/** C373 Jarvis T3: a hold policy per MCP server can only raise tool classes (found live: an MCP ad-budget change was a plain write). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Json } from "@opt2-tealbrick/spec/sdk";
import { type ConnectError, createConnectApp } from "../src/app.ts";
import { classify, classifyMcpTool } from "../src/effect.ts";
import { parseMcpPolicy, raiseByPolicy } from "../src/sources/mcp/policy.ts";
import { handlerOf, root, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const TOOLS = [
  { name: "list_campaigns", annotations: { readOnlyHint: true } },
  { name: "update_campaign_budget", annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: "reply_to_comment", annotations: { readOnlyHint: false, openWorldHint: true } },
  { name: "archive_post", annotations: { readOnlyHint: false } },
  { name: "delete_post", annotations: { destructiveHint: true } },
  { name: "issue_refund", annotations: { readOnlyHint: false } },
];

test("raiseByPolicy: the first matching list (money first) raises; a lower list never lowers", () => {
  const policy = parseMcpPolicy({ money: ["*budget*"], outward: ["archive_*"], writes: ["delete_*", "reply_*", "list_*"] });
  const cls = (name: string) => raiseByPolicy(name, classifyMcpTool(name, TOOLS.find((t) => t.name === name)?.annotations), policy).effect;
  assert.equal(cls("update_campaign_budget"), "money");
  assert.equal(cls("archive_post"), "outward");
  assert.equal(cls("delete_post"), "destructive", "writes never lowers destructive");
  assert.equal(cls("reply_to_comment"), "outward", "writes never lowers outward");
  assert.equal(cls("list_campaigns"), "write", "a writes pattern raises a read to write");
  assert.equal(cls("issue_refund"), "money", "money by name stays money");
  assert.deepEqual(raiseByPolicy("update_campaign_budget", classify({ write: true, outward: false, destructive: false }), null), classify({ write: true, outward: false, destructive: false }));
  assert.equal(raiseByPolicy("UPDATE_CAMPAIGN_BUDGET", classify({ write: true, outward: false, destructive: false }), policy).holdFamily, "money", "patterns ignore case");
});

test("parseMcpPolicy: only the four lists, plain patterns, at most 200", () => {
  assert.throws(() => parseMcpPolicy(null), /an object/u);
  assert.throws(() => parseMcpPolicy({ reads: ["x"] }), /Unknown list "reads"/u);
  assert.throws(() => parseMcpPolicy({ money: "x" }), /money: a list/u);
  assert.throws(() => parseMcpPolicy({ money: [""] }), /each pattern/u);
  assert.throws(() => parseMcpPolicy({ money: ["bud​get"] }), /each pattern/u);
  assert.throws(() => parseMcpPolicy({ money: Array.from({ length: 201 }, () => "x") }), /at most 200/u);
  assert.deepEqual(parseMcpPolicy({ money: [" *budget* "] }), { money: ["*budget*"] });
});

test("mcp_policy_set on a connected server re-classes its tools at once; get answers it; an empty policy removes it", async () => {
  const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { id?: number; method?: string }) : null;
    if (!body || body.id === undefined) return new Response(null, { status: 202 });
    const result =
      body.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ads" } } : body.method === "tools/list" ? { tools: TOOLS } : {};
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json", "mcp-session-id": "s1" } });
  }) as typeof fetch;
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), fetchImpl: impl, catalogAllowOrigins: ["https://ads.example.com"] });
  const person = testCtx({ db, person: true });
  const op = (name: string, input: Record<string, unknown>) => handlerOf(app, name)(input as Json, person);
  const account = ((await op("mcp_account_connect", { label: "Ads", url: "https://ads.example.com/mcp", headers: {} })) as unknown as { account: { service: string } }).account;
  const effectOf = (upstream: string) => (db.prepare("SELECT effect FROM connect_tools WHERE service = ? AND upstream = ?").get(account.service, upstream) as { effect: string }).effect;
  assert.equal(effectOf("update_campaign_budget"), "write", "before: the live gap");
  await assert.rejects(op("mcp_policy_set", { service: account.service, policy: { reads: ["*"] } }), (e: ConnectError) => e.code === "mcp_policy_invalid");
  await assert.rejects(op("mcp_policy_set", { service: "mcp_nope", policy: { money: ["*"] } }), (e: ConnectError) => e.code === "mcp_service_unknown");
  const out = (await op("mcp_policy_set", { service: account.service, policy: { money: ["*budget*"] } })) as unknown as { classes: { effect: string }[] };
  assert.ok(out.classes.some((c) => c.effect === "money"));
  assert.equal(effectOf("update_campaign_budget"), "money");
  assert.deepEqual(((await op("mcp_policy_get", { service: account.service })) as unknown as { policy: unknown }).policy, { money: ["*budget*"] });
  await op("mcp_policy_set", { service: account.service, policy: {} });
  assert.equal(effectOf("update_campaign_budget"), "write", "an empty policy removes it");
  assert.equal(db.prepare("SELECT count(*) AS n FROM connect_mcp_policies").get()?.n, 0);
});
