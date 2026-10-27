/**
 * C373 Jarvis (Coordinator approval): an account shared with ONE Evolving Workflows instance for READ tools. Fire-on-bad: unshared
 * account, another app, another instance, a write tool, an unlisted instance and a revoked share are all refused.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Json } from "@opt2-tealbrick/spec/sdk";
import { type ConnectError, createConnectApp } from "../src/app.ts";
import { fakeFetch, handlerOf, root, testCtx, testDb } from "./helpers.ts";

const EVO = "ins_01HZEV0000000000000000000A";
const EVO2 = "ins_01HZEV0000000000000000000B";
const KNOW = "ins_01HZKN0000000000000000000A";
const AGENT = "agt_01HZAG0000000000000000000A";
const spec = {
  openapi: "3.0.3",
  paths: {
    "/invoices": { get: { operationId: "listInvoices" }, post: { operationId: "createInvoice", requestBody: { content: { "application/json": { schema: { type: "object" } } } } } },
    "/reminders": { post: { operationId: "sendReminder" } },
  },
};

test("tool shares: only the shared Evolving Workflows instance, only READ tools, only while listed and shared", async () => {
  const sha = (d: string | Uint8Array) => createHash("sha256").update(d).digest("hex");
  const gz = gzipSync(Buffer.from(JSON.stringify({ format: "tealbrick.catalog/1", version: "9.9.9", entries: [] })));
  const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
  manifest.artifacts = [{ id: "catalog", version: "9.9.9", sha256: sha(gz), url: "https://github.com/Tealbrick/opt2-tealbrick-connect/releases/download/catalog-9.9.9/x.json.gz" }];
  const upstream = fakeFetch({ "GET /invoices": () => ({ body: { data: [{ id: 1 }] } }), "POST /invoices": () => ({ body: { id: 2 } }) });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith("https://github.com/") ? new Response(gz) : upstream.impl(input, init))) as typeof fetch;
  const dataDir = mkdtempSync(join(tmpdir(), "connect-toolshare-"));
  try {
    const db = testDb();
    const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), fetchImpl, dataDir, catalogAllowOrigins: ["https://billing.example.com"] });
    const callers = [
      { product: "evolution", ins: EVO, name: "Evolving Workflows" },
      { product: "knowledge", ins: KNOW, name: "Knowledge" },
    ];
    const person = testCtx({ db, person: true, companionCallers: callers });
    const op = (name: string, input: Record<string, unknown>, ctx = person) => handlerOf(app, name)(input as Json, ctx);
    await op("api_add", { name: "Billing", spec: JSON.stringify(spec), auth: { type: "none" } });
    const account = ((await op("catalog_account_connect", { service: "api_billing", label: "Billing", baseUrl: "https://billing.example.com", credentials: {} })) as unknown as { account: { id: string } }).account.id;
    const dyn = app.dynamic?.tools;
    assert.ok(dyn);
    const evo = testCtx({ db, app: EVO, appName: "Evolving Workflows", appProduct: "evolution", appListed: true });
    const read = (ctx = evo) => dyn.call("cb_api_billing_listinvoices", {}, ctx);
    const code = (c: string) => (e: ConnectError) => e.code === c;

    // unshared account → scope_denied
    await assert.rejects(read(), code("scope_denied"));
    // share refusals: unknown instance, wrong product, agent caller
    await assert.rejects(op("account_tools_share", { account, product: "evolution", instance: EVO2, share: true }), code("instance_unknown"));
    await assert.rejects(op("account_tools_share", { account, product: "knowledge", instance: KNOW, share: true }), code("product_unknown"));
    await assert.rejects(op("account_tools_share", { account, product: "evolution", instance: EVO, share: true }, testCtx({ db, agent: AGENT })), code("no_access"));
    // the owner shares → the read tool works for that instance
    await op("account_tools_share", { account, product: "evolution", instance: EVO, share: true });
    assert.deepEqual(((await read()) as { data: unknown }).data, { data: [{ id: 1 }] });
    const overview = (await op("accounts_overview", {})) as unknown as { accounts: { id: string; toolShares?: { product: string; instance: string; current: boolean }[] }[]; toolApps: { product: string; instances: unknown[] }[] };
    assert.deepEqual(overview.accounts.find((a) => a.id === account)?.toolShares?.map((t) => [t.product, t.instance, t.current]), [["evolution", EVO, true]]);
    assert.deepEqual(overview.toolApps.map((t) => [t.product, t.instances.length]), [["evolution", 1]]);
    // another evolution instance → scope_denied; another app → no_access; a write or outward tool → app_read_only
    await assert.rejects(read(testCtx({ db, app: EVO2, appProduct: "evolution", appListed: true })), code("scope_denied"));
    await assert.rejects(read(testCtx({ db, app: KNOW, appProduct: "knowledge", appListed: true })), code("no_access"));
    await assert.rejects(dyn.call("cb_api_billing_createinvoice", { body: {} }, evo), code("app_read_only"));
    await assert.rejects(dyn.call("cb_api_billing_sendreminder", {}, evo), code("app_read_only"));
    // an app without a verified product → caller_unverified; an instance not listed now → share_instance_gone
    await assert.rejects(read(testCtx({ db, app: EVO, appName: "Evolving Workflows" })), code("caller_unverified"));
    await assert.rejects(read(testCtx({ db, app: EVO, appProduct: "evolution", appListed: false })), code("share_instance_gone"));
    assert.equal(upstream.calls.filter((c) => c.method === "POST").length, 0, "no write ever reached the service");
    // revoke → the next call is refused at once
    await op("account_tools_share", { account, product: "evolution", share: false });
    await assert.rejects(read(), code("scope_denied"));
    // an agent's own access is unchanged by any of this
    await assert.rejects(dyn.call("cb_api_billing_listinvoices", {}, testCtx({ db, agent: AGENT, access: {} })), code("scope_denied"));
    assert.ok(((await dyn.call("cb_api_billing_listinvoices", {}, testCtx({ db, agent: AGENT, access: { [account]: "read" } }))) as { data: unknown }).data);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
