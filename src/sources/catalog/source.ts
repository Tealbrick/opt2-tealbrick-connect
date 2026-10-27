/**
 * Tealbrick catalog lane (Company Box seed): the sha256-pinned artifact from the manifest `artifacts[catalog]`,
 * per-app tools compiled from the pinned OpenAPI specs with our labels, accounts = (base URL + sealed credentials)
 * entered in Connect's own API-key popup (app-own secrets, allowed under option B, CORE §13).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import type { AppSecrets } from "@opt2-tealbrick/miniapp-sdk";
import type { Artifact } from "@opt2-tealbrick/spec/manifest";

import type { Account, AccountStore } from "../../accounts.ts";
import { isPostizCreatePost } from "../../postiz.ts";
import { DRAFT_SUFFIX, entrySchema, type ToolRegistry, toolName } from "../../tools.ts";
import type { FetchLike } from "../../util/http.ts";
import { assertEndpointAllowed, type Lookup } from "../../util/net-policy.ts";
import { type CatalogAuth, callOperation, credentialFields } from "./http.ts";
import { type CompiledOperation, compile, type EntryLabels } from "./openapi.ts";
import { buildOwnApi, OWN_APIS_MAX, type OwnApiInput, type OwnApiPreview, type OwnApiStore } from "./own-api.ts";

export const CATALOG_FORMAT = "tealbrick.catalog/1";
/**
 * C276a review #17: catalog apps whose every write keeps the full [create, update] (no per-method narrowing). Authentik is the
 * identity provider: users, groups, roles, flows, stages, sources, providers and outposts all change who can sign in. An entry
 * can also set `fullCrud: true` itself.
 */
export const FULL_CRUD_APPS: ReadonlySet<string> = new Set(["authentik"]);
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

export interface CatalogApp {
  id: string;
  displayName: string;
  description: string;
  category: string;
  version: string;
  auth: CatalogAuth & { label?: string };
  baseUrlExample: string;
  labels: EntryLabels;
  spec: unknown;
  basePathOverride: string | undefined;
  /** operationId the app answers cheaply when the account works (entry `healthOperation`). */
  healthOperation: string | null;
  /** shown under the credential field when the owner connects an account (entry `credentialHint`, ≤ 300 chars) */
  credentialHint: string;
}

/** C276c: entry `firstContact` — [{operation, recipients: ["body.<field>" | "query.<field>" | "path.<field>"]}]; invalid → refused. */
function parseFirstContact(raw: unknown, id: string): NonNullable<EntryLabels["firstContact"]> {
  if (raw === undefined) return [];
  const ok =
    Array.isArray(raw) &&
    raw.every(
      (f) =>
        f &&
        typeof f === "object" &&
        typeof (f as { operation?: unknown }).operation === "string" &&
        Array.isArray((f as { recipients?: unknown }).recipients) &&
        ((f as { recipients: unknown[] }).recipients).every((p) => typeof p === "string" && /^(body|query|path)\.[A-Za-z0-9_-]{1,64}$/u.test(p)),
    );
  if (!ok) throw new CatalogError("catalog_entry_invalid", `${id}: firstContact is invalid.`);
  return raw as NonNullable<EntryLabels["firstContact"]>;
}

export class CatalogError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CatalogError";
    this.code = code;
  }
}

