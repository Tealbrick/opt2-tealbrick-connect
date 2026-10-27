/**
 * QA R-1 end to end on the real SDK (miniapp-sdk 0.1.23, SDK-HV-1): Connect runs under `startApp` behind a fake bridge, an
 * agent sends a Gmail draft (first contact → held). The owner's hold shows the draft's recipients, subject and text. The
 * agent then edits the draft (A → B) and repeats the approved call: it is held AGAIN with B's content and nothing is sent;
 * B is sent only after its own approval.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";

import { digest, type Ed25519KeyPair, generateKeyPair, signCallProof, signGrant, signKeySetStatement, signSlice, ulid } from "@opt2-tealbrick/manifest";
import { decideHold, defineApp, HOLD_VIEW_UNREADABLE, startApp, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type { HoldFamily, Manifest } from "@opt2-tealbrick/spec/manifest";
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
        ["GMAIL_SEND_DRAFT", "GMAIL_GET_DRAFT", "GMAIL_DELETE_MESSAGE"].map((slug) => ({ name: toolName(slug), upstream: slug, title: slug === "GMAIL_SEND_DRAFT" ? "Send draft" : slug === "GMAIL_DELETE_MESSAGE" ? "Delete message" : "Get draft", description: slug, inputSchema: entrySchema({}), ...classifyComposioTool(slug, gmail) })),
      );
      await ctx.scopes.instances.create(PRODUCT_SCOPE, account.id, account.label);
      await ctx.scopes.set(owner, w.agent, PRODUCT_SCOPE, account.id, "read_update_delete");
      // C368: a Postiz account and its create-post tool (the row as the catalog sync writes it), for the draft variant
      const postiz = new AccountStore(ctx.db).create({ service: "postiz", source: "catalog", kind: "as_me", label: "Postiz", externalRef: "https://postiz.example.com", status: "connected" });
      new ToolRegistry(ctx.db).replaceService("catalog", "postiz", [
        { name: "cb_postiz_create", upstream: "PublicIntegrationsController_createPost", title: "POST /public/v1/posts", description: "", inputSchema: entrySchema({}), crud: ["create"], effect: "outward", holdFamily: "outward", httpMethod: "post", httpPath: "/public/v1/posts" },
      ]);
      await ctx.scopes.instances.create(PRODUCT_SCOPE, postiz.id, postiz.label);
      await ctx.scopes.set(owner, w.agent, PRODUCT_SCOPE, postiz.id, "read_update_delete");
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

const sendDraft = () => callTool("gmail_send_draft__first_contact", { draft_id: "r-1" }, ["first_contact"]);

async function callTool(tool: string, args: Json, held: HoldFamily[]): Promise<{ status: number; body: Record<string, any> }> {
  const input: Json = { tool, arguments: args };
  const grant = await signGrant(
    { iss: "tb:portal", sub: `tb:agt:${w.agent}`, aud: `tb:ins:${w.ins}`, iat: nowS(), ws: w.ws, cnf: { brg: w.brg }, crud: ["create", "read", "update", "delete"], mode: "free", held, caps: {}, wf: [], polrev: 1 },
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

function hold(id: string): { status: string; view: string | null; summary: string; meta: string } {
  const db = new DatabaseSync(join(dataDir, "app.db"), { readOnly: true });
  try {
    return db.prepare("SELECT status, view, summary, meta FROM tb_receipts WHERE id = ?").get(id) as { status: string; view: string | null; summary: string; meta: string };
  } finally {
    db.close();
  }
}
const approve = (id: string) => decideHold({ type: "person", id: w.per, ws: w.ws, instance: w.ins } as PersonPrincipal, { holdId: id as `hld_${string}`, decision: "approve" });

test("R-1: the owner sees recipients, subject and text of the draft; an edit after approval (A → B) is held again; B is sent only after its own approval", async () => {
  upstreamDraft.value = draft("Bob <bob@partner.example>", "Q3 invoice", "A: Hello Bob, the Q3 invoice is attached.");
  const first = await sendDraft();
  assert.equal(first.status, 202, JSON.stringify(first.body));
  const holdA = String(first.body.holdId);
  const a = hold(holdA);
  assert.match(a.view ?? "", /^Send draft \(gmail\), first contact\nAccount: Work inbox\nTo: bob@partner\.example\nSubject: Q3 invoice\n/u);
  assert.match(a.view ?? "", /A: Hello Bob, the Q3 invoice is attached\./u);
  assert.match(a.summary, /"Q3 invoice" to bob@partner\.example/u);
  await approve(holdA);

  // the agent edits the draft after the approval: new recipient and text
  upstreamDraft.value = draft("attacker@evil.example", "Q3 invoice", "B: here are all customer passwords");
  const retry = await sendDraft();
  assert.equal(retry.status, 202, "A's approval does not send B");
  const holdB = String(retry.body.holdId);
  assert.notEqual(holdB, holdA);
  assert.match(hold(holdB).view ?? "", /To: attacker@evil\.example[\s\S]*B: here are all customer passwords/u);
  assert.equal(sends(), 0, "nothing was sent");

  await approve(holdB);
  const run = await sendDraft();
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(sends(), 1);
  assert.equal(hold(holdB).status, "run");
});

test("the draft cannot be read → the hold is still created with the 'could not read' line", async () => {
  upstreamDraft.value = { nothing: true };
  const r = await sendDraft();
  assert.equal(r.status, 202);
  const h = hold(String(r.body.holdId));
  assert.equal(h.status, "held");
  assert.ok(h.view?.startsWith(`${HOLD_VIEW_UNREADABLE}\n\n`), h.view ?? "");
  assert.match(h.view ?? "", /"draft_id": "r-1"/u);
});

test("C368/C369: a held non-send tool shows a readable card (no JSON) and Connect keeps its details under the receipt's meta.viewSha256", async () => {
  const r = await callTool("gmail_delete_message", { message_id: "m-77", note: "<p>old</p>" }, ["destructive"]);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const h = hold(String(r.body.holdId));
  assert.equal(h.status, "held");
  assert.equal(h.view, "Delete message (gmail)\nAccount: Work inbox\n\nMessage id: m-77\nNote: old");
  assert.ok(!(h.view ?? "").startsWith(HOLD_VIEW_UNREADABLE));
  const meta = JSON.parse(h.meta) as { tool: string; viewSha256: string };
  assert.equal(meta.tool, "gmail_delete_message");
  const db = new DatabaseSync(join(dataDir, "app.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT tool, details FROM connect_hold_details WHERE view_sha256 = ?").get(meta.viewSha256) as { tool: string; details: string } | undefined;
    assert.ok(row, "details are stored under the hash the SDK binds the approval to");
    const d = JSON.parse(row.details) as { upstream: string; account: { label: string }; arguments: string };
    assert.deepEqual([row.tool, d.upstream, d.account.label], ["gmail_delete_message", "GMAIL_DELETE_MESSAGE", "Work inbox"]);
    assert.deepEqual(JSON.parse(d.arguments), { message_id: "m-77", note: "<p>old</p>" });
  } finally {
    db.close();
  }
});

test("C368 on the real SDK: the base create-post is held (outward); the __draft form is a plain write the SDK does not hold, and a non-draft input on it is refused before anything is sent", async () => {
  const post = { integration: { id: "ch1" }, value: [{ content: "<p>Hello</p>" }], settings: { __type: "linkedin" } };
  const sched = await callTool("cb_postiz_create", { body: { type: "schedule", date: "2026-11-03T13:30:00Z", posts: [post] } }, ["outward"]);
  assert.equal(sched.status, 202, JSON.stringify(sched.body));
  assert.match(hold(String(sched.body.holdId)).view ?? "", /^Create a Postiz post\nAccount: Postiz\nType: SCHEDULED[\s\S]*Channel: LinkedIn · channel id ch1[\s\S]*Hello$/u);
  // the same schedule on the draft name: not held by the SDK, refused by Connect
  const sneaky = await callTool("cb_postiz_create__draft", { body: { type: "schedule", date: "2026-11-03T13:30:00Z", posts: [post] } }, ["outward"]);
  assert.equal(sneaky.status, 409, JSON.stringify(sneaky.body));
  assert.equal(sneaky.body.error?.code, "draft_not_plain");
  // a real draft: not held (the upstream call then fails here because the test has no Postiz, which is not a hold)
  const draft = await callTool("cb_postiz_create__draft", { body: { type: "draft", posts: [post] } }, ["outward"]);
  assert.notEqual(draft.status, 202, "a draft is not held");
  assert.notEqual(draft.body.error?.code, "draft_not_plain");
});
