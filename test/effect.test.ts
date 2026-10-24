import assert from "node:assert/strict";
import { test } from "node:test";

import { ACCESS_CRUD, classify, classifyMcpTool, inferFromName, isSendTool, levelAllows, levelFor, mcpReadClaimUnverified, readsMoneyRecords, recipientsOf } from "../src/effect.ts";
import { classifyComposioTool, loadPolicies } from "../src/sources/composio/policy.ts";

test("classify obeys M-OP-2/3/4", () => {
  assert.deepEqual(classify({ write: false, outward: false, destructive: false }), { crud: ["read"], effect: "read" });
  assert.deepEqual(classify({ write: true, outward: false, destructive: false }), { crud: ["create", "update"], effect: "write" });
  assert.deepEqual(classify({ write: true, outward: true, destructive: false }), { crud: ["create", "update"], effect: "outward", holdFamily: "outward" });
  assert.deepEqual(classify({ write: true, outward: true, destructive: true }), { crud: ["update", "delete"], effect: "destructive", holdFamily: "destructive" });
  assert.deepEqual(classify({ write: true, outward: false, destructive: false, money: true }).holdFamily, "money");
});

test("access levels map to the frozen tier CRUD sets (CORE §13)", () => {
  assert.deepEqual(ACCESS_CRUD.read, ["read"]);
  assert.deepEqual(ACCESS_CRUD.read_update, ["read", "create", "update"]);
  assert.deepEqual(ACCESS_CRUD.read_update_delete, ["read", "create", "update", "delete"]);
  assert.equal(levelFor(["read"]), "read");
  assert.equal(levelFor(["create", "update"]), "read_update");
  assert.equal(levelFor(["update", "delete"]), "read_update_delete");
  assert.equal(levelAllows("read", ["create"]), false);
  assert.equal(levelAllows("read_update", ["create", "update"]), true);
  assert.equal(levelAllows("read_update", ["delete"]), false);
});

test("name inference is conservative", () => {
  assert.equal(inferFromName("SLACK_SEND_MESSAGE").effect, "outward");
  assert.equal(inferFromName("NOTION_DELETE_PAGE").effect, "destructive");
  assert.equal(inferFromName("NOTION_UPDATE_PAGE").effect, "write");
  assert.equal(inferFromName("NOTION_GET_PAGE").effect, "read");
});

test("MCP annotations only raise the class (X-03): readOnlyHint never lowers a write", () => {
  assert.equal(classifyMcpTool("delete_everything", { readOnlyHint: true }).effect, "destructive");
  assert.equal(classifyMcpTool("send_email", { readOnlyHint: true }).effect, "outward");
  assert.equal(classifyMcpTool("get_issue", { readOnlyHint: true }).effect, "read", "a hint that agrees with the name stays read");
  assert.equal(classifyMcpTool("lookup", { destructiveHint: true }).effect, "destructive");
  assert.equal(classifyMcpTool("lookup", { readOnlyHint: false, openWorldHint: true }).effect, "outward");
});

test("Gmail policy: send outward, delete destructive, label removal is a write, fetch is read", () => {
  const gmail = loadPolicies().get("gmail");
  assert.ok(gmail);
  assert.equal(classifyComposioTool("GMAIL_SEND_EMAIL", gmail).effect, "outward");
  assert.equal(classifyComposioTool("GMAIL_REPLY_TO_THREAD", gmail).effect, "outward");
  assert.equal(classifyComposioTool("GMAIL_CREATE_EMAIL_DRAFT", gmail).effect, "write");
  assert.equal(classifyComposioTool("GMAIL_REMOVE_LABEL", gmail).effect, "write");
  assert.equal(classifyComposioTool("GMAIL_DELETE_MESSAGE", gmail).effect, "destructive");
  assert.equal(classifyComposioTool("GMAIL_MOVE_TO_TRASH", gmail).effect, "destructive");
  assert.equal(classifyComposioTool("GMAIL_FETCH_EMAILS", gmail).effect, "read");
  assert.equal(classifyComposioTool("GMAIL_LIST_THREADS", gmail).effect, "read");
});

