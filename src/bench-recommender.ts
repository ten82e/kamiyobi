/**
 * 推薦品質ベンチマーク（dev tool）
 *
 * 各会議のトピック（カテゴリ正式名の内容語 + タグ + full_name の内容語）から
 * 合成論文クエリを作り、その会議が全会議の中で top-K に入るかを計測する。
 * スコアリングは本番と同じコードパス（site/recommender.ts の breakdown +
 * semanticScore + blendScore）を使うため、スコア改変の回帰検出に使える。
 *
 * 使い方:
 *   npm run bench                          # 英語: public/data.json + public/embeddings.json
 *   npm run bench -- --samples 100         # ランダム 100 件に絞る（高速確認）
 *   npm run bench -- --failures 10         # 正解が top-K 外だった事例を表示
 *   npm run bench -- --lang jp             # 日本語（日本語名の会議のみ、多言語モデル）
 *   npm run bench -- --lang jp --jpw 0.35  # 日本語の語彙重みを 0.35 に（既定 0.5）
 *   npm run bench -- --sw name=25,venue=0  # サブシグナル点数を上書き（実測スイープ用）
 *   npm run bench -- --sw nameOnce         # 会議名一致を先頭 1 語の固定加点のみに
 *   npm run bench -- --golden-en           # regression-known の実採択論文で回帰を測定
 *   npm run bench -- --no-idf              # IDF 減衰を無効化（既定は本番と同じく有効）
 *   --v2                                   # 合成 smoke/plumbing 評価
 *   --real-v2-dev ... --real-v2-heldout ... # 実論文の固定 revision 評価
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs as parseNodeArgs } from "node:util";
import { type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";
import { booleanValue, normalizeShortEquals, stringValue } from "./args.ts";
import {
  type BenchmarkEmbeddingBundle,
  type BenchmarkEmbeddingManifest,
  benchmarkEmbeddingManifestAtCutoff,
  buildBenchmarkEmbeddingBundle,
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  EMBEDDING_MULTI_REVISION,
  EMBEDDING_REVISION,
  VENUE_PAPERS,
  VENUE_PROFILE_ARTIFACT,
  type VenueProfileArtifact,
} from "./embeddings.ts";
import {
  loadRecommender,
  type PaperLine,
  type RecommenderApi,
  type VenueRecommendation,
} from "./recommender-api.ts";

const Recommender: RecommenderApi = await loadRecommender();

const STOP = Recommender.STOPWORDS;
const GEN_PAPER = Recommender.GENERIC_PAPER_WORDS ?? new Set<string>();

export interface BenchArgs {
  data: string;
  emb: string;
  samples: number;
  failures: number;
  topK: number;
  lang: "en" | "jp";
  jpw: number;
  byLen: boolean;
  adaptive: boolean;
  wGiven: boolean;
  penalty: boolean;
  prf: boolean;
  idf: boolean;
  sw: string | null;
  goldenEn: boolean;
  paperMax: boolean;
  v2: string | null;
  realV2Dev: string | null;
  realV2Heldout: string | null;
  realV2Negative: string | null;
  realV2Features: string | null;
  writeRequiredFeatures: string | null;
  realV2Small: boolean;
  dataDelta: string | null;
  dataDeltaBefore: string | null;
  dataDeltaAfter: string | null;
  json: boolean;
}

// 不正な数値（負・非整数・非数値）を既定値へフォールバック。
// --topk=-3 等（イコール構文）は下流の `rank > args.topK` が全会議を失敗扱いにするのを防ぐ。
function toPosInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : fallback;
}

function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) {
    return val
      .filter((x) => x !== null && x !== undefined)
      .map((x) => String(x).trim())
      .filter(Boolean);
  }
  if (typeof val === "string" && val.trim() !== "") {
    return [val.trim()];
  }
  return [];
}

export function parseBenchArgs(argv: string[] | null | undefined): BenchArgs {
  const args: BenchArgs = {
    data: "public/data.json",
    emb: "public/embeddings.json",
    samples: 0,
    failures: 0,
    topK: 5,
    lang: "en",
    jpw: 0.5,
    byLen: false,
    adaptive: false,
    wGiven: false,
    penalty: false,
    prf: false,
    // IDF は本番（ブラウザの buildNameIdf）と同じく既定オン。--no-idf でオフ
    idf: true,
    sw: null,
    goldenEn: false,
    // usenix-security の論文個別ベクトルを semanticScore の max 類似度に使う。
    // 英語のみ。実測で golden EN top1 15.8→26.3 / top5 63.2→71.9。既定オン。
    paperMax: true,
    v2: null,
    realV2Dev: null,
    realV2Heldout: null,
    realV2Negative: null,
    realV2Features: null,
    writeRequiredFeatures: null,
    realV2Small: false,
    dataDelta: null,
    dataDeltaBefore: null,
    dataDeltaAfter: null,
    json: false,
  };
  const normalized = normalizeShortEquals(argv, {
    d: "data",
    e: "emb",
    s: "samples",
    f: "failures",
    k: "topk",
    l: "lang",
  });
  const { values, tokens } = parseNodeArgs({
    args: normalized,
    options: {
      data: { type: "string", short: "d" },
      emb: { type: "string", short: "e" },
      samples: { type: "string", short: "s" },
      failures: { type: "string", short: "f" },
      topk: { type: "string", short: "k" },
      lang: { type: "string", short: "l" },
      jpw: { type: "string" },
      w: { type: "string" },
      "by-len": { type: "boolean" },
      adaptive: { type: "boolean" },
      penalty: { type: "boolean" },
      prf: { type: "boolean" },
      idf: { type: "boolean" },
      "no-idf": { type: "boolean" },
      "golden-en": { type: "boolean" },
      "paper-max": { type: "boolean" },
      "no-paper-max": { type: "boolean" },
      v2: { type: "string" },
      "bench-v2": { type: "string" },
      "real-v2-dev": { type: "string" },
      "real-v2-heldout": { type: "string" },
      "real-v2-negative": { type: "string" },
      "real-v2-features": { type: "string" },
      "write-required-features": { type: "string" },
      "real-v2-small": { type: "boolean" },
      "data-delta": { type: "string" },
      "data-delta-before": { type: "string" },
      "data-delta-after": { type: "string" },
      sw: { type: "string" },
      json: { type: "boolean" },
    },
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  args.data = stringValue(values.data) ?? args.data;
  args.emb = stringValue(values.emb) ?? args.emb;
  args.samples = toPosInt(stringValue(values.samples), 0);
  args.failures = toPosInt(stringValue(values.failures), 0);
  args.topK = toPosInt(stringValue(values.topk), 5);
  if (values.lang === "jp") args.lang = "jp";
  const jpw = [...tokens]
    .reverse()
    .find((token) => token.kind === "option" && (token.name === "jpw" || token.name === "w"));
  if (jpw?.kind === "option") {
    const weight = Number(jpw.value);
    args.jpw = Number.isNaN(weight) ? 0.5 : weight;
    args.wGiven = true;
  }
  if (values["by-len"] !== undefined) args.byLen = booleanValue(values["by-len"]);
  if (values.adaptive !== undefined) args.adaptive = booleanValue(values.adaptive);
  if (values.penalty !== undefined) args.penalty = booleanValue(values.penalty);
  if (values.prf !== undefined) args.prf = booleanValue(values.prf);
  if (values.idf !== undefined) args.idf = booleanValue(values.idf);
  if (values["no-idf"] !== undefined) args.idf = false;
  if (values["golden-en"] !== undefined) args.goldenEn = booleanValue(values["golden-en"]);
  if (values["paper-max"] !== undefined) args.paperMax = booleanValue(values["paper-max"]);
  if (values["no-paper-max"] !== undefined) args.paperMax = false;
  args.v2 = stringValue(values.v2) ?? stringValue(values["bench-v2"]) ?? null;
  args.realV2Dev = stringValue(values["real-v2-dev"]) ?? null;
  args.realV2Heldout = stringValue(values["real-v2-heldout"]) ?? null;
  args.realV2Negative = stringValue(values["real-v2-negative"]) ?? null;
  args.realV2Features = stringValue(values["real-v2-features"]) ?? null;
  args.writeRequiredFeatures = stringValue(values["write-required-features"]) ?? null;
  args.realV2Small = booleanValue(values["real-v2-small"], false);
  args.dataDelta = stringValue(values["data-delta"]) ?? null;
  args.dataDeltaBefore = stringValue(values["data-delta-before"]) ?? null;
  args.dataDeltaAfter = stringValue(values["data-delta-after"]) ?? null;
  args.sw = stringValue(values.sw) ?? null;
  args.json = booleanValue(values.json);
  for (const kv of (args.sw || "").split(",")) {
    const [k, v] = kv.split("=");
    if (!k) continue;
    if (k === "nameOnce") {
      Recommender.setSigWeights({ nameOnce: true });
    } else if (v !== undefined) {
      const n = Number(v);
      if (!Number.isNaN(n)) {
        const key = k as "domain" | "name" | "jp" | "tags" | "venue";
        Recommender.setSigWeights({ [key]: n });
      }
    }
  }
  return args;
}

export interface Conf {
  key: string;
  title: string;
  full_name: string;
  categories: string[];
  tags: string[];
}

/** ベンチのクエリ単位（合成・golden で形状が異なる） */
export interface BenchQuery {
  key: string;
  tw: string[];
  conf?: Conf;
  qid?: string;
  golden?: boolean;
}

const BENCH_V2_SPLITS = ["synthetic", "dev", "heldout"] as const;
type BenchV2Split = (typeof BENCH_V2_SPLITS)[number];

export interface BenchV2Profile {
  key: string;
  title: string;
  profile: string;
}

export interface BenchV2Query {
  id: string;
  split: BenchV2Split;
  time: string;
  title: string;
  keywords: string;
  key: string;
  semantic: Record<string, number>;
}

export interface BenchV2Fixture {
  version: number;
  venue_profiles: BenchV2Profile[];
  queries: BenchV2Query[];
}

export interface BenchV2Metrics {
  mrr: number;
  top1Accuracy: number;
  coverage: number;
  "recall@1": number;
  "recall@5": number;
  "recall@10": number;
  "ndcg@5": number;
  "ndcg@10": number;
}

export interface BenchV2ModeResult extends BenchV2Metrics {
  queries: number;
}

export interface BenchV2Result {
  version: 2;
  splits: Record<
    BenchV2Split,
    {
      queries: number;
      modes: Record<"lexical" | "semantic" | "fused", BenchV2ModeResult>;
      candidate_retrieval: {
        lexical_recall_at_50: number;
        semantic_recall_at_50: number;
        union_recall_at_50: number;
        oracle_reranker_recall_at_5: number;
      };
      fused_mrr_lcb: number;
      calibration: RecommendationCalibration;
    }
  >;
}

export interface RecommendationCalibration {
  expected_calibration_error: number;
  brier_score: number;
  top1_expected_calibration_error: number;
  top1_brier_score: number;
  top5_expected_calibration_error: number;
  top5_brier_score: number;
  precision_coverage: Array<{ threshold: number; precision: number | null; coverage: number }>;
  reliability_top1: Array<{
    lower: number;
    upper: number;
    confidence: number;
    accuracy: number;
    count: number;
  }>;
  reliability_top5: Array<{
    lower: number;
    upper: number;
    confidence: number;
    accuracy: number;
    count: number;
  }>;
}

export interface DataDeltaCase {
  id: string;
  synthetic: true;
  title: string;
  abstract?: string;
  category: string;
  language: "en" | "ja";
  venue_kind: "international" | "domestic" | "workshop" | "journal" | "special-issue";
  input: "title-only" | "abstract" | "out-of-scope" | "insufficient";
  expected_venue: string | null;
}

export interface DataDeltaFixture {
  schema: 1;
  synthetic: true;
  before_candidates: Array<Record<string, unknown>>;
  after_candidates: Array<Record<string, unknown>>;
  cases: DataDeltaCase[];
}

export interface DataDeltaResult {
  case_count: number;
  recall_at_1: number;
  recall_at_5: number;
  mrr: number;
  ndcg_at_10: number;
  abstention_rate: number;
  changed_top5: string[];
  new_venues_in_top5: string[];
  expected_venues_dropped: string[];
}

function roundDelta(value: number): number {
  return Number(value.toFixed(6));
}

const DATA_DELTA_NOW = Date.parse("2026-08-09T00:00:00Z");

/** The data-delta pool is the Browser recommendation pool without UI-only past representatives. */
export function dataDeltaTop5(
  candidates: Array<Record<string, unknown>>,
  lines: Array<{ title: string; abstract: string; keywords: string; venue: string }>,
): string[] {
  const rows = Recommender.candidateRows({ conferences: candidates }).concat(
    Recommender.journalRows(candidates, DATA_DELTA_NOW),
  );
  return Recommender.venueRecommendations(rows, lines, null, DATA_DELTA_NOW, { topN: 5 })
    .slice(0, 5)
    .map((result) => result.venueKey);
}

function dataDeltaTop10(
  candidates: Array<Record<string, unknown>>,
  lines: Array<{ title: string; abstract: string; keywords: string; venue: string }>,
): string[] {
  const rows = Recommender.candidateRows({ conferences: candidates }).concat(
    Recommender.journalRows(candidates, DATA_DELTA_NOW),
  );
  return Recommender.venueRecommendations(rows, lines, null, DATA_DELTA_NOW, { topN: 10 }).map(
    (result) => result.venueKey,
  );
}

export function fellOutOfTop5(
  beforeTop5: string[],
  expectedVenue: string,
  afterTop10: string[],
): boolean {
  const index = afterTop10.indexOf(expectedVenue);
  return beforeTop5.includes(expectedVenue) && (index < 0 || index >= 5);
}

