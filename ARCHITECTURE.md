# Connect (Tealbrick mini app): architecture

State: verified against the repo on 2026-10-17. Claims cite paths in this repo. Anything not verified is marked UNVERIFIED. For the whole system see the system `ARCHITECTURE.md` and `SYSTEM-OVERVIEW.md`.

## Common app pattern (verified for this repo on 2026-10-17)

- **Runtime**: Node 24, TypeScript run through `tsc` to `dist/`, UI built by `scripts/build-ui.ts` (no bundler). Connect writes a flat `dist/ui/`; it does not adopt the template's content-hashed `assets-<hash>/` directory (header of `scripts/build-ui.ts`). The app is started by `startApp` from `@opt2-tealbrick/miniapp-sdk` (`src/main.ts`).
- **Dockerfile**: two stages on `node:24-slim` pinned by digest, `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm run build && pnpm prune --prod`, the manifest also copied to `/opt/tb/tealbrick.manifest.json` (the `tb-exec` default), `USER node`, no `VOLUME`. The SDK drops root to uid 1000 itself when the platform starts the container as root (Railway volumes are root-owned).
- **Data**: one SQLite file `TB_DATA_DIR/app.db` owned by the SDK. App tables use their own prefix; SDK tables use `tb_*`. On Railway there is ONE volume per service: the backup directory is `<data mount>/backup`, so the volume size is data plus backup (C28).
- **Migrations**: `migrations/NNNN_name.sql` (or `.ts` exporting `up(db)`). The SDK enforces forward-only: gap-free from 0001, one transaction each, sha256 recorded in `tb_migrations`. A changed, missing, misnamed or `down` migration stops the app with `migration_invalid`.
- **Backups and restore**: SDK cron runner writes `tb-backup-<UTC>.tar.gz`; export `tealbrick.export/1` never carries the instance key, KEK, keys, secrets or sessions. Restore at next boot with `TB_RESTORE_FROM`.
- **Authorization**: the bridge gates (`gate()`); the SDK decides (`authorize()`): run, hold or refuse. Holds and receipts live in the app's own `tb_receipts` table. Raw call input is never stored, only a digest.
- **Manifest** `tealbrick.manifest.json` is the only source for operations, scopes, settings, hooks, companions, skills, runtime hints, backups and UI paths. Schema `tealbrick.miniapp/2`, `sdkMajor 1`, `source.license Apache-2.0`. Agent ops become MCP tools `<product>__<op>`. Person ops are owner UI only.
- **Generated**: `gen/` (openapi, kit, docs, railway) is produced by `tb-gen` and is not committed. The typed client kit is built into `dist/kit` and imported as `#kit` in apps that have one.
- **Standard UI pages** (from the kit `AppShell`): Holds, Receipts, Agents and scopes, Keys (where the app has keys), Backups and export.
- **Licence files**: `LICENSE` (Apache-2.0), `NOTICE`, `THIRD_PARTY_NOTICES.md`. The brand mark and app art are Tealbrick artwork and are not Apache-licensed.
- **Private by design**: no public address. Only the bridge is public.

## Connect: what it does

Connect is the one place for outside connectivity (C16 and the PRD). Per connected account the owner sets a tier: read, read/update, read/update/delete. Both kinds exist: "as me" (the agent uses the owner's account) and "as itself" (the agent's own identity, for example its Buzz identity). Tools are dynamic: search, then call. A send to a new recipient answers `first_contact_required` and the agent calls the `__first_contact` variant, which is held.

## Operations (from `tealbrick.manifest.json`)

46 operations.
- Read (agent): `tools` (dynamic, per account), `accounts_list`, `buzz_identity`, `buzz_channels`, `buzz_read`, `identities_list`, `buzz_scheduled`, `channel_inbox`, `channel_conversations`.
- Write (agent): `buzz_schedule_cancel`.
- Outward, hold family `outward`: `buzz_post`, `buzz_dm`, `buzz_react`, `buzz_edit`, `buzz_schedule`, `channel_send`, `channel_reply`, `channel_dm`, `channel_edit`, `channel_react`.
- Outward, hold family `first_contact`: `buzz_dm_first`, `channel_dm_first`.
- Destructive, hold `destructive`: `buzz_delete`, `channel_delete`.
- Person: 8 reads (`services_search`, `accounts_overview`, ...), 13 writes (`account_connect`, `catalog_account_connect`, `mcp_account_connect`, `buzz_identities_generate`, `channel_account_connect`, `sender_identity_set`, ...), and `buzz_profile_publish` (outward, hold family `identity`).
- Dynamic tools resolve per tool to read, write, outward, destructive or money. Unknown verbs classify fail-CLOSED (write or outward; payment is money, always held) (SEC-02). Hold view binding for send tools: account, recipients or channel, subject, first 500 characters as plain text, attachment names and sizes (`src/hold-view.ts`, C201).

## Scopes, hooks and companions

