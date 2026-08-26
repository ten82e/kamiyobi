/**
 * Output generation: JSON / CSV / Markdown / llms.txt / HTML.
 *
 * Everything under public/ is produced here.  Rendering is a pure function of
 * (conferences, config, now) so that two runs with the same input are byte
 * identical.  Ported from scripts/build.py (kamiyobi).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { recommendationAxes } from "../site/recommendation-core.ts";
// 代表採択論文タイトル（会議のセマンティック/語彙プロファイル強化）。
// データパイプラインで conferences に papers として載せ、ブラウザの語彙一致と
// IDF（buildNameIdf）の両方に使えるようにする。
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  EMBEDDING_MULTI_REVISION,
  EMBEDDING_REVISION,
  EMBEDDING_RUNTIME_VERSION,
  embeddingManifest,
  embeddingProfileHash,
  VENUE_PAPERS,
  venuePapersHash,
} from "./embeddings.ts";
import { DEADLINE_SELECTION_RULE } from "./merge.ts";
import {
  addDays,
  asDate,
  type Conference,
  cmpStr,
  DAY_MS,
  type Deadline,
  type DeadlineEvidence,
  dateOnly,
  dateOnlyState,
  dateOnlyWindow,
  deadlineTrackKey,
  type Edition,
  exactDeadlineState,
  fmtDate,
  fmtUTC,
  isDateOnlyDeadline,
  isExactDeadline,
  warningCounts,
  warningSummaries,
} from "./model.ts";

export let ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SITE_RUNTIME_FILES = [
  "recommender.js",
  "recommendation-core.js",
  "publish.js",
  "app.js",
] as const;

/** Compile the strict browser sources once; build and runtime tests consume these bytes. */
export function compileSiteRuntime(
  root = ROOT,
): Record<(typeof SITE_RUNTIME_FILES)[number], string> {
  const siteBuild = mkdtempSync(join(tmpdir(), "kamiyobi-site-runtime-"));
  try {
    execFileSync(
      join(root, "node_modules", ".bin", "tsc"),
      ["-p", join(root, "site", "tsconfig.build.json"), "--outDir", siteBuild],
      { stdio: "pipe" },
    );
    return Object.fromEntries(
      SITE_RUNTIME_FILES.map((name) => [name, readFileSync(join(siteBuild, name), "utf8")]),
    ) as Record<(typeof SITE_RUNTIME_FILES)[number], string>;
  } finally {
    rmSync(siteBuild, { recursive: true, force: true });
  }
}

export function setRoot(root: string): void {
  ROOT = root;
}

// --- constants ---------------------------------------------------------------

export const KIND_LABEL_JA: Record<string, string> = {
  abstract: "概要締切",
  paper: "論文締切",
  supplementary: "補足資料締切",
  notification: "採否通知",
  camera_ready: "カメラレディ締切",
  rebuttal_start: "反論期間開始",
  rebuttal_end: "反論期間終了",
  review_release: "査読結果公開",
  registration: "登録締切",
  other: "締切",
};

export const DEFAULT_CATEGORIES: Record<string, string> = {
  hpc: "High Performance Computing",
  networking: "Networking",
  systems: "Systems, Architecture and Storage",
  ai: "AI and Machine Learning",
  security: "Security and Privacy",
  db: "Database and Data Mining",
  graphics: "Graphics and Multimedia",
  hci: "Human-Computer Interaction",
  theory: "Theory and Algorithms",
};

export const DEFAULT_SOURCES = [
  { name: "ccfddl", repo: "ccfddl/ccf-deadlines", license: "MIT" },
  { name: "aideadlines", repo: "huggingface/ai-deadlines", license: "MIT" },
  { name: "local", repo: "data/extra.yaml", license: "MIT" },
];

const CSV_COLUMNS = [
  "key",
  "title",
  "full_name",
  "categories",
  "rank_ccf",
  "rank_core",
  "year",
  "edition_id",
  "kind",
  "label",
  "round",
  "deadline_precision",
  "deadline_local_date",
  "deadline_utc",
  "deadline_aoe",
  "tz_raw",
  "event_start",
  "event_end",
  "place",
  "date_text",
  "estimated",
  "estimate_window_start",
  "estimate_window_end",
  "sources",
  "link",
];

const TEMPLATE_MARKER = "/*__DATA__*/null";

/**
 * タイトル + 開催年を組み立てる。タイトルが既にその年（例: `CANOPIE-HPC 2026`）
 * または短縮年（例: `SC '26`, `SC ’26`）で終わっている場合は年を二重に付けない。
 * year が 0 / 未指定の場合はタイトルのみを返す。
 */
export function titleWithYear(
  title: string | null | undefined,
  year: number | null | undefined,
): string {
  const t = String(title ?? "").trim();
  if (!t) return "";
  if (!year) return t;
  const yStr = String(year);
  const yy = yStr.slice(-2);
  const normT = t.normalize("NFKC").trim();
  const hasYear =
    normT.endsWith(yStr) ||
    normT.endsWith(`'${yy}`) ||
    (yy && new RegExp(`(?:20${yy}|['’]?${yy})$`).test(normT));
  if (hasYear) {
    return t;
  }
  return `${t} ${year}`;
}

type EmbeddingFile = {
  model?: unknown;
  dim?: unknown;
  venuePapersHash?: unknown;
  embeddings?: Record<string, unknown>;
  multi?: { model?: unknown; dim?: unknown; embeddings?: Record<string, unknown> };
  paperVecs?: Record<string, unknown>;
  manifest?: {
    schema?: unknown;
    runtime_version?: unknown;
    profile_hash?: unknown;
    keys?: unknown;
    venue_papers_hash?: unknown;
    models?: {
      en?: { model?: unknown; revision?: unknown; dim?: unknown; probe?: { vector?: unknown } };
      multi?: { model?: unknown; revision?: unknown; dim?: unknown; probe?: { vector?: unknown } };
    };
    paper_vecs?: { keys?: unknown; dim?: unknown };
  };
};

function sameKeys(have: Record<string, unknown> | undefined, want: string[]): boolean {
  const keys = Object.keys(have ?? {}).sort();
  return keys.length === want.length && keys.every((key, i) => key === want[i]);
}

function flatVectorMapHasDim(vectors: Record<string, unknown> | undefined, dim: number): boolean {
  return Object.values(vectors ?? {}).every(
    (vector) => Array.isArray(vector) && vector.length === dim,
  );
}

function nestedVectorMapHasDim(vectors: Record<string, unknown> | undefined, dim: number): boolean {
  return Object.values(vectors ?? {}).every(
    (list) =>
      Array.isArray(list) &&
      list.length > 0 &&
      list.every((vector) => Array.isArray(vector) && vector.length === dim),
  );
}

/** 既存 embeddings.json が profile/model/vector 契約を満たすか判定する。 */
export function embeddingsStale(
  existing: EmbeddingFile | null | undefined,
  data: Parameters<typeof embeddingProfileHash>[0],
): boolean {
  if (!existing || typeof existing !== "object") return true;
  const expected = embeddingManifest(data);
  const manifest = existing.manifest;
  const en = manifest?.models?.en;
  const multi = manifest?.models?.multi;
  if (!manifest || !en || !multi) return true;
  if (
    manifest.schema !== expected.schema ||
    manifest.runtime_version !== expected.runtime_version ||
    manifest.profile_hash !== expected.profile_hash
  )
    return true;
  if (manifest.profile_hash !== embeddingProfileHash(data)) return true;
  if (
    !sameKeys(existing.embeddings, expected.keys) ||
    !sameKeys(existing.multi?.embeddings, expected.keys)
  ) {
    return true;
  }
  if (JSON.stringify(manifest.keys) !== JSON.stringify(expected.keys)) return true;
  if (manifest.venue_papers_hash !== expected.venue_papers_hash) return true;
  if (existing.venuePapersHash !== venuePapersHash()) return true;
  if (
    existing.model !== EMBEDDING_MODEL ||
    existing.dim !== EMBEDDING_DIM ||
    existing.multi?.model !== EMBEDDING_MULTI_MODEL ||
    existing.multi?.dim !== EMBEDDING_DIM
  ) {
    return true;
  }
  if (
    en.model !== expected.models.en.model ||
    en.revision !== expected.models.en.revision ||
    en.dim !== EMBEDDING_DIM ||
    multi.model !== expected.models.multi.model ||
    multi.revision !== expected.models.multi.revision ||
    multi.dim !== EMBEDDING_DIM ||
    !Array.isArray(en.probe?.vector) ||
    en.probe.vector.length !== EMBEDDING_DIM ||
    !Array.isArray(multi.probe?.vector) ||
    multi.probe.vector.length !== EMBEDDING_DIM
  ) {
    return true;
  }
  if (!flatVectorMapHasDim(existing.embeddings, EMBEDDING_DIM)) return true;
  if (!flatVectorMapHasDim(existing.multi?.embeddings, EMBEDDING_DIM)) return true;
  if (!sameKeys(existing.paperVecs, expected.paper_vecs.keys)) return true;
  if (!nestedVectorMapHasDim(existing.paperVecs, EMBEDDING_DIM)) return true;
  if (JSON.stringify(manifest.paper_vecs?.keys) !== JSON.stringify(expected.paper_vecs.keys))
    return true;
  if (manifest.paper_vecs?.dim !== EMBEDDING_DIM) return true;
  return false;
}

// --- record extraction -------------------------------------------------------

/** Anywhere on Earth display: UTC-12 wall clock of `atUtc`. */
function aoeText(atUtc: Date): string {
  return `${fmtUTC(addDays(atUtc, -0.5), "%Y-%m-%d %H:%M:%S")} AoE`;
}

function sortedDeadlines(edition: Edition): Deadline[] {
  return [...edition.deadlines].sort(
    (a, b) =>
      a.round - b.round ||
      deadlineSortTime(a) - deadlineSortTime(b) ||
      cmpStr(a.kind, b.kind) ||
      cmpStr(a.label ?? "", b.label ?? ""),
  );
}

function deadlineSortTime(deadline: Deadline): number {
  if (isExactDeadline(deadline)) return deadline.at_utc.getTime();
  return (
    dateOnlyWindow(deadline.local_date)?.earliestPossibleUtc.getTime() ?? Number.MAX_SAFE_INTEGER
  );
}

