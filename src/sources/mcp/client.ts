/**
 * Remote MCP client, Streamable HTTP only (harvest: v1 mcp-remote-client.ts). Legacy SSE transport is not ported.
 * - `initialize` with protocol version negotiation, `notifications/initialized`, `mcp-session-id` and
 *   `mcp-protocol-version` headers, `tools/list` paging (cursor loop guard), `tools/call`, DELETE on close.
 * - C373: `resources/list` (one page per call, the caller keeps the MCP cursor) and `resources/read` for the `documents`
 *   dataset. Those two never call a tool.
 * - Replies as JSON or as an SSE stream (incremental parser, byte cap); `redirect: "error"`; timeouts
 *   connect/request 10 s, call 30 s; body cap 2 MiB; at most 200 tools.
 */
import type { FetchLike } from "../../util/http.ts";
import { safeFetch } from "../../util/pinned-fetch.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_REQUEST_TIMEOUT_MS = 10_000;
export const MCP_CALL_TIMEOUT_MS = 30_000;
export const MCP_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MCP_MAX_TOOLS = 200;
const MAX_PAGES = 50;

export class McpError extends Error {
  readonly code: string;
  readonly status: number | null;
  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.status = status;
  }
}

/** One entry of `resources/list` (MCP 2025-06-18 `Resource`), kept as the server sent it apart from type checks. */
export interface McpResource {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/** One entry of `resources/read` contents: text or base64 blob. */
export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
}

export const MCP_MAX_RESOURCES_PER_PAGE = 1000;

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);

/** Incremental text/event-stream parser (one `message` event = one JSON-RPC message). */
export class SseParser {
  #buffer = "";
  #event = "";
  #data: string[] = [];
  readonly #onEvent: (event: { event: string; data: string }) => void;
  readonly #max: number;

  constructor(onEvent: (event: { event: string; data: string }) => void, maxBytes: number) {
    this.#onEvent = onEvent;
    this.#max = maxBytes;
  }

  feed(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const match = /\r\n|\r|\n/u.exec(this.#buffer);
      if (!match) break;
      if (match[0] === "\r" && match.index === this.#buffer.length - 1) break;
      const line = this.#buffer.slice(0, match.index);
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
      this.#line(line);
    }
    if (this.#buffer.length > this.#max) throw new McpError("mcp_response_too_large", "The MCP server response was too large.");
  }

  #line(line: string): void {
    if (line === "") {
      if (this.#data.length > 0) this.#onEvent({ event: this.#event || "message", data: this.#data.join("\n") });
      this.#event = "";
      this.#data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.#event = value;
    if (field === "data") this.#data.push(value);
  }
}

export interface McpClientOptions {
  url: string;
  headers?: Record<string, string>;
  fetchImpl?: FetchLike;
  clientVersion?: string;
}

export class McpClient {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: FetchLike;
  readonly #clientVersion: string;
  #session: string | null = null;
  #protocol: string | null = null;
  #serverName: string | null = null;
  #nextId = 1;

  private constructor(options: McpClientOptions) {
    this.#url = options.url;
    this.#headers = options.headers ?? {};
    this.#fetch = options.fetchImpl ?? safeFetch;
    this.#clientVersion = options.clientVersion ?? "0";
  }

  static async connect(options: McpClientOptions): Promise<McpClient> {
    const client = new McpClient(options);
    const init = rec(
      await client.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "tealbrick-connect", version: client.#clientVersion } }, MCP_REQUEST_TIMEOUT_MS),
    );
    const version = init?.protocolVersion;
    if (typeof version !== "string" || !/^[\w.-]{1,32}$/u.test(version)) throw new McpError("mcp_protocol_error", "Invalid initialize result.");
    client.#protocol = version;
    const info = rec(init?.serverInfo);
    if (typeof info?.name === "string" && info.name.trim()) client.#serverName = info.name.trim().slice(0, 200);
    await client.#post({ jsonrpc: "2.0", method: "notifications/initialized" }, MCP_REQUEST_TIMEOUT_MS, null);
    return client;
  }

  #headersFor(): Headers {
    const h = new Headers(this.#headers);
    h.set("accept", "application/json, text/event-stream");
    h.set("content-type", "application/json");
    if (this.#session) h.set("mcp-session-id", this.#session);
    if (this.#protocol) h.set("mcp-protocol-version", this.#protocol);
    return h;
  }

  async #post(message: Rec, timeoutMs: number, expectId: number | null): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, { method: "POST", headers: this.#headersFor(), body: JSON.stringify(message), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new McpError("mcp_unreachable", `The MCP server could not be reached (${error instanceof Error ? error.name : "error"}).`);
    }
    const session = response.headers.get("mcp-session-id");
    if (session && /^[\x21-\x7e]{1,256}$/u.test(session)) this.#session = session;
    if (!response.ok) {
      await response.body?.cancel();
      throw new McpError(response.status === 401 || response.status === 403 ? "mcp_unauthorized" : "mcp_http_error", `The MCP server answered ${response.status}.`, response.status);
    }
    if (expectId === null) {
      await response.body?.cancel();
      return undefined;
    }
    const reader = response.body?.getReader();
    if (!reader) throw new McpError("mcp_protocol_error", "Empty MCP response.");
    const sse = (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
    const decoder = new TextDecoder();
    let total = 0;
    let text = "";
    let reply: Rec | undefined;
    const parser = new SseParser((event) => {
      if (event.event !== "message") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      const found = (Array.isArray(parsed) ? parsed : [parsed]).map(rec).find((m) => m?.id === expectId);
      if (found) reply = found;
    }, MCP_MAX_BODY_BYTES);
    while (!reply) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MCP_MAX_BODY_BYTES) {
        await reader.cancel();
        throw new McpError("mcp_response_too_large", "The MCP server response was too large.");
      }
      const chunk = decoder.decode(value, { stream: true });
      if (sse) parser.feed(chunk);
      else text += chunk;
    }
    if (reply) await reader.cancel().catch(() => undefined);
    if (!sse) {
      try {
        const parsed = JSON.parse(text) as unknown;
        reply = (Array.isArray(parsed) ? parsed : [parsed]).map(rec).find((m) => m?.id === expectId);
      } catch {
        throw new McpError("mcp_protocol_error", "The MCP server sent invalid JSON.");
      }
    }
    if (!reply) throw new McpError("mcp_protocol_error", "The MCP server did not answer the request.");
    const error = rec(reply.error);
    if (error) throw new McpError("mcp_rpc_error", `MCP error ${String(error.code ?? "")}: ${String(error.message ?? "").slice(0, 300)}`);
    return reply.result;
  }

  request(method: string, params: Rec, timeoutMs: number): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    return this.#post({ jsonrpc: "2.0", id, method, params }, timeoutMs, id);
  }

  async listTools(max = MCP_MAX_TOOLS): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES && tools.length < max; page += 1) {
      const result = rec(await this.request("tools/list", cursor ? { cursor } : {}, MCP_REQUEST_TIMEOUT_MS));
      if (!result || !Array.isArray(result.tools)) throw new McpError("mcp_protocol_error", "Invalid tools/list result.");
      for (const raw of result.tools) {
        const t = rec(raw);
        if (!t || typeof t.name !== "string" || !t.name.trim()) continue;
        tools.push({
          name: t.name,
          ...(typeof t.title === "string" ? { title: t.title.slice(0, 200) } : {}),
          ...(typeof t.description === "string" ? { description: t.description.slice(0, 1000) } : {}),
          ...("inputSchema" in t ? { inputSchema: t.inputSchema } : {}),
          ...(rec(t.annotations) ? { annotations: rec(t.annotations) as Rec } : {}),
        });
        if (tools.length >= max) break;
      }
      const next = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!next || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
    return tools;
  }

