/**
 * Typed wrappers over `callOp` for the Connect person operations. The manifest declares person-op outputs as open
 * objects and tb-gen kit covers agent ops only, so these output types follow the handlers in `src/app.ts`
 * (REQUESTS `## connect: tb-gen person-op types`). Which ops need an idempotency key is NOT copied here (sdk.ts).
 */
import { callOp, type Json } from "./sdk.ts";

export type AccountKind = "as_me" | "as_itself";
export type AccountStatus = "pending" | "connected" | "failed" | "revoked";
export type ConnectMode = "api_key" | "no_auth" | "ready_managed" | "ready_user_key" | "needs_auth_config" | "not_supported";
export type AccessLevel = "read" | "read_update" | "read_update_delete";

export interface ServiceHit {
  service: string;
  name: string;
  description: string;
  logo: string | null;
  source: "composio" | "catalog";
  connectMode: ConnectMode;
  /** Catalog entries only: credential field names (["token"] or ["username", "password"]) and an address example. */
  fields?: string[];
  baseUrlExample?: string;
}

export interface Account {
  id: string;
  service: string;
  source: string;
  kind: AccountKind;
  label: string;
  ownerAgent: string | null;
  status: AccountStatus;
  detail: string;
  /** Chat accounts only (C230 R3): the apps the owner shared this account with. */
  shares?: AppShare[];
}

export interface AppShare {
  product: string;
  /** C240: the app instance the share is bound to (null = a share made before migration 0013: it serves nobody) */
  instance: string | null;
  /** false = the bound instance is not in the current list of apps that can call Connect, or there is none (before 0013) */
  current: boolean;
  level: ShareLevel;
  /** the owner included the log kept before the share began (30 days) */
  includeHistory: boolean;
  setAt: string;
}

/** R3: what an app may do with a chat account. none = nothing; available = dataset names and counts; shared = pull messages too. */
export type ShareLevel = "none" | "available" | "shared";
/** One line of the owner's "Recent access" list (R3 audit): which app asked for what. No message text. */
export interface AccessEntry {
  id: number;
  at: string;
  op: string;
  callerType: string;
  product: string | null;
  app: string | null;
  account: string | null;
  ok: boolean;
  outcome: string;
  rows: number;
  /** identical refusals within the same minute folded into this line */
  repeats: number;
}
export interface DataApp {
  product: string;
  name: string;
  /** C240: the installed instances of this app that can call Connect (verified, from the signed slice) */
  instances?: DataAppInstance[];
}
export interface DataAppInstance {
  instance: string;
  name: string;
  provider: string | null;
  /** runs on the owner's own infrastructure (provider own_infra) */
  ownInfra: boolean;
}

export interface BuzzIdentity {
  agent: string;
  displayName: string;
  pubkey: string;
  npub: string;
  createdAt: number;
  profilePublishedAt: number | null;
}

export interface BuzzAgentRow {
  agent: string;
  name: string;
  identity: BuzzIdentity | null;
  /** Owner's relay subset for this agent; null = all workspace relays (C73). */
  relays: string[] | null;
}

export type RelayOutcome = { relay: string; ok: true } | { relay: string; ok: false; error: string; detail: string };

export const servicesSearch = (query: string) => callOp<{ composioKey: boolean; catalogAvailable?: boolean; services: ServiceHit[] }>("services_search", { query });
/** `callersKnown` false = this Connect build cannot list the installed apps yet (miniapp-sdk < 0.1.32): no share can be made. */
export const accountsOverview = () => callOp<{ accounts: Account[]; dataApps?: DataApp[]; callersKnown?: boolean }>("accounts_overview", {});
export const accountAppShare = (account: string, product: string, level: ShareLevel, includeHistory: boolean, instance: string | null) =>
  callOp<{ account: string; product: string; level: ShareLevel; shares: AppShare[] }>("account_app_share", {
    account,
    product,
    level,
    includeHistory,
    ...(level !== "none" && instance ? { instance } : {}),
  });