/** `(year, kind, at_utc)` groups holding more than one deadline. */
function collisions(editions: Edition[]): Set<string> {
  const seen = new Map<string, number>();
  for (const ed of editions) {
    for (const dl of ed.deadlines) {
      const value = isDateOnlyDeadline(dl)
        ? `date:${dl.local_date}`
        : `instant:${dl.at_utc.getTime()}`;
      const key = `${ed.year}\u0000${dl.kind}\u0000${value}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  const out = new Set<string>();
  for (const [key, count] of seen) {
    if (count > 1) out.add(key);
  }
  return out;
}

export interface DataRecord {
  type: "deadline" | "event";
  categories: string[];
  kind_label: string;
  estimated: boolean;
  conf: Conference;
  edition: Edition;
  deadline: Deadline | null;
  all_day: boolean;
  start: Date;
  end: Date;
}

/** Flatten conferences into rows for CSV and upcoming.md. */
export function recordsOf(confs: Conference[] | null | undefined): DataRecord[] {
  if (!confs || !Array.isArray(confs)) return [];
  const records: DataRecord[] = [];
  for (const conf of [...confs].sort((a, b) => cmpStr(a?.key ?? "", b?.key ?? ""))) {
    if (!conf || typeof conf !== "object") continue;
    const cats = Array.isArray(conf.categories) ? [...conf.categories] : [];
    const editions = (Array.isArray(conf.editions) ? [...conf.editions] : [])
      .filter((e) => e && typeof e === "object")
      .sort(
        (a, b) => (a.year ?? 0) - (b.year ?? 0) || cmpStr(a.edition_id ?? "", b.edition_id ?? ""),
      );
    const collides = collisions(editions);
    editions.forEach((ed) => {
      sortedDeadlines(ed).forEach((dl) => {
        const dateValue = isDateOnlyDeadline(dl)
          ? `date:${dl.local_date}`
          : `instant:${dl.at_utc.getTime()}`;
        let labelJa = KIND_LABEL_JA[dl.kind] ?? KIND_LABEL_JA.other;
        if (collides.has(`${ed.year}\u0000${dl.kind}\u0000${dateValue}`) && dl.label) {
          labelJa = `${labelJa}: ${dl.label}`;
        }
        const dateWindow = isDateOnlyDeadline(dl) ? dateOnlyWindow(dl.local_date) : null;
        const anchor = isDateOnlyDeadline(dl) ? dateWindow?.earliestPossibleUtc : dl.at_utc;
        if (!(anchor instanceof Date)) return;
        records.push({
          type: "deadline",
          categories: cats,
          kind_label: labelJa,
          estimated: ed.estimated,
          conf,
          edition: ed,
          deadline: dl,
          all_day: isDateOnlyDeadline(dl),
          start: isDateOnlyDeadline(dl) ? anchor : new Date(anchor.getTime() - 30 * 60_000),
          end: dateWindow?.latestPossibleUtc ?? anchor,
        });
      });
      if (ed.event_start && !ed.estimated) {
        records.push({
          type: "event",
          categories: cats,
          kind_label: "開催",
          estimated: false,
          conf,
          edition: ed,
          deadline: null,
          all_day: true,
          start: ed.event_start,
          end: ed.event_end ?? ed.event_start,
        });
      }
    });
  }
  return records;
}

function sortKey(rec: DataRecord): [number, string] {
  // 終日項目はその日の 00:00 UTC、それ以外は正確な時刻で並べる。
  const stamp =
    rec.type === "deadline" && rec.deadline && isDateOnlyDeadline(rec.deadline)
      ? rec.start.getTime()
      : rec.all_day
        ? dateOnly(rec.start).getTime()
        : rec.start.getTime();
  return [stamp, `${rec.conf.key}:${rec.deadline?.kind ?? "event"}:${rec.start.getTime()}`];
}

// --- serialisation -----------------------------------------------------------

export function toJson(
  confs: Conference[] | null | undefined,
  config: Record<string, unknown> | null | undefined,
  now: Date | null | undefined,
): Record<string, unknown> {
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const safeConfig = config ?? {};
  const site = (safeConfig.site as Record<string, unknown>) ?? {};
  const domain = String(site.domain ?? "kamiyobi");
  const baseUrl = String(site.base_url ?? `https://${domain}`).replace(/\/+$/, "");
  const categories = (safeConfig.categories as Record<string, string> | null) ?? DEFAULT_CATEGORIES;
  const sources: Array<Record<string, unknown>> =
    (safeConfig.sources as Array<Record<string, unknown>> | null) ?? DEFAULT_SOURCES;
  const sourceByName = new Map(sources.map((source) => [String(source.name ?? ""), source]));
  const evidenceOf = (
    sourceName: string,
    at: Date | null,
    rawValue: string,
    estimated: boolean,
  ): Record<string, unknown> => {
    const source = sourceByName.get(sourceName);
    const sourceUrl = String(
      source?.url ??
        (sourceName === "override"
          ? `${baseUrl}/data/overrides.yaml`
          : sourceName === "local"
            ? `${baseUrl}/data/extra.yaml`
            : String(source?.repo ?? "").startsWith("http")
              ? String(source?.repo)
              : source?.repo
                ? `https://github.com/${String(source.repo)}`
                : ""),
    );
    const sourceClass = estimated
      ? "assumption"
      : sourceName === "local" || sourceName === "override"
        ? "curated-manual"
        : "aggregator";
    return {
      source_name: sourceName,
      source_url: sourceUrl,
      observed_at: "",
      original_value: rawValue || (at ? fmtUTC(at, "%Y-%m-%dT%H:%M:%SZ") : ""),
      confidence: estimated ? "estimated" : "aggregator",
      sourceClass,
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(rawValue || at ? { rawExcerpt: rawValue || fmtUTC(at, "%Y-%m-%dT%H:%M:%SZ") } : {}),
    };
  };
  const outConfs: unknown[] = [];
  for (const conf of [...(confs ?? [])].sort((a, b) => cmpStr(a?.key ?? "", b?.key ?? ""))) {
    if (!conf || typeof conf !== "object") continue;
    const editions: unknown[] = [];
    for (const ed of [...(conf.editions ?? [])].sort(
      (a, b) => (a.year ?? 0) - (b.year ?? 0) || cmpStr(a.edition_id ?? "", b.edition_id ?? ""),
    )) {
      editions.push({
        year: ed.year,
        id: ed.edition_id,
        link: ed.link || conf.link,
        place: ed.place,
        date_text: ed.date_text,
        event_start: ed.event_start ? fmtDate(ed.event_start) : null,
        event_end: ed.event_end ? fmtDate(ed.event_end) : null,
        estimated: ed.estimated,
        ...(ed.estimate ? { estimate: { ...ed.estimate } } : {}),
        source: ed.source,
        ...(ed.identity ? { identity: ed.identity } : {}),
        deadlines: sortedDeadlines(ed).map((dl) => {
          const evidence = dl.evidence?.length
            ? dl.evidence.map((item) => ({ ...item }))
            : [
                evidenceOf(
                  ed.source,
                  isExactDeadline(dl) ? dl.at_utc : null,
                  dl.raw_value ?? "",
                  ed.estimated,
                ),
              ];
          const conflicts = dl.conflicts?.length
            ? dl.conflicts.map((conflict) => ({
                at_utc: fmtUTC(conflict.at_utc, "%Y-%m-%dT%H:%M:%SZ"),
                ...(conflict.local_date
                  ? { precision: "date-only", local_date: conflict.local_date }
                  : {}),
                label: conflict.label,
                source: conflict.source,
                original_value: conflict.raw_value || fmtUTC(conflict.at_utc, "%Y-%m-%dT%H:%M:%SZ"),
                evidence:
                  conflict.evidence ??
                  evidenceOf(
                    conflict.source,
                    conflict.at_utc,
                    conflict.raw_value ?? "",
                    ed.estimated,
                  ),
              }))
            : [];
          const common = {
            kind: dl.kind,
            label: dl.label,
            round: dl.round,
            track: dl.track ?? "",
            comment: dl.comment,
            status: ed.estimated ? "estimated" : "confirmed",
            selection_rule: dl.selection_rule ?? DEADLINE_SELECTION_RULE,
            evidence,
            ...(dl.origins?.length ? { origins: dl.origins.map((origin) => ({ ...origin })) } : {}),
            ...(conflicts.length > 0 ? { conflicts } : {}),
          };
          if (isDateOnlyDeadline(dl)) {
            const window = dateOnlyWindow(dl.local_date);
            if (window === null) throw new Error(`invalid date-only deadline: ${dl.local_date}`);
            return {
              ...common,
              precision: "date-only",
              local_date: dl.local_date,
              earliest_utc: window.earliestPossibleUtc.toISOString(),
              latest_utc: window.latestPossibleUtc.toISOString(),
              utc: null,
              aoe: null,
              tz_raw: null,
            };
          }
          return {
            ...common,
            precision: "exact",
            utc: fmtUTC(dl.at_utc, "%Y-%m-%dT%H:%M:%SZ"),
            aoe: aoeText(dl.at_utc),
            tz_raw: dl.tz_raw,
          };
        }),
      });
    }
    outConfs.push({
      key: conf.key,
      title: conf.title,
      full_name: conf.full_name,
      categories: [...conf.categories],
      rank: { ...conf.rank },
      link: conf.link,
      tags: [...conf.tags],
      sources: [...conf.sources],
      dblp: conf.dblp,
      ...(conf.identity ? { identity: conf.identity } : {}),
      ...(conf.legacy_keys?.length ? { legacy_keys: [...conf.legacy_keys] } : {}),
      ...(conf.category_assignments?.length
        ? {
            category_assignments: conf.category_assignments.map((assignment) => ({
              ...assignment,
            })),
          }
        : {}),
      editions,
      // 代表採択論文タイトル（無い会議は空配列）。語彙一致 + IDF + 埋め込み強化に使う
      papers: VENUE_PAPERS[conf.key] ?? [],
    });
  }
  return {
    generated_at: fmtUTC(safeNow, "%Y-%m-%dT%H:%M:%SZ"),
    site: {
      domain,
      base_url: baseUrl,
    },
    sources,
    categories: { ...categories },
    legacy_key_redirects: (() => {
      const aliases = new Map<string, string[]>();
      for (const conference of confs ?? []) {
        for (const legacy of conference.legacy_keys ?? []) {
          aliases.set(legacy, [...(aliases.get(legacy) ?? []), conference.key]);
        }
      }
      return Object.fromEntries(
        [...aliases]
          .filter(([, targets]) => new Set(targets).size === 1)
          .map(([legacy, targets]) => [legacy, targets[0]!] as const),
      );
    })(),
    conferences: outConfs,
  };
}

type JsonRecord = Record<string, unknown>;

function jsonRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => Boolean(item && typeof item === "object"))
    : [];
}

function jsonStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function jsonTime(value: unknown): number | null {
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? time : null;
}

function jsonDeadlineTime(deadline: JsonRecord): number | null {
  return jsonDeadlineRange(deadline)?.[0] ?? null;
}

function jsonDeadlineRange(deadline: JsonRecord): [number, number] | null {
  const exact = jsonTime(deadline.utc);
  if (exact !== null) return [exact, exact];
  const earliest = jsonTime(deadline.earliest_utc);
  const latest = jsonTime(deadline.latest_utc);
  if (earliest !== null && latest !== null) return [earliest, latest];
  const window = dateOnlyWindow(deadline.local_date);
  return window ? [window.earliestPossibleUtc.getTime(), window.latestPossibleUtc.getTime()] : null;
}

function compactEdition(edition: JsonRecord, deadlines: JsonRecord[]): JsonRecord {
  return {
    year: edition.year,
    id: edition.id,
    link: edition.link,
    place: edition.place,
    date_text: edition.date_text,
    event_start: edition.event_start,
    event_end: edition.event_end,
    estimated: edition.estimated,
    ...(edition.estimate ? { estimate: edition.estimate } : {}),
    source: edition.source,
    deadlines,
  };
}

function compactConference(
  conf: JsonRecord,
  editions: JsonRecord[],
  withPapers: boolean,
): JsonRecord {
  return {
    key: conf.key,
    title: conf.title,
    full_name: conf.full_name,
    categories: conf.categories,
    rank: conf.rank,
    link: conf.link,
    tags: conf.tags,
    sources: conf.sources,
    ...(conf.category_assignments ? { category_assignments: conf.category_assignments } : {}),
    editions,
    ...(withPapers ? { papers: conf.papers ?? [] } : {}),
  };
}

/** The deadline UI payload: metadata plus only the current/near deadline window. */
export function toCatalog(
  data: Record<string, unknown>,
  now: Date | null | undefined,
  days = 180,
): Record<string, unknown> {
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const horizon = safeNow.getTime() + Math.max(1, days) * DAY_MS;
  const lookback = safeNow.getTime() - 30 * DAY_MS;
  const conferences = jsonRecords(data.conferences).map((conf) => {
    const editions = jsonRecords(conf.editions)
      .map((edition) => {
        const deadlines = jsonRecords(edition.deadlines).filter((deadline) => {
          const range = jsonDeadlineRange(deadline);
          return range !== null && range[1] >= lookback && range[0] <= horizon;
        });
        const eventStart = jsonTime(edition.event_start);
        const eventEnd = jsonTime(edition.event_end ?? edition.event_start);
        const inWindow =
          eventStart !== null && eventEnd !== null && eventEnd >= lookback && eventStart <= horizon;
        return inWindow || deadlines.length ? compactEdition(edition, deadlines) : null;
      })
      .filter((edition): edition is JsonRecord => edition !== null);
    return compactConference(conf, editions, false);
  });
  return {
    generated_at: data.generated_at,
    site: data.site,
    sources: data.sources,
    categories: data.categories,
    legacy_key_redirects: data.legacy_key_redirects,
    window: { lookback_days: 30, upcoming_days: Math.max(1, days) },
    history_ref: "data.json",
    recommendation_ref: "recommendation-index.json",
    conferences,
  };
}

