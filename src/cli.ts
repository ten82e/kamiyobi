/**
 * Entry point: node src/cli.ts build [options]
 * Ported from scripts/cli.py (kamiyobi).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs as parseNodeArgs } from "node:util";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { booleanValue, normalizeShortEquals, stringValue } from "./args.ts";
import { buildAll, collectPublishProvenance, type HealthSourceMetadata, toJson } from "./build.ts";
import { gcEvidence, verifyEvidence, writeEvidenceIndex } from "./evidence.ts";
import {
  applyAliases,
  applyOverrides,
  classify,
  deadlineSlotKey,
  dedupDeadlinesAfterRollforward,
  type MergeStats,
  mergeEditionIdentity,
  mergeSources,
  normalizeConfiguredVenueIdentities,
  rollforward,
  sanitizeEditions,
  select,
} from "./merge.ts";
import {
  type Conference,
  cmpStr,
  conferencesFromJson,
  type Deadline,
  deadlineTrackKey,
  warn,
  warningCounts,
  warningIdentityKeys,
} from "./model.ts";
import {
  applyVerificationLedger,
  assertResolutionCanApply,
  collectVerificationTargets,
  loadVerificationLedger,
  reverifyData,
  transitionVerificationResolution,
} from "./reverify.ts";
import { AideadlinesSource } from "./sources/aideadlines.ts";
import { fetchMetadataFor, resetFetchMetadata } from "./sources/base.ts";
import { CcfddlSource } from "./sources/ccfddl.ts";
import { LocalSource, localSourcePaths } from "./sources/local.ts";
import { resolvePrimaryObservations } from "./sources/primary.ts";

// ROOT はテストから差し替え可能（let）。
export let ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MIN_YEAR = new Date().getUTCFullYear();

export function setRoot(root: string): void {
  ROOT = root;
}

export function parseNow(text: string | null | undefined): Date {
  if (!text) return new Date();
  let value = text.trim();
  if (value.endsWith("Z") || value.endsWith("z")) {
    value = `${value.slice(0, -1)}+00:00`;
  }
  const normalized = value.replace(" ", "T");
  // Date は '2026-02-30' 等の不可能な暦日を黙って翌月へ繰り上げる
  // (parseInstant / asDate と同じ round-trip の流儀で拒否する)。
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(normalized);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const chk = new Date(Date.UTC(y, mo - 1, d));
    if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) {
      throw new Error(`unparsable --now: ${JSON.stringify(text)}`);
    }
  }
  // Date は時刻あり・offset 無しをローカル時刻にし、T24:00:00Z を翌日へ繰り上げる。
  // --now は決定的テスト用（SPEC §3.7）なので、どちらも拒否する。
  const time = /T(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(.*)$/.exec(normalized);
  if (time) {
    const hour = Number(time[1]);
    const minute = Number(time[2]);
    const second = Number(time[3] ?? "0");
    const zone = time[4] ?? "";
    if (hour > 23 || minute > 59 || second > 59 || !/^[+-]\d{2}:?\d{2}$/.test(zone)) {
      throw new Error(`unparsable --now: ${JSON.stringify(text)}`);
    }
  }
  const dt = new Date(normalized);
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`unparsable --now: ${JSON.stringify(text)}`);
  }
  return dt;
}

function loadYamlFile(path: string, opts?: { strict?: boolean }): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const loaded = loadYaml(readFileSync(path, "utf8"));
    return typeof loaded === "object" && loaded !== null ? (loaded as Record<string, unknown>) : {};
  } catch (exc) {
    // 静かに {} を返すと primary_overrides 等のエントリが全滅するのにビルドは
    // 成功し続ける（2026-08-12 whpc で実証）。必ず警告を出す。
    if (opts?.strict) {
      // 手編集の入力 (config.yaml / data/overrides.yaml) は、破損したまま
      // 警告だけで続行すると公式締切の訂正が消えたり縮退サイトが配信されたり
      // する（2026-08-13 実証）。SPEC.md 3.5 の「縮退した内容を配信しない」
      // 契約に合わせて中断させる（main の rejection handler が exit 1 にする）。
      throw new Error(`cannot parse ${path}: ${String(exc)}`);
    }
    warn(`cannot parse ${path}: ${String(exc)}`);
    return {};
  }
}

export type SourceStatus = "fresh" | "cache-fallback" | "snapshot-fallback" | "failed";
export interface SourceLoadResult {
  source: string;
  status: SourceStatus;
  revision: string | null;
  fetchedAt: string | null;
  contentHash: string | null;
  cacheAgeSeconds: number | null;
  conferences: Conference[];
  conferenceCount: number;
  editionCount: number;
  deadlineCount: number;
}

function sourceInstances(): Array<{
  name: string;
  load: (cache: string, opts?: { offline?: boolean; now?: Date }) => Promise<unknown[]>;
}> {
  return [new CcfddlSource(), new AideadlinesSource(), new LocalSource(localSourcePaths(ROOT))];
}

async function collectImpl(
  cacheDir: string,
  options: { offline?: boolean; now?: Date },
): Promise<{ groups: Conference[][]; failed: Set<string>; results?: SourceLoadResult[] }> {
  const groups: Conference[][] = [];
  const failed = new Set<string>();
  const results: SourceLoadResult[] = [];
  const sources = sourceInstances();
  for (const source of sources) {
    let group: unknown[] = [];
    try {
      group = await source.load(cacheDir, options);
    } catch (exc) {
      process.stderr.write(`warning: source ${source.name} の取得に失敗した: ${String(exc)}\n`);
      group = [];
    }
    if (group.length === 0 && source.name !== "local") {
      failed.add(source.name);
    }
    const conferences = group as Conference[];
    groups.push(conferences);
    const meta =
      source.name === "ccfddl"
        ? fetchMetadataFor("ccfddl/ccf-deadlines", "main")
        : source.name === "aideadlines"
          ? fetchMetadataFor("huggingface/ai-deadlines", "main")
          : null;
    const localInputs = localSourcePaths(ROOT).filter((path) => existsSync(path));
    const localContentHash =
      source.name === "local" && localInputs.length > 0
        ? createHash("sha256")
            .update(localInputs.map((path) => `${path}\0${readFileSync(path)}`).join("\0"))
            .digest("hex")
        : null;
    const localRevision = (() => {
      try {
        return (
          execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim() || null
        );
      } catch {
        return null;
      }
    })();
    const status: SourceStatus =
      source.name === "local"
        ? "fresh"
        : failed.has(source.name)
          ? "failed"
          : (meta?.status ?? "fresh");
    results.push({
      source: source.name,
      status,
      revision: meta?.revision ?? (source.name === "local" ? localRevision : null),
      fetchedAt: meta?.fetchedAt ?? null,
      contentHash: meta?.contentHash ?? (source.name === "local" ? localContentHash : null),
      cacheAgeSeconds: meta?.cacheAgeSeconds ?? null,
      conferences,
      conferenceCount: conferences.length,
      editionCount: conferences.reduce((n, conference) => n + conference.editions.length, 0),
      deadlineCount: conferences.reduce(
        (n, conference) =>
          n + conference.editions.reduce((m, edition) => m + edition.deadlines.length, 0),
        0,
      ),
    });
  }
  return { groups, failed, results };
}

// テストから差し替えられるよう、ESM の束縛をオブジェクト経由で公開する。
export const hooks = { collect: collectImpl };

export interface SnapshotMetadata {
  schema_version: 1;
  generated_at: string;
  sources: Record<
    string,
    Pick<
      SourceLoadResult,
      | "revision"
      | "fetchedAt"
      | "contentHash"
      | "conferenceCount"
      | "editionCount"
      | "deadlineCount"
    >
  >;
}

export interface SourceSnapshot {
  schemaVersion: 1;
  source: string;
  sourceRevision: string | null;
  fetchedAt: string;
  contentHash: string;
  conferences: unknown[];
}

interface PrimarySnapshot extends SourceSnapshot {
  source: "primary";
}

const SHA256 = /^[0-9a-f]{64}$/i;

function validSourceSnapshot(value: unknown, source: string): value is SourceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.source !== source ||
    (snapshot.sourceRevision !== null && typeof snapshot.sourceRevision !== "string") ||
    typeof snapshot.fetchedAt !== "string" ||
    !Number.isFinite(Date.parse(snapshot.fetchedAt)) ||
    typeof snapshot.contentHash !== "string" ||
    !SHA256.test(snapshot.contentHash) ||
    !Array.isArray(snapshot.conferences)
  )
    return false;
  const contentHash = createHash("sha256")
    .update(JSON.stringify(snapshot.conferences))
    .digest("hex");
  return contentHash === snapshot.contentHash.toLowerCase();
}

function sourceSnapshotDir(root = ROOT): string {
  return join(root, "data", "source-snapshots");
}

function sourceSnapshotPath(source: string, root = ROOT): string {
  return join(sourceSnapshotDir(root), `${source}.json`);
}

function sourceSnapshotCounts(
  conferences: Conference[],
): Pick<SourceLoadResult, "conferenceCount" | "editionCount" | "deadlineCount"> {
  return {
    conferenceCount: conferences.length,
    editionCount: conferences.reduce((n, conference) => n + conference.editions.length, 0),
    deadlineCount: conferences.reduce(
      (n, conference) =>
        n + conference.editions.reduce((m, edition) => m + edition.deadlines.length, 0),
      0,
    ),
  };
}

function readSourceSnapshots(
  root = ROOT,
): Map<string, { conferences: Conference[]; metadata: SourceSnapshot }> {
  const out = new Map<string, { conferences: Conference[]; metadata: SourceSnapshot }>();
  const dir = sourceSnapshotDir(root);
  if (!existsSync(dir)) return out;
  for (const source of ["ccfddl", "aideadlines", "local"]) {
    const path = sourceSnapshotPath(source, root);
    if (!existsSync(path)) continue;
    try {
      const metadata: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!validSourceSnapshot(metadata, source)) continue;
      const conferences = conferencesFromJson({ conferences: metadata.conferences });
      out.set(source, { conferences, metadata });
    } catch (exc) {
      process.stderr.write(`warning: source snapshot ${path} を読めない: ${String(exc)}\n`);
    }
  }
  return out;
}

function writeSourceSnapshots(
  results: SourceLoadResult[],
  config: Record<string, unknown>,
  now: Date,
  root = ROOT,
): void {
  mkdirSync(sourceSnapshotDir(root), { recursive: true });
  for (const result of results) {
    if (result.status !== "fresh") continue;
    const payload = toJson(result.conferences, config, now);
    const conferences = Array.isArray(payload.conferences) ? payload.conferences : [];
    const canonical = JSON.stringify(conferences);
    const snapshot: SourceSnapshot = {
      schemaVersion: 1,
      source: result.source,
      sourceRevision: result.revision,
      fetchedAt: result.fetchedAt ?? now.toISOString(),
      contentHash: createHash("sha256").update(canonical).digest("hex"),
      conferences,
    };
    writeFileSync(sourceSnapshotPath(result.source, root), `${JSON.stringify(snapshot)}\n`, "utf8");
  }
}

function primarySnapshotPath(root = ROOT): string {
  return sourceSnapshotPath("primary", root);
}

function primarySnapshotConferences(primary: Record<string, unknown>): unknown[] {
  const conferences = primary.conferences;
  if (!conferences || typeof conferences !== "object" || Array.isArray(conferences)) return [];
  return Object.entries(conferences as Record<string, unknown>)
    .sort(([left], [right]) => cmpStr(left, right))
    .flatMap(([key, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const conference = value as Record<string, unknown>;
      const editions = conference.editions;
      const editionRows =
        editions && typeof editions === "object" && !Array.isArray(editions)
          ? Object.entries(editions as Record<string, unknown>)
              .sort(([left], [right]) => cmpStr(left, right))
              .flatMap(([year, edition]) => {
                const numericYear = Number(year);
                return numericYear > 0 &&
                  Number.isInteger(numericYear) &&
                  edition &&
                  typeof edition === "object" &&
                  !Array.isArray(edition)
                  ? [{ year: numericYear, ...(edition as Record<string, unknown>) }]
                  : [];
              })
          : [];
      return [{ key, ...conference, editions: editionRows }];
    });
}

function writePrimarySnapshot(primary: Record<string, unknown>, now: Date, root = ROOT): void {
  const conferences = primarySnapshotConferences(primary);
  if (conferences.length === 0) return;
  const canonical = JSON.stringify(conferences);
  const snapshot: PrimarySnapshot = {
    schemaVersion: 1,
    source: "primary",
    sourceRevision: (() => {
      try {
        return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      } catch {
        return null;
      }
    })(),
    fetchedAt: now.toISOString(),
    contentHash: createHash("sha256").update(canonical).digest("hex"),
    conferences,
  };
  writeFileSync(primarySnapshotPath(root), `${JSON.stringify(snapshot)}\n`, "utf8");
}

function readPrimarySnapshot(root = ROOT): Record<string, unknown> {
  const path = primarySnapshotPath(root);
  if (!existsSync(path)) return {};
  try {
    const snapshot: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!validSourceSnapshot(snapshot, "primary")) return {};
    const conferences: Record<string, unknown> = {};
    for (const raw of snapshot.conferences) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const key = String(row.key ?? "").trim();
      if (!key) continue;
      const editions: Record<string, unknown> = {};
      for (const rawEdition of Array.isArray(row.editions) ? row.editions : []) {
        if (!rawEdition || typeof rawEdition !== "object") continue;
        const edition = rawEdition as Record<string, unknown>;
        const year = Number(edition.year);
        if (!Number.isInteger(year) || year <= 0) continue;
        const { year: _year, ...rest } = edition;
        editions[String(year)] = rest;
      }
      const { key: _key, editions: _editions, ...rest } = row;
      conferences[key] = { ...rest, ...(Object.keys(editions).length ? { editions } : {}) };
    }
    return Object.keys(conferences).length > 0 ? { conferences } : {};
  } catch (exc) {
    process.stderr.write(`warning: primary snapshot ${path} を読めない: ${String(exc)}\n`);
    return {};
  }
}

function readSnapshot(path: string): {
  conferences: Conference[];
  metadata: SnapshotMetadata | null;
} {
  if (!existsSync(path)) return { conferences: [], metadata: null };
  try {
    const payload = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const value = payload.snapshot_metadata;
    const metadata =
      value &&
      typeof value === "object" &&
      (value as Record<string, unknown>).schema_version === 1 &&
      typeof (value as Record<string, unknown>).generated_at === "string" &&
      (value as Record<string, unknown>).sources &&
      typeof (value as Record<string, unknown>).sources === "object"
        ? (value as unknown as SnapshotMetadata)
        : null;
    return { conferences: conferencesFromJson(payload), metadata };
  } catch (exc) {
    process.stderr.write(`warning: ${path} を読めない: ${String(exc)}\n`);
    return { conferences: [], metadata: null };
  }
}

export interface SnapshotRestoreResult {
  conferences: Conference[];
  counts: Record<
    string,
    Pick<SourceLoadResult, "conferenceCount" | "editionCount" | "deadlineCount">
  >;
}

function normalizedIdentity(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function snapshotConferenceMatch(
  conferences: Conference[],
  saved: Conference,
): Conference | undefined {
  const sourceIdsCompatible = (conference: Conference): boolean =>
    !Object.entries(saved.identity?.sourceIds ?? {}).some(
      ([source, id]) =>
        conference.identity?.sourceIds?.[source] !== undefined &&
        normalizedIdentity(conference.identity.sourceIds[source]) !== normalizedIdentity(id),
    );
  const criteria: Array<(conference: Conference) => boolean> = [
    (conference) =>
      Boolean(saved.identity?.venueId) &&
      normalizedIdentity(conference.identity?.venueId) ===
        normalizedIdentity(saved.identity?.venueId),
    (conference) =>
      Object.entries(saved.identity?.sourceIds ?? {}).some(
        ([source, id]) =>
          normalizedIdentity(conference.identity?.sourceIds?.[source]) === normalizedIdentity(id),
      ),
    (conference) =>
      sourceIdsCompatible(conference) &&
      Boolean(saved.identity?.dblpKey ?? saved.dblp) &&
      normalizedIdentity(conference.identity?.dblpKey ?? conference.dblp) ===
        normalizedIdentity(saved.identity?.dblpKey ?? saved.dblp),
    (conference) =>
      sourceIdsCompatible(conference) &&
      (conference.key === saved.key ||
        (conference.legacy_keys ?? []).includes(saved.key) ||
        (saved.legacy_keys ?? []).includes(conference.key)),
  ];
  for (const criterion of criteria) {
    const matches = conferences.filter(criterion);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
  }
  return undefined;
}

function snapshotEditionMatch(
  editions: Conference["editions"],
  saved: Conference["editions"][number],
): Conference["editions"][number] | undefined {
  const sameYear = editions.filter((edition) => edition.year === saved.year);
  const criteria: Array<(edition: Conference["editions"][number]) => boolean> = [
    (edition) =>
      Boolean(saved.identity?.editionId) &&
      normalizedIdentity(edition.identity?.editionId) ===
        normalizedIdentity(saved.identity?.editionId),
    (edition) =>
      Object.entries(saved.identity?.sourceIds ?? {}).some(
        ([source, id]) =>
          normalizedIdentity(edition.identity?.sourceIds?.[source]) === normalizedIdentity(id),
      ),
    (edition) => edition.edition_id === saved.edition_id,
  ];
  for (const criterion of criteria) {
    const matches = sameYear.filter(criterion);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
  }
  return undefined;
}

/** Restore only failed upstream material; current slots always win. */
export function restoreFailedSourceMaterialWithCounts(
  current: Conference[],
  snapshot: Conference[],
  failed: Set<string>,
): SnapshotRestoreResult {
  const out = current.map((conference) => ({
    ...conference,
    editions: conference.editions.map((edition) => ({
      ...edition,
      deadlines: [...edition.deadlines],
    })),
  }));
  const counts: SnapshotRestoreResult["counts"] = Object.fromEntries(
    [...failed].map((source) => [
      source,
      { conferenceCount: 0, editionCount: 0, deadlineCount: 0 },
    ]),
  );
  const count = (source: string, field: keyof SnapshotRestoreResult["counts"][string]) => {
    if (failed.has(source)) counts[source]![field] += 1;
  };
  const sourceOf = (
    conference: Conference,
    edition: Conference["editions"][number],
  ): string | null => {
    if (failed.has(edition.source)) return edition.source;
    if (edition.source) {
      // edition.source は明示されているが failed でない場合、その edition が
      // failed source 由来の deadline を混在させているかで復元を決める。
      // (satml27 は source=local でも ccfddl evidence の paper を持つ → 復元対象。
      //  bis 2025 は evidence が ccfddl のみで aideadlines 由来ではない → 復元不要)
      const hasFailedEvidence = (edition.deadlines ?? []).some((deadline) =>
        (deadline.evidence ?? []).some(
          (item) =>
            item.source_name !== null &&
            item.source_name !== undefined &&
            failed.has(item.source_name),
        ),
      );
      return hasFailedEvidence ? edition.source : null;
    }
    const candidates = conference.sources.filter((source) => failed.has(source));
    // Legacy snapshots identify only a one-source conference; infer that source,
    // never guess when provenance is mixed.
    return candidates.length === 1 ? candidates[0]! : null;
  };
  const sourceOfDeadline = (deadline: Deadline, fallback: string): string | null => {
    const sources = [
      ...new Set((deadline.evidence ?? []).map((item) => item.source_name).filter(Boolean)),
    ];
    if (sources.length === 0) return failed.has(fallback) ? fallback : null;
    if (sources.includes("local")) return "local";
    return sources.every((source) => failed.has(source)) ? sources[0]! : null;
  };
  for (const saved of snapshot) {
    const savedFailed = saved.sources.some((source) => failed.has(source));
    if (!savedFailed || (saved.sources.length === 1 && saved.sources[0] === "local")) continue;
    const held = snapshotConferenceMatch(out, saved);
    if (!held) {
      // Old snapshots attribute only a conference/edition to a source; retain
      // that ceiling rather than guessing per-field ownership.
      const sources = saved.sources.filter((source) => failed.has(source));
      const editions = saved.editions.flatMap((edition) => {
        const source = sourceOf(saved, edition);
        return source
          ? [
              {
                ...edition,
                source,
                deadlines: edition.deadlines.filter((deadline) =>
                  sourceOfDeadline(deadline, source),
                ),
              },
            ]
          : [];
      });
      if (!sources.length || !editions.length) continue;
      const restoredConference = { ...saved, sources, editions };
      out.push(restoredConference);
      for (const source of sources) count(source, "conferenceCount");
      for (const edition of editions) {
        count(edition.source, "editionCount");
        for (const deadline of edition.deadlines) {
          count(sourceOfDeadline(deadline, edition.source)!, "deadlineCount");
        }
      }
      continue;
    }
    let restored = false;
    for (const savedEdition of saved.editions) {
      const savedSource = sourceOf(saved, savedEdition);
      const heldEdition = snapshotEditionMatch(held.editions, savedEdition);
      if (!heldEdition) {
        if (!savedSource) continue;
        const deadlines = savedEdition.deadlines.filter((deadline) =>
          sourceOfDeadline(deadline, savedSource),
        );
        held.editions.push({
          ...savedEdition,
          source: savedSource,
          deadlines,
        });
        restored = true;
        count(savedSource, "editionCount");
        for (const deadline of deadlines) {
          count(sourceOfDeadline(deadline, savedSource)!, "deadlineCount");
        }
        continue;
      }
      const identitySources = [
        ...new Set([
          ...Object.keys(savedEdition.identity?.sourceIds ?? {}).filter((source) =>
            failed.has(source),
          ),
          ...(savedSource && failed.has(savedSource) ? [savedSource] : []),
        ]),
      ];
      if (identitySources.length > 0) {
        const failedSourceIds = Object.fromEntries(
          Object.entries(savedEdition.identity?.sourceIds ?? {}).filter(([source]) =>
            failed.has(source),
          ),
        );
        const identity = mergeEditionIdentity([
          heldEdition.identity,
          {
            officialUrls: savedEdition.identity?.officialUrls,
            sourceIds: failedSourceIds,
          },
        ]);
        if (!isDeepStrictEqual(heldEdition.identity, identity)) {
          heldEdition.identity = identity;
          restored = true;
          for (const source of identitySources) count(source, "editionCount");
        }
      }
      const present = new Set(heldEdition.deadlines.map(deadlineSlotKey));
      for (const deadline of savedEdition.deadlines) {
        const deadlineSource = sourceOfDeadline(deadline, savedSource ?? "");
        if (!deadlineSource) continue;
        if (!present.has(deadlineSlotKey(deadline))) {
          heldEdition.deadlines.push(deadline);
          restored = true;
          count(deadlineSource, "deadlineCount");
        }
      }
    }
    if (restored) {
      held.sources = [
        ...new Set([...held.sources, ...saved.sources.filter((source) => failed.has(source))]),
      ];
    }
  }
  return { conferences: out, counts };
}

