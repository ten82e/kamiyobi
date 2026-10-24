import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { callMcp, createMcpSandbox, type McpCall } from "./mcp_stdio.ts";

const root = createMcpSandbox("kamiyobi-mcp-scalar-inputs-", "2030-01-01T00:00:00Z");
const conferences = [
  ["past", "2029-12-31", false, [], "Tokyo"],
  ["today", "2030-01-01", false, [], "Tokyo"],
  ["tomorrow", "2030-01-02", false, [], "Paris"],
  ["estimated", "2030-01-03", true, [], "Paris"],
  ["domestic", "2030-01-04", false, ["domestic-jp"], "Tokyo"],
  ["online", "2030-01-06", false, [], "Online"],
].map(([key, date, estimated, tags, place]) => ({
  key,
  title: `Distributed ${key}`,
  full_name: `分散システム ${key}`,
  rank: {},
  categories: ["systems"],
  tags,
  editions: [
    {
      id: `${key}-2030`,
      year: 2030,
      estimated,
      place,
      deadlines: [{ kind: "paper", utc: `${date}T01:00:00Z`, tz_raw: "UTC" }],
    },
  ],
}));
const data = {
  generated_at: "2030-01-01T00:00:00Z",
  snapshot_metadata: { generated_at: "2030-01-01T00:00:00Z" },
  categories: { systems: "Systems" },
  conferences,
};
for (const path of [
  "public/catalog.json",
  "public/recommendation-index.json",
  "data/snapshot.json",
])
  writeFileSync(join(root, path), JSON.stringify(data));
interface Reply {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent?: {
    returned?: number;
    total?: number;
    candidate_venues?: number;
    rows?: Array<{ venue_key: string }>;
    items?: Array<{ type: string; venue_key: string }>;
    ignored_filters?: string[];
    warnings?: string[];
  };
}
const calls = (requests: McpCall[]) => callMcp<Reply>(root, requests);
const text = (reply: Reply) => reply.content.map((part) => part.text).join("\n");
function effectiveResult(reply: Reply, expectedWarnings: string[] = []) {
  const { warnings, ...result } = reply.structuredContent!;
  expect(warnings ?? []).toEqual(expectedWarnings);
  for (const warning of expectedWarnings) expect(text(reply)).toContain(warning);
  return result;
}
const search = { query: "分散システム", scope: "all", kind: "paper" };
const numericCases: Array<[string, Record<string, unknown>, string]> = [
  ["search_deadlines", search, "limit"],
  ["search_deadlines", search, "within_days"],
  ["list_upcoming", { scope: "all", kind: "paper" }, "limit"],
  ["list_upcoming", { scope: "all", kind: "paper" }, "days"],
  ["search_venues", { query: { title: "Distributed today" } }, "limit"],
  ["recommend_venues", { paper: { title: "Distributed today" } }, "limit"],
];
const boolFields = ["include_past", "include_estimated", "domestic", "online"];
function invalid(reply: Reply, field: string, guidance: string) {
  expect(reply.isError, `${field}: ${text(reply)}`).toBe(true);
  expect(reply.structuredContent).toBeUndefined();
  expect(text(reply)).toContain(`${field} は${guidance}`);
  expect(text(reply)).not.toMatch(/\[object Object\]|NaN|undefined/);
}

it("rejects numeric containers and retries with a scalar on the same connection", () => {
  for (const [tool, args, field] of numericCases) {
    const requests: McpCall[] = [[tool, { ...args, [field]: 2 }]];
    for (const value of [[], [2], ["2"], [[2]], {}, { value: 2 }])
      requests.push([tool, { ...args, [field]: value }], [tool, { ...args, [field]: 2 }]);
    const [baseline, ...replies] = calls(requests);
    expect(baseline.isError).not.toBe(true);
    expect(baseline.structuredContent).toBeDefined();
    for (let i = 0; i < replies.length; i += 2) {
      invalid(replies[i], field, "数で指定してください");
      expect(replies[i + 1]).toEqual(baseline);
    }
  }
});

it("rejects boolean containers instead of enabling or silently removing filters", () => {
  for (const field of boolFields) {
    const requests: McpCall[] = [["search_deadlines", { ...search, [field]: true }]];
    for (const value of [[], [true], [false], ["true"], ["false"], {}, { value: true }])
      requests.push(
        ["search_deadlines", { ...search, [field]: value }],
        ["search_deadlines", { ...search, [field]: true }],
      );
    const [baseline, ...replies] = calls(requests);
    expect(baseline.isError).not.toBe(true);
    for (let i = 0; i < replies.length; i += 2) {
      invalid(replies[i], field, " true か false で指定してください");
      expect(replies[i + 1]).toEqual(baseline);
    }
  }
});

