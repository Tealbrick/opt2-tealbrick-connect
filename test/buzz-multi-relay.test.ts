/** C73 Buzz multi-relay: relay list + migration, per-agent subset, publish to all with partial failure, read dedupe. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { schnorr } from "@noble/curves/secp256k1.js";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Json } from "@opt2-tealbrick/spec/sdk";

import { type ConnectError, createConnectApp, runDueBuzzPosts } from "../src/app.ts";
import { BuzzIdentities } from "../src/channels/buzz/identity.ts";
import { eventId, generateSecretKey, type NostrEvent, npubEncode, publicKeyOf, signEvent, verifyEvent } from "../src/channels/buzz/nostr.ts";
import { BuzzRelay } from "../src/channels/buzz/relay.ts";
import { MAX_RELAYS, normalizeRelayUrl, OLD_RELAY_SETTING_PROBLEM, type RelayOutcome, workspaceRelayList } from "../src/channels/buzz/relays.ts";
import { eventCtx, handlerOf, root, secretsFor, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const CHANNEL = "0b7d6c2e-1f3a-4c5b-9d8e-7f6a5b4c3d2e";
const AGENT = "agt_01MULTIRELAY00000000000000";
const A = "wss://relay-a.test.example";
const B = "wss://relay-b.test.example";
const C = "wss://relay-c.test.example";
const ORIGINS = [A, B, C].flatMap((r) => [r, r.replace("wss:", "https:")]);
const human = generateSecretKey();

type Mode = "ok" | "down" | "reject" | "not_member";
/** Several fake relays keyed by host: records events, answers queries from a per-relay store. */
function relays(modes: Record<string, Mode> = {}) {
  const events: Record<string, NostrEvent[]> = {};
  const stored: Record<string, NostrEvent[]> = {};
  const dmChannel: Record<string, string> = {};
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const relay = `wss://${url.host}`;
    const mode = modes[relay] ?? "ok";
    if (mode === "down") return new Response("bad gateway", { status: 502 });
    const body = JSON.parse(String(init?.body ?? "null")) as unknown;
    if (url.pathname === "/events") {
      if (mode === "not_member") return Response.json({ error: "restricted: not a channel member" }, { status: 400 });
      if (mode === "reject") return Response.json({ accepted: false, message: "blocked: spam" });
      const event = body as NostrEvent;
      assert.equal(verifyEvent(event), true);
      events[relay] = [...(events[relay] ?? []), event];
      const channel = dmChannel[relay] ?? CHANNEL;
      return Response.json(event.kind === 41010 ? { accepted: true, message: `response:${JSON.stringify({ channel_id: channel })}` } : { accepted: true, message: "" });
    }
    if (url.pathname === "/query") return Response.json(stored[relay] ?? []);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { impl, events, stored, dmChannel, modes };
}

async function app(input: { relays?: string; oldSetting?: boolean; modes?: Record<string, Mode> }) {
  const net = relays(input.modes);
  const db = testDb();
  const connect = createConnectApp({
    manifest,
    migrationsDir: join(root, "migrations"),
    fetchImpl: net.impl,
    allowRelayOrigins: ORIGINS,
    ...(input.relays !== undefined ? { buzzRelays: input.relays } : {}),
    ...(input.oldSetting !== undefined ? { oldBuzzRelaySettingPresent: input.oldSetting } : {}),
  });
  await connect.events?.agentAdded?.({ id: AGENT as `agt_${string}`, name: "Multi", mode: "free", status: "active" }, eventCtx(db));
  await handlerOf(connect, "buzz_identities_generate")({}, testCtx({ db, person: true }));
  const call = (op: string, body: Json) => handlerOf(connect, op)(body, testCtx({ db, agent: AGENT }));
  const owner = (op: string, body: Json) => handlerOf(connect, op)(body, testCtx({ db, person: true }));
  return { db, connect, net, call, owner };
}

