/**
 * End-to-end build from tests/fixtures/ only: SPEC.md sections 4 and 8.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@huggingface/transformers";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import { runHealthGate } from "../scripts/health-gate.ts";
import Recommender from "../site/recommender.ts";
import type { HealthDeadlineRef, HealthReport } from "../src/build.ts";
import {
  buildAll,
  calendarDayJa,
  compileSiteRuntime,
  DEFAULT_CATEGORIES,
  deadlineSlotId,
  deadlineWhenText,
  embeddingsStale,
  escapeMdCell,
  escapeMdUrl,
  evaluateHealthGate,
  HEALTH_SCHEMA_VERSION,
  healthMarkdown,
  healthReport,
  jsonCompact,
  ROOT,
  recordsOf,
  setRoot,
  titleWithYear,
  toCatalog,
  toCsv,
  toJson,
  toLlmsTxt,
  toRecommendationIndex,
  toUpcomingMd,
} from "../src/build.ts";
import { main as cliMain, parseArgs as parseCliArgs, usage } from "../src/cli.ts";
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  embeddingManifest,
  main as embeddingsMain,
  profileTexts,
  venuePapersHash,
} from "../src/embeddings.ts";
import {
  conf,
  data,
  effectiveCss,
  FILTER_RUNTIME_STUBS,
  japaneseStringLiterals,
  keydownWithBlockers,
  rankGradeOptionsSource,
  SORT_CANON,
  SORT_CANON_EVAL,
  site,
  siteHtmlRuntime,
  upcomingRows,
  verificationLabelsSource,
} from "./built_golden_shared.ts";
import {
  makeConference,
  makeDeadline,
  makeEdition,
  NOW,
  PUBLIC_FILES,
  REPO_ROOT,
  runCli,
  utc,
} from "./helpers.ts";
import { deadlineHintFunction, jsFunction, siteRuntime, vmSafeSource } from "./runtime_extract.ts";

it("healthReport separates future confirmed and estimated values", () => {
  const report = healthReport(
    {
      generated_at: "2026-08-09T00:00:00Z",
      sources: [{ name: "ccfddl" }],
      conferences: [
        {
          key: "confirmed",
          categories: ["systems"],
          editions: [{ estimated: false, deadlines: [{ utc: "2026-09-01T00:00:00Z" }] }],
        },
        {
          key: "estimated",
          categories: ["systems", "hpc"],
          editions: [{ estimated: true, deadlines: [{ utc: "2026-10-01T00:00:00Z" }] }],
        },
        {
          key: "past",
          categories: ["systems"],
          editions: [{ estimated: false, deadlines: [{ utc: "2026-08-08T00:00:00Z" }] }],
        },
      ],
    },
    NOW,
    {
      sourceStatus: { ccfddl: "failed" },
      parseWarnings: { malformed: 2 },
      outputFiles: { "data.json": { bytes: 10, sha256: "a".repeat(64) } },
    },
  );
  expect(report).toMatchObject({
    schema_version: HEALTH_SCHEMA_VERSION,
    generated_at: "2026-08-09T00:00:00Z",
    source_status: { ccfddl: "failed" },
    tracked_venues: 3,
    future_confirmed_venues: 1,
    future_estimated_venues: 1,
    confirmed_deadlines: 1,
    estimated_deadlines: 1,
    parse_warnings: { malformed: 2 },
    category_distribution: { hpc: 1, systems: 3 },
    output_files: { "data.json": { bytes: 10, sha256: "a".repeat(64) } },
  });
  // md は日本語ラベル＋`health.json` のキーを併記する（第 83 回まで英語の見出しだった）。
  expect(healthMarkdown(report)).toContain("| 確定した締切（`confirmed_deadlines`） | 1 |");
  expect(healthMarkdown(report)).toContain("| data.json | 10 |");
});

it("healthReport preserves equivalent camelCase and snake_case evidence", () => {
  const canonical = {
    sourceClass: "official-cfp",
    sourceUrl: "https://example.test/cfp",
    sourceRevision: "r1",
    contentHash: "a".repeat(64),
    retrievedAt: "2026-08-01T00:00:00Z",
    verifiedAt: "2026-08-02T00:00:00Z",
    verifiedFields: ["date", "time", "timezone"],
  };
  const snake = Object.fromEntries(
    Object.entries(canonical).map(([key, value]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      value,
    ]),
  );
  const refs = (evidence: Record<string, unknown>) =>
    healthReport(
      {
        conferences: [
          {
            key: "demo",
            editions: [
              {
                year: 2026,
                id: "demo26",
                deadlines: [
                  {
                    kind: "paper",
                    utc: "2026-09-01T00:00:00Z",
                    evidence: [evidence],
                  },
                ],
              },
            ],
          },
        ],
      },
      NOW,
    ).deadline_refs;
  const expected = refs(canonical);
  expect(expected).toHaveLength(1);
  expect(expected?.[0]?.evidence_hash).toBeTruthy();
  expect(expected?.[0]?.evidence).toEqual([canonical]);
  expect(refs(snake)).toEqual(expected);
});

it("healthReport counts date-only deadlines without inventing a UTC instant", () => {
  const report = healthReport(
    {
      conferences: [
        {
          key: "date-only",
          categories: ["systems"],
          editions: [
            {
              year: 2026,
              id: "date-only26",
              estimated: false,
              deadlines: [
                {
                  kind: "paper",
                  precision: "date-only",
                  local_date: "2026-08-10",
                },
              ],
            },
          ],
        },
      ],
    },
    NOW,
  );
  expect(report.confirmed_deadlines).toBe(1);
  expect(report.deadline_refs).toEqual([
    expect.objectContaining({
      deadline_id: deadlineSlotId("date-only", "date-only26", "paper", 1, ""),
      local_date: "2026-08-10",
    }),
  ]);
  expect(report.deadline_refs?.[0]).not.toHaveProperty("at_utc");
});

it("toJson preserves deadline evidence, conflicts, and selection rule", () => {
  const payload = toJson(
    [
      makeConference({
        key: "rtss",
        title: "RTSS",
        sources: ["aideadlines", "ccfddl"],
        editions: [
          makeEdition({
            year: 2026,
            source: "aideadlines",
            deadlines: [
              {
                ...makeDeadline("paper", "Paper submission", utc(2026, 9, 1)),
                raw_value: "September 1, 2026 23:59 UTC",
                conflicts: [
                  {
                    at_utc: utc(2026, 8, 31),
                    label: "Paper deadline",
                    source: "ccfddl",
                    raw_value: "2026-08-31T23:59:00Z",
                  },
                ],
              },
            ],
          }),
        ],
      }),
    ],
    {
      sources: [
        { name: "aideadlines", url: "https://example.org/aideadlines" },
        { name: "ccfddl", url: "https://example.org/ccfddl" },
      ],
    },
    NOW,
  );
  const deadline = (payload.conferences as any[])[0].editions[0].deadlines[0];
  expect(deadline.selection_rule).toBe("source_priority_then_nearest_within_configured_window");
  expect(deadline.evidence[0]).toMatchObject({
    source_name: "aideadlines",
    source_url: "https://example.org/aideadlines",
    observed_at: "",
    original_value: "September 1, 2026 23:59 UTC",
    confidence: "aggregator",
  });
  expect(deadline.evidence[0]).not.toHaveProperty("retrievedAt");
  expect(deadline.evidence[0]).not.toHaveProperty("verifiedAt");
  expect(deadline.evidence[0]).not.toHaveProperty("contentHash");
  expect(deadline.conflicts[0]).toMatchObject({
    at_utc: "2026-08-31T00:00:00Z",
    original_value: "2026-08-31T23:59:00Z",
    evidence: {
      source_name: "ccfddl",
      source_url: "https://example.org/ccfddl",
      confidence: "aggregator",
    },
  });
});

it("toJson preserves verification state on deadlines", () => {
  const payload = toJson(
    [
      makeConference({
        key: "testconf",
        title: "TestConf",
        sources: ["local"],
        editions: [
          makeEdition({
            year: 2026,
            source: "local",
            deadlines: [
              {
                ...makeDeadline("paper", "Paper submission", utc(2026, 10, 1)),
                verification: {
                  official_url: "https://testconf.org/cfp",
                  last_attempt_at: "2026-08-20T10:00:00Z",
                  last_verified_at: "2026-08-20T10:00:00Z",
                  next_check_at: "2026-08-27T10:00:00Z",
                  content_hash: "abc123",
                  status: "verified",
                },
              },
            ],
          }),
        ],
      }),
    ],
    {},
    NOW,
  );
  const deadline = (payload.conferences as any[])[0].editions[0].deadlines[0];
  expect(deadline.verification).toMatchObject({
    official_url: "https://testconf.org/cfp",
    last_attempt_at: "2026-08-20T10:00:00Z",
    last_verified_at: "2026-08-20T10:00:00Z",
    next_check_at: "2026-08-27T10:00:00Z",
    content_hash: "abc123",
    status: "verified",
  });
});

it("toJson omits verification when not set", () => {
  const payload = toJson(
    [
      makeConference({
        key: "testconf",
        title: "TestConf",
        sources: ["local"],
        editions: [
          makeEdition({
            year: 2026,
            source: "local",
            deadlines: [makeDeadline("paper", "Paper submission", utc(2026, 10, 1))],
          }),
        ],
      }),
    ],
    {},
    NOW,
  );
  const deadline = (payload.conferences as any[])[0].editions[0].deadlines[0];
  expect(deadline).not.toHaveProperty("verification");
});

it("toJson generates verification when reverification.enabled is true", () => {
  const payload = toJson(
    [
      makeConference({
        key: "testconf",
        title: "TestConf",
        link: "https://example.org/testconf",
        sources: ["local"],
        editions: [
          makeEdition({
            year: 2026,
            link: "",
            source: "local",
            deadlines: [
              {
                ...makeDeadline("paper", "Paper submission", utc(2026, 10, 1)),
                evidence: [
                  {
                    source_name: "test",
                    source_url: "https://example.org/testconf",
                    observed_at: "2026-08-31T00:00:00.000Z",
                    original_value: "2026-10-01T00:00:00Z",
                    confidence: "official",
                    sourceClass: "official-cfp",
                    sourceUrl: "https://example.org/testconf",
                    sourceRevision: "test-revision",
                    verifiedAt: "2026-08-31T00:00:00.000Z",
                  },
                ],
              },
            ],
          }),
          makeEdition({
            year: 2027,
            link: "https://example.org/testconf/2027",
            source: "local",
            deadlines: [
              {
                ...makeDeadline("paper", "Paper submission", utc(2027, 10, 1)),
                evidence: [
                  {
                    source_name: "test",
                    source_url: "https://example.org/testconf/2027",
                    observed_at: "2026-08-31T00:00:00.000Z",
                    original_value: "2027-10-01T00:00:00Z",
                    confidence: "official",
                    sourceClass: "official-cfp",
                    sourceUrl: "https://example.org/testconf/2027",
                    sourceRevision: "test-revision",
                    verifiedAt: "2026-08-31T00:00:00.000Z",
                  },
                ],
              },
            ],
          }),
        ],
      }),
    ],
    { health: { reverification: { enabled: true } } },
    NOW,
  );
  const deadlines = (payload.conferences as any[])[0].editions.map(
    (edition: any) => edition.deadlines[0],
  );
  expect(deadlines.map((deadline: any) => deadline.verification.official_url)).toEqual([
    "https://example.org/testconf",
    "https://example.org/testconf/2027",
  ]);
  expect(deadlines.every((deadline: any) => deadline.verification.status === "pending")).toBe(true);
  expect(deadlines.every((deadline: any) => deadline.verification.next_check_at)).toBe(true);
});

it("omits ambiguous legacy key redirects", () => {
  const payload = toJson(
    [
      makeConference({ key: "fse-sc", title: "FSE", legacy_keys: ["fse"] }),
      makeConference({ key: "fse-se", title: "FSE", legacy_keys: ["fse"] }),
      makeConference({ key: "new", title: "New", legacy_keys: ["old"] }),
      makeConference({ key: "sec-sc", title: "SEC", legacy_keys: ["sec"] }),
    ],
    { venue_identities: { sec: { source_ids: { ccfddl: "DS/sec" } } } },
    NOW,
  );
  expect(payload.legacy_key_redirects).toEqual({ old: "new" });
});

it("emits an explicit identity migration manifest for legacy slots", () => {
  const payload = toJson(
    [
      makeConference({
        key: "new",
        title: "New",
        legacy_keys: ["old"],
        editions: [
          makeEdition({
            year: 2026,
            edition_id: "new26",
            deadlines: [makeDeadline("paper", "Paper", new Date("2026-09-01T12:00:00Z"))],
          }),
        ],
      }),
    ],
    {},
    NOW,
  );
  expect(payload.identity_migrations).toMatchObject({
    schema_version: 1,
    from_identity_revision: "legacy-public-key",
    to_identity_revision: "identity-v1",
  });
  expect((payload.identity_migrations as any).migrations).toEqual([
    expect.objectContaining({
      action: "rename",
      from: expect.objectContaining({ venue: "old", edition: "*" }),
      to: expect.objectContaining({ venue: "new", edition: "new26" }),
    }),
  ]);
  expect(healthReport(payload, NOW).identity_migrations?.migrations).toHaveLength(1);
});

it("toJson preserves venue and edition identity for snapshot round-trips", () => {
  const payload = toJson(
    [
      makeConference({
        key: "identity",
        title: "Identity",
        dblp: "conf/identity",
        identity: {
          venueId: "identity",
          dblpKey: "conf/identity",
          officialDomains: ["identity.example"],
          aliases: ["Identity Conf"],
          sourceIds: { local: "identity" },
        },
        editions: [
          makeEdition({
            year: 2027,
            edition_id: "identity27",
            identity: {
              editionId: "identity-2027",
              officialUrls: ["https://identity.example/2027"],
            },
          }),
        ],
      }),
    ],
    {},
    NOW,
  );
  expect((payload.conferences as any[])[0]).toMatchObject({
    dblp: "conf/identity",
    identity: { venueId: "identity", dblpKey: "conf/identity" },
    editions: [{ identity: { editionId: "identity-2027" } }],
  });
});

it("date-only deadlines stay date-only in JSON, CSV, and upcoming output", () => {
  const confs = [
    makeConference({
      key: "date-only",
      title: "Date Only",
      editions: [
        makeEdition({
          year: 2026,
          deadlines: [
            {
              kind: "paper",
              label: "Submission deadline",
              precision: "date-only",
              local_date: "2026-08-10",
              round: 1,
              comment: null,
            },
          ],
        }),
      ],
    }),
  ];
  const records = recordsOf(confs);
  const deadline = (toJson(confs, {}, NOW).conferences as any[])[0].editions[0].deadlines[0];

  expect(deadline).toMatchObject({
    precision: "date-only",
    local_date: "2026-08-10",
    earliest_utc: "2026-08-09T10:00:00.000Z",
    latest_utc: "2026-08-11T11:59:59.999Z",
    utc: null,
    aoe: null,
    tz_raw: null,
  });
  expect(records[0].start.toISOString()).toBe("2026-08-09T10:00:00.000Z");
  expect(records[0].end.toISOString()).toBe("2026-08-11T11:59:59.999Z");
  expect(toCsv(records)).toContain("date-only,2026-08-10,,,,");
  expect(toUpcomingMd(records, NOW)).toContain("2026-08-10(月)（時刻未確認）");
  expect(toUpcomingMd(records, new Date("2026-08-11T11:59:59.999Z"))).toContain("締切日");
  expect(toUpcomingMd(records, new Date("2026-08-11T12:00:00.000Z"))).not.toContain("Date Only");

  const data = toJson(confs, {}, NOW);
  const uncertainNow = new Date("2026-08-11T00:00:00.000Z");
  expect(
    (toCatalog(data, uncertainNow).conferences as any[])[0].editions[0].deadlines,
  ).toHaveLength(1);
  expect(
    (toRecommendationIndex(data, uncertainNow).conferences as any[])[0].editions[0].deadlines[0]
      .local_date,
  ).toBe("2026-08-10");
  expect(healthReport(data, uncertainNow).confirmed_deadlines).toBe(1);
  expect(healthReport(data, new Date("2026-08-11T12:00:00.000Z")).confirmed_deadlines).toBe(0);
});

it("evaluateHealthGate covers normal updates and every fail-closed regression", () => {
  const previous: HealthReport = {
    schema_version: 1,
    generated_at: "2026-08-09T00:00:00Z",
    profile_hash: "profile-a",
    source_status: { ccfddl: "success" },
    source_failures: [],
    tracked_venues: 10,
    future_confirmed_venues: 8,
    future_estimated_venues: 2,
    confirmed_deadlines: 10,
    estimated_deadlines: 2,
    confirmed_future_deadlines: 10,
    estimated_future_deadlines: 2,
    venues_with_confirmed_future_deadline: 8,
    snapshot_fallback: false,
    parse_warnings: { one: 1 },
    parse_warning_count: 1,
    category_distribution: { systems: 5 },
    category_counts: { systems: 5 },
    required_venues: { rtss: "present" },
    output_files: {},
  };
  expect(evaluateHealthGate(previous, previous).ok).toBe(true);
  expect(
    evaluateHealthGate(
      { ...previous, confirmed_future_deadlines: 6, confirmed_deadlines: 6 },
      previous,
    ).ok,
  ).toBe(false);
  expect(
    evaluateHealthGate({ ...previous, required_venues: { rtss: "missing" } }, previous).ok,
  ).toBe(false);
  expect(
    evaluateHealthGate(
      { ...previous, parse_warning_count: 8, parse_warnings: { one: 8 } },
      previous,
    ).ok,
  ).toBe(false);
  expect(evaluateHealthGate({ ...previous, profile_hash: "profile-b" }, previous).ok).toBe(true);
  expect(
    evaluateHealthGate(
      { ...previous, source_failures: ["ccfddl"], source_status: { ccfddl: "failed" } },
      previous,
    ).ok,
  ).toBe(false);
  expect(
    evaluateHealthGate(
      {
        ...previous,
        source_failures: ["ccfddl"],
        source_status: { ccfddl: "snapshot-fallback" },
        snapshot_fallback: true,
      },
      previous,
    ).ok,
  ).toBe(true);
  expect(
    evaluateHealthGate(
      { ...previous, estimated_future_deadlines: 0, estimated_deadlines: 0 },
      previous,
    ).ok,
  ).toBe(true);
  expect(
    evaluateHealthGate({ ...previous, generated_at: "2026-08-08T00:00:00Z" }, previous).ok,
  ).toBe(false);
});

it("evaluateHealthGate compares deadline identity without profile churn", () => {
  const base: HealthReport = {
    schema_version: 1,
    generated_at: "2026-08-09T00:00:00Z",
    profile_hash: "profile-a",
    source_status: {},
    source_failures: [],
    tracked_venues: 1,
    future_confirmed_venues: 1,
    future_estimated_venues: 0,
    confirmed_deadlines: 1,
    estimated_deadlines: 0,
    confirmed_future_deadlines: 1,
    estimated_future_deadlines: 0,
    venues_with_confirmed_future_deadline: 1,
    snapshot_fallback: false,
    parse_warnings: {},
    parse_warning_count: 0,
    category_distribution: { systems: 1 },
    category_counts: { systems: 1 },
    required_venues: {},
    output_files: {},
    confirmed_deadline_refs: [
      { id: "rtss|rtss26|paper|2026-08-10T00:00:00.000Z", at_utc: "2026-08-10T00:00:00.000Z" },
    ],
  };

  // A newly tracked venue is an addition, not a regression.
  expect(
    evaluateHealthGate(
      {
        ...base,
        tracked_venues: 2,
        confirmed_deadlines: 2,
        confirmed_future_deadlines: 2,
        category_distribution: { systems: 2 },
        category_counts: { systems: 2 },
        confirmed_deadline_refs: [
          ...base.confirmed_deadline_refs!,
          { id: "new|new26|paper|2026-08-11T00:00:00.000Z", at_utc: "2026-08-11T00:00:00.000Z" },
        ],
      },
      base,
    ).ok,
  ).toBe(true);

  // A venue-profile change is provenance churn, not a lost deadline.
  expect(evaluateHealthGate({ ...base, profile_hash: "profile-b" }, base).ok).toBe(true);

  // The same deadline is still present, so its category correction passes.
  expect(
    evaluateHealthGate(
      { ...base, category_distribution: { networking: 1 }, category_counts: { networking: 1 } },
      base,
    ).ok,
  ).toBe(true);

  // A future deadline vanished without reaching its published instant.
  expect(evaluateHealthGate({ ...base, confirmed_deadline_refs: [] }, base).ok).toBe(false);

  // That same transition becomes ordinary expiry after the instant passes.
  expect(
    evaluateHealthGate(
      {
        ...base,
        generated_at: "2026-08-11T00:00:00Z",
        confirmed_deadlines: 0,
        confirmed_future_deadlines: 0,
        confirmed_deadline_refs: [],
      },
      base,
    ).ok,
  ).toBe(true);

  // Malformed semantic evidence cannot silently fall back to coarse counts.
  expect(
    evaluateHealthGate(
      { ...base, confirmed_deadline_refs: [{ id: "broken", at_utc: "not-a-date" }] as any },
      base,
    ).ok,
  ).toBe(false);
});

it("healthReport identifies deadline slots without embedding timestamps", () => {
  const report = healthReport(
    {
      generated_at: "2026-08-09T00:00:00Z",
      conferences: [
        {
          key: "rtss",
          categories: ["systems"],
          editions: [
            {
              year: 2026,
              id: "rtss26",
              estimated: false,
              deadlines: [
                {
                  kind: "paper",
                  label: "Paper submission",
                  round: 1,
                  utc: "2026-09-01T00:00:00Z",
                },
                {
                  kind: "paper",
                  label: "Paper submission Round 2",
                  round: 2,
                  utc: "2026-09-01T00:00:00Z",
                },
              ],
            },
            {
              year: 2026,
              id: "rtss26w",
              estimated: false,
              deadlines: [
                {
                  kind: "paper",
                  label: "Workshop paper",
                  round: 1,
                  utc: "2026-09-01T00:00:00Z",
                },
              ],
            },
            {
              year: 2025,
              id: "rtss25",
              estimated: false,
              deadlines: [
                { kind: "paper", label: "Paper submission", round: 1, utc: "2026-07-01T00:00:00Z" },
              ],
            },
          ],
        },
      ],
    },
    NOW,
  );
  expect(report.schema_version).toBe(HEALTH_SCHEMA_VERSION);
  expect(new Set(report.deadline_refs?.map((ref) => ref.deadline_id))).toEqual(
    new Set([
      deadlineSlotId("rtss", "rtss26", "paper", 1, ""),
      deadlineSlotId("rtss", "rtss26", "paper", 2, ""),
      deadlineSlotId("rtss", "rtss26w", "paper", 1, "workshop-paper"),
    ]),
  );
  for (const ref of report.deadline_refs ?? []) {
    expect(ref.deadline_id.includes("2026-09-01")).toBe(false);
    expect(ref.edition_year).toBe(2026);
  }
});

it("evaluateHealthGate matches deadline slots independently of timestamps", () => {
  const slot = (
    deadlineId: string,
    atUtc: string,
    extra: Partial<HealthDeadlineRef> = {},
  ): HealthDeadlineRef => ({
    deadline_id: deadlineId,
    at_utc: atUtc,
    edition_year: 2026,
    ...extra,
  });
  const paper1 = deadlineSlotId("rtss", "rtss26", "paper", 1, "");
  const paper2 = deadlineSlotId("rtss", "rtss26", "paper", 2, "");
  const workshop = deadlineSlotId("rtss", "rtss26w", "paper", 1, "workshop-paper");
  const industry = deadlineSlotId("rtss", "rtss26", "paper", 1, "industry");
  const industryTrack = deadlineSlotId("rtss", "rtss26", "paper", 1, "industry-track");
  const priorEvidence = {
    sourceClass: "official-cfp" as const,
    sourceUrl: "https://example.test/cfp",
    sourceRevision: "r1",
    contentHash: "old",
    retrievedAt: "2026-08-01T00:00:00Z",
    verifiedAt: "2026-08-01T00:00:00Z",
    verifiedFields: ["date", "time", "timezone"] as Array<"date" | "time" | "timezone">,
  };
  const base: HealthReport = {
    schema_version: HEALTH_SCHEMA_VERSION,
    generated_at: "2026-08-09T00:00:00Z",
    profile_hash: "profile-a",
    source_status: {},
    source_failures: [],
    tracked_venues: 1,
    future_confirmed_venues: 1,
    future_estimated_venues: 0,
    confirmed_deadlines: 1,
    estimated_deadlines: 0,
    confirmed_future_deadlines: 1,
    estimated_future_deadlines: 0,
    venues_with_confirmed_future_deadline: 1,
    snapshot_fallback: false,
    parse_warnings: {},
    parse_warning_count: 0,
    category_distribution: { systems: 1 },
    category_counts: { systems: 1 },
    required_venues: {},
    output_files: {},
    deadline_refs: [slot(paper1, "2026-09-01T00:00:00.000Z", { evidence: [priorEvidence] })],
  };
  const withRefs = (
    refs: HealthDeadlineRef[],
    extra: Partial<HealthReport> = {},
  ): HealthReport => ({
    ...base,
    confirmed_deadlines: refs.length,
    confirmed_future_deadlines: refs.length,
    deadline_refs: refs,
    ...extra,
  });

  expect(evaluateHealthGate(withRefs([slot(paper1, "2026-09-08T00:00:00.000Z")]), base).ok).toBe(
    true,
  );

  expect(evaluateHealthGate(withRefs([slot(paper1, "2026-08-31T00:00:00.000Z")]), base).ok).toBe(
    false,
  );
  expect(
    evaluateHealthGate(
      withRefs([
        slot(paper1, "2026-08-31T00:00:00.000Z", {
          evidence: [
            {
              ...priorEvidence,
              sourceRevision: "r2",
              contentHash: "new",
              retrievedAt: "2026-08-10T00:00:00Z",
              verifiedAt: "2026-08-10T00:00:00Z",
            },
          ],
        }),
      ]),
      base,
    ).ok,
  ).toBe(true);

  expect(
    evaluateHealthGate(
      withRefs([], {
        generated_at: "2026-09-02T00:00:00Z",
        confirmed_deadlines: 0,
        confirmed_future_deadlines: 0,
      }),
      base,
    ).ok,
  ).toBe(true);

  const sameInstantRounds = withRefs([
    slot(paper1, "2026-09-01T00:00:00.000Z"),
    slot(paper2, "2026-09-01T00:00:00.000Z"),
  ]);
  expect(sameInstantRounds.deadline_refs).toHaveLength(2);
  expect(evaluateHealthGate(sameInstantRounds, sameInstantRounds).ok).toBe(true);

  const twoEditions = withRefs([
    slot(paper1, "2026-09-01T00:00:00.000Z"),
    slot(workshop, "2026-09-01T00:00:00.000Z"),
  ]);
  expect(evaluateHealthGate(twoEditions, twoEditions).ok).toBe(true);
  expect(
    evaluateHealthGate(withRefs([slot(paper1, "2026-09-01T00:00:00.000Z")]), twoEditions).ok,
  ).toBe(false);

  // track キーはラベル由来で頻繁に動くため、venue/year/kind/round と時刻が
  // 完全一致し両側で一意な track 改名は同一締切として通す (2026-09-05 契約更新)。
  // 値が動く track 改名は tests/health_gate.test.ts が引き続き阻止を検証する。
  expect(
    evaluateHealthGate(
      withRefs([slot(industryTrack, "2026-09-01T00:00:00.000Z")]),
      withRefs([slot(industry, "2026-09-01T00:00:00.000Z")]),
    ).ok,
  ).toBe(true);

  // 旧 schema の edition 表記 (年のみ) は edition 改名対応付け (track まで一致 +
  // 両側一意) で吸収され、延長は通す (2026-09-05 契約更新)。前倒しは引き続き阻止。
  const legacySchemaBase: HealthReport = {
    ...base,
    schema_version: 1,
    deadline_refs: undefined,
    confirmed_deadline_refs: [
      { id: "rtss|2026|paper|2026-09-01T00:00:00.000Z", at_utc: "2026-09-01T00:00:00.000Z" },
    ],
  };
  expect(
    evaluateHealthGate(withRefs([slot(paper1, "2026-09-08T00:00:00.000Z")]), legacySchemaBase).ok,
  ).toBe(true);
  expect(
    evaluateHealthGate(withRefs([slot(paper1, "2026-08-25T00:00:00.000Z")]), legacySchemaBase).ok,
  ).toBe(false);

  expect(
    evaluateHealthGate(
      withRefs([{ deadline_id: paper1, local_date: "2026-08-31", edition_year: 2026 }]),
      withRefs([slot(paper1, "2026-09-01T11:59:00.000Z")]),
    ).ok,
  ).toBe(false);
});

it("scheduled deployments require a usable baseline", () => {
  expect(runHealthGate(["current-health.json", "--require-baseline"])).toBe(1);
});

it("generated health files describe the deterministic build", () => {
  const report = JSON.parse(readFileSync(join(site, "health.json"), "utf8"));
  expect(report).toMatchObject({
    schema_version: HEALTH_SCHEMA_VERSION,
    generated_at: "2026-08-09T00:00:00Z",
    tracked_venues: data.conferences.length,
    source_status: {
      ccfddl: "cache-fallback",
      aideadlines: "cache-fallback",
      local: "fresh",
    },
  });
  expect(Array.isArray(report.deadline_refs)).toBe(true);
  for (const ref of report.deadline_refs) {
    expect(ref.deadline_id).not.toMatch(/T\d{2}:\d{2}:\d{2}/);
    if (ref.local_date) expect(ref.local_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    else expect(ref.at_utc).toEqual(new Date(ref.at_utc).toISOString());
  }
  const dataBytes = readFileSync(join(site, "data.json"));
  expect(report.output_files["data.json"]).toEqual({
    bytes: dataBytes.byteLength,
    sha256: createHash("sha256").update(dataBytes).digest("hex"),
  });
  // health.md は「人間向け要約」なので日本語で見出しを出す（第 83 回まで英語だった）。
  expect(readFileSync(join(site, "health.md"), "utf8")).toContain("# ビルド健全性");
});

// --- generated file set ----------------------------------------------------

it.each(PUBLIC_FILES)("public file is generated: %s", (name) => {
  const path = join(site, name);
  expect(require("node:fs").existsSync(path), `${name} missing from public/`).toBe(true);
  if (name !== ".nojekyll") {
    expect(require("node:fs").statSync(path).size, `${name} is empty`).toBeGreaterThan(0);
  }
});

it("build is deterministic", () => {
  const second = join(mkdtempSync(join(tmpdir(), "cfp-site2-")), "public2");
  const run = runCli(second, { extra: ["--no-embeddings"] });
  expect(run.status, run.stderr).toBe(0);
  for (const name of PUBLIC_FILES) {
    expect(readFileSync(join(site, name))).toEqual(readFileSync(join(second, name)));
  }
}, 300_000);

it("publishes the same browser runtime that the site typecheck validates", () => {
  for (const name of Object.keys(compileSiteRuntime()) as Array<
    keyof ReturnType<typeof compileSiteRuntime>
  >) {
    expect(readFileSync(join(site, name), "utf8")).toEqual(siteRuntime(name));
  }
});

// --- data.json -------------------------------------------------------------

it("data.json has the spec top-level shape", () => {
  for (const key of ["generated_at", "site", "sources", "categories", "conferences"]) {
    expect(key in data).toBe(true);
  }
  expect(data.generated_at).toBe("2026-08-09T00:00:00Z");
  expect(typeof data.site).toBe("object");
  expect(data.site?.domain).toBeDefined();
  expect(data.site?.base_url).toBeDefined();
  expect(typeof data.categories).toBe("object");
  for (const cat of ["hpc", "networking", "systems", "ai", "security"]) {
    expect(cat in data.categories).toBe(true);
  }
  expect(Array.isArray(data.sources) && data.sources.length > 0).toBe(true);
  for (const src of data.sources) {
    for (const key of ["name", "repo", "license"]) {
      expect(key in src).toBe(true);
    }
  }
});

it("conference records match the spec", () => {
  expect(data.conferences.length).toBeGreaterThan(0);
  for (const conf of data.conferences) {
    for (const key of [
      "key",
      "title",
      "full_name",
      "categories",
      "rank",
      "link",
      "sources",
      "editions",
    ]) {
      expect(key in conf).toBe(true);
    }
    expect(Array.isArray(conf.categories)).toBe(true);
    expect(typeof conf.rank).toBe("object");
    expect(Array.isArray(conf.sources) && conf.sources.length > 0).toBe(true);
    for (const s of conf.sources) {
      expect(["ccfddl", "aideadlines", "local"]).toContain(s);
    }
  }
});

it("edition and deadline records match the spec", () => {
  let seenDeadline = false;
  for (const conf of data.conferences) {
    for (const ed of conf.editions) {
      for (const key of [
        "year",
        "id",
        "place",
        "link",
        "event_start",
        "event_end",
        "estimated",
        "deadlines",
      ]) {
        expect(key in ed).toBe(true);
      }
      expect(typeof ed.year).toBe("number");
      expect(typeof ed.estimated).toBe("boolean");
      for (const key of ["event_start", "event_end"]) {
        if (ed[key] !== null) {
          expect(String(ed[key])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
      }
      for (const dl of ed.deadlines) {
        seenDeadline = true;
        for (const key of ["kind", "label", "utc", "aoe", "tz_raw", "round"]) {
          expect(key in dl).toBe(true);
        }
        expect([
          "abstract",
          "paper",
          "supplementary",
          "notification",
          "camera_ready",
          "rebuttal_start",
          "rebuttal_end",
          "review_release",
          "registration",
          "other",
        ]).toContain(dl.kind);
        if (dl.precision === "date-only") {
          expect(dl.local_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(dl.utc).toBeNull();
          expect(dl.aoe).toBeNull();
          expect(dl.tz_raw).toBeNull();
        } else {
          expect(dl.utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
          expect(String(dl.aoe).endsWith("AoE")).toBe(true);
        }
        expect(typeof dl.round).toBe("number");
        expect(dl.round).toBeGreaterThanOrEqual(1);
      }
    }
  }
  expect(seenDeadline).toBe(true);
});

it("expected fixture conferences are present", () => {
  const keys = new Set(data.conferences.map((c: any) => c.key));
  for (const key of ["sigcomm", "nsdi", "sc"]) {
    expect(keys.has(key)).toBe(true);
  }
});

it("out-of-scope upstream conferences are filtered out", () => {
  const keys = new Set(data.conferences.map((c: any) => c.key));
  expect(keys.has("prcv")).toBe(true);
  for (const key of ["popl", "oopsla", "aplas"]) {
    expect(keys.has(key)).toBe(false);
  }
});

it("ccfddl plain deadline becomes a paper deadline", () => {
  const sc26 = conf("sc").editions.filter((e: any) => e.id === "sc26")[0];
  const kinds = new Set(sc26.deadlines.map((d: any) => d.kind));
  expect(kinds.has("paper")).toBe(true);
  expect(kinds.has("abstract")).toBe(true);
});

it("AoE boundary is converted in the generated data", () => {
  const sc26 = conf("sc").editions.filter((e: any) => e.id === "sc26")[0];
  const paper = sc26.deadlines.filter((d: any) => d.kind === "paper");
  expect(paper.length).toBeGreaterThan(0);
  expect(paper[0].utc).toBe("2026-04-09T11:59:00Z");
  expect(String(paper[0].tz_raw).toLowerCase()).toBe("aoe");
  expect(String(paper[0].aoe).startsWith("2026-04-08 23:59")).toBe(true);
});

it("free-text event dates are parsed", () => {
  const sigcomm26 = conf("sigcomm").editions.filter((e: any) => e.id === "sigcomm26")[0];
  expect(sigcomm26.event_start).toBe("2026-08-17");
  expect(sigcomm26.event_end).toBe("2026-08-21");
});

it("multiple rounds are preserved", () => {
  const nsdi27 = conf("nsdi").editions.filter((e: any) => e.id === "nsdi27")[0];
  const rounds = new Set(nsdi27.deadlines.map((d: any) => `${d.kind}:${d.round}`));
  expect(rounds.has("paper:1")).toBe(true);
  expect(rounds.has("paper:2")).toBe(true);
});

it("unparseable deadline is skipped not fatal", () => {
  const keys = new Set(data.conferences.map((c: any) => c.key));
  if (!keys.has("acl")) return;
  const editions: Record<string, any> = {};
  for (const e of conf("acl").editions) editions[e.id] = e;
  if ("acl27" in editions) {
    expect(editions.acl27.deadlines).toEqual([]);
  }
});

it("no deadline is in the far future by accident", () => {
  for (const c of data.conferences) {
    for (const ed of c.editions) {
      for (const dl of ed.deadlines) {
        const t = Date.parse(dl.precision === "date-only" ? `${dl.local_date}T00:00:00Z` : dl.utc);
        expect(t).toBeGreaterThanOrEqual(Date.parse("2015-01-01T00:00:00Z"));
        expect(t).toBeLessThanOrEqual(Date.parse("2032-01-01T00:00:00Z"));
      }
    }
  }
});

// --- other artefacts -------------------------------------------------------

it("CSV is one row per deadline", () => {
  const text = readFileSync(join(site, "data.csv"), "utf8");
  const rows = text.trim().split("\n").slice(1);
  expect(rows.length).toBeGreaterThan(0);
  let total = 0;
  let estimated = 0;
  for (const c of data.conferences) {
    for (const ed of c.editions) {
      total += ed.deadlines.length;
      if (ed.estimated) estimated += ed.deadlines.length;
    }
  }
  expect([total, total - estimated]).toContain(rows.length);
});

it("upcoming.md is a table", () => {
  const text = readFileSync(join(site, "upcoming.md"), "utf8");
  expect(text).toContain("|");
  expect(text).toMatch(/^\|?\s*-{3,}/m);
});

it("llms.txt indexes generated outputs", () => {
  const text = readFileSync(join(site, "llms.txt"), "utf8");
  for (const name of [
    "data.json",
    "health.json",
    "health.md",
    "data.csv",
    "upcoming.md",
    "recommender.js",
    "publish.json",
    "catalog.json",
    "recommendation-index.json",
    "app.js",
    "deadlines.ics",
  ]) {
    expect(text, `llms.txt 出力一覧は ${name} を載せる`).toContain(name);
  }
  /* 実在しない出力を載せない見張り（第 242 回）。`deadlines.ics` は第 266 回から実在するので、
     カレンダーのファイル名が 1 本きりであることを見る（増えたのに索引に無い、を許さない）。 */
  /* 別の名前のカレンダーのファイルが増えたのに索引から抜ける、を許さない。同じ名前は説明に
     何度出ても良いので、名前の種類で比べる。 */
  expect([...new Set(text.match(/[\w.-]+\.ics/g))]).toEqual(["deadlines.ics"]);
});

