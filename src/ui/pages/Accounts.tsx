import { Button, Card, EmptyState, Field, Select, Table, Tag, TextInput } from "@opt2-tealbrick/ui";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { ConfirmDialog, KindBadge, LoadError, Notice, PageHead, ServiceTile, StatusLabel } from "../components.tsx";
import { errorText, useLoad } from "../hooks.ts";
import {
  type AccessEntry,
  type AccessLevel,
  type Account,
  type AgentInfo,
  accountAppShare,
  accountDisconnect,
  accountsOverview,
  accountUpdate,
  agentsList,
  catalogAccountTest,
  type DataApp,
  type DataLease,
  dataAccessLog,
  databaseAccountConnect,
  dataLeaseRevoke,
  dataLeasesList,
  type McpToolRow,
  mcpToolReadSet,
  mcpToolsList,
  type ShareLevel,
  type ShareRoute,
  type SslMode,
  scopesAcceptOffer,
  scopesSet,
  toolsRefresh,
} from "../ops.ts";

type Picked = AccessLevel | "none";

const SHARE_OPTIONS: { value: ShareLevel; label: string }[] = [
  { value: "none", label: "Not shared" },
  { value: "available", label: "Names and counts only" },
  { value: "shared", label: "Share messages (read only)" },
];

// C336 RQ-3 / C373: a database is shared as a list of tables (available) or as its rows, read as documents (shared).
const DB_SHARE_OPTIONS: { value: ShareLevel; label: string }[] = [
  { value: "none", label: "Not shared" },
  { value: "available", label: "Table names only" },
  { value: "shared", label: "Share rows as documents (read only)" },
];
// C373: an MCP server is shared as collection names and counts (available) or as its documents (shared).
const MCP_SHARE_OPTIONS: { value: ShareLevel; label: string }[] = [
  { value: "none", label: "Not shared" },
  { value: "available", label: "Collection names and counts only" },
  { value: "shared", label: "Share documents (read only)" },
];
const SSL_OPTIONS: { value: SslMode; label: string }[] = [
  { value: "verify-full", label: "Encrypted, certificate checked" },
  { value: "require", label: "Encrypted, certificate not checked" },
  { value: "disable", label: "Not encrypted" },
];

// C276 (1): each level is named by its CRUD set, never a bare "Update".
const LEVEL_OPTIONS: { value: Picked; label: string }[] = [
  { value: "none", label: "None" },
  { value: "read", label: "Read" },
  { value: "read_update", label: "Read + create + update" },
  { value: "read_update_delete", label: "Full (+ delete)" },
];

/**
 * C331 (demo gap 6): a custom MCP server's service id is derived from its host ("mcp_acme_data_sources__282ebac3"), so its group is
 * headed by what the owner named the account; several accounts on one server keep the first label plus a count.
 */
export function serviceTitle(service: string, list: readonly Account[]): string {
  if (list.length === 0 || !list.every((a) => a.source === "mcp")) return service;
  const [first] = list;
  return list.length === 1 ? (first?.label ?? service) : `${first?.label ?? service} (+${list.length - 1} more)`;
}

