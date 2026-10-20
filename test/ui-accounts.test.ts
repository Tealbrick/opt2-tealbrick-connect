// The Accounts page (src/ui/pages/Accounts.tsx) against the real SDK client and a stub server: the app sharing sentences under
// each app row (S3-3) and the owner's "Recent access" table (S3-2): empty state, served rows, refused rows with the throttle
// counter. The page is compiled with the build tsconfig into dist/ui-test-accounts and rendered in happy-dom.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

type AccountsModule = typeof import("../src/ui/pages/Accounts.tsx");

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-accounts");

const win = new Window({ url: "http://localhost/a/connect/", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

type Share = { product: string; instance: string | null; current: boolean; level: "available" | "shared"; includeHistory: boolean; setAt: string };
type Inst = { instance: string; name: string; provider: string | null; ownInfra: boolean };
const K1 = "ins_01HZKNWDG00000000000000000";
const O1 = "ins_01HZ0BSRVR0000000000000000";
const inst = (instance: string, name: string, ownInfra = false): Inst => ({ instance, name, provider: ownInfra ? "own_infra" : "railway", ownInfra });
const DEFAULT_APPS = () => [
  { product: "knowledge", name: "Knowledge", instances: [inst(K1, "Knowledge")] },
  { product: "observer", name: "Observer", instances: [inst(O1, "Observer")] },
];
type Entry = { id: number; at: string; op: string; callerType: string; product: string | null; app: string | null; account: string | null; ok: boolean; outcome: string; rows: number; repeats: number };
const stub: {
  shares: Share[];
  entries: Entry[];
  dataApps: { product: string; name: string; instances: Inst[] }[];
  callersKnown: boolean;
  sent: Record<string, unknown>[];
  agentRows?: Record<string, unknown>[];
  scopeSets: Record<string, unknown>[];
  offerChanged?: boolean;
  ownerRowsEffective?: boolean;
} = {
  shares: [],
  entries: [],
  dataApps: DEFAULT_APPS(),
  callersKnown: true,
  // every account_app_share input the page sent (the stub answers ok and changes nothing)
  sent: [],
  // every tb.scopes_set input the page sent (C283d)
  scopeSets: [],
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const account = () => ({ id: "cna_1", service: "telegram", source: "channel", kind: "as_itself", label: "Support bot", ownerAgent: "agt_1", status: "connected", detail: "", shares: stub.shares });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  if (url.pathname.endsWith("/ops.json")) return json(200, { operations: [] });
  const path = url.pathname.replace("/a/connect/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (op === "accounts_overview") return json(200, { status: "ok", output: { accounts: [account()], dataApps: stub.dataApps, callersKnown: stub.callersKnown, ...(stub.ownerRowsEffective ? { ownerRowsEffective: true } : {}) } });
  if (op === "account_app_share") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Record<string, unknown> };
    stub.sent.push(body.input ?? (body as Record<string, unknown>));
    return json(200, { status: "ok", output: { shares: stub.shares } });
  }
  if (op === "data_access_log") return json(200, { status: "ok", output: { entries: stub.entries } });
  if (op === "tb.agents_list") return json(200, { status: "ok", output: { agents: [{ id: "agt_1", name: "Front desk", status: "active", ...(stub.agentRows ? { access: stub.agentRows } : {}) }] } });
  if (op === "tb.scopes_set") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Record<string, unknown> };
    const input = body.input ?? (body as Record<string, unknown>);
    stub.scopeSets.push(input);
    if (stub.offerChanged && input.acceptOffer) return json(409, { error: { code: "offer_changed", message: "The offer changed." } });
    return json(200, { status: "ok", output: {} });
  }
  return json(404, { error: { code: "not_found", message: String(op) } });
}) as typeof fetch;

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}
async function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(h(TbProvider, { product: "connect" }, el)));
  await flush();
  return {
    host,
    unmount: async () => {
      await act(async () => r.unmount());
      host.remove();
    },
  };
}