it("README links every machine-readable output file (data.csv regression)", () => {
  // #245: README「機械可読の出力」の案内で data.csv だけが URL 無しだった。
  // llms.txt / data.json / upcoming.md / data.csv を案内する。
  // この節の対象読者は「エージェントや自作の道具」— まさに URL を必要とする層。
  const config = (loadYaml(readFileSync(join(REPO_ROOT, "config.yaml"), "utf8")) ?? {}) as Record<
    string,
    any
  >;
  const base = String(config.site?.base_url ?? "").replace(/\/+$/, "");
  expect(base).toBeTruthy();
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  for (const name of ["data.json", "data.csv", "upcoming.md", "llms.txt"]) {
    expect(readme, `README must link the machine-readable output ${name}`).toContain(
      `${base}/${name}`,
    );
  }
});

it("llms.txt URLs match the published site", () => {
  const config = (loadYaml(readFileSync(join(REPO_ROOT, "config.yaml"), "utf8")) ?? {}) as Record<
    string,
    any
  >;
  const base = String(config.site?.base_url ?? "").replace(/\/+$/, "");
  expect(base).toBeTruthy();
  const urls = readFileSync(join(site, "llms.txt"), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("- http"))
    .map((l) => l.slice(2).split(" ", 1)[0]);
  expect(urls.length).toBe(0);
  for (const u of urls) {
    expect(u.startsWith(`${base}/`)).toBe(true);
  }
});

it("llms.txt title follows config site.title (not a stale hard-coded name)", () => {
  // ビルド成果の先頭行は config.yaml の site.title と一致する。
  const config = (loadYaml(readFileSync(join(REPO_ROOT, "config.yaml"), "utf8")) ?? {}) as Record<
    string,
    any
  >;
  const title = String(config.site?.title ?? "");
  expect(title).toBeTruthy();
  const text = readFileSync(join(site, "llms.txt"), "utf8");
  expect(text.split("\n")[0]).toBe(`# ${title}`);
  // デッドコンフィグ再発防止: カスタム site.title が toLlmsTxt の出力に反映される
  const custom = toLlmsTxt({
    site: { title: "custom-site" },
    categories: {},
  });
  expect(custom.split("\n")[0]).toBe("# custom-site");
});

it("llms.txt schema summary documents every key data.json actually emits (site/papers/url)", () => {
  // #237: data.json は site（トップレベル）・papers（会議ごと）・sources[].url を
  // 出力しており、golden test も data.site の存在を検証しているが、llms.txt の
  // スキーマ要約（と SPEC §4.2）はこれらを記載していなかった。
  // エージェントは llms.txt を「最初に読む索引」として使うため、実出力との
  // 乖離をここで回帰検査する。
  const text = readFileSync(join(site, "llms.txt"), "utf8");
  expect(text).toContain("意味検索用の埋め込みが公開物に含まれるか");
  const summary = text.slice(text.indexOf("## data.json のスキーマ要約"));
  // トップレベル site キー（base_url が公開 URL の基準）
  expect(summary).toMatch(/- site: object：\{domain: string, base_url: string\}/);
  expect(summary).toMatch(/base_url/);
  // 出典の url キー
  expect(summary).toMatch(/- sources: array of \{name, repo, license, url\}/);
  // 会議ごとの papers キー
  expect(summary).toMatch(/ {2}- papers: array of string/);
  // 実出力との整合: トップレベルキーは全て要約に現れる
  for (const key of Object.keys(data)) {
    expect(summary).toContain(key);
  }
  // 会議レベルのキーは全て要約に現れる
  for (const key of Object.keys(data.conferences[0] ?? {})) {
    expect(summary).toContain(key);
  }
});

it("README documents every build CLI flag (--no-embeddings regression)", () => {
  // #239: README の build オプション表が --no-embeddings を記載しておらず、
  // usage() / テストだけが知っている状態だった。README はユーザーが最初に読む
  // 文書で、実装（src/cli.ts の usage()）が機械可読契約である。
  // ここでは usage() の build セクションに現れる全 --flag が README に
  // 記載されていることを検証し、将来のフラグ追加・削除の乖離を検出する。
  const lines = usage().split("\n");
  const buildStart = lines.findIndex((l) => l.trim().startsWith("build "));
  const buildEnd = lines.findIndex((l, i) => i > buildStart && l.trim().startsWith("discover "));
  expect(buildStart).toBeGreaterThanOrEqual(0);
  expect(buildEnd).toBeGreaterThan(buildStart);
  const flags = [
    ...new Set(
      lines.slice(buildStart, buildEnd).flatMap((l) => l.match(/--[a-z][a-z0-9-]*/g) ?? []),
    ),
  ];
  expect(flags.length).toBeGreaterThan(0);
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  for (const flag of flags) {
    expect(readme, `README must document the build flag ${flag}`).toContain(flag);
  }
});

it("README documents every discover CLI flag (--categories/--min-year regression)", () => {
  // #247: usage() の discover セクションは 5 つのオプション（--out / --categories /
  // --min-year / --dry-run / --append）を定義するが、README の探索セクションは
  // --dry-run / --out / --append しか記載しておらず、--categories と --min-year が
  // 未記載だった。ここでは discover セクションの全 --flag が README に現れることを検証する
  // （#239 の build 版テストと同じパターンの discover 版）。
  const lines = usage().split("\n");
  const discStart = lines.findIndex((l) => l.trim().startsWith("discover "));
  const discEnd = lines.findIndex((l, i) => i > discStart && l.trim().startsWith("review "));
  expect(discStart).toBeGreaterThanOrEqual(0);
  expect(discEnd).toBeGreaterThan(discStart);
  const flags = [
    ...new Set(lines.slice(discStart, discEnd).flatMap((l) => l.match(/--[a-z][a-z0-9-]*/g) ?? [])),
  ];
  expect(flags).toContain("--categories");
  expect(flags).toContain("--min-year");
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  for (const flag of flags) {
    expect(readme, `README must document the discover flag ${flag}`).toContain(flag);
  }
});

it("README documents every CLI command (review command regression)", () => {
  // usage() の全機能コマンドを README と同期させる。
  expect(usage()).toContain("(既定: public)");
  expect(usage()).toContain("上流アーカイブのキャッシュ先");
  expect(usage()).toContain("ハゲタカ会議の疑い");
  expect(usage()).not.toContain("predatory");
  const commands = usage()
    .split("\n")
    .map((l) => /^ {2}([a-z][a-z0-9-]*) /.exec(l)?.[1])
    .filter((c): c is string => Boolean(c) && c !== "help");
  expect(commands).toContain("build");
  expect(commands).toContain("discover");
  expect(commands).toContain("review");
  expect(commands).toContain("reverify");
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  for (const cmd of commands) {
    expect(readme, `README must document the CLI command ${cmd}`).toContain(cmd);
  }
  expect(readme).toContain("cli.ts evidence");
});

it("SPEC §3.7 documents every CLI command and flag from usage() (#374)", () => {
  const spec = readFileSync(join(REPO_ROOT, "SPEC.md"), "utf8");
  const section = spec.slice(spec.indexOf("### 3.7 "), spec.indexOf("## 4. "));
  expect(section.length).toBeGreaterThan(0);
  const lines = usage().split("\n");
  const commands = lines
    .map((l) => /^ {2}([a-z][a-z0-9-]*) /.exec(l)?.[1])
    .filter((c): c is string => Boolean(c) && c !== "help");
  expect(commands).toEqual(["build", "discover", "review", "reverify", "evidence"]);
  for (const cmd of commands) {
    expect(section, `SPEC §3.7 must document the CLI command ${cmd}`).toContain(cmd);
  }
  const flags = [...new Set(lines.flatMap((l) => l.match(/--[a-z][a-z0-9-]*/g) ?? []))].filter(
    (f) => f !== "--help",
  );
  expect(flags).toContain("--no-embeddings");
  for (const flag of flags) {
    expect(section, `SPEC §3.7 must document the CLI flag ${flag}`).toContain(flag);
  }
});

it("SPEC §3.7 documents parseNow TZ and T24:00 fail-closed (#404)", () => {
  const spec = readFileSync(join(REPO_ROOT, "SPEC.md"), "utf8");
  const section = spec.slice(spec.indexOf("### 3.7 "), spec.indexOf("## 4. "));
  expect(section).toMatch(/offset|タイムゾーン|timezone/i);
  expect(section).toMatch(/T24:00|24:00/);
  expect(section).toMatch(/日付だけ|date-only|YYYY-MM-DD/);
});

it("SPEC §2 tree documents every src / site / data yaml / scripts ts file (#378/#380)", () => {
  const spec = readFileSync(join(REPO_ROOT, "SPEC.md"), "utf8");
  const section = spec.slice(spec.indexOf("## 2."), spec.indexOf("## 3."));
  const fenceStart = section.indexOf("```");
  const fenceEnd = section.indexOf("```", fenceStart + 3);
  const tree = section.slice(fenceStart, fenceEnd);
  expect(tree.length).toBeGreaterThan(0);
  const names = [
    ...readdirSync(join(REPO_ROOT, "src")).filter((f) => f.endsWith(".ts")),
    ...readdirSync(join(REPO_ROOT, "src", "sources")).filter((f) => f.endsWith(".ts")),
    ...readdirSync(join(REPO_ROOT, "site")),
    ...readdirSync(join(REPO_ROOT, "data")).filter((f) => /\.ya?ml$/i.test(f)),
    ...readdirSync(join(REPO_ROOT, "scripts")).filter((f) => f.endsWith(".ts")),
  ];
  expect(names).toContain("bench-recommender.ts");
  expect(names).toContain("recommender.ts");
  expect(names).toContain("primary.yaml");
  expect(names).toContain("compare-head.ts");
  for (const name of names) {
    expect(tree, `SPEC §2 must list ${name}`).toContain(name);
  }
  expect(tree).toContain("semantic-content.ts");
  expect(tree).toMatch(/sources\/[\s\S]*primary\.ts/);
  const workflows = readdirSync(join(REPO_ROOT, ".github", "workflows")).filter((file) =>
    file.endsWith(".yml"),
  );
  expect(workflows).toEqual(
    expect.arrayContaining([
      "ci.yml",
      "deploy.yml",
      "nightly.yml",
      "recommendation-bundle.yml",
      "update-data.yml",
    ]),
  );
  for (const name of workflows) {
    expect(tree, `SPEC §2 must list workflow ${name}`).toContain(name);
  }
});

it("AGENTS.md names canonical local sources instead of extra.yaml as live truth", () => {
  const agents = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");
  expect(agents).toContain("manual.yaml");
  expect(agents).toContain("curated.generated.yaml");
  expect(agents).toContain("data/extra.yaml");
  expect(agents).toMatch(/extra\.yaml.*正典ではない/);
  expect(agents).toContain("--no-embeddings");
});

it("GATES.md tracks restored CI instead of the deleted-CI note", () => {
  const gates = readFileSync(join(REPO_ROOT, "GATES.md"), "utf8");
  expect(gates).toContain(".github/workflows/ci.yml");
  expect(gates).not.toMatch(/CI\/CD は .*削除/);
  expect(gates).not.toContain("next-last-known-good-health.json");
});

it("full-benchmark workflows pin the real-paper feature store", () => {
  const nightly = readFileSync(join(REPO_ROOT, ".github/workflows/nightly.yml"), "utf8");
  const bundle = readFileSync(
    join(REPO_ROOT, ".github/workflows/recommendation-bundle.yml"),
    "utf8",
  );
  const repro = readFileSync(join(REPO_ROOT, "scripts/check-reproducible-build.zsh"), "utf8");
  expect(nightly).toContain("--real-v2-features data/benchmarks/real-paper-features.jsonl");
  expect(bundle).toContain("--real-v2-features data/benchmarks/real-paper-features.jsonl");
  expect(repro).toContain("--no-embeddings");
});

it("SPEC §4 documents every file a standard build generates (embeddings.json/recommender.js regression)", () => {
  // #241: SPEC §4 の生成物一覧が embeddings.json と recommender.js を記載しておらず、
  // 標準 build（node src/cli.ts build --out public）が生成する 2 ファイルが目録から
  // 欠落していた。SPEC は実装の正であり、§4 の表は生成物の正準目録なので、
  // 生成される全ファイルが §4 節に現れることをここで回帰検査する。
  // （buildAll が書く .nojekyll は PUBLIC_FILES に含まれないが、§4 には既に記載済み。）
  const spec = readFileSync(join(REPO_ROOT, "SPEC.md"), "utf8");
  const section4 = spec.slice(spec.indexOf("## 4. 生成物"), spec.indexOf("## 5."));
  expect(section4.length).toBeGreaterThan(0);
  const generated = [...PUBLIC_FILES, "embeddings.json", "recommender.js"];
  for (const name of generated) {
    expect(section4, `SPEC §4 must document the generated file ${name}`).toContain(name);
  }
});

it("index.html has the data injected", () => {
  const text = readFileSync(join(site, "index.html"), "utf8");
  expect(text).not.toContain("/*__DATA__*/null");
  expect(text).toContain("conferences");
  expect(siteRuntime()).toContain("__KAMIYOBI_DATA__");
});

it("build splits catalog, recommendation, and historical payloads (#468)", () => {
  const catalog = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8"));
  const recommendation = JSON.parse(readFileSync(join(site, "recommendation-index.json"), "utf8"));
  expect(catalog.history_ref).toBe("data.json");
  expect(catalog.recommendation_ref).toBe("recommendation-index.json");
  expect(catalog.conferences[0]).not.toHaveProperty("papers");
  expect(recommendation.embedding_ref).toBe("embeddings.json");
  expect(recommendation.conferences[0]).toHaveProperty("papers");
  expect(recommendation.conferences.every((conference: any) => conference.acronym)).toBe(true);
  expect(recommendation.conferences[0].editions.every((e: any) => e.deadlines.length <= 1)).toBe(
    true,
  );
  expect(readFileSync(join(site, "index.html"), "utf8")).not.toContain('"papers":');
  expect(data.conferences.length).toBeGreaterThanOrEqual(catalog.conferences.length);
});

it("carries every fielded recommendation profile value into the compact index", () => {
  const conf = makeConference({
    key: "profiled",
    title: "PROFILED",
    acronym: "PRF",
    scope: ["Distributed systems"],
    official_scope: ["Reliable storage"],
    paper_abstracts: ["A replicated storage abstract"],
    keywords: ["replication"],
    editions: [
      makeEdition({
        year: 2027,
        deadlines: [
          makeDeadline("paper", "Paper submission", new Date("2027-01-02T23:59:00.000Z"), "UTC"),
        ],
      }),
    ],
  });
  const recommendation = toRecommendationIndex(toJson([conf], {}, NOW), NOW);
  expect((recommendation.conferences as any[])[0]).toMatchObject({
    acronym: "PRF",
    scope: ["Distributed systems"],
    official_scope: ["Reliable storage"],
    paper_abstracts: ["A replicated storage abstract"],
    keywords: ["replication"],
  });
});

it("generated_at follows the --now argument", () => {
  const other = join(mkdtempSync(join(tmpdir(), "cfp-site3-")), "public3");
  const run = runCli(other, { now: "2027-01-02T00:00:00Z", extra: ["--no-embeddings"] });
  expect(run.status, run.stderr).toBe(0);
  const payload = JSON.parse(readFileSync(join(other, "data.json"), "utf8"));
  expect(payload.generated_at).toBe("2027-01-02T00:00:00Z");
  expect(payload.generated_at).not.toBe(data.generated_at);
  expect(NOW.toISOString()).toBe("2026-08-09T00:00:00.000Z");
}, 300_000);

// --- meeting-only conferences keep dates; site table stays paper-only (SPEC §7/§8) ---

it("conferences without deadlines keep their meeting dates", () => {
  for (const key of ["isc-hpc", "hoti", "apnoms"]) {
    const c = conf(key);
    const dated = c.editions.filter((e: any) => e.event_start);
    expect(dated.length).toBeGreaterThan(0);
    for (const ed of dated) {
      expect(ed.deadlines.length).toBe(0);
    }
  }
});

it("index.html has no meeting rows", () => {
  const html = siteHtmlRuntime();
  expect(html).not.toContain('event: "開催"');
  expect(html).toContain("KIND_LABEL[r.kind]");
  expect(html).toMatch(/r\.kind !== "abstract"\s*&&\s*r\.kind !== "paper"/);
  for (const title of ["ISC High Performance", "HOTI", "情報処理学会 HPC 研究会"]) {
    expect(html).toContain(title);
  }
});

it("SPEC §8 no longer claims meeting-only conferences appear as index.html rows (#372)", () => {
  const spec = readFileSync(join(REPO_ROOT, "SPEC.md"), "utf8");
  const section8 = spec.slice(spec.indexOf("## 8."), spec.indexOf("## 9."));
  expect(section8).not.toMatch(/開催回が index\.html に届いている/);
  expect(section8).toMatch(/index\.html has no meeting rows/);
  expect(section8).toMatch(/upcoming\.md/);
});

it("index.html 7d preset uses a real 7-day window", () => {
  const html = siteHtmlRuntime();
  // 「締切直近 (7日以内)」プリセットは 7 日窓で動作し、ドロップダウンに 7d がある
  expect(html).toContain("applyPreset('7d')");
  // 7 日窓の対応は recommender の条件表が正本（ボタン側は出し入れの規則を持たない）。
  expect(siteRuntime("recommender.js")).toMatch(/"7d":\s*\{\s*win:\s*"7d"/);
  expect(html).toContain('value="7d">7 日以内</option>');
  // 30 日窓への偽代入が残っていない（回帰防止）
  expect(siteRuntime("recommender.js")).not.toMatch(/"7d":\s*\{\s*win:\s*"30d"/);
});

it("index.html has domestic filter and tag", () => {
  const html = siteHtmlRuntime();
  expect(html).toContain('id="domestic"');
  expect(html).toContain("domestic-jp");
  expect(html).toContain('textContent = "国内"');
  // 読み側も同じ鍵を見ている（値の形は urlFlagJa に寄せた・SPEC §7）。
  expect(html).toContain('p.get("domestic")');
  expect(html).toContain("state.domestic = domesticFlag.on");
  for (const title of [
    "情報処理学会 OS 研究会",
    "電子情報通信学会 NS 研究会",
    "電子情報通信学会 IA 研究会",
    "電子情報通信学会 CQ 研究会",
    "電子情報通信学会 ICM 研究会",
    "APNOMS",
    "FIT",
  ]) {
    expect(html).toContain(title);
  }
});

// --- coincident deadlines are told apart (SPEC.md 3.6) ---------------------

it("coincident deadlines get distinguishable titles", async () => {
  const at = utc(2026, 9, 21, 22, 0, 0);
  const confs = [
    makeConference({
      key: "acm-siggraph",
      title: "SIGGRAPH",
      categories: ["ai"],
      sources: ["aideadlines"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "siggraph26",
          source: "aideadlines",
          deadlines: [
            makeDeadline("paper", "Posters deadline", at),
            makeDeadline("paper", "Appy Hour deadline", at),
            makeDeadline("paper", "Technical Papers deadline", utc(2026, 10, 22, 22, 0, 0)),
          ],
        }),
      ],
    }),
  ];
  const records = recordsOf(confs);
  expect(records.map((r) => r.kind_label).sort()).toEqual(
    ["論文締切", "論文締切: Appy Hour deadline", "論文締切: Posters deadline"].sort(),
  );
});

it("title ending with the edition year is not duplicated in SUMMARY/upcoming", async () => {
  const at = utc(2026, 12, 1, 22, 0, 0);
  const confs = [
    makeConference({
      key: "canopie-hpc-2026",
      title: "CANOPIE-HPC 2026",
      categories: ["hpc"],
      sources: ["aideadlines"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "canopie-hpc-2026-2026",
          source: "aideadlines",
          deadlines: [makeDeadline("paper", "Submission", at)],
        }),
      ],
    }),
    // タイトルに年が無い会議は従来どおり「タイトル + 年」
    makeConference({
      key: "plain-conf",
      title: "PLAIN",
      categories: ["hpc"],
      sources: ["aideadlines"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "plain-conf-2026",
          source: "aideadlines",
          deadlines: [makeDeadline("paper", "Submission", utc(2026, 12, 2, 22, 0, 0))],
        }),
      ],
    }),
  ];
  const upcoming = toUpcomingMd(recordsOf(confs), NOW);
  expect(upcoming).toContain("[CANOPIE-HPC 2026](http");
  expect(upcoming).not.toContain("[CANOPIE-HPC 2026 2026]");
  expect(upcoming).toContain("[PLAIN 2026](");
});

it("embeddingsStale は profile と manifest の不一致を再生成する", () => {
  const make = (keys: string[]) => {
    const data = {
      categories: {},
      conferences: keys.map((key) => ({
        key,
        title: key,
        full_name: key,
        categories: [],
        tags: [],
      })),
    };
    const probe = new Array(EMBEDDING_DIM).fill(0);
    const manifest = embeddingManifest(data, { en: probe, multi: probe });
    return {
      data,
      file: {
        model: EMBEDDING_MODEL,
        dim: EMBEDDING_DIM,
        venuePapersHash: venuePapersHash(),
        embeddings: Object.fromEntries(keys.map((k) => [k, probe])),
        multi: {
          model: EMBEDDING_MULTI_MODEL,
          dim: EMBEDDING_DIM,
          embeddings: Object.fromEntries(keys.map((k) => [k, probe])),
        },
        paperVecs: {},
        manifest,
      },
    };
  };
  const emb = (keys: string[]) => make(keys);
  const fresh = emb(["a", "b", "c"]);
  // 同一キー集合 → stale でない
  expect(embeddingsStale(fresh.file, fresh.data)).toBe(false);

  const paperData = {
    categories: {},
    conferences: [
      {
        key: "rtss",
        title: "RTSS",
        full_name: "Real-Time Systems Symposium",
        categories: [],
        tags: [],
      },
    ],
  };
  const paperProbe = new Array(EMBEDDING_DIM).fill(0);
  const paperFile = {
    model: EMBEDDING_MODEL,
    dim: EMBEDDING_DIM,
    venuePapersHash: venuePapersHash(),
    embeddings: { rtss: paperProbe },
    multi: { model: EMBEDDING_MULTI_MODEL, dim: EMBEDDING_DIM, embeddings: { rtss: paperProbe } },
    paperVecs: { rtss: [paperProbe, paperProbe.slice()] },
    manifest: embeddingManifest(paperData, { en: paperProbe, multi: paperProbe }),
  };
  // paperVecs は flat vector map ではなく、複数の paper vector を持つ nested map。
  expect(embeddingsStale(paperFile, paperData)).toBe(false);
  expect(
    embeddingsStale(
      {
        ...paperFile,
        manifest: { ...paperFile.manifest, runtime_version: "old-runtime" },
      },
      paperData,
    ),
  ).toBe(true);
  expect(embeddingsStale({ ...paperFile, paperVecs: { rtss: paperProbe } }, paperData)).toBe(true);
  expect(
    embeddingsStale(
      { ...paperFile, paperVecs: { rtss: [paperProbe, paperProbe.slice(0, -1)] } },
      paperData,
    ),
  ).toBe(true);

  // 数が同じでもキーが入れ替わったら stale（数比較だと見逃す）
  expect(embeddingsStale(fresh.file, emb(["a", "b", "d"]).data)).toBe(true);
  expect(embeddingsStale(fresh.file, emb(["a", "c", "b"]).data)).toBe(false); // 順序は無関係
  // 数が変わったら stale
  expect(embeddingsStale(fresh.file, emb(["a", "b"]).data)).toBe(true);
  expect(embeddingsStale(emb(["a", "b"]).file, fresh.data)).toBe(true);
  // プロファイルの title/full_name/tags/category 変更も stale
  const changed = structuredClone(fresh.data);
  changed.conferences[0].title = "changed";
  expect(embeddingsStale(fresh.file, changed)).toBe(true);
  // manifest / multilingual / model metadata が無い旧形式は stale
  // embeddings が無い既存データ → stale
  expect(embeddingsStale({}, fresh.data)).toBe(true);
  expect(embeddingsStale({ ...fresh.file, manifest: undefined }, fresh.data)).toBe(true);
  expect(embeddingsStale({ ...fresh.file, multi: undefined }, fresh.data)).toBe(true);
  expect(embeddingsStale({ ...fresh.file, model: "wrong" }, fresh.data)).toBe(true);
  expect(
    embeddingsStale(
      {
        ...fresh.file,
        manifest: {
          ...fresh.file.manifest,
          models: {
            ...fresh.file.manifest.models,
            en: { ...fresh.file.manifest.models.en, revision: "wrong" },
          },
        },
      },
      fresh.data,
    ),
  ).toBe(true);
});

it("offline build is reproducible from fixtures without live discovery", () => {
  // offline build が fixture + snapshot だけで再現できることを確認する。
  // ここでは discover と build が分離されていることだけを確認する。
  const cli = readFileSync(join(REPO_ROOT, "src/cli.ts"), "utf8");
  expect(cli).toContain("discover");
  expect(cli).toContain("build");
});

it("DEFAULT_CATEGORIES contains all 9 taxonomy domains", () => {
  const expectedDomains = [
    "hpc",
    "networking",
    "systems",
    "ai",
    "security",
    "db",
    "graphics",
    "hci",
    "theory",
  ];
  for (const domain of expectedDomains) {
    expect(DEFAULT_CATEGORIES[domain]).toBeTruthy();
  }
});

it("upcoming.md writes each deadline in its official zone, not blanket AoE (SPEC §4)", () => {
  // JST 宣言の締切を AoE 壁時計で出すと「当日早朝まで」と誤読される（site の §7 と同じ規則）。
  // 暦日の曜日も添える（一覧と同じ規則。ビルド・閲覧者のタイムゾーンに依存しない）。
  expect(deadlineWhenText(new Date("2026-08-17T14:59:00Z"), "UTC+9")).toBe(
    "2026-08-17(月) 23:59 JST",
  );
  expect(deadlineWhenText(new Date("2026-08-17T14:59:00Z"), "JST")).toBe(
    "2026-08-17(月) 23:59 JST",
  );
  // AoE は UTC-12 の壁時計。UTC 2026-02-07 11:59 は AoE では 2026-02-06 23:59。
  expect(deadlineWhenText(new Date("2026-02-07T11:59:00Z"), "AoE")).toBe(
    "2026-02-06(金) 23:59:00 AoE",
  );
  expect(deadlineWhenText(new Date("2026-02-07T11:59:00Z"), "UTC-12")).toContain("AoE");
  expect(deadlineWhenText(new Date("2026-02-06T11:59:00Z"), "UTC")).toBe(
    "2026-02-06(金) 11:59:00 UTC",
  );
  expect(deadlineWhenText(new Date("2026-02-06T11:59:00Z"), null)).toBe(
    "2026-02-06(金) 11:59:00 UTC",
  );
  // 未知の公式表記は換算せず、UTC 壁時計に原文を添える。
  expect(deadlineWhenText(new Date("2026-02-06T11:59:00Z"), "PT")).toBe(
    "2026-02-06(金) 11:59:00 UTC（公式 PT）",
  );
  // 暦日として読めない値には曜日を付けない（Date.UTC の暦月繰り越しに騙されない）。
  expect(calendarDayJa("2026-13-45")).toBe("");
  expect(calendarDayJa("2026-08-17")).toBe("月");
  expect(calendarDayJa(new Date("2026-08-17T23:00:00Z"))).toBe("月");
  expect(calendarDayJa(null)).toBe("");

  const rows = upcomingRows(site);
  const domestic = rows.filter((r) => /研究会|シンポジウム/.test(r[2]));
  expect(domestic.length).toBeGreaterThan(0);
  // 国内研究会・シンポジウムの行は JST 表記で、AoE 壁時計が残っていない。
  for (const row of domestic) {
    if (row[0].includes("時刻未確認")) continue;
    expect(row[0]).not.toContain("AoE");
  }
  expect(rows.some((r) => r[0].endsWith("JST"))).toBe(true);
});

