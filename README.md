# Connect (Tealbrick mini app)

Everything an agent reaches outside the workspace: Composio (Gmail, Calendar and 1,000+ apps), a Tealbrick catalog of self-hosted app connectors, custom remote MCP servers, Buzz (Nostr) identities per agent, and chat channels (Slack, Teams, Telegram, Discord). Built on the Miniapp SDK.

**Status:** 0.7.11 = 0.7.10 + the `contacts_list` companion op for Governance (who each agent first-contacted, on which channel; G-5, C373). 0.7.10 = 0.7.9 + the Accounts page writes the instance scope row a tool share needs (`toolShares[].scopeRow`). 0.7.9 = 0.7.8 + an account can be shared with one Evolving Workflows instance for READ tools only (`account_tools_share`; C373 Jarvis). 0.7.8 = 0.7.7 + a hold policy per MCP server that only raises classes (`mcp_policy_get`, `mcp_policy_set`; C373 Jarvis T3). 0.7.7 = 0.7.6 + "bring your own API": an OpenAPI description becomes a service with held tools through the catalog compiler (`api_preview`, `api_add`, `api_remove`; C373 Jarvis T2). 0.7.6 = 0.7.5 + curated Composio policies for facebook, instagram, youtube, tiktok, tiktok_ads, metaads, whatsapp, highlevel, googlesheets and wordpress_com (uploads and publishing outward, ad spend money, monitoring reads stay reads; optional `money` list in a policy; C373 Jarvis). 0.7.5 = 0.7.4 + dataset `documents` from MCP servers and databases for apps (C373). 0.7.4 = 0.7.3 + readable hold cards for every dynamic tool (Postiz create-post card, generic labelled-lines card), the Postiz `__draft` form (a plain write for a new draft only) and a "More details" modal on hold cards (C368, C369). 0.7.3 = 0.7.2 + first-contact sends refused (`first_contact_approval_off`) when the owner holds every message but not first messages, and `channel_send` to a conversation Connect has never seen treated as a first contact (C354a). 0.7.2 = 0.7.1 + database accounts and their table catalog for apps (Postgres; C336 RQ-3; no row access yet). 0.7.1 = 0.7.0 + Buzz alerts decided by the recipient's signed ✅ / ❌ reaction (C343a). 0.7.0 = 0.6.3 + Approve / Deny buttons on companion apps' Slack and Telegram DMs, relayed to Operator Inbox (IN-2), conformance 0.1.29. 0.6.3 = 0.6.2 + clearer MCP read-only refusals and Accounts page wording (C331 demo gaps). 0.6.2 = 0.6.1 + CF-CT-1 (declared JSON types, Mautic v2 PATCH), WebDAV PROPFIND/MKCOL/COPY/MOVE (Nextcloud) and catalog-0.3.1. Visibility: public, Apache-2.0. Published as the public GHCR image `ghcr.io/tealbrick/opt2-tealbrick-connect`. The largest of the apps (about 11,000 lines in `src/`).

- Repository: `Tealbrick/opt2-tealbrick-connect` (GitHub organisation `Tealbrick`)
- Licence: Apache-2.0 for the app code (`LICENSE`, `NOTICE`); upstream licences are in `THIRD_PARTY_NOTICES.md`. The Tealbrick brand mark and app art are Tealbrick artwork and are not covered by the Apache-2.0 licence.

## No secrets policy

This repository is public. It must never contain secrets or personal data, and neither may its issues or pull requests:

- No API keys, tokens, passwords, private keys, deployment secrets, `.env` files or connection strings. Use `.env.example` with placeholder values only.
- Runtime secrets live in the deployment platform (Railway variables) and are copied between services without printing them.
- No personal names, private agent configurations or customer data.
- Every pull request and every push to `main` runs a secret scan (gitleaks, the `secret-scan` step in `.woodpecker/ci.yaml`). GitHub secret scanning and push protection are not enabled on this repository, so this CI step is the guard. Optional local guard: `pre-commit install` (`.pre-commit-config.yaml` runs gitleaks).
- If a secret is committed anyway: rotate it first, then remove it from history.

## What it does

Connect is the one place for outside connectivity. Per connected account the owner sets a tier: read, read/update, read/update/delete. Both kinds of account exist: "as me" (the agent uses the owner's account) and "as itself" (the agent's own identity, for example its Buzz identity). Several accounts per service are possible.

