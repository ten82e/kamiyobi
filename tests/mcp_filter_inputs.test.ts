import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "kamiyobi-mcp-filter-inputs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const dir of ["src", "site", "scripts"])
  cpSync(join(repo, dir), join(root, dir), { recursive: true });
for (const file of ["package.json", "tsconfig.json"]) cpSync(join(repo, file), join(root, file));
symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
mkdirSync(join(root, "data"));
mkdirSync(join(root, "public"));
writeFileSync(
  join(root, "run.ts"),
  'import {runStdio} from "./src/mcp.ts";globalThis.fetch=async()=>{throw new Error("network forbidden")};runStdio(Date.parse("2030-01-01T00:00:00Z"));',
);

function venue(
  key: string,
  date?: string,
  options: { rank?: string; kind?: string; estimated?: boolean } = {},
) {
  return {
    key,
    title: `Distributed ${key}`,
    full_name: `分散システム ${key}`,
    categories: ["systems"],
    tags: date ? [] : ["journal"],
    rank: { core: options.rank ?? "A" },
    link: `https://${key}.example.org/`,
    editions: date
      ? [
          {
            id: `${key}-2030`,
            year: 2030,
            estimated: options.estimated ?? false,
            deadlines: [{ kind: options.kind ?? "paper", utc: date, tz_raw: "UTC" }],
          },
        ]
      : [],
  };
}
const far = venue("far", "2030-01-20T01:00:00Z", { rank: "B" });
const ongoing = venue("ongoing", undefined, { rank: "B" });
const all = [
  venue("past-two", "2029-12-30T01:00:00Z"),
  venue("past-near", "2029-12-31T01:00:00Z"),
  venue("today", "2030-01-01T01:00:00Z"),
  venue("tomorrow", "2030-01-02T01:00:00Z"),
  venue("after", "2030-01-03T01:00:00Z"),
  venue("third", "2030-01-04T01:00:00Z"),
  venue("estimated", "2030-01-05T01:00:00Z", { estimated: true }),
  venue("notice", "2030-01-06T01:00:00Z", { kind: "notification" }),
  far,
  ongoing,
];
const screenAt = "2029-12-31T12:00:00Z";
const allAt = "2029-12-31T06:00:00Z";
writeFileSync(
  join(root, "public/catalog.json"),
  JSON.stringify({ generated_at: screenAt, conferences: [far, ongoing] }),
);
writeFileSync(
  join(root, "data/snapshot.json"),
  JSON.stringify({ snapshot_metadata: { generated_at: allAt }, conferences: all }),
);
interface Page {
  total: number;
  scope: string;
  generated_at: string;
  returned: number;
  rows: Array<{ venue_key: string; utc: string | null }>;
  scope_comparison?: {
    scope: string;
    total: number;
    matched_before_filters: number;
    generated_at: string;
  };
}
function calls(inputs: Record<string, unknown>[]) {
  const child = spawnSync(process.execPath, ["run.ts"], {
    cwd: root,
    input: `${inputs.map((args, id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "search_deadlines", arguments: args } })).join("\n")}\n`,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const responses = child.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(responses).toHaveLength(inputs.length);
  return responses.map((response, id) => {
    expect(response.id).toBe(id);
    expect(response.error).toBeUndefined();
    expect(response.result.isError, JSON.stringify(response.result)).not.toBe(true);
    return response.result as { structuredContent: Page; content: Array<{ text: string }> };
  });
}
const keys = (page: Page) => page.rows.map((row) => row.venue_key);
const text = (response: ReturnType<typeof calls>[number]) =>
  response.content.map((item) => item.text).join("\n");
const active = ["today", "tomorrow", "after", "third", "far", "ongoing"];
const invalid = [0.5, 0.99, 0.000001, "0.5", 0, -1, "nonsense", "Infinity"];

it("does not apply a deadline window that the response says was ignored", () => {
  for (const query of ["Distributed", "分散システム"]) {
    for (const scope of ["screen", "all"]) {
      const expected = scope === "screen" ? ["far", "ongoing"] : active;
      const inputs = invalid.map((within_days) => ({ query, scope, within_days, limit: 100 }));
      for (const response of calls(inputs)) {
        expect(keys(response.structuredContent)).toEqual(expected);
        expect(response.structuredContent.total).toBe(expected.length);
        expect(response.structuredContent.scope_comparison).toBeUndefined();
        expect(text(response)).toContain("その値は使わず、未指定として扱います");
        expect(text(response)).not.toContain("／締切まで");
        expect(text(response)).not.toContain("within_days を省いてください");
        expect(
          response.structuredContent.rows.find((row) => row.venue_key === "ongoing")?.utc,
        ).toBeNull();
      }
    }
  }
});

it("uses the reported whole number of JST calendar days at both ends of fractional windows", () => {
  for (const query of ["Distributed", "分散システム"]) {
    for (const include_past of [false, true]) {
      const inputs = [1.5, 1.9, "1.9", 2.1, 2.9].map((within_days) => ({
        query,
        scope: "all",
        kind: "paper",
        include_past,
        within_days,
        limit: 100,
      }));
      for (const [index, response] of calls(inputs).entries()) {
        const days = index < 3 ? 1 : 2;
        const expected = [
          ...(include_past ? (days === 1 ? ["past-near"] : ["past-two", "past-near"]) : []),
          "today",
          "tomorrow",
          ...(days === 2 ? ["after"] : []),
        ];
        expect(keys(response.structuredContent), JSON.stringify(inputs[index])).toEqual(expected);
        expect(response.structuredContent.total).toBe(expected.length);
        expect(text(response)).toContain(`${days} 日として切りました`);
        expect(text(response)).toContain(`／締切まで ${days} 日以内`);
        expect(text(response)).not.toContain("未指定として扱います");
      }
    }
  }
});

it("passes normalized days to scope comparisons and same-connection retries", () => {
  for (const query of ["Distributed", "分散システム"]) {
    for (const within_days of [0.5, "0.5", 1.9, "1.9", 2.9]) {
      for (const include_past of [false, true]) {
        const expected =
          Number(within_days) < 1
            ? [
                ...(include_past ? ["past-two", "past-near"] : []),
                "today",
                "tomorrow",
                "after",
                "third",
              ]
            : Number(within_days) < 2
              ? [...(include_past ? ["past-near"] : []), "today", "tomorrow"]
              : [...(include_past ? ["past-two", "past-near"] : []), "today", "tomorrow", "after"];
        const filters = { query, rank: "A", kind: "paper", include_past, within_days, limit: 100 };
        const [zero, retry] = calls([
          { ...filters, scope: "screen" },
          { ...filters, scope: "all" },
        ]);
        expect(zero.structuredContent).toMatchObject({
          total: 0,
          returned: 0,
          rows: [],
          scope: "screen",
          generated_at: screenAt,
          scope_comparison: {
            scope: "all",
            total: expected.length,
            matched_before_filters: 10,
            generated_at: allAt,
          },
        });
        expect(text(zero)).toContain(`同じ絞り込み条件では ${expected.length} 件です`);
        expect(keys(retry.structuredContent)).toEqual(expected);
        expect(retry.structuredContent.total).toBe(expected.length);
      }
    }
  }
});

it("leaves absent or blank windows unrestricted and keeps explicit valid integers bounded", () => {
  const inputs = [undefined, null, "", "   ", 1, 2, "2"].map((within_days) => ({
    query: "Distributed",
    scope: "all",
    within_days,
    limit: 100,
  }));
  for (const [index, response] of calls(inputs).entries()) {
    const expected =
      index < 4 ? active : index === 4 ? ["today", "tomorrow"] : ["today", "tomorrow", "after"];
    expect(keys(response.structuredContent)).toEqual(expected);
    expect(response.structuredContent.total).toBe(expected.length);
    expect(text(response)).not.toContain("その値は使わず");
    expect(text(response)).not.toContain("端数なので");
  }
});
