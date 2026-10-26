/**
 * SDK-HV-1 / QA R-1: what the owner sees on a hold of a dynamic SEND tool (Connect `tools`). Recipients (to/cc/bcc or the
 * channel), subject, the first 500 characters of the text as PLAIN text (HTML stripped, never rendered) and attachment names
 * and sizes only. Content that lives upstream (a Gmail draft, a forwarded message) is READ with the same account the call
 * would use; content in the arguments is taken from the arguments. Pure text functions here; app.ts wires the account.
 * The SDK binds the approval to sha256 of this text, so the view must be deterministic for the same upstream content.
 */

import { recipientsOf } from "./effect.ts";

export const PREVIEW_CHARS = 500;
const LINE_MAX = 1000;
const SUBJECT_MAX = 300;
const ATTACHMENTS_SHOWN = 20;
const NAME_MAX = 120;
const SUMMARY_MAX = 280;

export interface MailView {
  to: string[];
  cc: string[];
  bcc: string[];
  channel: string[];
  subject: string | null;
  /** plain text (already stripped) */
  text: string | null;
  attachments: { name: string; size: number | null }[];
}

const emptyMail = (): MailView => ({ to: [], cc: [], bcc: [], channel: [], subject: null, text: null, attachments: [] });

/** Bidi overrides/isolates, zero-width and BOM (visual spoofing) and C0/C1 controls except tab and newline. */
const isInvisible = (cp: number): boolean =>
  (cp <= 0x1f && cp !== 0x09 && cp !== 0x0a) ||
  (cp >= 0x7f && cp <= 0x9f) ||
  (cp >= 0x200b && cp <= 0x200f) ||
  (cp >= 0x202a && cp <= 0x202e) ||
  (cp >= 0x2060 && cp <= 0x2064) ||
  (cp >= 0x2066 && cp <= 0x2069) ||
  cp === 0xfeff;
const stripInvisible = (s: string): string => Array.from(s, (ch) => (isInvisible(ch.codePointAt(0) ?? 0) ? "" : ch)).join("");
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const looksLikeHtml = (s: string) => /<\/?(?:html|body|div|p|br|span|table|a|b|i|strong|em|font|img|ul|ol|li|h[1-6])\b[^>]*>/iu.test(s);

/** Plain text of an upstream or agent-written text: HTML stripped (tags removed, never rendered), entities decoded, invisible characters removed. */
export function plainText(raw: string, isHtml = false): string {
  let s = raw;
  if (isHtml || looksLikeHtml(s)) {
    s = s
      .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/giu, " ")
      .replace(/<!--[\s\S]*?-->/gu, " ")
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/giu, "\n")
      .replace(/<[^>]*>/gu, " ");
    s = s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+|#39);/giu, (m, e: string) => {
      const k = e.toLowerCase();
      if (k.startsWith("#x")) return safeCodePoint(Number.parseInt(k.slice(2), 16), m);
      if (k.startsWith("#") && k !== "#39") return safeCodePoint(Number.parseInt(k.slice(1), 10), m);
      return NAMED_ENTITIES[k] ?? m;
    });
  }
  return stripInvisible(s.replace(/\r\n?/gu, "\n"))
    .replace(/[ \t ]+/gu, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function safeCodePoint(n: number, fallback: string): string {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(n);
  } catch {
    return fallback;
  }
}

const one = (s: string, max: number) => {
  const p = plainText(s).replace(/\s+/gu, " ");
  return p.length <= max ? p : `${p.slice(0, max - 1)}…`;
};

function listLine(label: string, items: readonly string[]): string | null {
  if (items.length === 0) return null;
  const shown: string[] = [];
  let len = 0;
  for (const it of items) {
    const v = one(it, 320);
    if (len + v.length + 2 > LINE_MAX) break;
    shown.push(v);
    len += v.length + 2;
  }
  const more = items.length - shown.length;
  return `${label}: ${shown.join(", ")}${more > 0 ? ` (and ${more} more)` : ""}`;
}

