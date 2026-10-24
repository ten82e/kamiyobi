import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import R from "../site/recommender.ts";
import { callMcp, createMcpSandbox, type McpCall } from "./mcp_stdio.ts";

const papers = [
  { title: "分散メモリの設計", keywords: "", venue: "SC" },
  { title: "Network routing", keywords: "routing", venue: "" },
  { title: "分散ストレージ", keywords: "", venue: "" },
];
const tsv = papers.map((paper) => [paper.title, paper.keywords, paper.venue].join("\t")).join("\n");
it.each(["\n", "\r\n"])(
  "preserves empty TSV cells and row order with %j line endings",
  (ending) => {
    expect(R.parsePaperLines(tsv.replaceAll("\n", ending))).toEqual(papers);
    expect(R.paperWeights(R.parsePaperLines(tsv))).toEqual([
      { role: "primary", weight: 1 },
      { role: "reference", weight: 0.2 },
      { role: "reference", weight: 0.2 },
    ]);
  },
);
it("does not promote metadata from a blank title cell into a paper title", () => {
  expect(R.parsePaperLines(`\tGPU\tSC\n${tsv}\n　\t\tFAST\n\t\t`)).toEqual(papers);
});
it("trims cell whitespace while preserving the positions of blank cells", () => {
  expect(
    R.parsePaperLines("　論文名　\t　\t SC \n\t GPU \t FAST \nEnglish title\t keywords \t "),
  ).toEqual([
    { title: "論文名", keywords: "", venue: "SC" },
    { title: "English title", keywords: "keywords", venue: "" },
  ]);
});
it("keeps ordinary pipe references, labeled records and JSON input intact", () => {
  expect(
    R.parsePaperLines("分散メモリの設計 | | SC\nNetwork routing | routing |\n分散ストレージ | | "),
  ).toEqual(papers);
  expect(R.parsePaperLines(JSON.stringify(papers))).toEqual(
    papers.map((paper) => ({ ...paper, abstract: "" })),
  );
  expect(R.parsePaperLines("題名：論文名\n概要：日本語の概要\n掲載先：SC")).toEqual([
    { title: "論文名", abstract: "日本語の概要", keywords: "", venue: "SC" },
  ]);
});

it.each(["search_venues", "recommend_venues"])(
  "%s keeps TSV columns through the actual MCP connection",
  (tool) => {
    const root = createMcpSandbox("kamiyobi-tsv-papers-", "2030-01-01T00:00:00Z");
    const data = {
      generated_at: "2030-01-01T00:00:00Z",
      snapshot_metadata: { generated_at: "2030-01-01T00:00:00Z" },
      categories: { hpc: "高性能計算", networks: "ネットワーク" },
      conferences: [
        {
          key: "sc",
          title: "SC",
          full_name: "High Performance Computing",
          scope: "GPU memory",
          categories: ["hpc"],
          tags: [],
          editions: [],
        },
        {
          key: "sigcomm",
          title: "SIGCOMM",
          full_name: "Network routing",
          scope: "Network routing",
          categories: ["networks"],
          tags: [],
          editions: [],
        },
      ],
    };
    for (const path of [
      "data/snapshot.json",
      "public/catalog.json",
      "public/recommendation-index.json",
    ])
      writeFileSync(join(root, path), JSON.stringify(data));
    const field = tool === "search_venues" ? "query" : "paper";
    const rows = [
      { title: "GPU memory management", keywords: "", venue: "SC" },
      ...papers.slice(1),
    ];
    const input = rows
      .map((paper) => [paper.title, paper.keywords, paper.venue].join("\t"))
      .join("\r\n");
    const requests: McpCall[] = [
      [tool, { [field]: rows }],
      [tool, { [field]: input }],
      [tool, { [field]: `\tGPU\tSIGCOMM\r\n${input}\r\n\t\tSC\r\n` }],
      [tool, { [field]: `\t[GPU]\tSIGCOMM\r\n${input}` }],
      [tool, { [field]: `\t{GPU}\tSIGCOMM\r\n${input}` }],
    ];
    const replies = callMcp<{
      isError?: boolean;
      structuredContent?: { input: unknown; rows: Array<{ venue_key: string }> };
    }>(root, requests);
    for (const reply of replies) {
      expect(reply.isError).not.toBe(true);
      expect(reply.structuredContent?.input).toEqual({ received: 3, used: 3, truncated: false });
      expect(reply.structuredContent?.rows.length).toBeGreaterThan(0);
    }
    for (const reply of replies.slice(1))
      expect(reply.structuredContent).toEqual(replies[0].structuredContent);
  },
);
