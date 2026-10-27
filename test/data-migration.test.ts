// Migration 0011 renumbers the inbound log's `rev` per account in ONE pass (window function + UPDATE FROM). A correlated
// COUNT(*) per row was quadratic (40k rows 4.5 s, 200k rows minutes) and would stall the start of a large log.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { root } from "./helpers.ts";

const dir = join(root, "migrations");
const sql = (name: string) => readFileSync(join(dir, name), "utf8");

test("migration 0011 renumbers 200 000 log rows (5 accounts) in under 5 s, per account 1..n in the old order", () => {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();
  for (const f of files.filter((n) => n < "0010")) db.exec(sql(f));
  for (let a = 0; a < 5; a++) {
    db.exec(`INSERT INTO connect_accounts (id, service, source, kind, label, owner_agent, status, detail, created_at, updated_at) VALUES ('a${a}','telegram','channel','as_itself','x','agt_1','connected','',1,1)`);
  }
  db.exec(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 200000)
    INSERT INTO connect_channel_inbox (account_id, conversation, conversation_type, message_id, sender_id, sender_name, text, sent_at, received_at)
    SELECT 'a' || (n % 5), 'c', 'channel', 'm' || n, 'u', 'U', 't', n, n FROM c`);
  db.exec(sql("0010_data_ops.sql"));
  const started = performance.now();
  db.exec(sql("0011_data_ops_review.sql"));
  const ms = performance.now() - started;
  console.log(`# migration 0011 on 200000 rows: ${Math.round(ms)} ms`);
  assert.ok(ms < 5000, `0011 took ${Math.round(ms)} ms`);
  // 40 000 rows per account, numbered 1..40000 in arrival order, and the counters continue above them
  for (let a = 0; a < 5; a++) {
    const r = db.prepare("SELECT COUNT(*) AS n, MIN(rev) AS lo, MAX(rev) AS hi, COUNT(DISTINCT rev) AS d FROM connect_channel_inbox WHERE account_id = ?").get(`a${a}`);
    assert.deepEqual({ ...r }, { n: 40_000, lo: 1, hi: 40_000, d: 40_000 });
    assert.equal(db.prepare("SELECT last FROM connect_account_rev WHERE account_id = ?").get(`a${a}`)?.last, 40_000);
  }
  const order = db.prepare("SELECT message_id FROM connect_channel_inbox WHERE account_id = 'a1' ORDER BY rev LIMIT 3").all().map((r) => r.message_id);
  assert.deepEqual(order, ["m1", "m6", "m11"]);
});

test("migration 0013 (C240) adds the share instance; a share from before it keeps NULL and matches no caller", async () => {
  const { ShareStore } = await import("../src/data/shares.ts");
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();
  assert.ok(files.includes("0013_share_instance.sql"));
  for (const f of files.filter((n) => n < "0013")) db.exec(sql(f));
  db.exec(`INSERT INTO connect_accounts (id, service, source, kind, label, owner_agent, status, detail, created_at, updated_at) VALUES ('a1','telegram','channel','as_itself','x','agt_1','connected','',1,1)`);
  db.exec(`INSERT INTO connect_account_shares (account_id, product, level, include_history, set_at) VALUES ('a1', 'knowledge', 'shared', 1, 5)`);
  db.exec(sql("0013_share_instance.sql"));
  const shares = new ShareStore(db as never);
  assert.equal(shares.get("a1", "knowledge")?.instance, null);
  assert.equal(shares.forCaller("a1", "knowledge", "ins_01HZKNWDG00000000000000000"), null);
  assert.deepEqual(shares.accountsForCaller("knowledge", "ins_01HZKNWDG00000000000000000"), []);
  // the later migrations (0020 adds the route; the store writes it) on top of the same rows
  for (const f of files.filter((n) => n > "0013_share_instance.sql")) db.exec(sql(f));
  shares.set("a1", "knowledge", "shared", true, "ins_01HZKNWDG00000000000000000", 9);
  assert.deepEqual(shares.forCaller("a1", "knowledge", "ins_01HZKNWDG00000000000000000"), { product: "knowledge", instance: "ins_01HZKNWDG00000000000000000", level: "shared", includeHistory: true, setAt: 9, route: "direct", lease: false });
  assert.throws(() => shares.set("a1", "observer", "shared", true, null), /needs the app instance/);
});

test("migration 0020 (C373): a share from before it reads route direct; the route column takes only direct or via_observer; doc versions table", () => {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();
  assert.ok(files.includes("0020_documents.sql"));
  for (const f of files.filter((n) => n < "0020")) db.exec(sql(f));
  db.exec(`INSERT INTO connect_accounts (id, service, source, kind, label, owner_agent, status, detail, created_at, updated_at) VALUES ('a1','telegram','channel','as_itself','x','agt_1','connected','',1,1)`);
  db.exec(`INSERT INTO connect_account_shares (account_id, product, level, include_history, set_at, instance_id) VALUES ('a1', 'knowledge', 'shared', 1, 5, 'ins_x')`);
  db.exec(sql("0020_documents.sql"));
  assert.equal(db.prepare("SELECT route FROM connect_account_shares WHERE account_id = 'a1'").get()?.route, "direct");
  assert.throws(() => db.exec("UPDATE connect_account_shares SET route = 'sideways'"), /CHECK/u);
  db.exec("INSERT INTO connect_doc_versions (account_id, doc_id, content_key, version, seen_at) VALUES ('a1', 'd1', 'sha256:x', 1, 7)");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connect_doc_versions").get()?.n, 1);
});

test("migration 0021 (QA-CONNECT35-9/-11/-13): expand only; old doc records survive, a database share has no lease, the cursor store takes a token", () => {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();
  assert.ok(files.includes("0021_documents_scan.sql"));
  for (const f of files.filter((n) => n < "0021")) db.exec(sql(f));
  db.exec("INSERT INTO connect_doc_versions (account_id, doc_id, content_key, version, seen_at) VALUES ('a1', 'd1', 'sha256:x', 3, 7)");
  db.exec("INSERT INTO connect_db_accounts (id, kind, label, endpoint, status, detail, created_at, updated_at) VALUES ('cdb_1', 'postgres', 'x', 'h:1/d', 'connected', '', 1, 1)");
  db.exec("INSERT INTO connect_db_shares (account_id, product, level, route, include_history, set_at, instance_id) VALUES ('cdb_1', 'observer', 'shared', 'direct', 0, 5, 'ins_x')");
  db.exec(sql("0021_documents_scan.sql"));
  assert.deepEqual({ ...db.prepare("SELECT version, seen_at, collection, updated_at, scan_at, deleted FROM connect_doc_versions").get() }, { version: 3, seen_at: 7, collection: null, updated_at: null, scan_at: null, deleted: 0 });
  assert.equal(db.prepare("SELECT lease FROM connect_db_shares").get()?.lease, 0, "an existing share has no lease");
  assert.throws(() => db.exec("UPDATE connect_db_shares SET lease = 2"), /CHECK/u);
  assert.throws(() => db.exec("UPDATE connect_doc_versions SET deleted = 2"), /CHECK/u);
  db.exec("INSERT INTO connect_doc_cursors (account_id, token, value, created_at) VALUES ('a1', 't1', '{}', 1)");
  assert.throws(() => db.exec("INSERT INTO connect_doc_cursors (account_id, token, value, created_at) VALUES ('a1', 't1', '{}', 1)"), /UNIQUE|PRIMARY/u);
});
