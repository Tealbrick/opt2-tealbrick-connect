/**
 * C373 / G-6 ("who may talk to whom"): WHERE the recipients of an outward call are, so the bridge can read them into the hook
 * target (`target.recipients`, cap `hook_recipients`) and Rules can match them. Contract:
 * coordination/leads/rules/CONTRACT-RECIPIENTS.md, block "THIRD PASS" (final).
 *
 * Connect names PLACES, never values: a `RecipientSpec` is an RFC 6901 pointer plus the handle kind of the value found there.
 * - Static ops: `operations[].recipients` in tealbrick.manifest.json, pointers into the op input (`STATIC_OP_RECIPIENTS` below).
 * - Dynamic tools: `DynamicResolution.recipients`, pointers into the INNER tool arguments (`input.arguments` of `tools_call`).
 *   `resolve(tool)` has no call arguments and the bridge caches it per tool, so the places come from the tool, not the call.
 *
 * Connect does NOT rewrite arguments. A value the bridge cannot read as a bare handle of the place's kind (Gmail
 * `"Ann <ann@example.com>"`, `me`, a comma list `a@x, b@y`, a Slack channel id `C…` or `D…`, a Slack channel name, a Telegram
 * `@username`, a Telegram chat id sent as a JSON number) makes the bridge set `target.recipientsIncomplete`, and Rules fail closed.
 * No recipients (absent) = unknown: Rules apply deny and hold recipient rules and never an allow rule (fail closed). So a tool
 * gets places ONLY when every place that can name a recipient is known; anything less stays absent.
 */
import type { DynamicResolution, Effect, JsonSchemaObject } from "@opt2-tealbrick/spec/manifest";

// TODO(C373 re-pin, spec 0.1.81): `RecipientSpec`, `RecipientKind`, `RECIPIENT_KINDS`, `RECIPIENT_SPECS_MAX` and
// `DynamicResolution.recipients` come from `@opt2-tealbrick/spec/manifest` (specs#64, labelled 0.1.81, not released yet; the
// manifest rule is M-OP-14, sdk#61). Import them from there and delete these local mirrors when the spec, manifest and
// miniapp-sdk pins move. Until the miniapp-sdk pin moves, the SDK resolve route drops
// `recipients` (it copies only tool, crud, effect, holdFamily), so the bridge does not see them yet.
export const RECIPIENT_KINDS = ["buzz", "slack", "telegram", "email"] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];
export interface RecipientSpec {
  /** RFC 6901 pointer into the op input (static op) or the inner tool arguments (dynamic tool) */
  pointer: string;
  kind: RecipientKind;
}
/** M-OP-14: 1..8 places per op or resolution */
export const RECIPIENT_SPECS_MAX = 8;
/** `DynamicResolution` with the spec 0.1.81 field (structural until the spec pin types it). */
export type ResolutionWithRecipients = DynamicResolution & { recipients?: RecipientSpec[] };

const places = (kind: RecipientKind, ...names: string[]): RecipientSpec[] => names.map((n) => ({ pointer: `/${n}`, kind }));

/**
 * Static outward ops that send to ONE kind of handle (spec 0.1.81 `operations[].recipients`). PREPARED, NOT APPLIED: the pinned
 * manifest validator (@opt2-tealbrick/manifest 0.1.28) refuses an unknown `recipients` member on an op (`schema_invalid`), so
 * these go into tealbrick.manifest.json with the manifest pin bump (test/recipients.test.ts fails on that bump as a reminder).
 * Not here, on purpose (absent = unknown = Rules fail closed):
 * - `channel_send`, `channel_reply`, `channel_dm`, `channel_dm_first`, `channel_edit`, `channel_react`: the kind of `person` /
 *   `conversation` depends on the account's service (slack, telegram, teams, discord), and a place has one fixed kind; a
 *   conversation is also often a group, not a person. Needs a spec change (kind from the account) or per-service ops.
 * - `buzz_post`, `buzz_schedule`, `buzz_edit`, `buzz_react`: `channel` is a Buzz group channel id, not a person's key.
 * - `buzz_profile_publish`: publishes the agent's own profile; nobody is addressed.
 */
export const STATIC_OP_RECIPIENTS: Readonly<Record<string, readonly RecipientSpec[]>> = {
  buzz_dm: places("buzz", "to"),
  buzz_dm_first: places("buzz", "to"),
};

