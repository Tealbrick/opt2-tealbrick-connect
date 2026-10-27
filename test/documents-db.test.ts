/**
 * C373: the `documents` dataset of a database account: table rows as CSV documents (contract documents/1, DRAFT).
 * Real handlers, real SQLite; the Postgres client is a FAKE driver that knows the catalog statements, the fixed pull
 * statements and the generated page SELECT, and records every statement in order. No network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { JsonSchemaObject, Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Json } from "@opt2-tealbrick/spec/sdk";

import { createConnectApp } from "../src/app.ts";
import { type DatabaseDriver, type DbRow, type DbSession, type DbTable, POSTGRES_SQL, readCatalog } from "../src/data/database.ts";
import { type DocumentsPage, decodeDocCursor } from "../src/data/documents.ts";
import { DB_PULL_ROW_CAP, isSecretColumn, POSTGRES_PULL_SQL, pageSql, ROWS_PER_DOCUMENT, toCsv } from "../src/data/table-documents.ts";
import { isForbiddenAddress, resolvePublicHost } from "../src/util/net-policy.ts";
import { handlerOf, root, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const schema = JSON.parse(readFileSync(join(root, "test", "contracts", "documents.1.schema.json"), "utf8")) as JsonSchemaObject;
const KNOWLEDGE = "ins_01HZKNWDG00000000000000000";
const OBSERVER = "ins_01HZ0BSRVR0000000000000000";
const AGENT = "agt_01DATAAGENT000000000000000";
const CANARY = "CANARY-pw-0b9d2c";
/** a Railway public TCP proxy answers with addresses like this one (66.33.22.0/24, public) */
const RAILWAY_PROXY_IP = "66.33.22.231";

/** customers: 450 rows with a primary key; notes: 3 rows, no key; monthly: a view of 2 rows; empty: no rows; `wide` (option): 120 rows of 3 KB with a key */
function fakePg(options: { wide?: boolean } = {}) {
  const sent: { sql: string; params?: readonly unknown[] }[] = [];
  const state = { role: { rolsuper: false, rolreplication: false } as DbRow, fail: new Set<string>(), failCode: "42501" };
  const columns: DbRow[] = [
    { table_schema: "public", table_name: "customers", column_name: "id", data_type: "bigint", table_type: "BASE TABLE" },
    { table_schema: "public", table_name: "customers", column_name: "name", data_type: "text", table_type: "BASE TABLE" },
    { table_schema: "public", table_name: "customers", column_name: "password_hash", data_type: "text", table_type: "BASE TABLE" },
    { table_schema: "public", table_name: "empty", column_name: "id", data_type: "integer", table_type: "BASE TABLE" },
    { table_schema: "public", table_name: "notes", column_name: "body", data_type: "text", table_type: "BASE TABLE" },
    { table_schema: "public", table_name: "tokens", column_name: "apiKey", data_type: "text", table_type: "BASE TABLE" },
    { table_schema: "sales", table_name: "monthly", column_name: "month", data_type: "text", table_type: "VIEW" },
    { table_schema: "sales", table_name: "monthly", column_name: "total", data_type: "numeric", table_type: "VIEW" },
    ...(options.wide
      ? [
          { table_schema: "public", table_name: "wide", column_name: "id", data_type: "bigint", table_type: "BASE TABLE" },
          { table_schema: "public", table_name: "wide", column_name: "body", data_type: "text", table_type: "BASE TABLE" },
        ]
      : []),
  ];
  const data: Record<string, DbRow[]> = {
    "public.customers": Array.from({ length: 450 }, (_v, i) => ({ id: String(i + 1), name: i === 0 ? 'Acme, "LLC"\nHQ' : `Customer ${i + 1}`, password_hash: CANARY })),
    "public.tokens": [{ apiKey: CANARY }],
    "public.empty": [],
    "public.notes": [{ body: "first" }, { body: null }, { body: "third" }],
    "sales.monthly": [{ month: "2026-09", total: "12000.50" }, { month: "2026-10", total: "13000" }],
    ...(options.wide ? { "public.wide": Array.from({ length: 120 }, (_v, i) => ({ id: String(i + 1), body: `r${i + 1}:${"x".repeat(3000)}` })) } : {}),
  };
  const keyOf: Record<string, string> = { customers: "id", wide: "id" };
  const fixed = new Set<string>([...Object.values(POSTGRES_SQL), ...Object.values(POSTGRES_PULL_SQL)]);
  const driver: DatabaseDriver = {
    async connect() {
      return {
        async query(sql, params) {
          sent.push({ sql, ...(params ? { params } : {}) });
          if (sql === POSTGRES_SQL.role) return [state.role];
          if (sql === POSTGRES_SQL.columns) return columns;
          if (sql === POSTGRES_SQL.rows) return [{ table_schema: "public", table_name: "customers", approx_rows: 450 }];
          if (sql === POSTGRES_PULL_SQL.primaryKey) return params?.[1] && keyOf[String(params[1])] ? [{ attname: keyOf[String(params[1])] }] : [];
          if (fixed.has(sql)) return [];
          // the generated page SELECT: FROM "<schema>"."<table>" AS src [WHERE ...] ORDER BY ... LIMIT $1 [OFFSET $2]
          const match = /FROM "([^"]+)"\."([^"]+)" AS src( WHERE .+)? ORDER BY .+ LIMIT \$1( OFFSET \$2)?$/u.exec(sql);
          assert.ok(match, `unexpected statement: ${sql.slice(0, 120)}`);
          const name = `${match[1]}.${match[2]}`;
          if (state.fail.has(name)) throw Object.assign(new Error(`permission denied for ${name} (host secret.internal)`), { code: state.failCode });
          const rows = data[name] ?? [];
          const limit = params?.[0] as number;
          if (match[4]) return rows.slice(params?.[1] as number, (params?.[1] as number) + limit);
          // keyset: the first key column, numeric
          const after = match[3] ? Number(params?.[1]) : 0;
          return rows.filter((r) => Number(r.id) > after).slice(0, limit);
        },
        async close() {},
      };
    },
  };
  return { driver, sent, state, data };
}

