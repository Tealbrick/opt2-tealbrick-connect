/**
 * C373: the `documents` dataset of an MCP account (contract documents/1, DRAFT). Real handlers, real SQLite; the MCP server
 * is a FAKE (resources/list paged with cursors, resources/read; it records every method, and no tools/call may follow the
 * connect). Every pull answer is re-validated here against the vendored schema in test/contracts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { JsonSchemaObject, Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Json } from "@opt2-tealbrick/spec/sdk";

import { createConnectApp } from "../src/app.ts";
import {
  assertDocumentsConform,
  authorOf,
  buildMcpRow,
  collectionOf,
  DOC_PULL_MAX_READS,
  type DocumentsPage,
  type DocumentsPullInput,
  documentText,
  encodeDocCursor,
  htmlToMarkdown,
  mcpDocumentsCatalog,
  pullMcpDocuments,
  rowProblems,
  safeId,
  safeUrl,
} from "../src/data/documents.ts";
import { DataError } from "../src/data/messages.ts";
import { McpError } from "../src/sources/mcp/client.ts";
import type { McpResourceSession } from "../src/sources/mcp/source.ts";
import { handlerOf, root, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const schema = JSON.parse(readFileSync(join(root, "test", "contracts", "documents.1.schema.json"), "utf8")) as JsonSchemaObject;
const URL_ = "https://mcp.example.com/mcp";
const URL_2 = "https://mcp2.example.com/mcp";
const KNOWLEDGE = "ins_01HZKNWDG00000000000000000";
const OBSERVER = "ins_01HZ0BSRVR0000000000000000";
const AGENT = "agt_01DATAAGENT000000000000000";

type Resource = { uri: string; name?: string; title?: string; mimeType?: string; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> };
type Content = { uri: string; mimeType?: string; text?: string; blob?: string };

/** The mock source's shape (C373): Drive docs with percent-encoded uris, Slack channel-days, a Stripe report, plus odd ones. */
function corpus(): { resources: Resource[]; contents: Map<string, Content[]> } {
  const resources: Resource[] = [
    { uri: "drive://acme/Finance/Q3%20board%20memo.md", name: "Q3 board memo", mimeType: "text/markdown", annotations: { lastModified: "2026-10-20T09:30:00Z" }, _meta: { collection: "Drive: Finance", kind: "document" } },
    { uri: "drive://acme/Finance/Budget%202027.html", name: "Budget 2027", mimeType: "text/html", annotations: { lastModified: "2026-10-21T10:00:00.123Z" }, _meta: { collection: "Drive: Finance", kind: "document" } },
    { uri: "drive://acme/Finance/logo.png", name: "logo", mimeType: "image/png", _meta: { collection: "Drive: Finance" } },
    { uri: "slack://general/2026-10-26", name: "#general 2026-10-26", mimeType: "text/plain", annotations: { lastModified: "2026-10-26T23:59:00Z" }, _meta: { collection: "Slack: #general", kind: "chat_transcript", author: "slack:U01ABCDEF" } },
    { uri: "slack://general/2026-10-27", name: "#general 2026-10-27", mimeType: "text/plain", _meta: { collection: "Slack: #general", kind: "chat_transcript", author: "Jane at Acme" } },
    { uri: "stripe://reports/mrr-2026-09", title: "MRR September", mimeType: "text/csv", _meta: { kind: "report", url: "https://dashboard.stripe.example.com/reports/mrr" } },
    { uri: "notes://inbox/blob-only", name: "blob note", mimeType: "text/plain" },
  ];
  const contents = new Map<string, Content[]>([
    [resources[0]?.uri as string, [{ uri: resources[0]?.uri as string, mimeType: "text/markdown", text: "# Q3\n\nRevenue grew.\u0000 Acme LLC." }]],
    [resources[1]?.uri as string, [{ uri: resources[1]?.uri as string, mimeType: "text/html", text: "<html><head><style>p{}</style></head><body><h1>Budget</h1><p>Total: <b>1&nbsp;200</b> &amp; more</p><ul><li>One</li><li>Two</li></ul><a href=\"https://example.com/x\">link</a><script>alert(1)</script></body></html>" }]],
    [resources[3]?.uri as string, [{ uri: resources[3]?.uri as string, text: "09:00 anna: hello\n09:01 ben: hi" }]],
    [resources[4]?.uri as string, [{ uri: resources[4]?.uri as string, text: "10:00 jane: today" }]],
    [resources[5]?.uri as string, [{ uri: resources[5]?.uri as string, mimeType: "text/csv", text: "month,mrr\n2026-09,12000" }]],
    [resources[6]?.uri as string, [{ uri: resources[6]?.uri as string, mimeType: "text/plain", blob: "aGVsbG8=" }]],
  ]);
  return { resources, contents };
}

function fakeMcp(options: { pageSize?: number; rateLimitList?: boolean; listRpcError?: string } = {}) {
  const methods: string[] = [];
  const data = corpus();
  const pageSize = options.pageSize ?? 3;
  let rateLimit = options.rateLimitList === true;
  const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { id?: number; method?: string; params?: Record<string, unknown> }) : null;
    if (headers.get("authorization") !== "Bearer good") return new Response("no", { status: 401 });
    if (!body || body.id === undefined) return new Response(null, { status: 202 });
    methods.push(String(body.method));
    let result: unknown;
    if (body.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { resources: {} }, serverInfo: { name: "acme-data-sources" } };
    else if (body.method === "tools/list") result = { tools: [{ name: "search_docs", annotations: { readOnlyHint: true } }] };
    else if (body.method === "resources/list") {
      if (options.listRpcError) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: options.listRpcError } }), { headers: { "content-type": "application/json" } });
      if (rateLimit) {
        rateLimit = false;
        return new Response("slow down", { status: 429 });
      }
      const start = Number((body.params?.cursor as string | undefined)?.replace("page-", "") ?? 0);
      const slice = data.resources.slice(start, start + pageSize);
      result = { resources: slice, ...(start + pageSize < data.resources.length ? { nextCursor: `page-${start + pageSize}` } : {}) };
    } else if (body.method === "resources/read") {
      const uri = String(body.params?.uri);
      result = { contents: data.contents.get(uri) ?? [] };
    } else return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no" } }), { headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json", "mcp-session-id": "s1" } });
  }) as typeof fetch;
  return { impl, methods, data };
}

