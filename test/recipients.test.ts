/**
 * C373 / G-6 ("who may talk to whom"): Connect names WHERE the recipients of an outward call are (src/recipients.ts).
 * Dynamic tools: `DynamicResolution.recipients` = pointers into the inner tool arguments, per tool (variants inherit).
 * Static ops: prepared, not applied (the pinned manifest validator refuses the member until the spec 0.1.81 pin bump).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { validateManifest } from "@opt2-tealbrick/manifest";
import type { JsonSchemaObject, Manifest } from "@opt2-tealbrick/spec/manifest";
import { COMPOSIO_SENDS, dynamicRecipients, RECIPIENT_KINDS, RECIPIENT_SPECS_MAX, type RecipientSpec, STATIC_OP_RECIPIENTS } from "../src/recipients.ts";
import { DRAFT_SUFFIX, entrySchema, FIRST_CONTACT_SUFFIX, ToolRegistry, type ToolRow, type ToolSource, toolName } from "../src/tools.ts";
import { root, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;

const OUT = { crud: ["create", "update"], effect: "outward", holdFamily: "outward" } as const;
const READ = { crud: ["read"], effect: "read" } as const;
const schema = (...names: string[]): JsonSchemaObject => entrySchema({ type: "object", properties: Object.fromEntries(names.map((n) => [n, { type: "string" }])) });
const row = (upstream: string, props: string[], cls: Pick<ToolRow, "crud" | "effect" | "holdFamily"> = { ...OUT, crud: [...OUT.crud] }): Omit<ToolRow, "source" | "service"> => ({
  name: toolName(upstream),
  upstream,
  title: upstream,
  description: upstream,
  inputSchema: schema(...props),
  crud: [...cls.crud],
  effect: cls.effect,
  ...(cls.holdFamily ? { holdFamily: cls.holdFamily } : {}),
});
const emails = (...names: string[]): RecipientSpec[] => names.map((n) => ({ pointer: `/${n}`, kind: "email" }));

/** The real top-level properties of the Composio schemas read 2026-10-27 (Gmail/Slack 20261023_00, Outlook 20261022_00, Telegram 20260821_00). */
const COMPOSIO = {
  gmail: [
    row("GMAIL_SEND_EMAIL", ["cc", "bcc", "body", "is_html", "subject", "user_id", "attachment", "from_email", "recipient_email", "extra_recipients", "include_signature"]),
    row("GMAIL_REPLY_TO_THREAD", ["cc", "bcc", "is_html", "user_id", "thread_id", "attachment", "message_body", "recipient_email", "extra_recipients", "include_signature"]),
    row("GMAIL_FORWARD_MESSAGE", ["cc", "bcc", "user_id", "message_id", "recipients", "additional_text", "include_signature"]),
    row("GMAIL_SEND_DRAFT", ["user_id", "draft_id"]),
    row("GMAIL_FETCH_EMAILS", ["query", "max_results", "user_id"], { crud: ["read"], effect: "read" }),
  ],
  outlook: [
    row("OUTLOOK_SEND_EMAIL", ["to", "body", "is_html", "subject", "to_name", "user_id", "cc_emails", "attachment", "bcc_emails", "from_address", "save_to_sent_items"]),
    row("OUTLOOK_FORWARD_MESSAGE", ["comment", "user_id", "message_id", "to_recipients"]),
    row("OUTLOOK_REPLY_EMAIL", ["comment", "is_html", "user_id", "cc_emails", "attachment", "bcc_emails", "message_id"]),
  ],
  slack: [
    row("SLACK_SEND_MESSAGE", ["blocks", "channel", "thread_ts", "unfurl_links", "unfurl_media", "fallback_text", "markdown_text", "reply_broadcast"]),
    row("SLACK_CHAT_POST_MESSAGE", ["text", "parse", "blocks", "mrkdwn", "channel", "thread_ts", "link_names", "attachments", "unfurl_links", "unfurl_media", "markdown_text", "reply_broadcast"]),
    row("SLACK_SEND_EPHEMERAL_MESSAGE", ["text", "user", "parse", "blocks", "as_user", "channel", "icon_url", "username", "thread_ts", "icon_emoji", "link_names", "attachments", "markdown_text"]),
  ],
  telegram: [
    row("TELEGRAM_SEND_MESSAGE", ["text", "chat_id", "parse_mode", "reply_markup", "reply_to_message_id", "disable_notification", "disable_web_page_preview"]),
    row("TELEGRAM_FORWARD_MESSAGE", ["chat_id", "message_id", "from_chat_id", "disable_notification"]),
  ],
};

function registry(): ToolRegistry {
  const tools = new ToolRegistry(testDb());
  for (const [service, rows] of Object.entries(COMPOSIO)) tools.replaceService("composio", service, rows);
  return tools;
}
const places = (tools: ToolRegistry, name: string) => tools.resolve(name)?.recipients;

/** RFC 6901 evaluation (as the bridge reads a place), for the examples below. */
function at(rootValue: unknown, pointer: string): unknown {
  let cur = rootValue;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
    cur = cur && typeof cur === "object" && Object.hasOwn(cur, token) ? (cur as Record<string, unknown>)[token] : undefined;
  }
  return cur;
}

