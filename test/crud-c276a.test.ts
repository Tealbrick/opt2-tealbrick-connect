/**
 * C276a: per-method CRUD for catalog ops and per-verb CRUD for Composio / MCP names, with the guardrails (a)–(e), and the
 * start-time re-sync that brings the new classes to accounts connected before the update.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { AccountStore } from "../src/accounts.ts";
import { classify, classifyMcpTool, crudFromName, isSendTool, narrowByName, type ToolClass, withCrud } from "../src/effect.ts";
import { catalogCrud, compile } from "../src/sources/catalog/openapi.ts";
import { parseBundle } from "../src/sources/catalog/source.ts";
import { type ComposioPolicy, classifyComposioTool, loadPolicies } from "../src/sources/composio/policy.ts";
import { resyncToolClasses, storedMarker, toolClassMarker } from "../src/tool-resync.ts";
import { root, testDb } from "./helpers.ts";

const WRITE = classify({ write: true, outward: false, destructive: false });
const OUTWARD = classify({ write: true, outward: true, destructive: false });
const DESTRUCTIVE = classify({ write: true, outward: false, destructive: true });
const READ = classify({ write: false, outward: false, destructive: false });
const MONEY = classify({ write: true, outward: true, destructive: false, money: true });

test("catalog: POST on a listed collection → [create]; PUT/PATCH → [update]; DELETE → [delete]; GET untouched", () => {
  assert.deepEqual(catalogCrud("post", "/api/v2/contacts", undefined, true), ["create"]);
  assert.deepEqual(catalogCrud("put", "/api/v2/contacts/{id}", undefined), ["update"]);
  assert.deepEqual(catalogCrud("patch", "/api/contacts/{id}/edit", undefined), ["update"]);
  assert.deepEqual(catalogCrud("delete", "/api/v2/contacts/{id}", undefined), ["delete"]);
  assert.equal(catalogCrud("get", "/api/v2/contacts", undefined, true), null);
});

test("guardrail (a): POST on an item path, with an action word, or on a path with no GET stays [create, update]", () => {
  assert.equal(catalogCrud("post", "/campaigns/{id}", undefined, true), null);
  assert.equal(catalogCrud("post", "/api/contacts/{id}/points/plus/{delta}", undefined, true), null);
  for (const action of ["send", "publish", "status", "cancel", "add", "graphql", "toggle_status", "bulk_create", "reset_secret", "clone"]) {
    assert.equal(catalogCrud("post", `/api/things/{id}/${action}`, undefined, true), null, action);
    assert.equal(catalogCrud("post", `/api/${action}`, undefined, true), null, action);
  }
  // RPC-style actions whose verb Connect does not know: no GET on the path, so not a collection.
  for (const path of ["/api/tx", "/orders/{code}/redeem/", "/invoices/{n}/transmit/", "/shares/{id}/unshare"]) assert.equal(catalogCrud("post", path, undefined, false), null, path);
  assert.equal(catalogCrud("post", "/api/subscribers", undefined, false), null);
});

test("guardrail (b): an explicit x-tealbrick-crud wins when valid; an invalid one is ignored", () => {
  assert.deepEqual(catalogCrud("post", "/api/tx", ["create"]), ["create"]);
  assert.deepEqual(catalogCrud("post", "/a", ["update", "update"]), ["update"]);
  assert.deepEqual(catalogCrud("post", "/a", ["read"], true), ["create"]);
  assert.deepEqual(catalogCrud("post", "/a", [], true), ["create"]);
  const spec = {
    openapi: "3.0.3",
    paths: {
      "/tx": { post: { operationId: "tx", "x-tealbrick-crud": ["create"] } },
      "/items/{id}": { delete: { operationId: "del", "x-tealbrick-crud": ["update"] } },
    },
  };
  const ops = Object.fromEntries(compile(spec, { outward: ["tx"] }).operations.map((o) => [o.operationId, o]));
  assert.deepEqual([ops.tx?.crud, ops.tx?.effect, ops.tx?.holdFamily], [["create"], "outward", "outward"]);
  // A destructive op keeps delete whatever the override says (M-OP-3).
  assert.deepEqual([ops.del?.crud, ops.del?.effect], [["update", "delete"], "destructive"]);
});

test("guardrail (c): read and money never change; destructive keeps delete; a non-destructive class never needs delete; effect and family stay", () => {
  assert.deepEqual(withCrud(READ, ["create"]), READ);
  assert.deepEqual(withCrud(MONEY, ["create"]), MONEY);
  assert.deepEqual(withCrud(DESTRUCTIVE, ["update"]), DESTRUCTIVE);
  assert.deepEqual(withCrud(DESTRUCTIVE, ["delete"]), { ...DESTRUCTIVE, crud: ["delete"] });
  assert.deepEqual(withCrud(WRITE, ["delete"]), WRITE);
  assert.deepEqual(withCrud(OUTWARD, ["create"]), { crud: ["create"], effect: "outward", holdFamily: "outward" });
  assert.deepEqual(withCrud(WRITE, null), WRITE);
  assert.deepEqual(withCrud(WRITE, ["update", "create"]), { ...WRITE, crud: ["create", "update"] });
});

test("guardrail (d): names — CREATE/ADD/INSERT → create, UPDATE/SET/PATCH/EDIT → update, DELETE/REMOVE → delete, SEND/POST/PUBLISH and unknown → [create, update]", () => {
  for (const name of ["GITHUB_CREATE_ISSUE", "TRELLO_ADD_CARD", "SHEETS_INSERT_ROW", "createRecord"]) assert.deepEqual(crudFromName(name), ["create"], name);
  for (const name of ["NOTION_UPDATE_PAGE", "SLACK_SET_TOPIC", "NOTION_PATCH_BLOCK", "edit_file"]) assert.deepEqual(crudFromName(name), ["update"], name);
  for (const name of ["NOTION_DELETE_BLOCK", "remove_item", "deleteRow"]) assert.deepEqual(crudFromName(name), ["delete"], name);
  for (const name of ["GMAIL_SEND_EMAIL", "SLACK_POST_MESSAGE", "WORDPRESS_PUBLISH", "do_the_thing", "CREATE_AND_SEND", "TOGGLE_X"]) assert.equal(crudFromName(name), null, name);
  // Read verbs do not count.
  assert.deepEqual(crudFromName("GET_OR_CREATE_CONTACT"), ["create"]);
  assert.deepEqual(crudFromName("CREATE_OR_UPDATE_FILE"), ["create", "update"]);
});

test("review #17: sensitive objects, people-reaching nouns, negated verbs and look-alike letters are never narrowed", () => {
  for (const name of [
    "create_message", "add_comment", "create_email", "create_dm", "add_sms", "update_and_sms", "set_and_schedule", "update_and_call",
    "create_invitation", "create_notification", "create_alert", "ADD_MEMBER", "addCollaborator", "SET_PERMISSIONS", "create_user",
    "add_role", "create_api_token", "set_password", "create_and_unshare", "set_and_unassign", "update_and_unlink", "create_dеlete",
    "GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_DELETE_MESSAGE", "import_contacts", "create_webhook",
    "add_attendee", "add_recipient", "create_deployment",
    "GOOGLECALENDAR_CREATE_EVENT", "GOOGLECALENDAR_UPDATE_EVENT", "GOOGLECALENDAR_PATCH_EVENT", "GOOGLECALENDAR_QUICK_ADD",
    "create_meeting", "book_appointment", "createBooking",
  ]) {
    assert.equal(crudFromName(name), null, name);
  }
  // An outward class whose name holds any outward word keeps its set.
  assert.deepEqual(narrowByName("create_post", OUTWARD), OUTWARD);
  // Subset rule: a destructive ADD_AND_REMOVE never needs create where [update, delete] did not.
  assert.deepEqual(narrowByName("ADD_AND_REMOVE_THINGS", DESTRUCTIVE), DESTRUCTIVE);
  assert.deepEqual(withCrud(DESTRUCTIVE, ["create", "delete"]), DESTRUCTIVE);
  assert.deepEqual(withCrud(WRITE, ["update"]), { ...WRITE, crud: ["update"] });
});

test("review #17: catalog paths naming access, identity, secrets or imports, and operationIds with another verb, keep [create, update]", () => {
  const keep: [string, string, string, boolean][] = [
    ["post", "/repos/{owner}/{repo}/contents", "repoChangeFiles", true],
    ["post", "/api/import/subscribers", "importSubscribers", true],
    ["post", "/api/0/generate-recovery-codes/", "", true],
    ["post", "/organizers/{o}/bankimportjobs/", "", true],
    ["post", "/oauth/authorize", "", true],
    ["post", "/apps/dashboard/api/v3/layout", "updateLayout", true],
    ["post", "/accounts/{a}/contacts/{id}/labels", "", true],
    ["post", "/accounts/{a}/conversations/{c}/messages", "", true],
    ["post", "/organizers/{o}/teams/{t}/invites/", "", true],
    ["post", "/apps/files_sharing/api/v1/shares", "", true],
    ["post", "/organizations/{o}/members/", "", true],
    ["post", "/cloud/groups", "", true],
    ["post", "/cloud/users/{id}/subadmins", "", true],
    ["post", "/organizers/{o}/giftcards/", "", true],
    ["post", "/repos/{o}/{r}/push_mirrors", "", true],
    ["post", "/events/{e}/sendmail_rules/", "", true],
    ["patch", "/events/{e}/sendmail_rules/{id}/", "", false],
    ["patch", "/rbac/permissions/assigned_by_roles/{uuid}/unassign/", "", false],
    ["put", "/core/transactional/applications/", "", false],
    ["put", "/api/profile", "", false],
    ["patch", "/repos/{o}/{r}/hooks/{id}", "", false],
    ["put", "/things/{id}", "createOrReplaceThing", false],
  ];
  for (const [method, path, operationId, lists] of keep) assert.equal(catalogCrud(method as "post", path, undefined, lists, operationId), null, `${method} ${path}`);
  assert.deepEqual(catalogCrud("post", "/public/v1/posts", undefined, true, "PublicIntegrationsController_createPost"), ["create"]);
  assert.deepEqual(catalogCrud("patch", "/events/{event}/", undefined, false, "events_partial_update"), ["update"]);
});

test("review #17: identity-provider apps (Authentik) keep the full set for every write", () => {
  const authentik = classes("authentik");
  for (const [id, cls] of Object.entries(authentik)) {
    if (cls.effect === "read" || cls.effect === "money") continue;
    assert.deepEqual(cls.crud, cls.effect === "destructive" ? ["update", "delete"] : ["create", "update"], id);
  }
});

test("Composio + MCP: the policy / annotations decide the effect, the name narrows the CRUD only when safe", () => {
  const policy: ComposioPolicy = { schema: 1, toolkit: "gmail", version: "1", destructive: ["GMAIL_DELETE_*"], outward: ["GMAIL_SEND_*"], writes: ["GMAIL_*_LABEL*", "GMAIL_CREATE_*"], reads: [] };
  assert.deepEqual(classifyComposioTool("GMAIL_DELETE_DRAFT_FOLDER", policy), { ...DESTRUCTIVE, crud: ["delete"] });
  assert.deepEqual(classifyComposioTool("GMAIL_DELETE_MESSAGE", policy), DESTRUCTIVE);
  assert.deepEqual(classifyComposioTool("GMAIL_SEND_EMAIL", policy), OUTWARD);
  assert.deepEqual(classifyComposioTool("GMAIL_CREATE_EMAIL_DRAFT", policy), WRITE);
  assert.deepEqual(classifyComposioTool("GMAIL_CREATE_FILTER_RULE", policy), { ...WRITE, crud: ["create"] });
  // REMOVE that the policy calls a write (not destructive) keeps [create, update]: never tighter than before by surprise.
  assert.deepEqual(classifyComposioTool("GMAIL_REMOVE_LABEL", policy), WRITE);
  assert.deepEqual(classifyComposioTool("GMAIL_LIST_LABELS", policy), READ);
  assert.equal(classifyComposioTool("STRIPE_CREATE_PAYMENT", policy).effect, "money");
  assert.deepEqual(classifyComposioTool("STRIPE_CREATE_PAYMENT", policy).crud, MONEY.crud);
  assert.deepEqual(classifyComposioTool("NOTION_UPDATE_PAGE", undefined), { ...WRITE, crud: ["update"] });
  assert.deepEqual(classifyMcpTool("create_issue", undefined), { ...WRITE, crud: ["create"] });
  assert.deepEqual(classifyMcpTool("delete_repo", undefined), { ...DESTRUCTIVE, crud: ["delete"] });
  assert.deepEqual(classifyMcpTool("send_message", undefined), OUTWARD);
  assert.deepEqual(classifyMcpTool("add_thing", { destructiveHint: true }), DESTRUCTIVE);
  assert.deepEqual(classifyMcpTool("list_things", { readOnlyHint: true }), READ);
});

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as { artifacts: { id: string; version: string; sha256: string }[] };
const pinned = manifest.artifacts.find((a) => a.id === "catalog");
assert.ok(pinned);
const apps = parseBundle(readFileSync(join(root, "test", "fixtures", "catalog", `tealbrick-catalog-${pinned.version}.json.gz`)), pinned.sha256);
const classes = (id: string) => {
  const app = apps.find((a) => a.id === id);
  assert.ok(app, id);
  return Object.fromEntries(compile(app.spec, app.labels).operations.map((o) => [`${o.method.toUpperCase()} ${o.path}`, o as ToolClass]));
};

test("shipped catalog: a Create grant can create a Postiz post or a Mautic contact; sends and actions still need Update", () => {
  const postiz = classes("postiz");
  const post = postiz["POST /public/v1/posts"];
  assert.deepEqual([post?.crud, post?.effect, post?.holdFamily], [["create"], "outward", "outward"]);
  assert.deepEqual(postiz["PUT /public/v1/posts/{id}/status"]?.crud, ["create", "update"], "status changes keep the full set");
  assert.deepEqual(postiz["DELETE /public/v1/posts/{id}"]?.crud, ["delete"]);
  const mautic = classes("mautic");
  assert.deepEqual(mautic["POST /api/v2/contacts"]?.crud, ["create"]);
  assert.deepEqual(mautic["POST /api/emails/{id}/send"]?.crud, ["create", "update"]);
  assert.deepEqual(mautic["POST /api/segments/{id}/contacts/add"]?.crud, ["create", "update"]);
  assert.deepEqual(mautic["PATCH /api/contacts/{id}/edit"]?.crud, ["update"]);
  assert.deepEqual(classes("listmonk")["POST /api/tx"]?.crud, ["create", "update"]);
  assert.deepEqual(classes("pretix")["POST /api/v1/organizers/{organizer}/events/"]?.crud, ["create"]);
});

test("guardrail (e): every op of the packed catalog has the reviewed class (snapshot; regenerate and review on any change)", () => {
  const snapshot = JSON.parse(readFileSync(join(root, "test", "fixtures", "catalog", `classes-${pinned.version}.json`), "utf8")) as Record<string, Record<string, string>>;
  for (const app of apps) {
    const now = Object.fromEntries(
      compile(app.spec, app.labels).operations.map((o) => [`${o.method.toUpperCase()} ${o.path}`, [o.crud.join("+"), o.effect, o.holdFamily ?? "-"].join(" ")]),
    );
    assert.deepEqual(now, snapshot[app.id], app.id);
  }
  assert.deepEqual(Object.keys(snapshot).sort(), apps.map((a) => a.id).sort());
});

test("re-sync on start: accounts connected before the update get new tool rows once; a failure retries at the next start", async () => {
  const db = testDb();
  const accounts = new AccountStore(db);
  const make = (service: string, source: "catalog" | "composio" | "mcp" | "channel") =>
    accounts.create({ service, source, kind: "as_me", label: service, ownerAgent: null, externalRef: "https://x.example.com", status: "connected" });
  make("postiz", "catalog");
  make("postiz", "catalog");
  make("gmail", "composio");
  const server = make("mcp-a", "mcp");
  make("slack", "channel");
  const calls: string[] = [];
  let failComposio = true;
  const sources = {
    accounts,
    catalog: { syncTools: async (s: string) => (calls.push(`catalog:${s}`), 1) },
    composio: {
      syncTools: async (s: string) => {
        calls.push(`composio:${s}`);
        if (failComposio) throw Object.assign(new Error("down"), { code: "upstream_unreachable" });
        return 1;
      },
    },
    mcp: { syncTools: async (a: { id: string }) => (calls.push(`mcp:${a.id}`), 1) },
  };
  const marker = toolClassMarker(pinned.version);
  const first = await resyncToolClasses(db, sources, marker);
  assert.deepEqual(calls.sort(), ["catalog:postiz", "composio:gmail", `mcp:${server.id}`].sort());
  assert.deepEqual(first.failed, ["composio:gmail"]);
  assert.equal(storedMarker(db), null, "no marker while a service failed");
  failComposio = false;
  calls.length = 0;
  await resyncToolClasses(db, sources, marker);
  assert.equal(calls.length, 3);
  assert.equal(storedMarker(db), marker);
  calls.length = 0;
  await resyncToolClasses(db, sources, marker);
  assert.deepEqual(calls, [], "same marker: nothing to do");
  await resyncToolClasses(db, sources, toolClassMarker("9.9.9"));
  assert.equal(calls.length, 3, "a new catalog version re-syncs again");
});

test("re-sync: a catalog app that left the catalog does not block the marker; a policy edit changes the marker", async () => {
  const db = testDb();
  const accounts = new AccountStore(db);
  accounts.create({ service: "gone", source: "catalog", kind: "as_me", label: "gone", ownerAgent: null, externalRef: "https://x.example.com", status: "connected" });
  const sources = {
    accounts,
    catalog: {
      syncTools: async () => {
        throw Object.assign(new Error("unknown"), { code: "catalog_app_unknown" });
      },
    },
    composio: { syncTools: async () => 0 },
    mcp: { syncTools: async () => 0 },
  };
  const marker = toolClassMarker("0.2.0", "aaaa");
  assert.deepEqual((await resyncToolClasses(db, sources, marker)).failed, []);
  assert.equal(storedMarker(db), marker);
  assert.notEqual(toolClassMarker("0.2.0", "bbbb"), marker);
});

test("Coordinator 2026-10-20: calendar event tools keep [create, update]; since CF-GC-1 they are send tools (first contact)", () => {
  const policies = loadPolicies(join(root, "policies", "composio"));
  for (const slug of ["GOOGLECALENDAR_CREATE_EVENT", "GOOGLECALENDAR_UPDATE_EVENT", "GOOGLECALENDAR_PATCH_EVENT", "GOOGLECALENDAR_QUICK_ADD"]) {
    const cls = classifyComposioTool(slug, policies.get("googlecalendar"));
    assert.equal(cls.effect, "outward", slug);
    assert.equal(isSendTool({ name: slug.toLowerCase(), upstream: slug, effect: cls.effect }), true, `${slug}: first-contact check (CF-GC-1)`);
    assert.deepEqual(cls.crud, ["create", "update"], slug);
  }
});