it("the empty deadline state names the filters that caused it (SPEC §7)", () => {
  // 案内は選択肢の実ラベルを指すので、その定数も正本（ビルド後）から入れる
  // （抜き出しは tests/runtime_extract.ts に共有した – 第 248 回）。
  const hint = deadlineHintFunction();
  /* 案内は「いまその条件で何行が隠れているか」を添える（第 136 回）。外している条件の
   * 数字は並ばないので、見立ての側でも内訳を渡す（渡さないと呼び出し側の実装と違う）。 */
  const clear = {
    window: "all",
    past: true,
    cats: 0,
    domestic: false,
    rank: "all",
    kind: "",
    query: "",
    est: true,
    hiddenKindWords: [],
    queryMatch: { catalog: 0, journal: 0 },
    termCounts: [],
    catalogConferences: 12,
    hidden: {
      past: 1200,
      est: 134,
      window: 438,
      rank: 416,
      cats: 88,
      domestic: 61,
      online: 462,
      kind: 900,
    },
  };
  // 条件を全部外して 0 件のときは、表に出ない種別（開催行）を説明する。
  expect(hint(clear)).toContain("upcoming.html");
  expect(hint(clear)).not.toContain("期間を");
  // 条件が残っているときは、外せる条件を実名で挙げる。
  const filtered = hint({ ...clear, window: "7d", past: false, query: "機械学" });
  // 案内は選択肢の実ラベルを書く（古いラベルを出すと、その語が画面に見つからない）。
  expect(filtered).toContain("「締切まで」を「かまわない」に変更");
  expect(filtered).toContain("「過去の締切も表示」をオン");
  /* 第 256 回: 「検索語を短くする」は、短くしても 0 件の語に効かない助言だったので、
   * 収録の上で効く見当が無ければ「別の語で試す」に変わった（効く見当があるときの文は
   * tests/zero_result_recovery.test.ts で見る）。 */
  expect(filtered).toContain("別の語で試す");
  expect(filtered).not.toContain("検索語を短くする");
  expect(hint({ ...clear, domestic: true, cats: 2, rank: "A*" })).toContain(
    "「国内研究会・国内シンポジウムのみ」をオフ",
  );
  /* 検索語が表に出さない種別（採否通知など）に当たっている場合。語は てびき と件数欄に
   * 出るのに表は投稿締切だけを出すので、「収録が無い」と誤解させる案内では止めない。 */
  const hiddenKind = hint({ ...clear, query: "採否", hiddenKindWords: ["採否通知"] });
  expect(hiddenKind).toContain("検索語は「採否通知」の種別に当たります");
  expect(hiddenKind).toContain("表には投稿締切だけを出します");
  // 外せる条件が無いなら、原因だけで打ち切る（使えない助言を並べない）。
  expect(hiddenKind).not.toContain("多いのは");
  expect(hiddenKind).not.toContain("外せる条件");
  /* 原因が特定できたなら、推測で並べる「多いのは」には切り替えない。
   * 原因を先に立て、後ろに実際に外せる条件だけを添う。 */
  const hiddenKindFiltered = hint({
    ...clear,
    past: false,
    domestic: true,
    query: "採否",
    hiddenKindWords: ["採否通知"],
  });
  expect(hiddenKindFiltered).toContain("外せる条件:");
  expect(hiddenKindFiltered).not.toContain("多いのは");
  expect(hiddenKindFiltered.indexOf("検索語は")).toBeLessThan(
    hiddenKindFiltered.indexOf("外せる条件"),
  );
  expect(hiddenKindFiltered).toContain("「国内研究会・国内シンポジウムのみ」をオフ");
  // 当たっていないときに誤った説明を出さない。
  expect(hint({ ...clear, query: "nsdi", hiddenKindWords: [] })).not.toContain("種別に当たります");
  /* 種別に当たっているとき、件数の説明で「いまの絞り込みで 0 件」とは書かない（外しても
   * 増えないので噓になる）。行き先のファイルを、件数と一緒に言う（第 247 回。
   * 2026-08-09 生成ビルドの実測: 「採択通知」は収録 129 件に当たって画面は 0 件なのに、
   * 案内は「既定と、いまの絞り込みで 0 件になっています」と言っていた）。 */
  const hiddenKindHits = hint({
    ...clear,
    query: "採択通知",
    hiddenKindWords: ["採否通知"],
    queryMatch: { catalog: 129, journal: 0 },
  });
  expect(hiddenKindHits, "当たった件数を出していない").toContain("この 129 件は表には出ず");
  expect(hiddenKindHits, "行き先を書いていない").toContain("upcoming.html");
  expect(hiddenKindHits, "外しても増えないのに絞り込みのせいにしている").not.toContain(
    "いまの絞り込みで 0 件",
  );

  /* 種別の絞り込みも外せる条件として名指す。数えないと、案内どおりに他を外しても 0 件のまま。
   * 書き方はセレクトの実ラベルに揃える。 */
  const kindFilter = hint({ ...clear, kind: "abstract", query: "音声" });
  expect(kindFilter).toContain("「種別」を「投稿締切（概要・論文）」に変更");
  expect(hint({ ...clear, kind: "" })).not.toContain("「種別」を");
  /* ラベルは 1 箇所の実装から出す。選択肢の生成も案内も定数を読む形にして、
   * 案内が古いラベルを指す事故を防ぐ（説明コメントに同じ語が現れるのは許す）。 */
  const runtimeForKindLabel = siteRuntime();
  expect(
    runtimeForKindLabel.match(/const KIND_ALL_LABEL_JA = "投稿締切（概要・論文）";/g)?.length,
  ).toBe(1);
  expect(runtimeForKindLabel).toContain("optAllK.textContent = KIND_ALL_LABEL_JA;");
  /* 案内の書き方そのもの（`tips.push` か別の helper 経由か）は固定しない。
   * 見たいのは「案内がセレクトと同じ定数を読んでいる」ことだけ（第 136 回で案内の項目は
   * `tip(...)` 経由になり、呼び出し形のピンは実装の形を縛るだけになった）。 */
  expect(
    /`「種別」を「\$\{KIND_ALL_LABEL_JA\}」に変更`/.test(runtimeForKindLabel),
    "案内がラベルを読み替えている",
  ).toBe(true);

  /* 検索語が収録データ全体では行に当たるのに、既定（投稿締切・未来だけ）といまの絞り込みで
   * 0 件になることがある（`情報検索` は 17 件収録なのに既定画面では 0 件）。
   * 「 kamiyobi に無い」と「今出していない」を区別できないと、そこで検索をやめてしまう。 */
  const hiddenByDefault = hint({
    ...clear,
    query: "情報検索",
    queryMatch: { catalog: 17, journal: 0 },
  });
  expect(hiddenByDefault).toContain("検索語「情報検索」は収録済みで 17 件に当たります");
  expect(hiddenByDefault).toContain("表は投稿締切でこれから先のものだけを出す既定");
  // 常時受付ジャーナルに当たるときは、種別で出せることを続ける。
  expect(hint({ ...clear, query: "情報検索", queryMatch: { catalog: 20, journal: 3 } })).toContain(
    "常時受付のジャーナル 3 件は「種別」で選べます",
  );
  // 原因が分かっていれば、別の理由を並べて「結局どうすればいいか」を埋めない。
  const catalogCase = hint({
    ...clear,
    past: false,
    query: "情報検索",
    queryMatch: { catalog: 17, journal: 0 },
  });
  expect(catalogCase).not.toContain("upcoming.html");
  expect(catalogCase).not.toContain("検索語を短くする");
  // 外せる条件が残っていれば、それは後ろに添う（原因だけで打ち切らない）。
  expect(catalogCase).toContain("「過去の締切も表示」をオン");
  // 原因が特定できないときは、今までどおり会期のみ案内を添える。
  expect(hint({ ...clear, past: false, query: "xyzzy" })).toContain("upcoming.html");

  // 収録に無い語で「当たります」と嘘をつかない。
  expect(hint({ ...clear, query: "xyzzy", queryMatch: { catalog: 0, journal: 0 } })).not.toContain(
    "収録済みで",
  );
  // 検索語が無いときに件数の説明を出さない（0 件の原因が絞り込みだけのケース）。
  expect(hint({ ...clear, query: "", queryMatch: { catalog: 40, journal: 0 } })).not.toContain(
    "収録済みで",
  );
  // 0 件メッセージは表の直下に出る（別ページへ飛ばさない）。
  const runtime = siteRuntime();
  expect(runtime).toContain('$("emptyText").textContent = emptyDeadlineHint(');
  // 案内が使う語は `SELECTABLE_KINDS` から求める（書き写すと増えた種別が案内から落ちる）。
  expect(runtime).toContain("hiddenKindQueryWords(searchQuery)");
  // 収録データ全体での当たり件数も同じ案内に渡す（「無い」と「出してない」を分けるため）。
  expect(runtime).toContain("queryMatch: queryMatchCounts(searchQuery)");
  // 「明日」「今週」を暦日へ解決したことも、同じ件数欄でおしらせする。
  expect(runtime).toContain("Recommender.relativeDayNotes(searchQuery, Date.now())");
});

it("weekday suffixes for date-only deadlines and 会期 are viewer-timezone independent (SPEC §7)", () => {
  const rec = siteRuntime("recommender.js");
  const constSrc = rec.match(/const CALENDAR_DATE_JA = \[[^\]]*\];/)?.[0];
  expect(constSrc, "CALENDAR_DATE_JA 定義が見つからない").toBeTruthy();
  const script = [
    constSrc as string,
    jsFunction(rec, "weekdayJaFromDate"),
    "const days = ['2026-12-17', '2026-12-18', '2026-09-30', '2027-03-01', '2026-13-45', ''];",
    "console.log(JSON.stringify(days.map(weekdayJaFromDate)));",
  ].join("\n");
  const outputs = ["Asia/Tokyo", "UTC", "America/Los_Angeles", "Pacific/Kiritimati"].map((TZ) => {
    const proc = spawnSync("node", ["-e", script], {
      encoding: "utf8",
      env: { ...process.env, TZ },
      timeout: 60_000,
    });
    expect(proc.status, proc.stderr).toBe(0);
    return proc.stdout.trim();
  });
  expect(outputs[0]).toBe(JSON.stringify(["木", "金", "水", "月", "", ""]));
  for (const out of outputs) expect(out).toBe(outputs[0]);

  // 一覧の date-only 行は同じ関数を通す（瞬間を作って TZ でズレさせない）。
  const app = siteRuntime();
  expect(app).toContain("Recommender.weekdayJaFromDate(r.localDate)");
  // 会期は一覧・行の詳細・CSV で共有する式（`eventCellJa`）へ寄った。画面側はその式を
  // 呼ぶこと、式中の曜日が正本の `weekdayJaFromDate` が出ることを確かめる。
  expect(app).toContain("Recommender.eventCellJa(r)");
  const evSrc = jsFunction(rec, "eventCellJa");
  expect(evSrc, "eventCellJa が見つからない").toBeTruthy();
  expect(evSrc).toContain("weekdayJaFromDate(");
  // 会期列の表示語そのものが TZ でズレないことの実測（一覧・詳細・CSV が同じ式を使う
  // ので、この実測が3画面分をまとめて持つ）。
  const evScript = [
    constSrc as string,
    jsFunction(rec, "weekdayJaFromDate"),
    jsFunction(rec, "eventCellJa"),
    "const rows = [",
    "  { event_start: '2026-12-03', event_end: '2026-12-04' },",
    "  { event_start: '2026-09-30', event_end: '' },",
    "  { event_start: '2027-03-01', event_end: '2027-03-05' },",
    "  { date_text: 'TBD 2027' },",
    "].map((ed) => eventCellJa({ ed }));",
    "console.log(JSON.stringify(rows));",
  ].join("\n");
  const evOutputs = ["Asia/Tokyo", "UTC", "America/Los_Angeles", "Pacific/Kiritimati"].map((TZ) => {
    const proc = spawnSync("node", ["-e", evScript], {
      encoding: "utf8",
      env: { ...process.env, TZ },
      timeout: 60_000,
    });
    expect(proc.status, proc.stderr).toBe(0);
    return proc.stdout.trim();
  });
  expect(evOutputs[0]).toBe(
    JSON.stringify([
      "2026-12-03(木) 〜 2026-12-04(金)",
      "2026-09-30(水)",
      "2027-03-01(月) 〜 2027-03-05(金)",
      "TBD 2027",
    ]),
  );
  for (const out of evOutputs) expect(out).toBe(evOutputs[0]);
});

it("the deadline search index carries Japanese month terms (SPEC §7)", () => {
  const runtime = siteRuntime("recommender.js");
  // 会期の `date_text` は国際会議だと英語表記なので、月での検索は ISO 暦日から作る。
  expect(runtime).toContain("monthTermsJa(ed.event_start)");
  expect(runtime).toContain("monthTermsJa(ed.event_end)");
  // 締切側は日付だけの値をそのまま、時刻を持つ値は JST の暦日で読む。
  // 暦日の読み出しは月語・日語で共有する（`calendarDateJa` に寄せる。書き写すと
  // 月と日で違う基準日を使い得る）。
  expect(runtime).toContain("monthTermsJa(dateOnly ? dl.local_date : t)");
  expect(runtime).toContain("dayTermsJa(dateOnly ? dl.local_date : t)");
  expect(runtime).toMatch(/calendarDateJa[\s\S]*new Date\(value \+ 9 \* 3_600_000\)/);
  expect(runtime).toMatch(/function monthTermsJa[\s\S]*?calendarDateJa\(value\)/);
});

it("upcoming.md keeps domestic deadlines off AoE and official-zone notation (SPEC §4)", () => {
  const data = JSON.parse(readFileSync(join(site, "data.json"), "utf8")) as {
    conferences: Array<{
      key: string;
      link?: string;
      tags?: string[];
      editions?: Array<{ link?: string }>;
    }>;
  };
  // md の行は公式ページへのリンクを持つので、そこから国内会議かを判定する。
  const domesticByLink = new Map<string, boolean>();
  for (const conf of data.conferences) {
    const domestic = (conf.tags || []).indexOf("domestic-jp") >= 0;
    const links = new Set<string>([conf.link || ""]);
    for (const ed of conf.editions || []) links.add(ed.link || "");
    for (const link of links) if (link) domesticByLink.set(link, domestic);
  }
  let domesticDeadlineRows = 0;
  for (const line of readFileSync(join(site, "upcoming.md"), "utf8").split("\n")) {
    if (!line.startsWith("| ") || /^\|-/.test(line)) continue;
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length < 7 || cells[0] === "日付" || cells[3] === "開催") continue;
    const link = /\]\((https?:\/\/[^)]+)\)/.exec(cells[2]);
    if (!link || domesticByLink.get(link[1]) !== true) continue;
    domesticDeadlineRows += 1;
    // JST 宣言が大半で、時刻未確認は日付だけ。AoE や「公式 PT」を国内の締切に載せない
    // という規則は md でも同じ（ビルド側だけ崩れてもテストが黙っている状態を避ける）。
    expect(cells[0], `${cells[2]} の国内締切行に AoE/公式ゾーン表記が出ている`).not.toMatch(/AoE/);
    expect(cells[0]).not.toMatch(/公式 PT|公式 UTC/);
  }
  // 1 件も無いと検査が空回りするので、この検査が実際に効いていることを確認する。
  expect(domesticDeadlineRows).toBeGreaterThan(0);
});

it("the 残り vocabulary in the table is documented in the guide (SPEC §7)", () => {
  const runtime = siteRuntime();
  const template = readFileSync(join(site, "index.html"), "utf8");
  const remainSrc = jsFunction(runtime, "remain");
  // 文言を変えても てびき だけ古いまま、ということが起きないようにする。
  // ラベルは remain() 側の断片ごとに検査する（テンプレート文字列なので前後の空白込み）。
  for (const fragment of ['"本日終了"', "日前に終了", '"まもなく"', "あと ${", " 時間`", " 日`"]) {
    expect(remainSrc, `remain() の文言が変わった: ${fragment}`).toContain(fragment);
  }
  // 日付だけの締切の残りは `remain()` を通らない（呼び出し側で「時刻未確認」を出す）。
  expect(runtime).toContain('{ text: "時刻未確認"');
  const help = template.slice(template.indexOf('id="helpPanel"'));
  const guide = help.slice(0, help.indexOf("</dl>"));
  for (const word of [
    "残り",
    "あと N 日",
    "あと N 時間",
    "まもなく",
    "本日終了",
    "日前に終了",
    "時刻未確認",
  ]) {
    expect(guide, `てびきに ${word} の説明がない`).toContain(word);
  }
  // 「過去の締切は既定で出さない」はEmpty 状態の案内と食い違うと誤解を招くので、同じ場所で説明する。
  expect(guide).toContain("過去の締切も表示");
});

it("upcoming.md and llms.txt explain the coverage window and the JST basis (SPEC §4)", () => {
  const md = readFileSync(join(site, "upcoming.md"), "utf8");
  const head = md.split("\n").slice(0, 12).join("\n");
  // md を単体で読む人に「いつの時点の、いつまでの表か」伝えないと表を使えない。
  /* 単位は括弧の外に一度だけ。「JST では … 09:00 JST」のように二度書くと読みづらい
   * （第 283 回まで `upcoming.md` と `upcoming.html` に出ていた – SPEC §7）。 */
  expect(head).toMatch(
    /生成時刻: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z（JST では \d{4}-\d{2}-\d{2}\([月火水木金土日]\) \d{2}:\d{2}）/,
  );
  expect(head).toMatch(/対象期間: \d{4}-\d{2}-\d{2} 〜 \d{4}-\d{2}-\d{2}\([月火水木金土日]\)/);
  // 会期行は生成時刻より前に開いていても載る（説明と実データが噛み合っていればよい）。
  expect(head).toContain("進行中の会期");

  const llms = readFileSync(join(site, "llms.txt"), "utf8");
  // サイトの見た目は国内研究会の収録と JST 基準が主役なので、llms.txt も同じ説明にする。
  expect(llms).toContain("domestic-jp");
  expect(llms).toContain("国内研究会");
  expect(llms).toContain("JST");
  expect(llms).toContain("## サイト（index.html）の日本語での引き方");
  for (const phrase of ["月で引ける", "都道府県で引ける", "BOM 付き CSV", "印刷時"]) {
    expect(llms, phrase).toContain(phrase);
  }
});

it("the shared URL keeps the sort order the sender was looking at (SPEC §7)", () => {
  const runtime = siteRuntime();
  const sortable = runtime.match(/const SORTABLE_KEYS = \[[^\]]*\];/)?.[0];
  const defaultKey = runtime.match(/const DEFAULT_SORT_KEY = "[^"]*";/)?.[0];
  expect(sortable, "SORTABLE_KEYS 定義が見つからない").toBeTruthy();
  expect(defaultKey, "DEFAULT_SORT_KEY 定義が見つからない").toBeTruthy();
  // readUrl / writeUrl は正本をそのまま動かす（書き写すと実装とズレる）。
  const script = [
    sortable as string,
    defaultKey as string,
    "let sortKey = DEFAULT_SORT_KEY, sortAsc = true;",
    "const state = { mode: 'deadlines', q: '', kind: '', rank: '', win: 'all', est: false, domestic: false, past: false, cats: [] };",
    "const DATA = { categories: { hpc: {}, systems: {} } };",
    "const KIND_LABEL = { abstract: '概要締切', paper: '論文締切', notification: '採否通知' };",
    runtime.match(/const SELECTABLE_KINDS = \[[^\]]*\];/)?.[0] ?? "",
    jsFunction(runtime, "selectableKind"),
    rankGradeOptionsSource(),
    runtime.match(/const WIN_OPTIONS = \[[^\]]*\];/)?.[0] ?? "",
    "let urlNotices = [];",
    jsFunction(runtime, "urlValueNoticeJa"),
    jsFunction(runtime, "urlFlagJa"),
    "let written = '';",
    "const window = { location: { search: '', pathname: '/index.html' } };",
    "const history = { replaceState: (_s, _t, url) => { written = String(url); } };",
    // writeUrl / readUrl は `<details>` の開閉も読むので、見立てにも同じ形を置く。
    "const helpPanel = { open: false };",
    "const $ = (id) => (id === 'helpPanel' ? helpPanel : null);",
    jsFunction(runtime, "rowShareKeyJa"),
    "let drawerRow = null;",
    "let pendingDrawerKey = '';",
    "state.online = false;",
    jsFunction(runtime, "readUrl"),
    jsFunction(runtime, "writeUrl"),
    // 送信者の画面（国内研究会・締切順・降順）を URL に写出する。
    "state.domestic = true; state.win = '180d'; sortKey = 'date'; sortAsc = false; writeUrl();",
    "const sent = written;",
    // 別の人がその URL を開いたときの復元。
    "window.location.search = sent.slice(1); sortKey = DEFAULT_SORT_KEY; sortAsc = true; readUrl();",
    "const got = [sortKey, sortAsc];",
    // 会期順で共有しても、開いた人の画面で同じ並びになる（新しい鍵も読み書きが対）。
    "state.domestic = false; state.win = 'all'; sortKey = 'event'; sortAsc = true; writeUrl();",
    "const sentEvent = written;",
    "window.location.search = sentEvent.slice(1); sortKey = DEFAULT_SORT_KEY; sortAsc = false; readUrl();",
    "const gotEvent = [sortKey, sortAsc];",
    // 表に出さない種別を URL で受けたら、既定に戻して理由を残す（黙って条件を変えない）。
    "state.kind = 'paper'; urlNotices = []; window.location.search = '?kind=notification'; readUrl();",
    "const droppedKind = [state.kind, urlNotices.join(' ／ ')];",
    // 使えない値を黙って落とさない（送った人の意図した絞り込みが外れた画面を開く）。
    "urlNotices = []; window.location.search = '?rank=B%2B%2B&win=7d%21'; readUrl();",
    "const droppedRankWin = [state.rank, state.win, urlNotices.join(' ／ ')];",
    // 分野は一部だけ未知のときと、全部未知のときで言うことが違う。
    "urlNotices = []; window.location.search = '?cats=hpc,ai%2Dfuture'; readUrl();",
    "const partialCats = [state.cats.join(','), urlNotices.join(' ／ ')];",
    "urlNotices = []; window.location.search = '?cats=ai%2Dfuture'; readUrl();",
    "const allUnknownCats = [state.cats.join(','), urlNotices.join(' ／ ')];",
    // 並び順の鍵が未知なら既定に戻し、それを伝える。
    "urlNotices = []; sortKey = DEFAULT_SORT_KEY; sortAsc = true; window.location.search = '?sort=deadline'; readUrl();",
    "const droppedSort = [sortKey, urlNotices.join(' ／ ')];",
    // 正しい値だけでは何も言わない（毎回注意されると読めない）。
    "urlNotices = []; window.location.search = '?rank=A%2A&win=30d&cats=hpc&sort=event'; readUrl();",
    "const cleanNotices = urlNotices.join(' ／ ');",
    // チェック欄は `1` 以外も読む（人が打った `true` を黙って切り捨てない）。
    "urlNotices = []; state.est = false; state.past = false; window.location.search = '?past=true&est=TRUE'; readUrl();",
    "const trueFlags = [state.past, state.est, urlNotices.join(' ／ ')];",
    // 入りなしも明に書ける（`0` / `false` で注意を出さない）。
    "urlNotices = []; state.past = true; window.location.search = '?past=0&domestic=false'; readUrl();",
    "const offFlags = [state.past, state.domestic, urlNotices.join(' ／ ')];",
    // 読めない値は入りなしにして、画面上の語（ラベルそのもの）で理由を出す。
    "urlNotices = []; state.online = true; window.location.search = '?online=maybe'; readUrl();",
    "const unreadableFlag = [state.online, urlNotices.join(' ／ ')];",
    // 画面のモードも同じ（既定の画面があるので、何を開いたかを書く）。
    "urlNotices = []; window.location.search = '?mode=posts'; readUrl();",
    "const unreadableMode = [state.mode, urlNotices.join(' ／ ')];",
    "urlNotices = []; window.location.search = '?mode=deadlines'; readUrl();",
    "const explicitMode = [state.mode, urlNotices.join(' ／ ')];",
    // てびきを開いた状態も引き継ぐ。閉じた `<details>` の中はブラウザのページ内検索に
    // 出ないので、開いた人一緒の画面をそのまま渡せるようにしたもの。
    "helpPanel.open = true; window.location.search = ''; writeUrl();",
    "const helpSent = written;",
    "helpPanel.open = false; urlNotices = []; window.location.search = helpSent.slice(1); readUrl();",
    "const openedByLink = helpPanel.open;",
    // てびきは画面の条件ではないので、読めない値でも注意を出さない（画面の語が増える）。
    "helpPanel.open = true; urlNotices = []; window.location.search = '?help=maybe'; readUrl();",
    "const helpUnreadable = [helpPanel.open, urlNotices.join(' ／ ')];",
    "const rowRound = [];",
    // 開いていた行の詳細も同じ理屈で引き継ぐ（第 147 回の印刷物の話と同じで、送った人の
    // 画面と送られた人の画面が別物になるのがいちばん親切じゃない）。
    "drawerRow = { conf: { key: 'SC', title: 'SC' }, ed: { year: 2026 }, kind: 'paper', t: 1794883140000 }; writeUrl();",
    "const rowSent = written;",
    "drawerRow = null; pendingDrawerKey = ''; window.location.search = rowSent.slice(1); readUrl();",
    "const rowRestored = [pendingDrawerKey, rowShareKeyJa({ conf: { key: 'SC' }, ed: { year: 2026 }, kind: 'paper', t: 1794883140000 })];",
    // 詳細を閉じて送ると、開いた人の画面でも開かない（幽霊の詳細を残さない）。
    "drawerRow = null; pendingDrawerKey = ''; writeUrl();",
    "const rowClosedSent = written;",
    "rowRound.push(rowSent, rowRestored[0], rowRestored[1], rowClosedSent);",
    "window.location.search = '?rank=A%2A'; readUrl();",
    "const restoredRank = state.rank;",
    // 既定の並びなら引数を足さない（URL は必要な情報だけ乗せる）。
    "sortKey = DEFAULT_SORT_KEY; sortAsc = true; state.domestic = false; writeUrl();",
    "console.log(JSON.stringify([",
    "  sent,",
    "  got,",
    "  written,",
    "  droppedKind,",
    "  restoredRank,",
    "  sentEvent,",
    "  gotEvent,",
    "  droppedRankWin,",
    "  partialCats,",
    "  allUnknownCats,",
    "  droppedSort,",
    "  cleanNotices,",
    "  trueFlags,",
    "  offFlags,",
    "  unreadableFlag,",
    "  unreadableMode,",
    "  explicitMode,",
    "  [helpSent, openedByLink, helpUnreadable[0], helpUnreadable[1]],",
    "  rowRound,",
    "]));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const [
    sent,
    got,
    defaultUrl,
    droppedKind,
    restoredRank,
    sentEvent,
    gotEvent,
    droppedRankWin,
    partialCats,
    allUnknownCats,
    droppedSort,
    cleanNotices,
    trueFlags,
    offFlags,
    unreadableFlag,
    unreadableMode,
    explicitMode,
    helpRound,
    rowRound,
  ] = JSON.parse(proc.stdout.trim()) as [
    string,
    [string, boolean],
    string,
    [string, string],
    string,
    string,
    [string, boolean],
    [string, string, string],
    [string, string],
    [string, string],
    [string, string],
    string,
    [boolean, boolean, string],
    [boolean, boolean, string],
    [boolean, string],
    [string, string],
    [string, string],
    [string, boolean, string, string],
    [string, string, string, string],
  ];
  expect(sent).toContain("sort=date");
  // 会期順の共有も対で動く（既定の向きなので `dir` は付かない）。
  expect(sentEvent).toContain("sort=event");
  expect(sentEvent).not.toContain("dir=");
  expect(gotEvent).toEqual(["event", true]);
  expect(sent).toContain("dir=desc");
  expect(sent).toContain("domestic=1");
  expect(got).toEqual(["date", false]);
  expect(defaultUrl).not.toContain("sort=");
  expect(defaultUrl).not.toContain("dir=");
  // 捨てたことを読み手に伝えず条件だけ変わる、を避ける。
  expect(droppedKind[0]).toBe("");
  expect(droppedKind[1]).toContain("upcoming.html");
  expect(restoredRank).toBe("A*");
  // 使えない値を黙って落とさない。送った人は自分が映っていた画面を信じて共有する。
  expect(droppedRankWin[0], "使えないランクが適用されている").toBe("");
  expect(droppedRankWin[1], "使えない締切までが適用されている").toBe("all");
  expect(droppedRankWin[2]).toContain("リンクのランク「B++」");
  expect(droppedRankWin[2]).toContain("ランクの絞り込みは外れています");
  expect(droppedRankWin[2]).toContain("リンクの締切まで「7d!」");
  expect(droppedRankWin[2]).toContain("締切日は絞っていません");
  // 分野は、一部だけ外れたときと全部外れたときで伝える内容が違う。
  expect(partialCats[0]).toBe("hpc");
  expect(partialCats[1]).toContain("ai-future");
  expect(partialCats[1]).toContain("その部分だけ外しました");
  expect(allUnknownCats[0]).toBe("");
  expect(allUnknownCats[1], "全部の分野が未知のときに、絞れていないことを言っていない").toContain(
    "分野の絞り込みは外れています",
  );
  // 並び順の鍵が未知なら既定に戻し、その旨を出す。
  expect(droppedSort[0]).toBe("rem");
  expect(droppedSort[1]).toContain("リンクの並び順「deadline」");
  expect(droppedSort[1]).toContain("既定の並び順に戻しました");
  // 正しい値だけでは何も言わない（毎回注意されると読めなくなる）。
  expect(cleanNotices).toBe("");
  // てびきが画面を共有する話と案内の文言の形を説明している（実装と案内がズレない形で）。
  const guideHtml = readFileSync(join(site, "index.html"), "utf8");
  expect(guideHtml, "てびきに画面共有の項が無い").toContain("<dt>画面を共有する</dt>");
  expect(guideHtml).toContain("はこの一覧で使えない値なので、");
  // チェック欄とモードも同じ扱いにした（第 130 回の直し方を広げただけなので、
  // 「1 以外を黙って切り捨てる」実装に戻っていないことをここで止める）。
  expect(trueFlags, "true と書いたチェックが効いていない").toEqual([true, true, ""]);
  expect(offFlags, "明示的な解除で注意を出している").toEqual([false, false, ""]);
  expect(unreadableFlag[0], "読めない値でチェックが入っている").toBe(false);
  expect(unreadableFlag[1]).toContain("リンクのオンライン参加可のみ「maybe」");
  expect(unreadableFlag[1]).toContain("チェックは入りませんでした");
  expect(unreadableMode[0], "読めないモードで推薦画面を開いている").toBe("deadlines");
  expect(unreadableMode[1]).toContain("リンクのモード「posts」");
  expect(unreadableMode[1]).toContain("締切の一覧を開きました");
  expect(explicitMode).toEqual(["deadlines", ""]);
  /* てびきを開いた状態も URL で引き継ぐ。閉じた `<details>` の中はブラウザのページ内検索に
   * 出ないので、開いた人一緒の画面をそのまま渡せるようにしたもの（SPEC §7）。 */
  expect(helpRound[0], "てびきを開いている状態が URL に残っていない").toContain("help=1");
  expect(helpRound[1], "リンクを開いた人の画面でてびきが開かない").toBe(true);
  // てびきは画面の絞り込みではないので、読めない値でも注意を出さない。
  // 開いていた行の詳細も対で引き継がれ、閉じて送れば開かない。
  expect(rowRound[0], "開いていた行の詳細が URL に残っていない").toContain(
    "row=SC%7C2026%7Cpaper%7C",
  );
  expect(rowRound[1], "送られた側で行の鍵が復元されていない").toBe(rowRound[2]);
  expect(rowRound[1]).toBe("SC|2026|paper|1794883140000");
  expect(rowRound[3], "詳細を閉じて送ったのに行の引数が残っている").not.toContain("row=");
  expect(helpRound[2]).toBe(false);
  expect(helpRound[3], "てびきの値で件数欄に注意が並んでいる").toBe("");
  // 知らない key は既定に戻る（URL を叩いて並べ替え式を壊せないようにする）。
  const bogus = spawnSync("node", ["-e", script.replace("sent.slice(1)", '"sort=bogus&dir=up"')], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(bogus.status, bogus.stderr).toBe(0);
  expect((JSON.parse(bogus.stdout.trim()) as [string, [string, boolean], string])[1]).toEqual([
    "rem",
    true,
  ]);
});

it("venues without a prefecture are findable by prefecture (SPEC §7)", () => {
  const build = readFileSync(new URL("../src/build.ts", import.meta.url), "utf8");
  const runtime = siteRuntime("recommender.js");
  // 土地で絞る入口はサイトと同じ語を使う（md 側で都道府県表を二重実装しない）。
  expect(build).toContain("Recommender.placeWithPrefectureJa(ed.place)");
  // 公式表記を書き換えないので、補うのは末尾に空白区切りで添える形だけ。
  // 生成 JS の補間式そのものを見て、ビルド側が同じ語を呼んでいることを確認する。
  // biome-ignore lint/suspicious/noTemplateCurlyInString: コンパイル後の JS 断片をそのまま照合するため ${...} を文字列として持つ
  expect(runtime).toContain("${placePrefectureJa(ed.place)}");
  // 参照する定数と関数は正本をそのまま注入する（書き写すと正本とズレる）。
  const citySrc = runtime.match(/const CITY_PREFECTURE_JA[\s\S]*?\];/)?.[0];
  expect(citySrc, "CITY_PREFECTURE_JA 定義が見つからない").toBeTruthy();
  const officialSrc = runtime.match(/const PREFECTURE_OFFICIAL_JA[\s\S]*?\};/)?.[0];
  expect(officialSrc, "PREFECTURE_OFFICIAL_JA 定義が見つからない").toBeTruthy();
  const [bare, withPref] = new Function(
    [
      citySrc as string,
      officialSrc as string,
      jsFunction(runtime, "prefectureOfficialJa"),
      jsFunction(runtime, "placePrefectures"),
      jsFunction(runtime, "placePrefectureJa"),
      jsFunction(runtime, "placeWithPrefectureJa"),
      "return [placePrefectureJa, placeWithPrefectureJa];",
    ].join("\n"),
  )() as [(v: unknown) => string, (v: unknown) => string];
  expect(bare("倉敷市芸文館")).toBe("岡山 岡山県");
  expect(withPref("倉敷市芸文館")).toBe("倉敷市芸文館 岡山県");
  expect(withPref("飛騨・世界生活文化センター（岐阜県高山市）")).toBe(
    "飛騨・世界生活文化センター（岐阜県高山市）",
  );
  expect(bare("未定")).toBe("");
  // 「県」を一律に足すと実在しない地名ができる。都・道・府は正式名で出す。
  expect(withPref("札幌市教育文化会館")).toBe("札幌市教育文化会館 北海道");
  expect(bare("東京（ハイブリッド）")).toBe("東京 東京都");
  expect(bare("大阪")).toBe("大阪 大阪府");
  expect(bare("京都大学 楽友会館")).toBe("京都 京都府");
  // 正式名がそのまま都道府県名ものの語は繰り返さない。
  expect(bare("札幌市教育文化会館")).toBe("北海道");
  // 複数の都道府県に読める表記では補わない（間違った土地を載せるほうが悪い）。
  expect(withPref("東京都市大学")).toBe("東京都市大学");
});

it("relative months in the query are resolved and shown (SPEC §7)", () => {
  const runtime = siteRuntime();
  const template = readFileSync(join(site, "index.html"), "utf8");
  // 展開式は recommender に一本化し、UI は展開後の語で絞り込む。
  expect(runtime).toContain("searchQuery = Recommender.expandRelativeMonths(state.q, now);");
  // 照合式は recommender 側（`searchMatcher`）に置く。語の分解を行ごとにやり直すと、
  // 行の数だけ遅くなる（3234 行で 1 打鍵あたり約 83 ms 実測）。
  expect(runtime).toContain("Recommender.searchMatcher(searchQuery)");
  expect(runtime).toContain("matchesQuery(r.hay)");
  expect(runtime).not.toContain("Recommender.hayMatches(r.hay, searchQuery)");
  // てびきに相対月の説明がある（仕様が画面から追える状態にする）。
  expect(template).toContain("「今月」「来月」「再来月」「先月」");
  // 「来月」がどの月に解決されたかをその場で見せる（伏せた展開は誤信を生む）。
  /* 件数欄の文言は本物の `relativeMonthNote` が作る（展開前後の番号対応は助詞でずれるので
   * 解決の内側でできた組を見る – 第 251 回）。 */
  const note = new Function("Recommender", `return (${jsFunction(runtime, "relativeMonthNote")});`)(
    Recommender as unknown as Record<string, unknown>,
  ) as (query: string, now: number) => string;
  const noteAt = (query: string) => note(query, Date.parse("2026-09-15T00:00:00Z"));
  expect(noteAt("来月")).toBe(" ｜ 来月 = 2026年10月");
  expect(noteAt("来月 国内")).toBe(" ｜ 来月 = 2026年10月");
  expect(noteAt("来月の締切"), "助詞で繋がれた形が説明に出ていない").toBe(" ｜ 来月 = 2026年10月");
  expect(noteAt("来月中の締切")).toBe(" ｜ 来月中 = 2026年10月");
  expect(noteAt("来月 再来月")).toBe(" ｜ 来月 = 2026年10月、再来月 = 2026年11月");
  expect(noteAt("機械学習")).toBe("");
  expect(noteAt("セキュリティの会議")).toBe("");
});