export function formatSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "size unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The owner-facing hold text. `heading` names the action, `account` the connected account label. */
export function renderHoldView(input: { heading: string; account: string; mail: MailView; notes?: readonly string[] }): string {
  const m = input.mail;
  const lines: (string | null)[] = [
    one(input.heading, 200),
    `Account: ${one(input.account, 200)}`,
    listLine("To", m.to),
    listLine("Cc", m.cc),
    listLine("Bcc", m.bcc),
    listLine("Channel", m.channel),
    m.subject !== null ? `Subject: ${one(m.subject, SUBJECT_MAX) || "(no subject)"}` : null,
  ];
  if (m.attachments.length > 0) {
    const shown = m.attachments.slice(0, ATTACHMENTS_SHOWN).map((a) => `${one(a.name, NAME_MAX) || "(no name)"} (${formatSize(a.size)})`);
    const more = m.attachments.length - shown.length;
    lines.push(`Attachments (names only): ${shown.join(", ")}${more > 0 ? ` (and ${more} more)` : ""}`);
  }
  for (const n of input.notes ?? []) lines.push(one(n, LINE_MAX));
  const out = lines.filter((l): l is string => l !== null);
  if (m.text !== null) {
    const text = m.text;
    const chars = [...text];
    const head = chars.slice(0, PREVIEW_CHARS).join("");
    const rest = chars.length - PREVIEW_CHARS;
    out.push("", rest > 0 ? `Text (plain text, first ${PREVIEW_CHARS} characters; ${rest} more not shown):` : "Text (plain text):", head || "(empty)");
  } else {
    out.push("", "Text: (none found)");
  }
  return out.join("\n");
}

/** Hold summary (≤ 280): the action, the subject and the first recipient. */
export function holdSummary(heading: string, mail: MailView): string {
  const who = [...mail.to, ...mail.cc, ...mail.bcc, ...mail.channel];
  const parts = [one(heading, 120)];
  if (mail.subject) parts.push(`"${one(mail.subject, 80)}"`);
  if (who[0]) parts.push(`to ${one(who[0], 80)}${who.length > 1 ? ` (+${who.length - 1})` : ""}`);
  const s = parts.join(" ");
  return s.length <= SUMMARY_MAX ? s : `${s.slice(0, SUMMARY_MAX - 1)}…`;
}

// ── content from the call arguments (GMAIL_SEND_EMAIL, Slack/Telegram/Discord posts, catalog and MCP send tools) ──

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/gu, "");
const TO_KEYS = new Set([
  "to", "recipient", "recipients", "recipientemail", "recipientemails", "extrarecipients", "toemail", "toemails", "toaddress", "toaddresses",
  "torecipients", "email", "emails", "emailaddress", "emailaddresses", "attendees", "invitees", "phone", "phonenumber", "tonumber", "userid", "username", "user",
]);
const CC_KEYS = new Set(["cc", "ccemails", "ccrecipients"]);
const BCC_KEYS = new Set(["bcc", "bccemails", "bccrecipients"]);
const CHANNEL_KEYS = new Set(["channel", "channelid", "channelname", "chatid", "conversationid"]);
const SUBJECT_KEYS = new Set(["subject", "title"]);
const TEXT_KEYS = ["body", "messagebody", "text", "markdowntext", "message", "content", "htmlbody", "additionaltext", "comment", "caption"];
const ATTACHMENT_KEYS = new Set(["attachment", "attachments", "file", "files"]);

/** Recipients of one argument value in the stable form of the first-contact check (`Name <a@b.c>` → a@b.c). */
const addresses = (value: unknown): string[] => recipientsOf({ to: value });

