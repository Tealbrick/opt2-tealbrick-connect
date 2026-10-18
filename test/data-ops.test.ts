/**
 * C230 R3: the data_* op family (data_accounts_list, data_catalog, data_pull) with dataset `messages` (contract messages/1),
 * and the owner's per-app sharing (account_app_share). Real handlers, real SQLite, the real ChannelHub; only the chat
 * providers are fakes. Every pull answer is re-validated here against the vendored frozen schema (a second, independent
 * check next to the producer's own gate).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { JsonSchemaObject, Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Json, Logger } from "@opt2-tealbrick/spec/sdk";

import { AccountStore } from "../src/accounts.ts";
import { createConnectApp } from "../src/app.ts";
import type { ChannelNet, ChannelProvider, ChannelService, InboundMessage, InboundSink } from "../src/channels/provider.ts";
import { parseDiscordDeletes, parseDiscordMessage, parseDiscordUpdate } from "../src/channels/providers/discord.ts";
import { parseSlackEvent } from "../src/channels/providers/slack.ts";
import { parseTelegramUpdate } from "../src/channels/providers/telegram.ts";
import { ChannelHub, INBOX_RETENTION_MS } from "../src/channels/service.ts";
import { companionCallersFor, verifiedAppProduct } from "../src/data/caller.ts";
import { encodeCursor, pullMessages, RetryLater } from "../src/data/messages.ts";
import { DATA_APPS } from "../src/data/shares.ts";
import { eventCtx, handlerOf, memorySecrets, root, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const schema = JSON.parse(readFileSync(join(root, "test", "contracts", "messages.1.schema.json"), "utf8")) as JsonSchemaObject;
const AGENT = "agt_01DATAAGENT000000000000000";
const KNOWLEDGE = "ins_01KNOWLEDGE00000000000000";
const OBSERVER = "ins_01OBSERVER0000000000000000";
const ROGUE = "ins_01ROGUE00000000000000000000";
const UNVERIFIED = "ins_01UNVERIFIED00000000000000";
const T0 = 1_760_000_000_000;

type Row = { id: string; conversation: string; thread?: string; sentAt: string; editedAt?: string; deleted?: boolean; author: { kind: string; handle: string; display?: string }; text: string; attachments: { name: string; mime: string; bytes: number }[]; untrusted: true; truncated?: boolean; attachmentsTruncated?: boolean };
type Page = { rows: Row[]; nextCursor: string | null; anchor?: string; exhausted: boolean; retryAfterS?: number; schema: string; untrusted: boolean };

function fakeProvider(service: ChannelService, sinks: Map<string, InboundSink>, extra: Partial<ChannelProvider> = {}): ChannelProvider {
  return {
    service,
    credentialFields: ["bot_token"],
    maxTextLength: 4096,
    // like the real providers: Telegram reports no deletions
    reports: { edits: true, deletions: service !== "telegram" },
    verify: async (creds) => ({ botId: `BOT-${String(creds.bot_token)}`, botName: "Test bot" }),
    conversations: async () => [],
    send: async () => ({ messageId: "sent-1" }),
    edit: async () => undefined,
    delete: async () => undefined,
    react: async () => undefined,
    openDirect: async (_c, _n, input) => ({ conversation: `dm-${input.personId}` }),
    inbound: {
      kind: "poll",
      run: async (creds, _net, _bot, sink, signal) => {
        sinks.set(`${service}:${String(creds.bot_token)}`, sink);
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    },
    ...extra,
  };
}

const net: ChannelNet = { fetch: (() => Promise.reject(new Error("no network"))) as typeof fetch, webSocket: () => { throw new Error("no ws"); }, now: () => Date.now(), sleep: async () => undefined };

async function setup(options: { history?: ChannelService[]; services?: ChannelService[]; callers?: { product: string; ins: string; name: string; provider?: string | null }[] } = {}) {
  const sinks = new Map<string, InboundSink>();
  const services = options.services ?? ["telegram", "slack", "discord", "teams"];
  const providers = new Map<ChannelService, ChannelProvider>(services.map((s) => [s, fakeProvider(s, sinks, options.history?.includes(s) ? { readsHistory: true } : {})]));
  const db = testDb();
  const logs: { level: string; msg: string; fields?: Record<string, Json> }[] = [];
  const log: Logger = {
    debug() {},
    info: (msg, fields) => void logs.push({ level: "info", msg, ...(fields ? { fields } : {}) }),
    warn: (msg, fields) => void logs.push({ level: "warn", msg, ...(fields ? { fields } : {}) }),
    error: (msg, fields) => void logs.push({ level: "error", msg, ...(fields ? { fields } : {}) }),
  };
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), channelProviders: providers, channelNet: net });
  await app.events?.agentAdded?.({ id: AGENT as `agt_${string}`, name: "Agent", mode: "free", status: "active" }, eventCtx(db));
  const accounts = new AccountStore(db);
  const hub = new ChannelHub({ db, accounts, secrets: memorySecrets(), providers, net, log });
  // the owner's page sees the verified app instances that can call Connect (test double of miniapp-sdk 0.1.32
  // ctx.companionCallers, C240); a share binds the product AND the instance picked here
  const callers = options.callers ?? [
    { product: "knowledge", ins: KNOWLEDGE, name: "Knowledge", provider: "railway" },
    { product: "observer", ins: OBSERVER, name: "Observer", provider: "railway" },
  ];
  const person = testCtx({ db, person: true, log, companionCallers: callers });
  // app callers carry what the real SDK (>= 0.1.27) puts in ctx.caller.product: the product of the Portal-signed slice entry
  const knowledge = testCtx({ db, app: KNOWLEDGE, appName: "Knowledge", appProduct: "knowledge", log });
  const observer = testCtx({ db, app: OBSERVER, appName: "Observer", appProduct: "observer", log });
  const agent = testCtx({ db, agent: AGENT, access: {}, log });
  // an instance that carries the exact manifest name "Knowledge" but whose verified product is another one
  const rogue = testCtx({ db, app: ROGUE, appName: "Knowledge", appProduct: "rogue-app", log });
  // an app caller the slice does not list: no verified product at all (its name still says "Knowledge")
  const unverified = testCtx({ db, app: UNVERIFIED, appName: "Knowledge", log });
  const op = (name: string, input: Record<string, unknown>, ctx = person) => handlerOf(app, name)(input as Json, ctx);
  const connect = async (service: ChannelService, token: string, label = `${service} ${token}`): Promise<string> => {
    const out = (await op("channel_account_connect", { service, label, agent: AGENT, credentials: { bot_token: token } })) as unknown as { account: { id: string } };
    await new Promise((r) => setTimeout(r, 5));
    return out.account.id;
  };
  const instanceOf: Record<string, string> = { knowledge: KNOWLEDGE, observer: OBSERVER };
  const share = (account: string, product: string, level: string, includeHistory = true, instance: string | undefined = instanceOf[product]) =>
    op("account_app_share", { account, product, level, includeHistory, ...(level === "none" || instance === undefined ? {} : { instance }) });
  const msg = (n: number, extra: Partial<InboundMessage> = {}): InboundMessage => ({
    conversation: "chan-1",
    conversationName: "general",
    conversationType: "channel",
    messageId: `m${n}`,
    threadId: null,
    senderId: "123456789",
    senderName: "Anna",
    text: `message ${n}`,
    sentAt: T0 + n * 1000,
    ...extra,
  });
  const ingest = (accountId: string, ...messages: InboundMessage[]) => {
    const account = accounts.get(accountId) as NonNullable<ReturnType<AccountStore["get"]>>;
    for (const m of messages) hub.ingest(account, m);
  };
  const pull = async (account: string, input: Record<string, unknown> = {}, ctx = knowledge): Promise<Page> => {
    const page = (await op("data_pull", { account, dataset: "messages", ...input }, ctx)) as unknown as Page;
    assert.deepEqual(validateAgainstSchema(schema, page as unknown as Json), { ok: true }, "every page is valid messages/1");
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 2 * 1024 * 1024);
    return page;
  };
  return { db, app, hub, accounts, op, connect, share, ingest, msg, pull, logs, ctx: { person, knowledge, observer, agent, rogue, unverified } };
}

const tick = () => new Promise((r) => setTimeout(r, 3));
const shareSetAt = (db: ReturnType<typeof testDb>, account: string, product: string): number =>
  Number(db.prepare("SELECT set_at FROM connect_account_shares WHERE account_id = ? AND product = ?").get(account, product)?.set_at);

/** The whole refusal: code, status and message. */
async function refusal(p: Promise<unknown>): Promise<{ code: string; httpStatus: number; message: string }> {
  try {
    await p;
  } catch (e) {
    const { code, httpStatus, message } = e as { code: string; httpStatus: number; message: string };
    return { code, httpStatus, message };
  }
  throw new Error("expected a refusal, the call succeeded");
}

// ── manifest invariants ──

const inputProps = (id: string) => (manifest.operations.find((o) => o.id === id)?.input?.properties ?? {}) as Record<string, { maximum?: number; enum?: unknown[] } | undefined>;

test("manifest: the three data ops are agent-audience, crud read, effect read, idempotency none, receipt false, no scopeType; the share op is a person write", () => {
  for (const id of ["data_accounts_list", "data_catalog", "data_pull"]) {
    const op = manifest.operations.find((o) => o.id === id);
    assert.deepEqual([op?.audience, op?.crud, op?.effect, op?.idempotency, op?.receipt, op?.scopeType, op?.holdFamily], ["agent", ["read"], "read", "none", false, undefined, undefined], id);
  }
  const share = manifest.operations.find((o) => o.id === "account_app_share");
  assert.deepEqual([share?.audience, share?.crud, share?.effect, share?.receipt], ["person", ["update"], "write", true]);
  assert.equal(inputProps("data_pull").limit?.maximum, 200);
});

test("manifest: the product enum of account_app_share is exactly the data apps Connect knows", () => {
  const allowed = (inputProps("account_app_share").product?.enum ?? []) as string[];
  assert.deepEqual([...allowed].sort(), Object.keys(DATA_APPS).sort());
});

