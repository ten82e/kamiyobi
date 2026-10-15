import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { recordsOf, toUpcomingMd } from "../src/build.ts";
import { conferencesFromJson } from "../src/model.ts";

const repo = join(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "kamiyobi-month-window-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const dir of ["src", "site"]) cpSync(join(repo, dir), join(root, dir), { recursive: true });
cpSync(join(repo, "tsconfig.json"), join(root, "tsconfig.json"));
symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
writeFileSync(join(root, "package.json"), '{"type":"module"}');
const raw = {
  conferences: ["month-only", "exact-range", "unverified"].map((precision) => ({
    key: precision,
    title: precision,
    categories: ["systems"],
    editions: [
      {
        id: precision,
        year: 2028,
        event_start: "2028-02-17",
        event_end: "2028-02-19",
        event_date_precision: precision,
        estimated: false,
        deadlines: [],
      },
    ],
  })),
};
mkdirSync(join(root, "data"));
writeFileSync(join(root, "data/snapshot.json"), JSON.stringify(raw));
writeFileSync(
  join(root, "run.ts"),
  'import {runStdio} from "./src/mcp.ts";runStdio(Date.parse(process.argv[2]));',
);
writeFileSync(
  join(root, "build-month.mjs"),
  `
import { readFileSync } from 'node:fs';
import { setRoot, buildAll } from './src/build.ts';
import { conferencesFromJson } from './src/model.ts';
setRoot(import.meta.dirname);
globalThis.fetch=async()=>{throw new Error('network forbidden')};
await buildAll(conferencesFromJson(JSON.parse(readFileSync('data/snapshot.json','utf8'))),
 {site:{upcoming_days:1}}, 'out', new Date(process.argv[2]),
 {noEmbeddings:true,localEmbeddingsOnly:true,venuePapers:{},reranker:null});
`,
);
const confs = conferencesFromJson(raw);
const records = recordsOf(confs);

function mcp(now: string) {
  const r = spawnSync(process.execPath, ["run.ts", now], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_upcoming", arguments: { days: 1, scope: "all" } } })}\n`,
  });
  expect(r.status, r.stderr).toBe(0);
  const result = JSON.parse(r.stdout).result;
  expect(result.isError).not.toBe(true);
  return result;
}
const cases = [
  ["2028-01-30T12:00:00Z", []],
  ["2028-01-31T12:00:00Z", ["month-only"]],
  ["2028-02-01T00:00:00Z", ["month-only"]],
  ["2028-02-17T00:00:00Z", ["exact-range", "month-only", "unverified"]],
  ["2028-02-20T00:00:00Z", ["month-only"]],
  ["2028-02-29T14:59:59Z", ["month-only"]],
  ["2028-02-29T15:00:00Z", []],
] as const;

describe("month-only date windows without invented event dates", () => {
  it.each(cases)("keeps the possible month at %s in Markdown and real MCP", (now, expected) => {
    const md = toUpcomingMd(records, new Date(now), 1);
    const rows = md.split("\n").filter((line) => line.startsWith("| ") && line.includes("2028"));
    expect(rows.map((line) => line.split("|")[3].trim().replace(" 2028", "")).sort()).toEqual([
      ...expected,
    ]);
    for (const line of rows.filter((line) => line.includes("month-only 2028"))) {
      expect(line).toContain("| 2028-02（月のみ判明） | 日付未確認 |");
      expect(line).not.toMatch(/2028-02-(?:01|17|19|29)|本日開催|開催中/);
    }
    const result = mcp(now);
    expect(
      result.structuredContent.items.map((item: { venue_key: string }) => item.venue_key).sort(),
    ).toEqual([...expected]);
    expect(result.structuredContent.event_total).toBe(expected.length);
    const month = result.structuredContent.items.find(
      (item: { venue_key: string }) => item.venue_key === "month-only",
    );
    if ((expected as readonly string[]).includes("month-only")) {
      expect(month).toMatchObject({
        event_start: "2028-02-17",
        event_end: "2028-02-19",
        event_date_precision: "month-only",
      });
      expect(result.content[0].text).toContain("2028-02（月のみ判明）");
    } else expect(month).toBeUndefined();
    expect(raw.conferences[0].editions[0]).toMatchObject({
      event_start: "2028-02-17",
      event_end: "2028-02-19",
      event_date_precision: "month-only",
    });
  });
  it("uses complete calendar months across a year boundary and preserves exact dates", () => {
    const day = (value: number) => new Date(value).toISOString().slice(0, 10);
    expect(
      Recommender.eventDateBoundsMs("2028-12-17", "2029-01-19", "month-only")?.map(day),
    ).toEqual(["2028-12-01", "2029-01-31"]);
    expect(
      Recommender.eventDateBoundsMs("2028-02-17", "2028-02-19", "exact-range")?.map(day),
    ).toEqual(["2028-02-17", "2028-02-19"]);
    expect(
      Recommender.eventDateBoundsMs("2028-02-17", "2028-02-19", "unverified")?.map(day),
    ).toEqual(["2028-02-17", "2028-02-19"]);
    expect(Recommender.eventDateBoundsMs("2028-02-30", "2028-03-02", "month-only")).toBeNull();
    expect(Recommender.eventDateBoundsMs("2028-03-02", "2028-02-20", "month-only")).toBeNull();
  });
  it("publishes the possible month through the build without changing archived dates", () => {
    for (const now of ["2028-02-20T00:00:00Z", "2028-02-29T15:00:00Z"]) {
      const child = spawnSync(process.execPath, ["build-month.mjs", now], {
        cwd: root,
        encoding: "utf8",
        timeout: 60000,
      });
      expect(child.status, child.stdout + child.stderr).toBe(0);
      const md = readFileSync(join(root, "out/upcoming.md"), "utf8");
      const html = readFileSync(join(root, "out/upcoming.html"), "utf8");
      if (now.startsWith("2028-02-20")) {
        expect(md).toContain("| 2028-02（月のみ判明） | 日付未確認 | month-only 2028 |");
        expect(html).toContain("2028-02（月のみ判明）");
        expect(html).not.toContain("本日開催</td>");
      } else {
        expect(md).not.toContain("month-only 2028");
        expect(html).not.toContain("month-only 2028");
      }
      const data = JSON.parse(readFileSync(join(root, "out/data.json"), "utf8"));
      expect(
        data.conferences.find((c: { key: string }) => c.key === "month-only").editions[0],
      ).toMatchObject({
        event_start: "2028-02-17",
        event_end: "2028-02-19",
        event_date_precision: "month-only",
      });
    }
  });
});
