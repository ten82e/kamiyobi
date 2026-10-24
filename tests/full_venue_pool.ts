import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import {
  applyAliases,
  applyOverrides,
  applyVenueScopes,
  classify,
  mergeSources,
  select,
} from "../src/merge.ts";
import { parseTree as parseAi } from "../src/sources/aideadlines.ts";
import { parseTree as parseCcf } from "../src/sources/ccfddl.ts";
import { parseFile } from "../src/sources/local.ts";

// Raw YAML captured from ccfddl/ccf-deadlines and huggingface/ai-deadlines on
// 2026-10-11. Parse it with production source readers, then merge canonical local inputs.
// No normalized snapshot, catalog, recommendation index or vector file is read.
export function freshFullVenuePool() {
  const root = join(import.meta.dirname, "..");
  const raw = mkdtempSync(join(tmpdir(), "kamiyobi-full-pool-raw-"));
  const hashes: Record<string, string> = {
    ccfddl: "d56875fd0fd58eb0f295b98fab8e7add85125d3ab45e4cf90672ab5c1a9bde11",
    aideadlines: "ca61a1cecea879ed76613e636df04a656ad9dd3c01b4364ab77a21aedca002b0",
  };
  for (const archive of ["ccfddl", "aideadlines"]) {
    const file = join(root, "tests/fixtures/full-pool-sources", `${archive}.tar.gz.b64`);
    const bytes = Buffer.from(readFileSync(file, "utf8"), "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== hashes[archive])
      throw new Error(`raw upstream fixture changed: ${archive}`);
    const extractedArchive = join(raw, `${archive}.tar.gz`);
    writeFileSync(extractedArchive, bytes);
    execFileSync("tar", ["-xzf", extractedArchive, "-C", raw]);
  }
  const config = load(readFileSync(join(root, "config.yaml"), "utf8")) as Record<string, unknown>;
  const overrides = load(readFileSync(join(root, "data/overrides.yaml"), "utf8")) as Record<
    string,
    unknown
  >;
  const groups = [
    parseCcf(join(raw, "conference")),
    parseAi(join(raw, "src/data/conferences")),
    [
      ...parseFile(join(root, "data/manual.yaml")),
      ...parseFile(join(root, "data/curated.generated.yaml")),
    ],
  ];
  const conferences = select(
    applyOverrides(
      classify(
        mergeSources(applyAliases(groups, overrides.aliases as Record<string, unknown>), config),
        config,
      ),
      overrides,
    ),
    config,
  );
  const categoryNames = config.categories as Record<string, string>;
  const enriched = applyVenueScopes(
    conferences,
    (load(readFileSync(join(root, "data/manual.yaml"), "utf8")) as Record<string, unknown>)
      .venue_scopes,
  );
  return { conferences: enriched, categoryNames, raw };
}
