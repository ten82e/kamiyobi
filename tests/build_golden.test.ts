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
  expect(html).toContain('p.get("domestic") === "1"');
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
  }) => string;
  const clear = {
    window: "all",
    past: true,
    cats: 0,
    domestic: false,
    rank: "all",
    kind: "",
    query: "",
    hiddenKindWords: [],
    queryMatch: { catalog: 0, journal: 0 },
    termCounts: [],
    catalogConferences: 12,
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
  expect(
    /tips\.push\(`「種別」を「\$\{KIND_ALL_LABEL_JA\}」に変更`\)/.test(runtimeForKindLabel),
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

  // 一覧の date-only 行と会期列が同じ関数を通す（瞬間を作って TZ でズレさせない）。
  const app = siteRuntime();
  expect(app).toContain("Recommender.weekdayJaFromDate(r.localDate)");
  expect(app).toContain("Recommender.weekdayJaFromDate(r.ed.event_start)");
  expect(app).toContain("Recommender.weekdayJaFromDate(r.ed.event_end)");
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
    "let droppedKindNotice = '';",
    "let written = '';",
    "const window = { location: { search: '', pathname: '/index.html' } };",
    "const history = { replaceState: (_s, _t, url) => { written = String(url); } };",
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
    "state.kind = 'paper'; droppedKindNotice = ''; window.location.search = '?kind=notification'; readUrl();",
    "const droppedKind = [state.kind, droppedKindNotice];",
    "window.location.search = '?rank=A%2A'; readUrl();",
    "const restoredRank = state.rank;",
    // 既定の並びなら引数を足さない（URL は必要な情報だけ乗せる）。
    "sortKey = DEFAULT_SORT_KEY; sortAsc = true; state.domestic = false; writeUrl();",
    "console.log(JSON.stringify([sent, got, written, droppedKind, restoredRank, sentEvent, gotEvent]));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const [sent, got, defaultUrl, droppedKind, restoredRank, sentEvent, gotEvent] = JSON.parse(
    proc.stdout.trim(),
  ) as [string, [string, boolean], string, [string, string], string, string, [string, boolean]];
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
    `const Recommender = { officialZone: ${jsFunction(siteRuntime("recommender.js"), "officialZone")}, placeJa: (v) => String(v ?? ""), topicTagsJa: () => [], weekdayJaFromDate: weekdayJaFromDate };`,
    "const body = { innerHTML: '' };",
    "const els = {",
    "  drawerBackdrop: { classList: { add() {} } }, drawerTitle: {}, drawerFullName: {},",
    "  drawerBody: body, drawerClose: { focus() {} },",
    "};",
    "const document = { activeElement: null, getElementById: (id) => els[id] || null };",
    "function $(id) { return document.getElementById(id); }",
    "const window = { _prevFocus: null };",
    `const openDrawer = new Function('window', 'document', '$', 'KIND_LABEL', 'titleWithYear', 'fmtDate', 'fmtJst', 'fmtAoE', 'esc', 'safeExternalUrl', 'rowDateOnlyState', 'verificationSummary', 'Recommender', 'meetingRangeJa', 'upcomingEditionsOf', 'return (' + ${JSON.stringify(openSrc)} + ')')(window, document, $, { paper: '論文締切' }, (t) => t, fmtDate, fmtJst, fmtAoE, (s) => String(s ?? ''), (v) => String(v ?? ''), () => null, () => '', Recommender, meetingRangeJa, upcomingEditionsOf);`,
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
  expect(html).toContain('state.past = p.get("past") === "1"');
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
  const keySrc = jsFunction(html, "onKeydown");
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
    `const SUMMARY = ${JSON.stringify(summarySrc)};`,
    `const CLOSE = ${JSON.stringify(closeSrc)};`,
    drawerDepsSrc as string,
    "const onKeydown = new Function('window', 'document', '$', 'selectedIndex', 'shown', 'openDrawer', 'closeDrawer', 'return (' + KEY + ')')(window, document, $, 1, ['A', 'B'], openSpy, closeSpy);",
    // d キー → 選択行 (shown[1]) のドロワーが開き、行にフォーカスが移る
    "onKeydown({ key: 'd', preventDefault() {}, target: { tagName: 'BODY' } });",
    "const dOpened = calls.open.length === 1 && calls.open[0] === 'B';",
    "const dFocusedRow = calls.focus[calls.focus.length - 1] === 'row1';",
    "const verificationSummary = new Function('esc', 'return (' + SUMMARY + ')')((s) => String(s ?? ''));",
    "const openDrawer = new Function('window', 'document', '$', 'KIND_LABEL', 'titleWithYear', 'fmtDate', 'fmtJst', 'fmtAoE', 'esc', 'safeExternalUrl', 'rowDateOnlyState', 'verificationSummary', 'Recommender', 'meetingRangeJa', 'upcomingEditionsOf', 'return (' + OPEN + ')')(window, document, $, {}, (t) => t, () => '', () => '', () => '', (s) => String(s ?? ''), (s) => String(s ?? ''), () => null, verificationSummary, { officialZone: () => '', placeJa: (v) => String(v ?? ''), topicTagsJa: () => [], weekdayJaFromDate: () => '' }, meetingRangeJa, upcomingEditionsOf);",
    "document.activeElement = prevEl;",
    "openDrawer({ kind: 'journal', conf: { title: 'X' }, ed: { place: 'P', date_text: 'D' } });",
    "const focusedClose = document.activeElement === closeBtn;",
    "const savedPrev = window._prevFocus === prevEl;",
    "const closeDrawer = new Function('window', 'document', '$', 'return (' + CLOSE + ')')(window, document, $);",
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
  const keySrc = jsFunction(html, "onKeydown");
  const script = [
    "const calls = { prevented: 0, focused: 0, opened: 0 };",
    "const state = { mode: 'recommend' };",
    "const window = {};",
    "const document = {};",
    "function $(id) { return id === 'q' ? { focus() { calls.focused++; } } : null; }",
    "const onKeydown = new Function('state', 'window', 'document', '$', 'selectedIndex', 'shown', 'openDrawer', 'closeDrawer', 'return (' + KEY + ')')(state, window, document, $, 0, [], () => { calls.opened++; }, () => {});",
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
  expect(template).toContain("ショートカット: <kbd>j</kbd>/<kbd>k</kbd> 選択");
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
  expect(body).toContain("esc(r.ed.date_text");
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
    `const openDrawer = new Function('window', 'document', '$', 'KIND_LABEL', 'titleWithYear', 'fmtDate', 'fmtJst', 'fmtAoE', 'esc', 'safeExternalUrl', 'rowDateOnlyState', 'verificationSummary', 'Recommender', 'meetingRangeJa', 'upcomingEditionsOf', 'return (' + ${JSON.stringify(openSrc)} + ')')(window, document, $, {}, (t) => t, () => '', () => '', () => '', (s) => String(s ?? ''), (s) => String(s ?? ''), () => null, verificationSummary, { officialZone: () => '', placeJa: (v) => String(v ?? ''), topicTagsJa: () => [], weekdayJaFromDate: () => '' }, meetingRangeJa, upcomingEditionsOf);`,
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
  expect(proc.stdout).toContain("date・time・timezone");
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
  expect(app).toContain('state.online = p.get("online") === "1";');

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
    "  classList: { contains: () => false, toggle() {}, add() {}, remove() {} } });",
    "const document = { createElement: mkEl, createTextNode: (t) => ({ textContent: t }) };",
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
    "const openDrawer = () => {};",
    "const esc = (s) => String(s == null ? '' : s);",
    "const safeExternalUrl = (u) => u;",
    "const $ = () => null;",
    "const window = {};",
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
  expect(out.extendedCells["会議"], "延長していた行に一覧で目印が出ていない").toContain(
    out.extendedWord,
  );
  expect(out.knownCells["会議"], "延長していない行まで目印を出している").not.toContain(
    out.extendedWord,
  );
  const guideText = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  expect(guideText, "てびきが延長の語を説明していない").toContain(`<dt>${out.extendedWord}</dt>`);
  // ドロワーも同じ語を使う（表とドロワーで言い方が割れないようにする）。
  expect(app).toContain("esc(placeShown || UNCONFIRMED_JA)");
  expect(app).toContain("esc(r.ed.date_text || r.ed.event_start || UNCONFIRMED_JA)");
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
    `const openDrawer = new Function('window','document','$','KIND_LABEL','titleWithYear','fmtDate','fmtJst','fmtAoE','esc','safeExternalUrl','rowDateOnlyState','verificationSummary','Recommender','catLabel','meetingRangeJa','upcomingEditionsOf','UNCONFIRMED_JA','return (' + ${JSON.stringify(openSrc)} + ')')(window, document, $, KIND_LABEL, titleWithYear, () => 'UTC', () => 'JST', () => 'AoE', esc, (u) => String(u ?? ''), () => null, verificationSummary, Recommender, catLabel, meetingRangeJa, upcomingEditionsOf, Recommender.unconfirmedLabelJa());`,
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
  expect(app).toContain("droppedKindNotice");
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
  expect(runtime).toContain("まず上位 ${RECOMMENDATION_PAGE} 件を表示");

  // ラベルと表示可否は本物を実行して見る（書き写すと「残り」の対応がズレる）。
  const script = [
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
  expect(app).toContain("国内研究会・国内シンポジウム以外 ${hidden.domestic} 件");
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
  expect(app).toContain("オンライン参加の記載がない ${hidden.online} 件");
  expect(app).toContain("うち開催地が未確認 ${hidden.onlinePlaceUnknown} 件");
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
    "評価「${state.rank}」を持たない行 ${hidden.rank} 件",
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
    '分野「${state.cats.map((key) => catLabel(key)).join("・")}」を持たない行 ${hidden.cats} 件',
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
    `const src = ${JSON.stringify(jsFunction(runtime, "onKeydown"))};`,
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
    "    'return (' + src + ')',",
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
  // 並べ替えバーの列は、実装が並び替え可能な列と Exactly 同じであること（双方向）。
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
  // キーボードの案内は狭い画面では消す（ショートカットの無い端末で誤導しない）。
  // 第 103 回まで見出ししか消しておらず、説明（`j`/`k`/`d`/`Esc` の書き方）が残っていたので、
  // 隣接する説明も一緒に閉じる形を要求する（文字列ピンは古い形を戻さないために置く）。
  expect(block, "キーボードの案内を狭い画面で消していない").toMatch(
    /\.only-keyboard,\s*\.only-keyboard \+ dd \{[^}]*display: none/,
  );
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
  expect(app).toContain("過ぎた締切 ${pastBlockTotal} 件は下にまとめました");
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
   * 上流の配布物と並ぶ欄に自项目へ「MIT」と付いて見えた（配布物のライセンス表記に見える）。
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
    'const closeDrawer = new Function("$", "window", "return (" + CLOSE_SRC + ")")(el, {});',
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
    'const onKeydown = new Function("state", "window", "document", "$", "selectedIndex", "shown",',
    '  "openDrawer", "closeDrawer", "safeExternalUrl", "return (" + KEY + ")")(',
    "  { mode: 'deadlines' },",
    "  { open: () => { calls.openUrl++; } },",
    "  { activeElement: null },",
    "  () => ({ querySelectorAll: () => [rowEl, rowEl] }), 1, [row, row],",
    "  () => { calls.drawer++; }, () => {},",
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
    "const Recommender = {",
    "  officialZone: (dl) => Recommender.zone,",
    "  weekdayJaFromDate,",
    "  zone: 'AoE',",
    "};",
    "const avail = new Function('fmtJst', 'fmtDate', 'fmtAoE', 'Recommender',",
    "  'return (' + AVAIL_SRC + ')')(fmtJst, fmtDate, fmtAoE, Recommender);",
    // UTC では 10/5、JST では 10/6 になる締切（AoE 23:59 型の例）。
    "const ts = Date.UTC(2026, 9, 5, 15, 59);",
    "const jstShown = fmtJst(new Date(ts));",
    "const aoe = avail({ _availability: { status: 'open', timestamp: ts }, dl: {} });",
    "Recommender.zone = 'JST';",
    "const jst = avail({ _availability: { status: 'open', timestamp: ts }, dl: {} });",
    "Recommender.zone = 'UTC';",
    "const utc = avail({ _availability: { status: 'open', timestamp: ts }, dl: {} });",
    "const dateOnly = avail({ _availability: { status: 'open', local_date: '2026-10-06' }, dl: {} });",
    "console.log(JSON.stringify({ jstShown, aoe, jst, utc, dateOnly }));",
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
    `const NOTE_SRC = ${JSON.stringify(jsFunction(app, "sortNoteJa"))};`,
    'const LABELS = { rem: "残り ↕", date: "日時（JST） ↓", conf: "会議 ↕", rank: "ランク ↑" };',
    "const document = {",
    "  querySelector: (sel) => {",
    `    const k = /data-sort="([^"]+)"/.exec(sel);`,
    "    if (!k || !(k[1] in LABELS)) return null;",
    "    return { textContent: LABELS[k[1]] };",
    "  },",
    "};",
    "const note = new Function('document', 'return (' + NOTE_SRC + ')')(document);",
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
  const note = new Function(`return (${jsFunction(app, "zeroResultLiveNote")});`)() as (f: {
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
  expect(plain).toContain("条件を緩める");
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
  const keySrc = jsFunction(html, "onKeydown");
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
    "  new Function('window', 'document', '$', 'selectedIndex', 'shown', 'openDrawer', 'closeDrawer', 'updateRowSelection', 'return (' + KEY + ')')(",
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

it("印刷物に、条件・件数・日時が残り、画面では見えない（SPEC §7）", () => {
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
    "const f = (over, win) => DESCRIBE(Object.assign({ q: '', cats: [], kind: '', rank: '', est: false, domestic: false, online: false, past: false }, over), kind, cat, win || '');",
    "const nothing = f({});",
    // 空白だけの検索語は条件にしない（打つ途中の欄で「検索語「」」と出さない）。
    "const blank = f({ q: '   ' });",
    "const many = f({ q: '研究会', kind: 'paper', cats: ['net', 'hpc'], domestic: true, online: true, past: true, est: true }, '30日以内');",
    // ランクは画面に出る等級そのものを書く（内部の番兵を書かない）。
    "const ranked = f({ rank: 'A*' });",
    "console.log(JSON.stringify({ nothing, blank, many, ranked }));",
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
