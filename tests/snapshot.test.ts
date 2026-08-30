/**
 * Snapshot fallback: SPEC.md section 3.5.
 * Ported from tests/test_snapshot.py.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  type BuildArgs,
  cmdBuild,
  discoverWriteAction,
  hooks,
  main,
  parseArgs,
  parseNow,
  restoreFailedSourceMaterial,
  restoreFailedSourceMaterialWithCounts,
  type SourceLoadResult,
  setRoot,
} from "../src/cli.ts";
import { type Conference, fmtUTC } from "../src/model.ts";
import {
  archiveMetadata,
  cacheMetadata,
  cacheSlot,
  fetchMetadataFor,
  fetchTarball,
  resetFetchMetadata,
  writeCacheMetadata,
} from "../src/sources/base.ts";
import {
  exactAt,
  makeConference,
  makeDeadline,
  makeEdition,
  makeFixtureCache,
  NOW_ARG,
  REPO_ROOT,
  utc,
} from "./helpers.ts";

function allUpstreamsDown(): void {
  hooks.collect = async () => ({
    groups: [[], [], []],
    failed: new Set(["ccfddl", "aideadlines"]),
  });
}

function isolatedRepo(): string {
  const root = mkdtempSync("/tmp/cfp-snap-");
  mkdirSync(join(root, "data"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "config.yaml"), join(root, "config.yaml"));
  copyFileSync(join(REPO_ROOT, "data", "overrides.yaml"), join(root, "data", "overrides.yaml"));
  return root;
}

function args(outdir: string, cache?: string): BuildArgs {
  return {
    out: outdir,
    config: "config.yaml",
    offline: true,
    now: NOW_ARG,
    cache: cache ?? join(mkdtempSync("/tmp/cfp-snap-cache-"), ".cache"),
    // 埋め込み生成は 2 モデルで数秒かかるためスナップショット検証ではスキップ
    noEmbeddings: true,
  };
}

function sourceResult(
  source: string,
  status: SourceLoadResult["status"],
  conferences: Conference[],
  values: Partial<SourceLoadResult> = {},
): SourceLoadResult {
  return {
    source,
    status,
    revision: null,
    fetchedAt: null,
    contentHash: null,
    cacheAgeSeconds: null,
    conferences,
    conferenceCount: conferences.length,
    editionCount: conferences.reduce((count, conference) => count + conference.editions.length, 0),
    deadlineCount: conferences.reduce(
      (count, conference) =>
        count + conference.editions.reduce((total, edition) => total + edition.deadlines.length, 0),
      0,
    ),
    ...values,
  };
}

describe("parseNow (CLI --now boundary)", () => {
  it.each([
    "2026-02-30T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-06-31T00:00:00Z",
    "2026-02-29T00:00:00Z",
  ])("impossible calendar date %s is rejected", (text) => {
    expect(() => parseNow(text)).toThrow("unparsable --now");
  });

  it("valid leap day is accepted", () => {
    expect(parseNow("2028-02-29T00:00:00Z").toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("valid forms are unchanged", () => {
    expect(parseNow("2026-08-15T00:00:00Z").toISOString()).toBe("2026-08-15T00:00:00.000Z");
    expect(parseNow("2026-08-15T00:00:00+09:00").toISOString()).toBe("2026-08-14T15:00:00.000Z");
    expect(parseNow(null)).toBeInstanceOf(Date);
  });

  it.each(["2026-13-01T00:00:00Z", "not-a-date"])("garbage %s still throws", (text) => {
    expect(() => parseNow(text)).toThrow("unparsable --now");
  });

  it.each(["2026-08-09T00:00:00", "2026-08-09 00:00:00"])(
    "timezone-less datetime %s is rejected so --now stays deterministic (#392)",
    (text) => {
      expect(() => parseNow(text)).toThrow("unparsable --now");
    },
  );

  it("date-only --now stays UTC midnight (#392)", () => {
    expect(parseNow("2026-08-09").toISOString()).toBe("2026-08-09T00:00:00.000Z");
  });

  it("hour 24 is rejected instead of rolling to the next day (#392)", () => {
    expect(() => parseNow("2026-08-09T24:00:00Z")).toThrow("unparsable --now");
  });
});

it("restores only failed-source venues, editions, and missing slots", () => {
  const current = [
    makeConference({
      key: "mixed",
      title: "Mixed",
      sources: ["ccfddl"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "mixed26",
          source: "ccfddl",
          deadlines: [makeDeadline("paper", "Paper", utc(2026, 9, 2))],
        }),
      ],
    }),
  ];
  const snapshot = [
    makeConference({
      key: "failed-only",
      title: "Failed",
      sources: ["aideadlines"],
      editions: [makeEdition({ year: 2026, edition_id: "failed26", source: "aideadlines" })],
    }),
    makeConference({
      key: "mixed",
      title: "Mixed",
      sources: ["ccfddl", "aideadlines"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "mixed26",
          source: "aideadlines",
          deadlines: [
            makeDeadline("abstract", "Abstract", utc(2026, 9, 1)),
            makeDeadline("paper", "Paper submission", utc(2026, 9, 1)),
            {
              ...makeDeadline("notification", "Notification", utc(2026, 9, 3)),
              evidence: [
                {
                  source_name: "ccfddl",
                  source_url: "https://example.org/ccfddl",
                  observed_at: "2026-08-01T00:00:00Z",
                  original_value: "2026-09-03",
                  confidence: "aggregator",
                },
              ],
            },
          ],
        }),
        makeEdition({ year: 2027, edition_id: "mixed27", source: "aideadlines" }),
      ],
    }),
    makeConference({ key: "removed-local", title: "Removed", sources: ["local"], editions: [] }),
  ];
  const restored = restoreFailedSourceMaterial(current, snapshot, new Set(["aideadlines"]));
  expect(restored.map((conference) => conference.key)).toEqual(["mixed", "failed-only"]);
  const mixed = restored[0]!;
  expect(mixed.editions.map((edition) => edition.edition_id)).toEqual(["mixed26", "mixed27"]);
  expect(mixed.editions[0]!.deadlines.map((deadline) => deadline.kind)).toEqual([
    "paper",
    "abstract",
  ]);
  expect(exactAt(mixed.editions[0]!.deadlines[0]!).toISOString()).toBe(
    utc(2026, 9, 2).toISOString(),
  );
  const detailed = restoreFailedSourceMaterialWithCounts(
    current,
    snapshot,
    new Set(["aideadlines"]),
  );
  expect(detailed.counts.aideadlines).toEqual({
    conferenceCount: 1,
    editionCount: 2,
    deadlineCount: 1,
  });
});

it("does not misattribute non-failed editions when another source failed (bis ghost regression)", () => {
  // snapshot の bis は sources [aideadlines, ccfddl] の混在 conference。
  // 2025 edition は ccfddl 由来 (deadline evidence も ccfddl のみ) で、failed でない
  // ccfddl に属する。aideadlines が failed のとき誤って 2025 を aideadlines と
  // 誤帰属して「source: aideadlines, deadlines: []」の ghost edition を作る
  // （2026-08-30 実測: restore 単体では正常・build 全体で bis 2025 が消えた）。
  // 修正: edition.source 明示 + deadline evidence に failed source が無ければ復元しない。
  const snapshot = [
    makeConference({
      key: "bis",
      title: "BIS",
      sources: ["aideadlines", "ccfddl"],
      editions: [
        makeEdition({
          year: 2025,
          edition_id: "bis2025",
          source: "ccfddl",
          deadlines: [
            {
              ...makeDeadline("paper", "Paper submission", utc(2025, 1, 31)),
              evidence: [
                {
                  source_name: "ccfddl",
                  source_url: "",
                  observed_at: "",
                  original_value: "2026-01-31",
                  confidence: "aggregator",
                },
              ],
            },
          ],
        }),
        makeEdition({
          year: 2026,
          edition_id: "bis2026",
          source: "ccfddl",
          deadlines: [
            {
              ...makeDeadline("paper", "Paper submission", utc(2026, 1, 25)),
              evidence: [
                {
                  source_name: "ccfddl",
                  source_url: "",
                  observed_at: "",
                  original_value: "2026-01-31",
                  confidence: "aggregator",
                },
              ],
            },
            {
              ...makeDeadline("notification", "Notification", utc(2026, 3, 9)),
              evidence: [
                {
                  source_name: "aideadlines",
                  source_url: "",
                  observed_at: "",
                  original_value: "2026-03-09",
                  confidence: "aggregator",
                },
              ],
            },
          ],
        }),
      ],
    }),
  ];
  // current 側に ccfddl のみの bis (2025/2026) が存在する（ccfddl は成功）。
  const current = [
    makeConference({
      key: "bis",
      title: "BIS",
      sources: ["ccfddl"],
      editions: [
        makeEdition({
          year: 2025,
          edition_id: "bis2025",
          source: "ccfddl",
          deadlines: [makeDeadline("paper", "Paper submission", utc(2025, 1, 31))],
        }),
      ],
    }),
  ];
  const restored = restoreFailedSourceMaterial(current, snapshot, new Set(["aideadlines"]));
  const bis = restored.find((c) => c.key === "bis");
  expect(bis).toBeDefined();
  // ghost edition が作られない: 2025 は ccfddl のまま 1 deadline。
  const ed2025 = bis!.editions.find((e) => e.year === 2025);
  expect(ed2025?.source).toBe("ccfddl");
  expect(ed2025?.deadlines.length).toBe(1);
  // 2026 は aidelines evidence を含むので復元対象: deadline が追加される。
  const ed2026 = bis!.editions.find((e) => e.year === 2026);
  expect(ed2026?.source).toBe("ccfddl");
  expect(ed2026?.deadlines.some((d) => d.kind === "notification")).toBe(true);
});

it("does not merge different source ids through a conflicting DBLP key", () => {
  const snapshot = [
    makeConference({
      key: "asiaccs",
      title: "AsiaCCS",
      sources: ["ccfddl"],
      dblp: "ccs",
      identity: { dblpKey: "ccs", sourceIds: { ccfddl: "SC/asiaccs" } },
      editions: [makeEdition({ year: 2026, edition_id: "asiaccs26", source: "ccfddl" })],
    }),
    makeConference({
      key: "ccs",
      title: "CCS",
      sources: ["ccfddl"],
      dblp: "ccs",
      identity: { dblpKey: "ccs", sourceIds: { ccfddl: "SC/ccs" } },
      editions: [makeEdition({ year: 2026, edition_id: "ccs26", source: "ccfddl" })],
    }),
  ];

  const restored = restoreFailedSourceMaterial([], snapshot, new Set(["ccfddl"]));
  expect(restored.map((conference) => conference.key).sort()).toEqual(["asiaccs", "ccs"]);
});

it("restores failed-source deadlines from a mixed edition led by local data", () => {
  const current = [
    makeConference({
      key: "mixed-local",
      title: "Mixed Local",
      sources: ["local"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "mixed-local26",
          source: "local",
          deadlines: [makeDeadline("paper", "Workshop paper", utc(2026, 8, 20))],
        }),
      ],
    }),
  ];
  const snapshot = [
    makeConference({
      key: "mixed-local",
      title: "Mixed Local",
      sources: ["local", "aideadlines"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "mixed-local26",
          source: "local",
          deadlines: [
            {
              ...makeDeadline("camera_ready", "Camera ready", utc(2026, 9, 9)),
              evidence: [
                {
                  source_name: "aideadlines",
                  source_url: "https://example.org/aideadlines",
                  observed_at: "2026-08-01T00:00:00Z",
                  original_value: "2026-09-09",
                  confidence: "aggregator",
                },
              ],
            },
          ],
        }),
      ],
    }),
  ];

  const restored = restoreFailedSourceMaterialWithCounts(
    current,
    snapshot,
    new Set(["aideadlines"]),
  );
  expect(restored.conferences[0]!.editions[0]!.deadlines.map((deadline) => deadline.kind)).toEqual([
    "paper",
    "camera_ready",
  ]);
  expect(restored.counts.aideadlines?.deadlineCount).toBe(1);
});

describe("source freshness", () => {
  const conference = (key: string, source: string) =>
    makeConference({
      key,
      title: key,
      categories: ["ai"],
      sources: [source],
      editions: [
        makeEdition({
          year: 2027,
          edition_id: `${key}27`,
          source,
          deadlines: [makeDeadline("paper", "Paper", utc(2026, 11, 1))],
        }),
      ],
    });

  it("reports fresh and cache-fallback metadata with its real age and hash", async () => {
    const root = isolatedRepo();
    setRoot(root);
    const fresh = conference("fresh-source", "ccfddl");
    const cached = conference("cached-source", "aideadlines");
    hooks.collect = async () => ({
      groups: [[fresh], [cached], []],
      failed: new Set<string>(),
      results: [
        sourceResult("ccfddl", "fresh", [fresh], {
          revision: "fresh-revision",
          fetchedAt: "2026-08-09T00:00:00.000Z",
          contentHash: "fresh-hash",
          cacheAgeSeconds: 0,
        }),
        sourceResult("aideadlines", "cache-fallback", [cached], {
          revision: "cached-revision",
          fetchedAt: "2026-08-08T23:58:00.000Z",
          contentHash: "cached-hash",
          cacheAgeSeconds: 120,
        }),
        sourceResult("local", "fresh", []),
      ],
    });
    const outdir = join(mkdtempSync("/tmp/cfp-source-meta-"), "out");
    expect(await cmdBuild({ ...args(outdir), offline: false })).toBe(0);
    const health = JSON.parse(readFileSync(join(outdir, "health.json"), "utf8")) as {
      source_status: Record<string, string>;
      source_metadata: Record<string, SourceLoadResult>;
    };
    expect(health.source_status).toMatchObject({ ccfddl: "fresh", aideadlines: "cache-fallback" });
    expect(health.source_metadata.aideadlines).toMatchObject({
      status: "cache-fallback",
      revision: "cached-revision",
      contentHash: "cached-hash",
      cacheAgeSeconds: 120,
      conferenceCount: 1,
      editionCount: 1,
      deadlineCount: 1,
    });
  });

  it("uses tarball bytes for revision identity and carries cache sidecar provenance", () => {
    const first = archiveMetadata(Buffer.from("same archive"));
    const again = archiveMetadata(Buffer.from("same archive"));
    const changed = archiveMetadata(Buffer.from("changed archive"));
    expect(first.contentHash).toBe(again.contentHash);
    expect(first.revision).toBe(`sha256:${first.contentHash}`);
    expect(changed.contentHash).not.toBe(first.contentHash);
    const slot = mkdtempSync("/tmp/cfp-cache-meta-");
    writeCacheMetadata(slot, first);
    expect(cacheMetadata(slot)).toEqual(first);
  });

  it("uses the saved cache retrieval time for fallback age without inventing content metadata", async () => {
    const cache = mkdtempSync("/tmp/cfp-cache-fallback-");
    const slot = cacheSlot(cache, "fixture/source", "main");
    const root = join(slot, "source-main");
    mkdirSync(root, { recursive: true });
    writeCacheMetadata(slot, {
      revision: "sha256:known",
      fetchedAt: "2026-08-09T00:00:00.000Z",
      contentHash: "known",
    });
    await expect(
      fetchTarball("fixture/source", "main", cache, {
        offline: true,
        now: new Date("2026-08-09T00:00:00.000Z"),
      }),
    ).resolves.toBe(root);
    expect(fetchMetadataFor("fixture/source", "main")).toMatchObject({
      status: "cache-fallback",
      revision: "sha256:known",
      contentHash: "known",
      cacheAgeSeconds: 0,
    });
  });

  it("clears process-global source metadata before every build", async () => {
    const cache = mkdtempSync("/tmp/cfp-cache-reset-");
    const slot = cacheSlot(cache, "fixture/source", "main");
    const cached = join(slot, "source-main");
    mkdirSync(cached, { recursive: true });
    writeCacheMetadata(slot, {
      revision: "sha256:known",
      fetchedAt: "2026-08-09T00:00:00.000Z",
      contentHash: "known",
    });
    await fetchTarball("fixture/source", "main", cache, { offline: true, now: utc(2026, 8, 9) });
    expect(fetchMetadataFor("fixture/source", "main")).not.toBeNull();

    const previous = hooks.collect;
    const root = isolatedRepo();
    setRoot(root);
    hooks.collect = async () => ({
      groups: [[conference("live", "ccfddl")], [], []],
      failed: new Set(["aideadlines"]),
    });
    try {
      expect(await cmdBuild(args(join(mkdtempSync("/tmp/cfp-cache-reset-out-"), "out")))).toBe(0);
      expect(fetchMetadataFor("fixture/source", "main")).toBeNull();
    } finally {
      hooks.collect = previous;
      resetFetchMetadata();
    }
  });

  it("rejects an online build before publishing an over-age cache fallback", async () => {
    const root = isolatedRepo();
    setRoot(root);
    const config = loadYaml(readFileSync(join(root, "config.yaml"), "utf8")) as Record<
      string,
      unknown
    >;
    config.health = { ...(config.health as Record<string, unknown>), max_cache_age_seconds: 60 };
    writeFileSync(join(root, "config.yaml"), dumpYaml(config), "utf8");
    const cached = conference("stale-cache", "ccfddl");
    hooks.collect = async () => ({
      groups: [[cached], [], []],
      failed: new Set<string>(),
      results: [
        sourceResult("ccfddl", "cache-fallback", [cached], {
          revision: "stale-revision",
          contentHash: "stale-hash",
          cacheAgeSeconds: 61,
        }),
        sourceResult("aideadlines", "fresh", []),
        sourceResult("local", "fresh", []),
      ],
    });
    const outdir = join(mkdtempSync("/tmp/cfp-source-stale-"), "out");
    expect(await cmdBuild({ ...args(outdir), offline: false })).toBe(2);
    expect(existsSync(join(outdir, "data.json"))).toBe(false);
  });

  it("marks failed source material restored from snapshot as snapshot-fallback", async () => {
    const root = isolatedRepo();
    setRoot(root);
    const live = conference("live-source", "ccfddl");
    writeFileSync(
      join(root, "data", "snapshot.json"),
      JSON.stringify({
        snapshot_metadata: {
          schema_version: 1,
          generated_at: NOW_ARG,
          sources: {
            aideadlines: {
              revision: "saved-revision",
              fetchedAt: NOW_ARG,
              contentHash: "saved-hash",
              conferenceCount: 1,
              editionCount: 1,
              deadlineCount: 1,
            },
          },
        },
        conferences: [
          {
            key: "saved-source",
            title: "saved-source",
            full_name: "saved-source",
            categories: ["ai"],
            sources: ["aideadlines"],
            editions: [
              {
                year: 2027,
                id: "saved-source27",
                source: "aideadlines",
                deadlines: [
                  {
                    kind: "paper",
                    label: "Paper",
                    round: 1,
                    utc: "2026-11-01T00:00:00.000Z",
                    tz_raw: "AoE",
                  },
                ],
              },
            ],
          },
        ],
      }),
      "utf8",
    );
    hooks.collect = async () => ({
      groups: [[live], [], []],
      failed: new Set(["aideadlines"]),
      results: [
        sourceResult("ccfddl", "fresh", [live]),
        sourceResult("aideadlines", "failed", []),
        sourceResult("local", "fresh", []),
      ],
    });
    const outdir = join(mkdtempSync("/tmp/cfp-source-snapshot-"), "out");
    expect(await cmdBuild(args(outdir))).toBe(0);
    const health = JSON.parse(readFileSync(join(outdir, "health.json"), "utf8")) as {
      source_status: Record<string, string>;
      source_metadata: Record<string, SourceLoadResult>;
    };
    expect(health.source_status.aideadlines).toBe("snapshot-fallback");
    expect(health.source_metadata.aideadlines.status).toBe("snapshot-fallback");
    expect(health.source_metadata.aideadlines).toMatchObject({
      revision: "saved-revision",
      contentHash: "saved-hash",
      observationStatus: "fresh",
      conferenceCount: 1,
      editionCount: 1,
      deadlineCount: 1,
    });
    expect((health as any).build_input_mode).toBe("offline-snapshot");
  });
});

describe("parseArgs (CLI flag parsing)", () => {
  it("parses positional command and standard flags", () => {
    const res = parseArgs(["build", "--out", "dist", "--config", "conf.yaml", "--offline"]);
    expect(res.command).toBe("build");
    expect(res.out).toBe("dist");
    expect(res.config).toBe("conf.yaml");
    expect(res.offline).toBe(true);
  });

  it("parses --flag=value equal-joined arguments", () => {
    const res = parseArgs([
      "build",
      "--out=dist/public",
      "--config=custom.yaml",
      "--now=2026-08-09T00:00:00Z",
      "--cache=.custom_cache",
      "--categories=hpc,systems",
      "--min-year=2027",
    ]);
    expect(res.command).toBe("build");
    expect(res.out).toBe("dist/public");
    expect(res.config).toBe("custom.yaml");
    expect(res.now).toBe("2026-08-09T00:00:00Z");
    expect(res.cache).toBe(".custom_cache");
    expect(res.categories).toBe("hpc,systems");
    expect(res.minYear).toBe(2027);
  });

  it("parses short options (-o, -c, -n)", () => {
    const res = parseArgs([
      "build",
      "-o",
      "out_dir",
      "-c",
      "custom.yaml",
      "-n",
      "2026-08-09T00:00:00Z",
    ]);
    expect(res.command).toBe("build");
    expect(res.out).toBe("out_dir");
    expect(res.config).toBe("custom.yaml");
    expect(res.now).toBe("2026-08-09T00:00:00Z");
  });

  it("parses explicit boolean flags (=false, =0, =no, =true)", () => {
    const resFalse = parseArgs(["build", "--offline=false", "--no-embeddings=0", "--dry-run=no"]);
    expect(resFalse.offline).toBe(false);
    expect(resFalse.noEmbeddings).toBe(false);
    expect(resFalse.dryRun).toBe(false);

    const resTrue = parseArgs(["build", "--offline=true", "--no-embeddings=1", "--append=true"]);
    expect(resTrue.offline).toBe(true);
    expect(resTrue.noEmbeddings).toBe(true);
    expect(resTrue.append).toBe(true);
  });

  it("parses review subcommand and options", () => {
    const res1 = parseArgs([
      "review",
      "--limit=20",
      "--candidates=data/custom_cands.yaml",
      "--now=2026-08-09T00:00:00Z",
    ]);
    expect(res1.command).toBe("review");
    expect(res1.limit).toBe(20);
    expect(res1.candidates).toBe("data/custom_cands.yaml");
    expect(res1.now).toBe("2026-08-09T00:00:00Z");

    const res2 = parseArgs(["review", "--limit", "15", "--candidates", "data/cand.yaml"]);
    expect(res2.command).toBe("review");
    expect(res2.limit).toBe(15);
    expect(res2.candidates).toBe("data/cand.yaml");

    const res3 = parseArgs(["review", "-l", "30", "-C", "data/cands.yaml"]);
    expect(res3.command).toBe("review");
    expect(res3.limit).toBe(30);
    expect(res3.candidates).toBe("data/cands.yaml");

    const res4 = parseArgs(["discover", "-d", "-a", "-y", "2027"]);
    expect(res4.command).toBe("discover");
    expect(res4.dryRun).toBe(true);
    expect(res4.append).toBe(true);
    expect(res4.minYear).toBe(2027);
  });

  it("discoverWriteAction: --append 候補 0 件は何もしない (none) — #267 回帰", () => {
    // 候補 0 件 + --append --out: 素通し上書きに落ちず既存ファイルを維持する
    expect(discoverWriteAction(0, true, "data/discovered_candidates.yaml", false)).toBe("none");
    // 候補 > 0 件 + --append --out: 従来どおり追記
    expect(discoverWriteAction(3, true, "data/discovered_candidates.yaml", false)).toBe("append");
    // dry-run / out 単体の従来挙動は不変
    expect(discoverWriteAction(0, false, null, true)).toBe("dry-run");
    expect(discoverWriteAction(5, false, "out.yaml", false)).toBe("write");
    expect(discoverWriteAction(0, false, null, false)).toBe("none");
    // --append だが out 無し: 追記先が無いので何もしない
    expect(discoverWriteAction(2, true, null, false)).toBe("none");
  });

  it.each([["--help"], ["-h"], ["help"]])("parses help forms %j", (arg) => {
    expect(parseArgs([arg]).help).toBe(true);
  });

  it("throws on unknown flags", () => {
    expect(() => parseArgs(["--invalid-option"])).toThrow("unknown option: --invalid-option");
    expect(() => parseArgs(["--bad=value"])).toThrow("unknown option: --bad=value");
  });

  // #312: 非数値・不正値の --min-year / --limit は既定値へフォールバック（NaN を下流へ伝播させない）
  it("falls back to defaults when --min-year / --limit are non-numeric", () => {
    expect(parseArgs(["discover", "-y", "abc"]).minYear).toBe(new Date().getUTCFullYear());
    expect(parseArgs(["review", "-l", "foo"]).limit).toBe(60);
  });

  it("rejects zero / non-integer min-year and limit (#312)", () => {
    // ゼロ・小数は正整数条件で弾かれ既定値へ（負は space 形式で unknown option に先行するため対象外）
    expect(parseArgs(["discover", "-y", "0"]).minYear).toBe(new Date().getUTCFullYear());
    expect(parseArgs(["discover", "-y", "3.5"]).minYear).toBe(new Date().getUTCFullYear());
    expect(parseArgs(["review", "-l", "1.5"]).limit).toBe(60);
  });

  it("accepts valid positive integers for --min-year / --limit (#312)", () => {
    expect(parseArgs(["discover", "-y", "2027"]).minYear).toBe(2027);
    expect(parseArgs(["review", "-l", "30"]).limit).toBe(30);
  });

  it("main returns 0 on help", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(await main(["-h"])).toBe(0);
    expect(await main(["help"])).toBe(0);
  });

  it("main executes review subcommand successfully", async () => {
    expect(
      await main([
        "review",
        "--now=2026-08-09T00:00:00Z",
        "--candidates=data/discovered_candidates.yaml",
      ]),
    ).toBe(0);
  });
});

describe("snapshot fallback", () => {
  it("build recovers from the snapshot when every source fails", async () => {
    const root = isolatedRepo();
    setRoot(root);
    const snapshot = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
      conferences: unknown[];
    };
    expect(snapshot.conferences.length).toBeGreaterThan(100);
    writeFileSync(join(root, "data", "snapshot.json"), JSON.stringify(snapshot), "utf8");

    allUpstreamsDown();
    const outdir = join(mkdtempSync("/tmp/cfp-snap-out-"), "out");
    const code = await cmdBuild(args(outdir));
    expect(code).toBe(0);

    const data = JSON.parse(readFileSync(join(outdir, "data.json"), "utf8")) as {
      conferences: unknown[];
    };
    // Restoring a snapshot applies the same confirmed-timezone contract as
    // live ingestion; observations without an exact zone are not published.
    expect(data.conferences.length).toBeLessThanOrEqual(snapshot.conferences.length);
  });

  it("restoring a snapshot drops unconfirmed timezone observations", async () => {
    const root = isolatedRepo();
    setRoot(root);
    writeFileSync(
      join(root, "data", "snapshot.json"),
      JSON.stringify({
        conferences: [
          {
            key: "restore-zone-test",
            title: "Restore Zone Test",
            categories: ["ai"],
            sources: ["ccfddl"],
            editions: [
              {
                year: 2027,
                id: "confirmed27",
                deadlines: [{ kind: "paper", utc: "2027-01-01T00:00:00Z", tz_raw: "UTC" }],
              },
              {
                year: 2028,
                id: "missing28",
                deadlines: [{ kind: "paper", utc: "2028-01-01T00:00:00Z", tz_raw: "" }],
              },
            ],
          },
        ],
      }),
      "utf8",
    );
    allUpstreamsDown();
    const outdir = join(mkdtempSync("/tmp/cfp-snap-zone-"), "out");
    expect(await cmdBuild(args(outdir))).toBe(0);
    const data = JSON.parse(readFileSync(join(outdir, "data.json"), "utf8")) as {
      conferences: Array<{
        key: string;
        editions: Array<{ id: string; deadlines: unknown[] }>;
      }>;
    };
    const restored = data.conferences.find((conf) => conf.key === "restore-zone-test")!;
    const editions = Object.fromEntries(restored.editions.map((edition) => [edition.id, edition]));
    expect(editions.confirmed27?.deadlines).toHaveLength(1);
    expect(editions.missing28?.deadlines).toEqual([]);
  });

  it("degraded builds still apply overrides to the restored snapshot", async () => {
    const root = isolatedRepo();
    setRoot(root);
    const snapshot = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
      conferences: unknown[];
    };
    writeFileSync(join(root, "data", "snapshot.json"), JSON.stringify(snapshot), "utf8");

    allUpstreamsDown();
    const outdir = join(mkdtempSync("/tmp/cfp-snap-out4-"), "out");
    const code = await cmdBuild(args(outdir));
    expect(code).toBe(0);

    const data = JSON.parse(readFileSync(join(outdir, "data.json"), "utf8")) as {
      conferences: Array<{
        key: string;
        editions: Array<{ year: number; estimated: boolean; deadlines: Array<{ utc: string }> }>;
      }>;
    };
    // 退避 snapshot は overrides 未反映の推定版を含むことがある（merge から
    // 次回日次更新までの窓）。上流障害時も data/overrides.yaml の修正が効くこと。
    const ccgrid = data.conferences.find((c) => c.key === "ccgrid");
    const e2027 = ccgrid?.editions.find((e) => e.year === 2027);
    expect(e2027).toBeDefined();
    expect(e2027?.estimated).toBe(false);
    expect(e2027?.deadlines.map((d) => d.utc).sort()).toEqual([
      "2026-11-25T11:59:59Z",
      "2026-12-02T11:59:59Z",
    ]);
  });

  it("degraded builds re-apply the local source onto the restored snapshot", async () => {
    const root = isolatedRepo();
    setRoot(root);
    const snapshot = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
      conferences: unknown[];
    };
    writeFileSync(join(root, "data", "snapshot.json"), JSON.stringify(snapshot), "utf8");

    // 上流障害時も local (data/extra.yaml) は読める。復元 snapshot に無い会議と、
    // snapshot には無い追加締切（satml 2027 通知系など）が配信に残ること。
    // snapshot の satml27 は paper 締切のみ（2026-08-14 時点）。extra.yaml は
    // 通知 3 件を持つ。degraded 復元に local が再適用されれば通知締切が入る。
    hooks.collect = async () => ({
      groups: [
        [],
        [],
        [
          {
            key: "extra-only-conf",
            title: "Extra Only Conf",
            full_name: "Extra Only Conf 2027",
            link: "",
            rank: {},
            dblp: null,
            upstream_sub: null,
            tags: [],
            categories: ["networking"],
            editions: [
              {
                year: 2027,
                edition_id: "extra-only-conf27",
                link: "",
                place: "",
                date_text: "2027-03-01..2027-03-03",
                event_start: new Date("2027-03-01T00:00:00Z"),
                event_end: new Date("2027-03-03T00:00:00Z"),
                deadlines: [
                  {
                    kind: "paper",
                    label: "Paper submission",
                    at_utc: new Date("2026-11-04T23:59:59Z"),
                    tz_raw: "America/Los_Angeles",
                    round: 1,
                    comment: null,
                  },
                ],
                estimated: false,
                source: "local",
              },
            ],
            sources: ["local"],
          },
          {
            key: "satml",
            title: "Security and Machine Learning",
            full_name: "Security and Machine Learning",
            link: "",
            rank: {},
            dblp: null,
            upstream_sub: null,
            tags: [],
            categories: [],
            editions: [
              {
                year: 2027,
                edition_id: "satml27",
                link: "",
                place: "",
                date_text: "2027-02-11..2027-02-13",
                event_start: new Date("2027-02-11T00:00:00Z"),
                event_end: new Date("2027-02-13T00:00:00Z"),
                deadlines: [
                  {
                    kind: "notification",
                    label: "Notification to authors",
                    at_utc: new Date("2026-12-16T23:59:59Z"),
                    tz_raw: "America/Los_Angeles",
                    round: 1,
                    comment: null,
                  },
                ],
                estimated: false,
                source: "local",
              },
            ],
            sources: ["local"],
          },
        ],
      ],
      failed: new Set(["ccfddl", "aideadlines"]),
    });

    const outdir = join(mkdtempSync("/tmp/cfp-snap-out8-"), "out");
    const code = await cmdBuild(args(outdir));
    expect(code).toBe(0);

    const data = JSON.parse(readFileSync(join(outdir, "data.json"), "utf8")) as {
      conferences: Array<{
        key: string;
        editions: Array<{
          year: number;
          deadlines: Array<{ utc: string; kind: string }>;
        }>;
      }>;
    };
    // local のみが持つ会議は復元 snapshot に無くても残る
    const extra = data.conferences.find((c) => c.key === "extra-only-conf");
    expect(extra).toBeDefined();
    // snapshot には無い追加締切（通知系）も degraded 配信に残る
    const satml = data.conferences.find((c) => c.key === "satml");
    const e27 = satml?.editions.find((e) => e.year === 2027);
    expect(e27?.deadlines.some((d) => d.kind === "notification")).toBe(true);
  });

  it("degraded builds drop local-only keys removed from extra.yaml", async () => {
    const root = isolatedRepo();
    setRoot(root);
    const snapshot = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
      conferences: unknown[];
    };
    // 削除済み local 会議を snapshot に仕込む（extra.yaml から消えたが snapshot に残る状態）
    snapshot.conferences.push({
      key: "ghost-local-conf",
      title: "Ghost Local Conf",
      full_name: "Ghost Local Conf",
      link: "",
      rank: {},
      dblp: null,
      upstream_sub: null,
      tags: [],
      categories: ["networking"],
      editions: [
        {
          year: 2026,
          edition_id: "ghost-local-conf26",
          link: "",
          place: "",
          date_text: "2026-12-01..2026-12-03",
          event_start: new Date("2026-12-01T00:00:00Z"),
          event_end: new Date("2026-12-03T00:00:00Z"),
          deadlines: [],
          estimated: false,
          source: "local",
        },
      ],
      sources: ["local"],
    });
    writeFileSync(join(root, "data", "snapshot.json"), JSON.stringify(snapshot), "utf8");

    // local group を注入（ghost は含めない = extra.yaml から削除された状態）。
    // 既存キー satml は snapshot にも local にもあるため「削除されていない local 会議は残る」検証に使う。
    hooks.collect = async () => ({
      groups: [
        [],
        [],
        [
          {
            key: "satml",
            title: "Security and Machine Learning",
            full_name: "Security and Machine Learning",
            link: "",
            rank: {},
            dblp: null,
            upstream_sub: null,
            tags: [],
            categories: [],
            editions: [
              {
                year: 2027,
                edition_id: "satml27",
                link: "",
                place: "",
                date_text: "2027-02-11..2027-02-13",
                event_start: new Date("2027-02-11T00:00:00Z"),
                event_end: new Date("2027-02-13T00:00:00Z"),
                deadlines: [
                  {
                    kind: "notification",
                    label: "Notification to authors",
                    at_utc: new Date("2026-12-16T23:59:59Z"),
                    tz_raw: "America/Los_Angeles",
                    round: 1,
                    comment: null,
                  },
                ],
                estimated: false,
                source: "local",
              },
            ],
            sources: ["local"],
          },
        ],
      ],
      failed: new Set(["ccfddl", "aideadlines"]),
    });

    const outdir = join(mkdtempSync("/tmp/cfp-snap-ghost-"), "out");
    const code = await cmdBuild(args(outdir));
    expect(code).toBe(0);

    const data = JSON.parse(readFileSync(join(outdir, "data.json"), "utf8")) as {
      conferences: Array<{ key: string }>;
    };
    // extra.yaml に存在しない local 由来キー（削除された会議）は復活しない
    expect(data.conferences.find((c) => c.key === "ghost-local-conf")).toBeUndefined();
    // 削除されていない local 会議（satml）は従来通り残る
    expect(data.conferences.find((c) => c.key === "satml")).toBeDefined();
  });

  it("degraded builds respect config.exclude and select() rules", async () => {
    const root = isolatedRepo();
    setRoot(root);
    const snapshot = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
      conferences: unknown[];
    };
    writeFileSync(join(root, "data", "snapshot.json"), JSON.stringify(snapshot), "utf8");

    // config.yaml に exclude: [sigcomm] を安全に追記して上流障害時も exclude が適用されるか検証
    const conf = loadYaml(readFileSync(join(root, "config.yaml"), "utf8")) as Record<
      string,
      unknown
    >;
    const excl = Array.isArray(conf.exclude) ? [...conf.exclude] : [];
    excl.push("sigcomm");
    conf.exclude = excl;
    writeFileSync(join(root, "config.yaml"), dumpYaml(conf), "utf8");

    allUpstreamsDown();
    const outdir = join(mkdtempSync("/tmp/cfp-snap-ex-"), "out");
    const code = await cmdBuild(args(outdir));
    expect(code).toBe(0);

    const data = JSON.parse(readFileSync(join(outdir, "data.json"), "utf8")) as {
      conferences: Array<{ key: string }>;
    };
    // snapshot に存在した sigcomm が config.exclude により除外されること
    expect(data.conferences.find((c) => c.key === "sigcomm")).toBeUndefined();
    // 他の会議は正常に残ること
    expect(data.conferences.find((c) => c.key === "sc")).toBeDefined();
  });

  it("build aborts instead of publishing gutted data", async () => {
    const root = isolatedRepo();
    setRoot(root);
    allUpstreamsDown();
    const outdir = join(mkdtempSync("/tmp/cfp-snap-out2-"), "out");
    const code = await cmdBuild(args(outdir));
    expect(code).not.toBe(0);
    expect(existsSync(join(outdir, "data.json"))).toBe(false);
  });

  it("partial upstream failure continues when live is nonempty even if snapshot is not larger (#410)", async () => {
    const root = isolatedRepo();
    setRoot(root);
    writeFileSync(
      join(root, "data", "snapshot.json"),
      JSON.stringify({
        conferences: [
          {
            key: "tiny-snap",
            title: "Tiny",
            categories: ["ai"],
            editions: [
              {
                year: 2027,
                id: "tiny27",
                deadlines: [{ kind: "paper", utc: "2026-11-01T23:59:59Z" }],
              },
            ],
          },
        ],
      }),
      "utf8",
    );
    const live = makeConference({
      key: "partial-live-conf",
      title: "Partial Live",
      categories: ["networking"],
      sources: ["ccfddl"],
      editions: [
        makeEdition({
          year: 2027,
          deadlines: [makeDeadline("paper", "Paper", utc(2026, 11, 1))],
        }),
      ],
    });
    hooks.collect = async () => ({
      groups: [[live], [], []],
      failed: new Set(["aideadlines"]),
    });
    const outdir = join(mkdtempSync("/tmp/cfp-snap-partial-"), "out");
    const code = await cmdBuild(args(outdir));
    expect(code).toBe(0);
    const data = JSON.parse(readFileSync(join(outdir, "data.json"), "utf8")) as {
      conferences: Array<{ key: string }>;
    };
    expect(data.conferences.find((c) => c.key === "partial-live-conf")).toBeDefined();
  });

  it("partial upstream failure merges snapshot conferences from the failed source (#412)", async () => {
    const root = isolatedRepo();
    setRoot(root);
    writeFileSync(
      join(root, "data", "snapshot.json"),
      JSON.stringify({
        conferences: [
          {
            key: "partial-live-conf",
            title: "Stale Live From Snapshot",
            categories: ["networking"],
            sources: ["ccfddl"],
            editions: [
              {
                year: 2027,
                id: "stale27",
                deadlines: [{ kind: "paper", utc: "2026-10-01T23:59:59Z", tz_raw: "UTC" }],
              },
            ],
          },
          {
            key: "aideadlines-only-conf",
            title: "AI Only",
            categories: ["ai"],
            sources: ["aideadlines"],
            editions: [
              {
                year: 2027,
                id: "aio27",
                deadlines: [{ kind: "paper", utc: "2026-12-01T23:59:59Z", tz_raw: "UTC" }],
              },
            ],
          },
        ],
      }),
      "utf8",
    );
    const live = makeConference({
      key: "partial-live-conf",
      title: "Partial Live",
      categories: ["networking"],
      sources: ["ccfddl"],
      editions: [
        makeEdition({
          year: 2027,
          deadlines: [makeDeadline("paper", "Paper", utc(2026, 11, 1))],
        }),
      ],
    });
    const live2 = makeConference({
      key: "partial-live-conf-2",
      title: "Partial Live 2",
      categories: ["systems"],
      sources: ["ccfddl"],
      editions: [
        makeEdition({
          year: 2027,
          deadlines: [makeDeadline("paper", "Paper", utc(2026, 11, 2))],
        }),
      ],
    });
    hooks.collect = async () => ({
      groups: [[live, live2], [], []],
      failed: new Set(["aideadlines"]),
    });
    const outdir = join(mkdtempSync("/tmp/cfp-snap-partial-merge-"), "out");
    const code = await cmdBuild(args(outdir));
    expect(code).toBe(0);
    const data = JSON.parse(readFileSync(join(outdir, "data.json"), "utf8")) as {
      conferences: Array<{ key: string; title: string }>;
    };
    expect(data.conferences.find((c) => c.key === "aideadlines-only-conf")).toBeDefined();
    expect(data.conferences.find((c) => c.key === "partial-live-conf")?.title).toBe("Partial Live");
  });

  it("build aborts when hand-edited data/overrides.yaml is unparsable", async () => {
    const root = isolatedRepo();
    setRoot(root);
    writeFileSync(
      join(root, "data", "overrides.yaml"),
      "conferences:\n  ccgrid: [unclosed\n",
      "utf8",
    );
    const outdir = join(mkdtempSync("/tmp/cfp-snap-out5-"), "out");
    await expect(cmdBuild(args(outdir))).rejects.toThrow(/cannot parse .*overrides\.yaml/);
    expect(existsSync(join(outdir, "data.json"))).toBe(false);
  });

  it("build aborts when hand-edited data/extra.yaml is unparsable", async () => {
    const root = isolatedRepo();
    setRoot(root);
    writeFileSync(
      join(root, "data", "extra.yaml"),
      "conferences:\n  fmas-2026: [unclosed\n",
      "utf8",
    );
    const outdir = join(mkdtempSync("/tmp/cfp-snap-out7-"), "out");
    await expect(cmdBuild(args(outdir))).rejects.toThrow(/cannot parse .*extra\.yaml/);
    expect(existsSync(join(outdir, "data.json"))).toBe(false);
  });

  it("build aborts when hand-edited config.yaml is unparsable", async () => {
    const root = isolatedRepo();
    setRoot(root);
    writeFileSync(join(root, "config.yaml"), "categories:\n  hpc: [unclosed\n", "utf8");
    const outdir = join(mkdtempSync("/tmp/cfp-snap-out6-"), "out");
    await expect(cmdBuild(args(outdir))).rejects.toThrow(/cannot parse .*config\.yaml/);
    expect(existsSync(join(outdir, "data.json"))).toBe(false);
  });

  it("auto-generated primary_overrides.yaml keeps warn-and-continue", async () => {
    const root = isolatedRepo();
    setRoot(root);
    const snapshot = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
      conferences: unknown[];
    };
    writeFileSync(join(root, "data", "snapshot.json"), JSON.stringify(snapshot), "utf8");
    writeFileSync(
      join(root, "data", "primary_overrides.yaml"),
      "conferences:\n  whpc: [unclosed\n",
      "utf8",
    );
    // 自動生成ファイルの破損は警告のみで続行（2026-08-12 whpc の趣旨）。
    const outdir = join(mkdtempSync("/tmp/cfp-snap-out7-"), "out");
    const code = await cmdBuild(args(outdir));
    expect(code).toBe(0);
  });

  it("an offline build does not overwrite the snapshot", async () => {
    const root = isolatedRepo();
    setRoot(root);
    const kept = { conferences: [{ key: "sentinel", editions: [] }] };
    const target = join(root, "data", "snapshot.json");
    writeFileSync(target, JSON.stringify(kept), "utf8");

    const cache = makeFixtureCache(mkdtempSync("/tmp/cfp-snap-fix-"));
    const outdir = join(mkdtempSync("/tmp/cfp-snap-out3-"), "out");
    const code = await cmdBuild(args(outdir, cache));
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(kept);
  });

  it("a healthy online build writes the snapshot without generated_at (SPEC §3.5)", async () => {
    // SPEC §3.5: snapshot は data.json のコピーだが「generated_at を含まない」。
    // 既存の snapshot テストは全て offline でこの経路を未カバーだったため、
    // fixture キャッシュから上流取得成功（failed 空）を模した healthy build で検証する。
    const root = isolatedRepo();
    setRoot(root);
    const cache = makeFixtureCache(mkdtempSync("/tmp/cfp-snap-online-"));
    // 上流を実 fetch せず fixture キャッシュ（offline 収集）で healthy な groups を作り、
    // 呼び出し側は offline: false（= 健全な online build の書き込み条件）にする。
    // collect の型: (cacheDir, options) => Promise<{groups, failed}>。
    // prev を明示的に hooks.collect と同じ型にして、finally の復元で型が広がらないようにする。
    const prev: typeof hooks.collect = hooks.collect;
    hooks.collect = async (dir: string, _options: { offline?: boolean }) => {
      const { CcfddlSource } = await import("../src/sources/ccfddl.ts");
      const { AideadlinesSource } = await import("../src/sources/aideadlines.ts");
      const { LocalSource } = await import("../src/sources/local.ts");
      const groups: Conference[][] = [
        (await new CcfddlSource().load(dir, { offline: true })) as Conference[],
        (await new AideadlinesSource().load(dir, { offline: true })) as Conference[],
        (await new LocalSource().load()) as Conference[],
      ];
      return { groups, failed: new Set<string>() };
    };
    try {
      const outdir = join(mkdtempSync("/tmp/cfp-snap-out-online-"), "out");
      const code = await cmdBuild({ ...args(outdir, cache), offline: false });
      expect(code).toBe(0);
      const snapshot = JSON.parse(
        readFileSync(join(root, "data", "snapshot.json"), "utf8"),
      ) as Record<string, unknown>;
      expect("generated_at" in snapshot).toBe(false);
      // data.json（§4.2）側は従来どおり generated_at を持つ。
      const data = JSON.parse(readFileSync(join(outdir, "data.json"), "utf8")) as Record<
        string,
        unknown
      >;
      expect("generated_at" in data).toBe(true);
    } finally {
      hooks.collect = prev;
    }
  });

  it("never refreshes the snapshot from a non-fresh cache fallback", async () => {
    const root = isolatedRepo();
    setRoot(root);
    const target = join(root, "data", "snapshot.json");
    const kept = { conferences: [{ key: "fresh-baseline", editions: [] }] };
    writeFileSync(target, JSON.stringify(kept), "utf8");
    const cached = makeConference({
      key: "cached-only",
      title: "Cached Only",
      sources: ["ccfddl"],
      editions: [makeEdition({ edition_id: "cached26", year: 2026 })],
    });
    const previous = hooks.collect;
    hooks.collect = async () => ({
      groups: [[cached], [], []],
      failed: new Set<string>(),
      results: [
        sourceResult("ccfddl", "cache-fallback", [cached], { cacheAgeSeconds: 1 }),
        sourceResult("aideadlines", "fresh", []),
        sourceResult("local", "fresh", []),
      ],
    });
    try {
      expect(
        await cmdBuild({
          ...args(join(mkdtempSync("/tmp/cfp-cache-no-snapshot-"), "out")),
          offline: false,
        }),
      ).toBe(0);
      expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(kept);
    } finally {
      hooks.collect = previous;
    }
  });

  it("the real repository's snapshot is untouched by the test suite", () => {
    const live = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
      conferences: unknown[];
    };
    expect(live.conferences.length).toBeGreaterThan(100);
  });

  it("every snapshot deadline's aoe is the UTC-12 wall clock of its utc", () => {
    const live = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
      conferences: Array<{
        key: string;
        editions: Array<{
          year: number;
          deadlines: Array<{ utc: string | null; aoe: string | null; precision?: string }>;
        }>;
      }>;
    };
    const AOE_MS = 12 * 60 * 60 * 1000;
    let checked = 0;
    for (const conf of live.conferences) {
      for (const ed of conf.editions ?? []) {
        for (const dl of ed.deadlines ?? []) {
          if (dl.precision === "date-only") continue;
          const ms = Date.parse(dl.utc ?? "");
          expect(Number.isNaN(ms), `${conf.key}/${ed.year} has bad utc ${dl.utc}`).toBe(false);
          const expected = `${fmtUTC(new Date(ms - AOE_MS), "%Y-%m-%d %H:%M:%S")} AoE`;
          expect(dl.aoe, `${conf.key}/${ed.year} aoe ${dl.aoe} != ${expected}`).toBe(expected);
          checked++;
        }
      }
    }
    // 実データが空になっていないこと（フィクスチャ混入・snapshot 置換の検出）。
    expect(checked).toBeGreaterThan(1000);
  });
});
