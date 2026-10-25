/**
 * Telegram Bot API provider (C58; harvest HARVEST-CHANNELS F5, v1 providers/telegram.ts). REST:
 * `https://api.telegram.org/bot<token>/<method>`. The token is part of the URL, so no error ever carries the URL or the
 * transport error; provider descriptions are `scrub`bed.
 *
 * - Credentials: `bot_token` (shape `<digits>:<base64url>`, checked before any request).
 * - verify: getMe. conversations: Telegram has no "list my chats" API, so this returns []. Conversations come from
 *   inbound messages; the channel service records each one it sees.
 * - send: sendMessage, plain text (no parse_mode). `threadId` is a message id: the post replies to it
 *   (reply_parameters). An inbound forum-topic id is the id of the topic's first message, so replying to it posts
 *   in that topic.
 * - react: setMessageReaction with one emoji from Telegram's fixed reaction list.
 * - openDirect: personId is the Telegram user id, which is also the private chat id. Telegram has no "open DM" call;
 *   getChat checks that the person has started the bot (a bot cannot write first).
 * - inbound `poll`: getUpdates long poll (no public route needed). deleteWebhook first when a webhook is set, because
 *   the two modes exclude each other (409). Channel-post self echo cannot be detected here (a channel post has no
 *   `from`): the service drops echoes with its sent-message ledger.
 */
import {
  type ActionSink,
  type BotIdentity,
  type ChannelCredentials,
  ChannelError,
  type ChannelNet,
  type ChannelProvider,
  type Conversation,
  cleanInboundText,
  type InboundAction,
  type InboundMessage,
  type InboundSink,
  mentionList,
  type SendInput,
} from "../provider.ts";
import { asRecord, backoffMs, cleanName, type ProviderResponse, pause, providerDetail, providerRequest, rateLimited } from "./http.ts";

const API_BASE = "https://api.telegram.org";
const SERVICE = "Telegram";
export const TELEGRAM_MAX_TEXT = 4096;
export const TELEGRAM_POLL_TIMEOUT_S = 25;
const TOKEN_SHAPE = /^[0-9]+:[A-Za-z0-9_-]+$/u;
/** Quality audit R2: how often one update whose message could not be stored is fetched again before it is passed. QA INFO: 10
 *  tries with the capped backoff (1 s doubling to 60 s) ride out a database outage of about 4 minutes. */
