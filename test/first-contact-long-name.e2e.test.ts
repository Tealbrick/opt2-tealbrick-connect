/**
 * D-C383-JM1 end to end on the real SDK: a first contact through a tool with a long catalog name. The agent asks by the same
 * name as for any other tool (`<tool>__first_contact`, up to 63 characters, spec DYNAMIC_TOOL_NAME_RE), and the flow is the
 * flow of a short name: refused with the name to call, held for the owner, sent once after approval, then known. Nothing
 * else widens: a plain send to a new person is still refused, a grant that holds only `outward` is still refused, a name that
 * is not a send tool does not resolve, and a request over 63 characters is refused before Connect sees it.
 * The harness is copied from first-contact-outward-interim.e2e (QA R-1).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";

import { digest, type Ed25519KeyPair, generateKeyPair, signCallProof, signGrant, signKeySetStatement, signSlice, ulid } from "@opt2-tealbrick/manifest";
import { decideHold, defineApp, startApp, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type { CrudAction, Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Json, PersonPrincipal, RunningApp } from "@opt2-tealbrick/spec/sdk";

import { AccountStore } from "../src/accounts.ts";
import { COMPOSIO_KEY, createConnectApp, PRODUCT_SCOPE } from "../src/app.ts";
import { entrySchema, ToolRegistry, toolName } from "../src/tools.ts";
import { fakeFetch, root } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const nowS = () => Math.floor(Date.now() / 1000);
const KEY = "ck_e2e_composio_key";

/** The exact name that failed live (C383, Connect 0.7.14): an MCP account tool, base 47 characters. */
const EXACT = "mcp_acme_data_sources_282ebac3_gmail_send_email";
/** A base at the catalog limit: 48 characters, so the variant has 63. */
const AT_LIMIT = `mcp_${"x".repeat(33)}_send_email`;
/** An upstream slug over the limit: toolName cuts it to at most 48 with a hash, so the variant still fits. */
const OVER_SLUG = `MCP_${"Y".repeat(60)}_SEND_EMAIL`;
const OVER = toolName(OVER_SLUG);
/** The longest short-form name the old schema took as a variant, one over: the first name that failed before the fix. */
const BASE_34 = `send_${"z".repeat(29)}`;
/** A long name that is not a send tool. */
const READ_LONG = `mcp_acme_data_sources_282ebac3_gmail_list_labels`;

interface World {
  root: Ed25519KeyPair;
  portal: Ed25519KeyPair;
  bridgeKey: Ed25519KeyPair;
  keySet: string;
  ws: `ws_${string}`;
  brg: `brg_${string}`;
  ins: `ins_${string}`;
  per: `per_${string}`;
  agent: `agt_${string}`;
}

let w: World;
let running: RunningApp;
let bridge: Server;
let dataDir: string;
const slugOf = (name: string) => (name === OVER ? OVER_SLUG : name.toUpperCase());
const upstream = fakeFetch(
  Object.fromEntries(
    [EXACT, AT_LIMIT, OVER, BASE_34].map((name) => [`POST /api/v3/tools/execute/${slugOf(name)}`, () => ({ body: { successful: true, data: { id: "sent-1" } } })]),
  ),
);
const sends = (name: string) => upstream.calls.filter((c) => c.url.pathname.endsWith(`/${slugOf(name)}`)).length;

async function sliceToken(): Promise<string> {
  const self = `tb:ins:${w.ins}` as const;
  return signSlice(
    {
      iss: "tb:portal",
      sub: self,
      aud: self,
      iat: nowS(),
      ws: w.ws,
      v: 1,
      rev: 1,
      ins: w.ins,
      product: "connect",
      portalKeys: [{ jwk: w.portal.publicJwk, status: "active" }],
      bridge: { id: w.brg, keys: [w.bridgeKey.publicJwk] },
      pause: { workspace: false, agents: [], instances: [] },
      revoked: { jtis: [] },
      personNbf: 0,
      grants: [],
      agents: [{ id: w.agent, name: "Agent", mode: "free", status: "active" }],
      portalKeySet: w.keySet,
    } as Parameters<typeof signSlice>[0],
    w.portal,
  );
}