test("SEC-02: unknown verbs fail closed; money is always money; read only for read verbs", () => {
  const cases: [string, string][] = [
    ["GITHUB_MERGE_PULL_REQUEST", "outward"],
    ["JIRA_CLOSE_ISSUE", "outward"],
    ["SLACK_APPROVE_WORKFLOW_REQUEST", "outward"],
    ["LINEAR_ARCHIVE_PROJECT", "write"],
    ["ACME_FROBNICATE_WIDGET", "outward"],
    ["NOTION_RENAME_PAGE", "write"],
    ["STRIPE_CREATE_REFUND", "money"],
    ["PAYPAL_SEND_PAYMENT", "money"],
    ["BANK_TRANSFER_FUNDS", "money"],
    ["SHOP_CHECKOUT_CART", "money"],
    ["GITHUB_LIST_REPOSITORIES", "read"],
    ["NOTION_GET_PAGE", "read"],
    ["GITHUB_GET_AND_MERGE", "outward"],
  ];
  for (const [name, effect] of cases) assert.equal(inferFromName(name).effect, effect, name);
  const money = inferFromName("STRIPE_CREATE_REFUND");
  assert.equal(money.holdFamily, "money");
  assert.deepEqual(levelFor(money.crud), "read_update_delete");
  // READ tier never covers a fail-closed unknown tool.
  assert.equal(levelAllows("read", inferFromName("ACME_FROBNICATE_WIDGET").crud), false);
});

test("SEC-02: Composio without a policy fails closed; a policy never downgrades money; MCP money ignores readOnlyHint", () => {
  assert.equal(classifyComposioTool("TRELLO_CLOSE_BOARD", undefined).effect, "outward");
  assert.equal(classifyComposioTool("GMAIL_PAY_INVOICE", loadPolicies().get("gmail")).effect, "money");
  assert.equal(classifyMcpTool("charge_card", { readOnlyHint: true }).effect, "money");
  assert.equal(classifyMcpTool("frobnicate", undefined).effect, "outward");
  assert.equal(classifyMcpTool("frobnicate", { readOnlyHint: true }).effect, "outward", "X-03: an unverified read claim stays fail-closed");
  assert.equal(classifyMcpTool("frobnicate", { readOnlyHint: true }, true).effect, "read", "X-03: the owner confirmed it as read");
});

test("C107: every outward or money class carries a hold family (resolve answers never lack one)", () => {
  const names = ["GMAIL_SEND_EMAIL", "SLACK_SEND_MESSAGE", "GITHUB_MERGE_PULL_REQUEST", "ACME_FROBNICATE_WIDGET", "STRIPE_CREATE_REFUND", "NOTION_DELETE_PAGE", "NOTION_UPDATE_PAGE", "NOTION_GET_PAGE"];
  for (const name of names) {
    const cls = inferFromName(name);
    if (cls.effect === "outward") assert.equal(cls.holdFamily, "outward", name);
    if (cls.effect === "money") assert.equal(cls.holdFamily, "money", name);
    if (cls.effect === "read" || cls.effect === "write") assert.equal(cls.holdFamily, undefined, name);
  }
  assert.equal(classifyMcpTool("lookup", { readOnlyHint: false, openWorldHint: true }).holdFamily, "outward");
  assert.equal(classifyMcpTool("send_invoice_payment", undefined).holdFamily, "money");
});

