import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recommendationAxes } from "../site/recommendation-core.ts";
import recommender from "../site/recommender.ts";
import { toRecommendationIndex } from "../src/build.ts";

const NOW = Date.parse("2026-08-25T00:00:00Z");

function conference(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "venue",
    title: "Venue",
    categories: ["systems"],
    tags: [],
    dblp: "venue",
    rank: { ccf: "A" },
    papers: ["Representative paper", "Second representative paper"],
    editions: [
      { year: 2024, estimated: false, deadlines: [] },
      { year: 2025, estimated: false, deadlines: [] },
      { year: 2026, estimated: false, deadlines: [] },
      {
        year: 2027,
        estimated: false,
        deadlines: [
          {
            kind: "paper",
            precision: "exact",
            utc: "2027-01-02T23:59:00.000Z",
            evidence: [
              {
                sourceClass: "official-cfp",
                verifiedFields: ["date", "time", "timezone", "kind"],
              },
              { sourceClass: "publisher", verifiedFields: ["date"] },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("recommendation axes", () => {
  it("labels research fit as an ordinal assessment rather than a probability", () => {
    const app = readFileSync(new URL("../site/app.ts", import.meta.url), "utf8");
    expect(app).toMatch(/研究適合度: \$\{r\._fitLabel \|\| "評価保留"\}（順位評価）/);
    expect(app).not.toMatch(/研究適合度:[^\n]*%/);
  });

  it("returns independent research fit, established maturity evidence, and deadline trust", () => {
    expect(recommendationAxes(conference(), 82, NOW)).toMatchObject({
      research_fit: { score: 82, categories: ["systems"], tags: [] },
      venue_maturity: {
        status: "established",
        profile_status: "profiled",
        evidence: {
          yearsObserved: 4,
          dblpIndexed: true,
          publisherVerified: true,
          ranked: true,
          profileCoverage: 2,
        },
      },
      deadline_precision: "exact",
      deadline_trust: {
        date: "official",
        time: "official",
        timezone: "official",
        kind: "official",
        sourceFreshness: "fresh",
        conflicts: 0,
      },
      evidence_quality: "official",
    });
  });

  it("does not call two editions or one paper established", () => {
    const value = conference({
      dblp: null,
      rank: {},
      papers: ["One paper"],
      editions: [
        { year: 2025, estimated: false, deadlines: [] },
        { year: 2026, estimated: false, deadlines: [] },
      ],
    });
    expect(recommendationAxes(value, null, NOW).venue_maturity).toMatchObject({
      status: "emerging",
      evidence: { yearsObserved: 2, profileCoverage: 1 },
    });
    expect(
      recommendationAxes(
        conference({
          dblp: null,
          rank: {},
          papers: [],
          evidence: [],
          editions: [{ year: 2026, source: "publisher", deadlines: [] }],
        }),
        null,
        NOW,
      ).venue_maturity.evidence.publisherVerified,
    ).toBe(true);
  });

  it("distinguishes new and unverified venues", () => {
    expect(
      recommendationAxes(
        conference({
          dblp: null,
          rank: {},
          papers: [],
          editions: [
            {
              year: 2027,
              deadlines: [
                {
                  precision: "date-only",
                  local_date: "2027-01-02",
                  evidence: [{ sourceClass: "aggregator", verifiedFields: ["date"] }],
                },
              ],
            },
          ],
        }),
        null,
        NOW,
      ),
    ).toMatchObject({
      venue_maturity: { status: "new", profile_status: "unprofiled" },
      deadline_precision: "date-only",
      deadline_trust: {
        date: "aggregator",
        time: "unverified",
        timezone: "unverified",
        kind: "unverified",
      },
      evidence_quality: "aggregator",
    });

    expect(
      recommendationAxes(
        conference({ dblp: null, rank: {}, papers: [], editions: [], evidence: [] }),
        null,
        NOW,
      ),
    ).toMatchObject({
      venue_maturity: { status: "unverified" },
      deadline_precision: "none",
      deadline_trust: {
        date: "unverified",
        time: "unverified",
        timezone: "unverified",
        kind: "unverified",
      },
      evidence_quality: "none",
    });
  });

  it("uses only evidence that verifies each deadline field", () => {
    const value = conference({
      dblp: null,
      rank: {},
      papers: [],
      editions: [
        {
          year: 2027,
          sourceFreshness: "cache-fallback",
          deadlines: [
            {
              kind: "paper",
              precision: "exact",
              utc: "2027-01-02T23:59:00.000Z",
              conflicts: [{ sourceClass: "aggregator" }, { sourceClass: "publisher" }],
              evidence: [
                { sourceClass: "official-cfp", verifiedFields: ["date"] },
                { sourceClass: "publisher", verifiedFields: ["time"] },
                { sourceClass: "curated-manual", verifiedFields: ["timezone"] },
                { sourceClass: "aggregator", verifiedFields: ["kind"] },
                { sourceClass: "official-cfp", verifiedFields: ["date"] },
              ],
            },
          ],
        },
      ],
    });
    expect(recommendationAxes(value, null, NOW).deadline_trust).toEqual({
      date: "official",
      time: "publisher",
      timezone: "curated-manual",
      kind: "aggregator",
      sourceFreshness: "cache-fallback",
      conflicts: 2,
    });
    expect(recommendationAxes(value, null, NOW).evidence_quality).toBe("official");
  });

  it("does not let an unscoped official evidence make every field official", () => {
    const value = conference({
      dblp: null,
      rank: {},
      papers: [],
      editions: [
        {
          year: 2027,
          deadlines: [
            {
              kind: "paper",
              precision: "exact",
              utc: "2027-01-02T23:59:00.000Z",
              evidence: [{ sourceClass: "official-cfp" }],
            },
          ],
        },
      ],
    });
    expect(recommendationAxes(value, null, NOW).deadline_trust).toMatchObject({
      date: "unverified",
      time: "unverified",
      timezone: "unverified",
      kind: "unverified",
    });
  });

  it("keeps source fallback and conflict trust independent of research ranking", () => {
    const value = conference({
      sourceFreshness: "snapshot-fallback",
      editions: [
        {
          year: 2027,
          deadlines: [
            {
              kind: "paper",
              precision: "date-only",
              local_date: "2027-01-02",
              evidence: [{ sourceClass: "assumption", verifiedFields: ["date"] }],
              conflicts: [{ sourceClass: "aggregator" }],
            },
          ],
        },
      ],
    });
    const axes = recommendationAxes(value, 7, NOW);
    expect(axes.research_fit.score).toBe(7);
    expect(axes.deadline_trust).toMatchObject({
      date: "assumption",
      sourceFreshness: "snapshot-fallback",
      conflicts: 1,
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
      venue_maturity: { status: "established", evidence: { yearsObserved: 4 } },
      deadline_trust: { date: "official", sourceFreshness: "fresh" },
    });
  });

  it("propagates source fallback and does not count the N rank sentinel", () => {
    const index = toRecommendationIndex(
      {
        generated_at: "2026-08-25T00:00:00.000Z",
        site: {},
        sources: [],
        categories: {},
        conferences: [conference({ sources: ["ccfddl"], rank: { ccf: "N" } })],
      },
      new Date(NOW),
      { ccfddl: "snapshot-fallback" },
    );
    const published = (index.conferences as Array<Record<string, any>>)[0]!;
    expect(published.recommendation_axes).toMatchObject({
      venue_maturity: { evidence: { ranked: false } },
      deadline_trust: { sourceFreshness: "snapshot-fallback" },
    });
  });

  it("uses the next target deadline rather than older official history", () => {
    const value = conference({
      editions: [
        {
          year: 2025,
          deadlines: [
            {
              precision: "exact",
              utc: "2025-01-01T00:00:00Z",
              evidence: [{ sourceClass: "official-cfp", verifiedFields: ["date"] }],
            },
          ],
        },
        {
          year: 2027,
          deadlines: [
            {
              precision: "date-only",
              local_date: "2027-01-02",
              evidence: [{ sourceClass: "aggregator", verifiedFields: ["date"] }],
            },
          ],
        },
      ],
    });
    expect(recommendationAxes(value, null, NOW)).toMatchObject({
      deadline_precision: "date-only",
      deadline_trust: { date: "aggregator" },
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
              evidence: [{ sourceClass: "official-cfp", verifiedFields: ["date"] }],
            },
            {
              precision: "date-only",
              local_date: "2027-01-02",
              evidence: [{ sourceClass: "aggregator", verifiedFields: ["date"] }],
            },
          ],
        },
      ],
    });
    expect(recommendationAxes(value, null, NOW)).toMatchObject({
      deadline_precision: "date-only",
      deadline_trust: { date: "aggregator" },
      evidence_quality: "aggregator",
    });
  });

  it("keeps trust axes independent for each ranked recommendation", () => {
    const candidates = [
      conference(),
      conference({
        key: "aggregator",
        title: "Kernel storage aggregator venue",
        dblp: null,
        rank: {},
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
                evidence: [{ sourceClass: "aggregator", verifiedFields: ["date"] }],
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
      NOW,
      { topN: 5 },
    );
    const ranked = results.find((result: any) => result.venueKey === "venue");
    const aggregator = results.find((result: any) => result.venueKey === "aggregator");
    expect({
      ...recommendationAxes(candidates[0]!, ranked.fit.score, NOW),
      venue_key: ranked.venueKey,
    }).toMatchObject({
      venue_key: "venue",
      research_fit: { score: expect.any(Number), categories: ["systems"] },
      venue_maturity: { status: "established" },
      deadline_trust: { date: "official" },
    });
    expect({
      ...recommendationAxes(candidates[1]!, aggregator.fit.score, NOW),
      venue_key: aggregator.venueKey,
    }).toMatchObject({
      venue_key: "aggregator",
      venue_maturity: { status: "new", profile_status: "unprofiled" },
      deadline_precision: "date-only",
      deadline_trust: { date: "aggregator", time: "unverified" },
    });
  });
});