export function restoreFailedSourceMaterial(
  current: Conference[],
  snapshot: Conference[],
  failed: Set<string>,
): Conference[] {
  return restoreFailedSourceMaterialWithCounts(current, snapshot, failed).conferences;
}

export interface BuildArgs {
  out: string;
  config: string;
  offline: boolean;
  now: string | null;
  cache: string;
  noEmbeddings?: boolean;
}

export async function cmdBuild(args: BuildArgs): Promise<number> {
  const now = parseNow(args.now);
  resetFetchMetadata();
  const configPath = isAbsolute(args.config) ? args.config : join(ROOT, args.config);
  const config = loadYamlFile(configPath, { strict: true });
  // 一次ソースからの自動抽出結果 (src/fetch-primary.ts 生成) は手書き
  // overrides の後に適用する: 公式ページの実測が最優先。
  // overrides は手編集なのでパース失敗で中断する（strict）。primary は
  // 自動生成のため、検証失敗は警告に留めて確定値を保持する。
  const overrides = loadYamlFile(join(ROOT, "data", "overrides.yaml"), { strict: true });
  // 一次ソースの自動抽出は「検証済み観測」だけを確定値として扱う:
  // 日付のみ・曖昧 tz・開催時期と矛盾する行はここで落とし、既存の確定値を保持する。
  const primaryPath = join(ROOT, "data", "primary_overrides.yaml");
  const primaryFile = loadYamlFile(primaryPath);
  const primaryObservations =
    primaryFile.conferences &&
    typeof primaryFile.conferences === "object" &&
    !Array.isArray(primaryFile.conferences)
      ? primaryFile
      : readPrimarySnapshot();
  // 現行の local 正典は manual + curated.generated。旧 extra.yaml は、正典が
  // まだ無い checkout の互換入力としてだけ使う。
  for (const path of localSourcePaths(ROOT)) loadYamlFile(path, { strict: true });
  const offline = Boolean(args.offline);

  const snapshot = join(ROOT, "data", "snapshot.json");
  const verificationLedgerPath = resolve(join(ROOT, "data", "verification-ledger.json"));
  const verificationLedger = existsSync(verificationLedgerPath)
    ? loadVerificationLedger(verificationLedgerPath)
    : null;

  const snapshotPayload = readSnapshot(snapshot);
  const collected = await hooks.collect(resolve(args.cache), { offline, now });
  const { groups, failed } = collected;
  const sourceSnapshots = readSourceSnapshots();
  const sourceSnapshotFallbacks = new Set<string>();
  const sourceGroups = groups.map((group, index) => {
    const source = sourceInstances()[index]?.name;
    const saved = source ? sourceSnapshots.get(source) : undefined;
    if (!source || !failed.has(source) || !saved || saved.conferences.length === 0) return group;
    sourceSnapshotFallbacks.add(source);
    return saved.conferences;
  });
  const sourceResults = (
    collected.results ??
    sourceInstances().map((source, index) => {
      const conferences = sourceGroups[index] ?? [];
      return {
        source: source.name,
        status: failed.has(source.name) ? "failed" : offline ? "cache-fallback" : "fresh",
        revision: null,
        fetchedAt: null,
        contentHash: null,
        cacheAgeSeconds: null,
        conferences,
        conferenceCount: conferences.length,
        editionCount: conferences.reduce((n, c) => n + c.editions.length, 0),
        deadlineCount: conferences.reduce(
          (n, c) => n + c.editions.reduce((m, e) => m + e.deadlines.length, 0),
          0,
        ),
      } satisfies SourceLoadResult;
    })
  ).map((result, index) => {
    if (!sourceSnapshotFallbacks.has(result.source)) return result;
    const conferences = sourceGroups[index] ?? [];
    return {
      ...result,
      conferences,
      ...sourceSnapshotCounts(conferences),
    };
  });
  if (!offline) {
    writeSourceSnapshots(sourceResults, config, now);
    if (primaryObservations === primaryFile) writePrimarySnapshot(primaryFile, now);
  }
  const maxCacheAgeSeconds = Number(
    (config.health as Record<string, unknown> | undefined)?.max_cache_age_seconds,
  );
  if (!offline && Number.isFinite(maxCacheAgeSeconds) && maxCacheAgeSeconds >= 0) {
    const stale = sourceResults.filter(
      (source) =>
        source.status === "cache-fallback" &&
        source.cacheAgeSeconds !== null &&
        source.cacheAgeSeconds > maxCacheAgeSeconds,
    );
    if (stale.length > 0) {
      process.stderr.write(
        `error: cache fallback exceeds max age for ${stale.map((source) => source.source).join(",")}\n`,
      );
      return 2;
    }
  }
  const aliased = applyAliases(
    sourceGroups,
    overrides.aliases as Record<string, unknown> | undefined,
  );
  const mergeStats: MergeStats = { merged_deadlines: 0, merged_by_key: {} };
  let confs = mergeSources(aliased, config, mergeStats);
  confs = classify(confs, config);

  // SPEC.md section 3.5: an upstream outage must not gut the published site.
  const degraded = failed.size > 0;
  let snapshotFallback = false;
  let snapshotFallbackCounts: Record<
    string,
    Pick<SourceLoadResult, "conferenceCount" | "editionCount" | "deadlineCount">
  > = {};
  if (degraded) {
    const restoredResult = restoreFailedSourceMaterialWithCounts(
      confs,
      snapshotPayload.conferences,
      new Set([...failed].filter((source) => !sourceSnapshotFallbacks.has(source))),
    );
    const restoredMaterial = restoredResult.conferences;
    snapshotFallback =
      sourceSnapshotFallbacks.size > 0 ||
      JSON.stringify(restoredMaterial) !== JSON.stringify(confs);
    if (snapshotFallback) {
      snapshotFallbackCounts = restoredResult.counts;
      for (const source of sourceSnapshotFallbacks) {
        snapshotFallbackCounts[source] = sourceSnapshotCounts(
          sourceSnapshots.get(source)!.conferences,
        );
      }
    }
    if (confs.length === 0 && !snapshotFallback) {
      process.stderr.write(
        `error: 上流 ${[...failed].sort().join(",")} が取得できず、退避に使える ${snapshot} も無い（${confs.length} 会議）。縮退した内容を配信しないため中断する\n`,
      );
      return 2;
    }
    if (snapshotFallback) {
      process.stderr.write(
        `warning: 上流 ${[...failed].sort().join(",")} が取得できないため ${snapshot} の該当 source を復元して生成する\n`,
      );
    } else {
      process.stderr.write(
        `warning: 上流 ${[...failed].sort().join(",")} が取得できないが、成功した ${confs.length} 会議で継続する（SPEC.md 3.5）\n`,
      );
    }
    // Snapshot keys may carry a collision suffix from an older partial source set.
    // Re-apply configured source identities before overrides address canonical keys. Overrides
    // run only after restoration so a patch cannot manufacture a duplicate placeholder edition.
    confs = classify(normalizeConfiguredVenueIdentities(restoredMaterial, config), config);
  }

  confs = applyOverrides(confs, overrides);
  const primary = resolvePrimaryObservations(primaryObservations, config, confs);
  confs = applyOverrides(confs, primary);
  confs = sanitizeEditions(confs);
  confs = rollforward(
    confs,
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
    config,
  );
  // SPEC.md 3.6: roll-forward copies a real edition's deadlines into the
  // estimated one, so the fold runs once more behind it.
  confs = dedupDeadlinesAfterRollforward(confs, config, mergeStats);
  confs = select(confs, config);
  if (verificationLedger) confs = applyVerificationLedger(confs, verificationLedger);

  const outdir = resolve(args.out);
  const healthConfig = (config.health as Record<string, unknown> | undefined) ?? {};
  const requiredVenues = Array.isArray(healthConfig.required_venues)
    ? healthConfig.required_venues.map((key) => String(key))
    : [];
  const maxObservationAgeSeconds =
    Number.isFinite(maxCacheAgeSeconds) && maxCacheAgeSeconds >= 0 ? maxCacheAgeSeconds : 86_400;
  const sourceMetadata: Record<string, HealthSourceMetadata> = Object.fromEntries(
    sourceResults.map(({ conferences: _conferences, ...source }) => {
      const restored = snapshotFallbackCounts[source.source];
      const saved = snapshotPayload.metadata?.sources[source.source];
      const usesSnapshot =
        failed.has(source.source) &&
        Boolean(
          restored && restored.conferenceCount + restored.editionCount + restored.deadlineCount > 0,
        );
      const observedAt = usesSnapshot ? (saved?.fetchedAt ?? null) : source.fetchedAt;
      const observedMs = Date.parse(String(observedAt ?? ""));
      const observationAgeSeconds = Number.isFinite(observedMs)
        ? Math.max(0, Math.floor((now.getTime() - observedMs) / 1000))
        : null;
      const observationStatus =
        source.source === "local" || source.status === "fresh"
          ? "fresh"
          : observationAgeSeconds === null
            ? "unknown"
            : observationAgeSeconds > maxObservationAgeSeconds
              ? "stale"
              : "fresh";
      return [
        source.source,
        {
          ...source,
          ...(usesSnapshot
            ? {
                status: "snapshot-fallback" as const,
                revision: saved?.revision ?? null,
                fetchedAt: saved?.fetchedAt ?? null,
                contentHash: saved?.contentHash ?? null,
                cacheAgeSeconds: observationAgeSeconds,
                ...restored,
              }
            : {}),
          observationStatus,
          observedAt,
          observationAgeSeconds,
        },
      ];
    }),
  );
  const recommendationSourceStatus = Object.fromEntries(
    Object.entries(sourceMetadata).map(([source, metadata]) => [
      source,
      metadata.observationStatus === "fresh"
        ? "fresh"
        : metadata.status === "cache-fallback"
          ? "cache-fallback"
          : "snapshot-fallback",
    ]),
  ) as Record<string, SourceStatus>;
  const stats = await buildAll(confs, config, outdir, now, {
    noEmbeddings: Boolean(args.noEmbeddings),
    publishProvenance: collectPublishProvenance(ROOT, configPath, { now, offline }),
    health: {
      sourceStatus: Object.fromEntries(
        sourceResults.map((source) => [
          source.source,
          failed.has(source.source)
            ? snapshotFallback &&
              (snapshotFallbackCounts[source.source]?.conferenceCount ?? 0) +
                (snapshotFallbackCounts[source.source]?.editionCount ?? 0) +
                (snapshotFallbackCounts[source.source]?.deadlineCount ?? 0) >
                0
              ? "snapshot-fallback"
              : "failed"
            : source.status,
        ]),
      ),
      sourceMetadata,
      recommendationSourceStatus,
      buildInputMode: offline ? "offline-snapshot" : "online-refresh",
      sourceFailures: [...failed],
      snapshotFallback,
      requiredVenues,
      parseWarnings: warningCounts(),
      warningIdentityKeys: warningIdentityKeys(),
      identityConflicts: mergeStats.identity_conflicts,
    },
  });
  // 統合件数は出力に載った会議のぶんだけ数える。
  const byKey = mergeStats.merged_by_key ?? {};
  stats.merged = degraded ? 0 : confs.reduce((n, c) => n + (byKey[c.key] ?? 0), 0);

  // 縮退したまま書き戻すと退避データそのものを壊すので、健全なときだけ更新する。
  // SPEC.md 3.5: snapshot は data.json のコピーだが「generated_at を含まない」。
  // 素コピーだと --now 指定の検証ビルドが架空の generated_at を退避データに焼き込む。
  // A snapshot is a fresh upstream baseline, never a cache/snapshot mixture.
  const allSourcesFresh = sourceResults.every((source) => source.status === "fresh");
  if (!degraded && !offline && allSourcesFresh && existsSync(join(outdir, "data.json"))) {
    const payload = JSON.parse(readFileSync(join(outdir, "data.json"), "utf8")) as Record<
      string,
      unknown
    >;
    delete payload.generated_at;
    payload.snapshot_metadata = {
      schema_version: 1,
      generated_at: now.toISOString(),
      sources: Object.fromEntries(
        sourceResults.map((source) => [
          source.source,
          {
            revision: source.revision,
            fetchedAt: source.fetchedAt ?? (source.source === "local" ? now.toISOString() : null),
            contentHash: source.contentHash,
            conferenceCount: source.conferenceCount,
            editionCount: source.editionCount,
            deadlineCount: source.deadlineCount,
          },
        ]),
      ),
    } satisfies SnapshotMetadata;
    writeFileSync(snapshot, JSON.stringify(payload), "utf8");
  }

  console.log(
    `built ${stats.conferences} conferences / ${stats.editions} editions / ${stats.deadlines} deadlines / ${stats.events} events (${stats.estimated} estimated, ${stats.merged} merged) -> ${outdir}`,
  );
  // Surface parse/fetch soft-warnings so execution logs and operators can see them.
  const counts = warningCounts();
  if (Object.keys(counts).length > 0) {
    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0]))
      .slice(0, 8);
    const summary = top.map(([msg, n]) => `${n}× ${msg}`).join("; ");
    process.stderr.write(
      `warnings: ${Object.values(counts).reduce((a, b) => a + b, 0)} (${summary})\n`,
    );
  }
  return 0;
}

