import { describe, expect, it } from "vitest";
import {
  HARD_NEGATIVE_QUOTAS,
  type RerankerTrainingRow,
  selectHardNegatives,
} from "../scripts/train-reranker.ts";

function negativeRow(
  venue: string,
  scores: { lexical: number; semantic: number; base: number; category: number },
): RerankerTrainingRow {
  return {
    paperId: "paper-1",
    venue,
    y: 0,
    baseScore: scores.base,
    x: [],
    features: {
      lexical_score: scores.lexical,
      semantic_score: scores.semantic,
      category_overlap: scores.category,
    },
  };
}

describe("reranker hard-negative sampling", () => {
  it("uses deterministic disjoint buckets and removes duplicate venues", () => {
    const rows = Array.from({ length: 140 }, (_, index) =>
      negativeRow(`venue-${String(index).padStart(3, "0")}`, {
        lexical: index === 0 ? 1000 : -index,
        semantic: index === 1 ? 1000 : -index,
        base: index === 2 ? 1000 : -index,
        category: index === 3 ? 1000 : -index,
      }),
    );
    const duplicate = { ...rows[0]!, venue: rows[0]!.venue };
    const first = selectHardNegatives([...rows, duplicate]);
    const second = selectHardNegatives([...rows, duplicate]);

    expect(first).toHaveLength(
      HARD_NEGATIVE_QUOTAS.lexical +
        HARD_NEGATIVE_QUOTAS.semantic +
        HARD_NEGATIVE_QUOTAS.base +
        HARD_NEGATIVE_QUOTAS.category_confusable +
        HARD_NEGATIVE_QUOTAS.random,
    );
    expect(new Set(first.map((row) => row.venue)).size).toBe(first.length);
    expect(first.map((row) => row.venue)).toEqual(second.map((row) => row.venue));
    const smallQuotas = {
      lexical: 1,
      semantic: 1,
      base: 1,
      category_confusable: 1,
      random: 1,
    } as const;
    expect(
      selectHardNegatives(rows, smallQuotas)
        .slice(0, 4)
        .map((row) => row.venue),
    ).toEqual(["venue-000", "venue-001", "venue-002", "venue-003"]);
  });

  it("shrinks gracefully when a fixture has fewer negatives than the quota", () => {
    const rows = [
      negativeRow("a", { lexical: 1, semantic: 0, base: 0, category: 0 }),
      negativeRow("b", { lexical: 0, semantic: 1, base: 0, category: 0 }),
    ];
    expect(selectHardNegatives(rows).map((row) => row.venue)).toEqual(["a", "b"]);
  });
});