test("relay list: normalised, deduplicated, ordered, max 8; only the list is read (C133)", () => {
  const list = workspaceRelayList({ list: `wss://a.example.com\nwss://OLD.example.com, wss://b.example.com:444 ; wss://a.example.com/` });
  assert.deepEqual(list.relays, ["wss://a.example.com", "wss://old.example.com", "wss://b.example.com:444"]);
  assert.deepEqual(list.problems, []);
  const many = workspaceRelayList({ list: Array.from({ length: 10 }, (_, i) => `wss://r${i}.example.com`).join(" ") });
  assert.equal(many.relays.length, MAX_RELAYS);
  assert.equal(many.problems.length, 2);
  assert.match(many.problems[0] ?? "", /at most 8/u);
  // C133: the removed old setting is never a relay; its presence is a clear owner-facing problem.
  const old = workspaceRelayList({ oldSettingPresent: true });
  assert.deepEqual(old.relays, []);
  assert.deepEqual(old.problems, [OLD_RELAY_SETTING_PROBLEM]);
  assert.deepEqual(workspaceRelayList({ list: "wss://a.example.com", oldSettingPresent: true }).relays, ["wss://a.example.com"]);
  assert.deepEqual(workspaceRelayList({}).relays, []);
  assert.deepEqual(workspaceRelayList({}).problems, []);
});

test("relay URL safety: wss only; loopback, private, link-local and local names refused unless allowlisted", () => {
  for (const bad of ["ws://relay.example.com", "https://relay.example.com", "wss://relay.example.com/x", "wss://u:p@relay.example.com", "wss://relay.example.com?q=1"]) {
    assert.throws(() => normalizeRelayUrl(bad), /relay_url_invalid/u, bad);
  }
  for (const bad of ["wss://127.0.0.1", "wss://10.1.2.3:7777", "wss://169.254.169.254", "wss://[::1]", "wss://[fd00::1]", "wss://localhost", "wss://relay.railway.internal", "wss://relay"]) {
    assert.throws(() => normalizeRelayUrl(bad), /relay_host_not_allowed/u, bad);
  }
  assert.equal(normalizeRelayUrl("ws://127.0.0.1:3000", ["ws://127.0.0.1:3000"]), "ws://127.0.0.1:3000");
  const list = workspaceRelayList({ list: "wss://10.0.0.5 wss://ok.example.com garbage" });
  assert.deepEqual(list.relays, ["wss://ok.example.com"]);
  assert.equal(list.problems.length, 2);
  assert.match(list.problems[0] ?? "", /private, loopback/u);
});

test("C133 at app level: only the old setting → clear refusal + owner problem; with the list it runs and still warns", async () => {
  const old = await app({ oldSetting: true });
  await assert.rejects(old.call("buzz_read", { channel: CHANNEL }), (e: { code?: string; message?: string }) => e.code === "buzz_relay_setting_removed" && /buzz_relay_url/u.test(e.message ?? ""));
  const oldList = (await old.owner("buzz_identities_list", {})) as { relay: string | null; relays: string[]; relayProblems: string[] };
  assert.equal(oldList.relay, null);
  assert.deepEqual(oldList.relays, []);
  assert.deepEqual(oldList.relayProblems, [OLD_RELAY_SETTING_PROBLEM]);
  const none = await app({});
  await assert.rejects(none.call("buzz_read", { channel: CHANNEL }), (e: { code?: string }) => e.code === "buzz_relay_missing");
  const both = await app({ oldSetting: true, relays: `${B}\n${A}` });
  const listed = (await both.owner("buzz_identities_list", {})) as { relay: string; relays: string[]; relayProblems: string[]; agents: { relays: string[] | null }[] };
  assert.equal(listed.relay, B);
  assert.deepEqual(listed.relays, [B, A]);
  assert.deepEqual(listed.relayProblems, [OLD_RELAY_SETTING_PROBLEM]);
  assert.equal(listed.agents[0]?.relays, null);
});

