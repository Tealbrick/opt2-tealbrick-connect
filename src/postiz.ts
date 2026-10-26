/**
 * C368: what Connect knows about Postiz's public API. Three jobs, all keyed on the UPSTREAM operation (catalog service `postiz`,
 * HTTP method and path), never on the hashed tool name:
 *   1. identify create post (POST /public/v1/posts), the status change (PUT /public/v1/posts/{id}/status) and the channel list;
 *   2. `draftCheck`: may a create-post call run as the plain-write `__draft` variant? Only when the EXACT input is a new draft that
 *      cannot touch an existing post (evidence in CHANGELOG 0.7.4 and the PR: Postiz posts.repository `createOrUpdatePost` upserts
 *      by `value[].id` and sweeps a whole `group`);
 *   3. the owner's readable hold card for create post (channel, type, date, text, images).
 * Pure functions; app.ts wires the account and the channel list.
 */
import { plainText } from "./hold-view.ts";
import type { ToolRow } from "./tools.ts";

export const POSTIZ_SERVICE = "postiz";

type OpRef = Pick<ToolRow, "source" | "service" | "httpMethod" | "httpPath">;
const is = (row: OpRef, method: string, path: string): boolean => row.source === "catalog" && row.service === POSTIZ_SERVICE && row.httpMethod === method && row.httpPath === path;

export const isPostizCreatePost = (row: OpRef): boolean => is(row, "post", "/public/v1/posts");
export const isPostizPostStatus = (row: OpRef): boolean => is(row, "put", "/public/v1/posts/{id}/status");
export const isPostizChannelList = (row: OpRef): boolean => is(row, "get", "/public/v1/integrations");

// ── the draft variant ──

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Keys Connect lets a plain-write draft carry. Anything else (`group`, `id`, `republish`, `inter`, `order`, ...) keeps the call on the held tool. */
const BODY_KEYS = new Set(["type", "date", "shortLink", "tags", "posts"]);
const POST_KEYS = new Set(["integration", "value", "settings"]);
const VALUE_KEYS = new Set(["content", "image", "delay"]);
const MAX_POSTS = 20;
const MAX_VALUES = 50;

export type DraftCheck = { ok: true } | { ok: false; reason: string };

/**
 * C368: may this exact input run as `<create-post>__draft` (a plain write, no owner approval)?
 * Yes only when ALL hold: the call has only `body`; body.type is exactly the string "draft"; the body, every post and every value
 * carry only the keys Postiz documents for a new post; no post has a `group` and no value has an `id`. Why: Postiz saves a post
 * with `upsert where id = value.id` (an existing id rewrites that post and, for type draft, sets it back to DRAFT and stops its
 * publish workflow) and, with a `group`, soft-deletes every post of that group. Without both, every row is new and a draft is
 * never published (state DRAFT starts no workflow). The check is an allow-list: an unknown key is a refusal, not a pass.
 */
export function draftCheck(args: Obj): DraftCheck {
  const no = (reason: string): DraftCheck => ({ ok: false, reason });
  const extra = Object.keys(args).filter((k) => k !== "body");
  if (extra.length > 0) return no(`the input has "${extra[0]}" besides "body"`);
  const body = args.body;
  if (!isObj(body)) return no('the input has no "body"');
  if (body.type !== "draft") return no('body.type is not exactly "draft"');
  const bad = Object.keys(body).find((k) => !BODY_KEYS.has(k));
  if (bad !== undefined) return no(`body has the field "${bad}", which a plain draft does not carry`);
  const posts = body.posts;
  if (!Array.isArray(posts) || posts.length === 0 || posts.length > MAX_POSTS) return no("body.posts must be a list of 1 to 20 posts");
  for (const post of posts) {
    if (!isObj(post)) return no("a post is not an object");
    const badPost = Object.keys(post).find((k) => !POST_KEYS.has(k));
    if (badPost !== undefined) return no(`a post has the field "${badPost}" (an existing group or id could change another post)`);
    if (!isObj(post.integration) || typeof post.integration.id !== "string" || !post.integration.id.trim()) return no("a post has no integration id");
    if (Object.keys(post.integration).some((k) => k !== "id")) return no("a post integration carries more than its id");
    if (post.settings !== undefined && !isObj(post.settings)) return no("post settings is not an object");
    const values = post.value;
    if (!Array.isArray(values) || values.length === 0 || values.length > MAX_VALUES) return no("a post must have 1 to 50 values");
    for (const value of values) {
      if (!isObj(value)) return no("a value is not an object");
      const badValue = Object.keys(value).find((k) => !VALUE_KEYS.has(k));
      if (badValue !== undefined) return no(`a value has the field "${badValue}" (an existing id would rewrite that post)`);
      if (typeof value.content !== "string") return no("a value has no text");
      if (value.image !== undefined && !Array.isArray(value.image)) return no("value.image is not a list");
    }
  }
  if (body.tags !== undefined && !Array.isArray(body.tags)) return no("body.tags is not a list");
  if (body.date !== undefined && typeof body.date !== "string") return no("body.date is not a string");
  if (body.shortLink !== undefined && typeof body.shortLink !== "boolean") return no("body.shortLink is not true or false");
  return { ok: true };
}