test("Gmail: send and reply name recipient_email, its alias to, extra_recipients, cc and bcc as email; forward names recipients, cc, bcc", () => {
  const tools = registry();
  assert.deepEqual(places(tools, "gmail_send_email"), emails("recipient_email", "to", "extra_recipients", "cc", "bcc"));
  assert.deepEqual(places(tools, "gmail_reply_to_thread"), emails("recipient_email", "to", "extra_recipients", "cc", "bcc"));
  assert.deepEqual(places(tools, "gmail_forward_message"), emails("recipients", "cc", "bcc"));
  // the places point at the agent's arguments as Connect passes them upstream (connect_account is not a place)
  const args = { connect_account: "Work", recipient_email: "ann@example.com", cc: ["bob@example.com"], bcc: [], subject: "Hi" };
  const values = (places(tools, "gmail_send_email") ?? []).map((p) => at(args, p.pointer)).filter((v) => v !== undefined);
  assert.deepEqual(values, ["ann@example.com", ["bob@example.com"], []]);
  // Connect never rewrites arguments: "Name <a@b>" stays as is (the bridge marks it recipientsIncomplete; Rules fail closed)
  assert.equal(at({ recipient_email: "Ann <ann@example.com>" }, "/recipient_email"), "Ann <ann@example.com>");
});

test("Outlook send and forward are email places; Slack channel (and channel_id) and the ephemeral user; Telegram chat_id", () => {
  const tools = registry();
  assert.deepEqual(places(tools, "outlook_send_email"), emails("to", "cc_emails", "bcc_emails"));
  assert.deepEqual(places(tools, "outlook_forward_message"), emails("to_recipients"));
  const slack = [
    { pointer: "/channel", kind: "slack" },
    { pointer: "/channel_id", kind: "slack" },
  ];
  assert.deepEqual(places(tools, "slack_send_message"), slack);
  assert.deepEqual(places(tools, "slack_chat_post_message"), slack);
  // an ephemeral message reaches `user` only, not the members of `channel`
  assert.deepEqual(places(tools, "slack_send_ephemeral_message"), [{ pointer: "/user", kind: "slack" }]);
  assert.deepEqual(places(tools, "telegram_send_message"), [{ pointer: "/chat_id", kind: "telegram" }]);
  // the sender's chat (from_chat_id) is not a recipient
  assert.deepEqual(places(tools, "telegram_forward_message"), [{ pointer: "/chat_id", kind: "telegram" }]);
});

test("variants: __first_contact has the places of its base; a read, a draft send, an implicit reply and unknown names have none", () => {
  const tools = registry();
  for (const base of ["gmail_send_email", "slack_send_message", "telegram_send_message", "outlook_send_email"]) {
    const first = tools.resolve(`${base}${FIRST_CONTACT_SUFFIX}`);
    assert.equal(first?.holdFamily, "first_contact", base);
    assert.deepEqual(first?.recipients, places(tools, base), base);
    assert.ok(first?.recipients && first.recipients.length > 0, base);
  }
  const fetch = tools.resolve("gmail_fetch_emails");
  assert.deepEqual(fetch, { tool: "gmail_fetch_emails", ...READ, crud: ["read"] });
  // the recipients of a draft are in the stored draft; an Outlook reply goes to the original sender: unknown (Rules fail closed)
  assert.equal(tools.resolve("gmail_send_draft")?.effect, "outward");
  assert.equal("recipients" in (tools.resolve("gmail_send_draft") ?? {}), false);
  assert.equal("recipients" in (tools.resolve(`gmail_send_draft${FIRST_CONTACT_SUFFIX}`) ?? {}), false);
  assert.equal("recipients" in (tools.resolve("outlook_reply_email") ?? {}), false);
  assert.equal(tools.resolve("nope"), null);
  assert.equal(tools.resolve(`gmail_send_email${DRAFT_SUFFIX}`), null);
});

test("Postiz: the create-post tool and its __draft form name no recipients (it posts to the owner's own channels)", () => {
  const tools = new ToolRegistry(testDb());
  const create = { ...row("PublicIntegrationsController_createPost", ["body"]), name: "postiz_create_post", httpMethod: "post", httpPath: "/public/v1/posts" };
  tools.replaceService("catalog", "postiz", [create]);
  const base = tools.resolve("postiz_create_post");
  assert.equal(base?.effect, "outward");
  assert.equal("recipients" in (base ?? {}), false);
  const draft = tools.resolve(`postiz_create_post${DRAFT_SUFFIX}`);
  assert.equal(draft?.effect, "write");
  assert.equal("recipients" in (draft ?? {}), false);
});