  /** `serverInfo.name` from initialize, when the server sent one. */
  get serverName(): string | null {
    return this.#serverName;
  }

  /** One page of `resources/list`. The caller pages with `nextCursor` (opaque, as the server sent it). */
  async listResources(cursor?: string): Promise<{ resources: McpResource[]; nextCursor: string | null }> {
    const result = rec(await this.request("resources/list", cursor ? { cursor } : {}, MCP_REQUEST_TIMEOUT_MS));
    if (!result || !Array.isArray(result.resources)) throw new McpError("mcp_protocol_error", "Invalid resources/list result.");
    const resources: McpResource[] = [];
    for (const raw of result.resources.slice(0, MCP_MAX_RESOURCES_PER_PAGE)) {
      const r = rec(raw);
      if (!r || typeof r.uri !== "string" || !r.uri.trim() || r.uri.length > 4096) continue;
      resources.push({
        uri: r.uri,
        ...(typeof r.name === "string" ? { name: r.name.slice(0, 1000) } : {}),
        ...(typeof r.title === "string" ? { title: r.title.slice(0, 1000) } : {}),
        ...(typeof r.description === "string" ? { description: r.description.slice(0, 2000) } : {}),
        ...(typeof r.mimeType === "string" ? { mimeType: r.mimeType.slice(0, 200) } : {}),
        ...(typeof r.size === "number" && Number.isFinite(r.size) ? { size: r.size } : {}),
        ...(rec(r.annotations) ? { annotations: rec(r.annotations) as Rec } : {}),
        ...(rec(r._meta) ? { _meta: rec(r._meta) as Rec } : {}),
      });
    }
    const next = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
    return { resources, nextCursor: next };
  }

  /** `resources/read` of one uri: the contents entries with a string `uri` and a string `text` or `blob`. */
  async readResource(uri: string): Promise<McpResourceContent[]> {
    const result = rec(await this.request("resources/read", { uri }, MCP_REQUEST_TIMEOUT_MS));
    if (!result || !Array.isArray(result.contents)) throw new McpError("mcp_protocol_error", "Invalid resources/read result.");
    const out: McpResourceContent[] = [];
    for (const raw of result.contents) {
      const c = rec(raw);
      if (!c) continue;
      const text = typeof c.text === "string" ? c.text : undefined;
      const blob = typeof c.blob === "string" ? c.blob : undefined;
      if (text === undefined && blob === undefined) continue;
      out.push({
        uri: typeof c.uri === "string" ? c.uri : uri,
        ...(typeof c.mimeType === "string" ? { mimeType: c.mimeType.slice(0, 200) } : {}),
        ...(text !== undefined ? { text } : {}),
        // the blob bytes are dropped here: the documents dataset carries text only (a blob is counted as skipped)
        ...(blob !== undefined ? { blob: "" } : {}),
        ...(rec(c._meta) ? { _meta: rec(c._meta) as Rec } : {}),
      });
    }
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; structuredContent?: unknown; isError: boolean }> {
    const result = rec(await this.request("tools/call", { name, arguments: args }, MCP_CALL_TIMEOUT_MS));
    if (!result) throw new McpError("mcp_protocol_error", "Invalid tools/call result.");
    return {
      content: Array.isArray(result.content) ? result.content : [],
      ...("structuredContent" in result ? { structuredContent: result.structuredContent } : {}),
      isError: result.isError === true,
    };
  }

  async close(): Promise<void> {
    if (!this.#session) return;
    try {
      await this.#fetch(this.#url, { method: "DELETE", headers: this.#headersFor(), redirect: "error", signal: AbortSignal.timeout(2_000) });
    } catch {
      // best effort
    }
  }
}
