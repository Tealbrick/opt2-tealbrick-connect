import { Button, Card, EmptyState, Field, Progress, Select, StepFlow, Textarea, TextInput, TextLink } from "@opt2-tealbrick/ui";
import { useEffect, useState } from "react";

import { LoadError, Notice, PageHead, ServiceTile } from "../components.tsx";
import { errorText, useLoad } from "../hooks.ts";
import { type AccountKind, accountConnect, accountsOverview, agentsList, apiAdd, apiPreview, catalogAccountConnect, type OwnApiInput, type OwnApiPreview, type ServiceHit, servicesSearch } from "../ops.ts";
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
  const [addingApi, setAddingApi] = useState(false);

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

      <Card className="own-api">
        <h2>Your own API</h2>
        <p className="tb-soft">
          A service that is not in this list but has an OpenAPI description (for example an invoicing, shipping or website API)? Add the description; Connect makes one tool per
          operation and holds every call that reaches people, removes data or spends money until you approve it.
        </p>
        <Button size="sm" onClick={() => setAddingApi(true)} disabled={picked !== null}>
          Add your own API
        </Button>
      </Card>

      {picked ? <ConnectFlow key={picked.service} service={picked} watch={watch} onWatch={setWatch} onClose={closeFlow} onOpenAccounts={props.onOpenAccounts} /> : null}
      {addingApi ? (
        <OwnApiFlow
          onClose={() => setAddingApi(false)}
          onSaved={(service) => {
            setAddingApi(false);
            setQuery(service);
            void results.reload();
          }}
        />
      ) : null}
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