// ── the hold card ──

export interface Channel {
  name: string;
  /** Postiz provider identifier, e.g. "linkedin", "x", "linkedin-page" */
  provider: string;
}
/** channel id → name and provider, read from GET /public/v1/integrations with the account the call would use */
export type ChannelLookup = ReadonlyMap<string, Channel>;

/** The channel list answer: a list, or an object holding one. Anything else gives an empty lookup. */
export function parseChannels(data: unknown): Map<string, Channel> {
  const list = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.integrations) ? data.integrations : [];
  const out = new Map<string, Channel>();
  for (const item of list.slice(0, 500)) {
    if (!isObj(item) || typeof item.id !== "string") continue;
    const name = typeof item.name === "string" && item.name.trim() ? item.name : typeof item.profile === "string" ? item.profile : "";
    out.set(item.id, { name, provider: typeof item.identifier === "string" ? item.identifier : "" });
  }
  return out;
}

const PROVIDER_NAMES: Record<string, string> = {
  x: "X", linkedin: "LinkedIn", "linkedin-page": "LinkedIn Page", facebook: "Facebook", instagram: "Instagram", "instagram-standalone": "Instagram",
  threads: "Threads", bluesky: "Bluesky", mastodon: "Mastodon", youtube: "YouTube", tiktok: "TikTok", pinterest: "Pinterest", reddit: "Reddit",
  dribbble: "Dribbble", discord: "Discord", slack: "Slack", telegram: "Telegram", medium: "Medium", devto: "DEV", hashnode: "Hashnode", wordpress: "WordPress", lemmy: "Lemmy",
};
export const providerName = (identifier: string): string =>
  PROVIDER_NAMES[identifier.toLowerCase()] ?? identifier.split(/[-_]/u).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

const TEXT_CHARS_MAX = 1500;
const TEXT_BUDGET = 12_000;
const POSTS_SHOWN = 10;
const VALUES_SHOWN = 10;
const VIEW_MAX = 15_000;
const clean = (s: string, max: number) => {
  const p = plainText(s).replace(/\s+/gu, " ");
  return p.length <= max ? p : `${p.slice(0, max - 1)}…`;
};

const TYPE_LABEL: Record<string, string> = {
  draft: "DRAFT (saved in Postiz, not published)",
  schedule: "SCHEDULED (Postiz publishes it at the date below)",
  now: "NOW (Postiz publishes it straight away)",
};
const TYPE_SHORT: Record<string, string> = { draft: "DRAFT", schedule: "SCHEDULED", now: "NOW" };

const utcMinute = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** A date for the owner: weekday, day, month, year and time in `timeZone`, with the UTC time when the zone is not UTC. */
export function formatWhen(raw: string, timeZone: string): string {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return `${clean(raw, 60)} (not a valid date)`;
  const at = (tz: string) => {
    try {
      return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(ms);
    } catch {
      return null;
    }
  };
  const zoned = at(timeZone);
  if (zoned === null || timeZone.toUpperCase() === "UTC") return `${at("UTC") ?? utcMinute(ms)}`;
  return `${zoned} (${utcMinute(ms)} UTC)`;
}

export interface PostCard {
  heading: string;
  account: string;
  /** the tool call arguments without `connect_account` (catalog shape: `{ body }`) */
  args: Obj;
  channels: ChannelLookup | null;
  /** IANA zone for the date; UTC when unknown */
  timeZone: string;
}

