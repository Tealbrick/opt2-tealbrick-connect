-- 0016 (C336 RQ-3, C330(3)): database accounts for the data_* ops, with shares that carry a route, and data leases.
-- Expand only: new tables and new nullable columns. Nothing is changed or dropped.
--
-- Why new tables and not a new `connect_accounts.source` value: that column has a CHECK list (0001) that SQLite can only
-- widen by rebuilding the table, and the rebuild would cascade-delete every child row while foreign keys are on (the SDK
-- runs each migration inside a transaction with foreign_keys=ON, and node:sqlite is in defensive mode). A database
-- account is therefore its own row family, with ids `cdb_<ULID>`, apart from chat and tool accounts.

-- One row per connected database. The DSN (host, port, database, user, password, sslmode) is SEALED in ctx.secrets under
-- `db:<id>`; this row keeps only a display string (`host:port/database`, no user, no password) and the state.
CREATE TABLE connect_db_accounts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('postgres')),
  label TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('connected', 'revoked')),
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Same shape as connect_account_shares (0010, 0011, 0013) plus the route: `direct` = the share's product may lease the
-- credential; `via_observer` = only Observer reads this database and the product of this row gets nothing for it.
CREATE TABLE connect_db_shares (
  account_id TEXT NOT NULL REFERENCES connect_db_accounts (id) ON DELETE CASCADE,
  product TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('available', 'shared')),
  route TEXT NOT NULL DEFAULT 'direct' CHECK (route IN ('direct', 'via_observer')),
  include_history INTEGER NOT NULL DEFAULT 0,
  set_at INTEGER NOT NULL,
  instance_id TEXT,
  PRIMARY KEY (account_id, product)
);
CREATE INDEX connect_db_shares_product ON connect_db_shares (product);

-- One row per data_lease answer. NEVER the credential: only who, what and until when. v0: the lease is the owner's sealed
-- read-only credential plus the expiry written here; `revoked_at` ends the lease in Connect (no new use is promised after it).
CREATE TABLE connect_data_leases (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES connect_db_accounts (id) ON DELETE CASCADE,
  product TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  datasets TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX connect_data_leases_issued ON connect_data_leases (issued_at);

-- The data access log names the lease of a data_lease line.
ALTER TABLE connect_data_audit ADD COLUMN lease_id TEXT;
ALTER TABLE connect_data_audit ADD COLUMN lease_expires_at INTEGER;
