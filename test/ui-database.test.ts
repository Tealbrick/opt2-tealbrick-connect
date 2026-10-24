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
const stub: { shares: Share[]; leases: Lease[]; sent: { op: string; input: Record<string, unknown> }[]; connectFails: boolean; entries: Record<string, unknown>[]; withDatabase: boolean } = {
  shares: [],
  leases: [],
  sent: [],
  connectFails: false,
  entries: [],
  withDatabase: true,
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const database = () => ({ id: "cdb_1", service: "postgres", source: "database", kind: "as_me", label: "Shop DB", ownerAgent: null, status: "connected", detail: "", endpoint: "db.example.com:5432/shop", shares: stub.shares });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  if (url.pathname.endsWith("/ops.json")) return json(200, { operations: [] });
  const path = url.pathname.replace("/a/connect/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
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
    await none.unmount();

    stub.shares = [
      { product: "knowledge", instance: K1, current: true, level: "available", includeHistory: false, setAt: SETAT, route: "direct" },
      { product: "observer", instance: O1, current: true, level: "shared", includeHistory: false, setAt: SETAT, route: "direct" },
    ];
    const mixed = await mount(h(mod.Accounts));
    const [names, lease] = notes(mixed.host);
    assert.match(names ?? "", /names of the tables and views, their columns and types, and about how many rows each holds\. It sees no values\./u);
    assert.match(lease ?? "", /short lease \(up to 15 minutes\) on the read-only user you stored/u);
    assert.match(lease ?? "", /the password stays valid in your database until you change it there/u);
    await mixed.unmount();

    stub.shares = [{ product: "knowledge", instance: K1, current: true, level: "shared", includeHistory: false, setAt: SETAT, route: "via_observer" }];
    const routed = await mount(h(mod.Accounts));
    assert.match(notes(routed.host)[0] ?? "", /Knowledge gets nothing from this database\. Only Observer reads it/u);
    await routed.unmount();
  });

  it("sends the route with the share: direct by default, via_observer on choice; the route select is for Knowledge only and a chat share sends none", async () => {
    reset();
    const page = await mount(h(mod.Accounts));
    assert.equal(page.host.querySelector('[aria-label="How Knowledge reaches Shop DB"]'), null, "no route before a share");
    await choose(page.host, "Share Shop DB with Knowledge", "Allow read-only access");
    assert.deepEqual(stub.sent, [{ op: "account_app_share", input: { account: "cdb_1", product: "knowledge", level: "shared", includeHistory: false, instance: K1, route: "direct" } }]);
    await page.unmount();

    stub.sent = [];
    stub.shares = [
      { product: "knowledge", instance: K1, current: true, level: "shared", includeHistory: false, setAt: SETAT, route: "direct" },
      { product: "observer", instance: O1, current: true, level: "shared", includeHistory: false, setAt: SETAT, route: "direct" },
    ];
    const shared = await mount(h(mod.Accounts));
    assert.ok(shared.host.querySelector('[aria-label="How Knowledge reaches Shop DB"]'));
    assert.equal(shared.host.querySelector('[aria-label="How Observer reaches Shop DB"]'), null, "Observer has no route");
    assert.equal(shared.host.querySelector('input[type="checkbox"]'), null, "no 30-day history for a database");
    await choose(shared.host, "How Knowledge reaches Shop DB", "Only through Observer");
    assert.deepEqual(stub.sent, [{ op: "account_app_share", input: { account: "cdb_1", product: "knowledge", level: "shared", includeHistory: false, instance: K1, route: "via_observer" } }]);
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

  it("lists the leases without a credential, ends an active one on click, and says what ending means", async () => {
    reset();
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

  it("the access list names a lease line: the tables and when the lease ends", async () => {
    reset();
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
