-- 0019 (C368, C369): (1) a catalog tool records its upstream HTTP method and path, so Connect identifies an operation (Postiz
-- create post: POST /public/v1/posts) by what it calls, never by the hashed tool name. NULL for other sources and for rows made
-- before 0.7.4 (the tool re-sync on start fills them; until then such a row is treated as an unknown tool: held, no variant).
ALTER TABLE connect_tools ADD COLUMN http_method TEXT;
ALTER TABLE connect_tools ADD COLUMN http_path TEXT;

-- (2) The technical data behind a hold card ("More details"): tool, upstream operation, account and the call arguments, kept for
-- the owner only (read by the person op hold_details). Keyed by the hash of the hold text the SDK binds the approval to
-- (receipt meta.viewSha256). Rows older than one day are deleted on the next write (a hold lives 15 minutes).
CREATE TABLE connect_hold_details (
  view_sha256 TEXT PRIMARY KEY,
  tool        TEXT NOT NULL,
  details     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX connect_hold_details_created ON connect_hold_details (created_at);
