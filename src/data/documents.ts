/**
 * The `documents` dataset of the data_* op family (C373 second brain; contract `documents/1`, DRAFT, vendored byte copy in
 * `src/contracts/documents.1.schema.json`, see `test/contracts/PROVENANCE.md`). One row = one text document. Producers:
 *   - MCP accounts (this module): MCP `resources/list` (paged with the server's cursor) and `resources/read`. Text resources
 *     only; a blob or a non-text mime type is skipped and counted. NEVER a tool call: the session object has no such method.
 *   - database accounts (`table-documents.ts`): one CSV document per page of rows of one `schema.table`.
 *
 * Every page is validated against the vendored schema before it leaves (like `messages`): a mismatch is a producer bug and
 * answers `data_contract_violation` (500), never a page that does not conform. A row that cannot be built or does not
 * conform is quarantined (skipped, counted, logged without its content).
 *
 * Cursors are opaque, name their account and the collection filter (`d1:<account>:<state>`), and are refused on another
 * account or another collection. A pull is a forward scan of the current source state: `exhausted` with `nextCursor: null`
 * ends it; to see changes, a consumer scans again from the start and keeps the row with the newest `rev` per
 * (account, collection, id).
 *
 * Bounds (QA-CONNECT35-2/-10): every pull reads at most DOC_PULL_MAX_READS resources and stops at the time budget, also when
 * no row was collected (a filtered-out read counts); a scan walks at most SCAN_MAX_LIST_PAGES list pages.
 *
 * Deletions (QA-CONNECT35-13, kept simple): a scan WITHOUT `collection` and WITHOUT `until` that reaches the end of the
 * source list marks every document it listed as seen (`connect_doc_versions.scan_at`). It then delivers a row with
 * `deleted: true` (empty text, empty title, a NEW rev, `updatedAt` at or after the last live row) once for each document
 * that Connect delivered before and that this scan did not see; an MCP document is read once more first and stays when that
 * read works (a list that moved between two pulls must not delete). A scan that was cut (list cap, loop in the server's
 * cursors) or that is filtered deletes nothing. The record stays as a tombstone for 30 days (a document that comes back takes
 * a new rev), then it is dropped.
 */
