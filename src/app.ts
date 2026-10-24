/**
 * Connect app definition for the Miniapp SDK (`defineApp`, SDK-API §3): one handler per manifest operation,
 * the dynamic `tools` family, public routes and events. Wire, auth, receipts, holds and scopes are SDK-owned.
 * Everything here is typed against the frozen contract (`@opt2-tealbrick/spec`).
 */

import { createHash } from "node:crypto";

import { channelSenderId } from "@opt2-tealbrick/manifest";
import type { AppSecrets, SdkAppDefinition, SdkOpContext, SdkPublicContext } from "@opt2-tealbrick/miniapp-sdk";
import type { CrudAction, DynamicCatalogEntry, DynamicResolution, DynamicSearchInput, Manifest } from "@opt2-tealbrick/spec/manifest";
import type { Caller, Db, DynamicHandlers, Handler, HandlerSpec, Json, Logger, OpContext, PublicHandler } from "@opt2-tealbrick/spec/sdk";

import { type Account, AccountStore, CONNECTION_KINDS, type ConnectionKind } from "./accounts.ts";
import { BuzzIdentities, WORKSPACE_SENDER } from "./channels/buzz/identity.ts";
import { parsePubkey } from "./channels/buzz/nostr.ts";
import { BuzzRefusal, BuzzRelay } from "./channels/buzz/relay.ts";
import { ChannelError, type ChannelNet, type ChannelProvider, type ChannelService as ChannelServiceId } from "./channels/provider.ts";
import { channelProviders } from "./channels/registry.ts";
import { ChannelHub, INBOX_RETENTION_MS, isChannelService } from "./channels/service.ts";
import { companionCallersFor, companionCallersKnown, companionListed, OWN_INFRA_PROVIDER, verifiedAppCaller } from "./data/caller.ts";
import { DataError, MESSAGES_DATASET, messagesCatalog, type PullInput, pullMessages } from "./data/messages.ts";
import { DATA_APPS, isDataApp, SHARE_LEVELS, type ShareLevel, ShareStore } from "./data/shares.ts";
import { classifyMcpTool, inferFromName, isInviteTool, isSendTool, namesMoney, recipientsAt, recipientsOf } from "./effect.ts";
import { gmailContentRead, holdSummary, mailFromArgs, mailFromGmail, renderHoldView } from "./hold-view.ts";
import { isSenderChannel, SENDER_CHANNELS, SENDERS_PAGE, type SenderChannel, SenderStore, senderScopeId } from "./senders.ts";
import { CatalogCallError } from "./sources/catalog/http.ts";
import { CatalogError, CatalogSource } from "./sources/catalog/source.ts";
import { ComposioClient, ComposioError, type ComposioToolkit } from "./sources/composio/client.ts";
import { loadPolicies } from "./sources/composio/policy.ts";
import { ComposioSource, connectMode } from "./sources/composio/source.ts";
import { McpError } from "./sources/mcp/client.ts";
import { OAuthError } from "./sources/mcp/oauth.ts";
import { McpSource } from "./sources/mcp/source.ts";
import { resyncToolClasses, toolClassMarker } from "./tool-resync.ts";
import { ACCOUNT_ARGUMENT, FIRST_CONTACT_SUFFIX, ToolRegistry } from "./tools.ts";
import { type FetchLike, UpstreamError } from "./util/http.ts";
import { newId } from "./util/ids.ts";
import { NetPolicyError } from "./util/net-policy.ts";
import { pinnedFetch } from "./util/pinned-fetch.ts";
import { scrubSecrets } from "./util/redact.ts";

export const PRODUCT_SCOPE = "account";
/** Characters of a Buzz post a hold view shows (a hold view over 16 000 characters is refused by the SDK). */
export const BUZZ_POST_VIEW_CHARS = 12_000;
export const COMPOSIO_KEY = "COMPOSIO_API_KEY";
export const COMPOSIO_CALLBACK_PATH = "/oauth/composio/callback";
export const MCP_CALLBACK_PATH = "/oauth/mcp/callback";
export const TEAMS_WEBHOOK_PATH = "/inbound/teams";

/** Error constructor with the SDK `TbError` shape; main.ts passes the SDK class so thrown errors map to the envelope. */
export type ErrorCtor = new (code: string, message: string, httpStatus?: number, details?: Record<string, unknown>) => Error;

export class ConnectError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: string, message: string, httpStatus = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "ConnectError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export interface ConnectEnv {
  manifest: Manifest;
  migrationsDir: string;
  ErrorClass?: ErrorCtor;
  fetchImpl?: FetchLike;
  composioBaseUrl?: string;
  composioAllowedOrigins?: readonly string[];
  /** Data volume (catalog artifact cache). */
  dataDir?: string;
  /** Exact origins allowed for catalog/MCP base URLs without the public-address check (tests). */
  catalogAllowOrigins?: readonly string[];
  /**
   * QA-CON060-1 / C292a: true when the workspace bridge admits owner rows above the Portal grant (C283 A1 bridge side). It is
   * set ONLY from the bridge capability "owner_rows" (ctx.bridgeCaps, miniapp-sdk 0.1.37 + Core C292), never from a version
   * number; until then it is false unless a test sets it, and the UI and the hints say an owner setting takes effect only
   * after a future bridge update (no version promised).
   */
  bridgeOwnerRows?: boolean;
  allowRelayOrigins?: readonly string[];
  /** Tests: injected chat providers and channel network (production: channelProviders() + pinned fetch + WebSocket). */
  channelProviders?: Map<ChannelServiceId, ChannelProvider>;
  channelNet?: ChannelNet;
  /** Manifest setting `buzz_relays` (env CONNECT_BUZZ_RELAYS): ordered relay list (C73; settings reach apps only as env, S6). */
  buzzRelays?: string | null;
  /** C133: the removed setting `buzz_relay_url` is still in the env (value never read); Buzz reports it clearly. */
  oldBuzzRelaySettingPresent?: boolean;
}

/** The SDK passes `SdkOpContext` (publicUrl, workspace, scopes, secrets: C31) where the frozen types say OpContext. */
const extras = (ctx: OpContext): SdkOpContext => ctx as SdkOpContext;
type ServiceCtx = { db: Db; getKey(name: string): Promise<string | null>; secrets?: AppSecrets; log?: Logger };

type Input = Record<string, unknown>;
const asInput = (value: Json): Input => (value && typeof value === "object" && !Array.isArray(value) ? (value as Input) : {});
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
/** Optional agent argument `relays` (C73): narrow to some of the agent's own relays. */
const relaysArg = (value: unknown): { relays?: string[] } => {
  if (!Array.isArray(value)) return {};
  const relays = value.filter((r): r is string => typeof r === "string" && r.trim().length > 0).slice(0, 8);
  return relays.length > 0 ? { relays } : {};
};

interface Services {
  accounts: AccountStore;
  tools: ToolRegistry;
  secrets: AppSecrets;
  composio: ComposioSource;
  buzz: BuzzIdentities;
  relay: BuzzRelay;
  catalog: CatalogSource;
  mcp: McpSource;
  channels: ChannelHub;
  senders: SenderStore;
  shares: ShareStore;
}

