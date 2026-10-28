// Contract messages/1 (C230 R3): the frozen files (sha256 in PROVENANCE.md), every fixture through the validator the
// producer uses, and the reader rule normalizeHandle(h) === h for the channels that have a canonical form.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HANDLE_CHANNELS, normalizeHandle, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { JsonSchemaObject } from "@opt2-tealbrick/spec/manifest";
import type { Json } from "@opt2-tealbrick/spec/sdk";

import { assertConforms, DataError, type MessagesPage } from "../src/data/messages.ts";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const file = (rel: string) => readFileSync(new URL(rel, import.meta.url));
const schema = JSON.parse(file("../src/contracts/messages.1.schema.json").toString()) as JsonSchemaObject;
const FIXTURES = JSON.parse(file("./contracts/messages.1.json").toString()) as { valid: Json[]; invalid: { why: string; doc: Json }[] };

test("contract files are the byte copies named in PROVENANCE.md (quiet on good, fires on a changed byte); the runtime schema is the same bytes", () => {
  const prov = file("./contracts/PROVENANCE.md").toString();
  for (const f of ["./contracts/messages.1.schema.json", "./contracts/messages.1.json", "../src/contracts/messages.1.schema.json"]) {
    const bytes = file(f);
    assert.ok(prov.includes(sha256(bytes)), `${f} does not match the sha256 in PROVENANCE.md`);
    assert.ok(!prov.includes(sha256(Buffer.concat([bytes, Buffer.from(" ")]))), "a changed file would not match");
  }
  assert.ok(file("./contracts/messages.1.schema.json").equals(file("../src/contracts/messages.1.schema.json")));
  assert.ok(prov.includes("spec-v0.1.42"));
});

test("fixtures: every valid page validates, every invalid page fails (the schema check is live)", () => {
  assert.ok(FIXTURES.valid.length >= 2 && FIXTURES.invalid.length >= 6);
  for (const doc of FIXTURES.valid) assert.deepEqual(validateAgainstSchema(schema, doc), { ok: true });
  for (const { why, doc } of FIXTURES.invalid) assert.equal(validateAgainstSchema(schema, doc).ok, false, why);
});

test("the producer's own gate (assertConforms) agrees with the fixtures: valid pass, invalid fail with data_contract_violation 500", () => {
  for (const doc of FIXTURES.valid) assert.doesNotThrow(() => assertConforms(doc as unknown as MessagesPage));
  for (const { why, doc } of FIXTURES.invalid) {
    assert.throws(() => assertConforms(doc as unknown as MessagesPage), (e) => e instanceof DataError && e.code === "data_contract_violation" && e.httpStatus === 500, why);
  }
});

test("the valid fixtures keep the reader rule: handles of buzz, slack and telegram are canonical", () => {
  for (const page of FIXTURES.valid as unknown as MessagesPage[]) {
    for (const row of page.rows) {
      const channel = row.author.handle.split(":")[0] as string;
      if ((HANDLE_CHANNELS as readonly string[]).includes(channel)) assert.equal(normalizeHandle(row.author.handle), row.author.handle, row.author.handle);
    }
  }
});

test("a page over 2 MiB, or over 200 rows, is refused by the producer gate", () => {
  const row = (n: number) => ({
    id: `m${n}`,
    conversation: "c",
    sentAt: "2026-10-17T10:00:00Z",
    author: { kind: "person" as const, handle: "telegram:1" },
    text: "x".repeat(65_536),
    attachments: [],
    untrusted: true as const,
  });
  const big: MessagesPage = { rows: Array.from({ length: 40 }, (_, n) => row(n)), nextCursor: null, exhausted: true };
  assert.throws(() => assertConforms(big), { code: "data_contract_violation", httpStatus: 500 });
  const many: MessagesPage = { rows: Array.from({ length: 201 }, (_, n) => ({ ...row(n), text: "x" })), nextCursor: null, exhausted: true };
  assert.throws(() => assertConforms(many), { code: "data_contract_violation" });
  assert.doesNotThrow(() => assertConforms({ rows: Array.from({ length: 200 }, (_, n) => ({ ...row(n), text: "x" })), nextCursor: null, exhausted: true }));
});

test("documents/1 (C373): the vendored schema files are the byte copies named in PROVENANCE.md; runtime and test copy are the same bytes", () => {
  const prov = file("./contracts/PROVENANCE.md").toString();
  for (const f of ["./contracts/documents.1.schema.json", "../src/contracts/documents.1.schema.json"]) {
    const bytes = file(f);
    assert.ok(prov.includes(sha256(bytes)), `${f} does not match the sha256 in PROVENANCE.md`);
    assert.ok(!prov.includes(sha256(Buffer.concat([bytes, Buffer.from(" ")]))), "a changed file would not match");
  }
  assert.ok(file("./contracts/documents.1.schema.json").equals(file("../src/contracts/documents.1.schema.json")));
  const documents = JSON.parse(file("../src/contracts/documents.1.schema.json").toString()) as { $defs: { row: { properties: { mime: { enum: string[] } } } } };
  assert.deepEqual(documents.$defs.row.properties.mime.enum, ["text/plain", "text/markdown", "text/csv"], "no text/html: the producer converts HTML");
});
