/**
 * The `documents` dataset of a database account (C373): every table or view of the catalog is a collection
 * (`<schema>.<table>`); one document is one page of up to ROWS_PER_DOCUMENT rows as CSV with a header line (kind `table`,
 * mime `text/csv`, id `<schema>.<table>:<page>`, page 1 = the first rows).
 *
 * How rows are read (the only place Connect reads table data):
 *  - one READ ONLY transaction (REPEATABLE READ) with a statement time limit, on a session that is read-only already
 *    (`pg-driver.ts`), after the role check (a superuser or replication role is refused, as at connect time);
 *  - only tables and views of the CURRENT catalog; identifiers come from that catalog, never from the caller, and are quoted;
 *  - every column cast to text and cut in SQL to CELL_MAX + 1 characters (`left(col::text, ...)`, QA-CONNECT35-7), except
 *    columns whose name looks like a secret (see `isSecretColumn`): those are never selected, and data_catalog lists them per
 *    collection (`droppedColumns`);
 *  - ordered by the primary key, else `ctid` for a table, else by every selected column for a view;
 *  - at most `DB_PULL_ROW_CAP` rows per pull, at most `limit` documents, at most 2 MiB per page.
 * Paging (QA-CONNECT35-5): a table with a primary key whose columns are all selected pages by KEY (`WHERE key > last`, the
 * cursor holds the last key), so a deep page costs no more than the first. A table without one (a view, `ctid` order, a key
 * that includes a dropped column) pages by LIMIT/OFFSET and is skipped when a page times out. A table that fails (permission
 * denied, a foreign table that is down, a timeout) is skipped inside a SAVEPOINT: it is counted in `skipped`, named in
 * `failedCollections`, and the pull goes on with the next table.
 * The cursor state: the table (`t`), the document number in that table (`n`), the rows already read from it (`o`), the last
 * key (`k`, keyset only) and the scan start (`s`). A page cut by the text cap advances only past the rows it holds
 * (QA-CONNECT35-6): the next document starts with the first row that was cut.
 * Deletions: see `documents.ts` (`reapDeleted`): after the last table of a full scan, a document of an earlier scan that this
 * scan did not see (a page that no longer exists, a table that was dropped) is delivered once as `deleted: true`.
 */
import { createHash } from "node:crypto";
import type { Db, Logger } from "@opt2-tealbrick/spec/sdk";

import type { DbColumn, DbSession, DbTable } from "./database.ts";
import {
  assertDocumentsConform,
  clampLimit,
  commitVersion,
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
  encodeDocCursor,
  inWindow,
  isoTime,
  markCollectionSeen,
  markSeen,
  newScan,
  planVersion,
  pruneTombstones,
  reapDeleted,
  rowProblems,
  stateInt,
} from "./documents.ts";
import { DataError } from "./messages.ts";

export const ROWS_PER_DOCUMENT = 200;
/** The most table rows one data_pull reads, whatever `limit` says. */
export const DB_PULL_ROW_CAP = 2000;
export const CELL_MAX = 4096;
const STATEMENT_TIMEOUT_MS = 10_000;
const FAILED_NAMES_MAX = 20;

/** The fixed statements of a pull (besides the generated SELECT of one page). No caller input is put into them. */
export const POSTGRES_PULL_SQL = {
  begin: "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
  timeout: `SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`,
  primaryKey:
    "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey) " +
    "WHERE i.indrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass AND i.indisprimary " +
    "ORDER BY array_position(i.indkey::int2[], a.attnum)",
  savepoint: "SAVEPOINT table_pull",
  rollbackTo: "ROLLBACK TO SAVEPOINT table_pull",
  release: "RELEASE SAVEPOINT table_pull",
  rollback: "ROLLBACK",
} as const;

// ── secret-looking columns (QA-CONNECT35-4) ──

