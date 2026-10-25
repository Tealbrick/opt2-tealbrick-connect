/** C58 Slack provider: Web API request shapes, error mapping, Socket Mode inbound (recorded fixtures, fake socket). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { type BotIdentity, ChannelError, type ChannelNet, type InboundMessage } from "../src/channels/provider.ts";
import { escapeSlackText, SLACK_APP_MANIFEST, slackProvider } from "../src/channels/providers/slack.ts";

const fixtures = join(import.meta.dirname, "fixtures", "channels");
const api = JSON.parse(readFileSync(join(fixtures, "slack-web-api.json"), "utf8")) as Record<string, Record<string, unknown>>;
const envelopes = JSON.parse(readFileSync(join(fixtures, "slack-socket-envelopes.json"), "utf8")) as Record<string, Record<string, unknown>>;

// Fake token shapes only; nothing here is a real credential.
// Built at run time so no token-shaped literal sits in the source (secret scanners); still fake values only.
const BOT_TOKEN = ["xoxb", "fake", "test", "bot", "value"].join("-");
const APP_TOKEN = ["xapp", "fake", "test", "app", "value"].join("-");
const CREDS = { bot_token: BOT_TOKEN, app_token: APP_TOKEN };
const BOT: BotIdentity = { botId: "U0BOTUSER1", botName: "tealbrick", workspace: "T0TESTTEAM" };
const NOW = 1_760_000_000_000;

type Reply = { status?: number; body: unknown; headers?: Record<string, string> };
type Call = { method: string; form: URLSearchParams; headers: Headers };

/** Fake Slack Web API: routes keyed by method name, form-encoded bodies recorded. */
function slackNet(routes: Record<string, Reply | ((form: URLSearchParams, n: number) => Reply)>) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const sockets: FakeSocket[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://slack.com");
    const method = url.pathname.replace(/^\/api\//u, "");
    const form = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ method, form, headers: new Headers(init?.headers) });
    const route = routes[method];
    const n = calls.filter((c) => c.method === method).length;
    const out = typeof route === "function" ? route(form, n) : (route ?? { body: { ok: false, error: "unknown_method" } });
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { "content-type": "application/json", ...out.headers } });
  }) as typeof fetch;
  const net: ChannelNet = {
    fetch: fetchImpl,
    webSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { net, calls, sleeps, sockets };
}

