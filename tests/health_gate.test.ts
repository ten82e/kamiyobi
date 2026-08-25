import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  deadlineSlotId,
  evaluateHealthGate,
  HEALTH_SCHEMA_VERSION,
  type HealthDeadlineRef,
  type HealthReport,
  healthMarkdown,
  healthReport,
  toJson,
} from "../src/build.ts";
import { mergeDeadlineSlots } from "../src/merge.ts";
import { deadlinesOf as localDeadlines } from "../src/sources/local.ts";
import { resolvePrimaryObservations } from "../src/sources/primary.ts";
import { makeConference, makeEdition, REPO_ROOT } from "./helpers.ts";

const report = {
  schema_version: 1,
  generated_at: "2026-08-09T00:00:00Z",
  profile_hash: "profile-a",
  source_failures: [],
  snapshot_fallback: false,
  confirmed_future_deadlines: 10,
  confirmed_deadlines: 10,
  required_venues: { rtss: "present" },
  parse_warning_count: 1,
  parse_warnings: { one: 1 },
  category_counts: { systems: 1 },
  category_distribution: { systems: 1 },
};

it("health-gate reads last-known-good and writes the next explicit artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-health-gate-"));
  const current = join(dir, "health.json");
  const previous = join(dir, "last-known-good.json");
  const next = join(dir, "next-last-known-good.json");
  writeFileSync(current, `${JSON.stringify(report)}\n`);
  writeFileSync(previous, `${JSON.stringify(report)}\n`);

  const passed = spawnSync(process.execPath, ["scripts/health-gate.ts", current, previous, next], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  expect(passed.status, passed.stderr).toBe(0);
  expect(JSON.parse(readFileSync(next, "utf8"))).toEqual(report);

  const blocked = join(dir, "blocked.json");
  const blockedNext = join(dir, "blocked-next.json");
  writeFileSync(blocked, `${JSON.stringify({ ...report, source_failures: ["ccfddl"] })}\n`);
  const failed = spawnSync(
    process.execPath,
    ["scripts/health-gate.ts", blocked, previous, blockedNext],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  expect(failed.status).toBe(1);
  expect(existsSync(blockedNext)).toBe(false);
});

const SLOT = deadlineSlotId("venue", "venue26", "paper", 1, "");
const TRACK_SLOT = deadlineSlotId("venue", "venue26", "paper", 1, "industry");
const ROUND_SLOT = deadlineSlotId("venue", "venue26", "paper", 2, "");

function exact(atUtc: string, extra: Partial<HealthDeadlineRef> = {}): HealthDeadlineRef {
  return { deadline_id: SLOT, at_utc: atUtc, edition_year: 2026, ...extra };
}

function dateOnly(localDate: string, extra: Partial<HealthDeadlineRef> = {}): HealthDeadlineRef {
  return { deadline_id: SLOT, local_date: localDate, edition_year: 2026, ...extra };
}

function health(refs: HealthDeadlineRef[], generatedAt = "2026-08-10T00:00:00Z"): HealthReport {
  return {
    schema_version: 2,
    generated_at: generatedAt,
    profile_hash: "profile",
    source_status: {},
    source_failures: [],
    tracked_venues: 1,
    future_confirmed_venues: 1,
    future_estimated_venues: 0,
    confirmed_deadlines: refs.length,
    estimated_deadlines: 0,
    confirmed_future_deadlines: refs.length,
    estimated_future_deadlines: 0,
    venues_with_confirmed_future_deadline: 1,
    snapshot_fallback: false,
    parse_warnings: {},
    parse_warning_count: 0,
    category_distribution: {},
    category_counts: {},
    required_venues: {},
    output_files: {},
    deadline_refs: refs,
  };
}