export const dataAccessLog = () => callOp<{ entries: AccessEntry[] }>("data_access_log", {});
export const accountConnect = (input: { service: string; label: string; kind: AccountKind; agent?: string }) =>
  callOp<{ account: Account; redirectUrl: string }>("account_connect", input);
export const catalogAccountConnect = (input: {
  service: string;
  label: string;
  baseUrl: string;
  credentials: Record<string, string>;
  kind: AccountKind;
  agent?: string;
}) => callOp<{ account: Account }>("catalog_account_connect", input);
export const accountUpdate = (id: string, label: string) => callOp<{ account: Account }>("account_update", { id, label });
export const accountDisconnect = (id: string) => callOp<{ account: Account }>("account_disconnect", { id });
export const toolsRefresh = (service: string) => callOp<{ service: string; tools: Json }>("tools_refresh", { service });

/** X-03: one MCP tool as the owner sees it. `unverifiedReadClaim` = the server says read-only, Connect classes it higher. */
export interface McpToolRow {
  name: string;
  title: string;
  effect: string;
  holdFamily: string | null;
  unverifiedReadClaim: boolean;
  ownerConfirmedRead: boolean;
}
export const mcpToolsList = (service: string) => callOp<{ service: string; tools: McpToolRow[] }>("mcp_tools_list", { service });
export const mcpToolReadSet = (name: string, read: boolean) => callOp<{ name: string; effect: string; ownerConfirmedRead: boolean }>("mcp_tool_read_set", { name, read });

export const buzzIdentitiesList = () => callOp<{ relay: string | null; relays: string[]; relayProblems: string[]; agents: BuzzAgentRow[] }>("buzz_identities_list", {});
export const buzzAgentRelaysSet = (agent: string, relays: string[] | null) => callOp<{ agent: string; relays: string[] | null }>("buzz_agent_relays_set", { agent, relays });
export const buzzIdentitiesGenerate = () => callOp<{ created: BuzzIdentity[]; existing: BuzzIdentity[] }>("buzz_identities_generate", {});
export const buzzIdentityRotate = (agent: string) => callOp<{ identity: BuzzIdentity }>("buzz_identity_rotate", { agent });
export const buzzProfilePublish = (agent?: string) =>
  callOp<{ published: (BuzzIdentity & { relays: RelayOutcome[] })[]; failed: { agent: string; error: string; detail: string }[] }>("buzz_profile_publish", agent ? { agent } : {});

export type CrudWord = "create" | "update" | "delete";
/** C283 A1 / C283d (miniapp-sdk 0.1.36): what the SDK says about one account row of an agent. */
export interface AccessRow {
  level: AccessLevel;
  /** "owner" = set by the owner in Connect, primary (applies even above the Portal grant); "bounded" = the Portal grant caps it */
  authority: "owner" | "bounded" | null;
  /** CRUD the row's level now grants beyond what the owner accepted; NOT effective until the owner accepts (explicit click) */
  offerAdds: CrudWord[];
}
export interface AgentInfo {
  id: string;
  name: string;
  /** Account instance id → level; `null` when `tb.agents_list` did not say (shape not known). */
  levels: Record<string, AccessLevel> | null;
  /** Account instance id → row details (authority, offer); empty when the SDK does not say. */
  rows: Record<string, AccessRow>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const LEVELS: readonly string[] = ["read", "read_update", "read_update_delete"];

/**
 * `tb.agents_list` → "slice agents with their scope access" (SDK-API §6); the exact output shape is not frozen.
 * Accepted: an array or `{ agents }`; each entry `{ id | agent, name, access | scopes | grants: [{ type, instanceId | id, access }] }`.
 */
export function normalizeAgents(raw: unknown): AgentInfo[] {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.agents) ? raw.agents : [];
  const out: AgentInfo[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id : typeof entry.agent === "string" ? entry.agent : null;
    if (!id) continue;
    const rows = [entry.access, entry.scopes, entry.grants].find(Array.isArray) as unknown[] | undefined;
    let levels: AgentInfo["levels"] = null;
    const details: AgentInfo["rows"] = {};
    if (rows) {
      levels = {};
      for (const row of rows) {
        if (!isRecord(row) || (row.type !== undefined && row.type !== "account")) continue;
        const instance = typeof row.instanceId === "string" ? row.instanceId : typeof row.id === "string" ? row.id : null;
        if (instance && typeof row.access === "string" && LEVELS.includes(row.access)) {
          levels[instance] = row.access as AccessLevel;
          const adds = isRecord(row.offer) && Array.isArray(row.offer.adds) ? row.offer.adds : [];
          details[instance] = {
            level: row.access as AccessLevel,
            authority: row.authority === "owner" || row.authority === "bounded" ? row.authority : null,
            offerAdds: (["create", "update", "delete"] as const).filter((a) => adds.includes(a)),
          };
        }
      }
    }
    out.push({ id, name: typeof entry.name === "string" && entry.name ? entry.name : id, levels, rows: details });
  }
  return out;
}

