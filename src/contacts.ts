/**
 * `contacts_list` (G-5, C373): who each agent has written to, on which channel, for the Governance app (`fleet`) Topology
 * contacts layer. Read-only, companion-only.
 *
 * Sources (first-contact records, one row per person a sender has written to):
 * - `connect_buzz_contacts` (agent, pubkey): Buzz DMs. The workspace sender (apps) is recorded as agent "workspace" and is
 *   reported with agent null.
 * - `connect_channel_contacts` (account_id, person_id): chat DMs per bot ACCOUNT. The agent is the account's `owner_agent`
 *   (an "as itself" bot); an account bound to no agent (for example a workspace sender bot) gives agent null.
 * - `connect_tool_contacts` (caller, account, address): recipients of dynamic send tools. The caller is an agent (agt_) or an
 *   app instance (ins_, reported with agent null).
 *
 * Never returned: message content, conversation ids (the Buzz DM channel, the chat conversation), account ids or secrets.
 * The account is named by its owner-typed label, which the canvas already shows.
 *
 * Who may call: ONLY an app caller whose VERIFIED product (`ctx.caller.product`, src/data/caller.ts) is `fleet` and that the
 * current signed slice still lists. Agents, people and every other app answer 403 `no_access`. The manifest also lists the op
 * with `listing: "workflow"` (spec 0.1.43, LR-1): the bridge lists and admits it only for a grant whose `wf` names it, which
 * is Governance's companion grant; agent cards never see it as an MCP tool. The guard here stays the defence for bridges
 * that predate the listing rule.
 */
import { normalizeHandle } from "@opt2-tealbrick/manifest";
import type { Handler, Json, OpContext } from "@opt2-tealbrick/spec/sdk";

import { companionListed, verifiedAppProduct } from "./data/caller.ts";
import { authorHandle } from "./data/messages.ts";

/** The one product that may read the contacts list. */
export const CONTACTS_PRODUCT = "fleet";
export const CONTACTS_PAGE = 200;
/** Agent key of Buzz first contacts sent as the workspace sender (src/channels/buzz/identity.ts WORKSPACE_SENDER). */
const WORKSPACE_KEY = "workspace";
const CONTROL = /[\p{Cc}\p{Cf}]/gu;
const HANDLE_MAX = 256;

export interface ContactRow {
  agent: string | null;
  /** "buzz", the chat service of the bot account (slack, telegram, teams, discord), or "tool" */
  channel: string;
  /** canonical "<channel>:<value>" (normalizeHandle) where it applies; else the raw provider id or address */
  handle: string;
  /** owner-typed label of the Connect account (chat and tool contacts) */
  account?: string;
  firstContactAt: number;
}

type Fail = (code: string, message: string, status?: number, details?: Record<string, unknown>) => never;

/** Sort and cursor key: (firstContactAt, agent, handle), then channel and account so equal triples stay distinct. */
type Key = [number, string, string, string, string];
const keyOf = (r: ContactRow): Key => [r.firstContactAt, r.agent ?? "", r.handle, r.channel, r.account ?? ""];
const compare = (a: Key, b: Key): number => {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  for (let i = 1; i < a.length; i++) if (a[i] !== b[i]) return (a[i] as string) < (b[i] as string) ? -1 : 1;
  return 0;
};
const encodeCursor = (k: Key): string => Buffer.from(JSON.stringify(k), "utf8").toString("base64url");
const decodeCursor = (cursor: string): Key | null => {
  try {
    const k = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(k) && k.length === 5 && Number.isSafeInteger(k[0]) && k.slice(1).every((v) => typeof v === "string")) return k as Key;
  } catch {
    // fall through
  }
  return null;
};

const clean = (value: string): string => value.replace(CONTROL, "").trim().slice(0, HANDLE_MAX);
const agentOf = (raw: unknown): string | null => (typeof raw === "string" && raw.startsWith("agt_") ? raw : null);

