/**
 * Effect classification for third-party tools, shared by every source (Composio, catalog, MCP).
 *
 * Vocabulary comes from the frozen spec (`@opt2-tealbrick/spec/manifest`); Connect holds no literals of its own
 * for effects or hold families. Tier = the manifest access level of the `account` scope:
 *   read → [read]; read_update → [read, create, update]; read_update_delete → [read, create, update, delete].
 * The SDK `authorize()` checks `crud ⊆ grant.crud ∩ access.crud`; Connect re-checks the exact account in `call`.
 */
import type { CrudAction, Effect, HoldFamily } from "@opt2-tealbrick/spec/manifest";

export const ACCESS_LEVELS = ["read", "read_update", "read_update_delete"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const ACCESS_CRUD: Readonly<Record<AccessLevel, readonly CrudAction[]>> = {
  read: ["read"],
  read_update: ["read", "create", "update"],
  read_update_delete: ["read", "create", "update", "delete"],
};

/** A resolved tool class: what the bridge gates and the SDK authorizes. Obeys MANIFEST M-OP-2…4. */
export interface ToolClass {
  crud: CrudAction[];
  effect: Effect;
  holdFamily?: HoldFamily;
}

const EFFECT_ORDER: readonly Effect[] = ["read", "write", "outward", "destructive", "money"];

export function effectRank(effect: Effect): number {
  return EFFECT_ORDER.indexOf(effect);
}

/**
 * Build a tool class from three facts. `write` = changes state, `outward` = reaches a third party (sends, posts,
 * notifies people), `destructive` = deletes or irreversibly overwrites. Result obeys M-OP-2/3/4:
 * read ⇔ ["read"]; destructive ⇒ delete ∈ crud and holdFamily "destructive"; outward ⇒ holdFamily "outward" (C107: a
 * `resolve` answer with outward or money effect always carries a family; "outward" is not held by default, the owner can
 * turn it on). X-02: `resolve` sees only the tool name, so a dynamic SEND tool to a new recipient works like Connect's own
 * channels (buzz_dm / buzz_dm_first): `tools.call` refuses `first_contact_required` unless every recipient is in the caller's
 * contact book for that account, and `<tool>__first_contact` resolves with hold family `first_contact` (held by default).
 */
export function classify(facts: { write: boolean; outward: boolean; destructive: boolean; money?: boolean }): ToolClass {
  if (facts.money) return { crud: ["create", "update", "delete"], effect: "money", holdFamily: "money" };
  if (facts.destructive) return { crud: ["update", "delete"], effect: "destructive", holdFamily: "destructive" };
  if (facts.outward) return { crud: ["create", "update"], effect: "outward", holdFamily: "outward" };
  if (facts.write) return { crud: ["create", "update"], effect: "write" };
  return { crud: ["read"], effect: "read" };
}

/** The lowest access level whose CRUD set contains every action of `crud`; null when none does. */
export function levelFor(crud: readonly CrudAction[]): AccessLevel | null {
  for (const level of ACCESS_LEVELS) {
    if (crud.every((action) => ACCESS_CRUD[level].includes(action))) return level;
  }
  return null;
}

export function levelAllows(level: AccessLevel, crud: readonly CrudAction[]): boolean {
  return crud.every((action) => ACCESS_CRUD[level].includes(action));
}

const MONEY_PARTS = new Set([
  "pay", "pays", "payment", "payments", "payout", "payouts", "charge", "charges", "refund", "refunds", "purchase",
  "purchases", "buy", "checkout", "withdraw", "withdrawal", "deposit", "transfer", "transfers", "remit", "wire",
  "invoice_pay", "capture", "subscribe", "donate", "tip", "trade", "swap",
]);
const DESTRUCTIVE_PARTS = new Set(["delete", "remove", "purge", "revoke", "disconnect", "destroy", "trash", "erase", "wipe", "drop", "truncate", "reset", "overwrite", "terminate"]);
const WRITE_PARTS = new Set([
  "add", "append", "archive", "assign", "create", "draft", "dispatch", "execute", "import", "insert", "mark", "modify",
  "move", "mutate", "patch", "put", "run", "set", "star", "submit", "sync", "trigger", "update", "upload", "upsert",
  "watch", "label", "batch", "stop", "rename", "edit", "save", "copy", "duplicate", "unarchive", "untrash", "tag",
]);
const OUTWARD_PARTS = new Set([
  "send", "reply", "forward", "post", "publish", "invite", "share", "notify", "message", "email", "tweet", "comment",
  "approve", "reject", "merge", "close", "reopen", "cancel", "lock", "unlock", "enable", "disable", "grant", "accept",
  "decline", "deploy", "release", "schedule", "book", "call", "dial", "sms", "dm", "broadcast", "announce",
]);
/** The only verbs that make a tool `read` (SEC-02: an explicit allow-list; anything else is not read). */
const READ_PARTS = new Set([
  "get", "list", "search", "fetch", "read", "find", "query", "lookup", "describe", "retrieve", "count", "view",
  "preview", "download", "export", "stats", "status", "info", "check", "validate", "verify",
]);

/**
 * CON-02: the words of a tool name in every common style. camelCase / PascalCase (`createPayment`, `deleteRepository`),
 * acronym runs (`HTTPRequest` → http, request), letter/digit borders, snake_case, kebab-case, dotted and spaced names all give
 * the same lower-case words, so money and destructive names are matched the same way whatever the server's naming style.
 */
export function nameParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/([A-Za-z])([0-9])/gu, "$1 $2")
    .replace(/([0-9])([A-Za-z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

/**
 * CON-02: long money and destructive stems also match INSIDE a word (`PAYMENTINTENT`, `paymentlinks`, `deleteall`): over-blocking
 * is safe for these classes. Short words (pay, buy, tip, wire, drop, ...) match only as whole words ("display", "tooltip",
 * "dropbox" stay out).
 */
const MONEY_STEMS = ["payment", "payout", "refund", "purchase", "checkout", "withdraw", "deposit", "transfer", "remittance", "charge"] as const;
const DESTRUCTIVE_STEMS = ["delete", "purge", "destroy", "erase", "truncate"] as const;
const hasStem = (parts: readonly string[], stems: readonly string[]) => parts.some((part) => stems.some((stem) => part.includes(stem)));
/** Destructive stems skip past participles ("list_deleted_items" names deleted things, it does not delete). */
const hasDestructiveStem = (parts: readonly string[]) => hasStem(parts.filter((part) => !part.endsWith("ed")), DESTRUCTIVE_STEMS);
const isMoneyParts = (parts: readonly string[]) => parts.some((part) => MONEY_PARTS.has(part)) || hasStem(parts, MONEY_STEMS);

/** True when the name names money movement (always `money`: always held, CORE §7). Any naming style (CON-02). */
export function namesMoney(name: string): boolean {
  return isMoneyParts(nameParts(name));
}

/**
 * Words that are mostly NOUNS in a tool name ("get_draft", "list_labels", "get_message"). After a leading read verb they do not
 * make the tool a write or outward one (F84: GMAIL_LIST_DRAFTS and GMAIL_LIST_LABELS were `write`). They still count when the name
 * does not start with a read verb ("create_email_draft", "send_message"), and a real verb (send, delete, create, update, ...)
 * anywhere in a read-led name still wins.
 */
const NOUN_PARTS = new Set(["draft", "label", "message", "email", "comment", "tag", "star", "call", "trash", "archive", "schedule", "dm", "sms"]);

/**
 * Name inference for a tool without labels (SEC-02, fail closed): money → `money`; destructive verbs → destructive;
 * outward verbs → outward; write verbs → write; read only when a read verb is present and no other class applies;
 * a name with no known verb → write + outward. Composio policy files and MCP annotations override this.
 * F84: when the FIRST verb of the name is a read verb, the ambiguous noun words (NOUN_PARTS) are not counted as verbs.
 */
export function inferFromName(name: string): ToolClass {
  const all = nameParts(name);
  if (isMoneyParts(all)) return classify({ write: true, outward: true, destructive: false, money: true });
  const isVerb = (part: string) => READ_PARTS.has(part) || DESTRUCTIVE_PARTS.has(part) || OUTWARD_PARTS.has(part) || WRITE_PARTS.has(part);
  const lead = all.find((part) => isVerb(part) && !NOUN_PARTS.has(part));
  const parts = lead !== undefined && READ_PARTS.has(lead) ? all.filter((part) => !NOUN_PARTS.has(part)) : all;
  const destructive = parts.some((part) => DESTRUCTIVE_PARTS.has(part)) || hasDestructiveStem(parts);
  const outward = parts.some((part) => OUTWARD_PARTS.has(part));
  const write = parts.some((part) => WRITE_PARTS.has(part));
  if (destructive || outward || write) return classify({ write: true, outward, destructive });
  if (parts.some((part) => READ_PARTS.has(part))) return classify({ write: false, outward: false, destructive: false });
  return classify({ write: true, outward: true, destructive: false });
}

// ── C276a: per-method / per-verb CRUD ──

const CREATE_VERBS = new Set(["create", "add", "insert"]);
const UPDATE_VERBS = new Set(["update", "set", "patch", "edit"]);
const DELETE_VERBS = new Set(["delete", "remove"]);
const isKnownVerb = (part: string) =>
  READ_PARTS.has(part) || DESTRUCTIVE_PARTS.has(part) || OUTWARD_PARTS.has(part) || WRITE_PARTS.has(part) || MONEY_PARTS.has(part);
const CRUD_ORDER: readonly CrudAction[] = ["create", "update", "delete"];

/**
 * C276a review #17: words that name access, identity, secrets or people-reaching objects. A tool or path that names one keeps
 * the full [create, update]: creating a user, role, member, invite, share, token or key is never a plain "create".
 */
const SENSITIVE_WORDS = new Set([
  "user", "group", "role", "member", "membership", "permission", "acl", "invite", "invitation", "share", "subadmin", "binding",
  "token", "key", "secret", "password", "credential", "recovery", "oauth", "authorize", "authorization", "collaborator", "owner",
  "transactional", "mfa", "totp", "webauthn", "sso", "saml", "provider", "delegate", "delegation", "forwarding", "admin", "notification",
  "alert", "announcement", "message", "email", "sms", "dm", "call", "comment", "schedule", "import", "export", "layout", "status",
  "label", "contents", "generate", "change", "replace", "apply", "execute", "run", "trigger", "sync", "upsert", "overwrite", "merge",
  "protection", "team", "org", "organization", "device", "giftcard", "voucher", "order", "cart", "agent", "conversation",
  "campaign", "automation", "inbox", "social", "profile", "setting", "webhook", "hook", "integration", "variable",
  "mirror", "attendee", "recipient", "deployment", "mail",
]);
/** Long stems that also match inside one word ("bankimportjobs", "passwordreset"). */
const SENSITIVE_STEMS = ["import", "password", "permission", "secret", "token", "invit", "credential", "recovery", "membership", "giftcard", "voucher", "sendmail"] as const;
/** Negating prefixes: un/de/dis/re + a known verb (unassign, unshare, deactivate, disconnect, reassign) is never a narrow write. */
const NEGATION = /^(?:un|de|dis|re)(.+)$/u;

/** Singular form for matching ("users" → "user", "statuses" → "status", "policies" → "policy"). */
function singular(part: string): string {
  if (part.endsWith("ies") && part.length > 4) return `${part.slice(0, -3)}y`;
  if (/(?:ses|xes|zes|ches|shes)$/u.test(part)) return part.slice(0, -2);
  if (part.endsWith("s") && !part.endsWith("ss") && part.length > 3) return part.slice(0, -1);
  return part;
}

/** True when any word of the text keeps the full CRUD set (sensitive word or stem, negated verb). */
export function keepsFullCrud(text: string): boolean {
  return nameParts(text).some((raw) => {
    const part = singular(raw);
    if (SENSITIVE_WORDS.has(part) || SENSITIVE_WORDS.has(raw) || SENSITIVE_STEMS.some((stem) => raw.includes(stem))) return true;
    if (isKnownVerb(part) || DELETE_VERBS.has(part)) return false;
    const negated = NEGATION.exec(part)?.[1];
    return negated !== undefined && (isKnownVerb(negated) || ACTION_WORDS.has(negated) || SENSITIVE_WORDS.has(negated));
  });
}

/**
 * Coordinator 2026-10-20 (PR #17): calendar / event / meeting / appointment / booking TOOLS (Composio, MCP) invite attendees but
 * are not send tools (isSendTool), so no first-contact hold fires for a new external attendee. They keep [create, update].
 * Names only: catalog paths such as pretix `/events/` are ticketed events, not invitations.
 */
const INVITE_OBJECT_WORDS = new Set(["event", "meeting", "appointment", "booking", "calendar"]);
const namesInviteObject = (name: string) => nameParts(name).some((part) => INVITE_OBJECT_WORDS.has(singular(part)) || part.includes("calendar"));

/** Only plain ASCII names are narrowed: a look-alike letter (Cyrillic "е" in "dеlete") must not hide a verb. */
const plainName = (name: string) => /^[\x20-\x7e]*$/u.test(name) && name.normalize("NFKC") === name;

/**
 * C276a: a narrower CRUD set for a write class, kept only when it is safe. `read` and `money` classes never change; the new set
 * must be a SUBSET of the old one (never a new action: review #17, ADD_AND_REMOVE → [create, delete] would need create where
 * [update, delete] did not); a destructive class must keep `delete`. Effect and hold family never change (guardrail c), so
 * outward writes stay held per policy.
 */
export function withCrud(cls: ToolClass, crud: readonly CrudAction[] | null): ToolClass {
  if (!crud || crud.length === 0 || cls.effect === "read" || cls.effect === "money") return cls;
  const set = CRUD_ORDER.filter((action) => crud.includes(action));
  if (set.length === 0 || !set.every((action) => cls.crud.includes(action))) return cls;
  if (cls.effect === "destructive" ? !set.includes("delete") : set.includes("delete")) return cls;
  return { ...cls, crud: set };
}

/**
 * C276a (d): the CRUD a Composio / MCP tool needs, from the verbs of its name: CREATE/ADD/INSERT → create, UPDATE/SET/PATCH/EDIT
 * → update, DELETE/REMOVE → delete. Any other verb (SEND, POST, PUBLISH, ...) or no verb at all → null (keep classify()'s
 * [create, update]). Read verbs and the noun words (draft, email, message, ...) do not count as verbs. Review #17: a name that
 * is not plain ASCII, or that names a sensitive object or a negated verb (keepsFullCrud), is never narrowed.
 */
export function crudFromName(name: string): CrudAction[] | null {
  if (!plainName(name) || keepsFullCrud(name) || namesInviteObject(name)) return null;
  const verbs = nameParts(name).filter((part) => !NOUN_PARTS.has(part) && !READ_PARTS.has(part) && (isKnownVerb(part) || CREATE_VERBS.has(part) || DELETE_VERBS.has(part)));
  if (verbs.length === 0) return null;
  const crud = new Set<CrudAction>();
  for (const verb of verbs) {
    if (CREATE_VERBS.has(verb)) crud.add("create");
    else if (UPDATE_VERBS.has(verb)) crud.add("update");
    else if (DELETE_VERBS.has(verb)) crud.add("delete");
    else return null;
  }
  return CRUD_ORDER.filter((action) => crud.has(action));
}

/** Path words that make a POST an action, not a collection create (C276a guardrail a), besides every known verb. */
const ACTION_WORDS = new Set([
  "graphql", "rpc", "jsonrpc", "command", "commands", "action", "actions", "bulk", "toggle", "clone", "retry", "resend", "restore",
  "reset", "rotate", "login", "logout", "auth", "token", "tokens", "webhook", "hooks", "callback", "callbacks", "test", "ping",
  "plus", "minus", "increment", "decrement", "start", "pause", "resume", "complete", "confirm", "generate", "authorize", "redeem",
  "transmit", "transact", "distribute", "extend", "reactivate", "migrate", "dispatch", "process", "link", "unlink", "connect",
  "activate", "assign", "lock", "approve", "change", "replace", "apply",
]);

/**
 * True when a path segment names an action: a known verb as written ("send", "publish"; the plural noun "posts" is not the verb
 * "post"), or an ACTION_WORDS word singular or plural, in any naming style.
 */
export function isActionWord(segment: string): boolean {
  return nameParts(segment).some((raw) => isKnownVerb(raw) || ACTION_WORDS.has(raw) || ACTION_WORDS.has(singular(raw))) || namesMoney(segment);
}

/**
 * C276a: the name-based CRUD applied to a class (Composio, MCP). Review #17: an OUTWARD class keeps its set when its name holds
 * any outward word, also the noun-like ones (create_message, add_comment, create_email): the send is the point of the tool.
 */
export function narrowByName(name: string, cls: ToolClass): ToolClass {
  if (cls.effect === "outward" && nameParts(name).some((part) => OUTWARD_PARTS.has(part) || OUTWARD_PARTS.has(singular(part)))) return cls;
  return withCrud(cls, crudFromName(name));
}

/**
 * MCP tool class. Money words always win. X-03: annotations come from an untrusted server, so they may only RAISE a class:
 * `destructiveHint: true` → destructive; `readOnlyHint: false` → never read. `readOnlyHint: true` is believed only when the
 * name inference also says read, or when the owner marked this tool read in Connect (`ownerRead`, op mcp_tool_read_set).
 */
export function classifyMcpTool(name: string, annotations: Record<string, unknown> | undefined, ownerRead = false): ToolClass {
  return narrowByName(name, classifyMcpBase(name, annotations, ownerRead));
}

function classifyMcpBase(name: string, annotations: Record<string, unknown> | undefined, ownerRead: boolean): ToolClass {
  const a = annotations ?? {};
  if (namesMoney(name)) return classify({ write: true, outward: true, destructive: false, money: true });
  if (a.destructiveHint === true) return classify({ write: true, outward: false, destructive: true });
  if (ownerRead) return classify({ write: false, outward: false, destructive: false });
  const inferred = inferFromName(name);
  // The server says the tool is not read-only: never class it as read.
  if (a.readOnlyHint === false && inferred.effect === "read") return classify({ write: true, outward: a.openWorldHint !== false, destructive: false });
  return inferred;
}

/** X-03: the server claims read-only but Connect classes the tool higher; the owner can confirm it as read. */
export function mcpReadClaimUnverified(name: string, annotations: Record<string, unknown> | undefined): boolean {
  return annotations?.readOnlyHint === true && annotations.destructiveHint !== true && !namesMoney(name) && inferFromName(name).effect !== "read";
}

// ── X-02: first contact for dynamic send tools ──

/** Verbs that make an outward tool a SEND to people (mail, DM, SMS, invites): only these need a known recipient. */
const SEND_PARTS = new Set(["send", "sends", "reply", "replies", "forward", "forwards", "dm", "sms", "mms", "invite", "invites", "share", "shares", "notify", "broadcast", "tweet"]);

/** True for an `outward` dynamic tool that sends to people: first contact applies (X-02, C107). */
export function isSendTool(tool: { name: string; upstream?: string; effect: Effect; sendRecipients?: readonly string[] }): boolean {
  if (tool.effect !== "outward") return false;
  // C276c: a catalog entry labels a send explicitly (`firstContact`), with where its recipients are.
  if (tool.sendRecipients !== undefined) return true;
  return nameParts(tool.upstream ?? tool.name).some((part) => SEND_PARTS.has(part)) || isInviteTool(tool);
}

/**
 * CF-GC-1 (Coordinator 2026-10-20): an outward tool that names an invite object (event, meeting, appointment, booking,
 * calendar: GOOGLECALENDAR_CREATE_EVENT, create_meeting) invites its attendees, so it is a send tool for first contact: a new
 * external attendee is held like a new Gmail recipient. Unlike a mail, an invite with NO attendees reaches nobody and runs.
 */
export function isInviteTool(tool: { name: string; upstream?: string; effect: Effect }): boolean {
  return tool.effect === "outward" && namesInviteObject(tool.upstream ?? tool.name);
}

/**
 * Argument names (lower case, `_`/`-` removed) that carry recipients, from the real Composio schemas (GMAIL_SEND_EMAIL
 * recipient_email/cc/bcc/extra_recipients, GMAIL_FORWARD_MESSAGE recipients, OUTLOOK_SEND_EMAIL to/cc_emails/bcc_emails),
 * Microsoft Graph (toRecipients) and common chat/SMS tools (channel, chat_id, phone_number).
 */
const RECIPIENT_KEYS = new Set([
  "to", "cc", "bcc", "recipient", "recipients", "recipientemail", "recipientemails", "extrarecipients", "ccemails", "bccemails",
  "toemail", "toemails", "toaddress", "toaddresses", "torecipients", "ccrecipients", "bccrecipients", "email", "emails",
  "emailaddress", "emailaddresses", "attendees", "invitees", "phone", "phonenumber", "tonumber", "channel", "channelid", "chatid",
  "conversationid", "userid", "username", "user",
]);
/** Values that name the sender itself, not a recipient (Composio `user_id: "me"`). */
const SELF_VALUES = new Set(["me", "self"]);
const MAX_RECIPIENTS = 100;

/** One address in a stable form: `Name <a@b.c>` → `a@b.c`; lower case; trimmed. */
/** Never a real address (spaces): a recipient value Connect cannot read, so no contact book holds it. */
export const UNREADABLE_RECIPIENT = "(unreadable recipient value)";
const EMAIL_TOKEN = /[^\s<>"',;()[\]]{1,200}@[^\s<>"',;()[\]]{1,200}/gu;

function normaliseAddress(raw: string): string | null {
  const angle = /<([^<>]+)>/u.exec(raw);
  const v = (angle?.[1] ?? raw).trim().toLowerCase();
  return v && v.length <= 320 && !SELF_VALUES.has(v) ? v : null;
}

function collect(value: unknown, out: Set<string>, depth: number): void {
  if (out.size > MAX_RECIPIENTS || depth > 4 || value === null || value === undefined) return;
  if (typeof value === "string") {
    for (const piece of value.split(/[,;\n]+/u)) {
      // Review #19 S2-1: '"<known@x>" <new@y>' must not hide new@y behind a display name. Every email-like token of the piece
      // counts (over-holding is safe); a piece with none (a phone number, a channel id) is taken as one value.
      // Review #19 re-check: no truncation (padding must not hide an address); a piece too long to be a real address list adds a
      // marker no contact book holds, so the call is always a first contact.
      if (piece.length > 2000) out.add(UNREADABLE_RECIPIENT);
      if (piece.length > 20_000) continue; // held anyway; do not scan huge values
      const emails = piece.match(EMAIL_TOKEN) ?? [];
      if (emails.length > 0) {
        for (const e of emails) {
          const a = normaliseAddress(e);
          if (a) out.add(a);
        }
      } else {
        const a = normaliseAddress(piece);
        if (a) out.add(a);
      }
    }
  } else if (typeof value === "number") {
    out.add(String(value));
  } else if (Array.isArray(value)) {
    for (const item of value) collect(item, out, depth + 1);
  } else if (typeof value === "object") {
    // Graph style { emailAddress: { address } } and { email | address | id | name }.
    const o = value as Record<string, unknown>;
    const inner = o.emailAddress ?? o.email ?? o.address ?? o.id ?? o.phone ?? o.number;
    collect(inner, out, depth + 1);
  }
}

/**
 * The recipients a send tool names in its arguments (X-02). Only the top-level recipient argument names count; a send tool
 * with none (GMAIL_SEND_DRAFT draft_id, a reply that names no address) gives [] and is treated as first contact (fail closed).
 */
/**
 * C276c: the recipients at the input pointers a catalog entry names ("body.recipients", "body.to", "query.email"); [] when the
 * pointers are empty or name nothing (the call is then a first contact, fail closed).
 */
export function recipientsAt(args: Record<string, unknown>, pointers: readonly string[]): string[] {
  const out = new Set<string>();
  // Review #19 S3-1: the FIRST pointer is the primary recipient (to, recipients, raised_by). When it names nobody the app may
  // fall back to a stored address, so the call is treated as having unknown recipients ([] = first contact, held).
  const primary = new Set<string>();
  if (pointers[0]) collectAt(args, pointers[0], primary);
  if (primary.size === 0) return [];
  for (const pointer of pointers) collectAt(args, pointer, out);
  return [...out].sort().slice(0, MAX_RECIPIENTS + 1);
}

function collectAt(args: Record<string, unknown>, pointer: string, out: Set<string>): void {
  const [group, key] = pointer.split(".");
  const container = group ? args[group] : undefined;
  if (key && container && typeof container === "object" && !Array.isArray(container)) collect((container as Record<string, unknown>)[key], out, 0);
}

export function recipientsOf(args: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const [key, value] of Object.entries(args)) {
    if (RECIPIENT_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/gu, ""))) collect(value, out, 0);
  }
  return [...out].sort().slice(0, MAX_RECIPIENTS + 1);
}
