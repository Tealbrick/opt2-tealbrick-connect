/**
 * Audit hole 4 (C380): a scheduled Buzz post is asked about again at send time. Every answer of the bridge's check, fail closed when
 * it cannot answer, one hold across ticks and restarts, no double post. The SDK's own `sendTimeCheck` has its tests in the SDK;
 * this file tests what Connect does with each answer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type BuzzSendCheck, buzzSendCheck, runDueBuzzPosts, SEND_CHECK_GIVE_UP_MS } from "../src/app.ts";
import type { BuzzRelay } from "../src/channels/buzz/relay.ts";
import { testDb } from "./helpers.ts";

const AGENT = "agt_01M4TNVDHPXJGTHATZV5SVJHX9";
const CHANNEL = "5a7d6c2e-1f3a-4c5b-9d8e-7f6a5b4c3d2e";
const NOW = 1_760_000_000_000;
const log = { debug() {}, info() {}, warn() {}, error() {} };

function world(rows = 1) {
  const db = testDb();
  db.prepare("INSERT INTO connect_agents (id, name, status, updated_at) VALUES (?, 'A', 'active', 1)").run(AGENT);
  for (let i = 1; i <= rows; i++) db.prepare("INSERT INTO connect_buzz_scheduled (id, agent, channel, content, send_at, status, created_at) VALUES (?, ?, ?, ?, ?, 'scheduled', 1)").run(`bsp_${i}`, AGENT, CHANNEL, `post ${i}`, NOW - 1000);
  const posts: string[] = [];
  const asked: { op: string; input: unknown; caller: unknown; holdId?: string | null }[] = [];
  const relay = {
    query: async () => ({ events: [], relays: [] }),
    post: async (_a: string, input: { content: string }) => {
      posts.push(input.content);
      return { id: `e${posts.length}`, relays: [] };
    },
  } as unknown as BuzzRelay;
  const run = (check: BuzzSendCheck, now = NOW) =>
    runDueBuzzPosts(db, relay, log, (q) => {
      asked.push(q);
      return check(q);
    }, now);
  const row = (id = "bsp_1") => ({ ...db.prepare("SELECT status, detail, hold_id FROM connect_buzz_scheduled WHERE id = ?").get(id) });
  return { db, posts, asked, run, row };
}

test("run: the post goes out once; the check names buzz_post, the exact input and the agent", async () => {
  const w = world();
  assert.equal(await w.run(async () => ({ decision: "run" })), 1);
  assert.deepEqual(w.posts, ["post 1"]);
  assert.deepEqual(w.asked, [{ op: "buzz_post", input: { channel: CHANNEL, content: "post 1" }, caller: { type: "agent", id: AGENT }, holdId: null }]);
  assert.equal(w.row().status, "sent");
  assert.equal(await w.run(async () => ({ decision: "run" })), 0, "not sent again");
  assert.equal(w.asked.length, 1);
});

test("refused (a stopped agent, a floor, a deny rule): nothing goes out, cancelled with the reason, not asked again", async () => {
  const w = world();
  assert.equal(await w.run(async () => ({ decision: "refused", code: "hook_denied", reason: "Refused by company policy" })), 0);
  assert.deepEqual(w.posts, []);
  assert.deepEqual(w.row(), { status: "cancelled", detail: "Not sent: Refused by company policy", hold_id: null });
  await w.run(async () => assert.fail("not asked again"));
});

test("fail closed: defer and a throwing check post nothing, the row waits, and it is tried again", async () => {
  const w = world();
  assert.equal(await w.run(async () => ({ decision: "defer", code: "bridge_unavailable" })), 0);
  assert.equal(w.row().status, "scheduled");
  assert.match(String(w.row().detail), /could not check/u);
  assert.equal(await w.run(async () => { throw new Error("socket closed"); }), 0, "a throw is no answer");
  assert.equal(w.row().status, "scheduled");
  assert.deepEqual(w.posts, []);
  assert.equal(await w.run(async () => ({ decision: "run" })), 1, "the next answer decides");
  assert.deepEqual(w.posts, ["post 1"]);
});

test("fail closed: a post that cannot be checked for a day is cancelled, not sent late", async () => {
  const w = world();
  const defer: BuzzSendCheck = async () => ({ decision: "defer", code: "x" });
  await w.run(defer, NOW - 1000 + SEND_CHECK_GIVE_UP_MS);
  assert.equal(w.row().status, "scheduled", "at the limit it still waits");
  await w.run(defer, NOW - 1000 + SEND_CHECK_GIVE_UP_MS + 1);
  assert.deepEqual(w.row(), { status: "cancelled", detail: "Not sent: Connect could not check the post with the bridge for a day.", hold_id: null });
  assert.deepEqual(w.posts, []);
});

test("a bridge with no check is no answer, never a pass; with the cap the SDK is asked", async () => {
  let calls = 0;
  const sendTimeCheck: BuzzSendCheck = async () => {
    calls += 1;
    return { decision: "run" };
  };
  const input = { op: "buzz_post", input: {}, caller: { type: "agent" as const, id: AGENT } };
  assert.deepEqual(await buzzSendCheck({ sendTimeCheck, bridgeCaps: () => [] })(input), { decision: "defer", code: "bridge_cap_missing" });
  assert.equal(calls, 0);
  assert.deepEqual(await buzzSendCheck({ sendTimeCheck, bridgeCaps: () => ["acting_agents"] })(input), { decision: "run" });
  assert.equal(calls, 1);
});

test("hold: the row keeps one hold id, is asked with it on each tick, and then the owner's answer decides", async () => {
  const approved = world();
  assert.equal(await approved.run(async () => ({ decision: "wait", holdId: "hld_1" })), 0);
  assert.deepEqual(approved.row(), { status: "scheduled", detail: "Waiting for the owner's approval.", hold_id: "hld_1" });
  await approved.run(async (q) => {
    assert.equal(q.holdId, "hld_1", "asked with the hold: no second hold");
    return { decision: "wait", holdId: "hld_1" };
  });
  assert.deepEqual(approved.posts, []);
  assert.equal(await approved.run(async () => ({ decision: "run" })), 1);
  assert.equal(approved.row().status, "sent");

  const denied = world();
  await denied.run(async () => ({ decision: "wait", holdId: "hld_2" }));
  await denied.run(async () => ({ decision: "refused", code: "hold_denied", reason: "The owner did not approve it." }));
  assert.equal(denied.row().status, "cancelled");
  assert.equal(denied.row().detail, "Not sent: The owner did not approve it.");
  assert.deepEqual(denied.posts, []);
});

test("restart: a tick cut during the check is reported failed and never re-sent; a post that waits on a hold carries on", async () => {
  const w = world(2);
  await w.run(async (q) => ((q.input as { content: string }).content === "post 1" ? { decision: "wait", holdId: "hld_1" } : { decision: "defer", code: "x" }));
  // the process dies while bsp_2 is claimed
  w.db.prepare("UPDATE connect_buzz_scheduled SET status = 'sending', claimed_at = ? WHERE id = 'bsp_2'").run(NOW);
  assert.equal(await w.run(async () => ({ decision: "run" }), NOW + 60_000), 1, "only the post with the hold");
  assert.deepEqual(w.posts, ["post 1"]);
  assert.equal(w.row("bsp_2").status, "sending");
  assert.equal(await w.run(async () => ({ decision: "run" }), NOW + 11 * 60_000), 0);
  assert.equal(w.row("bsp_2").status, "failed");
  assert.deepEqual(w.posts, ["post 1"]);
});

test("two ticks at once: the claim comes before the check, so one question, one hold, one post", async () => {
  const w = world();
  let open: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  const first = w.run(async () => {
    await gate;
    return { decision: "wait", holdId: "hld_1" };
  });
  const second = w.run(async () => assert.fail("the second tick must not ask"));
  await second;
  open();
  await first;
  assert.equal(w.asked.length, 1);
  assert.equal(w.row().hold_id, "hld_1");
});

test("posts that wait for the owner do not fill the window", async () => {
  const w = world(25);
  await w.run(async () => ({ decision: "wait", holdId: "hld" }));
  w.asked.length = 0;
  const later = NOW + 1;
  w.db.prepare("UPDATE connect_buzz_scheduled SET hold_id = 'hld' WHERE id <> 'bsp_25'").run();
  await w.run(async (q) => (q.holdId ? { decision: "wait", holdId: String(q.holdId) } : { decision: "run" }), later);
  assert.equal(w.row("bsp_25").status, "sent");
});

test("a paused or removed agent is cancelled before any bridge call, as before", async () => {
  const w = world();
  w.db.prepare("UPDATE connect_agents SET status = 'paused'").run();
  await w.run(async () => assert.fail("no bridge call"));
  assert.equal(w.row().status, "cancelled");
  assert.equal(w.row().detail, "Not sent: the agent was paused when the post was due.");
});
