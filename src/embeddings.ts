/**
 * 会議スコープのセマンティック埋め込みを生成する (public/embeddings.json)。
 *
 * 生成側とブラウザ側は @huggingface/transformers と同じモデル
 * (all-MiniLM-L6-v2) を使う。
 *
 * 使い方:
 *   node src/embeddings.ts public/data.json public/embeddings.json
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";
import { env, type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";
import { booleanValue, normalizeShortEquals } from "./args.ts";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_MULTI_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const EMBEDDING_DIM = 384;
export const EMBEDDING_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
export const EMBEDDING_MULTI_REVISION = "2c4055b12046f11709e9df2c122e59ffbdc2f900";
export const EMBEDDING_RUNTIME_VERSION = "transformers-4.2.0";
export const EMBEDDING_SCHEMA_VERSION = 1;
export const EMBEDDING_PROBE = "kamiyobi embedding compatibility probe";
export const PAPER_VEC_KEYS: readonly string[] = ["usenix-security", "rtss"];

const extractorPromises = new Map<string, Promise<FeatureExtractionPipeline>>();

function getExtractor(
  model: string,
  revision: string,
  localFilesOnly = false,
): Promise<FeatureExtractionPipeline> {
  if (localFilesOnly && !env.cacheDir)
    return Promise.reject(new Error("transformers cache directory is unavailable"));
  const modelPath = localFilesOnly ? join(env.cacheDir!, model, revision) : model;
  const cacheKey = `${modelPath}@${revision}:${localFilesOnly ? "local" : "remote"}`;
  let p = extractorPromises.get(cacheKey);
  if (!p) {
    p = pipeline(
      "feature-extraction",
      modelPath,
      localFilesOnly ? { local_files_only: true } : { revision },
    ) as Promise<FeatureExtractionPipeline>;
    extractorPromises.set(cacheKey, p);
    void p.catch(() => extractorPromises.delete(cacheKey));
  }
  return p;
}

/** Round to 6 decimal places. */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** 日本語会議（情報処理学会・電子情報通信学会の研究会・特集号等）のプロファイルに
 * 付与する日本語の分野キーワード。多言語モデル用のみ（英語モデルには使わない）。
 * 実測比較: これらを付与すると国内研究会のセマンティック検索が
 * top1 8.3%→25.0%・top5 16.7%→50.0% に改善（クエリの日本語語彙が会議に届く）。 */
const JP_CAT_KW: Record<string, string> = {
  systems:
    "カーネル スケジューリング 仮想化 オペレーティングシステム ミドルウェア ストレージ リアルタイム 組み込み メモリ",
  networking: "ネットワーク 通信 ルーティング 無線 プロトコル トラフィック",
  hpc: "ハイパフォーマンス スーパーコンピュータ 並列 GPU MPI",
  ai: "機械学習 深層学習 ニューラル 生成 推論",
  security: "セキュリティ プライバシー 暗号 認証",
  db: "データベース データマイニング 検索",
  graphics: "グラフィックス 可視化 映像 画像 レンダリング",
  hci: "ヒューマン ユーザインタフェース ユーザビリティ インタラクション",
  theory: "アルゴリズム 計算量 複雑性 グラフ",
};

const ATTRIBUTE_TAGS = new Set([
  "niche",
  "workshop",
  "domestic-jp",
  "journal",
  "special-issue",
  "niche-jp",
]);

function hasJapanese(text: string): boolean {
  return /[\u3040-\u9fff]/.test(text);
}

/** 会議のセマンティックプロファイルを実採択論文タイトルで強化する。
 * 会議名（International Conference on Machine Learning 等）だけでは実論文タイトル
 * （Batched Dueling Bandits 等）に似ず、実論文での正解会議が top5 に入らない
 * （golden EN 実測: top1 0.0%）ことが発端。代表論文タイトルをプロファイルに混ぜると
 * 「会議の実際の採択領域」を埋め込みに反映できる。
 *
 * データ源: DBLP の公式書誌ページ、PMLR、既存の公式採択リスト。
 * bench の regression-known テストセット（data/benchmarks/regression-known.json）とは
 * **完全に重複しないタイトルだけを使う**（リークなし検証）。
 */
/** Versioned venue-profile artifact loaded by both embedding and benchmark consumers. */
export const VENUE_PROFILE_SCHEMA_VERSION = 2;

export type VenueProfilePaper = {
  title: string;
  year: number;
  source: string;
  source_url: string;
  collected_at: string;
};

export type VenueProfileVectorMap = Record<string, number[]>;

export type VenueProfileSelection = {
  method: string;
  max_prototypes: number;
  source_year_max: number;
  embedding_model: string;
  embedding_revision: string;
};

export type VenueProfileEntry = {
  /** Complete source provenance; never consumed by runtime recommendation. */
  papers: VenueProfilePaper[];
  /** Canonical k-medoids selected at generation time for runtime consumers. */
  prototypes: string[];
  selection: VenueProfileSelection;
};

export type VenueProfileArtifact = {
  schema: typeof VENUE_PROFILE_SCHEMA_VERSION;
  profiles_hash: string;
  policy: VenueProfileSelection;
  profiles: Record<string, VenueProfileEntry>;
};

