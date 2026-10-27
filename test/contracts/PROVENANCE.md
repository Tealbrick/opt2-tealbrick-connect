# Provenance of the contract files in this folder

These files are byte copies. Do not edit them. To update, copy the files from a newer spec tag and change this header in
the same commit. `test/data-contract.test.ts` fails when a file no longer matches the sha256 below.

- Source repo: `Tealbrick/opt2-tealbrick-specs` (private)
- Tag: `spec-v0.1.42` (annotated tag object `0e1b92c2c962b728588e1aeccd1bd721cfe7e726`, commit `e2e05cdf9eb49bdaf726b6180779964d3cb3e506`)
- Contract: `messages/1` (one page of the Connect `messages` dataset, answer of `data_pull`; producer: this app, consumers: Knowledge foundry and Observer). Decision C230, request R3, FOUNDRY-DESIGN v2 §3.4.

| File here | Path in the source repo (at the tag) | sha256 |
|---|---|---|
| `messages.1.schema.json` | `packages/spec/schemas/contracts/messages.1.schema.json` | `9a627953cac9b7bb20a2bed14a807a2db334b776aa34f051495794a4b1302a24` |
| `messages.1.json` | `packages/spec/examples/contracts/messages.1.json` | `1734dc67c65fd6edd80ba3987319339aa0e5d9b46b25198df1c9887b7bff7c12` |
| `../../src/contracts/messages.1.schema.json` (runtime copy: the image has no `test/`) | same as the schema above | `9a627953cac9b7bb20a2bed14a807a2db334b776aa34f051495794a4b1302a24` |

How this app uses them: `src/data/messages.ts` validates EVERY `data_pull` page for dataset `messages` against the schema with
the JSON Schema 2020-12 validator that `@opt2-tealbrick/manifest` exports (`validateAgainstSchema`, ajv 8, formats as
annotations) before it returns the page. A mismatch is a producer bug: the op answers `data_contract_violation` (500), logs it,
and never returns the page. The fixtures `valid` and `invalid` run through the same validator in `test/data-contract.test.ts`.

## documents/1 (C373, DRAFT for spec 0.1.83)

- Source: `coordination/leads/second-brain/documents.1.schema.json` of the C373 second-brain lead (2026-10-27; packages lead review points a-g and QA specs#62 S2/S3 applied). The spec release that knows the id comes later via the packages lead; then this copy is replaced by the file at that spec tag and this section names the tag. Not in the manifest `contracts` field yet.
- Contract: `documents/1` (one page of the Connect `documents` dataset, answer of `data_pull`; producer: this app, from MCP accounts and database accounts; consumer: Observer, Knowledge through Observer, C322(6)).

| File here | Source | sha256 |
|---|---|---|
| `documents.1.schema.json` | the lead's file above | `77d581d1455084b385aef85223bc3d5cb698ede19d954fe92d5921ddec3c4bd0` |
| `../../src/contracts/documents.1.schema.json` (runtime copy) | same as the schema above | `77d581d1455084b385aef85223bc3d5cb698ede19d954fe92d5921ddec3c4bd0` |

How this app uses it: `src/data/documents.ts` validates EVERY `data_pull` page for dataset `documents` against the schema
(`validateAgainstSchema`, as for messages) and every row before it is added; a page that does not conform answers
`data_contract_violation` (500) and is never returned, a row that does not conform is skipped and counted (`quarantined`).