function attachmentsOf(value: unknown): { name: string; size: number | null }[] {
  const items = Array.isArray(value) ? value : [value];
  const out: { name: string; size: number | null }[] = [];
  for (const it of items.slice(0, 100)) {
    if (typeof it === "string" && it.trim()) out.push({ name: it.split(/[\\/]/u).pop() ?? it, size: null });
    else if (it && typeof it === "object") {
      const o = it as Record<string, unknown>;
      const name = o.name ?? o.filename ?? o.fileName ?? o.file_name ?? o.title;
      const size = o.size ?? o.sizeBytes ?? o.size_bytes ?? o.length;
      if (typeof name === "string" || typeof size === "number") out.push({ name: typeof name === "string" ? name : "", size: typeof size === "number" ? size : null });
    }
  }
  return out;
}

/** MailView from the arguments of a send tool. `is_html` (Composio Gmail) marks the body as HTML. */
export function mailFromArgs(args: Record<string, unknown>): MailView {
  const m = emptyMail();
  const html = args.is_html === true || args.isHtml === true;
  const byKey = new Map(Object.entries(args).map(([k, v]) => [norm(k), v] as const));
  for (const [k, v] of byKey) {
    if (TO_KEYS.has(k)) m.to.push(...addresses(v));
    else if (CC_KEYS.has(k)) m.cc.push(...addresses(v));
    else if (BCC_KEYS.has(k)) m.bcc.push(...addresses(v));
    else if (CHANNEL_KEYS.has(k) && (typeof v === "string" || typeof v === "number")) m.channel.push(String(v));
    else if (SUBJECT_KEYS.has(k) && typeof v === "string" && m.subject === null) m.subject = v;
    else if (ATTACHMENT_KEYS.has(k)) m.attachments.push(...attachmentsOf(v));
  }
  for (const k of TEXT_KEYS) {
    const v = byKey.get(k);
    if (typeof v === "string") {
      m.text = plainText(v, html || k === "htmlbody");
      break;
    }
  }
  m.to = [...new Set(m.to)];
  m.cc = [...new Set(m.cc)];
  m.bcc = [...new Set(m.bcc)];
  return m;
}

// ── content read upstream (Gmail API message / draft, or Composio's processed message form) ──

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function b64urlText(data: unknown): string | null {
  if (typeof data !== "string" || data.length === 0) return null;
  try {
    return Buffer.from(data.replace(/-/gu, "+").replace(/_/gu, "/"), "base64").toString("utf8");
  } catch {
    return null;
  }
}

