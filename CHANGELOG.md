# Changelog

Versions follow `package.json` and `tealbrick.manifest.json` (product id `connect`). Proposed next version: 0.6.0 (new operations and a migration).

## 0.6.0 - 2026-10-18 (prepared, not tagged)

The shared data operation family and the dataset `messages` (request R3, knowledge S-9; decisions C230 and C169). Not tagged: the lead decides the tag.

### Data sharing works for apps the owner shares with (C230 R3, SDK-CALLER-PRODUCT)
- The data operations `data_accounts_list`, `data_catalog` and `data_pull` now serve apps. The calling app is identified by the VERIFIED caller product (`ctx.caller.product`, miniapp-sdk 0.1.28: the verified grant's `prd` first, else the signed slice entry; a grant/slice mismatch is refused `grant_invalid` by the SDK), never by its name or instance id. The share check, the share record and the audit row all key on the product id.
- An app caller without a verified product is refused `caller_unverified` (403); a person or an agent is refused `no_access` (403); an app the owner did not share the account with gets `not_found` (404), identical for every account it cannot see. There is no fallback to the app name.
- The 503 `data_ops_unavailable` gate, the test-only `verifiedAppProduct` option of `createConnectApp` and the `dataOpsAvailable` flag are removed. Accounts no longer says "Sharing takes effect when Connect is updated".
- Dependencies: miniapp-sdk 0.1.28 (was 0.1.25), spec 0.1.46 (was 0.1.39; the type of `OpContext.caller.product`), manifest 0.1.23 (was 0.1.19; optional grant claim `prd`), conformance 0.1.21 (was 0.1.18; adds `A12.caller_product_verified` and `A12.grant_prd_*`, which pass). Lockfile integrity re-pinned with `tb-ci pin-tarballs`.
- The conformance waiver `A3.caps_count` is gone: a `capsAgent` setup step (conformance 0.1.21) has the fresh caps agent schedule a Buzz post, so `buzz_schedule_cancel` runs. The fixtures are `tealbrick-conformance.json` and `conformance.inputs.json`; `conformance.start.ts` turns the sentinel `sendAt` into "one hour from now" (harness only). Result: PASS (126 pass, 23 not_applicable, no waiver).
- New test `test/data-caller-e2e.test.ts` (real SDK, signed slice): an app named "Observer" whose verified product is Knowledge gets what is shared with Knowledge and nothing of what is shared with Observer; a grant `prd` that differs from the slice product is refused with no data.

### Added
- Operations `data_accounts_list`, `data_catalog` and `data_pull` (agent audience until the app audience exists; effect read, crud read, idempotency none, no receipt). They serve apps only: an agent or a person gets `no_access` (403). One contract for Knowledge and Observer; a later dataset needs no new operation.
- Dataset `messages` (kind messages, delivery pull, contract `messages/1`, spec tag `spec-v0.1.42`): the inbound log of Slack, Teams, Telegram and Discord. Rows have id, conversation, thread, sentAt/editedAt (RFC 3339 UTC), deleted, author {kind, handle `<channel>:<value>`, display}, text (cut at 65 536, `truncated`), attachments (metadata, at most 32), `untrusted: true`. Cursor paging forward and backward, `anchor`, `exhausted`, `retryAfterS`, at most 200 rows and 2 MiB per page.
- Every page is validated against the vendored schema before it is returned. A mismatch answers `data_contract_violation` (500) and is logged without message text.
- Person operation `account_app_share {account, product, level: none | available | shared}` and, in Accounts, "Share with <app> (read only)" for each chat account (Knowledge, Observer). Default none. `available`: catalog only (names, kinds, approximate counts, history flag; no message text). `shared`: `data_pull` too. An app sees only accounts shared with its product. Every account an app cannot see answers the same `not_found`. `accounts_overview` lists the shares and the apps one can share with.
- Contract files `test/contracts/messages.1.schema.json` and `messages.1.json` (sha256 in `test/contracts/PROVENANCE.md`); the runtime schema `src/contracts/messages.1.schema.json` is a second byte copy (the image has no `test/`).
- Migration 0010: the inbound log gets `rev` (change counter), `edited_at`, `deleted` and `attachments`; tables `connect_inbox_rev` and `connect_account_shares`. Existing rows get `rev = seq`. There is no down migration; a failed update is rolled back by the SDK pre-update snapshot.

### Review changes (C230 review of PR #13)
- Fail closed: the calling app is identified by the verified caller product, never by its manifest name. The name table `src/data/apps.ts` is gone.
- Edits and deletions come from the providers: Slack and Discord (both), Telegram (edits only; `deletions: false`). Teams is parsed but reports neither in `data_catalog` (`edits: false, deletions: false`: Teams sends the activities only in some installations). Where `deletions` is false a deleted message keeps its text for apps until the 30-day purge. An edit or deletion of a message that is not in the log is dropped and counted (`unmatchedChanges` in `channel_accounts`), never stored as a row. An edit is ordered and idempotent (a replay or an older edit takes no new rev).
- A share starts when it is made: `data_pull` returns only messages received at or after it, unless `account_app_share` has `includeHistory` (UI: "Include the last 30 days").
- A stored row that does not fit `messages/1` is quarantined (skipped, counted, logged with its rev) instead of blocking the account.
- `account_app_share` has a receipt; every data call (`data_accounts_list`, `data_catalog`, `data_pull`) writes one audit line, refused calls too (op, outcome, caller, product, account, dataset, row count; no text).
- Cursors are per account (per-account sequence, cursor names its account).
- Author kind `bot` where the provider says so. Rows of other bots are stored (flagged) only while the account has an app share, and are never listed for agents.
- UI: the share control re-reads the list after every save.
- Migration 0011: per-account `rev` (renumbered in one pass with a window function and `UPDATE ... FROM`: 200 000 rows in about 0.2 s), `sender_is_bot`, `include_history`, `unmatched_changes`, an index on `received_at` for the purge, `connect_account_rev`, `connect_data_audit`; the global counter table of 0010 is dropped.

### Review fixes (PR #14)
- Audit fails closed: a served `data_accounts_list`, `data_catalog` or `data_pull` writes its audit line BEFORE the answer is returned. When the line cannot be written the call answers 503 `audit_unavailable` and sends no data (before: the data went out and the failure was only logged). A refused call stays refused.
- Refused calls are throttled: the same caller, product, op and code write one audit line per minute; further ones raise `repeats` on that line (migration 0012). A served call always has its own line.
- Owner op `data_access_log` and, in Accounts, "Recent access": the last 100 calls, newest first (app, request, time, account, messages, served or refused). No message text. The record is kept 90 days.
- Accounts: under each app row, one plain sentence says what that level gives the app: every conversation of the bot; only messages from the share time on unless "Include the last 30 days"; names and counts of every conversation for the whole log at the catalog level; revoke at any time.
- Recent access shows a caller without a verified product as "Unverified app" (refused `caller_unverified`).
- The unused `DATA_OPS_VERIFIED_PRODUCT_SUPPORTED` constant is removed.
- **Do not roll back from 0.6.0 to 0.5.11.** Migrations 0010 to 0012 have no down step. A downgrade to 0.5.11 followed by a new upgrade leaves the log rows written in between hidden (their `rev` stays NULL), so an app would never see them. Restore the pre-update snapshot instead, or move forward.

### Changed
- `channel_reply` to a message that was deleted answers 404 `channel_message_unknown` (a deleted message is no longer in the agent inbox). Accepted.
- `channel_inbox` returns a `nextSeq` that moves past rows it hides (deleted messages, other bots' messages), so the next call does not scan them again.
- Disconnecting an account removes its app shares.
- `channel_inbox` (agents) no longer lists a message that the provider deleted.
- Dependencies: manifest 0.1.19 (was 0.1.18; `validateAgainstSchema`, `normalizeHandle`); miniapp-sdk, spec, conformance and ui unchanged. Lockfile integrity re-pinned.

### History in this phase
- No provider has a history reader in Connect yet. The inbound log (kept 30 days; apps need at least 7) is the only record. `data_catalog` says `history: false` for Slack, Teams, Telegram and Discord, and a backward pull answers `exhausted: true` with no rows. A forward pull from the start returns everything the log holds. Telegram bots are live-only.
- Attachment metadata is supported by the log and the contract, but no inbound parser fills it yet.
- Buzz is not a connected account and is not part of the dataset in this phase.

### Gaps
- Calls the SDK itself rejects (bad grant, `grant_invalid` on a `prd`/slice mismatch, paused, stale slice) never reach a handler, so they are not in the access list. By design.
