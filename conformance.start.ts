// Conformance harness (CONFORMANCE §2, app target): `tb-conformance app --start conformance.start.ts` boots Connect with
// the env the suite gives it (fake bridge, enrolment code, TB_KEK, data dir) and drives it like the bridge does.
//
// Known-good fixture for the agent receipt ops (`buzz_post`, see conformance.inputs.json): the agent's Buzz identity is
// created at tether or on its first Buzz op (F20, same as production), and the relay is an in-process fake test relay (no network, no
// real people — C22).
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { defineApp, startApp, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Json, OpContext } from "@opt2-tealbrick/spec/sdk";

import { AccountStore } from "./src/accounts.ts";
import { createConnectApp, PRODUCT_SCOPE } from "./src/app.ts";
import { BuzzIdentities, WORKSPACE_SENDER } from "./src/channels/buzz/identity.ts";
import { verifyEvent } from "./src/channels/buzz/nostr.ts";
import { ChannelError, type ChannelProvider } from "./src/channels/provider.ts";
import { channelProviders } from "./src/channels/registry.ts";
import { SenderStore } from "./src/senders.ts";
import { classifyComposioTool, loadPolicies } from "./src/sources/composio/policy.ts";
import { entrySchema, ToolRegistry, toolName } from "./src/tools.ts";

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "tealbrick.manifest.json"), "utf8")) as Manifest;
/** Sentinel `sendAt` of the capsAgent setup step in tealbrick-conformance.json. */
const CONFORMANCE_SEND_AT = "conformance:in-one-hour";
const TEST_RELAY = "wss://relay.conformance.example";
const TEST_RELAY_HTTP = "https://relay.conformance.example";

/**
 * A20 fixture (conformance >= 0.1.25, C283 A1; owner state, like the Gmail fixture below). A20.owner_row_above_grant needs a
 * scoped non-read agent op (channel_send, scope type account) that RUNS for a fresh agent on an account the owner gave it a row
 * for with tb.scopes_set. Real accounts have no default grants, so the harness has one connected chat account with this FIXED
 * id; tealbrick-conformance.json (setup) gives agent A an owner row on it and conformance.inputs.json names it. The chat
 * service is an in-process fake (no network): it only has to answer verify/send.
 */
const A20_ACCOUNT_ID = "cna_01CONFORMANCEA20CHAT000000";
const A20_CONVERSATION = "conformance-a20-channel";
const fakeChatProvider: ChannelProvider = {
  service: "telegram",
  credentialFields: ["bot_token"],
  maxTextLength: 4096,
  verify: async () => ({ botId: "conformance-bot", botName: "Conformance bot" }),
  conversations: async () => [{ id: A20_CONVERSATION, name: "Conformance channel", type: "channel" }],
  send: async (_creds, _net, input) => {
    if (input.conversation !== A20_CONVERSATION) throw new ChannelError("conversation_unknown", "Unknown conformance conversation.", 404);
    return { messageId: `conformance-msg-${Date.now()}` };
  },
  edit: async () => undefined,
  delete: async () => undefined,
  react: async () => undefined,
  openDirect: async (_creds, _net, input) => ({ conversation: `conformance-dm-${input.personId}` }),
  // webhook kind: no inbound worker, no socket (the suite has no chat network).
  inbound: { kind: "webhook", verifyWebhook: async () => ({ messages: [] }) },
};
const fakeChatNet = {
  fetch: (() => Promise.reject(new Error("conformance harness: no network"))) as typeof fetch,
  webSocket: () => {
    throw new Error("conformance harness: no WebSocket");
  },
  now: () => Date.now(),
  sleep: async () => undefined,
};

/** Fake test relay: accepts signed events at POST /events; anything else is forwarded to the real fetch. */
const relayFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.origin !== TEST_RELAY_HTTP) return fetch(input, init);
  if (url.pathname === "/events" && init?.method === "POST") {
    const event = JSON.parse(String(init.body)) as unknown;
    const ok = verifyEvent(event);
    const dmOpen = ok && (event as { kind: number }).kind === 41010;
    const message = !ok ? "invalid: bad event" : dmOpen ? `response:${JSON.stringify({ channel_id: "5a7d6c2e-1f3a-4c5b-9d8e-7f6a5b4c3d2e" })}` : "";
    return Response.json({ accepted: ok, message, event_id: ok ? (event as { id: string }).id : null });
  }
  if (url.pathname === "/query") return Response.json([]);
  return new Response("not found", { status: 404 });
}) as typeof fetch;

