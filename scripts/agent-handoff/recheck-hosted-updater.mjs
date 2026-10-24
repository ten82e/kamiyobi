/** Replay a captured updater health failure using the actual reviewed source. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { evaluateHealthGate, healthReport, toJson } from "../../src/build.ts";
import {
  applyOverrides,
  mergeSources,
  normalizeConfiguredVenueIdentities,
} from "../../src/merge.ts";
import { conferencesFromJson } from "../../src/model.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifact = path.resolve(
  process.argv[2] || "work/agent-verification/resume-2026-10-04/nightly",
);
const output = path.resolve(process.argv[3] || path.join(artifact, "../captured-gate-replay.json"));
assert(output.startsWith(path.join(repo, "work/agent-verification") + path.sep));
const read = (name) => JSON.parse(fs.readFileSync(path.join(artifact, name), "utf8"));
const baseline = read("baseline/data.json");
const current = read("current/data.json");
const oldBaseline = read("baseline/health.json");
const oldCurrent = read("health.json");
const config = load(fs.readFileSync(path.join(repo, "config.yaml"), "utf8"));
const overrides = load(fs.readFileSync(path.join(repo, "data/overrides.yaml"), "utf8"));
const now = new Date(oldCurrent.generated_at);
assert(Number.isFinite(now.getTime()));
const before = evaluateHealthGate(oldCurrent, oldBaseline);
assert(before.reasons.includes("previous deadline slot conflict: ecir|ecir27|abstract|1|"));
const rebuild = (data, original) => {
  const material = mergeSources(
    [normalizeConfiguredVenueIdentities(conferencesFromJson(data), config)],
    config,
  );
  const corrected = toJson(applyOverrides(material, overrides), config, now);
  const report = healthReport(corrected, now, {
    sourceStatus: original.source_status,
    sourceMetadata: original.source_metadata,
    sourceFailures: original.source_failures,
    buildInputMode: original.build_input_mode,
  });
  assert.deepEqual(report.source_status, original.source_status);
  assert.deepEqual(report.source_metadata, original.source_metadata);
  assert.equal(report.build_input_mode, original.build_input_mode);
  return report;
};
const after = evaluateHealthGate(rebuild(current, oldCurrent), rebuild(baseline, oldBaseline));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(
  output,
  `${JSON.stringify(
    {
      scope:
        "Captured health-stage replay only. Preserve source diagnostics; no fetch, discovery, reverify, deployment, or workflow dispatch.",
      before,
      after,
      now: now.toISOString(),
    },
    null,
    2,
  )}\n`,
);
assert(after.ok, JSON.stringify(after.reasons));
console.log(
  "PASS: captured ECIR baseline conflict reproduced; reviewed local rules pass the health gate",
);
