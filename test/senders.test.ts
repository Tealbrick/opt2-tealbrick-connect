/**
 * Connect 0.4.0: C86 workspace sender identities for companion APP callers, C81 G6 identities_list (C88: handles only),
 * F20 lazy agent Buzz identities, F15 mentions on reads.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Caller, Json } from "@opt2-tealbrick/spec/sdk";

import { type ConnectError, createConnectApp } from "../src/app.ts";
import { WORKSPACE_SENDER } from "../src/channels/buzz/identity.ts";
import { generateSecretKey, type NostrEvent, npubEncode, publicKeyOf, signEvent, verifyEvent } from "../src/channels/buzz/nostr.ts";
import type { ChannelNet, ChannelProvider, InboundMessage, InboundSink } from "../src/channels/provider.ts";
import { eventCtx, fakeFetch, handlerOf, root, scopeCreates, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const RELAY = "wss://relay.test.example";
const ORIGINS = [RELAY, "https://relay.test.example"];
const DM_CHANNEL = "5a7d6c2e-1f3a-4c5b-9d8e-7f6a5b4c3d2e";
const READ_CHANNEL = "0b7d6c2e-1f3a-4c5b-9d8e-7f6a5b4c3d2e";
const A = "agt_01SENDERAGENTA00000000000000";
const B = "agt_01SENDERAGENTB00000000000000";
const INBOX_APP = "ins_01INBOXAPP000000000000000000";

const isCode = (code: string) => (e: ConnectError) => e.code === code;

function world(readEvents: NostrEvent[] = []) {
  const events: NostrEvent[] = [];
  const relay = fakeFetch({
    "POST /events": ({ body }) => {
      const e = body as NostrEvent;
      assert.equal(verifyEvent(e), true);
      events.push(e);
      return { body: e.kind === 41010 ? { accepted: true, message: `response:${JSON.stringify({ channel_id: DM_CHANNEL })}` } : { accepted: true, message: "" } };
    },
    "POST /query": () => ({ body: readEvents }),
  });
  const sent: { conversation: string; text: string }[] = [];
  let sink: InboundSink | null = null;
  const provider: ChannelProvider = {
    service: "slack",
    credentialFields: ["bot_token"],
    maxTextLength: 4000,
    verify: async (creds) => ({ botId: creds.bot_token === "xoxb-a" ? "U0BOTA" : "U0BOTB", botName: "bot", workspace: "T0TEAM" }),
    conversations: async () => [],
    send: async (_c, _n, input) => {
      sent.push(input);
      return { messageId: `m${sent.length}` };
    },
    edit: async () => undefined,
    delete: async () => undefined,
    react: async () => undefined,
    openDirect: async (_c, _n, input) => ({ conversation: `D-${input.personId}` }),
    inbound: {
      kind: "poll",
      run: async (_c, _n, _b, s, signal) => {
        sink = s;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    },
  };
  const net: ChannelNet = { fetch: (() => Promise.reject(new Error("no network"))) as typeof fetch, webSocket: () => { throw new Error("no ws"); }, now: () => Date.now(), sleep: async () => undefined };
  return { events, relay, provider, net, sent, deliver: (m: InboundMessage) => sink?.(m) };
}

async function setup(readEvents: NostrEvent[] = []) {
  const w = world(readEvents);
  const db = testDb();
  const app = createConnectApp({
    manifest,
    migrationsDir: join(root, "migrations"),
    fetchImpl: w.relay.impl,
    buzzRelays: RELAY,
    allowRelayOrigins: ORIGINS,
    channelProviders: new Map([["slack", w.provider]]),
    channelNet: w.net,
  });
  for (const [id, name] of [[A, "Agent A"], [B, "Agent B"]] as const) await app.events?.agentAdded?.({ id: id as `agt_${string}`, name, mode: "free", status: "active" }, eventCtx(db));
  const person = testCtx({ db, person: true });
  const appCtx = () => testCtx({ db, app: INBOX_APP });
  const run = (op: string, input: Record<string, unknown>, ctx = appCtx()) => handlerOf(app, op)(input as Json, ctx);
  return { w, db, app, person, appCtx, run };
}

test("manifest 0.4.0: identities_list is agent read-only without receipt; sender ops are person writes; account scope shares sender instances", () => {
  const ops = Object.fromEntries(manifest.operations.map((o) => [o.id, o]));
  assert.equal(manifest.version, "0.6.0");
  const list = ops.identities_list;
  assert.deepEqual([list?.audience, list?.effect, list?.idempotency, list?.receipt, list?.scopeType], ["agent", "read", "none", false, undefined]);
  assert.deepEqual(list?.crud, ["read"]);
  for (const id of ["sender_identities_list", "sender_identity_set", "sender_identity_clear"]) assert.equal(ops[id]?.audience, "person", id);
  assert.deepEqual(manifest.scopes?.[0]?.defaultGrants, [{ kind: "shared", access: "apps_only" }]);
  // A2A-12: the apps-only level is labelled as such and the canvas summary counts only levels agents can use.
  assert.match(manifest.scopes?.[0]?.access.find((a) => a.id === "apps_only")?.label ?? "", /APPS ONLY \(not usable by agents\)/u);
  assert.doesNotMatch(manifest.scopes?.[0]?.summaryTemplate ?? "", /\{count\}|apps_only/u);
});

test("C86 Buzz: an app caller with no workspace sender gets no_sender_identity (409, not retryable, names the settings page)", async () => {
  const s = await setup();
  const to = npubEncode(publicKeyOf(generateSecretKey()));
  for (const op of ["buzz_dm", "buzz_dm_first", "buzz_post"]) {
    await assert.rejects(s.run(op, { to, content: "x", channel: READ_CHANNEL }), (e: ConnectError & { details?: Record<string, unknown> }) => {
      assert.equal(e.code, "no_sender_identity");
      assert.equal(e.httpStatus, 409);
      assert.equal(e.details?.retryable, false);
      assert.match(e.message, /Connect → Senders/u);
      return true;
    });
  }
  assert.equal(s.w.events.length, 0);
});

test("C86 Buzz: the owner sets the workspace sender (identity created); apps send from it, first contact still applies, receipt records the identity", async () => {
  const s = await setup();
  const set = (await handlerOf(s.app, "sender_identity_set")({ channel: "buzz", label: "Acme workspace" }, s.person)) as { sender: { identity: string; label: string } };
  assert.match(set.sender.identity, /^buzz:npub1/u);
  assert.equal(set.sender.label, "Acme workspace");
  const workspacePub = set.sender.identity.slice(5);
  const person = publicKeyOf(generateSecretKey());
  // First contact holds still apply to apps: buzz_dm to a new person is refused with the app path spelled out.
  await assert.rejects(s.run("buzz_dm", { to: npubEncode(person), content: "alert" }), (e: ConnectError) => {
    assert.equal(e.code, "buzz_first_contact_required");
    assert.match(e.message, /workspace sender[\s\S]*buzz_dm_first/u);
    return true;
  });
  const ctx = s.appCtx();
  await handlerOf(s.app, "buzz_dm_first")({ to: npubEncode(person), content: "first alert" }, ctx);
  assert.deepEqual(ctx.receipts.meta.at(-1), { subjectKind: "workspace_sender", sender: set.sender.identity, to: npubEncode(person), channel: DM_CHANNEL });
  assert.match(ctx.receipts.summary.at(-1) ?? "", /workspace sender/u);
  const later = s.appCtx();
  await handlerOf(s.app, "buzz_dm")({ to: npubEncode(person), content: "second alert" }, later);
  // Every event is signed by the workspace sender key, never by an agent key.
  assert.ok(s.w.events.length >= 3);
  for (const e of s.w.events) assert.equal(npubEncode(e.pubkey), workspacePub);
  assert.equal((later.receipts.meta.at(-1) as { sender: string }).sender, set.sender.identity);
  // An agent caller keeps its own identity (created on first use, F20) and its own contacts.
  const agentCtx = testCtx({ db: s.db, agent: A });
  await assert.rejects(handlerOf(s.app, "buzz_dm")({ to: npubEncode(person), content: "hi" }, agentCtx), isCode("buzz_first_contact_required"));
  await handlerOf(s.app, "buzz_dm_first")({ to: npubEncode(person), content: "hi" }, agentCtx);
  const agentSender = (agentCtx.receipts.meta.at(-1) as { sender: string; subjectKind: string });
  assert.equal(agentSender.subjectKind, "as_itself");
  assert.notEqual(agentSender.sender, set.sender.identity);
  // Read and own-state ops stay agent-only for apps (no confused deputy, C88).
  for (const op of ["buzz_read", "buzz_channels", "buzz_identity", "buzz_schedule", "buzz_scheduled"]) await assert.rejects(s.run(op, { channel: READ_CHANNEL }), isCode("agent_only"), op);
  // Clearing removes the workspace key; apps are refused again.
  await handlerOf(s.app, "sender_identity_clear")({ channel: "buzz" }, s.person);
  await assert.rejects(s.run("buzz_dm", { to: npubEncode(person), content: "x" }), isCode("no_sender_identity"));
  assert.equal(s.db.prepare("SELECT 1 FROM connect_buzz_identities WHERE agent = ?").get(WORKSPACE_SENDER), undefined);
});

test("C86 chat: apps send from the owner-picked bot via the shared sender:<service> instance; agents cannot use it (sender_reserved_for_apps)", async () => {
  const s = await setup();
  const a = (await handlerOf(s.app, "channel_account_connect")({ service: "slack", label: "A bot", agent: A, credentials: { bot_token: "xoxb-a" } }, s.person)) as { account: { id: string } };
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(s.run("channel_dm", { account: "slack", person: "U0OWNER", text: "alert" }), isCode("no_sender_identity"));
  await assert.rejects(handlerOf(s.app, "sender_identity_set")({ channel: "slack", account: "acc_nope" }, s.person), isCode("account_unknown"));
  const before = scopeCreates.length;
  const set = (await handlerOf(s.app, "sender_identity_set")({ channel: "slack", account: a.account.id }, s.person)) as { sender: { identity: string } };
  assert.equal(set.sender.identity, "slack:U0BOTA");
  assert.deepEqual(scopeCreates.slice(before), [{ type: "account", id: "sender:slack", label: "Workspace sender (slack) — for apps only, not usable by agents", shared: true }]);
  // The SDK checks the app's scope on sender:slack (shared default), whether the app names the service or an account id.
  const spec = s.app.handlers.channel_dm as { scope: (input: Json, caller: Caller) => string | null };
  const appCaller: Caller = { type: "app", id: INBOX_APP as `ins_${string}`, name: "Inbox", mode: null };
  const agentCaller: Caller = { type: "agent", id: A as `agt_${string}`, name: "A", mode: "free" };
  assert.equal(spec.scope({ account: "slack", person: "p", text: "t" }, appCaller), "sender:slack");
  assert.equal(spec.scope({ account: a.account.id, person: "p", text: "t" }, appCaller), "sender:slack");
  assert.equal(spec.scope({ account: a.account.id, person: "p", text: "t" }, agentCaller), a.account.id);
  // First contact applies; then the DM goes out through the picked bot and the receipt names it.
  await assert.rejects(s.run("channel_dm", { account: "slack", person: "U0OWNER", text: "alert" }), (e: ConnectError) => e.code === "channel_first_contact_required" && /channel_dm_first/u.test(e.message));
  const ctx = s.appCtx();
  const first = (await handlerOf(s.app, "channel_dm_first")({ account: "slack", person: "U0OWNER", text: "first alert" }, ctx)) as { conversation: string };
  assert.equal(first.conversation, "D-U0OWNER");
  assert.equal((ctx.receipts.meta.at(-1) as { sender: string; subjectKind: string }).sender, "slack:U0BOTA");
  await s.run("channel_dm", { account: "slack", person: "U0OWNER", text: "second alert" });
  assert.deepEqual(s.w.sent.map((m) => m.text), ["first alert", "second alert"]);
  // Coordinator condition 1: an agent WITH a scope row on sender:slack (shared default) still cannot send from it.
  const agentB = testCtx({ db: s.db, agent: B, access: { "sender:slack": "read_update" } }); // the SDK row is apps_only; the handler refuses regardless of level
  for (const op of ["channel_dm", "channel_send", "channel_dm_first", "channel_edit", "channel_react", "channel_conversations"]) {
    await assert.rejects(handlerOf(s.app, op)({ account: "sender:slack", person: "U0OWNER", conversation: "C1", messageId: "m1", text: "x", emoji: "+" }, agentB), isCode("sender_reserved_for_apps"), op);
  }
  // ...and an agent naming the service gets nothing either (only its own bots).
  await assert.rejects(handlerOf(s.app, "channel_dm")({ account: "slack", person: "U0OWNER", text: "x" }, agentB), isCode("channel_account_unknown"));
  // Edits/deletes/reactions are not app ops.
  await assert.rejects(s.run("channel_edit", { account: "slack", conversation: "C1", messageId: "m1", text: "x" }), isCode("agent_only"));
  // A disconnected sender bot is "no sender" for apps; clear un-shares the instance.
  await handlerOf(s.app, "account_disconnect")({ id: a.account.id }, s.person);
  await assert.rejects(s.run("channel_dm", { account: "slack", person: "U0OWNER", text: "x" }), isCode("no_sender_identity"));
  await handlerOf(s.app, "sender_identity_clear")({ channel: "slack" }, s.person);
  assert.equal(scopeCreates.at(-1)?.shared, false);
  const list = (await handlerOf(s.app, "sender_identities_list")({}, s.person)) as { senders: { channel: string; set: boolean }[] };
  assert.deepEqual(list.senders.filter((x) => x.set), []);
});

test("C81 G6 identities_list: handles only; an agent sees its own, a companion app all agents; the workspace sender is not an agent", async () => {
  const s = await setup();
  await handlerOf(s.app, "buzz_identities_generate")({}, s.person);
  await handlerOf(s.app, "sender_identity_set")({ channel: "buzz" }, s.person);
  await handlerOf(s.app, "channel_account_connect")({ service: "slack", label: "B bot", agent: B, credentials: { bot_token: "xoxb-b" } }, s.person);
  const npubOf = (agent: string) => npubEncode(String(s.db.prepare("SELECT pubkey FROM connect_buzz_identities WHERE agent = ?").get(agent)?.pubkey));
  const all = (await s.run("identities_list", {})) as { identities: Record<string, string>[]; nextCursor: string | null };
  assert.deepEqual(all.identities, [
    { agent: A, channel: "buzz", identity: `buzz:${npubOf(A)}` },
    { agent: B, channel: "buzz", identity: `buzz:${npubOf(B)}` },
    { agent: B, channel: "slack", identity: "slack:U0BOTB" },
  ]);
  assert.equal(all.nextCursor, null);
  for (const row of all.identities) assert.deepEqual(Object.keys(row).sort(), ["agent", "channel", "identity"]);
  const own = (await handlerOf(s.app, "identities_list")({}, testCtx({ db: s.db, agent: A }))) as { identities: { agent: string }[] };
  assert.deepEqual(own.identities.map((r) => r.agent), [A]);
  const peek = (await handlerOf(s.app, "identities_list")({ agent: B }, testCtx({ db: s.db, agent: A }))) as { identities: unknown[] };
  assert.deepEqual(peek.identities, []);
  const onlyB = (await s.run("identities_list", { agent: B })) as { identities: { agent: string }[] };
  assert.deepEqual(onlyB.identities.map((r) => r.agent), [B, B]);
  await assert.rejects(s.run("identities_list", { cursor: "!!" }), isCode("cursor_invalid"));
  // Read only: listing never creates identities.
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM connect_buzz_identities").get()?.n, 3);
});

test("identities_list pages with a cursor", async () => {
  const s = await setup();
  const many = Array.from({ length: 205 }, (_, i) => ({ id: `agt_01PAGE${String(i).padStart(22, "0")}`, name: `P${i}` }));
  await handlerOf(s.app, "buzz_identities_generate")({}, s.person);
  for (const a of many) await s.app.events?.agentAdded?.({ id: a.id as `agt_${string}`, name: a.name, mode: "free", status: "active" }, eventCtx(s.db));
  await handlerOf(s.app, "buzz_identities_generate")({}, s.person);
  const p1 = (await s.run("identities_list", {})) as { identities: { agent: string }[]; nextCursor: string };
  assert.equal(p1.identities.length, 200);
  const p2 = (await s.run("identities_list", { cursor: p1.nextCursor })) as { identities: { agent: string }[]; nextCursor: string | null };
  assert.equal(p2.identities.length, 7);
  assert.equal(p2.nextCursor, null);
  assert.equal(new Set([...p1.identities, ...p2.identities].map((r) => r.agent)).size, 207);
});

test("F20: an agent's first Buzz op creates its identity (no buzz_identity_missing, no owner step)", async () => {
  const s = await setup();
  const ctx = testCtx({ db: s.db, agent: A });
  const out = (await handlerOf(s.app, "buzz_channels")({}, ctx)) as { channels: unknown[] };
  assert.deepEqual(out.channels, []);
  const id = (await handlerOf(s.app, "buzz_identity")({}, ctx)) as { npub: string; relays: string[] };
  assert.match(id.npub, /^npub1/u);
  assert.deepEqual(id.relays, [RELAY]);
  // Parallel first calls create one key only.
  const ctxB = testCtx({ db: s.db, agent: B });
  const [x, y] = (await Promise.all([handlerOf(s.app, "buzz_identity")({}, ctxB), handlerOf(s.app, "buzz_identity")({}, ctxB)])) as { npub: string }[];
  assert.equal(x?.npub, y?.npub);
  await handlerOf(s.app, "buzz_post")({ channel: READ_CHANNEL, content: "hello" }, ctxB);
  assert.equal(npubEncode(s.w.events.at(-1)?.pubkey ?? ""), y?.npub);
});

test("F15: buzz_read lists mentions (p tags and nostr:npub references) and mentionsMe for the reading agent", async () => {
  const author = generateSecretKey();
  const other = publicKeyOf(generateSecretKey());
  // The agent's key is known only after its identity exists, so build events lazily through a mutable list.
  const events: NostrEvent[] = [];
  const s = await setup(events);
  const ctx = testCtx({ db: s.db, agent: A });
  const me = ((await handlerOf(s.app, "buzz_identity")({}, ctx)) as { pubkey: string }).pubkey;
  const at = 1_760_000_000;
  events.push(
    signEvent(author, { kind: 9, created_at: at, tags: [["h", READ_CHANNEL], ["p", me]], content: "please check" }),
    signEvent(author, { kind: 9, created_at: at + 1, tags: [["h", READ_CHANNEL]], content: `ping nostr:${npubEncode(other)} and nostr:${npubEncode(me)}` }),
    signEvent(author, { kind: 9, created_at: at + 2, tags: [["h", READ_CHANNEL], ["p", other]], content: "not you" }),
  );
  const out = (await handlerOf(s.app, "buzz_read")({ channel: READ_CHANNEL }, ctx)) as { messages: { content: string; mentions: string[]; mentionsMe: boolean }[] };
  assert.deepEqual(
    out.messages.map((m) => [m.mentionsMe, m.mentions]),
    [
      [true, [`buzz:${npubEncode(me)}`]],
      [true, [`buzz:${npubEncode(other)}`, `buzz:${npubEncode(me)}`]],
      [false, [`buzz:${npubEncode(other)}`]],
    ],
  );
});

test("F15: channel_inbox lists mentions as <service>:<id> and mentionsMe when the agent's bot is mentioned", async () => {
  const s = await setup();
  const { account } = (await handlerOf(s.app, "channel_account_connect")({ service: "slack", label: "A bot", agent: A, credentials: { bot_token: "xoxb-a" } }, s.person)) as { account: { id: string } };
  await new Promise((r) => setTimeout(r, 10));
  const msg = (id: string, mentions: string[]): InboundMessage => ({ conversation: "C1", conversationType: "channel", messageId: id, threadId: null, senderId: "U0HUMAN", senderName: "Ann", text: "x", sentAt: 1, mentions });
  s.w.deliver(msg("1", ["U0BOTA"]));
  s.w.deliver(msg("2", ["U0SOMEONE"]));
  const out = (await handlerOf(s.app, "channel_inbox")({}, testCtx({ db: s.db, agent: A, access: { [account.id]: "read" } }))) as { messages: { mentions: string[]; mentionsMe: boolean }[] };
  assert.deepEqual(out.messages.map((m) => [m.mentionsMe, m.mentions]), [
    [true, ["slack:U0BOTA"]],
    [false, ["slack:U0SOMEONE"]],
  ]);
});

test("0.5.3 (F76): every operation title is unique, so the approval form never shows two identical rows", () => {
  const seen = new Map<string, string>();
  for (const o of manifest.operations) {
    assert.equal(seen.get(o.title), undefined, `"${o.title}" is the title of ${seen.get(o.title)} and ${o.id}`);
    seen.set(o.title, o.id);
  }
  const title = (id: string) => manifest.operations.find((o) => o.id === id)?.title;
  assert.equal(title("buzz_dm"), "Direct message a known person on Buzz");
  assert.equal(title("channel_dm"), "Direct message a known person on a chat service");
});
