/**
 * C230 R3 on the REAL SDK (miniapp-sdk 0.1.28, SDK-CALLER-PRODUCT): Connect runs under `startApp` behind a fake bridge and
 * the data_* ops are called over HTTP with signed grants and call proofs. The SDK itself builds `ctx.caller.product` from the
 * Portal-signed slice (`companionCallers`), so this test proves the identity Connect keys on is the verified product and
 * not the app's name: an app named "Observer" whose verified product is Knowledge reads exactly what the owner shared with
 * Knowledge, and a caller the slice does not list gets nothing.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { digest, type Ed25519KeyPair, generateKeyPair, signCallProof, signGrant, signKeySetStatement, signSlice, ulid } from "@opt2-tealbrick/manifest";
import { defineApp, startApp, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Db, Json, RunningApp } from "@opt2-tealbrick/spec/sdk";

import { AccountStore } from "../src/accounts.ts";
import { createConnectApp } from "../src/app.ts";
import { ChannelHub } from "../src/channels/service.ts";
import { ShareStore } from "../src/data/shares.ts";
import { memorySecrets, root } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const nowS = () => Math.floor(Date.now() / 1000);
const T0 = 1_760_000_000_000;

interface World {
  root: Ed25519KeyPair;
  portal: Ed25519KeyPair;
  bridgeKey: Ed25519KeyPair;
  keySet: string;
  ws: `ws_${string}`;
  brg: `brg_${string}`;
  ins: `ins_${string}`;
  agent: `agt_${string}`;
  /** an app whose NAME says Observer but whose verified product (slice companionCallers) is Knowledge */
  liar: `ins_${string}`;
  /** an app that really is Observer */
  observer: `ins_${string}`;
  /** an app the slice does not list at all (the SDK names it by its instance id and gives it no product) */
  stranger: `ins_${string}`;
}

let w: World;
let running: RunningApp;
let bridge: Server;
let dataDir: string;
let appDb: Db;
let account = "";
let shares: ShareStore;

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
      companionCallers: [
        { product: "knowledge", ins: w.liar, name: "Observer" },
        { product: "observer", ins: w.observer, name: "Observer" },
      ],
      portalKeySet: w.keySet,
    } as Parameters<typeof signSlice>[0],
    w.portal,
  );
}

/** Fake bridge internal listener: claim, status (slice), keys. */
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
  w = {
    root: rootKey,
    portal,
    bridgeKey,
    keySet,
    ws: `ws_${ulid()}`,
    brg: `brg_${ulid()}`,
    ins: `ins_${ulid()}`,
    agent: `agt_${ulid()}`,
    liar: `ins_${ulid()}`,
    observer: `ins_${ulid()}`,
    stranger: `ins_${ulid()}`,
  };
  dataDir = mkdtempSync(join(tmpdir(), "connect-caller-e2e-"));
  const bridgeUrl = await startBridge(await sliceToken());
  const definition = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), dataDir, ErrorClass: TbError });
  const app = defineApp({
    ...definition,
    onStart: async (ctx) => {
      await definition.onStart?.(ctx);
      // owner state: one connected chat account with two messages in its log; nothing is shared yet
      appDb = ctx.db;
      const accounts = new AccountStore(ctx.db);
      const created = accounts.create({ service: "telegram", source: "channel", kind: "as_itself", ownerAgent: w.agent, label: "Support bot", status: "connected" });
      account = created.id;
      const hub = new ChannelHub({ db: ctx.db, accounts, secrets: memorySecrets(), providers: new Map(), net: {} as never, log: ctx.log });
      for (const n of [1, 2]) {
        hub.ingest(created, { conversation: "chan-1", conversationName: "general", conversationType: "channel", messageId: `m${n}`, threadId: null, senderId: "123456789", senderName: "Anna", text: `hello ${n}`, sentAt: T0 + n * 1000 });
      }
      shares = new ShareStore(ctx.db);
    },
  });
  running = await startApp(
    app,
    { TB_INSTANCE_ID: w.ins, TB_ENROL_CODE: "tbe_e2e", TB_BRIDGE_URL: bridgeUrl, TB_PORTAL_KEYS: JSON.stringify({ keys: [w.portal.publicJwk] }), TB_DATA_DIR: dataDir, TB_DATA_EPHEMERAL: "1", TB_LOG_LEVEL: "error" },
    { portalRootKeys: [w.root.publicJwk], port: 0 } as Parameters<typeof startApp>[2],
  );
  for (let i = 0; i < 200 && running.status() !== "ok"; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(running.status(), "ok");
  assert.ok(account !== "" && appDb !== undefined);
});

