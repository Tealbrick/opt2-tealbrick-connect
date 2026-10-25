-- 0016 (IN-2, C322(9), C331(3)): messages a companion app sent WITH buttons (Operator Inbox: Approve / Deny on an alert).
-- A click is relayed only when it hits one of these messages, with one of its stored buttons, before `expires_at`, while
-- the message is `open`; the first relayed click that ends in a decision closes it (`done`). The button values are the
-- app's signed tokens: only their SHA-256 hashes are kept. `requested_account` is the `account` input of the send (the
-- app binds its token to it). Rows are purged 30 days after they expire.
CREATE TABLE connect_channel_actions (
  account_id TEXT NOT NULL,
  conversation TEXT NOT NULL,
  message_id TEXT NOT NULL,
  product TEXT NOT NULL,
  instance TEXT NOT NULL,
  requested_account TEXT NOT NULL,
  value_hashes TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'busy', 'done')),
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, conversation, message_id)
);
CREATE INDEX connect_channel_actions_expiry ON connect_channel_actions (expires_at);