// ── only apps ──

test("non-app callers are refused no_access 403 by all three ops (agent and person), the app caller is served (quiet + fire)", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  const calls: [string, Record<string, unknown>][] = [
    ["data_accounts_list", {}],
    ["data_catalog", { account: acct }],
    ["data_pull", { account: acct, dataset: "messages" }],
  ];
  for (const [op, input] of calls) {
    for (const [who, ctx] of [["agent", s.ctx.agent], ["person", s.ctx.person]] as const) {
      const r = await refusal(s.op(op, input, ctx));
      assert.deepEqual([r.code, r.httpStatus], ["no_access", 403], `${op} as ${who}`);
    }
    await s.op(op, input, s.ctx.knowledge); // quiet on good
  }
});

test("an agent that owns the bot and has READ/UPDATE/DELETE scope on it still cannot use the data ops", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  const strong = testCtx({ db: s.db, agent: AGENT, access: { [acct]: "read_update_delete" } });
  for (const [op, input] of [["data_catalog", { account: acct }], ["data_pull", { account: acct, dataset: "messages" }]] as const) {
    assert.equal((await refusal(s.op(op, input, strong))).code, "no_access");
  }
});

test("account_app_share: an agent or an app cannot share (no_access 403); a person can", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  for (const ctx of [s.ctx.agent, s.ctx.knowledge]) {
    const r = await refusal(s.op("account_app_share", { account: acct, product: "knowledge", level: "shared" }, ctx));
    assert.deepEqual([r.code, r.httpStatus], ["no_access", 403]);
  }
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM connect_account_shares").get()?.n, 0);
  const out = (await s.share(acct, "knowledge", "shared")) as unknown as { level: string; shares: { product: string; level: string }[] };
  assert.deepEqual([out.level, out.shares.map((x) => [x.product, x.level])], ["shared", [["knowledge", "shared"]]]);
});

// ── sharing levels ──

test("sharing levels: none sees nothing; available sees the catalog (no text) and cannot pull; shared pulls", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1", "Support bot");
  s.ingest(acct, s.msg(1, { text: "secret launch plan" }), s.msg(2, { conversation: "chan-2", conversationName: "ops" }));

  // none (the default)
  assert.deepEqual(await s.op("data_accounts_list", {}, s.ctx.knowledge), { accounts: [] });
  assert.equal((await refusal(s.op("data_catalog", { account: acct }, s.ctx.knowledge))).code, "not_found");
  assert.equal((await refusal(s.op("data_pull", { account: acct, dataset: "messages" }, s.ctx.knowledge))).code, "not_found");

  // available
  await s.share(acct, "knowledge", "available");
  assert.deepEqual(await s.op("data_accounts_list", {}, s.ctx.knowledge), { accounts: [{ account: acct, service: "telegram", label: "Support bot", kinds: ["messages"], level: "available" }] });
  const catalog = (await s.op("data_catalog", { account: acct }, s.ctx.knowledge)) as unknown as { level: string; untrusted: boolean; datasets: { dataset: string; kind: string; delivery: string; approxRows: number; history: boolean; conversations: { id: string; name: string; approxRows: number }[] }[] };
  assert.equal(catalog.level, "available");
  assert.equal(catalog.untrusted, true);
  const [ds] = catalog.datasets;
  assert.deepEqual([ds?.dataset, ds?.kind, ds?.delivery, ds?.approxRows, ds?.history], ["messages", "messages", "pull", 2, false]);
  assert.deepEqual(ds?.conversations.map((c) => [c.id, c.name, c.approxRows]), [["chan-1", "general", 1], ["chan-2", "ops", 1]]);
  assert.ok(!JSON.stringify(catalog).includes("secret launch plan"), "no message value in the catalog");
  const denied = await refusal(s.op("data_pull", { account: acct, dataset: "messages" }, s.ctx.knowledge));
  assert.deepEqual([denied.code, denied.httpStatus], ["scope_denied", 403]);

  // shared
  await s.share(acct, "knowledge", "shared");
  const page = await s.pull(acct);
  assert.deepEqual(page.rows.map((r) => r.text), ["secret launch plan", "message 2"]);
  assert.equal(page.schema, "messages/1");
  assert.equal(page.untrusted, true);

  // back to none: everything closes again
  await s.share(acct, "knowledge", "none");
  assert.equal((await refusal(s.op("data_pull", { account: acct, dataset: "messages" }, s.ctx.knowledge))).code, "not_found");
});

test("sharing is per app: Observer sees only what is shared with Observer", async () => {
  const s = await setup();
  const a = await s.connect("telegram", "ta");
  const b = await s.connect("slack", "sb");
  await s.share(a, "knowledge", "shared");
  await s.share(b, "observer", "available");
  const ids = async (ctx: typeof s.ctx.knowledge) => ((await s.op("data_accounts_list", {}, ctx)) as unknown as { accounts: { account: string; level: string }[] }).accounts.map((x) => [x.account, x.level]);
  assert.deepEqual(await ids(s.ctx.knowledge), [[a, "shared"]]);
  assert.deepEqual(await ids(s.ctx.observer), [[b, "available"]]);
  assert.equal((await refusal(s.op("data_catalog", { account: a }, s.ctx.observer))).code, "not_found");
  assert.equal((await refusal(s.op("data_catalog", { account: b }, s.ctx.knowledge))).code, "not_found");
});

test("an app Connect does not know sees no account and gets not_found (unknown name, even with a look-alike name)", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  assert.deepEqual(await s.op("data_accounts_list", {}, s.ctx.rogue), { accounts: [] });
  assert.equal((await refusal(s.op("data_catalog", { account: acct }, s.ctx.rogue))).code, "not_found");
  assert.equal((await refusal(s.op("data_pull", { account: acct, dataset: "messages" }, s.ctx.rogue))).code, "not_found");
  // quiet on good: the real Knowledge still works
  assert.equal(((await s.op("data_accounts_list", {}, s.ctx.knowledge)) as unknown as { accounts: unknown[] }).accounts.length, 1);
});

test("no oracle: every account an app cannot see answers the identical not_found (same code, status and message)", async () => {
  const s = await setup();
  const real = await s.connect("telegram", "t1");
  const unshared = await s.connect("telegram", "t2");
  const other = await s.connect("telegram", "t3");
  const gone = await s.connect("telegram", "t4");
  await s.share(real, "knowledge", "shared");
  await s.share(other, "observer", "shared");
  await s.share(gone, "knowledge", "shared");
  await s.op("account_disconnect", { id: gone });
  const composio = s.accounts.create({ service: "gmail", source: "composio", kind: "as_me", label: "Mail", status: "connected" });
  const ids = [unshared, other, gone, composio.id, "cna_doesnotexist", "x".repeat(64)];
  const answers = new Set<string>();
  for (const id of ids) {
    for (const call of [() => s.op("data_catalog", { account: id }, s.ctx.knowledge), () => s.op("data_pull", { account: id, dataset: "messages" }, s.ctx.knowledge)]) {
      const r = await refusal(call());
      assert.deepEqual([r.code, r.httpStatus], ["not_found", 404], id);
      answers.add(JSON.stringify(r));
    }
  }
  assert.equal(answers.size, 1, "all refusals are byte-identical");
  // the account the app CAN see is not refused
  await s.op("data_catalog", { account: real }, s.ctx.knowledge);
});

test("a disconnected account closes: its shares are gone and a new connection starts at none", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  await s.op("account_disconnect", { id: acct });
  assert.deepEqual(await s.op("data_accounts_list", {}, s.ctx.knowledge), { accounts: [] });
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM connect_account_shares").get()?.n, 0);
  const again = await refusal(s.share(acct, "knowledge", "shared"));
  assert.deepEqual([again.code, again.httpStatus], ["channel_account_not_connected", 409]);
  await s.share(acct, "knowledge", "none"); // closing a revoked account's share is always allowed
});

test("account_app_share refuses bad input with exact codes", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  const gmail = s.accounts.create({ service: "gmail", source: "composio", kind: "as_me", label: "Mail", status: "connected" });
  assert.deepEqual((({ code, httpStatus }) => [code, httpStatus])(await refusal(s.share(acct, "fleet", "shared"))), ["product_unknown", 400]);
  assert.deepEqual((({ code, httpStatus }) => [code, httpStatus])(await refusal(s.share(acct, "knowledge", "everything"))), ["level_invalid", 400]);
  assert.deepEqual((({ code, httpStatus }) => [code, httpStatus])(await refusal(s.share("cna_nope", "knowledge", "shared"))), ["account_not_found", 404]);
  assert.deepEqual((({ code, httpStatus }) => [code, httpStatus])(await refusal(s.share(gmail.id, "knowledge", "shared"))), ["account_not_found", 404]);
});

test("accounts_overview lists the shares of a chat account and the apps one can share with", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  s.accounts.create({ service: "gmail", source: "composio", kind: "as_me", label: "Mail", status: "connected" });
  await s.share(acct, "observer", "available");
  const out = (await s.op("accounts_overview", {})) as unknown as { accounts: { id: string; source: string; shares?: unknown[] }[]; dataApps: unknown[] };
  assert.deepEqual(out.accounts.find((a) => a.id === acct)?.shares, [
    { product: "observer", instance: OBSERVER, current: true, level: "available", includeHistory: true, setAt: new Date(shareSetAt(s.db, acct, "observer")).toISOString() },
  ]);
  assert.ok(!("dataOpsAvailable" in out), "the gate is gone: sharing works");
  assert.equal(out.accounts.find((a) => a.source === "composio")?.shares, undefined);
  assert.deepEqual(out.dataApps, [
    { product: "knowledge", name: "Knowledge", instances: [{ instance: KNOWLEDGE, name: "Knowledge", provider: "railway", ownInfra: false }] },
    { product: "observer", name: "Observer", instances: [{ instance: OBSERVER, name: "Observer", provider: "railway", ownInfra: false }] },
  ]);
});

// ── C240: a share binds the verified product AND the instance id picked at share time ──