/** The Gmail message object inside a tool result: `{payload}` / `{message: {payload}}` / Composio wrappers, depth ≤ 4. */
export function findGmailMessage(data: unknown, depth = 0): Obj | null {
  if (!isObj(data) || depth > 4) return null;
  if (isObj(data.payload) || typeof data.messageText === "string" || isObj(data.preview)) return data;
  for (const key of ["message", "draft", "data", "response_data", "response", "result"]) {
    const found = findGmailMessage(data[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function headerMap(payload: Obj | null): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const headers = payload?.headers;
  if (!Array.isArray(headers)) return map;
  for (const h of headers) {
    if (!isObj(h) || typeof h.name !== "string" || typeof h.value !== "string") continue;
    const k = h.name.toLowerCase();
    map.set(k, [...(map.get(k) ?? []), h.value]);
  }
  return map;
}

function walkParts(part: Obj, out: { plain: string | null; html: string | null; attachments: { name: string; size: number | null }[] }, depth = 0): void {
  if (depth > 8) return;
  const mime = typeof part.mimeType === "string" ? part.mimeType.toLowerCase() : "";
  const body = isObj(part.body) ? part.body : {};
  const filename = typeof part.filename === "string" ? part.filename : "";
  if (filename) out.attachments.push({ name: filename, size: typeof body.size === "number" ? body.size : null });
  else if (mime === "text/plain" && out.plain === null) out.plain = b64urlText(body.data);
  else if (mime === "text/html" && out.html === null) out.html = b64urlText(body.data);
  if (Array.isArray(part.parts)) for (const p of part.parts) if (isObj(p)) walkParts(p, out, depth + 1);
}

/** MailView of a Gmail message or draft as Composio returns it (raw Gmail API resource or processed fields). Null when nothing is found. */
export function mailFromGmail(data: unknown): MailView | null {
  const msg = findGmailMessage(data);
  if (!msg) return null;
  const m = emptyMail();
  const payload = isObj(msg.payload) ? msg.payload : null;
  const headers = headerMap(payload);
  const hdr = (k: string) => (headers.get(k) ?? []).flatMap((v) => addresses(v));
  m.to = hdr("to");
  m.cc = hdr("cc");
  m.bcc = hdr("bcc");
  m.subject = headers.get("subject")?.[0] ?? null;
  const parts = { plain: null as string | null, html: null as string | null, attachments: [] as { name: string; size: number | null }[] };
  if (payload) walkParts(payload, parts);
  m.attachments = parts.attachments;
  if (parts.plain !== null) m.text = plainText(parts.plain);
  else if (parts.html !== null) m.text = plainText(parts.html, true);
  // Composio's processed form (GMAIL_FETCH_* style): to / subject / messageText / preview / attachmentList
  if (m.to.length === 0 && typeof msg.to === "string") m.to = addresses(msg.to);
  if (m.subject === null) m.subject = typeof msg.subject === "string" ? msg.subject : isObj(msg.preview) && typeof msg.preview.subject === "string" ? msg.preview.subject : null;
  if (m.text === null) {
    const t = typeof msg.messageText === "string" ? msg.messageText : isObj(msg.preview) && typeof msg.preview.body === "string" ? msg.preview.body : typeof msg.snippet === "string" ? msg.snippet : null;
    if (t !== null) m.text = plainText(t);
  }
  if (m.attachments.length === 0 && Array.isArray(msg.attachmentList)) m.attachments = attachmentsOf(msg.attachmentList);
  return m;
}

/** Upstream reads a Gmail send tool needs before the owner can see what it sends (null = the arguments carry the content). */
export function gmailContentRead(upstream: string, args: Record<string, unknown>): { slug: string; args: Record<string, unknown>; kind: "draft" | "forward" } | null {
  const user = typeof args.user_id === "string" && args.user_id ? args.user_id : "me";
  if (upstream === "GMAIL_SEND_DRAFT" && typeof args.draft_id === "string" && args.draft_id) return { slug: "GMAIL_GET_DRAFT", args: { user_id: user, draft_id: args.draft_id, format: "full" }, kind: "draft" };
  if (upstream === "GMAIL_FORWARD_MESSAGE" && typeof args.message_id === "string" && args.message_id) return { slug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", args: { user_id: user, message_id: args.message_id, format: "full" }, kind: "forward" };
  return null;
}

// ── C368/C369: the readable fallback for every other dynamic tool ──

const FIELDS_SHOWN = 60;
const SCALAR_MAX = 300;
const TEXT_BLOCK_MAX = 1500;
const GENERIC_MAX = 15_000;
const DEPTH_MAX = 6;

/** `recipient_email` / `recipientEmail` → "Recipient email". */
const humanize = (key: string): string => {
  const words = key.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/[_\-.]+/gu, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "(unnamed)";
};

interface Field {
  label: string;
  /** a short value goes on the label's line; a long or multi-line text goes under it */
  value: string;
  block: boolean;
}

function collectFields(value: unknown, path: string[], out: Field[], state: { more: number }, depth: number): void {
  const label = path.map((p) => (/^#\d+$/u.test(p) ? p : humanize(p))).join(" › ");
  const push = (field: Field) => {
    if (out.length >= FIELDS_SHOWN) state.more += 1;
    else out.push(field);
  };
  if (value === null || value === undefined) {
    push({ label, value: "(empty)", block: false });
    return;
  }
  if (typeof value === "boolean") {
    push({ label, value: value ? "yes" : "no", block: false });
    return;
  }
  if (typeof value === "number") {
    push({ label, value: String(value), block: false });
    return;
  }
  if (typeof value === "string") {
    const text = plainText(value);
    if (text.length > 100 || text.includes("\n")) {
      const chars = [...text];
      const rest = chars.length - TEXT_BLOCK_MAX;
      push({ label: rest > 0 ? `${label} (plain text, first ${TEXT_BLOCK_MAX} characters; ${rest} more not shown)` : `${label} (plain text)`, value: chars.slice(0, TEXT_BLOCK_MAX).join(""), block: true });
      return;
    }
    push({ label, value: one(text, SCALAR_MAX) || "(empty)", block: false });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
    push({ label, value: "(none)", block: false });
    return;
  }
    if (value.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v)) && value.length <= 20) {
      const joined = value.map((v) => (typeof v === "string" ? one(v, 120) : String(v))).join(", ");
      push({ label, value: one(joined, SCALAR_MAX), block: false });
      return;
    }
    value.forEach((item, i) => {
      if (i < 20 && depth < DEPTH_MAX) collectFields(item, [...path, `#${i + 1}`], out, state, depth + 1);
      else state.more += 1;
    });
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (entries.length === 0) {
    push({ label, value: "(none)", block: false });
    return;
  }
    if (depth >= DEPTH_MAX) {
    push({ label, value: `(${entries.length} more fields)`, block: false });
    return;
  }
    for (const [k, v] of entries) collectFields(v, [...path, k], out, state, depth + 1);
  }
}

/**
 * C368/C369: the owner's card for a held call of a dynamic tool without a special view: what the tool is, which account, and the
 * arguments as labelled lines (never a JSON blob). Long text is shown as text with HTML stripped. Keys are sorted so the same
 * input always gives the same text (the approval is bound to it). The raw arguments are in "More details" for the owner.
 */
export function renderGenericHold(input: { heading: string; account: string; args: Record<string, unknown> }): { summary: string; view: string } {
  const fields: Field[] = [];
  const state = { more: 0 };
  const entries = Object.entries(input.args).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [k, v] of entries) collectFields(v, [k], fields, state, 0);
  const lines: string[] = [one(input.heading, 200), `Account: ${one(input.account, 200)}`, ""];
  if (fields.length === 0) lines.push("No arguments.");
  for (const f of fields) {
    if (f.block) lines.push(`${f.label}:`, ...f.value.split("\n").map((l) => `  ${l}`));
    else lines.push(`${f.label}: ${f.value}`);
  }
  if (state.more > 0) lines.push(`(and ${state.more} more fields not shown; see More details)`);
  let view = lines.join("\n");
  if (view.length > GENERIC_MAX) view = `${view.slice(0, GENERIC_MAX - 40)}\n(the rest is not shown)`;
  const first = fields.find((f) => !f.block);
  const summary = [one(input.heading, 160), first ? `${first.label}: ${one(first.value, 80)}` : null].filter(Boolean).join(" · ");
  return { summary: summary.length <= SUMMARY_MAX ? summary : `${summary.slice(0, SUMMARY_MAX - 1)}…`, view };
}

/**
 * The words an owner reads for a tool. A catalog operation without a summary has the title "PUT /public/v1/posts/{id}/status";
 * its operation id ("PublicIntegrationsController_changePostStatus") gives "Change post status". Other titles: the first sentence.
 */
export function readableTitle(title: string, upstream: string): string {
  if (/^[A-Z]+ \//u.test(title.trim())) {
    const last = upstream.split("_").filter(Boolean).at(-1) ?? upstream;
    const words = humanize(last);
    if (words !== "(unnamed)") return words;
  }
  const first = title.trim().split(/(?<=[.!?])\s/u)[0] ?? title;
  return first.length <= 160 ? first : `${first.slice(0, 159)}…`;
}
