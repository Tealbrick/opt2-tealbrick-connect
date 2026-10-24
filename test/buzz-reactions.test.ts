/** C343a: the owner's signed ✅ / ❌ reaction on a Buzz alert decides through the sending app (QA rows of the Coordinator). */
import assert from "node:assert/strict";
import { test } from "node:test";

import { BUZZ_APPROVE, BUZZ_DENY, type BuzzReader, decideFrom, emojiMap, pollBuzzActions, recordBuzzActions } from "../src/channels/buzz/actions.ts";
import { generateSecretKey, type NostrEvent, publicKeyOf, signEvent } from "../src/channels/buzz/nostr.ts";
import type { MessageAction } from "../src/channels/provider.ts";
import type { RelayOutcome } from "../src/channels/service.ts";
import { secretsFor, testDb } from "./helpers.ts";

const OWNER_SK = generateSecretKey();
const OWNER = publicKeyOf(OWNER_SK);
const OTHER_SK = generateSecretKey();
const SENDER = "workspace-sender";
const CHANNEL = "5a7d6c2e-1f3a-4c5b-9d8e-7f6a5b4c3d2e";
const NOW = 1_760_000_000_000;
const NOW_S = NOW / 1000;
const ALERT_ID = "a".repeat(64);
const OTHER_EVENT = "b".repeat(64);
const VALUE_A = `ib1.${"t".repeat(16)}.a.${"m".repeat(22)}`;
const VALUE_D = `ib1.${"t".repeat(16)}.d.${"n".repeat(22)}`;
const BUTTONS: MessageAction[] = [
  { label: "Approve", value: VALUE_A, style: "primary" },
  { label: "Deny", value: VALUE_D, style: "danger" },
];

const react = (emoji: string, opts: { sk?: string; target?: string; at?: number } = {}): NostrEvent =>
  signEvent(opts.sk ?? OWNER_SK, { kind: 7, created_at: opts.at ?? NOW_S + 5, tags: [["e", opts.target ?? ALERT_ID], ["h", CHANNEL]], content: emoji });