async function setup(options: Parameters<typeof fakePg>[0] = {}) {
  const fake = fakePg(options);
  const lookup = async (host: string) => {
    if (host === "sakura.proxy.example.net") return [{ address: RAILWAY_PROXY_IP, family: 4 }];
    if (host === "private.example.com") return [{ address: "10.0.0.5", family: 4 }];
    throw new Error("ENOTFOUND");
  };
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), databaseDrivers: { postgres: fake.driver }, databaseLookup: lookup });
  const db = testDb();
  const callers = [
    { product: "knowledge", ins: KNOWLEDGE, name: "Knowledge", provider: "railway" },
    { product: "observer", ins: OBSERVER, name: "Observer", provider: "railway" },
  ];
  const person = testCtx({ db, person: true, companionCallers: callers });
  const observer = testCtx({ db, app: OBSERVER, appName: "Observer", appProduct: "observer", appListed: true });
  const knowledge = testCtx({ db, app: KNOWLEDGE, appName: "Knowledge", appProduct: "knowledge", appListed: true });
  const agent = testCtx({ db, agent: AGENT, access: {} });
  const op = (name: string, input: Record<string, unknown>, ctx = person) => handlerOf(app, name)(input as Json, ctx);
  const connect = async (extra: Record<string, unknown> = {}) =>
    ((await op("database_account_connect", { label: "Acme orders", host: "sakura.proxy.example.net", port: 23634, database: "railway", user: "acme_reader", password: CANARY, sslmode: "require", ...extra })) as unknown as { account: { id: string } }).account.id;
  const share = (account: string, product: string, level: string) => op("account_app_share", { account, product, level, ...(level === "none" ? {} : { instance: product === "knowledge" ? KNOWLEDGE : OBSERVER }) });
  const pull = async (account: string, input: Record<string, unknown> = {}, ctx = observer) => {
    const page = (await op("data_pull", { account, dataset: "documents", ...input }, ctx)) as unknown as DocumentsPage & { schema: string };
    assert.deepEqual(validateAgainstSchema(schema, page as unknown as Json), { ok: true }, "every page is valid documents/1");
    return page;
  };
  return { db, fake, op, connect, share, pull, ctx: { person, observer, knowledge, agent } };
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

