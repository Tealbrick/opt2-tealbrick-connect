-- A refused data_* call is audited at most once per minute for the same caller, product, op and code; `repeats` counts the
-- further identical refusals folded into that line. A successful call always has its own line (the owner sees every pull).
ALTER TABLE connect_data_audit ADD COLUMN repeats INTEGER NOT NULL DEFAULT 0;
