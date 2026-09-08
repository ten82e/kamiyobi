import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  likelyDuplicateVenues,
  main,
  newValidatorWarnings,
  normalizedTrack,
  summarizeCategoryChanges,
  summarizeDeadlineChanges,
  validateData,
  validateFile,
  validateFindings,
  validateProduction,
  validatorWarnings,
} from "../scripts/validate-data.ts";

describe("validate:data", () => {
  it("uses one warning identity for legacy extra and snapshot prefixes", () => {
    expect(
      validatorWarnings([
        "extra: ai4s-2026: category vocabulary diverges from title/full_name/scope; possible ai",
        "snapshot: ai4s-2026: category vocabulary diverges from title/full_name/scope; possible ai",
      ]),
    ).toEqual([
      expect.objectContaining({ code: "CATEGORY_VOCABULARY_DIVERGENCE", subject: "ai4s-2026" }),
      expect.objectContaining({ code: "CATEGORY_VOCABULARY_DIVERGENCE", subject: "ai4s-2026" }),
    ]);
  });

  it("rejects a missing or non-array conference collection", () => {
    expect(validateData({} as Record<string, unknown>).errors).toContain(
      "conferences must be an array",
    );
    expect(
      validateData({ conferences: {} } as unknown as Record<string, unknown>).errors,
    ).toContain("conferences must be an array");
    expect(validateData([] as unknown as Record<string, unknown>).errors).toContain(
      "top-level payload must be an object",
    );
  });

  it("fails closed on a new stable warning code and subject", () => {
    expect(
      newValidatorWarnings(
        ["venue: event date text is not structured"],
        [{ code: "EVENT_DATE_UNSTRUCTURED", subject: "other", status: "accepted" }],
      ),
    ).toEqual([expect.objectContaining({ code: "EVENT_DATE_UNSTRUCTURED", subject: "venue" })]);
  });
  it("fails closed when a known warning identity count increases", () => {
    expect(
      newValidatorWarnings(
        [
          "venue: event date text is not structured",
          "venue: event date text is not structured (second edition)",
        ],
        [{ code: "EVENT_DATE_UNSTRUCTURED", subject: "venue", count: 1, status: "accepted" }],
      ),
    ).toEqual([
      expect.objectContaining({ code: "EVENT_DATE_UNSTRUCTURED", subject: "venue", count: 2 }),
    ]);
  });

  it("reopens expired accepted findings", () => {
    const finding = {
      finding_id: "VF-test",
      code: "VALIDATOR_REVIEW",
      subject: "venue",
      severity: "review" as const,
      message: "venue: warning",
      count: 1,
      status: "accepted" as const,
      reviewed_by: "maintainer",
      reviewed_at: "2026-01-01T00:00:00Z",
      review_reason: "checked",
      evidence_ref: "data/manual.yaml#venue",
      expires_at: "2026-02-01T00:00:00Z",
    };
    expect(validateFindings([finding], Date.parse("2026-01-31T00:00:00Z"))).toEqual([]);
    expect(validateFindings([finding], Date.parse("2026-02-01T00:00:00Z"))).toContain(
      "VF-test: accepted finding has expired",
    );
  });

  it("does not let fixed findings suppress recurring warnings", () => {
    expect(
      newValidatorWarnings(
        ["venue: event date text is not structured"],
        [
          {
            code: "EVENT_DATE_UNSTRUCTURED",
            subject: "venue",
            count: 1,
            status: "fixed",
          },
        ],
      ),
    ).toEqual([
      expect.objectContaining({ code: "EVENT_DATE_UNSTRUCTURED", subject: "venue", count: 1 }),
    ]);
  });

  it("allows a fixed history entry beside a recurring accepted finding", () => {
    const shared = {
      code: "EVENT_DATE_UNSTRUCTURED",
      subject: "venue",
      severity: "review" as const,
      message: "venue: warning",
    };
    expect(
      validateFindings(
        [
          { ...shared, finding_id: "VF-fixed", status: "fixed", fixed_at: "2026-01-01T00:00:00Z" },
          {
            ...shared,
            finding_id: "VF-recurring",
            status: "accepted",
            reviewed_by: "maintainer",
            reviewed_at: "2026-02-01T00:00:00Z",
            review_reason: "reviewed again",
            evidence_ref: "data/manual.yaml#venue",
            expires_at: "2027-02-01T00:00:00Z",
          },
        ],
        Date.parse("2026-03-01T00:00:00Z"),
      ),
    ).toEqual([]);
  });
  it("matches a source-prefixed warning to an accepted canonical finding", () => {
    expect(
      newValidatorWarnings(
        [
          "snapshot: ai4s-2026: category vocabulary diverges from title/full_name/scope; possible ai",
        ],
        [{ code: "CATEGORY_VOCABULARY_DIVERGENCE", subject: "ai4s-2026", status: "accepted" }],
      ),
    ).toEqual([]);
  });

  it("does not rediscover a doubly-prefixed warning baseline", () => {
    expect(
      newValidatorWarnings(
        ["overrides: overrides:mmm/2027: event date text is not structured"],
        [
          {
            code: "EVENT_DATE_UNSTRUCTURED",
            subject: "overrides:mmm/2027",
            status: "accepted",
          },
        ],
      ),
    ).toEqual([]);
  });

  it("does not let a status-less legacy entry suppress a warning", () => {
    expect(
      newValidatorWarnings(
        ["venue: event date text is not structured"],
        [{ code: "EVENT_DATE_UNSTRUCTURED", subject: "venue" } as never],
      ),
    ).toHaveLength(1);
  });

  it("accepts explicit not-announced event date states and exact placeholders", () => {
    for (const edition of [
      { year: 2027, id: "status", event_date_status: "not-announced" },
      { year: 2027, id: "tbd", date_text: "TBD" },
      { year: 2027, id: "tbd-year", date_text: "TBD 2027" },
      { year: 2027, id: "not-announced", date_text: "not announced" },
    ]) {
      const result = validateData({ conferences: [{ key: "venue", editions: [edition] }] });
      expect(result.warnings).not.toContain(
        expect.stringContaining("event date text is not structured"),
      );
    }
  });
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

it("rejects a truncated leading year and same-year local duplicates", () => {
  const truncated = validateData({
    conferences: [
      {
        key: "icaidm-2026",
        title: "ICAIDM 2026",
        full_name:
          "026 3rd International Conference on Artificial Intelligence and Digital Management",
        editions: [{ year: 2026, id: "icaidm-202626" }],
      },
    ],
  });
  expect(truncated.errors).toContain("icaidm-2026: full_name appears truncated");
  expect(
    likelyDuplicateVenues([
      {
        key: "icbda-2027",
        title: "IEEE ICBDA 2027",
        full_name: "IEEE 12th International Conference on Big Data Analytics (ICBDA 2027)",
        editions: [{ year: 2027 }],
      },
      {
        key: "icbda2027",
        title: "ICBDA2027",
        full_name: "12th International Conference on Big Data Analytics",
        editions: [{ year: 2027 }],
      },
    ]),
  ).toEqual(["icbda-2027 / icbda2027"]);
  expect(
    validateData({
      conferences: [
        {
          key: "icbda-2027",
          title: "IEEE ICBDA 2027",
          full_name: "IEEE 12th International Conference on Big Data Analytics (ICBDA 2027)",
          editions: [{ year: 2027, id: "icbda-2027" }],
        },
        {
          key: "icbda2027",
          title: "ICBDA2027",
          full_name: "12th International Conference on Big Data Analytics",
          editions: [{ year: 2027, id: "icbda2027" }],
        },
      ],
    }).errors,
  ).toContain("duplicate venue edition icbda-2027 / icbda2027");
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

  const monthEnvelope = validateData({
    conferences: [
      {
        key: "month-envelope",
        categories: ["systems"],
        editions: [
          {
            year: 2027,
            id: "month-envelope-2027",
            date_text: "March-April, 2027",
            event_start: "2027-03-01",
            event_end: "2027-04-30",
          },
        ],
      },
    ],
  });
  expect(monthEnvelope.errors).toEqual([]);
  expect(monthEnvelope.warnings).toContain(
    "month-envelope/month-envelope-2027: event range exceeds 31 days",
  );

  // #724: 和文の月のみ表記は「年」に続く月番号 (例: "2026年11月" の "11") を
  // 日番号と誤認する hasDayNumber の欠陥により、英文と同じ意味の入力でも
  // 常に error (exit 1) に落ちていた (data/extra.yaml の実際の和文ソースが
  // 生成する入力形。src/model.ts の parseJapaneseRange が対応する定型)。
  const monthEnvelopeJp = validateData({
    conferences: [
      {
        key: "month-envelope-jp",
        categories: ["systems"],
        editions: [
          {
            year: 2027,
            id: "month-envelope-jp-2027",
            date_text: "2027年3月下旬～4月上旬（詳細未定）",
            event_start: "2027-03-01",
            event_end: "2027-04-30",
          },
        ],
      },
    ],
  });
  expect(monthEnvelopeJp.errors).toEqual([]);
  expect(monthEnvelopeJp.warnings).toContain(
    "month-envelope-jp/month-envelope-jp-2027: event range exceeds 31 days",
  );
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

  // #740: review_state: "unreviewed" / "unconfirmed" must NOT trigger isAutoPromoted
  const unreviewed = validateData({
    conferences: [
      {
        key: "unreviewed-conf",
        title: "Systems Workshop",
        categories: ["systems"],
        review_state: "unreviewed",
        editions: [],
      },
      {
        key: "unconfirmed-conf",
        title: "Systems Workshop 2",
        categories: ["systems"],
        review_state: "unconfirmed",
        editions: [],
      },
    ],
  });
  expect(unreviewed.warnings).not.toEqual(
    expect.arrayContaining([
      expect.stringContaining("auto-promoted categories lack category_evidence"),
    ]),
  );

  // #740: date_text: "TBA", "To be announced", "未定" must not trigger "event date text is not structured"
  const notAnnounced = validateData({
    conferences: [
      {
        key: "tba-conf",
        categories: ["systems"],
        editions: [
          { year: 2026, id: "tba-2026", date_text: "TBA" },
          { year: 2026, id: "tba2-2026", date_text: "To be announced" },
          { year: 2026, id: "tba3-2026", date_text: "未定" },
        ],
      },
    ],
  });
  expect(notAnnounced.warnings).not.toEqual(
    expect.arrayContaining([expect.stringContaining("event date text is not structured")]),
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
  expect(summary.summary).toContain("- changed: +security (unknown) -systems");
});

it("classifies deadline semantic risks deterministically", () => {
  const payload = (date: string, precision = "exact", sourceClass = "official-cfp") => ({
    conferences: [
      {
        key: "venue",
        editions: [
          {
            id: "venue27",
            deadlines: [
              {
                kind: "paper",
                precision,
                ...(precision === "date-only" ? { local_date: date } : { utc: date }),
                evidence: [{ sourceClass }],
              },
            ],
          },
        ],
      },
    ],
  });
  const result = summarizeDeadlineChanges(
    payload("2026-09-17T00:00:00Z"),
    payload("2026-09-10", "date-only", "aggregator"),
  );
  expect(result.changes[0]).toMatchObject({ risk: "critical", precisionAfter: "date-only" });
  expect(result.summary).toContain("risk: critical");
  const classOnly = (source_class: string) => ({
    conferences: [
      {
        key: "venue",
        editions: [
          {
            id: "venue27",
            deadlines: [
              {
                kind: "paper",
                precision: "exact",
                utc: "2026-09-17T00:00:00Z",
                evidence: [{ source_class, source_name: "ccfddl" }],
              },
            ],
          },
        ],
      },
    ],
  });
  expect(
    summarizeDeadlineChanges(classOnly("official-cfp"), classOnly("aggregator")).changes[0],
  ).toMatchObject({ risk: "high", evidenceBefore: "official-cfp", evidenceAfter: "aggregator" });
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

describe("month envelope validation fixes (#746)", () => {
  it("treats month-only dates with edition ordinals as envelopes (warning, not error)", () => {
    const res = validateData({
      conferences: [
        {
          key: "conf-ord",
          title: "Conf Ord",
          editions: [
            {
              id: "conf-ord-2026",
              year: 2026,
              date_text: "October 2026 (25th Annual Conference)",
              event_start: "2026-10-01",
              event_end: "2026-11-05", // > 31 days span
              event_date_precision: "month-only",
            },
          ],
        },
      ],
    });
    // Should be warning, not error
    expect(res.errors).toEqual([]);
    expect(res.warnings).toContain("conf-ord/conf-ord-2026: event range exceeds 31 days");
  });

  it("treats multi-month date text with explicit days as error when exceeding 31 days", () => {
    const res = validateData({
      conferences: [
        {
          key: "conf-days",
          title: "Conf Days",
          editions: [
            {
              id: "conf-days-2026",
              year: 2026,
              date_text: "October 1 - December 15, 2026",
              event_start: "2026-10-01",
              event_end: "2026-12-15",
            },
          ],
        },
      ],
    });
    expect(res.errors).toContain("conf-days/conf-days-2026: event range exceeds 31 days");
  });

  describe("validateProduction venueKeys collection (#748)", () => {
    it("includes manual and curated inputs in venueKeys so primary matches them without error", () => {
      const dir = mkdtempSync(join(tmpdir(), "kamiyobi-val-prod-"));
      mkdirSync(join(dir, "data"), { recursive: true });
      writeFileSync(join(dir, "config.yaml"), "categories:\n  systems: Systems\n");
      writeFileSync(join(dir, "data", "extra.yaml"), "conferences: []\n");
      writeFileSync(join(dir, "data", "overrides.yaml"), "conferences: {}\n");
      writeFileSync(join(dir, "data", "snapshot.json"), JSON.stringify({ conferences: [] }));
      writeFileSync(
        join(dir, "data", "primary.yaml"),
        "conferences:\n  manual-venue:\n    year: 2026\n",
      );
      writeFileSync(
        join(dir, "data", "primary_overrides.yaml"),
        "conferences:\n  manual-venue:\n    title: Manual Venue\n",
      );
      // Venue defined in manual.yaml
      writeFileSync(
        join(dir, "data", "manual.yaml"),
        "conferences:\n  - key: manual-venue\n    title: Manual Venue\n    categories: [systems]\n    editions: []\n",
      );

      const res = validateProduction(dir);
      const venueMissingErrors = res.errors.filter((e) => e.includes("venue key missing"));
      expect(venueMissingErrors).toEqual([]);
      rmSync(dir, { recursive: true, force: true });
    });

    it("main respects findings baseline when validating a single file (#752)", () => {
      const exitCode = main(["data/manual.yaml"]);
      expect(exitCode).toBe(0);
    });

    it("allows cross-year date_text when event spans across year boundary (#758)", () => {
      const res = validateData({
        conferences: [
          {
            key: "winter-conf",
            title: "Winter Conference",
            categories: ["systems"],
            editions: [
              {
                year: 2026,
                id: "winter-conf-2026",
                date_text: "December 28, 2026 - January 3, 2027",
                deadlines: [
                  {
                    kind: "paper",
                    date: "2026-10-01",
                    precision: "date-only",
                  },
                ],
              },
            ],
          },
        ],
      });
      const yearConflictErrors = res.errors.filter((e) => e.includes("conflicts with edition"));
      expect(yearConflictErrors).toEqual([]);
    });

    it.each([
      "January 3, 2027",
      "2026 / 2027 TBD",
      "January 3, 2027 - December 28, 2026",
      "January 1, 2026 - January 3, 2027",
      "December 32, 2026 - January 3, 2027",
    ])("rejects unsupported cross-year event text: %s (#758)", (dateText) => {
      const res = validateData({
        conferences: [
          {
            key: "mismatched-conf",
            title: "Mismatched Conference",
            categories: ["systems"],
            editions: [
              {
                year: 2026,
                id: "mismatched-conf-2026",
                date_text: dateText,
                deadlines: [
                  {
                    kind: "paper",
                    date: "2026-10-01",
                    precision: "date-only",
                  },
                ],
              },
            ],
          },
        ],
      });
      expect(res.errors).toContain(
        "mismatched-conf/mismatched-conf-2026: date_text year 2027 conflicts with edition 2026",
      );
    });
  });
});