/** Refuse everyone except a listed Governance (`fleet`) app instance. */
function assertFleet(ctx: OpContext, fail: Fail): void {
  if (verifiedAppProduct(ctx) !== CONTACTS_PRODUCT) fail("no_access", "Only the Governance app can read the contacts list.", 403);
  const listed = companionListed(ctx);
  if (listed === "gone") fail("no_access", "This app instance is not in the workspace list now. Try again later.", 403, { retryable: true, retryAfterMs: 30_000 });
  if (listed === "unknown") fail("companion_list_unavailable", "Connect cannot check that this app is still installed. Update Connect.", 503, { retryable: true, retryAfterMs: 30_000 });
}

/** Every contact row with first contact at or after `since`, sorted by keyOf. */
export function contactRows(ctx: Pick<OpContext, "db">, since: number): ContactRow[] {
  const rows: ContactRow[] = [];
  for (const r of ctx.db.prepare("SELECT agent, pubkey, first_sent_at FROM connect_buzz_contacts WHERE first_sent_at >= ?").all(since)) {
    const pubkey = String(r.pubkey);
    const agent = String(r.agent);
    rows.push({
      agent: agent === WORKSPACE_KEY ? null : agentOf(agent),
      channel: "buzz",
      handle: normalizeHandle(`buzz:${pubkey}`) ?? clean(`buzz:${pubkey}`),
      firstContactAt: Number(r.first_sent_at),
    });
  }
  const chat = ctx.db
    .prepare(
      `SELECT c.person_id, c.first_sent_at, a.service, a.label, a.owner_agent
         FROM connect_channel_contacts c JOIN connect_accounts a ON a.id = c.account_id
        WHERE c.first_sent_at >= ?`,
    )
    .all(since);
  for (const r of chat) {
    const service = String(r.service);
    rows.push({ agent: agentOf(r.owner_agent), channel: service, handle: authorHandle(service, String(r.person_id)), account: clean(String(r.label)), firstContactAt: Number(r.first_sent_at) });
  }
  const tool = ctx.db
    .prepare(
      `SELECT t.caller, t.address, t.first_sent_at, a.label
         FROM connect_tool_contacts t JOIN connect_accounts a ON a.id = t.account
        WHERE t.first_sent_at >= ?`,
    )
    .all(since);
  for (const r of tool) {
    const address = String(r.address);
    rows.push({ agent: agentOf(r.caller), channel: "tool", handle: normalizeHandle(address) ?? clean(address), account: clean(String(r.label)), firstContactAt: Number(r.first_sent_at) });
  }
  return rows.sort((x, y) => compare(keyOf(x), keyOf(y)));
}

/** The `contacts_list` handler. `fail` throws the app's SDK error (createConnectApp passes its own). */
export function contactsListHandler(fail: Fail): Handler {
  return async (input: Json, ctx: OpContext): Promise<Json> => {
    assertFleet(ctx, fail);
    const i = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
    let since = 0;
    if (i.since !== undefined) {
      if (typeof i.since !== "number" || !Number.isSafeInteger(i.since) || i.since < 0) fail("input_invalid", "since must be an integer time in epoch milliseconds.", 400);
      since = i.since as number;
    }
    let after: Key | null = null;
    if (i.cursor !== undefined && i.cursor !== "") {
      after = typeof i.cursor === "string" ? decodeCursor(i.cursor) : null;
      if (!after) fail("cursor_invalid", "cursor is not one this op returned.", 400);
    }
    const rows = contactRows(ctx, since);
    const start = after ? rows.findIndex((r) => compare(keyOf(r), after) > 0) : 0;
    const page = start < 0 ? [] : rows.slice(start, start + CONTACTS_PAGE);
    const last = page.at(-1);
    const more = start >= 0 && start + CONTACTS_PAGE < rows.length;
    return { contacts: page as unknown as Json, nextCursor: more && last ? encodeCursor(keyOf(last)) : null };
  };
}
