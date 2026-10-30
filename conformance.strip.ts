// C380: `access_revoke` is a guarded companion op (`listing: "workflow"`, no_access for everyone but Governance) that writes a
// receipt. Conformance <= 0.1.30 does not filter `listing`, so A3.run picks it as "an allowed call" and fails. The harness serves
// the shipped manifest WITHOUT it; the guard has its own tests (test/access.test.ts). `access_list` stays in the run.
// Remove this file when conformance filters `listing: "workflow"`.
import type { Manifest } from "@opt2-tealbrick/spec/manifest";

export const GUARDED_OPS: readonly string[] = ["access_revoke"];

/** The manifest minus the guarded ops (a copy). */
export function conformanceManifest(m: Manifest): Manifest {
  return { ...m, operations: m.operations.filter((o) => !GUARDED_OPS.includes(o.id)) };
}