export function runDataDeltaBenchmark(fixture: DataDeltaFixture): DataDeltaResult {
  if (
    fixture.schema !== 1 ||
    fixture.synthetic !== true ||
    !Array.isArray(fixture.cases) ||
    !Array.isArray(fixture.before_candidates) ||
    !Array.isArray(fixture.after_candidates)
  ) {
    throw new Error("data-delta fixture must be synthetic schema 1");
  }
  if (fixture.cases.length < 60 || fixture.cases.length > 100) {
    throw new Error("data-delta fixture must contain 60-100 cases");
  }
  const categories = new Set(fixture.cases.map((item) => item.category));
  const requiredCategories = [
    "hpc",
    "systems",
    "networking",
    "ai",
    "security",
    "db",
    "graphics",
    "hci",
    "theory",
  ];
  if (requiredCategories.some((category) => !categories.has(category))) {
    throw new Error("data-delta fixture lacks a supported category");
  }
  const has = <K extends keyof DataDeltaCase>(field: K, value: DataDeltaCase[K]): boolean =>
    fixture.cases.some((item) => item[field] === value);
  for (const language of ["en", "ja"] as const) {
    if (!has("language", language)) throw new Error("data-delta fixture lacks language coverage");
  }
  for (const kind of [
    "international",
    "domestic",
    "workshop",
    "journal",
    "special-issue",
  ] as const) {
    if (!has("venue_kind", kind)) throw new Error("data-delta fixture lacks venue kind coverage");
  }
  for (const input of ["title-only", "abstract", "out-of-scope", "insufficient"] as const) {
    if (!has("input", input)) throw new Error("data-delta fixture lacks input coverage");
  }
  const ids = new Set<string>();
  const changed: string[] = [];
  const newVenues = new Set<string>();
  const dropped = new Set<string>();
  const ranks: Array<number | null> = [];
  let abstentions = 0;
  for (const item of fixture.cases) {
    if (!item.id || !item.title || ids.has(item.id) || item.synthetic !== true) {
      throw new Error("invalid data-delta case");
    }
    ids.add(item.id);
    const lines = [{ title: item.title, abstract: item.abstract ?? "", keywords: "", venue: "" }];
    const beforeTop10 = dataDeltaTop10(fixture.before_candidates, lines);
    const afterTop10 = dataDeltaTop10(fixture.after_candidates, lines);
    const beforeTop5 = beforeTop10.slice(0, 5);
    const afterTop5 = afterTop10.slice(0, 5);
    const rank = item.expected_venue ? afterTop10.indexOf(item.expected_venue) + 1 : 0;
    if (afterTop10.length === 0) abstentions += 1;
    // Null explicitly means that the input must abstain, never merely that an
    // arbitrary expected key was absent from a non-empty recommendation list.
    if (item.expected_venue === null && afterTop10.length !== 0) ranks.push(null);
    else if (item.expected_venue === null) ranks.push(0);
    else ranks.push(rank || null);
    if (JSON.stringify(beforeTop5) !== JSON.stringify(afterTop5)) changed.push(item.id);
    for (const venue of afterTop5) if (!beforeTop5.includes(venue)) newVenues.add(venue);
    if (item.expected_venue && fellOutOfTop5(beforeTop5, item.expected_venue, afterTop10)) {
      dropped.add(item.expected_venue);
    }
  }
  const n = ranks.length;
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / n;
  return {
    case_count: n,
    recall_at_1: roundDelta(ranks.filter((rank) => rank === 1).length / n),
    recall_at_5: roundDelta(
      ranks.filter((rank) => rank !== null && rank > 0 && rank <= 5).length / n,
    ),
    mrr: roundDelta(mean(ranks.map((rank) => (rank ? 1 / rank : 0)))),
    ndcg_at_10: roundDelta(mean(ranks.map((rank) => (rank ? 1 / Math.log2(rank + 1) : 0)))),
    abstention_rate: roundDelta(abstentions / n),
    changed_top5: changed.sort(),
    new_venues_in_top5: [...newVenues].sort(),
    expected_venues_dropped: [...dropped].sort(),
  };
}

/** Fail a required data check when labeled recommendation quality regresses. */
export function dataDeltaRegressionReasons(
  fixture: DataDeltaFixture,
  result: DataDeltaResult,
): string[] {
  const baseline = runDataDeltaBenchmark({
    ...fixture,
    after_candidates: fixture.before_candidates,
  });
  const reasons = result.expected_venues_dropped.map(
    (venue) => `expected venue dropped from Top-5: ${venue}`,
  );
  for (const metric of ["recall_at_1", "recall_at_5", "mrr", "ndcg_at_10"] as const) {
    if (result[metric] < baseline[metric]) {
      reasons.push(`${metric} regressed: ${baseline[metric]} -> ${result[metric]}`);
    }
  }
  return reasons;
}

/** Substitute built recommendation indexes for the synthetic fixture catalogs. */
export function dataDeltaWithIndexes(
  fixture: DataDeltaFixture,
  before: unknown,
  after: unknown,
): DataDeltaFixture {
  const conferences = (value: unknown): Array<Record<string, unknown>> => {
    if (
      !value ||
      typeof value !== "object" ||
      !Array.isArray((value as { conferences?: unknown }).conferences)
    ) {
      throw new Error("data-delta recommendation index is missing conferences");
    }
    return (value as { conferences: Array<Record<string, unknown>> }).conferences;
  };
  return {
    ...fixture,
    before_candidates: conferences(before),
    after_candidates: conferences(after),
  };
}