async function setup(options: Parameters<typeof fakeMcp>[0] = {}) {
  const server = fakeMcp(options);
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), fetchImpl: server.impl, catalogAllowOrigins: ["https://mcp.example.com", "https://mcp2.example.com"] });
  const callers = [
    { product: "knowledge", ins: KNOWLEDGE, name: "Knowledge", provider: "railway" },
    { product: "observer", ins: OBSERVER, name: "Observer", provider: "railway" },
  ];
  const person = testCtx({ db, person: true, companionCallers: callers });
  const observer = testCtx({ db, app: OBSERVER, appName: "Observer", appProduct: "observer", appListed: true });
  const knowledge = testCtx({ db, app: KNOWLEDGE, appName: "Knowledge", appProduct: "knowledge", appListed: true });
  const agent = testCtx({ db, agent: AGENT, access: {} });
  const op = (name: string, input: Record<string, unknown>, ctx = person) => handlerOf(app, name)(input as Json, ctx);
  const connect = async (url = URL_, label = "Acme data") => ((await op("mcp_account_connect", { label, url, headers: { Authorization: "Bearer good" } })) as unknown as { account: { id: string } }).account.id;
  const instanceOf: Record<string, string> = { knowledge: KNOWLEDGE, observer: OBSERVER };
  const share = (account: string, product: string, level: string, extra: Record<string, unknown> = {}) =>
    op("account_app_share", { account, product, level, ...(level === "none" ? {} : { instance: instanceOf[product] }), ...extra });
  const pull = async (account: string, input: Record<string, unknown> = {}, ctx = observer): Promise<DocumentsPage & { schema: string; untrusted: boolean }> => {
    const page = (await op("data_pull", { account, dataset: "documents", ...input }, ctx)) as unknown as DocumentsPage & { schema: string; untrusted: boolean };
    assert.deepEqual(validateAgainstSchema(schema, page as unknown as Json), { ok: true }, "every page is valid documents/1");
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 2 * 1024 * 1024);
    return page;
  };
  return { db, app, server, op, connect, share, pull, ctx: { person, observer, knowledge, agent } };
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; httpStatus: number }> {
  try {
    await p;
  } catch (e) {
    const { code, httpStatus } = e as { code: string; httpStatus: number };
    return { code, httpStatus };
  }
  throw new Error("expected a refusal, the call succeeded");
}

async function refusalWithMessage(p: Promise<unknown>): Promise<{ code: string; httpStatus: number; message: string }> {
  try {
    await p;
  } catch (e) {
    const { code, httpStatus, message } = e as { code: string; httpStatus: number; message: string };
    return { code, httpStatus, message };
  }
  throw new Error("expected a refusal, the call succeeded");
}

