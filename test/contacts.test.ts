/**
 * G-5 (C373): `contacts_list`, the companion-only contacts list for Governance (`fleet`). Fire on bad callers (agent, person,
 * another app, an unverified app, a delisted instance), paging, no content fields; quiet on the good caller.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { opInGrantWorkflow, opVisibleToGrant, validateCompanions } from "@opt2-tealbrick/manifest";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Json } from "@opt2-tealbrick/spec/sdk";

import { AccountStore } from "../src/accounts.ts";
import { type ConnectError, createConnectApp } from "../src/app.ts";
import { WORKSPACE_SENDER } from "../src/channels/buzz/identity.ts";
import { npubEncode } from "../src/channels/buzz/nostr.ts";
import { CONTACTS_PAGE } from "../src/contacts.ts";
import { handlerOf, root, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const A = "agt_01CONTACTAGENTA0000000000000";
const B = "agt_01CONTACTAGENTB0000000000000";
const FLEET = "ins_01FLEETAPP000000000000000000";
const OTHER = "ins_01OTHERAPP000000000000000000";
const HEX = "a".repeat(64);
const HEX2 = "b".repeat(64);
/** Strings that must never reach the output: conversation ids, the Buzz DM channel, account ids. */
const SECRET_CONVERSATION = "D-SECRET-CONVERSATION";
const SECRET_DM_CHANNEL = "5a7d6c2e-secret-dm-channel";

type Row = { agent: string | null; channel: string; handle: string; account?: string; firstContactAt: number };
type Page = { contacts: Row[]; nextCursor: string | null };
const isCode = (code: string, status?: number) => (e: ConnectError) => e.code === code && (status === undefined || e.httpStatus === status);

function setup() {
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations") });
  const accounts = new AccountStore(db);
  const slackA = accounts.create({ service: "slack", source: "channel", kind: "as_itself", label: "A bot", ownerAgent: A, externalRef: null, status: "connected" });
  const telegramShared = accounts.create({ service: "telegram", source: "channel", kind: "as_me", label: "Workspace bot", ownerAgent: null, externalRef: null, status: "connected" });
  const gmail = accounts.create({ service: "gmail", source: "composio", kind: "as_me", label: "Work Gmail", ownerAgent: null, externalRef: null, status: "connected" });
  const buzz = db.prepare("INSERT INTO connect_buzz_contacts (agent, pubkey, channel, first_sent_at) VALUES (?, ?, ?, ?)");
  buzz.run(A, HEX, SECRET_DM_CHANNEL, 1_000);
  buzz.run(WORKSPACE_SENDER, HEX2, SECRET_DM_CHANNEL, 2_000);
  const chat = db.prepare("INSERT INTO connect_channel_contacts (account_id, person_id, conversation, first_sent_at) VALUES (?, ?, ?, ?)");
  chat.run(slackA.id, "u0person1", SECRET_CONVERSATION, 3_000);
  chat.run(telegramShared.id, "123456789", SECRET_CONVERSATION, 4_000);
  const tool = db.prepare("INSERT INTO connect_tool_contacts (caller, account, address, first_sent_at) VALUES (?, ?, ?, ?)");
  tool.run(B, gmail.id, "ana@example.com", 5_000);
  tool.run(OTHER, gmail.id, "bob@example.com", 6_000);
  const fleet = (extra: { appListed?: boolean } = {}) => testCtx({ db, app: FLEET, appProduct: "fleet", appListed: true, ...extra });
  const run = (input: Json, ctx = fleet()) => handlerOf(app, "contacts_list")(input, ctx) as Promise<Page>;
  return { db, app, accounts, run, fleet, ids: [slackA.id, telegramShared.id, gmail.id] };
}

