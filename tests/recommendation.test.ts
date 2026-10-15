import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recommendationAxes } from "../site/recommendation-core.ts";
import recommender from "../site/recommender.ts";
import {
  ROOT as BUILD_ROOT,
  setRoot as setBuildRoot,
  toCatalog,
  toRecommendationIndex,
} from "../src/build.ts";
import { tempWork } from "./helpers.ts";

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
    // 画面に出る語は「一致評価」で統一した（第 104 回まで、カードの頭のチップは
    // 「一致評価」、その下の行は「研究適合度」と、同じ値に二つの名前を付けていた）。
    // 順位の形であって確率ではない、という型はそのまま保つ。
    const app = readFileSync(new URL("../site/app.ts", import.meta.url), "utf8");
    expect(app).toMatch(/一致評価 \$\{r\._fitLabel \|\| "評価保留"\}/);
    expect(app).not.toMatch(/一致評価[^\n]*%/);
    expect(app).not.toContain("研究適合度");
  });

  it("returns independent research fit, venue records, and deadline trust", () => {
    expect(recommendationAxes(conference(), 82, NOW)).toMatchObject({
      research_fit: { score: 82, categories: ["systems"], tags: [] },
      venue_evidence: {
        yearsObserved: 4,
        dblpLinked: true,
        publisherSource: true,
        rankListed: true,
        profileCoverage: 2,
      },
      deadline_precision: "exact",
      deadline_trust: {
        date: "official",
        time: "official",
        timezone: "official",
        kind: "official",
        sourceFreshness: "unknown",
        conflicts: 0,
      },
      evidence_quality: "official",
    });
  });

  it("reports two recorded years and one sample without inferring maturity", () => {
    const value = conference({
      dblp: null,
      rank: {},
      papers: ["One paper"],
      editions: [
        { year: 2025, estimated: false, deadlines: [] },
        { year: 2026, estimated: false, deadlines: [] },
      ],
    });
    expect(recommendationAxes(value, null, NOW).venue_evidence).toMatchObject({
      yearsObserved: 2,
      profileCoverage: 1,
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
      ).venue_evidence.publisherSource,
    ).toBe(true);
  });

  it("distinguishes sparse records from absent records without assigning age", () => {
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
      venue_evidence: { yearsObserved: 1, profileCoverage: 0 },
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
      venue_evidence: { yearsObserved: 0, profileCoverage: 0 },
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

    expect(
      recommendationAxes(
        conference({
          dblp: null,
          rank: {},
          papers: [],
          editions: [
            {
              year: 2027,
              sourceFreshness: "fresh",
              deadlines: [
                {
                  kind: "paper",
                  precision: "exact",
                  utc: "2027-01-02T23:59:00.000Z",
                  evidence: [
                    {
                      source_class: "official-cfp",
                      verified_fields: ["date", "time", "timezone", "kind"],
                    },
                  ],
                },
              ],
            },
          ],
        }),
        null,
        NOW,
      ).deadline_trust.date,
    ).toBe("official");
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
      editions: [
        {
          year: 2027,
          deadlines: [
            {
              kind: "paper",
              precision: "date-only",
              local_date: "2027-01-02",
              evidence: [{ sourceClass: "assumption", verifiedFields: ["date"] }],
              origins: [
                {
                  source: "ccfddl",
                  revision: null,
                  fetchedAt: null,
                  freshness: "snapshot-fallback",
                },
              ],
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

  it("uses the highest-trust displayed-deadline origin before snapshot auxiliaries", () => {
    const value = conference({
      editions: [
        {
          year: 2027,
          deadlines: [
            {
              kind: "paper",
              precision: "date-only",
              local_date: "2027-01-02",
              origins: [
                { source: "official", sourceClass: "official-cfp", freshness: "fresh" },
                {
                  source: "ccfddl",
                  sourceClass: "aggregator",
                  freshness: "snapshot-fallback",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(recommendationAxes(value, 7, NOW).deadline_trust.sourceFreshness).toBe("fresh");
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
      venue_evidence: { yearsObserved: 4, profileCoverage: 2 },
      deadline_trust: { date: "official", sourceFreshness: "unknown" },
    });
  });

  /* 締切画面が最初に読む catalog にも同じ軸を載せる。此処が推薦索引と食ひ違ふと、
   * 畫面のカードと MCP が**同じ噓**を付く（順位の元にした論文數と、カードの「論文サンプル」が
   * 違ふ）。實測 2026-10-15: catalog は `papers` を載せない為に `profileCoverage` が 0 に
   * 固まり、23 会議が推薦索引（8件）と不一致だつた。catalog は papers を載せない侭、
   * 數へる時だけ正本を見る。 */
  it("counts paper samples in the catalog axes without publishing the titles", () => {
    const data = {
      generated_at: "2026-08-25T00:00:00.000Z",
      site: {},
      sources: [],
      categories: {},
      conferences: [conference()],
    };
    const at = new Date("2026-08-25T00:00:00.000Z");
    const catalog = toCatalog(data, at) as { conferences: Array<Record<string, unknown>> };
    const index = toRecommendationIndex(data, at) as {
      conferences: Array<Record<string, unknown>>;
    };
    const entry = catalog.conferences[0]!;
    expect(entry.recommendation_axes).toMatchObject({
      venue_evidence: { yearsObserved: 4, profileCoverage: 2 },
    });
    // 推薦索引と同じ軸（此処が割れると畫面と AI が違ふ数を言ふ）。
    expect((entry.recommendation_axes as Record<string, unknown>).venue_evidence).toEqual(
      (index.conferences[0]!.recommendation_axes as Record<string, unknown>).venue_evidence,
    );
    // catalog は題名を載せない（data.json と推薦索引が正本）。
    expect(entry).not.toHaveProperty("papers");
  });

  it("fails closed when the reranker artifact cannot be parsed", () => {
    const root = tempWork("kamiyobi-reranker-artifact-");
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const artifact = join(dataDir, "recommender-reranker.json");
    writeFileSync(artifact, "{invalid", "utf8");
    const originalRoot = BUILD_ROOT;
    setBuildRoot(root);
    try {
      expect(() =>
        toRecommendationIndex({ conferences: [] }, new Date("2026-08-25T00:00:00Z")),
      ).toThrow(artifact);
    } finally {
      setBuildRoot(originalRoot);
    }
  });

  it("fails closed when the reranker artifact violates its numeric contract", () => {
    const root = tempWork("kamiyobi-reranker-contract-");
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const model = JSON.parse(
      readFileSync(join(BUILD_ROOT, "data", "recommender-reranker.json"), "utf8"),
    );
    writeFileSync(
      join(dataDir, "recommender-reranker.json"),
      JSON.stringify({ ...model, blend: 2 }),
      "utf8",
    );
    const originalRoot = BUILD_ROOT;
    setBuildRoot(root);
    try {
      expect(() =>
        toRecommendationIndex({ conferences: [] }, new Date("2026-08-25T00:00:00Z")),
      ).toThrow("model contract is invalid");
    } finally {
      setBuildRoot(originalRoot);
    }
  });

  it("propagates source fallback and does not count the N rank sentinel", () => {
    const index = toRecommendationIndex(
      {
        generated_at: "2026-08-25T00:00:00.000Z",
        site: {},
        sources: [],
        categories: {},
        conferences: [
          conference({
            sources: ["ccfddl"],
            rank: { ccf: "N" },
            editions: [
              {
                year: 2027,
                source: "ccfddl",
                deadlines: [
                  {
                    kind: "paper",
                    precision: "exact",
                    utc: "2027-01-02T23:59:00.000Z",
                    evidence: [{ sourceClass: "official-cfp", verifiedFields: ["date"] }],
                  },
                ],
              },
            ],
          }),
        ],
      },
      new Date(NOW),
      { ccfddl: "snapshot-fallback" },
    );
    const published = (index.conferences as Array<Record<string, any>>)[0]!;
    expect(published.recommendation_axes).toMatchObject({
      venue_evidence: { rankListed: false },
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

  it("keeps date-only deadlines on the same calendar day as uncertain rather than none (#764)", () => {
    const value = conference({
      editions: [
        {
          year: 2026,
          deadlines: [
            {
              precision: "date-only",
              local_date: "2026-08-25",
              evidence: [{ sourceClass: "aggregator", verifiedFields: ["date"] }],
            },
          ],
        },
      ],
    });
    expect(
      recommendationAxes(value, null, Date.parse("2026-08-25T18:00:00Z")).deadline_precision,
    ).toBe("date-only");
    expect(
      recommendationAxes(value, null, Date.parse("2026-08-26T11:59:59.999Z")).deadline_precision,
    ).toBe("date-only");
    expect(
      recommendationAxes(value, null, Date.parse("2026-08-26T12:00:00Z")).deadline_precision,
    ).toBe("none");
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

  it("recognizes exact deadlines using at_utc without utc field", () => {
    const value = conference({
      editions: [
        {
          year: 2027,
          deadlines: [
            {
              precision: "exact",
              at_utc: "2027-02-15T23:59:00.000Z",
              evidence: [{ sourceClass: "official-cfp", verifiedFields: ["date"] }],
            },
          ],
        },
      ],
    });
    expect(recommendationAxes(value, null, NOW)).toMatchObject({
      deadline_precision: "exact",
    });
  });

  it("reports listed rankings and identity.dblpKey without assigning maturity", () => {
    const value = conference({
      dblp: null,
      identity: { dblpKey: "conf/test" },
      rank: undefined,
      rankings: { ccf: "A" },
      papers: ["One", "Two"],
      editions: [{ year: 2024 }, { year: 2025 }, { year: 2026 }],
    });
    const axes = recommendationAxes(value, null, NOW);
    expect(axes.venue_evidence.dblpLinked).toBe(true);
    expect(axes.venue_evidence.rankListed).toBe(true);
    expect(axes).not.toHaveProperty("venue_maturity");
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
      venue_evidence: { yearsObserved: 4 },
      deadline_trust: { date: "official" },
    });
    expect({
      ...recommendationAxes(candidates[1]!, aggregator.fit.score, NOW),
      venue_key: aggregator.venueKey,
    }).toMatchObject({
      venue_key: "aggregator",
      venue_evidence: { yearsObserved: 1, profileCoverage: 0 },
      deadline_precision: "date-only",
      deadline_trust: { date: "aggregator", time: "unverified" },
    });
  });

  it("keeps date-only local_date and exact at_utc rows without utc fields (#772)", () => {
    const rows = (recommender as any).candidateRows({
      conferences: [
        {
          key: "date-only-venue",
          title: "Date Only Venue",
          categories: ["systems"],
          editions: [
            {
              year: 2026,
              deadlines: [{ kind: "paper", precision: "date-only", local_date: "2026-08-09" }],
            },
          ],
        },
        {
          key: "exact-venue",
          title: "Exact Venue",
          categories: ["systems"],
          editions: [
            {
              year: 2026,
              deadlines: [
                { kind: "paper", precision: "exact", at_utc: "2026-12-01T23:59:00.000Z" },
              ],
            },
          ],
        },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      dateOnly: true,
      localDate: "2026-08-09",
      t: Date.parse("2026-08-08T10:00:00.000Z"),
      tLast: Date.parse("2026-08-10T11:59:59.999Z"),
    });
    expect(rows[1].t).toBe(Date.parse("2026-12-01T23:59:00.000Z"));
    expect(rows[1].tLast).toBe(rows[1].t);
  });

  it("preserves explicit zero-valued bounds and rejects invalid date-only fallback dates", () => {
    const rows = (recommender as any).candidateRows({
      conferences: [
        {
          key: "bounds",
          title: "Bounds",
          editions: [
            {
              year: 1970,
              deadlines: [
                {
                  kind: "paper",
                  precision: "date-only",
                  local_date: "1970-01-01",
                  earliest_utc: "1970-01-01T00:00:00Z",
                  latest_utc: "1970-01-01T00:00:00Z",
                },
                { kind: "paper", precision: "date-only", local_date: "2026-02-30" },
                { kind: "paper", precision: "date-only", local_date: "not-a-date" },
              ],
            },
          ],
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ t: 0, tLast: 0 });
  });

  it("does not prioritize unparseable deadlineTime ahead of earlier parseable deadlines in recommendationAxes", () => {
    const conf = {
      key: "sort-order-test",
      title: "Sort Order Test",
      categories: ["systems"],
      editions: [
        {
          year: 2026,
          deadlines: [
            {
              kind: "paper",
              precision: "exact",
              utc: "2026-09-01T23:59:00.000Z",
              evidence: [{ sourceClass: "official", verifiedFields: ["date"] }],
            },
          ],
        },
        {
          year: 2027,
          deadlines: [
            {
              kind: "paper",
              precision: "exact",
              // latest_utc makes it future, but utc is unparseable
              latest_utc: "2027-09-01T23:59:00.000Z",
              utc: "unparseable-date",
              evidence: [{ sourceClass: "official", verifiedFields: ["date"] }],
            },
          ],
        },
      ],
    };
    const axes = recommendationAxes(conf, 70, NOW);
    // 2026 deadline is the true earliest future deadline; unparseable 2027 should NOT jump ahead as epoch 0
    expect(axes.deadline_precision).toBe("exact");
    expect(axes.deadline_trust.date).toBe("official");
  });
});