let mod: AccountsModule;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  mod = (await import(pathToFileURL(join(outDir, "ui", "pages", "Accounts.js")).href)) as AccountsModule;
});
after(() => rmSync(outDir, { recursive: true, force: true }));

const SETAT = "2026-10-17T10:00:00.000Z";
const entry = (n: number, extra: Partial<Entry> = {}): Entry => ({ id: n, at: "2026-10-18T09:15:00.000Z", op: "data_pull", callerType: "app", product: "knowledge", app: "Knowledge", account: "Support bot", ok: true, outcome: "ok", rows: 7, repeats: 0, ...extra });
const text = (host: Element) => (host.textContent ?? "").replace(/\s+/gu, " ");
const rowsOf = (host: Element) => [...host.querySelectorAll("#recent-access ~ table tbody tr, section[aria-labelledby=recent-access] tbody tr")];
const notes = (host: Element) => [...host.querySelectorAll(".acc-note")].map((n) => n.textContent ?? "");

describe("Accounts page: app sharing sentences", () => {
  it("says what each level gives, under each app row, and that the owner can revoke", async () => {
    stub.entries = [];
    stub.shares = [];
    const none = await mount(h(mod.Accounts));
    assert.deepEqual(notes(none.host), ["This app sees nothing of this connection. Pick a level to share; you can revoke it at any time.", "This app sees nothing of this connection. Pick a level to share; you can revoke it at any time."]);
    await none.unmount();

    stub.shares = [
      { product: "knowledge", instance: K1, current: true, level: "available", includeHistory: false, setAt: SETAT },
      { product: "observer", instance: O1, current: true, level: "shared", includeHistory: false, setAt: SETAT },
    ];
    const mixed = await mount(h(mod.Accounts));
    const [catalog, fromNow] = notes(mixed.host);
    assert.match(catalog ?? "", /name and message count of every conversation of this bot, for the whole log Connect holds, and no message text\. You can stop sharing at any time\./u);
    assert.match(fromNow ?? "", /reads every conversation of this bot, but only the messages Connect received from the time you shared \(.+\); tick “Include the last 30 days” to add the older ones\. You can stop sharing at any time\./u);
    assert.equal(notes(mixed.host).length, 2, "one sentence under each app row");
    await mixed.unmount();

    stub.shares = [{ product: "knowledge", instance: K1, current: true, level: "shared", includeHistory: true, setAt: SETAT }];
    const history = await mount(h(mod.Accounts));
    assert.match(notes(history.host)[0] ?? "", /reads every conversation of this bot: the last 30 days Connect already holds and every new message\. You can stop sharing at any time\./u);
    await history.unmount();
  });
});

