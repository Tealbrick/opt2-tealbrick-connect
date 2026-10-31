// The filter on the long lists of the Accounts page (Recent access) and the Chat bots page (C382 batch 4). The server
// sends the last 100 calls and has no filter or page, so the filter is the page's: it reads those calls, the page shows
// 25 at a time, and at 100 the bar says older calls are not in the list. Compiled with the build tsconfig and rendered
// in happy-dom against a stub server.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-access-chat-filter");

const win = new Window({ url: "http://localhost/a/connect/", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "localStorage", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

const entry = (n: number) => ({
  id: n,
  at: "2026-10-18T09:15:00.000Z",
  op: "data_pull",
  callerType: "app",
  product: n % 2 ? "knowledge" : "observer",
  app: n % 2 ? "Knowledge" : "Observer",
  account: "Support bot",
  ok: true,
  outcome: "ok",
  rows: n,
  repeats: 0,
});
const bot = (n: number) => ({ id: `cna_${n}`, service: n % 2 ? "telegram" : "slack", source: "channel", kind: "as_itself", label: `Bot ${String(n).padStart(2, "0")}`, ownerAgent: "agt_1", status: "connected", detail: "", shares: [], bot: { id: `b${n}`, name: `helper${n}`, inbound: "connected", detail: "", unmatchedChanges: 0, notStored: 0 } });
const stub = { entries: [] as ReturnType<typeof entry>[], bots: [] as ReturnType<typeof bot>[] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  if (url.pathname.endsWith("/ops.json")) return json(200, { operations: [] });
  const path = url.pathname.replace("/a/connect/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (op === "accounts_overview") return json(200, { status: "ok", output: { accounts: [bot(1)], dataApps: [], callersKnown: true } });
  if (op === "data_access_log") return json(200, { status: "ok", output: { entries: stub.entries } });
  if (op === "channel_accounts") return json(200, { status: "ok", output: { accounts: stub.bots } });
  if (op === "channel_providers") return json(200, { status: "ok", output: { services: [], agents: [] } });
  if (op === "tb.agents_list") return json(200, { status: "ok", output: { agents: [] } });
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
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  await flush();
};
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  });
};
const text = (host: Element) => (host.textContent ?? "").replace(/\s+/gu, " ");
const buttons = (host: Element, label: RegExp) => [...host.querySelectorAll("button")].filter((b) => label.test((b.textContent ?? "").trim()));
const filterInput = (host: Element) => host.querySelector(".tb-listfilter input") as HTMLInputElement | null;
const rowsOf = (host: Element) => host.querySelectorAll("section[aria-labelledby=recent-access] tbody tr").length;
const KEY = "tb-filter:/a/connect/:";

let accounts: typeof import("../src/ui/pages/Accounts.tsx");
let chat: typeof import("../src/ui/pages/Chat.tsx");
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  accounts = (await import(pathToFileURL(join(outDir, "ui", "pages", "Accounts.js")).href)) as typeof accounts;
  chat = (await import(pathToFileURL(join(outDir, "ui", "pages", "Chat.js")).href)) as typeof chat;
});
after(() => rmSync(outDir, { recursive: true, force: true }));

const calls = (n: number) => Array.from({ length: n }, (_, i) => entry(n - i));
const reset = (n: number) => {
  localStorage.clear();
  stub.entries = calls(n);
};

