import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import R from "../site/recommender.ts";
import { callMcp, createMcpSandbox, type McpCall } from "./mcp_stdio.ts";

const papers = [
  {
    title: "GPU memory design",
    abstract: "Shared memory\nfor parallel kernels",
    keywords: "GPU, memory",
    venue: "SC",
  },
  {
    title: "分散ストレージの設計",
    abstract: "障害時も処理を継続する。\n複製を比較する。",
    keywords: "ストレージ、複製",
    venue: "FAST",
  },
  {
    title: "Network routing",
    abstract: "Packet scheduling",
    keywords: "routing",
    venue: "SIGCOMM",
  },
];
const labels = [
  ["Title", "Abstract", "Keywords", "Venue"],
  ["タイトル", "概要", "キーワード", "掲載先"],
  ["題名", "要旨", "検索語", "会議名"],
];
function block(paper: (typeof papers)[number], names: string[], colon: string) {
  return Object.values(paper)
    .map((value, index) => `${names[index]}${colon}${value}`)
    .join("\n");
}

it.each([0, 1, 2])(
  "keeps every labeled paper and its fields in order for label set %i",
  (index) => {
    for (const separator of ["\n", "\n\n"]) {
      const input = papers
        .map((paper) => block(paper, labels[index], index ? "：" : ": "))
        .join(separator);
      expect(R.parsePaperLines(input)).toEqual(papers);
      expect(R.paperWeights(R.parsePaperLines(input))).toEqual([
        { role: "primary", weight: 1 },
        { role: "reference", weight: 0.2 },
        { role: "reference", weight: 0.2 },
      ]);
    }
  },
);

it("accepts mixed title aliases without leaking fields between papers", () => {
  expect(
    R.parsePaperLines(
      "Title: First\nKeywords: GPU\n題名：第二\n概要：分散処理\nタイトル: Third\nVenue: FAST",
    ),
  ).toEqual([
    { title: "First", abstract: "", keywords: "GPU", venue: "" },
    { title: "第二", abstract: "分散処理", keywords: "", venue: "" },
    { title: "Third", abstract: "", keywords: "", venue: "FAST" },
  ]);
});

it("keeps paragraph breaks within one abstract as one paper and retains the first TXT paper", () => {
  const input = "題名：分散メモリ\n概要：第一段落。\n\n第二段落。\nキーワード：GPU";
  const expected = {
    title: "分散メモリ",
    abstract: "第一段落。\n第二段落。",
    keywords: "GPU",
    venue: "",
  };
  expect(R.parsePaperLines(input)).toEqual([expected]);
  expect(
    R.textPaperRecord(`${input}\nTitle: Reference\nAbstract: storage`, "filename.txt"),
  ).toEqual(expected);
});

it("keeps ordinary pipe and tab references and JSON arrays unchanged", () => {
  expect(R.parsePaperLines("Primary | GPU | SC\nReference\tstorage\tFAST")).toEqual([
    { title: "Primary", keywords: "GPU", venue: "SC" },
    { title: "Reference", keywords: "storage", venue: "FAST" },
  ]);
  expect(R.parsePaperLines(JSON.stringify(papers))).toEqual(papers);
});

it("retains a single paper whose abstract and keywords precede its title", () => {
  expect(
    R.parsePaperLines("Abstract: Shared memory\nKeywords: GPU\nVenue: SC\n題名：分散メモリ"),
  ).toEqual([{ title: "分散メモリ", abstract: "Shared memory", keywords: "GPU", venue: "SC" }]);
});

it("matches JSON input scores without replacing the primary with a differently themed reference", () => {
  const row = {
    conf: { key: "gpu", title: "GPU memory", scope: "parallel kernels", tags: [] },
    cats: ["hpc"],
  };
  const input = papers.map((paper, index) => block(paper, labels[index], "：")).join("\n\n");
  const parsed = R.parsePaperLines(input);
  expect(parsed).toEqual(papers);
  const canonical = R.parsePaperLines(JSON.stringify(papers));
  expect(R.scorePapers(row, parsed)).toBe(R.scorePapers(row, canonical));
  expect(R.scorePapers(row, parsed)).toBeGreaterThan(R.scorePapers(row, [...canonical].reverse()));
});

it.each(["search_venues", "recommend_venues"])(
  "preserves labeled paper batches through actual MCP %s requests",
  (tool) => {
    const root = createMcpSandbox("kamiyobi-labeled-papers-", "2030-01-01T00:00:00Z");
    const data = {
      generated_at: "2030-01-01T00:00:00Z",
      snapshot_metadata: { generated_at: "2030-01-01T00:00:00Z" },
      categories: { hpc: "高性能計算", systems: "システム", networks: "ネットワーク" },
      conferences: [
        ["gpu", "GPU memory kernels", "hpc"],
        ["storage", "Distributed storage replication", "systems"],
        ["network", "Network routing", "networks"],
      ].map(([key, title, category]) => ({
        key,
        title,
        full_name: title,
        scope: title,
        categories: [category],
        tags: [],
        editions: [
          {
            id: `${key}-2030`,
            year: 2030,
            deadlines: [{ kind: "paper", utc: "2030-02-01T00:00:00Z", tz_raw: "UTC" }],
          },
        ],
      })),
    };
    for (const path of [
      "public/catalog.json",
      "public/recommendation-index.json",
      "data/snapshot.json",
    ])
      writeFileSync(join(root, path), JSON.stringify(data));
    const field = tool === "search_venues" ? "query" : "paper";
    const batches = labels.map((names) =>
      papers.map((paper) => block(paper, names, "：")).join("\n\n"),
    );
    const longBatch = Array.from({ length: 21 }, (_, index) => ({
      ...papers[index % 3],
      title: `${papers[index % 3].title} ${index}`,
    }));
    const calls: McpCall[] = [
      [tool, { [field]: papers }],
      ...batches.map((input): McpCall => [tool, { [field]: input }]),
      [tool, { [field]: longBatch }],
      [tool, { [field]: longBatch.map((paper) => block(paper, labels[2], "：")).join("\n\n") }],
    ];
    const replies = callMcp<{
      isError?: boolean;
      structuredContent?: { input: unknown; rows: Array<{ venue_key: string }> };
    }>(root, calls);
    for (const reply of replies) {
      expect(reply.isError).not.toBe(true);
      expect(reply.structuredContent).toBeDefined();
      expect(reply.structuredContent?.rows.length).toBeGreaterThan(0);
    }
    expect(replies[0].structuredContent?.input).toEqual({ received: 3, used: 3, truncated: false });
    expect(replies[0].structuredContent?.rows[0].venue_key).toBe("gpu");
    for (const reply of replies.slice(1, 4))
      expect(reply.structuredContent).toEqual(replies[0].structuredContent);
    expect(replies[4].structuredContent?.input).toEqual({
      received: 21,
      used: 20,
      truncated: true,
    });
    expect(replies[5].structuredContent).toEqual(replies[4].structuredContent);
  },
);