it("keeps scalar limits and date windows effective, including supported numeric strings", () => {
  for (const [tool, args, field] of numericCases) {
    const replies = calls([1, 3, "3"].map((value) => [tool, { ...args, [field]: value }]));
    for (const reply of replies) expect(reply.isError).not.toBe(true);
    expect(effectiveResult(replies[1])).toEqual(
      effectiveResult(
        replies[2],
        tool === "search_deadlines"
          ? [`${field} は数で指定してください（いま "3" – 数値に変換しました）`]
          : [],
      ),
    );
    if (field === "limit") {
      expect(replies[0].structuredContent?.returned).toBe(1);
      expect(replies[1].structuredContent?.returned).toBe(3);
    } else {
      const keys = (r: Reply) =>
        tool === "list_upcoming"
          ? r.structuredContent?.items
              ?.filter((item) => item.type === "deadline")
              .map((item) => item.venue_key)
          : r.structuredContent?.rows?.map((row) => row.venue_key);
      expect(keys(replies[0])).toEqual(["today", "tomorrow"]);
      expect(keys(replies[1])).toEqual(
        tool === "list_upcoming"
          ? ["today", "tomorrow", "estimated", "domestic"]
          : ["today", "tomorrow", "domestic"],
      );
    }
  }
});

it("keeps boolean scalar aliases effective and preserves each filter's actual selection", () => {
  const expected: Record<string, string[]> = {
    include_past: ["past", "today", "tomorrow", "domestic", "online"],
    include_estimated: ["today", "tomorrow", "estimated", "domestic", "online"],
    domestic: ["domestic"],
    online: ["online"],
  };
  for (const field of boolFields) {
    const replies = calls(
      [true, "true", "1", 1, "yes", "on", "真", false, "false", "0", 0, "no", "off", "偽"].map(
        (value) => ["search_deadlines", { ...search, [field]: value }],
      ),
    );
    for (const reply of replies) expect(reply.isError).not.toBe(true);
    for (const reply of replies.slice(0, 7)) {
      expect(reply.structuredContent?.rows?.map((row) => row.venue_key)).toEqual(expected[field]);
      expect(text(reply)).not.toContain("で指定してください");
    }
    for (const reply of replies.slice(7)) {
      expect(reply.structuredContent?.rows?.map((row) => row.venue_key)).toEqual([
        "today",
        "tomorrow",
        "domestic",
        "online",
      ]);
      expect(text(reply)).not.toContain("で指定してください");
    }
  }
});

it("continues to ignore unused deadline filters in venue search and recommendation", () => {
  for (const tool of ["search_venues", "recommend_venues"]) {
    const args = { [tool === "search_venues" ? "query" : "paper"]: { title: "Distributed today" } };
    const filters = {
      within_days: [2],
      include_past: [true],
      include_estimated: {},
      domestic: [false],
      online: { value: true },
    };
    const [baseline, extra] = calls([
      [tool, args],
      [tool, { ...args, ...filters }],
    ]);
    expect(baseline.isError).not.toBe(true);
    expect(extra.isError).not.toBe(true);
    expect(extra.structuredContent).toEqual({
      ...baseline.structuredContent,
      ignored_filters: expect.arrayContaining(Object.keys(filters)),
    });
    expect(extra.structuredContent?.ignored_filters).toHaveLength(5);
    expect(extra.structuredContent?.candidate_venues).toBe(6);
    expect(text(extra)).toContain("無視した絞り込み");
  }
});

it("preserves omitted values and the existing fallback warnings for invalid scalar values", () => {
  for (const [tool, args, field] of numericCases) {
    const [baseline, ...replies] = calls([
      [tool, args],
      ...[null, "", "   ", "nonsense", 0].map(
        (value) => [tool, { ...args, [field]: value }] as McpCall,
      ),
    ]);
    expect(baseline.isError).not.toBe(true);
    for (const [index, reply] of replies.entries()) {
      expect(reply.isError).not.toBe(true);
      const warnings =
        tool === "search_deadlines" && index >= 3
          ? [
              `${field} は 1 以上の数で指定してください（いま ${JSON.stringify(index === 3 ? "nonsense" : 0)}）。その値は使わず、未指定として扱います`,
            ]
          : [];
      expect(effectiveResult(reply, warnings)).toEqual(effectiveResult(baseline));
    }
    for (const reply of replies.slice(0, 3)) expect(text(reply)).not.toContain(`${field} は`);
    for (const reply of replies.slice(3))
      expect(text(reply)).toContain(`${field} は 1 以上の数で指定してください`);
  }
  for (const field of boolFields) {
    const [baseline, ...replies] = calls([
      ["search_deadlines", search],
      ...[null, "", "   ", "nonsense"].map(
        (value) => ["search_deadlines", { ...search, [field]: value }] as McpCall,
      ),
    ]);
    for (const [index, reply] of replies.entries()) {
      expect(reply.isError).not.toBe(true);
      const warnings =
        index === 3
          ? [
              `${field} は true か false で指定してください（いま "nonsense"）。その値は使わず、既定の設定を使います`,
            ]
          : [];
      expect(effectiveResult(reply, warnings)).toEqual(effectiveResult(baseline));
    }
    for (const reply of replies.slice(0, 3)) expect(text(reply)).not.toContain(`${field} は`);
    expect(text(replies[3])).toContain(`${field} は true か false で指定してください`);
  }
});