it("the empty deadline state offers a one-click way to drop the filters (SPEC §7)", () => {
  const template = readFileSync(join(site, "index.html"), "utf8");
  const runtime = siteRuntime();
  // 文章で条件を名指しするだけでは足りないので、まとめて外すボタンを同じ場所に出す。
  expect(template).toContain('id="emptyText"');
  expect(template).toContain('<button id="emptyReset" type="button" hidden>');
  // 説明文は要素を消さないよう専用の span へ書く（textContent だと子要素が消える）。
  expect(runtime).toContain('$("emptyText").textContent = emptyDeadlineHint(');
  expect(runtime).toContain('$("emptyReset").hidden = !filtersClearable(filter);');
  // 一覧の意味を変える「過去の締切も表示」は利用者の選択として残す。
  const clear = { window: "all", cats: 0, domestic: false, rank: "", kind: "", query: "" };
  const isClearable = new Function(`return (${jsFunction(runtime, "filtersClearable")});`)() as (
    f: typeof clear,
  ) => boolean;
  expect(isClearable(clear)).toBe(false);
  expect(isClearable({ ...clear, query: "機械学" })).toBe(true);
  expect(isClearable({ ...clear, window: "7d" })).toBe(true);
  expect(isClearable({ ...clear, domestic: true })).toBe(true);
  expect(isClearable({ ...clear, rank: "A*", cats: 2 })).toBe(true);
  /* 種別だけ掛けた状態で 0 件になった人に「外せる条件はありません」と打ち止めさせない
   * （`音声` + 概要締切で 0 件、検索語だけなら 1 件、は実データで実際に起こる）。 */
  expect(isClearable({ ...clear, kind: "abstract" })).toBe(true);
});

it("the deadline table is usable on paper and with a Japanese IME (SPEC §7)", () => {
  const template = readFileSync(join(site, "index.html"), "utf8");
  const runtime = siteRuntime();
  // 印刷: 画面用の操作要素を落とし、紙で押せないリンクは URL を印字する。
  const print = template.slice(template.indexOf("@media print"));
  expect(print).toContain("@media print {");
  for (const hide of ["#controlsPanel", "#helpPanel", "#exportCsv", "#more", "#drawer"]) {
    expect(print, `印刷時に ${hide} を消さない`).toContain(`${hide},`);
  }
  expect(print).toContain('content: " (" attr(href) ")"');
  // 幅せまカード表示のメディアクエリが印刷幅でも当たるため、表として印刷させる。
  expect(print).toContain("thead { display: table-header-group; }");
  // 行がページのまたぎで分断されると「どの締切か」わからなくなる。
  expect(print).toContain("break-inside: avoid");
  // 印刷物だけ直近 40 件で打ち切られないよう、印刷前に全行を描画して印刷後に戻す。
  expect(runtime).toContain('window.addEventListener("beforeprint"');
  expect(runtime).toContain('window.addEventListener("afterprint"');
  /* 日本語 IME: 未確定のひらがなで絞り込み直さず、変換確定後に一度だけ適用する。
   * 経路は `wireDebouncedInput` に集約した（論文入力の要旨・タイトルも日本語で打つので、
   * 検索欄だけ守っても使う人は同じもたつきを踏む）。聞き手自体を張っている箇所は
   * ヘルパー内の 1 箇所だけであることを、下の IME 検査で実際に動かして確認する。 */
  expect(runtime).toContain('element.addEventListener("compositionstart"');
  expect(runtime).toContain('element.addEventListener("compositionend"');
  expect(runtime).toContain('wireDebouncedInput(valueElement("q")');
  // ビルド成果物では `if (composing)` と `return;` が改行で分かれるため、条件だけ見る。
  expect(runtime).toMatch(/if \(composing\)\s*\n?\s*return;/);
});

it("index.html tells Japanese readers what the site is before they open it (SPEC §7)", () => {
  const template = readFileSync(join(site, "index.html"), "utf8");
  // 検索結果とチャットのリンクプレビューに効くのは description / og まで。
  expect(template).toContain('<html lang="ja">');
  const description = template.match(/<meta name="description" content="([^"]+)">/)?.[1] ?? "";
  expect(description.length).toBeGreaterThan(60);
  // 「何時まで？」が日本語で伝わることを説明に含める（JST と曜日を主にする主旨）。
  expect(description).toContain("JST");
  expect(description).toContain("国内研究会");
  for (const prop of ["og:type", "og:site_name", "og:locale", "og:title", "og:description"]) {
    expect(template, `${prop} が無い`).toContain(`<meta property="${prop}"`);
  }
  expect(template).toContain('<meta property="og:locale" content="ja_JP">');
  // SVG の og:image はチャット側でプレビューに使えないので置かない（説明文中の語ではなく tag を見る）。
  expect(template).not.toMatch(/<meta[^>]+property="og:image"/);
  // canonical と og:url は config.yaml の site.base_url と同じ所在を指す（ズレ防止）。
  const config = loadYaml(readFileSync(join(REPO_ROOT, "config.yaml"), "utf8")) as {
    site: { base_url: string };
  };
  const base = config.site.base_url.replace(/\/+$/, "");
  expect(template).toContain(`<link rel="canonical" href="${base}/">`);
  expect(template).toContain(`<meta property="og:url" content="${base}/">`);
  // ファビコンは自前 SVG（外部アセットを読み込まない）。
  expect(template).toContain('<link rel="icon" type="image/svg+xml" href="icon.svg">');
  expect(existsSync(join(site, "icon.svg"))).toBe(true);
  const icon = readFileSync(join(site, "icon.svg"), "utf8");
  expect(icon).toContain("<svg");
  // アイコンに文字を入れると日本語フォントの無い環境で文字化けしうるので図形で描く。
  expect(icon).not.toMatch(/<text|<textPath/);
});

it("filtered rows can be exported to a spreadsheet as BOM-prefixed CSV (SPEC §7)", () => {
  const template = readFileSync(join(site, "index.html"), "utf8");
  const runtime = siteRuntime();
  // 書き出し本文は recommender の単一正典を通す（一覧の表示式とズレないようにする）。
  expect(runtime).toContain("Recommender.deadlinesToCsv(");
  // Excel は BOM の無い UTF-8 を日本語として読めない。
  // BOM 付きで渡していること（書き方が変わっても BOM 文字 + csv の組合せを見る）。
  expect(runtime).toContain("`\\ufeff${csv}`");
  // 推薦モードでは出さず、締切一覧の絞り込み件数ラベルをそのまま使う。
  expect(runtime).toContain("exportBtn.hidden = recMode || !shown.length;");
  expect(runtime).toContain("件を CSV でダウンロード");
  // 行はクリックで開いたまま、ボタン行は表のヘッダー選択対象にしない。
  expect(template).toContain('id="exportCsv"');
});

it("upcoming.md lists meetings as well as deadlines", () => {
  const rows = upcomingRows(site);
  const kinds = new Set(rows.map((r) => r[3]));
  expect(kinds.has("開催")).toBe(true);
  const names = rows
    .filter((r) => r[3] === "開催")
    .map((r) => r[2])
    .join(" ");
  for (const title of [
    "HOTI 2026",
    "SC 2026",
    "情報処理学会 HPC 研究会 2026",
    "P4 Workshop 2026",
    "LPC 2026",
  ]) {
    expect(names).toContain(title);
  }
});

it("upcoming.md keeps a running meeting and drops a finished one", async () => {
  const meeting = (key: string, start: Date, end: Date) =>
    makeConference({
      key,
      title: key.toUpperCase(),
      categories: ["hpc"],
      sources: ["local"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: `${key}26`,
          source: "local",
          event_start: start,
          event_end: end,
        }),
      ],
    });
  const confs = [
    meeting("running", utc(2026, 8, 7), utc(2026, 8, 11)),
    meeting("lastday", utc(2026, 8, 5), utc(2026, 8, 9)),
    meeting("finished", utc(2026, 8, 1), utc(2026, 8, 8)),
    meeting("future", utc(2026, 8, 19), utc(2026, 8, 21)),
  ];
  const outdir = mkdtempSync(join(tmpdir(), "cfp-mtg-"));
  await buildAll(confs, { categories: { hpc: "HPC" } }, outdir, NOW, { noEmbeddings: true });
  // 回帰ガード: noEmbeddings が第5引数で効いていれば埋め込みは生成されない
  expect(existsSync(join(outdir, "embeddings.json"))).toBe(false);
  const text = readFileSync(join(outdir, "upcoming.md"), "utf8");
  expect(text).toContain("開催中(残り3日)");
  expect(text).not.toContain("| 本日開催 |");
  expect(text).toContain("開催中(残り1日)");
  expect(text).not.toContain("FINISHED");
  expect(text).toContain("| 10日 |");
});

it("browser date-only state is independent of the viewer timezone", () => {
  const app = siteRuntime();
  const script = [
    // buildRows is a typed runtime delegation; its dependency is supplied
    // explicitly here so this evaluates the emitted app module, not removed
    // site/app.js source text.
    "const Recommender = { candidateRows: (data) => { const dl = data.conferences[0].editions[0].deadlines[0]; return [{ dateOnly: true, localDate: dl.local_date, t: Date.parse(dl.earliest_utc), tLast: Date.parse(dl.latest_utc) }]; } };",
    jsFunction(app, "buildRows"),
    // `rowIsPast` は recommender.js の判定に寄った（第 225 回）ので、雛形の Recommender に
    // その正本を足す – 規則をテスト側に書き写さない。
    "Recommender.deadlineRowIsPast = " +
      jsFunction(siteRuntime("recommender.js"), "deadlineRowIsPast") +
      ";",
    jsFunction(app, "rowDateOnlyState"),
    jsFunction(app, "rowIsPast"),
    "const data = { conferences: [{ key: 'x', title: 'X', editions: [{ year: 2026, deadlines: [{ kind: 'paper', precision: 'date-only', local_date: '2026-08-24', earliest_utc: '2026-08-23T10:00:00.000Z', latest_utc: '2026-08-25T11:59:59.999Z' }] }] }] };",
    "const row = buildRows(data)[0];",
    "const times = ['2026-08-23T09:59:59.999Z', '2026-08-23T10:00:00.000Z', '2026-08-25T11:59:59.999Z', '2026-08-25T12:00:00.000Z'].map(Date.parse);",
    "console.log(JSON.stringify(times.map((now) => [rowDateOnlyState(row, now), rowIsPast(row, now)])));",
  ].join("\n");
  const outputs = ["Asia/Tokyo", "UTC", "America/Los_Angeles"].map((TZ) => {
    const proc = spawnSync("node", ["-e", script], {
      encoding: "utf8",
      env: { ...process.env, TZ },
      timeout: 60_000,
    });
    expect(proc.status, proc.stderr).toBe(0);
    return JSON.parse(proc.stdout);
  });
  const expected = [
    ["definitely-future", false],
    ["uncertain-on-date", false],
    ["uncertain-on-date", false],
    ["definitely-past", true],
  ];
  expect(outputs).toEqual([expected, expected, expected]);
});

it("site runtime never emits the invalid let() CSS function (#223 follow-up)", () => {
  // site/app.ts が組み立てる inline style を `let(--chip)` にすると、CSS として
  // 不正な関数ごと宣言が破棄される。詳細ドロワーの「公式サイトを開く」は
  // `color: #fff` と組み合わさり、白抜きの追跡不能なボタンになった（実障害）。
  const runtimeFiles = [
    "app.js",
    "recommender.js",
    "recommendation-core.js",
    "publish.js",
  ] as const;
  for (const name of runtimeFiles) {
    expect(siteRuntime(name), `${name} に let(-- を検出`).not.toContain("let(--");
    expect(siteRuntime(name)).not.toMatch(/style="[^"]*\blet\(/);
  }
});

it("drawer shows JST with weekday and the official timezone, viewer-timezone independent (SPEC §7)", () => {
  // 2026-02-06 23:59 AoE = 2026-02-07T11:59:00Z = JST 2026-02-07(土) 20:59。
  // AoE 締切は JST では翌日の夜になるため、JST を主表記にしないと
  // 日本の利用者がいつ提出すべきか判定できない。
  const runtime = siteRuntime();
  const weekdayConst = runtime.match(/const WEEKDAY_JA = \[[^\]]*\];/)?.[0];
  expect(weekdayConst, "WEEKDAY_JA 定義が見つからない").toBeTruthy();
  // ドロワーは「今後の会期」も組むので、依存も正本から注入する（書き写さない）。
  // 会期の書き方は recommender.js の正本へ移した（索引と同じ 1 本。第 220 回）。
  const recSrc = siteRuntime("recommender.js");
  const drawerDepsSrc = [
    jsFunction(recSrc, "meetingRangeJa"),
    jsFunction(recSrc, "upcomingEditionsOf"),
    jsFunction(recSrc, "laterEditionLineJa"),
  ].join("\n");
  const openSrc = jsFunction(runtime, "openDrawer");
  const script = [
    weekdayConst as string,
    jsFunction(runtime, "pad"),
    jsFunction(runtime, "fmtDate"),
    jsFunction(runtime, "fmtJst"),
    jsFunction(runtime, "fmtAoE"),
    drawerDepsSrc as string,
    // 公式表記の判定は recommender.js の正本をそのまま注入する（規則の書き写しは
    // 正本とズレるため避ける）。officialZone の依存は isRecord のみ。
    jsFunction(siteRuntime("recommender.js"), "isRecord"),
    // 暦日の曜日も recommender.js の正本を注入する（TZ でズレないことの確認を兼ねる）。
    siteRuntime("recommender.js").match(/const CALENDAR_DATE_JA = \[[^\]]*\];/)?.[0] ?? "",
    jsFunction(siteRuntime("recommender.js"), "weekdayJaFromDate"),
    // 会期の式も正本を注入する（一覧・行の詳細・CSV が同じ式を使う。書き写さない）。
    jsFunction(siteRuntime("recommender.js"), "eventCellJa"),
    `const Recommender = { officialZone: ${jsFunction(siteRuntime("recommender.js"), "officialZone")}, placeJa: (v) => String(v ?? ""), topicTagsJa: () => [], weekdayJaFromDate: weekdayJaFromDate, eventCellJa: eventCellJa, meetingRangeJa: meetingRangeJa, upcomingEditionsOf: upcomingEditionsOf, laterEditionLineJa: laterEditionLineJa };`,
    "const body = { innerHTML: '' };",
    "const els = {",
    "  drawerBackdrop: { classList: { add() {} } }, drawerTitle: {}, drawerFullName: {},",
    "  drawerBody: body, drawerClose: { focus() {} },",
    "};",
    "const document = { activeElement: null, getElementById: (id) => els[id] || null };",
    "function $(id) { return document.getElementById(id); }",
    "const window = { _prevFocus: null };",
    // 「未確認」の語は正本（recommender.js の `UNCONFIRMED_LABEL_JA`）から取る。
    (siteRuntime("recommender.js").match(/const UNCONFIRMED_LABEL_JA = [^\n]*;/) || [""])[0],
    "const UNCONFIRMED_JA = UNCONFIRMED_LABEL_JA;",
    `const openDrawer = new Function('window', 'document', '$', 'KIND_LABEL', 'titleWithYear', 'fmtDate', 'fmtJst', 'fmtAoE', 'esc', 'safeExternalUrl', 'rowDateOnlyState', 'verificationSummary', 'Recommender', 'meetingRangeJa', 'upcomingEditionsOf', 'kindDetailJa', 'writeUrl', 'UNCONFIRMED_JA', 'fieldReasonsJa', 'return (' + ${JSON.stringify(openSrc)} + ')')(window, document, $, { paper: '論文締切' }, (t) => t, fmtDate, fmtJst, fmtAoE, (s) => String(s ?? ''), (v) => String(v ?? ''), () => null, () => '', Recommender, meetingRangeJa, upcomingEditionsOf, (${jsFunction(runtime, "kindDetailJa")}), () => {}, UNCONFIRMED_JA, { event: () => '', place: () => '', rank: () => '', note: (t) => (t ? '<i>' + t + '</i>' : '') });`,
    "const draw = (tzRaw) => {",
    "  body.innerHTML = '';",
    "  openDrawer({",
    "    kind: 'paper', conf: { key: 'demo', title: 'Demo' },",
    "    ed: { year: 2026, place: 'P', date_text: 'D', link: 'https://example.org' },",
    "    t: Date.parse('2026-02-07T11:59:00Z'), tLast: Date.parse('2026-02-07T11:59:00Z'),",
    "    dl: tzRaw === null ? {} : { tz_raw: tzRaw },",
    "  });",
    "  return body.innerHTML;",
    "};",
    "const drawDateOnly = () => {",
    "  body.innerHTML = '';",
    "  openDrawer({",
    "    kind: 'paper', dateOnly: true, localDate: '2026-09-30',",
    "    conf: { key: 'demo', title: 'Demo' },",
    "    ed: { year: 2026, place: 'P', date_text: 'D', link: 'https://example.org' },",
    "    t: Date.parse('2026-09-29T10:00:00.000Z'), tLast: Date.parse('2026-10-01T11:59:59.999Z'),",
    "    dl: { precision: 'date-only', local_date: '2026-09-30' },",
    "  });",
    "  return body.innerHTML;",
    "};",
    "console.log(JSON.stringify([draw('AoE'), draw('UTC+9'), draw('UTC'), draw(null), drawDateOnly()]));",
  ].join("\n");
  const outputs = ["Asia/Tokyo", "UTC", "America/Los_Angeles"].map((TZ) => {
    const proc = spawnSync("node", ["-e", script], {
      encoding: "utf8",
      env: { ...process.env, TZ },
      timeout: 60_000,
    });
    expect(proc.status, proc.stderr).toBe(0);
    return JSON.parse(proc.stdout) as string[];
  });
  expect(outputs[1]).toEqual(outputs[0]);
  expect(outputs[2]).toEqual(outputs[0]);
  const [aoeRow, jstRow, utcRow, rawRow, dateOnlyRow] = outputs[0];
  // 時刻未確認（date-only）の行も曜日を添える（動作計画は曜日で見込むため）。
  expect(dateOnlyRow).toContain("2026-09-30(水)");
  // JST が主表記で曜日を伴う。
  expect(aoeRow).toContain("2026-02-07(土) 20:59 JST");
  expect(jstRow).toContain("2026-02-07(土) 20:59 JST");
  // AoE 締切は公式表記として AoE を併記（JST の直後、UTC を挟まない）。
  expect(aoeRow).toContain("公式 2026-02-06 23:59 AoE");
  expect(aoeRow.indexOf("JST")).toBeLessThan(aoeRow.indexOf("AoE"));
  // JST 宣言の締切（国内研究会など）に AoE は出さない。
  expect(jstRow).toContain("公式 JST 締切");
  expect(jstRow).not.toContain("AoE");
  // 公式が UTC / 表記なしは UTC を添える。
  expect(utcRow).toContain("2026-02-07 11:59 UTC");
  expect(rawRow).toContain("2026-02-07 11:59 UTC");
  // inline style は var() で CSS 変数を読む。
  expect(aoeRow).toContain("background: var(--chip)");
  expect(aoeRow).toContain("background: var(--accent)");
});

it("table row leads with JST and guards AoE behind the official zone (SPEC §7)", () => {
  const runtime = siteRuntime();
  const template = readFileSync(join(site, "index.html"), "utf8");
  const makeRow = jsFunction(runtime, "makeRow");
  // 日時列の最上段は JST。UTC などは公式表記の注記として後に続く。
  expect(makeRow.indexOf('line(c1, fmtJst(d), "nowrap")')).toBeLessThan(
    makeRow.indexOf("line(c1, sub,"),
  );
  // AoE は公式表記が AoE のときだけ併記する（JST 宣言の国内締切に出さない）。
  expect(makeRow).toContain('if (zone === "JST")');
  expect(makeRow.indexOf('else if (zone === "AoE")')).toBeLessThan(makeRow.indexOf("fmtAoE(d)"));
  // 列名（カード表示の列名含む）で JST であることを明示する。
  expect(makeRow).toContain('td(tr, "日時（JST）")');
  expect(template).toContain("日時（JST）");
});

it("site UI is readable for Japanese researchers: field names, JST header, help panel (SPEC §7)", () => {
  const template = readFileSync(join(site, "index.html"), "utf8");
  const runtime = siteRuntime();
  // 分野は日本語名（英表記は data.json の正本を維持したまま併記だけ出す）。
  expect(runtime).toContain("Recommender.categoryLabelJa(key)");
  expect(runtime).not.toContain("key.toUpperCase()");
  // 日時列は JST であることをヘッダーで示す。
  expect(template).toContain("日時（JST）");
  // 初回利用者が用語で詰まらないよう、てびきを一覧の下に置く（既定は折り畳み）。
  expect(template).toContain("見方のてびき");
  expect(template).toContain("Anywhere on Earth");
  expect(template).toContain('id="helpPanel"');
  expect(runtime).toContain('$("helpPanel").hidden = recommend');
  // 検索で分野名・国内が引けることを案内する。
  expect(template).toContain("会議名・分野・開催地で検索");
  // スマホではキーボード案内を出さず、タップで詳細が見られることだけ伝える。
  expect(template).toContain("行を選ぶと詳細");
  expect(template).toMatch(/\.count-kbd \{ display: none; \}/);
  // 開催地は国名・開催形式を日本語に寄せ、原文（会場名・市区郡）は title と詳細に残す。
  expect(runtime).toContain("Recommender.placeJa(r.ed.place)");
  expect(runtime).toContain("placeCell.title = String(r.ed.place");
  expect(runtime).toContain("原表記: ");
  // 月見出し行は選択・詳細・キーボード移動の対象にしない（shown[] とのズレ防止）。
  expect(runtime).toContain('classList.contains("month-row")');
  expect(template).toContain(".month-row th");
  // 検索照合は recommender の正規化判定に一元化する（全角入力・複数語対応のため、
  // 一覧側で r.hay.indexOf(q) を直呼びしない。`来月` の展開も recommender 側で行う）。
  // 照合式は recommender 側（`searchMatcher`）に置く。語の分解を行ごとにやり直すと、
  // 行の数だけ遅くなる（3234 行で 1 打鍵あたり約 83 ms 実測）。
  expect(runtime).toContain("Recommender.searchMatcher(searchQuery)");
  expect(runtime).toContain("matchesQuery(r.hay)");
  expect(runtime).not.toContain("Recommender.hayMatches(r.hay, searchQuery)");
  // 主題タグ（tags）も日本語で詳細に出す（会議名から場を推定させないため）。
  expect(runtime).toContain("Recommender.topicTagsJa(r.conf.tags)");
  expect(runtime).toContain("<strong>主題:</strong>");
  expect(runtime).not.toContain("r.hay.indexOf(");
});

it("month headings appear only while browsing in chronological order (SPEC §7)", () => {
  const runtime = siteRuntime();
  const script = [
    `const countJa = (${jsFunction(runtime, "countJa")});`,
    "function pad(n) { return (n < 10 ? '0' : '') + n; }",
    jsFunction(runtime, "shouldGroupMonths"),
    jsFunction(runtime, "monthKey"),
    jsFunction(runtime, "monthHeading"),
    // JST 2026-10-01 09:00 と JST 2026-09-30 23:30 は UTC では同じ 9/30 だが、JST では別月。
    "const a = { kind: 'paper', t: Date.parse('2026-10-01T00:00:00Z') };",
    "const b = { kind: 'paper', t: Date.parse('2026-09-30T14:30:00Z') };",
    "const j = { kind: 'journal', t: Date.parse('2026-09-30T14:30:00Z') };",
    "const nan = { kind: 'paper', t: NaN };",
    "console.log(JSON.stringify({",
    "  groups: [",
    "    shouldGroupMonths({ sortKey: 'rem', sortAsc: true, paper: false }),",
    "    shouldGroupMonths({ sortKey: 'date', sortAsc: true, paper: false }),",
    "    shouldGroupMonths({ sortKey: 'date', sortAsc: false, paper: false }),",
    "    shouldGroupMonths({ sortKey: 'rank', sortAsc: true, paper: false }),",
    "    shouldGroupMonths({ sortKey: 'conf', sortAsc: true, paper: false }),",
    "    shouldGroupMonths({ sortKey: 'rem', sortAsc: true, paper: true }),",
    "  ],",
    "  keys: [monthKey(a), monthKey(b), monthKey(j), monthKey(nan)],",
    "  heading: monthHeading(monthKey(a), 7),",
    "}));",
  ].join("\n");
  const outputs = ["Asia/Tokyo", "UTC", "America/Los_Angeles"].map((TZ) => {
    const proc = spawnSync("node", ["-e", script], {
      encoding: "utf8",
      env: { ...process.env, TZ },
      timeout: 60_000,
    });
    expect(proc.status, proc.stderr).toBe(0);
    return JSON.parse(proc.stdout);
  });
  expect(outputs[1]).toEqual(outputs[0]);
  expect(outputs[2]).toEqual(outputs[0]);
  const got = outputs[0] as { groups: boolean[]; keys: string[]; heading: string };
  // 日時順（昇順）のときだけ区切る。逆順・ランク順・会議名順・推薦順では区切らない。
  expect(got.groups).toEqual([true, true, false, false, false, false]);
  // 月は JST で決める（表示が JST なので単位をずらさない）。
  expect(got.keys).toEqual(["2026-10", "2026-09", "", ""]);
  // 見出しは「何の月」かを書く（第 231 回。会期列と読み違えるため）。
  expect(got.heading).toBe("締切 2026年10月（7 件）");
});

