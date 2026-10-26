/**
 * C368 (Connect 0.7.4): Postiz holds. Driven against the shipped catalog (test/fixtures/catalog).
 *  - the owner's card for create post (channel, type, date in the zone, text as text, images) and the generic card of every other tool;
 *  - the `__draft` variant: a plain write, usable ONLY for a new draft (type exactly "draft", no group, no id);
 *  - schedule / now / odd types / the status change stay on the base tool (outward, held);
 *  - a Rules hold on the base matches the variant (C354 contract);
 *  - C369: the technical details kept for "More details".
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import { type ConnectError, createConnectApp } from "../src/app.ts";
import { draftCheck, formatWhen, isPostizCreatePost, isPostizPostStatus, parseChannels, renderPostizPost } from "../src/postiz.ts";
import { catalogToolName } from "../src/sources/catalog/source.ts";
import { DRAFT_SUFFIX, splitVariant, ToolRegistry } from "../src/tools.ts";
import { fakeFetch, handlerOf, root, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const pinned = manifest.artifacts?.find((a) => a.id === "catalog");
assert.ok(pinned);
const gz = readFileSync(join(root, "test", "fixtures", "catalog", `tealbrick-catalog-${pinned.version}.json.gz`));
const BASE = "https://postiz.example.com";
const CREATE = catalogToolName("postiz", "PublicIntegrationsController_createPost");
const STATUS = catalogToolName("postiz", "PublicIntegrationsController_changePostStatus");
const LIST = catalogToolName("postiz", "PublicIntegrationsController_listIntegration");
const DRAFT = `${CREATE}${DRAFT_SUFFIX}`;

async function setup(options: { timeZone?: string; channels?: unknown } = {}) {
  const upstream = fakeFetch({
    "GET /api/public/v1/integrations": () =>
      options.channels === null
        ? { status: 500, body: { error: "down" } }
        : { body: options.channels ?? [{ id: "ch1", name: "Martin Puskas", identifier: "linkedin", picture: "x", disabled: false }, { id: "ch2", name: "puma", identifier: "x" }] },
    "POST /api/public/v1/posts": () => ({ body: [{ postId: "p1", integration: "ch1" }] }),
    "PUT /api/public/v1/posts/p1/status": () => ({ body: { ok: true } }),
  });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) =>
    String(input).startsWith("https://github.com/") ? new Response(gz) : upstream.impl(input, init)) as typeof fetch;
  const dataDir = mkdtempSync(join(tmpdir(), "connect-pz-"));
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), fetchImpl, dataDir, catalogAllowOrigins: [BASE], ...(options.timeZone ? { timeZone: options.timeZone } : {}) });
  const person = testCtx({ db, person: true });
  const out = (await handlerOf(app, "catalog_account_connect")({ service: "postiz", label: "Postiz", baseUrl: BASE, credentials: { token: "k" } }, person)) as { account: { id: string } };
  const agent = testCtx({ db, access: { [out.account.id]: "read_update_delete" } });
  const dyn = app.dynamic?.tools;
  assert.ok(dyn);
  const posted = () => upstream.calls.filter((c) => c.method === "POST" && c.url.pathname === "/api/public/v1/posts");
  return { app, db, dyn, agent, person, upstream, posted, done: () => rmSync(dataDir, { recursive: true, force: true }) };
}

const post = (extra: Record<string, unknown> = {}, value: Record<string, unknown> = {}) => ({
  integration: { id: "ch1" },
  value: [{ content: "<p>Hello <b>world</b> &amp; friends</p>", image: [], ...value }],
  settings: { __type: "linkedin" },
  ...extra,
});
const body = (extra: Record<string, unknown> = {}) => ({ type: "draft", date: "2026-11-03T13:30:00Z", shortLink: false, tags: [], posts: [post()], ...extra });

test("resolution: the base is outward and held; __draft is a plain write for create post only; status, list and unknown bases have no draft form", async () => {
  const s = await setup();
  try {
    const base = await s.dyn.resolve(CREATE, s.agent);
    assert.deepEqual([base?.effect, base?.holdFamily], ["outward", "outward"]);
    const draft = await s.dyn.resolve(DRAFT, s.agent);
    assert.deepEqual([draft?.tool, draft?.effect, draft?.crud, draft?.holdFamily], [DRAFT, "write", base?.crud, undefined]);
    const status = await s.dyn.resolve(STATUS, s.agent);
    assert.deepEqual([status?.effect, status?.holdFamily], ["outward", "outward"], "PUT /posts/{id}/status stays outward and held");
    assert.equal(await s.dyn.resolve(`${STATUS}${DRAFT_SUFFIX}`, s.agent), null);
    assert.equal(await s.dyn.resolve(`${LIST}${DRAFT_SUFFIX}`, s.agent), null);
    assert.equal(await s.dyn.resolve(`nope${DRAFT_SUFFIX}`, s.agent), null);
    // identified by the upstream operation, not by the hashed name
    const rows = new ToolRegistry(s.db).listService("catalog", "postiz");
    assert.ok(rows.some((r) => isPostizCreatePost(r) && r.name === CREATE));
    assert.ok(rows.some((r) => isPostizPostStatus(r) && r.name === STATUS));
    assert.equal(rows.filter(isPostizCreatePost).length, 1);
    assert.match(new ToolRegistry(s.db).get(CREATE)?.description ?? "", new RegExp(`call ${CREATE}__draft with body.type "draft"`, "u"), "the agent is told about the draft form");
  } finally {
    s.done();
  }
});

test("a Rules hold on the base matches the __draft variant (C354: x also matches x__<suffix>, never a prefix)", async () => {
  const s = await setup();
  try {
    const ruleMatches = (rule: string, tool: string) => tool === rule || tool.startsWith(`${rule}__`); // the C354 contract of the Rules engine
    assert.ok(ruleMatches(CREATE, DRAFT));
    assert.ok(!ruleMatches(CREATE, `${CREATE}x`));
    assert.deepEqual(splitVariant(DRAFT), { base: CREATE, variant: "draft" });
    assert.ok(!CREATE.includes("__"), "catalog names never contain __, so the variant suffix is unambiguous");
    assert.ok(!CREATE.endsWith("_"));
  } finally {
    s.done();
  }
});

test("draft: a new draft runs as a plain write and sends exactly the body it was given", async () => {
  const s = await setup();
  try {
    const args = { connect_account: "Postiz", body: body() };
    const out = (await s.dyn.call(DRAFT, args, s.agent)) as { data: unknown };
    assert.deepEqual(out.data, [{ postId: "p1", integration: "ch1" }]);
    assert.equal(s.posted().length, 1);
    assert.deepEqual(s.posted()[0]?.body, body());
    assert.ok(s.agent.receipts.summary.some((x) => x.endsWith("(draft)")));
  } finally {
    s.done();
  }
});

const REFUSED: [string, Record<string, unknown>][] = [
  ["type schedule", { body: body({ type: "schedule" }) }],
  ["type now", { body: body({ type: "now" }) }],
  ["type update", { body: body({ type: "update" }) }],
  ["type Draft (case)", { body: body({ type: "Draft" }) }],
  ["type draft with a space", { body: body({ type: "draft " }) }],
  ["type missing", { body: (({ type: _t, ...rest }) => rest)(body()) }],
  ["type not a string", { body: body({ type: ["draft"] }) }],
  ["no body", {}],
  ["body is a list", { body: [body()] }],
  ["an existing group on a post (Postiz would sweep every post of that group)", { body: body({ posts: [post({ group: "g-123" })] }) }],
  ["an empty group key", { body: body({ posts: [post({ group: "" })] }) }],
  ["an existing post id on a value (Postiz would rewrite that post and set it back to DRAFT)", { body: body({ posts: [post({}, { id: "existing-post-id" })] }) }],
  ["a second value with an id", { body: body({ posts: [{ ...post(), value: [{ content: "a" }, { content: "b", id: "x" }] }] }) }],
  ["republish at the top", { body: body({ republish: true }) }],
  ["inter at the top", { body: body({ inter: 7 }) }],
  ["an id at the top", { body: body({ id: "p1" }) }],
  ["a post type", { body: body({ posts: [post({ type: "schedule" })] }) }],
  ["an unknown post field", { body: body({ posts: [post({ parentPostId: "p0" })] }) }],
  ["an integration with more than its id", { body: body({ posts: [{ ...post(), integration: { id: "ch1", group: "g" } }] }) }],
  ["no posts", { body: body({ posts: [] }) }],
  ["no value", { body: body({ posts: [{ integration: { id: "ch1" }, value: [] }] }) }],
  ["a query argument beside the body", { body: body(), query: { id: "p1" } }],
  ["a path argument beside the body", { body: body(), path: { id: "p1" } }],
];
for (const [name, args] of REFUSED) {
  test(`draft form refuses (nothing sent): ${name}`, async () => {
    const s = await setup();
    try {
      await assert.rejects(s.dyn.call(DRAFT, args, s.agent), (e: ConnectError) => {
        assert.equal(e.code, "draft_not_plain");
        assert.equal((e.details as { tool: string }).tool, CREATE, "the answer names the held tool");
        return true;
      });
      assert.equal(s.posted().length, 0, "no request reached Postiz");
      assert.equal(draftCheck(args).ok, false);
    } finally {
      s.done();
    }
  });
}

test("the base tool is unchanged: schedule and now run on the base name (the SDK holds them as outward); the draft form is not needed for them", async () => {
  const s = await setup();
  try {
    await s.dyn.call(CREATE, { body: body({ type: "schedule" }) }, s.agent);
    assert.equal(s.posted().length, 1);
    const status = await s.dyn.resolve(STATUS, s.agent);
    assert.equal(status?.holdFamily, "outward");
  } finally {
    s.done();
  }
});

test("card: channel name and provider, type, date in the zone, text as plain text, image count", async () => {
  const s = await setup({ timeZone: "Europe/Vienna" });
  try {
    const args = { connect_account: "Postiz", body: body({ type: "schedule", posts: [post({}, { image: [{ id: "i1", path: "https://x/1.png" }, { id: "i2", path: "https://x/2.png" }] })], tags: [{ value: "t", label: "launch" }] }) };
    const out = await s.dyn.holdView?.(CREATE, args, s.agent);
    const view = out?.view ?? "";
    assert.match(view, /^Create a Postiz post\nAccount: Postiz\nType: SCHEDULED \(Postiz publishes it at the date below\)\n/u);
    assert.match(view, /When: Tue,? 3 Nov 2026,? 14:30 (CET|GMT\+1) \(2026-11-03 13:30 UTC\)/u);
    assert.match(view, /Tags: launch/u);
    assert.match(view, /Posts: 1\nImages: 2\n/u);
    assert.match(view, /Post\n {2}Channel: LinkedIn · Martin Puskas\n {2}Images: 2\n {2}Text \(plain text\):\n {4}Hello world & friends$/u);
    assert.doesNotMatch(view, /[<>{}]|"type"/u, "no HTML and no JSON on the card");
    assert.equal(out?.summary, "Postiz post, SCHEDULED, to LinkedIn, 2026-11-03 13:30 UTC");
    // the same input in another key order gives the same text (the approval is bound to it)
    const again = await s.dyn.holdView?.(CREATE, { body: { posts: args.body.posts, tags: args.body.tags, date: args.body.date, shortLink: false, type: "schedule" }, connect_account: "Postiz" }, s.agent);
    assert.equal(again?.view, view);
  } finally {
    s.done();
  }
});

test("card: DRAFT and NOW labels, several channels, thread replies, an unknown channel id, an unknown type, a missing type", async () => {
  const s = await setup();
  try {
    const draft = (await s.dyn.holdView?.(DRAFT, { body: body({ posts: [post(), post({ integration: { id: "ch2" }, settings: { __type: "x" } }), post({ integration: { id: "zzz" } })] }) }, s.agent))?.view ?? "";
    assert.match(draft, /^Create a Postiz post \(draft form\)\n/u);
    assert.match(draft, /Type: DRAFT \(saved in Postiz, not published\)/u);
    assert.match(draft, /Date on the draft: Tue,? 3 Nov 2026,? 13:30 UTC/u);
    assert.match(draft, /Post 1 of 3\n {2}Channel: LinkedIn · Martin Puskas/u);
    assert.match(draft, /Post 2 of 3\n {2}Channel: X · puma/u);
    assert.match(draft, /Post 3 of 3\n {2}Channel: LinkedIn · channel id zzz \(not in the Postiz channel list\)/u);
    const now = (await s.dyn.holdView?.(CREATE, { body: { type: "now", posts: [{ integration: { id: "ch1" }, value: [{ content: "one" }, { content: "two" }] }] } }, s.agent))?.view ?? "";
    assert.match(now, /Type: NOW \(Postiz publishes it straight away\)\nWhen: straight away/u);
    assert.match(now, /Text \(plain text\):\n {4}one\n {2}Reply 1 in the thread \(plain text\):\n {4}two/u);
    const odd = (await s.dyn.holdView?.(CREATE, { body: { type: "publish-now-please", posts: [post()] } }, s.agent))?.view ?? "";
    assert.match(odd, /Type: UNKNOWN: "publish-now-please" \(Connect does not know this type\)/u);
    const none = (await s.dyn.holdView?.(CREATE, { body: { posts: [post()] } }, s.agent))?.view ?? "";
    assert.match(none, /Type: NOT GIVEN/u);
    assert.match(none, /When: no date given/u);
  } finally {
    s.done();
  }
});

test("card: when the channel list cannot be read the card shows the id and the provider from the settings, not an error", async () => {
  const s = await setup({ channels: null });
  try {
    const view = (await s.dyn.holdView?.(CREATE, { body: body({ type: "schedule" }) }, s.agent))?.view ?? "";
    assert.match(view, /Channel: LinkedIn · channel id ch1\n/u);
    assert.doesNotMatch(view, /not in the Postiz channel list/u, "the list was not read, so it is not claimed to lack the channel");
  } finally {
    s.done();
  }
});

test("card: long post text is cut with a count; the whole view stays under the SDK limit", async () => {
  const s = await setup();
  try {
    const long = "x".repeat(5000);
    const view = (await s.dyn.holdView?.(CREATE, { body: body({ posts: Array.from({ length: 12 }, () => post({}, { content: long })) }) }, s.agent))?.view ?? "";
    assert.match(view, /first 1200 characters; 3800 more not shown/u);
    assert.match(view, /\(and 2 more posts not shown\)/u);
    assert.ok(view.length <= 16_000, String(view.length));
  } finally {
    s.done();
  }
});

test("generic fallback: every other dynamic tool shows its title, account and labelled lines, long text as text, no JSON", async () => {
  const s = await setup();
  try {
    const out = await s.dyn.holdView?.(STATUS, { path: { id: "p1" }, body: { status: "draft", note: "<p>Line one</p><p>Line two is a very long note that goes past one hundred characters so that it is shown as a block of text.</p>", tags: ["a", "b"], deep: { ok: true, n: 3, none: null } } }, s.agent);
    const view = out?.view ?? "";
    assert.match(view, /^.+ \(postiz\)\nAccount: Postiz\n\n/u);
    assert.match(view, /\nBody › Deep › N: 3\n/u);
    assert.match(view, /\nBody › Deep › Ok: yes\n/u);
    assert.match(view, /\nBody › Deep › None: \(empty\)\n/u);
    assert.match(view, /\nBody › Status: draft\n/u);
    assert.match(view, /\nBody › Tags: a, b\n/u);
    assert.match(view, /\nBody › Note \(plain text\):\n {2}Line one\n {2}Line two is a very long note/u);
    assert.match(view, /\nPath › Id: p1$/u);
    assert.doesNotMatch(view, /[<>{}[\]"]/u, "no JSON, no HTML");
    assert.ok((out?.summary ?? "").length <= 280);
    assert.equal((await s.dyn.holdView?.(LIST, {}, s.agent))?.view.endsWith("No arguments."), true);
    // many fields: bounded, with a count
    const many = Object.fromEntries(Array.from({ length: 90 }, (_, i) => [`field_${String(i).padStart(2, "0")}`, i]));
    const big = (await s.dyn.holdView?.(STATUS, { body: many }, s.agent))?.view ?? "";
    assert.match(big, /\(and 30 more fields not shown; see More details\)$/u);
  } finally {
    s.done();
  }
});

test("C369: the details behind a card (tool, upstream operation, account, arguments) are kept for the owner only, under the hash of the hold text", async () => {
  const s = await setup();
  try {
    const args = { connect_account: "Postiz", body: body({ type: "schedule" }) };
    const out = await s.dyn.holdView?.(CREATE, args, s.agent);
    const sha = `sha256:${createHash("sha256").update(out?.view ?? "", "utf8").digest("hex")}`;
    const op = handlerOf(s.app, "hold_details");
    const got = (await op({ viewSha256: sha }, s.person)) as unknown as { found: boolean; details: { tool: string; method: string; path: string; upstream: string; account: { label: string }; arguments: string } };
    assert.equal(got.found, true);
    assert.deepEqual([got.details.tool, got.details.method, got.details.path, got.details.upstream, got.details.account.label], [CREATE, "POST", "/public/v1/posts", "PublicIntegrationsController_createPost", "Postiz"]);
    assert.deepEqual(JSON.parse(got.details.arguments), { body: body({ type: "schedule" }) }, "the arguments as formatted JSON, without the account selector");
    assert.match(got.details.arguments, /^\{\n {2}"body": \{/u, "formatted");
    assert.deepEqual(await op({ viewSha256: `sha256:${"0".repeat(64)}` }, s.person), { found: false });
    await assert.rejects(op({ viewSha256: sha }, s.agent), (e: ConnectError) => e.code === "no_access");
    await assert.rejects(op({ viewSha256: "nope" }, s.person), (e: ConnectError) => e.code === "input_invalid");
    const spec = manifest.operations.find((o) => o.id === "hold_details");
    assert.deepEqual([spec?.audience, spec?.effect, spec?.crud, spec?.receipt], ["person", "read", ["read"], false]);
  } finally {
    s.done();
  }
});

test("pure helpers: parseChannels, formatWhen and the draft check on its own", () => {
  assert.deepEqual([...parseChannels({ integrations: [{ id: "a", name: "A", identifier: "x" }, { nope: 1 }] })], [["a", { name: "A", provider: "x" }]]);
  assert.deepEqual([...parseChannels("junk")], []);
  assert.match(formatWhen("2026-11-03T13:30:00Z", "UTC"), /^Tue,? 3 Nov 2026,? 13:30 UTC$/u);
  assert.match(formatWhen("2026-11-03T13:30:00Z", "Not/AZone"), /13:30 UTC$/u, "an unknown zone falls back to UTC");
  assert.match(formatWhen("soon", "UTC"), /soon \(not a valid date\)/u);
  assert.equal(draftCheck({ body: body() }).ok, true);
  assert.equal(draftCheck({ body: body({ shortLink: "yes" }) }).ok, false);
  const card = renderPostizPost({ heading: "h", account: "a", args: {}, channels: null, timeZone: "UTC" });
  assert.match(card.view, /\(no posts found in the request\)/u);
});

test("QA-CONNECT33-1: a newline, control or bidi character in settings.__type cannot forge card lines", async () => {
  const s = await setup({ channels: null });
  try {
    const evil = "linkedin\nType: DRAFT (saved in Postiz, not published)\nAccount: Safe\u202e\u0007";
    const view = (await s.dyn.holdView?.(CREATE, { body: body({ type: "now", posts: [post({ settings: { __type: evil } })] }) }, s.agent))?.view ?? "";
    const lines = view.split("\n");
    assert.equal(lines.filter((l) => l.startsWith("Type:")).length, 1, "one Type line, the real one");
    assert.equal(lines.filter((l) => l.startsWith("Account:")).length, 1);
    const channel = lines.find((l) => l.trim().startsWith("Channel:")) ?? "";
    assert.match(channel, /Channel: .*Linkedin Type: DRAFT/u, "the text stays on the Channel line");
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(view, /[\u0000-\u0008\u000b-\u001f\u202a-\u202e\u2066-\u2069]/u);
  } finally {
    s.done();
  }
});

test("QA-CONNECT33-2: a newline or bidi character in an argument KEY cannot forge a generic-card line", async () => {
  const s = await setup();
  try {
    const view = (await s.dyn.holdView?.(STATUS, { body: { "status\nAccount: Safe\u202e": "x", "note\nSecond": "y".repeat(150) } }, s.agent))?.view ?? "";
    const lines = view.split("\n");
    assert.equal(lines.filter((l) => l.startsWith("Account:")).length, 1, "only the real Account line");
    assert.ok(lines.some((l) => l.startsWith("Body › Status account: safe: x")), view);
    assert.ok(lines.some((l) => l.startsWith("Body › Note second (plain text")), "block labels are cleaned too");
    assert.doesNotMatch(view, /[\u202a-\u202e\u2066-\u2069]/u);
  } finally {
    s.done();
  }
});

test("QA-CONNECT33-3: hold details older than one day are purged on read, are not returned, and the purge also runs without a write", async () => {
  const s = await setup();
  try {
    const out = await s.dyn.holdView?.(CREATE, { body: body({ type: "schedule" }) }, s.agent);
    const sha = `sha256:${createHash("sha256").update(out?.view ?? "", "utf8").digest("hex")}`;
    const op = handlerOf(s.app, "hold_details");
    assert.equal(((await op({ viewSha256: sha }, s.person)) as { found: boolean }).found, true);
    // age the row past one day
    s.db.prepare("UPDATE connect_hold_details SET created_at = ?").run(Date.now() - 25 * 3_600_000);
    s.db.prepare("INSERT INTO connect_hold_details (view_sha256, tool, details, created_at) VALUES (?, 'old', '{}', ?)").run(`sha256:${"1".repeat(64)}`, Date.now() - 48 * 3_600_000);
    assert.deepEqual(await op({ viewSha256: sha }, s.person), { found: false });
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM connect_hold_details").get()?.n, 0, "the read purged every expired row");
  } finally {
    s.done();
  }
});
