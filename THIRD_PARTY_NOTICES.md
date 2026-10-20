# Third-party notices

This app's own code is Apache-2.0 (see `LICENSE` and `NOTICE`). It includes the software and assets below under their own
licences. Update this file when you add a dependency, a vendored file or a companion image.

## Vendored into the built UI (`dist/ui`)

The UI build (`scripts/build-ui.ts`) copies these files into the app image.

| Name | Version | Licence | Source |
|---|---|---|---|
| React (`react`) | 19.3.0 | MIT | https://github.com/facebook/react |
| React DOM (`react-dom`) | 19.3.0 | MIT | https://github.com/facebook/react |
| `scheduler` | 0.28.0 | MIT | https://github.com/facebook/react |
| `@opt2-tealbrick/ui` (Tealbrick design system kit: tokens, components, CSS) | 0.2.4 | MIT | https://github.com/Martin-Atrin/opt2-tealbrick-packages |
| `@opt2-tealbrick/miniapp-sdk/client` and `@opt2-tealbrick/spec/sdk` (browser modules only) | 0.1.36 / 0.1.52 | MIT | see the next section |
| Nunito (variable font, `vendor/@opt2-tealbrick/ui/dist/fonts/*.woff2`) | 5.3.0 (`@fontsource-variable/nunito`) | SIL Open Font License 1.1 | https://github.com/googlefonts/nunito |

- Nunito is Copyright 2014 The Nunito Project Authors. Its licence text ships next to the font files as
  `vendor/@opt2-tealbrick/ui/dist/fonts/OFL.txt`.
- The Tealbrick brand mark and the app stills (`stills/*.webp`, from `@opt2-tealbrick/ui` `assets/`) are Tealbrick
  artwork. They are **not** covered by the Apache-2.0 licence of this app and are not licensed for reuse outside
  Tealbrick products.

## Runtime dependencies in the image (production `node_modules`)

| Name | Version | Licence | Source |
|---|---|---|---|
| `@noble/curves` (Buzz / Nostr signatures) | 2.4.0 | MIT | https://github.com/paulmillr/noble-curves |
| `@noble/hashes` (Buzz / Nostr hashing) | 2.4.0 | MIT | https://github.com/paulmillr/noble-hashes |
| `undici` (pinned outbound HTTP) | 8.11.2 | MIT | https://github.com/nodejs/undici |
| `@opt2-tealbrick/miniapp-sdk` | 0.1.36 | MIT | https://github.com/Martin-Atrin/opt2-tealbrick-sdk |
| `@opt2-tealbrick/manifest` | 0.1.28 | MIT | https://github.com/Martin-Atrin/opt2-tealbrick-sdk |
| `@opt2-tealbrick/spec` (dependency of the SDK; the SDK pins the same release) | 0.1.52 | MIT | https://github.com/Martin-Atrin/opt2-tealbrick-specs |
| `ajv` (dependency of the manifest package) | 8.17.1 | MIT | https://github.com/ajv-validator/ajv |
| `fast-deep-equal` (ajv) | 3.1.3 | MIT | https://github.com/epoberezkin/fast-deep-equal |
| `fast-uri` (ajv) | 3.1.8 | BSD-3-Clause | https://github.com/fastify/fast-uri |
| `json-schema-traverse` (ajv) | 1.0.0 | MIT | https://github.com/epoberezkin/json-schema-traverse |
| `require-from-string` (ajv) | 2.0.2 | MIT | https://github.com/floatdrop/require-from-string |

## Services and companions (not bundled in the image)

- **Composio.** Connect talks to the hosted Composio REST API (`backend.composio.dev`) with the owner's own Composio API key.
  No Composio SDK or Composio code is bundled or vendored. Composio is a third-party service under its own terms
  (https://composio.dev). The tool-name patterns in `policies/composio/*.json` are Connect's own classification of
  tool names (read, write, outward, destructive); they contain no Composio source code.
- **Tealbrick catalog of self-hosted apps** (`catalog-0.3.1`, release asset of this repository, pinned by sha256 in
  `tealbrick.manifest.json` `artifacts[]`). Downloaded at run time, not part of the image. It holds API descriptions of
  third-party self-hosted apps. Each entry keeps the name of its upstream app; the upstream apps and their API
  descriptions stay under their own licences.
- **MCP servers and chat services** (Slack, Microsoft Teams, Telegram, Discord, Buzz / Nostr relays) are reached over the
  network with the owner's own credentials. None of their code is included.

## Base image

`node:24-slim` (Dockerfile): Node.js (MIT, with bundled components under their own licences) on Debian (the licences of
its packages are in `/usr/share/doc/*/copyright` inside the image).

## Development only (not shipped)

TypeScript, Biome, `@types/*`, happy-dom and `@opt2-tealbrick/conformance` are used to build and test the app and are
not part of the image.