- **Scopes:** One scope type, `account` (access `read`, `read_update`, `read_update_delete`, `apps_only` which agents cannot use). Default grant: shared maps to `apps_only`.
- **Hooks:** None.
- **Companion grants it asks for:** None asked. Other apps call Connect: Inbox calls `buzz_dm`, `buzz_dm_first`, `channel_dm`, `channel_dm_first`; Fleet calls `identities_list`.

## Settings, keys and environment

Setting `buzz_relays` (up to 8 `wss://` lines, optional) becomes `CONNECT_BUZZ_RELAYS`. Key `COMPOSIO_API_KEY` (account default, optional). `TB_DATA_DIR` (default `/data`) holds the catalog cache. `CONNECT_BUZZ_RELAY_URL` is a removed setting; its presence is reported as an owner error. `.env.example` lists `CONNECT_DATA_DIR` and `CONNECT_SECRET_ENCRYPTION_KEY`; no code reads them (stale). The Dockerfile does NOT set `TB_DATA_DIR` or `TB_BACKUP_DIR`; the deploy recipe sets them (SDK-API section 13; `tb-gen railway` sets both).

## Data

- **Stored:** Migrations 0001 to 0009: `connect_accounts`, `connect_states`, `connect_tools`, `connect_buzz_identities`, `connect_agents`, `connect_buzz_contacts`, `connect_buzz_sent`, `connect_buzz_scheduled`, `connect_buzz_agent_relays`, `connect_channel_bots`, `connect_channel_conversations`, `connect_channel_inbox` (inbound chat text, 30 days), `connect_channel_sent`, `connect_channel_contacts`, `connect_senders`, `connect_tool_contacts`, `connect_tool_owner_reads`. SEALED in `ctx.secrets`: Buzz secret keys, channel credentials (Slack, Teams, Telegram, Discord), catalog API-key credentials, MCP server auth headers and OAuth tokens.
- **Never stored:** Composio OAuth material (Composio holds it; Connect keeps only the connected account id and a Composio user id equal to the workspace id), tool-call inputs beyond receipt digests.

## External calls and background work

- **External:** `backend.composio.dev/api/v3.1` (key sent only to `*.composio.dev`); Buzz relays chosen by the owner (HTTP query and events with NIP-98 signing); Slack API and Socket Mode; Telegram API; Discord API and gateway; Microsoft Bot Framework (Teams); the catalog artifact from a GitHub release (sha256 verified, cached); user-supplied catalog base URLs and remote MCP servers (https, public addresses only, DNS-pinned, no stdio). No LLM calls. All outbound traffic uses the pinned-connect fetch with a public-address policy (`src/util/net-policy.ts`, `pinned-fetch.ts`).
- **Background:** `onStart` starts channel inbound workers (Slack socket, Discord gateway, Telegram long poll; restart backoff 5 s to 5 minutes), tethers Buzz identities for known agents, and runs a 15 s timer that purges old channel inbox rows and posts due scheduled Buzz posts (claim as `sending`; a stale `sending` over 10 minutes is marked failed and never re-sent; at most 50 scheduled per agent; the agent must still be in the slice and not paused).

## Person UI

Services, Accounts, Buzz, Chat bots, Senders, Holds, Receipts, Agents and scopes, Keys, Backups and export (`src/ui/main.tsx`).

## Requirements and runtime hints

A Composio key only if Composio services are used. Buzz relays only if Buzz is used. Public routes (3, unauthenticated by design): `/oauth/composio/callback`, `/oauth/mcp/callback`, `/inbound/teams` (Bot Framework JWT verified, 128 KiB cap). A catalog artifact `catalog-0.2.0` (sha256 pinned in the manifest).

Port 8314. 0.5 cpu, 512 MB. Data 2 GB plus backup 5 GB declared as two volumes; Core and the generated Railway recipe merge them into one volume at the data mount (SDK-API 7.3; `TB_BACKUP_DIR=/data/backup`). Needs a non-sleeping container (long-lived outbound sockets). Backup cron `23 3 * * *`, retain 14. `EXPOSE 8314`.

## Pinned packages

Stable 0.5.10: miniapp-sdk 0.1.24, spec 0.1.35. Main (0.5.11): miniapp-sdk 0.1.25, spec 0.1.39. Both: manifest 0.1.18, conformance 0.1.18, ui 0.2.4. Also `@noble/curves`, `@noble/hashes`, `undici`.

All `@opt2-tealbrick/*` pins use dist-host tarball URLs. Upgrade safety (SDK 0.1.25: pre-update snapshot, migration lock, failed mode) is in this app only where the pin above says 0.1.25 (dev channel, RS-3 candidates). The other apps re-pin in RS-3 (dev channel first, stable after the qa1 soak). Core main (portal-core#1, E3) restores the snapshot on an automatic rollback, but that Core is not live yet (it goes live with RS-3, per the portal-core README). Until then Core can roll back an update only as an image (no data restore).

## Known gaps

- Dockerfile comment says `TB_DATA_DIR=/data` but the image does not set it.
- A conformance waiver `A3.caps_count` is live until conformance 0.1.19 (the pinned suite is 0.1.18).
- Telegram, Discord and Slack code paths were exercised mostly in unit tests; live checks of cross-agent chat-bot messages need a bot token (UNVERIFIED).