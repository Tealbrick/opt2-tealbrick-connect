/**
 * Which app is calling a data_* op (C230 R3, Coordinator ruling): the identity is the VERIFIED caller product, never the
 * app's manifest name (a name is not an identity: any installed app can carry any name).
 *
 * miniapp-sdk 0.1.27+ (SDK-CALLER-PRODUCT) gives every handler `ctx.caller.product` for an app caller. Since 0.1.28 it is the
 * `prd` claim of the verified companion grant first, else the Portal-signed slice entry (`companionCallers`) of the calling
 * instance; a grant `prd` that differs from the slice entry is refused by the SDK (`grant_invalid`) before any handler runs. It is
 * absent for people and agents and for an app neither the grant nor the slice names. This file is the only place that reads it.
 * Fail closed: an app caller without a verified product is refused. There is no fallback to `ctx.caller.name`, the manifest
 * name, the instance id or any input field. Every share check, share record and audit row keys on this product id.
 */
import type { OpContext } from "@opt2-tealbrick/spec/sdk";

/** The verified product id of an app caller, or null (not an app, no product, or an empty one). */
export function verifiedAppProduct(ctx: OpContext): string | null {
  const caller = ctx.caller;
  return caller.type === "app" && typeof caller.product === "string" && caller.product !== "" ? caller.product : null;
}
