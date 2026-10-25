/**
 * C336 RQ-3: database accounts, sharing with a route, the metadata-only catalog and the data_lease op.
 * Real handlers, real SQLite. The database client is a FAKE (an injected driver): no test opens a network connection.
 * The password is a canary string; the tests look for it in every place it must not appear.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { validateManifest } from "@opt2-tealbrick/manifest";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Json, Logger } from "@opt2-tealbrick/spec/sdk";

import { createConnectApp } from "../src/app.ts";
import { type DatabaseDriver, type DbRow, type DbSession, type DbTarget, POSTGRES_SQL } from "../src/data/database.ts";
import { eventCtx, handlerOf, root, secretsFor, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const AGENT = "agt_01DATAAGENT000000000000000";
const KNOWLEDGE = "ins_01HZKNWDG00000000000000000";
const OBSERVER = "ins_01HZ0BSRVR0000000000000000";
const KNOWLEDGE_2 = "ins_01HZKNWDG20000000000000000";
/** the database password of every test: looked for in every output, record and log line */
const CANARY = "CANARY-pw-7f3a91c2e5d84b6a";
const PUBLIC_IP = "93.184.216.34";

const REAL_STATEMENTS = new Set<string>(Object.values(POSTGRES_SQL));

/** The fake Postgres client: answers only the fixed metadata statements and fails the test on any other. */
function fakeDriver() {
  const sent: string[] = [];
  const targets: DbTarget[] = [];
  const state = { role: { rolsuper: false, rolreplication: false } as DbRow, failWith: null as null | Error, tablesEvery: 1 };
  // in the order of the real statement (ORDER BY schema, table, position)
  const columns: DbRow[] = [
    { table_schema: "public", table_name: "customers", column_name: "id", data_type: "bigint", table_type: "BASE TABLE" },
    { table_schema: "public", table_name: "customers", column_name: "email", data_type: "text", table_type: "BASE TABLE" },
    // names that cannot be written as schema.table are left out
    { table_schema: "public", table_name: "dotted.name", column_name: "id", data_type: "integer", table_type: "BASE TABLE" },
    { table_schema: "public", table_name: "fresh", column_name: "id", data_type: "integer", table_type: "BASE TABLE" },
    { table_schema: "public", table_name: "orders", column_name: "id", data_type: "bigint", table_type: "BASE TABLE" },
    { table_schema: "sales", table_name: "monthly", column_name: "total", data_type: "numeric", table_type: "VIEW" },
  ];
  const rows: DbRow[] = [
    { table_schema: "public", table_name: "customers", approx_rows: "1200" },
    { table_schema: "public", table_name: "orders", approx_rows: 54000 },
    { table_schema: "sales", table_name: "monthly", approx_rows: -1 },
    { table_schema: "public", table_name: "fresh", approx_rows: -1 },
  ];
  const driver: DatabaseDriver = {
    async connect(target) {
      targets.push(target);
      if (state.failWith) throw state.failWith;
      const session: DbSession = {
        async query(sql, params) {
          sent.push(sql);
          assert.ok(REAL_STATEMENTS.has(sql), `only the fixed metadata statements may be sent, got: ${sql.slice(0, 60)}`);
          assert.equal(params, undefined, "no statement takes a parameter");
          if (sql === POSTGRES_SQL.role) return [state.role];
          if (sql === POSTGRES_SQL.columns) return columns;
          return rows;
        },
        async close() {},
      };
      return session;
    },
  };
  return { driver, sent, targets, state };
}

type Logged = { level: string; msg: string; fields?: Record<string, Json> };

async function setup(options: { callers?: { product: string; ins: string; name: string; provider?: string | null }[] } = {}) {
  const fake = fakeDriver();
  const logs: Logged[] = [];
  const log: Logger = {
    debug: (msg, fields) => void logs.push({ level: "debug", msg, ...(fields ? { fields } : {}) }),
    info: (msg, fields) => void logs.push({ level: "info", msg, ...(fields ? { fields } : {}) }),
    warn: (msg, fields) => void logs.push({ level: "warn", msg, ...(fields ? { fields } : {}) }),
    error: (msg, fields) => void logs.push({ level: "error", msg, ...(fields ? { fields } : {}) }),
  };
  const lookup = async (host: string) => {
    if (host === "db.example.com") return [{ address: PUBLIC_IP, family: 4 }];
    if (host === "private.example.com") return [{ address: "10.0.0.5", family: 4 }];
    if (host === "mixed.example.com") return [{ address: PUBLIC_IP, family: 4 }, { address: "192.168.1.10", family: 4 }];
    throw new Error("ENOTFOUND");
  };
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), databaseDrivers: { postgres: fake.driver }, databaseLookup: lookup });
  const db = testDb();
  await app.events?.agentAdded?.({ id: AGENT as `agt_${string}`, name: "Agent", mode: "free", status: "active" }, eventCtx(db));
  const callers = options.callers ?? [
    { product: "knowledge", ins: KNOWLEDGE, name: "Knowledge", provider: "railway" },
    { product: "observer", ins: OBSERVER, name: "Observer", provider: "railway" },
  ];
  const person = testCtx({ db, person: true, log, companionCallers: callers });
  const knowledge = testCtx({ db, app: KNOWLEDGE, appName: "Knowledge", appProduct: "knowledge", appListed: true, log });
  const observer = testCtx({ db, app: OBSERVER, appName: "Observer", appProduct: "observer", appListed: true, log });
  const agent = testCtx({ db, agent: AGENT, access: {}, log });
  const op = (name: string, input: Record<string, unknown>, ctx = person) => handlerOf(app, name)(input as Json, ctx);
  const form = (extra: Record<string, unknown> = {}) => ({ label: "Shop DB", host: "db.example.com", port: 5432, database: "shop", user: "readonly", password: CANARY, sslmode: "verify-full", ...extra });
  const connect = async (extra: Record<string, unknown> = {}): Promise<string> => ((await op("database_account_connect", form(extra))) as unknown as { account: { id: string } }).account.id;
  const instanceOf: Record<string, string> = { knowledge: KNOWLEDGE, observer: OBSERVER };
  const share = (account: string, product: string, level: string, extra: Record<string, unknown> = {}) =>
    op("account_app_share", { account, product, level, ...(level === "none" ? {} : { instance: instanceOf[product] }), ...extra });
  const lease = (account: string, datasets: string[], extra: Record<string, unknown> = {}, ctx = knowledge) => op("data_lease", { account, datasets, ...extra }, ctx);
  return { db, app, fake, logs, op, form, connect, share, lease, ctx: { person, knowledge, observer, agent }, receipts: person.receipts };
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; httpStatus: number; message: string }> {
  try {
    await p;
  } catch (e) {
    const { code, httpStatus, message } = e as { code: string; httpStatus: number; message: string };
    return { code, httpStatus, message };
  }
  throw new Error("expected a refusal, the call succeeded");
}

