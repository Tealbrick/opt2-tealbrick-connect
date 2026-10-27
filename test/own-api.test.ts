/** C373 Jarvis T2 "bring your own API": an OpenAPI description becomes a service with held tools through the catalog compiler. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import { type ConnectError, createConnectApp } from "../src/app.ts";
import { buildOwnApi, OWN_API_OPS_MAX, type OwnApiInput, ownApiId } from "../src/sources/catalog/own-api.ts";
import { fakeFetch, handlerOf, root, secretsFor, testCtx, testDb } from "./helpers.ts";

// A small invoicing API shaped like the Italian e-invoicing services a developer would add (fictional).
const spec = {
  openapi: "3.0.3",
  info: { title: "Fatture (fictional)", version: "2.1" },
  servers: [{ url: "https://api.fatture.example/v2" }],
  paths: {
    "/c/{company_id}/issued_documents": {
      get: { operationId: "listIssuedDocuments", summary: "List issued documents", parameters: [{ name: "company_id", in: "path", required: true, schema: { type: "integer" } }] },
      post: { operationId: "createIssuedDocument", summary: "Create an issued document", parameters: [{ name: "company_id", in: "path", required: true, schema: { type: "integer" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { data: { type: "object" } } } } } } },
    },
    "/c/{company_id}/issued_documents/{document_id}": {
      delete: { operationId: "deleteIssuedDocument", parameters: [{ name: "company_id", in: "path", required: true, schema: { type: "integer" } }, { name: "document_id", in: "path", required: true, schema: { type: "integer" } }] },
    },
    "/c/{company_id}/issued_documents/{document_id}/e_invoice/send": {
      post: { operationId: "sendEInvoice", summary: "Send the e-invoice to SDI", parameters: [{ name: "company_id", in: "path", required: true, schema: { type: "integer" } }, { name: "document_id", in: "path", required: true, schema: { type: "integer" } }] },
    },
    "/c/{company_id}/issued_documents/{document_id}/email": {
      post: { operationId: "scheduleEmail", summary: "Email the document to the customer", parameters: [{ name: "company_id", in: "path", required: true, schema: { type: "integer" } }, { name: "document_id", in: "path", required: true, schema: { type: "integer" } }] },
    },
    "/c/{company_id}/shipments/label": {
      post: { operationId: "createShipmentLabel", summary: "Buy a shipping label", parameters: [{ name: "company_id", in: "path", required: true, schema: { type: "integer" } }] },
    },
    "/c/{company_id}/receipts/pay": {
      post: { operationId: "payReceipt", parameters: [{ name: "company_id", in: "path", required: true, schema: { type: "integer" } }] },
    },
    "/c/{company_id}/ledger": {
      post: { operationId: "frobnicateLedger", parameters: [{ name: "company_id", in: "path", required: true, schema: { type: "integer" } }] },
    },
    "/info": { get: { operationId: "getInfo", summary: "Who am I" } },
  },
};
const base: OwnApiInput = {
  name: "Fatture example",
  spec: JSON.stringify(spec),
  auth: { type: "header", name: "Authorization", prefix: "Bearer " },
  labels: { money: ["createShipmentLabel"], outward: ["scheduleEmail"] },
  healthOperation: "getInfo",
};
const classes = (input: OwnApiInput) => Object.fromEntries(buildOwnApi(input).preview.tools.map((t) => [t.operationId, t.effect]));

test("own API: catalog rules + labels + fail-closed names give every operation a hold class", () => {
  assert.deepEqual(classes(base), {
    listIssuedDocuments: "read",
    createIssuedDocument: "write",
    deleteIssuedDocument: "destructive",
    sendEInvoice: "outward", // no label: the name says send
    scheduleEmail: "outward", // label (the name alone says schedule = outward too)
    createShipmentLabel: "money", // money label: buying a label spends money
    payReceipt: "money", // money by name, always
    frobnicateLedger: "outward", // no known verb: fail closed (held)
    getInfo: "read",
  });
  const preview = buildOwnApi(base).preview;
  assert.equal(preview.service, "api_fatture_example");
  assert.deepEqual(preview.counts, { read: 2, write: 1, destructive: 1, outward: 3, money: 2 });
  assert.deepEqual(preview.warnings, []);
});

test("own API: reads label downgrades a POST, excluded ops are never offered, the catalog keeps the old method rule", () => {
  const c = classes({ ...base, labels: { reads: ["frobnicateLedger"], excluded: ["deleteIssuedDocument", "POST /c/*/receipts/pay"] } });
  assert.equal(c.frobnicateLedger, "read");
  assert.equal(c.deleteIssuedDocument, undefined);
  assert.equal(c.payReceipt, undefined);
});

