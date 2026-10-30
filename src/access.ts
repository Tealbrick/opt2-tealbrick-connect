/**
 * `tb.access/1` (C380, spec 0.1.89, docs/ACCESS.md): what Connect reports to Governance about who can reach what, and the
 * revoke of the items Connect can end. Companion-only: type app, verified product `fleet`, still listed in the signed slice.
 *
 * Bind to Core (S2-6): disconnecting an account and cancelling a scheduled post of an agent need the agent paused or absent in
 * this app's own copy of the signed slice (`connect_agents`), else `not_revocable` / `agent_running`. Governance therefore cannot
 * trigger them with no approved plan or Portal pause. A `channel_sender` bar is not bound: the owner can undo it on the Accounts page.
 *
 * Identity is the digest (JCS of {v, target, id, kind, subject, resource, level}): a paused item keeps its digest. Text fields
 * hold no message content and no secret.
 */
import { digest } from "@opt2-tealbrick/manifest";
import type { Db, Handler, Json, OpContext } from "@opt2-tealbrick/spec/sdk";

import type { Account, AccountStore } from "./accounts.ts";
import { npubEncode } from "./channels/buzz/nostr.ts";
import { barHandle, SenderBars } from "./sender-bars.ts";

const TARGET = "connect";
const CALLER_PRODUCT = "fleet";
/** Connect's own limit: a revoke can reach a provider per item. */
export const REVOKE_ITEMS_MAX = 5;
const LIMIT_DEFAULT = 100;
const SENDER_PREFIX = "channel_sender:";
const CONTROL = /[\p{Cc}\p{Cf}]/gu;
const AGENT_ID = /^agt_[0-9A-HJKMNP-TV-Z]{26}$/u;
const ITEM_ID = /^[a-z][a-z_]*:[!-~]+$/u;
const CHANNEL_WORDS: Record<string, string> = { buzz: "Buzz", slack: "Slack", telegram: "Telegram" };

const NOT_SHOWN = [
  { kind: "held_calls", reason: "Calls that wait for approval are kept outside Connect." },
  { kind: "scope_rows", reason: "Which agents may use an account is a scope row in the SDK. This version does not list it." },
];
const SENDER_NOT_SWEPT = { kind: "channel_sender", reason: "Connect does not know who a sender is. Ask with the person and their handles." };

type Fail = (code: string, message: string, status?: number, details?: Record<string, unknown>) => never;
type ItemSubject = { kind: "agent" | "person"; id: string } | { kind: "unlinked" };
type RevokeSubject = { kind: "agent" | "person"; id: string };

export interface AccessItem {
  id: string;
  kind: "account_as_itself" | "account_as_me" | "buzz_identity" | "scheduled_post" | "first_contacts" | "channel_sender";
  subject: ItemSubject;
  resource: string;
  direction: "held_by" | "about";
  level: "read" | "write" | "use" | "info";
  label: string;
  state: "active" | "paused" | "scheduled" | "dormant";
  revocable: boolean;
  since?: string;
  digest: string;
}

export interface AccessDeps {
  fail: Fail;
  accounts: (ctx: OpContext) => AccountStore;
  /** The owner's disconnect path: credential and shares removed, row `revoked`, messages kept. */
  disconnect: (ctx: OpContext, account: Account) => Promise<void>;
}

/** Spec fixture `access.caller_vector.1.json`. A person caller gets the agent answer. */
export function assertAccessCaller(ctx: Pick<OpContext, "caller">, fail: Fail): void {
  const caller = ctx.caller as { type?: string; product?: unknown; listed?: unknown };
  if (caller.type !== "app") fail("no_access", "Only the Governance app can use this operation.", 403);
  if (typeof caller.product !== "string" || caller.product === "") fail("caller_unverified", "Connect cannot verify which app is calling.", 403);
  if (caller.product !== CALLER_PRODUCT) fail("no_access", "Only the Governance app can use this operation.", 403);
  if (caller.listed !== true) fail("caller_unverified", "This app instance is not in the current workspace list.", 403);
}

