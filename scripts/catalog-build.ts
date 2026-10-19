/**
 * Build the Tealbrick catalog artifact (Company Box seed, HARVEST §D) from a source catalog directory.
 *
 *   node scripts/catalog-build.ts --from <dir> [--from <dir> …] [--override-from <dir> …] --version <semver> [--out dist/catalog]
 *     [--forbid-file <path>]
 *
 * - Verifies every spec / overlay against the sha256 pinned in its entry.json (refuses on mismatch).
 * - Several `--from` directories are merged (e.g. the v1 Company Box); a duplicate id is refused. An `--override-from`
 *   directory may add entries or REPLACE a `--from` entry of the same id (a Connect-owned delta to a donor entry); the
 *   replaced ids are reported.
 * - Scrubs home-infrastructure values: `baseUrlExample` → https://<id>.example.com, instance-captured
 *   `app.specSource` → "instance-capture", a spec `servers[].url` / Swagger `host` naming a forbidden host → its path
 *   only (the entry `basePath` decides the call path); PROVENANCE.md and coverage files are not shipped.
 * - Refuses to write when any personal host pattern remains anywhere in the bundle.
 * - Output: `tealbrick-catalog-<version>.json.gz` (deterministic gzip of one JSON document) + `.sha256`.
 * The artifact is attached to a GitHub release of this repo and pinned in the manifest `artifacts[]`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

export const CATALOG_FORMAT = "tealbrick.catalog/1";

/**
 * Home-infrastructure patterns that must never reach a public artifact. Generic patterns live here; operator-specific
 * host names are passed at build time with `--forbid-file <path>` (one regex per line, kept outside this repo).
 */
export const FORBIDDEN_PATTERNS: RegExp[] = [/\.ts\.net\b/iu, /tailnet/iu, /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/u];

export function addForbiddenPatterns(lines: string): void {
  for (const line of lines.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))) FORBIDDEN_PATTERNS.push(new RegExp(line, "iu"));
}

export interface CatalogEntryFile {
  name: string;
  sha256: string;
  content: string;
}
export interface CatalogBundleEntry {
  id: string;
  entry: Record<string, unknown>;
  files: CatalogEntryFile[];
}
export interface CatalogBundle {
  format: typeof CATALOG_FORMAT;
  version: string;
  entries: CatalogBundleEntry[];
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

export function findForbidden(text: string): string | null {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) return pattern.source;
  }
  return null;
}

function scrubEntry(raw: Record<string, unknown>): Record<string, unknown> {
  const entry = structuredClone(raw);
  const id = String(entry.id);
  if (typeof entry.baseUrlExample === "string") entry.baseUrlExample = `https://${id}.example.com`;
  const app = entry.app as Record<string, unknown> | undefined;
  if (app && typeof app.specSource === "string" && findForbidden(app.specSource)) app.specSource = "instance-capture";
  return entry;
}

/** A captured spec may name the instance it came from; keep only the path (the file digest is recomputed). */
function scrubSpec(file: CatalogEntryFile): CatalogEntryFile {
  const doc = JSON.parse(file.content) as { servers?: { url?: unknown }[]; host?: unknown };
  let changed = false;
  if (Array.isArray(doc.servers)) {
    for (const server of doc.servers) {
      if (typeof server?.url === "string" && findForbidden(server.url)) {
        server.url = decodeURI(new URL(server.url, "https://placeholder.invalid").pathname).replace(/\/+$/u, "") || "/";
        changed = true;
      }
    }
  }
  if (typeof doc.host === "string" && findForbidden(doc.host)) {
    delete doc.host;
    changed = true;
  }
  if (!changed) return file;
  const content = JSON.stringify(doc);
  return { name: file.name, sha256: sha256(content), content };
}

function readPinned(dir: string, file: string, pin: string): CatalogEntryFile {
  if (!/^[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/iu.test(file) || file.includes("..")) throw new Error(`${dir}: unsafe file name ${file}`);
  const bytes = readFileSync(join(dir, file));
  const actual = sha256(bytes);
  if (actual !== pin) throw new Error(`${dir}/${file}: sha256 ${actual} does not match pin ${pin}`);
  return { name: file, sha256: actual, content: bytes.toString("utf8") };
}

function entryDirs(roots: readonly string[], flag: string): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const root of roots) {
    for (const name of readdirSync(root)) {
      const dir = join(root, name);
      if (!statSync(dir).isDirectory() || !existsSync(join(dir, "entry.json"))) continue;
      if (dirs.has(name)) throw new Error(`${name}: catalog entry found in more than one ${flag} directory`);
      dirs.set(name, dir);
    }
  }
  return dirs;
}