test("MCP documents: the owner shares an MCP account with Observer; list, catalog and a paged pull of documents/1 rows; never a tool call", async () => {
  const t = await setup();
  const id = await t.connect();
  const shared = (await t.share(id, "observer", "shared")) as unknown as { route: string; shares: { route: string; level: string }[] };
  assert.equal(shared.route, "direct");
  assert.match(t.ctx.person.receipts.summary.at(-1) ?? "", /Sharing of “Acme data” with Observer “Observer”: documents, read only/u);

  const list = (await t.op("data_accounts_list", {}, t.ctx.observer)) as unknown as { accounts: { account: string; kinds: string[]; datasets: string[]; source: string; level: string }[] };
  assert.deepEqual(list.accounts.map((a) => [a.account, a.kinds, a.datasets, a.source, a.level]), [[id, ["documents"], ["documents"], "mcp", "shared"]]);

  const cat = (await t.op("data_catalog", { account: id }, t.ctx.observer)) as unknown as { source: string; datasets: { dataset: string; kind: string; delivery: string; contract: string; approxRows: number; skipped?: number; collections: { id: string; approxRows: number }[] }[] };
  assert.equal(cat.source, "mcp");
  const [documents] = cat.datasets;
  assert.deepEqual([documents?.dataset, documents?.kind, documents?.delivery, documents?.contract, documents?.approxRows, documents?.skipped], ["documents", "documents", "pull", "documents/1", 6, 1]);
  // _meta.collection wins; the Stripe report has none: the uri authority names it
  assert.deepEqual(documents?.collections.map((c) => [c.id, c.approxRows]), [["Drive: Finance", 2], ["Slack: #general", 2], ["inbox", 1], ["reports", 1]]);

  // paged pull: limit 2 over list pages of 3
  const seen: DocumentsPage["rows"] = [];
  let cursor: string | null = null;
  let skipped = 0;
  for (let i = 0; i < 10; i += 1) {
    const page = await t.pull(id, { limit: 2, ...(cursor ? { cursor } : {}) });
    assert.equal(page.schema, "documents/1");
    assert.ok(page.rows.length <= 2);
    seen.push(...page.rows);
    skipped += page.skipped ?? 0;
    if (page.exhausted) {
      assert.equal(page.nextCursor, null);
      break;
    }
    cursor = page.nextCursor;
  }
  assert.deepEqual(seen.map((r) => r.id), ["drive://acme/Finance/Q3%20board%20memo.md", "drive://acme/Finance/Budget%202027.html", "slack://general/2026-10-26", "slack://general/2026-10-27", "stripe://reports/mrr-2026-09"]);
  assert.equal(skipped, 2, "the png (listed as binary) and the blob-only text resource");
  const [memo, budget, day1, day2, report] = seen;
  assert.equal(memo?.text, "# Q3\n\nRevenue grew. Acme LLC.", "NUL removed");
  assert.deepEqual([memo?.collection, memo?.title, memo?.mime, memo?.kind, memo?.updatedAt, memo?.untrusted], ["Drive: Finance", "Q3 board memo", "text/markdown", "document", "2026-10-20T09:30:00.000Z", true]);
  assert.match(memo?.rev ?? "", /^v1-[0-9a-f]{64}$/u);
  // HTML becomes Markdown (documents/1 has no text/html)
  assert.equal(budget?.mime, "text/markdown");
  assert.equal(budget?.text, "# Budget\n\nTotal: **1 200** & more\n\n- One\n- Two\n\n[link](https://example.com/x)");
  assert.equal(budget?.updatedAt, "2026-10-21T10:00:00.123Z");
  // author: canonical when it maps (slack:U01ABCDEF), raw otherwise
  assert.deepEqual(day1?.author, { handle: "slack:U01ABCDEF" });
  assert.deepEqual(day2?.author, { handle: "Jane at Acme", raw: true });
  assert.equal(day1?.kind, "chat_transcript");
  // no lastModified: the time Connect first saw this rev
  assert.match(day2?.updatedAt ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.deepEqual([report?.mime, report?.kind, report?.url, report?.collection], ["text/csv", "report", "https://dashboard.stripe.example.com/reports/mrr", "reports"]);

  // a second scan keeps the rev and the first-seen time of the same text
  const again = await t.pull(id, { collection: "Slack: #general" });
  const day2Again = again.rows.find((r) => r.id === "slack://general/2026-10-27");
  assert.deepEqual([day2Again?.updatedAt, day2Again?.rev], [day2?.updatedAt, day2?.rev]);
  assert.deepEqual(again.rows.map((r) => r.collection), ["Slack: #general", "Slack: #general"]);
  // every change takes a NEW rev, also a change back to an older text
  const uri = "slack://general/2026-10-27";
  const revNow = async () => (await t.pull(id, { collection: "Slack: #general" })).rows.find((r) => r.id === uri)?.rev;
  t.server.data.contents.set(uri, [{ uri, text: "10:00 jane: today (edited)" }]);
  const v2 = await revNow();
  t.server.data.contents.set(uri, [{ uri, text: "10:00 jane: today" }]);
  const v3 = await revNow();
  assert.deepEqual([day2?.rev?.slice(0, 3), v2?.slice(0, 3), v3?.slice(0, 3)], ["v1-", "v2-", "v3-"]);
  assert.notEqual(v3, day2?.rev);

  // read only: after the connect (initialize + tools/list), only resources/* and initialize were sent
  assert.ok(!t.server.methods.includes("tools/call"), "never a tool call");
  assert.ok(t.server.methods.slice(2).every((m) => m === "initialize" || m === "resources/list" || m === "resources/read"), t.server.methods.join(","));

  // the audit line of a served pull
  const line = t.db.prepare("SELECT op, outcome, caller_type, product, account_id, dataset, row_count FROM connect_data_audit WHERE op = 'data_pull' AND outcome = 'ok' ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual({ ...line }, { op: "data_pull", outcome: "ok", caller_type: "app", product: "observer", account_id: id, dataset: "documents", row_count: 2 });
  assert.ok(!JSON.stringify(t.db.prepare("SELECT * FROM connect_data_audit").all()).includes("Revenue grew"), "no text in the audit");
});

test("MCP documents: refusals — agent and person, unshared, catalog-only, Knowledge via Observer, wrong dataset, backward; all audited", async () => {
  const t = await setup();
  const id = await t.connect();
  for (const ctx of [t.ctx.agent, t.ctx.person]) assert.deepEqual(await refusal(t.op("data_pull", { account: id, dataset: "documents" }, ctx)), { code: "no_access", httpStatus: 403 });
  // not shared: the same not_found as an unknown id
  assert.deepEqual(await refusal(t.pull(id)), { code: "not_found", httpStatus: 404 });
  assert.deepEqual(await refusal(t.pull("cna_01UNKNOWN")), { code: "not_found", httpStatus: 404 });
  // catalog only
  await t.share(id, "observer", "available");
  assert.deepEqual(await refusal(t.pull(id)), { code: "scope_denied", httpStatus: 403 });
  await t.share(id, "observer", "shared");
  // Knowledge: through Observer only (C322(6)); direct is refused; the via_observer share gives Knowledge nothing
  assert.equal((await refusal(t.share(id, "knowledge", "shared", { route: "direct" }))).code, "route_invalid");
  const k = (await t.share(id, "knowledge", "shared")) as unknown as { route: string };
  assert.equal(k.route, "via_observer");
  assert.deepEqual(((await t.op("data_accounts_list", {}, t.ctx.knowledge)) as unknown as { accounts: unknown[] }).accounts, []);
  assert.deepEqual(await refusal(t.pull(id, {}, t.ctx.knowledge)), { code: "not_found", httpStatus: 404 });
  assert.deepEqual(await refusal(t.op("data_catalog", { account: id }, t.ctx.knowledge)), { code: "not_found", httpStatus: 404 });
  // an MCP account has no messages; documents has no backward direction
  assert.deepEqual(await refusal(t.op("data_pull", { account: id, dataset: "messages" }, t.ctx.observer)), { code: "not_found", httpStatus: 404 });
  assert.equal((await refusal(t.pull(id, { direction: "backward" }))).code, "direction_unsupported");
  const outcomes = t.db.prepare("SELECT outcome FROM connect_data_audit WHERE op = 'data_pull'").all().map((r) => String(r.outcome));
  for (const code of ["no_access", "not_found", "scope_denied", "direction_unsupported"]) assert.ok(outcomes.includes(code), code);
  // disconnecting removes the shares and the first-seen records
  await t.pull(id);
  assert.ok(Number(t.db.prepare("SELECT COUNT(*) AS n FROM connect_doc_versions").get()?.n) > 0);
  await t.op("account_disconnect", { id });
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM connect_doc_versions").get()?.n, 0);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM connect_account_shares").get()?.n, 0);
});

test("MCP documents: a cursor names its account and collection; it is refused on another account or collection", async () => {
  const t = await setup();
  const a = await t.connect(URL_, "A");
  const b = await t.connect(URL_2, "B");
  await t.share(a, "observer", "shared");
  await t.share(b, "observer", "shared");
  const first = await t.pull(a, { limit: 1 });
  assert.ok(first.nextCursor);
  assert.deepEqual(await refusal(t.pull(b, { cursor: first.nextCursor })), { code: "cursor_invalid", httpStatus: 400 });
  assert.deepEqual(await refusal(t.pull(a, { cursor: first.nextCursor, collection: "Slack: #general" })), { code: "cursor_invalid", httpStatus: 400 });
  assert.deepEqual(await refusal(t.pull(a, { cursor: "bm90IGEgY3Vyc29y" })), { code: "cursor_invalid", httpStatus: 400 });
  // the right account continues
  const next = await t.pull(a, { limit: 1, cursor: first.nextCursor });
  assert.notEqual(next.rows[0]?.id, first.rows[0]?.id);
});

