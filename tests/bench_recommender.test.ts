import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  main as benchMain,
  type DataDeltaFixture,
  dataDeltaRegressionReasons,
  dataDeltaTop5,
  fellOutOfTop5,
  runDataDeltaBenchmark,
} from "../src/bench-recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

const fixture = JSON.parse(
  readFileSync(join(REPO_ROOT, "tests", "fixtures", "recommendation-data-delta.json"), "utf8"),
) as DataDeltaFixture;

describe("data-delta recommendation benchmark", () => {
  it("reports deterministic metric math and complete Top-5 delta lists", () => {
    const result = runDataDeltaBenchmark(fixture);
    expect(result).toMatchObject({
      case_count: 63,
      recall_at_1: 0.619048,
      recall_at_5: 0.698413,
      mrr: 0.644709,
      abstention_rate: 0.111111,
      expected_venues_dropped: [],
    });
    expect(result.ndcg_at_10).toBeCloseTo(0.657912, 6);
    expect(result.changed_top5).toHaveLength(55);
    expect(result.changed_top5).toContain("case-01-hpc-en");
    expect(result.new_venues_in_top5).toContain("ieice-fundamentals-discrete-math-special");
  });

  it("fails the required check when labeled quality regresses", async () => {
    const changed = JSON.parse(JSON.stringify(fixture)) as DataDeltaFixture;
    changed.after_candidates = [];
    const result = runDataDeltaBenchmark(changed);
    expect(dataDeltaRegressionReasons(changed, result)).toEqual(
      expect.arrayContaining([expect.stringContaining("recall_at_5 regressed")]),
    );
    const path = `${mkdtempSync(`${tmpdir()}/kamiyobi-bench-`)}/fixture.json`;
    writeFileSync(path, JSON.stringify(changed));
    expect(await benchMain(["--data-delta", path, "--json"])).toBe(1);
  });

  it("treats rank 5 to 6 as a Top-5 regression", () => {
    expect(fellOutOfTop5(["venue"], "venue", ["a", "b", "c", "d", "e", "venue"])).toBe(true);
  });

  it("derives the delta from candidate input rather than stored rankings", () => {
    const changed = JSON.parse(JSON.stringify(fixture)) as DataDeltaFixture;
    changed.after_candidates = [];
    const baseline = runDataDeltaBenchmark(fixture);
    const result = runDataDeltaBenchmark(changed);
    expect(result.recall_at_1).not.toBe(baseline.recall_at_1);
    expect(result.new_venues_in_top5).not.toEqual(baseline.new_venues_in_top5);
  });

  it("includes a deadline-free journal through the same browser pool", () => {
    const journal = {
      key: "ccpe",
      title: "Kernel Systems Journal",
      full_name: "Kernel Systems Journal",
      categories: ["systems"],
      tags: ["journal"],
      editions: [],
    };
    expect(
      dataDeltaTop5(
        [journal],
        [{ title: "kernel storage", abstract: "", keywords: "", venue: "" }],
      ),
    ).toContain("ccpe");
  });

  it("requires a labeled 60-100 case fixture with all nine categories", () => {
    expect(() => runDataDeltaBenchmark({ ...fixture, cases: fixture.cases.slice(0, 59) })).toThrow(
      /60-100/,
    );
    expect(() =>
      runDataDeltaBenchmark({
        ...fixture,
        cases: fixture.cases.map((item) => ({ ...item, category: "systems" })),
      }),
    ).toThrow(/category/);
    expect(() =>
      runDataDeltaBenchmark({
        ...fixture,
        cases: fixture.cases.map((item) => ({ ...item, venue_kind: "international" })),
      }),
    ).toThrow(/venue kind/);
    expect(() =>
      runDataDeltaBenchmark({
        ...fixture,
        cases: fixture.cases.map((item) => ({ ...item, input: "title-only" })),
      }),
    ).toThrow(/input coverage/);
  });
});
