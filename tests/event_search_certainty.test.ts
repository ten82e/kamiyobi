import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT, tempWork } from "./helpers.ts";

function input(precision: string) {
  return {
    key: "fresh",
    title: "Fresh",
    categories: [],
    editions: [
      {
        id: "future",
        year: 2029,
        event_start: "2030-05-17",
        event_end: "2030-05-19",
        date_text: "2030年5月17日-19日",
        event_date_precision: precision,
        deadlines: [] as Array<{ kind: string; utc: string; tz_raw: string }>,
      },
    ],
  };
}
function matches(hay: string, query: string) {
  return Recommender.searchMatcher(query, Date.parse("2029-01-01"))(hay);
}
it("uses only the known date granularity for schedule-only search and preserves source dates", () => {
  for (const precision of ["exact-range", "unverified", "month-only", "not-announced"]) {
    const conf = input(precision);
    const saved = JSON.stringify(conf);
    const rows = Recommender.scheduleOnlyEditions({ conferences: [conf] });
    expect(rows).toHaveLength(1);
    const hay = rows[0].hay;
    expect(matches(hay, "Fresh")).toBe(true);
    expect(matches(hay, "2029")).toBe(true);
    expect(matches(hay, "5月")).toBe(precision !== "not-announced");
    expect(matches(hay, "2030-05")).toBe(precision !== "not-announced");
    for (const query of ["2030-05-17", "17日", "金曜日", "2030年5月中旬", "2030年5月第3週"]) {
      expect(matches(hay, query), `${precision}: ${query}`).toBe(
        ["exact-range", "unverified"].includes(precision),
      );
    }
    if (precision === "month-only") expect(matches(hay, "月のみ判明")).toBe(true);
    if (precision === "not-announced") expect(matches(hay, "会期未発表")).toBe(true);
    expect(JSON.stringify(conf)).toBe(saved);
  }
});
it("keeps other-edition search from treating unknown source days as announced dates", () => {
  for (const precision of ["exact-range", "unverified", "month-only", "not-announced"]) {
    const conf = input(precision);
    conf.editions.unshift({
      ...conf.editions[0],
      id: "current",
      event_start: "2029-09-01",
      event_end: "2029-09-01",
      date_text: "",
      event_date_precision: "single-day",
      deadlines: [{ kind: "paper", utc: "2029-02-01T00:00:00Z", tz_raw: "UTC" }],
    });
    const rows = Recommender.candidateRows({ conferences: [conf] });
    expect(rows).toHaveLength(1);
    expect(matches(rows[0].hay, "2030-05-17"), precision).toBe(
      ["exact-range", "unverified"].includes(precision),
    );
    expect(matches(rows[0].hay, "2030-05"), precision).toBe(precision !== "not-announced");
  }
});

it("separates a dated submission deadline from the certainty of its own edition's event", () => {
  const conf = input("exact-range");
  conf.editions[0].deadlines.push({ kind: "paper", utc: "2029-02-01T00:00:00Z", tz_raw: "UTC" });
  for (const precision of ["exact-range", "month-only", "not-announced", "unverified"]) {
    conf.editions[0].event_date_precision = precision;
    const saved = JSON.stringify(conf);
    const rows = Recommender.candidateRows({ conferences: [conf] });
    expect(rows).toHaveLength(1);
    expect(matches(rows[0].hay, "2029-02-01")).toBe(true);
    expect(matches(rows[0].hay, "5月")).toBe(precision !== "not-announced");
    expect(matches(rows[0].hay, "木曜日")).toBe(true);
    expect(matches(rows[0].hay, "金曜日")).toBe(false);
    for (const query of ["2030-05-17", "17日"]) {
      expect(matches(rows[0].hay, query), `${precision}: ${query}`).toBe(
        ["exact-range", "unverified"].includes(precision),
      );
    }
    expect(JSON.stringify(conf)).toBe(saved);
  }
});

it("uses the same certainty-aware event search through a real MCP connection with fresh data", () => {
  const root = tempWork("kamiyobi-event-search-");
  for (const dir of ["src", "site"])
    cpSync(join(REPO_ROOT, dir), join(root, dir), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  mkdirSync(join(root, "data"));
  writeFileSync(
    join(root, "run.ts"),
    'import {runStdio} from "./src/mcp.ts";runStdio(Date.parse("2029-01-01T00:00:00Z"));',
  );
  const queries = ["5月", "2030-05-17", "17日", "木曜日", "2029-02-01"];
  for (const precision of ["exact-range", "month-only", "not-announced", "unverified"]) {
    const conf = input(precision);
    conf.editions[0].deadlines.push({ kind: "paper", utc: "2029-02-01T00:00:00Z", tz_raw: "UTC" });
    writeFileSync(join(root, "data/snapshot.json"), JSON.stringify({ conferences: [conf] }));
    const child = spawnSync(process.execPath, ["run.ts"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      input: `${queries
        .map((query, id) =>
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: {
              name: "search_deadlines",
              arguments: { scope: "all", kind: "paper", query },
            },
          }),
        )
        .join("\n")}\n`,
    });
    expect(child.status, child.stderr).toBe(0);
    const results = child.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).result);
    expect(results).toHaveLength(queries.length);
    for (let i = 0; i < queries.length; i++) {
      expect(results[i].isError).not.toBe(true);
      const expected =
        i >= 3 ||
        (i === 0
          ? precision !== "not-announced"
          : ["exact-range", "unverified"].includes(precision));
      expect(results[i].structuredContent.total, `${precision}: ${queries[i]}`).toBe(
        expected ? 1 : 0,
      );
    }
  }
});

it("keeps copied TBD and TBA labels searchable without reviving old calendar dates", () => {
  for (const label of ["TBD", "TBA"]) {
    const conf = input("not-announced");
    Object.assign(conf.editions[0], { event_start: "", event_end: "", date_text: `${label} 2029` });
    conf.editions[0].deadlines.push({ kind: "paper", utc: "2029-02-01T00:00:00Z", tz_raw: "UTC" });
    const rows = Recommender.candidateRows({ conferences: [conf] });
    expect(rows).toHaveLength(1);
    expect(matches(rows[0].hay, `${label} 2029`)).toBe(true);
    expect(matches(rows[0].hay, "会期未発表")).toBe(true);
    expect(matches(rows[0].hay, "2030-05-17")).toBe(false);
  }
});