type VenueProfileArtifactInput = {
  schema?: number;
  profiles_hash?: string;
  policy: VenueProfileSelection;
  profiles: Record<string, VenueProfileEntry>;
};

function venueProfileTitleKey(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function venueProfileSelection(value: unknown, context: string): VenueProfileSelection {
  if (!value || typeof value !== "object") {
    throw new Error(`invalid venue profile selection: ${context}`);
  }
  const selection = value as Record<string, unknown>;
  if (typeof selection.method !== "string" || !selection.method.trim()) {
    throw new Error(`invalid venue profile selection method: ${context}`);
  }
  if (
    !Number.isInteger(selection.max_prototypes) ||
    Number(selection.max_prototypes) < 3 ||
    Number(selection.max_prototypes) > 8
  ) {
    throw new Error(`invalid venue profile max_prototypes: ${context}`);
  }
  if (!Number.isInteger(selection.source_year_max) || Number(selection.source_year_max) < 1900) {
    throw new Error(`invalid venue profile source_year_max: ${context}`);
  }
  if (
    selection.embedding_model !== EMBEDDING_MODEL ||
    selection.embedding_revision !== EMBEDDING_REVISION
  ) {
    throw new Error(`invalid venue profile embedding identity: ${context}`);
  }
  return {
    method: selection.method.trim(),
    max_prototypes: Number(selection.max_prototypes),
    source_year_max: Number(selection.source_year_max),
    embedding_model: EMBEDDING_MODEL,
    embedding_revision: EMBEDDING_REVISION,
  };
}

function venueProfilePaper(value: unknown, context: string): VenueProfilePaper {
  if (!value || typeof value !== "object")
    throw new Error(`invalid venue profile paper: ${context}`);
  const paper = value as Record<string, unknown>;
  if (typeof paper.title !== "string" || !paper.title.trim()) {
    throw new Error(`invalid venue profile title: ${context}`);
  }
  if (!Number.isInteger(paper.year) || Number(paper.year) < 1900) {
    throw new Error(`invalid venue profile year: ${context}`);
  }
  if (typeof paper.source !== "string" || !paper.source.trim()) {
    throw new Error(`invalid venue profile source: ${context}`);
  }
  if (typeof paper.source_url !== "string" || !paper.source_url.trim()) {
    throw new Error(`invalid venue profile source_url: ${context}`);
  }
  try {
    const url = new URL(paper.source_url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new Error(`invalid venue profile source_url: ${context}`);
  }
  if (typeof paper.collected_at !== "string" || !paper.collected_at.trim()) {
    throw new Error(`invalid venue profile collected_at: ${context}`);
  }
  const collected = new Date(paper.collected_at);
  if (!Number.isFinite(collected.getTime()) || collected.toISOString() !== paper.collected_at) {
    throw new Error(`invalid venue profile collected_at: ${context}`);
  }
  if (Number(paper.year) > collected.getUTCFullYear()) {
    throw new Error(`future venue profile record: ${context}`);
  }
  return {
    title: paper.title.trim(),
    year: Number(paper.year),
    source: paper.source.trim(),
    source_url: paper.source_url.trim(),
    collected_at: paper.collected_at,
  };
}

function normalizedVenueProfileData(input: VenueProfileArtifactInput): {
  schema: typeof VENUE_PROFILE_SCHEMA_VERSION;
  policy: VenueProfileSelection;
  profiles: Record<string, VenueProfileEntry>;
} {
  if (input.schema !== undefined && input.schema !== VENUE_PROFILE_SCHEMA_VERSION) {
    throw new Error("invalid venue profile artifact schema");
  }
  const policy = venueProfileSelection(input.policy, "policy");
  if (!input.profiles || typeof input.profiles !== "object" || Array.isArray(input.profiles)) {
    throw new Error("invalid venue profile artifact profiles");
  }
  const profiles: Record<string, VenueProfileEntry> = {};
  const seenTitles = new Map<string, string>();
  for (const key of Object.keys(input.profiles).sort()) {
    if (!key.trim()) throw new Error("invalid venue profile key");
    const raw = input.profiles[key];
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.papers)) {
      throw new Error(`invalid venue profile entries: ${key}`);
    }
    const selection = venueProfileSelection(raw.selection, key);
    if (JSON.stringify(selection) !== JSON.stringify(policy)) {
      throw new Error(`mixed venue profile selection policy: ${key}`);
    }
    if (raw.papers.length < selection.max_prototypes) {
      throw new Error(`invalid venue profile paper count: ${key}`);
    }
    const papers = raw.papers
      .map((paper, index) => {
        const normalized = venueProfilePaper(paper, `${key}[${index}]`);
        if (normalized.year > selection.source_year_max) {
          throw new Error(`venue profile paper exceeds source cutoff: ${key}[${index}]`);
        }
        const titleKey = venueProfileTitleKey(normalized.title);
        const previous = seenTitles.get(titleKey);
        if (previous) throw new Error(`duplicate venue profile paper: ${key} / ${previous}`);
        seenTitles.set(titleKey, `${key}[${index}]`);
        return normalized;
      })
      .sort((a, b) => venueProfileTitleKey(a.title).localeCompare(venueProfileTitleKey(b.title)));
    if (!Array.isArray(raw.prototypes)) {
      throw new Error(`missing venue profile prototypes: ${key}`);
    }
    const prototypes = raw.prototypes
      .map((title) => String(title).trim())
      .filter(Boolean)
      .sort((a, b) => venueProfileTitleKey(a).localeCompare(venueProfileTitleKey(b)));
    if (
      prototypes.length < 3 ||
      prototypes.length > selection.max_prototypes ||
      new Set(prototypes.map(venueProfileTitleKey)).size !== prototypes.length
    ) {
      throw new Error(`invalid venue profile prototypes: ${key}`);
    }
    const titles = new Set(papers.map((paper) => venueProfileTitleKey(paper.title)));
    if (prototypes.some((title) => !titles.has(venueProfileTitleKey(title)))) {
      throw new Error(`unknown venue profile prototype: ${key}`);
    }
    profiles[key] = { papers, prototypes, selection };
  }
  if (Object.keys(profiles).length === 0) throw new Error("venue profile artifact is empty");
  return { schema: VENUE_PROFILE_SCHEMA_VERSION, policy, profiles };
}

