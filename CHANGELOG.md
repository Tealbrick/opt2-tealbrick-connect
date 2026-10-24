# Changelog

Versions follow `package.json` and `tealbrick.manifest.json` (product id `connect`). Current version: 0.6.3 (catalog 0.3.1; C331 demo gaps).

## 0.6.3 (prepared 2026-10-24; normal path)

C331 (10): gaps found while building the DEV second-brain demo (coordination/leads/demo/DEMO.md gaps 4, 5, 6). No migration, no catalog change; one owner-confirmed class change (D4b). Tool classes re-sync on start (`c331-1`).

- **Gap 4, refusal text:** `mcp_tool_read_set` named the wrong reason for a money-named tool ("The server does not say this tool is read-only" although the server did, e.g. `stripe_list_charges` with `readOnlyHint: true`). The refusal now says the real reason: a money name (money tools are always held, CORE §7), the server's `destructiveHint`, a tool that is already read, or no read-only claim. Classes from names and hints are unchanged (X-03: a server's claims only raise a class).
- **D4b (Coordinator OK 2026-10-24), money records:** the owner may confirm READ, per tool, for an MCP tool the server marks read-only (no `destructiveHint`) whose name only reads money records: a read verb, then record nouns (`stripe_list_charges`, `get_refund`, `export_payments`). Never automatic: until the owner confirms, the tool is money (always held). Anything else with a money word stays money: a second action or connector word (`list_and_refund_charges`, `list_charges_then_capture`, `listChargesAndPay`), a money verb (`create_charge`, `refund_list_charges`), a singular before more words (`list_charges_refund`, `get_charge_status`), a compound word (`list_paymentintents`), a non-ASCII letter. A refresh where the server no longer claims read-only makes it money again. The confirm card says "Reading moves no money"; every confirm and withdraw is a receipt (`mcp_tool_read_set`).
- **Gap 5, Accounts > Agent access:** an owner-set READ level said "takes effect after a future bridge update" although READ calls work at once. For READ it now says "<agent> can read this account now where its Portal grant includes read"; the future-bridge text stays for the higher levels while the bridge does not admit owner rows.
- **Quality audit R2 (2026-10-24), inbound messages are never lost silently:** a Slack, Discord, Telegram or Teams message that Connect cannot store (a database error) was swallowed after it was acked and deduped (Telegram's offset had already moved on). Now the hub writes one error log line (metadata only), counts it per account (`channel_accounts` → `bot.notStored`) and the bot's inbound detail says it; then the provider lets the platform send it again: Slack acks an event only after it is stored (an unacked event is redelivered and not deduped away), Telegram keeps the offset on that update and fetches it again after a backoff (passed after 5 tries), a Teams webhook answers 503. The Discord gateway does not redeliver; the count is the record.
- **Gap 6, Accounts heading:** a custom MCP server's group was headed by its internal service id ("mcp_acme_data_sources__282ebac3", derived from the host). It is now headed by the account label (several accounts on one server: the first label plus a count). Other services keep their name; element ids are unchanged.

## 0.6.2 (prepared 2026-10-20; normal path, 24 h soak)

### Catalog semantics (rest of the v1 sweep)
- **CF-CT-1:** a JSON request body is sent with its declared media type (plain `application/json` first, else the first JSON type the spec declares, e.g. `application/merge-patch+json`). API Platform PATCH (Mautic v2) works.
- **Mautic v2 PATCH is back** (28 ops, per-method `[update]`; campaigns, events, contacts, segments, sms, notifications, messages, triggers, trigger events and reports are outward). v2 PUT stays excluded (it blanks omitted fields); webhook PATCH stays excluded (outbound URL); users, roles and permissions stay excluded.
- **WebDAV methods** (v1 `x-<method>` keys): PROPFIND = read (Depth at most 1), MKCOL = create (a folder), COPY = create, MOVE = the destructive class `[update, delete]` (it removes the source; held by default). MOVE and COPY always send `Overwrite: F`. The `Destination` header is built from the spec's `x-destination-template` with the CF-NC-2 guards: a relative path under the same origin, prefix and user root; `..`, a leading `/`, empty segments and a full URL are refused. REPORT and PROPPATCH need an XML body and stay unavailable; LOCK/UNLOCK are not offered. 16 Nextcloud WebDAV ops.
- catalog-0.3.1 (Mautic entry change). Review #20: Mautic emails (POST, PATCH, v1 edit), forms, pages and focus items are `outward` (broadcast email, form emails to any address, public HTML and redirects): 5 existing ops change class from write to outward (CRUD unchanged); everything else only adds ops (snapshot `classes-0.3.1.json`). MOVE/COPY no longer offer an `Overwrite` input (it is always F). compile and send use the same JSON-type test.

## 0.6.1 (prepared 2026-10-20; tagged after 0.6.0 is stable)

### Catalog 0.3.0 (15 entries)
- New: **Frappe CRM and Helpdesk** (`frappe-crm`, 65 ops: read 30, write 21, outward 4 = CRM email, ticket reply, ticket create/update that can mail the customer; destructive 10 = deletes, bulk delete, ticket merge). Token auth `token <key>:<secret>` for a dedicated API user with CRM/Helpdesk roles only. Staged by the Agents lane (provenance in coordination/leads/connect/catalog-staging/frappe-crm).
- New: **Umami** (`umami`, 34 ops, all read: stats, metrics, events, sessions, report queries). No collection, login, admin, user/team or `/api/me` (it echoes the token). Auth: a long-lived read-only login token of a dedicated "View only" user (Umami 2.19 has no API keys).
- The 13 existing entries are unchanged (same tool classes, snapshot `test/fixtures/catalog/classes-0.3.0.json`).
- **C276c (customer email = a send):** an entry's `firstContact` puts its email/message ops through first contact with the recipients from the input: Frappe `crm_send_email` (recipients/cc/bcc), `hd_reply_to_ticket` (to/cc/bcc), `hd_ticket_create` (raised_by, contact, customer). The first field is the primary recipient: when it is empty the call is held. Every email-like token counts, so a display name cannot hide an address; the hold view shows the recipients, subject and text; a label on a missing or non-outward op refuses the entry. `hd_ticket_update` can mail the stored customer, which the input does not name: every call is held as a first contact. Migration 0015 (`connect_tools.send_recipients`); tool classes re-sync on start (`c276c-1`).
- **QA-CON060-1:** the current bridge still caps a call at the Portal grant, so an owner-set access above the grant (C283 A1) has no effect until a future bridge update (the bridge capability `owner_rows`, C292a). Accounts > Agent access now says "Your setting is saved. It takes effect after a future bridge update; until then the Portal grant still limits <agent>", and the accounts_list hint no longer tells the agent to ask for a Connect setting. Connect cannot read the bridge version yet (it will read the bridge capability `owner_rows`, never a version number); until then the flag is off.
- An upstream HTML error page reaches the agent only as its title; other error text loses its tags (QA INFO).
- **CF-NC-2 (S2):** Nextcloud files inside folders can be read and deleted. A path parameter marked `allowReserved: true` or `x-multi-segment: true` (v1 flag; the Nextcloud WebDAV `{path}` / `{item}`) may span "/": each segment is checked and percent-encoded on its own. A leading "/", empty, "." and ".." segments (also as %2e) and backslashes are refused; a "%2F" typed inside a name stays part of it. Every other path parameter is still one segment.
- The connect form shows the entry's `credentialHint` (Umami: "a dedicated View-only user"; Frappe: "a dedicated API user with CRM and Helpdesk roles only").

## 0.6.0 - 2026-10-20 (release 2)

Release 2 = the C240/R3 work below plus:

### Security
- **CF-GC-1:** Connect 0.5.x lets a calendar invite to a NEW person run with no hold (calendar tools were not send tools). Now outward tools that name an invite object (event, meeting, appointment, booking, calendar) go through first contact: a new external attendee is held `first_contact`; known attendees run; an event with no attendees runs.

### Access (C276a, C283 A1, C283d; miniapp-sdk 0.1.36)
- Per-method CRUD (C276a): a POST on a listed collection needs only `create`, PUT/PATCH only `update`, DELETE only `delete`. Actions, RPC-style paths, sends, imports and access/identity objects keep `[create, update]`; the new set is always a subset of the old one; effect and hold family never change. 470 of the 3236 catalog-0.2.0 ops need less (`test/fixtures/catalog/crud-diff-c276a-0.2.0.md`). Authentik keeps the full set.
- Tool rows are re-made on start when the classifier, the catalog or the Composio policies change (migration 0014, `connect_meta`): no more "Refresh tools" after an update.
- `accounts_list.hints[]`: no account assigned to you, tools that need more than your Portal grant allows, tools above your account access.
- Accounts > Agent access: a level the owner sets is the agent's own access, also above its Portal grant (C283 A1). Older rows say the Portal grant may allow less, with "Use this access". A widened level shows its offer and needs the owner's "Accept" (C283d). Levels are named Read / Read + create + update / Full (+ delete).
- Dependencies: miniapp-sdk 0.1.36 (0.1.35 skipped, C283c), manifest 0.1.28, spec 0.1.52, conformance 0.1.25 (A20/A21 rows pass with a harness-only fixture).

## 0.6.0 (C240/R3 part, prepared 2026-10-18)

The shared data operation family and the dataset `messages` (request R3, knowledge S-9; decisions C230 and C169). Not tagged: the lead decides the tag.

### Data sharing works for apps the owner shares with (C230 R3, SDK-CALLER-PRODUCT; with miniapp-sdk 0.1.32, pinned before the tag)
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

### A share is bound to one installed app (C240, SDK-COMPANION-CALLERS)
- `account_app_share` takes `instance` (required unless `level` is `none`). The owner picks it from the installed apps that can call Connect (`ctx.companionCallers()`, person ops, miniapp-sdk 0.1.32 / spec 0.1.48). An instance that is not listed for that product is refused `app_instance_unknown` (404); no instance is refused `instance_required` (400). An SDK without the function lists nothing, so no share can be made (fail closed).
- A data call is served only when its verified product AND its instance id (`ctx.caller.id`, the verified grant subject) are the pair the owner shared with. Another instance of the same product gets the same `not_found` as an unshared app. A reinstalled app has a new instance id and needs a new share. Nothing is bound on a first call.
- Migration 0013 adds `connect_account_shares.instance_id`. A share made before it (pre-release 0.6.0 builds only; 0.5.11 has no app shares) has no instance and serves nobody. Accounts shows it as "Not shared" with "Share again — this app must be chosen again after the update" on its row, and one notice at the top of the page counts these shares; it is never silently gone.
- Accounts: when two instances of an app are installed the owner picks which one; an app that is not installed says so; an instance on the owner's own server (provider `own_infra`) is named, with "Connect cannot check the code that runs there".
- `accounts_overview`: `dataApps[].instances` (`instance`, `name`, `provider`, `ownInfra`), and per share `instance` and `current`.

- Call-time check (Coordinator, C240): every data call needs the caller to be STILL listed under its product in the current signed slice (`ctx.caller.listed`, miniapp-sdk 0.1.32). `false` = 403 `share_instance_gone`, no flag = 503 `companion_list_unavailable` (fail closed); both audited and retryable (`details: {retryable: true, retryAfterMs: 30000}`), so a fresh companion whose grant arrives before the slice lists it retries instead of failing hard. A removed app with a still-valid grant reads nothing.
- Review fixes (C240 review): a share whose instance is no longer listed says "This app instance was removed; it can no longer read", keeps its level read-only, and has "Stop sharing" and "Share with the installed <app> instead" (the button and a note name an own-server target). Pre-0013 rows: "Share again" only when sharing is possible; the page notice counts connected chat accounts only. Moving a share to another instance unticks "Include the last 30 days". The instance picker shows where each instance runs and the end of its id. The receipt names the instance and "(your own server)". `current` needs the same product. `accounts_overview.callersKnown` false (SDK without `companionCallers`) shows "Sharing with apps needs the next Connect update." One account is shared with at most one instance per app.
- **After the update, choose each shared app again:** shares made before migration 0013 stop serving at the upgrade until the owner picks the app again in Accounts ("Share again"). Released versions (0.5.11 and older) have no app shares, so this concerns pre-release 0.6.0 builds only.
- **A newly installed app may be refused for up to about 20 seconds until the workspace config reaches Connect; it retries by itself.** (Healthy links: about 1–6 s with one Core replica, about 20 s worst case with several; longer only when a link fails.)
- **Do not roll back from 0.6.0 to 0.5.x.** Migrations 0010 to 0014 have no down step, and SDK schema 10 (miniapp-sdk 0.1.36) refuses an older SDK without a restore (`sdk_schema_newer`). A downgrade to 0.5.11 followed by a new upgrade leaves the log rows written in between hidden (their `rev` stays NULL), so an app would never see them. Restore the pre-update snapshot instead, or move forward.

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
