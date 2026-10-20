/**
 * Tool registry behind the dynamic `tools` operation (MANIFEST §5.3, mode "search").
 * One row per third-party tool; the bridge reads it through the SDK bridge ops catalog / resolve.
 * Only tools of services with at least one connected account are offered (search filters on that).
 */
import type { CrudAction, DynamicCatalogEntry, DynamicResolution, Effect, HoldFamily, JsonSchemaObject } from "@opt2-tealbrick/spec/manifest";
import type { Db } from "@opt2-tealbrick/spec/sdk";

import { isSendTool, type ToolClass } from "./effect.ts";
import { sha256Hex } from "./util/ids.ts";

export const TOOL_SOURCES = ["composio", "catalog", "mcp"] as const;
export type ToolSource = (typeof TOOL_SOURCES)[number];

/**
 * X-02: `<tool>__first_contact` is the same send tool resolved with hold family `first_contact` (held by default, C105).
 * `tools.call` refuses the plain tool with `first_contact_required` while a recipient is new to the caller on that account;
 * the agent then calls this name with the same arguments and the owner approves the first contact once.
 * Plain tool names never contain `__` (toolName collapses separators), so the suffix cannot clash with a real tool.
 */
export const FIRST_CONTACT_SUFFIX = "__first_contact";

/** Argument every catalog entry carries so the agent can pick one of several accounts of the same service. */
export const ACCOUNT_ARGUMENT = "connect_account";
const NAME_PATTERN = /^[a-z][a-z0-9_]{1,47}$/u;
const SCHEMA_MAX_BYTES = 16_384;

export interface ToolRow extends ToolClass {
  name: string;
  source: ToolSource;
  service: string;
  upstream: string;
  title: string;
  description: string;
  inputSchema: JsonSchemaObject;
  /** X-03: MCP only — the server claims read-only, Connect classes it higher (owner may confirm it with mcp_tool_read_set) */
  readClaim?: boolean;
}

/** DynamicCatalogEntry.name from an upstream slug: lower snake case, ≤ 48 chars (hash suffix when shortened). */
export function toolName(upstream: string): string {
  let name = upstream.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  if (!/^[a-z]/u.test(name)) name = `t_${name}`;
  if (name.length > 48) name = `${name.slice(0, 39)}_${sha256Hex(upstream).slice(0, 8)}`;
  if (!NAME_PATTERN.test(name)) throw new Error(`tool_name_invalid: ${upstream}`);
  return name;
}

/** The tool's own schema plus the optional account selector; oversized schemas collapse to an open object. */
export function entrySchema(upstreamSchema: unknown): JsonSchemaObject {
  const base = (upstreamSchema && typeof upstreamSchema === "object" ? upstreamSchema : {}) as Record<string, unknown>;
  const properties = (base.properties && typeof base.properties === "object" ? base.properties : {}) as Record<string, unknown>;
  const accountProperty = {
    type: "string",
    description: "Connected account id or label. Optional when you have exactly one account for this service.",
  };
  let schema: JsonSchemaObject = {
    ...base,
    type: "object",
    properties: { ...properties, [ACCOUNT_ARGUMENT]: accountProperty },
  };
  delete (schema as Record<string, unknown>).$schema;
  delete (schema as Record<string, unknown>).$id;
  if (Buffer.byteLength(JSON.stringify(schema)) > SCHEMA_MAX_BYTES) {
    schema = {
      type: "object",
      description: "Large input schema: pass the upstream arguments as documented by the service.",
      properties: { [ACCOUNT_ARGUMENT]: accountProperty },
      additionalProperties: true,
    };
  }
  return schema;
}

function fromRow(row: Record<string, unknown>): ToolRow {
  return {
    name: String(row.name),
    source: String(row.source) as ToolSource,
    service: String(row.service),
    upstream: String(row.upstream),
    title: String(row.title),
    description: String(row.description),
    inputSchema: JSON.parse(String(row.input_schema)) as JsonSchemaObject,
    crud: JSON.parse(String(row.crud)) as CrudAction[],
    effect: String(row.effect) as Effect,
    ...(row.hold_family ? { holdFamily: String(row.hold_family) as HoldFamily } : {}),
    ...(Number(row.read_claim ?? 0) === 1 ? { readClaim: true } : {}),
  };
}

export function toEntry(row: ToolRow): DynamicCatalogEntry {
  return {
    name: row.name,
    title: row.title.slice(0, 200),
    description: `[${row.service}] ${row.description}`.slice(0, 1000),
    inputSchema: row.inputSchema,
    crud: row.crud,
    effect: row.effect,
    ...(row.holdFamily ? { holdFamily: row.holdFamily } : {}),
  };
}

