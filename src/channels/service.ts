/**
 * Channel service (C58): Slack, Teams, Telegram and Discord connections behind the one provider interface.
 * Owns: channel accounts (connect_accounts source 'channel', kind 'as_itself', one agent per bot), the inbox with a
 * monotonic `seq` cursor, the sent-message ledger (edit/delete/react own messages only), first-contact records and the
 * long-running inbound workers (socket / long-poll) plus webhook delivery (Teams, via a manifest public route).
 * Credentials: SDK app secrets (`account:<id>`), never the database; never logged.
 */
import { createHash } from "node:crypto";
import type { AppSecrets } from "@opt2-tealbrick/miniapp-sdk";
import type { Db, Logger } from "@opt2-tealbrick/spec/sdk";

import type { Account, AccountStore } from "../accounts.ts";
import { BAR_REFUSED_CODE, BAR_REFUSED_TEXT, SenderBars } from "../sender-bars.ts";
import {
  type BotIdentity,
  CHANNEL_SERVICES,
  type ChannelCredentials,
  ChannelError,
  type ChannelNet,
  type ChannelProvider,
  type InboundAction,
  type InboundMessage,
  type MessageAction,
  type ChannelService as ServiceId,
} from "./provider.ts";

export const INBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RESTART_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];

export interface InboxRow {
  seq: number;
  account: string;
  service: string;
  conversation: string;
  conversationType: string;
  messageId: string;
  threadId: string | null;
  sender: { id: string; name: string };
  text: string;
  sentAt: number;
  /** F15: `<service>:<user id>` handles this message mentions (SDK-API §18 format) */
  mentions: string[];
  /** F15: true when the message mentions this connection's bot (the agent); a runner can wake on these only */
  mentionsMe: boolean;
}

export interface ChannelDeps {
  db: Db;
  accounts: AccountStore;
  secrets: AppSecrets;
  providers: ReadonlyMap<ServiceId, ChannelProvider>;
  net: ChannelNet;
  log?: Logger;
}

/** IN-2: who sent a message with buttons, and until when a click may be relayed. */
export interface ActionOrigin {
  product: string;
  instance: string;
  /** the `account` input of the send (the app binds its token to it) */
  requestedAccount: string;
  actions: readonly MessageAction[];
  expiresAt: number;
  /** actionsUntil passed before the send ran (it waited for approval): the text goes alone, with a note */
  expired?: boolean;
}

/** The line added to a message whose buttons expired before it was sent. */
export const ACTIONS_EXPIRED_NOTE = "(The buttons of this message expired before it was sent. Use the app that sent it.)";

/** IN-2: what the sending app answered for one click. `final` = the decision is made (or can never be made from here). */
export interface RelayOutcome {
  final: boolean;
  notice: string;
}
export type ActionRelay = (product: string, input: { token: string; clicker: { service: string; id: string }; account: string }, idempotencyKey: string) => Promise<RelayOutcome>;

/** A `busy` click older than this is taken as lost (the app never answered) and the message opens again. */
export const ACTION_BUSY_MS = 2 * 60_000;
const hashValue = (v: string) => createHash("sha256").update(v).digest("base64url");

type BotRow = BotIdentity & { settings: Record<string, string>; inboundState: string; inboundDetail: string; unmatchedChanges: number };

