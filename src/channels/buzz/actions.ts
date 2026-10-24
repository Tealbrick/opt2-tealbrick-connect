/**
 * C343a: Buzz has no buttons, so a companion app's Buzz DM with `actions` takes the recipient's signed reaction instead:
 * ✅ = the primary button, ❌ = the danger button. Connect keeps the two button values sealed in its app secrets (never in
 * the database), reads kind 7 reactions on its own alert in the DM channel, checks each one itself (the relay is
 * untrusted) and relays the matching value to the sending app (Operator Inbox: item_decide_dm), which decides once.
 *
 * A reaction counts only when: its Schnorr signature verifies; it is signed by the person the DM went to; its target
 * (`e` tag) is one of this alert's events; its content is exactly ✅ or ❌; it is not older than the alert; the alert is
 * open and not expired. The first valid reaction decides: a later one, a removed one or a text reply changes nothing.
 * The earliest second holding both ✅ and ❌ is ambiguous: nothing is decided and the owner is sent to Operator Inbox.
 */
import type { AppSecrets } from "@opt2-tealbrick/miniapp-sdk";
import type { Db, Logger } from "@opt2-tealbrick/spec/sdk";

import type { MessageAction } from "../provider.ts";
import type { ActionOrigin, ActionRelay } from "../service.ts";
import { type NostrEvent, verifyEvent } from "./nostr.ts";
import { KIND_REACTION } from "./relay.ts";

export const BUZZ_APPROVE = "✅";
export const BUZZ_DENY = "❌";
/** A reaction may be this much older than the alert (clock skew between relays and Connect). */
export const BUZZ_SKEW_S = 60;
/** At most this many reactions are read per channel and poll. */
export const BUZZ_REACTIONS_MAX = 100;
const secretName = (id: string) => `buzz-actions:${id}`;

/** What the hub needs from the relay client (BuzzRelay): read and reply as the sender. */
export interface BuzzReader {
  query(agent: string, filters: Record<string, unknown>[], options?: { relays?: readonly string[] }): Promise<{ events: NostrEvent[] }>;
  post(agent: string, input: { channel: string; content: string; replyTo?: { id: string; root?: string } }): Promise<unknown>;
}

/** Buzz takes one primary (✅) and at most one danger (❌) button; null when the list does not fit that. */
export function emojiMap(actions: readonly MessageAction[]): Record<string, string> | null {
  const primary = actions.filter((a) => a.style === "primary");
  const danger = actions.filter((a) => a.style === "danger");
  if (primary.length > 1 || danger.length > 1 || primary.length + danger.length !== actions.length || actions.length === 0) return null;
  return { ...(primary[0] ? { [BUZZ_APPROVE]: primary[0].value } : {}), ...(danger[0] ? { [BUZZ_DENY]: danger[0].value } : {}) };
}

/** The last `e` tag is a reaction's target (NIP-25). */
function target(event: NostrEvent): string | undefined {
  return event.tags.filter((t) => t[0] === "e").at(-1)?.[1];
}

/** ✅ / ❌ only; U+FE0F (emoji presentation) is ignored. */
function emojiOf(content: string): string | null {
  const c = content.replace(/️/gu, "").trim();
  return c === BUZZ_APPROVE || c === BUZZ_DENY ? c : null;
}

/**
 * The decision the reactions carry, or null (none valid yet), or "ambiguous". Every rule of the header is checked here;
 * `verifyEvent` runs again although the relay client already checked (a test or a future caller may pass raw events).
 */
export function decideFrom(events: readonly unknown[], alert: { eventIds: ReadonlySet<string>; owner: string; sentAtS: number }): string | "ambiguous" | null {
  const valid: { at: number; emoji: string }[] = [];
  for (const raw of events) {
    if (!verifyEvent(raw)) continue;
    const e = raw;
    if (e.kind !== KIND_REACTION || e.pubkey !== alert.owner) continue;
    const t = target(e);
    if (!t || !alert.eventIds.has(t)) continue;
    if (e.created_at < alert.sentAtS - BUZZ_SKEW_S) continue;
    const emoji = emojiOf(e.content);
    if (emoji) valid.push({ at: e.created_at, emoji });
  }
  if (valid.length === 0) return null;
  const first = Math.min(...valid.map((v) => v.at));
  const kinds = new Set(valid.filter((v) => v.at === first).map((v) => v.emoji));
  return kinds.size > 1 ? "ambiguous" : ([...kinds][0] as string);
}

export interface BuzzActionsDeps {
  db: Db;
  secrets: Pick<AppSecrets, "get" | "put" | "delete">;
  reader: BuzzReader;
  relay: ActionRelay | null;
  now: () => number;
  log?: Pick<Logger, "warn">;
}

/** Records a sent Buzz DM with buttons: the ledger row (no values) + the sealed emoji → value map. */
export async function recordBuzzActions(
  d: Pick<BuzzActionsDeps, "db" | "secrets" | "now">,
  input: { sender: string; owner: string; sent: readonly { id: string; channel: string }[]; origin: ActionOrigin },
): Promise<void> {
  const map = emojiMap(input.origin.actions);
  const first = input.sent[0];
  if (!map || !first) return;
  await d.secrets.put(secretName(first.id), JSON.stringify(map));
  const now = d.now();
  d.db
    .prepare(
      `INSERT OR REPLACE INTO connect_buzz_actions (id, sender, owner_pubkey, requested_to, events, product, instance, expires_at, sent_at, state, result, notice_sent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, 0, ?, ?)`,
    )
    .run(first.id, input.sender, input.owner, input.origin.requestedAccount, JSON.stringify(input.sent), input.origin.product, input.origin.instance, input.origin.expiresAt, now, now, now);
}

