/**
 * Slack channel provider (C58; harvest HARVEST-CHANNELS F3, ported from v1 providers/slack.ts).
 *
 * Credentials (two password fields the owner pastes from the Slack app config page):
 * - `bot_token` — `xoxb-…` bot user OAuth token. Every Web API call (`https://slack.com/api/<method>`, Bearer).
 * - `app_token` — `xapp-…` app-level token with the `connections:write` scope. Only Socket Mode inbound uses it
 *   (`apps.connections.open`), so no public route is needed for Slack.
 *
 * The app is created from `SLACK_APP_MANIFEST` (Socket Mode on, the bot scopes and events below).
 * Errors: Slack `ok:false` codes map to stable `ChannelError` codes; tokens are scrubbed from every message.
 */
import {
  type BotIdentity,
  type ChannelCredentials,
  ChannelError,
  type ChannelNet,
  type ChannelProvider,
  type Conversation,
  cleanInboundText,
  type InboundMessage,
  type InboundSink,
  mentionList,
  scrub,
} from "../provider.ts";

export const SLACK_API = "https://slack.com/api";
export const SLACK_MAX_TEXT_CHARS = 40_000;
/** Slack retries an event up to three times in about five minutes; 15 minutes covers every retry. */
export const SLACK_EVENT_DEDUPE_TTL_MS = 15 * 60_000;
export const SLACK_EVENT_DEDUPE_MAX_ENTRIES = 10_000;
/** One honoured Retry-After at most this long; a longer wait is refused as rate limited. */
export const SLACK_MAX_RETRY_AFTER_MS = 30_000;
export const SLACK_CONVERSATIONS_MAX = 200;
const SLACK_TIMEOUT_MS = 15_000;
const CONVERSATIONS_PAGE_SIZE = 200;
const CONVERSATIONS_MAX_PAGES = 10;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const MAX_RESPONSE_CHARS = 2 * 1024 * 1024;

const BOT_TOKEN = /^xoxb-[A-Za-z0-9-]{10,250}$/u;
const APP_TOKEN = /^xapp-[A-Za-z0-9-]{10,250}$/u;
const CONVERSATION_ID = /^[CGD][A-Z0-9]{2,30}$/u;
const USER_ID = /^[UW][A-Z0-9]{2,30}$/u;
const BOT_ID = /^B[A-Z0-9]{2,30}$/u;
const TEAM_ID = /^[TE][A-Z0-9]{2,30}$/u;
const TS = /^[0-9]{1,12}\.[0-9]{1,8}$/u;
const EVENT_ID = /^Ev[A-Za-z0-9]{2,40}$/u;
const EMOJI = /^:?([a-z0-9_+'-]{1,100}(?:::skin-tone-[2-6])?):?$/u;
const CURSOR = /^[A-Za-z0-9=+/_-]{1,512}$/u;
const SLACK_ERROR = /^[a-z0-9_.-]{1,64}$/u;
const SCOPE_LIST = /^[a-z:._-]{1,64}(?:,[a-z:._-]{1,64}){0,9}$/u;

/** The Slack app manifest the owner pastes at api.slack.com/apps → "Create New App" → "From an app manifest". */
export const SLACK_APP_MANIFEST = {
  _metadata: { major_version: 2, minor_version: 1 },
  display_information: {
    name: "Teal Brick Connect",
    description: "Your Teal Brick agents read and post in the Slack channels you invite them to.",
    background_color: "#0f5e5c", // check-system: allow (Slack app manifest value, not Connect UI)
  },
  features: {
    bot_user: { display_name: "Teal Brick", always_online: false },
  },
  oauth_config: {
    scopes: {
      bot: [
        "chat:write",
        "channels:read",
        "groups:read",
        "im:read",
        "im:write",
        "im:history",
        "channels:history",
        "groups:history",
        "reactions:write",
        "app_mentions:read",
        "users:read",
      ],
    },
  },
  settings: {
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
    event_subscriptions: {
      bot_events: ["message.channels", "message.groups", "message.im", "app_mention"],
    },
  },
} as const;

/** The scope a Web API method needs, named in `channel_scope_missing` when Slack does not say. */
const METHOD_SCOPE: Record<string, string> = {
  "chat.postMessage": "chat:write",
  "chat.update": "chat:write",
  "chat.delete": "chat:write",
  "reactions.add": "reactions:write",
  "conversations.open": "im:write",
  "conversations.list": "channels:read,groups:read",
  "apps.connections.open": "connections:write",
};

const CREDENTIAL_ERRORS = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "not_allowed_token_type"]);
const NOT_MEMBER_ERRORS = new Set(["channel_not_found", "not_in_channel"]);
const NOT_FOUND_ERRORS = new Set(["message_not_found", "thread_not_found", "user_not_found", "users_not_found"]);
const RATE_ERRORS = new Set(["ratelimited", "rate_limited"]);