function benchV2Text(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function benchV2Round(value: number): number {
  return Number(value.toFixed(6));
}

function validateBenchV2(fixture: BenchV2Fixture): void {
  if (fixture?.version !== 2) throw new Error("bench v2 version must be 2");
  if (!Array.isArray(fixture.venue_profiles) || fixture.venue_profiles.length === 0) {
    throw new Error("bench v2 venue_profiles must be non-empty");
  }
  if (!Array.isArray(fixture.queries) || fixture.queries.length === 0) {
    throw new Error("bench v2 queries must be non-empty");
  }
  const profiles = new Map<string, BenchV2Profile>();
  for (const profile of fixture.venue_profiles) {
    if (!profile?.key || profiles.has(profile.key)) throw new Error("bench v2 duplicate venue key");
    if (!profile.title || !profile.profile)
      throw new Error(`bench v2 profile ${profile.key} is incomplete`);
    profiles.set(profile.key, profile);
  }
  const ids = new Set<string>();
  const titles = new Set<string>();
  const times = new Map<BenchV2Split, number[]>();
  for (const split of BENCH_V2_SPLITS) times.set(split, []);
  for (const query of fixture.queries) {
    if (!BENCH_V2_SPLITS.includes(query.split))
      throw new Error(`bench v2 invalid split: ${query.split}`);
    if (!query.id || ids.has(query.id)) throw new Error("bench v2 duplicate query id");
    ids.add(query.id);
    const title = benchV2Text(query.title);
    if (!title || titles.has(title)) throw new Error("bench v2 duplicate or leaked query title");
    titles.add(title);
    const time = Date.parse(query.time);
    if (!Number.isFinite(time)) throw new Error(`bench v2 invalid query time: ${query.id}`);
    times.get(query.split)?.push(time);
    if (!profiles.has(query.key)) throw new Error(`bench v2 unknown target venue: ${query.key}`);
    if (
      [...profiles.values()].some((profile) =>
        [profile.title, profile.profile, profile.key].map(benchV2Text).includes(title),
      )
    ) {
      throw new Error(`bench v2 profile/query leakage: ${query.id}`);
    }
    if (!query.semantic || Object.keys(query.semantic).some((key) => !profiles.has(key))) {
      throw new Error(`bench v2 semantic scores have unknown venue: ${query.id}`);
    }
    for (const key of profiles.keys()) {
      if (!Number.isFinite(query.semantic[key]))
        throw new Error(`bench v2 semantic score missing: ${query.id}/${key}`);
    }
  }
  for (const split of BENCH_V2_SPLITS) {
    if (!times.get(split)?.length) throw new Error(`bench v2 split is empty: ${split}`);
  }
  const syntheticEnd = Math.max(...times.get("synthetic")!);
  const devStart = Math.min(...times.get("dev")!);
  const devEnd = Math.max(...times.get("dev")!);
  const heldoutStart = Math.min(...times.get("heldout")!);
  if (!(syntheticEnd < devStart && devEnd < heldoutStart)) {
    throw new Error("bench v2 splits must be strictly time ordered");
  }
}

function benchV2Metrics(ranks: Array<number | null>): BenchV2ModeResult {
  const n = ranks.length;
  const ranked = ranks.filter((rank): rank is number => rank !== null);
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / n;
  const recall = (k: number): number =>
    ranks.filter((rank) => rank !== null && rank <= k).length / n;
  const ndcg = (k: number): number =>
    mean(ranks.map((rank) => (rank !== null && rank <= k ? 1 / Math.log2(rank + 1) : 0)));
  return {
    queries: n,
    mrr: benchV2Round(mean(ranked.map((rank) => 1 / rank))),
    top1Accuracy: benchV2Round(ranks.filter((rank) => rank === 1).length / n),
    coverage: benchV2Round(ranked.length / n),
    "recall@1": benchV2Round(recall(1)),
    "recall@5": benchV2Round(recall(5)),
    "recall@10": benchV2Round(recall(10)),
    "ndcg@5": benchV2Round(ndcg(5)),
    "ndcg@10": benchV2Round(ndcg(10)),
  };
}

function calibrationMetrics(
  observations: Array<{
    top1Probability: number;
    top5Probability: number;
    top1: boolean;
    top5: boolean;
  }>,
): RecommendationCalibration {
  const reliability = (field: "top1" | "top5") =>
    Array.from({ length: 5 }, (_, index) => {
      const lower = index / 5;
      const upper = (index + 1) / 5;
      const probabilityField = field === "top1" ? "top1Probability" : "top5Probability";
      const bucket = observations.filter(
        (item) =>
          item[probabilityField] >= lower &&
          (index === 4 ? item[probabilityField] <= upper : item[probabilityField] < upper),
      );
      return {
        lower,
        upper,
        confidence: bucket.length
          ? benchV2Round(
              bucket.reduce((sum, item) => sum + item[probabilityField], 0) / bucket.length,
            )
          : 0,
        accuracy: bucket.length
          ? benchV2Round(bucket.filter((item) => item[field]).length / bucket.length)
          : 0,
        count: bucket.length,
      };
    });
  const top1Reliability = reliability("top1");
  const top5Reliability = reliability("top5");
  const ece = (buckets: RecommendationCalibration["reliability_top1"]) =>
    benchV2Round(
      buckets.reduce(
        (sum, bucket) =>
          sum +
          (bucket.count / Math.max(1, observations.length)) *
            Math.abs(bucket.confidence - bucket.accuracy),
        0,
      ),
    );
  const brier = (field: "top1" | "top5") => {
    const probabilityField = field === "top1" ? "top1Probability" : "top5Probability";
    return benchV2Round(
      observations.reduce(
        (sum, item) => sum + (item[probabilityField] - Number(item[field])) ** 2,
        0,
      ) / Math.max(1, observations.length),
    );
  };
  const top1Ece = ece(top1Reliability);
  const top1Brier = brier("top1");
  return {
    expected_calibration_error: top1Ece,
    brier_score: top1Brier,
    top1_expected_calibration_error: top1Ece,
    top1_brier_score: top1Brier,
    top5_expected_calibration_error: ece(top5Reliability),
    top5_brier_score: brier("top5"),
    precision_coverage: [0.1, 0.5, 0.8].map((threshold) => {
      const selected = observations.filter((item) => item.top1Probability >= threshold);
      return {
        threshold,
        precision: selected.length
          ? benchV2Round(selected.filter((item) => item.top1).length / selected.length)
          : null,
        coverage: benchV2Round(selected.length / Math.max(1, observations.length)),
      };
    }),
    reliability_top1: top1Reliability,
    reliability_top5: top5Reliability,
  };
}

export function runBenchmarkV2(fixture: BenchV2Fixture): BenchV2Result {
  validateBenchV2(fixture);
  const rows = fixture.venue_profiles.map((profile) => ({
    conf: {
      key: profile.key,
      title: profile.title,
      full_name: profile.title,
      tags: [],
      papers: [],
    },
    cats: [],
    kind: "paper",
    t: Date.parse("2099-01-01"),
    tLast: Date.parse("2099-01-01"),
    est: false,
  }));
  const bySplit = Object.fromEntries(
    BENCH_V2_SPLITS.map((split) => [
      split,
      {
        queries: 0,
        ranks: {
          lexical: [] as Array<number | null>,
          semantic: [] as Array<number | null>,
          fused: [] as Array<number | null>,
        },
        probabilities: [] as Array<{
          top1Probability: number;
          top5Probability: number;
          top1: boolean;
          top5: boolean;
        }>,
      },
    ]),
  ) as Record<
    BenchV2Split,
    {
      queries: number;
      ranks: Record<"lexical" | "semantic" | "fused", Array<number | null>>;
      probabilities: Array<{
        top1Probability: number;
        top5Probability: number;
        top1: boolean;
        top5: boolean;
      }>;
    }
  >;
  // bench-v2 is the stable synthetic retrieval/plumbing gate. The required
  // real-paper gate below separately exercises the trained production reranker.
  Recommender.setReranker(null);
  try {
    for (const query of fixture.queries) {
      const lines = Recommender.parsePaperLines(
        JSON.stringify([{ title: query.title, abstract: "", keywords: query.keywords, venue: "" }]),
      );
      const recommendations = Recommender.venueRecommendations(
        rows,
        lines,
        query.semantic,
        Date.parse(query.time),
        { topN: rows.length },
      ) as VenueRecommendation[];
      const rank = (mode: "lexical" | "semantic" | "fused"): number | null => {
        const ordered =
          mode === "fused"
            ? recommendations
            : recommendations
                .filter((item) =>
                  mode === "lexical" ? item.fit.lexicalScore > 0 : item.fit.semanticScore > 0,
                )
                .sort(
                  (a, b) =>
                    (mode === "lexical"
                      ? b.fit.lexicalScore - a.fit.lexicalScore
                      : b.fit.semanticScore - a.fit.semanticScore) ||
                    a.venueKey.localeCompare(b.venueKey),
                );
        const index = ordered.findIndex((item) => item.venueKey === query.key);
        return index < 0 ? null : index + 1;
      };
      bySplit[query.split].queries += 1;
      for (const mode of ["lexical", "semantic", "fused"] as const)
        bySplit[query.split].ranks[mode].push(rank(mode));
      const fusedRank = rank("fused");
      bySplit[query.split].probabilities.push({
        top1Probability: recommendations[0]?.fit.probability ?? 0,
        top5Probability: Math.max(
          0,
          ...recommendations.slice(0, 5).map((item) => item.fit.probability),
        ),
        top1: fusedRank === 1,
        top5: fusedRank !== null && fusedRank <= 5,
      });
    }
    return {
      version: 2,
      splits: Object.fromEntries(
        BENCH_V2_SPLITS.map((split) => [
          split,
          {
            queries: bySplit[split].queries,
            modes: Object.fromEntries(
              (Object.keys(bySplit[split].ranks) as Array<"lexical" | "semantic" | "fused">).map(
                (mode) => [mode, benchV2Metrics(bySplit[split].ranks[mode])],
              ),
            ),
            candidate_retrieval: (() => {
              const lexical = bySplit[split].ranks.lexical;
              const semantic = bySplit[split].ranks.semantic;
              const recall = (predicate: (index: number) => boolean) =>
                benchV2Round(
                  Array.from({ length: bySplit[split].queries }, (_, index) => index).filter(
                    predicate,
                  ).length / Math.max(1, bySplit[split].queries),
                );
              const union = (index: number) =>
                (lexical[index] !== null && lexical[index]! <= 50) ||
                (semantic[index] !== null && semantic[index]! <= 50);
              return {
                lexical_recall_at_50: recall(
                  (index) => lexical[index] !== null && lexical[index]! <= 50,
                ),
                semantic_recall_at_50: recall(
                  (index) => semantic[index] !== null && semantic[index]! <= 50,
                ),
                union_recall_at_50: recall(union),
                oracle_reranker_recall_at_5: recall(union),
              };
            })(),
            fused_mrr_lcb: bootstrapConfidenceInterval(bySplit[split].ranks.fused).metrics.mrr
              .lower,
            calibration: calibrationMetrics(bySplit[split].probabilities),
          },
        ]),
      ) as BenchV2Result["splits"],
    };
  } finally {
    Recommender.setReranker(null);
  }
}

export function benchV2RequiredRegressionReasons(result: BenchV2Result): string[] {
  const reasons: string[] = [];
  for (const split of ["dev", "heldout"] as const) {
    const value = result.splits[split];
    if (value.candidate_retrieval.union_recall_at_50 < 1)
      reasons.push(`fixed ${split} union Recall@50 regressed`);
    if (value.candidate_retrieval.oracle_reranker_recall_at_5 < 1)
      reasons.push(`fixed ${split} oracle reranker Recall@5 regressed`);
    if (value.modes.fused["recall@5"] < 1) reasons.push(`fixed ${split} fused Recall@5 regressed`);
    if (value.fused_mrr_lcb < 1) reasons.push(`fixed ${split} fused MRR LCB regressed`);
    if (
      !Number.isFinite(value.calibration.expected_calibration_error) ||
      !Number.isFinite(value.calibration.brier_score)
    )
      reasons.push(`fixed ${split} calibration is invalid`);
  }
  return reasons;
}

const REAL_PAPER_CATEGORIES = [
  "hpc",
  "systems",
  "networking",
  "ai",
  "security",
  "db",
  "graphics",
  "hci",
  "theory",
] as const;
const REAL_PAPER_LANGUAGES = ["en", "ja"] as const;
const REAL_PAPER_SCOPES = ["international", "domestic"] as const;
const REAL_PAPER_KINDS = ["conference", "workshop", "journal", "special-issue"] as const;
const REAL_PAPER_MODES = ["lexical", "semantic", "fused"] as const;
const REAL_PAPER_INPUT_MODES = ["title-only", "title+abstract", "pdf-extract"] as const;
const REAL_PAPER_NEGATIVE_REASONS = [
  "venue-not-in-catalog",
  "insufficient-content",
  "ambiguous-scope",
  "near-boundary",
] as const;
const REAL_PAPER_SOURCE_HOSTS = [
  "ches.iacr.org",
  "proceedings.mlr.press",
  "conferences.sigcomm.org",
  "2025.sigmod.org",
  "2026.sigmod.org",
  "openaccess.thecvf.com",
  "dblp.org",
  "hpdc.sci.utah.edu",
  "www.usenix.org",
  "www.ndss-symposium.org",
  "www.jstage.jst.go.jp",
  "ipsj.ixsq.nii.ac.jp",
  "pubmed.ncbi.nlm.nih.gov",
] as const;
const BOOTSTRAP_SEED = 0x5eed2026;
const BOOTSTRAP_RESAMPLES = 1_000;
type RealPaperLanguage = (typeof REAL_PAPER_LANGUAGES)[number];
type RealPaperScope = (typeof REAL_PAPER_SCOPES)[number];
type RealPaperKind = (typeof REAL_PAPER_KINDS)[number];
type RealPaperMode = (typeof REAL_PAPER_MODES)[number];
type RealPaperInputMode = (typeof REAL_PAPER_INPUT_MODES)[number];
type RealPaperNegativeReason = (typeof REAL_PAPER_NEGATIVE_REASONS)[number];
export type RealPaperCoverage = "full" | "required";

/** Frozen semantic production features.  The benchmark still performs lexical
 * retrieval and all ranking in the browser recommender; this file only replaces
 * remote model inference in required CI. */
export interface RequiredSemanticFeatures {
  version: 1;
  feature_schema: string[];
  minimum_language_counts: Record<"dev" | "heldout", Record<RealPaperLanguage, number>>;
  provenance: { generator: string; model: string; revision: string; runtime: string };
  profiles: Record<"dev" | "heldout" | "negative", BenchmarkEmbeddingManifest>;
  records: Array<{
    paper_id: string;
    record_sha256: string;
    semantic_scores: Record<string, number>;
    candidates: Array<{
      venue: string;
      base_score: number;
      features: Record<string, number>;
    }>;
  }>;
}

function requiredRecordHash(
  record: Pick<
    RequiredSemanticFeatures["records"][number],
    "paper_id" | "semantic_scores" | "candidates"
  >,
): string {
  return createHash("sha256")
    .update(JSON.stringify([record.paper_id, record.semantic_scores, record.candidates]))
    .digest("hex");
}

export function validateRequiredLanguageCounts(
  features: RequiredSemanticFeatures,
  fixtures: readonly RealPaperFixture[],
): void {
  for (const fixture of fixtures) {
    const minimums = features.minimum_language_counts?.[fixture.split];
    if (!minimums || !Number.isInteger(minimums.en) || !Number.isInteger(minimums.ja))
      throw new Error(`required feature fixture needs ${fixture.split} language minimums`);
    for (const language of REAL_PAPER_LANGUAGES) {
      const actual = fixture.records.filter((record) => record.language === language).length;
      if (minimums[language] < 1 || actual < minimums[language])
        throw new Error(`real paper ${fixture.split} ${language} count ${actual} below minimum`);
    }
  }
}

export function fixedFeatureRecord(
  features: RequiredSemanticFeatures | undefined,
  paperId: string,
  expected: BenchmarkEmbeddingManifest,
  split: "dev" | "heldout" | "negative",
): RequiredSemanticFeatures["records"][number] | null {
  if (!features) return null;
  if (
    features.version !== 1 ||
    !Array.isArray(features.feature_schema) ||
    features.feature_schema.join("\0") !== Recommender.RERANKER_FEATURE_SCHEMA.join("\0") ||
    JSON.stringify(features.profiles[split]) !== JSON.stringify(expected)
  ) {
    throw new Error("required semantic feature schema/profile mismatch");
  }
  const found = features.records.find((record) => record.paper_id === paperId);
  if (
    !found ||
    Object.keys(found.semantic_scores).length === 0 ||
    Object.values(found.semantic_scores).some((value) => !Number.isFinite(value)) ||
    found.record_sha256 !== requiredRecordHash(found) ||
    !found.candidates.length ||
    found.candidates.some(
      (candidate) =>
        Object.keys(candidate.features).join("\0") !==
          Recommender.RERANKER_FEATURE_SCHEMA.join("\0") ||
        Object.values(candidate.features).some((value) => !Number.isFinite(value)),
    )
  )
    throw new Error(`required production feature missing, altered, or zeroed: ${paperId}`);
  return found;
}

export interface RealPaperRecord {
  paper_id: string;
  year: number;
  title: string;
  abstract?: string;
  pdf_text?: string;
  pdf_sha256?: string;
  primary_venue: string;
  acceptable_venues: string[];
  language: RealPaperLanguage;
  domains: string[];
  venue_scope: RealPaperScope;
  venue_kind: RealPaperKind;
  input_mode: RealPaperInputMode;
  source: string;
}

export interface RealPaperSourceSnapshot {
  url: string;
  revision: string;
  sha256: string;
}

interface RealPaperProvenance {
  collected_at: string;
  sources: RealPaperSourceSnapshot[];
}

export interface RealPaperFixture {
  version: 1;
  split: "dev" | "heldout";
  profile_year_max: number;
  provenance: RealPaperProvenance;
  records: RealPaperRecord[];
}

type RealPaperProfiles = Record<string, string[]> | VenueProfileArtifact;

export type RealPaperRanks = Record<RealPaperMode, number | null>;

/** Per-query failure classification for the recommendation pipeline. */
export type FailureType =
  | "none"
  | "retrieval" // acceptable venue not in candidate set at all
  | "reranker" // acceptable venue in candidates but not in top-5 fused
  | "annotation" // recommended venue is valid but not in acceptable_venues
  | "calibration"; // top-5 has acceptable venue but confidence is wrong

export interface FailureClassification {
  failure_type: FailureType;
  /** Rank of best acceptable venue in the union of lexical+semantic candidates */
  union_rank: number | null;
  /** Rank of best acceptable venue in the fused (reranker) ranking */
  fused_rank: number | null;
  /** Number of acceptable venues found in the candidate set */
  acceptable_in_candidates: number;
  /** Total number of acceptable venues for this query */
  acceptable_total: number;
  /** Confidence label from the reranker */
  confidence: string;
}

export function classifyFailure(
  lexicalRank: number | null,
  semanticRank: number | null,
  fusedRank: number | null,
  acceptableVenues: ReadonlySet<string>,
  candidateKeys: ReadonlySet<string>,
  confidence: string,
): FailureClassification {
  const unionRank =
    lexicalRank !== null && semanticRank !== null
      ? Math.min(lexicalRank, semanticRank)
      : (lexicalRank ?? semanticRank);
  const acceptableInCandidates = [...acceptableVenues].filter((v) => candidateKeys.has(v)).length;
  const top5Hit = fusedRank !== null && fusedRank <= 5;
  const candidateHit = unionRank !== null && unionRank <= 50;

  let failureType: FailureType = "none";
  if (!candidateHit) {
    failureType = "retrieval";
  } else if (!top5Hit) {
    failureType = "reranker";
  } else if (confidence !== "sufficient") {
    failureType = "calibration";
  }

  return {
    failure_type: failureType,
    union_rank: unionRank,
    fused_rank: fusedRank,
    acceptable_in_candidates: acceptableInCandidates,
    acceptable_total: acceptableVenues.size,
    confidence,
  };
}

export interface BootstrapConfidenceInterval {
  method: "bootstrap";
  confidence_level: 0.95;
  seed: number;
  resamples: number;
  metrics: Record<
    "mrr" | "recall@1" | "recall@5" | "recall@10" | "ndcg@10",
    { lower: number; upper: number }
  >;
}

export interface RealPaperModeResult extends BenchV2ModeResult {
  confidence_interval: BootstrapConfidenceInterval;
}

export interface RealPaperModeDeltas {
  lexical_to_semantic: Record<"mrr" | "recall@1" | "recall@5" | "recall@10" | "ndcg@10", number>;
  lexical_to_fused: Record<"mrr" | "recall@1" | "recall@5" | "recall@10" | "ndcg@10", number>;
  semantic_to_fused: Record<"mrr" | "recall@1" | "recall@5" | "recall@10" | "ndcg@10", number>;
}

export interface RealPaperAbstention {
  mode: "fused";
  total: number;
  abstained: number;
  coverage: number;
  conditionalPrecision: number | null;
  "conditionalRecall@5": number | null;
}

export interface RealPaperSplitResult {
  queries: number;
  modes: Record<RealPaperMode, RealPaperModeResult>;
  strata: {
    language: Record<string, Record<RealPaperMode, RealPaperModeResult>>;
    category: Record<string, Record<RealPaperMode, RealPaperModeResult>>;
    domain: Record<string, Record<RealPaperMode, RealPaperModeResult>>;
    venueScope: Record<string, Record<RealPaperMode, RealPaperModeResult>>;
    venueKind: Record<string, Record<RealPaperMode, RealPaperModeResult>>;
    inputMode: Record<string, Record<RealPaperMode, RealPaperModeResult>>;
  };
  mode_deltas: RealPaperModeDeltas;
  abstention: RealPaperAbstention;
  candidate_retrieval: {
    lexical_recall_at_50: number;
    semantic_recall_at_50: number;
    union_recall_at_50: number;
    oracle_reranker_recall_at_5: number;
  };
  calibration: RecommendationCalibration;
  failure_taxonomy?: Record<FailureType, number>;
}

export interface RealPaperNegativeRecord {
  paper_id: string;
  year: number;
  title: string;
  abstract?: string;
  keywords?: string | string[];
  language: RealPaperLanguage;
  domains: string[];
  venue_kind: RealPaperKind;
  input_mode: RealPaperInputMode;
  source: string;
  negative_reason: RealPaperNegativeReason;
}

export interface RealPaperNegativeFixture {
  version: 1;
  split: "negative";
  profile_year_max: number;
  records: RealPaperNegativeRecord[];
}

export interface RealPaperNegativeResult {
  queries: number;
  expected_abstention_rate: number;
  non_abstain_rate: number;
  non_abstain_precision: 0 | null;
}

export interface RealPaperRegressionFloor {
  dev: { "fusedRecall@5": number; "unionRecall@50": number; fusedMrrLcb: number };
  heldout: { "fusedRecall@5": number; "unionRecall@50": number; fusedMrrLcb: number };
  negative: { expected_abstention_rate: number };
}

// Measured by the real CLI; values are tightened only with a new baseline.
export const REAL_PAPER_REGRESSION_FLOORS: Record<RealPaperCoverage, RealPaperRegressionFloor> = {
  required: {
    dev: { "fusedRecall@5": 0.111111, "unionRecall@50": 0.444444, fusedMrrLcb: 0.009 },
    heldout: { "fusedRecall@5": 0.3, "unionRecall@50": 0.8, fusedMrrLcb: 0.027 },
    negative: { expected_abstention_rate: 1 },
  },
  full: {
    dev: { "fusedRecall@5": 0.0625, "unionRecall@50": 0.5, fusedMrrLcb: 0 },
    heldout: { "fusedRecall@5": 0.075, "unionRecall@50": 0.5, fusedMrrLcb: 0 },
    negative: { expected_abstention_rate: 1 },
  },
};

export interface RealPaperResult {
  benchmark: "real-paper-v1";
  version: 1;
  models: {
    en: { model: string; revision: string };
    ja: { model: string; revision: string };
  };
  splits: {
    dev: RealPaperSplitResult;
    heldout: RealPaperSplitResult;
    negative?: RealPaperNegativeResult;
  };
  benchmark_embeddings?: {
    dev: BenchmarkEmbeddingManifest;
    heldout: BenchmarkEmbeddingManifest;
  };
  regression_floor: RealPaperRegressionFloor;
  timing: { firstLoadMs: null; repeatRecommendationMs: null };
}

export interface RealPaperRun {
  result: RealPaperResult;
  timing: { firstLoadMs: number; repeatRecommendationMs: number };
}

function realPaperText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function realPaperTitleTokens(value: unknown): Set<string> {
  return new Set(
    realPaperText(value)
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOP.has(word)),
  );
}