export class ToolRegistry {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Replace every tool of one (source, service) in one transaction. */
  replaceService(source: ToolSource, service: string, tools: readonly Omit<ToolRow, "source" | "service">[], now = Date.now()): number {
    return this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM connect_tools WHERE source = ? AND service = ?").run(source, service);
      const insert = this.#db.prepare(
        `INSERT INTO connect_tools (name, source, service, upstream, title, description, input_schema, crud, effect, hold_family, read_claim, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET source = excluded.source, service = excluded.service, upstream = excluded.upstream,
           title = excluded.title, description = excluded.description, input_schema = excluded.input_schema, crud = excluded.crud,
           effect = excluded.effect, hold_family = excluded.hold_family, read_claim = excluded.read_claim, updated_at = excluded.updated_at`,
      );
      for (const tool of tools) {
        insert.run(
          tool.name, source, service, tool.upstream, tool.title, tool.description, JSON.stringify(tool.inputSchema),
          JSON.stringify(tool.crud), tool.effect, tool.holdFamily ?? null, tool.readClaim ? 1 : 0, now,
        );
      }
      return tools.length;
    });
  }

  /** Every tool of one service across sources (CF-PZ-1 hints: which tools a caller cannot use and why). */
  forService(service: string): ToolRow[] {
    return this.#db.prepare("SELECT * FROM connect_tools WHERE service = ? ORDER BY name").all(service).map(fromRow);
  }

  /** Every tool of one (source, service), by name (owner views; X-03). */
  listService(source: ToolSource, service: string): ToolRow[] {
    return this.#db.prepare("SELECT * FROM connect_tools WHERE source = ? AND service = ? ORDER BY name").all(source, service).map(fromRow);
  }

  /** Overwrite the class of one tool (X-03: the owner confirmed an MCP tool as read, or withdrew that). */
  setClass(name: string, cls: ToolClass, now = Date.now()): void {
    this.#db
      .prepare("UPDATE connect_tools SET crud = ?, effect = ?, hold_family = ?, updated_at = ? WHERE name = ?")
      .run(JSON.stringify(cls.crud), cls.effect, cls.holdFamily ?? null, now, name);
  }

  removeService(source: ToolSource, service: string): void {
    this.#db.prepare("DELETE FROM connect_tools WHERE source = ? AND service = ?").run(source, service);
  }

  countFor(service: string): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM connect_tools WHERE service = ?").get(service);
    return Number(row?.n ?? 0);
  }

  get(name: string): ToolRow | null {
    const row = this.#db.prepare("SELECT * FROM connect_tools WHERE name = ?").get(name);
    return row ? fromRow(row) : null;
  }

  resolve(name: string): DynamicResolution | null {
    if (name.endsWith(FIRST_CONTACT_SUFFIX)) {
      const base = this.get(name.slice(0, -FIRST_CONTACT_SUFFIX.length));
      if (!base || !isSendTool(base)) return null;
      return { tool: name, crud: base.crud, effect: base.effect, holdFamily: "first_contact" };
    }
    const row = this.get(name);
    if (!row) return null;
    return { tool: row.name, crud: row.crud, effect: row.effect, ...(row.holdFamily ? { holdFamily: row.holdFamily } : {}) };
  }

  /**
   * Search tools of the given services (F85). The query is tokenised (case-insensitive, light plural folding, list/fetch/get/find/search/read verbs folded to one word) and a tool matches
   * when ANY word hits its name, title, description or service; results are ranked by word overlap (name and service words count
   * most, then title, then description), ties by name. A tool must hit at least one word that is not just its own service name,
   * unless every query word names a service. Empty query lists the first `limit` tools.
   */
  search(query: string, services: readonly string[], limit = 20): DynamicCatalogEntry[] {
    if (services.length === 0) return [];
    const words = [...new Set(tokens(query))].slice(0, 12);
    const placeholders = services.map(() => "?").join(", ");
    // Ranking needs the folded words of every row, so the SQL only scopes by service (a few hundred rows per service at most).
    const rows = this.#db
      .prepare(`SELECT * FROM connect_tools WHERE service IN (${placeholders}) ORDER BY service, name LIMIT 5000`)
      .all(...services)
      .map(fromRow);
    if (words.length === 0) return rows.slice(0, Math.max(1, Math.min(limit, 50))).map(toEntry);
    const everyWordIsAService = words.every((w) => services.some((svc) => tokens(svc).includes(w)));
    const ranked = rows
      .map((row) => ({ row, ...scoreRow(row, words) }))
      .filter((r) => r.score > 0 && (r.outside > 0 || everyWordIsAService))
      .sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name));
    return ranked.slice(0, Math.max(1, Math.min(limit, 50))).map((r) => toEntry(r.row));
  }
}

/** Verbs that ask for the same thing in a tool name ("list messages" finds "fetch emails"): folded to one word on both sides. */
const READ_SYNONYMS = new Set(["list", "fetch", "get", "find", "search", "retrieve", "read", "lookup", "show", "query"]);

/** Lower-case words of a text; plural folded (messages → message, entries → entry, fetches → fetch); read verbs folded; one-letter words dropped. */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((w) => w.length > 1)
    .map((w) => {
      if (READ_SYNONYMS.has(w)) return "get";
      if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
      if (w.length > 4 && /(ches|shes|sses|xes)$/u.test(w)) return w.slice(0, -2);
      if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
      return w;
    });
}

/** Word overlap: per query word the best field weight (name/service 3, title 2, description 1); `outside` counts words hit outside the service name. */
function scoreRow(row: ToolRow, words: readonly string[]): { score: number; outside: number } {
  const name = new Set(tokens(row.name));
  const service = new Set(tokens(row.service));
  const title = new Set(tokens(row.title));
  const description = new Set(tokens(row.description));
  let score = 0;
  let outside = 0;
  for (const w of words) {
    const inService = service.has(w);
    const inName = name.has(w);
    const best = inName || inService ? 3 : title.has(w) ? 2 : description.has(w) ? 1 : 0;
    score += best;
    if (best > 0 && !inService) outside++;
  }
  return { score, outside };
}