test("own API: input checks answer one plain sentence each", () => {
  const err = (patch: Partial<OwnApiInput>) => {
    try {
      buildOwnApi({ ...base, ...patch } as OwnApiInput);
      return "";
    } catch (e) {
      return `${(e as { code: string }).code}: ${(e as Error).message}`;
    }
  };
  assert.match(err({ spec: "{nope" }), /^own_api_invalid: The description is not valid JSON/u);
  assert.match(err({ spec: JSON.stringify({ paths: {} }) }), /must be OpenAPI 3\.x/u);
  assert.match(err({ spec: JSON.stringify({ openapi: "3.0.0" }) }), /has no paths/u);
  assert.match(err({ spec: JSON.stringify({ openapi: "3.0.0", paths: {} }) }), /no operation Connect can call/u);
  assert.match(err({ spec: `"${"x".repeat(2 * 1024 * 1024 + 1)}"` }), /larger than 2 MiB/u);
  assert.match(err({ name: "  " }), /name is 1 to 60/u);
  assert.match(err({ name: "!!!" }), /at least one letter or digit/u);
  assert.match(err({ auth: { type: "header", name: "Bad Header" } }), /header name/u);
  assert.match(err({ auth: { type: "oauth" } as never }), /Auth type must be/u);
  assert.match(err({ healthOperation: "createIssuedDocument" }), /must be a read \(GET\)/u);
  assert.match(err({ healthOperation: "nope" }), /is not in the description/u);
  assert.match(err({ labels: { outward: [""] } }), /outward: each pattern/u);
  assert.match(err({ basePath: "/../etc" }), /path prefix/u);
  const many = { openapi: "3.0.0", paths: Object.fromEntries(Array.from({ length: OWN_API_OPS_MAX + 1 }, (_v, n) => [`/r${n}`, { get: { operationId: `get${n}` } }])) };
  assert.match(err({ spec: JSON.stringify(many), healthOperation: "get0" }), /the most is 500/u);
  assert.throws(() => buildOwnApi(base, new Set([ownApiId("Fatture example")])), /taken by a catalog app/u);
  assert.deepEqual(buildOwnApi({ ...base, healthOperation: "", auth: { type: "none" } }).preview.warnings.length, 2);
});

test("own API end to end: preview, add, listed as a service, connect an account, held classes on the tools, call, remove", async () => {
  const sha = (d: string | Uint8Array) => createHash("sha256").update(d).digest("hex");
  // an empty pinned catalog (the own API must not depend on catalog entries)
  const gz = gzipSync(Buffer.from(JSON.stringify({ format: "tealbrick.catalog/1", version: "9.9.9", entries: [] })));
  const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
  manifest.artifacts = [{ id: "catalog", version: "9.9.9", sha256: sha(gz), url: "https://github.com/Tealbrick/opt2-tealbrick-connect/releases/download/catalog-9.9.9/x.json.gz" }];
  const upstream = fakeFetch({
    "GET /v2/info": ({ headers }) => ({ body: { ok: true, auth: headers.get("authorization") === "Bearer SECRET-FIC-1" } }),
    "GET /v2/c/7/issued_documents": () => ({ body: { data: [{ id: 1 }] } }),
  });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith("https://github.com/") ? new Response(gz) : upstream.impl(input, init))) as typeof fetch;
  const dataDir = mkdtempSync(join(tmpdir(), "connect-ownapi-"));
  try {
    const db = testDb();
    const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), fetchImpl, dataDir, catalogAllowOrigins: ["https://api.fatture.example"] });
    const person = testCtx({ db, person: true });
    const preview = (await handlerOf(app, "api_preview")(base as never, person)) as { preview: { service: string; operations: number } };
    assert.deepEqual([preview.preview.service, preview.preview.operations], ["api_fatture_example", 9]);
    assert.equal(db.prepare("SELECT count(*) AS n FROM connect_own_apis").get()?.n, 0, "preview saves nothing");
    await assert.rejects(handlerOf(app, "api_add")({ ...base, spec: "{" } as never, person), (e: ConnectError) => e.code === "own_api_invalid");
    await handlerOf(app, "api_add")(base as never, person);
    const search = (await handlerOf(app, "services_search")({ query: "fatture" }, person)) as { services: { service: string; source: string; own?: boolean; fields: string[] }[] };
    assert.deepEqual(search.services.map((s) => [s.service, s.source, s.own, s.fields]), [["api_fatture_example", "catalog", true, ["token"]]]);
    const out = (await handlerOf(app, "catalog_account_connect")({ service: "api_fatture_example", label: "Fatture", baseUrl: "https://api.fatture.example", credentials: { token: "SECRET-FIC-1" } }, person)) as { account: { id: string } };
    assert.ok(!JSON.stringify(db.prepare("SELECT * FROM connect_own_apis").all()).includes("SECRET-FIC-1"), "no key in the own API row");
    assert.deepEqual(secretsFor(db).names(), [`account:${out.account.id}`]);
    const tools = Object.fromEntries(db.prepare("SELECT upstream, effect, hold_family FROM connect_tools WHERE service = 'api_fatture_example'").all().map((r) => [r.upstream, [r.effect, r.hold_family]]));
    assert.deepEqual(tools.sendEInvoice, ["outward", "outward"]);
    assert.deepEqual(tools.createShipmentLabel, ["money", "money"]);
    assert.deepEqual(tools.listIssuedDocuments, ["read", null]);
    const tested = (await handlerOf(app, "catalog_account_test")({ id: out.account.id }, person)) as { ok: boolean };
    assert.equal(tested.ok, true);
    const reader = testCtx({ db, access: { [out.account.id]: "read" } });
    const dyn = app.dynamic?.tools;
    assert.ok(dyn);
    const listed = (await dyn.call("cb_api_fatture_example_listissueddocuments", { path: { company_id: 7 } }, reader)) as { data: unknown };
    assert.deepEqual(listed.data, { data: [{ id: 1 }] });
    await assert.rejects(handlerOf(app, "api_remove")({ service: "api_fatture_example" }, person), (e: ConnectError) => e.code === "own_api_in_use");
    await handlerOf(app, "account_disconnect")({ id: out.account.id }, person);
    await handlerOf(app, "api_remove")({ service: "api_fatture_example" }, person);
    const after = (await handlerOf(app, "services_search")({ query: "fatture" }, person)) as { services: unknown[] };
    assert.deepEqual(after.services, []);
    await assert.rejects(handlerOf(app, "api_remove")({ service: "api_fatture_example" }, person), (e: ConnectError) => e.code === "catalog_app_unknown");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
