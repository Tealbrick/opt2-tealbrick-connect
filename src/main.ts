/**
 * Container entry point: `node src/main.ts` (Node 24 type stripping). Builds the Connect app definition and hands
 * it to the Miniapp SDK (`defineApp` + `startApp`, SDK-API §3). The SDK owns the HTTP server, claim, slices,
 * receipts, holds, scopes, keys, app secrets, backups and the person session.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { defineApp, startApp, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type { Manifest } from "@opt2-tealbrick/spec/manifest";

import { createConnectApp } from "./app.ts";
import { defaultDatabaseDrivers } from "./data/pg-driver.ts";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as Manifest;

const running = await startApp(
  defineApp(
    createConnectApp({
      manifest,
      migrationsDir: join(root, "migrations"),
      dataDir: process.env.TB_DATA_DIR ?? "/data",
      buzzRelays: process.env.CONNECT_BUZZ_RELAYS ?? null,
      // C133: the old single-relay setting is no longer read; only its presence is reported (clear owner error).
      oldBuzzRelaySettingPresent: Boolean(process.env.CONNECT_BUZZ_RELAY_URL?.trim()),
      databaseDrivers: defaultDatabaseDrivers(),
      ErrorClass: TbError,
    }),
  ),
  process.env,
);

const stop = async () => {
  await running.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