// ---------------------------------------------------------------- Pure helpers

/** Slack mrkdwn control characters (`&`, `<`, `>`): escaping them stops `<!channel>`, `<@U…>` and link markup. */
export function escapeSlackText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function decodeSlackText(text: string): string {
  return text.replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function shortText(value: unknown, max: number): string {
  return typeof value === "string" ? cleanInboundText(value, max).trim() : "";
}

/** A bounded first-seen set with one TTL (insertion order = expiry order). */
export class ReplayGuard {
  readonly #seen = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;
  constructor(ttlMs: number, max: number, now: () => number) {
    this.#ttlMs = ttlMs;
    this.#max = max;
    this.#now = now;
  }
  /** Quality audit R2: a key whose message could not be stored is forgotten, so the platform's redelivery is taken. */
  forget(key: string): void {
    this.#seen.delete(key);
  }
  /** True the first time `key` is seen inside the window; false for a repeat. */
  firstSeen(key: string): boolean {
    const now = this.#now();
    for (const [k, expires] of this.#seen) {
      if (expires > now) break;
      this.#seen.delete(k);
    }
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, now + this.#ttlMs);
    while (this.#seen.size > this.#max) {
      const oldest = this.#seen.keys().next().value;
      if (oldest === undefined) break;
      this.#seen.delete(oldest);
    }
    return true;
  }
}

function botToken(creds: ChannelCredentials): string {
  const token = creds.bot_token?.trim();
  if (!token) throw new ChannelError("channel_credentials_missing", "Enter the Slack bot token (xoxb-…).");
  if (!BOT_TOKEN.test(token)) throw new ChannelError("channel_credentials_invalid", "The Slack bot token has an invalid shape. It starts with xoxb-.");
  return token;
}

function appToken(creds: ChannelCredentials): string {
  const token = creds.app_token?.trim();
  if (!token) throw new ChannelError("channel_credentials_missing", "Enter the Slack app-level token (xapp-…) with the connections:write scope.");
  if (!APP_TOKEN.test(token)) throw new ChannelError("channel_credentials_invalid", "The Slack app-level token has an invalid shape. It starts with xapp-.");
  return token;
}

function conversationId(value: unknown): string {
  if (typeof value !== "string" || !CONVERSATION_ID.test(value)) {
    throw new ChannelError("channel_input_invalid", "The Slack conversation id is invalid (C…, G… or D… expected).");
  }
  return value;
}

function messageTs(value: unknown, what = "message id"): string {
  if (typeof value !== "string" || !TS.test(value)) {
    throw new ChannelError("channel_input_invalid", `The Slack ${what} is invalid (a message ts such as 1700000000.000100 expected).`);
  }
  return value;
}

function outboundText(text: unknown): string {
  if (typeof text !== "string" || text.trim().length === 0) throw new ChannelError("channel_text_empty", "A Slack message needs text.");
  const escaped = escapeSlackText(text);
  if (escaped.length > SLACK_MAX_TEXT_CHARS) {
    throw new ChannelError("channel_text_too_long", `The text as sent to Slack is ${escaped.length} characters; Slack allows ${SLACK_MAX_TEXT_CHARS}.`);
  }
  return escaped;
}

/** Maps a Slack `ok:false` error code to a ChannelError. The code is a closed snake_case word, never echoed raw. */
export function slackError(error: unknown, method: string, needed?: unknown): ChannelError {
  const code = typeof error === "string" && SLACK_ERROR.test(error) ? error : "unknown_error";
  if (CREDENTIAL_ERRORS.has(code)) return new ChannelError("channel_credentials_rejected", `Slack rejected the token (${code}). Check or replace it.`, 401);
  if (NOT_MEMBER_ERRORS.has(code)) {
    return new ChannelError("channel_not_member", "The bot is not in this Slack channel. Invite the bot to the channel (/invite @bot), then try again.", 403);
  }
  if (code === "missing_scope") {
    const scope = typeof needed === "string" && SCOPE_LIST.test(needed) ? needed : (METHOD_SCOPE[method] ?? "unknown");
    return new ChannelError("channel_scope_missing", `The Slack app needs the ${scope} scope. Add it in the app config and reinstall the app.`, 403);
  }
  if (RATE_ERRORS.has(code)) return new ChannelError("channel_rate_limited", "Slack rate limit reached. Try again later.", 429);
  if (NOT_FOUND_ERRORS.has(code)) return new ChannelError("channel_not_found", `Slack could not find it (${code}).`, 404);
  if (code === "msg_too_long") return new ChannelError("channel_text_too_long", "Slack refused the text as too long.");
  return new ChannelError("channel_provider_error", `Slack refused the request (${code}).`, 502);
}

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : 1_000;
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) return undefined;
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