const REPLY_EXPIRED = "These reactions expired. Decide in Operator Inbox.";
const REPLY_AMBIGUOUS = "Both ✅ and ❌ arrived at the same time, so nothing was decided. Decide in Operator Inbox.";

/** One poll over the open Buzz alerts (the 15 s scheduler tick). Never throws: a problem is logged and retried next tick. */
export async function pollBuzzActions(d: BuzzActionsDeps): Promise<void> {
  const rows = d.db.prepare("SELECT * FROM connect_buzz_actions WHERE state = 'open' ORDER BY created_at ASC LIMIT 20").all();
  for (const r of rows) {
    try {
      await pollOne(d, r);
    } catch (error) {
      d.log?.warn("buzz action poll failed", { alert: String(r.id).slice(0, 16), code: (error as { code?: string }).code ?? "error" });
    }
  }
}

async function pollOne(d: BuzzActionsDeps, r: Record<string, unknown>): Promise<void> {
  const id = String(r.id);
  const sent = JSON.parse(String(r.events)) as { id: string; channel: string }[];
  const sender = String(r.sender);
  const reply = async (content: string) => {
    for (const one of sent) {
      try {
        await d.reader.post(sender, { channel: one.channel, content, replyTo: { id: one.id } });
      } catch (error) {
        d.log?.warn("buzz action reply failed", { alert: id.slice(0, 16), code: (error as { code?: string }).code ?? "error" });
      }
    }
  };
  const close = async (result: string) => {
    const done = d.db.prepare("UPDATE connect_buzz_actions SET state = 'done', result = ?, updated_at = ? WHERE id = ? AND state IN ('open', 'busy')").run(result, d.now(), id).changes;
    await d.secrets.delete(secretName(id));
    if (done === 1) await reply(result);
  };
  if (Number(r.expires_at) <= d.now()) return close(REPLY_EXPIRED);
  const eventIds = new Set(sent.map((s) => s.id));
  const events: NostrEvent[] = [];
  for (const channel of new Set(sent.map((s) => s.channel))) {
    const ids = sent.filter((s) => s.channel === channel).map((s) => s.id);
    const filter = { kinds: [KIND_REACTION], "#h": [channel], "#e": ids, since: Math.floor(Number(r.sent_at) / 1000) - BUZZ_SKEW_S, limit: BUZZ_REACTIONS_MAX };
    events.push(...(await d.reader.query(sender, [filter])).events);
  }
  const emoji = decideFrom(events, { eventIds, owner: String(r.owner_pubkey), sentAtS: Math.floor(Number(r.sent_at) / 1000) });
  if (emoji === null) return;
  if (emoji === "ambiguous") return close(REPLY_AMBIGUOUS);
  const map = JSON.parse((await d.secrets.get(secretName(id))) ?? "{}") as Record<string, string>;
  const value = map[emoji];
  if (!value) return close("This reaction cannot be used here. Decide in Operator Inbox.");
  const claimed = d.db.prepare("UPDATE connect_buzz_actions SET state = 'busy', updated_at = ? WHERE id = ? AND state = 'open'").run(d.now(), id).changes;
  if (claimed !== 1) return;
  const outcome = d.relay
    ? await d.relay(String(r.product), { token: value, clicker: { service: "buzz", id: String(r.requested_to) }, account: "buzz" }, `buzz-act-${id.slice(0, 32)}`).catch(() => ({
        final: false,
        notice: "Could not decide now. Open Operator Inbox.",
      }))
    : { final: false, notice: "Connect is starting." };
  if (outcome.final) return close(outcome.notice.slice(0, 300));
  // not final (a transient error, no grant): the alert stays open and the same reaction is tried again next tick; the
  // owner hears about it once
  const first = d.db.prepare("UPDATE connect_buzz_actions SET state = 'open', notice_sent = 1, updated_at = ? WHERE id = ? AND state = 'busy' AND notice_sent = 0").run(d.now(), id).changes;
  if (first !== 1) d.db.prepare("UPDATE connect_buzz_actions SET state = 'open', updated_at = ? WHERE id = ? AND state = 'busy'").run(d.now(), id);
  else await reply(outcome.notice.slice(0, 300));
}

/** Rows (and any sealed values left) 30 days after expiry. */
export async function purgeBuzzActions(d: Pick<BuzzActionsDeps, "db" | "secrets" | "now">, keepMs: number): Promise<void> {
  const old = d.db.prepare("SELECT id FROM connect_buzz_actions WHERE expires_at < ?").all(d.now() - keepMs);
  for (const r of old) await d.secrets.delete(secretName(String(r.id)));
  d.db.prepare("DELETE FROM connect_buzz_actions WHERE expires_at < ?").run(d.now() - keepMs);
}
