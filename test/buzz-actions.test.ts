/** Buzz message actions (C58 #4): react, edit/delete own posts only, scheduled posts. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Manifest } from "@opt2-tealbrick/spec/manifest";

import { type BuzzSendCheck, type ConnectError, createConnectApp, runDueBuzzPosts } from "../src/app.ts";
import { BuzzIdentities } from "../src/channels/buzz/identity.ts";
import { type NostrEvent, verifyEvent } from "../src/channels/buzz/nostr.ts";
import { BuzzRelay } from "../src/channels/buzz/relay.ts";
import { eventCtx, fakeFetch, handlerOf, root, secretsFor, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const CHANNEL = "0b7d6c2e-1f3a-4c5b-9d8e-7f6a5b4c3d2e";
const ALLOW: BuzzSendCheck = async () => ({ decision: "run" });
const AGENT = "agt_01BUZZACTIONS0000000000000";
const RELAY = "wss://relay.test.example";
const ORIGINS = [RELAY, "https://relay.test.example"];

async function setup() {
  const events: NostrEvent[] = [];
  const relay = fakeFetch({
    "POST /events": ({ body }) => {
      assert.equal(verifyEvent(body), true);
      events.push(body as NostrEvent);
      return { body: { accepted: true, message: "" } };
    },
  });
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), fetchImpl: relay.impl, buzzRelays: RELAY, allowRelayOrigins: ORIGINS });
  await app.events?.agentAdded?.({ id: AGENT as `agt_${string}`, name: "A", mode: "free", status: "active" }, eventCtx(db));
  await handlerOf(app, "buzz_identities_generate")({}, testCtx({ db, person: true }));
  return { db, app, events, relay, ctx: testCtx({ db, agent: AGENT }) };
}

test("react: kind 7 with e + h tags; invalid emoji refused", async () => {
  const s = await setup();
  const target = "a".repeat(64);
  await handlerOf(s.app, "buzz_react")({ channel: CHANNEL, messageId: target, emoji: "👍" }, s.ctx);
  assert.deepEqual(s.events.at(-1)?.tags, [["e", target], ["h", CHANNEL]]);
  assert.equal(s.events.at(-1)?.kind, 7);
  await assert.rejects(handlerOf(s.app, "buzz_react")({ channel: CHANNEL, messageId: target, emoji: ":custom:" }, s.ctx), (e: ConnectError) => e.code === "buzz_reaction_invalid");
});

test("edit (kind 40003) and delete (kind 5) only for the agent's own posts", async () => {
  const s = await setup();
  const posted = (await handlerOf(s.app, "buzz_post")({ channel: CHANNEL, content: "draft" }, s.ctx)) as { id: string };
  await handlerOf(s.app, "buzz_edit")({ channel: CHANNEL, messageId: posted.id, content: "final" }, s.ctx);
  assert.equal(s.events.at(-1)?.kind, 40003);
  assert.deepEqual(s.events.at(-1)?.tags, [["h", CHANNEL], ["e", posted.id]]);
  await assert.rejects(handlerOf(s.app, "buzz_edit")({ channel: CHANNEL, messageId: "b".repeat(64), content: "x" }, s.ctx), (e: ConnectError) => e.code === "buzz_not_own_message");
  await handlerOf(s.app, "buzz_delete")({ channel: CHANNEL, messageId: posted.id }, s.ctx);
  assert.equal(s.events.at(-1)?.kind, 5);
  await assert.rejects(handlerOf(s.app, "buzz_delete")({ channel: CHANNEL, messageId: posted.id }, s.ctx), (e: ConnectError) => e.code === "buzz_not_own_message");
});

test("schedule: validated time, listed, cancelled, due posts sent once by the scheduler", async () => {
  const s = await setup();
  await assert.rejects(handlerOf(s.app, "buzz_schedule")({ channel: CHANNEL, content: "x", sendAt: new Date(Date.now() - 1000).toISOString() }, s.ctx), (e: ConnectError) => e.code === "buzz_send_at_invalid");
  const a = (await handlerOf(s.app, "buzz_schedule")({ channel: CHANNEL, content: "later A", sendAt: new Date(Date.now() + 60_000).toISOString() }, s.ctx)) as { id: string };
  const b = (await handlerOf(s.app, "buzz_schedule")({ channel: CHANNEL, content: "later B", sendAt: new Date(Date.now() + 120_000).toISOString() }, s.ctx)) as { id: string };
  await handlerOf(s.app, "buzz_schedule_cancel")({ id: b.id }, s.ctx);
  await assert.rejects(handlerOf(s.app, "buzz_schedule_cancel")({ id: b.id }, s.ctx), (e: ConnectError) => e.code === "buzz_scheduled_unknown");
  const relay = new BuzzRelay(new BuzzIdentities({ db: s.db, secrets: secretsFor(s.db), relayUrls: RELAY, allowRelayOrigins: ORIGINS }), s.relay.impl);
  const before = s.events.length;
  assert.equal(await runDueBuzzPosts(s.db, relay, s.ctx.log, ALLOW, Date.now() + 61_000), 1);
  assert.equal(await runDueBuzzPosts(s.db, relay, s.ctx.log, ALLOW, Date.now() + 200_000), 0);
  assert.equal(s.events.length, before + 1);
  assert.equal(s.events.at(-1)?.content, "later A");
  const list = (await handlerOf(s.app, "buzz_scheduled")({}, s.ctx)) as { posts: { id: string; status: string; eventId: string | null }[] };
  assert.deepEqual(Object.fromEntries(list.posts.map((p) => [p.id, p.status])), { [a.id]: "sent", [b.id]: "cancelled" });
  // the scheduled post is an own message (editable)
  const sentId = list.posts.find((p) => p.id === a.id)?.eventId ?? "";
  await handlerOf(s.app, "buzz_edit")({ channel: CHANNEL, messageId: sentId, content: "edited" }, s.ctx);
});

// ── CON-01: scheduled posts are checked again when they are due ──

const schedule = (s: Awaited<ReturnType<typeof setup>>, content: string, inMs = 60_000) =>
  handlerOf(s.app, "buzz_schedule")({ channel: CHANNEL, content, sendAt: new Date(Date.now() + inMs).toISOString() }, s.ctx) as Promise<{ id: string }>;
const statusOf = (s: Awaited<ReturnType<typeof setup>>, id: string) => {
  const row = s.db.prepare("SELECT status, detail FROM connect_buzz_scheduled WHERE id = ?").get(id);
  return { status: String(row?.status), detail: String(row?.detail) };
};
const relayFor = (s: Awaited<ReturnType<typeof setup>>, impl = s.relay.impl) =>
  new BuzzRelay(new BuzzIdentities({ db: s.db, secrets: secretsFor(s.db), relayUrls: RELAY, allowRelayOrigins: ORIGINS }), impl);
const agentEntry = (status: "active" | "paused") => ({ id: AGENT as `agt_${string}`, name: "A", mode: "free" as const, status });

test("CON-01 quiet: an active agent's due post is sent once, through a `sending` claim", async () => {
  const s = await setup();
  const a = await schedule(s, "on time");
  let seenWhileSending: string | null = null;
  const relay = relayFor(s, async (input, init) => {
    seenWhileSending = statusOf(s, a.id).status;
    return s.relay.impl(input, init);
  });
  const before = s.events.length;
  assert.equal(await runDueBuzzPosts(s.db, relay, s.ctx.log, ALLOW, Date.now() + 61_000), 1);
  assert.equal(seenWhileSending, "sending", "the row is `sending` (not `sent`) while the relay call runs");
  assert.equal(statusOf(s, a.id).status, "sent");
  assert.equal(s.events.length, before + 1);
});

test("CON-01 fires: a post of an agent paused after scheduling is not sent", async () => {
  const s = await setup();
  const a = await schedule(s, "after pause");
  await s.app.events?.agentsChanged?.([agentEntry("paused")], eventCtx(s.db));
  const before = s.events.length;
  assert.equal(await runDueBuzzPosts(s.db, relayFor(s), s.ctx.log, ALLOW, Date.now() + 61_000), 0);
  assert.equal(s.events.length, before, "nothing reached the relay");
  assert.deepEqual(statusOf(s, a.id), { status: "cancelled", detail: "Not sent: the agent was paused when the post was due." });
  // resumed later: a new post goes out again (the alarm is not stuck on)
  await s.app.events?.agentsChanged?.([agentEntry("active")], eventCtx(s.db));
  const b = await schedule(s, "after resume");
  assert.equal(await runDueBuzzPosts(s.db, relayFor(s), s.ctx.log, ALLOW, Date.now() + 61_000), 1);
  assert.equal(statusOf(s, b.id).status, "sent");
});

test("CON-01 fires: agentRemoved (or an edge revoke, or leaving the slice while down) cancels the agent's scheduled posts", async () => {
  const s = await setup();
  const a = await schedule(s, "removed");
  await s.app.events?.agentRemoved?.(agentEntry("active"), eventCtx(s.db));
  assert.deepEqual(statusOf(s, a.id), { status: "cancelled", detail: "Not sent: the agent was removed from Connect." });

  const t = await setup();
  const b = await schedule(t, "left the slice");
  await t.app.events?.agentsChanged?.([], eventCtx(t.db));
  assert.equal(statusOf(t, b.id).status, "cancelled");
  assert.equal(await runDueBuzzPosts(t.db, relayFor(t), t.ctx.log, ALLOW, Date.now() + 61_000), 0);

  // a row whose agent vanished without any event is still refused at send time
  const u = await setup();
  const c = await schedule(u, "no agent row");
  u.db.prepare("DELETE FROM connect_agents").run();
  assert.equal(await runDueBuzzPosts(u.db, relayFor(u), u.ctx.log, ALLOW, Date.now() + 61_000), 0);
  assert.equal(statusOf(u, c.id).detail, "Not sent: the agent is no longer connected to Connect.");
});

test("CON-01 fires: a key rotation cancels waiting posts; a crash mid-send is reported failed, never `sent` or re-sent", async () => {
  const s = await setup();
  const a = await schedule(s, "old key");
  await handlerOf(s.app, "buzz_identity_rotate")({ agent: AGENT }, testCtx({ db: s.db, person: true }));
  assert.equal(statusOf(s, a.id).status, "cancelled");

  const b = await schedule(s, "crash");
  // simulate a process that claimed the row and died before the relay answered
  s.db.prepare("UPDATE connect_buzz_scheduled SET status = 'sending', claimed_at = ? WHERE id = ?").run(Date.now() - 11 * 60_000, b.id);
  const before = s.events.length;
  assert.equal(await runDueBuzzPosts(s.db, relayFor(s), s.ctx.log, ALLOW, Date.now() + 61_000), 0);
  assert.equal(statusOf(s, b.id).status, "failed");
  assert.match(statusOf(s, b.id).detail, /may not have gone out/u);
  assert.equal(s.events.length, before, "not re-sent");
  // a fresh `sending` row (another tick still posting) is left alone
  const c = await schedule(s, "in flight");
  s.db.prepare("UPDATE connect_buzz_scheduled SET status = 'sending', claimed_at = ? WHERE id = ?").run(Date.now(), c.id);
  await runDueBuzzPosts(s.db, relayFor(s), s.ctx.log, ALLOW, Date.now() + 61_000);
  assert.equal(statusOf(s, c.id).status, "sending");
});

test("CON-01: at most 50 waiting scheduled posts per agent", async () => {
  const s = await setup();
  for (let n = 0; n < 50; n++) s.db.prepare("INSERT INTO connect_buzz_scheduled (id, agent, channel, content, send_at, status, created_at) VALUES (?, ?, ?, 'x', ?, 'scheduled', ?)").run(`bsp_${n}`, AGENT, CHANNEL, Date.now() + 3_600_000, Date.now());
  await assert.rejects(schedule(s, "one too many"), (e: ConnectError) => e.code === "buzz_schedule_limit");
  await handlerOf(s.app, "buzz_schedule_cancel")({ id: "bsp_0" }, s.ctx);
  await schedule(s, "fits again");
});