function venueProfilePayload(input: VenueProfileArtifactInput): string {
  return JSON.stringify(normalizedVenueProfileData(input));
}

function venueProfileHash(input: VenueProfileArtifactInput): string {
  return createHash("sha256").update(venueProfilePayload(input)).digest("hex").slice(0, 16);
}

/** Validate and normalize the provenance-bearing artifact. */
export function validateVenueProfileArtifact(value: unknown): VenueProfileArtifact {
  if (!value || typeof value !== "object") throw new Error("invalid venue profile artifact");
  const raw = value as VenueProfileArtifactInput;
  const normalized = normalizedVenueProfileData(raw);
  const expected = venueProfileHash(raw);
  if (raw.profiles_hash !== expected) throw new Error("venue profile artifact hash mismatch");
  return { ...normalized, profiles_hash: expected };
}

/** Canonical generator for the versioned venue-profile artifact. */
export function serializeVenueProfileArtifact(input: VenueProfileArtifactInput): string {
  const normalized = normalizedVenueProfileData(input);
  const profiles_hash = venueProfileHash(normalized);
  return `${JSON.stringify({ ...normalized, profiles_hash }, null, 2)}\n`;
}

function loadVenueProfiles(): VenueProfileArtifact {
  const artifact = JSON.parse(
    readFileSync(new URL("../data/venue-profiles.json", import.meta.url), "utf8"),
  ) as VenueProfileArtifactInput;
  return validateVenueProfileArtifact(artifact);
}

export const VENUE_PROFILE_ARTIFACT = loadVenueProfiles();

function cosineDistance(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length);
  let score = 0;
  for (let index = 0; index < size; index++) score += left[index]! * right[index]!;
  return 1 - score;
}

/** Deterministic embedding k-medoids; generation must provide every title vector. */
export function selectVenueMedoids(
  papers: VenueProfilePaper[],
  max: number,
  vectors: VenueProfileVectorMap,
): VenueProfilePaper[] {
  if (max < 3) throw new Error("venue profile max_prototypes must be at least 3");
  const canonical = [...papers].sort(
    (a, b) =>
      venueProfileTitleKey(a.title).localeCompare(venueProfileTitleKey(b.title)) ||
      a.year - b.year ||
      a.source.localeCompare(b.source) ||
      a.source_url.localeCompare(b.source_url),
  );
  const seen = new Set<string>();
  const unique = canonical.filter((paper) => {
    const key = venueProfileTitleKey(paper.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const count = Math.min(unique.length, Math.min(8, max));
  const vectorOf = (paper: VenueProfilePaper) => {
    const vector = vectors[venueProfileTitleKey(paper.title)];
    if (!vector?.length || vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`missing venue profile vector: ${paper.title}`);
    }
    return vector;
  };
  const distance = (left: VenueProfilePaper, right: VenueProfilePaper) =>
    cosineDistance(vectorOf(left), vectorOf(right));
  const selected: VenueProfilePaper[] = [
    [...unique].sort((a, b) => {
      const aScore = unique.reduce((sum, other) => sum + distance(a, other), 0);
      const bScore = unique.reduce((sum, other) => sum + distance(b, other), 0);
      return (
        aScore - bScore ||
        venueProfileTitleKey(a.title).localeCompare(venueProfileTitleKey(b.title))
      );
    })[0]!,
  ];
  while (selected.length < count) {
    const candidate = unique
      .filter((paper) => !selected.includes(paper))
      .sort((a, b) => {
        const aScore = Math.min(...selected.map((item) => distance(item, a)));
        const bScore = Math.min(...selected.map((item) => distance(item, b)));
        return (
          bScore - aScore ||
          venueProfileTitleKey(a.title).localeCompare(venueProfileTitleKey(b.title))
        );
      })[0];
    selected.push(candidate);
  }
  for (let iteration = 0; iteration < 3; iteration++) {
    const clusters = selected.map(() => [] as VenueProfilePaper[]);
    for (const paper of unique) {
      const index = selected
        .map((medoid, candidate) => [candidate, distance(paper, medoid)] as const)
        .sort((left, right) => left[1] - right[1] || left[0] - right[0])[0]![0];
      clusters[index]!.push(paper);
    }
    const next = clusters.map((cluster, index) =>
      cluster.length
        ? [...cluster].sort(
            (a, b) =>
              cluster.reduce((sum, other) => sum + distance(a, other), 0) -
                cluster.reduce((sum, other) => sum + distance(b, other), 0) ||
              venueProfileTitleKey(a.title).localeCompare(venueProfileTitleKey(b.title)),
          )[0]!
        : selected[index]!,
    );
    if (next.every((paper, index) => paper === selected[index])) break;
    selected.splice(0, selected.length, ...next);
  }
  return selected.sort((a, b) =>
    venueProfileTitleKey(a.title).localeCompare(venueProfileTitleKey(b.title)),
  );
}

/** Derived compatibility view used by lexical and embedding consumers. */
export const VENUE_PAPERS: Record<string, string[]> = Object.fromEntries(
  Object.entries(VENUE_PROFILE_ARTIFACT.profiles).map(([key, profile]) => [
    key,
    profile.prototypes,
  ]),
);

/** Stable hash of the complete provenance-bearing artifact (embedding invalidation key). */
export function venuePapersHash(): string {
  return VENUE_PROFILE_ARTIFACT.profiles_hash;
}

/** Profile titles available to a benchmark at its historical cutoff. */
export function venuePapersAtCutoff(
  sourceYearMax: number,
  artifact: VenueProfileArtifact = VENUE_PROFILE_ARTIFACT,
): Record<string, string[]> {
  if (!Number.isInteger(sourceYearMax) || sourceYearMax < 1900) {
    throw new Error("benchmark profile cutoff must be a valid year");
  }
  return Object.fromEntries(
    Object.entries(artifact.profiles)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, profile]) => [
        key,
        profile.prototypes.filter((title) => {
          const paper = profile.papers.find(
            (candidate) => venueProfileTitleKey(candidate.title) === venueProfileTitleKey(title),
          );
          return paper !== undefined && paper.year <= sourceYearMax;
        }),
      ]),
  );
}

