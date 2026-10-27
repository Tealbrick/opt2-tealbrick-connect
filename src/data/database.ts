/**
 * Database accounts for the data_* ops (C336 RQ-3, C330(3); FOUNDRY-DESIGN §3.3-3.4).
 *
 * A database account is the owner's read-only connection to one database. Only Postgres is built. MySQL is the next
 * kind: add it to DATABASE_KINDS, give it a driver in the `DatabaseDrivers` map (src/data/pg-driver.ts is the pattern)
 * and a catalog query set next to POSTGRES_SQL; nothing else in Connect names the kind.
 *
 * What is stored where:
 *  - the DSN (host, port, database, user, password, sslmode) is SEALED in ctx.secrets under `db:<id>`;
 *  - `connect_db_accounts` keeps a label, the kind, a display string `host:port/database` (no user, no password) and the state;
 *  - `connect_data_leases` keeps who got a lease for which datasets until when. NEVER the credential.
 *
 * Connect reads METADATA here: table and column names, column types, approximate row counts (data_catalog) and the role
 * flags of the connecting user (a superuser or replication role is refused). The queries are the constants in POSTGRES_SQL.
 * C373: table rows are read in exactly one place, the `documents` dataset (`table-documents.ts`): a READ ONLY transaction,
 * fixed statements plus one generated page SELECT over catalog names, secret-looking columns never selected.
 *
 * The password leaves this module in exactly one place: `DatabaseAccountStore.dsn()`, used by the lease handler and the
 * driver call. Errors of a driver are mapped to fixed text plus an allow-listed code: a driver message is never forwarded.
 */
import type { AppSecrets } from "@opt2-tealbrick/miniapp-sdk";
import type { Db } from "@opt2-tealbrick/spec/sdk";

import { newId } from "../util/ids.ts";
import { DataError } from "./messages.ts";

export const DATABASE_KINDS = ["postgres"] as const;
export type DatabaseKind = (typeof DATABASE_KINDS)[number];
/** `service` name a database account shows in the owner page and in data_accounts_list. */
export const DATABASE_SERVICE: Record<DatabaseKind, string> = { postgres: "postgres" };
export const DEFAULT_PORT: Record<DatabaseKind, number> = { postgres: 5432 };

/** `disable` sends the password without TLS, `require` encrypts without checking who answers, `verify-full` checks the certificate and host name. */
export const SSL_MODES = ["disable", "require", "verify-full"] as const;
export type SslMode = (typeof SSL_MODES)[number];

/** Shown next to the form, returned by the connect operation. */
export const DATABASE_RECOMMENDATION =
  "Use a dedicated read-only database user: SELECT on the tables you want to share and nothing else (no INSERT, UPDATE, DELETE, no REPLICATION, not a superuser). Connect refuses a superuser or replication role.";

export const LEASE_MAX_TTL_S = 900;
export const LEASE_DEFAULT_TTL_S = 300;
export const LEASE_MAX_DATASETS = 50;
const MAX_TABLES = 2000;
const MAX_COLUMNS = 500;
const NAME_MAX = 128;

export interface DbDsn {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslmode: SslMode;
}

/** What a driver connects to: the DSN plus the address the net policy checked (connect to THAT, TLS name stays `host`). */
export interface DbTarget extends DbDsn {
  address: string;
}

export type DbRow = Record<string, unknown>;

/** One open connection. The catalog code sends only the statements of POSTGRES_SQL. */
export interface DbSession {
  query(sql: string, params?: readonly unknown[]): Promise<DbRow[]>;
  close(): Promise<void>;
}

/** The injected client: production is `pg-driver.ts`, tests pass a fake. A driver throws errors that may carry only `code`. */
export interface DatabaseDriver {
  connect(target: DbTarget): Promise<DbSession>;
}
export type DatabaseDrivers = Partial<Record<DatabaseKind, DatabaseDriver>>;