interface DiscoverArgs {
  out: string | null;
  candidateOut: string | null;
  categories: string | null;
  minYear: number;
  dryRun: boolean;
  append: boolean;
}

export type DiscoverWriteAction = "append" | "dry-run" | "write" | "none";

/**
 * cmdDiscover の出力分岐を決める（純関数。テスト可能）。
 * `--append` 指定時に候補が 0 件でも「何もしない」を返し、素通し上書きで
 * 蓄積ファイルが空になるのを防ぐ。
 */
export function discoverWriteAction(
  count: number,
  append: boolean,
  out: string | null,
  dryRun: boolean,
): DiscoverWriteAction {
  if (append && out) return count > 0 ? "append" : "none";
  if (dryRun) return "dry-run";
  if (out) return "write";
  return "none";
}

export async function cmdDiscover(args: DiscoverArgs): Promise<number> {
  const {
    NicheDiscoverer,
    formatActiveCandidates,
    formatCandidateArchive,
    formatCandidateRegistry,
    formatDiscoveredYaml,
    mergeCandidateRegistry,
    parseCandidateRegistry,
    splitCandidateLifecycle,
  } = await import("./discover.ts");
  const { loadTrackedTitles } = await import("./review-candidates.ts");
  const categories = args.categories ? args.categories.split(",").map((c) => c.trim()) : null;
  const discoverer = new NicheDiscoverer(ROOT);
  console.log(
    `穴場の会議・ジャーナルを探索中（カテゴリ: ${categories?.join(",") ?? "すべて"}）...`,
  );
  const candidates = await discoverer.runDiscovery(categories ?? null, args.minYear);

  console.log(`新しい穴場の会議・ジャーナル候補を ${candidates.length} 件見つけた。`);
  for (const cand of candidates.slice(0, 10)) {
    console.log(`  - [${cand.key}] ${cand.title}: ${cand.full_name} (${cand.link})`);
  }

  const yamlText = formatDiscoveredYaml(candidates);
  const candidatePath = args.candidateOut ?? join(ROOT, "data", "discovered_candidates.yaml");
  const candidatePathResolved = isAbsolute(candidatePath)
    ? candidatePath
    : join(ROOT, candidatePath);
  const existingRegistry = parseCandidateRegistry(
    loadYamlFile(candidatePathResolved, { strict: true }),
  );
  const registry = mergeCandidateRegistry(existingRegistry, candidates, new Date().toISOString());
  const action = discoverWriteAction(candidates.length, args.append, args.out, args.dryRun);

  if (action === "append") {
    // 既存 YAML の conferences に、key が被らない候補だけ追記する。
    const outPath = isAbsolute(args.out!) ? args.out! : join(ROOT, args.out!);
    const existing = loadYamlFile(outPath) as Record<string, unknown>;
    const existingConfs = (existing.conferences as Array<Record<string, unknown>> | null) ?? [];
    const seen = new Set(existingConfs.map((c) => c.key));
    const parsed = loadYaml(yamlText) as { conferences?: Array<Record<string, unknown>> };
    const newConfs = (parsed.conferences ?? []).filter((c) => !seen.has(c.key));
    existing.conferences = [...existingConfs, ...newConfs];
    const { dump } = await import("js-yaml");
    writeTextFile(outPath, dump(existing, { skipInvalid: true }));
    console.log(`\n${newConfs.length} 件の候補を ${outPath} に追記した`);
  } else if (action === "dry-run") {
    console.log("\n--- プレビュー出力（extra.yaml 形式） ---");
    console.log(yamlText.slice(0, 1000) + (yamlText.length > 1000 ? "..." : ""));
  } else if (action === "write") {
    const outPath = isAbsolute(args.out!) ? args.out! : join(ROOT, args.out!);
    writeTextFile(outPath, yamlText);
    console.log(`\n候補 YAML を ${outPath} に保存した`);
  }
  if (!args.dryRun && candidates.length > 0) {
    writeTextFile(candidatePathResolved, formatCandidateRegistry(registry));
  }
  if (!args.dryRun) {
    const lifecycle = splitCandidateLifecycle(
      registry.candidates,
      new Date(),
      loadTrackedTitles(ROOT),
    );
    writeTextFile(
      join(ROOT, "data", "discovery", "active.yaml"),
      formatActiveCandidates(lifecycle.active),
    );
    writeTextFile(
      join(ROOT, "data", "discovery", "archive.json"),
      formatCandidateArchive(lifecycle.archive),
    );
  }
  return 0;
}