/** every row of every table of the app database, as one string */
function dump(db: ReturnType<typeof testDb>): string {
  const out: string[] = [];
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) out.push(JSON.stringify(db.prepare(`SELECT * FROM ${String(t.name)}`).all()));
  return out.join("\n");
}

const DATASETS = ["public.customers", "public.orders"];

// ── manifest ──

test("manifest: the SDK's own validator accepts it (description length, rules), as startApp will", () => {
  const result = validateManifest(manifest);
  assert.equal(result.ok, true, JSON.stringify(result.ok ? [] : result.errors));
});

test("manifest: data_lease follows M-OP-12 (read, idempotency none, receipt true, agent audience, not dynamic) and the owner ops are person ops", () => {
  const op = manifest.operations.find((o) => o.id === "data_lease");
  assert.deepEqual([op?.audience, op?.crud, op?.effect, op?.idempotency, op?.receipt, op?.scopeType, op?.dynamic, op?.holdFamily], ["agent", ["read"], "read", "none", true, undefined, undefined, undefined]);
  const input = op?.input as unknown as { properties: { datasets: { minItems: number; maxItems: number }; ttlS: { maximum: number } } };
  assert.deepEqual([input.properties.datasets.minItems, input.properties.datasets.maxItems, input.properties.ttlS.maximum], [1, 50, 900]);
  for (const id of ["database_account_connect", "data_leases_list", "data_lease_revoke"]) assert.equal(manifest.operations.find((o) => o.id === id)?.audience, "person", id);
  assert.equal(manifest.operations.find((o) => o.id === "data_lease_revoke")?.receipt, true);
  assert.equal(manifest.operations.find((o) => o.id === "database_account_connect")?.receipt, false, "the connect form carries a password: no receipt");
});

// ── adding a database ──

test("database_account_connect: the DSN is sealed, the list shows no user and no password, the role is checked", async () => {
  const t = await setup();
  const out = (await t.op("database_account_connect", t.form())) as unknown as { account: Record<string, unknown>; recommendation: string };
  assert.equal(out.account.source, "database");
  assert.equal(out.account.service, "postgres");
  assert.equal(out.account.endpoint, "db.example.com:5432/shop");
  assert.match(out.recommendation, /read-only/u);
  assert.match(out.recommendation, /REPLICATION/u);
  const id = String(out.account.id);
  assert.match(id, /^cdb_/u);
  // the DSN is in the sealed store only
  assert.deepEqual(secretsFor(t.db).names(), [`db:${id}`]);
  assert.ok(!dump(t.db).includes(CANARY), "no password in the database");
  assert.ok(!dump(t.db).includes("readonly"), "no user name in the database");
  // the role flags were read; the driver connected to the checked address, not the host name
  assert.deepEqual(t.fake.sent, [POSTGRES_SQL.role]);
  assert.equal(t.fake.targets[0]?.address, PUBLIC_IP);
  assert.equal(t.fake.targets[0]?.host, "db.example.com");
  const overview = JSON.stringify(await t.op("accounts_overview", {}));
  assert.ok(!overview.includes(CANARY) && !overview.includes("readonly"));
  assert.match(overview, /cdb_/u);
  // an agent cannot see it in its own list
  const mine = (await t.op("accounts_list", {}, t.ctx.agent)) as unknown as { accounts: unknown[] };
  assert.deepEqual(mine.accounts, []);
});

test("database_account_connect: private addresses and local names are refused, a mixed DNS answer too; nothing is stored", async () => {
  const t = await setup();
  for (const host of ["private.example.com", "mixed.example.com", "10.1.2.3", "127.0.0.1", "169.254.169.254", "localhost", "db.internal", "[::1]", "fd00::1"]) {
    const r = await refusal(t.op("database_account_connect", t.form({ host })));
    assert.equal(r.code, "endpoint_not_allowed", host);
    assert.equal(r.httpStatus, 422, host);
    assert.ok(!r.message.includes(CANARY));
  }
  assert.deepEqual(t.fake.targets, [], "the driver was never called");
  assert.deepEqual(secretsFor(t.db).names(), []);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM connect_db_accounts").get()?.n, 0);
});