// ── DSN input ──

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates the owner's form. The error text never contains the password. */
export function parseDsn(input: Record<string, unknown>, kind: DatabaseKind): DbDsn {
  const text = (name: string, max: number, code: string, message: string): string => {
    const v = input[name];
    if (typeof v !== "string" || v.trim() === "" || v.length > max || /[\0\r\n]/u.test(v)) throw new DataError(code, message, 400);
    return v;
  };
  const host = text("host", 253, "host_required", "Enter the database host name or address.").trim();
  if (/[\s/@?#\\]/u.test(host)) throw new DataError("host_invalid", "The host must be a plain name or address, without a path, user or port.", 400);
  const rawPort = input.port;
  const port = rawPort === undefined || rawPort === null || rawPort === "" ? DEFAULT_PORT[kind] : typeof rawPort === "number" ? rawPort : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DataError("port_invalid", "The port must be a number from 1 to 65535.", 400);
  const database = text("database", 63, "database_required", "Enter the database name (up to 63 characters).").trim();
  const user = text("user", 63, "user_required", "Enter the database user (up to 63 characters).").trim();
  const password = text("password", 256, "password_required", "Enter the password of the database user (up to 256 characters).");
  const sslRaw = input.sslmode;
  const sslmode = sslRaw === undefined || sslRaw === null || sslRaw === "" ? "verify-full" : sslRaw;
  if (typeof sslmode !== "string" || !(SSL_MODES as readonly string[]).includes(sslmode)) throw new DataError("sslmode_invalid", "Pick disable, require or verify-full.", 400);
  return { host, port, database, user, password, sslmode: sslmode as SslMode };
}

/** Never the user or the password. */
export const endpointOf = (dsn: Pick<DbDsn, "host" | "port" | "database">): string => `${dsn.host.includes(":") ? `[${dsn.host}]` : dsn.host}:${dsn.port}/${dsn.database}`;

// ── catalog (metadata only) ──

/** The only statements Connect sends to a customer database. Fixed text: no input is ever put into them. */
export const POSTGRES_SQL = {
  role: "SELECT rolsuper, rolreplication FROM pg_roles WHERE rolname = current_user",
  columns:
    "SELECT c.table_schema, c.table_name, c.column_name, c.data_type, t.table_type " +
    "FROM information_schema.columns c " +
    "JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name " +
    "WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.table_schema NOT LIKE 'pg\\_%' " +
    "ORDER BY c.table_schema, c.table_name, c.ordinal_position LIMIT 100000",
  rows:
    "SELECT n.nspname AS table_schema, c.relname AS table_name, c.reltuples::bigint AS approx_rows " +
    "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
    "WHERE c.relkind IN ('r', 'p', 'v', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%' LIMIT 100000",
} as const;

export interface DbColumn {
  name: string;
  type: string;
}
export interface DbTable {
  /** `schema.table` */
  dataset: string;
  relation: "table" | "view" | "foreign_table";
  columns: DbColumn[];
  /** reltuples, only when the database has statistics (-1 = never analysed: absent) */
  approxRows?: number;
}

const clean = (value: unknown): string => String(value ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, NAME_MAX);
const RELATION: Record<string, DbTable["relation"]> = { "BASE TABLE": "table", VIEW: "view", FOREIGN: "foreign_table" };

/** A dataset id the lease input accepts: `schema.table`, no dot or quote inside a part. */
export const DATASET_ID = /^[^.\s"]{1,63}\.[^.\s"]{1,63}$/u;

/** Table and column names, types and approximate row counts. Never a value. */
export async function readCatalog(kind: DatabaseKind, session: DbSession): Promise<DbTable[]> {
  if (kind !== "postgres") throw new DataError("database_kind_unsupported", "This kind of database is not supported yet.", 400);
  const columns = await session.query(POSTGRES_SQL.columns);
  const rows = await session.query(POSTGRES_SQL.rows);
  const counts = new Map<string, number>();
  for (const r of rows) {
    const n = Number(r.approx_rows);
    if (Number.isFinite(n) && n >= 0) counts.set(`${clean(r.table_schema)}.${clean(r.table_name)}`, Math.trunc(n));
  }
  const tables = new Map<string, DbTable>();
  for (const r of columns) {
    const schema = clean(r.table_schema);
    const table = clean(r.table_name);
    const dataset = `${schema}.${table}`;
    // a name that cannot be written as schema.table (a dot or a quote inside) cannot be leased: left out
    if (!DATASET_ID.test(dataset) || schema !== String(r.table_schema) || table !== String(r.table_name)) continue;
    let entry = tables.get(dataset);
    if (!entry) {
      if (tables.size >= MAX_TABLES) continue;
      entry = { dataset, relation: RELATION[String(r.table_type)] ?? "table", columns: [] };
      const approx = counts.get(dataset);
      if (approx !== undefined) entry.approxRows = approx;
      tables.set(dataset, entry);
    }
    if (entry.columns.length < MAX_COLUMNS) entry.columns.push({ name: clean(r.column_name), type: clean(r.data_type) });
  }
  return [...tables.values()];
}

/** A superuser or a replication role is refused: the recommendation (read-only, no REPLICATION) is enforced where Connect can see it. */
export async function checkRole(session: DbSession): Promise<void> {
  const [role] = await session.query(POSTGRES_SQL.role);
  if (role?.rolsuper === true) throw new DataError("database_role_too_powerful", "This database user is a superuser. Use a dedicated read-only user with SELECT only.", 422);
  if (role?.rolreplication === true) throw new DataError("database_role_too_powerful", "This database user may replicate. Use a dedicated read-only user with SELECT only and no REPLICATION.", 422);
}

/** Maps a driver failure to fixed text. Only an allow-listed `code` is kept; the driver message (which may name a user or host) never is. */
export function driverFailure(error: unknown): DataError {
  if (error instanceof DataError) return error;
  const code = isRecord(error) && typeof error.code === "string" && /^[A-Za-z0-9_]{2,40}$/u.test(error.code) ? error.code : null;
  return new DataError("database_unreachable", `Connect could not read the database${code ? ` (${code})` : ""}. Check the address, the user and the TLS setting, then try again.`, 502);
}

/** Opens a session, runs `fn`, always closes. A failure of the driver becomes `driverFailure`. */
export async function withSession<T>(driver: DatabaseDriver, target: DbTarget, fn: (session: DbSession) => Promise<T>): Promise<T> {
  let session: DbSession;
  try {
    session = await driver.connect(target);
  } catch (error) {
    throw driverFailure(error);
  }
  try {
    return await fn(session);
  } catch (error) {
    throw driverFailure(error);
  } finally {
    await session.close().catch(() => undefined);
  }
}

// ── accounts ──

export interface DbAccount {
  id: string;
  kind: DatabaseKind;
  label: string;
  endpoint: string;
  status: "connected" | "revoked";
  detail: string;
  /** the TLS mode (libpq meaning; C373 migration 0020); null for an account from before it until `tlsMode` fills it */
  sslmode: SslMode | null;
  createdAt: number;
  updatedAt: number;
}

export const isDatabaseId = (id: string): boolean => id.startsWith("cdb_");

const accountOf = (r: DbRow): DbAccount => ({
  id: String(r.id),
  kind: String(r.kind) as DatabaseKind,
  label: String(r.label),
  endpoint: String(r.endpoint),
  status: r.status === "revoked" ? "revoked" : "connected",
  detail: String(r.detail),
  sslmode: (SSL_MODES as readonly unknown[]).includes(r.sslmode) ? (r.sslmode as SslMode) : null,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const secretName = (id: string): string => `db:${id}`;

export class DatabaseAccountStore {
  readonly #db: Db;
  readonly #secrets: AppSecrets;

  constructor(db: Db, secrets: AppSecrets) {
    this.#db = db;
    this.#secrets = secrets;
  }

  async create(input: { kind: DatabaseKind; label: string; dsn: DbDsn; now?: number }): Promise<DbAccount> {
    const now = input.now ?? Date.now();
    const id = newId("cdb");
    await this.#secrets.put(secretName(id), JSON.stringify(input.dsn));
    try {
      this.#db
        .prepare("INSERT INTO connect_db_accounts (id, kind, label, endpoint, status, detail, sslmode, created_at, updated_at) VALUES (?, ?, ?, ?, 'connected', '', ?, ?, ?)")
        .run(id, input.kind, input.label, endpointOf(input.dsn), input.dsn.sslmode, now, now);
    } catch (error) {
      await this.#secrets.delete(secretName(id)).catch(() => undefined);
      throw error;
    }
    const created = this.get(id);
    if (!created) throw new Error("account_create_failed");
    return created;
  }

  get(id: string): DbAccount | null {
    const row = this.#db.prepare("SELECT * FROM connect_db_accounts WHERE id = ?").get(id);
    return row ? accountOf(row) : null;
  }

  list(): DbAccount[] {
    return this.#db.prepare("SELECT * FROM connect_db_accounts ORDER BY label, created_at").all().map(accountOf);
  }

  rename(id: string, label: string, now = Date.now()): DbAccount {
    this.#db.prepare("UPDATE connect_db_accounts SET label = ?, updated_at = ? WHERE id = ?").run(label, now, id);
    return this.get(id) ?? (() => { throw new Error("account_not_found"); })();
  }

  /** The sealed DSN. The only reader of the password. */
  async dsn(account: Pick<DbAccount, "id" | "kind">): Promise<DbDsn> {
    const raw = await this.#secrets.get(secretName(account.id));
    if (!raw) throw new DataError("database_credentials_missing", "The database has no stored credentials; connect it again.", 409);
    // a JSON.parse error quotes a piece of its source text: the sealed DSN must never reach an error message
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
      return parseDsn(parsed, account.kind);
    } catch {
      throw new DataError("database_credentials_invalid", "The stored database credentials cannot be read; connect it again.", 409);
    }
  }

  /** The TLS mode for the owner page. An account from before migration 0020 has none in its row: read once from the seal. */
  async tlsMode(account: DbAccount): Promise<SslMode | null> {
    if (account.sslmode !== null || account.status !== "connected") return account.sslmode;
    try {
      const { sslmode } = await this.dsn(account);
      this.#db.prepare("UPDATE connect_db_accounts SET sslmode = ? WHERE id = ?").run(sslmode, account.id);
      return sslmode;
    } catch {
      return null;
    }
  }

  /** Seal removed, row kept as `revoked` (the owner's list hides it). */
  async revoke(id: string, now = Date.now()): Promise<DbAccount> {
    await this.#secrets.delete(secretName(id));
    this.#db.prepare("UPDATE connect_db_accounts SET status = 'revoked', detail = 'Disconnected by the owner.', updated_at = ? WHERE id = ?").run(now, id);
    return this.get(id) ?? (() => { throw new Error("account_not_found"); })();
  }
}

// ── leases ──

export interface LeaseRow {
  id: string;
  account: string;
  product: string;
  instance: string;
  datasets: string[];
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

const leaseOf = (r: DbRow): LeaseRow => ({
  id: String(r.id),
  account: String(r.account_id),
  product: String(r.product),
  instance: String(r.instance_id),
  datasets: JSON.parse(String(r.datasets)) as string[],
  issuedAt: Number(r.issued_at),
  expiresAt: Number(r.expires_at),
  revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
});

/** The lease record. It never holds a credential: v0 is the owner's sealed credential plus the expiry written here. */
export class LeaseStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  issue(input: { account: string; product: string; instance: string; datasets: readonly string[]; ttlS: number; now?: number }): LeaseRow {
    const now = input.now ?? Date.now();
    const id = newId("lse");
    const expiresAt = now + input.ttlS * 1000;
    this.#db
      .prepare("INSERT INTO connect_data_leases (id, account_id, product, instance_id, datasets, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.account, input.product, input.instance, JSON.stringify(input.datasets), now, expiresAt);
    return { id, account: input.account, product: input.product, instance: input.instance, datasets: [...input.datasets], issuedAt: now, expiresAt, revokedAt: null };
  }

  get(id: string): LeaseRow | null {
    const row = this.#db.prepare("SELECT * FROM connect_data_leases WHERE id = ?").get(id);
    return row ? leaseOf(row) : null;
  }

  /** Newest first. */
  list(limit: number): LeaseRow[] {
    return this.#db.prepare("SELECT * FROM connect_data_leases ORDER BY issued_at DESC, id DESC LIMIT ?").all(limit).map(leaseOf);
  }

  /** Ends one lease. false = unknown id. An ended or expired lease stays as it is. */
  revoke(id: string, now = Date.now()): boolean {
    const row = this.get(id);
    if (!row) return false;
    if (row.revokedAt === null) this.#db.prepare("UPDATE connect_data_leases SET revoked_at = ? WHERE id = ?").run(now, id);
    return true;
  }

  /** Ends every open lease of an account, optionally of one product (the owner changed or removed a share). */
  revokeOpen(account: string, product?: string, now = Date.now()): number {
    const sql = `UPDATE connect_data_leases SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL AND expires_at > ?${product ? " AND product = ?" : ""}`;
    const params: unknown[] = [now, account, now];
    if (product) params.push(product);
    return Number(this.#db.prepare(sql).run(...params).changes);
  }

  prune(before: number): void {
    this.#db.prepare("DELETE FROM connect_data_leases WHERE issued_at < ?").run(before);
  }
}

export const leaseState = (row: Pick<LeaseRow, "expiresAt" | "revokedAt">, now = Date.now()): "active" | "revoked" | "expired" =>
  row.revokedAt !== null ? "revoked" : row.expiresAt <= now ? "expired" : "active";