/** The recommendation payload: venue profiles and one representative availability record. */
export function toRecommendationIndex(
  data: Record<string, unknown>,
  now: Date | null | undefined,
  sourceStatus: Record<string, string> = {},
): Record<string, unknown> {
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const reranker = (() => {
    try {
      return JSON.parse(readFileSync(join(ROOT, "data", "recommender-reranker.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  const conferences = jsonRecords(data.conferences).map((conf) => {
    const editions = jsonRecords(conf.editions)
      .map((edition) => {
        const deadlines = jsonRecords(edition.deadlines)
          .filter((deadline) => ["abstract", "paper"].includes(String(deadline.kind)))
          .sort(
            (a, b) =>
              (jsonDeadlineTime(a) ?? Number.MAX_SAFE_INTEGER) -
              (jsonDeadlineTime(b) ?? Number.MAX_SAFE_INTEGER),
          );
        if (!deadlines.length) return null;
        const future = deadlines.find((deadline) => {
          const range = jsonDeadlineRange(deadline);
          return range !== null && range[1] >= safeNow.getTime();
        });
        const selected = future ?? deadlines[deadlines.length - 1];
        const origins = jsonRecords(selected.evidence)
          .map((evidence) => {
            const source = String(
              evidence.source_name ?? evidence.sourceName ?? edition.source ?? "",
            );
            const status = sourceStatus[source];
            return {
              source,
              ...(typeof evidence.sourceClass === "string"
                ? { sourceClass: evidence.sourceClass }
                : {}),
              revision:
                typeof evidence.sourceRevision === "string" ? evidence.sourceRevision : null,
              fetchedAt: typeof evidence.retrievedAt === "string" ? evidence.retrievedAt : null,
              freshness:
                status === "cache-fallback" || status === "snapshot-fallback" ? status : "fresh",
            };
          })
          .filter((origin) => origin.source);
        return compactEdition(edition, [{ ...selected, ...(origins.length ? { origins } : {}) }]);
      })
      .filter((edition): edition is JsonRecord => edition !== null);
    const recommendationConference = compactConference(conf, editions, true);
    return {
      ...recommendationConference,
      recommendation_axes: recommendationAxes(
        { ...recommendationConference, all_editions: conf.editions },
        null,
        safeNow.getTime(),
      ),
    };
  });
  return {
    generated_at: data.generated_at,
    site: data.site,
    sources: data.sources,
    categories: data.categories,
    legacy_key_redirects: data.legacy_key_redirects,
    history_ref: "data.json",
    embedding_ref: "embeddings.json",
    embedding_manifest: embeddingManifest(data as Parameters<typeof embeddingManifest>[0]),
    ...(reranker ? { reranker } : {}),
    conferences,
  };
}

export type HealthSourceStatus =
  | "fresh"
  | "cache-fallback"
  | "snapshot-fallback"
  | "failed"
  | "success";

export const HEALTH_SCHEMA_VERSION = 3;
export const HEALTH_DEADLINE_LOOKBACK_MS = 14 * DAY_MS;

export interface HealthOutputFile {
  bytes: number;
  sha256: string;
}

export interface HealthSourceMetadata {
  source: string;
  status: HealthSourceStatus;
  revision: string | null;
  fetchedAt: string | null;
  contentHash: string | null;
  cacheAgeSeconds: number | null;
  conferenceCount: number;
  editionCount: number;
  deadlineCount: number;
  observationStatus?: "fresh" | "stale" | "unknown";
  observedAt?: string | null;
  observationAgeSeconds?: number | null;
}

export type SemanticStatus = "ready" | "lexical-only";

export interface PublishArtifact {
  bytes: number;
  sha256: string;
}

export interface PublishInput {
  sha256: string;
}

export interface PublishManifest {
  schema_version: 1 | 2 | 3 | 4;
  generated_at: string;
  semantic_status: SemanticStatus;
  artifacts: Record<string, PublishArtifact>;
  build_id?: string;
  content_id?: string;
  profile_hash?: string;
  source_commit?: string | null;
  data_commit?: string | null;
  workflow_run_id?: string | null;
  dirty_worktree?: boolean | null;
  inputs?: Record<string, PublishInput>;
  promotion_batches?: Array<{ id: string; sha256: string }>;
  build?: PublishBuildContext;
}

export interface PublishBuildContext {
  now: string;
  offline: boolean | null;
  node: string;
  command: string;
  source_cache: "offline-with-snapshot-fallback" | "online-refresh" | "unspecified";
}

export interface PublishProvenance {
  sourceCommit: string | null;
  dataCommit: string | null;
  workflowRunId: string | null;
  dirtyWorktree: boolean | null;
  inputs: Record<string, PublishInput>;
  promotionBatches: Array<{ id: string; sha256: string }>;
  build: PublishBuildContext;
}

export function publishBuildId(now: Date, profileHash: string): string {
  return createHash("sha256")
    .update(`${now.toISOString()}\0${profileHash}`)
    .digest("hex")
    .slice(0, 16);
}

export function publishContentId(provenance: PublishProvenance, profileHash: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        source_commit: provenance.sourceCommit,
        inputs: Object.entries(provenance.inputs).sort(([left], [right]) => cmpStr(left, right)),
        promotion_batches: provenance.promotionBatches,
        profile_hash: profileHash,
        models: [
          [EMBEDDING_MODEL, EMBEDDING_REVISION],
          [EMBEDDING_MULTI_MODEL, EMBEDDING_MULTI_REVISION],
        ],
        runtime: EMBEDDING_RUNTIME_VERSION,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function gitOutput(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return null;
  }
}

function promotionBatches(root: string): Array<{ id: string; sha256: string }> {
  const batches: Array<{ id: string; sha256: string }> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (name === "manifest.json") {
        let id = relative(root, dirname(path));
        try {
          const value = JSON.parse(readFileSync(path, "utf8")) as { id?: unknown };
          if (typeof value.id === "string" && value.id) id = value.id;
        } catch {
          // The raw manifest hash is still useful provenance when its optional ID is unreadable.
        }
        batches.push({ id, sha256: sha256File(path) });
      }
    }
  };
  const data = join(root, "data", "promotions");
  if (existsSync(data)) walk(data);
  return batches.sort((a, b) => cmpStr(a.id, b.id) || cmpStr(a.sha256, b.sha256));
}

/** Capture only repository inputs that can affect a fixed-clock publication. */
export function collectPublishProvenance(
  root = ROOT,
  configPath = join(root, "config.yaml"),
  build?: { now?: Date; offline?: boolean },
): PublishProvenance {
  const sourceCommit = process.env.GITHUB_SHA?.trim() || gitOutput(root, ["rev-parse", "HEAD"]);
  const inputs = Object.fromEntries(
    [
      configPath,
      ...[
        "extra.yaml",
        "overrides.yaml",
        "primary_overrides.yaml",
        "recommender-reranker.json",
        "snapshot.json",
        "venue-profiles.json",
      ].map((name) => join(root, "data", name)),
    ]
      .filter(existsSync)
      .sort(cmpStr)
      .map((path) => [relative(root, path) || path, { sha256: sha256File(path) }]),
  );
  const dirty = gitOutput(root, ["status", "--porcelain", "--untracked-files=no"]);
  return {
    sourceCommit,
    dataCommit: sourceCommit,
    workflowRunId: process.env.GITHUB_RUN_ID?.trim() || null,
    dirtyWorktree: dirty === null ? null : dirty.length > 0,
    inputs,
    promotionBatches: promotionBatches(root),
    build: {
      now: build?.now?.toISOString() ?? new Date(0).toISOString(),
      offline: build?.offline ?? null,
      node: process.version,
      command:
        "node src/cli.ts build --out <dir> --cache <dir> --now <publish.build.now> [--offline]",
      source_cache:
        build?.offline === true
          ? "offline-with-snapshot-fallback"
          : build?.offline === false
            ? "online-refresh"
            : "unspecified",
    },
  };
}

function priorPublishProvenance(outdir: string): PublishProvenance | null {
  try {
    const value = JSON.parse(readFileSync(join(outdir, "publish.json"), "utf8")) as PublishManifest;
    if (
      ![3, 4].includes(value.schema_version) ||
      !value.inputs ||
      !value.promotion_batches ||
      !value.build ||
      !(value.source_commit === null || typeof value.source_commit === "string") ||
      !(value.data_commit === null || typeof value.data_commit === "string") ||
      !(value.workflow_run_id === null || typeof value.workflow_run_id === "string") ||
      !(value.dirty_worktree === null || typeof value.dirty_worktree === "boolean")
    )
      return null;
    return {
      sourceCommit: value.source_commit,
      dataCommit: value.data_commit,
      workflowRunId: value.workflow_run_id,
      dirtyWorktree: value.dirty_worktree,
      inputs: value.inputs,
      promotionBatches: value.promotion_batches,
      build: value.build,
    };
  } catch {
    return null;
  }
}

export interface HealthDeadlineRef {
  deadline_id: string;
  at_utc?: string;
  local_date?: string;
  evidence_hash?: string;
  edition_year?: number;
  earliest_utc?: string;
  latest_utc?: string;
  evidence?: HealthDeadlineEvidence[];
}

export type HealthDeadlineEvidence = Pick<
  DeadlineEvidence,
  | "sourceClass"
  | "sourceUrl"
  | "sourceRevision"
  | "retrievedAt"
  | "verifiedAt"
  | "contentHash"
  | "verifiedFields"
>;

/** Schema 1 last-known-good reports embedded the UTC instant in `id`. */
export interface LegacyHealthDeadlineRef {
  id: string;
  at_utc: string;
}

export interface HealthReport {
  schema_version: 1 | 2 | typeof HEALTH_SCHEMA_VERSION;
  generated_at: string;
  profile_hash: string;
  source_status: Record<string, HealthSourceStatus>;
  source_metadata?: Record<string, HealthSourceMetadata>;
  source_failures: string[];
  build_input_mode?: "online-refresh" | "offline-snapshot";
  tracked_venues: number;
  future_confirmed_venues: number;
  future_estimated_venues: number;
  confirmed_deadlines: number;
  estimated_deadlines: number;
  confirmed_future_deadlines: number;
  estimated_future_deadlines: number;
  venues_with_confirmed_future_deadline: number;
  future_exact_deadlines?: number;
  future_date_only_deadlines?: number;
  future_estimated_deadlines?: number;
  venues_with_exact_future_deadline?: number;
  venues_with_date_only_future_deadline?: number;
  snapshot_fallback: boolean;
  parse_warnings: Record<string, number>;
  warning_codes?: Record<string, { count: number; messages: string[] }>;
  identity_conflicts?: {
    venue: number;
    edition: number;
    new_since_baseline: number;
    details: Array<{
      scope: "venue" | "edition";
      reason: string;
      subject: string;
      candidates: string[];
    }>;
  };
  parse_warning_count: number;
  category_distribution: Record<string, number>;
  category_counts: Record<string, number>;
  required_venues: Record<string, "present" | "missing">;
  output_files: Record<string, HealthOutputFile>;
  deadline_refs?: HealthDeadlineRef[];
  confirmed_deadline_refs?: Array<HealthDeadlineRef | LegacyHealthDeadlineRef>;
}

export interface HealthReportOptions {
  sourceStatus?: Record<string, HealthSourceStatus>;
  sourceMetadata?: Record<string, HealthSourceMetadata>;
  recommendationSourceStatus?: Record<string, HealthSourceStatus>;
  buildInputMode?: "online-refresh" | "offline-snapshot";
  sourceFailures?: string[];
  snapshotFallback?: boolean;
  parseWarnings?: Record<string, number>;
  parseWarningCount?: number;
  warningCodes?: Record<string, { count: number; messages: string[] }>;
  identityConflicts?: Array<{
    scope: "venue" | "edition";
    reason: string;
    subject: string;
    candidates: string[];
  }>;
  requiredVenues?: string[];
  profileHash?: string;
  outputFiles?: Record<string, HealthOutputFile>;
}

export function normalizedTrackKey(
  label: string | null | undefined,
  kind: string,
  explicitTrack?: string | null | undefined,
): string {
  return deadlineTrackKey(label, kind, explicitTrack);
}

export function deadlineSlotId(
  venueId: string,
  editionId: string,
  kind: string,
  round: number,
  track: string,
): string {
  return [venueId, editionId, kind, String(round), track].join("|");
}

function deadlineRound(value: unknown): number {
  const round = Number(value ?? 1);
  return Number.isFinite(round) && round >= 1 ? Math.trunc(round) : 1;
}

function officialEvidenceHash(deadline: JsonRecord): string | undefined {
  const items = jsonRecords(deadline.evidence)
    .filter((item) => ["official-cfp", "publisher"].includes(String(item.sourceClass ?? "")))
    .filter((item) => {
      const fields = jsonStrings(item.verifiedFields);
      return (
        fields.includes("date") && (fields.includes("time") ? fields.includes("timezone") : true)
      );
    })
    .map(
      (item) =>
        `${String(item.sourceUrl ?? item.source_url ?? "")}\n${String(item.contentHash ?? item.sourceRevision ?? item.original_value ?? "")}`,
    )
    .filter((row) => row !== "\n")
    .sort(cmpStr);
  if (items.length === 0) return undefined;
  return createHash("sha256").update(items.join("\n")).digest("hex").slice(0, 16);
}

function healthEvidence(deadline: JsonRecord): HealthDeadlineEvidence[] {
  return jsonRecords(deadline.evidence)
    .map((item): HealthDeadlineEvidence | null => {
      const sourceClass = String(item.sourceClass ?? "");
      const sourceUrl = String(item.sourceUrl ?? item.source_url ?? "");
      const fields = jsonStrings(item.verifiedFields).filter((field) =>
        ["date", "time", "timezone", "kind", "round", "track"].includes(field),
      ) as NonNullable<DeadlineEvidence["verifiedFields"]>;
      if (!sourceClass && !sourceUrl && fields.length === 0) return null;
      return {
        ...(sourceClass ? { sourceClass: sourceClass as DeadlineEvidence["sourceClass"] } : {}),
        ...(sourceUrl ? { sourceUrl } : {}),
        ...(typeof item.sourceRevision === "string" ? { sourceRevision: item.sourceRevision } : {}),
        ...(typeof item.retrievedAt === "string" ? { retrievedAt: item.retrievedAt } : {}),
        ...(typeof item.verifiedAt === "string" ? { verifiedAt: item.verifiedAt } : {}),
        ...(typeof item.contentHash === "string" ? { contentHash: item.contentHash } : {}),
        ...(fields.length > 0 ? { verifiedFields: fields } : {}),
      };
    })
    .filter((item): item is HealthDeadlineEvidence => item !== null);
}

/** Build a deterministic health summary from the exact data payload being published. */
export function healthReport(
  data: Record<string, unknown>,
  now: Date | null | undefined,
  options: HealthReportOptions = {},
): HealthReport {
  const generatedAt = Date.parse(String(data.generated_at ?? ""));
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now.getTime() : generatedAt;
  const conferences = jsonRecords(data.conferences);
  const sourceNames = jsonRecords(data.sources)
    .map((source) => String(source.name ?? "").trim())
    .filter(Boolean);
  const sourceStatus = Object.fromEntries(
    [...new Set([...sourceNames, ...Object.keys(options.sourceStatus ?? {})])]
      .sort(cmpStr)
      .map((name) => [name, options.sourceStatus?.[name] ?? "success"]),
  ) as Record<string, HealthSourceStatus>;
  const sourceFailures = [
    ...new Set([
      ...Object.entries(sourceStatus)
        .filter(([, status]) => status === "failed")
        .map(([name]) => name),
      ...(options.sourceFailures ?? []),
    ]),
  ].sort(cmpStr);
  const categoryCounts: Record<string, number> = {};
  const presentVenues = new Set<string>();
  const confirmedVenues = new Set<string>();
  const exactVenues = new Set<string>();
  const dateOnlyVenues = new Set<string>();
  const estimatedVenues = new Set<string>();
  let confirmedDeadlines = 0;
  let estimatedDeadlines = 0;
  let futureExact = 0;
  let futureDateOnly = 0;
  let futureEstimated = 0;
  const deadlineRefs: HealthDeadlineRef[] = [];
  const lookbackStart = safeNow - HEALTH_DEADLINE_LOOKBACK_MS;
  for (const conference of conferences) {
    const key = String(conference.key ?? "").trim();
    if (key) presentVenues.add(key);
    for (const category of jsonStrings(conference.categories)) {
      categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    }
    for (const edition of jsonRecords(conference.editions)) {
      const estimated = Boolean(edition.estimated);
      let hasFuture = false;
      const editionYear = Number(edition.year);
      const editionId =
        String(edition.id ?? edition.edition_id ?? "").trim() ||
        (Number.isInteger(editionYear) && editionYear > 0 ? String(editionYear) : "");
      for (const deadline of jsonRecords(edition.deadlines)) {
        const dateOnlyPrecision = deadline.precision === "date-only";
        const range = jsonDeadlineRange(deadline);
        if (range === null) continue;
        const [timestamp, latest] = range;
        if (!estimated && key && latest >= lookbackStart) {
          const kind = String(deadline.kind ?? "other").trim() || "other";
          const round = deadlineRound(deadline.round);
          const track = normalizedTrackKey(
            String(deadline.label ?? ""),
            kind,
            typeof deadline.track === "string" ? deadline.track : "",
          );
          const ref: HealthDeadlineRef = {
            deadline_id: deadlineSlotId(key, editionId, kind, round, track),
            ...(dateOnlyPrecision
              ? { local_date: String(deadline.local_date) }
              : { at_utc: new Date(timestamp).toISOString() }),
          };
          if (Number.isInteger(editionYear) && editionYear > 0) ref.edition_year = editionYear;
          ref.earliest_utc = new Date(timestamp).toISOString();
          ref.latest_utc = new Date(latest).toISOString();
          const evidenceHash = officialEvidenceHash(deadline);
          if (evidenceHash) ref.evidence_hash = evidenceHash;
          const evidence = healthEvidence(deadline);
          if (evidence.length > 0) ref.evidence = evidence;
          deadlineRefs.push(ref);
          // A merge conflict is an alternate observed value in this exact slot.
          // Keep it in health refs so the gate cannot silently bless the winner.
          for (const conflict of jsonRecords(deadline.conflicts)) {
            const conflictDate = asDate(conflict.local_date);
            if (conflictDate !== null) {
              const localDate = fmtDate(conflictDate);
              const conflictWindow = dateOnlyWindow(localDate)!;
              deadlineRefs.push({
                deadline_id: ref.deadline_id,
                local_date: localDate,
                earliest_utc: conflictWindow.earliestPossibleUtc.toISOString(),
                latest_utc: conflictWindow.latestPossibleUtc.toISOString(),
                ...(ref.edition_year === undefined ? {} : { edition_year: ref.edition_year }),
              });
              continue;
            }
            const conflictAt = Date.parse(String(conflict.at_utc ?? ""));
            // Upstreams normalize an HH:MM deadline to either :00 or :59. Only that
            // conventional pair is equivalent; other sub-minute differences are real conflicts.
            const seconds = new Set([conflictAt % 60_000, timestamp % 60_000]);
            if (
              !Number.isFinite(conflictAt) ||
              (Math.floor(conflictAt / 60_000) === Math.floor(timestamp / 60_000) &&
                seconds.size === 2 &&
                seconds.has(0) &&
                seconds.has(59_000))
            )
              continue;
            const alternate: HealthDeadlineRef = {
              deadline_id: ref.deadline_id,
              at_utc: new Date(conflictAt).toISOString(),
              earliest_utc: new Date(conflictAt).toISOString(),
              latest_utc: new Date(conflictAt).toISOString(),
              ...(ref.edition_year === undefined ? {} : { edition_year: ref.edition_year }),
            };
            const alternateEvidence = healthEvidence(conflict);
            if (alternateEvidence.length > 0) alternate.evidence = alternateEvidence;
            deadlineRefs.push(alternate);
          }
        }
        if (latest < safeNow) continue;
        hasFuture = true;
        if (estimated) {
          estimatedDeadlines += 1;
          futureEstimated += 1;
        } else if (dateOnlyPrecision) {
          confirmedDeadlines += 1;
          futureDateOnly += 1;
          if (key) dateOnlyVenues.add(key);
        } else {
          confirmedDeadlines += 1;
          futureExact += 1;
          if (key) exactVenues.add(key);
        }
      }
      if (hasFuture && key) (estimated ? estimatedVenues : confirmedVenues).add(key);
    }
  }
  const parseWarnings = Object.fromEntries(
    Object.entries(options.parseWarnings ?? {})
      .filter(([, count]) => Number.isFinite(count) && count > 0)
      .sort(([a], [b]) => cmpStr(a, b)),
  );
  const sortedCategories = Object.fromEntries(
    Object.entries(categoryCounts).sort(([a], [b]) => cmpStr(a, b)),
  );
  const required = [
    ...new Set((options.requiredVenues ?? []).map((key) => String(key).trim()).filter(Boolean)),
  ].sort(cmpStr);
  const parseWarningCount =
    options.parseWarningCount ??
    Object.values(parseWarnings).reduce((sum, count) => sum + count, 0);
  const profileHash =
    options.profileHash ?? embeddingProfileHash(data as Parameters<typeof embeddingProfileHash>[0]);
  const sortedDeadlineRefs = [...deadlineRefs].sort(
    (a, b) =>
      cmpStr(a.deadline_id, b.deadline_id) ||
      cmpStr(a.at_utc ?? a.local_date ?? "", b.at_utc ?? b.local_date ?? ""),
  );
  const identityConflicts = [...(options.identityConflicts ?? [])].sort(
    (left, right) =>
      cmpStr(left.scope, right.scope) ||
      cmpStr(left.reason, right.reason) ||
      cmpStr(left.subject, right.subject),
  );
  return {
    schema_version: HEALTH_SCHEMA_VERSION,
    generated_at: String(data.generated_at ?? ""),
    profile_hash: profileHash,
    source_status: sourceStatus,
    source_metadata: options.sourceMetadata,
    source_failures: sourceFailures,
    build_input_mode: options.buildInputMode,
    tracked_venues: conferences.length,
    future_confirmed_venues: confirmedVenues.size,
    future_estimated_venues: estimatedVenues.size,
    confirmed_deadlines: confirmedDeadlines,
    estimated_deadlines: estimatedDeadlines,
    confirmed_future_deadlines: confirmedDeadlines,
    estimated_future_deadlines: estimatedDeadlines,
    venues_with_confirmed_future_deadline: confirmedVenues.size,
    future_exact_deadlines: futureExact,
    future_date_only_deadlines: futureDateOnly,
    future_estimated_deadlines: futureEstimated,
    venues_with_exact_future_deadline: exactVenues.size,
    venues_with_date_only_future_deadline: dateOnlyVenues.size,
    snapshot_fallback: Boolean(options.snapshotFallback),
    parse_warnings: parseWarnings,
    warning_codes: options.warningCodes,
    identity_conflicts: {
      venue: identityConflicts.filter((conflict) => conflict.scope === "venue").length,
      edition: identityConflicts.filter((conflict) => conflict.scope === "edition").length,
      new_since_baseline: 0,
      details: identityConflicts,
    },
    parse_warning_count: Math.max(0, Number(parseWarningCount) || 0),
    category_distribution: sortedCategories,
    category_counts: sortedCategories,
    required_venues: Object.fromEntries(
      required.map((key) => [key, presentVenues.has(key) ? "present" : "missing"]),
    ),
    output_files: Object.fromEntries(
      Object.entries(options.outputFiles ?? {}).sort(([a], [b]) => cmpStr(a, b)),
    ),
    deadline_refs: sortedDeadlineRefs,
  };
}

export interface HealthGateResult {
  ok: boolean;
  reasons: string[];
  warnings: string[];
}

function reportNumber(report: Partial<HealthReport>, primary: string, fallback: string): number {
  const value = report[primary as keyof HealthReport];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const oldValue = report[fallback as keyof HealthReport];
  return typeof oldValue === "number" && Number.isFinite(oldValue) ? oldValue : 0;
}

function reportSourceFailures(report: Partial<HealthReport>): string[] {
  return [
    ...new Set([
      ...(Array.isArray(report.source_failures) ? report.source_failures : []),
      ...Object.entries(report.source_status ?? {})
        .filter(([, status]) => status === "failed")
        .map(([name]) => name),
    ]),
  ].sort(cmpStr);
}

function reportWarningCount(report: Partial<HealthReport>): number {
  if (typeof report.parse_warning_count === "number") return report.parse_warning_count;
  return Object.values(report.parse_warnings ?? {}).reduce(
    (sum, count) => sum + (Number.isFinite(count) ? count : 0),
    0,
  );
}

function reportRequiredVenues(
  report: Partial<HealthReport>,
): Record<string, "present" | "missing"> {
  return report.required_venues ?? {};
}

function reportDeadlineRefs(report: Partial<HealthReport>): HealthDeadlineRef[] | null {
  const value = report.deadline_refs ?? report.confirmed_deadline_refs;
  if (!Array.isArray(value)) return null;
  const refs: HealthDeadlineRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const rec = item as unknown as Record<string, unknown>;
    const deadlineId = String(rec.deadline_id ?? rec.id ?? "").trim();
    const atUtc = rec.at_utc;
    const localDate = String(rec.local_date ?? "");
    if (!deadlineId) return null;
    const parsedLocalDate = asDate(localDate);
    if (
      (typeof atUtc !== "string" || !Number.isFinite(Date.parse(atUtc))) &&
      parsedLocalDate === null
    )
      return null;
    const ref: HealthDeadlineRef = { deadline_id: deadlineId };
    if (parsedLocalDate !== null) {
      ref.local_date = fmtDate(parsedLocalDate);
      const window = dateOnlyWindow(ref.local_date)!;
      ref.earliest_utc = window.earliestPossibleUtc.toISOString();
      ref.latest_utc = window.latestPossibleUtc.toISOString();
    } else {
      ref.at_utc = new Date(Date.parse(String(atUtc))).toISOString();
      ref.earliest_utc = ref.at_utc;
      ref.latest_utc = ref.at_utc;
    }
    if (typeof rec.earliest_utc === "string" && Number.isFinite(Date.parse(rec.earliest_utc))) {
      ref.earliest_utc = new Date(Date.parse(rec.earliest_utc)).toISOString();
    }
    if (typeof rec.latest_utc === "string" && Number.isFinite(Date.parse(rec.latest_utc))) {
      ref.latest_utc = new Date(Date.parse(rec.latest_utc)).toISOString();
    }
    if (typeof rec.evidence_hash === "string" && rec.evidence_hash.trim()) {
      ref.evidence_hash = rec.evidence_hash.trim();
    }
    const evidence = healthEvidence(rec);
    if (evidence.length > 0) ref.evidence = evidence;
    if (typeof rec.edition_year === "number" && Number.isInteger(rec.edition_year)) {
      ref.edition_year = rec.edition_year;
    }
    refs.push(ref);
  }
  return refs;
}

function hasDeadlineRefs(report: Partial<HealthReport>): boolean {
  return report.deadline_refs !== undefined || report.confirmed_deadline_refs !== undefined;
}

interface DeadlineSlot {
  deadline_id: string;
  venue: string;
  edition: string;
  kind: string;
  round: number;
  track: string;
  year: number | null;
  earliest_ms: number;
  latest_ms: number;
  precision: "exact" | "date-only";
  evidence_hash?: string;
  evidence: HealthDeadlineEvidence[];
}

function parseDeadlineSlot(ref: HealthDeadlineRef): DeadlineSlot | null {
  const parts = ref.deadline_id.split("|");
  if (parts.length >= 4 && Number.isFinite(Date.parse(parts[parts.length - 1] ?? ""))) {
    parts.pop();
  }
  const venue = (parts[0] ?? "").trim();
  const edition = (parts[1] ?? "").trim();
  const kind = (parts[2] ?? "other").trim() || "other";
  if (!venue || !kind) return null;
  let round = 1;
  let track = "";
  if (parts.length >= 4 && /^\d+$/.test(parts[3] ?? "")) {
    round = deadlineRound(parts[3]);
    track = parts.slice(4).join("|");
  } else if (parts.length >= 4) {
    track = parts.slice(3).join("|");
  }
  const yearFromEdition = /^\d{4}$/.test(edition) ? Number(edition) : null;
  const precision = ref.local_date ? "date-only" : "exact";
  const fallback = ref.local_date ? dateOnlyWindow(ref.local_date) : null;
  const earliestMs = Date.parse(
    String(ref.earliest_utc ?? fallback?.earliestPossibleUtc ?? ref.at_utc),
  );
  const latestMs = Date.parse(String(ref.latest_utc ?? fallback?.latestPossibleUtc ?? ref.at_utc));
  if (!Number.isFinite(earliestMs) || !Number.isFinite(latestMs) || earliestMs > latestMs)
    return null;
  return {
    deadline_id: deadlineSlotId(venue, edition, kind, round, track),
    venue,
    edition,
    kind,
    round,
    track,
    year: ref.edition_year ?? yearFromEdition,
    earliest_ms: earliestMs,
    latest_ms: latestMs,
    precision,
    evidence_hash: ref.evidence_hash,
    evidence: ref.evidence ?? [],
  };
}

function matchDeadlineSlots(
  previous: DeadlineSlot[],
  current: DeadlineSlot[],
  allowIdentityMigration: boolean,
): {
  pairs: Array<{ previous: DeadlineSlot; current: DeadlineSlot }>;
  unmatchedPrevious: DeadlineSlot[];
} {
  const usedPrevious = new Set<number>();
  const usedCurrent = new Set<number>();
  const pairs: Array<{ previous: DeadlineSlot; current: DeadlineSlot }> = [];

  // Edition id の改名・重複 (例: override-2027 と mobicom27 が同値で fold) は slot 内容が同一でも
  // 「future deadline disappeared」の誤検知になる。venue + kind/round/track + 時刻が完全一致する
  // slot は同一締切として扱う: previous 側の重複を先に潰してから 1:1 で対にする。
  const identityKey = (slot: DeadlineSlot): string =>
    [slot.venue, slot.kind, slot.round, slot.track, slot.earliest_ms, slot.latest_ms].join("\0");
  const representativeOf = new Map<string, number>();
  previous.forEach((slot, index) => {
    const key = identityKey(slot);
    const first = representativeOf.get(key);
    if (first === undefined) representativeOf.set(key, index);
    else usedPrevious.add(index); // 同一締切の重複 ref は比較対象から外す
  });

  if (allowIdentityMigration)
    previous.forEach((slot, previousIndex) => {
      if (usedPrevious.has(previousIndex)) return;
      const candidates = current
        .map((candidate, index) => ({ candidate, index }))
        .filter(
          ({ candidate, index }) =>
            !usedCurrent.has(index) &&
            candidate.venue === slot.venue &&
            candidate.earliest_ms === slot.earliest_ms &&
            candidate.latest_ms === slot.latest_ms,
        )
        .sort(
          (a, b) =>
            Number(a.candidate.deadline_id !== slot.deadline_id) -
              Number(b.candidate.deadline_id !== slot.deadline_id) ||
            Number(a.candidate.edition !== slot.edition) -
              Number(b.candidate.edition !== slot.edition) ||
            Number(a.candidate.kind !== slot.kind) - Number(b.candidate.kind !== slot.kind) ||
            a.index - b.index,
        );
      if (candidates.length === 0) return;
      const currentIndex = candidates[0].index;
      usedPrevious.add(previousIndex);
      usedCurrent.add(currentIndex);
      pairs.push({ previous: slot, current: current[currentIndex] });
    });

  const currentById = new Map<string, number[]>();
  current.forEach((slot, index) => {
    const list = currentById.get(slot.deadline_id) ?? [];
    list.push(index);
    currentById.set(slot.deadline_id, list);
  });
  previous.forEach((slot, previousIndex) => {
    if (usedPrevious.has(previousIndex)) return;
    const candidates = (currentById.get(slot.deadline_id) ?? []).filter(
      (index) => !usedCurrent.has(index),
    );
    if (candidates.length === 0) return;
    candidates.sort((a, b) => current[a].earliest_ms - current[b].earliest_ms || a - b);
    const currentIndex = candidates[0];
    usedPrevious.add(previousIndex);
    usedCurrent.add(currentIndex);
    pairs.push({ previous: slot, current: current[currentIndex] });
  });

  return {
    pairs,
    unmatchedPrevious: previous.filter((_, index) => !usedPrevious.has(index)),
  };
}

function resolveSlotGroups(
  slots: DeadlineSlot[],
  side: string,
): { slots: DeadlineSlot[]; reasons: string[]; warnings: string[] } {
  const grouped = new Map<string, DeadlineSlot[]>();
  for (const slot of slots)
    grouped.set(slot.deadline_id, [...(grouped.get(slot.deadline_id) ?? []), slot]);
  const resolved: DeadlineSlot[] = [];
  const reasons: string[] = [];
  const warnings: string[] = [];
  for (const [id, members] of grouped) {
    const exact = members.filter((member) => member.precision === "exact");
    const dateOnly = members.filter((member) => member.precision === "date-only");
    const exactValues = new Set(exact.map((member) => `${member.earliest_ms}/${member.latest_ms}`));
    const dateOnlyValues = new Set(
      dateOnly.map((member) => `${member.earliest_ms}/${member.latest_ms}`),
    );
    if (
      exactValues.size > 1 ||
      dateOnlyValues.size > 1 ||
      exact.length > 1 ||
      dateOnly.length > 1
    ) {
      if (exactValues.size === 1 && dateOnlyValues.size === 0) {
        warnings.push(`${side} duplicate deadline slot: ${id}`);
        resolved.push(exact[0]);
        continue;
      }
      if (dateOnlyValues.size === 1 && exactValues.size === 0) {
        warnings.push(`${side} duplicate deadline slot: ${id}`);
        resolved.push(dateOnly[0]);
        continue;
      }
    }
    if (exact.length > 0 && dateOnly.length > 0) {
      const exactValue = exact[0];
      const dateValue = dateOnly[0];
      if (
        exactValues.size === 1 &&
        dateOnlyValues.size === 1 &&
        exactValue.earliest_ms >= dateValue.earliest_ms &&
        exactValue.latest_ms <= dateValue.latest_ms
      ) {
        warnings.push(`${side} deadline slot precision resolved: ${id}`);
        resolved.push(exactValue);
        continue;
      }
    }
    if (members.length === 1) {
      resolved.push(members[0]);
      continue;
    }
    reasons.push(`${side} deadline slot conflict: ${id}`);
  }
  return { slots: resolved, reasons, warnings };
}

function evidenceIdentity(evidence: HealthDeadlineEvidence): string {
  return `${evidence.sourceClass ?? ""}\n${evidence.sourceUrl ?? ""}\n${evidence.contentHash ?? evidence.sourceRevision ?? ""}`;
}

function evidenceTime(evidence: HealthDeadlineEvidence): number | null {
  const value = Date.parse(String(evidence.verifiedAt ?? evidence.retrievedAt ?? ""));
  return Number.isFinite(value) ? value : null;
}

function authorizesEarlier(previous: DeadlineSlot, current: DeadlineSlot): boolean {
  const required = current.precision === "exact" ? ["date", "time", "timezone"] : ["date"];
  const official = (evidence: HealthDeadlineEvidence): boolean =>
    (evidence.sourceClass === "official-cfp" || evidence.sourceClass === "publisher") &&
    Boolean(evidence.contentHash || evidence.sourceRevision) &&
    evidenceTime(evidence) !== null;
  const prior = previous.evidence.filter(
    (evidence) => official(evidence) && evidence.verifiedFields?.includes("date"),
  );
  const latestPrior = Math.max(
    ...prior.map((evidence) => evidenceTime(evidence)!),
    Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(latestPrior)) return false;
  const priorIds = new Set(prior.map(evidenceIdentity));
  return current.evidence.some((evidence) => {
    const time = evidenceTime(evidence);
    return (
      official(evidence) &&
      required.every((field) => evidence.verifiedFields?.includes(field as never)) &&
      time !== null &&
      time > latestPrior &&
      !priorIds.has(evidenceIdentity(evidence))
    );
  });
}

function authorizesPrecisionCorrection(previous: DeadlineSlot, current: DeadlineSlot): boolean {
  if (current.earliest_ms > previous.earliest_ms || current.latest_ms < previous.latest_ms)
    return false;
  return current.evidence.some(
    (evidence) =>
      (evidence.sourceClass === "official-cfp" || evidence.sourceClass === "publisher") &&
      Boolean(evidence.contentHash || evidence.sourceRevision) &&
      evidenceTime(evidence) !== null &&
      evidence.verifiedFields?.includes("date"),
  );
}

function semanticDeadlineRegressions(
  previousRefs: HealthDeadlineRef[],
  currentRefs: HealthDeadlineRef[],
  previousTime: number,
  currentTime: number,
  allowIdentityMigration: boolean,
): HealthGateResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const previous: DeadlineSlot[] = [];
  const current: DeadlineSlot[] = [];
  for (const ref of previousRefs) {
    const slot = parseDeadlineSlot(ref);
    if (!slot) {
      reasons.push(`previous confirmed deadline references are malformed`);
      return { ok: false, reasons, warnings };
    }
    previous.push(slot);
  }
  for (const ref of currentRefs) {
    const slot = parseDeadlineSlot(ref);
    if (!slot) {
      reasons.push(`current confirmed deadline references are malformed`);
      return { ok: false, reasons, warnings };
    }
    current.push(slot);
  }
  const oldGroups = resolveSlotGroups(previous, "previous");
  const newGroups = resolveSlotGroups(current, "current");
  reasons.push(...oldGroups.reasons, ...newGroups.reasons);
  warnings.push(...oldGroups.warnings, ...newGroups.warnings);
  if (reasons.length > 0) return { ok: false, reasons, warnings };
  const { pairs, unmatchedPrevious } = matchDeadlineSlots(
    oldGroups.slots,
    newGroups.slots,
    allowIdentityMigration,
  );
  for (const pair of pairs) {
    if (pair.previous.precision === "exact" && pair.current.precision === "date-only") {
      if (pair.current.earliest_ms >= pair.previous.latest_ms) continue;
      if (authorizesPrecisionCorrection(pair.previous, pair.current)) continue;
      reasons.push(`deadline precision regressed: ${pair.previous.deadline_id}`);
      continue;
    }
    if (
      pair.previous.precision === "date-only" &&
      pair.current.precision === "exact" &&
      pair.current.earliest_ms >= pair.previous.earliest_ms &&
      pair.current.latest_ms <= pair.previous.latest_ms
    )
      continue;
    if (
      pair.previous.precision === "date-only" &&
      pair.current.precision === "date-only" &&
      pair.current.latest_ms >= pair.previous.latest_ms
    )
      continue;
    if (
      pair.previous.precision === "exact" &&
      pair.current.precision === "exact" &&
      pair.current.latest_ms >= pair.previous.latest_ms
    )
      continue;
    if (authorizesEarlier(pair.previous, pair.current)) continue;
    reasons.push(`deadline pulled earlier without evidence: ${pair.previous.deadline_id}`);
  }
  for (const slot of unmatchedPrevious) {
    if (slot.latest_ms <= previousTime) continue;
    if (!Number.isFinite(currentTime) || slot.latest_ms > currentTime) {
      reasons.push(`future deadline disappeared: ${slot.deadline_id}`);
    }
  }
  return { ok: reasons.length === 0, reasons, warnings };
}

