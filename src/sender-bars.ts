/**
 * Sender bars (C380): a person who left cannot reach agents through Connect and cannot get data back from them, with or
 * without the Rules app. This module is the one place that decides whether a handle is barred. The bar:
 * - drops inbound chat at ingest, with a count (ChannelHub.ingest) and hides what the person sent earlier from agents;
 * - hides the person's Buzz messages at read (Buzz has no ingest: the relay is read live) and ignores their reactions;
 * - ignores their clicks on buttons;
 * - refuses every outbound path to them: direct messages, replies, posts in a direct conversation, send tools that name them.
 *
 * Not covered, by design: a channel or group they are still a member of (the owner removes them there), mail or other
 * messages an agent reads through a connected tool account (Connect sees a tool result, not a sender), and what the person
 * sent before the bar when a data app reads the log (messages are never deleted).
 *
 * The refusal is the same text the Rules floor gives: the reason stays with the owner.
 */
import { normalizeHandle } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/spec/sdk";

import { type NostrEvent, parsePubkey } from "./channels/buzz/nostr.ts";

export const BAR_REFUSED_CODE = "refused_by_policy";
export const BAR_REFUSED_TEXT = "Refused by company policy.";
/** Channels without a canonical form in `normalizeHandle`: the provider's id is the value. */
const RAW_CHANNELS = new Set(["teams", "discord"]);
const RAW_VALUE = /^[!-~]{1,200}$/u;
const KIND_GROUP_METADATA = 39000;
const KIND_GROUP_MEMBERS = 39002;

const noLeadingZeros = (id: string): string => id.replace(/^(-?)0+(?=[0-9])/u, "$1");

/**
 * The handle a bar is stored under, or null when the input names nobody. Canonical for buzz, slack, telegram and email. A Teams
 * sender id is `<serviceUrl>|<userId>`: only the user id identifies the person, because the service URL differs per region.
 */
export function barHandle(input: string): string | null {
  const text = input.trim();
  const colon = text.indexOf(":");
  const channel = colon > 0 ? text.slice(0, colon) : "";
  // a provider accepts `0111` for the id 111; the canonical form does not
  if (channel === "telegram") return normalizeHandle(`telegram:${noLeadingZeros(text.slice(colon + 1).trim())}`);
  if (!RAW_CHANNELS.has(channel)) return normalizeHandle(text);
  const raw = text.slice(colon + 1);
  const value = (channel === "teams" ? raw.slice(raw.lastIndexOf("|") + 1) : raw).trim();
  if (!RAW_VALUE.test(value)) return null;
  return `${channel}:${channel === "discord" ? noLeadingZeros(value) : value}`;
}

export interface SenderBar {
  handle: string;
  plan: string | null;
  at: number;
  dropped: number;
}