describe("Accounts page: a share is bound to one installed app (C240)", () => {
  const NOTHING = "This app sees nothing of this connection. Pick a level to share; you can revoke it at any time.";
  const K2 = "ins_01HZKNWDG20000000000000000";
  const reset = () => {
    stub.entries = [];
    stub.shares = [];
    stub.dataApps = DEFAULT_APPS();
    stub.callersKnown = true;
    stub.sent = [];
  };
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, "element to click");
    await act(async () => (el as HTMLElement).click());
    await flush();
  };
  /** open the kit Select with this aria-label and choose the option whose text starts with `label` */
  const choose = async (host: Element, aria: string, label: string) => {
    await click(host.querySelector(`[aria-label="${aria}"]`));
    const listbox = host.querySelector(`[aria-label="${aria}"]`)?.parentElement?.querySelector('[role="listbox"]');
    const option = [...(listbox?.querySelectorAll('[role="option"]') ?? [])].find((o) => (o.textContent ?? "").startsWith(label));
    await click(option);
  };
  const button = (host: Element, aria: string) => host.querySelector(`button[aria-label="${aria}"]`);

  it("a share from before migration 0013 (no instance) serves nobody: Share again on its row, one page notice, and Stop sharing clears it", async () => {
    reset();
    // the exact shape accounts_overview returns for such a row (data-ops.test.ts: "a share row from before migration 0013")
    stub.shares = [
      { product: "knowledge", instance: null, current: false, level: "shared", includeHistory: true, setAt: SETAT },
      { product: "observer", instance: null, current: false, level: "available", includeHistory: false, setAt: SETAT },
    ];
    const page = await mount(h(mod.Accounts));
    const SHARE_AGAIN = "Share again — this app must be chosen again after the update.";
    assert.deepEqual(notes(page.host), [NOTHING, SHARE_AGAIN, NOTHING, SHARE_AGAIN]);
    const status = [...page.host.querySelectorAll('[role="status"]')].map((n) => (n.textContent ?? "").replace(/\s+/gu, " ").trim());
    assert.ok(status.includes("Connect was updated. 2 app shares must be chosen again: look for “Share again” below. Until then that app gets nothing."), JSON.stringify(status));
    await click(button(page.host, "Stop sharing Support bot with Knowledge"));
    assert.deepEqual(stub.sent, [{ account: "cna_1", product: "knowledge", level: "none", includeHistory: false }]);
    await page.unmount();
    // quiet on good: bound, listed shares give no update notice, no Share again, no Stop sharing button
    reset();
    stub.shares = [{ product: "knowledge", instance: K1, current: true, level: "shared", includeHistory: true, setAt: SETAT }];
    const good = await mount(h(mod.Accounts));
    assert.doesNotMatch(text(good.host), /Connect was updated|Share again|Stop sharing|no longer in your workspace list/u);
    await good.unmount();
  });

  it("a share bound to an instance that is no longer listed says it can no longer read; its level is read-only; it can be stopped or moved by button only", async () => {
    reset();
    stub.shares = [{ product: "knowledge", instance: K1, current: false, level: "shared", includeHistory: true, setAt: SETAT }];
    stub.dataApps = [{ product: "knowledge", name: "Knowledge", instances: [inst(K2, "Knowledge")] }];
    const page = await mount(h(mod.Accounts));
    const levelSelect = page.host.querySelector('[aria-label="Share Support bot with Knowledge"]') as HTMLButtonElement | null;
    assert.equal(levelSelect?.textContent, "Share messages (read only)", "the stored level shows");
    assert.equal(levelSelect?.disabled, true, "no level change moves the share silently");
    assert.deepEqual(notes(page.host), ["This app instance was removed; it can no longer read."]);
    await click(button(page.host, "Share Support bot with the installed Knowledge instead"));
    await click(button(page.host, "Stop sharing Support bot with Knowledge"));
    // moving is a new share: history unticked; stopping needs no instance
    assert.deepEqual(stub.sent, [
      { account: "cna_1", product: "knowledge", level: "shared", includeHistory: false, instance: K2 },
      { account: "cna_1", product: "knowledge", level: "none", includeHistory: false },
    ]);
    await page.unmount();
    // the same with no instance listed at all: Stop sharing is still there (the old grant may still read)
    reset();
    stub.shares = [{ product: "knowledge", instance: K1, current: false, level: "available", includeHistory: false, setAt: SETAT }];
    stub.dataApps = [{ product: "knowledge", name: "Knowledge", instances: [] }];
    const none = await mount(h(mod.Accounts));
    assert.ok(button(none.host, "Stop sharing Support bot with Knowledge"));
    assert.deepEqual(notes(none.host), ["This app instance was removed; it can no longer read."]);
    assert.equal(button(none.host, "Share Support bot with the installed Knowledge instead"), null);
    assert.doesNotMatch(text(none.host), /Install Knowledge/u);
    await none.unmount();
  });

  it("sends the right instance: the bound one for level and history changes, the picked one for a new share, and a move unticks history", async () => {
    reset();
    stub.dataApps = [{ product: "knowledge", name: "Knowledge", instances: [inst(K1, "Knowledge"), inst(K2, "Knowledge", true)] }];
    stub.shares = [{ product: "knowledge", instance: K2, current: true, level: "shared", includeHistory: true, setAt: SETAT }];
    const live = await mount(h(mod.Accounts));
    const which = live.host.querySelector('[aria-label="Which Knowledge gets Support bot"]');
    assert.match(which?.textContent ?? "", /Knowledge · your own server · …000000/u, "the picker shows the bound instance, with where it runs");
    await choose(live.host, "Share Support bot with Knowledge", "Names and counts only");
    await click(live.host.querySelector('input[aria-label="Include the last 30 days of Support bot for Knowledge"]'));
    await choose(live.host, "Which Knowledge gets Support bot", "Knowledge · railway");
    assert.deepEqual(stub.sent, [
      { account: "cna_1", product: "knowledge", level: "available", includeHistory: true, instance: K2 },
      { account: "cna_1", product: "knowledge", level: "shared", includeHistory: false, instance: K2 },
      { account: "cna_1", product: "knowledge", level: "shared", includeHistory: false, instance: K1 },
    ]);
    await live.unmount();
    // no share yet: pick the second instance, then a level: the picked one is sent
    reset();
    stub.dataApps = [{ product: "knowledge", name: "Knowledge", instances: [inst(K1, "Knowledge"), inst(K2, "Knowledge", true)] }];
    const fresh = await mount(h(mod.Accounts));
    await choose(fresh.host, "Which Knowledge gets Support bot", "Knowledge · your own server");
    assert.equal(stub.sent.length, 0, "picking alone shares nothing");
    assert.ok(notes(fresh.host).includes("This Knowledge runs on your own server. Connect cannot check the code that runs there. Share only if you trust that server."));
    await choose(fresh.host, "Share Support bot with Knowledge", "Share messages");
    assert.deepEqual(stub.sent, [{ account: "cna_1", product: "knowledge", level: "shared", includeHistory: false, instance: K2 }]);
    await fresh.unmount();
  });

  it("moving an unlisted share to an instance on the owner's own server says so on the button and in the note", async () => {
    reset();
    stub.shares = [{ product: "knowledge", instance: K1, current: false, level: "available", includeHistory: false, setAt: SETAT }];
    stub.dataApps = [{ product: "knowledge", name: "Knowledge", instances: [inst(K2, "Knowledge lab", true)] }];
    const page = await mount(h(mod.Accounts));
    assert.ok(notes(page.host).includes("This Knowledge runs on your own server. Connect cannot check the code that runs there. Share only if you trust that server."));
    const move = button(page.host, "Share Support bot with the installed Knowledge (your own server) instead");
    assert.equal(move?.textContent, "Share with the installed Knowledge (your own server) instead");
    await click(move);
    assert.deepEqual(stub.sent, [{ account: "cna_1", product: "knowledge", level: "available", includeHistory: false, instance: K2 }]);
    await page.unmount();
  });

  it("the update notice counts only rows the page shows, and on an old SDK it does not point at a Share again it cannot offer", async () => {
    reset();
    stub.shares = [{ product: "knowledge", instance: null, current: false, level: "shared", includeHistory: false, setAt: SETAT }];
    stub.callersKnown = false;
    const old = await mount(h(mod.Accounts));
    const status = [...old.host.querySelectorAll('[role="status"]')].map((n) => (n.textContent ?? "").replace(/\s+/gu, " ").trim());
    assert.ok(status.includes("Connect was updated. 1 app share must be chosen again after the next Connect update. Until then that app gets nothing."), JSON.stringify(status));
    assert.doesNotMatch(text(old.host), /Share again —|look for “Share again”/u);
    await old.unmount();
  });

  it("on an SDK that cannot list the apps, a bound share is not called removed: it says an update is needed and can be stopped", async () => {
    reset();
    stub.callersKnown = false;
    stub.dataApps = [{ product: "knowledge", name: "Knowledge", instances: [] }];
    stub.shares = [{ product: "knowledge", instance: K1, current: false, level: "shared", includeHistory: true, setAt: SETAT }];
    const page = await mount(h(mod.Accounts));
    assert.deepEqual(notes(page.host), ["Sharing with apps needs the next Connect update."]);
    assert.equal((page.host.querySelector('[aria-label="Share Support bot with Knowledge"]') as HTMLButtonElement | null)?.disabled, true);
    assert.ok(button(page.host, "Stop sharing Support bot with Knowledge"));
    await page.unmount();
  });

  it("not installed, an old SDK, and the quiet good case each say exactly what is true", async () => {
    reset();
    stub.dataApps = [{ product: "knowledge", name: "Knowledge", instances: [] }];
    const missing = await mount(h(mod.Accounts));
    assert.deepEqual(notes(missing.host), [NOTHING, "Install Knowledge in your workspace to share this account with it."]);
    await missing.unmount();
    reset();
    stub.callersKnown = false;
    stub.dataApps = [{ product: "knowledge", name: "Knowledge", instances: [] }];
    const old = await mount(h(mod.Accounts));
    assert.deepEqual(notes(old.host), [NOTHING, "Sharing with apps needs the next Connect update."]);
    await old.unmount();
    reset();
    const quiet = await mount(h(mod.Accounts));
    assert.deepEqual(notes(quiet.host), [NOTHING, NOTHING], "no reinstall, install, update or own-server note on the good case");
    assert.equal(quiet.host.querySelector('[aria-label="Which Knowledge gets Support bot"]'), null, "one instance: no choice");
    await quiet.unmount();
  });
});

