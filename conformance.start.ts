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
import { createConnectApp } from "./src/app.ts";
import { BuzzIdentities, WORKSPACE_SENDER } from "./src/channels/buzz/identity.ts";
import { verifyEvent } from "./src/channels/buzz/nostr.ts";
import { SenderStore } from "./src/senders.ts";
import { classifyComposioTool, loadPolicies } from "./src/sources/composio/policy.ts";
import { entrySchema, ToolRegistry, toolName } from "./src/tools.ts";

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "tealbrick.manifest.json"), "utf8")) as Manifest;
/** Sentinel `sendAt` of the capsAgent setup step in tealbrick-conformance.json. */
const CONFORMANCE_SEND_AT = "conformance:in-one-hour";
const TEST_RELAY = "wss://relay.conformance.example";
const TEST_RELAY_HTTP = "https://relay.conformance.example";

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
  const app = defineApp({
    ...definition,
    handlers,
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
