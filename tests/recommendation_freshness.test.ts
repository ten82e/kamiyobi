import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recommendationAxes, recommendationRetrievalStatus } from "../site/recommendation-core.ts";
import { RERANKER_ALGORITHM_REVISION, RERANKER_FEATURE_SCHEMA } from "../site/recommender.ts";
import { ROOT, setRoot, toRecommendationIndex } from "../src/build.ts";
import { tempWork } from "./helpers.ts";

const now = new Date("2026-10-13T00:00:00Z");
const deadline = (extra: Record<string, unknown> = {}) => ({
  kind: "paper",
  precision: "exact",
  utc: "2027-01-02T00:00:00Z",
  ...extra,
});
const conference = (deadlines: unknown[]) => ({
  key: "sample",
  title: "Sample",
  categories: ["systems"],
  editions: [{ year: 2027, deadlines }],
});
const freshness = (deadlines: unknown[]) =>
  recommendationAxes(conference(deadlines), null, now.getTime()).deadline_trust.sourceFreshness;

describe("retrieval history is distinct from official verification", () => {
  it.each([
    [
      { status: "cache-fallback", observationStatus: "fresh", fetchedAt: now.toISOString() },
      "cache-fallback",
    ],
    [
      { status: "snapshot-fallback", observationStatus: "fresh", fetchedAt: now.toISOString() },
      "snapshot-fallback",
    ],
    [{ status: "fresh", fetchedAt: null }, "unknown"],
    [{ status: "fresh", fetchedAt: "invalid" }, "unknown"],
    [{ status: "fresh", fetchedAt: now.toISOString() }, "fresh"],
  ])("keeps actual source retrieval status: %j", (metadata, expected) => {
    expect(recommendationRetrievalStatus(metadata as Record<string, unknown>)).toBe(expected);
  });

  it("does not infer a fresh retrieval from official evidence or a verification timestamp", () => {
    expect(
      freshness([
        deadline({
          evidence: [{ sourceClass: "official-cfp", verifiedFields: ["date"] }],
          verification: { status: "confirmed", last_verified_at: now.toISOString() },
        }),
      ]),
    ).toBe("unknown");
  });
  it("does not use an unrelated edition's history when there is no displayed deadline", () => {
    const axes = recommendationAxes(
      { editions: [{ year: 2020, sourceFreshness: "fresh" }] },
      null,
      now.getTime(),
    );
    expect(axes.deadline_trust.sourceFreshness).toBe("unknown");
  });
  it.each(["fresh", "cache-fallback", "snapshot-fallback"])(
    "retains explicit %s retrieval status",
    (status) => {
      expect(
        freshness([deadline({ origins: [{ sourceClass: "official-cfp", freshness: status }] })]),
      ).toBe(status);
    },
  );
  it("does not borrow a lower-trust origin's fresh status", () => {
    expect(
      freshness([
        deadline({
          origins: [
            { sourceClass: "official-cfp" },
            { sourceClass: "aggregator", freshness: "fresh" },
          ],
        }),
      ]),
    ).toBe("unknown");
  });
  it("does not let one fresh deadline hide another without retrieval history", () => {
    expect(
      freshness([
        deadline({ origins: [{ freshness: "fresh" }] }),
        deadline({ utc: "2027-01-03T00:00:00Z" }),
      ]),
    ).toBe("unknown");
  });
  it("does not manufacture fresh origins when building the recommendation index", () => {
    const data = {
      conferences: [
        conference([
          deadline({
            evidence: [{ source_name: "official", sourceClass: "official-cfp" }],
          }),
        ]),
      ],
    };
    const originalRoot = ROOT;
    const root = tempWork("freshness-index-");
    mkdirSync(join(root, "data"));
    // Ranking is outside this metadata test; supply its required contract locally.
    writeFileSync(
      join(root, "data/recommender-reranker.json"),
      JSON.stringify({
        version: 1,
        algorithm_revision: RERANKER_ALGORITHM_REVISION,
        feature_schema: RERANKER_FEATURE_SCHEMA,
        weights: Object.fromEntries(RERANKER_FEATURE_SCHEMA.map((name) => [name, 0])),
        intercept: 0,
        blend: 0,
        confidence_thresholds: { sufficient: 1, ambiguous: 0 },
        confidence_policy: { sufficient_enabled: false },
      }),
    );
    setRoot(root);
    try {
      const index = toRecommendationIndex(data, now) as {
        conferences: Array<{
          editions: Array<{ deadlines: Array<{ origins: Array<{ freshness: string }> }> }>;
          recommendation_axes: { deadline_trust: { sourceFreshness: string } };
        }>;
      };
      expect(index.conferences[0].editions[0].deadlines[0].origins[0].freshness).toBe("unknown");
      expect(index.conferences[0].recommendation_axes.deadline_trust.sourceFreshness).toBe(
        "unknown",
      );
      const explicit = toRecommendationIndex(data, now, { official: "fresh" }) as typeof index;
      expect(explicit.conferences[0].recommendation_axes.deadline_trust.sourceFreshness).toBe(
        "fresh",
      );
    } finally {
      setRoot(originalRoot);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