export function createConnectApp(env: ConnectEnv): SdkAppDefinition {
  const Err: ErrorCtor = env.ErrorClass ?? ConnectError;
  const fail = (code: string, message: string, status = 400, details?: Record<string, unknown>): never => {
    throw new Err(code, message, status, details);
  };
  const policies = loadPolicies();
  // C276a: a policy edit changes tool classes, so it is part of the re-sync marker.
  const policyDigest = createHash("sha256")
    .update(JSON.stringify([...policies.values()].sort((a, b) => (a.toolkit < b.toolkit ? -1 : 1))))
    .digest("hex")
    .slice(0, 16);
  const toolkitCache = new ToolkitCache();
  let cache: { db: Db; services: Services } | null = null;
  /** One outbound fetch: injected (tests) or pinned-connect (SEC-09), with exact allowlisted test hosts. */
  const allowHosts = [...(env.allowRelayOrigins ?? []), ...(env.catalogAllowOrigins ?? []), ...(env.composioAllowedOrigins ?? [])].map((o) => new URL(o).hostname);
  const outbound: FetchLike = env.fetchImpl ?? pinnedFetch(allowHosts);

  /** Composio client from the current key: app-own key wins over the workspace default (SDK getKey, C12). */
  const composioClient = async (getKey: (name: string) => Promise<string | null>): Promise<ComposioClient> => {
    const apiKey = await getKey(COMPOSIO_KEY);
    if (!apiKey) throw new ComposioError("composio_key_missing", "Add your Composio API key on the workspace key page first.", 409);
    return new ComposioClient({
      apiKey,
      ...(env.composioBaseUrl ? { baseUrl: env.composioBaseUrl } : {}),
      ...(env.composioAllowedOrigins ? { allowedOrigins: env.composioAllowedOrigins } : {}),
      fetchImpl: outbound,
    });
  };

  /** Services are bound to the SDK database handle (one process, one db). */
  const services = (ctx: ServiceCtx): Services => {
    const { db, getKey } = ctx;
    if (cache && cache.db === db) return cache.services;
    const secrets = ctx.secrets ?? fail("secrets_unavailable", "The SDK did not provide app secrets.", 500);
    const accounts = new AccountStore(db);
    const tools = new ToolRegistry(db);
    const composio = new ComposioSource({
      db,
      accounts,
      tools,
      policies,
      client: () => composioClient(getKey),
      ...(ctx.log ? { log: ctx.log } : {}),
    });
    const buzz = new BuzzIdentities({
      db,
      secrets,
      relayUrls: env.buzzRelays ?? null,
      oldRelaySettingPresent: env.oldBuzzRelaySettingPresent === true,
      ...(env.allowRelayOrigins ? { allowRelayOrigins: env.allowRelayOrigins } : {}),
    });
    const relay = new BuzzRelay(buzz, outbound);
    const catalog = new CatalogSource({
      artifact: env.manifest.artifacts?.find((a) => a.id === "catalog"),
      dataDir: env.dataDir ?? "/data",
      accounts,
      tools,
      secrets,
      fetchImpl: outbound,
      ...(env.catalogAllowOrigins ? { allowOrigins: env.catalogAllowOrigins } : {}),
    });
    const mcp = new McpSource({
      db,
      accounts,
      tools,
      secrets,
      fetchImpl: outbound,
      ...(env.catalogAllowOrigins ? { allowOrigins: env.catalogAllowOrigins } : {}),
    });
    const channels = new ChannelHub({
      db,
      accounts,
      secrets,
      providers: env.channelProviders ?? channelProviders(),
      net: env.channelNet ?? {
        fetch: outbound,
        webSocket: (url) => new WebSocket(url),
        now: () => Date.now(),
        sleep: (ms, signal) => sleepFor(ms, signal),
      },
      ...(ctx.log ? { log: ctx.log } : {}),
    });
    const built = { accounts, tools, secrets, composio, buzz, relay, catalog, mcp, channels, senders: new SenderStore(db), shares: new ShareStore(db) };
    cache = { db, services: built };
    return built;
  };

  /** Map module errors to the SDK error envelope. */
  const guard = <T>(fn: () => Promise<T>): Promise<T> =>
    fn().catch((error: unknown) => {
      if (error instanceof Err) throw error;
      if (error instanceof ComposioError) fail(error.code, error.message, error.status);
      if (error instanceof NetPolicyError) fail(error.code, error.message, 422);
      if (error instanceof CatalogError) fail(error.code, error.message, error.code === "catalog_app_unknown" || error.code === "tool_unknown" ? 404 : 400);
      if (error instanceof BuzzRefusal) fail(error.code, error.message, error.httpStatus);
      if (error instanceof ChannelError) fail(error.code, error.message, error.httpStatus);
      if (error instanceof DataError) fail(error.code, error.message, error.httpStatus);
      if (error instanceof UpstreamError) fail(error.code, error.message.slice(0, 300), error.status && error.status < 500 ? 409 : 502);
      if (error instanceof OAuthError) fail(error.code, error.message, 502);
      if (error instanceof McpError) fail(error.code, error.message, error.status && error.status < 500 ? 409 : 502);
      if (error instanceof CatalogCallError) fail(error.code, error.message, error.status && error.status < 500 ? 409 : 502);
      if (error instanceof Error && /^[a-z_]+(?::|$)/u.test(error.message)) fail(error.message.split(":")[0] ?? "connect_error", error.message, 400);
      throw error;
    });

  const accountView = (a: Account) => ({
    id: a.id,
    service: a.service,
    source: a.source,
    kind: a.kind,
    label: a.label,
    ownerAgent: a.ownerAgent,
    status: a.status,
    detail: a.detail,
  });

  /** Workspace id: from the SDK context (slice / person principal), else the verified grant. C12: Composio user_id. */
  const workspace = (ctx: OpContext): string =>
    extras(ctx).workspace ?? ctx.grant?.claims.ws ?? fail("workspace_unknown", "The workspace id is not known yet. Wait for the first workspace sync.", 503);
  const agentsOf = (db: Db): { id: string; name: string }[] =>
    db.prepare("SELECT id, name FROM connect_agents ORDER BY name, id").all().map((r) => ({ id: String(r.id), name: String(r.name) }));
  /**
   * F20 (C106): Buzz identity on tether. An agent that reaches Connect's slice (an edge to Connect) gets its Buzz key at
   * once: no owner step, no first Buzz call. Key only (no relay traffic, no profile publish). Runs from agentAdded and as
   * an onStart sweep; event contexts carry no app secrets, so before onStart built the services the sweep does the work.
   * Uses the same per-agent serialized ensure() as the Buzz ops (which still self-heal if this failed).
   */
  const tetherBuzz = async (db: Db, log: Logger): Promise<void> => {
    const built = cache && cache.db === db ? cache.services : null;
    if (!built) return;
    for (const agent of agentsOf(db)) {
      if (built.buzz.get(agent.id)) continue;
      try {
        await built.buzz.ensure(agent);
      } catch (e) {
        // L3: not silent. The agent's first Buzz op retries the same ensure().
        log.error("buzz identity on tether failed", { agent: agent.id, code: (e as { code?: string }).code ?? "error" });
      }
    }
  };

  /** Accounts of one service this caller may use for a tool with the given CRUD class. */
  const usableAccounts = async (ctx: OpContext, s: Services, service: string, crud: readonly CrudAction[]): Promise<Account[]> => {
    const out: Account[] = [];
    for (const account of s.accounts.list({ service, status: "connected" })) {
      if (account.kind === "as_itself" && account.ownerAgent !== ctx.caller.id) continue;
      let allowed = true;
      for (const action of crud) {
        if (!(await ctx.scope.can(PRODUCT_SCOPE, account.id, action))) {
          allowed = false;
          break;
        }
      }
      if (allowed) out.push(account);
    }
    return out;
  };


  // ── callers and sender identities (C86, F20) ──

  /** C86: an app caller with no workspace sender for this channel (409, not retryable; names the settings page). */
  const noSender = (channel: SenderChannel): never =>
    fail("no_sender_identity", `No workspace sender identity is set for ${channel}. Apps send only from it; the owner picks it in ${SENDERS_PAGE}.`, 409, {
      retryable: false,
      channel,
    });
  /** Ops that read or change an agent's own Buzz/chat state serve agents only; apps use the send ops. */
  const agentOnly = (ctx: OpContext): string =>
    ctx.caller.type === "agent"
      ? ctx.caller.id
      : fail("agent_only", "This operation serves agents only. Apps send from the workspace sender with buzz_post, buzz_dm_first, buzz_dm, channel_send, channel_reply, channel_dm_first or channel_dm.", 403);
  /** F20: the calling agent's Buzz key (created at tether by tetherBuzz; ensure() here only self-heals a failed tether). */
  const buzzAgent = async (ctx: OpContext, s: Services): Promise<string> => {
    const id = agentOnly(ctx);
    const row = ctx.db.prepare("SELECT name FROM connect_agents WHERE id = ?").get(id);
    await s.buzz.ensure({ id, name: row ? String(row.name) : ctx.caller.name });
    return id;
  };
  interface SenderUsed {
    /** key the Buzz relay signs with (agent id or WORKSPACE_SENDER) */
    key: string;
    kind: "agent" | "workspace";
    /** "<channel>:<value>" (SDK-API §18) — recorded on the receipt */
    handle: string;
  }
  /** Buzz send ops: an agent sends as itself; a companion app as the workspace sender (C86). */
  const buzzSender = async (ctx: OpContext, s: Services): Promise<SenderUsed> => {
    if (ctx.caller.type === "app") {
      const identity = s.senders.get("buzz") ? s.buzz.get(WORKSPACE_SENDER) : null;
      if (!identity) return noSender("buzz");
      return { key: WORKSPACE_SENDER, kind: "workspace", handle: channelSenderId("buzz", identity.npub) };
    }
    const key = await buzzAgent(ctx, s);
    const identity = s.buzz.get(key);
    return { key, kind: "agent", handle: channelSenderId("buzz", identity?.npub ?? key) };
  };
  const senderMeta = (sender: { kind: "agent" | "workspace"; handle: string }) => ({
    subjectKind: sender.kind === "workspace" ? "workspace_sender" : "as_itself",
    sender: sender.handle,
  });
  const chatHandle = (s: Services, account: Account): string => channelSenderId(account.service, s.channels.bot(account.id)?.botId ?? account.externalRef ?? account.id);
  /** Chat service an op targets from its `account` input: a channel account id, or (apps) the service name itself. */
  const serviceOfInput = (value: unknown): ChannelServiceId | null => {
    const v = str(value);
    if (!v) return null;
    if (isChannelService(v)) return v;
    if (v.startsWith("sender:") && isChannelService(v.slice(7))) return v.slice(7) as ChannelServiceId;
    const account = cache?.services.accounts.get(v);
    return account?.source === "channel" && isChannelService(account.service) ? account.service : null;
  };
  /** Scope target of a chat SEND op: the agent's own account; for an app the shared `sender:<service>` instance. */
  const sendScope = (input: Json, caller: Caller): string | null => {
    const account = str(asInput(input).account) ?? null;
    if (caller.type !== "app") return account;
    const service = serviceOfInput(account);
    return service ? senderScopeId(service) : account;
  };
  /** An agent's own chat account. `sender:*` scope rows (shared defaults) never let an agent use the workspace sender. */
  const ownChannel = (ctx: OpContext, s: Services, raw: unknown): Account => {
    const id = String(raw ?? "");
    agentOnly(ctx);
    if (id.startsWith("sender:")) fail("sender_reserved_for_apps", "The workspace sender is for companion apps only. Send from your own bot account.", 403);
    return s.channels.account(id, ctx.caller.id);
  };
  /** Chat send ops: an agent sends from its own bot; a companion app from the workspace sender of that service (C86). */
  const chatSender = (ctx: OpContext, s: Services, raw: unknown): { account: Account } & Omit<SenderUsed, "key"> => {
    if (ctx.caller.type !== "app") {
      const account = ownChannel(ctx, s, raw);
      return { account, kind: "agent", handle: chatHandle(s, account) };
    }
    const service = serviceOfInput(raw) ?? fail("channel_account_unknown", "Give the chat service (slack, teams, telegram or discord) or a Connect channel account id.", 404);
    const sender = s.senders.get(service);
    const account = sender?.account ? s.accounts.get(sender.account) : null;
    if (!sender || !account || account.source !== "channel" || account.status !== "connected") return noSender(service);
    return { account, kind: "workspace", handle: chatHandle(s, account) };
  };
  /** identities_list rows (C81 G6): channel identity handles of agents only — never secrets, names or message data (C88). */
  const identityRows = (s: Services, only: string | null): IdentityRow[] => {
    const rows: IdentityRow[] = [];
    for (const identity of s.buzz.list()) if (identity.agent.startsWith("agt_")) rows.push({ agent: identity.agent, channel: "buzz", identity: channelSenderId("buzz", identity.npub) });
    for (const account of s.accounts.list({ status: "connected" }))
      if (account.source === "channel" && account.ownerAgent) rows.push({ agent: account.ownerAgent, channel: account.service, identity: chatHandle(s, account) });
    return rows.filter((r) => only === null || r.agent === only).sort((x, y) => (rowKey(x) < rowKey(y) ? -1 : rowKey(x) > rowKey(y) ? 1 : 0));
  };
  const senderView = (s: Services, channel: SenderChannel) => {
    const row = s.senders.get(channel);
    if (!row) return { channel, set: false, label: null, account: null, identity: null, setAt: null };
    let identity: string | null = null;
    if (channel === "buzz") {
      const buzz = s.buzz.get(WORKSPACE_SENDER);
      identity = buzz ? channelSenderId("buzz", buzz.npub) : null;
    } else if (row.account) {
      const account = s.accounts.get(row.account);
      identity = account ? chatHandle(s, account) : null;
    }
    return { channel, set: true, label: row.label, account: row.account, identity, setAt: new Date(row.setAt).toISOString() };
  };
  const decodeCursor = (cursor: string): string => {
    try {
      const key = Buffer.from(cursor, "base64url").toString("utf8");
      if (key.split("\u0000").length === 3) return key;
    } catch {
      // fall through
    }
    return fail("cursor_invalid", "cursor is not one this op returned.");
  };
  const firstContactHint = (ctx: OpContext, op: string): string =>
    ctx.caller.type === "app"
      ? `The workspace sender has not written to this person before. Call ${op} once (the owner approves first contact); later messages use the normal op.`
      : `You have not written to this person before. Use ${op}; the owner approves first contact.`;

  /**
   * CF-PZ-1 / CF-PZ-4 + Coordinator 2026-10-20: tell the agent WHY tools it sees (or does not see) cannot be used. Tool search
   * runs without a caller, so the reasons are given here: (1) a connected service with no account assigned to this caller;
   * (2) tools the bridge hides because the Portal grant lacks their CRUD; (3) tools above the account access the owner gave.
   * Counts and CRUD words only, never tool arguments.
   */
  const accessHints = (s: Services, only: string | undefined, allowedBy: Map<string, Set<CrudAction>>, grantCrud: readonly CrudAction[] | null, callerType: string): string[] => {
    if (callerType !== "agent") return [];
    const hints: string[] = [];
    const need = (tools: readonly { crud: readonly CrudAction[] }[], has: (a: CrudAction) => boolean) =>
      (["create", "update", "delete"] as const).filter((a) => tools.some((t) => t.crud.includes(a) && !has(a)));
    for (const service of s.accounts.connectedServices()) {
      if (only && service !== only) continue;
      const tools = s.tools.forService(service);
      if (tools.length === 0) continue;
      const allowed = allowedBy.get(service);
      if (!allowed) {
        hints.push(`No ${service} account is assigned to you: ask the owner to assign one in Connect > Accounts.`);
        continue;
      }
      if (grantCrud) {
        const hidden = tools.filter((t) => !t.crud.every((a) => grantCrud.includes(a)));
        if (hidden.length > 0) {
          hints.push(
            env.bridgeOwnerRows === true
              ? `${hidden.length} ${service} tool${hidden.length === 1 ? " needs" : "s need"} more than your Portal grant allows (need: ${need(hidden, (a) => grantCrud.includes(a)).join(", ")}). They are hidden unless the owner set your access to this account in Connect: ask the owner to set it there or to raise your Connect grant.`
              : `${hidden.length} ${service} tool${hidden.length === 1 ? " needs" : "s need"} more than your Portal grant allows (need: ${need(hidden, (a) => grantCrud.includes(a)).join(", ")}): ask the owner to raise your Connect grant. An access setting in Connect takes effect only after a future bridge update.`,
          );
        }
      }
      const above = tools.filter((t) => !t.crud.every((a) => allowed.has(a)) && (!grantCrud || t.crud.every((a) => grantCrud.includes(a))));
      if (above.length > 0) {
        hints.push(
          `${above.length} ${service} tool${above.length === 1 ? " needs" : "s need"} more account access than you have (need: ${need(above, (a) => allowed.has(a)).join(", ")}): ask the owner to raise your access in Connect > Accounts.`,
        );
      }
    }
    return hints.slice(0, 20);
  };

  /** Catalog arguments are grouped by location; the hold view reads them as one flat object (body wins over query and path). */
  const flattenGroups = (args: Record<string, unknown>): Record<string, unknown> => {
    const pick = (k: string) => (args[k] && typeof args[k] === "object" && !Array.isArray(args[k]) ? (args[k] as Record<string, unknown>) : {});
    return { ...pick("path"), ...pick("query"), ...pick("body") };
  };

  /** The ONE account choice of a dynamic tool call (the call and its hold view use the same account). */
  const pickAccount = async (ctx: OpContext, s: Services, row: { service: string; crud: readonly CrudAction[] }, selector: unknown): Promise<Account> => {
    const usable = await usableAccounts(ctx, s, row.service, row.crud);
    let account: Account | undefined;
    const wanted = str(selector);
    if (wanted) {
      const all = s.accounts.list({ service: row.service, status: "connected" });
      const match = all.find((a) => a.id === wanted) ?? all.find((a) => a.label.toLowerCase() === wanted.toLowerCase());
      if (!match) fail("account_unknown", `No connected ${row.service} account named "${wanted}".`, 404);
      account = usable.find((a) => a.id === match?.id) ?? fail("scope_denied", `Your access to "${match?.label}" does not allow this tool.`, 403);
    } else if (usable.length === 1) {
      account = usable[0];
    } else if (usable.length === 0) {
      fail("scope_denied", `You have no ${row.service} account with access for this tool. Ask the owner to raise your access in Connect.`, 403);
    } else {
      fail("account_ambiguous", `Pick one account with "${ACCOUNT_ARGUMENT}": ${usable.map((a) => a.label).join(", ")}.`, 409);
    }
    return account ?? fail("scope_denied", "No usable account.", 403);
  };

  const dynamicTools: DynamicHandlers = {
    async catalog(query: DynamicSearchInput | null, ctx): Promise<DynamicCatalogEntry[]> {
      const s = services(ctx);
      return s.tools.search(query?.query ?? "", s.accounts.connectedServices(), query?.limit ?? 20);
    },
    async resolve(tool: string, ctx): Promise<DynamicResolution | null> {
      return services(ctx).tools.resolve(tool);
    },
    async call(tool, args, ctx): Promise<Json> {
      return guard(async () => {
        const s = services(ctx);
        // X-02: `<tool>__first_contact` = the same send tool, resolved with hold family first_contact (owner approved it).
        const firstContact = tool.endsWith(FIRST_CONTACT_SUFFIX);
        const baseName = firstContact ? tool.slice(0, -FIRST_CONTACT_SUFFIX.length) : tool;
        const row = s.tools.get(baseName) ?? fail("tool_unknown", `Unknown tool ${tool}. Search first.`, 404);
        const send = isSendTool(row);
        if (firstContact && !send) fail("tool_unknown", `Unknown tool ${tool}. Only send tools have a first-contact form.`, 404);
        const { [ACCOUNT_ARGUMENT]: selector, ...upstreamArgs } = args;
        const account = await pickAccount(ctx, s, row, selector);
        // C276c: a catalog send names where its recipients are; other send tools use the top-level recipient arguments (X-02).
        const recipients = !send ? [] : row.sendRecipients !== undefined ? recipientsAt(upstreamArgs, row.sendRecipients) : recipientsOf(upstreamArgs);
        if (send && !firstContact) {
          const caller = ctx.caller.id;
          const accountId = account.id;
          const unknown = recipients.filter((r) => !ctx.db.prepare("SELECT 1 FROM connect_tool_contacts WHERE caller = ? AND account = ? AND address = ?").get(caller, accountId, r));
          // CF-GC-1: an invite tool with no attendees invites nobody; every other send with no visible recipient fails closed.
          if ((recipients.length === 0 && !isInviteTool(row)) || unknown.length > 0) {
            const firstName = `${row.name}${FIRST_CONTACT_SUFFIX}`;
            const who = recipients.length === 0 ? "Connect cannot see the recipients of this call" : `${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ` and ${unknown.length - 5} more` : ""} ${unknown.length === 1 ? "is" : "are"} new to you on ${account.label}`;
            fail("first_contact_required", `${who}. Call the tool ${firstName} with the same arguments; the owner approves this first contact once. Later messages to known people use ${row.name}.`, 409, {
              retryable: false,
              tool: firstName,
              recipients: unknown.slice(0, 20),
            });
          }
        }
        ctx.receipt.summary(`${row.title} via ${account.label}${firstContact ? " (first contact)" : ""}`.slice(0, 280));
        ctx.receipt.meta({ subjectKind: account.kind, tool: row.upstream, service: row.service, account: account.label });
        let data: unknown;
        if (row.source === "composio") data = await s.composio.execute(account, row.upstream, upstreamArgs, workspace(ctx));
        else if (row.source === "catalog") data = await s.catalog.execute(account, row.name, upstreamArgs);
        else if (row.source === "mcp") data = await s.mcp.execute(account, row.upstream, upstreamArgs);
        else fail("source_not_ready", `${row.source} tools are not available yet.`, 501);
        if (send) rememberToolContacts(ctx.db, ctx.caller.id, account.id, recipients);
        return { account: account.label, untrusted: true, data: (data ?? null) as Json };
      });
    },
    /**
     * SDK-HV-1 / QA R-1 (miniapp-sdk 0.1.23): the owner sees what a held SEND tool would send — recipients, subject, the first
     * 500 characters as plain text, attachment names and sizes. A Gmail draft send (and a forward) READS the draft/message
     * with the same account the call would use (read only; never sends, never renders HTML). Other tools: null (default view).
     * A throw here (draft not found, upstream down) makes the SDK show the default view with "could not read"; the hold stays.
     */
    async holdView(tool, args, ctx) {
      const s = services(ctx);
      const firstContact = tool.endsWith(FIRST_CONTACT_SUFFIX);
      const row = s.tools.get(firstContact ? tool.slice(0, -FIRST_CONTACT_SUFFIX.length) : tool);
      if (!row || !isSendTool(row)) return null;
      const { [ACCOUNT_ARGUMENT]: selector, ...upstreamArgs } = args;
      const account = await pickAccount(ctx, s, row, selector);
      const heading = `${row.title} (${row.service})${firstContact ? ", first contact" : ""}`;
      // Review #19 S2-2: catalog arguments are grouped ({path, query, body}); the owner must see the recipient, subject and text.
      const flat = row.source === "catalog" ? flattenGroups(upstreamArgs) : upstreamArgs;
      let mail = mailFromArgs(flat);
      const notes: string[] = [];
      if (row.sendRecipients !== undefined) {
        const shown = new Set([...mail.to, ...mail.cc, ...mail.bcc]);
        for (const r of recipientsAt(upstreamArgs, row.sendRecipients)) if (!shown.has(r)) mail.to.push(r);
        if (row.sendRecipients.length === 0 || recipientsAt(upstreamArgs, row.sendRecipients).length === 0) {
          notes.push("Connect cannot see who receives this: the app may email the person stored on the record (for example the ticket's customer).");
        }
      }
      const read = row.source === "composio" ? gmailContentRead(row.upstream, upstreamArgs) : null;
      if (read) {
        const data = await s.composio.execute(account, read.slug, read.args, workspace(ctx));
        const found = mailFromGmail(data) ?? fail("hold_view_unreadable", "The draft or message has no readable content.", 502);
        if (read.kind === "draft") {
          mail = found;
          notes.push(`Draft: ${String(upstreamArgs.draft_id)} (content read from the mailbox now; a later change to the draft needs a new approval)`);
        } else {
          // forward: the recipients come from the arguments, the content from the forwarded message
          mail = { ...found, to: mail.to, cc: mail.cc, bcc: mail.bcc, text: [mail.text, found.text].filter((t) => t).join("\n\n---------- Forwarded message ----------\n") || null };
          notes.push(`Forwards message ${String(upstreamArgs.message_id)} (read from the mailbox now)`);
        }
      }
      const key = row.source === "composio" ? await ctx.getKey(COMPOSIO_KEY) : null;
      const scrub = (t: string) => (key ? scrubSecrets(t, [key]) : t);
      return { summary: scrub(holdSummary(heading, mail)), view: scrub(renderHoldView({ heading, account: account.label, mail, notes })) };
    },
  };

  // ── data_* op family (C230 R3): apps only, one confused-deputy rule for all three ops ──

  /**
   * The calling app's VERIFIED product id (ctx.caller.product, miniapp-sdk >= 0.1.27) and its verified instance id (C240).
   * Persons and agents: no_access. An app caller without a verified product is refused (fail closed): never its name or an
   * input field. Shares match on BOTH (ShareStore.forCaller), so a reinstalled app needs a new share.
   */
  const dataCaller = (ctx: OpContext): { product: string; instance: string } => {
    if (ctx.caller.type !== "app") return fail("no_access", "The data operations serve apps only. Agents and people cannot use them.", 403);
    return verifiedAppCaller(ctx) ?? fail("caller_unverified", "The calling app has no verified product, so it cannot use the data operations.", 403);
  };
  /**
   * C240 call-time check (Coordinator): a bound share serves only while the caller instance is STILL listed under its product
   * in the current signed slice (`ctx.caller.listed`, sdk 0.1.32). A removed instance may still hold a valid grant `prd`: refused
   * `share_instance_gone`. An SDK without the flag is refused `companion_list_unavailable` (fail closed). Both are audited.
   */
  const LIST_RETRY = { retryable: true, retryAfterMs: 30_000 } as const;
  const stillListed = (ctx: OpContext): void => {
    const state = companionListed(ctx);
    // retryable (Coordinator, like C261 caller_unverified): a fresh companion whose grant arrives before the slice lists it
    // retries after the slice catches up instead of failing hard
    if (state === "gone") fail("share_instance_gone", "This app instance is not in the workspace list now, so it cannot read shared accounts. Try again later.", 403, LIST_RETRY);
    if (state === "unknown") fail("companion_list_unavailable", "Connect cannot check that this app is still installed. Update Connect.", 503, LIST_RETRY);
  };
  /** The ONE refusal for every account the calling app cannot see (unknown, not a chat account, not connected, not shared with it). */
  const noSuchAccount = (): never => fail("not_found", "No such account.", 404);
  const dataAccount = (s: Services, ctx: OpContext, raw: unknown, need: "available" | "shared", note?: { product?: string | null }): { account: Account; level: "available" | "shared"; product: string; since: number | null } => {
    const { product, instance } = dataCaller(ctx);
    if (note) note.product = product;
    const id = str(raw);
    const account = id ? s.accounts.get(id) : null;
    if (account?.source !== "channel" || account.status !== "connected") return noSuchAccount();
    // C240: the share must be bound to this product AND this instance (a row from before 0013 has no instance: no match)
    const share = s.shares.forCaller(account.id, product, instance);
    if (!share) return noSuchAccount();
    stillListed(ctx);
    if (need === "shared" && share.level !== "shared") fail("scope_denied", "This account is shared with you for its catalog only. Ask the owner to share it for reading.", 403);
    return { account, level: share.level, product, since: share.includeHistory ? null : share.setAt };
  };
  /**
   * One share as the owner page shows it. `current` (C240): the bound instance is still an app that can call Connect (in the
   * current signed slice). false = the app was removed or reinstalled, or the row is from before 0013: it serves no call
   * and the owner shares again.
   */
  const shareView = (r: { product: string; instance: string | null; level: string; includeHistory: boolean; setAt: number }, callers: { product: string; instance: string }[]) => ({
    product: r.product,
    instance: r.instance,
    current: r.instance !== null && callers.some((c) => c.instance === r.instance && c.product === r.product),
    level: r.level,
    includeHistory: r.includeHistory,
    setAt: new Date(r.setAt).toISOString(),
  });
  /** The data apps the owner can share with (C240): each verified instance of a known data product, with where it runs. */
  const dataTargets = (ctx: OpContext) => {
    const callers = companionCallersFor(ctx).filter((c) => isDataApp(c.product));
    return {
      callers,
      dataApps: Object.entries(DATA_APPS).map(([product, name]) => ({
        product,
        name,
        instances: callers
          .filter((c) => c.product === product)
          .map((c) => ({ instance: c.instance, name: c.name, provider: c.provider, ownInfra: c.provider === OWN_INFRA_PROVIDER })),
      })),
    };
  };
  const messagesDeps = (s: Services, ctx: OpContext) => ({
    db: ctx.db,
    log: ctx.log,
    botId: (accountId: string) => s.channels.bot(accountId)?.botId ?? null,
    history: (service: string) => {
      try {
        return s.channels.provider(service).readsHistory === true;
      } catch {
        return false;
      }
    },
  });
  const timeArg = (value: unknown, name: string): number | null => {
    const v = str(value);
    if (v === undefined) return null;
    const ms = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u.test(v) ? Date.parse(v) : Number.NaN;
    return Number.isNaN(ms) ? fail(`${name}_invalid`, `${name} must be an RFC 3339 time, for example 2026-10-17T10:00:00Z.`) : ms;
  };

  interface AuditNote {
    product?: string | null;
    account?: string;
    dataset?: string;
    rows?: number;
    quarantined?: number;
  }
  /**
   * One audit line per data_* call (who called: type and id; which op; the verified product when there is one; account,
   * dataset, row count). Never message text. The account and dataset are recorded as the caller named them (clipped),
   * because a refusal has no resolved account.
   *
   * FAIL CLOSED: a SERVED call writes its line BEFORE the answer is returned; when the line cannot be written the call
   * answers 503 `audit_unavailable` and the data is dropped (nothing leaves unrecorded). A REFUSED call carries no data, so
   * it stays refused when its line cannot be written (the failure is an error in the log). Refused calls are throttled: the
   * same caller, product, op and code write one line per minute, and `repeats` counts the rest.
   */
  const audited = async (op: string, ctx: OpContext, input: Json, body: (note: AuditNote) => Promise<Json>): Promise<Json> => {
    const i = asInput(input);
    const note: AuditNote = {
      ...(typeof i.account === "string" ? { account: i.account.slice(0, 64) } : {}),
      ...(typeof i.dataset === "string" ? { dataset: i.dataset.slice(0, 64) } : {}),
    };
    const logLine = (outcome: string) => ctx.log.info(op, { outcome, caller: ctx.caller.type, app: note.product ?? null, account: note.account ?? null, rows: note.rows ?? 0, quarantined: note.quarantined ?? 0 });
    const insert = (outcome: string, now: number) =>
      ctx.db
        .prepare("INSERT INTO connect_data_audit (at, op, outcome, caller_type, caller_id, product, account_id, dataset, row_count, quarantined) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(now, op, outcome, ctx.caller.type, ctx.caller.id, note.product ?? null, note.account ?? null, note.dataset ?? null, note.rows ?? 0, note.quarantined ?? 0);
    const recordRefused = (outcome: string) => {
      try {
        const now = Date.now();
        const same = ctx.db
          .prepare("SELECT id FROM connect_data_audit WHERE at > ? AND op = ? AND outcome = ? AND caller_type = ? AND caller_id = ? AND product IS ? ORDER BY id DESC LIMIT 1")
          .get(now - AUDIT_REFUSAL_WINDOW_MS, op, outcome, ctx.caller.type, ctx.caller.id, note.product ?? null);
        if (same) ctx.db.prepare("UPDATE connect_data_audit SET repeats = repeats + 1 WHERE id = ?").run(Number(same.id));
        else insert(outcome, now);
        logLine(outcome);
      } catch (error) {
        ctx.log.error("data audit line could not be written", { op, error: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
      }
    };
    let out: Json;
    try {
      out = await body(note);
    } catch (error) {
      recordRefused(typeof (error as { code?: unknown }).code === "string" ? String((error as { code: string }).code).slice(0, 64) : "error");
      throw error;
    }
    try {
      insert("ok", Date.now());
    } catch (error) {
      ctx.log.error("data audit line could not be written; the answer is withheld", { op, error: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
      return fail("audit_unavailable", "Connect could not record this access, so it sent no data. Try again later.", 503, { retryable: true });
    }
    logLine("ok");
    return out;
  };

  const handlers: Record<string, Handler | HandlerSpec> = {
    // ── agent-audience data ops (apps only; the handler refuses everyone else) ──
    async data_accounts_list(input, ctx) {
      return audited("data_accounts_list", ctx, input, async (note) =>
        guard(async () => {
          const s = services(ctx);
          const { product, instance } = dataCaller(ctx);
          note.product = product;
          const bound = s.shares.accountsForCaller(product, instance);
          if (bound.length > 0) stillListed(ctx);
          const accounts = bound.flatMap((share) => {
            const a = s.accounts.get(share.account);
            return a?.source === "channel" && a.status === "connected"
              ? [{ account: a.id, service: a.service, label: a.label, kinds: ["messages"], level: share.level }]
              : [];
          });
          return { accounts } as unknown as Json;
        }),
      );
    },
    async data_catalog(input, ctx) {
      return audited("data_catalog", ctx, input, async (note) =>
        guard(async () => {
          const s = services(ctx);
          const { account, level } = dataAccount(s, ctx, asInput(input).account, "available", note);
          note.account = account.id;
          const history = messagesDeps(s, ctx).history(account.service);
          const reports = s.channels.provider(account.service).reports ?? { edits: false, deletions: false };
          return { account: account.id, service: account.service, label: account.label, level, datasets: [messagesCatalog(ctx.db, account, history, INBOX_RETENTION_MS, reports)], untrusted: true } as unknown as Json;
        }),
      );
    },
    async data_pull(input, ctx) {
      return audited("data_pull", ctx, input, async (note) =>
        guard(async () => {
          const s = services(ctx);
          const i = asInput(input);
          const { account, since: ingestedFrom } = dataAccount(s, ctx, i.account, "shared", note);
          note.account = account.id;
          if (str(i.dataset) !== MESSAGES_DATASET) fail("not_found", "No such dataset on this account.", 404);
          const direction = i.direction === "backward" ? "backward" : "forward";
          const pull: PullInput = {
            direction,
            cursor: str(i.cursor) ?? null,
            since: timeArg(i.since, "since"),
            until: timeArg(i.until, "until"),
            ingestedFrom,
            limit: typeof i.limit === "number" ? i.limit : 100,
          };
          const page = pullMessages(messagesDeps(s, ctx), account, pull);
          note.rows = page.rows.length;
          note.quarantined = page.quarantined ?? 0;
          return { ...page, schema: "messages/1", untrusted: true } as unknown as Json;
        }),
      );
    },

    // ── agent ops ──
    accounts_list: {
      // No manifest scopeType: an agent with no account access yet gets an empty list, not a scope refusal.
      // The handler filters every account by the caller's own scope access (ctx.scope).
      run: async (input, ctx) => {
      const s = services(ctx);
      const service = str(asInput(input).service);
      const readable = new Set(await ctx.scope.readable(PRODUCT_SCOPE));
      const accounts = s.accounts
        .list({ status: "connected", ...(service ? { service } : {}) })
        .filter((a) => readable.has(a.id) && (a.kind === "as_me" || a.ownerAgent === ctx.caller.id));
      const out = [];
      const allowedBy = new Map<string, Set<CrudAction>>();
      for (const a of accounts) {
        const canCreate = await ctx.scope.can(PRODUCT_SCOPE, a.id, "create");
        const canUpdate = await ctx.scope.can(PRODUCT_SCOPE, a.id, "update");
        const canDelete = await ctx.scope.can(PRODUCT_SCOPE, a.id, "delete");
        out.push({ id: a.id, label: a.label, service: a.service, kind: a.kind, access: canDelete ? "read_update_delete" : canUpdate ? "read_update" : "read" });
        const best = allowedBy.get(a.service) ?? new Set<CrudAction>(["read"]);
        for (const [action, can] of [["create", canCreate], ["update", canUpdate], ["delete", canDelete]] as const) if (can) best.add(action);
        allowedBy.set(a.service, best);
      }
      return { accounts: out, hints: accessHints(s, service, allowedBy, ctx.grant?.claims.crud ?? null, ctx.caller.type) };
      },
    },
    async buzz_identity(_input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        // F20: the first Buzz op creates the agent's identity, so this read always names it.
        const agent = await buzzAgent(ctx, s);
        const identity = s.buzz.get(agent);
        let relays: string[] = [];
        try {
          relays = s.buzz.relaysFor(agent);
        } catch {
          relays = [];
        }
        return { npub: identity?.npub ?? null, pubkey: identity?.pubkey ?? null, relay: relays[0] ?? null, relays };
      });
    },

    async buzz_channels(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        return s.relay.channels(await buzzAgent(ctx, s), relaysArg(asInput(input).relays));
      });
    },
    async buzz_read(input, ctx) {
      return guard(async () => {
        const i = asInput(input);
        const s = services(ctx);
        const { messages, relays } = await s.relay.read(await buzzAgent(ctx, s), {
          channel: String(i.channel ?? ""),
          ...(typeof i.since === "number" ? { since: i.since } : {}),
          ...(typeof i.limit === "number" ? { limit: i.limit } : {}),
          ...relaysArg(i.relays),
        });
        return { untrusted: true, messages, relays };
      });
    },
    buzz_post: {
      run: async (input, ctx) =>
        guard(async () => {
          const i = asInput(input);
          const s = services(ctx);
          const sender = await buzzSender(ctx, s);
          const channel = String(i.channel ?? "");
          const replyTo = str(i.replyTo);
          const root = str(i.threadRoot);
          ctx.receipt.summary(`Buzz post to channel ${channel.slice(0, 8)}…${sender.kind === "workspace" ? " as the workspace sender" : ""}`);
          ctx.receipt.meta({ ...senderMeta(sender), channel });
          const posted = await s.relay.post(sender.key, {
            channel,
            content: String(i.content ?? ""),
            ...(replyTo ? { replyTo: { id: replyTo, ...(root ? { root } : {}) } } : {}),
            ...relaysArg(i.relays),
          });
          rememberBuzzSent(ctx.db, sender.key, posted.id, channel);
          return posted;
        }),
      /**
       * R5-5 (RS-5 QA): the owner reads the post as plain text, not as raw arguments. The per-op holdView has no ctx, so the
       * sender (the agent's own identity, or the workspace sender for an app) is not known here. A post can be 20 000 characters
       * but a hold view over 16 000 is refused, so the text is cut at BUZZ_POST_VIEW_CHARS with a visible "more not shown" line.
       */
      holdView: (input) => {
        const i = asInput(input);
        const relays = relaysArg(i.relays).relays;
        const replyTo = str(i.replyTo);
        const text = [...String(i.content ?? "")];
        const more = text.length - BUZZ_POST_VIEW_CHARS;
        return [
          "Buzz post",
          `Channel: ${String(i.channel ?? "")}`,
          "As: the calling agent",
          ...(replyTo ? [`Reply to: ${replyTo}`] : []),
          ...(relays ? [`Relays: ${relays.join(", ")}`] : []),
          "",
          text.slice(0, BUZZ_POST_VIEW_CHARS).join(""),
          ...(more > 0 ? ["", `(${more} more characters not shown)`] : []),
        ].join("\n");
      },
    },
    async buzz_react(input, ctx) {
      return guard(async () => {
        const i = asInput(input);
        const s = services(ctx);
        const agent = await buzzAgent(ctx, s);
        ctx.receipt.summary("Buzz reaction");
        return s.relay.react(agent, { channel: String(i.channel ?? ""), messageId: String(i.messageId ?? ""), emoji: String(i.emoji ?? ""), ...relaysArg(i.relays) });
      });
    },
    async buzz_edit(input, ctx) {
      return guard(async () => {
        const i = asInput(input);
        const s = services(ctx);
        const agent = await buzzAgent(ctx, s);
        const channel = String(i.channel ?? "");
        const messageId = String(i.messageId ?? "");
        ownBuzzMessage(ctx.db, agent, messageId, fail);
        ctx.receipt.summary("Buzz message edited");
        return s.relay.edit(agent, { channel, messageId, content: String(i.content ?? ""), ...relaysArg(i.relays) });
      });
    },
    buzz_delete: {
      run: async (input, ctx) =>
        guard(async () => {
          const i = asInput(input);
          const s = services(ctx);
          const agent = await buzzAgent(ctx, s);
          const channel = String(i.channel ?? "");
          const messageId = String(i.messageId ?? "");
          ownBuzzMessage(ctx.db, agent, messageId, fail);
          const out = await s.relay.remove(agent, { channel, messageId, ...relaysArg(i.relays) });
          ctx.db.prepare("DELETE FROM connect_buzz_sent WHERE agent = ? AND event_id = ?").run(agent, messageId);
          ctx.receipt.summary("Buzz message deleted");
          return out;
        }),
      holdView: (input) => `Delete your Buzz message ${String(asInput(input).messageId ?? "").slice(0, 12)}… in channel ${String(asInput(input).channel ?? "")}`,
    },
    async buzz_schedule(input, ctx) {
      return guard(async () => {
        const i = asInput(input);
        const s = services(ctx);
        const agent = await buzzAgent(ctx, s);
        const channel = String(i.channel ?? "");
        const content = String(i.content ?? "").trim();
        const sendAt = Date.parse(String(i.sendAt ?? ""));
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(channel)) fail("buzz_channel_invalid", "channel must be a Buzz channel id.");
        if (!content) fail("buzz_content_invalid", "The message is empty.");
        if (!Number.isFinite(sendAt) || sendAt < Date.now() + 30_000 || sendAt > Date.now() + 30 * 86_400_000) fail("buzz_send_at_invalid", "sendAt must be an ISO time between 30 seconds and 30 days from now.");
        const waiting = Number(ctx.db.prepare("SELECT COUNT(*) AS n FROM connect_buzz_scheduled WHERE agent = ? AND status = 'scheduled'").get(agent)?.n ?? 0);
        if (waiting >= MAX_SCHEDULED_PER_AGENT) fail("buzz_schedule_limit", `You already have ${MAX_SCHEDULED_PER_AGENT} scheduled posts waiting. Cancel one first.`, 409);
        const narrow = relaysArg(i.relays).relays;
        const relays = s.buzz.relaysFor(agent, narrow);
        const id = newId("bsp");
        ctx.db
          .prepare("INSERT INTO connect_buzz_scheduled (id, agent, channel, content, send_at, status, created_at, relays) VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?)")
          .run(id, agent, channel, content, sendAt, Date.now(), narrow ? JSON.stringify(relays) : null);
        ctx.receipt.summary(`Buzz post scheduled for ${new Date(sendAt).toISOString()}`);
        return { id, sendAt: new Date(sendAt).toISOString() };
      });
    },
    async buzz_scheduled(_input, ctx) {
      return guard(async () => {
        const posts = ctx.db
          .prepare("SELECT id, channel, send_at, status, event_id, detail FROM connect_buzz_scheduled WHERE agent = ? ORDER BY send_at DESC LIMIT 100")
          .all(agentOnly(ctx))
          .map((r) => ({ id: String(r.id), channel: String(r.channel), sendAt: new Date(Number(r.send_at)).toISOString(), status: String(r.status), eventId: r.event_id === null ? null : String(r.event_id), detail: String(r.detail) }));
        return { posts };
      });
    },
    async buzz_schedule_cancel(input, ctx) {
      return guard(async () => {
        const id = String(asInput(input).id ?? "");
        const r = ctx.db.prepare("UPDATE connect_buzz_scheduled SET status = 'cancelled' WHERE id = ? AND agent = ? AND status = 'scheduled'").run(id, agentOnly(ctx));
        if (r.changes === 0) fail("buzz_scheduled_unknown", "No scheduled post of yours with that id is waiting.", 404);
        return { ok: true };
      });
    },

    // ── chat channels (agent; the send ops also serve companion apps through the workspace sender, C86) ──
    channel_inbox: {
      // No manifest scopeType (F35): an agent with no chat bot yet gets an empty inbox, not scope_denied on every poll.
      // This filter is the ONLY scope guard: own bots (ownerAgent = caller) that the caller may read (ctx.scope), and
      // the `account` input can only narrow that set (test/channel-inbox-scope.test.ts).
      run: async (input, ctx) =>
        guard(async () => {
          const i = asInput(input);
          const s = services(ctx);
          const agent = agentOnly(ctx);
          const readable = new Set(await ctx.scope.readable(PRODUCT_SCOPE));
          const mine = s.accounts
            .list({ status: "connected" })
            .filter((a) => a.source === "channel" && a.ownerAgent === agent && readable.has(a.id) && (!str(i.account) || a.id === str(i.account)));
          const out = s.channels.inbox(mine.map((a) => a.id), typeof i.sinceSeq === "number" ? i.sinceSeq : 0, typeof i.limit === "number" ? i.limit : 50);
          return { ...out, untrusted: true } as unknown as Json;
        }),
    },
    channel_conversations: {
      scope: (input) => str(asInput(input).account) ?? null,
      run: async (input, ctx) =>
        guard(async () => {
          const s = services(ctx);
          const account = ownChannel(ctx, s, asInput(input).account);
          await s.channels.refreshConversations(account).catch(() => undefined);
          return { conversations: s.channels.conversations(account.id) };
        }),
    },
    channel_send: {
      scope: sendScope,
      run: async (input, ctx) =>
        guard(async () => {
          const i = asInput(input);
          const s = services(ctx);
          const { account, ...sender } = chatSender(ctx, s, i.account);
          ctx.receipt.summary(`${account.service} post via ${account.label}${sender.kind === "workspace" ? " (workspace sender)" : ""}`);
          ctx.receipt.meta({ ...senderMeta(sender), service: account.service, account: account.label });
          return s.channels.send(account, ctx.caller.id, { conversation: String(i.conversation ?? ""), text: String(i.text ?? ""), threadId: str(i.threadId) ?? null });
        }),
      redact: (input) => `Chat post to ${String(asInput(input).conversation ?? "").slice(-40)}`,
    },
    channel_reply: {
      scope: sendScope,
      run: async (input, ctx) =>
        guard(async () => {
          const i = asInput(input);
          const s = services(ctx);
          const { account, ...sender } = chatSender(ctx, s, i.account);
          ctx.receipt.summary(`${account.service} reply via ${account.label}${sender.kind === "workspace" ? " (workspace sender)" : ""}`);
          ctx.receipt.meta({ ...senderMeta(sender), service: account.service, account: account.label });
          return s.channels.reply(account, ctx.caller.id, { seq: Number(i.seq ?? 0), text: String(i.text ?? "") });
        }),
    },
    channel_dm_first: {
      scope: sendScope,
      run: async (input, ctx) =>
        guard(async () => {
          const i = asInput(input);
          const s = services(ctx);
          const { account, ...sender } = chatSender(ctx, s, i.account);
          ctx.receipt.summary(`First ${account.service} DM via ${account.label}${sender.kind === "workspace" ? " (workspace sender)" : ""}`);
          ctx.receipt.meta({ ...senderMeta(sender), service: account.service, account: account.label, person: String(i.person ?? "").slice(-60) });
          return s.channels.directMessage(account, ctx.caller.id, { person: String(i.person ?? ""), text: String(i.text ?? ""), first: true });
        }),
      holdView: (input) => {
        const i = asInput(input);
        return `First direct message (chat)\nTo: ${String(i.person ?? "")}\n\n${String(i.text ?? "")}`;
      },
    },
    channel_dm: {
      scope: sendScope,
      run: async (input, ctx) =>
        guard(async () => {
          const i = asInput(input);
          const s = services(ctx);
          const { account, ...sender } = chatSender(ctx, s, i.account);
          ctx.receipt.summary(`${account.service} DM via ${account.label}${sender.kind === "workspace" ? " (workspace sender)" : ""}`);
          ctx.receipt.meta({ ...senderMeta(sender), service: account.service, account: account.label });
          try {
            return await s.channels.directMessage(account, ctx.caller.id, { person: String(i.person ?? ""), text: String(i.text ?? ""), first: false });
          } catch (error) {
            if (error instanceof ChannelError && error.code === "channel_first_contact_required") fail(error.code, firstContactHint(ctx, "channel_dm_first"), 409);
            throw error;
          }
        }),
    },
    channel_edit: {
      scope: (input) => str(asInput(input).account) ?? null,
      run: async (input, ctx) =>
        guard(async () => {
          const i = asInput(input);
          const s = services(ctx);
          const account = ownChannel(ctx, s, i.account);
          await s.channels.edit(account, { conversation: String(i.conversation ?? ""), messageId: String(i.messageId ?? ""), text: String(i.text ?? "") });
          ctx.receipt.summary(`${account.service} message edited`);
          return { ok: true };
        }),
    },
    channel_delete: {
      scope: (input) => str(asInput(input).account) ?? null,
      run: async (input, ctx) =>
        guard(async () => {
          const i = asInput(input);
          const s = services(ctx);
          const account = ownChannel(ctx, s, i.account);
          await s.channels.delete(account, { conversation: String(i.conversation ?? ""), messageId: String(i.messageId ?? "") });
          ctx.receipt.summary(`${account.service} message deleted`);
          return { ok: true };
        }),
      holdView: (input) => `Delete your chat message ${String(asInput(input).messageId ?? "")} in ${String(asInput(input).conversation ?? "")}`,
    },
    channel_react: {
      scope: (input) => str(asInput(input).account) ?? null,
      run: async (input, ctx) =>
        guard(async () => {
          const i = asInput(input);
          const s = services(ctx);
          const account = ownChannel(ctx, s, i.account);
          await s.channels.react(account, { conversation: String(i.conversation ?? ""), messageId: String(i.messageId ?? ""), emoji: String(i.emoji ?? "") });
          ctx.receipt.summary(`${account.service} reaction`);
          return { ok: true };
        }),
    },

    buzz_dm_first: {
      run: async (input, ctx) =>
        guard(async () => {
          const i = asInput(input);
          const s = services(ctx);
          const sender = await buzzSender(ctx, s);
          const sent = await s.relay.directMessage(sender.key, { to: String(i.to ?? ""), content: String(i.content ?? ""), ...relaysArg(i.relays) });
          rememberContact(ctx.db, sender.key, sent);
          for (const one of sent.sent) rememberBuzzSent(ctx.db, sender.key, one.id, one.channel);
          ctx.receipt.summary(`First Buzz DM to ${shortKey(sent.to)}${sender.kind === "workspace" ? " as the workspace sender" : ""}`);
          ctx.receipt.meta({ ...senderMeta(sender), to: sent.to, channel: sent.channel });
          return { id: sent.id, channel: sent.channel, to: sent.to, relays: sent.relays };
        }),
      holdView: (input) => {
        const i = asInput(input);
        const relays = relaysArg(i.relays).relays;
        return `First direct message in Buzz\nTo: ${String(i.to ?? "")}${relays ? `\nRelays: ${relays.join(", ")}` : ""}\n\n${String(i.content ?? "")}`;
      },
      redact: (input) => `First Buzz DM to ${shortKey(String(asInput(input).to ?? ""))}`,
    },
    buzz_dm: {
      run: async (input, ctx) =>
        guard(async () => {
          const i = asInput(input);
          const s = services(ctx);
          const to = parsePubkey(String(i.to ?? ""));
          if (!to) fail("buzz_recipient_invalid", "Give the person's Buzz key as npub1… or 64 hex.");
          const sender = await buzzSender(ctx, s);
          const known = ctx.db.prepare("SELECT 1 FROM connect_buzz_contacts WHERE agent = ? AND pubkey = ?").get(sender.key, to);
          if (!known) fail("buzz_first_contact_required", firstContactHint(ctx, "buzz_dm_first"), 409);
          const sent = await s.relay.directMessage(sender.key, { to: to as string, content: String(i.content ?? ""), ...relaysArg(i.relays) });
          for (const one of sent.sent) rememberBuzzSent(ctx.db, sender.key, one.id, one.channel);
          ctx.receipt.summary(`Buzz DM to ${shortKey(sent.to)}${sender.kind === "workspace" ? " as the workspace sender" : ""}`);
          ctx.receipt.meta({ ...senderMeta(sender), to: sent.to, channel: sent.channel });
          return { id: sent.id, channel: sent.channel, to: sent.to, relays: sent.relays };
        }),
      redact: (input) => `Buzz DM to ${shortKey(String(asInput(input).to ?? ""))}`,
    },

    // ── agent identities for Fleet (C81 G6; C88: identity handles only) ──
    async identities_list(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const i = asInput(input);
        const wanted = str(i.agent);
        // An agent sees only its own rows; a companion app (Fleet's grant) sees every agent of the workspace.
        const only = ctx.caller.type === "agent" ? ctx.caller.id : (wanted ?? null);
        if (ctx.caller.type === "agent" && wanted && wanted !== ctx.caller.id) return { identities: [], nextCursor: null };
        const rows = identityRows(s, only);
        const after = str(i.cursor) ? decodeCursor(String(i.cursor)) : null;
        const start = after ? rows.findIndex((r) => rowKey(r) > after) : 0;
        const page = start < 0 ? [] : rows.slice(start, start + IDENTITIES_PAGE);
        const last = page.at(-1);
        const more = start >= 0 && start + IDENTITIES_PAGE < rows.length;
        return { identities: page, nextCursor: more && last ? encodeCursor(rowKey(last)) : null };
      });
    },

    // ── person ops (app UI through the bridge launch) ──
    async services_search(input, ctx) {
      return guard(async () => {
        const query = (str(asInput(input).query) ?? "").toLowerCase();
        const matches = (slug: string, name: string) => !query || slug.includes(query) || name.toLowerCase().includes(query);
        let catalogAvailable = true;
        const apps = await services(ctx)
          .catalog.listApps()
          .catch((error: unknown) => {
            catalogAvailable = false;
            ctx.log.warn("catalog unavailable", { code: (error as { code?: string }).code ?? "error" });
            return [];
          });
        const catalog = apps
          .filter((a) => matches(a.service, a.name))
          .map((a) => ({
            service: a.service,
            name: a.name,
            description: a.description,
            logo: null,
            source: "catalog",
            connectMode: "api_key",
            fields: a.fields,
            baseUrlExample: a.baseUrlExample,
            ...(a.credentialHint ? { credentialHint: a.credentialHint } : {}),
          }));
        if (!(await ctx.getKey(COMPOSIO_KEY))) return { composioKey: false, catalogAvailable, services: catalog };
        const toolkits = await toolkitCache.get(() => composioClient(ctx.getKey));
        const hits = toolkits
          .filter((t) => matches(t.slug, t.name))
          .slice(0, 30)
          .map((t) => ({ service: t.slug, name: t.name, description: t.description, logo: t.logo, source: "composio", connectMode: connectMode(t) }));
        return { composioKey: true, catalogAvailable, services: [...catalog, ...hits] };
      });
    },
    async accounts_overview(_input, ctx) {
      const s = services(ctx);
      // Chat accounts also list who the owner shared them with (C230 R3); `dataApps` are the apps one can share with.
      // C240: `dataApps[].instances` are the verified app instances that can call Connect (ctx.companionCallers, person ops,
      // miniapp-sdk >= 0.1.32), each with its provider; `ownInfra` marks one that runs on the owner's own infrastructure.
      const { callers, dataApps } = dataTargets(ctx);
      const accounts = s.accounts.list().map((a) => (a.source === "channel" ? { ...accountView(a), shares: s.shares.forAccount(a.id).map((r) => shareView(r, callers)) } : accountView(a)));
      // callersKnown false: this build's SDK cannot list the apps (miniapp-sdk < 0.1.32), so no share can be made; the page says so
      return { accounts, dataApps, callersKnown: companionCallersKnown(ctx), ownerRowsEffective: env.bridgeOwnerRows === true } as unknown as Json;
    },
    // The owner (a person) decides which app sees which chat account. Agents cannot reach this op; an app cannot widen itself.
    async account_app_share(input, ctx) {
      return guard(async () => {
        if (ctx.caller.type !== "person") fail("no_access", "Only the owner shares accounts with apps.", 403);
        const s = services(ctx);
        const i = asInput(input);
        const id = str(i.account) ?? fail("account_required", "Pick the chat connection to share.");
        const product = str(i.product) ?? fail("product_required", "Pick the app to share with.");
        if (!isDataApp(product)) fail("product_unknown", `Pick an app that reads data: ${Object.values(DATA_APPS).join(" or ")}.`);
        const level = str(i.level) as ShareLevel | undefined;
        if (!level || !SHARE_LEVELS.includes(level)) fail("level_invalid", "Pick none, available or shared.");
        const account = s.accounts.get(id);
        if (account?.source !== "channel") fail("account_not_found", "No such chat connection.", 404);
        if (level !== "none" && account?.status !== "connected") fail("channel_account_not_connected", "This chat connection is not connected. Connect it again first.", 409);
        // C240: bind the share to the verified product AND the instance the owner picked, from the CURRENT signed slice.
        // Not listed (not installed, removed, reinstalled, an SDK without companionCallers, an expired slice) = refused.
        const { callers } = dataTargets(ctx);
        let instance: string | null = null;
        let target: (typeof callers)[number] | undefined;
        if (level !== "none") {
          instance = str(i.instance) ?? fail("instance_required", `Pick which ${DATA_APPS[product]} to share with.`);
          target = callers.find((c) => c.instance === instance && c.product === product);
          if (!target) fail("app_instance_unknown", `This ${DATA_APPS[product]} is not installed in your workspace or cannot call Connect. Reload the page and pick it again.`, 404);
        }
        s.shares.set(id, product, level as ShareLevel, i.includeHistory === true, instance);
        ctx.log.info("account shared with an app", { account: id, product, instance, level: level as string });
        // which instance, and whether it runs on the owner's own server (C240 item 3), not only the product
        const who = target ? `${DATA_APPS[product]} “${target.name}”${target.provider === OWN_INFRA_PROVIDER ? " (your own server)" : ""}` : DATA_APPS[product];
        ctx.receipt.summary(`Sharing of “${account?.label ?? id}” with ${who}: ${level === "none" ? "not shared" : level === "available" ? "names and counts only" : "messages, read only"}`);
        ctx.receipt.meta({ account: id, product, instance, level: level as string, includeHistory: i.includeHistory === true });
        return { account: id, product, instance, level, shares: s.shares.forAccount(id).map((r) => shareView(r, callers)) } as unknown as Json;
      });
    },
    // The owner (a person) sees which app asked for what: the last ACCESS_LOG_LIMIT audit lines, newest first. No message text.
    async data_access_log(_input, ctx) {
      return guard(async () => {
        if (ctx.caller.type !== "person") fail("no_access", "Only the owner sees the access list.", 403);
        const s = services(ctx);
        const labels = new Map<string, string>();
        const entries = ctx.db
          .prepare("SELECT id, at, op, outcome, caller_type, product, account_id, row_count, repeats FROM connect_data_audit ORDER BY id DESC LIMIT ?")
          .all(ACCESS_LOG_LIMIT)
          .map((r) => {
            const accountId = r.account_id === null ? null : String(r.account_id);
            if (accountId !== null && !labels.has(accountId)) labels.set(accountId, s.accounts.get(accountId)?.label ?? "");
            const product = r.product === null ? null : String(r.product);
            return {
              id: Number(r.id),
              at: new Date(Number(r.at)).toISOString(),
              op: String(r.op),
              callerType: String(r.caller_type),
              product,
              app: product === null ? null : (DATA_APPS[product] ?? product),
              account: accountId === null ? null : labels.get(accountId) || null,
              ok: r.outcome === "ok",
              outcome: String(r.outcome),
              rows: Number(r.row_count),
              repeats: Number(r.repeats),
            };
          });
        return { entries } as unknown as Json;
      });
    },
    async account_connect(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const i = asInput(input);
        const service = str(i.service) ?? fail("service_required", "Pick a service.");
        const kind = (str(i.kind) ?? "as_me") as ConnectionKind;
        if (!CONNECTION_KINDS.includes(kind)) fail("kind_invalid", "Kind must be as_me or as_itself.");
        const agent = str(i.agent) ?? null;
        if (kind === "as_itself" && !agentsOf(ctx.db).some((a) => a.id === agent)) fail("agent_unknown", "Pick the agent this account belongs to.");
        const origin = extras(ctx).publicUrl ?? fail("public_origin_unknown", "The workspace door address is not known yet.", 503);
        const result = await s.composio.startConnect({
          service,
          label: str(i.label) ?? service,
          kind,
          ownerAgent: kind === "as_itself" ? agent : null,
          workspaceId: workspace(ctx),
          callbackUrl: `${origin.replace(/\/+$/u, "")}/p/${env.manifest.id}${COMPOSIO_CALLBACK_PATH}`,
        });
        return { account: accountView(result.account), redirectUrl: result.redirectUrl };
      });
    },
    async catalog_account_connect(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const i = asInput(input);
        const kind = (str(i.kind) ?? "as_me") as ConnectionKind;
        if (!CONNECTION_KINDS.includes(kind)) fail("kind_invalid", "Kind must be as_me or as_itself.");
        const agent = str(i.agent) ?? null;
        if (kind === "as_itself" && !agentsOf(ctx.db).some((a) => a.id === agent)) fail("agent_unknown", "Pick the agent this account belongs to.");
        const credentials = (i.credentials && typeof i.credentials === "object" ? i.credentials : {}) as Record<string, string>;
        const account = await s.catalog.connect({
          service: str(i.service) ?? fail("service_required", "Pick an app."),
          label: str(i.label) ?? String(i.service),
          baseUrl: str(i.baseUrl) ?? fail("base_url_required", "Enter the app's address."),
          credentials,
          kind,
          ownerAgent: kind === "as_itself" ? agent : null,
        });
        await extras(ctx).scopes.instances.create(PRODUCT_SCOPE, account.id, account.label, account.ownerAgent ? { ownerAgent: account.ownerAgent as `agt_${string}` } : {});
        return { account: accountView(account) };
      });
    },
    async catalog_account_test(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const account = s.accounts.get(String(asInput(input).id ?? ""));
        if (account?.source !== "catalog") fail("account_not_found", "No such self-hosted app account.", 404);
        return (await s.catalog.test(account as Account)) as unknown as Json;
      });
    },
    async channel_providers(_input, ctx) {
      return {
        services: [...(env.channelProviders ?? channelProviders()).values()].map((p) => ({
          service: p.service,
          credentialFields: [...p.credentialFields],
          settingFields: (p.settingFields ?? []).map((f) => ({ ...f })),
          inbound: p.inbound.kind,
        })),
        agents: agentsOf(ctx.db),
      } as unknown as Json;
    },
    async channel_account_connect(input, ctx) {
      return guard(async () => {
        const i = asInput(input);
        const s = services(ctx);
        const service = String(i.service ?? "");
        if (!isChannelService(service)) fail("channel_service_unknown", "Pick Slack, Teams, Telegram or Discord.");
        const agent = str(i.agent) ?? fail("agent_required", "Pick the agent this bot speaks for.");
        if (!agentsOf(ctx.db).some((a) => a.id === agent)) fail("agent_unknown", "Unknown agent.", 404);
        const account = await s.channels.connect({
          service,
          label: str(i.label) ?? service,
          agent: agent as string,
          credentials: (i.credentials && typeof i.credentials === "object" ? i.credentials : {}) as Record<string, unknown>,
          ...(i.settings && typeof i.settings === "object" ? { settings: i.settings as Record<string, unknown> } : {}),
        });
        await extras(ctx).scopes.instances.create(PRODUCT_SCOPE, account.id, account.label, { ownerAgent: agent as `agt_${string}` });
        return { account: accountView(account) };
      });
    },
    async channel_accounts(_input, ctx) {
      const s = services(ctx);
      const accounts = s.accounts
        .list()
        .filter((a) => a.source === "channel")
        .map((a) => {
          const bot = s.channels.bot(a.id);
          return { ...accountView(a), bot: bot ? { id: bot.botId, name: bot.botName, inbound: bot.inboundState, detail: bot.inboundDetail, unmatchedChanges: bot.unmatchedChanges } : null };
        });
      return { accounts } as unknown as Json;
    },
    async mcp_account_connect(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const i = asInput(input);
        const kind = (str(i.kind) ?? "as_me") as ConnectionKind;
        if (!CONNECTION_KINDS.includes(kind)) fail("kind_invalid", "Kind must be as_me or as_itself.");
        const agent = str(i.agent) ?? null;
        if (kind === "as_itself" && !agentsOf(ctx.db).some((a) => a.id === agent)) fail("agent_unknown", "Pick the agent this account belongs to.");
        const url = str(i.url) ?? fail("url_required", "Enter the MCP server address.");
        if (i.auth === "oauth") {
          const origin = extras(ctx).publicUrl ?? fail("public_origin_unknown", "The workspace door address is not known yet.", 503);
          const started = await s.mcp.startOAuth({
            label: str(i.label) ?? "MCP server",
            url,
            kind,
            ownerAgent: kind === "as_itself" ? agent : null,
            redirectUri: `${origin.replace(/\/+$/u, "")}/p/${env.manifest.id}${MCP_CALLBACK_PATH}`,
          });
          return { account: accountView(started.account), redirectUrl: started.redirectUrl };
        }
        const account = await s.mcp.connect({
          label: str(i.label) ?? "MCP server",
          url,
          headers: (i.headers && typeof i.headers === "object" ? i.headers : {}) as Record<string, unknown>,
          kind,
          ownerAgent: kind === "as_itself" ? agent : null,
        });
        await extras(ctx).scopes.instances.create(PRODUCT_SCOPE, account.id, account.label, account.ownerAgent ? { ownerAgent: account.ownerAgent as `agt_${string}` } : {});
        return { account: accountView(account) };
      });
    },
    async account_update(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const i = asInput(input);
        const id = str(i.id) ?? fail("id_required", "Account id is required.");
        if (!s.accounts.get(id)) fail("account_not_found", "Account not found.", 404);
        return { account: accountView(s.accounts.update(id, { label: String(i.label ?? "") })) };
      });
    },
    async account_disconnect(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const id = str(asInput(input).id) ?? fail("id_required", "Account id is required.");
        const account = s.accounts.get(id) ?? fail("account_not_found", "Account not found.", 404);
        const revoked =
          account.source === "composio"
            ? await s.composio.disconnect(account)
            : account.source === "catalog"
              ? await s.catalog.disconnect(account)
              : account.source === "mcp"
                ? await s.mcp.disconnect(account)
                : account.source === "channel"
                  ? await s.channels.disconnect(account)
                  : s.accounts.update(id, { status: "revoked" });
        // C230 R3: a disconnected account is shared with no app any more (a new connection starts at none).
        s.shares.clearAccount(id);
        return { account: accountView(revoked) };
      });
    },
    async tools_refresh(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const service = str(asInput(input).service) ?? fail("service_required", "Pick a service.");
        const connected = s.accounts.list({ service, status: "connected" });
        if (connected.length === 0) fail("service_not_connected", "Connect an account first.", 409);
        const first = connected[0];
        const tools =
          first?.source === "catalog" ? await s.catalog.syncTools(service) : first?.source === "mcp" ? await s.mcp.syncTools(first) : await s.composio.syncTools(service);
        return { service, tools };
      });
    },
    // X-03: the owner sees each MCP tool's class; a tool the server calls read-only is a write until the owner confirms it.
    async mcp_tools_list(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const service = str(asInput(input).service) ?? fail("service_required", "Pick a service.");
        const tools = s.tools.listService("mcp", service).map((t) => ({
          name: t.name,
          title: t.title,
          effect: t.effect,
          holdFamily: t.holdFamily ?? null,
          // the server claims read-only but Connect classes it higher (or the owner already confirmed that claim)
          unverifiedReadClaim: t.readClaim === true,
          ownerConfirmedRead: ownerReadOf(ctx.db, t.name),
        }));
        return { service, tools } as unknown as Json;
      });
    },
    async mcp_tool_read_set(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const i = asInput(input);
        const name = str(i.name) ?? fail("tool_required", "Pick a tool.");
        const row = s.tools.get(name);
        if (row?.source !== "mcp") fail("tool_unknown", "No MCP tool with that name is connected.", 404);
        const tool = row as NonNullable<typeof row>;
        const confirmed = ownerReadOf(ctx.db, name);
        if (i.read === true && !tool.readClaim && !confirmed) fail("tool_not_read_only", notConfirmableText(tool), 409);
        if (i.read === true) ctx.db.prepare("INSERT INTO connect_tool_owner_reads (name, set_at) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET set_at = excluded.set_at").run(name, Date.now());
        else ctx.db.prepare("DELETE FROM connect_tool_owner_reads WHERE name = ?").run(name);
        // Re-class at once from the stored facts: owner read → read; withdrawn → the name inference (server hint not trusted).
        const cls = classifyMcpTool(tool.upstream, i.read === true ? { readOnlyHint: true } : undefined, i.read === true);
        s.tools.setClass(name, cls);
        if (i.read !== true) ctx.db.prepare("UPDATE connect_tools SET read_claim = 1 WHERE name = ? AND effect != 'read'").run(name);
        return { name, effect: cls.effect, ownerConfirmedRead: i.read === true };
      });
    },
    async buzz_identities_list(_input, ctx) {
      const s = services(ctx);
      const byAgent = new Map(s.buzz.list().map((i) => [i.agent, i]));
      const list = s.buzz.relayList();
      return {
        relay: list.relays[0] ?? null,
        relays: list.relays,
        relayProblems: list.problems,
        agents: agentsOf(ctx.db).map((a) => ({ agent: a.id, name: a.name, identity: byAgent.get(a.id) ?? null, relays: s.buzz.agentRelaySelection(a.id) })),
      };
    },
    async buzz_agent_relays_set(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const i = asInput(input);
        const id = str(i.agent) ?? fail("agent_required", "Pick an agent.");
        const agent = agentsOf(ctx.db).find((a) => a.id === id) ?? fail("agent_unknown", "Unknown agent.", 404);
        if (i.relays !== null && !Array.isArray(i.relays)) fail("buzz_relays_invalid", "relays is a list of wss addresses, or null for all relays.");
        const relays = s.buzz.setAgentRelays(agent.id, Array.isArray(i.relays) ? i.relays.map(String) : null);
        return { agent: agent.id, relays };
      });
    },
    async buzz_identities_generate(_input, ctx) {
      const s = services(ctx);
      const result = await s.buzz.generateAll(agentsOf(ctx.db));
      return { created: result.created, existing: result.existing };
    },
    async buzz_identity_rotate(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const id = str(asInput(input).agent) ?? fail("agent_required", "Pick an agent.");
        const agent = agentsOf(ctx.db).find((a) => a.id === id) ?? fail("agent_unknown", "Unknown agent.", 404);
        const identity = await s.buzz.rotate(agent);
        // CON-01: posts scheduled under the old key never go out under the new one.
        cancelScheduled(ctx.db, agent.id, "Not sent: the owner rotated this agent's Buzz key.");
        return { identity };
      });
    },
    async buzz_profile_publish(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const one = str(asInput(input).agent);
        const targets = one ? [one] : s.buzz.list().map((i) => i.agent);
        // Every relay of each agent; one relay down is reported per agent, not fatal (C73).
        const published: Json[] = [];
        const failed: Json[] = [];
        for (const agent of targets) {
          try {
            const out = await s.relay.publishProfile(agent);
            published.push({ ...out.identity, relays: out.relays } as unknown as Json);
          } catch (error) {
            if (one) throw error;
            failed.push({ agent, error: (error as { code?: string }).code ?? "error", detail: error instanceof Error ? error.message.slice(0, 300) : "failed" });
          }
        }
        return { published, failed };
      });
    },

    // ── workspace sender identities (C86; person ops, Connect → Senders) ──
    async sender_identities_list(_input, ctx) {
      const s = services(ctx);
      const senders = SENDER_CHANNELS.map((channel) => senderView(s, channel));
      const candidates = s.accounts
        .list({ status: "connected" })
        .filter((a) => a.source === "channel")
        .map((a) => ({ id: a.id, service: a.service, label: a.label }));
      return { senders, candidates } as unknown as Json;
    },
    async sender_identity_set(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const i = asInput(input);
        const channel = str(i.channel) ?? "";
        if (!isSenderChannel(channel)) fail("sender_channel_unknown", "Pick buzz, slack, teams, telegram or discord.");
        if (channel === "buzz") {
          const label = cleanLabel(str(i.label) ?? "Workspace");
          // A Buzz identity created for the workspace sender (kept on later changes; cleared with the sender).
          await s.buzz.ensure({ id: WORKSPACE_SENDER, name: label });
          s.senders.set("buzz", null, label);
        } else {
          const id = str(i.account) ?? fail("account_required", `Pick the ${channel} bot apps send from.`);
          const account = s.accounts.get(id);
          if (account?.source !== "channel" || account.service !== channel) fail("account_unknown", `No ${channel} bot with that id is connected in Connect.`, 404);
          if (account?.status !== "connected") fail("channel_account_not_connected", "This bot is not connected. Connect it again first.", 409);
          s.senders.set(channel as ChannelServiceId, id, (account as Account).label);
          // Companion apps reach it through the shared `sender:<service>` scope instance (manifest defaultGrants shared →
          // access `apps_only`, left out of the canvas summary; agents are refused in the handler: sender_reserved_for_apps).
          await extras(ctx).scopes.instances.create(PRODUCT_SCOPE, senderScopeId(channel as ChannelServiceId), `Workspace sender (${channel}) — for apps only, not usable by agents`, { shared: true });
        }
        return { sender: senderView(s, channel as SenderChannel) } as unknown as Json;
      });
    },
    async sender_identity_clear(input, ctx) {
      return guard(async () => {
        const s = services(ctx);
        const channel = str(asInput(input).channel) ?? "";
        if (!isSenderChannel(channel)) fail("sender_channel_unknown", "Pick buzz, slack, teams, telegram or discord.");
        const cleared = s.senders.clear(channel as SenderChannel);
        if (channel === "buzz") {
          await s.buzz.remove(WORKSPACE_SENDER);
          ctx.db.prepare("DELETE FROM connect_buzz_contacts WHERE agent = ?").run(WORKSPACE_SENDER);
          ctx.db.prepare("DELETE FROM connect_buzz_sent WHERE agent = ?").run(WORKSPACE_SENDER);
        } else {
          await extras(ctx).scopes.instances.create(PRODUCT_SCOPE, senderScopeId(channel as ChannelServiceId), `Workspace sender (${channel}, not set) — for apps only, not usable by agents`, { shared: false });
        }
        return { cleared };
      });
    },
  };

  const composioCallback: PublicHandler = async (req, rawCtx) => {
    const ctx = rawCtx as SdkPublicContext;
    const url = new URL(req.url);
    const page = callbackPage;
    try {
      const s = services(ctx);
      const workspaceId = ctx.workspace ?? fail("workspace_unknown", "The workspace id is not known yet.", 503);
      const account = await s.composio.completeCallback({
        state: url.searchParams.get("state"),
        connectedAccountId: url.searchParams.get("connected_account_id") ?? url.searchParams.get("connectedAccountId"),
        workspaceId,
      });
      await ctx.scopes.instances.create(PRODUCT_SCOPE, account.id, account.label, account.ownerAgent ? { ownerAgent: account.ownerAgent as `agt_${string}` } : {});
      return page(true, "Connected", `${escapeHtml(account.label)} is connected. Set each agent's access in Connect.`, 200);
    } catch (error) {
      ctx.log.warn("composio callback failed", { code: (error as { code?: string }).code ?? "error" });
      const message = error instanceof Error ? error.message : "The connection did not complete.";
      return page(false, "Not connected", escapeHtml(message), 400);
    }
  };

  const mcpCallback: PublicHandler = async (req, rawCtx) => {
    const ctx = rawCtx as SdkPublicContext;
    const url = new URL(req.url);
    try {
      const account = await services(ctx).mcp.completeOAuth({
        state: url.searchParams.get("state"),
        code: url.searchParams.get("code"),
        error: url.searchParams.get("error"),
      });
      await ctx.scopes.instances.create(PRODUCT_SCOPE, account.id, account.label, account.ownerAgent ? { ownerAgent: account.ownerAgent as `agt_${string}` } : {});
      return callbackPage(true, "Connected", `${escapeHtml(account.label)} is connected. Set each agent's access in Connect.`, 200);
    } catch (error) {
      ctx.log.warn("mcp oauth callback failed", { code: (error as { code?: string }).code ?? "error" });
      return callbackPage(false, "Not connected", escapeHtml(error instanceof Error ? error.message : "The connection did not complete."), 400);
    }
  };

  const teamsWebhook: PublicHandler = async (req, rawCtx) => {
    const ctx = rawCtx as SdkPublicContext;
    const body = await req.text();
    if (body.length > 128 * 1024) return new Response("", { status: 413 });
    const out = await services(ctx).channels.webhook("teams", { headers: req.headers, body });
    return new Response(out.body, { status: out.status, headers: { "content-type": out.contentType ?? "text/plain", "cache-control": "no-store" } });
  };

  return {
    manifest: env.manifest,
    handlers,
    dynamic: { tools: dynamicTools },
    publicRoutes: { [COMPOSIO_CALLBACK_PATH]: composioCallback, [MCP_CALLBACK_PATH]: mcpCallback, [TEAMS_WEBHOOK_PATH]: teamsWebhook },
    onStart: async (ctx) => {
      const s = services(ctx);
      s.channels.startAll();
      await tetherBuzz(ctx.db, ctx.log);
      // C276a: accounts connected before a classifier or catalog change get the new tool rows (background, best effort).
      const marker = toolClassMarker(env.manifest.artifacts?.find((a) => a.id === "catalog")?.version, policyDigest);
      void resyncToolClasses(ctx.db, s, marker, ctx.log).catch((e: unknown) => ctx.log.warn("tool re-sync failed", { code: (e as { code?: string }).code ?? "error" }));
      const tick = async () => {
        s.channels.purge();
        ctx.db.prepare("DELETE FROM connect_data_audit WHERE at < ?").run(Date.now() - 90 * 24 * 60 * 60 * 1000);
        await runDueBuzzPosts(ctx.db, s.relay, ctx.log);
      };
      const timer = setInterval(() => void tick().catch((e: unknown) => ctx.log.warn("scheduler tick failed", { code: (e as { code?: string }).code ?? "error" })), 15_000);
      timer.unref();
    },
    migrations: env.migrationsDir,
    // connect_agents mirrors slice agents (id, name) because handlers have no slice-agent read in the SDK; Connect needs
    // agent names for Buzz identities and the "as itself" picker (BSA-15: recorded as app data until the SDK exposes them).
    events: {
      async agentAdded(agent, ctx) {
        upsertAgent(ctx.db, agent);
        await tetherBuzz(ctx.db, ctx.log);
      },
      async agentRemoved(agent, ctx) {
        forgetAgent(ctx.db, agent.id);
      },
      // CON-01: the full slice agent list (boot, add, remove, pause/resume). Keeps each agent's status for the send-time
      // check of scheduled posts, and forgets agents that left the slice while Connect was not running.
      async agentsChanged(agents, ctx) {
        ctx.db.transaction(() => {
          for (const agent of agents) upsertAgent(ctx.db, agent);
          const listed = new Set(agents.map((a) => a.id as string));
          for (const row of ctx.db.prepare("SELECT id FROM connect_agents").all()) if (!listed.has(String(row.id))) forgetAgent(ctx.db, String(row.id));
        });
      },
    },
  };
}

