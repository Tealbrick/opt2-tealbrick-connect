/** C354a exposure interim: buzz_dm_first and channel_dm_first refuse when the grant holds outward but not first_contact. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Manifest } from "@opt2-tealbrick/spec/manifest";
import { type ConnectError, createConnectApp } from "../src/app.ts";
import { fakeFetch, handlerOf, root, testCtx, testDb } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;
const approvalOff = (e: ConnectError) => {
  assert.equal(e.code, "first_contact_approval_off");
  return true;
};

test("interim: the static first-contact ops refuse for held [outward] (agent and app callers) and go on otherwise", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "connect-fco-"));
  try {
    const upstream = fakeFetch({});
    const app = createConnectApp({ manifest, migrationsDir: join(root, "migrations"), fetchImpl: upstream.impl, dataDir });
    const db = testDb();
    for (const op of ["buzz_dm_first", "channel_dm_first"]) {
      await assert.rejects(handlerOf(app, op)({ to: "someone", person: "someone", text: "hi" }, testCtx({ db, grantHeld: ["outward"] })), approvalOff, op);
      await assert.rejects(handlerOf(app, op)({ to: "someone", person: "someone", text: "hi" }, testCtx({ db, app: "ins_CALLER", grantHeld: ["outward", "money"] })), approvalOff, `${op} app caller`);
      // any other combination passes the interim check (and then fails or runs on its own merits, never with this code)
      for (const held of [["first_contact"], ["outward", "first_contact"], []]) {
        await handlerOf(app, op)({ to: "someone", person: "someone", text: "hi" }, testCtx({ db, grantHeld: held })).then(
          () => undefined,
          (e: ConnectError) => assert.notEqual(e.code, "first_contact_approval_off", `${op} ${held.join(",")}`),
        );
      }
    }
    assert.equal(upstream.calls.length, 0, "nothing reached an upstream");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