test("database_account_connect: a superuser or a replication role is refused; bad fields are refused without the password in the text", async () => {
  const t = await setup();
  t.fake.state.role = { rolsuper: true, rolreplication: false };
  assert.equal((await refusal(t.op("database_account_connect", t.form()))).code, "database_role_too_powerful");
  t.fake.state.role = { rolsuper: false, rolreplication: true };
  const repl = await refusal(t.op("database_account_connect", t.form()));
  assert.equal(repl.code, "database_role_too_powerful");
  assert.match(repl.message, /REPLICATION/u);
  t.fake.state.role = { rolsuper: false, rolreplication: false };
  for (const bad of [{ port: 0 }, { port: 70000 }, { sslmode: "prefer" }, { host: "a b" }, { host: "user@db.example.com" }, { database: "" }, { password: "" }, { engine: "mysql" }]) {
    const r = await refusal(t.op("database_account_connect", t.form(bad)));
    assert.equal(r.httpStatus, 400, JSON.stringify(bad));
    assert.ok(!r.message.includes(CANARY));
  }
  assert.deepEqual(secretsFor(t.db).names(), []);
});

test("database_account_connect: a driver failure shows a fixed text and an allow-listed code, never the driver message or the password", async () => {
  const t = await setup();
  t.fake.state.failWith = Object.assign(new Error(`password authentication failed for user "readonly" password=${CANARY} host=db.example.com`), { code: "28P01" });
  const r = await refusal(t.op("database_account_connect", t.form()));
  assert.equal(r.code, "database_unreachable");
  assert.match(r.message, /28P01/u);
  assert.ok(!r.message.includes(CANARY) && !r.message.includes("readonly") && !r.message.includes("db.example.com"));
  // a driver error with a hostile code keeps no code at all
  t.fake.state.failWith = Object.assign(new Error("x"), { code: `bad code ${CANARY}` });
  const hostile = await refusal(t.op("database_account_connect", t.form()));
  assert.ok(!hostile.message.includes(CANARY));
  assert.deepEqual(secretsFor(t.db).names(), []);
});

test("a build with no driver says so (database_driver_unavailable)", async () => {
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), databaseLookup: async () => [{ address: PUBLIC_IP, family: 4 }] });
  const db = testDb();
  const person = testCtx({ db, person: true });
  const r = await refusal(handlerOf(app, "database_account_connect")({ label: "x", host: "db.example.com", database: "d", user: "u", password: CANARY } as Json, person));
  assert.equal(r.code, "database_driver_unavailable");
  assert.equal(r.httpStatus, 503);
});

// ── only apps, and only with a share ──

test("data ops refuse agents and the owner (no_access); data_lease needs an app with a verified product", async () => {
  const t = await setup();
  const id = await t.connect();
  await t.share(id, "knowledge", "shared");
  for (const ctx of [t.ctx.agent, t.ctx.person]) {
    for (const [name, input] of [["data_lease", { account: id, datasets: DATASETS }], ["data_catalog", { account: id }], ["data_accounts_list", {}]] as const) {
      const r = await refusal(t.op(name, input, ctx));
      assert.deepEqual([r.code, r.httpStatus], ["no_access", 403], name);
    }
  }
  const unverified = testCtx({ db: t.db, app: "ins_01HZVNVRFD0000000000000000", appName: "Knowledge" });
  assert.equal((await refusal(t.lease(id, DATASETS, {}, unverified))).code, "caller_unverified");
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM connect_data_leases").get()?.n, 0);
});

test("a database that is not shared, or shared for the catalog only, cannot be leased", async () => {
  const t = await setup();
  const id = await t.connect();
  const none = await refusal(t.lease(id, DATASETS));
  assert.deepEqual([none.code, none.httpStatus], ["not_found", 404]);
  // the unknown id and the real id that is not shared answer the same
  assert.deepEqual(await refusal(t.lease("cdb_01UNKNOWN", DATASETS)), none);
  await t.share(id, "knowledge", "available");
  const avail = await refusal(t.lease(id, DATASETS));
  assert.deepEqual([avail.code, avail.httpStatus], ["scope_denied", 403]);
  // the catalog works at this level
  const cat = (await t.op("data_catalog", { account: id }, t.ctx.knowledge)) as unknown as { datasets: { dataset: string }[] };
  assert.ok(cat.datasets.length > 0);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM connect_data_leases").get()?.n, 0);
  // a share bound to another instance serves nobody
  await t.share(id, "knowledge", "shared");
  const other = testCtx({ db: t.db, app: KNOWLEDGE_2, appName: "Knowledge", appProduct: "knowledge", appListed: true });
  assert.equal((await refusal(t.lease(id, DATASETS, {}, other))).code, "not_found");
  // an instance that is no longer listed is refused
  const gone = testCtx({ db: t.db, app: KNOWLEDGE, appName: "Knowledge", appProduct: "knowledge", appListed: false });
  assert.equal((await refusal(t.lease(id, DATASETS, {}, gone))).code, "share_instance_gone");
});

test("route via_observer: Knowledge gets nothing (not listed, not found, no lease); Observer reads through its own direct share", async () => {
  const t = await setup();
  const id = await t.connect();
  await t.share(id, "knowledge", "shared", { route: "via_observer" });
  const list = (await t.op("data_accounts_list", {}, t.ctx.knowledge)) as unknown as { accounts: unknown[] };
  assert.deepEqual(list.accounts, []);
  assert.equal((await refusal(t.op("data_catalog", { account: id }, t.ctx.knowledge))).code, "not_found");
  assert.equal((await refusal(t.lease(id, DATASETS))).code, "not_found");
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM connect_data_leases").get()?.n, 0);
  // Observer, shared directly
  await t.share(id, "observer", "shared");
  const granted = (await t.lease(id, DATASETS, {}, t.ctx.observer)) as unknown as { leaseId: string };
  assert.match(granted.leaseId, /^lse_/u);
  assert.equal(t.db.prepare("SELECT product FROM connect_data_leases WHERE id = ?").get(granted.leaseId)?.product, "observer");
  // Knowledge is still refused; back to direct it is served
  assert.equal((await refusal(t.lease(id, DATASETS))).code, "not_found");
  await t.share(id, "knowledge", "shared", { route: "direct" });
  assert.match(String(((await t.lease(id, DATASETS)) as unknown as { leaseId: string }).leaseId), /^lse_/u);
});

