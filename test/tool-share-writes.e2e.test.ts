/**
 * Connect-writes (C366b, Coordinator decisions 2026-10-30) end to end on the real SDK: Connect runs under `startApp` behind a fake
 * bridge with a fake upstream. An Evolving Workflows instance calls `tools` over HTTP with a bound companion grant and a call proof,
 * as the bridge sends them. Fire on bad: read share, read-only edge, outward with no approval, delete and money; a held write gives
 * exactly one upstream call on approve, none on deny, none more on a retry; another run with identical input does not use the
 * approval (QA approval reuse).
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
import type { Db, Json, PersonPrincipal, RunningApp } from "@opt2-tealbrick/spec/sdk";

import { AccountStore } from "../src/accounts.ts";
import { COMPOSIO_KEY, createConnectApp, PRODUCT_SCOPE } from "../src/app.ts";
import { ToolShareStore } from "../src/data/tool-shares.ts";
import { classifyComposioTool, loadPolicies } from "../src/sources/composio/policy.ts";
import { entrySchema, ToolRegistry, toolName } from "../src/tools.ts";
import { fakeFetch, root } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const nowS = () => Math.floor(Date.now() / 1000);
const CRUD_WRITE = ["read", "create", "update"];

interface World {
  portal: Ed25519KeyPair;
  root: Ed25519KeyPair;
  bridgeKey: Ed25519KeyPair;
  keySet: string;
  ws: `ws_${string}`;
  brg: `brg_${string}`;
  ins: `ins_${string}`;
  per: `per_${string}`;
  evo: `ins_${string}`;
}

let w: World;
let running: RunningApp;
let bridge: Server;
let dataDir: string;
let appDb: Db;
let readAccount = "";
let writeAccount = "";
const upstream = fakeFetch({
  "POST /api/v3/tools/execute/GMAIL_CREATE_EMAIL_DRAFT": () => ({ body: { successful: true, data: { id: "draft-1" } } }),
  "POST /api/v3/tools/execute/GMAIL_SEND_EMAIL": () => ({ body: { successful: true, data: { id: "sent-1" } } }),
  "POST /api/v3/tools/execute/GMAIL_DELETE_DRAFT": () => ({ body: { successful: true, data: {} } }),
  "POST /api/v3/tools/execute/GMAIL_LIST_DRAFTS": () => ({ body: { successful: true, data: { drafts: [] } } }),
});
const count = (slug: string) => upstream.calls.filter((c) => c.url.pathname.endsWith(`/${slug}`)).length;

async function startBridge(slice: string): Promise<string> {
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
    if (url.pathname === `/tb/v1/keys/${COMPOSIO_KEY}`) return json(200, { name: COMPOSIO_KEY, value: "ck_e2e", keysRev: 0 });
    if (url.pathname.startsWith("/tb/v1/keys/")) return json(404, { error: { code: "key_missing", message: "no key", requestId: "req_e2e" } });
    if (url.pathname === "/tb/v1/status") {
      if (body?.sliceRevision !== 1) return json(200, { slice, sliceRevision: 1, keysRev: 0 });
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
  w = { root: rootKey, portal, bridgeKey, keySet, ws: `ws_${ulid()}`, brg: `brg_${ulid()}`, ins: `ins_${ulid()}`, per: `per_${ulid()}`, evo: `ins_${ulid()}` };
  dataDir = mkdtempSync(join(tmpdir(), "connect-writes-e2e-"));
  const self = `tb:ins:${w.ins}` as const;
  const slice = await signSlice(
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
      agents: [],
      companionCallers: [{ product: "evolution", ins: w.evo, name: "Evolving Workflows" }],
      portalKeySet: w.keySet,
    } as Parameters<typeof signSlice>[0],
    w.portal,
  );
  const bridgeUrl = await startBridge(slice);
  const definition = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), dataDir, ErrorClass: TbError, fetchImpl: upstream.impl });
  const owner = { type: "person", id: w.per, ws: w.ws, instance: w.ins } as PersonPrincipal;
  const app = defineApp({
    ...definition,
    onStart: async (ctx) => {
      appDb = ctx.db;
      const accounts = new AccountStore(ctx.db);
      const a = accounts.create({ service: "gmail", source: "composio", kind: "as_me", label: "Write inbox", externalRef: "ca_w", status: "connected" });
      writeAccount = a.id;
      const gmail = loadPolicies().get("gmail");
      new ToolRegistry(ctx.db).replaceService(
        "composio",
        "gmail",
        ["GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_SEND_EMAIL", "GMAIL_DELETE_DRAFT", "GMAIL_LIST_DRAFTS"].map((slug) => ({ name: toolName(slug), upstream: slug, title: slug, description: slug, inputSchema: entrySchema({}), ...classifyComposioTool(slug, gmail) })),
      );
      await ctx.scopes.instances.create(PRODUCT_SCOPE, a.id, a.label);
      await ctx.scopes.set(owner, w.evo as unknown as `agt_${string}`, PRODUCT_SCOPE, a.id, "read_update");
      const shares = new ToolShareStore(ctx.db);
      shares.set(a.id, "evolution", w.evo, true);
      const r = accounts.create({ service: "outlook", source: "composio", kind: "as_me", label: "Read-only inbox", externalRef: "ca_r", status: "connected" });
      readAccount = r.id;
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

interface CallOpts {
  run?: string;
  key?: string;
  held?: string[];
  crud?: string[];
  /** a Rules hold (the bridge-attested before-hook verdict) */
  ruleHold?: boolean;
}
/** One app call as the bridge sends it: the context names the workflow and run, the key is per run and step like the engine's. */
async function callTool(tool: string, args: Record<string, Json>, o: CallOpts = {}): Promise<{ status: number; body: Record<string, any> }> {
  const run = o.run ?? "run_a";
  const input: Json = { tool, arguments: args };
  const context: Record<string, Json> = { "evolution.workflow": "brief-draft", "evolution.version": 2, "evolution.run": run, "evolution.step": "result" };
  const grant = await signGrant(
    { iss: "tb:portal", sub: `tb:ins:${w.evo}`, aud: `tb:ins:${w.ins}`, iat: nowS(), ws: w.ws, cnf: { brg: w.brg }, crud: (o.crud ?? CRUD_WRITE) as never, mode: "bound", held: (o.held ?? []) as never, caps: {}, wf: ["tools", "tool_shares_mine"], polrev: 1 },
    w.portal,
  );
  const jti = (JSON.parse(Buffer.from(grant.split(".")[1] as string, "base64url").toString("utf8")) as { jti: string }).jti;
  const proof = await signCallProof(
    { iss: `tb:brg:${w.brg}`, sub: `tb:ins:${w.evo}`, aud: `tb:ins:${w.ins}`, iat: nowS(), call: `call_${ulid()}`, gjti: jti, op: "tools", in: digest(input), ctx: digest(context), ...(o.ruleHold ? { hv: { f: "outward", r: "Rules: a test hold", by: "rules/before" } } : {}) } as Parameters<typeof signCallProof>[0],
    w.bridgeKey,
  );
  const res = await fetch(`http://127.0.0.1:${running.port}/tb/v1/ops/tools`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${grant}`, "tb-call": proof },
    body: JSON.stringify({ input, context, idempotencyKey: o.key ?? `wfrun:brief-draft:${run}:result` }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const errCode = (r: { body: Record<string, any> }): string => String(r.body.error?.code ?? r.body.code ?? "");
const decide = (id: string, decision: "approve" | "deny") => decideHold({ type: "person", id: w.per, ws: w.ws, instance: w.ins } as PersonPrincipal, { holdId: id as `hld_${string}`, decision });
const holdView = (id: string): string => {
  const db = new DatabaseSync(join(dataDir, "app.db"), { readOnly: true });
  try {
    return String((db.prepare("SELECT view FROM tb_receipts WHERE id = ?").get(id) as { view: string | null }).view);
  } finally {
    db.close();
  }
};

const DRAFT = "gmail_create_email_draft";
const draftArgs = (subject: string) => ({ recipient_email: "person@example.com", subject, body: "Fictional text" }) as Record<string, Json>;

test("a plain write with the write share runs with no hold; the same key again gives the stored answer and no second draft", async () => {
  const before = count("GMAIL_CREATE_EMAIL_DRAFT");
  const first = await callTool(DRAFT, draftArgs("plain"), { run: "run_plain" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const retry = await callTool(DRAFT, draftArgs("plain"), { run: "run_plain" });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(count("GMAIL_CREATE_EMAIL_DRAFT") - before, 1, "exactly one draft");
});

test("a Rules hold on the draft: the card names the workflow and run; deny gives no draft and approve exactly one", async () => {
  const before = count("GMAIL_CREATE_EMAIL_DRAFT");
  const denied = await callTool(DRAFT, draftArgs("deny me"), { run: "run_deny", ruleHold: true });
  assert.equal(denied.status, 202, JSON.stringify(denied.body));
  const view = holdView(String(denied.body.holdId));
  assert.match(view, /Asked by: Evolving Workflows/u);
  assert.match(view, /Workflow: brief-draft, version 2/u);
  assert.match(view, /Run: run_deny/u);
  assert.match(view, /Step: result/u);
  await decide(String(denied.body.holdId), "deny");
  const afterDeny = await callTool(DRAFT, draftArgs("deny me"), { run: "run_deny", ruleHold: true });
  assert.equal(errCode(afterDeny), "hold_denied", JSON.stringify(afterDeny.body));
  assert.equal(count("GMAIL_CREATE_EMAIL_DRAFT") - before, 0, "no draft on deny");

  const held = await callTool(DRAFT, draftArgs("approve me"), { run: "run_ok", ruleHold: true });
  assert.equal(held.status, 202);
  await decide(String(held.body.holdId), "approve");
  const ran = await callTool(DRAFT, draftArgs("approve me"), { run: "run_ok", ruleHold: true });
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  const retry = await callTool(DRAFT, draftArgs("approve me"), { run: "run_ok", ruleHold: true });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(count("GMAIL_CREATE_EMAIL_DRAFT") - before, 1, "exactly one draft on approve and retry");
});

test("approval reuse: another run with identical input gets its own hold, and the waiting run still runs on its approval", async () => {
  const before = count("GMAIL_CREATE_EMAIL_DRAFT");
  const a = await callTool(DRAFT, draftArgs("same input"), { run: "run_r1", ruleHold: true });
  assert.equal(a.status, 202);
  await decide(String(a.body.holdId), "approve");
  const b = await callTool(DRAFT, draftArgs("same input"), { run: "run_r2", ruleHold: true });
  assert.equal(b.status, 202, `the other run must not use the approval: ${JSON.stringify(b.body)}`);
  assert.notEqual(b.body.holdId, a.body.holdId);
  assert.equal(count("GMAIL_CREATE_EMAIL_DRAFT") - before, 0);
  const repeat = await callTool(DRAFT, draftArgs("same input"), { run: "run_r1", ruleHold: true });
  assert.equal(repeat.status, 200, `the waiting run must not be held again: ${JSON.stringify(repeat.body)}`);
  assert.equal(count("GMAIL_CREATE_EMAIL_DRAFT") - before, 1);
  await decide(String(b.body.holdId), "deny");
});

test("outward: refused with no approval and names the Rules hold; a Rules hold or a held family runs it once after the owner approves (C378)", async () => {
  const SEND = "gmail_send_email__first_contact";
  const args = { recipient_email: "person@example.com", subject: "Hello", body: "Fictional" } as Record<string, Json>;
  const before = count("GMAIL_SEND_EMAIL");
  const refused = await callTool(SEND, args, { run: "run_o1", held: [] });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(errCode(refused), "app_outward_needs_approval");
  assert.match(JSON.stringify(refused.body), /Rules app/u);
  assert.equal(count("GMAIL_SEND_EMAIL") - before, 0);
  // the default policy holds first_contact: the owner approves, it sends once
  const held = await callTool(SEND, args, { run: "run_o2", held: ["first_contact"] });
  assert.equal(held.status, 202, JSON.stringify(held.body));
  await decide(String(held.body.holdId), "approve");
  const ran = await callTool(SEND, args, { run: "run_o2", held: ["first_contact"] });
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  assert.equal(count("GMAIL_SEND_EMAIL") - before, 1);
  // the contact is known now: the plain tool with no hold is refused, and the text also names the form that waits
  const plain = await callTool("gmail_send_email", args, { run: "run_o3", held: ["first_contact"] });
  assert.equal(errCode(plain), "app_outward_needs_approval", JSON.stringify(plain.body));
  assert.match(JSON.stringify(plain.body), /gmail_send_email__first_contact/u);
  // an apps policy that holds outward: held; deny sends nothing
  const policy = await callTool("gmail_send_email", args, { run: "run_o4", held: ["outward"] });
  assert.equal(policy.status, 202, JSON.stringify(policy.body));
  await decide(String(policy.body.holdId), "deny");
  assert.equal(count("GMAIL_SEND_EMAIL") - before, 1);
  // C378: a Rules hold alone takes effect: held, the owner approves, it runs exactly once, a retry gives the stored answer
  const rule = await callTool("gmail_send_email", args, { run: "run_o5", held: [], ruleHold: true });
  assert.equal(rule.status, 202, JSON.stringify(rule.body));
  assert.doesNotMatch(holdView(String(rule.body.holdId)), /refuse/u);
  await decide(String(rule.body.holdId), "approve");
  const after = await callTool("gmail_send_email", args, { run: "run_o5", held: [], ruleHold: true });
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(count("GMAIL_SEND_EMAIL") - before, 2);
  const retry = await callTool("gmail_send_email", args, { run: "run_o5", held: [], ruleHold: true });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(count("GMAIL_SEND_EMAIL") - before, 2, "no second send on a retry");
  // the approval of another run proves nothing for this one
  const stolen = await callTool("gmail_send_email", args, { run: "run_o6", held: [] });
  assert.equal(errCode(stolen), "app_outward_needs_approval", JSON.stringify(stolen.body));
});

test("approval binding: two identical runs both approved each run on their own approval, in any order (SDK 0.1.44)", async () => {
  const before = count("GMAIL_CREATE_EMAIL_DRAFT");
  const a = await callTool(DRAFT, draftArgs("both"), { run: "run_b1", ruleHold: true });
  const b = await callTool(DRAFT, draftArgs("both"), { run: "run_b2", ruleHold: true });
  assert.deepEqual([a.status, b.status], [202, 202]);
  await decide(String(a.body.holdId), "approve");
  await decide(String(b.body.holdId), "approve");
  assert.equal((await callTool(DRAFT, draftArgs("both"), { run: "run_b1", ruleHold: true })).status, 200);
  assert.equal((await callTool(DRAFT, draftArgs("both"), { run: "run_b2", ruleHold: true })).status, 200);
  assert.equal(count("GMAIL_CREATE_EMAIL_DRAFT") - before, 2);
});

test("a delete tool stays refused with a write share (read_update has no delete)", async () => {
  const before = count("GMAIL_DELETE_DRAFT");
  const r = await callTool("gmail_delete_draft", { draft_id: "d-1" }, { run: "run_del", crud: [...CRUD_WRITE, "delete"], held: ["destructive"] });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(count("GMAIL_DELETE_DRAFT") - before, 0);
});

test("a read-only edge (grant crud read) refuses a write, whatever the share says", async () => {
  const before = count("GMAIL_CREATE_EMAIL_DRAFT");
  const r = await callTool(DRAFT, draftArgs("read edge"), { run: "run_edge", crud: ["read"] });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(count("GMAIL_CREATE_EMAIL_DRAFT") - before, 0);
});

test("back to read only: the next write is refused while reads go on; the kill path is Connect's own row", async () => {
  const shares = new ToolShareStore(appDb);
  shares.set(writeAccount, "evolution", w.evo, false);
  try {
    const before = count("GMAIL_CREATE_EMAIL_DRAFT");
    const r = await callTool(DRAFT, draftArgs("narrowed"), { run: "run_narrow" });
    assert.equal(errCode(r), "app_read_only", JSON.stringify(r.body));
    assert.equal(count("GMAIL_CREATE_EMAIL_DRAFT") - before, 0);
    const read = await callTool("gmail_list_drafts", {}, { run: "run_narrow_read" });
    assert.equal(read.status, 200, JSON.stringify(read.body));
  } finally {
    shares.set(writeAccount, "evolution", w.evo, true);
  }
  assert.ok(readAccount, "the unshared account exists");
});