const AUTH_OPTIONS = [
  { value: "header", label: "Key in a header", meta: "for example Authorization: Bearer <key>" },
  { value: "query", label: "Key in the address", meta: "a query parameter" },
  { value: "basic", label: "User name and password" },
  { value: "none", label: "No key" },
];
const EFFECT_WORDS: Record<string, string> = {
  read: "Reads (runs without approval)",
  write: "Changes data in the service",
  outward: "Reaches people or the public (held)",
  destructive: "Removes data (held)",
  money: "Spends money (always held)",
};
const lines = (v: string) =>
  v
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** C373 T2 "bring your own API": describe → check the tools and their hold classes → save. Nothing is saved before step 3. */
function OwnApiFlow(props: { onClose(): void; onSaved(service: string): void }) {
  const [name, setName] = useState("");
  const [spec, setSpec] = useState("");
  const [authType, setAuthType] = useState<OwnApiInput["auth"]["type"]>("header");
  const [authName, setAuthName] = useState("Authorization");
  const [prefix, setPrefix] = useState("Bearer ");
  const [basePath, setBasePath] = useState("");
  const [health, setHealth] = useState("");
  const [labels, setLabels] = useState({ outward: "", money: "", destructive: "", reads: "", excluded: "" });
  const [preview, setPreview] = useState<OwnApiPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);

  const input = (): OwnApiInput => ({
    name: name.trim(),
    spec,
    auth: authType === "header" ? { type: "header", name: authName.trim(), ...(prefix ? { prefix } : {}) } : authType === "query" ? { type: "query", name: authName.trim() } : { type: authType },
    labels: Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, lines(v)])) as NonNullable<OwnApiInput["labels"]>,
    ...(basePath.trim() ? { basePath: basePath.trim() } : {}),
    ...(health.trim() ? { healthOperation: health.trim() } : {}),
  });
  const check = async (): Promise<boolean> => {
    setError(null);
    if (!name.trim()) {
      setError("Give the API a name.");
      return false;
    }
    try {
      setPreview((await apiPreview(input())).preview);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  };
  const save = async (): Promise<boolean> => {
    setError(null);
    try {
      const out = await apiAdd(input());
      props.onSaved(out.preview.service);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  };
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return setError("The file is larger than 2 MiB.");
    setSpec(await file.text());
  };
  const failure = error ? <Notice tone="error">{error}</Notice> : null;
  const labelField = (key: keyof typeof labels, title: string, hint: string) => (
    <Field label={title} hint={hint}>
      <Textarea value={labels[key]} onChange={(e) => setLabels({ ...labels, [key]: e.target.value })} rows={2} spellCheck={false} />
    </Field>
  );
  return (
    <StepFlow
      open
      kicker="Your own API"
      title={name.trim() || "Add your own API"}
      step={step}
      onStepChange={(i) => {
        setError(null);
        setStep(i);
      }}
      onClose={props.onClose}
      onFinish={props.onClose}
      steps={[
        {
          name: "Describe",
          onNext: () => check(),
          render: () => (
            <>
              <Field label="Name">
                <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Fatture in Cloud" />
              </Field>
              <Field label="OpenAPI description (JSON)" hint="OpenAPI 3 or Swagger 2, at most 2 MiB. Convert a YAML file to JSON first.">
                <input type="file" accept=".json,application/json" aria-label="Choose a description file" onChange={(e) => void readFile(e.target.files?.[0])} />
                <Textarea value={spec} onChange={(e) => setSpec(e.target.value)} rows={6} spellCheck={false} aria-label="Or paste the description" />
              </Field>
              <Field label="How the key is sent">
                <Select options={AUTH_OPTIONS} value={authType} onValueChange={(v) => setAuthType(v as OwnApiInput["auth"]["type"])} />
              </Field>
              {authType === "header" || authType === "query" ? (
                <Field label={authType === "header" ? "Header name" : "Parameter name"}>
                  <TextInput value={authName} onChange={(e) => setAuthName(e.target.value)} maxLength={64} spellCheck={false} />
                </Field>
              ) : null}
              {authType === "header" ? (
                <Field label="Before the key" hint='For example "Bearer " (with the space). Empty when the header holds only the key.'>
                  <TextInput value={prefix} onChange={(e) => setPrefix(e.target.value)} maxLength={32} spellCheck={false} />
                </Field>
              ) : null}
              <Field label="Path prefix (optional)" hint="Only when the description's server address is missing or wrong, for example /wp-json.">
                <TextInput value={basePath} onChange={(e) => setBasePath(e.target.value)} maxLength={200} spellCheck={false} />
              </Field>
              <Field label="Test operation (optional)" hint="The operationId of a cheap GET that Test calls.">
                <TextInput value={health} onChange={(e) => setHealth(e.target.value)} maxLength={200} spellCheck={false} />
              </Field>
              <p className="tb-soft">
                Hold labels: one pattern per line, an operationId, "METHOD /path" or a pattern with *. Without a label, GET reads, DELETE removes, and any other call takes the class of
                its name (send, post, publish: held).
              </p>
              {labelField("money", "Spends money", "For example createShipmentLabel or POST /orders/*/pay")}
              {labelField("outward", "Reaches people or the public", "For example sendEInvoice")}
              {labelField("destructive", "Removes data", "")}
              {labelField("reads", "POST calls that only read", "")}
              {labelField("excluded", "Never offer to agents", "")}
              {failure}
            </>
          ),
        },
        {
          name: "Check",
          onNext: () => save(),
          render: () =>
            preview ? (
              <>
                <p>
                  {preview.operations} tools from {preview.name}.
                </p>
                <ul aria-label="Tools by class">
                  {Object.entries(preview.counts).map(([effect, n]) => (
                    <li key={effect}>
                      {EFFECT_WORDS[effect] ?? effect}: {n}
                    </li>
                  ))}
                </ul>
                {preview.warnings.map((w) => (
                  <Notice key={w}>{w}</Notice>
                ))}
                <table className="own-api-tools">
                  <thead>
                    <tr>
                      <th>Operation</th>
                      <th>Call</th>
                      <th>Class</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.tools.slice(0, 200).map((t) => (
                      <tr key={t.operationId}>
                        <td>{t.operationId}</td>
                        <td>
                          {t.method} {t.path}
                        </td>
                        <td>{t.effect}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {failure}
              </>
            ) : (
              failure
            ),
        },
        {
          name: "Saved",
          render: () => <p>Saved. Find it in the list and connect an account with its address and key.</p>,
        },
      ]}
    />
  );
}
