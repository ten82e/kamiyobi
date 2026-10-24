import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { callMcp, createMcpSandbox, type McpCall } from "./mcp_stdio.ts";

const root = createMcpSandbox("kamiyobi-mcp-scope-inputs-", "2030-01-01T00:00:00Z");
const screenAt = "2029-12-31T12:00:00Z",
  allAt = "2029-12-30T12:00:00Z";
const venue = (key: string, day: number) => ({
  key,
  title: `Distributed ${key}`,
  full_name: `分散システム ${key}`,
  rank: {},
  categories: ["systems"],
  tags: [],
  editions: [
    {
      id: `${key}-2030`,
      year: 2030,
      estimated: false,
      deadlines: [{ kind: "paper", utc: `2030-01-0${day}T00:00:00Z`, tz_raw: "UTC" }],
    },
  ],
});
const inside = venue("inside", 3),
  outside = venue("outside", 4);
writeFileSync(
  join(root, "public/catalog.json"),
  JSON.stringify({ generated_at: screenAt, conferences: [inside] }),
);
writeFileSync(
  join(root, "data/snapshot.json"),
  JSON.stringify({ snapshot_metadata: { generated_at: allAt }, conferences: [inside, outside] }),
);
writeFileSync(
  join(root, "public/recommendation-index.json"),
  JSON.stringify({
    generated_at: allAt,
    categories: { systems: "Systems" },
    conferences: [inside, outside],
  }),
);
interface Reply {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent?: {
    candidate_venues?: number;
    total?: number;
    deadline_total?: number;
    scope?: string;
    generated_at: string;
    venue_key?: string;
    rows?: Array<{ venue_key: string }>;
    items?: Array<{ type: string; venue_key: string }>;
    catalog_fallback?: boolean;
  };
}
const calls = (requests: McpCall[]) => callMcp<Reply>(root, requests);
const text = (reply: Reply) => reply.content.map((part) => part.text).join("\n");
const cases: Array<[string, Record<string, unknown>]> = [
  ["search_deadlines", { query: "分散システム", kind: "paper" }],
  ["list_upcoming", { days: 30, kind: "paper" }],
  ["venue_info", { key: "inside" }],
  ["explain_word", { word: "Distributed" }],
];
function checkFull(reply: Reply, tool: string) {
  expect(reply.isError).not.toBe(true);
  expect(text(reply)).not.toMatch(/\[object Object\]|知らない scope/);
  if (tool === "explain_word") {
    expect(text(reply)).toContain("素の照合で 2 行");
    expect(text(reply)).toContain("収録の全体");
  } else {
    expect(reply.structuredContent?.scope).toBe("all");
    expect(reply.structuredContent?.generated_at).toBe(allAt);
    if (tool === "search_deadlines")
      expect(reply.structuredContent?.rows?.map((row) => row.venue_key)).toEqual([
        "inside",
        "outside",
      ]);
    if (tool === "list_upcoming") {
      expect(reply.structuredContent?.deadline_total).toBe(2);
      expect(
        reply.structuredContent?.items
          ?.filter((item) => item.type === "deadline")
          .map((row) => row.venue_key),
      ).toEqual(["inside", "outside"]);
    }
    if (tool === "venue_info") expect(reply.structuredContent?.venue_key).toBe("inside");
  }
}

it("rejects scope containers before selecting data and accepts a corrected full scope on the same connection", () => {
  for (const [tool, args] of cases) {
    for (const scope of [{ scope: "all" }, {}, [], ["all"], ["screen", "all"]]) {
      const [bad, recovered] = calls([
        [tool, { ...args, scope }],
        [tool, { ...args, scope: "all" }],
      ]);
      expect(bad.isError, `${tool}: ${JSON.stringify(scope)}`).toBe(true);
      expect(bad.structuredContent).toBeUndefined();
      expect(text(bad)).toContain("scope は文字列で指定してください");
      expect(text(bad)).toContain("screen");
      expect(text(bad)).toContain("all");
      expect(text(bad)).not.toContain("[object Object]");
      checkFull(recovered, tool);
    }
  }
});

it("preserves scope aliases, case folding and source timestamps", () => {
  for (const [tool, args] of cases) {
    for (const scope of ["all", "collection", "full", " ALL ", " Collection "]) {
      checkFull(calls([[tool, { ...args, scope }]])[0], tool);
    }
    for (const scope of ["screen", "window", "catalog", " SCREEN "]) {
      const result = calls([[tool, { ...args, scope }]])[0];
      expect(result.isError).not.toBe(true);
      expect(text(result)).not.toContain("知らない scope");
      if (tool === "explain_word") expect(text(result)).toContain("素の照合で 1 行");
      else {
        expect(result.structuredContent?.scope).toBe("screen");
        expect(result.structuredContent?.generated_at).toBe(screenAt);
        if (tool === "search_deadlines")
          expect(result.structuredContent?.rows?.map((row) => row.venue_key)).toEqual(["inside"]);
        if (tool === "list_upcoming") expect(result.structuredContent?.deadline_total).toBe(1);
      }
    }
  }
});

it("retains each tool's omitted-scope default and the existing warning for unknown scope strings", () => {
  for (const [tool, args] of cases) {
    const results = calls([
      [tool, args],
      [tool, { ...args, scope: null }],
      [tool, { ...args, scope: "nosuch" }],
    ]);
    for (const result of results) expect(result.isError).not.toBe(true);
    const fullDefault = tool === "list_upcoming" || tool === "venue_info";
    for (const result of results.slice(0, 2)) {
      if (tool === "explain_word") expect(text(result)).toContain("素の照合で 1 行");
      else expect(result.structuredContent?.scope).toBe(fullDefault ? "all" : "screen");
    }
    expect(text(results[2])).toContain("知らない scope「nosuch」");
    if (tool !== "explain_word") expect(results[2].structuredContent?.scope).toBe("screen");
  }
});

it("does not validate unused scope arguments in venue search or recommendation", () => {
  for (const tool of ["search_venues", "recommend_venues"]) {
    const field = tool === "search_venues" ? "query" : "paper";
    const paper = { title: "Distributed inside" };
    const [baseline, extra] = calls([
      [tool, { [field]: paper }],
      [tool, { [field]: paper, scope: { scope: "screen" } }],
    ]);
    expect(baseline.isError).not.toBe(true);
    expect(extra.isError).not.toBe(true);
    expect(extra.structuredContent?.candidate_venues).toBe(2);
    expect(extra.structuredContent?.rows?.[0].venue_key).toBe("inside");
    expect(extra.structuredContent).toEqual({
      ...baseline.structuredContent,
      ignored_filters: ["scope"],
    });
    expect(text(extra)).toContain("無視した絞り込み scope");
    expect(text(extra)).not.toContain("scope は文字列");
  }
});