function world(initial: NostrEvent[] = []) {
  const db = testDb();
  const secrets = secretsFor(db);
  let now = NOW;
  let reactions = [...initial];
  const replies: string[] = [];
  const queries: Record<string, unknown>[] = [];
  const relayed: { product: string; input: unknown; key: string }[] = [];
  let outcome: RelayOutcome | Error = { final: true, notice: "Approved by you at 10:00 UTC." };
  const reader: BuzzReader = {
    query: async (_agent, filters) => {
      queries.push(filters[0] as Record<string, unknown>);
      return { events: reactions };
    },
    post: async (_agent, input) => {
      replies.push(input.content);
      return {};
    },
  };
  const relay = async (product: string, input: unknown, key: string) => {
    relayed.push({ product, input, key });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  const deps = () => ({ db, secrets, reader, relay, now: () => now });
  const record = () =>
    recordBuzzActions(
      { db, secrets, now: () => now },
      { sender: SENDER, owner: OWNER, sent: [{ id: ALERT_ID, channel: CHANNEL }], origin: { product: "inbox", instance: "ins_01INBOX", requestedAccount: "npub1owner", actions: BUTTONS, expiresAt: NOW + 3600_000 } },
    );
  return {
    db,
    secrets,
    replies,
    queries,
    relayed,
    record,
    poll: () => pollBuzzActions(deps()),
    set: (e: NostrEvent[]) => {
      reactions = e;
    },
    tick: (ms: number) => {
      now += ms;
    },
    setOutcome: (o: RelayOutcome | Error) => {
      outcome = o;
    },
    state: () => (db.prepare("SELECT state FROM connect_buzz_actions").get() as { state: string } | undefined)?.state,
  };
}

const alert = { eventIds: new Set([ALERT_ID]), owner: OWNER, sentAtS: NOW_S };

test("emoji map: one primary (✅) and at most one danger (❌) button", () => {
  assert.deepEqual(emojiMap(BUTTONS), { [BUZZ_APPROVE]: VALUE_A, [BUZZ_DENY]: VALUE_D });
  assert.deepEqual(emojiMap([BUTTONS[1] as MessageAction]), { [BUZZ_DENY]: VALUE_D });
  assert.equal(emojiMap([BUTTONS[0] as MessageAction, { ...(BUTTONS[0] as MessageAction), value: "x" }]), null, "two primary");
  assert.equal(emojiMap([]), null);
});

test("decideFrom: only a valid, signed reaction of the owner on this alert counts", () => {
  assert.equal(decideFrom([react(BUZZ_APPROVE)], alert), BUZZ_APPROVE);
  assert.equal(decideFrom([react(`${BUZZ_DENY}️`)], alert), BUZZ_DENY, "emoji presentation selector ignored");
  // forged signature: content changed after signing, and a made-up sig
  const good = react(BUZZ_DENY);
  assert.equal(decideFrom([{ ...good, content: BUZZ_APPROVE }], alert), null, "content changed after signing");
  assert.equal(decideFrom([{ ...react(BUZZ_APPROVE), sig: "0".repeat(128) }], alert), null, "made-up signature");
  // wrong pubkey: another member of the DM channel
  assert.equal(decideFrom([react(BUZZ_APPROVE, { sk: OTHER_SK })], alert), null);
  // a pubkey swapped in without re-signing
  assert.equal(decideFrom([{ ...react(BUZZ_APPROVE, { sk: OTHER_SK }), pubkey: OWNER }], alert), null);
  // a reaction on a different event
  assert.equal(decideFrom([react(BUZZ_APPROVE, { target: OTHER_EVENT })], alert), null);
  // a relay replaying an old reaction (older than the alert)
  assert.equal(decideFrom([react(BUZZ_APPROVE, { at: NOW_S - 3600 })], alert), null);
  // not ✅ / ❌
  for (const e of ["👍", "+", "✔", "✅✅", "approve", "❎", ""]) assert.equal(decideFrom([react(e)], alert), null, JSON.stringify(e));
  // a text reply (kind 9) never decides
  assert.equal(decideFrom([signEvent(OWNER_SK, { kind: 9, created_at: NOW_S + 5, tags: [["h", CHANNEL], ["e", ALERT_ID, "", "root"]], content: BUZZ_APPROVE })], alert), null);
  // ✅ then ❌: the first wins; the same second: ambiguous
  assert.equal(decideFrom([react(BUZZ_DENY, { at: NOW_S + 9 }), react(BUZZ_APPROVE, { at: NOW_S + 7 })], alert), BUZZ_APPROVE);
  assert.equal(decideFrom([react(BUZZ_DENY, { at: NOW_S + 7 }), react(BUZZ_APPROVE, { at: NOW_S + 7 })], alert), "ambiguous");
  // a burst: many invalid ones around one valid
  const burst = [
    ...Array.from({ length: 40 }, (_, n) => react("👍", { at: NOW_S + n })),
    ...Array.from({ length: 40 }, (_, n) => react(BUZZ_DENY, { sk: OTHER_SK, at: NOW_S + n })),
    react(BUZZ_APPROVE, { at: NOW_S + 50 }),
  ];
  assert.equal(decideFrom(burst, alert), BUZZ_APPROVE);
});

test("poll: the first valid ✅ is relayed once with the sealed value; the alert closes and the owner gets a reply", async () => {
  const w = world([react(BUZZ_APPROVE)]);
  await w.record();
  const row = w.db.prepare("SELECT * FROM connect_buzz_actions").get() as Record<string, unknown>;
  assert.doesNotMatch(JSON.stringify(row), /ib1\./u, "no button value in the database");
  assert.ok(await w.secrets.get(`buzz-actions:${ALERT_ID}`), "values sealed in the app secrets");
  await w.poll();
  assert.deepEqual(w.relayed, [{ product: "inbox", input: { token: VALUE_A, clicker: { service: "buzz", id: "npub1owner" }, account: "buzz" }, key: `buzz-act-${ALERT_ID.slice(0, 32)}` }]);
  assert.equal(w.state(), "done");
  assert.deepEqual(w.replies, ["Approved by you at 10:00 UTC."]);
  assert.equal(await w.secrets.get(`buzz-actions:${ALERT_ID}`), null, "values removed after the decision");
  assert.deepEqual(w.queries[0], { kinds: [7], "#h": [CHANNEL], "#e": [ALERT_ID], since: NOW_S - 60, limit: 100 });
  // after the decision: a later ❌ (or the same ✅ again) is never read
  w.set([react(BUZZ_APPROVE), react(BUZZ_DENY, { at: NOW_S + 30 })]);
  await w.poll();
  assert.equal(w.relayed.length, 1);
  assert.equal(w.replies.length, 1);
});

test("poll: a removed reaction (gone from the relay before the poll) decides nothing; removing one after changes nothing", async () => {
  const w = world([]);
  await w.record();
  await w.poll();
  assert.equal(w.relayed.length, 0);
  assert.equal(w.state(), "open");
  w.set([react(BUZZ_DENY)]);
  w.setOutcome({ final: true, notice: "Denied by you at 10:00 UTC." });
  await w.poll();
  w.set([]);
  await w.poll();
  assert.equal(w.relayed.length, 1);
  assert.equal(w.state(), "done");
});

test("poll: expired → closed with a reply, no relay; ambiguous → closed, no relay; a non-✅/❌ reaction keeps it open", async () => {
  const e = world([react(BUZZ_APPROVE)]);
  await e.record();
  e.tick(3600_001);
  await e.poll();
  assert.equal(e.relayed.length, 0);
  assert.deepEqual([e.state(), e.replies[0]], ["done", "These reactions expired. Decide in Operator Inbox."]);

  const a = world([react(BUZZ_APPROVE, { at: NOW_S + 7 }), react(BUZZ_DENY, { at: NOW_S + 7 })]);
  await a.record();
  await a.poll();
  assert.equal(a.relayed.length, 0);
  assert.equal(a.state(), "done");
  assert.match(a.replies[0] ?? "", /nothing was decided/u);

  const n = world([react("👍"), react(BUZZ_APPROVE, { sk: OTHER_SK })]);
  await n.record();
  await n.poll();
  assert.deepEqual([n.relayed.length, n.state(), n.replies.length], [0, "open", 0]);
});

test("poll: a final refusal of the app closes the alert with its text; a transient error keeps it open and tells the owner once", async () => {
  const w = world([react(BUZZ_APPROVE)]);
  await w.record();
  w.setOutcome({ final: false, notice: "Could not decide now. Try again, or open Operator Inbox." });
  await w.poll();
  await w.poll();
  assert.equal(w.relayed.length, 2, "the same reaction is tried again");
  assert.equal(w.state(), "open");
  assert.equal(w.replies.length, 1, "told once");
  w.setOutcome({ final: true, notice: "The agent added to this item after you opened it." });
  await w.poll();
  assert.equal(w.state(), "done");
  assert.equal(w.replies.at(-1), "The agent added to this item after you opened it.");
  // a relay that throws counts as transient
  const t = world([react(BUZZ_APPROVE)]);
  await t.record();
  t.setOutcome(new Error("boom"));
  await t.poll();
  assert.equal(t.state(), "open");
});