describe("Accounts page: Recent access", () => {
  it("shows the empty state when no app has asked", async () => {
    stub.shares = [];
    stub.entries = [];
    const page = await mount(h(mod.Accounts));
    assert.ok(page.host.querySelector("#recent-access"), "the section is there for a chat account");
    assert.match(text(page.host), /No app has asked for your chat messages yet\./u);
    assert.equal(rowsOf(page.host).length, 0);
    assert.match(text(page.host), /Connect keeps this record for 90 days/u);
    await page.unmount();
  });

  it("lists served and refused calls, newest first, with the repeat counter and no message text", async () => {
    stub.entries = [
      entry(4, { op: "data_pull", ok: false, outcome: "not_found", product: "observer", app: "Observer", rows: 0, repeats: 4 }),
      entry(3, { op: "data_catalog", rows: 0 }),
      entry(2, { op: "data_pull", rows: 7 }),
      entry(1, { op: "data_pull", ok: false, outcome: "caller_unverified", callerType: "app", product: null, app: null, account: null, rows: 0 }),
    ];
    const page = await mount(h(mod.Accounts));
    const rows = rowsOf(page.host).map((r) => [...r.querySelectorAll("td")].map((c) => (c.textContent ?? "").replace(/\s+/gu, " ").trim()));
    assert.equal(rows.length, 4);
    // columns: when, app, request, account, messages, result
    assert.deepEqual(rows[0]?.slice(1), ["Observer", "Read messages", "Support bot", "", "Refused: Not shared with this app and 4 more in the same minute"]);
    assert.deepEqual(rows[1]?.slice(1), ["Knowledge", "Read names and counts", "Support bot", "", "Served"]);
    assert.deepEqual(rows[2]?.slice(1), ["Knowledge", "Read messages", "Support bot", "7", "Served"]);
    assert.deepEqual(rows[3]?.slice(1), ["Unverified app", "Read messages", "", "", "Refused: Unverified app"]);
    assert.ok(rows.every((r) => (r[0] ?? "") !== ""), "every line has a time");
    await page.unmount();
  });
});

