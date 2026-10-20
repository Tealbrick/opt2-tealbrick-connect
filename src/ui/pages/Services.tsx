import { Button, Card, EmptyState, Field, Progress, Select, StepFlow, TextInput, TextLink } from "@opt2-tealbrick/ui";
import { useEffect, useState } from "react";

import { LoadError, Notice, PageHead, ServiceTile } from "../components.tsx";
import { errorText, useLoad } from "../hooks.ts";
import { type AccountKind, accountConnect, accountsOverview, agentsList, catalogAccountConnect, type ServiceHit, servicesSearch } from "../ops.ts";
import { hrefOf } from "../router.ts";

const POLL_MS = 2000;
const POLL_MAX_MS = 5 * 60 * 1000;

interface Watch {
  accountId: string;
  label: string;
  redirectUrl: string;
  phase: "waiting" | "connected" | "failed" | "timeout";
  detail: string;
}

const SearchIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
    <path d="m12.5 12.5 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export function Services(props: { onOpenAccounts(): void }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [picked, setPicked] = useState<ServiceHit | null>(null);
  const [watch, setWatch] = useState<Watch | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const results = useLoad(() => servicesSearch(debounced), debounced);

  // Watch a started connection: poll the account list every 2 s (max 5 min) and re-check at once on a popup message.
  const watchedId = watch?.phase === "waiting" ? watch.accountId : null;
  useEffect(() => {
    if (!watchedId) return;
    const started = Date.now();
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      let done = false;
      try {
        const account = (await accountsOverview()).accounts.find((a) => a.id === watchedId);
        if (account && (account.status === "connected" || account.status === "failed") && !stopped) {
          done = true;
          setWatch((w) => (w && w.accountId === watchedId ? { ...w, phase: account.status === "connected" ? "connected" : "failed", detail: account.detail } : w));
        }
      } catch {
        // a failed poll is retried on the next tick
      }
      inFlight = false;
      if (done || stopped) return;
      if (Date.now() - started >= POLL_MAX_MS) {
        setWatch((w) => (w && w.accountId === watchedId ? { ...w, phase: "timeout" } : w));
        return;
      }
      timer = setTimeout(() => void check(), POLL_MS);
    };
    // The popup posts { connect: true | false }; the answer only triggers a check, the server state decides.
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data === "object" && event.data !== null && "connect" in event.data) {
        clearTimeout(timer);
        void check();
      }
    };
    window.addEventListener("message", onMessage);
    timer = setTimeout(() => void check(), POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
  }, [watchedId]);

  /** Closing the flow keeps a connection that still waits (the page shows its progress); a finished one is shown in the flow already. */
  const closeFlow = () => {
    setPicked(null);
    setWatch((w) => (w && w.phase !== "waiting" ? null : w));
  };

  return (
    <section className="app-page" aria-label="Services">
      <PageHead title="Services" lede="Search the services you can connect, then sign in to your account of that service." />
      <div className="tb-search svc-search">
        <SearchIcon />
        <TextInput type="search" aria-label="Search services" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Gmail, Calendar, Slack" autoComplete="off" maxLength={80} />
      </div>

      {watch && !picked ? <WatchPanel watch={watch} onOpenAccounts={props.onOpenAccounts} onClose={() => setWatch(null)} /> : null}

      {results.error ? <LoadError message={results.error} busy={results.loading} onRetry={() => void results.reload()} /> : null}
      {results.data && !results.data.composioKey ? (
        <Notice>Add your Composio API key: in Tealbrick Portal open Connect’s keys (the key page of your workspace). Connect never shows the key.</Notice>
      ) : null}
      {results.loading && !results.data ? (
        <p className="tb-soft" role="status">
          Loading services.
        </p>
      ) : null}
      {results.data?.catalogAvailable === false ? <Notice>The Tealbrick catalog of self-hosted apps isn’t available right now.</Notice> : null}
      {results.data && results.data.services.length === 0 && !results.loading ? <EmptyState title="No service matches this search." /> : null}

      <ul className="cards" aria-label="Services">
        {(results.data?.services ?? []).map((service) => (
          <li key={service.service}>
            <ServiceCard service={service} busy={picked !== null} onOpen={() => setPicked(service)} />
          </li>
        ))}
      </ul>

      {picked ? <ConnectFlow key={picked.service} service={picked} watch={watch} onWatch={setWatch} onClose={closeFlow} onOpenAccounts={props.onOpenAccounts} /> : null}
    </section>
  );
}

