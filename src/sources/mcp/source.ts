/**
 * Custom / third-party remote MCP servers (harvest: v1 custom-mcp.ts, mcp-url-policy.ts; HARVEST §B).
 * One account = one server URL (https, public address) + optional auth headers, all sealed in Connect.
 * Each server is its own service (`mcp_<host>_<hash>`), its tools classified by MCP annotations, then name.
 * No stdio servers (Connect never starts local processes). MCP OAuth follows once the bridge public URL reaches apps.
 */
import type { AppSecrets } from "@opt2-tealbrick/miniapp-sdk";
import type { Db } from "@opt2-tealbrick/spec/sdk";

import type { Account, AccountStore } from "../../accounts.ts";
import { classifyMcpTool, mcpReadClaimUnverified } from "../../effect.ts";
import { entrySchema, type ToolRegistry, toolName } from "../../tools.ts";
import type { FetchLike } from "../../util/http.ts";
import { sha256Hex } from "../../util/ids.ts";
import { assertEndpointAllowed, type Lookup } from "../../util/net-policy.ts";
import { McpClient, McpError, type McpResource, type McpResourceContent } from "./client.ts";
import { authorization, discover, exchangeCode, type OAuthClient, type OAuthServer, type OAuthTokens, refresh, register } from "./oauth.ts";
import { type McpPolicy, McpPolicyStore, raiseByPolicy } from "./policy.ts";

/** C373: what the documents producer may do with an MCP server: list and read resources. Never a tool call. */
export interface McpResourceSession {
  serverName: string | null;
  listResources(cursor: string | null): Promise<{ resources: McpResource[]; nextCursor: string | null }>;
  readResource(uri: string): Promise<McpResourceContent[]>;
}

/** What Connect keeps per MCP account in ctx.secrets (one name per account). */
type StoredAuth =
  | { kind: "headers"; headers: Record<string, string> }
  | { kind: "oauth"; server: OAuthServer; client: OAuthClient; redirectUri: string; verifier?: string; tokens?: OAuthTokens };

export const OAUTH_STATE_TTL_MS = 30 * 60 * 1000;

export const MAX_HEADERS = 10;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/u;
const RESERVED = new Set([
  "accept", "connection", "content-length", "content-type", "host", "keep-alive", "mcp-protocol-version", "mcp-session-id",
  "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "cookie",
]);

export function validateHeaders(headers: Record<string, unknown>): Record<string, string> {
  const entries = Object.entries(headers);
  if (entries.length > MAX_HEADERS) throw new McpError("mcp_headers_invalid", `At most ${MAX_HEADERS} headers.`);
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name) || RESERVED.has(name.toLowerCase())) throw new McpError("mcp_headers_invalid", `Header ${name} is not allowed.`);
    if (typeof value !== "string" || value.length > 4096 || /[\r\n\0]/u.test(value)) throw new McpError("mcp_headers_invalid", `Header ${name} has an invalid value.`);
    out[name.toLowerCase()] = value;
  }
  return out;
}

/** Service id for a server URL: readable host stem + 8 hex of the full URL (≤ 32 chars). */
export function mcpService(url: URL): string {
  const stem = url.hostname.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 18);
  return `mcp_${stem}_${sha256Hex(url.toString()).slice(0, 8)}`;
}

export interface McpDeps {
  db: Db;
  accounts: AccountStore;
  tools: ToolRegistry;
  secrets: AppSecrets;
  fetchImpl?: FetchLike;
  lookup?: Lookup;
  allowOrigins?: readonly string[];
}

export class McpSource {
  readonly #d: McpDeps;

  constructor(deps: McpDeps) {
    this.#d = deps;
  }