type Params = Record<string, string | number | boolean | undefined>;

/**
 * One Slack Web API call: form-encoded POST with a Bearer token, no redirects, 15 s timeout. An HTTP 429 or
 * `ratelimited` honours Retry-After once (≤ 30 s); everything else maps through `slackError`.
 */
async function slackCall(
  net: ChannelNet,
  token: string,
  method: string,
  params: Params,
  creds: ChannelCredentials,
  options: { signal?: AbortSignal; okErrors?: readonly string[] } = {},
): Promise<Record<string, unknown>> {
  const { signal, okErrors } = options;
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) form.append(key, String(value));
  for (let attempt = 0; ; attempt += 1) {
    const timeout = AbortSignal.timeout(SLACK_TIMEOUT_MS);
    let response: Response;
    try {
      response = await net.fetch(`${SLACK_API}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: form.toString(),
        redirect: "manual",
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch (error) {
      const detail = error instanceof Error ? scrub(error.message, creds).slice(0, 120) : "network error";
      throw new ChannelError("channel_provider_unavailable", `Slack did not answer (${detail}).`, 502);
    }
    const json = await readJson(response);
    if (response.status === 429 || (json && json.ok === false && RATE_ERRORS.has(String(json.error)))) {
      const wait = retryAfterMs(response);
      if (attempt === 0 && wait <= SLACK_MAX_RETRY_AFTER_MS) {
        await net.sleep(wait, signal);
        continue;
      }
      throw new ChannelError("channel_rate_limited", "Slack rate limit reached. Try again later.", 429);
    }
    if (json && json.ok === true) return json;
    if (json && json.ok === false) {
      if (okErrors?.includes(String(json.error))) return json;
      throw slackError(json.error, method, json.needed);
    }
    throw new ChannelError("channel_provider_unavailable", `Slack answered HTTP ${response.status} without a readable result.`, 502);
  }
}

// ---------------------------------------------------------------- Socket Mode

/**
 * Normalises one Socket Mode `events_api` payload, or returns null for anything the agent must not see.
 * R3: another bot's message is returned with `senderIsBot` (the hub keeps it for data apps only); an edit
 * (`message_changed`, only when Slack marks the inner message `edited`) carries `change: edit`; a `message_deleted`
 * carries `change: delete` (conversation and message id only).
 */
export function parseSlackEvent(payload: unknown, bot: BotIdentity, now: () => number): { eventId: string; message: InboundMessage } | null {
  const record = asRecord(payload);
  if (record?.type !== "event_callback") return null;
  if (typeof bot.workspace !== "string" || !TEAM_ID.test(bot.workspace) || record.team_id !== bot.workspace) return null;
  const eventId = record.event_id;
  const outer = asRecord(record.event);
  if (typeof eventId !== "string" || !EVENT_ID.test(eventId) || !outer) return null;
  if (outer.type !== "message" && outer.type !== "app_mention") return null;
  const outerChannel = outer.channel;
  if (outer.subtype === "message_deleted") {
    const deletedTs = outer.deleted_ts;
    if (typeof outerChannel !== "string" || !CONVERSATION_ID.test(outerChannel) || typeof deletedTs !== "string" || !TS.test(deletedTs)) return null;
    const previous = asRecord(outer.previous_message);
    if (previous?.user === bot.botId) return null;
    return {
      eventId,
      message: { conversation: outerChannel, conversationType: "channel", messageId: deletedTs, threadId: null, senderId: "", senderName: "", text: "", sentAt: now(), change: { kind: "delete" } },
    };
  }
  let event = outer;
  let edit: { kind: "edit"; at: number } | undefined;
  if (outer.subtype === "message_changed") {
    const inner = asRecord(outer.message);
    const editedTs = Number(asRecord(inner?.edited)?.ts);
    if (!inner || !Number.isFinite(editedTs) || editedTs <= 0) return null;
    event = { ...inner, type: "message", channel: outer.channel, channel_type: outer.channel_type };
    edit = { kind: "edit", at: Math.round(editedTs * 1000) };
  }
  const subtype = event.subtype;
  const botSender = subtype === "bot_message" || (typeof event.bot_id === "string" && event.bot_id.length > 0);
  // Edits (message_changed), deletes (message_deleted), joins and the rest are not new messages.
  if (subtype !== undefined && subtype !== "thread_broadcast" && subtype !== "file_share" && subtype !== "bot_message") return null;
  const { channel, ts } = event;
  if (typeof channel !== "string" || !CONVERSATION_ID.test(channel) || typeof ts !== "string" || !TS.test(ts)) return null;
  const user = typeof event.user === "string" && event.user.length > 0 ? event.user : event.bot_id;
  if (typeof user !== "string" || !(USER_ID.test(user) || (botSender && BOT_ID.test(user))) || user === bot.botId) return null;
  const threadTs = typeof event.thread_ts === "string" && TS.test(event.thread_ts) && event.thread_ts !== ts ? event.thread_ts : null;
  const channelType = event.channel_type;
  const conversationType = channelType === "im" || (channelType === undefined && channel.startsWith("D")) ? "direct" : channelType === "mpim" ? "group" : "channel";
  const profile = asRecord(event.user_profile) ?? {};
  const senderName = shortText(profile.display_name, 80) || shortText(profile.real_name, 80) || shortText(profile.name, 80) || shortText(event.username, 80) || user;
  const raw = typeof event.text === "string" ? event.text : "";
  // The bot's own mention token is addressing, not content.
  const text = cleanInboundText(decodeSlackText(raw.split(`<@${bot.botId}>`).join("")).trim());
  // F15: `<@U…>` / `<@U…|name>` user mentions (the bot's own included) from the raw text; app_mention addresses the bot.
  const mentioned = [...raw.matchAll(/<@([UW][A-Z0-9]{2,30})(?:\|[^>]*)?>/gu)].map((m) => m[1] as string);
  if (event.type === "app_mention") mentioned.push(bot.botId);
  const seconds = Number(ts);
  return {
    eventId,
    message: {
      conversation: channel,
      conversationType,
      messageId: ts,
      threadId: threadTs,
      senderId: user,
      senderName,
      text,
      sentAt: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : now(),
      mentions: mentionList(mentioned),
      ...(edit ? { change: edit } : {}),
      ...(botSender ? { senderIsBot: true as const } : {}),
    },
  };
}

function frameText(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return undefined;
}

type SocketEnd = { hello: boolean; reason: "abort" | "disconnect" | "closed" };

/** One Socket Mode connection: ack every envelope, hand messages to the sink, resolve when the socket ends. */
function runSocket(
  url: string,
  net: ChannelNet,
  bot: BotIdentity,
  sink: InboundSink,
  dedupe: ReplayGuard,
  signal: AbortSignal,
): Promise<SocketEnd> {
  return new Promise((resolve) => {
    let hello = false;
    let settled = false;
    let ws: WebSocket;
    const finish = (reason: SocketEnd["reason"]) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      try {
        ws.close(1000);
      } catch {
        // already closed
      }
      resolve({ hello, reason });
    };
    const onAbort = () => finish("abort");
    try {
      ws = net.webSocket(url);
    } catch {
      resolve({ hello, reason: "closed" });
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      finish("abort");
      return;
    }
    ws.addEventListener("message", (event: MessageEvent) => {
      if (settled) return;
      const text = frameText(event.data);
      let envelope: Record<string, unknown> | undefined;
      try {
        envelope = text === undefined ? undefined : asRecord(JSON.parse(text));
      } catch {
        envelope = undefined;
      }
      if (!envelope) return;
      const ack = () => {
        if (typeof envelope.envelope_id !== "string" || envelope.envelope_id.length > 200) return;
        try {
          ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        } catch {
          // the close handler reconnects
        }
      };
      // Quality audit R2: an events_api envelope is acked only once its message is handled; anything else at once
      if (envelope.type !== "events_api") ack();
      if (envelope.type === "hello") {
        hello = true;
      } else if (envelope.type === "disconnect") {
        finish("disconnect");
      } else if (envelope.type === "events_api") {
        const parsed = parseSlackEvent(envelope.payload, bot, net.now);
        if (!parsed) return ack();
        // event_id stops Slack's retries; channel:ts stops the `message` + `app_mention` pair of one mention.
        const eventKey = `event:${parsed.eventId}`;
        const eventFresh = dedupe.firstSeen(eventKey);
        // An edit or a deletion of a message is a different event from the message itself (R3).
        const change = parsed.message.change;
        const kind = change ? (change.kind === "edit" ? `edit:${change.at}` : "delete") : "message";
        const messageKey = `${kind}:${parsed.message.conversation}:${parsed.message.messageId}`;
        const messageFresh = dedupe.firstSeen(messageKey);
        if (!eventFresh || !messageFresh) return ack();
        try {
          sink(parsed.message);
        } catch {
          // Quality audit R2: not stored (the hub logged and counted it). No ack and no dedupe mark: Slack sends it again
          // (Socket Mode redelivers an unacked event a few times). A sink failure never drops the connection.
          dedupe.forget(eventKey);
          dedupe.forget(messageKey);
          return;
        }
        ack();
      }
    });
    ws.addEventListener("close", () => finish("closed"));
    ws.addEventListener("error", () => finish("closed"));
  });
}

function isSlackSocketUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "wss:" && !url.username && !url.password && !url.port && (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com"));
  } catch {
    return false;
  }
}

function backoffMs(failures: number): number {
  const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures, 10));
  return Math.round(cap / 2 + Math.random() * (cap / 2));
}

async function pause(net: ChannelNet, ms: number, signal: AbortSignal): Promise<void> {
  try {
    await net.sleep(ms, signal);
  } catch {
    // aborted
  }
}

/**
 * Socket Mode loop: `apps.connections.open` (app token) → wss URL → socket. A `disconnect` envelope reconnects at
 * once; a dropped socket or failed open reconnects after a capped, jittered backoff. A rejected app token throws.
 */
async function runSocketMode(creds: ChannelCredentials, net: ChannelNet, bot: BotIdentity, sink: InboundSink, signal: AbortSignal): Promise<void> {
  const token = appToken(creds);
  const dedupe = new ReplayGuard(SLACK_EVENT_DEDUPE_TTL_MS, SLACK_EVENT_DEDUPE_MAX_ENTRIES, net.now);
  let failures = 0;
  while (!signal.aborted) {
    let url: string;
    try {
      const opened = await slackCall(net, token, "apps.connections.open", {}, creds, { signal });
      if (!isSlackSocketUrl(opened.url)) throw new ChannelError("channel_provider_unavailable", "Slack returned no usable Socket Mode URL.", 502);
      url = opened.url;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ChannelError && (error.code === "channel_credentials_rejected" || error.code === "channel_scope_missing")) {
        throw new ChannelError("channel_credentials_rejected", scrub(error.message, creds), 401);
      }
      failures += 1;
      await pause(net, backoffMs(failures), signal);
      continue;
    }
    const end = await runSocket(url, net, bot, sink, dedupe, signal);
    if (end.reason === "abort" || signal.aborted) return;
    if (end.hello) failures = 0;
    if (end.reason === "disconnect" && end.hello) continue;
    failures += 1;
    await pause(net, backoffMs(failures), signal);
  }
}

// ---------------------------------------------------------------- Provider

async function withScrub<T>(creds: ChannelCredentials, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ChannelError) {
      const clean = scrub(error.message, creds);
      throw clean === error.message ? error : new ChannelError(error.code, clean, error.httpStatus);
    }
    throw new ChannelError("channel_provider_error", scrub(error instanceof Error ? error.message : String(error), creds).slice(0, 200), 502);
  }
}

export const slackProvider: ChannelProvider = {
  service: "slack",
  credentialFields: ["bot_token", "app_token"],
  maxTextLength: SLACK_MAX_TEXT_CHARS,

  verify: (creds, net) =>
    withScrub(creds, async () => {
      const token = botToken(creds);
      appToken(creds);
      const auth = await slackCall(net, token, "auth.test", {}, creds);
      const userId = auth.user_id;
      const teamId = auth.team_id;
      if (typeof userId !== "string" || !USER_ID.test(userId) || typeof teamId !== "string" || !TEAM_ID.test(teamId)) {
        throw new ChannelError("channel_provider_unavailable", "Slack auth.test answered without a bot user or team id.", 502);
      }
      // botId is the bot USER id (U…): the id mentions use and inbound ignores as the bot's own.
      return { botId: userId, botName: shortText(auth.user, 80) || userId, workspace: teamId };
    }),

  conversations: (creds, net) =>
    withScrub(creds, async () => {
      const token = botToken(creds);
      const out: Conversation[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < CONVERSATIONS_MAX_PAGES && out.length < SLACK_CONVERSATIONS_MAX; page += 1) {
        const body = await slackCall(
          net,
          token,
          "conversations.list",
          { types: "public_channel,private_channel", exclude_archived: true, limit: CONVERSATIONS_PAGE_SIZE, cursor },
          creds,
        );
        const channels = Array.isArray(body.channels) ? body.channels : [];
        for (const raw of channels) {
          const channel = asRecord(raw);
          if (!channel || typeof channel.id !== "string" || !CONVERSATION_ID.test(channel.id)) continue;
          // chat:write without chat:write.public posts only where the bot is a member.
          if (channel.is_member !== true || channel.is_archived === true || channel.is_im === true || channel.is_mpim === true) continue;
          out.push({ id: channel.id, name: shortText(channel.name, 80) || channel.id, type: "channel" });
          if (out.length >= SLACK_CONVERSATIONS_MAX) break;
        }
        const next = asRecord(body.response_metadata)?.next_cursor;
        if (typeof next !== "string" || !CURSOR.test(next)) break;
        cursor = next;
      }
      return out;
    }),

  send: (creds, net, input) =>
    withScrub(creds, async () => {
      const token = botToken(creds);
      const channel = conversationId(input.conversation);
      const text = outboundText(input.text);
      const threadTs = input.threadId == null ? undefined : messageTs(input.threadId, "thread id");
      const body = await slackCall(
        net,
        token,
        "chat.postMessage",
        { channel, text, thread_ts: threadTs, mrkdwn: true, parse: "none", link_names: false, unfurl_links: false },
        creds,
      );
      if (typeof body.ts !== "string" || !TS.test(body.ts)) {
        throw new ChannelError("channel_provider_unavailable", "Slack answered success without a message ts; delivery is unknown.", 502);
      }
      return { messageId: body.ts };
    }),

  edit: (creds, net, input) =>
    withScrub(creds, async () => {
      const token = botToken(creds);
      const channel = conversationId(input.conversation);
      const ts = messageTs(input.messageId);
      const text = outboundText(input.text);
      await slackCall(net, token, "chat.update", { channel, ts, text, parse: "none", link_names: false }, creds);
    }),

  delete: (creds, net, input) =>
    withScrub(creds, async () => {
      const token = botToken(creds);
      const channel = conversationId(input.conversation);
      const ts = messageTs(input.messageId);
      await slackCall(net, token, "chat.delete", { channel, ts }, creds);
    }),

  react: (creds, net, input) =>
    withScrub(creds, async () => {
      const token = botToken(creds);
      const channel = conversationId(input.conversation);
      const timestamp = messageTs(input.messageId);
      const name = typeof input.emoji === "string" ? EMOJI.exec(input.emoji.trim())?.[1] : undefined;
      if (!name) throw new ChannelError("channel_input_invalid", "The emoji must be a Slack emoji name such as thumbsup or :tada:.");
      // Reacting twice is a no-op, not a failure.
      await slackCall(net, token, "reactions.add", { channel, timestamp, name }, creds, { okErrors: ["already_reacted"] });
    }),

  openDirect: (creds, net, input) =>
    withScrub(creds, async () => {
      const token = botToken(creds);
      if (typeof input.personId !== "string" || !USER_ID.test(input.personId)) {
        throw new ChannelError("channel_input_invalid", "The Slack person id is invalid (a user id such as U0123ABCD expected).");
      }
      const body = await slackCall(net, token, "conversations.open", { users: input.personId, return_im: false }, creds);
      const id = asRecord(body.channel)?.id;
      if (typeof id !== "string" || !CONVERSATION_ID.test(id)) {
        throw new ChannelError("channel_provider_unavailable", "Slack answered success without a conversation id.", 502);
      }
      return { conversation: id };
    }),

  // R3: message_changed / message_deleted are read.
  reports: { edits: true, deletions: true },
  inbound: {
    kind: "socket",
    run: (creds, net, bot, sink, signal) => withScrub(creds, () => runSocketMode(creds, net, bot, sink, signal)),
  },
};