const KNOWLEDGE_2 = "ins_01KNOWLEDGETWO00000000000000";
type Overview = { accounts: { id: string; shares?: { product: string; instance: string | null; current: boolean; level: string }[] }[]; dataApps: { product: string; instances: { instance: string; name: string; provider: string | null; ownInfra: boolean }[] }[] };
const DATA_OPS = (acct: string) => [["data_catalog", { account: acct }], ["data_pull", { account: acct, dataset: "messages" }]] as const;

test("C240: the bound instance is served; another instance with the same verified product gets the no-share refusal on every data op", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  s.ingest(acct, s.msg(1));
  const twin = testCtx({ db: s.db, app: KNOWLEDGE_2, appName: "Knowledge", appProduct: "knowledge" });
  // quiet on good: the bound instance reads
  assert.equal((await s.pull(acct)).rows.length, 1);
  assert.equal(((await s.op("data_accounts_list", {}, s.ctx.knowledge)) as unknown as { accounts: unknown[] }).accounts.length, 1);
  // fires on bad: same product, other instance
  for (const [op, input] of DATA_OPS(acct)) assert.deepEqual((await refusal(s.op(op, input, twin))).code, "not_found", op);
  assert.deepEqual(((await s.op("data_accounts_list", {}, twin)) as unknown as { accounts: unknown[] }).accounts, []);
});

test("C240: reinstall = new share. The old instance leaves the slice, the share shows current:false and serves nobody; sharing again binds the new instance", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  const firstSetAt = shareSetAt(s.db, acct, "knowledge");
  // the owner reinstalled Knowledge: the slice now lists only the new instance
  const owner = testCtx({ db: s.db, person: true, companionCallers: [{ product: "knowledge", ins: KNOWLEDGE_2, name: "Knowledge", provider: "railway" }] });
  const reinstalled = testCtx({ db: s.db, app: KNOWLEDGE_2, appName: "Knowledge", appProduct: "knowledge" });
  const view = (await s.op("accounts_overview", {}, owner)) as unknown as Overview;
  assert.deepEqual(view.accounts.find((a) => a.id === acct)?.shares?.map((x) => [x.instance, x.current]), [[KNOWLEDGE, false]]);
  assert.deepEqual(view.dataApps.find((a) => a.product === "knowledge")?.instances.map((i) => i.instance), [KNOWLEDGE_2]);
  for (const [op, input] of DATA_OPS(acct)) assert.equal((await refusal(s.op(op, input, reinstalled))).code, "not_found", op);
  await tick();
  await s.op("account_app_share", { account: acct, product: "knowledge", instance: KNOWLEDGE_2, level: "shared", includeHistory: true }, owner);
  assert.ok(shareSetAt(s.db, acct, "knowledge") > firstSetAt, "a new instance is a new share (set_at moves)");
  assert.equal(((await s.op("data_catalog", { account: acct }, reinstalled)) as unknown as { account: string }).account, acct);
  // the old instance (if it still called) is not served any more
  assert.equal((await refusal(s.op("data_catalog", { account: acct }, s.ctx.knowledge))).code, "not_found");
});

test("C240: share time refuses an instance that is missing, unknown, of another product, or not visible (SDK without companionCallers); no row is written", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  const rows = () => Number(s.db.prepare("SELECT COUNT(*) AS n FROM connect_account_shares").get()?.n);
  const oldSdk = testCtx({ db: s.db, person: true });
  const cases: [Record<string, unknown>, typeof s.ctx.person, string, number][] = [
    [{ account: acct, product: "knowledge", level: "shared" }, s.ctx.person, "instance_required", 400],
    [{ account: acct, product: "knowledge", level: "available", instance: KNOWLEDGE_2 }, s.ctx.person, "app_instance_unknown", 404],
    [{ account: acct, product: "knowledge", level: "shared", instance: OBSERVER }, s.ctx.person, "app_instance_unknown", 404],
    [{ account: acct, product: "knowledge", level: "shared", instance: KNOWLEDGE }, oldSdk, "app_instance_unknown", 404],
  ];
  for (const [input, ctx, code, status] of cases) {
    const r = await refusal(s.op("account_app_share", input, ctx));
    assert.deepEqual([r.code, r.httpStatus], [code, status], JSON.stringify(input));
  }
  assert.equal(rows(), 0);
  // quiet on good: a listed instance of that product is bound
  await s.share(acct, "knowledge", "available");
  assert.equal(s.db.prepare("SELECT instance_id FROM connect_account_shares").get()?.instance_id, KNOWLEDGE);
  // "none" needs no instance and works even when the app is gone from the slice
  await s.op("account_app_share", { account: acct, product: "knowledge", level: "none" }, oldSdk);
  assert.equal(rows(), 0);
});

test("C240: a share row from before migration 0013 (no instance) serves no caller and shows current:false (the page says Share again: ui-accounts.test.ts)", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  s.db.prepare("INSERT INTO connect_account_shares (account_id, product, level, include_history, set_at) VALUES (?, 'knowledge', 'shared', 1, ?)").run(acct, Date.now());
  for (const [op, input] of DATA_OPS(acct)) assert.equal((await refusal(s.op(op, input, s.ctx.knowledge))).code, "not_found", op);
  assert.deepEqual(((await s.op("data_accounts_list", {}, s.ctx.knowledge)) as unknown as { accounts: unknown[] }).accounts, []);
  const view = (await s.op("accounts_overview", {})) as unknown as Overview;
  assert.deepEqual(view.accounts.find((a) => a.id === acct)?.shares?.map((x) => [x.instance, x.current]), [[null, false]]);
});

test("C240 item 3: the owner page marks a target on the owner's own infrastructure (provider own_infra); unknown provider is null", async () => {
  const s = await setup({
    callers: [
      { product: "knowledge", ins: KNOWLEDGE, name: "Knowledge", provider: "own_infra" },
      { product: "observer", ins: OBSERVER, name: "Observer" },
      { product: "rogue-app", ins: ROGUE, name: "Knowledge", provider: "railway" },
    ],
  });
  const view = (await s.op("accounts_overview", {})) as unknown as Overview;
  assert.deepEqual(view.dataApps.map((a) => [a.product, a.instances]), [
    ["knowledge", [{ instance: KNOWLEDGE, name: "Knowledge", provider: "own_infra", ownInfra: true }]],
    ["observer", [{ instance: OBSERVER, name: "Observer", provider: null, ownInfra: false }]],
  ]);
});

test("C240: companionCallersFor reads person calls only and skips malformed entries", () => {
  const db = testDb();
  const entries = [
    { product: "knowledge", ins: KNOWLEDGE, name: "Knowledge", provider: "railway" },
    { product: "", ins: OBSERVER, name: "x" },
    { product: "observer", ins: "agt_01NOTANINSTANCE0000000000", name: "x" },
    { product: "observer", ins: OBSERVER, name: "" },
  ];
  const person = testCtx({ db, person: true, companionCallers: entries });
  assert.deepEqual(companionCallersFor(person), [
    { product: "knowledge", instance: KNOWLEDGE, name: "Knowledge", provider: "railway" },
    { product: "observer", instance: OBSERVER, name: OBSERVER, provider: null },
  ]);
  const app = { ...testCtx({ db, app: KNOWLEDGE, appProduct: "knowledge" }), companionCallers: () => entries };
  assert.deepEqual(companionCallersFor(app as never), []);
  assert.deepEqual(companionCallersFor(testCtx({ db, person: true })), []);
});

// ── pull: paging, cursors ──

test("forward paging: pages of 3 over 8 messages give every message exactly once in order, ending exhausted; later messages continue from nextCursor", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  s.ingest(acct, ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => s.msg(n)));
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await s.pull(acct, { limit: 3, ...(cursor ? { cursor } : {}) });
    pages += 1;
    seen.push(...page.rows.map((r) => r.id));
    if (page.exhausted) {
      assert.ok(page.nextCursor, "forward keeps a cursor when exhausted, to poll for newer rows");
      cursor = page.nextCursor as string;
      break;
    }
    cursor = page.nextCursor as string;
  }
  assert.deepEqual(seen, ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]);
  assert.equal(pages, 3);
  // nothing new: empty, exhausted, same cursor
  const quiet = await s.pull(acct, { cursor });
  assert.deepEqual([quiet.rows.length, quiet.exhausted, quiet.nextCursor], [0, true, cursor]);
  // two new messages: exactly those
  s.ingest(acct, s.msg(9), s.msg(10));
  const next = await s.pull(acct, { cursor });
  assert.deepEqual(next.rows.map((r) => r.id), ["m9", "m10"]);
  assert.equal(next.exhausted, true);
});

test("the first page carries an anchor (the newest row); a page with a cursor carries none", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  const empty = await s.pull(acct);
  assert.deepEqual([empty.rows, empty.exhausted, empty.nextCursor, empty.anchor], [[], true, null, undefined]);
  s.ingest(acct, s.msg(1), s.msg(2), s.msg(3));
  const first = await s.pull(acct, { limit: 1 });
  assert.ok(first.anchor);
  const all = await s.pull(acct);
  assert.equal(all.nextCursor, all.anchor, "after the last row, the cursor is the anchor");
  assert.equal((await s.pull(acct, { cursor: first.nextCursor as string })).anchor, undefined);
});

test("backward paging (a provider with history): newest first, pages of 3 over 8 messages, no gap and no duplicate, last page exhausted with a null cursor", async () => {
  const s = await setup({ history: ["telegram"] });
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  s.ingest(acct, ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => s.msg(n)));
  assert.equal(((await s.op("data_catalog", { account: acct }, s.ctx.knowledge)) as unknown as { datasets: { history: boolean }[] }).datasets[0]?.history, true);
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const page = await s.pull(acct, { direction: "backward", limit: 3, ...(cursor ? { cursor } : {}) });
    seen.push(...page.rows.map((r) => r.id));
    if (page.exhausted) {
      assert.equal(page.nextCursor, null);
      break;
    }
    cursor = page.nextCursor as string;
  }
  assert.deepEqual(seen, ["m8", "m7", "m6", "m5", "m4", "m3", "m2", "m1"]);
  // forward from the anchor of the first page sees only what arrived after it
  const first = await s.pull(acct, { direction: "backward", limit: 2 });
  s.ingest(acct, s.msg(9));
  assert.deepEqual((await s.pull(acct, { cursor: first.anchor as string })).rows.map((r) => r.id), ["m9"]);
});