function WatchPanel(props: { watch: Watch; onOpenAccounts(): void; onClose(): void }) {
  const { watch } = props;
  // A finished connection: the result with a small Dismiss beside it inside the notice (mockup "Connection progress").
  const dismiss = (
    <Button size="sm" onClick={props.onClose}>
      Dismiss
    </Button>
  );
  return (
    <section aria-label="Connection progress" className="watch">
      {watch.phase === "waiting" ? (
        <Notice>
          Waiting for you to finish signing in for “{watch.label}”. If no window opened,{" "}
          <TextLink href={watch.redirectUrl} target="_blank" rel="noopener noreferrer">
            open the sign-in page
          </TextLink>
          .
        </Notice>
      ) : null}
      {watch.phase === "connected" ? (
        <Notice tone="ok">
          <span className="notice-row">
            <span>
              “{watch.label}” is connected. Next, set what each agent may do with it in <AccountsLink onOpen={props.onOpenAccounts} />.
            </span>
            {dismiss}
          </span>
        </Notice>
      ) : null}
      {watch.phase === "failed" ? (
        <Notice tone="error">
          <span className="notice-row">
            <span>
              “{watch.label}” didn’t connect.{watch.detail ? ` ${watch.detail}` : ""}
            </span>
            {dismiss}
          </span>
        </Notice>
      ) : null}
      {watch.phase === "timeout" ? (
        <Notice tone="error">
          <span className="notice-row">
            <span>No answer after 5 minutes for “{watch.label}”. Check Accounts to see if it connected, or try again.</span>
            {dismiss}
          </span>
        </Notice>
      ) : null}
    </section>
  );
}

function AccountsLink({ onOpen }: { onOpen(): void }) {
  return (
    <TextLink
      href={hrefOf("accounts")}
      onClick={(e) => {
        e.preventDefault();
        onOpen();
      }}
    >
      Accounts
    </TextLink>
  );
}

function ServiceCard(props: { service: ServiceHit; busy: boolean; onOpen(): void }) {
  const { service } = props;
  // The mockup names the source in the description line: "Files on your own server · Tealbrick catalog".
  const about = [service.description, service.source === "catalog" ? "Tealbrick catalog" : ""].filter(Boolean).join(" · ");
  return (
    <Card as="article" className="svc-card">
      <div className="tb-row">
        <ServiceTile name={service.name} />
        <h3>{service.name}</h3>
      </div>
      {about ? <p className="tb-soft">{about}</p> : null}
      <ConnectState {...props} />
    </Card>
  );
}

function ConnectState({ service, busy, onOpen }: { service: ServiceHit; busy: boolean; onOpen(): void }) {
  switch (service.connectMode) {
    case "needs_auth_config":
      return <p className="tb-hint">Needs an OAuth app in your Composio dashboard first.</p>;
    case "no_auth":
      return <p className="tb-hint">Needs no sign-in.</p>;
    case "not_supported":
      return <p className="tb-hint">Can’t be connected yet.</p>;
    default:
      return (
        <div className="tb-ctas">
          <Button variant="primary" size="sm" onClick={onOpen} disabled={busy} aria-label={`Connect ${service.name}`}>
            Connect
          </Button>
        </div>
      );
  }
}

const FIELD_LABEL: Record<string, string> = { token: "API token", username: "Username", password: "Password" };
const KIND_OPTIONS = [
  { value: "as_me", label: "As me" },
  { value: "as_itself", label: "As itself", meta: "one agent’s own account" },
];