export interface ReviewCliArgs {
  candidates?: string;
  limit?: number;
  now?: string | null;
}

export async function cmdReview(args: ReviewCliArgs): Promise<number> {
  const { runReviewCandidates } = await import("./review-candidates.ts");
  const defaultActive = join(ROOT, "data", "discovery", "active.yaml");
  const rawPath =
    args.candidates ??
    (existsSync(defaultActive) ? defaultActive : join(ROOT, "data", "discovered_candidates.yaml"));
  const candidatesPath = isAbsolute(rawPath) ? rawPath : join(ROOT, rawPath);
  const limit = args.limit ?? 60;
  const now = args.now ? parseNow(args.now) : new Date();
  runReviewCandidates(candidatesPath, limit, now);
  return 0;
}

export interface ReverifyCliArgs {
  action?: "plan" | "run" | "review" | "accept" | "apply" | "reject";
  data?: string;
  ledger?: string;
  now?: string | null;
  due?: boolean;
  resolution?: string;
  reason?: string;
  maxPages?: number;
  maxDeadlines?: number;
  maxPerHost?: number;
  concurrency?: number;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export async function cmdReverify(args: ReverifyCliArgs): Promise<number> {
  const dataPath = resolve(args.data ?? join(ROOT, "public", "data.json"));
  const ledgerPath = resolve(args.ledger ?? join(ROOT, "data", "verification-ledger.json"));
  try {
    const action = args.action ?? "run";
    if (action === "review") {
      const ledger = loadVerificationLedger(ledgerPath);
      console.log(
        JSON.stringify(
          ledger.resolutions.filter((item) => item.state === "open" || item.state === "accepted"),
          null,
          2,
        ),
      );
      return 0;
    }
    if (action === "accept" || action === "apply" || action === "reject") {
      if (!args.resolution) throw new Error(`reverify ${action} requires --resolution <id>`);
      if (action === "apply") {
        assertResolutionCanApply(ledgerPath, args.resolution);
        applyResolutionSource(ledgerPath, args.resolution, args.now);
      }
      transitionVerificationResolution(
        ledgerPath,
        args.resolution,
        action === "accept" ? "accepted" : action === "apply" ? "applied" : "rejected",
        args.reason,
        args.now ? parseNow(args.now) : new Date(),
      );
      console.log(
        JSON.stringify({
          resolution_id: args.resolution,
          state: action === "accept" ? "accepted" : action === "apply" ? "applied" : "rejected",
        }),
      );
      return 0;
    }
    if (action === "plan") {
      const data = JSON.parse(readFileSync(dataPath, "utf8")) as { conferences?: unknown[] };
      const ledger = loadVerificationLedger(ledgerPath);
      const now = args.now ? parseNow(args.now) : new Date();
      const targets = collectVerificationTargets(data as never, ledger, now, Boolean(args.due));
      const pages = [...new Set(targets.map((target) => target.url))].sort();
      console.log(
        JSON.stringify(
          {
            deadlines: targets.length,
            pages: pages.length,
            targets: targets.map((target) => ({
              deadline_id: target.deadlineId,
              page_id: target.pageId,
              url: target.url,
              source_class: target.sourceClass,
              priority: target.priority,
            })),
          },
          null,
          2,
        ),
      );
      return 0;
    }
    const result = await reverifyData({
      dataPath,
      ledgerPath,
      now: args.now ? parseNow(args.now) : new Date(),
      due: Boolean(args.due),
      bodyRoot: join(ROOT, "data", "evidence", "blobs"),
      limits: {
        maxPages: args.maxPages,
        maxDeadlines: args.maxDeadlines,
        maxPerHost: args.maxPerHost,
        concurrency: args.concurrency,
        timeoutMs: args.timeoutMs,
        maxBodyBytes: args.maxBodyBytes,
      },
    });
    console.log(
      JSON.stringify({
        processed: result.processed,
        pages: result.pages,
        statuses: result.statuses,
      }),
    );
    return 0;
  } catch (error) {
    process.stderr.write(`reverify failed: ${String(error)}\n`);
    return 1;
  }
}

export interface EvidenceCliArgs {
  action?: "verify" | "gc";
  dryRun?: boolean;
}

export function cmdEvidence(args: EvidenceCliArgs): number {
  try {
    if (args.action === "gc") {
      const result = gcEvidence(ROOT, Boolean(args.dryRun));
      console.log(JSON.stringify({ ...result, dry_run: Boolean(args.dryRun) }, null, 2));
      if (!args.dryRun) writeEvidenceIndex(ROOT);
      return 0;
    }
    const report = verifyEvidence(ROOT);
    writeEvidenceIndex(ROOT);
    console.log(JSON.stringify(report, null, 2));
    return report.issues.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(`evidence failed: ${String(error)}\n`);
    return 1;
  }
}

function resolutionSourcePath(entry: {
  source_name?: string;
  promotion_ref?: { batch: string; resolution: string };
}): string {
  if (entry.source_name === "local") {
    if (entry.promotion_ref && existsSync(join(ROOT, "data", "curated.generated.yaml")))
      return join(ROOT, "data", "curated.generated.yaml");
    if (existsSync(join(ROOT, "data", "manual.yaml"))) return join(ROOT, "data", "manual.yaml");
    return join(ROOT, "data", "extra.yaml");
  }
  return entry.source_name === "primary"
    ? join(ROOT, "data", "primary_overrides.yaml")
    : join(ROOT, "data", "overrides.yaml");
}

function resolutionDeadlineValue(value: string): { date: string; time?: string; tz?: string } {
  const text = value.trim();
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? text.slice(0, 10);
  const time = /\b(\d{2}:\d{2}(?::\d{2})?)\b/.exec(text)?.[1];
  const tz =
    /\b(AoE|UTC(?:[+-]\d{1,2}(?::?\d{2})?)?|GMT(?:[+-]\d{1,2}(?::?\d{2})?)?|[A-Za-z_]+\/[A-Za-z_]+)\b/i.exec(
      text,
    )?.[1];
  return { date, ...(time ? { time } : {}), ...(tz ? { tz } : {}) };
}

function applyResolutionSource(
  ledgerPath: string,
  resolutionId: string,
  nowText?: string | null,
): void {
  const ledger = loadVerificationLedger(ledgerPath);
  const resolution = ledger.resolutions.find((item) => item.resolution_id === resolutionId);
  if (!resolution) throw new Error(`unknown verification resolution: ${resolutionId}`);
  const entry =
    ledger.deadlines[resolution.deadline_id] ??
    ledger.deadlines[ledger.aliases[resolution.deadline_id] ?? ""];
  if (!entry)
    throw new Error(`resolution target is missing from ledger: ${resolution.deadline_id}`);
  const path = resolutionSourcePath(entry);
  const parsed = existsSync(path) ? loadYaml(readFileSync(path, "utf8")) : {};
  const value = resolutionDeadlineValue(resolution.new_value);
  const row: Record<string, unknown> = {
    kind: entry.kind,
    label: entry.label ?? entry.kind,
    round: entry.round,
    date: value.time && value.tz ? `${value.date} ${value.time}` : value.date,
    ...(value.time && value.tz ? { tz: value.tz } : { precision: "date-only" }),
    ...(entry.track ? { track: entry.track } : {}),
    ...(entry.promotion_ref ? { promotion_ref: entry.promotion_ref } : {}),
    superseded_deadlines: [
      {
        value: resolution.old_value,
        precision: /\b\d{2}:\d{2}\b/.test(resolution.old_value) ? "exact" : "date-only",
        source: resolution.official_url,
        ...(resolution.evidence_ref ? { evidenceRef: resolution.evidence_ref } : {}),
        status: "superseded",
        supersededBy: resolution.deadline_id,
        reason: resolution.change_kind === "extension" ? "official-extension" : "manual-resolution",
        supersededAt: nowText ? parseNow(nowText).toISOString() : new Date().toISOString(),
      },
    ],
  };
  const matchesEntry = (item: unknown): boolean => {
    if (!item || typeof item !== "object") return false;
    const raw = item as Record<string, unknown>;
    const rawTrack = String(raw.track ?? "");
    const normalizedTrack = deadlineTrackKey(
      String(raw.label ?? ""),
      String(raw.kind ?? "other"),
      rawTrack,
    );
    return (
      String(raw.kind ?? "") === entry.kind &&
      Number(raw.round ?? 1) === entry.round &&
      (rawTrack === entry.track || normalizedTrack === entry.track)
    );
  };
  const preserveSourceHistory = (previous: unknown): void => {
    if (!previous || typeof previous !== "object") return;
    const history = (previous as Record<string, unknown>).superseded_deadlines;
    if (Array.isArray(history)) {
      row.superseded_deadlines = [...history, ...(row.superseded_deadlines as unknown[])];
    }
  };
  const parsedRoot = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >;
  if (Array.isArray(parsedRoot.conferences)) {
    const root = parsedRoot;
    const conferences = Array.isArray(root.conferences) ? root.conferences : [];
    let conference = conferences.find(
      (item) => (item as Record<string, unknown>)?.key === entry.venue_key,
    ) as Record<string, unknown> | undefined;
    if (!conference) {
      conference = { key: entry.venue_key, title: entry.venue_key, editions: [] };
      conferences.push(conference);
    }
    const editions = Array.isArray(conference.editions) ? conference.editions : [];
    let edition = editions.find(
      (item) =>
        String((item as Record<string, unknown>)?.id ?? (item as Record<string, unknown>)?.year) ===
        entry.edition_id,
    ) as Record<string, unknown> | undefined;
    if (!edition) {
      edition = {
        year: Number(entry.edition_id.match(/20\d{2}/)?.[0] ?? 0),
        id: entry.edition_id,
        deadlines: [],
      };
      editions.push(edition);
    }
    const deadlines = Array.isArray(edition.deadlines) ? edition.deadlines : [];
    const index = deadlines.findIndex((item) => {
      return matchesEntry(item);
    });
    if (index >= 0) {
      preserveSourceHistory(deadlines[index]);
      deadlines[index] = row;
    } else deadlines.push(row);
    edition.deadlines = deadlines;
    conference.editions = editions;
    root.conferences = conferences;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${dumpYaml(root, { lineWidth: -1, noRefs: true })}`, "utf8");
    return;
  }
  const root = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const conferences = (
    root.conferences && typeof root.conferences === "object" ? root.conferences : {}
  ) as Record<string, unknown>;
  const conference = (
    conferences[entry.venue_key] && typeof conferences[entry.venue_key] === "object"
      ? conferences[entry.venue_key]
      : {}
  ) as Record<string, unknown>;
  const editions = (
    conference.editions && typeof conference.editions === "object" ? conference.editions : {}
  ) as Record<string, unknown>;
  const year = String(entry.edition_id.match(/20\d{2}/)?.[0] ?? entry.edition_id);
  const edition = (
    editions[year] && typeof editions[year] === "object" ? editions[year] : {}
  ) as Record<string, unknown>;
  const deadlines = Array.isArray(edition.deadlines) ? edition.deadlines : [];
  const index = deadlines.findIndex((item) => {
    return matchesEntry(item);
  });
  if (index >= 0) {
    preserveSourceHistory(deadlines[index]);
    deadlines[index] = row;
  } else deadlines.push(row);
  edition.deadlines = deadlines;
  editions[year] = edition;
  conference.editions = editions;
  conferences[entry.venue_key] = conference;
  root.conferences = conferences;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${dumpYaml(root, { lineWidth: -1, noRefs: true })}`, "utf8");
}

function writeTextFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

export interface CliArgs {
  command?: string;
  reverifyAction?: ReverifyCliArgs["action"];
  evidenceAction?: EvidenceCliArgs["action"];
  out?: string;
  candidateOut?: string | null;
  config?: string;
  offline?: boolean;
  now?: string | null;
  cache?: string;
  categories?: string | null;
  minYear?: number;
  dryRun?: boolean;
  append?: boolean;
  noEmbeddings?: boolean;
  candidates?: string;
  limit?: number;
  data?: string;
  ledger?: string;
  due?: boolean;
  resolution?: string;
  reason?: string;
  maxPages?: number;
  maxDeadlines?: number;
  maxPerHost?: number;
  concurrency?: number;
  timeoutMs?: number;
  maxBodyBytes?: number;
  help?: boolean;
}

export function usage(): string {
  return [
    "usage: node src/cli.ts <command> [options]",
    "",
    "commands:",
    "  build    収集して public/ を生成する",
    "    -o, --out <dir>       出力先ディレクトリ (既定: public)",
    "    -c, --config <path>   設定ファイル (既定: config.yaml)",
    "    --offline             ネットワークを使わずキャッシュのみ使う",
    "    -n, --now <iso>       基準時刻。例 2026-08-09T00:00:00Z",
    "    --cache <dir>         上流アーカイブのキャッシュ先 (既定: .cache)",
    "    --no-embeddings       埋め込み (embeddings.json) を生成しない（テスト用・高速化）",
    "  discover 穴場の会議・ジャーナルを自律探索する",
    "    -o, --out <path>      出力 YAML パス（未指定時は標準出力表示）",
    "    --candidate-out <path> 候補管理ファイル (既定: data/discovered_candidates.yaml; active/archive も更新)",
    "    --categories <s>      カンマ区切りの対象カテゴリ（例: hpc,systems）",
    `    -y, --min-year <n>    対象の最小年 (既定: ${DEFAULT_MIN_YEAR})`,
    "    -d, --dry-run         ファイル出力せず結果をプレビュー表示",
    "    -a, --append          既存 YAML にキー重複なしで追記",
    "  review   探索された候補のレビュー順・重複・ハゲタカ会議の疑いを一覧表示する",
    "    -C, --candidates <p>  候補 YAML パス (既定: data/discovery/active.yaml)",
    "    -l, --limit <n>       表示上限件数 (既定: 60)",
    "    -n, --now <iso>       基準時刻。例 2026-08-09T00:00:00Z",
    "  reverify [plan|run|review|accept|apply|reject] 再確認台帳を管理する",
    "    --data <path>         対象 data.json (既定: public/data.json)",
    "    --ledger <path>       台帳 (既定: data/verification-ledger.json)",
    "    --due                 次回確認時刻を過ぎた締切だけ確認する",
    "    --max-pages <n>       取得ページ上限 (既定: 40)",
    "    --max-deadlines <n>   対象締切上限 (既定: 200)",
    "    --max-per-host <n>    host別取得上限 (既定: 5)",
    "    --concurrency <n>     同時取得数 (既定: 4)",
    "    --timeout-ms <n>      取得タイムアウト (既定: 15000)",
    "    --max-body-bytes <n>  本文上限 (既定: 5242880)",
    "    --resolution <id>     accept/apply/reject対象 resolution",
    "    --reason <text>       状態変更の理由",
    "    -n, --now <iso>       基準時刻",
    "  evidence [verify|gc] 証拠本文の参照整合性を検査・回収する",
    "    -d, --dry-run         gc対象だけ表示して削除しない",
    "  help / --help / -h      使い方を表示する",
  ].join("\n");
}

// 有限正整数の文字列のみ数値化し、不正値・非数値は既定値にフォールバックする。
// Number("abc") = NaN になり、下流の `?? default` が NaN を拾わないため、
// 非数値入力が cand.year >= NaN（常に false）へ伝播して discover が 0 件になるのを防ぐ。
function toPosInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : fallback;
}

