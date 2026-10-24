import { describe, expect, it } from "vitest";
import {
  isRecommendationAxes,
  recommendationAxes,
  venueEvidenceLineJa,
} from "../site/recommendation-core.ts";

const now = Date.parse("2026-10-13T00:00:00Z");
const counts = (input: Record<string, unknown>) => recommendationAxes(input, null, now);

describe("venue evidence describes catalog coverage, not age or review quality", () => {
  it("does not classify one recorded edition, even with rank, publisher and DBLP information", () => {
    const axes = counts({
      editions: [{ year: 2026, source: "publisher" }],
      dblp: "conf/known",
      rank: { ccf: "A" },
      papers: ["One sample", "Two samples"],
    });
    expect(axes.venue_evidence).toEqual({
      yearsObserved: 1,
      profileCoverage: 2,
      dblpLinked: true,
      publisherSource: true,
      rankListed: true,
    });
    expect(axes).not.toHaveProperty("venue_maturity");
    expect(axes.venue_evidence).not.toHaveProperty("status");
    expect(venueEvidenceLineJa(axes.venue_evidence)).toBe(
      "収録データ: 開催年 1年分 ／ 論文サンプル 2件",
    );
  });

  it("counts distinct recorded years rather than the span, and excludes both forms of estimated editions", () => {
    const axes = counts({
      all_editions: [
        { year: 1980 },
        { year: 2026 },
        { year: 2026 },
        { year: 2027, estimated: true },
        { year: 2028, estimate: { basis: "next-edition" } },
        { year: 0 },
        { year: 2025.5 },
        { year: true },
      ],
      editions: [{ year: 2026 }],
      papers: ["  One sample  ", "One sample", "Two\n samples", "Two samples", null, {}, 123, ""],
    });
    expect(axes.venue_evidence).toMatchObject({ yearsObserved: 2, profileCoverage: 2 });
    expect(venueEvidenceLineJa(axes.venue_evidence)).toBe(
      "収録データ: 開催年 2年分 ／ 論文サンプル 2件",
    );
  });

  it("does not infer that a venue has no history when no records are available", () => {
    const axes = counts({});
    expect(axes.venue_evidence).toEqual({
      yearsObserved: 0,
      profileCoverage: 0,
      dblpLinked: false,
      publisherSource: false,
      rankListed: false,
    });
    expect(venueEvidenceLineJa(axes.venue_evidence)).toBe(
      "収録データ: 開催年 0年分 ／ 論文サンプル 0件",
    );
    expect(isRecommendationAxes(axes)).toBe(true);
  });

  it("rejects old or hybrid maturity classifications rather than trusting a cached label", () => {
    const axes = counts({ editions: [{ year: 2026 }] });
    const old = {
      ...axes,
      venue_maturity: { status: "established", evidence: { yearsObserved: 99 } },
    };
    expect(isRecommendationAxes(old)).toBe(false);
    const { venue_evidence: _removed, ...rest } = old;
    expect(isRecommendationAxes(rest)).toBe(false);
    expect(isRecommendationAxes(axes)).toBe(true);
  });

  it.each([-1, 1.5, Number.NaN])("rejects an invalid recorded year count: %s", (yearsObserved) => {
    const axes = counts({});
    expect(
      isRecommendationAxes({ ...axes, venue_evidence: { ...axes.venue_evidence, yearsObserved } }),
    ).toBe(false);
  });

  it("validates the remaining axes when accepting cached evidence", () => {
    const axes = counts({});
    expect(isRecommendationAxes({ ...axes, deadline_precision: "invented" })).toBe(false);
    expect(
      isRecommendationAxes({
        ...axes,
        research_fit: { ...axes.research_fit, score: Number.POSITIVE_INFINITY },
      }),
    ).toBe(false);
    expect(
      isRecommendationAxes({
        ...axes,
        deadline_trust: { ...axes.deadline_trust, date: "constructor" },
      }),
    ).toBe(false);
  });
});
