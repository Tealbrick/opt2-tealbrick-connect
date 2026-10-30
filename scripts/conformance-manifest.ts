// Writes conformance.manifest.json = tealbrick.manifest.json minus the guarded companion ops (conformance.strip.ts), for
// `tb-conformance app --manifest`. Git-ignored and never copied into the image.
import { readFileSync, writeFileSync } from "node:fs";

import { conformanceManifest } from "../conformance.strip.ts";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("tealbrick.manifest.json", root), "utf8"));
writeFileSync(new URL("conformance.manifest.json", root), `${JSON.stringify(conformanceManifest(manifest), null, 2)}\n`);