type IdentityRow = {
  agent: string;
  channel: string;
  /** "<channel>:<value>" (SDK-API §18): Buzz npub, Slack/Teams/Discord bot user id, Telegram numeric bot id */
  identity: string;
};
const IDENTITIES_PAGE = 200;
/** A refused data_* call writes one audit line per minute for the same caller, product, op and code (the rest are counted). */
const AUDIT_REFUSAL_WINDOW_MS = 60_000;
/** The owner's "Recent access" list shows this many audit lines. */
const ACCESS_LOG_LIMIT = 100;
const rowKey = (r: IdentityRow): string => `${r.agent}\u0000${r.channel}\u0000${r.identity}`;
const encodeCursor = (key: string): string => Buffer.from(key, "utf8").toString("base64url");

function callbackPage(ok: boolean, title: string, detail: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:2rem"><h1>${title}</h1><p>${detail}</p><p>You can close this window.</p><script>window.opener&&window.opener.postMessage({connect:${ok ? "true" : "false"}},"*")</script></body>`, // check-system: allow (standalone sign-in popup page: no kit stylesheet is served at the callback address)
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } },
  );
}

/** Record that the agent's first DM to this person ran (later DMs use buzz_dm). */
function rememberContact(db: Db, agent: string, sent: { to: string; channel: string }): void {
  const pubkey = parsePubkey(sent.to);
  if (!pubkey) return;
  db.prepare(
    "INSERT INTO connect_buzz_contacts (agent, pubkey, channel, first_sent_at) VALUES (?, ?, ?, ?) ON CONFLICT (agent, pubkey) DO UPDATE SET channel = excluded.channel",
  ).run(agent, pubkey, sent.channel, Date.now());
}

