/**
 * QA R-1 / SDK-HV-1: a held Connect send shows the owner what it sends. GMAIL_SEND_DRAFT {draft_id} reads the draft with the
 * account the call would use (recipients, subject, first 500 characters as plain text, attachment names and sizes); sends with
 * the content in their arguments (GMAIL_SEND_EMAIL, Slack posts) are shown from the arguments; other tools keep the SDK view.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import type { DynamicHandlers } from "@opt2-tealbrick/spec/sdk";
import { AccountStore } from "../src/accounts.ts";
import { type ConnectError, createConnectApp } from "../src/app.ts";
import { formatSize, mailFromArgs, mailFromGmail, PREVIEW_CHARS, plainText, renderHoldView } from "../src/hold-view.ts";
import { classifyComposioTool, loadPolicies } from "../src/sources/composio/policy.ts";
import { entrySchema, ToolRegistry, toolName } from "../src/tools.ts";
import { eventCtx, fakeFetch, testCtx, testDb } from "./helpers.ts";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const WS = "ws_01TESTWORKSPACE00000000000";
const KEY = "ck_test_key_value_hv1";
const ME = "agt_01AGENTME000000000000000000";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

function rawDraft(o: { to?: string; cc?: string; subject?: string; plain?: string | null; html?: string | null; attachments?: { filename: string; size: number }[] }) {
  const alt = [
    ...(o.plain !== null && o.plain !== undefined ? [{ mimeType: "text/plain", body: { data: b64(o.plain), size: o.plain.length } }] : []),
    ...(o.html !== null && o.html !== undefined ? [{ mimeType: "text/html", body: { data: b64(o.html), size: o.html.length } }] : []),
  ];
  return {
    id: "r-1",
    message: {
      id: "m-1",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "me@work.example" },
          ...(o.to ? [{ name: "To", value: o.to }] : []),
          ...(o.cc ? [{ name: "Cc", value: o.cc }] : []),
          ...(o.subject !== undefined ? [{ name: "Subject", value: o.subject }] : []),
        ],
        parts: [{ mimeType: "multipart/alternative", parts: alt }, ...(o.attachments ?? []).map((a) => ({ mimeType: "application/pdf", filename: a.filename, body: { attachmentId: "att", size: a.size } }))],
      },
    },
  };
}

function setup() {
  const db = testDb();
  const state: { draft: unknown; draftOk: boolean; message: unknown } = { draft: null, draftOk: true, message: null };
  const upstream = fakeFetch({
    "POST /api/v3/tools/execute/GMAIL_GET_DRAFT": () => ({ body: state.draftOk ? { successful: true, data: state.draft } : { successful: false, error: "Requested entity was not found." } }),
    "POST /api/v3/tools/execute/GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID": () => ({ body: { successful: true, data: state.message } }),
    "POST /api/v3/tools/execute/GMAIL_SEND_DRAFT": () => ({ body: { successful: true, data: { id: "sent" } } }),
  });
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), fetchImpl: upstream.impl });
  void app.events?.agentAdded?.({ id: ME as `agt_${string}`, name: "Me", mode: "free", status: "active" }, eventCtx(db));
  const accounts = new AccountStore(db);
  const work = accounts.create({ service: "gmail", source: "composio", kind: "as_me", label: "Work inbox", externalRef: "ca_work", status: "connected" });
  const priv = accounts.create({ service: "gmail", source: "composio", kind: "as_me", label: "Private inbox", externalRef: "ca_priv", status: "connected" });
  const slack = accounts.create({ service: "slack", source: "composio", kind: "as_me", label: "Team Slack", externalRef: "ca_slack", status: "connected" });
  const gmail = loadPolicies().get("gmail");
  const tools = new ToolRegistry(db);
  tools.replaceService(
    "composio",
    "gmail",
    ["GMAIL_SEND_DRAFT", "GMAIL_SEND_EMAIL", "GMAIL_FORWARD_MESSAGE", "GMAIL_DELETE_MESSAGE", "GMAIL_FETCH_EMAILS"].map((slug) => ({
      name: toolName(slug),
      upstream: slug,
      title: slug === "GMAIL_SEND_DRAFT" ? "Send draft" : slug === "GMAIL_SEND_EMAIL" ? "Send email" : slug,
      description: slug,
      inputSchema: entrySchema({ type: "object", properties: {} }),
      ...classifyComposioTool(slug, gmail),
    })),
  );
  tools.replaceService("composio", "slack", [
    { name: toolName("SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL"), upstream: "SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL", title: "Send message", description: "Post", inputSchema: entrySchema({}), ...classifyComposioTool("SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL", undefined) },
  ]);
  const dyn = app.dynamic?.tools as DynamicHandlers & { holdView: NonNullable<DynamicHandlers["holdView"]> };
  assert.ok(dyn?.holdView, "Connect implements holdView");
  const ctx = (access: Record<string, "read" | "read_update">) => testCtx({ db, agent: ME, ws: WS, keys: { COMPOSIO_API_KEY: KEY }, access });
  const executed = () => upstream.calls.filter((c) => c.url.pathname.includes("/tools/execute/")).map((c) => ({ slug: c.url.pathname.split("/").pop(), body: c.body as Record<string, any> }));
  return { db, app, dyn, state, ctx, executed, work, priv, slack };
}

test("GMAIL_SEND_DRAFT (first contact): the hold shows recipients, subject, plain text and attachment names read from the draft with the call's account", async () => {
  const s = setup();
  s.state.draft = rawDraft({ to: "Bob <bob@x.example>, carol@x.example", cc: "dan@x.example", subject: "Invoice Q3", plain: "Hello Bob,\nthe invoice is attached.", html: "<p>Hello <b>Bob</b></p>", attachments: [{ filename: "invoice.pdf", size: 123_456 }] });
  // two Gmail accounts: the agent names the Work inbox, exactly like the call would
  const me = s.ctx({ [s.work.id]: "read_update", [s.priv.id]: "read_update" });
  const out = await s.dyn.holdView("gmail_send_draft__first_contact", { draft_id: "r-1", connect_account: "Work inbox" }, me);
  assert.ok(out);
  assert.equal(
    out.view,
    [
      "Send draft (gmail), first contact",
      "Account: Work inbox",
      "To: bob@x.example, carol@x.example",
      "Cc: dan@x.example",
      "Subject: Invoice Q3",
      "Attachments (names only): invoice.pdf (121 KB)",
      "Draft: r-1 (content read from the mailbox now; a later change to the draft needs a new approval)",
      "",
      "Text (plain text):",
      "Hello Bob,\nthe invoice is attached.",
    ].join("\n"),
  );
  assert.ok((out.summary ?? "").length <= 280);
  assert.match(out.summary ?? "", /"Invoice Q3" to bob@x\.example \(\+2\)/u);
  const ex = s.executed();
  assert.deepEqual(ex.map((e) => e.slug), ["GMAIL_GET_DRAFT"], "read only: the draft is never sent by the hold view");
  assert.equal(ex[0]?.body.connected_account_id, "ca_work");
  assert.equal(ex[0]?.body.user_id, WS);
  assert.deepEqual(ex[0]?.body.arguments, { user_id: "me", draft_id: "r-1", format: "full" });
  // the same account rules as the call: two usable accounts and no selector → refused (the SDK shows "could not read")
  await assert.rejects(s.dyn.holdView("gmail_send_draft__first_contact", { draft_id: "r-1" }, me), (e: ConnectError) => e.code === "account_ambiguous");
});

test("A→B: the agent edits the draft after the hold → a different view (the SDK binds the approval to its sha256)", async () => {
  const s = setup();
  const me = s.ctx({ [s.work.id]: "read_update" });
  s.state.draft = rawDraft({ to: "bob@x.example", subject: "Lunch", plain: "A: see you at noon" });
  const a = await s.dyn.holdView("gmail_send_draft__first_contact", { draft_id: "r-1" }, me);
  s.state.draft = rawDraft({ to: "attacker@evil.example", subject: "Lunch", plain: "B: here are the passwords" });
  const b = await s.dyn.holdView("gmail_send_draft__first_contact", { draft_id: "r-1" }, me);
  assert.notEqual(a?.view, b?.view);
  assert.match(b?.view ?? "", /To: attacker@evil\.example/u);
  assert.match(b?.view ?? "", /B: here are the passwords/u);
  // same content → the same text (deterministic, so an unchanged draft keeps its approval)
  const b2 = await s.dyn.holdView("gmail_send_draft__first_contact", { draft_id: "r-1" }, me);
  assert.equal(b2?.view, b?.view);
});

test("HTML-only draft: tags, scripts and styles stripped, entities decoded; first 500 characters only; invisible characters removed", async () => {
  const s = setup();
  const me = s.ctx({ [s.work.id]: "read_update" });
  const long = "word ".repeat(300);
  s.state.draft = rawDraft({
    to: "bob@x.example",
    subject: `Pay${String.fromCodePoint(0x202e)}gnp.exe now`,
    plain: null,
    html: `<html><head><style>p{color:red}</style><title>t</title></head><body><p>Pay&nbsp;now &amp; <a href="https://evil.example/x">click here</a></p><script>alert(1)</script><img src=x onerror=alert(2)><p>${long}</p></body></html>`,
  });
  const out = await s.dyn.holdView("gmail_send_draft__first_contact", { draft_id: "r-1" }, me);
  const view = out?.view ?? "";
  assert.doesNotMatch(view, /<|alert|href|onerror|color:red/u);
  assert.match(view, /Pay now & click here/u);
  assert.match(view, /Subject: Paygnp\.exe now/u, "bidi override removed");
  const total = [...plainText(`<p>Pay&nbsp;now &amp; <a>click here</a></p><p>${long}</p>`, true)].length;
  assert.match(view, new RegExp(`Text \\(plain text, first ${PREVIEW_CHARS} characters; ${total - PREVIEW_CHARS} more not shown\\):`, "u"));
  const text = view.split("not shown):\n")[1] ?? "";
  assert.equal([...text].length, PREVIEW_CHARS);
});

test("the draft cannot be read → holdView throws (the SDK keeps the hold and shows 'could not read'); no send", async () => {
  const s = setup();
  const me = s.ctx({ [s.work.id]: "read_update" });
  s.state.draftOk = false;
  await assert.rejects(s.dyn.holdView("gmail_send_draft__first_contact", { draft_id: "gone" }, me));
  s.state.draftOk = true;
  s.state.draft = { nothing: true };
  await assert.rejects(s.dyn.holdView("gmail_send_draft__first_contact", { draft_id: "r-1" }, me), (e: ConnectError) => e.code === "hold_view_unreadable");
  assert.ok(!s.executed().some((e) => e.slug === "GMAIL_SEND_DRAFT"));
});

test("GMAIL_SEND_EMAIL: shown from the arguments (no upstream read); HTML body stripped; attachments by name only", async () => {
  const s = setup();
  const me = s.ctx({ [s.work.id]: "read_update" });
  const out = await s.dyn.holdView(
    "gmail_send_email",
    { recipient_email: "Friend <friend@x.example>", cc: ["c1@x.example"], bcc: "b1@x.example", subject: "Report", body: "<p>See <b>attached</b></p>", is_html: true, attachment: { name: "report.xlsx", mimetype: "application/vnd.ms-excel", s3key: "k/1" } },
    me,
  );
  assert.equal(
    out?.view,
    ["Send email (gmail)", "Account: Work inbox", "To: friend@x.example", "Cc: c1@x.example", "Bcc: b1@x.example", "Subject: Report", "Attachments (names only): report.xlsx (size unknown)", "", "Text (plain text):", "See attached"].join("\n"),
  );
  assert.deepEqual(s.executed(), []);
});

test("Slack post (Composio): the channel and the text; Gmail forward reads the forwarded message", async () => {
  const s = setup();
  const me = s.ctx({ [s.work.id]: "read_update", [s.slack.id]: "read_update" });
  const slack = await s.dyn.holdView("slack_sends_a_message_to_a_slack_channel", { channel: "#general", markdown_text: "Release is *out*" }, me);
  assert.match(slack?.view ?? "", /^Send message \(slack\)\nAccount: Team Slack\nChannel: #general\n\nText \(plain text\):\nRelease is \*out\*$/u);
  s.state.message = { messageId: "m-9", subject: "Contract", to: "me@work.example", messageText: "Signed contract text", attachmentList: [{ filename: "contract.pdf", mimeType: "application/pdf" }] };
  const fwd = await s.dyn.holdView("gmail_forward_message", { message_id: "m-9", recipient_email: "lawyer@x.example", additional_text: "FYI" }, me);
  const v = fwd?.view ?? "";
  assert.match(v, /To: lawyer@x\.example/u);
  assert.match(v, /Subject: Contract/u);
  assert.match(v, /Attachments \(names only\): contract\.pdf \(size unknown\)/u);
  assert.match(v, /FYI\n\n---------- Forwarded message ----------\nSigned contract text/u);
  assert.doesNotMatch(v, /me@work\.example/u, "the forwarded message's own To is not the recipient");
  assert.deepEqual(s.executed().map((e) => e.slug), ["GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"]);
});

test("C368: non-send tools get a readable card of labelled lines (no raw JSON); an unknown tool keeps the SDK default (null); the Composio key never appears in a view", async () => {
  const s = setup();
  const me = s.ctx({ [s.work.id]: "read_update" });
  const del = await s.dyn.holdView("gmail_delete_message", { message_id: "m1" }, me);
  assert.match(del?.view ?? "", /^GMAIL_DELETE_MESSAGE \(gmail\)\nAccount: .*\n\nMessage id: m1$/u);
  assert.doesNotMatch(del?.view ?? "", /[{}"]/u, "no JSON on the card");
  assert.match((await s.dyn.holdView("gmail_fetch_emails", {}, me))?.view ?? "", /No arguments\.$/u);
  assert.equal(await s.dyn.holdView("nope", {}, me), null);
  s.state.draft = rawDraft({ to: "bob@x.example", subject: `key ${KEY}`, plain: `the key is ${KEY}` });
  const out = await s.dyn.holdView("gmail_send_draft__first_contact", { draft_id: "r-1" }, me);
  assert.ok(!(out?.view ?? "").includes(KEY));
  assert.ok(!(out?.summary ?? "").includes(KEY));
  assert.match(out?.view ?? "", /the key is \[redacted\]/u);
});

test("pure helpers: Composio processed form, sizes, many recipients bounded", () => {
  const m = mailFromGmail({ response_data: { subject: "Hi", to: "a@x.example, b@x.example", messageText: "<div>Body</div>" } });
  assert.deepEqual([m?.to, m?.subject, m?.text], [["a@x.example", "b@x.example"], "Hi", "Body"]);
  assert.equal(mailFromGmail({ unrelated: 1 }), null);
  assert.deepEqual([formatSize(512), formatSize(2048), formatSize(3 * 1024 * 1024), formatSize(null)], ["512 B", "2 KB", "3.0 MB", "size unknown"]);
  const many = Array.from({ length: 200 }, (_, i) => `person${i}@x.example`);
  const view = renderHoldView({ heading: "Send", account: "A", mail: mailFromArgs({ to: many, body: "x" }) });
  const toLine = view.split("\n").find((l) => l.startsWith("To: ")) ?? "";
  assert.ok(toLine.length <= 1100, `${toLine.length}`);
  assert.match(toLine, /\(and \d+ more\)$/u);
  assert.ok(view.length < 16_000);
});
