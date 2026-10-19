# Connect (Tealbrick mini app)

Everything an agent reaches outside the workspace: Composio (Gmail, Calendar and 1,000+ apps), a Tealbrick catalog of self-hosted app connectors, custom remote MCP servers, Buzz (Nostr) identities per agent, and chat channels (Slack, Teams, Telegram, Discord). Built on the Miniapp SDK.

**Status:** stable 0.5.10; `main` is 0.5.11 (dev channel until promoted). Visibility: public, Apache-2.0. Published as the public GHCR image `ghcr.io/tealbrick/opt2-tealbrick-connect` (on 2026-10-17 its version tags are the dev build `0.5.11-dev.1` and a `sha-` tag; there is no `0.5.10` tag in that registry). The largest of the apps (about 11,000 lines in `src/`).

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
| `src/sources/composio/` | Composio client (key sent only to `*.composio.dev`), verified connect flow, tool sync, policies (`policies/composio/`). |
| `src/sources/catalog/` | Tealbrick catalog source (OpenAPI-based connectors; user-supplied base URLs). |
| `src/sources/mcp/` | Custom remote MCP servers (https, DNS-pinned) and their OAuth flow. |
| `src/channels/buzz/` | One Buzz (Nostr) identity per agent, created when the agent reaches Connect's slice (the owner can also create all in one action); sealed keys; allowlisted signing. Several relays: the workspace setting `buzz_relays` (the old single `buzz_relay_url` was removed in 0.5.2; its presence is reported as a clear error), a per-agent subset in the database, publish to all and read from all with dedupe, per-relay results (`relays.ts`). |
| `src/channels/` | Chat channels: Slack, Teams, Telegram, Discord providers, registry and service. |
| `src/util/` | Pinned fetch, network policy, redaction, ids. |
| `src/ui/` | React person UI. |
| `migrations/` | 9 forward-only migrations. Never edit a released file. |
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
4. Core deploys the newest stable version when the owner installs or updates the app. Core main (portal-core#1, E3) switches to the new version only after a health check and rolls back when it fails; the live Core does not have this yet (it goes live with RS-3, per the portal-core README).

The catalog artifact (`catalog-0.2.0`, sha256 pinned in the manifest) is built with `pnpm catalog:build` and attached to a GitHub release. 0.2.0 = the 12 v1 Company Box entries + Mautic (13 entries), built with `--from <v1 company-box> --from <staged entries> --version 0.2.0 --forbid-file <operator host list>`; the operator host list is kept outside this public repo. The same bytes are in `test/fixtures/catalog/` for the tests.

## Dependency pins

- `@opt2-tealbrick/*` dependencies are pinned as tarball URLs on the dist host (`Tealbrick/opt2-tealbrick-dist` releases). `pnpm-lock.yaml` carries the sha512 integrity of every such tarball. After changing one, run `pnpm install`, then `node <opt2-tealbrick-platform>/ci/tb-ci.ts pin-tarballs .`, then `pnpm install --frozen-lockfile`, and commit the lockfile. Image builds run `pnpm install --frozen-lockfile --ignore-scripts`.
- `pnpm build` writes the UI to a flat `dist/ui/` (`index.html`, the compiled modules and `vendor/`). `scripts/build-ui.ts` does not adopt the template's content-hash directory, so the SDK serves every UI file as `no-cache` and a deploy is visible at once.

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md): design of this app (operations, scopes, data, background work).
- [`CONTRIBUTING.md`](CONTRIBUTING.md): how to change it.
- Runtime contract: `docs/SDK-API.md` in `Tealbrick/opt2-tealbrick-specs`. UI kit: `Tealbrick/opt2-tealbrick-packages`.
- System documentation (overview, environments, runbooks) lives in the private repo Tealbrick/opt2-tealbrick-docs.