it("recommendation data arrival re-schedules semantic for pending paper text", () => {
  // 再現バグ: 埋め込み到着前に scheduleSemantic が走ると error で固着し、
  // データが揃っても再計算されず「意味検索は利用不可」が出続ける。
  const app = siteRuntime();
  const script = (paperText: string, withEmbeddings: boolean) =>
    [
      "let recommendationData = null, recommendationPromise = null, recommendationError = false;",
      "let EMBEDDINGS = null, semanticReason = null;",
      "const DATA = {};",
      "const calls = [];",
      `const loadPublishedRecommendation = () => Promise.resolve({ index: { conferences: [] }, embeddings: ${withEmbeddings ? "{ ok: true }" : "null"}, state: { semantic: ${withEmbeddings}, reason: null } });`,
      "const catalogFrom = (value) => value;",
      "const embeddingBundle = (value) => value;",
      "const clearSemantic = (state) => calls.push('clear:' + state);",
      `const currentPaperText = () => ${JSON.stringify(paperText)};`,
      "const scheduleSemantic = () => calls.push('schedule');",
      "const setRecommendationProfile = () => {};",
      "const render = () => {};",
      jsFunction(app, "loadRecommendationData"),
      "loadRecommendationData();",
      "recommendationPromise.then(() => console.log(JSON.stringify(calls)));",
    ].join("\n");
  const run = (paperText: string, withEmbeddings: boolean) => {
    const proc = spawnSync("node", ["-e", script(paperText, withEmbeddings)], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(proc.status, proc.stderr).toBe(0);
    return JSON.parse(proc.stdout);
  };
  // 入力済みテキスト + 埋め込み到着 → 再スケジュールされる
  expect(run("TSN scheduling paper", true)).toEqual(["schedule"]);
  // テキスト未入力 → 再スケジュールしない
  expect(run("", true)).toEqual([]);
  // 埋め込み不可 → error のまま (再スケジュールで隠さない)
  expect(run("TSN scheduling paper", false)).toEqual(["clear:error"]);
});

it("default filter shows only submission deadlines", () => {
  const html = siteHtmlRuntime();
  const filterSrc = jsFunction(html, "filter");
  const script = [
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    // filter() は実時刻 (Date.now()) と行の t を比較するため、凍結した now を
    // 返す FakeDate を注入する。実時刻に依存させると実行日が進んだだけで
    // 行が全て「過去」になり [] に化ける。
    "class FakeDate extends Date { static now() { return now; } }",
    "function row(kind) {",
    "  return {",
    "    kind: kind, est: false, cats: ['hpc'], rankPairs: [], hay: 'x',",
    "    t: now + 86400000, tLast: now + 2 * 86400000, ed: { deadlines: [] }, conf: { key: kind }",
    "  };",
    "}",
    'const rows = ["paper", "abstract", "event", "notification", "camera_ready"].map(row);',
    'const state = { q: "", cats: [], kind: "", rank: "", win: "all", est: false };',
    FILTER_RUNTIME_STUBS,
    'const filter = new Function("Date", "DAY", "rows", "state", "sortAsc", "sortKey",',
    '                            "return (" + FILTER + ")")(FakeDate, DAY, rows, state, false, "time");',
    "console.log(JSON.stringify(filter().map(r => r.kind)));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  expect(JSON.parse(proc.stdout)).toEqual(["paper", "abstract"]);
});

it("recommendation filter ignores deadline-only state", () => {
  const html = siteHtmlRuntime();
  const filterSrc = jsFunction(html, "filter");
  const script = [
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    "const paper = { value: '' };",
    "const document = {};",
    "function $(id) { return id === 'paperText' ? paper : null; }",
    "const window = {};",
    "function row(hay, t, rank, cats, tags) {",
    "  return { kind: 'paper', est: false, cats, rankPairs: [rank], hay, tags, t, tLast: t, ed: { deadlines: [] }, conf: { key: hay } };",
    "}",
    "const rows = [",
    "  row('topic', now + 86400000, 'A', ['hpc'], ['domestic-jp']),",
    "  row('other', now + 30 * 86400000, 'B', ['systems'], []),",
    "];",
    "const state = { mode: 'deadlines', q: 'topic', cats: ['hpc'], kind: 'paper', rank: 'A', win: '1', est: false, domestic: true, past: false };",
    FILTER_RUNTIME_STUBS,
    "const filter = new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "  'return (' + FILTER + ')')(FakeDate, DAY, rows, state, true, 'rem');",
    "const deadline = filter().length;",
    "state.mode = 'recommend';",
    "paper.value = 'topic';",
    "const recommend = filter().length;",
    "console.log(deadline + '|' + recommend);",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  expect(proc.stdout.trim()).toBe("1|2");
});

it("列見出しは並び替えの目印（aria-sort と語尾の矢印）を持つ（キーで押せることは別の検査で見る・SPEC §7）", () => {
  const html = siteHtmlRuntime();
  // ここでは目印だけを見る。以前はタイトルで「キーボードで操作できる」と言いながら
  // キーを押す検査をしていなかった（実装は張れているので不具合ではなかったが、検査が
  // 画面の挙動を語った形になっていた）。キー操作は
  // 「見出しの並び替えは Enter・Space で効き、行用の Enter と衝突しない」で実際に押す。
  // 静的検証: ソート可能な各ヘッダーに tabindex / aria-sort / data-sort がある
  // （第 126 回で「会期」が増えたので、個数の書写ではなく実装の鍵から数える）。
  const ths = [...html.matchAll(/<th([^>]*data-sort="([^"]+)"[^>]*)>/g)];
  for (const m of ths) {
    expect(m[1]).toContain('tabindex="0"');
    expect(m[1]).toContain("aria-sort=");
  }
  // 既定の並び（残り昇順）に合わせて rem のみ ascending、他は none
  const attrs = Object.fromEntries(ths.map((m) => [m[2], /aria-sort="([^"]+)"/.exec(m[1])?.[1]]));
  expect(attrs).toEqual({
    rem: "ascending",
    date: "none",
    event: "none",
    conf: "none",
    rank: "none",
  });
  // 見出しの数は実装の並べ替え可能な鍵と一致する（どちらか一方だけ増える事故を防ぐ）。
  const keys = /const SORTABLE_KEYS = \[([^\]]*)\];/.exec(siteRuntime())?.[1] || "";
  expect(ths.length).toBe(keys.split(",").length);
  // 押す前に意味が分かるよう、見出しに title を持つ（語は崩さない）。
  for (const m of ths) {
    expect(m[1], `${m[2]} の見出しに説明が無い`).toContain("昇順・降順を切り替えます");
  }
  // 実行検証: setSortAria を抽出して fake DOM で状態遷移を確認する
  const src = jsFunction(html, "setSortAria");
  const script = [
    // 見出しは「語 + 目印」の一字列。テンプレートと同じ初期値から始め、書き換えを見る。
    "const LABELS = { rem: '残り', date: '日時（JST）', conf: '会議', rank: 'ランク' };",
    "const ths = ['rem','date','conf','rank'].map(k => ({ k, attrs: {}, text: LABELS[k] + ' ↕' }));",
    "const document = {",
    "  querySelectorAll: () => ths.map(t => ({",
    "    getAttribute: (a) => a === 'data-sort' ? t.k : null,",
    "    setAttribute: (a, v) => { t.attrs[a] = v; },",
    "    get textContent() { return t.text; },",
    "    set textContent(v) { t.text = v; },",
    "  })),",
    "};",
    // 目印の書き方は本物の実装を入れる（書き写すと矢印の対応がズレる）。
    `const sortMarkJa = ${jsFunction(html, "sortMarkJa")};`,
    `const setSortAria = ${src};`,
    "let sortAsc = true;",
    "setSortAria('rem');",
    "const s1 = JSON.stringify(ths.map(t => t.attrs['aria-sort']));",
    "const m1 = JSON.stringify(ths.map(t => t.text));",
    "setSortAria('date');",
    "const s2 = JSON.stringify(ths.map(t => t.attrs['aria-sort']));",
    "sortAsc = false;",
    "setSortAria('date');",
    "const s3 = JSON.stringify(ths.map(t => t.attrs['aria-sort']));",
    "const m3 = JSON.stringify(ths.map(t => t.text));",
    "console.log(s1 + '|' + s2 + '|' + s3 + '|' + m1 + '|' + m3);",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const [r1, r2, r3, m1, m3] = proc.stdout.trim().split("|");
  expect(JSON.parse(r1)).toEqual(["ascending", "none", "none", "none"]);
  expect(JSON.parse(r2)).toEqual(["none", "ascending", "none", "none"]);
  expect(JSON.parse(r3)).toEqual(["none", "descending", "none", "none"]);
  /* `aria-sort` だけ変えても、マウス利用者には何も見えない。押している列の目印を
   * ↑ / ↓ に変え、他の列は `↕` のままにする（語が削れてはいけない）。 */
  expect(JSON.parse(m1)).toEqual(["残り ↑", "日時（JST） ↕", "会議 ↕", "ランク ↕"]);
  expect(JSON.parse(m3)).toEqual(["残り ↕", "日時（JST） ↓", "会議 ↕", "ランク ↕"]);
});

it("dark theme via prefers-color-scheme overrides the palette (SPEC §7)", () => {
  const html = siteHtmlRuntime();
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
  expect(style).toContain("color-scheme: light dark");
  const root = style.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
  const dark =
    style.match(
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{[^{}]*:root\s*\{([^}]*)\}\s*\}/,
    )?.[1] ?? "";
  expect(dark, "@media (prefers-color-scheme: dark) が存在しない").not.toBe("");
  const varsOf = (block: string) =>
    Object.fromEntries(
      [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
    );
  const light = varsOf(root);
  const darkVars = varsOf(dark);
  const lum = (hex: string) => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) throw new Error(`hex でない: ${hex}`);
    const n = parseInt(m[1], 16);
    return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  };
  // ダーク値はライト値と異なり、背景が暗く・文字が明るく上書きされている
  expect(darkVars["--bg"]).not.toBe(light["--bg"]);
  expect(darkVars["--fg"]).not.toBe(light["--fg"]);
  expect(lum(darkVars["--bg"])).toBeLessThan(lum(light["--bg"]));
  expect(lum(darkVars["--fg"])).toBeGreaterThan(lum(light["--fg"]));
  expect(lum(darkVars["--bg"])).toBeLessThan(lum(darkVars["--fg"]));
});

it("drawer closes only on ✕ / backdrop click, not on inner elements", () => {
  const html = siteHtmlRuntime();
  // 静的検証: BUTTON 判定の除去と名前付き関数化がビルド成果に反映されている
  expect(html).toMatch(/function closeDrawer\(e(?:\s*=\s*null)?\)/);
  expect(html).not.toContain('e.target.tagName === "BUTTON"');
  const src = jsFunction(html, "closeDrawer");
  // 実行検証: fake DOM で閉じる / 閉じないの 4 経路を確認する
  const script = [
    "const removals = [];",
    // #218: closeDrawer は window._prevFocus を参照するため注入する（フォーカス復元対象は無し）
    "const window = { _prevFocus: null };",
    "const backdrop = { classList: { remove: () => removals.push(1) } };",
    "const document = { getElementById: (id) => (id === 'drawerBackdrop' ? backdrop : null) };",
    "function $(id) { return document.getElementById(id); }",
    // 閉じると URL から行の引数が外れる（第 148 回）ので、その口も見立てに置く。
    // `node -e` は ESM（厳格モード）なので、代入される変数は宣言が要る。
    "let drawerRow = { conf: { key: 'x' } };",
    "const writeUrl = () => {};",
    `const closeDrawer = ${src};`,
    // 1. ✕ の自前 onclick 経路（引数なし）→ 閉じる
    "closeDrawer();",
    "const r1 = removals.length;",
    // 2. バックドロップの直接クリック → 閉じる
    "closeDrawer({ target: backdrop });",
    "const r2 = removals.length;",
    // 3. ドロワー内の button → 閉じない（#207 回帰）
    "closeDrawer({ target: { tagName: 'BUTTON' } });",
    "const r3 = removals.length;",
    // 4. ドロワー内の通常クリック → 閉じない
    "closeDrawer({ target: { tagName: 'DIV' } });",
    "const r4 = removals.length;",
    "console.log(r1 + '|' + r2 + '|' + r3 + '|' + r4);",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  expect(proc.stdout.trim()).toBe("1|2|2|2");
});

it("narrow screens fall back to card layout (SPEC §7)", () => {
  const html = siteHtmlRuntime();
  // 狭幅向けメディアクエリが存在し、ブレークポイントが 640px 以下
  const mq = html.match(/@media \(max-width: (\d+)px\) \{/);
  expect(mq, "@media (max-width: ...) が存在しない").not.toBeNull();
  expect(Number(mq![1])).toBeLessThanOrEqual(640);
  // カード化の要: ヘッダ行非表示・行のブロック化・既存 data-label による列名表示
  expect(html).toContain("thead { display: none; }");
  expect(html).toContain("attr(data-label)");
  // 残り時間セルにも data-label が付き、カード内で列名が表示される
  expect(html).toContain('td(tr, "残り", "c-deadline")');
});

it("deadline display includes AoE notation for AoE deadlines only (SPEC §7)", () => {
  const html = siteHtmlRuntime();
  // 表とドロワーの両方が、公式表記が AoE のときだけ AoE を出す式になっている。
  // JST 宣言の国内締切まで AoE を並記すると、実在しない AoE 締切を検知させる。
  expect(html).toContain("Recommender.officialZone(r.dl)");
  expect(html).toMatch(/公式 \$\{fmtAoE\(d\)\}/);
  expect(html).toMatch(/crossCheck = `公式 \$\{fmtAoE\(new Date\(r\.t\)\)\}`/);
  expect(html).toContain('"公式 JST 締切"');
  // 実行検証: fmtAoE は UTC-12 の壁時計を返す（例: 12:00 UTC → 00:00 AoE）
  const src = jsFunction(html, "fmtAoE");
  const script = [
    "function pad(n) { return (n < 10 ? '0' : '') + n; }",
    `const fmtAoE = ${src};`,
    "const d = new Date(Date.UTC(2026, 8, 1, 12, 0));",
    "const e = new Date(Date.UTC(2026, 8, 2, 0, 30));",
    "console.log(fmtAoE(d) + '|' + fmtAoE(e));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  expect(proc.stdout.trim()).toBe("2026-09-01 00:00 AoE|2026-09-01 12:30 AoE");
});

it("past-deadline toggle reveals past rows (SPEC §7)", () => {
  const html = siteHtmlRuntime();
  // 静的検証: トグル UI と URL 状態の配線がある
  expect(html).toContain('id="past"');
  expect(html).toContain('p.get("past")');
  expect(html).toContain("state.past = pastFlag.on");
  expect(html).toMatch(/if\s*\(state\.past\)\s*(?:\{\s*)?p\.set\(["']past["'],\s*["']1["']\)/);
  // 実行検証: past=false では過去行が出ず、past=true で出る
  const filterSrc = jsFunction(html, "filter");
  const script = [
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    "function row(tOff) {",
    "  return {",
    "    kind: 'paper', est: false, cats: ['hpc'], rankPairs: [], hay: 'x',",
    "    t: now + tOff, tLast: now + tOff, ed: { deadlines: [] }, conf: { key: 'r' + tOff }",
    "  };",
    "}",
    // 未来 20 日 / 未来 3 日 / 過去 3 日 / 過去 20 日
    "const rows = [row(20 * DAY), row(3 * DAY), row(-3 * DAY), row(-20 * DAY)];",
    FILTER_RUNTIME_STUBS,
    "const mk = (past, win) => new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "  'return (' + FILTER + ')')(FakeDate, DAY, rows,",
    "  { q: '', cats: [], kind: '', rank: '', win: win, est: false, past: past }, true, 'rem');",
    // 過去を示さない:  future のみ（20日, 3日）。
    "const seen = [mk(false, 'all')().length, mk(true, 'all')().length];",
    // 「締切まで 7 日」+ 過去表示は **前後 7 日**（変更前は past 側が窓の外に出ず、
    // 過去分が片端から残った。実測で 7日以内+過去表示 = 2,059 行だった）。
    "seen.push(mk(true, '7d')().length, mk(false, '7d')().length);",
    // 「かまわない」なら過去表示で全件（窓は課さない）。
    "seen.push(mk(true, 'all')().length);",
    "console.log(JSON.stringify(seen));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  // past=false + 7日: 今後の 3 日後だけ（20 日後は窓の外、過去分はそもそも出ない）。
  expect(JSON.parse(proc.stdout)).toEqual([2, 4, 2, 1, 4]);
});

it("「過去の締切も表示」と CSV の読み方にてびきが応える（SPEC §7）", () => {
  const html = siteHtmlRuntime();
  expect(html).toContain("<dt>過去の締切も表示</dt>");
  expect(html).toContain("<dt>CSV</dt>");
  // 期間窓の案内は、過去を表示したときの前後窓として正しい記述にする
  // （「過ぎた締切は期間の外に出ます」は実装と逆の説明だった）。
  expect(html).toContain("同じ日数の<strong>前後</strong>の窓になります");
  expect(html).not.toContain("過ぎた締切は期間の外に出ます");
  // CSV は「表示中＝絞り込み後の全行」であること、数値の残り列と BOM を書く。
  const dd = html.slice(html.indexOf("<dt>CSV</dt>"), html.indexOf("<dt>並び順</dt>"));
  expect(dd).toContain("絞り込み後の全行");
  expect(dd).toContain("BOM");
  expect(dd).toContain("負の数");
});

it("drawer is a keyboard-operable modal dialog with focus management (#218)", () => {
  const html = siteHtmlRuntime();
  // 静的検証: dialog セマンティクス・無名アイコンボタンのラベル・キーボード経路・ヒント表記
  expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="drawerTitle"');
  expect(html).toContain('aria-label="閉じる"');
  expect(html).toContain("tr.tabIndex = -1;");
  expect(html).toContain("<kbd>d</kbd> 詳細");
  // 実行検証: d キーで選択行のドロワーが開き、開閉でフォーカスが移る / 戻る
  const keySrc = keydownWithBlockers(html);
  const drawerDepsSrc = [
    // 会期の書き方の正本は recommender.js に移した（一覧・行の詳細・索引が同じ 1 本。第 220 回）。
    siteRuntime("recommender.js").match(/const CALENDAR_DATE_JA = \[[^\]]*\];/)?.[0] ?? "",
    jsFunction(siteRuntime("recommender.js"), "weekdayJaFromDate"),
    'const placeJa = (v) => String(v ?? "");',
    jsFunction(siteRuntime("recommender.js"), "meetingRangeJa"),
    jsFunction(siteRuntime("recommender.js"), "upcomingEditionsOf"),
    jsFunction(siteRuntime("recommender.js"), "laterEditionLineJa"),
  ].join("\n");
  const openSrc = jsFunction(html, "openDrawer");
  const summarySrc = jsFunction(html, "verificationSummary");
  const closeSrc = jsFunction(html, "closeDrawer");
  const script = [
    "const calls = { open: [], focus: [] };",
    "const prevEl = { focus() { calls.focus.push('prev'); document.activeElement = prevEl; } };",
    "const closeBtn = { focus() { calls.focus.push('close'); document.activeElement = closeBtn; } };",
    "const rowEls = [",
    "  { focus() { calls.focus.push('row0'); document.activeElement = rowEls[0]; } },",
    "  { focus() { calls.focus.push('row1'); document.activeElement = rowEls[1]; } },",
    "];",
    "rowEls[0].classList = { contains: () => false };",
    "rowEls[1].classList = { contains: () => false };",
    "const backdrop = { classList: { add() {}, remove() {} } };",
    "const els = {",
    "  drawerBackdrop: backdrop, drawerTitle: {}, drawerFullName: {}, drawerBody: {},",
    "  drawerClose: closeBtn, tbody: { querySelectorAll: () => rowEls }, q: { focus() {} },",
    "};",
    "const document = { activeElement: prevEl, getElementById: (id) => els[id] || null };",
    "function $(id) { return document.getElementById(id); }",
    "const window = { _prevFocus: null };",
    "const openSpy = (r) => calls.open.push(r);",
    "const closeSpy = () => {};",
    `const KEY = ${JSON.stringify(keySrc)};`,
    `const OPEN = ${JSON.stringify(openSrc)};`,
    `const KIND_DETAIL = (${jsFunction(html, "kindDetailJa")});`,
    `const SUMMARY = ${JSON.stringify(summarySrc)};`,
    `const CLOSE = ${JSON.stringify(closeSrc)};`,
    drawerDepsSrc as string,
    "const onKeydown = new Function('window', 'document', '$', 'selectedIndex', 'shown', 'openDrawer', 'closeDrawer', KEY + ';return onKeydown;')(window, document, $, 1, ['A', 'B'], openSpy, closeSpy);",
    // d キー → 選択行 (shown[1]) のドロワーが開き、行にフォーカスが移る
    "onKeydown({ key: 'd', preventDefault() {}, target: { tagName: 'BODY' } });",
    "const dOpened = calls.open.length === 1 && calls.open[0] === 'B';",
    "const dFocusedRow = calls.focus[calls.focus.length - 1] === 'row1';",
    "const verificationSummary = new Function('esc', 'return (' + SUMMARY + ')')((s) => String(s ?? ''));",
    // 「未確認」の語は正本（recommender.js の `UNCONFIRMED_LABEL_JA`）から取る。
    (siteRuntime("recommender.js").match(/const UNCONFIRMED_LABEL_JA = [^\n]*;/) || [""])[0],
    "const UNCONFIRMED_JA = UNCONFIRMED_LABEL_JA;",
    "const openDrawer = new Function('window', 'document', '$', 'KIND_LABEL', 'titleWithYear', 'fmtDate', 'fmtJst', 'fmtAoE', 'esc', 'safeExternalUrl', 'rowDateOnlyState', 'verificationSummary', 'Recommender', 'meetingRangeJa', 'upcomingEditionsOf', 'kindDetailJa', 'writeUrl', 'UNCONFIRMED_JA', 'fieldReasonsJa', 'return (' + OPEN + ')')(window, document, $, {}, (t) => t, () => '', () => '', () => '', (s) => String(s ?? ''), (s) => String(s ?? ''), () => null, verificationSummary, { officialZone: () => '', placeJa: (v) => String(v ?? ''), topicTagsJa: () => [], weekdayJaFromDate: (v) => weekdayJaFromDate(v), eventCellJa: (r) => String(r?.ed?.event_start || r?.ed?.date_text || ''), meetingRangeJa: meetingRangeJa, upcomingEditionsOf: upcomingEditionsOf, laterEditionLineJa: laterEditionLineJa }, meetingRangeJa, upcomingEditionsOf, KIND_DETAIL, () => {}, UNCONFIRMED_JA, { event: () => '', place: () => '', rank: () => '', note: (t) => (t ? '<i>' + t + '</i>' : '') });",
    "document.activeElement = prevEl;",
    "openDrawer({ kind: 'journal', conf: { title: 'X' }, ed: { place: 'P', date_text: 'D' } });",
    "const focusedClose = document.activeElement === closeBtn;",
    "const savedPrev = window._prevFocus === prevEl;",
    "const closeDrawer = new Function('window', 'document', '$', 'writeUrl', 'return (' + CLOSE + ')')(window, document, $, () => {});",
    "closeDrawer();",
    "const restored = document.activeElement === prevEl;",
    "console.log(JSON.stringify({ dOpened, dFocusedRow, focusedClose, savedPrev, restored }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  expect(JSON.parse(proc.stdout)).toEqual({
    dOpened: true,
    dFocusedRow: true,
    focusedClose: true,
    savedPrev: true,
    restored: true,
  });
});

it("global shortcuts respect editable targets and recommendation mode", () => {
  const html = siteHtmlRuntime();
  const keySrc = keydownWithBlockers(html);
  const script = [
    "const calls = { prevented: 0, focused: 0, opened: 0 };",
    "const state = { mode: 'recommend' };",
    "const window = {};",
    "const document = {};",
    "function $(id) { return id === 'q' ? { focus() { calls.focused++; } } : null; }",
    "const onKeydown = new Function('state', 'window', 'document', '$', 'selectedIndex', 'shown', 'openDrawer', 'closeDrawer', KEY + ';return onKeydown;')(state, window, document, $, 0, [], () => { calls.opened++; }, () => {});",
    "function event(key, target) { onKeydown({ key, target, preventDefault() { calls.prevented++; } }); }",
    "event('j', { tagName: 'TEXTAREA', isContentEditable: false });",
    "event('j', { tagName: 'DIV', isContentEditable: true });",
    "event('j', { tagName: 'BODY', isContentEditable: false });",
    "event('/', { tagName: 'BODY', isContentEditable: false });",
    "console.log(JSON.stringify(calls));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", `const KEY = ${JSON.stringify(keySrc)};\n${script}`], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  expect(JSON.parse(proc.stdout)).toEqual({ prevented: 2, focused: 1, opened: 0 });
});

it("keyboard Enter opens external links with noopener (reverse tabnabbing, #517)", () => {
  const runtime = siteRuntime();
  // 全 window.open 呼び出しが opener を渡さないこと（第三引数に noopener を含む）
  const opens = runtime.match(/window\.open\([^)]*\)/g) ?? [];
  expect(opens.length).toBeGreaterThan(0);
  for (const call of opens) {
    expect(call).toMatch(/["'`]noopener/);
  }
});

it("meeting past rule is wired to the end date", () => {
  const html = siteHtmlRuntime();
  expect(html).not.toContain('kind: "event"');
  expect(html).not.toContain('event: "開催"');
});

it("upcoming.md window honors config site.upcoming_days", async () => {
  const confs = [
    makeConference({
      key: "win60",
      title: "WIN60",
      categories: ["hpc"],
      sources: ["local"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "win6026",
          source: "local",
          deadlines: [
            makeDeadline("paper", "paper", utc(2026, 8, 20)), // +11d: inside a 60d window
          ],
        }),
        makeEdition({
          year: 2026,
          edition_id: "win6026b",
          source: "local",
          deadlines: [
            makeDeadline("paper", "paper", utc(2026, 11, 15)), // +98d: inside 180d, outside 60d
          ],
        }),
      ],
    }),
  ];
  const outdir = mkdtempSync(join(tmpdir(), "cfp-win-"));
  await buildAll(confs, { categories: { hpc: "HPC" }, site: { upcoming_days: 60 } }, outdir, NOW, {
    noEmbeddings: true,
  });
  const text = readFileSync(join(outdir, "upcoming.md"), "utf8");
  // ヘッダは設定値を表示する
  expect(text).toContain("# 直近 60 日の締切と開催");
  // 60 日以内の締切は残り、60 日超は窓から落ちる
  expect(text).toContain("WIN60");
  expect(text).not.toContain("2026-11-15");
  // llms.txt の説明も設定値に一致する
  const llms = readFileSync(join(outdir, "llms.txt"), "utf8");
  expect(llms).toContain("直近 60 日の締切と開催の表");
});

it("toUpcomingMd formats sub-hour remaining times as minutes and sub-day as hours", () => {
  const confs = [
    makeConference({
      key: "urgent",
      title: "URGENT",
      categories: ["systems"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "urgent26",
          deadlines: [
            makeDeadline("paper", "Paper", new Date(NOW.getTime() + 45 * 60_000)), // +45min
            makeDeadline("abstract", "Abstract", new Date(NOW.getTime() + 3 * 3_600_000)), // +3h
            makeDeadline("notification", "Notification", new Date(NOW.getTime() + 2 * 86_400_000)), // +2d
          ],
        }),
      ],
    }),
  ];
  const recs = recordsOf(confs);
  const md = toUpcomingMd(recs, NOW, 30);
  expect(md).toContain("| 45分 |");
  expect(md).toContain("| 3時間 |");
  expect(md).toContain("| 2日 |");
});

it("toUpcomingMd outputs fallback row when no upcoming deadlines match", () => {
  const md = toUpcomingMd([], NOW, 30);
  expect(md).toContain("| - | - | 該当なし | - | - | - | - |");
});

it("toLlmsTxt documents outputs and categories correctly", () => {
  const text = toLlmsTxt({
    categories: { systems: "Systems" },
  });
  expect(text).toContain("data.json");
  expect(text).toContain("upcoming.md");
  expect(text).toContain("catalog.json");
  expect(text).toContain("recommendation-index.json");
  expect(text).toContain("app.js");
  expect(text).toContain("deadlines.ics");
  expect(text).toContain("実在値: systems");
});

it("site template statUpcoming counts confirmed submission deadlines only", () => {
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const runtime = siteRuntime();
  expect(template).toMatch(/Content-Security-Policy/);
  expect(template).toMatch(
    /script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https:\/\/cdn\.jsdelivr\.net https:\/\/cdnjs\.cloudflare\.com/,
  );
  expect(template).toMatch(
    /connect-src 'self' https:\/\/cdn\.jsdelivr\.net https:\/\/huggingface\.co https:\/\/cdn-lfs\.huggingface\.co/,
  );
  expect(template).toContain(".verification-summary");
  // script-src ディレクティブ内のみワイルドカード禁止 (connect-src の *.cdn.hf.co は
  // fetch 先の許可であり script 実行元ではない)。境界は ';'。
  expect(template).not.toMatch(/script-src[^;>]*\*/);
  // statUpcoming の計算が投稿締切 (abstract/paper) かつ非推定 (!r.est) のみに限定されていること
  expect(runtime).toMatch(
    /rows\.filter\(\(r\)\s*=>\s*\(r\.kind\s*===\s*"abstract"\s*\|\|\s*r\.kind\s*===\s*"paper"\)\s*&&\s*!r\.est/,
  );
});

it("site template lazy-loads recommendation data outside the catalog shell (#468)", () => {
  const runtime = siteRuntime();
  expect(runtime).toContain("loadPublishedRecommendation");
  expect(siteRuntime("publish.js")).toContain('fetchText("recommendation-index.json")');
  expect(runtime).toContain("setRecommendationProfile(result.index)");
});

it("site runtime lazy-loads deadline history with retry and stale-response guards (#491)", () => {
  const runtime = siteRuntime();
  expect(runtime).toContain("function createHistoryLoader(fetchJson, onState)");
  expect(runtime).toContain("function resolveHistoryRef()");
  expect(runtime).toMatch(
    /if\s*\(state\.mode\s*===\s*"deadlines"\s*&&\s*state\.past\)\s*loadHistoryData\(\)/,
  );
  expect(runtime).toMatch(
    /if\s*\(state\.mode\s*!==\s*"deadlines"\s*\|\|\s*!state\.past\)\s*return/,
  );
  expect(runtime).toMatch(
    /if\s*\(!response\.ok\)\s*throw new Error\(`history \$\{response\.status\}`\)/,
  );

  const loaderSrc = jsFunction(runtime, "createHistoryLoader");
  const script = [
    `const createHistoryLoader = ${loaderSrc};`,
    "const flush = () => new Promise((resolve) => setImmediate(resolve));",
    "const requests = [];",
    "const states = [];",
    "const loader = createHistoryLoader((ref) => new Promise((resolve, reject) => requests.push({ ref, resolve, reject })), (status) => states.push(status));",
    "(async () => {",
    '  const first = loader.load("data.json");',
    '  const same = loader.load("data.json");',
    "  await flush();",
    "  requests[0].resolve({ conferences: [{ editions: [] }] });",
    "  const value = await first;",
    '  const cached = await loader.load("data.json");',
    "  const retryRequests = [];",
    "  const retryStates = [];",
    "  const retryLoader = createHistoryLoader((ref) => new Promise((resolve, reject) => retryRequests.push({ ref, resolve, reject })), (status) => retryStates.push(status));",
    '  const bad = retryLoader.load("data.json");',
    "  await flush();",
    '  retryRequests[0].resolve({ conferences: "malformed" });',
    "  await bad;",
    '  const retried = retryLoader.load("data.json");',
    "  await flush();",
    "  retryRequests[1].resolve({ conferences: [] });",
    "  const recovered = await retried;",
    "  const staleRequests = [];",
    "  const staleStates = [];",
    "  const staleLoader = createHistoryLoader((ref) => new Promise((resolve, reject) => staleRequests.push({ ref, resolve, reject })), (status) => staleStates.push(status));",
    '  const stale = staleLoader.load("data.json");',
    "  await flush();",
    "  staleLoader.cancel();",
    '  const current = staleLoader.load("data.json");',
    "  await flush();",
    '  staleRequests[0].resolve({ conferences: [{ editions: [] }], marker: "old" });',
    '  staleRequests[1].resolve({ conferences: [], marker: "new" });',
    "  const staleValue = await stale;",
    "  const currentValue = await current;",
    "  console.log([value === cached, first === same, requests.length, states.join('|'), retryStates.join('|'), recovered && retryLoader.status, staleValue === null, currentValue.marker, staleStates.join('|')].join('|'));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  expect(proc.stdout.trim()).toBe(
    "true|true|1|loading|ready|loading|error|loading|ready|ready|true|new|loading|loading|ready",
  );
});

it("site template localized shortcuts label and preset button active sync", () => {
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const runtime = siteRuntime();
  // SPEC §7: 日本語 UI。Shortcuts: ではなく ショートカット:
  // 案内の語そのものは見ない（キーの並びは「効いているキーと画面のショートカット案内・
  // てびきの並び替えの導線がズレない」の検査が、ビルド後のコードから受け取るキーを
  // 正本に確かめる）。ここでは「読み上げられる欄にショートカット案内が有るか」だけを見る。
  expect(template).toContain("ショートカット: <kbd>j</kbd>");
  expect(template).not.toContain("Shortcuts: <kbd>j</kbd>");
  expect(template).toContain("A*ランク");
  expect(template).not.toContain("Top Tier");
  expect(template).toContain("投稿予定概要");
  expect(template).not.toContain("投稿予定 Abstract");
  expect(runtime).toContain("意味検索の候補");
  expect(runtime).not.toContain("semantic 候補");
  expect(runtime).toContain("意味の近さ ");
  // クイック抽出プリセットボタンが data-preset を持ち、updatePresetActive で同期されること
  expect(template).toContain('data-preset="7d"');
  expect(template).toContain('data-preset="a_star"');
  expect(template).toContain('data-preset="hpc_sys"');
  expect(template).toContain('data-preset="domestic"');
  expect(template).toContain('data-preset="online"');
  expect(runtime).toContain("function updatePresetActive()");
});

it("site template does not include external Google Fonts per SPEC §7 (#223)", () => {
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  // SPEC §7: コア UI は外部 Web フォントを使わない
  expect(template).not.toContain("fonts.googleapis.com");
  expect(template).not.toContain("fonts.gstatic.com");
  expect(template).not.toContain("family=Inter");
  expect(template).not.toContain("family=JetBrains+Mono");
  expect(template).toContain("--font-sans: system-ui,");
  expect(template).toContain("--font-mono: ui-monospace,");
});

it("site template exposes independent recommendation and deadline render paths (#466)", () => {
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const runtime = siteRuntime();
  expect(template).toContain('id="modeRecommend"');
  expect(template).toContain('id="modeDeadlines"');
  expect(template).toContain('aria-pressed="false"');
  expect(template).toContain('id="deadlineTableWrap"');
  expect(template).toContain('id="recommendationCards"');
  expect(runtime).toContain("function setMode(mode)");
  expect(runtime).toContain("renderRecommendationCards(paperMode ? shown : [])");
  expect(template).toContain("mode-recommend .deadline-only");
  expect(template).toContain("mode-deadlines .recommend-only");
});

it("openDrawer escapes place, date_text, and official-site href (#390)", () => {
  const runtime = siteRuntime();
  const start = runtime.indexOf("function openDrawer");
  const end = runtime.indexOf("window.openDrawer", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = runtime.slice(start, end);
  expect(body).toContain("esc(r.ed.place");
  // 会期の公式表記は原表記として別に出す（主語は一覧と同じ式）。公式表記が主語だった頃と
  // 違って `eventRawJa` 経由になるので、生値が `date_text` から来ることごと確かめる。
  expect(body).toContain("esc(eventRawJa");
  expect(body).toContain('String(r.ed.date_text || "")');
  // 主語の会期も esc を通す（`eventCellJa` の値を、esc を通さずに混ぜない）。
  expect(body).toMatch(/esc\(\s*\n?\s*eventShownJa/);
  expect(body).toContain("safeExternalUrl(r.ed.link || r.conf.link)");
  expect(body).toContain("esc(officialLink)");
});

it("openDrawer escapes KIND_LABEL fallback kind (#396)", () => {
  const runtime = siteRuntime();
  const start = runtime.indexOf("function openDrawer");
  const end = runtime.indexOf("window.openDrawer", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = runtime.slice(start, end);
  expect(body).toMatch(/esc\(\s*KIND_LABEL\[r\.kind\]/);
  expect(body).not.toMatch(/\+ \(KIND_LABEL\[r\.kind\] \|\| r\.kind\) \+/);
});

it("normal deadline drawer includes verification details", () => {
  const runtime = siteRuntime();
  // ドロワーは「今後の会期」も組むので、依存も正本から注入する（書き写さない）。
  const drawerDepsSrc = [
    verificationLabelsSource(),
    // 会期の書き方の正本は recommender.js に移した（一覧・行の詳細・索引が同じ 1 本。第 220 回）。
    siteRuntime("recommender.js").match(/const CALENDAR_DATE_JA = \[[^\]]*\];/)?.[0] ?? "",
    jsFunction(siteRuntime("recommender.js"), "weekdayJaFromDate"),
    'const placeJa = (v) => String(v ?? "");',
    jsFunction(siteRuntime("recommender.js"), "meetingRangeJa"),
    jsFunction(siteRuntime("recommender.js"), "upcomingEditionsOf"),
    jsFunction(siteRuntime("recommender.js"), "laterEditionLineJa"),
  ].join("\n");
  const openSrc = jsFunction(runtime, "openDrawer");
  const summarySrc = jsFunction(runtime, "verificationSummary");
  const script = [
    drawerDepsSrc as string,
    "const body = { innerHTML: '' };",
    "const closeBtn = { focus() {} };",
    "const els = {",
    "  drawerBackdrop: { classList: { add() {} } }, drawerTitle: {}, drawerFullName: {},",
    "  drawerBody: body, drawerClose: closeBtn,",
    "};",
    "const document = { activeElement: null, getElementById: (id) => els[id] || null };",
    "function $(id) { return document.getElementById(id); }",
    "const window = { _prevFocus: null };",
    `const verificationSummary = new Function('esc', 'return (' + ${JSON.stringify(summarySrc)} + ')')((s) => String(s ?? ''));`,
    // 「未確認」の語は正本（recommender.js の `UNCONFIRMED_LABEL_JA`）から取る。
    (siteRuntime("recommender.js").match(/const UNCONFIRMED_LABEL_JA = [^\n]*;/) || [""])[0],
    "const UNCONFIRMED_JA = UNCONFIRMED_LABEL_JA;",
    `const openDrawer = new Function('window', 'document', '$', 'KIND_LABEL', 'titleWithYear', 'fmtDate', 'fmtJst', 'fmtAoE', 'esc', 'safeExternalUrl', 'rowDateOnlyState', 'verificationSummary', 'Recommender', 'meetingRangeJa', 'upcomingEditionsOf', 'kindDetailJa', 'writeUrl', 'UNCONFIRMED_JA', 'fieldReasonsJa', 'return (' + ${JSON.stringify(openSrc)} + ')')(window, document, $, {}, (t) => t, () => '', () => '', () => '', (s) => String(s ?? ''), (s) => String(s ?? ''), () => null, verificationSummary, { officialZone: () => '', placeJa: (v) => String(v ?? ''), topicTagsJa: () => [], weekdayJaFromDate: (v) => weekdayJaFromDate(v), eventCellJa: (r) => String(r?.ed?.event_start || r?.ed?.date_text || ''), meetingRangeJa: meetingRangeJa, upcomingEditionsOf: upcomingEditionsOf, laterEditionLineJa: laterEditionLineJa }, meetingRangeJa, upcomingEditionsOf, (${jsFunction(runtime, "kindDetailJa")}), () => {}, UNCONFIRMED_JA, { event: () => '', place: () => '', rank: () => '', note: (t) => (t ? '<i>' + t + '</i>' : '') });`,
    "openDrawer({",
    "  kind: 'paper', conf: { key: 'demo', title: 'Demo' },",
    "  ed: { year: 2026, place: 'P', date_text: 'D' }, t: 0, tLast: 0,",
    "  dl: { verification: { last_verified_at: '2026-08-01T10:00:00Z', source_class: 'official-cfp', status: 'verified', next_check_at: '2026-09-01T10:00:00Z' }, evidence: [{ verifiedFields: ['date', 'time', 'timezone'] }] },",
    "});",
    "console.log(body.innerHTML);",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  expect(proc.stdout).toContain("公式確認");
  expect(proc.stdout).toContain("公式CFP");
  // 項目名は日本語に直して出す（収録データの内部表記 `date・time・timezone` のままを見せない）。
  expect(proc.stdout).toContain("日付・時刻・タイムゾーン");
  expect(proc.stdout).not.toContain("date・time・timezone");
  expect(proc.stdout).toContain("確認済み");
  expect(proc.stdout).toContain("次回確認予定");
});

it("repolink URL is sanitised via safeExternalUrl (#419)", () => {
  // #419: DATA.sources[].url を a.href に代入する箇所が safeExternalUrl を
  // 経由していないと、javascript:alert(1) 等の不正スキーマがクロスサイト
  // スクリプティングの原因になる。ビルド成果が safeExternalUrl(localSrc.url)
  // を使うことを静的に検証する。
  const runtime = siteRuntime();
  expect(runtime).toContain("safeExternalUrl(localSrc.url)");
  expect(runtime).not.toMatch(/a\.href\s*=\s*localSrc\.url[^)]/);
});

it("SPEC §7 carves out recommender CDNs and the site stays on that allowlist (#370)", () => {
  const spec = readFileSync(join(REPO_ROOT, "SPEC.md"), "utf8");
  const section7 = spec.slice(spec.indexOf("## 7."), spec.indexOf("## 8."));
  expect(section7).toMatch(/cdn\.jsdelivr\.net/);
  expect(section7).toMatch(/@xenova\/transformers/);
  expect(section7).toMatch(/cdnjs\.cloudflare\.com/);
  expect(section7).toMatch(/pdf\.js/);
  expect(section7).toMatch(/recommender\.js/);
  expect(section7).toMatch(/代替動作/);

  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const runtime = siteRuntime();
  const allowed = [
    "https://cdn.jsdelivr.net",
    "https://cdnjs.cloudflare.com",
    "https://huggingface.co",
    "https://cdn-lfs.huggingface.co",
    "https://*.cdn.hf.co",
    "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/+esm",
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  ];
  const urls = [...(template + runtime).matchAll(/https:\/\/[^\s"'`]+/g)].map((m) => m[0]);
  const cdnLike = urls
    .map((u) => u.replace(/[;,]+$/, ""))
    .filter((u) => /cdn\.|jsdelivr|unpkg|cdnjs|googleapis|gstatic|esm\.sh/i.test(u));
  for (const url of cdnLike) {
    expect(allowed).toContain(url);
  }
});

it("escapeMdCell escapes pipe characters and collapses newlines (#236)", () => {
  expect(escapeMdCell("Tokyo | Online")).toBe("Tokyo \\| Online");
  expect(escapeMdCell("Line 1\nLine 2\r\nLine 3")).toBe("Line 1 Line 2 Line 3");
  expect(escapeMdCell(null)).toBe("");
  expect(escapeMdCell(undefined)).toBe("");
});

it("toUpcomingMd escapes pipe characters in title and place preserving 7-column table layout (#236)", () => {
  const records = [
    {
      type: "deadline" as const,
      categories: ["ai"],
      kind_label: "論文締切",
      estimated: false,
      conf: makeConference({
        key: "pipe-conf",
        title: "Test | Workshop",
        categories: ["ai"],
        sources: ["local"],
        link: "https://example.com",
      }),
      edition: makeEdition({
        year: 2026,
        edition_id: "pipe26",
        estimated: false,
        place: "Tokyo | Online (Hybrid)",
        link: "https://example.com",
      }),
      deadline: {
        kind: "paper" as const,
        label: "Paper",
        at_utc: new Date("2026-08-20T12:00:00Z"),
        tz_raw: "UTC",
        round: 1,
        comment: null,
      },
      all_day: false,
      start: new Date("2026-08-20T11:30:00Z"),
      end: new Date("2026-08-20T12:00:00Z"),
    },
    {
      type: "event" as const,
      categories: ["ai"],
      kind_label: "開催",
      estimated: false,
      conf: makeConference({
        key: "pipe-event",
        title: "Symposium | Special Track",
        categories: ["ai"],
        sources: ["local"],
        link: "https://example.com",
      }),
      edition: makeEdition({
        year: 2026,
        edition_id: "pipeev26",
        estimated: false,
        event_start: new Date("2026-08-25T00:00:00Z"),
        event_end: new Date("2026-08-27T00:00:00Z"),
        place: "Kyoto | In-person",
        link: "https://example.com",
      }),
      deadline: null,
      all_day: true,
      start: new Date("2026-08-25T00:00:00Z"),
      end: new Date("2026-08-27T00:00:00Z"),
    },
  ];
  const md = toUpcomingMd(records, new Date("2026-08-10T00:00:00Z"));
  expect(md).toContain("[Test \\| Workshop 2026](https://example.com)");
  // 開催地はサイトの表と同じ日本語表記を出す（パイプのエスケープはそのまま保つ）。
  expect(md).toContain("Tokyo \\| オンライン (ハイブリッド)");
  expect(md).toContain("[Symposium \\| Special Track 2026](https://example.com)");
  expect(md).toContain("Kyoto \\| 対面");

  // テーブルの各行の列区切り（エスケープされていないパイプ）が正確に 8 本（7 列）であることを検証
  const tableRows = md.split("\n").filter((l) => l.startsWith("|") && !l.includes("---"));
  for (const row of tableRows) {
    const unescapedPipes = row.split(/(?<!\\)\|/g).length - 1;
    expect(unescapedPipes).toBe(8);
  }
});

it("titleWithYear avoids duplicate short-year appending and handles missing years (#276, #294)", () => {
  expect(titleWithYear("CANOPIE-HPC 2026", 2026)).toBe("CANOPIE-HPC 2026");
  expect(titleWithYear("SC '26", 2026)).toBe("SC '26");
  expect(titleWithYear("SC ’26", 2026)).toBe("SC ’26");
  expect(titleWithYear("EuroSys ’26", 2026)).toBe("EuroSys ’26");
  expect(titleWithYear("GeoAI'26", 2026)).toBe("GeoAI'26");
  expect(titleWithYear("CAIS'26", 2026)).toBe("CAIS'26");
  expect(titleWithYear("SC26", 2026)).toBe("SC26");
  expect(titleWithYear("SIGCOMM", 2026)).toBe("SIGCOMM 2026");
  expect(titleWithYear("IPSJ", 0)).toBe("IPSJ");
  expect(titleWithYear("IPSJ", null)).toBe("IPSJ");
  expect(titleWithYear("IPSJ", undefined)).toBe("IPSJ");
  expect(titleWithYear(null, 2026)).toBe("");
  expect(titleWithYear(undefined, 2026)).toBe("");
});

it("escapeMdUrl sanitizes pipes, spaces, newlines, and parentheses (#284)", () => {
  expect(escapeMdUrl("https://example.com/test?a=1|b=2")).toBe(
    "https://example.com/test?a=1%7Cb=2",
  );
  expect(escapeMdUrl("https://example.com/path (2026)/cfp.html")).toBe(
    "https://example.com/path%20%282026%29/cfp.html",
  );
  expect(escapeMdUrl("https://example.com/cfp with space/")).toBe(
    "https://example.com/cfp%20with%20space/",
  );
  expect(escapeMdUrl("https://example.com/path\r\n/cfp.html")).toBe(
    "https://example.com/path/cfp.html",
  );
  expect(escapeMdUrl("https://example.com/normal")).toBe("https://example.com/normal");
  expect(escapeMdUrl("")).toBe("");
  expect(escapeMdUrl(null)).toBe("");
  expect(escapeMdUrl(undefined)).toBe("");
});

it("toUpcomingMd escapes pipe characters in URLs and preserves 7 table columns (#284)", () => {
  const records = [
    {
      type: "deadline" as const,
      categories: ["networking"],
      kind_label: "論文締切",
      estimated: false,
      conf: makeConference({
        key: "test-pipe-url",
        title: "PipeUrlConf",
        full_name: "Conference with Pipe in URL",
        categories: ["networking"],
        link: "https://example.com/cfp?track=main|poster",
      }),
      edition: makeEdition({
        year: 2026,
        edition_id: "pipe-url-2026",
        link: "https://example.com/cfp?track=main|poster",
        place: "Tokyo, Japan",
        date_text: "August 17-21, 2026",
        event_start: new Date("2026-08-17T00:00:00Z"),
        event_end: new Date("2026-08-21T00:00:00Z"),
      }),
      deadline: {
        kind: "paper" as const,
        label: "Full Paper",
        at_utc: new Date("2026-08-20T23:59:59Z"),
        tz_raw: "AoE",
        round: 1,
        comment: null,
      },
      all_day: false,
      start: new Date("2026-08-20T23:29:59Z"),
      end: new Date("2026-08-20T23:59:59Z"),
    },
  ];
  const md = toUpcomingMd(records, new Date("2026-08-10T00:00:00Z"));
  expect(md).toContain("[PipeUrlConf 2026](https://example.com/cfp?track=main%7Cposter)");

  const tableRows = md.split("\n").filter((l) => l.startsWith("|") && !l.includes("---"));
  for (const row of tableRows) {
    const unescapedPipes = row.split(/(?<!\\)\|/g).length - 1;
    expect(unescapedPipes).toBe(8); // 8 pipes = 7 columns
  }
});

it("parseCliArgs parses short flags with equals syntax (-o=dist, -c=config.yaml, etc.) (#286)", () => {
  const res1 = parseCliArgs([
    "build",
    "-o=dist",
    "-c=custom.yaml",
    "-n=2026-08-09T00:00:00Z",
    "--offline=true",
  ]);
  expect(res1.command).toBe("build");
  expect(res1.out).toBe("dist");
  expect(res1.config).toBe("custom.yaml");
  expect(res1.now).toBe("2026-08-09T00:00:00Z");
  expect(res1.offline).toBe(true);

  const res2 = parseCliArgs(["review", "-l=25", "-C=custom_cand.yaml"]);
  expect(res2.command).toBe("review");
  expect(res2.limit).toBe(25);
  expect(res2.candidates).toBe("custom_cand.yaml");

  const res3 = parseCliArgs(["discover", "-y=2027", "-d=true", "-a=true"]);
  expect(res3.command).toBe("discover");
  expect(res3.minYear).toBe(2027);
  expect(res3.dryRun).toBe(true);
  expect(res3.append).toBe(true);
});

it("buildAll emits recommender.js when custom template is in separate directory (#306)", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "cfp-custom-tmpl-"));
  const customTmpl = join(tmpDir, "custom_template.html");
  writeFileSync(customTmpl, "<html><body>/*__DATA__*/null</body></html>", "utf8");

  const outDir = join(tmpDir, "out");
  const stats = await buildAll(
    [],
    { template: customTmpl },
    outDir,
    new Date("2026-08-09T00:00:00Z"),
    {
      noEmbeddings: true,
    },
  );

  expect(stats.conferences).toBe(0);
  expect(existsSync(join(outDir, "index.html"))).toBe(true);
  expect(existsSync(join(outDir, "recommender.js"))).toBe(true);
  expect(readFileSync(join(outDir, "recommender.js"), "utf8")).toContain("Recommender");
});

it("buildAll removes stale managed files and requires the site template", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "cfp-missing-template-"));
  const outDir = join(tmpDir, "out");
  mkdirSync(outDir, { recursive: true });
  for (const name of ["index.html", "recommender.js", "embeddings.json"]) {
    writeFileSync(join(outDir, name), "stale", "utf8");
  }
  writeFileSync(join(outDir, "keep.txt"), "keep", "utf8");

  await expect(
    buildAll(
      [],
      { template: join(tmpDir, "missing-template.html") },
      outDir,
      new Date("2026-08-09T00:00:00Z"),
      { noEmbeddings: true },
    ),
  ).rejects.toThrow(/required site template missing/);
  expect(existsSync(join(outDir, "index.html"))).toBe(false);
  expect(existsSync(join(outDir, "recommender.js"))).toBe(false);
  expect(existsSync(join(outDir, "embeddings.json"))).toBe(false);
  expect(existsSync(join(outDir, "keep.txt"))).toBe(true);
});

it("buildAll removes stale embeddings when local model generation fails", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "cfp-stale-embeddings-"));
  const outDir = join(tmpDir, "out");
  const template = join(tmpDir, "template.html");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "embeddings.json"), "stale", "utf8");
  writeFileSync(template, "<html><body>/*__DATA__*/null</body></html>", "utf8");
  const originalCacheDir = env.cacheDir;
  env.cacheDir = join(tmpDir, "empty-cache");

  try {
    await buildAll([], { template }, outDir, NOW, { localEmbeddingsOnly: true });
  } finally {
    env.cacheDir = originalCacheDir;
  }

  expect(existsSync(join(outDir, "embeddings.json"))).toBe(false);
  expect(JSON.parse(readFileSync(join(outDir, "publish.json"), "utf8")).semantic_status).toBe(
    "lexical-only",
  );
});

it("buildAll rejects a site template without the data marker", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "cfp-missing-marker-"));
  const outDir = join(tmpDir, "out");
  const template = join(tmpDir, "template.html");
  writeFileSync(template, "<!doctype html><title>empty</title>\n", "utf8");

  await expect(
    buildAll([], { template }, outDir, new Date("2026-08-09T00:00:00Z"), { noEmbeddings: true }),
  ).rejects.toThrow(/template marker missing/);
  expect(existsSync(join(outDir, "publish.json"))).toBe(false);
});