export default async function start(env: Record<string, string>): Promise<{ url: string; stop(): Promise<void>; backupNow(): Promise<void> }> {
  const definition = createConnectApp({
    manifest,
    migrationsDir: join(import.meta.dirname, "migrations"),
    dataDir: env.TB_DATA_DIR ?? "/data",
    ErrorClass: TbError,
    fetchImpl: relayFetch,
    allowRelayOrigins: [TEST_RELAY, TEST_RELAY_HTTP],
    buzzRelays: TEST_RELAY,
    channelProviders: new Map([...channelProviders(), [fakeChatProvider.service, fakeChatProvider]]),
    channelNet: fakeChatNet,
  });
  // F20: Buzz ops create the calling agent's identity on first use, so the suite drives the real handlers unwrapped.
  // C86 fixture (owner state, like conformance.inputs.json): the owner has set a workspace Buzz sender, so the suite's
  // companion-app call (A12.companion_inbound → buzz_post) runs from it. Without one, the refusal is no_sender_identity
  // (tested in test/senders.test.ts).
  // A3.caps_count (conformance >= 0.1.21): the setup step in tealbrick-conformance.json has the fresh caps agent schedule one
  // Buzz post, so its `buzz_schedule_cancel` has a post it OWNS. `buzz_schedule` only accepts a time 30 s to 30 days ahead and a
  // fixture file cannot hold a moving time, so the fixture names the sentinel below and THIS harness (never production) turns it
  // into "one hour from now" before the real handler runs. Every other input goes to the real handler unchanged.
  const realSchedule = definition.handlers.buzz_schedule as (input: Json, ctx: OpContext) => Promise<Json>;
  const handlers = {
    ...definition.handlers,
    buzz_schedule: (input: Json, ctx: OpContext) =>
      realSchedule(input && typeof input === "object" && !Array.isArray(input) && input.sendAt === CONFORMANCE_SEND_AT ? { ...input, sendAt: new Date(Date.now() + 3_600_000).toISOString() } : input, ctx),
  };
  // A20: the chat handlers let an agent use only the account it OWNS (scope_denied otherwise). The A20 checks call the op as a
  // FRESH agent whose id the fixture file cannot name, so for the fixed fixture account (and only it) this harness hands the
  // account to the calling agent right before the real handler runs. The SDK scope gate (what A20 tests: owner row vs Portal
  // grant) runs before this and is untouched.
  const sendSpec = definition.handlers.channel_send;
  if (!sendSpec || typeof sendSpec === "function") throw new Error("conformance harness: channel_send is expected to be a handler spec");
  const sendHandler = {
    ...sendSpec,
    run: (input: Json, ctx: OpContext) => {
      const account = input && typeof input === "object" && !Array.isArray(input) ? input.account : undefined;
      if (account === A20_ACCOUNT_ID && ctx.caller.type === "agent") ctx.db.prepare("UPDATE connect_accounts SET owner_agent = ? WHERE id = ?").run(ctx.caller.id, A20_ACCOUNT_ID);
      return sendSpec.run(input, ctx);
    },
  };
  const app = defineApp({
    ...definition,
    handlers: { ...handlers, channel_send: sendHandler },
    onStart: async (ctx) => {
      const buzz = new BuzzIdentities({ db: ctx.db, secrets: ctx.secrets, relayUrls: TEST_RELAY, allowRelayOrigins: [TEST_RELAY, TEST_RELAY_HTTP] });
      await buzz.ensure({ id: WORKSPACE_SENDER, name: "Conformance workspace" });
      new SenderStore(ctx.db).set("buzz", null, "Conformance workspace");
      // C107 fixture (owner state): one connected Gmail account with its tools classified by the real Composio policy,
      // so the suite resolves real dynamic entries (A11/B16.resolve_family: a send resolves with the "outward" family).
      const accounts = new AccountStore(ctx.db);
      if (accounts.list({ service: "gmail" }).length === 0) {
        accounts.create({ service: "gmail", source: "composio", kind: "as_me", label: "Conformance inbox", externalRef: "ca_conformance", status: "connected" });
        const gmail = loadPolicies().get("gmail");
        new ToolRegistry(ctx.db).replaceService(
          "composio",
          "gmail",
          ["GMAIL_SEND_EMAIL", "GMAIL_FETCH_EMAILS", "GMAIL_DELETE_MESSAGE"].map((slug) => ({
            name: toolName(slug),
            upstream: slug,
            title: slug,
            description: slug,
            inputSchema: entrySchema({ type: "object", properties: {} }),
            ...classifyComposioTool(slug, gmail),
          })),
        );
      }
      // A20 fixture (owner state): one connected chat account with a fixed id, a fake bot and a scope instance (no row for any
      // agent; the setup step in tealbrick-conformance.json writes agent A's owner row with tb.scopes_set).
      if (!accounts.get(A20_ACCOUNT_ID)) {
        const now = Date.now();
        ctx.db
          .prepare(
            `INSERT INTO connect_accounts (id, service, source, kind, label, owner_agent, external_ref, auth_config_id, status, detail, created_at, updated_at)
             VALUES (?, 'telegram', 'channel', 'as_itself', 'Conformance chat', 'agt_01CONFORMANCEA20OWNER00000', 'conformance-bot', NULL, 'connected', '', ?, ?)`,
          )
          .run(A20_ACCOUNT_ID, now, now);
        ctx.db
          .prepare("INSERT INTO connect_channel_bots (account_id, bot_id, bot_name, workspace, settings, updated_at) VALUES (?, 'conformance-bot', 'Conformance bot', NULL, '{}', ?)")
          .run(A20_ACCOUNT_ID, now);
        await ctx.secrets.put(`account:${A20_ACCOUNT_ID}`, JSON.stringify({ bot_token: "conformance-fake-token" }));
      }
      await ctx.scopes.instances.create(PRODUCT_SCOPE, A20_ACCOUNT_ID, "Conformance chat", {});
      await definition.onStart?.(ctx);
    },
  });
  // Test roots (C63; suite default since spec 0.1.12): the suite passes TEST Portal Root Keys in TBCONF_PORTAL_ROOT_KEYS;
  // only this harness reads it and hands them to startApp. Production never reads that variable.
  // Port: the suite's free port (TBCONF_PORT, conformance >= 0.1.13), else manifest runtime.port.
  const harness = {
    ...(env.TBCONF_PORTAL_ROOT_KEYS ? { portalRootKeys: JSON.parse(env.TBCONF_PORTAL_ROOT_KEYS) } : {}),
    port: env.TBCONF_PORT ? Number(env.TBCONF_PORT) : manifest.runtime.port,
  } as Parameters<typeof startApp>[2];
  const running = await startApp(app, env, harness);
  return {
    url: `http://127.0.0.1:${running.port}`,
    stop: () => running.stop(),
    backupNow: async () => {
      await running.backups.runNow();
    },
  };
}