- Tools are dynamic: the agent searches (`connect__tools_search`), then calls (`connect__tools_call`). Unknown verbs classify fail-closed (write or outward); payment is money and always held.
- A send to a new recipient answers `first_contact_required`. The agent then calls the `__first_contact` variant, which is held for the owner.
- Secrets are sealed in the SDK secret store: Buzz secret keys, channel credentials, catalog API keys, MCP auth headers and OAuth tokens. Composio OAuth material stays at Composio.
- Outbound requests go through a pinned fetch with a public-address policy (https, public addresses only, no stdio MCP servers).
- Other apps call Connect: Inbox sends owner alerts through the Buzz and channel DM operations; Fleet reads `identities_list`.
- Connect calls one app: a press on an Approve / Deny button of an Inbox alert (Slack, Telegram) or the owner's signed ✅ / ❌ reaction on a Buzz alert is relayed to Inbox `item_decide_dm` (companion grant). Connect never decides; Inbox checks the one-time token.
- Data for apps (R3, unreleased): the owner shares a connected chat account with one app, read only (Accounts, "Share with <app> (read only)"; none by default). The shared operations `data_accounts_list`, `data_catalog` and `data_pull` serve apps only and answer the dataset `messages` (contract `messages/1`, frozen in spec-v0.1.42) from the inbound log of Slack, Teams, Telegram and Discord (kept 30 days). See ARCHITECTURE "Data operations for apps".
  - **Documents (C373, unreleased):** dataset `documents` (contract `documents/1`, DRAFT) from MCP servers (MCP resources only, never a tool) and databases (200 rows per CSV document, read-only transaction, secret-looking columns dropped). Shared with Observer directly; Knowledge reads these sources only through Observer (C322(6)). See ARCHITECTURE "Dataset documents".
  - **Databases (C336 RQ-3, 0.7.2):** the owner adds a Postgres database (Accounts > Databases; host, port, database, user, password, sslmode; sealed in Connect) and shares it with Knowledge or Observer at `available`: the app sees table and view names, columns, types and approximate row counts, never a value. Each database share has a route: `direct` or `via_observer` (only Observer reads it; Knowledge gets nothing for it). Use a dedicated read-only database user with SELECT only and no REPLICATION; Connect refuses a superuser or replication role and any non-public address. **A lease on the credential (the `data_lease` operation) is not offered** (rows are read only as documents, C373): it would answer the database password and the pinned spec cannot declare `secretOutput` (QA-CON24-1, C354a). The code is kept but has no manifest operation, no handler and no route (`src/data/lease-ops.ts`); leases return when Connect can declare `secretOutput` and the bridge and Core enforce `requires.bridgeCaps`. See ARCHITECTURE "Database accounts".
  - **What "available" reveals:** the app sees that the account exists (service, label), the dataset name, kind and contract, the approximate row count, the oldest message time, the retention, the `history`, `edits` and `deletions` flags, and the name, type and message count of each conversation. It sees no message text, no sender and no message id.
  - **What "shared" adds:** the messages Connect receives from now on. The owner can tick "Include the last 30 days" to add the log Connect already holds.
  - **Who is calling:** the data operations key on the VERIFIED caller product (`ctx.caller.product`, miniapp-sdk 0.1.28), never on the app's name. An app caller without a verified product is refused `caller_unverified` (403); a person or an agent is refused `no_access` (403). The share check, the share record and the audit line all use the product id.
  - **One installed app per share (C240):** a share is bound to the verified product AND the instance id the owner picked at share time, from the installed apps that can call Connect (`ctx.companionCallers()`, miniapp-sdk 0.1.32). A call is served only when its verified product and instance id are that pair. A reinstalled app has a new instance id, so the owner shares again; a share made before migration 0013 (only pre-release 0.6.0 builds; 0.5.11 has no app shares) has no instance and serves nobody until the owner chooses the app again (Accounts shows "Share again" on its row and one notice at the top). Every data call also checks that the calling instance is STILL listed under its product in the current signed slice (`ctx.caller.listed`, miniapp-sdk 0.1.32): a removed instance is refused `share_instance_gone` (403) even with a valid grant, and an SDK without the flag is refused `companion_list_unavailable` (503, fail closed). Both are retryable after 30 s, for a new app whose grant arrives before the workspace list does. Accounts shows such a share as "This app instance was removed; it can no longer read", with "Stop sharing" and an explicit move button. One account is shared with at most one instance per app. Nothing is bound on a first call. The share page names an app that runs on the owner's own server (provider `own_infra`): Connect cannot check the code that runs there.
  - **Edits and deletions, per provider:** Slack (`message_changed` / `message_deleted`) and Discord (`MESSAGE_UPDATE` / `MESSAGE_DELETE`) report both. Telegram reports edits only (`edited_message`): a Telegram bot is never told that a message was deleted, so `data_catalog` says `deletions: false`. Teams is parsed (`messageUpdate` / `messageDelete`) but Teams sends these activities only in some installations, so `data_catalog` says `edits: false, deletions: false` for Teams. Where `deletions` is false, a deleted message keeps its text for apps until the 30-day purge. An edit or deletion that names a message Connect never logged is dropped and counted (`unmatchedChanges` in `channel_accounts`); it never becomes a row.