export const TELEGRAM_SINK_TRIES = 10;
const CHAT_ID_SHAPE = /^(-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/u;
const USER_ID_SHAPE = /^[0-9]{1,20}$/u;
const MESSAGE_ID_SHAPE = /^[0-9]{1,12}$/u;
const CALLBACK_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/u;
/** answerCallbackQuery shows at most 200 characters. */
const CALLBACK_TEXT_MAX = 200;

/**
 * Emoji a bot can set with setMessageReaction (ReactionTypeEmoji). U+FE0F is removed before the lookup, so "❤\ufe0f" and
 * "❤" are the same reaction (v1 providers/telegram.ts:62-122).
 */
export const TELEGRAM_REACTION_EMOJI: readonly string[] = [
  "❤", "👍", "👎", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊",
  "🤡", "🥱", "🥴", "😍", "🐳", "❤\u200d🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾",
  "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨\u200d💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅",
  "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷\u200d♂", "🤷", "🤷\u200d♀", "😡",
];
const REACTIONS = new Set(TELEGRAM_REACTION_EMOJI);

function tokenOf(creds: ChannelCredentials): string {
  const token = creds.bot_token?.trim() ?? "";
  if (!token) throw new ChannelError("channel_credentials_missing", "Enter the Telegram bot token from @BotFather.");
  if (!TOKEN_SHAPE.test(token)) {
    throw new ChannelError("channel_credentials_invalid", "The Telegram bot token has the wrong shape. It looks like 123456789:AA… (from @BotFather).");
  }
  return token;
}

function chatOf(conversation: string): string {
  if (typeof conversation !== "string" || !CHAT_ID_SHAPE.test(conversation)) {
    throw new ChannelError("channel_conversation_invalid", "A Telegram chat id is a number (or @channelusername).");
  }
  return conversation;
}

function messageIdOf(messageId: string | null | undefined, field = "messageId"): number {
  if (typeof messageId !== "string" || !MESSAGE_ID_SHAPE.test(messageId)) {
    throw new ChannelError("channel_message_id_invalid", `${field} must be a Telegram message id (digits).`);
  }
  return Number(messageId);
}

function textOf(text: string): string {
  if (typeof text !== "string" || text.trim().length === 0) throw new ChannelError("channel_message_empty", "The message has no text.");
  if (text.length > TELEGRAM_MAX_TEXT) {
    throw new ChannelError("channel_text_too_long", `The text is ${text.length} characters; Telegram allows ${TELEGRAM_MAX_TEXT}.`);
  }
  return text;
}

function descriptionOf(response: ProviderResponse): string {
  const d = asRecord(response.json)?.description;
  return typeof d === "string" ? d : "";
}

/** Map a failed Bot API answer to a ChannelError. Telegram answers 404 for a token it does not know. */
function failure(response: ProviderResponse, creds: ChannelCredentials, method: string): ChannelError {
  const description = descriptionOf(response);
  const lower = description.toLowerCase();
  const detail = providerDetail(description, creds);
  const status = response.status;
  if (status === 401 || status === 404) {
    return new ChannelError("channel_credentials_rejected", "Telegram rejected the bot token. Check it in @BotFather or enter a new one.", 401);
  }
  if (status === 429) return rateLimited(SERVICE, response);
  if (status === 403) {
    if (lower.includes("blocked") || lower.includes("initiate conversation") || lower.includes("user is deactivated")) {
      return new ChannelError(
        "channel_dm_not_allowed",
        "Telegram does not let the bot write to this person. They must open the bot and press Start first (or they blocked the bot).",
        403,
      );
    }
    if (lower.includes("not a member") || lower.includes("kicked") || lower.includes("not enough rights")) {
      return new ChannelError("channel_not_member", "The bot is not a member of this chat or lacks the right to post. Add it to the chat first.", 403);
    }
    return new ChannelError("channel_forbidden", `Telegram refused ${method}${detail ? `: ${detail}` : "."}`, 403);
  }
  if (status === 400 && (lower.includes("not found") || lower.includes("message to") || lower.includes("message can't be"))) {
    return new ChannelError("channel_not_found", `Telegram could not find this chat or message${detail ? `: ${detail}` : "."}`, 404);
  }
  if (status === 409) {
    return new ChannelError("channel_consumer_conflict", "Another program is reading this bot's updates (or a webhook is set).", 409);
  }
  if (status >= 500) return new ChannelError("channel_provider_unavailable", "Telegram is not available right now. Try again later.", 502);
  return new ChannelError("channel_rejected", `Telegram refused ${method}${detail ? `: ${detail}` : "."}`, 400);
}

async function call(
  creds: ChannelCredentials,
  net: ChannelNet,
  method: string,
  body: Record<string, unknown>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ response: ProviderResponse; result: unknown }> {
  const token = tokenOf(creds);
  const response = await providerRequest(net, { method: "POST", url: `${API_BASE}/bot${token}/${method}`, body, ...options }, SERVICE);
  const record = asRecord(response.json);
  if (response.status < 200 || response.status >= 300 || record?.ok !== true) {
    if (response.status >= 200 && response.status < 300) {
      throw new ChannelError("channel_provider_bad_response", `Telegram answered ${method} but the reply was not understood.`, 502);
    }
    throw failure(response, creds, method);
  }
  return { response, result: record.result };
}

/** Short placeholder text for files (metadata only; no file is downloaded). */
function filePlaceholders(message: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (Array.isArray(message.photo) && message.photo.length > 0) out.push("[photo]");
  const document = asRecord(message.document);
  if (document) out.push(`[file${cleanName(document.file_name, 60) ? `: ${cleanName(document.file_name, 60)}` : ""}]`);
  if (asRecord(message.audio)) out.push("[audio]");
  if (asRecord(message.voice)) out.push("[voice message]");
  if (asRecord(message.video) || asRecord(message.video_note)) out.push("[video]");
  if (asRecord(message.sticker)) out.push(`[sticker${typeof asRecord(message.sticker)?.emoji === "string" ? ` ${cleanName(asRecord(message.sticker)?.emoji, 8)}` : ""}]`);
  if (asRecord(message.location)) out.push("[location]");
  if (asRecord(message.contact)) out.push("[contact]");
  if (asRecord(message.poll)) out.push("[poll]");
  return out;
}

function conversationType(chatType: unknown): InboundMessage["conversationType"] {
  if (chatType === "private") return "direct";
  if (chatType === "channel") return "channel";
  return "group";
}

/**
 * One getUpdates update → InboundMessage, or null when ignored (v1 parseTelegramUpdate, telegram.ts:967-1029):
 * only `message` and `channel_post`; bots (the bot itself included) ignored; channel posts and anonymous admins use
 * `sender_chat` as the sender; `threadId` is the forum topic id; text or caption, files as short placeholders.
 */
/**
 * F15: mentioned user ids from message entities. `text_mention` carries the user id; an `@username` mention carries only
 * a name, so it counts only when it names this bot (its username). Offsets are UTF-16, as in JS strings.
 */
function telegramMentions(message: Record<string, unknown>, body: string, bot: Pick<BotIdentity, "botId"> & { botName?: string }): string[] {
  const entities = [message.entities, message.caption_entities].flatMap((e) => (Array.isArray(e) ? e : []));
  const out: string[] = [];
  for (const raw of entities) {
    const e = asRecord(raw);
    if (!e) continue;
    const user = asRecord(e.user);
    if (e.type === "text_mention" && typeof user?.id === "number" && Number.isSafeInteger(user.id)) out.push(String(user.id));
    if (e.type === "mention" && typeof e.offset === "number" && typeof e.length === "number" && bot.botName) {
      if (body.slice(e.offset, e.offset + e.length).toLowerCase() === `@${bot.botName.toLowerCase()}`) out.push(bot.botId);
    }
  }
  return mentionList(out);
}

export function parseTelegramUpdate(update: unknown, bot: Pick<BotIdentity, "botId"> & { botName?: string }, now: number): InboundMessage | null {
  const record = asRecord(update);
  if (!record) return null;
  const edited = asRecord(record.edited_message) ?? asRecord(record.edited_channel_post);
  const message = asRecord(record.message) ?? asRecord(record.channel_post) ?? edited;
  if (!message) return null;
  // R3: an edit needs its edit time; Telegram sends no event when a bot-visible message is deleted.
  const editDate = edited && message === edited && typeof edited.edit_date === "number" && Number.isFinite(edited.edit_date) ? edited.edit_date * 1000 : null;
  if (edited && message === edited && editDate === null) return null;
  const chat = asRecord(message.chat);
  const messageId = message.message_id;
  if (!chat || typeof chat.id !== "number" || !Number.isSafeInteger(chat.id) || typeof messageId !== "number" || !Number.isSafeInteger(messageId)) {
    return null;
  }
  const from = asRecord(message.from);
  if (from && String(from.id) === bot.botId) return null;
  const senderIsBot = from?.is_bot === true;
  const senderChat = asRecord(message.sender_chat);
  const sender = from && typeof from.id === "number" ? from : senderChat;
  if (!sender || typeof sender.id !== "number" || !Number.isSafeInteger(sender.id)) return null;
  const senderName =
    (sender === from
      ? cleanName([from.first_name, from.last_name].filter((p) => typeof p === "string").join(" "))
      : cleanName(sender.title)) ||
    cleanName(sender.username) ||
    String(sender.id);
  const body = typeof message.text === "string" ? message.text : typeof message.caption === "string" ? message.caption : "";
  const parts = [body, ...filePlaceholders(message)].filter((p) => p.length > 0);
  const text = cleanInboundText(parts.join("\n"));
  if (text.trim().length === 0) return null;
  const threadId =
    message.is_topic_message === true && typeof message.message_thread_id === "number" && Number.isSafeInteger(message.message_thread_id)
      ? String(message.message_thread_id)
      : null;
  const conversationName =
    cleanName(chat.title) || cleanName([chat.first_name, chat.last_name].filter((p) => typeof p === "string").join(" ")) || cleanName(chat.username);
  const date = message.date;
  return {
    conversation: String(chat.id),
    ...(conversationName ? { conversationName } : {}),
    conversationType: conversationType(chat.type),
    messageId: String(messageId),
    threadId,
    senderId: String(sender.id),
    senderName,
    text,
    sentAt: typeof date === "number" && Number.isFinite(date) && date > 0 ? date * 1000 : now,
    mentions: telegramMentions(message, body, bot),
    ...(editDate !== null ? { change: { kind: "edit" as const, at: editDate } } : {}),
    ...(senderIsBot ? { senderIsBot: true as const } : {}),
  };
}

/**
 * IN-2: one `callback_query` update → the click, or null. Only a click on a message in a chat (not an inline message),
 * by a person (not a bot), with callback_data, is read.
 */
export function parseTelegramCallback(update: unknown, bot: Pick<BotIdentity, "botId">): InboundAction | null {
  const q = asRecord(asRecord(update)?.callback_query);
  if (!q || typeof q.id !== "string" || !CALLBACK_ID_SHAPE.test(q.id) || typeof q.data !== "string") return null;
  const from = asRecord(q.from);
  if (!from || typeof from.id !== "number" || !Number.isSafeInteger(from.id) || String(from.id) === bot.botId) return null;
  const message = asRecord(q.message);
  const chat = asRecord(message?.chat);
  // an "inaccessible message" (date 0, older than 48 h) carries no text and cannot be edited
  if (!message || !chat || typeof chat.id !== "number" || !Number.isSafeInteger(chat.id) || typeof message.message_id !== "number" || message.date === 0) return null;
  return {
    conversation: String(chat.id),
    messageId: String(message.message_id),
    clickerId: String(from.id),
    ...(from.is_bot === true ? { clickerIsBot: true as const } : {}),
    value: q.data.slice(0, 200),
    ackId: q.id,
    text: cleanInboundText(typeof message.text === "string" ? message.text : ""),
  };
}

async function verify(creds: ChannelCredentials, net: ChannelNet): Promise<BotIdentity> {
  const { result } = await call(creds, net, "getMe", {});
  const me = asRecord(result);
  if (!me || typeof me.id !== "number") throw new ChannelError("channel_provider_bad_response", "Telegram answered getMe but the reply was not understood.", 502);
  return { botId: String(me.id), botName: cleanName(me.username, 64) || cleanName(me.first_name, 64) || String(me.id) };
}

/** Telegram has no list API: conversations are learned from inbound messages and recorded by the channel service. */
async function conversations(creds: ChannelCredentials): Promise<Conversation[]> {
  tokenOf(creds);
  return [];
}

async function send(creds: ChannelCredentials, net: ChannelNet, input: SendInput): Promise<{ messageId: string }> {
  tokenOf(creds);
  const chat = chatOf(input.conversation);
  const text = textOf(input.text);
  const reply = input.threadId ? messageIdOf(input.threadId, "threadId") : null;
  const { result } = await call(creds, net, "sendMessage", {
    chat_id: chat,
    text,
    ...(reply !== null ? { reply_parameters: { message_id: reply, allow_sending_without_reply: false } } : {}),
    // IN-2: one row of buttons; callback_data = the opaque value (≤ 64 bytes, checked by the hub)
    ...(input.actions?.length ? { reply_markup: { inline_keyboard: [input.actions.map((a) => ({ text: a.label, callback_data: a.value }))] } } : {}),
  });
  const id = asRecord(result)?.message_id;
  if (typeof id !== "number") throw new ChannelError("channel_provider_bad_response", "Telegram sent the message but the reply was not understood.", 502);
  return { messageId: String(id) };
}

async function edit(creds: ChannelCredentials, net: ChannelNet, input: { conversation: string; messageId: string; text: string }): Promise<void> {
  tokenOf(creds);
  const body = { chat_id: chatOf(input.conversation), message_id: messageIdOf(input.messageId), text: textOf(input.text) };
  try {
    await call(creds, net, "editMessageText", body);
  } catch (error) {
    // "message is not modified" is the asked end state.
    if (error instanceof ChannelError && error.code === "channel_rejected" && /not modified/iu.test(error.message)) return;
    throw error;
  }
}

async function remove(creds: ChannelCredentials, net: ChannelNet, input: { conversation: string; messageId: string }): Promise<void> {
  tokenOf(creds);
  await call(creds, net, "deleteMessage", { chat_id: chatOf(input.conversation), message_id: messageIdOf(input.messageId) });
}

/** IN-2: stops the client's spinner with the notice; a final answer also edits the message (the keyboard goes). */
async function actionDone(
  creds: ChannelCredentials,
  net: ChannelNet,
  input: { conversation: string; messageId: string; ackId: string | null; text: string; notice: string; final: boolean },
): Promise<void> {
  tokenOf(creds);
  if (input.ackId && CALLBACK_ID_SHAPE.test(input.ackId)) {
    await call(creds, net, "answerCallbackQuery", { callback_query_id: input.ackId, text: input.notice.slice(0, CALLBACK_TEXT_MAX), show_alert: !input.final }).catch(
      // a late answer (the query is older than about 15 s) must not stop the edit
      () => undefined,
    );
  }
  if (!input.final) return;
  const text = `${input.text}\n\n${input.notice}`.slice(0, TELEGRAM_MAX_TEXT);
  // editMessageText without reply_markup removes the inline keyboard
  await edit(creds, net, { conversation: input.conversation, messageId: input.messageId, text });
}

export function telegramReaction(emoji: string): string | null {
  if (typeof emoji !== "string") return null;
  const name = emoji.trim().replace(/\ufe0f/gu, "");
  return REACTIONS.has(name) ? name : null;
}

async function react(creds: ChannelCredentials, net: ChannelNet, input: { conversation: string; messageId: string; emoji: string }): Promise<void> {
  tokenOf(creds);
  const chat = chatOf(input.conversation);
  const messageId = messageIdOf(input.messageId);
  const emoji = telegramReaction(input.emoji);
  if (!emoji) {
    throw new ChannelError("channel_reaction_invalid", "A Telegram reaction must be one emoji from Telegram's reaction list (for example 👍 ❤ 🔥 🎉 👀).");
  }
  await call(creds, net, "setMessageReaction", { chat_id: chat, message_id: messageId, reaction: [{ type: "emoji", emoji }] });
}

async function openDirect(creds: ChannelCredentials, net: ChannelNet, input: { personId: string }): Promise<{ conversation: string }> {
  tokenOf(creds);
  if (typeof input.personId !== "string" || !USER_ID_SHAPE.test(input.personId)) {
    throw new ChannelError("channel_person_invalid", "A Telegram person id is the numeric user id.");
  }
  try {
    const { result } = await call(creds, net, "getChat", { chat_id: input.personId });
    const chat = asRecord(result);
    if (chat?.type !== "private" || String(chat.id) !== input.personId) {
      throw new ChannelError("channel_person_invalid", "This Telegram id is not a person.");
    }
  } catch (error) {
    // A person who never started the bot is "chat not found" for the bot.
    if (error instanceof ChannelError && error.code === "channel_not_found") {
      throw new ChannelError(
        "channel_dm_not_allowed",
        "Telegram does not let the bot write to this person first. They must open the bot and press Start.",
        403,
      );
    }
    throw error;
  }
  return { conversation: input.personId };
}

/**
 * getUpdates long poll until `signal` aborts. Offset = last update_id + 1 confirms the batch. Errors back off
 * (capped exponential with jitter); a rejected token throws; 409 (a webhook or another poller) backs off, and a
 * webhook found later is deleted again.
 */
async function run(creds: ChannelCredentials, net: ChannelNet, bot: BotIdentity, sink: InboundSink, signal: AbortSignal, actions?: ActionSink): Promise<void> {
  tokenOf(creds);
  let offset: number | undefined;
  let webhookChecked = false;
  let attempts = 0;
  // Quality audit R2: tries per update whose message could not be stored (the offset stays on it until TELEGRAM_SINK_TRIES)
  const sinkTries = new Map<number, number>();
  while (!signal.aborted) {
    try {
      if (!webhookChecked) {
        const { result } = await call(creds, net, "getWebhookInfo", {}, { signal });
        const url = asRecord(result)?.url;
        if (typeof url === "string" && url.length > 0) await call(creds, net, "deleteWebhook", { drop_pending_updates: false }, { signal });
        webhookChecked = true;
      }
      const { result } = await call(
        creds,
        net,
        "getUpdates",
        { ...(offset !== undefined ? { offset } : {}), timeout: TELEGRAM_POLL_TIMEOUT_S, allowed_updates: ["message", "channel_post", "edited_message", "edited_channel_post", ...(actions ? ["callback_query"] : [])] },
        { signal, timeoutMs: (TELEGRAM_POLL_TIMEOUT_S + 15) * 1000 },
      );
      if (!Array.isArray(result)) throw new ChannelError("channel_provider_bad_response", "Telegram answered getUpdates but the reply was not understood.", 502);
      for (const update of result) {
        const id = asRecord(update)?.update_id;
        if (typeof id !== "number" || !Number.isSafeInteger(id)) continue;
        const click = actions ? parseTelegramCallback(update, bot) : null;
        if (click && actions) {
          try {
            actions(click);
          } catch {
            // The sink never breaks the poll loop (a click is answered or retried by the hub, not by getUpdates).
          }
          if (offset === undefined || id + 1 > offset) offset = id + 1;
          continue;
        }
        const message = parseTelegramUpdate(update, bot, net.now());
        if (message) {
          try {
            sink(message);
            sinkTries.delete(id);
          } catch {
            // Quality audit R2: not stored (the hub logged and counted it). The offset stays on this update, so the next
            // getUpdates returns it again after a backoff; after TELEGRAM_SINK_TRIES tries it is passed (counted each time).
            const tries = (sinkTries.get(id) ?? 0) + 1;
            sinkTries.set(id, tries);
            if (tries < TELEGRAM_SINK_TRIES) throw new ChannelError("channel_inbound_not_stored", "An incoming Telegram message could not be stored; it is fetched again.", 503);
            sinkTries.delete(id);
          }
        }
        if (offset === undefined || id + 1 > offset) offset = id + 1;
      }
      attempts = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ChannelError && error.code === "channel_credentials_rejected") throw error;
      if (error instanceof ChannelError && error.code === "channel_consumer_conflict") webhookChecked = false;
      await pause(net, backoffMs(attempts), signal);
      attempts += 1;
    }
  }
}

export const telegramProvider: ChannelProvider = {
  service: "telegram",
  credentialFields: ["bot_token"],
  maxTextLength: TELEGRAM_MAX_TEXT,
  verify,
  conversations: (creds) => conversations(creds),
  send,
  edit,
  delete: remove,
  react,
  actionDone,
  openDirect,
  // R3: edits arrive as edited_message / edited_channel_post; Telegram never tells a bot that a message was deleted.
  reports: { edits: true, deletions: false },
  inbound: { kind: "poll", run },
};
