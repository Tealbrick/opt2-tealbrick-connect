/** Chat bots (C58): connect a Slack, Teams, Telegram or Discord bot for one agent; see inbound status. */
import { Button, Card, EmptyState, Field, type FlowStep, Segmented, Select, StepFlow, Swatch, Switch, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useState } from "react";

import { LoadError, Notice, PageHead, PageNote, StatusLabel } from "../components.tsx";
import { errorText, useLoad } from "../hooks.ts";
import { type ChannelProviderInfo, channelAccountConnect, channelAccounts, channelProviders } from "../ops.ts";

type Service = ChannelProviderInfo["service"];

/** IN-2 (C334(2)): the one-time Slack step for the Approve / Deny buttons of Operator Inbox alerts (ASD-STE100). */
function SlackButtonsSteps() {
  return (
    <div className="tb-soft">
      <p>The Approve and Deny buttons of Operator Inbox alerts need Interactivity. Do these steps one time for each Slack app:</p>
      <ol>
        <li>Open api.slack.com/apps and select your Teal Brick app.</li>
        <li>Select Interactivity &amp; Shortcuts.</li>
        <li>Set Interactivity to On. Socket Mode needs no Request URL.</li>
        <li>Select Save Changes.</li>
        <li>If Slack tells you to reinstall the app, select Reinstall to Workspace.</li>
      </ol>
      <p>If Interactivity is off, the alert shows the buttons, but a click does nothing. You can always decide in Operator Inbox.</p>
    </div>
  );
}

const NAMES: Record<Service, string> = { slack: "Slack", teams: "Microsoft Teams", telegram: "Telegram", discord: "Discord" };
const HELP: Record<Service, string> = {
  slack: "Create a Slack app with Socket Mode and Interactivity on, install it, then paste the bot token (xoxb-…) and the app-level token (xapp-…, scope connections:write).",
  teams: "Create a single-tenant Azure Bot. Set its messaging endpoint to your workspace door: https://<bridge>/p/connect/inbound/teams.",
  telegram: "Create a bot with @BotFather and paste its token. People must start a chat with the bot before it can message them.",
  discord: "Create a bot in the Discord developer portal, invite it to your server, paste its token.",
};
const label = (field: string) => field.replace(/_/gu, " ").replace(/^./u, (c) => c.toUpperCase());