test("account_app_share on a database: levels, routes and refusals", async () => {
  const t = await setup();
  const id = await t.connect();
  const out = (await t.share(id, "knowledge", "shared")) as unknown as { route: string; shares: { route: string; level: string; current: boolean }[] };
  assert.equal(out.route, "direct", "direct is the default");
  assert.deepEqual(out.shares.map((s) => [s.route, s.level, s.current]), [["direct", "shared", true]]);
  // via_observer is for Knowledge only
  assert.equal((await refusal(t.share(id, "observer", "shared", { route: "via_observer" }))).code, "route_invalid");
  assert.equal((await refusal(t.share(id, "knowledge", "shared", { route: "sideways" }))).code, "route_invalid");
  // a chat account has no route
  t.db.exec(`INSERT INTO connect_accounts (id, service, source, kind, label, owner_agent, status, detail, created_at, updated_at) VALUES ('cna_chat','telegram','channel','as_itself','bot','${AGENT}','connected','',1,1)`);
  assert.equal((await refusal(t.share("cna_chat", "knowledge", "shared", { route: "via_observer" }))).code, "route_invalid");
  // an unknown database id and an unlisted instance
  assert.equal((await refusal(t.share("cdb_01NOPE", "knowledge", "shared"))).code, "account_not_found");
  assert.equal((await refusal(t.op("account_app_share", { account: id, product: "knowledge", level: "shared", instance: "ins_01HZNOTLISTED00000000000000" }))).code, "app_instance_unknown");
  assert.equal((await refusal(t.op("account_app_share", { account: id, product: "knowledge", level: "shared" }))).code, "instance_required");
  // agents and apps cannot share
  assert.equal((await refusal(t.op("account_app_share", { account: id, product: "knowledge", level: "shared", instance: KNOWLEDGE }, t.ctx.agent))).code, "no_access");
  assert.equal((await refusal(t.op("account_app_share", { account: id, product: "knowledge", level: "shared", instance: KNOWLEDGE }, t.ctx.knowledge))).code, "no_access");
  // none removes the row
  const gone = (await t.share(id, "knowledge", "none")) as unknown as { shares: unknown[] };
  assert.deepEqual(gone.shares, []);
  // the receipt names the sharing and carries no credential
  assert.ok(t.receipts.summary.every((s) => !s.includes(CANARY)));
  assert.match(t.receipts.summary[0] ?? "", /Shop DB/u);
});

test("data_pull on a database answers delivery_lease after the share check; a stranger learns nothing", async () => {
  const t = await setup();
  const id = await t.connect();
  assert.equal((await refusal(t.op("data_pull", { account: id, dataset: "public.customers" }, t.ctx.knowledge))).code, "not_found");
  await t.share(id, "knowledge", "shared");
  const r = await refusal(t.op("data_pull", { account: id, dataset: "public.customers" }, t.ctx.knowledge));
  assert.deepEqual([r.code, r.httpStatus], ["delivery_lease", 400]);
});

// ── the catalog: metadata only ──

test("data_catalog of a database: tables and views, columns, types, approximate rows; only metadata statements run", async () => {
  const t = await setup();
  const id = await t.connect();
  await t.share(id, "knowledge", "available");
  t.fake.sent.length = 0;
  const list = (await t.op("data_accounts_list", {}, t.ctx.knowledge)) as unknown as { accounts: { account: string; service: string; kinds: string[]; level: string; source: string }[] };
  assert.deepEqual(list.accounts.map((a) => [a.account, a.service, a.kinds, a.level, a.source]), [[id, "postgres", ["table"], "available", "database"]]);
  const cat = (await t.op("data_catalog", { account: id }, t.ctx.knowledge)) as unknown as {
    source: string; level: string; untrusted: boolean;
    datasets: { dataset: string; kind: string; delivery: string; relation: string; approxRows?: number; columns: { name: string; type: string }[] }[];
  };
  assert.deepEqual([cat.source, cat.level, cat.untrusted], ["database", "available", true]);
  assert.deepEqual(cat.datasets.map((d) => d.dataset), ["public.customers", "public.fresh", "public.orders", "sales.monthly"]);
  const customers = cat.datasets.find((d) => d.dataset === "public.customers");
  assert.deepEqual(customers, { dataset: "public.customers", title: "public.customers", kind: "table", delivery: "lease", relation: "table", approxRows: 1200, columns: [{ name: "id", type: "bigint" }, { name: "email", type: "text" }] });
  assert.equal(cat.datasets.find((d) => d.dataset === "sales.monthly")?.relation, "view");
  assert.equal("approxRows" in (cat.datasets.find((d) => d.dataset === "public.fresh") ?? {}), false, "no statistics = no count");
  assert.ok(cat.datasets.every((d) => d.delivery === "lease" && d.kind === "table"));
  // only the two catalog statements ran, and nothing selected table data
  assert.deepEqual(t.fake.sent, [POSTGRES_SQL.columns, POSTGRES_SQL.rows]);
  for (const sql of Object.values(POSTGRES_SQL)) assert.doesNotMatch(sql, /\bFROM\s+(public|sales)\./iu);
  // the answer carries no credential
  assert.ok(!JSON.stringify(cat).includes(CANARY));
});

