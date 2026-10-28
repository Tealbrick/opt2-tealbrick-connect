-- 0021 (C373, QA-CONNECT35-9/-11/-13): scan bookkeeping for the `documents` dataset and the lease flag. Expand only.
-- (1) connect_doc_versions learns where a document lives and when a full scan last saw it, so a document that is gone from
--     the source can be delivered once as a deletion row (documents/1 `deleted: true`). `deleted = 1` is the tombstone: it
--     keeps the version counter, so a document that comes back takes a NEW rev. Tombstones are dropped after 30 days.
ALTER TABLE connect_doc_versions ADD COLUMN collection TEXT;
ALTER TABLE connect_doc_versions ADD COLUMN updated_at INTEGER;
ALTER TABLE connect_doc_versions ADD COLUMN scan_at INTEGER;
ALTER TABLE connect_doc_versions ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));

-- (2) A cursor state that does not fit the 512 characters of a cursor (a long list cursor of the source server, a long key
--     value) is kept here under a short token; the cursor carries the token. Old rows are pruned on write.
CREATE TABLE connect_doc_cursors (
  account_id TEXT NOT NULL,
  token TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, token)
);

-- (3) QA-CONNECT35-11: a database share at `shared` gives rows as documents. It must NEVER also give the sealed database
--     credential (a lease). The lease needs its own explicit flag, set by nobody today (leases are not shipped): 0 = no lease.
--     A change of the share (level, route, instance) resets it to 0.
ALTER TABLE connect_db_shares ADD COLUMN lease INTEGER NOT NULL DEFAULT 0 CHECK (lease IN (0, 1));
