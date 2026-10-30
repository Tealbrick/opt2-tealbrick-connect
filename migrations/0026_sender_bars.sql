-- 0026 (C380): senders whose messages no longer reach agents. One row per handle ("<channel>:<value>", src/sender-bars.ts).
-- `plan` = the Governance plan that set the bar, NULL when the owner set it on the Accounts page. `dropped` = chat messages
-- dropped at ingest. The row holds no message text. Existing inbound rows are kept.
CREATE TABLE connect_sender_bars (
  handle TEXT PRIMARY KEY,
  plan TEXT,
  at INTEGER NOT NULL,
  dropped INTEGER NOT NULL DEFAULT 0
);
