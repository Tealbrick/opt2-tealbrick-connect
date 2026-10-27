/**
 * The `documents` dataset of a database account (C373): every table or view of the catalog is a collection
 * (`<schema>.<table>`); one document is one page of up to ROWS_PER_DOCUMENT rows as CSV with a header line (kind `table`,
 * mime `text/csv`, id `<schema>.<table>:<page>`, page 1 = the first rows).
 *
 * How rows are read (the only place Connect reads table data):
 *  - one READ ONLY transaction (REPEATABLE READ) with a statement time limit, on a session that is read-only already
 *    (`pg-driver.ts`), after the role check (a superuser or replication role is refused, as at connect time);
 *  - only tables and views of the CURRENT catalog; identifiers come from that catalog, never from the caller, and are quoted;
 *  - every column cast to text, except columns whose name looks like a secret (password, secret, token, API key, ...):
 *    those are never selected, and data_catalog lists them per collection (`droppedColumns`);
 *  - ordered by the primary key, else `ctid` for a table, else by every selected column for a view;
 *  - at most `DB_PULL_ROW_CAP` rows per pull, at most `limit` documents, at most 2 MiB per page.
 * Paging is LIMIT/OFFSET per table (simple and stable while the table does not change; a changed table moves rows between
 * pages and the consumer sees new `rev`s). The cursor state is the table and the page number.
 */
import { createHash } from "node:crypto";
import type { Db, Logger } from "@opt2-tealbrick/spec/sdk";

import type { DbSession, DbTable } from "./database.ts";
import {
  assertDocumentsConform,
  clampLimit,
  DOC_PULL_TIME_BUDGET_MS,
  DOC_ROW_BUDGET_BYTES,
  DOC_TEXT_MAX,
  DOCUMENTS_CONTRACT,
  DOCUMENTS_DATASET,
  type DocumentRow,
  type DocumentsCatalog,
  type DocumentsPage,
  type DocumentsPullInput,
  decodeDocCursor,
  docVersion,
  encodeDocCursor,
  inWindow,
  isoTime,
  rowProblems,
} from "./documents.ts";
import { DataError } from "./messages.ts";

export const ROWS_PER_DOCUMENT = 200;
/** The most table rows one data_pull reads, whatever `limit` says. */
export const DB_PULL_ROW_CAP = 2000;
const CELL_MAX = 4096;
const STATEMENT_TIMEOUT_MS = 10_000;

/** The fixed statements of a pull (besides the generated SELECT of one page). No caller input is put into them. */
export const POSTGRES_PULL_SQL = {
  begin: "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
  timeout: `SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`,
  primaryKey:
    "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey) " +
    "WHERE i.indrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass AND i.indisprimary " +
    "ORDER BY array_position(i.indkey::int2[], a.attnum)",
  rollback: "ROLLBACK",
} as const;

/**
 * documents/1 (spec QA): a column whose name looks like a secret is dropped from table pages. The name is compared with its
 * separators removed and in lower case, so `api_key`, `apiKey` and `API-KEY` all match.
 */
const SECRET_COLUMN = /(password|passwd|passphrase|pwd|secret|token|apikey|privatekey|accesskey|secretkey|signingkey|clientkey|credential|sessionid|sessionkey|cookie|salt|otpseed|totp|mfaseed|recoverycode)/u;
export const isSecretColumn = (name: string): boolean => SECRET_COLUMN.test(name.toLowerCase().replace(/[^a-z0-9]/gu, ""));
/** The table with its secret-looking columns removed (what a page selects). */
export const withoutSecrets = (table: DbTable): DbTable => ({ ...table, columns: table.columns.filter((c) => !isSecretColumn(c.name)) });

