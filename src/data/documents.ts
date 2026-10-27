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
 */
import { createHash } from "node:crypto";
import { normalizeHandle, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { JsonSchemaObject } from "@opt2-tealbrick/spec/manifest";
import type { Db, Json, Logger } from "@opt2-tealbrick/spec/sdk";
import documentsSchema from "../contracts/documents.1.schema.json" with { type: "json" };
import type { McpResource, McpResourceContent } from "../sources/mcp/client.ts";
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
  /** extra member: source entries that are not text (blobs, binary mime types), never read into a row */
  skipped?: number;
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
 * The `rev` of a document and when Connect first saw that version (`connect_doc_versions`, migration 0020). `contentKey` is
 * the sha256 of the delivered text (or the server's etag). The same key keeps `rev` and `seenAt`; a different key (any
 * change, also a change back to an older text) takes the next version: a NEW `rev` (`v<version>-<sha256 of the key>`) and
 * `seenAt` = now. `seenAt` is the row's `updatedAt` when the source gives no time.
 */
export function docVersion(db: Db, account: string, docId: string, contentKey: string, now = Date.now()): { rev: string; seenAt: number } {
  const row = db.prepare("SELECT content_key, version, seen_at FROM connect_doc_versions WHERE account_id = ? AND doc_id = ?").get(account, docId);
  const revOf = (version: number) => `v${version}-${sha256(contentKey)}`;
  if (row && String(row.content_key) === contentKey) return { rev: revOf(Number(row.version)), seenAt: Number(row.seen_at) };
  const version = row ? Number(row.version) + 1 : 1;
  db.prepare(
    `INSERT INTO connect_doc_versions (account_id, doc_id, content_key, version, seen_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (account_id, doc_id) DO UPDATE SET content_key = excluded.content_key, version = excluded.version, seen_at = excluded.seen_at`,
  ).run(account, docId, contentKey, version, now);
  return { rev: revOf(version), seenAt: now };
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

/** An id with credentials in it (user info, a query) is replaced by its hash: the id stays stable and carries no secret. */
export function safeId(value: string): string {
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/u.exec(value)?.[1] ?? "";
  return authority.includes("@") || value.includes("?") || /\s/u.test(value) ? `h:${sha256(value)}` : fitId(value, 512);
}

export function clearSeen(db: Db, account: string): void {
  db.prepare("DELETE FROM connect_doc_versions WHERE account_id = ?").run(account);
}

// ── cursors ──

export type CursorState = Record<string, Json>;

/** `d1:<account>:<json state>`, base64url. The state carries the collection filter (`c`) the cursor was made for. */
export function encodeDocCursor(account: string, collection: string | null, state: CursorState): string {
  const cursor = Buffer.from(`d1:${account}:${JSON.stringify({ ...state, c: collection })}`).toString("base64url");
  if (cursor.length > CURSOR_MAX) throw new DataError("source_cursor_too_long", "The source returned a page marker that is too long to continue from. Pull this collection again from the start.", 502);
  return cursor;
}

export function decodeDocCursor(cursor: string, account: string, collection: string | null): CursorState {
  const refuse = (): never => {
    throw new DataError("cursor_invalid", "cursor is not one data_pull returned for this account, dataset and collection.");
  };
  const decoded = cursor.length > CURSOR_MAX ? "" : Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^d1:([A-Za-z0-9_-]{1,64}):(\{.*\})$/su.exec(decoded);
  if (!match || match[1] !== account) return refuse();
  let state: unknown;
  try {
    state = JSON.parse(match[2] as string);
  } catch {
    return refuse();
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) return refuse();
  const s = state as CursorState;
  if ((s.c ?? null) !== collection) return refuse();
  return s;
}

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
 * else, for a `scheme://authority/folder/.../name` uri, the first folder of the path; else the authority
 * (`slack://general/2026-10-27` → `general`); else the server name.
 */
export function collectionOf(resource: Pick<McpResource, "uri" | "annotations" | "_meta">, serverName: string): string {
  const named = metaString(resource, "collection", "tealbrick/collection");
  const pick = (v: string | null | undefined): string | null => {
    const c = v ? cleanLine(v, 200) : "";
    return c || null;
  };
  if (named) return pick(named) ?? cleanLine(serverName, 200);
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/u.exec(resource.uri);
  if (match) {
    const segments = (match[2] ?? "").split("/").filter(Boolean).map((s) => safeDecode(s));
    if (segments.length >= 2) {
      const first = pick(segments[0]);
      if (first) return first;
    }
    const authority = pick(safeDecode(match[1] ?? ""));
    if (authority) return authority;
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

function titleOf(r: McpResource): string {
  for (const v of [r.title, r.name, r.uri.split(/[/?#]/u).filter(Boolean).at(-1), r.uri]) {
    const t = v ? cleanLine(safeDecode(v), 300) : "";
    if (t) return t;
  }
  return "Untitled";
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
const BLOCK = new Set(["p", "div", "section", "article", "header", "footer", "main", "nav", "aside", "ul", "ol", "table", "blockquote", "figure", "form"]);

/**
 * A one-pass, tag-by-tag conversion (linear: no nested backtracking over the document): headings, paragraphs, lists, line
 * breaks, bold, italics, https links and table cells become Markdown; scripts, styles and every other tag are dropped;
 * entities are decoded. It reads text out of HTML; it is not a sanitizer (consumers treat the text as untrusted anyway).
 */
export function htmlToMarkdown(html: string): string {
  const out: string[] = [];
  const links: (string | null)[] = [];
  let hidden = 0;
  let pre = 0;
  let last = 0;
  const text = (raw: string) => {
    if (hidden > 0 || raw === "") return;
    out.push(pre > 0 ? decodeEntities(raw) : decodeEntities(raw.replace(/\s+/gu, " ")));
  };
  for (const m of html.matchAll(HTML_TOKEN)) {
    text(html.slice(last, m.index));
    last = m.index + m[0].length;
    const name = m[2]?.toLowerCase();
    if (!name) continue; // a comment
    const closing = m[1] === "/";
    if (HIDDEN.has(name)) {
      hidden = closing ? Math.max(0, hidden - 1) : hidden + 1;
      continue;
    }
    if (hidden > 0) continue;
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

/** One documents/1 row from a listed resource and its read contents. */
export function mcpRow(db: Db, account: string, serverName: string, r: McpResource, content: McpResourceContent & { text: string }, sourceMime: SourceMime, now = Date.now()): DocumentRow {
  const collection = collectionOf(r, serverName);
  const id = safeId(r.uri);
  const title = titleOf(r);
  const { text, mime } = documentText(content.text, sourceMime);
  const etag = metaString(content, "etag") ?? metaString(r, "etag");
  const contentKey = etag && etag.length <= 1024 && !HAS_CONTROL.test(etag) ? `etag:${etag}` : `sha256:${sha256(text)}`;
  const version = docVersion(db, account, id, contentKey, now);
  const rev = version.rev;
  const updatedAt = isoTime(metaString(r, "lastModified")) ?? isoTime(version.seenAt) ?? new Date(now).toISOString();
  const kindHint = metaString(r, "kind");
  const kind: DocKind = kindHint && (KINDS as readonly string[]).includes(kindHint) ? (kindHint as DocKind) : "document";
  const url = safeUrl(metaString(r, "url") ?? r.uri);
  const path = cleanLine(metaString(r, "path") ?? `${collection}/${title}`, 1024);
  const authorHint = metaString(r, "author");
  const author = authorHint ? authorOf(authorHint) : null;
  const body = capText(text);
  return {
    id,
    collection,
    title,
    ...(path ? { path } : {}),
    ...(url ? { url } : {}),
    mime,
    updatedAt,
    rev,
    ...(author ? { author } : {}),
    kind,
    text: body.text,
    untrusted: true,
    ...(body.truncated ? { truncated: true } : {}),
  };
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

/** data_catalog: the collections of an MCP account with approximate counts. Names and counts only, never a text. */
export async function mcpDocumentsCatalog(session: McpResourceSession, fallbackName: string): Promise<DocumentsCatalog> {
  const serverName = session.serverName ?? fallbackName;
  const counts = new Map<string, number>();
  let total = 0;
  let skipped = 0;
  let partial = false;
  let cursor: string | null = null;
  const seen = new Set<string>();
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
    if (page + 1 >= CATALOG_MAX_RESOURCES / 50) {
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

/**
 * One page of documents from an MCP account. The cursor state is the server's list cursor (`m`, null = the first list
 * page) and the position in that list page (`o`). The scan reads resources in list order, skips other collections, counts
 * non-text entries as `skipped`, and stops at `limit` rows, at the byte budget, or at the time budget.
 */
export async function pullMcpDocuments(deps: McpDocumentsDeps, session: McpResourceSession, account: string, input: DocumentsPullInput): Promise<DocumentsPage> {
  const now = deps.now ?? Date.now;
  const limit = clampLimit(input.limit);
  const state = input.cursor === null ? { m: null, o: 0 } : decodeDocCursor(input.cursor, account, input.collection);
  let listCursor = typeof state.m === "string" ? state.m : null;
  let offset = typeof state.o === "number" && Number.isInteger(state.o) && state.o >= 0 ? state.o : 0;
  const serverName = session.serverName ?? deps.fallbackName;
  const rows: DocumentRow[] = [];
  let used = 0;
  let skipped = 0;
  let quarantined = 0;
  const started = now();
  const cursorAt = (m: string | null, o: number) => encodeDocCursor(account, input.collection, { m, o });
  const finish = (page: DocumentsPage): DocumentsPage => {
    const out = { ...page, ...(quarantined > 0 ? { quarantined } : {}), ...(skipped > 0 ? { skipped } : {}) };
    assertDocumentsConform(out, deps.log);
    return out;
  };
  const seenCursors = new Set<string>();
  for (let pages = 0; pages < LIST_PAGES_PER_PULL; pages += 1) {
    let listed: Awaited<ReturnType<McpResourceSession["listResources"]>>;
    try {
      listed = await session.listResources(listCursor);
    } catch (error) {
      const later = retryAfter(error);
      if (!later) throw error;
      return finish({ rows, nextCursor: rows.length > 0 ? cursorAt(listCursor, offset) : input.cursor, exhausted: false, retryAfterS: later.retryAfterS });
    }
    for (; offset < listed.resources.length; offset += 1) {
      const r = listed.resources[offset] as McpResource;
      if (rows.length >= limit || (rows.length > 0 && now() - started > DOC_PULL_TIME_BUDGET_MS)) return finish({ rows, nextCursor: cursorAt(listCursor, offset), exhausted: false });
      if (input.collection !== null && collectionOf(r, serverName) !== input.collection) continue;
      const listedMime = textMime(r.mimeType);
      if (!listedMime) {
        skipped += 1;
        continue;
      }
      let contents: McpResourceContent[];
      try {
        contents = await session.readResource(r.uri);
      } catch (error) {
        const later = retryAfter(error);
        if (!later) throw error;
        return finish({ rows, nextCursor: cursorAt(listCursor, offset), exhausted: false, retryAfterS: later.retryAfterS });
      }
      const text = contents.find((c): c is McpResourceContent & { text: string } => typeof c.text === "string" && (c.uri === r.uri || contents.length === 1));
      const mime = text ? textMime(text.mimeType ?? r.mimeType) : null;
      if (!text || !mime) {
        skipped += 1;
        continue;
      }
      let row: DocumentRow | null = null;
      try {
        row = mcpRow(deps.db, account, serverName, r, text, mime, now());
        const why = rowProblems(row);
        if (why) {
          quarantined += 1;
          deps.log?.error("data_pull: a document does not conform to documents/1 and was skipped", { account, why: why.slice(0, 200) });
          row = null;
        }
      } catch (error) {
        quarantined += 1;
        deps.log?.error("data_pull: a document could not be built and was skipped", { account, why: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      }
      if (!row || !inWindow(row.updatedAt, input)) continue;
      const size = Buffer.byteLength(JSON.stringify(row)) + 1;
      // the page is full: this resource is read again first on the next pull
      if (rows.length > 0 && used + size > DOC_ROW_BUDGET_BYTES) return finish({ rows, nextCursor: cursorAt(listCursor, offset), exhausted: false });
      rows.push(row);
      used += size;
    }
    const next = listed.nextCursor;
    if (!next || next === listCursor || seenCursors.has(next)) return finish({ rows, nextCursor: null, exhausted: true });
    seenCursors.add(next);
    listCursor = next;
    offset = 0;
  }
  return finish({ rows, nextCursor: cursorAt(listCursor, offset), exhausted: false });
}