describe("Accounts page: agent access is the owner's own, offers need an explicit accept (C283 A1 / C283d)", () => {
  const buttons = (host: Element, name: RegExp) => [...host.querySelectorAll("button")].filter((b) => name.test(b.textContent ?? ""));
  const click = async (b: Element | undefined) => {
    assert.ok(b, "button");
    await act(async () => (b as HTMLButtonElement).click());
    await flush();
  };
  const reset = (rows: Record<string, unknown>[]) => {
    stub.entries = [];
    stub.shares = [];
    stub.dataApps = DEFAULT_APPS();
    stub.callersKnown = true;
    stub.agentRows = rows;
    stub.scopeSets = [];
    stub.offerChanged = false;
    stub.ownerRowsEffective = true;
  };

  it("names levels by their CRUD set, never a bare Update", async () => {
    reset([{ type: "account", instanceId: "cna_1", access: "read_update", authority: "owner" }]);
    const p = await mount(h(mod.Accounts));
    assert.match(text(p.host), /Set in Connect: Front desk can read, create and update on this account, also where the Portal grant allows less\./u);
    assert.doesNotMatch(text(p.host), /READ\/UPDATE/u);
    await p.unmount();
  });

  it("shows offer.adds and sends acceptOffer only on the owner's click, at the row's own level", async () => {
    reset([{ type: "account", instanceId: "cna_1", access: "read_update", authority: "owner", offer: { adds: ["delete", "create"] } }]);
    const p = await mount(h(mod.Accounts));
    assert.match(text(p.host), /This level now also allows create, delete\. Front desk cannot use it until you accept\./u);
    assert.deepEqual(stub.scopeSets, [], "nothing is accepted without a click");
    await click(buttons(p.host, /^Accept create, delete$/u)[0]);
    assert.deepEqual(stub.scopeSets, [{ agent: "agt_1", type: "account", id: "cna_1", access: "read_update", acceptOffer: { adds: ["create", "delete"] } }]);
    await p.unmount();
  });

  it("a changed offer (409 offer_changed) is said plainly and the list is read again", async () => {
    reset([{ type: "account", instanceId: "cna_1", access: "read", authority: "owner", offer: { adds: ["create"] } }]);
    stub.offerChanged = true;
    const p = await mount(h(mod.Accounts));
    await click(buttons(p.host, /^Accept create$/u)[0]);
    assert.match(text(p.host), /Front desk: The offer changed\. Check the new offer, then accept again\./u);
    await p.unmount();
  });

  it("QA-CON060-1: while the bridge does not admit owner rows, the page says the setting is saved and takes effect after the bridge update", async () => {
    reset([
      { type: "account", instanceId: "cna_1", access: "read_update", authority: "owner" },
    ]);
    stub.ownerRowsEffective = false;
    const p = await mount(h(mod.Accounts));
    assert.match(text(p.host), /Your setting is saved\. It takes effect after the bridge update to 0\.2\.4; until then the Portal grant still limits Front desk\./u);
    assert.match(text(p.host), /Above the Portal grant it takes effect after the bridge update to 0\.2\.4/u);
    assert.doesNotMatch(text(p.host), /Set in Connect: Front desk can/u);
    await p.unmount();
    reset([{ type: "account", instanceId: "cna_1", access: "read", authority: "bounded" }]);
    stub.ownerRowsEffective = false;
    const b = await mount(h(mod.Accounts));
    assert.match(text(b.host), /If you use this access, Connect saves it as Front desk's own access \(read\); above the Portal grant it takes effect after the bridge update to 0\.2\.4\./u);
    await b.unmount();
  });

  it("a bounded row becomes the owner's own only on 'Use this access' (same level, no acceptOffer)", async () => {
    reset([{ type: "account", instanceId: "cna_1", access: "read", authority: "bounded" }]);
    const p = await mount(h(mod.Accounts));
    assert.match(text(p.host), /Front desk's Portal grant may allow less than this level\. If you use this access, Front desk can read on this account, also where the Portal grant allows less\./u);
    assert.deepEqual(stub.scopeSets, []);
    await click(buttons(p.host, /^Use this access$/u)[0]);
    assert.deepEqual(stub.scopeSets, [{ agent: "agt_1", type: "account", id: "cna_1", access: "read" }]);
    await p.unmount();
  });
});
