/**
 * Curated per-toolkit policies (harvest: v1 composio-policy.ts). Composio tool names hide writes
 * (`*_PATCH`, `*_WATCH`) and outward actions; a policy pins the class. Order: see classifyComposioTool (exact slugs, read-led
 * names, destructive → outward → writes → reads → name inference). With a policy present, its patterns override name inference (e.g. GMAIL_REMOVE_LABEL
 * is a write, not destructive). Policies are our own labels and ship inside the image.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { classify, inferFromName, namesMoney, narrowByName, type ToolClass } from "../../effect.ts";

export interface ComposioPolicy {
  schema: 1;
  toolkit: string;
  version: string;
  notes?: string;
  /** Optional (C373 Jarvis): tools that spend money although their name does not say so (ad campaigns, budgets, bids). */
  money?: string[];
  destructive: string[];
  outward: string[];
  writes: string[];
  reads: string[];
}

function patternRegex(pattern: string): RegExp {
  const body = pattern
    .trim()
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`, "iu");
}

export function matches(patterns: readonly string[], slug: string): boolean {
  return patterns.some((pattern) => patternRegex(pattern).test(slug));
}

export function parsePolicy(raw: unknown): ComposioPolicy {
  const p = raw as Partial<ComposioPolicy>;
  const list = (value: unknown, field: string) => {
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.length > 0 && v.length <= 200)) {
      throw new Error(`policy_invalid: ${field}`);
    }
    return value as string[];
  };
  if (p.schema !== 1 || typeof p.toolkit !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(p.toolkit) || typeof p.version !== "string") {
    throw new Error("policy_invalid: header");
  }
  return {
    schema: 1,
    toolkit: p.toolkit,
    version: p.version,
    ...(typeof p.notes === "string" ? { notes: p.notes } : {}),
    ...(p.money === undefined ? {} : { money: list(p.money, "money") }),
    destructive: list(p.destructive, "destructive"),
    outward: list(p.outward, "outward"),
    writes: list(p.writes, "writes"),
    reads: list(p.reads, "reads"),
  };
}

export function loadPolicies(dir = join(import.meta.dirname, "../../../policies/composio")): Map<string, ComposioPolicy> {
  const map = new Map<string, ComposioPolicy>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const policy = parsePolicy(JSON.parse(readFileSync(join(dir, file), "utf8")));
    map.set(policy.toolkit, policy);
  }
  return map;
}

const READ = { write: false, outward: false, destructive: false } as const;

/**
 * Order (F84): money name → exact slugs of the policy (money first) (a pattern without `*`, any list) → a read-led name that holds no write, outward
 * or destructive verb (so GMAIL_LIST_DRAFTS / GMAIL_LIST_LABELS / GOOGLECALENDAR_ACL_LIST stay reads although `*DRAFT*`, `*LABEL*`,
 * `ACL_*` patterns would catch them) → money → destructive → outward → writes → reads patterns → name inference.
 * A slug with a real mutating verb (GMAIL_GET_AND_SEND) is never read-led, so the policy patterns still decide it.
 */
export function classifyComposioTool(slug: string, policy: ComposioPolicy | undefined): ToolClass {
  // C276a (d): the policy / name decides the effect; the verbs of the slug then narrow the CRUD when that is safe.
  return narrowByName(slug, composioClass(slug, policy));
}

function composioClass(slug: string, policy: ComposioPolicy | undefined): ToolClass {
  // Money movement is always `money` (always held), whatever a policy says about the tool.
  if (namesMoney(slug)) return classify({ write: true, outward: true, destructive: false, money: true });
  if (!policy) return inferFromName(slug);
  const exact = (patterns: readonly string[]) => patterns.some((p) => !p.includes("*") && p.toLowerCase() === slug.toLowerCase());
  const money = policy.money ?? [];
  const MONEY = { write: true, outward: true, destructive: false, money: true } as const;
  if (exact(money)) return classify(MONEY);
  if (exact(policy.destructive)) return classify({ write: true, outward: false, destructive: true });
  if (exact(policy.outward)) return classify({ write: true, outward: true, destructive: false });
  if (exact(policy.writes)) return classify({ write: true, outward: false, destructive: false });
  if (exact(policy.reads)) return classify(READ);
  if (inferFromName(slug).effect === "read") return classify(READ);
  if (matches(money, slug)) return classify(MONEY);
  if (matches(policy.destructive, slug)) return classify({ write: true, outward: false, destructive: true });
  if (matches(policy.outward, slug)) return classify({ write: true, outward: true, destructive: false });
  if (matches(policy.writes, slug)) return classify({ write: true, outward: false, destructive: false });
  if (matches(policy.reads, slug)) return classify(READ);
  return inferFromName(slug); // fail closed for slugs the policy does not name (SEC-02)
}