it("buildAll handles null and undefined arguments safely and setRoot works (#336)", async () => {
  const originalRoot = ROOT;
  try {
    setRoot("/custom/test/root");
    expect(ROOT).toBe("/custom/test/root");
  } finally {
    setRoot(originalRoot);
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "cfp-null-build-"));
  const stats = await buildAll(null, null, tmpDir, new Date("2026-08-09T00:00:00Z"), {
    noEmbeddings: true,
  });

  expect(stats.conferences).toBe(0);
  expect(stats.editions).toBe(0);
  expect(stats.deadlines).toBe(0);
  expect(existsSync(join(tmpDir, "data.json"))).toBe(true);
  expect(existsSync(join(tmpDir, "data.csv"))).toBe(true);
  /* 収録が 0 件のときのカレンダーは、空でも形式として成立していること（購読する側は
     ファイルの在無で壊れたか分からない）。ただし**イベントを 1 件も作らない**こと –
     何もない状態から締切を作らない（第 266 回で `.ics` が出たので、見張りの意味を移す）。 */
  expect(readdirSync(tmpDir).some((name) => name.endsWith(".ics"))).toBe(true);
  const emptyIcs = readFileSync(join(tmpDir, "deadlines.ics"), "utf8");
  expect(emptyIcs).toContain("BEGIN:VCALENDAR");
  expect(emptyIcs).toContain("END:VCALENDAR");
  expect(emptyIcs).not.toContain("BEGIN:VEVENT");
});

it("parseCliArgs and cliMain handle null/undefined and direct arguments (#340)", async () => {
  expect(parseCliArgs(null)).toEqual({});
  expect(parseCliArgs(undefined)).toEqual({});

  const directHelp = await cliMain(["help"]);
  expect(directHelp).toBe(0);

  const directFlag = await cliMain(["--help"]);
  expect(directFlag).toBe(0);

  const nullCode = await cliMain(null);
  expect(nullCode).toBe(2);
});

it("buildAll, toJson, and toUpcomingMd handle null/undefined now and invalid upcoming_days safely (#354)", async () => {
  const jsonNull = toJson([], {}, null);
  expect(typeof jsonNull.generated_at).toBe("string");

  const mdNull = toUpcomingMd([], null);
  expect(mdNull).toContain("該当なし");

  const mdCustomNegative = toUpcomingMd([], null, -10 as any);
  expect(mdCustomNegative).toContain("直近 180 日の締切と開催");

  const tmpDir = mkdtempSync(join(tmpdir(), "build-now-test-"));
  try {
    const stats = await buildAll([], { site: { upcoming_days: -50 } }, tmpDir, null, {
      noEmbeddings: true,
    });
    expect(stats.conferences).toBe(0);
    expect(stats.deadlines).toBe(0);
    expect(existsSync(join(tmpDir, "data.json"))).toBe(true);
    expect(existsSync(join(tmpDir, "upcoming.md"))).toBe(true);
    const md = readFileSync(join(tmpDir, "upcoming.md"), "utf8");
    expect(md).toContain("直近 180 日の締切と開催");
  } finally {
    // cleanup
  }
});

it("profileTexts and embeddingsMain handle non-array tags/categories safely (#358)", async () => {
  const res = profileTexts([
    {
      key: "test-conf",
      title: "TestConf",
      full_name: "International Test Conference",
      categories: "systems" as any,
      tags: "niche" as any,
    },
  ]);
  expect(res.keys).toEqual(["test-conf"]);
  expect(res.texts[0]).toContain("systems");
  expect(res.texts[0]).not.toContain("niche");

  const nullCode = await embeddingsMain(null);
  expect(nullCode).toBe(2);

  const helpCode = await embeddingsMain(["--help"]);
  expect(helpCode).toBe(0);

  expect(await embeddingsMain(["-h"])).toBe(0);
});

describe("jsonCompact and legacy_key_redirects fixes (#746)", () => {
  it("jsonCompact omits undefined properties and converts undefined in arrays to null", () => {
    // Undefined in object should be omitted, not turned into {}
    expect(jsonCompact({ a: 1, b: undefined, c: "test" })).toBe('{"a": 1, "c": "test"}');

    // Deep undefined should also be omitted
    expect(jsonCompact({ outer: { inner: undefined, valid: true } })).toBe(
      '{"outer": {"valid": true}}',
    );

    // Undefined in arrays becomes null
    expect(jsonCompact([1, undefined, "three"])).toBe('[1, null, "three"]');

    // Top-level null / undefined
    expect(jsonCompact(null)).toBe("null");
    expect(jsonCompact(undefined)).toBe("null");

    // Primitives
    expect(jsonCompact(42)).toBe("42");
    expect(jsonCompact(true)).toBe("true");
    expect(jsonCompact("hello")).toBe('"hello"');
  });

  it("toJson sorts legacy_key_redirects deterministically", () => {
    const confs = [
      {
        key: "beta",
        title: "Beta Conf",
        categories: ["systems"],
        tags: [],
        sources: [],
        rank: {},
        legacy_keys: ["z-legacy", "a-legacy"],
        editions: [],
      },
      {
        key: "alpha",
        title: "Alpha Conf",
        categories: ["systems"],
        tags: [],
        sources: [],
        rank: {},
        legacy_keys: ["m-legacy"],
        editions: [],
      },
    ] as any;
    const data = toJson(confs, {}, new Date("2026-08-09T00:00:00Z"));
    const redirects = (data.legacy_key_redirects ?? {}) as Record<string, string>;
    const keys = Object.keys(redirects);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual(["a-legacy", "m-legacy", "z-legacy"]);
  });

  it("toJson deterministically sorts deadlines by track when round, time, kind, and label match (#748)", () => {
    const conf = makeConference({
      key: "track-conf",
      title: "Track Conf",
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "track-conf26",
          deadlines: [
            {
              ...makeDeadline("paper", "Deadline", new Date("2026-09-01T12:00:00Z"), "AoE", 1),
              track: "research",
            },
            {
              ...makeDeadline("paper", "Deadline", new Date("2026-09-01T12:00:00Z"), "AoE", 1),
              track: "industry",
            },
            {
              ...makeDeadline("paper", "Deadline", new Date("2026-09-01T12:00:00Z"), "AoE", 1),
              track: "artifacts",
            },
          ],
        }),
      ],
    });
    const data = toJson([conf], {}, new Date("2026-08-09T00:00:00Z"));
    const deadlines = (data.conferences as any[])[0].editions[0].deadlines;
    expect(deadlines.map((dl: any) => dl.track)).toEqual(["artifacts", "industry", "research"]);
  });

  it("sortKey orders date-only deadlines on their calendar day rather than previous day (#750)", async () => {
    const confExactPrior = makeConference({
      key: "exact-prior",
      title: "Exact Prior",
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "prior26",
          deadlines: [
            makeDeadline("paper", "Prior Deadline", new Date("2026-09-01T20:00:00Z"), "UTC", 1),
          ],
        }),
      ],
    });
    const confDateOnly = makeConference({
      key: "date-only-conf",
      title: "Date Only Conf",
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "dateonly26",
          deadlines: [
            {
              kind: "paper",
              label: "Date Only Deadline",
              round: 1,
              precision: "date-only",
              local_date: "2026-09-02",
              comment: null,
            },
          ],
        }),
      ],
    });
    const dir = mkdtempSync(join(tmpdir(), "kamiyobi-sortkey-"));
    await buildAll([confDateOnly, confExactPrior], {}, dir, new Date("2026-08-09T00:00:00Z"));
    const upcoming = readFileSync(join(dir, "upcoming.md"), "utf8");
    const priorIdx = upcoming.indexOf("Exact Prior");
    const dateOnlyIdx = upcoming.indexOf("Date Only Conf");
    expect(priorIdx).toBeGreaterThanOrEqual(0);
    expect(dateOnlyIdx).toBeGreaterThanOrEqual(0);
    expect(priorIdx).toBeLessThan(dateOnlyIdx);
    rmSync(dir, { recursive: true, force: true });
  });
});

it("the empty state offers the next schedule-only meeting (SPEC §7)", () => {
  // 締切が未定の会は締切一覧の表に載らない。だから「検索語は合っているのに 0 件」で
  // 終わらせず、次回会期をその場で案内する。マークアップと呼び出しの両方を見る
  // （どちらか一方だけ直して案内が消える事故を防ぐ）。
  const html = readFileSync(join(site, "index.html"), "utf8");
  expect(html).toContain('id="emptyMeeting"');
  const app = siteRuntime("app.js");
  expect(app).toContain("Recommender.scheduleOnlyEditions");
  expect(app).toContain("会期だけ確定している次回");
  expect(app).toContain("締切が未定の会は表に載せません");
  // 実データで実際に効いていること（0 件なら検査が空回りする）。
  const editions = Recommender.scheduleOnlyEditions(data);
  expect(editions.length).toBeGreaterThan(0);
  expect(editions.some((e) => e.tags.indexOf("domestic-jp") >= 0)).toBe(true);
  // 案内に混ぜるのは「締切を持たない版」だけ。会議ごとに件数が一致するかで見る。
  type EditionShape = { deadlines?: unknown[]; event_start?: string };
  for (const conf of (data.conferences || []) as Array<{
    key: string;
    editions?: EditionShape[];
  }>) {
    const expected = (conf.editions || []).filter(
      (ed) =>
        !(ed.deadlines || []).length && /^\d{4}-\d{2}-\d{2}$/.test(String(ed.event_start || "")),
    ).length;
    const got = Recommender.scheduleOnlyEditions({ conferences: [conf] }).length;
    expect(got, `${conf.key}: 締切の無い版と案内対象の件数が合わない`).toBe(expected);
  }
});