export class SenderBars {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  /** False on a replay: the first plan and time stay. Every direct conversation the log knows for this handle is kept with the bar. */
  add(handle: string, plan: string | null, now = Date.now()): boolean {
    if (Number(this.#db.prepare("INSERT OR IGNORE INTO connect_sender_bars (handle, plan, at) VALUES (?, ?, ?)").run(handle, plan, now).changes) === 0) return false;
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT i.account_id, i.conversation, i.sender_id FROM connect_channel_inbox i JOIN connect_accounts a ON a.id = i.account_id
         WHERE a.service = ? AND i.conversation_type = 'direct' AND i.sender_is_bot = 0`,
      )
      .all(handle.slice(0, handle.indexOf(":")));
    for (const r of rows) if (barHandle(`${handle.slice(0, handle.indexOf(":"))}:${String(r.sender_id)}`) === handle) this.noteConversation(handle, String(r.account_id), String(r.conversation));
    return true;
  }

  remove(handle: string): boolean {
    this.#db.prepare("DELETE FROM connect_sender_bar_conversations WHERE handle = ?").run(handle);
    return Number(this.#db.prepare("DELETE FROM connect_sender_bars WHERE handle = ?").run(handle).changes) > 0;
  }

  noteConversation(handle: string, account: string, conversation: string): void {
    this.#db.prepare("INSERT OR IGNORE INTO connect_sender_bar_conversations (handle, account_id, conversation) VALUES (?, ?, ?)").run(handle, account, conversation);
  }

  /** True when this conversation is a direct conversation of a barred handle. */
  conversation(account: string, conversation: string): boolean {
    return this.#db.prepare("SELECT 1 FROM connect_sender_bar_conversations WHERE account_id = ? AND conversation = ? LIMIT 1").get(account, conversation) !== undefined;
  }

  list(): SenderBar[] {
    return this.#db
      .prepare("SELECT handle, plan, at, dropped FROM connect_sender_bars ORDER BY at DESC, handle LIMIT 500")
      .all()
      .map((r) => ({ handle: String(r.handle), plan: r.plan === null ? null : String(r.plan), at: Number(r.at), dropped: Number(r.dropped) }));
  }

  has(handle: string): boolean {
    return this.#db.prepare("SELECT 1 FROM connect_sender_bars WHERE handle = ?").get(handle) !== undefined;
  }

  /** The fast path of every check: a workspace with no bar pays one read. */
  any(): boolean {
    return this.#db.prepare("SELECT 1 FROM connect_sender_bars LIMIT 1").get() !== undefined;
  }

  /** The barred handle of a provider user id on a service, or null. */
  sender(service: string, id: string): string | null {
    const handle = barHandle(`${service}:${id}`);
    return handle && this.has(handle) ? handle : null;
  }

  countDrop(handle: string): void {
    this.#db.prepare("UPDATE connect_sender_bars SET dropped = dropped + 1 WHERE handle = ?").run(handle);
  }

  /** The Buzz keys (hex) under a bar. */
  buzzKeys(): string[] {
    return this.#db
      .prepare("SELECT handle FROM connect_sender_bars WHERE handle LIKE 'buzz:%'")
      .all()
      .map((r) => parsePubkey(String(r.handle).slice("buzz:".length)))
      .filter((k): k is string => k !== null);
  }

  buzzKey(pubkey: string): boolean {
    return this.buzzKeys().includes(pubkey);
  }

  /** True when a send tool's recipient value is a barred mail address or a barred id on the tool's own service. */
  recipient(service: string, value: string): boolean {
    const bare = value.replace(/^mailto:/iu, "");
    for (const candidate of [bare, `email:${bare}`, `${service}:${bare}`]) {
      const handle = barHandle(candidate);
      if (handle && this.has(handle)) return true;
    }
    return false;
  }
}

/** What the check reads from the relay client (BuzzRelay.query: signature-checked events). */
export interface BuzzQuery {
  query(agent: string, filters: Record<string, unknown>[], options?: { relays?: readonly string[] }): Promise<{ events: NostrEvent[] }>;
}

/**
 * True when a Buzz channel is a direct conversation with a barred person. Known from Connect's own contact book, else from the
 * channel's member list on the relay, because the person may have opened the conversation. A relay that cannot answer throws
 * (the send fails closed; that relay would not take the post either). A member of a larger channel is not checked here.
 */
export async function buzzChannelBarred(db: Db, reader: BuzzQuery, agent: string, channel: string, relays?: readonly string[]): Promise<boolean> {
  const keys = new SenderBars(db).buzzKeys();
  if (keys.length === 0) return false;
  // a Buzz channel id is a UUID, accepted in either case
  const channelId = channel.toLowerCase();
  const known = db.prepare(`SELECT 1 FROM connect_buzz_contacts WHERE lower(channel) = ? AND pubkey IN (${keys.map(() => "?").join(", ")}) LIMIT 1`).get(channelId, ...keys);
  if (known) return true;
  const { events } = await reader.query(
    agent,
    [
      { kinds: [KIND_GROUP_MEMBERS], "#d": [channelId], limit: 20 },
      { kinds: [KIND_GROUP_METADATA], "#d": [channelId], limit: 20 },
    ],
    relays ? { relays } : {},
  );
  const named = (e: NostrEvent) => e.tags.some((t) => t[0] === "d" && t[1]?.toLowerCase() === channelId);
  const members = new Set(events.filter((e) => e.kind === KIND_GROUP_MEMBERS && named(e)).flatMap((e) => e.tags.filter((t) => t[0] === "p" && typeof t[1] === "string").map((t) => t[1] as string)));
  if (!keys.some((k) => members.has(k))) return false;
  const metadata = events.filter((e) => e.kind === KIND_GROUP_METADATA && named(e));
  // no metadata, or two people only: treated as direct (narrow only)
  return metadata.length === 0 || members.size <= 2 || metadata.some((e) => e.tags.some((t) => t[0] === "hidden" && t.length === 1));
}