test("F84: read-led names stay reads (drafts, labels, send-as); real verbs and sends still win", () => {
  const gmail = loadPolicies().get("gmail");
  assert.ok(gmail);
  for (const slug of ["GMAIL_LIST_LABELS", "GMAIL_LIST_DRAFTS", "GMAIL_GET_DRAFT", "GMAIL_GET_LABEL", "GMAIL_LIST_SEND_AS", "GMAIL_GET_SEND_AS", "GMAIL_GET_PROFILE", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "GMAIL_LIST_HISTORY", "GMAIL_SEARCH_PEOPLE"]) {
    const cls = classifyComposioTool(slug, gmail);
    assert.equal(cls.effect, "read", slug);
    assert.deepEqual(cls.crud, ["read"], slug);
    assert.equal(levelAllows("read", cls.crud), true, `READ tier can call ${slug}`);
  }
  for (const [slug, effect] of [
    ["GMAIL_CREATE_EMAIL_DRAFT", "write"], ["GMAIL_UPDATE_DRAFT", "write"], ["GMAIL_CREATE_LABEL", "write"], ["GMAIL_REMOVE_LABEL", "write"],
    ["GMAIL_SEND_DRAFT", "outward"], ["GMAIL_SEND_EMAIL", "outward"], ["GMAIL_GET_AND_SEND", "outward"], ["GMAIL_DELETE_DRAFT", "destructive"],
    ["GMAIL_DELETE_LABEL", "destructive"], ["GMAIL_MOVE_TO_TRASH", "destructive"],
  ] as const) assert.equal(classifyComposioTool(slug, gmail).effect, effect, slug);
  // The same name rule without a policy (catalog, MCP): a noun word after a leading read verb is not a verb.
  for (const name of ["list_drafts", "get_draft", "list_labels", "get_message", "fetch_email", "get_comment"]) assert.equal(inferFromName(name).effect, "read", name);
  for (const [name, effect] of [["create_draft", "write"], ["send_message", "outward"], ["get_and_send_message", "outward"], ["get_and_delete_draft", "destructive"], ["post_comment", "outward"]] as const)
    assert.equal(inferFromName(name).effect, effect, name);
});

test("F84: every curated toolkit policy classifies read-led list/get/fetch/search names as read", () => {
  const policies = loadPolicies();
  assert.ok(policies.size >= 2);
  const nouns = ["DRAFT", "DRAFTS", "LABEL", "LABELS", "MESSAGE", "MESSAGES", "EVENTS", "SETTINGS", "ACL", "CALENDARS", "PROFILE", "THREADS"];
  for (const [toolkit, policy] of policies) {
    const prefix = toolkit.toUpperCase();
    for (const verb of ["GET", "LIST", "FETCH", "SEARCH", "FIND"]) {
      for (const noun of nouns) assert.equal(classifyComposioTool(`${prefix}_${verb}_${noun}`, policy).effect, "read", `${prefix}_${verb}_${noun}`);
    }
  }
});

test("F84: Google Calendar policy: list/get reads (ACL, settings) stay reads; event writes and attendee changes keep their class", () => {
  const cal = loadPolicies().get("googlecalendar");
  assert.ok(cal);
  for (const slug of ["GOOGLECALENDAR_LIST_CALENDARS", "GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_ACL_LIST", "GOOGLECALENDAR_ACL_GET", "GOOGLECALENDAR_SETTINGS_GET", "GOOGLECALENDAR_SETTINGS_LIST", "GOOGLECALENDAR_FIND_FREE_SLOTS", "GOOGLECALENDAR_GET_CALENDAR"])
    assert.equal(classifyComposioTool(slug, cal).effect, "read", slug);
  for (const [slug, effect] of [
    ["GOOGLECALENDAR_CREATE_EVENT", "outward"], ["GOOGLECALENDAR_REMOVE_ATTENDEE", "outward"], ["GOOGLECALENDAR_ACL_INSERT", "outward"],
    ["GOOGLECALENDAR_DELETE_EVENT", "destructive"], ["GOOGLECALENDAR_BATCH_EVENTS", "destructive"], ["GOOGLECALENDAR_SETTINGS_WATCH", "outward"],
  ] as const) assert.equal(classifyComposioTool(slug, cal).effect, effect, slug);
});

// ── security sprint 1 ──

