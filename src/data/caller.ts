/**
 * Which app is calling a data_* op (C230 R3, Coordinator ruling): the identity is the VERIFIED caller product, never the
 * app's manifest name (a name is not an identity: any installed app can carry any name).
 *
 * miniapp-sdk 0.1.27+ (SDK-CALLER-PRODUCT) gives every handler `ctx.caller.product` for an app caller. Since 0.1.28 it is the
 * `prd` claim of the verified companion grant first, else the Portal-signed slice entry (`companionCallers`) of the calling
 * instance; a grant `prd` that differs from the slice entry is refused by the SDK (`grant_invalid`) before any handler runs. It is
 * absent for people and agents and for an app neither the grant nor the slice names. This file is the only place that reads it.
 * Fail closed: an app caller without a verified product is refused. There is no fallback to `ctx.caller.name`, the manifest
 * name, the instance id or any input field. Every share check, share record and audit row keys on this product id; since C240
 * a share also binds the verified instance id (verifiedAppCaller).
 */
import type { OpContext } from "@opt2-tealbrick/spec/sdk";

/** The verified product id of an app caller, or null (not an app, no product, or an empty one). */
export function verifiedAppProduct(ctx: OpContext): string | null {
  const caller = ctx.caller;
  return caller.type === "app" && typeof caller.product === "string" && caller.product !== "" ? caller.product : null;
}

/**
 * The calling app as a share key (C240): its verified product AND its instance id. `ctx.caller.id` of an app caller is the
 * `sub` of the verified companion grant (the SDK refuses the call before the handler otherwise), so the pair is verified.
 */
export function verifiedAppCaller(ctx: OpContext): { product: string; instance: string } | null {
  const product = verifiedAppProduct(ctx);
  const instance = ctx.caller.id;
  return product && typeof instance === "string" && instance.startsWith("ins_") ? { product, instance } : null;
}

/** One app instance that may call Connect, as the owner page sees it (spec 0.1.48 `CompanionCaller`). */
export interface CompanionCallerView {
  product: string;
  instance: string;
  name: string;
  /** where it runs (`railway`, `own_infra`, ...); null = unknown (older Core) */
  provider: string | null;
}

/** spec 0.1.48 / miniapp-sdk 0.1.32 (SDK-COMPANION-CALLERS): person-op contexts carry `companionCallers()`. */
type WithCompanionCallers = { companionCallers?: () => readonly { product?: unknown; ins?: unknown; name?: unknown; provider?: unknown }[] };

/**
 * The verified app instances that may call Connect, from the CURRENT signed slice. Person (owner) calls only: anyone else, an
 * SDK without the function, an expired slice or a malformed entry gives nothing, so a share cannot be created (fail closed).
 */
export function companionCallersFor(ctx: OpContext): CompanionCallerView[] {
  if (ctx.caller.type !== "person") return [];
  const fn = (ctx as OpContext & WithCompanionCallers).companionCallers;
  if (typeof fn !== "function") return [];
  const out: CompanionCallerView[] = [];
  for (const e of fn() ?? []) {
    if (!e || typeof e.product !== "string" || e.product === "" || typeof e.ins !== "string" || !e.ins.startsWith("ins_")) continue;
    const name = typeof e.name === "string" && e.name !== "" ? e.name : e.ins;
    const provider = typeof e.provider === "string" && e.provider !== "" ? e.provider : null;
    out.push({ product: e.product, instance: e.ins, name, provider });
  }
  return out;
}

/** An `own_infra` caller runs code the workspace owner operates (S3-4 residual): the owner page says so. */
export const OWN_INFRA_PROVIDER = "own_infra";
