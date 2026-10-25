/**
 * C360 (INC-20261025-01): 0.6.5 is the 0.6.1 code plus the first-contact fixes. Versions 0.6.2 to 0.6.4 carry newer code (and
 * 0.6.4 the migration 0016_database_accounts), so a workspace on them must never "update" to 0.6.5. Core refuses an update whose
 * running version does not satisfy the release's `upgradeFrom` (reason `upgrade_path`); the release record takes it from here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { root } from "./helpers.ts";

const ci = JSON.parse(readFileSync(join(root, "tealbrick-ci.json"), "utf8")) as { images: { product: string; upgradeFrom?: string }[] };
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

test("C361a: the 0.6.6 image-only patch accepts updates only from 0.6.1 and older or exactly 0.6.5 (dev-only 0.6.2 to 0.6.4 cannot move sideways)", () => {
  assert.equal(pkg.version, "0.6.6");
  const app = ci.images.find((i) => i.product === "connect");
  assert.equal(app?.upgradeFrom, "<=0.6.1 || =0.6.5");
});
