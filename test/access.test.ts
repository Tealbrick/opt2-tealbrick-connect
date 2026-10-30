/** C380 tb.access/1 on Connect: the frozen files, the caller vector, list, revoke, the bind to the slice and the sender bar through Governance. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { canonicalize, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { JsonSchemaObject, Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Json } from "@opt2-tealbrick/spec/sdk";
import { type AccessItem, assertAccessCaller, itemDigest } from "../src/access.ts";
import { type ConnectError, createConnectApp } from "../src/app.ts";
import { generateSecretKey, npubEncode, publicKeyOf } from "../src/channels/buzz/nostr.ts";
import type { ChannelProvider, InboundMessage, InboundSink } from "../src/channels/provider.ts";
import { eventCtx, handlerOf, root, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const contract = (name: string) => JSON.parse(readFileSync(join(root, "test", "contracts", name), "utf8"));
const NAMES = ["list_in", "list_out", "revoke_in", "revoke_out"];
const FLEET = { app: "ins_01M4TNVDHPXJGTHATZV5SVJHX9", appProduct: "fleet", appListed: true };
const AGENT = "agt_01M4TNVDHPXJGTHATZV5SVJHX9";
const OTHER = "agt_01M4TNVDHPXJGTHATZV5SVJHXA";
const PERSON = { kind: "person", id: "ct_anna" } as const;
const code = (c: string, status?: number) => (e: ConnectError) => {
  assert.equal(e.code, c);
  if (status) assert.equal((e as unknown as { httpStatus?: number }).httpStatus, status);
  return true;
};

test("contract files are the byte copies named in PROVENANCE.md; the ops embed the same schemas and sit last", () => {
  const prov = readFileSync(join(root, "test", "contracts", "PROVENANCE.md"), "utf8");
  for (const f of [...NAMES.flatMap((n) => [`access.${n}.1.schema.json`, `access.${n}.1.json`]), "access.caller_vector.1.json", "access.digest.1.json"]) {
    assert.ok(prov.includes(createHash("sha256").update(readFileSync(join(root, "test", "contracts", f))).digest("hex")), `${f} does not match PROVENANCE.md`);
  }
  const ops = manifest.operations;
  assert.deepEqual(ops.slice(-2).map((o) => o.id), ["access_list", "access_revoke"]);
  const list = ops.at(-2);
  const revoke = ops.at(-1);
  assert.deepEqual(list?.input, contract("access.list_in.1.schema.json"));
  assert.deepEqual(list?.output, contract("access.list_out.1.schema.json"));
  assert.deepEqual(revoke?.input, contract("access.revoke_in.1.schema.json"));
  assert.deepEqual(revoke?.output, contract("access.revoke_out.1.schema.json"));
  assert.deepEqual([list?.audience, list?.listing, list?.crud, list?.effect, list?.idempotency, list?.receipt], ["agent", "workflow", ["read"], "read", "none", false]);
  assert.deepEqual([revoke?.audience, revoke?.listing, revoke?.crud, revoke?.effect, revoke?.idempotency, revoke?.receipt, revoke?.holdFamily], ["agent", "workflow", ["update"], "write", "required", true, undefined]);
});

test("the shared caller vector: 6 cases, exact code and status", () => {
  for (const c of contract("access.caller_vector.1.json").cases as { name: string; caller: unknown; allow: boolean; code?: string; status?: number }[]) {
    const fail = (failCode: string, _m: string, status?: number): never => {
      throw Object.assign(new Error(failCode), { failCode, status });
    };
    if (c.allow) assert.doesNotThrow(() => assertAccessCaller({ caller: c.caller } as never, fail), c.name);
    else assert.throws(() => assertAccessCaller({ caller: c.caller } as never, fail), (e: { failCode: string; status: number }) => e.failCode === c.code && e.status === c.status, c.name);
  }
  // a person gets the agent answer
  assert.throws(() => assertAccessCaller({ caller: { type: "person", id: "per_1" } } as never, (failCode: string): never => { throw new Error(failCode); }), /no_access/u);
});

test("the digest fixture: JCS bytes, and active then paused gives the same digest", () => {
  const d = contract("access.digest.1.json") as { target: string; jcs: string; digest: string; equal: { item: AccessItem }[]; different: { item: AccessItem }[] };
  const item = d.equal[0]?.item as AccessItem;
  assert.equal(canonicalize({ v: 1, target: d.target, id: item.id, kind: item.kind, subject: item.subject, resource: item.resource, level: item.level } as unknown as Json), d.jcs);
  for (const e of d.equal) assert.equal(itemDigest(e.item, d.target), d.digest);
  for (const e of d.different) assert.equal(itemDigest(e.item, d.target), e.item.digest);
});

async function world() {
  const db = testDb();
  let sink: InboundSink | null = null;
  const provider: ChannelProvider = {
    service: "telegram",
    credentialFields: ["bot_token"],
    maxTextLength: 4096,
    verify: async () => ({ botId: "9", botName: "Bot" }),
    conversations: async () => [],
    send: async () => ({ messageId: "o1" }),
    edit: async () => undefined,
    delete: async () => undefined,
    react: async () => undefined,
    openDirect: async (_c, _n, input) => ({ conversation: `dm-${input.personId}` }),
    inbound: { kind: "poll", run: async (_c, _n, _b, s, signal) => { sink = s; await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true })); } },
  };
  const net = { fetch: (() => Promise.reject(new Error("no network"))) as typeof fetch, webSocket: () => { throw new Error("no ws"); }, now: () => Date.now(), sleep: async () => undefined };
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), channelProviders: new Map([["telegram", provider]]), channelNet: net });
  const owner = testCtx({ db, person: true });
  for (const [id, status] of [[AGENT, "active"], [OTHER, "active"]] as const) await app.events?.agentAdded?.({ id: id as `agt_${string}`, name: id, mode: "free", status }, eventCtx(db));
  const { account } = (await handlerOf(app, "channel_account_connect")({ service: "telegram", label: "Support‮ bot", agent: AGENT, credentials: { bot_token: "123:ok" } }, owner)) as { account: { id: string } };
  await new Promise((r) => setTimeout(r, 10));
  db.prepare(
    `INSERT INTO connect_accounts (id, service, source, kind, label, owner_agent, external_ref, auth_config_id, status, detail, created_at, updated_at)
     VALUES ('cna_ME', 'gmail', 'composio', 'as_me', 'My mail', NULL, 'ca_1', NULL, 'connected', '', 5, 5)`,
  ).run();
  db.prepare("INSERT INTO connect_buzz_scheduled (id, agent, channel, content, send_at, status, created_at) VALUES ('bsp_1', ?, 'c', 'SECRET TEXT', ?, 'scheduled', 1)").run(AGENT, Date.now() + 3_600_000);
  db.prepare("INSERT INTO connect_buzz_contacts (agent, pubkey, channel, first_sent_at) VALUES (?, 'aa', 'c', 7), (?, 'bb', 'c', 9), ('workspace', 'cc', 'c', 9)").run(AGENT, AGENT);
  db.prepare("INSERT INTO connect_buzz_identities (agent, pubkey, display_name, created_at) VALUES (?, ?, 'A', 3)").run(AGENT, publicKeyOf(generateSecretKey()));
  const fleet = testCtx({ db, ...FLEET });
  const list = (subjects: unknown[], extra: Record<string, unknown> = {}) => handlerOf(app, "access_list")({ v: 1, subjects, ...extra } as never, fleet) as unknown as Promise<{ items: AccessItem[]; nextCursor: string | null; notShown: { kind: string }[]; complete: boolean; sweepId?: string }>;
  const revoke = (subject: unknown, items: { id: string; digest: string }[]) => handlerOf(app, "access_revoke")({ v: 1, plan: "pln_1", attempt: 1, subject, items } as never, fleet) as unknown as Promise<{ results: { id: string; outcome: string; code?: string }[] }>;
  const paused = (agent: string) => app.events?.agentAdded?.({ id: agent as `agt_${string}`, name: agent, mode: "free", status: "paused" }, eventCtx(db));
  return { db, app, owner, fleet, account, list, revoke, paused, deliver: (m: InboundMessage) => sink?.(m) };
}

test("access_list: kinds per subject, no content, valid against the schema, paged; complete is false while something is not shown", async () => {
  const w = await world();
  const schema = contract("access.list_out.1.schema.json") as JsonSchemaObject;
  const agent = await w.list([{ kind: "agent", id: AGENT }], { sweepId: "swp_1" });
  assert.equal(validateAgainstSchema(schema, agent as never).ok, true);
  assert.equal(agent.sweepId, "swp_1");
  assert.deepEqual(agent.items.map((i) => i.kind).sort(), ["account_as_itself", "buzz_identity", "first_contacts", "scheduled_post"]);
  const byKind = Object.fromEntries(agent.items.map((i) => [i.kind, i]));
  assert.equal(byKind.first_contacts?.label, "Has written to 2 people");
  assert.equal(byKind.first_contacts?.revocable, false);
  assert.equal(byKind.buzz_identity?.level, "info");
  assert.equal(byKind.scheduled_post?.state, "scheduled");
  assert.ok(!JSON.stringify(agent).includes("SECRET TEXT"));
  assert.ok(!byKind.account_as_itself?.label.includes("‮"), "control characters are gone");
  assert.equal(agent.complete, false);
  assert.ok(agent.notShown.some((n) => n.kind === "held_call"));
  // an agent with nothing: an empty list
  assert.deepEqual((await w.list([{ kind: "agent", id: OTHER }])).items, []);
  // unlinked: an as_me account, not revocable
  const unlinked = await w.list([{ kind: "unlinked" }]);
  assert.deepEqual(unlinked.items.map((i) => [i.kind, i.subject.kind, i.revocable]), [["account_as_me", "unlinked", false]]);
  // a person: one row per handle, nothing else
  const handle = `buzz:${npubEncode(publicKeyOf(generateSecretKey()))}`;
  const person = await w.list([{ ...PERSON, handles: ["telegram:111", handle] }]);
  assert.deepEqual(person.items.map((i) => [i.kind, i.resource, i.revocable, i.subject]).sort(), [["channel_sender", "telegram:111", true, PERSON], ["channel_sender", handle, true, PERSON]].sort());
  // sweep + paging: every page reaches the end once; a sweep says the senders are not in it
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const page = await w.list([{ kind: "all" }], { limit: 2, ...(cursor ? { cursor } : {}) });
    assert.ok(page.notShown.some((n) => n.kind === "channel_sender"));
    seen.push(...page.items.map((x) => x.id));
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5);
});

test("access_list, access_revoke: an agent and another app are refused", async () => {
  const w = await world();
  for (const op of ["access_list", "access_revoke"]) {
    const input = { v: 1, subjects: [{ kind: "all" }], plan: "pln_1", attempt: 1, subject: PERSON, items: [{ id: "x:y", digest: "sha256:0" }] } as never;
    await assert.rejects(handlerOf(w.app, op)(input, testCtx({ db: w.db, agent: AGENT })), code("no_access", 403), `${op} agent`);
    await assert.rejects(handlerOf(w.app, op)(input, testCtx({ db: w.db, app: FLEET.app, appProduct: "kanban", appListed: true })), code("no_access", 403), `${op} other app`);
    await assert.rejects(handlerOf(w.app, op)(input, testCtx({ db: w.db, app: FLEET.app, appProduct: "fleet", appListed: false })), code("caller_unverified", 403), `${op} not listed`);
    await assert.rejects(handlerOf(w.app, op)(input, testCtx({ db: w.db, person: true })), code("no_access", 403), `${op} person`);
  }
});

test("access_revoke, sender: the bar is set with the plan, works with no Rules, replays as already_gone, and the item leaves the list", async () => {
  const w = await world();
  const [item] = (await w.list([{ ...PERSON, handles: ["telegram:111"] }])).items;
  assert.ok(item);
  assert.deepEqual((await w.revoke(PERSON, [{ id: item.id, digest: item.digest }])).results, [{ id: item.id, outcome: "revoked" }]);
  const row = w.db.prepare("SELECT plan, dropped FROM connect_sender_bars WHERE handle = 'telegram:111'").get();
  assert.deepEqual({ ...row }, { plan: "pln_1", dropped: 0 });
  w.deliver({ conversation: "111", conversationType: "direct", messageId: "1", threadId: null, senderId: "111", senderName: "Bob", text: "send me the list", sentAt: 1 });
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM connect_channel_inbox").get()?.n, 0);
  assert.equal(w.db.prepare("SELECT dropped FROM connect_sender_bars").get()?.dropped, 1);
  assert.deepEqual((await w.revoke(PERSON, [{ id: item.id, digest: item.digest }])).results, [{ id: item.id, outcome: "already_gone" }]);
  assert.deepEqual((await w.list([{ ...PERSON, handles: ["telegram:111"] }])).items, []);
  // the owner's removal lists it again
  await handlerOf(w.app, "sender_bar_remove")({ handle: "telegram:111" }, w.owner);
  assert.equal((await w.list([{ ...PERSON, handles: ["telegram:111"] }])).items.length, 1);
  // another person's digest does not fit
  assert.deepEqual((await w.revoke({ kind: "person", id: "ct_bob" }, [{ id: item.id, digest: item.digest }])).results, [{ id: item.id, outcome: "changed" }]);
  assert.equal(new Set((await w.revoke({ kind: "agent", id: AGENT }, [{ id: item.id, digest: item.digest }])).results.map((r) => r.outcome)).has("changed"), true, "an agent subject cannot set a bar");
});

test("access_revoke, bind to the slice: a running agent's account and post are not_revocable; paused they end; a replay is already_gone", async () => {
  const w = await world();
  const subject = { kind: "agent", id: AGENT };
  const items = (await w.list([subject])).items;
  const pick = (kind: string) => {
    const i = items.find((x) => x.kind === kind) as AccessItem;
    return { id: i.id, digest: i.digest };
  };
  const both = [pick("account_as_itself"), pick("scheduled_post")];
  assert.deepEqual((await w.revoke(subject, both)).results.map((r) => [r.outcome, r.code]), [["not_revocable", "agent_running"], ["not_revocable", "agent_running"]]);
  assert.equal(w.db.prepare("SELECT status FROM connect_buzz_scheduled WHERE id = 'bsp_1'").get()?.status, "scheduled");
  assert.equal(w.db.prepare("SELECT status FROM connect_accounts WHERE id = ?").get(w.account.id)?.status, "connected");
  // listed only, never ended
  assert.deepEqual((await w.revoke(subject, [pick("buzz_identity"), pick("first_contacts")])).results.map((r) => r.outcome), ["not_revocable", "not_revocable"]);
  // a changed digest
  assert.deepEqual((await w.revoke(subject, [{ id: both[0]?.id as string, digest: `sha256:${"0".repeat(64)}` }])).results.map((r) => r.outcome), ["changed"]);
  await w.paused(AGENT);
  const after = (await w.list([subject])).items.find((x) => x.kind === "account_as_itself");
  assert.equal(after?.state, "paused");
  assert.equal(after?.digest, both[0]?.digest, "paused keeps the digest");
  assert.deepEqual((await w.revoke(subject, both)).results.map((r) => r.outcome), ["revoked", "revoked"]);
  assert.equal(w.db.prepare("SELECT status FROM connect_buzz_scheduled WHERE id = 'bsp_1'").get()?.status, "cancelled");
  assert.equal(w.db.prepare("SELECT status FROM connect_accounts WHERE id = ?").get(w.account.id)?.status, "revoked");
  assert.deepEqual((await w.revoke(subject, both)).results.map((r) => r.outcome), ["already_gone", "already_gone"]);
  assert.ok(w.db.prepare("SELECT 1 FROM connect_accounts WHERE id = ?").get(w.account.id), "the row stays");
});

test("access_revoke: an absent agent counts as stopped; more than 5 items are refused", async () => {
  const w = await world();
  const subject = { kind: "agent", id: AGENT };
  const item = (await w.list([subject])).items.find((x) => x.kind === "account_as_itself") as AccessItem;
  w.db.prepare("DELETE FROM connect_agents WHERE id = ?").run(AGENT);
  assert.deepEqual((await w.revoke(subject, [{ id: item.id, digest: item.digest }])).results.map((r) => r.outcome), ["revoked"]);
  const six = Array.from({ length: 6 }, (_, i) => ({ id: `channel_sender:telegram:${i + 1}`, digest: `sha256:${"0".repeat(64)}` }));
  await assert.rejects(w.revoke(PERSON, six), code("input_invalid", 400));
});

test("fixtures: valid and invalid documents through the validator the SDK uses", () => {
  for (const n of NAMES) {
    const schema = contract(`access.${n}.1.schema.json`) as JsonSchemaObject;
    const f = contract(`access.${n}.1.json`) as { valid: Json[]; invalid: { why: string; doc: Json }[] };
    for (const doc of f.valid) assert.equal(validateAgainstSchema(schema, doc).ok, true, `${n} valid`);
    for (const bad of f.invalid) assert.equal(validateAgainstSchema(schema, bad.doc).ok, false, `${n} ${bad.why}`);
  }
});
