import { describe, expect, it } from "vitest";
import R from "../site/recommender.ts";

const NOW = Date.UTC(2026, 0, 1);
const row = (key: string, title: string) => ({
  conf: { key, title, full_name: "", tags: [] },
  cats: [],
});

describe("recommendation retrieval without generated data", () => {
  it.each([
    "Statistical inference for randomized experiments",
    "クエリ拡張による文書検索の精度を評価する。",
  ])("keeps an abstract-only JSON input in its own field: %s", (abstract) => {
    const lines = R.parsePaperLines(JSON.stringify([{ title: "", abstract }]));
    expect(lines).toEqual([{ title: "", abstract, keywords: "", venue: "" }]);
    expect(R.queryText(lines)).toContain(abstract);
    expect(R.queryText(lines)).not.toContain('"abstract":');
    expect(R.parsePaperLines('[{"title":"","abstract":""}]')).toEqual([]);
  });

  it("preserves canonical hyphenated semantic keys and gives them precedence over aliases", () => {
    const rows = [row("information-retrieval", "Neutral forum")];
    const result = R.venueRecommendations(
      rows,
      R.parsePaperLines("unmatched topic"),
      { "information-retrieval": 70, "information retrieval": 5 },
      NOW,
      { semanticSimilarities: { "information-retrieval": 0.7 } },
    );
    expect(result).toHaveLength(1);
    expect(result[0].fit.semanticScore).toBe(70);
    expect(result[0].fit.semanticRank).toBe(1);
  });

  it("ranks by unrounded evidence when the displayed scores tie", () => {
    const rows = ["first", "second", "zzthird", "aafourth"].map((key) => row(key, "Neutral forum"));
    const result = R.venueRecommendations(
      rows,
      R.parsePaperLines("unmatched topic"),
      { first: 90, second: 80, zzthird: 70, aafourth: 60 },
      NOW,
    );
    expect(result.map((item) => item.venueKey)).toEqual(["first", "second", "zzthird", "aafourth"]);
    expect(result[2].fit.baseScore).toBe(result[3].fit.baseScore);
  });

  it("retains weak positive similarities without treating their display score as strong evidence", () => {
    const query = [1, 0];
    const embeddings = {
      nearest: [0.19, Math.sqrt(1 - 0.19 ** 2)],
      farther: [0.1, Math.sqrt(1 - 0.1 ** 2)],
      orthogonal: [0, 1],
    };
    const scores = Object.fromEntries(
      Object.keys(embeddings).map((key) => [key, R.semanticScore(key, query, embeddings)]),
    );
    const similarities = Object.fromEntries(
      Object.keys(embeddings).map((key) => [key, R.semanticSimilarity(key, query, embeddings)]),
    );
    expect(Object.values(scores)).toEqual([0, 0, 0]);
    const result = R.venueRecommendations(
      Object.keys(embeddings).map((key) => row(key, "Neutral forum")),
      R.parsePaperLines("unmatched topic"),
      scores,
      NOW,
      { fieldedLexical: true, semanticSimilarities: similarities },
    );
    expect(result.map((item) => item.venueKey)).toEqual(["nearest", "farther"]);
    expect(result[0].fit.semanticScore).toBe(0);
    expect(result[0].fit.evidenceStrength).toBe(0);
    expect(result[0].fit.confidence).toBe("insufficient");
  });

  it("expands retrieval topics at word boundaries and retains the original Japanese input", () => {
    expect(R.expandJp("chair", true)).toBe("");
    expect(R.expandJp("clustering", true)).toContain("unsupervised machine learning");
    expect(R.expandJp("reclusteringness", true)).toBe("");
    expect(R.expandJp("機械学習", true)).toContain("machine learning");
    const rows = [
      {
        conf: { key: "learning", title: "Learning forum", scope: "unsupervised machine learning" },
        cats: ["ai"],
      },
      {
        conf: { key: "center", title: "Datacenter forum", scope: "datacenter networking" },
        cats: ["networking"],
      },
    ];
    const result = R.venueRecommendations(
      rows,
      R.parsePaperLines("clustering"),
      { learning: 0, center: 0 },
      NOW,
      { fieldedLexical: true, semanticSimilarities: { learning: 0.1, center: 0.1 } },
    );
    expect(result[0].venueKey).toBe("learning");
    expect(result[0].fit.lexicalRank).toBe(1);
  });
});