/** Letters of other scripts that look like Latin ones (a column named with them is a disguise). */
const LOOKALIKE: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", х: "x", у: "y", і: "i", ѕ: "s", ј: "j", ԁ: "d", һ: "h", ԛ: "q", ԝ: "w", ӏ: "l", к: "k", м: "m", т: "t", в: "b", н: "h",
  α: "a", β: "b", ε: "e", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ζ: "z", η: "n",
};
/** whole words of a name (split at separators and camelCase) that mark a secret */
const SECRET_WORDS = new Set([
  "pass", "passwd", "password", "passcode", "passphrase", "pw", "pwd", "pswd", "passwort", "contrasena", "motdepasse", "kennwort", "wachtwoord", "senha",
  "auth", "authorization", "bearer", "jwt", "hash", "digest", "hmac", "pin", "otp", "totp", "cvv", "cvc", "ssn",
  "secret", "secrets", "token", "tokens", "apikey", "salt", "session", "sessions", "cookie", "cookies", "credential", "credentials", "creds",
  "encrypted", "cipher", "ciphertext",
]);
/** `key` is a secret only with one of these words before it (a bare `key` column is a name in a key/value table) */
const KEY_PREFIX = new Set(["api", "private", "secret", "auth", "license", "licence", "access", "signing", "client", "encryption", "master", "ssh", "session", "service", "app", "public"]);
/** stems found anywhere in the name with its separators removed (and common letter swaps undone) */
const SECRET_STEMS =
  /(password|passwd|passphrase|passcode|passwort|contrasena|motdepasse|kennwort|wachtwoord|secret|token|credential|apikey|privatekey|accesskey|secretkey|signingkey|clientkey|encryptionkey|masterkey|sshkey|authkey|licensekey|sessionid|sessionkey|cookie|otpseed|totp|mfaseed|recoverycode|bearer|authorization)/u;

/** NFKC, accents removed, look-alike letters mapped to Latin; `mixed` = Latin letters together with look-alike letters of another script. */
function foldName(name: string): { text: string; mixed: boolean } {
  const base = name.normalize("NFKC").normalize("NFD").replace(/\p{M}/gu, "");
  let other = false;
  const mapped = Array.from(base)
    .map((ch) => {
      const lower = ch.toLowerCase();
      if (LOOKALIKE[lower] !== undefined) {
        other = true;
        return ch === lower ? LOOKALIKE[lower] : (LOOKALIKE[lower] as string).toUpperCase();
      }
      return ch;
    })
    .join("");
  return { text: mapped, mixed: other && /[A-Za-z]/u.test(mapped) };
}

/**
 * documents/1 (spec QA): a column whose name looks like a secret is dropped from table pages. The name is folded (NFKC,
 * accents removed, look-alike Cyrillic and Greek letters read as Latin; Latin mixed with those is dropped), split into words at
 * separators and camelCase, and matched against a word list (pass, pw, auth, hash, pin, otp, token, ...), `key` after a
 * word such as api/private/secret, and secret stems in the joined name (`apikey`, `credential`, a leet-spelled `s3cret`).
 * It is a heuristic: a secret under an ordinary name is not found. data_catalog lists what was dropped; the owner checks.
 */
export function isSecretColumn(name: string): boolean {
  const { text, mixed } = foldName(name);
  if (mixed) return true;
  const spaced = text.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2").toLowerCase();
  const words = spaced.split(/[^a-z0-9]+/u).filter(Boolean);
  if (words.some((w) => SECRET_WORDS.has(w))) return true;
  if (words.some((w, i) => w === "key" && i > 0 && KEY_PREFIX.has(words[i - 1] as string))) return true;
  const joined = words.join("");
  if (SECRET_STEMS.test(joined)) return true;
  const unleeted = joined.replace(/0/gu, "o").replace(/1/gu, "i").replace(/3/gu, "e").replace(/4/gu, "a").replace(/5/gu, "s").replace(/7/gu, "t");
  return SECRET_STEMS.test(unleeted);
}
/** The table with its secret-looking columns removed (what a page selects). */
export const withoutSecrets = (table: DbTable): DbTable => ({ ...table, columns: table.columns.filter((c) => !isSecretColumn(c.name)) });

/** A Postgres identifier, quoted. Names come from the database's own catalog. */
export const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;
/** The name of a column in the database (a cleaned catalog name keeps the real one in `real`). */
const dbName = (c: DbColumn): string => c.real ?? c.name;

