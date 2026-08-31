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
  // health.json のみを検証対象とし、embeddings (ONNX 推論) は並列ワーカ下で
  // 競合してタイムアウトするため省略。他の build テストと同じ慣習。
  expect(runCli(baselineDir, { cache, extra: ["--no-embeddings"] }).status).toBe(0);
  if (mutate) {
    mutate(join(cache, "ccfddl__ccf-deadlines__main", "ccf-deadlines-main", "conference"));
  }
  expect(runCli(currentDir, { cache, extra: ["--no-embeddings"] }).status).toBe(0);
  return {
    baseline: JSON.parse(readFileSync(join(baselineDir, "health.json"), "utf8")) as HealthReport,
    current: JSON.parse(readFileSync(join(currentDir, "health.json"), "utf8")) as HealthReport,
  };
}

/** 現在の data から観測系 baseline を作る。 */
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

  it("future-edition id rename passes the gate (issta-type upstream adoption)", {
    timeout: 240_000,
  }, () => {
    // issta|override-2027 → issta27 型: 上流が従来 override だった 2027 edition を
    // 公式収録すると edition id が rename される。venue/kind/round/track/時刻が
    // 全て一致する slot は同一締切であり、future deadline disappeared の誤検知に
    // してはならない (2026-08-30 実測)。過去締切の sigcomm rename テストは
    // disappeared 判定の対象外 (L1787: latest_ms <= previousTime で skip) なので、
    // 未来締切で pin する。
    const { baseline, current } = buildPair((root) => {
      const file = join(root, "NW", "nsdi.yml");
      const text = readFileSync(file, "utf8").replace(/(id: nsdi27\n)/, "id: nsdi27b\n");
      writeFileSync(file, text);
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
    const a = runCli(join(root, "a"), { cache, extra: ["--no-embeddings"] });
    const b = runCli(join(root, "b"), { cache, extra: ["--no-embeddings"] });
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
    // observation baseline を比較源にする。
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

  it("timeline array->object drift (valid YAML) is detected as future deadline disappearance", {
    timeout: 240_000,
  }, () => {
    const { baseline, current } = buildPair((root) => {
      const file = join(root, "NW", "nsdi.yml");
      // timeline を完全オブジェクト化（valid YAML）。deadlinesOf は配列以外を
      // 無視して fallback（top-level にも deadline が無い）→ deadlines=0 になる経路。
      // 例外・パース失敗は起こらないため「行削除」シナリオとは別経路の drift。
      const text = readFileSync(file, "utf8").replace(
        /timeline:\n(\s+)- abstract_deadline: '2026-04-16 23:59:59'\n\s+deadline: '2026-04-23 23:59:59'\n(\s+)- abstract_deadline: '2026-09-10 23:59:59'\n\s+deadline: '2026-09-17 23:59:59'\n/,
        "timeline:\n$1  abstract_deadline: '2026-04-16 23:59:59'\n$1  deadline: '2026-04-23 23:59:59'\n$1  abstract_deadline: '2026-09-10 23:59:59'\n$1  deadline: '2026-09-17 23:59:59'\n",
      );
      writeFileSync(file, text);
    });
    const result = evaluateHealthGate(current, baseline);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("future deadline disappeared"))).toBe(
      true,
    );
  });

  it("confs array->object drift skips only that conference; the gate still blocks", {
    timeout: 240_000,
  }, () => {
    const root = scratch();
    const cache = makeFixtureCache(join(root, "cache"));
    const baselineDir = join(root, "baseline");
    const currentDir = join(root, "current");
    expect(runCli(baselineDir, { cache, extra: ["--no-embeddings"] }).status).toBe(0);
    const treeRoot = join(cache, "ccfddl__ccf-deadlines__main", "ccf-deadlines-main", "conference");
    const file = join(treeRoot, "NW", "nsdi.yml");
    // confs 全体をオブジェクト（配列でない）に置換 — 上流スキーマ drift の模擬。
    // 修正後: その 1 ファイルは skip されソース全体は落ちない (source_failures 空)。
    // 代わりに該当会議の締切消失として gate が検出する。
    writeFileSync(
      file,
      `- title: NSDI
  description: USENIX Symposium on Networked Systems Design and Implementation
  sub: NW
  dblp: nsdi
  confs:
    year: 2027
    id: nsdi27
    link: https://www.usenix.org/conference/nsdi27
    timeline:
      - abstract_deadline: '2026-09-10 23:59:59'
        deadline: '2026-09-17 23:59:59'
    timezone: UTC-4
    date: May 11-13, 2027
    place: Providence, RI, USA
`,
    );
    expect(runCli(currentDir, { cache, extra: ["--no-embeddings"] }).status).toBe(0);
    const health = JSON.parse(
      readFileSync(join(currentDir, "health.json"), "utf8"),
    ) as HealthReport;
    expect(health.source_failures ?? []).toEqual([]);
    const baseline = JSON.parse(
      readFileSync(join(baselineDir, "health.json"), "utf8"),
    ) as HealthReport;
    const result = evaluateHealthGate(health, baseline);
    expect(result.ok).toBe(false);
    expect(
      result.reasons.some(
        (r) => r.includes("future deadline disappeared") || r.includes("required venue"),
      ),
    ).toBe(true);
  });
});
