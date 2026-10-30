/**
 * C373 Jarvis (Coordinator approval, C366 shape): the owner shares one connected account with ONE app instance for READ tools
 * only. The first and only app is Evolving Workflows: its engine runs a deterministic workflow that reads a mailbox, a sheet or
 * an own API through `connect.tools`. Rules:
 *   - the share binds the account, the VERIFIED product and the exact instance id the owner picked from the signed slice
 *     (`companionCallersFor`); a reinstalled app has a new instance id and gets nothing;
 *   - the calling instance must still be listed in the current slice (`companionListed`), checked per call;
 *   - a share serves READ tools (crud read only, effect read). With `writes` (a separate owner choice, off by default, migration
 *     0025) it also serves WRITE tools (a draft, a label, a new record) and OUTWARD tools, the latter only when the caller's grant holds
 *     the tool's family, so the SDK runs it only on an owner approval (src/app.ts `outwardHeldByGrant`). DESTRUCTIVE and MONEY tools stay agent-only, whatever the share says;
 *   - owner-only person op, off by default, shown on the Accounts page; deleting the row is the kill path (the next call fails).
 * Table `connect_tool_shares` (migrations 0024, 0025).
 */
import type { Db } from "@opt2-tealbrick/spec/sdk";

/** Apps an account can be shared with for tools: product id → name shown in the UI. */
export const TOOL_SHARE_APPS: Readonly<Record<string, string>> = { evolution: "Evolving Workflows" };
export const isToolShareApp = (product: string): boolean => Object.hasOwn(TOOL_SHARE_APPS, product);

export interface ToolShare {
  account: string;
  product: string;
  instance: string;
  setAt: number;
  /** the owner also allowed write tools (migration 0025); false for every share made before it */
  writes: boolean;
}

interface Row {
  account: string;
  product: string;
  instance: string;
  set_at: number;
  writes: number;
}
const COLUMNS = "account, product, instance, set_at, writes";
const fromRow = (r: Row): ToolShare => ({ account: r.account, product: r.product, instance: r.instance, setAt: Number(r.set_at), writes: Number(r.writes) === 1 });

export class ToolShareStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  get(account: string, product: string): ToolShare | null {
    const r = this.#db.prepare(`SELECT ${COLUMNS} FROM connect_tool_shares WHERE account = ? AND product = ?`).get(account, product) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  forAccount(account: string): ToolShare[] {
    return (this.#db.prepare(`SELECT ${COLUMNS} FROM connect_tool_shares WHERE account = ? ORDER BY product`).all(account) as unknown as Row[]).map(fromRow);
  }

  /** The shares bound to one exact app instance. */
  forInstance(product: string, instance: string): ToolShare[] {
    return (this.#db.prepare(`SELECT ${COLUMNS} FROM connect_tool_shares WHERE product = ? AND instance = ? ORDER BY account`).all(product, instance) as unknown as Row[]).map(fromRow);
  }

  /** `writes` is always written: a share again without it narrows to read tools, never keeps an older write choice. */
  set(account: string, product: string, instance: string, writes: boolean, now = Date.now()): void {
    this.#db
      .prepare("INSERT INTO connect_tool_shares (account, product, instance, set_at, writes) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account, product) DO UPDATE SET instance = excluded.instance, set_at = excluded.set_at, writes = excluded.writes")
      .run(account, product, instance, now, writes ? 1 : 0);
  }

  remove(account: string, product: string): boolean {
    return Number(this.#db.prepare("DELETE FROM connect_tool_shares WHERE account = ? AND product = ?").run(account, product).changes) > 0;
  }
}