  async #checkedUrl(value: string): Promise<URL> {
    const url = await assertEndpointAllowed(value.trim(), {
      schemes: ["https:"],
      ...(this.#d.lookup ? { lookup: this.#d.lookup } : {}),
      ...(this.#d.allowOrigins ? { allowOrigins: this.#d.allowOrigins } : {}),
    });
    if (url.search || url.hash) throw new McpError("mcp_url_invalid", "The server address must not contain a query or fragment (put keys in headers).");
    return url;
  }

  get #net() {
    return {
      ...(this.#d.fetchImpl ? { fetchImpl: this.#d.fetchImpl } : {}),
      ...(this.#d.lookup ? { lookup: this.#d.lookup } : {}),
      ...(this.#d.allowOrigins ? { allowOrigins: this.#d.allowOrigins } : {}),
    };
  }

  async #stored(account: Account): Promise<StoredAuth> {
    const raw = await this.#d.secrets.get(`account:${account.id}`);
    if (!raw) throw new McpError("mcp_credentials_missing", "The account has no stored credentials; connect it again.");
    return JSON.parse(raw) as StoredAuth;
  }

  /** Request headers for an account; OAuth access tokens are refreshed 60 s before expiry (or when forced). */
  async #headers(account: Account, forceRefresh = false): Promise<Record<string, string>> {
    const stored = await this.#stored(account);
    if (stored.kind === "headers") return stored.headers;
    if (!stored.tokens) throw new McpError("mcp_oauth_incomplete", "Sign-in to this MCP server has not completed.");
    let tokens = stored.tokens;
    if (forceRefresh || (tokens.expiresAt !== null && tokens.expiresAt < Date.now() + 60_000)) {
      if (!tokens.refreshToken) throw new McpError("mcp_oauth_expired", "The sign-in expired; connect the server again.");
      tokens = await refresh(this.#net, stored.server, stored.client, tokens.refreshToken);
      await this.#d.secrets.put(`account:${account.id}`, JSON.stringify({ ...stored, tokens }));
    }
    return { authorization: `Bearer ${tokens.accessToken}` };
  }

  /** Step 1 of an OAuth connect: discovery, client registration, pending account, one-time state. */
  async startOAuth(input: { label: string; url: string; kind: "as_me" | "as_itself"; ownerAgent?: string | null; redirectUri: string }): Promise<{ account: Account; redirectUrl: string }> {
    const url = await this.#checkedUrl(input.url);
    const server = await discover(this.#net, url.toString());
    if (!server) throw new McpError("mcp_oauth_not_required", "This server needs no sign-in; connect it without OAuth.");
    const client = await register(this.#net, server, input.redirectUri, "Teal Brick Connect");
    const auth = authorization(server, client, input.redirectUri);
    const account = this.#d.accounts.create({
      service: mcpService(url),
      source: "mcp",
      kind: input.kind,
      label: input.label,
      ownerAgent: input.ownerAgent ?? null,
      externalRef: url.toString(),
      status: "pending",
    });
    const stored: StoredAuth = { kind: "oauth", server, client, redirectUri: input.redirectUri, verifier: auth.verifier };
    await this.#d.secrets.put(`account:${account.id}`, JSON.stringify(stored));
    this.#d.db
      .prepare("INSERT INTO connect_states (state_hash, account_id, purpose, expires_at) VALUES (?, ?, 'mcp_oauth', ?)")
      .run(sha256Hex(auth.state), account.id, Date.now() + OAUTH_STATE_TTL_MS);
    return { account, redirectUrl: auth.url };
  }

  /** Public callback: single-use state, code exchange with PKCE + resource, then tools are listed and registered. */
  async completeOAuth(input: { state: string | null; code: string | null; error: string | null }): Promise<Account> {
    if (!input.state) throw new McpError("connect_state_invalid", "The sign-in answer is missing its state.");
    const hash = sha256Hex(input.state);
    const row = this.#d.db.prepare("SELECT * FROM connect_states WHERE state_hash = ? AND purpose = 'mcp_oauth'").get(hash);
    if (!row || row.consumed_at !== null || Number(row.expires_at) < Date.now()) throw new McpError("connect_state_invalid", "This sign-in link is unknown, used or expired. Start again.");
    this.#d.db.prepare("UPDATE connect_states SET consumed_at = ? WHERE state_hash = ?").run(Date.now(), hash);
    const account = this.#d.accounts.get(String(row.account_id));
    if (account?.status !== "pending") throw new McpError("connect_state_invalid", "The pending connection no longer exists.");
    try {
      if (input.error || !input.code) throw new McpError("mcp_oauth_denied", `Sign-in was not completed${input.error ? ` (${input.error.slice(0, 60)})` : ""}.`);
      const stored = await this.#stored(account);
      if (stored.kind !== "oauth" || !stored.verifier) throw new McpError("connect_state_invalid", "The pending sign-in is incomplete.");
      const tokens = await exchangeCode(this.#net, stored.server, stored.client, { code: input.code, verifier: stored.verifier, redirectUri: stored.redirectUri });
      const { verifier: _used, ...rest } = stored;
      await this.#d.secrets.put(`account:${account.id}`, JSON.stringify({ ...rest, tokens }));
      const connected = this.#d.accounts.update(account.id, { status: "connected", detail: "" });
      await this.syncTools(connected);
      return connected;
    } catch (error) {
      this.#d.accounts.update(account.id, { status: "failed", detail: error instanceof Error ? error.message : "Sign-in failed." });
      throw error;
    }
  }

  async #client(url: string, headers: Record<string, string>): Promise<McpClient> {
    await this.#checkedUrl(url);
    return McpClient.connect({ url, headers, ...(this.#d.fetchImpl ? { fetchImpl: this.#d.fetchImpl } : {}) });
  }

  /** Connect a server: check the URL, list tools with the given headers (proves access), store, register tools. */
  async connect(input: { label: string; url: string; headers?: Record<string, unknown>; kind: "as_me" | "as_itself"; ownerAgent?: string | null }): Promise<Account> {
    const url = await this.#checkedUrl(input.url);
    const headers = validateHeaders(input.headers ?? {});
    const client = await this.#client(url.toString(), headers);
    let tools: Awaited<ReturnType<McpClient["listTools"]>>;
    try {
      tools = await client.listTools();
    } finally {
      await client.close();
    }
    const service = mcpService(url);
    const account = this.#d.accounts.create({
      service,
      source: "mcp",
      kind: input.kind,
      label: input.label,
      ownerAgent: input.ownerAgent ?? null,
      externalRef: url.toString(),
      status: "connected",
    });
    await this.#d.secrets.put(`account:${account.id}`, JSON.stringify({ kind: "headers", headers } satisfies StoredAuth));
    this.#register(service, tools);
    return account;
  }

  #register(service: string, tools: Awaited<ReturnType<McpClient["listTools"]>>): number {
    // X-03: a server's readOnlyHint is believed only for tools the owner confirmed as read in Connect.
    const ownerRead = new Set(this.#d.db.prepare("SELECT name FROM connect_tool_owner_reads").all().map((r) => String(r.name)));
    // C373 T3: the owner's or developer's policy for this server can only raise a class (money > destructive > outward > write)
    const policy = new McpPolicyStore(this.#d.db).get(service);
    return this.#d.tools.replaceService(
      "mcp",
      service,
      tools.map((t) => {
        const name = toolName(`${service}_${t.name}`);
        const readClaim = mcpReadClaimUnverified(t.name, t.annotations);
        return {
          name,
          upstream: t.name,
          title: (t.title ?? t.name).slice(0, 200),
          description: t.description ?? t.name,
          inputSchema: entrySchema(t.inputSchema),
          ...raiseByPolicy(t.name, classifyMcpTool(t.name, t.annotations, readClaim && ownerRead.has(name)), policy),
          ...(readClaim ? { readClaim: true } : {}),
        };
      }),
    );
  }

  /** C373 T3: the server's policy (null = none). */
  policyGet(service: string): McpPolicy | null {
    return new McpPolicyStore(this.#d.db).get(service);
  }

  /** C373 T3: save the policy of a connected server and re-make its tool classes now (one connected account is enough). */
  async policySet(service: string, policy: McpPolicy): Promise<number> {
    const account = this.#d.accounts.list({ service, status: "connected" }).find((a) => a.source === "mcp");
    if (!account) throw new McpError("mcp_service_unknown", "No connected MCP server with this service name.", 404);
    new McpPolicyStore(this.#d.db).set(service, policy);
    return this.syncTools(account);
  }

  async syncTools(account: Account): Promise<number> {
    if (!account.externalRef) throw new McpError("account_not_connected", "This account is not connected.");
    const client = await this.#client(account.externalRef, await this.#headers(account));
    try {
      return this.#register(account.service, await client.listTools());
    } finally {
      await client.close();
    }
  }

  async execute(account: Account, upstreamTool: string, args: Record<string, unknown>): Promise<unknown> {
    if (account.source !== "mcp" || account.status !== "connected" || !account.externalRef) throw new McpError("account_not_connected", "This account is not connected.");
    const run = async (forceRefresh: boolean) => {
      const client = await this.#client(account.externalRef as string, await this.#headers(account, forceRefresh));
      try {
        const result = await client.callTool(upstreamTool, args);
        if (result.isError) throw new McpError("mcp_tool_error", JSON.stringify(result.content).slice(0, 500));
        return { content: result.content, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}) };
      } finally {
        await client.close();
      }
    };
    try {
      return await run(false);
    } catch (error) {
      const oauth = (await this.#stored(account)).kind === "oauth";
      if (oauth && error instanceof McpError && error.code === "mcp_unauthorized") return run(true);
      throw error;
    }
  }

  /**
   * C373: a READ-ONLY session for the `documents` dataset: the server name, `resources/list` and `resources/read` only. The
   * object handed to `fn` has no way to call a tool. An OAuth account whose token the server refuses at the start is
   * refreshed once, as `execute` does.
   */
  async withResources<T>(account: Account, fn: (session: McpResourceSession) => Promise<T>): Promise<T> {
    if (account.source !== "mcp" || account.status !== "connected" || !account.externalRef) throw new McpError("account_not_connected", "This account is not connected.");
    const open = async (forceRefresh: boolean) => this.#client(account.externalRef as string, await this.#headers(account, forceRefresh));
    let client: McpClient;
    try {
      client = await open(false);
    } catch (error) {
      const oauth = (await this.#stored(account)).kind === "oauth";
      if (!(oauth && error instanceof McpError && error.code === "mcp_unauthorized")) throw error;
      client = await open(true);
    }
    try {
      return await fn({
        serverName: client.serverName,
        listResources: (cursor) => client.listResources(cursor ?? undefined),
        readResource: (uri) => client.readResource(uri),
      });
    } finally {
      await client.close();
    }
  }

  async disconnect(account: Account): Promise<Account> {
    await this.#d.secrets.delete(`account:${account.id}`);
    const revoked = this.#d.accounts.update(account.id, { status: "revoked", detail: "Disconnected by the owner." });
    if (this.#d.accounts.list({ service: account.service, status: "connected" }).length === 0) this.#d.tools.removeService("mcp", account.service);
    return revoked;
  }
}