/** Parse + verify a downloaded bundle: outer sha256 = manifest pin, every file sha256 = its recorded digest. */
export function parseBundle(gz: Uint8Array, pin: string): CatalogApp[] {
  const actual = sha256(gz);
  if (actual !== pin) throw new CatalogError("catalog_pin_mismatch", `Catalog artifact sha256 ${actual} does not match the pin.`);
  const bundle = JSON.parse(gunzipSync(gz).toString("utf8")) as {
    format?: string;
    entries?: { id: string; entry: Record<string, unknown>; files: { name: string; sha256: string; content: string }[] }[];
  };
  if (bundle.format !== CATALOG_FORMAT || !Array.isArray(bundle.entries)) throw new CatalogError("catalog_format_invalid", "Unknown catalog format.");
  return bundle.entries.map((e) => {
    for (const f of e.files) if (sha256(f.content) !== f.sha256) throw new CatalogError("catalog_file_mismatch", `${e.id}/${f.name} digest mismatch.`);
    const entry = e.entry;
    const openapi = (entry.openapi ?? {}) as { spec?: string; basePath?: string; overlay?: { file?: string } };
    const specFile = e.files.find((f) => f.name === openapi.spec);
    if (!specFile) throw new CatalogError("catalog_spec_missing", `${e.id}: spec file missing.`);
    let spec: unknown = JSON.parse(specFile.content);
    // v1 company-box.ts:391-393: the pinned overlay (RFC 7396 merge patch) supplements what the upstream spec lacks.
    if (openapi.overlay) {
      const overlayFile = e.files.find((f) => f.name === openapi.overlay?.file);
      if (!overlayFile) throw new CatalogError("catalog_overlay_missing", `${e.id}: overlay file missing.`);
      spec = applyMergePatch(spec, JSON.parse(overlayFile.content));
    }
    const app = (entry.app ?? {}) as { version?: string };
    return {
      id: e.id,
      displayName: String(entry.displayName ?? e.id),
      description: String(entry.description ?? "").slice(0, 600),
      category: String(entry.category ?? ""),
      version: String(app.version ?? ""),
      auth: (entry.auth ?? { type: "none" }) as CatalogApp["auth"],
      baseUrlExample: String(entry.baseUrlExample ?? ""),
      labels: {
        outward: (entry.outward as string[] | undefined) ?? [],
        destructive: (entry.destructive as string[] | undefined) ?? [],
        reads: (entry.reads as string[] | undefined) ?? [],
        excluded: (entry.excluded as EntryLabels["excluded"]) ?? [],
        fullCrud: entry.fullCrud === true || FULL_CRUD_APPS.has(e.id),
        firstContact: parseFirstContact(entry.firstContact, e.id),
      },
      credentialHint: typeof entry.credentialHint === "string" ? entry.credentialHint.slice(0, 300) : "",
      spec,
      basePathOverride: typeof openapi.basePath === "string" ? openapi.basePath : undefined,
      healthOperation: typeof entry.healthOperation === "string" ? entry.healthOperation : null,
    };
  });
}

export interface CatalogDeps {
  artifact: Artifact | undefined;
  dataDir: string;
  accounts: AccountStore;
  tools: ToolRegistry;
  secrets: AppSecrets;
  fetchImpl?: FetchLike;
  lookup?: Lookup;
  allowOrigins?: readonly string[];
  /** C373 T2: the owner's own API descriptions (migration 0022); absent = none */
  ownApis?: OwnApiStore;
}

export class CatalogSource {
  readonly #d: CatalogDeps;
  #apps: Map<string, CatalogApp> | null = null;
  #compiled = new Map<string, { basePath: string; byName: Map<string, CompiledOperation> }>();

  constructor(deps: CatalogDeps) {
    this.#d = deps;
  }

