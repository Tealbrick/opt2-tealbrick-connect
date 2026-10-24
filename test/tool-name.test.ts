// C354: a catalog entry name never contains "__" (x__<suffix> is reserved for resolved variants, e.g. __first_contact).
import assert from "node:assert/strict";
import { test } from "node:test";

import { toolName } from "../src/tools.ts";

test("a shortened name whose 39th character is an underscore has no double underscore", () => {
  const slug = `${"a".repeat(38)}_${"b".repeat(20)}`;
  const name = toolName(slug);
  assert.ok(!name.includes("__"), name);
  assert.match(name, /^a{38}_[0-9a-f]{8}$/u);
  assert.ok(name.length <= 48);
  // the hash still tells two long slugs with the same start apart
  assert.notEqual(name, toolName(`${"a".repeat(38)}_${"c".repeat(20)}`));
});

test("no slug shape gives a name with __: cuts at every position, runs of separators, a leading digit", () => {
  for (let cut = 30; cut <= 48; cut++) {
    for (const sep of ["_", "__", "-", " ", "._-"]) {
      const slug = `${"x".repeat(cut)}${sep}${"y".repeat(30)}`;
      const name = toolName(slug);
      assert.ok(!name.includes("__"), `${slug} -> ${name}`);
      assert.match(name, /^[a-z][a-z0-9_]{1,47}$/u);
    }
  }
  assert.ok(!toolName("1__2__3").includes("__"));
  assert.equal(toolName("GMAIL_SEND_EMAIL"), "gmail_send_email", "a normal name is unchanged");
});