test("publish goes to every relay with the same event id; one relay down is reported, not fatal", async () => {
  const s = await app({ relays: [A, B, C].join("\n"), modes: { [B]: "down" } });
  const out = (await s.call("buzz_post", { channel: CHANNEL, content: "hello all" })) as { id: string; relays: RelayOutcome[] };
  assert.equal(s.net.events[A]?.[0]?.id, out.id);
  assert.equal(s.net.events[C]?.[0]?.id, out.id);
  assert.equal(s.net.events[B], undefined);
  assert.deepEqual(out.relays.map((r) => [r.relay, r.ok]), [[A, true], [B, false], [C, true]]);
  const failed = out.relays[1] as Extract<RelayOutcome, { ok: false }>;
  assert.equal(failed.error, "upstream_error");
  // react / edit / delete fan out the same way
  const edit = (await s.call("buzz_edit", { channel: CHANNEL, messageId: out.id, content: "edited" })) as { relays: RelayOutcome[] };
  assert.deepEqual(edit.relays.map((r) => r.ok), [true, false, true]);
  const react = (await s.call("buzz_react", { channel: CHANNEL, messageId: out.id, emoji: "+" })) as { relays: RelayOutcome[] };
  assert.equal(react.relays.filter((r) => r.ok).length, 2);
});

test("no relay accepts → the op fails and names the relays; same refusal everywhere keeps its code", async () => {
  const mixed = await app({ relays: `${A}\n${B}`, modes: { [A]: "down", [B]: "reject" } });
  await assert.rejects(mixed.call("buzz_post", { channel: CHANNEL, content: "x" }), (e: ConnectError) => e.code === "buzz_relays_failed" && e.message.includes(A) && e.message.includes(B));
  const members = await app({ relays: `${A}\n${B}`, modes: { [A]: "not_member", [B]: "not_member" } });
  await assert.rejects(members.call("buzz_post", { channel: CHANNEL, content: "x" }), (e: ConnectError) => e.code === "buzz_not_member" && e.httpStatus === 403);
  // single relay keeps the old single-relay error
  const one = await app({ relays: A, modes: { [A]: "reject" } });
  await assert.rejects(one.call("buzz_post", { channel: CHANNEL, content: "x" }), (e: ConnectError) => e.code === "buzz_rejected");
  // a relay that answers but refuses membership while another accepts: partial, reported as buzz_not_member
  const partial = await app({ relays: `${A}\n${B}`, modes: { [B]: "not_member" } });
  const out = (await partial.call("buzz_post", { channel: CHANNEL, content: "x" })) as { relays: RelayOutcome[] };
  assert.deepEqual(out.relays[1], { relay: B, ok: false, error: "buzz_not_member", detail: (out.relays[1] as { detail: string }).detail });
});

test("read merges all relays and dedupes by event id; a down relay is reported", async () => {
  const s = await app({ relays: [A, B, C].join("\n"), modes: { [C]: "down" } });
  const shared = signEvent(human, { kind: 9, created_at: 100, tags: [["h", CHANNEL]], content: "on both" });
  const onlyA = signEvent(human, { kind: 9, created_at: 101, tags: [["h", CHANNEL]], content: "only A" });
  const onlyB = signEvent(human, { kind: 9, created_at: 99, tags: [["h", CHANNEL]], content: "only B" });
  s.net.stored[A] = [shared, onlyA];
  s.net.stored[B] = [onlyB, shared, { ...shared, content: "forged" }];
  const out = (await s.call("buzz_read", { channel: CHANNEL })) as { messages: { id: string; content: string }[]; relays: RelayOutcome[]; untrusted: boolean };
  assert.deepEqual(out.messages.map((m) => m.content), ["only B", "on both", "only A"]);
  assert.equal(new Set(out.messages.map((m) => m.id)).size, 3);
  assert.deepEqual(out.relays.map((r) => r.ok), [true, true, false]);
  assert.equal(out.untrusted, true);
});