// ── the lease ──

test("data_lease: the lease answer, the checked address, the record and the audit line", async () => {
  const t = await setup();
  const id = await t.connect();
  await t.share(id, "knowledge", "shared");
  const before = Date.now();
  const out = (await t.lease(id, DATASETS, { ttlS: 600 })) as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(out).sort(), ["checkedAddress", "database", "datasets", "expiresAt", "host", "kind", "leaseId", "password", "port", "sslmode", "user"]);
  assert.deepEqual([out.kind, out.host, out.port, out.checkedAddress, out.database, out.user, out.password, out.sslmode], ["postgres", "db.example.com", 5432, PUBLIC_IP, "shop", "readonly", CANARY, "verify-full"]);
  assert.deepEqual(out.datasets, DATASETS);
  const end = Date.parse(String(out.expiresAt));
  assert.ok(end >= before + 600_000 && end <= Date.now() + 600_000, "expiresAt is now + ttl");
  const lease = t.db.prepare("SELECT * FROM connect_data_leases WHERE id = ?").get(String(out.leaseId));
  assert.deepEqual([lease?.account_id, lease?.product, lease?.instance_id, lease?.datasets, Number(lease?.expires_at)], [id, "knowledge", KNOWLEDGE, JSON.stringify(DATASETS), end]);
  assert.equal(lease?.revoked_at, null);
  // the audit line names the lease, account, datasets, expiry and caller
  const line = t.db.prepare("SELECT * FROM connect_data_audit WHERE op = 'data_lease' ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual([line?.outcome, line?.caller_type, line?.caller_id, line?.product, line?.account_id, line?.dataset, line?.lease_id, Number(line?.lease_expires_at)], ["ok", "app", KNOWLEDGE, "knowledge", id, DATASETS.join(","), out.leaseId, end]);
  // the owner's access log shows it
  const log = (await t.op("data_access_log", {})) as unknown as { entries: { op: string; leaseId?: string; leaseExpiresAt?: string; datasets?: string[]; app: string; account: string }[] };
  const entry = log.entries.find((e) => e.op === "data_lease");
  assert.deepEqual([entry?.leaseId, entry?.leaseExpiresAt, entry?.datasets, entry?.app, entry?.account], [out.leaseId, out.expiresAt, DATASETS, "Knowledge", "Shop DB"]);
});

test("data_lease: ttl above 900 or not a whole number is refused, the default is 300; datasets are checked (1..50, schema.table, in the catalog)", async () => {
  const t = await setup();
  const id = await t.connect();
  await t.share(id, "knowledge", "shared");
  assert.equal((await refusal(t.lease(id, DATASETS, { ttlS: 901 }))).code, "ttl_too_long");
  for (const ttlS of [0, -5, 1.5, "60", 100000]) assert.match((await refusal(t.lease(id, DATASETS, { ttlS }))).code, /^ttl_/u, String(ttlS));
  const ok900 = (await t.lease(id, DATASETS, { ttlS: 900 })) as unknown as { expiresAt: string };
  assert.ok(Date.parse(ok900.expiresAt) <= Date.now() + 900_000);
  const dflt = (await t.lease(id, DATASETS)) as unknown as { expiresAt: string };
  const left = Date.parse(dflt.expiresAt) - Date.now();
  assert.ok(left > 290_000 && left <= 300_000, `default ttl ${left}`);
  // datasets
  assert.equal((await refusal(t.lease(id, []))).code, "datasets_required");
  assert.equal((await refusal(t.op("data_lease", { account: id }, t.ctx.knowledge))).code, "datasets_required");
  assert.equal((await refusal(t.lease(id, Array.from({ length: 51 }, (_, n) => `public.t${n}`)))).code, "too_many_datasets");
  for (const bad of ["customers", "public.customers.x", 'public."orders"', "public.", "pub lic.orders", 7]) assert.equal((await refusal(t.lease(id, [bad as string]))).code, "dataset_invalid", String(bad));
  // outside the catalog (also when mixed with a real one) and a name the catalog left out
  const missing = await refusal(t.lease(id, ["public.customers", "public.secrets"]));
  assert.deepEqual([missing.code, missing.httpStatus], ["dataset_not_found", 404]);
  assert.doesNotMatch(missing.message, /public\.secrets/u, "a fixed message: the requested names are not echoed");
  assert.equal((await refusal(t.lease(id, ["public.dotted"]))).code, "dataset_not_found");
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM connect_data_leases").get()?.n, 2, "only the two good leases were recorded");
  // duplicates collapse
  const dup = (await t.lease(id, ["public.orders", "public.orders"])) as unknown as { datasets: string[] };
  assert.deepEqual(dup.datasets, ["public.orders"]);
});

test("data_lease: the address is checked again at the lease (DNS that turned private is refused)", async () => {
  const t = await setup();
  const id = await t.connect();
  await t.share(id, "knowledge", "shared");
  // same account, the name now answers a private address: rebuild the app with that DNS over the same database
  const flip = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), databaseDrivers: { postgres: t.fake.driver }, databaseLookup: async () => [{ address: "10.0.0.9", family: 4 }] });
  const r = await refusal(handlerOf(flip, "data_lease")({ account: id, datasets: DATASETS } as Json, t.ctx.knowledge));
  assert.equal(r.code, "endpoint_not_allowed");
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM connect_data_leases").get()?.n, 0);
});