/** Compare a new report with the last known good report before deployment. */
/** 最後に成功した online 更新の診断状態。snapshot fallback の structural baseline では
 * 観測系 (warning・conflict) が記録されないため、こちらを比較源に使う。 */
export interface ObservationBaseline {
  observed_at: string;
  parse_warning_count?: number;
  warning_codes?: Record<string, { count: number; messages: string[] }>;
  identity_conflicts?: HealthReport["identity_conflicts"];
}

export function evaluateHealthGate(
  current: HealthReport,
  previous: HealthReport | null | undefined,
  observationBaseline?: ObservationBaseline | null,
): HealthGateResult {
  const currentReport = current as Partial<HealthReport>;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const currentProfile = String(currentReport.profile_hash ?? "");
  if (!currentProfile) reasons.push("profile hash is missing");
  if (
    currentReport.confirmed_future_deadlines !== undefined &&
    currentReport.confirmed_deadlines !== undefined &&
    currentReport.confirmed_future_deadlines !== currentReport.confirmed_deadlines
  ) {
    reasons.push("confirmed deadline health metadata is inconsistent");
  }
  if (
    currentReport.category_counts &&
    currentReport.category_distribution &&
    JSON.stringify(currentReport.category_counts) !==
      JSON.stringify(currentReport.category_distribution)
  ) {
    reasons.push("category health metadata is inconsistent");
  }
  if (Object.values(reportRequiredVenues(currentReport)).some((status) => status === "missing")) {
    reasons.push("required venue is missing");
  }
  const currentFailures = reportSourceFailures(currentReport);
  const unbackedFailures = currentFailures.filter(
    (source) => currentReport.source_status?.[source] !== "snapshot-fallback",
  );
  if (unbackedFailures.length > 0) {
    reasons.push(`source failure without snapshot fallback: ${unbackedFailures.join(",")}`);
  }
  for (const [source, metadata] of Object.entries(currentReport.source_metadata ?? {})) {
    if (source === "local") continue;
    if (metadata.observationStatus === "stale") {
      reasons.push(`source observation is stale: ${source}`);
    } else if (metadata.status === "snapshot-fallback" && metadata.observationStatus !== "fresh") {
      reasons.push(`snapshot observation freshness is unknown: ${source}`);
    }
  }
  const currentGeneratedAt = Date.parse(String(currentReport.generated_at ?? ""));
  if (!Number.isFinite(currentGeneratedAt)) reasons.push("generated_at is invalid");
  if (!previous) return { ok: reasons.length === 0, reasons, warnings };

  const previousReport = previous as Partial<HealthReport>;
  // Profile hashes intentionally vary with venue-paper/profile updates; they
  // are provenance metadata, not evidence that a deadline was lost.
  const previousGeneratedAt = Date.parse(String(previousReport.generated_at ?? ""));
  if (
    Number.isFinite(currentGeneratedAt) &&
    Number.isFinite(previousGeneratedAt) &&
    currentGeneratedAt < previousGeneratedAt
  ) {
    reasons.push("generated_at moved backwards");
  }
  const previousConfirmed = reportNumber(
    previousReport,
    "confirmed_future_deadlines",
    "confirmed_deadlines",
  );
  const currentConfirmed = reportNumber(
    currentReport,
    "confirmed_future_deadlines",
    "confirmed_deadlines",
  );
  const previousRefs = reportDeadlineRefs(previousReport);
  const currentRefs = reportDeadlineRefs(currentReport);
  if (hasDeadlineRefs(previousReport) && previousRefs === null) {
    reasons.push("previous confirmed deadline references are malformed");
  }
  if (hasDeadlineRefs(currentReport) && currentRefs === null) {
    reasons.push("current confirmed deadline references are malformed");
  }
  const hasSemanticRefs = previousRefs !== null && currentRefs !== null;
  if (!hasSemanticRefs && previousConfirmed > 0 && currentConfirmed <= previousConfirmed * 0.6) {
    reasons.push("confirmed future deadlines dropped by 40% or more");
  }
  if (hasSemanticRefs) {
    const semantic = semanticDeadlineRegressions(
      previousRefs!,
      currentRefs!,
      previousGeneratedAt,
      currentGeneratedAt,
      Number(currentReport.schema_version ?? 1) > Number(previousReport.schema_version ?? 1),
    );
    reasons.push(...semantic.reasons);
    warnings.push(...semantic.warnings);
  }
  const previousRequired = reportRequiredVenues(previousReport);
  const currentRequired = reportRequiredVenues(currentReport);
  for (const [venue, status] of Object.entries(previousRequired)) {
    if (status === "present" && currentRequired[venue] !== "present") {
      reasons.push(`required venue disappeared: ${venue}`);
    }
  }
  // 観測系の比較源: structural baseline が snapshot fallback の場合は、最後に成功した online
  // 更新から引き継いだ committed observation baseline を比較源にする。どちらも無い (初回
  // bootstrap) 場合だけ観測系検査をスキップする。slot 内容の比較は常に実行される。
  const previousIsOnline = previousReport.snapshot_fallback !== true;
  const observation: Partial<ObservationBaseline> | null = previousIsOnline
    ? null
    : (observationBaseline ?? null);
  const diagnosticsAvailable =
    previousIsOnline || (observation !== null && typeof observation.observed_at === "string");

  const previousWarnings = reportWarningCount(previousReport);
  const observationWarnings = Number(observation?.parse_warning_count ?? NaN);
  const warningReferenceCount = previousIsOnline
    ? previousWarnings
    : Number.isFinite(observationWarnings)
      ? observationWarnings
      : null;
  if (
    diagnosticsAvailable &&
    warningReferenceCount !== null &&
    reportWarningCount(currentReport) > warningReferenceCount * 2 + 5
  ) {
    reasons.push("parse warnings increased sharply");
  }
  const currentConflicts = currentReport.identity_conflicts;
  const previousConflictDetails = previousIsOnline
    ? previousReport.identity_conflicts?.details
    : observation?.identity_conflicts?.details;
  if (diagnosticsAvailable && currentConflicts && previousConflictDetails) {
    const conflictKey = (conflict: (typeof currentConflicts.details)[number]) =>
      JSON.stringify([
        conflict.scope,
        conflict.reason,
        conflict.subject,
        [...(conflict.candidates ?? [])].sort(cmpStr),
      ]);
    const previousKeys = new Set(previousConflictDetails.map(conflictKey));
    const newConflicts = currentConflicts.details.filter(
      (conflict) => !previousKeys.has(conflictKey(conflict)),
    ).length;
    currentConflicts.new_since_baseline = newConflicts;
    if (newConflicts > 0) reasons.push(`identity conflicts increased by ${newConflicts}`);
  }
  const previousWarningCodes: Record<string, { count: number; messages: string[] }> | undefined =
    previousIsOnline ? previousReport.warning_codes : observation?.warning_codes;
  if (diagnosticsAvailable && previousWarningCodes) {
    for (const [code, warning] of Object.entries(currentReport.warning_codes ?? {})) {
      const prior = previousWarningCodes[code];
      if (!prior) reasons.push(`new warning code: ${code}`);
      else if (warning.count > prior.count) reasons.push(`warning code increased: ${code}`);
    }
  }
  return { ok: reasons.length === 0, reasons, warnings };
}

