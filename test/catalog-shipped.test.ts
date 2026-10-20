/**
 * The shipped catalog artifact (test/fixtures/catalog = the bytes pinned in the manifest `artifacts[catalog]`):
 * overlays merged (CF-PZ-2), declared header defaults sent (CF-NC-1), Mautic compiled with its labels.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { buildRequest, headerDefault } from "../src/sources/catalog/http.ts";
import { type CompiledOperation, compile } from "../src/sources/catalog/openapi.ts";
import { applyMergePatch, type CatalogApp, parseBundle } from "../src/sources/catalog/source.ts";
import { root } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as { artifacts: { id: string; version: string; sha256: string; url: string }[] };
const pinned = manifest.artifacts.find((a) => a.id === "catalog");
assert.ok(pinned);
const gz = readFileSync(join(root, "test", "fixtures", "catalog", `tealbrick-catalog-${pinned.version}.json.gz`));
const apps = new Map(parseBundle(gz, pinned.sha256).map((a) => [a.id, a]));
const raw = JSON.parse(gunzipSync(gz).toString("utf8")) as { entries: { id: string; entry: { openapi: { spec: string; overlay?: { file: string } } }; files: { name: string; content: string }[] }[] };

function app(id: string): CatalogApp {
  const a = apps.get(id);
  assert.ok(a, `catalog app ${id}`);
  return a;
}
function op(id: string, method: string, path: string): CompiledOperation {
  const a = app(id);
  const found = compile(a.spec, a.labels).operations.find((o) => o.method === method && o.path === path);
  assert.ok(found, `${id} ${method.toUpperCase()} ${path}`);
  return found;
}
type Obj = { type?: string; properties?: Record<string, Obj>; required?: string[] };
const prop = (schema: unknown, ...keys: string[]): Obj | undefined => keys.reduce<Obj | undefined>((s, k) => s?.properties?.[k], schema as Obj);

test("fixture is the artifact the manifest pins", () => {
  assert.equal(createHash("sha256").update(gz).digest("hex"), pinned.sha256);
  assert.match(pinned.url, new RegExp(`/releases/download/catalog-${pinned.version.replaceAll(".", "\\.")}/tealbrick-catalog-${pinned.version.replaceAll(".", "\\.")}\\.json\\.gz$`, "u"));
});

test("CF-PZ-2: every entry with an overlay gets it merged into its spec (RFC 7396)", () => {
  const withOverlay = raw.entries.filter((e) => e.entry.openapi.overlay);
  assert.deepEqual(withOverlay.map((e) => e.id), ["authentik", "changedetection", "chatwoot", "formbricks", "postiz"]);
  for (const e of withOverlay) {
    const spec = JSON.parse(e.files.find((f) => f.name === e.entry.openapi.spec)?.content ?? "null");
    const overlay = JSON.parse(e.files.find((f) => f.name === e.entry.openapi.overlay?.file)?.content ?? "null");
    assert.ok(overlay, `${e.id} overlay file`);
    assert.deepEqual(app(e.id).spec, applyMergePatch(spec, overlay), e.id);
    assert.notDeepEqual(app(e.id).spec, spec, `${e.id}: overlay changes the spec`);
    assert.ok(compile(app(e.id).spec, app(e.id).labels).operations.length > 0, `${e.id} compiles`);
  }
});

test("CF-PZ-2: Postiz POST /public/v1/posts has its body schema; GET has startDate/endDate/customer", () => {
  const create = op("postiz", "post", "/public/v1/posts");
  assert.equal(create.effect, "outward");
  assert.equal(create.body?.contentType, "application/json");
  assert.equal(create.body?.required, true);
  assert.deepEqual(create.body?.schema.required, ["type", "posts"]);
  const body = prop(create.inputSchema, "body");
  assert.ok(prop(body, "type") && prop(body, "posts") && prop(body, "date"));
  assert.ok((create.inputSchema.required as string[] | undefined)?.includes("body"));

  const list = op("postiz", "get", "/public/v1/posts");
  assert.equal(list.effect, "read");
  const query = prop(list.inputSchema, "query");
  for (const name of ["startDate", "endDate", "customer"]) assert.ok(prop(query, name), `query.${name}`);
  const built = buildRequest({ baseUrl: "https://postiz.example.com", basePath: "/api", op: list, args: { query: { startDate: "2026-10-01T00:00:00Z", endDate: "2026-10-31T00:00:00Z" } }, auth: { type: "header", name: "Authorization" }, credentials: { token: "t" } });
  assert.equal(built.url.searchParams.get("startDate"), "2026-10-01T00:00:00Z");
  assert.equal(built.url.searchParams.get("endDate"), "2026-10-31T00:00:00Z");

  // The overlay declares the upload body as multipart (a file): binary inputs are not in opt2 (C11), so the tool that
  // could never send a file is no longer offered. Upload from a URL stays.
  const postiz = compile(app("postiz").spec, app("postiz").labels).operations;
  assert.ok(!postiz.some((o) => o.path === "/public/v1/upload"));
  assert.ok(postiz.some((o) => o.path === "/public/v1/upload-from-url"));
});

test("merge patch: objects merge, null deletes, arrays and scalars replace", () => {
  assert.deepEqual(applyMergePatch({ a: { b: 1, c: 2 }, d: [1, 2], e: 1 }, { a: { c: null, x: 3 }, d: [9], e: "s" }), { a: { b: 1, x: 3 }, d: [9], e: "s" });
  assert.deepEqual(applyMergePatch({ a: 1 }, { a: { b: null } }), { a: {} });
  const merged = applyMergePatch({ a: 1 }, JSON.parse('{"__proto__": {"polluted": true}, "b": 2}')) as Record<string, unknown>;
  assert.deepEqual(merged, { a: 1, b: 2 });
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
});

test("CF-NC-1: Nextcloud OCS ops send OCS-APIRequest: true when the caller omits it; the caller's value wins", () => {
  const nc = app("nextcloud");
  assert.equal(nc.healthOperation, "ocs-get-capabilities");
  const health = compile(nc.spec, nc.labels).operations.find((o) => o.operationId === "ocs-get-capabilities");
  assert.ok(health);
  assert.equal(health.effect, "read");
  // The agent may omit it: the header group is not required (it is filled in at call time).
  assert.ok(!(health.inputSchema.required as string[] | undefined)?.includes("header"));
  const auth = { type: "basic" as const };
  const credentials = { username: "u", password: "p" };
  const sent = buildRequest({ baseUrl: "https://cloud.example.com", basePath: nc.basePathOverride ?? "", op: health, args: {}, auth, credentials });
  assert.equal((sent.init.headers as Record<string, string>)["OCS-APIRequest"], "true");
  const own = buildRequest({ baseUrl: "https://cloud.example.com", basePath: "", op: health, args: { header: { "OCS-APIRequest": false } }, auth, credentials });
  assert.equal((own.init.headers as Record<string, string>)["OCS-APIRequest"], "false");
  // Every OCS op in the catalog declares it, and every one now sends it.
  const ocs = compile(nc.spec, nc.labels).operations.filter((o) => o.parameters.some((p) => p.in === "header" && p.name === "OCS-APIRequest"));
  assert.ok(ocs.length > 10);
  for (const o of ocs) assert.equal(headerDefault(o.parameters.find((p) => p.name === "OCS-APIRequest") ?? { in: "query", schema: {} }), true, o.operationId);
});

test("CF-NC-1: defaults never set auth, transport or credential headers; const wins over default; non-scalars ignored", () => {
  const spec = {
    openapi: "3.0.3",
    paths: {
      "/x": {
        get: {
          operationId: "x",
          parameters: [
            { name: "X-Api-Key", in: "header", required: true, schema: { type: "string", default: "planted" } },
            { name: "Authorization", in: "header", schema: { type: "string", default: "Bearer planted" } },
            { name: "Cookie", in: "header", schema: { type: "string", default: "s=planted" } },
            { name: "Content-Type", in: "header", schema: { type: "string", default: "text/plain" } },
            { name: "X-Mode", in: "header", schema: { type: "string", const: "fixed", default: "other" } },
            { name: "X-Obj", in: "header", schema: { type: "object", default: { a: 1 } } },
            { name: "X-Null", in: "header", required: true, schema: { type: "string", default: null } },
            { name: "X-Forwarded-For", in: "header", schema: { type: "string", default: "1.2.3.4" } },
            { name: "constructor", in: "header", schema: { type: "string" } },
            { name: "X-Plain", in: "header", required: true, schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 10 } },
          ],
        },
      },
    },
  };
  const [x] = compile(spec).operations;
  assert.ok(x);
  // A required header without a default stays required for the caller.
  // A required header without a usable (scalar) default stays required for the caller.
  assert.deepEqual(prop(x.inputSchema, "header")?.required, ["X-Null", "X-Plain"]);
  const headerAuth = buildRequest({ baseUrl: "https://a.example.com", basePath: "", op: x, args: { header: { "X-Plain": "p", "X-Null": "n" } }, auth: { type: "header", name: "X-Api-Key" }, credentials: { token: "REAL" } });
  const h = headerAuth.init.headers as Record<string, string>;
  assert.equal(h["X-Api-Key"], "REAL");
  assert.equal(h.Authorization, undefined);
  assert.equal(h.Cookie, undefined);
  assert.equal(h["Content-Type"], undefined);
  assert.equal(h["X-Mode"], "fixed");
  assert.equal(h["X-Obj"], undefined);
  assert.equal(h["X-Plain"], "p");
  assert.equal(h["X-Forwarded-For"], undefined);
  assert.ok(!Object.hasOwn(h, "constructor"), "inherited keys are not header values");
  // Query defaults are not sent (only headers: v1 parameterHasDefault is header-only).
  assert.equal(headerAuth.url.searchParams.get("limit"), null);
  const basic = buildRequest({ baseUrl: "https://a.example.com", basePath: "", op: x, args: {}, auth: { type: "basic" }, credentials: { username: "u", password: "p" } });
  assert.equal((basic.init.headers as Record<string, string>).authorization, `Basic ${Buffer.from("u:p").toString("base64")}`);
  assert.equal((basic.init.headers as Record<string, string>).Authorization, undefined);
  assert.throws(() => buildRequest({ baseUrl: "https://a.example.com", basePath: "", op: x, args: { header: { "X-Mode": "a\r\nb" } }, auth: { type: "none" }, credentials: {} }), /line break/u);
});

test("Mautic: 168 exposed ops (v2 PATCH back since CF-CT-1), outward/destructive labels intact, admin and webhook ops not exposed", () => {
  const m = app("mautic");
  assert.equal(m.auth.type, "basic");
  assert.equal(m.baseUrlExample, "https://mautic.example.com");
  const ops = compile(m.spec, m.labels).operations;
  assert.equal(ops.length, 168);
  const count = (key: (o: CompiledOperation) => string) => {
    const acc: Record<string, number> = {};
    for (const o of ops) acc[key(o)] = (acc[key(o)] ?? 0) + 1;
    return acc;
  };
  assert.deepEqual(count((o) => o.effect), { read: 67, write: 42, outward: 30, destructive: 29 });
  assert.deepEqual(count((o) => o.method), { get: 67, post: 40, patch: 32, delete: 29 });
  const byId = new Map(ops.map((o) => [o.operationId, o]));
  for (const id of m.labels.outward ?? []) {
    const o = byId.get(id);
    assert.ok(o, `outward ${id} exposed`);
    assert.equal(o.effect, "outward", id);
    assert.equal(o.holdFamily, "outward", id);
  }
  assert.equal((m.labels.outward ?? []).length, 30);
  for (const o of ops.filter((x) => x.method === "delete")) {
    assert.equal(o.effect, "destructive", o.operationId);
    assert.equal(o.holdFamily, "destructive", o.operationId);
    assert.ok(o.crud.includes("delete"), o.operationId);
  }
  for (const id of ["v1_emails_send", "v1_emails_contact_send", "v1_campaigns_contact_add", "v1_contacts_dnc_email_remove"]) assert.equal(byId.get(id)?.effect, "outward", id);
  assert.ok(!ops.some((o) => /\/api\/v2\/(users|roles|permissions)\b/u.test(o.path)), "no admin ops");
  assert.ok(!ops.some((o) => o.method === "post" && o.path === "/api/v2/webhooks"), "no webhook create");
  assert.ok(!ops.some((o) => o.path.startsWith("/api/v2/") && o.method === "put"), "no v2 PUT (it blanks omitted fields)");
  assert.ok(!ops.some((o) => o.path.startsWith("/api/v2/webhooks") && ["post", "patch", "put"].includes(o.method)), "no webhook create or PATCH");
  // CF-CT-1: the v2 PATCH sends the declared merge-patch type
  const patch = ops.find((o) => o.method === "patch" && o.path === "/api/v2/tags/{id}");
  assert.equal(patch?.body?.contentType, "application/merge-patch+json");
  assert.deepEqual(patch?.crud, ["update"]);
  const patched = buildRequest({ baseUrl: "https://mautic.example.com", basePath: "", op: patch as CompiledOperation, args: { path: { id: 3 }, body: { tag: "vip" } }, auth: m.auth, credentials: { username: "u", password: "p" } });
  assert.equal((patched.init.headers as Record<string, string>)["content-type"], "application/merge-patch+json");
  assert.equal(patched.init.body, JSON.stringify({ tag: "vip" }));
  assert.equal(ops.find((o) => o.method === "patch" && o.path === "/api/v2/campaigns/{id}")?.effect, "outward");
  const health = byId.get(m.healthOperation ?? "");
  assert.equal(health?.effect, "read");
  assert.equal(health?.path, "/api/v2/tags");
  const sent = buildRequest({ baseUrl: "https://mautic.example.com", basePath: m.basePathOverride ?? "", op: health as CompiledOperation, args: {}, auth: m.auth, credentials: { username: "api", password: "pw" } });
  assert.equal(sent.url.toString(), "https://mautic.example.com/api/v2/tags");
});

test("Chatwoot (Connect override of the v1 entry): admin-class ops are excluded, the overlay routes and labels stay", () => {
  const cw = app("chatwoot");
  const ops = compile(cw.spec, cw.labels).operations;
  const id = (o: CompiledOperation) => `${o.method.toUpperCase()} ${o.path}`;
  assert.ok(!ops.some((o) => o.path.startsWith("/platform/api/")), "no Platform API");
  assert.ok(!ops.some((o) => /\/(saml_settings|custom_roles)\b/u.test(o.path)), "no SAML or custom roles");
  assert.ok(!ops.some((o) => o.path.startsWith("/api/v1/profile") && o.method !== "get"), "no profile/MFA/token writes");
  assert.ok(!ops.some((o) => o.path.includes("whatsapp_business_management_token")), "no WhatsApp Business token");
  assert.ok(!ops.some((o) => o.path.includes("/captain/custom_tools") && (o.method === "post" || o.method === "patch")), "no custom-tool writes");
  // Health and the agent work stay: profile read, conversations, messages (outward, held per policy).
  assert.equal(ops.find((o) => o.operationId === cw.healthOperation)?.effect, "read");
  const send = ops.find((o) => id(o) === "POST /api/v1/accounts/{account_id}/conversations/{conversation_id}/messages");
  assert.equal(send?.effect, "outward");
  assert.equal(send?.holdFamily, "outward");
  assert.ok(ops.length > 152, "overlay routes are merged");
  for (const o of ops.filter((x) => x.method === "delete")) assert.equal(o.effect, "destructive", id(o));
});

test("no operator host names anywhere in the shipped artifact", () => {
  const text = gunzipSync(gz).toString("utf8");
  assert.doesNotMatch(text, /polygonface|\.ts\.net|tailnet|fedora-?n150|192\.168\./iu);
});

test("Frappe CRM + Helpdesk (catalog 0.3.0): 65 ops with their labels; DocType paths keep %20; token auth key:secret", () => {
  const f = app("frappe-crm");
  assert.deepEqual(f.auth, { type: "header", name: "Authorization", prefix: "token ", label: "API key and secret, as key:secret" });
  const ops = compile(f.spec, f.labels).operations;
  assert.equal(ops.length, 65);
  const count: Record<string, number> = {};
  for (const o of ops) count[o.effect] = (count[o.effect] ?? 0) + 1;
  assert.deepEqual(count, { read: 30, write: 21, outward: 4, destructive: 10 });
  const byId = new Map(ops.map((o) => [o.operationId, o]));
  for (const id of ["crm_send_email", "hd_reply_to_ticket", "hd_ticket_create", "hd_ticket_update"]) assert.equal(byId.get(id)?.effect, "outward", id);
  // merge_ticket is listed outward too, destructive wins
  assert.equal(byId.get("hd_merge_tickets")?.effect, "destructive");
  for (const o of ops.filter((x) => x.method === "delete")) assert.equal(o.effect, "destructive", o.operationId);
  assert.equal(byId.get(f.healthOperation ?? "")?.effect, "read");
  const create = ops.find((o) => o.method === "post" && o.path === "/api/resource/CRM%20Lead");
  assert.ok(create);
  const sent = buildRequest({ baseUrl: "https://crm.example.com", basePath: f.basePathOverride ?? "", op: create, args: { body: { first_name: "A" } }, auth: f.auth, credentials: { token: "k:s" } });
  assert.equal(sent.url.toString(), "https://crm.example.com/api/resource/CRM%20Lead");
  assert.equal((sent.init.headers as Record<string, string>).Authorization, "token k:s");
});

test("Umami (catalog 0.3.0): 34 ops, all read; no collection, login, admin or /api/me (it echoes the token)", () => {
  const u = app("umami");
  assert.deepEqual(u.auth, { type: "header", name: "Authorization", prefix: "Bearer ", label: "Umami token" });
  const ops = compile(u.spec, u.labels).operations;
  assert.equal(ops.length, 34);
  assert.ok(ops.every((o) => o.effect === "read" && o.crud.join() === "read"), "all read");
  for (const bad of ["/api/send", "/api/batch", "/api/me", "/api/auth/login", "/api/users", "/api/admin"]) assert.ok(!ops.some((o) => o.path.startsWith(bad)), bad);
  assert.equal(ops.find((o) => o.operationId === u.healthOperation)?.path, "/api/websites");
});

test("QA INFO (0.6.0): an upstream HTML error page reaches the agent only as its title; other text loses its tags", async () => {
  const { plainError } = await import("../src/sources/catalog/http.ts");
  assert.equal(plainError("<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><script>x()</script>secret-ish internals</body></html>"), 'HTML page "502 Bad Gateway"');
  assert.equal(plainError("<html><body>no title</body></html>"), "HTML page");
  assert.equal(plainError("Bad <b>request</b>:\n  field   missing"), "Bad request : field missing");
});

test("CF-NC-2: Nextcloud WebDAV file paths may span folders (x-multi-segment); traversal, backslash and leading / are refused", () => {
  const nc = app("nextcloud");
  const ops = compile(nc.spec, nc.labels).operations;
  const get = ops.find((o) => o.method === "get" && o.path === "/remote.php/dav/files/{user}/{path}");
  assert.ok(get, "WebDAV download op");
  assert.equal(get.parameters.find((p) => p.name === "path")?.multiSegment, true);
  assert.notEqual(get.parameters.find((p) => p.name === "user")?.multiSegment, true, "user stays one segment");
  const url = (path: unknown, user: unknown = "henry") =>
    buildRequest({ baseUrl: "https://cloud.example.com", basePath: nc.basePathOverride ?? "", op: get, args: { path: { user, path } }, auth: { type: "basic" }, credentials: { username: "u", password: "p" } }).url.toString();
  assert.equal(url("Documents/Q3 report/notes.md"), "https://cloud.example.com/remote.php/dav/files/henry/Documents/Q3%20report/notes.md");
  assert.equal(url("notes.md"), "https://cloud.example.com/remote.php/dav/files/henry/notes.md");
  assert.equal(url("Photos/"), "https://cloud.example.com/remote.php/dav/files/henry/Photos", "one trailing / (a folder) is dropped");
  // a "%2F" typed inside a name stays part of the name, it never becomes a separator
  assert.equal(url("a%2Fb/c.txt"), "https://cloud.example.com/remote.php/dav/files/henry/a%252Fb/c.txt");
  for (const bad of ["../secret.txt", "Documents/../../etc", "a/./b", "a//b", "/abs/path", "a\\b", "%2e%2e/x", "", "Docs/%2E/x"]) {
    assert.throws(() => url(bad), /argument_invalid|relative path|segment/u, JSON.stringify(bad));
  }
  // single-segment params keep refusing "/" (the user segment cannot climb)
  assert.throws(() => url("notes.md", "../admin"), /single segment/u);
  assert.throws(() => url("notes.md", "a/b"), /single segment/u);
});

test("0.6.2 WebDAV: PROPFIND reads (Depth at most 1), MKCOL/COPY create, MOVE is the destructive class; Destination stays under the user root; never overwrite", () => {
  const nc = app("nextcloud");
  const ops = compile(nc.spec, nc.labels).operations;
  const by = (method: string, path: string) => {
    const o = ops.find((x) => x.method === method && x.path === path);
    assert.ok(o, `${method} ${path}`);
    return o;
  };
  const FILE = "/remote.php/dav/files/{user}/{path}";
  const req = (op: CompiledOperation, header: Record<string, unknown> = {}, path: Record<string, unknown> = { user: "henry", path: "Docs/a b.txt" }) =>
    buildRequest({ baseUrl: "https://cloud.example.com/nc", basePath: nc.basePathOverride ?? "", op, args: { path, header }, auth: { type: "basic" }, credentials: { username: "u", password: "p" } });
  const h = (r: ReturnType<typeof buildRequest>) => r.init.headers as Record<string, string>;
  const propfind = by("propfind", FILE);
  assert.deepEqual([propfind.effect, propfind.crud], ["read", ["read"]]);
  assert.equal(req(propfind).init.method, "PROPFIND");
  assert.equal(h(req(propfind)).Depth, "1");
  assert.equal(h(req(propfind, { Depth: "infinity" })).Depth, "1", "no infinite listing");
  assert.equal(h(req(propfind, { Depth: "0" })).Depth, "0");
  assert.deepEqual(by("mkcol", FILE).crud, ["create"]);
  const copy = by("copy", FILE);
  assert.deepEqual([copy.effect, copy.crud], ["write", ["create"]]);
  const move = by("move", FILE);
  assert.deepEqual([move.effect, move.crud, move.holdFamily], ["destructive", ["update", "delete"], "destructive"]);
  for (const op of [copy, move]) {
    const r = req(op, { Destination: "Archive/2026/a b.txt", Overwrite: "T" });
    assert.equal(r.url.toString(), "https://cloud.example.com/nc/remote.php/dav/files/henry/Docs/a%20b.txt");
    assert.equal(h(r).Destination, "https://cloud.example.com/nc/remote.php/dav/files/henry/Archive/2026/a%20b.txt", "same origin, prefix and user root");
    assert.equal(h(r).Overwrite, "F", "never overwrite, even when the caller asks");
    assert.equal(r.init.method, op.method.toUpperCase());
    // a full URL is refused too ("https://" has an empty segment): the caller never names a host
    for (const bad of ["../other/x", "/abs", "Archive/../../x", "https://evil.example/x", "a\\b", ""]) {
      assert.throws(() => req(op, { Destination: bad }), /argument_invalid|relative path|segment|required/u, JSON.stringify(bad));
    }
    assert.throws(() => req(op, {}), /Destination is required/u);
    // the user in the Destination is the source's user (one segment, no climbing)
    assert.throws(() => req(op, { Destination: "x" }, { user: "../admin", path: "a" }), /single segment/u);
  }
  // trash restore keeps its default name under the trash root
  const restore = by("move", "/remote.php/dav/trashbin/{user}/trash/{item}");
  assert.equal(h(req(restore, {}, { user: "henry", item: "a.txt.d123" })).Destination, "https://cloud.example.com/nc/remote.php/dav/trashbin/henry/restore/restored");
});

test("CF-CT-1: plain application/json is preferred; else the first declared JSON type is sent; a non-JSON-only body stays unsupported", async () => {
  const { isJsonType } = await import("../src/sources/catalog/http.ts");
  for (const t of ["application/json", "application/merge-patch+json", "application/vnd.api+json", "application/ld+json; charset=utf-8"]) assert.ok(isJsonType(t), t);
  for (const t of ["text/json", "application/jsonx", "application/xml", "application/json-seq+x"]) assert.ok(!isJsonType(t), t);
  const spec = {
    openapi: "3.0.3",
    paths: {
      "/a/{id}": { patch: { operationId: "a", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/vnd.api+json": { schema: { type: "object" } }, "application/json": { schema: { type: "object" } } } } } },
      "/b/{id}": { patch: { operationId: "b", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/ld+json; charset=utf-8": { schema: { type: "object" } } } } } },
      "/c": { post: { operationId: "c", requestBody: { required: true, content: { "application/xml": { schema: { type: "object" } } } } } },
    },
  };
  const ops = Object.fromEntries(compile(spec).operations.map((o) => [o.operationId, o]));
  assert.equal(ops.a?.body?.contentType, "application/json");
  assert.equal(ops.b?.body?.contentType, "application/ld+json");
  assert.equal(ops.c, undefined, "an XML-only required body is not offered");
});