function official(revision: string, verifiedAt: string, fields = ["date", "time", "timezone"]) {
  return {
    sourceClass: "official-cfp" as const,
    sourceUrl: "https://example.test/cfp",
    sourceRevision: revision,
    contentHash: revision,
    retrievedAt: verifiedAt,
    verifiedAt,
    verifiedFields: fields as Array<"date" | "time" | "timezone">,
  };
}

it("enforces every interval and precision transition", () => {
  const oldExact = health(
    [exact("2026-09-01T12:00:00Z", { evidence: [official("old", "2026-08-01T00:00:00Z")] })],
    "2026-08-09T00:00:00Z",
  );
  expect(evaluateHealthGate(health([exact("2026-09-01T12:00:00Z")]), oldExact).ok).toBe(true);
  expect(evaluateHealthGate(health([exact("2026-09-02T12:00:00Z")]), oldExact).ok).toBe(true);
  expect(evaluateHealthGate(health([exact("2026-08-31T12:00:00Z")]), oldExact).ok).toBe(false);
  expect(
    evaluateHealthGate(
      health([
        exact("2026-08-31T12:00:00Z", {
          evidence: [official("new", "2026-08-02T00:00:00Z")],
        }),
      ]),
      oldExact,
    ).ok,
  ).toBe(true);

  const oldDateOnly = health(
    [dateOnly("2026-09-01", { evidence: [official("old", "2026-08-01T00:00:00Z", ["date"])] })],
    "2026-08-09T00:00:00Z",
  );
  expect(evaluateHealthGate(health([exact("2026-09-01T12:00:00Z")]), oldDateOnly).ok).toBe(true);
  expect(evaluateHealthGate(health([exact("2026-09-02T12:00:00Z")]), oldDateOnly).ok).toBe(false);
  expect(
    evaluateHealthGate(
      health([
        exact("2026-09-02T12:00:00Z", {
          evidence: [official("new", "2026-08-02T00:00:00Z")],
        }),
      ]),
      oldDateOnly,
    ).ok,
  ).toBe(true);
  expect(evaluateHealthGate(health([dateOnly("2026-09-01")]), oldDateOnly).ok).toBe(true);
  expect(evaluateHealthGate(health([dateOnly("2026-09-02")]), oldDateOnly).ok).toBe(true);
  expect(evaluateHealthGate(health([dateOnly("2026-08-31")]), oldDateOnly).ok).toBe(false);
  expect(evaluateHealthGate(health([dateOnly("2026-09-01")]), oldExact).ok).toBe(false);
  expect(
    evaluateHealthGate(
      health([
        dateOnly("2026-09-01", {
          evidence: [official("date-only", "2026-08-02T00:00:00Z", ["date"])],
        }),
      ]),
      oldExact,
    ).ok,
  ).toBe(true);
  expect(evaluateHealthGate(health([dateOnly("2026-09-03")]), oldExact).ok).toBe(true);
  expect(
    evaluateHealthGate(
      {
        ...health([
          exact("2026-08-31T12:00:00Z"),
          { ...exact("2026-09-01T12:00:00Z"), deadline_id: ROUND_SLOT },
        ]),
        schema_version: HEALTH_SCHEMA_VERSION,
      },
      { ...oldExact, schema_version: 2 },
    ).ok,
  ).toBe(true);
  expect(evaluateHealthGate(health([]), oldExact).ok).toBe(false);
  expect(evaluateHealthGate(health([], "2026-09-02T00:00:00Z"), oldExact).ok).toBe(true);
});

it("requires fallback coverage for every failed source", () => {
  const current = health([]);
  current.snapshot_fallback = true;
  current.source_failures = ["ccfddl", "aideadlines"];
  current.source_status = { ccfddl: "snapshot-fallback", aideadlines: "failed" };
  expect(evaluateHealthGate(current, null).reasons).toContain(
    "source failure without snapshot fallback: aideadlines",
  );
  current.source_status.aideadlines = "snapshot-fallback";
  expect(evaluateHealthGate(current, null).ok).toBe(true);
});