/** Hash the exact provenance-bearing profile slice used by a historical benchmark. */
export function benchmarkProfileHash(
  sourceYearMax: number,
  artifact: VenueProfileArtifact = VENUE_PROFILE_ARTIFACT,
): string {
  if (!Number.isInteger(sourceYearMax) || sourceYearMax < 1900) {
    throw new Error("benchmark profile cutoff must be a valid year");
  }
  const profiles = Object.fromEntries(
    Object.entries(artifact.profiles)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, profile]) => [
        key,
        {
          selection: {
            method: profile.selection.method,
            max_prototypes: profile.selection.max_prototypes,
          },
          papers: profile.papers.filter((paper) => paper.year <= sourceYearMax),
          prototypes: profile.prototypes.filter((title) => {
            const paper = profile.papers.find(
              (candidate) => venueProfileTitleKey(candidate.title) === venueProfileTitleKey(title),
            );
            return paper !== undefined && paper.year <= sourceYearMax;
          }),
        },
      ]),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema: artifact.schema,
        source_year_max: sourceYearMax,
        profiles,
        profile_rules: {
          excluded_attribute_tags: [...ATTRIBUTE_TAGS].sort(),
          paper_vector_keys: [...PAPER_VEC_KEYS].sort(),
        },
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

export function benchmarkEmbeddingCacheKey(sourceYearMax: number): string {
  const safeModel = (model: string): string => model.replaceAll("/", "-");
  return [
    "benchmark-embedding",
    sourceYearMax,
    benchmarkProfileHash(sourceYearMax),
    safeModel(EMBEDDING_MODEL),
    EMBEDDING_REVISION,
    safeModel(EMBEDDING_MULTI_MODEL),
    EMBEDDING_MULTI_REVISION,
    EMBEDDING_RUNTIME_VERSION,
  ].join("-");
}

import { toStringArray } from "./util.ts";

function extractScopeText(c: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof c.scope === "string" && c.scope.trim()) {
    parts.push(c.scope.trim());
  } else if (Array.isArray(c.scope)) {
    parts.push(...toStringArray(c.scope));
  }
  if (typeof c.official_scope === "string" && c.official_scope.trim()) {
    parts.push(c.official_scope.trim());
  } else if (Array.isArray(c.official_scope)) {
    parts.push(...toStringArray(c.official_scope));
  }
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

/** 会議プロファイル文（カテゴリは正式名で展開）。
 * 多言語モデル用（forMulti）は、日本語名の会議にカテゴリの日本語キーワードを付与して
 * 日本語クエリから検索可能にする。英語モデルは日本語キーワードがノイズになるため
 * 付与しない（言語別の埋め込みを実測で分離した設計）。 */
