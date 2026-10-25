/**
 * C354a QA (connect#31): the 0.6.1 known-direct check counts only messages from people (`sender_is_bot = 0`). A direct
 * conversation where only a bot wrote stays a first contact; after a person writes, channel_send posts. Adopted from qa-probe5.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import { type ConnectError, createConnectApp } from "../src/app.ts";
import type { ChannelNet, ChannelProvider } from "../src/channels/provider.ts";
import { eventCtx, handlerOf, root, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const AGENT = "agt_01CHANAGENT000000000000000";
test("S3-1: a known direct conversation where only a BOT wrote is a first contact (0.6.1 sender_is_bot filter kept)", async () => {
  const sent: string[] = [];
  const provider: ChannelProvider = {
    service: "telegram", credentialFields: ["bot_token"], maxTextLength: 4096,
    verify: async () => ({ botId: "bot-1", botName: "b" }), conversations: async () => [],
    send: async (_c, _n, i) => { sent.push(i.conversation); return { messageId: `m${sent.length}` }; },
    edit: async () => undefined, delete: async () => undefined, react: async () => undefined,
    openDirect: async (_c, _n, i) => ({ conversation: `dm-${i.personId}` }),
    inbound: { kind: "poll", run: async (_c, _n, _b, _s, signal) => { await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true })); } },
  } as ChannelProvider;
  const net = { fetch: (() => Promise.reject(new Error("x"))) as typeof fetch, webSocket: () => { throw new Error("x"); }, now: () => Date.now(), sleep: async () => undefined } as ChannelNet;
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), channelProviders: new Map([["telegram", provider]]), channelNet: net });
  await app.events?.agentAdded?.({ id: AGENT as `agt_${string}`, name: AGENT, mode: "free", status: "active" }, eventCtx(db));
  const { account } = (await handlerOf(app, "channel_account_connect")({ service: "telegram", label: "TG", agent: AGENT, credentials: { bot_token: "123:ok" } }, testCtx({ db, person: true }))) as { account: { id: string } };
  const ctx = testCtx({ db, agent: AGENT, access: { [account.id]: "read_update" }, grantHeld: ["first_contact"] });
  const code = (p: Promise<unknown>) => p.then(() => "SENT", (e: ConnectError) => e.code);
  db.prepare("INSERT INTO connect_channel_conversations (account_id, conversation, name, type, last_seen_at) VALUES (?, 'DBOT', 'x', 'direct', 0)").run(account.id);
  db.prepare("INSERT INTO connect_channel_inbox (account_id, conversation, conversation_type, message_id, thread_id, sender_id, sender_name, text, sent_at, received_at, mentions, rev, attachments, edited_at, sender_is_bot) VALUES (?, 'DBOT', 'direct', '1', NULL, 'bot2', 'Bot', 'hi', 1, 1, '[]', 1, NULL, NULL, 1)").run(account.id);
  const r = await code(handlerOf(app, "channel_send")({ account: account.id, conversation: "DBOT", text: "x" }, ctx));
  assert.equal(sent.length, 0, "nothing reached the provider");
  assert.equal(r, "channel_first_contact_required");
  db.prepare("INSERT INTO connect_channel_inbox (account_id, conversation, conversation_type, message_id, thread_id, sender_id, sender_name, text, sent_at, received_at, mentions, rev, attachments, edited_at, sender_is_bot) VALUES (?, 'DBOT', 'direct', '2', NULL, 'u1', 'Ann', 'hi', 1, 1, '[]', 2, NULL, NULL, 0)").run(account.id);
  assert.equal(await code(handlerOf(app, "channel_send")({ account: account.id, conversation: "DBOT", text: "x" }, ctx)), "SENT");
  assert.deepEqual(sent, ["DBOT"]);
});
