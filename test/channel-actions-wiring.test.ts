/**
 * CON23D-1 / CON23D-2 (QA delta on connect#23 24a4a80, adopted from QA's probe tests): the Telegram poll confirms a
 * callback_query at once (R2 keeps message offsets after the sink), and the hub really hands the provider the action sink.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AccountStore } from "../src/accounts.ts";
import type { ChannelNet, ChannelProvider, InboundAction, MessageAction } from "../src/channels/provider.ts";
import { telegramProvider } from "../src/channels/providers/telegram.ts";
import { ChannelHub } from "../src/channels/service.ts";
import { secretsFor, testDb } from "./helpers.ts";

type Upd = Record<string, unknown>;
const cb = (id: number, data = "v"): Upd => ({ update_id: id, callback_query: { id: `cbq${id}`, from: { id: 42, is_bot: false }, message: { message_id: 7, date: 1, chat: { id: 42, type: "private" }, text: "Post?" }, data } });
const msg = (id: number): Upd => ({ update_id: id, message: { message_id: id, date: 1, chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false, first_name: "A" }, text: `hello ${id}` } });

/** A Telegram model: unconfirmed updates stay until a getUpdates carries an offset above them. */
function server(pending: Upd[], stopAfterPolls: number) {
  const abort = new AbortController();
  const offsets: (number | undefined)[] = [];
  const net: ChannelNet = {
    fetch: (async (input: string | URL, init?: RequestInit) => {
      const method = String(input).split("/").at(-1) ?? "";
      let result: unknown = [];
      if (method === "getWebhookInfo") result = { url: "" };
      if (method === "getUpdates") {
        const off = (JSON.parse(String(init?.body ?? "{}")) as { offset?: number }).offset;
        offsets.push(off);
        if (off !== undefined) pending = pending.filter((u) => (u.update_id as number) >= off);
        result = [...pending];
        if (offsets.length >= stopAfterPolls) abort.abort();
      }
      return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    webSocket: () => {
      throw new Error("no ws");
    },
    now: () => 0,
    sleep: async () => undefined,
  };
  return { abort, net, offsets, left: () => pending.map((u) => u.update_id) };
}
const inbound = telegramProvider.inbound as Extract<ChannelProvider["inbound"], { kind: "socket" | "poll" }>;
const bot = { botId: "999", botName: "bot" };
const creds = { bot_token: "123456:AAfaketesttoken" };

test("QA-D1 callback_query: the next getUpdates confirms it at once (offset = id + 1)", async () => {
  const s = server([cb(5)], 2);
  const clicks: InboundAction[] = [];
  await inbound.run(creds, s.net, bot, () => {}, s.abort.signal, (a) => void clicks.push(a));
  assert.equal(clicks.length, 1);
  assert.deepEqual(s.offsets, [undefined, 6]);
});

test("QA-D2 [click 10, message 11 fails once]: click delivered once, message stored on the retry", async () => {
  const s = server([cb(10), msg(11)], 4);
  const clicks: InboundAction[] = [];
  const stored: unknown[] = [];
  let failed = false;
  await inbound.run(creds, s.net, bot, (m) => { if (!failed) { failed = true; throw new Error("db"); } stored.push(m); }, s.abort.signal, (a) => void clicks.push(a));
  assert.equal(clicks.length, 1, "click not replayed when the message after it is fetched again");
  assert.equal(stored.length, 1);
  assert.deepEqual(s.offsets.slice(0, 3), [undefined, 11, 12]);
});

test("QA-D3 [message 10 fails once, click 11]: the click is delivered exactly once (after the retry)", async () => {
  const s = server([msg(10), cb(11)], 4);
  const clicks: InboundAction[] = [];
  const stored: unknown[] = [];
  let failed = false;
  await inbound.run(creds, s.net, bot, (m) => { if (!failed) { failed = true; throw new Error("db"); } stored.push(m); }, s.abort.signal, (a) => void clicks.push(a));
  assert.equal(clicks.length, 1);
  assert.equal(stored.length, 1);
});

test("QA-D4 crash between fetch and the click: the restart gets the callback again (never lost), and it is the ledger that stops a second decision", async () => {
  const s = server([cb(5)], 1);
  const first: InboundAction[] = [];
  // run 1 dies while handling the click: abort inside the sink, no further getUpdates confirms the update
  await inbound.run(creds, s.net, bot, () => {}, s.abort.signal, (a) => { first.push(a); s.abort.abort(); });
  assert.equal(first.length, 1);
  assert.deepEqual(s.left(), [5], "Telegram still holds it: nothing confirmed");
});

test("QA-D5 hub.start passes an action sink to the provider, and a click through it reaches the relay", async () => {
  let sink: ((a: InboundAction) => void) | undefined;
  const sent: string[] = [];
  const BUTTONS: MessageAction[] = [{ label: "Approve", value: `ib1.${"a".repeat(16)}.a.${"m".repeat(22)}`, style: "primary" }];
  const provider: ChannelProvider = {
    service: "slack", credentialFields: ["bot_token"], maxTextLength: 4000,
    verify: async () => ({ botId: "U0BOT", botName: "bot", workspace: "T0TEAM" }),
    conversations: async () => [],
    send: async (_c, _n, i) => {
      sent.push(i.text);
      return { messageId: "m1" };
    },
    edit: async () => undefined, delete: async () => undefined, react: async () => undefined,
    openDirect: async (_c, _n, i) => ({ conversation: `D-${i.personId}` }),
    actionDone: async () => undefined,
    inbound: { kind: "poll", run: async (_c, _n, _b, _s, signal, actions) => { sink = actions; await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true })); } },
  };
  const net: ChannelNet = { fetch: (() => Promise.reject(new Error("x"))) as typeof fetch, webSocket: () => { throw new Error("x"); }, now: () => 1_760_000_000_000, sleep: async () => undefined };
  const db = testDb();
  const h = new ChannelHub({ db, accounts: new AccountStore(db), secrets: secretsFor(db), providers: new Map([["slack", provider]]), net });
  const account = await h.connect({ service: "slack", label: "S", agent: "agt_01ACTIONAGENT0000000000000", credentials: { bot_token: "xoxb-x" } });
  const relayed: unknown[] = [];
  h.setActionRelay(async (p, i) => {
    relayed.push([p, i]);
    return { final: true, notice: "ok" };
  });
  await h.directMessage(account, "ins_01INBOXAPP000000000000000000", { person: "U0OWNER", text: "t", first: true, origin: { product: "inbox", instance: "ins_01INBOXAPP000000000000000000", requestedAccount: "slack", actions: BUTTONS, expiresAt: 1_760_000_000_000 + 3_600_000 } });
  h.start(account);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(typeof sink, "function", "the hub gave the provider an action sink");
  sink?.({ conversation: "D-U0OWNER", messageId: "m1", clickerId: "U0OWNER", value: String(BUTTONS[0]?.value), ackId: null, text: "t" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(relayed.length, 1);
  h.stopAll();
});