it("gates stale observations, new warning codes, and new identity conflicts", () => {
  const previous = {
    ...health([]),
    warning_codes: { KNOWN: { count: 1, messages: ["known"] } },
    identity_conflicts: { venue: 0, edition: 0, new_since_baseline: 0, details: [] },
  };
  const current = {
    ...health([]),
    warning_codes: {
      KNOWN: { count: 1, messages: ["known"] },
      NEW: { count: 1, messages: ["new"] },
    },
    identity_conflicts: {
      venue: 1,
      edition: 0,
      new_since_baseline: 0,
      details: [{ scope: "venue" as const, reason: "key-collision", subject: "x" }],
    },
    source_metadata: {
      ccfddl: {
        source: "ccfddl",
        status: "snapshot-fallback" as const,
        revision: "r",
        fetchedAt: "2026-08-01T00:00:00Z",
        contentHash: "h",
        cacheAgeSeconds: 90000,
        conferenceCount: 1,
        editionCount: 1,
        deadlineCount: 1,
        observationStatus: "stale" as const,
      },
    },
  };
  const result = evaluateHealthGate(current, previous);
  expect(result.reasons).toEqual(
    expect.arrayContaining([
      "source observation is stale: ccfddl",
      "new warning code: NEW",
      "identity conflicts increased by 1",
    ]),
  );
});

it("requires newer distinct official field evidence for earlier moves", () => {
  const previous = health(
    [exact("2026-09-01T12:00:00Z", { evidence: [official("old", "2026-08-01T00:00:00Z")] })],
    "2026-08-09T00:00:00Z",
  );
  const manual = {
    ...official("manual", "2026-08-02T00:00:00Z"),
    sourceClass: "curated-manual" as const,
  };
  expect(
    evaluateHealthGate(health([exact("2026-08-31T12:00:00Z", { evidence: [manual] })]), previous)
      .ok,
  ).toBe(false);
  expect(
    evaluateHealthGate(
      health([
        exact("2026-08-31T12:00:00Z", {
          evidence: [{ ...official("old", "2026-08-02T00:00:00Z"), verifiedFields: ["date"] }],
        }),
      ]),
      previous,
    ).ok,
  ).toBe(false);
  expect(
    evaluateHealthGate(
      health([
        dateOnly("2026-09-02", {
          evidence: [official("new-date", "2026-08-02T00:00:00Z", ["date"])],
        }),
      ]),
      health(
        [
          dateOnly("2026-09-01", {
            evidence: [official("old-date", "2026-08-01T00:00:00Z", ["date"])],
          }),
        ],
        "2026-08-09T00:00:00Z",
      ),
    ).ok,
  ).toBe(true);
});

