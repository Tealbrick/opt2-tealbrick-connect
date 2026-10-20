/** A fresh agent edge (no account access yet) still has usable Connect tools: Buzz ops and an empty accounts list. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { CrudAction, Manifest } from "@opt2-tealbrick/spec/manifest";

import { AccountStore } from "../src/accounts.ts";
import { createConnectApp } from "../src/app.ts";
import { ToolRegistry } from "../src/tools.ts";
import { handlerOf, root, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;

test("account-scoped ops are the tools family and the chat-bot ops; Buzz ops and accounts_list need no scope access", () => {
  const scoped = manifest.operations.filter((o) => o.audience === "agent" && o.scopeType).map((o) => o.id);
  assert.deepEqual(scoped.filter((id) => !id.startsWith("channel_")), ["tools"]);
  for (const id of ["buzz_identity", "buzz_channels", "buzz_read", "buzz_post", "buzz_react", "buzz_edit", "buzz_delete", "buzz_schedule", "buzz_dm_first", "buzz_dm", "accounts_list"]) {
    const op = manifest.operations.find((o) => o.id === id);
    assert.ok(op && op.audience === "agent" && !op.scopeType, id);
  }
});

test("accounts_list for an agent with no account access returns an empty list", async () => {
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations") });
  const out = await handlerOf(app, "accounts_list")({}, testCtx({ db, access: {} }));
  assert.deepEqual(out, { accounts: [], hints: [] });
});

test("CF-PZ-1/CF-PZ-4: accounts_list says why tools cannot be used: no account assigned, hidden by the grant, above the account access", async () => {
  const db = testDb();
  const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations") });
  const accounts = new AccountStore(db);
  const postiz = accounts.create({ service: "postiz", source: "catalog", kind: "as_me", label: "Postiz", ownerAgent: null, externalRef: "https://postiz.example.com", status: "connected" });
  accounts.create({ service: "mautic", source: "catalog", kind: "as_me", label: "Mautic", ownerAgent: null, externalRef: "https://mautic.example.com", status: "connected" });
  const tools = new ToolRegistry(db);
  const row = (name: string, crud: CrudAction[], effect: "read" | "write" | "outward" | "destructive") => ({ name, upstream: name, title: name, description: name, inputSchema: { type: "object" as const }, crud, effect });
  tools.replaceService("catalog", "postiz", [row("cb_postiz_list", ["read"], "read"), row("cb_postiz_create", ["create"], "outward"), row("cb_postiz_status", ["update"], "outward"), row("cb_postiz_delete", ["delete"], "destructive")]);
  tools.replaceService("catalog", "mautic", [row("cb_mautic_list", ["read"], "read")]);
  const hints = async (access: Record<string, "read" | "read_update" | "read_update_delete">, grantCrud?: CrudAction[]) =>
    ((await handlerOf(app, "accounts_list")({}, testCtx({ db, access, ...(grantCrud ? { grantCrud } : {}) }))) as { hints: string[] }).hints;
  // No account assigned at all: one hint per connected service.
  assert.deepEqual(await hints({}, ["read"]), [
    "No mautic account is assigned to you: ask the owner to assign one in Connect > Accounts.",
    "No postiz account is assigned to you: ask the owner to assign one in Connect > Accounts.",
  ]);
  // Henry's case before the fix: Read grant, full account access → 3 write tools hidden by the grant.
  const readGrant = await hints({ [postiz.id]: "read_update_delete" }, ["read"]);
  assert.ok(readGrant.includes("3 postiz tools need more than your Portal grant allows (need: create, update, delete). They are hidden unless the owner set your access to this account in Connect: ask the owner to set it there or to raise your Connect grant."), readGrant.join(" | "));
  assert.ok(readGrant.includes("No mautic account is assigned to you: ask the owner to assign one in Connect > Accounts."));
  // Grant Read + Create, account Read: the create tool is visible but above the account access; update/delete hidden.
  const mixed = await hints({ [postiz.id]: "read" }, ["read", "create"]);
  assert.ok(mixed.includes("2 postiz tools need more than your Portal grant allows (need: update, delete). They are hidden unless the owner set your access to this account in Connect: ask the owner to set it there or to raise your Connect grant."), mixed.join(" | "));
  assert.ok(mixed.includes("1 postiz tool needs more account access than you have (need: create): ask the owner to raise your access in Connect > Accounts."), mixed.join(" | "));
  // Everything allowed: no postiz hint.
  assert.ok(!(await hints({ [postiz.id]: "read_update_delete" }, ["read", "create", "update", "delete"])).some((h) => h.includes("postiz")));
});
