-- 0012 (C276a): one key/value row per app-wide fact. `tool_classes` records which tool classifier and catalog version the
-- stored connect_tools rows were made with; on start Connect re-syncs every connected service when it differs, so a new
-- classifier (per-method CRUD) or a new catalog (overlays, header defaults) reaches accounts connected before the update.
CREATE TABLE connect_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