function realPaperNearDuplicate(left: string, right: string): boolean {
  const a = realPaperTitleTokens(left);
  const b = realPaperTitleTokens(right);
  if (a.size < 3 || b.size < 3) return false;
  const smaller = a.size <= b.size ? a : b;
  const larger = smaller === a ? b : a;
  let overlap = 0;
  for (const token of smaller) if (larger.has(token)) overlap++;
  return overlap / smaller.size >= 0.8;
}

function realPaperInputMode(
  record: Pick<RealPaperRecord, "abstract" | "pdf_text" | "input_mode">,
): RealPaperInputMode {
  if (record.pdf_text?.trim()) return "pdf-extract";
  if (record.abstract?.trim()) return "title+abstract";
  return "title-only";
}

function validateRealPaperSource(record: { paper_id: string; source: string }): URL {
  try {
    const source = new URL(record.source);
    if (
      source.protocol !== "https:" ||
      !REAL_PAPER_SOURCE_HOSTS.includes(source.hostname as never)
    ) {
      throw new Error();
    }
    return source;
  } catch {
    throw new Error(`real paper ${record.paper_id} needs an approved https source URL`);
  }
}

function validateRealPaperProvenance(fixture: RealPaperFixture): void {
  if (!Number.isFinite(Date.parse(fixture.provenance?.collected_at))) {
    throw new Error(`real paper ${fixture.split} provenance needs collected_at`);
  }
  const sources = new Map<string, RealPaperSourceSnapshot>();
  for (const source of fixture.provenance?.sources ?? []) {
    validateRealPaperSource({ paper_id: `${fixture.split} provenance`, source: source.url });
    if (
      sources.has(source.url) ||
      !source.revision?.trim() ||
      !/^[a-f0-9]{64}$/.test(source.sha256)
    ) {
      throw new Error(`real paper ${fixture.split} has invalid source provenance`);
    }
    sources.set(source.url, source);
  }
  for (const record of fixture.records) {
    const snapshot = sources.get(record.source);
    if (!snapshot) {
      throw new Error(`real paper ${record.paper_id} source is missing from provenance`);
    }
    if (
      record.input_mode === "pdf-extract" &&
      "pdf_sha256" in record &&
      record.pdf_sha256 !== snapshot.sha256
    ) {
      throw new Error(`real paper ${record.paper_id} PDF hash does not match source provenance`);
    }
  }
}

