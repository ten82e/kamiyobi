import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { callMcp, createMcpSandbox, type McpCall } from "./mcp_stdio.ts";

const root = createMcpSandbox("kamiyobi-encoded-papers-", "2030-01-01T00:00:00Z");
const data = {
  generated_at: "2030-01-01T00:00:00Z",
  snapshot_metadata: { generated_at: "2030-01-01T00:00:00Z" },
  categories: { systems: "システム", networks: "ネットワーク" },
  conferences: [
    ["gpu", "GPU memory management", "systems"],
    ["net", "Network routing", "networks"],
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
  "data/snapshot.json",
  "public/catalog.json",
  "public/recommendation-index.json",
])
  writeFileSync(join(root, path), JSON.stringify(data));
interface Reply {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent?: {
    input: { received: number; used: number; truncated: boolean };
    rows: Array<{ venue_key: string }>;
  };
}
const tools = ["search_venues", "recommend_venues"];
const invalid = [
  { value: {}, path: "", reason: "title または abstract" },
  { value: [], path: "", reason: "1件以上" },
  { value: { title: {} }, path: ".title", reason: "文字列" },
  { value: { abstract: ["GPU"] }, path: ".abstract", reason: "文字列" },
  { value: { title: "GPU", keywords: ["memory", 4] }, path: ".keywords", reason: "文字列" },
  { value: { title: "GPU", venue: {} }, path: ".venue", reason: "文字列" },
  { value: { title: "GPU", source: "unexpected" }, path: "", reason: "使えない項目" },
  { value: [{ title: "GPU" }, null], path: "[1]", reason: "論文オブジェクト" },
  { value: [{ title: "GPU" }, { title: " " }], path: "[1]", reason: "title または abstract" },
  { value: { name: {} }, path: ".name", reason: "文字列" },
  { value: { summary: ["GPU"] }, path: ".summary", reason: "文字列" },
  { value: { title: " ", name: "GPU" }, path: "", reason: "title または abstract" },
  { value: { abstract: " ", summary: "GPU" }, path: "", reason: "title または abstract" },
  { value: { title: "GPU", keyword: ["memory", 4] }, path: ".keyword", reason: "文字列" },
];
it.each(tools.flatMap((tool) => invalid.map((test) => ({ tool, ...test }))))(
  "$tool rejects encoded invalid paper $value and recovers in English and Japanese without reconnecting",
  ({ tool, value, path, reason }) => {
    const field = tool === "search_venues" ? "query" : "paper";
    const calls: McpCall[] = [
      [tool, { [field]: JSON.stringify(value) }],
      [tool, { [field]: { title: "GPU memory management" } }],
      [
        tool,
        { [field]: JSON.stringify({ title: "GPUメモリ管理", abstract: "GPU memory management" }) },
      ],
    ];
    const [bad, en, ja] = callMcp<Reply>(root, calls);
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toBeUndefined();
    expect(bad.content[0].text).toContain(field + path);
    expect(bad.content[0].text).toContain(reason);
    expect(bad.content[0].text).not.toMatch(/\[object Object\]|undefined|NaN/);
    for (const good of [en, ja]) {
      expect(good.isError).not.toBe(true);
      expect(good.structuredContent?.input).toEqual({ received: 1, used: 1, truncated: false });
      expect(good.structuredContent?.rows[0].venue_key).toBe("gpu");
    }
  },
);

it.each(tools)("%s retains valid legacy JSON aliases and all papers", (tool) => {
  const field = tool === "search_venues" ? "query" : "paper";
  const canonical = [
    {
      title: "GPU memory management",
      abstract: "GPU scheduling",
      keywords: "memory, GPU",
      venue: "GPU",
    },
    { title: "Network routing", abstract: "Packet scheduling", keywords: "routing", venue: "" },
  ];
  const legacy = [
    {
      title_text: canonical[0].title,
      summary: canonical[0].abstract,
      keyword: ["memory", "GPU"],
      venue: "GPU",
    },
    { name: canonical[1].title, summary: canonical[1].abstract, keyword: "routing" },
  ];
  const [native, encoded, aliases, nativeAliases] = callMcp<Reply>(root, [
    [tool, { [field]: canonical }],
    [tool, { [field]: JSON.stringify(canonical) }],
    [tool, { [field]: JSON.stringify(legacy) }],
    [tool, { [field]: legacy }],
  ]);
  expect(nativeAliases.isError).toBe(true);
  expect(nativeAliases.structuredContent).toBeUndefined();
  expect(nativeAliases.content[0].text).toContain(`${field}[0]`);
  expect(nativeAliases.content[0].text).toContain("使えない項目");
  expect(native.isError).not.toBe(true);
  expect(native.structuredContent?.rows.length).toBeGreaterThan(0);
  expect(native.structuredContent?.input).toEqual({ received: 2, used: 2, truncated: false });
  for (const actual of [encoded, aliases]) {
    expect(actual.isError).not.toBe(true);
    expect(actual.structuredContent).toEqual(native.structuredContent);
    expect(actual.content).toEqual(native.content);
  }
});

it.each(tools)(
  "%s preserves literal titles that start with non-JSON braces or brackets",
  (tool) => {
    const field = tool === "search_venues" ? "query" : "paper";
    for (const title of ["[GPU] memory management", "{GPU memory management"]) {
      const [literal, record] = callMcp<Reply>(root, [
        [tool, { [field]: title }],
        [tool, { [field]: { title } }],
      ]);
      expect(literal.isError).not.toBe(true);
      expect(literal.structuredContent?.input).toEqual({ received: 1, used: 1, truncated: false });
      expect(literal.structuredContent?.rows.length).toBeGreaterThan(0);
      expect(literal.structuredContent).toEqual(record.structuredContent);
    }
  },
);
