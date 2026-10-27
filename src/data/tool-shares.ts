/**
 * C373 Jarvis (Coordinator approval, C366 shape): the owner shares one connected account with ONE app instance for READ tools
 * only. The first and only app is Evolving Workflows: its engine runs a deterministic workflow that reads a mailbox, a sheet or
 * an own API through `connect.tools`. Rules:
 *   - the share binds the account, the VERIFIED product and the exact instance id the owner picked from the signed slice
 *     (`companionCallersFor`); a reinstalled app has a new instance id and gets nothing;
 *   - the calling instance must still be listed in the current slice (`companionListed`), checked per call;
 *   - only a tool whose resolved class is READ (crud read only, effect read) is served, checked per call; write, outward,
 *     destructive and money tools are agent-only (with holds) and refused for app callers;
 *   - owner-only person op, off by default, shown on the Accounts page; deleting the row is the kill path (the next call fails).
 * Table `connect_tool_shares` (migration 0024).
 */
import type { Db } from "@opt2-tealbrick/spec/sdk";

/** Apps an account can be shared with for read tools: product id → name shown in the UI. */
export const TOOL_SHARE_APPS: Readonly<Record<string, string>> = { evolution: "Evolving Workflows" };
export const isToolShareApp = (product: string): boolean => Object.hasOwn(TOOL_SHARE_APPS, product);

export interface ToolShare {
  account: string;
  product: string;
  instance: string;
  setAt: number;
}

export class ToolShareStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  get(account: string, product: string): ToolShare | null {
    const r = this.#db.prepare("SELECT account, product, instance, set_at FROM connect_tool_shares WHERE account = ? AND product = ?").get(account, product) as
      | { account: string; product: string; instance: string; set_at: number }
      | undefined;
    return r ? { account: r.account, product: r.product, instance: r.instance, setAt: Number(r.set_at) } : null;
  }

  forAccount(account: string): ToolShare[] {
    return (this.#db.prepare("SELECT account, product, instance, set_at FROM connect_tool_shares WHERE account = ? ORDER BY product").all(account) as { account: string; product: string; instance: string; set_at: number }[]).map((r) => ({
      account: r.account,
      product: r.product,
      instance: r.instance,
      setAt: Number(r.set_at),
    }));
  }

  set(account: string, product: string, instance: string, now = Date.now()): void {
    this.#db
      .prepare("INSERT INTO connect_tool_shares (account, product, instance, set_at) VALUES (?, ?, ?, ?) ON CONFLICT(account, product) DO UPDATE SET instance = excluded.instance, set_at = excluded.set_at")
      .run(account, product, instance, now);
  }

  remove(account: string, product: string): boolean {
    return Number(this.#db.prepare("DELETE FROM connect_tool_shares WHERE account = ? AND product = ?").run(account, product).changes) > 0;
  }
}