export function Chat() {
  const providers = useLoad(channelProviders);
  const accounts = useLoad(channelAccounts);
  const [service, setService] = useState<Service | null>(null);
  const [adding, setAdding] = useState(false);
  const services = providers.data?.services ?? [];
  const picked = services.find((p) => p.service === service) ?? services[0] ?? null;
  return (
    <section className="app-page" aria-label="Chat bots">
      <PageHead title="Chat bots" />
      <PageNote>Give an agent its own bot on Slack, Teams, Telegram or Discord. Messages to the bot reach the agent’s inbox.</PageNote>
      {providers.error ? <LoadError message={providers.error} busy={providers.loading} onRetry={() => void providers.reload()} /> : null}
      {picked ? (
        <>
          <Segmented<Service>
            label="Provider"
            options={services.map((p) => ({ value: p.service, label: p.service === "teams" ? "Teams" : NAMES[p.service] }))}
            value={picked.service}
            onChange={setService}
          />
          <Card className="bot-card">
            <h2 className="sub-head">{NAMES[picked.service]}</h2>
            <p className="tb-soft">{HELP[picked.service]}</p>
            {picked.service === "slack" ? <SlackButtonsSteps /> : null}
            <div className="tb-ctas">
              <Button variant="primary" onClick={() => setAdding(true)}>
                {`Connect a ${NAMES[picked.service]} bot`}
              </Button>
            </div>
          </Card>
        </>
      ) : null}
      {adding && picked ? (
        <BotFlow
          key={picked.service}
          provider={picked}
          agents={providers.data?.agents ?? []}
          onConnected={() => void accounts.reload()}
          onClose={() => setAdding(false)}
        />
      ) : null}
      <h2 className="sub-head">Connected bots</h2>
      {accounts.error ? <LoadError message={accounts.error} busy={accounts.loading} onRetry={() => void accounts.reload()} /> : null}
      {accounts.data && accounts.data.accounts.length === 0 ? <EmptyState title="No chat bots yet." /> : null}
      {accounts.data && accounts.data.accounts.length > 0 ? (
        <div className="ruled">
          {accounts.data.accounts.map((a) => (
            <div key={a.id} className="item">
              <Swatch />
              <h3>{a.label}</h3>
              {a.bot ? (
                <p>
                  Bot {a.bot.name}. Inbound: {a.bot.inbound}
                  {a.bot.detail ? ` (${a.bot.detail})` : ""}
                </p>
              ) : null}
              <div className="side">
                <Tag>{NAMES[a.service as Service] ?? a.service}</Tag>
                <StatusLabel status={a.status} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** Bot set-up in steps (C126): the bot, its keys, its settings (only when the provider has any), then done. */
function BotFlow(props: { provider: ChannelProviderInfo; agents: { id: string; name: string }[]; onConnected(): void; onClose(): void }) {
  const { provider } = props;
  const toggles = provider.settingFields.filter((f) => f.type === "boolean");
  const [labelText, setLabel] = useState(NAMES[provider.service]);
  const [agent, setAgent] = useState(props.agents[0]?.id ?? "");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Record<string, string | boolean>>(Object.fromEntries(provider.settingFields.map((f) => [f.key, f.default])));
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [step, setStep] = useState(0);

  const fail = (message: string): false => {
    setError(message);
    return false;
  };
  const bot = (): boolean => {
    if (!labelText.trim()) return fail("Give this bot a name.");
    if (!agent) return fail("Pick the agent this bot speaks for.");
    setError(null);
    return true;
  };
  const keys = (): boolean => {
    if (provider.credentialFields.some((f) => !creds[f])) return fail("Fill in every key field.");
    setError(null);
    return true;
  };
  const keysLast = toggles.length === 0;
  const connect = async (): Promise<boolean> => {
    if (connected) return true; // connected already: never send the keys twice
    setError(null);
    try {
      await channelAccountConnect({ service: provider.service, label: labelText, agent, credentials: creds, settings });
      setCreds({});
      setConnected(true);
      props.onConnected();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  };

  const failure = error ? <Notice tone="error">{error}</Notice> : null;
  const steps: FlowStep[] = [
    {
      name: "Bot",
      onNext: bot,
      render: () => (
        <>
          <p className="tb-soft">{HELP[provider.service]}</p>
          {provider.service === "slack" ? <SlackButtonsSteps /> : null}
          <Field label="Name">
            <TextInput value={labelText} onChange={(e) => setLabel(e.target.value)} maxLength={60} disabled={connected} />
          </Field>
          <Field label="Agent this bot speaks for">
            <Select options={props.agents.map((a) => ({ value: a.id, label: a.name }))} value={agent} onValueChange={setAgent} placeholder="Choose an agent" disabled={connected} />
          </Field>
          {props.agents.length === 0 ? <p className="tb-hint">No agents yet. Add an agent in Tealbrick Portal first.</p> : null}
          {step === 0 ? failure : null}
        </>
      ),
    },
    {
      name: "Keys",
      nextLabel: keysLast ? (connected ? "Next" : "Connect bot") : "Next",
      onNext: keysLast ? async () => keys() && (await connect()) : keys,
      render: () => (
        <>
          {provider.credentialFields.map((f) => (
            <Field key={f} label={label(f)}>
              <TextInput type="password" autoComplete="off" value={creds[f] ?? ""} onChange={(e) => setCreds({ ...creds, [f]: e.target.value })} disabled={connected} />
            </Field>
          ))}
          <p className="tb-hint">The keys stay in Connect. Connect never shows them again.</p>
          {step === 1 ? failure : null}
        </>
      ),
    },
    ...(toggles.length > 0
      ? [
          {
            name: "Settings",
            nextLabel: connected ? "Next" : "Connect bot",
            onNext: connect,
            render: () => (
              <>
                {toggles.map((f) => (
                  <Switch
                    key={f.key}
                    label={f.label}
                    checked={settings[f.key] === true || settings[f.key] === "true"}
                    onCheckedChange={(on) => setSettings({ ...settings, [f.key]: on })}
                    disabled={connected}
                  />
                ))}
                {step === 2 ? failure : null}
              </>
            ),
          } satisfies FlowStep,
        ]
      : []),
    {
      name: "Done",
      nextLabel: "Done",
      render: () => (
        <Notice tone="ok">
          “{labelText}” is connected. Set what the agent may do with it on the Accounts page.
        </Notice>
      ),
    },
  ];
  return (
    <StepFlow
      open
      kicker="Chat bots"
      title={`Connect a ${NAMES[provider.service]} bot`}
      steps={steps}
      step={step}
      onStepChange={(i) => {
        setError(null);
        setStep(i);
      }}
      onClose={props.onClose}
      onFinish={props.onClose}
    />
  );
}