// ── the password goes nowhere but the lease answer ──

test("the password appears nowhere but the data_lease answer: records, audit, owner outputs, receipts, log lines, errors", async () => {
  const t = await setup();
  const id = await t.connect();
  await t.share(id, "knowledge", "shared");
  const granted = (await t.lease(id, DATASETS)) as unknown as { leaseId: string; password: string };
  assert.equal(granted.password, CANARY, "the one place it is allowed");
  const errors: string[] = [];
  const catching = async (p: Promise<unknown>) => void (await p.catch((e: Error & { details?: unknown }) => errors.push(`${e.message} ${JSON.stringify(e.details ?? {})} ${e.stack ?? ""}`)));
  // refusals on every path
  await catching(t.lease(id, ["public.nothing"]));
  await catching(t.lease(id, DATASETS, { ttlS: 9999 }));
  await catching(t.lease("cdb_01NOPE", DATASETS));
  await catching(t.lease(id, DATASETS, {}, t.ctx.agent));
  t.fake.state.failWith = Object.assign(new Error(`could not connect with password ${CANARY}`), { code: "ECONNREFUSED" });
  await catching(t.lease(id, DATASETS));
  await catching(t.op("data_catalog", { account: id }, t.ctx.knowledge));
  await catching(t.op("database_account_connect", t.form({ label: "again" })));
  t.fake.state.failWith = null;
  // the owner's outputs and the sharing / revoking receipts
  const outputs = [
    JSON.stringify(await t.op("data_leases_list", {})),
    JSON.stringify(await t.op("data_access_log", {})),
    JSON.stringify(await t.op("accounts_overview", {})),
    JSON.stringify(await t.share(id, "knowledge", "shared", { route: "direct" })),
    JSON.stringify(await t.op("data_lease_revoke", { lease: granted.leaseId })),
    JSON.stringify(await t.op("data_catalog", { account: id }, t.ctx.knowledge)),
    JSON.stringify(await t.op("data_accounts_list", {}, t.ctx.knowledge)),
  ];
  for (const o of outputs) assert.ok(!o.includes(CANARY), "owner output");
  assert.ok(errors.length >= 6, `errors collected: ${errors.length}`);
  for (const e of errors) assert.ok(!e.includes(CANARY), `error text: ${e.slice(0, 100)}`);
  assert.ok(!dump(t.db).includes(CANARY), "database (records, audit, shares, leases)");
  for (const r of [...t.receipts.summary, ...t.receipts.meta.map((m) => JSON.stringify(m))]) assert.ok(!r.includes(CANARY), "receipt");
  assert.ok(t.receipts.summary.length >= 2);
  // M-OP-12: data_lease has a receipt (summary + meta set by the handler; the SDK adds the input digest). No credential, host or user in it.
  const lease = t.ctx.knowledge.receipts;
  assert.ok(lease.summary.length >= 1, "every issued lease writes a receipt summary");
  assert.match(lease.summary[0] ?? "", /^Database lease for Knowledge: 2 tables of “Shop DB” until \d{4}-/u);
  assert.deepEqual(Object.keys((lease.meta[0] ?? {}) as object).sort(), ["account", "datasets", "expiresAt", "lease"]);
  for (const r of [...lease.summary, ...lease.meta.map((m) => JSON.stringify(m))]) for (const secret of [CANARY, "db.example.com", "readonly", PUBLIC_IP]) assert.ok(!r.includes(secret), `lease receipt has no ${secret}`);
  for (const l of t.logs) assert.ok(!JSON.stringify(l).includes(CANARY), `log line: ${l.msg}`);
  assert.ok(t.logs.some((l) => l.msg === "data_lease" && l.fields?.lease === granted.leaseId), "the lease is logged by id");
});

