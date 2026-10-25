/**
 * Outbound address policy for owner-entered endpoints (Buzz relay, MCP servers, catalog base URLs).
 * Harvest: v1 mcp-url-policy.ts + buzz-relay-guard.ts. Refused: loopback, unspecified, RFC 1918, CGNAT 100.64/10,
 * link-local (incl. cloud metadata 169.254.169.254), ULA fc00::/7 (Railway private network), multicast, reserved,
 * IPv4-mapped/NAT64 forms of those, and local names (localhost, *.local, *.internal, single label).
 * Every DNS answer must be public. Exact `allowOrigins` (tests / test relay) bypass the address checks.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Lookup = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;
export const defaultLookup: Lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export class NetPolicyError extends Error {
  readonly code = "endpoint_not_allowed";
  readonly reason: string;
  constructor(reason: string) {
    super(`Endpoint is not allowed (${reason}).`);
    this.reason = reason;
  }
}

function v4Forbidden(o: number[]): boolean {
  const [a = 0, b = 0] = o;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (o[2] === 0 || o[2] === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && o[2] === 100) ||
    (a === 203 && b === 0 && o[2] === 113)
  );
}

function expandV6(address: string): number[] | null {
  let normalized: string;
  try {
    // WHATWG URL parsing normalises IPv6 (embedded IPv4 becomes two hex groups, zone ids are refused).
    normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const [head = "", rest] = normalized.split("::");
  const h = head ? head.split(":").map((x) => Number.parseInt(x, 16)) : [];
  const r = rest ? rest.split(":").map((x) => Number.parseInt(x, 16)) : [];
  const groups = rest === undefined ? h : [...h, ...Array<number>(8 - h.length - r.length).fill(0), ...r];
  return groups.length === 8 && groups.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? groups : null;
}

export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return v4Forbidden(address.split(".").map(Number));
  if (family !== 6) return true;
  const g = expandV6(address);
  if (!g) return true;
  const [g0 = 0, , , , , g5 = 0, g6 = 0, g7 = 0] = g;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g7 === 1) return true; // ::1
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g[1] === 0x0db8) return true; // documentation
  const embedded = [g6 >>> 8, g6 & 0xff, g7 >>> 8, g7 & 0xff];
  if (g.slice(0, 5).every((x) => x === 0) && (g5 === 0xffff || g5 === 0)) return v4Forbidden(embedded); // mapped / compat
  if (g0 === 0x64 && g[1] === 0xff9b) return v4Forbidden(embedded); // NAT64
  return false;
}

/** Local names: localhost, *.localhost, *.local, *.internal, single label. */
export function isForbiddenHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/u, "");
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".");
}

export interface PolicyOptions {
  schemes: readonly string[];
  allowOrigins?: readonly string[];
  lookup?: Lookup;
}

/** Parse and check an endpoint URL; resolves the host and refuses any non-public answer. */
export async function assertEndpointAllowed(value: string, options: PolicyOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NetPolicyError("invalid_url");
  }
  if (options.allowOrigins?.includes(url.origin)) return url;
  if (!options.schemes.includes(url.protocol)) throw new NetPolicyError("scheme_not_allowed");
  if (url.username || url.password) throw new NetPolicyError("userinfo_not_allowed");
  if (url.hash) throw new NetPolicyError("fragment_not_allowed");
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (isIP(host)) {
    if (isForbiddenAddress(host)) throw new NetPolicyError("address_not_allowed");
    return url;
  }
  if (isForbiddenHostname(host)) throw new NetPolicyError("hostname_not_allowed");
  let answers: ReadonlyArray<{ address: string }>;
  try {
    answers = await (options.lookup ?? defaultLookup)(host);
  } catch {
    throw new NetPolicyError("dns_lookup_failed");
  }
  if (answers.length === 0) throw new NetPolicyError("dns_lookup_failed");
  if (answers.some((a) => isForbiddenAddress(a.address))) throw new NetPolicyError("address_not_allowed");
  return url;
}

/**
 * A bare host (no URL) for a non-HTTP endpoint such as a database (C336 RQ-3). The same rules as `assertEndpointAllowed`:
 * an IP literal must be public, local names are refused, every DNS answer must be public. Returns the address the check
 * passed, so the caller can connect to THAT address (no second DNS answer between the check and the connection).
 * `allowHosts` are exact host names that skip the address checks (tests only; no owner-facing exception exists, C41).
 */
export async function resolvePublicHost(value: string, options: { allowHosts?: readonly string[]; lookup?: Lookup } = {}): Promise<{ host: string; address: string }> {
  const host = value.trim().replace(/^\[|\]$/gu, "").toLowerCase();
  if (!host || host.length > 253 || /[\s/@?#\\]/u.test(host)) throw new NetPolicyError("invalid_host");
  if (options.allowHosts?.includes(host)) {
    if (isIP(host)) return { host, address: host };
    const answers = await (options.lookup ?? defaultLookup)(host).catch(() => []);
    return { host, address: answers[0]?.address ?? host };
  }
  if (isIP(host)) {
    if (isForbiddenAddress(host)) throw new NetPolicyError("address_not_allowed");
    return { host, address: host };
  }
  if (isForbiddenHostname(host)) throw new NetPolicyError("hostname_not_allowed");
  let answers: ReadonlyArray<{ address: string }>;
  try {
    answers = await (options.lookup ?? defaultLookup)(host);
  } catch {
    throw new NetPolicyError("dns_lookup_failed");
  }
  const first = answers[0];
  if (!first) throw new NetPolicyError("dns_lookup_failed");
  if (answers.some((a) => isForbiddenAddress(a.address))) throw new NetPolicyError("address_not_allowed");
  return { host, address: first.address };
}
