-- 0017 (C343a): Buzz DMs a companion app sent WITH buttons (Operator Inbox alerts). Buzz has no buttons, so the recipient
-- reacts ✅ (primary) or ❌ (danger) on the alert. `events` = the alert's kind 9 events ({id, channel} per relay channel);
-- `owner_pubkey` = the hex key the DM went to (only its signed reaction counts); `requested_to` = the `to` input of the
-- send (the app binds its token to it). The button values are NOT here: they are sealed in the app secrets
-- (`buzz-actions:<id>`) and removed when the alert closes. Rows are purged 30 days after they expire.
CREATE TABLE connect_buzz_actions (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL,
  owner_pubkey TEXT NOT NULL,
  requested_to TEXT NOT NULL,
  events TEXT NOT NULL,
  product TEXT NOT NULL,
  instance TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'busy', 'done')),
  result TEXT,
  notice_sent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX connect_buzz_actions_open ON connect_buzz_actions (state, created_at);
