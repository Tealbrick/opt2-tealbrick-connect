/**
 * C373 Jarvis T3: a hold policy per MCP server (one Connect service `mcp_<host>_<hash>`), set by the owner or by the developer who
 * builds for the owner. MCP tools are classed by the server's annotations and their names (classifyMcpTool); a name such as
 * `update_campaign_budget` is a write there, although it spends money. The policy names such tools with patterns on the
 * server's own tool names, the same `*` patterns as a Composio policy, and can only RAISE a class: money > destructive >
 * outward > write. Lowering a class stays the owner's per-tool read confirmation (mcp_tool_read_set, X-03).
 */
import type { Db } from "@opt2-tealbrick/spec/sdk";

import { classify, effectRank, type ToolClass } from "../../effect.ts";
import { matches } from "../composio/policy.ts";

export const MCP_POLICY_KEYS = ["money", "destructive", "outward", "writes"] as const;
export type McpPolicyKey = (typeof MCP_POLICY_KEYS)[number];
export type McpPolicy = Partial<Record<McpPolicyKey, string[]>>;
const PATTERNS_MAX = 200;

export class McpPolicyError extends Error {
  readonly code = "mcp_policy_invalid";
}

const RAISED: Record<McpPolicyKey, ToolClass> = {
  money: classify({ write: true, outward: true, destructive: false, money: true }),
  destructive: classify({ write: true, outward: false, destructive: true }),
  outward: classify({ write: true, outward: true, destructive: false }),
  writes: classify({ write: true, outward: false, destructive: false }),
};

/** Check an input policy: only the four lists, each at most 200 plain patterns of at most 200 characters. */
export function parseMcpPolicy(raw: unknown): McpPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new McpPolicyError("The policy is an object with the lists money, destructive, outward and writes.");
  const out: McpPolicy = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(MCP_POLICY_KEYS as readonly string[]).includes(key)) throw new McpPolicyError(`Unknown list "${key.slice(0, 40)}". Use money, destructive, outward or writes.`);
    if (!Array.isArray(value) || value.length > PATTERNS_MAX) throw new McpPolicyError(`${key}: a list of at most ${PATTERNS_MAX} patterns.`);
    out[key as McpPolicyKey] = value.map((p) => {
      if (typeof p !== "string" || !p.trim() || p.length > 200 || !/^[\x20-\x7e]+$/u.test(p)) throw new McpPolicyError(`${key}: each pattern is 1 to 200 plain characters (a tool name or a * pattern).`);
      return p.trim();
    });
  }
  return out;
}

/** The class after the policy: the higher of the computed class and the first list (money first) that names the tool. */
export function raiseByPolicy(upstreamName: string, base: ToolClass, policy: McpPolicy | null | undefined): ToolClass {
  if (!policy) return base;
  for (const key of MCP_POLICY_KEYS) {
    if (!matches(policy[key] ?? [], upstreamName)) continue;
    const raised = RAISED[key];
    return effectRank(raised.effect) > effectRank(base.effect) ? raised : base;
  }
  return base;
}

export class McpPolicyStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  get(service: string): McpPolicy | null {
    const row = this.#db.prepare("SELECT policy FROM connect_mcp_policies WHERE service = ?").get(service) as { policy: string } | undefined;
    return row ? (JSON.parse(row.policy) as McpPolicy) : null;
  }

  /** An empty policy (no pattern in any list) removes the row. */
  set(service: string, policy: McpPolicy, now = Date.now()): void {
    if (MCP_POLICY_KEYS.every((k) => (policy[k] ?? []).length === 0)) {
      this.#db.prepare("DELETE FROM connect_mcp_policies WHERE service = ?").run(service);
      return;
    }
    this.#db
      .prepare("INSERT INTO connect_mcp_policies (service, policy, updated_at) VALUES (?, ?, ?) ON CONFLICT(service) DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at")
      .run(service, JSON.stringify(policy), now);
  }
}