it("groups full slot identities, resolves contained precision, and reports counts", () => {
  const same = health([exact("2026-09-01T12:00:00Z"), exact("2026-09-01T12:00:00Z")]);
  expect(evaluateHealthGate(same, same)).toMatchObject({
    ok: true,
    warnings: [
      `previous duplicate deadline slot: ${SLOT}`,
      `current duplicate deadline slot: ${SLOT}`,
    ],
  });
  expect(
    evaluateHealthGate(health([exact("2026-09-01T12:00:00Z"), exact("2026-09-02T12:00:00Z")]), same)
      .ok,
  ).toBe(false);
  const contained = health([dateOnly("2026-09-01"), exact("2026-09-01T12:00:00Z")]);
  expect(evaluateHealthGate(contained, contained)).toMatchObject({
    ok: true,
    warnings: expect.arrayContaining([`previous deadline slot precision resolved: ${SLOT}`]),
  });
  expect(
    evaluateHealthGate(health([dateOnly("2026-09-01"), exact("2026-09-02T12:00:00Z")]), contained)
      .ok,
  ).toBe(false);
  const separate = health([
    exact("2026-09-01T12:00:00Z"),
    { ...exact("2026-09-01T12:00:00Z"), deadline_id: TRACK_SLOT },
    { ...exact("2026-09-01T12:00:00Z"), deadline_id: ROUND_SLOT },
  ]);
  expect(evaluateHealthGate(separate, separate).ok).toBe(true);

  const stats = healthReport(
    {
      generated_at: "2026-08-09T00:00:00Z",
      conferences: [
        {
          key: "exact",
          editions: [
            { estimated: false, deadlines: [{ kind: "paper", utc: "2026-09-01T00:00:00Z" }] },
          ],
        },
        {
          key: "date",
          editions: [
            {
              estimated: false,
              deadlines: [{ kind: "paper", precision: "date-only", local_date: "2026-08-10" }],
            },
          ],
        },
        {
          key: "estimate",
          editions: [
            { estimated: true, deadlines: [{ kind: "paper", utc: "2026-09-01T00:00:00Z" }] },
          ],
        },
      ],
    },
    new Date("2026-08-09T00:00:00Z"),
  );
  expect(stats).toMatchObject({
    future_exact_deadlines: 1,
    future_date_only_deadlines: 1,
    future_estimated_deadlines: 1,
    venues_with_exact_future_deadline: 1,
    venues_with_date_only_future_deadline: 1,
  });
  expect(healthMarkdown(stats)).toContain("| Future date-only deadlines | 1 |");
});

it("turns serialized merge conflicts into a health slot collision", () => {
  const data = {
    generated_at: "2026-08-09T00:00:00Z",
    conferences: [
      {
        key: "venue",
        editions: [
          {
            id: "venue26",
            year: 2026,
            deadlines: [
              {
                kind: "paper",
                round: 1,
                precision: "exact",
                utc: "2026-09-01T12:00:00Z",
                conflicts: [{ at_utc: "2026-09-02T12:00:00Z" }],
              },
            ],
          },
        ],
      },
    ],
  };
  const withConflict = healthReport(data, new Date("2026-08-09T00:00:00Z"));
  expect(withConflict.deadline_refs).toHaveLength(2);
  expect(evaluateHealthGate(withConflict, withConflict).reasons).toContain(
    `previous deadline slot conflict: ${SLOT}`,
  );
});

it("preserves date-only merge conflicts through JSON and blocks health", () => {
  const dateOnly = {
    kind: "paper" as const,
    label: "Paper",
    precision: "date-only" as const,
    local_date: "2026-09-01",
    round: 1,
    comment: null,
  };
  const exact = localDeadlines({
    deadlines: [{ kind: "paper", label: "Paper", date: "2026-09-03 12:00", tz: "UTC" }],
  })[0]!;
  const merged = mergeDeadlineSlots([dateOnly], [exact]);
  const data = toJson(
    [
      makeConference({
        key: "venue",
        title: "Venue",
        editions: [makeEdition({ year: 2026, edition_id: "venue26", deadlines: merged })],
      }),
    ],
    {},
    new Date("2026-08-09T00:00:00Z"),
  );
  expect((data.conferences as any[])[0].editions[0].deadlines[0].conflicts).toHaveLength(1);
  const report = healthReport(data, new Date("2026-08-09T00:00:00Z"));
  expect(evaluateHealthGate(report, report).reasons).toContain(
    `previous deadline slot conflict: ${SLOT}`,
  );

  const adjacent = mergeDeadlineSlots([dateOnly], [{ ...dateOnly, local_date: "2026-09-02" }]);
  const adjacentData = toJson(
    [
      makeConference({
        key: "venue",
        title: "Venue",
        editions: [makeEdition({ year: 2026, edition_id: "venue26", deadlines: adjacent })],
      }),
    ],
    {},
    new Date("2026-08-09T00:00:00Z"),
  );
  const adjacentReport = healthReport(adjacentData, new Date("2026-08-09T00:00:00Z"));
  expect(evaluateHealthGate(adjacentReport, adjacentReport).reasons).toContain(
    `previous deadline slot conflict: ${SLOT}`,
  );
});

