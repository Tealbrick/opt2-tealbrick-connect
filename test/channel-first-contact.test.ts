/**
 * C354a QA S3-1 (INC-20261025-01): `channel_send` to a conversation Connect has never seen is a first contact. Pins the one
 * provider refresh per unknown send, the exact-string match, the old direct-conversation check, fail-closed provider errors and
 * the 200-entry list cap. Adopted from the QA probe (qa-probe3) with its assertions unchanged.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import { type ConnectError, createConnectApp } from "../src/app.ts";
import { ChannelError, type ChannelNet, type ChannelProvider, type Conversation, type InboundMessage, type InboundSink } from "../src/channels/provider.ts";
import { eventCtx, handlerOf, root, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const AGENT = "agt_01CHANAGENT000000000000000";

const ids = (n: number): Conversation[] => Array.from({ length: n }, (_, i) => ({ id: `C${String(i + 1).padStart(3, "0")}`, name: `chan${i + 1}`, type: "channel" as const }));
function world(initial: Conversation[]) {
  const sent: { conversation: string; text: string }[] = [];
  const st = { list: initial, listCalls: 0, listFails: false };
  let sink: InboundSink | null = null;
  const provider: ChannelProvider = {
    service: "telegram",
    credentialFields: ["bot_token"],
    maxTextLength: 4096,
    verify: async () => ({ botId: "bot-1", botName: "Test bot" }),
    conversations: async () => {
      st.listCalls += 1;
      if (st.listFails) throw new ChannelError("channel_provider_unavailable", "down", 502);
      return st.list;
    },
    send: async (_c, _n, input) => {
      sent.push({ conversation: input.conversation, text: input.text });
      return { messageId: `m${sent.length}` };
    },
    edit: async () => undefined,
    delete: async () => undefined,
    react: async () => undefined,
    openDirect: async (_c, _n, input) => ({ conversation: `dm-${input.personId}` }),
    inbound: { kind: "poll", run: async (_c, _n, _b, s, signal) => { sink = s; await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true })); } },
  };
  const net: ChannelNet = { fetch: (() => Promise.reject(new Error("no network"))) as typeof fetch, webSocket: () => { throw new Error("no ws"); }, now: () => Date.now(), sleep: async () => undefined };
  return { provider, net, sent, st, deliver: (m: InboundMessage) => sink?.(m) };
}
async function setup(initial = ids(2)) {
  const w = world(initial);
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), channelProviders: new Map([["telegram", w.provider]]), channelNet: w.net });
  await app.events?.agentAdded?.({ id: AGENT as `agt_${string}`, name: AGENT, mode: "free", status: "active" }, eventCtx(db));
  const person = testCtx({ db, person: true });
  const { account } = (await handlerOf(app, "channel_account_connect")({ service: "telegram", label: "TG", agent: AGENT, credentials: { bot_token: "123:ok" } }, person)) as { account: { id: string } };
  await new Promise((r) => setTimeout(r, 10));
  w.st.listCalls = 0;
  const ctx = testCtx({ db, agent: AGENT, access: { [account.id]: "read_update" }, grantHeld: ["first_contact"] });
  const send = (conversation: string, extra: Record<string, unknown> = {}) => handlerOf(app, "channel_send")({ account: account.id, conversation, text: "hello", ...extra }, ctx);
  const code = (p: Promise<unknown>) => p.then(() => "SENT", (e: ConnectError) => e.code);
  return { w, db, app, account, ctx, send, code };
}
const msg = (conversation: string, type: InboundMessage["conversationType"], id = "1", sender = "u1"): InboundMessage => ({ conversation, conversationType: type, messageId: id, threadId: null, senderId: sender, senderName: "Ann", text: "hi", sentAt: 1 });

test("S3-1: every way to address a person or an unlisted place is refused with nothing sent", async () => {
  const s = await setup();
  const bad = ["U0NEWPERSON", "D0NEWDM", "C0NOTLISTED", "G0PRIVATE", "123456789", "-1001234567890", "@someuser", "someone@example.com", "", " ", " C001", "C001 ", "c001", "C001\n", "C001\u200b", "C0O1", "c001/../C002", "C001,C0NEW"];
  for (const id of bad) {
    const before = s.w.sent.length;
    const c = await s.code(s.send(id));
    assert.equal(c, "channel_first_contact_required", JSON.stringify(id));
    assert.equal(s.w.sent.length, before, `provider reached for ${JSON.stringify(id)}`);
  }
  assert.equal(await s.code(s.send("C001")), "SENT", "listed channel posts as before");
  assert.equal(await s.code(s.send("C002", { threadId: "5" })), "SENT");
  assert.equal(await s.code(s.send("U0NEWPERSON", { threadId: "5" })), "channel_first_contact_required");
});

test("S3-1: known direct conversations keep the old check; exact-string match only", async () => {
  const s = await setup();
  s.w.deliver(msg("D100", "direct", "10", "uA"));
  assert.equal(await s.code(s.send("D100")), "SENT", "a person who wrote first");
  for (const v of ["d100", " D100", "D100 ", "D100\n"]) assert.equal(await s.code(s.send(v)), "channel_first_contact_required", JSON.stringify(v));
  // a DM Connect knows but nobody wrote in, and no contact: old check refuses
  s.db.prepare("INSERT INTO connect_channel_conversations (account_id, conversation, name, type, last_seen_at) VALUES (?, 'D200', 'x', 'direct', 0)").run(s.account.id);
  assert.equal(await s.code(s.send("D200")), "channel_first_contact_required");
  // after channel_dm_first the person is a contact and channel_send to the opened conversation works
  await handlerOf(s.app, "channel_dm_first")({ account: s.account.id, person: "u7", text: "hello" }, s.ctx);
  assert.equal(await s.code(s.send("dm-u7")), "SENT");
});

test("S3-1: refresh-then-known, concurrency, provider failure, refresh count", async () => {
  const s = await setup();
  assert.equal(await s.code(s.send("C005")), "channel_first_contact_required");
  assert.equal(s.w.st.listCalls, 1, "one refresh per unknown send");
  s.w.st.list = ids(6); // the provider now lists C005
  assert.equal(await s.code(s.send("C005")), "SENT");
  assert.equal(s.w.st.listCalls, 2);
  assert.equal(await s.code(s.send("C005")), "SENT");
  assert.equal(s.w.st.listCalls, 2, "known: no further refresh");
  // parallel sends to unknown ids: all refused, nothing sent
  const before = s.w.sent.length;
  const r = await Promise.all(["U1", "U2", "U3", "C0X"].map((i) => s.code(s.send(i))));
  assert.deepEqual(r, Array(4).fill("channel_first_contact_required"));
  assert.equal(s.w.sent.length, before);
  // the provider fails on refresh: still refused (fail closed)
  s.w.st.listFails = true;
  assert.equal(await s.code(s.send("U9")), "channel_first_contact_required");
  assert.equal(await s.code(s.send("C001")), "SENT", "known ids need no refresh");
});

test("S3-1: group DM (mpim) and the cap of 200", async () => {
  const s = await setup(ids(250));
  // refresh stores the first 200 only
  assert.equal(await s.code(s.send("C200")), "SENT", "200th listed channel");
  assert.equal(await s.code(s.send("C201")), "channel_first_contact_required", "201st is beyond the cap: fails closed");
  assert.equal(await s.code(s.send("C250")), "channel_first_contact_required");
  // mpim: not listed; an inbound group message makes it known as group; an unseen mpim is refused
  assert.equal(await s.code(s.send("G0MPIM")), "channel_first_contact_required");
  s.w.deliver(msg("G0MPIM", "group", "20", "uB"));
  assert.equal(await s.code(s.send("G0MPIM")), "SENT", "a group DM Connect saw inbound is known");
  assert.equal(await s.code(s.send("G0OTHERMPIM")), "channel_first_contact_required");
});

test("S3-1: channel_reply and the inbound conversation are unchanged", async () => {
  const s = await setup();
  s.w.deliver(msg("D300", "direct", "30", "uC"));
  const inbox = (await handlerOf(s.app, "channel_inbox")({}, s.ctx)) as { messages: { seq: number }[] };
  const rep = await handlerOf(s.app, "channel_reply")({ account: s.account.id, seq: inbox.messages[0]?.seq ?? 0, text: "re" }, s.ctx);
  assert.ok(rep);
});
