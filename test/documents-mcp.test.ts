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
import { assertDocumentsConform, authorOf, collectionOf, type DocumentsPage, documentText, htmlToMarkdown, safeId, safeUrl } from "../src/data/documents.ts";
import { DataError } from "../src/data/messages.ts";
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

function fakeMcp(options: { pageSize?: number; rateLimitList?: boolean } = {}) {
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