/** The owner's card for a held Postiz create-post call: `summary` (≤ 280) and `view` (≤ 16 000, plain text, deterministic). */
export function renderPostizPost(card: PostCard): { summary: string; view: string } {
  const body = isObj(card.args.body) ? card.args.body : {};
  const rawType = body.type;
  const typeKey = typeof rawType === "string" ? rawType : "";
  const typeLine = TYPE_LABEL[typeKey] ?? (rawType === undefined ? "NOT GIVEN (Postiz may refuse this call)" : `UNKNOWN: "${clean(String(rawType), 40)}" (Connect does not know this type)`);
  const posts = Array.isArray(body.posts) ? body.posts.filter(isObj) : [];
  const channelOf = (post: Obj): { line: string; short: string } => {
    const id = isObj(post.integration) && typeof post.integration.id === "string" ? post.integration.id : "";
    const found = card.channels?.get(id);
    const typed = isObj(post.settings) && typeof post.settings.__type === "string" ? post.settings.__type : "";
    const provider = found?.provider || typed;
    const pretty = provider ? providerName(provider) : "";
    const prefix = pretty ? `${pretty} · ` : "";
    if (found?.name) return { line: `${prefix}${clean(found.name, 100)}`, short: pretty || clean(found.name, 40) };
    return { line: `${prefix}channel id ${clean(id, 80) || "(none)"}${card.channels ? " (not in the Postiz channel list)" : ""}`, short: pretty || "a channel" };
  };
  const lines: string[] = [clean(card.heading, 200), `Account: ${clean(card.account, 200)}`, `Type: ${typeLine}`];
  if (typeKey === "now") lines.push("When: straight away");
  else if (typeof body.date === "string" && body.date.trim()) lines.push(`${typeKey === "draft" ? "Date on the draft" : "When"}: ${formatWhen(body.date, card.timeZone)}`);
  else lines.push("When: no date given");
  if (Array.isArray(body.tags) && body.tags.length > 0) {
    const tags = body.tags.map((t) => (isObj(t) ? String(t.label ?? t.value ?? "") : String(t))).filter(Boolean);
    if (tags.length > 0) lines.push(`Tags: ${clean(tags.join(", "), 200)}`);
  }
  let images = 0;
  const blocks: string[] = [];
  // the text of all shown values shares one budget, so the end of the card (counts of what is not shown) always fits the SDK limit
  const shownValues = posts.slice(0, POSTS_SHOWN).reduce((n, p) => n + Math.min(Array.isArray(p.value) ? p.value.length : 0, VALUES_SHOWN), 0);
  const textChars = Math.max(200, Math.min(TEXT_CHARS_MAX, Math.floor(TEXT_BUDGET / Math.max(1, shownValues))));
  posts.slice(0, POSTS_SHOWN).forEach((post, pi) => {
    const values = Array.isArray(post.value) ? post.value.filter(isObj) : [];
    const own = values.reduce((n, v) => n + (Array.isArray(v.image) ? v.image.length : 0), 0);
    images += own;
    const b: string[] = [posts.length > 1 ? `Post ${pi + 1} of ${posts.length}` : "Post", `  Channel: ${channelOf(post).line}`, `  Images: ${own}`];
    values.slice(0, VALUES_SHOWN).forEach((v, vi) => {
      const chars = [...(typeof v.content === "string" ? plainText(v.content, true) : "")];
      const rest = chars.length - textChars;
      const shown = chars.slice(0, textChars).join("");
      const label = vi === 0 ? "Text" : `Reply ${vi} in the thread`;
      b.push(`  ${label} (plain text${rest > 0 ? `, first ${textChars} characters; ${rest} more not shown` : ""}):`, ...(shown || "(empty)").split("\n").map((l) => `    ${l}`));
    });
    if (values.length > VALUES_SHOWN) b.push(`  (and ${values.length - VALUES_SHOWN} more values not shown)`);
    blocks.push(b.join("\n"));
  });
  if (posts.length === 0) blocks.push("Post\n  (no posts found in the request)");
  if (posts.length > POSTS_SHOWN) blocks.push(`(and ${posts.length - POSTS_SHOWN} more posts not shown)`);
  lines.push(`Posts: ${posts.length}`, `Images: ${images}`, "", ...blocks);
  let view = lines.join("\n");
  if (view.length > VIEW_MAX) view = `${view.slice(0, VIEW_MAX - 40)}\n(the rest is not shown)`;

  const shorts = [...new Set(posts.map((p) => channelOf(p).short))];
  const to = posts.length > 1 ? `${posts.length} posts (${shorts.slice(0, 4).join(", ")}${shorts.length > 4 ? ", ..." : ""})` : (shorts[0] ?? "a channel");
  const ms = typeof body.date === "string" ? Date.parse(body.date) : Number.NaN;
  const when = typeKey === "now" ? ", now" : Number.isFinite(ms) ? `, ${utcMinute(ms)} UTC` : "";
  const summary = `Postiz post, ${TYPE_SHORT[typeKey] ?? "UNKNOWN TYPE"}, to ${to}${when}`;
  return { summary: summary.length <= 280 ? summary : `${summary.slice(0, 279)}…`, view };
}
