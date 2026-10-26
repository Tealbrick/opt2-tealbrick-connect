// C369: "More details" on a hold card. A button that opens a modal with the technical data of the held call: tool, upstream
// operation, Connect account and the input as formatted JSON (kept by Connect for the owner only, op hold_details), plus what the
// SDK knows of the hold (family, reason, caller, hold id, call id, times). The card itself stays human readable.
// SELF-CONTAINED on purpose: the packages lead will ship one shared card + modal in @opt2-tealbrick/ui; delete this file and the
// <HoldDetails> line in standard.tsx's HoldRow then. The modal is the ui package's native <dialog> (focus trap, Esc, inert page).
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Dialog } from "@opt2-tealbrick/ui";
import { useEffect, useState } from "react";

/** The fields of an SDK hold (receipt) this modal reads. */
export interface HoldLike {
  id: string;
  callId?: string | null;
  caller: { type?: string; id?: string; name: string };
  op: string;
  effect?: string;
  holdFamily: string | null;
  heldBy: string | null;
  inputDigest?: string;
  meta?: unknown;
  summary: string;
  createdAt?: number;
  expiresAt?: number | null;
}

interface Details {
  tool: string;
  title: string;
  service: string;
  source: string;
  upstream: string;
  method: string | null;
  path: string | null;
  account: { id: string; label: string } | null;
  arguments: string;
}
type State = { kind: "loading" } | { kind: "none" } | { kind: "error" } | { kind: "ok"; details: Details };

const metaOf = (hold: HoldLike): Record<string, unknown> => (hold.meta && typeof hold.meta === "object" && !Array.isArray(hold.meta) ? (hold.meta as Record<string, unknown>) : {});
const stamp = (ms: number | null | undefined): string | null => (typeof ms === "number" && Number.isFinite(ms) ? `${new Date(ms).toLocaleString()} (${new Date(ms).toISOString()})` : null);

export function HoldDetails({ hold }: { hold: HoldLike }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ kind: "loading" });
  const meta = metaOf(hold);
  const sha = typeof meta.viewSha256 === "string" ? meta.viewSha256 : null;

  useEffect(() => {
    if (!open) return;
    if (!sha) {
      setState({ kind: "none" });
      return;
    }
    let live = true;
    setState({ kind: "loading" });
    callOp<{ found: boolean; details?: Details }>("hold_details", { viewSha256: sha })
      .then((r) => live && setState(r.found && r.details ? { kind: "ok", details: r.details } : { kind: "none" }))
      .catch(() => live && setState({ kind: "error" }));
    return () => {
      live = false;
    };
  }, [open, sha]);

  const d = state.kind === "ok" ? state.details : null;
  const rows: [string, string | null][] = [
    ["Tool", d ? d.tool : typeof meta.tool === "string" ? meta.tool : hold.op],
    ["Operation", d ? (d.method && d.path ? `${d.method} ${d.path} (${d.upstream})` : d.upstream) : hold.op],
    ["Connect account", d ? (d.account ? `${d.account.label} (${d.account.id})` : "not chosen") : null],
    ["Held calls of", hold.holdFamily],
    ["Held by", hold.heldBy],
    ["Agent", `${hold.caller.name}${hold.caller.id ? ` (${hold.caller.id})` : ""}`],
    ["Hold id", hold.id],
    ["Call id", hold.callId ?? null],
    ["Created", stamp(hold.createdAt)],
    ["Expires", stamp(hold.expiresAt)],
    ["Input digest", hold.inputDigest ?? null],
  ];
  return (
    <>
      <Button size="sm" aria-haspopup="dialog" aria-label={`More details of ${hold.op} from ${hold.caller.name}`} onClick={() => setOpen(true)}>
        More details
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} kicker="Technical details" title={hold.caller.name} size="lg" className="hold-details">
        <p className="muted">{hold.summary}</p>
        <dl className="hold-facts">
          {rows
            .filter(([, v]) => v !== null && v !== "")
            .map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
        </dl>
        <h3>Input</h3>
        {state.kind === "loading" ? <p role="status">Loading…</p> : null}
        {state.kind === "error" ? <p role="alert">Could not load the input. Try again.</p> : null}
        {state.kind === "none" ? <p>Connect has no input for this call. It keeps the input of tool calls for one day only.</p> : null}
        {d ? <pre className="view">{d.arguments}</pre> : null}
      </Dialog>
    </>
  );
}