export function healthMarkdown(report: HealthReport): string {
  const lines = [
    "# Build health",
    "",
    `Generated at: ${report.generated_at}`,
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Tracked venues | ${report.tracked_venues} |`,
    `| Future confirmed venues | ${report.future_confirmed_venues} |`,
    `| Future estimated venues | ${report.future_estimated_venues} |`,
    `| Confirmed deadlines | ${report.confirmed_deadlines} |`,
    `| Estimated deadlines | ${report.estimated_deadlines} |`,
    `| Future exact deadlines | ${report.future_exact_deadlines ?? 0} |`,
    `| Future date-only deadlines | ${report.future_date_only_deadlines ?? 0} |`,
    `| Future estimated deadlines | ${report.future_estimated_deadlines ?? 0} |`,
    `| Venues with future exact deadline | ${report.venues_with_exact_future_deadline ?? 0} |`,
    `| Venues with future date-only deadline | ${report.venues_with_date_only_future_deadline ?? 0} |`,
    `| Parse warning count | ${report.parse_warning_count} |`,
    `| Snapshot fallback | ${report.snapshot_fallback ? "yes" : "no"} |`,
    `| Profile hash | ${report.profile_hash} |`,
    "",
    "## Source status",
    "",
    "| Source | Status |",
    "|---|---|",
    ...Object.entries(report.source_status).map(([source, status]) => `| ${source} | ${status} |`),
    "",
    `Source failures: ${report.source_failures.length > 0 ? report.source_failures.join(", ") : "none"}`,
    "",
    "## Categories",
    "",
    "| Category | Venues |",
    "|---|---:|",
    ...Object.entries(report.category_distribution).map(
      ([category, count]) => `| ${category} | ${count} |`,
    ),
    "",
    "## Parse warnings",
    "",
    ...(Object.entries(report.parse_warnings).length
      ? Object.entries(report.parse_warnings).map(([message, count]) => `- ${count}× ${message}`)
      : ["- none"]),
    "",
    "## Required venues",
    "",
    ...(Object.entries(report.required_venues).length
      ? Object.entries(report.required_venues).map(([venue, status]) => `- ${venue}: ${status}`)
      : ["- none"]),
    "",
    "## Output files",
    "",
    "| File | Bytes | SHA-256 |",
    "|---|---:|---|",
    ...Object.entries(report.output_files).map(
      ([name, file]) => `| ${name} | ${file.bytes} | ${file.sha256} |`,
    ),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function outputFileManifest(outdir: string, names: string[]): Record<string, HealthOutputFile> {
  return Object.fromEntries(
    [...new Set(names)].sort(cmpStr).map((name) => {
      const bytes = readFileSync(join(outdir, name));
      return [
        name,
        { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") },
      ];
    }),
  );
}

/** Hash the final publish set after every optional artifact has been restored or generated. */
export function writePublishManifest(
  outdir: string,
  names: string[],
  now: Date | null | undefined,
  semanticStatus: SemanticStatus,
  provenance?: PublishProvenance,
): PublishManifest {
  const artifacts = Object.fromEntries(
    [...new Set(names)]
      .filter((name) => name !== "publish.json")
      .sort(cmpStr)
      .map((name) => {
        const bytes = readFileSync(join(outdir, name));
        return [
          name,
          { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") },
        ];
      }),
  );
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const profileHash = existsSync(join(outdir, "data.json"))
    ? embeddingProfileHash(JSON.parse(readFileSync(join(outdir, "data.json"), "utf8")))
    : "";
  const resolvedProvenance =
    provenance ?? priorPublishProvenance(outdir) ?? collectPublishProvenance();
  const contentId = publishContentId(resolvedProvenance, profileHash);
  const manifest: PublishManifest = {
    schema_version: 4,
    generated_at: safeNow.toISOString(),
    semantic_status: semanticStatus,
    artifacts,
    content_id: contentId,
    build_id: publishBuildId(safeNow, contentId),
    profile_hash: profileHash,
    source_commit: resolvedProvenance.sourceCommit,
    data_commit: resolvedProvenance.dataCommit,
    workflow_run_id: resolvedProvenance.workflowRunId,
    dirty_worktree: resolvedProvenance.dirtyWorktree,
    inputs: resolvedProvenance.inputs,
    promotion_batches: resolvedProvenance.promotionBatches,
    build: { ...resolvedProvenance.build, now: safeNow.toISOString() },
  };
  writeFileSync(join(outdir, "publish.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export function csvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(records: DataRecord[] | null | undefined): string {
  const lines: string[] = [];
  lines.push(CSV_COLUMNS.join(","));
  for (const rec of records ?? []) {
    if (!rec || typeof rec !== "object" || rec.type !== "deadline") continue;
    const { conf, edition: ed, deadline: dl } = rec;
    if (!conf || !ed || dl === null || dl === undefined) continue;
    lines.push(
      [
        conf.key,
        conf.title,
        conf.full_name,
        conf.categories.join(";"),
        conf.rank.ccf ?? "",
        conf.rank.core ?? "",
        ed.year,
        ed.edition_id,
        dl.kind,
        dl.label ?? "",
        dl.round,
        isDateOnlyDeadline(dl) ? "date-only" : "exact",
        isDateOnlyDeadline(dl) ? dl.local_date : "",
        isExactDeadline(dl) ? fmtUTC(dl.at_utc, "%Y-%m-%dT%H:%M:%SZ") : "",
        isExactDeadline(dl) ? aoeText(dl.at_utc) : "",
        isExactDeadline(dl) ? dl.tz_raw : "",
        ed.event_start ? fmtDate(ed.event_start) : "",
        ed.event_end ? fmtDate(ed.event_end) : "",
        ed.place ?? "",
        ed.date_text ?? "",
        ed.estimated ? "true" : "false",
        ed.estimate?.window_start ?? "",
        ed.estimate?.window_end ?? "",
        conf.sources.join(";"),
        ed.link || conf.link || "",
      ]
        .map((v) => csvField(v))
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function escapeMdCell(s: string | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

/** Sanitize a URL embedded in a Markdown link [text](url) inside table cells. */
export function escapeMdUrl(url: string | null | undefined): string {
  if (!url) return "";
  let u = String(url)
    .trim()
    .replace(/[\r\n]+/g, "");
  u = u.replace(/\|/g, "%7C");
  u = u.replace(/\s+/g, "%20");
  u = u.replace(/\(/g, "%28").replace(/\)/g, "%29");
  return u;
}

export function toUpcomingMd(
  records: DataRecord[] | null | undefined,
  now: Date | null | undefined,
  days = 180,
): string {
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const rawDays = Number(days);
  const safeDays =
    Number.isFinite(rawDays) && Number.isInteger(rawDays) && rawDays > 0 ? rawDays : 180;
  const horizon = addDays(safeNow, safeDays);
  const today = dateOnly(safeNow);
  const rows: string[] = [];
  for (const rec of records ?? []) {
    if (!rec || typeof rec !== "object") continue;
    const { conf, edition: ed } = rec;
    if (!conf || !ed) continue;
    const rawLink = ed.link || conf.link;
    const link = rawLink ? escapeMdUrl(rawLink) : "";
    const titleEscaped = escapeMdCell(titleWithYear(conf.title, ed.year));
    const name = link ? `[${titleEscaped}](${link})` : titleEscaped;
    const placeEscaped = escapeMdCell(ed.place);
    if (rec.type === "deadline") {
      const dl = rec.deadline;
      if (dl === null) continue;
      let left: string;
      let when: string;
      if (isDateOnlyDeadline(dl)) {
        const window = dateOnlyWindow(dl.local_date);
        const state = dateOnlyState(dl.local_date, safeNow);
        if (
          window === null ||
          state === null ||
          state === "definitely-past" ||
          window.earliestPossibleUtc.getTime() > horizon.getTime()
        )
          continue;
        left =
          state === "uncertain-on-date"
            ? "締切日"
            : `${Math.max(1, Math.ceil((window.earliestPossibleUtc.getTime() - safeNow.getTime()) / DAY_MS))}日`;
        when = `${dl.local_date}（時刻未確認）`;
      } else {
        if (
          exactDeadlineState(dl.at_utc, safeNow) === "past" ||
          dl.at_utc.getTime() > horizon.getTime()
        )
          continue;
        const remainMs = dl.at_utc.getTime() - safeNow.getTime();
        const remainDays = Math.floor(remainMs / DAY_MS);
        if (remainDays >= 1) {
          left = `${remainDays}日`;
        } else {
          const hours = Math.floor(remainMs / 3_600_000);
          if (hours >= 1) {
            left = `${hours}時間`;
          } else {
            const mins = Math.max(1, Math.floor(remainMs / 60_000));
            left = `${mins}分`;
          }
        }
        when =
          ed.estimated && ed.estimate
            ? `推定期間 ${ed.estimate.window_start}〜${ed.estimate.window_end}`
            : aoeText(dl.at_utc);
      }
      const kindText = escapeMdCell(rec.kind_label);
      const roundText = `R${dl.round}`;
      rows.push(
        `| ${when} | ${left} | ${name} | ${kindText} | ${roundText} | ${ed.estimated ? "推定" : ""} | ${placeEscaped} |`,
      );
    } else {
      const start = ed.event_start;
      if (start === null) continue;
      const end = ed.event_end ?? start;
      if (
        dateOnly(start).getTime() > dateOnly(horizon).getTime() ||
        today.getTime() > dateOnly(end).getTime()
      ) {
        continue;
      }
      let left: string;
      const startDay = dateOnly(start).getTime();
      const endDay = dateOnly(end).getTime();
      if (today.getTime() < startDay) {
        left = `${(startDay - today.getTime()) / DAY_MS}日`;
      } else if (today.getTime() === startDay) {
        left = "本日開催";
      } else {
        left = `開催中(残り${(endDay - today.getTime()) / DAY_MS + 1}日)`;
      }
      const when =
        end.getTime() !== start.getTime() ? `${fmtDate(start)} 〜 ${fmtDate(end)}` : fmtDate(start);
      rows.push(
        `| ${when} | ${left} | ${name} | 開催 | - | ${ed.estimated ? "推定" : ""} | ${placeEscaped} |`,
      );
    }
  }
  const head = [
    `# 直近 ${safeDays} 日の締切と開催`,
    "",
    `生成時刻: ${fmtUTC(safeNow, "%Y-%m-%dT%H:%M:%SZ")}`,
    "",
    "| 日付 | 残り | 会議 | 種別 | R | 推定 | 開催地 |",
    "|---|---|---|---|---|---|---|",
  ];
  if (rows.length === 0) rows.push("| - | - | 該当なし | - | - | - | - |");
  return `${[...head, ...rows].join("\n")}\n`;
}

