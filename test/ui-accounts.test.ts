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
const K1 = "ins_01KNOWLEDGE00000000000000";
const O1 = "ins_01OBSERVER0000000000000000";
const inst = (instance: string, name: string, ownInfra = false): Inst => ({ instance, name, provider: ownInfra ? "own_infra" : "railway", ownInfra });
const DEFAULT_APPS = () => [
  { product: "knowledge", name: "Knowledge", instances: [inst(K1, "Knowledge")] },
  { product: "observer", name: "Observer", instances: [inst(O1, "Observer")] },
];
type Entry = { id: number; at: string; op: string; callerType: string; product: string | null; app: string | null; account: string | null; ok: boolean; outcome: string; rows: number; repeats: number };
const stub: { shares: Share[]; entries: Entry[]; dataApps: { product: string; name: string; instances: Inst[] }[] } = { shares: [], entries: [], dataApps: DEFAULT_APPS() };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const account = () => ({ id: "cna_1", service: "telegram", source: "channel", kind: "as_itself", label: "Support bot", ownerAgent: "agt_1", status: "connected", detail: "", shares: stub.shares });

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  if (url.pathname.endsWith("/ops.json")) return json(200, { operations: [] });
  const path = url.pathname.replace("/a/connect/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (op === "accounts_overview") return json(200, { status: "ok", output: { accounts: [account()], dataApps: stub.dataApps } });
  if (op === "data_access_log") return json(200, { status: "ok", output: { entries: stub.entries } });
  if (op === "tb.agents_list") return json(200, { status: "ok", output: { agents: [{ id: "agt_1", name: "Front desk", status: "active" }] } });
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
  it("a share whose app was reinstalled shows Not shared and asks to share again; a removed app says so", async () => {
    stub.entries = [];
    stub.shares = [{ product: "knowledge", instance: K1, current: false, level: "shared", includeHistory: true, setAt: SETAT }];
    stub.dataApps = [{ product: "knowledge", name: "Knowledge", instances: [inst("ins_01KNOWLEDGETWO00000000000000", "Knowledge")] }];
    const again = await mount(h(mod.Accounts));
    assert.deepEqual(notes(again.host), [NOTHING, "The Knowledge you shared with before was removed or installed again, so it gets nothing now. Pick a level to share with the installed Knowledge."]);
    await again.unmount();
    stub.dataApps = [{ product: "knowledge", name: "Knowledge", instances: [] }];
    const gone = await mount(h(mod.Accounts));
    assert.deepEqual(notes(gone.host), [NOTHING, "The Knowledge you shared with before was removed, so it gets nothing now."]);
    await gone.unmount();
  });

  it("an app that is not installed says how to share; a quiet page has no extra notes", async () => {
    stub.shares = [];
    stub.dataApps = [{ product: "knowledge", name: "Knowledge", instances: [] }];
    const missing = await mount(h(mod.Accounts));
    assert.deepEqual(notes(missing.host), [NOTHING, "Install Knowledge in your workspace to share this account with it."]);
    await missing.unmount();
    stub.dataApps = DEFAULT_APPS();
    const quiet = await mount(h(mod.Accounts));
    assert.deepEqual(notes(quiet.host), [NOTHING, NOTHING], "no reinstall, install or own-server note on the good case");
    await quiet.unmount();
  });

  it("names a target on the owner's own server (C240 item 3), and offers a choice when two are installed", async () => {
    stub.shares = [];
    stub.dataApps = [{ product: "knowledge", name: "Knowledge", instances: [inst(K1, "Knowledge", true)] }];
    const own = await mount(h(mod.Accounts));
    assert.deepEqual(notes(own.host), [NOTHING, "This Knowledge runs on your own server. Connect cannot check the code that runs there. Share only if you trust that server."]);
    assert.equal(own.host.querySelector('[aria-label="Which Knowledge gets Support bot"]'), null, "one instance: no choice");
    await own.unmount();
    stub.dataApps = [{ product: "knowledge", name: "Knowledge", instances: [inst(K1, "Knowledge"), inst("ins_01KNOWLEDGETWO00000000000000", "Knowledge lab", true)] }];
    const two = await mount(h(mod.Accounts));
    assert.ok(two.host.querySelector('[aria-label="Which Knowledge gets Support bot"]'), "two instances: the owner picks one");
    await two.unmount();
    stub.dataApps = DEFAULT_APPS();
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