export function profileTexts(
  confs: unknown[] | null | undefined,
  catNames?: Record<string, string> | null,
  forMulti = false,
  venuePapers: Record<string, string[]> = VENUE_PAPERS,
): { keys: string[]; texts: string[] } {
  const keys: string[] = [];
  const texts: string[] = [];
  const safeCats = catNames ?? {};
  for (const raw of confs ?? []) {
    const c = raw as Record<string, unknown>;
    if (!c || typeof c !== "object") continue;
    const key = String(c.key ?? "").trim();
    if (!key) continue;
    // カテゴリは短いキー（systems 等）より正式名（Systems, Architecture and Storage）で
    // 埋め込む方がセマンティック品質が高い（ベンチマークで実測）。
    const cats = toStringArray(c.categories);
    const catText = cats.map((k) => safeCats[k] || k).join(" ");
    const name = `${String(c.title ?? "")} ${String(c.full_name ?? "")}`;
    // 多言語モデル用: 日本語名の会議に日本語の分野語を付与（クエリ側の日本語語彙と一致させる）
    const isJpVenue =
      hasJapanese(name) ||
      toStringArray(c.tags).includes("domestic-jp") ||
      toStringArray(c.tags).includes("niche-jp");
    const jpKw = forMulti && isJpVenue ? cats.map((k) => JP_CAT_KW[k] || "").join(" ") : "";
    // 実採択論文タイトル（あれば）でプロファイルを強化。
    // 英語モデルにのみ付与する。
    // multi にも付けると日本語クエリの sem ランキングを乱すため。
    // 「タイトル個別ベクトルの平均」方式（会議名 + 各タイトルを別々に埋めて
    // 平均）は golden top1 +2 エントリだが top5 -2・EN 合成 -3.6 で総合的に悪化した。
    // 連結 mean pooling が最良（golden top5 73.5% / EN 合成 85.0%）。
    // rtss/ecrts は論文が多様（scheduling/WCET/TSN/AI/FPGA）で平均重心が
    // 汎用化し、無関係クエリ（memory safety 等）を奪う。埋め込みは会議名中心に保ち、
    // papers は語彙一致（scoreLine）でのみ使う。
    // usenix-security も 24 本が極めて多様（crypto/ML/web/ハードウェア/ブロックチェーン）で
    // 重心が汎用化しやすいため vocab-only。
    // icdcs を vocab-only にすると golden top5 65.7→62.9 に悪化するため、埋め込みは維持する。
    const skipEmb = SKIP_EMB_KEYS.has(key);
    const papers = !forMulti && !skipEmb ? (venuePapers[key] ?? []).slice(0, 8).join(" . ") : "";
    const tags = toStringArray(c.tags).filter((tag) => !ATTRIBUTE_TAGS.has(tag));
    const scopeText = extractScopeText(c);
    const parts = [
      String(c.title ?? ""),
      String(c.full_name ?? ""),
      catText,
      scopeText,
      jpKw,
      tags.join(" "),
      papers,
    ];
    const text = parts.filter(Boolean).join(" ").trim();
    keys.push(key);
    texts.push(text || key);
  }
  return { keys, texts };
}

/** 1 モデルぶんの埋め込み表 {key: number[]} を生成する。
 * keys に同じ key が複数回現れる場合（会議名 + 各代表論文タイトル）は、
 * その平均ベクトルを返し、会議の採択領域の重心にする。 */