test("manifest: contacts_list is an agent-audience read, workflow-listed (no MCP tool for agent cards), no hold, no receipt", () => {
  const op = manifest.operations.find((o) => o.id === "contacts_list");
  assert.ok(op);
  assert.equal(manifest.operations.at(-1)?.id, "contacts_list", "appended at the end of operations");
  assert.equal(op.audience, "agent");
  assert.deepEqual(op.crud, ["read"]);
  assert.equal(op.effect, "read");
  assert.equal(op.holdFamily, undefined);
  assert.equal(op.idempotency, "none");
  assert.equal(op.receipt, false);
  assert.equal(op.scopeType, undefined);
  assert.equal(op.listing, "workflow");
  // An agent card (Free, empty wf, or Bound with its own wf) does not see it; Governance's companion grant (wf = its ops) does.
  const view = { id: op.id, audience: op.audience, crud: op.crud, listing: op.listing } as never;
  assert.equal(opVisibleToGrant(view, { mode: "free", wf: [], crud: ["read", "create", "update", "delete"] }, ["account"]), false);
  assert.equal(opVisibleToGrant(view, { mode: "bound", wf: ["buzz_post"], crud: ["read"] }, ["account"]), false);
  assert.equal(opInGrantWorkflow({ mode: "bound", wf: ["contacts_list"] }, op.id, op.listing), true);
  // The companion entry Governance declares validates against this manifest (M-CP-2).
  const fleet = { ...manifest, id: "fleet", companions: [{ product: "connect", operations: ["contacts_list"], crud: ["read"], purpose: "Topology contacts layer." }] } as Manifest;
  const checked = validateCompanions(fleet, [manifest]);
  assert.equal(checked.ok, true, JSON.stringify(checked));
});

test("fire: agents, people, other apps, unverified and delisted app instances are refused", async () => {
  const s = setup();
  await assert.rejects(s.run({}, testCtx({ db: s.db, agent: A })), isCode("no_access", 403));
  await assert.rejects(s.run({}, testCtx({ db: s.db, person: true })), isCode("no_access", 403));
  await assert.rejects(s.run({}, testCtx({ db: s.db, app: OTHER, appProduct: "inbox", appListed: true })), isCode("no_access", 403));
  // the manifest NAME is never an identity: an app named "fleet" or "Governance" without the verified product is refused
  await assert.rejects(s.run({}, testCtx({ db: s.db, app: OTHER, appName: "fleet", appListed: true })), isCode("no_access", 403));
  await assert.rejects(s.run({}, testCtx({ db: s.db, app: OTHER, appName: "Governance", appProduct: "", appListed: true })), isCode("no_access", 403));
  await assert.rejects(s.run({}, s.fleet({ appListed: false })), isCode("no_access", 403));
  await assert.rejects(s.run({}, testCtx({ db: s.db, app: FLEET, appProduct: "fleet" })), isCode("companion_list_unavailable", 503));
});

test("quiet: Governance gets every contact, handles canonical, agent null where no agent sent, sorted by firstContactAt", async () => {
  const s = setup();
  const out = await s.run({});
  assert.equal(out.nextCursor, null);
  assert.deepEqual(out.contacts, [
    { agent: A, channel: "buzz", handle: `buzz:${npubEncode(HEX)}`, firstContactAt: 1_000 },
    { agent: null, channel: "buzz", handle: `buzz:${npubEncode(HEX2)}`, firstContactAt: 2_000 },
    { agent: A, channel: "slack", handle: "slack:U0PERSON1", account: "A bot", firstContactAt: 3_000 },
    { agent: null, channel: "telegram", handle: "telegram:123456789", account: "Workspace bot", firstContactAt: 4_000 },
    { agent: B, channel: "tool", handle: "ana@example.com", account: "Work Gmail", firstContactAt: 5_000 },
    { agent: null, channel: "tool", handle: "bob@example.com", account: "Work Gmail", firstContactAt: 6_000 },
  ]);
  // no content fields: only the contract keys, and no conversation id, DM channel or account id anywhere
  for (const row of out.contacts) for (const key of Object.keys(row)) assert.ok(["agent", "channel", "handle", "account", "firstContactAt"].includes(key), key);
  const text = JSON.stringify(out);
  for (const leak of [SECRET_CONVERSATION, SECRET_DM_CHANNEL, ...s.ids]) assert.ok(!text.includes(leak), leak);
  // read only: nothing written
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM connect_tool_contacts").get()?.n, 2);
});