function validateRealPaperRecord(
  record: RealPaperRecord,
  split: RealPaperFixture["split"],
  index: number,
  venueKeys: ReadonlySet<string>,
): void {
  if (!record || typeof record !== "object")
    throw new Error(`real paper ${split}[${index}] is invalid`);
  if (!record.paper_id?.trim()) throw new Error(`real paper ${split}[${index}] missing paper_id`);
  if (!Number.isInteger(record.year) || record.year < 1900 || record.year > 2100) {
    throw new Error(`real paper ${record.paper_id} has invalid year`);
  }
  if (!record.title?.trim()) throw new Error(`real paper ${record.paper_id} missing title`);
  if (!REAL_PAPER_INPUT_MODES.includes(record.input_mode))
    throw new Error(`real paper ${record.paper_id} has invalid input_mode`);
  if (record.input_mode !== realPaperInputMode(record))
    throw new Error(`real paper ${record.paper_id} input_mode does not match supplied text`);
  const source = validateRealPaperSource(record);
  if (record.input_mode === "pdf-extract") {
    if (
      !/^[a-f0-9]{64}$/.test(record.pdf_sha256 ?? "") ||
      !/\.pdf(?:$|[?#])|\/_pdf(?:\/|$)/i.test(source.pathname)
    ) {
      throw new Error(`real paper ${record.paper_id} PDF extraction needs a PDF URL and hash`);
    }
  } else if (record.pdf_sha256) {
    throw new Error(`real paper ${record.paper_id} has a PDF hash outside pdf-extract mode`);
  }
  if (!venueKeys.has(record.primary_venue)) {
    throw new Error(
      `real paper ${record.paper_id} has unknown primary venue: ${record.primary_venue}`,
    );
  }
  const acceptable = toStringArray(record.acceptable_venues);
  if (!acceptable.length || !acceptable.includes(record.primary_venue)) {
    throw new Error(
      `real paper ${record.paper_id} needs acceptable_venues including primary venue`,
    );
  }
  if (new Set(acceptable).size !== acceptable.length) {
    throw new Error(`real paper ${record.paper_id} has duplicate acceptable venue`);
  }
  for (const key of acceptable) {
    if (!venueKeys.has(key))
      throw new Error(`real paper ${record.paper_id} has unknown venue: ${key}`);
  }
  if (!REAL_PAPER_LANGUAGES.includes(record.language)) {
    throw new Error(`real paper ${record.paper_id} has invalid language`);
  }
  if (!REAL_PAPER_SCOPES.includes(record.venue_scope)) {
    throw new Error(`real paper ${record.paper_id} has invalid venue_scope`);
  }
  if (!REAL_PAPER_KINDS.includes(record.venue_kind)) {
    throw new Error(`real paper ${record.paper_id} has invalid venue_kind`);
  }
  if (!toStringArray(record.domains).length)
    throw new Error(`real paper ${record.paper_id} needs domains`);
}

function validateRealPaperCoverage(fixture: RealPaperFixture, coverage: "full" | "required"): void {
  const expectedSize = coverage === "full" ? [80, 120] : [6, 20];
  if (fixture.records.length < expectedSize[0] || fixture.records.length > expectedSize[1]) {
    throw new Error(
      `real paper ${fixture.split} ${coverage} fixture must contain ${expectedSize[0]}-${expectedSize[1]} records`,
    );
  }
  const requireValues = (name: string, required: readonly string[], values: string[]): void => {
    const actual = new Set(values);
    const missing = required.filter((value) => !actual.has(value));
    if (missing.length) {
      throw new Error(`real paper ${fixture.split} lacks ${name}: ${missing.join(", ")}`);
    }
  };
  requireValues(
    "language coverage",
    REAL_PAPER_LANGUAGES,
    fixture.records.map((record) => record.language),
  );
  requireValues(
    "venue scope coverage",
    REAL_PAPER_SCOPES,
    fixture.records.map((record) => record.venue_scope),
  );
  requireValues(
    "category coverage",
    REAL_PAPER_CATEGORIES,
    fixture.records.flatMap((record) => record.domains),
  );
  requireValues(
    "venue kind coverage",
    REAL_PAPER_KINDS,
    fixture.records.map((record) => record.venue_kind),
  );
  requireValues(
    "input mode coverage",
    REAL_PAPER_INPUT_MODES,
    fixture.records.map((record) => record.input_mode),
  );
  if (!fixture.records.some((record) => record.acceptable_venues.length > 1)) {
    throw new Error(`real paper ${fixture.split} lacks multiple acceptable venues`);
  }
  if (fixture.split === "heldout") {
    const counts = new Map<string, number>();
    for (const record of fixture.records) {
      counts.set(record.primary_venue, (counts.get(record.primary_venue) ?? 0) + 1);
    }
    if (Math.max(...counts.values()) / fixture.records.length > 0.25) {
      throw new Error("real paper heldout maximum venue share exceeds 25%");
    }
  }
}

function validateRealPaperNegativeFixture(fixture: RealPaperNegativeFixture): void {
  if (fixture?.version !== 1 || fixture.split !== "negative")
    throw new Error("negative real paper fixture must be version 1 / negative");
  if (!Number.isInteger(fixture.profile_year_max) || !fixture.records?.length)
    throw new Error("negative real paper fixture must have a cutoff and records");
  const ids = new Set<string>();
  for (const record of fixture.records) {
    if (!record.paper_id?.trim() || ids.has(record.paper_id))
      throw new Error(`negative real paper has duplicate or missing id: ${record.paper_id}`);
    ids.add(record.paper_id);
    if (!Number.isInteger(record.year) || record.year < 1900 || record.year > 2100)
      throw new Error(`negative real paper ${record.paper_id} has invalid year`);
    if (!record.title?.trim() || !toStringArray(record.domains).length)
      throw new Error(`negative real paper ${record.paper_id} is incomplete`);
    if (
      !REAL_PAPER_LANGUAGES.includes(record.language) ||
      !REAL_PAPER_KINDS.includes(record.venue_kind)
    )
      throw new Error(`negative real paper ${record.paper_id} has invalid segment`);
    if (
      !REAL_PAPER_INPUT_MODES.includes(record.input_mode) ||
      record.input_mode !== realPaperInputMode(record)
    )
      throw new Error(`negative real paper ${record.paper_id} has invalid input mode`);
    if (!REAL_PAPER_NEGATIVE_REASONS.includes(record.negative_reason))
      throw new Error(`negative real paper ${record.paper_id} has invalid label`);
    validateRealPaperSource(record);
  }
  const requireCoverage = (name: string, actual: string[], expected: readonly string[]) => {
    const missing = expected.filter((value) => !actual.includes(value));
    if (missing.length) throw new Error(`negative real paper lacks ${name}: ${missing.join(", ")}`);
  };
  requireCoverage(
    "language coverage",
    fixture.records.map((record) => record.language),
    REAL_PAPER_LANGUAGES,
  );
  requireCoverage(
    "input mode coverage",
    fixture.records.map((record) => record.input_mode),
    ["title-only", "title+abstract"],
  );
  requireCoverage(
    "reason coverage",
    fixture.records.map((record) => record.negative_reason),
    REAL_PAPER_NEGATIVE_REASONS,
  );
  const minYear = Math.min(...fixture.records.map((record) => record.year));
  if (!(fixture.profile_year_max < minYear))
    throw new Error("negative real paper profile must precede evaluation year");
}

export function validateRealPaperFixtures(
  dev: RealPaperFixture,
  heldout: RealPaperFixture,
  venueKeys: ReadonlySet<string> = new Set(Object.keys(VENUE_PAPERS)),
  profiles: RealPaperProfiles = VENUE_PROFILE_ARTIFACT,
  regressionKnown: RegressionKnownRecord[] = REGRESSION_KNOWN.records,
  negative?: RealPaperNegativeFixture,
  coverage: "full" | "required" = "full",
): void {
  for (const fixture of [dev, heldout]) {
    if (fixture?.version !== 1) throw new Error("real paper fixture version must be 1");
    if (fixture.split !== "dev" && fixture.split !== "heldout") {
      throw new Error(`real paper fixture has invalid split: ${fixture.split}`);
    }
    if (!Number.isInteger(fixture.profile_year_max)) {
      throw new Error(`real paper ${fixture.split} profile_year_max must be an integer`);
    }
    if (!Array.isArray(fixture.records) || fixture.records.length === 0) {
      throw new Error(`real paper ${fixture.split} records must be non-empty`);
    }
    validateRealPaperProvenance(fixture);
    validateRealPaperCoverage(fixture, coverage);
    const minYear = Math.min(...fixture.records.map((record) => record.year));
    if (!(fixture.profile_year_max < minYear)) {
      throw new Error(`real paper ${fixture.split} profile must precede evaluation year`);
    }
    for (const [index, record] of fixture.records.entries()) {
      validateRealPaperRecord(record, fixture.split, index, venueKeys);
    }
  }
  const devEnd = Math.max(...dev.records.map((record) => record.year));
  const heldoutStart = Math.min(...heldout.records.map((record) => record.year));
  if (!(devEnd < heldoutStart))
    throw new Error("real paper dev/heldout years must be strictly ordered");

  if (negative) validateRealPaperNegativeFixture(negative);

  const titles = new Map<string, string>();
  const allRecords = [...dev.records, ...heldout.records, ...(negative?.records ?? [])];
  const ids = new Set<string>();
  for (const record of allRecords) {
    if (ids.has(record.paper_id)) throw new Error(`real paper duplicate id: ${record.paper_id}`);
    ids.add(record.paper_id);
    const normalized = realPaperText(record.title);
    const previous = titles.get(normalized);
    if (previous)
      throw new Error(`real paper exact-title leakage: ${record.paper_id} / ${previous}`);
    for (const [otherTitle, otherId] of titles) {
      if (realPaperNearDuplicate(record.title, otherTitle)) {
        throw new Error(`real paper near-duplicate leakage: ${record.paper_id} / ${otherId}`);
      }
    }
    titles.set(normalized, record.paper_id);
  }
  for (const record of allRecords) {
    for (const known of regressionKnown) {
      if (realPaperText(record.title) === realPaperText(known.title)) {
        throw new Error(`real paper regression-known leakage: ${record.paper_id} / ${known.key}`);
      }
      if (realPaperNearDuplicate(record.title, known.title)) {
        throw new Error(
          `real paper near-duplicate regression-known leakage: ${record.paper_id} / ${known.key}`,
        );
      }
    }
  }
  for (const fixture of [dev, heldout, ...(negative ? [negative] : [])]) {
    const eligibleProfiles = profileTitlesBefore(profiles, fixture.profile_year_max);
    for (const record of fixture.records) {
      for (const [venue, paperTitles] of Object.entries(eligibleProfiles)) {
        for (const profileTitle of paperTitles) {
          if (realPaperText(record.title) === realPaperText(profileTitle)) {
            throw new Error(`real paper profile leakage: ${record.paper_id} / ${venue}`);
          }
          if (realPaperNearDuplicate(record.title, profileTitle)) {
            throw new Error(
              `real paper near-duplicate profile leakage: ${record.paper_id} / ${venue}`,
            );
          }
        }
      }
    }
  }
}

/** Return only profile records that were available at a fixture's cutoff. */
export function profileTitlesBefore(
  profiles: RealPaperProfiles,
  sourceYearMax: number,
): Record<string, string[]> {
  if ("schema" in profiles && profiles.schema === 2) {
    const artifact = profiles as VenueProfileArtifact;
    return Object.fromEntries(
      Object.entries(artifact.profiles).map(([venue, profile]) => [
        venue,
        profile.prototypes.filter((title) =>
          profile.papers.some((paper) => paper.title === title && paper.year <= sourceYearMax),
        ),
      ]),
    );
  }
  return profiles as Record<string, string[]>;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function bootstrapConfidenceInterval(ranks: Array<number | null>): BootstrapConfidenceInterval {
  const metricNames = ["mrr", "recall@1", "recall@5", "recall@10", "ndcg@10"] as const;
  const samples = Object.fromEntries(
    metricNames.map((metric) => [metric, [] as number[]]),
  ) as Record<(typeof metricNames)[number], number[]>;
  const random = seededRandom(BOOTSTRAP_SEED);
  for (let repeat = 0; repeat < BOOTSTRAP_RESAMPLES; repeat++) {
    const sample = Array.from(
      { length: ranks.length },
      () => ranks[Math.floor(random() * ranks.length)]!,
    );
    const metrics = benchV2Metrics(sample);
    for (const metric of metricNames) samples[metric].push(metrics[metric]);
  }
  return {
    method: "bootstrap",
    confidence_level: 0.95,
    seed: BOOTSTRAP_SEED,
    resamples: BOOTSTRAP_RESAMPLES,
    metrics: Object.fromEntries(
      metricNames.map((metric) => {
        const values = samples[metric].sort((left, right) => left - right);
        return [
          metric,
          {
            lower: values[Math.floor((values.length - 1) * 0.025)]!,
            upper: values[Math.ceil((values.length - 1) * 0.975)]!,
          },
        ];
      }),
    ) as BootstrapConfidenceInterval["metrics"],
  };
}

export function realPaperMetrics(
  records: RealPaperRecord[],
  rankings: Record<string, RealPaperRanks>,
): Record<RealPaperMode, RealPaperModeResult> {
  const byMode = Object.fromEntries(
    REAL_PAPER_MODES.map((mode) => [
      mode,
      (() => {
        const ranks = records.map((record) => {
          const result = rankings[record.paper_id];
          if (!result) throw new Error(`real paper ranking missing: ${record.paper_id}`);
          return result[mode];
        });
        return {
          ...benchV2Metrics(ranks),
          confidence_interval: bootstrapConfidenceInterval(ranks),
        };
      })(),
    ]),
  ) as Record<RealPaperMode, RealPaperModeResult>;
  return byMode;
}

function realPaperModeDeltas(
  modes: Record<RealPaperMode, RealPaperModeResult>,
): RealPaperModeDeltas {
  const metrics = ["mrr", "recall@1", "recall@5", "recall@10", "ndcg@10"] as const;
  const delta = (from: RealPaperMode, to: RealPaperMode) =>
    Object.fromEntries(
      metrics.map((metric) => [metric, benchV2Round(modes[to][metric] - modes[from][metric])]),
    ) as RealPaperModeDeltas["lexical_to_semantic"];
  // lexical_delta is surfaced as the fused-minus-lexical pair below.
  return {
    lexical_to_semantic: delta("lexical", "semantic"),
    lexical_to_fused: delta("lexical", "fused"),
    semantic_to_fused: delta("semantic", "fused"),
  };
}

function realPaperStrata(
  records: RealPaperRecord[],
  rankings: Record<string, RealPaperRanks>,
): RealPaperSplitResult["strata"] {
  const dimensions = {
    language: (record: RealPaperRecord): string[] => [record.language],
    category: (record: RealPaperRecord): string[] => toStringArray(record.domains).sort(),
    domain: (record: RealPaperRecord): string[] => toStringArray(record.domains).sort(),
    venueScope: (record: RealPaperRecord): string[] => [record.venue_scope],
    venueKind: (record: RealPaperRecord): string[] => [record.venue_kind],
    inputMode: (record: RealPaperRecord): string[] => [record.input_mode],
  } as const;
  const result = {} as RealPaperSplitResult["strata"];
  for (const [dimension, values] of Object.entries(dimensions)) {
    const groups: Record<string, RealPaperRecord[]> = {};
    for (const record of records) {
      for (const value of values(record)) {
        groups[value] ??= [];
        groups[value]!.push(record);
      }
    }
    result[dimension as keyof RealPaperSplitResult["strata"]] = Object.fromEntries(
      Object.keys(groups)
        .sort()
        .map((value) => [value, realPaperMetrics(groups[value]!, rankings)]),
    ) as never;
  }
  return result;
}

function realPaperAbstention(
  records: RealPaperRecord[],
  rankings: Record<string, RealPaperRanks>,
  confidence: Record<string, string>,
): RealPaperAbstention {
  const eligible = records.filter((record) => confidence[record.paper_id] === "sufficient");
  const metrics = eligible.map((record) => rankings[record.paper_id]!.fused);
  return {
    mode: "fused",
    total: records.length,
    abstained: records.length - eligible.length,
    coverage: benchV2Round(eligible.length / records.length),
    conditionalPrecision:
      eligible.length > 0
        ? benchV2Round(metrics.filter((rank) => rank === 1).length / eligible.length)
        : null,
    "conditionalRecall@5":
      eligible.length > 0
        ? benchV2Round(
            metrics.filter((rank) => rank !== null && rank <= 5).length / eligible.length,
          )
        : null,
  };
}

function realPaperSplitResult(
  records: RealPaperRecord[],
  rankings: Record<string, RealPaperRanks>,
  confidence: Record<string, string>,
  predictedProbability?: Record<string, { top1: number; top5: number }>,
  failures?: Record<string, FailureClassification>,
): RealPaperSplitResult {
  const metrics = realPaperMetrics(records, rankings);
  const probabilities = records.map((record) => {
    const fallback =
      confidence[record.paper_id] === "sufficient"
        ? 0.8
        : confidence[record.paper_id] === "ambiguous"
          ? 0.5
          : 0.1;
    return {
      top1Probability: predictedProbability?.[record.paper_id]?.top1 ?? fallback,
      top5Probability: predictedProbability?.[record.paper_id]?.top5 ?? fallback,
      top1: (rankings[record.paper_id]?.fused ?? Infinity) <= 1,
      top5: (rankings[record.paper_id]?.fused ?? Infinity) <= 5,
    };
  });
  const candidate = records.map((record) => rankings[record.paper_id]!);
  const recall = (predicate: (ranks: RealPaperRanks) => boolean) =>
    benchV2Round(candidate.filter(predicate).length / Math.max(1, candidate.length));
  return {
    queries: records.length,
    modes: metrics,
    strata: realPaperStrata(records, rankings),
    mode_deltas: realPaperModeDeltas(metrics),
    abstention: realPaperAbstention(records, rankings, confidence),
    candidate_retrieval: {
      lexical_recall_at_50: recall((ranks) => ranks.lexical !== null && ranks.lexical <= 50),
      semantic_recall_at_50: recall((ranks) => ranks.semantic !== null && ranks.semantic <= 50),
      union_recall_at_50: recall(
        (ranks) =>
          (ranks.lexical !== null && ranks.lexical <= 50) ||
          (ranks.semantic !== null && ranks.semantic <= 50),
      ),
      oracle_reranker_recall_at_5: recall(
        (ranks) =>
          (ranks.lexical !== null && ranks.lexical <= 50) ||
          (ranks.semantic !== null && ranks.semantic <= 50),
      ),
    },
    calibration: calibrationMetrics(probabilities),
    failure_taxonomy: failures
      ? Object.values(failures).reduce<Record<FailureType, number>>(
          (acc, f) => {
            acc[f.failure_type]++;
            return acc;
          },
          { none: 0, retrieval: 0, reranker: 0, annotation: 0, calibration: 0 },
        )
      : undefined,
  };
}

export function buildRealPaperResult(
  dev: RealPaperFixture,
  heldout: RealPaperFixture,
  evaluations: {
    dev: {
      rankings: Record<string, RealPaperRanks>;
      confidence: Record<string, string>;
      probability?: Record<string, { top1: number; top5: number }>;
      failures?: Record<string, FailureClassification>;
    };
    heldout: {
      rankings: Record<string, RealPaperRanks>;
      confidence: Record<string, string>;
      probability?: Record<string, { top1: number; top5: number }>;
      failures?: Record<string, FailureClassification>;
    };
    negative?: { rankings: Record<string, RealPaperRanks>; confidence: Record<string, string> };
  },
  benchmarkEmbeddings?: { dev: BenchmarkEmbeddingManifest; heldout: BenchmarkEmbeddingManifest },
  negative?: RealPaperNegativeFixture,
  coverage: RealPaperCoverage = "full",
): RealPaperResult {
  return {
    benchmark: "real-paper-v1",
    version: 1,
    models: {
      en: { model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION },
      ja: { model: EMBEDDING_MULTI_MODEL, revision: EMBEDDING_MULTI_REVISION },
    },
    splits: {
      dev: realPaperSplitResult(
        dev.records,
        evaluations.dev.rankings,
        evaluations.dev.confidence,
        evaluations.dev.probability,
        evaluations.dev.failures,
      ),
      heldout: realPaperSplitResult(
        heldout.records,
        evaluations.heldout.rankings,
        evaluations.heldout.confidence,
        evaluations.heldout.probability,
        evaluations.heldout.failures,
      ),
      ...(negative && evaluations.negative
        ? {
            negative: (() => {
              const abstained = negative.records.filter(
                (record) => evaluations.negative!.confidence[record.paper_id] !== "sufficient",
              ).length;
              const nonAbstain = negative.records.length - abstained;
              return {
                queries: negative.records.length,
                expected_abstention_rate: benchV2Round(abstained / negative.records.length),
                non_abstain_rate: benchV2Round(nonAbstain / negative.records.length),
                non_abstain_precision: nonAbstain > 0 ? 0 : null,
              };
            })(),
          }
        : {}),
    },
    ...(benchmarkEmbeddings ? { benchmark_embeddings: benchmarkEmbeddings } : {}),
    regression_floor: REAL_PAPER_REGRESSION_FLOORS[coverage],
    // Wall-clock values are intentionally kept out of machine-readable JSON.
    timing: { firstLoadMs: null, repeatRecommendationMs: null },
  };
}

export function realPaperRegressionReasons(
  result: RealPaperResult,
  coverage: RealPaperCoverage,
): string[] {
  const floor = REAL_PAPER_REGRESSION_FLOORS[coverage];
  const actual = {
    dev: result.splits.dev.modes.fused["recall@5"],
    heldout: result.splits.heldout.modes.fused["recall@5"],
    negative: result.splits.negative?.expected_abstention_rate,
    devUnion: result.splits.dev.candidate_retrieval.union_recall_at_50,
    heldoutUnion: result.splits.heldout.candidate_retrieval.union_recall_at_50,
    devMrrLcb: result.splits.dev.modes.fused.confidence_interval.metrics.mrr.lower,
    heldoutMrrLcb: result.splits.heldout.modes.fused.confidence_interval.metrics.mrr.lower,
  };
  return [
    ...(actual.dev < floor.dev["fusedRecall@5"]
      ? [`real bench ${coverage} dev fused Recall@5 ${actual.dev} < ${floor.dev["fusedRecall@5"]}`]
      : []),
    ...(actual.heldout < floor.heldout["fusedRecall@5"]
      ? [
          `real bench ${coverage} heldout fused Recall@5 ${actual.heldout} < ${floor.heldout["fusedRecall@5"]}`,
        ]
      : []),
    ...(actual.devUnion < floor.dev["unionRecall@50"]
      ? [
          `real bench ${coverage} dev union Recall@50 ${actual.devUnion} < ${floor.dev["unionRecall@50"]}`,
        ]
      : []),
    ...(actual.heldoutUnion < floor.heldout["unionRecall@50"]
      ? [
          `real bench ${coverage} heldout union Recall@50 ${actual.heldoutUnion} < ${floor.heldout["unionRecall@50"]}`,
        ]
      : []),
    ...(actual.devMrrLcb < floor.dev.fusedMrrLcb
      ? [`real bench ${coverage} dev fused MRR LCB ${actual.devMrrLcb} < ${floor.dev.fusedMrrLcb}`]
      : []),
    ...(actual.heldoutMrrLcb < floor.heldout.fusedMrrLcb
      ? [
          `real bench ${coverage} heldout fused MRR LCB ${actual.heldoutMrrLcb} < ${floor.heldout.fusedMrrLcb}`,
        ]
      : []),
    ...(actual.negative === undefined
      ? [`real bench ${coverage} negative result is missing`]
      : actual.negative < floor.negative.expected_abstention_rate
        ? [
            `real bench ${coverage} negative abstention ${actual.negative} < ${floor.negative.expected_abstention_rate}`,
          ]
        : []),
  ];
}

function realPaperRank(
  recommendations: VenueRecommendation[],
  acceptable: ReadonlySet<string>,
): number | null {
  const index = recommendations.findIndex((recommendation) =>
    acceptable.has(recommendation.venueKey),
  );
  return index < 0 ? null : index + 1;
}

export async function realPaperEmbeddingBundles(
  confs: Conf[],
  catNames: Record<string, string>,
  years: { dev: number; heldout: number },
  frozen: boolean,
  builder: typeof buildBenchmarkEmbeddingBundle = buildBenchmarkEmbeddingBundle,
): Promise<Record<"dev" | "heldout", BenchmarkEmbeddingBundle>> {
  const empty = (manifest: BenchmarkEmbeddingManifest): BenchmarkEmbeddingBundle => ({
    manifest,
    embeddings: {},
    multi: { embeddings: {} },
    paperVecs: {},
  });
  if (frozen)
    return {
      dev: empty(benchmarkEmbeddingManifestAtCutoff(years.dev)),
      heldout: empty(benchmarkEmbeddingManifestAtCutoff(years.heldout)),
    };
  return {
    dev: await builder(confs, catNames, years.dev),
    heldout: await builder(confs, catNames, years.heldout),
  };
}

export async function runRealPaperBenchmark(
  dev: RealPaperFixture,
  heldout: RealPaperFixture,
  data: { conferences: Conf[]; categories?: Record<string, string> },
  negative?: RealPaperNegativeFixture,
  coverage: "full" | "required" = "full",
  requiredFeatures?: RequiredSemanticFeatures,
  collectedFeatures?: RequiredSemanticFeatures["records"],
): Promise<RealPaperRun> {
  const confs = data.conferences ?? [];
  const venueKeys = new Set(confs.map((conference) => conference.key));
  validateRealPaperFixtures(
    dev,
    heldout,
    venueKeys,
    VENUE_PROFILE_ARTIFACT,
    REGRESSION_KNOWN.records,
    negative,
    coverage,
  );
  const records = [...dev.records, ...heldout.records, ...(negative?.records ?? [])];
  const usedLanguages = [...new Set(records.map((record) => record.language))].sort();
  const useFrozenFeatures = coverage === "required" && requiredFeatures !== undefined;
  if (useFrozenFeatures) validateRequiredLanguageCounts(requiredFeatures, [dev, heldout]);
  const modelFor = (
    language: RealPaperLanguage,
  ): { model: string; revision: string; key: string } =>
    language === "ja"
      ? { model: EMBEDDING_MULTI_MODEL, revision: EMBEDDING_MULTI_REVISION, key: "multi" }
      : { model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION, key: "en" };
  const extractors = new Map<RealPaperLanguage, FeatureExtractionPipeline>();
  const loadStart = performance.now();
  const catNames = data.categories ?? {};
  const benchmarkEmbeddings = await realPaperEmbeddingBundles(
    confs,
    catNames,
    { dev: dev.profile_year_max, heldout: heldout.profile_year_max },
    useFrozenFeatures,
  );
  for (const language of useFrozenFeatures ? [] : usedLanguages) {
    const model = modelFor(language);
    extractors.set(
      language,
      (await pipeline("feature-extraction", model.model, {
        revision: model.revision,
      })) as FeatureExtractionPipeline,
    );
  }
  const firstLoadMs = Number((performance.now() - loadStart).toFixed(2));
  const vectors = new Map<string, number[]>();
  for (const language of useFrozenFeatures ? [] : usedLanguages) {
    const group = records.filter((record) => record.language === language);
    const extractor = extractors.get(language)!;
    const output = await extractor(
      group.map((record) =>
        `${record.title} ${"pdf_text" in record ? (record.pdf_text ?? record.abstract ?? "") : (record.abstract ?? "")}`.trim(),
      ),
      { pooling: "mean", normalize: true },
    );
    const tensors = Array.isArray(output) ? output : [output];
    let index = 0;
    for (const tensor of tensors) {
      const count = tensor.dims[0] ?? 1;
      const width = tensor.dims[1] ?? 384;
      const values = Array.from(tensor.data as Float32Array | ArrayLike<number>);
      for (let row = 0; row < count; row++) {
        const record = group[index++];
        if (!record) throw new Error(`real paper embedding count mismatch for ${language}`);
        vectors.set(record.paper_id, values.slice(row * width, (row + 1) * width));
      }
    }
    if (index !== group.length)
      throw new Error(`real paper embedding count mismatch for ${language}`);
  }

  Recommender.setExpandEnabled(true);
  const rowsFor = (sourceYearMax: number) => {
    const papers = profileTitlesBefore(VENUE_PROFILE_ARTIFACT, sourceYearMax);
    return confs.map((conference) => ({
      conf: {
        key: conference.key,
        title: conference.title,
        full_name: conference.full_name,
        tags: conference.tags ?? [],
        papers: papers[conference.key] ?? [],
      },
      cats: conference.categories ?? [],
      kind: "paper",
      t: Date.UTC(2099, 0, 1),
      tLast: Date.UTC(2099, 0, 1),
      est: false,
    }));
  };
  const recommend = (
    record: RealPaperRecord | RealPaperNegativeRecord,
    rows: ReturnType<typeof rowsFor>,
    bundle: (typeof benchmarkEmbeddings)["dev"],
    split: "dev" | "heldout" | "negative",
  ): {
    rankings: RealPaperRanks;
    confidence: string;
    probability: { top1: number; top5: number };
    failure: FailureClassification;
    candidateKeys: Set<string>;
  } => {
    const vector = vectors.get(record.paper_id);
    if (!useFrozenFeatures && !vector)
      throw new Error(`real paper vector missing: ${record.paper_id}`);
    Recommender.setPaperVecs(
      !useFrozenFeatures && record.language === "en" ? bundle.paperVecs : null,
    );
    const lines = Recommender.parsePaperLines(
      JSON.stringify([
        {
          title: record.title,
          abstract:
            "pdf_text" in record
              ? (record.pdf_text ?? record.abstract ?? "")
              : (record.abstract ?? ""),
          keywords: "",
          venue: "",
        },
      ]),
    );
    const inferredSemanticScores = useFrozenFeatures
      ? {}
      : Object.fromEntries(
          confs.map((conference) => [
            conference.key,
            Recommender.semanticScore(
              conference.key,
              vector!,
              record.language === "ja" ? bundle.multi.embeddings : bundle.embeddings,
            ),
          ]),
        );
    const fixed = useFrozenFeatures
      ? fixedFeatureRecord(requiredFeatures, record.paper_id, bundle.manifest, split)
      : null;
    const semanticScores = fixed?.semantic_scores ?? inferredSemanticScores;
    const recommendations = Recommender.venueRecommendations(
      rows,
      lines,
      semanticScores,
      Date.UTC(record.year, 0, 1),
      { topN: rows.length, venueCats: Recommender.autoDetectCats(lines) },
    ) as VenueRecommendation[];
    const candidateFeatures = recommendations
      .map((recommendation) => ({
        venue: recommendation.venueKey,
        base_score: recommendation.fit.baseScore,
        features: recommendation.fit.rerankerFeatures,
      }))
      .sort((left, right) => left.venue.localeCompare(right.venue));
    if (fixed && JSON.stringify(fixed.candidates) !== JSON.stringify(candidateFeatures))
      throw new Error(`required production feature mismatch: ${record.paper_id}`);
    if (collectedFeatures)
      collectedFeatures.push({
        paper_id: record.paper_id,
        record_sha256: requiredRecordHash({
          paper_id: record.paper_id,
          semantic_scores: inferredSemanticScores,
          candidates: candidateFeatures,
        }),
        semantic_scores: inferredSemanticScores,
        candidates: candidateFeatures,
      });
    const acceptable = new Set("acceptable_venues" in record ? record.acceptable_venues : []);
    const lexical = recommendations
      .filter((recommendation) => recommendation.fit.lexicalScore > 0)
      .sort(
        (left, right) =>
          right.fit.lexicalScore - left.fit.lexicalScore ||
          left.venueKey.localeCompare(right.venueKey),
      );
    const semantic = recommendations
      .filter((recommendation) => recommendation.fit.semanticScore > 0)
      .sort(
        (left, right) =>
          right.fit.semanticScore - left.fit.semanticScore ||
          left.venueKey.localeCompare(right.venueKey),
      );
    const lexicalRank = realPaperRank(lexical, acceptable);
    const semanticRank = realPaperRank(semantic, acceptable);
    const fusedRank = realPaperRank(recommendations, acceptable);
    const conf = String(recommendations[0]?.fit.confidence ?? "insufficient");
    const candidateKeySet = new Set(recommendations.map((r) => r.venueKey));
    return {
      rankings: {
        lexical: lexicalRank,
        semantic: semanticRank,
        fused: fusedRank,
      },
      confidence: conf,
      probability: {
        top1: recommendations[0]?.fit.probability ?? 0,
        top5: Math.max(0, ...recommendations.slice(0, 5).map((item) => item.fit.probability)),
      },
      failure: classifyFailure(
        lexicalRank,
        semanticRank,
        fusedRank,
        acceptable,
        candidateKeySet,
        conf,
      ),
      candidateKeys: candidateKeySet,
    };
  };
  const evaluate = (
    fixture: Pick<RealPaperFixture, "records" | "profile_year_max"> | RealPaperNegativeFixture,
    bundle: (typeof benchmarkEmbeddings)["dev"],
    split: "dev" | "heldout" | "negative",
  ): {
    rankings: Record<string, RealPaperRanks>;
    confidence: Record<string, string>;
    probability: Record<string, { top1: number; top5: number }>;
    failures: Record<string, FailureClassification>;
  } => {
    const rankings: Record<string, RealPaperRanks> = {};
    const confidence: Record<string, string> = {};
    const probability: Record<string, { top1: number; top5: number }> = {};
    const failures: Record<string, FailureClassification> = {};
    const rows = rowsFor(fixture.profile_year_max);
    Recommender.setNameIdf(Recommender.buildNameIdf(rows.map((row) => row.conf)));
    for (const record of fixture.records) {
      const evaluation = recommend(record, rows, bundle, split);
      rankings[record.paper_id] = evaluation.rankings;
      confidence[record.paper_id] = evaluation.confidence;
      probability[record.paper_id] = evaluation.probability;
      failures[record.paper_id] = evaluation.failure;
    }
    return { rankings, confidence, probability, failures };
  };
  Recommender.setReranker(
    JSON.parse(readFileSync(new URL("../data/recommender-reranker.json", import.meta.url), "utf8")),
  );
  try {
    const evaluations = {
      dev: evaluate(dev, benchmarkEmbeddings.dev, "dev"),
      heldout: evaluate(heldout, benchmarkEmbeddings.heldout, "heldout"),
      ...(negative
        ? { negative: evaluate(negative, benchmarkEmbeddings.heldout, "negative") }
        : {}),
    };
    const repeatStart = performance.now();
    const repeatRows = rowsFor(dev.profile_year_max);
    Recommender.setNameIdf(Recommender.buildNameIdf(repeatRows.map((row) => row.conf)));
    if (dev.records[0]) recommend(dev.records[0], repeatRows, benchmarkEmbeddings.dev, "dev");
    const repeatRecommendationMs = Number((performance.now() - repeatStart).toFixed(2));
    return {
      result: buildRealPaperResult(
        dev,
        heldout,
        evaluations,
        {
          dev: benchmarkEmbeddings.dev.manifest,
          heldout: benchmarkEmbeddings.heldout.manifest,
        },
        negative,
        coverage,
      ),
      timing: { firstLoadMs, repeatRecommendationMs },
    };
  } finally {
    Recommender.setNameIdf(null);
    Recommender.setPaperVecs(null);
    Recommender.setReranker(null);
  }
}

export function norm(s: string | null | undefined): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function contentWords(s: string | null | undefined): string[] {
  return norm(s)
    .split(" ")
    .filter((w) => w.length > 3 && !STOP.has(w));
}

/** メタデータタグ（本文語彙として検索されない属性語）。
 * スコアリング側の GENERIC_TAGS 除外と対にした。
 * 合成クエリが workshop/journal を含むと、
 * 自己マッチの +10 で「除外がマイナス」という見かけの差が出るため、クエリ側も除く。 */
export const GENERIC_TAGS = new Set([
  "niche",
  "workshop",
  "domestic-jp",
  "journal",
  "special-issue",
  "niche-jp",
]);

/** 会議のトピック語（実論文が使う語彙を模す）: トピックタグ + カテゴリ正式名の内容語 + full_name の内容語 */
export function topicWords(
  c: Conf | null | undefined,
  catFull?: Record<string, string> | null,
): string[] {
  if (!c || typeof c !== "object") return [];
  const words: string[] = [];
  const seen = new Set<string>();
  const safeCatFull = catFull ?? {};
  const add = (w: string): void => {
    w = w.toLowerCase();
    if (w.length > 3 && !STOP.has(w) && !seen.has(w)) {
      seen.add(w);
      words.push(w);
    }
  };
  toStringArray(c.tags)
    .filter((t) => !GENERIC_TAGS.has(t))
    .forEach(add);
  toStringArray(c.categories).forEach((k) => {
    contentWords(safeCatFull[k] ?? k).forEach(add);
  });
  contentWords(c.full_name ?? c.title ?? "")
    .slice(0, 6)
    .forEach(add);
  return words.slice(0, 10);
}

/** 会議名に現れる汎用的な日本語（どの会議にも出る）は、日本語クエリの識別語にしない */
const JP_STOP = new Set([
  "情報処理学会",
  "電子情報通信学会",
  "研究会",
  "特集号",
  "シンポジウム",
  "論文誌",
  "学会",
  "信学技報",
  "電子情報通信", // IEEE 相当の組織プレフィックス
  "情報処理", // IPSJ 相当（全 IPSJ 会議に出る）
]);

/** 実ユーザーが入力しそうな日本語論文（タイトル + キーワード）→ 正解会議。
 * 正解は「そのトピックで最も自然な投稿先」。国内研究会は対応する国際会議が無い
 * トピックなので曖昧性が低い。国際会議は分野が明確なものだけ採用する。
 * キーワードは日英混在（実ユーザーの入力パターン）と日本語のみの両方を含む。 */
const GOLDEN_JP: Array<{ title: string; keywords: string; key: string }> = [
  // 分散・並列処理（DPS 研）
  {
    title: "分散システムにおける複製管理とコンセンサスプロトコルの設計",
    keywords: "分散処理, レプリケーション, コンセンサス, 耐故障性",
    key: "ipsj-sigdps",
  },
  {
    title: "モバイルエッジ環境向け低遅延ミドルウェアの実装と評価",
    keywords: "エッジ, 低遅延, ミドルウェア",
    key: "ipsj-sigdps",
  },
  // OS（OS 研）
  {
    title: "Linux カーネル向け省電力スケジューラの実装と評価",
    keywords: "カーネル, スケジューリング, 省電力",
    key: "ipsj-sigos",
  },
  {
    title: "コンテナ環境におけるメモリ管理のオーバーヘッド解析",
    keywords: "コンテナ, メモリ, 仮想化",
    key: "ipsj-sigos",
  },
  // HPC（HPC 研）
  {
    title: "GPU クラスタ向け集団通信ライブラリの性能最適化",
    keywords: "GPU, 並列, 集団通信, MPI",
    key: "ipsj-sighpc",
  },
  {
    title: "大規模数値シミュレーションの通信特性の解析",
    keywords: "スーパーコンピュータ, 並列, シミュレーション",
    key: "ipsj-sighpc",
  },
  // ネットワーク（NS/IN 研）
  {
    title: "サービスメッシュにおけるトラフィック制御の検証",
    keywords: "ネットワーク, トラフィック, SDN",
    key: "ieice-ns",
  },
  {
    title: "5G コアネットワークにおけるスライシング資源配分",
    keywords: "ネットワーク, スライシング, 資源配分",
    key: "ieice-in",
  },
  // 通信品質（CQ 研）
  {
    title: "ウェブサービスにおけるユーザ体感品質の測定手法",
    keywords: "通信品質, 体感品質, 遅延",
    key: "ieice-cq",
  },
  {
    title: "車載ネットワークにおけるリアルタイム通信の品質評価",
    keywords: "通信, 品質, 車載",
    key: "ieice-cq",
  },
  // コンピュータシステム（ComSys）
  {
    title: "自律分散コンピュータシステムの構成管理手法",
    keywords: "分散システム, 構成管理, 自律",
    key: "comsys",
  },
  // アーキテクチャ（ARC 研）
  {
    title: "キャッシュコヒーレンシのためのマイクロアーキテクチャ設計",
    keywords: "キャッシュ, コヒーレンシ, アーキテクチャ",
    key: "ipsj-sigarc",
  },
  // 通信マネジメント（ICM 研）
  {
    title: "エッジコンピューティング基盤の運用管理の自動化",
    keywords: "エッジ, 運用管理, 自動化",
    key: "ieice-icm",
  },
  // IPSJ 特集号
  {
    title: "超知能と社会システムの共進化に関する考察",
    keywords: "超知能, 社会システム, AI",
    key: "ipsj-27-l-superintelligence",
  },
  {
    title: "AI 時代の社会基盤を支えるコンピュータセキュリティ技術",
    keywords: "セキュリティ, 社会基盤, コンピュータセキュリティ",
    key: "ipsj-27-m-security",
  },
  // 国際会議（分野が明確なもの）
  {
    title: "NVMe SSD 向けログ構造化ストレージの設計と実装",
    keywords: "nvme, ssd, log-structured, storage",
    key: "fast",
  },
  {
    title: "リアルタイムシステムにおける分散共有資源のスケジューリング",
    keywords: "real-time, scheduling, resource",
    key: "rtss",
  },
  {
    title: "SGX エンクレーブにおける機械学習推論の保護",
    keywords: "sgx, enclave, machine learning, privacy",
    key: "s-p",
  },
  {
    title: "データセンターネットワークにおける輻輳制御の設計",
    keywords: "datacenter, congestion control, network",
    key: "nsdi",
  },
  // 国内: 電子情報通信学会 特集号・その他研究会
  {
    title: "ミリ波帯無線フロントエンド向けマイクロ波回路の設計",
    keywords: "マイクロ波, ミリ波, 無線, 回路",
    key: "ieice-electron-microwave-special",
  },
  {
    title: "グラフ彩色数とその応用に関する離散数学的考察",
    keywords: "離散数学, グラフ, 彩色, 応用",
    key: "ieice-fundamentals-discrete-math-special",
  },
  {
    title: "オフィス情報システムにおけるログデータ活用の基盤技術",
    keywords: "ログデータ, 活用技術, オフィス情報",
    key: "ieice-inf-syst-log-data-special",
  },
  {
    title: "非線形力学系のカオス解析とその工学応用",
    keywords: "非線形理論, カオス, 力学系, 応用",
    key: "ieice-nolta-recent-advances-special",
  },
  {
    title: "大規模ネットワークの経路制御プロトコルの評価手法",
    keywords: "ネットワーク, 経路制御, プロトコル, 評価",
    key: "ieice-in",
  },
  // 国内: 情報処理学会 論文誌特集号・大会
  {
    title: "情報システムの要件定義プロセスの改善手法",
    keywords: "情報システム, 要件定義, プロセス",
    key: "ipsj-27-n-info-systems",
  },
  {
    title: "ユビキタス環境におけるコンテキスト認識基盤の設計",
    keywords: "ユビキタス, コンテキスト, 認識, 基盤",
    key: "ipsj-27-p-ubiquitous",
  },
  {
    title: "Web アプリケーションのアクセシビリティ評価フレームワーク",
    keywords: "Web, アプリケーション, アクセシビリティ, 評価",
    key: "ipsj-27-r-compsac",
  },
  {
    title: "情報処理分野における近年の研究動向のサーベイ",
    keywords: "サーベイ, 情報処理, 研究動向",
    key: "jip",
  },
  {
    title: "情報科学技術フォーラムにおけるセッション報告と考察",
    keywords: "情報科学技術, フォーラム, セッション",
    key: "fit",
  },
  {
    title: "インターネットサービスの運用自動化と障害対応の実践",
    keywords: "インターネット, 運用技術, 自動化, 障害対応",
    key: "iots",
  },
  // 国内: 既存研究会の別トピック
  {
    title: "リアルタイム OS のメモリ保護機構の実装と評価",
    keywords: "リアルタイム, OS, メモリ保護, カーネル",
    key: "ipsj-sigos",
  },
  {
    title: "分散システムにおけるコンセンサスアルゴリズムの実装比較",
    keywords: "分散システム, コンセンサス, 実装, 比較",
    key: "comsys",
  },
  {
    title: "低遅延ストリーミングにおける体感品質と通信品質の相関分析",
    keywords: "低遅延, ストリーミング, 体感品質, 通信品質",
    key: "ieice-cq",
  },
  // 国際: 分野が明確な追加
  {
    title: "NVMe オーバーファブリックにおける RDMA 転送の性能解析",
    keywords: "nvme, rdma, fabric, storage",
    key: "fast",
  },
  {
    title: "Time-Sensitive Networking のスケジューラ実装と評価",
    keywords: "tsn, scheduling, real-time, ethernet",
    key: "rtss",
  },
];

/** regression-known（実採択論文タイトル、タイトルのみで測定）: 合成クエリは会議名の内容語から
 * 作るため実論文より易しい。こちらは会議名チャンクを含まない実際の論文タイトルで
 * 真の精度を測る。出典: USENIX NSDI/OSDI '25 technical sessions、
 * SOSP '25 accepted (sigops.org)、NDSS '25 accepted、ICML (PMLR v162)。 */
export interface RegressionKnownRecord {
  title: string;
  key: string;
}

export interface RegressionKnownFixture {
  version: 1;
  purpose: "regression-known";
  records: RegressionKnownRecord[];
}

export const REGRESSION_KNOWN = JSON.parse(
  readFileSync(new URL("../data/benchmarks/regression-known.json", import.meta.url), "utf8"),
) as RegressionKnownFixture;

const REGRESSION_EN = REGRESSION_KNOWN.records;

/** 会議名から日本語の内容チャンクを取り出す（実論文が使う日本語語彙を模す）。
 * 助詞（と/の/を 等）で分割し、末尾の汎用語（研究会/システム 等）を落とす。 */
function jpChunks(s: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of String(s ?? "").match(/[\u3000-\u9fff]{2,}/g) ?? []) {
    for (let part of m.split(/[ともの・、／()（）]/)) {
      part = part.replace(
        /(学会|研究会|シンポジウム|特集号|論文誌|大会|フォーラム|技術|報告|システム|コンピュータ|処理)$/,
        "",
      );
      part = part.trim();
      if (part.length < 2 || JP_STOP.has(part) || seen.has(part)) continue;
      // ひらがな主体の文法的断片（例: 「共に革新する」）は捨てる
      if (/[ぁ-ん]{3,}/.test(part) && !/[\u4e00-\u9fff]/.test(part)) continue;
      seen.add(part);
      out.push(part);
    }
  }
  return out.slice(0, 10);
}

export async function main(
  argv: string[] | null | undefined = process.argv.slice(2),
): Promise<number> {
  const rawArgs = Array.isArray(argv) ? argv : [];
  if (rawArgs.includes("--help") || rawArgs.includes("-h") || rawArgs.includes("help")) {
    console.log(
      "usage: node src/bench-recommender.ts [--data <path>] [--emb <path>] [--v2 <fixture>] [--real-v2-dev <fixture>] [--real-v2-heldout <fixture>] [--real-v2-negative <fixture>] [--real-v2-small] [--samples <n>] [--failures <n>] [--topk <n>] [--lang <en|jp>] [--golden-en] [--no-idf]",
    );
    return 0;
  }
  const args = parseBenchArgs(rawArgs);
  if (args.dataDelta) {
    try {
      const fixture = JSON.parse(readFileSync(args.dataDelta, "utf8")) as DataDeltaFixture;
      const withIndexes =
        args.dataDeltaBefore && args.dataDeltaAfter
          ? dataDeltaWithIndexes(
              fixture,
              JSON.parse(readFileSync(args.dataDeltaBefore, "utf8")),
              JSON.parse(readFileSync(args.dataDeltaAfter, "utf8")),
            )
          : fixture;
      const result = runDataDeltaBenchmark(withIndexes);
      process.stdout.write(`${JSON.stringify(result, null, args.json ? 0 : 2)}\n`);
      const regressions = dataDeltaRegressionReasons(withIndexes, result);
      if (regressions.length === 0) return 0;
      process.stderr.write(`${regressions.join("\n")}\n`);
      return 1;
    } catch (error) {
      process.stderr.write(
        `data-delta benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
  }
  if (args.json && !args.v2 && rawArgs.length === 1) {
    try {
      const fixture = JSON.parse(
        readFileSync(new URL("../tests/fixtures/bench-v2.json", import.meta.url), "utf8"),
      ) as BenchV2Fixture;
      const fused = runBenchmarkV2(fixture).splits.heldout.modes.fused;
      process.stdout.write(
        `${JSON.stringify({
          recall_at_1: fused["recall@1"],
          recall_at_5: fused["recall@5"],
          mrr: fused.mrr,
          ndcg_at_10: fused["ndcg@10"],
          abstention_rate: 1 - fused.coverage,
          changed_top_5_queries: [],
          new_top_5_venues: [],
          expected_venues_falling_out: [],
        })}\n`,
      );
      return 0;
    } catch (error) {
      process.stderr.write(`recommendation benchmark failed: ${String(error)}\n`);
      return 1;
    }
  }
  if (args.v2) {
    try {
      const fixture = JSON.parse(readFileSync(args.v2, "utf8")) as BenchV2Fixture;
      const result = runBenchmarkV2(fixture);
      console.log(JSON.stringify(result, null, 2));
      const regressions = benchV2RequiredRegressionReasons(result);
      if (regressions.length === 0) return 0;
      process.stderr.write(`${regressions.join("\n")}\n`);
      return 1;
    } catch (error) {
      process.stderr.write(
        `bench v2 failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
  }
  if (args.realV2Small || args.realV2Dev || args.realV2Heldout) {
    if (!args.realV2Small && (!args.realV2Dev || !args.realV2Heldout)) {
      process.stderr.write("real bench requires --real-v2-dev and --real-v2-heldout together\n");
      return 1;
    }
    try {
      const defaultFixture = (name: string) =>
        new URL(`../data/benchmarks/${name}`, import.meta.url);
      const dev = JSON.parse(
        readFileSync(
          args.realV2Dev ??
            defaultFixture(
              args.realV2Small ? "real-paper-required-dev.json" : "real-paper-dev.json",
            ),
          "utf8",
        ),
      ) as RealPaperFixture;
      const heldout = JSON.parse(
        readFileSync(
          args.realV2Heldout ??
            defaultFixture(
              args.realV2Small ? "real-paper-required-heldout.json" : "real-paper-heldout.json",
            ),
          "utf8",
        ),
      ) as RealPaperFixture;
      const negative = JSON.parse(
        readFileSync(args.realV2Negative ?? defaultFixture("real-paper-negative.json"), "utf8"),
      ) as RealPaperNegativeFixture;
      const data = JSON.parse(readFileSync(args.data, "utf8")) as {
        conferences: Conf[];
        categories?: Record<string, string>;
      };
      const requiredFeatures = args.realV2Features
        ? (JSON.parse(readFileSync(args.realV2Features, "utf8")) as RequiredSemanticFeatures)
        : undefined;
      const collectedFeatures: RequiredSemanticFeatures["records"] = [];
      const run = await runRealPaperBenchmark(
        dev,
        heldout,
        data,
        negative,
        args.realV2Small ? "required" : "full",
        requiredFeatures,
        args.writeRequiredFeatures ? collectedFeatures : undefined,
      );
      if (args.writeRequiredFeatures) {
        const benchmarkProfiles = run.result.benchmark_embeddings;
        if (!benchmarkProfiles) throw new Error("benchmark embedding manifests are missing");
        const profiles = { ...benchmarkProfiles, negative: benchmarkProfiles.heldout };
        writeFileSync(
          args.writeRequiredFeatures,
          `${JSON.stringify(
            {
              version: 1,
              feature_schema: [...Recommender.RERANKER_FEATURE_SCHEMA],
              minimum_language_counts: {
                dev: { en: 8, ja: 1 },
                heldout: { en: 9, ja: 1 },
              },
              provenance: {
                generator: "src/bench-recommender.ts",
                model: EMBEDDING_MODEL,
                revision: EMBEDDING_REVISION,
                runtime: process.version,
              },
              profiles,
              records: [
                ...new Map(
                  collectedFeatures.map((record) => [record.paper_id, record] as const),
                ).values(),
              ].sort((a, b) => a.paper_id.localeCompare(b.paper_id)),
            } satisfies RequiredSemanticFeatures,
            null,
            2,
          )}\n`,
        );
      }
      console.log(JSON.stringify(run.result, null, 2));
      process.stderr.write(
        `real-bench: dev=${run.result.splits.dev.queries} heldout=${run.result.splits.heldout.queries} negative=${run.result.splits.negative?.queries ?? 0} ` +
          `first_load_ms=${run.timing.firstLoadMs} repeat_recommendation_ms=${run.timing.repeatRecommendationMs}\n`,
      );
      const regressions = realPaperRegressionReasons(
        run.result,
        args.realV2Small ? "required" : "full",
      );
      if (regressions.length === 0) return 0;
      process.stderr.write(`${regressions.join("\n")}\n`);
      return 1;
    } catch (error) {
      process.stderr.write(
        `real bench failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
  }
  let dataRaw: string;
  let embRaw: string;
  try {
    dataRaw = readFileSync(args.data, "utf8");
  } catch {
    process.stderr.write(`data not found: ${args.data}\n`);
    return 1;
  }
  try {
    embRaw = readFileSync(args.emb, "utf8");
  } catch {
    process.stderr.write(`embeddings not found: ${args.emb}\n`);
    return 1;
  }
  const data = JSON.parse(dataRaw) as {
    conferences: Conf[];
    categories?: Record<string, string>;
  };
  const emb = JSON.parse(embRaw) as {
    embeddings: Record<string, number[]>;
    multi?: { embeddings: Record<string, number[]> };
    paperVecs?: Record<string, number[][]>;
  };
  const catFull = (data.categories ?? {}) as Record<string, string>;
  const confs = data.conferences;

  const isJp = args.lang === "jp";
  // golden EN モード: 実採択論文タイトル（タイトルのみ）で真の精度を測る。
  // 複数エントリが同じ会議キーを持つため、クエリ識別子（qid）で一意化する。
  const queries: BenchQuery[] = args.goldenEn
    ? REGRESSION_EN.map((g, i) => ({ key: g.key, qid: `g${i}`, tw: [g.title], golden: true }))
    : isJp
      ? confs
          .map((c) => ({ key: c.key, tw: jpChunks(`${c.title} ${c.full_name}`), conf: c }))
          .filter((q) => q.tw.length >= 2)
      : confs
          .map((c) => ({ key: c.key, tw: topicWords(c, catFull), conf: c }))
          .filter((q) => q.tw.length >= 3);
  let selected = queries;
  if (args.samples > 0 && args.samples < selected.length) {
    // 決定論的にサンプリング（seed 固定）して再現可能にする
    const step = Math.floor(selected.length / args.samples);
    selected = selected.filter((_, i) => i % step === 0).slice(0, args.samples);
  }
  const model = isJp ? EMBEDDING_MULTI_MODEL : EMBEDDING_MODEL;
  const venueEmb = isJp ? (emb.multi?.embeddings ?? emb.embeddings) : emb.embeddings;

  // --idf: 会議名 + 代表論文語彙の IDF 重み表（希少語ほど重い）。
  // 代表論文語彙は汎用語（machine/deep/cache 等）が全会議に出現しやすく、
  // そのまま語彙一致に使うと会議間で衝突するため、df で汎用語を減衰する。
  // 名前と papers の混在 df だと、papers 追加（rtss/ecrts）で名前語の IDF が薄まり
  // 合成 top1 84.8→76.9 に悪化する。
  // 名前優先 1 マップだと、名前にも出る語（memory 等）が papers マッチでも高重みになり、
  // rtss/ecrts の papers 語彙が無関係クエリを奪う。
  // マッチ元ごとに別マップを使う。
  // buildNameIdf（recommender.js）と同じ定義。
  if (args.idf) {
    const nameDf = new Map<string, number>();
    const paperDf = new Map<string, number>();
    const bump = (m: Map<string, number>, w: string): void => {
      m.set(w, (m.get(w) ?? 0) + 1);
    };
    for (const c of confs) {
      const seenName = new Set<string>();
      for (const w of contentWords(`${c.title ?? ""} ${c.full_name ?? ""}`)) {
        if (!seenName.has(w)) {
          seenName.add(w);
          bump(nameDf, w);
        }
      }
      const seenPaper = new Set<string>();
      for (const w of contentWords((VENUE_PAPERS[c.key] ?? []).join(" "))) {
        // paper 語彙の汎用語（self/general/framework 等）はスコアリングで加点されないので df にも数えない。
        if (GEN_PAPER.has(w)) continue;
        if (!seenPaper.has(w)) {
          seenPaper.add(w);
          bump(paperDf, w);
        }
      }
    }
    const N = confs.length;
    const idfOf = (d: number): number => Math.log(1 + N / (d + 1)) / Math.log(1 + N);
    const mk = (m: Map<string, number>): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const [w, d] of m) out[w] = idfOf(d);
      return out;
    };
    Recommender.setNameIdf({ name: mk(nameDf), paper: mk(paperDf) });
  }
  // 英語クエリのみ論文個別ベクトル（max 類似度）を有効化。
  // 日本語クエリは多言語モデルなので英語モデルの論文ベクトルを混ぜない
  // （言語別分離設計）。
  if (args.paperMax && !isJp && emb.paperVecs) {
    Recommender.setPaperVecs(emb.paperVecs);
  } else {
    Recommender.setPaperVecs(null);
  }
  const scheme = args.wGiven
    ? `score = vocab×${args.jpw} + sem×${(1 - args.jpw).toFixed(2)}`
    : args.goldenEn
      ? "score = adaptive (実論文タイトル, vocab×vocabWeight(len))"
      : isJp
        ? `score = vocab×${args.jpw} + sem×${(1 - args.jpw).toFixed(2)} (日本語: 0.6 固定)`
        : "score = adaptive (vocab×vocabWeight(len), 内容語数で 0.25/0.4)";
  const sigNote = args.sw ? ` sigWeights=[${args.sw}]` : "";
  const pmNote = args.paperMax ? " paperMax=on" : "";
  console.log(
    `bench: ${selected.length} conferences, lang=${args.lang}, model=${model}, topK=${args.topK} (${scheme}${sigNote}${pmNote})`,
  );

  // クエリを埋め込む（embeddings.ts と同じ呼び出し方）
  const embed = async (): Promise<Map<string, number[]>> => {
    const extractor = (await pipeline("feature-extraction", model)) as FeatureExtractionPipeline;
    const out = new Map<string, number[]>();
    const batch = 64;
    for (let i = 0; i < selected.length; i += batch) {
      const texts = selected.slice(i, i + batch).map((q) => q.tw.join(" "));
      const output = await extractor(texts, { pooling: "mean", normalize: true });
      const tensors = Array.isArray(output) ? output : [output];
      let idx = 0;
      for (const tensor of tensors) {
        const n = tensor.dims[0] ?? 1;
        const w = tensor.dims[1] ?? 384;
        const arr = Array.from(tensor.data as Float32Array | ArrayLike<number>);
        for (let j = 0; j < n; j++) {
          out.set(selected[i + idx]!.qid ?? selected[i + idx]!.key, arr.slice(j * w, (j + 1) * w));
          idx++;
        }
      }
    }
    return out;
  };

  // 本番と同じスコアリング: Recommender.breakdown（語彙）+ semanticScore + blendScore
  const rowFor = (c: Conf): Record<string, unknown> => ({
    conf: {
      key: c.key,
      title: c.title,
      full_name: c.full_name,
      tags: c.tags ?? [],
      // 代表論文語彙（embedding 側の VENUE_PAPERS と同じ出典）— 語彙一致にも効かせる。
      // 本番ではデータパイプラインが conferences に papers を載せる。
      // 無い場合は空として扱う。
      papers: VENUE_PAPERS[c.key] ?? [],
    },
    cats: c.categories ?? [],
  });
  const lines = (tw: string[], golden?: boolean): PaperLine[] =>
    golden
      ? [{ title: tw.join(" "), keywords: "", venue: "" }]
      : [{ title: "", keywords: tw.join(" "), venue: "" }];

  const queryVec = await embed();
  const runSynthetic = (
    expand: boolean,
  ): {
    hits: { top1: number; top5: number; top10: number };
    failures: Array<{ rank: number; key: string; title: string; top: string[] }>;
  } => {
    Recommender.setExpandEnabled(expand);
    const hits = { top1: 0, top5: 0, top10: 0 };
    const failures: Array<{ rank: number; key: string; title: string; top: string[] }> = [];
    for (const q of selected) {
      const scored: Array<[string, number]> = [];
      const qv = queryVec.get(q.qid ?? q.key);
      for (const c of confs) {
        const vocab = Recommender.breakdown(rowFor(c), lines(q.tw, q.golden)).score as number;
        const semRaw = qv ? (Recommender.semanticScore(c.key, qv, venueEmb) as number) : 0;
        // --penalty: 英語クエリで日本語名主体の会議（英語モデルの埋め込みが不正確）を減衰。
        // 研究会（sighpc 等）は英語名で正しく拾えることもあるので、特集号のみ対象にする
        // （IPSJ 特集号は英語テキストが薄くカテゴリ重心に埋まる — 誤マッチの実測元）。
        const isSpecialIssue = (c.tags ?? []).includes("special-issue");
        const sem =
          !isJp && args.penalty && isSpecialIssue
            ? Math.round(semRaw * (Recommender.englishRatio(c) as number))
            : semRaw;
        // 既定は本番と同じ適応（vocabWeight: 内容語数で 0.25/0.4、日本語 0.6）。
        // --w/--jpw 指定時は固定重み（スイープ用）
        const opts = !args.wGiven
          ? { jp: isJp, len: q.golden ? Recommender.contentWordCount(q.tw.join(" ")) : q.tw.length }
          : args.adaptive && !isJp
            ? { len: q.tw.length }
            : { jpw: args.jpw };
        scored.push([c.key, Recommender.blendScore(vocab, sem, opts) as number]);
      }
      scored.sort((a, b) => b[1] - a[1]);
      const rank = scored.findIndex((x) => x[0] === q.key) + 1;
      if (rank <= 1) hits.top1++;
      if (rank <= 5) hits.top5++;
      if (rank <= 10) hits.top10++;
      if (rank > args.topK) {
        failures.push({
          rank,
          key: q.key,
          title: q.golden ? q.tw.join(" ") : (q.conf?.title ?? q.key),
          top: scored.slice(0, 3).map((s) => `${s[0]}(${s[1]}%)`),
        });
      }
    }
    return { hits, failures };
  };
  const synthResults = isJp
    ? [true, false].map((e) => ({ e, ...runSynthetic(e) }))
    : [{ e: true, ...runSynthetic(true) }];
  for (const r of synthResults) {
    const nn = selected.length;
    const s1 = ((r.hits.top1 / nn) * 100).toFixed(1);
    const s5 = ((r.hits.top5 / nn) * 100).toFixed(1);
    const s10 = ((r.hits.top10 / nn) * 100).toFixed(1);
    console.log(
      `top1: ${s1}%  top5: ${s5}%  top10: ${s10}%  (n=${nn}${isJp ? `, expand=${r.e ? "on" : "off"}` : ""})`,
    );
    if (args.byLen && !isJp) {
      // クエリ長（語数）ごとの top1。短いクエリは語彙が疎、長いクエリは語彙が濃い
      const groups: Record<string, { n: number; top1: number }> = {};
      for (const q of selected) {
        const L = q.tw.length <= 4 ? "short(<=4)" : q.tw.length <= 7 ? "mid(5-7)" : "long(>=8)";
        groups[L] ??= { n: 0, top1: 0 };
        groups[L]!.n++;
      }
      // 再スコアして長さグループごとの top1 を集計（expand 状態を揃える）
      Recommender.setExpandEnabled(r.e);
      for (const q of selected) {
        const scored: Array<[string, number]> = [];
        const qv = queryVec.get(q.key);
        for (const c of confs) {
          const vocab = Recommender.breakdown(rowFor(c), lines(q.tw)).score as number;
          const sem = qv ? (Recommender.semanticScore(c.key, qv, venueEmb) as number) : 0;
          scored.push([c.key, Recommender.blendScore(vocab, sem, { jpw: args.jpw }) as number]);
        }
        scored.sort((a, b) => b[1] - a[1]);
        const rank = scored.findIndex((x) => x[0] === q.key) + 1;
        const L = q.tw.length <= 4 ? "short(<=4)" : q.tw.length <= 7 ? "mid(5-7)" : "long(>=8)";
        if (rank <= 1) groups[L]!.top1++;
      }
      for (const L of ["short(<=4)", "mid(5-7)", "long(>=8)"]) {
        const g = groups[L];
        if (!g || g.n === 0) continue;
        console.log(`  ${L}: top1 ${((g.top1 / g.n) * 100).toFixed(1)}% (n=${g.n})`);
      }
    }
    if (args.failures > 0 && r.failures.length > 0) {
      r.failures.sort((a, b) => a.rank - b.rank);
      console.log(
        `--- top${args.topK} 外の事例（最大 ${args.failures} 件${isJp ? `, expand=${r.e ? "on" : "off"}` : ""}） ---`,
      );
      for (const f of r.failures.slice(0, args.failures)) {
        console.log(`[${f.rank}] ${f.key} — ${f.title} | top3: ${f.top.join(", ")}`);
      }
    }
  }
  Recommender.setExpandEnabled(true);

  // ---- 日本語ゴールデンセット（実ユーザーの論文テキスト、展開の有無） ----
  if (isJp) {
    const gExtractor = (await pipeline("feature-extraction", model)) as FeatureExtractionPipeline;
    const gTexts = GOLDEN_JP.map((g) => `${g.title} ${g.keywords}`);
    const gOut = await gExtractor(gTexts, { pooling: "mean", normalize: true });
    const tensors = Array.isArray(gOut) ? gOut : [gOut];
    const gVecs: number[][] = [];
    for (const tensor of tensors) {
      const n = tensor.dims[0] ?? 1;
      const w = tensor.dims[1] ?? 384;
      const arr = Array.from(tensor.data as Float32Array | ArrayLike<number>);
      for (let j = 0; j < n; j++) gVecs.push(arr.slice(j * w, (j + 1) * w));
    }
    for (const expand of [true, false]) {
      Recommender.setExpandEnabled(expand);
      const gh = { top1: 0, top5: 0, top10: 0 };
      const gfail: Array<{ rank: number; key: string; title: string; top: string[] }> = [];
      for (let gi = 0; gi < GOLDEN_JP.length; gi++) {
        const g = GOLDEN_JP[gi]!;
        const scored: Array<[string, number]> = [];
        for (const c of confs) {
          const vocab = Recommender.breakdown(rowFor(c), [
            { title: g.title, keywords: g.keywords, venue: "" },
          ]).score as number;
          const sem = Recommender.semanticScore(c.key, gVecs[gi]!, venueEmb) as number;
          const gOpts = !args.wGiven
            ? { jp: true, len: Recommender.contentWordCount(`${g.title} ${g.keywords}`) }
            : { jp: true, jpw: args.jpw };
          scored.push([c.key, Recommender.blendScore(vocab, sem, gOpts) as number]);
        }
        scored.sort((a, b) => b[1] - a[1]);
        const rank = scored.findIndex((x) => x[0] === g.key) + 1;
        if (rank <= 1) gh.top1++;
        if (rank <= 5) gh.top5++;
        if (rank <= 10) gh.top10++;
        if (rank > args.topK) {
          gfail.push({
            rank,
            key: g.key,
            title: g.title,
            top: scored.slice(0, 3).map((s) => `${s[0]}(${s[1]}%)`),
          });
        }
      }
      const gn = GOLDEN_JP.length;
      const g1 = ((gh.top1 / gn) * 100).toFixed(1);
      const g5 = ((gh.top5 / gn) * 100).toFixed(1);
      const g10 = ((gh.top10 / gn) * 100).toFixed(1);
      console.log(
        `golden-jp (expand=${expand ? "on" : "off"}): top1: ${g1}%  top5: ${g5}%  top10: ${g10}%  (n=${gn})`,
      );
      if (args.failures > 0 && gfail.length > 0) {
        gfail.sort((a, b) => a.rank - b.rank);
        console.log(`  golden top${args.topK} 外（expand=${expand ? "on" : "off"}）:`);
        for (const f of gfail.slice(0, args.failures)) {
          console.log(`    [${f.rank}] ${f.key} — ${f.title} | top3: ${f.top.join(", ")}`);
        }
      }
    }
    Recommender.setExpandEnabled(true);
  }

  // ---- 擬似関連性フィードバック（PRF）: 掲載先タグ付きクエリ ----
  // タグ会議自身の埋め込みをクエリに 0.3 ブレンドしたとき、タグ会議が #1 になる率を測る
  if (args.prf && !isJp && emb.embeddings) {
    const prfSet = selected.slice(0, args.samples || 100).filter((q) => emb.embeddings[q.key]);
    const prfExtractor = (await pipeline("feature-extraction", model)) as FeatureExtractionPipeline;
    const prfQuery = (text: string): Promise<number[]> =>
      prfExtractor(text, { pooling: "mean", normalize: true }).then((out) => {
        const t = Array.isArray(out) ? out[0] : out;
        return Array.from(t.data as Float32Array | ArrayLike<number>);
      });
    const scoreAll = (qv: number[], q: { key: string; tw: string[] }): Array<[string, number]> => {
      const out: Array<[string, number]> = [];
      for (const c of confs) {
        const vocab = Recommender.breakdown(rowFor(c), [
          { title: q.tw.join(" "), keywords: "", venue: c.title || c.key },
        ]).score as number;
        const sem = Recommender.semanticScore(c.key, qv, venueEmb) as number;
        out.push([c.key, Recommender.blendScore(vocab, sem, { len: q.tw.length }) as number]);
      }
      out.sort((a, b) => b[1] - a[1]);
      return out;
    };
    const prfTop1 = { base: 0, blend: 0 };
    for (const q of prfSet) {
      const qv = await prfQuery(q.tw.join(" "));
      if (scoreAll(qv, q)[0]?.[0] === q.key) prfTop1.base++;
      const blended = Recommender.blendVectors(qv, emb.embeddings[q.key], 0.7) as number[];
      if (scoreAll(blended, q)[0]?.[0] === q.key) prfTop1.blend++;
    }
    const pn = prfSet.length;
    console.log(
      `prf (タグ=会議自身): #1 一致 ${((prfTop1.base / pn) * 100).toFixed(1)}% → ${((prfTop1.blend / pn) * 100).toFixed(1)}%  (n=${pn})`,
    );
  }
  return 0;
}

const isMain = Boolean(
  process.argv[1] &&
    (process.argv[1].endsWith("bench-recommender.ts") ||
      process.argv[1].endsWith("bench-recommender.js")),
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