test("catalog sends: the entry's firstContact labels (sendRecipients, dotted) stay Connect's first-contact gate and are not places", () => {
  const tools = new ToolRegistry(testDb());
  // as the frappe-crm entry labels them (catalog 0.3.1): no kind, record names next to addresses, a stored customer behind body.to
  const reply = { ...row("hd_reply_to_ticket", ["body"]), name: "frappe_crm_hd_reply_to_ticket", sendRecipients: ["body.to", "body.cc", "body.bcc"] };
  const create = { ...row("hd_ticket_create", ["body"]), name: "frappe_crm_hd_ticket_create", sendRecipients: ["body.raised_by", "body.contact", "body.customer"] };
  tools.replaceService("catalog", "frappe-crm", [reply, create]);
  for (const name of ["frappe_crm_hd_reply_to_ticket", "frappe_crm_hd_ticket_create"]) {
    assert.equal(tools.resolve(name)?.effect, "outward", name);
    assert.equal("recipients" in (tools.resolve(name) ?? {}), false, name);
    assert.equal("recipients" in (tools.resolve(`${name}${FIRST_CONTACT_SUFFIX}`) ?? {}), false, name);
  }
});

test("guards: only outward Composio tools of the table, and only while the current schema matches the table", () => {
  const one = (source: ToolSource, r: Omit<ToolRow, "source" | "service">) => dynamicRecipients({ ...r, source });
  const send = row("GMAIL_SEND_EMAIL", ["recipient_email", "cc", "bcc", "subject"]);
  assert.deepEqual(one("composio", send), emails("recipient_email", "to", "extra_recipients", "cc", "bcc"));
  // same slug from an MCP server or the catalog: not Composio's schema
  assert.equal(one("mcp", send), null);
  assert.equal(one("catalog", send), null);
  // not outward (the owner re-classed it, or the policy says write): no places (they are for outward calls only)
  assert.equal(one("composio", { ...send, crud: ["create"], effect: "write" }), null);
  // drift: a new recipient-like property that no place covers → unknown, never places that miss someone
  assert.equal(one("composio", row("GMAIL_SEND_EMAIL", ["recipient_email", "cc", "bcc", "reply_to_recipients", "to_addresses"])), null);
  assert.equal(one("composio", row("SLACK_SEND_MESSAGE", ["channel", "users"])), null);
  // drift: none of the places is in the schema any more (renamed) → unknown
  assert.equal(one("composio", row("GMAIL_SEND_EMAIL", ["recipient", "subject"])), null);
  // an oversized schema collapses to an open object (only connect_account) → unknown
  const huge = { ...send, inputSchema: entrySchema({ type: "object", properties: { recipient_email: { type: "string", description: "x".repeat(20_000) } } }) };
  assert.equal(one("composio", huge), null);
  // a slug that is not in the table (and an inherited Object member name) → unknown
  assert.equal(one("composio", row("DISCORD_SEND_MESSAGE", ["channel_id", "content"])), null);
  assert.equal(one("composio", row("constructor", ["to"])), null);
});

test("every table entry is a valid M-OP-14 list: 1..8 unique RFC 6901 places of a known kind", () => {
  const lists = [...Object.values(COMPOSIO_SENDS).map((e) => e.specs), ...Object.values(STATIC_OP_RECIPIENTS)];
  for (const specs of lists) {
    assert.ok(specs.length >= 1 && specs.length <= RECIPIENT_SPECS_MAX);
    assert.equal(new Set(specs.map((s) => `${s.kind} ${s.pointer}`)).size, specs.length);
    for (const s of specs) {
      assert.match(s.pointer, /^(?:\/(?:[^~/]|~[01])*)+$/u);
      assert.ok((RECIPIENT_KINDS as readonly string[]).includes(s.kind));
    }
  }
  // the spec 0.1.81 kind list (manifest normalizeHandle channels)
  assert.deepEqual(RECIPIENT_KINDS, ["buzz", "slack", "telegram", "email"]);
});

test("static ops: buzz_dm and buzz_dm_first name /to as buzz; prepared, NOT in the manifest until the spec 0.1.81 pin bump", () => {
  assert.deepEqual(Object.keys(STATIC_OP_RECIPIENTS).sort(), ["buzz_dm", "buzz_dm_first"]);
  for (const [id, specs] of Object.entries(STATIC_OP_RECIPIENTS)) {
    const op = manifest.operations.find((o) => o.id === id);
    assert.ok(op, id);
    assert.equal(op.effect, "outward", id);
    for (const s of specs) assert.ok(op.input?.properties && Object.hasOwn(op.input.properties, s.pointer.slice(1)), `${id} ${s.pointer}`);
  }
  // nothing applied yet: the shipped manifest has no recipients member on any op
  assert.equal(
    manifest.operations.some((o) => Object.hasOwn(o, "recipients")),
    false,
  );
  // Tripwire for the re-pin: the pinned validator refuses the member today. When this assertion fails, the manifest pin knows
  // `operations[].recipients` (spec 0.1.81): apply STATIC_OP_RECIPIENTS to tealbrick.manifest.json and turn this into a check
  // that the manifest carries exactly these places.
  const applied = structuredClone(manifest);
  for (const op of applied.operations) {
    const specs = STATIC_OP_RECIPIENTS[op.id];
    if (specs) Object.assign(op, { recipients: specs });
  }
  const result = validateManifest(applied);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.some((e) => /^\/operations\/\d+\/recipients$/u.test(e.path)));
});
