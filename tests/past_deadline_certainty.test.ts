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
import R from "../site/recommender.ts";

const now = Date.parse("2029-06-01T00:00:00Z");
function conference(precision: string, start = "2029-06-02") {
  return {
    key: precision,
    title: precision,
    categories: [],
    rank: {},
    editions: [
      {
        id: "current",
        year: 2029,
        event_start: start,
        event_end: start,
        event_date_precision: precision,
        deadlines: [{ kind: "paper", utc: "2029-05-01T00:00:00Z", tz_raw: "UTC" }],
      },
    ],
  };
}
const precisions = ["month-only", "unverified", "not-announced", "exact-range", "single-day"];
function tag(conf: unknown, at = now) {
  const rows = R.candidateRows({ conferences: [conf] });
  expect(rows).toHaveLength(1);
  return R.pastDeadlineTagJa(rows[0], at);
}
it("only calls a known future session upcoming, preserving uncertain dates as uncertain", () => {
  for (const precision of precisions) {
    expect(tag(conference(precision)), precision).toBe(
      ["exact-range", "single-day"].includes(precision) ? "締切済み（会期がこれから）" : "締切済み",
    );
  }
  expect(tag(conference("exact-range", "2029-06-01"))).toBe("締切済み");
  expect(tag(conference("single-day"), Date.parse("2029-06-01T14:59:59.999Z"))).toBe(
    "締切済み（会期がこれから）",
  );
  expect(tag(conference("single-day"), Date.parse("2029-06-01T15:00:00Z"))).toBe("締切済み");
});
it("uses edition identity so another same-day edition remains visible and the current split edition is not next", () => {
  const conf = conference("exact-range", "2029-06-01");
  conf.editions.push({ ...conf.editions[0], id: "distinct", deadlines: [] });
  expect(tag(conf)).toBe("締切済み（次回予定）");
  conf.editions.pop();
  expect(tag(conf)).toBe("締切済み");
  const split = {
    ...conf,
    editions: [
      {
        ...conf.editions[0],
        event_start: null,
        event_end: null,
        event_date_precision: "split-dates",
        event_segments: [{ start: "2029-06-02", end: "2029-06-03" }],
      },
    ],
  };
  expect(tag(split)).toBe("締切済み（会期がこれから）");
});
const repo = join(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "kamiyobi-past-certainty-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const dir of ["src", "site"]) cpSync(join(repo, dir), join(root, dir), { recursive: true });
symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
writeFileSync(join(root, "package.json"), '{"type":"module"}');
mkdirSync(join(root, "data"));
writeFileSync(
  join(root, "data/snapshot.json"),
  JSON.stringify({ conferences: precisions.map((p) => conference(p)) }),
);
writeFileSync(
  join(root, "run.ts"),
  'import {runStdio} from "./src/mcp.ts";runStdio(Date.parse("2029-06-01T00:00:00Z"));',
);
it("sends certainty-aware tags over MCP without published data or model artifacts", () => {
  for (const dir of ["public", ".cache"]) expect(existsSync(join(root, dir))).toBe(false);
  const child = spawnSync(process.execPath, ["run.ts"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_deadlines", arguments: { include_past: true, kinds: ["paper"], scope: "all", limit: 100 } } })}\n`,
  });
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout.trim()).result;
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent.rows).toHaveLength(5);
  const text = result.content.map((c: { text?: string }) => c.text || "").join("\n");
  const lines = text.split("\n").filter((line: string) => line.startsWith("2029-05-01"));
  expect(lines).toHaveLength(5);
  for (const precision of precisions) {
    const line = lines.find((l: string) => l.includes(`${precision}（current）`));
    expect(line, precision).toBeDefined();
    expect(line.includes("締切済み（会期がこれから）"), precision).toBe(
      ["exact-range", "single-day"].includes(precision),
    );
  }
});