  /** The pinned catalog plus the owner's own APIs (C373 T2). An own API never shadows a catalog app (its id starts with `api_`). */
  async apps(): Promise<Map<string, CatalogApp>> {
    if (this.#apps) return this.#apps;
    const own = this.#d.ownApis?.list() ?? [];
    let apps: Map<string, CatalogApp>;
    try {
      apps = await this.#catalogApps();
    } catch (error) {
      // the catalog download failing must not hide the owner's own APIs; not cached, so the catalog is tried again next time
      if (own.length === 0) throw error;
      return new Map(own.map((a) => [a.id, a]));
    }
    for (const a of own) if (!apps.has(a.id)) apps.set(a.id, a);
    this.#apps = apps;
    return apps;
  }

  /** Load the pinned artifact (cached on the data volume, verified on every load). */
  async #catalogApps(): Promise<Map<string, CatalogApp>> {
    const artifact = this.#d.artifact ?? (() => {
      throw new CatalogError("catalog_not_declared", "The manifest declares no catalog artifact.");
    })();
    const file = join(this.#d.dataDir, "catalog", `tealbrick-catalog-${artifact.version}.json.gz`);
    let gz: Uint8Array;
    if (existsSync(file)) gz = readFileSync(file);
    else {
      const response = await (this.#d.fetchImpl ?? fetch)(artifact.url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new CatalogError("catalog_download_failed", `Catalog download answered ${response.status}.`);
      gz = new Uint8Array(await response.arrayBuffer());
      if (sha256(gz) !== artifact.sha256) throw new CatalogError("catalog_pin_mismatch", "Downloaded catalog does not match the pin.");
      mkdirSync(join(this.#d.dataDir, "catalog"), { recursive: true });
      writeFileSync(`${file}.tmp`, gz);
      renameSync(`${file}.tmp`, file);
    }
    return new Map(parseBundle(gz, artifact.sha256).map((a) => [a.id, a]));
  }

  /** C373 T2: compile an own API description and show its tools and hold classes; nothing is saved. */
  async previewOwn(input: OwnApiInput): Promise<OwnApiPreview> {
    return buildOwnApi(input, await this.#reserved()).preview;
  }

  /**
   * C373 T2: save an own API (same name = replace) and re-make its tools when accounts of it are connected. The service then
   * shows in services_search; its accounts connect with catalog_account_connect.
   */
  async addOwn(input: OwnApiInput): Promise<OwnApiPreview> {
    const store = this.#d.ownApis ?? (() => {
      throw new CatalogError("own_api_unavailable", "Own APIs are not available here.");
    })();
    const { app, row, preview } = buildOwnApi(input, await this.#reserved());
    if (!store.exists(app.id) && store.count() >= OWN_APIS_MAX) throw new CatalogError("own_api_limit", `At most ${OWN_APIS_MAX} own APIs.`);
    store.put(row);
    this.#apps = null;
    this.#compiled.delete(app.id);
    if (this.#d.accounts.list({ service: app.id, status: "connected" }).length > 0) await this.syncTools(app.id);
    return preview;
  }

  /** C373 T2: remove an own API. Refused while an account of it is connected (disconnect them first). */
  async removeOwn(service: string): Promise<void> {
    const store = this.#d.ownApis;
    if (!store?.exists(service)) throw new CatalogError("catalog_app_unknown", `Unknown own API ${service}.`);
    if (this.#d.accounts.list({ service, status: "connected" }).length > 0) throw new CatalogError("own_api_in_use", "Disconnect the accounts of this API first.");
    store.remove(service);
    this.#apps = null;
    this.#compiled.delete(service);
    this.#d.tools.removeService("catalog", service);
  }

  async #reserved(): Promise<Set<string>> {
    return new Set((await this.#catalogApps().catch(() => new Map<string, CatalogApp>())).keys());
  }

  async #compiledFor(app: CatalogApp) {
    let c = this.#compiled.get(app.id);
    if (!c) {
      const { basePath, operations } = compile(app.spec, app.labels);
      const prefix = (app.basePathOverride ?? basePath).replace(/\/+$/u, "");
      c = { basePath: prefix && !prefix.startsWith("/") ? `/${prefix}` : prefix, byName: new Map(operations.map((op) => [catalogToolName(app.id, op.operationId), op])) };
      this.#compiled.set(app.id, c);
    }
    return c;
  }

  async listApps(): Promise<{ service: string; name: string; description: string; category: string; version: string; fields: string[]; baseUrlExample: string; credentialHint?: string; own?: true }[]> {
    return [...(await this.apps()).values()].map((a) => ({
      ...(a.id.startsWith("api_") && this.#d.ownApis?.exists(a.id) ? { own: true as const } : {}),
      service: a.id,
      name: a.displayName,
      description: a.description,
      category: a.category,
      version: a.version,
      fields: credentialFields(a.auth),
      baseUrlExample: a.baseUrlExample,
      ...(a.credentialHint ? { credentialHint: a.credentialHint } : {}),
    }));
  }

  /** API-key popup: create a connected account with base URL + sealed credentials, then load its tools. */
  async connect(input: { service: string; label: string; baseUrl: string; credentials: Record<string, string>; kind: "as_me" | "as_itself"; ownerAgent?: string | null }): Promise<Account> {
    const app = (await this.apps()).get(input.service) ?? (() => {
      throw new CatalogError("catalog_app_unknown", `Unknown catalog app ${input.service}.`);
    })();
    const base = await assertEndpointAllowed(input.baseUrl.trim(), { schemes: ["https:"], ...(this.#d.lookup ? { lookup: this.#d.lookup } : {}), ...(this.#d.allowOrigins ? { allowOrigins: this.#d.allowOrigins } : {}) });
    if (base.search || base.hash) throw new CatalogError("base_url_invalid", "The address must not contain a query or fragment.");
    const fields = credentialFields(app.auth);
    for (const field of fields) if (!input.credentials[field]?.trim()) throw new CatalogError("credentials_missing", `Enter the ${field}.`);
    const account = this.#d.accounts.create({
      service: app.id,
      source: "catalog",
      kind: input.kind,
      label: input.label,
      ownerAgent: input.ownerAgent ?? null,
      externalRef: base.toString().replace(/\/+$/u, ""),
      status: "connected",
    });
    await this.#d.secrets.put(`account:${account.id}`, JSON.stringify(Object.fromEntries(fields.map((f) => [f, String(input.credentials[f]).trim()]))));
    if (this.#d.tools.countFor(app.id) === 0) await this.syncTools(app.id);
    return account;
  }

  async syncTools(service: string): Promise<number> {
    const app = (await this.apps()).get(service);
    if (!app) throw new CatalogError("catalog_app_unknown", `Unknown catalog app ${service}.`);
    const compiled = await this.#compiledFor(app);
    return this.#d.tools.replaceService(
      "catalog",
      service,
      [...compiled.byName.entries()].map(([name, op]) => ({
        name,
        upstream: op.operationId,
        title: op.summary.slice(0, 200),
        description: `${op.method.toUpperCase()} ${op.path}: ${op.summary}${draftHint(app.id, name, op)}`,
        inputSchema: entrySchema(op.inputSchema),
        crud: op.crud,
        effect: op.effect,
        ...(op.holdFamily ? { holdFamily: op.holdFamily } : {}),
        ...(op.sendRecipients ? { sendRecipients: op.sendRecipients } : {}),
        httpMethod: op.method,
        httpPath: op.path,
      })),
    );
  }

  async execute(account: Account, tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (account.source !== "catalog" || account.status !== "connected" || !account.externalRef) throw new CatalogError("account_not_connected", "This account is not connected.");
    const app = (await this.apps()).get(account.service);
    if (!app) throw new CatalogError("catalog_app_unknown", `Unknown catalog app ${account.service}.`);
    const compiled = await this.#compiledFor(app);
    const op = compiled.byName.get(tool) ?? (() => {
      throw new CatalogError("tool_unknown", `Unknown tool ${tool}.`);
    })();
    const stored = await this.#d.secrets.get(`account:${account.id}`);
    const credentials = (stored ? JSON.parse(stored) : {}) as Record<string, string>;
    const result = await callOperation({
      baseUrl: account.externalRef,
      basePath: compiled.basePath,
      op,
      args,
      auth: app.auth,
      credentials,
      ...(this.#d.fetchImpl ? { fetchImpl: this.#d.fetchImpl } : {}),
      ...(this.#d.lookup ? { lookup: this.#d.lookup } : {}),
      ...(this.#d.allowOrigins ? { allowOrigins: this.#d.allowOrigins } : {}),
    });
    return result.data;
  }

  /** C368: the upstream operation behind a catalog tool (for the owner's hold details). Null when the app or tool is unknown. */
  async operationOf(service: string, tool: string): Promise<{ operationId: string; method: string; path: string } | null> {
    const app = (await this.apps()).get(service);
    if (!app) return null;
    const op = (await this.#compiledFor(app)).byName.get(tool);
    return op ? { operationId: op.operationId, method: op.method, path: op.path } : null;
  }

  /** Connection test: call the app's `healthOperation` with the account's credentials (read-only operations only). */
  async test(account: Account): Promise<{ ok: boolean; operation: string | null; detail: string }> {
    const app = (await this.apps()).get(account.service);
    if (!app) throw new CatalogError("catalog_app_unknown", `Unknown catalog app ${account.service}.`);
    if (!app.healthOperation) return { ok: false, operation: null, detail: "This app has no test operation." };
    const compiled = await this.#compiledFor(app);
    const name = catalogToolName(app.id, app.healthOperation);
    const op = compiled.byName.get(name);
    if (op?.effect !== "read") return { ok: false, operation: app.healthOperation, detail: "The test operation is not a read operation." };
    try {
      await this.execute(account, name, {});
      return { ok: true, operation: app.healthOperation, detail: "The app answered." };
    } catch (error) {
      return { ok: false, operation: app.healthOperation, detail: error instanceof Error ? error.message.slice(0, 300) : "The test failed." };
    }
  }

  async disconnect(account: Account): Promise<Account> {
    await this.#d.secrets.delete(`account:${account.id}`);
    const revoked = this.#d.accounts.update(account.id, { status: "revoked", detail: "Disconnected by the owner." });
    if (this.#d.accounts.list({ service: account.service, status: "connected" }).length === 0) this.#d.tools.removeService("catalog", account.service);
    return revoked;
  }
}

/** RFC 7396 JSON merge patch (v1 openapi-adapter.ts:919-929): objects merge, `null` deletes, anything else replaces. */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const base: Record<string, unknown> = target && typeof target === "object" && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (key === "__proto__") continue;
    if (value === null) delete base[key];
    else base[key] = applyMergePatch(base[key], value);
  }
  return base;
}

/**
 * C368: tell the agent about the draft form of Postiz create post (a plain write: no owner approval, no second approval in Postiz).
 * Only that one operation; the name is the registry name plus the variant suffix.
 */
function draftHint(app: string, name: string, op: { method: string; path: string }): string {
  if (!isPostizCreatePost({ source: "catalog", service: app, httpMethod: op.method, httpPath: op.path })) return "";
  return ` To only SAVE A DRAFT (not published), call ${name}${DRAFT_SUFFIX} with body.type "draft" and new posts only (no group, no id): it runs without owner approval. type "schedule" and "now" need the owner's approval.`;
}

/** `cb_<app>_<operation>` (≤ 48 chars, toolName hashes longer ones). */
export function catalogToolName(app: string, operationId: string): string {
  return toolName(`cb_${app}_${operationId}`);
}
