/**
 * C380 sender bar, Connect part of A29: a person who left cannot reach agents and cannot get data back through Connect, with or
 * without Rules. Every test here runs with no Rules app and no hold: the refusals come from Connect alone. Each guard has a
 * quiet-on-good and a fire-on-bad row.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { schnorr } from "@noble/curves/secp256k1.js";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import { type ConnectError, createConnectApp, runDueBuzzPosts } from "../src/app.ts";
import { BUZZ_APPROVE, type BuzzReader, pollBuzzActions, recordBuzzActions } from "../src/channels/buzz/actions.ts";
import { eventId, generateSecretKey, type NostrEvent, npubEncode, publicKeyOf, signEvent } from "../src/channels/buzz/nostr.ts";
import type { BuzzRelay } from "../src/channels/buzz/relay.ts";
import type { ChannelNet, ChannelProvider, InboundMessage, InboundSink, MessageAction } from "../src/channels/provider.ts";
import { barHandle, SenderBars } from "../src/sender-bars.ts";
import { eventCtx, fakeFetch, handlerOf, root, secretsFor, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const AGENT = "agt_01BARAGENT00000000000000000";
const REFUSED = (e: ConnectError) => {
  assert.equal(e.code, "refused_by_policy");
  assert.equal(e.message, "Refused by company policy.");
  assert.equal((e as unknown as { status?: number; httpStatus?: number }).status ?? (e as unknown as { httpStatus?: number }).httpStatus, 403);
  return true;
};

function chatWorld() {
  const sent: { conversation: string; text: string }[] = [];
  const edits: string[] = [];
  const reactions: string[] = [];
  let sink: InboundSink | null = null;
  const provider: ChannelProvider = {
    service: "telegram",
    credentialFields: ["bot_token"],
    maxTextLength: 4096,
    verify: async () => ({ botId: "9", botName: "Bot" }),
    conversations: async () => [{ id: "-100", name: "Team room", type: "group" }],
    send: async (_c, _n, input) => {
      sent.push({ conversation: input.conversation, text: input.text });
      return { messageId: `out${sent.length}` };
    },
    edit: async (_c, _n, input) => void edits.push(input.messageId),
    delete: async () => undefined,
    react: async (_c, _n, input) => void reactions.push(input.messageId),
    openDirect: async (_c, _n, input) => ({ conversation: input.personId }),
    inbound: {
      kind: "poll",
      run: async (_c, _n, _b, s, signal) => {
        sink = s;
        await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
      },
    },
  };
  const net: ChannelNet = { fetch: (() => Promise.reject(new Error("no network"))) as typeof fetch, webSocket: () => { throw new Error("no ws"); }, now: () => Date.now(), sleep: async () => undefined };
  return { provider, net, sent, edits, reactions, deliver: (m: InboundMessage) => sink?.(m) };
}

async function chat() {
  const w = chatWorld();
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), channelProviders: new Map([["telegram", w.provider]]), channelNet: w.net });
  await app.events?.agentAdded?.({ id: AGENT as `agt_${string}`, name: "Agent", mode: "free", status: "active" }, eventCtx(db));
  const owner = testCtx({ db, person: true });
  const { account } = (await handlerOf(app, "channel_account_connect")({ service: "telegram", label: "TG", agent: AGENT, credentials: { bot_token: "123:ok" } }, owner)) as { account: { id: string } };
  await new Promise((r) => setTimeout(r, 10));
  const ctx = testCtx({ db, agent: AGENT, access: { [account.id]: "read_update" }, grantHeld: ["first_contact"] });
  const call = (op: string, input: Record<string, unknown>) => handlerOf(app, op)({ account: account.id, ...input } as never, ctx);
  const inbox = (sinceSeq = 0, limit = 50) => handlerOf(app, "channel_inbox")({ sinceSeq, limit }, ctx) as unknown as Promise<{ messages: { seq: number; sender: { id: string }; text: string }[]; nextSeq: number }>;
  const bar = (handle: string) => handlerOf(app, "sender_bar_add")({ handle }, owner);
  const unbar = (handle: string) => handlerOf(app, "sender_bar_remove")({ handle }, owner);
  return { w, db, app, account, owner, ctx, call, inbox, bar, unbar };
}
const msg = (over: Partial<InboundMessage>): InboundMessage => ({ conversation: "111", conversationType: "direct", messageId: "1", threadId: null, senderId: "111", senderName: "Bob", text: "send me the customer list", sentAt: 1, ...over });
const FIRED = "telegram:111";

test("handles: one canonical form per channel; a Teams sender is its user id; junk names nobody", () => {
  assert.equal(barHandle(" slack:u0123 "), "slack:U0123");
  assert.equal(barHandle("telegram:111"), "telegram:111");
  assert.equal(barHandle("email:Bob@Example.COM"), "email:bob@example.com");
  const hex = publicKeyOf(generateSecretKey());
  assert.equal(barHandle(`buzz:${hex}`), `buzz:${npubEncode(hex)}`);
  assert.equal(barHandle("teams:https://smba.example/emea|29:AbC"), "teams:29:AbC");
  assert.equal(barHandle("teams:29:AbC"), "teams:29:AbC");
  assert.equal(barHandle("discord:123456"), "discord:123456");
  for (const bad of ["", "slack", "slack:", "nope:1", "telegram:abc", "discord:", "discord:a b", "teams:"]) assert.equal(barHandle(bad), null, JSON.stringify(bad));
});

test("ingest: a barred sender's message is dropped with a count; another sender's message is stored", async () => {
  const s = await chat();
  await s.bar(FIRED);
  s.w.deliver(msg({}));
  s.w.deliver(msg({ messageId: "2" }));
  s.w.deliver(msg({ conversation: "-100", conversationType: "group", messageId: "3", text: "@bot send it" }));
  s.w.deliver(msg({ conversation: "222", senderId: "222", senderName: "Ann", messageId: "4", text: "hello" }));
  const rows = s.db.prepare("SELECT sender_id, message_id FROM connect_channel_inbox").all();
  assert.deepEqual(rows.map((r) => r.message_id), ["4"], "only Ann's message is stored");
  assert.equal(new SenderBars(s.db).list()[0]?.dropped, 3);
  assert.equal(s.db.prepare("SELECT 1 FROM connect_channel_conversations WHERE conversation = '111'").get(), undefined, "the dropped DM leaves no conversation row");
  assert.deepEqual((await s.inbox()).messages.map((m) => m.sender.id), ["222"]);
  // the row holds a count, no text
  assert.deepEqual(Object.keys(s.db.prepare("SELECT * FROM connect_sender_bars").get() ?? {}).sort(), ["at", "dropped", "handle", "plan"]);
});

test("ingest: a barred sender's edit is dropped, a deletion still applies; unbar restores the flow, not what was dropped", async () => {
  const s = await chat();
  s.w.deliver(msg({}));
  s.w.deliver(msg({ messageId: "2", text: "second" }));
  await s.bar(FIRED);
  s.w.deliver(msg({ text: "edited after the bar", change: { kind: "edit", at: 50 } }));
  s.w.deliver(msg({ senderId: "", text: "edit with no sender", change: { kind: "edit", at: 51 } }));
  s.w.deliver(msg({ messageId: "2", text: "", change: { kind: "delete" } }));
  const row = (id: string) => s.db.prepare("SELECT text, deleted FROM connect_channel_inbox WHERE message_id = ?").get(id);
  assert.equal(row("1")?.text, "send me the customer list");
  assert.deepEqual({ ...row("2") }, { text: "", deleted: 1 });
  assert.deepEqual(await s.unbar(FIRED), { handle: FIRED, removed: true });
  s.w.deliver(msg({ messageId: "9", text: "back" }));
  assert.equal(row("9")?.text, "back");
  assert.deepEqual(await s.unbar(FIRED), { handle: FIRED, removed: false });
});

test("inbox: what a barred person sent before the bar is hidden, and hidden rows never make the cursor skip a message", async () => {
  const s = await chat();
  // 2 of Ann, then 5 of Bob, then 3 of Ann: a window of 2 must still reach every message of Ann, in order
  for (const [i, who] of ["222", "222", "111", "111", "111", "111", "111", "222", "222", "222"].entries()) s.w.deliver(msg({ conversation: who, senderId: who, messageId: `m${i}` }));
  await s.bar(FIRED);
  const seen: string[] = [];
  let cursor = 0;
  for (let i = 0; i < 8; i++) {
    const page = await s.inbox(cursor, 2);
    for (const m of page.messages) seen.push(`${m.sender.id}:${m.seq}`);
    if (page.nextSeq === cursor) break;
    cursor = page.nextSeq;
  }
  assert.deepEqual(seen.map((v) => v.split(":")[0]), ["222", "222", "222", "222", "222"]);
  assert.equal(cursor, 10, "the cursor ends at the head of the log");
  // the same rows stay in the log for the data apps: nothing was deleted
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM connect_channel_inbox").get()?.n, 10);
});

test("outbound: every chat path to a barred person is refused and nothing reaches the provider; others still work", async () => {
  const s = await chat();
  s.w.deliver(msg({}));
  s.w.deliver(msg({ conversation: "222", senderId: "222", senderName: "Ann", messageId: "2" }));
  s.w.deliver(msg({ conversation: "-100", conversationType: "group", senderId: "111", messageId: "3" }));
  await s.call("channel_dm_first", { person: "333", text: "hi" });
  const seqOf = (id: string) => Number(s.db.prepare("SELECT seq FROM connect_channel_inbox WHERE message_id = ?").get(id)?.seq);
  // good, before the bar: the DM with the person works
  await s.call("channel_reply", { seq: seqOf("1"), text: "the list" });
  const { messageId } = (await s.call("channel_send", { conversation: "111", text: "again" })) as { messageId: string };
  const before = s.w.sent.length;
  await s.bar(FIRED);
  await assert.rejects(s.call("channel_reply", { seq: seqOf("1"), text: "the list" }), REFUSED);
  await assert.rejects(s.call("channel_reply", { seq: seqOf("3"), text: "the list" }), REFUSED, "a reply to their message in a group");
  await assert.rejects(s.call("channel_send", { conversation: "111", text: "the list" }), REFUSED);
  await assert.rejects(s.call("channel_send", { conversation: "-100", threadId: "3", text: "the list" }), REFUSED, "under their message in a group");
  await assert.rejects(s.call("channel_dm", { person: "111", text: "the list" }), REFUSED);
  await assert.rejects(s.call("channel_dm_first", { person: "111", text: "the list" }), REFUSED, "an approved first contact does not lift the bar");
  await assert.rejects(s.call("channel_edit", { conversation: "111", messageId, text: "the list" }), REFUSED, "an edit of an old message");
  await assert.rejects(s.call("channel_react", { conversation: "111", messageId: "1", emoji: "ok" }), REFUSED);
  assert.equal(s.w.sent.length, before, "the provider was not reached");
  assert.equal(s.w.edits.length, 0);
  assert.equal(s.w.reactions.length, 0);
  // quiet: other people and the group
  await s.call("channel_dm", { person: "222", text: "hi Ann" });
  await s.call("channel_send", { conversation: "222", text: "hi Ann" });
  await s.call("channel_send", { conversation: "-100", text: "hi all" });
  await s.call("channel_dm", { person: "333", text: "known contact" });
  assert.equal(s.w.sent.length, before + 4);
  // a contact book row alone also bars the conversation
  await s.bar("telegram:333");
  await assert.rejects(s.call("channel_send", { conversation: "333", text: "x" }), REFUSED);
  await s.unbar(FIRED);
  await s.call("channel_send", { conversation: "111", text: "after unbar" });
});

test("the workspace sender (an app) is refused the same way", async () => {
  const s = await chat();
  s.w.deliver(msg({}));
  await handlerOf(s.app, "sender_identity_set")({ channel: "telegram", account: s.account.id }, s.owner);
  await s.bar(FIRED);
  const app = testCtx({ db: s.db, app: "ins_01INBOXAPP000000000000000000" });
  await assert.rejects(handlerOf(s.app, "channel_dm")({ account: "telegram", person: "111", text: "alert" }, app), REFUSED);
  await assert.rejects(handlerOf(s.app, "channel_send")({ account: "telegram", conversation: "111", text: "alert" }, app), REFUSED);
});

test("owner ops: person only; a bad handle is refused; an agent cannot lift or set a bar", async () => {
  const s = await chat();
  for (const op of ["sender_bar_add", "sender_bar_remove"]) {
    await assert.rejects(handlerOf(s.app, op)({ handle: FIRED }, s.ctx), (e: ConnectError) => e.code === "no_access", `${op} as agent`);
    await assert.rejects(handlerOf(s.app, op)({ handle: FIRED }, testCtx({ db: s.db, app: "ins_01OTHER00000000000000000000" })), (e: ConnectError) => e.code === "no_access", `${op} as app`);
    await assert.rejects(handlerOf(s.app, op)({ handle: "nope" }, s.owner), (e: ConnectError) => e.code === "handle_invalid", `${op} junk`);
  }
  // a replay keeps the first row
  const bars = new SenderBars(s.db);
  assert.equal(bars.add(FIRED, "pln_1", 5), true);
  assert.equal(bars.add(FIRED, "pln_2", 6), false);
  assert.deepEqual(bars.list(), [{ handle: FIRED, plan: "pln_1", at: 5, dropped: 0 }]);
  const view = (await handlerOf(s.app, "accounts_overview")({}, s.owner)) as unknown as { senderBars: { handle: string; fromGovernance: boolean; dropped: number }[] };
  assert.deepEqual(view.senderBars.map((b) => [b.handle, b.fromGovernance, b.dropped]), [[FIRED, true, 0]]);
});

test("tool sends: a send tool naming a barred address is refused in both forms; another address keeps the old path", async () => {
  const db = testDb();
  const upstream = fakeFetch({});
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), fetchImpl: upstream.impl });
  const owner = testCtx({ db, person: true });
  await handlerOf(app, "sender_bar_add")({ handle: "email:Bob@Example.com" }, owner);
  db.prepare(
    `INSERT INTO connect_accounts (id, service, source, kind, label, owner_agent, external_ref, auth_config_id, status, detail, created_at, updated_at)
     VALUES ('cna_MAIL', 'gmail', 'composio', 'as_itself', 'Mail', ?, 'ca_x', NULL, 'connected', '', 1, 1)`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO connect_tools (name, source, service, upstream, title, description, input_schema, crud, effect, hold_family, updated_at)
     VALUES ('gmail_send_email', 'composio', 'gmail', 'GMAIL_SEND_EMAIL', 'Send', 'Send', '{}', '["create"]', 'outward', 'outward', 1)`,
  ).run();
  const ctx = testCtx({ db, agent: AGENT, access: { cna_MAIL: "read_update" }, grantHeld: ["first_contact"] });
  const tools = app.dynamic?.tools as unknown as { call: (tool: string, args: Record<string, unknown>, c: unknown) => Promise<unknown> };
  for (const recipient of ["bob@example.com", "Bob <BOB@example.com>", "ann@example.com, bob@example.com"]) {
    await assert.rejects(tools.call("gmail_send_email", { recipient_email: recipient, body: "the list" }, ctx), REFUSED, recipient);
    await assert.rejects(tools.call("gmail_send_email__first_contact", { recipient_email: recipient, body: "the list" }, ctx), REFUSED, `${recipient} first contact`);
  }
  await assert.rejects(tools.call("gmail_send_email", { recipient_email: "ann@example.com" }, ctx), (e: ConnectError) => e.code === "first_contact_required", "the old path");
  assert.equal(upstream.calls.length, 0);
});

// ── Buzz: no ingest; the relay is read live ──
const CHANNEL = "5a7d6c2e-1f3a-4c5b-9d8e-7f6a5b4c3d2e";
const ROOM = "6b8d6c2e-1f3a-4c5b-9d8e-7f6a5b4c3d2e";
const RELAY = "wss://relay.test.example";

async function buzz() {
  const firedSk = generateSecretKey();
  const fired = publicKeyOf(firedSk);
  const annSk = generateSecretKey();
  const groupSk = generateSecretKey();
  const posted: NostrEvent[] = [];
  const st = { fail: false, events: [] as NostrEvent[] };
  const relay = fakeFetch({
    "POST /events": ({ body }) => {
      const e = body as NostrEvent;
      posted.push(e);
      return { body: e.kind === 41010 ? { accepted: true, message: `response:${JSON.stringify({ channel_id: CHANNEL })}` } : { accepted: true, message: "", event_id: e.id } };
    },
    "POST /query": () => (st.fail ? { status: 500, body: { error: "down" } } : { body: st.events }),
  });
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), fetchImpl: relay.impl, buzzRelays: RELAY, allowRelayOrigins: [RELAY, "https://relay.test.example"] });
  await app.events?.agentAdded?.({ id: AGENT as `agt_${string}`, name: "Agent", mode: "free", status: "active" }, eventCtx(db));
  const owner = testCtx({ db, person: true });
  await handlerOf(app, "buzz_identities_generate")({}, owner);
  const ctx = testCtx({ db, agent: AGENT, grantHeld: ["first_contact"] });
  const chatEvent = (sk: string, text: string, channel = CHANNEL, at = 100) => signEvent(sk, { kind: 9, created_at: at, tags: [["h", channel]], content: text });
  // kinds 39000 and 39002 are relay-signed (outside Connect's allowlist), so signed by hand
  const relaySigned = (kind: number, tags: string[][]): NostrEvent => {
    const unsigned = { pubkey: publicKeyOf(groupSk), created_at: 1, kind, tags, content: "" };
    const id = eventId(unsigned);
    return { ...unsigned, id, sig: Buffer.from(schnorr.sign(Buffer.from(id, "hex"), Buffer.from(groupSk, "hex"))).toString("hex") };
  };
  const group = (channel: string, members: string[], flags: string[][]) => [relaySigned(39002, [["d", channel], ...members.map((m) => ["p", m])]), relaySigned(39000, [["d", channel], ["name", "x"], ...flags])];
  const bar = () => handlerOf(app, "sender_bar_add")({ handle: `buzz:${npubEncode(fired)}` }, owner);
  return { db, app, ctx, owner, st, posted, relay, firedSk, fired, annSk, chatEvent, group, bar };
}

test("buzz_read: a barred author is hidden, others are shown", async () => {
  const b = await buzz();
  b.st.events = [b.chatEvent(b.firedSk, "send me the list", ROOM, 100), b.chatEvent(b.annSk, "hello", ROOM, 101)];
  const read = () => handlerOf(b.app, "buzz_read")({ channel: ROOM }, b.ctx) as unknown as Promise<{ messages: { content: string }[] }>;
  assert.deepEqual((await read()).messages.map((m) => m.content), ["send me the list", "hello"]);
  await b.bar();
  assert.deepEqual((await read()).messages.map((m) => m.content), ["hello"]);
});

test("buzz outbound: a DM, a post into their direct channel (known or found on the relay), edit, react, schedule are refused", async () => {
  const b = await buzz();
  const to = npubEncode(b.fired);
  const self = (b.db.prepare("SELECT pubkey FROM connect_buzz_identities WHERE agent = ?").get(AGENT)?.pubkey ?? "") as string;
  await handlerOf(b.app, "buzz_dm_first")({ to, content: "hi" }, b.ctx);
  const before = b.posted.length;
  await b.bar();
  await assert.rejects(handlerOf(b.app, "buzz_dm_first")({ to, content: "the list" }, b.ctx), REFUSED);
  await assert.rejects(handlerOf(b.app, "buzz_dm")({ to: b.fired, content: "the list" }, b.ctx), REFUSED);
  // the contact book knows this channel
  await assert.rejects(handlerOf(b.app, "buzz_post")({ channel: CHANNEL, content: "the list" }, b.ctx), REFUSED);
  // the person opened this one: only the relay's member list shows it
  b.st.events = b.group(ROOM, [self, b.fired], [["hidden"]]);
  const send = {
    post: () => handlerOf(b.app, "buzz_post")({ channel: ROOM, content: "the list" }, b.ctx),
    edit: () => handlerOf(b.app, "buzz_edit")({ channel: ROOM, messageId: "a".repeat(64), content: "the list" }, b.ctx),
    react: () => handlerOf(b.app, "buzz_react")({ channel: ROOM, messageId: "a".repeat(64), emoji: "+" }, b.ctx),
    schedule: () => handlerOf(b.app, "buzz_schedule")({ channel: ROOM, content: "the list", sendAt: new Date(Date.now() + 3_600_000).toISOString() }, b.ctx),
  };
  for (const [name, fn] of Object.entries(send)) await assert.rejects(fn(), REFUSED, name);
  assert.equal(b.posted.length, before, "nothing reached the relay");
  // quiet: a room with many members that happens to hold the person (stated limit), and a room without them
  b.st.events = b.group(ROOM, [self, b.fired, publicKeyOf(generateSecretKey())], []);
  await send.post();
  b.st.events = b.group(ROOM, [self, publicKeyOf(generateSecretKey())], [["hidden"]]);
  await send.post();
  assert.equal(b.posted.length, before + 2);
  // a relay that cannot answer: not sent
  b.st.fail = true;
  await assert.rejects(send.post());
  assert.equal(b.posted.length, before + 2);
});

test("buzz outbound with no bar: no extra relay query", async () => {
  const b = await buzz();
  const queries = () => b.relay.calls.filter((c) => c.url.pathname === "/query").length;
  await handlerOf(b.app, "buzz_post")({ channel: ROOM, content: "hello" }, b.ctx);
  assert.equal(queries(), 0);
});

test("a post scheduled before the bar is cancelled when due, with no relay post", async () => {
  const b = await buzz();
  const self = String(b.db.prepare("SELECT pubkey FROM connect_buzz_identities WHERE agent = ?").get(AGENT)?.pubkey);
  const { id } = (await handlerOf(b.app, "buzz_schedule")({ channel: ROOM, content: "the list", sendAt: new Date(Date.now() + 3_600_000).toISOString() }, b.ctx)) as { id: string };
  await b.bar();
  b.st.events = b.group(ROOM, [self, b.fired], [["hidden"]]);
  const relay = { query: async () => ({ events: b.st.events, relays: [] }), post: async () => { throw new Error("must not post"); } } as unknown as BuzzRelay;
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  assert.equal(await runDueBuzzPosts(b.db, relay, log, Date.now() + 2 * 3_600_000), 0);
  const row = b.db.prepare("SELECT status, detail FROM connect_buzz_scheduled WHERE id = ?").get(id);
  assert.deepEqual({ ...row }, { status: "cancelled", detail: "Not sent: refused by company policy." });
});

test("buzz reactions: a barred recipient's signed reaction decides nothing and gets no reply", async () => {
  const db = testDb();
  const sk = generateSecretKey();
  const pubkey = publicKeyOf(sk);
  const secrets = secretsFor(db);
  const NOW = 1_760_000_000_000;
  const buttons: MessageAction[] = [{ label: "Approve", value: `ib1.${"t".repeat(16)}.a.${"m".repeat(22)}`, style: "primary" }];
  const alert = "a".repeat(64);
  await recordBuzzActions({ db, secrets, now: () => NOW }, { sender: "workspace", owner: pubkey, sent: [{ id: alert, channel: CHANNEL }], origin: { product: "inbox", instance: "ins_01", requestedAccount: "npub1x", actions: buttons, expiresAt: NOW + 3_600_000 } });
  const reaction = signEvent(sk, { kind: 7, created_at: NOW / 1000 + 5, tags: [["e", alert], ["h", CHANNEL]], content: BUZZ_APPROVE });
  const replies: string[] = [];
  const relayed: unknown[] = [];
  const reader: BuzzReader = { query: async () => ({ events: [reaction] }), post: async (_a, i) => void replies.push(i.content) };
  const deps = { db, secrets, reader, relay: async (_p: string, input: unknown) => { relayed.push(input); return { final: true, notice: "Approved." }; }, now: () => NOW };
  new SenderBars(db).add(`buzz:${npubEncode(pubkey)}`, null);
  await pollBuzzActions(deps);
  assert.deepEqual(relayed, []);
  assert.deepEqual(replies, []);
  assert.equal(db.prepare("SELECT state FROM connect_buzz_actions").get()?.state, "done");
  assert.equal(await secrets.get(`buzz-actions:${alert}`), null, "the sealed values are gone");
});