/**
 * Composio tools (by upstream slug) whose recipients are top-level arguments, from the Composio schemas read 2026-10-27 (Gmail
 * and Slack 20261023_00, Outlook 20261022_00, Telegram 20260821_00). Aliases that Composio documents but that are not schema
 * properties are listed too (GMAIL_SEND_EMAIL `to` for `recipient_email`, Slack `channel_id` for `channel`): an argument that
 * reaches people but has no place would let a call look like it has no recipients.
 * Not here, on purpose (absent = unknown = Rules fail closed):
 * - GMAIL_SEND_DRAFT, OUTLOOK_SEND_DRAFT: the recipients are in the stored draft, not in the arguments.
 * - OUTLOOK_REPLY_EMAIL, OUTLOOK_REPLY_ALL and reply drafts: the reply goes to the original sender, who is not an argument.
 * - GMAIL_CREATE_EMAIL_DRAFT and other drafts: a draft reaches nobody.
 * - MCP tools, Discord and Teams tools (no handle kind), Buzz/Nostr (no Composio toolkit; Connect's own `buzz_dm` op is static).
 * - Catalog tools, Postiz included (it posts to the owner's own channels, not to a person). The catalog's own recipient
 *   labels (`firstContact[].recipients` → `ToolRow.sendRecipients`, dotted `body.to`) are NOT converted to places, and that is
 *   the only other source: it covers catalog ops, this table covers Composio slugs, so no tool has two. They are not converted
 *   because they mean something else: (1) no kind (frappe-crm `hd_ticket_create` names `body.contact` and `body.customer`,
 *   which are record names, not addresses); (2) Connect's first-contact gate treats an EMPTY first place as "recipients
 *   unknown" (`recipientsAt`, review #19 S3-1: `hd_reply_to_ticket` without `body.to` still mails the stored ticket customer),
 *   while the bridge reads an empty place as "no recipients", which would tell Rules a mail to the customer has none.
 *   Follow-up (catalog format): a `kind` per label and a rule for stored recipients, then one converter here.
 */
export const COMPOSIO_SENDS: Readonly<Record<string, { specs: readonly RecipientSpec[]; notRecipients?: readonly string[] }>> = {
  GMAIL_SEND_EMAIL: { specs: places("email", "recipient_email", "to", "extra_recipients", "cc", "bcc") },
  GMAIL_REPLY_TO_THREAD: { specs: places("email", "recipient_email", "to", "extra_recipients", "cc", "bcc") },
  GMAIL_FORWARD_MESSAGE: { specs: places("email", "recipients", "cc", "bcc") },
  OUTLOOK_SEND_EMAIL: { specs: places("email", "to", "cc_emails", "bcc_emails") },
  OUTLOOK_FORWARD_MESSAGE: { specs: places("email", "to_recipients") },
  SLACK_SEND_MESSAGE: { specs: places("slack", "channel", "channel_id") },
  SLACK_CHAT_POST_MESSAGE: { specs: places("slack", "channel", "channel_id") },
  SLACK_SCHEDULE_MESSAGE: { specs: places("slack", "channel", "channel_id") },
  // an ephemeral message is shown to `user` only, inside `channel`: the other channel members do not get it
  SLACK_SEND_EPHEMERAL_MESSAGE: { specs: places("slack", "user"), notRecipients: ["channel"] },
  TELEGRAM_SEND_MESSAGE: { specs: places("telegram", "chat_id") },
  TELEGRAM_SEND_PHOTO: { specs: places("telegram", "chat_id") },
  TELEGRAM_SEND_DOCUMENT: { specs: places("telegram", "chat_id") },
  TELEGRAM_FORWARD_MESSAGE: { specs: places("telegram", "chat_id") },
};

/**
 * Schema property names (lower case, `_`/`-` removed) that can name a recipient. Drift guard: when the tool's CURRENT schema
 * has such a property that no place covers (Composio added or renamed one), the tool gets no places (unknown, fail closed)
 * instead of places that miss someone. Sender fields (`user_id`, `from_email`, `from_chat_id`) are not in the set.
 */
const RECIPIENT_LIKE = new Set([
  "to", "cc", "bcc", "recipient", "recipients", "recipientemail", "recipientemails", "extrarecipients", "ccemails", "bccemails",
  "toemail", "toemails", "toaddress", "toaddresses", "torecipients", "ccrecipients", "bccrecipients", "email", "emails",
  "emailaddress", "emailaddresses", "attendees", "invitees", "phone", "phonenumber", "tonumber", "channel", "channelid", "chatid",
  "conversationid", "user", "userids", "users",
]);

const fold = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/gu, "");
/** The first reference token of a pointer, unescaped (RFC 6901 `~1` → `/`, `~0` → `~`). */
const topKey = (pointer: string) => (pointer.slice(1).split("/")[0] ?? "").replace(/~1/gu, "/").replace(/~0/gu, "~");

/**
 * The recipient places of one dynamic tool, or null (unknown). Only an `outward` Composio tool of the table, and only when its
 * current input schema names at least one of the places and has no recipient-like property outside them (an oversized schema
 * that collapsed to an open object names none, so it stays unknown).
 */
export function dynamicRecipients(tool: { source: string; upstream: string; effect: Effect; inputSchema: JsonSchemaObject }): RecipientSpec[] | null {
  if (tool.source !== "composio" || tool.effect !== "outward") return null;
  const known = Object.hasOwn(COMPOSIO_SENDS, tool.upstream) ? COMPOSIO_SENDS[tool.upstream] : undefined;
  if (!known) return null;
  const props = tool.inputSchema.properties && typeof tool.inputSchema.properties === "object" ? Object.keys(tool.inputSchema.properties) : [];
  const covered = new Set(known.specs.map((s) => fold(topKey(s.pointer))));
  const exempt = new Set((known.notRecipients ?? []).map(fold));
  if (!props.some((p) => covered.has(fold(p)))) return null;
  if (props.some((p) => RECIPIENT_LIKE.has(fold(p)) && !covered.has(fold(p)) && !exempt.has(fold(p)))) return null;
  return known.specs.map((s) => ({ ...s }));
}