/** Fake bridge internal listener: claim, status (slice), workspace key fetch. */
async function startBridge(slice: string): Promise<string> {
  const waiting: ServerResponse[] = [];
  bridge = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    const url = new URL(req.url ?? "/", "http://x");
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (url.pathname === "/tb/v1/claim") return json(200, { ins: w.ins, bridge: { id: w.brg, publicKey: w.bridgeKey.publicJwk, internalUrl: `http://127.0.0.1:${port()}` }, slice });
    if (url.pathname === `/tb/v1/keys/${COMPOSIO_KEY}`) return json(200, { name: COMPOSIO_KEY, value: KEY, keysRev: 0 });
    if (url.pathname.startsWith("/tb/v1/keys/")) return json(404, { error: { code: "key_missing", message: "no key", requestId: "req_e2e" } });
    if (url.pathname === "/tb/v1/status") {
      if (body?.sliceRevision !== 1) return json(200, { slice, sliceRevision: 1, keysRev: 0 });
      waiting.push(res);
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(204);
          res.end();
        }
      }, 1000).unref();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${port()}`;
}
const port = () => {
  const a = bridge.address();
  return typeof a === "object" && a ? a.port : 0;
};

before(async () => {
  const [rootKey, portal, bridgeKey] = await Promise.all([generateKeyPair(), generateKeyPair(), generateKeyPair()]);
  const keySet = await signKeySetStatement({ iss: "tb:portal-root", aud: "tb:portal-keys", seq: 1, iat: nowS(), keys: [{ jwk: portal.publicJwk, status: "active" }] }, rootKey);
  w = { root: rootKey, portal, bridgeKey, keySet, ws: `ws_${ulid()}`, brg: `brg_${ulid()}`, ins: `ins_${ulid()}`, per: `per_${ulid()}`, agent: `agt_${ulid()}` };
  dataDir = mkdtempSync(join(tmpdir(), "connect-hv-e2e-"));
  const bridgeUrl = await startBridge(await sliceToken());
  const definition = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), dataDir, ErrorClass: TbError, fetchImpl: upstream.impl });
  const owner = { type: "person", id: w.per, ws: w.ws, instance: w.ins } as PersonPrincipal;
  const app = defineApp({
    ...definition,
    onStart: async (ctx) => {
      // owner state: one connected Gmail inbox, its tools classified by the real policy, the agent at READ/UPDATE on it
      const account = new AccountStore(ctx.db).create({ service: "gmail", source: "composio", kind: "as_me", label: "Work inbox", externalRef: "ca_work", status: "connected" });
      const row = (name: string, slug: string, outward: boolean) => ({
        name,
        upstream: slug,
        title: slug,
        description: slug,
        inputSchema: entrySchema({}),
        ...(outward ? { crud: ["create", "update"] as CrudAction[], effect: "outward" as const, holdFamily: "outward" as const } : { crud: ["read"] as CrudAction[], effect: "read" as const }),
      });
      new ToolRegistry(ctx.db).replaceService("composio", "gmail", [...[EXACT, AT_LIMIT, OVER, BASE_34].map((n) => row(n, slugOf(n), true)), row(READ_LONG, READ_LONG.toUpperCase(), false)]);
      await ctx.scopes.instances.create(PRODUCT_SCOPE, account.id, account.label);
      await ctx.scopes.set(owner, w.agent, PRODUCT_SCOPE, account.id, "read_update");
      await definition.onStart?.(ctx);
    },
  });
  running = await startApp(
    app,
    { TB_INSTANCE_ID: w.ins, TB_ENROL_CODE: "tbe_e2e", TB_BRIDGE_URL: bridgeUrl, TB_PORTAL_KEYS: JSON.stringify({ keys: [w.portal.publicJwk] }), TB_DATA_DIR: dataDir, TB_DATA_EPHEMERAL: "1", TB_LOG_LEVEL: "error" },
    { portalRootKeys: [w.root.publicJwk], port: 0 } as Parameters<typeof startApp>[2],
  );
  for (let i = 0; i < 200 && running.status() !== "ok"; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(running.status(), "ok");
});

after(async () => {
  await running?.stop();
  bridge?.closeAllConnections();
  await new Promise<void>((r) => (bridge ? bridge.close(() => r()) : r()));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

async function send(tool: string, to: string, held: string[] = ["first_contact"]): Promise<{ status: number; body: Record<string, any> }> {
  const input: Json = { tool, arguments: { recipient_email: to, subject: "Hello", body: "Text" } };
  const grant = await signGrant(
    { iss: "tb:portal", sub: `tb:agt:${w.agent}`, aud: `tb:ins:${w.ins}`, iat: nowS(), ws: w.ws, cnf: { brg: w.brg }, crud: ["create", "read", "update", "delete"], mode: "free", held: held as never, caps: {}, wf: [], polrev: 1 },
    w.portal,
  );
  const jti = (JSON.parse(Buffer.from(grant.split(".")[1] as string, "base64url").toString("utf8")) as { jti: string }).jti;
  const proof = await signCallProof({ iss: `tb:brg:${w.brg}`, sub: `tb:agt:${w.agent}`, aud: `tb:ins:${w.ins}`, iat: nowS(), call: `call_${ulid()}`, gjti: jti, op: "tools", in: digest(input), ctx: digest({}) }, w.bridgeKey);
  const res = await fetch(`http://127.0.0.1:${running.port}/tb/v1/ops/tools`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${grant}`, "tb-call": proof },
    body: JSON.stringify({ input, context: {} }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

function hold(id: string): { status: string; view: string | null; summary: string; hold_family: string | null } {
  const db = new DatabaseSync(join(dataDir, "app.db"), { readOnly: true });
  try {
    return db.prepare("SELECT status, view, summary, hold_family FROM tb_receipts WHERE id = ?").get(id) as { status: string; view: string | null; summary: string; hold_family: string | null };
  } finally {
    db.close();
  }
}
const approve = (id: string) => decideHold({ type: "person", id: w.per, ws: w.ws, instance: w.ins } as PersonPrincipal, { holdId: id as `hld_${string}`, decision: "approve" });
const code = (r: { body: Record<string, any> }) => String(r.body.error?.code);

test("the names under test have the lengths the fix is about", () => {
  assert.equal(EXACT.length, 47);
  assert.equal(`${EXACT}__first_contact`.length, 62, "the exact name that failed live");
  assert.equal(AT_LIMIT.length, 48);
  assert.equal(`${AT_LIMIT}__first_contact`.length, 63);
  assert.ok(OVER_SLUG.length > 48 && OVER.length <= 48, "a slug over the limit is cut with a hash");
  assert.equal(BASE_34.length, 34);
  assert.equal(`${BASE_34}__first_contact`.length, 49, "one over the old limit");
});

for (const [label, name] of [
  ["the exact name that failed live", EXACT],
  ["a name at the limit", AT_LIMIT],
  ["a name cut from a slug over the limit", OVER],
  ["the first name the old schema refused", BASE_34],
] as const) {
  test(`first contact through ${label}: refused with the name to call, held, sent once, then known`, async () => {
    const start = sends(name);
    const to = `${slugOf(name).slice(-24).toLowerCase()}@new.example`;
    const plain = await send(name, to);
    assert.equal(plain.status, 409, JSON.stringify(plain.body));
    assert.equal(code(plain), "first_contact_required");
    assert.equal(plain.body.error.details?.tool ?? plain.body.error.tool, `${name}__first_contact`, "the answer names the tool to call");
    assert.match(String(plain.body.error.message), new RegExp(`${name}__first_contact`, "u"));
    assert.equal(sends(name) - start, 0, "nothing was sent");

    const held = await send(`${name}__first_contact`, to);
    assert.equal(held.status, 202, JSON.stringify(held.body));
    const holdId = String(held.body.holdId);
    assert.equal(hold(holdId).status, "held");
    assert.equal(hold(holdId).hold_family, "first_contact", "held by the first-contact family, as a short name");
    assert.match(String(hold(holdId).view), new RegExp(to.replace(/\./gu, "\\."), "u"), "the owner sees the recipient");
    assert.equal(sends(name) - start, 0, "nothing is sent before approval");

    await approve(holdId);
    const run = await send(`${name}__first_contact`, to);
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(sends(name) - start, 1, "sent once");
    assert.equal(hold(holdId).status === "held", false);

    const again = await send(name, to);
    assert.equal(again.status, 200, `the person is known now: ${JSON.stringify(again.body)}`);
    assert.equal(sends(name) - start, 2);

    const other = await send(name, `other.${to}`);
    assert.equal(other.status, 409, "a person the agent has not written to is still a first contact");
    assert.equal(code(other), "first_contact_required");
    assert.equal(sends(name) - start, 2);
  });
}

test("no widening on a long name: outward-only hold refuses, a repeat needs a new approval, a read tool has no first-contact form", async () => {
  const start = sends(EXACT);
  const refused = await send(`${EXACT}__first_contact`, "a@new.example", ["outward"]);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(code(refused), "first_contact_approval_off");
  assert.equal(sends(EXACT) - start, 0);

  const held = await send(`${EXACT}__first_contact`, "b@new.example");
  assert.equal(held.status, 202);
  await approve(String(held.body.holdId));
  assert.equal((await send(`${EXACT}__first_contact`, "b@new.example")).status, 200);
  assert.equal((await send(`${EXACT}__first_contact`, "b@new.example")).status, 202, "the approval is used once: the same first-contact call is held again");

  const read = await send(`${READ_LONG}__first_contact`, "c@new.example");
  assert.equal(read.status, 404, JSON.stringify(read.body));
  assert.equal(code(read), "dynamic_resolve_failed");
});

test("a request over 63 characters is refused before Connect sees it", async () => {
  const start = sends(AT_LIMIT);
  const r = await send(`${AT_LIMIT}__first_contact_`, "d@new.example");
  assert.equal(`${AT_LIMIT}__first_contact_`.length, 64);
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(code(r), "input_invalid");
  assert.equal(sends(AT_LIMIT) - start, 0);
});
