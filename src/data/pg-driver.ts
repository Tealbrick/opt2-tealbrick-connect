/**
 * The production Postgres client for database accounts (C336 RQ-3): a thin adapter over `pg` behind the `DatabaseDriver`
 * interface. Connect sends the catalog statements of `database.ts` and the read-only pull of `table-documents.ts` through
 * it. Tests never load this file: they pass a fake driver.
 * - TLS keeps the libpq meaning of sslmode: `require` encrypts without checking the certificate (a Railway-hosted database
 *   with a self-signed certificate works), `verify-full` checks the certificate and the host name, `disable` is plain.
 *
 * - Connects to the ADDRESS the net policy checked (`target.address`), not to the host name, so DNS cannot answer twice.
 *   TLS keeps checking the certificate against the host name (`servername`) in mode verify-full.
 * - The session is read-only (`default_transaction_read_only`), with a connect and a statement time limit.
 * - Every parameter is explicit, so no PG* environment variable or ~/.pgpass entry is ever used.
 * - A failure carries the driver's error `code`; the message (which may name a user or host) is dropped by `driverFailure`.
 */
import { isIP } from "node:net";

import pg from "pg";

import type { DatabaseDriver, DatabaseDrivers, DbRow, DbSession, DbTarget } from "./database.ts";

const CONNECT_TIMEOUT_MS = 8_000;
const STATEMENT_TIMEOUT_MS = 10_000;

function sslOf(target: DbTarget): false | pg.ClientConfig["ssl"] {
  if (target.sslmode === "disable") return false;
  const servername = isIP(target.host) ? undefined : target.host;
  return {
    rejectUnauthorized: target.sslmode === "verify-full",
    ...(servername ? { servername } : {}),
  };
}

export const postgresDriver: DatabaseDriver = {
  async connect(target: DbTarget): Promise<DbSession> {
    const client = new pg.Client({
      host: target.address,
      port: target.port,
      database: target.database,
      user: target.user,
      password: target.password,
      ssl: sslOf(target),
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      query_timeout: STATEMENT_TIMEOUT_MS + 2_000,
      application_name: "tealbrick-connect",
      options: "-c default_transaction_read_only=on",
    });
    // an idle error must not crash the process; the next query reports it
    client.on("error", () => undefined);
    await client.connect();
    return {
      async query(sql: string, params?: readonly unknown[]): Promise<DbRow[]> {
        const result = await client.query(sql, params ? [...params] : undefined);
        return result.rows as DbRow[];
      },
      async close(): Promise<void> {
        await client.end();
      },
    };
  },
};

/** The drivers a production Connect passes to `createConnectApp`. MySQL joins here when it is built. */
export const defaultDatabaseDrivers = (): DatabaseDrivers => ({ postgres: postgresDriver });