it("the next-meeting note formats the schedule-only edition for a Japanese reader (SPEC §7)", () => {
  // 文言の一致だけだと「実は出ていない」を防げないので、ビルド後の app.js の関数を
  // そのまま実行して表示文言を検査する。Recommender は書き写さず、同じビルドで
  // 生成された recommender.js を読み込む（正本とズレたスタブで通す検査にしない）。
  const runtime = compileSiteRuntime();
  if (!runtime) throw new Error("site runtime is not compiled");
  const dir = mkdtempSync(join(tmpdir(), "cfp-note-"));
  const recPath = join(dir, "recommender.mjs");
  writeFileSync(recPath, runtime["recommender.js"]);
  const script = [
    // 間接 eval でグローバルに置く（`new Function` の中身はグローバルスコープで解決されるため、
    // async IIFE の中の変数は見えない）。
    // `windowLimitMs` は `DAY` を読むので、同じ eval の中で一緒に定義する（グローバルに置く）。
    `(0, eval)("const DAY = 86400000; " + ${JSON.stringify(jsFunction(runtime["app.js"], "windowLimitMs"))});`,
    "(async () => {",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${recPath}`)});`,
    "const DAY = 86400000;",
    "Date.now = () => Date.UTC(2026, 8, 22, 3, 0, 0);", // 2026-09-22 12:00 JST
    "const DATA = { conferences: [{ key: 'ipsj-al', title: '情報処理学会 AL 研究会', full_name: '情報処理学会 アルゴリズム研究会 (AL)', categories: ['theory'], tags: ['domestic-jp'], link: 'https://example.invalid/al', editions: [",
    "  { id: 'ipsj-al-2026-11', date_text: '2026年11月12日-13日', event_start: '2026-11-12', event_end: '2026-11-13', place: '松江テルサ（島根県）', link: 'https://example.invalid/al', deadlines: [] },",
    "  { id: 'ipsj-al-2026-09', event_start: '2026-09-04', event_end: '2026-09-05', place: 'オンライン', deadlines: [{ kind: 'abstract', precision: 'date-only', local_date: '2026-08-01' }] }",
    "]}] };",
    "let searchQuery = Recommender.expandRelativeMonths('アルゴリズム', Date.now());",
    "const box = { hidden: true, textContent: '', appendChild(node) { if (node.textContent) this.textContent += node.textContent; } };",
    "const document = { createElement: (tag) => ({ tagName: tag, textContent: '', href: '', target: '', rel: '' }), createTextNode: (text) => ({ textContent: text }) };",
    "const $ = () => box;",
    jsFunction(siteRuntime("app.js"), "scheduleOnlyMatches"),
    jsFunction(siteRuntime("app.js"), "renderNextMeetingNote"),
    // 数え上げ（`scheduleOnlyMatches`）と文の組み立て（`renderNextMeetingNote`）を
    // 実際に繋いで動かす（画面と同じ繋ぎ方）。
    "renderNextMeetingNote(scheduleOnlyMatches({ window: '90', cats: [], domestic: true }));",
    "console.log(JSON.stringify({ hidden: box.hidden, text: box.textContent }));",
    "})().catch((e) => { console.error(e && e.stack || String(e)); process.exit(1); });",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const shown = JSON.parse(proc.stdout) as { hidden: boolean; text: string };
  expect(shown.hidden).toBe(false);
  expect(shown.text).toContain("会期だけ確定している次回:");
  // 暦日 + 曜日（時刻を付けない）/ 同じ年は年を二度書かない / 会場名を出す。
  expect(shown.text).toContain("2026-11-12(木)〜11-13(金)");
  expect(shown.text).toContain("情報処理学会 AL 研究会");
  expect(shown.text).toContain("松江テルサ（島根県）");
  expect(shown.text).toContain("締切が未定の会は表に載せません");
  expect(shown.text).not.toContain("2026-09-04");

  // 期間外（30 日先まで）なら案内しない。
  const outOfWindow = spawnSync("node", ["-e", script.replace("window: '90'", "window: '30'")], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(outOfWindow.status, outOfWindow.stderr).toBe(0);
  expect(JSON.parse(outOfWindow.stdout).hidden).toBe(true);
});

it("the drawer lists the same conference's later meetings (SPEC §7)", () => {
  const app = siteRuntime("app.js");
  expect(app).toContain("今後の会期");
  // てびき に語彙を書かないと、案内だけ増えて説明が追いつかない状態になる。
  const html = readFileSync(join(site, "index.html"), "utf8");
  const guide = html.slice(html.indexOf('id="helpPanel"'), html.indexOf("</dl>"));
  for (const word of ["会期のみ・締切未定", "upcoming.html", "今後の会期"]) {
    expect(guide, `てびき に「${word}」が無い`).toContain(word);
  }

  // ビルド後の関数をそのまま実行する（Recommender は同じビルドの正本を読み込む）。
  const runtime = compileSiteRuntime();
  if (!runtime) throw new Error("site runtime is not compiled");
  const dir = mkdtempSync(join(tmpdir(), "cfp-later-"));
  const recPath = join(dir, "recommender.mjs");
  writeFileSync(recPath, runtime["recommender.js"]);
  const script = [
    "(async () => {",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${recPath}`)});`,
    "const conf = { key: 'ipsj-hpc', editions: [",
    "  { event_start: '2026-08-06', event_end: '2026-08-07', place: '名古屋大学' },",
    "  { event_start: '2026-09-28', event_end: '2026-09-29', place: '名古屋大学' },",
    "  { event_start: '2026-12-01', event_end: '2026-12-02', place: '沖縄産業支援センター（沖縄県）' },",
    "  { event_start: '2027-03-07', event_end: '2027-03-08', place: '' },",
    "  { event_start: '2027-06-01', event_end: '2027-06-02', place: '将来分' },",
    "] };",
    "const now = Date.UTC(2026, 8, 22, 3, 0, 0);", // 2026-09-22 12:00 JST
    // 会期の書き方は recommender.js の正本をそのまま使う（第 220 回にそこへ移した）。
    "const later = Recommender.upcomingEditionsOf(conf, '2026-09-28', now);",
    "console.log(JSON.stringify({",
    "  sameYear: Recommender.meetingRangeJa('2026-12-01', '2026-12-02'),",
    "  crossYear: Recommender.meetingRangeJa('2026-12-30', '2027-01-02'),",
    "  oneDay: Recommender.meetingRangeJa('2026-12-01', '2026-12-01'),",
    "  later: later.map((e) => Recommender.laterEditionLineJa(e)),",
    "  capped: later.length,",
    "}));",
    "})().catch((e) => { console.error(e && e.stack || String(e)); process.exit(1); });",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    sameYear: string;
    crossYear: string;
    oneDay: string;
    later: string[];
    capped: number;
  };
  // 同じ年は年を二度書かない / 年を跨いだら年を落とさない / 1 日会期に〜を付けない。
  expect(out.sameYear).toBe("2026-12-01(火)〜12-02(水)");
  expect(out.crossYear).toBe("2026-12-30(水)〜2027-01-02(土)");
  expect(out.oneDay).toBe("2026-12-01(火)");
  // 過ぎた回と、今見ている回は出さない。最大 3 件。
  expect(out.capped).toBe(3);
  expect(out.later[0]).toContain("2026-12-01(火)〜12-02(水) ＠沖縄産業支援センター（沖縄県）");
  expect(out.later.join(" / ")).not.toContain("2026-09-28");
  expect(out.later.join(" / ")).not.toContain("2026-08-06");
});

it("every kind label shown in upcoming.md is searchable (SPEC §7)", () => {
  const build = readFileSync(new URL("../src/build.ts", import.meta.url), "utf8");
  const app = siteRuntime("app.js");
  // 表記を二重実装させない（表示語で検索できない、という事故の根本原因）。
  expect(build).toContain("Recommender.kindLabelTable()");
  expect(app).toContain("Recommender.kindLabelTable()");

  const md = readFileSync(join(site, "upcoming.md"), "utf8");
  const kinds = new Set<string>();
  for (const line of md.split("\n")) {
    if (!line.startsWith("| ") || /^\|-/.test(line)) continue;
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    if (cells.length < 7 || cells[0] === "日付" || cells[3] === "開催") continue;
    kinds.add(cells[3]);
  }
  // md に種別語が実際に載っていること（0 件なら検査が空回りする）。
  expect(kinds.size).toBeGreaterThan(1);
  const rows = Recommender.candidateRows(data);
  for (const label of kinds) {
    expect(
      rows.some((r) => Recommender.hayMatches(r.hay, label)),
      `upcoming.md の種別「${label}」が検索で引けない`,
    ).toBe(true);
  }
});

it("the per-query matcher agrees with hayMatches and is not rebuilt per row (SPEC §7)", () => {
  const queries = [
    "ネットワーク",
    "国内 オンライン",
    "論文締切",
    "ネットワークセキュリティ",
    "きゅうしゅう",
    "九州",
    "来月 国内",
    "ＮＳＤＩ",
    "12月",
    "",
  ];
  const rows = Recommender.candidateRows(data);
  expect(rows.length).toBeGreaterThan(100);
  for (const q of queries) {
    const matcher = Recommender.searchMatcher(q);
    const viaMatcher = rows.filter((r) => matcher(r.hay)).length;
    const viaHay = rows.filter((r) => Recommender.hayMatches(r.hay, q)).length;
    expect(viaMatcher, `「${q}」で searchMatcher と hayMatches がズレた`).toBe(viaHay);
  }

  // 行ごとに語を分解し直していないことの保険（形そのものは上のドリフトガードで見る）。
  // 実測は新形が約 50 ms、行ごとに分解する古い形が約 500 ms / 20,000 行なので、
  // 壊れてもすぐには落ちない緩さで、桁違いの退化だけつかまえる。
  const many = Array.from({ length: 20_000 }, (_, i) => rows[i % rows.length]);
  const started = Date.now();
  const matcher = Recommender.searchMatcher("ネットワーク");
  const hits = many.filter((r) => matcher(r.hay)).length;
  const elapsed = Date.now() - started;
  expect(hits).toBeGreaterThan(0);
  expect(elapsed, `20,000 行の照合が ${elapsed} ms（行ごとに分解し直していないか？）`).toBeLessThan(
    1_500,
  );
});

it("the online-participation filter keeps only venues that say so (SPEC §7)", () => {
  const html = siteHtmlRuntime();
  const filterSrc = jsFunction(html, "filter");
  const template = readFileSync(join(site, "index.html"), "utf8");
  // 入口（チェックボックス・ショートカット・てびき）が画面から消えないようにする。
  expect(template).toContain('<input type="checkbox" id="online">');
  expect(template).toContain('data-preset="online" onclick="applyPreset(\'online\')"');
  const guide = template.slice(template.indexOf('id="helpPanel"'), template.indexOf("</dl>"));
  expect(guide).toContain("オンライン参加可");
  expect(guide).toContain("対面とは判定しません");
  const app = siteRuntime("app.js");
  // 絞り込みは recommender の判定を呼ぶ（UI 側に表記の規則を写さない）。
  expect(app).toContain("Recommender.placeOffersOnline(r.ed.place)");
  // 共有できる状態にする（「オンライン参加可で国内」のような見方を貼り付けられる）。
  expect(app).toContain('p.set("online", "1");');
  expect(app).toContain('p.get("online")');
  expect(app).toContain("state.online = onlineFlag.on;");

  const script = [
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    "const document = {};",
    "function $(id) { return null; }",
    "const window = {};",
    "function row(key, place) {",
    "  return { kind: 'paper', est: false, cats: ['hpc'], rankPairs: ['B'], hay: key, tags: [],",
    "    t: now + 86400000, tLast: now + 86400000, ed: { place, deadlines: [] }, conf: { key } };",
    "}",
    "const rows = [",
    "  row('hybrid', '和歌山ビッグ愛（和歌山県）／オンライン'),",
    "  row('inperson', '京都大学 楽友会館（京都府）'),",
    "  row('venue-name', 'San Francisco Bay, USA and KSIR Virtual Conference Center, USA'),",
    "  row('english', 'Toronto, Canada & Virtual'),",
    "];",
    "const state = { mode: 'deadlines', q: '', cats: [], kind: '', rank: '', win: 'all', est: false, domestic: false, online: true, past: false };",
    FILTER_RUNTIME_STUBS,
    "const filter = new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "  'return (' + FILTER + ')')(FakeDate, DAY, rows, state, true, 'rem');",
    "console.log(JSON.stringify({ online: filter().map((r) => r.conf.key), all: (() => { state.online = false; return filter().map((r) => r.conf.key); })() }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as { online: string[]; all: string[] };
  // 会場名に語が含まれるだけの行は残さない。
  // 同じ締切時刻の行は表に出る会議名順（`english` → `hybrid`）にぞろえる。
  expect(out.online).toEqual(["english", "hybrid"]);
  expect(out.all).toEqual(["english", "hybrid", "inperson", "venue-name"]);
});

it("the card layout actually fits a phone width (SPEC §7)", () => {
  const html = siteHtmlRuntime();
  const style = html.slice(html.indexOf("<style"), html.indexOf("</style>"));
  // スキャナの自己検証: メディアクエリ内のルールも見えていること。
  expect(effectiveCss(style, "thead", "display", 400)).toBe("none");
  expect(effectiveCss(style, "thead", "display", 1200)).not.toBe("none");

  // 狭幅ではカード化するので、デスクトップ用の最小幅は解除されないといけない。
  // 880px を残したままだとカード自体が 880px になり、1 行読むのに横スワイプが要る。
  expect(effectiveCss(style, "table", "min-width", 400)).toBe("0");
  expect(effectiveCss(style, ".tablewrap", "overflow-x", 400)).not.toBe("auto");
  // 広い画面では従来どおり（横並びの表）でないと意味が無い。
  expect(effectiveCss(style, "table", "min-width", 1200)).toBe("880px");
  /* 第 269 回まで、広い画面では `.tablewrap` が `overflow-x: auto` であることをここで
     見ていた。意図は「表が潰れない」ことだったが、列の名前をスクロール後も残すため、
     横に越えない幅では `overflow` を戻すようになった（`overflow` が有ると見出しの粘着が
     効かない）。なので、はみ出す幅で `auto` のままと見る（粘着の幅その物は
     `tests/upcoming_long_table.test.ts` が「越えない幅だけ」で見る）。 */
  expect(effectiveCss(style, ".tablewrap", "overflow-x", 900)).toBe("auto");
});

it("category chips count the rows that pass the other filters (SPEC §7)", () => {
  const html = siteHtmlRuntime();
  const filterSrc = jsFunction(html, "filter");
  const countsSrc = jsFunction(html, "categoryCounts");
  const updateSrc = jsFunction(html, "updateCategoryCounts");
  const template = readFileSync(join(site, "index.html"), "utf8");
  // 件数を出す場所（チップごとに span を 1 つずつ増やす）と、0 を消さないための
  // スタイルが無くなっていないこと。
  const app = siteRuntime("app.js");
  expect(app).toContain('"chip-count"');
  expect(app).toContain("updateCategoryCounts();");
  expect(template).toContain(".chips .chip-count.zero");

  const script = [
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    "const document = {};",
    "function $(id) { return null; }",
    "const window = {};",
    "function row(key, cats, domestic) {",
    "  return { kind: 'paper', est: false, cats, rankPairs: ['B'], hay: key,",
    "    tags: domestic ? ['domestic-jp'] : [], t: now + 86400000, tLast: now + 86400000,",
    "    ed: { place: '京都', deadlines: [] }, conf: { key } };",
    "}",
    "const rows = [",
    "  row('a', ['hpc'], true),",
    "  row('b', ['hpc', 'db'], false),",
    "  row('c', ['security'], true),",
    "];",
    countsSrc,
    updateSrc,
    "const nodes = {};",
    "const mkNode = () => ({ textContent: '', cls: new Set(), classList: {",
    "  toggle(name, on) { if (on) this.owner.cls.add(name); else this.owner.cls.delete(name); },",
    "}, });",
    "for (const key of ['hpc', 'db', 'security', 'ai']) {",
    "  const node = mkNode();",
    "  node.classList.owner = node;",
    "  nodes[key] = node;",
    "}",
    "const state = { mode: 'deadlines', q: '', cats: ['hpc'], kind: '', rank: '', win: 'all', est: false, domestic: true, online: false, past: false };",
    FILTER_RUNTIME_STUBS,
    "const filter = new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "  'return (' + FILTER + ')')(FakeDate, DAY, rows, state, true, 'rem');",
    "const shownKeys = filter().map((r) => r.conf.key);",
    // 選んだ分野 (hpc) で自分の選択肢を潰さない: hpc の件数は選んだ後も 1（国内を通る行）。
    "const counts = categoryCounts();",
    // chip への反映（0 は消さず zero クラスで薄くする）。
    "catFacetCounts = { hpc: 1, db: 0 };",
    "const catCountNodes = nodes;",
    "updateCategoryCounts();",
    "console.log(JSON.stringify({",
    "  shownKeys,",
    "  counts,",
    "  hpcText: nodes.hpc.textContent,",
    "  dbText: nodes.db.textContent,",
    "  dbZero: nodes.db.cls.has('zero'),",
    "  hpcZero: nodes.hpc.cls.has('zero'),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    shownKeys: string[];
    counts: Record<string, number>;
    hpcText: string;
    dbText: string;
    dbZero: boolean;
    hpcZero: boolean;
  };
  // 表は hpc かつ国内の行だけ。
  expect(out.shownKeys).toEqual(["a"]);
  // 件数は分野の絞り込みを見る前で数える: hpc=1（a）, db=0（b は国内で落ちる）, security=1（c）。
  expect(out.counts).toEqual({ hpc: 1, security: 1 });
  // 0 の分野は消さず、薄く出す。
  expect(out.hpcText).toBe("1");
  expect(out.dbText).toBe("0");
  expect(out.dbZero).toBe(true);
  expect(out.hpcZero).toBe(false);
});

it("説明文に開発用語を残さない（SPEC §7）", () => {
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const runtime = siteRuntime("app.js");
  // サイトのビルドはコメントを残すので、コメントではなく**画面へ出る文字列**だけを見る。
  // recommender.js もドロワー等の文言を出すので同じ検査に通す。
  const literals = [
    ...japaneseStringLiterals(runtime),
    ...japaneseStringLiterals(siteRuntime("recommender.js")),
    ...Array.from(template.matchAll(/>([^<>{}]*[\u3040-\u30ff\u4e00-\u9fff][^<>{}]*)</g)).map(
      (m) => m[1] as string,
    ),
    ...Array.from(
      template.matchAll(
        /(?:placeholder|title|aria-label)="([^"]*[\u3040-\u30ff\u4e00-\u9fff][^"]*)"/g,
      ),
    ).map((m) => m[1] as string),
  ];
  expect(literals.length).toBeGreaterThan(80);
  // 出す方を直したら、置き換えた語が本当に画面へ出る文字列に残っていることも見る
  // （禁止語だけ増やして、実際には消えていない/逆に出ていない、を検査できないため）。
  const recSrc = siteRuntime("recommender.js");
  const _runtimeOnly = [...japaneseStringLiterals(runtime), ...japaneseStringLiterals(recSrc)];
  for (const phrase of [
    "今回あたって確認",
    "確定済みの収録データ（今回は上流にあたらず）",
    "その会議の論文サンプル",
  ]) {
    // 抽出器は正規表現リテラルの中の引用符でずれることがあるので、在る方を見る
    // 検査は生の成果物テキストで見る（無い方を禁止語で見るのは上のとおり）。
    expect(
      [runtime, recSrc].some((src) => src.includes(phrase)),
      `置き換えた推薦カードの語 ${phrase} がビルド成果物に見当たらない`,
    ).toBe(true);
  }
  // 実装側の語をそのまま出さない。画面では 分野 / 主題 / 絞り込み / 言葉の一致 を使う。
  // `カテゴリ` `カテゴリー` `フィルタ` は下の `inputAliasOnly` に分けた（打たれた語としてだけ
  // 受け入れ、説明文には出さない – 第 248 回）。
  const banned = [
    // 推薦カードから出した語（第 84 回）。`キャッシュ退避` 等は実装側の言い方。
    "退避",
    "観測年数",
    "プロフィール",
    "シグナル",
    "トピック",
    "領域タグ",
    "ブースト",
    "RRF",
    "閾値",
    "埋め込み",
    "語彙スコア",
    "デッドライン",
  ];
  for (const word of banned) {
    const hits = literals.filter((text) => text.includes(word));
    expect(hits, `画面に出る文言に「${word}」が残っている`).toEqual([]);
  }
  /* 打たれた語としてだけ受け入れる実装側の語（第 248 回）。`カテゴリ` `カテゴリー` `フィルタ` は
   * 利用者が実際に打つ語なので、検索語の別名（`UI_WORD_GROUPS_JA`）として受け入れる
   * （第 244 回ではこの検査に当たるため別名に載せられず、これらの語を打った人は 0 件と
   * 何も書かれていない案内だけを受け取っていた – 2026-08-09 生成ビルドで実測）。
   * ただし画面の説明文・てびき・ビルド済みの HTML には出さない。説明文に出ないことは
   * `tests/search_words.test.ts` が案内文そのもので見る（ここでは静的な出ない方を見る）。 */
  const inputAliasOnly = ["カテゴリ", "カテゴリー", "フィルタ"];
  // ビルド済み HTML の画面に出る部分だけ見る（<script> の中はコードなので除外する）。
  const builtHtml = readFileSync(join(site, "index.html"), "utf8").replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  for (const word of inputAliasOnly) {
    expect(template.includes(word), `てびきに「${word}」が出ている`).toBe(false);
    expect(builtHtml.includes(word), `ビルド済みの HTML に「${word}」が出ている`).toBe(false);
  }
});

it("unknown 会期・開催地・ランクを「未確認」として出す（SPEC §7）", () => {
  const app = siteRuntime("app.js");
  const dir = mkdtempSync(join(tmpdir(), "cfp-unknown-"));
  const recPath = join(dir, "recommender.mjs");
  writeFileSync(recPath, siteRuntime("recommender.js"));
  const script = [
    "(async () => {",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${recPath}`)});`,
    "const mkEl = (tag) => ({ tagName: tag, children: [], childNodes: [], textContent: '',",
    "  className: '', title: '', href: '', target: '', rel: '', tabIndex: 0, style: {},",
    "  hidden: false, colSpan: 0, attrs: {},",
    "  appendChild(n) { this.children.push(n); this.childNodes.push(n); return n; },",
    "  setAttribute(k, v) { this.attrs[k] = v; },",
    "  addEventListener() {}, querySelectorAll() { return []; },",
    "  contains(n) { if (n === this) return true; return this.children.some((c) => c && c.contains && c.contains(n)); },",
    "  classList: { contains: () => false, toggle() {}, add() {}, remove() {} } });",
    // tr.onclick は event.target を HTMLElement で絞るので、見立てにも同じ判定を通す。
    "class FakeElement {}",
    "const mkClick = (n) => ({ target: Object.assign(Object.create(FakeElement.prototype), n) });",
    "const document = { createElement: mkEl, createTextNode: (t) => ({ textContent: t }) };",
    "globalThis.HTMLElement = FakeElement;",
    "const KIND_LABEL = { paper: '論文締切', abstract: '概要締切', journal: '常時受付' };",
    "const now = Date.UTC(2026, 7, 10);",
    "const fmtJst = () => 'JST';",
    "const fmtDate = () => 'DATE';",
    "const fmtAoE = () => 'AoE';",
    "const officialZone = () => 'JST';",
    "const catLabel = (k) => k;",
    // `titleWithYear` はスタブにせず正本を使う（並び順と同じ語をセルが組むことを見るため）。
    "const verificationTag = () => null;",
    "const verificationAlert = () => '';",
    "const toggleDetail = () => {};",
    "const opened = [];",
    "const openDrawer = (r) => { opened.push(r.conf.key); };",
    "const esc = (s) => String(s == null ? '' : s);",
    "const safeExternalUrl = (u) => u;",
    "const $ = () => null;",
    "const window = { getSelection: () => selection };",
    "let selection = { isCollapsed: true, toString: () => '', anchorNode: null };",
    jsFunction(app, "td"),
    jsFunction(app, "line"),
    // 定数も正本から写す（文言の正典をテスト側に二重化しない）。
    app.match(/const UNCONFIRMED_JA = [^\n]*;/)?.[0] ?? "",
    app.match(/const UNCONFIRMED_TITLES_JA = \{[\s\S]*?\};/)?.[0] ?? "",
    /* 「未確認」「該当なし」「評価なし」の理由の語も正本から（表のセルの注記と行の詳細の
     * 本文が同じ入口を見るようにした – 第 236 回）。塊ごと写すので、語も条件も二重化しない。 */
    app.match(/const RANK_UNRATED_JA = [^\n]*;/)?.[0] ?? "",
    app.match(/const RANK_UNRATED_TITLE_JA = [^\n]*;/)?.[0] ?? "",
    app.match(/const fieldReasonsJa = \{[\s\S]*?\n {4}\};/)?.[0] ?? "",
    // 経過状態の判定は純粋なので正本から取る（書かない）。
    jsFunction(app, "rowDateOnlyState"),
    jsFunction(app, "rowIsPast"),
    jsFunction(app, "rowIsFuture"),
    // 「あと N 日」も正本から（ダミー値で通す検査にしない）。
    jsFunction(app, "remain"),
    "const DAY = 86400000;",
    ...SORT_CANON.fns,
    jsFunction(app, "kindDetailJa"),
    jsFunction(app, "makeRow"),
    "const flat = (n) => (n.textContent || '') + n.children.map((c) => '|' + flat(c)).join('');",
    "const titles = (n, out = []) => { if (n.title) out.push(n.title); n.children.forEach((c) => titles(c, out)); return out; };",
    "const cells = (n, out = {}) => {",
    "  if (n.attrs && n.attrs['data-label']) out[n.attrs['data-label']] = flat(n);",
    "  n.children.forEach((c) => cells(c, out));",
    "  return out;",
    "};",
    // 一致評価のチップ（行内展開のトリガ）も同じハーネスで見る（行の中に有る物なので）。
    "const mk = (place, eventStart, label) => ({ kind: 'paper', est: false, cats: ['hpc'], rankPairs: [], _matchScore: 40, _fitLabel: 'B',",
    "  hay: 'x', tags: ['domestic-jp'], t: Date.UTC(2026, 8, 1), tLast: Date.UTC(2026, 8, 1),",
    "  dateOnly: false, ed: { place, event_start: eventStart, event_end: eventStart, deadlines: [], date_text: '' },",
    "  dl: { kind: 'paper', label: label || '' }, conf: { key: 'k', title: '研究会', link: '' } });",
    "const empty = makeRow(mk('', null));",
    "const known = makeRow(mk('Kyoto, Japan', '2026-11-12'));",
    // 上流の締切名に Extended と付いていた行（延長の事実はここにしか情報がない）。
    "const extended = makeRow(mk('Kyoto, Japan', '2026-11-12', 'Paper submission (Extended)'));",
    // 行クリックと文字選択の relations（第 149 回: 選んだ離すでもドロワーが開いていた）。
    "const selLog = [];",
    "selection = { isCollapsed: true, toString: () => '', anchorNode: null };",
    "known.onclick(mkClick(known));",
    "selLog.push(opened.length);",
    "const cellInside = known.children[0];",
    "selection = { isCollapsed: false, toString: () => '研究会', anchorNode: cellInside };",
    "known.onclick(mkClick(known));",
    "selLog.push(opened.length);",
    // 1 文字も含まないドラッグ（空いた場所をクリックしただけ）では開いてよい。
    "selection = { isCollapsed: false, toString: () => '   ', anchorNode: cellInside };",
    "known.onclick(mkClick(known));",
    "selLog.push(opened.length);",
    // 他所に残った選択を理由に、いま押した行を開かないのは別の不親切。
    "selection = { isCollapsed: false, toString: () => '研究会', anchorNode: { marker: 'elsewhere' } };",
    "known.onclick(mkClick(known));",
    "selLog.push(opened.length);",
    "const findByClass = (n, cls, out = []) => {",
    "  if (n.className && String(n.className).split(' ').includes(cls)) out.push(n);",
    "  (n.children || []).forEach((c) => findByClass(c, cls, out));",
    "  return out;",
    "};",
    "const trig = findByClass(known, 'match-trigger')[0] || null;",
    "console.log(JSON.stringify({",
    "  emptyCells: cells(empty), emptyTitles: titles(empty),",
    "  knownCells: cells(known), knownTitles: titles(known),",
    "  extendedCells: cells(extended), extendedWord: Recommender.extendedLabelJa(),",
    "  selLog,",
    "  trigger: trig && { tag: trig.tagName, type: trig.type, attrs: trig.attrs, cls: trig.className },",
    "}));",
    "})().catch((e) => { console.error(e && e.stack || String(e)); process.exit(1); });",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    emptyCells: Record<string, string>;
    emptyTitles: string[];
    knownCells: Record<string, string>;
    knownTitles: string[];
    extendedCells: Record<string, string>;
    extendedWord: string;
    selLog: number[];
    trigger: { tag: string; type: string; attrs: Record<string, string>; cls: string } | null;
  };
  // 空の値は「-」ではなく、確認できていないことを短い語で出す。
  expect(out.emptyCells.会期).toContain("未確認");
  expect(out.emptyCells.開催地).toContain("未確認");
  expect(out.emptyCells.ランク).toContain("未確認");
  // 一致評価のチップ（行内展開のトリガ）: `<span>` + `onclick` だとキーボードで開けなかった
  // （Tab で届かず、行の Enter はドロワーを開く。2026-09-23 実測: ビルド成果物に
  // `aria-expanded` は 1 箇所も無く、トリガは span）。ボタンにして開閉状態を出す。
  expect(out.trigger, "一致評価のチップが行に出ていない（検査が空振り）").not.toBeNull();
  // 偽 DOM は tagName を渡したまま入れるので、大文字小文字は正規化して見る（実 DOM は "BUTTON"）。
  expect(out.trigger?.tag.toLowerCase()).toBe("button");
  expect(out.trigger?.type, "タイプ未指定だとブラウザは提出ボタンにする").toBe("button");
  expect(out.trigger?.attrs["aria-expanded"], "初期の開閉状態が支援技術に伝わらない").toBe("false");
  // 行のクリック側がこの語でトリガを判別しているので、崩れたら開閉が壊れる。
  expect(out.trigger?.cls).toContain("match-trigger");
  expect(out.emptyTitles.join(" ")).toContain("CCF・CORE");
  // 会議が決めていないこととは別の話なので、「未定」にしない。
  expect(JSON.stringify(out.emptyCells)).not.toContain("未定");
  // 値がある行は従来どおり（会期は ISO + 曜日、開催地は日本語化し、原表記は title に残す）。
  expect(out.knownCells.会期).toContain("2026-11-12(木)");
  expect(out.knownCells.開催地).toContain("日本");
  expect(out.knownTitles.join(" ")).toContain("Kyoto, Japan");
  /* 締切が延びていたことは、一覧に出さないと分からない（2026-09-23 実測: 上流の締切名に
   * "Extended" と付く行が画面では他の行と区別が無く、検索も英語でしか引けなかった）。
   * 語は recommender の正本から取り、てびきの語と揃える（テスト側に書き写さない）。 */
  expect(out.extendedWord).not.toBe("");
  // 選択が無い行クリックは開く / 行内を選択した離すは開かない / 空のドラッグは開く /
  // 他所の選択は邪魔しない。
  expect(out.selLog, "文字選択とドロワーの開閉が噛み合っていない").toEqual([1, 1, 2, 3]);
  expect(out.extendedCells.会議, "延長していた行に一覧で目印が出ていない").toContain(
    out.extendedWord,
  );
  expect(out.knownCells.会議, "延長していない行まで目印を出している").not.toContain(
    out.extendedWord,
  );
  /* 収録元の締切名は、印を付けずに種別欄へ並べると画面の種別と並ぶ別の分類に見えていた
   * （第 146 回）。表のセルが「原表記: …」の形で描けることを、makeRow の実際の出力で見る。*/
  expect(
    out.extendedCells.種別,
    "収録元の締切名が、何の値か分からない形で種別欄に出ている",
  ).toContain("原表記: Paper submission (Extended)");
  expect(out.emptyCells.種別 ?? "", "原表記の無い行に語だけが出ている").not.toContain("原表記");
  const guideText = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  expect(guideText, "てびきが延長の語を説明していない").toContain(`<dt>${out.extendedWord}</dt>`);
  // ドロワーも同じ語を使う（表とドロワーで言い方が割れないようにする）。
  // 常時受付の行は「未確認」ではなく「該当なし」を出すので、式ごと見る（SPEC §7）。
  expect(app).toContain("placeNa ? NOT_APPLICABLE_JA : UNCONFIRMED_JA");
  expect(
    (app.match(/fieldNotApplicableJa\(r\) \? NOT_APPLICABLE_JA : UNCONFIRMED_JA/g) || []).length,
    "ドロワーの開催地・会期が「該当なし」を区別していない",
  ).toBe(2);
});

it("「未確認」と出した行はそのまま検索できる（SPEC §7）", () => {
  const app = siteRuntime("app.js");
  const build = readFileSync(new URL("../src/build.ts", import.meta.url), "utf8");
  // 語を二重実装させない。表示も検索も md も recommender の正本から取る。
  expect(app).toContain("Recommender.unconfirmedLabelJa()");
  expect(build).toContain("Recommender.unconfirmedLabelJa()");

  const rows = Recommender.candidateRows(data);
  const word = Recommender.unconfirmedLabelJa();
  expect(word).toBe("未確認");
  // 表のセルの作り方と同じ条件（会期は event_start、開催地は place、ランクは rankPairs）。
  const gapOf = (r: (typeof rows)[number]): string[] => {
    const gaps: string[] = [];
    if (!String(r.ed.event_start || "").trim()) gaps.push("会期");
    if (!String(r.ed.place || "").trim()) gaps.push("開催地");
    if (!r.rankPairs.length) gaps.push("ランク");
    return gaps;
  };
  const shownSet = new Set(
    rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => gapOf(r).length > 0)
      .map(({ i }) => i),
  );
  const foundSet = new Set(
    rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => Recommender.hayMatches(r.hay, word))
      .map(({ i }) => i),
  );
  expect(shownSet.size, "検査が空回りしている").toBeGreaterThan(100);
  // 表示しているのに引けない行、引けるのに表示していない行、どちらも無いこと。
  expect([...foundSet].filter((i) => !shownSet.has(i))).toEqual([]);
  expect([...shownSet].filter((i) => !foundSet.has(i))).toEqual([]);

  // 項目名を添えても引ける（「開催地が分かっていない行だけ見たい」に応える）。
  for (const field of ["会期", "開催地", "ランク"]) {
    const expected = rows.filter((r) => gapOf(r).includes(field)).length;
    expect(expected, `${field} の欠落が実データに無い`).toBeGreaterThan(0);
    const hit = rows.filter((r) => Recommender.hayMatches(r.hay, `${field}${word}`)).length;
    expect(hit, `${field}${word} の検索件数`).toBe(expected);
  }
  // 全て揃った行を「未確認」でヒットさせない。
  const complete = rows.filter((r) => gapOf(r).length === 0);
  // 検査が空回りしない程度の下限（このビルドの収録では全て揃った行は少数）。
  expect(complete.length).toBeGreaterThan(10);
  expect(complete.filter((r) => Recommender.hayMatches(r.hay, word))).toEqual([]);
});

it("upcoming.md の開催地列に空欄を残さない（SPEC §4）", () => {
  const md = readFileSync(join(site, "upcoming.md"), "utf8");
  const word = Recommender.unconfirmedLabelJa();
  let blank = 0;
  let unconfirmed = 0;
  let counted = 0;
  for (const line of md.split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("|---")) continue;
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    if (cells.length < 7 || cells[0] === "日付") continue;
    counted += 1;
    if (!cells[6]) blank += 1;
    if (cells[6] === word) unconfirmed += 1;
  }
  expect(counted, "upcoming.md の本文を行えていない").toBeGreaterThan(100);
  expect(blank, "空欄だと収録漏れと公式未発表が区別できない").toBe(0);
  // 0 件になるようなら検査が無意味なので、実際に「未確認」が出ていることも見る。
  expect(unconfirmed).toBeGreaterThan(0);
});

it("のぞいた行数を件数欄で説明する（SPEC §7）", () => {
  const runtime = siteRuntime();
  const app = siteRuntime("app.js");
  const filterSrc = jsFunction(runtime, "filter");
  const countsSrc = jsFunction(runtime, "hiddenDeadlineCounts");
  // 件数欄に出る文言が消えていないこと。
  expect(app).toContain("のぞく: ");
  // 「スパコン」などを分野名に寄せたことも、同じ件数欄で伝える。
  expect(app).toContain("querySynonymNotes(searchQuery)");
  expect(app).toContain("hiddenDeadlineCounts()");

  const script = [
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    "const document = {};",
    "function $(id) { return null; }",
    "const window = {};",
    "function row(key, opt) {",
    "  const o = opt || {};",
    "  return { kind: o.kind || 'paper', est: o.est === true, cats: ['hpc'], rankPairs: ['B'],",
    "    hay: key, tags: [], t: o.past ? now - 86400000 : now + 86400000,",
    "    tLast: o.past ? now - 86400000 : now + 86400000,",
    "    ed: { place: '京都', deadlines: [] }, conf: { key } };",
    "}",
    "const rows = [",
    "  row('future-paper', {}),",
    "  row('past-paper', { past: true }),",
    "  row('future-paper-est', { est: true }),",
    "  row('future-abstract', { kind: 'abstract' }),",
    "  row('future-notification', { kind: 'notification' }),",
    "  // 過去かつ投稿締切以外の行は両方に立つ（内訳を足すと全件にならないことを見る）。",
    "  row('past-notification', { past: true, kind: 'notification' }),",
    "];",
    countsSrc,
    "const state = { mode: 'deadlines', q: '', cats: [], kind: '', rank: '', win: 'all', est: false, domestic: false, online: false, past: false };",
    FILTER_RUNTIME_STUBS,
    "const filter = new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "  'return (' + FILTER + ')')(FakeDate, DAY, rows, state, true, 'rem');",
    "const defaults = { shown: filter().map((r) => r.conf.key), hidden: hiddenDeadlineCounts() };",
    "state.past = true;",
    "const withPast = { shown: filter().map((r) => r.conf.key), hidden: hiddenDeadlineCounts() };",
    "console.log(JSON.stringify({ defaults, withPast }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    defaults: { shown: string[]; hidden: Record<string, number> };
    withPast: { shown: string[]; hidden: Record<string, number> };
  };
  // 既定: 過去の締切・推定・投稿締切以外の種別が落ちる。
  expect(out.defaults.shown.slice().sort()).toEqual(["future-abstract", "future-paper"]);
  // 国内チェックは入れていないので domestic は 0 のまま（件数を出すのは効いたときだけ）。
  // 国内チェックもオンライン絞り込みも入れていないので、それぞれの内訳は 0 のまま。
  expect(out.defaults.hidden).toEqual({
    past: 2,
    kind: 2,
    est: 1,
    domestic: 0,
    online: 0,
    onlinePlaceUnknown: 0,
    window: 0,
    // 評価でしぼるのは選択欄を動かしたときだけなので、既定では内訳に立たない。
    rank: 0,
    cats: 0,
    // 検索語だけでのぞいた行数（第 227 回）。この組み立ては検索語を空で回すので 0。
    query: 0,
  });
  // 「過去の締切も表示」をオンにすると過去の分はのぞかなくなる（他はそのまま）。
  expect(out.withPast.hidden.past).toBe(0);
  expect(out.withPast.hidden.kind).toBe(2);
  expect(out.withPast.shown.slice().sort()).toEqual([
    "future-abstract",
    "future-paper",
    "past-paper",
  ]);
});

it("ドロワーは表の情報（分野・ランク・ラウンド）を落とさない（SPEC §7）", () => {
  const runtime = siteRuntime();
  const dir = mkdtempSync(join(tmpdir(), "cfp-drawer-fields-"));
  const recPath = join(dir, "recommender.mjs");
  writeFileSync(recPath, siteRuntime("recommender.js"));
  const openSrc = jsFunction(runtime, "openDrawer");
  const summarySrc = jsFunction(runtime, "verificationSummary");
  const script = [
    "(async () => {",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${recPath}`)});`,
    "const body = { innerHTML: '' };",
    "const els = {",
    "  drawerBackdrop: { classList: { add() {} } }, drawerTitle: {}, drawerFullName: {},",
    "  drawerBody: body, drawerClose: { focus() {} },",
    "};",
    "const document = { activeElement: null, getElementById: (id) => els[id] || null };",
    "function $(id) { return document.getElementById(id); }",
    "const window = { _prevFocus: null };",
    "const esc = (s) => String(s ?? '');",
    "const KIND_LABEL = Recommender.kindLabelTable();",
    jsFunction(runtime, "titleWithYear"),
    jsFunction(runtime, "catLabel"),
    // 会期の書き方の正本は recommender.js に移した（一覧・行の詳細・索引が同じ 1 本。第 220 回）。
    siteRuntime("recommender.js").match(/const CALENDAR_DATE_JA = \[[^\]]*\];/)?.[0] ?? "",
    jsFunction(siteRuntime("recommender.js"), "weekdayJaFromDate"),
    'const placeJa = (v) => String(v ?? "");',
    jsFunction(siteRuntime("recommender.js"), "meetingRangeJa"),
    jsFunction(siteRuntime("recommender.js"), "upcomingEditionsOf"),
    jsFunction(siteRuntime("recommender.js"), "laterEditionLineJa"),
    `const verificationSummary = new Function('esc', 'return (' + ${JSON.stringify(summarySrc)} + ')')(esc);`,
    // 理由の語（「 kamiyobi が公式で…確認できていません」など）も正本の塊ごと注入する。
    // 表のセルの注記と行の詳細の本文が同じ式を見るようにしたので、ここで写すと壊れる。
    runtime.match(/const RANK_UNRATED_JA = [^\n]*;/)?.[0] ?? "",
    runtime.match(/const RANK_UNRATED_TITLE_JA = [^\n]*;/)?.[0] ?? "",
    runtime.match(/const UNCONFIRMED_TITLES_JA = \{[\s\S]*?\};/)?.[0] ?? "",
    runtime.match(/const NOT_APPLICABLE_JA = [^\n]*;/)?.[0] ?? "",
    runtime.match(/const fieldReasonsJa = \{[\s\S]*?\n {4}\};/)?.[0] ?? "",
    `const openDrawer = new Function('window','document','$','KIND_LABEL','titleWithYear','fmtDate','fmtJst','fmtAoE','esc','safeExternalUrl','rowDateOnlyState','verificationSummary','Recommender','catLabel','meetingRangeJa','upcomingEditionsOf','UNCONFIRMED_JA','kindDetailJa', 'writeUrl', 'fieldReasonsJa', 'return (' + ${JSON.stringify(openSrc)} + ')')(window, document, $, KIND_LABEL, titleWithYear, () => 'UTC', () => 'JST', () => 'AoE', esc, (u) => String(u ?? ''), () => null, verificationSummary, Recommender, catLabel, meetingRangeJa, upcomingEditionsOf, Recommender.unconfirmedLabelJa(), (${jsFunction(runtime, "kindDetailJa")}), () => {}, fieldReasonsJa);`,
    "openDrawer({",
    "  kind: 'paper', cats: ['hpc', 'systems'], rankPairs: ['ccf:B', 'core:A*', 'thcpl:N'],",
    "  conf: { key: 'demo', title: 'Demo', tags: ['machine-learning'] },",
    "  ed: { year: 2026, place: 'Kyoto, Japan', date_text: '2026年11月2日-4日', event_start: '2026-11-02' },",
    "  t: 0, tLast: 0,",
    "  dl: { kind: 'paper', round: 2, label: 'Poster submission' },",
    "});",
    "const withFields = body.innerHTML;",
    "body.innerHTML = '';",
    "openDrawer({",
    "  kind: 'paper', conf: { key: 'demo2', title: 'Demo 2' },",
    "  ed: { place: '未定', event_start: null }, t: 0, tLast: 0, dl: { kind: 'paper' },",
    "});",
    "const bare = body.innerHTML;",
    "console.log(JSON.stringify({ withFields, bare }));",
    "})().catch((e) => { console.error(e && e.stack || String(e)); process.exit(1); });",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as { withFields: string; bare: string };
  // 分野は日本語名（英表記だけを出さない）。
  expect(out.withFields).toContain("分野:");
  expect(out.withFields).toContain("高性能計算");
  // ラベルはサイトの正典（`systems` は「システム」と出す）。並べ語は中黒（・）で、
  // 一覧・CSV・件数欄と同じ（行の詳細だけ全角コンマだと、写して引いたときに
  // 1 語扱いで 0 件になる。2026-09-23 実測）。
  expect(out.withFields).toContain("高性能計算・システム");
  // ランクは表のセルと同じ表記。
  expect(out.withFields).toContain("ランク:");
  expect(out.withFields).toContain("CCF B");
  expect(out.withFields).toContain("CORE A*");
  // 内部トークン `N` をそのまま出さない（SPEC §2: `N` はランク無し）。
  expect(out.withFields).toContain("THCPL 評価なし");
  expect(out.withFields).not.toContain("THCPL N");
  // 第 1 ラウンド以外はそのこと自体が情報なので出す。
  expect(out.withFields).toContain("第 2 ラウンド");
  expect(out.withFields).toContain("Poster submission");
  // 分野の値が無い行は見出しだけを出さない（値の無い欄を並べない）。
  expect(out.bare).not.toContain("分野:");
  /* ランクは別の話 – 一覧のセルは同じ行に「未確認」と書くので、詳細でも同じ語を出す
   * （2026-08-09 生成ビルドで実測: 等級の組が無い行は収録 863 行中 388 行で、一覧は
   * 「未確認」と出し、行の詳細は「ランク」の行その物を落としていた。第 236 回）。 */
  expect(out.bare).toMatch(/<strong>ランク:<\/strong> 未確認<\/p>/);
  /* 理由の語は表のセルの注記（`title`）にしか無く、タッチ操作の端末と読み上げに
   * 届かなかった。行の詳細の本文に出す（語は `recommender.js` 側の正本から来る）。 */
  expect(out.bare, "ランクが未確認な理由を行の詳細が言っていない").toContain(
    "CCF・CORE の一覧でこの会議の評価が確認できていません。",
  );
  expect(out.bare).not.toContain("ラウンド");
  // 空の会期・開催地は表と同じ語で出す（表とドロワーで言い方が割れないようにする）。
  expect(out.bare).toContain("未確認");
});

it("種別セレクトに並ぶ選択肢は、選べば行が返る（SPEC §7）", () => {
  const runtime = siteRuntime();
  const app = siteRuntime("app.js");
  const filterSrc = jsFunction(runtime, "filter");
  const kindSrc = jsFunction(runtime, "selectableKind");
  // 選択肢は `SELECTABLE_KINDS`（＝ `filter()` が通す種別）から作る。
  // `KIND_LABEL` の全鍵を並べると、選んでも 0 件になる選択肢が並ぶ（実際に起きた）。
  expect(app).toContain("SELECTABLE_KINDS.forEach");
  expect(app).not.toContain("Object.keys(KIND_LABEL).forEach");
  // URL で捨てた種別は件数欄で理由を出す。
  expect(app).toContain("urlNotices");
  expect(app).toContain("upcoming.html で確認できます");

  const recPath = join(site, "recommender.js");
  const dataPath = join(site, "data.json");
  const script = [
    // 間接 eval でグローバルに置く（`new Function` の中身はグローバルスコープで解決されるため、
    // async IIFE の中の変数は見えない）。
    `(0, eval)(${JSON.stringify(jsFunction(runtime, "windowLimitMs"))});`,
    // 窓の比較（行の表示暦日）は絞り込み本体と画面上部の数が共有する（第 228 回）。
    `(0, eval)(${JSON.stringify(jsFunction(runtime, "rowShownDayMs"))});`,
    `(0, eval)(${JSON.stringify(jsFunction(runtime, "rowAfter"))});`,
    // 並び順の比較もグローバルに（`new Function` 内はグローバルで解決される）。
    // 手書きの `SELECTABLE_KINDS` は種別セレクトの正本から取る。
    `(0, eval)(${JSON.stringify(SORT_CANON_EVAL)});`,
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${recPath}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(dataPath)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const KIND_LABEL = Recommender.kindLabelTable();",
    kindSrc,
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-09T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    "const document = {};",
    "function $(id) { return null; }",
    "const window = {};",
    "globalThis.Recommender = Recommender;",
    "globalThis.activeData = DATA;",
    "globalThis.hiddenCounts = { past: 0, est: 0, kind: 0, rank: 0, cats: 0 };",
    "globalThis.catFacetCounts = {};",
    "globalThis.searchQuery = '';",
    "function run(kind) {",
    "  const state = { mode: 'deadlines', q: '', cats: [], kind: kind, rank: '', win: 'all',",
    "    est: false, domestic: false, online: false, past: false };",
    "  const runFilter = new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "    'return (' + FILTER + ')')(FakeDate, 86400000, rows, state, true, 'rem');",
    "  const out = runFilter();",
    "  const kinds = {};",
    "  out.forEach((r) => { kinds[r.kind] = (kinds[r.kind] || 0) + 1; });",
    "  return { n: out.length, kinds };",
    "}",
    "const kinds = {};",
    "rows.forEach((r) => { kinds[r.kind] = (kinds[r.kind] || 0) + 1; });",
    "console.log(JSON.stringify({",
    "  catalogKinds: kinds,",
    "  all: run(''),",
    "  abstract: run('abstract'),",
    "  paper: run('paper'),",
    "  journal: run('journal'),",
    "  notification: run('notification'),",
    "  cameraReady: run('camera_ready'),",
    "  dropped: selectableKind('notification'),",
    "  kept: selectableKind('paper'),",
    "  unknown: selectableKind('definitely-not-a-kind'),",
    "}));",
    "})().catch((e) => { console.error(e && e.stack || String(e)); process.exit(1); });",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 120_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    catalogKinds: Record<string, number>;
    all: { n: number; kinds: Record<string, number> };
    abstract: { n: number; kinds: Record<string, number> };
    paper: { n: number; kinds: Record<string, number> };
    journal: { n: number; kinds: Record<string, number> };
    notification: { n: number; kinds: Record<string, number> };
    cameraReady: { n: number; kinds: Record<string, number> };
    dropped: { kind: string; notice: string };
    kept: { kind: string; notice: string };
    unknown: { kind: string; notice: string };
  };
  // 収録されているのに選べない種別があること（＝この検査に意味があること）。
  expect(out.catalogKinds.notification || 0).toBeGreaterThan(0);
  // 既定は投稿締切のみ。
  expect(Object.keys(out.all.kinds).sort()).toEqual(["abstract", "paper"]);
  // 選択肢に並べる種別は、選べば行が返らないといけない。
  expect(out.abstract.n, "概要締切が 0 件なら選択肢が噺になる").toBeGreaterThan(0);
  expect(out.paper.n).toBeGreaterThan(0);
  expect(out.journal.n).toBeGreaterThan(0);
  expect(Object.keys(out.abstract.kinds)).toEqual(["abstract"]);
  expect(Object.keys(out.paper.kinds)).toEqual(["paper"]);
  // 投稿締切以外の種別を表に出さないのは仕様（SPEC §7）。`upcoming.md` で追う。
  expect(out.notification.n).toBe(0);
  expect(out.cameraReady.n).toBe(0);
  // 実在する種別を URL で受けたときは、黙って捨てず理由を返す。
  expect(out.dropped.kind).toBe("");
  expect(out.dropped.notice).toContain("採否通知");
  expect(out.dropped.notice).toContain("upcoming.html");
  expect(out.kept).toEqual({ kind: "paper", notice: "" });
  // 不明な値は説明を出さない（存在しない種別の名前を教えない）。
  expect(out.unknown).toEqual({ kind: "", notice: "" });
});

