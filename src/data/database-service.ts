/**
 * Database accounts and data leases: the orchestration between the sealed DSN, the address policy and the injected driver
 * (C336 RQ-3). `app.ts` keeps the caller checks (who is an app, which share) and calls this for everything that touches the
 * database. See `database.ts` for what is stored and what Connect reads.
 */
import { normalizeLabel } from "../accounts.ts";
import { type Lookup, NetPolicyError, resolvePublicHost } from "../util/net-policy.ts";
import {
  checkRole,
  DATASET_ID,
  type DatabaseAccountStore,
  type DatabaseDriver,
  type DatabaseDrivers,
  type DatabaseKind,
  type DbAccount,
  type DbDsn,
  type DbTable,
  type DbTarget,
  LEASE_DEFAULT_TTL_S,
  LEASE_MAX_DATASETS,
  LEASE_MAX_TTL_S,
  type LeaseRow,
  type LeaseStore,
  parseDsn,
  readCatalog,
  withSession,
} from "./database.ts";
import type { DocumentsPage, DocumentsPullInput } from "./documents.ts";
import { DataError } from "./messages.ts";
import { pullTableDocuments, type TableDocumentsDeps, tableCursorState } from "./table-documents.ts";

export interface DatabaseServiceDeps {
  accounts: DatabaseAccountStore;
  leases: LeaseStore;
  drivers: DatabaseDrivers;
  /** DNS (tests inject one) */
  lookup?: Lookup;
  /** exact host names that skip the address policy (tests only; there is no owner-facing exception, C41) */
  allowHosts?: readonly string[];
}

/** The data_lease answer. It is the ONLY place the password leaves Connect, and only in the op output. */
export interface LeaseGrant {
  leaseId: string;
  kind: DatabaseKind;
  host: string;
  port: number;
  /** the address the net policy checked just now: connect to this, with TLS name `host` */
  checkedAddress: string;
  database: string;
  user: string;
  password: string;
  sslmode: DbDsn["sslmode"];
  datasets: string[];
  expiresAt: string;
}

/**
 * Every error that leaves the database path has a code and a FIXED message. A DataError (fixed texts in this module and in
 * `database.ts`) and a NetPolicyError (its reason is one of a short list, never the host) pass; anything else (a SQLite error,
 * a JSON error, a bug) becomes `fallback`. No DSN, host, user or password reaches an error message (QA, M-OP-12).
 */
async function sealed<T>(fallback: { code: string; message: string; status: number }, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DataError || error instanceof NetPolicyError) throw error;
    throw new DataError(fallback.code, fallback.message, fallback.status);
  }
}

export class DatabaseService {
  readonly #d: DatabaseServiceDeps;

  constructor(deps: DatabaseServiceDeps) {
    this.#d = deps;
  }

