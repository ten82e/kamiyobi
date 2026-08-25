import { describe, expect, it } from "vitest";
import {
  normalizedTrack,
  summarizeCategoryChanges,
  validateData,
  validateFile,
  validateProduction,
} from "../scripts/validate-data.ts";

describe("validate:data", () => {
  it("rejects precision and conflicting slot errors and supports clean payloads", () => {
    const result = validateData({
      conferences: [
        {
          key: "x",
          title: "X",
          full_name: "X",
          editions: [
            {
              year: 2027,
              id: "x27",
              deadlines: [
                {
                  kind: "paper",
                  label: "Paper submission",
                  utc: "2026-09-01T00:00:00Z",
                  tz_raw: "UTC",
                  evidence: [{ sourceClass: "official-cfp" }],
                },
                {
                  kind: "paper",
                  label: "Paper submission",
                  utc: "2026-09-02T00:00:00Z",
                  tz_raw: "UTC",
                  evidence: [{ sourceClass: "official-cfp" }],
                },
                {
                  kind: "abstract",
                  label: "Abstract",
                  precision: "date-only",
                  local_date: "2026-09-01",
                  tz_raw: "UTC",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(result.errors).toContain("x/x27: conflicting deadline slot paper/1/");
    expect(result.errors).toContain("x/x27: date-only has time/timezone");
  });
});

it("detects edition identity, event integrity, swaps and string corruption deterministically", () => {
  const result = validateData({
    conferences: [
      {
        key: "bad-2026",
        title: "Bad Conference 20",
        full_name: "Bad 2026\u202e\ufffd",
        editions: [
          {
            year: 2027,
            id: "bad-2026",
            date_text: "May 2, 2026",
            event_start: "2027-05-03",
            deadlines: [
              { kind: "paper", label: "Paper", utc: "2027-05-04T00:00:00Z", tz_raw: "UTC" },
              {
                kind: "supplementary",
                label: "Broken",
                utc: "2027-05-04T00:00:00",
                tz_raw: "unconfirmed",
              },
            ],
          },
          { year: 2027, id: "bad-2026", event_start: "2027-05-04", event_end: "2027-05-03" },
        ],
      },
    ],
  });
  expect(result.errors).toEqual(
    expect.arrayContaining([
      "bad-2026: full_name contains invisible/replacement characters",
      "bad-2026: full_name year 2026 conflicts with edition 2027",
      "bad-2026: key year 2026 conflicts with edition 2027",
      "bad-2026: title appears truncated",
      "bad-2026/bad-2026: id year conflicts with edition year",
      "bad-2026/bad-2026: date_text year 2026 conflicts with edition 2027",
      "bad-2026/bad-2026: event range is incomplete",
      "bad-2026/bad-2026: event range is reversed",
      "bad-2026/bad-2026: deadline appears to be an event date (paper)",
      "bad-2026/bad-2026: deadline appears to be an event date (supplementary)",
      "bad-2026/bad-2026: exact has unconfirmed timezone",
      "bad-2026: duplicate edition id bad-2026",
    ]),
  );
  expect(normalizedTrack(undefined, "Paper submission", "paper")).toBe("");
  expect(normalizedTrack("Industry", "Paper submission", "paper")).toBe("industry");
});

it("keeps a valid multi-edition name and different round/track slots as negative controls", () => {
  const result = validateData({
    conferences: [
      {
        key: "iso-27001",
        title: "OK 2027",
        full_name: "OK 2027",
        editions: [
          { year: 2026, id: "ok-2026", event_start: "2026-06-01", event_end: "2026-06-02" },
          {
            year: 2027,
            id: "ok-2027",
            event_start: "2027-06-01",
            event_end: "2027-06-02",
            deadlines: [
              {
                kind: "paper",
                label: "Paper",
                track: "regular",
                round: 1,
                utc: "2027-05-01T00:00:00Z",
                tz_raw: "UTC",
              },
              {
                kind: "paper",
                label: "Paper",
                track: "industry",
                round: 1,
                utc: "2027-05-02T00:00:00Z",
                tz_raw: "UTC",
              },
              {
                kind: "paper",
                label: "Paper",
                round: 2,
                utc: "2027-05-03T00:00:00Z",
                tz_raw: "UTC",
              },
            ],
          },
        ],
      },
    ],
  });
  expect(result.errors).toEqual([]);
  expect(normalizedTrack(undefined, "Full Paper Submission", "paper")).toBe("");
});

it.each(["greenai2027", "ieeebc27", "eaai-27", "ifs-27"])(
  "detects a year suffix in key %s",
  (key) => {
    const result = validateData({
      conferences: [{ key, editions: [{ year: 2026, id: "edition-2026", deadlines: [] }] }],
    });
    expect(result.errors).toContain(`${key}: key year 2027 conflicts with edition 2026`);
  },
);

it("rejects glued id years and exact/date-only precision mixtures", () => {
  const result = validateData({
    conferences: [
      {
        key: "precision",
        editions: [
          {
            year: 2027,
            id: "evomusart-202726",
            deadlines: [
              {
                precision: "bogus",
                utc: "2027-01-03T00:00:00Z",
                tz_raw: "UTC",
                kind: "notification",
              },
              {
                precision: "exact",
                utc: "2026-02-30T23:59:00Z",
                tz_raw: "UTC",
                kind: "camera_ready",
              },
              { precision: "date-only", local_date: "2027-01-01 23:59", kind: "paper" },
              {
                precision: "exact",
                utc: "2027-01-02T00:00:00Z",
                local_date: "2027-01-02",
                tz_raw: "Mars/Phobos",
                kind: "abstract",
              },
            ],
          },
        ],
      },
    ],
  });
  expect(result.errors).toEqual(
    expect.arrayContaining([
      "precision/evomusart-202726: id year conflicts with edition year",
      "precision/evomusart-202726: unknown deadline precision bogus",
      "precision/evomusart-202726: invalid exact instant",
      "precision/evomusart-202726: date-only has time/timezone",
      "precision/evomusart-202726: exact mixes local_date with instant",
      "precision/evomusart-202726: exact has unconfirmed timezone",
    ]),
  );
});

it("uses model instant parsing for offsets and accepts a short year-crossing event", () => {
  const valid = validateData({
    conferences: [
      {
        key: "offset",
        title: "Offset Systems",
        full_name: "Offset Systems",
        categories: ["systems"],
        editions: [
          {
            year: 2027,
            id: "offset-2027",
            date_text: "2027-12-31..2028-01-02",
            event_start: "2027-12-31",
            event_end: "2028-01-02",
            deadlines: [
              {
                kind: "paper",
                label: "Paper",
                utc: "2027-12-01T12:00:00+09:00",
                tz_raw: "UTC+09:00",
              },
              {
                kind: "abstract",
                label: "Abstract",
                utc: "2027-12-02T03:00:00Z",
                tz_raw: "UTC",
              },
            ],
          },
        ],
      },
    ],
  });
  expect(valid.errors).toEqual([]);

  const conflict = validateData({
    conferences: [
      {
        key: "conflict",
        categories: ["systems"],
        editions: [
          {
            year: 2027,
            id: "conflict-2027",
            deadlines: [
              {
                kind: "paper",
                label: "Paper",
                date: "2027-12-01T12:00:00+09:00",
                tz_raw: "UTC",
              },
            ],
          },
        ],
      },
    ],
  });
  expect(conflict.errors).toContain(
    "conflict/conflict-2027: exact timezone conflicts with embedded offset",
  );

  const tooLong = validateData({
    conferences: [
      {
        key: "too-long",
        categories: ["systems"],
        editions: [
          {
            year: 2027,
            id: "too-long-2027",
            event_start: "2027-01-01",
            event_end: "2027-02-03",
          },
        ],
      },
    ],
  });
  expect(tooLong.errors).toContain("too-long/too-long-2027: event range exceeds 31 days");
});

it("checks configured categories and reports promotion/evidence and vocabulary drift as warnings", () => {
  const empty = validateData({
    conferences: [{ key: "empty", categories: [], editions: [] }],
  });
  expect(empty.errors).toContain("empty: categories is empty or invalid");

  const unknown = validateData({
    conferences: [{ key: "unknown", categories: ["not-configured"], editions: [] }],
  });
  expect(unknown.errors).toContain("unknown: unknown category not-configured");

  const promoted = validateData({
    conferences: [
      {
        key: "promoted",
        title: "International Machine Learning Workshop",
        full_name: "International Machine Learning Workshop",
        scope: "Machine Learning",
        categories: ["security"],
        review_state: "reviewed",
        editions: [],
      },
    ],
  });
  expect(promoted.errors).toEqual([]);
  expect(promoted.warnings).toEqual(
    expect.arrayContaining([
      "promoted: auto-promoted categories lack category_evidence",
      "promoted: category vocabulary diverges from title/full_name/scope; possible ai",
    ]),
  );
});

it("summarizes category changes as a pure data-only comparison", () => {
  const before = {
    conferences: [
      { key: "changed", categories: ["systems", "ai"] },
      { key: "same", categories: ["hpc"] },
      { key: "new", categories: [] },
    ],
  };
  const after = {
    conferences: [
      { key: "changed", categories: ["ai", "security"] },
      { key: "new", categories: ["networking"] },
    ],
  };
  const summary = summarizeCategoryChanges(before, after);
  expect(summary.changes).toEqual([
    {
      key: "changed",
      before: ["ai", "systems"],
      after: ["ai", "security"],
      added: ["security"],
      removed: ["systems"],
    },
    {
      key: "new",
      before: [],
      after: ["networking"],
      added: ["networking"],
      removed: [],
    },
  ]);
  expect(summary.added).toBe(2);
  expect(summary.removed).toBe(1);
  expect(summary.summary).toContain("- changed: +security -systems");
});

it("validates every production input by default", () => {
  expect(validateProduction().errors).toEqual([]);
});

it("accepts each production YAML input explicitly", () => {
  for (const file of [
    "data/extra.yaml",
    "data/overrides.yaml",
    "data/primary.yaml",
    "data/primary_overrides.yaml",
  ])
    expect(validateFile(file).errors).toEqual([]);
});
