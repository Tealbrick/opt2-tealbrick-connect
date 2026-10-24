import { Button, Card, EmptyState, Select, Table, Tag, TextInput } from "@opt2-tealbrick/ui";
import { type FormEvent, useMemo, useState } from "react";

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
  dataAccessLog,
  type McpToolRow,
  mcpToolReadSet,
  mcpToolsList,
  type ShareLevel,
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
      setNotice(`“${confirm.label}” is disconnected. Agents lose access to it at once.`);
      setConfirm(null);
      await accounts.reload();
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
      {accounts.data && groups.length === 0 ? <EmptyState title="No accounts are connected yet.">Open Services to connect one.</EmptyState> : null}
      {agents.error ? <LoadError message={`Agents couldn’t be loaded: ${agents.error}`} busy={agents.loading} onRetry={() => void agents.reload()} /> : null}

      {groups.map(([service, list]) => (
        <section key={service} className="tb-stack" aria-labelledby={`svc-${service}`}>
          <div className="group-head">
            <h2 id={`svc-${service}`} className="tb-row">
              <ServiceTile name={serviceTitle(service, list)} />
              {serviceTitle(service, list)}
            </h2>
            {list.some((a) => a.status === "connected") ? <RefreshTools service={service} /> : null}
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
                  onShared={() => accounts.reload()}
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

      {accounts.data && (accounts.data.accounts.some((a) => a.source === "channel") || (access.data?.entries.length ?? 0) > 0) ? (
        <RecentAccess entries={access.data?.entries ?? null} error={access.error} busy={access.loading} onReload={() => void access.reload()} />
      ) : null}

      <ConfirmDialog
        open={confirm !== null}
        title="Disconnect this account?"
        body={<p>“{confirm?.label}” will be disconnected. Agents lose access to it at once. You can connect it again later.</p>}
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
            <KindBadge kind={account.kind} />
            {account.kind === "as_itself" && props.ownerName ? <span className="tb-muted">{props.ownerName}</span> : null}
          </div>
        </div>
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {account.status === "failed" && account.detail ? <p className="tb-soft">{account.detail}</p> : null}
      {account.status === "connected" ? <AgentAccess account={account} agents={props.agents} onChanged={props.onAgentsChanged} ownerRowsEffective={props.ownerRowsEffective} /> : null}
      {account.status === "connected" && account.source === "channel" && props.dataApps.length > 0 ? <AppSharing account={account} apps={props.dataApps} callersKnown={props.callersKnown} onChanged={props.onShared} /> : null}
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

  const change = async (app: DataApp, level: ShareLevel, includeHistory: boolean, instance: string | null) => {
    setBusy(app.product);
    setError(null);
    try {
      await accountAppShare(account.id, app.product, level, includeHistory, instance);
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
        const options = SHARE_OPTIONS.map((o) => (o.value !== "none" && !target ? { ...o, disabled: true } : o));
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
            {level === "shared" && listed ? (
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
            {unlisted || unknown ? null : <p className="tb-soft acc-note">{shareSentence(level, includeHistory, bound?.setAt)}</p>}
            {legacy && callersKnown ? <p className="tb-soft acc-note">Share again — this app must be chosen again after the update.</p> : null}
            {unlisted ? <p className="tb-soft acc-note">This app instance was removed; it can no longer read.</p> : null}
            {!callersKnown ? <p className="tb-soft acc-note">Sharing with apps needs the next Connect update.</p> : null}
            {callersKnown && instances.length === 0 && !unlisted ? <p className="tb-soft acc-note">{`Install ${app.name} in your workspace to share this account with it.`}</p> : null}
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
  data_pull: "Read messages",
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
function RecentAccess({ entries, error, busy, onReload }: { entries: AccessEntry[] | null; error: string | null; busy: boolean; onReload(): void }) {
  return (
    <section className="tb-stack" aria-labelledby="recent-access">
      <div className="group-head">
        <h2 id="recent-access">Recent access</h2>
        <Button size="sm" disabled={busy} onClick={onReload}>
          Refresh
        </Button>
      </div>
      <p className="tb-soft">The last 100 times an app asked Connect for the messages of your chat accounts. Connect keeps this record for 90 days.</p>
      {error ? <LoadError message={error} busy={busy} onRetry={onReload} /> : null}
      {entries === null ? (
        error ? null : (
          <p className="tb-soft" role="status">
            Loading access.
          </p>
        )
      ) : entries.length === 0 ? (
        <EmptyState title="No app has asked for your chat messages yet." />
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
                <td>{ACCESS_OPS[e.op] ?? e.op}</td>
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
