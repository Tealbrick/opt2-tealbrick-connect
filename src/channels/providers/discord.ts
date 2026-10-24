/**
 * Discord provider (C58; harvest HARVEST-CHANNELS F6, v1 providers/discord.ts + channels/discord-gateway.ts).
 * REST v10 with `Authorization: Bot <token>`; inbound over the gateway WebSocket (outbound connection, no public route).
 *
 * - Credentials: `bot_token`. Setting `message_content` (boolean, default false): the channel service passes account
 *   settings merged into `creds` as strings, so this provider reads `creds.message_content === "true"`. When true,
 *   IDENTIFY asks for the privileged MESSAGE_CONTENT intent, which must also be on in the Discord developer portal
 *   (else Discord closes with 4014). Without it Discord sends empty text except in DMs and messages that mention the bot.
 * - verify: GET /users/@me (+ GET /oauth2/applications/@me for the application id as `workspace`, when it answers).
 * - conversations: the bot's guilds, then each guild's text (0) and announcement (5) channels, at most 200.
 * - send/edit never ping anyone (`allowed_mentions.parse = []`). `threadId` is a message id: the post replies to it.
 * - inbound `socket`: MESSAGE_CREATE → InboundMessage. `threadId` is the replied-to message id for replies (a Discord
 *   thread is a channel of its own, so it is the `conversation`). DMs (no guild_id) are `direct`.
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
  type SendInput,
} from "../provider.ts";
import { asRecord, backoffMs, cleanName, type ProviderResponse, pause, providerDetail, providerRequest, rateLimited } from "./http.ts";

const API_BASE = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://tealbrick.com, 1)";
const SERVICE = "Discord";
export const DISCORD_MAX_TEXT = 2000;
export const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
/** A READY `resume_gateway_url` is used only on a Discord gateway host; else the fixed URL and a fresh IDENTIFY. */
const DISCORD_RESUME_URL = /^wss:\/\/([a-z0-9-]+\.)*discord\.gg(:443)?\/?$/u;
const MAX_CONVERSATIONS = 200;
const HELLO_TIMEOUT_MS = 30_000;
const SNOWFLAKE = /^[0-9]{1,25}$/u;
const TOKEN_SHAPE = /^[\x21-\x7e]{20,200}$/u;
const CUSTOM_EMOJI = /^(?:<a?:([A-Za-z0-9_]{2,32}):([0-9]{1,25})>|([A-Za-z0-9_]{2,32}):([0-9]{1,25}))$/u;
// A keycap, or 1-16 code points with no ASCII, whitespace or control character.
const UNICODE_EMOJI = /^(?:[0-9#*]\ufe0f?\u20e3|[^\p{ASCII}\s\p{Cc}]{1,16})$/u;

export const DISCORD_INTENTS = Object.freeze({ GUILDS: 1 << 0, GUILD_MESSAGES: 1 << 9, DIRECT_MESSAGES: 1 << 12, MESSAGE_CONTENT: 1 << 15 });

export function discordIntents(messageContent: boolean): number {
  return DISCORD_INTENTS.GUILDS | DISCORD_INTENTS.GUILD_MESSAGES | DISCORD_INTENTS.DIRECT_MESSAGES | (messageContent ? DISCORD_INTENTS.MESSAGE_CONTENT : 0);
}

/** Close codes after which reconnecting cannot help (v1 discord-gateway.ts:44-51). */
const REFUSED_CLOSE: Readonly<Record<number, string>> = {
  4010: "Discord refused the connection: invalid shard.",
  4011: "Discord requires sharding for this bot (it is in too many servers for one connection).",
  4012: "Discord refused the gateway API version.",
  4013: "Discord refused the requested intents (invalid intents).",
  4014: "Discord refused a privileged intent. Turn on MESSAGE CONTENT INTENT for the bot in the Discord developer portal, or switch off \"Read message text\".",
};
/** Close codes after which the session cannot be resumed. */
const NO_RESUME_CLOSE = new Set([4007, 4009]);

function tokenOf(creds: ChannelCredentials): string {
  const token = creds.bot_token?.trim() ?? "";
  if (!token) throw new ChannelError("channel_credentials_missing", "Enter the Discord bot token (Developer Portal → Bot → Reset Token).");
  if (!TOKEN_SHAPE.test(token)) throw new ChannelError("channel_credentials_invalid", "The Discord bot token has the wrong shape. Paste the token itself, without \"Bot \".");
  return token;
}

function snowflakeOf(value: string | null | undefined, code: string, what: string): string {
  if (typeof value !== "string" || !SNOWFLAKE.test(value)) throw new ChannelError(code, `${what} must be a Discord id (digits).`);
  return value;
}

function textOf(text: string): string {
  if (typeof text !== "string" || text.trim().length === 0) throw new ChannelError("channel_message_empty", "The message has no text.");
  if (text.length > DISCORD_MAX_TEXT) {
    throw new ChannelError("channel_text_too_long", `The text is ${text.length} characters; Discord allows ${DISCORD_MAX_TEXT}.`);
  }
  return text;
}

/** URL path segment of a reaction: a Unicode emoji, or a custom emoji `name:id` (also from `<:name:id>`). */
export function discordReactionPath(emoji: string): string | null {
  if (typeof emoji !== "string") return null;
  const trimmed = emoji.trim();
  const custom = CUSTOM_EMOJI.exec(trimmed);
  if (custom) return encodeURIComponent(`${custom[1] ?? custom[3]}:${custom[2] ?? custom[4]}`);
  return UNICODE_EMOJI.test(trimmed) ? encodeURIComponent(trimmed) : null;
}

function failure(response: ProviderResponse, creds: ChannelCredentials): ChannelError {
  const record = asRecord(response.json);
  const code = typeof record?.code === "number" ? record.code : null;
  const detail = providerDetail(record?.message, creds);
  const status = response.status;
  if (status === 401) return new ChannelError("channel_credentials_rejected", "Discord rejected the bot token. Reset it in the Discord developer portal and enter the new one.", 401);
  if (status === 429) return rateLimited(SERVICE, response);
  if (code === 50001 || code === 50013) {
    return new ChannelError(
      "channel_not_member",
      "The bot cannot see or post in this channel. Invite the bot to the server and give it View Channel and Send Messages there.",
      403,
    );
  }
  if (code === 50007) return new ChannelError("channel_dm_not_allowed", "Discord does not let the bot message this person (no shared server, or DMs closed).", 403);
  if (status === 403) return new ChannelError("channel_forbidden", `Discord refused this action${detail ? `: ${detail}` : "."}`, 403);
  if (status === 404) return new ChannelError("channel_not_found", `Discord could not find this channel, message or person${detail ? `: ${detail}` : "."}`, 404);
  if (status >= 500) return new ChannelError("channel_provider_unavailable", "Discord is not available right now. Try again later.", 502);
  return new ChannelError("channel_rejected", `Discord refused this action${detail ? `: ${detail}` : "."}`, 400);
}

async function call(
  creds: ChannelCredentials,
  net: ChannelNet,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<ProviderResponse> {
  const token = tokenOf(creds);
  const response = await providerRequest(
    net,
    { method, url: `${API_BASE}${path}`, headers: { authorization: `Bot ${token}`, "user-agent": USER_AGENT }, ...(body === undefined ? {} : { body }) },
    SERVICE,
  );
  if (response.status < 200 || response.status >= 300) throw failure(response, creds);
  return response;
}

function badResponse(what: string): ChannelError {
  return new ChannelError("channel_provider_bad_response", `Discord answered ${what} but the reply was not understood.`, 502);
}

async function verify(creds: ChannelCredentials, net: ChannelNet): Promise<BotIdentity> {
  const me = asRecord((await call(creds, net, "GET", "/users/@me")).json);
  if (!me || typeof me.id !== "string" || !SNOWFLAKE.test(me.id)) throw badResponse("/users/@me");
  let workspace: string | undefined;
  try {
    const app = asRecord((await call(creds, net, "GET", "/oauth2/applications/@me")).json);
    if (typeof app?.id === "string" && SNOWFLAKE.test(app.id)) workspace = app.id;
  } catch {
    // Optional: the identity stands without the application id.
  }
  return { botId: me.id, botName: cleanName(me.username, 64) || me.id, ...(workspace ? { workspace } : {}) };
}

async function conversations(creds: ChannelCredentials, net: ChannelNet): Promise<Conversation[]> {
  const guilds = (await call(creds, net, "GET", "/users/@me/guilds")).json;
  if (!Array.isArray(guilds)) throw badResponse("/users/@me/guilds");
  const out: Conversation[] = [];
  for (const raw of guilds) {
    if (out.length >= MAX_CONVERSATIONS) break;
    const guild = asRecord(raw);
    if (!guild || typeof guild.id !== "string" || !SNOWFLAKE.test(guild.id)) continue;
    let channels: unknown;
    try {
      channels = (await call(creds, net, "GET", `/guilds/${guild.id}/channels`)).json;
    } catch (error) {
      // A guild the bot cannot read any more is skipped; the others are still listed.
      if (error instanceof ChannelError && ["channel_forbidden", "channel_not_found", "channel_not_member"].includes(error.code)) continue;
      throw error;
    }
    if (!Array.isArray(channels)) continue;
    const guildName = cleanName(guild.name, 60);
    const text = channels
      .map((c) => asRecord(c))
      .filter((c): c is Record<string, unknown> => !!c && (c.type === 0 || c.type === 5) && typeof c.id === "string" && SNOWFLAKE.test(c.id))
      .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
    for (const channel of text) {
      if (out.length >= MAX_CONVERSATIONS) break;
      const name = cleanName(channel.name, 80) || String(channel.id);
      out.push({ id: String(channel.id), name: guildName ? `${guildName} / #${name}` : `#${name}`, type: "channel" });
    }
  }
  return out;
}

async function send(creds: ChannelCredentials, net: ChannelNet, input: SendInput): Promise<{ messageId: string }> {
  tokenOf(creds);
  const channel = snowflakeOf(input.conversation, "channel_conversation_invalid", "The conversation");
  const content = textOf(input.text);
  const reply = input.threadId ? snowflakeOf(input.threadId, "channel_message_id_invalid", "threadId") : null;
  const res = await call(creds, net, "POST", `/channels/${channel}/messages`, {
    content,
    allowed_mentions: { parse: [] },
    ...(reply ? { message_reference: { message_id: reply, fail_if_not_exists: true } } : {}),
  });
  const id = asRecord(res.json)?.id;
  if (typeof id !== "string" || !SNOWFLAKE.test(id)) throw badResponse("the send");
  return { messageId: id };
}

async function edit(creds: ChannelCredentials, net: ChannelNet, input: { conversation: string; messageId: string; text: string }): Promise<void> {
  tokenOf(creds);
  const channel = snowflakeOf(input.conversation, "channel_conversation_invalid", "The conversation");
  const message = snowflakeOf(input.messageId, "channel_message_id_invalid", "messageId");
  await call(creds, net, "PATCH", `/channels/${channel}/messages/${message}`, { content: textOf(input.text), allowed_mentions: { parse: [] } });
}

async function remove(creds: ChannelCredentials, net: ChannelNet, input: { conversation: string; messageId: string }): Promise<void> {
  tokenOf(creds);
  const channel = snowflakeOf(input.conversation, "channel_conversation_invalid", "The conversation");
  const message = snowflakeOf(input.messageId, "channel_message_id_invalid", "messageId");
  await call(creds, net, "DELETE", `/channels/${channel}/messages/${message}`);
}

async function react(creds: ChannelCredentials, net: ChannelNet, input: { conversation: string; messageId: string; emoji: string }): Promise<void> {
  tokenOf(creds);
  const channel = snowflakeOf(input.conversation, "channel_conversation_invalid", "The conversation");
  const message = snowflakeOf(input.messageId, "channel_message_id_invalid", "messageId");
  const emoji = discordReactionPath(input.emoji);
  if (!emoji) throw new ChannelError("channel_reaction_invalid", "A Discord reaction is one Unicode emoji or a custom emoji as name:id.");
  await call(creds, net, "PUT", `/channels/${channel}/messages/${message}/reactions/${emoji}/@me`);
}

async function openDirect(creds: ChannelCredentials, net: ChannelNet, input: { personId: string }): Promise<{ conversation: string }> {
  tokenOf(creds);
  const person = snowflakeOf(input.personId, "channel_person_invalid", "The person id");
  const channel = asRecord((await call(creds, net, "POST", "/users/@me/channels", { recipient_id: person })).json);
  if (!channel || typeof channel.id !== "string" || !SNOWFLAKE.test(channel.id)) throw badResponse("the direct message channel");
  return { conversation: channel.id };
}

/**
 * Gateway MESSAGE_CREATE data → InboundMessage, or null when ignored (v1 parseDiscordMessageCreate,
 * discord.ts:765-817): bots, webhooks and the bot itself ignored; only DEFAULT (0) and REPLY (19) messages;
 * attachments as short placeholders; no guild_id → direct.
 */
export function parseDiscordMessage(data: unknown, botUserIds: readonly string[], now: number): InboundMessage | null {
  const d = asRecord(data);
  if (!d) return null;
  const author = asRecord(d.author);
  const { id, channel_id: channelId } = d;
  if (typeof id !== "string" || !SNOWFLAKE.test(id) || typeof channelId !== "string" || !SNOWFLAKE.test(channelId)) return null;
  if (!author || typeof author.id !== "string" || !SNOWFLAKE.test(author.id)) return null;
  if (botUserIds.includes(author.id)) return null;
  const senderIsBot = author.bot === true || (typeof d.webhook_id === "string" && d.webhook_id.length > 0);
  if (d.type !== undefined && d.type !== 0 && d.type !== 19) return null;
  const files = (Array.isArray(d.attachments) ? d.attachments : [])
    .slice(0, 10)
    .map((a) => asRecord(a))
    .filter((a): a is Record<string, unknown> => !!a)
    .map((a) => `[attachment${cleanName(a.filename, 60) ? `: ${cleanName(a.filename, 60)}` : ""}]`);
  const content = typeof d.content === "string" ? d.content : "";
  const text = cleanInboundText([content, ...files].filter((p) => p.length > 0).join("\n"));
  if (text.trim().length === 0) return null;
  const member = asRecord(d.member);
  const senderName = cleanName(member?.nick) || cleanName(author.global_name) || cleanName(author.username) || author.id;
  const reference = asRecord(d.message_reference)?.message_id;
  const replyTo = d.type === 19 && typeof reference === "string" && SNOWFLAKE.test(reference) ? reference : null;
  const sentAt = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : Number.NaN;
  const guild = typeof d.guild_id === "string" && SNOWFLAKE.test(d.guild_id);
  return {
    conversation: channelId,
    ...(guild ? {} : { conversationName: senderName }),
    conversationType: guild ? "channel" : "direct",
    messageId: id,
    threadId: replyTo,
    senderId: author.id,
    senderName,
    text,
    sentAt: Number.isFinite(sentAt) ? sentAt : now,
    // F15: the gateway's resolved user mentions, plus `<@id>` / `<@!id>` tokens in the text.
    mentions: mentionList([
      ...(Array.isArray(d.mentions) ? d.mentions : []).map((m) => asRecord(m)?.id).filter((v): v is string => typeof v === "string" && SNOWFLAKE.test(v)),
      ...[...content.matchAll(/<@!?(\d{5,25})>/gu)].map((m) => m[1] as string),
    ]),
    ...(senderIsBot ? { senderIsBot: true as const } : {}),
  };
}

/**
 * R3: gateway MESSAGE_UPDATE data → an edit, only when Discord says the message was edited (`edited_timestamp`) and sent
 * the author and text (a partial update, for example a link preview, is ignored).
 */
export function parseDiscordUpdate(data: unknown, botUserIds: readonly string[], now: number): InboundMessage | null {
  const d = asRecord(data);
  const edited = typeof d?.edited_timestamp === "string" ? Date.parse(d.edited_timestamp) : Number.NaN;
  if (!Number.isFinite(edited)) return null;
  const message = parseDiscordMessage(data, botUserIds, now);
  return message ? { ...message, change: { kind: "edit", at: edited } } : null;
}

/** R3: gateway MESSAGE_DELETE / MESSAGE_DELETE_BULK data → one deletion per message id (conversation and id only). */
export function parseDiscordDeletes(data: unknown, now: number): InboundMessage[] {
  const d = asRecord(data);
  const channelId = d?.channel_id;
  if (!d || typeof channelId !== "string" || !SNOWFLAKE.test(channelId)) return [];
  const ids = Array.isArray(d.ids) ? d.ids : [d.id];
  return ids
    .filter((id): id is string => typeof id === "string" && SNOWFLAKE.test(id))
    .slice(0, 100)
    .map((id) => ({
      conversation: channelId,
      conversationType: typeof d.guild_id === "string" ? ("channel" as const) : ("direct" as const),
      messageId: id,
      threadId: null,
      senderId: "",
      senderName: "",
      text: "",
      sentAt: now,
      change: { kind: "delete" as const },
    }));
}

type GatewayPayload = { op?: unknown; d?: unknown; s?: unknown; t?: unknown };
type SessionEnd = { kind: "reconnect"; delayMs?: number } | { kind: "aborted" } | { kind: "fatal"; error: ChannelError };

interface GatewayState {
  sessionId: string | null;
  resumeUrl: string | null;
  seq: number | null;
  botUserIds: string[];
  attempts: number;
}

function clearSession(state: GatewayState): void {
  state.sessionId = null;
  state.resumeUrl = null;
  state.seq = null;
}

function frameText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return null;
}

/** One gateway connection, from open to close. Resolves with what the run loop does next; never rejects. */
function gatewaySession(
  token: string,
  messageContent: boolean,
  net: ChannelNet,
  state: GatewayState,
  sink: InboundSink,
  signal: AbortSignal,
): Promise<SessionEnd> {
  return new Promise<SessionEnd>((resolve) => {
    const resuming = Boolean(state.sessionId && state.resumeUrl && state.seq !== null);
    const url = resuming ? `${(state.resumeUrl as string).replace(/\/$/u, "")}/?v=10&encoding=json` : DISCORD_GATEWAY_URL;
    const conn = new AbortController();
    const connSignal = AbortSignal.any([signal, conn.signal]);
    let ws: WebSocket;
    let done = false;
    let acked = true;
    let gotHello = false;

    const finish = (end: SessionEnd, closeCode: number) => {
      if (done) return;
      done = true;
      conn.abort();
      signal.removeEventListener("abort", onAbort);
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close(closeCode);
      } catch {
        // already closed
      }
      resolve(end);
    };
    const onAbort = () => finish({ kind: "aborted" }, 1000);
    const send = (payload: Record<string, unknown>) => {
      try {
        ws.send(JSON.stringify(payload));
      } catch {
        // A send on a closing socket is lost; the close handler reconnects.
      }
    };

    try {
      ws = net.webSocket(url);
    } catch {
      resolve({ kind: "reconnect" });
      return;
    }
    try {
      ws.binaryType = "arraybuffer";
    } catch {
      // not settable on this socket
    }
    if (signal.aborted) {
      done = true;
      try {
        ws.close(1000);
      } catch {
        // ignore
      }
      resolve({ kind: "aborted" });
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    // No HELLO in time: a dead connection.
    void pause(net, HELLO_TIMEOUT_MS, connSignal).then(() => {
      if (!done && !gotHello && !connSignal.aborted) finish({ kind: "reconnect" }, 4000);
    });

    const heartbeat = async (intervalMs: number) => {
      await pause(net, intervalMs * Math.random(), connSignal);
      while (!connSignal.aborted && !done) {
        if (!acked) {
          // No ACK since the last beat: a zombie connection. Close with a non-1000 code so the session stays resumable.
          finish({ kind: "reconnect" }, 4000);
          return;
        }
        acked = false;
        send({ op: 1, d: state.seq });
        await pause(net, intervalMs, connSignal);
      }
    };

    const onDispatch = (payload: GatewayPayload) => {
      const data = asRecord(payload.d);
      if (payload.t === "READY" && data) {
        state.sessionId = typeof data.session_id === "string" ? data.session_id : null;
        const resumeUrl = typeof data.resume_gateway_url === "string" ? data.resume_gateway_url.toLowerCase() : "";
        state.resumeUrl = DISCORD_RESUME_URL.test(resumeUrl) ? resumeUrl : null;
        const userId = asRecord(data.user)?.id;
        if (typeof userId === "string" && !state.botUserIds.includes(userId)) state.botUserIds.push(userId);
        state.attempts = 0;
        return;
      }
      if (payload.t === "RESUMED") {
        state.attempts = 0;
        return;
      }
      const messages =
        payload.t === "MESSAGE_CREATE"
          ? [parseDiscordMessage(data, state.botUserIds, net.now())]
          : payload.t === "MESSAGE_UPDATE"
            ? [parseDiscordUpdate(data, state.botUserIds, net.now())]
            : payload.t === "MESSAGE_DELETE" || payload.t === "MESSAGE_DELETE_BULK"
              ? parseDiscordDeletes(data, net.now())
              : [];
      for (const message of messages) {
        if (!message) continue;
        try {
          sink(message);
        } catch {
          // The sink never breaks the gateway loop. Quality audit R2: the hub logged and counted the message that could not
          // be stored and shows it on the bot; the Discord gateway does not deliver an event twice.
        }
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      if (done) return;
      const raw = frameText(event.data);
      if (raw === null) return;
      let payload: GatewayPayload;
      try {
        payload = JSON.parse(raw) as GatewayPayload;
      } catch {
        return;
      }
      if (!payload || typeof payload !== "object") return;
      if (typeof payload.s === "number" && Number.isSafeInteger(payload.s)) state.seq = payload.s;
      switch (payload.op) {
        case 10: {
          gotHello = true;
          const interval = Number(asRecord(payload.d)?.heartbeat_interval);
          const intervalMs = Number.isFinite(interval) && interval >= 1000 ? interval : 41_250;
          acked = true;
          void heartbeat(intervalMs);
          if (resuming && state.sessionId && state.seq !== null) {
            send({ op: 6, d: { token, session_id: state.sessionId, seq: state.seq } });
          } else {
            send({
              op: 2,
              d: { token, intents: discordIntents(messageContent), properties: { os: "linux", browser: "tealbrick-connect", device: "tealbrick-connect" } },
            });
          }
          return;
        }
        case 11:
          acked = true;
          return;
        case 1:
          send({ op: 1, d: state.seq });
          return;
        case 7:
          finish({ kind: "reconnect" }, 4000);
          return;
        case 9:
          if (payload.d !== true) clearSession(state);
          finish({ kind: "reconnect", delayMs: 1000 + Math.round(Math.random() * 4000) }, 4000);
          return;
        case 0:
          onDispatch(payload);
          return;
        default:
          return;
      }
    };
    ws.onerror = () => undefined;
    ws.onclose = (event: CloseEvent) => {
      const code = event.code;
      if (code === 4004) {
        finish(
          {
            kind: "fatal",
            error: new ChannelError("channel_credentials_rejected", "Discord rejected the bot token on the gateway. Reset it in the developer portal and enter the new one.", 401),
          },
          1000,
        );
        return;
      }
      const refused = REFUSED_CLOSE[code];
      if (refused) {
        finish({ kind: "fatal", error: new ChannelError("channel_gateway_refused", refused, 400) }, 1000);
        return;
      }
      if (NO_RESUME_CLOSE.has(code)) clearSession(state);
      finish({ kind: "reconnect" }, 4000);
    };
  });
}

/** Gateway loop until `signal` aborts: reconnect with backoff ≥ 1 s (growing), RESUME when possible. */
async function run(creds: ChannelCredentials, net: ChannelNet, bot: BotIdentity, sink: InboundSink, signal: AbortSignal): Promise<void> {
  const token = tokenOf(creds);
  const messageContent = creds.message_content === "true";
  const state: GatewayState = { sessionId: null, resumeUrl: null, seq: null, botUserIds: bot.botId ? [bot.botId] : [], attempts: 0 };
  while (!signal.aborted) {
    const end = await gatewaySession(token, messageContent, net, state, sink, signal);
    if (end.kind === "aborted" || signal.aborted) return;
    if (end.kind === "fatal") throw end.error;
    const delay = Math.max(1000, end.delayMs ?? backoffMs(state.attempts));
    state.attempts += 1;
    await pause(net, delay, signal);
  }
}

export const discordProvider: ChannelProvider = {
  service: "discord",
  credentialFields: ["bot_token"],
  settingFields: [
    {
      key: "message_content",
      type: "boolean",
      default: false,
      label: "Read message text (needs the MESSAGE CONTENT intent in the Discord developer portal)",
    },
  ],
  maxTextLength: DISCORD_MAX_TEXT,
  verify,
  conversations: (creds, net) => conversations(creds, net),
  send,
  edit,
  delete: remove,
  react,
  openDirect,
  // R3: MESSAGE_UPDATE / MESSAGE_DELETE (Discord) and message_changed / message_deleted (Slack) are read.
  reports: { edits: true, deletions: true },
  inbound: { kind: "socket", run },
};