function rememberBuzzSent(db: Db, agent: string, eventId: string, channel: string): void {
  db.prepare("INSERT OR IGNORE INTO connect_buzz_sent (agent, event_id, channel, sent_at) VALUES (?, ?, ?, ?)").run(agent, eventId, channel, Date.now());
}

function ownBuzzMessage(db: Db, agent: string, eventId: string, fail: (code: string, message: string, status?: number) => never): void {
  if (!db.prepare("SELECT 1 FROM connect_buzz_sent WHERE agent = ? AND event_id = ?").get(agent, eventId)) {
    fail("buzz_not_own_message", "You can only change messages you posted through Connect.", 403);
  }
}

/** A scheduled post can wait at most this many per agent (CON-01: an injected agent cannot queue without bound). */
export const MAX_SCHEDULED_PER_AGENT = 50;
/** A post still `sending` after this long was cut by a restart: reported failed, never re-sent (no double post, L7). */
export const SENDING_STALE_MS = 10 * 60_000;

function upsertAgent(db: Db, agent: { id: string; name: string; status?: string }): void {
  const status = agent.status === "paused" ? "paused" : "active";
  db.prepare("INSERT INTO connect_agents (id, name, status, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, status = excluded.status, updated_at = excluded.updated_at").run(
    agent.id,
    agent.name.slice(0, 80),
    status,
    Date.now(),
  );
}