function parseMentions(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const list = JSON.parse(value) as unknown;
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function isChannelService(value: string): value is ServiceId {
  return (CHANNEL_SERVICES as readonly string[]).includes(value);
}

/** QA-CON25-1: how many not-stored message keys one account keeps (the count stops growing there; the log still shows each). */
const NOT_STORED_MAX = 1000;

export class ChannelHub {
  readonly #d: ChannelDeps;
  readonly #bars: SenderBars;
  readonly #workers = new Map<string, AbortController>();
  #relay: ActionRelay | null = null;
  /** account id → keys of messages not stored yet (QA-CON25-1: counted once per message, removed when a redelivery is stored) */
  readonly #notStored = new Map<string, Set<string>>();

  constructor(deps: ChannelDeps) {
    this.#d = deps;
    this.#bars = new SenderBars(deps.db);
  }

  provider(service: string): ChannelProvider {
    const p = isChannelService(service) ? this.#d.providers.get(service) : undefined;
    if (!p) throw new ChannelError("channel_service_unknown", `Unknown channel service ${service}.`, 404);
    return p;
  }

  bot(accountId: string): BotRow | null {
    const r = this.#d.db.prepare("SELECT * FROM connect_channel_bots WHERE account_id = ?").get(accountId);
    if (!r) return null;
    return {
      botId: String(r.bot_id),
      botName: String(r.bot_name),
      ...(r.workspace ? { workspace: String(r.workspace) } : {}),
      settings: JSON.parse(String(r.settings)) as Record<string, string>,
      inboundState: String(r.inbound_state),
      inboundDetail: String(r.inbound_detail),
      unmatchedChanges: Number(r.unmatched_changes ?? 0),
    };
  }

  async #creds(account: Account): Promise<ChannelCredentials> {
    const raw = await this.#d.secrets.get(`account:${account.id}`);
    if (!raw) throw new ChannelError("channel_credentials_missing", "This channel connection has no credentials; connect it again.", 409);
    return { ...(JSON.parse(raw) as ChannelCredentials), ...(this.bot(account.id)?.settings ?? {}) };
  }

  /** The agent's own connected channel account, or a clear refusal. */
  account(id: string, agent: string): Account {
    const a = this.#d.accounts.get(id);
    if (a?.source !== "channel") throw new ChannelError("channel_account_unknown", "No such channel connection.", 404);
    if (a.status !== "connected") throw new ChannelError("channel_account_not_connected", "This channel connection is not connected.", 409);
    if (a.ownerAgent !== agent) throw new ChannelError("scope_denied", "This channel bot belongs to another agent.", 403);
    return a;
  }

  // ── owner actions ──

  async connect(input: { service: string; label: string; agent: string; credentials: Record<string, unknown>; settings?: Record<string, unknown> }): Promise<Account> {
    const provider = this.provider(input.service);
    const creds: ChannelCredentials = {};
    for (const field of provider.credentialFields) {
      const v = input.credentials[field];
      if (typeof v !== "string" || !v.trim()) throw new ChannelError("credentials_missing", `Enter the ${field.replace(/_/gu, " ")}.`);
      creds[field] = v.trim();
    }
    const settings: Record<string, string> = {};
    for (const f of provider.settingFields ?? []) {
      const v = input.settings?.[f.key];
      settings[f.key] = String(v === undefined ? f.default : v);
    }
    const bot = await provider.verify({ ...creds, ...settings }, this.#d.net);
    const account = this.#d.accounts.create({
      service: provider.service,
      source: "channel",
      kind: "as_itself",
      label: input.label,
      ownerAgent: input.agent,
      externalRef: bot.botId,
      status: "connected",
    });
    await this.#d.secrets.put(`account:${account.id}`, JSON.stringify(creds));
    this.#d.db
      .prepare("INSERT INTO connect_channel_bots (account_id, bot_id, bot_name, workspace, settings, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(account.id, bot.botId, bot.botName.slice(0, 120), bot.workspace ?? null, JSON.stringify(settings), Date.now());
    await this.refreshConversations(account).catch(() => undefined);
    this.start(account);
    return account;
  }

  async disconnect(account: Account): Promise<Account> {
    this.stop(account.id);
    await this.#d.secrets.delete(`account:${account.id}`);
    return this.#d.accounts.update(account.id, { status: "revoked", detail: "Disconnected by the owner." });
  }

  // ── conversations ──

  async refreshConversations(account: Account): Promise<void> {
    const provider = this.provider(account.service);
    const bot = this.bot(account.id);
    if (!bot) return;
    const list = await provider.conversations(await this.#creds(account), this.#d.net, bot);
    for (const c of list.slice(0, 200)) this.#rememberConversation(account.id, c.id, c.name, c.type);
  }

  #rememberConversation(accountId: string, conversation: string, name: string, type: string): void {
    this.#d.db
      .prepare(
        `INSERT INTO connect_channel_conversations (account_id, conversation, name, type, last_seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (account_id, conversation) DO UPDATE SET name = excluded.name, type = excluded.type, last_seen_at = excluded.last_seen_at`,
      )
      .run(accountId, conversation, name.slice(0, 120), type, Date.now());
  }

  conversations(accountId: string): { id: string; name: string; type: string }[] {
    return this.#d.db
      .prepare("SELECT conversation, name, type FROM connect_channel_conversations WHERE account_id = ? ORDER BY name LIMIT 200")
      .all(accountId)
      .map((r) => ({ id: String(r.conversation), name: String(r.name), type: String(r.type) }));
  }

  // ── inbound ──

  /** Store one inbound message (dedupe; own sent messages dropped). Returns true when new. */
  ingest(account: Account, m: InboundMessage): boolean {
    const own = this.#d.db.prepare("SELECT 1 FROM connect_channel_sent WHERE account_id = ? AND conversation = ? AND message_id = ?").get(account.id, m.conversation, m.messageId);
    if (own) return false;
    // C380: a barred sender's new message or edit stops here, with a count. A deletion only removes text, so it still applies.
    const barred = m.change?.kind === "delete" ? null : this.#barredInbound(account, m);
    if (barred) {
      this.#bars.countDrop(barred);
      this.#d.log?.info("channel: inbound message from a barred sender dropped", { service: account.service, account: account.id });
      return false;
    }
    // R3: a reported edit or deletion changes a message that is already logged (it takes a new `rev`). One that is not
    // logged (older than the retention, from before the bot connected, or dropped) is an ORPHAN: it is counted and logged
    // (metadata only) and never becomes a row, so an agent never sees an edit as a new message.
    if (m.change) {
      const state = this.#state(account.id, m.conversation, m.messageId);
      if (state === "none") this.#orphan(account, m.change.kind);
      else if (state === "live") {
        if (m.change.kind === "delete") this.markDeleted(account.id, m.conversation, m.messageId);
        else this.markEdited(account.id, m.conversation, m.messageId, m.text, m.change.at);
      }
      return false;
    }
    // Another bot's message is kept only for data apps: with no app share on the account it is dropped (as before R3).
    if (m.senderIsBot && !this.#shared(account.id)) return false;
    this.#rememberConversation(account.id, m.conversation, m.conversationName ?? m.conversation, m.conversationType);
    const r = this.#d.db
      .prepare(
        `INSERT OR IGNORE INTO connect_channel_inbox (account_id, conversation, conversation_type, message_id, thread_id, sender_id, sender_name, text, sent_at, received_at, mentions, rev, attachments, edited_at, sender_is_bot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        account.id,
        m.conversation,
        m.conversationType,
        m.messageId,
        m.threadId,
        m.senderId,
        m.senderName.slice(0, 120),
        m.text,
        m.sentAt,
        Date.now(),
        JSON.stringify(m.mentions ?? []),
        this.#nextRev(account.id),
        m.attachments && m.attachments.length > 0 ? JSON.stringify(m.attachments.slice(0, 32)) : null,
        null,
        m.senderIsBot ? 1 : 0,
      );
    return r.changes > 0;
  }

  /** The barred handle behind an inbound message or edit: its sender, or for an edit the sender of the stored row. */
  #barredInbound(account: Account, m: InboundMessage): string | null {
    if (!this.#bars.any()) return null;
    const direct = this.#bars.sender(account.service, m.senderId);
    if (direct || !m.change) return direct;
    const stored = this.#d.db.prepare("SELECT sender_id FROM connect_channel_inbox WHERE account_id = ? AND conversation = ? AND message_id = ?").get(account.id, m.conversation, m.messageId);
    return stored ? this.#bars.sender(account.service, String(stored.sender_id)) : null;
  }

  /** C380: refuses anything an agent or app could write into a direct conversation with a barred person, or under their message. */
  #refuseBarred(account: Account, conversation: string, messageId?: string | null): void {
    if (!this.#bars.any()) return;
    const service = account.service;
    const db = this.#d.db;
    const barred =
      this.#bars.sender(service, conversation) !== null ||
      db.prepare("SELECT person_id FROM connect_channel_contacts WHERE account_id = ? AND conversation = ?").all(account.id, conversation).some((r) => this.#bars.sender(service, String(r.person_id)) !== null) ||
      db
        .prepare("SELECT DISTINCT sender_id FROM connect_channel_inbox WHERE account_id = ? AND conversation = ? AND conversation_type = 'direct' AND sender_is_bot = 0")
        .all(account.id, conversation)
        .some((r) => this.#bars.sender(service, String(r.sender_id)) !== null) ||
      (!!messageId && db.prepare("SELECT sender_id FROM connect_channel_inbox WHERE account_id = ? AND conversation = ? AND message_id = ?").all(account.id, conversation, messageId).some((r) => this.#bars.sender(service, String(r.sender_id)) !== null));
    if (barred) throw new ChannelError(BAR_REFUSED_CODE, BAR_REFUSED_TEXT, 403);
  }

  /** R3: the next change number of this account's `messages` dataset (a per-account sequence; a duplicate message wastes one). */
  #nextRev(accountId: string): number {
    this.#d.db
      .prepare("INSERT INTO connect_account_rev (account_id, last) VALUES (?, 1) ON CONFLICT (account_id) DO UPDATE SET last = last + 1")
      .run(accountId);
    return Number(this.#d.db.prepare("SELECT last FROM connect_account_rev WHERE account_id = ?").get(accountId)?.last);
  }

  #state(accountId: string, conversation: string, messageId: string): "none" | "live" | "deleted" {
    const row = this.#d.db.prepare("SELECT deleted FROM connect_channel_inbox WHERE account_id = ? AND conversation = ? AND message_id = ?").get(accountId, conversation, messageId);
    return row ? (Number(row.deleted) === 1 ? "deleted" : "live") : "none";
  }

  /** Any app share (available or shared) on this account. */
  #shared(accountId: string): boolean {
    return !!this.#d.db.prepare("SELECT 1 FROM connect_account_shares WHERE account_id = ? LIMIT 1").get(accountId);
  }

  #orphan(account: Account, kind: "edit" | "delete"): void {
    this.#d.db.prepare("UPDATE connect_channel_bots SET unmatched_changes = unmatched_changes + 1 WHERE account_id = ?").run(account.id);
    this.#d.log?.info("channel: an edit or deletion names a message that is not in the log; dropped", { service: account.service, account: account.id, kind });
  }

  /** R3: the provider deleted a logged message. Its text and attachments are erased; the row takes a new `rev` so pulls see it. */
  markDeleted(accountId: string, conversation: string, messageId: string): boolean {
    if (this.#state(accountId, conversation, messageId) !== "live") return false;
    const r = this.#d.db
      .prepare("UPDATE connect_channel_inbox SET text = '', attachments = NULL, deleted = 1, rev = ? WHERE account_id = ? AND conversation = ? AND message_id = ? AND deleted = 0")
      .run(this.#nextRev(accountId), accountId, conversation, messageId);
    return r.changes > 0;
  }

  /**
   * R3: the provider edited a logged message. Ordered and idempotent: it applies only when `editedAt` is newer than the
   * stored edit time, so a replay or a late older event takes no new `rev`.
   */
  markEdited(accountId: string, conversation: string, messageId: string, text: string, editedAt: number): boolean {
    if (this.#state(accountId, conversation, messageId) !== "live") return false;
    const newer = this.#d.db
      .prepare("SELECT 1 FROM connect_channel_inbox WHERE account_id = ? AND conversation = ? AND message_id = ? AND (edited_at IS NULL OR edited_at < ?)")
      .get(accountId, conversation, messageId, editedAt);
    if (!newer) return false;
    const r = this.#d.db
      .prepare("UPDATE connect_channel_inbox SET text = ?, edited_at = ?, rev = ? WHERE account_id = ? AND conversation = ? AND message_id = ? AND deleted = 0")
      .run(text, editedAt, this.#nextRev(accountId), accountId, conversation, messageId);
    return r.changes > 0;
  }

  inbox(accountIds: readonly string[], sinceSeq: number, limit: number): { messages: InboxRow[]; nextSeq: number } {
    if (accountIds.length === 0) return { messages: [], nextSeq: sinceSeq };
    const placeholders = accountIds.map(() => "?").join(", ");
    const want = Math.max(1, Math.min(limit, 100));
    const page = this.#d.db.prepare(
      `SELECT i.*, a.service FROM connect_channel_inbox i JOIN connect_accounts a ON a.id = i.account_id
       WHERE i.account_id IN (${placeholders}) AND i.seq > ? AND i.deleted = 0 AND i.sender_is_bot = 0 ORDER BY i.seq LIMIT ?`,
    );
    // C380: what a barred person sent before the bar is hidden from agents. Hidden rows must not shorten the window: the rule
    // below reads a short window as "nothing is left", so the next page is read until the window is full or the log ends.
    const bars = this.#bars.any();
    const rows: Record<string, unknown>[] = [];
    for (let after = sinceSeq; ; ) {
      const read = page.all(...accountIds, after, want);
      for (const r of read) {
        after = Number(r.seq);
        if (rows.length < want && !(bars && this.#bars.sender(String(r.service), String(r.sender_id)))) rows.push(r);
      }
      if (!bars || read.length < want || rows.length >= want) break;
    }
    const botIds = new Map(accountIds.map((id) => [id, this.bot(id)?.botId.toLowerCase() ?? null]));
    const messages = rows.map((r) => {
      const ids = parseMentions(r.mentions);
      const bot = botIds.get(String(r.account_id)) ?? null;
      return {
      seq: Number(r.seq),
      account: String(r.account_id),
      service: String(r.service),
      conversation: String(r.conversation),
      conversationType: String(r.conversation_type),
      messageId: String(r.message_id),
      threadId: r.thread_id === null ? null : String(r.thread_id),
      sender: { id: String(r.sender_id), name: String(r.sender_name) },
      text: String(r.text),
      sentAt: Number(r.sent_at),
      mentions: ids.map((id) => `${String(r.service)}:${id}`),
      mentionsMe: bot !== null && ids.some((id) => id.toLowerCase() === bot),
      };
    });
    // Fewer than `limit` visible rows means the window is exhausted: skip past hidden rows (deleted messages, other bots')
    // too, so the next call does not scan them again. A full window ends at its last visible row.
    if (messages.length >= want) return { messages, nextSeq: messages.at(-1)?.seq ?? sinceSeq };
    const head = this.#d.db.prepare(`SELECT MAX(seq) AS seq FROM connect_channel_inbox WHERE account_id IN (${placeholders})`).get(...accountIds)?.seq;
    return { messages, nextSeq: Math.max(sinceSeq, messages.at(-1)?.seq ?? sinceSeq, head === null || head === undefined ? 0 : Number(head)) };
  }

  inboundRow(accountId: string, seq: number): InboxRow | null {
    return this.inbox([accountId], seq - 1, 1).messages.find((m) => m.seq === seq) ?? null;
  }

  /** Webhook delivery (Teams): the first connected account of the service whose verification succeeds takes it. */
  async webhook(service: ServiceId, request: { headers: Headers; body: string }): Promise<{ status: number; body: string; contentType?: string }> {
    const provider = this.provider(service);
    if (provider.inbound.kind !== "webhook") return { status: 404, body: "" };
    for (const account of this.#d.accounts.list({ service, status: "connected" }).filter((a) => a.source === "channel")) {
      const bot = this.bot(account.id);
      if (!bot) continue;
      try {
        const out = await provider.inbound.verifyWebhook(request, await this.#creds(account), this.#d.net, bot);
        try {
          for (const m of out.messages) this.#store(account, m);
        } catch {
          // Quality audit R2: not stored (logged and counted); a 5xx makes the sender deliver the activity again
          return { status: 503, body: "" };
        }
        return out.reply ?? { status: 200, body: "" };
      } catch (error) {
        if (!(error instanceof ChannelError) || error.code !== "channel_webhook_unauthorized") this.#d.log?.warn("channel webhook failed", { service, code: (error as { code?: string }).code ?? "error" });
      }
    }
    return { status: 401, body: "" };
  }

  // ── outbound (agent) ──

  async #recordSent(account: Account, conversation: string, messageId: string, agent: string): Promise<void> {
    this.#d.db
      .prepare("INSERT OR IGNORE INTO connect_channel_sent (account_id, conversation, message_id, agent, sent_at) VALUES (?, ?, ?, ?, ?)")
      .run(account.id, conversation, messageId, agent, Date.now());
  }

  #knownPerson(account: Account, personId: string): string | null {
    // C380: a barred person is known to nobody, whatever the book says.
    if (this.#bars.sender(account.service, personId)) return null;
    const contact = this.#d.db.prepare("SELECT conversation FROM connect_channel_contacts WHERE account_id = ? AND person_id = ?").get(account.id, personId);
    if (contact) return String(contact.conversation);
    // A person who wrote to the bot in a direct conversation is not a first contact.
    const wrote = this.#d.db
      .prepare("SELECT conversation FROM connect_channel_inbox WHERE account_id = ? AND sender_id = ? AND conversation_type = 'direct' AND sender_is_bot = 0 ORDER BY seq DESC LIMIT 1")
      .get(account.id, personId);
    return wrote ? String(wrote.conversation) : null;
  }

  #checkText(provider: ChannelProvider, text: string): string {
    const t = text.trim();
    if (!t) throw new ChannelError("channel_message_empty", "The message is empty.");
    if (t.length > provider.maxTextLength) throw new ChannelError("channel_text_too_long", `The message is ${t.length} characters; ${provider.service} allows ${provider.maxTextLength}.`);
    return t;
  }

  async send(account: Account, agent: string, input: { conversation: string; text: string; threadId?: string | null }): Promise<{ messageId: string; conversation: string }> {
    this.#refuseBarred(account, input.conversation, input.threadId);
    const provider = this.provider(account.service);
    const knownRow = () => this.#d.db.prepare("SELECT type FROM connect_channel_conversations WHERE account_id = ? AND conversation = ?").get(account.id, input.conversation);
    let known = knownRow();
    if (!known) {
      // C354a QA S3-1: a conversation id Connect has never seen (e.g. a person's user id, which Slack turns into a DM) is a
      // first contact. Ask the provider once; if it still does not list the conversation, refuse like an unknown person.
      await this.refreshConversations(account).catch(() => undefined);
      known = knownRow();
      if (!known) {
        throw new ChannelError(
          "channel_first_contact_required",
          "Connect has not seen this conversation. Use channel_conversations to list the conversations you can post to, or channel_dm_first to write to a person; the owner approves first contact.",
          409,
        );
      }
    }
    if (known.type === "direct") {
      const wrote = this.#d.db.prepare("SELECT 1 FROM connect_channel_inbox WHERE account_id = ? AND conversation = ? AND sender_is_bot = 0 LIMIT 1").get(account.id, input.conversation);
      const contact = this.#d.db.prepare("SELECT 1 FROM connect_channel_contacts WHERE account_id = ? AND conversation = ?").get(account.id, input.conversation);
      if (!wrote && !contact) throw new ChannelError("channel_first_contact_required", "This is a direct conversation with someone you have not written to. Use channel_dm_first.", 409);
    }
    const text = this.#checkText(provider, input.text);
    const out = await provider.send(await this.#creds(account), this.#d.net, { conversation: input.conversation, text, threadId: input.threadId ?? null });
    await this.#recordSent(account, input.conversation, out.messageId, agent);
    return { messageId: out.messageId, conversation: input.conversation };
  }

  async reply(account: Account, agent: string, input: { seq: number; text: string }): Promise<{ messageId: string; conversation: string }> {
    const raw = this.#d.db.prepare("SELECT sender_id FROM connect_channel_inbox WHERE account_id = ? AND seq = ?").get(account.id, input.seq);
    if (raw && this.#bars.sender(account.service, String(raw.sender_id))) throw new ChannelError(BAR_REFUSED_CODE, BAR_REFUSED_TEXT, 403);
    const row = this.inboundRow(account.id, input.seq);
    if (!row) throw new ChannelError("channel_message_unknown", "No inbound message with that seq on this connection.", 404);
    const threadId = account.service === "slack" || account.service === "teams" ? (row.threadId ?? row.messageId) : row.messageId;
    return this.send(account, agent, { conversation: row.conversation, text: input.text, threadId });
  }

  async directMessage(
    account: Account,
    agent: string,
    input: { person: string; text: string; first: boolean; origin?: ActionOrigin },
  ): Promise<{ messageId: string; conversation: string; actions?: "shown" | "unsupported" | "expired" }> {
    // C380: first contact is refused too. An approved or unheld `channel_dm_first` must not reach a barred person.
    if (this.#bars.sender(account.service, input.person)) throw new ChannelError(BAR_REFUSED_CODE, BAR_REFUSED_TEXT, 403);
    this.#refuseBarred(account, input.person);
    const provider = this.provider(account.service);
    const known = this.#knownPerson(account, input.person);
    if (!input.first && !known) throw new ChannelError("channel_first_contact_required", "You have not written to this person before. Use channel_dm_first; the owner approves first contact.", 409);
    const expired = input.origin?.expired === true;
    const text = this.#checkText(provider, expired ? `${input.text}\n\n${ACTIONS_EXPIRED_NOTE}` : input.text);
    const creds = await this.#creds(account);
    const conversation = known ?? (await provider.openDirect(creds, this.#d.net, { personId: input.person })).conversation;
    // IN-2: buttons only where the provider can answer a click (Slack, Telegram); elsewhere the text goes alone
    const origin = input.origin && !expired && provider.actionDone ? input.origin : undefined;
    const out = await provider.send(creds, this.#d.net, { conversation, text, ...(origin ? { actions: origin.actions } : {}) });
    await this.#recordSent(account, conversation, out.messageId, agent);
    if (origin) {
      const now = this.#d.net.now();
      this.#d.db
        .prepare(
          `INSERT OR REPLACE INTO connect_channel_actions (account_id, conversation, message_id, product, instance, requested_account, value_hashes, expires_at, state, result, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?)`,
        )
        .run(account.id, conversation, out.messageId, origin.product, origin.instance, origin.requestedAccount, JSON.stringify(origin.actions.map((a) => hashValue(a.value))), origin.expiresAt, now, now);
    }
    this.#rememberConversation(account.id, conversation, `Direct: ${input.person.slice(-24)}`, "direct");
    this.#d.db
      .prepare("INSERT OR IGNORE INTO connect_channel_contacts (account_id, person_id, conversation, first_sent_at) VALUES (?, ?, ?, ?)")
      .run(account.id, input.person, conversation, Date.now());
    return { messageId: out.messageId, conversation, ...(input.origin ? { actions: expired ? ("expired" as const) : origin ? ("shown" as const) : ("unsupported" as const) } : {}) };
  }

  // ── button clicks (IN-2) ──

  /** The app wires the relay at start (it needs the start context's callApp). Until then a click is answered "not ready". */
  setActionRelay(relay: ActionRelay | null): void {
    this.#relay = relay;
  }

  /**
   * One click. Relayed only when it hits a message we sent with buttons, with one of its buttons, before expiry, while
   * the message is open; the first click that ends in a decision closes it. The clicker always gets an answer.
   */
  async action(account: Account, a: InboundAction): Promise<void> {
    if (a.clickerIsBot) return;
    const provider = this.provider(account.service);
    const done = provider.actionDone;
    if (!done) return;
    const creds = await this.#creds(account);
    const answer = async (notice: string, final: boolean) => {
      try {
        await done(creds, this.#d.net, { conversation: a.conversation, messageId: a.messageId, clickerId: a.clickerId, ackId: a.ackId, text: a.text, notice, final });
      } catch (error) {
        this.#d.log?.warn("channel action answer failed", { service: account.service, code: (error as { code?: string }).code ?? "error" });
      }
    };
    // C380: a barred person's click decides nothing and is not relayed. The message stays open for someone else.
    if (this.#bars.sender(account.service, a.clickerId)) return answer("This button does not work here.", false);
    const db = this.#d.db;
    const now = this.#d.net.now();
    const row = db.prepare("SELECT * FROM connect_channel_actions WHERE account_id = ? AND conversation = ? AND message_id = ?").get(account.id, a.conversation, a.messageId);
    const hash = hashValue(a.value);
    if (!row || !(JSON.parse(String(row.value_hashes)) as string[]).includes(hash)) return answer("This button does not work here.", false);
    if (row.state === "done") return answer(row.result ? String(row.result) : "This was already decided.", false);
    const key = [account.id, a.conversation, a.messageId] as const;
    if (Number(row.expires_at) <= now) {
      const notice = "This button expired. Open Operator Inbox to decide.";
      db.prepare("UPDATE connect_channel_actions SET state = 'done', result = ?, updated_at = ? WHERE account_id = ? AND conversation = ? AND message_id = ?").run(notice, now, ...key);
      return answer(notice, true);
    }
    const claimed = db
      .prepare(
        "UPDATE connect_channel_actions SET state = 'busy', updated_at = ? WHERE account_id = ? AND conversation = ? AND message_id = ? AND (state = 'open' OR (state = 'busy' AND updated_at < ?))",
      )
      .run(now, ...key, now - ACTION_BUSY_MS).changes;
    if (claimed !== 1) return answer("This is being handled.", false);
    let outcome: RelayOutcome;
    try {
      outcome = this.#relay
        ? await this.#relay(String(row.product), { token: a.value, clicker: { service: account.service, id: a.clickerId }, account: String(row.requested_account) }, `dm-act-${account.id}-${a.messageId}-${hash.slice(0, 16)}`)
        : { final: false, notice: "Connect is starting. Try again in a moment." };
    } catch {
      outcome = { final: false, notice: "Could not decide now. Try again, or open Operator Inbox." };
    }
    const notice = outcome.notice.slice(0, 300);
    db.prepare("UPDATE connect_channel_actions SET state = ?, result = ?, updated_at = ? WHERE account_id = ? AND conversation = ? AND message_id = ? AND state = 'busy'").run(
      outcome.final ? "done" : "open",
      outcome.final ? notice : null,
      this.#d.net.now(),
      ...key,
    );
    return answer(notice, outcome.final);
  }

  #ownMessage(account: Account, conversation: string, messageId: string): void {
    const own = this.#d.db.prepare("SELECT 1 FROM connect_channel_sent WHERE account_id = ? AND conversation = ? AND message_id = ?").get(account.id, conversation, messageId);
    if (!own) throw new ChannelError("channel_not_own_message", "You can only change messages you sent through Connect.", 403);
  }

  async edit(account: Account, input: { conversation: string; messageId: string; text: string }): Promise<void> {
    this.#refuseBarred(account, input.conversation);
    const provider = this.provider(account.service);
    this.#ownMessage(account, input.conversation, input.messageId);
    await provider.edit(await this.#creds(account), this.#d.net, { ...input, text: this.#checkText(provider, input.text) });
  }

  async delete(account: Account, input: { conversation: string; messageId: string }): Promise<void> {
    this.#ownMessage(account, input.conversation, input.messageId);
    await this.provider(account.service).delete(await this.#creds(account), this.#d.net, input);
    this.#d.db.prepare("DELETE FROM connect_channel_sent WHERE account_id = ? AND conversation = ? AND message_id = ?").run(account.id, input.conversation, input.messageId);
  }

  async react(account: Account, input: { conversation: string; messageId: string; emoji: string }): Promise<void> {
    this.#refuseBarred(account, input.conversation, input.messageId);
    await this.provider(account.service).react(await this.#creds(account), this.#d.net, input);
  }

  // ── inbound workers ──

  /** Start inbound for every connected channel account (app start). */
  startAll(): void {
    for (const a of this.#d.accounts.list({ status: "connected" })) if (a.source === "channel") this.start(a);
  }

  #setState(accountId: string, state: string, detail = ""): void {
    this.#d.db.prepare("UPDATE connect_channel_bots SET inbound_state = ?, inbound_detail = ?, updated_at = ? WHERE account_id = ?").run(state, detail.slice(0, 300), Date.now(), accountId);
  }

  start(account: Account): void {
    const provider = this.provider(account.service);
    const inbound = provider.inbound;
    if (inbound.kind === "webhook") {
      this.#setState(account.id, "webhook", "Messages arrive through the workspace door (public route).");
      return;
    }
    if (this.#workers.has(account.id)) return;
    const controller = new AbortController();
    this.#workers.set(account.id, controller);
    const loop = async () => {
      let attempt = 0;
      while (!controller.signal.aborted) {
        const bot = this.bot(account.id);
        if (!bot) return;
        try {
          this.#setState(account.id, "running");
          const creds = await this.#creds(account);
          await inbound.run(
            creds,
            this.#d.net,
            bot,
            (m) => this.#store(account, m),
            controller.signal,
            (a) =>
              void this.action(account, a).catch((error: unknown) =>
                this.#d.log?.warn("channel action failed", { service: account.service, code: (error as { code?: string }).code ?? "error" }),
              ),
          );
          if (controller.signal.aborted) break;
          attempt = 0;
        } catch (error) {
          const code = (error as { code?: string }).code ?? "error";
          if (code === "channel_credentials_rejected" || code === "channel_gateway_refused") {
            this.#setState(account.id, "failed", error instanceof Error ? error.message : code);
            this.#workers.delete(account.id);
            return;
          }
          this.#setState(account.id, "retrying", code);
          this.#d.log?.warn("channel inbound stopped; retrying", { service: account.service, code });
          await this.#d.net.sleep(RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length - 1)] as number, controller.signal).catch(() => undefined);
          attempt += 1;
        }
      }
      this.#setState(account.id, "stopped");
    };
    void loop();
  }

  /**
   * Quality audit R2 (2026-10-24): the inbound sink. A message that cannot be stored (a database error) is never silent: one
   * error log line (metadata only, never the text), a per-account count since start, and the bot's inbound detail says it.
   * Then it throws, so the provider lets the platform deliver it again where it can (Slack: no ack; Telegram: the offset
   * stays); Discord does not redeliver, the count is the record.
   */
  #store(account: Account, m: InboundMessage): void {
    const key = `${m.change ? (m.change.kind === "edit" ? `edit:${m.change.at}` : "delete") : "message"}:${m.conversation}:${m.messageId}`;
    const pending = this.#notStored.get(account.id);
    try {
      this.ingest(account, m);
    } catch (error) {
      const set = pending ?? new Set<string>();
      // QA-CON25-1: one message counts once, however often its redelivery fails (bounded: the oldest key goes first)
      set.add(key);
      while (set.size > NOT_STORED_MAX) set.delete(set.values().next().value as string);
      this.#notStored.set(account.id, set);
      const code = (error as { code?: string }).code ?? (error instanceof Error ? error.name : "error");
      this.#d.log?.error("channel inbound message could not be stored", { service: account.service, account: account.id, code, notStored: set.size });
      this.#notStoredNotice(account.id, set.size);
      throw error;
    }
    // QA-CON25-1: a redelivery was stored; the notice goes when nothing is left
    if (pending?.delete(key)) this.#notStoredNotice(account.id, pending.size);
  }

  #notStoredNotice(accountId: string, count: number): void {
    try {
      if (count === 0) this.#setState(accountId, "running");
      else {
        const words = count === 1 ? "1 incoming message" : `${count} incoming messages`;
        this.#setState(accountId, "running", `${words} could not be stored yet (last try: ${new Date().toISOString()}). Connect asks the chat service to send them again where it can.`);
      }
    } catch {
      // the database itself is failing: the log line and the count stay
    }
  }

  /** Quality audit R2 / QA-CON25-1: inbound messages of an account that are not stored yet (since this process started). */
  notStored(accountId: string): number {
    return this.#notStored.get(accountId)?.size ?? 0;
  }

  stop(accountId: string): void {
    this.#workers.get(accountId)?.abort();
    this.#workers.delete(accountId);
  }

  stopAll(): void {
    for (const id of [...this.#workers.keys()]) this.stop(id);
  }

  purge(now = Date.now()): void {
    this.#d.db.prepare("DELETE FROM connect_channel_inbox WHERE received_at < ?").run(now - INBOX_RETENTION_MS);
    this.#d.db.prepare("DELETE FROM connect_channel_actions WHERE expires_at < ?").run(now - INBOX_RETENTION_MS);
  }
}
