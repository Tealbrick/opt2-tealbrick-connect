/** IN-2: buttons on a companion app's DM (Operator Inbox Approve / Deny), click relay, Slack and Telegram shapes. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Json } from "@opt2-tealbrick/spec/sdk";
import { AccountStore } from "../src/accounts.ts";
import { ACTION_CALLBACKS, actionRelay, type ConnectError, createConnectApp } from "../src/app.ts";
import type { ActionSink, ChannelNet, ChannelProvider, InboundAction, MessageAction } from "../src/channels/provider.ts";
import { actionBlocks, parseSlackAction, SLACK_APP_MANIFEST, slackProvider } from "../src/channels/providers/slack.ts";
import { parseTelegramCallback, telegramProvider } from "../src/channels/providers/telegram.ts";
import { ACTION_BUSY_MS, ChannelHub, type RelayOutcome } from "../src/channels/service.ts";
import { eventCtx, handlerOf, root, secretsFor, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const AGENT = "agt_01ACTIONAGENT0000000000000";
const INBOX_APP = "ins_01INBOXAPP000000000000000000";
const VALUE_A = `ib1.${"a".repeat(16)}.a.${"m".repeat(22)}`;
const VALUE_D = `ib1.${"a".repeat(16)}.d.${"n".repeat(22)}`;
const BUTTONS: MessageAction[] = [
  { label: "Approve", value: VALUE_A, style: "primary" },
  { label: "Deny", value: VALUE_D, style: "danger" },
];
const isCode = (code: string) => (e: ConnectError) => e.code === code;

function fakeWorld(withActions = true) {
  const sent: { conversation: string; text: string; actions?: readonly MessageAction[] }[] = [];
  const answers: { notice: string; final: boolean; clickerId: string; text: string }[] = [];
  let actionSink: ActionSink | undefined;
  let now = 1_760_000_000_000;
  const provider: ChannelProvider = {
    service: "slack",
    credentialFields: ["bot_token"],
    maxTextLength: 4000,
    verify: async () => ({ botId: "U0BOT", botName: "bot", workspace: "T0TEAM" }),
    conversations: async () => [],
    send: async (_c, _n, input) => {
      sent.push(input);
      return { messageId: `m${sent.length}` };
    },
    edit: async () => undefined,
    delete: async () => undefined,
    react: async () => undefined,
    openDirect: async (_c, _n, input) => ({ conversation: `D-${input.personId}` }),
    ...(withActions ? { actionDone: async (_c, _n, input) => void answers.push({ notice: input.notice, final: input.final, clickerId: input.clickerId, text: input.text }) } : {}),
    inbound: {
      kind: "poll",
      run: async (_c, _n, _b, _s, signal, actions) => {
        actionSink = actions;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    },
  };
  const net: ChannelNet = {
    fetch: (() => Promise.reject(new Error("no network"))) as typeof fetch,
    webSocket: () => {
      throw new Error("no ws");
    },
    now: () => now,
    sleep: async () => undefined,
  };
  return { provider, net, sent, answers, sink: () => actionSink, tick: (ms: number) => {
      now += ms;
    }, now: () => now };
}

async function hub(withActions = true) {
  const w = fakeWorld(withActions);
  const db = testDb();
  const accounts = new AccountStore(db);
  const h = new ChannelHub({ db, accounts, secrets: secretsFor(db), providers: new Map([["slack", w.provider]]), net: w.net });
  const account = await h.connect({ service: "slack", label: "Sender", agent: AGENT, credentials: { bot_token: "xoxb-x" } });
  const relayed: { product: string; input: unknown; key: string }[] = [];
  let outcome: RelayOutcome | Error = { final: true, notice: "Approved by you at 10:00 UTC." };
  h.setActionRelay(async (product, input, key) => {
    relayed.push({ product, input, key });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const dm = () =>
    h.directMessage(account, INBOX_APP, {
      person: "U0OWNER",
      text: "Scout asks for your approval: Post?",
      first: true,
      origin: { product: "inbox", instance: INBOX_APP, requestedAccount: "slack", actions: BUTTONS, expiresAt: w.now() + 3600_000 },
    });
  const click = (over: Partial<InboundAction> = {}) =>
    h.action(account, { conversation: "D-U0OWNER", messageId: "m1", clickerId: "U0OWNER", value: VALUE_A, ackId: null, text: "Scout asks for your approval: Post?", ...over });
  return { w, db, h, account, relayed, dm, click, setOutcome: (o: RelayOutcome | Error) => {
      outcome = o;
    },
  };
}

test("hub: a DM with buttons is shown and recorded (value hashes only); a click is relayed once and closes the message", async () => {
  const t = await hub();
  const out = await t.dm();
  assert.deepEqual(out, { messageId: "m1", conversation: "D-U0OWNER", actions: "shown" });
  assert.deepEqual(t.w.sent[0]?.actions, BUTTONS);
  const row = t.db.prepare("SELECT * FROM connect_channel_actions").get() as Record<string, unknown>;
  assert.equal(row.state, "open");
  assert.equal(row.requested_account, "slack");
  assert.doesNotMatch(String(row.value_hashes), /ib1\./u, "no raw value stored");

  await t.click();
  assert.equal(t.relayed.length, 1);
  assert.deepEqual(t.relayed[0]?.input, { token: VALUE_A, clicker: { service: "slack", id: "U0OWNER" }, account: "slack" });
  assert.match(String(t.relayed[0]?.key), /^dm-act-cna_[A-Z0-9]+-m1-/u);
  assert.deepEqual(t.w.answers.at(-1), { notice: "Approved by you at 10:00 UTC.", final: true, clickerId: "U0OWNER", text: "Scout asks for your approval: Post?" });

  // replay: the same button, the other button → no second relay, the clicker hears it was decided
  await t.click();
  await t.click({ value: VALUE_D });
  assert.equal(t.relayed.length, 1);
  assert.deepEqual(t.w.answers.at(-1), { notice: "Approved by you at 10:00 UTC.", final: false, clickerId: "U0OWNER", text: "Scout asks for your approval: Post?" });
});

test("hub: a forged value, an unknown message, another conversation are never relayed", async () => {
  const t = await hub();
  await t.dm();
  await t.click({ value: `ib1.${"b".repeat(16)}.a.${"m".repeat(22)}` });
  await t.click({ messageId: "m999" });
  await t.click({ conversation: "D-SOMEONE" });
  assert.equal(t.relayed.length, 0);
  assert.ok(t.w.answers.every((a) => !a.final && a.notice === "This button does not work here."));
});

test("hub: wrong person (app refuses, not final) keeps the buttons; the owner can still decide", async () => {
  const t = await hub();
  await t.dm();
  t.setOutcome({ final: false, notice: "Only the person this alert went to can decide here." });
  await t.click({ clickerId: "U0OTHER" });
  assert.equal(t.w.answers.at(-1)?.final, false);
  assert.equal((t.db.prepare("SELECT state FROM connect_channel_actions").get() as { state: string }).state, "open");
  t.setOutcome({ final: true, notice: "Denied by you at 10:01 UTC." });
  await t.click({ value: VALUE_D });
  assert.equal(t.relayed.length, 2);
  assert.equal(t.w.answers.at(-1)?.final, true);
});

test("hub: expired buttons end without a relay; a lost relay (busy) frees after the busy window; a relay error is not final", async () => {
  const t = await hub();
  await t.dm();
  t.setOutcome(new Error("boom"));
  await t.click();
  assert.deepEqual([t.w.answers.at(-1)?.final, t.w.answers.at(-1)?.notice], [false, "Could not decide now. Try again, or open Operator Inbox."]);
  // a click while another is busy
  t.db.prepare("UPDATE connect_channel_actions SET state = 'busy', updated_at = ?").run(t.w.now());
  await t.click();
  assert.equal(t.w.answers.at(-1)?.notice, "This is being handled.");
  t.w.tick(ACTION_BUSY_MS + 1);
  t.setOutcome({ final: true, notice: "Approved by you at 10:03 UTC." });
  await t.click();
  assert.equal(t.w.answers.at(-1)?.final, true);

  const e = await hub();
  await e.dm();
  e.w.tick(3600_001);
  await e.click();
  assert.equal(e.relayed.length, 0);
  assert.deepEqual([e.w.answers.at(-1)?.final, e.w.answers.at(-1)?.notice], [true, "This button expired. Open Operator Inbox to decide."]);
});

test("hub: a provider without actionDone (Teams, Discord) sends the text only and says unsupported", async () => {
  const t = await hub(false);
  const out = await t.dm();
  assert.equal(out.actions, "unsupported");
  assert.equal(t.w.sent[0]?.actions, undefined);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM connect_channel_actions").get()?.n, 0);
});

test("relay: only inbox → item_decide_dm; answers map to notices; final refusals end the buttons", async () => {
  assert.deepEqual(ACTION_CALLBACKS, { inbox: "item_decide_dm" });
  const calls: unknown[] = [];
  const ok = actionRelay(async (product, op, input, opts) => {
    calls.push([product, op, input, opts]);
    return { status: "ok", output: { response: "deny" } };
  }, () => Date.parse("2026-10-24T14:02:30Z"));
  assert.deepEqual(await ok("inbox", { token: VALUE_D, clicker: { service: "slack", id: "U0OWNER" }, account: "slack" }, "k1"), { final: true, notice: "Denied by you at 14:02 UTC." });
  assert.deepEqual(calls[0], ["inbox", "item_decide_dm", { token: VALUE_D, clicker: { service: "slack", id: "U0OWNER" }, account: "slack" }, { idempotencyKey: "k1" }]);
  assert.equal((await ok("creative", { token: "x", clicker: { service: "slack", id: "U" }, account: "slack" }, "k")).final, false, "no callback for other products");
  const refuse = (code: string, message = "Inbox says no.") =>
    actionRelay(async () => {
      throw Object.assign(new Error(message), { code });
    });
  const input = { token: VALUE_A, clicker: { service: "slack", id: "U0OWNER" }, account: "slack" };
  for (const code of ["token_used", "token_expired", "token_invalid", "token_locked", "already_decided", "item_expired", "stale_version", "buttons_off", "decide_in_inbox"])
    assert.deepEqual(await refuse(code)("inbox", input, "k"), { final: true, notice: "Inbox says no." }, code);
  assert.deepEqual(await refuse("wrong_person")("inbox", input, "k"), { final: false, notice: "Only the person this alert went to can decide here." });
  assert.deepEqual(await refuse("no_grant")("inbox", input, "k"), { final: false, notice: "Open Operator Inbox in the Portal to decide." });
  assert.equal((await refuse("internal")("inbox", input, "k")).final, false);
});

test("channel_dm / channel_dm_first: only a verified companion app may add buttons; inputs are checked", async () => {
  const w = fakeWorld();
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), channelProviders: new Map([["slack", w.provider]]), channelNet: w.net });
  await app.events?.agentAdded?.({ id: AGENT as `agt_${string}`, name: "A", mode: "free", status: "active" }, eventCtx(db));
  const person = testCtx({ db, person: true });
  const acc = (await handlerOf(app, "channel_account_connect")({ service: "slack", label: "S", agent: AGENT, credentials: { bot_token: "xoxb-a" } }, person)) as { account: { id: string } };
  await handlerOf(app, "sender_identity_set")({ channel: "slack", account: acc.account.id }, person);
  const run = (op: string, input: Record<string, unknown>, ctx = testCtx({ db, app: INBOX_APP, appProduct: "inbox" })) => handlerOf(app, op)(input as Json, ctx);
  const base = { account: "slack", person: "U0OWNER", text: "alert" };
  const actions = BUTTONS.map(({ label, value, style }) => ({ label, value, style }));
  await assert.rejects(run("channel_dm_first", { ...base, account: acc.account.id, actions }, testCtx({ db, agent: AGENT, access: { [acc.account.id]: "read_update" } })), isCode("actions_apps_only"));
  await assert.rejects(run("channel_dm_first", { ...base, actions }, testCtx({ db, app: INBOX_APP })), isCode("caller_unverified"));
  await assert.rejects(run("channel_dm_first", { ...base, actions: [] }), isCode("actions_invalid"));
  await assert.rejects(run("channel_dm_first", { ...base, actions: [{ label: "A", value: "has space" }] }), isCode("actions_invalid"));
  await assert.rejects(run("channel_dm_first", { ...base, actions: [actions[0], actions[0]] }), isCode("actions_invalid"));
  await assert.rejects(run("channel_dm_first", { ...base, actions, actionsUntil: "not a time" }), isCode("actions_invalid"));
  await assert.rejects(run("channel_dm_first", { ...base, actions, actionsUntil: "2099-01-01T00:00:00Z" }), isCode("actions_invalid"));
  // QA-CON23-2: buttons that expired while the send waited for approval → the text goes alone, with a note
  const late = (await run("channel_dm_first", { ...base, actions, actionsUntil: "2020-01-01T00:00:00Z" })) as { actions: string };
  assert.equal(late.actions, "expired");
  assert.equal(w.sent.at(-1)?.actions, undefined);
  assert.match(String(w.sent.at(-1)?.text), /buttons of this message expired/u);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connect_channel_actions").get()?.n, 0);
  const out = (await run("channel_dm_first", { ...base, actions })) as { actions: string };
  assert.equal(out.actions, "shown");
  const plain = (await run("channel_dm", base)) as Record<string, unknown>;
  assert.equal(plain.actions, undefined, "no buttons asked → no actions field");
  const row = db.prepare("SELECT product, instance FROM connect_channel_actions").get() as Record<string, unknown>;
  assert.deepEqual([row.product, row.instance], ["inbox", INBOX_APP]);
});

test("manifest: Connect is a companion of inbox for item_decide_dm only; channel_dm* accept actions", () => {
  assert.deepEqual(
    manifest.companions?.map((c) => [c.product, c.operations, c.crud]),
    [["inbox", ["item_decide_dm"], ["update"]]],
  );
  for (const id of ["channel_dm", "channel_dm_first"]) {
    const op = manifest.operations.find((o) => o.id === id) as unknown as { input: { properties: Record<string, { maxItems?: number }> } };
    assert.equal(op.input.properties.actions?.maxItems, 3, id);
    assert.ok(op.input.properties.actionsUntil, id);
  }
  assert.equal((SLACK_APP_MANIFEST.settings as { interactivity?: { is_enabled: boolean } }).interactivity?.is_enabled, true);
});

// ── Slack ──

const BOT = { botId: "U0BOTUSER1", botName: "tealbrick", workspace: "T0TESTTEAM" };
const slackClick = (over: Record<string, unknown> = {}) => ({
  type: "block_actions",
  team: { id: "T0TESTTEAM" },
  user: { id: "U0OWNER1" },
  channel: { id: "D0OWNERDM1" },
  container: { type: "message", message_ts: "1700000100.000200", channel_id: "D0OWNERDM1" },
  message: { ts: "1700000100.000200", text: "Scout asks &amp; waits" },
  actions: [{ action_id: "tb_act_0", block_id: "tb_actions", value: VALUE_A, action_ts: "1700000200.000300" }],
  ...over,
});

test("slack: buttons as Block Kit; block_actions parsed with team, user and action id checks", () => {
  const blocks = actionBlocks("hi &amp; you", BUTTONS) as { type: string; elements?: { action_id: string; value: string; style: string }[] }[];
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["section", "actions"],
  );
  assert.deepEqual(
    blocks[1]?.elements?.map((e) => [e.action_id, e.value, e.style]),
    [
      ["tb_act_0", VALUE_A, "primary"],
      ["tb_act_1", VALUE_D, "danger"],
    ],
  );
  const parsed = parseSlackAction(slackClick(), BOT);
  assert.deepEqual(parsed?.action, { conversation: "D0OWNERDM1", messageId: "1700000100.000200", clickerId: "U0OWNER1", value: VALUE_A, ackId: null, text: "Scout asks & waits" });
  assert.equal(parseSlackAction(slackClick({ team: { id: "T0OTHER" } }), BOT), null, "other team");
  assert.equal(parseSlackAction(slackClick({ user: { id: "B0BOT" } }), BOT), null, "not a user");
  assert.equal(parseSlackAction(slackClick({ actions: [{ action_id: "other", value: VALUE_A }] }), BOT), null, "not our button");
  assert.equal(parseSlackAction(slackClick({ type: "view_submission" }), BOT), null);
});

function slackNet() {
  const calls: { method: string; form: URLSearchParams }[] = [];
  const net: ChannelNet = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const method = new URL(String(input)).pathname.replace(/^\/api\//u, "");
      calls.push({ method, form: new URLSearchParams(String(init?.body ?? "")) });
      return new Response(JSON.stringify({ ok: true, ts: "1700000100.000200", message_ts: "1" }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    webSocket: () => {
      throw new Error("no ws");
    },
    now: () => 0,
    sleep: async () => undefined,
  };
  return { net, calls };
}

test("slack: send with buttons posts blocks; actionDone final updates without buttons, not final is ephemeral", async () => {
  const creds = { bot_token: ["xoxb", "fake", "test", "bot", "value"].join("-"), app_token: ["xapp", "fake", "test", "app", "value"].join("-") };
  const s = slackNet();
  await slackProvider.send(creds, s.net, { conversation: "D0OWNERDM1", text: "Post?", actions: BUTTONS });
  const blocks = JSON.parse(String(s.calls[0]?.form.get("blocks"))) as { type: string }[];
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["section", "actions"],
  );
  assert.equal(s.calls[0]?.form.get("text"), "Post?");
  const done = slackProvider.actionDone;
  assert.ok(done);
  await done(creds, s.net, { conversation: "D0OWNERDM1", messageId: "1700000100.000200", clickerId: "U0OWNER1", ackId: null, text: "Post?", notice: "Approved by you at 10:00 UTC.", final: true });
  assert.equal(s.calls[1]?.method, "chat.update");
  const updated = JSON.parse(String(s.calls[1]?.form.get("blocks"))) as { type: string }[];
  assert.deepEqual(
    updated.map((b) => b.type),
    ["section", "context"],
  );
  await done(creds, s.net, { conversation: "D0OWNERDM1", messageId: "1700000100.000200", clickerId: "U0OTHER1", ackId: null, text: "Post?", notice: "Only the person…", final: false });
  assert.deepEqual([s.calls[2]?.method, s.calls[2]?.form.get("user")], ["chat.postEphemeral", "U0OTHER1"]);
});

// ── Telegram ──

test("telegram: inline keyboard on send; callback_query parsed; actionDone answers and edits the keyboard away", async () => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const net: ChannelNet = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const method = String(input).split("/").at(-1) ?? "";
      calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true, result: method === "sendMessage" ? { message_id: 77 } : true }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    webSocket: () => {
      throw new Error("no ws");
    },
    now: () => 0,
    sleep: async () => undefined,
  };
  const creds = { bot_token: "123456:AAfaketesttoken" };
  await telegramProvider.send(creds, net, { conversation: "42", text: "Post?", actions: BUTTONS });
  assert.deepEqual(calls[0]?.body.reply_markup, {
    inline_keyboard: [
      [
        { text: "Approve", callback_data: VALUE_A },
        { text: "Deny", callback_data: VALUE_D },
      ],
    ],
  });
  const update = { update_id: 9, callback_query: { id: "4382bfdwdsb323b2d9", from: { id: 42, is_bot: false }, message: { message_id: 77, date: 1, chat: { id: 42, type: "private" }, text: "Post?" }, data: VALUE_A } };
  assert.deepEqual(parseTelegramCallback(update, { botId: "999" }), { conversation: "42", messageId: "77", clickerId: "42", value: VALUE_A, ackId: "4382bfdwdsb323b2d9", text: "Post?" });
  assert.equal(parseTelegramCallback({ callback_query: { ...update.callback_query, message: undefined, inline_message_id: "x" } }, { botId: "999" }), null, "inline message");
  assert.equal(parseTelegramCallback({ callback_query: { ...update.callback_query, message: { ...update.callback_query.message, date: 0 } } }, { botId: "999" }), null, "inaccessible");
  const done = telegramProvider.actionDone;
  assert.ok(done);
  await done(creds, net, { conversation: "42", messageId: "77", clickerId: "42", ackId: "4382bfdwdsb323b2d9", text: "Post?", notice: "Approved by you at 10:00 UTC.", final: true });
  assert.deepEqual(
    calls.slice(1).map((c) => c.method),
    ["answerCallbackQuery", "editMessageText"],
  );
  assert.equal(calls[2]?.body.text, "Post?\n\nApproved by you at 10:00 UTC.");
  assert.equal(calls[2]?.body.reply_markup, undefined, "keyboard removed");
  await done(creds, net, { conversation: "42", messageId: "77", clickerId: "43", ackId: "4382bfdwdsb323b2d9", text: "Post?", notice: "Only the person…", final: false });
  assert.deepEqual([calls.at(-1)?.method, calls.at(-1)?.body.show_alert], ["answerCallbackQuery", true]);
});

test("slack socket: an interactive envelope is acked and reaches the action sink once (replay guard)", async () => {
  class Socket extends EventTarget {
    readonly sent: string[] = [];
    send(data: string) {
      this.sent.push(data);
    }
    close() {}
    emit(frame: unknown) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
    }
  }
  const sockets: Socket[] = [];
  const net: ChannelNet = {
    fetch: (async () => new Response(JSON.stringify({ ok: true, url: "wss://wss-primary.slack.com/link/?ticket=t" }), { headers: { "content-type": "application/json" } })) as typeof fetch,
    webSocket: () => {
      const s = new Socket();
      sockets.push(s);
      return s as unknown as WebSocket;
    },
    now: () => 0,
    sleep: async () => undefined,
  };
  const creds = { bot_token: ["xoxb", "fake", "test", "bot", "value"].join("-"), app_token: ["xapp", "fake", "test", "app", "value"].join("-") };
  const clicks: InboundAction[] = [];
  const abort = new AbortController();
  const inbound = slackProvider.inbound as Extract<ChannelProvider["inbound"], { kind: "socket" | "poll" }>;
  assert.equal(inbound.kind, "socket");
  const running = inbound.run(creds, net, BOT, () => {}, abort.signal, (a) => clicks.push(a));
  for (let i = 0; i < 100 && sockets.length === 0; i += 1) await new Promise((r) => setImmediate(r));
  const socket = sockets[0] as Socket;
  socket.emit({ type: "hello" });
  socket.emit({ envelope_id: "e1", type: "interactive", payload: slackClick() });
  socket.emit({ envelope_id: "e2", type: "interactive", payload: slackClick() });
  socket.emit({ envelope_id: "e3", type: "interactive", payload: slackClick({ team: { id: "T0OTHER" } }) });
  assert.equal(clicks.length, 1);
  assert.deepEqual(socket.sent, ['{"envelope_id":"e1"}', '{"envelope_id":"e2"}', '{"envelope_id":"e3"}']);
  abort.abort();
  await running;
});

test("telegram: the poll asks for callback_query updates only when an action sink is given (QA-CON23-1)", async () => {
  const bodies: Record<string, unknown>[] = [];
  const run = async (withSink: boolean) => {
    const abort = new AbortController();
    const net: ChannelNet = {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const method = String(input).split("/").at(-1) ?? "";
        if (method === "getUpdates") {
          bodies.push(JSON.parse(String(init?.body ?? "{}")));
          abort.abort();
        }
        return new Response(JSON.stringify({ ok: true, result: method === "getWebhookInfo" ? { url: "" } : [] }), { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      webSocket: () => {
        throw new Error("no ws");
      },
      now: () => 0,
      sleep: async () => undefined,
    };
    const inbound = telegramProvider.inbound as Extract<ChannelProvider["inbound"], { kind: "socket" | "poll" }>;
    await inbound.run({ bot_token: "123456:AAfaketesttoken" }, net, { botId: "999", botName: "bot" }, () => {}, abort.signal, withSink ? () => {} : undefined);
  };
  await run(true);
  await run(false);
  assert.deepEqual(bodies[0]?.allowed_updates, ["message", "channel_post", "edited_message", "edited_channel_post", "callback_query"]);
  assert.deepEqual(bodies[1]?.allowed_updates, ["message", "channel_post", "edited_message", "edited_channel_post"]);
});

test("telegram poll: a callback_query update reaches the action sink, not the message sink", async () => {
  const abort = new AbortController();
  const clicks: InboundAction[] = [];
  const messages: unknown[] = [];
  let n = 0;
  const net: ChannelNet = {
    fetch: (async (input: string | URL) => {
      const method = String(input).split("/").at(-1) ?? "";
      if (method === "getUpdates" && ++n > 1) abort.abort();
      const result =
        method === "getWebhookInfo"
          ? { url: "" }
          : n === 1
            ? [{ update_id: 1, callback_query: { id: "cbq1", from: { id: 42, is_bot: false }, message: { message_id: 7, date: 1, chat: { id: 42, type: "private" }, text: "Post?" }, data: VALUE_A } }]
            : [];
      return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    webSocket: () => {
      throw new Error("no ws");
    },
    now: () => 0,
    sleep: async () => undefined,
  };
  const inbound = telegramProvider.inbound as Extract<ChannelProvider["inbound"], { kind: "socket" | "poll" }>;
  await inbound.run({ bot_token: "123456:AAfaketesttoken" }, net, { botId: "999", botName: "bot" }, (m) => messages.push(m), abort.signal, (a) => clicks.push(a));
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0]?.ackId, "cbq1");
  assert.equal(messages.length, 0);
});