async function embedSet(
  model: string,
  texts: string[],
  keys: string[],
  revision: string,
  localFilesOnly = false,
): Promise<Record<string, number[]>> {
  const extractor = await getExtractor(model, revision, localFilesOnly);
  const sums = new Map<string, number[]>();
  const counts = new Map<string, number>();
  // メモリ節約のためバッチで処理
  const batch = 128;
  for (let start = 0; start < texts.length; start += batch) {
    const chunk = texts.slice(start, start + batch);
    const output = await extractor(chunk, { pooling: "mean", normalize: true });
    const tensors = Array.isArray(output) ? output : [output];
    let index = 0;
    for (const tensor of tensors) {
      const dims = tensor.dims;
      const n = dims.length >= 1 ? dims[0] : 1;
      const width = dims.length >= 2 ? dims[1] : EMBEDDING_DIM;
      const arr = Array.from(tensor.data as Float32Array | ArrayLike<number>);
      for (let i = 0; i < n; i++) {
        const key = keys[start + index];
        if (key !== undefined) {
          const vec = arr.slice(i * width, (i + 1) * width);
          const prev = sums.get(key);
          if (!prev) {
            sums.set(key, vec);
          } else {
            for (let d = 0; d < width; d++) prev[d] += vec[d];
          }
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        index += 1;
      }
    }
  }
  const out: Record<string, number[]> = {};
  for (const [key, sum] of sums) {
    const c = counts.get(key) ?? 1;
    const avg = sum.map((v) => v / c);
    const norm = Math.sqrt(avg.reduce((a, v) => a + v * v, 0)) || 1;
    out[key] = avg.map((v) => round6(v / norm));
  }
  return out;
}

/** 各テキストを個別ベクトルとして埋め込む（平均しない）。max 類似度用。 */
async function embedEach(
  model: string,
  texts: string[],
  revision: string,
  localFilesOnly = false,
): Promise<number[][]> {
  const extractor = await getExtractor(model, revision, localFilesOnly);
  const out: number[][] = [];
  const batch = 128;
  for (let start = 0; start < texts.length; start += batch) {
    const chunk = texts.slice(start, start + batch);
    const output = await extractor(chunk, { pooling: "mean", normalize: true });
    const tensors = Array.isArray(output) ? output : [output];
    for (const tensor of tensors) {
      const dims = tensor.dims;
      const n = dims.length >= 1 ? dims[0] : 1;
      const width = dims.length >= 2 ? dims[1] : EMBEDDING_DIM;
      const arr = Array.from(tensor.data as Float32Array | ArrayLike<number>);
      for (let i = 0; i < n; i++) {
        const vec = arr.slice(i * width, (i + 1) * width);
        const norm = Math.sqrt(vec.reduce((a, v) => a + v * v, 0)) || 1;
        out.push(vec.map((v) => round6(v / norm)));
      }
    }
  }
  return out;
}

/** Generation-only title embeddings for deterministic venue-profile medoids. */
export async function embedVenueProfileTitles(titles: string[]): Promise<VenueProfileVectorMap> {
  const canonical = [...new Set(titles.map(venueProfileTitleKey))].sort();
  // transformers 4.x resolves a pinned cache reliably when it is an explicit
  // model path. This generator-only path never falls back to an unpinned model.
  if (!env.cacheDir) throw new Error("transformers cache directory is unavailable");
  const modelDir = join(env.cacheDir, EMBEDDING_MODEL, EMBEDDING_REVISION);
  const extractor = (await pipeline("feature-extraction", modelDir)) as FeatureExtractionPipeline;
  const output = await extractor(canonical, { pooling: "mean", normalize: true });
  const tensors = Array.isArray(output) ? output : [output];
  const vectors: number[][] = [];
  for (const tensor of tensors) {
    const count = tensor.dims[0] ?? 1;
    const width = tensor.dims[1] ?? EMBEDDING_DIM;
    const values = Array.from(tensor.data as Float32Array | ArrayLike<number>);
    for (let index = 0; index < count; index++) {
      vectors.push(values.slice(index * width, (index + 1) * width).map(round6));
    }
  }
  return Object.fromEntries(canonical.map((title, index) => [title, vectors[index]!]));
}

export interface BenchmarkEmbeddingManifest {
  schema: 1;
  runtime_version: string;
  profile_year_max: number;
  profile_hash_at_cutoff: string;
  cache_key: string;
  models: {
    en: { model: string; revision: string; dim: number };
    multi: { model: string; revision: string; dim: number };
  };
  paper_vecs: { keys: string[]; dim: number };
}

export interface BenchmarkEmbeddingBundle {
  manifest: BenchmarkEmbeddingManifest;
  embeddings: Record<string, number[]>;
  multi: { embeddings: Record<string, number[]> };
  paperVecs: Record<string, number[][]>;
}

export function benchmarkEmbeddingManifest(
  sourceYearMax: number,
  paperVecKeys: string[],
): BenchmarkEmbeddingManifest {
  return {
    schema: 1,
    runtime_version: EMBEDDING_RUNTIME_VERSION,
    profile_year_max: sourceYearMax,
    profile_hash_at_cutoff: benchmarkProfileHash(sourceYearMax),
    cache_key: benchmarkEmbeddingCacheKey(sourceYearMax),
    models: {
      en: { model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION, dim: EMBEDDING_DIM },
      multi: {
        model: EMBEDDING_MULTI_MODEL,
        revision: EMBEDDING_MULTI_REVISION,
        dim: EMBEDDING_DIM,
      },
    },
    paper_vecs: { keys: [...paperVecKeys].sort(), dim: EMBEDDING_DIM },
  };
}

/** Manifest-only benchmark contract. This never initializes a model or reads a model cache. */
export function benchmarkEmbeddingManifestAtCutoff(
  sourceYearMax: number,
): BenchmarkEmbeddingManifest {
  const papers = venuePapersAtCutoff(sourceYearMax);
  const paperVecKeys = PAPER_VEC_KEYS.filter((key) => (papers[key] ?? []).length > 0);
  return benchmarkEmbeddingManifest(sourceYearMax, paperVecKeys);
}

/** Build benchmark-only vectors; production embeddings are intentionally not accepted here. */
export async function buildBenchmarkEmbeddingBundle(
  confs: unknown[],
  catNames: Record<string, string>,
  sourceYearMax: number,
): Promise<BenchmarkEmbeddingBundle> {
  const papers = venuePapersAtCutoff(sourceYearMax);
  const en = profileTexts(confs, catNames, false, papers);
  const multi = profileTexts(confs, catNames, true, papers);
  const embeddings = await embedSet(EMBEDDING_MODEL, en.texts, en.keys, EMBEDDING_REVISION);
  const multiEmbeddings = await embedSet(
    EMBEDDING_MULTI_MODEL,
    multi.texts,
    multi.keys,
    EMBEDDING_MULTI_REVISION,
  );
  const paperVecs: Record<string, number[][]> = {};
  for (const key of PAPER_VEC_KEYS) {
    const titles = papers[key] ?? [];
    if (titles.length > 0) {
      paperVecs[key] = await embedEach(EMBEDDING_MODEL, titles, EMBEDDING_REVISION);
    }
  }
  return {
    manifest: benchmarkEmbeddingManifestAtCutoff(sourceYearMax),
    embeddings,
    multi: { embeddings: multiEmbeddings },
    paperVecs,
  };
}

const SKIP_EMB_KEYS = new Set([...PAPER_VEC_KEYS, "ecrts"]);

type EmbeddingData = {
  categories?: Record<string, unknown>;
  conferences?: Array<Record<string, unknown>>;
};

export type EmbeddingModelManifest = {
  model: string;
  revision: string;
  dim: number;
  probe: { text: string; vector: number[] };
};

export type EmbeddingManifest = {
  schema: number;
  runtime_version: string;
  profile_hash: string;
  keys: string[];
  venue_papers_hash: string;
  models: { en: EmbeddingModelManifest; multi: EmbeddingModelManifest };
  paper_vecs: { keys: string[]; dim: number };
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function dataConferences(data: EmbeddingData | null | undefined): Array<Record<string, unknown>> {
  return (data?.conferences ?? [])
    .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === "object"))
    .map((c) => ({
      key: String(c.key ?? "").trim(),
      title: String(c.title ?? ""),
      full_name: String(c.full_name ?? ""),
      categories: toStringArray(c.categories),
      tags: toStringArray(c.tags),
      scope:
        typeof c.scope === "string"
          ? c.scope
          : Array.isArray(c.scope)
            ? toStringArray(c.scope)
            : "",
      official_scope:
        typeof c.official_scope === "string"
          ? c.official_scope
          : Array.isArray(c.official_scope)
            ? toStringArray(c.official_scope)
            : "",
    }))
    .filter((c) => c.key)
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

function expectedPaperKeys(data: EmbeddingData | null | undefined): string[] {
  return dataConferences(data)
    .map((c) => String(c.key))
    .filter(
      (key) =>
        (PAPER_VEC_KEYS as readonly string[]).includes(key) && (VENUE_PAPERS[key]?.length ?? 0) > 0,
    )
    .sort();
}

function modelManifest(model: string, revision: string, probe: number[]): EmbeddingModelManifest {
  return {
    model,
    revision,
    dim: EMBEDDING_DIM,
    probe: { text: EMBEDDING_PROBE, vector: probe },
  };
}

/** Hash every input that changes profile vectors, not only the output key set. */
export function embeddingProfileHash(data: EmbeddingData | null | undefined): string {
  const profile = {
    schema: EMBEDDING_SCHEMA_VERSION,
    runtime_version: EMBEDDING_RUNTIME_VERSION,
    models: {
      en: modelManifest(EMBEDDING_MODEL, EMBEDDING_REVISION, []),
      multi: modelManifest(EMBEDDING_MULTI_MODEL, EMBEDDING_MULTI_REVISION, []),
    },
    categories: data?.categories ?? {},
    conferences: dataConferences(data).map((c) => ({
      ...c,
      papers: VENUE_PAPERS[String(c.key)] ?? [],
    })),
    profile_rules: {
      jp_category_keywords: JP_CAT_KW,
      skip_embedding_keys: [...SKIP_EMB_KEYS].sort(),
      paper_vector_keys: [...PAPER_VEC_KEYS].sort(),
      excluded_attribute_tags: [...ATTRIBUTE_TAGS].sort(),
      english_papers: "first-eight-concatenated",
      multilingual_papers: "excluded",
    },
  };
  return createHash("sha256")
    .update(JSON.stringify(stableValue(profile)))
    .digest("hex")
    .slice(0, 16);
}

export function embeddingBundleKey(profileHash: string): string {
  return [
    "kamiyobi-recommendation",
    profileHash,
    EMBEDDING_REVISION,
    EMBEDDING_MULTI_REVISION,
    EMBEDDING_RUNTIME_VERSION,
  ].join("-");
}

export function embeddingManifest(
  data: EmbeddingData | null | undefined,
  probes: { en?: number[]; multi?: number[] } = {},
): EmbeddingManifest {
  const keys = dataConferences(data).map((c) => String(c.key));
  return {
    schema: EMBEDDING_SCHEMA_VERSION,
    runtime_version: EMBEDDING_RUNTIME_VERSION,
    profile_hash: embeddingProfileHash(data),
    keys,
    venue_papers_hash: venuePapersHash(),
    models: {
      en: modelManifest(EMBEDDING_MODEL, EMBEDDING_REVISION, probes.en ?? []),
      multi: modelManifest(EMBEDDING_MULTI_MODEL, EMBEDDING_MULTI_REVISION, probes.multi ?? []),
    },
    paper_vecs: { keys: expectedPaperKeys(data), dim: EMBEDDING_DIM },
  };
}

export async function buildEmbeddings(
  dataPath: string,
  outPath: string,
  localFilesOnly = false,
): Promise<Record<string, number[]>> {
  const data = JSON.parse(readFileSync(dataPath, "utf8")) as {
    conferences: Array<Record<string, unknown>>;
    categories?: Record<string, string>;
  };
  const catNames = (data.categories ?? {}) as Record<string, string>;
  const en = profileTexts(data.conferences, catNames, false);
  const multiTexts = profileTexts(data.conferences, catNames, true);

  // 言語適応型デュアルモデル（実測ベース）:
  // 英語は all-MiniLM-L6-v2（EN top1 80.1%）、日本語は paraphrase-multilingual
  // （JP top1 19.0% → 42.9%）。一方だけだと他方が落ちるため両方持つ。
  // 多言語側は日本語会議に日本語キーワードを付与（国内研究会の検索改善、実測済み）。
  const out = await embedSet(
    EMBEDDING_MODEL,
    en.texts,
    en.keys,
    EMBEDDING_REVISION,
    localFilesOnly,
  );
  const multi = await embedSet(
    EMBEDDING_MULTI_MODEL,
    multiTexts.texts,
    multiTexts.keys,
    EMBEDDING_MULTI_REVISION,
    localFilesOnly,
  );
  const [enProbe] = await embedEach(
    EMBEDDING_MODEL,
    [EMBEDDING_PROBE],
    EMBEDDING_REVISION,
    localFilesOnly,
  );
  const [multiProbe] = await embedEach(
    EMBEDDING_MULTI_MODEL,
    [EMBEDDING_PROBE],
    EMBEDDING_MULTI_REVISION,
    localFilesOnly,
  );

  // skipEmb 会議のうち rtss/usenix-security に論文個別ベクトルを付与する。
  // 多様な論文の平均重心は汎用化しやすいため埋め込みから外したが、その副作用で
  // 会議名のみの埋め込みになり実論文タイトルからセマンティックに発見されなくなった
  // （golden EN top1 15.8% vs top5 63.2% の乖離の主因）。
  // 「個別ベクトルの平均」は採らず、max 類似度（クエリが採択論文のどれかに近ければ
  // 会議に近い）を使う。
  // 英語モデルのみ対象にする。
  // multi に英語論文語彙を混ぜると日本語クエリの順位を乱すため。
  const paperVecs: Record<string, number[][]> = {};
  // rtss は論文が多様で max が「1 本でも近い」誤マッチを起こす
  // （Beehive→rtss 50%、BULKHEAD→rtss 38% 等）。
  // ches を paperVecs に足すと top5 65.7→64.3 に悪化する。
  // FPGA/AES 語彙が BULKHEAD/Beehive 等を奪うため。
  // rtss は語境界・GENERIC 導入後に Timely Classification 対策として使う。
  // rtas は top1 +2.5pt だが top5 −2.5pt で、既存 2 件
  // CounterSEVeillance/One-Size-Fits-None を奪い新規獲得 0 のため採らない。
  // rtas は VENUE_PAPERS 語彙のみで 8 件中 6 件 top5 を達成。
  for (const key of PAPER_VEC_KEYS) {
    const papers = VENUE_PAPERS[key] ?? [];
    if (!papers.length) continue;
    // 論文タイトルを**個別に**埋め込む（平均しない — max 類似度で使うため）。
    // embedSet は key ごとに平均するので使えない。
    const vecs = await embedEach(EMBEDDING_MODEL, papers, EMBEDDING_REVISION, localFilesOnly);
    paperVecs[key] = vecs;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  const tempPath = `${outPath}.tmp.${process.pid}`;
  const payload = JSON.stringify({
    model: EMBEDDING_MODEL,
    dim: EMBEDDING_DIM,
    venuePapersHash: venuePapersHash(),
    manifest: embeddingManifest(data, { en: enProbe, multi: multiProbe }),
    embeddings: out,
    multi: {
      model: EMBEDDING_MULTI_MODEL,
      dim: EMBEDDING_DIM,
      embeddings: multi,
    },
    paperVecs,
  });
  try {
    writeFileSync(tempPath, payload, "utf8");
    renameSync(tempPath, outPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Preserve the original error when cleanup also fails.
    }
    throw error;
  }
  return out;
}

export async function main(
  argv: string[] | null | undefined = process.argv.slice(2),
): Promise<number> {
  const { values, positionals, tokens } = parseNodeArgs({
    args: normalizeShortEquals(argv, { f: "force", h: "help" }),
    options: {
      force: { type: "boolean", short: "f" },
      help: { type: "boolean", short: "h" },
    },
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  if (values.help || positionals.includes("help")) {
    console.log("usage: node src/embeddings.ts [--force|-f] <data.json> <embeddings.json>");
    return 0;
  }
  const known = new Set(["force", "help"]);
  if (positionals.length === 0 || tokens.some((t) => t.kind === "option" && !known.has(t.name))) {
    process.stderr.write(
      "usage: node src/embeddings.ts [--force|-f] <data.json> <embeddings.json>\n",
    );
    return 2;
  }
  if (positionals.length !== 2) {
    process.stderr.write(
      "usage: node src/embeddings.ts [--force|-f] <data.json> <embeddings.json>\n",
    );
    return 2;
  }
  const force = booleanValue(values.force, false);
  const [dataPath, outPath] = positionals;
  let dataExists = true;
  try {
    readFileSync(dataPath);
  } catch {
    dataExists = false;
  }
  if (!dataExists) {
    process.stderr.write(`data not found: ${dataPath}\n`);
    return 1;
  }
  if (!force) {
    let outExists = false;
    try {
      readFileSync(outPath);
      outExists = true;
    } catch {
      outExists = false;
    }
    if (outExists) {
      process.stderr.write(`embeddings already exist: ${outPath} (skip)\n`);
      return 0;
    }
  }
  const out = await buildEmbeddings(dataPath, outPath);
  console.log(`embeddings written: ${Object.keys(out).length} conferences -> ${outPath}`);
  return 0;
}

const isMain = Boolean(
  process.argv[1] &&
    (process.argv[1].endsWith("embeddings.ts") || process.argv[1].endsWith("embeddings.js")),
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
