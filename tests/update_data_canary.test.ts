/**
 * update-data canary: reproduce the scheduled offline-baseline vs fresh-upstream
 * comparison against frozen fixtures and pin health-gate pass/fail decisions
 * for each scenario class (edition-id rename, genuine disappearance, new
 * warning code, new identity conflict).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateHealthGate, type HealthReport, type ObservationBaseline } from "../src/build.ts";
import { makeFixtureCache, runCli } from "./helpers.ts";

const tempDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-canary-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function buildPair(mutate?: (fixtureRoot: string) => void): {
  baseline: HealthReport;
  current: HealthReport;
} {
  const root = scratch();
  const cache = makeFixtureCache(join(root, "cache"));
  const baselineDir = join(root, "baseline");
  const currentDir = join(root, "current");
  expect(runCli(baselineDir, { cache }).status).toBe(0);
  if (mutate) {
    mutate(join(cache, "ccfddl__ccf-deadlines__main", "ccf-deadlines-main", "conference"));
  }
  expect(runCli(currentDir, { cache }).status).toBe(0);
  return {
    baseline: JSON.parse(readFileSync(join(baselineDir, "health.json"), "utf8")) as HealthReport,
    current: JSON.parse(readFileSync(join(currentDir, "health.json"), "utf8")) as HealthReport,
  };
}

/** 現在の data から観測系 baseline を作る (update-data workflow と同じ内容)。 */
function observationOf(report: HealthReport): ObservationBaseline {
  const conflicts = report.identity_conflicts;
  return {
    observed_at: report.generated_at,
    parse_warning_count: report.parse_warning_count,
    warning_codes: report.warning_codes ?? {},
    identity_conflicts:
      conflicts && "details" in conflicts
        ? { ...conflicts, new_since_baseline: 0 }
        : { venue: 0, edition: 0, new_since_baseline: 0, details: [] },
  };
}

describe("update-data canary", () => {
  it("edition id rename alone passes the gate (slot values identical)", {
    timeout: 180_000,
  }, () => {
    const { baseline, current } = buildPair((root) => {
      const file = join(root, "NW", "sigcomm.yml");
      writeFileSync(file, readFileSync(file, "utf8").replace(/id: sigcomm26/g, "id: sigcomm26b"));
    });
    const result = evaluateHealthGate(current, baseline);
    expect(result.ok).toBe(true);
  });

  it("a genuinely removed future deadline fails the gate", { timeout: 180_000 }, () => {
    const { baseline, current } = buildPair((root) => {
      const file = join(root, "NW", "nsdi.yml");
      const text = readFileSync(file, "utf8").replace(
        /- abstract_deadline: '[^']+'\n\s+deadline: '[^']+'\n/,
        "",
      );
      writeFileSync(file, text);
    });
    const result = evaluateHealthGate(current, baseline);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("future deadline disappeared"))).toBe(
      true,
    );
  });

  it("unchanged sources rebuild stable health metadata", { timeout: 180_000 }, () => {
    const root = scratch();
    const cache = makeFixtureCache(join(root, "cache"));
    const a = runCli(join(root, "a"), { cache });
    const b = runCli(join(root, "b"), { cache });
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    const read = (dir: string) =>
      JSON.parse(readFileSync(join(dir, "health.json"), "utf8")) as HealthReport;
    expect(read(join(root, "b")).confirmed_deadlines).toBe(
      read(join(root, "a")).confirmed_deadlines,
    );
  });

  it("a new warning code fails when the observation baseline knows the old codes", {
    timeout: 120_000,
  }, () => {
    const { baseline, current } = buildPair();
    // snapshot-fallback baseline では warning_codes が記録されないため、
    // update-data workflow と同じく observation baseline を比較源にする。
    const observation = observationOf(baseline);
    const mutated = JSON.parse(JSON.stringify(current)) as HealthReport;
    mutated.warning_codes = {
      ...(mutated.warning_codes ?? {}),
      BRAND_NEW_CODE: { count: 1, messages: ["synthetic"] },
    };
    const withBaseline = evaluateHealthGate(mutated, baseline, observation);
    expect(withBaseline.ok).toBe(false);
    expect(withBaseline.reasons.some((r) => r.includes("new warning code"))).toBe(true);
  });

  it("a new identity conflict fails when the observation baseline knows the old ones", {
    timeout: 120_000,
  }, () => {
    const { baseline, current } = buildPair();
    const observation = observationOf(baseline);
    const mutated = JSON.parse(JSON.stringify(current)) as HealthReport;
    const base = observation.identity_conflicts ?? {
      venue: 0,
      edition: 0,
      new_since_baseline: 0,
      details: [] as Array<{
        scope: "venue";
        reason: string;
        subject: string;
        candidates: string[];
      }>,
    };
    const conflicts = { ...base, new_since_baseline: 0 };
    conflicts.details = [
      ...(conflicts.details ?? []),
      {
        scope: "venue" as const,
        reason: "key-collision",
        subject: "fake:x|y",
        candidates: ["fake:a", "fake:b"],
      },
    ];
    mutated.identity_conflicts = conflicts;
    const result = evaluateHealthGate(mutated, baseline, observation);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("identity conflicts increased"))).toBe(true);
  });
});
