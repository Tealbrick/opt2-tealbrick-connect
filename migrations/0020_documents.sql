-- 0020 (C373): the `documents` dataset of the data_* ops. Expand only: one new column, one new table.
-- (1) A share of an MCP account carries a route like a database share (0018): `direct` = the share's product pulls the
--     documents; `via_observer` = only Observer reads the account and the product of this row gets nothing for it. Chat
--     account shares keep `direct` (Connect refuses another route for them).
ALTER TABLE connect_account_shares ADD COLUMN route TEXT NOT NULL DEFAULT 'direct' CHECK (route IN ('direct', 'via_observer'));

-- (2) The version of each document Connect has delivered: `content_key` (sha256 of the text, or of the server's etag), a
--     `version` that grows by one whenever the content key changes (so every change, also back to an older text, gets a NEW
--     `rev` = v<version>-<sha256 of the key>), and when Connect first saw that version (the row's `updatedAt` when the source
--     gives no time). No text is stored. `account_id` is a chat/tool account (`connect_accounts`) or a database account
--     (`connect_db_accounts`), so there is no foreign key; a disconnect deletes the account's rows.
CREATE TABLE connect_doc_versions (
  account_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  content_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, doc_id)
);

-- (3) The TLS mode of a database account (`disable`, `require`, `verify-full`; libpq meaning), so the owner page can show
--     it without reading the sealed DSN. NULL for an account added before 0020: Connect fills it from the DSN on first read.
ALTER TABLE connect_db_accounts ADD COLUMN sslmode TEXT CHECK (sslmode IS NULL OR sslmode IN ('disable', 'require', 'verify-full'));