export function toLlmsTxt(config: Record<string, unknown> | null | undefined): string {
  const safeConfig = config ?? {};
  const categories = (safeConfig.categories as Record<string, string> | null) ?? DEFAULT_CATEGORIES;
  const sources = (safeConfig.sources as Array<Record<string, unknown>> | null) ?? DEFAULT_SOURCES;
  // config.yaml の site.title をタイトル行に反映する。
  const siteTitle = String(
    (safeConfig.site as Record<string, unknown> | null)?.title ?? "kamiyobi",
  );
  const lines = [
    `# ${siteTitle}`,
    "",
    "HPC・ネットワーク・システム・AI 系の国際会議の投稿締切と開催日を、",
    "上流の公開データから日次で正規化して配信する静的データ集である。",
    "サーバは無く、GitHub Pages 上の静的ファイルだけで構成される。",
    "",
    "## 出力一覧",
    "",
    "- data.json：正規化データ全体（機械可読の正）。",
    "- health.json：配信前ゲートにも使う確定/推定締切とソース状態の健全性レポート。",
    "- publish.json：最終公開セットのハッシュ、元 commit、入力 hash、build 条件と、意味検索用の埋め込みが公開物に含まれるかを示す semantic_status（ready / lexical-only）。",
    "- catalog.json：締切画面向けの現在・近日期間カタログ。",
    "- recommendation-index.json：投稿先推薦の会議プロフィールと埋め込み参照。",
    "- app.js：site/app.ts から生成するブラウザ UI 実行時処理。",
    "- recommender.js：site/recommender.ts から生成する推薦実行時処理。",
    "- health.md：health.json の人間向け要約。",
    "- data.csv：1 行 1 締切のフラット表。",
    `- upcoming.md：直近 ${String((safeConfig.site as Record<string, unknown> | null)?.upcoming_days ?? 180)} 日の締切と開催の表。`,
  ];
  lines.push(
    "",
    "## data.json のスキーマ要約",
    "",
    "トップレベルは以下のキーを持つオブジェクトである。",
    "",
    "- generated_at: string：生成時刻。'YYYY-MM-DDTHH:MM:SSZ'（UTC）。",
    "- site: object：{domain: string, base_url: string}。配信サイトの所在。",
    "  公開サイトの絶対 URL を組み立てるには base_url を基準にする。",
    "- sources: array of {name, repo, license, url}：出典と授権。",
    "- categories: object：カテゴリ ID から英語名への写像。",
    `  実在値: ${[...Object.keys(categories)].sort().join(", ")}。`,
    "- legacy_key_redirects: object：旧会議 key から現在の正規 key への写像。",
    "- conferences: array：会議の配列。各要素は次の形である。",
    "  - key: string：正規化キー（slug）。例 'sigcomm'。",
    "  - title: string：略称。例 'SIGCOMM'。",
    "  - full_name: string：正式名称。",
    "  - categories: array of string：上記 categories のキー。",
    "  - rank: object：{'ccf': 'A', 'core': 'A*'} 等。欠けうる。",
    "    値 'N' は上流でランクが付いていないことを表す番兵であり、等級ではない。",
    "  - link: string：会議の公式サイト。",
    "  - tags: array of string：補助タグ。カテゴリではない。",
    "  - sources: array of string：この会議の出典名。",
    "  - dblp: string|null：DBLP の会議キー。無い場合は null。",
    "  - identity: object：明示的な venue ID、DBLP key、公式 domain、alias、source ID。存在時のみ。",
    "  - legacy_keys: array of string：正規 key へ移行した旧 key。存在時のみ。",
    "  - category_assignments: array：カテゴリと付与理由。存在時のみ。",
    "  - papers: array of string：代表採択論文タイトル。語彙一致・推薦に使う。",
    "    無い会議は空配列。",
    "  - editions: array：開催回。各要素は次の形である。",
    "    - year: integer, id: string（例 'sigcomm26'）, link: string, place: string",
    "    - date_text: string：上流の自由文の会期表記。構造化されていないことがある。",
    "    - event_start / event_end: string|null：'YYYY-MM-DD'。パース不能なら null。",
    "    - estimated: boolean：true は過去実績からの推定。実データではない。",
    "    - estimate: object|null：推定版の点推定・日付窓・根拠版・信頼度。確定版には無い。",
    "      window_start / window_end は表示用の日付範囲であり、公式締切ではない。",
    "    - source: string：この開催回を提供した出典名。",
    "    - identity: object：明示的な edition ID と公式 URL。存在時のみ。",
    "    - deadlines: array：各要素は次の形である。",
    "      - kind: string：'abstract'|'paper'|'supplementary'|'notification'" +
      "|'camera_ready'|'rebuttal_start'|'rebuttal_end'|'review_release'" +
      "|'registration'|'other' の 10 種のみ。",
    "      - label: string：上流の表示用ラベル。",
    "      - precision: 'exact'|'date-only'：締切値の精度。",
    "      - exact は utc: 'YYYY-MM-DDTHH:MM:SSZ'、aoe、tz_raw を持つ。",
    "      - date-only は local_date: 'YYYY-MM-DD' と earliest_utc/latest_utc を持ち、utc/aoe/tz_raw は null。",
    "      - round: integer：1 起点。複数投稿ラウンドを持つ会議がある。",
    "      - comment: string|null：上流の注記。",
    "      - status: 'confirmed'|'estimated'：開催回の確定/推定状態。",
    "      - selection_rule: string：採用値を選んだ決定規則。",
    "      - evidence: array：source_name/source_url/observed_at/original_value/confidence。",
    "      - conflicts: array：採用しなかった候補値とその evidence（存在時のみ）。",
    "",
    "## 利用上の注意",
    "",
    "- exact の比較は deadlines[].utc、date-only の比較は earliest_utc/latest_utc の不確実性区間で行う。aoe は表示用である。",
    "- date-only の UTC 境界は状態判定用であり、公式時刻や時刻単位の残り時間として扱わない。",
    "- estimated=true の版は推定窓であり、公式サイトで締切を確認してから利用する。",
    "- data.csv は 1 行 1 締切のフラット表で、deadline_precision と deadline_local_date を持つ。",
    "  comment・tags・thcpl ランクは列に無い。全情報が要るときは data.json を使う。",
    "- 権威は上流と各会議の公式サイトである。重要な判断の前に link 先を確認すること。",
    "",
    "## 出典とライセンス",
    "",
  );
  for (const src of sources) {
    lines.push(`- ${src.name}: ${src.repo} （${src.license}）`);
  }
  lines.push(
    "",
    "本リポジトリの生成物は MIT ライセンスで配布する。",
    "上流データの権利は各上流リポジトリに帰属し、NOTICE.md に帰属表示がある。",
    "",
  );
  return lines.join("\n");
}