test("channels: union over relays, each channel lists the relays it is on", async () => {
  const net = relays();
  const db = testDb();
  const ids = new BuzzIdentities({ db, secrets: secretsFor(db), relayUrls: `${A}\n${B}`, allowRelayOrigins: ORIGINS });
  const [me] = (await ids.generateAll([{ id: "agt_X", name: "X" }])).created;
  assert.ok(me);
  const relayKey = generateSecretKey();
  // kinds 39000/39002 are relay-signed (outside Connect's allowlist), so sign by hand
  const signed = (kind: number, tags: string[][]) => relaySign(relayKey, kind, tags);
  const other = "1c8e7d3f-2a4b-4d6c-8e9f-0a1b2c3d4e5f";
  const shared = [signed(39002, [["d", CHANNEL], ["p", me.pubkey]]), signed(39000, [["d", CHANNEL], ["name", "general"]])];
  net.stored[A] = shared;
  net.stored[B] = [...shared, signed(39002, [["d", other], ["p", me.pubkey]]), signed(39000, [["d", other], ["name", "b-only"]])];
  const out = await new BuzzRelay(ids, net.impl).channels("agt_X");
  assert.deepEqual(out.channels.map((c) => [c.name, c.relays]), [["b-only", [B]], ["general", [A, B]]]);
});

test("per-agent subset: owner limits the agent; publish only there; agent may narrow but not widen", async () => {
  const s = await app({ relays: [A, B, C].join("\n") });
  await assert.rejects(s.owner("buzz_agent_relays_set", { agent: AGENT, relays: ["wss://elsewhere.example.com"] }), (e: ConnectError) => e.code === "buzz_relay_unknown");
  await assert.rejects(s.owner("buzz_agent_relays_set", { agent: AGENT, relays: [] }), (e: ConnectError) => e.code === "buzz_relays_empty");
  const set = (await s.owner("buzz_agent_relays_set", { agent: AGENT, relays: [`${C}/`, A] })) as { relays: string[] };
  assert.deepEqual(set.relays, [A, C]);
  assert.deepEqual(((await s.call("buzz_identity", {})) as { relays: string[] }).relays, [A, C]);
  const out = (await s.call("buzz_post", { channel: CHANNEL, content: "subset" })) as { relays: RelayOutcome[] };
  assert.deepEqual(out.relays.map((r) => r.relay), [A, C]);
  assert.equal(s.net.events[B], undefined);
  const narrow = (await s.call("buzz_post", { channel: CHANNEL, content: "narrow", relays: [C] })) as { relays: RelayOutcome[] };
  assert.deepEqual(narrow.relays.map((r) => r.relay), [C]);
  await assert.rejects(s.call("buzz_post", { channel: CHANNEL, content: "wider", relays: [B] }), (e: ConnectError) => e.code === "buzz_relay_not_allowed");
  const listed = (await s.owner("buzz_identities_list", {})) as { agents: { relays: string[] | null }[] };
  assert.deepEqual(listed.agents[0]?.relays, [A, C]);
  // back to all relays
  await s.owner("buzz_agent_relays_set", { agent: AGENT, relays: null });
  assert.deepEqual(((await s.call("buzz_identity", {})) as { relays: string[] }).relays, [A, B, C]);
});

test("subset that no longer matches the workspace list refuses instead of widening", async () => {
  const db = testDb();
  const before = new BuzzIdentities({ db, secrets: secretsFor(db), relayUrls: `${A}\n${B}`, allowRelayOrigins: ORIGINS });
  await before.generateAll([{ id: "agt_Y", name: "Y" }]);
  before.setAgentRelays("agt_Y", [B]);
  const after = new BuzzIdentities({ db, secrets: secretsFor(db), relayUrls: A, allowRelayOrigins: ORIGINS });
  assert.throws(() => after.relaysFor("agt_Y"), (e: ConnectError) => e.code === "buzz_relays_none_selected");
  const none = new BuzzIdentities({ db, secrets: secretsFor(db), allowRelayOrigins: ORIGINS });
  assert.throws(() => none.relaysFor("agt_Y"), (e: ConnectError) => e.code === "buzz_relay_missing");
});