export function buildBundle(from: string | readonly string[], version: string, options: { overrideFrom?: readonly string[] } = {}): CatalogBundle & { replaced: string[] } {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error(`invalid version ${version}`);
  const dirs = entryDirs(typeof from === "string" ? [from] : from, "--from");
  const replaced: string[] = [];
  for (const [name, dir] of entryDirs(options.overrideFrom ?? [], "--override-from")) {
    if (dirs.has(name)) replaced.push(name);
    dirs.set(name, dir);
  }
  const entries: CatalogBundleEntry[] = [];
  for (const [name, dir] of [...dirs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, "entry.json"))) continue;
    const raw = JSON.parse(readFileSync(join(dir, "entry.json"), "utf8")) as Record<string, unknown>;
    if (raw.schema !== 1 || raw.id !== name) throw new Error(`${dir}: entry schema/id invalid`);
    const files: CatalogEntryFile[] = [];
    const openapi = raw.openapi as { spec?: string; sha256?: string; overlay?: { file: string; sha256: string } } | undefined;
    if (raw.source === "openapi") {
      if (!openapi?.spec || !openapi.sha256) throw new Error(`${dir}: openapi spec pin missing`);
      files.push(scrubSpec(readPinned(dir, openapi.spec, openapi.sha256)));
      if (openapi.overlay) files.push(readPinned(dir, openapi.overlay.file, openapi.overlay.sha256));
    } else {
      throw new Error(`${dir}: unsupported source ${String(raw.source)}`);
    }
    entries.push({ id: name, entry: scrubEntry(raw), files });
  }
  if (entries.length === 0) throw new Error(`no catalog entries in ${[from].flat().join(", ")}`);
  const bundle: CatalogBundle = { format: CATALOG_FORMAT, version, entries };
  Object.defineProperty(bundle, "replaced", { value: replaced.sort(), enumerable: false });
  for (const entry of bundle.entries) {
    const hit = findForbidden(JSON.stringify(entry.entry)) ?? entry.files.map((f) => findForbidden(f.content)).find(Boolean) ?? null;
    if (hit) throw new Error(`${entry.id}: personal host pattern remains (${hit})`);
  }
  return bundle as CatalogBundle & { replaced: string[] };
}

export function writeBundle(bundle: CatalogBundle, outDir: string): { file: string; sha256: string; bytes: number } {
  mkdirSync(outDir, { recursive: true });
  const gz = gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 9 });
  const file = join(outDir, `tealbrick-catalog-${bundle.version}.json.gz`);
  const digest = sha256(gz);
  writeFileSync(file, gz);
  writeFileSync(`${file}.sha256`, `${digest}  tealbrick-catalog-${bundle.version}.json.gz\n`);
  return { file, sha256: digest, bytes: gz.byteLength };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { from: { type: "string", multiple: true }, version: { type: "string" }, out: { type: "string", default: "dist/catalog" }, "forbid-file": { type: "string" }, "override-from": { type: "string", multiple: true } },
  });
  if (values["forbid-file"]) addForbiddenPatterns(readFileSync(resolve(values["forbid-file"]), "utf8"));
  if (!values.from?.length || !values.version) {
    console.error("usage: node scripts/catalog-build.ts --from <dir> [--from <dir> …] --version <semver> [--out dist/catalog] [--forbid-file <path>]");
    process.exit(2);
  }
  const bundle = buildBundle(
    values.from.map((d) => resolve(d)),
    values.version,
    { overrideFrom: (values["override-from"] ?? []).map((d) => resolve(d)) },
  );
  const result = writeBundle(bundle, resolve(values.out));
  console.log(JSON.stringify({ entries: bundle.entries.map((e) => e.id), replaced: bundle.replaced, ...result }, null, 2));
}
