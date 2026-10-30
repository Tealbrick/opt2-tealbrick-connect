-- 0025 (Connect-writes, C366b, Coordinator approval 2026-10-30): the owner can also share an account for WRITE tools with the app
-- instance it is already shared with. A separate flag, default off: every share made before this migration stays read only.
ALTER TABLE connect_tool_shares ADD COLUMN writes INTEGER NOT NULL DEFAULT 0;