test("database documents: a Railway-style public TCP proxy passes the address policy; a private host does not (policy unchanged)", async () => {
  assert.equal(isForbiddenAddress(RAILWAY_PROXY_IP), false);
  assert.deepEqual(await resolvePublicHost("sakura.proxy.example.net", { lookup: async () => [{ address: RAILWAY_PROXY_IP, family: 4 }] }), { host: "sakura.proxy.example.net", address: RAILWAY_PROXY_IP });
  await assert.rejects(resolvePublicHost("private.example.com", { lookup: async () => [{ address: "10.0.0.5", family: 4 }] }), /address_not_allowed/u);
  await assert.rejects(resolvePublicHost("db.railway.internal"), /hostname_not_allowed/u);
  const t = await setup();
  const id = await t.connect();
  const overview = (await t.op("accounts_overview", {})) as unknown as { accounts: { id: string; sslmode?: string; endpoint?: string }[] };
  const row = overview.accounts.find((a) => a.id === id);
  assert.deepEqual([row?.endpoint, row?.sslmode], ["sakura.proxy.example.net:23634/railway", "require"], "the TLS mode is shown, never a credential");
  assert.ok(!JSON.stringify(overview).includes(CANARY));
  assert.equal((await refusal(t.connect({ host: "private.example.com" }))).code, "endpoint_not_allowed");
});

