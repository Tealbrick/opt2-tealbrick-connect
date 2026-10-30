-- 0027 (C380, audit hole 4): a scheduled Buzz post that a Rules hold stopped at send time keeps the id of that hold. The row stays
-- 'scheduled' and is asked about again each tick until the owner decides. NULL = no hold. Existing rows keep NULL.
ALTER TABLE connect_buzz_scheduled ADD COLUMN hold_id TEXT;