it("treats :00 and :59 as the same minute when sources omit second precision", () => {
  const report = healthReport(
    {
      generated_at: "2026-08-09T00:00:00Z",
      conferences: [
        {
          key: "venue",
          editions: [
            {
              id: "venue26",
              year: 2026,
              deadlines: [
                {
                  kind: "paper",
                  precision: "exact",
                  utc: "2026-09-01T12:00:00Z",
                  conflicts: [{ at_utc: "2026-09-01T12:00:59Z" }],
                },
              ],
            },
          ],
        },
      ],
    },
    new Date("2026-08-09T00:00:00Z"),
  );
  expect(report.deadline_refs).toHaveLength(1);
  expect(evaluateHealthGate(report, report).reasons).toEqual([]);
});

it("keeps other sub-minute values as a real slot conflict", () => {
  const report = healthReport(
    {
      generated_at: "2026-08-09T00:00:00Z",
      conferences: [
        {
          key: "venue",
          editions: [
            {
              id: "venue26",
              year: 2026,
              deadlines: [
                {
                  kind: "paper",
                  precision: "exact",
                  utc: "2026-09-01T12:00:10Z",
                  conflicts: [{ at_utc: "2026-09-01T12:00:50Z" }],
                },
              ],
            },
          ],
        },
      ],
    },
    new Date("2026-08-09T00:00:00Z"),
  );
  expect(report.deadline_refs).toHaveLength(2);
  expect(evaluateHealthGate(report, report).reasons).toContain(
    `previous deadline slot conflict: ${SLOT}`,
  );
});

it("preserves source field evidence without manufacturing manual verification", () => {
  const manual = localDeadlines({
    link: "https://example.test/manual",
    deadlines: [{ kind: "paper", date: "2026-09-01 23:59", tz: "UTC" }],
  })[0];
  expect(manual.evidence?.[0]).toMatchObject({
    sourceClass: "curated-manual",
    sourceUrl: "https://example.test/manual",
  });
  expect(manual.evidence?.[0]).not.toHaveProperty("retrievedAt");
  const primary = resolvePrimaryObservations({
    conferences: {
      venue: {
        _comment: "primary (https://example.test/cfp)",
        editions: {
          2026: {
            deadlines: [
              { kind: "paper", label: "Paper", date: "2026-09-01", time: "23:59", tz: "UTC" },
            ],
          },
        },
      },
    },
  });
  const resolved = (
    (primary.conferences as Record<string, any>).venue.editions[2026].deadlines as any[]
  )[0];
  expect(resolved.evidence[0]).toMatchObject({
    sourceClass: "official-cfp",
    sourceUrl: "https://example.test/cfp",
    verifiedFields: ["date", "time", "timezone"],
  });
  expect(resolved.evidence[0]).not.toHaveProperty("contentHash");
  const json = toJson(
    [
      makeConference({
        key: "venue",
        title: "Venue",
        editions: [makeEdition({ year: 2026, deadlines: [manual] })],
      }),
    ],
    {},
    new Date("2026-08-09T00:00:00Z"),
  );
  expect((json.conferences as any[])[0].editions[0].deadlines[0].evidence[0].sourceClass).toBe(
    "curated-manual",
  );
  const merged = mergeDeadlineSlots(
    [manual],
    [
      {
        ...manual,
        evidence: [
          {
            source_name: "upstream",
            source_url: "https://example.test/upstream",
            observed_at: "",
            original_value: "2026-09-01 23:59 UTC",
            confidence: "aggregator",
            sourceClass: "aggregator",
          },
        ],
      },
    ],
  );
  expect(merged[0].evidence?.map((item) => item.sourceClass)).toEqual([
    "aggregator",
    "curated-manual",
  ]);
});