test("DM: conversation opened on every relay; per-relay channel ids; every sent message is an own message", async () => {
  const s = await app({ relays: `${A}\n${B}` });
  const otherChannel = "7e7d6c2e-1f3a-4c5b-9d8e-7f6a5b4c3d2e";
  s.net.dmChannel[B] = otherChannel;
  const person = npubEncode(publicKeyOf(generateSecretKey()));
  const out = (await s.call("buzz_dm_first", { to: person, content: "hi on two relays" })) as { id: string; channel: string; relays: (RelayOutcome & { channel?: string; id?: string })[] };
  assert.equal(out.channel, CHANNEL);
  assert.deepEqual(out.relays.map((r) => [r.relay, r.ok, r.channel]), [[A, true, CHANNEL], [B, true, otherChannel]]);
  const bMessage = s.net.events[B]?.find((e) => e.kind === 9);
  assert.ok(bMessage);
  assert.notEqual(bMessage.id, out.id);
  // both message ids are recorded as the agent's own (edit/delete allowed)
  await s.call("buzz_edit", { channel: otherChannel, messageId: bMessage.id, content: "edit on B" });
  const later = (await s.call("buzz_dm", { to: person, content: "again" })) as { relays: RelayOutcome[] };
  assert.equal(later.relays.length, 2);
});

test("profiles publish to every relay of each agent; scheduled posts keep the agent's relay choice", async () => {
  const s = await app({ relays: `${A}\n${B}`, modes: { [B]: "down" } });
  const out = (await s.owner("buzz_profile_publish", {})) as { published: { relays: RelayOutcome[]; profilePublishedAt: number | null }[]; failed: unknown[] };
  assert.equal(out.failed.length, 0);
  assert.deepEqual(out.published[0]?.relays.map((r) => r.ok), [true, false]);
  assert.ok(out.published[0]?.profilePublishedAt);
  assert.equal(s.net.events[A]?.[0]?.kind, 0);

  s.net.modes[B] = "ok";
  await s.call("buzz_schedule", { channel: CHANNEL, content: "later on B", sendAt: new Date(Date.now() + 60_000).toISOString(), relays: [B] });
  await s.call("buzz_schedule", { channel: CHANNEL, content: "later on all", sendAt: new Date(Date.now() + 60_000).toISOString() });
  const relay = new BuzzRelay(new BuzzIdentities({ db: s.db, secrets: secretsFor(s.db), relayUrls: `${A}\n${B}`, allowRelayOrigins: ORIGINS }), s.net.impl);
  assert.equal(await runDueBuzzPosts(s.db, relay, testCtx({ db: s.db }).log, async () => ({ decision: "run" }), Date.now() + 61_000), 2);
  assert.deepEqual(s.net.events[A]?.filter((e) => e.kind === 9).map((e) => e.content), ["later on all"]);
  assert.deepEqual(s.net.events[B]?.filter((e) => e.kind === 9).map((e) => e.content).sort(), ["later on B", "later on all"].sort());
});

test("manifest: relay list setting + env, old single-relay setting removed (C133), relays argument on agent Buzz ops", () => {
  const fields = manifest.settings?.steps.flatMap((s) => s.fields) ?? [];
  assert.equal(fields.find((f) => f.key === "buzz_relays")?.type, "text");
  assert.equal(fields.find((f) => f.key === "buzz_relay_url"), undefined);
  const env = manifest.runtime.env ?? [];
  assert.ok(env.some((e) => e.name === "CONNECT_BUZZ_RELAYS" && e.setting === "buzz_relays"));
  assert.ok(!env.some((e) => e.name === "CONNECT_BUZZ_RELAY_URL" || e.setting === "buzz_relay_url"));
  for (const id of ["buzz_channels", "buzz_read", "buzz_post", "buzz_dm_first", "buzz_dm", "buzz_react", "buzz_edit", "buzz_delete", "buzz_schedule"]) {
    const op = manifest.operations.find((o) => o.id === id);
    assert.ok((op?.input as { properties?: Record<string, unknown> } | undefined)?.properties?.relays, `${id} has relays`);
  }
  assert.equal(manifest.operations.find((o) => o.id === "buzz_agent_relays_set")?.audience, "person");
});

function relaySign(key: string, kind: number, tags: string[][]): NostrEvent {
  const unsigned = { pubkey: publicKeyOf(key), created_at: 5, kind, tags, content: "" };
  const id = eventId(unsigned);
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, "hex"), Buffer.from(key, "hex"))).toString("hex");
  return { id, ...unsigned, sig };
}
