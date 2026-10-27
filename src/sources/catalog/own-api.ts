/**
 * C373 Jarvis T2, "bring your own API": the owner (or the developer building for the owner) gives Connect an OpenAPI 3 / Swagger 2
 * description of a service that no catalog entry and no Composio toolkit covers (Fatture in Cloud, PackLink Pro, a self-hosted
 * WordPress, a client's own REST API). Connect compiles it with the catalog compiler, so every operation gets the same hold
 * classes as a catalog app (GET read, DELETE destructive, money by name or label), plus the developer's own labels and a
 * fail-closed name rule for writes no label names (`inferNames`). The API is then a service in the list; its accounts are
 * ordinary catalog accounts (address + sealed key, address policy). The description and labels live in `connect_own_apis`
 * (migration 0022); key values never do.
 */
import { createHash } from "node:crypto";

import type { Db } from "@opt2-tealbrick/spec/sdk";

import type { CatalogAuth } from "./http.ts";
import { type CompiledOperation, compile, type EntryLabels } from "./openapi.ts";
import { type CatalogApp, CatalogError } from "./source.ts";

export const OWN_API_PREFIX = "api_";
/** The largest description Connect accepts (the JSON text). */
export const OWN_API_SPEC_MAX = 2 * 1024 * 1024;
export const OWN_API_OPS_MAX = 500;
export const OWN_APIS_MAX = 50;
const PATTERNS_MAX = 200;
const LABEL_KEYS = ["outward", "destructive", "reads", "money"] as const;

export interface OwnApiInput {
  name: string;
  description?: string;
  /** the OpenAPI 3.x / Swagger 2.0 description as JSON text */
  spec: string;
  auth: CatalogAuth;
  labels?: { outward?: string[]; destructive?: string[]; reads?: string[]; money?: string[]; excluded?: string[] };
  /** the path prefix to put before every path when the description's `servers` entry is missing or wrong (for example `/wp-json`) */
  basePath?: string;
  /** a GET operation (operationId) the service answers cheaply, used by "Test" */
  healthOperation?: string;
}

export interface OwnApiPreview {
  service: string;
  name: string;
  operations: number;
  counts: Record<string, number>;
  tools: { operationId: string; method: string; path: string; effect: string; holdFamily?: string }[];
  warnings: string[];
}

interface OwnApiRow {
  id: string;
  name: string;
  description: string;
  spec: string;
  spec_sha256: string;
  labels: string;
  auth: string;
  base_path: string | null;
  health_op: string | null;
  created_at: number;
}

const bad = (message: string): never => {
  throw new CatalogError("own_api_invalid", message);
};
const plain = (v: string) => /^[\x20-\x7e]*$/u.test(v);

export function ownApiId(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 24);
  if (!slug) bad("The name needs at least one letter or digit.");
  return `${OWN_API_PREFIX}${slug}`;
}

function checkAuth(raw: unknown): CatalogAuth {
  const a = (raw ?? {}) as Record<string, unknown>;
  if (a.type === "none" || a.type === "basic") return { type: a.type };
  if (a.type === "header" || a.type === "query") {
    const name = typeof a.name === "string" ? a.name.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(name)) bad(`The ${a.type} name must be 1 to 64 letters, digits, "-" or "_".`);
    if (a.type === "query") return { type: "query", name };
    const prefix = typeof a.prefix === "string" ? a.prefix : undefined;
    if (prefix !== undefined && (prefix.length > 32 || !plain(prefix))) bad("The prefix must be at most 32 plain characters (for example \"Bearer \").");
    return { type: "header", name, ...(prefix ? { prefix } : {}) };
  }
  return bad('Auth type must be "header", "query", "basic" or "none".');
}

function checkPatterns(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > PATTERNS_MAX) bad(`${field}: a list of at most ${PATTERNS_MAX} patterns.`);
  return (raw as unknown[]).map((p) => {
    if (typeof p !== "string" || !p.trim() || p.length > 200 || !plain(p)) bad(`${field}: each pattern is 1 to 200 plain characters (operationId, "METHOD /path" or "*" wildcards).`);
    return (p as string).trim();
  });
}

function checkSpec(text: unknown): unknown {
  if (typeof text !== "string" || !text.trim()) bad("Paste the API description (OpenAPI 3 or Swagger 2, as JSON).");
  if (Buffer.byteLength(text as string, "utf8") > OWN_API_SPEC_MAX) bad("The description is larger than 2 MiB.");
  let doc: unknown;
  try {
    doc = JSON.parse(text as string);
  } catch {
    bad("The description is not valid JSON. Convert a YAML file to JSON first.");
  }
  const d = (doc ?? {}) as Record<string, unknown>;
  const v3 = typeof d.openapi === "string" && /^3\./u.test(d.openapi);
  const v2 = d.swagger === "2.0";
  if (!v3 && !v2) bad('The description must be OpenAPI 3.x ("openapi": "3...") or Swagger 2.0 ("swagger": "2.0").');
  if (!d.paths || typeof d.paths !== "object") bad("The description has no paths.");
  return doc;
}

