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
    ignored_filters?: string[];
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

it("keeps exact grades effective without mixing A and A-star, and a named scale only sees that scale", () => {
  /* 2026-10-18 – 尺度の名（`CCF A`・`core:A*`）が付いていれば、その尺度の等級だけで絞る。
   * 等級だけ（`A`）はどの尺度でも当たる（画面のランク欄と同じ）。 */
  const expected: Record<string, { any: string[]; ccf: string[]; core: string[] }> = {
    "A*": { any: ["star", "dual"], ccf: [], core: ["star", "dual"] },
    A: { any: ["a"], ccf: ["a"], core: [] },
    B: { any: ["b", "dual"], ccf: ["dual"], core: ["b"] },
    C: { any: ["c"], ccf: ["c"], core: [] },
    N: { any: ["n"], ccf: [], core: [] },
  };
  for (const query of queries) {
    for (const [grade, wanted] of Object.entries(expected)) {
      const forms: Array<[string, string[]]> = [
        [grade, wanted.any],
        [`  ${grade}  `, wanted.any],
        [`CCF ${grade}`, wanted.ccf],
        [`ccf:${grade}`, wanted.ccf],
        [`core:${grade}`, wanted.core],
      ];
      const replies = calls(
        forms.map(([rank]) => ["search_deadlines", { query, scope: "all", rank }]),
      );
      replies.forEach((reply, index) => {
        const [rank, keysWanted] = forms[index] as [string, string[]];
        expect(reply.isError, rank).not.toBe(true);
        expect(keys(reply) ?? [], rank).toEqual(keysWanted);
        expect(reply.structuredContent?.total, rank).toBe(keysWanted.length);
        expect(text(reply), rank).not.toContain("知らないランク");
      });
    }
  }
});

it("retains the same rank in full-collection comparisons when the screen has no match", () => {
  for (const query of queries) {
    for (const [rank, wanted] of [
      ["B", ["b", "dual"]],
      ["core:B", ["b"]],
    ] as Array<[string, string[]]>) {
      const [screenReply, full] = calls([
        ["search_deadlines", { query, scope: "screen", rank }],
        ["search_deadlines", { query, scope: "all", rank }],
      ]);
      expect(screenReply.isError).not.toBe(true);
      expect(screenReply.structuredContent?.total).toBe(0);
      expect(screenReply.structuredContent?.scope_comparison).toEqual({
        scope: "all",
        total: wanted.length,
        matched_before_filters: 7,
        generated_at: allAt,
      });
      expect(keys(full)).toEqual(wanted);
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

it("ignores rank in venue search, and types it in recommendation", () => {
  /* 会場のランクの絞り込みは推薦には 2026-10-18 から在る（画面の推薦モードと同じ欄）。
   * 検索（search_venues）には無いので、渡されても「無視した」と名指す。
   * 推薦では文字列だけを受け、オブジェクトは型エラーにする（黙って無視しない – SPEC の方針）。 */
  const 検索 = { query: { title: "Distributed a" } };
  const [検索素, 検索ランク] = calls([
    ["search_venues", 検索],
    ["search_venues", { ...検索, rank: { ccf: "A" } }],
  ]);
  expect(検索素.isError).not.toBe(true);
  expect(検索ランク.isError).not.toBe(true);
  expect(検索ランク.structuredContent).toEqual({
    ...検索素.structuredContent,
    ignored_filters: ["rank"],
  });
  expect(text(検索ランク)).toContain("無視した絞り込み rank");

  const 推薦 = { paper: { title: "Distributed a" } };
  const [推薦素, 文字列のランク] = calls([
    ["recommend_venues", 推薦],
    ["recommend_venues", { ...推薦, rank: "A" }],
  ]);
  expect(推薦素.isError).not.toBe(true);
  expect(文字列のランク.isError).not.toBe(true);
  expect(text(文字列のランク), "文字列の rank を無視した絞り込みとして名指した").not.toContain(
    "無視した絞り込み",
  );
  expect(
    文字列のランク.structuredContent?.ignored_filters ?? [],
    "rank を今も無視している",
  ).not.toContain("rank");
  const [型違い] = calls([["recommend_venues", { ...推薦, rank: { ccf: "A" } }]]);
  expect(型違い.isError, "オブジェクトの rank を黙って受けた").toBe(true);
  expect(text(型違い), "型の直し方を書いていない").toContain("rank は文字列で指定してください");
});
