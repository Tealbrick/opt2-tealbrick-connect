/**
 * The ONE channel provider interface (C58; harvest HARVEST-CHANNELS F1/F3–F7). Slack, Teams, Telegram and Discord
 * implement it; Connect's channel service owns accounts, the inbox, the sent-message ledger, first-contact records
 * and the long-running inbound workers. Providers are pure adapters: no database, no secrets store, no logging of
 * credentials. Every network call goes through `net.fetch` (pinned outbound in production, recorded fixtures in tests).
 *
 * Rules every provider follows:
 * - Never return, log or embed a credential in an error message (`scrub` the text with the credential values).
 * - Validate input before any request; refuse with `ChannelError` (stable `code`, owner-readable `message`).
 * - Inbound text is untrusted: strip control/bidi characters and cap length (`cleanInboundText`).
 * - Ignore the bot's own messages and other bots' messages on inbound.
 */
export const CHANNEL_SERVICES = ["slack", "teams", "telegram", "discord"] as const;
export type ChannelService = (typeof CHANNEL_SERVICES)[number];

/** Decrypted credential fields of one channel account (from ctx.secrets; never persisted elsewhere). */
export type ChannelCredentials = Record<string, string>;

export interface ChannelNet {
  fetch: typeof fetch;
  /** Opens an outbound WebSocket (Discord gateway, Slack Socket Mode). Production: global WebSocket. */
  webSocket: (url: string) => WebSocket;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class ChannelError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = "ChannelError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Who the bot is, from the provider's "who am I" call; stored as account metadata (no secrets). */
export interface BotIdentity {
  botId: string;
  botName: string;
  /** Slack team id / Teams tenant id / Discord application id, when the provider has one. */
  workspace?: string;
}

export interface Conversation {
  id: string;
  name: string;
  type: "channel" | "group" | "direct";
}

/** One inbound message, normalised. `messageId` is unique within (account, conversation). */
export interface InboundMessage {
  conversation: string;
  conversationName?: string;
  conversationType: "channel" | "group" | "direct";
  messageId: string;
  threadId: string | null;
  senderId: string;
  senderName: string;
  text: string;
  /** epoch ms from the provider when it has one, else receive time */
  sentAt: number;
  /**
   * F15: provider user ids this message mentions (the bot included when it was addressed), at most 50, de-duplicated.
   * Read as `<service>:<id>` handles (SDK-API §18) in channel_inbox.
   */
  mentions?: string[];
  /** R3: attachment metadata only (name, mime type, size); no provider fills it yet. At most 32 are kept. */
  attachments?: { name: string; mime: string; bytes: number }[];
  /**
   * R3: the provider reports an edit (new text, `at` = edit time, epoch ms) or a deletion of an earlier message. Absent
   * means a new message. A deletion carries only the conversation and the message id (the other fields are ignored).
   */
  change?: { kind: "edit"; at: number } | { kind: "delete" };
  /** R3: the sender is another bot (the provider says so). Such rows are kept for data apps (author kind "bot") and never reach agents. */
  senderIsBot?: true;
}

/** De-duplicated, bounded mention id list (F15). */
export function mentionList(ids: Iterable<string>): string[] {
  return [...new Set([...ids].filter((id) => id.length > 0 && id.length <= 200))].slice(0, 50);
}

export type InboundSink = (message: InboundMessage) => void;

/**
 * IN-2: one button under a message. `value` is opaque to Connect (the sending app signs it); ≤ 64 ASCII characters, the
 * Telegram callback_data limit. Only a companion app (workspace sender) attaches buttons; an agent cannot.
 */
export interface MessageAction {
  label: string;
  value: string;
  style: "primary" | "danger";
}
export const MAX_ACTIONS = 3;
export const ACTION_LABEL_MAX = 30;
export const ACTION_VALUE = /^[A-Za-z0-9._:-]{1,64}$/u;

/** IN-2: a click on a button of a message the bot sent, as the provider reports it (untrusted until the hub matched it). */
export interface InboundAction {
  conversation: string;
  /** the message the button belongs to */
  messageId: string;
  /** the provider user id of the person who clicked */
  clickerId: string;
  /** the provider marks the clicker as a bot */
  clickerIsBot?: true;
  value: string;
  /** what `actionDone` needs to answer this click (Telegram callback_query id); null when the provider needs none */
  ackId: string | null;
  /** the message text as the provider shows it now (for the final edit), cleaned */
  text: string;
}

export type ActionSink = (action: InboundAction) => void;

export interface SendInput {
  conversation: string;
  text: string;
  /** reply in this thread (Slack thread_ts, Teams reply-to activity id, Telegram/Discord message id) */
  threadId?: string | null;
  /** IN-2: buttons; only providers with `actionDone` show them (the hub checks the list first) */
  actions?: readonly MessageAction[];
}

export interface ChannelProvider {
  service: ChannelService;
  /** Credential field names the owner enters (password inputs). */
  credentialFields: readonly string[];
  /** Optional non-secret settings per account (e.g. Discord `message_content` intent), with defaults. */
  settingFields?: readonly { key: string; label: string; type: "boolean" | "string"; default: boolean | string }[];
  maxTextLength: number;
  /**
   * R3: true when Connect can page this service's messages BACKWARD in time (data_pull direction backward; data_catalog
   * history). Phase 1: no provider sets it. Connect has no provider history reader yet, so the inbound log (kept for
   * INBOX_RETENTION_MS) is the only record and is read forward.
   */
  readsHistory?: boolean;
  /**
   * R3: which inbound events the provider reports for messages Connect already logged. `edits` / `deletions` false or
   * absent means the log keeps the old text (a deleted message stays until the 30-day purge) and data_catalog says so.
   */
  reports?: { edits: boolean; deletions: boolean };
  /** Check the credentials and return the bot identity (Slack auth.test, Telegram getMe, Discord /users/@me, Teams token + app id). */
  verify(creds: ChannelCredentials, net: ChannelNet): Promise<BotIdentity>;
  /** Conversations the bot can post to (bounded list, ≤ 200). */
  conversations(creds: ChannelCredentials, net: ChannelNet, bot: BotIdentity): Promise<Conversation[]>;
  send(creds: ChannelCredentials, net: ChannelNet, input: SendInput): Promise<{ messageId: string }>;
  edit(creds: ChannelCredentials, net: ChannelNet, input: { conversation: string; messageId: string; text: string }): Promise<void>;
  delete(creds: ChannelCredentials, net: ChannelNet, input: { conversation: string; messageId: string }): Promise<void>;
  react(creds: ChannelCredentials, net: ChannelNet, input: { conversation: string; messageId: string; emoji: string }): Promise<void>;
  /**
   * IN-2: answers a click. `final` = the decision is made: remove the buttons and add `notice` as a status line to the
   * message (`text` = the message text without buttons). Not final: only the clicker sees `notice`; the buttons stay.
   * A provider without it never shows buttons (Teams, Discord: text only).
   */
  actionDone?(
    creds: ChannelCredentials,
    net: ChannelNet,
    input: { conversation: string; messageId: string; clickerId: string; ackId: string | null; text: string; notice: string; final: boolean },
  ): Promise<void>;
  /** Open (or reuse) the direct conversation with one person; returns its conversation id. */
  openDirect(creds: ChannelCredentials, net: ChannelNet, input: { personId: string }): Promise<{ conversation: string }>;
  /**
   * Inbound. `socket` / `poll`: `run` loops until `signal` aborts, calling `sink` per message; it handles reconnects
   * and backoff itself and resolves only on abort (errors after a backoff are retried; a credential refusal throws
   * ChannelError("channel_credentials_rejected")). `webhook`: `verifyWebhook` checks one request (signature/JWT) and
   * returns the messages it carries; the app exposes it on a manifest public route.
   */
  inbound:
    | {
        kind: "socket" | "poll";
        /** `actions` (IN-2): button clicks, for providers with `actionDone`; absent = clicks are dropped */
        run(creds: ChannelCredentials, net: ChannelNet, bot: BotIdentity, sink: InboundSink, signal: AbortSignal, actions?: ActionSink): Promise<void>;
      }
    | {
        kind: "webhook";
        verifyWebhook(
          request: { headers: Headers; body: string },
          creds: ChannelCredentials,
          net: ChannelNet,
          bot: BotIdentity,
        ): Promise<{ messages: InboundMessage[]; reply?: { status: number; body: string; contentType?: string } }>;
      };
}

const CONTROL = /[\p{Cc}\p{Cf}]/gu;
export const INBOUND_TEXT_MAX = 8_000;

export function cleanInboundText(text: string, max = INBOUND_TEXT_MAX): string {
  return text.replace(CONTROL, (c) => (c === "\n" || c === "\t" ? c : "")).slice(0, max);
}

/** Remove every credential value (≥ 6 chars) from a text before it reaches an error or a log. */
export function scrub(text: string, creds: ChannelCredentials): string {
  let out = text;
  for (const v of Object.values(creds)) if (v && v.length >= 6) out = out.split(v).join("[redacted]");
  return out;
}