export function parseArgs(argv: string[] | null | undefined): CliArgs {
  const normalized = normalizeShortEquals(argv, {
    h: "help",
    o: "out",
    c: "config",
    n: "now",
    y: "min-year",
    d: "dry-run",
    a: "append",
    C: "candidates",
    l: "limit",
  });
  const options = {
    help: { type: "boolean", short: "h" },
    out: { type: "string", short: "o" },
    "candidate-out": { type: "string" },
    config: { type: "string", short: "c" },
    cache: { type: "string" },
    now: { type: "string", short: "n" },
    categories: { type: "string" },
    "min-year": { type: "string", short: "y" },
    offline: { type: "boolean" },
    "no-embeddings": { type: "boolean" },
    "dry-run": { type: "boolean", short: "d" },
    append: { type: "boolean", short: "a" },
    candidates: { type: "string", short: "C" },
    limit: { type: "string", short: "l" },
    data: { type: "string" },
    ledger: { type: "string" },
    due: { type: "boolean" },
    resolution: { type: "string" },
    reason: { type: "string" },
    "max-pages": { type: "string" },
    "max-deadlines": { type: "string" },
    "max-per-host": { type: "string" },
    concurrency: { type: "string" },
    "timeout-ms": { type: "string" },
    "max-body-bytes": { type: "string" },
  } as const;
  const { values, positionals, tokens } = parseNodeArgs({
    args: normalized,
    options,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "option" && !(token.name in options)) {
      throw new Error(`unknown option: ${normalized[token.index]}`);
    }
  }
  const command = positionals[0];
  const reverifyAction = command === "reverify" ? positionals[1] : undefined;
  const evidenceAction = command === "evidence" ? positionals[1] : undefined;
  const args: CliArgs = {};
  if (command && command !== "help") args.command = command;
  if (reverifyAction) {
    if (!["plan", "run", "review", "accept", "apply", "reject"].includes(reverifyAction))
      throw new Error(`unknown reverify action: ${reverifyAction}`);
    args.reverifyAction = reverifyAction as ReverifyCliArgs["action"];
  }
  if (evidenceAction) {
    if (!["verify", "gc"].includes(evidenceAction))
      throw new Error(`unknown evidence action: ${evidenceAction}`);
    args.evidenceAction = evidenceAction as EvidenceCliArgs["action"];
  }
  if (command === "help" || values.help) args.help = true;
  if (values.out !== undefined) args.out = stringValue(values.out) ?? "public";
  if (values["candidate-out"] !== undefined) {
    args.candidateOut =
      stringValue(values["candidate-out"]) ?? join(ROOT, "data", "discovered_candidates.yaml");
  }
  if (values.config !== undefined) args.config = stringValue(values.config) ?? "config.yaml";
  if (values.cache !== undefined) args.cache = stringValue(values.cache) ?? ".cache";
  if (values.now !== undefined) args.now = stringValue(values.now) ?? null;
  if (values.categories !== undefined) args.categories = stringValue(values.categories) ?? null;
  if (values["min-year"] !== undefined) {
    args.minYear = toPosInt(stringValue(values["min-year"]), DEFAULT_MIN_YEAR);
  }
  if (values.offline !== undefined) args.offline = booleanValue(values.offline);
  if (values["no-embeddings"] !== undefined) {
    args.noEmbeddings = booleanValue(values["no-embeddings"]);
  }
  if (values["dry-run"] !== undefined) args.dryRun = booleanValue(values["dry-run"]);
  if (values.append !== undefined) args.append = booleanValue(values.append);
  if (values.candidates !== undefined) {
    args.candidates =
      stringValue(values.candidates) ?? join(ROOT, "data", "discovered_candidates.yaml");
  }
  if (values.limit !== undefined) args.limit = toPosInt(stringValue(values.limit), 60);
  if (values.data !== undefined) args.data = stringValue(values.data) ?? undefined;
  if (values.ledger !== undefined) args.ledger = stringValue(values.ledger) ?? undefined;
  if (values.due !== undefined) args.due = booleanValue(values.due);
  if (values.resolution !== undefined)
    args.resolution = stringValue(values.resolution) ?? undefined;
  if (values.reason !== undefined) args.reason = stringValue(values.reason) ?? undefined;
  if (values["max-pages"] !== undefined)
    args.maxPages = toPosInt(stringValue(values["max-pages"]), 40);
  if (values["max-deadlines"] !== undefined)
    args.maxDeadlines = toPosInt(stringValue(values["max-deadlines"]), 200);
  if (values["max-per-host"] !== undefined)
    args.maxPerHost = toPosInt(stringValue(values["max-per-host"]), 5);
  if (values.concurrency !== undefined)
    args.concurrency = toPosInt(stringValue(values.concurrency), 4);
  if (values["timeout-ms"] !== undefined)
    args.timeoutMs = toPosInt(stringValue(values["timeout-ms"]), 15_000);
  if (values["max-body-bytes"] !== undefined)
    args.maxBodyBytes = toPosInt(stringValue(values["max-body-bytes"]), 5 * 1024 * 1024);
  return args;
}

