/**
 * One HTTP call for one catalog operation (harvest: v1 openapi-http.ts rules, lines 1-23).
 * - Base URL re-checked by the outbound policy on every call (fresh DNS); `redirect: "error"`.
 * - Path parameters are encoded per segment; `.`/`..` and slashes in values are refused, so the final URL keeps
 *   the base origin and path prefix. Only declared query/header parameters are sent; a declared header the caller
 *   omits gets its schema const/default; transport headers and the credential header are never set from either.
 * - Credentials are attached here only; response text is scrubbed of every credential value; errors carry codes
 *   and statuses, never URLs with credentials or header values.
 */

import type { FetchLike } from "../../util/http.ts";
import { assertEndpointAllowed, type Lookup } from "../../util/net-policy.ts";
import { safeFetch } from "../../util/pinned-fetch.ts";
import { scrubSecrets } from "../../util/redact.ts";
import type { CompiledOperation } from "./openapi.ts";

export type CatalogAuth = { type: "header"; name: string; prefix?: string } | { type: "basic" } | { type: "query"; name: string } | { type: "none" };

export const CALL_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const FORBIDDEN_HEADERS = new Set([
  "host",
  "authorization",
  "cookie",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
  "accept",
  "proxy-authorization",
  "te",
  "upgrade",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "x-http-method-override",
  "x-method-override",
  "origin",
  "referer",
  "expect",
  "keep-alive",
]);

export class CatalogCallError extends Error {
  readonly code: string;
  readonly status: number | null;
  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = "CatalogCallError";
    this.code = code;
    this.status = status;
  }
}

/** Credential fields the owner enters for an auth kind (the API-key popup). */
export function credentialFields(auth: CatalogAuth): string[] {
  if (auth.type === "basic") return ["username", "password"];
  if (auth.type === "none") return [];
  return ["token"];
}