/** Kind ("As me" / "As itself") and, for "As itself", the agent picker; shared by both connect flows. */
function KindFields({ kind, agent, onKind, onAgent, locked }: { kind: AccountKind; agent: string; onKind(k: AccountKind): void; onAgent(a: string): void; locked: boolean }) {
  const agents = useLoad(agentsList, kind);
  return (
    <>
      <Field label="Use this account">
        <Select options={KIND_OPTIONS} value={kind} onValueChange={(v) => onKind(v as AccountKind)} disabled={locked} />
      </Field>
      {kind === "as_itself" ? (
        <Field label="Agent">
          <Select
            options={(agents.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
            value={agent}
            onValueChange={onAgent}
            placeholder="Choose an agent"
            disabled={locked}
          />
        </Field>
      ) : null}
      {kind === "as_itself" && agents.error ? <Notice tone="error">{agents.error}</Notice> : null}
    </>
  );
}

function ConnectFlow(props: { service: ServiceHit; watch: Watch | null; onWatch(watch: Watch): void; onClose(): void; onOpenAccounts(): void }) {
  return props.service.source === "catalog" ? <CatalogFlow service={props.service} onClose={props.onClose} onOpenAccounts={props.onOpenAccounts} /> : <ComposioFlow {...props} />;
}

/** Composio services (choose, sign in, progress, done): sign in through a popup, then wait for the account to become connected. */
function ComposioFlow(props: { service: ServiceHit; watch: Watch | null; onWatch(watch: Watch): void; onClose(): void; onOpenAccounts(): void }) {
  const { service } = props;
  const [label, setLabel] = useState(service.name);
  const [kind, setKind] = useState<AccountKind>("as_me");
  const [agent, setAgent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [startedId, setStartedId] = useState<string | null>(null);
  const watch = props.watch && props.watch.accountId === startedId ? props.watch : null;

  // The connection ended (connected, failed or timed out) while the owner looks at the progress step: show the result.
  useEffect(() => {
    if (step === 2 && watch && watch.phase !== "waiting") setStep(3);
  }, [step, watch]);

  const account = () => {
    if (!label.trim()) return setError("Give this account a label.");
    if (kind === "as_itself" && !agent) return setError("Pick the agent this account belongs to.");
    setError(null);
    return true;
  };

  const signIn = async (): Promise<boolean> => {
    if (startedId) return true; // the sign-in window was opened already: never start a second connection
    setError(null);
    try {
      const out = await accountConnect({ service: service.service, label: label.trim(), kind, ...(kind === "as_itself" ? { agent } : {}) });
      let target: URL;
      try {
        target = new URL(out.redirectUrl);
      } catch {
        throw new Error("The sign-in address isn’t valid.");
      }
      if (target.protocol !== "https:") throw new Error("The sign-in address isn’t secure.");
      window.open(target.href, "tb-connect-signin", "popup,width=520,height=720,noopener,noreferrer");
      setStartedId(out.account.id);
      props.onWatch({ accountId: out.account.id, label: out.account.label, redirectUrl: target.href, phase: "waiting", detail: "" });
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  };

  const failure = error ? <Notice tone="error">{error}</Notice> : null;
  return (
    <StepFlow
      open
      kicker="Connect"
      title={service.name}
      step={step}
      onStepChange={(i) => {
        setError(null);
        setStep(i);
      }}
      onClose={props.onClose}
      onFinish={props.onClose}
      steps={[
        {
          name: "Account",
          onNext: () => account() === true,
          render: () => (
            <>
              <Field label="Label">
                <TextInput value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} disabled={startedId !== null} />
              </Field>
              <KindFields kind={kind} agent={agent} onKind={setKind} onAgent={setAgent} locked={startedId !== null} />
              {step === 0 ? failure : null}
            </>
          ),
        },
        {
          name: "Sign in",
          nextLabel: startedId ? "Next" : "Sign in and connect",
          onNext: signIn,
          render: () => (
            <>
              <p className="tb-soft">
                {startedId
                  ? `The sign-in window for ${service.name} was opened. Go on to follow the connection.`
                  : `A sign-in window for ${service.name} opens next. Sign in to your own account there, then come back here.`}
              </p>
              {step === 1 ? failure : null}
            </>
          ),
        },
        {
          name: "Progress",
          canNext: watch !== null && watch.phase !== "waiting",
          render: () => (
            <>
              <Progress label="Waiting for the sign-in" />
              {watch ? (
                <p className="tb-soft">
                  Waiting for you to finish signing in for “{watch.label}”. If no window opened,{" "}
                  <TextLink href={watch.redirectUrl} target="_blank" rel="noopener noreferrer">
                    open the sign-in page
                  </TextLink>
                  . You can close this window and come back; Connect keeps checking.
                </p>
              ) : null}
            </>
          ),
        },
        {
          name: "Done",
          nextLabel: "Done",
          render: () =>
            watch?.phase === "connected" ? (
              <Notice tone="ok">
                “{watch.label}” is connected. Next, set what each agent may do with it in{" "}
                <AccountsLink
                  onOpen={() => {
                    props.onClose();
                    props.onOpenAccounts();
                  }}
                />
                .
              </Notice>
            ) : watch?.phase === "failed" ? (
              <Notice tone="error">
                “{watch.label}” didn’t connect.{watch.detail ? ` ${watch.detail}` : ""}
              </Notice>
            ) : watch?.phase === "timeout" ? (
              <Notice tone="error">No answer after 5 minutes for “{watch.label}”. Check Accounts to see if it connected, or try again.</Notice>
            ) : null,
        },
      ]}
    />
  );
}

/** Catalog (self-hosted) services (choose, keys, done): address and API credentials; the account is connected at once, no popup. */
function CatalogFlow(props: { service: ServiceHit; onClose(): void; onOpenAccounts(): void }) {
  const { service } = props;
  const fields = service.fields && service.fields.length > 0 ? service.fields : ["token"];
  const [label, setLabel] = useState(service.name);
  const [baseUrl, setBaseUrl] = useState("");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [kind, setKind] = useState<AccountKind>("as_me");
  const [agent, setAgent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Watch | null>(null);
  const [step, setStep] = useState(0);

  const account = () => {
    if (!label.trim()) return setError("Give this account a label.");
    if (!baseUrl.trim()) return setError("Enter the address of the app.");
    if (kind === "as_itself" && !agent) return setError("Pick the agent this account belongs to.");
    setError(null);
    return true;
  };

  const connect = async (): Promise<boolean> => {
    if (result) return true; // connected already: never send the credentials twice
    setError(null);
    if (fields.some((f) => !credentials[f])) {
      setError("Fill in every credential field.");
      return false;
    }
    try {
      const out = await catalogAccountConnect({
        service: service.service,
        label: label.trim(),
        baseUrl: baseUrl.trim(),
        credentials: Object.fromEntries(fields.map((f) => [f, credentials[f] ?? ""])),
        kind,
        ...(kind === "as_itself" ? { agent } : {}),
      });
      setCredentials({});
      setResult({ accountId: out.account.id, label: out.account.label, redirectUrl: "", phase: out.account.status === "failed" ? "failed" : "connected", detail: out.account.detail });
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  };

  const failure = error ? <Notice tone="error">{error}</Notice> : null;
  return (
    <StepFlow
      open
      kicker="Connect"
      title={service.name}
      step={step}
      onStepChange={(i) => {
        setError(null);
        setStep(i);
      }}
      onClose={props.onClose}
      onFinish={props.onClose}
      steps={[
        {
          name: "Account",
          onNext: () => account() === true,
          render: () => (
            <>
              <Field label="Label">
                <TextInput value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} disabled={result !== null} />
              </Field>
              <Field label="Address of the app">
                <TextInput
                  type="url"
                  inputMode="url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={service.baseUrlExample ?? "https://"}
                  maxLength={300}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={result !== null}
                />
              </Field>
              <KindFields kind={kind} agent={agent} onKind={setKind} onAgent={setAgent} locked={result !== null} />
              {step === 0 ? failure : null}
            </>
          ),
        },
        {
          name: "Keys",
          nextLabel: result ? "Next" : "Connect",
          onNext: connect,
          render: () => (
            <>
              {fields.map((field) => (
                <Field key={field} label={FIELD_LABEL[field] ?? field}>
                  <TextInput
                    type="password"
                    value={credentials[field] ?? ""}
                    onChange={(e) => setCredentials((c) => ({ ...c, [field]: e.target.value }))}
                    maxLength={4096}
                    autoComplete="new-password"
                    spellCheck={false}
                    disabled={result !== null}
                  />
                </Field>
              ))}
              {service.credentialHint ? <p className="tb-hint">{service.credentialHint}</p> : null}
              <p className="tb-hint">The key stays in Connect. Connect never shows it again.</p>
              {step === 1 ? failure : null}
            </>
          ),
        },
        {
          name: "Done",
          nextLabel: "Done",
          render: () =>
            result?.phase === "connected" ? (
              <Notice tone="ok">
                “{result.label}” is connected. Next, set what each agent may do with it in{" "}
                <AccountsLink
                  onOpen={() => {
                    props.onClose();
                    props.onOpenAccounts();
                  }}
                />
                .
              </Notice>
            ) : result?.phase === "failed" ? (
              <Notice tone="error">
                “{result.label}” didn’t connect.{result.detail ? ` ${result.detail}` : ""}
              </Notice>
            ) : null,
        },
      ]}
    />
  );
}
