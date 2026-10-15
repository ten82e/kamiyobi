import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "kamiyobi-mcp-segments-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const dir of ["src", "site"]) cpSync(join(repo, dir), join(root, dir), { recursive: true });
symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
writeFileSync(join(root, "package.json"), '{"type":"module"}');
mkdirSync(join(root, "data"));
const editions = [
  {
    id: "online-local",
    year: 2029,
    link: "https://example.org/2029/program",
    event_date_precision: "split-dates",
    event_segments: [
      { start: "2029-06-01", end: "2029-06-01", label: "オンライン" },
      { start: "2029-06-05", end: "2029-06-06", label: "現地開催" },
    ],
  },
  {
    id: "unverified",
    year: 2030,
    link: "https://example.org/2030/program",
    event_date_precision: "unverified",
    event_segments: [{ start: "2029-06-07", end: "2029-06-08", label: "日程確認中" }],
  },
];
function writeSnapshot(input: Array<Record<string, unknown>>) {
  writeFileSync(
    join(root, "data/snapshot.json"),
    JSON.stringify({
      conferences: [
        {
          key: "fresh",
          title: "Fresh",
          link: "https://example.org/current",
          categories: [],
          rank: {},
          editions: input.map((ed) => ({ ...ed, place: "Tokyo, Japan", deadlines: [] })),
        },
      ],
    }),
  );
}
writeSnapshot(editions);
writeFileSync(
  join(root, "run.ts"),
  'import {runStdio} from "./src/mcp.ts";runStdio(Date.parse("2029-05-31T00:00:00Z"));',
);
function pages(limit: number) {
  expect(existsSync(join(root, "public"))).toBe(false);
  expect(existsSync(join(root, ".cache"))).toBe(false);
  const child = spawnSync(process.execPath, ["run.ts"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
    input: `${Array.from({ length: Math.ceil(3 / limit) }, (_, id) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "list_upcoming", arguments: { days: 10, limit, offset: id * limit } },
      }),
    ).join("\n")}\n`,
  });
  expect(child.status, child.stderr).toBe(0);
  return child.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).result);
}
it("keeps segment labels, certainty, edition identity and official URLs in MCP text and structured pages", () => {
  for (const limit of [1, 3]) {
    const results = pages(limit);
    const items = results.flatMap((r) => r.structuredContent.items);
    expect(items).toHaveLength(3);
    expect(items.map((r) => [r.edition_id, r.year, r.segment_label, r.official_url])).toEqual([
      ["online-local", 2029, "オンライン", editions[0].link],
      ["online-local", 2029, "現地開催", editions[0].link],
      ["unverified", 2030, "日程確認中", editions[1].link],
    ]);
    const lines = results
      .flatMap((r) => r.content.flatMap((c: { text?: string }) => (c.text || "").split("\n")))
      .filter((line) => /^- \d{4}-/.test(line));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      "- 2029-06-01(金)（オンライン） | Fresh 2029（key: fresh・online-local） | Tokyo, 日本 https://example.org/2029/program",
    );
    expect(lines[1]).toBe(
      "- 2029-06-05(火) 〜 2029-06-06(水)（現地開催） | Fresh 2029（key: fresh・online-local） | Tokyo, 日本 https://example.org/2029/program",
    );
    expect(lines[2]).toBe(
      "- 2029-06-07(木) 〜 2029-06-08(金)（日付未確認）（日程確認中） | Fresh 2030（key: fresh・unverified） | Tokyo, 日本 https://example.org/2030/program",
    );
  }
});

function lookup() {
  const child = spawnSync(process.execPath, ["run.ts"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "venue_info", arguments: { key: "fresh" } } })}\n`,
  });
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout.trim()).result;
  expect(result.isError).not.toBe(true);
  const text = result.content.map((c: { text?: string }) => c.text || "").join("\n");
  return text;
}
it("recognizes segment-only schedules when looking up an event-only venue over MCP", () => {
  const text = lookup();
  expect(text).toContain("会期は収録にあります");
  expect(text).toContain("upcoming.md");
  expect(text).not.toContain("会期も確認できていない");
  expect(text).toContain("https://example.org/current");
});

it("updates schedule availability for valid single dates, invalid dates and empty input", () => {
  try {
    for (const [ed, available] of [
      [{ event_start: "2029-06-01", event_end: "2029-06-02" }, true],
      [{ event_segments: [{ start: "2029-06-01" }] }, true],
      [{ event_segments: [] }, false],
      [{ event_segments: [{ start: "2029-02-30", end: "2029-03-01" }] }, false],
      [{ event_start: "2029-06-02", event_end: "2029-06-01" }, false],
      [{}, false],
    ] as const) {
      writeSnapshot([{ id: "changed", year: 2029, ...ed }]);
      const text = lookup();
      expect(text.includes("会期は収録にあります"), JSON.stringify(ed)).toBe(available);
      expect(text.includes("会期も確認できていない"), JSON.stringify(ed)).toBe(!available);
    }
    writeSnapshot([]);
    expect(lookup()).toContain("会期も確認できていない");
  } finally {
    writeSnapshot(editions);
  }
});