test("backward without provider history answers exhausted:true with no rows; the catalog says history:false (every provider in phase 1)", async () => {
  const s = await setup();
  for (const service of ["telegram", "slack", "discord", "teams"] as const) {
    const acct = await s.connect(service, `tok-${service}`);
    await s.share(acct, "knowledge", "shared");
    s.ingest(acct, s.msg(1), s.msg(2));
    const back = await s.pull(acct, { direction: "backward" });
    assert.deepEqual([back.rows, back.nextCursor, back.exhausted], [[], null, true], service);
    const cat = (await s.op("data_catalog", { account: acct }, s.ctx.knowledge)) as unknown as { datasets: { history: boolean }[] };
    assert.equal(cat.datasets[0]?.history, false, service);
    assert.equal((await s.pull(acct)).rows.length, 2, "the log itself is readable forward");
  }
});

test("since is inclusive and until exclusive, on sentAt", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  s.ingest(acct, ...[1, 2, 3, 4, 5].map((n) => s.msg(n)));
  const at = (n: number) => new Date(T0 + n * 1000).toISOString();
  assert.deepEqual((await s.pull(acct, { since: at(2), until: at(4) })).rows.map((r) => r.id), ["m2", "m3"]);
  assert.deepEqual((await s.pull(acct, { since: at(5) })).rows.map((r) => r.id), ["m5"]);
  assert.deepEqual((await s.pull(acct, { until: at(1) })).rows, []);
  const bad = await refusal(s.op("data_pull", { account: acct, dataset: "messages", since: "yesterday" }, s.ctx.knowledge));
  assert.deepEqual([bad.code, bad.httpStatus], ["since_invalid", 400]);
  assert.equal((await refusal(s.op("data_pull", { account: acct, dataset: "messages", until: "2026-10-17 10:00:00" }, s.ctx.knowledge))).code, "until_invalid");
});

test("a cursor that no pull returned is refused cursor_invalid 400; an unknown dataset is not_found; the limit is capped at 200", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  for (const cursor of ["!!!", Buffer.from("m2:5").toString("base64url"), Buffer.from("m1:abc").toString("base64url")]) {
    const r = await refusal(s.op("data_pull", { account: acct, dataset: "messages", cursor }, s.ctx.knowledge));
    assert.deepEqual([r.code, r.httpStatus], ["cursor_invalid", 400], cursor);
  }
  const ds = await refusal(s.op("data_pull", { account: acct, dataset: "orders" }, s.ctx.knowledge));
  assert.deepEqual([ds.code, ds.httpStatus], ["not_found", 404]);
  s.ingest(acct, ...Array.from({ length: 250 }, (_, i) => s.msg(i + 1)));
  const page = await s.pull(acct, { limit: 200 });
  assert.equal(page.rows.length, 200);
  assert.equal(page.exhausted, false);
  assert.equal((await s.pull(acct, { cursor: page.nextCursor as string, limit: 200 })).rows.length, 50);
  // the op input schema refuses 201 before the handler (the SDK validates); the handler clamps as well
  assert.equal((await s.pull(acct, { limit: 5000 })).rows.length, 200);
});

// ── rows: shape ──

test("rows are exactly messages/1: ids, thread, RFC 3339 UTC times, untrusted true, author kind person, display name", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  s.ingest(acct, s.msg(1, { threadId: "m0", senderName: "Anna Ivanova", sentAt: Date.UTC(2026, 9, 17, 10, 0, 0, 123) }));
  const [row] = (await s.pull(acct)).rows;
  assert.deepEqual(row, {
    id: "m1",
    conversation: "chan-1",
    thread: "m0",
    sentAt: "2026-10-17T10:00:00.123Z",
    author: { kind: "person", handle: "telegram:123456789", display: "Anna Ivanova" },
    text: "message 1",
    attachments: [],
    untrusted: true,
  });
});

test("author handles: canonical for slack (upper-case) and telegram; raw <channel>:<id> for discord and teams; the bot itself is kind self", async () => {
  const s = await setup();
  const slack = await s.connect("slack", "sl");
  const tg = await s.connect("telegram", "tg");
  const dc = await s.connect("discord", "dc");
  const tm = await s.connect("teams", "tm");
  for (const a of [slack, tg, dc, tm]) await s.share(a, "knowledge", "shared");
  s.ingest(slack, s.msg(1, { senderId: "u012abcdef" }), s.msg(2, { senderId: "W0ABCDEFG" }));
  s.ingest(tg, s.msg(1, { senderId: "123456789" }), s.msg(2, { senderId: "BOT-tg" }));
  s.ingest(dc, s.msg(1, { senderId: "80351110224678912" }));
  s.ingest(tm, s.msg(1, { senderId: "29:1AbC-dEf_ghi" }));
  const handles = async (a: string) => (await s.pull(a)).rows.map((r) => [r.author.kind, r.author.handle]);
  assert.deepEqual(await handles(slack), [["person", "slack:U012ABCDEF"], ["person", "slack:W0ABCDEFG"]]);
  assert.deepEqual(await handles(tg), [["person", "telegram:123456789"], ["self", "telegram:BOT-tg"]]);
  assert.deepEqual(await handles(dc), [["person", "discord:80351110224678912"]]);
  assert.deepEqual(await handles(tm), [["person", "teams:29:1AbC-dEf_ghi"]]);
});

test("a sender id that is not canonical for slack/telegram keeps its raw handle and is logged (no row is dropped)", async () => {
  const s = await setup();
  const slack = await s.connect("slack", "sl");
  await s.share(slack, "knowledge", "shared");
  s.ingest(slack, s.msg(1, { senderId: "B0BOTBOT" }), s.msg(2, { senderId: "U0ABCDEF" }));
  const rows = (await s.pull(slack)).rows;
  assert.deepEqual(rows.map((r) => r.author.handle), ["slack:B0BOTBOT", "slack:U0ABCDEF"]);
  assert.ok(s.logs.some((l) => l.level === "warn" && l.msg.includes("not canonical")));
});

test("text over 65536 characters is cut with truncated:true (by characters, not UTF-16 units); a short text carries no flag", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  s.ingest(acct, s.msg(1, { text: "a".repeat(70_000) }), s.msg(2, { text: "😀".repeat(65_536) }), s.msg(3, { text: "😀".repeat(65_537) }), s.msg(4, { text: "ok" }));
  const rows = (await s.pull(acct)).rows;
  assert.deepEqual(rows.map((r) => [Array.from(r.text).length, r.truncated]), [[65_536, true], [65_536, undefined], [65_536, true], [2, undefined]]);
});