test("MCP documents: a rate-limited list answers an empty page with retryAfterS and the same cursor", async () => {
  const t = await setup({ rateLimitList: true });
  const id = await t.connect();
  await t.share(id, "observer", "shared");
  // the connect does not list resources; the first pull meets the 429
  const page = await t.pull(id);
  assert.deepEqual([page.rows.length, page.nextCursor, page.exhausted, page.retryAfterS], [0, null, false, 30]);
  const after = await t.pull(id);
  assert.ok(after.rows.length > 0);
});

test("documents/1 gate: a page that does not conform is never returned (data_contract_violation 500)", () => {
  const row = { id: "x", collection: "c", title: "t", mime: "text/plain" as const, updatedAt: "2026-10-27T10:00:00Z", rev: "r", text: "hi", untrusted: true as const };
  assert.doesNotThrow(() => assertDocumentsConform({ rows: [row], nextCursor: null, exhausted: true }));
  const bad: DocumentsPage[] = [
    { rows: [{ ...row, mime: "text/html" as never }], nextCursor: null, exhausted: true },
    { rows: [{ ...row, url: "http://insecure.example.com" }], nextCursor: null, exhausted: true },
    { rows: [{ ...row, title: "" }], nextCursor: null, exhausted: true },
    { rows: [{ ...row, deleted: true }], nextCursor: null, exhausted: true },
    { rows: Array.from({ length: 51 }, (_v, i) => ({ ...row, id: `d${i}` })), nextCursor: null, exhausted: true },
    { rows: Array.from({ length: 10 }, (_v, i) => ({ ...row, id: `d${i}`, text: "x".repeat(262_144) })), nextCursor: null, exhausted: true },
  ];
  for (const page of bad) assert.throws(() => assertDocumentsConform(page), (e) => e instanceof DataError && e.code === "data_contract_violation" && e.httpStatus === 500);
  // a deletion: empty text, empty title allowed
  assert.doesNotThrow(() => assertDocumentsConform({ rows: [{ ...row, title: "", text: "", deleted: true }], nextCursor: null, exhausted: true }));
});

test("collection rule, HTML conversion, author and NUL handling", () => {
  const server = "acme-data-sources";
  assert.equal(collectionOf({ uri: "drive://acme/Finance/a.md", _meta: { collection: "Drive: Finance" } }, server), "Drive: Finance");
  assert.equal(collectionOf({ uri: "drive://acme/Finance/a.md", annotations: { collection: "From annotations" } }, server), "From annotations");
  assert.equal(collectionOf({ uri: "drive://acme/Q3%20Plans/a.md" }, server), "Q3 Plans", "the first folder, decoded");
  assert.equal(collectionOf({ uri: "slack://general/2026-10-27" }, server), "general", "no folder: the authority");
  assert.equal(collectionOf({ uri: "file:///docs/a.md" }, server), "docs");
  assert.equal(collectionOf({ uri: "urn:acme:memo" }, server), server, "no hierarchy: the server name");
  assert.equal(htmlToMarkdown("<p>a<br>b</p><table><tr><td>1</td><td>2</td></tr></table><a href='javascript:x'>no</a>"), "a\nb\n\n1 | 2 |\n\nno");
  assert.equal(htmlToMarkdown("<!-- c --><pre>  keep\n  this</pre><i>x</i> &lt;y&gt; &#169; &#x1F600;"), "```\n  keep\n  this\n```\n*x* <y> © 😀");
  // linear on hostile input (no nested backtracking): 200k unclosed tags finish fast
  const started = Date.now();
  htmlToMarkdown("<h1".repeat(200_000));
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(authorOf("telegram:123456789"), { handle: "telegram:123456789" });
  assert.deepEqual(authorOf("Anna\u0007 Smith"), { handle: "Anna Smith", raw: true });
  assert.deepEqual(documentText("a\u0000b", "text/plain"), { text: "ab", mime: "text/plain" });
  // url: https only; no user info, no query, no fragment (a token or a signature may hide there)
  assert.equal(safeUrl("https://docs.example.com/a/b%20c"), "https://docs.example.com/a/b%20c");
  assert.equal(safeUrl("https://docs.example.com/a?X-Amz-Signature=abc&token=t#x"), "https://docs.example.com/a");
  assert.equal(safeUrl("https://user:pw@docs.example.com/a"), null);
  assert.equal(safeUrl("http://docs.example.com/a"), null);
  assert.equal(safeUrl("drive://acme/x"), null);
  // id: an id with credentials (user info or a query) becomes its hash
  assert.equal(safeId("drive://acme/Finance/a.md"), "drive://acme/Finance/a.md");
  assert.match(safeId("https://u:p@x.example.com/a"), /^h:[0-9a-f]{64}$/u);
  assert.match(safeId("s3://bucket/a?X-Amz-Credential=k"), /^h:[0-9a-f]{64}$/u);
});


// ── QA round 1 (C373, PR #35) ──

const memDb = () => testDb();
const NO_WINDOW = { since: null, until: null } as const;
const pullInput = (extra: Partial<DocumentsPullInput> = {}): DocumentsPullInput => ({ cursor: null, collection: null, ...NO_WINDOW, limit: 20, ...extra });
type Listed = { uri: string; mimeType?: string; name?: string; _meta?: Record<string, unknown> };

/** An in-memory MCP session: `pages` of listed resources; `read` decides each read. It counts calls. */
function session(pages: Listed[][], read: (uri: string) => Promise<{ uri: string; text?: string; mimeType?: string }[]> | { uri: string; text?: string }[] = (uri) => [{ uri, text: `text of ${uri}` }]) {
  const calls = { list: 0, read: 0, uris: [] as string[] };
  const impl: McpResourceSession = {
    serverName: "srv",
    async listResources(cursor) {
      calls.list += 1;
      const i = cursor === null ? 0 : Number(cursor.replace(/\D/gu, "").slice(-6));
      const resources = pages[i] ?? [];
      return { resources, nextCursor: i + 1 < pages.length ? `c${i + 1}` : null };
    },
    async readResource(uri) {
      calls.read += 1;
      calls.uris.push(uri);
      return await read(uri);
    },
  };
  return { impl, calls };
}

