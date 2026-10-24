import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import R from "../site/recommendation.ts";
import { callMcp, createMcpSandbox, type McpCall } from "./mcp_stdio.ts";

const now = Date.UTC(2026, 8, 1);
const conferences = [
  {
    key: "fgcs",
    title: "FGCS",
    full_name: "Future Generation Computer Systems",
    categories: ["systems"],
    scope: ["parallel computing memory gpu"],
    editions: [],
  },
  {
    key: "local-ml",
    title: "国内ML研究会",
    full_name: "Machine Learning Research Workshop",
    categories: ["ai"],
    scope: ["machine learning neural network classification training inference"],
    editions: [],
  },
];
const rows = R.candidatePool([], conferences, now);
const titles = ["GPU memory management fgcs", "並列メモリ管理 fgcs"];
const paper = (title: string) => ({ title, abstract: "", keywords: "", venue: "" });
const reference = paper(
  "local-ml machine learning neural network classification training inference",
);
it.each(
  titles.flatMap((title) => [
    paper(title),
    { ...paper(title.replace(" fgcs", "")), keywords: "fgcs" },
  ]),
)(
  "preserves the primary paper's named destination despite reference venue names: $title / $keywords",
  (primary) => {
    for (const references of [[], [reference], [reference, reference, reference]]) {
      const result = R.venueRecommendations(rows, [primary, ...references], null, now, {
        fieldedLexical: true,
      });
      expect(result[0].venueKey).toBe("fgcs");
      if (references.length) expect(result.some((r) => r.venueKey === "local-ml")).toBe(true);
    }
    expect(
      R.venueRecommendations(rows, [reference, primary], null, now, { fieldedLexical: true })[0]
        .venueKey,
    ).toBe("local-ml");
  },
);

it.each(["search_venues", "recommend_venues"])(
  "%s respects primary intent through an actual MCP connection",
  (tool) => {
    const root = createMcpSandbox("kamiyobi-primary-intent-", new Date(now).toISOString());
    const data = {
      generated_at: new Date(now).toISOString(),
      conferences,
      categories: { systems: "システム", ai: "人工知能" },
    };
    for (const path of [
      "data/snapshot.json",
      "public/catalog.json",
      "public/recommendation-index.json",
    ])
      writeFileSync(join(root, path), JSON.stringify(data));
    const field = tool === "search_venues" ? "query" : "paper";
    const calls: McpCall[] = titles.flatMap((title) => {
      const primary = paper(title);
      return [
        [tool, { [field]: [primary, reference], limit: 1 }],
        [tool, { [field]: JSON.stringify([primary, reference]), limit: 1 }],
        [tool, { [field]: [reference, primary], limit: 1 }],
      ] as McpCall[];
    });
    const replies = callMcp<{
      isError?: boolean;
      structuredContent: {
        candidate_venues: number;
        input: unknown;
        rows: Array<{ rank: number; venue_key: string }>;
      };
    }>(root, calls);
    for (const [index, reply] of replies.entries()) {
      expect(reply.isError).not.toBe(true);
      expect(reply.structuredContent.candidate_venues).toBe(2);
      expect(reply.structuredContent.input).toEqual({ received: 2, used: 2, truncated: false });
      expect(reply.structuredContent.rows).toHaveLength(1);
      expect(reply.structuredContent.rows[0]).toMatchObject({
        rank: 1,
        venue_key: index % 3 === 2 ? "local-ml" : "fgcs",
      });
    }
  },
);

it.each(titles)(
  "keeps the shared recommendation order in the compiled screen filter: %s",
  async (title) => {
    const { runInNewContext } = await import("node:vm");
    const { jsFunction, siteRuntime } = await import("./runtime_extract.ts");
    const app = siteRuntime();
    const papers = [paper(title), reference];
    const input = JSON.stringify(papers);
    class Clock extends Date {
      static now() {
        return now;
      }
    }
    const context = {
      Date: Clock,
      DAY: 86400000,
      Recommender: R,
      document: {},
      $: () => ({ value: input }),
      rows: [],
      activeData: { conferences },
      state: { mode: "recommend", q: "", cats: [], win: "all" },
      semQuery: null,
      semEmbeddings: null,
      sortAsc: true,
      sortKey: "time",
      searchQuery: "",
      截つた行: 0,
      venueLookupMiss: [],
      recommendationCandidateCount: 0,
      hiddenCounts: {},
      catFacetCounts: {},
    };
    const filter = runInNewContext(
      [
        jsFunction(app, "windowLimitMs"),
        jsFunction(app, "windowFloorMs"),
        `(${jsFunction(app, "filter")})`,
      ].join("\n"),
      context,
    );
    const shown = filter() as Array<{ conf: { key: string }; _matchScore: number }>;
    const shared = R.venueRecommendations(rows, papers, null, now, {
      fieldedLexical: true,
      venueCats: R.autoDetectCats(papers),
      semanticSimilarities: null,
    }).filter((r) => r.fit.score >= 10);
    expect(shared[0].venueKey).toBe("fgcs");
    expect(shared[0].fit.score).toBeLessThan(shared[1].fit.score);
    expect(shown.map((r) => r.conf.key)).toEqual(shared.map((r) => r.venueKey));
    expect(shown.map((r) => r._matchScore)).toEqual(shared.map((r) => r.fit.score));
  },
);
