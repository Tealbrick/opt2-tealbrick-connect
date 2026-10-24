/** Channel hub (C58) against a fake provider: connect, inbox seq cursor, send/reply, first contact, own-message rules, workers, webhook. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import { AccountStore } from "../src/accounts.ts";
import { type ConnectError, createConnectApp } from "../src/app.ts";
import { ChannelError, type ChannelNet, type ChannelProvider, type InboundMessage, type InboundSink } from "../src/channels/provider.ts";
import { eventCtx, handlerOf, root, secretsFor, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const AGENT = "agt_01CHANAGENT000000000000000";
const OTHER = "agt_01CHANOTHER000000000000000";

function fakeWorld() {
  const sent: { conversation: string; text: string; threadId?: string | null }[] = [];
  const calls: string[] = [];
  let sink: InboundSink | null = null;
  let runs = 0;
  let n = 0;
  const provider: ChannelProvider = {
    service: "telegram",
    credentialFields: ["bot_token"],
    maxTextLength: 4096,
    verify: async (creds) => {
      if (creds.bot_token !== "123:ok") throw new ChannelError("channel_credentials_rejected", "The bot token was rejected.", 401);
      return { botId: "bot-1", botName: "Test bot" };
    },
    conversations: async () => [{ id: "chan-1", name: "general", type: "channel" }],
    send: async (_c, _n, input) => {
      sent.push(input);
      n += 1;
      return { messageId: `m${n}` };
    },
    edit: async (_c, _n, input) => void calls.push(`edit:${input.messageId}`),
    delete: async (_c, _n, input) => void calls.push(`delete:${input.messageId}`),
    react: async (_c, _n, input) => void calls.push(`react:${input.emoji}`),
    openDirect: async (_c, _n, input) => ({ conversation: `dm-${input.personId}` }),
    inbound: {
      kind: "poll",
      run: async (_creds, _net, _bot, s, signal) => {
        runs += 1;
        sink = s;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    },
  };
  const net: ChannelNet = { fetch: (() => Promise.reject(new Error("no network"))) as typeof fetch, webSocket: () => { throw new Error("no ws"); }, now: () => Date.now(), sleep: async () => undefined };
  return { provider, net, sent, calls, deliver: (m: InboundMessage) => sink?.(m), runs: () => runs };
}

async function setup() {
  const w = fakeWorld();
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), channelProviders: new Map([["telegram", w.provider]]), channelNet: w.net });
  for (const id of [AGENT, OTHER]) await app.events?.agentAdded?.({ id: id as `agt_${string}`, name: id, mode: "free", status: "active" }, eventCtx(db));
  const person = testCtx({ db, person: true });
  return { w, db, app, person };
}

test("connect verifies the bot, seals credentials, starts the inbound worker; bad token refused", async () => {
  const s = await setup();
  await assert.rejects(handlerOf(s.app, "channel_account_connect")({ service: "telegram", label: "TG", agent: AGENT, credentials: { bot_token: "123:bad" } }, s.person), (e: ConnectError) => e.code === "channel_credentials_rejected");
  const out = (await handlerOf(s.app, "channel_account_connect")({ service: "telegram", label: "TG", agent: AGENT, credentials: { bot_token: "123:ok" } }, s.person)) as { account: { id: string; kind: string } };
  assert.equal(out.account.kind, "as_itself");
  assert.deepEqual(secretsFor(s.db).names(), [`account:${out.account.id}`]);
  assert.ok(!JSON.stringify(s.db.prepare("SELECT * FROM connect_channel_bots").all()).includes("123:ok"));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.w.runs(), 1);
  const status = (await handlerOf(s.app, "channel_accounts")({}, s.person)) as { accounts: { bot: { inbound: string } }[] };
  assert.equal(status.accounts[0]?.bot.inbound, "running");
  await handlerOf(s.app, "account_disconnect")({ id: out.account.id }, s.person);
  assert.deepEqual(secretsFor(s.db).names(), []);
});

test("inbox: seq cursor, dedupe, only the owning agent with read access; reply threads; untrusted", async () => {
  const s = await setup();
  const { account } = (await handlerOf(s.app, "channel_account_connect")({ service: "telegram", label: "TG", agent: AGENT, credentials: { bot_token: "123:ok" } }, s.person)) as { account: { id: string } };
  await new Promise((r) => setTimeout(r, 10));
  const msg = (id: string, text: string): InboundMessage => ({ conversation: "chan-1", conversationType: "channel", messageId: id, threadId: null, senderId: "u1", senderName: "Ann", text, sentAt: 1 });
  s.w.deliver(msg("10", "hello"));
  s.w.deliver(msg("10", "hello again (duplicate id)"));
  s.w.deliver(msg("11", "second"));
  const ctx = testCtx({ db: s.db, agent: AGENT, access: { [account.id]: "read_update" } });
  const first = (await handlerOf(s.app, "channel_inbox")({ limit: 1 }, ctx)) as { messages: { seq: number; text: string }[]; nextSeq: number; untrusted: boolean };
  assert.equal(first.untrusted, true);
  assert.deepEqual(first.messages.map((m) => m.text), ["hello"]);
  const next = (await handlerOf(s.app, "channel_inbox")({ sinceSeq: first.nextSeq }, ctx)) as { messages: { seq: number; text: string }[] };
  assert.deepEqual(next.messages.map((m) => m.text), ["second"]);
  const other = (await handlerOf(s.app, "channel_inbox")({}, testCtx({ db: s.db, agent: OTHER, access: { [account.id]: "read" } }))) as { messages: unknown[] };
  assert.equal(other.messages.length, 0);
  const noAccess = (await handlerOf(s.app, "channel_inbox")({}, testCtx({ db: s.db, agent: AGENT, access: {} }))) as { messages: unknown[] };
  assert.equal(noAccess.messages.length, 0);
  const reply = (await handlerOf(s.app, "channel_reply")({ account: account.id, seq: first.messages[0]?.seq ?? 0, text: "hi Ann" }, ctx)) as { messageId: string };
  assert.equal(s.w.sent.at(-1)?.threadId, "10");
  // Our own sent message echoed back by the provider is not stored as inbound.
  s.w.deliver({ ...msg(reply.messageId, "hi Ann"), senderId: "bot-1" });
  const after = (await handlerOf(s.app, "channel_inbox")({ sinceSeq: 0 }, ctx)) as { messages: unknown[] };
  assert.equal(after.messages.length, 2);
  await assert.rejects(handlerOf(s.app, "channel_send")({ account: account.id, conversation: "chan-1", text: "x" }, testCtx({ db: s.db, agent: OTHER, access: { [account.id]: "read_update" } })), (e: ConnectError) => e.code === "scope_denied");
});

test("DMs: first contact via channel_dm_first; channel_dm refuses unknown people; a person who wrote first is known", async () => {
  const s = await setup();
  const { account } = (await handlerOf(s.app, "channel_account_connect")({ service: "telegram", label: "TG", agent: AGENT, credentials: { bot_token: "123:ok" } }, s.person)) as { account: { id: string } };
  await new Promise((r) => setTimeout(r, 10));
  const ctx = testCtx({ db: s.db, agent: AGENT, access: { [account.id]: "read_update" } });
  await assert.rejects(handlerOf(s.app, "channel_dm")({ account: account.id, person: "u7", text: "hi" }, ctx), (e: ConnectError) => e.code === "channel_first_contact_required");
  const first = (await handlerOf(s.app, "channel_dm_first")({ account: account.id, person: "u7", text: "hello" }, ctx)) as { conversation: string };
  assert.equal(first.conversation, "dm-u7");
  await handlerOf(s.app, "channel_dm")({ account: account.id, person: "u7", text: "again" }, ctx);
  s.w.deliver({ conversation: "dm-u9", conversationType: "direct", messageId: "50", threadId: null, senderId: "u9", senderName: "Bo", text: "hi bot", sentAt: 1 });
  await handlerOf(s.app, "channel_dm")({ account: account.id, person: "u9", text: "hi Bo" }, ctx);
  assert.equal(s.w.sent.at(-1)?.conversation, "dm-u9");
  const spec = s.app.handlers.channel_dm_first as { holdView: (i: unknown) => string };
  assert.match(spec.holdView({ person: "u7", text: "hello" }), /First direct message[\s\S]*hello/u);
});

test("edit/delete only own messages; react passes through", async () => {
  const s = await setup();
  const { account } = (await handlerOf(s.app, "channel_account_connect")({ service: "telegram", label: "TG", agent: AGENT, credentials: { bot_token: "123:ok" } }, s.person)) as { account: { id: string } };
  const ctx = testCtx({ db: s.db, agent: AGENT, access: { [account.id]: "read_update_delete" } });
  const sent = (await handlerOf(s.app, "channel_send")({ account: account.id, conversation: "chan-1", text: "draft" }, ctx)) as { messageId: string };
  await handlerOf(s.app, "channel_edit")({ account: account.id, conversation: "chan-1", messageId: sent.messageId, text: "final" }, ctx);
  await assert.rejects(handlerOf(s.app, "channel_edit")({ account: account.id, conversation: "chan-1", messageId: "someone-else", text: "x" }, ctx), (e: ConnectError) => e.code === "channel_not_own_message");
  await handlerOf(s.app, "channel_react")({ account: account.id, conversation: "chan-1", messageId: "anything", emoji: "👍" }, ctx);
  await handlerOf(s.app, "channel_delete")({ account: account.id, conversation: "chan-1", messageId: sent.messageId }, ctx);
  await assert.rejects(handlerOf(s.app, "channel_delete")({ account: account.id, conversation: "chan-1", messageId: sent.messageId }, ctx), (e: ConnectError) => e.code === "channel_not_own_message");
  assert.deepEqual(s.w.calls, [`edit:${sent.messageId}`, "react:👍", `delete:${sent.messageId}`]);
});

test("manifest: channel ops are account-scoped; delete ops are destructive + held; DM first is first_contact; Teams webhook route", () => {
  const ops = Object.fromEntries(manifest.operations.map((o) => [o.id, o]));
  assert.equal(ops.channel_inbox?.scopeType, undefined); // F35: the handler filters by ctx.scope (see channel-inbox-scope test)
  for (const id of ["channel_send", "channel_reply", "channel_dm_first", "channel_dm", "channel_edit", "channel_delete", "channel_react", "channel_conversations"]) assert.equal(ops[id]?.scopeType, "account", id);
  assert.equal(ops.channel_dm_first?.holdFamily, "first_contact");
  assert.equal(ops.channel_delete?.holdFamily, "destructive");
  assert.equal(ops.buzz_delete?.holdFamily, "destructive");
  assert.ok(manifest.publicRoutes?.some((r) => r.path === "/inbound/teams" && r.purpose === "webhook"));
  assert.ok(new AccountStore(testDb()));
});

test("quality audit R2: a message the database cannot store is logged, counted and shown on the bot, and the provider is told", async () => {
  const w = fakeWorld();
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), channelProviders: new Map([["telegram", w.provider]]), channelNet: w.net });
  const lines: { msg: string; fields?: Record<string, unknown> }[] = [];
  const log = { debug() {}, info() {}, warn() {}, error: (msg: string, fields?: Record<string, unknown>) => void lines.push({ msg, ...(fields ? { fields } : {}) }) };
  const person = testCtx({ db, person: true, log: log as never });
  await handlerOf(app, "channel_accounts")({}, person); // the hub is built with this context's logger
  await app.events?.agentAdded?.({ id: AGENT as `agt_${string}`, name: AGENT, mode: "free", status: "active" }, eventCtx(db));
  const { account } = (await handlerOf(app, "channel_account_connect")({ service: "telegram", label: "TG", agent: AGENT, credentials: { bot_token: "123:ok" } }, person)) as { account: { id: string } };
  await new Promise((r) => setTimeout(r, 10));
  const msg: InboundMessage = { conversation: "chan-1", conversationType: "channel", messageId: "20", threadId: null, senderId: "u1", senderName: "Ann", text: "secret text", sentAt: 1 };
  db.exec("CREATE TRIGGER r2_fail BEFORE INSERT ON connect_channel_inbox BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;");
  assert.throws(() => w.deliver(msg), /disk I\/O error/u, "the provider learns it was not stored (Slack: no ack; Telegram: offset stays)");
  assert.throws(() => w.deliver({ ...msg, messageId: "21" }));
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.msg, "channel inbound message could not be stored");
  assert.deepEqual([lines[1]?.fields?.account, lines[1]?.fields?.failed], [account.id, 2]);
  assert.ok(!JSON.stringify(lines).includes("secret text"), "metadata only, never the text");
  const listed = (await handlerOf(app, "channel_accounts")({}, person)) as { accounts: { id: string; bot: { detail: string; notStored: number } | null }[] };
  const bot = listed.accounts.find((a) => a.id === account.id)?.bot;
  assert.equal(bot?.notStored, 2);
  assert.match(bot?.detail ?? "", /^2 incoming messages could not be stored since the last start/u);
  // the database recovers: the redelivered message is stored
  db.exec("DROP TRIGGER r2_fail");
  w.deliver(msg);
  const inbox = (await handlerOf(app, "channel_inbox")({}, testCtx({ db, agent: AGENT, access: { [account.id]: "read" } }))) as { messages: { text: string }[] };
  assert.deepEqual(inbox.messages.map((m) => m.text), ["secret text"]);
});
