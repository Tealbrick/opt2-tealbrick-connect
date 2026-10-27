/**
 * Per-app sharing of connected accounts for the data_* ops (C230 R3; FOUNDRY-DESIGN v2 §3.4–3.5, the confused-deputy
 * ruling C169). The OWNER shares a connected chat account with one app, at a level:
 *   - `available`: data_catalog only (dataset names, kinds, approximate counts, conversation names, history flag; no message)
 *   - `shared`:    data_pull as well (read only)
 * No row means not shared (the default). An agent can never share, widen or read these rows (person op `account_app_share`).
 *
 * `set_at` is when the share began (it moves when the level or the history choice changes). A pull returns only messages
 * Connect received at or after it, unless the owner chose `includeHistory` (the whole log, 30 days).
 * Who the calling app is: see `caller.ts` (the verified product, never a name).
 *
 * C240 (migration 0013): a share is bound to the verified product AND the instance id the owner picked at share time, from
 * the person-op list `ctx.companionCallers()` (miniapp-sdk >= 0.1.32). A data_* call is served only when its verified
 * Caller.product and Caller.id are that pair. A reinstalled app has a new instance id, so it needs a new share; a row from
 * before 0013 has no instance and matches no caller. Nothing is bound on a first call.
 */
import type { Db } from "@opt2-tealbrick/spec/sdk";

export const SHARE_LEVELS = ["none", "available", "shared"] as const;
export type ShareLevel = (typeof SHARE_LEVELS)[number];
export type StoredLevel = Exclude<ShareLevel, "none">;

/** Apps the owner can share with: product id → name shown in the UI (a display list, not an identity table). */
export const DATA_APPS: Readonly<Record<string, string>> = {
  knowledge: "Knowledge",
  observer: "Observer",
};

export const isDataApp = (product: string): boolean => Object.hasOwn(DATA_APPS, product);

/**
 * C336 RQ-3: the route of a database share. `direct` = the share's product may read it (catalog, documents; a lease once
 * leases ship). `via_observer` = only Observer reads this database; the product of the row gets nothing for it (not listed,
 * not found). C373 (migration 0020): an MCP account share has a route too. Chat shares have none (always `direct`).
 */
export const SHARE_ROUTES = ["direct", "via_observer"] as const;
export type ShareRoute = (typeof SHARE_ROUTES)[number];

/** The two share tables: chat and MCP accounts (0010, 0013, route since 0020) and database accounts (0018, with the route). */
export type ShareTable = "connect_account_shares" | "connect_db_shares";

export interface ShareRow {
  product: string;
  /** the app instance the owner shared with; null = a row from before migration 0013 (matches no caller) */
  instance: string | null;
  level: StoredLevel;
  includeHistory: boolean;
  /** epoch ms */
  setAt: number;
  /** `direct` unless the owner chose `via_observer` (database and MCP shares only) */
  route: ShareRoute;
}

const rowOf = (r: Record<string, unknown>): ShareRow => ({
  product: String(r.product),
  instance: typeof r.instance_id === "string" && r.instance_id !== "" ? r.instance_id : null,
  level: String(r.level) as StoredLevel,
  includeHistory: Number(r.include_history) === 1,
  setAt: Number(r.set_at),
  route: r.route === "via_observer" ? "via_observer" : "direct",
});

export class ShareStore {
  readonly #db: Db;
  readonly #table: ShareTable;

  constructor(db: Db, table: ShareTable = "connect_account_shares") {
    this.#db = db;
    this.#table = table;
  }

  #row = (r: Record<string, unknown>): ShareRow => rowOf(r);

  get(account: string, product: string): ShareRow | null {
    const row = this.#db.prepare(`SELECT * FROM ${this.#table} WHERE account_id = ? AND product = ?`).get(account, product);
    return row ? this.#row(row) : null;
  }

  /** The share that serves a call: the row of this product, only when it is bound to exactly this caller instance. */
  forCaller(account: string, product: string, instance: string): ShareRow | null {
    const row = this.get(account, product);
    return row && row.instance !== null && row.instance === instance ? row : null;
  }

  level(account: string, product: string): ShareLevel {
    return this.get(account, product)?.level ?? "none";
  }

  /**
   * `none` removes the row (no instance needed). Else the row is bound to `instance`: a call that changes nothing keeps
   * `set_at`; a change of level, history choice or instance moves it to now (a new instance is a new share).
   */
  set(account: string, product: string, level: ShareLevel, includeHistory = false, instance: string | null = null, now = Date.now(), route: ShareRoute = "direct"): void {
    if (level === "none") {
      this.#db.prepare(`DELETE FROM ${this.#table} WHERE account_id = ? AND product = ?`).run(account, product);
      return;
    }
    if (!instance) throw new Error("a share needs the app instance (C240)");
    const current = this.get(account, product);
    if (current && current.level === level && current.includeHistory === includeHistory && current.instance === instance && current.route === route) return;
    // the table name is one of the two constants of ShareTable, never input
    this.#db
      .prepare(
        `INSERT INTO ${this.#table} (account_id, product, level, route, include_history, set_at, instance_id) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, product) DO UPDATE SET level = excluded.level, route = excluded.route, include_history = excluded.include_history, set_at = excluded.set_at, instance_id = excluded.instance_id`,
      )
      .run(account, product, level, route, includeHistory ? 1 : 0, now, instance);
  }

  forAccount(account: string): ShareRow[] {
    return this.#db.prepare(`SELECT * FROM ${this.#table} WHERE account_id = ? ORDER BY product`).all(account).map(this.#row);
  }

  /** The shares that serve this caller: bound to this product AND this instance. */
  accountsForCaller(product: string, instance: string): (ShareRow & { account: string })[] {
    return this.#db
      .prepare(`SELECT * FROM ${this.#table} WHERE product = ? AND instance_id = ? ORDER BY account_id`)
      .all(product, instance)
      .map((r) => ({ ...this.#row(r), account: String(r.account_id) }));
  }

  clearAccount(account: string): void {
    this.#db.prepare(`DELETE FROM ${this.#table} WHERE account_id = ?`).run(account);
  }
}