describe("Recent access: filter and 25 rows at a time", () => {
  it("a short list stays as it is: no filter, no Show more", async () => {
    reset(3);
    const m = await mount(h(accounts.Accounts));
    assert.equal(filterInput(m.host), null);
    assert.equal(rowsOf(m.host), 3);
    assert.equal(buttons(m.host, /^Show \d+ more$/u).length, 0);
    assert.doesNotMatch(text(m.host), /Listing/u);
    await m.unmount();
  });

  it("a long list shows 25 rows, says what is shown, and Show more reaches every row", async () => {
    reset(60);
    const m = await mount(h(accounts.Accounts));
    assert.equal(rowsOf(m.host), 25);
    assert.match(text(m.host), /Listing 25 of 60 calls\./u);
    await click(buttons(m.host, /^Show 25 more$/u)[0] as Element);
    assert.equal(rowsOf(m.host), 50);
    assert.match(text(m.host), /Listing 50 of 60 calls\./u);
    await click(buttons(m.host, /^Show 10 more$/u)[0] as Element);
    assert.equal(rowsOf(m.host), 60);
    assert.match(text(m.host), /Listing 60 of 60 calls\./u);
    assert.equal(buttons(m.host, /^Show \d+ more$/u).length, 0);
    await m.unmount();
  });

  it("the filter narrows, says N of M, goes back to the first 25, and Clear restores", async () => {
    reset(60);
    const m = await mount(h(accounts.Accounts));
    await click(buttons(m.host, /^Show 25 more$/u)[0] as Element);
    await type(filterInput(m.host) as HTMLInputElement, "Observer");
    assert.match(text(m.host), /Showing 30 of 60 calls\./u);
    assert.doesNotMatch(text(m.host), /loaded so far/u, "60 calls is a complete list of what the server sends");
    assert.equal(rowsOf(m.host), 25, "a new filter starts at the first 25");
    assert.match(text(m.host), /Listing 25 of 30 calls that match\./u);
    await type(filterInput(m.host) as HTMLInputElement, "^Knowledge$");
    assert.match(text(m.host), /Showing 30 of 60 calls\./u);
    await click(buttons(m.host, /^Clear filter$/u)[0] as Element);
    assert.equal(rowsOf(m.host), 25);
    assert.match(text(m.host), /Listing 25 of 60 calls\./u);
    assert.equal(localStorage.getItem(`${KEY}accounts:recent-access`), "");
    await m.unmount();
  });

  it("nothing found on a complete list says all calls were searched", async () => {
    reset(60);
    const m = await mount(h(accounts.Accounts));
    await type(filterInput(m.host) as HTMLInputElement, "zzz");
    assert.equal(rowsOf(m.host), 0);
    assert.match(text(m.host), /No call matches\. The filter searched all 60 calls\./u);
    await m.unmount();
  });

  it("at the server's limit of 100 the filter says it reads only the calls in the list and that older calls are not searched", async () => {
    reset(100);
    const m = await mount(h(accounts.Accounts));
    await type(filterInput(m.host) as HTMLInputElement, "zzz");
    assert.match(text(m.host), /Showing 0 of 100 loaded calls\./u);
    assert.match(text(m.host), /The filter searches only the 100 calls loaded so far\./u);
    assert.match(text(m.host), /No loaded call matches\./u);
    assert.match(text(m.host), /This list holds only the last 100 calls\. Older calls cannot be searched here\./u);
    await m.unmount();
  });

  it("a remembered filter shows after a remount, even for a short list", async () => {
    reset(3);
    localStorage.setItem(`${KEY}accounts:recent-access`, "Observer");
    const m = await mount(h(accounts.Accounts));
    assert.equal(filterInput(m.host)?.value, "Observer");
    assert.match(text(m.host), /Showing 1 of 3 calls\./u);
    assert.equal(rowsOf(m.host), 1);
    await m.unmount();
  });
});

describe("Chat bots: filter", () => {
  const setBots = (n: number) => {
    localStorage.clear();
    stub.bots = Array.from({ length: n }, (_, i) => bot(i + 1));
  };
  const items = (host: Element) => host.querySelectorAll(".ruled .item").length;

  it("a short list shows no filter", async () => {
    setBots(3);
    const m = await mount(h(chat.Chat));
    assert.equal(filterInput(m.host), null);
    assert.equal(items(m.host), 3);
    await m.unmount();
  });

  it("narrows by name, bot name and service, says N of M chat bots, Clear restores", async () => {
    setBots(10);
    const m = await mount(h(chat.Chat));
    assert.equal(items(m.host), 10);
    await type(filterInput(m.host) as HTMLInputElement, "^Bot 0[12]$");
    assert.equal(items(m.host), 2);
    assert.match(text(m.host), /Showing 2 of 10 chat bots\./u);
    await type(filterInput(m.host) as HTMLInputElement, "helper10");
    assert.equal(items(m.host), 1);
    await type(filterInput(m.host) as HTMLInputElement, "slack");
    assert.equal(items(m.host), 5);
    await click(buttons(m.host, /^Clear filter$/u)[0] as Element);
    assert.equal(items(m.host), 10);
    await m.unmount();
  });

  it("nothing found says all bots were searched; a remembered filter shows after a remount", async () => {
    setBots(10);
    localStorage.setItem(`${KEY}chat-bots`, "zzz");
    const m = await mount(h(chat.Chat));
    assert.equal(filterInput(m.host)?.value, "zzz");
    assert.equal(items(m.host), 0);
    assert.match(text(m.host), /No chat bot matches\. The filter searched all 10 chat bots\./u);
    await m.unmount();
  });
});