/** Validate the input and compile it: the app Connect will serve, its row, and what the owner sees before saving. */
export function buildOwnApi(input: OwnApiInput, reserved: ReadonlySet<string> = new Set()): { app: CatalogApp; row: Omit<OwnApiRow, "created_at">; preview: OwnApiPreview } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 60 || !plain(name)) bad("The name is 1 to 60 plain characters.");
  const id = ownApiId(name);
  if (reserved.has(id)) bad(`The name ${id} is taken by a catalog app. Choose another name.`);
  const description = typeof input.description === "string" ? input.description.trim().slice(0, 600) : "";
  const spec = checkSpec(input.spec);
  const auth = checkAuth(input.auth);
  const l = input.labels ?? {};
  const labels: EntryLabels = {
    ...Object.fromEntries(LABEL_KEYS.map((k) => [k, checkPatterns(l[k], k)])),
    excluded: checkPatterns(l.excluded, "excluded").map((operation) => ({ operation, reason: "excluded by the owner" })),
    inferNames: true,
  };
  const basePath = typeof input.basePath === "string" && input.basePath.trim() ? input.basePath.trim() : undefined;
  if (basePath !== undefined && (!/^\/[A-Za-z0-9._~\-/]{0,199}$/u.test(basePath) || basePath.includes(".."))) bad('The path prefix starts with "/" and holds only letters, digits and "/._~-".');
  let operations: CompiledOperation[];
  try {
    operations = compile(spec, labels).operations;
  } catch {
    return bad("Connect could not read the operations of this description.");
  }
  if (operations.length === 0) bad("The description has no operation Connect can call (JSON or form bodies only, no file uploads).");
  if (operations.length > OWN_API_OPS_MAX) bad(`The description has ${operations.length} operations; the most is ${OWN_API_OPS_MAX}. Exclude the ones you do not need.`);
  const healthOperation = typeof input.healthOperation === "string" && input.healthOperation.trim() ? input.healthOperation.trim() : null;
  const warnings: string[] = [];
  if (healthOperation) {
    const op = operations.find((o) => o.operationId === healthOperation);
    if (!op) bad(`The test operation ${healthOperation} is not in the description.`);
    if (op?.effect !== "read") bad(`The test operation ${healthOperation} must be a read (GET).`);
  } else warnings.push("No test operation: the Test button cannot check an account.");
  const counts: Record<string, number> = {};
  for (const op of operations) counts[op.effect] = (counts[op.effect] ?? 0) + 1;
  if (auth.type === "none") warnings.push("No auth: every call goes out without a key.");
  const specText = JSON.stringify(spec);
  const app: CatalogApp = {
    id,
    displayName: name,
    description: description || `Your own API (${operations.length} operations).`,
    category: "Your own API",
    version: String(((spec as Record<string, unknown>).info as Record<string, unknown> | undefined)?.version ?? "").slice(0, 40),
    auth,
    baseUrlExample: "",
    labels,
    spec,
    basePathOverride: basePath,
    healthOperation,
    credentialHint: "",
  };
  return {
    app,
    row: {
      id,
      name,
      description,
      spec: specText,
      spec_sha256: createHash("sha256").update(specText).digest("hex"),
      labels: JSON.stringify(labels),
      auth: JSON.stringify(auth),
      base_path: basePath ?? null,
      health_op: healthOperation,
    },
    preview: {
      service: id,
      name,
      operations: operations.length,
      counts,
      tools: operations.slice(0, OWN_API_OPS_MAX).map((o) => ({ operationId: o.operationId, method: o.method.toUpperCase(), path: o.path, effect: o.effect, ...(o.holdFamily ? { holdFamily: o.holdFamily } : {}) })),
      warnings,
    },
  };
}

export class OwnApiStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  list(): CatalogApp[] {
    const rows = this.#db.prepare("SELECT * FROM connect_own_apis ORDER BY created_at").all() as unknown as OwnApiRow[];
    return rows.map((r) => ({
      id: r.id,
      displayName: r.name,
      description: r.description || "Your own API.",
      category: "Your own API",
      version: "",
      auth: JSON.parse(r.auth) as CatalogAuth,
      baseUrlExample: "",
      labels: JSON.parse(r.labels) as EntryLabels,
      spec: JSON.parse(r.spec) as unknown,
      basePathOverride: r.base_path ?? undefined,
      healthOperation: r.health_op,
      credentialHint: "",
    }));
  }

  count(): number {
    return Number((this.#db.prepare("SELECT count(*) AS n FROM connect_own_apis").get() as { n: number }).n);
  }

  exists(id: string): boolean {
    return !!this.#db.prepare("SELECT 1 FROM connect_own_apis WHERE id = ?").get(id);
  }

  /** Insert or replace (the same name updates the description; connected accounts keep working with the new tools). */
  put(row: Omit<OwnApiRow, "created_at">, now = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO connect_own_apis (id, name, description, spec, spec_sha256, labels, auth, base_path, health_op, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, spec = excluded.spec,
           spec_sha256 = excluded.spec_sha256, labels = excluded.labels, auth = excluded.auth, base_path = excluded.base_path,
           health_op = excluded.health_op`,
      )
      .run(row.id, row.name, row.description, row.spec, row.spec_sha256, row.labels, row.auth, row.base_path, row.health_op, now);
  }

  remove(id: string): boolean {
    return Number(this.#db.prepare("DELETE FROM connect_own_apis WHERE id = ?").run(id).changes) > 0;
  }
}