  #driver(kind: DatabaseKind): DatabaseDriver {
    return this.#d.drivers[kind] ?? (() => { throw new DataError("database_driver_unavailable", "This Connect build cannot read this kind of database yet.", 503); })();
  }

  /** Host policy now: every DNS answer public (a private address is refused), returns the address that passed. */
  async #resolve(host: string): Promise<string> {
    const resolved = await resolvePublicHost(host, { ...(this.#d.lookup ? { lookup: this.#d.lookup } : {}), ...(this.#d.allowHosts ? { allowHosts: this.#d.allowHosts } : {}) });
    return resolved.address;
  }

  async #target(account: DbAccount): Promise<{ dsn: DbDsn; target: DbTarget }> {
    const dsn = await this.#d.accounts.dsn(account);
    return { dsn, target: { ...dsn, address: await this.#resolve(dsn.host) } };
  }

  /**
   * Add a database: validates the form, checks the host against the address policy, connects once to check that the role is
   * not a superuser and has no replication, then seals the DSN. Nothing is stored when any step fails.
   */
  connect(input: { kind: DatabaseKind; label: string; fields: Record<string, unknown> }): Promise<DbAccount> {
    return sealed({ code: "database_connect_failed", message: "The database could not be added.", status: 500 }, () => this.#connect(input));
  }

  async #connect(input: { kind: DatabaseKind; label: string; fields: Record<string, unknown> }): Promise<DbAccount> {
    const dsn = parseDsn(input.fields, input.kind);
    const label = normalizeLabel(input.label);
    const driver = this.#driver(input.kind);
    const target: DbTarget = { ...dsn, address: await this.#resolve(dsn.host) };
    await withSession(driver, target, (session) => checkRole(session));
    return this.#d.accounts.create({ kind: input.kind, label, dsn });
  }

  /** Table and column names, types, approximate row counts. Metadata only. */
  catalog(account: DbAccount): Promise<DbTable[]> {
    return sealed({ code: "catalog_failed", message: "The table list could not be read.", status: 500 }, () => this.#catalog(account));
  }

  async #catalog(account: DbAccount): Promise<DbTable[]> {
    const { target } = await this.#target(account);
    return withSession(this.#driver(account.kind), target, (session) => readCatalog(account.kind, session));
  }

  /**
   * C373: one page of the `documents` dataset (table rows as CSV, `table-documents.ts`). The cursor is checked before any
   * database contact; then the address policy, the role check (a superuser or replication role is refused, as at connect),
   * the current catalog and one READ ONLY transaction.
   */
  pullDocuments(account: DbAccount, input: DocumentsPullInput, deps: TableDocumentsDeps): Promise<DocumentsPage> {
    tableCursorState(account.id, input);
    return sealed({ code: "pull_failed", message: "The rows could not be read.", status: 500 }, async () => {
      const { target } = await this.#target(account);
      return withSession(this.#driver(account.kind), target, async (session) => {
        await checkRole(session);
        const tables = await readCatalog(account.kind, session);
        return pullTableDocuments(deps, session, account.id, tables, input);
      });
    });
  }

  /** Datasets of a lease request: 1..50 distinct `schema.table` strings. */
  static datasets(raw: unknown): string[] {
    if (!Array.isArray(raw) || raw.length < 1) throw new DataError("datasets_required", `Name 1 to ${LEASE_MAX_DATASETS} datasets as schema.table.`, 400);
    if (raw.length > LEASE_MAX_DATASETS) throw new DataError("too_many_datasets", `A lease covers at most ${LEASE_MAX_DATASETS} datasets.`, 400);
    const seen = new Set<string>();
    for (const d of raw) {
      if (typeof d !== "string" || !DATASET_ID.test(d)) throw new DataError("dataset_invalid", "Every dataset must be written as schema.table.", 400);
      seen.add(d);
    }
    return [...seen];
  }

  static ttl(raw: unknown): number {
    if (raw === undefined || raw === null) return LEASE_DEFAULT_TTL_S;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) throw new DataError("ttl_invalid", `ttlS must be a whole number of seconds from 1 to ${LEASE_MAX_TTL_S}.`, 400);
    if (raw > LEASE_MAX_TTL_S) throw new DataError("ttl_too_long", `A lease lasts at most ${LEASE_MAX_TTL_S} seconds. Ask again when it ends.`, 400);
    return raw;
  }

  /**
   * v0 lease: the owner's sealed read-only credential, handed to the calling app with an expiry that Connect records. Only
   * datasets that exist in the catalog now. The record holds no credential.
   */
  lease(input: { account: DbAccount; product: string; instance: string; datasets: readonly string[]; ttlS: number; now?: number }): Promise<{ grant: LeaseGrant; row: LeaseRow }> {
    return sealed({ code: "lease_failed", message: "The lease could not be issued.", status: 500 }, () => this.#lease(input));
  }

  async #lease(input: { account: DbAccount; product: string; instance: string; datasets: readonly string[]; ttlS: number; now?: number }): Promise<{ grant: LeaseGrant; row: LeaseRow }> {
    const { dsn, target } = await this.#target(input.account);
    const tables = await withSession(this.#driver(input.account.kind), target, (session) => readCatalog(input.account.kind, session));
    const known = new Set(tables.map((t) => t.dataset));
    const missing = input.datasets.filter((d) => !known.has(d));
    if (missing.length > 0) throw new DataError("dataset_not_found", "A requested dataset is not in the catalog of this database. Read data_catalog and ask again.", 404);
    const row = this.#d.leases.issue({
      account: input.account.id,
      product: input.product,
      instance: input.instance,
      datasets: input.datasets,
      ttlS: input.ttlS,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    const grant: LeaseGrant = {
      leaseId: row.id,
      kind: input.account.kind,
      host: dsn.host,
      port: dsn.port,
      checkedAddress: target.address,
      database: dsn.database,
      user: dsn.user,
      password: dsn.password,
      sslmode: dsn.sslmode,
      datasets: [...input.datasets],
      expiresAt: new Date(row.expiresAt).toISOString(),
    };
    return { grant, row };
  }
}
