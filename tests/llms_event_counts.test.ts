import { expect, it } from "vitest";
import { toLlmsTxt } from "../src/build.ts";

const zero = {
  "exact-range": 0,
  "single-day": 0,
  "month-only": 0,
  "split-dates": 0,
  unverified: 0,
  "not-announced": 0,
};
type Counts = typeof zero;
type Edition = {
  event_date_precision?: string;
  event_start?: string | null;
  deadlines?: unknown[];
};
function edition(precision: string, start?: string | null): Edition {
  return { event_date_precision: precision, event_start: start };
}
function data(...groups: Edition[][]) {
  return { conferences: groups.map((editions) => ({ editions })) };
}
function summary(input?: Record<string, unknown> | null) {
  const lines = toLlmsTxt({}, undefined, input)
    .split("\n")
    .filter((line) => line.includes("- event_date_precision:"));
  expect(lines).toHaveLength(1);
  const matches = [...lines[0].matchAll(/'([^']+)'（[^）]*・([\d,]+) 版）/g)];
  expect(matches).toHaveLength(6);
  const counts = Object.fromEntries(
    matches.map((match) => [match[1], Number(match[2].replaceAll(",", ""))]),
  ) as Counts;
  const other = /以外の ([\d,]+) 版のうち、([\d,]+) 版には event_start/.exec(lines[0]);
  expect(other, "the date coverage summary must be present").not.toBeNull();
  return {
    counts,
    other: Number(other![1].replaceAll(",", "")),
    dated: Number(other![2].replaceAll(",", "")),
    line: lines[0],
  };
}
function assertCounts(
  input: Record<string, unknown> | null | undefined,
  counts: Counts,
  other: number,
  dated: number,
) {
  const result = summary(input);
  expect(result.counts).toEqual(counts);
  expect(result.other).toBe(other);
  expect(result.dated).toBe(dated);
  return result;
}
it.each([undefined, null, {}, data([])])(
  "reports zero counts without generated data for %j",
  (input) => {
    assertCounts(input, zero, 0, 0);
  },
);
it("counts all editions across conferences, keeps six distinct classes, and ignores deadlines", () => {
  const input = data(
    [
      edition("exact-range", "2028-01-01"),
      ...Array.from({ length: 2 }, () => edition("single-day", "2028-02-01")),
    ],
    [edition("month-only", "2028-03-01"), edition("month-only", "  "), edition("month-only", null)],
    [
      ...Array.from({ length: 4 }, () => edition("split-dates")),
      ...Array.from({ length: 5 }, () => edition("unverified")),
      ...Array.from({ length: 6 }, () => edition("not-announced")),
    ],
    [],
  );
  input.conferences[0].editions[0].deadlines = Array.from({ length: 99 }, () => ({
    kind: "paper",
  }));
  assertCounts(
    input,
    {
      "exact-range": 1,
      "single-day": 2,
      "month-only": 3,
      "split-dates": 4,
      unverified: 5,
      "not-announced": 6,
    },
    18,
    1,
  );
});
it("updates counts when editions are added and removed from the same input object", () => {
  const input = data([edition("unverified")], [edition("month-only", "2028-03-01")]);
  assertCounts(input, { ...zero, unverified: 1, "month-only": 1 }, 2, 1);
  input.conferences[0].editions.push(edition("unverified", "2028-04-01"), edition("not-announced"));
  assertCounts(input, { ...zero, unverified: 2, "month-only": 1, "not-announced": 1 }, 4, 2);
  input.conferences[1].editions.pop();
  assertCounts(input, { ...zero, unverified: 2, "not-announced": 1 }, 3, 1);
});
it("moves an edition between precision classes and updates both coverage counts", () => {
  const event = edition("unverified", "2028-05-01");
  const input = data([event, edition("split-dates", "2028-06-01")]);
  assertCounts(input, { ...zero, unverified: 1, "split-dates": 1 }, 2, 2);
  event.event_date_precision = "exact-range";
  assertCounts(input, { ...zero, "exact-range": 1, "split-dates": 1 }, 1, 1);
  event.event_date_precision = "single-day";
  assertCounts(input, { ...zero, "single-day": 1, "split-dates": 1 }, 1, 1);
  event.event_date_precision = "month-only";
  assertCounts(input, { ...zero, "month-only": 1, "split-dates": 1 }, 2, 2);
});
it("updates date coverage for non-exact editions while excluding exact ranges and single days", () => {
  const event = edition("not-announced");
  const input = data([
    event,
    edition("exact-range", "2028-01-01"),
    edition("single-day", "2028-02-01"),
  ]);
  const counts = { ...zero, "not-announced": 1, "exact-range": 1, "single-day": 1 };
  assertCounts(input, counts, 1, 0);
  event.event_start = "2028-07-01";
  assertCounts(input, counts, 1, 1);
  event.event_start = " \t ";
  assertCounts(input, counts, 1, 0);
  event.event_start = null;
  assertCounts(input, counts, 1, 0);
});
it("formats four-digit category and coverage counts with grouping separators", () => {
  const input = data(
    Array.from({ length: 1001 }, () => edition("exact-range")),
    Array.from({ length: 1002 }, () => edition("unverified", "2028-01-01")),
  );
  const result = assertCounts(
    input,
    { ...zero, "exact-range": 1001, unverified: 1002 },
    1002,
    1002,
  );
  expect(result.line).toContain("開始と終了が確定・1,001 版");
  expect(result.line).toContain("未確認・1,002 版");
  expect(result.line).toContain("以外の 1,002 版のうち、1,002 版には event_start");
});
it("does not mutate the supplied editions or their order while generating counts", () => {
  const input = data([
    edition("month-only", "2028-01-01"),
    edition("exact-range"),
    edition("unverified", null),
  ]);
  const original = structuredClone(input);
  assertCounts(input, { ...zero, "month-only": 1, "exact-range": 1, unverified: 1 }, 2, 1);
  expect(input).toEqual(original);
});
