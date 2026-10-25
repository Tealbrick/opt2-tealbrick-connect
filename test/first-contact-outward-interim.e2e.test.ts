/**
 * C354a interim (connect 0.7.3 / 0.5.13) end to end on the real SDK: Connect runs under `startApp` behind a fake bridge with a
 * fake upstream. A grant that holds `outward` but not `first_contact` gets 409 `first_contact_approval_off` on a first-contact
 * send and nothing is sent; every other combination is held as before, and the default path still completes after approval.
 * The harness is copied from hold-view-e2e (QA R-1).
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
import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Json, PersonPrincipal, RunningApp } from "@opt2-tealbrick/spec/sdk";

import { AccountStore } from "../src/accounts.ts";
import { COMPOSIO_KEY, createConnectApp, PRODUCT_SCOPE } from "../src/app.ts";
import { classifyComposioTool, loadPolicies } from "../src/sources/composio/policy.ts";
import { entrySchema, ToolRegistry, toolName } from "../src/tools.ts";
import { fakeFetch, root } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const nowS = () => Math.floor(Date.now() / 1000);
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const KEY = "ck_e2e_composio_key";

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

const draft = (to: string, subject: string, text: string) => ({
  id: "r-1",
  message: { id: "m-1", payload: { mimeType: "multipart/alternative", headers: [{ name: "To", value: to }, { name: "Subject", value: subject }], parts: [{ mimeType: "text/plain", body: { data: b64(text) } }] } },
});

let w: World;
let running: RunningApp;
let bridge: Server;
let dataDir: string;
const upstreamDraft: { value: unknown } = { value: null };
const upstream = fakeFetch({
  "POST /api/v3/tools/execute/GMAIL_GET_DRAFT": () => ({ body: { successful: true, data: upstreamDraft.value } }),
  "POST /api/v3/tools/execute/GMAIL_SEND_DRAFT": () => ({ body: { successful: true, data: { id: "sent-1" } } }),
});
const sends = () => upstream.calls.filter((c) => c.url.pathname.endsWith("/GMAIL_SEND_DRAFT")).length;

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
      const gmail = loadPolicies().get("gmail");
      new ToolRegistry(ctx.db).replaceService(
        "composio",
        "gmail",
        ["GMAIL_SEND_DRAFT", "GMAIL_GET_DRAFT"].map((slug) => ({ name: toolName(slug), upstream: slug, title: slug === "GMAIL_SEND_DRAFT" ? "Send draft" : "Get draft", description: slug, inputSchema: entrySchema({}), ...classifyComposioTool(slug, gmail) })),
      );
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

async function sendDraft(tool = "gmail_send_draft__first_contact", held: string[] = ["first_contact"]): Promise<{ status: number; body: Record<string, any> }> {
  const input: Json = { tool, arguments: { draft_id: "r-1" } };
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

function hold(id: string): { status: string; view: string | null; summary: string } {
  const db = new DatabaseSync(join(dataDir, "app.db"), { readOnly: true });
  try {
    return db.prepare("SELECT status, view, summary FROM tb_receipts WHERE id = ?").get(id) as { status: string; view: string | null; summary: string };
  } finally {
    db.close();
  }
}
const approve = (id: string) => decideHold({ type: "person", id: w.per, ws: w.ws, instance: w.ins } as PersonPrincipal, { holdId: id as `hld_${string}`, decision: "approve" });

test("interim: a grant that holds outward but not first_contact refuses __first_contact (nothing sent); other combinations hold", async () => {
  upstreamDraft.value = draft("Carol <carol@new.example>", "Hello", "first contact");
  const before = sends();
  const r = await sendDraft("gmail_send_draft__first_contact", ["outward"]);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(JSON.stringify(r.body), /first_contact_approval_off/u);
  assert.equal(sends() - before, 0, "nothing was sent");
  assert.equal((await sendDraft("gmail_send_draft", ["outward"])).status, 202, "plain send held by outward");
  assert.equal((await sendDraft("gmail_send_draft__first_contact", ["first_contact"])).status, 202, "default card holds first contact");
  assert.equal((await sendDraft("gmail_send_draft__first_contact", ["outward", "first_contact"])).status, 202, "both held");
  assert.equal(sends() - before, 0);
  // the default path still completes: the owner approves the held first contact and the same call then sends once
  const held = await sendDraft("gmail_send_draft__first_contact", ["first_contact"]);
  assert.equal(held.status, 202);
  const holdId = String(held.body.holdId);
  assert.equal(hold(holdId).status, "held");
  await approve(holdId);
  const run = await sendDraft("gmail_send_draft__first_contact", ["first_contact"]);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(sends() - before, 1);
});