it("ランクの選択肢は選べば行が返り、表示語はそのまま引ける（SPEC §7）", () => {
  const runtime = siteRuntime();
  const app = siteRuntime("app.js");
  const filterSrc = jsFunction(runtime, "filter");
  // 表示は recommender の語を正本にする（表とドロワーで言い方が割れないようにする）。
  expect(app).toContain("Recommender.rankPairLabelJa(");
  // URL が受け付けるランクの値は選択肢の正本と同じ列表を使う（書き写しを防ぐ）。
  // 等級順の正本は recommender（app の選択肢はその写し。並び順と同じ表を使う）。
  const grades = rankGradeOptionsSource();
  expect(app).toContain("RANK_GRADE_OPTIONS = Recommender.rankGradeOrderJa()");
  expect(app).toContain('RANK_GRADE_OPTIONS.indexOf(rawRank || "")');
  expect(app).toContain("RANK_GRADE_OPTIONS.forEach((r) => {");
  // 選択肢の列表はビルド成果から取る（テスト側に書き写さない）。
  const gradeOptions = [...String(grades).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  expect(gradeOptions.length).toBeGreaterThan(2);

  const recPath = join(site, "recommender.js");
  const dataPath = join(site, "data.json");
  const script = [
    // 間接 eval でグローバルに置く（`new Function` の中身はグローバルスコープで解決されるため、
    // async IIFE の中の変数は見えない）。
    `(0, eval)(${JSON.stringify(jsFunction(runtime, "windowLimitMs"))});`,
    // 窓の比較（行の表示暦日）は絞り込み本体と画面上部の数が共有する（第 228 回）。
    `(0, eval)(${JSON.stringify(jsFunction(runtime, "rowShownDayMs"))});`,
    `(0, eval)(${JSON.stringify(jsFunction(runtime, "rowAfter"))});`,
    // 並び順の比較もグローバルに（`new Function` 内はグローバルで解決される）。
    // 手書きの `SELECTABLE_KINDS` は種別セレクトの正本から取る。
    `(0, eval)(${JSON.stringify(SORT_CANON_EVAL)});`,
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${recPath}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(dataPath)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    "class FakeDate extends Date { static now() { return now; } }",
    "const document = {};",
    "function $(id) { return null; }",
    "const window = {};",
    "globalThis.Recommender = Recommender;",
    "globalThis.activeData = DATA;",
    "globalThis.hiddenCounts = { past: 0, est: 0, kind: 0, rank: 0, cats: 0 };",
    "globalThis.catFacetCounts = {};",
    "globalThis.searchQuery = '';",
    "function run(rank) {",
    "  const state = { mode: 'deadlines', q: '', cats: [], kind: '', rank: rank, win: 'all',",
    "    est: false, domestic: false, online: false, past: false };",
    "  const runFilter = new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "    'return (' + FILTER + ')')(FakeDate, 86400000, rows, state, true, 'rem');",
    "  return runFilter();",
    "}",
    // 期待行をこの場で書き写さない（推定・過去・期間の規則を再現すると、テストが実装の
    // 写しになる）。既定の画面（rank 未指定）を出発点にして、
    // 「ランクの絞り込みは、その grade を持つ行だけの部分集合である」ことを見る。
    "const gradeOf = (p) => { const at = String(p).indexOf(':'); return at < 0 ? '' : String(p).slice(at + 1); };",
    "const rowId = (r) => [r.conf.key, r.t, r.kind].join('|');",
    "const baseRows = run('');",
    "const gradesInView = new Set();",
    "baseRows.forEach((r) => (r.rankPairs || []).forEach((p) => { const g2 = gradeOf(p); if (g2) gradesInView.add(g2); }));",
    "const perGrade = {};",
    `const GRADES = ${JSON.stringify(gradeOptions)};`,
    "GRADES.filter((g) => gradesInView.has(g)).forEach((g) => {",
    "  const got = run(g).map(rowId);",
    "  const want = baseRows.filter((r) => Recommender.rankMatches(r.rankPairs, g)).map(rowId);",
    "  perGrade[g] = { n: got.length, exact: JSON.stringify(got) === JSON.stringify(want) };",
    "});",
    // 表示ラベルがそのままで引けるか（全ペアを総当たり）。
    "const pairs = new Set();",
    "rows.forEach((r) => (r.rankPairs || []).forEach((p) => pairs.add(p)));",
    "const unreachable = [];",
    "for (const p of pairs) {",
    "  const label = Recommender.rankPairLabelJa(p);",
    "  if (!rows.some((r) => Recommender.hayMatches(r.hay, label))) unreachable.push(p + ' -> ' + label);",
    "}",
    // 評価一覧に載るが評価の無い行（N）は「評価なし」で引けること。
    "const unrated = rows.filter((r) => (r.rankPairs || []).some((p) => /:N$/.test(String(p)))).length;",
    "const unratedHit = rows.filter((r) => Recommender.hayMatches(r.hay, '評価なし')).length;",
    "console.log(JSON.stringify({",
    "  base: baseRows.length,",
    "  inView: [...gradesInView].sort(),",
    "  perGrade,",
    "  pairCount: pairs.size,",
    "  unreachable,",
    "  unrated,",
    "  unratedHit,",
    "}));",
    "})().catch((e) => { console.error(e && e.stack || String(e)); process.exit(1); });",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 120_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    base: number;
    inView: string[];
    perGrade: Record<string, { n: number; exact: boolean }>;
    pairCount: number;
    unreachable: string[];
    unrated: number;
    unratedHit: number;
  };
  // 既定の画面に見える grade は、選べばその行が返る。grade の厳密比較になっていることも
  // ここで見る（一覧名込みの文字列と比べる実装だと全 grade で 0 件になる）。
  expect(out.base, "既定画面が行を作っていない").toBeGreaterThan(0);
  expect(out.inView.length, "ランク付きの行が既定画面に見当たらない").toBeGreaterThan(1);
  for (const [grade, got] of Object.entries(out.perGrade)) {
    expect(got.n, `ランク ${grade} を選ぶと 0 件になる`).toBeGreaterThan(0);
    expect(got.exact, `ランク ${grade} の絞り込みが grade 一致と違う行を返している`).toBe(true);
  }
  // 表に出すランクの語が、そのまま検索で引けない行がない。
  expect(out.pairCount).toBeGreaterThan(4);
  expect(out.unreachable).toEqual([]);
  expect(out.unrated).toBeGreaterThan(0);
  expect(out.unratedHit).toBeGreaterThanOrEqual(out.unrated);
});

it("締切までの選択肢は URL と表裏一体で、窓は入れ子になる（SPEC §7）", () => {
  const runtime = siteRuntime();
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const filterSrc = jsFunction(runtime, "filter");
  // セレクトに並ぶ値と、URL が受け付ける値がズレると、共有 URL でセレクトが空欄になる
  // （選択肢に無い値を `select.value` に代入すると表示が消える）。
  const selectBlock = template.match(/<select id="win"[\s\S]*?<\/select>/)?.[0];
  expect(selectBlock, "期間のセレクトが見つからない").toBeTruthy();
  const optionValues = [...String(selectBlock).matchAll(/<option value="([^"]+)">/g)].map(
    (m) => m[1],
  );
  const accepted = runtime.match(/const WIN_OPTIONS = \[[^\]]*\];/)?.[0];
  expect(accepted, "WIN_OPTIONS 定義が見つからない").toBeTruthy();
  const acceptedValues = [...String(accepted).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  expect(optionValues.slice().sort()).toEqual(acceptedValues.slice().sort());
  // 「直近 N 日」は過去 7 日とも読める。締切日からの日数だと分かる表記にする。
  expect(String(selectBlock)).not.toContain("直近");
  expect(template).toContain("締切まで");

  const script = [
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-09T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    "const document = {};",
    "function $(id) { return null; }",
    "const window = {};",
    "let hiddenCounts = {",
    "  past: 0, est: 0, kind: 0, domestic: 0, online: 0, onlinePlaceUnknown: 0, window: 0, rank: 0, cats: 0,",
    "};",
    "let catFacetCounts = {};",
    "let searchQuery = '';",
    "const activeData = { conferences: [] };",
    jsFunction(runtime, "windowLimitMs"),
    jsFunction(runtime, "windowFloorMs"),
    // 窓の比較（行の表示暦日）も共有実装（第 228 回）。書かないと `filter` が
    // `rowAfter is not defined` で落ちる。
    jsFunction(runtime, "rowShownDayMs"),
    jsFunction(runtime, "rowAfter"),
    ...SORT_CANON.all,
    "const Recommender = {",
    "  expandRelativeMonths: (q) => q || '', searchMatcher: () => () => true,",
    "  parsePaperLines: (t) => (t ? [{ title: t }] : []),",
    "  journalRows: () => [], pastRepresentatives: () => [],",
    "  rankMatches: (pairs, rank) => (pairs || []).some((p) => p.slice(p.indexOf(':') + 1) === rank),",
    "  placeOffersOnline: () => false, hasJapanese: () => false,",
    "};",
    "const rows = [];",
    // 400 日先まで行を置く（窓の入れ子と「選べば変わる」を両方見るため、窓より広くする）。
    "for (let i = 0; i < 400; i++) {",
    "  const inDays = i; // 0〜399 日後",
    "  rows.push({",
    "    kind: 'paper', est: false, cats: ['hpc'], rankPairs: [], hay: 'row' + i, tags: [],",
    "    t: now + inDays * DAY, tLast: now + inDays * DAY,",
    "    ed: { place: '京都', deadlines: [] }, conf: { key: 'r' + i },",
    "  });",
    "}",
    "for (let i = 0; i < 8; i++) {",
    "  rows.push({",
    "    kind: 'paper', est: false, cats: ['hpc'], rankPairs: [], hay: 'past' + i, tags: [],",
    "    t: now - (i + 1) * DAY, tLast: now - (i + 1) * DAY,",
    "    ed: { place: '京都', deadlines: [] }, conf: { key: 'p' + i },",
    "  });",
    "}",
    "function run(opt) {",
    "  const o = opt || {};",
    "  const state = { mode: 'deadlines', q: '', cats: [], kind: '', rank: '', win: o.win || 'all',",
    "    est: false, domestic: false, online: false, past: o.past === true };",
    "  const runFilter = new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "    'return (' + FILTER + ')')(FakeDate, DAY, rows, state, true, 'rem');",
    "  return runFilter().map((r) => r.conf.key);",
    "}",
    "const win = {};",
    // 過去行も出す設定で比べる（既定画面だと全行が未来なので、広い窓と区別できない）。
    "['all', '7d', '30d', '90d', '180d'].forEach((w) => {",
    "  win[w] = run({ win: w, past: true });",
    "});",
    "console.log(JSON.stringify({ win }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as { win: Record<string, string[]> };
  // 窓は入れ子。広い窓が狭い窓を含んでいないと「変えたのに増えない」が起きる。
  const subset = (small: string, big: string) => {
    const bigSet = new Set(out.win[big]);
    expect(
      out.win[small].every((k) => bigSet.has(k)),
      `${small} が ${big} を含んでいない`,
    ).toBe(true);
  };
  expect(out.win["7d"].length).toBeGreaterThan(0);
  subset("7d", "30d");
  subset("30d", "90d");
  subset("90d", "180d");
  subset("180d", "all");
  // 並べる選択肢は、選べば画面が変わる（何もしない値を並べない）。
  for (const win of ["7d", "30d", "90d", "180d"]) {
    expect(out.win[win].length, `窓 ${win} が「かまわない」と同じ行を返す`).toBeLessThan(
      out.win.all.length,
    );
  }
});

it("早め絞り込みのボタンは、入っている条件が点く（SPEC §7）", () => {
  const runtime = siteRuntime();
  const script = [
    "const { default: Recommender } = await import(" +
      JSON.stringify(`file://${join(site, "recommender.js")}`) +
      ");",
    jsFunction(runtime, "updatePresetActive"),
    // `updatePresetActive` はモジュールスコープの `state` を読む（引数取らず）。
    "let state = {};",
    "function btn(preset) {",
    "  const b = { preset, active: false, pressed: '' };",
    "  b.classList = {",
    "    toggle: (_name, on) => {",
    "      b.active = Boolean(on);",
    "    },",
    "  };",
    "  b.setAttribute = (name, value) => {",
    "    if (name === 'aria-pressed') b.pressed = String(value);",
    "  };",
    "  b.getAttribute = (name) => (name === 'data-preset' ? preset : null);",
    "  return b;",
    "}",
    "const buttons = ['7d', 'a_star', 'hpc_sys', 'domestic', 'online'].map((p) => btn(p));",
    "const document = { querySelectorAll: () => buttons };",
    "function lit(next) {",
    "  state = Object.assign({}, base, next);",
    "  buttons.forEach((b) => {",
    "    b.active = false;",
    "    b.pressed = '';",
    "  });",
    "  updatePresetActive();",
    "  const on = buttons.filter((b) => b.active).map((b) => b.preset);",
    "  const read = buttons.filter((b) => b.pressed === 'true').map((b) => b.preset);",
    "  if (read.join(',') !== on.join(',')) {",
    "    throw new Error('点灯と読み上げの状態が違う: 点灯 [' + on.join('・') + '] / 読み上げ [' + read.join('・') + ']');",
    "  }",
    "  if (buttons.some((b) => b.pressed !== 'true' && b.pressed !== 'false')) {",
    "    throw new Error('状態を書いていない早め絞り込みのボタンがいる');",
    "  }",
    "  return on;",
    "}",
    "const base = { q: '', cats: [], kind: '', rank: '', win: 'all', est: false, domestic: false, online: false, past: false };",
    "console.log(JSON.stringify({",
    "  nothing: lit({}),",
    "  domestic: lit({ domestic: true }),",
    "  online: lit({ online: true }),",
    "  // 複合状態は、掛かっている条件のボタンがすべて点く（変更前はどれでもない表示で、",
    "  // 押したことが画面から読めなかった）。",
    "  both: lit({ domestic: true, online: true }),",
    "  domesticPlusQuery: lit({ domestic: true, q: 'nsdi' }),",
    "  sevenDays: lit({ win: '7d' }),",
    "  sevenDaysAndRank: lit({ win: '7d', rank: 'A*' }),",
    "  queryOnly: lit({ q: 'スパコン' }),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Record<string, string[]>;
  expect(out.nothing).toEqual([]);
  expect(out.domestic).toEqual(["domestic"]);
  expect(out.online).toEqual(["online"]);
  expect(out.both.sort()).toEqual(["domestic", "online"]);
  // 検索語を足しても、掛かっている条件は点いたまま。
  expect(out.domesticPlusQuery).toEqual(["domestic"]);
  expect(out.sevenDays).toEqual(["7d"]);
  expect(out.sevenDaysAndRank.sort()).toEqual(["7d", "a_star"]);
  expect(out.queryOnly).toEqual([]);
});

it("実カタログで、表に出す語はすべて日本語表記を持つ（SPEC §7）", () => {
  // 「表に出す語が検索で引けない」と同じ系列の欠陥を先回りする検査。
  // 内部トークン（kind・分野・主題タグ）に対応する日本語表記が無いと、
  // 種別と分野は英語のまま出たり、主題ドロワーから語が消えたりする。
  // 対応表に無い語をどう扱うかを、実データで全値なべて確認する。
  const _runtime = siteRuntime("recommender.js");
  const dataPath = join(site, "data.json");
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(dataPath)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const kindTable = Recommender.kindLabelTable();",
    "const kinds = new Map();",
    "rows.forEach((r) => {",
    "  kinds.set(r.kind, (kinds.get(r.kind) || 0) + 1);",
    "});",
    // 分野は対応表が無ければ key をそのまま返す実装。key と一致 = 未整備。
    "const cats = new Map();",
    "rows.forEach((r) => {",
    "  (r.cats || []).forEach((c) => {",
    "    cats.set(c, (cats.get(c) || 0) + 1);",
    "  });",
    "});",
    "const tags = new Map();",
    "DATA.conferences.forEach((c) => {",
    "  (c.tags || []).forEach((t) => {",
    "    tags.set(t, (tags.get(t) || 0) + 1);",
    "  });",
    "});",
    "console.log(JSON.stringify({",
    "  kindsNoJa: [...kinds.keys()].filter((k) => !kindTable[k]),",
    "  catsNoJa: [...cats.keys()].filter((c) => Recommender.categoryLabelJa(c) === c),",
    "  tagsNoJa: [...tags.entries()]",
    "    .filter(([t]) => !Recommender.tagLabelJa(t))",
    "    .map(([t, n]) => ({ tag: t, conferences: n })),",
    // 日本語表記を持ちながらドロワーに出ない語（＝主題から落ちる情報）。
    "  tagsHiddenWithJa: [...tags.entries()]",
    "    .filter(([t]) => {",
    "      const label = Recommender.tagLabelJa(t);",
    "      return Boolean(label) && Recommender.topicTagsJa([t]).indexOf(label) < 0;",
    "    })",
    "    .map(([t, n]) => ({ tag: t, conferences: n })),",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    kindsNoJa: string[];
    catsNoJa: string[];
    tagsNoJa: { tag: string; conferences: number }[];
    tagsHiddenWithJa: { tag: string; conferences: number }[];
  };
  expect(out.kindsNoJa, "日本語表記の無い締切種別").toEqual([]);
  expect(out.catsNoJa, "日本語表記の無い分野").toEqual([]);
  // 日本語表記を持ちながら主題から落ちる語は、理由を持つものだけ。
  // `journal` はジャーナルを表す構造タグで、種別列が「常時受付」として既に伝えている
  // （主題に並べると分野と種別が混ざるため出さない）。
  expect(out.tagsHiddenWithJa.map((t) => t.tag).sort()).toEqual(["journal"]);
  expect(out.tagsHiddenWithJa[0].conferences, "journal タグの件数").toBeGreaterThan(0);
  /* 主題に出さないタグの許容リスト。増えたら理由を書く — 対応表に無い語は主題から
   * 黙って消えるので、データにタグを足した人が気づかないままたくさん溜まるのをここで止める。
   *   domestic-jp       … 「国内のみ」しぼりの構造タグ（行頭に「国内」を出すので主題には出さない）
   *   sensys            … 統合先の名前（「掲載終了」「統合済み」の語が既に伝える）
   *   virtual-execution … 開催地が "Virtual" を示し「オンライン参加可」が伝える */
  const ALLOWED_UNLABELED = ["domestic-jp", "sensys", "virtual-execution"];
  expect(
    out.tagsNoJa.filter((t) => ALLOWED_UNLABELED.indexOf(t.tag) < 0),
    "理由の無い、日本語表記の無い主題タグ",
  ).toEqual([]);
  // 開催地がオンライン参加可を示さない会議に `virtual-execution` を付けると、
  // 主題から落ちた情報がどこにも出なくなる。実データで当たった行について確かめる。
  const catalog = JSON.parse(readFileSync(dataPath, "utf8")) as {
    conferences: { key: string; tags?: string[]; editions?: { place?: string }[] }[];
  };
  catalog.conferences
    .filter((c) => (c.tags || []).indexOf("virtual-execution") >= 0)
    .forEach((c) => {
      expect(
        (c.editions || []).some((ed) => Recommender.placeOffersOnline(String(ed.place || ""))),
        `${c.key}: 開催地がオンライン参加可を示さないのにタグが主題から落ちる`,
      ).toBe(true);
    });
});

it("upcoming.md の開催地は、サイトの表と同じ日本語表記で出る（SPEC §7）", () => {
  // 以前は md 側が `placeWithPrefectureJa` だけを使い、サイト側は `placeJa` だけを使っていた。
  // 両方が持ちつづつ半分ずつで、md の海外行は "Kunming, China" のまま残っていた
  // （「日本」で grep しても国内の行に当たらない）。
  const buildSrc = readFileSync(join(REPO_ROOT, "src", "build.ts"), "utf8");
  expect(buildSrc, "md の開催地は placeJa と placeWithPrefectureJa を組み合わせて出す").toContain(
    "Recommender.placeJa(Recommender.placeWithPrefectureJa(ed.place))",
  );

  const rec = siteRuntime("recommender.js");
  // ビルド後は型注釈が消えるので、型名を問わずに読む。
  const terms = rec.match(/const PLACE_TERMS_JA[^=]*= \[([\s\S]*?)\n\s*\];/);
  expect(terms, "PLACE_TERMS_JA が見つからない").toBeTruthy();
  const keys = [...String(terms![1]).matchAll(/\["((?:[^"\\]|\\.)+)",/g)].map((m) => m[1]);
  expect(keys.length, "対応表が読めない").toBeGreaterThan(40);

  const md = readFileSync(join(site, "upcoming.md"), "utf8");
  const offenders: string[] = [];
  md.split("\n").forEach((line) => {
    if (!line.startsWith("| ")) return;
    const cells = line.split("|").map((c) => c.trim());
    const venue = cells[cells.length - 2];
    if (!venue || venue === "開催地" || venue === "---") return;
    venue.split("/").forEach((segment) => {
      const at = segment.lastIndexOf(",");
      const tail = (at < 0 ? segment : segment.slice(at + 1)).trim();
      // 対応表に載っている語が英語のまま残っていたら、md だけ日本語化が効いていない。
      if (/[A-Za-z]/.test(tail) && keys.indexOf(tail.toLowerCase()) >= 0) {
        offenders.push(`${venue} → ${tail}`);
      }
    });
  });
  expect(offenders, `md の開催地が未翻訳: ${offenders.join(" / ")}`).toEqual([]);
});

it("分野の言い方は、画面に出る語だけを指す（SPEC §7）", () => {
  // 寄せた先が行に見えない語だと、なぜ出たか分からないまま行の壁になる。
  // 同義語表の行き先が、分野名・主題タグの日本語表記（どちらも画面に出す）だけを向いていることを検査する。
  const rec = siteRuntime("recommender.js");
  const app = siteRuntime("app.js");
  const table = rec.match(/const QUERY_SYNONYMS_JA[^=]*= \[([\s\S]*?)\n\s*\];/);
  expect(table, "QUERY_SYNONYMS_JA が見つからない").toBeTruthy();
  const entries = [...String(table![1]).matchAll(/\["([^"]+)", "([^"]+)", \[([^\]]*)\]\]/g)].map(
    (m) => ({
      word: m[1],
      shown: m[2],
      terms: [...m[3].matchAll(/"([^"]+)"/g)].map((t) => t[1]),
    }),
  );
  expect(entries.length).toBeGreaterThan(5);
  /* 欄の選択肢に出る語のほか、**行として画面に出る文字列に実在する表記**も寄せ先にしてよい
   * （第 249 回 – `国内開催` を `国内` に寄せた）。`国内` は選択肢の語ではないが行の会議名
   * 「…研究会」等の表記の一部として画面に出る（2026-08-09 生成の実データで 46 行が「国内」を
   * 含む – `tests/search_words.test.ts` が出会える行数で見る）。選択肢の語だけに絞ると
   * 0 行のままで、案内も書けなかった。
   * ビルド成果物テキスト（recommender.js 自身）で見ると、書き足した語がそこに現れるので
   * 検査が空洞になる（`もともとの表記` を展開語に置く改ざんで exit 0 になった – 実測）。 */
  const rowText = (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
        typeof Recommender.candidateRows
      >[0],
    ) as Array<{ hay: string }>
  )
    .map((row) => String(row.hay))
    .join("\n");
  expect(rowText.length, "ビルド後の行の文字が読めない（検査が空洞になる）").toBeGreaterThan(
    100000,
  );
  /* サイトが場所の別名として知っている見出し（`米国` など）も寄せ先にできる。
   * これらの語は行にそのままは出ないが行の英文字表記（州・都市）と同じ場所を指し、
   * 画面が行の開催地として出す表記の読みそのもの（第 250 回 – `米国開催` を `米国` に
   * 寄せた。実測で 787 行に出会える）。見出し語の一覧はビルド後の成果物から読む。 */
  const knownReadings = [
    rec.match(/const PLACE_READINGS[\s\S]*?\];/)?.[0] ?? "",
    rec.match(/const REGION_READINGS[\s\S]*?\];/)?.[0] ?? "",
    rec.match(/const CONTINENT_READINGS[\s\S]*?\];/)?.[0] ?? "",
  ].join("\n");
  expect(knownReadings.length, "場所の別名見出しが読めない（検査が空洞になる）").toBeGreaterThan(
    2000,
  );
  entries.forEach((entry) => {
    // 説明の「◯◯『△△』」の △△ が、その語の実際の日本語表記と一致すること。
    const quoted = entry.shown.match(/「([^」]+)」/)?.[1];
    expect(quoted, `${entry.word} の説明に表示語を書いていない`).toBeTruthy();
    expect(entry.terms, `${entry.word} の展開語が無い`).toContain(quoted);
    /* 展開語は、画面に出す表記そのもの。分野名・締切種別・主題タグの対応表、および
     * 参加形式の語（チェックボックスに出る）に無い語を指したら失敗する
     * （寄せ先が行に見えない語だと、なぜ出たか分からなくなる）。 */
    const labelBlocks = [
      /const CATEGORY_LABELS_JA[^=]*= \{([\s\S]*?)\n\s*\};/,
      /const KIND_LABEL_JA[^=]*= \{([\s\S]*?)\n\s*\};/,
      /const TAG_LABELS_JA[^=]*= \{([\s\S]*?)\n\s*\};/,
      /const ONLINE_PARTICIPATION_LABEL_JA[^\n]*;/,
      // ランクの列に出る語（評価の無い行に「評価なし」と出す）。`ランクなし` をここへ寄せる
      // 検索の言い方が増えるまで、この検査の並べ先に含まれていなかった。
      /const RANK_UNRATED_LABEL_JA[^\n]*;/,
    ]
      .map((re) => rec.match(re)?.[0] ?? "")
      .join("\n");
    expect(labelBlocks.length, "表示語の対応表が読めない").toBeGreaterThan(100);
    /* 欄の選択肢に出る語のほか、**行のなかに実在する表記**も寄せ先にしてよい（第 249 回 –
     * `国内開催` を `国内` に寄せた）。`国内` は選択肢の語ではないが、サイト自身が
     * 件数欄に『国内研究会・国内シンポジウム』と書いていて、行の表記にも現れる
     * （2026-08-09 生成ビルドで 46 行が「国内」を含む – `tests/search_words.test.ts` が
     * 実際に行に出会えることを見る）。選択肢の語だけに絞ると 0 行のままで、案内も
     * 書けなかった。 */
    if (!rowText.includes(String(quoted)) && !knownReadings.includes(String(quoted))) {
      expect(labelBlocks, `${entry.word} → ${quoted} が画面に出る語ではない`).toContain(
        `"${quoted}"`,
      );
    }
  });
  // 件数欄で説明すること（理由も出さずに分野全体の行を並べない）。
  expect(app).toContain("querySynonymNotes(searchQuery)");
  // 説明文そのものは recommender 側が持つ（件数欄の文言と検索の寄せ先が割れないように）。
  expect(rec).toContain("で探しています");
});

it("既定画面で 0 件でも収録している検索語がある（0 件の説明が要る根拠）（SPEC §7）", () => {
  // 「検索語は収録済みで N 件に当たります」の説明は、そういう状況が実データに無いと嘘になる。
  // 既定画面（投稿締切・未来・推定を除く）では消えるのに、カタログには残る語を
  // ビルド後のデータから実際に探して確認する。
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(DATA);",
    // サイトの既定画面と同じ条件（種別は投稿締切、未来、推定を除く）。
    "const view = rows.filter((r) => {",
    "  if (r.kind !== 'abstract' && r.kind !== 'paper') return false;",
    "  if (r.ed.estimated) return false;",
    "  return r.t >= now;",
    "});",
    // 主題タグの日本語表記を語として試し、カタログ上の当たりと既定画面の当たりを数える。
    "const labels = [];",
    "DATA.conferences.forEach((c) => {",
    "  Recommender.topicTagsJa(c.tags || []).forEach((l) => {",
    "    if (labels.indexOf(l) < 0) labels.push(l);",
    "  });",
    "});",
    "const tried = labels.slice(0, 24);",
    "const hidden = [];",
    "tried.forEach((q) => {",
    "  const m = Recommender.searchMatcher(q);",
    "  const catalog = rows.filter((r) => m(r.hay)).length;",
    "  const shown = view.filter((r) => m(r.hay)).length;",
    "  if (catalog > 0 && shown === 0) hidden.push({ q, catalog });",
    "});",
    "console.log(JSON.stringify({ tried: tried.length, labels: labels.length, hidden }));",
    "})();",
  ]
    .filter((line) => typeof line === "string")
    .join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    tried: number;
    labels: number;
    hidden: { q: string; catalog: number }[];
  };
  expect(out.labels, "主題タグが出ていない").toBeGreaterThan(0);
  expect(out.tried).toBeGreaterThan(0);
  // 1 件でもあれば説明は発火する（fixture だと全部の語が既定画面に出る場合はこの限りでない）。
  if (out.hidden.length) {
    expect(out.hidden[0].catalog).toBeGreaterThan(0);
  }
});

it("日本語 IME の変換中は再計算せず、確定後に一度だけ適用する（SPEC §7）", async () => {
  /* 検索欄だけ変換中を除けても、論文入力の要旨・タイトルは日本語で打つ欄なので
   * 同じもたつきが残る。入力欄はすべて同じ経路を通っていることを、ビルド後の
   * 実装を動かして確かめる（書き写した模倣では漂移を検出できない）。 */
  const app = siteRuntime();
  const wire = new Function(`return ${jsFunction(app, "wireDebouncedInput")};`)() as (
    element: { addEventListener(type: string, listener: () => void): void },
    delay: number,
    applyInput: () => void,
    onType?: () => void,
  ) => void;
  const fake = () => {
    const el: {
      handlers: Record<string, () => void>;
      applied: number;
      typed: number;
      addEventListener(type: string, listener: () => void): void;
      fire(type: string): void;
    } = {
      handlers: {},
      applied: 0,
      typed: 0,
      addEventListener(type, listener) {
        this.handlers[type] = listener;
      },
      fire(type) {
        this.handlers[type]();
      },
    };
    return el;
  };
  const wait = () => new Promise((resolve) => setTimeout(resolve, 60));

  // まとめた適用: 3 回打っても再計算は 1 回。
  const typing = fake();
  wire(
    typing,
    20,
    () => (typing.applied += 1),
    () => (typing.typed += 1),
  );
  typing.fire("input");
  typing.fire("input");
  typing.fire("input");
  await wait();
  expect(typing.applied).toBe(1);
  // 軽い処理（キャッシュ無効化）は打鍵ごとに走る。再計算を後回しにしても、
  // 古い結果を使い回さないために必要。
  expect(typing.typed).toBe(3);

  // 変換中（未確定のひらがな）は再計算しない。確定後に一度だけ。
  const ime = fake();
  wire(
    ime,
    20,
    () => (ime.applied += 1),
    () => (ime.typed += 1),
  );
  ime.fire("compositionstart");
  ime.fire("input");
  ime.fire("input");
  ime.fire("input");
  await wait();
  expect(ime.applied, "変換の途中で一覧が入れ替わっている").toBe(0);
  ime.fire("compositionend");
  await wait();
  expect(ime.applied, "確定後に適用されていない").toBe(1);
  // 変換中もキャッシュは無効化しておく（その隙に分野チップ等を押すことがある）。
  expect(ime.typed).toBeGreaterThanOrEqual(4);

  // compositionstart を飛ばして compositionend だけ来る入力経路でも取りこぼさない。
  const only = fake();
  wire(only, 20, () => (only.applied += 1));
  only.fire("compositionend");
  await wait();
  expect(only.applied).toBe(1);

  // 入力欄はすべてこの経路を通る（生で `input` を張った欄が 1 つでもあれば、
  // その欄だけ変換中にも再計算する）。
  expect(
    (app.match(/addEventListener\("input"/g) || []).length,
    "生の input 聞き手を張った欄が残っている",
  ).toBe(1);
  expect(app).toContain('wireDebouncedInput(valueElement("q")');
  expect(app).toContain('wireDebouncedInput($("paperText")');
  // 論文入力の 4 欄（タイトル・要旨・キーワード・参考文献）も同じ経路。
  expect(app).toContain('"paperPrimaryTitle", "paperPrimaryAbstract"');
  expect(app).toContain("wireDebouncedInput($(id), 200");
});

it("略称と年の合わせ打ちが実カタログで当たり、2 文字語の取りこぼしが増えない（SPEC §7）", () => {
  // `ICDE2027` 0 件 / `ICDE 2027` 6 件、`nsdi27` 0 件 / `NSDI 2027` 6 件だった。
  // 割る方向に直したので、今まで当たっていた行（`SC26` の直書き）を落としていないことも
  // 同じ実データで確認する。
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const hit = (q) => { const m = Recommender.searchMatcher(q); return rows.filter((r) => m(r.hay)); };",
    // 略称+年の入力が、語を割って打ったときと同じ行を出す。
    "const joined = hit('nsdi 2027').length;",
    "const glued = hit('nsdi27').length;",
    "const scSpaced = hit('sc 26').length;",
    // 2 文字語を部分一致で拾った行数（変更前に近い過剰な当たり）。
    "const gluedSc = rows.filter((r) => String(r.hay).indexOf('sc') >= 0).length;",
    "const boundedSc = hit('sc').length;",
    "console.log(JSON.stringify({ joined, glued, scSpaced, gluedSc, boundedSc }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    joined: number;
    glued: number;
    scSpaced: number;
    gluedSc: number;
    boundedSc: number;
  };
  expect(out.joined, "語を割って打つ方が 0 件").toBeGreaterThan(0);
  expect(out.glued, "貼り付けた入力が当たらない").toBe(out.joined);
  // `sc 26` は語の境界で当てるので、部分一致で拾うより大きく減る（`science` を捨てた）。
  expect(out.scSpaced).toBeGreaterThan(0);
  expect(out.scSpaced).toBeLessThan(out.gluedSc);
  expect(out.boundedSc).toBeGreaterThan(0);
  expect(out.boundedSc).toBeLessThan(out.gluedSc);
});