/** The value a declared header parameter takes when the caller omits it: schema `const`, else `default` (scalars only). */
export function headerDefault(p: { in: string; schema: Record<string, unknown> }): string | number | boolean | undefined {
  if (p.in !== "header") return undefined;
  const value = "const" in p.schema ? p.schema.const : p.schema.default;
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

function segment(value: unknown, name: string): string {
  if (value === undefined || value === null || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")) {
    throw new CatalogCallError("argument_invalid", `Path parameter ${name} is missing or not a scalar.`);
  }
  const text = String(value);
  if (!text || text === "." || text === ".." || /[/\\]/u.test(text)) throw new CatalogCallError("argument_invalid", `Path parameter ${name} is not a single segment.`);
  return encodeURIComponent(text);
}

/**
 * CF-NC-2: a multi-segment path value (a file path below a WebDAV root: "Documents/Q3 report/notes.md"). Split on "/", every
 * segment checked like a single one and percent-encoded on its own, joined with "/". Refused: a leading "/", empty, "." and
 * ".." segments (also percent-encoded dots), backslashes. One trailing "/" (a folder) is dropped. A "%2F" typed inside a name
 * stays part of that name ("%252F"), so it never becomes a separator.
 */
function segments(value: unknown, name: string): string {
  if (value === undefined || value === null || (typeof value !== "string" && typeof value !== "number")) {
    throw new CatalogCallError("argument_invalid", `Path parameter ${name} is missing or not a string.`);
  }
  const text = String(value);
  if (!text || text.startsWith("/") || text.includes("\\")) throw new CatalogCallError("argument_invalid", `Path parameter ${name} must be a relative path without backslashes.`);
  const parts = (text.endsWith("/") ? text.slice(0, -1) : text).split("/");
  for (const part of parts) {
    const dots = part.replace(/%2e/giu, ".");
    if (!part || dots === "." || dots === "..") throw new CatalogCallError("argument_invalid", `Path parameter ${name} has an empty, "." or ".." segment.`);
  }
  return parts.map((part) => encodeURIComponent(part)).join("/");
}

export function buildRequest(input: {
  baseUrl: string;
  basePath: string;
  op: CompiledOperation;
  args: Record<string, unknown>;
  auth: CatalogAuth;
  credentials: Record<string, string>;
}): { url: URL; init: RequestInit; secrets: string[] } {
  const base = new URL(input.baseUrl);
  const prefix = `${base.pathname.replace(/\/+$/u, "")}${input.basePath}`;
  const groups = (key: string) => (input.args[key] && typeof input.args[key] === "object" ? (input.args[key] as Record<string, unknown>) : {});
  const pathArgs = groups("path");
  const queryArgs = groups("query");
  const headerArgs = groups("header");
  const multi = new Set(input.op.parameters.filter((p) => p.in === "path" && p.multiSegment).map((p) => p.name));
  const path = input.op.path.replace(/\{([^}]+)\}/gu, (_m, name: string) => (multi.has(name) ? segments(pathArgs[name], name) : segment(pathArgs[name], name)));
  const url = new URL(base.origin);
  url.pathname = `${prefix}${path}`;
  const headers: Record<string, string> = { accept: "application/json" };
  for (const p of input.op.parameters) {
    if (p.in === "query" && queryArgs[p.name] !== undefined) {
      const value = queryArgs[p.name];
      for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(p.name, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    // A declared header the caller omits gets its schema const/default (v1 openapi-http.ts:478); the caller's value wins.
    const own = Object.hasOwn(headerArgs, p.name) ? headerArgs[p.name] : undefined;
    const headerValue = p.in === "header" ? (own ?? headerDefault(p)) : undefined;
    if (p.in === "header" && headerValue !== undefined) {
      if (FORBIDDEN_HEADERS.has(p.name.toLowerCase())) continue;
      if (input.auth.type === "header" && p.name.toLowerCase() === input.auth.name.toLowerCase()) continue;
      const v = String(headerValue);
      if (/[\r\n]/u.test(v)) throw new CatalogCallError("argument_invalid", `Header ${p.name} contains a line break.`);
      headers[p.name] = v;
    }
  }
  const unknownGroups = Object.keys(input.args).filter((k) => !["path", "query", "header", "body"].includes(k));
  if (unknownGroups.length) throw new CatalogCallError("argument_invalid", `Unknown argument groups: ${unknownGroups.join(", ")}.`);
  const secrets: string[] = [];
  if (input.auth.type === "header") {
    const token = input.credentials.token ?? "";
    if (!token) throw new CatalogCallError("credentials_missing", "The account has no API token.");
    headers[input.auth.name] = `${input.auth.prefix ?? ""}${token}`;
    secrets.push(token);
  } else if (input.auth.type === "basic") {
    const { username = "", password = "" } = input.credentials;
    if (!username || !password) throw new CatalogCallError("credentials_missing", "The account has no username/password.");
    const encoded = Buffer.from(`${username}:${password}`).toString("base64");
    headers.authorization = `Basic ${encoded}`;
    secrets.push(password, encoded);
  } else if (input.auth.type === "query") {
    const token = input.credentials.token ?? "";
    if (!token) throw new CatalogCallError("credentials_missing", "The account has no API token.");
    url.searchParams.set(input.auth.name, token);
    secrets.push(token);
  }
  let body: string | null = null;
  if (input.op.body && input.args.body !== undefined) {
    if (input.op.body.contentType === "application/json") {
      body = JSON.stringify(input.args.body);
      headers["content-type"] = "application/json";
    } else {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries((input.args.body ?? {}) as Record<string, unknown>)) form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      body = form.toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
  } else if (input.op.body?.required) {
    throw new CatalogCallError("argument_invalid", "This operation needs a body.");
  }
  return { url, init: { method: input.op.method.toUpperCase(), headers, body, redirect: "error" }, secrets };
}

/** QA INFO (0.6.0): an HTML error page reaches the agent only as its <title>; other text loses its tags and extra space. */
export function plainError(text: string): string {
  if (/<\s*(?:!doctype|html|head|body)\b/iu.test(text)) {
    const title = /<title[^>]*>([^<]{0,200})<\/title>/iu.exec(text)?.[1]?.trim();
    return title ? `HTML page "${title}"` : "HTML page";
  }
  return text.replace(/<[^>]{0,500}>/gu, " ").replace(/\s+/gu, " ").trim();
}

export async function callOperation(input: Parameters<typeof buildRequest>[0] & { fetchImpl?: FetchLike; lookup?: Lookup; allowOrigins?: readonly string[] }): Promise<{ status: number; data: unknown }> {
  await assertEndpointAllowed(input.baseUrl, {
    schemes: ["https:"],
    ...(input.lookup ? { lookup: input.lookup } : {}),
    ...(input.allowOrigins ? { allowOrigins: input.allowOrigins } : {}),
  });
  const { url, init, secrets } = buildRequest(input);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? safeFetch)(url, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch (error) {
    throw new CatalogCallError("upstream_unreachable", scrubSecrets(error instanceof Error ? error.message : String(error), secrets));
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new CatalogCallError("upstream_response_too_large", "The response is larger than 2 MiB.", response.status);
    }
    chunks.push(value);
  }
  const text = scrubSecrets(Buffer.concat(chunks).toString("utf8"), secrets);
  let data: unknown = text;
  if (/json/iu.test(response.headers.get("content-type") ?? "")) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text.slice(0, 4096);
    }
  } else data = text.slice(0, 64 * 1024);
  if (!response.ok) {
    const detail = typeof data === "string" ? plainError(data) : JSON.stringify(data);
    throw new CatalogCallError(response.status === 401 || response.status === 403 ? "upstream_unauthorized" : "upstream_error", `Upstream answered ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`, response.status);
  }
  return { status: response.status, data };
}