export function Accounts() {
  const accounts = useLoad(accountsOverview);
  const access = useLoad(dataAccessLog);
  // bumped when a share or a database changes: the lease list (shown only when leases are offered) reads again
  const [leaseTick, setLeaseTick] = useState(0);
  const agents = useLoad(agentsList);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);

  const groups = useMemo(() => {
    const byService = new Map<string, Account[]>();
    for (const account of accounts.data?.accounts ?? []) {
      if (account.status === "revoked") continue;
      byService.set(account.service, [...(byService.get(account.service) ?? []), account]);
    }
    return [...byService.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [accounts.data]);

  const agentName = (id: string | null) => agents.data?.find((a) => a.id === id)?.name ?? id ?? "";

  const disconnect = async () => {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    try {
      await accountDisconnect(confirm.id);
      setNotice(confirm.source === "database" ? `“${confirm.label}” is disconnected. Its stored password is removed and every share and lease of it has ended.` : `“${confirm.label}” is disconnected. Agents lose access to it at once.`);
      setConfirm(null);
      await accounts.reload();
      if (confirm.source === "database") setLeaseTick((n) => n + 1);
    } catch (e) {
      setError(errorText(e));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  // C240 / migration 0013: a share from before the update has no app instance; it serves nothing until the owner shares again
  // (only rows the page shows: connected chat accounts)
  const reshare = (accounts.data?.accounts ?? [])
    .filter((a) => a.source === "channel" && a.status === "connected")
    .reduce((n, a) => n + (a.shares ?? []).filter((x) => x.instance === null).length, 0);
  const callersKnown = accounts.data?.callersKnown !== false;
  const hasDatabase = (accounts.data?.accounts ?? []).some((a) => a.source === "database" && a.status === "connected");
  // C354a: rows of a database (leases) are not offered yet; the page shows the lease list and the lease level only when Connect says so
  const leasesEnabled = accounts.data?.leasesEnabled === true;

  return (
    <section className="app-page" aria-label="Accounts">
      <PageHead title="Accounts" lede="Your connected accounts, and what each agent may do with them. “Read + create + update” includes sending." />
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {reshare > 0 ? (
        <Notice>
          {callersKnown
            ? `Connect was updated. ${reshare === 1 ? "1 app share" : `${reshare} app shares`} must be chosen again: look for “Share again” below. Until then that app gets nothing.`
            : `Connect was updated. ${reshare === 1 ? "1 app share" : `${reshare} app shares`} must be chosen again after the next Connect update. Until then that app gets nothing.`}
        </Notice>
      ) : null}
      {accounts.error ? <LoadError message={accounts.error} busy={accounts.loading} onRetry={() => void accounts.reload()} /> : null}
      {accounts.loading && !accounts.data ? (
        <p className="tb-soft" role="status">
          Loading accounts.
        </p>
      ) : null}
      {accounts.data && groups.length === 0 ? <EmptyState title="No accounts are connected yet.">Open Services to connect one, or add a database below.</EmptyState> : null}
      {agents.error ? <LoadError message={`Agents couldn’t be loaded: ${agents.error}`} busy={agents.loading} onRetry={() => void agents.reload()} /> : null}

      {groups.map(([service, list]) => (
        <section key={service} className="tb-stack" aria-labelledby={`svc-${service}`}>
          <div className="group-head">
            <h2 id={`svc-${service}`} className="tb-row">
              <ServiceTile name={serviceTitle(service, list)} />
              {serviceTitle(service, list)}
            </h2>
            {list.some((a) => a.status === "connected" && a.source !== "database") ? <RefreshTools service={service} /> : null}
          </div>
          {list.some((a) => a.source === "mcp" && a.status === "connected") ? <McpTools service={service} /> : null}
          <ul className="cards cards-wide">
            {list.map((account) => (
              <li key={account.id}>
                <AccountRow
                  account={account}
                  ownerName={agentName(account.ownerAgent)}
                  agents={agents.data ?? []}
                  onAgentsChanged={agents.reload}
                  ownerRowsEffective={accounts.data?.ownerRowsEffective === true}
                  dataApps={accounts.data?.dataApps ?? []}
                  callersKnown={callersKnown}
                  leasesEnabled={leasesEnabled}
                  onShared={async () => {
                    await accounts.reload();
                    setLeaseTick((n) => n + 1);
                  }}
                  onRenamed={() => {
                    setNotice(null);
                    void accounts.reload();
                  }}
                  onDisconnect={() => setConfirm(account)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {accounts.data ? (
        <AddDatabase
          recommendation={accounts.data.databaseRecommendation ?? DEFAULT_DB_ADVICE}
          onAdded={(label) => {
            setError(null);
            setNotice(`“${label}” is added. Share it with an app below.`);
            void accounts.reload();
          }}
        />
      ) : null}

      {accounts.data && leasesEnabled && hasDatabase ? <DataLeases tick={leaseTick} /> : null}

      {accounts.data && (accounts.data.accounts.some((a) => a.source === "channel" || a.source === "database") || (access.data?.entries.length ?? 0) > 0) ? (
        <RecentAccess entries={access.data?.entries ?? null} error={access.error} busy={access.loading} databases={hasDatabase} onReload={() => void access.reload()} />
      ) : null}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.source === "database" ? "Disconnect this database?" : "Disconnect this account?"}
        body={
          confirm?.source === "database" ? (
            <p>“{confirm.label}” will be disconnected. Connect removes the stored password and ends every share and lease of it. You can add it again later.</p>
          ) : (
            <p>“{confirm?.label}” will be disconnected. Agents lose access to it at once. You can connect it again later.</p>
          )
        }
        confirmLabel="Disconnect"
        busy={busy}
        onConfirm={() => void disconnect()}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}

const EFFECT_TEXT: Record<string, string> = {
  read: "reads only",
  write: "changes data",
  outward: "sends or publishes",
  destructive: "deletes",
  money: "moves money",
};

/**
 * X-03: an MCP server can only CLAIM that a tool is read-only. Connect treats such a tool by its name (usually a write)
 * until the owner confirms the claim here. Only tools with an unverified claim can be confirmed.
 */
function McpTools({ service }: { service: string }) {
  const tools = useLoad(() => mcpToolsList(service), service);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const claimed = (tools.data?.tools ?? []).filter((t) => t.unverifiedReadClaim);
  const set = async (tool: McpToolRow, read: boolean) => {
    setBusy(tool.name);
    setError(null);
    try {
      await mcpToolReadSet(tool.name, read);
      await tools.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  if (tools.error) return <LoadError message={`Tools couldn’t be loaded: ${tools.error}`} busy={tools.loading} onRetry={() => void tools.reload()} />;
  if (claimed.length === 0) return null;
  return (
    <Card as="section" className="tool-claims" aria-label="Read-only claims to check">
      <p>
        <strong>Read-only claims to check.</strong> The server says these tools only read. Connect doesn’t trust that claim. Confirm a tool only when you know it
        reads only. A READ agent can then call it.
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ul className="tool-list">
        {claimed.map((t) => (
          <li key={t.name} className="tool-row">
            <span>
              {t.title} <span className="tb-muted">({t.ownerConfirmedRead ? "you confirmed: reads only" : `treated as: ${EFFECT_TEXT[t.effect] ?? t.effect}`})</span>
              {t.effect === "money" ? (
                // C331 D4b: a read of money records; the owner confirms it per tool
                <span className="tb-soft"> The server says it only reads money records. Reading moves no money. Confirm it only when you know it moves none.</span>
              ) : null}
            </span>
            <Button size="sm" disabled={busy === t.name} onClick={() => void set(t, !t.ownerConfirmedRead)} aria-label={`${t.ownerConfirmedRead ? "Withdraw" : "Confirm"} read-only for ${t.title}`}>
              {t.ownerConfirmedRead ? "Withdraw" : "Confirm read-only"}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function RefreshTools({ service }: { service: string }) {
  const [state, setState] = useState<{ busy: boolean; text: string | null; error: boolean }>({ busy: false, text: null, error: false });
  const run = async () => {
    setState({ busy: true, text: null, error: false });
    try {
      await toolsRefresh(service);
      setState({ busy: false, text: "Tools refreshed.", error: false });
    } catch (e) {
      setState({ busy: false, text: errorText(e), error: true });
    }
  };
  return (
    <div className="tb-row">
      {state.text ? (
        <span className={state.error ? "inline-error" : "tb-muted"} role={state.error ? "alert" : "status"}>
          {state.text}
        </span>
      ) : null}
      <Button size="sm" onClick={() => void run()} disabled={state.busy} aria-label={`Refresh tools of ${service}`}>
        Refresh tools
      </Button>
    </div>
  );
}

function AccountRow(props: {
  account: Account;
  ownerName: string;
  agents: AgentInfo[];
  dataApps: DataApp[];
  callersKnown: boolean;
  leasesEnabled: boolean;
  onShared(): Promise<void>;
  onAgentsChanged(): Promise<void>;
  ownerRowsEffective: boolean;
  onRenamed(): void;
  onDisconnect(): void;
}) {
  const { account } = props;
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(account.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!label.trim()) return setError("The label can’t be empty.");
    setBusy(true);
    setError(null);
    try {
      await accountUpdate(account.id, label.trim());
      setEditing(false);
      props.onRenamed();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card as="article" className="acct">
      {editing ? (
        <form className="tb-input-row" onSubmit={save}>
          <TextInput aria-label="Account label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
          <Button type="submit" variant="primary" disabled={busy}>
            Save
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setLabel(account.label);
              setError(null);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <div className="acct-head">
          <h3>{account.label}</h3>
          <div className="tb-row acct-tags">
            <StatusLabel status={account.status} />
            {account.source === "database" ? null : <KindBadge kind={account.kind} />}
            {account.kind === "as_itself" && props.ownerName ? <span className="tb-muted">{props.ownerName}</span> : null}
          </div>
        </div>
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {account.status === "failed" && account.detail ? <p className="tb-soft">{account.detail}</p> : null}
      {account.source === "database" && account.endpoint ? <p className="tb-soft">{account.endpoint} (Postgres). Agents never see this account; only the apps you share it with.</p> : null}
      {account.source === "database" && account.sslmode ? <p className="tb-soft">{`Connection: ${SSL_OPTIONS.find((o) => o.value === account.sslmode)?.label ?? account.sslmode}.`}</p> : null}
      {account.source === "database" && account.sslmode === "disable" ? <Notice tone="error">The connection to this database is not encrypted. The password and the rows that you share travel in clear text. Switch it to an encrypted connection when your database allows it.</Notice> : null}
      {account.status === "connected" && account.source !== "database" ? <AgentAccess account={account} agents={props.agents} onChanged={props.onAgentsChanged} ownerRowsEffective={props.ownerRowsEffective} /> : null}
      {account.status === "connected" && (account.source === "channel" || account.source === "database" || account.source === "mcp") && props.dataApps.length > 0 ? <AppSharing account={account} apps={props.dataApps} callersKnown={props.callersKnown} onChanged={props.onShared} /> : null}
      {!editing ? (
        <div className="tb-ctas">
          <Button size="sm" onClick={() => setEditing(true)} aria-label={`Rename ${account.label}`}>
            Rename
          </Button>
          {account.source === "catalog" && account.status === "connected" ? <TestConnection id={account.id} label={account.label} /> : null}
          <Button size="sm" variant="danger" onClick={props.onDisconnect} aria-label={`Disconnect ${account.label}`}>
            Disconnect
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function TestConnection({ id, label }: { id: string; label: string }) {
  const [state, setState] = useState<{ busy: boolean; text: string | null; error: boolean }>({ busy: false, text: null, error: false });
  const run = async () => {
    setState({ busy: true, text: null, error: false });
    try {
      const out = await catalogAccountTest(id);
      setState({ busy: false, text: out.ok ? "Connection works." : out.detail, error: !out.ok });
    } catch (e) {
      setState({ busy: false, text: errorText(e), error: true });
    }
  };
  return (
    <>
      <Button size="sm" onClick={() => void run()} disabled={state.busy} aria-label={`Test the connection of ${label}`}>
        Test connection
      </Button>
      {state.text ? (
        <span className={state.error ? "inline-error" : "tb-muted"} role={state.error ? "alert" : "status"}>
          {state.text}
        </span>
      ) : null}
    </>
  );
}

/**
 * C283 A1 / C283d: the owner sets each agent's access to this account. A level the owner saves here is the agent's own access
 * ("set in Connect"), also above the agent's Portal grant. A row Connect or the Portal made ("limited by the Portal grant")
 * becomes the owner's own only on the owner's click ("Use this access"). When a level now allows more than the owner accepted
 * (an app update widened it), the extra actions are NOT used until the owner clicks "Accept".
 */
function AgentAccess({ account, agents, onChanged, ownerRowsEffective = false }: { account: Account; agents: AgentInfo[]; onChanged?(): Promise<void>; ownerRowsEffective?: boolean }) {
  // Levels set in this session win over the (possibly unknown) list shape.
  const [local, setLocal] = useState<Record<string, Picked>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (agents.length === 0) return <p className="tb-soft">No agents yet. Add an agent in Tealbrick Portal to give it access.</p>;

  const currentLevel = (agent: AgentInfo): Picked | "" => local[agent.id] ?? (agent.levels ? (agent.levels[account.id] ?? "none") : "");

  const run = async (agent: AgentInfo, action: () => Promise<unknown>, after?: () => void) => {
    setBusy(agent.id);
    setError(null);
    try {
      await action();
      after?.();
      await onChanged?.();
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError(`${agent.name}: ${code === "offer_changed" ? "The offer changed. Check the new offer, then accept again." : errorText(e)}`);
      if (code === "offer_changed") await onChanged?.();
    } finally {
      setBusy(null);
    }
  };
  // S4-1 (review #18): with a reload the page shows what the server holds (authority, offer); the local level only bridges a
  // page that cannot reload.
  const change = (agent: AgentInfo, value: Picked) =>
    run(agent, () => scopesSet(agent.id, account.id, value === "none" ? null : value), onChanged ? undefined : () => setLocal((l) => ({ ...l, [agent.id]: value })));
  const crudWords = (adds: readonly string[]) => adds.join(", ");
  const LEVEL_CRUD: Record<string, string> = { read: "read", read_update: "read, create and update", read_update_delete: "read, create, update and delete" };

  return (
    <fieldset className="tb-stack access">
      <legend className="tb-label access-legend">Agent access</legend>
      <p className="tb-soft access-note">
        {ownerRowsEffective
          ? "A level you choose here is the agent's own access to this account, also where its Portal grant allows less."
          : "A level you choose here is saved as the agent's own access. Above the Portal grant it takes effect after a future bridge update; until then the Portal grant still limits the agent."}
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {agents.map((agent) => {
        const row = local[agent.id] === undefined ? agent.rows[account.id] : undefined;
        return (
          <div key={agent.id} className="tb-stack">
            <div className="acc-row">
              <span>{agent.name}</span>
              <Select
                aria-label={`${agent.name} access to ${account.label}`}
                options={LEVEL_OPTIONS}
                value={currentLevel(agent)}
                placeholder="Choose access"
                disabled={busy === agent.id}
                onValueChange={(v) => v !== currentLevel(agent) && void change(agent, v as Picked)}
              />
            </div>
            {row && row.offerAdds.length > 0 ? (
              <div className="acc-row acc-offer">
                <span className="access-note">
                  This level now also allows {crudWords(row.offerAdds)}. {agent.name} cannot use it until you accept.
                </span>
                <Button size="sm" disabled={busy === agent.id} onClick={() => void run(agent, () => scopesAcceptOffer(agent.id, account.id, row.level, row.offerAdds))}>
                  Accept {crudWords(row.offerAdds)}
                </Button>
              </div>
            ) : null}
            {row && row.authority === "bounded" ? (
              <div className="acc-row acc-bounded">
                <span className="access-note">
                  {ownerRowsEffective
                    ? `${agent.name}'s Portal grant may allow less than this level. If you use this access, ${agent.name} can ${LEVEL_CRUD[row.level]} on this account, also where the Portal grant allows less.`
                    : `${agent.name}'s Portal grant may allow less than this level. If you use this access, Connect saves it as ${agent.name}'s own access (${LEVEL_CRUD[row.level]}); above the Portal grant it takes effect after a future bridge update.`}
                </span>
                <Button size="sm" variant="secondary" disabled={busy === agent.id} onClick={() => void run(agent, () => scopesSet(agent.id, account.id, row.level))}>
                  Use this access
                </Button>
              </div>
            ) : row && row.authority === "owner" ? (
              <span className="tb-soft access-note">
                {ownerRowsEffective
                  ? `Set in Connect: ${agent.name} can ${LEVEL_CRUD[row.level]} on this account, also where the Portal grant allows less.`
                  : row.level === "read"
                    ? // C331 (demo gap 5): READ is the lowest level; it works now wherever the Portal grant includes read
                      `Your setting is saved. ${agent.name} can read this account now where its Portal grant includes read.`
                    : `Your setting is saved. It takes effect after a future bridge update; until then the Portal grant still limits ${agent.name}.`}
              </span>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * C230 R3: the owner decides which app may read a chat account's messages. "Share (read only)" lets that app pull the
 * messages Connect receives from now on; "Include the last 30 days" adds what Connect already holds. "Names and counts
 * only" shows the app the conversation names and counts and no message. Agents never see this: the data operations
 * serve apps only. The control shows what the server holds: it re-reads the list after every save.
 * C240: a share is bound to one installed instance of the app (picked here when there are several). The page never
 * pretends a share is gone while it may still serve:
 *   - bound to an instance that is no longer listed (removed, installed again): it can no longer read (the server checks
 *     `ctx.caller.listed` on every call); its level shows read-only, with "Stop sharing" and an explicit move button;
 *   - from before migration 0013 (no instance): it serves nobody; "Share again" on the row and a page notice;
 *   - moving a share to another instance is a new share: "Include the last 30 days" starts unticked again.
 * An instance on the owner's own server is named as such.
 */
function AppSharing({ account, apps, callersKnown, onChanged }: { account: Account; apps: DataApp[]; callersKnown: boolean; onChanged(): Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // with several installed instances and no live share, the owner picks which one the next share goes to (product -> id)
  const [picked, setPicked] = useState<Record<string, string>>({});
  const share = (app: DataApp) => account.shares?.find((x) => x.product === app.product);

  const isDb = account.source === "database";
  // C373: databases and MCP servers give the dataset `documents` and are shared with a route
  const routed = isDb || account.source === "mcp";
  // C322(6): Knowledge reads a database or an MCP server only through Observer; the direct route is not offered to it
  const routeFor = (app: DataApp): ShareRoute | undefined => (routed ? (app.product === "knowledge" ? "via_observer" : "direct") : undefined);
  const change = async (app: DataApp, level: ShareLevel, includeHistory: boolean, instance: string | null) => {
    setBusy(app.product);
    setError(null);
    try {
      await accountAppShare(account.id, app.product, level, includeHistory, instance, level === "none" ? undefined : routeFor(app));
      await onChanged();
    } catch (e) {
      setError(`${app.name}: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <fieldset className="tb-stack access">
      <legend className="tb-label access-legend">Apps (read only)</legend>
      {routed ? <p className="tb-soft acc-dataset">{`Dataset: documents. ${isDb ? "Each table is a collection; every 200 rows are one document." : "Each text file the server lists is one document."}`}</p> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {apps.map((app) => {
        const instances = app.instances ?? [];
        const row = share(app);
        // a row with an instance can serve; one without (before migration 0013) serves nobody
        const bound = row && row.instance !== null ? row : undefined;
        const legacy = row !== undefined && row.instance === null;
        const listed = bound?.current === true;
        // with an SDK that cannot list the apps, a bound share is not "removed": the page cannot tell (and data calls fail closed)
        const unknown = !callersKnown && bound !== undefined;
        const unlisted = bound !== undefined && !listed && !unknown;
        const level: ShareLevel = bound?.level ?? "none";
        const pick = picked[app.product];
        const target = listed ? instances.find((i) => i.instance === bound?.instance) : (instances.find((i) => i.instance === pick) ?? instances[0]);
        const includeHistory = listed ? (bound?.includeHistory ?? false) : false;
        const isBusy = busy === app.product;
        const route: ShareRoute = bound?.route ?? routeFor(app) ?? "direct";
        const options = (isDb ? DB_SHARE_OPTIONS : routed ? MCP_SHARE_OPTIONS : SHARE_OPTIONS).map((o) => (o.value !== "none" && !target ? { ...o, disabled: true } : o));
        const where = target?.ownInfra ? " (your own server)" : "";
        const setLevel = (v: ShareLevel) => {
          if (v === level) return;
          if (v === "none") return void change(app, "none", false, null);
          if (!target) return;
          // the same instance keeps its history choice; another instance is a new share (history unticked)
          void change(app, v, target.instance === bound?.instance ? includeHistory : false, target.instance);
        };
        return (
          <div key={app.product} className="acc-row">
            <span>Share with {app.name} (read only)</span>
            <Select aria-label={`Share ${account.label} with ${app.name}`} options={options} value={level} disabled={isBusy || unlisted || unknown || (level === "none" && !target)} onValueChange={(v) => setLevel(v as ShareLevel)} />
            {instances.length > 1 ? (
              <>
                <span className="tb-soft">Which {app.name}</span>
                <Select
                  aria-label={`Which ${app.name} gets ${account.label}`}
                  options={instances.map((i) => ({ value: i.instance, label: instanceLabel(i) }))}
                  value={target?.instance ?? ""}
                  disabled={isBusy}
                  onValueChange={(v) => {
                    if (listed && level !== "none") {
                      // moving a live share to another instance is a new share: history starts unticked
                      if (v !== bound?.instance) void change(app, level, false, v);
                    } else setPicked((p) => ({ ...p, [app.product]: v }));
                  }}
                />
              </>
            ) : null}
            {!routed && level === "shared" && listed ? (
              <label className="tb-row">
                <input
                  type="checkbox"
                  checked={includeHistory}
                  disabled={isBusy}
                  onChange={(e) => void change(app, "shared", e.target.checked, bound?.instance ?? null)}
                  aria-label={`Include the last 30 days of ${account.label} for ${app.name}`}
                />
                <span className="tb-soft">Include the last 30 days</span>
              </label>
            ) : null}
            {unlisted || unknown ? null : <p className="tb-soft acc-note">{routed ? documentsShareSentence(level, route, app.name, isDb) : shareSentence(level, includeHistory, bound?.setAt)}</p>}
            {legacy && callersKnown ? <p className="tb-soft acc-note">Share again — this app must be chosen again after the update.</p> : null}
            {unlisted ? <p className="tb-soft acc-note">This app instance was removed; it can no longer read.</p> : null}
            {!callersKnown ? <p className="tb-soft acc-note">Sharing with apps needs the next Connect update.</p> : null}
            {callersKnown && instances.length === 0 && !unlisted ? <p className="tb-soft acc-note">{`Install ${app.name} in your workspace to share ${isDb ? "this database" : routed ? "this server" : "this account"} with it.`}</p> : null}
            {target?.ownInfra ? (
              <p className="tb-soft acc-note">{`This ${app.name} runs on your own server. Connect cannot check the code that runs there. Share only if you trust that server.`}</p>
            ) : null}
            {unlisted || legacy || unknown ? (
              <div className="tb-ctas acc-actions">
                <Button size="sm" disabled={isBusy} onClick={() => void change(app, "none", false, null)} aria-label={`Stop sharing ${account.label} with ${app.name}`}>
                  Stop sharing
                </Button>
                {unlisted && target ? (
                  <Button size="sm" disabled={isBusy} onClick={() => void change(app, level, false, target.instance)} aria-label={`Share ${account.label} with the installed ${app.name}${where} instead`}>
                    {`Share with the installed ${app.name}${where} instead`}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}

/** Two instances with the same name stay apart: where each runs and the end of its id. */
function instanceLabel(i: { instance: string; name: string; provider: string | null; ownInfra: boolean }): string {
  const where = i.ownInfra ? "your own server" : (i.provider ?? "unknown host");
  return `${i.name} · ${where} · …${i.instance.slice(-6)}`;
}

/** One plain sentence per level and route for a database or an MCP server: what the app really gets (C336, C373). */
function documentsShareSentence(level: ShareLevel, route: ShareRoute, app: string, database: boolean): string {
  const what = database ? "this database" : "this server";
  if (level === "none") return `This app sees nothing of ${what}. Pick a level to share; you can revoke it at any time.`;
  if (route === "via_observer") return `${app} reads ${what} only through Observer. Share it with Observer too; ${app} gets nothing from Connect directly.`;
  if (level === "available")
    return database
      ? "This app sees the names of the tables and views, their columns and types, and about how many rows each holds. It sees no values. You can stop sharing at any time."
      : "This app sees the names of the collections on this server and how many documents each holds. It reads no document. You can stop sharing at any time.";
  return database
    ? "This app reads the rows of every table and view, 200 rows per document, in a read-only transaction. It cannot change anything. Columns whose name looks like a secret (password, token, key) are left out; this is a guess by name, so check your tables. You can stop sharing at any time."
    : "This app reads the text files this server lists, as documents. Connect never runs a tool of the server for it. You can stop sharing at any time.";
}

/** One plain sentence per sharing level: what the app really gets (S3-3). */
function shareSentence(level: ShareLevel, includeHistory: boolean, setAt: string | undefined): string {
  if (level === "available") return "This app sees the name and message count of every conversation of this bot, for the whole log Connect holds, and no message text. You can stop sharing at any time.";
  if (level === "shared" && includeHistory) return "This app reads every conversation of this bot: the last 30 days Connect already holds and every new message. You can stop sharing at any time.";
  if (level === "shared") {
    const since = setAt ? ` (${new Date(setAt).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })})` : "";
    return `This app reads every conversation of this bot, but only the messages Connect received from the time you shared${since}; tick “Include the last 30 days” to add the older ones. You can stop sharing at any time.`;
  }
  return "This app sees nothing of this connection. Pick a level to share; you can revoke it at any time.";
}

const ACCESS_OPS: Record<string, string> = {
  data_accounts_list: "Listed the shared accounts",
  data_catalog: "Read names and counts",
  data_pull: "Read messages or documents",
  data_lease: "Leased database access",
};
const REFUSED_TEXT: Record<string, string> = {
  not_found: "Not shared with this app",
  scope_denied: "Names and counts only",
  caller_unverified: "Unverified app",
  share_instance_gone: "App instance removed",
  companion_list_unavailable: "Connect needs an update",
  no_access: "Not an app",
  audit_unavailable: "Could not be recorded",
};

function accessWhen(iso: string): string {
  return new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * C230 R3 (S3-2): which app asked Connect for chat data, newest first, the last 100 calls. The owner only. No message text.
 * A refusal repeated within a minute is one line with a count.
 */
function RecentAccess({ entries, error, busy, databases = false, onReload }: { entries: AccessEntry[] | null; error: string | null; busy: boolean; databases?: boolean; onReload(): void }) {
  return (
    <section className="tb-stack" aria-labelledby="recent-access">
      <div className="group-head">
        <h2 id="recent-access">Recent access</h2>
        <Button size="sm" disabled={busy} onClick={onReload}>
          Refresh
        </Button>
      </div>
      <p className="tb-soft">
        {databases
          ? "The last 100 times an app asked Connect for the messages of your chat accounts or for the tables and rows of your databases. Connect keeps this record for 90 days."
          : "The last 100 times an app asked Connect for the messages of your chat accounts. Connect keeps this record for 90 days."}
      </p>
      {error ? <LoadError message={error} busy={busy} onRetry={onReload} /> : null}
      {entries === null ? (
        error ? null : (
          <p className="tb-soft" role="status">
            Loading access.
          </p>
        )
      ) : entries.length === 0 ? (
        <EmptyState title={databases ? "No app has asked for your data yet." : "No app has asked for your chat messages yet."} />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>When</th>
              <th>App</th>
              <th>Request</th>
              <th>Account</th>
              <th>Messages</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="num">{accessWhen(e.at)}</td>
                <td>{e.app ?? (e.callerType === "app" ? "Unverified app" : e.callerType === "agent" ? "An agent" : e.callerType)}</td>
                <td>
                  {ACCESS_OPS[e.op] ?? e.op}
                  {e.leaseId ? <span className="tb-soft">{` · lease ends ${accessWhen(e.leaseExpiresAt ?? e.at)} · ${tablesText(e.datasets ?? [])}`}</span> : null}
                </td>
                <td>{e.account ?? ""}</td>
                <td className="num">{e.op === "data_pull" && e.ok ? e.rows : ""}</td>
                <td>
                  <Tag status={e.ok ? "live" : "default"}>{e.ok ? "Served" : `Refused: ${REFUSED_TEXT[e.outcome] ?? e.outcome}`}</Tag>
                  {e.repeats > 0 ? <span className="tb-soft">{` and ${e.repeats} more in the same minute`}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

/** Shown when an older Connect answers without the text. The server sends the same advice. */
const DEFAULT_DB_ADVICE = "Use a dedicated read-only database user: SELECT on the tables you want to share and nothing else (no INSERT, UPDATE, DELETE, no REPLICATION, not a superuser).";

const EMPTY_DB_FORM = { label: "", host: "", port: "5432", database: "", user: "", password: "", sslmode: "verify-full" as SslMode };

/**
 * C336 RQ-3: the owner adds a Postgres database for apps. The form goes to Connect once; the password is sealed there and
 * never shown again. Connect refuses a private address, a superuser and a replication role, and reads table and column names
 * only. Agents never see a database account.
 */
function AddDatabase({ recommendation, onAdded }: { recommendation: string; onAdded(label: string): void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_DB_FORM);
  const [busy, setBusy] = useState(false);
  // `n` counts the failures, so the same text twice still moves the reader to it
  const [failure, setFailure] = useState<{ text: string; n: number } | null>(null);
  const error = failure?.text ?? null;
  const setError = (text: string | null) => setFailure((f) => (text === null ? null : { text, n: (f?.n ?? 0) + 1 }));
  const alertBox = useRef<HTMLDivElement>(null);
  const set = (key: keyof typeof EMPTY_DB_FORM, value: string) => setForm((f) => ({ ...f, [key]: value }));
  // QA-CON24-2: on a small screen the form is taller than the view, so a refusal appears out of sight and focus stays on
  // the button. The notice is scrolled into view and takes focus (role alert reads it out).
  useEffect(() => {
    if (!failure) return;
    alertBox.current?.focus();
    alertBox.current?.scrollIntoView?.({ block: "center" });
  }, [failure]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const port = form.port.trim() === "" ? 5432 : Number(form.port);
    if (!form.label.trim() || !form.host.trim() || !form.database.trim() || !form.user.trim() || !form.password) return setError("Fill in the name, host, database, user and password.");
    if (!Number.isInteger(port) || port < 1 || port > 65535) return setError("The port must be a number from 1 to 65535.");
    setBusy(true);
    setError(null);
    try {
      await databaseAccountConnect({ label: form.label.trim(), host: form.host.trim(), port, database: form.database.trim(), user: form.user.trim(), password: form.password, sslmode: form.sslmode });
      const label = form.label.trim();
      setForm(EMPTY_DB_FORM);
      setOpen(false);
      onAdded(label);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="tb-stack" aria-labelledby="add-database">
      <div className="group-head">
        <h2 id="add-database">Databases</h2>
        {open ? null : (
          <Button size="sm" onClick={() => setOpen(true)}>
            Add a database
          </Button>
        )}
      </div>
      <p className="tb-soft">Let Observer read the tables of your Postgres database: the table names only, or the rows as documents, read only. Agents never see a database. You choose which app gets it.</p>
      {open ? (
        <Card as="div" className="acct">
         <form className="tb-stack" aria-label="Add a database" onSubmit={submit}>
          <Notice>{recommendation} Connect refuses a superuser or a replication role, and it connects only to public addresses.</Notice>
          {error ? (
            <div ref={alertBox} tabIndex={-1}>
              <Notice tone="error">{error}</Notice>
            </div>
          ) : null}
          <Field label="Name">
            <TextInput value={form.label} onChange={(e) => set("label", e.target.value)} maxLength={60} disabled={busy} />
          </Field>
          <Field label="Host">
            <TextInput value={form.host} onChange={(e) => set("host", e.target.value)} autoComplete="off" disabled={busy} />
          </Field>
          <Field label="Port">
            <TextInput value={form.port} onChange={(e) => set("port", e.target.value)} inputMode="numeric" disabled={busy} />
          </Field>
          <Field label="Database">
            <TextInput value={form.database} onChange={(e) => set("database", e.target.value)} autoComplete="off" disabled={busy} />
          </Field>
          <Field label="User">
            <TextInput value={form.user} onChange={(e) => set("user", e.target.value)} autoComplete="off" disabled={busy} />
          </Field>
          <Field label="Password">
            <TextInput type="password" value={form.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" disabled={busy} />
          </Field>
          <p className="tb-hint">Connect stores the password sealed and never shows it again.</p>
          <Field label="Encryption">
            <Select aria-label="Encryption of the database connection" options={SSL_OPTIONS} value={form.sslmode} onValueChange={(v) => set("sslmode", v)} disabled={busy} />
          </Field>
          {form.sslmode === "verify-full" ? null : <Notice>{form.sslmode === "disable" ? "The password and the data travel without encryption." : "The connection is encrypted, but Connect does not check who answers."} Use this only when your database cannot present a valid certificate.</Notice>}
          <div className="tb-ctas">
            <Button type="submit" variant="primary" disabled={busy}>
              Add database
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setForm(EMPTY_DB_FORM);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
         </form>
        </Card>
      ) : null}
    </section>
  );
}

const tablesText = (datasets: string[]): string => (datasets.length <= 3 ? datasets.join(", ") : `${datasets.slice(0, 3).join(", ")} and ${datasets.length - 3} more`);
const LEASE_STATE: Record<DataLease["state"], string> = { active: "Active", revoked: "Ended by you", expired: "Expired" };

/**
 * C336 RQ-3: every lease an app asked for, newest first. v0 is honest about what a lease is: the read-only password you stored,
 * handed to the app for a few minutes. "End lease" ends it in Connect and in this list; the password itself stays valid in the
 * database until the owner changes it there.
 */
function DataLeases({ tick }: { tick: number }) {
  const loaded = useLoad(dataLeasesList, String(tick));
  const { error, loading: busy } = loaded;
  const leases = loaded.data?.leases ?? null;
  const onReload = () => void loaded.reload();
  const [ending, setEnding] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const end = async (lease: DataLease) => {
    setEnding(lease.id);
    setFailure(null);
    try {
      await dataLeaseRevoke(lease.id);
      onReload();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setEnding(null);
    }
  };
  return (
    <section className="tb-stack" aria-labelledby="data-leases">
      <div className="group-head">
        <h2 id="data-leases">Database leases</h2>
        <Button size="sm" disabled={busy} onClick={onReload}>
          Refresh
        </Button>
      </div>
      <p className="tb-soft">
        A lease gives an app the read-only password you stored, for at most 15 minutes. Ending a lease marks it ended in Connect, but the password stays valid in your
        database. To cut access at once, change that user’s password in your database and add the database again.
      </p>
      {error ? <LoadError message={error} busy={busy} onRetry={onReload} /> : null}
      {failure ? <Notice tone="error">{failure}</Notice> : null}
      {leases === null ? (
        error ? null : (
          <p className="tb-soft" role="status">
            Loading leases.
          </p>
        )
      ) : leases.length === 0 ? (
        <EmptyState title="No app has asked for a lease yet." />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Given</th>
              <th>App</th>
              <th>Database</th>
              <th>Tables</th>
              <th>Ends</th>
              <th>State</th>
              <th>
                <span className="tb-sr">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {leases.map((l) => (
              <tr key={l.id}>
                <td className="num">{accessWhen(l.issuedAt)}</td>
                <td>{l.app}</td>
                <td>{l.accountLabel}</td>
                <td>{tablesText(l.datasets)}</td>
                <td className="num">{accessWhen(l.expiresAt)}</td>
                <td>
                  <Tag status={l.state === "active" ? "live" : "default"}>{LEASE_STATE[l.state]}</Tag>
                </td>
                <td>
                  {l.state === "active" ? (
                    <Button size="sm" disabled={ending === l.id} onClick={() => void end(l)} aria-label={`End the lease of ${l.app} on ${l.accountLabel}`}>
                      End lease
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}
