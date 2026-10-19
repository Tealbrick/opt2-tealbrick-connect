/**
 * OpenAPI 3.x / Swagger 2.0 → catalog tools (harvest: v1 openapi-adapter.ts, company-box.ts; HARVEST §D).
 * One tool per operation: input `{path?, query?, header?, body?}` grouped by location, local `$ref`s inlined with a
 * node budget and cycle guard (oversized or cyclic schemas fall back to an open object). Risk per v1
 * `operationRisk` (openapi-adapter.ts:764-787): GET/HEAD/OPTIONS read; DELETE destructive; entry `destructive`
 * patterns; `reads` may only downgrade POST; `outward` patterns; `excluded` operations are skipped.
 * Only JSON and form-urlencoded bodies (no binary inputs in opt2, C11).
 */
import type { JsonSchemaObject } from "@opt2-tealbrick/spec/manifest";

import { classify, namesMoney, type ToolClass } from "../../effect.ts";
import { headerDefault } from "./http.ts";

export const METHODS = ["get", "head", "options", "post", "put", "patch", "delete"] as const;
export type Method = (typeof METHODS)[number];
const READ_METHODS = new Set<Method>(["get", "head", "options"]);
const NODE_BUDGET = 4_000;

export interface Parameter {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema: Record<string, unknown>;
}

export interface CompiledOperation extends ToolClass {
  operationId: string;
  method: Method;
  path: string;
  summary: string;
  parameters: Parameter[];
  body: { contentType: "application/json" | "application/x-www-form-urlencoded"; required: boolean; schema: Record<string, unknown> } | null;
  inputSchema: JsonSchemaObject;
}