export async function main(
  argv: string[] | null | undefined = process.argv.slice(2),
): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    process.stderr.write(`error: ${String(exc)}\n\n${usage()}\n`);
    return 2;
  }
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.command === "build") {
    return cmdBuild({
      out: args.out ?? "public",
      config: args.config ?? "config.yaml",
      offline: Boolean(args.offline),
      now: args.now ?? null,
      cache: args.cache ?? ".cache",
      noEmbeddings: Boolean(args.noEmbeddings),
    });
  }
  if (args.command === "reverify") {
    return cmdReverify({
      action: args.reverifyAction,
      data: args.data,
      ledger: args.ledger,
      now: args.now,
      due: args.due,
      resolution: args.resolution,
      reason: args.reason,
      maxPages: args.maxPages,
      maxDeadlines: args.maxDeadlines,
      maxPerHost: args.maxPerHost,
      concurrency: args.concurrency,
      timeoutMs: args.timeoutMs,
      maxBodyBytes: args.maxBodyBytes,
    });
  }
  if (args.command === "evidence") {
    return cmdEvidence({ action: args.evidenceAction ?? "verify", dryRun: args.dryRun });
  }
  if (args.command === "discover") {
    return cmdDiscover({
      out: args.out ?? null,
      candidateOut: args.candidateOut ?? null,
      categories: args.categories ?? null,
      minYear: args.minYear ?? DEFAULT_MIN_YEAR,
      dryRun: Boolean(args.dryRun),
      append: Boolean(args.append),
    });
  }
  if (args.command === "review") {
    return cmdReview({
      candidates: args.candidates,
      limit: args.limit,
      now: args.now,
    });
  }
  process.stderr.write(`${usage()}\n`);
  return 2;
}

const isMain = Boolean(
  process.argv[1] && (process.argv[1].endsWith("cli.ts") || process.argv[1].endsWith("cli.js")),
);
if (isMain) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
