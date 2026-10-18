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
  scopesSet,
  toolsRefresh,
} from "../ops.ts";

type Picked = AccessLevel | "none";

const SHARE_OPTIONS: { value: ShareLevel; label: string }[] = [
  { value: "none", label: "Not shared" },
  { value: "available", label: "Names and counts only" },
  { value: "shared", label: "Share messages (read only)" },
];

const LEVEL_OPTIONS: { value: Picked; label: string }[] = [
  { value: "none", label: "None" },
  { value: "read", label: "READ" },
  { value: "read_update", label: "READ/UPDATE" },
  { value: "read_update_delete", label: "READ/UPDATE/DELETE" },
];

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

  return (
    <section className="app-page" aria-label="Accounts">
      <PageHead title="Accounts" lede="Your connected accounts, and what each agent may do with them. READ/UPDATE includes creating and sending." />
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
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
              <ServiceTile name={service} />
              {service}
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
                  dataApps={accounts.data?.dataApps ?? []}
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

function AccountRow(props: { account: Account; ownerName: string; agents: AgentInfo[]; dataApps: DataApp[]; onShared(): Promise<void>; onRenamed(): void; onDisconnect(): void }) {
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
      {account.status === "connected" ? <AgentAccess account={account} agents={props.agents} /> : null}
      {account.status === "connected" && account.source === "channel" && props.dataApps.length > 0 ? <AppSharing account={account} apps={props.dataApps} onChanged={props.onShared} /> : null}
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

function AgentAccess({ account, agents }: { account: Account; agents: AgentInfo[] }) {
  // Levels set in this session win over the (possibly unknown) list shape.
  const [local, setLocal] = useState<Record<string, Picked>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (agents.length === 0) return <p className="tb-soft">No agents yet. Add an agent in Tealbrick Portal to give it access.</p>;

  const currentLevel = (agent: AgentInfo): Picked | "" => local[agent.id] ?? (agent.levels ? (agent.levels[account.id] ?? "none") : "");

  const change = async (agent: AgentInfo, value: Picked) => {
    setBusy(agent.id);
    setError(null);
    try {
      await scopesSet(agent.id, account.id, value === "none" ? null : value);
      setLocal((l) => ({ ...l, [agent.id]: value }));
    } catch (e) {
      setError(`${agent.name}: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <fieldset className="tb-stack access">
      <legend className="tb-label access-legend">Agent access</legend>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {agents.map((agent) => (
        <div key={agent.id} className="acc-row">
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
      ))}
    </fieldset>
  );
}

/**
 * C230 R3: the owner decides which app may read a chat account's messages. "Share (read only)" lets that app pull the
 * messages Connect receives from now on; "Include the last 30 days" adds what Connect already holds. "Names and counts
 * only" shows the app the conversation names and counts and no message. Agents never see this: the data operations
 * serve apps only. The control shows what the server holds: it re-reads the list after every save.
 * C240: a share is bound to one installed instance of the app (picked here when there are several). A share whose instance
 * is gone (removed, reinstalled) serves nothing and shows "Not shared" with a note; an instance on the owner's own server
 * is named as such.
 */
function AppSharing({ account, apps, onChanged }: { account: Account; apps: DataApp[]; onChanged(): Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // C240: with several installed instances of one app, the owner picks which one (product -> instance id)
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
        const current = share(app);
        const instances = app.instances ?? [];
        // a share bound to an instance that is gone (removed, reinstalled) or from before 0.6.0 serves nothing: show "Not shared"
        const live = current?.current === true ? current : undefined;
        const stale = current !== undefined && live === undefined;
        const target = instances.find((i) => i.instance === (picked[app.product] ?? live?.instance)) ?? instances[0];
        const level = live?.level ?? "none";
        const includeHistory = live?.includeHistory ?? false;
        return (
          <div key={app.product} className="acc-row">
            <span>Share with {app.name} (read only)</span>
            <Select
              aria-label={`Share ${account.label} with ${app.name}`}
              options={SHARE_OPTIONS}
              value={level}
              disabled={busy === app.product || (instances.length === 0 && level === "none")}
              onValueChange={(v) => v !== level && void change(app, v as ShareLevel, includeHistory, target?.instance ?? null)}
            />
            {instances.length > 1 ? (
              <>
                <span className="tb-soft">Which {app.name}</span>
                <Select
                  aria-label={`Which ${app.name} gets ${account.label}`}
                  options={instances.map((i) => ({ value: i.instance, label: i.ownInfra ? `${i.name} (your own server)` : i.name }))}
                  value={target?.instance ?? ""}
                  disabled={busy === app.product}
                  onValueChange={(v) => {
                    setPicked((p) => ({ ...p, [app.product]: v }));
                    if (level !== "none" && v !== live?.instance) void change(app, level, includeHistory, v);
                  }}
                />
              </>
            ) : null}
            {level === "shared" ? (
              <label className="tb-row">
                <input
                  type="checkbox"
                  checked={includeHistory}
                  disabled={busy === app.product}
                  onChange={(e) => void change(app, "shared", e.target.checked, target?.instance ?? live?.instance ?? null)}
                  aria-label={`Include the last 30 days of ${account.label} for ${app.name}`}
                />
                <span className="tb-soft">Include the last 30 days</span>
              </label>
            ) : null}
            <p className="tb-soft acc-note">{shareSentence(level, includeHistory, live?.setAt)}</p>
            {stale ? (
              <p className="tb-soft acc-note">
                {instances.length > 0
                  ? `The ${app.name} you shared with before was removed or installed again, so it gets nothing now. Pick a level to share with the installed ${app.name}.`
                  : `The ${app.name} you shared with before was removed, so it gets nothing now.`}
              </p>
            ) : null}
            {instances.length === 0 && !stale ? <p className="tb-soft acc-note">{`Install ${app.name} in your workspace to share this account with it.`}</p> : null}
            {target?.ownInfra ? (
              <p className="tb-soft acc-note">{`This ${app.name} runs on your own server. Connect cannot check the code that runs there. Share only if you trust that server.`}</p>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
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