/** A Postgres identifier, quoted. Names come from the database's own catalog. */
export const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** The SELECT of one page: every column as text, a stable order, LIMIT $1 OFFSET $2. */
export function pageSql(table: DbTable, keys: readonly string[]): string {
  const [schema = "", name = ""] = table.dataset.split(".");
  const cols = table.columns.map((c) => `src.${quoteIdent(c.name)}::text AS ${quoteIdent(c.name)}`).join(", ");
  const order =
    keys.length > 0
      ? keys.map((k) => `src.${quoteIdent(k)}`).join(", ")
      : table.relation === "table"
        ? "src.ctid"
        : table.columns.map((_c, i) => String(i + 1)).join(", ");
  return `SELECT ${cols} FROM ${quoteIdent(schema)}.${quoteIdent(name)} AS src ORDER BY ${order} LIMIT $1 OFFSET $2`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  // documents/1: no NUL in text (Postgres text cannot hold one; a cast of another type could)
  let s = String(value).replaceAll("\0", "");
  if (s.length > CELL_MAX) s = `${Array.from(s).slice(0, CELL_MAX).join("")}…`;
  return /[",\r\n]/u.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** CSV with a header line; cut at a whole line when it would pass the contract's text cap. */
export function toCsv(columns: readonly string[], rows: readonly Record<string, unknown>[]): { text: string; truncated: boolean; rows: number } {
  const lines = [columns.map(csvCell).join(",")];
  let length = lines[0]?.length ?? 0;
  let kept = 0;
  for (const r of rows) {
    const line = columns.map((c) => csvCell(r[c])).join(",");
    // +1 for the line break; the cap is in characters and a UTF-16 length is never smaller than the character count
    if (length + 1 + line.length > DOC_TEXT_MAX) return { text: lines.join("\n"), truncated: true, rows: kept };
    lines.push(line);
    length += 1 + line.length;
    kept += 1;
  }
  return { text: lines.join("\n"), truncated: false, rows: kept };
}

/** data_catalog: every table and view as a collection; the count is the approximate number of documents (pages). */
export function tableDocumentsCatalog(tables: readonly DbTable[]): DocumentsCatalog {
  const sorted = [...tables].sort((a, b) => (a.dataset < b.dataset ? -1 : a.dataset > b.dataset ? 1 : 0));
  const collections = sorted.map((t) => {
    const dropped = t.columns.filter((c) => isSecretColumn(c.name)).map((c) => c.name);
    return { id: t.dataset, name: t.dataset, approxRows: t.approxRows === undefined ? 0 : Math.ceil(t.approxRows / ROWS_PER_DOCUMENT), ...(dropped.length > 0 ? { droppedColumns: dropped } : {}) };
  });
  return {
    dataset: DOCUMENTS_DATASET,
    title: "Documents",
    kind: "documents",
    delivery: "pull",
    contract: DOCUMENTS_CONTRACT,
    approxRows: collections.reduce((n, c) => n + c.approxRows, 0),
    history: false,
    collections: collections.slice(0, 2000),
  };
}

export interface TableDocumentsDeps {
  db: Db;
  log?: Logger;
  now?: () => number;
}

/** Checks the cursor before any database contact (a cursor of another account or collection is refused at once). */
export function tableCursorState(account: string, input: Pick<DocumentsPullInput, "cursor" | "collection">): { t: string | null; n: number } {
  if (input.cursor === null) return { t: null, n: 0 };
  const s = decodeDocCursor(input.cursor, account, input.collection);
  const t = typeof s.t === "string" ? s.t : null;
  const n = typeof s.n === "number" && Number.isInteger(s.n) && s.n >= 0 ? s.n : 0;
  return { t, n };
}

/**
 * One page of table documents. `tables` is the catalog read in the same session. Runs inside one READ ONLY transaction;
 * the transaction is always rolled back (nothing to commit).
 */
export async function pullTableDocuments(deps: TableDocumentsDeps, session: DbSession, account: string, tables: readonly DbTable[], input: DocumentsPullInput): Promise<DocumentsPage> {
  const now = deps.now ?? Date.now;
  const limit = clampLimit(input.limit);
  const sorted = [...tables].sort((a, b) => (a.dataset < b.dataset ? -1 : a.dataset > b.dataset ? 1 : 0));
  const scope = input.collection === null ? sorted : sorted.filter((t) => t.dataset === input.collection);
  if (input.collection !== null && scope.length === 0) throw new DataError("not_found", "No such collection on this account.", 404);
  const start = tableCursorState(account, input);
  // the table of the cursor, or (dropped since) the next one in name order
  let index = start.t === null ? 0 : scope.findIndex((t) => t.dataset >= (start.t as string));
  if (index < 0) index = scope.length;
  let page = start.t !== null && scope[index]?.dataset === start.t ? start.n : 0;

  const rows: DocumentRow[] = [];
  let used = 0;
  let read = 0;
  let quarantined = 0;
  const started = now();
  const cursorAt = () => encodeDocCursor(account, input.collection, { t: scope[index]?.dataset ?? null, n: page });
  const finish = (out: DocumentsPage): DocumentsPage => {
    const result = { ...out, ...(quarantined > 0 ? { quarantined } : {}) };
    assertDocumentsConform(result, deps.log);
    return result;
  };

  await session.query(POSTGRES_PULL_SQL.begin);
  try {
    await session.query(POSTGRES_PULL_SQL.timeout);
    const keysOf = new Map<string, string[]>();
    while (index < scope.length) {
      if (rows.length >= limit || read + ROWS_PER_DOCUMENT > DB_PULL_ROW_CAP || (rows.length > 0 && now() - started > DOC_PULL_TIME_BUDGET_MS)) return finish({ rows, nextCursor: cursorAt(), exhausted: false });
      const full = scope[index] as DbTable;
      const table = withoutSecrets(full);
      if (table.columns.length === 0) {
        // nothing but secret-looking columns: no document for this table
        index += 1;
        page = 0;
        continue;
      }
      let keys = keysOf.get(table.dataset);
      if (!keys) {
        const [schema = "", name = ""] = table.dataset.split(".");
        keys = table.relation === "table" ? (await session.query(POSTGRES_PULL_SQL.primaryKey, [schema, name])).map((r) => String(r.attname)) : [];
        // a key column the catalog does not list (a name Connect cleaned) cannot be ordered on: fall back to ctid
        if (!keys.every((k) => full.columns.some((c) => c.name === k))) keys = [];
        keysOf.set(table.dataset, keys);
      }
      const fetched = await session.query(pageSql(table, keys), [ROWS_PER_DOCUMENT + 1, page * ROWS_PER_DOCUMENT]);
      read += Math.min(fetched.length, ROWS_PER_DOCUMENT);
      const more = fetched.length > ROWS_PER_DOCUMENT;
      const pageRows = fetched.slice(0, ROWS_PER_DOCUMENT);
      if (pageRows.length > 0) {
        const csv = toCsv(
          table.columns.map((c) => c.name),
          pageRows,
        );
        const first = page * ROWS_PER_DOCUMENT + 1;
        const id = `${table.dataset}:${page + 1}`;
        const version = docVersion(deps.db, account, id, `sha256:${createHash("sha256").update(csv.text).digest("hex")}`, now());
        const row: DocumentRow = {
          id,
          collection: table.dataset,
          title: `${table.dataset} rows ${first}–${first + Math.max(csv.rows, 1) - 1}`,
          path: `${table.dataset}/page ${page + 1}`,
          mime: "text/csv",
          updatedAt: isoTime(version.seenAt) ?? new Date(now()).toISOString(),
          rev: version.rev,
          kind: "table",
          text: csv.text,
          untrusted: true,
          ...(csv.truncated ? { truncated: true } : {}),
        };
        const why = rowProblems(row);
        if (why) {
          quarantined += 1;
          deps.log?.error("data_pull: a table page does not conform to documents/1 and was skipped", { account, collection: table.dataset, page: page + 1, why: why.slice(0, 200) });
        } else if (inWindow(row.updatedAt, input)) {
          const size = Buffer.byteLength(JSON.stringify(row)) + 1;
          // the page is full: this table page is read again first on the next pull
          if (rows.length > 0 && used + size > DOC_ROW_BUDGET_BYTES) return finish({ rows, nextCursor: cursorAt(), exhausted: false });
          rows.push(row);
          used += size;
        }
      }
      if (more) page += 1;
      else {
        index += 1;
        page = 0;
      }
    }
    return finish({ rows, nextCursor: null, exhausted: true });
  } finally {
    await session.query(POSTGRES_PULL_SQL.rollback).catch(() => undefined);
  }
}