import { createHash } from "node:crypto";
import { normalizeHandle, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { JsonSchemaObject } from "@opt2-tealbrick/spec/manifest";
import type { Db, Json, Logger } from "@opt2-tealbrick/spec/sdk";
import documentsSchema from "../contracts/documents.1.schema.json" with { type: "json" };
import { McpError, type McpResource, type McpResourceContent } from "../sources/mcp/client.ts";
import type { McpResourceSession } from "../sources/mcp/source.ts";
import { DataError, RetryLater } from "./messages.ts";

export const DOCUMENTS_DATASET = "documents";
export const DOCUMENTS_CONTRACT = "documents/1";
export const DOC_PAGE_MAX_ROWS = 50;
export const DOC_PAGE_DEFAULT_ROWS = 20;
/** S-7: one page is at most 2 MiB serialized. The row budget leaves room for the envelope. */
export const DOC_PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const DOC_ROW_BUDGET_BYTES = DOC_PAGE_MAX_BYTES - 8 * 1024;
/** documents/1 `text` maxLength (characters, as JSON Schema counts them) */
export const DOC_TEXT_MAX = 262_144;
/** A pull stops reading new resources after this long and answers what it has (the cursor continues). */
export const DOC_PULL_TIME_BUDGET_MS = 20_000;
/** At most this many `resources/list` pages are walked in one pull (a server that pages one entry at a time still ends). */
const LIST_PAGES_PER_PULL = 20;
/** QA-CONNECT35-2: at most this many `resources/read` calls in one pull, whatever the filters keep or drop. */
export const DOC_PULL_MAX_READS = 100;
/** QA-CONNECT35-10: a scan (all pulls of one cursor chain) walks at most this many list pages; then it ends, `partial`. */
export const SCAN_MAX_LIST_PAGES = 1000;
/** data_catalog stops walking the list after this long (`partial`). */
const CATALOG_TIME_BUDGET_MS = 30_000;
/** A server list cursor longer than this is refused (`source_cursor_too_long`); a shorter one is stored if the cursor would not fit. */
const SERVER_CURSOR_MAX = 8192;
const TOMBSTONE_KEEP_MS = 30 * 24 * 3600 * 1000;
const STASH_KEEP = 500;
const STASH_TTL_MS = 7 * 24 * 3600 * 1000;
const STASH_VALUE_MAX = 65_536;
/** data_catalog walks at most this many resources (the counts say `approx`). */
const CATALOG_MAX_RESOURCES = 5000;
const CATALOG_MAX_COLLECTIONS = 200;
const CURSOR_MAX = 512;

export type DocMime = "text/plain" | "text/markdown" | "text/csv";
/** What a source may send: the contract's types plus HTML, which the producer converts to Markdown (documents/1 has no text/html). */
export type SourceMime = DocMime | "text/html";
export type DocKind = "document" | "chat_transcript" | "table" | "report" | "record";
const KINDS: readonly DocKind[] = ["document", "chat_transcript", "table", "report", "record"];

export interface DocumentRow {
  id: string;
  collection: string;
  title: string;
  path?: string;
  url?: string;
  mime: DocMime;
  updatedAt: string;
  rev: string;
  deleted?: boolean;
  /** canonical `normalizeHandle` form when the source value maps to one, else the raw value with `raw: true` */
  author?: { handle: string; raw?: true; display?: string };
  kind?: DocKind;
  text: string;
  untrusted: true;
  truncated?: boolean;
}

export interface DocumentsPage {
  rows: DocumentRow[];
  nextCursor: string | null;
  exhausted: boolean;
  retryAfterS?: number;
  /** extra member (the contract allows them): rows skipped because they did not conform to documents/1 */
  quarantined?: number;
  /** extra member: source entries that are not text (blobs, binary mime types) or that could not be read; never in a row */
  skipped?: number;
  /** extra member: tables (collections) that failed or timed out in this pull and were skipped (names only, at most 20) */
  failedCollections?: string[];
  /** extra member: the scan ended at a safety cap; the source may have more */
  partial?: true;
}

export interface DocumentsPullInput {
  cursor: string | null;
  /** only this collection (as `data_catalog` lists it), or null for all */
  collection: string | null;
  /** inclusive lower bound on `updatedAt`, epoch ms */
  since: number | null;
  /** exclusive upper bound on `updatedAt`, epoch ms */
  until: number | null;
  limit: number;
}

export interface DocumentsCatalog {
  dataset: string;
  title: string;
  kind: "documents";
  delivery: "pull";
  contract: string;
  approxRows: number;
  history: false;
  /** `droppedColumns` (database accounts): secret-looking columns that table pages never contain */
  collections: { id: string; name: string; approxRows: number; droppedColumns?: string[] }[];
  /** source entries that are not text and are never pulled */
  skipped?: number;
  /** true when the catalog stopped counting at its cap */
  partial?: boolean;
}

// ── small helpers ──

const CONTROL = /[\p{Cc}\p{Cf}]/gu;
const HAS_CONTROL = /[\p{Cc}\p{Cf}]/u;
const clipChars = (value: string, max: number): string => (value.length <= max ? value : Array.from(value).slice(0, max).join(""));
export const cleanLine = (value: string, max: number): string => clipChars(value.replace(CONTROL, " ").replace(/\s+/gu, " ").trim(), max);
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A value over `max` characters becomes a stable hash (an id must stay stable and unique). */
export function fitId(value: string, max: number): string {
  return Array.from(value).length <= max ? value : `h:${sha256(value)}`;
}

/** The contract's `updatedAt`: `YYYY-MM-DDTHH:MM:SS(.mmm)Z`, or null for a value that is not a real time. */
export function isoTime(value: unknown): string | null {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return d.getUTCFullYear() >= 1970 && d.getUTCFullYear() <= 9999 ? d.toISOString() : null;
}

/** Text cut to the contract cap, in characters. */
export function capText(text: string): { text: string; truncated: boolean } {
  if (text.length <= DOC_TEXT_MAX) return { text, truncated: false };
  const chars = Array.from(text);
  return chars.length <= DOC_TEXT_MAX ? { text, truncated: false } : { text: chars.slice(0, DOC_TEXT_MAX).join(""), truncated: true };
}

/**
 * The `rev` of a document and when Connect first saw that version (`connect_doc_versions`, migrations 0020 and 0021).
 * `contentKey` is the sha256 of the delivered text (or the server's etag). The same key keeps `rev` and `seenAt`; a different
 * key (any change, also a change back to an older text) takes the next version: a NEW `rev` (`v<version>-<sha256 of the
 * key>`) and `seenAt` = now. `seenAt` is the row's `updatedAt` when the source gives no time.
 *
 * `planVersion` only computes; `commitVersion` writes. A caller commits only a row it delivers (QA-CONNECT35-2: a document
 * outside the window, or one the page had no room for, leaves no record).
 */
export interface VersionPlan {
  rev: string;
  seenAt: number;
  version: number;
  contentKey: string;
}
const revOf = (version: number, contentKey: string): string => `v${version}-${sha256(contentKey)}`;

export function planVersion(db: Db, account: string, docId: string, contentKey: string, now = Date.now()): VersionPlan {
  const row = db.prepare("SELECT content_key, version, seen_at, deleted FROM connect_doc_versions WHERE account_id = ? AND doc_id = ?").get(account, docId);
  if (row && Number(row.deleted) === 0 && String(row.content_key) === contentKey) {
    const version = Number(row.version);
    return { rev: revOf(version, contentKey), seenAt: Number(row.seen_at), version, contentKey };
  }
  const version = row ? Number(row.version) + 1 : 1;
  return { rev: revOf(version, contentKey), seenAt: now, version, contentKey };
}

/** Writes the plan of a delivered row. `scan` = the start time of the scan that delivered it (0 = no scan). */
export function commitVersion(db: Db, account: string, docId: string, plan: VersionPlan, meta: { collection: string; updatedAt: number; scan: number | null }): void {
  db.prepare(
    `INSERT INTO connect_doc_versions (account_id, doc_id, content_key, version, seen_at, collection, updated_at, scan_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT (account_id, doc_id) DO UPDATE SET content_key = excluded.content_key, version = excluded.version, seen_at = excluded.seen_at,
       collection = excluded.collection, updated_at = excluded.updated_at, deleted = 0,
       scan_at = MAX(COALESCE(connect_doc_versions.scan_at, 0), COALESCE(excluded.scan_at, 0))`,
  ).run(account, docId, plan.contentKey, plan.version, plan.seenAt, meta.collection, meta.updatedAt, meta.scan ?? 0);
}

/** The id (a start time, ms) of a new scan: later than every scan of this account so far, so two scans never share one. */
export function newScan(db: Db, account: string, now: number): number {
  const row = db.prepare("SELECT MAX(scan_at) AS last FROM connect_doc_versions WHERE account_id = ?").get(account);
  return Math.max(now, Number(row?.last ?? 0) + 1);
}

/** A listed document the scan `scan` has seen (a record exists only for a document delivered before). */
export function markSeen(db: Db, account: string, docId: string, scan: number): void {
  db.prepare("UPDATE connect_doc_versions SET scan_at = MAX(COALESCE(scan_at, 0), ?) WHERE account_id = ? AND doc_id = ?").run(scan, account, docId);
}

/** Every record of one collection counts as seen (a table that failed in this scan is not gone). */
export function markCollectionSeen(db: Db, account: string, collection: string, scan: number): void {
  db.prepare("UPDATE connect_doc_versions SET scan_at = MAX(COALESCE(scan_at, 0), ?) WHERE account_id = ? AND collection = ?").run(scan, account, collection);
}

export type Presence = "present" | "gone" | "unknown";

export interface ReapInput {
  db: Db;
  account: string;
  /** start time of the scan that reached the end of the source */
  scan: number;
  /** records already looked at and kept (not deleted) in this phase: skipped by the next query */
  offset: number;
  /** how many deletion rows may still be added */
  capacity: number;
  now: () => number;
  window: Pick<DocumentsPullInput, "since" | "until">;
  /** collection of a record that has none (written before migration 0021) */
  fallbackCollection: string;
  /** MCP: asks the source once more. Table pages need no probe: the scan itself is the proof. */
  probe?: (docId: string) => Promise<Presence>;
  /** false = stop (the pull has no read budget left) */
  canProbe?: () => boolean;
}

/**
 * The deletion rows of a finished full scan: records delivered before that scan `scan` did not see. Each gets a tombstone
 * (version + 1, so a new rev) and a `deleted: true` row. `done` is true when no candidate is left; else continue with
 * `offset`. A record outside the window, or one the probe could not decide, stays a candidate for the next scan.
 */
export async function reapDeleted(o: ReapInput): Promise<{ rows: DocumentRow[]; offset: number; done: boolean }> {
  const rows: DocumentRow[] = [];
  let kept = o.offset;
  const next = (n: number) =>
    o.db
      .prepare("SELECT doc_id, version, collection, seen_at, updated_at FROM connect_doc_versions WHERE account_id = ? AND deleted = 0 AND COALESCE(scan_at, 0) < ? ORDER BY doc_id LIMIT ? OFFSET ?")
      .all(o.account, o.scan, n, kept);
  for (;;) {
    if (rows.length >= o.capacity) return { rows, offset: kept, done: next(1).length === 0 };
    const batch = next(50);
    if (batch.length === 0) return { rows, offset: kept, done: true };
    for (const v of batch) {
      if (rows.length >= o.capacity || (o.probe && o.canProbe && !o.canProbe())) return { rows, offset: kept, done: false };
      const docId = String(v.doc_id);
      if (o.probe) {
        const seen = await o.probe(docId);
        if (seen === "present") {
          markSeen(o.db, o.account, docId, o.scan);
          continue;
        }
        if (seen === "unknown") {
          kept += 1;
          continue;
        }
      }
      const at = Math.max(o.now(), Number(v.seen_at), Number(v.updated_at ?? 0));
      const updatedAt = isoTime(at) ?? new Date(o.now()).toISOString();
      if (!inWindow(updatedAt, o.window)) {
        kept += 1;
        continue;
      }
      const version = Number(v.version) + 1;
      const contentKey = "deleted";
      o.db
        .prepare("UPDATE connect_doc_versions SET content_key = ?, version = ?, seen_at = ?, updated_at = ?, scan_at = ?, deleted = 1 WHERE account_id = ? AND doc_id = ?")
        .run(contentKey, version, at, at, o.scan, o.account, docId);
      rows.push({
        id: docId,
        collection: cleanLine(typeof v.collection === "string" && v.collection ? v.collection : o.fallbackCollection, 200) || "documents",
        title: "",
        mime: "text/plain",
        updatedAt,
        rev: revOf(version, contentKey),
        deleted: true,
        text: "",
        untrusted: true,
      });
    }
  }
}

/** Tombstones older than 30 days are dropped (a consumer that missed a deletion for that long reconciles by a full scan). */
export function pruneTombstones(db: Db, account: string, now: number): void {
  db.prepare("DELETE FROM connect_doc_versions WHERE account_id = ? AND deleted = 1 AND seen_at < ?").run(account, now - TOMBSTONE_KEEP_MS);
}

/**
 * documents/1 `url`: https only, no user or password, no query and no fragment (a query may hold a token or a signature).
 * Anything else: no url.
 */
export function safeUrl(value: string | null | undefined): string | null {
  if (!value || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const out = `https://${url.host}${url.pathname}`;
  return /^https:\/\/[^\s@/?#]+(\/[^\s?#]*)?$/u.test(out) && out.length <= 2048 ? out : null;
}

/** A uri as parts: the host without user info and port, the decoded path segments. Never the query, the fragment or the user info. */
interface UriParts {
  host: string;
  segments: string[];
  /** user info, a query or a fragment was present: the uri may carry a credential */
  risky: boolean;
}

function parseUri(uri: string): UriParts | null {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(uri)) return null;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  const hierarchical = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(uri);
  const risky = url.username !== "" || url.password !== "" || /[?#\s]/u.test(uri);
  const path = url.pathname;
  return {
    host: hierarchical ? safeDecode(url.hostname) : "",
    segments: hierarchical ? path.split("/").filter(Boolean).map(safeDecode) : path === "" ? [] : [safeDecode(path)],
    risky,
  };
}

/** An id with credentials in it (user info, a query, a fragment) is replaced by its hash: the id stays stable and carries no secret. */
export function safeId(value: string): string {
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/u.exec(value)?.[1] ?? "";
  return authority.includes("@") || /[?#\s]/u.test(value) || parseUri(value)?.risky === true ? `h:${sha256(value)}` : fitId(value, 512);
}

/** An account's records go with the account (a disconnect). */
export function clearSeen(db: Db, account: string): void {
  db.prepare("DELETE FROM connect_doc_versions WHERE account_id = ?").run(account);
  db.prepare("DELETE FROM connect_doc_cursors WHERE account_id = ?").run(account);
}

// ── cursors ──

export type CursorState = Record<string, Json>;

/** A state too long for a cursor is kept in `connect_doc_cursors` under a short token (QA-CONNECT35-9). */
function stash(db: Db, account: string, value: string, now: number): string {
  const token = createHash("sha256").update(value).digest("base64url").slice(0, 22);
  db.prepare("INSERT INTO connect_doc_cursors (account_id, token, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (account_id, token) DO UPDATE SET created_at = excluded.created_at").run(account, token, value, now);
  db.prepare("DELETE FROM connect_doc_cursors WHERE account_id = ? AND created_at < ?").run(account, now - STASH_TTL_MS);
  db.prepare("DELETE FROM connect_doc_cursors WHERE account_id = ? AND token NOT IN (SELECT token FROM connect_doc_cursors WHERE account_id = ? ORDER BY created_at DESC, token LIMIT ?)").run(account, account, STASH_KEEP);
  return token;
}

const collectionTag = (collection: string | null): string | null => (collection === null ? null : sha256(collection).slice(0, 16));

/**
 * `d1:<account>:<json state>`, base64url. The state carries a tag of the collection filter (`c`) the cursor was made for. A
 * state that would pass the 512 characters of a cursor is stored (`connect_doc_cursors`) and the cursor holds its token.
 */
export function encodeDocCursor(db: Db, account: string, collection: string | null, state: CursorState, now = Date.now()): string {
  const make = (s: CursorState) => Buffer.from(`d1:${account}:${JSON.stringify({ ...s, c: collectionTag(collection) })}`).toString("base64url");
  const direct = make(state);
  if (direct.length <= CURSOR_MAX) return direct;
  const json = JSON.stringify(state);
  if (json.length > STASH_VALUE_MAX) throw new DataError("source_cursor_too_long", "The source returned a page marker that is too long to continue from. Pull this collection again from the start.", 502);
  return make({ z: stash(db, account, json, now) });
}

export function decodeDocCursor(db: Db, cursor: string, account: string, collection: string | null): CursorState {
  const refuse = (): never => {
    throw new DataError("cursor_invalid", "cursor is not one data_pull returned for this account, dataset and collection.");
  };
  const parse = (text: string): CursorState => {
    let state: unknown;
    try {
      state = JSON.parse(text);
    } catch {
      return refuse();
    }
    return !state || typeof state !== "object" || Array.isArray(state) ? refuse() : (state as CursorState);
  };
  const decoded = cursor.length > CURSOR_MAX ? "" : Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^d1:([A-Za-z0-9_-]{1,64}):(\{.*\})$/su.exec(decoded);
  if (!match || match[1] !== account) return refuse();
  const s = parse(match[2] as string);
  if ((s.c ?? null) !== collectionTag(collection)) return refuse();
  if (typeof s.z === "string") {
    const row = db.prepare("SELECT value FROM connect_doc_cursors WHERE account_id = ? AND token = ?").get(account, s.z);
    if (!row) return refuse();
    return parse(String(row.value));
  }
  return s;
}

/** A non-negative whole number from a cursor state, else `fallback`. */
export const stateInt = (value: unknown, fallback = 0): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback);

// ── validation ──

const rowSchema = { $schema: documentsSchema.$schema, $defs: documentsSchema.$defs, $ref: "#/$defs/row" } as unknown as JsonSchemaObject;

/** null when the row conforms, else the failed rules (paths and rule names only, never values). */
export function rowProblems(row: DocumentRow): string | null {
  const checked = validateAgainstSchema(rowSchema, row as unknown as Json);
  return checked.ok ? null : checked.errors.slice(0, 3).map((e) => `${e.path || "/"} ${e.message}`).join("; ");
}

/** Check a page against the frozen contract and the size cap. Throws `data_contract_violation` (500). */
export function assertDocumentsConform(page: DocumentsPage, log?: Logger): void {
  const problems: string[] = [];
  const checked = validateAgainstSchema(documentsSchema as unknown as JsonSchemaObject, page as unknown as Json);
  if (!checked.ok) for (const e of checked.errors.slice(0, 5)) problems.push(`${e.path || "/"} ${e.message}`);
  const bytes = Buffer.byteLength(JSON.stringify(page));
  if (bytes > DOC_PAGE_MAX_BYTES) problems.push(`page is ${bytes} bytes; the cap is ${DOC_PAGE_MAX_BYTES}`);
  if (problems.length === 0) return;
  // Paths and rule names only: a page's values are untrusted document content and stay out of logs and errors.
  log?.error("data_pull: page does not conform to documents/1", { problems: problems.join("; ").slice(0, 600) });
  throw new DataError("data_contract_violation", "The page did not conform to the documents/1 contract and was not returned.", 500);
}

export function inWindow(updatedAt: string, input: Pick<DocumentsPullInput, "since" | "until">): boolean {
  const ms = Date.parse(updatedAt);
  return (input.since === null || ms >= input.since) && (input.until === null || ms < input.until);
}

export const clampLimit = (limit: number): number => Math.max(1, Math.min(DOC_PAGE_MAX_ROWS, Math.trunc(limit) || DOC_PAGE_DEFAULT_ROWS));

// ── MCP resources as documents ──

const metaString = (r: { annotations?: Record<string, unknown>; _meta?: Record<string, unknown> }, ...keys: string[]): string | null => {
  for (const source of [r._meta, r.annotations]) {
    for (const key of keys) {
      const v = source?.[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
};

/**
 * The collection of a resource: `_meta` / `annotations` `collection` (or `tealbrick/collection`) when the server sets it;
 * else, for a `scheme://host/folder/.../name` uri, the first folder of the path; else the host
 * (`slack://general/2026-10-27` → `general`); else the server name. Built from the PARSED uri: the host without user info
 * and port and the path segments, never the user info, the query or the fragment (QA-CONNECT35-3).
 */
export function collectionOf(resource: Pick<McpResource, "uri" | "annotations" | "_meta">, serverName: string): string {
  const named = metaString(resource, "collection", "tealbrick/collection");
  const pick = (v: string | null | undefined): string | null => {
    const c = v ? cleanLine(v, 200) : "";
    return c || null;
  };
  if (named) return pick(named) ?? cleanLine(serverName, 200);
  const parts = parseUri(resource.uri);
  if (parts) {
    if (parts.segments.length >= 2) {
      const first = pick(parts.segments[0]);
      if (first) return first;
    }
    const host = pick(parts.host);
    if (host) return host;
  }
  return cleanLine(serverName, 200) || "documents";
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** text/* only (no mime: text/plain). Mapped onto the contract's types plus HTML; any other text type reads as text/plain. */
export function textMime(mime: string | undefined): SourceMime | null {
  if (mime === undefined || mime.trim() === "") return "text/plain";
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!base.startsWith("text/")) return null;
  return base === "text/markdown" || base === "text/csv" || base === "text/html" ? base : "text/plain";
}

/**
 * The title: the server's title or name; else the last path segment of the parsed uri; else the host. A uri with user info,
 * a query or a fragment and no title or name gets "Untitled" and a short hash, so nothing of it reaches a string member.
 */
function titleOf(r: McpResource): string {
  for (const v of [r.title, r.name]) {
    const t = v ? cleanLine(safeDecode(v), 300) : "";
    if (t) return t;
  }
  const parts = parseUri(r.uri);
  if (parts && !parts.risky) {
    const t = cleanLine(parts.segments.at(-1) ?? parts.host, 300);
    if (t) return t;
  }
  return `Untitled ${sha256(r.uri).slice(0, 8)}`;
}

// ── HTML to Markdown (documents/1 has no text/html) ──

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/giu, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

// `[^<>]*`: an attribute run stops at the next `<`, so an unclosed tag costs one scan to that `<` (linear overall)
const HTML_TOKEN = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^<>]*)>/gu;
const HIDDEN = new Set(["script", "style", "head", "noscript", "template", "svg"]);
/** raw-text elements: an unclosed one hides the rest of the page (as a browser reads it); the others only hide when they are closed */
const RAW_HIDDEN = new Set(["script", "style"]);
const BLOCK = new Set(["p", "div", "section", "article", "header", "footer", "main", "nav", "aside", "ul", "ol", "table", "blockquote", "figure", "form"]);

/**
 * A one-pass, tag-by-tag conversion (linear: no nested backtracking over the document): headings, paragraphs, lists, line
 * breaks, bold, italics, https links and table cells become Markdown; scripts, styles and every other tag are dropped;
 * entities are decoded. It reads text out of HTML; it is not a sanitizer (consumers treat the text as untrusted anyway).
 * Hidden elements (script, style, head, noscript, template, svg) are a stack of names (QA-CONNECT35-12): a self-closing tag
 * hides nothing, a closing tag ends its own element, and an element other than script and style that is never closed does
 * not hide the rest of the page; `<body>` ends an open `<head>`.
 */
export function htmlToMarkdown(html: string): string {
  const out: string[] = [];
  const links: (string | null)[] = [];
  const tokens = [...html.matchAll(HTML_TOKEN)];
  // reverse pass: which hidden opener has a closing tag after it
  const closed: boolean[] = new Array<boolean>(tokens.length).fill(false);
  const closes = new Map<string, number>();
  let bodyAfter = false;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const name = tokens[i]?.[2]?.toLowerCase();
    if (name === "body" && tokens[i]?.[1] !== "/") bodyAfter = true;
    if (!name || !HIDDEN.has(name)) continue;
    if (tokens[i]?.[1] === "/") closes.set(name, (closes.get(name) ?? 0) + 1);
    else if ((closes.get(name) ?? 0) > 0) {
      closes.set(name, (closes.get(name) ?? 0) - 1);
      closed[i] = true;
    } else if (name === "head" && bodyAfter) closed[i] = true; // a head without `</head>` ends at `<body>`
  }
  const hidden: string[] = [];
  let pre = 0;
  let last = 0;
  const text = (raw: string) => {
    if (hidden.length > 0 || raw === "") return;
    out.push(pre > 0 ? decodeEntities(raw) : decodeEntities(raw.replace(/\s+/gu, " ")));
  };
  for (const [index, m] of tokens.entries()) {
    text(html.slice(last, m.index));
    last = m.index + m[0].length;
    const name = m[2]?.toLowerCase();
    if (!name) continue; // a comment
    const closing = m[1] === "/";
    if (HIDDEN.has(name)) {
      if (closing) {
        const at = hidden.lastIndexOf(name);
        if (at >= 0) hidden.length = at;
      } else if (!/\/\s*$/u.test(m[3] ?? "") && (RAW_HIDDEN.has(name) || closed[index])) hidden.push(name);
      continue;
    }
    if (name === "body" && !closing) {
      const at = hidden.indexOf("head");
      if (at >= 0) hidden.length = at;
    }
    if (hidden.length > 0) continue;
    if (/^h[1-6]$/u.test(name)) out.push(closing ? "\n\n" : `\n\n${"#".repeat(Number(name[1]))} `);
    else if (BLOCK.has(name)) out.push("\n\n");
    else if (name === "pre") {
      pre = closing ? Math.max(0, pre - 1) : pre + 1;
      out.push("\n```\n");
    } else if (name === "br") out.push("\n");
    else if (name === "li" && !closing) out.push("\n- ");
    else if (name === "tr" && closing) out.push("\n");
    else if ((name === "td" || name === "th") && closing) out.push(" | ");
    else if (name === "strong" || name === "b") out.push("**");
    else if (name === "em" || name === "i") out.push("*");
    else if (name === "a") {
      if (closing) {
        const href = links.pop();
        if (href) out.push(`](${href})`);
      } else {
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/iu.exec(m[3] ?? "");
        const value = href ? decodeEntities(href[1] ?? href[2] ?? "").trim() : "";
        const keep = /^https:\/\/[^\s()]+$/u.test(value) ? value : null;
        links.push(keep);
        if (keep) out.push("[");
      }
    }
  }
  text(html.slice(last));
  let fenced = false;
  return out
    .join("")
    .split("\n")
    .map((line) => {
      if (line.trim() === "```") {
        fenced = !fenced;
        return "```";
      }
      // inside <pre> the spacing is the content; elsewhere it is an artefact of the tags
      return fenced ? line : line.replace(/[ \t]+$/u, "").replace(/^[ \t]+(?=\S)/u, "");
    })
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** `author`: canonical (`normalizeHandle`) when the source value maps to one, else the raw value marked `raw: true`. */
export function authorOf(value: string): DocumentRow["author"] | null {
  const raw = cleanLine(value, 256);
  if (!raw) return null;
  const canonical = normalizeHandle(raw);
  return canonical && canonical.length <= 256 ? { handle: canonical } : { handle: raw, raw: true };
}

/** The text a row carries: NUL removed (documents/1), HTML converted to Markdown. */
export function documentText(text: string, mime: SourceMime): { text: string; mime: DocMime } {
  const clean = text.replaceAll("\0", "");
  return mime === "text/html" ? { text: htmlToMarkdown(clean), mime: "text/markdown" } : { text: clean, mime };
}

/**
 * One documents/1 row from a listed resource and its read contents, and the `commit` that records its version. The row is
 * built without writing anything: a caller commits only a row it delivers (QA-CONNECT35-2).
 */
export function buildMcpRow(
  db: Db,
  account: string,
  serverName: string,
  r: McpResource,
  content: McpResourceContent & { text: string },
  sourceMime: SourceMime,
  now = Date.now(),
  scan: number | null = null,
): { row: DocumentRow; commit: () => void } {
  const collection = collectionOf(r, serverName);
  const id = safeId(r.uri);
  const title = titleOf(r);
  const { text, mime } = documentText(content.text, sourceMime);
  const etag = metaString(content, "etag") ?? metaString(r, "etag");
  const contentKey = etag && etag.length <= 1024 && !HAS_CONTROL.test(etag) ? `etag:${etag}` : `sha256:${sha256(text)}`;
  const plan = planVersion(db, account, id, contentKey, now);
  const updatedAt = isoTime(metaString(r, "lastModified")) ?? isoTime(plan.seenAt) ?? new Date(now).toISOString();
  const kindHint = metaString(r, "kind");
  const kind: DocKind = kindHint && (KINDS as readonly string[]).includes(kindHint) ? (kindHint as DocKind) : "document";
  const url = safeUrl(metaString(r, "url") ?? r.uri);
  const path = cleanLine(metaString(r, "path") ?? `${collection}/${title}`, 1024);
  const authorHint = metaString(r, "author");
  const author = authorHint ? authorOf(authorHint) : null;
  const body = capText(text);
  const row: DocumentRow = {
    id,
    collection,
    title,
    ...(path ? { path } : {}),
    ...(url ? { url } : {}),
    mime,
    updatedAt,
    rev: plan.rev,
    ...(author ? { author } : {}),
    kind,
    text: body.text,
    untrusted: true,
    ...(body.truncated ? { truncated: true } : {}),
  };
  return { row, commit: () => commitVersion(db, account, id, plan, { collection, updatedAt: Date.parse(updatedAt), scan }) };
}

export interface McpDocumentsDeps {
  db: Db;
  log?: Logger;
  /** the account label: the collection when the server gives neither a collection nor a name */
  fallbackName: string;
  now?: () => number;
}

/** MCP `resources/list` errors that mean "slow down": the page answers empty with the same cursor and `retryAfterS`. */
function retryAfter(error: unknown): RetryLater | null {
  const status = (error as { status?: unknown })?.status;
  return status === 429 || status === 503 ? new RetryLater(30) : null;
}

const codeOf = (error: unknown): string => (error instanceof McpError ? error.code : "unknown");

/**
 * QA-CONNECT35-8: the text of an MCP JSON-RPC error is the SERVER's. The data ops never forward it: a fixed message with the
 * code. Other errors of the MCP path have Connect's own fixed texts and pass.
 */
export function mcpDataFailure(error: unknown): unknown {
  if (!(error instanceof McpError)) return error;
  if (error.code !== "mcp_rpc_error" && error.code !== "mcp_tool_error") return error;
  return new McpError(error.code, "The MCP server could not answer the request.", error.status);
}

/** data_catalog: the collections of an MCP account with approximate counts. Names and counts only, never a text. */
export async function mcpDocumentsCatalog(session: McpResourceSession, fallbackName: string, now: () => number = Date.now): Promise<DocumentsCatalog> {
  const serverName = session.serverName ?? fallbackName;
  const counts = new Map<string, number>();
  let total = 0;
  let skipped = 0;
  let partial = false;
  let cursor: string | null = null;
  const seen = new Set<string>();
  const started = now();
  for (let page = 0; ; page += 1) {
    const listed = await session.listResources(cursor);
    for (const r of listed.resources) {
      if (total + skipped >= CATALOG_MAX_RESOURCES) {
        partial = true;
        break;
      }
      if (!textMime(r.mimeType)) {
        skipped += 1;
        continue;
      }
      total += 1;
      const c = collectionOf(r, serverName);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    if (partial || !listed.nextCursor || seen.has(listed.nextCursor)) break;
    // QA-CONNECT35-10: one overall bound (pages and time), not only a bound per request
    if (page + 1 >= CATALOG_MAX_RESOURCES / 50 || now() - started > CATALOG_TIME_BUDGET_MS) {
      partial = true;
      break;
    }
    seen.add(listed.nextCursor);
    cursor = listed.nextCursor;
  }
  const collections = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, CATALOG_MAX_COLLECTIONS)
    .map(([id, n]) => ({ id, name: id, approxRows: n }));
  return {
    dataset: DOCUMENTS_DATASET,
    title: "Documents",
    kind: "documents",
    delivery: "pull",
    contract: DOCUMENTS_CONTRACT,
    approxRows: total,
    history: false,
    collections,
    ...(skipped > 0 ? { skipped } : {}),
    ...(partial ? { partial: true } : {}),
  };
}

/** MCP spec: -32002 resource not found, -32602 invalid params (a uri that no longer exists). Only these mean "gone". */
const GONE_RPC = /^MCP error -(32002|32602):/u;

/**
 * One page of documents from an MCP account. The cursor state is the server's list cursor (`m`, null = the first list
 * page), the position in that list page (`o`), the list pages done in this scan (`p`) and the scan's start time (`s`).
 * The scan reads resources in list order, skips other collections, counts non-text entries and unreadable ones as `skipped`,
 * and stops at `limit` rows, at the byte budget, at DOC_PULL_MAX_READS reads or at the time budget (the last two also when
 * no row was collected). A read that fails is skipped: it never blocks the scan (QA-CONNECT35-1). After the end of the list
 * of a full scan, deletion rows follow (see the header; cursor state `rk` = records kept so far in that phase).
 */
export async function pullMcpDocuments(deps: McpDocumentsDeps, session: McpResourceSession, account: string, input: DocumentsPullInput): Promise<DocumentsPage> {
  const now = deps.now ?? Date.now;
  const limit = clampLimit(input.limit);
  const state = input.cursor === null ? {} : decodeDocCursor(deps.db, input.cursor, account, input.collection);
  let listCursor = typeof state.m === "string" ? state.m : null;
  let offset = stateInt(state.o);
  let listPages = stateInt(state.p);
  const scan: number | null = input.cursor === null ? newScan(deps.db, account, now()) : typeof state.s === "number" && Number.isSafeInteger(state.s) ? state.s : null;
  const reaping = typeof state.rk === "number";
  // deletions only from a full, unfiltered scan: no collection, no `until`
  const canReap = input.collection === null && input.until === null && scan !== null;
  const serverName = session.serverName ?? deps.fallbackName;
  const rows: DocumentRow[] = [];
  let used = 0;
  let skipped = 0;
  let quarantined = 0;
  let reads = 0;
  let handled = 0;
  let unreachable = 0;
  const started = now();
  const cursorAt = (extra: CursorState = {}) =>
    encodeDocCursor(deps.db, account, input.collection, reaping ? { s: scan, ...extra } : { m: listCursor, o: offset, p: listPages, ...(scan === null ? {} : { s: scan }), ...extra }, now());
  const finish = (page: DocumentsPage): DocumentsPage => {
    const out = { ...page, ...(quarantined > 0 ? { quarantined } : {}), ...(skipped > 0 ? { skipped } : {}) };
    assertDocumentsConform(out, deps.log);
    return out;
  };
  // at least one entry is handled per pull, so a cursor always moves; then the read and time budgets apply, rows or not
  const spent = () => handled > 0 && (reads >= DOC_PULL_MAX_READS || now() - started > DOC_PULL_TIME_BUDGET_MS);
  const later = (error: unknown) => retryAfter(error);

  let complete = false;
  let partial = false;
  if (!reaping) {
    const seenCursors = new Set<string>();
    let pages = 0;
    for (; ; pages += 1) {
      if (pages >= LIST_PAGES_PER_PULL || spent()) return finish({ rows, nextCursor: cursorAt(), exhausted: false });
      let listed: Awaited<ReturnType<McpResourceSession["listResources"]>>;
      try {
        listed = await session.listResources(listCursor);
      } catch (error) {
        const wait = later(error);
        if (!wait) throw error;
        return finish({ rows, nextCursor: rows.length > 0 ? cursorAt() : input.cursor, exhausted: false, retryAfterS: wait.retryAfterS });
      }
      for (; offset < listed.resources.length; offset += 1) {
        if (rows.length >= limit || spent()) return finish({ rows, nextCursor: cursorAt(), exhausted: false });
        handled += 1;
        const r = listed.resources[offset] as McpResource;
        // a full scan marks every listed document as seen, whatever happens to it below
        if (canReap) markSeen(deps.db, account, safeId(r.uri), scan as number);
        if (input.collection !== null && collectionOf(r, serverName) !== input.collection) continue;
        const listedMime = textMime(r.mimeType);
        if (!listedMime) {
          skipped += 1;
          continue;
        }
        // the list already says the document is outside the window: no read
        const listedAt = isoTime(metaString(r, "lastModified"));
        if (listedAt && !inWindow(listedAt, input)) continue;
        let contents: McpResourceContent[];
        reads += 1;
        try {
          contents = await session.readResource(r.uri);
          unreachable = 0;
        } catch (error) {
          const wait = later(error);
          if (wait) return finish({ rows, nextCursor: cursorAt(), exhausted: false, retryAfterS: wait.retryAfterS });
          const code = codeOf(error);
          if (code === "mcp_unauthorized") throw error;
          // QA-CONNECT35-1: one unreadable resource (not found, forbidden, too large, a 5xx) never blocks the scan; the code is logged, never the server's text
          skipped += 1;
          deps.log?.error("data_pull: a resource could not be read and was skipped", { account, code });
          unreachable = code === "mcp_unreachable" ? unreachable + 1 : 0;
          // a server that does not answer at all: stop here and try again later, do not walk the whole list
          if (unreachable >= 3) return finish({ rows, nextCursor: cursorAt({ o: offset + 1 }), exhausted: false, retryAfterS: 30 });
          continue;
        }
        const text = contents.find((c): c is McpResourceContent & { text: string } => typeof c.text === "string" && (c.uri === r.uri || contents.length === 1));
        const mime = text ? textMime(text.mimeType ?? r.mimeType) : null;
        if (!text || !mime) {
          skipped += 1;
          continue;
        }
        let built: ReturnType<typeof buildMcpRow> | null = null;
        try {
          built = buildMcpRow(deps.db, account, serverName, r, text, mime, now(), canReap ? scan : null);
          const why = rowProblems(built.row);
          if (why) {
            quarantined += 1;
            deps.log?.error("data_pull: a document does not conform to documents/1 and was skipped", { account, why: why.slice(0, 200) });
            built = null;
          }
        } catch (error) {
          quarantined += 1;
          deps.log?.error("data_pull: a document could not be built and was skipped", { account, why: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
        }
        if (!built || !inWindow(built.row.updatedAt, input)) continue;
        const size = Buffer.byteLength(JSON.stringify(built.row)) + 1;
        // the page is full: this resource is read again first on the next pull
        if (rows.length > 0 && used + size > DOC_ROW_BUDGET_BYTES) return finish({ rows, nextCursor: cursorAt(), exhausted: false });
        built.commit();
        rows.push(built.row);
        used += size;
      }
      const next = listed.nextCursor;
      if (!next) {
        complete = true;
        break;
      }
      // a server that returns a cursor it returned before, or that never ends: the scan stops here and deletes nothing
      if (next === listCursor || seenCursors.has(next) || listPages + 1 >= SCAN_MAX_LIST_PAGES) {
        partial = true;
        break;
      }
      if (next.length > SERVER_CURSOR_MAX) throw new DataError("source_cursor_too_long", "The source returned a page marker that is too long to continue from. Pull this collection again from the start.", 502);
      seenCursors.add(next);
      listCursor = next;
      offset = 0;
      listPages += 1;
    }
  }
  if (reaping || (complete && canReap)) {
    if (!canReap) return finish({ rows, nextCursor: null, exhausted: true });
    const probe = async (docId: string): Promise<Presence> => {
      // an id that is a hash had credentials in its uri: it cannot be read again, the list is the proof
      if (docId.startsWith("h:")) return "gone";
      reads += 1;
      try {
        return (await session.readResource(docId)).length > 0 ? "present" : "gone";
      } catch (error) {
        const wait = later(error);
        if (wait) throw wait;
        const code = codeOf(error);
        if (code === "mcp_unauthorized") throw error;
        if (code === "mcp_response_too_large") return "present";
        return code === "mcp_rpc_error" && GONE_RPC.test((error as Error).message) ? "gone" : "unknown";
      }
    };
    try {
      const reaped = await reapDeleted({
        db: deps.db,
        account,
        scan: scan as number,
        offset: reaping ? stateInt(state.rk) : 0,
        capacity: limit - rows.length,
        now,
        window: input,
        fallbackCollection: serverName,
        probe,
        canProbe: () => !spent(),
      });
      rows.push(...reaped.rows);
      if (!reaped.done) return finish({ rows, nextCursor: encodeDocCursor(deps.db, account, input.collection, { rk: reaped.offset, s: scan }, now()), exhausted: false });
      pruneTombstones(deps.db, account, now());
    } catch (error) {
      const wait = error instanceof RetryLater ? error : null;
      if (!wait) throw error;
      return finish({ rows, nextCursor: encodeDocCursor(deps.db, account, input.collection, { rk: reaping ? stateInt(state.rk) : 0, s: scan }, now()), exhausted: false, retryAfterS: wait.retryAfterS });
    }
  }
  return finish({ rows, nextCursor: null, exhausted: true, ...(partial ? { partial: true as const } : {}) });
}
