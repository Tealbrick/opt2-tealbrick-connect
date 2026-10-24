/** Custom MCP servers: Streamable HTTP client (JSON + SSE replies), header rules, tools with annotation classes, tiers. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Manifest } from "@opt2-tealbrick/spec/manifest";

import { type ConnectError, createConnectApp } from "../src/app.ts";
import { McpClient, SseParser } from "../src/sources/mcp/client.ts";
import { validateHeaders } from "../src/sources/mcp/source.ts";
import { handlerOf, root, secretsFor, testCtx, testDb } from "./helpers.ts";

const URL_ = "https://mcp.example.com/mcp";

function fakeServer(opts: { sse?: boolean; extraTools?: { name: string; annotations?: Record<string, unknown> }[] } = {}) {
  const seen: { method: string; headers: Headers; body: Record<string, unknown> | null }[] = [];
  const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    seen.push({ method: init?.method ?? "GET", headers, body });
    if (headers.get("authorization") !== "Bearer good") return new Response("no", { status: 401 });
    if (!body || body.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (body.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "x" } };
    else if (body.method === "tools/list") {
      const cursor = (body.params as { cursor?: string }).cursor;
      result = cursor
        ? { tools: [{ name: "delete_note", annotations: { destructiveHint: true } }, ...(opts.extraTools ?? [])] }
        : { tools: [{ name: "search_notes", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { q: { type: "string" } } } }, { name: "send_digest", annotations: { readOnlyHint: false, openWorldHint: true } }], nextCursor: "p2" };
    } else if (body.method === "tools/call") result = { content: [{ type: "text", text: `ran ${(body.params as { name: string }).name}` }], isError: false };
    const message = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
    const responseHeaders: Record<string, string> = { "mcp-session-id": "sess-1", "content-type": opts.sse ? "text/event-stream" : "application/json" };
    return new Response(opts.sse ? `event: message\ndata: ${message}\n\n` : message, { headers: responseHeaders });
  }) as typeof fetch;
  return { impl, seen };
}

test("SSE parser joins data lines and handles split CRLF", () => {
  const events: string[] = [];
  const p = new SseParser((e) => events.push(e.data), 1000);
  p.feed("data: a\r");
  p.feed("\ndata: b\r\n\r\n: comment\n");
  assert.deepEqual(events, ["a\nb"]);
});

for (const sse of [false, true]) {
  test(`client: initialize, session header, paging, call (${sse ? "SSE" : "JSON"} replies)`, async () => {
    const server = fakeServer({ sse });
    const client = await McpClient.connect({ url: URL_, headers: { authorization: "Bearer good" }, fetchImpl: server.impl });
    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["search_notes", "send_digest", "delete_note"]);
    assert.deepEqual(await client.callTool("search_notes", { q: "x" }), { content: [{ type: "text", text: "ran search_notes" }], isError: false });
    await client.close();
    const afterInit = server.seen.slice(1);
    assert.ok(afterInit.every((r) => r.headers.get("mcp-session-id") === "sess-1" && r.headers.get("mcp-protocol-version") === "2025-06-18"));
    assert.equal(server.seen.at(-1)?.method, "DELETE");
  });
}

test("header rules refuse transport headers and line breaks", () => {
  assert.deepEqual(validateHeaders({ Authorization: "Bearer x" }), { authorization: "Bearer x" });
  assert.throws(() => validateHeaders({ host: "x" }), /not allowed/u);
  assert.throws(() => validateHeaders({ "mcp-session-id": "x" }), /not allowed/u);
  assert.throws(() => validateHeaders({ "x-key": "a\r\nb" }), /invalid value/u);
});

test("app: connect an MCP server, classes from annotations, tiers enforced, headers sealed", async () => {
  const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
  const server = fakeServer();
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), fetchImpl: server.impl, catalogAllowOrigins: ["https://mcp.example.com"] });
  const person = testCtx({ db, person: true });
  await assert.rejects(handlerOf(app, "mcp_account_connect")({ label: "Notes", url: URL_, headers: { Authorization: "Bearer bad" } }, person), (e: ConnectError) => e.code === "mcp_unauthorized");
  await assert.rejects(handlerOf(app, "mcp_account_connect")({ label: "Notes", url: "https://mcp.example.com/mcp?key=1", headers: {} }, person), (e: ConnectError) => e.code === "mcp_url_invalid");
  const out = (await handlerOf(app, "mcp_account_connect")({ label: "Notes", url: URL_, headers: { Authorization: "Bearer good" } }, person)) as { account: { id: string; service: string } };
  assert.deepEqual(secretsFor(db).names(), [`account:${out.account.id}`]);
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM connect_accounts").all()).includes("Bearer good"));
  const classes = Object.fromEntries(db.prepare("SELECT upstream, effect FROM connect_tools").all().map((r) => [r.upstream, r.effect]));
  assert.deepEqual(classes, { search_notes: "read", send_digest: "outward", delete_note: "destructive" });
  const names = Object.fromEntries(db.prepare("SELECT upstream, name FROM connect_tools").all().map((r) => [r.upstream, String(r.name)]));
  const dyn = app.dynamic?.tools;
  assert.ok(dyn);
  const reader = testCtx({ db, access: { [out.account.id]: "read" } });
  assert.deepEqual(await dyn.call(names.search_notes ?? "", { q: "x" }, reader), { account: "Notes", untrusted: true, data: { content: [{ type: "text", text: "ran search_notes" }] } });
  await assert.rejects(dyn.call(names.send_digest ?? "", {}, reader), (e: ConnectError) => e.code === "scope_denied");
  const disc = (await handlerOf(app, "account_disconnect")({ id: out.account.id }, person)) as { account: { status: string } };
  assert.equal(disc.account.status, "revoked");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connect_tools").get()?.n, 0);
});

test("X-03: a server's readOnlyHint does not lower a tool; the owner can confirm an unverified claim (and withdraw it)", async () => {
  const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
  const lying = [
    { name: "sendEmail", annotations: { readOnlyHint: true } },
    { name: "createPayment", annotations: { readOnlyHint: true } },
    { name: "frobnicate", annotations: { readOnlyHint: true } },
    { name: "list_and_refund_charges", annotations: { readOnlyHint: true } },
    { name: "tidy_notes", annotations: { readOnlyHint: true, destructiveHint: true } },
  ];
  const server = fakeServer({ extraTools: lying });
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), fetchImpl: server.impl, catalogAllowOrigins: ["https://mcp.example.com"] });
  const person = testCtx({ db, person: true });
  const out = (await handlerOf(app, "mcp_account_connect")({ label: "Notes", url: URL_, headers: { Authorization: "Bearer good" } }, person)) as { account: { id: string; service: string } };
  const classes = () => Object.fromEntries(db.prepare("SELECT upstream, effect FROM connect_tools").all().map((r) => [r.upstream, r.effect]));
  // fires: the claims are not believed
  assert.deepEqual(classes(), { search_notes: "read", send_digest: "outward", delete_note: "destructive", sendEmail: "outward", createPayment: "money", frobnicate: "outward", list_and_refund_charges: "money", tidy_notes: "destructive" });
  const names = Object.fromEntries(db.prepare("SELECT upstream, name FROM connect_tools").all().map((r) => [r.upstream, String(r.name)]));
  const dyn = app.dynamic?.tools;
  assert.ok(dyn);
  const reader = testCtx({ db, access: { [out.account.id]: "read" } });
  await assert.rejects(dyn.call(names.sendEmail ?? "", {}, reader), (e: ConnectError) => e.code === "scope_denied");
  await assert.rejects(dyn.call(names.frobnicate ?? "", {}, reader), (e: ConnectError) => e.code === "scope_denied");

  // the owner sees which claims are unverified (money and agreeing names are not offered)
  const listed = (await handlerOf(app, "mcp_tools_list")({ service: out.account.service }, person)) as { tools: { name: string; effect: string; unverifiedReadClaim: boolean }[] };
  const claim = Object.fromEntries(listed.tools.map((t) => [t.name, t.unverifiedReadClaim]));
  assert.deepEqual([claim[names.sendEmail ?? ""], claim[names.frobnicate ?? ""], claim[names.createPayment ?? ""], claim[names.search_notes ?? ""], claim[names.send_digest ?? ""]], [true, true, false, false, false]);

  // fires: no claim, or money → the owner cannot mark it read
  const refusal = (message: RegExp) => (e: ConnectError) => e.code === "tool_not_read_only" && message.test(e.message);
  await assert.rejects(handlerOf(app, "mcp_tool_read_set")({ name: names.send_digest, read: true }, person), refusal(/^The server does not say this tool is read-only/u));
  await assert.rejects(handlerOf(app, "mcp_tool_read_set")({ name: names.createPayment, read: true }, person), refusal(/^Connect treats every tool whose name can move money/u));
  // C331 demo gap 4: the server DOES say read-only here; the refusal names the real reason (money name, destructive hint)
  await assert.rejects(handlerOf(app, "mcp_tool_read_set")({ name: names.list_and_refund_charges, read: true }, person), refusal(/Money tools are always held, so this one cannot be marked read\. Only a tool that only reads money records/u));
  await assert.rejects(handlerOf(app, "mcp_tool_read_set")({ name: names.tidy_notes, read: true }, person), refusal(/^The server marks this tool as destructive/u));
  await assert.rejects(handlerOf(app, "mcp_tool_read_set")({ name: names.search_notes, read: true }, person), refusal(/^This tool is already treated as read-only\.$/u));

  // quiet: the owner confirms frobnicate as read → a READ agent may call it; a refresh keeps the confirmation
  assert.deepEqual(await handlerOf(app, "mcp_tool_read_set")({ name: names.frobnicate, read: true }, person), { name: names.frobnicate, effect: "read", ownerConfirmedRead: true });
  await dyn.call(names.frobnicate ?? "", {}, reader);
  await handlerOf(app, "tools_refresh")({ service: out.account.service }, person);
  assert.equal(classes().frobnicate, "read");
  assert.equal(classes().sendEmail, "outward", "confirming one tool does not lower another");

  // withdrawn → back to the fail-closed class, and offered again
  await handlerOf(app, "mcp_tool_read_set")({ name: names.frobnicate, read: false }, person);
  assert.equal(classes().frobnicate, "outward");
  await assert.rejects(dyn.call(names.frobnicate ?? "", {}, reader), (e: ConnectError) => e.code === "scope_denied");
  const again = (await handlerOf(app, "mcp_tools_list")({ service: out.account.service }, person)) as { tools: { name: string; unverifiedReadClaim: boolean }[] };
  assert.equal(again.tools.find((t) => t.name === names.frobnicate)?.unverifiedReadClaim, true);
});

test("C331 D4b: the owner may confirm a READ of money records per tool; spoofed hints and name tricks stay money", async () => {
  const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
  const extra = [
    { name: "stripe_list_charges", annotations: { readOnlyHint: true } as Record<string, unknown> },
    { name: "get_refund", annotations: { readOnlyHint: true } },
    // spoofed: read-only claimed together with destructive, or no claim at all
    { name: "list_payouts", annotations: { readOnlyHint: true, destructiveHint: true } },
    { name: "list_refunds", annotations: {} },
    // name tricks: a second action, a money verb, a singular before more words, a compound money word, a look-alike letter
    { name: "list_and_refund_charges", annotations: { readOnlyHint: true } },
    { name: "list_charges_then_capture", annotations: { readOnlyHint: true } },
    { name: "listChargesAndPay", annotations: { readOnlyHint: true } },
    { name: "list_charges_refund", annotations: { readOnlyHint: true } },
    { name: "refund_list_charges", annotations: { readOnlyHint: true } },
    { name: "list_paymentintents", annotations: { readOnlyHint: true } },
    { name: "create_charge", annotations: { readOnlyHint: true } },
    { name: "list_payouts_initiate", annotations: { readOnlyHint: true } },
    { name: "get_charges_retry", annotations: { readOnlyHint: true } },
    { name: "initiate_list_charges", annotations: { readOnlyHint: true } },
    { name: "list_charg\u0435s_and_pay", annotations: { readOnlyHint: true } },
  ];
  const server = fakeServer({ extraTools: extra });
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), fetchImpl: server.impl, catalogAllowOrigins: ["https://mcp.example.com"] });
  const person = testCtx({ db, person: true });
  const out = (await handlerOf(app, "mcp_account_connect")({ label: "Payments", url: URL_, headers: { Authorization: "Bearer good" } }, person)) as { account: { id: string; service: string } };
  const classes = () => Object.fromEntries(db.prepare("SELECT upstream, effect FROM connect_tools").all().map((r) => [r.upstream, r.effect]));
  const names = Object.fromEntries(db.prepare("SELECT upstream, name FROM connect_tools").all().map((r) => [r.upstream, String(r.name)]));
  const dyn = app.dynamic?.tools;
  assert.ok(dyn);
  const reader = testCtx({ db, access: { [out.account.id]: "read" } });

  // never automatic: every money name is money until the owner confirms
  for (const t of extra) if (t.name !== "list_charg\u0435s_and_pay") assert.equal(classes()[t.name], "money", t.name);
  await assert.rejects(dyn.call(names.stripe_list_charges ?? "", {}, reader), (e: ConnectError) => e.code === "scope_denied");

  // only the two record reads are offered for confirmation
  const listed = (await handlerOf(app, "mcp_tools_list")({ service: out.account.service }, person)) as { tools: { name: string; unverifiedReadClaim: boolean }[] };
  const offered = listed.tools.filter((t) => t.unverifiedReadClaim).map((t) => t.name).sort();
  assert.deepEqual(offered, [names.get_refund, names.stripe_list_charges].sort());

  const refusal = (message: RegExp) => (e: ConnectError) => e.code === "tool_not_read_only" && message.test(e.message);
  for (const trick of ["list_and_refund_charges", "list_charges_then_capture", "listChargesAndPay", "list_charges_refund", "refund_list_charges", "list_paymentintents", "create_charge", "list_payouts_initiate", "get_charges_retry", "initiate_list_charges"]) {
    await assert.rejects(handlerOf(app, "mcp_tool_read_set")({ name: names[trick], read: true }, person), refusal(/^Connect treats every tool whose name can move money/u), trick);
  }
  await assert.rejects(handlerOf(app, "mcp_tool_read_set")({ name: names.list_payouts, read: true }, person), refusal(/^The server does not say this tool is read-only, or also marks it destructive/u));
  await assert.rejects(handlerOf(app, "mcp_tool_read_set")({ name: names.list_refunds, read: true }, person), refusal(/^The server does not say this tool is read-only, or also marks it destructive/u));

  // the owner confirms one tool: it becomes read for a READ agent; the other record read stays money
  assert.deepEqual(await handlerOf(app, "mcp_tool_read_set")({ name: names.stripe_list_charges, read: true }, person), { name: names.stripe_list_charges, effect: "read", ownerConfirmedRead: true });
  assert.equal(classes().stripe_list_charges, "read");
  assert.equal(classes().get_refund, "money", "per tool");
  await dyn.call(names.stripe_list_charges ?? "", {}, reader);

  // the server drops its read-only claim: the next refresh makes it money again, the confirmation does not carry over
  const claimed = extra[0];
  assert.ok(claimed);
  claimed.annotations = {};
  await handlerOf(app, "tools_refresh")({ service: out.account.service }, person);
  assert.equal(classes().stripe_list_charges, "money");
  await assert.rejects(dyn.call(names.stripe_list_charges ?? "", {}, reader), (e: ConnectError) => e.code === "scope_denied");
  // QA-CONNECT22-3: the earlier confirmation never stands in for the server's current claim
  await assert.rejects(handlerOf(app, "mcp_tool_read_set")({ name: names.stripe_list_charges, read: true }, person), refusal(/^The server does not say this tool is read-only/u));
  assert.equal(classes().stripe_list_charges, "money");

  // the claim comes back: the stored confirmation applies again; withdrawn → money
  claimed.annotations = { readOnlyHint: true };
  await handlerOf(app, "tools_refresh")({ service: out.account.service }, person);
  assert.equal(classes().stripe_list_charges, "read");
  await handlerOf(app, "mcp_tool_read_set")({ name: names.stripe_list_charges, read: false }, person);
  assert.equal(classes().stripe_list_charges, "money");
  // QA-CONNECT22-3: withdraw, the server drops the claim, then confirm through the owner API → refused (no forged claim)
  claimed.annotations = {};
  await handlerOf(app, "tools_refresh")({ service: out.account.service }, person);
  await assert.rejects(handlerOf(app, "mcp_tool_read_set")({ name: names.stripe_list_charges, read: true }, person), refusal(/^The server does not say this tool is read-only/u));
  assert.equal(classes().stripe_list_charges, "money");
});

test("QA-CONNECT22-4/5: withdraw then confirm again without a refresh; names with control or invisible characters are money and say why", async () => {
  const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
  const c = (code: number) => String.fromCharCode(code);
  // tab, newline, bell, zero-width space (distinct sanitized names: same-name tools would replace each other)
  const odd = [`list${c(9)}files`, `search_docs${c(10)}`, `list_${c(7)}notes`, `find${c(0x200b)}pages`];
  const extra = [{ name: "stripe_list_charges", annotations: { readOnlyHint: true } }, ...odd.map((name) => ({ name, annotations: { readOnlyHint: true } }))];
  const server = fakeServer({ extraTools: extra });
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), fetchImpl: server.impl, catalogAllowOrigins: ["https://mcp.example.com"] });
  const person = testCtx({ db, person: true });
  await handlerOf(app, "mcp_account_connect")({ label: "Payments", url: URL_, headers: { Authorization: "Bearer good" } }, person);
  const nameOf = (upstream: string) => String(db.prepare("SELECT name FROM connect_tools WHERE upstream = ?").get(upstream)?.name);
  const effect = (upstream: string) => String(db.prepare("SELECT effect FROM connect_tools WHERE upstream = ?").get(upstream)?.effect);
  const set = (upstream: string, read: boolean) => handlerOf(app, "mcp_tool_read_set")({ name: nameOf(upstream), read }, person);

  // QA-CONNECT22-4: confirm → withdraw → confirm again, no refresh in between: the stored current claim still allows it
  await set("stripe_list_charges", true);
  await set("stripe_list_charges", false);
  assert.equal(effect("stripe_list_charges"), "money");
  assert.deepEqual(await set("stripe_list_charges", true), { name: nameOf("stripe_list_charges"), effect: "read", ownerConfirmedRead: true });

  // QA-CONNECT22-4/5: control and invisible characters in a name → money, never confirmable, and the refusal names the reason
  for (const upstream of odd) {
    assert.equal(effect(upstream), "money", JSON.stringify(upstream));
    await assert.rejects(set(upstream, true), (e: ConnectError) => e.code === "tool_not_read_only" && /^This tool's name has characters Connect cannot check/u.test(e.message), JSON.stringify(upstream));
  }
});
