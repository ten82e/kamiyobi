import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { callMcp, createMcpSandbox, type McpCall } from "./mcp_stdio.ts";

const now = "2030-01-01T00:00:00Z";
const root = createMcpSandbox("kamiyobi-mcp-search-warnings-", now);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const data = {
  generated_at: now,
  snapshot_metadata: { generated_at: now },
  categories: { systems: "Systems", db: "Databases" },
  conferences: ["systems", "db"].map((key, index) => ({
    key,
    title: `Distributed ${key}`,
    full_name: `分散システム ${key}`,
    categories: [key],
    rank: { ccf: "A" },
    editions: [
      { year: 2030, deadlines: [{ kind: "paper", utc: `2030-01-0${index * 3 + 1}T01:00:00Z` }] },
    ],
  })),
};
for (const file of ["public/catalog.json", "data/snapshot.json"])
  writeFileSync(join(root, file), JSON.stringify(data));

interface Reply {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent: {
    query: string;
    total: number;
    warnings: string[];
    rows: Array<{ venue_key: string }>;
  };
}
const base = { query: "Distributed", scope: "all", kind: "paper", limit: 100 };
const cases: Array<{
  name: string;
  args: Record<string, unknown>;
  notice: string;
  keys: string[];
}> = [
  {
    name: "unknown category",
    args: { category: "unknown-field" },
    notice: "知らない分野",
    keys: ["systems", "db"],
  },
  {
    name: "mixed categories",
    args: { categories: ["systems", "unknown-field"] },
    notice: "知らない分野",
    keys: ["systems"],
  },
  {
    name: "category precedence",
    args: { category: "db", categories: ["systems"] },
    notice: "category は categories",
    keys: ["systems"],
  },
  { name: "unknown kind", args: { kind: "unknown-kind" }, notice: "知らない種別", keys: [] },
  { name: "empty kinds", args: { kinds: [] }, notice: "kinds が空", keys: ["systems", "db"] },
  {
    name: "kind precedence",
    args: { kind: "notification", kinds: ["paper"] },
    notice: "kind は kinds",
    keys: ["systems", "db"],
  },
  { name: "unknown rank", args: { rank: "ZZ" }, notice: "知らないランク", keys: [] },
  {
    name: "invalid window",
    args: { within_days: -1 },
    notice: "within_days は",
    keys: ["systems", "db"],
  },
  { name: "invalid limit", args: { limit: 0 }, notice: "limit は", keys: ["systems", "db"] },
  { name: "numeric string", args: { limit: "1" }, notice: "数値に変換しました", keys: ["systems"] },
  { name: "fractional limit", args: { limit: 1.7 }, notice: "端数", keys: ["systems"] },
  { name: "capped limit", args: { limit: 101 }, notice: "上限 100", keys: ["systems", "db"] },
  {
    name: "fractional window",
    args: { within_days: 1.7 },
    notice: "1 日として",
    keys: ["systems"],
  },
  {
    name: "unknown scope",
    args: { scope: "unknown-scope" },
    notice: "知らない scope",
    keys: ["systems", "db"],
  },
  {
    name: "long query",
    args: { query: `Distributed${" ".repeat(790)}ignored suffix` },
    notice: "最初の 800 字",
    keys: ["systems", "db"],
  },
  { name: "symbols only", args: { query: "---" }, notice: "記号だけ", keys: ["systems", "db"] },
  ...["include_past", "include_estimated", "domestic", "online"].map((field) => ({
    name: `invalid ${field}`,
    args: { [field]: "maybe" },
    notice: `${field} は`,
    keys: ["systems", "db"],
  })),
];

it.each(cases)(
  "reports $name in structured output and preserves effective search rules",
  ({ args, notice, keys }) => {
    const queries = args.query === "---" ? ["Distributed"] : ["Distributed", "分散システム"];
    const requests: McpCall[] = queries.flatMap((query) => {
      const input = { ...base, query, ...args };
      if (typeof args.query === "string" && args.query.length > 800)
        input.query = `${query}${" ".repeat(800 - query.length)}ignored suffix`;
      return [
        ["search_deadlines", input],
        ["search_deadlines", { ...base, query }],
      ];
    });
    const replies = callMcp<Reply>(root, requests);
    for (let index = 0; index < replies.length; index += 2) {
      const reply = replies[index];
      expect(reply.isError).not.toBe(true);
      expect(reply.structuredContent.rows.map((row) => row.venue_key)).toEqual(keys);
      expect(reply.structuredContent.warnings.some((warning) => warning.includes(notice))).toBe(
        true,
      );
      for (const warning of reply.structuredContent.warnings) {
        expect(warning.trim()).not.toBe("");
        expect(reply.content[0].text).toContain(warning);
      }
      expect(JSON.parse(reply.content[1].text)).toEqual(reply.structuredContent);
      expect(replies[index + 1].structuredContent.warnings).toEqual([]);
      expect(replies[index + 1].structuredContent.total).toBe(2);
    }
  },
);
