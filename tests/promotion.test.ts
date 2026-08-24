import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type PromotionObservation,
  resolvePromotion,
  writePromotionBatch,
} from "../src/promotion.ts";
import { REPO_ROOT } from "./helpers.ts";

const evidence = {
  sourceRevision: "cfp-v1",
  retrievedAt: "2026-08-25T00:00:00.000Z",
  verifiedAt: "2026-08-25T00:01:00.000Z",
  contentHash: "a".repeat(64),
};

function observation(overrides: Partial<PromotionObservation> = {}): PromotionObservation {
  return {
    candidate: "exampleconf",
    sourceUrl: "https://example.test/cfp",
    sourceClass: "official-cfp",
    title: "ExampleConf",
    categories: ["systems"],
    tags: ["workshop"],
    reviewState: "reviewed",
    deadline: {
      date: "2027-01-02",
      time: "23:59:00",
      timezone: "AoE",
      kind: "paper",
      round: 2,
      track: "main",
    },
    eventDate: "2027-04-01",
    eventEndDate: "2027-04-03",
    rawExcerpt: "Paper deadline: January 2, 2027 23:59 AoE",
    evidence,
    ...overrides,
  };
}

describe("promotion batch", () => {
  it("promotes exact and date-only primary observations with normalized field evidence", () => {
    const exact = resolvePromotion(observation());
    expect(exact).toMatchObject({
      decision: "promote",
      normalized: {
        venue: { key: "exampleconf", categories: ["systems"], tags: ["workshop"] },
        edition: { year: 2027, event_start: "2027-04-01", event_end: "2027-04-03" },
        deadline: { precision: "exact", kind: "paper", round: 2, track: "main", tz: "AoE" },
      },
    });
    const dateOnly = resolvePromotion(
      observation({ deadline: { date: "2027-01-02", kind: "paper", round: 1 } }),
    );
    expect(dateOnly.normalized?.deadline).toMatchObject({
      precision: "date-only",
      date: "2027-01-02",
    });
    const dateOnlyEvidence = dateOnly.normalized!.deadline.evidence as Array<
      Record<string, unknown>
    >;
    expect(dateOnlyEvidence[0]).toMatchObject({
      sourceClass: "official-cfp",
      sourceRevision: "cfp-v1",
      contentHash: "a".repeat(64),
      verifiedFields: ["date", "kind", "round"],
    });
  });

  it("holds missing primary fields and rejects non-primary observations", () => {
    expect(
      resolvePromotion(observation({ evidence: { ...evidence, contentHash: "" } })).decision,
    ).toBe("hold");
    expect(resolvePromotion(observation({ sourceClass: "aggregator" })).decision).toBe("reject");
  });

  it("holds impossible dates, times, zones, and incoherent edition years", () => {
    expect(
      resolvePromotion(
        observation({
          title: "ExampleConf 2027",
          eventDate: undefined,
          deadline: { date: "2026-99-99", time: "99:99", timezone: "Mars/Phobos" },
        }),
      ).decision,
    ).toBe("hold");
    expect(resolvePromotion(observation({ eventEndDate: undefined })).decision).toBe("hold");
    const previousYearDeadline = resolvePromotion(
      observation({
        title: "ExampleConf 2027",
        eventDate: undefined,
        eventEndDate: undefined,
        deadline: { date: "2026-01-02", time: "23:59", timezone: "UTC" },
      }),
    );
    expect(previousYearDeadline).toMatchObject({
      decision: "promote",
      normalized: { edition: { year: 2027 } },
    });
    expect(
      resolvePromotion(
        observation({
          title: "ExampleConf 2028",
          eventDate: "2027-04-01",
          eventEndDate: "2027-04-03",
          deadline: { date: "2026-01-02", time: "23:59", timezone: "UTC" },
        }),
      ).decision,
    ).toBe("hold");
  });

  it("writes byte-identical isolated batch artifacts and verifies JSONL files", () => {
    const dir = mkdtempSync(join(tmpdir(), "kamiyobi-promotion-"));
    const observations = join(dir, "observations.jsonl");
    writeFileSync(
      observations,
      `${JSON.stringify(observation())}\n${JSON.stringify(observation({ candidate: "hold", title: undefined }))}\n`,
    );
    const files = ["observations.jsonl", "resolutions.json", "manifest.json", "extra.yaml"];
    const run = () =>
      writePromotionBatch(observations, join(dir, "resolutions.json"), join(dir, "manifest.json"));
    expect(run().map((resolution) => resolution.decision)).toEqual(["promote", "hold"]);
    const first = Object.fromEntries(
      files.map((file) => [file, readFileSync(join(dir, file), "utf8")]),
    );
    run();
    expect(
      Object.fromEntries(files.map((file) => [file, readFileSync(join(dir, file), "utf8")])),
    ).toEqual(first);
    expect(first["extra.yaml"]).toContain("precision: exact");
    expect(JSON.parse(first["manifest.json"]).extra.sha256).toMatch(/^[0-9a-f]{64}$/);
    const verified = spawnSync("node", ["scripts/verify-cfp.ts", "--file", observations], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(verified.status).toBe(0);
    expect(JSON.parse(verified.stdout)).toHaveLength(2);

    const generated = join(dir, "generated");
    const promoted = spawnSync(
      "node",
      ["scripts/promote-candidates.ts", observations, "--out", generated],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    expect(promoted.status).toBe(0);
    for (const file of files) expect(existsSync(join(generated, file))).toBe(true);
    expect(readFileSync(join(generated, "observations.jsonl"), "utf8")).toBe(
      readFileSync(observations, "utf8"),
    );
  });
});