test("attachments are metadata only: at most 32, attachmentsTruncated when more existed; text of a message with files is untouched", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  const files = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}.pdf`, mime: "application/pdf", bytes: 1000 + i }));
  s.ingest(acct, s.msg(1, { attachments: files }), s.msg(2, { attachments: files.slice(0, 2) }));
  // the hub keeps at most 32; a stored longer list (older rows, other writers) is still cut by the producer
  s.db.prepare("UPDATE connect_channel_inbox SET attachments = ? WHERE message_id = 'm2'").run(JSON.stringify(files));
  const [a, b] = (await s.pull(acct)).rows;
  assert.deepEqual([a?.attachments.length, a?.attachmentsTruncated], [32, undefined]);
  assert.deepEqual([b?.attachments.length, b?.attachmentsTruncated], [32, true]);
  assert.deepEqual(a?.attachments[0], { name: "f0.pdf", mime: "application/pdf", bytes: 1000 });
});

test("an edit and a deletion reach a forward cursor that already passed the row; a deleted row has empty text and no attachments", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  s.ingest(acct, s.msg(1, { attachments: [{ name: "a.png", mime: "image/png", bytes: 5 }] }), s.msg(2), s.msg(3));
  const first = await s.pull(acct);
  assert.equal(first.rows.length, 3);
  const cursor = first.nextCursor as string;
  assert.equal(s.hub.markEdited(acct, "chan-1", "m2", "message 2, edited", T0 + 60_000), true);
  assert.equal(s.hub.markDeleted(acct, "chan-1", "m1"), true);
  assert.equal(s.hub.markDeleted(acct, "chan-1", "m1"), false, "already deleted");
  assert.equal(s.hub.markDeleted(acct, "chan-1", "nope"), false);
  const next = await s.pull(acct, { cursor });
  assert.deepEqual(next.rows.map((r) => r.id), ["m2", "m1"]);
  assert.deepEqual([next.rows[0]?.text, next.rows[0]?.editedAt], ["message 2, edited", new Date(T0 + 60_000).toISOString()]);
  assert.deepEqual([next.rows[1]?.deleted, next.rows[1]?.text, next.rows[1]?.attachments], [true, "", []]);
  assert.equal(s.db.prepare("SELECT text FROM connect_channel_inbox WHERE message_id = 'm1'").get()?.text, "", "the stored text is erased too");
  // an agent's channel_inbox does not show the deleted message
  const inbox = (await s.op("channel_inbox", {}, testCtx({ db: s.db, agent: AGENT, access: { [acct]: "read" } }))) as unknown as { messages: { messageId: string }[] };
  assert.deepEqual(inbox.messages.map((m) => m.messageId), ["m2", "m3"]);
});

test("a very long page is cut at 2 MiB without losing a row: paging through 40 rows of 60 000 characters gives all of them once", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  s.ingest(acct, ...Array.from({ length: 40 }, (_, i) => s.msg(i + 1, { text: "x".repeat(60_000) })));
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (let i = 0; i < 20; i++) {
    const page = await s.pull(acct, { limit: 200, ...(cursor ? { cursor } : {}) });
    pages += 1;
    seen.push(...page.rows.map((r) => r.id));
    cursor = page.nextCursor as string;
    if (page.exhausted) break;
    assert.ok(page.rows.length < 40, "the first page was cut by size");
  }
  assert.ok(pages >= 2);
  assert.deepEqual(seen, Array.from({ length: 40 }, (_, i) => `m${i + 1}`));
});

test("an id over 200 characters becomes a stable hash (the contract allows 200); two different long ids stay different", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  s.ingest(acct, s.msg(1, { messageId: "a".repeat(300) }), s.msg(2, { messageId: `${"a".repeat(299)}b` }));
  const rows = (await s.pull(acct)).rows;
  assert.ok(rows.every((r) => r.id.length <= 200));
  assert.notEqual(rows[0]?.id, rows[1]?.id);
  assert.equal((await s.pull(acct)).rows[0]?.id, rows[0]?.id);
});

// ── fail loudly ──

test("a stored row that breaks messages/1 is quarantined: skipped, counted, logged with its rev, the page stays valid and the account is not blocked", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  s.ingest(acct, s.msg(1), s.msg(2, { messageId: "" }), s.msg(3));
  const page = await s.pull(acct);
  assert.deepEqual(page.rows.map((r) => r.id), ["m1", "m3"]);
  assert.equal((page as unknown as { quarantined: number }).quarantined, 1);
  assert.equal(page.exhausted, true);
  const logged = s.logs.find((l) => l.level === "error" && l.msg.includes("does not conform"));
  assert.deepEqual([logged?.fields?.rev, logged?.fields?.account], [2, acct]);
  assert.ok(!JSON.stringify(logged).includes("message 2"), "message text stays out of the log");
  // paging past the bad row does not stall: a page that holds only the bad row still moves the cursor
  const first = await s.pull(acct, { limit: 1 });
  const second = await s.pull(acct, { limit: 1, cursor: first.nextCursor as string });
  assert.deepEqual([second.rows.length, second.exhausted], [0, false]);
  assert.equal((second as unknown as { quarantined: number }).quarantined, 1);
  assert.deepEqual((await s.pull(acct, { limit: 1, cursor: second.nextCursor as string })).rows.map((r) => r.id), ["m3"]);
  // quiet on good: a page without a bad row has no quarantined member
  s.db.prepare("DELETE FROM connect_channel_inbox WHERE message_id = ''").run();
  assert.equal("quarantined" in (await s.pull(acct)), false);
});

test("a rate-limited source answers an empty, valid page with retryAfterS and the same cursor (clamped to 1..3600)", async () => {
  const s = await setup();
  const acct = s.accounts.create({ service: "telegram", source: "channel", kind: "as_itself", ownerAgent: AGENT, label: "x", status: "connected" });
  const cursor = encodeCursor(acct.id, 5);
  const limited = (seconds: number) =>
    pullMessages({ db: s.db, botId: () => null, history: () => false, read: () => { throw new RetryLater(seconds); } }, acct, { direction: "forward", cursor, since: null, until: null, ingestedFrom: null, limit: 10 });
  const page = limited(30);
  assert.deepEqual(page, { rows: [], nextCursor: cursor, exhausted: false, retryAfterS: 30 });
  assert.deepEqual(validateAgainstSchema(schema, page as unknown as Json), { ok: true });
  assert.equal(limited(99_999).retryAfterS, 3600);
  assert.equal(limited(0.2).retryAfterS, 1);
  // any other source error is not swallowed
  assert.throws(() => pullMessages({ db: s.db, botId: () => null, history: () => false, read: () => { throw new Error("boom"); } }, acct, { direction: "forward", cursor: null, since: null, until: null, ingestedFrom: null, limit: 10 }), { message: "boom" });
});

// ── retention and migration ──

test("retention: the inbound log is kept at least 7 days (30 now): a 8-day-old message stays, a 31-day-old one is purged", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  assert.equal(INBOX_RETENTION_MS, 30 * 24 * 3600 * 1000, "the constant is what the catalog reports");
  s.ingest(acct, s.msg(1), s.msg(2));
  const day = 24 * 3600 * 1000;
  s.db.prepare("UPDATE connect_channel_inbox SET received_at = ? WHERE message_id = 'm1'").run(Date.now() - 31 * day);
  s.db.prepare("UPDATE connect_channel_inbox SET received_at = ? WHERE message_id = 'm2'").run(Date.now() - 8 * day);
  s.hub.purge();
  assert.deepEqual((await s.pull(acct)).rows.map((r) => r.id), ["m2"]);
  // revs are never reused after the purge
  s.ingest(acct, s.msg(3));
  const revs = s.db.prepare("SELECT rev FROM connect_channel_inbox ORDER BY rev").all().map((r) => Number(r.rev));
  assert.deepEqual(revs, [...revs].sort((a, b) => a - b));
  assert.equal(new Set(revs).size, revs.length);
});

test("migrations 0010 + 0011: old rows get a per-account rev (1, 2, 3 per account), the counters continue above them, the global counter is gone", () => {
  const db = new DatabaseSync(":memory:");
  const dir = join(root, "migrations");
  const files = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();
  for (const f of files.filter((n) => n < "0010")) db.exec(readFileSync(join(dir, f), "utf8"));
  for (const a of ["a1", "a2"]) db.exec(`INSERT INTO connect_accounts (id, service, source, kind, label, owner_agent, status, detail, created_at, updated_at) VALUES ('${a}','telegram','channel','as_itself','x','agt_1','connected','',1,1)`);
  // interleaved traffic of two accounts
  for (const [n, a] of [[1, "a1"], [2, "a2"], [3, "a2"], [4, "a1"], [5, "a1"]] as const) {
    db.exec(`INSERT INTO connect_channel_inbox (account_id, conversation, conversation_type, message_id, sender_id, sender_name, text, sent_at, received_at) VALUES ('${a}','c','channel','m${n}','u','U','t',${n},${n})`);
  }
  db.exec(readFileSync(join(dir, "0010_data_ops.sql"), "utf8"));
  assert.deepEqual(db.prepare("SELECT seq, rev FROM connect_channel_inbox ORDER BY seq").all().map((r) => [r.seq, r.rev]), [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
  db.exec(readFileSync(join(dir, "0011_data_ops_review.sql"), "utf8"));
  assert.deepEqual(db.prepare("SELECT account_id, rev FROM connect_channel_inbox ORDER BY seq").all().map((r) => [r.account_id, r.rev]), [["a1", 1], ["a2", 1], ["a2", 2], ["a1", 2], ["a1", 3]]);
  assert.deepEqual(db.prepare("SELECT account_id, last FROM connect_account_rev ORDER BY account_id").all().map((r) => [r.account_id, r.last]), [["a1", 3], ["a2", 2]]);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'connect_inbox_rev'").get(), undefined);
});

// ── Coordinator ruling A: the app is identified by the verified caller product, never by name ──

test("A: an app caller without a verified product is refused caller_unverified 403 by all three ops, whatever its name says; its share by name changes nothing", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  await s.share(acct, "observer", "shared");
  const calls: [string, Record<string, unknown>][] = [["data_accounts_list", {}], ["data_catalog", { account: acct }], ["data_pull", { account: acct, dataset: "messages" }]];
  const named = (name: string) => testCtx({ db: s.db, app: UNVERIFIED, appName: name });
  for (const [op, input] of calls) {
    for (const ctx of [s.ctx.unverified, named("Observer"), named("observer"), named("knowledge")]) {
      const r = await refusal(s.op(op, input, ctx));
      assert.deepEqual([r.code, r.httpStatus], ["caller_unverified", 403], `${op} as ${ctx.caller.name}`);
    }
    // people and agents are still no_access; the verified apps are served
    assert.equal((await refusal(s.op(op, input, s.ctx.person))).code, "no_access");
    assert.equal((await refusal(s.op(op, input, s.ctx.agent))).code, "no_access");
    await s.op(op, input, s.ctx.knowledge);
  }
});

test("A: verifiedAppProduct answers the verified product of an app caller and null otherwise (no name, no id, no input)", () => {
  const db = testDb();
  assert.equal(verifiedAppProduct(testCtx({ db, app: KNOWLEDGE, appName: "Observer", appProduct: "knowledge" })), "knowledge");
  assert.equal(verifiedAppProduct(testCtx({ db, app: KNOWLEDGE, appName: "Observer" })), null, "an app without a product: null, whatever the name");
  assert.equal(verifiedAppProduct(testCtx({ db, app: KNOWLEDGE, appName: "Observer", appProduct: "" })), null, "an empty product is no product");
  assert.equal(verifiedAppProduct(testCtx({ db, person: true })), null);
  assert.equal(verifiedAppProduct(testCtx({ db, agent: AGENT })), null);
  const agentWithProduct = testCtx({ db, agent: AGENT });
  (agentWithProduct.caller as { product?: string }).product = "observer";
  assert.equal(verifiedAppProduct(agentWithProduct), null, "only an app caller has a verified product");
});

test("A: an instance that carries the exact manifest name \"Knowledge\" but is not the verified Knowledge is refused (sees nothing, not_found)", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  assert.equal(s.ctx.rogue.caller.name, "Knowledge");
  assert.deepEqual(await s.op("data_accounts_list", {}, s.ctx.rogue), { accounts: [] });
  assert.equal((await refusal(s.op("data_catalog", { account: acct }, s.ctx.rogue))).code, "not_found");
  assert.equal((await refusal(s.op("data_pull", { account: acct, dataset: "messages" }, s.ctx.rogue))).code, "not_found");
  // the share the owner gave Observer is not reachable by a name that says Observer
  const nameOnly = testCtx({ db: s.db, app: ROGUE, appName: "Observer", appProduct: "rogue-app" });
  await s.share(acct, "observer", "shared");
  assert.deepEqual(await s.op("data_accounts_list", {}, nameOnly), { accounts: [] });
  // and a verified instance is served whatever name it carries
  const renamed = testCtx({ db: s.db, app: KNOWLEDGE, appName: "Something else entirely", appProduct: "knowledge" });
  assert.equal(((await s.op("data_accounts_list", {}, renamed)) as unknown as { accounts: unknown[] }).accounts.length, 1);
});

// ── B: edits and deletions through the real provider parsers ──

test("B: Slack, Telegram and Discord events (real parsers) → the log → data_pull: an edit and a deletion reach a cursor that already passed the message", async () => {
  const s = await setup();
  const slack = await s.connect("slack", "sl");
  const tg = await s.connect("telegram", "tg");
  const dc = await s.connect("discord", "dc");
  for (const a of [slack, tg, dc]) await s.share(a, "knowledge", "shared");
  const feed = (acct: string, m: InboundMessage | null | undefined) => {
    assert.ok(m);
    s.hub.ingest(s.accounts.get(acct) as NonNullable<ReturnType<AccountStore["get"]>>, m);
  };
  const now = () => T0;

  // Slack
  const bot = { botId: "U0BOTUSER1", botName: "bot", workspace: "T0TESTTEAM" };
  const sl = (event: Record<string, unknown>) => parseSlackEvent({ type: "event_callback", team_id: "T0TESTTEAM", event_id: "Ev0DATA0001", event: { type: "message", channel: "C0GENERAL1", channel_type: "channel", ...event } }, bot, now)?.message;
  feed(slack, sl({ user: "U0HUMAN001", text: "one", ts: "1700000200.000100" }));
  feed(slack, sl({ user: "U0HUMAN001", text: "two", ts: "1700000201.000100" }));
  const slackCursor = (await s.pull(slack)).nextCursor as string;
  feed(slack, sl({ subtype: "message_changed", message: { user: "U0HUMAN001", text: "one, edited", ts: "1700000200.000100", edited: { ts: "1700000260.000100" } } }));
  feed(slack, sl({ subtype: "message_deleted", deleted_ts: "1700000201.000100" }));
  const slackNext = await s.pull(slack, { cursor: slackCursor });
  assert.deepEqual(slackNext.rows.map((r) => [r.id, r.text, r.editedAt, r.deleted]), [
    ["1700000200.000100", "one, edited", "2023-11-14T22:17:40.000Z", undefined],
    ["1700000201.000100", "", undefined, true],
  ]);

  // Telegram (edits only: Telegram never reports a deletion)
  const tgBot = { botId: "999000111", botName: "tbot" };
  const base = { message_id: 41, date: 1_760_000_000, chat: { id: 5550001, type: "private" }, from: { id: 5550001, first_name: "Ada" } };
  feed(tg, parseTelegramUpdate({ update_id: 1, message: { ...base, text: "hello" } }, tgBot, 1));
  const tgCursor = (await s.pull(tg)).nextCursor as string;
  feed(tg, parseTelegramUpdate({ update_id: 2, edited_message: { ...base, text: "hello, edited", edit_date: 1_760_000_100 } }, tgBot, 1));
  const tgNext = await s.pull(tg, { cursor: tgCursor });
  assert.deepEqual(tgNext.rows.map((r) => [r.id, r.text, r.editedAt]), [["41", "hello, edited", "2025-10-09T08:55:00.000Z"]]);
  assert.equal(((await s.op("data_catalog", { account: tg }, s.ctx.knowledge)) as unknown as { datasets: { edits: boolean; deletions: boolean }[] }).datasets[0]?.deletions, false);

  // Discord
  const ids = ["999"];
  const gw = { id: "4400000000000000001", channel_id: "3300000000000000001", guild_id: "2200000000000000001", author: { id: "6600000000000000001", username: "ada" }, content: "build ok?", attachments: [], timestamp: "2026-10-12T09:01:02.345000+00:00", type: 0 };
  feed(dc, parseDiscordMessage(gw, ids, 1));
  const dcCursor = (await s.pull(dc)).nextCursor as string;
  feed(dc, parseDiscordUpdate({ ...gw, content: "build ok? (edited)", edited_timestamp: "2026-10-12T09:05:00.000000+00:00" }, ids, 1));
  for (const m of parseDiscordDeletes({ id: gw.id, channel_id: gw.channel_id, guild_id: gw.guild_id }, 1)) feed(dc, m);
  const dcNext = await s.pull(dc, { cursor: dcCursor });
  assert.deepEqual(dcNext.rows.map((r) => [r.id, r.deleted, r.text]), [[gw.id, true, ""]], "the deletion is the newest state of the row");
  assert.equal(s.db.prepare("SELECT text FROM connect_channel_inbox WHERE account_id = ?").get(dc)?.text, "", "the stored text is erased");
  assert.equal(((await s.op("data_catalog", { account: dc }, s.ctx.knowledge)) as unknown as { datasets: { deletions: boolean }[] }).datasets[0]?.deletions, true);
});

test("B: an edit or a deletion of a message Connect never logged is an orphan: dropped and counted, never a row an agent could see (Telegram, Discord, Slack parsers)", async () => {
  const s = await setup();
  const tg = await s.connect("telegram", "tg");
  const dc = await s.connect("discord", "dc");
  const sl = await s.connect("slack", "sl");
  for (const a of [tg, dc, sl]) await s.share(a, "knowledge", "shared");
  const feed = (acct: string, m: InboundMessage | null | undefined) => {
    assert.ok(m);
    s.hub.ingest(s.accounts.get(acct) as NonNullable<ReturnType<AccountStore["get"]>>, m);
  };
  feed(tg, parseTelegramUpdate({ update_id: 1, edited_message: { message_id: 7, date: 1_760_000_000, chat: { id: 5550001, type: "private" }, from: { id: 5550001, first_name: "Ada" }, text: "old message, edited", edit_date: 1_760_000_100 } }, { botId: "999", botName: "b" }, 1));
  const gw = { id: "4400000000000000001", channel_id: "3300000000000000001", guild_id: "2200000000000000001", author: { id: "6600000000000000001", username: "ada" }, content: "old", attachments: [], timestamp: "2026-10-12T09:01:02.345000+00:00", type: 0 };
  feed(dc, parseDiscordUpdate({ ...gw, content: "old, edited", edited_timestamp: "2026-10-12T09:05:00.000000+00:00" }, ["999"], 1));
  for (const m of parseDiscordDeletes({ id: gw.id, channel_id: gw.channel_id }, 1)) feed(dc, m);
  const bot = { botId: "U0BOTUSER1", botName: "bot", workspace: "T0TESTTEAM" };
  const slack = (event: Record<string, unknown>) => parseSlackEvent({ type: "event_callback", team_id: "T0TESTTEAM", event_id: "Ev0ORPHAN01", event: { type: "message", channel: "C0GENERAL1", channel_type: "channel", ...event } }, bot, () => T0)?.message;
  feed(sl, slack({ subtype: "message_changed", message: { user: "U0HUMAN001", text: "edited", ts: "1700000200.000100", edited: { ts: "1700000260.000100" } } }));
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM connect_channel_inbox").get()?.n, 0, "no row from an edit or a delete of an unknown message");
  for (const a of [tg, dc, sl]) assert.deepEqual((await s.pull(a)).rows, []);
  const counts = Object.fromEntries(((await s.op("channel_accounts", {})) as unknown as { accounts: { id: string; bot: { unmatchedChanges: number } }[] }).accounts.map((a) => [a.id, a.bot.unmatchedChanges]));
  assert.deepEqual(counts, { [tg]: 1, [dc]: 2, [sl]: 1 });
  assert.equal(s.logs.filter((l) => l.msg.includes("not in the log")).length, 4);
  assert.ok(!JSON.stringify(s.logs).includes("old message"), "the log holds metadata only");
  for (const [id, agentCtx] of [[tg, testCtx({ db: s.db, agent: AGENT, access: { [tg]: "read" } })]] as const) {
    assert.deepEqual(((await s.op("channel_inbox", { account: id }, agentCtx)) as unknown as { messages: unknown[] }).messages, []);
  }
  // quiet on good: a normal edit of a logged message is not an orphan
  feed(tg, parseTelegramUpdate({ update_id: 3, message: { message_id: 8, date: 1_760_000_000, chat: { id: 5550001, type: "private" }, from: { id: 5550001, first_name: "Ada" }, text: "fresh" } }, { botId: "999", botName: "b" }, 1));
  feed(tg, parseTelegramUpdate({ update_id: 4, edited_message: { message_id: 8, date: 1_760_000_000, chat: { id: 5550001, type: "private" }, from: { id: 5550001, first_name: "Ada" }, text: "fresh, edited", edit_date: 1_760_000_100 } }, { botId: "999", botName: "b" }, 1));
  assert.deepEqual((await s.pull(tg)).rows.map((r) => r.text), ["fresh, edited"]);
  assert.equal(s.logs.filter((l) => l.msg.includes("not in the log")).length, 4);
});

test("B: an edit is ordered and idempotent: a replay or an older edit takes no new rev; a deletion of a deleted message is a no-op", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  s.ingest(acct, s.msg(1));
  const rev = () => Number(s.db.prepare("SELECT rev FROM connect_channel_inbox WHERE message_id = 'm1'").get()?.rev);
  assert.equal(rev(), 1);
  assert.equal(s.hub.markEdited(acct, "chan-1", "m1", "v2", T0 + 2000), true);
  assert.equal(rev(), 2);
  assert.equal(s.hub.markEdited(acct, "chan-1", "m1", "v2", T0 + 2000), false, "replay");
  assert.equal(s.hub.markEdited(acct, "chan-1", "m1", "v1.5", T0 + 1000), false, "an older edit arriving late");
  assert.equal(rev(), 2);
  assert.equal(s.db.prepare("SELECT text FROM connect_channel_inbox WHERE message_id = 'm1'").get()?.text, "v2");
  assert.equal(s.hub.markEdited(acct, "chan-1", "m1", "v3", T0 + 3000), true);
  assert.equal(rev(), 3);
  assert.equal(s.hub.markDeleted(acct, "chan-1", "m1"), true);
  assert.equal(s.hub.markDeleted(acct, "chan-1", "m1"), false);
  assert.equal(rev(), 4, "the replayed deletion took no rev");
  // an edit that arrives after the deletion changes nothing and is not an orphan
  s.hub.ingest(s.accounts.get(acct) as NonNullable<ReturnType<AccountStore["get"]>>, s.msg(1, { change: { kind: "edit", at: T0 + 9000 } }));
  assert.equal(rev(), 4);
  assert.equal(s.db.prepare("SELECT unmatched_changes AS n FROM connect_channel_bots WHERE account_id = ?").get(acct)?.n, 0);
});

test("channel_reply to a deleted message is 404 channel_message_unknown", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  s.ingest(acct, s.msg(1), s.msg(2));
  const seq = (id: string) => Number(s.db.prepare("SELECT seq FROM connect_channel_inbox WHERE message_id = ?").get(id)?.seq);
  const agent = testCtx({ db: s.db, agent: AGENT, access: { [acct]: "read_update" } });
  assert.deepEqual(await s.op("channel_reply", { account: acct, seq: seq("m2"), text: "ok" }, agent), { messageId: "sent-1", conversation: "chan-1" });
  s.hub.markDeleted(acct, "chan-1", "m1");
  const r = await refusal(s.op("channel_reply", { account: acct, seq: seq("m1"), text: "ok" }, agent));
  assert.deepEqual([r.code, r.httpStatus], ["channel_message_unknown", 404]);
});

// ── bots' rows are kept only for an account with an app share; the agent inbox moves past hidden rows ──

test("bots: another bot's message is stored only while the account has an app share; without one it is dropped as before R3", async () => {
  const s = await setup();
  const acct = await s.connect("slack", "sl");
  s.ingest(acct, s.msg(1, { senderId: "B0OTHERBOT", senderIsBot: true }));
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM connect_channel_inbox").get()?.n, 0, "no share: dropped");
  await s.share(acct, "knowledge", "available");
  s.ingest(acct, s.msg(2, { senderId: "B0OTHERBOT", senderIsBot: true }), s.msg(3, { senderId: "U0HUMAN001" }));
  assert.deepEqual(s.db.prepare("SELECT message_id FROM connect_channel_inbox ORDER BY seq").all().map((r) => r.message_id), ["m2", "m3"]);
  await s.share(acct, "knowledge", "none");
  s.ingest(acct, s.msg(4, { senderId: "B0OTHERBOT", senderIsBot: true }));
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM connect_channel_inbox WHERE message_id = 'm4'").get()?.n, 0, "share withdrawn: dropped again");
});

test("inbox: nextSeq moves past hidden rows (other bots' messages, deleted messages); a full window ends at its last visible row", async () => {
  const s = await setup();
  const acct = await s.connect("slack", "sl");
  await s.share(acct, "knowledge", "available");
  const agent = testCtx({ db: s.db, agent: AGENT, access: { [acct]: "read" } });
  const inbox = async (since: number, limit?: number) => (await s.op("channel_inbox", { sinceSeq: since, ...(limit ? { limit } : {}) }, agent)) as unknown as { messages: { messageId: string }[]; nextSeq: number };
  const seq = (id: string) => Number(s.db.prepare("SELECT seq FROM connect_channel_inbox WHERE message_id = ?").get(id)?.seq);
  s.ingest(acct, s.msg(1, { senderId: "U0HUMAN001" }), s.msg(2, { senderId: "B0OTHERBOT", senderIsBot: true }), s.msg(3, { senderId: "B0OTHERBOT", senderIsBot: true }));
  const first = await inbox(0);
  assert.deepEqual(first.messages.map((m) => m.messageId), ["m1"]);
  assert.equal(first.nextSeq, seq("m3"), "past the two hidden bot rows");
  assert.deepEqual((await inbox(first.nextSeq)).messages, []);
  assert.equal((await inbox(first.nextSeq)).nextSeq, seq("m3"));
  // a deleted message hides too
  s.ingest(acct, s.msg(4, { senderId: "U0HUMAN001" }));
  s.hub.markDeleted(acct, "chan-1", "m4");
  assert.equal((await inbox(first.nextSeq)).nextSeq, seq("m4"));
  // a full window ends at its last visible row (the rest is read next time)
  s.ingest(acct, s.msg(5, { senderId: "U0HUMAN001" }), s.msg(6, { senderId: "U0HUMAN001" }), s.msg(7, { senderId: "B0OTHERBOT", senderIsBot: true }));
  const window = await inbox(first.nextSeq, 1);
  assert.deepEqual([window.messages.map((m) => m.messageId), window.nextSeq], [["m5"], seq("m5")]);
  const rest = await inbox(window.nextSeq, 5);
  assert.deepEqual([rest.messages.map((m) => m.messageId), rest.nextSeq], [["m6"], seq("m7")]);
});

// ── C: a share starts when it is made ──

test("C: a pull returns only messages Connect received at or after the share began, unless includeHistory; the catalog counts stay whole", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  s.ingest(acct, s.msg(1), s.msg(2));
  s.db.prepare("UPDATE connect_channel_inbox SET received_at = ?").run(Date.now() - 5 * 24 * 3600 * 1000);
  await s.share(acct, "knowledge", "shared", false);
  await tick();
  s.ingest(acct, s.msg(3));
  assert.deepEqual((await s.pull(acct)).rows.map((r) => r.id), ["m3"], "only what arrived after the share");
  // include the last 30 days: the whole log
  await s.share(acct, "knowledge", "shared", true);
  assert.deepEqual((await s.pull(acct)).rows.map((r) => r.id), ["m1", "m2", "m3"]);
  // withdraw the history again: the share starts anew now
  await tick();
  await s.share(acct, "knowledge", "shared", false);
  await tick();
  assert.deepEqual((await s.pull(acct)).rows, []);
  s.ingest(acct, s.msg(4));
  const page = await s.pull(acct);
  assert.deepEqual(page.rows.map((r) => r.id), ["m4"]);
  assert.ok(page.anchor, "the anchor is within the shared part too");
  // an old message that is edited later stays out (it was received before the share)
  s.hub.markEdited(acct, "chan-1", "m1", "edited late", T0);
  assert.deepEqual((await s.pull(acct)).rows.map((r) => r.id), ["m4"]);
});

test("C: set_at is kept by a call that changes nothing and moves when the level or the history choice changes", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared", false);
  s.db.prepare("UPDATE connect_account_shares SET set_at = 1000").run();
  await s.share(acct, "knowledge", "shared", false);
  assert.equal(shareSetAt(s.db, acct, "knowledge"), 1000);
  await s.share(acct, "knowledge", "shared", true);
  assert.ok(shareSetAt(s.db, acct, "knowledge") > 1000);
});

// ── E: receipts and audit ──

test("E: account_app_share writes a receipt line; every data_* call writes one audit line (op, outcome, caller, product, account, dataset, row count; no text), refusals too", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1", "Support bot");
  const person = testCtx({ db: s.db, person: true, companionCallers: [{ product: "knowledge", ins: KNOWLEDGE, name: "Knowledge" }] });
  await s.op("account_app_share", { account: acct, product: "knowledge", instance: KNOWLEDGE, level: "shared", includeHistory: true }, person);
  assert.deepEqual(person.receipts.summary, ["Sharing of “Support bot” with Knowledge: messages, read only"]);
  assert.deepEqual(person.receipts.meta, [{ account: acct, product: "knowledge", instance: KNOWLEDGE, level: "shared", includeHistory: true }]);
  s.ingest(acct, s.msg(1, { text: "private words" }), s.msg(2));
  await s.pull(acct, { limit: 1 });
  await s.pull(acct);
  await s.op("data_catalog", { account: acct }, s.ctx.knowledge);
  await s.op("data_accounts_list", {}, s.ctx.knowledge);
  // refusals: an agent, an unshared app, an unknown account, an unknown dataset
  await refusal(s.op("data_pull", { account: acct, dataset: "messages" }, s.ctx.agent));
  await refusal(s.op("data_pull", { account: acct, dataset: "messages" }, s.ctx.observer));
  await refusal(s.op("data_catalog", { account: "cna_nope" }, s.ctx.knowledge));
  await refusal(s.op("data_pull", { account: acct, dataset: "orders" }, s.ctx.knowledge));
  const audit = s.db.prepare("SELECT op, outcome, caller_type, product, account_id, dataset, row_count FROM connect_data_audit ORDER BY id").all().map((r) => ({ ...r }));
  const ok = { caller_type: "app", product: "knowledge", account_id: acct };
  assert.deepEqual(audit, [
    { op: "data_pull", outcome: "ok", ...ok, dataset: "messages", row_count: 1 },
    { op: "data_pull", outcome: "ok", ...ok, dataset: "messages", row_count: 2 },
    { op: "data_catalog", outcome: "ok", ...ok, dataset: null, row_count: 0 },
    { op: "data_accounts_list", outcome: "ok", caller_type: "app", product: "knowledge", account_id: null, dataset: null, row_count: 0 },
    { op: "data_pull", outcome: "no_access", caller_type: "agent", product: null, account_id: acct, dataset: "messages", row_count: 0 },
    { op: "data_pull", outcome: "not_found", caller_type: "app", product: "observer", account_id: acct, dataset: "messages", row_count: 0 },
    { op: "data_catalog", outcome: "not_found", caller_type: "app", product: "knowledge", account_id: "cna_nope", dataset: null, row_count: 0 },
    { op: "data_pull", outcome: "not_found", caller_type: "app", product: "knowledge", account_id: acct, dataset: "orders", row_count: 0 },
  ]);
  assert.ok(!JSON.stringify(s.db.prepare("SELECT * FROM connect_data_audit").all()).includes("private words"));
  assert.ok(s.logs.some((l) => l.msg === "data_pull" && l.fields?.rows === 1));
});

test("E: a refused unverified app caller is audited too, with the caller and no product", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  await refusal(s.op("data_pull", { account: acct, dataset: "messages" }, s.ctx.unverified));
  await refusal(s.op("data_catalog", { account: acct }, s.ctx.person));
  const audit = s.db.prepare("SELECT op, outcome, caller_type, caller_id, product FROM connect_data_audit ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(audit, [
    { op: "data_pull", outcome: "caller_unverified", caller_type: "app", caller_id: UNVERIFIED, product: null },
    { op: "data_catalog", outcome: "no_access", caller_type: "person", caller_id: "per_01TESTOWNER00000000000000", product: null },
  ]);
});

// ── F: cursors are per account ──

test("F: another account's traffic does not move a cursor; a cursor of one account is refused on another", async () => {
  const s = await setup();
  const a = await s.connect("telegram", "ta");
  const b = await s.connect("slack", "sb");
  await s.share(a, "knowledge", "shared");
  await s.share(b, "knowledge", "shared");
  s.ingest(a, s.msg(1), s.msg(2));
  const first = await s.pull(a);
  assert.equal(first.nextCursor, encodeCursor(a, 2), "the cursor is the account's own sequence number");
  s.ingest(b, ...Array.from({ length: 25 }, (_, i) => s.msg(i + 1)));
  s.ingest(a, s.msg(3));
  const next = await s.pull(a, { cursor: first.nextCursor as string });
  assert.deepEqual(next.rows.map((r) => r.id), ["m3"]);
  assert.equal(next.nextCursor, encodeCursor(a, 3), "25 messages of account B moved nothing");
  assert.equal((await s.pull(b)).nextCursor, encodeCursor(b, 25));
  const wrong = await refusal(s.op("data_pull", { account: b, dataset: "messages", cursor: first.nextCursor }, s.ctx.knowledge));
  assert.deepEqual([wrong.code, wrong.httpStatus], ["cursor_invalid", 400]);
});

// ── H: author kind bot ──

test("H: a sender the provider says is a bot reads as author kind bot; the bot's own id as self; agents never see bot messages", async () => {
  const s = await setup();
  const acct = await s.connect("slack", "sl");
  await s.share(acct, "knowledge", "shared");
  s.ingest(acct, s.msg(1, { senderId: "U0HUMAN001" }), s.msg(2, { senderId: "B0OTHERBOT", senderIsBot: true }), s.msg(3, { senderId: "U0APPUSER1", senderIsBot: true }), s.msg(4, { senderId: "BOT-sl" }));
  const rows = (await s.pull(acct)).rows;
  assert.deepEqual(rows.map((r) => [r.author.kind, r.author.handle]), [["person", "slack:U0HUMAN001"], ["bot", "slack:B0OTHERBOT"], ["bot", "slack:U0APPUSER1"], ["self", "slack:BOT-sl"]]);
  // a bot id (B0OTHERBOT) that is not a user id is expected, not a warning; the only warning is the test bot's own invalid Slack id
  assert.equal(s.logs.filter((l) => l.level === "warn" && l.msg.includes("not canonical")).length, 1);
  const inbox = (await s.op("channel_inbox", {}, testCtx({ db: s.db, agent: AGENT, access: { [acct]: "read" } }))) as unknown as { messages: { messageId: string }[] };
  assert.deepEqual(inbox.messages.map((m) => m.messageId), ["m1", "m4"], "bot rows never reach an agent");
});

// ── I/J: the exact catalog at the available level ──

test("I: the catalog at the available level is exactly names, kinds, counts and flags: no value, no text, no sender", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1", "Support bot");
  s.ingest(acct, s.msg(1, { text: "secret launch plan", senderName: "Anna" }), s.msg(2, { conversation: "chan-2", conversationName: "ops", senderId: "777" }));
  await s.share(acct, "knowledge", "available");
  const catalog = (await s.op("data_catalog", { account: acct }, s.ctx.knowledge)) as Record<string, unknown>;
  const oldest = new Date(T0 + 1000).toISOString();
  assert.deepEqual(catalog, {
    account: acct,
    service: "telegram",
    label: "Support bot",
    level: "available",
    datasets: [
      {
        dataset: "messages",
        title: "Messages",
        kind: "messages",
        delivery: "pull",
        contract: "messages/1",
        approxRows: 2,
        history: false,
        retentionDays: 30,
        edits: true,
        deletions: false,
        oldestAt: oldest,
        conversations: [
          { id: "chan-1", name: "general", type: "channel", approxRows: 1 },
          { id: "chan-2", name: "ops", type: "channel", approxRows: 1 },
        ],
      },
    ],
    untrusted: true,
  });
  const text = JSON.stringify(catalog);
  for (const leak of ["secret launch plan", "Anna", "123456789", "777", "m1", "m2"]) assert.ok(!text.includes(leak), `catalog leaks ${leak}`);
});

// ── PR #14 review: audit fails closed, refusals are throttled, the owner can read the access list ──

const auditCount = (db: ReturnType<typeof testDb>) => Number(db.prepare("SELECT COUNT(*) AS n FROM connect_data_audit").get()?.n);
const breakAudit = (db: ReturnType<typeof testDb>) => db.exec("CREATE TRIGGER audit_insert_fails BEFORE INSERT ON connect_data_audit BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
const repairAudit = (db: ReturnType<typeof testDb>) => db.exec("DROP TRIGGER audit_insert_fails");

test("S3-1: when the audit line cannot be written a served call answers 503 audit_unavailable and returns NO data (all three ops); refused calls stay refused", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  s.ingest(acct, s.msg(1, { text: "private words" }));
  const calls: [string, Record<string, unknown>][] = [["data_accounts_list", {}], ["data_catalog", { account: acct }], ["data_pull", { account: acct, dataset: "messages" }]];
  breakAudit(s.db);
  for (const [op, input] of calls) {
    const r = await refusal(s.op(op, input, s.ctx.knowledge));
    assert.deepEqual([r.code, r.httpStatus], ["audit_unavailable", 503], op);
    assert.ok(!JSON.stringify(r).includes("private words"));
    // a refused call is still the same refusal (no data was at stake)
    assert.equal((await refusal(s.op(op, input, s.ctx.agent))).code, "no_access");
    assert.equal((await refusal(s.op(op, input, s.ctx.unverified))).code, "caller_unverified");
  }
  assert.equal(auditCount(s.db), 0);
  assert.ok(s.logs.some((l) => l.level === "error" && /audit line could not be written/u.test(l.msg)), "the failure is an error in the log");
  repairAudit(s.db);
  const page = await s.pull(acct);
  assert.equal(page.rows.length, 1, "served again once the audit works");
  assert.equal(auditCount(s.db), 1);
});

test("S4: a refused call is audited once per minute per caller, product, op and code; the rest are counted; a served call is never folded", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1");
  await s.share(acct, "knowledge", "shared");
  for (let n = 0; n < 5; n++) await refusal(s.op("data_pull", { account: acct, dataset: "messages" }, s.ctx.observer));
  await refusal(s.op("data_catalog", { account: acct }, s.ctx.observer)); // another op: its own line
  await refusal(s.op("data_pull", { account: "cna_nope", dataset: "messages" }, s.ctx.rogue)); // another product
  for (let n = 0; n < 3; n++) await refusal(s.op("data_pull", { account: acct, dataset: "messages" }, s.ctx.unverified)); // another code
  for (let n = 0; n < 3; n++) await s.pull(acct);
  const rows = s.db.prepare("SELECT op, outcome, product, repeats FROM connect_data_audit ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { op: "data_pull", outcome: "not_found", product: "observer", repeats: 4 },
    { op: "data_catalog", outcome: "not_found", product: "observer", repeats: 0 },
    { op: "data_pull", outcome: "not_found", product: "rogue-app", repeats: 0 },
    { op: "data_pull", outcome: "caller_unverified", product: null, repeats: 2 },
    { op: "data_pull", outcome: "ok", product: "knowledge", repeats: 0 },
    { op: "data_pull", outcome: "ok", product: "knowledge", repeats: 0 },
    { op: "data_pull", outcome: "ok", product: "knowledge", repeats: 0 },
  ]);
  // after the minute the same refusal writes a new line
  s.db.prepare("UPDATE connect_data_audit SET at = at - 61000").run();
  await refusal(s.op("data_pull", { account: acct, dataset: "messages" }, s.ctx.observer));
  assert.equal(auditCount(s.db), 8);
});

test("S3-2: data_access_log gives the owner the last 100 calls, newest first, with app name, account label, rows and ok/refused; no text; apps and agents are refused", async () => {
  const s = await setup();
  const acct = await s.connect("telegram", "t1", "Support bot");
  await s.share(acct, "knowledge", "shared");
  s.ingest(acct, s.msg(1, { text: "private words" }), s.msg(2));
  await s.pull(acct);
  await refusal(s.op("data_pull", { account: acct, dataset: "messages" }, s.ctx.observer));
  await refusal(s.op("data_pull", { account: acct, dataset: "messages" }, s.ctx.observer));
  const out = (await s.op("data_access_log", {})) as unknown as { entries: Record<string, unknown>[] };
  assert.deepEqual(
    out.entries.map(({ id: _id, at: _at, ...rest }) => rest),
    [
      { op: "data_pull", callerType: "app", product: "observer", app: "Observer", account: "Support bot", ok: false, outcome: "not_found", rows: 0, repeats: 1 },
      { op: "data_pull", callerType: "app", product: "knowledge", app: "Knowledge", account: "Support bot", ok: true, outcome: "ok", rows: 2, repeats: 0 },
    ],
  );
  assert.ok(!JSON.stringify(out).includes("private words"));
  assert.match(String(out.entries[0]?.at), /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u);
  assert.equal((await refusal(s.op("data_access_log", {}, s.ctx.knowledge))).code, "no_access");
  assert.equal((await refusal(s.op("data_access_log", {}, s.ctx.agent))).code, "no_access");
  // only the last 100
  const insert = s.db.prepare("INSERT INTO connect_data_audit (at, op, outcome, caller_type, caller_id, product, row_count) VALUES (?, 'data_catalog', 'ok', 'app', ?, 'knowledge', 0)");
  for (let n = 0; n < 150; n++) insert.run(Date.now(), `ins_${n}`);
  const big = (await s.op("data_access_log", {})) as unknown as { entries: { id: number }[] };
  assert.equal(big.entries.length, 100);
  assert.ok(big.entries.every((e, i) => i === 0 || e.id < (big.entries[i - 1] as { id: number }).id), "newest first");
});

test("manifest: data_access_log is a person read without receipt", () => {
  const op = manifest.operations.find((o) => o.id === "data_access_log");
  assert.ok(op);
  assert.deepEqual([op.audience, op.effect, op.crud, op.receipt, op.idempotency], ["person", "read", ["read"], false, "none"]);
});
