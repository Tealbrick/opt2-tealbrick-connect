/**
 * The three lease operations of C336 RQ-3 (`data_lease`, `data_leases_list`, `data_lease_revoke`), kept OUT of the manifest.
 *
 * QA-CON24-1 / C354a (no waiver): `data_lease` answers the owner's database password. Without the `secretOutput` flag the
 * bridge passes an output to every matching after-hook, and the op would be listed to agents. The flag is in spec 0.1.66+, not
 * in the pinned spec, and Core/bridge do not yet enforce `requires.bridgeCaps`. So the operations are NOT in
 * `tealbrick.manifest.json` and `createConnectApp` registers no handler for them: there is no route and no tool.
 *
 * The code stays (handlers in `src/app.ts`, `DatabaseService.lease`, the lease record), reachable only when the manifest handed
 * to `createConnectApp` declares these operations: tests do that with `LEASE_OPS`. To ship leases: add `secretOutput: true` to
 * `data_lease` and the bridge-capability requirement, move these definitions into the manifest, and take the refusal code
 * `secret_output_app_only` from the spec. Until then database accounts ship with the catalog (share level `available`) and rows
 * as documents (level `shared`, data_pull).
 *
 * QA-CONNECT35-11 (C373): a share at `shared` means "rows as documents" and NEVER "the database credential". When leases ship,
 * the owner must enable a lease with its own explicit flag on the share (`connect_db_shares.lease`, migration 0021, default 0,
 * reset by any change of the share). The `data_lease` handler refuses with `lease_unavailable` unless that flag is set, so
 * `shared` alone cannot grant one. The owner operation and the page control that set the flag come with the lease release.
 */
import type { Manifest } from "@opt2-tealbrick/spec/manifest";

export const LEASE_OP_IDS = ["data_lease", "data_leases_list", "data_lease_revoke"] as const;

export const LEASE_OPS: Manifest["operations"] = [
  {
    "id": "data_lease",
    "title": "Lease read-only access to shared database tables",
    "description": "APPS ONLY (agents are refused: no_access). The app is identified by its verified product. A short lease on the owner's read-only database credential, for an account shared with the calling app at level shared, route direct, and only for datasets (schema.table) in data_catalog now. The answer carries the connection fields INCLUDING THE PASSWORD: connect to checkedAddress (checked against the public-address policy just now) with TLS name host, keep nothing after expiresAt (at most 900 seconds), never log, store or pass on the password. Connect does not store or replay the answer; the receipt keeps the input digest and a redacted summary only. Not shared, or shared through Observer: not_found. Every error has a code and a fixed message.",
    "input": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "account",
        "datasets"
      ],
      "properties": {
        "account": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "description": "Connect database account id (from data_accounts_list)."
        },
        "datasets": {
          "type": "array",
          "minItems": 1,
          "maxItems": 50,
          "uniqueItems": true,
          "items": {
            "type": "string",
            "minLength": 3,
            "maxLength": 127,
            "pattern": "^[^.\\s\"]{1,63}\\.[^.\\s\"]{1,63}$"
          },
          "description": "schema.table names from data_catalog."
        },
        "ttlS": {
          "type": "integer",
          "minimum": 1,
          "maximum": 900,
          "description": "Lease length in seconds. Default 300, at most 900."
        }
      }
    },
    "output": {
      "type": "object",
      "required": [
        "leaseId",
        "kind",
        "host",
        "port",
        "checkedAddress",
        "database",
        "user",
        "password",
        "sslmode",
        "datasets",
        "expiresAt"
      ],
      "properties": {
        "leaseId": {
          "type": "string"
        },
        "kind": {
          "enum": [
            "postgres"
          ]
        },
        "host": {
          "type": "string"
        },
        "port": {
          "type": "integer",
          "minimum": 1,
          "maximum": 65535
        },
        "checkedAddress": {
          "type": "string"
        },
        "database": {
          "type": "string"
        },
        "user": {
          "type": "string"
        },
        "password": {
          "type": "string"
        },
        "sslmode": {
          "enum": [
            "disable",
            "require",
            "verify-full"
          ]
        },
        "datasets": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "expiresAt": {
          "type": "string",
          "description": "RFC 3339 time. Drop the credential at this time."
        }
      }
    },
    "crud": [
      "read"
    ],
    "effect": "read",
    "idempotency": "none",
    "receipt": true,
    "audience": "agent"
  },
  {
    "id": "data_leases_list",
    "title": "Database leases",
    "description": "The owner sees the last 100 database leases: app, database, datasets, issued, end, state (active, revoked, expired). Never a credential. Agents cannot use this.",
    "input": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    },
    "output": {
      "type": "object"
    },
    "crud": [
      "read"
    ],
    "effect": "read",
    "idempotency": "none",
    "receipt": false,
    "audience": "person"
  },
  {
    "id": "data_lease_revoke",
    "title": "End a database lease",
    "description": "The owner ends a lease in Connect. A lease is the stored read-only credential plus an end time that Connect records, so the credential itself stays valid at the database: to cut access at once, change that database user's password. Agents cannot use this.",
    "input": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "lease"
      ],
      "properties": {
        "lease": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      }
    },
    "output": {
      "type": "object"
    },
    "crud": [
      "update"
    ],
    "effect": "write",
    "idempotency": "supported",
    "receipt": true,
    "audience": "person"
  }
] as unknown as Manifest["operations"];

/** True when the manifest declares the lease operations (never the shipped one). */
export const leasesDeclared = (manifest: Pick<Manifest, "operations">): boolean => LEASE_OP_IDS.every((id) => manifest.operations.some((o) => o.id === id));