export function itemDigest(item: Pick<AccessItem, "id" | "kind" | "subject" | "resource" | "level">, target = TARGET): string {
  return digest({ v: 1, target, id: item.id, kind: item.kind, subject: item.subject, resource: item.resource, level: item.level } as unknown as Json);
}

const text = (value: string): string => Array.from(value.replace(CONTROL, "").trim()).slice(0, 120).join("");
const iso = (ms: unknown): string => new Date(Number(ms)).toISOString();
const withDigest = (item: Omit<AccessItem, "digest">): AccessItem => ({ ...item, digest: itemDigest(item) });

/** True when this app's copy of the signed slice shows the agent paused, or does not show it. */
function agentStopped(db: Db, agent: string): boolean {
  const row = db.prepare("SELECT status FROM connect_agents WHERE id = ?").get(agent);
  return !row || row.status === "paused";
}

const sameSubject = (a: ItemSubject, b: RevokeSubject): boolean => a.kind === b.kind && a.id === b.id;

/** Everything held by an agent or by nobody Connect can name. */
function storedItems(db: Db, accounts: AccountStore): AccessItem[] {
  const out: AccessItem[] = [];
  const paused = new Set(db.prepare("SELECT id FROM connect_agents WHERE status = 'paused'").all().map((r) => String(r.id)));
  const stateOf = (agent: string): AccessItem["state"] => (paused.has(agent) ? "paused" : "active");
  for (const a of accounts.list()) {
    if (a.status === "revoked") continue;
    const label = text(`${a.service}: ${a.label}`);
    const since = iso(a.createdAt);
    const dormant = a.status !== "connected";
    if (a.kind === "as_itself" && a.ownerAgent && AGENT_ID.test(a.ownerAgent)) {
      out.push(withDigest({ id: `account_as_itself:${a.id}`, kind: "account_as_itself", subject: { kind: "agent", id: a.ownerAgent }, resource: a.id, direction: "held_by", level: "use", label, state: dormant ? "dormant" : stateOf(a.ownerAgent), revocable: true, since }));
    } else {
      // no person is linked to an account in this version; the owner names these for Governance
      out.push(withDigest({ id: `${a.kind === "as_me" ? "account_as_me" : "account_as_itself"}:${a.id}`, kind: a.kind === "as_me" ? "account_as_me" : "account_as_itself", subject: { kind: "unlinked" }, resource: a.id, direction: "held_by", level: "use", label, state: dormant ? "dormant" : "active", revocable: false, since }));
    }
  }
  for (const r of db.prepare("SELECT agent, pubkey, created_at FROM connect_buzz_identities").all()) {
    const agent = String(r.agent);
    if (!AGENT_ID.test(agent)) continue;
    out.push(withDigest({ id: `buzz_identity:${agent}`, kind: "buzz_identity", subject: { kind: "agent", id: agent }, resource: `buzz:${npubEncode(String(r.pubkey))}`, direction: "held_by", level: "info", label: "Buzz identity", state: stateOf(agent), revocable: false, since: iso(r.created_at) }));
  }
  for (const r of db.prepare("SELECT id, agent, send_at, created_at FROM connect_buzz_scheduled WHERE status = 'scheduled'").all()) {
    if (!AGENT_ID.test(String(r.agent))) continue;
    out.push(withDigest({ id: `scheduled_post:${String(r.id)}`, kind: "scheduled_post", subject: { kind: "agent", id: String(r.agent) }, resource: String(r.id), direction: "held_by", level: "write", label: `Scheduled Buzz post, ${iso(r.send_at).slice(0, 16).replace("T", " ")} UTC`, state: "scheduled", revocable: true, since: iso(r.created_at) }));
  }
  // one info row per agent: people written to, no names
  const contacts = new Map<string, { count: number; since: number }>();
  const add = (agent: unknown, count: unknown, since: unknown) => {
    if (typeof agent !== "string" || !AGENT_ID.test(agent)) return;
    const seen = contacts.get(agent);
    contacts.set(agent, { count: (seen?.count ?? 0) + Number(count), since: Math.min(seen?.since ?? Number(since), Number(since)) });
  };
  for (const r of db.prepare("SELECT agent, COUNT(*) AS n, MIN(first_sent_at) AS at FROM connect_buzz_contacts GROUP BY agent").all()) add(r.agent, r.n, r.at);
  for (const r of db.prepare("SELECT a.owner_agent AS agent, COUNT(*) AS n, MIN(c.first_sent_at) AS at FROM connect_channel_contacts c JOIN connect_accounts a ON a.id = c.account_id GROUP BY a.owner_agent").all()) add(r.agent, r.n, r.at);
  for (const r of db.prepare("SELECT caller AS agent, COUNT(*) AS n, MIN(first_sent_at) AS at FROM connect_tool_contacts GROUP BY caller").all()) add(r.agent, r.n, r.at);
  for (const [agent, c] of contacts) {
    out.push(withDigest({ id: `first_contacts:${agent}`, kind: "first_contacts", subject: { kind: "agent", id: agent }, resource: agent, direction: "held_by", level: "info", label: c.count === 1 ? "Has written to 1 person" : `Has written to ${c.count} people`, state: stateOf(agent), revocable: false, since: iso(c.since) }));
  }
  return out;
}

