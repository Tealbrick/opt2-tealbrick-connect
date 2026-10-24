/**
 * C336 RQ-3 on the REAL SDK (M-OP-12, specs#47 head 3c108b0): data_lease over HTTP with a signed grant and call proof. The
 * receipt row the SDK writes (input digest + the handler's redacted summary) must never hold the credential, and the
 * answer is not kept in the idempotency table. The database client is a fake; the DSN is sealed in the real app secret store.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";

import { digest, type Ed25519KeyPair, generateKeyPair, signCallProof, signGrant, signKeySetStatement, signSlice, ulid } from "@opt2-tealbrick/manifest";
import { defineApp, startApp, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Db, Json, RunningApp } from "@opt2-tealbrick/spec/sdk";

import { createConnectApp } from "../src/app.ts";
import { DatabaseAccountStore, type DatabaseDriver, type DbRow, POSTGRES_SQL } from "../src/data/database.ts";
import { ShareStore } from "../src/data/shares.ts";
import { root } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const nowS = () => Math.floor(Date.now() / 1000);
const CANARY = "CANARY-pw-e2e-5c81d07a93";
const HOST = "db.e2e-example.com";
const USER = "e2e_readonly_user";

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
      companionCallers: [{ product: "knowledge", ins: w.liar, name: "Knowledge" }],
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
  const fake: DatabaseDriver = {
    async connect() {
      return {
        async query(sql: string): Promise<DbRow[]> {
          if (sql === POSTGRES_SQL.columns) return [{ table_schema: "public", table_name: "customers", column_name: "id", data_type: "bigint", table_type: "BASE TABLE" }];
          return [];
        },
        async close() {},
      };
    },
  };
  const definition = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), dataDir, ErrorClass: TbError, databaseDrivers: { postgres: fake }, databaseLookup: async () => [{ address: "93.184.216.34", family: 4 }] });
  const app = defineApp({
    ...definition,
    onStart: async (ctx) => {
      await definition.onStart?.(ctx);
      appDb = ctx.db;
      // owner state: one database (DSN sealed in the REAL app secret store), shared with the Knowledge instance
      const created = await new DatabaseAccountStore(ctx.db, ctx.secrets).create({
        kind: "postgres",
        label: "Shop DB",
        dsn: { host: HOST, port: 5432, database: "shop", user: USER, password: CANARY, sslmode: "verify-full" },
      });
      account = created.id;
      shares = new ShareStore(ctx.db, "connect_db_shares");
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

const code = (r: { body: Record<string, any> }): unknown => r.body.error?.code ?? r.body.code;
/** the app database file as the SDK wrote it, read-only (the app handle refuses tb_* tables) */
const rawDb = () => new DatabaseSync(join(dataDir, "app.db"), { readOnly: true });
const everything = (): string => {
  const db = rawDb();
  const out: string[] = [];
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) out.push(JSON.stringify(db.prepare(`SELECT * FROM ${String(t.name)}`).all()));
  db.close();
  return out.join("\n");
};

test("data_lease on the real SDK: the answer carries the password; the receipt row (digest + redacted summary) and every table do not (M-OP-12)", async () => {
  shares.set(account, "knowledge", "shared", false, w.liar);
  const r = await call(w.liar, "data_lease", { account, datasets: ["public.customers"], ttlS: 120 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.output.password, CANARY, "the one place it is allowed");
  assert.equal(r.body.output.host, HOST);
  const raw = rawDb();
  const receipts = raw.prepare("SELECT * FROM tb_receipts WHERE op = 'data_lease'").all().map((x) => ({ ...x }));
  assert.equal(receipts.length, 1, "credential issuance is audited by a receipt");
  const receipt = receipts[0] as Record<string, unknown>;
  assert.equal(receipt.status, "run");
  assert.match(String(receipt.input_digest), /^sha256:/u);
  assert.equal(receipt.summary, `Database lease for Knowledge: 1 table of “Shop DB” until ${r.body.output.expiresAt}`);
  assert.deepEqual(JSON.parse(String(receipt.meta)), { account, lease: r.body.output.leaseId, datasets: ["public.customers"], expiresAt: r.body.output.expiresAt });
  const row = JSON.stringify(receipt);
  for (const secret of [CANARY, HOST, USER, "93.184.216.34"]) assert.ok(!row.includes(secret), `receipt row has no ${secret}`);
  // nothing else in the database holds the credential either (the sealed store is encrypted); no idempotency copy of the answer
  const dump = everything();
  for (const secret of [CANARY, USER]) assert.ok(!dump.includes(secret), `no table has ${secret}`);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM tb_idempotency WHERE op = 'data_lease'").get()?.n, 0);
  raw.close();
  shares.set(account, "knowledge", "none");
});

test("data_lease on the real SDK: an agent is refused no_access (spec code secret_output_app_only after the pin moves); an error carries a fixed message", async () => {
  shares.set(account, "knowledge", "shared", false, w.liar);
  const agent = await call(w.agent, "data_lease", { account, datasets: ["public.customers"] });
  assert.deepEqual([agent.status, code(agent)], [403, "no_access"]);
  assert.equal(agent.body.output, undefined);
  const missing = await call(w.liar, "data_lease", { account, datasets: ["public.nothing"] });
  assert.deepEqual([missing.status, code(missing)], [404, "dataset_not_found"]);
  assert.equal(missing.body.error.message, "A requested dataset is not in the catalog of this database. Read data_catalog and ask again.");
  assert.ok(!JSON.stringify(missing.body).includes(CANARY) && !JSON.stringify(missing.body).includes(HOST));
  shares.set(account, "knowledge", "none");
});