test("CON-02 fires: money and destructive names in camelCase, PascalCase, kebab and joined words keep their class", () => {
  const money = ["createPayment", "refundCharge", "transferFunds", "createPaymentIntent", "CreateRefund", "stripe-create-refund", "issuePayout", "PAYMENTINTENT_CREATE", "capturePaymentIntent"];
  for (const name of money) {
    assert.equal(inferFromName(name).effect, "money", name);
    assert.equal(classifyMcpTool(name, { readOnlyHint: true }).holdFamily, "money", name);
  }
  const destructive = ["deleteRepository", "dropTable", "purgeQueue", "DeleteAllRecords", "delete-branch", "truncateTable", "deleteall"];
  for (const name of destructive) assert.equal(inferFromName(name).holdFamily, "destructive", name);
});

test("CON-02 fires on real Composio slugs from the catalog (composio search, 2026-10-14)", () => {
  for (const slug of ["STRIPE_CREATE_REFUND", "STRIPE_CREATE_CHARGE_REFUND", "STRIPE_CREATE_TRANSFER", "STRIPE_CREATE_PAYMENT_LINK", "STRIPE_CREATE_CHECKOUT_SESSION", "QUICKBOOKS_CREATE_PAYMENT", "QUICKBOOKS_CREATE_ECHECK_PAYMENT"]) {
    assert.equal(classifyComposioTool(slug, undefined).effect, "money", slug);
  }
  assert.equal(classifyComposioTool("GITHUB_DELETE_A_REPOSITORY", undefined).effect, "destructive");
  const gmail = loadPolicies().get("gmail");
  for (const slug of ["GMAIL_SEND_EMAIL", "GMAIL_REPLY_TO_THREAD", "GMAIL_FORWARD_MESSAGE", "GMAIL_SEND_DRAFT"]) assert.equal(classifyComposioTool(slug, gmail).effect, "outward", slug);
});

test("CON-02 stays quiet: reads and lookalike words are not money or destructive", () => {
  const reads = ["getRepository", "listIssues", "searchMessages", "getDisplaySettings", "fetchTooltip", "GITHUB_GET_A_REPOSITORY", "GITHUB_FIND_REPOSITORIES", "STRIPE_RETRIEVE_BALANCE", "listDeletedItems", "get_payload"];
  for (const name of reads) assert.equal(inferFromName(name).effect, "read", name);
  assert.equal(inferFromName("updateDropboxFile").effect, "write", "dropbox is not drop");
  assert.equal(classifyComposioTool("GMAIL_FETCH_EMAILS", loadPolicies().get("gmail")).effect, "read");
});

test("X-03: only an unverified read claim is offered to the owner; agreeing or money claims are not", () => {
  assert.equal(mcpReadClaimUnverified("send_email", { readOnlyHint: true }), true);
  assert.equal(mcpReadClaimUnverified("get_issue", { readOnlyHint: true }), false, "the name already says read");
  assert.equal(mcpReadClaimUnverified("send_email", undefined), false, "no claim");
  assert.equal(mcpReadClaimUnverified("createPayment", { readOnlyHint: true }), false, "money can never be confirmed read");
  assert.equal(classifyMcpTool("createPayment", { readOnlyHint: true }, true).effect, "money", "an owner read mark never lowers money");
});

