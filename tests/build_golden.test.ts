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
import { beforeAll, describe, expect, it } from "vitest";
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
  makeConference,
  makeDeadline,
  makeEdition,
  NOW,
  PUBLIC_FILES,
  REPO_ROOT,
  runCli,
  utc,
} from "./helpers.ts";

let site: string;
let data: Record<string, any>;
let compiledRuntime: ReturnType<typeof compileSiteRuntime> | null = null;

function siteRuntime(name: keyof ReturnType<typeof compileSiteRuntime> = "app.js"): string {
  compiledRuntime ??= compileSiteRuntime();
  return compiledRuntime[name];
}

/* 等級順の列表をビルド成果から取り出す（テスト側に書き写さない）。
 * app.js の `RANK_GRADE_OPTIONS` は recommender の正本から作るので、
 * ハーネスへ入れるときは recommender 側の定義をそのまま使う。 */
function rankGradeOptionsSource(): string {
  const rec = siteRuntime("recommender.js");
  const order = rec.match(/const RANK_GRADE_ORDER_JA = \[[^\]]*\];/)?.[0];
  expect(order, "recommender の等級順（RANK_GRADE_ORDER_JA）が見つからない").toBeTruthy();
  return `${String(order).replace("const RANK_GRADE_ORDER_JA", "const RANK_GRADE_OPTIONS")};`;
}

function siteHtmlRuntime(): string {
  return `${readFileSync(join(site, "index.html"), "utf8")}\n${siteRuntime()}`;
}

beforeAll(() => {
  const outdir = join(mkdtempSync(join(tmpdir(), "cfp-site-")), "public");
  // 埋め込み生成は 2 モデル（英語+多言語）で数秒かかるため、このテスト群ではスキップ
  const run = runCli(outdir, { extra: ["--no-embeddings"] });
  expect(
    run.status,
    `cli build failed\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`,
  ).toBe(0);
  site = outdir;
  data = JSON.parse(readFileSync(join(site, "data.json"), "utf8"));
}, 300_000);

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

function conf(key: string): any {
  const matches = data.conferences.filter((c: any) => c.key === key);
  expect(matches.length).toBeGreaterThan(0);
  return matches[0];
}

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
  ]) {
    expect(text, `llms.txt 出力一覧は ${name} を載せる`).toContain(name);
  }
  expect(text).not.toMatch(/\.ics/);
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

// --- upcoming.md carries meetings too (SPEC.md 4) --------------------------

function upcomingRows(dir: string): string[][] {
  const text = readFileSync(join(dir, "upcoming.md"), "utf8");
  const rows: string[][] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|") || new Set(line).isSubsetOf(new Set("|- "))) continue;
    rows.push(
      line
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim()),
    );
  }
  return rows.slice(1);
}

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
  // 案内は選択肢の実ラベルを指すので、その定数も正本（ビルド後）から入れる。
  const appForHint = siteRuntime();
  const hint = new Function(
    `${appForHint.match(/const KIND_ALL_LABEL_JA = [^\n]*;/)?.[0] ?? ""}
     ${jsFunction(appForHint, "countJa")};
     return (${jsFunction(appForHint, "emptyDeadlineHint")});`,
  )() as (f: {
    window: string;
    past: boolean;
    cats: number;
    domestic: boolean;
    rank: string;
    kind: string;
    query: string;
    hiddenKindWords: string[];
    queryMatch: { catalog: number; journal: number };
    termCounts: Array<{ term: string; count: number }>;
    catalogConferences: number;
    online?: boolean;
    est?: boolean;
    hidden?: Record<string, number>;
  }) => string;
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
  expect(hint(clear)).toContain("upcoming.md");
  expect(hint(clear)).not.toContain("期間を");
  // 条件が残っているときは、外せる条件を実名で挙げる。
  const filtered = hint({ ...clear, window: "7d", past: false, query: "機械学" });
  // 案内は選択肢の実ラベルを書く（古いラベルを出すと、その語が画面に見つからない）。
  expect(filtered).toContain("「締切まで」を「かまわない」に変更");
  expect(filtered).toContain("「過去の締切も表示」をオン");
  expect(filtered).toContain("検索語を短くする");
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
  expect(catalogCase).not.toContain("upcoming.md");
  expect(catalogCase).not.toContain("検索語を短くする");
  // 外せる条件が残っていれば、それは後ろに添う（原因だけで打ち切らない）。
  expect(catalogCase).toContain("「過去の締切も表示」をオン");
  // 原因が特定できないときは、今までどおり会期のみ案内を添える。
  expect(hint({ ...clear, past: false, query: "xyzzy" })).toContain("upcoming.md");

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
  expect(head).toMatch(
    /生成時刻: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z（JST では \d{4}-\d{2}-\d{2}\([月火水木金土日]\) \d{2}:\d{2} JST）/,
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
  expect(droppedKind[1]).toContain("upcoming.md");
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
  const note = new Function(`return (${jsFunction(runtime, "relativeMonthNote")});`)() as (
    query: string,
    expanded: string,
  ) => string;
  expect(note("来月", "2026年10月")).toBe(" ｜ 来月 = 2026年10月");
  expect(note("来月 国内", "2026年10月 国内")).toBe(" ｜ 来月 = 2026年10月");
  expect(note("機械学習", "機械学習")).toBe("");
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

// --- the site's meeting rows run to the end of the meeting (SPEC.md 7) -----

/* `onKeydown` を抜き出して叩く検査は、第 135 回で増えたキーの振り分け関数も一緒に渡す
 * （抜き出した関数は独立していないと `ReferenceError` になる – 同じ穴に二度落ちないため、
 * 生の抜き出しではなくこの helper を使う）。 */
function keydownWithBlockers(src: string): string {
  // 第 152 回: `j` は選択が行の描画範囲を越えないか確認するので、抜き出した関数に
  // その関数も必要（独立していないと `ReferenceError` – 同じ helper の趣旨と同じ）。
  return `const ensureRowsDrawn = () => {};\n${jsFunction(src, "keyBlockedByTarget")}\n${jsFunction(src, "onKeydown")}`;
}

function jsFunction(html: string, name: string): string {
  const start = html.indexOf(`function ${name}(`);
  let depth = 0;
  let i = html.indexOf("{", start);
  while (true) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
    i += 1;
  }
}

// filter() is extracted from the emitted module; provide only its explicit module dependencies.
/* Node 26 は `-e` に渡したソースを ESM かどうか機械的に判定するようで、配列のリテラルに
 * `"crypto"` が 1 語で含まれていると**モジュール扱いになり、トップレベルの `const`/`var` が
 * `new Function` の本体から見えなくなる**（`Recommender is not defined` に化ける。
 * 2026-09-23 に実発生: `cryptography` `xcrypto` は大丈夫で、`crypto` だけ該当した）。
 * 実行時に同じ文字列になる Unicode エスケープへ書き換えて回避する（正本はそのまま）。 */
function vmSafeSource(src: string): string {
  return src.replace(/"crypto"/g, '"cr\\u0079pto"');
}

const SEARCH_CANON = (() => {
  // 検索照合の規則は recommender.js の正本をそのまま注入する（書き写すと正本とズレるため、
  // スタブでの再現は避ける）。
  const rec = siteRuntime("recommender.js");
  const consts = [
    ["SMALL_KANA_JA", /const SMALL_KANA_JA[\s\S]*?\};/],
    // `searchNormalize` がアクセントを折るための表（正本から注入し、写しは作らない）。
    // 他の定数の定義中に `searchNormalize` が呼ばれるので、必ず先に置く。
    ["DIACRITIC_FOLD_JA", /const DIACRITIC_FOLD_JA[\s\S]*?\};/],
    ["DIACRITIC_FOLD_CHARS", /const DIACRITIC_FOLD_CHARS = [^\n]*;/],
    ["LATIN_DIACRITIC_CHARS", /const LATIN_DIACRITIC_CHARS = [^\n]*;/],
    ["COMBINING_MARKS", /const COMBINING_MARKS = [^\n]*;/],
    ["PLACE_QUERY_ALIASES_JA", /const PLACE_QUERY_ALIASES_JA[\s\S]*?\];/],
    ["TOPIC_QUERY_ALIASES_JA", /const TOPIC_QUERY_ALIASES_JA[\s\S]*?\];/],
    ["RELATIVE_MONTH_OFFSETS_JA", /const RELATIVE_MONTH_OFFSETS_JA[\s\S]*?\};/],
    ["PLACE_READINGS", /const PLACE_READINGS[\s\S]*?\];/],
    ["REGION_READINGS", /const REGION_READINGS[\s\S]*?\];/],
    // 地域まとめ（`ヨーロッパ` → 国名）は shared の国名リスト変数に依存するので、
    // 定義順（TDZ）を崩さないようにリストを先に、表を後に inject する。
    ["EUROPE_JA", /const EUROPE_JA =[\s\S]*?;/],
    ["ASIA_JA", /const ASIA_JA =[\s\S]*?;/],
    ["US_STATES_JA", /const US_STATES_JA =[\s\S]*?;/],
    ["US_JA", /const US_JA =[\s\S]*?;/],
    ["NORTH_AMERICA_JA", /const NORTH_AMERICA_JA =[\s\S]*?;/],
    ["SOUTH_AMERICA_JA", /const SOUTH_AMERICA_JA =[\s\S]*?;/],
    ["CENTRAL_AMERICA_JA", /const CENTRAL_AMERICA_JA =[\s\S]*?;/],
    ["OCEANIA_JA", /const OCEANIA_JA =[\s\S]*?;/],
    ["CONTINENT_READINGS", /const CONTINENT_READINGS[\s\S]*?\];/],
    // 地方名 → 都道府県 + 開催市（`関東` で `Tokyo, Japan` を引く）の定義。
    ["PREFECTURE_CITIES_JA", /const PREFECTURE_CITIES_JA[\s\S]*?\];/],
    ["CITIES_BY_PREFECTURE", /const CITIES_BY_PREFECTURE[\s\S]*?\};/],
    ["QUERY_EDGE_PUNCTUATION", /const QUERY_EDGE_PUNCTUATION = [^\n]*;/],
    ["COMPOUND_MIN_LENGTH_JA", /const COMPOUND_MIN_LENGTH_JA = [^\n]*;/],
    ["ONLINE_TERMS_JA", /const ONLINE_TERMS_JA = [^\n]*;/],
    ["ONLINE_TERMS_EN", /const ONLINE_TERMS_EN = [^\n]*;/],
    ["ONLINE_VENUE_FALSE_POSITIVES", /const ONLINE_VENUE_FALSE_POSITIVES = [^\n]*;/],
    ["QUERY_SYNONYMS_JA", /const QUERY_SYNONYMS_JA[\s\S]*?\];/],
    ["ABBREV_YEAR_TOKEN", /const ABBREV_YEAR_TOKEN = [^\n]*;/],
    // 数字だけの入力（`12/25` `2026-12`）を暦日へ解決するための定義。
    ["DATE_WITH_YEAR_TOKEN", /const DATE_WITH_YEAR_TOKEN = [^\n]*;/],
    ["DATE_MONTH_DAY_TOKEN", /const DATE_MONTH_DAY_TOKEN = [^\n]*;/],
    ["DATE_YEAR_MONTH_TOKEN", /const DATE_YEAR_MONTH_TOKEN = [^\n]*;/],
    // 英字語の語境界照合（開催地の語は語全体で当てる）が使う定義。
    ["LATIN_TERM_TOKEN", /const LATIN_TERM_TOKEN = [^\n]*;/],
    ["wholeWordLatinTerms", /let wholeWordLatinTerms[^\n]*;/],
    ["RELATIVE_DAY_OFFSETS_JA", /const RELATIVE_DAY_OFFSETS_JA[\s\S]*?\};/],
    ["RELATIVE_WEEK_OFFSETS_JA", /const RELATIVE_WEEK_OFFSETS_JA[\s\S]*?\};/],
  ].map(([name, re]) => {
    const src = rec.match(re)?.[0];
    expect(src, `${name} 定義が見つからない`).toBeTruthy();
    return vmSafeSource(src as string);
  });
  return [
    ...consts,
    ...[
      "kanaFold",
      "monthTermsJa",
      "expandRelativeMonths",
      "searchNormalize",
      // 第 153 回: URL を検索欄に貼れるようにしたので、その部品も一緒に抜く
      // （抜いた関数は独立していないと `ReferenceError` になる）。
      "hostFromUrl",
      "hostLabels",
      "linkSearchTerms",
      "urlLikeQueryTerms",
      "queryTokens",
      "querySynonymMap",
      "abbrevYearGroups",
      "isCalendarMonthDay",
      "calendarDateGroups",
      "offsetCalendarDay",
      "weekDayTermsJa",
      "relativeDayGroups",
      "queryTokenGroups",
      "compoundSplitHit",
      "placeOffersOnline",
      "isShortLatinTerm",
      "foldedLetterAtWordBoundary",
      "termEndsInDigit",
      "placeLatinTerms",
      "cityQueryForms",
      "regionEntryMembers",
      "matchFoldedGroups",
      "searchMatcher",
      "hayMatches",
    ].map((name) => jsFunction(rec, name)),
  ];
})();
/* 並び順の比較は表の実装そのものを注入する。SORT はセルに出る語（`conferenceNameCell`）で
 * 決まるので、スタブにすると「見ていない語で並ぶ」欠けを検査できない。 */
const SORT_CANON = (() => {
  const app = siteRuntime();
  const consts = [/const SELECTABLE_KINDS = [^\n]*;/.exec(app)?.[0] || ""];
  const fns = ["titleWithYear", "conferenceNameCell", "kindSortIndex", "compareDeadlineRows"].map(
    (name) => jsFunction(app, name),
  );
  return { consts, fns, all: [...consts, ...fns] };
})();
/* 間接 eval で関数はグローバルに載るが、`const` は eval 用の宣言環境に閉じる
 * （`globalThis.X` にならない）。eval に渡す側だけ `var` に直す（正本の値はそのまま）。 */
const SORT_CANON_EVAL = [
  ...SORT_CANON.consts.map((src) => src.replace(/^const /, "var ")),
  ...SORT_CANON.fns,
].join("\n");

const FILTER_RUNTIME_STUBS = [
  // 窓の上限時刻は絞り込みと 0 件時の会期案内で共有する実装（書かないと両者が違う窓で動く）。
  jsFunction(siteRuntime(), "windowLimitMs"),
  // 「締切まで」の上下限は絞り込み本体が共有する実装（窓の解釈を二重化しない）。
  jsFunction(siteRuntime(), "windowFloorMs"),
  ...SORT_CANON.all,
  "let semQuery = null, semEmbeddings = null;",
  "let catFacetCounts = {};",
  "let hiddenCounts = {",
  "  past: 0, est: 0, kind: 0, domestic: 0, online: 0, onlinePlaceUnknown: 0, window: 0, rank: 0, cats: 0,",
  "};",
  "const activeData = { conferences: [] };",
  ...SEARCH_CANON,
  "let searchQuery = '';",
  "const Recommender = { searchNormalize: searchNormalize, queryTokens: queryTokens, kanaFold: kanaFold, queryTokenGroups: queryTokenGroups, searchMatcher: searchMatcher, matchFoldedGroups: matchFoldedGroups, placeOffersOnline: placeOffersOnline, monthTermsJa: monthTermsJa, expandRelativeMonths: expandRelativeMonths, hayMatches: hayMatches, parsePaperLines: (text) => text ? [{ title: text }] : [], hasJapanese: () => false, contentWordCount: () => 0, autoDetectCats: () => [], venueCategories: () => [], journalRows: () => [], pastRepresentatives: () => [], rankMatches: (pairs, rank) => pairs.includes(rank), venueRecommendations: (rows) => rows.map((row) => ({ row, boosted: false, match: null, availability: null, fit: { score: 10, lexicalScore: 10, label: '', lexicalRank: 0, semanticRank: 0, semanticScore: 0 } })), comparePapers: () => 0 };",
].join("\n");

it("browser date-only state is independent of the viewer timezone", () => {
  const app = siteRuntime();
  const script = [
    // buildRows is a typed runtime delegation; its dependency is supplied
    // explicitly here so this evaluates the emitted app module, not removed
    // site/app.js source text.
    "const Recommender = { candidateRows: (data) => { const dl = data.conferences[0].editions[0].deadlines[0]; return [{ dateOnly: true, localDate: dl.local_date, t: Date.parse(dl.earliest_utc), tLast: Date.parse(dl.latest_utc) }]; } };",
    jsFunction(app, "buildRows"),
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
  const drawerDepsSrc = [
    jsFunction(runtime, "meetingRangeJa"),
    jsFunction(runtime, "upcomingEditionsOf"),
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
    `const Recommender = { officialZone: ${jsFunction(siteRuntime("recommender.js"), "officialZone")}, placeJa: (v) => String(v ?? ""), topicTagsJa: () => [], weekdayJaFromDate: weekdayJaFromDate, eventCellJa: eventCellJa };`,
    "const body = { innerHTML: '' };",
    "const els = {",
    "  drawerBackdrop: { classList: { add() {} } }, drawerTitle: {}, drawerFullName: {},",
    "  drawerBody: body, drawerClose: { focus() {} },",
    "};",
    "const document = { activeElement: null, getElementById: (id) => els[id] || null };",
    "function $(id) { return document.getElementById(id); }",
    "const window = { _prevFocus: null };",
    `const openDrawer = new Function('window', 'document', '$', 'KIND_LABEL', 'titleWithYear', 'fmtDate', 'fmtJst', 'fmtAoE', 'esc', 'safeExternalUrl', 'rowDateOnlyState', 'verificationSummary', 'Recommender', 'meetingRangeJa', 'upcomingEditionsOf', 'kindDetailJa', 'writeUrl', 'return (' + ${JSON.stringify(openSrc)} + ')')(window, document, $, { paper: '論文締切' }, (t) => t, fmtDate, fmtJst, fmtAoE, (s) => String(s ?? ''), (v) => String(v ?? ''), () => null, () => '', Recommender, meetingRangeJa, upcomingEditionsOf, (${jsFunction(runtime, "kindDetailJa")}), () => {});`,
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
  expect(got.heading).toBe("2026年10月（7 件）");
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
    jsFunction(html, "meetingRangeJa"),
    jsFunction(html, "upcomingEditionsOf"),
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
    "const openDrawer = new Function('window', 'document', '$', 'KIND_LABEL', 'titleWithYear', 'fmtDate', 'fmtJst', 'fmtAoE', 'esc', 'safeExternalUrl', 'rowDateOnlyState', 'verificationSummary', 'Recommender', 'meetingRangeJa', 'upcomingEditionsOf', 'kindDetailJa', 'writeUrl', 'return (' + OPEN + ')')(window, document, $, {}, (t) => t, () => '', () => '', () => '', (s) => String(s ?? ''), (s) => String(s ?? ''), () => null, verificationSummary, { officialZone: () => '', placeJa: (v) => String(v ?? ''), topicTagsJa: () => [], weekdayJaFromDate: () => '', eventCellJa: (r) => String(r?.ed?.event_start || r?.ed?.date_text || '') }, meetingRangeJa, upcomingEditionsOf, KIND_DETAIL, () => {});",
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
  expect(text).not.toMatch(/\.ics/);
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
    jsFunction(runtime, "meetingRangeJa"),
    jsFunction(runtime, "upcomingEditionsOf"),
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
    `const openDrawer = new Function('window', 'document', '$', 'KIND_LABEL', 'titleWithYear', 'fmtDate', 'fmtJst', 'fmtAoE', 'esc', 'safeExternalUrl', 'rowDateOnlyState', 'verificationSummary', 'Recommender', 'meetingRangeJa', 'upcomingEditionsOf', 'kindDetailJa', 'writeUrl', 'return (' + ${JSON.stringify(openSrc)} + ')')(window, document, $, {}, (t) => t, () => '', () => '', () => '', (s) => String(s ?? ''), (s) => String(s ?? ''), () => null, verificationSummary, { officialZone: () => '', placeJa: (v) => String(v ?? ''), topicTagsJa: () => [], weekdayJaFromDate: () => '', eventCellJa: (r) => String(r?.ed?.event_start || r?.ed?.date_text || '') }, meetingRangeJa, upcomingEditionsOf, (${jsFunction(runtime, "kindDetailJa")}), () => {});`,
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
  expect(readdirSync(tmpDir).some((name) => name.endsWith(".ics"))).toBe(false);
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
    jsFunction(siteRuntime("app.js"), "meetingRangeJa"),
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
  for (const word of ["会期のみ・締切未定", "upcoming.md", "今後の会期"]) {
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
    jsFunction(app, "meetingRangeJa"),
    jsFunction(app, "upcomingEditionsOf"),
    "const later = upcomingEditionsOf(conf, '2026-09-28', now);",
    "console.log(JSON.stringify({",
    "  sameYear: meetingRangeJa('2026-12-01', '2026-12-02'),",
    "  crossYear: meetingRangeJa('2026-12-30', '2027-01-02'),",
    "  oneDay: meetingRangeJa('2026-12-01', '2026-12-01'),",
    "  later: later.map((e) => meetingRangeJa(e.start, e.end) + (e.place ? ' ＠' + e.place : '')),",
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

/** ビルド後の CSS をルール単位に割る（ネストは @media のみ）。
 * コメントは前置されるとセレクタや @media の判定を壊すので、先に落とす。 */
function cssBlocks(
  css: string,
  media = "",
): Array<{ media: string; selector: string; body: string }> {
  const source = media === "" ? css.replace(/\/\*[\s\S]*?\*\//g, "") : css;
  const out: Array<{ media: string; selector: string; body: string }> = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("{", i);
    if (open < 0) break;
    const prelude = source.slice(i, open).trim();
    const closeBrace = (from: number): number => {
      let depth = 1;
      let j = from;
      while (j < source.length && depth > 0) {
        if (source[j] === "{") depth += 1;
        else if (source[j] === "}") depth -= 1;
        j += 1;
      }
      return j - 1;
    };
    if (/^@(media|supports)/.test(prelude)) {
      const end = closeBrace(open + 1);
      const cond = prelude.replace(/^@(media|supports)\s*/, "");
      for (const rule of cssBlocks(source.slice(open + 1, end), cond)) out.push(rule);
      i = end + 1;
      continue;
    }
    if (prelude.startsWith("@")) {
      i = closeBrace(open + 1) + 1;
      continue;
    }
    const end = source.indexOf("}", open);
    if (end < 0) break;
    for (const sel of prelude
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      out.push({ media, selector: sel, body: source.slice(open + 1, end) });
    }
    i = end + 1;
  }
  return out;
}

function cssMediaApplies(media: string, width: number): boolean {
  if (!media) return true;
  if (/\bprint\b/.test(media)) return false;
  const max = media.match(/max-width:\s*(\d+)px/);
  if (max && width > Number(max[1])) return false;
  const min = media.match(/min-width:\s*(\d+)px/);
  if (min && width < Number(min[1])) return false;
  return true;
}

/** 同じセレクタに後から書かれた宣言が勝つ、という単一の規則で解決する。 */
function effectiveCss(
  css: string,
  selector: string,
  property: string,
  width: number,
): string | null {
  let value: string | null = null;
  for (const block of cssBlocks(css)) {
    if (block.selector !== selector) continue;
    if (!cssMediaApplies(block.media, width)) continue;
    const hit = block.body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
    if (hit) value = (hit[1] as string).trim();
  }
  return value;
}

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
  // 広い画面では従来どおり（横並びの表・スクロール可）でないと意味が無い。
  expect(effectiveCss(style, "table", "min-width", 1200)).toBe("880px");
  expect(effectiveCss(style, ".tablewrap", "overflow-x", 1200)).toBe("auto");
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

/** 文字列リテラルだけを拾う（ビルド後はコメントが残るため、正規表現では混ざる）。 */
function japaneseStringLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close < 0) break;
      i = close + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let buf = "";
      while (j < src.length) {
        const d = src[j];
        if (d === "\\") {
          buf += src[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (d === c) break;
        if (d === "\n" && c !== "`") break;
        buf += d;
        j += 1;
      }
      if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(buf)) out.push(buf);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

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
  const runtimeOnly = [...japaneseStringLiterals(runtime), ...japaneseStringLiterals(recSrc)];
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
  const banned = [
    // 推薦カードから出した語（第 84 回）。`キャッシュ退避` 等は実装側の言い方。
    "退避",
    "観測年数",
    "プロフィール",
    "シグナル",
    "カテゴリ",
    "トピック",
    "領域タグ",
    "ブースト",
    "RRF",
    "閾値",
    "埋め込み",
    "語彙スコア",
    "デッドライン",
    "フィルタ",
  ];
  for (const word of banned) {
    const hits = literals.filter((text) => text.includes(word));
    expect(hits, `画面に出る文言に「${word}」が残っている`).toEqual([]);
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
  expect(out.emptyCells["会期"]).toContain("未確認");
  expect(out.emptyCells["開催地"]).toContain("未確認");
  expect(out.emptyCells["ランク"]).toContain("未確認");
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
  expect(out.knownCells["会期"]).toContain("2026-11-12(木)");
  expect(out.knownCells["開催地"]).toContain("日本");
  expect(out.knownTitles.join(" ")).toContain("Kyoto, Japan");
  /* 締切が延びていたことは、一覧に出さないと分からない（2026-09-23 実測: 上流の締切名に
   * "Extended" と付く行が画面では他の行と区別が無く、検索も英語でしか引けなかった）。
   * 語は recommender の正本から取り、てびきの語と揃える（テスト側に書き写さない）。 */
  expect(out.extendedWord).not.toBe("");
  // 選択が無い行クリックは開く / 行内を選択した離すは開かない / 空のドラッグは開く /
  // 他所の選択は邪魔しない。
  expect(out.selLog, "文字選択とドロワーの開閉が噛み合っていない").toEqual([1, 1, 2, 3]);
  expect(out.extendedCells["会議"], "延長していた行に一覧で目印が出ていない").toContain(
    out.extendedWord,
  );
  expect(out.knownCells["会議"], "延長していない行まで目印を出している").not.toContain(
    out.extendedWord,
  );
  /* 収録元の締切名は、印を付けずに種別欄へ並べると画面の種別と並ぶ別の分類に見えていた
   * （第 146 回）。表のセルが「原表記: …」の形で描けることを、makeRow の実際の出力で見る。*/
  expect(
    out.extendedCells["種別"],
    "収録元の締切名が、何の値か分からない形で種別欄に出ている",
  ).toContain("原表記: Paper submission (Extended)");
  expect(out.emptyCells["種別"] ?? "", "原表記の無い行に語だけが出ている").not.toContain("原表記");
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
    jsFunction(runtime, "meetingRangeJa"),
    jsFunction(runtime, "upcomingEditionsOf"),
    `const verificationSummary = new Function('esc', 'return (' + ${JSON.stringify(summarySrc)} + ')')(esc);`,
    `const openDrawer = new Function('window','document','$','KIND_LABEL','titleWithYear','fmtDate','fmtJst','fmtAoE','esc','safeExternalUrl','rowDateOnlyState','verificationSummary','Recommender','catLabel','meetingRangeJa','upcomingEditionsOf','UNCONFIRMED_JA','kindDetailJa', 'writeUrl', 'return (' + ${JSON.stringify(openSrc)} + ')')(window, document, $, KIND_LABEL, titleWithYear, () => 'UTC', () => 'JST', () => 'AoE', esc, (u) => String(u ?? ''), () => null, verificationSummary, Recommender, catLabel, meetingRangeJa, upcomingEditionsOf, Recommender.unconfirmedLabelJa(), (${jsFunction(runtime, "kindDetailJa")}), () => {});`,
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
  // 無い行で空の見出しを出さない（主題と同じ扱い）。
  expect(out.bare).not.toContain("分野:");
  expect(out.bare).not.toContain("ランク:");
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
  expect(app).toContain("upcoming.md で確認できます");

  const recPath = join(site, "recommender.js");
  const dataPath = join(site, "data.json");
  const script = [
    // 間接 eval でグローバルに置く（`new Function` の中身はグローバルスコープで解決されるため、
    // async IIFE の中の変数は見えない）。
    `(0, eval)(${JSON.stringify(jsFunction(runtime, "windowLimitMs"))});`,
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
  expect(out.dropped.notice).toContain("upcoming.md");
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
    "  const b = { preset, active: false };",
    "  b.classList = {",
    "    toggle: (_name, on) => {",
    "      b.active = Boolean(on);",
    "    },",
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
    "  });",
    "  updatePresetActive();",
    "  return buttons.filter((b) => b.active).map((b) => b.preset);",
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
  const runtime = siteRuntime("recommender.js");
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
    ]
      .map((re) => rec.match(re)?.[0] ?? "")
      .join("\n");
    expect(labelBlocks.length, "表示語の対応表が読めない").toBeGreaterThan(100);
    expect(labelBlocks, `${entry.word} → ${quoted} が画面に出る語ではない`).toContain(
      `"${quoted}"`,
    );
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

it("相対週が実カタログで其の週 7 日と同じ行を出し、暦日でも引ける（SPEC §7）", () => {
  // 「来週」が 0 件、`8月11日` が 0 件だった（hay に暦日が無く、週の語も展開しなかった）。
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(DATA);",
    "const view = rows.filter((r) => (r.kind === 'abstract' || r.kind === 'paper') && r.t >= now && !r.ed.estimated);",
    "const hit = (q) => { const m = Recommender.searchMatcher(q, now); return view.filter((r) => m(r.hay)); };",
    // 来週 = 8/10〜8/16（月曜始まり）。7 日の和集合と同じ行になること。
    "const week = hit('来週');",
    "const days = Recommender.weekDayTermsJa('来週', now);",
    "const union = view.filter((r) => days.some((d) => String(r.hay).indexOf(d) >= 0));",
    // 週の外の日を交えないことも、実際の行で見る（週末日曜の翌日を含む行があるとは限らないので、
    // 週の日付そのものを持つ行が和集合に入っていることを確認する）。",
    "const outside = view.filter((r) => {",
    "  const j = new Date(r.t + 9 * 3600000);",
    "  const key = j.getUTCFullYear() + '年' + (j.getUTCMonth() + 1) + '月' + j.getUTCDate() + '日';",
    "  return !r.dateOnly && days.indexOf(key) < 0 && week.indexOf(r) >= 0;",
    "});",
    "const byDay = hit('8月22日').length;",
    "console.log(JSON.stringify({ week: week.length, union: union.length, outside: outside.length, byDay, days: days.length }));",
    "})();",
  ]
    .filter((line) => !line.trim().endsWith('",') || !line.includes("// "))
    .join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    week: number;
    union: number;
    outside: number;
    byDay: number;
    days: number;
  };
  expect(out.days).toBe(7);
  expect(out.week, "「来週」が 0 件のまま").toBeGreaterThan(0);
  expect(out.week, "週 7 日の和集合と違う行を出している").toBe(out.union);
  expect(out.outside, "週の外の日を持つ行を交えている").toBe(0);
  expect(out.byDay, "暦日（8月22日）で引けない").toBeGreaterThan(0);
});

it("論文から探すの候補も「さらに表示」で全件に到達する（SPEC §7）", () => {
  const runtime = siteRuntime("app.js");
  // 変更前は推薦カードを 5 件で打ち切り、`#more` を常に隠していた。件数欄は候補総数
  // （実測で 49〜200 件）を出すので、「200 件」と言いながら 5 件しか見えず、
  // 残りに到達する手段が無い画面になっていた。
  const page = runtime.match(/const RECOMMENDATION_PAGE = (\d+);/);
  expect(page, "推薦カードの初期表示件数が決まっていない").not.toBeNull();
  expect(Number(page?.[1])).toBeGreaterThan(5);
  expect(runtime).toContain("cardsDrawn = Math.min(list.length, RECOMMENDATION_PAGE);");
  expect(runtime).toContain("list.slice(0, cardsDrawn)");
  // 推薦モードでも「さらに表示」を生かし、残り件数を同じ形で見せる。
  expect(runtime).toContain("updateMoreButton(cardsDrawn, recommendationList.length);");
  expect(runtime).toContain('if (!$("recommendationCards").hidden) {');
  expect(runtime).toContain("drawMoreCards();");
  // 「さらに表示 (残り N 件)」の組み立ては一か所（表とカードで文言がズレないようにする）。
  expect((runtime.match(/さらに表示 \(残り/g) || []).length).toBe(1);
  // 件数欄の言い切りと画面を食い違わせない。
  expect(runtime).toContain("まず上位 ${countJa(RECOMMENDATION_PAGE)} 件を表示");

  // ラベルと表示可否は本物を実行して見る（書き写すと「残り」の対応がズレる）。
  const script = [
    `const countJa = (${jsFunction(runtime, "countJa")});`,
    "const more = { hidden: null, textContent: '' };",
    "const $ = () => more;",
    `const moreButtonLabel = ${jsFunction(runtime, "moreButtonLabel")};`,
    `const updateMoreButton = ${jsFunction(runtime, "updateMoreButton")};`,
    "const seen = [];",
    "for (const [drawn, total] of [[0, 200], [20, 200], [180, 200], [200, 200]]) {",
    "  updateMoreButton(drawn, total);",
    "  seen.push([more.hidden, more.textContent].join('/'));",
    "}",
    "console.log(JSON.stringify(seen));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  expect(JSON.parse(proc.stdout)).toEqual([
    "false/さらに表示 (残り 200 件)",
    "false/さらに表示 (残り 180 件)",
    "false/さらに表示 (残り 20 件)",
    "true/さらに表示 (残り 20 件)",
  ]);

  // 0 件の案内は、この画面に無い条件へ利用者を送らない（推薦モードでは
  // 検索・分野・国内などの絞り込みを見せていない）。
  expect(runtime).not.toContain("該当する投稿先がありません。論文本文を長めに入れるか");
  expect(runtime).toContain("タイトル・概要・キーワードを足すと当たりやすくなります");
});

it("同じ締切時刻の行は表に出る会議名と種別で並ぶ（SPEC §7）", () => {
  const runtime = siteRuntime("app.js");
  // 既定画面 477 行のうち 303 行が別の行と同じ締切時刻を持つ（同値グループは最大 17 行）。
  // 変更前のタイはデータ源の順のままだった。
  // 第 91 回で昇降の掛け算は比較関数の内側へ移した（外で掛けると、締切の時刻を
  // 持たない行が降順で先頭に反転して「いちばん遠い」に化けるため）。
  expect(runtime).toContain("return compareDeadlineRows(a, b, mult);");
  // ランク順も同じ評価の塊の中を読めるようにする。
  expect(runtime).toContain("return cmp ? cmp * mult : compareDeadlineRows(a, b, mult);");
  expect(runtime).not.toContain("compareDeadlineRows(a, b) * mult");
  // 並び順は表のセルに出る語を共通の helper で使う（セルとSORTが別文字列を持つのが原因）。
  expect(runtime).toContain("const name = conferenceNameCell(r);");
  expect(runtime).not.toContain('localeCompare(b.conf.title || "")');
  // ロケールを明示しない比較は閲覧者の UI ロケールで順序が変わる（実測で en/de と ja が違った）。
  expect(
    (runtime.match(/\.localeCompare\(conferenceNameCell\(b\), "ja"\)/g) || []).length,
  ).toBeGreaterThanOrEqual(2);

  const consts = /const SELECTABLE_KINDS = [^\n]*;/.exec(runtime)?.[0];
  expect(consts, "種別の並び順の元になる配列がない").toBeTruthy();
  const script = [
    consts,
    `const kindSortIndex = ${jsFunction(runtime, "kindSortIndex")};`,
    `const titleWithYear = ${jsFunction(runtime, "titleWithYear")};`,
    `const conferenceNameCell = ${jsFunction(runtime, "conferenceNameCell")};`,
    `const compareDeadlineRows = ${jsFunction(runtime, "compareDeadlineRows")};`,
    "const row = (title, key, t, kind, year) => ({ conf: { title, key }, ed: { year }, t, kind });",
    // 同じ時刻の3行。漢字名は読み基準の五十音順（航空=か → 情報=ざ）に並ぶ。
    "const tied = [",
    "  row('情報処理研究会', 'ipsj-hi', 1, 'paper', 2027),",
    "  row('航空宇宙研究会', 'ipsj-ast', 1, 'paper', 2027),",
    "  row('ネットワーク研究会', 'ipsj-nw', 1, 'paper', 2027),",
    "];",
    "const byName = tied.slice().sort(compareDeadlineRows).map((r) => conferenceNameCell(r));",
    // 名前の末尾に年が付く（セルと同じ文字列で並んでいることを見る）。
    "expect_year = byName.every((n) => n.endsWith('2027'));",
    // 会議名も時刻も同じなら、種別セレクトに並べる順（概要 → 論文）で割る。
    "const sameKind = [",
    "  row('SC', 'sc', 5, 'paper', 2027),",
    "  row('SC', 'sc', 5, 'abstract', 2027),",
    "  row('SC', 'sc', 5, 'journal', 2027),",
    "];",
    "const kinds = sameKind.slice().sort(compareDeadlineRows).map((r) => r.kind);",
    // 時刻が違う行は種別より先に関係なく時刻で並ぶ。
    "const times = [row('B', 'b', 9, 'abstract', null), row('A', 'a', 3, 'paper', null)];",
    "const byTime = times.slice().sort(compareDeadlineRows).map((r) => r.conf.key);",
    // 入力順を変えても結果が同じ（表の並びをビルド・描画順に依存させない）。
    "const many = [];",
    "for (let i = 0; i < 40; i += 1) {",
    "  many.push(row('会議' + (i % 5), 'k' + (i % 5), (i % 3) * 7, i % 2 ? 'paper' : 'abstract', 2027));",
    "}",
    "const forward = many.slice().sort(compareDeadlineRows).map((r) => [r.conf.key, r.kind, r.t].join(':'));",
    "const backward = many.slice().reverse().sort(compareDeadlineRows).map((r) => [r.conf.key, r.kind, r.t].join(':'));",
    // 降順は昇順の完全な逆順になる（矢印を押しただけで並びの意味が崩れない）。",
    "const asc = many.slice().sort(compareDeadlineRows);",
    "const desc = many.slice().sort((x, y) => compareDeadlineRows(y, x));",
    "console.log(JSON.stringify({",
    "  byName,",
    "  expect_year,",
    "  kinds,",
    "  byTime,",
    "  deterministic: JSON.stringify(forward) === JSON.stringify(backward),",
    "  reversed:",
    "    JSON.stringify(desc.map((r) => [r.conf.key, r.kind, r.t].join(':'))) ===",
    "    JSON.stringify(asc.map((r) => [r.conf.key, r.kind, r.t].join(':')).reverse()),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    byName: string[];
    expect_year: boolean;
    kinds: string[];
    byTime: string[];
    deterministic: boolean;
    reversed: boolean;
  };
  expect(out.byName).toEqual([
    "ネットワーク研究会 2027",
    "航空宇宙研究会 2027",
    "情報処理研究会 2027",
  ]);
  // カタカナ語は漢字語より前の段に出る（読み辞書を持たないため。仕様として固定する）。
  expect(out.expect_year).toBe(true);
  expect(out.kinds).toEqual(["abstract", "paper", "journal"]);
  expect(out.byTime).toEqual(["a", "b"]);
  expect(out.deterministic, "入力順で表の並びが変わる").toBe(true);
  expect(out.reversed, "降順が昇順の逆順になっていない").toBe(true);
});

it("共有URLに論文の本文を載せず、そのことを画面で伝える（SPEC §10）", () => {
  const app = siteRuntime("app.js");
  const html = siteHtmlRuntime();
  /* URL に書き出すのはモードと絞り込みだけ。論文のタイトル・概要・キーワードを
   * クエリに載せると、未発表の原稿がリンク・チャットプレビュー・閲覧履歴・サーバログに
   * 残る。将来「共有が復元されない」という報告で足されないよう、不変条件として固定する。 */
  const writeUrl = jsFunction(app, "writeUrl");
  const readUrl = jsFunction(app, "readUrl");
  expect(writeUrl).toContain('p.set("mode", state.mode)');
  expect(writeUrl.toLowerCase()).not.toMatch(/paper|abstract|keyword/);
  expect(readUrl.toLowerCase()).not.toMatch(/paper|abstract|keyword/);
  /* 論文の本文が入らないことは、気づかなければ「リンクが壊れた」に見える。
   * 入力する場所と、空のときに出る案内の両方に書く。 */
  expect(html).toContain("共有用URLには論文のタイトル・概要を含めません");
  expect(app).toContain("リンクで開いた場合はここが空になります");
  // 案内は推薦モードのpanelに出す（てびきは推薦画面では畳まれるため、あてにできない）。
  const panel = html.slice(
    html.indexOf('class="recommend-only"'),
    html.indexOf('id="recommendationCards"'),
  );
  expect(panel).toContain("共有用URLには論文のタイトル・概要を含めません");
});

it("開催地を日本語で引け、アクセント付きのつづりは ASCII で当たる（SPEC §7）", () => {
  /* 開催地は公式表記（`Seattle, USA` / `Montréal`）のまま変えない。日本人は「シアトル」
   * 「米国」「montreal」と打つので、検索語側だけで届かせる。実データで測る:
   * 変更前は `東京` 0 件（`tokyo` は 28 件）、`krakow` 0 件（表記は `Kraków`）だった。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const keys = (q) => { const m = Recommender.searchMatcher(q); return rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year); };",
    "const jp = keys('東京');",
    "const latin = keys('tokyo');",
    "const krakow = keys('krakow').length;",
    "const beikoku = keys('米国');",
    // 誤爆検査: 「米国」が出した行は、どれも hay に usa / america を持つ。
    "const m = Recommender.searchMatcher('米国');",
    // 別表記の寄せで当たり方が広がった結果、**語の途中**で当たっている行が混ざる
    // （`evomusart` の中に `usa`、`latin american` に `america`。2026-09-23 実測で
    // `米国` に収録 18 行の誤りが残る。語境界で照らす修法に変えるまで、ここでは
    // 寄せた語そのものが誤って入っていないことだけを見る）。
    // 誤爆の判定は画面に出る開催地表記で見る。`米国` は開催地の日本語化（`United States` →
    // `アメリカ`）と州表記（`San Diego, CA` → `カリフォルニア州`。上流は国名を書かない）で
    // 当たる行が増えていて、hay の英文字だけを見るとそれを誤爆として拾ってしまう。
    // ただし語の途中当たり（`evomusart` の中の `usa`、`latin american`）は別の話で、
    // 語境界で照らす修法に変えるまで語として現れる行は許す（§7 の既知の誤り）。
    "const US_STATES = ['カリフォルニア州', 'コロラド州', 'ハワイ州', 'ペンシルベニア州', 'ルイジアナ州', 'テネシー州', 'インディアナ州', 'オレゴン州'];",
    "const wordHit = (hay) => /(^|[^a-z0-9])(usa|america)($|[^a-z0-9])/.test(hay);",
    "const phantoms = rows.filter((r) => {",
    "  if (!m(r.hay)) return false;",
    "  const place = String(Recommender.placeJa(r.ed.place)).trim();",
    "  if (!place) return !wordHit(String(r.hay));",
    "  if (/(usa|america|united state|アメリカ)/i.test(place)) return false;",
    "  if (US_STATES.some((x) => place.includes(x))) return false;",
    "  return !wordHit(String(r.hay));",
    "}).length;",
    // 別表記の表に、収録カタログで 1 件も当たらない英文字表記を置いていないこと。
    "const src = readFileSync(" + JSON.stringify(join(site, "recommender.js")) + ", 'utf8');",
    "const i = src.indexOf('const PLACE_QUERY_ALIASES_JA = [');",
    "const table = eval(src.slice(i + 'const PLACE_QUERY_ALIASES_JA = '.length, src.indexOf('];', i) + 1));",
    "const alive = table.filter(([, latin]) => keys(latin).length > 0).length;",
    "console.log(JSON.stringify({",
    "  jp: jp.length, same: jp.join(',') === latin.join(','), krakow,",
    "  beikoku: beikoku.length, phantoms, total: table.length, alive,",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 120_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    jp: number;
    same: boolean;
    krakow: number;
    beikoku: number;
    phantoms: number;
    total: number;
    alive: number;
  };
  // 検査用のビルドは小型のカタログなので、「何件当たるか」ではなく
  // 日本語表記と英文字表記で**同じ行に届く**ことだけを見る（件数の実測は SPEC §7 に載せる。
  // アクセントを落とす動作は `tests/recommender.test.ts` の固定データで見る）。
  expect(out.jp, "「東京」が 0 件").toBeGreaterThan(0);
  expect(out.same, "日本語表記と英文字表記で出会う行が違う").toBe(true);
  expect(out.beikoku, "「米国」が 0 件").toBeGreaterThan(0);
  expect(out.phantoms, "別表記の寄せが誤爆している行がある").toBe(0);
});

it("別表記の表は、実際に新しい行を増やしている（SPEC §7）", () => {
  /* 開催地・主題の別表記は「打たれた語」と「画面に出る語」をつなぐためだけのもの。
   * 分野ラベルや日本語の開催地表記が既に同じ行を拾えているのに表へ足すと、
   * 説明だけが増えて当たり方が変わらない（例: `データベース`→database は追加 0 件だった）。
   * 収録カタログで、別表記側の語が**日本語表記だけのときより多く**の行を出すことを見る。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    `const rec = readFileSync(${JSON.stringify(join(site, "recommender.js"))}, 'utf8');`,
    "const rows = Recommender.candidateRows(DATA);",
    "const norm = (s) => String(s).normalize('NFKC').toLowerCase();",
    "const keys = (pred) => new Set(rows.filter(pred).map((r) => r.conf.key + '@' + r.ed.year));",
    "const grab = (name) => {",
    "  const head = 'const ' + name + ' = ';",
    "  const i = rec.indexOf(head);",
    "  const j = rec.indexOf('\\n    ];', i);",
    // Node の ESM 検出回避は検索の正典の注入と同じものを使う（`vmSafeSource`）。
    // 表の末尾が説明コメントで終わることがある（`//` の行に `]` を繋ぐとコメントに
    // 飲み込まれて構文エラーになる）。改行 after 閉じる。
    '  return eval(vmSafeSource(rec.slice(i + head.length, j)) + "\\n];");',
    "};",
    "const stats = (name) => {",
    "  let alive = 0;",
    "  let total = 0;",
    "  const dead = [];",
    "  for (const [ja, latin] of grab(name)) {",
    "    const m = Recommender.searchMatcher(latin);",
    "    const latinKeys = keys((r) => m(r.hay));",
    "    const jaKeys = keys((r) => norm(r.hay).includes(norm(ja)));",
    // 検査用のビルドは小型カタログなので、英文字側が 1 行も出ない条目は判定しない
    // （収録欠落ではなく、単にその会議が無いだけ）。当たった条目だけを見る。
    "    if (latinKeys.size === 0) continue;",
    "    total += 1;",
    "    const added = [...latinKeys].filter((k) => !jaKeys.has(k)).length;",
    "    if (added > 0) alive += 1;",
    "    else dead.push(ja + '→' + latin);",
    "  }",
    "  return { alive, total, dead };",
    "};",
    "console.log(JSON.stringify({",
    "  place: stats('PLACE_QUERY_ALIASES_JA'),",
    "  topic: stats('TOPIC_QUERY_ALIASES_JA'),",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync(
    "node",
    ["-e", `const vmSafeSource = ${vmSafeSource.toString()};\n${script}`],
    {
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    place: { alive: number; total: number; dead: string[] };
    topic: { alive: number; total: number; dead: string[] };
  };
  /* 別表記は「打てば行が増える」ためだけに置く。当たった条目で追加 0 件が続くなら、
   * その条目は説明だけを太らせる死んだ寄せなので、割愛する判断の材料にする
   * （`データベース`→database は実カタログで追加 0 件だったので実際に削った）。
   * ただし開催地の日本語化（`Kyoto, Japan` → `京都, 日本`）で日本語側が既に拾える場合が
   * あるため、0 件は少数派であることまでしか要求しない。 */
  for (const [name, stat] of Object.entries(out)) {
    expect(stat.total, `${name} の表で判定できる条目が無さすぎる`).toBeGreaterThan(3);
    expect(stat.dead.length).toBeLessThanOrEqual(Math.max(1, Math.ceil(stat.total * 0.2)));
  }
});

it("「国内研究会・国内シンポジウムのみ」で消えた行を件数欄が説明する（SPEC §7）", () => {
  /* このチェックは主催の区分で、日本の開催かどうかではない。付けたままだと
   * `Tokyo, 日本` と書かれた行が黙って消える（実測: 既定画面 477 行のうち 448 行が落ち、
   * そのうち 11 行は日本開催）。のぞいた件数を出さないと「国内に無かった」と誤解される。 */
  const filterSrc = jsFunction(siteRuntime(), "filter");
  const script = [
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    "function row(key, tags, place) {",
    "  return { kind: 'paper', est: false, cats: ['hpc'], rankPairs: [], hay: key,",
    "    tags: tags, t: now + DAY, tLast: now + DAY, ed: { place: place, deadlines: [] },",
    "    conf: { key: key } };",
    "}",
    "const rows = [",
    "  row('ieice-nolta', ['domestic-jp'], '京都大学 楽友会館（京都府）／オンライン'),",
    "  row('icde', [], 'Tokyo, 日本'),",
    "  row('sc', [], 'St. Louis, USA'),",
    "];",
    FILTER_RUNTIME_STUBS,
    "const run = (domestic) => new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "  'return (' + FILTER + ')')(FakeDate, DAY, rows,",
    "  { q: '', cats: [], kind: '', rank: '', win: 'all', est: false, domestic: domestic }, true, 'rem');",
    // `new Function` は絞り込み関数を返すので、ここから一度呼ぶ。
    "const shown = run(false)().map((r) => r.conf.key);",
    "run(true)();",
    "console.log(JSON.stringify({ shown, domestic: hiddenCounts.domestic }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as { shown: string[]; domestic: number };
  // 同じ締切時刻なので、並び順は表に出る会議名の昇順（SPEC §7 のタイ処理）。
  expect(out.shown).toEqual(["icde", "ieice-nolta", "sc"]);
  // チェックを付けると国内研究会の 1 行だけになり、のぞいた 2 行が件数へ出る。
  expect(out.domestic, "のぞいた件数が出ていない").toBe(2);

  const app = siteRuntime();
  // 件数欄の実装がその件数を出していること。
  expect(app).toContain("国内研究会・国内シンポジウム以外 ${countJa(hidden.domestic)} 件");
  // 説明は「日本の開催とは別物」と、戻し方（検索で引く）を同じ箇所に書く。
  const html = siteHtmlRuntime();
  const dd = html.slice(html.indexOf("<dt>国内</dt>"), html.indexOf("<dt>種別</dt>"));
  expect(dd).toContain("日本の開催かどうかとは別物");
  expect(dd).toContain("Tokyo, 日本");
  expect(dd).toContain("のぞいた件数");
  // チェックボックス自体にも同じ注意を出す（てびきは畳まれているので）。
  const box = html.slice(html.indexOf('id="domestic"'), html.indexOf('id="online"'));
  expect(box).toContain("日本の開催かどうかは関係ありません");
  expect(box).toContain("検索に「東京」");
});

it("「オンライン参加可のみ」で出ない理由を 2 通りに分けて数える（SPEC §7）", () => {
  /* この絞り込みは会場表記の記述だけで動く。チェックした人から見て「出ない」理由は
   * (a) 対面の記述しかない、(b) **開催地自体が未確認**で読みようがない、の 2 つある。
   * (b) を混ぜると「オンライン参加を認めていない会議」と誤解される。
   * 実測: 既定画面 477 行のうち条件に書くのは 15 行だけで、のぞく 462 件のうち 110 行は
   * 開催地が空だった。 */
  const filterSrc = jsFunction(siteRuntime(), "filter");
  const script = [
    `const countJa = (${jsFunction(siteRuntime(), "countJa")});`,
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    "function row(key, place) {",
    "  return { kind: 'paper', est: false, cats: ['hpc'], rankPairs: [], tags: [], hay: key,",
    "    t: now + DAY, tLast: now + DAY, ed: { place: place, deadlines: [] }, conf: { key: key } };",
    "}",
    "const rows = [",
    "  row('hybrid', 'Alicante, Spain / Online'),",
    "  row('onsite', 'Kyoto, 日本'),",
    "  row('unknown', ''),",
    "];",
    FILTER_RUNTIME_STUBS,
    "const run = (online) => new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "  'return (' + FILTER + ')')(FakeDate, DAY, rows,",
    "  { q: '', cats: [], kind: '', rank: '', win: 'all', est: false, online: online }, true, 'rem');",
    "const all = run(false)().length;",
    "const shown = run(true)().map((r) => r.conf.key);",
    "console.log(JSON.stringify({",
    "  all, shown, online: hiddenCounts.online, unknown: hiddenCounts.onlinePlaceUnknown,",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    all: number;
    shown: string[];
    online: number;
    unknown: number;
  };
  expect(out.all).toBe(3);
  expect(out.shown).toEqual(["hybrid"]);
  expect(out.online, "のぞいた行数が出ていない").toBe(2);
  expect(out.unknown, "開催地が未確認の行数を分けていない").toBe(1);

  const app = siteRuntime();
  expect(app).toContain("オンライン参加の記載がない ${countJa(hidden.online)} 件");
  expect(app).toContain("うち開催地が未確認 ${countJa(hidden.onlinePlaceUnknown)} 件");
  // チェックボックスの tool tip にも、対面を断定していないことと確認先を書く。
  const html = siteHtmlRuntime();
  const box = html.slice(html.indexOf('id="online"'), html.indexOf('id="est"'));
  expect(box).toContain("記述が無い行は対面だと判定していません");
  expect(box).toContain("開催地が未確認");
  const dd = html.slice(
    html.indexOf("<dt>オンライン参加可</dt>"),
    html.indexOf("<dt>会期のみ・締切未定</dt>"),
  );
  expect(dd).toContain("オンライン参加が無いのだと誤解しないでください");
});

it("「締切まで N 日以内」の窓で外れた件数を件数欄に出す（SPEC §7）", () => {
  /* 窓は選択欄の下側にも効くのに、件数欄は過去の締切・種別・推定しか言わなかった。
   * 「7 日以内」を選ぶと実測で対象 477 行のうち 39 行しか出ず、のこり 438 行が黙って
   * 消えるので「今週は収録が薄い」と誤解される。外れた件数と戻し方を出す。 */
  const filterSrc = jsFunction(siteRuntime(), "filter");
  const script = [
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    "function row(key, offset) {",
    "  return { kind: 'paper', est: false, cats: ['hpc'], rankPairs: [], tags: [], hay: key,",
    "    t: now + offset * DAY, tLast: now + offset * DAY,",
    "    ed: { place: 'Kyoto, 日本', deadlines: [] }, conf: { key: key } };",
    "}",
    "const rows = [row('soon', 2), row('far', 40), row('old', -40)];",
    FILTER_RUNTIME_STUBS,
    "const run = (win, past) => new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "  'return (' + FILTER + ')')(FakeDate, DAY, rows,",
    "  { q: '', cats: [], kind: '', rank: '', win: win, est: false, past: past }, true, 'rem');",
    "const all = run('all', false)().length;",
    "const narrow = run('7d', false)().map((r) => r.conf.key);",
    "const narrowWindow = hiddenCounts.window;",
    // 「過去の締切も表示」と併用すると窓は前後対称になる（下限側も同じ計数にまとめる）。
    "const both = run('7d', true)().map((r) => r.conf.key);",
    "const bothWindow = hiddenCounts.window;",
    "console.log(JSON.stringify({ all, narrow, narrowWindow, both, bothWindow }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    all: number;
    narrow: string[];
    narrowWindow: number;
    both: string[];
    bothWindow: number;
  };
  // 窓を「かまわない」にしても、40 日前の行は既定では「過去の締切」の内訳で落ちる。
  expect(out.all).toBe(2);
  // 7 日以内: 40 日後の行が上限側で外れる（40 日前の行は「過去の締切」側の内訳なので窓に数えない）。
  expect(out.narrow).toEqual(["soon"]);
  expect(out.narrowWindow, "窓で外れた件数が出ていない").toBe(1);
  // 過去表示と併用: 下限側（40 日前）も同じ窓として数える。
  expect(out.both).toEqual(["soon"]);
  expect(out.bothWindow, "対称窓の下限側を窓に数えていない").toBe(2);

  const app = siteRuntime();
  expect(app).toContain("`「締切まで ${Number.parseInt(state.win, 10)} 日以内」を超える");
  // 選択欄の表記（「7 日以内」）とその戻し方を選んで書く。
  const html = siteHtmlRuntime();
  const dd = html.slice(
    html.indexOf("<dt>締切まで</dt>"),
    html.indexOf("<dt>過去の締切も表示</dt>"),
  );
  expect(dd).toContain("「締切まで 7 日以内」を超える N 件");
  expect(dd).toContain("収録が薄いわけではありません");
  expect(dd).toContain("「かまわない」");
});

it("地域まとめの構成員は、収録カタログの開催地に現れる（SPEC §7）", () => {
  /* `ヨーロッパ` → 国名、という寄せは「画面の開催地に出る語」だけで作る。
   * 収録に無い国名を混ぜると、件数欄の説明だけが長くなって当たり方が変わらない
   * （§7 の別表記と同じ基準）。構成員が実際の開催地に現れることと、
   * 各地域の語で実際に一行以上当たることを見る。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    // 検査用ビルドのカタログは小さい（小型 fixtures）ので、開催地の語は収録カタログ
    // （`data/snapshot.json`）で見る。件数の検査だけ実行ビルドのコードを使う。
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(
      new URL("../data/snapshot.json", import.meta.url).pathname,
    )}, 'utf8'));`,
    `const rec = readFileSync(${JSON.stringify(join(site, "recommender.js"))}, 'utf8');`,
    "const head = 'const CONTINENT_READINGS = ';",
    "const i = rec.indexOf(head);",
    "const j = rec.indexOf('\\n    ];', i);",
    // 表は `EUROPE_JA` などの変数で国名リストを共有しているので、その定義も eval に入れる。
    'const decls = (rec.match(/const [A-Z_]+_JA =\\s*\\n?\\s*(?:`[^`]*`|"[^"]*");/g) || [])',
    "  .map((d) => vmSafeSource(d))",
    "  .join('\\n');",
    "const table = eval(`${decls}\\n${vmSafeSource(rec.slice(i + head.length, j))}\\n];`);",
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const norm = (s) => String(s).normalize('NFKC').toLowerCase();",
    "const places = rows.map((r) => norm(Recommender.placeJa(r.ed.place) + ' ' + String(r.ed.place || '')));",
    "const missing = [];",
    "const emptyRegions = [];",
    "const seen = new Set();",
    "for (const entry of table) {",
    "  const heading = entry[0];",
    "  if (seen.has(heading)) continue;",
    "  seen.add(heading);",
    "  for (const member of String(entry[2]).split(',')) {",
    "    if (!places.some((p) => p.includes(norm(member)))) missing.push(heading + '→' + member);",
    "  }",
    "  const m = Recommender.searchMatcher(heading, now);",
    "  if (!rows.some((r) => m(r.hay))) emptyRegions.push(heading);",
    "}",
    "console.log(JSON.stringify({ regions: [...seen], missing, emptyRegions }));",
    "})();",
  ].join("\n");
  const proc = spawnSync(
    "node",
    ["-e", `const vmSafeSource = ${vmSafeSource.toString()};\n${script}`],
    {
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    regions: string[];
    missing: string[];
    emptyRegions: string[];
  };
  expect(out.regions.length).toBeGreaterThanOrEqual(8);
  expect(out.missing, `収録の開催地に現れない構成員: ${out.missing.join(" ")}`).toEqual([]);
  expect(out.emptyRegions, `1 行も当たらない地域の語: ${out.emptyRegions.join(" ")}`).toEqual([]);
});

it("ビルド後の照合式は英字語を語の途中では当てない（SPEC §7）", () => {
  /* 語境界の照合は `matchFoldedGroups` の規則で、一覧の絞り込みはビルド後の
   * `recommender.js` を通る。ここで見ておくのは「実装が効いて shipped の挙動が直っているか」。
   * `米国` が語の途中当たりでパナマ・ドイツの会議を出していた実発生をそのまま固定する。 */
  const script = [
    "(async () => {",
    "const { default: Recommender } = await import(",
    `  ${JSON.stringify(`file://${join(site, "recommender.js")}`)},`,
    ");",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const hays = [",
    "  'evomusart 2027 16th international conference mainz, ドイツ',",
    "  'ieice trans. inf. & syst. special section on log data usage techniques',",
    "  'lascas ieee latin american symposium on circuits and systems panama city, パナマ',",
    "  'sigcomm 2027 alexandria, va, usa アメリカ',",
    "  'asplos vienna, オーストリア computer-vision computer vision',",
    "];",
    "const match = (q) => {",
    "  const m = Recommender.searchMatcher(q, now);",
    "  return hays.map((hay) => (m(hay) ? 1 : 0));",
    "};",
    "console.log(JSON.stringify({",
    "  us: match('米国'),",
    "  eu: match('ヨーロッパ'),",
    "  vision: match('視覚'),",
    "  sc: match('sc'),",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 120_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    us: number[];
    eu: number[];
    vision: number[];
    sc: number[];
  };
  // 語の途中当たり（evomusart / usage / latin american）は落ち、語として出る行だけ残る。
  expect(out.us, "`米国` の語の途中当たりが残っている").toEqual([0, 0, 0, 1, 0]);
  // 地域まとめは画面に出る日本語の国名で当たる（Mainz は `ドイツ`、Wien は `オーストリア`）。
  expect(out.eu).toEqual([1, 0, 0, 0, 1]);
  // 語頭の一致（computer-vision のハイフン越え）は生かす。
  expect(out.vision).toEqual([0, 0, 0, 0, 1]);
  // 1〜2 文字は従来どおり前後の境界を見る。
  expect(out.sc).toEqual([0, 0, 0, 0, 0]);
});

it("数字で打った日付が、暦日の日本語表記と同じ行に当たる（SPEC §7）", () => {
  /* 一覧の絞り込みはビルド後の `recommender.js` を通る。検査用のカタログの日付をそのまま
   * 数字表記（`8/22`・`2026/8/22`）に直して、日本語表記（`8月22日`）と同じ行集合になることを
   * 見る。固定の日付を書くと、このビルドにその日が無いときに空振りで通ってしまうため、
   * 実際に締切のある日を選ぶ。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    // JST の暦日で最多数の行を持つ日を使う。
    "const jst = (t) => new Date(t + 9 * 60 * 60 * 1000);",
    "const counts = new Map();",
    "rows.forEach((r) => {",
    "  if (Number.isFinite(r.t)) {",
    "    const d = jst(r.t);",
    "    const k = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;",
    "    counts.set(k, (counts.get(k) || 0) + 1);",
    "  }",
    "});",
    "const [year, month, day] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split('-');",
    "const keys = (q) => {",
    "  const m = Recommender.searchMatcher(q, now);",
    "  return rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year + '@' + r.kind).sort();",
    "};",
    "const ja = keys(`${month}月${day}日`);",
    "const jaYear = keys(`${year}年${month}月${day}日`);",
    "console.log(JSON.stringify({",
    "  date: `${year}/${month}/${day}`,",
    "  sameMonthDay: JSON.stringify(keys(`${month}/${day}`)) === JSON.stringify(ja),",
    "  sameMonthDayDash: JSON.stringify(keys(`${month}-${day}`)) === JSON.stringify(ja),",
    "  sameWithYear: JSON.stringify(keys(`${year}/${month}/${day}`)) === JSON.stringify(jaYear),",
    "  sameYearMonth: JSON.stringify(keys(`${year}-${month}`)) === JSON.stringify(keys(`${year}年${month}月`)),",
    "  hits: ja.length,",
    "  invalidUntouched: JSON.stringify(Recommender.queryTokenGroups('13/45', now)),",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 120_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    date: string;
    sameMonthDay: boolean;
    sameMonthDayDash: boolean;
    sameWithYear: boolean;
    sameYearMonth: boolean;
    hits: number;
    invalidUntouched: string;
  };
  expect(out.hits, `検査用カタログに ${out.date} の締切が無い`).toBeGreaterThan(0);
  expect(out.sameMonthDay, `${out.date} を「M/D」で引くと行集合が違う`).toBe(true);
  expect(out.sameMonthDayDash, `${out.date} を「M-D」で引くと行集合が違う`).toBe(true);
  expect(out.sameWithYear, `${out.date} を「Y/M/D」で引くと行集合が違う`).toBe(true);
  expect(out.sameYearMonth, `${out.date} を「Y-M」で引くと行集合が違う`).toBe(true);
  // ありえない日付は展開しない（会議名の数字の取り合わせを壊さない）。
  expect(out.invalidUntouched).toBe('[["13/45"]]');
});

it("画面に出る状態の語（推定）が一覧の検索でも引ける（SPEC §7）", () => {
  /* 締切セルに `推定` のバッジを出し、CSV にも同じ語を書いていたのに、検索用の文字列に
   * 入れていなかったため「推定」で 1 件も引けなかった（2026-09-23 実測: 収録 134 件が 0 件）。
   * 画面に出る語は検索でも引ける、をビルド後の成果物で確認する。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const m = Recommender.searchMatcher('推定', now);",
    "const hit = rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year + '@' + r.kind).sort();",
    "const flagged = rows",
    "  .filter((r) => r.ed.estimated === true)",
    "  .map((r) => r.conf.key + '@' + r.ed.year + '@' + r.kind)",
    "  .sort();",
    // バッジ語を共有していること: 推定行の hay と CSV の状態欄が同じ語を書く。
    "const est = rows.find((r) => r.ed.estimated === true);",
    "const csv = est ? Recommender.deadlinesToCsv([est], now) : '';",
    "console.log(JSON.stringify({",
    "  flagged: flagged.length,",
    "  sameSet: JSON.stringify(hit) === JSON.stringify(flagged),",
    "  hayHasWord: est ? String(est.hay).includes('推定') : false,",
    "  csvHasWord: csv.includes('推定'),",
    "  noFalsePositive: rows.filter((r) => !r.ed.estimated && String(r.hay).includes('推定')).length,",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 120_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    flagged: number;
    sameSet: boolean;
    hayHasWord: boolean;
    csvHasWord: boolean;
    noFalsePositive: number;
  };
  expect(out.flagged, "検査用カタログに推定の行が無い").toBeGreaterThan(0);
  expect(out.sameSet, "「推定」で引ける行と推定バッジの行が違う").toBe(true);
  expect(out.hayHasWord, "推定行の検索用文字列に「推定」が無い").toBe(true);
  expect(out.csvHasWord, "CSV の状態欄と検索の語がズレている").toBe(true);
  expect(out.noFalsePositive, "推定でない行が「推定」で当たる").toBe(0);
  // 件数欄は、落ちた行の出し方まで同じ行に書く（回復経路を検索語から探させない）。
  const app = siteRuntime("app.js");
  expect(app).toContain("件（「推定締切を含める」で出ます）");
});

it("地方名で引くと、開催市だけ書かれた国内行も漏れない（SPEC §7）", () => {
  /* 国内の国際会議の開催地は上流どおりの英字表記（`Tokyo, Japan`）で都道府県が書かれない。
   * 地方名を都道府県に展開するだけでは取りこぼしていた（実測で `東京` 28 件に対し `関東` 1 件）。
   * **収録カタログ（`data/snapshot.json`）**で、都市→地方の対応をここでおいて、その地方の語で
   * その行が引けることを見る（検査用のビルドはカタログが小さく空振りするため）。
   * 新しい都市が増えたときはこれが失敗するので、表を足す案内になる。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    // 開催地の語はビルド後の成果物から、行は収録カタログから読む。
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    `const src = readFileSync(${JSON.stringify(join(site, "recommender.js"))}, 'utf8');`,
    "const i = src.indexOf('const PREFECTURE_CITIES_JA = [');",
    "const table = eval(src.slice(i + 'const PREFECTURE_CITIES_JA = '.length, src.indexOf('];', i) + 1));",
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    // 都市 → 地方（表の書き写しではなく、検査側で独立に言い直した対応）。
    "const REGION_OF_CITY = {",
    "  tokyo: '関東', yokohama: '関東', tsukuba: '関東',",
    "  kyoto: '関西', osaka: '関西', kobe: '関西', nara: '関西',",
    "  nagoya: '中部', gifu: '中部', fukui: '中部', kanazawa: '中部',",
    "  fukuoka: '九州', nagasaki: '九州', okinawa: '九州', miyakojima: '九州',",
    "};",
    "const hitKeys = (q) => {",
    "  const m = Recommender.searchMatcher(q, now);",
    "  return new Set(rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year + '@' + r.kind));",
    "};",
    "const regionHits = {};",
    "Object.values(REGION_OF_CITY).forEach((region) => {",
    "  if (!regionHits[region]) regionHits[region] = hitKeys(region);",
    "});",
    "const missing = [];",
    "const citiesSeen = new Set();",
    "rows.forEach((r) => {",
    "  const place = String(r.ed.place || '').toLowerCase();",
    "  if (!/japan|日本/.test(String(r.ed.place) + String(Recommender.placeJa(r.ed.place)))) return;",
    "  const city = Object.keys(REGION_OF_CITY).find((c) => place.includes(c));",
    "  if (!city) return;",
    "  citiesSeen.add(city);",
    "  const key = r.conf.key + '@' + r.ed.year + '@' + r.kind;",
    "  if (!regionHits[REGION_OF_CITY[city]].has(key))",
    "    missing.push(`${city} (${String(r.ed.place)}) が ${REGION_OF_CITY[city]} で引けない`);",
    "});",
    // 表に、収録カタログで 1 件も当たらない都市を置いていないこと。
    "const dead = [];",
    "table.forEach(([, cities]) => {",
    "  String(cities).split(',').forEach((city) => {",
    "    if (hitKeys(city).size === 0) dead.push(city);",
    "  });",
    "});",
    "console.log(JSON.stringify({",
    "  cities: citiesSeen.size, tableRows: table.length, missing, dead,",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 120_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    cities: number;
    tableRows: number;
    missing: string[];
    dead: string[];
  };
  // 検査が空振りで通らないように、実際に都市の行を拾えている件数を見る。
  expect(out.cities, "収録カタログで都市の行を 1 つも拾えていない").toBeGreaterThanOrEqual(14);
  expect(out.missing, "地方名で引けない国内行がある:\n" + out.missing.join("\n")).toEqual([]);
  expect(out.dead, "都市の表に、収録カタログで当たらない語がある").toEqual([]);
});

it("参加形式の語で引いた行が、チェックボックスで出る行と一致する（SPEC §7）", () => {
  /* `オンライン参加可` はチェックボックスの語。その語で検索した人が同じ行にたどり着けること、
   * 判定が `placeOffersOnline` 1本で決まっていること（別の書き方をするとズレる）を、
   * 収録カタログの行で見る。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const key = (r) => r.conf.key + '@' + r.ed.year + '@' + r.kind;",
    "const byPredicate = rows.filter((r) => Recommender.placeOffersOnline(r.ed.place)).map(key).sort();",
    "const byQuery = (q) => {",
    "  const m = Recommender.searchMatcher(q, now);",
    "  return rows.filter((r) => m(r.hay)).map(key).sort();",
    "};",
    "const phrase = byQuery('オンライン参加可');",
    "const hybrid = byQuery('ハイブリッド');",
    "const outside = hybrid.filter((k) => !byPredicate.includes(k));",
    "console.log(JSON.stringify({",
    "  predicate: byPredicate.length,",
    "  sameAsPhrase: JSON.stringify(phrase) === JSON.stringify(byPredicate),",
    "  hybrid: hybrid.length,",
    "  hybridOutside: outside.slice(0, 3),",
    "  noFalseFacet: rows.filter((r) => !Recommender.placeOffersOnline(r.ed.place) && String(r.hay).includes('オンライン参加可')).length,",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 120_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    predicate: number;
    sameAsPhrase: boolean;
    hybrid: number;
    hybridOutside: string[];
    noFalseFacet: number;
  };
  expect(out.predicate, "収録カタログにオンライン参加可の行が無い").toBeGreaterThan(0);
  expect(out.sameAsPhrase, "「オンライン参加可」で引ける行とチェックボックスの行が違う").toBe(true);
  expect(out.hybrid, "「ハイブリッド」が 0 件").toBeGreaterThan(0);
  expect(out.hybridOutside, "「ハイブリッド」がオンライン参加の記載のない行を出した").toEqual([]);
  expect(out.noFalseFacet, "オンライン参加可の語が該当外の行に入っている").toBe(0);
});

it("チェックボックスの語と種別の言い方を実データで引ける（SPEC §7）", () => {
  /* 「国内研究会」はチェックボックスの語、「アブストラクト締切」は種別セレクトの語に
   * 「締切」を付けた言い方。どちらも 0 件で止まっていた（2026-09-23 実測:
   * `国内研究会` 0 件 / `アブストラクト締切` 0 件）。収録カタログの行で見る。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const key = (r) => r.conf.key + '@' + r.ed.year + '@' + r.kind;",
    "const keys = (q) => {",
    "  const m = Recommender.searchMatcher(q, now);",
    "  return rows.filter((r) => m(r.hay)).map(key).sort();",
    "};",
    // 国内研究会の語は、domestic-jp の行で名前に研究会を含む行と一致すること。
    "const expectedDomestic = rows",
    "  .filter((r) => (r.conf.tags || []).indexOf('domestic-jp') >= 0)",
    "  .filter((r) => String(r.conf.title || '').includes('研究会'))",
    "  .map(key)",
    "  .sort();",
    "const domestic = keys('国内研究会');",
    // 語を、該当しない行に入れていないこと（シンポジウムとワークショップは別々の語）。
    "const wrongWords = rows.filter((r) => {",
    "  const hay = String(r.hay);",
    "  const title = String(r.conf.title || '');",
    "  const words = [];",
    "  if (hay.includes('国内シンポジウム')) words.push('シンポジウム');",
    "  if (hay.includes('国内ワークショップ')) words.push('ワークショップ');",
    "  return words.some((w) => !title.includes(w));",
    "}).length;",
    // 種別の複合語は、単語で引いたときと同じ行集合になること。",
    "const kindPairs = [",
    "  ['アブストラクト締切', 'アブストラクト'],",
    "  ['抄録締切', '抄録'],",
    "  ['要旨締切', '要旨'],",
    "  ['全文締切', '全文'],",
    "];",
    "const kindMismatch = kindPairs",
    "  .filter(([phrase, word]) => JSON.stringify(keys(phrase)) !== JSON.stringify(keys(word)))",
    "  .map(([phrase]) => phrase);",
    "console.log(JSON.stringify({",
    "  domestic: domestic.length,",
    "  sameDomestic: JSON.stringify(domestic) === JSON.stringify(expectedDomestic),",
    "  wrongWords,",
    "  abstractRows: keys('アブストラクト締切').length,",
    "  kindMismatch,",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 120_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    domestic: number;
    sameDomestic: boolean;
    wrongWords: number;
    abstractRows: number;
    kindMismatch: string[];
  };
  expect(out.domestic, "「国内研究会」が 0 件").toBeGreaterThan(0);
  expect(out.sameDomestic, "「国内研究会」で引ける行が国内の研究会行と違う").toBe(true);
  expect(out.wrongWords, "名前にない参加形式の語が行に入っている").toBe(0);
  expect(out.abstractRows, "「アブストラクト締切」が 0 件").toBeGreaterThan(0);
  expect(
    out.kindMismatch,
    "複合語で引くと単語と違う行集合になる: " + out.kindMismatch.join(","),
  ).toEqual([]);
  // 常時受付: 行の中で 2 つの名前が見えていた（日時セルだけ「随時受付」）。画面に出す語を統一する。
  const app = siteRuntime("app.js");
  const rec = siteRuntime("recommender.js");
  expect(app, "一覧に「随時受付」が残っている").not.toContain("随時受付");
  expect(rec, "CSV の常時受付表記が「随時受付」に戻っている").not.toContain('"随時受付";');
});

it("収録 5 行以上の開催都市は、カタカナの入力でたどれないものがない（SPEC §7）", () => {
  /* 海外の出張先はカタカナで覚えるのが普通なのに、収録カタログに現れる都市の多くが
   * 日本語表記の表に無く、カタカナで打つと 0 件だった（2026-09-23 実測: 収録 5 行以上の
   * 都市のうち 123 種が表に無かった）。**収録カタログ側**から検査するので、都市が増えて
   * 表が追いついていないときに落ちる（＝足す案内になる）。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    `const src = readFileSync(${JSON.stringify(join(site, "recommender.js"))}, 'utf8');`,
    "const i = src.indexOf('const PLACE_QUERY_ALIASES_JA = [');",
    "const aliases = eval(src.slice(i + 'const PLACE_QUERY_ALIASES_JA = '.length, src.indexOf('];', i) + 1));",
    /* 都市語はアクセント付きで収録されている（`Cancún` `Malmö` `Kraków` など）。
     * 検索側はアクセントを捨てるので、数え上げもアクセント記号を除いて行わないと、
     * **アクセント付きの都市が検査から丸ごと抜ける**（2026-09-23 に実測で発覚:
     * `Cancún` は収録 23 行あったのに ASCII の正規表現で弾かれて検査されていなかった）。 */
    "const FOLD = (v) => String(v).normalize('NFKC').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase();",
    "const cityOf = (r) => {",
    "  const raw = String(r.ed.place || '').trim();",
    "  if (!raw) return '';",
    "  const segment = raw.split('/')[0];",
    "  const at = segment.indexOf(',');",
    "  return FOLD(at < 0 ? segment : segment.slice(0, at));",
    "};",
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    // 都市語を数える。開催形式の語と会場名（大学・会議センターなど）は都市ではないので除く。
    "const NOT_CITY = /university|center|centre|centre|universitat|resort|foundation|institute|campus|hall|online|virtual|tbd|sar$|california/i;",
    "const counts = new Map();",
    "rows.forEach((r) => {",
    "  const raw = String(r.ed.place || '').trim();",
    "  if (!raw) return;",
    "  const segment = raw.split('/')[0];",
    "  const at = segment.indexOf(',');",
    "  const city = FOLD(at < 0 ? segment : segment.slice(0, at));",
    // アクセント記号を除いた後なので、ラテン文字の都市名はここで拾える（ギリシャ文字・キリル文字の
    // 表記は引き続き数えない。検索のアクセント除去と同じ範囲に揃えている）。
    "  if (!city || !/^[a-z][a-z .'-]*$/.test(city)) return;",
    "  if (NOT_CITY.test(city) || city.length < 4) return;",
    "  const key = city;",
    "  counts.set(key, (counts.get(key) || 0) + 1);",
    "});",
    /* 「その都市の行が 1 行以上当たる日本語の語があるか」を、表の条目ごとに確かめる。
     * ただ語を打って当たった行の都市を覚えるやり方だと、`Anaheim, California` が
     * 「カリフォルニア」でカバーされてしまい、都市の名前では引けないまま緑になる
     * （2026-09-23 に実測で通ってしまい、検査として弱かった）。表の条目が示す
     * 英文字のつづりが都市語に現れていて、かつその語でその行に届くことを見る。 */
    "const covered = new Set();",
    "aliases.forEach(([ja, latin]) => {",
    "  const word = String(ja);",
    "  const want = String(latin).toLowerCase();",
    "  const m = Recommender.searchMatcher(word, now);",
    "  rows.forEach((r) => {",
    "    const city = cityOf(r);",
    "    if (!city || city.indexOf(want) < 0) return;",
    "    if (m(r.hay)) covered.add(city);",
    "  });",
    "});",
    "const uncovered = [...counts.entries()]",
    "  .filter(([, n]) => n >= 5)",
    "  .filter(([city]) => !covered.has(city))",
    "  .map(([city, n]) => `${city} (${n} 行)`)",
    "  .sort();",
    // 表の語が、カタログで本当に当たる語だけか（死んだ条目を置かない）。
    // ただし **寄せ先の英文字がこのカタログに 1 行も無い条目は判定しない** — それは死んだ
    // 条目ではなく、単にその会議がこのビルドに無いだけ（「別表記の表は、実際に新しい行を
    // 増やしている」検査と同じ約束。例: `会津若松` の行は上流の取得状況で増える）。
    // 実際に当たるかの判定は、収録に依存しない形の検査（日本開催の行の検査）で見る。
    "const dead = [];",
    "let unjudged = 0;",
    "aliases.forEach(([ja, latin]) => {",
    "  const ml = Recommender.searchMatcher(String(latin), now);",
    "  if (rows.filter((r) => ml(r.hay)).length === 0) {",
    "    unjudged += 1;",
    "    return;",
    "  }",
    "  const m = Recommender.searchMatcher(ja, now);",
    "  if (rows.filter((r) => m(r.hay)).length === 0) dead.push(String(ja));",
    "});",
    "console.log(JSON.stringify({",
    "  cities: counts.size, uncovered, dead: dead.slice(0, 6), unjudged,",
    " }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    cities: number;
    uncovered: string[];
    dead: string[];
    unjudged: number;
  };
  expect(out.cities, "カタログから都市を 1 つも数え上げられない").toBeGreaterThan(100);
  expect(out.uncovered, "カタカナで引けない開催都市がある:\n" + out.uncovered.join("\n")).toEqual(
    [],
  );
  expect(out.dead, "日本語表記の表に、1 件も当たらない語がある").toEqual([]);
  // 判定を飛ばした条目が多すぎるなら（表が実データから浮いている）、この目検が効かなくなる。
  expect(
    out.unjudged,
    "このビルドに無い都市への寄せが多すぎる（表が実データから浮いている）",
  ).toBeLessThan(30);
});

it("早め絞り込みのボタンは、押した条件だけを出し入れし、押されたまま見える（SPEC §7）", () => {
  /* 変更前: ボタンを押すたびに検索語・締切種別・推定まで初期値へ戻り、点灯は他の条件が
   * すべて空のときだけだった。`スパコン` と打ってから「オンライン参加可」を押すと
   * 検索語が消えて 15 件（無関係なオンライン会議）が並び、押したボタンは点かない。
   * ここはビルド後の成果物で、(1) 検索語を消さないこと (2) 点灯が状態を見ること
   * (3) ボタンの名前と条件表がズレていないこと を見る。
   * 出し入れの規則そのものは `tests/recommender.test.ts` で実行して確かめる。 */
  const app = siteRuntime("app.js");
  const html = readFileSync(join(site, "index.html"), "utf8");

  const presetBody = app.slice(
    app.indexOf("window.applyPreset = "),
    app.indexOf("// Column Sorting"),
  );
  expect(presetBody, "ボタンが状態をまるごと戻している（正本は recommender）").toContain(
    "presetNextSelection",
  );
  expect(presetBody, "ボタンが検索語を消している").not.toContain('q: ""');
  expect(presetBody, "ボタンが締切種別を消している").not.toContain('kind: ""');

  const activeBody = jsFunction(app, "updatePresetActive");
  expect(activeBody, "点灯が recommender の判定を見ていない").toContain("presetIsActive");
  expect(activeBody, "他の条件が空のときだけ点く判定が残っている").not.toContain("!state.q");

  // 一覧のボタンと条件表の名前がズレると、押しても効かないボタンが黙って増える。
  const buttons = [...html.matchAll(/data-preset="([^"]+)"/g)].map((m) => m[1]).sort();
  expect(buttons.length).toBeGreaterThan(3);
  const script = [
    "(async () => {",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const buttons = ${JSON.stringify(buttons)};`,
    "const empty = { win: 'all', rank: '', cats: [], domestic: false, online: false };",
    // 名前のないボタンは状態を変えられない（黙って効かないボタンにしない）。
    "const inert = buttons.filter((b) => {",
    "  const next = Recommender.presetNextSelection(b, empty);",
    "  return JSON.stringify(next) === JSON.stringify(empty);",
    "});",
    // 二度押しで戻る（押した意味を取り消せる）。
    "const noUndo = buttons.filter((b) => {",
    "  const once = Recommender.presetNextSelection(b, empty);",
    "  return JSON.stringify(Recommender.presetNextSelection(b, once)) !== JSON.stringify(empty);",
    "});",
    // 押している間は点く（他の条件を足した画面でも）。
    "const neverLit = buttons.filter((b) => {",
    "  const once = Recommender.presetNextSelection(b, empty);",
    "  // 他の条件を足した画面（検索語はここで渡さないが、分野・ランク・窓を埋めた状態）でも点くか。",
    "  return !Recommender.presetIsActive(b, once) || !Recommender.presetIsActive(b, {",
    "    ...once,",
    "    cats: b === 'hpc_sys' ? once.cats : ['security'],",
    "    rank: b === 'a_star' ? once.rank : 'A',",
    "    win: b === '7d' ? once.win : '90d',",
    "  });",
    "});",
    "console.log(JSON.stringify({ inert, noUndo, neverLit }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as { inert: string[]; noUndo: string[]; neverLit: string[] };
  expect(out.inert, "押しても効かない早め絞り込みのボタンがある: " + out.inert.join(", ")).toEqual(
    [],
  );
  expect(out.noUndo, "もう一度押しても外せないボタンがある: " + out.noUndo.join(", ")).toEqual([]);
  expect(
    out.neverLit,
    "他の条件を足した画面で点かないボタンがある: " + out.neverLit.join(", "),
  ).toEqual([]);
});

it("かな入力の地名が、漢字で引ける行を取りこぼさない（SPEC §7）", () => {
  /* 漢字見出しは英文字表記の寄せ（`東京` ↔ `tokyo`）を持つが、かな見出しはその漢字へ
   * 寄せるだけだった。開催地の公式表記はそのまま残す設計なので、**漢字で出てかなで
   * 出ない**行が黙って生まれた（2026-09-23 実測: 東京 28 件 / `とうきょう` 1 件、
   * 京都 18 件 / `きょうと` 2 件、`なら` 0 件）。
   * 読み表の条目ごとに、**漢字で出る行をかなでも出す**ことを収録カタログで見る。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const src = readFileSync(${JSON.stringify(join(site, "recommender.js"))}, 'utf8');`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const i = src.indexOf('const PLACE_READINGS = [');",
    "const readings = eval(src.slice(i + 'const PLACE_READINGS = '.length, src.indexOf('];', i) + 1));",
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const keys = (word) => {",
    "  const m = Recommender.searchMatcher(word, now);",
    "  return new Set(rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year + '@' + r.kind));",
    "};",
    "const worse = [];",
    "readings.forEach((entry) => {",
    "  const kanji = String(entry[0]);",
    "  const kana = String(entry[1]);",
    "  const byKanji = keys(kanji);",
    "  if (!byKanji.size) return; // 収録に無い場所は比較しようがない",
    "  const byKana = keys(kana);",
    "  const missing = [...byKanji].filter((k) => !byKana.has(k)).length;",
    "  if (missing) worse.push(`${kana} / ${kanji}: 漢字 ${byKanji.size} 件 → かな ${byKana.size} 件（${missing} 件足りない）`);",
    "});",
    // 受け取った寄せが違う語へ漏れていないこと（`なら` が奈良以外の行を拾わない等）。
    "const leak = [];",
    "[['なら', '奈良'], ['とうきょう', '東京'], ['きょうと', '京都']].forEach(([kana, kanji]) => {",
    "  const a = keys(kana);",
    "  const b = keys(kanji);",
    "  if (a.size !== b.size || [...a].some((k) => !b.has(k))) leak.push(`${kana} と ${kanji} の行集合が違う`);",
    "});",
    "console.log(JSON.stringify({ worse, leak }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as { worse: string[]; leak: string[] };
  expect(out.worse, "かなで打くと漢字より足りない行がある:\n" + out.worse.join("\n")).toEqual([]);
  expect(out.leak, "かな入力の行集合が漢字とズレている: " + out.leak.join(" / ")).toEqual([]);
});

it("「南米」「中米」で引けると、地域の切れ目が実データで崩れない（SPEC §7）", () => {
  /* 「中南米」は当たっても「南米」単体では 0 件で止まっていた（2026-09-23 実測:
   * 中南米 95 行 / 南米 0 行 / 中米 0 行）。南米の会議を開こうとする人は「南米」と書く。
   * 収録カタログで、国名で引ける行が地域の語でも引けること、地域の切れ目が
   * 混ざらないことを見る。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const keys = (word) => {",
    "  const m = Recommender.searchMatcher(word, now);",
    "  return new Set(rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year + '@' + r.kind));",
    "};",
    "const missing = (broad, narrowList) =>",
    "  narrowList.flatMap((narrow) => [...keys(narrow)].filter((k) => !keys(broad).has(k)).map((k) => `${narrow}: ${k}`));",
    "const intersect = (a, b) => [...keys(a)].filter((k) => keys(b).has(k)).length;",
    "console.log(JSON.stringify({",
    "  south: keys('南米').size,",
    "  central: keys('中米').size,",
    "  latin: keys('中南米').size,",
    "  southFromCountries: missing('南米', ['ブラジル', 'チリ', 'コロンビア', 'アルゼンチン']),",
    "  centralFromCountries: missing('中米', ['メキシコ', 'コスタリカ', 'パナマ']),",
    "  latinMissing: missing('中南米', ['南米', '中米']),",
    "  southInEurope: intersect('南米', 'ヨーロッパ'),",
    "  centralInAsia: intersect('中米', 'アジア'),",
    "  mexicoInNorthAmerica: keys('メキシコ').size && missing('北米', ['メキシコ']).length === 0,",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    south: number;
    central: number;
    latin: number;
    southFromCountries: string[];
    centralFromCountries: string[];
    latinMissing: string[];
    southInEurope: number;
    centralInAsia: number;
    mexicoInNorthAmerica: boolean;
  };
  expect(out.south, "「南米」が 0 件").toBeGreaterThan(0);
  expect(out.central, "「中米」が 0 件").toBeGreaterThan(0);
  expect(
    out.latinMissing,
    "「中南米」が南米・中米の行を取りこぼしている:\n" + out.latinMissing.join("\n"),
  ).toEqual([]);
  expect(
    out.southFromCountries,
    "国名で引ける南米の行が「南米」で出ていない:\n" + out.southFromCountries.join("\n"),
  ).toEqual([]);
  expect(
    out.centralFromCountries,
    "国名で引ける中米の行が「中米」で出ていない:\n" + out.centralFromCountries.join("\n"),
  ).toEqual([]);
  // 地域の切れ目（ブラジルの行がヨーロッパに入らない等）。
  expect(out.southInEurope, "南米の行がヨーロッパで当たっている").toBe(0);
  expect(out.centralInAsia, "中米の行がアジアで当たっている").toBe(0);
  expect(out.mexicoInNorthAmerica, "メキシコ開催の行が「北米」で出ていない").toBe(true);
});

it("「中国」で国と地方の両方が出ても、大陸の語に国内の行は混ざらない（SPEC §7）", () => {
  /* 「中国」は国名としても地方名としても打たれる。国名の行しか当たらない状態は
   * 調べ方を狭めるが（2026-09-23 実測: `中国` 233 行、中国地方の 3 行は `中国地方`
   * と打たないと出なかった）、広げすぎると `アジア` に国内の行が混ざる
   * （実際 `中国` を地方見出しへ足した日にアジアが 523 → 526 行へ広がった）。
   * 収録カタログで両方を同時に確認する。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rowsOf = (word) => {",
    "  const m = Recommender.searchMatcher(word, now);",
    "  return rows.filter((r) => m(r.hay));",
    "};",
    "const keys = (word) => new Set(rowsOf(word).map((r) => r.conf.key + '@' + r.ed.year + '@' + r.kind));",
    "const chugoku = keys('中国地方');",
    "console.log(JSON.stringify({",
    "  chugoku: chugoku.size,",
    "  china: keys('中国').size,",
    "  chinaMissing: [...chugoku].filter((k) => !keys('中国').has(k)),",
    "  // 「アジアに国内研究会は入らない」はてびきで書いている約束。",
    "  asiaDomestic: rowsOf('アジア').filter((r) => (r.conf.tags || []).indexOf('domestic-jp') >= 0).length,",
    "  europeDomestic: rowsOf('ヨーロッパ').filter((r) => (r.conf.tags || []).indexOf('domestic-jp') >= 0).length,",
    "  shutoken: keys('首都圏').size,",
    "  tokai: keys('東海').size,",
    // 開催地に都道府県が書かれない行（`Nagoya, Japan`）もあるので、「東海」の当たり行が
    // 都道府県名を含むことでは確かめられない。構成県の語で引ける行を含むことを見る。
    "  tokaiMissing: [",
    "    ...new Set([...keys('愛知'), ...keys('岐阜')].map((k) => k)),",
    "  ].filter((k) => !keys('東海').has(k)),",
    "  shutokenMissing: [...keys('東京')].filter((k) => !keys('首都圏').has(k)),",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    chugoku: number;
    china: number;
    chinaMissing: string[];
    asiaDomestic: number;
    europeDomestic: number;
    shutoken: number;
    tokai: number;
    tokaiMissing: string[];
    shutokenMissing: string[];
  };
  expect(out.chugoku, "中国地方の行が 0 件").toBeGreaterThan(0);
  expect(
    out.chinaMissing,
    "「中国」で引くと中国地方の行が足りない:\n" + out.chinaMissing.join("\n"),
  ).toEqual([]);
  expect(out.asiaDomestic, "「アジア」に国内の行が混ざっている").toBe(0);
  expect(out.europeDomestic, "「ヨーロッパ」に国内の行が混ざっている").toBe(0);
  expect(out.shutoken, "「首都圏」が 0 件").toBeGreaterThan(0);
  expect(out.tokai, "「東海」が 0 件").toBeGreaterThan(0);
  expect(
    out.tokaiMissing,
    "「東海」が愛知・岐阜の行を取りこぼしている:\n" + out.tokaiMissing.join("\n"),
  ).toEqual([]);
  expect(
    out.shutokenMissing,
    "「首都圏」が東京の行を取りこぼしている:\n" + out.shutokenMissing.join("\n"),
  ).toEqual([]);
});

it("ランク順は等級で並び、評価の無い行は末尾に回る（SPEC §7）", () => {
  /* 変更前は `rankPairs[0]`（`ccf:A` のような文字列）で並べていたので、
   * 体系名が等級より先に効き、降順で ccf:N（評価が付いていない）の行が先頭に
   * 来ていた（2026-09-23 実測）。並びの規則は recommender の `rankSortKey` が正本で、
   * 一覧の比較式がそれを使っていること、選択欄の等級順と同じ正本であることを見る。 */
  const app = siteRuntime("app.js");
  const html = readFileSync(join(site, "index.html"), "utf8");
  const rankAt = app.indexOf('sortKey === "rank"');
  const rankEnd = app.indexOf("compareDeadlineRows(a, b, mult)", rankAt);
  // 目印が見つからず -1 になると slice の終端が化けて、中身を見ているのに見ていない
  // 検査になる（第 91 回で呼び出し形を変えたときに実際へ起きた）。
  expect(rankAt, "ランク順の並び替え箇所が見つからない").toBeGreaterThan(0);
  expect(rankEnd, "ランク順が比較関数を呼んでいない").toBeGreaterThan(rankAt);
  const rankBlock = app.slice(rankAt, rankEnd);
  expect(rankBlock, "ランク順が recommender の等級キーを見ていない").toContain("rankSortKey");
  expect(rankBlock, "rankPairs を直接比較している").not.toContain("rankPairs[0]");
  // 選択欄の等級は app 側で組み立てるので、静的な HTML には無い。
  // ここは選択欄が recommender の正本から等級をもらっていることを見る
  // （並び順と同じ順序で選択肢を出すための前提）。
  expect(html, "HTML にランク選択欄がない").toContain('id="rank"');
  expect(app, "ランクの選択欄が等級順の正本を使っていない").toContain(
    "RANK_GRADE_OPTIONS = Recommender.rankGradeOrderJa()",
  );

  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const view = rows.filter((r) => (r.kind === 'abstract' || r.kind === 'paper') && r.t >= now && !r.ed.estimated);",
    "const key = (r) => Recommender.rankSortKey(r.rankPairs);",
    "const desc = view.slice().sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));",
    "const rated = (r, grades) => r.rankPairs.some((p) => grades.indexOf(p.slice(p.indexOf(':') + 1)) >= 0);",
    "const topBad = desc.slice(0, 20).filter((r) => !rated(r, ['A*', 'A'])).map((r) => r.rankPairs.join('+') || '(なし)');",
    "const tailBad = desc.slice(-20).filter((r) => rated(r, ['A*', 'A'])).map((r) => r.conf.key);",
    /* 体系名が等級より先に効いていないこと: `A*` を1つでも持つ行が、最良の等級が
     * C 以下の行（`ccf:C` を最良とする行など）より前に並びきるかを見る。
     * 変更前は `core:A*` の行が `ccf:C` の後ろに置かれていた。 */
    "const isAStar = (r) => rated(r, ['A*']);",
    "const bestIsLow = (r) => !rated(r, ['A*', 'A', 'B']) && r.rankPairs.length > 0;",
    "const aStarIndexes = desc.map((r, i) => (isAStar(r) ? i : -1)).filter((i) => i >= 0);",
    "const lowIndexes = desc.map((r, i) => (bestIsLow(r) ? i : -1)).filter((i) => i >= 0);",
    "const crossSystemOk = aStarIndexes.length > 0 && lowIndexes.length > 0",
    "  ? Math.max(...aStarIndexes) < Math.min(...lowIndexes)",
    "  : null;",
    "console.log(JSON.stringify({",
    "  viewRows: view.length,",
    "  topBad,",
    "  tailBad,",
    "  crossSystemOk,",
    "  hasAStar: desc.some((r) => rated(r, ['A*'])),",
    "  gradeOrder: Recommender.rankGradeOrderJa(),",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    viewRows: number;
    topBad: string[];
    tailBad: string[];
    crossSystemOk: boolean | null;
    hasAStar: boolean;
    gradeOrder: string[];
  };
  expect(out.viewRows).toBeGreaterThan(0);
  expect(out.hasAStar, "収録に A* の行がない（検査が空振りする）").toBe(true);
  expect(
    out.topBad,
    "ランク順の降順で先頭に評価の無い・等級の低い行が来ている: " + out.topBad.join(" / "),
  ).toEqual([]);
  expect(
    out.tailBad,
    "A* / A の行がランク順の末尾に置かれている: " + out.tailBad.join(", "),
  ).toEqual([]);
  expect(
    out.crossSystemOk,
    "A* を持つ行が、最良の等級が C 以下の行より後ろに置かれている（体系名が優先している）",
  ).toBe(true);
  expect(out.gradeOrder).toEqual(["A*", "A", "B", "C", "N"]);
  // URL にも同じ値を書く（`rank=A*` が選択肢に無い値で共有されない）。
  expect(app, "ランクの URL 読み書きが選択肢と同じ表を見ていない").toContain("RANK_GRADE_OPTIONS");
});

it("開催地の翻訳が収録データで化けていない（New Mexico・別表記の国名・語の食い付き）（SPEC §7）", () => {
  /* 開催地の国名を日本語に寄せる処理は、複合地名を壊すと画面が嘘をつく
   * （`New Mexico` → 「New メキシコ」で、アメリカの会議が「メキシコ」で出ていた）。
   * 収録カタログ全体で、寄せ結果と原文が食い違っていないことをみる。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');",
    "const rowsOf = (word) => {",
    "  const m = Recommender.searchMatcher(word, now);",
    "  return rows.filter((r) => m(r.hay));",
    "};",
    "const strip = (s) => fold(s).replace(/[^a-z ]/g, ' ');",
    // ① 国名で引いた行の原文に、その国の語が本当に書かれているか（州名の混入など）。
    "const mexicoBad = rowsOf('メキシコ')",
    "  .filter((r) => !/(^| )mexico( |$)/.test(strip(r.ed.place)))",
    "  .map((r) => String(r.ed.place));",
    "const koreaBad = rowsOf('韓国')",
    "  .filter((r) => !/(korea|korea|seoul)/.test(strip(r.ed.place)))",
    "  .map((r) => String(r.ed.place));",
    // ② 別表記で書かれた国が、日本語の語でたどれないままになっていないか。
    "const count = (word, re) => rowsOf(word).filter((r) => re.test(String(r.ed.place))).length;",
    "const codeRows = rows.filter((r) => /,\\s*BE$/.test(String(r.ed.place))).length;",
    // ③ 寄せ結果で日本語の語にラテン文字が食い付いていないか（`パナマ City` 型）。
    "const glued = [];",
    "rows.forEach((r) => {",
    "  const out = Recommender.placeJa(r.ed.place);",
    "  const hit = out.match(/[ぁ-んァ-ン一-龥][A-Za-z]/);",
    "  if (hit && glued.indexOf(out) < 0) glued.push(out);",
    "});",
    "console.log(JSON.stringify({",
    "  mexicoBad,",
    "  koreaBad,",
    "  newMexicoRows: rowsOf('ニューメキシコ').length,",
    "  newMexicoAllNewMexico: rowsOf('ニューメキシコ').every((r) => /new mexico/i.test(String(r.ed.place))),",
    "  belgiumFromCode: count('ベルギー', /,\\s*BE$/),",
    "  codeRows,",
    "  curacao: count('キュラソー', /cura[çc]ao/i),",
    "  mexicoAccented: count('メキシコ', /m[ée]xico/i),",
    "  glued: glued.slice(0, 5),",
    "  gluedCount: glued.length,",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    mexicoBad: string[];
    koreaBad: string[];
    newMexicoRows: number;
    newMexicoAllNewMexico: boolean;
    belgiumFromCode: number;
    codeRows: number;
    curacao: number;
    mexicoAccented: number;
    glued: string[];
    gluedCount: number;
  };
  expect(
    out.mexicoBad,
    "「メキシコ」で引くとメキシコ国内ではない行が出る:\n" + out.mexicoBad.join("\n"),
  ).toEqual([]);
  expect(out.koreaBad, "「韓国」で引くと韓国の行ではない:\n" + out.koreaBad.join("\n")).toEqual([]);
  expect(out.newMexicoRows, "「ニューメキシコ」が 0 件").toBeGreaterThan(0);
  expect(out.newMexicoAllNewMexico, "「ニューメキシコ」に別の場所が混ざっている").toBe(true);
  expect(
    out.codeRows,
    "国コードで書かれた開催地が収録に見当たらない（検査が空振りする）",
  ).toBeGreaterThan(0);
  expect(out.belgiumFromCode, "国コード `BE` の行が「ベルギー」で引けない").toBe(out.codeRows);
  expect(out.curacao, "Curaçao が「キュラソー」で引けない").toBeGreaterThan(0);
  expect(out.mexicoAccented, "México が「メキシコ」で引けない").toBeGreaterThan(0);
  expect(
    out.gluedCount,
    `日本語の語にラテン文字が食い付いた開催地表記: ${out.glued.join(" / ")}`,
  ).toBe(0);
});

it("「評価でしぼる」でのぞいた件数を件数欄に出す（SPEC §7）", () => {
  /* 評価の選択欄は「A*」などの一語で、収録にその評価がどれくらいあるかが見えない。
   * のぞいた行数を出さないと「収録に A* が少ない」と誤解する（2026-09-23 実測:
   * 既定画面 477 行のうち「A*」は 61 行だけで、のこり 416 行の話が件数欄になかった）。
   * ビルド後の `filter` を動かし、表示件数とのぞいた数の合計が対象行数と一致ることをみる。
   * 等級の判定は recommender の正本（厳密比較）を使う — 選択欄と同じ比較式でないと
   * 「A」が「A*」に誤マッチして数字が合うはずのものが合わなくなる。 */
  const runtime = siteRuntime();
  const rec = readFileSync(join(site, "recommender.js"), "utf8");
  const filterSrc = jsFunction(runtime, "filter");
  const rankMatchesSrc = jsFunction(rec, "rankMatches");
  expect(rankMatchesSrc, "recommender の等級判定が見つからない").toBeTruthy();
  // 関数ソースをそのまま入れる（JSON.stringify すると文字列になって代入にならない）。
  const script = [
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    "function row(key, rankPairs) {",
    "  return { kind: 'paper', est: false, cats: ['hpc'], rankPairs: rankPairs, tags: [],",
    "    hay: key, t: now + DAY, tLast: now + DAY,",
    "    ed: { place: 'Kyoto, 日本', deadlines: [] }, conf: { key: key } };",
    "}",
    "const rows = [",
    "  row('a', []), row('b', []), row('c', []),",
    "  row('astar', ['ccf:A*']), row('aA', ['core:A']), row('bB', ['ccf:B']),",
    "  row('n1', ['ccf:N']), row('n2', ['ccf:N', 'core:A*']),",
    "];",
    FILTER_RUNTIME_STUBS,
    // 等级判定だけ正本に差し替える（スタブの `includes` は部分一致で誤マッチする）。
    `Recommender.rankMatches = ${rankMatchesSrc};`,
    "const run = (rank) => {",
    // `hiddenCounts` はスタブ側の `let` 束縛そのものを戻す（globalThis に書いても
    // `filter` は語彙束縛を見るので数え直されない）。
    "  hiddenCounts = {",
    "    past: 0, est: 0, kind: 0, domestic: 0, online: 0, onlinePlaceUnknown: 0, window: 0, rank: 0, cats: 0,",
    "  };",
    "  const out = new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "    'return (' + FILTER + ')')(FakeDate, DAY, rows,",
    "    { q: '', cats: [], kind: '', rank: rank, win: 'all', est: false }, true, 'rem')();",
    "  return { shown: out.map((r) => r.conf.key), hidden: hiddenCounts.rank };",
    "};",
    "const out = { noRank: run(''), grades: {} };",
    "['A*', 'A', 'B', 'C', 'N'].forEach((g) => { out.grades[g] = run(g); });",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    noRank: { shown: string[]; hidden: number };
    grades: Record<string, { shown: string[]; hidden: number }>;
  };
  // 評価を掛けない行はすべて出る（のぞいた数も 0）。
  expect(out.noRank.shown).toHaveLength(8);
  expect(out.noRank.hidden).toBe(0);
  Object.entries(out.grades).forEach(([grade, v]) => {
    // 表示 + のぞく = 対象行数（数え漏らし・二重計上の検出）。
    expect(v.shown.length + v.hidden, `評価「${grade}」`).toBe(8);
  });
  expect(out.grades["A*"].shown).toEqual(["astar", "n2"]);
  // 厳密比較なので「A」は「A*」を含まない（選択欄と同じ判定を使っていることの確認）。
  expect(out.grades.A.shown).toEqual(["aA"]);
  expect(out.grades.N.shown).toEqual(["n1", "n2"]);
  expect(out.grades.C.shown).toEqual([]);
  expect(out.grades.C.hidden, "0 件の評価でのぞいた数が出ていない").toBe(8);

  const app = runtime;
  expect(app, "件数欄が評価で絞った件数を書いていない").toContain(
    "評価「${state.rank}」を持たない行 ${countJa(hidden.rank)} 件",
  );
});

it("CSV の分野列は画面と同じ日本語の語で、英字のキーを書かない（SPEC §7）", () => {
  /* 分野は絞り込みで使う次元なのに、一覧は 7 列で分野列を持たないため、
   * 表計算に持ち出すと分野ごとに並べ替えられなかった。CSV だけに見出すとき、
   * 書く語は画面（分野チップ・行の詳細）と同じ日本語で、`hpc` のような
   * 内部キーを表計算に渡さない。収録カタログ全体で列の組み立ても確かめる。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    // RFC4180 の読み方で 1 行ずつ分ける（開催地などにカンマが入る）。
    "function splitLine(line) {",
    "  const out = [];",
    "  let cur = '', quoted = false;",
    "  for (let i = 0; i < line.length; i++) {",
    "    const ch = line[i];",
    "    if (quoted) {",
    "      if (ch === '\"' && line[i + 1] === '\"') { cur += '\"'; i++; }",
    "      else if (ch === '\"') quoted = false;",
    "      else cur += ch;",
    "    } else if (ch === '\"') quoted = true;",
    "    else if (ch === ',') { out.push(cur); cur = ''; }",
    "    else cur += ch;",
    "  }",
    "  out.push(cur);",
    "  return out;",
    "}",
    "const csv = Recommender.deadlinesToCsv(rows, now);",
    "const lines = csv.split('\\r\\n').filter((l) => l.length);",
    "const header = splitLine(lines[0]);",
    "const at = header.indexOf('分野');",
    "const cells = lines.slice(1).map((l) => splitLine(l)[at]);",
    "const widths = new Set(lines.map((l) => splitLine(l).length));",
    // キーがそのまま出ている例（ラベル表に無い語）を集める。
    "const asciiCells = [...new Set(cells.filter((c) => c && !/[ぁ-んァ-ン一-龥]/.test(c)))];",
    "const emptyWhereCats = lines.slice(1)",
    "  .map((l, i) => ({ cats: (rows[i].cats || []).length, cell: cells[i] }))",
    "  .filter((x) => x.cats > 0 && !x.cell).length;",
    "const mismatch = lines.slice(1)",
    "  .map((l, i) => (rows[i].cats || []).map((c) => Recommender.categoryLabelJa(c)).join('・'))",
    "  .filter((want, i) => want !== cells[i]).length;",
    "console.log(JSON.stringify({",
    "  header, at, dataRows: lines.length - 1, widths: [...widths],",
    "  sample: cells.filter((c) => c).slice(0, 3),",
    "  asciiCells: asciiCells.slice(0, 5),",
    "  emptyWhereCats, mismatch,",
    "  labeled: rows.reduce((n, r) => n + (r.cats || []).length, 0),",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    header: string[];
    at: number;
    dataRows: number;
    widths: number[];
    sample: string[];
    asciiCells: string[];
    emptyWhereCats: number;
    mismatch: number;
    labeled: number;
  };
  expect(out.header, "CSV の見出しに分野がない").toContain("分野");
  expect(out.at).toBeGreaterThan(0);
  expect(out.dataRows).toBeGreaterThan(1000);
  // 列の組み立てが全行で揃っている（1 列だけ欠ける行を作らない）。
  expect(out.widths, "行によって列数が違う").toEqual([out.header.length]);
  expect(out.labeled).toBeGreaterThan(0);
  expect(out.sample.length, "分野が書かれた行がない（検査が空振りする）").toBeGreaterThan(0);
  expect(
    out.asciiCells,
    "分野列に日本語でない語が混ざっている: " + out.asciiCells.join(", "),
  ).toEqual([]);
  expect(out.emptyWhereCats, "分野を持つ行の分野列が空").toBe(0);
  expect(out.mismatch, "分野列が画面と同じ語になっていない行がある").toBe(0);
});

it("分野チップでのぞいた件数を件数欄に出す（SPEC §7）", () => {
  /* チップには分野ごとの件数が写るが、「選んだ分野で何行が出て他が何行だったか」は
   * 件数欄に書かないと分からない（2026-09-23 実測: 既定画面 477 行のうち
   * 「人工知能」は 182 行で、のこり 295 行の話し手が件数欄にいなかった）。
   * のぞいた数は「他の条件を通った行」からの数えなので、表示と足して全件にはならない
   * — その関係も検査で固定する（何と何を足した数か分からない表示を避ける）。 */
  const runtime = siteRuntime();
  const filterSrc = jsFunction(runtime, "filter");
  const script = [
    `const countJa = (${jsFunction(runtime, "countJa")});`,
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    "function row(key, cats) {",
    "  return { kind: 'paper', est: false, cats: cats, rankPairs: [], tags: [],",
    "    hay: key, t: now + DAY, tLast: now + DAY,",
    "    ed: { place: 'Kyoto, 日本', deadlines: [] }, conf: { key: key } };",
    "}",
    "const rows = [",
    "  row('hpc', ['hpc']), row('ai', ['ai']), row('both', ['hpc', 'ai']),",
    "  row('sec', ['sec']), row('net', ['net', 'sec']),",
    "];",
    FILTER_RUNTIME_STUBS,
    "const run = (cats) => {",
    // `hiddenCounts` はスタブ側の `let` 束縛そのものを戻す（語彙束縛を見ないので
    // globalThis に書いても数え直されない）。
    "  hiddenCounts = {",
    "    past: 0, est: 0, kind: 0, domestic: 0, online: 0, onlinePlaceUnknown: 0, window: 0,",
    "    rank: 0, cats: 0,",
    "  };",
    "  const out = new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "    'return (' + FILTER + ')')(FakeDate, DAY, rows,",
    "    { q: '', cats: cats, kind: '', rank: '', win: 'all', est: false }, true, 'rem')();",
    "  return { shown: out.map((r) => r.conf.key), hidden: hiddenCounts.cats, facets: catFacetCounts };",
    "};",
    "console.log(JSON.stringify({",
    "  none: run([]), one: run(['hpc']), two: run(['hpc', 'ai']), other: run(['quantum']),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    none: { shown: string[]; hidden: number };
    one: { shown: string[]; hidden: number };
    two: { shown: string[]; hidden: number };
    other: { shown: string[]; hidden: number };
  };
  /* 並び順はこの検査の話ではないので、比較は常に順を揃えて行う。 */
  // チップを押していないときは内訳に立たない（件数欄に出さない）。
  expect(out.none.shown).toHaveLength(5);
  expect(out.none.hidden).toBe(0);
  // 1 つのチップ: 表示 + のぞく = 他の条件を通った行（ここでは全 5 行）。
  expect(out.one.shown.slice().sort()).toEqual(["both", "hpc"]);
  expect(out.one.hidden).toBe(3);
  // 2 つのチップは OR なので、のぞく数は減る（`net` は hpc・ai のどちらでもない）。
  expect(out.two.shown.slice().sort()).toEqual(["ai", "both", "hpc"]);
  expect(out.two.hidden).toBe(2);
  // 収録に無い分野を選ぶと 0 件＋のぞいた全件（0 件の案内と合わせて理由が分かる）。
  expect(out.other.shown).toEqual([]);
  expect(out.other.hidden).toBe(5);

  const app = runtime;
  expect(app, "件数欄が分野で絞った件数を書いていない").toContain(
    '分野「${state.cats.map((key) => catLabel(key)).join("・")}」を持たない行 ${countJa(hidden.cats)} 件',
  );
});

it("新しい分野の言い方が、収録カタログの英文字表記に届いている（SPEC §7）", () => {
  /* 「打ち方が通じない」で 0 件にしないための表なので、**実データで当たること**を見る。
   * 日本語で打った行が英文字表記の行をすべて含み、かつ 1 件以上出ること。
   *英文字側の語順が収録に無い条目を置いていないことも、ここで同時に確かめる。 */
  const pairs: Array<[string, string]> = [
    ["リアルタイム", "real-time"],
    ["実時間", "real-time"],
    ["スケジューリング", "scheduling"],
    ["プログラミング言語", "programming language"],
    ["コンパイラ", "compiler"],
    ["クラスタ", "cluster"],
    ["バイオインフォマティクス", "bioinformatics"],
    ["音響", "acoustic"],
    ["脆弱性", "vulnerability"],
    ["マルウェア", "malware"],
    ["侵入検知", "intrusion detection"],
    ["モバイル", "mobile"],
    ["ユーザインタフェース", "user interface"],
    ["ゲーム", "game"],
    ["エッジコンピューティング", "edge computing"],
    ["仮想現実", "virtual reality"],
    ["拡張現実", "augmented reality"],
    ["計算機アーキテクチャ", "computer architecture"],
    ["データ分析", "data analytics"],
    ["パターン認識", "pattern recognition"],
    // 第 3 群（英文字側が 1〜183 行当たり、日本語は 0 件だった語）。
    ["プライバシー", "privacy"],
    ["医療", "medical"],
    ["医用", "medical"],
    ["健康", "health"],
    ["認知", "cognitive"],
    ["ドローン", "drone"],
    ["知識グラフ", "knowledge graph"],
    ["データマイニング", "data mining"],
    ["推論", "reasoning"],
    ["プロトコル", "protocol"],
    ["センサネットワーク", "sensor network"],
    ["自律", "autonomous"],
  ];
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const PAIRS = " + JSON.stringify(pairs) + ";",
    "const out = [];",
    "for (const [ja, latin] of PAIRS) {",
    "  const folded = Recommender.searchNormalize(latin);",
    "  const phrase = new Set(rows.filter((r) => Recommender.kanaFold(r.hay).indexOf(folded) >= 0).map((r) => r.conf.key + '@' + r.ed.year));",
    "  const m = Recommender.searchMatcher(ja);",
    "  const viaJa = new Set(rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year));",
    "  const missing = [...phrase].filter((k) => !viaJa.has(k)).length;",
    "  out.push({ ja, latin, phrase: phrase.size, viaJa: viaJa.size, missing });",
    "}",
    "console.log(JSON.stringify(out));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Array<{
    ja: string;
    latin: string;
    phrase: number;
    viaJa: number;
    missing: number;
  }>;
  expect(out.length).toBe(pairs.length);
  for (const row of out) {
    expect(
      row.phrase,
      `「${row.ja}」の寄せ先 ${row.latin} が収録に現れない（死んだ寄せ）`,
    ).toBeGreaterThan(0);
    expect(row.missing, `「${row.ja}」で引くと ${row.latin} の行が ${row.missing} 件届かない`).toBe(
      0,
    );
    expect(row.viaJa, `「${row.ja}」で 1 件も出ない`).toBeGreaterThan(0);
  }
});

it("新しい開催市の言い方が、収録の開催地に届いている（SPEC §7）", () => {
  /* 「5 行以上の都市は検査で見ている」検査は、**アクセント付きの都市名を ASCII 正規表現で
   * 弾いていた**ため、`Cancún`（収録 23 行）など 4 種を見ていなかった（2026-09-23 実測）。
   * アクセント記号を除いて数え上げるように直したので、足した語が本当に届くことを実データで見る。 */
  const pairs: Array<[string, string]> = [
    ["カンクン", "cancun"],
    ["マルメ", "malmo"],
    ["テュービンゲン", "tubingen"],
    ["マラガ", "malaga"],
    ["サクラメント", "sacramento"],
    ["ニージメヘン", "nijmegen"],
    ["ヴェローナ", "verona"],
    ["ハリファックス", "halifax"],
    ["アレクサンドリア", "alexandria"],
    ["ドゥブロブニク", "dubrovnik"],
    ["ロングビーチ", "long beach"],
    ["シャーロット", "charlotte"],
    ["クラクフ", "krakow"],
    ["ピサ", "pisa"],
    ["ノッティンガム", "nottingham"],
    ["マインツ", "mainz"],
  ];
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const FOLD = (v) => String(v).normalize('NFKC').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase();",
    "const cityOf = (r) => {",
    "  const raw = String(r.ed.place || '').trim();",
    "  if (!raw) return '';",
    "  const seg = raw.split('/')[0];",
    "  const at = seg.indexOf(',');",
    "  return FOLD(at < 0 ? seg : seg.slice(0, at));",
    "};",
    "const PAIRS = " + JSON.stringify(pairs) + ";",
    "const out = [];",
    "for (const [ja, latin] of PAIRS) {",
    "  const want = String(latin).toLowerCase();",
    "  const cities = new Set(rows.filter((r) => cityOf(r).indexOf(want) >= 0).map((r) => r.conf.key + '@' + r.ed.year));",
    "  const m = Recommender.searchMatcher(ja);",
    "  const viaJa = new Set(rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year));",
    "  out.push({ ja, latin, cities: cities.size, missing: [...cities].filter((k) => !viaJa.has(k)).length });",
    "}",
    "console.log(JSON.stringify(out));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Array<{
    ja: string;
    latin: string;
    cities: number;
    missing: number;
  }>;
  expect(out.length).toBe(pairs.length);
  for (const row of out) {
    expect(
      row.cities,
      `「${row.ja}」の寄せ先 ${row.latin} が開催地として収録に現れない`,
    ).toBeGreaterThan(0);
    expect(row.missing, `「${row.ja}」で引くとその都市の行が ${row.missing} 件届かない`).toBe(0);
  }
});

it("略称と年をスペースで離して 2 桁打つ入力も、実カタログで 4 桁と同じ行を出す（SPEC §7）", () => {
  /* `nsdi27`（貼り付け）と `NSDI 2027`（4 桁）は通っていたのに、いちばん打ちやすい
   * `NSDI 27` が 0 件だった（2026-09-23 実測）。**裸の 2 桁を年として扱うのは、
   * 同じ入力に略称があるときだけ**なので、月日や裸の数字の当たり方が広まっていないことも
   * 同じ実データで確認する。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const keys = (q) => { const m = Recommender.searchMatcher(q); return rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year).sort(); };",
    "const pairs = [['NSDI 27', 'NSDI 2027'], ['ICDE 27', 'ICDE 2027'], ['OSDI 26', 'OSDI 2026']]",
    "  .map((pair) => ({ short: keys(pair[0]), long: keys(pair[1]) }));",
    "const bare = keys('27').length;",
    "const monthDay = keys('8月 27').length;",
    // 暦日で引ける入力は従来どおり（年の展開で減っていないこと）。
    "const isoMonth = keys('2026-12').length;",
    "console.log(JSON.stringify({ pairs, bare, monthDay, isoMonth }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    pairs: Array<{ short: string[]; long: string[] }>;
    bare: number;
    monthDay: number;
    isoMonth: number;
  };
  out.pairs.forEach((pair, i) => {
    expect(pair.long.length, `${i} 件目の 4 桁入力が 0 件`).toBeGreaterThan(0);
    expect(pair.short, `${i} 件目: 離して 2 桁打つ入力が 4 桁と同じ行を出さない`).toEqual(
      pair.long,
    );
  });
  // 裸の 2 桁・月日の入力は広げていない（暦日の当たり方のまま）。
  expect(out.bare).toBeGreaterThan(0);
  expect(out.monthDay).toBeGreaterThan(0);
  expect(out.isoMonth).toBeGreaterThan(0);
});

it("会期だけの会の案内と行の詳細の開催地は、表と同じ書き方で出す（SPEC §7）", () => {
  /* 行の詳細は「開催地: Kyoto, 日本」と出すのに、「今後の会期」と 0 件時の会期案内は
   * 原文のままだった（＠Kyoto, Japan）。開催都市は公式表記のまま、国だけ日本語に寄せる
   * のが表の書き方なので、そちらに揃える。同じ画面の中で同じ種類の情報が 2 通りの
   * 書き方をしていると、別の場所だと誤解する（開催地は日本語に寄せる、が既定の約束）。
   * ビルド後の `renderNextMeetingNote` を疑似 DOM で実際に動かして確かめる。 */
  const runtime = siteRuntime();
  const recSrc = readFileSync(join(site, "recommender.js"), "utf8");
  expect(runtime).toContain("＠${shownPlace}");
  expect(runtime).toContain("＠${Recommender.placeJa(place)}");
  // 原文を出しっぱなしにする形に戻っていないこと（表題の語で探す人が探せる形）。
  expect(runtime).not.toContain("＠${m.place}");
  expect(runtime).not.toContain("＠${next.place}");
  const noteSrc = jsFunction(runtime, "renderNextMeetingNote");
  const matchSrc = jsFunction(runtime, "scheduleOnlyMatches");
  const limitSrc = jsFunction(runtime, "windowLimitMs");
  const rangeSrc = jsFunction(runtime, "meetingRangeJa");
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    "const DAY = 86400000;",
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    // 会期だけ確定している回（締切の無い edition）を 1 件置く。
    "const DATA = { conferences: [{ key: 'demo', title: 'Demo Conf', link: 'https://example.org/',",
    "  categories: ['hpc'], tags: [], editions: [{ event_start: '2026-09-30', event_end: '2026-10-02',",
    "  place: 'Kyoto, Japan', deadlines: [], link: 'https://example.org/cfp' }] }] }",
    "const boxes = [];",
    "function node(text) { return { textContent: text || '', title: '', tag: 'span', children: [],",
    "  appendChild(c) { this.children.push(c); return c; } }; }",
    "const box = node();",
    "box.hidden = true;",
    "boxes.push(box);",
    "const document = { createElement: (tag) => { const n = node(); n.tag = tag; return n; },",
    "  createTextNode: (t) => node(t) };",
    "const $ = () => box;",
    "let searchQuery = '';",
    `${limitSrc}`,
    `${rangeSrc}`,
    `${matchSrc}`,
    `${noteSrc}`,
    "renderNextMeetingNote(scheduleOnlyMatches({ window: 'all', cats: [], domestic: false, online: false }));",
    "const flat = (n) => (n.textContent || '') + n.children.map(flat).join('');",
    "const titles = [];",
    "(function walk(n) { if (n.title) titles.push(n.title); n.children.forEach(walk); })(box);",
    "console.log(JSON.stringify({ hidden: box.hidden, text: flat(box), titles }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as { hidden: boolean; text: string; titles: string[] };
  expect(out.hidden, "会期案内が出ていない（検査が空振りする）").toBe(false);
  // 表と同じ書き方（国は日本語、開催市は公式表記）。
  expect(out.text, "開催地が表と同じ書き方になっていない: " + out.text).toContain("Kyoto, 日本");
  expect(out.text).not.toContain("Japan");
  expect(out.titles, "原表記をどこにも残していない").toContain("Kyoto, Japan");
  // 会期の書き方も表と同じ（暦日 + 曜日）。
  expect(out.text).toContain("2026-09-30(水)");
});

it("日本開催の行は、開催地の市区郡・会場を日本語で打つとその行に出会える（SPEC §7）", () => {
  /* 国内の行はローマ字をそのまま打つ人が少ない（漢字で打つ）。海外側は「5 行以上の都市」で
   * 見ていたが、日本開催は 1 都市 1〜2 行なので閾値に届かず、検査の外にあった。
   * 2026-09-23 実測: 日本開催の行のうち `Aizuwakamatsu` の 2 行だけが、どの日本語の
   * 言い方でも 0 件だった（`会津若松` を足して解消）。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const rec = readFileSync(${JSON.stringify(join(site, "recommender.js"))}, 'utf8');`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const FOLD = (v) => String(v).normalize('NFKC').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase();",
    "const grab = (name) => {",
    "  const head = 'const ' + name + ' = ';",
    "  const i = rec.indexOf(head);",
    "  const j = rec.indexOf('\\n    ];', i);",
    '  return eval(vmSafeSource(rec.slice(i + head.length, j)) + "\\n];");',
    "};",
    "const cityOf = (place) => {",
    "  const seg = String(place || '').trim().split('/')[0];",
    "  const at = seg.indexOf(',');",
    "  return (at < 0 ? seg : seg.slice(0, at)).trim();",
    "};",
    // ① 実行ビルドの収録に対して: 日本開催の行の開催地（最初の市区郡・会場）ごとに、
    //    日本語の言い方の表に対応があるか。
    "const rows = Recommender.candidateRows(DATA);",
    "const japan = rows.filter((r) => /日本|japan/i.test(String(r.ed.place || '')));",
    "const pairs = grab('PLACE_QUERY_ALIASES_JA').map((p) => [p[0], FOLD(p[1])]);",
    // 除外は置かない。`Miyakojima`（FC の回）は公式の "Miyakojima, Japan" に応じて
    // `宮古島` が既に寄せてあるので、そのまま通る。
    "const segs = new Map();",
    "japan.forEach((r) => { const c = cityOf(r.ed.place); segs.set(c, (segs.get(c) || 0) + 1); });",
    "const uncovered = [];",
    "for (const [city, n] of segs) {",
    "  const folded = FOLD(city);",
    "  if (!/^[a-z]/.test(folded)) continue;",
    "  if (!pairs.some((p) => folded.indexOf(p[1]) >= 0)) uncovered.push(city + ' (' + n + ' 行)');",
    "}",
    // ② 表にあっても当たり方が違えば意味がないので、合成した行に対して実際に引いて見る
    //    （収録側の行は上流の取得状況で増減するため、ここでは再現できる形でおく）。
    // 収録の形（`tests/helpers.ts` の makeConference/makeEdition と同じ字段）。
    "const mk = (key, place) => ({ key, title: key.toUpperCase(), full_name: key.toUpperCase(),",
    "  link: 'https://example.org/', rank: {}, dblp: null, upstream_sub: null, tags: [],",
    "  categories: ['hpc'], sources: ['ccfddl'], editions: [{",
    "  edition_id: key + '26', link: 'https://example.org/cfp', place, date_text: '2026-09-30',",
    "  event_start: '2026-09-30', event_end: '2026-10-02', estimated: false, source: 'ccfddl',",
    "  deadlines: [{ kind: 'paper', label: '2026-09-01', at_utc: '2026-09-01T15:00:00.000Z',",
    "  tz_raw: 'AoE', round: 1, comment: null }] }] });",
    "const fixture = { conferences: [",
    "  mk('aizu', 'Aizuwakamatsu, Japan'), mk('hitotsubashi', 'Hitotsubashi Hall, Tokyo, Japan'),",
    "  mk('miraikan', 'Tokyo Odaiba Miraikan, Japan'), mk('tokyo', 'Tokyo, Japan'),",
    "  mk('kyoto', 'Kyoto, Japan'), mk('nagoya', 'Nagoya, Japan'),",
    "] };",
    "const frows = Recommender.candidateRows(fixture);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const checks = [['会津若松', 'aizu'], ['会津', 'aizu'], ['一橋講堂', 'hitotsubashi'],",
    "  ['日本科学未来館', 'miraikan'], ['未来館', 'miraikan'], ['東京', 'tokyo'], ['東京', 'hitotsubashi'],",
    "  ['京都', 'kyoto'], ['名古屋', 'nagoya']];",
    "const misses = [];",
    "for (const [ja, key] of checks) {",
    "  const m = Recommender.searchMatcher(ja, now);",
    "  const row = frows.find((r) => r.conf.key === key);",
    "  if (!row) misses.push(ja + ': 行が無い');",
    "  else if (!m(row.hay)) misses.push('「' + ja + '」が " + "' + key + ' の行を返さない');",
    "}",
    "console.log(JSON.stringify({",
    "  total: segs.size, japan: japan.length,",
    "  uncovered, misses, fixtureRows: frows.length,",
    " }));",
    "})();",
  ].join("\n");
  const proc = spawnSync(
    "node",
    ["-e", `const vmSafeSource = ${vmSafeSource.toString()};\n${script}`],
    { encoding: "utf8", timeout: 180_000 },
  );
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    total: number;
    japan: number;
    uncovered: string[];
    misses: string[];
    fixtureRows: number;
  };
  // 検査が実際に日本開催の行を見ていること（空振りを防ぐ）。
  expect(out.japan, "日本開催の行が検査に乗っていない").toBeGreaterThan(8);
  expect(out.total).toBeGreaterThan(5);
  expect(out.fixtureRows, "合成行が作れていない").toBe(6);
  expect(
    out.uncovered,
    "日本語で打ってもたどれない日本開催の開催地:\n" + out.uncovered.join("\n"),
  ).toEqual([]);
  expect(out.misses, "日本語で引いても行が出ない:\n" + out.misses.join("\n")).toEqual([]);
});

it("ラウンドは画面の書き方でも CSV の表記でも、実カタログで同じ行を出す（SPEC §7）", () => {
  /* 表の種別セルは「第 N ラウンド」、CSV は `RN`。画面の語が検索で引けないと、
   * 複数ラウンドの会議（PVLDB や SIGMOD など）を絞り込めない。
   * 画面どおりにスペースを入れて写した入力が全件に化けていないこともここで見る。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(DATA);",
    "const keys = (q) => { const m = Recommender.searchMatcher(q, now); return rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year + '#' + r.dl.kind + '#' + r.dl.round).sort(); };",
    "const out = [];",
    "for (const n of [1, 2, 3, 12]) {",
    "  const own = rows.filter((r) => Number(r.dl.round) === n)",
    "    .map((r) => r.conf.key + '@' + r.ed.year + '#' + r.dl.kind + '#' + r.dl.round).sort();",
    "  if (own.length === 0) continue;",
    "  const spaced = keys('第 ' + n + ' ラウンド');",
    "  const compact = keys('第' + n + 'ラウンド');",
    "  const csv = keys('R' + n);",
    "  const missing = own.filter((k) => compact.indexOf(k) < 0).length;",
    "  const csvMissing = own.filter((k) => csv.indexOf(k) < 0).length;",
    "  out.push({ n, own: own.length, spaced: spaced.length, compact: compact.length, csv: csv.length, missing, csvMissing });",
    "}",
    // 全件に化けていないこと（割れた語が緩いので、必ず上位桁で抑える）。
    "const all = rows.length;",
    "const wide = keys('第 2 ラウンド').length;",
    "console.log(JSON.stringify({ all, wide, out }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    all: number;
    wide: number;
    out: Array<{
      n: number;
      own: number;
      spaced: number;
      compact: number;
      csv: number;
      missing: number;
      csvMissing: number;
    }>;
  };
  expect(out.out.length, "ラウンド付きの行が数え上げられていない").toBeGreaterThan(2);
  for (const row of out.out) {
    expect(
      row.missing,
      `第 ${row.n} ラウンドの行が ${row.missing} 件届かない（画面の書き方）`,
    ).toBe(0);
    expect(
      row.csvMissing,
      `第 ${row.n} ラウンドの行が ${row.csvMissing} 件届かない（CSV の表記）`,
    ).toBe(0);
    // 寄せた形はきっちりそのラウンドの行だけ（他ラウンドを交えない）。
    expect(row.spaced, `第 ${row.n} ラウンド: スペース入り写しが件数の違う結果を出した`).toBe(
      row.compact,
    );
    expect(row.compact, `第 ${row.n} ラウンド: 寄せた形がそのラウンド以外も出した`).toBe(row.own);
  }
  expect(out.wide, "画面どおりに写した入力が全件に化けている").toBeLessThan(out.all / 4);
});

it("画面が・で並べた分野の語をそのまま写すと、その行に出会える（SPEC §7）", () => {
  /* 件数欄・CSV の分野列・行の詳細は `人工知能・データベース` の形で行を説明する。
   * 変更前は写した語が 0 件だったので、**その表記を実際に持つ行**が全部出ることを
   * 実データで見る（AND なので、持たない行が増えてよいことは要求しない）。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const label = (r) => (r.cats || []).map((c) => Recommender.categoryLabelJa(c)).join('・');",
    "const byLabel = new Map();",
    "rows.forEach((r) => {",
    "  const l = label(r);",
    "  if (l.indexOf('・') < 0) return;",
    "  if (!byLabel.has(l)) byLabel.set(l, []);",
    "  byLabel.get(l).push(r.conf.key + '@' + r.ed.year);",
    "});",
    // 件数の多い表記だけ見る（1 行の表記は収録欠落と区別できない）。
    "const labels = [...byLabel.entries()].filter(([, v]) => v.length >= 5).sort((a, b) => b[1].length - a[1].length).slice(0, 8);",
    "const out = labels.map(([l, own]) => {",
    "  const m = Recommender.searchMatcher(l);",
    "  const hit = rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year);",
    "  return { l, own: own.length, hit: hit.length, missing: own.filter((k) => hit.indexOf(k) < 0).length };",
    "});",
    "console.log(JSON.stringify({ kinds: byLabel.size, out }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    kinds: number;
    out: Array<{ l: string; own: number; hit: number; missing: number }>;
  };
  expect(out.kinds, "・ で並ぶ分野表記が数え上げられていない").toBeGreaterThan(3);
  expect(out.out.length).toBeGreaterThan(2);
  for (const row of out.out) {
    expect(row.missing, `「${row.l}」を写すとその表記を持つ行が ${row.missing} 件届かない`).toBe(0);
    // AND なので、ヒットはその表記を持つ行数以上（1 語だけの行も入る）。
    expect(row.hit, `「${row.l}」の当たり方が表記を持つ行数より少ない`).toBeGreaterThanOrEqual(
      row.own,
    );
  }
});

it("案内文に書いた実測値が、ビルド成果物に対して今も合っている（SPEC §7）", () => {
  /* 案内文は「既定画面 478 行のうち 15 行だけ」のような実測値を根拠に書いている。
   * それが収録や実装の change でズレると、案内文が噓をつく（画面の件数欄と合わない）。
   * 2026-09-23 に実際に 7 か所ズレていた（477→478 行、のぞく 462→463 件、
   * 2 ラウンド 387→378 件、`プライバシー` 20→16 件など）。
   * 測る基準は **オフラインビルド（収録 `data/snapshot.json` + 固定時刻 2026-08-09）**。
   * 上流キャッシュ込みのビルドは再現しないので、案内文の基準にしない。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  /* 測る基準は **固定時刻のオフラインビルド**。`tests/helpers.ts` の既定時刻だと
     窓に入る行数が変わるので、案内文が書いた時刻（2026-08-09）で組み直す。 */
  const basis = join(mkdtempSync(join(tmpdir(), "cfp-basis-")), "public");
  /* `tempCache()` は合成した fixture キャッシュを書く（収録が差し替わる）。
     案内文の実測値は **収録 `data/snapshot.json` から組んだ成果物**について書いたもの
     なので、空キャッシュ（= snapshot へフォールバック）で組む。ここを取り違えると
     既定画面が 306 行になって案内文と合わない（2026-09-23 に実測）。 */
  const emptyCache = mkdtempSync(join(tmpdir(), "cfp-empty-cache-"));
  const built = runCli(basis, {
    now: "2026-08-09T00:00:00Z",
    cache: emptyCache,
    extra: ["--no-embeddings"],
  });
  expect(built.status, built.stderr).toBe(0);
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(basis, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(basis, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const DAY = 86400000;",
    "const rows = Recommender.candidateRows(DATA);",
    "const view = rows.filter((r) => (r.kind === 'abstract' || r.kind === 'paper') && r.t >= now && !r.ed.estimated);",
    "const hits = (q, pool) => { const m = Recommender.searchMatcher(q, now); return pool.filter((r) => m(r.hay)).length; };",
    "const online = view.filter((r) => Recommender.placeOffersOnline(r.ed.place)).length;",
    "const unknownPlace = view",
    "  .filter((r) => !Recommender.placeOffersOnline(r.ed.place))",
    "  .filter((r) => !String(r.ed.place || '').trim()).length;",
    "console.log(JSON.stringify({",
    "  catalog: rows.length,",
    "  view: view.length,",
    "  estimated: rows.filter((r) => r.ed.estimated).length,",
    "  onlineView: online,",
    "  onlineCatalog: rows.filter((r) => Recommender.placeOffersOnline(r.ed.place)).length,",
    "  unknownPlace,",
    "  in7d: view.filter((r) => r.t - now <= 7 * DAY).length,",
    "  ai: hits('人工知能', view),",
    "  astar: hits('A*', view),",
    "  round2: rows.filter((r) => Number(r.dl.round) === 2).length,",
    "  extendedView: view.filter((r) => Recommender.isExtendedDeadline(r.dl)).length,",
    "  extendedAll: rows.filter((r) => Recommender.isExtendedDeadline(r.dl)).length,",
    "  middleDot: rows.filter((r) =>",
    "    (r.cats || []).map((c) => Recommender.categoryLabelJa(c)).join('・').indexOf('・') >= 0).length,",
    "  cancun: rows.filter((r) => Recommender.kanaFold(String(r.ed.place || '')).indexOf('cancun') >= 0).length,",
    "  privacy: hits('プライバシー', view),",
    "  dataMining: hits('データマイニング', view),",
    "  dataAnalytics: hits('データ分析', view),",
    "  vr: hits('仮想現実', view),",
    "  realtime: hits('リアルタイム', view),",
    " }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const m = JSON.parse(proc.stdout) as Record<string, number>;
  // 案内文が書いている数（左）と、いま測れる数（右）を突合する。
  const claims: Array<[string, string, number]> = [
    ["既定画面の行数", "478 行", m.view],
    ["推定で出さない行", "134 件", m.estimated],
    ["7 日以内の行", "39 行", m.in7d],
    ["7 日以内で窓の外", "439 行", m.view - m.in7d],
    ["人工知能の行", "182 行", m.ai],
    ["人工知能でのこり", "296 行", m.view - m.ai],
    ["A* の行", "61 行", m.astar],
    ["A* でのこり", "417 行", m.view - m.astar],
    ["オンラインに書ける行", "15 行", m.onlineView],
    ["オンラインでのぞく件", "463 件", m.view - m.onlineView],
    ["開催地が未確認の行", "110 件", m.unknownPlace],
    ["収録のオンライン可", "117 件", m.onlineCatalog],
    ["2 ラウンドの行", "378 件", m.round2],
    ["既定画面で延長の目印が付く行", "9 行", m.extendedView],
    ["収録全体の延長の目印", "33 件", m.extendedAll],
    ["・付きの分野表記を持つ行", "397 行", m.middleDot],
    ["Cancún の行", "23 行", m.cancun],
    ["プライバシー", "16 件", m.privacy],
    ["データマイニング", "22 件", m.dataMining],
    ["データ分析", "7 件", m.dataAnalytics],
    ["仮想現実", "6 件", m.vr],
    ["リアルタイム", "2 件", m.realtime],
  ];
  expect(claims.length).toBeGreaterThan(15);
  for (const [label, written, measured] of claims) {
    expect(measured, `案内文の「${label}」は ${written} と書いてあるが、いま ${measured}`).toBe(
      Number(written.replace(/[^0-9]/g, "")),
    );
    // 案内文の実際にその数を書いていることも見る（検査だけ先に绿になるのを防ぐ）。
    expect(template, `案内文に「${label}」の値 ${written} が書かれていない`).toContain(written);
  }
});

it("行の詳細の分野・主題・ランクは、一覧と同じ中黒で並び、写すとその行に出会える（SPEC §7）", () => {
  /* 一覧・CSV・件数欄は分野を中黒（・）で並べるのに、行の詳細だけ全角コンマ（，）で
   * 並べていた。同じ情報を 2 通りの書き方で見せるうえ、行の詳細から検索欄へ写した人が
   * 1 語扱いで 0 件に当たった（2026-09-23 実測: `人工知能，データベース` 0 件）。 */
  const runtime = siteRuntime();
  expect(runtime, "行の詳細がまだ全角コンマで並べている").not.toContain('join("，")');
  expect(
    runtime.match(/\.join\("・"\)/g)?.length,
    "分野・主題・ランクの並べ語が揃っていない",
  ).toBeGreaterThanOrEqual(3);
  // 写した形（中黒で並べた分野）が、実カタログでその行に戻ってくることは
  // 「画面が・で並べた分野の語をそのまま写すと」の検査が見ている。ここでは
  // 行の詳細がその形を出することだけ確かめる。
  const rows = spawnSync(
    "node",
    [
      "-e",
      [
        "(async () => {",
        "const { readFileSync } = await import('node:fs');",
        `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
        `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
        "const rows = Recommender.candidateRows(DATA);",
        "const multi = rows.filter((r) => (r.cats || []).length >= 2).length;",
        "console.log(JSON.stringify({ multi }));",
        "})();",
      ].join("\n"),
    ],
    { encoding: "utf8", timeout: 180_000 },
  );
  expect(rows.status, rows.stderr).toBe(0);
  const out = JSON.parse(rows.stdout) as { multi: number };
  expect(out.multi, "分野を 2 つ以上持つ行が無いとこの検査が空振りする").toBeGreaterThan(20);
});

it("月・日の語は、和暦の語を持つ行だけを出す（隣の月日が混ざらない・SPEC §7）", () => {
  /* 照合は部分一致なので、変更前は `1月` が `11月` に当たって 1 月と無関係な行を
   * 526 件返していた（`2月` は 394 件・`1日` は 287 件）。実カタログで、
   * **当たり = 和暦の語を持つ行** であることを双方向で見る（多くも少なくも出ない）。 */
  // 収録の和暦年（2019〜2028 実測）を月語の展開範囲が含んでいることも見るので、
  // 空キャッシュ（= 収録 snapshot）で組み直した成果物で測る。
  const basis2 = join(mkdtempSync(join(tmpdir(), "cfp-month-")), "public");
  const builtMonth = runCli(basis2, {
    now: "2026-08-09T00:00:00Z",
    cache: mkdtempSync(join(tmpdir(), "cfp-empty-")),
    extra: ["--no-embeddings"],
  });
  expect(builtMonth.status, builtMonth.stderr).toBe(0);
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(basis2, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(basis2, "data.json"))}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const hasMonth = (hay, m) => new RegExp('(^| )\\\\d{4}年' + m + '月').test(hay);",
    // 日の語は `8月10日` と `2026年8月10日` の両方に出る（月語も `2026年8月`）。
    "const hasDay = (hay, d) =>",
    "  new RegExp('(^| )(\\\\d{4}年)?\\\\d{1,2}月' + d + '日').test(hay);",
    "const out = [];",
    "for (let m = 1; m <= 12; m += 1) {",
    "  const mt = Recommender.searchMatcher(m + '月');",
    "  const hit = rows.filter((r) => mt(r.hay));",
    "  const own = rows.filter((r) => hasMonth(r.hay, m));",
    "  out.push({",
    "    q: m + '月', hit: hit.length, own: own.length,",
    "    extra: hit.filter((r) => !hasMonth(r.hay, m)).length,",
    "    miss: own.filter((r) => !mt(r.hay)).length,",
    "  });",
    "}",
    "for (const d of [1, 2, 7, 11, 22, 31]) {",
    "  const mt = Recommender.searchMatcher(d + '日');",
    "  const hit = rows.filter((r) => mt(r.hay));",
    "  const own = rows.filter((r) => hasDay(r.hay, d));",
    "  out.push({",
    "    q: d + '日', hit: hit.length, own: own.length,",
    "    extra: hit.filter((r) => !hasDay(r.hay, d)).length,",
    "    miss: own.filter((r) => !mt(r.hay)).length,",
    "  });",
    "}",
    "console.log(JSON.stringify(out));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Array<{
    q: string;
    hit: number;
    own: number;
    extra: number;
    miss: number;
  }>;
  expect(out.length).toBe(18);
  for (const row of out) {
    expect(
      row.own,
      `「${row.q}」で和暦の語を持つ行が数えられていない（検査が空振り）`,
    ).toBeGreaterThan(20);
    expect(row.extra, `「${row.q}」は和暦の語を持たない行を ${row.extra} 件返す`).toBe(0);
    expect(row.miss, `「${row.q}」は和暦の語を持つ行を ${row.miss} 件落としている`).toBe(0);
  }
});

it("llms.txt に書いた検索の引き方が、ビルド成果物で実際に効く（SPEC §7）", () => {
  /* `llms.txt` は「サイトの日本語での引き方」を書く。ここは機械（検索支援・要約支援）が
   * 読むので、実装とズレた書き方を残すと、そのまま利用者に伝えられる。
   * ラウンド（第 76 回）・並べ語（第 77・80 回）・月語の和暦展開（第 81 回）は
   * 実装だけ先に進んでいて、llms.txt は知らなかった。本文と挙動を対で固定する。 */
  const text = readFileSync(join(site, "llms.txt"), "utf8");
  for (const phrase of [
    "月語は和暦の語",
    "画面が中黒で並べる語",
    "ラウンドは画面の書き方",
    "略称と年を離して",
    // 第 81 回より前はこの 4 つが全部無かった。
  ]) {
    expect(text, `llms.txt に検索の案内として ${phrase} が無い`).toContain(phrase);
  }

  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(DATA);",
    "const hits = (q) => rows.filter((r) => Recommender.searchMatcher(q, now)(r.hay)).length;",
    "const groups = (q) => Recommender.queryTokenGroups(q, now);",
    "console.log(JSON.stringify({",
    // 月: `1月` は和暦の語を持つ行だけを出す。
    "  monthExtra: rows",
    "    .filter((r) => Recommender.searchMatcher('1月', now)(r.hay))",
    "    .filter((r) => !/(^| )\\d{4}年1月/.test(r.hay)).length,",
    "  monthFound: hits('1月') > 0,",
    // 日: `1日` は 11日・21日・31日を混ぜない。
    "  dayExtra: rows",
    "    .filter((r) => Recommender.searchMatcher('1日', now)(r.hay))",
    "    .filter((r) => !/(^| )(\\d{4}年)?\\d{1,2}月1日/.test(r.hay)).length,",
    // 並べ語: 写した語が引けて、1語より狭い（AND）。
    "  dot: hits('人工知能・データベース'),",
    "  dotSingle: hits('人工知能'),",
    "  dotComma: hits('人工知能，データベース'),",
    "  dotPunctOnly: groups('，').length,",
    // ラウンド: 画面の書き方 = 詰めた形 = R 表記。
    "  roundSpaced: hits('第 2 ラウンド'),",
    "  roundJoined: hits('第2ラウンド'),",
    "  roundR: hits('r2'),",
    "  roundCombined: groups('スパコン・第 2 ラウンド').length,",
    // 略称と年: 離して打つと割れる。月日の裸の数字は割らない。
    "  abbrevGroups: groups('NSDI 27').length,",
    "  abbrevYear: groups('NSDI 27').some((g) => g.indexOf('2027') >= 0),",
    "  monthDayGroups: groups('8月 27').some((g) => g.indexOf('2027') >= 0),",
    " }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Record<string, number | boolean>;
  expect(out.monthExtra, "`1月` が和暦の語を持たない行を返す（llms.txt の案内と違う）").toBe(0);
  expect(out.monthFound, "`1月` が 1 件も返さず検査が空振りしている").toBe(true);
  expect(out.dayExtra, "`1日` が 11日・21日・31日の行を返す").toBe(0);
  expect(out.dot, "中黒で並べた語が 0 件").toBeGreaterThan(0);
  expect(out.dotComma, "全角コンマで並べた語が中黒と違う結果になる").toBe(out.dot);
  expect(out.dot).toBeLessThanOrEqual(out.dotSingle as number);
  expect(out.dotPunctOnly, "並べ語だけの入力が語を作っている").toBe(0);
  expect(out.roundSpaced, "画面の書き方のラウンドが詰めた形と違う件数になる").toBe(out.roundJoined);
  expect(
    out.roundR,
    "R 表記が画面の書き方より少ない（打ち方が統一されていない）",
  ).toBeGreaterThanOrEqual(out.roundJoined as number);
  expect(out.roundCombined, "並べ語とラウンドの語を一緒に書くと壊れる").toBe(2);
  expect(out.abbrevGroups, "`NSDI 27` が 2 語に割れない").toBe(2);
  expect(out.abbrevYear, "`NSDI 27` の 27 が 2027 として引けない").toBe(true);
  expect(out.monthDayGroups, "月日の裸の数字（`8月 27`）を年に展開している").toBe(false);
});

it("health.md は日本語で書き、数値が health.json とずれていない（SPEC §7）", () => {
  /* 「health.md：health.json の人間向け要約」と案内しておきながら、本文は英語のままだった
   * （2026-09-23 確認: "# Build health" / "Tracked venues" / "| Metric | Value |"）。
   * 読むのは収録を確かめる人なので日本語に寄せた。機械可読の正は health.json なので、
   * 各見出しに JSON のキーを併記し、**md に出た数値が json と同じこと**をここで見る
   * （表示だけ先に古くなるのを防ぐ）。 */
  const md = readFileSync(join(site, "health.md"), "utf8");
  const json = JSON.parse(readFileSync(join(site, "health.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const rows: Array<[string, string]> = [
    ["収録している会議", "tracked_venues"],
    ["次回以降に確定した締切を持つ会議", "future_confirmed_venues"],
    ["確定した締切", "confirmed_deadlines"],
    ["推定締切", "estimated_deadlines"],
    ["次回以降の推定締切", "future_estimated_deadlines"],
    ["解析上の注意の件数", "parse_warning_count"],
  ];
  expect(rows.length).toBeGreaterThanOrEqual(6);
  for (const [label, key] of rows) {
    const value = json[key];
    expect(typeof value, `health.json に ${key} がない`).toBe("number");
    const line = `| ${label}（\`${key}\`） | ${String(value)} |`;
    expect(md, `health.md の ${label} の行が health.json と合わない（または行がない）`).toContain(
      line,
    );
  }
  // 「要約」の名に反して英語に戻していないこと（機械キーは併記してあってよい）。
  for (const stale of ["# Build health", "| Metric | Value |", "Tracked venues", "Source status"]) {
    expect(md, `health.md に英語のままの箇所が残っている: ${stale}`).not.toContain(stale);
  }
  // フォールバックの有無は、数値だけでなく意味が分かる形で書く。
  expect(md).toContain("収録 snapshot で組んだか（`snapshot_fallback`）");
  expect(md).toContain(
    json.snapshot_fallback
      ? "| 収録 snapshot で組んだか（`snapshot_fallback`） | はい |"
      : "| 収録 snapshot で組んだか（`snapshot_fallback`） | いいえ |",
  );
  expect(md, "結論が先に書いていない（まとめ章がない）").toContain("## まとめ");
});

it("キーボード操作は効き、入力中は効かない（SPEC §7）", () => {
  /* 一覧には j / k / ↑ / ↓ / Enter / d / Esc / `/` の既定操作があるが、**検査も
   * 説明も無かった**（2026-09-23 確認）。とくに「検索欄で j と打ったときに行が
   * 動くか」は、打つ人にとって効くと壊れる操作なので、効かない側を固定する。
   * ビルド成果物の `onKeydown` を取り出して、作り物の画面に対して実際に叩く。 */
  const runtime = siteRuntime();
  const script = [
    "(async () => {",
    `const src = ${JSON.stringify(keydownWithBlockers(runtime))};`,
    "const calls = { update: 0, open: [], drawer: [], close: 0, focus: [] };",
    // `onKeydown` の `d` と `updateRowSelection` は行の classList を見るので、作り物でも持つ。
    "const rows = [0, 1, 2].map((i) => ({",
    "  i,",
    "  selected: false,",
    "  classList: { contains: () => false, toggle() {} },",
    "  focus() { calls.focus.push('row' + i); },",
    "  scrollIntoView() {},",
    "  setAttribute(k, v) { calls.focus.push('aria' + i + ':' + k + '=' + v); },",
    "  removeAttribute(k) { calls.focus.push('aria' + i + ':-' + k); },",
    "}));",
    "const els = {",
    "  q: { focus() { calls.focus.push('q'); } },",
    "  tbody: { querySelectorAll: () => rows },",
    "};",
    "const $ = (id) => els[id] || null;",
    "const win = { open: (href) => calls.open.push(href) };",
    "const keydown = (key, target, mode, index) => {",
    "  let prevented = false;",
    "  const state = { mode: mode || 'list' };",
    "  const fn = new Function(",
    "    'state', 'shown', 'selectedIndex', 'updateRowSelection', 'openDrawer', 'closeDrawer',",
    "    'safeExternalUrl', '$', 'window',",
    "    src + ';return onKeydown;',",
    "  );",
    "  const e = {",
    "    key,",
    "    target: target || { tagName: 'BODY' },",
    "    preventDefault() { prevented = true; },",
    "  };",
    "  const handler = fn(",
    "    state,",
    "    [{ conf: { key: 'a', link: 'https://example.org/a' }, ed: { link: 'https://example.org/a' } },",
    "     { conf: { key: 'b', link: 'https://example.org/b' }, ed: { link: '' } },",
    "     { conf: { key: 'c', link: '' }, ed: { link: '' } }],",
    "    typeof index === 'number' ? index : 1,",
    "    () => { calls.update += 1; },",
    "    (r) => { calls.drawer.push(r && r.conf ? r.conf.key : null); },",
    "    () => { calls.close += 1; },",
    "    (u) => String(u || ''),",
    "    $,",
    "    win,",
    "  );",
    // `new Function` の戻り値は作られた関数そのもの。第 2 段で呼んで初めて発火する。
    "  handler(e);",
    "  return prevented;",
    "};",
    "const out = {};",
    "  // 入力中の打鍵で行を動かさない（検索語に j を含む入力は普通にある）。",
    "  out.inInput = keydown('j', { tagName: 'INPUT' });",
    "  out.inInputUpdate = calls.update;",
    "  out.inTextarea = keydown('k', { tagName: 'TEXTAREA' });",
    "  out.inSelect = keydown('/', { tagName: 'SELECT' });",
    "  out.editable = keydown('j', { tagName: 'DIV', isContentEditable: true });",
    "  calls.update = 0;",
    "  out.list = keydown('j');",
    "  out.listUpdate = calls.update;",
    "  calls.update = 0;",
    "  out.up = keydown('k');",
    "  out.upUpdate = calls.update;",
    "  calls.update = 0;",
    // 上端・下端ではこれ以上動かさない（周回しない。外れた選択が出ない）。
    "  out.topKey = keydown('k', null, 'list', 0);",
    "  out.topUpdate = calls.update;",
    "  calls.update = 0;",
    "  out.bottomKey = keydown('j', null, 'list', 2);",
    "  out.bottomUpdate = calls.update;",
    "  out.slash = keydown('/');",
    "  out.focusQ = calls.focus.indexOf('q') >= 0;",
    "  out.d = keydown('d');",
    "  out.drawer = calls.drawer.slice();",
    "  out.esc = keydown('Escape');",
    "  out.close = calls.close;",
    "  out.enter = keydown('Enter');",
    "  out.opened = calls.open.slice();",
    "  calls.update = 0;",
    "  out.recommend = keydown('j', null, 'recommend');",
    "  out.recommendUpdate = calls.update;",
    "  // 入力の中では Esc だけ効く（検索欄のフォーカスを外す）。",
    "  let blurred = 0;",
    // 本物の入力欄は tagName を持つので、同じ形で作る（tag が引けない要素は
    // handler の先頭でそのまま返る）。
    "  out.escInInput = keydown('Escape', { tagName: 'INPUT', blur: () => { blurred += 1; } });",
    "  out.escBlurred = blurred;",
    "console.log(JSON.stringify(out));",
    "})().catch((e) => { console.error(e && e.stack || String(e)); process.exit(1); });",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Record<string, unknown>;
  // 入力中は効かない（`j` を含む検索語を打てること。検索欄は IME の入力先でもある）。
  expect(out.inInput, "検索欄で j を打ったときに処理を止めていない").toBe(false);
  expect(out.inInputUpdate, "検索欄で j を打つと行の選択が動いた").toBe(0);
  expect(out.inTextarea, "概要欄で k を打つと行の選択が動いた").toBe(false);
  expect(out.inSelect, "選択欄で / を打つと検索欄に飛んだ").toBe(false);
  expect(out.editable, "編集中の欄で j を打つと行の選択が動いた").toBe(false);
  // 入力以外は効く。
  expect(out.list, "一覧で j が効かない").toBe(true);
  expect(out.listUpdate, "一覧で jを行を選ばない").toBe(1);
  expect(out.upUpdate, "一覧で k が行を選ばない").toBe(1);
  expect(out.topKey, "上端で k が処理を止めていない").toBe(true);
  expect(out.topUpdate, "上端で k を押すと選択が外れた（周回させない）").toBe(0);
  expect(out.bottomUpdate, "下端で j を押すと選択が外れた（周回させない）").toBe(0);
  expect(out.slash, "/ で検索欄に焦点が当たらない").toBe(true);
  expect(out.focusQ, "/ が検索欄以外に焦点を当てた").toBe(true);
  expect(out.drawer, "d で選択行の詳細が開かない").toEqual(["b"]);
  expect(out.close, "Esc で詳細が閉じない").toBe(1);
  // 選択行（2件目）は会期側のリンクが無いので会議本体のリンクを開く。
  expect(out.opened, "Enter で公式ページを開かない").toEqual(["https://example.org/b"]);
  // 推薦モードでは表用の操作を無効化する（論文の欄を打っている間に表が動かない）。
  expect(out.recommend, "推薦モードで j が処理を止めていない").toBe(true);
  expect(out.recommendUpdate, "推薦モードで j に行が動いた").toBe(0);
  expect(out.escBlurred, "入力欄の中では Esc が焦点を外さない").toBe(1);
});

it("キーボードの既定操作は、てびきに書いたとおりに実装されている（SPEC §7）", () => {
  /* 第 84 回まで既定操作が検査も説明も無かった。てびきに書いた以上、実装が同じキーを
   * 処理していることを対で見る（案内だけ先に変更しても、実装だけキーを増やしても落ちる）。
   * `Esc` のように画面での書き方が違うものは、対応表をここに置く。 */
  const runtime = siteRuntime();
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const keys: Array<[string, string]> = [
    ['key === "j"', "j"],
    ['key === "k"', "k"],
    ['key === "d"', "d"],
    ['key === "/"', "/"],
    ['key === "Enter"', "Enter"],
    ['key === "Escape"', "Esc"],
    ['key === "ArrowDown"', "↓"],
    ['key === "ArrowUp"', "↑"],
  ];
  expect(keys.length).toBeGreaterThanOrEqual(8);
  // 第 86 回でこの項には class が付いた（狭い画面では隠す）。なので語句ではなく
  // 項の名前で探して、その <dt> から dd の終わりまでを取り出す。
  const named = template.indexOf("キーボードで一覧を動かす");
  expect(named, "てびきにキーボードの項がない").toBeGreaterThan(0);
  const guide = template.slice(template.lastIndexOf("<dt", named));
  const entry = guide.slice(0, guide.indexOf("</dd>"));
  expect(entry.length, "てびきにキーボードの項がない").toBeGreaterThan(40);
  for (const [code, shown] of keys) {
    expect(runtime, `ビルド成果物が ${code} を処理していない`).toContain(code);
    expect(entry, `てびきのキーボードの項に ${shown} が書いていない`).toContain(
      `<code>${shown}</code>`,
    );
  }
  // 入力欄の中で効かないことも、案内と実装が揃っている。
  expect(entry).toContain("入力欄の中ではこれらのキーはただの文字");
  expect(runtime).toContain('tag === "INPUT"');
});

it("狭い画面でも並び替えできる（見出しを消すなら並べ替えの列を対で出す・SPEC §7）", () => {
  /* 640px 以下では `thead { display: none }`で行をカード化するが、並び替えの入口は
   * 見出ししかなかった（2026-09-23 実測: スマートフォンの幅で並び替えが operation
   * 不能だった。てびきは「列の見出しを押すと並び替わります」と書いている）。
   * 同じ `toggleSort` を呼ぶ列を表の上に増やし、**見出しを消す規則と並べ替えバーを
   * 対で**見る（どちらか一方だけ変わると落ちる）。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const media = template.slice(template.indexOf("@media (max-width: 640px)"));
  const block = media.slice(0, media.indexOf("\n}"));
  expect(block, "狭い画面で見出しを隠す規則が無い（この検査の前提）").toContain(
    "thead { display: none; }",
  );
  expect(block, "見出しを隠すのに並べ替えの列を出していない（並び替え不能に戻る）").toContain(
    ".sortbar { display: flex; }",
  );
  // 並べ替えバーの列は、実装が並び替え可能な列とちょうど一致すること（双方向）。
  const bar = template.slice(template.indexOf('<div class="sortbar"'));
  const barBlock = bar.slice(0, bar.indexOf("</div>"));
  const barKeys = Array.from(barBlock.matchAll(/data-sort="([^"]+)"/g)).map((m) => m[1]);
  const headerKeys = Array.from(
    template
      .slice(template.indexOf("<thead>"), template.indexOf("</thead>"))
      .matchAll(/data-sort="([^"]+)"/g),
  ).map((m) => m[1]);
  expect(barKeys.length).toBeGreaterThanOrEqual(4);
  expect(barKeys.sort()).toEqual(headerKeys.sort());
  // 画面に出る語も見出しと同じ（別名にすると引けない語になる）。
  for (const label of ["残り", "日時（JST）", "会議", "ランク"]) {
    expect(barBlock, `並べ替えバーに ${label} の列がない`).toContain(`>${label}`);
  }
  /* キーボードの案内を消す条件は「幅」ではない（第 145 回で変更）。`j` / `k` / `d` / `/` の
   * 処理に幅の判定は無いので、狭い窓を開いた人からは案内だけが消えていた。タッチで狙う
   * 端末でだけ隠す。第 103 回まで見出ししか消しておらず、説明（`j`/`k`/`d`/`Esc` の書き方が
   * 残っていた）ので、隣接する説明も一緒に閉じる形を要求する要求はそのまま残す。*/
  const coarse = template.slice(template.indexOf("@media (hover: none), (pointer: coarse)"));
  const coarseBlock = coarse.slice(0, coarse.indexOf("\n}"));
  expect(coarseBlock, "キー操作の案内を操作手段で隠していない").toMatch(
    /\.count-kbd \{[^}]*display: none/,
  );
  expect(coarseBlock, "キーボードの案内を操作手段で隠していない").toMatch(
    /\.only-keyboard,\s*\.only-keyboard \+ dd \{[^}]*display: none/,
  );
  expect(
    block,
    "キーボードの案内を幅でも隠している（狭い窓で効いているキーの案内が消える）",
  ).not.toContain(".only-keyboard");
  expect(template).toContain('<dt class="only-keyboard">キーボードで一覧を動かす</dt>');
  // てびきも同じことを書いている。
  const guide = template.slice(template.indexOf("<dt>並び順</dt>"));
  expect(guide.slice(0, guide.indexOf("</dd>"))).toContain("並べ替え");
});

it("並べ替えの目印は列見出しと並べ替えバーの両方に付く（SPEC §7）", () => {
  const runtime = siteRuntime();
  const script = [
    "(async () => {",
    `const src = ${JSON.stringify(jsFunction(runtime, "setSortAria"))};`,
    "const nodes = [];",
    "const mk = (tag, key) => ({",
    "  tagName: tag,",
    "  attrs: {},",
    "  text: (key === 'rem' ? '残り ↕' : 'ランク ↕'),",
    "  getAttribute(n) { return n === 'data-sort' ? key : null; },",
    "  setAttribute(n, v) { this.attrs[n] = v; },",
    "  get textContent() { return this.text; },",
    "  set textContent(v) { this.text = v; },",
    "});",
    "const th = mk('TH', 'rem');",
    "const button = mk('BUTTON', 'rank');",
    "const other = mk('BUTTON', 'rem');",
    "const document = { querySelectorAll: (sel) => (sel === '[data-sort]' ? [th, button, other] : []) };",
    "const fn = new Function('document', 'sortAsc', 'sortMarkJa', 'return (' + src + ')');",
    // `sortMarkJa` の実際の契約（見出しでは語に続けて置く。先頭スペースは付けない）。
    "const setSortAria = fn(document, false, (active, asc) => (active ? (asc ? '↑' : '↓') : '↕'));",
    "const out = [];",
    "setSortAria('rank');",
    "out.push({ th: [th.attrs['aria-sort'], th.text], button: [button.attrs['aria-pressed'], button.text], other: [other.attrs['aria-pressed'], other.text] });",
    "console.log(JSON.stringify(out[0]));",
    "})().catch((e) => { console.error(e && e.stack || String(e)); process.exit(1); });",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Record<string, [string, string]>;
  // 押している列だけ目印が変わる（見出しとバーで同じ規則）。
  expect(out.button).toEqual(["true", "ランク ↓"]);
  expect(out.th).toEqual(["none", "残り ↕"]);
  // 別の列のボタンが押したことにされないこと。
  expect(out.other).toEqual(["false", "残り ↕"]);
});

it("操作できる箇所に焦点の目印があり、隠した制御が操作不能になっていない（SPEC §7）", () => {
  /* 分野チップの checkbox は `.chips input { display: none }` で消していた
   * （2026-09-23 実測）。`display: none` はタブ順序からも外れるので、**分野での
   * 絞り込みがキーボードで到達不能**だった。期間・種別・ランクの `<select>` も
   * `outline: none` だけで焦点の目印を書いていなかった（入力欄は border-color が
   * 変わるが、select は変わらない）。印刷 CSS を除いて検査する。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const style = template.slice(template.indexOf("<style>"), template.indexOf("</style>"));
  // 印刷 CSS は操作要素を意図的に消す（印刷した紙で操作はしない）ので対象外。
  const printAt = style.indexOf("@media print");
  let css = style;
  if (printAt >= 0) {
    let depth = 0;
    let i = style.indexOf("{", printAt);
    while (i < style.length) {
      if (style[i] === "{") depth += 1;
      else if (style[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
      i += 1;
    }
    css = style.slice(0, printAt) + style.slice(i + 1);
  }
  // CSS の注釈を落とす（注釈の中に `outline: none` と同じ語を書いているので、
  // 規則の選抜が注釈ごと拾って誤判した）。
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");

  // ① 操作要素そのものに display: none を掛けていないこと（タブ順序から外れて
  //    操作不能になる。`display: none` と `opacity: 0` は見た目は同じだが違う）。
  const rules = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g));
  expect(rules.length).toBeGreaterThan(40);
  for (const [, selector, body] of rules) {
    if (!/display:\s*none/.test(body)) continue;
    const sel = selector.trim();
    expect(
      /\b(input|select|textarea|button)\b/.test(sel),
      `操作要素を display:none にしている（キーボードで到達不能になる）: ${sel}`,
    ).toBe(false);
  }

  // ② 分野チップは「見えなくするだけ」でタブに残り、焦点がラベルに出ること。
  const chipRule = css.slice(css.indexOf(".chips input {"));
  expect(chipRule.slice(0, 240), "チップの checkbox が元に戻って消えている").toContain(
    "opacity: 0;",
  );
  expect(css, "チップの焦点の目印が無い").toContain(".chips label:has(input:focus-visible)");

  // ③ 焦点の目印を落としている制御が無いこと（`outline: none` を掛けたら、
  //    同じ要素に対する出す側の規則を書く。規則の有無を要素ごとに突き合わせる）。
  const focusRules = Array.from(css.matchAll(/([^{}]+)\{[^{}]*outline:[^{}]*\}/g))
    .filter(([, selector]) => /:focus/.test(selector))
    .map(([, selector]) => selector);
  expect(focusRules.length).toBeGreaterThanOrEqual(3);
  const dropped = Array.from(css.matchAll(/([^{}]+)\{([^{}]*outline:\s*none[^{}]*)\}/g)).map((m) =>
    m[1].trim(),
  );
  expect(dropped.length).toBeGreaterThanOrEqual(3);
  for (const sel of dropped) {
    for (const part of sel.split(",")) {
      const probe = part.trim().replace(/:focus.*$/, "");
      // `input[type=search]` なら要素名 + 属性まで、`select` なら要素名で探す。
      const needle = probe.replace(/\s+/g, "");
      const hit = focusRules.some((rule) =>
        rule.split(",").some((f) =>
          f
            .replace(/:focus(-visible)?/, "")
            .replace(/\s+/g, "")
            .startsWith(needle),
        ),
      );
      expect(hit, `${probe} は outline: none なのに焦点の目印の規則が無い`).toBe(true);
    }
  }
  for (const sel of ["select:focus-visible", "button:focus-visible", "textarea:focus-visible"]) {
    expect(css, `焦点の目印の規則に ${sel} が無い`).toContain(sel);
  }
});

it("表の列見出しと件数欄が支援技術に伝わる（SPEC §7）", () => {
  /* 列見出しの `<th>` に `scope` が無く、月見出し側は `scope="colgroup"` を使って
   * いた（2026-09-23 実測）。支援技術では 478 行のセルがどの列のものか伝えられない。
   * また絞り込みのたびに書き換わる件数欄（`#count`）と履歴状態（`#historyStatus`）に
   * `aria-live` が無く、**入力したのに画面がどう変わったか**が黙って入れ替わっていた。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const head = template.slice(template.indexOf("<thead>"), template.indexOf("</thead>"));
  const ths = Array.from(head.matchAll(/<th\b([^>]*)>/g));
  expect(ths.length).toBeGreaterThanOrEqual(7);
  for (const [, attrs] of ths) {
    expect(attrs, `<th> に scope が無い（${attrs.trim()}）`).toContain('scope="col"');
  }
  // 絞り込みのフィードバックを出す欄は、書き換わったことが分かる形にする。
  // 読み上げは専用の短い欄に出す（`#count` は「のぞく」の内訳まで載る長い欄なので、
  // 第 88 回でそのまま aria-live を付けると 1 打鍵ごとに数十語が流れた。第 89 回で分割）。
  for (const probe of [
    '<span id="countLive" class="sr-label" aria-live="polite">',
    '<div id="historyStatus" aria-live="polite"',
  ]) {
    expect(template, `支援技術に伝わらない欄がある: ${probe}`).toContain(probe);
  }
  expect(template, "長い件数欄そのものを aria-live に戻さない").not.toContain(
    '<span id="count" aria-live',
  );
  // 画面に出す長い内訳（「のぞく」）は読み上げない。件数と状態の通知だけを読み上げる。
  const runtimeLive = siteRuntime();
  expect(runtimeLive).toContain("cnt += ` ｜ のぞく");
  expect(runtimeLive).not.toContain("cntLive += ` ｜ のぞく");
  for (const note of ["全履歴を読み込み中", "意味検索を実行中", '$("countLive")']) {
    expect(runtimeLive, `読み上げ欄への書き込みが減っている: ${note}`).toContain(note);
  }
  // 月見出しは列グループの見出し（列見出しと同じ規則になっていること）。
  const runtime = siteRuntime();
  expect(runtime).toContain('th.scope = "colgroup"');
});

it("絞り込みの各欄に名前があり、支援技術から消していない（SPEC §7）", () => {
  /* 種別・ランク・締切までの見出しはただの `<span>` で、`<label for>` では無かった
   * （2026-09-23 実測）。支援技術では 3 つの選択欄が「すべて」としか読めず、どれが
   * 種別でどれがランクか分からない。検索欄は見出し自体を置いていなかった
   * （placeholder だけ。打つと消える）。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const body = template.slice(template.indexOf("<body"));
  const controls = Array.from(body.matchAll(/<(?:select|input|textarea)\b[^>]*>/g)).map(
    (m) => m[0],
  );
  expect(controls.length).toBeGreaterThanOrEqual(12);
  const labelled = new Set(
    Array.from(body.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)).map((m) => m[1]),
  );
  const ids = new Set(Array.from(body.matchAll(/\bid="([^"]+)"/g)).map((m) => m[1]));
  // ラベルで囲う型（`<label class="check"><input …></label>`）も名前を持つ。
  // タグ文字列だけ見ても分からないので、本文上の位置の前後を見て判定する。
  const wrappedInLabel = (id: string) => {
    const at = body.indexOf(`id="${id}"`);
    if (at < 0) return false;
    return body.lastIndexOf("<label", at) > body.lastIndexOf("</label>", at);
  };
  for (const tag of controls) {
    const id = /\bid="([^"]+)"/.exec(tag)?.[1] || "";
    if (!id) continue;
    // 隠れた保持用（`paperText` など）やファイル選択は、ここでの点検対象から除く。
    if (/\shidden\b|type="hidden"|type="file"/.test(tag)) continue;
    const hasName = labelled.has(id) || /aria-label=|placeholder=/.test(tag) || wrappedInLabel(id);
    // 選択欄と検索欄は「名前がある」だけでは足りない（placeholder は打つと消える）。
    const needsLabel = /<select|type="search"/.test(tag);
    if (needsLabel) {
      expect(
        labelled.has(id),
        `id="${id}" に label[for] が無い（支援技術に名前が伝わらない）`,
      ).toBe(true);
    } else {
      // チェックボックスはラベルで囲われている（`<label class="check">`）。
      expect(hasName || labelled.has(id), `id="${id}" に名前が無い`).toBe(true);
    }
  }
  // `for` が居ない id を指していると、名前もクリックでの焦点も静かに切れる。
  for (const target of labelled) {
    expect(ids.has(target), `label[for="${target}"] が対応する欄を持たない`).toBe(true);
  }
  // 見えないラベルは `display: none` ではなく clip で消す（第 87 回と同じ教訓）。
  const sr = template.slice(template.indexOf(".sr-label {"));
  expect(sr.slice(0, 260)).toContain("clip-path:");
  expect(sr.slice(0, 260)).not.toContain("display: none");
  // 画面に出る見出しは従来どおりスタイルが当たる（見た目を壊していない）。
  expect(template).toContain(".field > span, .field > label");
});

it("CSV のランク列は画面と同じ書き方で、番兵の `N` を渡さない（SPEC §7）", () => {
  /* 画面と行の詳細はランクの無い所を「評価なし」と出す（第 47 回）が、CSV 書き出しは
   * 上流の番兵 `N` をそのまま出していた（2026-09-23 実測: 将来締切 917 行で 271 マス）。
   * 表計算で「N という等級」で絞り込めてしまい、空欄との違いも読めない。
   * 収録カタログから組んだ実データの CSV で検査する（合成 fixture では 0 マスになる）。 */
  const out = join(mkdtempSync(join(tmpdir(), "cfp-csv-rank-")), "public");
  const emptyCache = mkdtempSync(join(tmpdir(), "cfp-csv-rank-cache-"));
  const built = runCli(out, {
    now: "2026-08-09T00:00:00Z",
    cache: emptyCache,
    extra: ["--no-embeddings"],
  });
  expect(built.status, built.stderr).toBe(0);
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(out, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(out, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(DATA).filter((r) => r.t > now);",
    "const csv = Recommender.deadlinesToCsv(rows, now);",
    "const split = (line) => { const out2 = []; let cur = ''; let q = false;",
    "  for (let i = 0; i < line.length; i += 1) { const c = line[i];",
    "    if (q) { if (c === '\\\"') { if (line[i + 1] === '\\\"') { cur += '\\\"'; i += 1; } else { q = false; } } else { cur += c; } }",
    "    else if (c === '\\\"') { q = true; }",
    "    else if (c === ',') { out2.push(cur); cur = ''; } else { cur += c; } }",
    "  out2.push(cur); return out2; };",
    "const lines = csv.split('\\r\\n').filter((l) => l.length > 0);",
    "const head = split(lines[0]);",
    "const body = lines.slice(1).map(split);",
    "const cols = head.length;",
    "const idx = ['CCF', 'CORE', 'THCPL'].map((h) => head.indexOf(h));",
    "let wrong = 0; let sentinelCells = 0; let unratedCells = 0;",
    "body.forEach((c) => { if (c.length !== cols) { wrong += 1; return; }",
    "  idx.forEach((i) => { if (c[i] === 'N') sentinelCells += 1; if (c[i] === '評価なし') unratedCells += 1; }); });",
    // 収録データ側の番兵の数を数え、CSV の「評価なし」と突き合わせる（双方向の検査）。
    "const absent = ['n', 'none', '-'];",
    "let sentinelData = 0;",
    "rows.forEach((r) => { const rk = (r.conf && r.conf.rank) || {};",
    "  ['ccf', 'core', 'thcpl'].forEach((k) => { const v = String(rk[k] ?? '').trim().toLowerCase();",
    "    if (v && absent.indexOf(v) >= 0) sentinelData += 1; }); });",
    "console.log(JSON.stringify({ rows: rows.length, cols, wrong, sentinelCells, unratedCells, sentinelData }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout.trim().split("\n").pop() || "{}");
  expect(got.rows).toBeGreaterThan(500);
  expect(got.cols).toBe(14);
  // 引用符で括った欄も含めて列がずれていないこと（表計算で化ける元）。
  expect(got.wrong, "CSV の列数が揃わない行がある").toBe(0);
  expect(
    got.sentinelData,
    "実データにランクの番兵が含まれていない（検査が空振り）",
  ).toBeGreaterThan(0);
  expect(got.sentinelCells, "ランクの番兵 `N` が表計算へそのまま出ている").toBe(0);
  // 番兵の数だけ「評価なし」が出ている（書き換え漏れと過剰変換の両方を見る）。
  expect(got.unratedCells).toBe(got.sentinelData);
});

it("日本語の案内に中国語の略語を混ぜない（SPEC §7）", () => {
  /* dropdown に当たる中国語表記を説明文に混入させては 3 回指摘している（2026-09-23 まで）。
   * 画面に出す語・案内に書く語は日本語で書く、という §7 の約束をファイル横断で検める。
   * 語列出典が自分自身を参照して落ちないよう、点検語は文字番号で書く。
   * 引用（実物の誤記をバッククォートで書いた記録）は対象外。
   * 第 97 回で、自分が案内に実際に混入させた語（中国語の簡体字表記と韓国語の活用の語）を
   * 点検語に足した。点検語の一覧はこのファイル自身も見るので、該当の語は引用しない。
   * ハングルは日本語の案内に出る用事が無いので文字範囲で抑える（会議名は日本語か現地表記、
   * 点検語自身のエスケープは文字範囲に掛からない）。 */
  const words = [
    "\u4e0b\u62c9",
    "\u6298\u53e0",
    "\u8fd9\u4e9b",
    "\u6279\u91cf",
    "\u8fc7\u53bb",
    "\u95ee\u9898",
    "\u663e\u793a",
    "\u53d8\u91cf",
    "\u51fd\u6570",
    "\u5df2\u7ecf",
    "\u8fd9\u91cc",
    // 簡体字専用の一字目（日本語の新字体・共用漢字と字形が別な物だけ。たとえば日本語の
    // 「状態」の状や「文章」は正常な日本語なので入れない – 実際に混ぜて検査を落としたり、
    // 誤検出で検査を信用できなくしたりするのはここの失敗なので、一字ずつ確認して足す）。
    "\u52b3",
    "\u9879",
    "\u8fc7",
    "\u53d1",
    "\u5b9e",
    "\u663e",
    "\u56fe",
    "\u5173",
    "\u7f51",
    "\u503c",
    "\u8ba9",
    "\u4ece",
    "\u8bf4",
    "\u8bf7",
    "\u4e1c",
    "\u8f66",
    "\u9a6c",
    "\u9e1f",
    "\u9c7c",
    "\u95e8",
    "\u957f",
    "\u98ce",
    "\u98de",
    "\u4e66",
    "\u7535",
    "\u5bf9",
    "\u65f6",
    "\u89c1",
    "\u89c2",
    "\u4e49",
    "\u6c14",
    "\u534e",
    "\u79cd",
    "\u7ebf",
    "\u672f",
    "\u8fd0",
    "\u8fdc",
    "\u8fb9",
    "\u5904",
    "\u4ea7",
    // 日本語の語として成り立たない二字目以上の語（同じ字を使う中華語）。
    "\u53c2\u6570",
    "\u5176\u4ed6",
    // 同じ運びの別の表記（二字目の文字番号が違う）。第 122 回でこちらの実物が
    // 案内とコメントに残っていたのに、上の表記しか点検していなくて黙っていた。
    "\u5176\u5b83",
    "\u6b67",
    // 「新しい」に当たる四字の語は日本語として立たない（第 120 回の手記に混入した）。
    "\u65b0\u7684",
    // 「データ」「ここ」に当たる語も同じ系統（上の二字語と同じ運びで混入する）。
    "\u6570\u636e",
    "\u8fd9\u91cc",
  ];
  const targets = [
    "README.md",
    "SPEC.md",
    "site/template.html",
    "site/app.ts",
    "site/recommender.ts",
    "tests/build_golden.test.ts",
    "tests/recommender.test.ts",
  ];
  for (const rel of targets) {
    const text = readFileSync(join(REPO_ROOT, rel), "utf8").replace(/`[^`\n]*`/g, "");
    for (const word of words) {
      expect(text, `${rel} に中国語の略語「${word}」が混入している`).not.toContain(word);
    }
    // 点検語は文字番号で書いているので、一文字でも間違えると検査が黙って通る
    // （第 122 回で、実際に混入していた語の二字目の文字番号を間違えていた）。
    // 意図した語が実際に点検されていることを、文字番号から組み立てた見本で確かめる。
    for (const points of [
      [0x5176, 0x5b83],
      [0x5176, 0x4ed6],
      [0x4e0b, 0x62c9],
      [0x65b0, 0x7684],
    ]) {
      const sample = String.fromCharCode.apply(null, points);
      const label = points.map((c) => "U+" + c.toString(16)).join("+");
      expect(words, `点検語に ${label} の表記が無い（文字番号の書き間違い？）`).toContain(sample);
      // 見本の文が実際に点検で落ちることも見る。語列表に有っても、読み方が違いますと
      // 混入を検出できないので、ここが通って初めて検査が効いていると言える。
      const sampleText = `見本: ${sample} の混入`;
      expect(
        words.some((word) => sampleText.includes(word)),
        `見本 ${label} を検出できない`,
      ).toBe(true);
    }

    // 韓国語文字列の混入（第 97 回で動詞の活用形を実際に混入させた。日本語の案内に
    // 出る用事が無いので、ハングルは文字範囲で抑える。ここでは語を引用しない）。
    const hangul = /[\uac00-\ud55c]+/g;
    expect(text.match(hangul) || [], `${rel} にハングルが混入している`).toEqual([]);
  }
});

it("締切の時刻を持たない行を交ぜても日時順が崩れない（SPEC §7）", () => {
  /* `a.t < b.t` は片側が NaN だと常に false なので、締切の時刻を持たない行
   * （常時受付の学術誌など）を交ぜた並べ替えで比較の向きが定まらなかった。
   * 2026-09-23 実測（修正前のビルド成果物）: cmp(時刻なし, 時刻あり) = 1 かつ
   * cmp(時刻あり, 時刻なし) = 1 で反対称でなく、同じ集合を入力順を変えて sort すると
   * 結果が変わり、昇順では時刻の無い行が先頭に出て「いちばん近い締切」と誤読させた。
   * 収録カタログには現時点で時刻の無い行が 0 件（実測）なので今日の見え方は変わらないが、
   * 学術誌を 1 行追加するだけで日時順の表全体が崩れる形だった。ビルド成果物の比較関数で
   * 性質を検める。 */
  const rt = siteRuntime();
  // 会議名と種別の並びは本検査の本題ではないので、決定的な簡潔実装を渡す。
  // 比較関数はこれ以外の自由変数を持たせないこと（第 91 回でヘルパーを増やしたら、
  // 既存の抽出検査が `ReferenceError` で 6 件落ちた。渡す物を増やさない設計にする）。
  const compare = new Function(
    "conferenceNameCell",
    "kindSortIndex",
    `return (${jsFunction(rt, "compareDeadlineRows")});`,
  )(
    (r: { n?: string }) => String(r?.n ?? ""),
    () => 0,
  );

  type Row = { t: number; n: string; kind: string };
  const rows: Row[] = [
    { t: Number.NaN, n: "J1", kind: "journal" },
    { t: Number.NaN, n: "J2", kind: "journal" },
    { t: Date.parse("2026-09-03T00:00:00Z"), n: "p3", kind: "paper" },
    { t: Date.parse("2026-09-01T00:00:00Z"), n: "p1", kind: "paper" },
    { t: Date.parse("2026-09-02T00:00:00Z"), n: "p2", kind: "paper" },
  ];
  // ① 反対称性（比較関数の契約）。旧実装はここが 1 / 1 だった。
  for (const a of rows) {
    for (const b of rows) {
      expect(
        Math.sign(compare(a, b, 1)) + Math.sign(compare(b, a, 1)),
        `反対称でない: ${a.n} と ${b.n}`,
      ).toBe(0);
    }
  }
  // ② 入力順を変えても結果が同じ（NaN で順序が不定になっていたことの直接の検査）。
  const orders = [
    rows,
    rows.slice().reverse(),
    [rows[2], rows[0], rows[3], rows[1], rows[4]],
    [rows[1], rows[4], rows[3], rows[0], rows[2]],
  ];
  const asc = new Set(
    orders.map((o) =>
      o
        .slice()
        .sort((x, y) => compare(x, y, 1))
        .map((r) => r.n)
        .join(" "),
    ),
  );
  const desc = new Set(
    orders.map((o) =>
      o
        .slice()
        .sort((x, y) => compare(x, y, -1))
        .map((r) => r.n)
        .join(" "),
    ),
  );
  expect(asc.size, `昇順が入力順に依存している: ${[...asc].join(" / ")}`).toBe(1);
  expect(desc.size, `降順が入力順に依存している: ${[...desc].join(" / ")}`).toBe(1);
  // ③ 時刻の無い行は向きに関係なく最後尾（降順で先頭に反転すると「いちばん遠い」に化ける）。
  expect([...asc][0], "昇順で時刻の無い行が末尾に無い").toBe("p1 p2 p3 J1 J2");
  expect([...desc][0], "降順で時刻の無い行が末尾に無い").toBe("p3 p2 p1 J2 J1");
});

it("過去の締切も表示すると、過ぎた行が画面の先頭を埋め尽くさない（SPEC §7）", () => {
  /* 「過去の締切も表示」を入れると、既定の並び（残りの昇順）では過ぎた行がそのまま
   * 先頭に来る。収録カタログは締切時刻が過ぎた行が 2,318 行（総 3,235 行。2026-09-23 実測）
   * で、2019 年 5 月の行が画面の先頭になり、これからの締切はすべてその下に沈んでいた。
   * 過ぎた行を後ろの塊へ寄せ、塊の切り替わりに見出しを出すことを、ビルド成果物の
   * `filter` で検査する（並びの契約そのものを見るため、行は合成する。件数の実測値は
   * 上のコメントに書いたとおり）。 */
  const app = siteRuntime();
  const filterSrc = jsFunction(app, "filter");
  const script = [
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-09T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    // 3 行はこれからの締切、2 行は過ぎた締切（古い順に 2019, 2026-08-08）。
    "function row(key, t) {",
    "  return { kind: 'paper', est: false, cats: ['hpc'], rankPairs: [], hay: key,",
    "    t: t, tLast: t, dateOnly: false, localDate: '',",
    "    ed: { year: 2026, deadlines: [], place: '', date_text: '', event_start: '', event_end: '' },",
    "    dl: { kind: 'paper', round: 1 }, conf: { key: key, title: key, link: '' } };",
    "}",
    "const rows = [",
    "  row('near', now + DAY), row('mid', now + 30 * DAY), row('far', now + 400 * DAY),",
    "  row('just-closed', now - DAY), row('old', Date.parse('2019-05-25T00:00:00Z')),",
    "];",
    'const state = { q: "", cats: [], kind: "", rank: "", win: "all", est: false, past: true };',
    FILTER_RUNTIME_STUBS,
    'const filter = new Function("Date", "DAY", "rows", "state", "sortAsc", "sortKey",',
    '                            "return (" + FILTER + ")")(FakeDate, DAY, rows, state, true, "rem");',
    "const out = filter();",
    "console.log(JSON.stringify({",
    "  order: out.map((r) => r.conf.key),",
    "  flags: out.map((r) => r._pastBlock),",
    " }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout.trim().split("\n").pop() || "{}");
  // これからの 3 行が先頭、過ぎた 2 行が後ろの塊（変更前は古い 2019 年の行が画面の先頭だった）。
  // 塊の**内側**は選んだ列の向きそのまま（残りの昇順なので、過ぎた塊は古い順になる）。
  // 塊の中で向きを反転させると列見出しの ↑ と食い違うので、そこは正直に保つ。
  expect(got.order).toEqual(["near", "mid", "far", "old", "just-closed"]);
  expect(got.flags).toEqual([0, 0, 0, 1, 1]);
  // 塊の切り替わりに見出し行を出す（`month-row` を併せ持つのは、列を跨ぐ見出しとして
  // 支援技術に同じ扱いをさせるため。キーボード移動が飛ばすのと同じ規則でもある）。
  expect(app).toContain('tr.className = "month-row section-row"');
  expect(app).toContain('"過ぎた締切"');
  expect(app).toContain("過ぎた締切 ${countJa(pastBlockTotal)} 件は下にまとめました");
});

it("「本日終了」は JST の暦日で決まる（SPEC §7）", () => {
  /* 経過日数の floor で決めていたため、JST で昨日終わった締切が「本日終了」になっていた
   * （2026-09-23 実測: JST 15:00 に見た JST 前日 19:00 締切 = 20 時間前 → 「本日終了」）。
   * 「今日の締切だと思って開いたら昨日だった」になり、一覧が JST を単位にしている約束とも
   * 食い違う。暦日の差で数えることにして、てびきにもその旨を書いた。 */
  const app = siteRuntime();
  const script = [
    "(async () => {",
    'const now = Date.parse("2026-08-10T06:00:00Z"); // JST 2026-08-10 15:00',
    "class FakeDate extends Date { static now() { return now; } }",
    // 関数本体はテンプレートリテラルを含むので、JSON 化して渡す（素で埋めると
    // 外側のテンプレートが壊れる。2026-09-23 に実発生）。
    `const REMAIN_SRC = ${JSON.stringify(jsFunction(app, "remain"))};`,
    'const remain = new Function("Date", "DAY", "return (" + REMAIN_SRC + ")")(FakeDate, 86400000);',
    "const H = 3600000;",
    "const at = (hoursAgo) => remain(now - hoursAgo * H).text;",
    "console.log(JSON.stringify({",
    "  sameDay1h: at(1),            // JST 同日 14:00",
    "  sameDay8h: at(8),            // JST 同日 07:00",
    "  sameDay14h: at(14),          // JST 同日 01:00（日付は同じ）",
    "  yesterdayJst20h: at(20),     // JST 前日 19:00 ← 旧実装は「本日終了」",
    "  yesterdayJst26h: at(26),     // JST 前日 13:00",
    "  twoDays: at(50),             // JST 2 日前 13:00",
    "  futureNow: remain(now + 30 * 60000).text,",
    "  futureHours: remain(now + 5 * H).text,",
    "  futureDays: remain(now + 3 * 86400000).text,",
    "  soonClass: remain(now + 3 * 86400000).cls,",
    "  farClass: remain(now + 20 * 86400000).cls,",
    " }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout.trim().split("\n").pop() || "{}");
  expect(got.sameDay1h).toBe("本日終了");
  expect(got.sameDay8h).toBe("本日終了");
  expect(got.sameDay14h).toBe("本日終了");
  // 暦日で数えるので、20 時間前（JST では昨日）は「1 日前」。
  expect(got.yesterdayJst20h).toBe("1 日前に終了");
  expect(got.yesterdayJst26h).toBe("1 日前に終了");
  expect(got.twoDays).toBe("2 日前に終了");
  // 先の側は今までどおり（境界を同時に抑える）。
  expect(got.futureNow).toBe("まもなく");
  expect(got.futureHours).toBe("あと 5 時間");
  expect(got.futureDays).toBe("あと 3 日");
  expect(got.soonClass).toBe("soon");
  expect(got.farClass).toBe("");
  // 実装が暦日で数えることを、てびきが同じ約束で書いている（案内と実装のズレ検出）。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  expect(template).toContain("日数は JST の暦日");
});

it("収録状況の四つ組は、何を数えているかと単位がラベルに出る（SPEC §7）", () => {
  /* 画面上部の四つの数は、単位を書かないまま会議の数と締切の件数を並べていた
   * （2026-09-23 実測: 「追跡会議数 680」と「直近30日締切 176」が同じ物だと読める）。
   * 「穴場/特化誌」はラベルだけ 2 つの集まりを騙っていた（実数を入れていたのは
   * niche タグの会議 63 だけで、journal タグは数えていない）。国内もチェックボックスは
   * 「国内研究会・国内シンポジウム」なのに、ここは「国内研究会」だった。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const barStart = template.indexOf('<div class="summary-bar">');
  expect(barStart).toBeGreaterThan(0);
  const bar = template.slice(barStart, template.indexOf("</header>", barStart));
  // 絞り込みで動かない数なので、その旨をキャプションに書く。
  expect(bar).toContain("絞り込み前の収録全体");
  expect(bar).toContain("収録している会議:");
  expect(bar).toContain("これからの30日間の締切:");
  expect(bar, "締切の件数に単位が無い").toContain('class="stat-unit">件<');
  // ラベルと実数がズレていた 2 件を戻さない。
  expect(bar).not.toContain("穴場/特化誌");
  expect(bar).toContain("穴場として収録した会議:");
  expect(bar).not.toContain("<span>国内研究会:</span>");
  expect(bar).toContain("国内研究会・国内シンポジウム:");
  // 開発よりの語だった「追跡会議数」を戻さない。
  expect(bar).not.toContain("追跡会議数");
  // てびきに単位と数え方の説明がある（画面が示す語をてびきが説明していないと調べられない）。
  const help = template.slice(template.indexOf('id="helpPanel"'));
  const guide = help.slice(0, help.indexOf("</dl>"));
  expect(guide).toContain("画面上部の四つの数");
  expect(guide, "四つ組が絞り込みで動かないことをてびきが書いていない").toContain(
    "絞り込み前の収録全体",
  );
  expect(guide).toContain("niche");
  expect(guide).toContain("domestic-jp");
  // id はそのまま（JS 側の更新先が生きていること）。
  const runtime = siteRuntime();
  for (const id of ["statConfs", "statUpcoming", "statNiche", "statDomestic"]) {
    expect(runtime, `収録状況の更新先が消えている: ${id}`).toContain(`"${id}"`);
  }
});

it("早め絞り込みのボタンは、同じ条件を出す欄と同じ語で書かれている（SPEC §7）", () => {
  /* ボタンの語が、同じ条件を出す欄と割れていた（2026-09-23 実測）。
   * 分野チップは「高性能計算」なのに、ボタンだけ内部キーの HPC を出していた。
   * チェック欄は「国内研究会・国内シンポジウムのみ」なのに、ボタンは「国内研究会」だけで、
   * プリセットの方が狭い条件だと読めた（中身は同じ domestic-jp）。
   * てびきが並べる語も実装と食い違っていた。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const barStart = template.indexOf('<div class="presets-bar');
  expect(barStart).toBeGreaterThan(0);
  const bar = template.slice(barStart, template.indexOf("</div>", barStart));
  const buttons = Array.from(bar.matchAll(/data-preset="([a-z_0-9]+)"[^>]*>([^<]*)<\/button>/g));
  expect(buttons.length, "早め絞り込みのボタンが見つからない").toBe(5);
  const labels = new Map(buttons.map((m) => [m[1], m[2]]));

  // 分野のボタンは、分野チップと同じ日本語の語を使う（内部キーを画面に出さない）。
  const rec = siteRuntime("recommender.js");
  const catLabel = (key: string) => {
    const at = rec.indexOf("CATEGORY_LABELS_JA");
    expect(at, "CATEGORY_LABELS_JA が見つからない").toBeGreaterThan(0);
    const m = new RegExp(`\\b${key}: "([^"]+)"`).exec(rec.slice(at, at + 2000));
    expect(m, `分野の語が見つからない: ${key}`).not.toBeNull();
    return (m as RegExpExecArray)[1];
  };
  const hpc = catLabel("hpc");
  const systems = catLabel("systems");
  expect(labels.get("hpc_sys")).toBe(`${hpc}・${systems}`);
  expect(bar, "内部キーの HPC を画面に出している").not.toContain("HPC");

  // 国内のボタンは、チェック欄と同じ集まり名を使う（同じ物に二つの名前を付けない）。
  const checkbox = /<span title="[^"]*">([^<]*国内研究会[^<]*)<\/span>/.exec(template);
  expect(checkbox, "国内のチェック欄の語が見つからない").not.toBeNull();
  const domestic = labels.get("domestic") || "";
  expect(checkbox![1], `ボタンの語がチェック欄と違う集まり名: ${domestic}`).toContain(domestic);

  // てびきが並べる語が実装と同じ（案内と実装のズレ検出）。
  const help = template.slice(template.indexOf('id="helpPanel"'));
  const guide = help.slice(0, help.indexOf("</dl>"));
  for (const [, , label] of buttons) {
    expect(guide, `てびきにボタン「${label}」が実装と同じ語で書かれていない`).toContain(
      `「${label}」`,
    );
  }
});

it("「データ生成」の時刻は JST と曜日で出る（SPEC §7）", () => {
  /* 生成時刻は UTC の `...Z` で来るため、そのまま出していた（2026-09-23 実測:
   * 「データ生成: 2026-08-09T00:00:00Z」）。一覧は JST + 曜日を単位にしているので、
   * この欄だけ別単位だと、夜ビルドで日付が一日ずれて見える（UTC 8/8 20:00 は
   * JST では 8/9 の朝）。読めない値には嘘の日付を作らない。 */
  const app = siteRuntime();
  const weekday = app.match(/const WEEKDAY_JA = \[[^\]]*\];/)?.[0];
  expect(weekday, "WEEKDAY_JA が見つからない").toBeTruthy();
  const script = [
    "(async () => {",
    weekday,
    // 抽出した関数本体は、引用符の中へ素で埋めると壊れる（JSON 化して別の変数に置く）。
    `const PAD_SRC = ${JSON.stringify(jsFunction(app, "pad"))};`,
    `const FMT_SRC = ${JSON.stringify(jsFunction(app, "fmtJst"))};`,
    `const GEN_SRC = ${JSON.stringify(jsFunction(app, "generatedAtLabel"))};`,
    'const pad = new Function("return (" + PAD_SRC + ")")();',
    'const fmtJst = new Function("WEEKDAY_JA", "pad", "return (" + FMT_SRC + ")")(WEEKDAY_JA, pad);',
    'const generatedAtLabel = new Function("fmtJst", "return (" + GEN_SRC + ")")(fmtJst);',
    "console.log(JSON.stringify({",
    "  night: generatedAtLabel('2026-08-08T20:00:00Z'),",
    "  morning: generatedAtLabel('2026-08-09T00:00:00Z'),",
    "  broken: generatedAtLabel('未取得'),",
    " }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout.trim().split("\n").pop() || "{}");
  // UTC では 8/8 の夜でも、JST では 8/9 の朝（一日進んだ日付を出す）。
  expect(got.night).toMatch(/^データ生成: 2026-08-09\([日月火水木金土]\) 05:00 JST$/);
  expect(got.night).not.toContain("2026-08-08");
  expect(got.morning).toMatch(/^データ生成: 2026-08-09\([日月火水木金土]\) 09:00 JST$/);
  // 時刻として読めない値は原文を残す（嘘の日付を作らない）。
  expect(got.broken).toBe("データ生成: 未取得");
  // てびきは「右上の更新時刻」と書いている。実際のレイアウト（見出し行の右端）と合うこと。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const brand = template.slice(template.indexOf(".brand-row {"));
  expect(brand.slice(0, 240)).toContain("justify-content: space-between");
  const genat = template.slice(template.indexOf('id="genat"'));
  expect(genat.slice(0, 80), "生成時刻の欄が見出し行に無い").toContain("</div>");
  // てびきが「右上の更新時刻」とだけ書いていた（実際の語は「データ生成」で、単位も
  // 出さなかった）。画面に出る語と単位をそのまま引けるようにする。
  const help = template.slice(template.indexOf('id="helpPanel"'));
  const guide = help.slice(0, help.indexOf("</dl>"));
  expect(guide).toContain("右上");
  expect(guide, "てびきが画面の語「データ生成」を挙げていない").toContain("データ生成");
  expect(guide, "てびきが生成時刻の単位を書いていない").toContain("JST");
});

it("データ源の行は内部の実装語を出さず、上流は一次資料へ飛べる（SPEC §7）", () => {
  /* 以前は `ccfddl (ccfddl/ccf-deadlines, MIT) / aideadlines (…) / local (data/extra.yaml, MIT)`
   * と出していた（2026-09-23 実測）。自前の入力の内部ファイル名を画面に出すうえ、
   * 上流の配布物と並ぶ欄で、自分の入力にも「MIT」と付いて見えた（配布物のライセンス表記に見える）。
   * 名前はリンクでもなく、出典を確かめられなかった。 */
  const app = siteRuntime();
  const script = [
    "(async () => {",
    'const safeExternalUrl = (u) => (typeof u === "string" && u.startsWith("https://") ? u : null);',
    `const SRC_SRC = ${JSON.stringify(jsFunction(app, "dataSourceLabels"))};`,
    'const dataSourceLabels = new Function("safeExternalUrl", "return (" + SRC_SRC + ")")(safeExternalUrl);',
    "const got = dataSourceLabels([",
    "  { name: 'ccfddl', repo: 'ccfddl/ccf-deadlines', license: 'MIT', url: 'https://github.com/ccfddl/ccf-deadlines' },",
    "  { name: 'local', repo: 'data/extra.yaml', license: 'MIT', url: 'https://github.com/ten82e/kamiyobi' },",
    "  { name: 'unknown', url: 'javascript:alert(1)' },",
    " ]);",
    "console.log(JSON.stringify(got));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout.trim().split("\n").pop() || "[]");
  // 上流はそのまま（誰の配布物か、何のライセンスかが分かる）。
  expect(got[0].label).toBe("ccfddl（ccfddl/ccf-deadlines、MIT）");
  expect(got[0].url).toBe("https://github.com/ccfddl/ccf-deadlines");
  // 自分の入力は、内部ファイル名とライセンスを出さない。
  expect(got[1].label, "内部ファイル名を画面に出している").not.toContain("data/extra.yaml");
  expect(got[1].label, "自前の入力にライセンスを付けている").not.toContain("MIT");
  expect(got[1].label).toBe("このサイトで収録した分（上流に無いもの）");
  // https 以外はリンクにしない（`safeExternalUrl` の結果だけを渡す）。
  expect(got[2].url).toBeNull();
  // てびきに画面の語そのままの説明がある（26 項目あっても「データ源」だけ無かった）。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const help = template.slice(template.indexOf('id="helpPanel"'));
  const guide = help.slice(0, help.indexOf("</dl>"));
  expect(guide).toContain("<dt>データ源</dt>");
  expect(guide).toContain("このサイトで収録した分（上流に無いもの）");
  expect(guide).toContain("一次資料");
});

it("一致評価の行内展開は、開閉状態を支援技術に伝える（SPEC §7）", () => {
  /* `aria-expanded` がビルド成果物に 1 箇所も無かった（2026-09-23 実測）。
   * トリガが `<span>` + `onclick` のときはキーボードで開けず、支援技術には
   * 「押せる物」「今開いている物」として伝わらなかった。ボタン化に合わせて、
   * 開いたとき true / 閉じたとき false をトリガに載せる。 */
  const app = siteRuntime();
  const script = [
    "(async () => {",
    "const mkRow = () => {",
    "  const trigger = {",
    "    tagName: 'BUTTON', attrs: { 'aria-expanded': 'false' },",
    "    setAttribute(k, v) { this.attrs[k] = v; },",
    "  };",
    "  const parentNode = { inserted: [], insertBefore(node, ref) { this.inserted.push([node, ref]); } };",
    "  return {",
    "    tagName: 'TR', parentNode, nextSibling: null, attrs: trigger.attrs,",
    "    nextElementSibling: null, // 最初は次の行が無い（= 閉じている）",
    "    querySelector: () => trigger,",
    "    remove() {},",
    "  };",
    "};",
    `const TOGGLE_SRC = ${JSON.stringify(jsFunction(app, "toggleDetail"))};`,
    "const detailRows = [];",
    "const makeDetailRow = () => {",
    "  const row = { className: 'detail-row', removed: false, nextElementSibling: null,",
    "    classList: { contains: (c) => c === 'detail-row' },",
    "    remove() { this.removed = true; } };",
    "  detailRows.push(row);",
    "  return row;",
    "};",
    'const toggleDetail = new Function("makeDetailRow", "return (" + TOGGLE_SRC + ")")(makeDetailRow);',
    "const tr = mkRow();",
    "const state = () => tr.attrs['aria-expanded'];",
    "const before = state();",
    "toggleDetail({}, tr); // 開く",
    "const opened = state();",
    "const inserted = tr.parentNode.inserted.length;",
    "tr.nextElementSibling = detailRows[0]; // 挿直後の並び（次の行が行内展開）",
    "toggleDetail({}, tr); // 閉じる",
    "const closed = state();",
    "const removed = detailRows[0].removed;",
    "console.log(JSON.stringify({ before, opened, closed, inserted, removed }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout.trim().split("\n").pop() || "{}");
  expect(got.before).toBe("false");
  expect(got.opened, "開いても aria-expanded が変わらない").toBe("true");
  expect(got.closed, "閉じても aria-expanded が変わらない").toBe("false");
  expect(got.inserted, "行内展開が挿さっていない（検査が空振り）").toBe(1);
  expect(got.removed, "2 回目の押しが閉じていない").toBe(true);
  // てびきの書き方が実装とズレていない（「Tab で Enter」を実際に効かせるのはボタンだから）。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  expect(template).toContain("Tab でチップに移動して Enter");
  // チップの見た目を崩さないためのリセットが入っていること。
  expect(template).toMatch(/button\.tag \{[\s\S]{0,160}appearance: none;/);
  // てびきの用語集が構造的に壊れていないこと。第 98 回で、ある項に `</dd>` が余分に
  // 含まれていて、追記した文章が最初の閉じタグの後ろにぶら下がっていた（実測 27 個に対し
  // 閉じタグ 28 個）。画面に出る説明文が化けないための最低限の点検。
  const help = template.slice(template.indexOf('id="helpPanel"'));
  const guide = help.slice(0, help.indexOf("</dl>"));
  const ddOpen = (guide.match(/<dd>/g) || []).length;
  const ddClose = (guide.match(/<\/dd>/g) || []).length;
  expect(ddOpen, "てびきの語が説明を持っていない").toBeGreaterThan(20);
  expect(ddClose, `てびきの </dd> が <dd> と揃わない（開き ${ddOpen} / 閉じ ${ddClose}）`).toBe(
    ddOpen,
  );
  const dtCount = (guide.match(/<dt[ >]/g) || []).length;
  expect(dtCount, "てびきの見出しが減っている").toBe(ddOpen - 1); // 1 項だけ dd を 2 つ持つ
});

it("閉じた行の詳細は、支援技術からもタブ順序からも消える（SPEC §7）", () => {
  /* 閉じたドロワーは `opacity: 0` と画面外スライド（`right: -480px`）だけで消していた
   * （2026-09-23 実測）。`pointer-events: none` はマウス専用で、Tab は素通りしない。
   * なので閉じている状態で「閉じる」ボタンがタブ順序に残り、見えない箇所にフォーカスが
   * 飛んでいた。さらに中身は `role="dialog" aria-modal="true"` なので、閉じたまま
   * ツリーに出ると「ページ全体が背景」として扱われる支援技術がある。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const strip = (block: string) => block.replace(/\/\*[\s\S]*?\*\//g, "");

  const closedStart = template.indexOf(".drawer-backdrop {");
  expect(closedStart).toBeGreaterThan(0);
  const closed = strip(template.slice(closedStart, template.indexOf("}", closedStart)));
  expect(closed, "閉じたドロワーが支援技術から消えない").toContain("visibility: hidden");
  // フェードアウトを潰さない遅延（閉じる側だけ遅らせる）。
  expect(closed, "visibility を即時に切り替えて遷移を潰している").toMatch(
    /visibility 0s linear 0\.[1-9]/,
  );

  const activeStart = template.indexOf(".drawer-backdrop.active");
  expect(activeStart).toBeGreaterThan(0);
  const active = strip(template.slice(activeStart, template.indexOf("}", activeStart)));
  expect(active, "開いたドロワーが見えない").toContain("visibility: visible");
  expect(active, "表示に遅れが出て開きが重い").toMatch(/visibility 0s(?![ .\d])/);

  // タブで届く物が全部ドロワーの内側に有ること（＝この CSS でタブ順序も塞がる）。
  // ドロワーは本文の後ろ（`</footer>` の後）に有るので、そこから後ろを洗う。
  const drawerStart = template.indexOf('<div class="drawer-backdrop"');
  expect(drawerStart).toBeGreaterThan(0);
  const tail = template.slice(drawerStart);
  const drawerBlock = tail.slice(
    0,
    tail.indexOf("<script") > 0 ? tail.indexOf("<script") : tail.length,
  );
  expect(
    drawerBlock.match(/<button/g) || [],
    "ドロワーに閉じる手段が無い（検査が空振り）",
  ).toHaveLength(1);
  const rest = tail.slice(drawerBlock.length);
  expect(rest.match(/<button/g) || [], "ドロワーの後ろに閉じた状態で残る操作がある").toEqual([]);
  // ダイアログとしての行儀（閉じたときに消えることが前提の属性）。
  expect(template).toContain('role="dialog"');
  expect(template).toContain('aria-modal="true"');

  // 実装は `.active` を外すだけで閉じる（CSS の可視性が効く形）。
  const app = siteRuntime();
  const script = [
    "(async () => {",
    "const touched = [];",
    "const el = (id) => ({ id, classList: { remove: (c) => touched.push([id, 'remove', c]),",
    "  add: (c) => touched.push([id, 'add', c]) } });",
    `const CLOSE_SRC = ${JSON.stringify(jsFunction(app, "closeDrawer"))};`,
    'const closeDrawer = new Function("$", "window", "writeUrl", "return (" + CLOSE_SRC + ")")(el, {}, () => {});',
    "closeDrawer();",
    "console.log(JSON.stringify(touched));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const touched = JSON.parse(proc.stdout.trim().split("\n").pop() || "[]");
  expect(touched).toContainEqual(["drawerBackdrop", "remove", "active"]);
});

it("てびきのキーボード表記が、実装が扱うキーと欠けずに合う（SPEC §7）", () => {
  /* 自分が案内文に「j/k + Enter でドロワーが開く」と誤記した（2026-09-23。実際は `Enter` は
   * 公式ページ、`d` が行の詳細）。キーの操作説明は、一度ズレると画面の挙動と案内が別物を
   * 指したまま永aku。ビルド成果物から実際に扱うキーを洗って、てびきが全て挙げているかを見る。
   * キーの名前はテスト側に書き写さず、実装側から作る（語を二重化しない）。 */
  const app = siteRuntime();
  const keys = Array.from(
    new Set(
      Array.from(jsFunction(app, "onKeydown").matchAll(/\be\.key === "([^"]+)"/g), (m) => m[1]),
    ),
  );
  expect(keys.length, "キー処理が見当たらない（検査が空振り）").toBeGreaterThan(5);
  const NAMED: Record<string, string> = { ArrowDown: "↓", ArrowUp: "↑", Escape: "Esc" };
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  // 見出しには `class="only-keyboard"` が付く（狭い画面ではショートカットを使えないため）。
  const dtAt = template.indexOf("キーボードで一覧を動かす</dt>");
  expect(dtAt).toBeGreaterThan(0);
  const keyGuide = template.slice(dtAt, template.indexOf("</dd>", dtAt));
  for (const key of keys) {
    const shown = NAMED[key] || key;
    expect(keyGuide, `てびきがキー「${key}」（画面では ${shown}）を挙げていない`).toContain(shown);
  }
  // キーの名前が揃っても、**何をするキーか**がズレると案内が噓をつく（自分の誤記はこれ）。
  // 実装側: `d` は行の詳細を開き、`Enter` は公式ページを開く（行の詳細は開かない）。
  const script = [
    "(async () => {",
    "const calls = { openUrl: 0, drawer: 0 };",
    "const row = { conf: { link: 'https://example.org' }, ed: { link: 'https://example.org/e' } };",
    "const rowEl = { classList: { contains: () => false }, focus() {} };",
    `const KEY = ${JSON.stringify(jsFunction(app, "onKeydown"))};`,
    // onKeydown はキーの振り分け関数を呼ぶので、抜き出した 2 つを一緒に作る。
    `const KEYBLOCK = ${JSON.stringify(jsFunction(app, "keyBlockedByTarget"))};`,
    'const onKeydown = new Function("state", "window", "document", "$", "selectedIndex", "shown",',
    '  "openDrawer", "closeDrawer", "ensureRowsDrawn", "safeExternalUrl", KEYBLOCK + ";" + KEY + ";return onKeydown;")(',
    "  { mode: 'deadlines' },",
    "  { open: () => { calls.openUrl++; } },",
    "  { activeElement: null },",
    "  () => ({ querySelectorAll: () => [rowEl, rowEl] }), 1, [row, row],",
    "  () => { calls.drawer++; }, () => {}, () => {},",
    "  (u) => (typeof u === 'string' && u.startsWith('https://') ? u : null),",
    ");",
    "const fire = (key) => onKeydown({ key, target: { tagName: 'BODY', isContentEditable: false }, preventDefault() {} });",
    "fire('d');",
    "const afterD = { drawer: calls.drawer, openUrl: calls.openUrl };",
    "fire('Enter');",
    "const afterEnter = { drawer: calls.drawer, openUrl: calls.openUrl };",
    "console.log(JSON.stringify({ afterD, afterEnter }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout.trim().split("\n").pop() || "{}");
  expect(got.afterD.drawer, "d が行の詳細を開いていない").toBe(1);
  expect(got.afterD.openUrl, "d が公式ページも開いている").toBe(0);
  // `window.open` は Enter のぶんだけ（d では開かないので計 1 回）。
  expect(got.afterEnter.openUrl, "Enter が公式ページを開いていない").toBe(1);
  expect(got.afterEnter.drawer, "Enter が行の詳細も開いている（案内と違う動き）").toBe(1);
  // 案内側: 同じ対応で書けていること。
  expect(keyGuide).toMatch(/<code>Enter<\/code>[^。]*公式ページ/);
  expect(keyGuide).toMatch(/<code>d<\/code>[^。]*行の詳細/);
  // 「行の詳細」の項（今回追加）: 開き方（押す / `d`）と閉じ方（`Esc`）を書く。
  const detailAt = template.indexOf("<dt>行の詳細</dt>");
  expect(detailAt).toBeGreaterThan(0);
  const detailGuide = template.slice(detailAt, template.indexOf("</dd>", detailAt));
  for (const word of ["行を押す", "<code>d</code>", "<code>Esc</code>", "公式サイト", "✕"]) {
    expect(detailGuide, `行の詳細の説明に ${word} が無い`).toContain(word);
  }
  // 狭い画面ではキーの案内が出せない（押す/✕ の話だけが残る）。
  const keyboardSpan = /<span class="only-keyboard">([\s\S]*?)<\/span>/.exec(detailGuide);
  expect(keyboardSpan, "行の詳細の説明でキー操作を狭い画面向けに括っていない").not.toBeNull();
  expect(keyboardSpan![1]).toContain("<code>d</code>");
  expect(keyboardSpan![1], "押さなくて良い操作が混ざっている").not.toContain("行を押す");
  expect(detailGuide.slice(0, detailGuide.indexOf('<span class="only-keyboard">'))).toContain("✕");
});

it("狭い画面ではキー操作の案内は見出しも説明も閉じる（SPEC §7）", () => {
  /* 狭い画面（ほぼスマホ）ではショートカットが使えないので案内も消す方針で、第 85 回に
   * 一度「閉じ忘れ」を直している。しかし閉じていたのは `.only-keyboard` を付けた **見出しだけ**
   * で、直後の `<dd>`（`j`/`k`/`d`/`Esc` の書き方そのもの）はそのまま出ていた（2026-09-23 実測）。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const at = template.indexOf("@media (max-width: 640px)");
  expect(at).toBeGreaterThan(0);
  const mediaBlocks = template.slice(at);
  expect(mediaBlocks).toMatch(/\.only-keyboard,\s*\.only-keyboard \+ dd \{[^}]*display: none/);
  // キーの項は、見出しを失っても説明が独り歩きしていないこと。
  const dtAt = template.indexOf('<dt class="only-keyboard">');
  expect(dtAt).toBeGreaterThan(0);
  const afterDd = template.slice(template.indexOf("</dt>", dtAt) + 5);
  expect(afterDd.trimStart().startsWith("<dd>"), "キーの項の説明が直後に無い").toBe(true);
});

it("二つの画面の呼び方が、切り替えボタンの語と揃っている（SPEC §7）", () => {
  /* 切り替えボタンは「投稿先を探す」／「締切を検索」なのに、てびきだけ別の呼び方
   * （「論文から探す」）で 3 か所書いていた（2026-09-23 実測）。案内を読んだ人が
   * どのボタンか特定できない。第 94 回の収録状況、第 95 回の早め絞り込みと同じ型なので、
   * ボタンの語を正本にして検査に入れる（テスト側に語を書き写さない）。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const label = (id: string) => {
    const at = template.indexOf(`id="${id}"`);
    expect(at, `切り替えボタンが見つからない: ${id}`).toBeGreaterThan(0);
    const open = template.indexOf(">", at);
    const m = />([^<]+)<\/button>/.exec(template.slice(open, open + 200));
    expect(m, `ボタンの語が取れない: ${id}`).not.toBeNull();
    return (m as RegExpExecArray)[1];
  };
  const recommend = label("modeRecommend");
  const deadlines = label("modeDeadlines");
  expect(recommend.length).toBeGreaterThan(0);
  // 見出し・案内はボタンと同じ語を使う。
  const guide = template.slice(template.indexOf('id="helpPanel"'));
  expect(guide).toContain(recommend);
  // 「締切を検索」側は既定の画面で、案内は表その物の語（「一覧」）で書いているので
  // 画面名の一致は要求しない（締切一覧＝表の意味で使っていて、誤りではない）。
  expect(deadlines.length).toBeGreaterThan(0);
  // 別の呼び方に寄せる書き方を戻さない（第 95 回の検査と同じ趣旨）。
  expect(guide, "ボタンに無い画面名を案内に書かない").not.toContain("論文から探す");
  // 画面の下（CSV の説明など）も同じ。
  const csvDd = template.slice(template.indexOf("<dt>CSV</dt>"));
  expect(csvDd.slice(0, csvDd.indexOf("</dd>"))).toContain(recommend);
});

it("PDF 読み込みの失敗は日本語と打ち手で出る（SPEC §7）", () => {
  /* 失敗時に内部の英語文字列をそのまま画面へ出していた（2026-09-23 実測）。
   * 「PDF 読込に失敗しました: pdfjs unavailable」「: file is too large」
   * 「: PDF has too many pages」「: PDF extraction timed out」など。
   * 日本語の利用者には何が起きたか直せない。特に `pdfjs unavailable` は、
   * 学内のプロキシで CDN が塞がれると起きる一番よくある失敗だった。 */
  const app = siteRuntime();
  const maxBytes = 20 * 1024 * 1024;
  const script = [
    "(async () => {",
    `const FAIL_SRC = ${JSON.stringify(jsFunction(app, "pdfFailureMessageJa"))};`,
    `const MAX_BYTES = ${maxBytes};`,
    'const f = new Function("PDF_MAX_BYTES", "PDF_MAX_PAGES", "return (" + FAIL_SRC + ")")(MAX_BYTES, 100);',

    "const cases = {",
    "  cdn: new Error('pdfjs unavailable'),",
    "  large: new Error('file is too large'),",
    "  pages: new Error('PDF has too many pages'),",
    "  slow: new Error('PDF extraction timed out'),",
    "  broken: new Error('Invalid PDF structure.'),",
    "  unknown: new Error('boom'),",
    " };",
    "const out = {};",
    "for (const k of Object.keys(cases)) out[k] = f(cases[k]);",
    "const aborted = new Error(' aborted');",
    "aborted.name = 'AbortError';",
    "out.aborted = f(aborted);",
    "console.log(JSON.stringify(out));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout.trim().split("\n").pop() || "{}");
  // 内部の英語をそのまま出さない。
  for (const key of Object.keys(got)) {
    const text = got[key];
    expect(text, `${key} が日本語になっていない`).toMatch(/[ぁ-んァ-ン一-龯]/);
    expect(text, `${key} が内部の英語文字列を写している`).not.toMatch(
      /pdfjs unavailable|file is too large|too many pages|timed out|Invalid PDF/i,
    );
    expect(text, `${key} に打ち手が無い（何が起きたかだけで終わる）`).toMatch(
      /貼|キャンセル|確かめる|指定して/,
    );
  }
  // 上限値は実装の定数から出る（テスト側に数字を書き写していない証明）。
  expect(got.large).toContain("20 MB");
  expect(got.pages).toContain("100 ページ");
  expect(got.aborted).toBe("PDF 読込をキャンセルしました");
  // 未発表の論文を預ける操作なので、送信しないことを画面に書く。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  expect(template).toContain("選んだファイルは送信しません");
});

it("推薦のカードの行が、てびきの数と名前と合う（SPEC §7）", () => {
  /* 推薦のカードは、同じ値に二つの名前を付けていた（頭のチップは「一致評価」、その下の
   * 行は「研究適合度」で、どちらも `r._fitLabel`・2026-09-23 実測）。てびきは
   * 「4行並べます」と書きながら、実際は 5 行で、しかも載っていない行が1つ有った
   * （「締切と種別」）。第 100 回のキー操作と同じ型なので、**行のラベルをビルド成果物から
   * 洗って**てびきと突き合わせる（語も件数もテスト側に書き写さない）。 */
  const app = siteRuntime();
  const card = jsFunction(app, "makeRecommendationCard");
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const labels = Array.from(
    new Set(
      Array.from(
        card.matchAll(/`([^`\n$]{2,20})[^`]*`,\s*\n?\s*"card-section recommendation-axes"/g),
        // ラベルは最初の読点・コロンまで（「締切の確認状況: 日付 …」の行がある）。
        (m) => m[1].split(/[:：]/)[0].trim(),
      ),
    ),
  );
  expect(labels.length, "カードの行が見当たらない（検査が空振り）").toBeGreaterThan(2);
  // 同じ値の言い替えを戻さない。画面に出る語はテンプレートとランタイムの文字列から出る
  // （`public/` は CI ではテスト後にビルドするので、ビルド成果物を読まない）。
  expect(card, "同じ評価に二つ目の名前を付けた").not.toContain("研究適合度");
  expect(template, "画面に二つ目の名前が残っている").not.toContain("研究適合度");
  const at = template.indexOf("カードの頭にある<strong>一致評価</strong>");
  expect(at).toBeGreaterThan(0);
  const guide = template.slice(template.lastIndexOf("<dd>", at), template.indexOf("</dd>", at));
  // てびきが数える行数と、実装の行数が合うこと。
  const counted = /判断材料を(\d+)行/.exec(guide);
  expect(counted, "てびきがカードの行数を数えていない").not.toBeNull();
  expect(Number(counted![1]), "てびきの行数と実装の行数が割れている").toBe(labels.length);
  for (const label of labels) {
    expect(guide, `てびきがカードの行「${label}」を挙げていない`).toContain(label);
  }
  // 一致評価はカードの頭に出る語として説明する（行として数えない）。
  expect(guide).toContain("一致評価");
});

it("推薦のカードの締切は表と同じ向き（JST と曜日）で出る（SPEC §7）", () => {
  /* 表は JST を主表記にしている（AoE 23:59 締切は JST では翌日の夜になるため、UTC 優先だと
   * 日本で何時までに出せばよいか分からない – `makeRow` のコメント）。ところが推薦のカードの
   * 受付状況は `fmtDate(ts) + " UTC / " + fmtAoE(ts)` で、UTC 主表記だった（2026-09-23 実測:
   * 「次回締切: 2026-10-05 23:59 UTC / 2026-10-05 15:59 AoE」）。同じ画面の表では
   * 「2026-10-06(火) 08:59 JST」が出るので、同じ締切に二つの時刻が並んでいた。
   * 加えて同じ値を「締切:」でもう一行出していて、「締切: 次回締切: …」の二重ラベルだった。 */
  const app = siteRuntime();
  const script = [
    "(async () => {",
    `const AVAIL_SRC = ${JSON.stringify(jsFunction(app, "recommendationAvailability"))};`,
    `const FMTJST_SRC = ${JSON.stringify(jsFunction(app, "fmtJst"))};`,
    `const FMTDATE_SRC = ${JSON.stringify(jsFunction(app, "fmtDate"))};`,
    `const FMTAOE_SRC = ${JSON.stringify(jsFunction(app, "fmtAoE"))};`,
    // 抽出関数の自由変数は正本から揃える（`pad` を自作すると書式がズレる）。
    `const PAD_SRC = ${JSON.stringify(jsFunction(app, "pad"))};`,
    "const pad = new Function('return (' + PAD_SRC + ')')();",
    // `fmtJst` の自由変数（曜日の配列）も正本の宣言から作る。
    `const WEEKDAY_DECL = ${JSON.stringify((app.match(/const WEEKDAY_JA = \[[^\]]*\];/) || [""])[0])};`,
    "const WEEKDAY_JA = new Function('return ' + WEEKDAY_DECL.replace(/^const WEEKDAY_JA = /, '').replace(/;$/, ''))();",
    "if (!Array.isArray(WEEKDAY_JA) || WEEKDAY_JA.length !== 7) throw new Error('曜日の配列が取れていない');",
    "const fmtJst = new Function('WEEKDAY_JA', 'pad', 'return (' + FMTJST_SRC + ')')(WEEKDAY_JA, pad);",
    "const fmtDate = new Function('pad', 'return (' + FMTDATE_SRC + ')')(pad);",
    "const fmtAoE = new Function('pad', 'return (' + FMTAOE_SRC + ')')(pad);",
    // 表で使う曜日の語はビルド成果物から取る（テスト側に書き写さない）。
    `const WEEKDAY_SRC = ${JSON.stringify(jsFunction(siteRuntime("recommender.js"), "weekdayJaFromDate"))};`,
    // helper の自由変数（暦日の曜日の配列）も正本から揃える。
    `const CAL_DECL = ${JSON.stringify((siteRuntime("recommender.js").match(/const CALENDAR_DATE_JA = \[[^\]]*\];/) || [""])[0])};`,
    "const CALENDAR_DATE_JA = new Function('return ' + CAL_DECL.replace(/^const CALENDAR_DATE_JA = /, '').replace(/;$/, ''))();",
    "if (!Array.isArray(CALENDAR_DATE_JA) || CALENDAR_DATE_JA.length !== 7) throw new Error('暦日の曜日の配列が取れていない');",
    "const weekdayJaFromDate = new Function('CALENDAR_DATE_JA', 'return (' + WEEKDAY_SRC + ')')(CALENDAR_DATE_JA);",
    // 「分からない」の語（未確認）も正本から取る（テスト側に書き写さない）。
    // 関数は宣言済みの語を返すだけなので、語の宣言そのものを取りに出す。
    `const UNCONFIRMED_DECL = ${JSON.stringify(
      (siteRuntime("recommender.js").match(/const UNCONFIRMED_LABEL_JA = [^;]*;/) || [""])[0],
    )};`,
    "const UNCONFIRMED_JA = new Function('return ' + UNCONFIRMED_DECL.replace(/^const UNCONFIRMED_LABEL_JA = /, '').replace(/;$/, ''))();",
    "if (typeof UNCONFIRMED_JA !== 'string' || !UNCONFIRMED_JA.length) throw new Error('未確認の語が取れない（検査が空振り）');",
    "const Recommender = {",
    "  officialZone: (dl) => Recommender.zone,",
    "  weekdayJaFromDate,",
    "  zone: 'AoE',",
    "};",
    "const avail = new Function('fmtJst', 'fmtDate', 'fmtAoE', 'Recommender', 'UNCONFIRMED_JA',",
    "  'return (' + AVAIL_SRC + ')')(fmtJst, fmtDate, fmtAoE, Recommender, UNCONFIRMED_JA);",
    // UTC では 10/5、JST では 10/6 になる締切（AoE 23:59 型の例）。
    "const ts = Date.UTC(2026, 9, 5, 15, 59);",
    "const jstShown = fmtJst(new Date(ts));",
    "const aoe = avail({ _availability: { status: 'open', timestamp: ts }, dl: {} });",
    "Recommender.zone = 'JST';",
    "const jst = avail({ _availability: { status: 'open', timestamp: ts }, dl: {} });",
    "Recommender.zone = 'UTC';",
    "const utc = avail({ _availability: { status: 'open', timestamp: ts }, dl: {} });",
    "const dateOnly = avail({ _availability: { status: 'open', local_date: '2026-10-06' }, dl: {} });",
    // 受付状況が確認できない行の語（第 142 回）。画面 other 箇所と同じ語に揃える。
    "const noAvail = avail({});",
    "const ongoing = avail({ _availability: { status: 'ongoing' }, dl: {} });",
    "const openNoDate = avail({ _availability: { status: 'open' }, dl: {} });",
    "const uncertainNoDate = avail({ _availability: { status: 'uncertain' }, dl: {} });",
    "const weirdStatus = avail({ _availability: { status: 'someday' }, dl: {} });",
    "console.log(JSON.stringify({",
    "  jstShown,",
    "  aoe,",
    "  jst,",
    "  utc,",
    "  dateOnly,",
    "  noAvail,",
    "  ongoing,",
    "  openNoDate,",
    "  uncertainNoDate,",
    "  weirdStatus,",
    "  unconfirmed: UNCONFIRMED_JA,",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout.trim().split("\n").pop() || "{}");
  // JST（曜日付き）が主表記で、表と同じ文字列になる。
  expect(got.aoe, "JST の主表記が出ていない").toContain(got.jstShown);
  expect(got.aoe.startsWith("次回締切: " + got.jstShown), "JST が先頭ではない").toBe(true);
  // AoE 併記は AoE 宣言の会議だけ。
  expect(got.aoe).toContain("公式 AoE");
  expect(got.jst, "JST 宣言の締切に AoE を併記している").not.toContain("AoE");
  expect(got.jst).toContain("公式 JST 締切");
  expect(got.utc).toContain("UTC");
  // 暦日だけの締切も曜日を添える（表と同じ）。
  expect(got.dateOnly, "暦日だけの締切に曜日が無い").toMatch(
    /^次回締切: 2026-10-06\(.+\)（時刻未確認）$/,
  );
  // 同じ値をカード内で二回出さない（「締切: 次回締切: …」の二重ラベルを戻さない）。
  const card = jsFunction(app, "makeRecommendationCard");
  expect(
    card.match(/recommendationAvailability\(r\)/g) || [],
    "同じ値を二行に出している",
  ).toHaveLength(1);
  expect(card).not.toMatch(/締切: \$\{recommendationAvailability/);
  /* 受付状況が確認できない行の語。画面の「分からない」は 未確認 / 該当なし / 評価なし の
   * 3 つに揃えてあって、てびきの「空欄の出し方」に同じ約束を書いている。カードだけが
   * 「受付状況不明」を出していた（2026-09-23 実測）。てびきにも無い語だったので、
   * 画面で見た人が意味を引けない語だった。 */
  expect(got.noAvail).toBe("受付状況" + got.unconfirmed);
  expect(got.noAvail).not.toContain("不明");
  expect(got.weirdStatus).toBe("受付状況" + got.unconfirmed);
  expect(got.uncertainNoDate).toBe("受付状況" + got.unconfirmed);
  // 受け付け中なのに日付が出ていない行は、分からない部分だけを書く。
  expect(got.openNoDate).toBe("次回締切の日付が" + got.unconfirmed);
  // 「常時受付」は実在する状態（2026-09-23 実測: プール 3,257 行で 4 件）で、てびきが書く語。
  expect(got.ongoing).toBe("常時受付");
  const guide = readFileSync(join(site, "index.html"), "utf8");
  for (const word of [
    "受付状況" + got.unconfirmed,
    "次回締切の日付が" + got.unconfirmed,
    "常時受付",
  ]) {
    expect(guide, `カードに出す「${word}」がてびきから引けない`).toContain(word);
  }
  // 表示文に「不明」を戻さない（コメントには出てよいので、文字列リテラルだけ見る）。
  expect(got.aoe + got.jst + got.utc + got.dateOnly + got.noAvail + got.openNoDate).not.toContain(
    "不明",
  );
  expect(jsFunction(app, "recommendationAvailability")).not.toMatch(/"[^"]*不明[^"]*"/);
});

it("支援技術に本文の位置と表の名前を伝え、跳ぶ導線を置く（SPEC §7）", () => {
  /* 検索欄・プリセット・分野チップを全部 Tab で辿らないと表に届かず、本文へ飛ぶ導線が
   * 無かった。`<table>` にも名前が無く（`<caption>` も `aria-label` も無し）、支援技術には
   * 「表」だとだけ伝わっていた（2026-09-23 実測）。結果のまとまりを示すランドマークも無い。 */
  const html = siteHtmlRuntime();
  const body = html.slice(html.indexOf("<body>"));
  // 跳ぶ導線が最初の操作可能な要素であること（後から足すと意味が無い）。
  const focusables = Array.from(body.matchAll(/<(a|button|input|select)\b/g));
  expect(focusables.length).toBeGreaterThan(5);
  expect(focusables[0][1], "最初の操作可能要素が跳ぶ導線ではない").toBe("a");
  const skip = /<a class="skip-link" href="#([^"]+)">([^<]*)<\/a>/.exec(body);
  expect(skip, "本文へ跳ぶ導線が有らない").not.toBeNull();
  expect(skip![2]).toContain("締切の一覧");
  // 飛び先が実在し、フォーカスを当てられること（`tabindex="-1"` が無いと飛んでも読まない）。
  const target = new RegExp(`<(main|div|section)[^>]*id="${skip![1]}"[^>]*>`).exec(body);
  expect(target, `跳ぶ導線の飛び先 ${skip![1]} が無い`).not.toBeNull();
  expect(target![0], "飛び先にフォーカスを当てられない").toContain('tabindex="-1"');
  // 結果のまとまりのランドマークは一つだけ。
  expect((body.match(/<main\b/g) || []).length, "main が重複している").toBe(1);
  // 画面に描画しない支援技術向けの語を、`display: none` で消していないこと。
  const caption = /<caption class="only-sr">([^<]*)<\/caption>/.exec(body);
  expect(caption, "表に名前が無い").not.toBeNull();
  expect(caption![1]).toContain("締切");
  const onlySr = /\.only-sr \{([^}]*)\}/.exec(html);
  expect(onlySr, "支援技術向けの語の隠し方が無いか、壊れている").not.toBeNull();
  expect(onlySr![1], "display: none にすると読み上げ自体が消える").not.toContain("display: none");
  const skipRule = /\.skip-link \{([^}]*)\}/.exec(html.slice(html.indexOf(".skip-link {")));
  expect(skipRule, "跳ぶ導線の基準の style が無いか、壊れている").not.toBeNull();
  expect(skipRule![1], "跳ぶ導線を display: none で消している").not.toContain("display: none");
  // フォーカスしたら画面に出てくること（見えない導線はキーボードでは使えない）。
  expect(html).toMatch(/\.skip-link:focus \{[^}]*left: ?(?!-9999)/);
});

it("見出しの並び替えは Enter・Space で効き、行用の Enter と衝突しない（SPEC §7）", () => {
  /* 「sortable headers are keyboard-operable」という検査が有ったが、実際にキーを押す所を
   * 一度も見ておらず、`tabindex` と `aria-sort` の有無だけを見ていた（2026-09-23 確認）。
   * 実装は `th` に keydown を張る形なので、その張られた handler をビルド成果物から
   * 抜き出して本当に押す（検査が画面の挙動を語っている形に戻す）。 */
  const app = siteRuntime();
  const at = app.indexOf('th.addEventListener("keydown"');
  expect(at, "見出しのキーボード処理が見当たらない").toBeGreaterThan(0);
  const head = 'th.addEventListener("keydown", ';
  const start = at + head.length;
  let depth = 0;
  let end = start;
  for (let i = start; i < app.length; i++) {
    const ch = app[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (!depth) {
        end = i + 1;
        break;
      }
    }
  }
  const handler = app.slice(start, end);
  const script = [
    "(async () => {",
    `const HANDLER = ${JSON.stringify(handler)};`,
    "const out = [];",
    "const window = { toggleSort: (k) => out.push(['toggle', k]) };",
    "const th = { getAttribute: (a) => (a === 'data-sort' ? 'date' : null) };",
    "const onKey = new Function('th', 'window', 'return (' + HANDLER + ')')(th, window);",
    "const fire = (key) => {",
    "  let prevented = false, stopped = false;",
    "  onKey({ key, preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });",
    "  out.push([key, prevented, stopped]);",
    "};",
    "fire('Enter');",
    "fire(' ');",
    "fire('j');",
    "console.log(JSON.stringify(out));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  // 混ざった組（['toggle', 列] と ['Enter', 停止, 伝搬]）なので型を寄せておく。
  const out = JSON.parse(proc.stdout.trim().split("\n").pop() || "[]") as Array<
    [string, unknown, unknown?]
  >;
  const toggled = out.filter((x) => x[0] === "toggle").map((x) => x[1]);
  // Enter と Space の両方が、押した列の並び替えを呼ぶ（Space が抜けている実装はよくある）。
  expect(toggled, "Enter・Space で並び替えが起きていない").toEqual(["date", "date"]);
  // `j` は選択行を動かすキーなので、見出しが食ってはいけない。
  expect(
    out.some((x) => x[0] === "j" && x[1] === false),
    "j キーを止めている",
  ).toBe(true);
  // グローバルの「Enter = 選択行の公式ページを開く」に奪われないよう、止めてから渡す。
  const enter = out.find((x) => x[0] === "Enter");
  expect(enter, "Enter を押した記録が無い（検査が空振り）").toBeDefined();
  expect(enter![1], "Enter で既定動作を止めていない").toBe(true);
  expect(enter![2], "Enter がグローバル側に伝わる（公式ページが開いてしまう）").toBe(true);
});

it("並び替えの状態は読み上げに伝わる（見出しの矢印だけだった・SPEC §7）", () => {
  /* 並び順は見出しの語尾の矢印（↑/↓/↕）にしか出ていなかった（2026-09-23 実測）。
   * キーボードでヘッダーを押して並びが変わっても読み上げは何も言わない。過ぎた締切を
   * 下にまとめたときは件数欄に書く（黙って並びを変えない）ので、その方針と同じにする。
   * 画面は混むので読み上げ専用の短い欄にだけ足す（第 89 回で分けた仕組み）。 */
  const app = siteRuntime();
  const script = [
    "(async () => {",
    `const LABEL_SRC = ${JSON.stringify(jsFunction(app, "sortColumnLabel"))};`,
    `const NOTE_SRC = ${JSON.stringify(jsFunction(app, "sortNoteJa"))};`,
    'const LABELS = { rem: "残り ↕", date: "日時（JST） ↓", conf: "会議 ↕", rank: "ランク ↑" };',
    "const document = {",
    "  querySelector: (sel) => {",
    `    const k = /data-sort="([^"]+)"/.exec(sel);`,
    "    if (!k || !(k[1] in LABELS)) return null;",
    "    return { textContent: LABELS[k[1]] };",
    "  },",
    "};",
    "const sortColumnLabel = new Function('document', 'return (' + LABEL_SRC + ')')(document);",
    "const note = new Function(",
    "  'document',",
    "  'sortColumnLabel',",
    "  'return (' + NOTE_SRC + ')'",
    ")(document, sortColumnLabel);",
    "console.log(JSON.stringify({",
    "  rem: note('rem', true),",
    "  dateDesc: note('date', false),",
    "  rank: note('rank', false),",
    "  none: note('', true),",
    "  unknown: note('other', true),",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout.trim().split("\n").pop() || "{}");
  // 語尾の矢印を落とした見出しの語を使い、向きを日本語で書く。
  expect(got.rem).toBe(" ｜ 並び順: 残り 昇順");
  expect(got.dateDesc).toBe(" ｜ 並び順: 日時（JST） 降順");
  expect(got.rank).toBe(" ｜ 並び順: ランク 降順");
  expect(got.none, "並び順が無いのに文を出す").toBe("");
  expect(got.unknown, "見出しの無い列の語をこしらえている").toBe("");
  // 画面に出す文には足さない（読み上げ専用の欄にだけ入れる）。読み上げ欄の語を
  // てびきにも書いておくので、三者がズレないようにする。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const at = template.indexOf("<dt>並び順</dt>");
  expect(at).toBeGreaterThan(0);
  const guide = template.slice(at, template.indexOf("</dd>", at));
  expect(guide, "てびきを読み上げの語と揃えないと、画面の説明が噓になる").toContain(
    "並び順: 残り 昇順",
  );
});

it("URL に書く条件は、URL から読みもする（共有画面で条件が消えない・SPEC §7）", () => {
  /* `writeUrl` は 12 種類の条件を書く。読み側 `readUrl` が 1 つでも忘れていると、
   * 共有した相手の画面でその条件だけ黙って外れる（画面には「絞り込み済み」らしく
   * 出てしまう）。両方の関数からキー名を洗って照合する（キーをテスト側に書き写さない）。 */
  const app = siteRuntime();
  const keys = (fn: string, re: RegExp) => {
    const body = jsFunction(app, fn);
    expect(body, `${fn} が見当たらない（検査が空振り）`).not.toBe("");
    return new Set(Array.from(body.matchAll(re), (m) => m[1]));
  };
  const written = keys("writeUrl", /\.set\("([a-z]+)"/g);
  const read = keys("readUrl", /\.get\("([a-z]+)"/g);
  expect(written.size, "URL に書く条件が見当たらない").toBeGreaterThan(6);
  for (const key of written) {
    expect(read, `URL には ${key} を書くのに読まない（共有先で条件が消える）`).toContain(key);
  }
  // 読むだけで書かないキーは許す（古い URL の受け皿など）が、空いていたら記録する。
  const onlyRead = Array.from(read).filter((k) => !written.has(k));
  expect(onlyRead, "読み-only のキーが増えたら意図を確認する").toEqual([]);
});

it("表の公式表記に出る語（時刻未確認・AoE・JST）はその語で引ける（SPEC §7）", () => {
  /* 一覧の 2 行目は公式ページの表記を出すが、その語が検索要素に入っていなかった
   * （2026-09-23 実測）。日付だけの行 188 件が「時刻未確認」の印を出すのにその語は
   * 0 件、AoE 宣言の行 1,908 件が「公式 AoE …」と出すのに「AoE」は 2 件だけ
   * （上流の締切名に偶々入っていた物で、AoE 締切自体は 1 件も出ていなかった）。
   * 「画面に出ている語で検索できる」状態を保つ（SPEC §2 の表示と検索の約束事）。 */
  const rows = Recommender.candidateRows(data);
  expect(rows.length).toBeGreaterThan(100);
  const dateOnly = rows.filter((r) => r.dateOnly === true);
  const aoe = rows.filter((r) => Recommender.officialZone(r.dl) === "AoE");
  const jst = rows.filter((r) => Recommender.officialZone(r.dl) === "JST");
  // 検査が空振りしないこと（収録が変わって 0 行になたら、この検査は何も言えなくなる）。
  expect(dateOnly.length, "日付だけの行が無い（検査が空振り）").toBeGreaterThan(0);
  expect(aoe.length, "AoE 宣言の行が無い（検査が空振り）").toBeGreaterThan(0);
  expect(jst.length, "JST 宣言の行が無い（検査が空振り）").toBeGreaterThan(0);
  /* 画面が出す語をビルド成果物から取る（表示の語をテスト側に書き写すと、表示だけが
   * 変わったときに検査が緑のまま残る）。`残り` 列の badge の語を見る。 */
  const app = siteRuntime();
  const badge = /text: "([^"]*未確認[^"]*)", cls: ""/.exec(app);
  expect(badge, "一覧の badge の語が見つからない").not.toBeNull();
  const badgeWord = String(badge![1]).replace(/[（）。]/g, "");
  expect(badgeWord).toContain("時刻未確認");
  // 日付だけの行は、画面と同じ語で全部引ける。
  for (const r of dateOnly) {
    expect(
      Recommender.hayMatches(r.hay, badgeWord),
      `${String(r.hay).slice(0, 24)} が「${badgeWord}」で引けない`,
    ).toBe(true);
  }
  // AoE 宣言の行は「AoE」で引ける。逆に JST 宣言の行が混ざると、実在しない AoE 締切を
  // 探したことになる（表示で AoE を出さない行と同じ向き）。
  for (const r of aoe) {
    expect(
      Recommender.hayMatches(r.hay, "AoE"),
      `${String(r.hay).slice(0, 24)} が「AoE」で引けない`,
    ).toBe(true);
  }
  for (const r of jst) {
    expect(
      Recommender.hayMatches(r.hay, "AoE"),
      `${String(r.hay).slice(0, 24)} は AoE 締切でない`,
    ).toBe(false);
    expect(
      Recommender.hayMatches(r.hay, "JST"),
      `${String(r.hay).slice(0, 24)} が「JST」で引けない`,
    ).toBe(true);
  }
  // 全行に出る「公式」の二字は検索語にしない（入れても絞れず、絞れたと誤信させる。
  // 「確認できたものだけ」はチェックボックスの側で絞る）。
  expect(rows.filter((r) => Recommender.hayMatches(r.hay, "公式")).length).toBe(0);
});

it("キーボードで選んだ行にフォーカスが動く（支援技術に読まれる・SPEC §7）", () => {
  /* `j` / `k` は行のクラス目印だけ変えてスクロールしていた（2026-09-23 実測）。
   * てびきは「キーボードで一覧を動かす」と案内しているので、支援技術を使う人にも
   * 選んだ行が読める形（フォーカスを移す）にする。なめらかスクロールは「動きを抑える」
   * 設定を見ないまま効いていたので、その向きも見る。 */
  const app = siteRuntime();
  const script = [
    "(async () => {",
    `const UPDATE = ${JSON.stringify(jsFunction(app, "updateRowSelection"))};`,
    // shown[] と 1:1 の行のほかに、展開行と月見出し行が混ざる（除外されないと行がズレる）。
    "const mk = (name, classes) => {",
    "  return {",
    "    name,",
    "    classList: { contains: (c) => classes.indexOf(c) >= 0, toggle: () => {} },",
    "    focused: 0,",
    "    focusArgs: null,",
    "    scrollArgs: null,",
    "    attrs: {},",
    "    focus(o) { this.focused++; this.focusArgs = o || null; },",
    "    scrollIntoView(o) { this.scrollArgs = o || null; },",
    "    setAttribute(k, v) { this.attrs[k] = v; },",
    "    removeAttribute(k) { delete this.attrs[k]; },",
    "  };",
    "};",
    'const rows = [mk("row0", ["row"]), mk("detail", ["detail-row"]), mk("row1", ["row"]), mk("row2", ["row"])];',
    "const mkWindow = (reduce) => ({",
    "  matchMedia: (q) => ({ matches: reduce && q.indexOf('prefers-reduced-motion') >= 0 }),",
    "});",
    // 実装の関数宣言を、自由変数（`$`・`window`・`selectedIndex`）を渡して呼ぶ。
    "const run = (index, reduce) => {",
    "  const window = mkWindow(reduce);",
    "  rows.forEach((r) => { r.focused = 0; r.focusArgs = null; r.scrollArgs = null; });",
    "  const fn = new Function('$', 'window', 'selectedIndex',",
    "    UPDATE + '; return updateRowSelection();');",
    "  fn(() => ({ querySelectorAll: () => rows }), window, index);",
    "};",
    // shown[] の 2 番目（実体 3 行目の row2 を index 2 で選ぶ。除外行を数えるとズレる）。
    "run(1, false);",
    "const a = rows.map((r) => [r.name, r.focused, JSON.stringify(r.focusArgs), JSON.stringify(r.scrollArgs)]);",
    "run(2, true);",
    "const b = rows.map((r) => [r.name, r.focused, JSON.stringify(r.scrollArgs)]);",
    "console.log(JSON.stringify({ a, b }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const { a, b } = JSON.parse(proc.stdout.trim().split("\n").pop() || "{}") as {
    a: unknown[][];
    b: unknown[][];
  };
  const focused = a.filter((x) => Number(x[1]) > 0).map((x) => String(x[0]));
  // 選んだ行だけフォーカスされる（除外行ではないこと – 除外が効くと 1 行ズレる）。
  expect(focused, "選んだ行にフォーカスが動いていない").toEqual(["row1"]);
  const row1 = a.find((x) => x[0] === "row1");
  expect(row1, "row1 の記録が無い（検査が空振り）").toBeDefined();
  // なめらかスクロールと二重にスクロールしないよう、フォーカスはスクロールを抑える。
  expect(String(row1![2]), "フォーカスが画面を動かして二重にスクロールする").toContain(
    "preventScroll",
  );
  // 「動きを抑える」設定が無ければなめらか、あれば瞬間移動。
  expect(String(row1![3])).toContain("smooth");
  const row2 = b.find((x) => x[0] === "row2");
  expect(row2, "row2 の記録が無い（検査が空振り）").toBeDefined();
  expect(String(row2![2]), "「動きを抑える」設定でもなめらかに動く").toContain("auto");
  // てびきにも、選んだ行が読まれることを書いておく（案内と実装のズレを防ぐ）。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const at = template.indexOf("<code>d</code> で行の詳細を出します。");
  expect(at).toBeGreaterThan(0);
  expect(template.slice(at, at + 260), "てびきに読み上げの説明が無い").toContain("支援技術");
});

it("締切が延びていた行は、一覧・CSV・検索で同じ語が揃う（SPEC §7）", () => {
  /* 上流の締切名に "Extended"（延長）と付く行が収録 3,235 行のうち 33 行（将来締切 15 行）
   * あったが、その事実は画面のどこにも出ておらず、検索も英語の `extended` でしか引けなかっ
   * た（「延長」は偶然日本語の締切名を持っていた 3 件だけ – 2026-09-23 実測）。
   * 締切が延びたかどうかは動作計画に直結するので、一覧のチップ・CSV の取得状態・検索語が
   * 同じ語になることを実データで見る。 */
  const rows = Recommender.candidateRows(data);
  const extended = rows.filter((r) => Recommender.isExtendedDeadline(r.dl));
  expect(extended.length, "延長の行が無い収録では検査が空振りする").toBeGreaterThan(0);
  expect(extended.length).toBeLessThan(rows.length);
  for (const r of extended) {
    expect(
      Recommender.hayMatches(r.hay, "延長"),
      `${r.hay.slice(0, 24)} が「延長」で引けない`,
    ).toBe(true);
  }
  // 延長していない行が混ざってはいけない（語を広く入れると誤検出になる）。
  const others = rows.filter((r) => !Recommender.isExtendedDeadline(r.dl));
  expect(
    others.filter((r) => Recommender.hayMatches(r.hay, "延長")).length,
    "延長していない行が「延長」で引ける",
  ).toBe(0);
  // CSV の取得状態にも同じ語を入れる（表計算に落とすと情報が消えないようにする）。
  // 型は行の欄を広く取る API なので、テスト側の行型は寄せる（実装の検査ではない）。
  const csv = Recommender.deadlinesToCsv(
    extended as unknown as Record<string, unknown>[],
    Date.UTC(2026, 7, 9),
  );
  expect(csv).toContain(Recommender.extendedLabelJa());
  // チップの語は日本語にする（上流の英語ラベルをそのままチップにしない – 公式ページの
  // 表記そのものを出す欄は別に有るが、あれは意図して原表記を残している欄なので別物）。
  expect(Recommender.extendedLabelJa()).not.toMatch(/[A-Za-z]/);
});

it("語を並べた検索で 0 件のとき、原因の語を名指す（SPEC §7）", () => {
  /* 「ネットワーク 福岡 GPU」も「人工知能 だけ」も 0 件だったが、画面は原因の語を言わず
   * 「検索語を短くする」しか出さなかった（2026-09-23 実測）。語ごとの当たり数を数えて、
   * 収録データに無い語を名指すか、語をすべて含む行が無いことを件数で示す。 */
  const rows = Recommender.candidateRows(data);
  const hays = rows.map((r) => r.hay);
  const counts = Recommender.queryTermCounts("ネットワーク 福岡 GPU", hays);
  expect(counts.length, "語に分けていない").toBeGreaterThan(1);
  const gpu = counts.find((c) => c.term === "gpu");
  expect(gpu, "GPU の語が数え上げられていない").toBeDefined();
  expect(gpu!.count, "この収録に GPU の行があるなら検査の前提が変わった").toBe(0);
  expect(
    counts.filter((c) => c.count > 0).length,
    "当たる語が 1 つも無い（検査が空振り）",
  ).toBeGreaterThan(0);
  /* 展開される語は、生の語ではなく展開後で数える（「九州」は会場地名に漢字で書かれて
   * いないことがある – 1 語だけで数ると「無い」と誤らせる）。 */
  const kyushu = Recommender.queryTermCounts("九州", hays);
  expect(kyushu.length).toBe(1);
  expect(kyushu[0].count, "展開後の語で数えていない").toBeGreaterThan(0);

  // 0 件案内の文面（ビルド成果物の関数を使う）。
  const app = siteRuntime();
  const hint = new Function(
    `${app.match(/const KIND_ALL_LABEL_JA = [^\n]*;/)?.[0] ?? ""}
     return (${jsFunction(app, "emptyDeadlineHint")});`,
  )() as (f: object) => string;
  const base = {
    window: "all",
    past: true,
    cats: 0,
    domestic: false,
    online: false,
    rank: "all",
    kind: "",
    query: "ネットワーク 福岡 GPU",
    hiddenKindWords: [],
    queryMatch: { catalog: 0, journal: 0 },
    // 収録データは入っている前提の検査（無いときの説明は別の検査で見る）。
    catalogConferences: 12,
  };
  const dead = hint({
    ...base,
    termCounts: [
      { term: "ネットワーク", count: 258 },
      { term: "福岡", count: 1 },
      { term: "gpu", count: 0 },
    ],
  });
  expect(dead, "収録に無い語を名指していない").toContain("「gpu」");
  expect(dead).toContain("収録データにも見当たりません");
  // 原因の語が分かったときは、的外れな「検索語を短くする」を出さない。
  expect(dead).not.toContain("検索語を短くする");
  // 語が全部当たっている場合は、語ごとの件数を出す（「人工知能 だけ」のような形）。
  const all = hint({
    ...base,
    query: "機械学習 のみ",
    termCounts: [
      { term: "機械学習", count: 494 },
      { term: "のみ", count: 1 },
    ],
  });
  expect(all).toContain("語をすべて含む行はありません");
  expect(all).toContain("「機械学習」494件");
  // 1 語だけの検索では出さない（語を並べた人が対象）。
  const one = hint({
    ...base,
    query: "データベース",
    termCounts: [{ term: "データベース", count: 456 }],
    catalogConferences: 12,
  });
  expect(one).not.toContain("語をすべて含む行はありません");
  expect(one).not.toContain("収録データにも見当たりません");
});

it("0 件の理由は読み上げにも短的に出る（長い文を aria-live に流さない・SPEC §7）", () => {
  /* 0 件の理由（どの語が足りなかったか等）は `#emptyText` に書くだけで、支援技術には
   * 読まれていなかった（2026-09-23 実測: 読み上げ専用の欄は件数だけを言っていた）。
   * とはいえ長い説明文を aria-live に流すと 1 打鍵ごとに数十語が読まれる（第 88 回で
   * 実際に起きた）。同じ原因を短い形で読み上げに出す。 */
  const app = siteRuntime();
  const note = new Function(
    `${jsFunction(app, "countJa")};
     return (${jsFunction(app, "zeroResultLiveNote")});`,
  )() as (f: {
    hiddenKindWords: string[];
    termCounts: Array<{ term: string; count: number }>;
    catalogConferences: number;
    queryMatch: { catalog: number; journal: number };
  }) => string;
  const empty = {
    hiddenKindWords: [],
    termCounts: [],
    queryMatch: { catalog: 0, journal: 0 },
    // データは入っている前提の検査（無いときの説明は別の検査で見る）。
    catalogConferences: 12,
  };
  // 収録に無い語が最優先（その語を外さないと何も変わらないので）。
  const dead = note({
    ...empty,
    termCounts: [
      { term: "ネットワーク", count: 258 },
      { term: "gpu", count: 0 },
    ],
  });
  expect(dead).toContain("gpu");
  expect(dead).toContain("収録データにありません");
  // 表に出さない種別に当たったケース。
  const kindHit = note({ ...empty, hiddenKindWords: ["採否通知"] });
  expect(kindHit).toContain("採否通知");
  expect(kindHit).toContain("種別");
  // 収録では当たるがいまの条件で 0 件、は件数を書く（「kamiyobi に無い」と誤らせない）。
  const inCatalog = note({ ...empty, queryMatch: { catalog: 31, journal: 0 } });
  expect(inCatalog).toContain("31 件");
  expect(inCatalog).toContain("いまの条件では 0 件");
  // どの原因でも無いときの受け皿。
  const plain = note(empty);
  /* 「緩められる」という言いぶりは、下に「外せる条件」が並んでいる画面では
   * その案内を指す文に変わった（外せる条件が残っていない画面では言わない – 第 141 回）。*/
  expect(plain).toContain("下に外せる条件も書いてあります");
  // 読み上げなので短い（画面に出す説明文は別。1 打鍵ごとに読まれる長さにする）。
  for (const text of [dead, kindHit, inCatalog, plain]) {
    expect(text.length, `読み上げの文が長い: ${text}`).toBeLessThanOrEqual(60);
  }
  // 読み上げ専用の欄にだけ入れ、画面に出す件数欄には足さない（画面は元の文のままで良い）。
  expect(app, "0 件の理由を読み上げに足していない").toContain("cntLive += zeroResultLiveNote(");
  expect(app, "画面の件数欄に 0 件の理由を二重に書いている").not.toContain(
    "cnt += zeroResultLiveNote(",
  );
  // 判定自体が「表が出て 0 件のときだけ」発火することも見る（推薦のカードでは出さない）。
  const guard = /const zeroFilter =[\s\S]{0,120}?\? \{/.exec(app);
  expect(guard, "0 件の判定の組み方が変わって検査が空振りしている").not.toBeNull();
  expect(guard![0], "0 件以外でも数え上げている").toContain("!shown.length");
  expect(guard![0], "推薦のカードでも数え上げている").toContain("!recMode");
});

it("手引きが名指すファイルは、画面から押して辿れる（SPEC §7）", () => {
  /* てびきと 0 件の注記は「会期だけ確定の会は upcoming.md に載せます」と何回も言うが、
   * ファイル名を書くだけだと、画面を読む人はそこにたどれない（URL を打ち込むだけになる）。
   * 同じビルドの中に有るファイルなので、押せる形にする（2026-09-23 実測: リンク 0 本）。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const mentions = template.match(/<code>upcoming\.md<\/code>/g) || [];
  expect(
    mentions.length,
    "てびきがファイルを名指す箇所が数え上げられていない",
  ).toBeGreaterThanOrEqual(2);
  const linked =
    template.match(/<a href="upcoming\.md"[^>]*><code>upcoming\.md<\/code><\/a>/g) || [];
  expect(linked.length, "てびきのファイル名が押せる形になっていない").toBe(mentions.length);
  // 印刷物でもファイル名は残る（リンクの文字自体が名前なので、印刷で消える書き方はしない）。
  expect(template, "印刷でリンク欄を丸ごと消すと名前が読めない").not.toContain(
    "main a { display: none",
  );
  // 画面の 0 件注記（ビルド後のコード）も同じファイルを指す。
  const app = siteRuntime();
  expect(app, "0 件の注記がファイルをまだ文字列に埋めている").toContain('href = "upcoming.md"');
  expect(app).not.toContain("会期は upcoming.md にも掲載");
  // 指す先がビルド成果物に本当に有る（リンク切れを防ぐ）。
  const builder = readFileSync(join(REPO_ROOT, "src", "build.ts"), "utf8");
  expect(builder, "ビルドが upcoming.md を出さなくなったらリンクが死ぬ").toContain("upcoming.md");
});

it("表に行が出ていても、会期だけ確定の該当件数が件数欄に出る（SPEC §7）", () => {
  /* 「会期だけが確定している会」の存在は、表が 0 件のときの案内にしか出ていなかった。
   * だから表に 1 行でも出た人は「これで全部だ」と受け取る（2026-09-23 実測:
   * 「研究会」は表 16 件に対して会期だけの該当 28 件、「ネットワーク」は 39 件に対し 31 件が
   * 画面に出ていなかった）。件数欄に出す。 */
  const runtime = siteRuntime();
  const script = [
    "(async () => {",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    "const DAY = 86400000;",
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    // 時計を止める（この検査機の実際の日付は 2026-09 以降なので、止めないと窓の検査が
    // 実際の日付で走って空振りする – 2026-09-23 に実測）。
    "Date.now = () => now;",
    // 会期だけ確定の回を 3 件（合致 / 過去 / 国内限定で落ちる）。
    "const DATA = { conferences: [",
    "  { key: 'a', title: 'Alpha WS', categories: ['hpc'], tags: [], editions: [",
    "    { event_start: '2026-09-30', event_end: '2026-10-01', place: 'Kyoto, Japan', deadlines: [] }] },",
    "  { key: 'b', title: 'Beta WS', categories: ['hpc'], tags: [], editions: [",
    "    { event_start: '2026-07-01', event_end: '2026-07-02', place: 'Osaka, Japan', deadlines: [] }] },",
    "  { key: 'c', title: 'Gamma WS', categories: ['hpc'], tags: ['domestic-jp'], editions: [",
    "    { event_start: '2026-10-20', event_end: '2026-10-21', place: '松江テルサ（島根県）', deadlines: [] }] },",
    "] };",
    "let searchQuery = '';",
    `${jsFunction(runtime, "windowLimitMs")}`,
    `${jsFunction(runtime, "scheduleOnlyMatches")}`,
    "const all = scheduleOnlyMatches({ window: 'all', cats: [], domestic: false, online: false });",
    "searchQuery = 'Alpha';",
    "const q = scheduleOnlyMatches({ window: 'all', cats: [], domestic: false, online: false });",
    "searchQuery = '';",
    "const domestic = scheduleOnlyMatches({ window: 'all', cats: [], domestic: true, online: false });",
    "const win = scheduleOnlyMatches({ window: '30d', cats: [], domestic: false, online: false });",
    "console.log(JSON.stringify({",
    "  all: all.map((m) => m.name), q: q.map((m) => m.name),",
    "  domestic: domestic.map((m) => m.name), win: win.map((m) => m.name),",
    " }));",
    "})().catch((e) => { console.error(e && e.stack || String(e)); process.exit(1); });",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 120_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    all: string[];
    q: string[];
    domestic: string[];
    win: string[];
  };
  // 過去の回は数えない（表と同じ「これからの会」の目盛り）。
  expect(out.all).toEqual(["Alpha WS", "Gamma WS"]);
  // 検索語でも絞れる（表と同じ目盛りであることの確認）。
  expect(out.q).toEqual(["Alpha WS"]);
  // 国内チェックをかければ国内の会だけになる。
  expect(out.domestic).toEqual(["Gamma WS"]);
  // 「締切まで」の窓も掛かる。
  expect(out.win).toEqual([]);

  // 件数欄への出し方（ビルド後）。表に行が有るときだけ出し、読み上げにも同じ語を流す。
  expect(runtime, "件数欄に会期だけ確定の件数を出していない").toContain(
    "同じ条件で会期だけが確定している会",
  );
  expect(runtime, "0 件のときと二重に出している").toContain(
    "if (shown.length && scheduleOnly.length)",
  );
  expect(runtime, "読み上げに伝えていない").toContain("cntLive += scheduleNote");
});

it("画面に出る曜日が検索の語になり、週末・平日も寄せた先を出す（SPEC §7）", () => {
  /* 一覧の日付欄は JST の曜日を一文字で出しているのに（既定画面 478 行は全て曜日付き）、
   * 「金曜日」で引くと 0 件だった（2026-09-23 実測）。画面に出る語は検索でも引ける、
   * という規則を曜日に適用する。一文字（`土`）は他の語を巻くので入れない。 */
  const rows = Recommender.candidateRows(data);
  const now = Date.UTC(2026, 7, 9);
  const view = rows.filter(
    (r) => (r.kind === "abstract" || r.kind === "paper") && r.t >= now && !r.ed.estimated,
  );
  const hits = (q: string) => {
    const m = Recommender.searchMatcher(q, now);
    return view.filter((r) => m(r.hay)).length;
  };
  const days = ["月曜", "火曜", "水曜", "木曜", "金曜", "土曜", "日曜"];
  const per = days.map((w) => hits(w));
  days.forEach((w, i) => {
    expect(per[i], `${w} の行が引けない`).toBeGreaterThan(0);
  });
  // 各行は必ずちょうど一日に当たる（合計が行数と一致 = 漏れも重複もない）。
  expect(
    per.reduce((a, b) => a + b, 0),
    "曜日の当たり方が行数と合わない",
  ).toBe(view.length);
  // 週末・平日は寄せた先を件数欄に出す（語を増やしたことを隠さない）。
  expect(hits("週末")).toBe(hits("土曜") + hits("日曜"));
  expect(hits("平日")).toBe(view.length - hits("週末"));
  // 寄せたことを件数欄のおしらせで言う（語を増やしたことを隠さない）。
  expect(Recommender.querySynonymNotes("週末").join("")).toContain("土曜日の行と日曜日の行");
  expect(Recommender.querySynonymNotes("平日").join("")).toContain("月曜日から金曜日の行");
  // 曜日の寄せ先は、分野などを画面に出るラベルへ寄せる表には混ぜていない（別の検査が
  // あの表の展開語を「列にそのまま出るラベル」に限定しているため）。
  const rec = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
  const labelTable = /const QUERY_SYNONYMS_JA[\s\S]*?\n {2}\];/.exec(rec);
  expect(labelTable, "寄せ語の対応表が読めない").not.toBeNull();
  expect(labelTable![0], "曜日の語を分野などの表に混ぜている").not.toContain("週末");
  expect(rec, "曜日の寄せ語の表が無い").toContain("WEEKDAY_QUERY_SYNONYMS_JA");
  // 一文字の語を入れなかった理由（「土木」が曜日で引えるようになってはいけない）。
  expect(hits("土木")).toBe(0);
  // 時刻未確認の行は、表示している暦日（local_date）の曜日で引ける。
  const dateOnly = view.filter((r) => String(r.localDate || "").trim());
  expect(dateOnly.length, "時刻未確認の行が無く検査が空振りする").toBeGreaterThan(0);
  for (const r of dateOnly.slice(0, 40)) {
    const term = Recommender.weekdaySearchTerms(r.localDate).split(" ")[0];
    expect(term, `${String(r.localDate)} の曜日が作れない`).not.toBe("");
    expect(
      Recommender.searchMatcher(term, now)(r.hay),
      `表示の暦日 ${String(r.localDate)} の曜日でその行が引けない`,
    ).toBe(true);
  }
  // 手引きが曜日の引き方を説明している（語の形も実装と同じものを使う）。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  expect(template, "てびきが曜日の検索を説明していない").toContain("曜日も引けます");
  expect(template).toContain("「週末」（土曜日・日曜日）");
});

it("「視差効果を減らす」設定では動きが消え、開閉自体はそのまま効く（SPEC §7）", () => {
  /* OS の設定で動きを抑えている人。第 110 回で JS のスクロールはこの設定を見たが、
   * CSS の遷移は見ていなかった（2026-09-23 実測: `prefers-reduced-motion` の扱いが
   * スタイル内に 0 箇所で、行の詳細は 0.25 秒で滑り込んでいた）。*/
  const html = siteHtmlRuntime();
  const style = html.slice(html.indexOf("<style"), html.indexOf("</style>"));
  const blocks = cssBlocks(style);
  const reduced = blocks.filter((b) => /prefers-reduced-motion/.test(b.media || ""));
  expect(reduced.length, "動きを抑える設定の扱いがスタイルに無い").toBeGreaterThan(0);
  const star = reduced.find((b) => b.selector === "*");
  expect(star, "要素全体の動きを止めていない").toBeDefined();
  expect(star!.body, "遷移の長さを短くしていない").toContain("transition-duration: 0.01ms");
  // 待ち受けの安全のため `none` ではなく 0.01ms にする（0 にすると遷移終了が来ない）。
  expect(star!.body).not.toMatch(/transition[^:]*:\s*none/);
  // 解決関数（メディアクエリの条件は幅だけを見る）でも、動きが消えた値になること。
  expect(effectiveCss(style, "*", "transition-duration", 1200)).toContain("0.01ms");
  // 通常時の動きまで潰していたら意味が無い（既定は従来のままだこと）。
  expect(effectiveCss(style, ".drawer", "transition", 1200)).toContain("0.25s");
  expect(effectiveCss(style, ".drawer-backdrop", "transition", 1200)).toContain("0.2s");
  // 開閉はクラスの宣言で決まり、遷移の完了に依存しない（動きを消しても開く・閉じるが
  // そのまま効くことを、宣言そのもので見る）。
  expect(effectiveCss(style, ".drawer-backdrop", "visibility", 1200)).toBe("hidden");
  expect(effectiveCss(style, ".drawer-backdrop.active", "visibility", 1200)).toBe("visible");
  expect(effectiveCss(style, ".drawer", "right", 1200)).toBe("-480px");
  expect(effectiveCss(style, ".drawer-backdrop.active .drawer", "right", 1200)).toBe("0");
  // JS 側（行のスクロール）も同じ設定を見ている – 片方だけ守る形に戻さない。
  expect(siteRuntime()).toContain("prefers-reduced-motion");
});

it("検索欄で Esc を押すと、語を消さずに欄を出て選択行に戻る（SPEC §7）", () => {
  /* `/` で検索欄に飛び、打ち終わって `j` / `k` を打ちたい、というのが実際の動きだった。
   * 入力欄にいる間の `j` / `k` は文字入力になるので、Esc で欄を出る必要がある。
   * Esc 自体は入力欄で効いていたが、フォーカスが body に落ちるだけだった
   * （2026-09-23 実測: 選択行に返していなかった – 行の詳細を閉じるときだけ戻す形）。
   * 支援技術では「どこを読めばいいのか」が分からなくなる。*/
  const html = siteRuntime();
  const keySrc = keydownWithBlockers(html);
  const selectSrc = jsFunction(html, "updateRowSelection");
  const script = [
    "const calls = [];",
    "function row(name) {",
    "  return {",
    "    name,",
    "    classList: { contains: () => false, toggle: (c, on) => calls.push(name + ':' + c + ':' + on) },",
    "    focus() { calls.push('focus:' + name); },",
    "    scrollIntoView() { calls.push('scroll:' + name); },",
    "    setAttribute(k, v) { calls.push(name + ':' + k + '=' + v); },",
    "    removeAttribute(k) { calls.push(name + ':-' + k); },",
    "  };",
    "}",
    "const rows = [row('row0'), row('row1')];",
    // 検索欄（id は q）。フォーカスを戻す対象と区別できるので、blur を数える。
    "const search = { tagName: 'INPUT', blur() { calls.push('blur:q'); }, focus() {} };",
    "const paper = { tagName: 'TEXTAREA', blur() { calls.push('blur:paper'); }, focus() {} };",
    "const els = { q: search, tbody: { querySelectorAll: () => rows } };",
    "const document = { activeElement: null, getElementById: (id) => els[id] || null };",
    "function $(id) { return document.getElementById(id); }",
    "const window = { matchMedia: () => ({ matches: false }) };",
    "const shown = [{ key: 'A' }, { key: 'B' }];",
    `const KEY = ${JSON.stringify(keySrc)};`,
    `const SELECT = ${JSON.stringify(selectSrc)};`,
    "const make = (selectedIndex) =>",
    "  new Function('window', 'document', '$', 'selectedIndex', 'shown', 'openDrawer', 'closeDrawer', 'updateRowSelection', KEY + ';return onKeydown;')(",
    "    window, document, $, selectedIndex, shown, () => {}, () => {}, updateRowSelection);",
    "const updateRowSelection = new Function('window', 'document', '$', 'selectedIndex', 'return (' + SELECT + ')')(window, document, $, 1);",
    // ① 検索欄で Esc → 欄を出て（blur）、選んでいた行にフォーカスが戻る。
    "calls.length = 0;",
    "make(1)({ key: 'Escape', preventDefault() {}, target: search });",
    "const fromSearch = calls.slice();",
    // ② 他の入力欄（論文の本文など）で Esc → 欄は出るが、表の行に奪わない。
    "calls.length = 0;",
    "make(1)({ key: 'Escape', preventDefault() {}, target: paper });",
    "const fromPaper = calls.slice();",
    // ③ 行を選んでいないとき（まだ 0 件・未選択）は行にフォーカスを移さない。
    "calls.length = 0;",
    "make(-1)({ key: 'Escape', preventDefault() {}, target: search });",
    "const noRow = calls.slice();",
    // ④ そのほかの鍵では何もしない（入力の内容を壊さない）。
    "calls.length = 0;",
    "make(1)({ key: 'x', preventDefault() {}, target: search });",
    "const other = calls.slice();",
    "console.log(JSON.stringify({ fromSearch, fromPaper, noRow, other }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Record<string, string[]>;
  expect(out.fromSearch, "検索欄から出られていない").toContain("blur:q");
  expect(out.fromSearch, "選択行にフォーカスが戻っていない").toContain("focus:row1");
  // 検索語を消す実装に戻っていないこと（blur 以外の操作を足していない）。
  expect(out.fromSearch.filter((c) => c.startsWith("blur:"))).toEqual(["blur:q"]);
  // 他の入力欄では表の行を奪わない（論文の本文に打っていて Esc を押した人が、表の行に
  // 飛ばされることがあってはいけない）。
  expect(out.fromPaper).toContain("blur:paper");
  expect(
    out.fromPaper.filter((c) => c.startsWith("focus:")),
    "他の入力欄で Esc を押した人が表の行に飛ばされている",
  ).toEqual([]);
  // 行が未選択のときはフォーカスを移さない（存在しない行を触らない）。
  expect(out.noRow.filter((c) => c.startsWith("focus:"))).toEqual([]);
  // 他の鍵は入力欄では素通り（文字が入るだけ）。
  expect(out.other).toEqual([]);
  // 手引きが二つの導線を説明している（ショートカットの一覧は件数欄にもある）。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  expect(template, "てびきが / と Esc の導線を説明していない").toContain(
    "<code>/</code> で検索欄に飛び",
  );
  expect(template).toContain("検索語を消さずに欄を出て");
});

it("幅を持つ行の残り・並び・月は、画面に出している暦日で決まる（SPEC §7）", () => {
  /* 時刻未確認の行は `t` が「最も早く締切る瞬間」（UTC+14 の始まり）だった。それを
   * 残り・並び・月の基準に使うと、同じ行の日付欄と食い違う（2026-09-23 実測:
   * 既定画面 478 行で表示暦日が戻る隣接ペア 27 件。CSV の残り列は既定画面の該当 175 行
   * すべてで日付欄より 1 日少ない値。収録全体では 13 行が前の月のグループに落ち、例は
   * 表示 2026-09-01 の行が 2026年8月に入っていた）。画面の「残り」はこれらの行では数値を
   * 出さず「時刻未確認」の語を出すので、画面にずれは出ていなかった。*/
  const recPath = join(site, "recommender.js");
  const dataPath = join(site, "data.json");
  const script = [
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${recPath}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(dataPath)}, 'utf8'));`,
    "const NOW = Date.parse('2026-08-09T00:00:00Z');",
    "const DAY = 86400000;",
    "const jstDay = (ms) => Math.floor((ms + 9 * 3600000) / DAY);",
    "const jstMonth = (ms) => { const d = new Date(ms + 9 * 3600000); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); };",
    "const displayDay = (r) => String(r.localDate || '').trim() || new Date(r.t + 9 * 3600000).toISOString().slice(0, 10);",
    "const rows = Recommender.candidateRows(DATA, NOW);",
    "const view = rows.filter((r) => (r.kind === 'abstract' || r.kind === 'paper') && r.t >= NOW && !r.est);",
    "const dateOnly = view.filter((r) => String(r.localDate || '').trim());",
    "const inversions = (list, key) => { const s = [...list].sort((a, b) => key(a) - key(b)); let n = 0; for (let i = 1; i < s.length; i++) if (displayDay(s[i - 1]) > displayDay(s[i])) n++; return n; };",
    // ① 並び: 表示している暦日が戻る場所が無いこと（従来の基準では実在した）。
    "const shownInversions = inversions(view, (r) => r.tShown);",
    "const oldInversions = inversions(view, (r) => r.t);",
    // ② 基準: 時刻未確認の行の `tShown` は日付欄の日そのもの（CSV の残り列はここから数える）。
    "const remainWrong = dateOnly.filter((r) => jstDay(r.tShown) !== jstDay(Date.parse(String(r.localDate) + 'T00:00:00+09:00'))).length;",
    // ③ 月グループ: 表示している暦日の月に入る（従来の基準では前の月に落ちていた）。
    "const monthWrong = rows.filter((r) => String(r.localDate || '').trim() && jstMonth(r.tShown) !== String(r.localDate).slice(0, 7)).length;",
    "const monthWrongOld = rows.filter((r) => String(r.localDate || '').trim() && jstMonth(r.t) !== String(r.localDate).slice(0, 7)).length;",
    // ④ 終了判定の幅はそのまま（幅の最早 < 表示の暦日 < 幅の終り）。
    "const widthOk = dateOnly.every((r) => r.t < r.tShown && r.tShown <= r.tLast);",
    // ⑤ CSV の残り列も同じ基準。
    "const sample = dateOnly[0];",
    "const csv = Recommender.deadlinesToCsv([sample], NOW);",
    "const csvLeft = Number(csv.split('\\n')[1].split(',')[2]);",
    "const csvExpected = jstDay(Date.parse(String(sample.localDate) + 'T00:00:00+09:00')) - jstDay(NOW);",
    "console.log(JSON.stringify({ view: view.length, dateOnly: dateOnly.length, shownInversions, oldInversions, remainWrong, monthWrong, monthWrongOld, widthOk, csvLeft, csvExpected }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Record<string, number | boolean>;
  expect(out.view, "既定画面が空").toBeGreaterThan(100);
  expect(out.dateOnly, "時刻未確認の行が無い").toBeGreaterThan(50);
  expect(out.shownInversions, "日時順で表示している暦日が戻る行がある").toBe(0);
  expect(out.oldInversions, "基準を変えても何も変わらないなら検査は無意味").toBeGreaterThan(0);
  expect(out.remainWrong, "残りの基準が日付欄と違う時刻未確認の行がある").toBe(0);
  expect(out.monthWrong, "月グループが日付欄と違う月に入る行がある").toBe(0);
  expect(out.monthWrongOld, "従来の基準でも月は狂っていなかったはず").toBeGreaterThan(0);
  expect(out.widthOk, "幅の両端が壊れている").toBe(true);
  expect(out.csvLeft, "CSV の残り列が日付欄から数えた日数と違う").toBe(out.csvExpected);
});

it("並びの比較は表示している暦日を使い、その値を持たない行も落とさない（SPEC §7）", () => {
  const app = siteRuntime();
  const cmpSrc = jsFunction(app, "compareDeadlineRows");
  const monthSrc = jsFunction(app, "monthKey");
  const remainSrc = jsFunction(app, "remain");
  const script = [
    "const DAY = 86400000;",
    "const name = (r) => r.name;",
    "const kindIndex = (k) => (k === 'abstract' ? 0 : k === 'paper' ? 1 : 2);",
    `const CMP = ${JSON.stringify(cmpSrc)};`,
    `const MONTH = ${JSON.stringify(monthSrc)};`,
    `const REMAIN = ${JSON.stringify(remainSrc)};`,
    "const cmp = new Function('conferenceNameCell', 'kindSortIndex', 'return (' + CMP + ')')(name, kindIndex);",
    "const pad = (n) => String(n).padStart(2, '0');",
    "const monthKey = new Function('pad', 'return (' + MONTH + ')')(pad);",
    "const now = Date.UTC(2026, 7, 9);",
    "const DateNow = now;",
    "const remain = new Function('DAY', 'Date', 'return (' + REMAIN + ')')(DAY, { now: () => DateNow });",
    // 表示 8月14日 23:00 JST（確定）と、表示 8月15日（時刻未確認・幅の最早は 8月14日 19:00 JST）。
    "const sure = { name: 'A', kind: 'paper', t: Date.UTC(2026, 7, 14, 14, 0), tShown: Date.UTC(2026, 7, 14, 14, 0), tLast: Date.UTC(2026, 7, 14, 14, 0) };",
    "const wide = { name: 'B', kind: 'paper', t: Date.UTC(2026, 7, 14, 10, 0), tShown: Date.UTC(2026, 7, 15, 3, 0), tLast: Date.UTC(2026, 7, 15, 15, 0), localDate: '2026-08-15' };",
    // 従来の基準（t）なら B が先だったが、表示している暦日では A が先。
    "const oldOrder = wide.t < sure.t;",
    "const shownOrder = cmp(sure, wide) < 0;",
    // 降順でも逆向きになる（塊の反転を再現しない）。
    "const descOrder = cmp(sure, wide, -1) > 0;",
    // tShown を持たない行（古い呼び出し側・検査が組んだ行）は t で並ぶ。末尾には落ちない。
    "const legacy = { name: 'C', kind: 'paper', t: Date.UTC(2026, 7, 20), tLast: Date.UTC(2026, 7, 20) };",
    "const legacyFirst = cmp(legacy, sure) > 0;",
    "const legacyVsTail = cmp(legacy, { name: 'D', kind: 'paper', t: Number.NaN, tLast: Number.NaN }) < 0;",
    // 月も表示している暦日。幅の最早が前の月でも、表示の月に入る。
    "const monthWide = { name: 'E', kind: 'paper', t: Date.UTC(2026, 8, 30, 10, 0), tShown: Date.UTC(2026, 9, 1, 3, 0), tLast: Date.UTC(2026, 9, 1, 15, 0), localDate: '2026-10-01' };",
    "const month = monthKey(monthWide);",
    "const monthFromT = new Date(monthWide.t + 9 * 3600000).getUTCMonth();",
    "const monthJournal = monthKey({ kind: 'journal', name: 'J', t: now, tShown: now, tLast: now });",
    // 残りは tShown から。持たない行は t から数え、NaN を画面に出さない。
    "const remainWide = remain(wide.tShown).text;",
    "const remainLegacy = remain(legacy.t).text;",
    "const remainNoNaN = remain(Number.NaN).text.indexOf('NaN') < 0;",
    "console.log(JSON.stringify({ oldOrder, shownOrder, descOrder, legacyFirst, legacyVsTail, month, monthFromT, monthJournal, remainWide, remainLegacy, remainNoNaN }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Record<string, unknown>;
  expect(out.oldOrder, "前提が崩れた（従来の基準なら B が先では無い）").toBe(true);
  expect(out.shownOrder, "表示している暦日で並んでいない").toBe(true);
  expect(out.descOrder, "降順で逆向きになっていない").toBe(true);
  expect(out.legacyFirst, "tShown の無い行を末尾に落としている").toBe(true);
  expect(out.legacyVsTail, "tShown の無い行と時刻不明の行の前後が壊れている").toBe(true);
  expect(out.month, "月グループが表示の暦日から決まっていない").toBe("2026-10");
  expect(out.monthFromT, "従来の基準でも 10 月なら検査は無意味").toBe(8);
  expect(out.monthJournal, "常時受付が月グループに入っている").toBe("");
  expect(out.remainWide, "残りが表示している暦日から数えていない").toBe("あと 6 日");
  expect(out.remainLegacy).toBe("あと 11 日");
  expect(out.remainNoNaN, "残りに NaN が出ている").toBe(true);
});

it("印刷物に、条件・並び順・件数・日時が残り、画面では見えない（SPEC §7）", () => {
  /* 印刷は「研究室に貼る・グループ会議で回覧する」用途（スタイルのコメントに書いた需要）。
   * ところが画面の絞り込み欄は印刷で落ちるため、紙のうえに「どんな条件で絞った一覧か」が
   * 残っていなかった（2026-09-23 実測: 印刷時に条件を書く箇所はどこにも無い。データ生成日
   * だけがヘッダーに残る）。受け取った人は収録全体の一覧と取り違える。*/
  const app = siteRuntime();
  const describeSrc = jsFunction(app, "describeFilters");
  const script = [
    `const DESCRIBE_SRC = ${JSON.stringify(describeSrc)};`,
    "const DESCRIBE = new Function('return (' + DESCRIBE_SRC + ')')();",
    "const kind = (k) => ({ abstract: '概要締切', paper: '論文締切' })[k] || k;",
    "const cat = (c) => ({ net: 'ネットワーク', hpc: '高性能計算' })[c] || c;",
    "const sl = (k) => ({ rem: '残り', date: '日時（JST）', event: '会期', conf: '会議', rank: 'ランク' })[k] || '';",
    "const f = (over, win, sort) =>",
    "  DESCRIBE(",
    "    Object.assign(",
    "      { q: '', cats: [], kind: '', rank: '', est: false, domestic: false, online: false, past: false },",
    "      over,",
    "    ),",
    "    kind,",
    "    (g) => (g === 'N' ? '評価なし' : g),",
    "    cat,",
    "    win || '',",
    "    sort || { key: 'rem', asc: true },",
    "    sl,",
    "  );",
    "const nothing = f({});",
    // 空白だけの検索語は条件にしない（打つ途中の欄で「検索語「」」と出さない）。
    "const blank = f({ q: '   ' });",
    "const many = f({ q: '研究会', kind: 'paper', cats: ['net', 'hpc'], domestic: true, online: true, past: true, est: true }, '30日以内');",
    // ランクは画面に出る等級そのものを書く（内部の番兵を書かない）。
    "const ranked = f({ rank: 'A*' });",
    // 「評価なし」を選ぶと紙に「ランク: N」と出ていた（選択欄は日本語に出すと同じ語にする）。
    "const unrated = f({ rank: 'N' });",
    // 並び順は絞り込みではないが、紙には要る（並べ替えて配ることもある）。
    "const byEvent = f({ q: '研究会' }, '', { key: 'event', asc: true });",
    "const byDateDesc = f({}, '', { key: 'date', asc: false });",
    // 既定の並びでも書く（「締切の新しい順で印刷した」が分からないと読み手が困る）。
    "const byDefault = f({}, '', { key: 'rem', asc: true });",
    // 見出しに見当たらない鍵のときは並び順を書かない（噓を書かない）。
    "const unknownKey = f({}, '', { key: 'nope', asc: true });",
    "console.log(JSON.stringify({ nothing, blank, many, ranked, unrated, byEvent, byDateDesc, byDefault, unknownKey }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Record<string, string>;
  expect(out.nothing, "何も絞っていないときの書き方が無い").toContain("絞り込みなし");
  expect(out.blank, "空の検索語を条件にしている").toBe(out.nothing);
  expect(out.many).toContain("検索語「研究会」");
  expect(out.many).toContain("種別: 論文締切");
  expect(out.many).toContain("分野: ネットワーク・高性能計算");
  expect(out.many).toContain("締切まで: 30日以内");
  expect(out.many).toContain("推定締切を含める");
  expect(out.many).toContain("国内研究会・国内シンポジウムのみ");
  expect(out.many).toContain("オンライン参加可のみ");
  expect(out.many).toContain("過去の締切も表示");
  expect(out.ranked).toContain("ランク: A*");
  // 「評価なし」は選択欄と同じ語で紙に書く。N はデータ内部の番兵で、紙で意味が読めない。
  expect(out.unrated, "条件の書き下ろしが評価なしを日本語で出さない").toContain("ランク: 評価なし");
  expect(out.unrated, "条件の書き下ろしが内部の番兵 N を書いている").not.toMatch(/ランク: N(\D|$)/);
  // 並び順（第 126 回で会期順が増えたので、紙で区別できる必要がある）。
  expect(out.byEvent).toContain("検索語「研究会」");
  expect(out.byEvent).toContain("並び順: 会期 昇順");
  expect(out.byDateDesc).toContain("並び順: 日時（JST） 降順");
  expect(out.byDefault, "既定の並びが紙に残っていない").toContain("並び順: 残り 昇順");
  expect(out.byDefault).toContain("絞り込みなし");
  // 見出しに見当たらない鍵のときは並び順を書かない（噓の列名を紙に残さない）。
  expect(out.unknownKey, "画面に無い列名を並び順として書いた").toBe(
    "絞り込みなし（収録全体の一覧）",
  );
  expect(out.unknownKey).not.toContain("並び順");
  // 画面のチェック欄・セレクトと同じ語を書いている（別の名前を付けない）。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  for (const label of [
    "推定締切を含める",
    "過去の締切も表示",
    "国内研究会・国内シンポジウムのみ",
    "オンライン参加可のみ",
  ]) {
    expect(template, `画面に出ている条件の語がない: ${label}`).toContain(label);
  }

  // 紙にのこる見出し: 画面では `display: none`（支援技術からもタブ順序からも消す）、
  // 印刷のときだけ出る。幅解決の補助関数は print を見ないので、節を直接読む。
  const html = siteHtmlRuntime();
  const style = html.slice(html.indexOf("<style"), html.indexOf("</style>"));
  expect(effectiveCss(style, ".print-meta", "display", 1200)).toBe("none");
  const blocks = cssBlocks(style);
  const printed = blocks.filter((b) => b.selector === ".print-meta" && /print/.test(b.media || ""));
  expect(printed.length, "印刷のときに出る規則が無い").toBeGreaterThan(0);
  expect(printed[0].body, "印刷のときに block になっていない").toContain("display: block");
  // 表の直前にあること（印刷で表より後ろに落ちると「誰の一覧か」分からない）。
  expect(
    template.indexOf('id="printMeta"') < template.indexOf('id="deadlineTableWrap"'),
    "見出しが表より後ろにある",
  ).toBe(true);
  // 印刷の前に入れて、後で消す（画面の DOM に古い条件を残さない）。
  expect(app).toContain("beforeprint");
  expect(app).toContain("fillPrintMeta();");
  expect(app).toContain('$("printMeta")');
  // 呼び出し側が、今の並びを実際に渡していること（上の抜き出し検査だけでは実画面は変わらない）。
  expect(app).toContain("{ key: sortKey, asc: sortAsc },");
  // 列名を取り出す関数も印刷の組み立てに使っている（見出しの語を二箇所に書かない）。
  expect(app).toContain("sortColumnLabel");
  const labelSrc = jsFunction(app, "sortColumnLabel");
  // 列名は画面の見出しから取る（書き写さない）。見出しは目印の矢印まで書き換えるので、
  // そこを落として紙に出せる語だけを取り出すことを、見出しの実物に近い形で確認する。
  const labelProc = spawnSync(
    "node",
    [
      "-e",
      vmSafeSource(
        [
          `const SRC = ${JSON.stringify(labelSrc)};`,
          // 見出しの実物は「会期 ↕」のように語と目印が一体になっている。
          "const run = (text, key) => {",
          "  const doc = {",
          "    querySelector: (sel) => (sel.indexOf(key) >= 0 ? { textContent: text } : null),",
          "  };",
          "  return new Function('document', 'return (' + SRC + ')')(doc)(key);",
          "};",
          "console.log(JSON.stringify([",
          "  run('会期 ↕', 'event'),",
          "  run('日時（JST） ↓', 'date'),",
          "  run('残り ↑', 'rem'),",
          "  run('', 'conf'),",
          "]));",
        ].join("\n"),
      ),
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  expect(labelProc.status, labelProc.stderr).toBe(0);
  const labels = JSON.parse(labelProc.stdout) as string[];
  // 見出しの語だけを取り、目印の矢印は紙に書かない（空の見出しは空のまま）。
  expect(labels).toEqual(["会期", "日時（JST）", "残り", ""]);
  expect(app, "印刷した日時を残していない").toContain("印刷した日時");
  expect(app, "データ生成日時を残していない").toContain("generatedAtLabel(genAt)");
  // てびきが印刷の説明を持っている（押せる場所が無いと分からない）。
  expect(template).toContain("<dt>印刷</dt>");
});

it("選んだ行は支援技術にも伝わる（視覚の目印だけで状態を出さない・SPEC §7）", () => {
  /* 選んだ行は `selected` クラスの切り替えだけを変えていた（2026-09-23 実測: ビルド
   * 成果物に `aria-current`・`aria-selected` は 1 箇所も無い）。クラスは色と枠でしか
   * 伝わらないので、キーボードで何行目を選んでいるかが支援技術に読めない。*/
  const app = siteRuntime();
  const selectSrc = jsFunction(app, "updateRowSelection");
  const script = [
    "function mk(name, cls) {",
    "  return {",
    "    name,",
    "    attrs: {},",
    "    classes: cls.slice(),",
    "    classList: {",
    "      contains: (c) => cls.indexOf(c) >= 0,",
    "      toggle: (c, on) => {",
    "        const at = cls.indexOf(c);",
    "        if (on && at < 0) cls.push(c);",
    "        if (!on && at >= 0) cls.splice(at, 1);",
    "      },",
    "    },",
    "    setAttribute(k, v) { this.attrs[k] = String(v); },",
    "    removeAttribute(k) { delete this.attrs[k]; },",
    "    focus() {},",
    "    scrollIntoView() {},",
    "  };",
    "}",
    "const rows = [mk('r0', ['row']), mk('detail', ['detail-row']), mk('r1', ['row']), mk('r2', ['row'])];",
    "const document = { getElementById: (id) => (id === 'tbody' ? tbody : null) };",
    "const tbody = { querySelectorAll: () => rows };",
    "function $(id) { return document.getElementById(id); }",
    "const window = { matchMedia: () => ({ matches: true }) };",
    `const SELECT = ${JSON.stringify(selectSrc)};`,
    "const run = (index) => {",
    "  const fn = new Function('window', 'document', '$', 'selectedIndex', 'return (' + SELECT + ')')(window, document, $, index);",
    "  fn();",
    "  return rows.filter((r) => r.attrs['aria-current']).map((r) => r.name + '=' + r.attrs['aria-current']);",
    "};",
    "const one = run(1);",
    "const clsAfterOne = rows.map((r) => r.name + ':' + (r.classList.contains('selected') ? 1 : 0)).join(' ');",
    // クラスの付き方はこの時点で写す（後に選び直すと消える）。
    "const moved = run(2);",
    "const none = run(-1);",
    "const cls = clsAfterOne;",
    "console.log(JSON.stringify({ one, moved, none, cls }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    one: string[];
    moved: string[];
    none: string[];
    cls: string;
  };
  // 選んだ行だけが行番号を宣言する（クラスと同じ一行）。
  expect(out.one, "選んだ行が支援技術に分かる属性を持っていない").toEqual(["r1=row"]);
  // 選び直したら前の行の宣言は消える（二行が「今選んでいる行」になる形を許さない）。
  expect(out.moved, "選び直したあと前の行が宣言を残している").toEqual(["r2=row"]);
  // 未選択（再描画直後）は宣言が残らない。
  expect(out.none, "未選択なのに宣言が残っている").toEqual([]);
  // 展開行・月見出し行は対応表から除外されている（属性も付けない）。
  // 展開行（detail）は対応表から除外されているので、選んでもいないのに印を付けられない。
  expect(out.cls).toBe("r0:0 detail:0 r1:1 r2:0");
  // 実物のビルド成果物にも属性の操作が入っていること（上の抜き出しが空振りでないこと）。
  expect(app).toContain('setAttribute("aria-current", "row")');
  expect(app).toContain('removeAttribute("aria-current")');
});

it("締切のデータが無い画面は、それを条件の話より先に言う（SPEC §7）", () => {
  /* データが差し込まれていない HTML を開いたとき、画面は「該当する締切はありません。
   * 条件を緩めると出ます」と言っていた（2026-09-23 実測）。緩めても何も出ないので、
   * 的外れの案内になる。ヘッダーの「データ生成」も、値が欠けていると語だけ残る
   * （空文字 → 「データ生成: 」、`undefined` → その英字、`null` → 1970-01-01）。
   * 締切のサイトで間違った日付を「データ生成」として見せるのが最悪だった。*/
  const app = siteRuntime();
  const script = [
    `const LABEL_SRC = ${JSON.stringify(jsFunction(app, "generatedAtLabel"))};`,
    `const HINT_SRC = ${JSON.stringify(jsFunction(app, "emptyDeadlineHint"))};`,
    `const LIVE_SRC = ${JSON.stringify(jsFunction(app, "zeroResultLiveNote"))};`,
    // fmtJst はビルド成果物から取る（表示形式をここにもう一度書かない）。
    `const FMT_SRC = ${JSON.stringify(jsFunction(app, "fmtJst"))};`,
    "const fmtJst = new Function(",
    "  'WEEKDAY_JA',",
    "  'pad',",
    "  'return (' + FMT_SRC + ')'",
    ")(['日','月','火','水','木','金','土'], (n) => String(n).padStart(2, '0'));",
    "const generatedAtLabel = new Function('fmtJst', 'UNCONFIRMED_JA', 'return (' + LABEL_SRC + ')')(fmtJst, '未確認');",
    "const hint = new Function('return (' + HINT_SRC + ')')();",
    "const live = new Function('return (' + LIVE_SRC + ')')();",
    "const empty = {",
    "  window: 'all', past: false, cats: 0, domestic: false, online: false, rank: '',",
    "  kind: '', query: '', hiddenKindWords: [], queryMatch: { catalog: 0, journal: 0 },",
    "  termCounts: [], catalogConferences: 0,",
    "};",
    "const labels = ['', undefined, null, 'junk'].map((v) => generatedAtLabel(v));",
    "const goodLabel = generatedAtLabel('2026-08-09T00:00:00Z');",
    "const noData = hint(empty);",
    "const noDataLive = live(empty);",
    // 同じ画面でデータが入っていれば、従来どおり条件の話をする（空振りでないこと）。
    "const withData = hint(",
    "  Object.assign({}, empty, {",
    "    catalogConferences: 12,",
    "    query: '人工知能 gpu',",
    "    // 語を並べて打った形（原因の語を名指す案内は二語以上のときに出る）。",
    "    termCounts: [{ term: '人工知能', count: 12 }, { term: 'gpu', count: 0 }],",
    "    queryMatch: { catalog: 0, journal: 0 },",
    "  }),",
    ");",
    "const withDataLive = live(Object.assign({}, empty, { catalogConferences: 12, termCounts: [{ term: 'gpu', count: 0 }] }));",
    "console.log(JSON.stringify({ labels, goodLabel, noData, noDataLive, withData, withDataLive }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    labels: string[];
    goodLabel: string;
    noData: string;
    noDataLive: string;
    withData: string;
    withDataLive: string;
  };
  // 値が欠けている三类（空欄・`undefined`・`null`）で、語だけの空欄・英字・1970 年を
  // 画面に出さない。
  for (const label of out.labels.slice(0, 3)) {
    expect(label, "データ生成の表示に値の欠け方が漏れている").toBe("データ生成: 未確認");
  }
  // 読めるのに日付ではない値（運営が置く「未取得」などの印字）はそのまま出す –
  // 「未確認」に潰すと、運営側の切り分けができなくなる（別の検査が実物を見ている）。
  expect(out.labels[3], "日付として読めない印字を潰している").toBe("データ生成: junk");
  expect(out.goodLabel).toContain("2026-08-09");
  expect(out.goodLabel).not.toContain("undefined");
  // データが無いときは、条件を緩める案内を出さない。
  expect(out.noData).toContain("締切のデータが入っていません");
  expect(out.noData).not.toContain("条件を緩める");
  expect(out.noData).not.toContain("外せる条件");
  expect(out.noData).not.toContain("外せる条件");
  expect(out.noDataLive, "読み上げがデータが無いことを言っていない").toContain(
    "データが入っていません",
  );
  // データが入っているときは従来の案内が生きている。
  expect(out.withData).toContain("該当する締切はありません");
  expect(out.withData).toContain("gpu");
  expect(out.withDataLive).toContain("gpu");
  // 呼び出し側が収録件数を通していること（上だけ見ていても実画面は変わらない）。
  expect(app).toContain("catalogConferences: DATA.conferences.length");
});

it("意味検索が使えない理由は、画面では日本語で出る（英字の符号を混ぜない・SPEC §7）", () => {
  /* 件数の欄に出す「意味検索は利用不可（語彙検索のみ・原因: …）」に、失敗の識別子を
   * そのまま挟んでいた（2026-09-23 実測: 「原因: embeddings unavailable」「原因:
   * model load failed」…）。識別子は #711（8 通りの失敗が 1 文言に潰れて原因追跡不能に
   * なった）で入れたもので、捨てると調査に戻れない。画面は日本語、識別子は属性で残す。*/
  const app = siteRuntime();
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(
      `file://${join(site, "recommender.js")}`,
    )});`,
    "const labels = Recommender.semanticReasonLabelsJa;",
    "const codes = Object.keys(labels);",
    "const ascii = codes.filter((c) => /[A-Za-z]/.test(labels[c]));",
    "const shown = codes.map((c) => Recommender.semanticReasonJa(c));",
    "const other = Recommender.semanticReasonJa('some free text from upstream');",
    "const passthrough = Recommender.semanticReasonJa('モデルの読み込みに失敗しました（詳しい注記）');",
    "const blank = [undefined, null, '   '].map((v) => Recommender.semanticReasonJa(v));",
    "console.log(JSON.stringify({ codes: codes.length, ascii, shown, other, passthrough, blank, labels }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    codes: number;
    ascii: string[];
    shown: string[];
    other: string;
    passthrough: string;
    blank: string[];
    labels: { [code: string]: string };
  };
  // ラベルは全部日本語（英字の符号が混じると、それ自体が読めない語になる）。
  expect(out.ascii, "日本語の理由に英字が残っている").toEqual([]);
  expect(out.codes).toBeGreaterThan(10);
  expect(out.shown.every((t) => typeof t === "string" && t.length > 0)).toBe(true);
  // 未知の値（上流が返す自由文）は「その他の問題」に寄せる。ただし日本語で書かれた
  // 説明を英語扱いで潰さない。
  expect(out.other).toBe("その他の問題");
  expect(out.passthrough).toContain("モデルの読み込みに失敗しました");
  // 値が欠けているときは「特定できなかった」と言う（空欄を出さない）。
  for (const label of out.blank) expect(label).toBe("原因を特定できませんでした");

  // 画面の文に識別子を混ぜないこと、識別子は属性で残すこと（原因追跡の要件）。
  expect(app).not.toContain("原因: ${semanticReason");
  expect(app).toContain("Recommender.semanticReasonJa(");
  expect(app).toContain('setAttribute("data-semantic-reason"');
  expect(app).toContain('removeAttribute("data-semantic-reason")');
  // 識別子を打ち忘れた符号が出ないか、ビルド成果物側も照合する（上のラベル表は人が
  // 写した表なので、実装が新しい符号を足したときにここで気づく）。
  const built = [
    { name: "app.js", text: app },
    { name: "publish.js", text: siteRuntime("publish.js") },
  ];
  const missing: string[] = [];
  for (const item of built) {
    const pattern = /(?:semanticReason|reason)\s*[:=]\s*"([^"]+)"/g;
    for (const match of item.text.matchAll(pattern)) {
      const code = match[1];
      if (/[\u3041-\u309f\u30a1-\u30ff\u4e00-\u9fff]/.test(code)) continue; // 日本語の注記はそのまま通す
      if (!Object.hasOwn(out.labels, code)) missing.push(`${code} (${item.name})`);
    }
  }
  expect(missing, "ラベルの無い失敗の識別子がある").toEqual([]);

  // 画面に出る語をてびきが説明していること。
  const guide = readFileSync(join(site, "index.html"), "utf8");
  expect(guide).toContain("意味検索が使えないとき");
  expect(guide).toContain("意味検索は利用不可");
});

it("会期でも並び替えられる（出張の計画は「いつ開かれるか」で見ることが多い・SPEC §7）", () => {
  /* 並び替えられたのは 残り・日時・会議・ランク の 4 列だけで、表示している「会期」の列は
   * 押せなかった（2026-09-23 実測: `SORTABLE_KEYS = ["rem", "date", "conf", "rank"]`）。
   * 出張の計画は「いつ開かれるか」順で見ることが多く、締切順では会期が飛び飛びになる
   * （既定画面 478 行を締切順で見たまま会期の昇順を数えると 707 箇所の逆転）。*/
  const app = siteRuntime();
  const cmp = jsFunction(app, "compareEventRows");
  const due = jsFunction(app, "dueShown");
  const group = jsFunction(app, "shouldGroupMonths");
  const script = [
    `const DUE_SRC = ${JSON.stringify(due)};`,
    `const CMP_SRC = ${JSON.stringify(cmp)};`,
    `const GROUP_SRC = ${JSON.stringify(group)};`,
    "const dueShown = new Function('return (' + DUE_SRC + ')')();",
    "const cmp = new Function('dueShown', 'return (' + CMP_SRC + ')')(dueShown);",
    "const groups = new Function('return (' + GROUP_SRC + ')')();",
    "const row = (name, event, due) => ({",
    "  title: name, tEvent: event ? Date.parse(event + 'T00:00:00Z') + 3 * 3600000 : Number.NaN,",
    "  t: due ? Date.parse(due + 'T15:00:00Z') : Number.NaN, tShown: due ? Date.parse(due + 'T15:00:00Z') : Number.NaN,",
    "});",
    "const rows = [row('a', '2026-10-01', '2026-05-01'), row('b', '2026-09-01', '2026-06-01'), row('c', '', '2026-04-01')];",
    "const asc = rows.slice().sort((x, y) => cmp(x, y, 1)).map((r) => r.title).join('');",
    "const desc = rows.slice().sort((x, y) => cmp(x, y, -1)).map((r) => r.title).join('');",
    // 会期が同じ行は締切の近い順に揃う（同日に複数開く研究会で並びが揺れない）。
    "const tied = [row('x', '2026-09-01', '2026-07-01'), row('y', '2026-09-01', '2026-03-01')]",
    "  .sort((p, q) => cmp(p, q, 1)).map((r) => r.title).join('');",
    "const groupingFor = (key) => groups({ sortKey: key, sortAsc: true, paper: false });",
    "console.log(JSON.stringify({ asc, desc, tied, groupEvent: groupingFor('event'), groupDate: groupingFor('date') }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    asc: string;
    desc: string;
    tied: string;
    groupEvent: boolean;
    groupDate: boolean;
  };
  // 会期が決まっている行は会期順。未確認は向きに関係なく末尾（画面で「未確認」と
  // 読める行が先頭に来る形を許さない）。
  expect(out.asc).toBe("bac");
  expect(out.desc).toBe("abc");
  expect(out.tied).toBe("yx");
  // 月のまとめ見出しは、締切の日付順をまとめるもの。会期順では出さない。
  expect(out.groupDate, "締切順の月のまとめまで消えている").toBe(true);
  expect(out.groupEvent, "会期順で締切月の見出しが出ている").toBe(false);

  // 入口が三つ（見出し・狭い画面のボタン・実装の鍵）そろっていること。1 つ欠けると
  // 押せない列になるか、押せない鍵を URL が受け付けることになる。
  expect(app).toContain('SORTABLE_KEYS = ["rem", "date", "event", "conf", "rank"]');
  const html = readFileSync(join(site, "index.html"), "utf8");
  expect(html).toContain('data-sort="event"');
  expect(
    (html.match(/data-sort="event"/g) || []).length,
    "見出しと並び替えバーの両方に入口が必要",
  ).toBe(2);
  expect(html).toContain("会期 ↕");
  // てびきが画面に出る語を説明していること。
  expect(html).toContain("会期</strong>の順は出張の計画に向きます");
  expect(html).toContain("昇順・降順のどちらでも<strong>末尾</strong>");
});

it("実データで会期順が並びとして成立している（未確認が末尾に固まる・SPEC §7）", () => {
  const app = siteRuntime();
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(
      `file://${join(site, "recommender.js")}`,
    )});`,
    `const CMP_SRC = ${JSON.stringify(jsFunction(app, "compareEventRows"))};`,
    `const DUE_SRC = ${JSON.stringify(jsFunction(app, "dueShown"))};`,
    "const fs = await import('node:fs');",
    "const data = JSON.parse(fs.readFileSync(process.env.DSH_SITE_DATA || '', 'utf8'));",
    "const dueShown = new Function('return (' + DUE_SRC + ')')();",
    "const cmp = new Function('dueShown', 'return (' + CMP_SRC + ')')(dueShown);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(data, now).filter((r) => (r.kind === 'abstract' || r.kind === 'paper') && r.t >= now && !r.ed.estimated);",
    "const known = rows.filter((r) => Number.isFinite(r.tEvent)).length;",
    "const sorted = rows.slice().sort((a, b) => cmp(a, b, 1));",
    "let bad = 0, seenUnknown = false, prev = -Infinity;",
    "for (const r of sorted) {",
    "  if (!Number.isFinite(r.tEvent)) { seenUnknown = true; continue; }",
    "  if (seenUnknown) bad++;",
    "  if (r.tEvent < prev) bad++;",
    "  if (r.tEvent > prev) prev = r.tEvent;",
    "}",
    // 並び替える前（既定の締切順）は同じ指標でどれくらい飛んでいるかも出す（空振りでないこと）。
    "let before = 0, prev2 = -Infinity;",
    "for (const r of rows) { if (!Number.isFinite(r.tEvent)) continue; if (r.tEvent < prev2) before++; if (r.tEvent > prev2) prev2 = r.tEvent; }",
    "console.log(JSON.stringify({ total: rows.length, known, unknown: rows.length - known, bad, before }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, DSH_SITE_DATA: join(site, "data.json") },
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    total: number;
    known: number;
    unknown: number;
    bad: number;
    before: number;
  };
  expect(out.total).toBeGreaterThan(100);
  // 会期が決まっている行と未確認の行、両方が実際に有ること（片だけなら検査が空振りする）。
  expect(out.known).toBeGreaterThan(100);
  expect(out.unknown).toBeGreaterThan(0);
  expect(out.bad, "会期順に並べても逆転か未確認の先頭混入がある").toBe(0);
  // 並べる前は飛んでいる（＝この並びが実際に効いている）。
  expect(out.before).toBeGreaterThan(0);
});

it("てびきのキーボード欄が同じ操作を二度書いていない（SPEC §7）", () => {
  /* 「キーボードで一覧を動かす」の説明で、`/`（検索欄へ飛ぶ）と `Esc` の説明が
   * 一続きの文章の中に二回あった（2026-09-23 実測: 「`/` で検索欄に飛び…（`Esc` は行の
   * 詳細を閉じるのにも使います）」と、同じ項の後ろの方に「`/` を押すと検索欄に飛び、
   * `Esc` で詳細を閉じます」）。読者は二つの文が同じ操作を指しているのか、別々の操作が
   * あるのかを確かめられない。同じ欄の中で同じ言い回しを繰り返さない。*/
  const html = readFileSync(join(site, "index.html"), "utf8");
  const at = html.indexOf("<dt>印刷</dt>");
  const kb = html.indexOf('<dt class="only-keyboard">キーボードで一覧を動かす</dt>');
  expect(kb, "キーボードの項が無くなった").toBeGreaterThan(-1);
  const block = html.slice(kb, html.indexOf("</div>", kb));
  for (const phrase of ["検索欄に飛び", "行の詳細を閉じる"]) {
    const hits = block.split(phrase).length - 1;
    expect(hits, `「${phrase}」の説明が同じ項に ${hits} 回ある`).toBe(1);
  }
  // 印刷の項は、並び順が紙に残ることを説明している（第 127 回）。
  expect(at, "印刷の項が無くなった").toBeGreaterThan(-1);
  const print = html.slice(at, html.indexOf("</dd>", at));
  expect(print).toContain("並び順");
});

it("古いデータを開いた人に、生成から経った日数を伝える（SPEC §7）", () => {
  /* 更新は日次の運用（`.github/workflows/update-data.yml` の cron: 17 20 * * *）。
   * それが止まっているとき、画面は「データ生成: 2026-08-09(日) 09:00 JST」と出すだけで、
   * それが何日前なのかも言わなかった（2026-09-23 実測: ヘッダーの文字列は生成時刻だけ）。
   * 締切のサイトで古い一覧を最新と誤って使い、投稿の機会を逃すのが一番悪い失敗。 */
  const rec = join(site, "recommender.js");
  const app = siteRuntime();
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    "const gen = Date.parse('2026-08-09T00:00:00Z');",
    "const DAY = 86400000;",
    "const at = (days) => new Date(gen + days * DAY).toISOString();",
    // 生成時刻は固定し、閲覧側の現在時刻だけを動かす（生成時刻もずらすと経過年数が 0 になる）。
    "const note = (days) => Recommender.dataAgeNoteJa(at(0), gen + days * DAY);",
    "const cases = [0.1, 1, 2, 3, 5, 11].map((d) => [d, note(d)]);",
    // 生成より過去（閲覧側の時計がずれている）で警告を出さない。
    "const past = Recommender.dataAgeNoteJa(at(0), gen - DAY);",
    // 生成時刻が読めない値のときは空（別経路で「未確認」と出るので二重に言わない）。
    "const broken = ['', '未取得', undefined, null].map((v) => Recommender.dataAgeNoteJa(v, gen));",
    "const noNow = Recommender.dataAgeNoteJa(at(30), Number.NaN);",
    "console.log(JSON.stringify({",
    "  threshold: Recommender.dataStaleDaysJa,",
    "  silentBelow: cases.filter(([d]) => d < 3).every(([, t]) => t === ''),",
    "  firedAt3: cases.find(([d]) => d === 3)[1],",
    "  firedAt11: cases.find(([d]) => d === 11)[1],",
    "  at0: cases.find(([d]) => d === 0.1)[1],",
    "  past, broken, noNow,",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    threshold: number;
    silentBelow: boolean;
    firedAt3: string;
    firedAt11: string;
    at0: string;
    past: string;
    broken: string[];
    noNow: string;
  };
  // 閾値はてびきと README に書いた値と同じ（書き写さず、実装の正本から取る）。
  expect(out.threshold).toBe(3);
  expect(out.at0).toBe("");
  expect(out.silentBelow, "閾値より前で警告が出ている").toBe(true);
  expect(out.firedAt3, "閾値の日で警告が出ていない").toContain(
    "データは 3 日前に生成されたものです",
  );
  // 日数は実際の経過日数を出す（「古い」の一言で済ませない）。
  expect(out.firedAt11).toContain("データは 11 日前");
  // 締切の推測ではなく、公式確認の依頼として締める。
  expect(out.firedAt3).toContain("公式サイトの募集要項");
  // 時計のズレ・読めない値で根拠の無い警告を出さない。
  expect(out.past).toBe("");
  expect(out.noNow).toBe("");
  for (const text of out.broken) expect(text).toBe("");

  // 実画面への配線（上の検査だけではヘッダーは何も変わらない）。
  expect(app).toContain("dataAgeNoteJa(DATA.generated_at, Date.now())");
  expect(app).toContain('"stale"');
  const html = readFileSync(join(site, "index.html"), "utf8");
  // 色だけに頼らず本文で言うが、視覚の目印も付ける。
  expect(html).toContain(".meta-info .stale");
  expect(
    html.slice(html.indexOf(".meta-info .stale"), html.indexOf(".meta-info .stale") + 200),
  ).toContain("var(--warn)");
  // てびきが画面に出る語を説明していること。
  expect(html).toContain("日次で更新する運用");
  expect(html).toContain("3 日以上");
});

it("常時受付の行の会期・開催地は「該当なし」と出す（SPEC §7）", () => {
  /* 「未確認」は kamiyobi が公式で裏を取れていないという意味だと、てびきが説明している。
   * 常時受付のジャーナル（tag: journal で締切なし）は会期も会場も存在しないのに、表・行の
   * 詳細ともに「未確認」と出していた（2026-09-23 実測: 実データ 22 行が 未確認 扱い。
   * ラベルは 0 件にならない）。読者は公式の発表を待つ情報だと誤り、発表を待ってしまう。*/
  const rec = join(site, "recommender.js");
  const app = siteRuntime();
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    // `node -e` のソースは require とトップレベル await を同時に持てない（AGENTS.md）。
    "const { readFileSync } = await import('node:fs');",
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const deadlines = Recommender.candidateRows(DATA, now);",
    "const journals = Recommender.journalRows(DATA.conferences, now);",
    "const yes = (rows) => rows.filter((r) => Recommender.fieldNotApplicableJa(r)).length;",
    // 壊れた行（null など）で落ちないこと。
    "const broken = [null, undefined, {}, { kind: 'paper' }].map((v) => Recommender.fieldNotApplicableJa(v));",
    // 画面に出る語は検索でも引ける（他の状態の語と同じ約束）。
    "const m = Recommender.searchMatcher('該当なし', now);",
    "const found = deadlines.concat(journals).filter((r) => m(r.hay)).length;",
    "console.log(JSON.stringify({",
    "  na: Recommender.notApplicableLabelJa(),",
    "  unconfirmed: Recommender.unconfirmedLabelJa(),",
    "  journalRows: journals.length,",
    "  journalYes: yes(journals),",
    "  deadlineYes: yes(deadlines),",
    "  deadlineTotal: deadlines.length,",
    // 「未確認」の出番が残っていることも見る（置き換えてしまったら検査が無意味になる）。
    "  unknownEvent: deadlines.filter((r) => !r.ed.event_start).length,",
    "  titles: [Recommender.notApplicableTitleJa('event'), Recommender.notApplicableTitleJa('place'), Recommender.notApplicableTitleJa('rank')],",
    "  broken,",
    "  found,",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    na: string;
    unconfirmed: string;
    journalRows: number;
    journalYes: number;
    deadlineYes: number;
    deadlineTotal: number;
    unknownEvent: number;
    titles: string[];
    broken: boolean[];
    found: number;
  };
  expect(out.na).toBe("該当なし");
  // 「未確認」とは別の語であることが検査の意味（同じ語なら区別できない）。
  expect(out.na).not.toBe(out.unconfirmed);
  expect(out.journalRows, "常時受付の行が実データに無い").toBeGreaterThan(0);
  expect(out.journalYes, "常時受付の行が「該当なし」になっていない").toBe(out.journalRows);
  // 締切行では出さない（誤って「該当なし」にすると、確認待ちの情報を消してしまう）。
  expect(out.deadlineYes, "締切行に「該当なし」が出ている").toBe(0);
  expect(out.deadlineYes).toBeLessThan(out.deadlineTotal);
  expect(out.unknownEvent, "「未確認」を出す行が消えて検査が無意味になっている").toBeGreaterThan(0);
  // 理由を title に書く。知らない欄には空を返す（でたらめな理由を書かない）。
  expect(out.titles[0]).toContain("会期");
  expect(out.titles[1]).toContain("開催地");
  expect(out.titles[2]).toBe("");
  for (const v of out.broken) expect(v).toBe(false);
  expect(out.found, "画面に出す語が検索で引けない").toBe(out.journalRows);

  // 実画面への配線（表と行の詳細の両方）。
  expect(app).toContain("Recommender.notApplicableLabelJa()");
  expect(app).toContain('notApplicableTitleJa("event")');
  expect(app).toContain('notApplicableTitleJa("place")');
  const guide = readFileSync(join(site, "index.html"), "utf8");
  // てびきが「未確認」との区別を説明していること。
  const at = guide.indexOf("<dt>未確認</dt>");
  expect(at, "未確認の説明が無くなった").toBeGreaterThan(-1);
  const entry = guide.slice(at, guide.indexOf("</dd>", at));
  expect(entry).toContain("該当なし");
  expect(entry).toContain("常時受付");
});

it("upcoming.md は、表のうえで列の意味が分かる（SPEC §7）", async () => {
  /* この表は `index.html` と違い、条件欄もてびきもない単体のファイルとして読まれる
   * （チャットに貼る・grep する・他ツールに食わせる）。ところが列の見出しが
   * `| 日付 | 残り | 会議 | 種別 | R | 推定 | 開催地 |` で、**「R」が何なのか表のどこにも
   * 書いていなかった**（2026-09-23 実測: 値は `R1`・`R2`・`-`。会期行の「残り」が
   * 「本日開催」「開催中(残り1日)」になることも、種別「開催」が締切でないことも、
   * 表のうえでは説明が無かった）。 */
  const confs = [
    makeConference({
      key: "run",
      title: "RUN",
      categories: ["hpc"],
      sources: ["local"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "run26",
          source: "local",
          event_start: utc(2026, 8, 7),
          event_end: utc(2026, 8, 11),
          deadlines: [makeDeadline("paper", "Paper submission", utc(2026, 8, 20), "AoE", 2)],
        }),
      ],
    }),
  ];
  const outdir = mkdtempSync(join(tmpdir(), "cfp-md-legend-"));
  await buildAll(confs, { categories: { hpc: "HPC" } }, outdir, NOW, { noEmbeddings: true });
  const text = readFileSync(join(outdir, "upcoming.md"), "utf8");
  const lines = text.split("\n");
  const headerAt = lines.findIndex((line) => line.startsWith("| 日付 |"));
  expect(headerAt, "表の見出し行が無い").toBeGreaterThan(-1);
  const above = lines.slice(0, headerAt).join("\n");
  const cells = lines[headerAt]
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  // 一文字だけの見出しは、単体で開いた人に読めない（`R` が通ると検査が空振りする）。
  for (const cell of cells) {
    expect(/^[A-Za-z]$/.test(cell), `読み替えないと分からない見出し「${cell}」`).toBe(false);
  }
  // 見出しはサイトと同じ語（一覧の列名は「ラウンド」）。
  expect(cells).toContain("ラウンド");
  expect(above, "列の意味を表のうえで説明していない").toContain("列の意味");
  // 実際に画面（表）に出る語で説明する – 略語の説明だけで分からないようにする。
  for (const word of ["ラウンド", "残り", "推定", "本日開催", "開催中"]) {
    expect(above, `列の意味のうち「${word}」を説明していない`).toContain(word);
  }
  // 種別「開催」は締切ではないことを書く（締切表だと信じて読む人を誤らせない）。
  expect(above).toContain("会期そのもの");
  // 列の数と見出しは常に揃う（列が増えて説明が漏れた日に気づけるようにする）。
  const sep = lines[headerAt + 1];
  expect(sep.split("|").slice(1, -1).length).toBe(cells.length);
});

it("CSV の状態の列に、画面の「未確認」「該当なし」を残す（SPEC §7）", () => {
  /* 一覧のセルは空欄を作らないので「未確認」「該当なし」と書く（第 129 回で「該当なし」を
   * 分けた）。ところが CSV に書き出すと、値の列（会期・開催地・ランク）が空になるだけで、
   * その状態は消えていた（2026-09-23 実測: 会期が未知の締切行で状態・会期・開催地の各列が
   * すべて空。常時受付の行も、画面は「該当なし」と読むのに CSV では同じ空欄）。
   * 表計算に持ち出した人は「収録が無いのか、まだ確認できていないのか」を区別できない。 */
  const rec = join(site, "recommender.js");
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    "const { readFileSync } = await import('node:fs');",
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const deadlines = Recommender.candidateRows(DATA, now);",
    "const journals = Recommender.journalRows(DATA.conferences, now);",
    "const fields = (rows) => rows.filter((r) => Recommender.unconfirmedFieldsJa(r).length);",
    // 条件（行の値）から期待する件数をその場で作る（数字を書き写さない）。
    "const unknownEvent = deadlines.filter((r) => !String(r.ed.event_start || '').trim());",
    "const withTerm = unknownEvent.filter((r) => Recommender.unconfirmedFieldsJa(r).includes('会期未確認'));",
    "const journalNa = journals.filter((r) => Recommender.unconfirmedFieldsJa(r).includes('会期該当なし'));",
    "const journalUnconfirmed = journals.filter((r) => Recommender.unconfirmedFieldsJa(r).includes('会期未確認'));",
    // ランクは常時受付にも付き得るので「該当なし」にはならない。
    "const journalNaRank = journals.filter((r) => Recommender.unconfirmedFieldsJa(r).includes('ランク該当なし'));",
    // CSV の実物を読む（列名で見出しから洗う）。
    "const parse = (line) => {",
    "  const out = [];",
    "  let cur = '';",
    "  let quoted = false;",
    "  for (let i = 0; i < line.length; i++) {",
    "    const ch = line[i];",
    "    if (ch === '\"') {",
    "      if (quoted && line[i + 1] === '\"') {",
    "        cur += '\"';",
    "        i++;",
    "      } else {",
    "        quoted = !quoted;",
    "      }",
    "    } else if (ch === ',' && !quoted) {",
    "      out.push(cur);",
    "      cur = '';",
    "    } else {",
    "      cur += ch;",
    "    }",
    "  }",
    "  out.push(cur);",
    "  return out;",
    "};",
    "const csv = Recommender.deadlinesToCsv(unknownEvent.slice(0, 5).concat(journals.slice(0, 5)), now);",
    // 改行は CRLF の可能性があるので両方受ける。
    "const lines = csv.split(/\\r?\\n/);",
    "const cols = parse(lines[0].replace(/^\\\\uFEFF/, ''));",
    "const at = (name) => cols.indexOf(name);",
    "const rows = lines.slice(1).filter(Boolean).map(parse);",
    "console.log(JSON.stringify({",
    "  headers: cols,",
    "  unknownEvent: unknownEvent.length,",
    "  withTerm: withTerm.length,",
    "  fieldsOfUnknown: Recommender.unconfirmedFieldsJa(unknownEvent[0]),",
    "  journalRows: journals.length,",
    "  journalNa: journalNa.length,",
    "  journalUnconfirmed: journalUnconfirmed.length,",
    "  journalNaRank: journalNaRank.length,",
    "  statusCells: rows.map((r) => [r[at('種別')], r[at('会期')], r[at('状態')]]),",
    "  broken: [null, undefined, {}].map((v) => Recommender.unconfirmedFieldsJa(v).length > 0),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    headers: string[];
    unknownEvent: number;
    withTerm: number;
    fieldsOfUnknown: string[];
    journalRows: number;
    journalNa: number;
    journalUnconfirmed: number;
    journalNaRank: number;
    statusCells: string[][];
    broken: boolean[];
  };
  // 状態の列は元からある（列を増やさず、この列が区別を引き受ける）。
  expect(out.headers).toContain("状態");
  expect(out.headers).toContain("会期");
  expect(out.unknownEvent, "会期が未知の行が実データに無い").toBeGreaterThan(0);
  expect(out.withTerm, "画面が「未確認」と出す行が CSV で区別できない").toBe(out.unknownEvent);
  expect(out.fieldsOfUnknown).toContain("会期未確認");
  expect(out.journalRows).toBeGreaterThan(0);
  expect(out.journalNa, "常時受付の行が「該当なし」として出ていない").toBe(out.journalRows);
  // 第 129 回の区別が書き出し後も保つか（確認待ちと混ざらない）。
  expect(out.journalUnconfirmed, "常時受付の行が「未確認」に化けている").toBe(0);
  expect(out.journalNaRank, "ランクを「該当なし」にしている").toBe(0);
  // CSV の実物: 状態の列に語があり、値の列は空のまま。
  const deadlineCells = out.statusCells.filter((c) => c[0] !== "常時受付");
  expect(deadlineCells.length).toBeGreaterThan(0);
  for (const [, eventCell, status] of deadlineCells) {
    expect(eventCell, "値の列まで語で埋めた（空のままが正しい）").toBe("");
    expect(status).toContain("会期未確認");
  }
  const journalCells = out.statusCells.filter((c) => c[0] === "常時受付");
  expect(journalCells.length).toBeGreaterThan(0);
  for (const [, , status] of journalCells) {
    expect(status).toContain("会期該当なし");
    // 「ランク未確認」は有り得るので、会期・開催地が確認待ちに化けていないことを見る。
    expect(status).not.toContain("会期未確認");
    expect(status).not.toContain("開催地未確認");
  }
  // 壊れた行で落ちない（値が無い行は未確認として扱う）。
  for (const ok of out.broken) expect(ok).toBe(true);
  // てびきが状態の列の説明を持っている（画面に出る語をてびきが説明する約束）。
  const guide = readFileSync(join(site, "index.html"), "utf8");
  const at = guide.indexOf("<dt>CSV</dt>");
  expect(at, "CSV の項が無くなった").toBeGreaterThan(-1);
  const entry = guide.slice(at, guide.indexOf("</dd>", at));
  expect(entry).toContain("状態");
  expect(entry).toContain("該当なし");
});

it("CSV の状態の列に書いた語は、そのまま検索で引ける（SPEC §7）", () => {
  /* 第 133 回で CSV の状態の列に「会期未確認」「会期該当なし」を書けるようにした。
   * ここで問題になるのが、その語を画面の検索欄に打ったとき – 検索語（行の `hay`）に
   * 同じ語が無ければ「CSV に載っていたのに 0 件」になる（画面に出る語は検索でも引ける、
   * という SPEC §2 の約束）。実測で常時受付の行は `会期該当なし` が 0 件、
   * `ランク未確認` も 0 件だった（画面のセルには出ているのに）。 */
  const rec = join(site, "recommender.js");
  // 検索語も CSV も recommender の側で作るので、組み立てが一箇所かはそちらを見る。
  const recSrc = siteRuntime("recommender.js");
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    "const { readFileSync } = await import('node:fs');",
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const deadlines = Recommender.candidateRows(DATA, now);",
    "const journals = Recommender.journalRows(DATA.conferences, now);",
    "const parse = (line) => {",
    "  const out = [];",
    "  let cur = '';",
    "  let quoted = false;",
    "  for (let i = 0; i < line.length; i++) {",
    "    const ch = line[i];",
    "    if (ch === '\"') {",
    "      if (quoted && line[i + 1] === '\"') {",
    "        cur += '\"';",
    "        i++;",
    "      } else {",
    "        quoted = !quoted;",
    "      }",
    "    } else if (ch === ',' && !quoted) {",
    "      out.push(cur);",
    "      cur = '';",
    "    } else {",
    "      cur += ch;",
    "    }",
    "  }",
    "  out.push(cur);",
    "  return out;",
    "};",
    "const sample = deadlines.slice(0, 400).concat(deadlines.slice(-400)).concat(journals);",
    "const csv = Recommender.deadlinesToCsv(sample, now);",
    "const lines = csv.split(/\\r?\\n/).filter(Boolean);",
    "const cols = parse(lines[0].replace(/^\\\\uFEFF/, ''));",
    "const at = (name) => cols.indexOf(name);",
    // プロパティ: CSV の状態の列に書いた語は、その行の検索語に入っている。
    "const rows = [];",
    "const bad = [];",
    "let checked = 0;",
    "lines.slice(1).forEach((line, i) => {",
    "  if (!line.trim()) return;",
    "  const row = sample[i];",
    "  rows.push(row);",
    "  parse(line)[at('状態')].split('・').filter(Boolean).forEach((word) => {",
    "    checked += 1;",
    "    if (!Recommender.searchMatcher(word, now)(row.hay)) bad.push(word);",
    "  });",
    "});",
    "const hits = (word, rows) => rows.filter((r) => Recommender.searchMatcher(word, now)(r.hay)).length;",
    "const naJournals = journals.filter((r) => Recommender.unconfirmedFieldsJa(r).some((f) => f === '会期該当なし'));",
    "const unrankedJournals = journals.filter((r) => !(r.rankPairs || []).length);",
    "console.log(JSON.stringify({",
    "  checked,",
    "  bad: bad.slice(0, 5),",
    "  badCount: bad.length,",
    "  journalRows: journals.length,",
    "  naJournalRows: naJournals.length,",
    "  eventNa: hits('会期該当なし', journals),",
    "  eventNaInDeadlines: hits('会期未確認', journals),",
    "  eventUnconfirmed: hits('会期未確認', deadlines),",
    "  unconfirmedDeadlines: deadlines.filter((r) => !String(r.ed.event_start || '').trim()).length,",
    "  rankUnconfirmedJournals: hits('ランク未確認', journals),",
    "  unrankedJournals: unrankedJournals.length,",
    "  naInDeadlines: hits('該当なし', deadlines),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    checked: number;
    bad: string[];
    badCount: number;
    journalRows: number;
    naJournalRows: number;
    eventNa: number;
    eventNaInDeadlines: number;
    eventUnconfirmed: number;
    unconfirmedDeadlines: number;
    rankUnconfirmedJournals: number;
    unrankedJournals: number;
    naInDeadlines: number;
  };
  // 検査が無意味にならないこと（状態の列が空ばかりなら何も見ていない）。
  expect(out.checked, "CSV の状態の列が空で、検査が空振りしている").toBeGreaterThan(50);
  expect(out.bad, `CSV に書いた語が引けない: ${out.bad.join(", ")}`).toEqual([]);
  // 常時受付の行は「該当なし」の語で引ける（第 129 回の語が検索にも残る）。
  expect(out.naJournalRows).toBeGreaterThan(0);
  expect(out.eventNa).toBe(out.naJournalRows);
  // 締切行と常時受付の行が混ざらない（逆も同じ）。
  expect(out.eventNaInDeadlines, "常時受付の行が「会期未確認」で引ける").toBe(0);
  expect(out.naInDeadlines, "締切行が「該当なし」で引ける").toBe(0);
  expect(out.eventUnconfirmed).toBe(out.unconfirmedDeadlines);
  // ランクが空の常時受付の行は、そのまま引ける。
  expect(out.rankUnconfirmedJournals).toBe(out.unrankedJournals);
  // 検索語の組み立ては一箇所（項目別の古い実装が残っていないことも見る）。
  expect(recSrc, "検索語の組み立てが二重実装になっている").not.toContain("unconfirmedSearchTerms");
  // 締切行と常時受付の行、両方の検索語が同じ関数から出ている。
  expect((recSrc.match(/unconfirmedHayJa\(/g) || []).length).toBeGreaterThanOrEqual(3);
});

it("ボタンを押した直後も快捷键が効く（SPEC §7）", () => {
  /* 完成した画面の `onKeydown` をビルド成果物から抜き出して動かした（2026-09-23 実測）。
   * 入力欄・選択欄・ボタン・編集できる欄ではすべてのキーを止める作りだったので、
   * **画面をクリックするたびに快捷键が死んでいた**: 「過去の締切も表示」のボタンを
   * クリックした直後、`/` は検索欄にフォーカスを移さず、`j` は行を動かさなかった
   * （飲み込まれることも無く無反応）。`j` / `k` を使う人はボタンを踏んだ直後である
   * ことが多いので、ボタンが本当に受け取るキー（Enter と Space）だけ残して通す。 */
  const app = siteRuntime("app.js");
  const keyFn = jsFunction(app, "keyBlockedByTarget");
  const keydownFn = jsFunction(app, "onKeydown");
  expect(keyFn, "キーの振り分け関数が見当たらない（検査が空振り）").not.toBe("");
  expect(keydownFn, "onKeydown が見当たらない").not.toBe("");
  const script = [
    // 抜き出した 2 つの関数を、画面と同じ外部の値と一緒に作って動かす。
    "const fn = new Function(",
    "  '$',",
    "  'state',",
    "  'shown',",
    "  'selectedIndex',",
    "  'updateRowSelection',",
    "  'openDrawer',",
    "  'closeDrawer',",
    "  'safeExternalUrl',",
    "  'window',",
    "  " +
      JSON.stringify(
        `const ensureRowsDrawn = () => {};\n${keyFn}\n${keydownFn}\nreturn { onKeydown, keyBlockedByTarget };`,
      ) +
      ",",
    ");",
    "let moved = 0;",
    "let closed = 0;",
    "const log = [];",
    "const qEl = { tagName: 'INPUT', focus: () => log.push('検索欄にfocus'), blur: () => log.push('blur') };",
    "const made = fn(",
    "  () => qEl,",
    "  { mode: 'deadlines' },",
    // 選択行が末尾だと `j` は行を動かさない（画面と同じ）ので、3 行渡す。
    "  [{ ed: {}, conf: {} }, { ed: {}, conf: {} }, { ed: {}, conf: {} }],",
    "  0,",
    "  () => { moved += 1; log.push('行が動いた'); },",
    "  () => {},",
    "  () => { closed += 1; },",
    "  (x) => x,",
    "  { open: () => {}, matchMedia: () => ({ matches: false }) },",
    ");",
    "const run = (tag, key, inSearch) => {",
    "  log.length = 0;",
    "  moved = 0;",
    "  const target = inSearch ? qEl : { tagName: tag, blur: () => log.push('blur') };",
    "  let prevented = 0;",
    "  made.onKeydown({",
    "    target,",
    "    key,",
    "    preventDefault: () => {",
    "      prevented += 1;",
    "      log.push('飲み込み');",
    "    },",
    "  });",
    "  return { log: log.slice(), prevented };",
    "};",
    "const blocked = made.keyBlockedByTarget;",
    "console.log(JSON.stringify({",
    "  table: {",
    "    input: blocked('INPUT', 'j', false),",
    "    select: blocked('SELECT', 'j', false),",
    "    textarea: blocked('TEXTAREA', '/', false),",
    "    editable: blocked('BODY', 'j', true),",
    "    buttonEnter: blocked('BUTTON', 'Enter', false),",
    "    buttonSpace: blocked('BUTTON', ' ', false),",
    "    buttonJ: blocked('BUTTON', 'j', false),",
    "    buttonSlash: blocked('BUTTON', '/', false),",
    "    bodyJ: blocked('BODY', 'j', false),",
    "  },",
    "  buttonSlash: run('BUTTON', '/', false),",
    "  buttonJ: run('BUTTON', 'j', false),",
    "  buttonSpace: run('BUTTON', ' ', false),",
    "  buttonEnter: run('BUTTON', 'Enter', false),",
    "  textareaSlash: run('TEXTAREA', '/', false),",
    "  searchEscape: run('INPUT', 'Escape', true),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    table: { [k: string]: boolean };
    buttonSlash: { log: string[]; prevented: number };
    buttonJ: { log: string[]; prevented: number };
    buttonSpace: { log: string[]; prevented: number };
    buttonEnter: { log: string[]; prevented: number };
    textareaSlash: { log: string[]; prevented: number };
    searchEscape: { log: string[]; prevented: number };
  };
  // 欄ではすべてのキーを欄に渡す（論文の本文に `/` が打てるようにする）。
  expect(out.table.input).toBe(true);
  expect(out.table.select).toBe(true);
  expect(out.table.textarea).toBe(true);
  expect(out.table.editable).toBe(true);
  // ボタンが本当に受け取るキーだけボタンに残す。
  expect(out.table.buttonEnter, "ボタンの Enter をショートカットに取った").toBe(true);
  expect(out.table.buttonSpace, "ボタンの Space をショートカットに取った").toBe(true);
  // 他はショートカットに渡す（ここが直しどころ）。
  expect(out.table.buttonJ, "ボタン押下後に j が死んでいる").toBe(false);
  expect(out.table.buttonSlash, "ボタン押下後に / が死んでいる").toBe(false);
  expect(out.table.bodyJ).toBe(false);
  // 実際に `onKeydown` を通しても同じ（`/` が検索欄へ飛び、`j` が行を動かす）。
  expect(out.buttonSlash.log).toContain("検索欄にfocus");
  expect(out.buttonJ.log).toContain("行が動いた");
  expect(out.buttonSpace.prevented, "ボタンの Space を飲み込んだ").toBe(0);
  expect(out.buttonEnter.prevented, "ボタンの Enter を飲み込んだ").toBe(0);
  expect(out.textareaSlash.prevented, "論文欄の / をショートカットに取った").toBe(0);
  // 検索欄での Esc は従来のまま（欄を出て、選んでいた行に返す）。
  expect(out.searchEscape.log).toContain("blur");
  expect(out.searchEscape.log).toContain("行が動いた");
  // てびきが同じ約束を書いているか（画面の挙動と案内をズレさせない）。
  const html = readFileSync(join(site, "index.html"), "utf8");
  const at = html.indexOf('<dt class="only-keyboard">キーボードで一覧を動かす</dt>');
  expect(at, "キーボードの項が無くなった").toBeGreaterThan(-1);
  expect(html.slice(at, html.indexOf("</dd>", at))).toContain("ボタンを押した直後も");
});

it("0 件の案内が、各条件で今何行が隠れているかを並べて書く（SPEC §7）", () => {
  /* 0 件の画面は「外せる条件」を実名で並べる（第 66 回以降で整えてきた）。しかし条件の
   * 名前だけが並び、6 項目のどれから外す価値があるかは書かれていなかった（2026-09-23 実測:
   * 窓を 7 日・評価を A* に絞った 0 件画面の案内は「外せる条件: …」の羅列だけ）。
   * 同じ画面上の件数欄は、同じ条件で消えた行数を内訳として書いているので、その数字を
   * 項目に添って、案内と件数欄が同じ行の話をするようにする。 */
  const app = siteRuntime("app.js");
  const hintFn = jsFunction(app, "emptyDeadlineHint");
  expect(hintFn, "0 件案内の関数が見当たらない（検査が空振り）").not.toBe("");
  const script = [
    `const countJa = (${jsFunction(app, "countJa")});`,
    "const KIND_ALL_LABEL_JA = 'すべての種別';",
    `${hintFn.replace("function emptyDeadlineHint", "const emptyDeadlineHint = function")}`,
    "const base = {",
    "  window: '7d',",
    "  past: false,",
    "  cats: 2,",
    "  domestic: true,",
    "  online: true,",
    "  rank: 'A*',",
    "  kind: 'paper',",
    "  est: false,",
    "  query: '',",
    "  hiddenKindWords: [],",
    "  queryMatch: { catalog: 0, journal: 0 },",
    "  termCounts: [],",
    "  catalogConferences: 40,",
    "};",
    "const counted = emptyDeadlineHint({",
    "  ...base,",
    "  hidden: {",
    "    window: 438,",
    "    past: 1231,",
    "    est: 134,",
    "    rank: 416,",
    "    cats: 88,",
    "    domestic: 61,",
    "    online: 462,",
    "    kind: 900,",
    "  },",
    "});",
    // どの条件も行を隠していないとき、外し直しの案内を並べても打ち直しが増えるだけ。
    "const plain = emptyDeadlineHint({ ...base, hidden: {} });",
    "const noData = emptyDeadlineHint({ ...base, catalogConferences: 0, hidden: { past: 5 } });",
    // 外していない条件の数字は書かない（窓を「かまわない」にしているのに
    // 「締切まで」の項目を並べないのと同じ扱い）。
    "const allWindow = emptyDeadlineHint({",
    "  ...base,",
    "  window: 'all',",
    "  hidden: { window: 9999, past: 3 },",
    "});",
    "console.log(JSON.stringify({ counted, plain, noData, allWindow }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    counted: string;
    plain: string;
    noData: string;
    allWindow: string;
  };
  // 各項目に、件数欄と同じ名前で同じ数字が添わる。
  expect(out.counted).toContain("「締切まで 7 日以内」を超える 438 件");
  expect(out.counted).toContain("「過去の締切も表示」をオン（過去の締切 1,231 件）");
  expect(out.counted).toContain("「推定締切を含める」をオン（推定 134 件）");
  expect(out.counted).toContain("評価「A*」を持たない行 416 件");
  expect(out.counted).toContain("選んだ分野を持たない行 88 件");
  expect(out.counted).toContain("国内研究会・国内シンポジウム以外 61 件");
  expect(out.counted).toContain("オンライン参加の記載がない 462 件");
  expect(out.counted).toContain("投稿締切以外の種別 900 件");
  // どの条件も行を隠していないなら、外し直しの案内を並べない（打ち直しが増えるだけ）。
  // 「（ 0 件）」を出すのは画面の噓にもなる。
  expect(out.plain).not.toContain("件）");
  expect(out.plain).not.toContain("過去の締切も表示");
  expect(out.plain).not.toContain("推定締切を含める");
  // データその物が無いときの文は条件の話に埋もれない（先にそれを言う）。
  expect(out.noData).toContain("締切のデータが入っていません");
  expect(out.noData).not.toContain("過去の締切");
  // 隠している行数が 0 の条件を勧めない（窓を外し切っているのに「締切まで」を出さない）。
  expect(out.allWindow).not.toContain("9999");
  expect(out.allWindow).not.toContain("締切まで");
  expect(out.allWindow).toContain("過去の締切 3 件");
  // 呼び出し側が内訳を渡していること（渡さなければ上の数字は永遠に 0 のまま）。
  expect(app).toContain("hidden: hiddenDeadlineCounts()");
  expect(app).toContain("est: state.est");
});

it("行をまたぐ見出しの列数と、外せる条件の数え上げを実際の列と揃える（SPEC §7）", () => {
  /* 月見出し・過ぎた締切の見出し・行の詳細は `colSpan` で列をまたぐ。以前は 7 を
   * 3 箇所に直書きしていた（2026-09-23 実測: `colSpan = 7` がビルド成果物に 3 件）。
   * 列を増やした日に見出しの跨ぎが足りなくなると、画面では見出しの右に列が余って
   * 「表示が欠けた」ように見え、支援技術では見出しが列に紐づかない。同じ数は
   * 表の見出し（`site/template.html`）と行のラベル（`data-label`）にも出ていたので、
   * 三者が本当に同じかを検査で結ぶ。 */
  const app = siteRuntime("app.js");
  const html = readFileSync(join(site, "index.html"), "utf8");
  const headAt = html.indexOf("<thead>");
  expect(headAt, "表の見出しが見当たらない").toBeGreaterThan(-1);
  const head = html.slice(headAt, html.indexOf("</thead>", headAt));
  // `<thead>` を抓わないように `<th\b` にし、閉じタグを書く列（種別・開催地）も取る。
  const headerLabels = [...head.matchAll(/<th\b[^>]*>([^<\n]*)/g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  expect(headerLabels.length, "見出しの列が読めない").toBeGreaterThan(4);
  // 行側も同じ数のラベルを持っている（カード化ではこの語が列名になる）。
  const cellLabels = [...app.matchAll(/td\(tr, "([^"]+)"(?:, "[^"]*")?\)/g)].map((m) => m[1]);
  expect(cellLabels.length, "行のラベルが読めない").toBe(headerLabels.length);
  expect([...new Set(cellLabels)].length, "行のラベルが重複している").toBe(cellLabels.length);
  // 跨ぎの列数は 1 箇所に寄せてある（直書きに戻ると、列を変えた日に静かに壊れる）。
  expect((app.match(/colSpan = 7/g) || []).length, "列数の直書きが残っている").toBe(0);
  const tableColumns = /const TABLE_COLUMNS_JA = (\d+);/.exec(app);
  expect(tableColumns, "列数の定数が見当たらない").not.toBeNull();
  expect(Number(tableColumns?.[1]), "列数の定数が見出しと違う").toBe(headerLabels.length);

  /* 「条件をまとめて外す」が出る条件の数え上げに、推定が入っていない状態を見る。
   * 0 件案内（第 136 回）は推定を「外せる条件」として並べるので、同じ数え上げに
   * していないと、案内は外せるというのにボタンは出ない。 */
  const clearFn = jsFunction(app, "filtersClearable");
  expect(clearFn, "filtersClearable が見当たらない").not.toBe("");
  const script = [
    // 抜き出した関数ソースは文字列ではなく式としてそのまま入れる（JSON.stringify すると
    // 関数ではなく文字列になり、`f is not a function` になる）。
    "const f = (" + clearFn + ");",
    "const clear = {",
    "  window: 'all',",
    "  cats: 0,",
    "  domestic: false,",
    "  online: false,",
    "  rank: 'all',",
    "  kind: '',",
    "  est: false,",
    "  query: '',",
    "};",
    "console.log(JSON.stringify({",
    "  nothing: f(clear),",
    "  estOnly: f({ ...clear, est: true }),",
    "  kindOnly: f({ ...clear, kind: 'paper' }),",
    "  windowOnly: f({ ...clear, window: '7d' }),",
    "  rankOnly: f({ ...clear, rank: 'A*' }),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as { [k: string]: boolean };
  expect(out.nothing, "条件を一切掛けていないのに外せることになる").toBeFalsy();
  expect(out.kindOnly).toBeTruthy();
  expect(out.windowOnly).toBeTruthy();
  expect(out.rankOnly).toBeTruthy();
  expect(out.estOnly, "推定だけを外せない（0 件案内は外せる条件に並べる）").toBeTruthy();
});

it("投稿先を探すモードの一致評価の語を、画面で説明している語に限定する（SPEC §7）", () => {
  /* カードの chips は `一致評価 <語> ▾` と出す。以前は「情報不足」がほぼ全ての行に出て、
   * 論文を最後まで入力しても同じだった（2026-09-23 実測: 画面に出る 25 件のうち 23 件、
   * 意味検索の得点を_synthetic に足しても 122 件のうち 120 件）。
   * 「論文の情報が足りない」と読める語が常に出るため、実際に測った人が入力をやめる
   * 恐れがあった。ここは (a) 常に出る語を画面で説明しているか、(b) 説明文が無い語を
   * 出していないか、を検査する（ラベルは実装から取り、テストに書き写さない）。 */
  const script = [
    "import fs from 'node:fs';",
    `import Recommender from ${JSON.stringify("file://" + join(site, "recommender.js"))};`,
    "const R = Recommender;",
    `const DATA = JSON.parse(fs.readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const NOW = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = R.candidateRows(DATA, NOW);",
    "const papers = [",
    "  'タイトル: 分散 GPU 学習の通信最適化',",
    "  'タイトル: ゼロコピー転送を用いた分散 GPU 学習のための通信最適化\\n概要: RDMA と集合通信ライブラリの性能を計測し、学習反復あたり短縮を確認した。\\nキーワード: 分散学習 ネットワーク',",
    "];",
    "const labels = new Set();",
    "let shownRows = 0;",
    "let mostCommon = { label: '', count: 0 };",
    "const tally = {};",
    "for (const p of papers) {",
    "  const lines = R.parsePaperLines(p);",
    "  const scores = {};",
    "  for (const x of R.venueRecommendations(rows, lines, scores, NOW, { fieldedLexical: true })) {",
    "    labels.add(x.fit.label);",
    "    // 一覧に出る行だけを数える（しきい値は app.js の式から取る）。",
    "    if (x.fit.score >= 10) {",
    "      shownRows += 1;",
    "      tally[x.fit.label] = (tally[x.fit.label] || 0) + 1;",
    "    }",
    "  }",
    "}",
    "for (const [label, count] of Object.entries(tally)) if (count > mostCommon.count) mostCommon = { label, count };",
    "console.log(JSON.stringify({ labels: [...labels], shownRows, tally, mostCommon }));",
  ].join("\n");
  // Node 26 は `node -e` のソースを ESM として見るので、静的 import がそのまま使える。
  const proc = spawnSync("node", ["-e", script], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    labels: string[];
    shownRows: number;
    tally: { [k: string]: number };
    mostCommon: { label: string; count: number };
  };
  expect(out.shownRows, "推薦の行が 1 も出ず、検査が空振り").toBeGreaterThan(10);
  expect(out.labels.length, "ラベルが 1 種類しか出ず、検査が空振り").toBeGreaterThan(1);
  const html = readFileSync(join(site, "index.html"), "utf8");
  // 画面に出る語は、てびきで説明している語だけにする。
  for (const label of out.labels) {
    expect(html, `「${label}」が一覧に出るのに、画面のどこにも説明が無い`).toContain(label);
  }
  // 常に出る語は、説明文が「その語がほぼ全行に出る」ことを正直に書いている。
  const noteAt = html.indexOf(out.mostCommon.label);
  expect(noteAt).toBeGreaterThan(-1);
  const note = html.slice(Math.max(0, noteAt - 400), noteAt + 400);
  expect(note).toMatch(/実測|ほとんど/);
  // 以前の語は画面から消えている（論文を入力しても消えない警告に見えていた）。
  expect(html).not.toContain("情報不足");
});

it("内訳の項目に、足して読むように見える数字を出さない（SPEC §7）", () => {
  /* 推薦の行の内訳（`一致評価 … ▾` を押すと出る）は、以前 `+18` などの数字を並べていた。
   * しかしその数字は手作業で決めた信号重みで、**画面に出すスコアとは別の計算**だった
   * （2026-09-23 実測: 「一致スコア 65点」の行の内訳は +18 と +9 が並ぶだけで合計 27、
   * 63 点的な行は合計 21、59 点的な行は合計 57）。`+` 付きの数字は足して読むものに見え、
   * てびきも「どの要素でどれだけ合ったか」と書いていたため、画面の噓になっていた。
   * 内訳は「当たった要素」の名前だけを出し、スコアとの関係を明文化する。 */
  const app = siteRuntime("app.js");
  expect(app).toContain("この会議で当たった要素");
  /* 項目は名前だけ。以前は「ラベルの直後に + と値を繋ぐ古い形」だけを禁じていたため、
   * ラベルを先に書いて後ろへ足す書き方で数字が戻っていた（2026-08-09 実測: 内訳を持つ候補
   * 29 件すべてで内訳の和とスコアが違い、例はスコア 58 点 / 内訳の和 45、52 点 / 15）。
   * なので書き方に依存しない形で見る。内訳を出す 3 箇所の関数に、値を足す形が 1 つも
   * 入っていないこと（画面に出る語と数字の対応は、ここで決める）。 */
  const surfaces = ["makeRow", "makeDetailRow", "makeRecommendationCard"];
  for (const name of surfaces) {
    const body = jsFunction(app, name);
    expect(body.length, `${name} が見つからない（内訳の実装が消えた）`).toBeGreaterThan(0);
    expect(body, `${name} が内訳の項目に足し算に見える数字を出している`).not.toContain("+" + "${");
  }
  expect(app, "内訳に足し算に見える数字を残している").not.toContain('"+10"');
  const html = readFileSync(join(site, "index.html"), "utf8");
  // スコアと内訳の関係を書いておく（点を足した値だと誤解させない）。
  expect(html).toMatch(/スコア（点）はこの内訳を足した値ではありません/);

  /* 「数字を足すとスコアになる」が成立しないことの実測（直した理由の記録として残す。
   * 成立する日が来ても、項目は名前だけを出し続ける）。 */
  const script = [
    "import fs from 'node:fs';",
    `import Recommender from ${JSON.stringify("file://" + join(site, "recommender.js"))};`,
    "const R = Recommender;",
    `const DATA = JSON.parse(fs.readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const NOW = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = R.candidateRows(DATA, NOW);",
    "const lines = R.parsePaperLines(",
    "  'タイトル: ゼロコピー転送を用いた分散 GPU 学習のための通信最適化\\n概要: RDMA と集合通信ライブラリの性能を計測した。\\nキーワード: 分散学習 ネットワーク HPC',",
    ");",
    "const kept = R.venueRecommendations(rows, lines, {}, NOW, { fieldedLexical: true }).filter(",
    "  (x) => x.fit.score >= 10,",
    ");",
    "let checked = 0;",
    "let differs = 0;",
    "for (const x of kept) {",
    "  const agg = x.match.agg || {};",
    "  const sum = ['domain', 'name', 'paper', 'jp', 'tags'].reduce(",
    "    (s, k) => s + (agg[k] || 0),",
    "    0,",
    "  );",
    "  if (!sum) continue;",
    "  checked += 1;",
    "  if (sum !== x.fit.lexicalScore) differs += 1;",
    "}",
    "console.log(JSON.stringify({ checked, differs, shown: kept.length }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as { checked: number; differs: number; shown: number };
  expect(out.shown, "推薦の行が出ず、検査が空振り").toBeGreaterThan(5);
  expect(out.checked, "内訳の項目がある行が出ず、検査が空振り").toBeGreaterThan(5);
  // 内訳の重みの合計は、スコアと**ほとんどの行で一致しない**（足してスコアになるのでは
  // ない）。ここで「全行で一致しない」を主張するのは強すぎる。スコアはこれらの信号から
  // 計算されるので、低い点の行では重みの合計がたまたまスコアと同じ値になることがある
  // （2026-08-09 実測: 入力論文を日本語ラベルで書くと 1 論文として読めるようになり（第 168
  // 回）、推薦される行の組みが変わって 30 点の行が 1 件一致した）。利用者への実際の約束は
  // 上の変側（`+<数>` を作らない・てびきの「スコア（点）はこの内訳を足した値ではありません」）
  // が持っていて、ここは「合計＝スコアと読むのがほとんどの行で噓になる」の実測として残す。
  expect(out.differs, "内訳の合計がスコアと一致する行が過半（前提が変わった）").toBeGreaterThan(
    Math.floor(out.checked / 2),
  );
});

it("画面に出る文へ markdown の記号を混ぜない（SPEC §7）", () => {
  /* `site/template.html` に `**強調**` の形で書いた行が実際に有った（2026-09-23 実測:
   * 「残り」の項に `**日数は JST の暦日**` がそのまま画面に出ていた）。Markdown を書く
   * 癖が HTML に残っても検査が通っていたので、表示される本文だけを見て弾く。
   * CSS・スクリプト・HTML コメントの中は画面に出ないので見る必要がない。 */
  const html = readFileSync(join(site, "index.html"), "utf8");
  const visible = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // 要素に囲まれた文字（`<code>` の中も画面に出る）だけを見る。
    .replace(/<[^>]+>/g, " ");
  expect(visible, "画面に出る文に markdown の強調記号が残っている").not.toContain("**");
  /* バッククォートも同じ。てびきの本文中に `NSDI 2027` / `cryptography` / `Tokyo, 日本` の形で
   * 書いた行が実際に有った（2026-09-23 実測: 画面に記号がそのまま出ていた）。HTML では
   * `<code>` で囲むのがこの画面の書き方で、てびきの他の項目はそうなっている（第 143 回）。*/
  expect(visible, "画面に出る文に markdown の code 記号が残っている").not.toContain("`");
  expect(visible).not.toMatch(/__\S[^_]*__\s/);
  expect(visible).not.toMatch(/\[[^\]\n]{1,40}\]\([^)\n]{1,80}\)/);
  /* 吹き出し（`title`）も画面に出る文。折り返し形式の指定は効かず記号がそのまま出る
   * （2026-09-23 実測: 「 kamiyobi の内部表記では `N`」）。画面の語だけで書かせる。*/
  const app = siteRuntime("app.js");
  const titleDecl = (app.match(/RANK_UNRATED_TITLE_JA\s*=\s*"[^"]*"/) || [""])[0];
  expect(titleDecl, "「評価なし」の吹き出しが見つからない（検査が空振り）").not.toBe("");
  expect(titleDecl).not.toContain("`");
  expect(titleDecl, "画面に無い開発寄りの語を吹き出しに混ぜない").not.toContain("内部表記");
  const guide = visible;
  // 吹き出しが画面の語を使う限り、てびき側にもその語の説明が要る。
  for (const word of titleDecl.match(/「[^」]+」/g) || []) {
    expect(guide, `吹き出しの語 ${word} がてびきから引けない`).toContain(word);
  }
});

it("閉じたままのてびきの入口に、中身とズレた見出しを置かない（SPEC §7）", () => {
  /* 「見方のてびき」は `<details>` で畳んだまま開く。閉じた `<details>` の中はブラウザの
   * ページ内検索（Ctrl+F）で出てこない（WebKit の既知の制限:
   * https://bugs.webkit.org/show_bug.cgi?id=239940）。だから見出し（summary）だけが
   * 常に読める案内になっていて、そこにうたった語が中身に見当たらないと、
   * 「書いてあるはずなのに見つからない」で人が止まる。見出しの引用符の中の語を
   * そのままてびき本文と突き合わせる。
   * 併せて、開いた状態をリンクで引き継ぐ `?help=1` が画面の案内にもあることを見る。 */
  const html = readFileSync(join(site, "index.html"), "utf8");
  const headAt = html.indexOf("<summary>");
  expect(headAt, "てびきの見出しが見当たらない").toBeGreaterThan(-1);
  const summary = html.slice(headAt, html.indexOf("</summary>", headAt));
  const advertised = [...summary.matchAll(/「([^」]+)」/g)].map((m) => m[1]);
  expect(advertised.length, "てびきの見出しが語をうたっていない（検査が空振り）").toBeGreaterThan(
    2,
  );
  const guideStart = html.indexOf('<details class="help"');
  const guide = html.slice(guideStart, html.indexOf("</details>", guideStart));
  expect(guide.length, "てびきの本文が読めない").toBeGreaterThan(1000);
  for (const word of advertised) {
    expect(guide, `てびきの見出しが「${word}」とうたっているが、中にその語の説明が無い`).toContain(
      word,
    );
  }
  // 開いた状態を渡せることを、画面の案内も書く（知り合いにリンクで教えられる形に）。
  expect(guide).toContain("?help=1");
  // 読み書きが対でないと、開いて共有したリンクを受けた人の画面で畳まれている。
  const app = siteRuntime("app.js");
  expect(app).toContain('p.set("help", "1")');
  expect(app).toContain('p.get("help")');
});

it("0 件の読み上げが、画面に出ている案内の有無と緩められる条件の有無を正直に言う（SPEC §7）", () => {
  /* 0 件画面の下には「外せる条件」を並べるが、読み上げには短い理由だけを流していた
   * （2026-09-23 実測: 「 ｜ いまの条件では行がありません。条件を緩めると出ます」）。
   * 支援技術では下に出ている案内が見えないので、0 件とだけ聞いて操作をやめる人が出る。
   * 逆に、外せる条件が 1 つも残っていない画面で「緩めると出ます」と言うのは噓だった。 */
  const app = siteRuntime("app.js");
  const liveFn = jsFunction(app, "zeroResultLiveNote");
  expect(liveFn, "0 件の読み上げ文言が見当たらない（検査が空振り）").not.toBe("");
  const script = [
    // 抜き出した関数は式としてそのまま入れる（JSON.stringify すると文字列になる）。
    "const live = (" + liveFn + ");",
    "const base = {",
    "  hiddenKindWords: [],",
    "  termCounts: [],",
    "  queryMatch: { catalog: 0, journal: 0 },",
    "  catalogConferences: 40,",
    "  clearable: false,",
    "  pastShown: false,",
    "  hidden: {},",
    "};",
    "const run = (over) => live({ ...base, ...over });",
    "console.log(JSON.stringify({",
    "  // 窓で絞って 0 件（今日は実際に踏める形）。",
    "  windowed: run({ clearable: true, hidden: { window: 34 } }),",
    "  // 何も絞っていないのに 0 件で、過去の締切だけが出ない形。",
    "  onlyPast: run({ hidden: { past: 2317 } }),",
    "  // 過去も表示し終えて 0 件（緩める条件が残っていない）。",
    "  exhausted: run({ pastShown: true }),",
    "  noData: run({ catalogConferences: 0 }),",
    "  // 原因が特定できても、下に案内があることは同じように伝える。",
    "  hiddenKind: run({ hiddenKindWords: ['採否通知'], clearable: true, hidden: { kind: 603 } }),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as { [k: string]: string };
  // 下に出ている案内を指し示す（支援技術では下の塊が見えない）。
  expect(out.windowed).toContain("下に外せる条件も書いてあります");
  expect(out.hiddenKind).toContain("下に外せる条件も書いてあります");
  expect(out.hiddenKind).toContain("種別に当たります");
  // 括弧を二重に重ねない（読み上げで「（…）（…）」と続くのは聞こえない）。
  expect(out.hiddenKind).not.toContain("）（");
  // 緩められない画面で「緩めると出ます」と言わない。
  expect(out.exhausted).not.toMatch(/緩め|外せる条件/);
  expect(out.exhausted).toContain("収録にいま以降の締切");
  expect(out.onlyPast).toContain("収録の締切はすべて過ぎています");
  expect(out.onlyPast).toContain("過去の締切も表示");
  // データその物が無い話は、条件の話より先にそのまま出す（第 118 回以降の方針）。
  expect(out.noData).toContain("締切のデータが入っていません");
  // 呼び出し側が、0 件案内と同じ数え合わせを渡していること。
  expect(app).toContain("clearable: filtersClearable(");
  expect(app).toContain("pastShown: state.past");
});

it("画面の件数は 3 桁ごとに区切り、てびきの書き方と揃える（SPEC §7）", () => {
  /* 既定画面の件数欄は「478 件 / 全 3235 件」、0 件の案内は「過去の締切 2317 件」と出ていた
   * （2026-09-23 実測）。一方てびきは同じ数を「全 3,235 件」と書いていて、同じ数が画面と
   * 案内で二つの形になっていた。4 桁以上の数を素で出すと、表示件数と収録総数を見比べたとき
   * に桁の大きさが取り出しにくい。`toLocaleString` は環境で区切り文字が変わるので、
   * 区切りは自前で書く。 */
  const app = siteRuntime("app.js");
  const fnSrc = jsFunction(app, "countJa");
  expect(fnSrc, "件数の数え合わせの関数が見当たらない（検査が空振り）").not.toBe("");
  const script = [
    "const countJa = (" + fnSrc + ");",
    "console.log(JSON.stringify({",
    "  small: countJa(478),",
    "  edge999: countJa(999),",
    "  edge1000: countJa(1000),",
    "  pool: countJa(3235),",
    "  past: countJa(2317),",
    "  big: countJa(1234567),",
    "  negative: countJa(-5),",
    "  zero: countJa(0),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as { [k: string]: string };
  expect(got.small).toBe("478");
  expect(got.edge999).toBe("999");
  expect(got.edge1000, "4 桁目から区切れていない").toBe("1,000");
  expect(got.pool).toBe("3,235");
  expect(got.past).toBe("2,317");
  expect(got.big).toBe("1,234,567");
  // 残り日数などでも使うので、符号と区切りを壊さない。
  expect(got.negative).toBe("-5");
  expect(got.zero).toBe("0");
  // 1 箇所でも素の数値があると、その欄だけ区切りの無い数になる。
  const unwrapped = [...app.matchAll(/\$\{([^{}"]+)\} 件/g)].filter(
    (m) => !m[1].trim().startsWith("countJa("),
  );
  expect(
    unwrapped.map((m) => m[1]),
    "countJa を経ずに件数を出している個所がある",
  ).toEqual([]);
  // 案内側の書き方と実際の画面が同じであることを、実行した結果で結ぶ。
  const html = readFileSync(join(site, "index.html"), "utf8");
  expect(html).toContain(`全 ${got.pool} 件`);
  const guideCounts = [...html.matchAll(/([0-9][0-9,]{3,}) 件/g)].map((m) => m[1]);
  expect(guideCounts.length, "てびきに 4 桁以上の件数が出ていない（検査が空振り）").toBeGreaterThan(
    0,
  );
  for (const c of guideCounts) {
    expect(c, `てびきの「${c} 件」が画面の数え方と違う形になっている`).toMatch(
      /^[0-9]{1,3}(,[0-9]{3})*$/,
    );
  }
});

it("キー操作の案内は幅ではなく操作手段で出し、効いている画面から案内を消さない（SPEC §7）", () => {
  /* `j` / `k` / `d` / `/` の処理に幅の判定は無い（`onKeydown` に `innerWidth` 等の参照は
   * 無い）。ところが案内の方は 640px 未満という「幅」の条件で隠れていた（2026-09-23 実測:
   * パソコンの窓を左右に分割して狭くした人は、キーが効いているのに件数欄の案内とてびきの
   * 「キーボードで一覧を動かす」の項が消えた画面を開く）。タッチで狙う端末で隠すのが
   * 意図なので、操作手段（`pointer` / `hover`）で分ける。 */
  const html = readFileSync(join(site, "index.html"), "utf8");
  const css = (html.match(/<style>([\s\S]*?)<\/style>/) || ["", ""])[1];
  // コメントの中に条件らしい語を書いても誤読しないよう、実装と同じく先に落とす。
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: Array<{ query: string; body: string }> = [];
  const re = /@media[^{]*\{/g;
  for (let m = re.exec(noComments); m !== null; m = re.exec(noComments)) {
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < noComments.length && depth > 0) {
      if (noComments[j] === "{") depth += 1;
      else if (noComments[j] === "}") depth -= 1;
      j += 1;
    }
    blocks.push({
      query: m[0].slice(0, -1).replace(/\s+/g, " ").trim(),
      body: noComments.slice(m.index + m[0].length, j),
    });
  }
  expect(blocks.length, "@media の块が読めない（検査が空振り）").toBeGreaterThan(2);
  const selectors = [".count-kbd", ".only-keyboard"];
  for (const sel of selectors) {
    const hiding = blocks.filter((b) => b.body.includes(`${sel} {`) || b.body.includes(`${sel},`));
    expect(hiding.length, `${sel} を隠す規則が見当たらない（検査が空振り）`).toBeGreaterThan(0);
    for (const b of hiding) {
      expect(
        b.query,
        `${sel} を幅で隠している（狭い窓を開いた人から、効いているキーの案内が消える）`,
      ).toMatch(/\((pointer|hover)\s*:/);
    }
  }
  // キー処理その物に幅の判定が無いことも見る（案内だけ消える食い違いの根本）。
  const app = siteRuntime("app.js");
  const handler = jsFunction(app, "onKeydown");
  expect(handler, "キー処理本体が見当たらない（検査が空振り）").not.toBe("");
  expect(handler).not.toMatch(/innerWidth|clientWidth|offsetWidth|matchMedia/);
});

it("収録元の締切名は「原表記」と書いて、画面の種別と混ざらないようにする（SPEC §7）", () => {
  /* 種別欄の本筋は「概要締切」「論文締切」だが、その下に収録元がその締切に付けた名前を
   * 併記している。既定画面 478 行はすべて原表記を持ち、無印で並べていた（2026-09-23 実測:
   * 「Submission deadline」129 行、「Paper submission」56 行、「Submission」34 行で、国内分は
   * 「発表申込締切」など日本語）。印の無い別分類が同じ列に並んで見えたため、会期で既に
   * 使っている「原表記」の語をここでも使う。表と行の詳細で式を共有する（式が二つあると
   * 片方だけ直す – 第 128 回）。 */
  const app = siteRuntime("app.js");
  const fnSrc = jsFunction(app, "kindDetailJa");
  expect(fnSrc, "締切名の併記を作る関数が見当たらない（検査が空振り）").not.toBe("");
  const script = [
    "const kindDetailJa = (" + fnSrc + ");",
    "console.log(JSON.stringify({",
    "  roundAndLabel: kindDetailJa(2, 'Paper submission'),",
    "  firstRound: kindDetailJa(1, 'Submission deadline'),",
    "  japanese: kindDetailJa(null, '発表申込締切'),",
    "  blank: kindDetailJa(3, '   '),",
    "  nothing: kindDetailJa(null, null),",
    "  numericString: kindDetailJa('2', 'Abstract registration'),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as { [k: string]: string };
  expect(got.roundAndLabel).toBe("第 2 ラウンド / 原表記: Paper submission");
  // 第 1 ラウンドは旧来どおり書かない（毎行に付いて読みにくくなる）。
  expect(got.firstRound).toBe("原表記: Submission deadline");
  expect(got.japanese).toBe("原表記: 発表申込締切");
  expect(got.blank).toBe("第 3 ラウンド");
  expect(got.nothing).toBe("");
  expect(got.numericString, "数値が文字列で来るとラウンドが消える").toBe(
    "第 2 ラウンド / 原表記: Abstract registration",
  );
  // 表のセルと行の詳細が同じ式を使う（どちらかだけ直す変更を落ちるようにする）。
  expect((app.match(/kindDetailJa\(/g) || []).length, "併記の呼び出し箇所").toBe(3);
  expect(app).not.toMatch(/detail\.push\(\s*r\.dl\.label\s*\)/);
  // 画面に出る語として、てびきにも同じ語で書いてある。
  const html = readFileSync(join(site, "index.html"), "utf8");
  expect(html, "原表記という語がてびきから引けない").toContain("原表記:");
});

it("投稿先を探す画面で印刷すると、紙に出る但し書きが実際の内容と一致する（SPEC §7）", () => {
  /* 印刷物の但し書き（`#printMeta`）は表用の文言を常時書いていた。推薦画面では
   * `shown` が空になる（`render` の `shown = recMode && !recommendationData ? [] : filter()`）
   * ので、候補のカードが並んだ紙に「表示 0 件」と刷れていた（2026-09-23 実測）。
   * 紙が自分を噓をつく形なので、画面の実物（モードのボタン名）を使った文にする。 */
  const html = readFileSync(join(site, "index.html"), "utf8");
  // 画面のモード名は正本から取る（テスト側に書き写すと、呼び方が変わったときに気づけない）。
  const modeBtn = /id="modeRecommend"[^>]*>([^<]+)</.exec(html);
  expect(modeBtn, "モードの切替ボタンが見当たらない（検査が空振り）").not.toBeNull();
  const modeWord = String(modeBtn![1]).trim();
  expect(modeWord).not.toBe("");

  const app = siteRuntime("app.js");
  // 但し書きは `state` を直読みするので、モードごとに組み直して 2 回走らせる。
  const run = (mode: string, shownCount: number, cardCount: number) => {
    const body = [
      "function countJa(n) { const int = Math.trunc(Number(n) || 0); const d = String(Math.abs(int)).replace(/\\B(?=(\\d{3})+$)/g, ','); return int < 0 ? '-' + d : d; }",
      "const meta = { textContent: '' };",
      `const cards = { children: ${JSON.stringify(new Array(cardCount).fill(null).map(() => ({})))} };`,
      "const $ = (id) => (id === 'printMeta' ? meta : id === 'recommendationCards' ? cards : null);",
      "const valueElement = () => ({ options: [{ text: '30 日以内' }], selectedIndex: 0 });",
      "function describeFilters() { return '投稿締切（概要・論文）／締切まで 30 日以内'; }",
      "const fmtJst = () => '2026-08-09 (日) 09:00 JST';",
      "function generatedAtLabel(v) { return 'データ生成: ' + v; }",
      "const KIND_LABEL = { paper: '論文締切' };",
      // 語の正本はビルドした `recommender.js`。印刷の但し書きが使う語も本物から借りる
      // （検査に語を書き写すと、画面の語が変わっても気づけない）。
      `const { default: REAL } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
      "const Recommender = {",
      "  categoryLabelJa: (c) => c,",
      "  unconfirmedLabelJa: () => REAL.unconfirmedLabelJa(),",
      "  rankUnratedLabelJa: () => REAL.rankUnratedLabelJa(),",
      "  extendedLabelJa: () => REAL.extendedLabelJa(),",
      "  notApplicableLabelJa: () => REAL.notApplicableLabelJa(),",
      "};",
      "const DATA = { generated_at: '2026-08-09T09:00:00Z' };",
      "let sortKey = 'deadline', sortAsc = true, sortColumnLabel = '日時（JST）';",
      `let shown = ${JSON.stringify(new Array(shownCount).fill(null))};`,
      `let state = { mode: ${JSON.stringify(mode)}, win: '30d', kind: '', cats: [], rank: '', past: false };`,
      // 条件の書き下ろしに渡すラベル関数（この検査は describeFilters をスタブにするので
      // 呼ばれないが、名前だけは必要）。語の正本は注入済みの Recommender 側にある。
      jsFunction(app, "rankFilterLabelJa"),
      jsFunction(app, "printLegendJa"),
      jsFunction(app, "fillPrintMeta"),
      "fillPrintMeta();",
      "console.log(JSON.stringify({ out: meta.textContent }));",
    ].join("\n");
    const proc = spawnSync("node", ["-e", vmSafeSource(body)], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(proc.status, proc.stderr).toBe(0);
    return (JSON.parse(proc.stdout) as { out: string }).out;
  };
  const rec = run("recommend", 0, 3);
  expect(rec, "推薦画面の印刷物に表の件数が刷れている").not.toContain("表示 0 件");
  expect(rec).toContain(modeWord);
  expect(rec, "候補の数が紙に残っていない").toContain("候補 3 件");
  expect(rec).toContain("2026-08-09 (日) 09:00 JST");
  const recEmpty = run("recommend", 0, 0);
  expect(recEmpty).toContain("候補 0 件");
  const dl = run("deadlines", 10, 0);
  expect(dl).toContain("表示 10 件");
  expect(dl, "締切一覧の但し書きまで候補の語を出している").not.toContain("候補");

  // 紙に候補が残ること自体は従来どおり（印刷で隠している規則が無いこと）。
  const css = (html.match(/<style>([\s\S]*?)<\/style>/) || ["", ""])[1].replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const printBlocks: string[] = [];
  const re = /@media[^{]*\{/g;
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    const query = m[0].slice(0, -1).replace(/\s+/g, " ").trim();
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth += 1;
      else if (css[j] === "}") depth -= 1;
      j += 1;
    }
    if (query.includes("print")) printBlocks.push(css.slice(m.index + m[0].length, j));
  }
  expect(printBlocks.length, "印刷用の規則が読めない（検査が空振り）").toBeGreaterThan(0);
  const printCss = printBlocks.join("\n");
  expect(printCss, "候補のカードが印刷で消えている").not.toMatch(
    /#recommendationCards[^{]*\{[^}]*display:\s*none/,
  );
  // 紙では URL を押せない。表と同じく候補のカードにもアドレスを併記する。
  expect(printCss).toMatch(/#tbody a\[href\^="http"\]::after/);
  expect(printCss, "候補のカードだけ公式ページのアドレスが紙に残らない").toMatch(
    /#recommendationCards a\[href\^="http"\]::after/,
  );
  // てびきにも同じ事実を書く（画面の語を引けるようにする）。
  expect(html).toContain("投稿先を探す画面 ／ 候補 N 件");
});

it("開いていた行の詳細まで共有し、てびきの説明と実際の引き継ぎをズレさせない（SPEC §7）", () => {
  /* 「画面を共有する」は絞り込み・並び順・てびきの開閉を URL に載せる（第 99 回・第 140 回）。
   * 一方で、いちばん共有したい単位である「この締切」が行として残っておらず、送られた側は
   * 表のなかから同じ行を探さなければならなかった（2026-09-23 実測: ビルド成果物の URL の
   * 書き出しに行に関する引数は 1 つも無かった）。 */
  const app = siteRuntime("app.js");
  const html = readFileSync(join(site, "index.html"), "utf8");
  // 書き出しと読み取りが対で存在すること（片方だけの実装は黙って消える）。
  expect(app).toContain('p.set("row", rowShareKeyJa(');
  expect(app).toContain('p.get("row")');
  // 起動時は `render()` の後に復元する（`shown` が揃う前だと行を探せない）。
  // 起動時の並び: `readUrl()` → 描き込み → 行の詳細の復元（`shown` が揃う前では探せない）。
  // ビルド後はインデントが変わるので、行の並びで見つける。
  const wired = /\n\s*render\(\);\n\s*restoreDrawerFromUrl\(\);/.exec(app);
  expect(wired, "描き込みの後で行の詳細を開いていない（URL を受け取らない画面）").not.toBeNull();
  const firstRead = app.lastIndexOf("readUrl();", (wired as RegExpExecArray).index);
  expect(firstRead, "URL を読む前に開こうとしている").toBeGreaterThan(0);
  // 行の鍵は同じ会議の別締切を区別できる（概要/論文・年違い）。
  const script = [
    "const rowShareKeyJa = (" + jsFunction(app, "rowShareKeyJa") + ");",
    "const a = { conf: { key: 'SC' }, ed: { year: 2026 }, kind: 'paper', t: 1794883140000 };",
    "console.log(JSON.stringify({",
    "  a: rowShareKeyJa(a),",
    "  same: rowShareKeyJa({ ...a }) === rowShareKeyJa(a),",
    "  kind: rowShareKeyJa({ ...a, kind: 'abstract', t: 1 }) !== rowShareKeyJa(a),",
    "  year: rowShareKeyJa({ ...a, ed: { year: 2027 } }) !== rowShareKeyJa(a),",
    "  sparse: rowShareKeyJa({ conf: {}, ed: {}, kind: '', t: NaN }),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as { [k: string]: string };
  expect(got.same).toBe(true);
  expect(got.kind).toBe(true);
  expect(got.year).toBe(true);
  expect(got.a).toBe("SC|2026|paper|1794883140000");
  // 情報が無い行でも例外にはせず、空の欄を残す（照合にしか使わない）。
  expect(got.sparse).toBe("|||");
  // 案内にも同じ事実を書く（画面の語を引けるようにする）。
  expect(html, "?row= のことがてびきに無い").toContain("<code>?row=</code>");
});

it("読めない形式のファイルを PDF のせいにしない（SPEC §7）", () => {
  /* 論文を選ぶ欄は `accept=".pdf,.txt"` だが、ピッカーは「すべてのファイル」に切り替えられる
   * ので他の形式も運ばれてくる。従来は拡張子を見ておらず、Word なども PDF として pdf.js に
   * 渡していた（2026-09-23 実測: `.docx` を選ぶと pdf.js が `Invalid PDF structure.` を落とし、
   * 画面は「PDF から文字を読み取れませんでした（文字が入っていない PDF や、パスワード付きは
   * 読めません）」と言った。自分の PDF の文字化けを疑って、直せない方向へ探してしまう）。 */
  const app = siteRuntime("app.js");
  const script = [
    "const PDF_MAX_BYTES = 20 * 1024 * 1024;",
    "const PDF_MAX_PAGES = 3;",
    "const unsupportedPaperFormatJa = (" + jsFunction(app, "unsupportedPaperFormatJa") + ");",
    "const message = (" + jsFunction(app, "pdfFailureMessageJa") + ");",
    "const names = ['paper.docx', 'ronbun.doc', 'talk.odp', 'TALK.ODP', 'notes.txt', 'paper.pdf', 'paper.PDF', 'summary', 'book.epub'];",
    "console.log(JSON.stringify({",
    "  verdicts: names.map((n) => {",
    "    const u = unsupportedPaperFormatJa(n);",
    "    return { name: n, msg: u ? message(new Error(u)) : '' };",
    "  }),",
    "  // PDF の失敗の言い方は従来どおり残る（増やした分岐が既存の案内を潰していないこと）。",
    "  invalid: message(new Error('Invalid PDF structure.')),",
    "  cancelled: message(Object.assign(new Error('x'), { name: 'AbortError' })),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as {
    verdicts: Array<{ name: string; msg: string }>;
    invalid: string;
    cancelled: string;
  };
  const byName: { [k: string]: string } = {};
  for (const v of got.verdicts) byName[v.name] = v.msg;
  for (const n of ["paper.docx", "ronbun.doc", "talk.odp", "TALK.ODP", "book.epub"]) {
    expect(byName[n], `${n} が読み取れることになっている（検査が空振り）`).not.toBe("");
    // 「あなたの PDF が壊れている」とは言わない。拡張子を実名で出して、次を指示する。
    expect(byName[n]).not.toMatch(/PDF (から|を)(文字)?が?読み取れ/);
    expect(byName[n]).toContain("対応しているのは PDF と TXT です");
    expect(byName[n]).toContain("貼り付けてください");
  }
  expect(byName["TALK.ODP"], "大文字の拡張子を取りこぼしている").toContain(".odp");
  for (const n of ["notes.txt", "paper.pdf", "paper.PDF", "summary"]) {
    expect(byName[n], `${n} を弾いている（従来読めていたものを壊した）`).toBe("");
  }
  expect(got.invalid).toContain("PDF から文字を読み取れませんでした");
  expect(got.cancelled).toBe("PDF 読込をキャンセルしました");
  // 弾く場所: 大きさの判定より前で、ファイル名を見る（読みに行かない）。
  expect(app).toContain("unsupportedPaperFormatJa(file.name)");
  // 欄の注記にも対応形式を書いておく（押す前に分かるようにする）。
  const html = readFileSync(join(site, "index.html"), "utf8");
  expect(html, "対応形式の注記が無い").toContain("Word などの文書形式は読めません");
});

it("条件クリアは論文の入力を消さず、消す操作は名前の書いたボタンが受け持つ（SPEC §7）", () => {
  /* 「条件クリア」は絞り込みだけをまとめる操作だが、論文のタイトル・概要・参考論文の欄と
   * 選んだファイルまで消していた（2026-09-23 実測: `#reset` の節に `paperText` と
   * `paperReferences` への代入が残っていた）。てびきは CSV を条件なしで出す手順として
   * 「条件クリアを押してください」と案内しているので、絞り込みを直したいだけの人が
   * Confirmation も Undo も無く打ち込んだ概要を失っていた。 */
  const app = siteRuntime("app.js");
  // `#reset` の節に論文の入力を消す代入が残っていないこと（節の範囲は次の addEventListener まで）。
  const resetAt = app.indexOf('$("reset").addEventListener');
  expect(resetAt, "条件クリアの処理が見当たらない（検査が空振り）").toBeGreaterThan(0);
  // 自分自身の `addEventListener("click"` を飛ばしてから、次の節の開始を探す。
  const selfAt = app.indexOf('addEventListener("click"', resetAt);
  const nextAt = app.indexOf('addEventListener("click"', selfAt + 22);
  const resetBody = app.slice(resetAt, nextAt > 0 ? nextAt : resetAt + 1600);
  expect(resetBody).toContain('q: ""');
  for (const paperField of [
    "paperText",
    "paperReferences",
    "paperPrimaryTitle",
    "paperFileLabel",
  ]) {
    expect(
      resetBody,
      `条件クリアが ${paperField} を消している（概要を失う操作のまま）`,
    ).not.toContain(paperField);
  }
  // 実行検証: 論文の入力を消す操作は、五つの欄をまとめて白紙にする。
  const script = [
    "const vals = {",
    "  paperText: '打った本文',",
    "  paperPrimaryTitle: 'タイトル',",
    "  paperPrimaryAbstract: '概要',",
    "  paperPrimaryKeywords: 'キーワード',",
    "  paperReferences: 'ref | k | v',",
    "};",
    "const valueElement = (id) => ({",
    "  get value() {",
    "    return vals[id];",
    "  },",
    "  set value(v) {",
    "    vals[id] = v;",
    "  },",
    "});",
    "let paperPrimaryVenue = 'ICDE';",
    "let invalidated = 0;",
    "const invalidateSemantic = () => { invalidated += 1; };",
    jsFunction(app, "setPrimaryRecord").replace(
      "function setPrimaryRecord",
      "const setPrimaryRecord = function",
    ),
    "const label = { textContent: 'paper.docx' };",
    "const $ = (id) => (id === 'paperFileLabel' ? label : {});",
    "const paperFiles = { value: 'stale' };",
    jsFunction(app, "clearPaperInput").replace(
      "function clearPaperInput",
      "const clearPaperInput = function",
    ),
    "clearPaperInput();",
    "console.log(JSON.stringify({ vals, venue: paperPrimaryVenue, file: paperFiles.value, label: label.textContent, invalidated }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as {
    vals: { [k: string]: string };
    venue: string;
    file: string;
    label: string;
    invalidated: number;
  };
  expect(got.vals).toEqual({
    paperText: "",
    paperPrimaryTitle: "",
    paperPrimaryAbstract: "",
    paperPrimaryKeywords: "",
    paperReferences: "",
  });
  expect(got.venue, "PDF から取った掲載先の想定が残っている").toBe("");
  expect(got.file).toBe("");
  expect(got.label).toBe("未選択");
  expect(got.invalidated, "意味検索の使い回しを無効化していない").toBe(1);
  // 消す操作は、その名前のボタンが受け持つ（てびきの説明と同じ語で出す）。
  const html = readFileSync(join(site, "index.html"), "utf8");
  const btn = /<button id="paperReset"[^>]*>([^<]+)<\/button>/.exec(html);
  expect(btn, "論文の入力を消すボタンが無い").not.toBeNull();
  expect(html, "てびきがボタンの語で案内していない").toContain(`ボタン「${btn![1]}」`);
});

it("キーボードで選んだ行がまだ描画されていなくても、その場で続きを描く（SPEC §7）", () => {
  /* 選択は `shown`（絞り込み後の全行）まで進むが、表に描いてある行は `drawn` 行だけだった
   * （2026-09-23 実測: 既定の PAGE は 40 行で、`j` を 40 回押すとハイライトとフォーカスは
   * 40 行目に残ったまま、内部の選択だけ 41 行目以降へ進んだ）。`d` を押すと画面に出ていない
   * 行の詳細が開き、キーが効かなくなったように見えていた。共有リンクで受け取った側も
   * 同じ状態で、しかも `render()` が先頭で選択を解くため開いた行に目印も付かなかった。 */
  const app = siteRuntime("app.js");
  const body = (name: string) => {
    const at = app.indexOf(`function ${name}(`);
    expect(at, `function ${name} が見つからない（検査が空振り）`).toBeGreaterThan(0);
    let depth = 0;
    let started = false;
    for (let i = at; i < app.length; i++) {
      if (app[i] === "{") {
        depth++;
        started = true;
      } else if (app[i] === "}") {
        depth--;
        if (started && depth === 0) return app.slice(at, i + 1);
      }
    }
    throw new Error(`unbalanced: ${name}`);
  };
  // 前提: render() は選択と描画位置を戻す（顺序の要求はこれに由来する）。
  const renderBody = body("render");
  expect(renderBody).toContain("drawn = 0;");
  expect(renderBody).toContain("selectedIndex = -1;");
  // `j` / ↓: 選択を進めたら、描画をそれから追いつかせてから目印を動かす。
  const jBranch = /selectedIndex\+\+;[\s\S]{0,160}/.exec(app)?.[0] ?? "";
  expect(jBranch, "j の選択移動が描画に追いついていない（見えない行を選ぶまま）").toContain(
    "ensureRowsDrawn(selectedIndex)",
  );
  expect(jBranch.indexOf("ensureRowsDrawn")).toBeLessThan(jBranch.indexOf("updateRowSelection"));
  // `d`: フォーカス先の行が存在する必要がある。
  expect(
    /e\.key === "d" && selectedIndex >= 0[\s\S]{0,600}?ensureRowsDrawn\(selectedIndex\);/.test(app),
    "d が未描画の行に対してフォーカス先を探している",
  ).toBe(true);
  /* 共有リンクの受け取り側: render → 選択 → 描画 → 目印 → 詳細 の順。
   * 第 156 回で render は分岐の中に置く形になった（既定に出ていない行は条件を外して
   * 作り直すため）。守るべきは「render の後に目印を付ける」なので、render の呼び出しが
   * 何箇所あっても最後に走る物が選択より前であることを見る。 */
  const restore = body("restoreDrawerFromUrl");
  const marks = [
    restore.lastIndexOf("render();"),
    restore.indexOf("selectedIndex = idx;"),
    restore.indexOf("ensureRowsDrawn(idx);"),
    restore.indexOf("updateRowSelection();"),
    // 表に出さない種別の枝にも `openDrawer` がある（第 156 回）。見るのは末尾の
    // 「描き終えた後に目印を付けてから詳細を開く」手順なので最後を見る。
    restore.lastIndexOf("openDrawer("),
  ];
  expect(marks, "受け取り側の復元の手順が揃っていない").toEqual(
    [...marks].map((_, i) => (i === 0 ? marks[0] : marks[i])).map((v) => v),
  );
  for (let i = 1; i < marks.length; i++) {
    expect(marks[i], `復元の手順 ${i} 番目が見当たらない`).toBeGreaterThan(marks[i - 1]);
  }
  // 実行検証: 描画済みを越えるindexを頼むと、足りるまで描き、末尾では以上描かない。
  const script = [
    "let drawn = 0;",
    "const shown = { length: 95 };",
    "const PAGE = 40;",
    "let calls = 0;",
    "function drawMore() {",
    "  calls += 1;",
    "  if (calls > 200) throw new Error('ended rows keep drawing');",
    "  drawn = Math.min(drawn + PAGE, shown.length);",
    "}",
    "const ensureRowsDrawn = (" + jsFunction(app, "ensureRowsDrawn") + ");",
    "const steps = [];",
    "ensureRowsDrawn(5);",
    "steps.push([drawn, calls]);",
    "ensureRowsDrawn(41);",
    "steps.push([drawn, calls]);",
    "ensureRowsDrawn(94);",
    "steps.push([drawn, calls]);",
    "ensureRowsDrawn(94);",
    "steps.push([drawn, calls]);",
    "ensureRowsDrawn(500);",
    "steps.push([drawn, calls]);",
    "console.log(JSON.stringify(steps));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  // 40 行ずつ描かれる: 5 → 40、41 → 80、94 → 95（全行）、リピートでも増えない、
  // 全体より遠いindexを頼んでも 95 行で止まる（絞り込み後の行数を越えて描かない）。
  expect(JSON.parse(proc.stdout)).toEqual([
    [40, 1],
    [80, 2],
    [95, 3],
    [95, 3],
    [95, 3],
  ]);
});

it("公式ページの URL を検索欄に貼るとその会議が見つかる（SPEC §7）", () => {
  /* メーリングリストで CFP のリンクを受け取った人が、検索欄にその URL を貼って収録確認を
   * していた。会議の検索語（hay）に URL が無く、照合側も URL を語に分解してしまうので
   * 0 件になり、収録されていないと誤解していた（2026-09-23 実測: ビルド後の `searchMatcher` で
   * 「https://warwick.ac.uk/fac/sci/dcs/aamas2027/」は 0 行）。 */
  const rec = readFileSync(join(site, "recommender.js"), "utf8");
  // 実行検証 1: URL からホストの成分を取り出す式そのもの。
  const script = [
    `const hostFromUrl = (${jsFunction(rec, "hostFromUrl")});`,
    `const hostLabels = (${jsFunction(rec, "hostLabels")});`,
    `const linkSearchTerms = (${jsFunction(rec, "linkSearchTerms")});`,
    "const urls = [",
    "  'https://warwick.ac.uk/fac/sci/dcs/aamas2027/',",
    "  'http://www.kyoto.example.ac.jp/index.html',",
    "  'https://asiaccs2027.cityu.edu.mo:8443/index.html',",
    "  'ftp://mail.server.example.org/pub',",
    "  '',",
    "];",
    "console.log(JSON.stringify({",
    "  hosts: urls.map((u) => hostFromUrl(u)),",
    "  terms: urls.map((u) => linkSearchTerms(u)),",
    "  // 2 文字以下の成分（`ac`・`jp`・`www`）を入れない約束。",
    "  shortKept: urls.some((u) => hostLabels(hostFromUrl(u)).some((p) => p.length < 3)),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as { hosts: string[]; terms: string[]; shortKept: boolean };
  expect(got.hosts).toEqual([
    "warwick.ac.uk",
    "www.kyoto.example.ac.jp",
    "asiaccs2027.cityu.edu.mo",
    "mail.server.example.org",
    "",
  ]);
  expect(got.terms[0].split(" ")).toEqual(["warwick"]);
  expect(got.terms[2]).toBe("asiaccs2027 cityu edu");
  expect(got.shortKept, "2 文字以下の成分が混ざっている（短い略称の検索が誤爆する）").toBe(false);
  // 実行検証 2: ビルド後の検索で、URL を貼った人が該当会議にたどり着けるか。
  const script2 = [
    "const { default: Recommender } = await import(" +
      JSON.stringify(`file://${join(site, "recommender.js")}`) +
      ");",
    "const fs = await import('node:fs');",
    "const data = JSON.parse(fs.readFileSync(" +
      JSON.stringify(join(site, "data.json")) +
      ", 'utf8'));",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(data.conferences, now);",
    "const targets = [];",
    "for (const r of rows) {",
    "  const link = String((r.ed && r.ed.link) || '');",
    "  if (/^https?:\\/\\/[a-z0-9.-]+\\.[a-z]{2,}/i.test(link)) targets.push({ link, key: r.conf.key });",
    "  if (targets.length >= 4) break;",
    "}",
    "const out = [];",
    "for (const t of targets) {",
    "  const bare = t.link.replace(/^https?:\\/\\//, '').replace(/\\/$/, '');",
    "  const host = bare.split('/')[0];",
    "  for (const q of [t.link, bare, host]) {",
    "    const m = Recommender.searchMatcher(q, now);",
    "    const hit = rows.filter((r) => m(r.hay));",
    "    out.push({ q, hits: hit.length, self: hit.some((r) => r.conf.key === t.key) });",
    "  }",
    "}",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const proc2 = spawnSync("node", ["--input-type=module", "-e", vmSafeSource(script2)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc2.status, proc2.stderr).toBe(0);
  const found = JSON.parse(proc2.stdout) as Array<{ q: string; hits: number; self: boolean }>;
  expect(found.length, "検査対象の URL が無かった").toBeGreaterThanOrEqual(9);
  for (const f of found) {
    expect(f.hits, `URL 検索「${f.q}」で 0 行（収録なしと誤解されるまま）`).toBeGreaterThan(0);
    expect(f.self, `URL 検索「${f.q}」で該当会議が引けない`).toBe(true);
  }
  // 案内にも同じ操作が書いてある（画面だけで増えて、てびきが古い状態を残さない）。
  const html = readFileSync(join(site, "index.html"), "utf8");
  expect(html).toContain("URL をそのまま貼っても引けます");
});

it("URL で引いて 0 件のときは「語が無い」とは言わず収録の範囲を言う（SPEC §7）", () => {
  /* 第 153 回で URL 検索を通したので、URL を貼って 0 件になるのは「その会議が収録に無い」という
   * 意味になった。ところが 0 件案内は従来「語「〜」は収録データにありません」の形で、打った
   * 文字列を語として扱う案内をしていた（2026-09-23 実測: URL を貼った場合もこの文が出ていた）。
   * 収録の範囲（何を収めていて何が無いのか）が伝わらず、検索の仕方が悪いと誤解される。 */
  const app = siteRuntime("app.js");
  const rec = readFileSync(join(site, "recommender.js"), "utf8");
  const script = [
    "const countJa = (n) => String(n);",
    "const looksLikeUrlQuery = (" + jsFunction(rec, "looksLikeUrlQuery") + ");",
    "const urlLikeQueryTerms = (" + jsFunction(rec, "urlLikeQueryTerms") + ");",
    "const hostFromUrl = (" + jsFunction(rec, "hostFromUrl") + ");",
    "const hostLabels = (" + jsFunction(rec, "hostLabels") + ");",
    "const note = (" + jsFunction(app, "zeroResultLiveNote") + ");",
    // URL の形とそれ以外（日付・会議名・語の羅列）を混同しないこと。
    "const yes = ['https://www.example-university.edu/symposium-2027/cfp', 'example.ac.jp/workshop27', 'easychair.org/cfp/x'];",
    "const no = ['機械学習', 'ICDE 2026', '3/5', '研究会', ''];",
    "const mk = (q, term) => ({",
    "  hiddenKindWords: [],",
    "  termCounts: [{ term, count: 0 }],",
    "  urlQuery: looksLikeUrlQuery(q),",
    "  queryMatch: { catalog: 0, journal: 0 },",
    "  catalogConferences: 1880,",
    "  clearable: false,",
    "  pastShown: false,",
    "  hidden: { past: 10 },",
    "});",
    "console.log(JSON.stringify({",
    "  yes: yes.map((q) => [q, looksLikeUrlQuery(q)]),",
    "  no: no.map((q) => [q, looksLikeUrlQuery(q)]),",
    "  urlNote: note(mk('example.ac.jp/workshop27', 'example-university')),",
    "  wordNote: note(mk('機械学習', '機械学習')),",
    // データその物が無いときは、URL でもやはりそれを先に言う。
    "  emptyData: note({ ...mk('example.ac.jp'), catalogConferences: 0 }),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as {
    yes: Array<[string, boolean]>;
    no: Array<[string, boolean]>;
    urlNote: string;
    wordNote: string;
    emptyData: string;
  };
  for (const [q, flag] of got.yes) expect(flag, `URL の形を URL と見分けていない: ${q}`).toBe(true);
  for (const [q, flag] of got.no)
    expect(flag, `URL ではない語を URL 扱いしている: ${q}`).toBe(false);
  expect(got.urlNote).toContain("URL の会議は収録に見当たりません");
  // 打った文字列を「語」と呼ばない（長文の URL を「語」と出してもしゃべらない）。
  expect(got.urlNote, "URL を語として扱う案内のまま").not.toContain("語「");
  // 収録の中心と、次に何を打つかも書く（0 件で操作をやめないようにする）。
  expect(got.urlNote).toContain("ランク付けの一覧");
  expect(got.urlNote).toContain("国内研究会");
  expect(got.urlNote).toContain("会議名");
  // 「下に外せる条件も書いてあります」の言いぶりは他の 0 件案内と同じ（検査で語を固定している）。
  expect(got.urlNote).toContain("下に外せる条件も書いてあります");
  // URL 以外の従来の文は変わっていない。
  expect(got.wordNote).toContain("語「機械学習」は収録データにありません");
  expect(got.emptyData).toBe(" ｜ 締切のデータが入っていません");
  // 組み込み: 検索語から判定を渡している（渡していないとこの枝は死んだまま）。
  expect(app).toContain("urlQuery: Recommender.looksLikeUrlQuery(searchQuery)");
  // てびきにも収録の範囲を書く（画面だけが増えて、案内が古いままにならないようにする）。
  const html = readFileSync(join(site, "index.html"), "utf8");
  expect(html).toContain("URL で引いて出てこないときは、その会議は収録していません");
});

it("0 件案内の画面側も URL を「語」と呼ばず、読み上げと同じことを言う（SPEC §7）", () => {
  /* 第 154 回は読み上げ側（`zeroResultLiveNote`）だけを直した。画面に出る 0 件案内
   * （`emptyDeadlineHint`）は URL を知らず、検索語その物を引用した（2026-09-23 実測:
   * ビルド後の関数に「https://warwick.ac.uk/fac/sci/dcs/aamas2027/」を渡すと
   * `検索語「https://warwick.ac.uk/fac/sci/dcs/aamas2027/」は収録済みで 6 件に当たります`
   * と出し、同じ画面の読み上げは「収録に見当たりません」と言っていた）。同じ画面の中で
   * 目の字と読み上げが逆のことを言い、数十文字のアドレスが読み上げられる。
   * また収録に無い URL には「その語を外すと増えます」と出していて、URL には外せる語が
   * 無いので実行不能な案内だった。 */
  const app = siteRuntime("app.js");
  const script = [
    "const countJa = (n) => String(n);",
    `const hint = (${jsFunction(app, "emptyDeadlineHint")});`,
    `const note = (${jsFunction(app, "zeroResultLiveNote")});`,
    "const mk = (o) => Object.assign({",
    "  window: '', past: false, cats: 0, domestic: false, online: false,",
    "  rank: '', kind: '', est: false, hidden: {}, query: '',",
    "  hiddenKindWords: [], queryMatch: { catalog: 0, journal: 0 },",
    "  termCounts: [], urlQuery: false, catalogConferences: 1880,",
    "  clearable: false, pastShown: false,",
    "}, o);",
    "const url = 'https://warwick.ac.uk/fac/sci/dcs/aamas2027/';",
    "const cases = {",
    "  // ドメインが収録に無い URL。",
    "  missing: mk({",
    "    query: 'https://www.example-university.edu/symposium-2027/cfp',",
    "    urlQuery: true,",
    "    termCounts: [{ term: 'example-university', count: 0 }, { term: 'edu', count: 40 }],",
    "  }),",
    "  // ドメインが収録に当たっているのに、いまの条件で 0 件の URL。",
    "  present: mk({",
    "    query: url,",
    "    urlQuery: true,",
    "    queryMatch: { catalog: 6, journal: 0 },",
    "    termCounts: [{ term: 'warwick', count: 6 }],",
    "  }),",
    "  // 語を並べた従来の検索語（挙動を変えない）。",
    "  words: mk({",
    "    query: '機械学習 福岡 GPU',",
    "    termCounts: [",
    "      { term: '機械学習', count: 494 },",
    "      { term: '福岡', count: 8 },",
    "      { term: 'GPU', count: 0 },",
    "    ],",
    "  }),",
    "};",
    "const out = {};",
    "for (const [k, f] of Object.entries(cases)) out[k] = { screen: hint(f), live: note(f) };",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as Record<string, { screen: string; live: string }>;
  // 画面側も URL を「語」と呼ばない。
  expect(got.missing.screen).toContain("URL の会議は収録に見当たりません");
  expect(got.missing.screen, "URL を語として外す案内のまま").not.toContain(
    "その語を外すと増えます",
  );
  expect(got.missing.screen).toContain("ランク付けの一覧");
  // 同じ画面の読み上げと目の字が同じことを言う（前回までの矛盾）。
  expect(got.missing.live).toContain("URL の会議は収録に見当たりません");
  // ドメインが収録済みなら「収録に無い」とは言わない（前回まで読み上げ側が噓をついていた）。
  expect(got.present.screen).toContain("その URL のドメインは収録済みで 6 件");
  expect(got.present.screen).not.toContain("収録に見当たりません");
  expect(got.present.live).not.toContain("収録に見当たりません");
  // 数十文字のアドレスをそのまま引用しない（読み上げでも目の字でも読みにくい）。
  expect(got.present.screen, "URL をそのまま引用している").not.toContain("warwick.ac.uk/fac");
  expect(got.missing.screen).not.toContain("example-university.edu/symposium");
  // 語の検索語の案内はそのまま。
  expect(got.words.screen).toContain("検索語のうち「GPU」は収録データにも見当たりません");
  expect(got.words.live).toContain("語「GPU」は収録データにありません");
  // 両方に同じ判定が渡っている（片方だけ直す状態を許さない）。
  expect(jsFunction(app, "emptyDeadlineHint")).toContain("filter.urlQuery");
  expect(jsFunction(app, "zeroResultLiveNote")).toContain("filter.urlQuery");
});

it("既定に出ていない行の共有リンクを踏んだら、条件を外してその行を開く（SPEC §7）", () => {
  /* 行の詳細のURL（`?row=`）は、その行が既定の一覧に出ていないと黙って何もしなかった
   * （2026-09-23 実測: `restoreDrawerFromUrl` の本体は `shown` に見当たらなければ `return`
   * するだけ。ビルド後のデータで数えると、行の共有キー 3,207 件のうち既定の一覧に
   * 出る物は 475 件だけで、残り 2,732 件 – 過ぎた締切 2,295 件・推定 134 件・表に出さない
   * 種別 303 件 – へのリンクを踏んでも一覧が出るだけだった）。論文のメモに残った
   * 去年の締切のリンクを踏む操作は普通にあるので、外せる条件は自分で外して見せる。 */
  const app = siteRuntime("app.js");
  const recPath = `file://${join(site, "recommender.js")}`;
  const dataPath = join(site, "data.json");
  const script = [
    `const { default: Rec } = await import(${JSON.stringify(recPath)});`,
    "const fs = await import('node:fs');",
    `const data = JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    `const rowDateOnlyState = (${jsFunction(app, "rowDateOnlyState")});`,
    `const rowIsPast = (${jsFunction(app, "rowIsPast")});`,
    `const rowShareKeyJa = (${jsFunction(app, "rowShareKeyJa")});`,
    `const sharedRowState = (${jsFunction(app, "sharedRowState")});`,
    `const sharedRowNotice = (${jsFunction(app, "sharedRowNotice")});`,
    `const loosenSharedRowConditions = (${jsFunction(app, "loosenSharedRowConditions")});`,
    `const restoreDrawerFromUrl = (${jsFunction(app, "restoreDrawerFromUrl")});`,
    // 抜き出した関数が参照する自由変数は、必ず上のスコープに置く（第 143 回の教訓）。
    /const SELECTABLE_KINDS = \[[^\]]*\];/.exec(app)?.[0],
    "const rows = Rec.candidateRows(data.conferences, now);",
    // 分類が画面の判定（rowIsPast）と食い違わないこと。
    "let disagree = 0;",
    "for (const r of rows) {",
    "  const want = rowIsPast(r, now) ? 'past' : r.est ? 'est' : 'other';",
    "  if (sharedRowState(r, now) !== want) disagree += 1;",
    "}",
    // 配線の実行。一覧の作り直し（render）は画面と同じ規則 – 推定を含まない・
    // 表に出す種別だけ・過ぎた締切はチェックがオンのときだけ – で、判定自体は
    // ビルド済みの `rowIsPast` を使う。
    "globalThis.Date = { now: () => now };",
    // `mode` は締切の一覧の画面（行の詳細を開ける画面）で受け取った場合。
    "let state = { past: false, est: false, mode: 'deadlines' };",
    "let shown = [];",
    "let calls = [];",
    "let pendingDrawerKey = '';",
    "let selectedIndex = -1;",
    "const toForm = () => { calls.push('toForm:' + state.past + '/' + state.est); };",
    "const render = () => {",
    "  selectedIndex = -1;",
    "  shown = rows.filter((r) =>",
    "    (state.est || !r.est) &&",
    "    ['abstract', 'paper', 'journal'].includes(r.kind) &&",
    "    (state.past || !rowIsPast(r, now)));",
    "};",
    "const ensureRowsDrawn = () => { calls.push('draw'); };",
    "const updateRowSelection = () => { calls.push('select:' + selectedIndex); };",
    "const openDrawer = (r) => { calls.push('open:' + rowShareKeyJa(r)); };",
    "const live = {};",
    "const $ = () => ({ set textContent(v) { live.v = v; }, get textContent() { return live.v || ''; } });",
    "const run = (key, initial) => {",
    "  state = { past: false, est: false, mode: 'deadlines' };",
    "  shown = initial;",
    "  calls = [];",
    "  delete live.v;",
    "  pendingDrawerKey = key;",
    "  restoreDrawerFromUrl();",
    "  return { state, calls, live: live.v || '' };",
    "};",
    "const first = (pred) => rows.filter(pred)[0];",
    "const pastRow = first((r) => !r.est && rowIsPast(r, now) && r.kind === 'paper');",
    "const estRow = first((r) => r.est && r.kind === 'paper');",
    "const hiddenKindRow = first((r) => !r.est && !rowIsPast(r, now) && r.kind === 'notification');",
    "const out = {};",
    "out.disagree = disagree;",
    "out.past = run(rowShareKeyJa(pastRow), []);",
    "out.pastKey = rowShareKeyJa(pastRow);",
    "out.est = run(rowShareKeyJa(estRow), []);",
    "out.estKey = rowShareKeyJa(estRow);",
    "out.hiddenKind = run(rowShareKeyJa(hiddenKindRow), []);",
    "out.hiddenKindKey = rowShareKeyJa(hiddenKindRow);",
    "out.missing = run('kaminari-2099-not-recorded#x', []);",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const proc = spawnSync("node", ["--input-type=module", "-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as {
    disagree: number;
    past: { state: { past: boolean; est: boolean }; calls: string[]; live: string };
    pastKey: string;
    est: { state: { past: boolean; est: boolean }; calls: string[]; live: string };
    estKey: string;
    hiddenKind: { state: { past: boolean; est: boolean }; calls: string[]; live: string };
    hiddenKindKey: string;
    missing: { state: { past: boolean; est: boolean }; calls: string[]; live: string };
  };
  expect(got.disagree, "行の分類が画面の「過ぎた締切」の判定と食い違っている").toBe(0);
  // 過ぎた締切のリンク: 「過去の締切も表示」を外して（チェック欄にも出して）行を開く。
  expect(got.past.state.past, "過ぎた締切のリンクで「過去の締切も表示」が入らない").toBe(true);
  expect(got.past.state.est, "推定まで巻き込んで外している").toBe(false);
  expect(got.past.calls, "チェック欄を書き直していない（外れたことが画面に出ない）").toContain(
    "toForm:true/false",
  );
  expect(got.past.calls).toContain(`open:${got.pastKey}`);
  expect(got.past.live, "見つかっているのに「見つかりません」を流している").toBe("");
  // 推定のリンク: 同じやり方で「推定締切を含める」だけを外す。
  expect(got.est.state.est).toBe(true);
  expect(got.est.state.past, "過ぎた締切まで巻き込んで外している").toBe(false);
  expect(got.est.calls).toContain(`open:${got.estKey}`);
  // 表に出さない種別（採否通知・カメラレディなど）: 絞り込みの問題ではないので、
  // 「条件を確認してください」とは言わず、その行を開く。
  expect(got.hiddenKind.state.past, "表に出さない種別で過去表示を外している").toBe(false);
  expect(got.hiddenKind.state.est, "表に出さない種別で推定を外している").toBe(false);
  expect(got.hiddenKind.calls).toContain(`open:${got.hiddenKindKey}`);
  expect(got.hiddenKind.live).toContain("表に出さない種別");
  expect(got.hiddenKind.live).not.toContain("絞り込み");
  // 収録に無いキー: 開かず、その旨をそのまま出す（黙ったままにしない）。
  expect(got.missing.calls).toEqual([]);
  expect(got.missing.live).toContain("この収録に見当たりません");
  // てびきにも同じ振る舞いを書く。
  const html = readFileSync(join(site, "index.html"), "utf8");
  expect(html, "共有リンクの振る舞いがてびきに無い").toContain(
    "その行のために条件を自分から外して",
  );
});

it("投稿先を探す画面に切り替えると行の詳細を閉じ、その URL を受け取っても噓を言わない（SPEC §7）", () => {
  /* 行の詳細（`?row=`）を開いたまま「投稿先を探す」に切り替えると、ドロワーは閉じられず
   * `?row=` が推薦画面の URL に残った（`writeUrl` はモードを見ずに `row`を書く – 2026-08-09
   * 実測: `setMode` の本体にドロワーを閉じる箇所が無かった）。その URL を受け取った人は、
   * 表が描かれない画面で行を探そうとして、収録されている行なのに
   * 「共有された行はこの収録に見当たりません。データの更新で無くなった可能性があります」
   * と読まされていた（第 156 回で入れた「見つかりません」の文が、画面をまたぐと
   * むしろ噓になった）。条件（過去の締切も表示）を勝手に外してもいた。 */
  const app = siteRuntime("app.js");
  const recPath = `file://${join(site, "recommender.js")}`;
  const dataPath = join(site, "data.json");
  // 配線の検査: 推薦画面で受け取ったときに何もしないこと。
  const script = [
    `const { default: Rec } = await import(${JSON.stringify(recPath)});`,
    "const fs = await import('node:fs');",
    `const data = JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    `const rowDateOnlyState = (${jsFunction(app, "rowDateOnlyState")});`,
    `const rowIsPast = (${jsFunction(app, "rowIsPast")});`,
    `const rowShareKeyJa = (${jsFunction(app, "rowShareKeyJa")});`,
    `const sharedRowState = (${jsFunction(app, "sharedRowState")});`,
    `const sharedRowNotice = (${jsFunction(app, "sharedRowNotice")});`,
    `const restoreDrawerFromUrl = (${jsFunction(app, "restoreDrawerFromUrl")});`,
    "const rows = Rec.candidateRows(data.conferences, now);",
    "globalThis.Date = { now: () => now };",
    "let state = { past: false, est: false, mode: 'recommend' };",
    "let shown = [];",
    "let calls = [];",
    "let pendingDrawerKey = '';",
    "const toForm = () => { calls.push('toForm'); };",
    "const render = () => { calls.push('render'); };",
    "const ensureRowsDrawn = () => { calls.push('draw'); };",
    "const updateRowSelection = () => { calls.push('select'); };",
    "const openDrawer = () => { calls.push('open'); };",
    "const live = {};",
    "const $ = () => ({ set textContent(v) { live.v = v; }, get textContent() { return live.v || ''; } });",
    "const pastRow = rows.filter((r) => !r.est && rowIsPast(r, now) && r.kind === 'paper')[0];",
    "pendingDrawerKey = rowShareKeyJa(pastRow);",
    "restoreDrawerFromUrl();",
    "console.log(JSON.stringify({",
    "  recorded: rows.some((r) => rowShareKeyJa(r) === pendingDrawerKey),",
    "  calls, live: live.v || '', pastFlipped: state.past, estFlipped: state.est,",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["--input-type=module", "-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as {
    recorded: boolean;
    calls: string[];
    live: string;
    pastFlipped: boolean;
    estFlipped: boolean;
  };
  expect(got.recorded, "検査に使える収録済みの行が無かった").toBe(true);
  // 収録されている行について「収録に無い」と言わない（噓の文を流さない）。
  expect(got.live).not.toContain("この収録に見当たりません");
  expect(got.live).toContain("投稿先を探す画面では行を開きません");
  // 表の画面に戻れば開けることを言う（操作を止めない）。
  expect(got.live).toContain("締切の一覧に戻すと開けます");
  // 条件を勝手に外さない。
  expect(got.pastFlipped, "推薦画面で「過去の締切も表示」を外している").toBe(false);
  expect(got.estFlipped, "推薦画面で「推定締切を含める」を外している").toBe(false);
  expect(got.calls, "表の無い画面で一覧を描き直している").toEqual([]);
  // 発生源: モードを変えたら開いていた行を閉じる（`?row=` を推薦画面の URL に残さない）。
  const setMode = jsFunction(app, "setMode");
  // ビルド後の整形で改行が入るので、形では見る（開いていた行を閉じる呼び出しがあること）。
  expect(
    /if \(drawerRow\)\s*\n?\s*closeDrawer\(\);/.test(setMode),
    "モード変更時にドロワーを閉じていない",
  ).toBe(true);
  expect(setMode.indexOf("closeDrawer()")).toBeLessThan(setMode.indexOf("state.mode ="));
});

it("語に付いた疑問符・括弧で検索が 0 件にならない（SPEC §7）", () => {
  /* 画面の文字列は括弧や句読点を含む（`Lodz, Po (Poland)`、種別セルの「(AoE)」など）。
   * 従来はそれらを語の成分として扱っていたので、文末に疑問符を打ちただけで 0 件になった
   * （2026-08-09 実測: `ICDE` は 18 行、`ICDE？` と `ICDE?` は 0 行、`ICDE (2027)` と
   * `ICDE（2027）` も 0 行、`sigcomm.` も 0 行）。0 件案内は収録されているのに
   * `語「icde？」は収録データにありません` と出し、検索の仕方のせいだと誤解させた。
   * 逆に記号だけを入力に含む絞りは効いてしまい（`-` は 3,123 行・`（）` は 504 行・
   * `＋` は 85 行）、同じ種類の入力が三通りに割れていた。 */
  const recPath = `file://${join(site, "recommender.js")}`;
  const dataPath = join(site, "data.json");
  const script = [
    `const { default: Rec } = await import(${JSON.stringify(recPath)});`,
    "const fs = await import('node:fs');",
    `const data = JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Rec.candidateRows(data.conferences, now);",
    "const hays = rows.map((r) => r.hay);",
    "const count = (q) => {",
    "  const m = Rec.searchMatcher(q, now);",
    "  return rows.filter((r) => m(r.hay)).length;",
    "};",
    // ビルド後の収録から語を取り出して、その周りに記号を置く（語を hardcoded しない）。
    "const withTerm = rows.find((r) => {",
    "  const t = String(r.conf.key || '').split('-').find((p) => /^[a-z]{4,}$/.test(p));",
    "  return !!t && count(t) > 0 && count(t) < rows.length;",
    "});",
    "const term = String(withTerm.conf.key).split('-').find((p) => /^[a-z]{4,}$/.test(p));",
    "const forms = [term, '？' + term, term + '？', term + '?', '（' + term + '）', '(' + term + ')', term + '.', term + '。'];",
    "const hits = forms.map((q) => ({ q, n: count(q), self: (() => { const m = Rec.searchMatcher(q, now); return rows.some((r) => m(r.hay) && r.conf.key === withTerm.conf.key); })() }));",
    // 記号だけの入力は「何も打っていない」と同じ（三通りに割れない）。
    "const symbols = ['-', '（）', '()', '...', '＋', '？', '?', '；', '～'];",
    "const symCounts = symbols.map((q) => count(q));",
    // 語の成分になり得る記号（`+`）は端にあっても削らない。
    "const plus = { c: count('c'), cpp: count('c++') };",
    // 0 件案内は語を名指すが、記号だけの入力で「語」を作らない。",
    "const symTerms = Rec.queryTermCounts('（）', hays, now);",
    "const termNote = Rec.queryTermCounts(term + '？', hays, now).map((t) => t.term);",
    "console.log(JSON.stringify({ term, hits, symCounts, total: rows.length, plus, symTerms, termNote }));",
  ].join("\n");
  const proc = spawnSync("node", ["--input-type=module", "-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as {
    term: string;
    hits: Array<{ q: string; n: number; self: boolean }>;
    symCounts: number[];
    total: number;
    plus: { c: number; cpp: number };
    symTerms: Array<{ term: string }>;
    termNote: string[];
  };
  expect(got.hits[0].n, "基準の語その物が引けない").toBeGreaterThan(0);
  for (const h of got.hits) {
    expect(h.n, `語に記号を付けただけの検索語「${h.q}」が 0 行`).toBeGreaterThan(0);
    expect(h.self, `検索語「${h.q}」で元の行が引けない`).toBe(true);
  }
  // 記号だけ（・記号だけを重ねた入力）は全件。全部が同じ数になる。
  for (const [i, n] of got.symCounts.entries()) {
    expect(n, `記号だけの入力の件数がバラバラ（${i} 番目）`).toBe(got.total);
  }
  expect(got.symTerms, "記号だけから語を作って 0 件案内に載せる").toEqual([]);
  // 疑問符を取った語として数える（案内が「語「icde？」」にならない）。
  expect(got.termNote).toEqual([got.term]);
  // `C++` の語尾の `+` を削ると `c` に化けて別物になる（実測で 0 件 → 745 行）。
  expect(got.plus.cpp, "語尾の + が削られて `c` と同じ検索になっている").not.toBe(got.plus.c);
});

it("行の詳細の公式確認は内部表記のまま見せない（SPEC §7）", () => {
  /* 行の詳細の「公式確認」欄は、収録データの値をそのまま出していた（2026-08-09 実測:
   * ビルド後の data.json で `verification.source_class` が `unknown` の締切 236 件は
   * 「確認元: unknown」と出ていた。`verifiedFields` は項目名そのもので
   * `date・kind・round` 15 件、`date` 8 件、`date・kind` 5 件など 33 件。
   * 項目その物が無い行の既定値は「日付・時刻・タイムゾーン」と日本語なので、
   * 同じ欄の中で日本語と機械の表記が混ざっていた。 */
  const app = siteRuntime("app.js");
  const script = [
    "const esc = (x) => String(x);",
    `const verificationSummary = (${jsFunction(app, "verificationSummary")});`,
    "const fs = await import('node:fs');",
    `const data = JSON.parse(fs.readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    // ビルド後の収録すべてに対して、画面に出る語を集める。
    "const src = {}; const fld = {}; let n = 0;",
    "for (const c of data.conferences)",
    "  for (const ed of c.editions || [])",
    "    for (const dl of ed.deadlines || []) {",
    "      const v = dl.verification; if (!v) continue; n += 1;",
    "      const html = verificationSummary(dl);",
    "      const a = (html.match(/確認元<\\/b> ([^<]*)/) || [, '(なし)'])[1];",
    "      const b = (html.match(/確認範囲<\\/b> ([^<]*)/) || [, '(なし)'])[1];",
    "      src[a] = (src[a] || 0) + 1;",
    "      fld[b] = (fld[b] || 0) + 1;",
    "    }",
    // 知らない項目名を勝手に翻訳しない約束（合成の入力で見る）。
    "const mystery = verificationSummary({",
    "  verification: { status: 'verified', source_class: 'mystery-source' },",
    "  evidence: [{ verifiedFields: ['date', 'mystery_field'] }],",
    "});",
    "const onlySelector = verificationSummary({",
    "  verification: { status: 'verified', selector_or_field: 'table-row:deadline' },",
    "  evidence: [],",
    "});",
    "console.log(JSON.stringify({ n, src, fld, mystery, onlySelector }));",
  ].join("\n");
  const proc = spawnSync("node", ["--input-type=module", "-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as {
    n: number;
    src: Record<string, number>;
    fld: Record<string, number>;
    mystery: string;
    onlySelector: string;
  };
  expect(got.n, "検査できる確認付きの締切が無かった").toBeGreaterThan(0);
  // 英文字だけの語（機械の表記）をそのまま出さない。`公式CFP` のように和英混在は許す。
  const asciiOnly = (value: string) => /^[a-z0-9 ._:/+-]+$/i.test(value);
  const badSrc = Object.keys(got.src).filter(asciiOnly);
  expect(badSrc, `確認元に内部表記が残っている: ${badSrc.join(" / ")}`).toEqual([]);
  const badFld = Object.keys(got.fld).filter(asciiOnly);
  expect(badFld, `確認範囲に内部表記が残っている: ${badFld.join(" / ")}`).toEqual([]);
  // `unknown` を機械の表記のまま出さない（中身を推測して「記録なし」などとは書かない）。
  const countOf = (map: Record<string, number>, key: string): number => map[key] ?? 0;
  expect(countOf(got.src, "unknown"), "unknown がそのまま出ている").toBe(0);
  /* 「分からない」を出す語は 未確認 / 該当なし / 評価なし に揃える画面の約束がある
   * （てびきの「未確認」の項）。第 159 回では一時「不明」を入れてしまった
   * （2026-08-09 実測: ビルド後に利用者へ出る「不明」はその 1 箇所だけで、てびきに無い語。
   * 同じ種の欠陥は 2026-09-23 にもある – カードだけが「受付状況不明」と出て直している）。 */
  expect(countOf(got.src, "不明"), "てびきに無い「不明」を出している").toBe(0);
  expect(countOf(got.fld, "不明"), "てびきに無い「不明」を出している").toBe(0);
  expect(
    countOf(got.src, "未確認"),
    "unknown をてびきの語（未確認）に寄せていない",
  ).toBeGreaterThan(0);
  // てびきが、公式確認の欄で同じ語を使うことを載せている（画面の語が案内に有る）。
  const help = readFileSync(join(site, "index.html"), "utf8");
  const entry = help.slice(help.indexOf("<dt>未確認</dt>"));
  const dd = entry.slice(0, entry.indexOf("</dd>"));
  expect(dd.replace(/<[^>]*>/g, ""), "てびきが確認元で同じ語を使うことを書いていない").toContain(
    "確認元",
  );
  // 収録の実データで確認範囲が日本語化されている。
  expect(
    Object.keys(got.fld).filter((k) => k.includes("日付")).length,
    "確認範囲が日本語化されていない",
  ).toBeGreaterThan(0);
  // 知らない語は翻訳せずそのまま残す（無い語を作らない）。
  expect(got.mystery).toContain("日付・mystery_field");
  expect(got.mystery).toContain("mystery-source");
  // 機械の判定名しか無い行は、それが読み取り箇所だと分かる言い方にする。
  expect(got.onlySelector).toContain("公式ページ内の表の締切欄");
});

it("行の詳細の公式確認の日時は利用者の端末の時刻合わせに左右されない（SPEC §7）", () => {
  /* 表の日時は `fmtJst` が +09:00 固定で計算し、ヘッダーにも「日時は JST で出しています」と
   * 書いてある。行の詳細の公式確認の欄だけが `toLocaleString("ja-JP")` を使っていて、
   * これは利用者の端末の時刻合わせで変わる（2026-08-09 実測: `2026-08-01T18:30:00Z` が
   * TZ=UTC で `2026/8/1 18:30:00`、TZ=Asia/Tokyo で `2026/8/2 3:30:00`、
   * TZ=America/Los_Angeles で `2026/8/1 11:30:00`。次回確認予定は
   * `2026/8/9 21:00` と `2026/8/10 6:00` に分かれ、日付その物がずれた）。
   * 出張先で端末を現地に合わせる人は珍しくなく、そのとき同じ行の表と詳細が違う日時を
   * 書く。`toLocaleString` は数の区切りでも既に避けることにしてある（`countJa` の comment）。 */
  const app = siteRuntime("app.js");
  const script = [
    "const esc = (x) => String(x);",
    // `fmtJst` は `pad` と `WEEKDAY_JA` を使うので、もろもろビルド成果から取る。
    /const WEEKDAY_JA = \[[^\]]*\]/.exec(app)?.[0] ?? "",
    `const pad = (${jsFunction(app, "pad")});`,
    `const fmtJst = (${jsFunction(app, "fmtJst")});`,
    `const verificationSummary = (${jsFunction(app, "verificationSummary")});`,
    "const fs = await import('node:fs');",
    `const data = JSON.parse(fs.readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    // 1) 表示の語: JST のラベルを付けて、一覧と同じ形（`2026-08-02(日) 03:30 JST`）で出す。
    "const probe = verificationSummary({",
    "  verification: {",
    "    last_verified_at: '2026-08-01T18:30:00Z',",
    "    next_check_at: '2026-08-09T21:00:00Z',",
    "    source_class: 'official-cfp',",
    "    status: 'verified',",
    "  },",
    "  evidence: [],",
    "});",
    "const shown = (label) => (probe.match(new RegExp('<b>' + label + '</b> ([^<]*)')) || [, ''])[1];",
    // 2) 収録の全タイムスタンプで `fmtJst` と同じ結果になること（書き写しのズレを見る）。
    "const stamps = [];",
    "let compared = 0; let agreed = 0;",
    "for (const c of data.conferences)",
    "  for (const ed of c.editions || [])",
    "    for (const dl of ed.deadlines || []) {",
    "      const v = dl.verification; if (!v) continue;",
    "      for (const key of ['last_verified_at', 'next_check_at']) {",
    "        const raw = v[key]; if (typeof raw !== 'string' || !raw) continue;",
    "        compared += 1;",
    "        const out = verificationSummary({ verification: v, evidence: [] });",
    "        const want = fmtJst(new Date(raw));",
    "        if (out.includes(want)) agreed += 1;",
    "        else if (stamps.length < 3) stamps.push({ key, raw, want });",
    "      }",
    "    }",
    "console.log(JSON.stringify({",
    "  tz: process.env.TZ || '', 確認: shown('公式確認'), 次回: shown('次回確認予定'),",
    "  compared, agreed, stamps,",
    "}));",
  ].join("\n");
  const run = (tz: string) =>
    spawnSync("node", ["--input-type=module", "-e", vmSafeSource(script)], {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, TZ: tz },
    });
  const zones = ["UTC", "Asia/Tokyo", "America/Los_Angeles"];
  const results = zones.map((tz) => {
    const proc = run(tz);
    expect(proc.status, `${tz}: ${proc.stderr}`).toBe(0);
    return JSON.parse(proc.stdout) as {
      tz: string;
      確認: string;
      次回: string;
      compared: number;
      agreed: number;
      stamps: unknown[];
    };
  });
  // 端末の時刻合わせが変わっても、出る日時が変わらない。
  const first = results[0];
  for (const [i, got] of results.entries()) {
    expect(got.確認, `${zones[i]} で公式確認の日時が変わった`).toBe(first.確認);
    expect(got.次回, `${zones[i]} で次回確認予定の日時が変わった`).toBe(first.次回);
  }
  // 一覧と同じ形（`-` 区切りの日付・曜日・時刻・JST の語）。
  expect(first.確認, "JST を名乗らない、または一覧と違う形の日時になっている").toMatch(
    /^\d{4}-\d{2}-\d{2}\([日月火水木金土]\) \d{2}:\d{2} JST$/,
  );
  // 収録の実データで一覧の計算式と一致する（内側の書き写しがズレていない）。
  expect(first.compared, "検査できるタイムスタンプが無かった").toBeGreaterThan(0);
  expect(first.agreed, `fmtJst と違う日時を出している: ${JSON.stringify(first.stamps)}`).toBe(
    first.compared,
  );
});

it("CSV のファイル名の日は端末の時刻合わせに左右されない（SPEC §7）", () => {
  /* ファイル名 `kamiyobi-deadlines-<YYYYMMDD>.csv` の日付は `new Date()` のローカル日付を
   * 使っていた（2026-08-09 実測: JST で 8/10 0:30 の瞬間に保存すると、UTC の端末では
   * `kamiyobi-deadlines-20260809.csv`、日本の端末では `kamiyobi-deadlines-20260810.csv`）。
   * このサイトは「日時は JST で出しています」と宣言し、一覧の日付も JST 固定で計算して
   * いるので、同じ日に保存したファイルの日付が人によってズレた（夜に締切をまとめる、
   * 出張先で端末を現地に合わせる、で起きます）。 */
  const app = siteRuntime("app.js");
  const script = [
    "const RealDate = Date;",
    // 保存した瞬間を固定する（この瞬間は JST と UTC で日付が違うことを下に確かめる）。
    "const FIXED = RealDate.parse('2026-08-09T15:30:00Z');",
    "globalThis.Date = class extends RealDate {",
    "  constructor(...a) { if (a.length) super(...a); else super(FIXED); }",
    "  static now() { return FIXED; }",
    "};",
    "let downloaded = '';",
    "globalThis.Blob = class { constructor(parts) { this.parts = parts; } };",
    "globalThis.URL = { createObjectURL: () => 'blob:fake' };",
    "globalThis.document = {",
    "  createElement: () => ({ click() {}, set download(v) { downloaded = v; }, get download() { return downloaded; } }),",
    "  body: { appendChild() {}, removeChild() {} },",
    "};",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const exportShownCsv = (${jsFunction(app, "exportShownCsv")});`,
    "const shown = [{ t: FIXED, conf: { key: 'demo', title: 'Demo', categories: [] }, ed: { year: 2026 }, dl: { kind: 'paper' }, kind: 'paper' }];",
    "exportShownCsv();",
    // 基準: 同じ瞬間の JST の日付（+09:00 で数える。画面の日時の数え方と同じ）。
    "const jst = new RealDate(FIXED + 9 * 3600000);",
    "const utc = new RealDate(FIXED);",
    // 注入する文字列の中ではテンプレート相当の記号を使わない（lint の指摘が増えるため、
    // 連結で同じ日付の組み立てを書く）。
    "const pad2 = (n) => String(n).padStart(2, '0');",
    "const fmt = (x) => String(x.getUTCFullYear()) + pad2(x.getUTCMonth() + 1) + pad2(x.getUTCDate());",
    "console.log(JSON.stringify({",
    "  tz: process.env.TZ || '', downloaded, jst: fmt(jst), utc: fmt(utc),",
    "}));",
  ].join("\n");
  const zones = ["UTC", "Asia/Tokyo", "America/Los_Angeles"];
  const results = zones.map((tz) => {
    const proc = spawnSync("node", ["--input-type=module", "-e", vmSafeSource(script)], {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, TZ: tz },
    });
    expect(proc.status, `${tz}: ${proc.stderr}`).toBe(0);
    return JSON.parse(proc.stdout) as { tz: string; downloaded: string; jst: string; utc: string };
  });
  // 基準の瞬間が JST と UTC で違う日であること（検査が空振りしない）。
  expect(results[0].jst === results[0].utc, "基準の瞬間が JST と UTC で同じ日になっている").toBe(
    false,
  );
  const first = results[0];
  for (const [i, got] of results.entries()) {
    expect(got.downloaded, `${zones[i]} でファイル名が変わった`).toBe(first.downloaded);
  }
  // JST の日付を使う（UTC の日付ではない）。
  expect(first.downloaded).toBe(`kamiyobi-deadlines-${first.jst}.csv`);
  expect(first.downloaded).not.toBe(`kamiyobi-deadlines-${first.utc}.csv`);
});

it("リンクについていた検索語で行が落ちていても、種別のせいにせずその行を開く（SPEC §7）", () => {
  /* `?q=…&row=…` のように、検索語行と行の目印を同時に含む URL がある（`writeUrl` は
   * モードを問わず両方を書き出す。/detail を開いたまま検索を打ち直す動きでも生まれる）。
   * 従来はその行が一覧に無い理由を「過ぎた締切」「推定」「表に出さない種別」の三つで
   * しか見ておらず、それ以外（検索語・ランク・期間窓・分野などの絞り込み）は種別のせいと
   * 誤解する文を出していた（2026-08-09 実測: 表に出る `paper` の行へのリンクで
   * 「その行は表に出さない種別（採否通知・カメラレディなど）なので…」が出ていた）。
   * 送った人の画面では出ていた行なので、受け取った側で必要最小限の条件を外して開く。 */
  const app = siteRuntime("app.js");
  const recPath = `file://${join(site, "recommender.js")}`;
  const dataPath = join(site, "data.json");
  const script = [
    `const { default: Rec } = await import(${JSON.stringify(recPath)});`,
    "const fs = await import('node:fs');",
    `const data = JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    `const rowDateOnlyState = (${jsFunction(app, "rowDateOnlyState")});`,
    `const rowIsPast = (${jsFunction(app, "rowIsPast")});`,
    `const rowShareKeyJa = (${jsFunction(app, "rowShareKeyJa")});`,
    `const sharedRowState = (${jsFunction(app, "sharedRowState")});`,
    `const sharedRowNotice = (${jsFunction(app, "sharedRowNotice")});`,
    `const loosenSharedRowConditions = (${jsFunction(app, "loosenSharedRowConditions")});`,
    `const restoreDrawerFromUrl = (${jsFunction(app, "restoreDrawerFromUrl")});`,
    // 表に出る種別の正本はセレクトの選択肢と同じ（書き写さない）。
    /const SELECTABLE_KINDS = \[[^\]]*\];/.exec(app)?.[0],
    "const rows = Rec.candidateRows(data.conferences, now);",
    "globalThis.Date = { now: () => now };",
    // 画面と同じ条件で `shown` を組み直す（`render` の代わり。検索語・推定・過去・種別）。
    // 抜き出した関数が参照する自由変数は、必ず上のスコープに置く（第 143 回の教訓）。
    "let state = { mode: 'deadlines', q: '', kind: '', rank: '', win: 'all',",
    "  est: false, domestic: false, online: false, past: false, cats: [] };",
    "let shown = [];",
    "let calls = [];",
    "let pendingDrawerKey = '';",
    "let selectedIndex = -1;",
    "const live = {};",
    // 常時受付のジャーナル行は「種別」で選んだときだけ出るので、ここでも同じにしておく。
    "const redraw = () => {",
    "  const m = Rec.searchMatcher(state.q, now);",
    "  return rows.filter((r) => (state.est || !r.est)",
    "    && (state.past || !rowIsPast(r, now))",
    "    && SELECTABLE_KINDS.indexOf(r.kind) >= 0",
    "    && (state.kind ? r.kind === state.kind : r.kind !== 'journal')",
    "    && m(r.hay));",
    "};",
    "const toForm = () => { calls.push('toForm'); };",
    "const render = () => { calls.push('render'); shown = redraw(); };",
    "const ensureRowsDrawn = () => { calls.push('draw'); };",
    "const updateRowSelection = () => { calls.push('select'); };",
    "const openDrawer = (r) => { calls.push('open:' + (r && r.kind)); };",
    "const $ = () => ({ set textContent(v) { live.v = v; }, get textContent() { return live.v || ''; } });",
    "const make = (pastRow) => {",
    "  const target = rows.filter((r) => r.kind === 'paper' && !r.est",
    "    && (pastRow ? rowIsPast(r, now) : !rowIsPast(r, now)))[0];",
    "  state = { mode: 'deadlines', q: 'zzzありえない検索語zzz', kind: '', rank: '',",
    "    win: 'all', est: false, domestic: false, online: false, past: false, cats: [] };",
    "  calls = [];",
    "  live.v = '';",
    "  shown = redraw();",
    "  pendingDrawerKey = rowShareKeyJa(target);",
    "  selectedIndex = -1;",
    "  restoreDrawerFromUrl();",
    "  return {",
    "    見つかる: shown.some((r) => rowShareKeyJa(r) === pendingDrawerKey),",
    "    calls: calls.slice(), live: live.v || '', q: state.q, past: state.past,",
    "    est: state.est, 種別: target.kind,",
    "  };",
    "};",
    "console.log(JSON.stringify({ 未来: make(false), 過去: make(true) }));",
  ].join("\n");
  const proc = spawnSync("node", ["--input-type=module", "-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  type Got = {
    見つかる: boolean;
    calls: string[];
    live: string;
    q: string;
    past: boolean;
    est: boolean;
    種別: string;
  };
  const got = JSON.parse(proc.stdout) as { 未来: Got; 過去: Got };
  for (const key of ["未来", "過去"] as const) {
    const one = got[key];
    expect(one.種別, "検査に使った行の種別がおかしい").toBe("paper");
    // 噓の文を出さない（表に出る種別なのに種別のせいにしない）。
    expect(one.live, `${key}の行で種別のせいにしている`).not.toContain("表に出さない種別");
    expect(one.live, `${key}の行で「収録に無い」と噓を言っている`).not.toContain(
      "この収録に見当たりません",
    );
    // 外したものを名指しで書く（黙って条件を変えない）。
    expect(one.live, `${key}の行で条件を外したことを書いていない`).toContain(
      "その行を開くために、リンクについていた条件を自分から外しました",
    );
    expect(one.live, `${key}の行で検索語を名指ししていない`).toContain("検索語");
    // 本当にその行が一覧へ戻る（「行の目印が出ない」扱いにしない）。
    expect(one.見つかる, `${key}の行が一覧に戻っていない`).toBe(true);
    expect(one.calls, `${key}の行に選択の目印を付けていない`).toContain("draw");
    expect(one.calls).toContain("select");
    expect(one.calls[one.calls.length - 1]).toBe("open:paper");
    expect(one.q, "検索語が残ったままだった").toBe("");
    // 最小限だけ触る（推定の行を外していない）。
    expect(one.est, "推定の行まで外している").toBe(false);
  }
  // 過ぎた行のリンクでは「過去の締切も表示」が必要なので、それは入る。
  expect(got.過去.past, "過ぎた行のリンクで「過去の締切も表示」が入っていない").toBe(true);
  // 未来の行のリンクでまで過去表示を勝手に外さない。
  expect(got.未来.past, "未来の行のリンクで「過去の締切も表示」まで外している").toBe(false);
});

it("投稿先を探す画面の順位が無い行を横棒の記号にしない（SPEC §7）", () => {
  /* 内訳の chip と比較文は、順位が無いとき横棒（U+2014）を出していた。順位は上位の
   * 候補にだけ付く（語彙検索の順位は言葉が重なった行にだけ、意味検索の順位は上位にだけ
   * 付く）ので、この状態は珍しくない（2026-08-09 実測: ビルドした `venueRecommendations`
   * に意味検索の点を与えて候補を 200 件出すと、44 件が「順位 —」、3 件が
   * 「言葉の一致（語彙検索）で — 位」になっていた。例は `cade` で語彙 0 点・
   * 意味の近さ 0.899・意味検索 1 位）。横棒は支援技術で読まれず、値が壊れたのか
   * 順位が無いのか利用者には判別できない。 */
  const app = siteRuntime("app.js");
  const detail = jsFunction(app, "makeDetailRow");
  // 抜き出した内訳の組み立ての中に、記号だけの値が残っていないこと。
  expect(detail, "内訳に横棒の記号が値として残っている").not.toContain(`"—"`);
  expect(detail, "内訳に縦棒の記号が値として残っている").not.toContain(`"―"`);
  // 語で出す方に切り替わっている（ビルド後の成果物で確かめる）。
  expect(detail, "順位が無いことを語で書いていない").toContain("順位は出ていません");
  expect(detail, "語彙検索の点が無いことを語と実数で書いていない").toContain("点で順位は無く");
  // 記号を使わない方針は、行の詳細の比較文にも及んでいる（他の箇所に横棒が残って
  // いないか、ビルド全体を一度見る）。
  const quoted = app.match(/["'`]—["'`]/g) || [];
  expect(
    quoted,
    `ビルド後のコードに横棒だけを値にした箇所が残っている: ${quoted.length} 箇所`,
  ).toHaveLength(0);

  // 上の書き方が正しいための条件を、ビルドした検索で確かめる。
  //  (1) 語彙検索の順位は「言葉が重なった行（語彙の点が 0 より大きい行）」にだけ付く。
  //      これが崩れると「N 点で順位は無く」という文が噓になる（N が 0 ではなくなる）。
  //  (2) 順位は上位 `topN` までしか付かないので、点があっても順位が無い行が生まれる
  //      （`topN` を小さくして、収録の大きさに関わらず必ず起きることを確かめる）。
  const recPath = `file://${join(site, "recommender.js")}`;
  const dataPath = join(site, "data.json");
  const script = [
    `const { default: Rec } = await import(${JSON.stringify(recPath)});`,
    "const fs = await import('node:fs');",
    `const data = JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Rec.candidateRows(data.conferences, now);",
    "const paper = [",
    "  'Title: Storage-efficient checkpointing for large-scale LLM training on clusters',",
    "  'Abstract: Periodic state saving with erasure coding across object stores reduces',",
    "  'bandwidth at the expense of recovery latency in HPC environments.',",
    "  'Keywords: fault tolerance, checkpointing, storage systems',",
    "].join('\\n');",
    "const lines = Rec.parsePaperLines(paper);",
    // 意味検索が動いている状態を再現する（鍵から決まる値なので実行のたびに同じになる）。
    "const sem = {};",
    "for (const r of rows) {",
    "  const key = String((r.conf && r.conf.key) || '');",
    "  if (!key) continue;",
    "  let h = 0;",
    "  for (const ch of key) h = (h * 31 + ch.codePointAt(0)) % 10007;",
    "  sem[key] = (h % 900) / 1000;",
    "}",
    "const run = (topN) =>",
    "  Rec.venueRecommendations(rows, lines, sem, now, {",
    "    venueCats: ['hpc', 'system'],",
    "    fieldedLexical: true,",
    "    topN,",
    "  })",
    "    .filter((x) => x.fit.score >= 10)",
    "    .slice(0, 200);",
    "const wide = run(200);",
    "const narrow = run(3);",
    // (1) 語彙の順位が欠ける行は、語彙の点が 0 の行だけ。
    "let lexMismatch = 0;",
    "let lexNoRank = 0;",
    "for (const x of wide) {",
    "  if (!x.fit.lexicalRank) lexNoRank += 1;",
    "  if (Boolean(x.fit.lexicalRank) !== x.fit.lexicalScore > 0) lexMismatch += 1;",
    "}",
    // (2) 点があるのに順位が無い行（`topN` の外）。
    "let semNoRank = 0;",
    "for (const x of narrow) {",
    "  if ((x.fit.semanticScore || 0) > 0 && !x.fit.semanticRank) semNoRank += 1;",
    "}",
    "console.log(JSON.stringify({",
    "  shown: wide.length,",
    "  lexNoRank,",
    "  lexMismatch,",
    "  narrowShown: narrow.length,",
    "  semNoRank,",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["--input-type=module", "-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as {
    shown: number;
    lexNoRank: number;
    lexMismatch: number;
    narrowShown: number;
    semNoRank: number;
  };
  expect(got.shown, "候補が一件も出ない画面では検査できない").toBeGreaterThan(0);
  // (1) 「N 点で順位は無く」が噓にならないこと（順位が無い行の語彙の点は必ず 0）。
  expect(got.lexMismatch, "語彙の順位の有無と点の一致が崩れた（文を見直す）").toBe(0);
  // (2) 点があっても順位が無い行が実際に生まれる（無くなったら語で書く案内ごと見直す）。
  expect(got.narrowShown, "候補が出ない画面では検査できない").toBeGreaterThan(0);
  expect(got.semNoRank, "順位が欠ける行が生まれなくなった（案内ごと見直す）").toBeGreaterThan(0);
});

it("効いているキーと画面のショートカット案内・てびきの並び替えの導線がズレない（SPEC §7）", () => {
  /* `onKeydown` は `j` / `k` のほかに `ArrowUp` / `ArrowDown` も選択行の移動に使って
   * いるのに、画面の案内（「ショートカット: j / k 選択 | …」）とてびきのキーボードの項の
   * どちらにも矢印が出ていなかった（2026-08-09 実測: 処理しているキーは
   * `/`・`ArrowDown`・`ArrowUp`・`Enter`・`Escape`・`d`・`j`・`k` の 8 種で、案内は 6 種）。
   * また列の見出しは `tabindex="0"` + `Enter` / `スペース` で並び替えが効くのに、
   * てびきはマウスで「押す」話しか書いておらず、キーボードだけの利用者には
   * 並び替えの導線が届いていなかった。 */
  const app = siteRuntime("app.js");
  const html = readFileSync(join(site, "index.html"), "utf8");
  // 1) ビルド後のコードが実際に受け取っているキーの集合。
  const handler = jsFunction(app, "onKeydown");
  const handled = [
    ...new Set(
      [...handler.matchAll(/e\.key === "([^"]+)"/g)].map((m) => (m[1] === undefined ? "" : m[1])),
    ),
  ].filter((k) => k !== "");
  expect(handled.sort(), "想定していないキーの受け取り方になった（案内も直す）").toEqual(
    ["/", "ArrowDown", "ArrowUp", "Enter", "Escape", "d", "j", "k"].sort(),
  );
  // 2) 画面に出るショートカット案内が、受け取っているキーを全部書いている。
  const hint = html.slice(
    html.indexOf("ショートカット:"),
    html.indexOf("</span>", html.indexOf("ショートカット:")),
  );
  expect(hint.length, "画面のショートカット案内が見つからない").toBeGreaterThan(0);
  // 読み方の対応（矢印キーは画面では ↑ / ↓、Esc は Esc と書く）。
  const notation: Record<string, string> = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    Escape: "Esc",
  };
  for (const key of handled) {
    expect(hint, `画面の案内に ${key}（${notation[key] || key}）が書かれていない`).toContain(
      notation[key] || key,
    );
  }
  // 3) 並び替えの導線: 見出しがフォーカス出来て、Enter / スペースで効くこと。
  const ths = [...html.matchAll(/<th\b[^>]*data-sort="[^"]*"[^>]*>/g)].map((m) => m[0]);
  expect(ths.length, "並び替え出来る列の見出しが見つからない").toBeGreaterThan(0);
  for (const th of ths) {
    expect(th.includes('tabindex="0"'), `見出しがタブで移動できない: ${th}`).toBe(true);
  }
  expect(
    /e\.key === "Enter" \|\| e\.key === " "/.test(app),
    "見出しの Enter / スペースで並び替えが効かない",
  ).toBe(true);
  // 4) てびきのキーボードの項に、並び替えの導線が書かれていること。
  const kb = html.slice(html.indexOf('<dt class="only-keyboard">キーボードで一覧を動かす</dt>'));
  const entry = kb.slice(0, kb.indexOf("</dd>") + 5);
  expect(entry.length, "てびきのキーボードの項が見つからない").toBeGreaterThan(0);
  for (const word of ["Tab", "見出し", "並び替え", "スペース", "↑", "↓"]) {
    expect(entry, `てびきのキーボードの項に ${word} が無い`).toContain(word);
  }
  // ソートできる列の正本と見出しが一致している（案内に列名を書いたので、ズレたら気づく）。
  const keys = JSON.parse(/const SORTABLE_KEYS = (\[[^\]]*\])/.exec(app)?.[1] || "[]") as string[];
  const thKeys = ths.map((th) => /data-sort="([^"]*)"/.exec(th)?.[1] || "");
  expect([...thKeys].sort()).toEqual([...keys].sort());
});

it("データ生成からの日数は JST の暦日で数える（SPEC §7）", () => {
  /* 「データは N 日前に生成されたものです」の N が経過 24 時間で数えていた。
   * この画面は生成時刻も一覧の日時も JST で出していて、「残り」も JST の暦日が正本
   * なので、生成時刻の直後に並ぶ「N 日前」だけ別単位で数えると隣に書いた日時と
   * 合わなかった。ビルドした `dataAgeNoteJa` で実測:
   *   JST 8/6 23:00 生成 → JST 8/9 01:00 閲覧: 経過 2 日（旧: 警告なし）/ 暦日 3 日（新: 警告）
   *   JST 8/6 23:00 生成 → JST 8/10 00:30 閲覧: 経過 3 日（旧: 「3 日前」）/ 暦日 4 日（新: 「4 日前」）
   * 警告が遅くとも約一日遅れて届くと、古い一覧を最新と誤る失敗を防げない。 */
  const rec = join(site, "recommender.js");
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    // 生成は JST 2026-08-06 23:00（UTC では 8/6 14:00。暦日だけ跨界隈に置く）。
    "const gen = Date.parse('2026-08-06T14:00:00Z');",
    "const note = (iso) => Recommender.dataAgeNoteJa(new Date(gen).toISOString(), Date.parse(iso));",
    // 経過 24 時間と JST 暦日がズレる 2 点を見る。
    "const earlyMorning = note('2026-08-08T16:00:00Z'); // JST 8/9 01:00, 経過2日/暦日3日",
    "const lateNight = note('2026-08-09T15:30:00Z'); // JST 8/10 00:30, 経過3日/暦日4日",
    // 生成当日（JST で同日）は何も言わない。
    "const sameDay = note('2026-08-06T14:30:00Z'); // JST 8/6 23:30, 暦日 0 日",
    "console.log(JSON.stringify({",
    "  threshold: Recommender.dataStaleDaysJa,",
    "  earlyMorning,",
    "  lateNight,",
    "  sameDay,",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    threshold: number;
    earlyMorning: string;
    lateNight: string;
    sameDay: string;
  };
  // 暦日 3 日目で警告が出る（経過 2 日では出ない旧挙動に戻ったら落ちる）。
  expect(
    out.earlyMorning,
    "JST 暦日 3 日目で警告が出ていない（経過 24 時間で数え直した？）",
  ).toContain("データは 3 日前");
  // 暦日 4 日目は「4 日前」（経過 3 日の「3 日前」で止まっていたら落ちる）。
  expect(out.lateNight, "日数が JST 暦日ではなく経過 24 時間で止まっている").toContain(
    "データは 4 日前",
  );
  expect(out.lateNight).not.toContain("3 日前");
  // 生成当日（JST 暦日で同日）は何も言わない。閾値はてびきの値（書き写さず実装から取る）。
  expect(out.sameDay, "生成当日に警告が出ている").toBe("");
  expect(out.threshold).toBe(3);
  // てびきが数え方（JST の暦日）を宣言していること。
  const html = readFileSync(join(site, "index.html"), "utf8");
  expect(html, "てびきが日数の数え方（JST の暦日）を書いていない").toContain("JST の暦日");
});

it("CSV の種別列は画面と同じ日本語の語で、英字の内部表記を書かない（SPEC §7）", () => {
  /* deadlinesToCsv は種別を 3 件だけの表（abstract/paper/journal）で訳していて、それ
   * 以外の種別は内部表記をそのまま出していた（2026-08-09 実測: `notification` /
   * `camera_ready` / `rebuttal_end` / `other` / `rebuttal_start` / `review_release` /
   * `registration` / `supplementary`）。**正直な到達性の記録**: 収録のそれらの行は
   * 一覧に出さない種別（`SELECTABLE_KINDS` は abstract/paper/journal のみ）で、画面の
   * CSV は `shown` を渡すため、現時点で利用者が英字の入った CSV を得る経路は無い。
   * ビルドが書く `data.csv`（全収録のフラット表）は正本の `kindLabelTable` を使って
   * 既に正しく、ここだけが古い表を別に持つ唯一の経路だった。種別を表に出す変更をした
   * 瞬間に英字が漏れる地雷なので、分野列が `categoryLabelJa` を使うのと同じ形で正本に
   * 揃えた。この検査は「既知の種別なら内部表記を書かない」という関数の契約を見る。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(DATA, now);",
    // RFC4180 の読み方で 1 行ずつ分ける（会議名などにカンマが入る）。
    "function splitLine(line) {",
    "  const out = [];",
    "  let cur = '', quoted = false;",
    "  for (let i = 0; i < line.length; i++) {",
    "    const ch = line[i];",
    "    if (quoted) {",
    "      if (ch === '\"' && line[i + 1] === '\"') { cur += '\"'; i++; }",
    "      else if (ch === '\"') quoted = false;",
    "      else cur += ch;",
    "    } else if (ch === '\"') quoted = true;",
    "    else if (ch === ',') { out.push(cur); cur = ''; }",
    "    else cur += ch;",
    "  }",
    "  out.push(cur);",
    "  return out;",
    "}",
    "const csv = Recommender.deadlinesToCsv(rows, now);",
    "const lines = csv.split('\\r\\n').filter((l) => l.length);",
    "const header = splitLine(lines[0]);",
    "const at = header.indexOf('種別');",
    "const cells = lines.slice(1).map((l) => splitLine(l)[at]);",
    "const widths = new Set(lines.map((l) => splitLine(l).length));",
    "const labels = Recommender.kindLabelTable();",
    "const kinds = lines.slice(1).map((l) => {",
    "  const c = splitLine(l);",
    "  return c[at];",
    "});",
    // 内部表記のまま（日本語を含まない）セルが残っていないか。
    "const asciiCells = [...new Set(cells.filter((c) => c && !/[ぁ-んァ-ン一-龥]/.test(c)))];",
    // CSV の種別列が、その行の種別から画面のラベル表で引いた語と一致するか。
    "const kindsInData = lines.slice(1).map((l, i) => String((rows[i].dl && rows[i].dl.kind) || rows[i].kind || ''));",
    "const mismatch = kindsInData",
    "  .map((k) => labels[k] || k)",
    "  .filter((want, i) => want !== cells[i]).length;",
    // 直前の 3 件の表では訳せなかった種別（= 旧バグで英字が出ていた行）が実際に有ること。
    "const oldTableKinds = { abstract: 1, paper: 1, journal: 1 };",
    "const wasAscii = kindsInData.filter((k) => k && !oldTableKinds[k] && labels[k]).length;",
    "console.log(JSON.stringify({",
    "  header, at, dataRows: lines.length - 1, widths: [...widths],",
    "  distinct: [...new Set(cells)].sort(),",
    "  asciiCells, mismatch, wasAscii,",
    "  allLabeled: [...new Set(cells)].every((c) => Object.values(labels).includes(c)),",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    header: string[];
    at: number;
    dataRows: number;
    widths: number[];
    distinct: string[];
    asciiCells: string[];
    mismatch: number;
    wasAscii: number;
    allLabeled: boolean;
  };
  expect(out.header, "CSV の見出しに種別がない").toContain("種別");
  expect(out.at).toBeGreaterThan(0);
  expect(out.dataRows).toBeGreaterThan(1000);
  expect(out.widths, "行によって列数が違う").toEqual([out.header.length]);
  // 種別列の語はすべて画面のラベル表の語（= 表計算で画面と同じ語で絞り込める）。
  expect(out.allLabeled, "CSV の種別列に画面に無い語が出ている").toBe(true);
  // 旧バグ（英字の内部表記）が 0 件であること。
  expect(
    out.asciiCells,
    `種別列に日本語でない内部表記が混ざっている: ${out.asciiCells.join(", ")}`,
  ).toEqual([]);
  expect(out.mismatch, "種別列が画面と同じ語になっていない行がある").toBe(0);
  // 空振り防止: 3 件の表では訳せなかった種別の行が実データに有ること。
  expect(out.wasAscii, "種別列の英字化を踏む行が無い（検査が空振り）").toBeGreaterThan(0);
});

it("論文の貼り付けは日本語の項目名でも 1 論文として読める（SPEC §7）", () => {
  /* 投稿先を探す画面は日本語で「タイトルと概要を…貼り付けてください」と言い、参考論文欄も
   * 日本語ラベル（タイトル | キーワード | 掲載先）を載せているのに、構造化パーサは英語の
   * 項目名（title:/abstract:）しか見ていなかった。そのため「タイトル:」「概要:」で書いた
   * 1 論文が各行に分裂し、ラベルごと title に入る壊れた候補が並んだ（2026-08-09 実測:
   * 英語ラベルの同じ内容は 1 論文に読めるのに、日本語ラベルだと 4 論文に化け、それぞれ
   * title="タイトル: …" のようになった）。参考論文欄（可視）と .txt アップロードは
   * parsePaperLines を通るので、到達経路は有る。全角コロンも吸う。ラベル表を増やさず、
   * 項目名の別名として日本語を受ける。 */
  const script = [
    "(async () => {",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    "const P = (t) => Recommender.parsePaperLines(t);",
    // 日本語ラベル（半角コロン）: 1 論文として全項目が分かれること。
    "const ja = P(['タイトル: Attention Is All You Need',",
    "  '概要: We propose the Transformer.',",
    "  'キーワード: transformer, attention',",
    "  '掲載先: NeurIPS'].join('\\n'));",
    // 全角コロン + 抄録/検索語の別名。
    "const jaWide = P('タイトル：深層学習\\n抄録：データ並列の最適化\\n検索語：ml').length;",
    // 英語ラベルは従来どおり 1 論文。
    "const en = P(['Title: X', 'Abstract: Y', 'Keywords: z'].join('\\n'));",
    // 従来動作の維持: 参考論文欄のパイプ書式（タイトル | キーワード | 掲載先）。
    "const pipe = P('SC 2026 | hpc, storage | SC');",
    // 従来動作の維持: ラベル無しの 1 行はそのまま 1 論文（title=その行）。
    "const bare = P('分散学習の高速化');",
    // タイトル行が 1 つも無い貼り付けは構造化入力とみなさない（各行に落ちる＝ゲートの維持）。
    "const noTitle = P('概要: 本文のみ\\nキーワード: x').length;",
    "console.log(JSON.stringify({",
    "  jaCount: ja.length,",
    "  jaTitle: ja[0] && ja[0].title,",
    "  jaAbs: ja[0] && ja[0].abstract,",
    "  jaKw: ja[0] && ja[0].keywords,",
    "  jaVenue: ja[0] && ja[0].venue,",
    "  jaWide, enCount: en.length, enTitle: en[0] && en[0].title,",
    "  pipeVenue: pipe[0] && pipe[0].venue, pipeCount: pipe.length,",
    "  bareCount: bare.length, bareTitle: bare[0] && bare[0].title,",
    "  noTitle,",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    jaCount: number;
    jaTitle: string;
    jaAbs: string;
    jaKw: string;
    jaVenue: string;
    jaWide: number;
    enCount: number;
    enTitle: string;
    pipeVenue: string;
    pipeCount: number;
    bareCount: number;
    bareTitle: string;
    noTitle: number;
  };
  // 日本語ラベルでも 1 論文にまとまり、ラベルが title に混ざらない。
  expect(out.jaCount, "日本語ラベルの 1 論文が各行に分裂している").toBe(1);
  expect(out.jaTitle).toBe("Attention Is All You Need");
  expect(out.jaAbs).toContain("Transformer");
  expect(out.jaKw).toContain("transformer");
  expect(out.jaVenue).toBe("NeurIPS");
  expect(out.jaWide, "全角コロンや抄録/検索語の別名が効かない").toBe(1);
  // 英語ラベルは維持。
  expect(out.enCount).toBe(1);
  expect(out.enTitle).toBe("X");
  // 参考論文欄のパイプ書式と、ラベル無し 1 行の従来動作を壊していない。
  expect(out.pipeCount, "パイプ書式の参考論文が壊れた").toBe(1);
  expect(out.pipeVenue).toBe("SC");
  expect(out.bareCount).toBe(1);
  expect(out.bareTitle).toBe("分散学習の高速化");
  // タイトル行の無い貼り付けは構造化しない（ゲートを緩めすぎていない）。
  expect(out.noTitle, "タイトル行の無い入力を 1 論文に潰してしまった").toBeGreaterThan(1);
});

it("会期は一覧・行の詳細・CSV で同じ式を使い、行の詳細が公式の英語表記を主語にしない（SPEC §7）", () => {
  /* 会期の式を一覧・行の詳細・CSV が別々に持っていた。行の詳細だけ公式ページの原文を先に
   * 出していたので、一覧が `2024-03-18(月) 〜 2024-03-21(木)` の行を開くと詳細は
   * `March 18-21, 2024` と英語だけが出ていた（2026-08-09 実測: 会期に ISO を持つ 2,971 行の
   * うち 2,933 行でズレ、既定画面にも 338 行あった）。てびきの「日時」は「表と詳細で同じ
   * 式を使う」と書いているので、案内と実装のずれでもあった。正式な日付が読める行は必ず
   * 一覧と同じ式に直し、公式表記は「原表記」として別に残す（開催地と同じ作法）。 */
  const script = [
    "import fs from 'node:fs';",
    `import Recommender from ${JSON.stringify(`file://${join(site, "recommender.js")}`)};`,
    "const R = Recommender;",
    `const DATA = JSON.parse(fs.readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const NOW = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = R.candidateRows(DATA, NOW);",
    "const HAS_ASCII_ALPHA = /[A-Za-z]/; // \\b は文字列リテラル内で不可視のバックスペースになるため使わない",
    // 壊れていた行が実際に何件有ったか（検査が空振りでないことの証明）。
    "let wasEnglish = 0;",
    "let englishNow = 0;",
    "let fallback = 0;",
    "for (const r of rows) {",
    "  const start = String((r.ed && r.ed.event_start) || '').trim();",
    "  const raw = String((r.ed && r.ed.date_text) || '').trim();",
    "  if (start && raw && HAS_ASCII_ALPHA.test(raw)) wasEnglish += 1;",
    "  const shown = R.eventCellJa(r);",
    "  if (start && HAS_ASCII_ALPHA.test(shown)) englishNow += 1;",
    "  if (!start && shown) fallback += 1;",
    "}",
    // 行単位の式: 1日だけ・期間・ISO 無し（原文）。
    "const single = R.eventCellJa({ ed: { event_start: '2026-01-05', event_end: '2026-01-05' } });",
    "const range = R.eventCellJa({ ed: { event_start: '2026-12-03', event_end: '2026-12-04' } });",
    "const rawOnly = R.eventCellJa({ ed: { date_text: 'TBD 2027' } });",
    "const nothing = R.eventCellJa({ ed: {} });",
    // CSV の会期列が画面と同じ式か（表計算へ出したときだけ書き方が違う、を弾く）。
    "const SEL = ['abstract', 'paper', 'journal'];",
    "const shownRows = rows.filter((r) => SEL.indexOf(r.kind) >= 0);",
    "const csv = R.deadlinesToCsv(shownRows, NOW);",
    "const parseLine = (line) => {",
    "  const out = [];",
    "  let cur = '';",
    "  let q = false;",
    "  for (let i = 0; i < line.length; i++) {",
    "    const ch = line[i];",
    "    if (q) {",
    "      if (ch === '\"') {",
    "        if (line[i + 1] === '\"') { cur += '\"'; i++; } else q = false;",
    "      } else cur += ch;",
    "    } else if (ch === '\"') q = true;",
    "    else if (ch === ',') { out.push(cur); cur = ''; }",
    "    else cur += ch;",
    "  }",
    "  out.push(cur);",
    "  return out;",
    "};",
    "const lines = csv.split('\\r\\n').filter((l) => l.length);",
    "const head = parseLine(lines[0]);",
    "const evIdx = head.indexOf('会期');",
    "const csvVals = new Set(lines.slice(1).map((l) => parseLine(l)[evIdx]));",
    "let csvChecked = 0;",
    "let csvMiss = 0;",
    "for (const r of shownRows) {",
    "  const want = R.eventCellJa(r);",
    "  if (!want) continue;",
    "  csvChecked += 1;",
    "  if (!csvVals.has(want)) csvMiss += 1;",
    "}",
    "console.log(JSON.stringify({ rowCount: rows.length, wasEnglish, englishNow, fallback, single, range, rawOnly, nothing, evIdx, csvChecked, csvMiss }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    rowCount: number;
    wasEnglish: number;
    englishNow: number;
    fallback: number;
    single: string;
    range: string;
    rawOnly: string;
    nothing: string;
    evIdx: number;
    csvChecked: number;
    csvMiss: number;
  };
  // 壊れていた行は大量に有った（＝この検査は空振りではない）。
  // 閾値は絶対値で書かない。テストハーネスのビルドは自分自身の固定時刻で走るため、
  // 候補行数は締切の過ぎ具合で大きく変わる（2026-08-09 固定の検査用ビルドでは 3,235 行、
  // ハーネスのビルドでは 510 行だった。割合で書かないと時刻が動いた日に検査が壊れる）。
  expect(out.rowCount, "候補行が出ていない").toBeGreaterThan(200);
  expect(out.wasEnglish, "公式表記が英語の行が見つからず、検査が空振り").toBeGreaterThan(
    Math.floor(out.rowCount / 10),
  );
  // 直後は正式な日付が読める行で英語の原文を主語にしない。
  expect(out.englishNow, "行の詳細と同じ式なのに会期が英語の原文になっている").toBe(0);
  // ISO が無い行だけ原文を主語にする（12 行あるうちの何行かは選択可能種別で画面に出る）。
  expect(out.fallback, "ISO の無い行の原文フォールバックが消えている").toBeGreaterThan(0);
  // 式の形。1日だけの行は期間を書かない。
  expect(out.single).toBe("2026-01-05(月)");
  expect(out.range).toBe("2026-12-03(木) 〜 2026-12-04(金)");
  expect(out.rawOnly).toBe("TBD 2027");
  expect(out.nothing).toBe("");
  // CSV の会期列が画面と同じ式。
  expect(out.evIdx, "CSV に対象の会期列が無い").toBeGreaterThan(-1);
  expect(out.csvChecked, "CSV と突き合わせる行が出ていない").toBeGreaterThan(
    Math.floor(out.rowCount / 10),
  );
  expect(out.csvMiss, `CSV の会期列が画面と違う行が ${out.csvMiss} 件`).toBe(0);

  // 行の詳細（ドロワー）は同じ式を呼び、公式表記を主語にしないこと。
  const runtime = siteRuntime();
  const start = runtime.indexOf("function openDrawer");
  const openBody = runtime.slice(start, runtime.indexOf("window.openDrawer", start));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(openBody).toContain("Recommender.eventCellJa(r)");
  expect(openBody, "公式表記を主語に戻していた").not.toMatch(
    /r\.ed\.date_text\s*\|\|\s*r\.ed\.event_start/,
  );
  expect(openBody).toContain("原表記: ");
});

it("会議名は CSV と同じ語が出る（表計算で画面の語が引ける。SPEC §7）", () => {
  /* 会議名列は画面で行の詳細で「タイトル + 開催年」を出す（`3DV 2024`）。CSV だけは年の
   * 足し算を持たない別実装（素の `conf.title`）で、同じ行が `3DV` になっていた（2026-08-09
   * 実測: 候補行 3,235 件のうち 2,996 件で画面と CSV の会議名が違い、既定画面の 478 行中
   * 422 件が該当）。CSV には年の列が無いので、表計算で画面で見た名前や西暦で絞り込むと
   * 0 行になり、同じ会議の別回も一つの語に潰れていた。組み立て式を
   * `site/recommender.ts` の `titleWithYearJa` に寄せて CSV を同じ語にした
   * （md を作る src/build.ts も同じ正本を呼ぶ）。 */
  const app = siteRuntime();
  const script = [
    "import fs from 'node:fs';",
    `import Recommender from ${JSON.stringify(`file://${join(site, "recommender.js")}`)};`,
    // 画面側の組み立てはビルドした app.js の実装をそのまま使う（書き写さない）。
    jsFunction(app, "titleWithYear"),
    jsFunction(app, "conferenceNameCell"),
    "const R = Recommender;",
    `const DATA = JSON.parse(fs.readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const NOW = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = R.candidateRows(DATA, NOW);",
    // エスケープの事故（第 169 回で \\b が不可視のバックスペースになった）を呼ばないよう、
    // 引用符と改行は文字組みで作る。
    "const Q = String.fromCharCode(34);",
    "const CR = String.fromCharCode(13);",
    "const LF = String.fromCharCode(10);",
    "const parseLine = (line) => {",
    "  const out = [];",
    "  let cur = '';",
    "  let q = false;",
    "  for (let i = 0; i < line.length; i++) {",
    "    const ch = line[i];",
    "    if (q) {",
    "      if (ch === Q) {",
    "        if (line[i + 1] === Q) { cur += Q; i++; } else { q = false; }",
    "      } else { cur += ch; }",
    "    } else if (ch === Q) { q = true; }",
    "    else if (ch === ',') { out.push(cur); cur = ''; }",
    "    else { cur += ch; }",
    "  }",
    "  out.push(cur);",
    "  return out;",
    "};",
    // CSV は入力行と 1:1 で並ぶ（実測で確認済み）ので位置で突き合わせる。
    "const csv = R.deadlinesToCsv(rows, NOW);",
    "const lines = csv.split(CR + LF).filter((l) => l.length);",
    "const head = parseLine(lines[0]);",
    "const nameIdx = head.indexOf('会議');",
    "const cells = lines.slice(1).map((l) => parseLine(l)[nameIdx]);",
    "let mismatch = 0;",
    "let emptyCell = 0;",
    "let withYear = 0;",
    "let wasBare = 0;",
    "const miss = [];",
    "for (let i = 0; i < rows.length; i++) {",
    "  const r = rows[i];",
    "  const shown = conferenceNameCell(r);",
    "  const cell = cells[i];",
    "  if (shown !== cell) {",
    "    mismatch += 1;",
    "    if (miss.length < 3) miss.push('画面=「' + shown + '」 CSV=「' + cell + '」');",
    "  }",
    "  if (shown && !cell) emptyCell += 1;",
    // 年が添えられていること（直前はここが空だった）。
    "  const y = r.ed && r.ed.year ? String(r.ed.year) : '';",
    "  if (y && cell.slice(-y.length) === y && cell.length > y.length) withYear += 1;",
    // 素の title と違う行＝直し前は壊れていた行（検査が空振りでない証明）。
    "  if (cell !== String(r.conf.title || '')) wasBare += 1;",
    "}",
    "console.log(JSON.stringify({ rowCount: rows.length, csvRows: cells.length, nameIdx, mismatch, emptyCell, withYear, wasBare, miss }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    rowCount: number;
    csvRows: number;
    nameIdx: number;
    mismatch: number;
    emptyCell: number;
    withYear: number;
    wasBare: number;
    miss: string[];
  };
  expect(out.rowCount, "候補行が出ていない").toBeGreaterThan(200);
  expect(out.csvRows, "CSV と候補行が 1:1 で並ばない（突き合わせの前提が変わった）").toBe(
    out.rowCount,
  );
  expect(out.nameIdx, "CSV に会議名欄が無い").toBeGreaterThan(-1);
  // 直し前は画面と CSV で会議名が違っていた（＝この検査は空振りではない）。
  expect(out.wasBare, "年が添えられた行が無く、検査が空振り").toBeGreaterThan(
    Math.floor(out.rowCount / 10),
  );
  // 画面と同じ語が CSV に出る。
  expect(out.mismatch, `画面と CSV の会議名が違う行: ${out.miss.join(" / ")}`).toBe(0);
  expect(out.emptyCell, "画面は名前を出すのに CSV は空欄の行がある").toBe(0);
  expect(out.withYear, "CSV の会議名に年が添えられていない").toBeGreaterThan(
    Math.floor(out.rowCount / 10),
  );
});

it("upcoming.md へのリンクは、ブラウザで表に整形されないことを正直に書く（SPEC §7）", () => {
  /* 締切が未定で会期だけ決まっている会は `upcoming.md` にしか載らず、画面・てびきの両方から
   * そのリンクを送っている。リンクの説明が「ブラウザでは文章で開きます」と言っていたが、
   * 実測は違った。配信先の HEAD は `content-type: text/markdown` を返し（2026-08-09 実測:
   * `https://ten82e.github.io/kamiyobi/upcoming.md`）、ビルドした `upcoming.md` は
   * 1,117 行が `|` の表組みで、会議名は 1,115 行が `[名前](URL)` のマークダウン記号のまま。
   * ブラウザは `text/markdown` を表として描画しないので、記号が並んだ文章で見えるか
   * ダウンロードされる – 「文章で開きます」は噓で、しかも押した人が表を見つけられない。 */
  const html = readFileSync(join(site, "index.html"), "utf8");
  const links = [...html.matchAll(/<a\b[^>]*href="upcoming\.md"[^>]*>/g)];
  expect(
    links.length,
    "upcoming.md へのリンクが無くなった（案内の実体が変わった）",
  ).toBeGreaterThan(0);
  for (const m of links) {
    const tag = m[0];
    expect(tag, "リンクに説明が無い").toContain("title=");
    // 「文章で開きます」という旧い噓だけを書いていないこと。
    expect(tag).not.toMatch(/文章で開きます/);
    // 実態（マークダウンの表であること・整形されない／ダウンロードされ得ること）を書くこと。
    expect(tag, "リンクの説明がマークダウンの表だと伝えていない").toContain("マークダウン");
    expect(tag, "リンクの説明がダウンロードされ得ると伝えていない").toContain("ダウンロード");
  }

  // `title` はマウスを載せたときだけ出る。触る端末では読めないので、てびきの本文にも
  // 同じ実態を書く（案内と実装のずれは画面の外側でも起きる）。
  const gStart = html.indexOf("<dt>会期のみ・締切未定</dt>");
  expect(gStart, "てびきの該当項が無い").toBeGreaterThan(-1);
  const guideNote = html.slice(gStart, html.indexOf("</dd>", gStart));
  expect(guideNote, "てびきの本文がマークダウンの表だと伝えていない").toContain("マークダウン");
  expect(guideNote, "てびきの本文がダウンロードされ得ると伝えていない").toContain("ダウンロード");
  expect(guideNote).not.toMatch(/文章で開きます/);

  // 画面の中のリンク（0 件・会期だけ確定の案内）も同じ説明を持つ。
  const runtime = siteRuntime();
  expect(runtime).toContain('upcoming.href = "upcoming.md"');
  const notice = runtime.slice(
    runtime.indexOf('upcoming.href = "upcoming.md"'),
    runtime.indexOf('upcoming.href = "upcoming.md"') + 1400,
  );
  expect(notice, "画面の中の upcoming.md リンクが実態を伝えていない").toContain("upcoming.title");
  expect(notice).toContain("マークダウン");
  expect(notice).toContain("ダウンロード");

  // 噓の無い説明にしておく根拠を、ビルド成果物自身で確認する（md はマークダウンのまま配られる）。
  const md = readFileSync(join(site, "upcoming.md"), "utf8");
  expect(md.startsWith("# "), "upcoming.md がマークダウン文書でない").toBe(true);
  const tableRows = md.split("\n").filter((l) => l.startsWith("| "));
  expect(tableRows.length, "upcoming.md に行が見つからない").toBeGreaterThan(10);
  const bracketLinks = tableRows.filter((l) => /\[[^\]]+\]\(https?:\/\//.test(l));
  expect(
    bracketLinks.length,
    "upcoming.md の会議名がマークダウンの記号で書かれていない（説明の実態が変わった）",
  ).toBeGreaterThan(0);
});

it("常時受付の行にも公式ページの URL が出る（SPEC §7）", () => {
  /* 種別で「常時受付」を選ぶと、締切を持たないジャーナルをその場で行に組み立てる
   * （`journalRows`）。この経路だけ会議レコードを `normalizeConference` を通して作っていたが、
   * その正規化が `link` を持っていなかった（型にも無い）。画面は `ed.link || conf.link` で
   * リンクを出すので、常時受付の行だけが公式ページへ飛べない形になっていた（2026-08-09 実測:
   * 常時受付 22 行のうちリンクを持つ物 0 件。同じ 22 件は収録データの `conference.link` に
   * 公式 URL を持っていた）。表のリンク・行の詳細の「公式サイトを開く」・CSV の URL 欄の
   * すべてが空で、常に投稿できる掲載先を探している人がそこで手が止まる。 */
  const rec = join(site, "recommender.js");
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    // `node -e` のソースは require とトップレベル await を同時に持てない（AGENTS.md）。
    "const { readFileSync } = await import('node:fs');",
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const srcLink = new Map();",
    "for (const c of (DATA.conferences || [])) {",
    "  if (typeof c.key === 'string' && typeof c.link === 'string' && c.link) srcLink.set(c.key, c.link);",
    "}",
    "const journals = Recommender.journalRows(DATA.conferences, now);",
    "const linkOf = (r) => String((r.ed && r.ed.link) || (r.conf && r.conf.link) || '');",
    "let missing = 0;",
    "let notWeb = 0;",
    "let invented = 0;",
    "const miss = [];",
    "for (const r of journals) {",
    "  const u = linkOf(r);",
    "  const name = String((r.conf && r.conf.title) || (r.conf && r.conf.key) || '');",
    "  if (!u) { missing += 1; if (miss.length < 3) miss.push(name); continue; }",
    "  if (!/^https?:\\/\\//.test(u)) notWeb += 1;",
    "  const src = srcLink.get(String((r.conf && r.conf.key) || ''));",
    // 収録データに有る URL を引き継ぐだけ。こちらで作り込んでいない（締切と同じで推測しない）。
    "  if (src && u !== src) invented += 1;",
    "}",
    "const CRLF = String.fromCharCode(13) + String.fromCharCode(10);",
    "const lines = Recommender.deadlinesToCsv(journals, now).split(CRLF).filter((l) => l.length);",
    // URL は最後の列（ヘッダの語で位置を決める）。
    "const head = lines[0].split(',');",
    "const urlIdx = head.indexOf('URL');",
    "const blankUrl = lines.slice(1).filter((l) => !String(l.split(',').pop() || '').trim()).length;",
    "console.log(JSON.stringify({",
    "  journalRows: journals.length,",
    "  urlIdx,",
    "  csvRows: lines.length - 1,",
    "  missing, notWeb, invented, blankUrl, miss,",
    "  sample: journals.slice(0, 2).map((r) => linkOf(r)),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout.split("\n")[0]) as {
    journalRows: number;
    urlIdx: number;
    csvRows: number;
    missing: number;
    notWeb: number;
    invented: number;
    blankUrl: number;
    miss: string[];
    sample: string[];
  };
  expect(out.journalRows, "常時受付の行が実データに無い（検査が空振り）").toBeGreaterThan(0);
  expect(out.urlIdx, "CSV に URL 欄が無い").toBeGreaterThan(-1);
  expect(out.csvRows).toBe(out.journalRows);
  expect(out.missing, `公式ページの URL が無い常時受付行: ${out.miss.join("、")}`).toBe(0);
  expect(out.notWeb, "http/https でないリンクを載せている").toBe(0);
  expect(out.invented, "収録データに無い URL を行に載せている").toBe(0);
  expect(out.blankUrl, "CSV の URL 欄が空の常時受付行がある").toBe(0);
  for (const u of out.sample)
    expect(u.startsWith("https://") || u.startsWith("http://")).toBe(true);

  // 持たせても画面が読まなければ直らない。実際に使われている式と、href 前の検査を見る。
  const app = siteRuntime();
  expect(app).toContain("r.ed.link || r.conf.link");
  expect(app, "リンクをそのまま href に置いている").toContain(
    "safeExternalUrl(r.ed.link || r.conf.link)",
  );
});

it("画面に出る語と CSV の値に計算の失敗が混ざらない（SPEC §7）", () => {
  /* 第 174 回の点検で、ビルドした成果物を見て確かめた項目は、どれも問題なしだった。画面の噓は
   * 見つからなかったが、問題なしだという事実には検査が無かった（第 167 回・第 169 回・第 170 回・
   * 第 172 回の欠陥は、どれも「別の場所が同じ値を出しているか」の検査が有ればもっと早く落ちた）。
   * そこで点検内容をそのまま検査に落とす。
   *   - CSV の全マス（45,290 マス実測）に undefined・NaN・Invalid Date・null・Infinity が無い
   *   - 狭い画面のカード化で列の名前（`data-label`）が 7 列すべてに出る
   *   - てびきの「並び順」の項に並ぶ列名が、実装の並び替え可能な列と一致する
   * いずれも実装から語を導いて比べる（数字や語を書き写さない）。 */
  const html = readFileSync(join(site, "index.html"), "utf8");
  const app = siteRuntime();

  // ---- 1. カード化の列名 == 表の見出し ----
  const headerCells = [
    ...html.slice(html.indexOf("<thead"), html.indexOf("</thead>")).matchAll(/<th\b[^>]*>([^<]*)/g),
  ]
    .map((m) => m[1].replace(/[↕↑↓]/g, "").trim())
    .filter((t) => t.length > 0);
  expect(headerCells.length, "表の見出しが見つからない").toBeGreaterThan(3);
  const cardLabels = [...app.matchAll(/td\([A-Za-z]+, "([^"]+)"/g)].map((m) => m[1]);
  expect(cardLabels.length, "カード化の列名が 1 つも付いていない").toBe(headerCells.length);
  for (const label of headerCells) {
    expect(cardLabels, `カード化したとき「${label}」の列名が消える`).toContain(label);
  }

  // ---- 2. てびきの並び順の項 == 並び替え可能な列 ----
  const sortable = [
    ...html
      .slice(html.indexOf("<thead"), html.indexOf("</thead>"))
      .matchAll(/data-sort="([a-z]+)"[^>]*>([^<]*)/g),
  ].map((m) => ({ key: m[1], label: m[2].replace(/[↕↑↓]/g, "").trim() }));
  expect(sortable.length, "並び替え可能な列が無い").toBeGreaterThan(3);
  const gStart = html.indexOf("<dt>並び順</dt>");
  expect(gStart, "てびきの並び順の項が無い").toBeGreaterThan(-1);
  const guideSort = html.slice(gStart, html.indexOf("</dd>", gStart));
  for (const col of sortable) {
    // 見出しは「日時（JST）」の様に但し書きを添えるので、てびき側は語の始めで当たる。
    const head = col.label.replace(/（.*$/, "");
    expect(guideSort, `てびきの並び順の項に「${col.label}」が書かれていない`).toContain(head);
  }
  // てびきに並んだ語が実装に無い列を指しても困るので、両側を同じ数で見ておく。
  const listed = ["残り", "日時", "会期", "会議", "ランク"].filter((w) => guideSort.includes(w));
  expect(listed.length, "てびきに並ぶ列数が実装と違う").toBe(sortable.length);

  // ---- 3. CSV の値に計算の失敗が混ざらない ----
  const rec = join(site, "recommender.js");
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    "const { readFileSync } = await import('node:fs');",
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(DATA, now);",
    // バックスラッシュ入りの正規表現を文字列に書くと不可視の制御文字になる（第 169 回で実発生）。
    // なので語の切れ目を見たい項目は部分一致で見る。
    "const BAD = ['undefined', 'NaN', 'Invalid Date', 'null', 'Infinity'];",
    "const Q = String.fromCharCode(34);",
    "const CRLF = String.fromCharCode(13) + String.fromCharCode(10);",
    "const parseLine = (line) => {",
    "  const out = [];",
    "  let cur = '';",
    "  let q = false;",
    "  for (let i = 0; i < line.length; i++) {",
    "    const ch = line[i];",
    "    if (q) {",
    "      if (ch === Q) {",
    "        if (line[i + 1] === Q) { cur += Q; i++; } else { q = false; }",
    "      } else { cur += ch; }",
    "    } else if (ch === Q) { q = true; }",
    "    else if (ch === ',') { out.push(cur); cur = ''; }",
    "    else { cur += ch; }",
    "  }",
    "  out.push(cur);",
    "  return out;",
    "};",
    "const lines = Recommender.deadlinesToCsv(rows, now).split(CRLF).filter((l) => l.length);",
    "const head = parseLine(lines[0]);",
    "let cells = 0;",
    "let bad = 0;",
    "const where = [];",
    "for (let i = 1; i < lines.length; i++) {",
    "  const cellsRow = parseLine(lines[i]);",
    "  for (let c = 0; c < cellsRow.length; c++) {",
    "    const v = cellsRow[c];",
    "    cells += 1;",
    "    if (BAD.some((w) => v.indexOf(w) >= 0)) {",
    "      bad += 1;",
    "      if (where.length < 3) where.push(head[c] + ' = ' + v.slice(0, 30));",
    "    }",
    "  }",
    "}",
    // 検出器が死んでいると「0 件」が空振りになるので、わざと壊した 1 マスで自查する。
    "const probe = parseLine('a,NaN,c').filter((v) => BAD.some((w) => v.indexOf(w) >= 0)).length;",
    "console.log(JSON.stringify({",
    "  rows: rows.length,",
    "  cols: head.length,",
    "  cells,",
    "  bad,",
    "  where,",
    "  probe,",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    rows: number;
    cols: number;
    cells: number;
    bad: number;
    where: string[];
    probe: number;
  };
  expect(out.rows, "候補行が出ていない").toBeGreaterThan(200);
  // CSV は行と 1:1 で並び、列数は全行で同じ（マスの総数はその積になる）。
  expect(out.cells, "CSV のマス数が行数と列数の積にならない").toBe(out.rows * out.cols);
  expect(out.probe, "計算の失敗を検出する検査自体が壊れている").toBe(1);
  expect(out.bad, `CSV に計算の失敗が混ざっている: ${out.where.join(" / ")}`).toBe(0);
});

it("「評価なし」で印刷すると、紙の条件にも同じ語が出る（SPEC §7）", () => {
  /* ランクの選択欄は、値 `N`（データ内部の番兵）を日本語の「評価なし」で出している –
   * 実装のコメントも「読み手には意味が伝わらない」と書いていた。ところが印刷物の条件の
   * 書き下ろしは値をそのまま書いていて、「評価なし」で絞って印刷すると紙に
   * 「ランク: N」と刷れていた（2026-08-09 実測: ビルドした describeFilters に
   * rank='N' を渡すと「検索語「HPC」 ／ ランク: N ／ …」）。紙を配った人にだけ意味が
   * 読めない語なので、選択欄と同じ式（`rankFilterLabelJa`）を使うようにした。 */
  const app = siteRuntime("app.js");
  const rec = join(site, "recommender.js");
  const body = [
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    "const RANK_UNRATED = Recommender.rankUnratedLabelJa();",
    "const meta = { textContent: '' };",
    "const cards = { children: [] };",
    "const $ = (id) => (id === 'printMeta' ? meta : id === 'recommendationCards' ? cards : null);",
    "const valueElement = () => ({ options: [{ text: '30 日以内' }], selectedIndex: 0 });",
    "const countJa = (n) => String(n);",
    "const fmtJst = () => '2026-08-09 (日) 09:00 JST';",
    "function generatedAtLabel(v) { return 'データ生成: ' + v; }",
    "const KIND_LABEL = { paper: '論文締切' };",
    "const DATA = { generated_at: '2026-08-09T09:00:00Z' };",
    "let sortKey = 'date', sortAsc = true;",
    "const sortColumnLabel = (k) => ({ date: '日時（JST）', rem: '残り', event: '会期' })[k] || '';",
    "let shown = [null, null];",
    "let state = { mode: 'deadlines', q: 'HPC', win: '30d', kind: '', rank: 'N', est: false, domestic: false, online: false, past: false, cats: [] };",
    // 印刷の但し書きは本物の 3 関数を繋いで走らせる（配線を確かめるため）。
    jsFunction(app, "rankFilterLabelJa"),
    jsFunction(app, "describeFilters"),
    jsFunction(app, "printLegendJa"),
    jsFunction(app, "fillPrintMeta"),
    "fillPrintMeta();",
    // 選択肢のラベルも同じ式を使う（規則を 2 箇所に書かない）。
    "const labelOf = (g) => Recommender.rankGradeOrderJa().map((x) => (x === g ? (x === 'N' ? RANK_UNRATED : x) : null)).filter(Boolean)[0];",
    "console.log(JSON.stringify({",
    "  out: meta.textContent,",
    "  unrated: RANK_UNRATED,",
    "  optionLabel: labelOf('N'),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(body)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as { out: string; unrated: string; optionLabel: string };
  // 紙に出る語が、選択欄と同じ語であることを正本から確かめる。
  expect(out.optionLabel, "選択肢のラベルが日本語で無い").toBe(out.unrated);
  expect(out.out, `紙の条件に選択肢と同じ語が出ていない: ${out.out}`).toContain(
    `ランク: ${out.unrated}`,
  );
  expect(out.out, `紙の条件に内部の番兵が残っている: ${out.out}`).not.toMatch(/ランク: N(\D|$)/);

  // 同じ式を両方で使っていること（書き写しが再び生まれないように）。
  const uses = app.match(/rankFilterLabelJa/g) || [];
  expect(
    uses.length,
    "条件の書き下ろしか選択肢のどちらかが別の式になっている",
  ).toBeGreaterThanOrEqual(3);
});

it("相対月の展開を、てびきは固定の日付で約束していない（SPEC §7）", () => {
  /* てびきの「今月」「来月」「再来月」「先月」の項は、展開結果の例を「来月 = 2026年10月」と
   * 書いていた。しかし 2026-08-09 のビルドで実装が返すのは 2026年9月 で、10月は
   * 「再来月」の値だった（ビルドした recommender.js で実測: 今月 2026年8月 / 来月 2026年9月 /
   * 再来月 2026年10月 / 先月 2026年7月）。静的な文に固定の日付で例を書くと、その月を離れた
   * 読者には画面と食い違う語になる – 「来月」が 2 ヶ月先だと受け取った人は出張の月を
   * 間違える。項からは日付の例を外し、「打った語 = 解決した西暦月」という形の記述に替えた。 */
  const html = readFileSync(join(site, "index.html"), "utf8");
  const helpStart = html.indexOf('id="helpPanel"');
  expect(helpStart, "てびきの欄が見つからない（検査が空振り）").toBeGreaterThan(-1);
  const help = html.slice(helpStart, html.indexOf("</details>", helpStart));
  const visible = help.replace(/<[^>]+>/g, "");

  // てびきの項に、画面で無くなっている可能性のある展開例（語 = 具体的な日付）を書かない。
  for (const word of ["今月", "来月", "再来月", "先月", "明日", "今週", "来週", "先週"]) {
    expect(visible, `てびきが「${word}」の展開例を固定の日付で書いている`).not.toMatch(
      new RegExp(`${word} = 20\\d\\d`),
    );
  }
  // 展開結果の形だけは教えてくれないと、件数欄の語が何かわからない。
  expect(visible, "展開結果の形を書いていない").toContain("打った語 = 解決した西暦月");

  // 規則そのものは実測で守られている（期待値は実装から写さず、この検査が固定した
  // 時計から導く。ずらす月数はてびきに書いた意味そのもの）。
  const rec = join(site, "recommender.js");
  const app = siteRuntime("app.js");
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    "const NOW = Date.parse('2026-08-09T00:00:00Z');",
    "const base = new Date(NOW + 9 * 3600000);",
    // 日本時間の暦月から期待する月を独立に作る（実装の月加算を写さない）。
    "const monthAt = (offset) => {",
    "  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offset, 1));",
    "  return d.getUTCFullYear() + '年' + (d.getUTCMonth() + 1) + '月';",
    "};",
    "const offsets = { 今月: 0, 来月: 1, 再来月: 2, 先月: -1 };",
    "const expanded = {};",
    "const expected = {};",
    "for (const [word, offset] of Object.entries(offsets)) {",
    "  expanded[word] = Recommender.expandRelativeMonths(word, NOW);",
    "  expected[word] = monthAt(offset);",
    "}",
    // 件数欄に書く語は本物の `relativeMonthNote` が作る（画面の文と検査が離れないように）。
    jsFunction(app, "relativeMonthNote"),
    "const note = relativeMonthNote('来月', Recommender.expandRelativeMonths('来月', NOW));",
    "console.log(JSON.stringify({ expanded, expected, note, expectedNote: '来月 = ' + monthAt(1) }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    expanded: Record<string, string>;
    expected: Record<string, string>;
    note: string;
    expectedNote: string;
  };
  for (const word of Object.keys(out.expected)) {
    expect(
      out.expanded[word],
      `「${word}」の展開が ${out.expected[word]} ではない（取り違えると画面とてびきがズレる）`,
    ).toBe(out.expected[word]);
  }
  expect(out.note, "件数欄に展開した語が出ない").toContain(out.expectedNote);
});

it("過去の締切の読み込み状態は、同じ画面上で二つの名前を持たない（SPEC §7）", () => {
  /* 「過去の締切も表示」にチェックした直後、件数欄は「全履歴を読み込み中…」、状態欄は
   * 「過去の締切を読み込んでいます…」と出していた（2026-08-09 実測）。同じ 1 回の読み込みを
   * 指すのに別の語が並び、別々の読み込みが始まったように読める。状態欄の語には
   * 「表示中のカタログ」という、画面のどこにも出ていない語も混ざっていた。名詞を 1 箇所で
   * 決め（`HISTORY_NOUN_JA`）、件数欄の短い形も状態欄の長い形もそこから作るようにした。 */
  const app = siteRuntime("app.js");
  const html = readFileSync(join(site, "index.html"), "utf8");

  // 定義その物を実行して語を取り出す（画面に出る語を、この検査に写さない）。
  const block = /(const HISTORY_NOUN_JA = [\s\S]{0,700}?const HISTORY_ERROR_JA = [^;]+;)/.exec(app);
  expect(block, "読み込み状態の語の定義が見つからない（検査が空振り）").not.toBeNull();
  const script = [
    block![1],
    "console.log(JSON.stringify({ nounJa: HISTORY_NOUN_JA, shortLoad: HISTORY_LOADING_SHORT_JA, shortErr: HISTORY_ERROR_SHORT_JA, load: HISTORY_LOADING_JA, err: HISTORY_ERROR_JA }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const words = JSON.parse(proc.stdout) as {
    nounJa: string;
    shortLoad: string;
    shortErr: string;
    load: string;
    err: string;
  };
  expect(words.nounJa.length).toBeGreaterThan(0);
  // 四つの形がすべて同じ名詞で始まる（ここで又分岐しない）。
  for (const [name, text] of [
    ["件数欄の読み込み中", words.shortLoad],
    ["件数欄の失敗", words.shortErr],
    ["状態欄の読み込み中", words.load],
    ["状態欄の失敗", words.err],
  ] as const) {
    expect(text, `${name} が同じ名詞で始まっていない（別名で読める語になる）`).toContain(
      words.nounJa,
    );
  }
  // 状態欄は『どうなったか』と『いま使える物』を書く（短い形だけでは追い切れない）。
  expect(words.err, "状態欄の語が使える範囲を伝えていない").toContain("一覧");

  // 件数欄と状態欄の両方が同じ定義を参照していること。
  expect(
    (app.match(/HISTORY_LOADING_SHORT_JA/g) || []).length,
    "件数欄が短い方を使っていない",
  ).toBeGreaterThanOrEqual(3);
  expect(
    (app.match(/HISTORY_ERROR_SHORT_JA/g) || []).length,
    "件数欄が短い方を使っていない",
  ).toBeGreaterThanOrEqual(3);
  expect(
    (app.match(/HISTORY_LOADING_JA(?!_)/g) || []).length,
    "状態欄が長い方を使っていない",
  ).toBeGreaterThanOrEqual(2);
  expect(
    (app.match(/HISTORY_ERROR_JA(?!_)/g) || []).length,
    "状態欄が長い方を使っていない",
  ).toBeGreaterThanOrEqual(2);

  // 二つ目の名前（全履歴）は、画面に出る文字列から無くなっている。
  const literals = app.match(/"[^"\n]*"/g) || [];
  expect(
    literals.filter((text) => text.includes("全履歴")),
    "画面に出る語に別名が残っている",
  ).toEqual([]);

  // てびきが、画面に出る語そのもので状態を説明している。
  const dtAt = html.indexOf("<dt>過去の締切も表示</dt>");
  expect(dtAt, "てびきの項が見つからない").toBeGreaterThan(-1);
  const entry = html.slice(dtAt, html.indexOf("</dd>", dtAt)).replace(/<[^>]+>/g, "");
  expect(entry, "てびきが読み込み中の語で説明していない").toContain(
    words.shortLoad.replace("…", ""),
  );
  expect(entry, "てびきが読み込みに失敗したときの話をしていない").toContain("失敗");
  const retry = /<button id="historyRetry"[^>]*>([^<]+)</.exec(html);
  expect(retry, "再試行のボタンが見当たらない").not.toBeNull();
  expect(entry, "てびきが再試行のボタンの名前で書いていない").toContain(String(retry![1]).trim());
  // 再試行のボタンも同じ名詞を使う（名前が又分岐しないように）。
  expect(String(retry![1]), "再試行のボタンが別の名詞になっている").toContain(words.nounJa);
});

it("入力の例を押すと、打ち込んだ物を取り消せる（SPEC §7）", () => {
  /* 投稿先を探す画面の「入力の例」（以前の群ラベルは「動作確認用サンプル」）は、
   * 欄をその例で上書きする。空のときの案内は『上のサンプルボタンで入力の形を確かめ
   * られます』と押すことを勧めていたのに、押すと打ち込んだタイトル・概要・キーワード・
   * 掲載先が告げずに消え、元に戻せなかった（2026-08-09 実測: ハンドラが
   * `setPrimaryRecord` と参考論文欄のクリアを無条件に呼んでいた）。長い概要を貼った後に
   * 形を確かめることができなかった。今は差し替え前に入力を保持し、取り消しのボタンを
   * 出す。規則は純粋な関数にしてある（画面を作らずに検査で動かせる）。 */
  const app = siteRuntime("app.js");
  const html = readFileSync(join(site, "index.html"), "utf8");

  const script = [
    jsFunction(app, "paperInputHasText"),
    jsFunction(app, "paperInputWithSample"),
    "const empty = { title: '', abstract: '', keywords: '', references: '', venue: '' };",
    "const typed = { title: '自分の論文', abstract: 'とても長い概要'.repeat(40), keywords: '', references: '', venue: '' };",
    "const blanks = { title: '   ', abstract: '', keywords: '', references: '', venue: '' };",
    "const refsOnly = { title: '', abstract: '', keywords: '', references: '先行研究 A | 先行 | ICSE', venue: '' };",
    "const out = {};",
    "for (const [name, current] of Object.entries({ empty, typed, blanks, refsOnly })) {",
    "  const swap = paperInputWithSample(current, { ...empty, title: '例のタイトル' });",
    "  out[name] = {",
    "    kept: swap.kept ? [swap.kept.title, swap.kept.abstract, swap.kept.references].join('|') : null,",
    "    next: swap.next.title,",
    "  };",
    "}",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Record<string, { kept: string | null; next: string }>;
  // 空の欄では戻す物がないので取り消しを出さない（押すたびにボタンが出るのも嘘になる）。
  expect(out.empty.kept, "空の欄でも取り消しを出している").toBeNull();
  expect(out.blanks.kept, "空白だけを取り消し可能な入力にしている").toBeNull();
  // 打ち込んでいれば、そのまま残る（タイトルと長い概要が戻る）。
  expect(out.typed.kept, "打ち込んだ概要が保持されない").toContain("とても長い概要");
  expect(out.typed.next, "例の方が入力になっていない").toBe("例のタイトル");
  // 本文欄が空でも、参考論文を挙げていれば戻す物がある。
  expect(out.refsOnly.kept, "参考論文だけの場合に取り消しが無い").toContain("先行研究 A");

  // 画面の配線: 差し替えの規則を使って書き、取り消しのボタンを出す。
  expect(app, "差し替えが規則関数を使っていない").toContain("paperInputWithSample(");
  // 例のボタンと、ファイル選んだときの差し替えが**同じ規則**を通ること（規則が又分岐して
  // 一方だけ黙って消すようにならないように。ファイル欄には「複数可」と書いてあるので、
  // 前に選んだ物が残ると読む人がいる）。
  const swaps = (app.match(/paperInputWithSample\(/g) || []).length;
  // 定義 1 箇所 + 例のボタン + ファイル選択 の 3 箇所が規則を通る（1 つでも欠ければ、
  // その道だけは黙って消す側へ戻る）。
  expect(
    swaps,
    "差し替えの規則を使う場所が足りない（黙って消す道が残っている）",
  ).toBeGreaterThanOrEqual(3);
  expect(app, "取り消しのボタンを操作していない").toContain("setPaperUndoVisible(");
  const undo = /<button id="paperUndo"[^>]*>([^<]+)</.exec(html);
  expect(undo, "取り消しのボタンが画面に無い").not.toBeNull();
  const undoLabel = String(undo![1]).trim();
  expect(undoLabel, "取り消しのボタンが日本語で何を戻すか書いていない").toContain("戻す");

  // てびきが、画面のボタン名で説明している（語を写さず、ビルドから取る）。
  const dtAt = html.indexOf("<dt>論文の入力とサンプル</dt>");
  expect(dtAt, "てびきの項が無い").toBeGreaterThan(-1);
  const entry = html.slice(dtAt, html.indexOf("</dd>", dtAt)).replace(/<[^>]+>/g, "");
  expect(entry, "てびきが取り消しのボタン名で書いていない").toContain(undoLabel);
  expect(entry, "てびきが欄を入れ替えることを隠している").toContain("入れ替えます");
  // ファイルを選んだときの差し替えも同じボタンで戻せる、と書いてあること。
  expect(entry, "てびきがファイル選択でも戻せると書いていない").toContain("PDF・TXT を選んだとき");

  // 開発向けの群ラベルは画面から無くなる。
  expect(html, "開発向けの群ラベルが残っている").not.toContain("動作確認用サンプル");
});

it("ラウンドの R 表記が、別の周目の行を混ぜない（SPEC §7）", () => {
  /* 検索は英字語を語頭だけ閉じた形で開く（`crypto` が `cryptography` に当たる）。
   * 同じ規則を `R1` にも利かせていたため、右に数字が続いても打ち切れず、1 周目を引い
   * たのに 10・11・12 周目の行が混ざっていた（2026-08-09 実測: 既定画面で `R1` が 426 行
   * に当たり、そのうち 6 行は round が 10・11・12。てびきは「CSV に書く R2 と同じ語で
   * 引ける」と書いていたので、表計算から画面に戻った人が見落とす形だった）。末尾が数字
   * の語だけ右端も閉じるようにした。英字で終わる語の前缀一致はそのまま残す。
   * 規則その物は合成した行に当てて確かめる（テスト用ビルドの収録に左右されない）。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(DATA, now);",
    "const match = (q) => Recommender.searchMatcher(q, now);",
    "const hit = (r, q) => match(q)(r.hay);",
    "const round = (r) => Number((r.dl && r.dl.round) || 0);",
    // 規則の直接検査: 末尾が数字の語は右も閉じ、英字で終わる語は語頭だけ開く。
    "  const digits = {",
    "    open: match('R1')('venue r1 paper'),",
    "    ten: match('R1')('venue r10 paper'),",
    "    glued: match('R1')('venue r1b paper'),",
    "    tenItself: match('R10')('venue r10 paper'),",
    "    tenFromOne: match('R10')('venue r100 paper'),",
    "  };",
    "  const letters = {",
    "    prefix: match('crypto')('field cryptography systems'),",
    "    plural: match('robot')('field robotics lab'),",
    "    leftGlued: match('crypto')('xcryptographyy'),",
    "  };",
    // 収録全体: 周目の数だけ、それぞれの R 表記がその周目の行にだけ当たることを見る。
    "  const seen = {};",
    "  for (const r of rows) { const n = round(r); if (n > 0) seen[n] = (seen[n] || 0) + 1; }",
    "  const perRound = Object.keys(seen).map(Number).sort((a, b) => a - b).map((n) => ({",
    "    n,",
    "    present: seen[n],",
    "    hits: rows.filter((r) => hit(r, 'R' + n)).length,",
    "    wrong: rows.filter((r) => hit(r, 'R' + n) && round(r) !== n).length,",
    "    ja: rows.filter((r) => hit(r, '第 ' + n + ' ラウンド')).length,",
    "  }));",
    "  console.log(JSON.stringify({ digits, letters, perRound, total: rows.length }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 180_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    digits: Record<string, boolean>;
    letters: Record<string, boolean>;
    perRound: { n: number; present: number; hits: number; wrong: number; ja: number }[];
    total: number;
  };
  expect(out.total, "収録行が読めていない").toBeGreaterThan(0);
  // 右端を閉じたこと。
  expect(out.digits.open, "R1 がその物の周目に当たらない").toBe(true);
  expect(out.digits.ten, "R1 が 10 周目の行をまだ返す").toBe(false);
  expect(out.digits.glued, "R1 が続きの数字以外的な語に当たる").toBe(false);
  expect(out.digits.tenItself, "R10 が自分の周目に当たらない（閉めすぎ）").toBe(true);
  expect(out.digits.tenFromOne, "R10 が 100 周目を返す").toBe(false);
  // 英字で終わる語の語頭開きは捨てていない。
  expect(out.letters.prefix, "英字語の前缀一致まで失われている").toBe(true);
  expect(out.letters.plural, "複数形への語頭開きが失われている").toBe(true);
  expect(out.letters.leftGlued, "語頭が英数字でつながる位置を許している").toBe(false);
  // 実データ: 収録されているすべての周目について、R 表記はその周目にだけ当たる。
  expect(out.perRound.length, "周目を持つ行が収録に無い（検査が空振りしている）").toBeGreaterThan(
    1,
  );
  const wide = out.perRound.filter((e) => e.n >= 10);
  for (const e of out.perRound) {
    expect(e.hits, `R${e.n} が 1 件も返さない`).toBeGreaterThan(0);
    expect(e.hits, `R${e.n} の当たった行数がその周目の行数と違う`).toBe(e.present);
    expect(e.wrong, `R${e.n} が別の周目の行を返す`).toBe(0);
    expect(e.ja, `第 ${e.n} ラウンド と R${e.n} で当たった行数が違う`).toBe(e.present);
  }
  // NOTE: この収録に 10 周目以上の行が無いときは、混入その物は上の `digits`（合成行）でだけ
  // 確かまる。本番の収録では 2026-08-09 に 6 行の混入を実測している。
  void wide;

  // てびき: 表に 1 周目を添えないことと、それでも語が引けることを書いておく。
  const html = readFileSync(join(site, "index.html"), "utf8");
  const dtAt = html.indexOf("<dt>検索</dt>");
  expect(dtAt, "検索の項が無い").toBeGreaterThan(-1);
  const entry = html.slice(dtAt, html.indexOf("</dd>", dtAt)).replace(/<[^>]+>/g, "");
  expect(entry, "てびきが 1 周目を表に添えないと書いていない").toContain("1 ラウンド目");
  expect(entry, "てびきが 1 周目の語を挙げていない").toContain("第 1 ラウンド");
  expect(entry, "てびきが CSV の書き方を挙げていない").toContain("R1");
});

it("印刷した紙が、紙に出る語を紙の説明だけで読ませる（SPEC §7）", () => {
  /* 画面のてびきは印刷時に隠れる（`@media print` で `#helpPanel` を消す）。ところが紙には
   * 画面と同じ語が刷られる。2026-08-09 実測: 既定の印刷対象 478 行のうち 280 行が
   * 「ランク未確認」で、会期未確認 114 行・開催地未確認 110 行・延長後 9 行が続く。
   * 変更前の紙にはこれらの意味がどこにも書かれておらず、受け取った人は画面を開かないと
   * 読めなかった（研究室に貼る・回覧する用途では足りない）。印刷帯に但し書きを載せ、
   * 語は正本（`recommender.js` の公開している名前）から組み立てるようにした。
   * ここで見るのは (1) 紙に出る語が漏れなく説明されていること、(2) 説明側に自作の語が
   * 無いこと、(3) 紙にだけ出ること、(4) てびきがその但し書きを画面の語で書いていること。 */
  const app = siteRuntime("app.js");
  const html = readFileSync(join(site, "index.html"), "utf8");
  const script = [
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    jsFunction(app, "printLegendJa"),
    "const legend = printLegendJa();",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(DATA, now);",
    "const printPool = rows.filter((r) => (r.kind === 'abstract' || r.kind === 'paper') && !r.est);",
    "const cr = String.fromCharCode(13, 10);",
    "const q = String.fromCharCode(34);",
    "const cells = (line) => {",
    "  const out = []; let cur = ''; let quoted = false;",
    "  for (let i = 0; i < line.length; i++) {",
    "    const ch = line[i];",
    "    if (quoted) {",
    "      if (ch === q) { if (line[i + 1] === q) { cur += ch; i++; } else quoted = false; } else cur += ch;",
    "    } else if (ch === q) quoted = true;",
    "    else if (ch === ',') { out.push(cur); cur = ''; }",
    "    else cur += ch;",
    "  }",
    "  out.push(cur); return out;",
    "};",
    "const tableCsv = Recommender.deadlinesToCsv(printPool, now);",
    "const lines = tableCsv.split(cr).filter((l) => l.length);",
    "const head = cells(lines[0]);",
    "const at = head.indexOf('状態');",
    "const counts = {};",
    "for (let i = 1; i < lines.length; i++) {",
    "  const v = cells(lines[i])[at] || '';",
    "  for (const w of v.split('・')) if (w) counts[w] = (counts[w] || 0) + 1;",
    "}",
    // 説明側が使って良い語の集合: CSV に出る値（状態・ランク・種別・締切）。
    "const all = Recommender.deadlinesToCsv(rows, now).split(cr);",
    "const seen = new Set();",
    "for (let i = 1; i < all.length; i++) {",
    "  const c = cells(all[i]);",
    "  for (const k of ['状態', 'ランク', '種別', '締切']) {",
    "    const j = head.indexOf(k);",
    "    if (j < 0) continue;",
    "    for (const w of String(c[j] || '').split('・')) if (w) seen.add(w);",
    "  }",
    "}",
    "console.log(JSON.stringify({",
    "  legend,",
    "  rows: printPool.length,",
    "  counts,",
    "  vocab: [...seen].join(String.fromCharCode(10)),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 180_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    legend: string;
    rows: number;
    counts: Record<string, number>;
    vocab: string;
  };
  expect(out.rows, "印刷対象の行が読めていない").toBeGreaterThan(0);
  const counts = Object.entries(out.counts).sort((a, b) => b[1] - a[1]);
  expect(counts.length, "紙に出る状態の語が無い（検査が空振りしている）").toBeGreaterThanOrEqual(2);
  // (1) 印刷行の 2 割以上に付く語は、紙の説明に載っていなければならない。
  const frequent = counts.filter(([, n]) => n >= out.rows * 0.2);
  expect(frequent.length, "多く付く語が無く、この検査が空振りしている").toBeGreaterThan(0);
  for (const [word, n] of frequent) {
    expect(out.legend, `紙に ${n} 行刷られる「${word}」を但し書きが説明していない`).toContain(word);
  }
  // (2) 但し書きが自作の語を紙に書かない（画面の語か CSV の値に実在するものだけ）。
  const tokens = [...out.legend.matchAll(/「([^」]+)」/g)].map((m) => m[1]);
  const lead = out.legend.slice(out.legend.indexOf(": ") + 2).split("は、")[0];
  for (const w of lead.split("・")) if (w.trim()) tokens.push(w.trim());
  // 照合先は「紙に刷られる値」と「画面に見える文」だけに絞る。実装のソース全体を照合先に
  // すると、説明文に偶々現れる語を拾って検査が実質的に効かなくなる（第 182 回に実際に踏んだ:
  // 無い語を但し書きへ足しても、コメント中の語と当たって通ってしまった）。
  const visible = html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, "");
  const hay = [out.vocab, visible].join("\n");
  for (const t of tokens) {
    if (t.length < 2) continue;
    expect(hay, `但し書きの「${t}」が画面にも CSV にも無い自作の語になっている`).toContain(t);
  }
  // (3) 紙にだけ出る（画面では隠れ、印刷で見える）。
  expect(html, "印刷の帯が画面に出る設定になっている").toMatch(
    /\.print-meta\s*\{[^}]*display:\s*none/,
  );
  expect(html, "印刷の帯が紙に出る設定が無い").toMatch(
    /\.print-meta\s*\{[^}]*display:\s*block\s*!important/,
  );
  const printBlock = /@media print\s*\{([\s\S]*?)\n\}/.exec(html);
  expect(printBlock, "印刷の取りまとめが見つからない").not.toBeNull();
  expect(printBlock![1], "印刷でてびきが消えない（紙の説明が二つになる）").toContain("#helpPanel");

  // (4) てびきが、紙の但し書きを画面の語で案内している（語を検査に写さない）。
  const prefix = out.legend.slice(0, out.legend.indexOf(": "));
  const dtAt = html.indexOf("<dt>印刷</dt>");
  expect(dtAt, "印刷の項が無い").toBeGreaterThan(-1);
  const entry = html.slice(dtAt, html.indexOf("</dd>", dtAt)).replace(/<[^>]+>/g, "");
  expect(entry, "てびきが紙の但し書きを案内していない").toContain("但し書き");
  expect(entry, "てびきが紙に出る見出しの語と違う語で書いている").toContain(prefix);

  // 点検: てびきの項は括弧が釣り合っていること（印刷の項で 1 つ開きっぱなしだった）。
  const helpStart = html.indexOf('id="helpPanel"');
  const dl = html.indexOf("<dl", helpStart);
  const dlEnd = html.indexOf("</dl>", dl);
  const items = [...html.slice(dl, dlEnd).matchAll(/<dd>([\s\S]*?)<\/dd>/g)];
  expect(items.length, "てびきの項が読めない").toBeGreaterThan(10);
  for (const m of items) {
    const text = m[1].replace(/<[^>]+>/g, "");
    const open = text.split("（").length - 1;
    const close = text.split("）").length - 1;
    expect(open - close, `てびきの項で括弧が釣り合っていない: ${text.slice(0, 40)}`).toBe(0);
  }
});

it("紙に刷られない語を、紙の但し書きが説明していない（SPEC §7）", () => {
  /* 第 182 回で載せた但し書きが、自分自身で噓を書いていた。説明していた語の 2 つが
   * 紙に現れない。行の詳細の「原表記:」は `@media print` で `#drawer` が消えるので
   * 刷られず、残り欄の横線は現状のデータで一度も出ない（2026-08-09 実測: 候補行
   * 3,235 件と期刊行 22 件の CSV に 0 件）。一方で紙に刷る「公式表記」の列と、
   * ランの三列（CCF・CORE・THCPL）が 478 行中 280 行で空欄であることは
   * 説明していなかった。紙の説明は紙に出る語だけを説明すべきなので、方向を直す。
   * ここでは (1) 但し書きが説明する語が紙に刷られる値・見出しに実在すること、
   * (2) 印刷行の 2 割以上で空欄になる列は名前を挙げて説明していること、
   * (3) 「公式表記」と「種別」の中身が別物なら、両方の列名を説明に載せることを見る。 */
  const app = siteRuntime("app.js");
  const html = readFileSync(join(site, "index.html"), "utf8");
  const script = [
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    jsFunction(app, "printLegendJa"),
    "const legend = printLegendJa();",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const cr = String.fromCharCode(13, 10);",
    "const q = String.fromCharCode(34);",
    "const cells = (line) => {",
    "  const out = []; let cur = ''; let quoted = false;",
    "  for (let i = 0; i < line.length; i++) {",
    "    const ch = line[i];",
    "    if (quoted) {",
    "      if (ch === q) { if (line[i + 1] === q) { cur += ch; i++; } else quoted = false; } else cur += ch;",
    "    } else if (ch === q) quoted = true;",
    "    else if (ch === ',') { out.push(cur); cur = ''; }",
    "    else cur += ch;",
    "  }",
    "  out.push(cur); return out;",
    "};",
    // 印刷しうる行の全体（表の行と常時受付の行）。但し書きはどちらの印刷にも出る。
    "const pool = Recommender.candidateRows(DATA, now).concat(Recommender.journalRows(DATA.conferences, now));",
    "const csv = Recommender.deadlinesToCsv(pool, now);",
    "const lines = csv.split(cr).filter((l) => l.length);",
    "const head = cells(lines[0]);",
    "const empties = {};",
    "for (let i = 1; i < lines.length; i++) {",
    "  const c = cells(lines[i]);",
    "  for (let j = 0; j < head.length; j++) if (!String(c[j] || '')) empties[head[j]] = (empties[head[j]] || 0) + 1;",
    "}",
    // 「公式表記」と「種別」の中身が重なっているか（重なっていれば二つの説明は要らない）。
    "const official = new Set();",
    "const kinds = new Set();",
    "const oi = head.indexOf('公式表記');",
    "const ki = head.indexOf('種別');",
    "for (let i = 1; i < lines.length; i++) {",
    "  const c = cells(lines[i]);",
    "  official.add(String(c[oi] || '')); kinds.add(String(c[ki] || ''));",
    "}",
    "let overlap = 0;",
    "for (const v of kinds) if (official.has(v)) overlap += 1;",
    "console.log(JSON.stringify({",
    "  legend,",
    "  rows: lines.length - 1,",
    "  unconf: Recommender.unconfirmedLabelJa(),",
    "  head,",
    "  empties,",
    "  overlap,",
    "  printable: csv,",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 180_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    legend: string;
    rows: number;
    unconf: string;
    head: string[];
    empties: Record<string, number>;
    overlap: number;
    printable: string;
  };
  expect(out.rows, "印刷しうる行が読めていない").toBeGreaterThan(0);
  // (1) 但し書きが説明する語は、紙に刷られる見出しか値に実在しなければならない。
  const tokens = [...out.legend.matchAll(/「([^」]+)」/g)].map((m) => m[1]);
  const lead = out.legend.slice(out.legend.indexOf(": ") + 2).split("は、")[0];
  for (const w of lead.split("・")) if (w.trim()) tokens.push(w.trim());
  expect(tokens.length, "但し書きが語を説明していない（検査が空振り）").toBeGreaterThan(3);
  for (const t of tokens) {
    if (t.length < 2) continue;
    expect(
      out.printable,
      `紙に刷られない語「${t}」を但し書きが説明している（紙だけを読む人には存在しない語の説明）`,
    ).toContain(t);
  }
  // (2) 既定の印刷対象で 2 割以上が空欄になる列は、並べても意味が読めないので説明する。
  // 「状態」欄の語で説明する場合（「会期未確認」など）も説明と数える。
  const sparse = out.head.filter((h) => (out.empties[h] || 0) >= out.rows * 0.2);
  expect(sparse.length, "空欄の列が無く、この検査が空振りしている").toBeGreaterThan(0);
  const explained = sparse.filter(
    (h) => out.legend.includes(h) || out.legend.includes(`${h}${out.unconf}`),
  );
  for (const h of sparse) {
    expect(
      explained.length,
      `印刷行の 2 割以上で「${h}」が空欄なのに、但し書きがその列を説明していない（説明済み: ${explained.join("・")}）`,
    ).toBe(sparse.length);
  }
  // (3) 「公式表記」と「種別」は中身が別物なので、両方の列名を説明に載せる。
  expect(out.overlap, "公式表記と種別が同じ値を共有している（前提が変わった）").toBe(0);
  for (const h of ["公式表記", "種別"]) {
    expect(out.legend, `列「${h}」が但し書きに出ない`).toContain(h);
  }
  // 画面のてびきも、但し書きが名指しで説明する列を同じ名前で案内している（語を書き写さない）。
  const dtAt = html.indexOf("<dt>印刷</dt>");
  expect(dtAt, "印刷の項が無い").toBeGreaterThan(-1);
  const entry = html.slice(dtAt, html.indexOf("</dd>", dtAt)).replace(/<[^>]+>/g, "");
  // 「開催地未確認」のように未確認の語で説明する列は、列名そのものを説明していないので、
  // てびきに列名を書くことは要求しない（部分文字列で拾わない）。
  const named = sparse.filter(
    (h) => out.legend.includes(h) && !out.legend.includes(`${h}${out.unconf}`),
  );
  expect(named.length, "列を名指しで説明する項が無く、この検査が空振りしている").toBeGreaterThan(0);
  for (const h of named) {
    expect(entry, `てびきが列「${h}」の空欄を案内していない`).toContain(h);
  }
});

it("`llms.txt` が、月の相対語を実装と違う月に決めていない（SPEC §7）", () => {
  /* `llms.txt` は AI に読ませる案内なので、ここに間違った月が書いてあると、画面を
   * 見ていない人にそのまま伝わる。2026-08-09 生成のビルドで実測: 実装は `来月` を
   * 2026年9月 に解決する（2026年10月は `再来月`）。ところが `llms.txt` は
   * `来月 = 2026年10月` と書いていた – 画面のてびきでは第 180 回ごろに直した
   * 固定の例が、こちらの文に残っていた。画面と同じ「打った語 = 解決した西暦月」の
   * 形に替え、月の語のずれ分だけを数で書くことにする。
   * ここでは (1) 文が書くずれ分が実装と一致すること、(2) 固定の月を書いている箇所が
   * あれば、その月が実装の答えと一致すること、(3) 画面と同じ形の名前が載っていることを見る。 */
  const rec = join(site, "recommender.js");
  const script = [
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    `const llms = readFileSync(${JSON.stringify(join(site, "llms.txt"))}, 'utf8');`,
    "const now = Date.parse(DATA.generated_at);",
    "const words = [['今月', 0], ['来月', 1], ['再来月', 2], ['先月', -1]];",
    "const DAY = 86400000;",
    "const jst = new Date(now + 9 * 3600000);",
    "const base = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), 1);",
    "const rows = words.map(([w, off]) => {",
    "  const d = new Date(base + off * 31 * DAY);",
    "  const y = d.getUTCFullYear();",
    "  const m = d.getUTCMonth() + 1;",
    "  const want = y + '年' + m + '月';",
    "  return { w, off, want, got: Recommender.expandRelativeMonths(w, now) };",
    "});",
    "console.log(JSON.stringify({ rows, llms }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    rows: { w: string; off: number; want: string; got: string }[];
    llms: string;
  };
  expect(out.rows.length, "月の語が読めない").toBe(4);
  // (1) 文が書くずれ分（+0 / +1 / +2 / -1 ヶ月）が、実装の答えと一致する。
  for (const r of out.rows) {
    expect(r.got, `\`${r.w}\` の解決が実装と違う（展開結果: ${r.got}）`).toBe(r.want);
  }
  // (2) 固定の月を例に書いている箇所があれば、その月は実装の答えでなければならない。
  const claims = [...out.llms.matchAll(/(今月|来月|再来月|先月)`?\s*=\s*(\d{4}年\d{1,2}月)/g)];
  for (const m of claims) {
    const row = out.rows.find((r) => r.w === m[1]);
    expect(row, `案内に \`月\` の語があるが読み取れない: ${m[0]}`).toBeDefined();
    expect(
      row!.want,
      `案内が \`${m[0]}\` と書いているが、実装は ${row!.want} と読む（生成日からずれている）`,
    ).toBe(m[2]);
  }
  expect(claims.length, "固定の月の例が復活している（実装とズレる書き方）").toBe(0);
  // (3) 画面の件数欄と同じ形の名称を使っている（書き写しで別名称にならないように）。
  expect(out.llms, "件数欄の形の説明が無い").toContain("打った語 = 解決した西暦月");
  // 四つの語をまとめて説明していること（1 語だけ説明が落ちると、その語だけが画面と違う）。
  for (const r of out.rows) {
    expect(out.llms, `案内に ${r.w} の説明が無い`).toContain(`\`${r.w}\``);
  }
});

it("書き出した CSV の残り日数が、画面の「残り」の数と全行で一致する（SPEC §7）", () => {
  /* 表計算で並び替える人は、画面の「残り」を確かめてから CSV を開く。両方の数が違えば、
   * どちらを信じるか分からなくなる。2026-08-09 生成のビルドで実測: 過ぎた行 2,317 件のうち
   * 279 件で CSV の数が 1 日大きかった（画面「2019 日前に終了」に CSV「-2020」）。
   * 画面は JST の暦日差で数えるのに、CSV の過去側は経過時間の floor を使っていたため。
   * 先の行は同じ基準だったので 0 件だった。
   * ここでは画面の関数その物（ビルドした app.js から `remain` を抜き出す）と CSV を全行で
   * 突き合わせる。画面の語を組み立てて比べるので、実装の語を検査に書き写さない。 */
  const rec = join(site, "recommender.js");
  const dataFile = join(site, "data.json");
  const appFile = join(site, "app.js");
  const script = [
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import('file://${rec}');`,
    `const APP = readFileSync('${appFile}', 'utf8');`,
    `const DATA = JSON.parse(readFileSync('${dataFile}', 'utf8'));`,
    "const CR = String.fromCharCode(13, 10);",
    "const Q = String.fromCharCode(34);",
    "function jsFunction(name) {",
    "  const i = APP.indexOf('function ' + name);",
    "  if (i < 0) throw new Error('not found: ' + name);",
    "  let depth = 0;",
    "  const start = APP.indexOf('{', i);",
    "  for (let k = start; k < APP.length; k++) {",
    "    if (APP[k] === '{') depth++;",
    "    else if (APP[k] === '}') { depth--; if (!depth) return APP.slice(i, k + 1); }",
    "  }",
    "  throw new Error('unbalanced: ' + name);",
    "}",
    "const DAY = Number(APP.match(/(?:const|var|let) DAY = ([0-9e_]+)/)[1].replace(/_/g, ''));",
    "if (!Number.isFinite(DAY) || DAY <= 0) throw new Error('DAY が読めない');",
    "const now = Date.parse(DATA.generated_at);",
    "if (!Number.isFinite(now)) throw new Error('生成時刻が読めない');",
    "const remain = new Function('Date', 'DAY',",
    "  jsFunction('remain') + '; return remain;')({ now: () => now }, DAY);",
    "function cells(line) {",
    "  const out = [];",
    "  let cur = '', inQ = false;",
    "  for (let i = 0; i < line.length; i++) {",
    "    const ch = line[i];",
    "    if (inQ) {",
    "      if (ch === Q) { if (line[i + 1] === Q) { cur += ch; i++; } else inQ = false; }",
    "      else cur += ch;",
    "    } else if (ch === Q) inQ = true;",
    "    else if (ch === ',') { out.push(cur); cur = ''; }",
    "    else cur += ch;",
    "  }",
    "  out.push(cur);",
    "  return out;",
    "}",
    "const rows = Recommender.candidateRows(DATA, now);",
    "const lines = Recommender.deadlinesToCsv(rows, now).split(CR).filter(Boolean);",
    "const head = cells(lines[0]);",
    "const iLeft = head.indexOf('残り日数');",
    "if (iLeft < 0) throw new Error('残り日数 列が無い');",
    "const bad = [];",
    "let checked = 0, pastLabeled = 0, datedLabeled = 0, skipped = 0;",
    "for (let j = 1; j < lines.length; j++) {",
    "  const row = rows[j - 1];",
    "  if (!row) continue;",
    "  const t = Number.isFinite(row.tShown) ? row.tShown : row.dateOnly ? row.tLast : row.t;",
    "  if (!Number.isFinite(t)) continue;",
    "  const label = remain(t).text;",
    "  const value = cells(lines[j])[iLeft];",
    "  const mDay = label.match(/^あと ([0-9]+) 日$/);",
    "  const mPast = label.match(/^([0-9]+) 日前に終了$/);",
    "  let want = 0;",
    "  if (label === '本日終了' || label === 'まもなく' || /^あと [0-9]+ 時間$/.test(label)) want = 0;",
    "  else if (mDay) want = Number(mDay[1]);",
    "  else if (mPast) { want = -Number(mPast[1]); pastLabeled++; }",
    "  else { skipped++; continue; }",
    "  checked++;",
    "  if (want !== 0) datedLabeled++;",
    "  if (Number(value) !== want && bad.length < 4)",
    "    bad.push('画面「' + label + '」 -> CSV「' + value + '」 ' + String(row.conf.title).slice(0, 22));",
    "}",
    "console.log(JSON.stringify({ bad, checked, pastLabeled, datedLabeled, skipped, rows: rows.length }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    bad: string[];
    checked: number;
    pastLabeled: number;
    datedLabeled: number;
    skipped: number;
    rows: number;
  };
  // 候補行を 1 行も取りこぼさずに比較していること（行数の固定値はハーネスのビルドと
  // 配信ビルドで違うので、常に全行を比べる条件にする）。
  expect(out.rows, "候補行が無い").toBeGreaterThan(100);
  expect(out.checked, "比較から漏れた行がある").toBe(out.rows);
  expect(out.skipped, "画面の語が読み解けず比較できなかった行がある").toBe(0);
  // 過去側の基準を実際に通っていること（無ければこの検査は空振りになる）。
  expect(
    out.pastLabeled,
    "「N 日前に終了」の行が無く、過去側の基準を検査できていない",
  ).toBeGreaterThan(0);
  expect(out.datedLabeled, "日数を出す行が無く、この検査は空振りしている").toBeGreaterThan(0);
  expect(out.bad, `画面と CSV の残り日数が食い違う行がある\n${out.bad.join("\n")}`).toEqual([]);
});

it("upcoming.md の「残り」が、実在しない猶予を約束していない（SPEC §7）", () => {
  /* `upcoming.md` の「残り」欄は、日・時間・分はいずれも切り下げで書く欄である。ところが分の
   * 欄だけ 1 に切り上げていた（`Math.max(1, …)`）。2026-08-09 生成のビルドで実測: 生成時刻
   * ちょうどに締まる行が「1分」と書かれていた（同じ行の画面は「まもなく」を出す）。「まだ
   * 1 分ある」と読んだ人が、締まり切った行を眺めていたことになる。
   * 検査は 2 方向。
   * (1) 通常のビルドの全行で、書いた猶予が実在し、次の単位までは届いていないこと。
   * (2) 分の欄は通常のビルドでは踏まないので、`upcoming.md` に載る最も早い締切の 30 秒前に
   *     生成時刻を置いたビルドを別途作り、その行を通す（切り上げなら「1分」と書いて落ちる）。
   * 語の形は検査側で組み立てて比べ、実装の語を検査に書き写さない。 */
  const rowsOf = (mdPath: string, jsonPath: string) =>
    [
      "const { readFileSync } = await import('node:fs');",
      `const MD = readFileSync('${mdPath}', 'utf8');`,
      `const DATA = JSON.parse(readFileSync('${jsonPath}', 'utf8'));`,
      "const now = Date.parse(DATA.generated_at);",
      "if (!Number.isFinite(now)) throw new Error('生成時刻が読めない');",
      "const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;",
      // 「2026-08-09(日) 00:00:00 UTC」の形だけ読む。末尾の「（公式 PT）」などは落として良い。
      "const INST = /^([0-9]{4})-([0-9]{2})-([0-9]{2})\\(([日月火水木金土])\\) ([0-9]{2}):([0-9]{2}):([0-9]{2}) (UTC|JST|AoE)(?:（[^）]*）)?$/;",
      // AoE は UTC-12、JST は UTC+9。表示されているInstantに戻す。
      "function instantOf(text) {",
      "  const m = text.match(INST);",
      "  if (!m) return NaN;",
      "  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]),",
      "    Number(m[5]), Number(m[6]), Number(m[7]));",
      "  if (m[8] === 'JST') return base - 9 * HOUR;",
      "  if (m[8] === 'AoE') return base + 12 * HOUR;",
      "  return base;",
      "}",
      // 「残り」欄の形を (書いた猶予, 単位) に落とす。数えられない形は数えない。
      "function claimOf(text) {",
      "  const t = text.trim();",
      "  if (t === 'まもなく') return { want: 0, unit: MIN };",
      "  let m = t.match(/^([0-9]+)分$/);",
      "  if (m) return { want: Number(m[1]) * MIN, unit: MIN };",
      "  m = t.match(/^([0-9]+)時間$/);",
      "  if (m) return { want: Number(m[1]) * HOUR, unit: HOUR };",
      "  m = t.match(/^([0-9]+)日$/);",
      "  if (m) return { want: Number(m[1]) * DAY, unit: DAY };",
      "  return null;",
      "}",
      "const bad = [], targets = [];",
      "let parsed = 0, claims = 0, soon = 0;",
      "for (const line of MD.split('\\n')) {",
      "  if (!line.startsWith('| ')) continue;",
      "  const cells = line.slice(2).split(' | ');",
      "  if (cells.length < 7 || cells[0] === '日付' || /^-+$/.test(cells[0])) continue;",
      "  const at = instantOf(cells[0].trim());",
      "  if (!Number.isFinite(at)) continue;",
      "  parsed++;",
      "  const left = at - now;",
      "  if (left > 2 * MIN && left < 170 * DAY) targets.push(String(at));",
      "  const claim = claimOf(cells[1]);",
      "  if (!claim) continue;",
      "  claims++;",
      "  if (left >= 0 && left < MIN) soon++;",
      "  // 書き方は切り下げなので、書いた猶予は実在し、次の単位までは届いていないはず。",
      "  if (left < claim.want || left >= claim.want + claim.unit) {",
      "    if (bad.length < 5)",
      "      bad.push('「' + cells[1].trim() + '」の実残り ' + Math.floor(left / MIN) + '分 ' +",
      "        cells[0].trim() + ' ／ ' + String(cells[2]).slice(0, 26));",
      "  }",
      "}",
      "console.log(JSON.stringify({ bad, parsed, claims, soon, targets }));",
    ].join("\n");
  const run = (mdPath: string, jsonPath: string) => {
    const proc = spawnSync("node", ["-e", vmSafeSource(rowsOf(mdPath, jsonPath))], {
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(proc.status, proc.stderr).toBe(0);
    return JSON.parse(proc.stdout) as {
      bad: string[];
      parsed: number;
      claims: number;
      soon: number;
      targets: string[];
    };
  };
  const main = run(join(site, "upcoming.md"), join(site, "data.json"));
  expect(main.parsed, "upcoming.md から時刻を読み取れた行が無い").toBeGreaterThan(100);
  expect(main.claims, "「残り」の猶予欄を読み取れた行が無い").toBeGreaterThan(100);
  // 締切の 30 秒前に生成したビルドで、分の欄を実際に通す。
  expect(main.targets.length, "作り直しの対象にできる締切が無い").toBeGreaterThan(0);
  const target = Math.min(...main.targets.map((t) => Number(t)));
  const stamp = new Date(target - 30_000).toISOString().replace(/\.[0-9]{3}Z$/, "Z");
  const outSub = join(mkdtempSync(join(tmpdir(), "kamiyobi-soon-")), "public");
  const built = runCli(outSub, { now: stamp, extra: ["--no-embeddings"] });
  expect(built.status, built.stderr).toBe(0);
  const sub = run(join(outSub, "upcoming.md"), join(outSub, "data.json"));
  expect(
    sub.soon,
    "締切 30 秒前のビルドで分の欄を通れていない（この検査は空振りになる）",
  ).toBeGreaterThan(0);
  expect(
    [...main.bad, ...sub.bad],
    "実在しない（または次の単位に届かない）猶予を書いた行がある",
  ).toEqual([]);
});

it("health.md の出力ファイル表が、載せないファイルを自分で言い切っている（SPEC §7）", () => {
  /* 「## 出力ファイル」の下に一部のファイルだけを並べると、読者はそれが配付物の全部だと読む。
   * 2026-08-09 生成のビルドで実測: 配付先に置くファイルは 16 件、この表は 13 件で、
   * 除く 3 件（`health.json`・`health.md`・`publish.json`）のことはどこにも書いていなかった。
   * 収録を確かめる人と、ハッシュを突き合わせる機械の両方がそこで止まる。
   * 検査は 3 点。(1) ビルド後の実ファイルと表の対応 (2) 載らないファイルが表の直前の但し書きに
   * 名前で挙がっているか (3) 但し書きが「完全な一覧」として指す `publish.json` の `artifacts` が、
   * 実ファイルを漏れなく載せているか（自分自身の `publish.json` を除く）。 */
  const md = readFileSync(join(site, "health.md"), "utf8");
  const head = md.indexOf("## 出力ファイル");
  expect(head, "health.md に見出し「出力ファイル」が無い").toBeGreaterThan(-1);
  const section = md.slice(head);
  const listed = new Set(
    [...section.matchAll(/^\| (\S+) \| [0-9]+ \| [0-9a-f]{64} \|$/gm)].map((m) => m[1]),
  );
  expect(listed.size, "health.md の出力ファイル表から行が読めない").toBeGreaterThan(5);
  const present = readdirSync(site, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const omitted = present.filter((name) => !listed.has(name)).sort();
  // このビルドでは実際に載らない物が出ている（載らない物が無くなったときは但し書きごと
  // 用がなくなるので、この検査も外す）。
  expect(
    omitted,
    "出力ファイル表が実ファイルを全て載せていて、この検査は空振りになる",
  ).not.toHaveLength(0);
  // 表の直前（但し書き）に、載らない物が名前で挙がっている。
  const tableAt = section.indexOf("\n| ");
  const note = section.slice(0, tableAt < 0 ? section.length : tableAt);
  for (const name of omitted) {
    expect(note, `但し書きが「${name}」にふれていない`).toContain(`\`${name}\``);
  }
  // 但し書きが指す先の publish.json が、本当に漏れなく全ファイルを載せているか。
  const publish = JSON.parse(readFileSync(join(site, "publish.json"), "utf8")) as {
    artifacts: Record<string, { bytes: number; sha256: string }>;
  };
  const covered = Object.keys(publish.artifacts);
  expect(
    present.filter((name) => name !== "publish.json" && !covered.includes(name)),
    "publish.json の artifacts が実ファイルを漏らしている",
  ).toEqual([]);
  // 自分自身のハッシュを持てない物だけを除いている（何でも除外して良いことにしない）。
  expect(omitted.includes("publish.json"), "publish.json が除かれていない").toBe(true);
});

it("upcoming.md の会期行の「残り」が、JST の同じ日なら同じ読みになる（SPEC §7）", () => {
  /* 「本日開催」「開催中(残り N 日)」「N 日後」は暦日で決める表記である。ところが 今日 を UTC の
   * 暦日から取っていた（`dateOnly(safeNow)`）。この表の日付は会期そのもの（時刻を持たない暦日）で、
   * サイトの一覧は JST 固定なので、日本の午前 9 時までのあいだだけ表が一日古くなる。
   * 2026-08-10 08:30 JST 生成で実測: 前日に終わった会期（WISA 2026）が「開催中(残り1日)」として
   * 載り、当日開始の CCCG 2026 と USENIX Security 2026 の 2 件が「1日」＝明日になっていた。
   * 検査は語を書き写さない。JST で同じ日の 2 時刻（生成時刻の 30 分前と 90 分後。UTC の日は
   * 変わる）で 2 通作り、会期行の並びと「残り」が同じであることを比べる。
   * 締切行を比べないのは、締切の残りは経過時間で決まるので 2 通のあいだで正当に変わるため。 */
  const nowMs = Date.parse(data.generated_at);
  const clocks = [new Date(nowMs - 30 * 60_000), new Date(nowMs + 90 * 60_000)];
  // 2 通が JST の同じ日にあること（無ければこの検査は意味を失う）。
  const jstDay = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
  expect(jstDay(clocks[1].getTime()), "2 通が JST の同じ日に無い").toBe(
    jstDay(clocks[0].getTime()),
  );
  // UTC の日は違っていなければ、直前の実装でも通ってしまう。
  expect(clocks[1].toISOString().slice(0, 10)).not.toBe(clocks[0].toISOString().slice(0, 10));

  const eventRows = (outdir: string) => {
    const md = readFileSync(join(outdir, "upcoming.md"), "utf8");
    const map = new Map<string, string>();
    for (const line of md.split("\n")) {
      if (!line.startsWith("| ")) continue;
      const cells = line.slice(2).split(" | ");
      if (cells.length < 7 || cells[3] !== "開催") continue;
      map.set(cells[2], cells[1]);
    }
    return map;
  };
  const dirs = clocks.map((clock, index) => {
    const outdir = join(mkdtempSync(join(tmpdir(), `kamiyobi-jst-day-${index}-`)), "public");
    const run = runCli(outdir, {
      now: clock.toISOString().replace(/\.[0-9]{3}Z$/, "Z"),
      extra: ["--no-embeddings"],
    });
    expect(run.status, run.stderr).toBe(0);
    return { dir: outdir, rows: eventRows(outdir) };
  });
  const [morningJst, laterJst] = dirs;
  expect(morningJst.rows.size, "会期行が 1 件も読めない（この検査は空振りになる）").toBeGreaterThan(
    0,
  );
  // 同じ日なら、載る会期も「残り」の読みも同じでなければ噓をつく。
  expect(
    [...morningJst.rows.keys()].filter((key) => !laterJst.rows.has(key)),
    "JST の同じ日に、片方にしか載らない会期がある",
  ).toEqual([]);
  const drift = [...morningJst.rows.keys()]
    .filter((key) => laterJst.rows.has(key) && morningJst.rows.get(key) !== laterJst.rows.get(key))
    .slice(0, 4)
    .map((key) => `${key}: 「${morningJst.rows.get(key)}」 -> 「${laterJst.rows.get(key)}」`);
  expect(drift, "JST の同じ日に「残り」の読みが変わる会期がある").toEqual([]);
});

it("llms.txt が data.csv の列をビルドの列定義どおりに載せる（SPEC §7）", () => {
  /* `data.csv` は README でも入口に挙がる成果物なのに、列の辞書がどの公開文書にも無かった。
   * 2026-08-09 生成のビルドで実測: 25 本の列名のうち 7 本（`rank_ccf`・`rank_core`・`edition_id`・
   * `deadline_utc`・`deadline_aoe`・`estimate_window_start`・`estimate_window_end`）は
   * `llms.txt` のどこにも出てこず、Excel で開いた人が空欄と値 'N' の違いを確かめられなかった。
   * 検査は列名を書き写さない。ビルドした `data.csv` のヘッダー行を正として、`llms.txt` の
   * 「## data.csv の列」節が同じ名前を同じ順で、空欄でない説明付きで載せることを見る。
   * 列を足した／削った／順を変えたときに辞書だけが古くなる状態を、この検査が止める。 */
  const csv = readFileSync(join(site, "data.csv"), "utf8");
  const headerLine = csv.split("\n")[0];
  expect(headerLine.includes('"'), "ヘッダー行の読み方が変わる").toBe(false);
  const columns = headerLine.split(",").map((name) => name.trim());
  expect(columns.length, "data.csv のヘッダーが読めない").toBeGreaterThan(10);

  const txt = readFileSync(join(site, "llms.txt"), "utf8");
  const head = txt.indexOf("## data.csv の列");
  expect(head, "llms.txt に「## data.csv の列」の節が無い").toBeGreaterThan(-1);
  const next = txt.indexOf("\n## ", head + 1);
  const section = txt.slice(head, next < 0 ? txt.length : next);

  const entries = section
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const at = line.indexOf("：");
      expect(at, `説明の区切り「：」が無い行: ${line.slice(0, 40)}`).toBeGreaterThan(1);
      return { name: line.slice(2, at).trim(), note: line.slice(at + 1).trim() };
    });
  expect(entries.length, "列の項目が読めない").toBeGreaterThan(10);
  expect(
    entries.map((entry) => entry.name),
    "載る列の名前が data.csv と違う",
  ).toEqual(columns);
  for (const entry of entries) {
    expect(entry.note, `列「${entry.name}」の説明が空欄`).not.toBe("");
  }
  // 「この順で N 本」という宣言が実数と合っているか（宣言を書き写すと必ずズレる）。
  const declared = /列はこの順で ([0-9]+) 本。/.exec(section);
  expect(declared, "本数の宣言が無い").not.toBeNull();
  expect(Number(declared?.[1]), "本数の宣言が data.csv の列数と違う").toBe(columns.length);
});

it("JavaScript が動かないとき、index.html が理由と読み替え先を自分で言う（SPEC §7）", () => {
  /* 学内や端末側でスクリプトを止める運用、読み込みの失敗などで JS が動かないと、この画面は
   * 黙って空になる。2026-08-09 生成のビルドで実測: JavaScript を使わないときに出る案内を
   * 一つも置いておらず、表は空・件数は「--」のまま、検索も絞り込みも押せた。
   * 検査は built の index.html から読む。 (1) 案内ブロックが 1 個ある (2) ブロックの中のリンクが
   * すべて相対パスで、しかもビルド先に実在する（配信先はサブパスの下なので、絶対パスは 404 に
   * なる。ビルドしなくなったファイルを指していてもいけない） (3) 空の表より前に出る
   * (4) 静的な HTML に締切の件数を書かない（生成のたびに古くなる語を残さない）。 */
  const html = readFileSync(join(site, "index.html"), "utf8");
  const opens = [...html.matchAll(/<noscript>/g)].length;
  expect(opens, "JavaScript を使わないときの案内が複数あるか、無い").toBe(1);
  const block = /<noscript>([\s\S]*?)<\/noscript>/.exec(html);
  expect(block, "案内ブロックの閉じが無い").not.toBeNull();
  const inner = String(block?.[1]);
  const text = inner
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  expect(text.length, "案内が空である").toBeGreaterThan(60);
  expect(text.includes("JavaScript"), "何が効かないのかが書かれていない").toBe(true);
  /* 静的な HTML に収録数の噓を置かない。締切の総数は生成のたびに動くので、ここで 3 桁以上の
   * 「N 件」を書いた瞬間に古くなる（「1 行 1 件」のような形の話は残して良い）。 */
  expect(
    /[0-9][0-9,]{2,} ?件/.test(text),
    `静的な HTML に収録数を書いている: ${text.slice(0, 60)}`,
  ).toBe(false);
  // リンクは相対パスで、実在する物だけ。
  const hrefs = [...inner.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  expect(hrefs.length, "読み替え先の案内が無い").toBeGreaterThan(0);
  for (const href of hrefs) {
    expect(href, `絶対パスのリンクはサブパス配信で切れる: ${href}`).not.toMatch(/^(?:\/|https?:)/);
    expect(existsSync(join(site, href)), `案内が指す ${href} がビルド先に無い`).toBe(true);
  }
  // 空の表より前に読む位置にあること。
  const results = html.indexOf('id="results"');
  expect(results, "一覧の目印が無い").toBeGreaterThan(-1);
  expect(html.indexOf("<noscript>"), "案内が表のうしろに回っている").toBeLessThan(results);
});

it("llms.txt の出力一覧が、ビルドが置いたファイルを一つも漏らさない（SPEC §7）", () => {
  /* `llms.txt` は機械が読む索引なのに、2026-08-09 生成のビルドで実測すると「出力一覧」は
   * 16 件中 10 件しか並べておらず、`recommendation-core.js`・`publish.js`・`icon.svg`・
   * `.nojekyll` など公開物の 4 割が何かも分からないままだった（第 189 回に health.md で
   * 見たのと同じ形）。名前はビルドの定数から生成しているので、**ビルド先に実在する物を
   * 全部載せているか**をビルドした出力から確かめる（定数を書き写さない）。
   * 載せたのに無いファイルは、その行が自分で「こういうビルドだけに出る」と説明していること。
   * 黙って載せたまま 404 を教えないようにする。 */
  const llms = readFileSync(join(site, "llms.txt"), "utf8");
  const start = llms.indexOf("## 出力一覧");
  expect(start, "出力一覧の節が無い").toBeGreaterThanOrEqual(0);
  const rest = llms.slice(start);
  const end = rest.slice(1).search(/^## /m);
  const section = end < 0 ? rest : rest.slice(0, end + 1);
  const entries = [...section.matchAll(/^- ([^：\r\n]+)：([^\r\n]*)/gm)];
  expect(entries.length, "出力一覧が空である").toBeGreaterThan(0);
  const named = entries.map((m) => m[1].trim());
  expect(new Set(named).size, "同じファイルを二回載せている").toBe(named.length);
  for (const [name, note] of entries.map((m) => [m[1].trim(), m[2].trim()] as const)) {
    expect(note.length, `説明が空欄: ${name}`).toBeGreaterThan(4);
    if (existsSync(join(site, name))) continue;
    expect(
      note.includes("出ない"),
      `ビルド先に無い ${name} を載せているのに、どのビルドに出ないのかを書いていない`,
    ).toBe(true);
  }
  for (const name of readdirSync(site)) {
    expect(named.includes(name), `ビルドが置いた ${name} が出力一覧に無い`).toBe(true);
  }
});