test("every error on the lease path has a code and a fixed message: no DSN, host, user or password in it", async () => {
  const HOST = "db.example.com";
  const clean = (e: { message: string; details?: unknown; stack?: string }): void => {
    const text = `${e.message} ${JSON.stringify(e.details ?? {})} ${e.stack ?? ""}`;
    for (const secret of [CANARY, HOST, "readonly", PUBLIC_IP, "5432", "shop"]) assert.ok(!text.includes(secret), `error text has no ${secret}: ${text.slice(0, 120)}`);
  };
  const fail = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      clean(e as Error);
      const { code, message, httpStatus } = e as { code: string; message: string; httpStatus: number };
      return { code, message, httpStatus };
    }
    throw new Error("expected a refusal");
  };
  const t = await setup();
  const id = await t.connect();
  await t.share(id, "knowledge", "shared");
  // the driver throws a message full of the DSN: no code, then a hostile code, then a real one
  t.fake.state.failWith = new Error(`FATAL: password authentication failed for user "readonly" at ${HOST}:5432 db shop password=${CANARY} ${PUBLIC_IP}`);
  const bare = await fail(t.lease(id, DATASETS));
  assert.deepEqual([bare.code, bare.httpStatus], ["database_unreachable", 502]);
  assert.equal(bare.message, "Connect could not read the database. Check the address, the user and the TLS setting, then try again.");
  t.fake.state.failWith = Object.assign(new Error(`${CANARY} ${HOST}`), { code: "ECONNREFUSED" });
  assert.equal((await fail(t.lease(id, DATASETS))).message, "Connect could not read the database (ECONNREFUSED). Check the address, the user and the TLS setting, then try again.");
  t.fake.state.failWith = Object.assign(new Error("x"), { code: `${CANARY}@${HOST}` });
  assert.equal((await fail(t.lease(id, DATASETS))).message, bare.message, "a code that is not on the allow list is dropped");
  t.fake.state.failWith = null;
  // a catalog that does not hold the dataset: fixed text, the caller's names are not echoed
  const missing = await fail(t.lease(id, ["public.nothing"]));
  assert.deepEqual([missing.code, missing.message], ["dataset_not_found", "A requested dataset is not in the catalog of this database. Read data_catalog and ask again."]);
  // the sealed DSN is damaged: a JSON error would quote it; the answer is fixed
  await secretsFor(t.db).put(`db:${id}`, `{"host":"${HOST}","port":5432,"database":"shop","user":"readonly","password":"${CANARY}`);
  for (const run of [() => t.lease(id, DATASETS), () => t.op("data_catalog", { account: id }, t.ctx.knowledge)]) {
    const r = await fail(run());
    assert.deepEqual([r.code, r.httpStatus, r.message], ["database_credentials_invalid", 409, "The stored database credentials cannot be read; connect it again."]);
  }
  await secretsFor(t.db).delete(`db:${id}`);
  assert.equal((await fail(t.lease(id, DATASETS))).code, "database_credentials_missing");
  // the host now fails DNS, or answers a private address: the policy text names a reason, never the host
  const dns = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), databaseDrivers: { postgres: t.fake.driver }, databaseLookup: async () => { throw new Error(`getaddrinfo ENOTFOUND ${HOST}`); } });
  await secretsFor(t.db).put(`db:${id}`, JSON.stringify({ host: HOST, port: 5432, database: "shop", user: "readonly", password: CANARY, sslmode: "verify-full" }));
  const lookup = await (async () => { try { await handlerOf(dns, "data_lease")({ account: id, datasets: DATASETS } as Json, t.ctx.knowledge); } catch (e) { clean(e as Error); return e as { code: string; message: string }; } throw new Error("expected a refusal"); })();
  assert.deepEqual([lookup.code, lookup.message], ["endpoint_not_allowed", "Endpoint is not allowed (dns_lookup_failed)."]);
  // an unexpected failure inside Connect (the lease record cannot be written) is a fixed lease_failed
  t.db.exec("ALTER TABLE connect_data_leases RENAME TO connect_data_leases_gone");
  const broken = await fail(t.lease(id, DATASETS));
  assert.deepEqual([broken.code, broken.httpStatus, broken.message], ["lease_failed", 500, "The lease could not be issued."]);
});

test("a lease whose audit line cannot be written is withheld and ended (nothing leaves unrecorded)", async () => {
  const t = await setup();
  const id = await t.connect();
  await t.share(id, "knowledge", "shared");
  t.db.exec("ALTER TABLE connect_data_audit RENAME TO connect_data_audit_gone");
  const r = await refusal(t.lease(id, DATASETS));
  assert.deepEqual([r.code, r.httpStatus], ["audit_unavailable", 503]);
  assert.ok(!r.message.includes(CANARY));
  const rows = t.db.prepare("SELECT revoked_at FROM connect_data_leases").all();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0]?.revoked_at, null, "the undelivered lease is ended");
});

// ── the owner ends leases ──