/** The agent left Connect's slice (removed, or its edge to Connect revoked): forget it and cancel what it scheduled. */
function forgetAgent(db: Db, agent: string): void {
  db.prepare("DELETE FROM connect_agents WHERE id = ?").run(agent);
  db.prepare("DELETE FROM connect_buzz_agent_relays WHERE agent = ?").run(agent);
  cancelScheduled(db, agent, "Not sent: the agent was removed from Connect.");
}

function cancelScheduled(db: Db, agent: string, detail: string): number {
  return db.prepare("UPDATE connect_buzz_scheduled SET status = 'cancelled', detail = ? WHERE agent = ? AND status = 'scheduled'").run(detail, agent).changes;
}

/**
 * Post due scheduled Buzz messages. CON-01: the post was authorised when it was scheduled, so at send time Connect checks
 * again what it can see in the slice: the agent must still be in Connect's slice and not paused. The workspace kill switch
 * and connection revocations are not visible to app timers in SDK 0.1.18 (REQUESTS `## connect: send-time pause read`).
 * Claim = `sending` + claimed_at, then `sent` or `failed`; a stale `sending` row is reported failed, never re-sent.
 */
export async function runDueBuzzPosts(db: Db, relay: BuzzRelay, log: Logger, now = Date.now()): Promise<number> {
  const stale = db
    .prepare("UPDATE connect_buzz_scheduled SET status = 'failed', detail = ? WHERE status = 'sending' AND claimed_at <= ?")
    .run("Interrupted: Connect restarted while sending. The post may not have gone out; check the channel and schedule it again.", now - SENDING_STALE_MS);
  if (stale.changes > 0) log.warn("scheduled buzz posts interrupted", { count: String(stale.changes) });
  const due = db.prepare("SELECT id, agent, channel, content, relays FROM connect_buzz_scheduled WHERE status = 'scheduled' AND send_at <= ? ORDER BY send_at LIMIT 20").all(now);
  let sent = 0;
  for (const r of due) {
    const id = String(r.id);
    const agentRow = db.prepare("SELECT status FROM connect_agents WHERE id = ?").get(String(r.agent));
    const refusal = !agentRow ? "Not sent: the agent is no longer connected to Connect." : agentRow.status !== "active" ? "Not sent: the agent was paused when the post was due." : null;
    if (refusal) {
      db.prepare("UPDATE connect_buzz_scheduled SET status = 'cancelled', detail = ? WHERE id = ? AND status = 'scheduled'").run(refusal, id);
      log.warn("scheduled buzz post not sent", { agent: String(r.agent), reason: agentRow ? "paused" : "removed" });
      continue;
    }
    const claim = db.prepare("UPDATE connect_buzz_scheduled SET status = 'sending', claimed_at = ? WHERE id = ? AND status = 'scheduled'").run(now, id);
    if (claim.changes === 0) continue;
    try {
      const narrow = r.relays === null || r.relays === undefined ? undefined : (JSON.parse(String(r.relays)) as string[]);
      const out = await relay.post(String(r.agent), { channel: String(r.channel), content: String(r.content), ...(narrow ? { relays: narrow } : {}) });
      const failedOn = out.relays.filter((o) => !o.ok).map((o) => `${o.relay} (${o.ok ? "" : o.error})`);
      db.prepare("UPDATE connect_buzz_scheduled SET status = 'sent', event_id = ?, detail = ? WHERE id = ?").run(out.id, failedOn.length ? `Sent; failed on ${failedOn.join(", ")}`.slice(0, 300) : "", id);
      rememberBuzzSent(db, String(r.agent), out.id, String(r.channel));
      sent += 1;
    } catch (error) {
      db.prepare("UPDATE connect_buzz_scheduled SET status = 'failed', detail = ? WHERE id = ?").run(error instanceof Error ? error.message.slice(0, 300) : "failed", id);
      log.warn("scheduled buzz post failed", { code: (error as { code?: string }).code ?? "error" });
    }
  }
  return sent;
}