test("database documents: catalog, then table pages as CSV in one READ ONLY transaction, by primary key, ctid or every column", async () => {
  const t = await setup();
  const id = await t.connect();
  await t.share(id, "observer", "shared");
  const list = (await t.op("data_accounts_list", {}, t.ctx.observer)) as unknown as { accounts: { account: string; datasets: string[] }[] };
  assert.deepEqual(list.accounts.map((a) => [a.account, a.datasets]), [[id, ["documents"]]]);
  const cat = (await t.op("data_catalog", { account: id }, t.ctx.observer)) as unknown as { datasets: { dataset: string; collections?: { id: string; approxRows: number }[] }[] };
  // secret-looking columns are named in the catalog and never selected
  assert.deepEqual(cat.datasets[0]?.collections, [
    { id: "public.customers", name: "public.customers", approxRows: 3, droppedColumns: ["password_hash"] },
    { id: "public.empty", name: "public.empty", approxRows: 0 },
    { id: "public.notes", name: "public.notes", approxRows: 0 },
    { id: "public.tokens", name: "public.tokens", approxRows: 0, droppedColumns: ["apiKey"] },
    { id: "sales.monthly", name: "sales.monthly", approxRows: 0 },
  ]);

  t.fake.sent.length = 0;
  const seen: DocumentsPage["rows"] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 10; i += 1) {
    const page = await t.pull(id, { limit: 2, ...(cursor ? { cursor } : {}) });
    assert.equal(page.schema, "documents/1");
    seen.push(...page.rows);
    if (page.exhausted) break;
    cursor = page.nextCursor;
  }
  assert.deepEqual(seen.map((r) => r.id), ["public.customers:1", "public.customers:2", "public.customers:3", "public.notes:1", "sales.monthly:1"]);
  const [c1, c2, c3, notes, monthly] = seen;
  assert.deepEqual([c1?.collection, c1?.mime, c1?.kind, c1?.title, c1?.untrusted], ["public.customers", "text/csv", "table", "public.customers rows 1–200", true]);
  const lines = (c1?.text ?? "").split("\n");
  assert.deepEqual(lines.slice(0, 2), ["id,name", '1,"Acme, ""LLC""']);
  assert.equal(c2?.title, "public.customers rows 201–400");
  assert.equal(c3?.title, "public.customers rows 401–450");
  assert.equal(notes?.text, "body\nfirst\n\nthird", "NULL is an empty cell");
  assert.equal(monthly?.text, "month,total\n2026-09,12000.50\n2026-10,13000");
  assert.match(c1?.rev ?? "", /^v1-[0-9a-f]{64}$/u);
  assert.ok(!t.fake.sent.some((s) => s.sql.includes("password_hash") && s.sql.includes("::text")), "a secret-looking column is never selected");
  assert.ok(!t.fake.sent.some((s) => s.sql.includes('"public"."tokens"')), "a table of only secret-looking columns is not read");

  // every pull: role check and catalog, then BEGIN READ ONLY + statement timeout first, ROLLBACK last
  const statements = t.fake.sent.map((s) => s.sql);
  const begins = statements.filter((s) => s === POSTGRES_PULL_SQL.begin).length;
  assert.equal(begins, statements.filter((s) => s === POSTGRES_PULL_SQL.rollback).length);
  assert.ok(begins >= 3);
  for (let i = 0; i < statements.length; i += 1) {
    if (statements[i] !== POSTGRES_PULL_SQL.begin) continue;
    assert.deepEqual(statements.slice(i - 3, i + 2), [POSTGRES_SQL.role, POSTGRES_SQL.columns, POSTGRES_SQL.rows, POSTGRES_PULL_SQL.begin, POSTGRES_PULL_SQL.timeout]);
  }
  assert.match(POSTGRES_PULL_SQL.begin, /READ ONLY/u);
  // ordering: primary key for customers, ctid for notes (no key), every column for the view
  const selects = t.fake.sent.filter((s) => s.sql.startsWith("SELECT left(src."));
  assert.ok(selects.some((s) => s.sql.includes('FROM "public"."customers" AS src ORDER BY src."id" LIMIT')));
  assert.ok(selects.some((s) => s.sql.includes('FROM "public"."notes" AS src ORDER BY src.ctid LIMIT')));
  assert.ok(selects.some((s) => s.sql.includes('FROM "sales"."monthly" AS src ORDER BY 1, 2 LIMIT')));
  assert.ok(selects.every((s) => s.params?.[0] === ROWS_PER_DOCUMENT + 1), "LIMIT 201: one more row tells whether the table goes on");
  // QA-CONNECT35-5: a table with a key pages by key (WHERE key > last), never by a growing OFFSET; every cell is cut in SQL (QA-CONNECT35-7)
  const customerPages = selects.filter((s) => s.sql.includes('"public"."customers"'));
  assert.ok(customerPages.some((s) => s.sql.includes('WHERE src."id" > $2 ORDER BY src."id" LIMIT $1') && s.params?.[1] === "200"));
  assert.ok(customerPages.every((s) => !s.sql.includes("OFFSET")));
  assert.ok(selects.every((s) => /left\(src\."[^"]+"::text, 4097\)/u.test(s.sql)));
  // the sealed password never shows
  assert.ok(!JSON.stringify(seen).includes(CANARY));
  // a served pull writes its audit line
  const line = t.db.prepare("SELECT outcome, product, account_id, dataset, row_count FROM connect_data_audit WHERE op = 'data_pull' ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual({ ...line }, { outcome: "ok", product: "observer", account_id: id, dataset: "documents", row_count: 1 });
});

test("database documents: one collection; the cursor is refused on another account or collection before any database contact", async () => {
  const t = await setup();
  const a = await t.connect();
  const b = await t.connect({ label: "Other" });
  await t.share(a, "observer", "shared");
  await t.share(b, "observer", "shared");
  const first = await t.pull(a, { collection: "public.customers", limit: 1 });
  assert.deepEqual(first.rows.map((r) => r.id), ["public.customers:1"]);
  assert.ok(first.nextCursor);
  t.fake.sent.length = 0;
  assert.equal((await refusal(t.pull(b, { collection: "public.customers", cursor: first.nextCursor }))).code, "cursor_invalid");
  assert.equal((await refusal(t.pull(a, { cursor: first.nextCursor }))).code, "cursor_invalid", "another collection filter");
  assert.deepEqual(t.fake.sent, [], "no statement was sent for a refused cursor");
  const next = await t.pull(a, { collection: "public.customers", limit: 5, cursor: first.nextCursor });
  assert.deepEqual([next.rows.map((r) => r.id), next.exhausted, next.nextCursor], [["public.customers:2", "public.customers:3"], true, null]);
  assert.deepEqual(await refusal(t.pull(a, { collection: "public.nothing" })), { code: "not_found", httpStatus: 404, message: "No such collection on this account." });
});

test("database documents: refusals — agent, unshared, catalog only, Knowledge (through Observer), a superuser role; a table dataset still answers delivery_lease", async () => {
  const t = await setup();
  const id = await t.connect();
  assert.equal((await refusal(t.pull(id, {}, t.ctx.agent))).code, "no_access");
  assert.equal((await refusal(t.pull(id))).code, "not_found");
  await t.share(id, "observer", "available");
  assert.equal((await refusal(t.pull(id))).code, "scope_denied");
  await t.share(id, "observer", "shared");
  const k = (await t.share(id, "knowledge", "shared")) as unknown as { route: string };
  assert.equal(k.route, "via_observer");
  assert.equal((await refusal(t.pull(id, {}, t.ctx.knowledge))).code, "not_found");
  assert.equal((await refusal(t.op("data_pull", { account: id, dataset: "public.customers" }, t.ctx.observer))).code, "delivery_lease");
  // the role check runs at every pull
  t.fake.state.role = { rolsuper: true, rolreplication: false };
  const r = await refusal(t.pull(id));
  assert.deepEqual([r.code, r.httpStatus], ["database_role_too_powerful", 422]);
  assert.ok(!t.fake.sent.some((s) => s.sql === POSTGRES_PULL_SQL.begin && t.fake.sent.indexOf(s) > t.fake.sent.length - 3), "no rows were read after the refusal");
  const outcomes = t.db.prepare("SELECT outcome FROM connect_data_audit WHERE op = 'data_pull'").all().map((x) => String(x.outcome));
  for (const code of ["no_access", "not_found", "scope_denied", "delivery_lease", "database_role_too_powerful"]) assert.ok(outcomes.includes(code), code);
});

test("database documents: the row cap per pull and the CSV text cap", () => {
  assert.ok(DB_PULL_ROW_CAP >= ROWS_PER_DOCUMENT && DB_PULL_ROW_CAP % ROWS_PER_DOCUMENT === 0);
  const wide = Array.from({ length: 200 }, (_v, i) => ({ v: `${i}:${"x".repeat(2000)}` }));
  const csv = toCsv(["v"], wide);
  assert.equal(csv.truncated, true);
  assert.ok(Array.from(csv.text).length <= 262_144);
  assert.ok(csv.rows < 200 && csv.text.split("\n").length === csv.rows + 1, "cut at a whole line");
  const table: DbTable = { dataset: 'odd"schema.t', relation: "table", columns: [{ name: 'a"b', type: "text" }] };
  assert.equal(pageSql(table, []), 'SELECT left(src."a""b"::text, 4097) AS "a""b" FROM "odd""schema"."t" AS src ORDER BY src.ctid LIMIT $1 OFFSET $2');
  assert.equal(pageSql(table, ["a\"b"], 0), 'SELECT left(src."a""b"::text, 4097) AS "a""b" FROM "odd""schema"."t" AS src ORDER BY src."a""b" LIMIT $1');
  assert.equal(pageSql(table, ["a\"b"], 1), 'SELECT left(src."a""b"::text, 4097) AS "a""b" FROM "odd""schema"."t" AS src WHERE src."a""b" > $2 ORDER BY src."a""b" LIMIT $1');
  const two: DbTable = { dataset: "s.t", relation: "table", columns: [{ name: "a", type: "int" }, { name: "b", type: "int" }] };
  assert.match(pageSql(two, ["a", "b"], 2), /WHERE \(src\."a", src\."b"\) > \(\$2, \$3\) ORDER BY src\."a", src\."b" LIMIT \$1$/u);
});

/** pulls a whole scan with `limit`, returns every page */
async function scan(t: Awaited<ReturnType<typeof setup>>, id: string, input: Record<string, unknown> = {}): Promise<DocumentsPage[]> {
  const pages: DocumentsPage[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 60; i += 1) {
    const page: DocumentsPage = await t.pull(id, { limit: 50, ...input, ...(cursor ? { cursor } : {}) });
    pages.push(page);
    if (page.exhausted) {
      assert.equal(page.nextCursor, null, "the end of a scan: exhausted true and nextCursor null");
      return pages;
    }
    assert.ok(page.nextCursor, "a page that is not the last has a cursor");
    cursor = page.nextCursor;
  }
  throw new Error("the scan did not end");
}

test("QA-CONNECT35-5: a table that fails or times out is skipped (counted, named), the pull goes on; the failure text never leaves", async () => {
  const t = await setup();
  const id = await t.connect();
  await t.share(id, "observer", "shared");
  t.fake.state.fail.add("public.notes");
  const pages = await scan(t, id);
  const ids = pages.flatMap((p) => p.rows.map((r) => r.id));
  assert.deepEqual(ids, ["public.customers:1", "public.customers:2", "public.customers:3", "sales.monthly:1"], "the other tables are delivered");
  assert.equal(pages.reduce((n, p) => n + (p.skipped ?? 0), 0), 1);
  assert.deepEqual(pages.flatMap((p) => p.failedCollections ?? []), ["public.notes"]);
  assert.ok(t.fake.sent.some((s) => s.sql === POSTGRES_PULL_SQL.rollbackTo), "inside a savepoint: the transaction stays usable");
  assert.ok(!JSON.stringify(pages).includes("secret.internal"), "the driver text is not forwarded");
  assert.equal(t.db.prepare("SELECT outcome FROM connect_data_audit WHERE op = 'data_pull' ORDER BY id DESC LIMIT 1").get()?.outcome, "ok");
  // a timeout (statement_timeout) is the same
  t.fake.state.failCode = "57014";
  const again = await scan(t, id);
  assert.equal(again.flatMap((p) => p.rows).length, 4);
  // the first table failing does not block the rest either
  t.fake.state.fail.clear();
  t.fake.state.fail.add("public.customers");
  const third = await scan(t, id);
  assert.deepEqual(third.flatMap((p) => p.rows.map((r) => r.id)), ["public.notes:1", "sales.monthly:1"]);
});

test("QA-CONNECT35-6: a page cut by the text cap advances only past the rows it holds; every row is delivered once", async () => {
  const t = await setup({ wide: true });
  const id = await t.connect();
  await t.share(id, "observer", "shared");
  const pages = await scan(t, id, { collection: "public.wide", limit: 5 });
  const docs = pages.flatMap((p) => p.rows);
  assert.ok(docs.length > 1 && docs.every((d) => d.id.startsWith("public.wide:")));
  assert.equal(docs[0]?.truncated, true, "the text cap cut this page");
  assert.ok(docs.at(-1)?.truncated !== true, "the last page holds the rest");
  const ids: string[] = [];
  for (const d of docs) for (const line of d.text.split("\n").slice(1)) ids.push(line.split(",")[0] as string);
  assert.deepEqual(ids, Array.from({ length: 120 }, (_v, i) => String(i + 1)), "no row lost, none twice, in key order");
  assert.deepEqual(docs.map((d) => d.id), docs.map((_d, i) => `public.wide:${i + 1}`));
  // the title names the rows of the document
  assert.match(docs[0]?.title ?? "", /^public\.wide rows 1–\d+$/u);
  assert.match(docs[1]?.title ?? "", new RegExp(`^public\\.wide rows ${docs[0]?.text.split("\n").length as number}–`, "u"));
  // one row that alone passes the cap is cut, and the scan still moves on
  const names = Array.from({ length: 100 }, (_v, i) => `c${i}`);
  const huge = toCsv(names, [Object.fromEntries(names.map((n) => [n, "x".repeat(4000)])), Object.fromEntries(names.map((n) => [n, "y"]))]);
  assert.deepEqual([huge.rows, huge.truncated, Array.from(huge.text).length <= 262_144], [1, true, true]);
});

test("QA-CONNECT35-9: a cursor that would pass 512 characters is stored under a token; a long key still pages; a lost token is cursor_invalid", async () => {
  const t = await setup();
  const id = await t.connect();
  await t.share(id, "observer", "shared");
  const longKey = `${"k".repeat(900)}`;
  // a table cursor with a long key value
  const state = { t: "public.customers", n: 1, o: 200, k: [longKey], s: 1 };
  const { encodeDocCursor } = await import("../src/data/documents.ts");
  const cursor = encodeDocCursor(t.db, id, null, state);
  assert.ok(cursor.length <= 512, `cursor is ${cursor.length} characters`);
  assert.deepEqual({ ...decodeDocCursor(t.db, cursor, id, null), c: undefined }, { ...state, c: undefined });
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM connect_doc_cursors WHERE account_id = ?").get(id)?.n, 1);
  t.db.prepare("DELETE FROM connect_doc_cursors").run();
  assert.throws(() => decodeDocCursor(t.db, cursor, id, null), (e) => (e as { code: string }).code === "cursor_invalid");
  // the stash is cut to the newest 500 per account
  for (let i = 0; i < 520; i += 1) encodeDocCursor(t.db, id, null, { t: "public.customers", k: [`${i}${longKey}`] }, 1000 + i);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM connect_doc_cursors WHERE account_id = ?").get(id)?.n, 500);
});

test("QA-CONNECT35-13: a page or table that is gone since the last full scan is delivered once as deleted:true (new rev, updatedAt not before the last live row)", async () => {
  const t = await setup();
  const id = await t.connect();
  await t.share(id, "observer", "shared");
  const first = await scan(t, id);
  const live = new Map(first.flatMap((p) => p.rows).map((r) => [r.id, r]));
  assert.deepEqual([...live.keys()], ["public.customers:1", "public.customers:2", "public.customers:3", "public.notes:1", "sales.monthly:1"]);
  assert.ok(first.flatMap((p) => p.rows).every((r) => r.deleted === undefined));
  // an unchanged source: a new scan from no cursor delivers the live rows again and no deletion
  const same = await scan(t, id);
  assert.deepEqual(same.flatMap((p) => p.rows.filter((r) => r.deleted)).length, 0);
  // the table shrinks to 150 rows (pages 2 and 3 are gone), notes is dropped
  const sent = t.fake.data["public.customers"] as DbRow[];
  sent.length = 150;
  delete t.fake.data["public.notes"];
  t.fake.data["public.notes"] = [];
  const gone = await scan(t, id);
  const rows = gone.flatMap((p) => p.rows);
  const deleted = rows.filter((r) => r.deleted);
  assert.deepEqual(deleted.map((r) => r.id).sort(), ["public.customers:2", "public.customers:3", "public.notes:1"]);
  for (const d of deleted) {
    const before = live.get(d.id);
    assert.notEqual(d.rev, before?.rev, "a new rev");
    assert.ok(Date.parse(d.updatedAt) >= Date.parse(before?.updatedAt ?? ""), "updatedAt not before the last live row");
    assert.deepEqual([d.text, d.title, d.collection, d.untrusted], ["", "", before?.collection, true]);
  }
  assert.ok(rows.some((r) => r.id === "public.customers:1" && !r.deleted), "the rest of the scan is delivered as live rows");
  // once: the next scan delivers no tombstone again
  const next = await scan(t, id);
  assert.equal(next.flatMap((p) => p.rows).filter((r) => r.deleted).length, 0);
  // a page that comes back takes a NEW rev (not the tombstone's, not the old one)
  sent.push(...Array.from({ length: 300 }, (_v, i) => ({ id: String(151 + i), name: `Customer ${151 + i}`, password_hash: CANARY })));
  const back = (await scan(t, id)).flatMap((p) => p.rows);
  const c2 = back.find((r) => r.id === "public.customers:2");
  assert.ok(c2 && !c2.deleted);
  assert.notEqual(c2.rev, live.get("public.customers:2")?.rev);
  assert.notEqual(c2.rev, deleted.find((d) => d.id === "public.customers:2")?.rev);
  // a filtered scan (one collection) never deletes
  sent.length = 100;
  const filtered = await scan(t, id, { collection: "public.customers" });
  assert.equal(filtered.flatMap((p) => p.rows).filter((r) => r.deleted).length, 0);
  // a table that fails in a scan is not "gone"
  t.fake.state.fail.add("public.customers");
  const failing = (await scan(t, id)).flatMap((p) => p.rows);
  assert.equal(failing.filter((r) => r.deleted).length, 0);
});

test("QA-CONNECT35-4: secret-looking columns — folded, split into words, extended list; ordinary names stay", () => {
  const secret = [
    "password", "Passwort", "passcode", "pass", "pw", "pswd", "contraseña", "motdepasse", "kennwort", "ＰＡＳＳＷＯＲＤ", "pаssword", "auth", "authorization", "bearer", "jwt", "hash",
    "pin", "otp", "cvv", "ssn", "private_key", "privateKey", "auth_key", "license_key", "hmac", "encrypted", "api_key", "apiKey", "PASS_WORD", "sec ret", "s3cret", "credentials",
    "tokens_used", "userPassword", "password_hash", "X-Auth-Token", "session_id", "refreshToken", "salt", "cookie", "secret_question", "Pásswörd",
  ];
  for (const n of secret) assert.equal(isSecretColumn(n), true, n);
  const plain = ["id", "name", "email", "author", "authors", "title", "spin", "passenger", "bypass", "key", "sort_key", "monthly_total", "created_at", "hashtag", "pinned_at"];
  for (const n of plain) assert.equal(isSecretColumn(n), false, n);
});

test("QA-CONNECT35-5: a column name that Connect cleaned maps back to the real one in SQL; the real name is not shown in the catalog", async () => {
  const session: DbSession = {
    async query(sql) {
      if (sql === POSTGRES_SQL.columns)
        return [
          { table_schema: "public", table_name: "t", column_name: "na​me", data_type: "text", table_type: "BASE TABLE" },
          { table_schema: "public", table_name: "t", column_name: "name", data_type: "text", table_type: "BASE TABLE" },
          { table_schema: "public", table_name: "t", column_name: "plain", data_type: "text", table_type: "BASE TABLE" },
        ];
      return [];
    },
    async close() {},
  };
  const [table] = await readCatalog("postgres", session);
  assert.deepEqual(table?.columns.map((c) => c.name), ["name", "plain"], "a duplicate cleaned name is left out");
  assert.equal(table?.columns[0]?.real, "na​me");
  const sql = pageSql(table as DbTable, []);
  assert.ok(sql.includes('left(src."na​me"::text, 4097) AS "name"'), sql);
  // data_catalog does not show the real name
  const t = await setup();
  const id = await t.connect();
  await t.share(id, "observer", "available");
  const cat = (await t.op("data_catalog", { account: id }, t.ctx.observer)) as unknown as { datasets: { columns?: Record<string, unknown>[] }[] };
  assert.ok(cat.datasets.filter((d) => d.columns).every((d) => d.columns?.every((c) => Object.keys(c).sort().join() === "name,type")));
});
