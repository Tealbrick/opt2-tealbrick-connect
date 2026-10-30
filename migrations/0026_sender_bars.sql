-- 0026 (C380): senders whose messages no longer reach agents. One row per handle ("<channel>:<value>", src/sender-bars.ts).
-- `plan` = the Governance plan that set the bar, NULL when the owner set it on the Accounts page. `dropped` = chat messages
-- dropped at ingest. The row holds no message text. Existing inbound rows are kept.
CREATE TABLE connect_sender_bars (
  handle TEXT PRIMARY KEY,
  plan TEXT,
  at INTEGER NOT NULL,
  dropped INTEGER NOT NULL DEFAULT 0
);

-- The direct conversations of a barred handle. The inbound log is purged after 30 days and a Slack, Discord or Teams conversation
-- id is not the user id, so the link is kept here while the bar stands: filled from the log when the bar is set, and when a
-- message is dropped.
CREATE TABLE connect_sender_bar_conversations (
  handle TEXT NOT NULL REFERENCES connect_sender_bars (handle) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES connect_accounts (id) ON DELETE CASCADE,
  conversation TEXT NOT NULL,
  PRIMARY KEY (handle, account_id, conversation)
);
CREATE INDEX connect_sender_bar_conversations_by_conversation ON connect_sender_bar_conversations (account_id, conversation);