export const agentsList = async (): Promise<AgentInfo[]> => normalizeAgents(await callOp<Json>("tb.agents_list", {}));
/** `tb.scopes_set` from the owner's session: the row becomes the owner's own (primary, C283 A1). */
export const scopesSet = (agent: string, accountId: string, access: AccessLevel | null) =>
  callOp<Json>("tb.scopes_set", { agent, type: "account", id: accountId, access });
/**
 * C283d: accept the row's offer at the SAME level. Only from an explicit owner click on the offer the page shows; a changed offer
 * is refused 409 `offer_changed` by the SDK.
 */
export const scopesAcceptOffer = (agent: string, accountId: string, access: AccessLevel, adds: CrudWord[]) =>
  callOp<Json>("tb.scopes_set", { agent, type: "account", id: accountId, access, acceptOffer: { adds } });

export const catalogAccountTest = (id: string) => callOp<{ ok: boolean; operation: string | null; detail: string }>("catalog_account_test", { id });

export interface ChannelProviderInfo {
  service: "slack" | "teams" | "telegram" | "discord";
  credentialFields: string[];
  settingFields: { key: string; label: string; type: "boolean" | "string"; default: boolean | string }[];
  inbound: "socket" | "poll" | "webhook";
}
export interface ChannelAccountInfo extends Account {
  bot: { id: string; name: string; inbound: string; detail: string } | null;
}
export const channelProviders = () => callOp<{ services: ChannelProviderInfo[]; agents: { id: string; name: string }[] }>("channel_providers", {});
export const channelAccounts = () => callOp<{ accounts: ChannelAccountInfo[] }>("channel_accounts", {});
export const channelAccountConnect = (input: { service: string; label: string; agent: string; credentials: Record<string, string>; settings?: Record<string, string | boolean> }) =>
  callOp<{ account: Account }>("channel_account_connect", input);

/** C86: the identity companion apps send from, per channel. */
export type SenderChannel = "buzz" | "slack" | "teams" | "telegram" | "discord";
export interface SenderInfo {
  channel: SenderChannel;
  set: boolean;
  label: string | null;
  account: string | null;
  /** "<channel>:<value>" */
  identity: string | null;
  setAt: string | null;
}
export const senderIdentitiesList = () => callOp<{ senders: SenderInfo[]; candidates: { id: string; service: string; label: string }[] }>("sender_identities_list", {});
export const senderIdentitySet = (input: { channel: SenderChannel; account?: string; label?: string }) => callOp<{ sender: SenderInfo }>("sender_identity_set", input);
export const senderIdentityClear = (channel: SenderChannel) => callOp<{ cleared: boolean }>("sender_identity_clear", { channel });
