import { describe, expect, it } from "vitest";
import Recommendation from "../site/recommendation.ts";
import Core from "../site/recommender.ts";

const now = Date.parse("2026-08-09T00:00:00Z");
function rows(key: string, title: string, full_name: string, categories: string[]) {
  return Core.candidateRows({
    conferences: [
      {
        key,
        title,
        full_name,
        categories,
        editions: [
          {
            year: 2027,
            deadlines: [{ kind: "paper", precision: "exact", utc: "2027-01-01T00:00:00Z" }],
          },
        ],
      },
    ],
  });
}
const journal = rows("fgcs", "FGCS", "Future Generation Computer Systems", ["systems"]);
const workshop = rows("local-ml", "国内ML研究会", "機械学習研究会", ["ai"]);
const lines = (title: string) => [{ title, abstract: "", keywords: "", venue: "" }];

describe("shared word-only recommendation fallback", () => {
  it("keeps an explicitly named venue ahead of broader topic matches without increasing confidence", () => {
    const input = [...workshop, ...journal];
    const result = Recommendation.venueRecommendations(
      input,
      lines("機械学習の応用 fgcs"),
      null,
      now,
      { topN: 1 },
    );
    expect(result[0].venueKey).toBe("fgcs");
    const original = Core.venueRecommendations(journal, lines("機械学習の応用 fgcs"), null, now)[0];
    expect(result[0].fit.score).toBe(original.fit.score);
    expect(result[0].fit.confidence).toBe(original.fit.confidence);
  });
  it("requires a whole venue key, not a prefix or a hyphenated longer venue", () => {
    for (const title of ["機械学習の応用 xfgcsx", "機械学習の応用 fgcs-workshop"]) {
      const input = [...workshop, ...journal];
      expect(Recommendation.venueRecommendations(input, lines(title), null, now)).toEqual(
        Core.venueRecommendations(input, lines(title), null, now),
      );
    }
  });
  it("does not mistake a category abbreviation for a venue name", () => {
    const input = rows(
      "ipsj-sigdbs",
      "情報処理学会 DBS 研究会",
      "情報処理学会 データベースシステム研究会 (DBS)",
      ["db"],
    );
    expect(Core.venueRecommendations(input, lines("unrelated db request"), null, now)).not.toEqual(
      [],
    );
    expect(
      Recommendation.venueRecommendations(input, lines("unrelated db request"), null, now),
    ).toEqual([]);
    expect(
      Recommendation.venueRecommendations(
        input,
        lines("データベースの解析 ipsj-sigdbs"),
        null,
        now,
      )[0].venueKey,
    ).toBe("ipsj-sigdbs");
  });
  it("keeps independently verified fielded and semantic scoring unchanged", () => {
    const input = [...workshop, ...journal];
    for (const [semantic, options] of [
      [null, { fieldedLexical: true }],
      [{ fgcs: 80 }, {}],
    ] as const) {
      expect(
        Recommendation.venueRecommendations(
          input,
          lines("機械学習の応用 fgcs"),
          semantic,
          now,
          options,
        ),
      ).toEqual(
        Core.venueRecommendations(input, lines("機械学習の応用 fgcs"), semantic, now, options),
      );
    }
  });
});
