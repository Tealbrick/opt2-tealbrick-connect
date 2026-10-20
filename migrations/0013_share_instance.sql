-- 0013 (C240): a share binds the verified product AND the instance id of the app the owner picked at share time. A data_*
-- call is served only when its verified Caller.product and Caller.id are that pair, so a reinstalled app (a new instance id)
-- needs a new share. Rows from before this migration have no instance: they match no caller (fail closed) and the owner
-- page asks to share again. There is no binding on a first call.
ALTER TABLE connect_account_shares ADD COLUMN instance_id TEXT;
