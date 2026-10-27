// The Accounts page for database accounts (C336 RQ-3) against the real SDK client and a stub server: the add form, the share
// with its route, no agent access, the lease list with "End lease", and the lease line of the access list. The page is compiled
// with the build tsconfig into dist/ui-test-database and rendered in happy-dom.
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
const outDir = join(root, "dist", "ui-test-database");
const CANARY = "CANARY-pw-ui-4d2b9e";

const win = new Window({ url: "http://localhost/a/connect/", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "HTMLInputElement", "HTMLFormElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

const K1 = "ins_01HZKNWDG00000000000000000";
const O1 = "ins_01HZ0BSRVR0000000000000000";
const SETAT = "2026-10-17T10:00:00.000Z";
type Share = { product: string; instance: string | null; current: boolean; level: "available" | "shared"; includeHistory: boolean; setAt: string; route?: "direct" | "via_observer" };
type Lease = { id: string; account: string; accountLabel: string; product: string; app: string; datasets: string[]; issuedAt: string; expiresAt: string; revokedAt: string | null; state: "active" | "revoked" | "expired" };
const stub: { shares: Share[]; leases: Lease[]; sent: { op: string; input: Record<string, unknown> }[]; connectFails: boolean; entries: Record<string, unknown>[]; withDatabase: boolean; leasesEnabled: boolean; asked: string[] } = {
  shares: [],
  leases: [],
  sent: [],
  connectFails: false,
  entries: [],
  withDatabase: true,
  // the shipped Connect has no lease operations (C354a); a test turns them on to check the kept page code
  leasesEnabled: false,
  asked: [],
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let sslmodeShown: string | undefined;
const database = () => ({ id: "cdb_1", service: "postgres", source: "database", kind: "as_me", label: "Shop DB", ownerAgent: null, status: "connected", detail: "", endpoint: "db.example.com:5432/shop", ...(sslmodeShown ? { sslmode: sslmodeShown } : {}), shares: stub.shares });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  if (url.pathname.endsWith("/ops.json")) return json(200, { operations: [] });
  const path = url.pathname.replace("/a/connect/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (op) stub.asked.push(op);
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Record<string, unknown> };
  const sent = (): void => void stub.sent.push({ op: String(op), input: body.input ?? (body as Record<string, unknown>) });
  if (op === "accounts_overview") {
    return json(200, {
      status: "ok",
      output: {
        accounts: stub.withDatabase ? [database()] : [],
        dataApps: [
          { product: "knowledge", name: "Knowledge", instances: [{ instance: K1, name: "Knowledge", provider: "railway", ownInfra: false }] },
          { product: "observer", name: "Observer", instances: [{ instance: O1, name: "Observer", provider: "railway", ownInfra: false }] },
        ],
        callersKnown: true,
        databaseRecommendation: "Use a dedicated read-only database user: SELECT only, no REPLICATION.",
        leasesEnabled: stub.leasesEnabled,
      },
    });
  }
  if (op === "account_app_share") {
    sent();
    return json(200, { status: "ok", output: { shares: stub.shares } });
  }
  if (op === "database_account_connect") {
    sent();
    return stub.connectFails ? json(422, { error: { code: "endpoint_not_allowed", message: "Endpoint is not allowed (address_not_allowed)." } }) : json(200, { status: "ok", output: { account: database(), recommendation: "x" } });
  }
  if (op === "data_leases_list") return json(200, { status: "ok", output: { leases: stub.leases } });
  if (op === "data_lease_revoke") {
    sent();
    return json(200, { status: "ok", output: { lease: body.input?.lease, state: "revoked" } });
  }
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

const text = (host: Element) => (host.textContent ?? "").replace(/\s+/gu, " ");
/** the cells of a table row, separated, so a pattern can tell them apart */
const cells = (row: Element) => [...row.querySelectorAll("td")].map((td) => text(td)).join(" | ");
const notes = (host: Element) => [...host.querySelectorAll(".acc-note")].map((n) => n.textContent ?? "");
const click = async (el: Element | null | undefined) => {
  assert.ok(el, "element to click");
  await act(async () => (el as HTMLElement).click());
  await flush();
};
const choose = async (host: Element, aria: string, label: string) => {
  await click(host.querySelector(`[aria-label="${aria}"]`));
  const listbox = host.querySelector(`[aria-label="${aria}"]`)?.parentElement?.querySelector('[role="listbox"]');
  const option = [...(listbox?.querySelectorAll('[role="option"]') ?? [])].find((o) => (o.textContent ?? "").startsWith(label));
  await click(option);
};
const sentInputs = () => stub.sent.map((s) => s.input);
const reset = () => {
  stub.shares = [];
  stub.leases = [];
  stub.sent = [];
  stub.entries = [];
  stub.connectFails = false;
  stub.withDatabase = true;
  stub.leasesEnabled = false;
  stub.asked = [];
};
const lease = (n: number, extra: Partial<Lease> = {}): Lease => ({ id: `lse_${n}`, account: "cdb_1", accountLabel: "Shop DB", product: "knowledge", app: "Knowledge", datasets: ["public.customers", "public.orders"], issuedAt: "2026-10-18T09:00:00.000Z", expiresAt: "2026-10-18T09:05:00.000Z", revokedAt: null, state: "active", ...extra });

describe("Accounts page: database accounts (C336 RQ-3)", () => {
  it("lists the database with its endpoint, no agent access, no tool refresh; says what each level and route gives", async () => {
    reset();
    const none = await mount(h(mod.Accounts));
    assert.match(text(none.host), /db\.example\.com:5432\/shop \(Postgres\)\. Agents never see this account/u);
    assert.doesNotMatch(text(none.host), /Agent access/u);
    assert.equal(none.host.querySelector('button[aria-label="Refresh tools of postgres"]'), null);
    assert.equal(none.host.querySelector('[aria-label="Which Knowledge gets Shop DB"]'), null, "one instance: no instance picker");
    assert.deepEqual(notes(none.host), ["This app sees nothing of this database. Pick a level to share; you can revoke it at any time.", "This app sees nothing of this database. Pick a level to share; you can revoke it at any time."]);
    // C373: the dataset is named once, in plain words
    assert.match(text(none.host), /Dataset: documents\. Each table is a collection; every 200 rows are one document\./u);
    await none.unmount();

    stub.shares = [{ product: "observer", instance: O1, current: true, level: "available", includeHistory: false, setAt: SETAT, route: "direct" }];
    const mixed = await mount(h(mod.Accounts));
    const observerNote = notes(mixed.host)[1];
    assert.match(observerNote ?? "", /names of the tables and views, their columns and types, and about how many rows each holds\. It sees no values\./u);
    assert.doesNotMatch(text(mixed.host), /lease/iu, "C354a: nothing on the page speaks of leases while Connect offers none");
    // C373: the share menu offers the rows as documents
    await click(mixed.host.querySelector('[aria-label="Share Shop DB with Observer"]'));
    const labels = [...(mixed.host.querySelector('[aria-label="Share Shop DB with Observer"]')?.parentElement?.querySelectorAll('[role="option"]') ?? [])].map((o) => (o.textContent ?? "").trim());
    assert.deepEqual(labels, ["Not shared", "Table names only", "Share rows as documents (read only)"]);
    await mixed.unmount();

    stub.shares = [{ product: "observer", instance: O1, current: true, level: "shared", includeHistory: false, setAt: SETAT, route: "direct" }];
    const rows = await mount(h(mod.Accounts));
    assert.match(notes(rows.host)[1] ?? "", /reads the rows of every table and view, 200 rows per document, in a read-only transaction/u);
    assert.match(notes(rows.host)[1] ?? "", /looks like a secret \(password, token, key\) are left out; this is a guess by name, so check your tables/u);
    await rows.unmount();

    stub.shares = [{ product: "knowledge", instance: K1, current: true, level: "available", includeHistory: false, setAt: SETAT, route: "via_observer" }];
    const routed = await mount(h(mod.Accounts));
    assert.match(notes(routed.host)[0] ?? "", /Knowledge reads this database only through Observer\. Share it with Observer too/u);
    await routed.unmount();
  });

  it("QA-CONNECT35-11: a connection without encryption (sslmode disable) shows a plain warning; an encrypted one does not", async () => {
    reset();
    sslmodeShown = "disable";
    const open = await mount(h(mod.Accounts));
    assert.match(text(open.host), /Connection: .*\./u);
    assert.match(text(open.host), /The connection to this database is not encrypted\. The password and the rows that you share travel in clear text\./u);
    await open.unmount();
    sslmodeShown = "verify-full";
    const safe = await mount(h(mod.Accounts));
    assert.doesNotMatch(text(safe.host), /not encrypted/u);
    await safe.unmount();
    sslmodeShown = undefined;
  });

  it("C322(6): sends the route with the share: via_observer for Knowledge, direct for Observer; no route select; a chat share sends none", async () => {
    reset();
    const page = await mount(h(mod.Accounts));
    assert.equal(page.host.querySelector('[aria-label="How Knowledge reaches Shop DB"]'), null, "the direct route is not offered");
    await choose(page.host, "Share Shop DB with Knowledge", "Table names only");
    assert.deepEqual(stub.sent, [{ op: "account_app_share", input: { account: "cdb_1", product: "knowledge", level: "available", includeHistory: false, instance: K1, route: "via_observer" } }]);
    await page.unmount();

    stub.sent = [];
    stub.shares = [{ product: "knowledge", instance: K1, current: true, level: "available", includeHistory: false, setAt: SETAT, route: "via_observer" }];
    const shared = await mount(h(mod.Accounts));
    assert.equal(shared.host.querySelector('[aria-label="How Knowledge reaches Shop DB"]'), null);
    assert.equal(shared.host.querySelector('input[type="checkbox"]'), null, "no 30-day history for a database");
    await choose(shared.host, "Share Shop DB with Observer", "Share rows as documents (read only)");
    assert.deepEqual(stub.sent, [{ op: "account_app_share", input: { account: "cdb_1", product: "observer", level: "shared", includeHistory: false, instance: O1, route: "direct" } }]);
    await shared.unmount();
  });

  it("the add form shows the advice, sends the fields once, never shows the password again and says a refusal plainly", async () => {
    reset();
    stub.withDatabase = false;
    const page = await mount(h(mod.Accounts));
    assert.match(text(page.host), /Databases/u);
    assert.doesNotMatch(text(page.host), /Use a dedicated read-only database user/u, "advice shows with the form");
    await click([...page.host.querySelectorAll("button")].find((b) => b.textContent === "Add a database"));
    assert.match(text(page.host), /Use a dedicated read-only database user: SELECT only, no REPLICATION\. Connect refuses a superuser or a replication role, and it connects only to public addresses\./u);
    const form = page.host.querySelector('form[aria-label="Add a database"]') as HTMLFormElement;
    assert.ok(form);
    const type = async (label: string, value: string) => {
      const field = [...form.querySelectorAll("label")].find((l) => (l.textContent ?? "").trim().startsWith(label));
      const input = (field?.querySelector("input") ?? form.querySelector(`input[aria-label="${label}"]`)) as HTMLInputElement | null;
      assert.ok(input, label);
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
        setter?.call(input, value);
        input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
      });
    };
    const submit = async () => {
      await act(async () => form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
      await flush();
    };
    // empty: nothing is sent
    await submit();
    assert.match(text(page.host), /Fill in the name, host, database, user and password\./u);
    assert.deepEqual(stub.sent, []);
    await type("Name", "Shop DB");
    await type("Host", "10.0.0.5");
    await type("Database", "shop");
    await type("User", "readonly");
    await type("Password", CANARY);
    assert.equal((form.querySelector('input[type="password"]') as HTMLInputElement).value, CANARY);
    stub.connectFails = true;
    await submit();
    assert.deepEqual(sentInputs(), [{ label: "Shop DB", host: "10.0.0.5", port: 5432, database: "shop", user: "readonly", password: CANARY, sslmode: "verify-full" }]);
    assert.match(text(page.host), /Endpoint is not allowed/u);
    assert.ok(!text(page.host).includes(CANARY), "the password is never printed");
    stub.connectFails = false;
    await submit();
    assert.equal(stub.sent.length, 2);
    // after the add the form is closed and empty; the notice says what to do next
    assert.equal(page.host.querySelector('form[aria-label="Add a database"]'), null);
    assert.match(text(page.host), /“Shop DB” is added\. Share it with an app below\./u);
    assert.ok(!page.host.innerHTML.includes(CANARY));
    await page.unmount();
  });

  it("QA-CON24-2: a refusal of the add form is scrolled into view and takes focus (also the same refusal twice and a form that is incomplete)", async () => {
    reset();
    stub.withDatabase = false;
    stub.connectFails = true;
    const scrolled: Element[] = [];
    const proto = (globalThis as { HTMLElement: { prototype: { scrollIntoView?: (arg?: unknown) => void } } }).HTMLElement.prototype;
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      const page = await mount(h(mod.Accounts));
      await click([...page.host.querySelectorAll("button")].find((b) => b.textContent === "Add a database"));
      const form = page.host.querySelector('form[aria-label="Add a database"]') as HTMLFormElement;
      const submit = async () => {
        await act(async () => form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
        await flush();
      };
      const type = async (label: string, value: string) => {
        const input = [...form.querySelectorAll("label")].find((l) => (l.textContent ?? "").trim().startsWith(label))?.querySelector("input") as HTMLInputElement;
        await act(async () => {
          Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
          input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
        });
      };
      const alertBox = () => form.querySelector('[role="alert"]')?.parentElement as HTMLElement | null;
      // incomplete form
      await submit();
      assert.ok(alertBox(), "the notice is shown");
      assert.equal(document.activeElement, alertBox(), "focus moved to the notice");
      assert.equal(scrolled.at(-1), alertBox(), "the notice was scrolled into view");
      // a refusal from Connect
      for (const [label, value] of [["Name", "Shop DB"], ["Host", "10.0.0.5"], ["Database", "shop"], ["User", "readonly"], ["Password", CANARY]] as const) await type(label, value);
      (document.activeElement as HTMLElement | null)?.blur?.();
      scrolled.length = 0;
      await submit();
      assert.match(text(alertBox() as Element), /Endpoint is not allowed/u);
      assert.equal(document.activeElement, alertBox());
      assert.equal(scrolled.length, 1);
      // the same refusal again moves the reader to it again
      (document.activeElement as HTMLElement | null)?.blur?.();
      scrolled.length = 0;
      await submit();
      assert.equal(document.activeElement, alertBox(), "same text, focus again");
      assert.equal(scrolled.length, 1);
      await page.unmount();
    } finally {
      if (original) proto.scrollIntoView = original;
      else delete proto.scrollIntoView;
    }
  });

  it("when Connect offers leases (kept code): the level appears, the lease sentence is honest, the list shows no credential and an active lease can be ended", async () => {
    reset();
    stub.leasesEnabled = true;
    // C373: a `shared` database share gives rows as documents; the share sentence says that, not a lease
    stub.shares = [{ product: "observer", instance: O1, current: true, level: "shared", includeHistory: false, setAt: SETAT, route: "direct" }];
    const offered = await mount(h(mod.Accounts));
    assert.match(notes(offered.host)[1] ?? "", /200 rows per document/u);
    await offered.unmount();
    stub.leases = [lease(2), lease(1, { state: "revoked", revokedAt: "2026-10-18T09:01:00.000Z", datasets: ["a.b", "c.d", "e.f", "g.h", "i.j"] }), lease(0, { state: "expired" })];
    const page = await mount(h(mod.Accounts));
    const section = page.host.querySelector('section[aria-labelledby="data-leases"]') as Element;
    assert.ok(section);
    assert.match(text(section), /for at most 15 minutes\. Ending a lease marks it ended in Connect, but the password stays valid in your database\. To cut access at once, change that user’s password/u);
    const rows = [...section.querySelectorAll("tbody tr")].map(cells);
    assert.equal(rows.length, 3);
    assert.match(rows[0] ?? "", /^.+ \| Knowledge \| Shop DB \| public\.customers, public\.orders \| .+ \| Active \| End lease$/u);
    assert.match(rows[1] ?? "", /\| a\.b, c\.d, e\.f and 2 more \| .+ \| Ended by you \| $/u);
    assert.match(rows[2] ?? "", /\| Expired \| $/u);
    assert.equal(section.querySelectorAll("button[aria-label^='End the lease']").length, 1, "only an active lease can be ended");
    await click(section.querySelector("button[aria-label='End the lease of Knowledge on Shop DB']"));
    assert.deepEqual(stub.sent, [{ op: "data_lease_revoke", input: { lease: "lse_2" } }]);
    await page.unmount();
  });

  it("in the shipped Connect there is no lease section and the page never asks for the lease list (C354a)", async () => {
    reset();
    stub.leases = [lease(1)];
    const page = await mount(h(mod.Accounts));
    assert.equal(page.host.querySelector('section[aria-labelledby="data-leases"]'), null);
    assert.ok(!stub.asked.includes("data_leases_list"), stub.asked.join(","));
    await page.unmount();
  });

  it("the access list names a lease line: the tables and when the lease ends", async () => {
    reset();
    stub.leasesEnabled = true;
    stub.entries = [
      { id: 1, at: "2026-10-18T09:00:00.000Z", op: "data_lease", callerType: "app", product: "knowledge", app: "Knowledge", account: "Shop DB", ok: true, outcome: "ok", rows: 2, repeats: 0, leaseId: "lse_1", leaseExpiresAt: "2026-10-18T09:05:00.000Z", datasets: ["public.customers", "public.orders"] },
      { id: 2, at: "2026-10-18T09:00:00.000Z", op: "data_lease", callerType: "app", product: "knowledge", app: "Knowledge", account: "Shop DB", ok: false, outcome: "scope_denied", rows: 0, repeats: 0 },
    ];
    const page = await mount(h(mod.Accounts));
    const section = page.host.querySelector('section[aria-labelledby="recent-access"]') as Element;
    const rows = [...section.querySelectorAll("tbody tr")].map(cells);
    assert.match(rows[0] ?? "", /\| Knowledge \| Leased database access · lease ends .+ · public\.customers, public\.orders \| Shop DB \| {2}\| Served$/u);
    assert.match(rows[1] ?? "", /\| Leased database access \| Shop DB \| {2}\| Refused: Names and counts only$/u);
    await page.unmount();
  });

  it("disconnecting a database says its password is removed and every share and lease has ended", async () => {
    reset();
    const page = await mount(h(mod.Accounts));
    await click(page.host.querySelector('button[aria-label="Disconnect Shop DB"]'));
    assert.match(text(document.body), /Disconnect this database\?/u);
    assert.match(text(document.body), /removes the stored password and ends every share and lease of it/u);
    await page.unmount();
  });
});
