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

## tb.access/1 (C380)

- Source repo: `Tealbrick/opt2-tealbrick-specs`, tag `spec-v0.1.89` (commit d543905 on branch `c380/b1-access-contract` when copied). Not a manifest contract id. Contract: `docs/ACCESS.md`.
- The manifest ops `access_list` and `access_revoke` embed the four schemas as parsed JSON (`test/access.test.ts` compares them).

| File here | Path in the source repo | sha256 |
|---|---|---|
| `access.caller_vector.1.json` | `packages/spec/examples/contracts/access.caller_vector.1.json` | `faf832b1a3fa7e122f252677e9a946be11668cacd23ce0f765fcaa57ebe5cd49` |
| `access.digest.1.json` | `packages/spec/examples/contracts/access.digest.1.json` | `e4db19dd894802348b9e87c2251d85383fb2e4f47e90b26dde76c42e17b42daa` |
| `access.list_in.1.json` | `packages/spec/examples/contracts/access.list_in.1.json` | `dc1745d9a0bd6d83fdd672fbc14e119f9637b19537162e77455b246676535c85` |
| `access.list_in.1.schema.json` | `packages/spec/schemas/contracts/access.list_in.1.schema.json` | `83f1c2f7c2c399d8e11a93418e469d01c777af5f6c8bfe7cd2643539f3a04fe5` |
| `access.list_out.1.json` | `packages/spec/examples/contracts/access.list_out.1.json` | `efc7e1389eb7a7eac55e3149c2ac111959a5664ebaccf630a0155668c70b5c49` |
| `access.list_out.1.schema.json` | `packages/spec/schemas/contracts/access.list_out.1.schema.json` | `571feb6b833d392f8eec3212b21d53aa7e529dfb65a34f8a54b89d07160c7f48` |
| `access.revoke_in.1.json` | `packages/spec/examples/contracts/access.revoke_in.1.json` | `5cab7e5c4b15ddf172aac5a4dab0f55a1028eeaa4ac491a712c4b88f6221783d` |
| `access.revoke_in.1.schema.json` | `packages/spec/schemas/contracts/access.revoke_in.1.schema.json` | `edbe7c6b94ffb74e4dff0c3f986ccaa29e83d8d6fd1fa9f1e2986d2802e60c51` |
| `access.revoke_out.1.json` | `packages/spec/examples/contracts/access.revoke_out.1.json` | `76ed608d69f86c43d217ce18516ffe7b233d20f5971a962e862184a62b296281` |
| `access.revoke_out.1.schema.json` | `packages/spec/schemas/contracts/access.revoke_out.1.schema.json` | `b36b1c6474fc858daf93e2a4d9605067113937b984e8b26833fa13eae314d919` |
