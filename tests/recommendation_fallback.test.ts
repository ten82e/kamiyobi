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
  /* 並びは**画面に出している一致評価（fit.score）の強い順**。語の重なりの点（lexical）で
   * 並べ替えると、点の低い候補が点の高い候補より上に来て、カードの札
   * （「候補」「重なりうすい」）と順が食い違う（2026-10-18 実測: TSN の例で RTSS 80 点が
   * 9 番目、COLT 16 点が 1 番目）。 */
  it("orders candidates by the fit score shown on the card, not by lexical overlap", () => {
    const input = [...journal, ...workshop];
    const 結果 = Recommendation.venueRecommendations(
      input,
      lines("機械学習 大規模 分散 systems"),
      null,
      now,
      {},
    );
    const 点 = 結果.map((r) => r.fit.score);
    expect(点.length, "候補が出ていない（検査が空振り）").toBeGreaterThan(1);
    for (let i = 1; i < 点.length; i += 1)
      expect(点[i - 1], `点の順が崩れている: ${JSON.stringify(点)}`).toBeGreaterThanOrEqual(点[i]);
  });

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
  it("uses the same intent policy for the browser's fielded fallback when semantics are unavailable", () => {
    const input = [...workshop, ...journal];
    expect(
      Recommendation.venueRecommendations(input, lines("機械学習の応用 fgcs"), null, now, {
        fieldedLexical: true,
      })[0].venueKey,
    ).toBe("fgcs");
  });
  it("requires a whole venue key, not a prefix or a hyphenated longer venue", () => {
    for (const title of ["機械学習の応用 xfgcsx", "機械学習の応用 fgcs-workshop"]) {
      const input = [...workshop, ...journal];
      const result = Recommendation.venueRecommendations(input, lines(title), null, now);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].venueKey).toBe("local-ml");
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
  it("keeps independently verified semantic scoring unchanged", () => {
    const input = [...workshop, ...journal];
    for (const [semantic, options] of [
      [{ fgcs: 80 }, { fieldedLexical: true }],
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
  it.each([false, true])(
    "keeps all matching venues before UI pagination (semantic=%s)",
    (semantic) => {
      const input = Array.from({ length: 231 }, (_, i) =>
        rows(`gpu-study-${i}`, `GPU memory study ${i}`, "GPU memory management", ["systems"]).map(
          (row) => ({ ...row, conf: { ...row.conf, scope: ["GPU memory management"] } }),
        ),
      ).flat();
      const scores = semantic
        ? Object.fromEntries(input.map((row, i) => [row.conf.key, 90 - i / 100]))
        : null;
      const options = { fieldedLexical: true };
      const all = Recommendation.venueRecommendations(
        input,
        lines("GPU memory management"),
        scores,
        now,
        options,
      );
      expect(all).toHaveLength(231);
      expect(new Set(all.map((item) => item.venueKey)).size).toBe(231);
      expect(all).toEqual(
        Core.venueRecommendations(input, lines("GPU memory management"), scores, now, {
          ...options,
          topN: input.length,
        }),
      );
      const limited = Recommendation.venueRecommendations(
        input,
        lines("GPU memory management"),
        scores,
        now,
        { ...options, topN: 7 },
      );
      expect(limited.map((item) => item.venueKey)).toEqual(
        all.slice(0, 7).map((item) => item.venueKey),
      );
      expect(limited.map((item) => item.fit.score)).toEqual(
        all.slice(0, 7).map((item) => item.fit.score),
      );
    },
  );
  it("retrieves an explicitly named venue even when its lexical rank is beyond two hundred", () => {
    const strong = Array.from({ length: 231 }, (_, i) =>
      rows(`gpu-study-${i}`, `GPU memory study ${i}`, "GPU memory management", ["systems"]),
    ).flat();
    const preferred = rows("fgcs", "FGCS", "Future Generation Computer Systems", ["systems"]);
    const input = [...strong, ...preferred];
    const query = lines("GPU memory management fgcs");
    const all = Core.venueRecommendations(input, query, null, now, {
      fieldedLexical: true,
      topN: input.length,
    });
    expect(all.findIndex((item) => item.venueKey === "fgcs")).toBeGreaterThanOrEqual(200);
    expect(
      Recommendation.venueRecommendations(input, query, null, now, {
        fieldedLexical: true,
        topN: 1,
      }).map((item) => item.venueKey),
    ).toEqual(["fgcs"]);
  });
  it("keeps undated venue metadata, avoids duplicates and leaves CSV dates empty", () => {
    const known = rows("dated", "GPU memory systems", "GPU memory systems", ["systems"]);
    const conferences = [
      known[0].conf,
      {
        key: "undated",
        title: "GPU memory research",
        categories: ["systems"],
        scope: ["gpu memory management"],
        editions: [],
      },
    ];
    const missing = Recommendation.undatedVenueRows(conferences, known);
    expect(missing.map((row) => row.conf.key)).toEqual(["undated"]);
    expect(Number.isFinite(missing[0].t)).toBe(false);
    expect(missing[0].dl).toEqual({});
    expect(Recommendation.undatedVenueRows(conferences, [...known, ...missing])).toEqual([]);
    const results = Recommendation.venueRecommendations(
      [...known, ...missing],
      lines("GPU memory management"),
      null,
      now,
      { fieldedLexical: true },
    );
    expect(results.find((row) => row.venueKey === "undated")!.availability).toMatchObject({
      status: "unknown",
      timestamp: null,
      local_date: null,
    });
    const csv = Recommendation.candidateRowsToCsv(
      [missing[0] as unknown as Record<string, unknown>],
      now,
    );
    expect(csv.split("\r\n")[1].startsWith(",,,,,,,")).toBe(true);
    expect(csv).not.toMatch(/NaN|1970-01-01/);
  });
  it("does not recreate an alias of an already consolidated submission as an undated venue", () => {
    const dated = rows("canonical", "GPU research", "GPU research", ["systems"]);
    const represented = dated.map((row) => ({
      ...row,
      submission: {
        issueLabel: "issue",
        language: "English",
        shareAliases: [],
        sourceRecords: [
          { venueKey: "canonical", editionId: "canonical27", year: 2027 },
          { venueKey: "alias", editionId: "alias27", year: 2027 },
        ],
      },
    }));
    const conferences = [dated[0].conf, { key: "alias", title: "GPU alias", editions: [] }];
    expect(Recommendation.undatedVenueRows(conferences, represented)).toEqual([]);
  });
});
