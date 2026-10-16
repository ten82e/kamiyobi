import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { callMcp, createMcpSandbox, type McpCall } from "./mcp_stdio.ts";

const root = createMcpSandbox("kamiyobi-mcp-rank-inputs-", "2030-01-01T00:00:00Z");
const screenAt = "2029-12-31T12:00:00Z",
  allAt = "2029-12-31T06:00:00Z";
const definitions: Array<[string, Record<string, string>]> = [
  ["star", { core: "A*" }],
  ["a", { ccf: "A" }],
  ["b", { core: "B" }],
  ["c", { ccf: "C" }],
  ["n", { thcpl: "N" }],
  ["unranked", {}],
  ["dual", { core: "A*", ccf: "B" }],
];
const conferences = definitions.map(([key, rank], i) => ({
  key,
  rank,
  title: `Distributed ${key}`,
  full_name: `分散システム ${key}`,
  categories: ["systems"],
  tags: [],
  editions: [
    {
      id: `${key}-2030`,
      year: 2030,
      estimated: false,
      deadlines: [{ kind: "paper", utc: `2030-01-0${i + 2}T00:00:00Z`, tz_raw: "UTC" }],
    },
  ],
}));
const screen = conferences.filter((conf) => ["a", "c", "unranked"].includes(conf.key));
writeFileSync(
  join(root, "public/catalog.json"),
  JSON.stringify({ generated_at: screenAt, conferences: screen }),
);
writeFileSync(
  join(root, "data/snapshot.json"),
  JSON.stringify({ snapshot_metadata: { generated_at: allAt }, conferences }),
);
writeFileSync(
  join(root, "public/recommendation-index.json"),
  JSON.stringify({ generated_at: allAt, categories: { systems: "Systems" }, conferences }),
);
interface Reply {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent?: {
    total?: number;
    scope?: string;
    generated_at?: string;
    candidate_venues?: number;
    rows?: Array<{ venue_key: string }>;
    scope_comparison?: {
      scope: string;
      total: number;
      matched_before_filters: number;
      generated_at: string;
    };
  };
}
const calls = (requests: McpCall[]) => callMcp<Reply>(root, requests);
const text = (r: Reply) => r.content.map((part) => part.text).join("\n");
const keys = (r: Reply) => r.structuredContent?.rows?.map((row) => row.venue_key);
const queries = ["Distributed", "分散システム"];

it("rejects rank containers and recovers to the exact grade on the same MCP connection", () => {
  for (const query of [...queries, ""])
    for (const scope of ["screen", "all"]) {
      const args = { query, scope, rank: "A" };
      const requests: McpCall[] = [["search_deadlines", args]];
      for (const rank of [[], ["A"], [["A"]], ["A", "B"], {}, { ccf: "A" }])
        requests.push(["search_deadlines", { ...args, rank }], ["search_deadlines", args]);
      const [baseline, ...replies] = calls(requests);
      expect(baseline.isError).not.toBe(true);
      expect(keys(baseline)).toEqual(["a"]);
      for (let i = 0; i < replies.length; i += 2) {
        expect(replies[i].isError).toBe(true);
        expect(replies[i].structuredContent).toBeUndefined();
        expect(text(replies[i])).toContain("rank は文字列で指定してください");
        expect(text(replies[i])).toContain("CCF A");
        expect(text(replies[i])).not.toContain("[object Object]");
        expect(replies[i + 1]).toEqual(baseline);
      }
    }
});

it("keeps exact grades and displayed scale labels effective without mixing A and A-star", () => {
  const expected: Record<string, string[]> = {
    "A*": ["star", "dual"],
    A: ["a"],
    B: ["b", "dual"],
    C: ["c"],
    N: ["n"],
  };
  for (const query of queries) {
    for (const [grade, wanted] of Object.entries(expected)) {
      const ranks = [grade, `CCF ${grade}`, `core:${grade}`, `  ${grade}  `];
      const replies = calls(
        ranks.map((rank) => ["search_deadlines", { query, scope: "all", rank }]),
      );
      for (const reply of replies) {
        expect(reply.isError).not.toBe(true);
        expect(keys(reply)).toEqual(wanted);
        expect(reply.structuredContent?.total).toBe(wanted.length);
        expect(text(reply)).not.toContain("知らないランク");
      }
    }
  }
});

it("retains the same rank in full-collection comparisons when the screen has no match", () => {
  for (const query of queries) {
    for (const rank of ["B", "THCPL B", "core:B"]) {
      const [screenReply, full] = calls([
        ["search_deadlines", { query, scope: "screen", rank }],
        ["search_deadlines", { query, scope: "all", rank }],
      ]);
      expect(screenReply.isError).not.toBe(true);
      expect(screenReply.structuredContent?.total).toBe(0);
      expect(screenReply.structuredContent?.scope_comparison).toEqual({
        scope: "all",
        total: 2,
        matched_before_filters: 7,
        generated_at: allAt,
      });
      expect(keys(full)).toEqual(["b", "dual"]);
      expect(full.structuredContent?.generated_at).toBe(allAt);
    }
  }
});

it("preserves unknown scalar grades, empty ranks and the no-query guidance", () => {
  for (const query of queries) {
    const [baseline, ...replies] = calls([
      ["search_deadlines", { query, scope: "all" }],
      ...[null, "", "   "].map(
        (rank) => ["search_deadlines", { query, scope: "all", rank }] as McpCall,
      ),
      ...["D", "a", 1, true].map(
        (rank) => ["search_deadlines", { query, scope: "all", rank }] as McpCall,
      ),
    ]);
    expect(keys(baseline)).toEqual(["star", "a", "b", "c", "n", "unranked", "dual"]);
    for (const reply of replies.slice(0, 3)) {
      expect(reply.isError).not.toBe(true);
      expect(reply.structuredContent).toEqual(baseline.structuredContent);
      expect(text(reply)).not.toContain("知らないランク");
    }
    for (const reply of replies.slice(3)) {
      expect(reply.isError).not.toBe(true);
      expect(keys(reply)).toEqual([]);
      expect(text(reply)).toContain("知らないランク");
    }
  }
  const [empty, filterOnly] = calls([
    ["search_deadlines", {}],
    ["search_deadlines", { scope: "all", rank: "A" }],
  ]);
  expect(empty.structuredContent).toBeUndefined();
  expect(text(empty)).toContain("検索語が空です");
  expect(keys(filterOnly)).toEqual(["a"]);
});

it("continues to ignore unused rank arguments in venue search and recommendation", () => {
  for (const tool of ["search_venues", "recommend_venues"]) {
    const args = { [tool === "search_venues" ? "query" : "paper"]: { title: "Distributed a" } };
    const [baseline, extra] = calls([
      [tool, args],
      [tool, { ...args, rank: { ccf: "A" } }],
    ]);
    expect(baseline.isError).not.toBe(true);
    expect(extra.isError).not.toBe(true);
    expect(extra.structuredContent).toEqual({
      ...baseline.structuredContent,
      ignored_filters: ["rank"],
    });
    expect(extra.structuredContent?.candidate_venues).toBe(7);
    expect(text(extra)).toContain("無視した絞り込み rank");
  }
});
