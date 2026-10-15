import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT, tempWork } from "./helpers.ts";

const now = Date.parse("2029-01-01T00:00:00Z");
const conf = {
  key: "fixture",
  title: "Fresh fixture",
  categories: ["systems"],
  editions: [
    {
      id: "current",
      year: 2029,
      event_start: "2029-09-01",
      event_end: "2029-09-02",
      event_date_precision: "exact-range",
      deadlines: [{ kind: "paper", utc: "2029-02-01T00:00:00Z", tz_raw: "UTC" }],
    },
    {
      id: "forecast",
      year: 2030,
      estimated: true,
      event_start: "2030-05-17",
      event_end: "2030-05-19",
      event_date_precision: "exact-range",
      deadlines: [{ kind: "paper", utc: "2030-01-07T00:00:00Z", tz_raw: "UTC" }],
    },
    {
      id: "recorded",
      year: 2031,
      event_start: "2031-06-12",
      event_end: "2031-06-14",
      event_date_precision: "exact-range",
      deadlines: [],
    },
    {
      id: "unannounced-forecast",
      year: 2032,
      estimated: true,
      event_date_precision: "not-announced",
      deadlines: [],
    },
  ],
};
it("keeps estimated other-edition dates out of confirmed rows without hiding forecasts or recorded later editions", () => {
  const before = JSON.stringify(conf);
  const rows = Recommender.candidateRows({ conferences: [conf] });
  expect(rows).toHaveLength(2);
  const current = rows.find((row) => row.ed.id === "current")!;
  const forecast = rows.find((row) => row.ed.id === "forecast")!;
  for (const query of ["2030-05-17", "2030年5月17日", "2030-05"]) {
    const matcher = Recommender.searchMatcher(query, now);
    expect(matcher(current.hay), query).toBe(false);
    expect(matcher(forecast.hay), query).toBe(true);
  }
  expect(Recommender.searchMatcher("会期未発表", now)(current.hay)).toBe(false);
  expect(Recommender.searchMatcher("2032", now)(current.hay)).toBe(false);
  for (const query of ["2029-02-01", "2029-09-01", "2031-06-12", "2029年2月1日"])
    expect(Recommender.searchMatcher(query, now)(current.hay), query).toBe(true);
  expect(JSON.stringify(conf)).toBe(before);
});

it("applies the boundary through MCP search and still returns the forecast when explicitly requested", () => {
  const root = tempWork("kamiyobi-estimated-event-search-");
  for (const dir of ["src", "site"])
    cpSync(join(REPO_ROOT, dir), join(root, dir), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, "data/snapshot.json"), JSON.stringify({ conferences: [conf] }));
  writeFileSync(join(root, "run.ts"), `import {runStdio} from "./src/mcp.ts";runStdio(${now});`);
  const requests = ["2030-05-17", "2030年5月17日", "2030-05"].flatMap((query) => [
    { query, include_estimated: false, scope: "all" },
    { query, include_estimated: true, scope: "all" },
  ]);
  const child = spawnSync(process.execPath, ["run.ts"], {
    cwd: root,
    encoding: "utf8",
    timeout: 20000,
    input: `${requests.map((args, i) => JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: "search_deadlines", arguments: args } })).join("\n")}\n`,
  });
  expect(child.status, child.stderr).toBe(0);
  const replies = child.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(replies).toHaveLength(6);
  for (const [i, reply] of replies.entries()) {
    expect(reply.id).toBe(i + 1);
    expect(reply.error).toBeUndefined();
    expect(reply.result.isError).not.toBe(true);
    const data = reply.result.structuredContent;
    expect(data.total, requests[i].query).toBe(i % 2);
    expect(data.rows.map((row: { edition_id: string }) => row.edition_id)).toEqual(
      i % 2 ? ["forecast"] : [],
    );
    if (i % 2) expect(data.rows[0]).toMatchObject({ estimated: true, event_start: "2030-05-17" });
  }
});
