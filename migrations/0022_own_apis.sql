-- 0022 (C373 Jarvis T2, "bring your own API"): an OpenAPI 3 / Swagger 2 description the owner or the developer adds to Connect.
-- Connect compiles it with the catalog compiler (same hold classes) and lists it as a service next to the Tealbrick catalog;
-- accounts of it are ordinary catalog accounts (base URL + sealed key). Expand only. The spec text is kept as given (JSON);
-- labels and auth are the developer's own hold labels and the auth shape (never a key value: keys stay in the secret store).
CREATE TABLE connect_own_apis (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  spec         TEXT NOT NULL,
  spec_sha256  TEXT NOT NULL,
  labels       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  base_path    TEXT,
  health_op    TEXT,
  created_at   INTEGER NOT NULL
);