/** JSON を空白付きのコンパクト形式で直列化する。 */
function jsonCompact(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(jsonCompact).join(", ")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${jsonCompact(v)}`).join(", ")}}`;
}

/** Make a JSON literal safe to paste into a <script> body. */
function embedJson(jsJson: string): string {
  return jsJson
    .replace(/<\//g, "<\\/")
    .replace(/<!--/g, "\\u003c!--")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// --- entry point -------------------------------------------------------------

export interface BuildStats {
  generated_at: string;
  conferences: number;
  editions: number;
  deadlines: number;
  events: number;
  estimated: number;
  files: string[];
  merged?: number;
}

/** Generate everything under `outdir` and return a stats dict. */
export async function buildAll(
  confs: Conference[] | null | undefined,
  config: Record<string, unknown> | null | undefined,
  outdir: string,
  now: Date | null | undefined,
  opts: {
    noEmbeddings?: boolean;
    health?: HealthReportOptions;
    publishProvenance?: PublishProvenance;
  } = {},
): Promise<BuildStats> {
  mkdirSync(outdir, { recursive: true });

  const safeConfs = Array.isArray(confs) ? confs : [];
  const safeConfig = config ?? {};

  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const nowUtc = new Date(safeNow.getTime());
  // DTSTAMP is derived from --now (floored to the day).
  const site = (safeConfig.site as Record<string, unknown>) ?? {};
  // config.yaml の site.upcoming_days（既定 180）: upcoming.md の窓を決める。
  // 設定値を読まないと 180 に固定されるため、site.upcoming_days を反映する。
  const rawUpcomingDays = Number(site.upcoming_days ?? 180);
  const upcomingDays =
    Number.isFinite(rawUpcomingDays) && Number.isInteger(rawUpcomingDays) && rawUpcomingDays > 0
      ? rawUpcomingDays
      : 180;

  const records = recordsOf(safeConfs);
  records.sort((a, b) => {
    const [sa, sb] = [sortKey(a), sortKey(b)];
    return sa[0] - sb[0] || cmpStr(sa[1], sb[1]);
  });
  const written: string[] = [];

  const write = (name: string, text: string): void => {
    writeFileSync(join(outdir, name), text, "utf8");
    written.push(name);
  };

  const data = toJson(safeConfs, safeConfig, nowUtc);
  const jsonText = JSON.stringify(data, null, 2);
  write("data.json", `${jsonText}\n`);
  write("catalog.json", `${JSON.stringify(toCatalog(data, nowUtc, upcomingDays), null, 2)}\n`);
  const publishProvenance =
    opts.publishProvenance ?? collectPublishProvenance(ROOT, undefined, { now: nowUtc });
  const contentId = publishContentId(publishProvenance, embeddingProfileHash(data));
  const buildId = publishBuildId(nowUtc, contentId);
  write(
    "recommendation-index.json",
    `${JSON.stringify(
      {
        ...toRecommendationIndex(
          data,
          nowUtc,
          opts.health?.recommendationSourceStatus ?? opts.health?.sourceStatus,
        ),
        content_id: contentId,
        build_id: buildId,
      },
      null,
      2,
    )}\n`,
  );
  write("data.csv", toCsv(records));
  write("upcoming.md", toUpcomingMd(records, nowUtc, upcomingDays));

  // セマンティックレコメンド用の埋め込み（transformers.js が無ければスキップして語彙のみで動作）
  if (!opts.noEmbeddings) {
    try {
      const embPath = join(outdir, "embeddings.json");
      let needEmb = true;
      try {
        const existing = JSON.parse(readFileSync(embPath, "utf8")) as {
          embeddings?: Record<string, unknown>;
        };
        needEmb = embeddingsStale(existing, data);
      } catch {
        needEmb = true;
      }
      if (needEmb) {
        const { buildEmbeddings } = await import("./embeddings.ts");
        await buildEmbeddings(join(outdir, "data.json"), embPath);
      }
      written.push("embeddings.json");
    } catch (exc) {
      console.warn(
        `warning: embeddings を生成しなかった（${(exc as Error).constructor.name}: ${String(exc)}）`,
      );
    }
  }

  write("llms.txt", toLlmsTxt(safeConfig));
  write(".nojekyll", "");

  const template = String(safeConfig.template ?? "site/template.html");
  const templatePath = isAbsolute(template) ? template : join(ROOT, template);
  let templateText: string | null = null;
  try {
    templateText = readFileSync(templatePath, "utf8");
  } catch {
    templateText = null;
  }
  if (templateText !== null) {
    if (!templateText.includes(TEMPLATE_MARKER)) {
      console.warn(
        `warning: ${templatePath} に ${TEMPLATE_MARKER} が見つからない。index.html を素通しする`,
      );
    } else {
      templateText = templateText.replace(
        TEMPLATE_MARKER,
        embedJson(jsonCompact(toCatalog(data, nowUtc, upcomingDays))),
      );
    }
    write("index.html", templateText);
    for (const [name, source] of Object.entries(compileSiteRuntime())) write(name, source);
  } else {
    console.warn(`warning: ${templatePath} が無いので index.html を生成しない`);
  }

  const report = healthReport(data, nowUtc, {
    ...opts.health,
    parseWarnings: opts.health?.parseWarnings ?? warningCounts(),
    warningCodes:
      opts.health?.warningCodes ??
      Object.fromEntries(
        warningSummaries().map(({ code, count, messages }) => [code, { count, messages }]),
      ),
    outputFiles: outputFileManifest(outdir, written),
  });
  write("health.json", `${JSON.stringify(report, null, 2)}\n`);
  write("health.md", healthMarkdown(report));
  writePublishManifest(
    outdir,
    written,
    nowUtc,
    written.includes("embeddings.json") ? "ready" : "lexical-only",
    publishProvenance,
  );
  if (!written.includes("publish.json")) written.push("publish.json");

  const nDeadlines = records.filter((r) => r.type === "deadline").length;
  return {
    generated_at: String(data.generated_at),
    conferences: safeConfs.length,
    editions: safeConfs.reduce((n, c) => n + (c?.editions?.length ?? 0), 0),
    deadlines: nDeadlines,
    events: records.length - nDeadlines,
    estimated: records.filter((r) => r.estimated).length,
    files: written,
  };
}
