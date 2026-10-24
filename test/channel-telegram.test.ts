/** Telegram provider contract (C58): recorded Bot API fixtures, fake fetch and sleep. Never touches the network. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelError, type InboundMessage } from "../src/channels/provider.ts";
import { parseTelegramUpdate, TELEGRAM_SINK_TRIES, telegramProvider, telegramReaction } from "../src/channels/providers/telegram.ts";
import { fakeNet, fixture, instantSleep, type RecordedRoute, recordedFetch } from "./channel-fakes.ts";

// Fake token (right shape, never valid anywhere).
const TOKEN = "123456789:AAFakeTokenForTestsOnly_xxxxxxxxxxxx-z";
const creds = { bot_token: TOKEN };
const P = `/bot${TOKEN}`;
const updates = fixture("telegram-updates.json");
const bot = { botId: "999000111", botName: "teal_bot" };

function setup(routes: Record<string, RecordedRoute>) {
  const fetch = recordedFetch(routes);
  const sleep = instantSleep();
  const { net } = fakeNet({ fetch: fetch.impl, sleep: sleep.sleep });
  return { net, calls: fetch.calls, waits: sleep.waits };
}

function assertChannelError(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ChannelError, String(error));
    assert.equal(error.code, code, error.message);
    assert.ok(!error.message.includes(TOKEN), "token leaked into the message");
    assert.ok(!error.message.includes("AAFakeToken"), "token part leaked into the message");
    return true;
  };
}

test("telegram: declaration", () => {
  assert.equal(telegramProvider.service, "telegram");
  assert.deepEqual(telegramProvider.credentialFields, ["bot_token"]);
  assert.equal(telegramProvider.maxTextLength, 4096);
  assert.equal(telegramProvider.inbound.kind, "poll");
});

test("telegram: verify calls getMe on the Bot API and returns the identity", async () => {
  const { net, calls } = setup({
    [`POST ${P}/getMe`]: {
      body: { ok: true, result: { id: 999000111, is_bot: true, first_name: "Teal", username: "teal_bot", can_join_groups: true } },
    },
  });
  assert.deepEqual(await telegramProvider.verify(creds, net), { botId: "999000111", botName: "teal_bot" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `https://api.telegram.org/bot${TOKEN}/getMe`);
  assert.equal(calls[0]?.method, "POST");
});

test("telegram: a token with the wrong shape is refused before any request", async () => {
  const { net, calls } = setup({});
  await assert.rejects(telegramProvider.verify({ bot_token: "not-a-token" }, net), assertChannelError("channel_credentials_invalid"));
  await assert.rejects(telegramProvider.verify({}, net), assertChannelError("channel_credentials_missing"));
  await assert.rejects(telegramProvider.send({ bot_token: "12:ab cd" }, net, { conversation: "1", text: "x" }), assertChannelError("channel_credentials_invalid"));
  assert.equal(calls.length, 0);
});

test("telegram: conversations is empty (no list API; the service records chats from inbound)", async () => {
  const { net, calls } = setup({});
  assert.deepEqual(await telegramProvider.conversations(creds, net, bot), []);
  assert.equal(calls.length, 0);
});

test("telegram: send is plain sendMessage; threadId becomes reply_parameters", async () => {
  const { net, calls } = setup({
    [`POST ${P}/sendMessage`]: {
      body: { ok: true, result: { message_id: 812, date: 1760000100, chat: { id: -1001234567890, type: "supergroup", title: "Team Room" }, text: "on it" } },
    },
  });
  assert.deepEqual(await telegramProvider.send(creds, net, { conversation: "-1001234567890", text: "on it", threadId: "120" }), { messageId: "812" });
  assert.deepEqual(calls[0]?.body, { chat_id: "-1001234567890", text: "on it", reply_parameters: { message_id: 120, allow_sending_without_reply: false } });
  await telegramProvider.send(creds, net, { conversation: "5550001", text: "hi", threadId: null });
  assert.deepEqual(calls[1]?.body, { chat_id: "5550001", text: "hi" });
});

test("telegram: send validates before any request", async () => {
  const { net, calls } = setup({});
  await assert.rejects(telegramProvider.send(creds, net, { conversation: "x y", text: "hi" }), assertChannelError("channel_conversation_invalid"));
  await assert.rejects(telegramProvider.send(creds, net, { conversation: "1", text: "   " }), assertChannelError("channel_message_empty"));
  await assert.rejects(telegramProvider.send(creds, net, { conversation: "1", text: "a".repeat(4097) }), assertChannelError("channel_text_too_long"));
  await assert.rejects(telegramProvider.send(creds, net, { conversation: "1", text: "a", threadId: "abc" }), assertChannelError("channel_message_id_invalid"));
  assert.equal(calls.length, 0);
});

test("telegram: edit, delete and react request shapes", async () => {
  const ok = { body: { ok: true, result: true } };
  const { net, calls } = setup({
    [`POST ${P}/editMessageText`]: { body: { ok: true, result: { message_id: 812, text: "fixed" } } },
    [`POST ${P}/deleteMessage`]: ok,
    [`POST ${P}/setMessageReaction`]: ok,
  });
  await telegramProvider.edit(creds, net, { conversation: "-100123", messageId: "812", text: "fixed" });
  await telegramProvider.delete(creds, net, { conversation: "-100123", messageId: "812" });
  // "❤\ufe0f" (with U+FE0F) is the same reaction as "❤".
  await telegramProvider.react(creds, net, { conversation: "-100123", messageId: "812", emoji: String.fromCodePoint(0x2764, 0xfe0f) });
  assert.deepEqual(
    calls.map((c) => [c.path.split("/").pop(), c.body]),
    [
      ["editMessageText", { chat_id: "-100123", message_id: 812, text: "fixed" }],
      ["deleteMessage", { chat_id: "-100123", message_id: 812 }],
      ["setMessageReaction", { chat_id: "-100123", message_id: 812, reaction: [{ type: "emoji", emoji: String.fromCodePoint(0x2764) }] }],
    ],
  );
});

test("telegram: a reaction outside Telegram's list is refused without a request", async () => {
  const { net, calls } = setup({});
  await assert.rejects(telegramProvider.react(creds, net, { conversation: "1", messageId: "2", emoji: "🦖" }), assertChannelError("channel_reaction_invalid"));
  await assert.rejects(telegramProvider.react(creds, net, { conversation: "1", messageId: "2", emoji: ":thumbsup:" }), assertChannelError("channel_reaction_invalid"));
  assert.equal(calls.length, 0);
  assert.equal(telegramReaction("👍"), "👍");
});

test("telegram: edit with the same text counts as done", async () => {
  const { net } = setup({
    [`POST ${P}/editMessageText`]: {
      status: 400,
      body: { ok: false, error_code: 400, description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same" },
    },
  });
  await telegramProvider.edit(creds, net, { conversation: "1", messageId: "2", text: "same" });
});

test("telegram: openDirect uses the user id as the private chat id", async () => {
  const { net, calls } = setup({
    [`POST ${P}/getChat`]: { body: { ok: true, result: { id: 5550001, type: "private", first_name: "Ada", accent_color_id: 1, max_reaction_count: 11 } } },
  });
  assert.deepEqual(await telegramProvider.openDirect(creds, net, { personId: "5550001" }), { conversation: "5550001" });
  assert.deepEqual(calls[0]?.body, { chat_id: "5550001" });
  await assert.rejects(telegramProvider.openDirect(creds, net, { personId: "@ada" }), assertChannelError("channel_person_invalid"));
});

test("telegram: openDirect and send map 'cannot write first' and 'blocked' to channel_dm_not_allowed", async () => {
  const { net } = setup({
    [`POST ${P}/getChat`]: { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: chat not found" } },
    [`POST ${P}/sendMessage`]: [
      { status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" } },
      { status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } },
    ],
  });
  await assert.rejects(telegramProvider.openDirect(creds, net, { personId: "5550009" }), (error) => {
    assertChannelError("channel_dm_not_allowed")(error);
    assert.match((error as Error).message, /press Start/u);
    return true;
  });
  await assert.rejects(telegramProvider.send(creds, net, { conversation: "5550009", text: "hi" }), assertChannelError("channel_dm_not_allowed"));
  await assert.rejects(telegramProvider.send(creds, net, { conversation: "5550009", text: "hi" }), assertChannelError("channel_dm_not_allowed"));
});

test("telegram: error mapping 401/404/403/400/5xx", async () => {
  const cases: [number, string, string][] = [
    [401, "Unauthorized", "channel_credentials_rejected"],
    [404, "Not Found", "channel_credentials_rejected"],
    [403, "Forbidden: bot is not a member of the supergroup chat", "channel_not_member"],
    [403, "Forbidden: bot was kicked from the group chat", "channel_not_member"],
    [400, "Bad Request: message to delete not found", "channel_not_found"],
    [400, "Bad Request: message can't be deleted for everyone", "channel_not_found"],
    [400, "Bad Request: chat not found", "channel_not_found"],
    [502, "Bad Gateway", "channel_provider_unavailable"],
    [400, "Bad Request: something odd", "channel_rejected"],
  ];
  for (const [status, description, code] of cases) {
    const { net } = setup({ [`POST ${P}/deleteMessage`]: { status, body: { ok: false, error_code: status, description } } });
    await assert.rejects(telegramProvider.delete(creds, net, { conversation: "-100123", messageId: "5" }), assertChannelError(code));
  }
});

test("telegram: the token never reaches an error message", async () => {
  const { net } = setup({
    [`POST ${P}/sendMessage`]: { status: 400, body: { ok: false, error_code: 400, description: `Bad Request: weird echo of bot${TOKEN} and ${TOKEN}` } },
  });
  await assert.rejects(telegramProvider.send(creds, net, { conversation: "1", text: "x" }), (error) => {
    assertChannelError("channel_rejected")(error);
    assert.match((error as Error).message, /\[redacted\]/u);
    return true;
  });
  // A transport error whose text carries the URL (and so the token) is replaced by a fixed message.
  const failing = fakeNet({
    fetch: (async (url: string) => {
      throw new TypeError(`fetch failed for ${url}`);
    }) as unknown as typeof fetch,
  });
  await assert.rejects(telegramProvider.verify(creds, failing.net), assertChannelError("channel_provider_unavailable"));
});

test("telegram: 429 honours parameters.retry_after once, then reports channel_rate_limited", async () => {
  const limited = { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } } };
  const first = setup({ [`POST ${P}/sendMessage`]: [limited, { body: { ok: true, result: { message_id: 5 } } }] });
  assert.deepEqual(await telegramProvider.send(creds, first.net, { conversation: "1", text: "x" }), { messageId: "5" });
  assert.deepEqual(first.waits, [3000]);
  assert.equal(first.calls.length, 2);

  const twice = setup({ [`POST ${P}/sendMessage`]: [limited, limited] });
  await assert.rejects(telegramProvider.send(creds, twice.net, { conversation: "1", text: "x" }), assertChannelError("channel_rate_limited"));
  assert.equal(twice.calls.length, 2);

  const long = setup({ [`POST ${P}/sendMessage`]: { ...limited, body: { ...limited.body, parameters: { retry_after: 120 } } } });
  await assert.rejects(telegramProvider.send(creds, long.net, { conversation: "1", text: "x" }), assertChannelError("channel_rate_limited"));
  assert.equal(long.calls.length, 1, "a wait over 30 s is not slept");
});

test("telegram: parseTelegramUpdate normalises messages and ignores bots", () => {
  const [privateMsg, botMsg, channelPost, topicPhoto, memberUpdate] = updates.batch1.result;
  const now = 42;
  const msg = parseTelegramUpdate(privateMsg, bot, now);
  assert.deepEqual(msg, {
    conversation: "5550001",
    conversationName: "Ada Lovelace",
    conversationType: "direct",
    messageId: "41",
    threadId: null,
    senderId: "5550001",
    senderName: "Ada Lovelace",
    text: "hello bot!",
    sentAt: 1760000000000,
    mentions: [],
  });
  // R3: another bot is kept and flagged (data apps read it as author kind bot); the bot itself is still ignored.
  assert.equal(parseTelegramUpdate(botMsg, bot, now)?.senderIsBot, true);
  assert.equal(parseTelegramUpdate(memberUpdate, bot, now), null);
  const post = parseTelegramUpdate(channelPost, bot, now);
  assert.equal(post?.conversationType, "channel");
  assert.equal(post?.senderId, "-1009876543210");
  assert.equal(post?.senderName, "Announcements");
  const topic = parseTelegramUpdate(topicPhoto, bot, now);
  assert.equal(topic?.conversationType, "group");
  assert.equal(topic?.threadId, "77");
  assert.equal(topic?.text, "see the chart\n[photo]");
  // The bot's own id is ignored even if Telegram omitted is_bot.
  assert.equal(parseTelegramUpdate({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 1, type: "private" }, from: { id: 999000111 }, text: "x" } }, bot, now), null);
});

test("telegram: poll loop deletes a webhook, advances the offset, backs off on 409, stops on abort", async () => {
  const controller = new AbortController();
  let polls = 0;
  const { net, calls, waits } = setup({
    [`POST ${P}/getWebhookInfo`]: [{ body: updates.getWebhookInfoSet }, { body: updates.getWebhookInfoEmpty }],
    [`POST ${P}/deleteWebhook`]: { body: updates.deleteWebhook },
    [`POST ${P}/getUpdates`]: () => {
      polls += 1;
      if (polls === 1) return { body: updates.batch1 };
      if (polls === 2) return { status: 409, body: updates.conflict };
      if (polls === 3) return { body: updates.batch2 };
      controller.abort();
      return { body: { ok: true, result: [] } };
    },
  });
  const got: InboundMessage[] = [];
  if (telegramProvider.inbound.kind !== "poll") throw new Error("expected poll");
  await telegramProvider.inbound.run(creds, net, bot, (m) => got.push(m), controller.signal);

  const methods = calls.map((c) => c.path.split("/").pop());
  assert.deepEqual(methods, ["getWebhookInfo", "deleteWebhook", "getUpdates", "getUpdates", "getWebhookInfo", "getUpdates", "getUpdates"]);
  assert.deepEqual(calls[1]?.body, { drop_pending_updates: false });
  const polled = calls.filter((c) => c.path.endsWith("/getUpdates")).map((c) => c.body);
  assert.deepEqual(polled[0], { timeout: 25, allowed_updates: ["message", "channel_post", "edited_message", "edited_channel_post"] });
  assert.equal(polled[1]?.offset, 727300106, "offset = last update_id + 1 (ignored updates count too)");
  assert.equal(polled[2]?.offset, 727300106);
  assert.equal(polled[3]?.offset, 727300107);
  assert.equal(waits.length, 1, "one backoff after the 409");
  assert.ok((waits[0] ?? 0) >= 1000);
  assert.deepEqual(
    got.map((m) => [m.conversation, m.messageId, m.text]),
    [
      ["5550001", "41", "hello bot!"],
      [String(updates.batch1.result[1].message.chat.id), String(updates.batch1.result[1].message.message_id), String(updates.batch1.result[1].message.text)],
      ["-1009876543210", "9", "Release 1.2 is out"],
      ["-1001234567890", "120", "see the chart\n[photo]"],
      ["5550001", "43", "[file: report.pdf]"],
    ],
  );
});

test("telegram: poll loop throws channel_credentials_rejected on 401", async () => {
  const { net } = setup({
    [`POST ${P}/getWebhookInfo`]: { body: updates.getWebhookInfoEmpty },
    [`POST ${P}/getUpdates`]: { status: 401, body: updates.unauthorized },
  });
  if (telegramProvider.inbound.kind !== "poll") throw new Error("expected poll");
  await assert.rejects(telegramProvider.inbound.run(creds, net, bot, () => {}, new AbortController().signal), assertChannelError("channel_credentials_rejected"));
});

test("telegram: poll loop retries transient errors with growing backoff", async () => {
  const controller = new AbortController();
  let polls = 0;
  const received: InboundMessage[] = [];
  const { net, waits } = setup({
    [`POST ${P}/getWebhookInfo`]: { body: updates.getWebhookInfoEmpty },
    [`POST ${P}/getUpdates`]: () => {
      polls += 1;
      if (polls <= 3) return { status: 502, body: { ok: false, error_code: 502, description: "Bad Gateway" } };
      if (polls === 4) return { body: updates.batch2 };
      controller.abort();
      return { body: { ok: true, result: [] } };
    },
  });
  if (telegramProvider.inbound.kind !== "poll") throw new Error("expected poll");
  await telegramProvider.inbound.run(creds, net, bot, (m) => received.push(m), controller.signal);
  assert.equal(waits.length, 3);
  assert.ok(waits.every((w) => w >= 1000));
  assert.ok((waits[2] ?? 0) >= 2000, "backoff grows");
  assert.equal(received.length, 1);
});

test("quality audit R2: a message the sink cannot store is fetched again (offset kept), then passed after TELEGRAM_SINK_TRIES", async () => {
  const controller = new AbortController();
  const offsets: (number | undefined)[] = [];
  let polls = 0;
  const id = updates.batch2.result[0].update_id as number;
  const { net, waits } = setup({
    [`POST ${P}/getWebhookInfo`]: { body: updates.getWebhookInfoEmpty },
    [`POST ${P}/getUpdates`]: (call) => {
      offsets.push(call.body?.offset);
      polls += 1;
      if (polls <= TELEGRAM_SINK_TRIES) return { body: updates.batch2 };
      controller.abort();
      return { body: { ok: true, result: [] } };
    },
  });
  if (telegramProvider.inbound.kind !== "poll") throw new Error("expected poll");
  let tries = 0;
  await telegramProvider.inbound.run(
    creds,
    net,
    bot,
    () => {
      tries += 1;
      throw new Error("database is locked");
    },
    controller.signal,
  );
  assert.equal(tries, TELEGRAM_SINK_TRIES, "offered to the sink on every fetch");
  assert.deepEqual(offsets.slice(0, TELEGRAM_SINK_TRIES), Array(TELEGRAM_SINK_TRIES).fill(undefined), "the offset never confirms the update it could not store");
  assert.equal(offsets[TELEGRAM_SINK_TRIES], id + 1, "after the last try the update is passed");
  assert.equal(waits.length, TELEGRAM_SINK_TRIES - 1, "a backoff before each new fetch");
});

test("telegram: an already aborted signal returns without polling", async () => {
  const { net, calls } = setup({});
  const controller = new AbortController();
  controller.abort();
  if (telegramProvider.inbound.kind !== "poll") throw new Error("expected poll");
  await telegramProvider.inbound.run(creds, net, bot, () => {}, controller.signal);
  assert.equal(calls.length, 0);
});

test("R3 telegram: edited_message and edited_channel_post become edits (with edit_date); no edit_date is ignored; Telegram reports no deletions", () => {
  const base = { message_id: 41, date: 1_760_000_000, chat: { id: 5550001, type: "private" }, from: { id: 5550001, first_name: "Ada" }, text: "hello, edited" };
  const edit = parseTelegramUpdate({ update_id: 9, edited_message: { ...base, edit_date: 1_760_000_100 } }, bot, 5);
  assert.deepEqual(edit?.change, { kind: "edit", at: 1_760_000_100_000 });
  assert.equal(edit?.messageId, "41");
  assert.equal(edit?.text, "hello, edited");
  const post = parseTelegramUpdate({ update_id: 10, edited_channel_post: { ...base, chat: { id: -1009876543210, type: "channel" }, from: undefined, sender_chat: { id: -1009876543210, title: "Announcements" }, edit_date: 1_760_000_200 } }, bot, 5);
  assert.deepEqual(post?.change, { kind: "edit", at: 1_760_000_200_000 });
  assert.equal(parseTelegramUpdate({ update_id: 11, edited_message: base }, bot, 5), null);
  assert.equal(parseTelegramUpdate({ update_id: 12, message: base }, bot, 5)?.change, undefined);
  assert.deepEqual(telegramProvider.reports, { edits: true, deletions: false });
});
