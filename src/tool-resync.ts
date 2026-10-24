/**
 * C276a: re-sync stored tool rows after a classifier or catalog change. Tool rows (input schema, CRUD, effect, hold family) are
 * written when an account connects or the owner presses "Refresh tools"; without this, accounts connected before an update keep
 * the old classes and schemas. Runs from onStart: catalog services re-compile locally; Composio and MCP need the network and are
 * best effort (a failure is logged and retried at the next start, the marker is written only when every service synced).
 */
import type { Db, Logger } from "@opt2-tealbrick/spec/sdk";

import type { Account, AccountStore } from "./accounts.ts";

/** Bump when classify / per-method CRUD rules change, so stored rows are re-made on the next start. */
export const TOOL_CLASS_VERSION = "c331-1";
export const TOOL_CLASSES_KEY = "tool_classes";

export interface ResyncSources {
  accounts: AccountStore;
  catalog: { syncTools(service: string): Promise<number> };
  composio: { syncTools(service: string): Promise<number> };
  mcp: { syncTools(account: Account): Promise<number> };
}

/** Classifier version + catalog version + a digest of the shipped Composio policy files (a policy edit re-syncs too). */
export function toolClassMarker(catalogVersion: string | undefined, policyDigest = "none"): string {
  return `${TOOL_CLASS_VERSION}|catalog-${catalogVersion ?? "none"}|policies-${policyDigest}`;
}

export function storedMarker(db: Db): string | null {
  const row = db.prepare("SELECT value FROM connect_meta WHERE key = ?").get(TOOL_CLASSES_KEY);
  return row ? String(row.value) : null;
}

export async function resyncToolClasses(db: Db, s: ResyncSources, marker: string, log?: Logger, now = Date.now()): Promise<{ synced: string[]; failed: string[] }> {
  const synced: string[] = [];
  const failed: string[] = [];
  if (storedMarker(db) === marker) return { synced, failed };
  const seen = new Set<string>();
  for (const account of s.accounts.list({ status: "connected" })) {
    if (account.source !== "catalog" && account.source !== "composio" && account.source !== "mcp") continue;
    // Catalog and Composio tools are per service; MCP tools are per server account.
    const key = account.source === "mcp" ? `mcp:${account.id}` : `${account.source}:${account.service}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (account.source === "catalog") await s.catalog.syncTools(account.service);
      else if (account.source === "composio") await s.composio.syncTools(account.service);
      else await s.mcp.syncTools(account);
      synced.push(key);
    } catch (error) {
      // A catalog app that left the catalog has no tools to re-make; it must not block the marker forever.
      if ((error as { code?: string }).code === "catalog_app_unknown") {
        synced.push(key);
        continue;
      }
      failed.push(key);
      log?.warn("tool re-sync failed", { service: key, code: (error as { code?: string }).code ?? "error" });
    }
  }
  if (failed.length === 0) {
    db.prepare("INSERT INTO connect_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(
      TOOL_CLASSES_KEY,
      marker,
      now,
    );
  }
  if (synced.length || failed.length) log?.info("tool classes re-synced", { marker, synced: synced.length, failed: failed.length });
  return { synced, failed };
}
