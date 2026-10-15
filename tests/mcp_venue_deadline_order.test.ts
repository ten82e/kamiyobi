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
const root = mkdtempSync(join(tmpdir(), "kamiyobi-venue-deadline-order-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const dir of ["src", "site"]) cpSync(join(repo, dir), join(root, dir), { recursive: true });
symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
writeFileSync(join(root, "package.json"), '{"type":"module"}');
mkdirSync(join(root, "data"));
const edition = (id: string, deadline: Record<string, unknown>) => ({
  id,
  year: 2029,
  deadlines: [{ kind: "paper", tz_raw: "UTC", ...deadline }],
});
const forecast = {
  point_estimate: "2029-06-01T02:00:00Z",
  window_start: "2029-05-25",
  window_end: "2029-06-08",
  source_editions: [2027, 2028],
  method: "median-interval",
  confidence: "low",
};
const predicted = {
  ...edition("predicted", { utc: forecast.point_estimate }),
  estimated: true,
  estimate: forecast,
};
writeFileSync(
  join(root, "data/snapshot.json"),
  JSON.stringify({
    conferences: [
      {
        key: "fresh",
        title: "Fresh",
        categories: [],
        rank: {},
        editions: [
          edition("past-latest", { utc: "2029-05-31T23:00:00Z" }),
          edition("future-late", { utc: "2029-06-03T00:00:00Z" }),
          edition("past-old", { utc: "2029-05-01T00:00:00Z" }),
          edition("uncertain-today", {
            precision: "date-only",
            local_date: "2029-06-01",
            earliest_utc: "2029-05-31T10:00:00Z",
            latest_utc: "2029-06-02T11:59:59.999Z",
          }),
          edition("future-early", { utc: "2029-06-01T06:00:00Z" }),
          edition("notification", { kind: "notification", utc: "2029-06-01T01:00:00Z" }),
        ],
      },
      {
        key: "mixed",
        title: "Mixed",
        categories: [],
        rank: {},
        editions: [
          predicted,
          edition("recorded-future", { utc: "2029-06-03T00:00:00Z" }),
          {
            ...edition("predicted-past", { utc: "2029-05-31T23:00:00Z" }),
            estimated: true,
            estimate: { ...forecast, point_estimate: "2029-05-31T23:00:00Z" },
          },
          edition("recorded-past", { utc: "2029-05-30T00:00:00Z" }),
        ],
      },
      {
        key: "only-predicted",
        title: "Only Predicted",
        categories: [],
        rank: {},
        editions: [
          predicted,
          {
            ...edition("predicted-notification", {
              kind: "notification",
              utc: "2029-06-01T01:00:00Z",
            }),
            estimated: true,
            estimate: { ...forecast, point_estimate: "2029-06-01T01:00:00Z" },
          },
        ],
      },
    ],
  }),
);
writeFileSync(
  join(root, "run.ts"),
  'import {runStdio} from "./src/mcp.ts";runStdio(Date.parse(process.argv[2]));',
);
function call(now: string, key = "fresh") {
  for (const dir of ["public", ".cache"]) expect(existsSync(join(root, dir))).toBe(false);
  const child = spawnSync(process.execPath, ["run.ts", now], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "venue_info", arguments: { key } } })}\n`,
  });
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout.trim()).result;
  expect(result.isError).not.toBe(true);
  return { data: result.structuredContent, text: result.content[0].text as string };
}
it("uses the same future-first display order in text, structured deadlines and next-submission selection", () => {
  const { data, text } = call("2029-06-01T00:00:00Z");
  const order = [
    "notification",
    "uncertain-today",
    "future-early",
    "future-late",
    "past-old",
    "past-latest",
  ];
  expect(data.rows.map((r: { edition_id: string }) => r.edition_id)).toEqual(order);
  const lines = text.split("\n").filter((line) => /^2029-/.test(line));
  expect(lines).toHaveLength(6);
  expect(lines.map((line) => /Fresh（([^）]+)）/.exec(line)?.[1])).toEqual(order);
  expect(data).toMatchObject({
    deadline_total: 6,
    upcoming_deadline_total: 4,
    past_deadline_total: 2,
    next_submission: {
      edition_id: "uncertain-today",
      precision: "date-only",
      utc: null,
      local_date: "2029-06-01",
      uncertainty: { state: "uncertain-on-date" },
    },
    latest_past_submission: { edition_id: "past-latest" },
  });
  const next = text.split("\n").find((line) => line.startsWith("次の投稿締切:"));
  expect(next).toContain("Fresh（uncertain-today）");
  expect(next).toContain("すでに終了している可能性");
});
it("updates counts and summaries when uncertain and exact deadlines all become past", () => {
  const { data, text } = call("2029-06-04T00:00:00Z");
  expect(data.rows.map((r: { edition_id: string }) => r.edition_id)).toEqual([
    "past-old",
    "past-latest",
    "notification",
    "uncertain-today",
    "future-early",
    "future-late",
  ]);
  expect(data).toMatchObject({
    deadline_total: 6,
    upcoming_deadline_total: 0,
    past_deadline_total: 6,
    next_submission: null,
    latest_past_submission: { edition_id: "future-late" },
  });
  const next = text.split("\n").find((line) => line.startsWith("次の投稿締切:"));
  expect(next).toContain("今後の収録にありません");
  expect(next).toContain("Fresh（future-late）");
});

it("separates recorded submissions and forecasts without losing estimated rows or uncertainty windows", () => {
  const { data, text } = call("2029-06-01T00:00:00Z", "mixed");
  expect(data.next_submission).toMatchObject({ edition_id: "recorded-future", estimated: false });
  expect(data.latest_past_submission).toMatchObject({
    edition_id: "recorded-past",
    estimated: false,
  });
  expect(data.next_estimated_submission).toMatchObject({
    edition_id: "predicted",
    estimated: true,
    estimate: forecast,
  });
  expect(data.rows).toHaveLength(4);
  expect(data.rows.filter((row: { estimated: boolean }) => row.estimated)).toHaveLength(2);
  const next = text.split("\n").find((line) => line.startsWith("次の投稿締切:"));
  expect(next).toContain("Mixed（recorded-future）");
  expect(next).not.toContain("（推定）");
  const predictedLine = text.split("\n").find((line) => line.startsWith("次の投稿締切（推定）:"));
  expect(predictedLine).toContain("Mixed（predicted）");
  expect(predictedLine).toContain("推定期間");
});
it("leaves recorded summaries null when only forecasts exist and expires the forecast as time advances", () => {
  const before = call("2029-06-01T00:00:00Z", "only-predicted");
  expect(before.data).toMatchObject({
    next_submission: null,
    latest_past_submission: null,
    next_estimated_submission: { edition_id: "predicted", estimated: true },
  });
  expect(before.text.split("\n").find((line) => line.startsWith("次の投稿締切:"))).toContain(
    "推定を除く",
  );
  expect(before.data.rows).toHaveLength(2);
  const after = call("2029-06-10T00:00:00Z", "only-predicted");
  expect(after.data).toMatchObject({
    next_submission: null,
    latest_past_submission: null,
    next_estimated_submission: null,
  });
  expect(after.data.rows).toHaveLength(2);
  expect(after.text).not.toContain("次の投稿締切（推定）:");
});