function ownerReadOf(db: Db, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM connect_tool_owner_reads WHERE name = ?").get(name);
}

/**
 * C331 (demo gap 4): why the owner cannot mark an MCP tool read, in the words of the real reason. Money names win over any claim
 * (CORE §7: money is always held); a class above the name inference came from the server's `destructiveHint`; otherwise the
 * server makes no read-only claim.
 */
function notConfirmableText(tool: { upstream: string; effect: string }): string {
  if (namesMoney(tool.upstream))
    return "Connect treats every tool whose name names money (a charge, payment, refund or transfer) as a money tool. Money tools are always held, so this one cannot be marked read.";
  if (tool.effect === "read") return "This tool is already treated as read-only.";
  if (tool.effect === "destructive" && inferFromName(tool.upstream).effect !== "destructive") return "The server marks this tool as destructive, so it cannot be marked read.";
  return "The server does not say this tool is read-only, so it cannot be marked read.";
}

/** X-02: the recipients of a send that ran are known to this caller on this account from now on. */
function rememberToolContacts(db: Db, caller: string, account: string, recipients: readonly string[]): void {
  const insert = db.prepare("INSERT OR IGNORE INTO connect_tool_contacts (caller, account, address, first_sent_at) VALUES (?, ?, ?, ?)");
  for (const r of recipients) insert.run(caller, account, r, Date.now());
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

function shortKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 12)}…${key.slice(-4)}` : key;
}

function cleanLabel(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 80) || "Workspace";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);
}

/** Composio's toolkit list changes rarely; one fetch per hour serves every search. */
class ToolkitCache {
  #value: { at: number; toolkits: ComposioToolkit[] } | null = null;
  async get(client: () => Promise<ComposioClient>, now = Date.now()): Promise<ComposioToolkit[]> {
    if (this.#value && now - this.#value.at < 3_600_000) return this.#value.toolkits;
    const toolkits = await (await client()).listToolkits();
    this.#value = { at: now, toolkits };
    return toolkits;
  }
}
