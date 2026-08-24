import { describe, expect, it } from "vitest";
import { recommendationAxes } from "../site/recommendation-core.ts";
import recommender from "../site/recommender.ts";
import { toRecommendationIndex } from "../src/build.ts";

function conference(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "venue",
    title: "Venue",
    categories: ["systems"],
    tags: [],
    papers: ["Representative paper"],
    editions: [
      {
        year: 2027,
        estimated: false,
        deadlines: [
          {
            kind: "paper",
            precision: "exact",
            utc: "2027-01-02T23:59:00.000Z",
            evidence: [
              { sourceClass: "official-cfp", verifiedFields: ["date", "time", "timezone"] },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("recommendation axes", () => {
  it("keeps official exact fit, maturity, precision, and evidence as independent values", () => {
    expect(recommendationAxes(conference(), 82)).toEqual({
      research_fit: { score: 82, categories: ["systems"], tags: [] },
      venue_maturity: { status: "established", profile_status: "profiled" },
      deadline_precision: "exact",
      evidence_quality: "official",
    });
  });

  it("distinguishes aggregator date-only, estimated/no-deadline, and new venue cases", () => {
    expect(
      recommendationAxes(
        conference({
          papers: [],
          editions: [
            {
              year: 2027,
              deadlines: [
                {
                  precision: "date-only",
                  local_date: "2027-01-02",
                  evidence: [{ sourceClass: "aggregator" }],
                },
              ],
            },
          ],
        }),
      ),
    ).toMatchObject({
      venue_maturity: { status: "new", profile_status: "unprofiled" },
      deadline_precision: "date-only",
      evidence_quality: "aggregator",
    });
    expect(
      recommendationAxes(
        conference({ editions: [{ year: 2027, estimated: true, deadlines: [] }] }),
      ),
    ).toMatchObject({
      deadline_precision: "estimated",
      evidence_quality: "none",
    });
    expect(recommendationAxes(conference({ editions: [] }))).toMatchObject({
      deadline_precision: "none",
    });
  });

  it("publishes the same axes in the browser-facing recommendation index", () => {
    const index = toRecommendationIndex(
      {
        generated_at: "2026-08-25T00:00:00.000Z",
        site: {},
        sources: [],
        categories: {},
        conferences: [conference()],
      },
      new Date("2026-08-25T00:00:00.000Z"),
    );
    const published = (index.conferences as Array<Record<string, unknown>>)[0]!;
    expect(published.recommendation_axes).toMatchObject({
      research_fit: { score: null, categories: ["systems"] },
      venue_maturity: { status: "established" },
      deadline_precision: "exact",
      evidence_quality: "official",
    });
  });

  it("uses the next target deadline rather than an older official history", () => {
    const value = conference({
      editions: [
        {
          year: 2025,
          deadlines: [
            {
              precision: "exact",
              utc: "2025-01-01T00:00:00Z",
              evidence: [{ sourceClass: "official-cfp" }],
            },
          ],
        },
        {
          year: 2027,
          deadlines: [
            {
              precision: "date-only",
              local_date: "2027-01-02",
              evidence: [{ sourceClass: "aggregator" }],
            },
          ],
        },
      ],
    });
    expect(recommendationAxes(value, null, Date.parse("2026-08-25T00:00:00Z"))).toMatchObject({
      deadline_precision: "date-only",
      evidence_quality: "aggregator",
    });
  });

  it("ignores an expired exact deadline in the same target edition", () => {
    const value = conference({
      editions: [
        {
          year: 2027,
          deadlines: [
            {
              precision: "exact",
              utc: "2026-01-01T00:00:00Z",
              evidence: [{ sourceClass: "official-cfp" }],
            },
            {
              precision: "date-only",
              local_date: "2027-01-02",
              evidence: [{ sourceClass: "aggregator" }],
            },
          ],
        },
      ],
    });
    expect(recommendationAxes(value, null, Date.parse("2026-08-25T00:00:00Z"))).toMatchObject({
      deadline_precision: "date-only",
      evidence_quality: "aggregator",
    });
  });

  it("returns independent browser-facing axes with each ranked recommendation", () => {
    const candidates = [
      conference(),
      conference({
        key: "aggregator",
        title: "Kernel storage aggregator venue",
        papers: [],
        editions: [
          {
            year: 2027,
            deadlines: [
              {
                precision: "date-only",
                local_date: "2027-01-02",
                earliest_utc: "2027-01-02T00:00:00.000Z",
                latest_utc: "2027-01-02T23:59:59.999Z",
                evidence: [{ sourceClass: "aggregator" }],
              },
            ],
          },
        ],
      }),
    ];
    const rows = (recommender as any).candidateRows({ conferences: candidates });
    const results = (recommender as any).venueRecommendations(
      rows,
      [{ title: "kernel storage representative paper", keywords: "", venue: "" }],
      null,
      Date.parse("2026-08-25T00:00:00Z"),
      { topN: 5 },
    );
    const ranked = results.find((result: any) => result.venueKey === "venue");
    const aggregator = results.find((result: any) => result.venueKey === "aggregator");
    expect({
      ...recommendationAxes(candidates[0]!, ranked.fit.score),
      venue_key: ranked.venueKey,
    }).toMatchObject({
      venue_key: "venue",
      research_fit: { score: expect.any(Number), categories: ["systems"] },
      venue_maturity: { status: "established", profile_status: "profiled" },
      deadline_precision: "exact",
      evidence_quality: "official",
    });
    expect({
      ...recommendationAxes(candidates[1]!, aggregator.fit.score),
      venue_key: aggregator.venueKey,
    }).toMatchObject({
      venue_maturity: { status: "new", profile_status: "unprofiled" },
      deadline_precision: "date-only",
      evidence_quality: "aggregator",
    });
  });
});