## Language

New code is TypeScript (Node 24+). Swift only where the macOS app requires it.

## Quick start

```sh
corepack enable && pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck && pnpm lint && pnpm test
pnpm conformance      # tb-conformance against the real app, then scripts/conformance.ts (not release evidence; QA is)
pnpm build            # compiles with `tsc` and builds the UI
pnpm gen              # tb-gen: openapi, kit, docs, railway (gen/, not committed)
```

Run the person UI without a bridge: set `TB_STANDALONE=1` and `TB_DATA_DIR` to a scratch folder (standalone mode; operations answer 503 `no_bridge`). Outbound network access is needed for the external services above. `node src/main.ts` runs the sources directly for development. The app starts only on `@opt2-tealbrick/miniapp-sdk`.

## Layout

| Path | Concern |
|---|---|
| `tealbrick.manifest.json` | The only description of the app (operations, `account` scope with tiers, key requirement, public routes, catalog artifact pin). |
| `src/app.ts` | App definition for the Miniapp SDK: one handler per operation, the dynamic `tools` family, the Composio callback, events. |
| `src/accounts.ts` | Connected accounts (several per service). Per-agent access lives in the SDK scope store: read, read/update (incl. create/send), read/update/delete. Kind "as me" or "as itself". |
| `src/tools.ts`, `src/effect.ts` | Tool registry behind `connect__tools_search` / `connect__tools_call`; effect and tier classification. |
| `src/hold-view.ts` | What the owner sees when a send is held (account, recipients or channel, subject, first 500 characters as plain text, attachment names and sizes). |
| `src/senders.ts` | Workspace sender identities used for outgoing messages. |
| `src/data/` | The shared `data_*` operations (R3): `caller.ts` (the verified app product and instance; the owner's list of companion callers), `shares.ts` (which app is shared which account), `messages.ts` (dataset `messages`, cursors, quarantine, page validation), `documents.ts` / `table-documents.ts` (dataset `documents` from MCP resources and table pages, C373), `database.ts` / `database-service.ts` / `pg-driver.ts` (database accounts, the metadata-only catalog, the lease record and the Postgres client behind the `DatabaseDriver` interface). `src/contracts/` holds the frozen `messages/1` schema (byte copy, see `test/contracts/PROVENANCE.md`). |
| `src/sources/composio/` | Composio client (key sent only to `*.composio.dev`), verified connect flow, tool sync, policies (`policies/composio/`). |
| `src/sources/catalog/` | Tealbrick catalog source (OpenAPI-based connectors; user-supplied base URLs) and own APIs (`own-api.ts`: an OpenAPI description the owner adds, compiled with the same hold classes, C373 T2). |
| `src/sources/mcp/` | Custom remote MCP servers (https, DNS-pinned) and their OAuth flow. |
| `src/channels/buzz/` | One Buzz (Nostr) identity per agent, created when the agent reaches Connect's slice (the owner can also create all in one action); sealed keys; allowlisted signing. Several relays: the workspace setting `buzz_relays` (the old single `buzz_relay_url` was removed in 0.5.2; its presence is reported as a clear error), a per-agent subset in the database, publish to all and read from all with dedupe, per-relay results (`relays.ts`). |
| `src/channels/` | Chat channels: Slack, Teams, Telegram, Discord providers, registry and service. |
| `src/util/` | Pinned fetch, network policy, redaction, ids. |
| `src/ui/` | React person UI. |
| `migrations/` | Forward-only migrations (0001–0024). Never edit a released file. |
| `skills/connect-tools/SKILL.md` | The agent skill declared in the manifest. |
| `scripts/catalog-build.ts` | Builds the Tealbrick catalog artifact (sha256-pinned, scrubbed) that is attached to a GitHub release. |
| `scripts/conformance.ts` | Connect checks the real conformance suite does not cover (app files, Composio policies); `pnpm conformance` runs `tb-conformance app` first. |
| `scripts/build-ui.ts` | UI build without a bundler (tsc output + vendored modules + import map). |
| `conformance.start.ts` | Boots the app for `tb-conformance`. |
| `test/` | Unit tests (`node --test`). |
| `Dockerfile`, `tealbrick-ci.json` | Image (tsc to `dist/`, pnpm, manifest also at `/opt/tb`) and CI settings (kind `miniapp`, one image). |
| `.woodpecker/ci.yaml`, `.github/workflows/opt2-release.yml` | The opt2 CI template ci-v9.9, generated from `Tealbrick/opt2-tealbrick-platform`. Do not edit. |
| `gen/` | `tb-gen` output, not committed. |

## Configuration

The SDK reads only `TB_*` variables (SDK API section 13). The deploy recipe sets them: `TB_INSTANCE_ID`, `TB_ENROL_CODE`, `TB_BRIDGE_URL`, `TB_PORTAL_KEYS`, `TB_KEK`, `TB_DATA_DIR` and `TB_BACKUP_DIR`. Optional: `TB_LOG_LEVEL`, `TB_RESTORE_FROM`, `TB_STANDALONE`. The listen port is the manifest `runtime.port` (8314). The Dockerfile does not set `TB_DATA_DIR` or `TB_BACKUP_DIR`, so the deploy must provide them (`/data` and `/data/backup`: one volume per service).

App-specific:

- Setting `buzz_relays` (up to 8 `wss://` lines, optional) becomes `CONNECT_BUZZ_RELAYS`. `CONNECT_BUZZ_RELAY_URL` is a removed setting; its presence is reported as an owner error.
- Key `COMPOSIO_API_KEY` (account default, optional; needed only if Composio services are used).
- `TB_DATA_DIR` (default `/data`) also holds the catalog cache.
- The app needs a non-sleeping container (long-lived outbound sockets for channels and Buzz) and three unauthenticated public routes: `/oauth/composio/callback`, `/oauth/mcp/callback`, `/inbound/teams` (Bot Framework JWT verified).

## How it ships

1. Set the same version in `package.json` and `tealbrick.manifest.json`. Check `publisher` and `source.repo` in the manifest; the repository name must match the image name in `tealbrick-ci.json` (`opt2-tealbrick-connect`).
2. Tag `v<semver>` on a green pipeline and push the tag. Tags are immutable.
3. The release Action pushes the GHCR image and the kit tarball. `registry-sync` signs the index entry with the image digest and the manifest digest.
4. Core deploys the newest stable version when the owner installs or updates the app. Core (E3, live since RS-3) switches to the new version only after a health check and rolls back when it fails, restoring the pre-update data snapshot; the gate is "not worse than before" (C219). The full effect needs the app to run SDK 0.1.25, which holds for the dev channel builds today and for stable after their promotion.

The catalog artifact (`catalog-0.3.1`, sha256 pinned in the manifest) is built with `pnpm catalog:build` and attached to a GitHub release. 0.3.0 = the 12 v1 Company Box entries + Mautic + Frappe CRM/Helpdesk + Umami (15 entries; Chatwoot replaced by a Connect override that excludes admin-class ops), built with `--from <v1 company-box> --override-from <staged entries> --version 0.3.1 --forbid-file <operator host list>`; the operator host list is kept outside this public repo. The same bytes are in `test/fixtures/catalog/` for the tests.

## Dependency pins

- `@opt2-tealbrick/*` dependencies are pinned as tarball URLs on the dist host (`Tealbrick/opt2-tealbrick-dist` releases). `pnpm-lock.yaml` carries the sha512 integrity of every such tarball. After changing one, run `pnpm install`, then `node <opt2-tealbrick-platform>/ci/tb-ci.ts pin-tarballs .`, then `pnpm install --frozen-lockfile`, and commit the lockfile. Image builds run `pnpm install --frozen-lockfile --ignore-scripts`.
- `pnpm build` writes the UI to a flat `dist/ui/` (`index.html`, the compiled modules and `vendor/`). `scripts/build-ui.ts` does not adopt the template's content-hash directory, so the SDK serves every UI file as `no-cache` and a deploy is visible at once.

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md): design of this app (operations, scopes, data, background work).
- [`CONTRIBUTING.md`](CONTRIBUTING.md): how to change it.
- Runtime contract: `docs/SDK-API.md` in `Tealbrick/opt2-tealbrick-specs`. UI kit: `Tealbrick/opt2-tealbrick-packages`.
- System documentation (overview, environments, runbooks) lives in the private repo Tealbrick/opt2-tealbrick-docs.