test("since filters on firstContactAt (inclusive); bad since and cursor are refused", async () => {
  const s = setup();
  const out = await s.run({ since: 4_000 });
  assert.deepEqual(
    out.contacts.map((r) => r.firstContactAt),
    [4_000, 5_000, 6_000],
  );
  await assert.rejects(s.run({ since: -1 }), isCode("input_invalid", 400));
  await assert.rejects(s.run({ since: 1.5 }), isCode("input_invalid", 400));
  await assert.rejects(s.run({ cursor: "!!" }), isCode("cursor_invalid", 400));
  await assert.rejects(s.run({ cursor: Buffer.from('["x"]').toString("base64url") }), isCode("cursor_invalid", 400));
});

test("pages of 200 in a stable order (firstContactAt, agent, handle); the cursor resumes after the last row", async () => {
  const s = setup();
  const tool = s.db.prepare("INSERT INTO connect_tool_contacts (caller, account, address, first_sent_at) VALUES (?, ?, ?, ?)");
  const gmail = s.ids[2];
  // 450 more rows, many on the same time so the tie-break (agent, handle) decides
  for (let i = 0; i < 450; i++) tool.run(i % 2 ? A : B, gmail, `p${String(i).padStart(4, "0")}@example.com`, 10_000 + Math.floor(i / 10));
  const seen: Row[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: Page = await s.run(cursor ? { cursor } : {});
    assert.ok(page.contacts.length <= CONTACTS_PAGE);
    seen.push(...page.contacts);
    cursor = page.nextCursor;
    pages++;
  } while (cursor);
  assert.equal(pages, 3);
  assert.equal(seen.length, 456);
  assert.equal(new Set(seen.map((r) => `${r.firstContactAt}|${r.agent}|${r.handle}|${r.account}`)).size, 456, "no row twice");
  const key = (r: Row) => [String(r.firstContactAt).padStart(16, "0"), r.agent ?? "", r.handle].join("\u0000");
  for (let i = 1; i < seen.length; i++) assert.ok(key(seen[i - 1] as Row) <= key(seen[i] as Row), `order at ${i}`);
  // the same walk again gives the same pages
  const again = await s.run({});
  assert.deepEqual(again.contacts, seen.slice(0, CONTACTS_PAGE));
});

test("rows with the same visible key on a page boundary are both returned (source key tie-break, QA connect#34 S3)", async () => {
  const s = setup();
  const twin = s.accounts.create({ service: "gmail", source: "composio", kind: "as_me", label: "Work Gmail", ownerAgent: null, externalRef: null, status: "connected" });
  const tool = s.db.prepare("INSERT INTO connect_tool_contacts (caller, account, address, first_sent_at) VALUES (?, ?, ?, ?)");
  // 6 seed rows + 193 fillers = 199 rows before the twins, so the twins straddle the 200-row page boundary
  for (let i = 0; i < 193; i++) tool.run(B, s.ids[2], `f${String(i).padStart(4, "0")}@example.com`, 7_000 + i);
  tool.run(A, s.ids[2], "same@example.com", 9_000);
  tool.run(A, twin.id, "same@example.com", 9_000);
  const first: Page = await s.run({});
  assert.equal(first.contacts.length, CONTACTS_PAGE);
  assert.ok(first.nextCursor);
  const second: Page = await s.run({ cursor: first.nextCursor });
  assert.equal(second.contacts.length, 1);
  assert.equal(second.nextCursor, null);
  const twins = [...first.contacts, ...second.contacts].filter((r) => r.handle === "same@example.com");
  assert.equal(twins.length, 2, "both twin rows are returned");
  assert.ok(twins.every((r) => !("src" in r)), "the source key is never sent");
});