test("data_leases_list and data_lease_revoke: states, and a changed or removed share, or a disconnect, ends open leases", async () => {
  const t = await setup();
  const id = await t.connect();
  await t.share(id, "knowledge", "shared");
  const a = (await t.lease(id, ["public.customers"])) as unknown as { leaseId: string };
  const b = (await t.lease(id, ["public.orders"], { ttlS: 60 })) as unknown as { leaseId: string };
  type Row = { id: string; state: string; datasets: string[]; app: string; accountLabel: string; revokedAt: string | null };
  const list = async () => ((await t.op("data_leases_list", {})) as unknown as { leases: Row[] }).leases;
  assert.deepEqual((await list()).map((l) => [l.id, l.state]).sort(), [[a.leaseId, "active"], [b.leaseId, "active"]].sort());
  const first = (await list()).find((l) => l.id === a.leaseId);
  assert.deepEqual([first?.datasets, first?.app, first?.accountLabel], [["public.customers"], "Knowledge", "Shop DB"]);
  // the owner ends one
  const ended = (await t.op("data_lease_revoke", { lease: a.leaseId })) as unknown as { state: string };
  assert.equal(ended.state, "revoked");
  assert.equal((await refusal(t.op("data_lease_revoke", { lease: "lse_01NOPE" }))).code, "lease_not_found");
  assert.equal((await refusal(t.op("data_lease_revoke", { lease: b.leaseId }, t.ctx.agent))).code, "no_access");
  assert.equal((await refusal(t.op("data_leases_list", {}, t.ctx.knowledge))).code, "no_access");
  assert.match(t.receipts.summary.at(-1) ?? "", /Ended the database lease/u);
  // the same share again changes nothing
  await t.share(id, "knowledge", "shared");
  assert.equal((await list()).find((l) => l.id === b.leaseId)?.state, "active");
  // a changed level ends the open lease
  await t.share(id, "knowledge", "available");
  assert.equal((await list()).find((l) => l.id === b.leaseId)?.state, "revoked");
  // an expired lease shows as expired
  await t.share(id, "knowledge", "shared");
  const c = (await t.lease(id, ["public.customers"])) as unknown as { leaseId: string };
  t.db.prepare("UPDATE connect_data_leases SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, c.leaseId);
  assert.equal((await list()).find((l) => l.id === c.leaseId)?.state, "expired");
  // a removed share ends the open ones
  const d = (await t.lease(id, ["public.customers"])) as unknown as { leaseId: string };
  await t.share(id, "knowledge", "none");
  assert.equal((await list()).find((l) => l.id === d.leaseId)?.state, "revoked");
  // a share through Observer ends them as well
  await t.share(id, "knowledge", "shared");
  const e = (await t.lease(id, ["public.customers"])) as unknown as { leaseId: string };
  await t.share(id, "knowledge", "shared", { route: "via_observer" });
  assert.equal((await list()).find((l) => l.id === e.leaseId)?.state, "revoked");
  // disconnecting removes the seal and the shares, and ends the leases
  await t.share(id, "knowledge", "shared", { route: "direct" });
  const f = (await t.lease(id, ["public.customers"])) as unknown as { leaseId: string };
  await t.op("account_disconnect", { id });
  assert.deepEqual(secretsFor(t.db).names(), []);
  assert.equal((await list()).find((l) => l.id === f.leaseId)?.state, "revoked");
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM connect_db_shares").get()?.n, 0);
  assert.equal((await refusal(t.lease(id, ["public.customers"]))).code, "not_found");
  const overview = (await t.op("accounts_overview", {})) as unknown as { accounts: { id: string; status: string }[] };
  assert.equal(overview.accounts.find((x) => x.id === id)?.status, "revoked");
});

test("account_update renames a database; the data access log names a database by its label", async () => {
  const t = await setup();
  const id = await t.connect();
  const out = (await t.op("account_update", { id, label: "Shop (read only)" })) as unknown as { account: { label: string } };
  assert.equal(out.account.label, "Shop (read only)");
  assert.equal((await refusal(t.op("account_update", { id: "cdb_01NOPE", label: "x" }))).code, "account_not_found");
});

// ── upgrade ──

test("migration 0018 is expand only: numbering has no gap, old rows survive untouched, the new tables and columns work", () => {
  const dir = join(root, "migrations");
  const files = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();
  // The Coordinator's order: Inbox #23 = 0016, another PR = 0017, this PR = 0018. Until those two are on main the folder has
  // a gap at 0016 and 0017 (the SDK's gap-free check fails locally for the real-SDK tests and conformance, by design); every
  // number below this migration is gap-free from 0001 and this one is the last.
  const numbers = files.map((f) => Number(f.slice(0, 4)));
  assert.deepEqual(numbers.slice(0, -1), numbers.slice(0, -1).map((_, n) => n + 1), "gap-free from 0001 below this migration");
  assert.equal(numbers.at(-1), 18);
  assert.equal(files.at(-1), "0018_database_accounts.sql");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of files.filter((n) => n < "0018")) db.exec(readFileSync(join(dir, f), "utf8"));
  db.exec(`INSERT INTO connect_accounts (id, service, source, kind, label, owner_agent, status, detail, created_at, updated_at) VALUES ('a1','telegram','channel','as_itself','x','agt_1','connected','',1,1)`);
  db.exec(`INSERT INTO connect_account_shares (account_id, product, level, include_history, set_at, instance_id) VALUES ('a1', 'knowledge', 'shared', 1, 5, 'ins_1')`);
  db.exec(`INSERT INTO connect_data_audit (at, op, outcome, caller_type, caller_id, product, account_id, dataset, row_count, quarantined) VALUES (1,'data_pull','ok','app','ins_1','knowledge','a1','messages',3,0)`);
  const snapshot = (): string =>
    JSON.stringify(["connect_accounts", "connect_account_shares", "connect_data_audit"].map((t) => db.prepare(`SELECT * FROM ${t}`).all()));
  const before = snapshot();
  db.exec(readFileSync(join(dir, "0018_database_accounts.sql"), "utf8"));
  // old columns and values are unchanged; the two new audit columns are NULL for old rows
  const after = JSON.parse(snapshot()) as Record<string, unknown>[][];
  const old = JSON.parse(before) as Record<string, unknown>[][];
  assert.deepEqual(after[0], old[0]);
  assert.deepEqual(after[1], old[1]);
  assert.deepEqual(after[2]?.map((r) => ({ ...r, lease_id: undefined, lease_expires_at: undefined })), old[2]?.map((r) => ({ ...r, lease_id: undefined, lease_expires_at: undefined })));
  assert.equal(after[2]?.[0]?.lease_id, null);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  // new tables: a database, a share with a route, a lease
  db.exec(`INSERT INTO connect_db_accounts (id, kind, label, endpoint, status, created_at, updated_at) VALUES ('cdb_1','postgres','db','h:5432/d','connected',1,1)`);
  db.exec(`INSERT INTO connect_db_shares (account_id, product, level, instance_id, set_at) VALUES ('cdb_1','knowledge','shared','ins_1',1)`);
  assert.equal(db.prepare("SELECT route FROM connect_db_shares").get()?.route, "direct");
  assert.throws(() => db.exec(`UPDATE connect_db_shares SET route = 'sideways'`), /CHECK/u);
  assert.throws(() => db.exec(`INSERT INTO connect_db_shares (account_id, product, level, instance_id, set_at) VALUES ('cdb_nope','knowledge','shared','ins_1',1)`), /FOREIGN KEY/u);
  db.exec(`INSERT INTO connect_data_leases (id, account_id, product, instance_id, datasets, issued_at, expires_at) VALUES ('lse_1','cdb_1','knowledge','ins_1','[]',1,2)`);
  db.exec("DELETE FROM connect_db_accounts WHERE id = 'cdb_1'");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connect_data_leases").get()?.n, 0, "leases follow their database");
  // the chat accounts were never touched by a database being removed
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connect_account_shares").get()?.n, 1);
});