test("X-02: send tools and their recipients (real Composio argument names)", () => {
  assert.equal(isSendTool({ name: "gmail_send_email", upstream: "GMAIL_SEND_EMAIL", effect: "outward" }), true);
  assert.equal(isSendTool({ name: "gmail_forward_message", upstream: "GMAIL_FORWARD_MESSAGE", effect: "outward" }), true);
  assert.equal(isSendTool({ name: "slack_sends_a_message", upstream: "SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL", effect: "outward" }), true);
  assert.equal(isSendTool({ name: "sendMessage", effect: "outward" }), true, "camelCase MCP send");
  // quiet: outward tools that reach no person, and reads/writes
  assert.equal(isSendTool({ name: "github_merge_pull_request", upstream: "GITHUB_MERGE_PULL_REQUEST", effect: "outward" }), false);
  assert.equal(isSendTool({ name: "gmail_create_email_draft", upstream: "GMAIL_CREATE_EMAIL_DRAFT", effect: "write" }), false);
  assert.equal(isSendTool({ name: "gmail_list_send_as", upstream: "GMAIL_LIST_SEND_AS", effect: "read" }), false);

  assert.deepEqual(recipientsOf({ recipient_email: "Bob <BOB@x.example>", cc: ["c@x.example"], bcc: [], extra_recipients: ["d@x.example, e@x.example"], user_id: "me", subject: "hi" }), [
    "bob@x.example",
    "c@x.example",
    "d@x.example",
    "e@x.example",
  ]);
  assert.deepEqual(recipientsOf({ message_id: "m1", recipients: ["x@evil.example"], additional_text: "fyi" }), ["x@evil.example"], "GMAIL_FORWARD_MESSAGE");
  assert.deepEqual(recipientsOf({ to: "o@x.example", cc_emails: ["p@x.example"], bcc_emails: ["q@x.example"] }), ["o@x.example", "p@x.example", "q@x.example"], "OUTLOOK_SEND_EMAIL");
  assert.deepEqual(recipientsOf({ toRecipients: [{ emailAddress: { address: "g@x.example" } }] }), ["g@x.example"], "Graph style");
  assert.deepEqual(recipientsOf({ draft_id: "r1", user_id: "me" }), [], "GMAIL_SEND_DRAFT names no recipient");
});

test("C331 D4b: only a pure read of money records may be confirmed; an owner confirmation is the only way to read", () => {
  for (const name of ["stripe_list_charges", "list_charges", "listCharges", "get_refund", "stripe_get_charge", "export_payments", "get_payouts_count", "search_transfers"]) {
    assert.equal(readsMoneyRecords(name), true, name);
    assert.equal(mcpReadClaimUnverified(name, { readOnlyHint: true }), true, name);
    assert.equal(classifyMcpTool(name, { readOnlyHint: true }).effect, "money", `${name}: never automatic`);
    assert.equal(classifyMcpTool(name, { readOnlyHint: true }, true).effect, "read", `${name}: owner confirmed`);
  }
  for (const name of [
    "list_and_refund_charges", "list_charges_then_capture", "listChargesAndPay", "list_charges_refund", "refund_list_charges", "stripe_charge_list",
    "list_refunds_for_charge", "get_charge_status", "list_paymentintents", "create_charge", "charge_customer", "list_pay", "pay_list",
    "list_charges_delete", "list_charges_to_customer", "list_charg\u0435s",
    // QA-CONNECT22-2: the tail and the prefix are allow-lists
    "list_payouts_initiate", "get_charges_retry", "list_charges_v2", "initiate_list_charges", "acme_list_charges", "stripe_acme_list_charges",
  ]) {
    assert.equal(readsMoneyRecords(name), false, name);
    assert.equal(mcpReadClaimUnverified(name, { readOnlyHint: true }), false, name);
  }
  for (const name of ["create_charge", "list_and_refund_charges", "pay_list"]) assert.equal(classifyMcpTool(name, { readOnlyHint: true }, true).effect, "money", `${name}: a stale owner row never lowers it`);
  // spoofed hints: no claim, or read-only together with destructive
  assert.equal(mcpReadClaimUnverified("list_charges", undefined), false);
  assert.equal(mcpReadClaimUnverified("list_charges", { readOnlyHint: true, destructiveHint: true }), false);
});

test("QA-CONNECT22-1 (C340): a name that is not plain ASCII is money, whatever it claims or the owner confirmed", () => {
  for (const name of ["list_charg\u0435s", "d\u0435lete_all_customers", "list\u200b_notes", "search_notes\u200d", "\uff4c\uff49\uff53\uff54_notes"]) {
    assert.equal(classifyMcpTool(name, { readOnlyHint: true }).effect, "money", JSON.stringify(name));
    assert.equal(classifyMcpTool(name, { readOnlyHint: true }, true).effect, "money", `${JSON.stringify(name)}: an owner row never lowers it`);
    assert.equal(mcpReadClaimUnverified(name, { readOnlyHint: true }), false, JSON.stringify(name));
  }
  assert.equal(classifyMcpTool("search_notes", { readOnlyHint: true }).effect, "read", "a plain read name is unchanged");
});