async function scanAll(db: ReturnType<typeof memDb>, s: McpResourceSession, input: Partial<DocumentsPullInput> = {}, now = () => Date.now(), maxPulls = 300) {
  const pages: DocumentsPage[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxPulls; i += 1) {
    const page: DocumentsPage = await pullMcpDocuments({ db, fallbackName: "srv", now }, s, "acc", pullInput({ ...input, cursor }));
    pages.push(page);
    if (page.exhausted) {
      assert.equal(page.nextCursor, null);
      return pages;
    }
    assert.ok(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("the scan did not end");
}

test("QA-CONNECT35-1: a resource that cannot be read is skipped and counted; the scan goes on (rpc error, too large, 5xx); unauthorized stops; 429 retries", async () => {
  const db = memDb();
  const list = [[{ uri: "x://c/f/1", mimeType: "text/plain" }, { uri: "x://c/f/2", mimeType: "text/plain" }, { uri: "x://c/f/3", mimeType: "text/plain" }, { uri: "x://c/f/4", mimeType: "text/plain" }, { uri: "x://c/f/5", mimeType: "text/plain" }]];
  const logs: unknown[] = [];
  const log = { error: (_m: string, f: unknown) => logs.push(f), warn() {}, info() {}, debug() {} } as never;
  const s = session(list, (uri) => {
    if (uri.endsWith("1")) throw new McpError("mcp_rpc_error", "MCP error -32002: SERVER-TEXT-secret-path");
    if (uri.endsWith("2")) throw new McpError("mcp_response_too_large", "The MCP server response was too large.");
    if (uri.endsWith("3")) throw new McpError("mcp_http_error", "The MCP server answered 500.", 500);
    return [{ uri, text: "ok" }];
  });
  const page = await pullMcpDocuments({ db, fallbackName: "srv", log }, s.impl, "acc", pullInput());
  assert.deepEqual([page.rows.map((r) => r.id), page.skipped, page.exhausted, page.nextCursor], [["x://c/f/4", "x://c/f/5"], 3, true, null]);
  assert.ok(!JSON.stringify(logs).includes("SERVER-TEXT"), "the code is logged, never the server's text");
  assert.ok(logs.some((l) => (l as { code?: string }).code === "mcp_rpc_error"));
  // unauthorized is a whole-server problem: the pull stops with it
  const auth = session(list, () => {
    throw new McpError("mcp_unauthorized", "The MCP server answered 401.", 401);
  });
  await assert.rejects(pullMcpDocuments({ db, fallbackName: "srv" }, auth.impl, "acc", pullInput()), (e) => (e as McpError).code === "mcp_unauthorized");
  // 429/503 on a read: an empty page, the cursor at that resource, retryAfterS
  const slow = session(list, () => {
    throw new McpError("mcp_http_error", "The MCP server answered 429.", 429);
  });
  const wait = await pullMcpDocuments({ db, fallbackName: "srv" }, slow.impl, "acc", pullInput());
  assert.deepEqual([wait.rows.length, wait.exhausted, wait.retryAfterS, typeof wait.nextCursor], [0, false, 30, "string"]);
  // a server that does not answer at all: stop after three, retry later (no walk of the whole list)
  const down = session([Array.from({ length: 50 }, (_v, i) => ({ uri: `x://c/f/${i}`, mimeType: "text/plain" }))], () => {
    throw new McpError("mcp_unreachable", "unreachable");
  });
  const stop = await pullMcpDocuments({ db, fallbackName: "srv" }, down.impl, "acc", pullInput());
  assert.deepEqual([down.calls.read, stop.exhausted, stop.retryAfterS], [3, false, 30]);
});

test("QA-CONNECT35-2: reads per pull are bounded also with zero rows; the window decides before any version record is written", async () => {
  const db = memDb();
  // 20 list pages x 1000 text resources, a window that keeps none: used to be 20000 reads in ONE call
  const pages = Array.from({ length: 20 }, (_v, p) => Array.from({ length: 1000 }, (_w, k) => ({ uri: `x://c/f/${p}-${k}`, mimeType: "text/plain" })));
  const s = session(pages);
  const future = Date.now() + 86_400_000;
  const first = await pullMcpDocuments({ db, fallbackName: "srv" }, s.impl, "acc", pullInput({ since: future }));
  assert.ok(s.calls.read <= DOC_PULL_MAX_READS, `${s.calls.read} reads`);
  assert.deepEqual([first.rows.length, first.exhausted, typeof first.nextCursor], [0, false, "string"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connect_doc_versions").get()?.n, 0, "no version record for a row outside the window");
  // the cursor moves: following it reads everything in bounded pulls
  const readsBefore = s.calls.read;
  const all = await scanAll(db, s.impl, { since: future });
  assert.equal(s.calls.read - readsBefore, 20_000, "every resource is read once in a whole scan");
  assert.ok(all.every((p) => p.rows.length === 0));
  assert.ok(all.length >= 20_000 / DOC_PULL_MAX_READS - 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connect_doc_versions").get()?.n, 0);
  // a listed lastModified outside the window is decided without a read at all
  const dated = session([Array.from({ length: 300 }, (_w, k) => ({ uri: `x://c/g/${k}`, mimeType: "text/plain", _meta: { lastModified: "2020-01-01T00:00:00Z" } }))]);
  const none = await pullMcpDocuments({ db, fallbackName: "srv" }, dated.impl, "acc", pullInput({ since: Date.parse("2026-01-01T00:00:00Z") }));
  assert.deepEqual([dated.calls.read, none.rows.length, none.exhausted], [0, 0, true]);
  // the time budget also applies with no row: a slow server stops the pull, the cursor moves by at least one entry
  let clock = 1_000_000;
  const slowSession = session(
    [Array.from({ length: 50 }, (_w, k) => ({ uri: `x://c/h/${k}`, mimeType: "text/plain" }))],
    (uri) => {
      clock += 8_000;
      return [{ uri, text: "t" }];
    },
  );
  const timed = await pullMcpDocuments({ db: memDb(), fallbackName: "srv", now: () => clock }, slowSession.impl, "acc", pullInput({ since: Date.now() + 1e9 }));
  assert.ok(slowSession.calls.read >= 1 && slowSession.calls.read <= 4, `${slowSession.calls.read} reads`);
  assert.deepEqual([timed.rows.length, timed.exhausted], [0, false]);
});

test("QA-CONNECT35-3: collection, title and path come from the parsed uri: no user info, query or fragment in any member", () => {
  const db = memDb();
  const secrets = ["pw", "abc123", "SECRETFRAG", "tok", "user"];
  const cases: { uri: string; collection: string; title: string; path: string }[] = [
    { uri: "https://user:pw@host.example.com/file.txt", collection: "host.example.com", title: "", path: "" },
    { uri: "https://host.example.com/doc?token=abc123", collection: "host.example.com", title: "", path: "" },
    { uri: "https://host.example.com/a/b.md#SECRETFRAG", collection: "", title: "", path: "" },
    { uri: "https://tok@host.example.com:8443/folder/doc.md", collection: "", title: "", path: "" },
    { uri: "slack://general/2026-10-27", collection: "general", title: "2026-10-27", path: "general/2026-10-27" },
  ];
  for (const c of cases) {
    const { row } = buildMcpRow(db, "acc", "srv", { uri: c.uri, mimeType: "text/plain" }, { uri: c.uri, text: "body" }, "text/plain");
    const members = JSON.stringify({ ...row, text: undefined });
    for (const word of secrets) assert.ok(!members.includes(word), `${c.uri}: "${word}" in ${members}`);
    assert.equal(rowProblems(row), null);
    if (c.collection) assert.equal(row.collection, c.collection, c.uri);
    if (c.title) assert.equal(row.title, c.title, c.uri);
    if (c.path) assert.equal(row.path, c.path, c.uri);
  }
  const withQuery = buildMcpRow(db, "acc", "srv", { uri: "https://host.example.com/doc?token=abc123" }, { uri: "x", text: "b" }, "text/plain").row;
  assert.match(withQuery.title, /^Untitled [0-9a-f]{8}$/u);
  assert.match(withQuery.id, /^h:[0-9a-f]{64}$/u);
  assert.equal(withQuery.collection, "host.example.com");
  // a server title or name is the server's own text and stays
  assert.equal(buildMcpRow(db, "acc", "srv", { uri: "https://u:p@h.example.com/x?t=1", name: "Q3 memo" }, { uri: "x", text: "b" }, "text/plain").row.title, "Q3 memo");
  // an unparseable uri gives no part of itself
  assert.match(buildMcpRow(db, "acc", "srv", { uri: "not a uri?secret=1" }, { uri: "x", text: "b" }, "text/plain").row.title, /^Untitled /u);
  assert.equal(collectionOf({ uri: "https://user:pw@host.example.com/file.txt" }, "srv"), "host.example.com");
});

test("QA-CONNECT35-8: the MCP server's error text never reaches the caller of data_pull or data_catalog", async () => {
  const t = await setup({ listRpcError: "INTERNAL-PATH /srv/secret/keys.db" });
  const id = await t.connect();
  await t.share(id, "observer", "shared");
  for (const call of [t.op("data_pull", { account: id, dataset: "documents" }, t.ctx.observer), t.op("data_catalog", { account: id }, t.ctx.observer)]) {
    const r = await refusalWithMessage(call);
    assert.equal(r.code, "mcp_rpc_error");
    assert.ok(!r.message.includes("INTERNAL-PATH"), r.message);
    assert.equal(r.message, "The MCP server could not answer the request.");
  }
});

test("QA-CONNECT35-9: a long list cursor of the server fits (stored under a token); the scan never gets stuck", async () => {
  const db = memDb();
  const longCursor = (i: number) => `${"L".repeat(3000)}${String(i).padStart(6, "0")}`;
  const pages = Array.from({ length: 4 }, (_v, p) => [{ uri: `x://c/f/${p}a`, mimeType: "text/plain" }, { uri: `x://c/f/${p}b`, mimeType: "text/plain" }]);
  const impl: McpResourceSession = {
    serverName: "srv",
    async listResources(cursor) {
      const i = cursor === null ? 0 : Number(cursor.slice(-6));
      return { resources: pages[i] ?? [], nextCursor: i + 1 < pages.length ? longCursor(i + 1) : null };
    },
    async readResource(uri) {
      return [{ uri, text: uri }];
    },
  };
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i += 1) {
    const page: DocumentsPage = await pullMcpDocuments({ db, fallbackName: "srv" }, impl, "acc", pullInput({ limit: 1, cursor }));
    if (cursor) assert.ok(cursor.length <= 512, `${cursor.length}`);
    seen.push(...page.rows.map((r) => r.id));
    if (page.exhausted) break;
    cursor = page.nextCursor;
  }
  assert.deepEqual(seen, pages.flat().map((r) => r.uri));
  assert.ok(Number(db.prepare("SELECT COUNT(*) AS n FROM connect_doc_cursors").get()?.n) > 0);
  // a cursor of another collection or account is still refused, also when stored
  const stored = encodeDocCursor(db, "acc", null, { m: longCursor(1), o: 0, p: 1 });
  await assert.rejects(pullMcpDocuments({ db, fallbackName: "srv" }, impl, "other", pullInput({ cursor: stored })), (e) => (e as DataError).code === "cursor_invalid");
  await assert.rejects(pullMcpDocuments({ db, fallbackName: "srv" }, impl, "acc", pullInput({ cursor: stored, collection: "x" })), (e) => (e as DataError).code === "cursor_invalid");
  // a list cursor beyond 8 KiB is refused with a fixed message
  const huge: McpResourceSession = { ...impl, async listResources() { return { resources: [], nextCursor: "H".repeat(9000) }; } };
  await assert.rejects(pullMcpDocuments({ db, fallbackName: "srv" }, huge, "acc", pullInput()), (e) => (e as DataError).code === "source_cursor_too_long");
});

test("QA-CONNECT35-10: a server whose list never ends ends the scan at the cap (partial); the catalog has an overall time bound", async () => {
  const db = memDb();
  let n = 0;
  const forever: McpResourceSession = {
    serverName: "srv",
    async listResources() {
      n += 1;
      return { resources: [], nextCursor: `next-${n}` };
    },
    async readResource(uri) {
      return [{ uri, text: "t" }];
    },
  };
  const pages = await scanAll(db, forever, {}, undefined, 100);
  const last = pages.at(-1);
  assert.deepEqual([last?.exhausted, last?.partial, last?.nextCursor], [true, true, null]);
  assert.ok(n >= 1000 && n <= 1000 + 20, `${n} list calls`);
  // the catalog: a clock that jumps stops it
  let clock = 0;
  let calls = 0;
  const slowList: McpResourceSession = {
    serverName: "srv",
    async listResources() {
      calls += 1;
      clock += 20_000;
      return { resources: [{ uri: `x://c/${calls}`, mimeType: "text/plain" }], nextCursor: `n${calls}` };
    },
    async readResource(uri) {
      return [{ uri }];
    },
  };
  const cat = await mcpDocumentsCatalog(slowList, "srv", () => clock);
  assert.deepEqual([cat.partial, calls <= 3], [true, true]);
});

test("QA-CONNECT35-12: htmlToMarkdown — svg, an unclosed template or head or noscript do not drop the rest of the page", () => {
  assert.equal(htmlToMarkdown("<p>a</p><svg/><p>after svg</p>"), "a\n\nafter svg");
  assert.equal(htmlToMarkdown("<p>a</p><svg width=1 />after"), "a\n\nafter");
  assert.equal(htmlToMarkdown("<p>a</p><template><p>x</p><p>after</p>"), "a\n\nx\n\nafter");
  assert.equal(htmlToMarkdown("<noscript><p>after</p>"), "after");
  assert.equal(htmlToMarkdown("<head><title>t</title><body><p>after</p></body>"), "after", "<body> ends an open head");
  assert.equal(htmlToMarkdown("<p>a</p><svg><path d='x'/><text>drawn</text></svg><p>b</p>"), "a\n\nb", "a closed svg is hidden");
  assert.equal(htmlToMarkdown("<p>a</p><script>var x = 1;</p><p>never</p>"), "a", "an unclosed script hides the rest, as a browser reads it");
  assert.equal(htmlToMarkdown("<p>a</p></template><p>b</p>"), "a\n\nb", "a stray closing tag hides nothing");
  assert.equal(htmlToMarkdown("<style>p{}</style><p>x</p><style>q{}</style>y"), "x\n\ny");
});

test("QA-CONNECT35-13: a document that is gone since the last full scan is delivered once as deleted:true; the scan end is exhausted with no cursor", async () => {
  const db = memDb();
  let clock = 1_800_000_000_000;
  const now = () => (clock += 1000);
  const docs = new Map<string, string>([["x://c/a", "A"], ["x://c/b", "B"], ["x://c/d", "D"]]);
  const hidden = new Set<string>(); // listed no more, but still readable (a list that moved)
  const s = session([[]], (uri) => (docs.has(uri) ? [{ uri, text: docs.get(uri) ?? "" }] : (() => { throw new McpError("mcp_rpc_error", "MCP error -32002: Resource not found"); })()));
  const impl: McpResourceSession = {
    ...s.impl,
    async listResources() {
      return { resources: [...docs.keys()].filter((u) => !hidden.has(u)).map((uri) => ({ uri, mimeType: "text/plain" })), nextCursor: null };
    },
  };
  const live = (pages: DocumentsPage[]) => pages.flatMap((p) => p.rows);
  const first = live(await scanAll(db, impl, {}, now));
  assert.deepEqual(first.map((r) => r.id), ["x://c/a", "x://c/b", "x://c/d"]);
  // nothing changed: no deletion row, no more calls than needed
  assert.equal(live(await scanAll(db, impl, {}, now)).filter((r) => r.deleted).length, 0);
  // b is removed at the source
  docs.delete("x://c/b");
  const second = await scanAll(db, impl, {}, now);
  const rows = live(second);
  assert.deepEqual(rows.map((r) => [r.id, r.deleted === true]), [["x://c/a", false], ["x://c/d", false], ["x://c/b", true]]);
  const gone = rows.find((r) => r.deleted);
  const before = first.find((r) => r.id === "x://c/b");
  assert.ok(gone && before);
  assert.notEqual(gone.rev, before.rev);
  assert.ok(Date.parse(gone.updatedAt) >= Date.parse(before.updatedAt));
  assert.deepEqual([gone.text, gone.title, gone.collection, gone.untrusted, rowProblems(gone)], ["", "", before.collection, true, null]);
  assert.deepEqual([second.at(-1)?.exhausted, second.at(-1)?.nextCursor], [true, null], "a full scan ends with exhausted:true and no cursor");
  // once only
  assert.equal(live(await scanAll(db, impl, {}, now)).filter((r) => r.deleted).length, 0);
  // it comes back: a live row with a NEW rev
  docs.set("x://c/b", "B");
  const back = live(await scanAll(db, impl, {}, now)).find((r) => r.id === "x://c/b");
  assert.ok(back && !back.deleted);
  assert.notEqual(back.rev, before.rev);
  assert.notEqual(back.rev, gone.rev);
  // a list that moved (d is not listed this time but is still readable): no deletion
  hidden.add("x://c/d");
  assert.equal(live(await scanAll(db, impl, {}, now)).filter((r) => r.deleted).length, 0, "a document that can still be read is not deleted");
  hidden.clear();
  // access revoked (the read answers not found) and not listed: deleted
  const revoked = new Set(["x://c/a"]);
  const impl2: McpResourceSession = {
    ...impl,
    async listResources() {
      return { resources: [...docs.keys()].filter((u) => !revoked.has(u)).map((uri) => ({ uri, mimeType: "text/plain" })), nextCursor: null };
    },
    async readResource(uri) {
      if (revoked.has(uri)) throw new McpError("mcp_rpc_error", "MCP error -32002: gone");
      return [{ uri, text: docs.get(uri) ?? "" }];
    },
  };
  assert.deepEqual(live(await scanAll(db, impl2, {}, now)).filter((r) => r.deleted).map((r) => r.id), ["x://c/a"]);
  // a filtered scan or one with `until` deletes nothing
  docs.delete("x://c/d");
  assert.equal(live(await scanAll(db, impl, { collection: "c" }, now)).filter((r) => r.deleted).length, 0);
  assert.equal(live(await scanAll(db, impl, { until: Date.now() + 1e12 }, now)).filter((r) => r.deleted).length, 0);
  assert.deepEqual(live(await scanAll(db, impl, {}, now)).filter((r) => r.deleted).map((r) => r.id), ["x://c/d"]);
  // a tombstone is dropped after 30 days
  clock += 31 * 24 * 3600 * 1000;
  await scanAll(db, impl, {}, now);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connect_doc_versions WHERE deleted = 1").get()?.n, 0);
});

test("QA-CONNECT35-13: a cut scan (a list that repeats a cursor) deletes nothing", async () => {
  const db = memDb();
  const mk = (loop: boolean): McpResourceSession => ({
    serverName: "srv",
    async listResources(cursor) {
      if (loop && cursor === null) return { resources: [{ uri: "x://c/a", mimeType: "text/plain" }], nextCursor: "same" };
      if (loop) return { resources: [], nextCursor: "same" };
      return { resources: [{ uri: "x://c/a", mimeType: "text/plain" }, { uri: "x://c/b", mimeType: "text/plain" }], nextCursor: null };
    },
    async readResource(uri) {
      return [{ uri, text: uri }];
    },
  });
  await scanAll(db, mk(false));
  const cut = await scanAll(db, mk(true));
  assert.equal(cut.flatMap((p) => p.rows).filter((r) => r.deleted).length, 0);
  assert.equal(cut.at(-1)?.partial, true);
});


test("QA delta D1: a 429 during the deletion re-read keeps the tombstones made so far and tombstones nothing else", async () => {
  const db = memDb();
  const docs = Array.from({ length: 10 }, (_v, k) => `x://c/f${k}`);
  let list: string[] = docs;
  let mode: "ok" | "gone3-then-429" | "ok-after" = "ok";
  let probes = 0;
  const impl: McpResourceSession = {
    serverName: "srv",
    async listResources() {
      return { resources: list.map((uri) => ({ uri, mimeType: "text/plain" })), nextCursor: null };
    },
    async readResource(uri) {
      if (mode === "gone3-then-429" && uri !== docs[9]) {
        probes += 1;
        if (probes <= 3) throw new McpError("mcp_rpc_error", "MCP error -32002: not found");
        throw new McpError("mcp_http_error", "The MCP server answered 429.", 429);
      }
      if (mode === "ok-after") throw new McpError("mcp_rpc_error", "MCP error -32002: not found");
      return [{ uri, text: uri }];
    },
  };
  await scanAll(db, impl);
  list = [docs[9] as string];
  mode = "gone3-then-429";
  const page = await pullMcpDocuments({ db, fallbackName: "srv" }, impl, "acc", pullInput());
  assert.deepEqual([page.rows.filter((r) => r.deleted).length, page.rows.length, page.retryAfterS, page.exhausted], [3, 4, 30, false]);
  assert.ok(page.nextCursor);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connect_doc_versions WHERE deleted = 1").get()?.n, 3, "only the rows that were returned are tombstoned");
  // the next pull continues; the rest is deleted then, and nothing is delivered twice
  mode = "ok-after";
  const rest = await pullMcpDocuments({ db, fallbackName: "srv" }, impl, "acc", pullInput({ cursor: page.nextCursor }));
  const ids = [...page.rows, ...rest.rows].filter((r) => r.deleted).map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.sort(), docs.slice(0, 9).sort());
  assert.deepEqual([rest.exhausted, rest.nextCursor], [true, null]);
});

test("QA delta D2: the deletion phase has the same read and time budget as the scan, also with zero rows, and resumes by cursor", async () => {
  const db = memDb();
  const docs = Array.from({ length: 300 }, (_v, k) => `x://c/f${String(k).padStart(3, "0")}`);
  let list: string[] = docs;
  let reads = 0;
  const impl: McpResourceSession = {
    serverName: "srv",
    async listResources() {
      return { resources: list.map((uri) => ({ uri, mimeType: "text/plain" })), nextCursor: null };
    },
    async readResource(uri) {
      reads += 1;
      return [{ uri, text: uri }];
    },
  };
  await scanAll(db, impl);
  // the list is empty now and every document can still be read: nothing is deleted, and no pull reads more than the budget
  list = [];
  reads = 0;
  let cursor: string | null = null;
  let pulls = 0;
  for (; pulls < 20; pulls += 1) {
    const before = reads;
    const page: DocumentsPage = await pullMcpDocuments({ db, fallbackName: "srv" }, impl, "acc", pullInput({ cursor, limit: 20 }));
    assert.ok(reads - before <= DOC_PULL_MAX_READS, `${reads - before} reads in one pull`);
    assert.equal(page.rows.length, 0);
    if (page.exhausted) break;
    cursor = page.nextCursor;
  }
  assert.equal(reads, 300);
  assert.equal(pulls + 1, 3, "300 re-reads in 3 pulls of 100");
  // the time budget: a slow server stops a deletion pull after the first read
  let clock = 5_000_000;
  const slow: McpResourceSession = { ...impl, async readResource(uri) { clock += 25_000; return [{ uri, text: uri }]; } };
  const timed = await pullMcpDocuments({ db, fallbackName: "srv", now: () => clock }, slow, "acc", pullInput());
  assert.ok(!timed.exhausted && timed.nextCursor);
});

test("QA delta D3: an id that cannot be read again (a hash) is not deleted by a list that is empty", async () => {
  const db = memDb();
  const secretUri = "https://u:p@host.example.com/a?x=1";
  let list = [{ uri: secretUri, mimeType: "text/plain" }, { uri: "x://c/other", mimeType: "text/plain" }];
  const impl: McpResourceSession = {
    serverName: "srv",
    async listResources() {
      return { resources: list, nextCursor: null };
    },
    async readResource(uri) {
      return [{ uri, text: uri }];
    },
  };
  const first = (await scanAll(db, impl)).flatMap((p) => p.rows);
  const hashed = first.find((r) => r.id.startsWith("h:"));
  assert.ok(hashed);
  // an empty list (a failing server that answers ok) deletes nothing
  list = [];
  assert.equal((await scanAll(db, impl)).flatMap((p) => p.rows).filter((r) => r.deleted).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connect_doc_versions WHERE deleted = 1").get()?.n, 0);
  // a list with at least one resource that no longer has the hashed document deletes it
  list = [{ uri: "x://c/other", mimeType: "text/plain" }];
  const del = (await scanAll(db, impl)).flatMap((p) => p.rows).filter((r) => r.deleted);
  assert.deepEqual(del.map((r) => r.id), [hashed.id]);
});