function senderItem(person: string, handle: string): AccessItem {
  const channel = handle.slice(0, handle.indexOf(":"));
  return withDigest({ id: `${SENDER_PREFIX}${handle}`, kind: "channel_sender", subject: { kind: "person", id: person }, resource: handle, direction: "held_by", level: "use", label: `${CHANNEL_WORDS[channel] ?? channel} messages from this person reach agents`, state: "active", revocable: true });
}

type ListSubject = { kind: "agent"; id: string } | { kind: "person"; id: string; handles: string[] } | { kind: "unlinked" } | { kind: "all" };

/** What the asked subjects hold, sorted by id. A barred handle is not listed: nothing is left to end. */
function collect(db: Db, accounts: AccountStore, subjects: readonly ListSubject[]): AccessItem[] {
  const stored = subjects.some((s) => s.kind !== "person") ? storedItems(db, accounts) : [];
  const bars = new SenderBars(db);
  const byId = new Map<string, AccessItem>();
  for (const s of subjects) {
    if (s.kind === "person") {
      for (const raw of s.handles) {
        const handle = barHandle(raw);
        const id = `${SENDER_PREFIX}${handle}`;
        // one item has one subject: the first person named keeps a handle two people claim
        if (handle && !bars.has(handle) && !byId.has(id)) byId.set(id, senderItem(s.id, handle));
      }
      continue;
    }
    for (const item of stored) {
      if (s.kind === "all" || (s.kind === "unlinked" && item.subject.kind === "unlinked") || (s.kind === "agent" && item.subject.kind === "agent" && item.subject.id === s.id)) byId.set(item.id, item);
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const encodeCursor = (id: string): string => Buffer.from(id, "utf8").toString("base64url");
const decodeCursor = (cursor: string): string | null => {
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  return ITEM_ID.test(id) ? id : null;
};

export function accessListHandler(deps: AccessDeps): Handler {
  return async (input, ctx) => {
    assertAccessCaller(ctx, deps.fail);
    const i = input as unknown as { subjects?: ListSubject[]; cursor?: string; limit?: number; sweepId?: string };
    const subjects = Array.isArray(i.subjects) ? i.subjects : deps.fail("input_invalid", "subjects is required.", 400);
    const limit = typeof i.limit === "number" ? i.limit : LIMIT_DEFAULT;
    const all = collect(ctx.db, deps.accounts(ctx), subjects);
    const after = typeof i.cursor === "string" ? (decodeCursor(i.cursor) ?? deps.fail("input_invalid", "cursor is not one this op returned.", 400)) : null;
    const start = after === null ? 0 : all.findIndex((item) => item.id > after);
    const page = start < 0 ? [] : all.slice(start, start + limit);
    const more = start >= 0 && start + limit < all.length;
    const last = page.at(-1);
    const notShown = subjects.some((s) => s.kind === "all") ? [...NOT_SHOWN, SENDER_NOT_SWEPT] : NOT_SHOWN;
    return {
      v: 1,
      asOf: new Date().toISOString(),
      ...(i.sweepId ? { sweepId: i.sweepId } : {}),
      items: page,
      nextCursor: more && last ? encodeCursor(last.id) : null,
      notShown,
      complete: false,
    } as unknown as Json;
  };
}

interface RevokeResult {
  id: string;
  outcome: "revoked" | "already_gone" | "changed" | "not_revocable" | "failed";
  code?: string;
  detail?: string;
}

function revokeSender(db: Db, plan: string, subject: RevokeSubject, item: { id: string; digest: string }): RevokeResult {
  const handle = item.id.slice(SENDER_PREFIX.length);
  if (subject.kind !== "person" || barHandle(handle) !== handle) return { id: item.id, outcome: "changed" };
  if (senderItem(subject.id, handle).digest !== item.digest) return { id: item.id, outcome: "changed" };
  return { id: item.id, outcome: new SenderBars(db).add(handle, plan) ? "revoked" : "already_gone" };
}

export function accessRevokeHandler(deps: AccessDeps): Handler {
  return async (input, ctx) => {
    assertAccessCaller(ctx, deps.fail);
    const i = input as unknown as { plan: string; attempt: number; subject: RevokeSubject; items: { id: string; digest: string }[] };
    if (!Array.isArray(i.items) || i.items.length === 0 || i.items.length > REVOKE_ITEMS_MAX) deps.fail("input_invalid", `Send 1 to ${REVOKE_ITEMS_MAX} items.`, 400);
    const accounts = deps.accounts(ctx);
    // The row, not the request: an item named for another subject is `changed`, and the running check reads the row's own agent.
    const needRows = i.items.some((asked) => !asked.id.startsWith(SENDER_PREFIX));
    const current = new Map(needRows ? storedItems(ctx.db, accounts).map((item) => [item.id, item]) : []);
    const results: RevokeResult[] = [];
    for (const asked of i.items) {
      if (asked.id.startsWith(SENDER_PREFIX)) {
        results.push(revokeSender(ctx.db, i.plan, i.subject, asked));
        continue;
      }
      const item = current.get(asked.id);
      if (!item) results.push({ id: asked.id, outcome: "already_gone" });
      else if (item.digest !== asked.digest || !sameSubject(item.subject, i.subject)) results.push({ id: asked.id, outcome: "changed" });
      else if (!item.revocable) results.push({ id: asked.id, outcome: "not_revocable" });
      else if (!agentStopped(ctx.db, (item.subject as { id: string }).id)) results.push({ id: asked.id, outcome: "not_revocable", code: "agent_running" });
      else if (item.kind === "scheduled_post") {
        const done = ctx.db.prepare("UPDATE connect_buzz_scheduled SET status = 'cancelled', detail = ? WHERE id = ? AND agent = ? AND status = 'scheduled'").run("Not sent: cancelled by a Governance plan.", item.resource, (item.subject as { id: string }).id).changes;
        results.push({ id: asked.id, outcome: done > 0 ? "revoked" : "already_gone" });
      } else {
        const account = accounts.get(item.resource);
        if (account?.status === "revoked" || !account) {
          results.push({ id: asked.id, outcome: "already_gone" });
          continue;
        }
        try {
          await deps.disconnect(ctx, account);
          results.push({ id: asked.id, outcome: "revoked" });
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          results.push({ id: asked.id, outcome: "failed", ...(typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? { code } : {}), detail: "Connect could not disconnect this account. Try again." });
        }
      }
    }
    const revoked = results.filter((r) => r.outcome === "revoked").length;
    ctx.receipt.summary(`Governance plan ${i.plan}, attempt ${i.attempt}: ${revoked} of ${results.length} items ended`);
    return { v: 1, asOf: new Date().toISOString(), results } as unknown as Json;
  };
}