after(async () => {
  await running?.stop();
  bridge?.closeAllConnections();
  await new Promise<void>((r) => (bridge ? bridge.close(() => r()) : r()));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/** One signed op call. An app caller carries a bound companion grant whose workflow lists the op (and, when `prd` is given, the grant claim `prd` of manifest >= 0.1.23); an agent a free grant. */
async function call(caller: `ins_${string}` | `agt_${string}`, op: string, input: Record<string, Json> = {}, prd?: string): Promise<{ status: number; body: Record<string, any> }> {
  const app = caller.startsWith("ins_");
  const sub = (app ? `tb:ins:${caller}` : `tb:agt:${caller}`) as `tb:agt:agt_${string}`;
  const grant = await signGrant(
    { iss: "tb:portal", sub, aud: `tb:ins:${w.ins}`, iat: nowS(), ws: w.ws, cnf: { brg: w.brg }, crud: ["read"], mode: app ? "bound" : "free", held: [], caps: {}, wf: app ? [op] : [], polrev: 1, ...(prd === undefined ? {} : { prd }) } as Parameters<typeof signGrant>[0],
    w.portal,
  );
  const jti = (JSON.parse(Buffer.from(grant.split(".")[1] as string, "base64url").toString("utf8")) as { jti: string }).jti;
  const proof = await signCallProof({ iss: `tb:brg:${w.brg}`, sub, aud: `tb:ins:${w.ins}`, iat: nowS(), call: `call_${ulid()}`, gjti: jti, op, in: digest(input), ctx: digest({}) }, w.bridgeKey);
  const res = await fetch(`http://127.0.0.1:${running.port}/tb/v1/ops/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${grant}`, "tb-call": proof },
    body: JSON.stringify({ input, context: {} }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
/** Each data op has its own closed input schema. */
const inputOf = (op: string): Record<string, Json> => (op === "data_accounts_list" ? {} : op === "data_catalog" ? { account } : { account, dataset: "messages" });
const code = (r: { body: Record<string, any> }): unknown => r.body.error?.code ?? r.body.code;

test("the SDK gives an app caller the verified product from the signed slice, whatever the app is named", async () => {
  shares.set(account, "observer", "shared", true);
  // the liar is named "Observer" and Observer has the share, but its verified product is Knowledge: it sees nothing
  const list = await call(w.liar, "data_accounts_list");
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body.output, { accounts: [] });
  for (const op of ["data_catalog", "data_pull"] as const) {
    const r = await call(w.liar, op, inputOf(op));
    assert.deepEqual([r.status, code(r)], [404, "not_found"], `${op} for a Knowledge-verified app named Observer`);
  }
  // the real Observer, same name, is served
  const real = await call(w.observer, "data_accounts_list");
  assert.equal(real.status, 200, JSON.stringify(real.body));
  assert.deepEqual(real.body.output.accounts.map((a: { account: string; level: string }) => [a.account, a.level]), [[account, "shared"]]);
});

test("with an owner share for the verified product the app gets data; without one it is refused; removing the share closes it again", async () => {
  shares.set(account, "observer", "none");
  assert.deepEqual((await call(w.liar, "data_accounts_list")).body.output, { accounts: [] }, "no share: nothing");
  assert.equal(code(await call(w.liar, "data_catalog", { account })), "not_found");

  shares.set(account, "knowledge", "shared", true);
  const list = await call(w.liar, "data_accounts_list");
  assert.deepEqual(list.body.output.accounts.map((a: { account: string }) => a.account), [account]);
  const catalog = await call(w.liar, "data_catalog", { account });
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
  assert.equal(catalog.body.output.account, account);
  const pulled = await call(w.liar, "data_pull", { account, dataset: "messages" });
  assert.equal(pulled.status, 200, JSON.stringify(pulled.body));
  assert.deepEqual(pulled.body.output.rows.map((r: { text: string }) => r.text), ["hello 1", "hello 2"]);
  // Observer (the real one) still has no share
  assert.equal(code(await call(w.observer, "data_pull", { account, dataset: "messages" })), "not_found");

  shares.set(account, "knowledge", "none");
  assert.equal(code(await call(w.liar, "data_pull", { account, dataset: "messages" })), "not_found");
});

test("an app caller the slice does not list has no verified product and is refused, even when a share exists for every data app", async () => {
  shares.set(account, "knowledge", "shared", true);
  shares.set(account, "observer", "shared", true);
  for (const op of ["data_accounts_list", "data_catalog", "data_pull"] as const) {
    const r = await call(w.stranger, op, inputOf(op));
    assert.deepEqual([r.status, code(r)], [403, "caller_unverified"], op);
  }
  const audit = appDb.prepare("SELECT outcome, caller_id, product FROM connect_data_audit WHERE caller_id = ? ORDER BY id").all(w.stranger).map((r) => ({ ...r }));
  assert.deepEqual(audit.map((r) => [r.outcome, r.product]), [["caller_unverified", null], ["caller_unverified", null], ["caller_unverified", null]]);
  shares.set(account, "knowledge", "none");
  shares.set(account, "observer", "none");
});

test("an agent (even the account's owner) is refused no_access; every served call is audited under the verified product", async () => {
  shares.set(account, "knowledge", "shared", true);
  for (const op of ["data_accounts_list", "data_catalog", "data_pull"] as const) {
    const r = await call(w.agent, op, inputOf(op));
    assert.deepEqual([r.status, code(r)], [403, "no_access"], op);
  }
  await call(w.liar, "data_catalog", { account });
  const row = appDb.prepare("SELECT product, caller_type, caller_id, outcome FROM connect_data_audit WHERE caller_id = ? AND op = 'data_catalog' ORDER BY id DESC LIMIT 1").get(w.liar);
  assert.deepEqual({ ...row }, { product: "knowledge", caller_type: "app", caller_id: w.liar, outcome: "ok" });
  shares.set(account, "knowledge", "none");
});

test("a grant whose prd differs from the slice product of the same instance is refused grant_invalid by the SDK: no data, no handler call, no audit row", async () => {
  shares.set(account, "knowledge", "shared", true);
  shares.set(account, "observer", "shared", true);
  const before = Number(appDb.prepare("SELECT COUNT(*) AS n FROM connect_data_audit").get()?.n);
  for (const op of ["data_accounts_list", "data_catalog", "data_pull"] as const) {
    // the slice says liar = knowledge; the grant says observer (which also has a share): refused, whichever product is "better"
    for (const prd of ["observer", "someone-else"]) {
      const r = await call(w.liar, op, inputOf(op), prd);
      assert.deepEqual([r.status, code(r)], [403, "grant_invalid"], `${op} prd ${prd}`);
      assert.equal(r.body.output, undefined);
    }
    // the same prd as the slice entry is served
    assert.equal((await call(w.liar, op, inputOf(op), "knowledge")).status, 200, op);
  }
  const after = Number(appDb.prepare("SELECT COUNT(*) AS n FROM connect_data_audit").get()?.n);
  assert.equal(after - before, 3, "only the three served calls reached the handler");
  shares.set(account, "knowledge", "none");
  shares.set(account, "observer", "none");
});

test("an app the slice does not list yet is identified by the grant prd (GRANT-PRD), and only by it", async () => {
  shares.set(account, "knowledge", "shared", true);
  const served = await call(w.stranger, "data_catalog", inputOf("data_catalog"), "knowledge");
  assert.equal(served.status, 200, JSON.stringify(served.body));
  assert.equal(served.body.output.account, account);
  // a prd with no share sees nothing; without a prd the caller is unverified again
  assert.equal(code(await call(w.stranger, "data_catalog", inputOf("data_catalog"), "observer")), "not_found");
  assert.equal(code(await call(w.stranger, "data_catalog", inputOf("data_catalog"))), "caller_unverified");
  shares.set(account, "knowledge", "none");
});