/**
 * The SELECT of one page: every column as text cut to CELL_MAX + 1 characters, a stable order. `keyset` = the number of key
 * values the page starts after (0 = from the first row): `WHERE (key...) > ($2...)`, `LIMIT $1`. Without `keyset`:
 * `LIMIT $1 OFFSET $2`. `keys` are database names.
 */
export function pageSql(table: DbTable, keys: readonly string[], keyset?: number): string {
  const [schema = "", name = ""] = table.dataset.split(".");
  const cols = table.columns.map((c) => `left(src.${quoteIdent(dbName(c))}::text, ${CELL_MAX + 1}) AS ${quoteIdent(c.name)}`).join(", ");
  const order =
    keys.length > 0
      ? keys.map((k) => `src.${quoteIdent(k)}`).join(", ")
      : table.relation === "table"
        ? "src.ctid"
        : table.columns.map((_c, i) => String(i + 1)).join(", ");
  const from = `FROM ${quoteIdent(schema)}.${quoteIdent(name)} AS src`;
  if (keyset === undefined) return `SELECT ${cols} ${from} ORDER BY ${order} LIMIT $1 OFFSET $2`;
  if (keyset === 0) return `SELECT ${cols} ${from} ORDER BY ${order} LIMIT $1`;
  const left = keys.map((k) => `src.${quoteIdent(k)}`);
  const holders = keys.map((_k, i) => `$${i + 2}`);
  const where = keys.length === 1 ? `${left[0]} > ${holders[0]}` : `(${left.join(", ")}) > (${holders.join(", ")})`;
  return `SELECT ${cols} ${from} WHERE ${where} ORDER BY ${order} LIMIT $1`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  // documents/1: no NUL in text (Postgres text cannot hold one; a cast of another type could)
  let s = String(value).replaceAll("\0", "");
  if (s.length > CELL_MAX) s = `${Array.from(s).slice(0, CELL_MAX).join("")}…`;
  return /[",\r\n]/u.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * CSV with a header line; cut at a whole line when it would pass the contract's text cap. `rows` is how many rows the text
 * holds: the caller advances past exactly those (QA-CONNECT35-6). A first row that alone passes the cap is cut inside the
 * line (`truncated`), so a cursor always moves.
 */
export function toCsv(columns: readonly string[], rows: readonly Record<string, unknown>[]): { text: string; truncated: boolean; rows: number } {
  const lines = [columns.map(csvCell).join(",")];
  let length = lines[0]?.length ?? 0;
  let kept = 0;
  for (const r of rows) {
    const line = columns.map((c) => csvCell(r[c])).join(",");
    // +1 for the line break; the cap is in characters and a UTF-16 length is never smaller than the character count
    if (length + 1 + line.length > DOC_TEXT_MAX) {
      if (kept > 0) return { text: lines.join("\n"), truncated: true, rows: kept };
      lines.push(Array.from(line).slice(0, Math.max(0, DOC_TEXT_MAX - length - 1)).join(""));
      return { text: lines.join("\n"), truncated: true, rows: 1 };
    }
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

interface TableCursor {
  /** table of the cursor; null = the first one */
  t: string | null;
  /** documents already made from this table (the next id is `n + 1`) */
  n: number;
  /** rows already read from this table */
  o: number;
  /** last key values (text), keyset paging only */
  k: string[] | null;
  /** start of the scan (null = a cursor from before scans were tracked: no deletions) */
  s: number | null;
  /** deletion phase: records kept so far (null = not in it) */
  rk: number | null;
}

/** Checks the cursor before any database contact (a cursor of another account or collection is refused at once). */
export function tableCursorState(db: Db, account: string, input: Pick<DocumentsPullInput, "cursor" | "collection">, now = Date.now()): TableCursor {
  if (input.cursor === null) return { t: null, n: 0, o: 0, k: null, s: newScan(db, account, now), rk: null };
  const s = decodeDocCursor(db, input.cursor, account, input.collection);
  const k = Array.isArray(s.k) && s.k.length > 0 && s.k.length <= 16 && s.k.every((v) => typeof v === "string") ? (s.k as string[]) : null;
  return {
    t: typeof s.t === "string" ? s.t : null,
    n: stateInt(s.n),
    o: stateInt(s.o),
    k,
    s: typeof s.s === "number" && Number.isSafeInteger(s.s) ? s.s : null,
    rk: typeof s.rk === "number" && Number.isSafeInteger(s.rk) && s.rk >= 0 ? s.rk : null,
  };
}

const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{2,40}$/u.test(code) ? code : "unknown";
};

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
  const start = tableCursorState(deps.db, account, input, now());
  const scan = start.s;
  // deletions only from a full, unfiltered scan: no collection, no `until`
  const canReap = input.collection === null && input.until === null && scan !== null;
  // the table of the cursor, or (dropped since) the next one in name order
  let index = start.rk !== null ? scope.length : start.t === null ? 0 : scope.findIndex((t) => t.dataset >= (start.t as string));
  if (index < 0) index = scope.length;
  const same = start.t !== null && scope[index]?.dataset === start.t;
  let doc = same ? start.n : 0;
  let offset = same ? start.o : 0;
  let lastKey: string[] | null = same ? start.k : null;

  const rows: DocumentRow[] = [];
  const failed: string[] = [];
  let used = 0;
  let read = 0;
  let handled = 0;
  let quarantined = 0;
  let skipped = 0;
  const started = now();
  const cursorAt = () =>
    encodeDocCursor(deps.db, account, input.collection, { t: scope[index]?.dataset ?? null, n: doc, o: offset, ...(lastKey ? { k: lastKey } : {}), ...(scan === null ? {} : { s: scan }) }, now());
  const finish = (out: DocumentsPage): DocumentsPage => {
    const result = {
      ...out,
      ...(quarantined > 0 ? { quarantined } : {}),
      ...(skipped > 0 ? { skipped } : {}),
      ...(failed.length > 0 ? { failedCollections: failed.slice(0, FAILED_NAMES_MAX) } : {}),
    };
    assertDocumentsConform(result, deps.log);
    return result;
  };
  const reset = () => {
    index += 1;
    doc = 0;
    offset = 0;
    lastKey = null;
  };

  // the deletion phase needs no database contact
  const reap = async (from: number): Promise<DocumentsPage> => {
    const reaped = await reapDeleted({ db: deps.db, account, scan: scan as number, offset: from, capacity: limit - rows.length, now, window: input, fallbackCollection: "tables" });
    rows.push(...reaped.rows);
    if (!reaped.done) return finish({ rows, nextCursor: encodeDocCursor(deps.db, account, input.collection, { rk: reaped.offset, s: scan }, now()), exhausted: false });
    pruneTombstones(deps.db, account, now());
    return finish({ rows, nextCursor: null, exhausted: true });
  };
  if (start.rk !== null) return canReap ? reap(start.rk) : finish({ rows, nextCursor: null, exhausted: true });

  await session.query(POSTGRES_PULL_SQL.begin);
  try {
    await session.query(POSTGRES_PULL_SQL.timeout);
    const keysOf = new Map<string, string[]>();
    while (index < scope.length) {
      // at least one table page is handled per pull, so a cursor always moves; then the row cap and the time budget apply, rows or not
      if (rows.length >= limit || read + ROWS_PER_DOCUMENT > DB_PULL_ROW_CAP || (handled > 0 && now() - started > DOC_PULL_TIME_BUDGET_MS)) return finish({ rows, nextCursor: cursorAt(), exhausted: false });
      handled += 1;
      const full = scope[index] as DbTable;
      const table = withoutSecrets(full);
      if (table.columns.length === 0) {
        // nothing but secret-looking columns: no document for this table
        reset();
        continue;
      }
      // keyset paging when the primary key is known and every key column is a selected one (its value then is in the row and in the cursor)
      let keys = keysOf.get(table.dataset);
      let fetched: Record<string, unknown>[];
      let useKeyset = false;
      try {
        await session.query(POSTGRES_PULL_SQL.savepoint);
        if (!keys) {
          const [schema = "", name = ""] = table.dataset.split(".");
          const found = table.relation === "table" ? (await session.query(POSTGRES_PULL_SQL.primaryKey, [schema, name])).map((r) => String(r.attname)) : [];
          // a key column the catalog does not list cannot be ordered on: fall back to ctid
          keys = found.every((k) => full.columns.some((c) => dbName(c) === k)) ? found : [];
          keysOf.set(table.dataset, keys);
        }
        const keyColumns = keys.map((k) => table.columns.find((c) => dbName(c) === k));
        useKeyset = keys.length > 0 && keyColumns.every((c) => c !== undefined);
        const after = useKeyset && lastKey && lastKey.length === keys.length ? lastKey : null;
        if (useKeyset && lastKey && !after) throw new Error("cursor key does not fit the table");
        fetched = await session.query(pageSql(table, keys, useKeyset ? (after ? keys.length : 0) : undefined), useKeyset ? [ROWS_PER_DOCUMENT + 1, ...(after ?? [])] : [ROWS_PER_DOCUMENT + 1, offset]);
        await session.query(POSTGRES_PULL_SQL.release);
      } catch (error) {
        // QA-CONNECT35-5: one bad or slow table never blocks the others; the savepoint keeps the transaction usable
        await session.query(POSTGRES_PULL_SQL.rollbackTo);
        deps.log?.error("data_pull: a table could not be read and was skipped", { account, collection: table.dataset, code: errorCode(error) });
        skipped += 1;
        failed.push(table.dataset);
        if (scan !== null) markCollectionSeen(deps.db, account, table.dataset, scan);
        reset();
        continue;
      }
      const more = fetched.length > ROWS_PER_DOCUMENT;
      const pageRows = fetched.slice(0, ROWS_PER_DOCUMENT);
      read += pageRows.length;
      if (pageRows.length === 0) {
        reset();
        continue;
      }
      const columns = table.columns.map((c) => c.name);
      const csv = toCsv(columns, pageRows);
      const first = offset + 1;
      const id = `${table.dataset}:${doc + 1}`;
      const plan = planVersion(deps.db, account, id, `sha256:${createHash("sha256").update(csv.text).digest("hex")}`, now());
      const updatedAt = isoTime(plan.seenAt) ?? new Date(now()).toISOString();
      const row: DocumentRow = {
        id,
        collection: table.dataset,
        title: `${table.dataset} rows ${first}–${first + csv.rows - 1}`,
        path: `${table.dataset}/page ${doc + 1}`,
        mime: "text/csv",
        updatedAt,
        rev: plan.rev,
        kind: "table",
        text: csv.text,
        untrusted: true,
        ...(csv.truncated ? { truncated: true } : {}),
      };
      if (scan !== null) markSeen(deps.db, account, id, scan);
      const why = rowProblems(row);
      if (why) {
        quarantined += 1;
        deps.log?.error("data_pull: a table page does not conform to documents/1 and was skipped", { account, collection: table.dataset, page: doc + 1, why: why.slice(0, 200) });
      } else if (inWindow(row.updatedAt, input)) {
        const size = Buffer.byteLength(JSON.stringify(row)) + 1;
        // the page is full: this table page is read again first on the next pull
        if (rows.length > 0 && used + size > DOC_ROW_BUDGET_BYTES) return finish({ rows, nextCursor: cursorAt(), exhausted: false });
        commitVersion(deps.db, account, id, plan, { collection: table.dataset, updatedAt: Date.parse(updatedAt), scan: canReap ? scan : null });
        rows.push(row);
        used += size;
      }
      // advance past the rows the document holds, no further (QA-CONNECT35-6)
      doc += 1;
      offset += csv.rows;
      if (useKeyset) {
        const lastRow = pageRows[csv.rows - 1] as Record<string, unknown>;
        const keyNames = (keys as string[]).map((k) => (table.columns.find((c) => dbName(c) === k) as DbColumn).name);
        lastKey = keyNames.map((n) => String(lastRow[n] ?? ""));
      }
      if (!more && csv.rows === pageRows.length) reset();
    }
    if (canReap) return await reap(0);
    return finish({ rows, nextCursor: null, exhausted: true });
  } finally {
    await session.query(POSTGRES_PULL_SQL.rollback).catch(() => undefined);
  }
}

