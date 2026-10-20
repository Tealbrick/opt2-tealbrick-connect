/**
 * C276c (Coordinator 2026-10-20): a customer email is a send. Catalog ops the entry labels `firstContact` go through the X-02
 * first-contact check with the recipients from where the entry says they are; an op whose recipient is not in the input (the
 * stored ticket customer) is a first contact on every call. Driven against the shipped catalog (test/fixtures/catalog).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import { type ConnectError, createConnectApp } from "../src/app.ts";
import { catalogToolName } from "../src/sources/catalog/source.ts";
import { fakeFetch, handlerOf, root, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const pinned = manifest.artifacts?.find((a) => a.id === "catalog");
assert.ok(pinned);
const gz = readFileSync(join(root, "test", "fixtures", "catalog", `tealbrick-catalog-${pinned.version}.json.gz`));
const BASE = "https://crm.example.com";

async function setup() {
  const upstream = fakeFetch({
    "POST /api/method/frappe.core.doctype.communication.email.make": () => ({ body: { message: { name: "COMM-1" } } }),
    "POST /api/resource/HD%20Ticket": () => ({ body: { data: { name: "T-1" } } }),
    "PUT /api/resource/HD%20Ticket/T-1": () => ({ body: { data: { name: "T-1" } } }),
    "POST /api/v2/document/HD%20Ticket/T-1/method/reply_via_agent/": () => ({ body: { data: null } }),
    "GET /api/method/frappe.auth.get_logged_user": () => ({ body: { message: "api@example.com" } }),
  });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) =>
    String(input).startsWith("https://github.com/") ? new Response(gz) : upstream.impl(input, init)) as typeof fetch;
  const dataDir = mkdtempSync(join(tmpdir(), "connect-fc-"));
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), fetchImpl, dataDir, catalogAllowOrigins: [BASE] });
  const person = testCtx({ db, person: true });
  const out = (await handlerOf(app, "catalog_account_connect")({ service: "frappe-crm", label: "CRM", baseUrl: BASE, credentials: { token: "k:s" } }, person)) as {
    account: { id: string };
  };
  const agent = testCtx({ db, access: { [out.account.id]: "read_update_delete" } });
  const dyn = app.dynamic?.tools;
  assert.ok(dyn);
  const calls = (path: string) => upstream.calls.filter((c) => c.url.pathname === path).length;
  return { app, db, dyn, agent, person, calls, done: () => rmSync(dataDir, { recursive: true, force: true }) };
}
const tool = (op: string) => catalogToolName("frappe-crm", op);
const firstContact = (recipients: string[]) => (e: ConnectError) => {
  assert.equal(e.code, "first_contact_required");
  assert.deepEqual((e.details as { recipients: string[] }).recipients, recipients);
  return true;
};

test("C276c crm_send_email: a new recipient (recipients/cc/bcc in the body) is held; after one approved first contact it runs", async () => {
  const s = await setup();
  try {
    const send = tool("crm_send_email");
    const body = { doctype: "CRM Lead", name: "L-1", subject: "Hi", content: "Hello", send_email: 1 };
    assert.equal((await s.dyn.resolve(`${send}__first_contact`, s.agent))?.holdFamily, "first_contact");
    await assert.rejects(s.dyn.call(send, { body: { ...body, recipients: "new@ext.example", cc: "Boss <boss@ext.example>" } }, s.agent), firstContact(["boss@ext.example", "new@ext.example"]));
    assert.equal(s.calls("/api/method/frappe.core.doctype.communication.email.make"), 0);
    await s.dyn.call(`${send}__first_contact`, { body: { ...body, recipients: "new@ext.example" } }, s.agent);
    await s.dyn.call(send, { body: { ...body, recipients: "new@ext.example" } }, s.agent);
    assert.equal(s.calls("/api/method/frappe.core.doctype.communication.email.make"), 2);
  } finally {
    s.done();
  }
});

test("C276c hd_reply_to_ticket: recipients from body.to/cc/bcc", async () => {
  const s = await setup();
  try {
    const reply = tool("hd_reply_to_ticket");
    const args = { path: { name: "T-1" }, body: { message: "Fixed.", to: "customer@ext.example" } };
    await assert.rejects(s.dyn.call(reply, args, s.agent), firstContact(["customer@ext.example"]));
    await s.dyn.call(`${reply}__first_contact`, args, s.agent);
    await s.dyn.call(reply, args, s.agent);
    assert.equal(s.calls("/api/v2/document/HD%20Ticket/T-1/method/reply_via_agent/"), 2);
  } finally {
    s.done();
  }
});

test("C276c hd_ticket_create: raised_by names the customer; without it the recipient cannot be seen and the call is held", async () => {
  const s = await setup();
  try {
    const create = tool("hd_ticket_create");
    await assert.rejects(s.dyn.call(create, { body: { subject: "Help", raised_by: "client@ext.example" } }, s.agent), firstContact(["client@ext.example"]));
    await assert.rejects(s.dyn.call(create, { body: { subject: "Help" } }, s.agent), firstContact([]));
    assert.equal(s.calls("/api/resource/HD%20Ticket"), 0);
    await s.dyn.call(`${create}__first_contact`, { body: { subject: "Help", raised_by: "client@ext.example" } }, s.agent);
    await s.dyn.call(create, { body: { subject: "Again", raised_by: "client@ext.example" } }, s.agent);
    assert.equal(s.calls("/api/resource/HD%20Ticket"), 2);
  } finally {
    s.done();
  }
});

test("C276c hd_ticket_update: the stored customer is not in the input, so EVERY call is a first contact (held), also after one approval", async () => {
  const s = await setup();
  try {
    const update = tool("hd_ticket_update");
    const args = { path: { name: "T-1" }, body: { status: "Resolved" } };
    await assert.rejects(s.dyn.call(update, args, s.agent), firstContact([]));
    await s.dyn.call(`${update}__first_contact`, args, s.agent);
    await assert.rejects(s.dyn.call(update, args, s.agent), firstContact([]));
    assert.equal(s.calls("/api/resource/HD%20Ticket/T-1"), 1);
  } finally {
    s.done();
  }
});

test("C276c: writes that mail nobody (a CRM lead) and the Umami reads are not send tools; Umami's connect form says to use a View-only user", async () => {
  const s = await setup();
  try {
    assert.equal(await s.dyn.resolve(`${tool("crm_lead_create")}__first_contact`, s.agent), null);
    const search = (await handlerOf(s.app, "services_search")({ query: "umami" }, s.person)) as { services: { service: string; credentialHint?: string }[] };
    assert.match(search.services.find((x) => x.service === "umami")?.credentialHint ?? "", /dedicated View-only user/u);
  } finally {
    s.done();
  }
});

test("C276c recipientsAt reads only the named pointers; an invalid firstContact label refuses the bundle", async () => {
  const { recipientsAt } = await import("../src/effect.ts");
  const { parseBundle } = await import("../src/sources/catalog/source.ts");
  const { createHash } = await import("node:crypto");
  const { gzipSync } = await import("node:zlib");
  assert.deepEqual(recipientsAt({ body: { to: "A <a@x.example>", cc: ["b@x.example"], other: "c@x.example" } }, ["body.to", "body.cc"]), ["a@x.example", "b@x.example"]);
  assert.deepEqual(recipientsAt({ body: { to: "a@x.example" } }, []), []);
  assert.deepEqual(recipientsAt({ to: "a@x.example" }, ["body.to"]), []);
  const sha = (d: string | Uint8Array) => createHash("sha256").update(d).digest("hex");
  const spec = JSON.stringify({ openapi: "3.0.3", paths: {} });
  const bundle = (firstContact: unknown) => {
    const doc = { format: "tealbrick.catalog/1", version: "9.9.9", entries: [{ id: "x", entry: { schema: 1, id: "x", source: "openapi", openapi: { spec: "openapi.json", sha256: sha(spec) }, firstContact }, files: [{ name: "openapi.json", sha256: sha(spec), content: spec }] }] };
    return gzipSync(Buffer.from(JSON.stringify(doc)));
  };
  const ok = bundle([{ operation: "send", recipients: ["body.to"] }]);
  assert.deepEqual(parseBundle(ok, sha(ok))[0]?.labels.firstContact, [{ operation: "send", recipients: ["body.to"] }]);
  for (const bad of [[{ operation: "send", recipients: ["to"] }], [{ operation: "send" }], "send", [{ operation: "send", recipients: ["body.a.b"] }]]) {
    const gz2 = bundle(bad);
    assert.throws(() => parseBundle(gz2, sha(gz2)), /firstContact is invalid/u, JSON.stringify(bad));
  }
});

test("review #19 S2-1: a display name cannot hide a new address behind a known one", async () => {
  const s = await setup();
  try {
    const send = tool("crm_send_email");
    const body = { doctype: "CRM Lead", name: "L-1", subject: "Hi", content: "Hello", send_email: 1 };
    await s.dyn.call(`${send}__first_contact`, { body: { ...body, recipients: "friend@ext.example" } }, s.agent);
    await assert.rejects(s.dyn.call(send, { body: { ...body, recipients: '"<friend@ext.example>" <stranger@ext.example>' } }, s.agent), firstContact(["stranger@ext.example"]));
    await assert.rejects(s.dyn.call(send, { body: { ...body, recipients: "Friend friend@ext.example stranger@ext.example" } }, s.agent), firstContact(["stranger@ext.example"]));
    // re-check: padding must not push an address out of sight
    await assert.rejects(
      s.dyn.call(send, { body: { ...body, recipients: `"<friend@ext.example>${" ".repeat(2100)}" <stranger@ext.example>` } }, s.agent),
      (e: ConnectError) => e.code === "first_contact_required" && (e.details as { recipients: string[] }).recipients.includes("stranger@ext.example"),
    );
    assert.equal(s.calls("/api/method/frappe.core.doctype.communication.email.make"), 1);
  } finally {
    s.done();
  }
});

test("review #19 S2-2: the owner's hold view of a catalog send shows the recipient, subject and text", async () => {
  const s = await setup();
  try {
    const view = await s.dyn.holdView?.(`${tool("crm_send_email")}__first_contact`, { body: { doctype: "CRM Lead", name: "L-1", subject: "Offer", content: "Dear customer", send_email: 1, recipients: "new@ext.example" } }, s.agent);
    assert.ok(view);
    assert.match(view.view, /To: new@ext\.example/u);
    assert.match(view.view, /Offer/u);
    assert.match(view.view, /Dear customer/u);
    const stored = await s.dyn.holdView?.(`${tool("hd_ticket_update")}__first_contact`, { path: { name: "T-1" }, body: { status: "Resolved" } }, s.agent);
    assert.match(stored?.view ?? "", /Connect cannot see who receives this/u);
  } finally {
    s.done();
  }
});

test("review #19 S3-1/S3-2: an empty primary recipient is held; ticket create also counts contact and customer", async () => {
  const s = await setup();
  try {
    const reply = tool("hd_reply_to_ticket");
    await s.dyn.call(`${reply}__first_contact`, { path: { name: "T-1" }, body: { message: "x", to: "known@ext.example" } }, s.agent);
    // no "to": Helpdesk may fall back to the stored customer → held, even with a known cc
    await assert.rejects(s.dyn.call(reply, { path: { name: "T-1" }, body: { message: "x", cc: "known@ext.example" } }, s.agent), firstContact([]));
    const create = tool("hd_ticket_create");
    await s.dyn.call(`${create}__first_contact`, { body: { subject: "a", raised_by: "client@ext.example" } }, s.agent);
    await assert.rejects(s.dyn.call(create, { body: { subject: "b", raised_by: "client@ext.example", contact: "Stranger GmbH" } }, s.agent), firstContact(["stranger gmbh"]));
  } finally {
    s.done();
  }
});

test("review #19 S3-3 + S4: a firstContact label on a missing or non-outward op refuses the entry; path text and HTML errors are bounded", async () => {
  const { compile } = await import("../src/sources/catalog/openapi.ts");
  const { buildRequest, plainError } = await import("../src/sources/catalog/http.ts");
  const spec = { openapi: "3.0.3", paths: { "/m": { post: { operationId: "mail" } }, "/r": { get: { operationId: "read_it" } } } };
  assert.equal(compile(spec, { outward: ["mail"], firstContact: [{ operation: "mail", recipients: ["body.to"] }] }).operations.find((o) => o.operationId === "mail")?.sendRecipients?.[0], "body.to");
  assert.throws(() => compile(spec, { outward: ["mail"], firstContact: [{ operation: "mial", recipients: [] }] }), /names no exposed operation/u);
  assert.throws(() => compile(spec, { firstContact: [{ operation: "read_it", recipients: [] }] }), /not outward/u);
  const started = Date.now();
  plainError(`<html>${"<title".repeat(10_000)}`);
  assert.ok(Date.now() - started < 200, "plainError stays fast on hostile input");
  const [get] = compile({ openapi: "3.0.3", paths: { "/f/{p}": { get: { operationId: "g", parameters: [{ name: "p", in: "path", required: true, schema: { type: "string" } }] } } } }).operations;
  assert.ok(get);
  assert.throws(() => buildRequest({ baseUrl: "https://a.example.com", basePath: "", op: get, args: { path: { p: "\uD800" } }, auth: { type: "none" }, credentials: {} }), /not valid text/u);
});