export interface EntryLabels {
  outward?: string[];
  destructive?: string[];
  reads?: string[];
  excluded?: { operation: string; reason: string }[];
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function identity(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export function patternMatches(pattern: string, op: { operationId: string; method: string; path: string }): boolean {
  const regex = new RegExp(
    `^${pattern
      .trim()
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
      .join(".*")}$`,
    "iu",
  );
  return regex.test(op.operationId) || regex.test(identity(op.method, op.path));
}

function pointer(document: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = document;
  for (const raw of ref.slice(2).split("/")) {
    const token = raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
    node = rec(node)?.[token];
    if (node === undefined) return undefined;
  }
  return node;
}

/** Inline local `$ref`s. Returns null on a cycle, a missing target or when the node budget is spent. */
export function inline(document: unknown, schema: unknown): Rec | null {
  let nodes = 0;
  const walk = (value: unknown, stack: readonly string[]): unknown => {
    nodes += 1;
    if (nodes > NODE_BUDGET) throw new Error("budget");
    if (Array.isArray(value)) return value.map((v) => walk(v, stack));
    const r = rec(value);
    if (!r) return value;
    const ref = str(r.$ref);
    if (ref) {
      if (stack.includes(ref)) throw new Error("cycle");
      const target = pointer(document, ref);
      if (target === undefined) throw new Error("missing");
      const { $ref: _ignored, ...siblings } = r;
      const resolved = walk(target, [...stack, ref]);
      return Object.keys(siblings).length ? { allOf: [resolved], ...(walk(siblings, stack) as Rec) } : resolved;
    }
    const out: Rec = {};
    for (const [key, child] of Object.entries(r)) {
      if (key === "example" || key === "examples" || key === "xml" || key.startsWith("x-")) continue;
      out[key] = walk(child, stack);
    }
    return out;
  };
  try {
    const result = rec(walk(schema, []));
    return result ?? null;
  } catch {
    return null;
  }
}

const OPEN: Rec = { type: "object", additionalProperties: true };

function swaggerParamSchema(p: Rec): Rec {
  const out: Rec = {};
  for (const key of ["type", "format", "items", "enum", "default", "minimum", "maximum", "minLength", "maxLength", "pattern", "minItems", "maxItems"]) {
    if (key in p) out[key] = p[key];
  }
  return out;
}

function toolNameSegment(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

/** Stable operation id: the spec's operationId, else `<method>_<path>` in snake case. */
export function operationKey(method: string, path: string, operationId: string | undefined): string {
  return operationId ?? toolNameSegment(`${method}_${path.replace(/[{}]/gu, "")}`);
}

export function compile(raw: unknown, labels: EntryLabels = {}): { basePath: string; operations: CompiledOperation[] } {
  const doc = rec(raw);
  if (!doc) throw new Error("openapi_invalid");
  const swagger = str(doc.swagger) === "2.0";
  if (!swagger && !/^3\.\d+(\.\d+)?$/u.test(str(doc.openapi) ?? "")) throw new Error("openapi_version_unsupported");
  let basePath = "";
  if (swagger) basePath = str(doc.basePath) ?? "";
  else {
    const first = rec((doc.servers as unknown[] | undefined)?.[0]);
    let server = str(first?.url);
    // Substitute server variables with their defaults; a template that stays unresolved contributes no path.
    for (const [name, variable] of Object.entries(rec(first?.variables) ?? {})) {
      const value = str(rec(variable)?.default);
      if (server && value !== undefined) server = server.split(`{${name}}`).join(value);
    }
    if (server?.includes("{")) server = server.replace(/^[^/]*\{[^}]*\}[^/]*/u, "").replace(/\{[^}]*\}/gu, "");
    if (server) {
      try {
        basePath = new URL(server, "https://placeholder.invalid").pathname;
      } catch {
        basePath = "";
      }
    }
  }
  basePath = basePath.replace(/\/+$/u, "");
  const operations: CompiledOperation[] = [];
  for (const [path, item] of Object.entries(rec(doc.paths) ?? {})) {
    const pathItem = rec(item) ?? {};
    for (const method of METHODS) {
      const op = rec(pathItem[method]);
      if (!op || op.deprecated === true) continue;
      const operationId = operationKey(method, path, str(op.operationId));
      const subject = { operationId, method, path };
      if ((labels.excluded ?? []).some((e) => patternMatches(e.operation, subject))) continue;

      const merged = new Map<string, Rec>();
      for (const list of [pathItem.parameters, op.parameters]) {
        for (const p of Array.isArray(list) ? list : []) {
          const param = rec(str(rec(p)?.$ref) ? pointer(doc, String(rec(p)?.$ref)) : p);
          const name = str(param?.name);
          const location = str(param?.in);
          if (param && name && location) merged.set(`${location}:${name}`, param);
        }
      }
      const parameters: Parameter[] = [];
      let body: CompiledOperation["body"] = null;
      let unsupported = false;
      for (const p of merged.values()) {
        const location = String(p.in);
        if (location === "path" || location === "query" || location === "header") {
          const schema = inline(doc, swagger ? swaggerParamSchema(p) : (p.schema ?? {})) ?? {};
          // A header with a const/default is filled in at call time (http.ts headerDefault), so the agent may omit it.
          const filled = location === "header" && headerDefault({ in: location, schema }) !== undefined;
          parameters.push({ name: String(p.name), in: location, required: location === "path" || (p.required === true && !filled), schema });
        } else if (location === "body") {
          body = { contentType: "application/json", required: p.required === true, schema: inline(doc, p.schema ?? {}) ?? OPEN };
        } else if (location === "formData") {
          if (p.type === "file") unsupported = true;
        }
      }
      if (!swagger) {
        const requestBody = rec(str(rec(op.requestBody)?.$ref) ? pointer(doc, String(rec(op.requestBody)?.$ref)) : op.requestBody);
        const content = rec(requestBody?.content);
        if (content) {
          const json = Object.keys(content).find((t) => /json/iu.test(t));
          const form = Object.keys(content).find((t) => t.toLowerCase().startsWith("application/x-www-form-urlencoded"));
          const chosen = json ?? form;
          if (chosen) {
            body = {
              contentType: json ? "application/json" : "application/x-www-form-urlencoded",
              required: requestBody?.required === true,
              schema: inline(doc, rec(content[chosen])?.schema ?? {}) ?? OPEN,
            };
          } else if (requestBody?.required === true) unsupported = true;
        }
      }
      if (unsupported) continue;

      const readMethod = READ_METHODS.has(method);
      const readByLabel = method === "post" && (labels.reads ?? []).some((pattern) => patternMatches(pattern, subject));
      const destructive = method === "delete" || (labels.destructive ?? []).some((pattern) => patternMatches(pattern, subject));
      const outward = (labels.outward ?? []).some((pattern) => patternMatches(pattern, subject));
      // Money movement on a non-read method is always `money` (always held, SEC-02).
      const money = !readMethod && namesMoney(`${operationId} ${path}`);
      const cls = classify({ write: !readMethod && !readByLabel, outward, destructive, money });

      const group = (location: Parameter["in"]) => {
        const items = parameters.filter((p) => p.in === location);
        if (items.length === 0) return null;
        return {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(items.map((p) => [p.name, p.schema])),
          ...(items.some((p) => p.required) ? { required: items.filter((p) => p.required).map((p) => p.name) } : {}),
        };
      };
      const properties: Rec = {};
      const required: string[] = [];
      for (const location of ["path", "query", "header"] as const) {
        const g = group(location);
        if (g) {
          properties[location] = g;
          if ((g as Rec).required) required.push(location);
        }
      }
      if (body) {
        properties.body = body.schema;
        if (body.required) required.push("body");
      }
      operations.push({
        operationId,
        method,
        path,
        summary: (str(op.summary) ?? str(op.description) ?? identity(method, path)).slice(0, 300),
        parameters,
        body,
        inputSchema: { type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) },
        ...cls,
      });
    }
  }
  return { basePath, operations };
}