class FakeSocket extends EventTarget {
  readonly url: string;
  readonly sent: string[] = [];
  closed = false;
  constructor(url: string) {
    super();
    this.url = url;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  emit(frame: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
  drop() {
    this.dispatchEvent(new Event("close"));
  }
}

async function until(condition: () => boolean, what: string) {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function rejectsWith(promise: Promise<unknown>, code: string, status?: number): Promise<ChannelError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ChannelError, `expected ChannelError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.httpStatus, status);
    assert.ok(!error.message.includes(BOT_TOKEN) && !error.message.includes(APP_TOKEN), "token leaked into the error");
    return error;
  }
  assert.fail(`expected ${code}`);
}

test("verify: auth.test with the bot token → bot user id, name, team id; shapes checked before any request", async () => {
  const { net, calls } = slackNet({ "auth.test": { body: api["auth.test"] } });
  const bot = await slackProvider.verify(CREDS, net);
  assert.deepEqual(bot, { botId: "U0BOTUSER1", botName: "tealbrick", workspace: "T0TESTTEAM" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.headers.get("authorization"), `Bearer ${BOT_TOKEN}`);
  assert.match(calls[0]?.headers.get("content-type") ?? "", /x-www-form-urlencoded/u);

  await rejectsWith(slackProvider.verify({ bot_token: "xoxp-user-token-not-a-bot", app_token: APP_TOKEN }, net), "channel_credentials_invalid");
  await rejectsWith(slackProvider.verify({ bot_token: BOT_TOKEN, app_token: "xoxb-wrong-kind-of-token" }, net), "channel_credentials_invalid");
  await rejectsWith(slackProvider.verify({ bot_token: BOT_TOKEN }, net), "channel_credentials_missing");
  assert.equal(calls.length, 1, "no request for a malformed credential");
});

test("conversations: public + private channels the bot is in, cursor paging, archived/non-member skipped, names cleaned", async () => {
  const { net, calls } = slackNet({
    "conversations.list": (form) => ({ body: form.get("cursor") ? api["conversations.list.page2"] : api["conversations.list.page1"] }),
  });
  const list = await slackProvider.conversations(CREDS, net, BOT);
  assert.deepEqual(list, [
    { id: "C0GENERAL1", name: "general", type: "channel" },
    { id: "G0PRIVATE1", name: "leads", type: "channel" },
  ]);
  assert.equal(calls[0]?.form.get("types"), "public_channel,private_channel");
  assert.equal(calls[0]?.form.get("exclude_archived"), "true");
  assert.equal(calls[1]?.form.get("cursor"), "dGVhbTpDMDYxRkE1UEI=");
});

test("conversations: capped at 200", async () => {
  const page = (offset: number) => ({
    ok: true,
    channels: Array.from({ length: 150 }, (_, i) => ({ id: `C${String(offset + i).padStart(6, "0")}`, name: `c${offset + i}`, is_member: true })),
    response_metadata: { next_cursor: `cursor${offset + 150}` },
  });
  const { net, calls } = slackNet({ "conversations.list": (_form, n) => ({ body: page((n - 1) * 150) }) });
  const list = await slackProvider.conversations(CREDS, net, BOT);
  assert.equal(list.length, 200);
  assert.equal(calls.length, 2);
});

test("send: chat.postMessage with escaped text and thread_ts; returns the ts", async () => {
  const { net, calls } = slackNet({ "chat.postMessage": { body: api["chat.postMessage"] } });
  const out = await slackProvider.send(CREDS, net, { conversation: "C0GENERAL1", text: "a & b <!channel> <@U0SOMEONE>", threadId: "1700000000.000100" });
  assert.deepEqual(out, { messageId: "1700000100.000200" });
  const form = calls[0]?.form;
  assert.equal(form?.get("channel"), "C0GENERAL1");
  assert.equal(form?.get("text"), "a &amp; b &lt;!channel&gt; &lt;@U0SOMEONE&gt;");
  assert.equal(form?.get("thread_ts"), "1700000000.000100");
  assert.equal(form?.get("link_names"), "false");
  assert.equal(escapeSlackText("<&>"), "&lt;&amp;&gt;");

  const top = slackNet({ "chat.postMessage": { body: api["chat.postMessage"] } });
  await slackProvider.send(CREDS, top.net, { conversation: "C0GENERAL1", text: "hi", threadId: null });
  assert.equal(top.calls[0]?.form.has("thread_ts"), false);

  await rejectsWith(slackProvider.send(CREDS, net, { conversation: "general", text: "x" }), "channel_input_invalid");
  await rejectsWith(slackProvider.send(CREDS, net, { conversation: "C0GENERAL1", text: "  " }), "channel_text_empty");
  await rejectsWith(slackProvider.send(CREDS, net, { conversation: "C0GENERAL1", text: "<".repeat(10_001) }), "channel_text_too_long");
  await rejectsWith(slackProvider.send(CREDS, net, { conversation: "C0GENERAL1", text: "x", threadId: "abc" }), "channel_input_invalid");
  assert.equal(calls.length, 1, "invalid input never reaches Slack");
});

test("edit, delete, react, openDirect: method and parameter shapes", async () => {
  const { net, calls } = slackNet({
    "chat.update": { body: { ok: true, channel: "C0GENERAL1", ts: "1700000100.000200", text: "x" } },
    "chat.delete": { body: { ok: true, channel: "C0GENERAL1", ts: "1700000100.000200" } },
    "reactions.add": (_form, n) => ({ body: n === 1 ? { ok: true } : { ok: false, error: "already_reacted" } }),
    "conversations.open": { body: api["conversations.open"] },
  });
  await slackProvider.edit(CREDS, net, { conversation: "C0GENERAL1", messageId: "1700000100.000200", text: "new <text>" });
  await slackProvider.delete(CREDS, net, { conversation: "C0GENERAL1", messageId: "1700000100.000200" });
  await slackProvider.react(CREDS, net, { conversation: "C0GENERAL1", messageId: "1700000100.000200", emoji: ":thumbsup:" });
  await slackProvider.react(CREDS, net, { conversation: "C0GENERAL1", messageId: "1700000100.000200", emoji: "thumbsup" });
  const direct = await slackProvider.openDirect(CREDS, net, { personId: "U0HUMAN001" });
  assert.deepEqual(direct, { conversation: "D0DIRECT01" });
  assert.deepEqual(
    calls.map((c) => c.method),
    ["chat.update", "chat.delete", "reactions.add", "reactions.add", "conversations.open"],
  );
  assert.deepEqual(Object.fromEntries(calls[0]?.form ?? []), { channel: "C0GENERAL1", ts: "1700000100.000200", text: "new &lt;text&gt;", parse: "none", link_names: "false" });
  assert.deepEqual(Object.fromEntries(calls[1]?.form ?? []), { channel: "C0GENERAL1", ts: "1700000100.000200" });
  assert.deepEqual(Object.fromEntries(calls[2]?.form ?? []), { channel: "C0GENERAL1", timestamp: "1700000100.000200", name: "thumbsup" });
  assert.equal(calls[4]?.form.get("users"), "U0HUMAN001");

  await rejectsWith(slackProvider.react(CREDS, net, { conversation: "C0GENERAL1", messageId: "1700000100.000200", emoji: "<script>" }), "channel_input_invalid");
  await rejectsWith(slackProvider.openDirect(CREDS, net, { personId: "ada@example.com" }), "channel_input_invalid");
});

test("error mapping: credentials, membership, scopes, provider errors", async () => {
  const cases: [string, Record<string, unknown>, string, number][] = [
    ["invalid_auth", { ok: false, error: "invalid_auth" }, "channel_credentials_rejected", 401],
    ["token_revoked", { ok: false, error: "token_revoked" }, "channel_credentials_rejected", 401],
    ["account_inactive", { ok: false, error: "account_inactive" }, "channel_credentials_rejected", 401],
    ["not_authed", { ok: false, error: "not_authed" }, "channel_credentials_rejected", 401],
    ["channel_not_found", { ok: false, error: "channel_not_found" }, "channel_not_member", 403],
    ["not_in_channel", { ok: false, error: "not_in_channel" }, "channel_not_member", 403],
    ["missing_scope", api["error.missing_scope"] ?? {}, "channel_scope_missing", 403],
    ["is_archived", { ok: false, error: "is_archived" }, "channel_provider_error", 502],
  ];
  for (const [label, body, code, status] of cases) {
    const { net } = slackNet({ "chat.postMessage": { body } });
    const error = await rejectsWith(slackProvider.send(CREDS, net, { conversation: "C0GENERAL1", text: "hi" }), code, status);
    if (code === "channel_not_member") assert.match(error.message, /Invite the bot/u, label);
    if (label === "missing_scope") assert.match(error.message, /reactions:write/u);
  }
  // Slack did not name the scope: the method's own scope is named.
  const { net } = slackNet({ "chat.postMessage": { body: { ok: false, error: "missing_scope" } } });
  const error = await rejectsWith(slackProvider.send(CREDS, net, { conversation: "C0GENERAL1", text: "hi" }), "channel_scope_missing");
  assert.match(error.message, /chat:write/u);
});

test("rate limit: HTTP 429 honours Retry-After once, then refuses", async () => {
  const once = slackNet({
    "chat.postMessage": (_form, n) => (n === 1 ? { status: 429, body: { ok: false, error: "ratelimited" }, headers: { "retry-after": "2" } } : { body: api["chat.postMessage"] }),
  });
  assert.deepEqual(await slackProvider.send(CREDS, once.net, { conversation: "C0GENERAL1", text: "hi" }), { messageId: "1700000100.000200" });
  assert.deepEqual(once.sleeps, [2000]);

  const twice = slackNet({ "chat.postMessage": { status: 429, body: { ok: false, error: "ratelimited" }, headers: { "retry-after": "1" } } });
  await rejectsWith(slackProvider.send(CREDS, twice.net, { conversation: "C0GENERAL1", text: "hi" }), "channel_rate_limited", 429);
  assert.equal(twice.calls.length, 2);

  const long = slackNet({ "chat.postMessage": { status: 429, body: { ok: false, error: "ratelimited" }, headers: { "retry-after": "600" } } });
  await rejectsWith(slackProvider.send(CREDS, long.net, { conversation: "C0GENERAL1", text: "hi" }), "channel_rate_limited", 429);
  assert.equal(long.calls.length, 1, "a wait over 30 s is not honoured");
});

test("tokens never reach an error message (network error echoing the request)", async () => {
  const net: ChannelNet = {
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      throw new Error(`connect failed for ${new Headers(init?.headers).get("authorization")}`);
    }) as typeof fetch,
    webSocket: () => {
      throw new Error("unused");
    },
    now: () => NOW,
    sleep: async () => {},
  };
  const error = await rejectsWith(slackProvider.send(CREDS, net, { conversation: "C0GENERAL1", text: "hi" }), "channel_provider_unavailable");
  assert.match(error.message, /\[redacted\]/u);
});

test("manifest: Socket Mode on, inbound scopes and events present (fixes v1 gaps)", () => {
  assert.equal(SLACK_APP_MANIFEST.settings.socket_mode_enabled, true);
  const scopes: readonly string[] = SLACK_APP_MANIFEST.oauth_config.scopes.bot;
  for (const scope of ["chat:write", "channels:read", "groups:read", "im:read", "im:write", "im:history", "channels:history", "groups:history", "reactions:write", "app_mentions:read", "users:read"]) {
    assert.ok(scopes.includes(scope), scope);
  }
  assert.deepEqual([...SLACK_APP_MANIFEST.settings.event_subscriptions.bot_events], ["message.channels", "message.groups", "message.im", "app_mention"]);
  assert.equal("request_url" in SLACK_APP_MANIFEST.settings.event_subscriptions, false);
});

test("socket mode: hello, ack every envelope, messages to the sink, filters, dedupe, disconnect → reconnect, drop → backoff, abort closes", async () => {
  const { net, calls, sleeps, sockets } = slackNet({ "apps.connections.open": { body: api["apps.connections.open"] } });
  if (slackProvider.inbound.kind !== "socket") assert.fail("slack inbound is socket");
  const received: InboundMessage[] = [];
  const abort = new AbortController();
  const running = slackProvider.inbound.run(CREDS, net, BOT, (m) => received.push(m), abort.signal);

  await until(() => sockets.length === 1, "first socket");
  assert.equal(calls[0]?.method, "apps.connections.open");
  assert.equal(calls[0]?.headers.get("authorization"), `Bearer ${APP_TOKEN}`, "Socket Mode uses the app-level token");
  assert.equal(sockets[0]?.url, api["apps.connections.open"]?.url);
  const first = sockets[0] as FakeSocket;
  first.emit(envelopes.hello);
  first.emit(envelopes.message);
  first.emit(envelopes.message); // Slack retry of the same event_id
  first.emit(envelopes.app_mention_same_message); // the app_mention twin of the same message
  first.emit(envelopes.bot_message);
  first.emit(envelopes.edit);
  first.emit(envelopes.other_team);
  first.emit({ ...envelopes.message, envelope_id: "env-own", payload: { ...(envelopes.message?.payload as object), event_id: "Ev0OWN00001", event: { type: "message", channel: "C0GENERAL1", user: "U0BOTUSER1", text: "me", ts: "1700000500.000100" } } });
  first.emit(envelopes.dm_thread_reply);

  assert.deepEqual(
    first.sent.map((s) => JSON.parse(s).envelope_id),
    ["env-0001", "env-0001", "env-0002", "env-0003", "env-0004", "env-0006", "env-own", "env-0005"],
    "every envelope is acked",
  );
  assert.deepEqual(received, [
    {
      conversation: "C0GENERAL1",
      conversationType: "channel",
      messageId: "1700000200.000100",
      threadId: null,
      senderId: "U0HUMAN001",
      senderName: "Ada",
      text: "can you check <this> & that?",
      sentAt: 1_700_000_200_000,
      mentions: ["U0BOTUSER1"],
    },
    {
      // R3: another bot's message is kept, flagged; the hub never lists it for agents and apps see author kind bot
      conversation: "C0GENERAL1",
      conversationType: "channel",
      messageId: "1700000201.000100",
      threadId: null,
      senderId: "B0OTHERBOT",
      senderName: "B0OTHERBOT",
      text: "beep",
      sentAt: 1_700_000_201_000,
      mentions: [],
      senderIsBot: true,
    },
    {
      conversation: "D0DIRECT01",
      conversationType: "direct",
      messageId: "1700000300.000300",
      threadId: "1700000250.000100",
      senderId: "U0HUMAN002",
      senderName: "U0HUMAN002",
      text: "replying in thread",
      sentAt: 1_700_000_300_000,
      mentions: [],
    },
  ]);

  // disconnect (refresh_requested) after hello: reconnect at once, no backoff
  first.emit(envelopes.disconnect);
  await until(() => sockets.length === 2, "reconnect after disconnect");
  assert.equal(first.closed, true);
  assert.deepEqual(sleeps, []);
  // dedupe survives the reconnect
  const second = sockets[1] as FakeSocket;
  second.emit(envelopes.hello);
  second.emit(envelopes.message);
  assert.equal(received.length, 3);

  // a dropped socket: capped, jittered backoff before the next open
  second.drop();
  await until(() => sockets.length === 3, "reconnect after drop");
  assert.equal(sleeps.length, 1);
  assert.ok((sleeps[0] ?? 0) >= 500 && (sleeps[0] ?? 0) <= 2_000, `backoff ${sleeps[0]}`);

  abort.abort();
  await running;
  assert.equal(sockets[2]?.closed, true);
  assert.equal(calls.filter((c) => c.method === "apps.connections.open").length, 3);
});

test("socket mode: a rejected app token throws channel_credentials_rejected without the token", async () => {
  const { net, sockets } = slackNet({ "apps.connections.open": { body: { ok: false, error: "invalid_auth" } } });
  if (slackProvider.inbound.kind !== "socket") assert.fail("slack inbound is socket");
  await rejectsWith(slackProvider.inbound.run(CREDS, net, BOT, () => {}, new AbortController().signal), "channel_credentials_rejected", 401);
  assert.equal(sockets.length, 0);

  const scope = slackNet({ "apps.connections.open": { body: { ok: false, error: "missing_scope", needed: "connections:write" } } });
  const error = await rejectsWith(slackProvider.inbound.run(CREDS, scope.net, BOT, () => {}, new AbortController().signal), "channel_credentials_rejected");
  assert.match(error.message, /connections:write/u);
});

test("socket mode: transient open failures back off and retry; abort during backoff resolves", async () => {
  const abort = new AbortController();
  const { net, sleeps } = slackNet({
    "apps.connections.open": (_form, n) => {
      if (n >= 3) abort.abort();
      return { status: 503, body: "unavailable" };
    },
  });
  if (slackProvider.inbound.kind !== "socket") assert.fail("slack inbound is socket");
  await slackProvider.inbound.run(CREDS, net, BOT, () => {}, abort.signal);
  assert.equal(sleeps.length, 2);
  assert.ok((sleeps[1] ?? 0) > (sleeps[0] ?? 0) / 2, "backoff grows");
  for (const ms of sleeps) assert.ok(ms <= 60_000);
});

test("R3 socket mode: an edit (message_changed with edited) and a deletion reach the sink as changes; the same ts is not deduped away; an unedited change is ignored", async () => {
  const { net, sockets } = slackNet({ "apps.connections.open": { body: api["apps.connections.open"] } });
  if (slackProvider.inbound.kind !== "socket") assert.fail("slack inbound is socket");
  const received: InboundMessage[] = [];
  const abort = new AbortController();
  const running = slackProvider.inbound.run(CREDS, net, BOT, (m) => received.push(m), abort.signal);
  await until(() => sockets.length === 1, "first socket");
  const socket = sockets[0] as FakeSocket;
  const wrap = (n: number, event: Record<string, unknown>) => ({
    envelope_id: `env-r3-${n}`,
    type: "events_api",
    payload: { team_id: "T0TESTTEAM", type: "event_callback", event_id: `Ev0R3EVENT${n}`, event_time: 1_700_000_300 + n, event },
  });
  const original = { type: "message", channel: "C0GENERAL1", user: "U0HUMAN001", text: "first", ts: "1700000200.000100", channel_type: "channel" };
  socket.emit(envelopes.hello);
  socket.emit(wrap(1, original));
  socket.emit(wrap(2, { type: "message", subtype: "message_changed", channel: "C0GENERAL1", channel_type: "channel", message: { ...original, text: "first, edited", edited: { user: "U0HUMAN001", ts: "1700000260.000200" } } }));
  socket.emit(wrap(3, { type: "message", subtype: "message_changed", channel: "C0GENERAL1", hidden: true, message: { ...original, text: "unfurl only" } }));
  socket.emit(wrap(4, { type: "message", subtype: "message_deleted", channel: "C0GENERAL1", deleted_ts: "1700000200.000100", previous_message: original }));
  assert.deepEqual(
    received.map((m) => [m.messageId, m.text, m.change]),
    [
      ["1700000200.000100", "first", undefined],
      ["1700000200.000100", "first, edited", { kind: "edit", at: 1_700_000_260_000 }],
      ["1700000200.000100", "", { kind: "delete" }],
    ],
  );
  assert.equal(received[2]?.conversation, "C0GENERAL1");
  abort.abort();
  await running;
});

test("R3 slack parser: another app's message carries senderIsBot; the bot's own edit and delete are ignored; the provider reports edits and deletions", async () => {
  const { parseSlackEvent } = await import("../src/channels/providers/slack.ts");
  const event = (e: Record<string, unknown>) => ({ type: "event_callback", team_id: "T0TESTTEAM", event_id: "Ev0PARSER01", event: { type: "message", channel: "C0GENERAL1", ts: "1700000200.000100", ...e } });
  const withUserBot = parseSlackEvent(event({ user: "U0APPUSER1", bot_id: "B0APP00001", text: "from an app" }), BOT, () => 1);
  assert.equal(withUserBot?.message.senderIsBot, true);
  assert.equal(withUserBot?.message.senderId, "U0APPUSER1");
  assert.equal(parseSlackEvent(event({ user: "U0HUMAN001", text: "hi" }), BOT, () => 1)?.message.senderIsBot, undefined);
  assert.equal(parseSlackEvent(event({ subtype: "message_deleted", deleted_ts: "1700000100.000100", previous_message: { user: BOT.botId } }), BOT, () => 1), null);
  assert.equal(parseSlackEvent(event({ subtype: "message_changed", message: { user: BOT.botId, text: "x", ts: "1700000100.000100", edited: { ts: "1700000150.000100" } } }), BOT, () => 1), null);
  assert.deepEqual(slackProvider.reports, { edits: true, deletions: true });
});

test("quality audit R2: a message the sink cannot store is not acked and not deduped, so Slack's redelivery is stored", async () => {
  const { net, sockets } = slackNet({ "apps.connections.open": { body: api["apps.connections.open"] } });
  if (slackProvider.inbound.kind !== "socket") assert.fail("slack inbound is socket");
  const received: InboundMessage[] = [];
  let failNext = true;
  const abort = new AbortController();
  const running = slackProvider.inbound.run(
    CREDS,
    net,
    BOT,
    (m) => {
      if (failNext) {
        failNext = false;
        throw new Error("database is locked");
      }
      received.push(m);
    },
    abort.signal,
  );
  await until(() => sockets.length === 1, "socket");
  const ws = sockets[0] as FakeSocket;
  ws.emit(envelopes.hello);
  ws.emit(envelopes.message);
  assert.deepEqual(ws.sent.map((s) => JSON.parse(s).envelope_id), [], "not acked: Slack sends it again");
  assert.equal(received.length, 0);
  ws.emit(envelopes.message); // Slack's redelivery of the unacked envelope
  assert.deepEqual(ws.sent.map((s) => JSON.parse(s).envelope_id), ["env-0001"]);
  assert.equal(received.length, 1, "the redelivery is stored, not deduped away");
  ws.emit(envelopes.message);
  assert.equal(received.length, 1, "a later repeat is still deduped (and acked)");
  assert.equal(ws.sent.length, 2);
  abort.abort();
  await running;
});
