-- 0024 (C373 Jarvis, Coordinator approval): the owner shares one connected account with ONE app instance for READ tools only
-- (first app: Evolving Workflows, so a deterministic workflow can read a mailbox, a sheet or an own API, C366). Keyed by the
-- account and the verified product; bound to the exact instance id the owner picked (a reinstall = a new instance = no share).
-- Writes, outward, destructive and money tools stay agent-only with holds. Off by default; deleting the row is the kill path.
CREATE TABLE connect_tool_shares (
  account   TEXT NOT NULL REFERENCES connect_accounts (id) ON DELETE CASCADE,
  product   TEXT NOT NULL,
  instance  TEXT NOT NULL,
  set_at    INTEGER NOT NULL,
  PRIMARY KEY (account, product)
);
