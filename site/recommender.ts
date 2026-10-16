import type { SubmissionDisplay } from "./submission-identity.ts";

/*
 * recommender.js — 論文タイトル/キーワード → 会議マッチングの純粋ロジック
 *
 * ブラウザ（template.html）と Node（テスト）の両方から使える。
 * 依存: なし（DOM 非依存）。
 *
 * 公開 API:
 *   parsePaperLines(text)      → [{title, keywords, venue}]  (1行1論文、| 区切り)
 *   autoDetectCats(lines)      → [catKey, ...]  分野自動判定（ヒット数の降順、0 件なら []）
 *   scorePapers(r, lines)      → number 0..100  (primary/reference weighted topic score)
 *   breakdown(r, lines)        → {score, venueHit, perLine: [...]}  デバッグ/表示用
 *   safeExternalUrl(value)     → HTTP/HTTPS または相対 URL、不正な URL は ""
 */

import {
  latinAttestedJa,
  latinNearestJa,
  latinSkeletonJa,
  latinVocabularyJa,
} from "./latin-retype.ts"; // 欧文の打ち間違いの見当
import { PLACE_QUERY_ALIASES_JA } from "./place-aliases.ts"; // 繋ぎを `.ts` で書く – site/tsconfig.build.json の書き換えで成果物は `.js` になる
import { TOPIC_QUERY_ALIASES_JA } from "./topic-aliases.ts"; // 主題の寄せ表

type Vector = number[];
type VectorMap = Record<string, Vector>;
type PaperVectorMap = Record<string, Vector[]>;

export const RERANKER_FEATURE_SCHEMA = [
  "lexical_score",
  "semantic_score",
  "category_overlap",
  "venue_name_evidence",
  "prior_venue",
  "language_match",
  "venue_kind",
] as const;
export const RERANKER_ALGORITHM_REVISION = "l2-pairwise-logistic-reranker-v3-grouped-cv";
type RerankerFeatureName = (typeof RERANKER_FEATURE_SCHEMA)[number];
type RerankerFeatures = Record<RerankerFeatureName, number>;

interface PaperRecord {
  title: string;
  abstract?: string;
  keywords?: string;
  venue?: string;
}

interface DeadlineRecord {
  kind?: string;
  label?: string;
  comment?: string | null;
  precision?: "exact" | "date-only";
  local_date?: string;
  earliest_utc?: string;
  latest_utc?: string;
  utc?: string | null;
  at_utc?: string | null;
  tz_raw?: string | null;
  round?: number;
}

interface EditionRecord {
  year?: number;
  place?: string;
  date_text?: string;

  id?: string;
  /** 会期の暦日。国際会議の `date_text` は英語表記なので、月での検索はこっちを使う。 */
  event_start?: string;
  event_end?: string;
  event_date_precision?: string;
  event_segments?: Array<{ start: string; end: string; label?: string }>;
  estimated?: boolean;
  /** 公式ページ。検索欄に URL を貼って収録確認をする人が使えるように、検索語へ入れる。 */
  link?: string;
  deadlines?: DeadlineRecord[];
  schedule_deadlines?: DeadlineRecord[];
}

/** 会期情報があり、投稿締切が未収録の回（締切一覧の表には出さない）。 */
interface ScheduleOnlyEdition {
  key: string;
  name: string;
  year?: number;
  link: string;
  place: string;
  eventStart: string;
  eventEnd: string;
  eventDatePrecision?: string;
  eventSegments?: Array<{ start: string; end: string; label?: string }>;
  rankPairs: string[];
  cats: string[];
  tags: string[];
  hay: string;
}

interface ConferenceRecord {
  key: string;
  /** 会議・ジャーナルの公式ページの URL。画面は `ed.link || conf.link` でリンクを出すので、
   * 正規化の段階で落とすと、そこを通る行（常時受付のジャーナル）だけリンクの無い行になる。 */
  link?: string;

  recommendation_axes?: Record<string, unknown>;
  title?: string;
  full_name?: string;
  categories?: string[];
  tags?: string[];
  papers?: string[];
  acronym?: string;
  scope?: string | string[];
  official_scope?: string | string[];
  paper_abstracts?: string[];
  keywords?: string[];
  rank?: Record<string, string>;
  editions?: EditionRecord[];

  record_deadline_last?: string | null;
  /** 収録の側で一番近い締切の日（品の窓の外も含む – 第 298 回）。 */
  record_deadline_next?: string;
  /** その締切の種別（`abstract` など – 画面の日本語に直す）。 */
  record_deadline_next_kind?: string;
  /** 品書の生成時点で残っていた締切の本数。 */
  record_deadline_count?: number;
}

interface CandidateRow {
  submission?: SubmissionDisplay;
  conf: ConferenceRecord;
  ed: EditionRecord;
  dl: DeadlineRecord;
  kind: string;
  est: boolean;
  t: number;
  /** 画面に出している暦日（JST の正午）。並び順・残り・CSV の残り列の基準。
   * 時刻未確認の行では `t`（最も早い締め時刻）と違う – 幅の端で並べると日付欄と
   * 食い違うため（SPEC §7）。 */
  tShown: number;
  tLast: number;
  /** 会期（開催日）の開始 instant。JST の正午として置く（会期は暦日で持っていて、
   *  時刻は持たない）。会期が決まっていない行は `NaN` – その行は並びの末尾に置く
   *  （SPEC §7）。 */
  tEvent: number;
  dateOnly?: boolean;
  localDate?: string;
  cats: string[];
  categories?: string[];
  tags: string[];
  rankPairs: string[];
  hay: string;
  dupLabel?: string;
  name?: string;
  year?: number | null;
  _matchScore?: number;
}

interface ConferenceHay {
  key: string;
  title: string;
  full: string;
  tags: string[];
  jp: string[];
  papers: string[];
  acronym: string[];
  scope: string[];
  categories: string[];
  paperAbstracts: string[];
  keywords: string[];
}

type SignalScores = Record<"domain" | "name" | "paper" | "jp" | "tags" | "venue", number>;
type FieldName =
  | "acronym"
  | "full_name"
  | "scope"
  | "tags"
  | "categories"
  | "representative_papers"
  | "paper_title"
  | "paper_abstract"
  | "keywords";
type FieldScores = Record<FieldName, number>;
type FieldRanks = Partial<Record<FieldName, number>>;
interface LineScore {
  score: number;
  venueHit: boolean;
  details: SignalScores;
  fieldScores: FieldScores;
}
interface PaperWeight {
  role: "primary" | "reference";
  weight: number;
}
interface LineEvidence extends LineScore, PaperWeight {
  lineIndex?: number;
  rank?: number;
  key?: string;
}
interface SignalEvidence {
  type: string;
  contribution: number;
  rank?: number;
}
interface ScoreBreakdown {
  score: number;
  topicScore: number;
  venueScore: number;
  venueHit: boolean;
  perLine: LineEvidence[];
  evidence: LineEvidence[];
  signalEvidence?: SignalEvidence[];
  agg: SignalScores & { venueName?: number };
  fieldScores: FieldScores;
}
type Confidence = "sufficient" | "ambiguous" | "insufficient";
interface RecommendationOptions {
  venueCats?: string[];
  topN?: number;
  fieldedLexical?: boolean;
  semanticSimilarities?: Record<string, number> | null;
}
interface RecommendationEntry {
  key: string;
  row: CandidateRow;
  match: ScoreBreakdown;
  retrievalFields: FieldScores;
  lexicalScore: number;
  semantic: number;
  similarity: number;
  evidenceStrength: number;
  boosted: boolean;
}
interface RecommendationResult {
  venueKey: string;
  row: CandidateRow;
  fit: {
    score: number;
    rankingScore: number;
    evidenceStrength: number;
    confidence: Confidence;
    label: string;
    lexicalScore: number;
    fieldScores: FieldScores;
    fieldRanks: FieldRanks;
    fieldRrf: number;
    semanticScore: number;
    lexicalRank: number | null;
    semanticRank: number | null;
    rrf: number;
    evidence: Array<SignalEvidence | LineEvidence>;
    confidenceScore: number;
    queryConfidence: {
      top1Score: number;
      top2Score: number;
      margin: number;
      top5Entropy: number;
      lexicalSemanticAgreement: number;
      candidateCoverage: number;
      inputHasAbstract: number;
      inputTokenCount: number;
      calibrated: boolean;
    };
    /** Compatibility alias; not rendered as a probability in the UI. */
    probability: number;
    baseScore: number;
    rerankerFeatures: RerankerFeatures;
  };
  availability: Availability;
  match: ScoreBreakdown;
  boosted: boolean;
}

interface LinearRerankerModel {
  version: 1;
  algorithm_revision: string;
  feature_schema: string[];
  intercept: number;
  weights: Record<string, number>;
  blend: number;
  confidence_thresholds: { sufficient: number; ambiguous: number };
  /** 精度保証が取れるまで sufficient 表示は無効 (UI は 候補/重なりうすい の2段階)。 */
  confidence_policy: { sufficient_enabled: boolean };
  calibration?: { method: "platt"; slope: number; intercept: number };
}

export function isValidRerankerModel(value: unknown): value is LinearRerankerModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<LinearRerankerModel>;
  const thresholds = model.confidence_thresholds;
  const calibration = model.calibration;
  return Boolean(
    model.version === 1 &&
      model.algorithm_revision === RERANKER_ALGORITHM_REVISION &&
      Array.isArray(model.feature_schema) &&
      model.feature_schema.join("\0") === RERANKER_FEATURE_SCHEMA.join("\0") &&
      Number.isFinite(model.intercept) &&
      model.weights !== null &&
      typeof model.weights === "object" &&
      Object.keys(model.weights).join("\0") === RERANKER_FEATURE_SCHEMA.join("\0") &&
      Object.values(model.weights).every(Number.isFinite) &&
      Number.isFinite(model.blend) &&
      model.blend! >= 0 &&
      model.blend! <= 1 &&
      thresholds !== null &&
      typeof thresholds === "object" &&
      Number.isFinite(thresholds.sufficient) &&
      Number.isFinite(thresholds.ambiguous) &&
      thresholds.ambiguous >= 0 &&
      thresholds.sufficient <= 1 &&
      thresholds.ambiguous <= thresholds.sufficient &&
      model.confidence_policy !== null &&
      typeof model.confidence_policy === "object" &&
      typeof model.confidence_policy.sufficient_enabled === "boolean" &&
      (calibration === undefined ||
        (calibration !== null &&
          typeof calibration === "object" &&
          calibration.method === "platt" &&
          Number.isFinite(calibration.slope) &&
          Number.isFinite(calibration.intercept))),
  );
}
interface Availability {
  kind: string;
  status: "ongoing" | "uncertain" | "open" | "past" | "unknown";
  timestamp: number | null;
  local_date: string | null;
  date_state: "definitely-future" | "uncertain-on-date" | "definitely-past" | null;
  estimated: boolean;
}
interface PdfItem {
  str?: string;
  transform?: number[];
  height?: number;
  width?: number;
}
interface PdfLine {
  text: string;
  x: number;
  y: number;
  right: number;
  height: number;
  items: PdfItem[];
}
interface EmbeddingProbe {
  text?: string;
  vector?: Vector;
}
interface EmbeddingModelMeta {
  model?: string;
  revision?: string;
  dim?: number;
  probe?: EmbeddingProbe;
}
interface EmbeddingSet {
  model?: string;
  dim?: number;
  embeddings?: VectorMap;
}
interface EmbeddingBundle extends EmbeddingSet {
  manifest?: {
    schema?: number;
    profile_hash?: string;
    keys?: string[];
    models?: Record<string, EmbeddingModelMeta>;
  };
  multi?: EmbeddingSet;
}

function parsedInstant(value: unknown): number | null {
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? time : null;
}

/** Same bounds as src/model.ts dateOnlyWindow: UTC midnight -14h .. +36h-1ms. */
function dateOnlyWindowMs(localDate: unknown): { start: number; end: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(localDate ?? "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const startOfDay = Date.UTC(year, month - 1, day);
  const date = new Date(startOfDay);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return {
    start: startOfDay - 14 * 3_600_000,
    end: startOfDay + 36 * 3_600_000 - 1,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPdfItem(value: unknown): value is PdfItem {
  return (
    isRecord(value) &&
    (value.str === undefined || typeof value.str === "string") &&
    (value.height === undefined ||
      (typeof value.height === "number" && Number.isFinite(value.height))) &&
    (value.width === undefined ||
      (typeof value.width === "number" && Number.isFinite(value.width))) &&
    (value.transform === undefined ||
      (Array.isArray(value.transform) &&
        value.transform.every((item) => typeof item === "number" && Number.isFinite(item))))
  );
}

function isConference(value: unknown): value is ConferenceRecord {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    (value.editions === undefined ||
      (Array.isArray(value.editions) && value.editions.every(isEdition))) &&
    (value.categories === undefined ||
      (Array.isArray(value.categories) &&
        value.categories.every((item) => typeof item === "string"))) &&
    (value.tags === undefined ||
      (Array.isArray(value.tags) && value.tags.every((item) => typeof item === "string"))) &&
    (value.papers === undefined ||
      (Array.isArray(value.papers) && value.papers.every((item) => typeof item === "string")))
  );
}

function normalizedStrings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

function normalizeConference(value: unknown): ConferenceRecord | null {
  if (!isRecord(value)) return null;
  const rank: Record<string, string> = {};
  if (isRecord(value.rank)) {
    for (const [key, item] of Object.entries(value.rank)) {
      if (typeof item === "string") rank[key] = item;
    }
  }
  return {
    key: typeof value.key === "string" ? value.key : "",
    link: typeof value.link === "string" ? value.link : undefined,

    recommendation_axes: isRecord(value.recommendation_axes)
      ? value.recommendation_axes
      : undefined,
    title: typeof value.title === "string" ? value.title : "",
    full_name: typeof value.full_name === "string" ? value.full_name : "",
    categories: normalizedStrings(value.categories),
    tags: normalizedStrings(value.tags),
    papers: normalizedStrings(value.papers),
    acronym: typeof value.acronym === "string" ? value.acronym : undefined,
    scope: normalizedStrings(value.scope),
    official_scope: normalizedStrings(value.official_scope),
    paper_abstracts: normalizedStrings(value.paper_abstracts),
    keywords: normalizedStrings(value.keywords),
    rank,
    editions: Array.isArray(value.editions) ? value.editions.filter(isEdition) : [],
  };
}

function normalizeCandidateLike(value: unknown): CandidateRow | null {
  if (!isRecord(value)) return null;
  const conf = normalizeConference(value.conf) ?? normalizeConference(value);
  if (!conf) return null;
  return {
    conf,
    ed: isEdition(value.ed) ? value.ed : {},
    dl: isDeadline(value.dl) ? value.dl : {},
    kind: typeof value.kind === "string" ? value.kind : "other",
    est: Boolean(value.est),
    t: typeof value.t === "number" ? value.t : 0,
    // 旧い呼び出し側が `tShown` を持たない場合は `t` に寄せる（行を落とさない）。
    tShown:
      typeof value.tShown === "number" ? value.tShown : typeof value.t === "number" ? value.t : 0,
    // 会期の開始。持たない呼び出し側からも作れるように、無いときは「未確認」の形にする。
    tEvent: typeof value.tEvent === "number" ? value.tEvent : Number.NaN,
    tLast: typeof value.tLast === "number" ? value.tLast : 0,
    dateOnly: Boolean(value.dateOnly),
    localDate: typeof value.localDate === "string" ? value.localDate : "",
    cats: normalizedStrings(value.cats ?? value.categories ?? conf.categories),
    categories: normalizedStrings(value.categories),
    tags: normalizedStrings(value.tags ?? conf.tags),
    rankPairs: normalizedStrings(value.rankPairs),
    hay: typeof value.hay === "string" ? value.hay : "",
    submission:
      isRecord(value.submission) &&
      typeof value.submission.issueLabel === "string" &&
      typeof value.submission.language === "string" &&
      Array.isArray(value.submission.shareAliases) &&
      Array.isArray(value.submission.sourceRecords)
        ? (value.submission as unknown as SubmissionDisplay)
        : undefined,
    dupLabel: typeof value.dupLabel === "string" ? value.dupLabel : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
    year: typeof value.year === "number" || value.year === null ? value.year : undefined,
  };
}

function isDeadline(value: unknown): value is DeadlineRecord {
  return isRecord(value) && (value.kind === undefined || typeof value.kind === "string");
}

function isEdition(value: unknown): value is EditionRecord {
  return (
    isRecord(value) &&
    (value.deadlines === undefined ||
      (Array.isArray(value.deadlines) && value.deadlines.every(isDeadline)))
  );
}

const Recommender = (() => {
  /* 既存 template.html の DOMAIN_SIGNAL と同一（ここが正典）
   * 変更時は template.html 側の重複定義も同じ内容に保つこと。 */
  const DOMAIN_SIGNAL: Record<string, string[]> = {
    hpc: [
      "hpc",
      "supercomputing",
      "high performance computing",
      "high-performance computing",
      "scasia",
      "hpcasia",
      "parallel",
      "gpu",
      "fpga",
      "cuda",
      "mpi",
      "interconnect",
      "cluster",
      "llm inference",
      "ハイパフォーマンス",
      "スーパーコンピュータ",
      "並列",
      "高性能計算",
      "高性能",
      "スパコン",
      "アクセラレータ",
      "クラスタ",
      "集団通信",
      "xsig",
    ],
    systems: [
      "storage",
      "nvme",
      "cxl",
      "rdma",
      "kernel",
      "operating system",
      "memory",
      "virtual",
      "compiler",
      "real-time",
      "realtime",
      "embedded",
      "deterministic",
      "tsn",
      "ストレージ",
      "カーネル",
      "分散システム",
      "分散",
      "並列処理",
      "ミドルウェア",
      "オペレーティングシステム",
      "スケジューリング",
      "スケジューラ",
      "仮想化",
      "コンテナ",
      "省電力",
      "アーキテクチャ",
      "キャッシュ",
      "プロセッサ",
      "xsig",
    ],
    networking: [
      "network",
      "networking",
      "ethernet",
      "sdn",
      "p4",
      "protocol",
      "wireless",
      "5g",
      "routing",
      "bpf",
      "ebpf",
      "packet",
      "ネットワーク",
      "通信",
      "ルーティング",
      "無線",
    ],
    ai: [
      "machine learning",
      "deep learning",
      "neural",
      "sysml",
      "gnn",
      "transformer",
      "llm",
      "ai",
      "機械学習",
      "深層学習",
      "ニューラル",
      "生成",
    ],
    security: [
      "security",
      "privacy",
      "crypto",
      "vulnerability",
      "binary",
      "enclave",
      "sgx",
      "confidential",
      "セキュリティ",
      "プライバシー",
      "暗号",
      "scis",
      "脆弱性",
      "認証",
    ],
    db: [
      "database",
      "query",
      "sql",
      "index",
      "data mining",
      "data management",
      "key-value",
      "oltp",
      "olap",
      "vector",
      "データベース",
      "クエリ",
      "データマイニング",
    ],
    graphics: [
      "graphics",
      "rendering",
      "mesh",
      "animation",
      "multimedia",
      "video",
      "audio",
      "image processing",
      "computer vision",
      "3d",
      "ビジュアライゼーション",
      "可視化",
      "映像",
      "グラフィックス",
    ],
    hci: [
      "human-computer",
      "user interface",
      "usability",
      "interaction",
      "accessibility",
      "touch",
      "augmented reality",
      "virtual reality",
      "ヒューマン",
      "ユーザインタフェース",
      "ユーザビリティ",
    ],
    theory: [
      "algorithm",
      "complexity",
      "automata",
      "graph theory",
      "approximation",
      "lower bound",
      "combinatorial",
      "formal",
      "verification",
      "アルゴリズム",
      "計算量",
      "複雑性",
    ],
  };

  const STOPWORDS = new Set(
    (
      "a an and or the of for in on to with via using based towards toward using design implementation " +
      "analysis study novel can we our this that from at by as is are be it its their these those paper papers " +
      "new towards between within across over under both each more most than then thus also such when while " +
      "which who what how why not no nor only into onto upon about above below out off they them he she his " +
      "her you your i me my mine do does did has have had will would could should may might must shall there " +
      "here been being was were am if else whether either neither yet still already just even though although " +
      "because system systems network networks conference symposium workshop international annual proceedings " +
      "ieee acm usenix journal letters transactions magazine association machinery electronics engineers " +
      "special interest group review about applications application computer computing science institute technical " +
      // 会議名によく出るが内容語としては弱い語（Signal Processing 等の誤爆防止）
      "processing technology advanced modern research recent emerging " +
      // 特集号タイトルの "Special Issue" が special issue を含むクエリを浚う誤爆防止
      "issue issues"
    ).split(/\s+/),
  );

  const JP_STOPWORDS = new Set([
    "における",
    "について",
    "に関する",
    "に対する",
    "関する",
    "対する",
    "による",
    "および",
    "または",
    "これら",
    "それら",
    "そのため",
    "用いた",
    "向けた",
    "行った",
    "提案する",
    "検討する",
    "評価する",
    "ための",
    "などの",
    "に基づく",
    "基づく",
    "向け",
    "よる",
    "関して",
    "あたり",
    "当たって",
    "おける",
    "伴う",
    "対して",
  ]);

  /* 1行: "タイトル | キーワード | 掲載先(任意)" または "タイトル<TAB>キーワード<TAB>掲載先" */
  function parsePaperLines(text: unknown): PaperRecord[] {
    if (!text) return [];
    const structured = parseStructuredPapers(text);
    if (structured) return structured;
    return String(text)
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        let parts = line.split(/\s*\|\s*/);
        if (parts.length === 1) parts = line.split("\t");
        return {
          title: (parts[0] || "").trim(),
          keywords: (parts[1] || "").trim(),
          venue: (parts[2] || "").trim(),
        };
      })
      .filter((paper) => Boolean(paper.title));
  }

  /* 投稿先を探す画面の貼り付け欄は、説明が日本語（「タイトルと概要を下の欄に貼り付けて
   * ください」）なので、項目名も日本語で書いた物が来る。以前は英語の項目名しか見ておらず、
   * 「タイトル:」「概要:」と書かれた 1 論文が各行に分裂して、ラベルごと title に入る
   * 壊れた候補が並んでいた（2026-08-09 実測: 英語ラベルは 1 論文に読めるのに、日本語ラベル
   * の同じ内容は 4 論文に化け、それぞれ title="タイトル: …" のようになった）。
   * 表記の揺れ（全角コロン・「keyword」と「keywords」）も吸収する。 */
  const PAPER_FIELD_ALIASES_JA: Record<string, string> = {
    タイトル: "title",
    表題: "title",
    標題: "title",
    題目: "title",
    題名: "title",
    論文名: "title",
    概要: "abstract",
    抄録: "abstract",
    要旨: "abstract",
    アブストラクト: "abstract",
    キーワード: "keywords",
    検索語: "keywords",
    掲載先: "venue",
    投稿先: "venue",
    掲載学会: "venue",
    ベニュー: "venue",
    会議名: "venue",
  };
  const PAPER_FIELD_ESCAPED = Object.keys(PAPER_FIELD_ALIASES_JA).map((label) =>
    label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const PAPER_FIELD_RE_JA = new RegExp(
    `^[\\s　]*(title|abstract|keywords?|venue|${PAPER_FIELD_ESCAPED.join("|")})[\\s　]*[:：][\\s　]*(.*)$`,
    "i",
  );
  function paperFieldKeyJa(label: string): string {
    const lower = label.toLowerCase();
    if (lower === "keyword") return "keywords";
    if (PAPER_FIELD_ALIASES_JA[label]) return PAPER_FIELD_ALIASES_JA[label];
    if (["title", "abstract", "keywords", "venue"].indexOf(lower) >= 0) return lower;
    return "";
  }

  function parseStructuredPapers(text: unknown): PaperRecord[] | null {
    const raw = String(text).trim();
    if (!raw) return [];
    if (raw[0] === "{" || raw[0] === "[") {
      try {
        const parsed: unknown = JSON.parse(raw);
        const records = Array.isArray(parsed) ? parsed : [parsed];
        const jsonRows = records
          .map(normalizePaperRecord)
          .filter((paper): paper is PaperRecord => paper !== null);
        return jsonRows;
      } catch (_error) {
        return null;
      }
    }
    // タイトルラベルが 1 つも無ければ構造化入力ではないとみなす（表形式の生テキストを
    // 壊さないため。英語・日本語のどちらのタイトル表記でも通す）。
    const lines = raw.split(/\r?\n/);
    if (
      !lines.some((line) => {
        const match = PAPER_FIELD_RE_JA.exec(line);
        return match && paperFieldKeyJa(match[1]) === "title";
      })
    )
      return null;
    const fields: Record<string, string> = { title: "", abstract: "", keywords: "", venue: "" };
    const papers: PaperRecord[] = [];
    const finish = () => {
      const paper = normalizePaperRecord(fields);
      if (paper) papers.push(paper);
      for (const key of Object.keys(fields)) fields[key] = "";
    };
    let current = "";
    let hasTitle = false;
    lines.forEach((line) => {
      const match = PAPER_FIELD_RE_JA.exec(line);
      if (match) {
        current = paperFieldKeyJa(match[1]);
        if (!current) return;
        if (current === "title") {
          if (hasTitle) finish();
          hasTitle = true;
        }
        fields[current] = match[2].trim();
      } else if (current && line.trim()) {
        fields[current] += (fields[current] ? "\n" : "") + line.trim();
      }
    });
    finish();
    return papers.length ? papers : null;
  }

  function pdfPages(pages: unknown): unknown[][] {
    return Array.isArray(pages) && Array.isArray(pages[0])
      ? pages.map((page) => (Array.isArray(page) ? page : []))
      : [Array.isArray(pages) ? pages : []];
  }

  function pdfFontSize(item: PdfItem): number {
    return (
      Math.hypot(Number(item.transform?.[0]) || 0, Number(item.transform?.[1]) || 0) ||
      Math.abs(Number(item.height) || 0)
    );
  }

  function pdfPageLines(items: unknown[]): PdfLine[] {
    const runs = items.filter(isPdfItem).filter((item) => String(item.str || "").trim());
    const horizontal = runs.filter(
      (item) =>
        Math.abs(Number(item.transform?.[1]) || 0) <=
        Math.abs(Number(item.transform?.[0]) || 0) * 0.1,
    );
    const selected = horizontal.length ? horizontal : runs;
    const positioned = selected
      .map((item, index) => ({
        item,
        x: Number(item.transform?.[4]) || 0,
        y: Number.isFinite(item.transform?.[5]) ? Number(item.transform?.[5]) : -index * 100,
        height: pdfFontSize(item),
      }))
      .sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: Array<{ y: number; height: number; runs: typeof positioned }> = [];
    for (const run of positioned) {
      let row = rows.find(
        (candidate) =>
          Math.abs(candidate.y - run.y) <=
          Math.max(2, Math.max(candidate.height, run.height) * 0.25),
      );
      if (!row) {
        row = { y: run.y, height: run.height, runs: [] };
        rows.push(row);
      }
      row.height = Math.max(row.height, run.height);
      row.runs.push(run);
    }
    const rowLines = rows.map((row) => {
      const segments: PdfLine[] = [];
      let previous: (typeof positioned)[number] | undefined;
      for (const run of row.runs.sort((a, b) => a.x - b.x)) {
        const widthKnown = Number.isFinite(run.item.width) && Number.isFinite(previous?.item.width);
        const gap = previous ? run.x - previous.x - Number(previous.item.width) : 0;
        let line = segments[segments.length - 1];
        if (!line || (widthKnown && gap > Math.max(2, row.height * 0.8))) {
          line = { text: "", x: run.x, y: row.y, right: run.x, height: row.height, items: [] };
          segments.push(line);
        }
        const space =
          line.text &&
          (!widthKnown ||
            gap > Math.max(0.5, Math.min(run.height, previous?.height || run.height) * 0.15))
            ? " "
            : "";
        line.text +=
          space +
          String(run.item.str || "")
            .replace(/\s+/g, " ")
            .trim();
        line.right = Math.max(line.right, run.x + (Number(run.item.width) || 0));
        line.items.push(run.item);
        previous = run;
      }
      return segments;
    });
    const all = rowLines.flat();
    if (!all.length) return [];
    const combine = (parts: PdfLine[]): PdfLine => ({
      ...parts[0],
      text: parts.map((line) => line.text).join(" "),
      right: Math.max(...parts.map((line) => line.right)),
      items: parts.flatMap((line) => line.items),
    });
    const center =
      (Math.min(...all.map((line) => line.x)) + Math.max(...all.map((line) => line.right))) / 2;
    const gutters = rowLines.filter((lines) =>
      lines.some((line, index) => index > 0 && lines[index - 1].right < center && line.x > center),
    );
    // 繰り返し現れる中央の空白を段間とみなし、単発の広い語間とは区別する。
    if (gutters.length < 3 || gutters.length < rowLines.length * 0.15) return rowLines.map(combine);
    const ordered: PdfLine[] = [],
      left: PdfLine[] = [],
      right: PdfLine[] = [];
    const flush = () => {
      ordered.push(...left, ...right);
      left.length = 0;
      right.length = 0;
    };
    for (const lines of rowLines) {
      if (lines.some((line) => line.x < center && line.right > center)) {
        flush();
        ordered.push(combine(lines));
      } else {
        const leftParts = lines.filter((line) => line.x < center);
        const rightParts = lines.filter((line) => line.x >= center);
        if (leftParts.length) left.push(combine(leftParts));
        if (rightParts.length) right.push(combine(rightParts));
      }
    }
    flush();
    return ordered;
  }

  function pdfTextLines(pages: unknown): string[] {
    return pdfPages(pages).flatMap((page) => pdfPageLines(page).map((line) => line.text));
  }

  function pdfJoinLines(lines: string[]): string {
    return lines.filter(Boolean).reduce((text, line) => {
      const adjacentJapanese =
        /[\u3040-\u30ff\u3400-\u9fff]$/.test(text) || /^[\u3040-\u30ff\u3400-\u9fff]/.test(line);
      return text + (text && !adjacentJapanese ? " " : "") + line;
    }, "");
  }

  function pdfPaperRecord(metadata: unknown, pages: unknown, fallbackText: unknown): PaperRecord {
    const pageList = pdfPages(pages);
    const positioned = pageList.map(pdfPageLines);
    const layout = positioned.flatMap((lines, page) => lines.map((line) => ({ ...line, page })));
    const lines = layout.map((line) => line.text);
    const metadataRecord = isRecord(metadata) ? metadata : {};
    const info = isRecord(metadataRecord.info) ? metadataRecord.info : metadataRecord;
    let title = String(info.Title || info.title || "").trim();
    if (!title) {
      const first = positioned[0] || [];
      const max = Math.max(0, ...first.flatMap((line) => line.items.map(pdfFontSize)));
      if (max > 0)
        title = pdfJoinLines(
          first
            .filter((line) => line.items.some((item) => pdfFontSize(item) >= max * 0.9))
            .map((line) => line.text),
        );
    }
    if (!title) title = lines[0] || String(fallbackText || "").trim();
    title = title.replace(/\s+/g, " ").slice(0, 240);
    const abstractLabel = /^(?:abstract\b|概要|要旨|抄録|あらまし)\s*[:：.\-—–]?\s*/i;
    const keywordsLabel = /^(?:keywords?\b|index terms\b|キーワード)\s*[:：.\-—–]?\s*/i;
    const section =
      /^(?:(?:\d+(?:\.\d+)*\.?|[IVX]+\.)\s*)?(?:introduction\b|references\b|はじめに|序論|参考文献)/i;
    const abstractAt = lines.findIndex((line) => abstractLabel.test(line));
    const keywordsAt = lines.findIndex((line) => keywordsLabel.test(line));
    const content = (start: number, label: RegExp) => {
      if (start < 0) return "";
      const result = [lines[start].replace(label, "").trim()];
      for (let index = start + 1; index < lines.length; index++) {
        if (
          section.test(lines[index]) ||
          abstractLabel.test(lines[index]) ||
          keywordsLabel.test(lines[index])
        )
          break;
        if (label === keywordsLabel) {
          const previous = layout[index - 1];
          const next = layout[index];
          if (
            next.page !== previous.page ||
            previous.y - next.y > Math.max(3, previous.height * 1.8) ||
            next.y > previous.y + 2 ||
            Math.abs(next.x - previous.x) > Math.max(12, previous.height * 2)
          )
            break;
        }
        result.push(lines[index]);
      }
      return pdfJoinLines(result);
    };
    return {
      title,
      abstract: content(abstractAt, abstractLabel).slice(0, 6000),
      keywords: content(keywordsAt, keywordsLabel).slice(0, 1000),
      venue: "",
    };
  }

  function normalizePaperRecord(record: unknown): PaperRecord | null {
    if (!isRecord(record)) return null;
    const value = (name: string): unknown => record[name] ?? "";
    const list = (name: string) => {
      const item = value(name);
      return Array.isArray(item) ? item.filter(Boolean).join(", ") : String(item || "").trim();
    };
    const title = String(value("title") || value("title_text") || value("name") || "").trim();
    const abstract = String(value("abstract") || value("summary") || "").trim();
    if (!title && !abstract) return null;
    return {
      title: title,
      abstract,
      keywords: list("keywords") || list("keyword"),
      venue: String(value("venue") || value("conference") || "").trim(),
    };
  }

  function textPaperRecord(text: unknown, fallbackText: unknown): PaperRecord {
    const raw = String(text || "").trim();
    const structured = parseStructuredPapers(raw);
    if (structured?.length) return structured[0];
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const title = lines.shift() || String(fallbackText || "").trim();
    return {
      title: title.slice(0, 240),
      abstract: lines.join(" ").slice(0, 6000),
      keywords: "",
      venue: "",
    };
  }

  function paperText(p: PaperRecord): string {
    return [p?.title, p?.abstract, p?.keywords].filter(Boolean).join(" ").trim();
  }

  function paperIdentity(p: PaperRecord): string {
    const title = String(p?.title || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (title) return title;
    return [p?.abstract, p?.keywords]
      .map((value) =>
        String(value || "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter(Boolean)
      .join("\u0001");
  }

  function paperWeights(lines: readonly PaperRecord[]): PaperWeight[] {
    const seen = new Set<string>();
    let referenceTotal = 0;
    return lines.map((paper, index) => {
      const id = paperIdentity(paper);
      if (index === 0) {
        if (id) seen.add(id);
        return { role: "primary", weight: 1 };
      }
      if (!id || seen.has(id) || referenceTotal >= 0.4) {
        return { role: "reference", weight: 0 };
      }
      seen.add(id);
      const weight = Math.min(0.2, 0.4 - referenceTotal);
      referenceTotal += weight;
      return { role: "reference", weight: weight };
    });
  }

  /* 掲載先・会議名の照合用正規化。機能語（the/of/and/& 等）を除いて
   * 「Security & Privacy」と「Security and Privacy」のような表記ゆれを吸収する。
   * 両側（venue 側・会議側）を同じ規則で正規化するので一致判定は一貫する。
   */
  const FILLER = /\b(a|an|the|and|or|of|for|in|on|at|to|by|with)\b/g;
  function normKey(s: unknown): string {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, " ")
      .replace(FILLER, " ")
      .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, " ")
      .trim();
  }

  /* 掲載先タグの略称エイリアス: 正規化した venue 文字列 → 会議 key のリスト。
   * 例: 「SP」は 2 文字のため完全一致（key）しか効かず、key "s-p" には一致しない。
   * 「s&p」→「s p」はタイトル正規化で拾えるためエイリアス不要。
   */
  const VENUE_ALIASES: Record<string, string[]> = {
    sp: ["s-p"], // IEEE Symposium on Security & Privacy
    snp: ["s-p"],
  };

  /* 会議名/代表論文語彙マッチングの IDF 重み表 {name: {word: 0..1}, paper: {word: 0..1}}
   * （null なら一律 15 点）。会議名での出現頻度が高い語（network 等）は加点を抑え、
   * 希少語（deterministic 等）を重くする。papers 語は papers 側の df（汎用語が広く
   * 出現する）で減衰する。ブラウザ/ベンチが setNameIdf で設定する（会議集合は
   * 実行時にしか分からない）。
   */
  let idfMap: { name: Record<string, number>; paper: Record<string, number> } | null = null;
  function setNameIdf(map: { name: Record<string, number>; paper: Record<string, number> } | null) {
    idfMap = map || null;
  }

  /* skipEmb 会議（rtss/ecrts/usenix-security）の論文個別ベクトル表。
   * semanticScore が max 類似度を取るときに使う。英語クエリのみ（多言語モデルの
   * クエリに英語モデルの論文ベクトルを混ぜると言語別分離設計を壊す）。
   * null なら会議名ベクトルのみ使う。
   */
  let paperVecsState: PaperVectorMap | null = null;
  let topicVecsState: PaperVectorMap | null = null;
  function setTopicVecs(vectors: PaperVectorMap | null) {
    topicVecsState = vectors;
  }
  function setPaperVecs(pv: PaperVectorMap | null) {
    paperVecsState = pv || null;
  }

  /* 全会議から IDF 重み表を作る… – 実測と理由は第 723 回に SPEC へ送つた。*/
  function buildNameIdf(confs: unknown): {
    name: Record<string, number>;
    paper: Record<string, number>;
  } {
    const nameDf: Record<string, number> = {};
    const paperDf: Record<string, number> = {};
    const safeConfs = Array.isArray(confs)
      ? confs.map(normalizeConference).filter((conf): conf is ConferenceRecord => conf !== null)
      : [];
    safeConfs.forEach((c) => {
      const seenName: Record<string, boolean> = {};
      const seenPaper: Record<string, boolean> = {};
      normKey(`${c.title || ""} ${c.full_name || ""}`)
        .split(" ")
        .forEach((word) => {
          const w = word;
          if (w.length > 3 && !STOPWORDS.has(w) && !seenName[w]) {
            seenName[w] = true;
            nameDf[w] = (nameDf[w] || 0) + 1;
          }
        });
      const papers = c.papers || [];
      papers.forEach((title) => {
        normKey(title || "")
          .split(" ")
          .forEach((word) => {
            const w = word;
            if (w.length > 3 && !STOPWORDS.has(w) && !seenPaper[w]) {
              seenPaper[w] = true;
              paperDf[w] = (paperDf[w] || 0) + 1;
            }
          });
      });
    });
    const N = safeConfs.length;
    const idfOf = (d: number) => (N <= 0 ? 0 : Math.log(1 + N / (d + 1)) / Math.log(1 + N));
    const mk = (df: Record<string, number>) => {
      const out: Record<string, number> = {};
      Object.keys(df).forEach((w) => {
        out[w] = idfOf(df[w]);
      });
      return out;
    };
    return { name: mk(nameDf), paper: mk(paperDf) };
  }

  /* サブシグナルの内部点数。実測スイープ結果:
   *   - domain/name/tags/venue は 15/15/10/40 が最適。増減とも悪化
   *     （name=25: -2.7, name=10: -0.4/-1.6, domain=30: top5 -0.9, tags=0: -0.7）
   *   - jp は 15→30 で日本語ゴールデン top1 +2.8pt、EN/JP synthetic は不変
   *     （日本語チャンク一致は日本語クエリでのみ発火するため EN に影響なし）
   *   - paper（代表採択論文語彙）は name と同額の 15 が最適。
   *     低い値は golden EN を大きく損なう（paper=10 で top5 66.7→57.8）。
   * setSigWeights({domain:.., name:.., paper:.., jp:.., tags:.., venue:.., nameOnce: bool}) で
   * ブラウザ/ベンチから上書きできる。nameOnce は会議名一致を「先頭 1 語のみ固定加点」
   * （語数に比例させない）にする実験用フラグ。
   */
  const SIG_WEIGHTS: Record<string, number | boolean> & {
    domain: number;
    name: number;
    paper: number;
    paperCap: number;
    jp: number;
    tags: number;
    venue: number;
    nameOnce: boolean;
  } = {
    domain: 15,
    name: 15,
    paper: 15,
    paperCap: 4,
    jp: 30,
    tags: 10,
    venue: 40,
    nameOnce: false,
  };
  function setSigWeights(w: Partial<typeof SIG_WEIGHTS> | null) {
    if (!w) return;
    Object.keys(SIG_WEIGHTS).forEach((k) => {
      // nameOnce は boolean フラグ（先頭 1 語固定加点）なので boolean も適用する。
      // SIG_WEIGHTS の他キーは全て数値で、boolean を許可しても混入しない。
      const value = w[k];
      if (typeof value === "number" || typeof value === "boolean") SIG_WEIGHTS[k] = value;
    });
  }

  /* メタデータタグ（本文の英単語と偶然一致して誤加点する汎用語）。
   * workshop(36 会議)/journal(18)/niche(43)/domestic-jp/special-issue は
   * トピックではなく属性のため、tags 語彙一致から除外する（トピックタグは残す）。
   */
  const GENERIC_TAGS = new Set([
    "niche",
    "workshop",
    "domestic-jp",
    "journal",
    "special-issue",
    "niche-jp",
  ]);

  /* 代表採択論文語彙（conf.papers）のマッチで除外する汎用語。
   * 名前語の STOPWORDS とは別 — 論文タイトルに頻出するが会議の識別に寄与しない語。
   * rtss の papers 語彙（self/general/framework 等）が data2vec クエリに
   * 5 ヒット（self/general/framework/vision/language）して 49 点を稼ぎ、sem が効く
   * icml（vocab 48 + sem 9）を blendScore の減衰で下回って top1 を奪った。
   * vision/language 等は会議名では識別語だが papers では汎用 — マッチ元が papers な
   * のでここで除外しても名前語マッチ（nameWords）には影響しない。
   */
  const GENERIC_PAPER_WORDS = new Set([
    "self",
    "general",
    "framework",
    "approach",
    "method",
    "based",
    "using",
    "towards",
    "improving",
    "understanding",
    "learning",
    "analysis",
    "study",
    "design",
    "performance",
    // efficient/scalable は論文タイトル頻出語で df が高く
    // IDF で自然減衰される。GENERIC に入れると正当なマッチ（Carbon-efficient ↔ papers の
    // efficient 等）まで消し、GREEN→nsdi の golden が top5 から脱落した（実測）。
  ]);

  const FIELD_WEIGHTS: Record<FieldName, number> = {
    acronym: 3,
    full_name: 2.5,
    scope: 1.5,
    tags: 1.5,
    categories: 1,
    representative_papers: 1.5,
    paper_title: 1.5,
    paper_abstract: 1,
    keywords: 1.2,
  };
  const FIELD_NAMES = Object.keys(FIELD_WEIGHTS) as FieldName[];

  const jaSegmenter =
    typeof Intl !== "undefined" && Intl.Segmenter
      ? new Intl.Segmenter("ja", { granularity: "word" })
      : null;

  const JP_ORG_STOP =
    /(?:情報処理学会|電子情報通信学会|情報処理|電子情報通信|研究会|シンポジウム|特集号|論文誌|学会|信学技報|ワークショップ)/gu;

  const JP_PAPER_GENERIC = new Set([
    "研究",
    "開発",
    "提案",
    "手法",
    "評価",
    "実装",
    "解析",
    "実験",
    "検討",
    "考察",
    "情報",
    "処理",
    "論文",
    "システム",
  ]);

  function extractDistinctiveJpTerms(raw: unknown): string[] {
    const text = String(raw ?? "").toLowerCase();
    if (!text) return [];
    const terms = new Set<string>();
    // Katakana: full sequences of length >= 3
    for (const m of text.match(/[\u30a0-\u30ff\u30fc]{3,}/g) ?? []) {
      if (!JP_STOPWORDS.has(m) && !JP_PAPER_GENERIC.has(m)) terms.add(m);
    }
    // Kanji: 2-kanji and 4-kanji decomposed
    for (const m of text.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
      if (!JP_STOPWORDS.has(m) && !JP_PAPER_GENERIC.has(m)) {
        terms.add(m);
        if (m.length === 4) {
          const sub1 = m.slice(0, 2);
          const sub2 = m.slice(2, 4);
          if (!JP_STOPWORDS.has(sub1) && !JP_PAPER_GENERIC.has(sub1)) terms.add(sub1);
          if (!JP_STOPWORDS.has(sub2) && !JP_PAPER_GENERIC.has(sub2)) terms.add(sub2);
        }
      }
    }
    if (jaSegmenter) {
      for (const item of jaSegmenter.segment(text)) {
        const seg = item.segment.trim();
        if (/^[\u30a0-\u30ff\u30fc]+$/.test(seg)) continue;
        if (
          item.isWordLike &&
          seg.length >= 2 &&
          !JP_STOPWORDS.has(seg) &&
          !JP_PAPER_GENERIC.has(seg)
        ) {
          terms.add(seg);
        }
      }
    }
    return [...terms];
  }

  const lexicalTermCache = new Map<string, string[]>();
  const signalTextCache = new Map<string, string>();
  const signalPatternCache = new Map<string, RegExp>();
  function rememberLexicalValue<T>(cache: Map<string, T>, key: string, value: T): T {
    if (cache.size >= 1024) cache.delete(cache.keys().next().value!);
    cache.set(key, value);
    return value;
  }

  function lexicalTerms(value: unknown): string[] {
    const raw = String(value ?? "").toLowerCase();
    if (!raw) return [];
    const cached = lexicalTermCache.get(raw);
    if (cached) return cached.slice();
    const terms = new Set<string>();
    const ascii = raw.match(/[a-z0-9]+/g) || [];
    ascii.forEach((term) => {
      if (!STOPWORDS.has(term)) terms.add(term);
    });
    if (hasJapanese(raw)) {
      const katakana = raw.match(/[\u30a0-\u30ff\u30fc]{2,}/g) || [];
      katakana.forEach((term) => {
        if (!JP_STOPWORDS.has(term)) terms.add(term);
      });
      const kanji = raw.match(/[\u3400-\u9fff]{2,}/g) || [];
      kanji.forEach((term) => {
        if (!JP_STOPWORDS.has(term)) {
          terms.add(term);
          if (term.length === 4) {
            terms.add(term.slice(0, 2));
            terms.add(term.slice(2, 4));
          } else if (term.length === 6) {
            terms.add(term.slice(0, 2));
            terms.add(term.slice(2, 4));
            terms.add(term.slice(4, 6));
          }
        }
      });
      if (jaSegmenter) {
        for (const item of jaSegmenter.segment(raw)) {
          const seg = item.segment.trim();
          if (item.isWordLike && seg.length >= 2 && !JP_STOPWORDS.has(seg)) {
            if (/^[\u30a0-\u30ff\u30fc]+$/.test(seg)) continue;
            terms.add(seg);
            if (seg.length === 4) {
              terms.add(seg.slice(0, 2));
              terms.add(seg.slice(2, 4));
            }
          }
        }
      }
    }
    return rememberLexicalValue(lexicalTermCache, raw, [...terms]).slice();
  }

  function overlapScore(query: unknown, documents: readonly string[]): number {
    const queryTerms = lexicalTerms(query);
    const documentTerms = new Set(documents.flatMap((document) => lexicalTerms(document)));
    if (!queryTerms.length || !documentTerms.size) return 0;
    return Math.round(
      (100 * queryTerms.filter((term) => documentTerms.has(term)).length) / queryTerms.length,
    );
  }

  function fieldedLexicalScore(
    paper: PaperRecord,
    conf: ConferenceHay,
  ): { score: number; fields: FieldScores } {
    const title = paper.title ?? "";
    const abstract = paper.abstract ?? "";
    const keywords = paper.keywords ?? "";
    const all = [title, abstract, keywords].join(" ");
    const detected = autoDetectCats([paper]);
    const catQuery = [...new Set([...lexicalTerms(all), ...detected])].join(" ");
    const fields: FieldScores = {
      acronym: overlapScore(title, conf.acronym),
      full_name: overlapScore(all, [conf.title, conf.full]),
      scope: overlapScore(all, conf.scope),
      tags: overlapScore(all, conf.tags),
      categories: overlapScore(catQuery, conf.categories),
      representative_papers: overlapScore(all, conf.papers),
      paper_title: overlapScore(title, conf.papers),
      paper_abstract: overlapScore(abstract, [...conf.papers, ...conf.paperAbstracts]),
      keywords: overlapScore(keywords, [...conf.keywords, ...conf.papers]),
    };
    const active = (Object.keys(fields) as FieldName[]).filter((field) => {
      const documents =
        field === "full_name"
          ? [conf.title, conf.full]
          : field === "scope"
            ? conf.scope
            : field === "tags"
              ? conf.tags
              : field === "categories"
                ? conf.categories
                : field === "representative_papers" || field === "paper_title"
                  ? conf.papers
                  : field === "paper_abstract"
                    ? [...conf.papers, ...conf.paperAbstracts]
                    : field === "keywords"
                      ? [...conf.keywords, ...conf.papers]
                      : conf.acronym;
      return documents.length > 0;
    });
    const weight = active.reduce((sum, field) => sum + FIELD_WEIGHTS[field], 0);
    const score = weight
      ? active.reduce((sum, field) => sum + fields[field] * FIELD_WEIGHTS[field], 0) / weight
      : 0;
    return { score: Math.round(score), fields };
  }

  /* 会議側の照合文字列（key / title / full_name / tags / 日本語表記 / 代表論文語彙） */
  function confHay(r: CandidateRow | ConferenceRecord): ConferenceHay {
    const c = "conf" in r ? r.conf : r;
    return {
      key: normKey(c.key),
      title: normKey(c.title),
      full: normKey(c.full_name),
      tags: (c.tags || []).map((tag) => normKey(tag)),
      jp: `${c.title || ""} ${c.full_name || ""}`.match(/[\u3000-\u9fff]+/g) || [],
      // 代表採択論文タイトル（実データが持つ場合のみ）。語彙一致の対象を
      // 「会議名」から「会議の実際の採択領域」に広げる。
      papers: (c.papers || []).map((paper) => normKey(paper)),
      acronym: normalizedStrings(c.acronym).map((value) => normKey(value)),
      scope: [
        ...new Set([...normalizedStrings(c.scope), ...normalizedStrings(c.official_scope)]),
      ].map((value) => normKey(value)),
      categories: normalizedStrings(c.categories).map((value) => normKey(value)),
      paperAbstracts: normalizedStrings(c.paper_abstracts).map((value) => normKey(value)),
      keywords: normalizedStrings(c.keywords).map((value) => normKey(value)),
    };
  }

  /* 分野自動判定: 全論文テキストで各分野シグナルのヒット数を数える */
  function autoDetectCats(lines: readonly PaperRecord[]): string[] {
    if (!lines?.length) return [];
    const text = lines
      .map((paper) => paperText(paper))
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const hits: Array<{ dom: string; n: number }> = [];
    const hay = `${expandJp(text)} ${text}`;
    Object.keys(DOMAIN_SIGNAL).forEach((dom) => {
      const n = DOMAIN_SIGNAL[dom].filter((keyword) => signalInText(hay, keyword)).length;
      if (n > 0) hits.push({ dom: dom, n: n });
    });
    hits.sort((a, b) => b.n - a.n);
    return hits.map((hit) => hit.dom);
  }

  function emptyFieldScores(): FieldScores {
    return {
      acronym: 0,
      full_name: 0,
      scope: 0,
      tags: 0,
      categories: 0,
      representative_papers: 0,
      paper_title: 0,
      paper_abstract: 0,
      keywords: 0,
    };
  }

  /* 1行ぶんのスコア (0..100)。venueHit は掲載先タグ一致なら true */
  function scoreLine(
    r: CandidateRow,
    p: PaperRecord,
    conf: ConferenceHay,
    useFielded = false,
  ): LineScore {
    if (!p)
      return {
        score: 0,
        venueHit: false,
        details: { domain: 0, name: 0, paper: 0, jp: 0, tags: 0, venue: 0 },
        fieldScores: emptyFieldScores(),
      };
    const pt = paperText(p).toLowerCase();
    if (!pt)
      return {
        score: 0,
        venueHit: false,
        details: { domain: 0, name: 0, paper: 0, jp: 0, tags: 0, venue: 0 },
        fieldScores: emptyFieldScores(),
      };
    let score = 0;
    const details = { domain: 0, name: 0, paper: 0, jp: 0, tags: 0, venue: 0 };
    const fielded = fieldedLexicalScore(p, conf);
    // ponytail: keep the new fielded retrieval contribution bounded at 20 points;
    // replace the handcrafted scorer only after a measured benchmark win.
    if (useFielded) score += Math.min(20, Math.round(fielded.score * 0.2));
    // 内側ブロックで使う let は関数ルートに宣言を集約（biome noInnerDeclarations）
    let wgt: number;
    let jpHay: string;
    let jpHit: boolean;
    let rawTag: string;
    let nv: string;
    let hay: string[];
    let rawHay: string[];
    let rt: string;
    let aliases: string[] | undefined;
    let hl: string;
    let c: ConferenceRecord;
    const categories = r.cats || r.categories || r.conf.categories || [];

    // 注: 日本語→英語展開（expandJp）はスコアリングに使わない。
    // 実測比較: 展開語が英語名の会議に広く一致して誤爆し、
    // 日本語ゴールデンセット top1 が 42%→16% に悪化した。展開は
    // 分野自動判定（autoDetectCats）の表示用にのみ使う。

    // 分野シグナル: 論文にキーワードがあり、会議がそのカテゴリを持つ。
    // ヒット数ではなく「カテゴリにヒットしたか」で +SIG_WEIGHTS.domain（累積しない）。
    Object.keys(DOMAIN_SIGNAL).forEach((dom) => {
      if (categories.indexOf(dom) === -1) return;
      const hit = DOMAIN_SIGNAL[dom].some((keyword) => signalInText(pt, keyword));
      if (hit) {
        score += SIG_WEIGHTS.domain;
        details.domain += SIG_WEIGHTS.domain;
      }
    });

    // 会議名（title + full_name）の語彙一致（一般語は STOPWORDS で除外）。
    // 代表採択論文語彙（conf.papers）は「会議の実際の採択領域」を表すが、汎用語
    // （cache/machine/deep 等）が全会議の papers に現れて誤爆する。
    // 名前語と papers 語を分離する。
    // rtss/ecrts の papers 語彙（memory/optimization/analysis 等）が無関係クエリ
    // （memory safety / private optimization 等）へ交差マッチしたため。
    // IDF 重み表があれば希少語を重く、無ければ一律 SIG_WEIGHTS.name / paper 点。
    // nameOnce: 先頭 1 語の固定加点のみ（語数に比例させない実験用）
    // 代表論文語彙は英語クエリでのみ使う（日本語クエリでは日本語チャンク一致が主役で、
    // 英語の代表論文語彙は英語キーワード（nvme/storage 等）を持つ日本語論文クエリと
    // 衝突して誤爆する）。
    // また、掲載先タグ付き行（p.venue）でも使わない — タグの絶対性（venueHit +40）を
    // 守るため。
    const nameWords = `${conf.title} ${conf.full} ${conf.acronym.join(" ")}`
      .split(" ")
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
    const paperWords =
      hasJapanese(pt) || p.venue
        ? []
        : conf.papers
            .join(" ")
            .split(" ")
            .filter(
              (word) => word.length > 3 && !STOPWORDS.has(word) && !GENERIC_PAPER_WORDS.has(word),
            );
    let nameGiven = false;
    nameWords.forEach((w) => {
      if (!wordInText(pt, w)) return;
      if (SIG_WEIGHTS.nameOnce && nameGiven) return;
      wgt = idfMap?.name?.[w]
        ? Math.max(2, Math.round(SIG_WEIGHTS.name * idfMap.name[w]))
        : SIG_WEIGHTS.name;
      score += wgt;
      details.name += wgt;
      nameGiven = true;
    });
    // 行あたりの paper 語彙ヒット数に上限（SIG_WEIGHTS.paperCap）。
    // 論文が多い会議（rtss 22 本等）の汎用語（vision/model/real-time 等）が
    // 数ヒットでスコア上限 100 に達し、グラフィクス/マルチメディア系の他クエリ
    // （3dv/siggraph/icassp 等 39 件）を奪った。複数ヒットは「採択領域の一致」という
    // 1 信号と見なす（日本語チャンク一致と同じ考え方）。
    let paperHits = 0;
    paperWords.forEach((w) => {
      if (!wordInText(pt, w)) return;
      if (paperHits >= SIG_WEIGHTS.paperCap) return;
      paperHits++;
      wgt = idfMap?.paper?.[w]
        ? Math.max(2, Math.round(SIG_WEIGHTS.paper * idfMap.paper[w]))
        : SIG_WEIGHTS.paper;
      score += wgt;
      details.paper += wgt;
    });

    // 日本語の部分一致: 論文の固有日本語語彙（カタカナ語・漢字複合語）が会議名の日本語に含まれれば加点
    // 助詞や汎用学会接頭辞（情報処理学会/電子情報通信学会/研究会/シンポジウム等）を落とした
    // 実質名称に対して照合し、論文側の研究/提案/評価/システム等の汎用語も除外する。
    if (hasJapanese(pt) && conf.jp.length) {
      jpHay = conf.jp
        .join(" ")
        .replace(JP_ORG_STOP, " ")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
      if (jpHay) {
        const terms = extractDistinctiveJpTerms(pt);
        jpHit = terms.some((term) => jpHay.indexOf(term) !== -1);
        if (jpHit) {
          score += SIG_WEIGHTS.jp;
          details.jp += SIG_WEIGHTS.jp;
        }
      }
    }

    // tags 語彙一致（data-mining 等の領域タグ。GENERIC_TAGS は属性なので除外）
    conf.tags.forEach((t) => {
      if (!t || GENERIC_TAGS.has(t) || t.length <= 3) return;
      if (signalInText(pt, t)) {
        score += SIG_WEIGHTS.tags;
        details.tags += SIG_WEIGHTS.tags;
      }
    });

    // 掲載先タグ一致: この論文がこの会議に載ったことがある
    let venueHit = false;
    if (p.venue) {
      rawTag = String(p.venue).trim().replace(/\s+/g, " ");
      nv = normKey(p.venue);
      hay = [conf.key, conf.title, conf.full].filter(Boolean);
      // 原文（日本語含む）照合: 「情報処理学会 DPS 研究会」タグが会議名に含まれれば一致。
      // 短いタグ（ISC 等）は完全一致のみ（ISCA への部分一致誤爆を防ぐ）
      c = r.conf;
      rawHay = [(c.title || "").replace(/\s+/g, " "), (c.full_name || "").replace(/\s+/g, " ")];
      rt = rawTag.toLowerCase();
      venueHit =
        rawTag.length >= 2 &&
        rawHay.some((h) => {
          if (!h) return false;
          hl = h.toLowerCase();
          return rawTag.length <= 3 ? hl === rt : hl.indexOf(rt) !== -1 || rt.indexOf(hl) !== -1;
        });
      if (!venueHit && nv.length >= 2) {
        aliases = VENUE_ALIASES[nv];
        if (nv.length <= 3) {
          // 2〜3 文字タグ（SC / ISC / dps 等）は完全一致のみ（部分一致は誤爆する）
          venueHit = hay.some((h) => h === nv);
        } else {
          venueHit = hay.some((h) => h && (h.indexOf(nv) !== -1 || nv.indexOf(h) !== -1));
        }
        // 略称エイリアス（例: SP → s-p）は key 単位で照合する（両側を normKey で正規化）
        if (!venueHit && aliases) {
          venueHit = aliases.some((key) => normKey(key) === conf.key);
        }
      }
      if (venueHit) {
        details.venue += SIG_WEIGHTS.venue;
      }
    }

    return {
      score: Math.min(100, score),
      venueHit: venueHit,
      details: details,
      fieldScores: fielded.fields,
    };
  }

  /* 全行のスコア: 平均と最大の加重平均（0.6×平均 + 0.4×最大）。
   * タグ付き論文 1 本の強シグナルが多数行の平均で薄まらないようにする。 */
  function scorePapers(r: unknown, lines: readonly PaperRecord[], useFielded = false): number {
    const row = normalizeCandidateLike(r);
    if (!row || !lines?.length) return 0;
    const conf = confHay(row);
    const weights = paperWeights(lines);
    let sum = 0;
    let total = 0;
    let max = 0;
    for (let i = 0; i < lines.length; i++) {
      const s = scoreLine(row, lines[i], conf, useFielded).score;
      const weight = weights[i].weight;
      if (!weight) continue;
      sum += s * weight;
      total += weight;
      if (s * weight > max) max = s * weight;
    }
    if (!total) return 0;
    const avg = sum / total;
    return Math.round(avg * 0.6 + max * 0.4);
  }

  /* ランクフィルタ: rankPairs ("ccf:A" 等) のグレードを厳密比較する。
   * indexOf の部分一致だと "A" が "core:A*" に誤マッチする (A* は A ではない)。 */
  /* 評価の等級を「よさ」の順に並べた表。一覧の選択欄・URL・並び順で同じ正本を使う
   * （書き写すと、選択肢に無い等級を通した URL が生まれたり、並びだけが違う順序に
   * なったりする）。 */
  const RANK_GRADE_ORDER_JA = ["A*", "A", "B", "C", "N"];

  function rankGradeOrderJa(): string[] {
    return RANK_GRADE_ORDER_JA.slice();
  }

  /* ランク順の並びキー。`rankPairs` は `ccf:A` の形なので、文字列比較すると
   * **体系名が等級より先に効いて**、`ccf:C` が `core:A*` より前に並んでいた。
   * `N`（一覧に載っているが評価が付いていない）を等級として先頭側に出す問題もあった
   * （実測）。
   *
   * ここでは等級を点数に直して並べる（`A*` が最も高い）。表の並びは数値列と同じ約束で、
   * **昇順がいちばん低い行（評価の無い行）から、降順がいちばん高い行（A*）から**出る。
   * 同じ等級の塊の中は、次の体系の等級がよい行を後ろ（＝降順で前）に置く。
   * 未知の等級は「評価あり」側として `N` の下・評価の無い行の上に置く
   * （知らない等級を「評価なし」と混ぜない）。 */
  function rankSortKey(pairs: readonly string[] | null | undefined): string {
    const best = RANK_GRADE_ORDER_JA.length + 1; // A* などの最高点に使う幅
    const qualities: number[] = [];
    (pairs || []).forEach((pair) => {
      const text = String(pair);
      const grade = text.slice(text.indexOf(":") + 1);
      const at = RANK_GRADE_ORDER_JA.indexOf(grade);
      qualities.push(at < 0 ? 1 : best - at);
    });
    // 評価の無い行は 0（昇順で先頭、降順で末尾）。
    if (!qualities.length) qualities.push(0);
    qualities.sort((x, y) => y - x);
    while (qualities.length < 3) qualities.push(0);
    return qualities
      .slice(0, 3)
      .map((n) => (n < 10 ? `0${n}` : String(n)))
      .join("|");
  }

  function rankMatches(rankPairs: readonly string[] | null | undefined, grade: string): boolean {
    return (rankPairs || []).some((pair) => pair.slice(pair.indexOf(":") + 1) === grade);
  }

  function rankGradeJa(rank: unknown): string {
    const 打たれた = String(rank ?? "").trim();
    if (打たれた === "") return "";
    /* `scale:grade` の形（素の `rankPairs`）はそのまま通す。 */
    if (打たれた.includes(":")) return 打たれた.slice(打たれた.indexOf(":") + 1).trim();
    /* 「CCF A」の様に尺度の名が前に着ている – **後ろの等級だけ**を取る。 */
    const 語 = 打たれた.split(/\s+/).filter(Boolean);
    if (語.length > 1) return 語[語.length - 1]!;
    return 打たれた;
  }

  /* SPEC §7: サイト UI は日本語。data.json の categories は機械可読の英表記を保つため、
   * 日本語表示名はここを単一正典にする（絞り込みチップ・行タグ・検索語の共通元）。 */
  const CATEGORY_LABELS_JA: Record<string, string> = {
    ai: "人工知能",
    db: "データベース",
    graphics: "グラフィックス",
    hci: "人間情報処理",
    hpc: "高性能計算",
    networking: "ネットワーク",
    security: "セキュリティ",
    systems: "システム",
    theory: "計算理論",
  };

  /* 検索の言いゆれの吸収: 日本の研… – 実測と理由は第 723 回に SPEC へ送つた。*/
  const QUERY_SYNONYMS_JA: Array<[string, string, string[]]> = [
    /* 種別を打つ人の言い方を増やす（2… – 実測と理由は第 723 回に SPEC へ送つた。*/
    ["ピアレビュー結果", "種別「査読結果公開」", ["査読結果公開"]],

    [
      "審査",
      "種別「査読結果公開」（収録では『査読結果公開』『査読』と書かれています）",
      ["査読結果公開"],
    ],
    [
      "レフェリー",
      "種別「査読結果公開」（収録では『査読結果公開』『査読』と書かれています）",
      ["査読結果公開"],
    ],

    ["合否結果", "種別「採否通知」", ["採否通知"]],

    ["採録通知", "種別「採否通知」", ["採否通知"]],
    ["最終版提出", "種別「カメラレディ」", ["カメラレディ"]],
    ["採否通知締切", "種別「採否通知」", ["採否通知"]],
    ["採否通知deadline", "種別「採否通知」", ["採否通知"]],
    ["結果締切", "種別「査読結果公開」", ["査読結果公開"]],
    ["参加登録締切", "種別「登録締切」", ["登録締切"]],
    ["参加締切", "種別「登録締切」", ["登録締切"]],

    ["参加申込", "種別「登録締切」（参加の申込みは『登録締切』と書きます）", ["登録締切"]],
    ["参加申込み", "種別「登録締切」（参加の申込みは『登録締切』と書きます）", ["登録締切"]],
    ["参加申込締切", "種別「登録締切」（参加の申込みは『登録締切』と書きます）", ["登録締切"]],
    ["参加申込み締切", "種別「登録締切」（参加の申込みは『登録締切』と書きます）", ["登録締切"]],

    ["反論終了", "種別「反論期間終了」", ["反論期間終了"]],
    ["反論提出", "種別「反論期間終了」", ["反論期間終了"]],

    /* 早期割引（early bird）の料金の締切を尋ねる人は多いが、収録に早期割引の区別は無い
     * （`early bird` は品書に 0 箇所・`early` 11 行の種別は論文 1・採否 4・査読結果 5・登録 1
     * に散っている – 一つの種別へは寄せる）。種別『登録締切』（7 行）を出し、**収録に区別が
     * 無い事を案内その物に書く**（黙って別の意味の行に寄せない）。 */
    [
      "早期割引",
      "種別「登録締切」（収録に早期割引の区別は無く、登録の締切を出しています）",
      ["登録締切"],
    ],

    [
      "早期締切",
      "種別「登録締切」（収録に早期割引の区別は無く、登録の締切を出しています）",
      ["登録締切"],
    ],
    [
      "早期提出",
      "種別「登録締切」（収録に早期割引の区別は無く、登録の締切を出しています）",
      ["登録締切"],
    ],
    [
      "早割",
      "種別「登録締切」（収録に早期割引の区別は無く、登録の締切を出しています）",
      ["登録締切"],
    ],

    [
      "生成AI",
      "原文に generative と書かれた行（其の分野を広く探すなら『AI』で絞れます）",
      ["generative"],
    ],
    [
      "生成的人工知能",
      "原文に generative と書かれた行（其の分野を広く探すなら『AI』で絞れます）",
      ["generative"],
    ],
    [
      "生成モデル",
      "原文に generative と書かれた行（其の分野を広く探すなら『AI』で絞れます）",
      ["generative"],
    ],
    /* コンピュータアーキテクチャは収録の催し物に当たりながら日本語の語が通らなかった
     * （`architecture` 16 行・`computer architecture` 7 行・`microarchitecture` 3 行 – 実測。
     * 日本語側の `マイクロアーキテクチャ` は既に通るのに、その親の語が抜けていた）。 */
    [
      "コンピュータアーキテクチャ",
      "原文に computer architecture と書かれた行",
      ["computer architecture"],
    ],
    /* 耐障害性は収録の原文に `fault tolerance` が 1 度も現れない（実測 0 行）ので、その方で
     * 使われている `reliability`（1 行）へ導す。**無い語をある様に寄せない**（案内でその事を言う）。 */
    [
      "耐障害性",
      "原文に reliability と書かれた行（収録に fault tolerance という語はありません）",
      ["reliability"],
    ],
    [
      "フォールトトレランス",
      "原文に reliability と書かれた行（収録に fault tolerance という語はありません）",
      ["reliability"],
    ],
    [
      "耐故障",
      "原文に reliability と書かれた行（収録に fault tolerance という語はありません）",
      ["reliability"],
    ],
    /* 穴場の言い方（実測）。
     * `穴場` は収録の主題タグ `niche` の画面のラベル（`TAG_LABELS_JA`）で 44 行通るので、その方の
     * 言い方を其処へ寄せる（行を増やさない – 寄せ先の語の行と一字も違わない事を検査に張る）。 */
    ["穴場会議", "主題タグ「穴場」", ["穴場"]],
    ["穴場な会議", "主題タグ「穴場」", ["穴場"]],
    ["隠れ家的な会議", "主題タグ「穴場」", ["穴場"]],
    ["穴場の会", "主題タグ「穴場」", ["穴場"]],

    ["特A", "等級「A*」", ["A*"]],
    ["A特", "等級「A*」", ["A*"]],
    ["エースター", "等級「A*」", ["A*"]],
    ["Aスター", "等級「A*」", ["A*"]],
    ["Aスタート", "等級「A*」", ["A*"]],
    ["A*の会", "等級「A*」", ["A*"]],
    ["A*級", "等級「A*」", ["A*"]],
    ["A*な会議", "等級「A*」", ["A*"]],

    ["スパコン", "分野「高性能計算」", ["高性能計算", "hpc"]],

    ["高性能計算機", "分野「高性能計算」", ["高性能計算", "hpc"]],
    ["ロボティクス学会", "分野「ロボティクス」", ["ロボティクス", "robotics"]],
    ["スーパーコンピュータ", "分野「高性能計算」", ["高性能計算", "hpc"]],
    ["スーパーコンピューター", "分野「高性能計算」", ["高性能計算", "hpc"]],
    ["スーパーコンピューティング", "分野「高性能計算」", ["高性能計算", "hpc"]],
    ["並列処理", "分野「高性能計算」", ["高性能計算", "hpc"]],
    ["並列計算", "分野「高性能計算」", ["高性能計算", "hpc"]],
    ["分散システム", "分野「システム」", ["システム", "systems"]],
    ["分散処理", "分野「システム」", ["システム", "systems"]],
    ["組み込み", "分野「システム」", ["システム", "systems"]],
    ["組込み", "分野「システム」", ["システム", "systems"]],

    ["AIセキュリティ", "分野「セキュリティ」", ["セキュリティ", "security"]],
    ["インシデント対応", "分野「セキュリティ」", ["セキュリティ", "security"]],
    ["インシデント", "分野「セキュリティ」", ["セキュリティ", "security"]],
    ["脆弱性研究", "分野「セキュリティ」", ["セキュリティ", "security"]],
    ["人間中心設計", "分野「人間情報処理」", ["人間情報処理", "hci"]],
    ["移動体通信", "分野「ネットワーク」", ["ネットワーク", "networking"]],
    ["モバイル通信", "分野「ネットワーク」", ["ネットワーク", "networking"]],

    ["クラウド", "分野「システム」", ["システム", "systems"]],
    ["深層学習", "主題「ディープラーニング」", ["ディープラーニング", "deep-learning"]],

    ["音声処理", "主題「音声」（英語では speech と書かれた会議名）", ["音声", "speech"]],
    ["スピーチ", "主題「音声」（英語では speech と書かれた会議名）", ["音声", "speech"]],
    ["推薦システム", "主題「推薦」（recommendation）", ["推薦", "recommendation"]],
    ["計算機ビジョン", "主題「コンピュータビジョン」", ["コンピュータビジョン", "vision"]],
    ["可視化", "分野「グラフィックス」", ["グラフィックス", "graphics"]],
    ["ビジュアライゼーション", "分野「グラフィックス」", ["グラフィックス", "graphics"]],
    ["ヒューマンインタフェース", "分野「人間情報処理」", ["人間情報処理", "hci"]],
    ["ヒューマンインターフェース", "分野「人間情報処理」", ["人間情報処理", "hci"]],
    ["人間中心", "分野「人間情報処理」", ["人間情報処理", "hci"]],
    // 参加形式の言い方。`ハイブリッド` で引く人は「オンラインでも参加できる行」を
    // 求めているので、行が持つ参加形式の語へ寄せる（2026-09-23 時点で `ハイブリッド` の
    // まま当たる行はすべて過去で、既定の一覧では 0 件になっていた）。
    ["ハイブリッド", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    // 「国内で開かれる会議」を探す人は、画面の『国内研究会・国内シンポジウム』と同じものを
    // 求めている（第 249 回 – 2026-08-09 生成ビルドで実測: `国内開催` `国内会議` `日本開催`
    // `国内向け` はいずれも 0 行で、`国内` は 46 行に当たった。行は「国内研究会」等の表記を
    // 持つので、打たれた語だけでは 1 行も減らなかった）。
    ["国内開催", "「国内」のつく行（国内研究会・国内シンポジウム）", ["国内"]],
    ["国内会議", "「国内」のつく行（国内研究会・国内シンポジウム）", ["国内"]],
    ["日本開催", "「国内」のつく行（国内研究会・国内シンポジウム）", ["国内"]],
    ["国内向け", "「国内」のつく行（国内研究会・国内シンポジウム）", ["国内"]],
    /* 学会その物を指す語。*/
    ["国内学会", "「国内」のつく行（国内研究会・国内シンポジウム）", ["国内"]],
    // 米国側も同じ言い方で打たれる（第 250 回 – 実測: `米国開催` `アメリカ開催` `米国向け` は
    // 0 行で、`米国` は 787 行に当たった）。`米国` は地域まとめの見出しで行の表記には出ない
    // ので、上の hop 合成で見出しを越えるようにして初めて届く（第 249 回はそこで止まって
    // 0 行だったので載せなかった）。
    ["米国開催", "開催地の表記に「米国」の州・都市を含む行", ["米国"]],
    ["アメリカ開催", "開催地の表記に「米国」の州・都市を含む行", ["米国"]],
    ["米国向け", "開催地の表記に「米国」の州・都市を含む行", ["米国"]],
    // `米国開催` は第 249 回では載せられなかった。`米国` は 787 行に当たるが、行のなかに
    // 「米国」の表記は 1 つも無く（`data.json` で 0 件）、地域まとめの展開が効いて初めて
    // あたる語で、hop 合成が地域まとめの見出しで止まっていたため 0 行のままだった
    // （展開語を `["米国"]` と書いただけでは届かず、案内だけが「探しています」と噓を言った）。
    // 第 250 回で hop を直し、下の条目で載せた。
    // 参加形式の言い方はもっと多い。画面に出る語は「オンライン参加可」だけで、
    // 「オンライン開催」と打つ人は 0 行に当たっていた（2026-08-09 生成の実測:
    // `オンライン開催` 0 行 / `ハイブリッド開催` 0 行 / `リモート` 0 行 / `遠隔` 0 行 /
    // `ウェブ開催` 0 行）。英語も同じで、`hybrid` 4 行・`virtual` 11 行・`online` 3 行に
    // しか当たらず、同じ意味の `オンライン参加可` は 24 行あった。
    // `virtual` は寄せていない – 会議名の "Virtual Reality" に当たって 10 行よけいに出る
    // （実測: `virtual` は 34 行に増え、そのうち参加形式の印がある行は 24 行で、残りは
    // 「International Conference on Virtual Reality and Visualization」などの会議名だった）。
    // 逆の言い方（`対面` `in-person` `onsite` `現地`）は収録に語その物が無いので
    // 寄せない – 0 件の案内に任せる（実測: データに "in-person"・"onsite"・「対面」は
    // 1 度も出てこない）。
    ["オンライン開催", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    ["ハイブリッド開催", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],

    ["ハイブリッド形式", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    ["リモート", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    ["遠隔", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    ["ウェブ開催", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    ["web開催", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    // 参加形式の言い方の続き。2026-09-25 実測（2026-08-09 生成の実ビルドの品書
    // 872 行・固定時刻 2026-08-09T00:00:00Z）: 上の `リモート` `遠隔` `ウェブ開催` `web開催`
    // は 24 行（= 参加形式の印のある行）通るのに、日本で書かれる別の言い方 `リモート参加`
    // `遠隔参加` `ネット参加` `ネット開催` `ウェブ参加` `ウェビナー` `オンライン形式`
    // `在宅参加` `在宅` `ハイフレックス` は **0 行で案内も無し**だった（品書の文本にも
    // "webinar" 0 箇所・"hyflex" 0 箇所 – 実測）。意味は同じなのでこの方の寄せ先へ寄せる
    // （件の欄に「参加形式『オンライン参加可』で探しています」と出るので、印で絞った事は
    // 隠れない – 上の行と同じ道）。
    // 寄せない物: `オンラインのみ` は実測 1 行通るので触らない – 「のみ」の区別は収録して
    // 居ないので 24 行に広げない。`現地参加` `対面` `対面のみ` `オフライン` `リアル開催` は
    // 既に 0 件の案内が出て居り、`オンライン参加可` へ寄せると**反対の意味**に成る。
    ["リモート参加", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    ["遠隔参加", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    ["ネット参加", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    ["ネット開催", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    ["ウェブ参加", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    ["ウェビナー", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    ["オンライン形式", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    ["在宅参加", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    ["在宅", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    ["ハイフレックス", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    ["hybrid", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    ["remote", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    ["online", "参加形式「オンライン参加可」", ["オンライン参加可"]],
    // 締切種別も言い方が分かれる。学会側は「抄録」「要旨」と書くことが多いが、
    // 表は「概要締切」を出す（実測: `抄録` 0 件 / `概要` 660 件）。
    // 「アブストラクト」単体では当たるが、選択肢に出る語との複合で打つ人が多い
    // （`アブストラクト締切` は 2026-09-23 実測で 0 件、`概要締切` は 660 件）。
    ["アブストラクト締切", "種別「概要締切」", ["概要締切", "abstract"]],
    // ほかのサイトや昔の表記で「随時受付」と書くところがある。表の語は `常時受付`
    // （種別ラベル・CSV・並び順・てびきですべて同じ語を使っているので、そこへ寄せる）。

    ["随時受付", "種別「常時受付」", ["常時受付"]],
    // 等級の列を見出しの語で打つ人。画面は評価の無い行に「評価なし」と出すのに、列の見出しは
    // 「ランク」なので、その語で打つと 0 件に当たっていた（2026-08-09 生成ビルドで実測:
    // `ランクなし` 0 件 / 画面の語 `評価なし` 144 件）。
    ["ランクなし", "画面の語「評価なし」", ["評価なし"]],
    // 「論文募集」は上流（Call for Papers）の言い方。表は種別を「論文締切」と出すので、
    // その語へ寄せる（2026-08-09 生成ビルドで実測: `論文募集` 0 件 / `論文締切` 454 件）。
    // 原文の "paper" には寄せない – 採否通知などのラベルにも出る語で、寄せる先として
    // 誤っている（実測: "paper" を入れた形で出た行に種別「採否通知」が混ざった）。
    ["論文募集", "種別「論文締切」", ["論文締切"]],
    // 「投稿締切」「論文提出」は日本の研究者がいちばん書く言い方なのに、表の語は
    // 「論文締切」なので噛み合わなかった（2026-08-09 生成ビルドの実測: `投稿締切` 2 件 /
    // `論文投稿` 1 件 / `論文提出` 0 件 / `原稿提出` 0 件 / `提出` 0 件、同じ意味の
    // `論文締切` は 454 件、原文の "paper submission" は 440 件）。700 行ある表で 2 行の
    // 画面を見せられて「このサイトには無い」と受け取られていただろう。
    // 原文の "paper" には寄せない – `論文募集` で実測したとおり、採否通知のラベルに
    // 混ざる語なので、寄せ先としては誤っている。
    ["投稿締切", "種別「論文締切」", ["論文締切"]],
    ["論文投稿", "種別「論文締切」", ["論文締切"]],
    ["論文提出", "種別「論文締切」", ["論文締切"]],
    ["原稿提出", "種別「論文締切」", ["論文締切"]],
    ["投稿", "種別「論文締切」", ["論文締切"]],

    ["採択通知", "種別「採否通知」", ["採否通知"]],
    ["採択", "種別「採否通知」", ["採否通知"]],
    ["採択結果", "種別「採否通知」", ["採否通知"]],
    ["結果通知", "種別「採否通知」", ["採否通知"]],
    ["合否通知", "種別「採否通知」", ["採否通知"]],
    ["受理通知", "種別「採否通知」", ["採否通知"]],

    ["受理", "種別「採否通知」", ["採否通知"]],
    ["通知結果", "種別「採否通知」", ["採否通知"]],
    ["合否", "種別「採否通知」", ["採否通知"]],

    ["結果発表", "種別「採否通知」", ["採否通知"]],
    ["アクセプト", "種別「採否通知」", ["採否通知"]],
    ["最終原稿", "種別「カメラレディ締切」", ["カメラレディ締切"]],
    ["最終稿", "種別「カメラレディ締切」", ["カメラレディ締切"]],

    ["再延長", "締切が延びた印「延長」", ["延長"]],
    ["繰り下げ", "締切が延びた印「延長」", ["延長"]],
    ["延長された", "締切が延びた印「延長」", ["延長"]],

    ["伸びた", "締切が延びた印「延長」", ["延長"]],
    ["延びた", "締切が延びた印「延長」", ["延長"]],
    ["カメラレディ原稿", "種別「カメラレディ締切」", ["カメラレディ締切"]],
    ["登録期限", "種別「登録締切」", ["登録締切"]],
    ["事前登録", "種別「登録締切」", ["登録締切"]],
    ["登録開始", "種別「登録締切」", ["登録締切"]],
    ["レビュー結果", "種別「査読結果公開」", ["査読結果公開"]],
    ["審査結果", "種別「査読結果公開」", ["査読結果公開"]],
    ["査読公開", "種別「査読結果公開」", ["査読結果公開"]],

    ["提出日", "種別「論文締切」", ["論文締切"]],
    ["投稿日", "種別「論文締切」", ["論文締切"]],
    ["通知日", "種別「採否通知」", ["採否通知"]],
    ["採択日", "種別「採否通知」", ["採否通知"]],
    ["登録日", "種別「登録締切」", ["登録締切"]],
    ["参加登録", "種別「登録締切」", ["登録締切", "registration"]],
    ["早期登録", "種別「登録締切」", ["登録締切"]],

    ["カメラレディ期限", "種別「カメラレディ」", ["カメラレディ"]],
    ["早期登録締切", "種別「登録締切」", ["登録締切"]],
    /* 分野の繋がった言い方（実測 – `分散コンピューティング` `組込みシステム` `埋め込みシステム` は
     * 0 行で案内も無し、その方の `分散システム` `組込み` は分野「システム」で通った）。 */
    ["分散コンピューティング", "分野「システム」", ["システム", "systems"]],
    ["組込みシステム", "分野「システム」", ["システム", "systems"]],
    /* `埋め込みシステム` は寄せない（実測で 0 行だった – その方の言い方も其処で黙った侭）。
     * このサイトは画面に出す文言に開発側の語『埋め込み』を残さない決まりで、
     * `tests/build_golden.test.ts` の「説明文に開発用語を残さない」がそれを見ている –
     * 案内は打ち方をそのまま名指すので、寄せの語にするとその決まりと噛み合わない。
     * 「組込み」で足りる（同じ分野「システム」に 259 行通る）。 */
    ["会期日", "列「会期」", ["会期"]],

    ["日程", "列「会期」", ["会期"]],
    ["開催日", "列「会期」", ["会期"]],
    ["開催日程", "列「会期」", ["会期"]],
    ["開催時期", "列「会期」", ["会期"]],
    ["いつ開催", "列「会期」", ["会期"]],
    ["開始日", "列「会期」", ["会期"]],
    ["終了日", "列「会期」", ["会期"]],
    ["提出", "種別「論文締切」", ["論文締切"]],
    ["抄録締切", "種別「概要締切」", ["概要締切", "abstract"]],

    ["サマリ", "種別「概要締切」", ["概要締切", "abstract"]],
    ["サマリペーパー", "種別「概要締切」", ["概要締切", "abstract"]],
    ["要旨締切", "種別「概要締切」", ["概要締切", "abstract"]],
    ["抄録", "種別「概要締切」", ["概要締切", "abstract"]],
    ["要旨", "種別「概要締切」", ["概要締切", "abstract"]],
    ["アブストラクト", "種別「概要締切」", ["概要締切", "abstract"]],
    ["全文締切", "種別「論文締切」", ["論文締切", "paper"]],
    ["全文", "種別「論文締切」", ["論文締切", "paper"]],
    ["フルペーパー", "種別「論文締切」", ["論文締切", "paper"]],
    ["本論文", "種別「論文締切」", ["論文締切", "paper"]],
    /* 締切の回（ラウンド）の言い方（第… – 実測と理由は第 723 回に SPEC へ送つた。*/
    ["第1回", "締切の回「第1ラウンド」", ["第1ラウンド"]],
    ["第1回締切", "締切の回「第1ラウンド」", ["第1ラウンド"]],
    ["1回目", "締切の回「第1ラウンド」", ["第1ラウンド"]],
    ["1ラウンド目", "締切の回「第1ラウンド」", ["第1ラウンド"]],
    ["ラウンド1", "締切の回「第1ラウンド」", ["第1ラウンド"]],
    ["1次締切", "締切の回「第1ラウンド」", ["第1ラウンド"]],
    ["第一回", "締切の回「第1ラウンド」", ["第1ラウンド"]],
    ["一回目", "締切の回「第1ラウンド」", ["第1ラウンド"]],
    ["第2回", "締切の回「第2ラウンド」", ["第2ラウンド"]],
    ["第2回締切", "締切の回「第2ラウンド」", ["第2ラウンド"]],
    ["2回目", "締切の回「第2ラウンド」", ["第2ラウンド"]],
    ["2ラウンド目", "締切の回「第2ラウンド」", ["第2ラウンド"]],
    ["ラウンド2", "締切の回「第2ラウンド」", ["第2ラウンド"]],
    ["2次締切", "締切の回「第2ラウンド」", ["第2ラウンド"]],
    ["第二回", "締切の回「第2ラウンド」", ["第2ラウンド"]],
    ["二回目", "締切の回「第2ラウンド」", ["第2ラウンド"]],
    ["第3回", "締切の回「第3ラウンド」", ["第3ラウンド"]],
    ["第3回締切", "締切の回「第3ラウンド」", ["第3ラウンド"]],
    ["3回目", "締切の回「第3ラウンド」", ["第3ラウンド"]],
    ["3ラウンド目", "締切の回「第3ラウンド」", ["第3ラウンド"]],
    ["ラウンド3", "締切の回「第3ラウンド」", ["第3ラウンド"]],
    ["第三回", "締切の回「第3ラウンド」", ["第3ラウンド"]],
    ["三回目", "締切の回「第3ラウンド」", ["第3ラウンド"]],
    ["第4回", "締切の回「第4ラウンド」", ["第4ラウンド"]],
    ["第4回締切", "締切の回「第4ラウンド」", ["第4ラウンド"]],
    ["4回目", "締切の回「第4ラウンド」", ["第4ラウンド"]],
    ["4ラウンド目", "締切の回「第4ラウンド」", ["第4ラウンド"]],
    ["ラウンド4", "締切の回「第4ラウンド」", ["第4ラウンド"]],
    ["第5回", "締切の回「第5ラウンド」", ["第5ラウンド"]],
    ["第5回締切", "締切の回「第5ラウンド」", ["第5ラウンド"]],
    ["5回目", "締切の回「第5ラウンド」", ["第5ラウンド"]],
    ["5ラウンド目", "締切の回「第5ラウンド」", ["第5ラウンド"]],
    ["ラウンド5", "締切の回「第5ラウンド」", ["第5ラウンド"]],
    ["初回", "締切の回「第1ラウンド」", ["第1ラウンド"]],
    ["初回締切", "締切の回「第1ラウンド」", ["第1ラウンド"]],

    ["コンピュータネットワーク", "分野「ネットワーク」", ["ネットワーク"]],
    ["計算機ネットワーク", "分野「ネットワーク」", ["ネットワーク"]],
    ["ネットワークプロトコル", "分野「ネットワーク」", ["ネットワーク"]],
    ["ヒューマンコンピュータインタラクション", "分野「人間情報処理」", ["人間情報処理"]],
    ["データベース管理", "分野「データベース」", ["データベース"]],
    ["システム設計", "分野「システム」", ["システム"]],

    ["特別号", "種別「特集号」", ["特集号"]],
  ];

  /* 検索語が、表に出さない締切種別の表示語に当たるかを聞く（0 件の案内が使う）。
   * 「採否通知」は てびき と件数欄に語が出るのに、表は投稿締切だけを出すため検索すると
   * 0 件になる。収録が無いのだと誤解させないため、区別できる案内を出せるようにする。
   * 当たった種別名を返す（案内側で実名を書くため、真偽値だけでは使えない）。 */
  /* 部分一致では捕まえられない言い方（ラベルと語が噛み合わないものだけ足す）。 */

  const HIDDEN_KIND_ALIASES_JA: Record<string, string[]> = {
    カメラレディ締切: ["camera ready", "camera-ready"],

    反論期間開始: ["リバットル", "rebuttal"],
    反論期間終了: ["リバットル", "rebuttal"],
  };

  function queryHiddenKindMatches(query: unknown, hiddenKindLabels: readonly string[]): string[] {
    const tokens = queryTokens(query);
    if (!tokens.length) return [];

    const synonyms = querySynonymMap();
    const folded: string[] = [];
    tokens.forEach((token) => {
      const entry = synonyms[kanaFold(token)];
      if (entry) {
        entry[1].forEach((term) => {
          folded.push(kanaFold(term));
        });
      }
    });

    const equal: boolean[] = [];
    const fragmentTokens: string[][] = [];
    const nameable: boolean[] = [];
    hiddenKindLabels.forEach((label) => {
      if (!label) {
        nameable.push(false);
        return;
      }
      const words = [label].concat(HIDDEN_KIND_ALIASES_JA[label] || []);
      let isNameable = true;
      /* 他の種別の語にすっぽり含まれる語は、その種別を名指せない。 */
      hiddenKindLabels.forEach((other) => {
        if (other && other !== label && other.indexOf(label) >= 0) isNameable = false;
      });
      nameable.push(isNameable);
      let same = false;
      const frag: string[] = [];
      tokens.forEach((token) => {
        words.forEach((word) => {
          if (token === word) same = true;
          else if (word.indexOf(token) >= 0 || token.indexOf(word) >= 0) frag.push(token);
        });
      });
      folded.forEach((term) => {
        words.forEach((word) => {
          if (kanaFold(word) === term) same = true;
        });
      });
      equal.push(same);
      fragmentTokens.push(frag);
    });
    const out: string[] = [];
    hiddenKindLabels.forEach((label, index) => {
      if (!label || !nameable[index]) return;
      const enough =
        equal[index] ||
        fragmentTokens[index].some((token) => {
          let touched = 0;
          fragmentTokens.forEach((frag, other) => {
            if (nameable[other] && frag.indexOf(token) >= 0) touched += 1;
          });
          return touched === 1;
        });
      if (enough && out.indexOf(label) < 0) out.push(label);
    });
    return out;
  }

  /** 検索語の同義展開（キーはかな正規化した語）。 */
  /* 「週末に締めたい」「平日の締切だけ」という探し方を、曜日の語に寄せる。
   * 分野・種別・タグを画面に出るラベルへ寄せる表（`QUERY_SYNONYMS_JA`）とは別に持つ。
   * あの表の展開語は、列にそのまま出るラベルでなければならない（別の検査がそれを
   * 見ていて、曜日の語はあの対応表に存在しない語だから同じ検査には載せられない）。
   * 件数欄のおしらせは同じ仕組みで出す（語を増やしたことをその場で書く）。 */
  function querySynonymMap(): Record<string, [string, string[]]> {
    /* 曜日の意的な探し方の表。分野などを画面に出るラベルへ寄せる表（`QUERY_SYNONYMS_JA`）
     * とは別に持つ – あの表の展開語は列にそのまま出るラベルでなければならず（別の検査が
     * それを見ている）、曜日の語はその対応表に存在しない語なので載せられない。
     * 表は関数の中に置く（この関数は検査で単位切り出しして動かすので、モジュール級の
     * 別名前に依存させない）。 */
    const WEEKDAY_QUERY_SYNONYMS_JA: Array<[string, string, string[]]> = [
      ["週末", "土曜日の行と日曜日の行", ["土曜", "土曜日", "日曜", "日曜日"]],
      ["しゅうまつ", "土曜日の行と日曜日の行", ["土曜", "土曜日", "日曜", "日曜日"]],
      /* 「週末」と同じ頼み方なのに、こちらだけ黙っていた（2026-09-30 実測・実ビルドの品書
       * 872 行: `土日` **0 行** / `週末` 268 行・`平日` 604 行）。`祝日` は寄せない –
       * 収録に祝日の情報無く、休日であることを推測しない（AGENTS.md）。 */
      ["土日", "土曜日の行と日曜日の行", ["土曜", "土曜日", "日曜", "日曜日"]],
      [
        "平日",
        "月曜日から金曜日の行",
        ["月曜", "月曜日", "火曜", "火曜日", "水曜", "水曜日", "木曜", "木曜日", "金曜", "金曜日"],
      ],
    ];
    const out: Record<string, [string, string[]]> = {};
    /* 上流の原文にしか出ていない語を、… – 実測と理由は第 723 回に SPEC へ送つた。*/

    const UPSTREAM_TEXT_QUERY_SYNONYMS_JA: Array<[string, string, string[]]> = [
      ["情報処理学会", "学会「IPSJ」", ["情報処理学会", "ipsj.or.jp"]],
      ["電子情報通信学会", "学会「IEICE」", ["電子情報通信学会", "ieice.org"]],
      ["nips", "会議「NeurIPS」", ["neurips"]],
      ["日本時間", "行の時刻に書かれた JST という語", ["JST"]],
      ["日本標準時", "行の時刻に書かれた JST という語", ["JST"]],
      ["日本標準時間", "行の時刻に書かれた JST という語", ["JST"]],
      ["世界標準時", "行の時刻に書かれた UTC・GMT の語", ["UTC", "GMT"]],
      ["協定世界時", "行の時刻に書かれた UTC・GMT の語", ["UTC", "GMT"]],
      ["グリニッジ標準時", "行の時刻に書かれた UTC・GMT の語", ["UTC", "GMT"]],
      ["グリニッジ平均時", "行の時刻に書かれた UTC・GMT の語", ["UTC", "GMT"]],
      /* 「バーチャル開催」は上流の英文字語でしか書かれていない（2026-09-30 実測・実ビルドの
       * 品書 872 行・同刻）: `バーチャル` **0 行**なのに原文の
       * `virtual` は 11 行（`オンライン` 24 行・`ポスター` 6 行は通っていた）。
       * **`口頭` は載せない** – 原文の `oral` を打つと 0 行で、品書に現れる "oral" は別の英字語の
       * 一部（5 箇所）に過ぎなかった（上の決まり – 収録に実在しない語を寄せても 0 件のまま）。
       * 参加形式の「対面」「現地」「リアル」も受けない – 収録に参加形式のラベルが無く、そのことを
       * 上の案内が既に画面に書いている。 */
      ["バーチャル", "原文の virtual という語", ["virtual"]],
      /* 『参加』『開催』を繋げた言い方も同じ語を指す（実測）:
       * `バーチャル` 11 行が通るのに `バーチャル参加` **0 行**・`バーチャル開催` **0 行**で
       * 案内も無し（画面は「語「バーチャル参加」は収録データにありません」とだけ読む）。
       * 収録の `virtual` を持つ行と同じ行に会えるので、その方へ寄せる（対称差 0 – 検査で張る）。
       * `バーチャルのみ` は寄せない – 「オンラインのみの行だけ」を頼む言い方なので、
       * hybrid の行まで出す事になる（実測 `オンラインのみ` 1 行 / `オンライン` 24 行 – 別物）。 */
      ["バーチャル参加", "原文の virtual という語", ["virtual"]],
      ["バーチャル開催", "原文の virtual という語", ["virtual"]],
      ["ポスター", "原文の poster という語", ["poster"]],
      ["ポスター発表", "原文の poster という語", ["poster"]],
      // 同じ形の言い方が表に無い（2026-08-09 生成ビルドで実測: `ポスター` 6 件・
      // `ポスター発表` 6 件なのに `ポスター募集` と `ポスター投稿` は 0 件）。
      ["ポスター募集", "原文の poster という語", ["poster"]],
      ["ポスター投稿", "原文の poster という語", ["poster"]],

      ["ボスター", "原文の poster という語", ["poster"]],
      // 期刊・特集号の募集も同じ形で打つ（実測: `特集号` 15 件・`研究会` 23 件なのに
      // `特集号募集` `特集号投稿` `研究会発表` は 0 件）。寄せ先はいずれも表の会議名に
      // そのまま出ている語（`IEICE Trans. Electron. 特集号（アナログ回路と…`、
      // `電子情報通信学会 CPSY 研究会 2026`）なので、画面に出る語への寄せという不変条件を守る。
      // 逆に `シンポジウム発表` は寄せない – `シンポジウム` で当たる行の会議名は
      // `SCIS 2027` で、寄せ先が画面に出ない語に化けるため。
      ["特集号募集", "会議名に出る『特集号』の語", ["特集号"]],
      ["特集号投稿", "会議名に出る『特集号』の語", ["特集号"]],
      ["研究会発表", "会議名に出る『研究会』の語", ["研究会"]],
      // 学会に出す雑誌の呼び方。表の種別ラベルは `常時受付`（旧いサイトでは「随時受付」と
      // 書かれていた語と同じ）。原文の "journal" には寄せない – `学会誌` で当たる行の
      // 会議名は `IJGCA 2026` のような略称で、寄せ先が画面に出ない語になるため。
      ["学会誌", "種別「常時受付」", ["常時受付"]],
      ["ジャーナル", "種別「常時受付」", ["常時受付"]],
      ["デモ", "原文の demo という語", ["demo"]],
      ["デモ発表", "原文の demo という語", ["demo"]],
      ["チュートリアル", "原文の tutorial という語", ["tutorial"]],

      ["チュートリアルセッション", "原文の tutorial という語", ["tutorial"]],
      ["ポスターセッション", "原文の poster という語", ["poster"]],
      ["ワークショップ形式", "原文の workshop という語", ["workshop"]],

      ["チュートリアル提案", "原文の tutorial という語", ["tutorial"]],
      ["チュートリアル募集", "原文の tutorial という語", ["tutorial"]],
      ["ワークショップ提案", "原文の workshop という語", ["workshop"]],
      ["ワークショップ募集", "原文の workshop という語", ["workshop"]],
      ["セッション提案", "原文の session という語", ["session"]],
      ["セッション募集", "原文の session という語", ["session"]],
      ["特別セッション募集", "原文の special session という語", ["special session"]],
      ["学生発表", "原文の student という語", ["student"]],
      ["ポスター提案", "原文の poster という語", ["poster"]],

      ["ワークショップ", "原文の workshop という語", ["workshop"]],
      ["セッション", "原文の session という語", ["session"]],
      ["学生", "原文の student という語", ["student"]],
      ["特別セッション", "原文の special session という語", ["special session"]],
      ["学生セッション", "原文の student という語", ["student"]],

      ["国際", "原文の international という語", ["international"]],
      ["こくさい", "原文の international という語", ["international"]],
      ["國際", "原文の international という語", ["international"]],
      ["国際的", "原文の international という語", ["international"]],
      ["国際的な", "原文の international という語", ["international"]],

      ["国際会議", "原文の international という語", ["international"]],
      ["国際大会", "原文の international という語", ["international"]],
      ["国際学会", "原文の international という語", ["international"]],
      ["国際カンファレンス", "原文の international という語", ["international"]],
      ["国際コンファレンス", "原文の international という語", ["international"]],
      ["国際シンポジウム", "原文の international symposium という語", ["international symposium"]],
      ["国際ワークショップ", "原文の international workshop という語", ["international workshop"]],
      ["年次", "原文の annual という語", ["annual"]],
      ["シンポジウム", "原文の symposium という語", ["symposium"]],
      /* 論文の種類の言い方（片仮名で書く… – 実測と理由は第 723 回に SPEC へ送つた。*/
      ["ショートペーパー", "原文の short paper という語", ["short paper"]],
      ["ショートペーパー募集", "原文の short paper という語", ["short paper"]],
      ["ショートペーパー投稿", "原文の short paper という語", ["short paper"]],

      ["ロングペーパー", "原文の full paper という語", ["full paper"]],
      ["トラックペーパー", "原文の track paper という語", ["track paper"]],
      ["トラックペーパー募集", "原文の track paper という語", ["track paper"]],
      ["ポジションペーパー", "原文の position paper という語", ["position paper"]],
      ["ポジションペーパー募集", "原文の position paper という語", ["position paper"]],
      ["テクニカルペーパー", "原文の technical paper という語", ["technical paper"]],
      ["テクニカルペーパー募集", "原文の technical paper という語", ["technical paper"]],
      ["デモ論文", "原文の demo paper という語", ["demo paper"]],
      ["デモ論文募集", "原文の demo paper という語", ["demo paper"]],
      /* 上の `特別セッション` と同じ打ち方（片仮名で書く運用語 – 実測で `スペシャルセッション`
       * **0 行で案内も無し**、その方の "special session" は繋がって書かれた行が 3 行）。 */
      ["スペシャルセッション", "原文の special session という語", ["special session"]],
      ["スペシャルセッション募集", "原文の special session という語", ["special session"]],

      ["アルゴリズム", "原文の algorithm という語", ["algorithm"]],
      ["自動化", "原文の automation という語", ["automation"]],
      ["オーケストレーション", "原文の orchestration という語", ["orchestration"]],
      ["コンテナ", "原文の container という語", ["container"]],
      ["コンテナオーケストレーション", "原文の orchestration という語", ["orchestration"]],
      ["ミドルウェア", "原文の middleware という語", ["middleware"]],
      ["マイクロアーキテクチャ", "原文の microarchitecture という語", ["microarchitecture"]],
      ["ニューラル", "原文の neural という語", ["neural"]],
      ["ニューラルネットワーク", "原文の neural network という語", ["neural network"]],
      ["異常検知", "原文の anomaly detection という語", ["anomaly detection"]],

      ["リアルタイムシステム", "原文の real-time という語", ["real-time"]],
      ["プロシーディング", "原文の proceedings という語", ["proceedings"]],
      ["プロシーディングス", "原文の proceedings という語", ["proceedings"]],
      ["プロシーディングズ", "原文の proceedings という語", ["proceedings"]],
      ["メモリ", "原文の memory という語", ["memory"]],
      /* `edge` は寄せない – `knowledge` の中に含まれて CIKM・KR など 26 行が「エッジ」で
       * 出てしまう（同じビルドで実測: `edge` を含む行 30 件のうち 26 件が knowledge 由来）。
       * 語として出る `edge computing` だけに寄せる。 */
      ["エッジ", "原文の edge computing という語", ["edge computing"]],
      ["エッジコンピューティング", "原文の edge computing という語", ["edge computing"]],
      ["エッジコンピュティング", "原文の edge computing という語", ["edge computing"]],

      ["画像認識", "原文の computer vision という語", ["computer vision"]],
      ["マルチメディア", "原文の multimedia という語", ["multimedia"]],
      ["ビッグデータ", "原文の big data という語", ["big data"]],
      ["大量データ", "原文の big data という語", ["big data"]],
      ["知識発見", "原文の knowledge discovery という語", ["knowledge discovery"]],
      ["データサイエンス", "原文の data science という語", ["data science"]],
      ["生体", "原文の bio という語", ["bio"]],
      ["バイオ", "原文の bio という語", ["bio"]],
      ["リコメンデーション", "原文の recommendation という語", ["recommendation"]],
      ["レコメンデーション", "原文の recommendation という語", ["recommendation"]],
      ["レコメンド", "原文の recommendation という語", ["recommendation"]],

      ["情報セキュリティ", "分野名の セキュリティ という語", ["セキュリティ"]],
      ["暗号学", "原文の 暗号 という語", ["暗号"]],
      ["理論計算機科学", "分野名の 計算理論 または原文の 理論 という語", ["計算理論", "理論"]],
      [
        "理論コンピュータ科学",
        "分野名の 計算理論 または原文の 理論 という語",
        ["計算理論", "理論"],
      ],
      ["音声認識", "原文の speech という語", ["speech"]],
      ["統計学", "原文の statistics という語", ["statistics"]],
      /* 開催地の州名を日本語で打った人 – 決め手と実測は SPEC §8に置く（注を纏めた – 第 537 回）。*/
      ["カリフォルニア", "原文の california または ca という語", ["california", "ca"]],
      ["カリフォルニア州", "原文の california または ca という語", ["california", "ca"]],
      ["コロラド", "原文の colorado または co という語", ["colorado", "co"]],
      ["コロラド州", "原文の colorado または co という語", ["colorado", "co"]],
      ["テキサス", "原文の texas という語", ["texas"]],
      ["テキサス州", "原文の texas という語", ["texas"]],
      ["ジョージア", "原文の georgia または ga という語", ["georgia", "ga"]],
      ["ジョージア州", "原文の georgia または ga という語", ["georgia", "ga"]],
      ["ペンシルベニア", "原文の pennsylvania という語", ["pennsylvania"]],
      ["ペンシルベニア州", "原文の pennsylvania という語", ["pennsylvania"]],
      ["バージニア", "原文の virginia という語", ["virginia"]],
      ["バージニア州", "原文の virginia という語", ["virginia"]],
      ["アリゾナ", "原文の arizona という語", ["arizona"]],
      ["アリゾナ州", "原文の arizona という語", ["arizona"]],
      ["イリノイ", "原文の illinois または il という語", ["illinois", "il"]],
      ["イリノイ州", "原文の illinois または il という語", ["illinois", "il"]],
      ["フロリダ", "原文の florida または fl という語", ["florida", "fl"]],
      ["フロリダ州", "原文の florida または fl という語", ["florida", "fl"]],
      ["マサチューセッツ", "原文の massachusetts または ma という語", ["massachusetts", "ma"]],
      ["マサチューセッツ州", "原文の massachusetts または ma という語", ["massachusetts", "ma"]],
      ["メリーランド", "原文の maryland または md という語", ["maryland", "md"]],
      ["メリーランド州", "原文の maryland または md という語", ["maryland", "md"]],
      ["ワシントン", "原文の washington または wa という語", ["washington", "wa"]],
      ["ワシントン州", "原文の washington または wa という語", ["washington", "wa"]],
    ];

    QUERY_SYNONYMS_JA.concat(WEEKDAY_QUERY_SYNONYMS_JA, UPSTREAM_TEXT_QUERY_SYNONYMS_JA).forEach(
      ([word, shown, terms]) => {
        out[kanaFold(word)] = [shown, terms];
      },
    );
    return out;
  }

  /* 件数欄に出す「こう探しました」。展開した語だけを言い、行数は数えない
   * （行番号に連番を付けているため、件数を書くと誤読を招く）。 */
  /* 検索語を書き換えたときは、その場でおしらせする（件数欄が使う）。
   * 寄せた語（`スパコン` → 分野「高性能計算」）と、割った語（`nsdi27` → `nsdi` と `2027`）を
   * 同じ入口で返す。理由も見ずに分野全体の行を並べたり、別々の語を含む行を返したりすると、
   * なぜその行が出たか分からないまま行数の壁になる。 */
  /* 表示側で日本語に寄せる開催地の語（国名など）。検索語のおしらせでは、
   * 画面に既に日本語で出る語を「英語で書かれた開催地を探した」と書かないために使う。 */
  let displayedPlaceTermSet: Set<string> | null = null;
  function displayedPlaceTerms(): Set<string> {
    if (!displayedPlaceTermSet) {
      displayedPlaceTermSet = new Set(
        PLACE_TERMS_JA.map((entry) => String(entry[0]).toLowerCase()),
      );
    }
    return displayedPlaceTermSet;
  }

  const WHOLE_TABLE_QUERY_JA = [
    "締め",
    "締め切り",
    "締切り",
    "しめきり",
    "締切日",

    "〆切日",
    "締め切り日",
    "提出期限",
    // 「〜の会議」で打つ人は表の subject を打ち返しているだけで、絞り込みになっていない
    // （第 245 回・2026-08-09 生成ビルドの実測: `会議` `大会` `カンファレンス` は 0 行で、
    // `セキュリティの会議` も 0 行だった。`セキュリティ` だけなら 152 行）。
    // 「シンポジウム」3 行・「ワークショップ」126 行のような部分集合の語は載せない。
    "会議",
    "大会",
    "カンファレンス",
    // 表その物を指す言い方は、この画面を見ている人が「一覧が見たい」と打つ語なので、
    // 絞り込みには使わない（第 248 回の実測: `一覧` `一覧表` `締切一覧` はいずれも 0 行で、
    // 収録の全行が締切の一覧だった。`リスト` は 1 行に当たるので載せない）。
    "一覧",
    "一覧表",
    "締切一覧",

    "すべて",
    "全て",
    "全件",
    "全部",
    "全締切",

    "〆切り",
    "〆め切り",
    "しめきり日",
    "〆切日付",
    "〆切一覧",
    "デッドライン",
    "でっどらいん",
    // ひらがなで打つ人と同じ判断をするための生字（`wholeTableQueryWordJa` は小文字化だけで
    // 比べる – 第 239 回の方針）。片仮名は `kanaFold` が折るので書かなくていい。
    "かいぎ",
    "たいかい",

    "情報工学",
    "情報科学",
    "情報学",
    "情報系",
    "計算機科学",
    "コンピュータサイエンス",

    "シメキリ",
    "カイギ",
    "タイカイ",
  ];

  /**
   * 検索語がこの表その物を指す語のとき、打たれた語を返す（そうでなければ空）。
   * 小文字化と前後の空白だけ整える – `kanaFold` に寄せると、漢字の語に対して
   * 不要な依存（発音記号の表）を検査側に押し付けることになる。
   */
  function wholeTableQueryWordJa(query: unknown): string {
    const 頼み = [
      "表示",
      "表示して",
      "表示する",
      "出して",
      "出してください",
      "出たい",
      "見たい",
      "見せて",
      "見せてください",
    ];

    const 折る = (値: string) => (typeof 値.normalize === "function" ? 値.normalize("NFKC") : 値);
    const q = 折る(String(query == null ? "" : query))
      .trim()
      .toLowerCase();
    if (!q) return "";
    const hit = WHOLE_TABLE_QUERY_JA.find((word) => 折る(word).toLowerCase() === q);
    if (hit) return hit;

    for (const 語尾 of 頼み) {
      if (q.length > 語尾.length && q.endsWith(語尾)) {
        const 核 = q.slice(0, q.length - 語尾.length);
        const h = WHOLE_TABLE_QUERY_JA.find((word) => word.toLowerCase() === 核);
        if (h) return h;
      }
    }
    return "";
  }

  const WHOLE_TABLE_COPY_OMITTED_JA = new Set(["デッドライン", "でっどらいん"]);

  function 全行の語の組みJa(query: unknown): string {
    const 元 = String(query == null ? "" : query).trim();
    if (!元) return "";
    /* 長い語から当てる（`一覧表` を `一覧` + `表` に割らん為）。 */
    const 語々 = WHOLE_TABLE_QUERY_JA.map((word) => word.toLowerCase()).sort(
      (甲, 乙) => 乙.length - 甲.length,
    );
    let 残 = 元.toLowerCase();
    let 數 = 0;
    while (残.length > 0) {
      const 次 = 語々.find((語) => 残.startsWith(語));
      if (!次) break;
      /* 語と語の間の「の」・空格・中黒は、繋げて打つた形と同じに見る。 */
      残 = 残
        .slice(次.length)
        .replace(/^[ \u3000・、,]+/, "")
        .replace(/^の/, "");
      數 += 1;
    }
    return 數 >= 2 && 残 === "" ? 元 : "";
  }

  /** 0 件の画面に出す打ち直し方（読み上げ側の短い文も同じ語列表から作る）。 */
  function wholeTableQueryNoteJa(query: unknown): string {
    const word = wholeTableQueryWordJa(query) || 全行の語の組みJa(query);
    if (!word) return "";
    const 名指し = WHOLE_TABLE_COPY_OMITTED_JA.has(word) ? "その語" : `「${word}」`;
    return (
      ` ${名指し}はこの表の全行にあてはまる語なので、検索では絞り込めません。` +
      "会議名（`SC`）・分野（`セキュリティ`）・開催地（`パリ`）のように、表の欄に出る語で打ってください。" +
      /* 「全部見たい」の頼み方には、その場打ち直しがある。 */
      "表の全行を見たい時は検索語を消してください（過ぎた締切は『過去の締切も表示』で出ます）。"
    );
  }

  const COLUMN_VALUE_EXAMPLES_JA: Record<string, string[]> = {
    分野: ["セキュリティ", "機械学習", "高性能計算"],
    種別: ["論文締切", "概要締切"],
    参加形式: ["オンライン参加可"],
    開催地: ["国内", "米国"],
    地域: ["アジア", "ヨーロッパ"],

    会期: ["2026年12月", "2027年3月"],
  };
  /* 打たれた語 -> 画面に出る欄の名前（`COLUMN_VALUE_EXAMPLES_JA` の keys）。 */
  const COLUMN_QUERY_WORDS_JA: Array<[string, string]> = [
    ["分野", "分野"],
    ["テーマ", "分野"],
    ["分類", "分野"],
    ["種別", "種別"],
    ["種類", "種別"],
    ["ステータス", "種別"],
    ["参加形式", "参加形式"],
    ["会場", "開催地"],
    /* 会期の欄の別の呼び方。*/
    ["開催期間", "会期"],
    /* 場所の別名– 語の表は完全一致なので、形の変はつた名はその方で置く
     * （`会場名はどこ` 等が黙つていた – 各 0 行を実測）。*/
    /* 「どの国？」と**聞き方の語を付けた名**– 語の表は完全一致なのでその方で
     * 置く（各 0 行を実測で確認）。*/
    ["どの国", "開催地"],
    ["どこの国", "開催地"],
    ["どの都市", "開催地"],
    ["どこの都市", "開催地"],
    ["どの地域", "地域"],
    ["会場名", "開催地"],
    ["開催都市", "開催地"],
    ["開催国", "開催地"],
    ["会場所在地", "開催地"],
    /* 会場の別の言い方。*/
    ["場所", "開催地"],
    ["開催場所", "開催地"],
    ["会議場", "開催地"],
    ["都道府県", "開催地"],

    ["都市", "開催地"],
    ["地域", "地域"],
  ];

  function columnGluedEntryJa(
    query: unknown,
    値が当たるか: (語: string) => boolean,
  ): [string, string] | null {
    const 元 = String(query == null ? "" : query).trim();
    const 折 = 元.toLowerCase();
    let best: [string, string] | null = null;
    for (const [word, column] of COLUMN_QUERY_WORDS_JA) {
      const 語 = word.toLowerCase();
      if (語.length < 2 || !折.startsWith(語)) continue;
      const 値 = 元.slice(word.length).trim();
      if (値.length < 2) continue;
      if (!値が当たるか(値)) continue;
      if (!best || word.length > best[0].length) best = [word, column];
    }
    return best;
  }

  function columnGluedTailEntryJa(
    query: unknown,
    値が当たるか: (語: string) => boolean,
  ): [string, string] | null {
    const 元 = String(query == null ? "" : query).trim();
    const 折 = 元.toLowerCase();
    let best: [string, string] | null = null;
    for (const [word, column] of COLUMN_QUERY_WORDS_JA) {
      const 語 = word.toLowerCase();
      if (語.length < 2 || !折.endsWith(語)) continue;
      const 前 = 元
        .slice(0, 元.length - word.length)
        .replace(/の$/, "")
        .trim();
      if (前.length < 2) continue;

      if (!値が当たるか(前) && !wholeTableQueryWordJa(前)) continue;
      if (!best || word.length > best[0].length) best = [word, column];
    }
    return best;
  }

  function columnQueryEntry(
    query: unknown,
    値が当たるか?: (語: string) => boolean,
  ): [string, string] | null {
    const q = String(query == null ? "" : query)
      .trim()
      .toLowerCase();
    if (!q) return null;
    const 一致 = (語: string) =>
      COLUMN_QUERY_WORDS_JA.find(
        ([word, column]) => word.toLowerCase() === 語 || column.toLowerCase() === 語,
      );
    const 剥ぐ語尾 = [
      "どこで行われるのか",
      "どこにありますか",
      "どこでやるのか",
      "で開催されます",
      "にありますか",
      "はいつですか",
      "で開催される",
      "どちらですか",
      "にあります",
      "されますか",
      "われますか",
      "で開かれる",
      "どこですか",
      "どこにある",
      "なんですか",
      "ありますか",
      "わかります",
      "分かります",
      "はいつ頃",
      "何ですか",
      "はどちら",
      "ですかね",
      "知りたい",
      "はいつ",
      "で開催",
      "はどこ",
      "どちら",
      "ですか",
      "ますか",
      "教えて",
      "あるの",
      "分かる",
      "わかる",
      "の場所",
      "どこ",
      "どれ",
      "？",
      "?",
      "の",
      "は",
      "が",
      "か",
    ];
    const 剥いだJa = (語: string): string => {
      let 残 = 語;
      for (let i = 0; i < 6; i += 1) {
        const 次 = 剥ぐ語尾.find((尾) => 残.length > 尾.length && 残.endsWith(尾));
        if (!次) break;
        残 = 残.slice(0, 残.length - 次.length);
      }
      return 残;
    };
    const 一致剥ぎ付き = (語: string) => 一致(語) || 一致(剥いだJa(語));
    const hit = 一致(q);
    if (hit) return hit;
    {
      /* 助詞と問ひの語を続けただけの打ち方。
       * 語を並べた打ち方には使はれない（その方は下に讓る – 第 354 回の決まり）。*/
      const 剥 = 一致(剥いだJa(q));
      if (剥 && q.split(/\s+/).length === 1) return 剥;
    }

    const 語々 = q.split(/[\s、，,・：:]+/).filter((語) => 語.length >= 1);
    if (語々.length < 2) {
      /* separator の無い繋がれた形（`分野セキュリティ`）はここで切る – 上の門（それだけで行が
       * 出る残り）を通る時だけ受ける。*/
      if (値が当たるか) {
        const 頭 = columnGluedEntryJa(query, 値が当たるか);
        if (頭) return 頭;
        return columnGluedTailEntryJa(query, 値が当たるか);
      }
      return null;
    }
    let best: [string, string] | null = null;
    for (const 語 of 語々) {
      const 當 = 一致剥ぎ付き(語);
      if (當 && (!best || 語.length > best[0].toLowerCase().length)) best = [當[0], 當[1]];
    }

    if (best) return best;
    if (値が当たるか) {
      const 頭 = columnGluedEntryJa(query, 値が当たるか);
      if (頭) return 頭;
      return columnGluedTailEntryJa(query, 値が当たるか);
    }
    return null;
  }

  /** 検索語が欄の名前のとき、打たれた語を返す（読み上げの分岐が使う）。 */
  function columnQueryWordJa(query: unknown): string {
    const hit = columnQueryEntry(query);
    return hit ? hit[0] : "";
  }

  /** 0 件案内に出す打ち直し方（値の例は収録に実在する語だけ – 検査がそれを見る）。 */
  function columnQueryNoteJa(query: unknown, 値が当たるか?: (語: string) => boolean): string {
    const hit = columnQueryEntry(query, 値が当たるか);
    if (!hit) return "";
    const examples = (COLUMN_VALUE_EXAMPLES_JA[hit[1]] || [])
      .map((word) => `「${word}」`)
      .join("・");
    const column = hit[0] === hit[1] ? "この表の欄" : `この表の欄（${hit[1]}）`;
    return (
      ` 「${hit[0]}」は${column}の名前で、値そのものではありません。` +
      `値で検索してください（例: ${examples}）。`
    );
  }

  /** 読み上げ側の短い文（同じ表から作り、画面と読み上げが別のことを言わないようにする）。 */
  function columnQueryLiveNoteJa(query: unknown, 値が当たるか?: (語: string) => boolean): string {
    const hit = columnQueryEntry(query, 値が当たるか);
    if (!hit) return "";
    const first = (COLUMN_VALUE_EXAMPLES_JA[hit[1]] || [])[0] || "";
    const column = hit[0] === hit[1] ? "欄" : `欄（${hit[1]}）`;
    return `「${hit[0]}」は${column}の名前です。値（「${first}」など）で打ってください`;
  }

  function conjunctionQueryNoteJa(query: unknown, 件が当たるか: (文: string) => number): string {
    const 文 = String(query == null ? "" : query).trim();
    if (文.length > 30 || /\s/.test(文) || /\./.test(文)) return "";
    if (件が当たるか(文) !== 0) return ""; // 行が出る打ち方を説教せん。

    const まで家 = /^(.{2,})(までに|まで|から)$/.exec(文);
    if (まで家) {
      const 前 = まで家[1];
      const 接 = まで家[2];
      const 前件 = 件が当たるか(前);

      const 日の語Ja =
        /^(?:[0-9]{1,4}[年月日時周]|[0-9]+週|[月火水木金土日曜]|平日|土日|今[日月週年]|来[日月週年]|先[日月週年]|明[後]?日|あさって|昨日|一昨日|週末|上旬|中旬|下旬|月初|月末|月初|年初|年始|年[末初]|年度|年頭|年度内|年内|半年|一年|[0-9]+年前|[0-9]+年後)/;
      if (前件 > 0 && !日の語Ja.test(前)) {
        const 例の羣 =
          接 === "から" ? ["来週から", "今週から", "8月から"] : ["来月まで", "今月まで", "8月まで"];
        const 示す = 例の羣.find((語) => 件が当たるか(語) > 0);
        return (
          ` 「${文}」のことなら – 「${接}」は日にちに付く語なので、捜れる語に付けても絞り込めません` +
          `（捜は「${前}」を書く行を ${前件} 件見て居ます）。「${前}」だけ、` +
          (示す
            ? `期間で絞るなら「${示す}」（${件が当たるか(示す)} 件）のやうに日にちを添えてお打ちください。`
            : "期間で絞るなら日にちを添えてお打ちください。")
        );
      }
    }
    if (文.length < 5) return "";
    /* 並べる順 – 長い `または` を先に見る（`と` で先に割れると `または` の語が途中で切れる）。
     * 抜き出す検査（`tests/runtime_extract.ts`）は関数の体だけを持ってくるので、表は中の局所に置く。*/
    for (const 目 of ["または", "と", "や"]) {
      const 位置 = 文.indexOf(目);
      if (位置 <= 0) continue;
      const 前 = 文.slice(0, 位置);
      const 後 = 文.slice(位置 + 目.length);
      if (前.length < 2 || 後.length < 2) continue;
      /* 助詞で始まる片側（`ひとつの締切` → `の締切`）は語の途中で割れた物なので讓る
       * （`と` は語の中にも入る – 上の注）。*/
      if (/^[のはがをにでへやもの]/.test(後)) continue;
      const 前件 = 件が当たるか(前);
      const 後件 = 件が当たるか(後);
      if (前件 === 0 && 後件 === 0) continue; // 両方無い – 収録に無い語の話は別の案内がする。
      const 繋いだ = `「${前}」と「${後}」を「${目}」で繋いで打つと両方を含む行を探すため 0 件になります`;
      if (前件 === 0 || 後件 === 0) {
        const 欠 = 前件 === 0 ? 前 : 後;
        const ある = 前件 === 0 ? 後 : 前;
        return (
          ` 「${欠}」を書く行はなく、「${ある}」を書く行は ${前件 === 0 ? 後件 : 前件} 件あります。` +
          `${繋いだ}。どちらかだけで打ってください。`
        );
      }
      return (
        ` 「${前}」を書く行は ${前件} 件、「${後}」を書く行は ${後件} 件ありますが、${繋いだ}。` +
        "どちらかだけで打ってください。"
      );
    }
    return "";
  }

  /* `quiet` に置いた語は案内に書き返さない（この画面の説明文に書かない実装側の語なので、
   * 開発用語を残さない検査に当たる – `カテゴリ` 系と同じ扱い）。主語の無い文で同じことを言う。 */

  const UI_WORD_GROUPS_JA: Array<{
    words: string[];
    echo: boolean;
    note: string;
    live: string;
    /* SPEC 第 326・352・354・503 */
    anyTail?: boolean;
    /* SPEC 第 505 */
    deadlineTail?: boolean;
    /** 数の統計の羣が受ける**比べる語尾**専用の表を見る。*/
    statTail?: boolean;
    quiet?: string[];
    noteQuiet?: string;
    liveQuiet?: string;

    exactOnly?: string[];
    /* SPEC 第 250・354 */
    multiword?: boolean;
    /* 立てた語に行が当たるかに関わらず件数欄に出す。 */
    always?: boolean;
  }> = [
    {
      /* SPEC 第 506・511 */
      /* SPEC 第 641・337・632 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        "使い方",
        "ヘルプ",
        "てびき",
        "つかいかた",
        "みかた",
        "見方",
        "凡例",
        "色分け",
        "印",
        "しるし",
        "読み方",
        "読み上げ",
        "スクリーンリーダー",
        "類義語",
        "一致評価",
        "意味検索",
        "該当なし",
      ],
      /* SPEC 第 250・354・505・511 */
      deadlineTail: true,
      echo: true,
      note: "はこの表の語ではなく、ページの下にある『見方のてびき』に書いています。検索では絞り込めません。",
      live: "は下の『見方のてびき』に書いています（検索では絞れません）",
    },
    {
      /* SPEC 第 643 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: ["略稱", "略称", "正式名", "正式名称", "英語名", "和名", "アルファベット", "ローマ字"],
      echo: true,
      note: "のことなら、行には会議の略称と正式な英語名と（日本の会なら）日本語の学会名を並べて書いて居ります。どれで打っても同じ行になります – 2026-08-09 生成の品書で実測、`icassp` と `international conference on acoustics` はいずれも 7 行。捜しは部分一致なので途中で切れた打ち方も受けますが、二語に割れるとその両方を書く行だけになります（`acoustics speech` のやうに）。",
      live: "のことなら、行には略称と正式名を並べて書くので、どちらで打っても同じ行に出ます",
    },
    /* SPEC 第 294 */
    {
      words: [
        "GPU",
        "CUDA",
        "Kubernetes",
        "OpenMP",
        "PGAS",
        "サーバーレス",
        "連合学習",
        "分散台帳",
        "暗号通貨",
        "エネルギー効率",
        "省電力",
        "サステナビリティ",
        "グリーンIT",
        "ヒューマンコンピュータインタラクション",
        "オーガナイズドセッション",
        "産学セッション",
        "ユーザスタディ",
        "ユーザー研究",
        "ウェブ技術",
        "セマンティックウェブ",
        "オントロジー",
        "自然対話",
        "対話システム",
        "自律移動",
        "Safety-critical",
        "オープンアクセス",
        "著作権譲渡",
        "博士課程学生",
        "産学連携",
        "共同研究",
        "技術移転",
        "研究発表",
        "成果発表",
        "機械翻訳",
        "意味解析",
        /* SPEC 第 642 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "federated",
        "フェデレーテッド",
        "性能評価",
        "ソフトウェアインジニアリング",
        /* SPEC 第 669・534 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "発表番号",
        "索引",
        /* 第 671 回 – 採択後の扱いを訊く人（検索 0 行・讓り無し – `オープンアクセス` は通る）。*/
        "著作権",
        "著作権移譲",
        "ライセンス",
        "クローズドアクセス",
      ],
      /* SPEC 第 337・538 */
      anyTail: true,
      echo: true,
      note: "はこの表の行に書かれて居らん細目の主題です。この表は催し物の分野・種別・開催地・参加形式・締切の日を出しています。其の語を外して分野名（例: 人工知能・セキュリティ・ネットワーク・高性能計算）で打つと絞れます。",
      live: "はこの表の行に無い細目の主題です。分野名（人工知能・セキュリティ・ネットワーク・高性能計算）で打つと絞れます。",
    },
    /* SPEC 第 535・534 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
    {
      /* 参加する人と参加の形。*/
      words: [
        /* SPEC 第 661・588 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "初心者",
        "初学者",
        "初級",
        "中級",
        "上級",
        "入門",
        "実践",
        "実践者",
        "シニア",
        "社会人",
        "技術者",
        "研究者",
        "企業",
        "産業界",
        "業界",
        "院生",
        "修士",
        "一般",
        "女性",
        "男性",
        "ジェンダー",
        "女性限定",
        "男性限定",
        "学生限定",
        /* 第 650 回 – 主語で訪ねる人（`誰が応募できる` – 実測 0 行・案内も無し）。*/
        "誰が応募",
        "誰が参加",
        "若手限定",

        "学生向け",
        "大学院生向け",
        "博士課程",
        "傍聴",
        "見学者",
        "同伴者",
        "家族",
        "一般参加",
        "学部生",
        "大学生",
        "高校生",
        "教員",
        "企業人",
        "引率",
        "同行者",
        "聴講生",
        "研究生",
        "科目等履修生",
        "ポスドク",

        /* 第 719 回 – 実際に打たれる形（文の見本の残り。実測 2026-10-06: 句の侭は 0 行・案内も無し）。*/
        "学生でも投稿できる",
        "学生でも参加できる",
        "学生が投稿できる",
        "学生でも発表できる",
        "初めての投稿",
        "初投稿",
        "学会デビュー",
        "発表が初めて",
        "技術職員",
        "研究員",
        /* SPEC 第 686 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "大学院生",
        "博士学生",
        "学部学生",
        "奨学金",
        "参加支援",
        "参加費補助",
      ],
      /* 語が頭に續く形も受ける（同じ印 – 注は最初に寫す處に置く）。*/
      anyTail: true,
      echo: true,
      note: "のような募集対象や旅費の支援の有無は、この表は持っていません。収録するのは催し物の名前・締切の日・分野・種別・開催地・参加形式です。対象と支援は公式ページでご確認ください。",
      live: "のような募集対象や旅費の支援は、この表は持っていません。公式ページをご確認ください。",
    },
    {
      /* SPEC 第 698 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        "卒論",
        "修論",
        "博論",
        "卒業論文",
        "博士論文",
        "学位",
        "学位論文",
        "博士学位",
        "学位審査",
        "論文審査",
        "課程",
        "ドクター",
        "ドクターコース",
        "ドクトラル",
        "口頭試問",
        "公聴会",
      ],
      echo: true,
      note: "はこの表が持っていません。この表が並べているのは会議・シンポジウム・ワークショップの締切で、学位や課程の手続き（論文審査・公聴会・修了要件）は各大学の教務の案内にあります。博士課程の学生向けの枠（doctoral consortium）を持つ会議もあり、その行は原文の英字で `doctoral` と書かれています。",
      live: "は学位・課程の手続きの言葉です。大学の教務の案内をご覧ください",
    },
    {
      words: ["毎年開催", "隔年開催", "毎年やっている", "隔年でやっている", "何回目", "第何回"],
      echo: true,
      note: "はこの表が持つ欄の名前ではありません。毎年か隔年かは各催し物の公式ページに書かれています。『投稿先を探す』で論文を入れた時に出る候補カードには『収録データ』（収録した開催年と、その会議の論文サンプル数。開催周期や創設年の根拠ではありません）も出ます。",
      live: "はこの表が持っていません。公式ページと、候補カードの『収録データ』をご覧ください",
    },
    /* SPEC 第 337・536 */
    {
      /* SPEC §8（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        "プロポーザル",

        "発表者登録",
        "特殊セッション",
        "トラック",
        /* SPEC 第 691 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "ラウンドテーブル",
        "ボスターセッション",
        "英語セッション",
        /* 發表の呼び方と、次の回への引き渡し。*/
        "論文発表",
        "引き継ぎ",

        "チュートリアルの依頼",
        "ワークショップの提案",
        "企画セッションの提案",
        "タイムキーパー",
        "質問時間",
        "記念撮影",
        "SNS投稿",
        "ハッシュタグ",
        "広報",
        "参加者名簿",
        "資料公開",
        "開催中止",
        "開催延期",
        /* SPEC 第 688 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "サテライト",
        "併設",

        "特集セッション",
        "途中参加",
        "途中退出",
        "遅刻",
        "名簿",
        "参加者一覧",
        "スライド公開",
        /* SPEC 第 663・588 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "取消し規約",
        "取消規約",
        "参加規約",
        "利用規約",
        "日程の変更",
        "繰上げ",
        "繰下げ",
        "エントリー",
        "口頭セッション",
        "発表集録",
        "学会集録",
        "記録",

        "企業展示",
        "出展",
        "ポスターサイズ",
        "遅延申請",
        /* SPEC 第 644 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "配信",
        "ライブ配信",
        "差し替え",
        "再提出",
        "録画配信",
        "オンライン配信",
        "参加登録方法",
        "領収書",
        "請求書",
        "委託料",
        "謝金",
        "開場",
        "前日受け付け",
        "当日参加",
        "直前",
        "キャンセル",
        /* SPEC 第 670 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "欠席",
        "不参加",
        "払い戻し",
        "取り消し",
        "レシート",
        "Invoice",
        "科研費",
        "出願",
        "特許",
        "招聘",
        "客員研究員",
        "博士後期",
        "単位互換",
        "滞在費",
        "発表料",
        "原稿料",
        "論文費",
        "ページチャージ",
        "印刷費",
        "遅延登録",
        "延長登録",
        "再登録",
        "証明書",
        "参加証明",
        "出席証明",
        "発表証明",
        "最終告知",
        "校了",
        "組版",
        "懇親会",
        "昼食",
        "ランチ",
        "送迎",
        "論文集",
        /* SPEC 第 671 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "DVD",
        "USB",
        "入会",
        "討論",
        "パネル",
        "受付",
        "案内状",
        "shepherding",
        "審査委員",
        "不合格",
        "採否の理由",
        "査読コメント",
        "コメント",
        "名札",
        "参加証",
        "振込",
        "入金",
        "返金",
        "支払",
        "学生割",
        "ビザレター",
        "入国",
        "消費税",
        "銀行",
        "納品書",
        "出張届",
        /* 第 715 回 – 利用者が実際に打つ形（文の見本 106 文の残りから）。その群の斷りがそのまま答へになる物だけを載せる。*/
        "学会参加の許可",
        "参加の許可",
        "出張申請",
        /* 第 719 回 – 実際に打たれる形（文の見本の残り。実測 2026-10-06: 句の侭は 0 行・案内も無し）。*/
        "デモができる会議",
        "デモ発表がある",
        "発表時間が長い",
        "質疑応答が長い",
        "依頼書",
        "内諾",
        "査読料",
        "論文掲載料",
        "発表論文集",
        "休憩",
        "就査証",
        "依頼状",
        "校正刷",
        "広告",
        "展示",
        "実行委員長",
        "プログラム委員長",
        "実行委員",
        "運営委員",
        "組織委員",
        "受賞者",
        "学会賞",
        "学生優秀賞",
        /* SPEC 第 690 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "ポスター賞",
        "優秀発表賞",
        "研究賞",
        "功績賞",
        "研究奨励賞",
        "若手研究者賞",
        "国際会議賞",
        "ベストポスター",
        "オーディエンス賞",
        /* SPEC 第 687 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "学生賞",
        "飛び入り",
        "見学",
        "開演",
        "開会",
        "閉会",
        "進行",
        "登壇順",
        "発言時間",
        "昼休み",
        "特別講演",
        "招待講演者",
        "登壇者",
        "投稿番号",
        "採択通知メール",
        "掲載確定",
        "当日登録",
        "所属の変更",
        "著者順",
        "発表の可否",
        "発表可否",
        "参加可否",
        "出張報告",
        "発表取消",
        "参加取消",
        "事前確認",
        "原稿の言語",
        "口頭の言語",
        "質問の受付",
        "連絡方法",
        "資料配布",
        "資料ダウンロード",
        "スライド提出",
        "動画提出",
        "当日欠席",
        "代理出席",
        /* 代理その物（`代理の方が出席できますか` – 実測 0 行 – 第 620 回）。*/
        "代理",
        "代理発表",
        "アナウンス",
        "更新情報",
        "変更点",
        "締切の変更",
        "締切短縮",
        "日時の変更",
        "会場変更",
        "会場の変更",
        "振替",
        "延期",
        "中止",
        "終了告知",
        "当日券",
        "正規登録",
        "グループ割",
        "無料参加",
        "聴講無料",
        "登壇リハ",
        "事前リハ",
        "名刺交換",
        "ネットワーキング",
        "情報交換",
        "採用",
        "求人",
        "リクルート",
        "企業説明",
        "産学交流",
        "連携提案",
        "発表順",
        "セッション順",
        "登壇時間",
        "採否の照会",
        "採択証明",
        "掲載証明",
        "登録内容の変更",
        "口座情報",
        "名義変更",
        "明細書",
        "個人会員",
        "法人会員",
        "会員費",
        "入会手続",
        "退会",
        "会員番号",
        "会員証",
        "二重会員",
        "会員種別の変更",
        "非会員参加",
        "会員以外",
        "生配信",
        "アーカイブ配信",
        "見逃し配信",
        "後日視聴",
        /* 第 648 回 – 後から観る形と、その時に配る物（実測 0 行・案内も無し）。*/
        "録画視聴",
        "アーカイブ公開",
        "期間限定公開",
        "技術報告",
        "ポスター印刷",
        "在學証明",
        "在籍証明",
        "指導教員",
        "業績",
        "研究実績",
        "発表実績",
        "簡易書留",
        "書留",
        "消印",
        "宿泊無し",
        "日帰り",
        "近場",
        "総会",
        "理事会",
        "支部",
        "地域支部",
        "幹事",
        "役員の選出",
        "投票",
        "電子投票",
        "委任状",
        "議事録",
        "送金",
        "外貨",
        "源泉徴収",
        "個人番号",
        "緊急セッション",
        "減免",
        "免除",
        "助成",
        "出張支援",
        "若手支援",
        "日本語発表",
        "英語必須",
        "発音",
        "翻訳サービス",
        "英語支援",
        "筆談",
        "精算",
        /* SPEC 第 672・671 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "立替",
        "経理",
        "決裁",
        "申請書",
        "伝票",
        "口座振込",
        "決算",
        "報告書",
        "お礼状",
        "教務",
        "パネリスト登壇",
        "後日配信",
        "記錄視聴",
        "ポスター発表時間",
        "講師",
        "保険",
        /* 渡航の備え。*/
        "海外旅行保険",
      ],
      /* 語が頭に續く形も受ける（同じ印 – 注は最初に寫す處に置く）。*/
      anyTail: true,
      echo: true,
      note: "はこの表が持つ欄の名前ではありません。収録するのは催し物の名前・締切の日・分野・種別・開催地・参加形式で、運営と手続きのこと（発表の形・展示・費用・配信・取り消し・当日の進行と参加者の名簿）は各催し物の公式ページに書かれて居ます。",
      live: "はこの表の欄に無い運営・手続きのことです。公式ページをご覧ください。",
    },
    /* SPEC 第 536 */
    {
      /* SPEC 第 337 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        /* SPEC 第 388 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "出版",
        "掲載",
        "掲載誌",

        "ISBN",
        "DOI",

        "学会誌",
        "速報誌",
        /* SPEC 第 688 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "学術雑誌",
        "ジャーナル論文",
        "原著論文",
        "短報",
        "投稿論文",
        "紀要",
        "研究会誌",
        "予稿集",
        "プログラム集",
        "講演集録",
        "抄録集",
        "プロシーディングス購読",
      ],
      /* 語が頭に續く形も受ける（同じ印 – 注は最初に寫す處に置く）。*/
      anyTail: true,
      echo: true,
      note: "はこの表が載せる種別と違います。この表は会議・シンポジウム・ワークショップの締切を出しています（例: 『論文締切』『ワークショップ 締切』）。学会誌や論文誌の投稿規程はこの表には出て居ません。",
      live: "はこの表が載せる会議と別の種別です。この表は会議・シンポジウム・ワークショップの締切を出しています。",
    },
    /* SPEC 第 542 */
    {
      words: ["ハッカソン", "アイディアソン", "サマースクール", "夏季学校", "冬季学校"],
      echo: true,
      anyTail: true,
      note: "はこの表が載せる種別（会議・シンポジウム・ワークショップ）に入らん催し物の形です。この表は締切の一覧で、其の方の催し物や学校の募集は出して居ません。",
      live: "はこの表が載せる種別と違う催し物の形です。この表は締切の一覧です。",
    },
    /* SPEC 第 337・543 */
    {
      words: [
        "最寄り",
        "ホテル手配",
        "宿泊手配",
        "駐車場",
        "地図",
        "会場地図",
        "会場案内",
        "服装",
        "持ち物",
        "荷物",
        "手荷物",
        "両替",
        "プロジェクター",
        "電源",
        "有線LAN",
        "Wi-Fi",
        /* 持ち込む物と下見の名。*/
        "発表練習",
        /* 助詞を挾んだ形（第 712 回 – 実測 2026-10-06: `発表の練習` は 0 行・案内も無しだつた。*/
        "発表の練習",
        "リハーサル",
        "HDMI",
        "ネット環境",
        "無線LAN",
        "機材",
        "椅子",
        "配布物",
        "会場レイアウト",
        "搬入",
        "搬出",
        "設営",
        "解体",
        "撮影",
        "写真撮影",
        /* SPEC 第 691 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "録音許可",
        "肖像権",
        "報道",
        "取材",
        "記者",
        "プレス",
        "USBメモリ",
        "前日入り",
        "後片付け",
        "介添",
        "ドレスコード",
        /* SPEC 第 617・337・512 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "車",
        "自家用車",
        "マイカー",
        "交通アクセス",
        "交通機関",
        "電車",
        "地下鉄",
        "タクシー",
        "最寄り駅",
        "宿",
        /* SPEC 第 672 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "素泊まり",
        "ゲストハウス",
        "現地集合",
        "移動日",
        /* SPEC 第 516・337・617 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "民宿",
        "旅館",
        "宿泊先",
        /* 泊まりの手配の名。*/
        "ホテル予約",
        "相部屋",
        "一人部屋",
        /* SPEC 第 505・617 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "車で",
        "車に",
        "宿の",
        "宿に",
        "バスツアー",
        "見学会",
        "エクスカーション",
        "空港",
      ],
      echo: true,
      anyTail: true,
      note: "はこの表が持つ開催地（街の名前）とは別の案内です。この表は催し物の名前・締切の日・分野・種別・開催地・参加形式を出しています。会場の中と外のこと（最寄り・駐車・地図・誘導・往き方・泊まる所）は各催し物の公式ページに書かれて居ます。",
      live: "はこの表が持つ開催地とは別の、会場まわりの案内です。公式ページをご覧ください。",
    },
    /* SPEC 第 337・540 */
    {
      /* SPEC §8（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        "次回",
        "終了時刻",
        "何時",
        "何日",
        "何曜日",
        "いつ迄",
        "何時から",
        "何時迄",
        "何月",
        "いつから",
        "タイムゾーン",
      ],
      echo: true,
      anyTail: true,
      exactOnly: ["いつ頃", "いつ締まる", "いつになる"],
      note: "という聞き方では絞り込めません。この表は締切の日を持つ表です。日付で絞るには「2026年」「8月」「今月」のような形で打ちます。",
      live: "という聞き方では絞り込めません。日付は「2026年」「8月」「今月」のような形で打ちます。",
    },
    /* SPEC 第 540 */
    {
      words: ["日程表", "会期表", "日程一覧"],
      echo: true,
      anyTail: true,
      note: "はこの表が出す物ではありません。この表が出す日付は締切の日で、会議の日程その物の並びは持っていません。",
      live: "はこの表が出す物ではありません。この表が出す日付は締切の日です。",
    },
    /* SPEC 第 337・541 */
    {
      words: [
        "自己引用",
        "再現性",
        "データ公開",
        "研究倫理",
        /* 第 671 回 – 倫理の手続きを略語と和名で。*/
        "IRB",
        "同意書",
        "Appendix",

        "募集要項",
        /* SPEC 第 688 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "応募要領",
        "改訂",

        "追加資料",
        "動画",
        "デモ動画",
        "コード公開",

        "投稿規定",
        "執筆ガイドライン",
        "投稿要領",
        "投稿フォーマット",
        "原稿書式",
        "テンプレート",
        "二段組",
        "ページ数",
        /* 第 670 回 – 原稿の形をその方の名で打つ人（`ページ数` は通る）。斷りが既に「原稿の
         * 書式・頁数」を名指している。*/
        "書式",
        "フォーマット",
        "最大ページ",
        "原稿の長さ",
        "最大ページ数",
        "ページ制限",
        "英語原稿",
        "和文原稿",
        "図表",
        "参考文献形式",
        "引用形式",
        /* SPEC 第 691 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "キャプション",
        "付録",
        "オーバーレングス",
        "インフォームドコンセント",
        /* SPEC 第 687 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "LaTeX",
        "Overleaf",
        "参考文献",
        "文字数",
        "前刷り",
        "別刷り",
        "倫理",
        "倫理審査",
        "剽窃",
        "被験者",
        "再投稿",
        "著者情報",
        "所属機関",
        "肩書",
        "連絡先",
        "執筆料金",
        "リジェクト",
        "別投稿",
        "転載",
        "二重投稿",
        /* SPEC 第 672 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "並行投稿",
        "arxiv",
        "自己援用",
        "プレプリント",
        "arXiv投稿",
        "出版倫理",
        /* 出版の識別子（`ISSN は取っていますか` – 実測 0 行 – 第 620 回）。*/
        "ISSN",
        "利益相反",
        "プロシーディングス出版",
        /* SPEC 第 663・588 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "転投",
        "追加実験",
        "リバットル",
        "速報",
        "論文特集",
        "特集論文",
        "投稿規程",
        "校正",
        "日本語で投稿",
        "日本語投稿",
        "和文投稿",

        "謝辞",
        "募集期間",
        "投稿期間",
        /* 一枚物の寸法（`A0かA1か` – 実測 0 行）。原稿の書式の話なのでこの羣。*/
        "A0",
        "A1",
        "B0",
        "寸法",
        "判型",
        "サイズ",
      ],
      echo: true,
      anyTail: true,
      note: "はこの表が持つ欄の名前ではありません。この表は催し物の名前・締切の日・分野・種別・開催地・参加形式を出しています。原稿の書式・頁数・投稿の手続きは各催し物の公式ページに書かれて居ます。",
      live: "はこの表の欄に無い、原稿と投稿の手続きのことです。公式ページをご覧ください。",
    },
    {
      /* SPEC 第 248・338 */
      words: [
        "并べ替え",
        "并べ替える",
        "並びかえ",
        "並びかえる",
        "近い順に",
        "早い順に",
        "遅い順に",
        "新しい順に",
        "古い順に",
        "順に表示",

        "並び替え",
        "並び順",
        "並べ替え",
        "ソート",
        /* SPEC 第 385 */
        "日付順",
        "sort",
        "昇順",
        "降順",
        "早い順",
        "遅い順",
        "近い順",
        "遠い順",
        "新しい順",
        "古い順",
        "会議名順",
        "名前順",
        "ランク順",
        "会期順",
        "残り順",
        "日時順",
        /* SPEC 第 643・337 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "年度順",
        "少ない順",
        "多い順",
        "並べる",
        "並べたい",
        "並びたい",
        "並ぶ",
        "並べて",
      ],
      echo: true,
      /* SPEC 第 505・506 */
      deadlineTail: true,
      /* SPEC 第 250・354・507 */
      multiword: true,
      note: "はこの表の語ではなく、列の見出し（『残り』『日時』『会期』『会議』『ランク』）を押して操作します。狭い画面では表の上に出る並べ替えの欄を使います。検索欄には打ち込まないでください。",
      live: "は列の見出し（『残り』『日時』など）で操作します",
    },
    {
      /* SPEC 第 338・339 */
      words: [
        "まもなく",
        "まもなく締切",
        "前もって",
        "前もってどれくらい",
        "前もって何日",
        "締切はいつまで",

        "当面",
        "しばらく",
        "近いうち",
        "近い内",
        "直近",
        "間もなく",
        /* SPEC 第 390 */
        "近日",
        "近日中",
        "早いうち",
        "もうすぐ",
        "もう間もなく",
        "早め",
        "締切の近い",
        "いつまで",
        /* SPEC 第 415 */
        "数日",
        "数日間",
        "数日以内",
        "数週間",
        "数週間以内",
        "数か月",
        "数ヶ月",
        "数カ月",
        "数ケ月",
        "数か月以内",
        "数ヶ月以内",
        "数カ月以内",
        "数ケ月以内",
        "数年",
        "数年以内",
        "あと何日",
        /* SPEC 第 681 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      ],
      /* SPEC 第 503・504 */
      anyTail: true,
      echo: true,
      exactOnly: ["間に合う", "間に合うか", "間に合う？", "間に合う会議", "いつまでに"],
      note: "という曖昧な幅では絞り込めません。上の『締切まで』の欄（『7 日以内』『30 日以内』『90 日以内』『180 日以内』）で締切日からの日数を選んでください。この欄は締切日からの日数で、会期の長さではありません。",
      live: "は曖昧な幅では絞れません。上の『締切まで』の欄（『7 日以内』『30 日以内』など）で日数を選んでください",
    },
    {
      /* 人気という順は無い – ある順の名前を並べて答える。 */
      /* SPEC §8（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: ["人気順", "人気", "おすすめ順", "注目順", "評価順", "締切順"],
      echo: true,
      deadlineTail: true,
      /* 注は初出に置く。*/
      multiword: true,
      note: "という順はこの表にありません。並べ替えられるのは列の見出し（『残り』『日時』『会期』『会議』『ランク』）です。",
      live: "という順はありません。並べられるのは列の見出し（『残り』『日時』『会期』『会議』『ランク』）です",
    },

    {
      words: ["開催が近い", "開催が近い会議", "会期が近い", "開催間近"],
      echo: true,
      note: "はこの表が持つ欄の名前ではありません。開かれる日の近い順に見るには、列『会期』の見出しを押してください（この表の既定の並びは締切の近い順です）。会期が『未確認』の行は、どちらの向きでも末尾に置きます。",
      live: "は欄の名前ではありません。開かれる日の順は列『会期』の見出しを押してください",
    },

    {
      words: [
        "英文校正",
        "ネイティブチェック",
        "図の作り方",
        "表の作り方",
        "コードの公開",
        "実験の再現",
        "新規性の主張",
        "貢献の書き方",
        "反論の書き方",
        "想定質問",
        "論文の書き方",
        "発表の準備",
        "ポスターの作り方",
        "論文の推敲",
        "添削",
        "執筆",
      ],
      echo: true,
      note: "は論文や発表の作り方の話で、この表が持つ欄の名前ではありません。この表が並べているのは催し物の名前・締切の日・分野・種別・開催地・参加形式・等級です。書き方と準備の案内は各会議の投稿規定や発表の案内、所属の研究室・大学の支援（英文校正の窓口など）にあります。",
      live: "は論文や発表の作り方の話です。投稿規定や所属の支援をご覧ください",
    },
    {
      /* 絞り込みを訊く語 – こちらは本当に欄の操作（`種別` `ランク` `締切まで` `条件クリア`）。 */
      words: ["絞り込み", "フィルタ", "条件"],
      echo: true,
      deadlineTail: true,
      /* 注は初出に置く。*/
      multiword: true,
      note: "はこの表の語ではなく、上にある欄（『種別』『ランク』『締切まで』『条件クリア』）で操作します。検索欄には打ち込まないでください。",
      live: "は上にある欄で操作します（検索欄には打ち込まないでください）",
      quiet: ["フィルタ"],
      noteQuiet:
        "操作はこの表の話ではなく、上にある欄（『種別』『ランク』『締切まで』『条件クリア』）で行います。検索欄には打ち込まないでください。",
      liveQuiet: "操作は上にある欄（『種別』など）で行います。検索欄には打ち込みません",
    },
    {
      /* SPEC 第 246・249 */
      words: [
        "対面",
        "対面開催",
        /* SPEC 第 249 */
        "対面参加",
        "対面のみ",
        "オフライン",
        "オフライン参加",
        "オフライン開催",
        "オフラインのみ",
        "オンサイト",
        "オンサイト参加",
        "オンサイト開催",
        "オンサイトのみ",
        "現地",
        "現地開催",
        "現地参加",
        "現地のみ",
        "リアル",
        "リアル開催",
        "リアル参加",
        "リアルのみ",
        /* SPEC 第 249 */
        "ハイブリッドのみ",
        "ハイブリッドだけ",
        "オンラインだけ",
        "対面だけ",
        /* SPEC 第 659・588・660 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "オンライン限定",
        "ハイブリッド限定",
        "バーチャル限定",
        /* SPEC §8（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "会場参加",
        "現地対面",
        /* SPEC 第 509 */
        "ブレンデッド",
        "ブレンド",
        "混合",
        "混在",
        "併用",
        "オンライン併用",
        "対面とオンライン",
        "部分参加",
        /* SPEC 第 617・337・505 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "完全オンライン",
        "オンライン聴講",
        "聴講だけ",
        "聴講",
      ],
      multiword: true,
      /* SPEC 第 505 */
      deadlineTail: true,
      echo: true,
      note: "は参加形式の言い方ですが、この表は参加形式の印として『オンライン参加可』だけを出していて、対面かどうかは収録していません。オンラインで参加できる行は『オンライン参加可』で探せます。",
      live: "参加形式は『オンライン参加可』の印だけです。対面は収録していません",
    },
    /* SPEC 第 325・337 */
    {
      /* SPEC §8（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        "インボイス",
        /* 第 715 回 – 利用者が実際に打つ形（文の見本 106 文の残りから）。その群の斷りがそのまま答へになる物だけを載せる。*/
        "参加費を払った",
        "学協会費",
        /* SPEC 第 690 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "学生会員",
        "正会員",
        "賛助会員",
        /* 会員の別の段。*/
        "フェロー",
        "交通費支給",
        "宿泊補助",
        "現金",

        "OA料金",

        "参加費",
        /* 頁を越えた分の費用。*/
        "ページ課金",
        /* 平たい言ひ方（`お金はいりますか` – 実測 0 行・費用の群 – 第 620 回）。*/
        "お金",
        "参加費用",
        "参加料",
        "学生参加費",
        "非会員",
        "非会員価格",
        "会員価格",
        "登録費",
        "費用",
        "参加費無料",
        "登録費無料",
        "無料",
        "有料",
        "経費",
        "旅費",
        "学生割引",
        /* SPEC 第 644 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "投稿料",
        "審査料",
        "キャンセル料",
        /* SPEC 第 337・348 */
        "渡航費",
        /* 第 715 回 – 利用者が実際に打つ形（文の見本 106 文の残りから）。その群の斷りがそのまま答へになる物だけを載せる。*/
        "渡航費が高い",
        /* SPEC 第 623 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "出場料",
        "旅費支援",
        "旅費補助",
        "補助",
        "補助金",
        "学生支援",
        "travel grant",
        /* SPEC 第 337・354 */
        "travel",
        "grant",
        /* SPEC 第 337・378 */
        "受講料",
        "学生料金",
        "登録料",
        "参加登録費",
        /* SPEC 第 337・382 */
        "掲載料",
        /* 第 669 回 – 料金の名を英語で打つ人（`page charge` – 実測 0 行・案内も無し – `掲載料` は通る）。*/
        "page charge",
        "出版費",
        "登録手数料",
        "参加手数料",
        "学割",
        /* SPEC 第 648 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "オーバースページ",
        "過剰ページ",
        "ページ超過",
        "超過ページ料",
        "ページ追加料",
        "1ページ追加",
        "非会員料金",
        "発表者負担",
        "謝礼",
        /* 第 650 回 – 同じ料を「費用」「料金」で掛く人（実測 0 行・案内も無し – `発表費` は通る）。*/
        "発表費用",
        "掲載費用",
        "投稿費用",
        "聴講料金",
        "早期割引料",
        "登録費用",
        "fee",
        /* SPEC 第 387 */
        "渡航支援",
        "トラベルグラント",
        "発表支援",
        "経費支援",
        "渡航費補助",
        "参加費支援",
        /* SPEC 第 337・348・516 */
        "交通費",
        "出張費",
        "宿泊費",
        "宿泊",
        "宿泊代",
        "ホテル代",
        "宿代",
        "会費",
        "年会費",
        "出展料",
        "展示料",
        "協賛金",
        "広告料",
        "聴講料",
        "聴講費",
        "受講費",
        "参加登録料",
        "招待券",
        "入場料",
        "チケット",
        "チケット代",
        "学生無料",
        "グラント",
        "lodging",
        "accommodation",
        "会場費",
        "懇親会費",
        "交流会費",
        /* SPEC 第 617・388・522 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "決済",
        "クレジット決済",
        "クレジットカード決済",
        "クレジットカード",
        "銀行振込",
        "前払い",
        "後払い",
        "現金払い",
        "支払方法",
        /* 払いの名目（`発表費はいりますか` `投稿費は` – 実測 0 行 – 第 620 回）。*/
        "発表費",
        "投稿費",
        "支払い方法",
        "割引",
        "会員割引",
        "オーサーフィー",
      ],
      /* SPEC 第 682・623 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      exactOnly: ["手数料", "いくら"],
      multiword: true,
      /* SPEC 第 505 */
      deadlineTail: true,
      echo: true,
      note: "はこの表が持っていません。収録するのは締切日・会議名・開催地・参加形式の印（『オンライン参加可』）・分野・等級だけで、費用の欄はありません。参加費は各会議の公式ページに書いてあります。",
      live: "は収録していません（費用の欄はありません。公式ページをご覧ください）",
    },
    {
      /* SPEC 第 337・525・526 */
      words: [
        "アクセシビリティ",
        "バリアフリー",
        "車椅子",
        "車いす",
        "くるまいす",
        "手話",
        "聴覚障害",
        "視覚障害",
        "食物アレルギー",
        "アレルギー",
        "ハラル",
        "字幕",
        "介助",
        "盲導犬",
        "多目的トイレ",
        "accessibility",
        "accessible",
        "wheelchair",
        "託児",
        /* SPEC 第 697 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "朝食",
        "夕食",
        "ベジタリアン",
        "ハラール",
        "祈祷室",
        "託児所",
        "キッズ",
        "同伴",
        "チャイルドケア",
        "childcare",
        "授乳室",
        "子連れ",
        "子供連れ",
        "子ども同伴",
        "介助者",
        "手話通訳",
        "バリアフリー対応",
        "障害者",
        "障がい者",
        "介護",
        "逐次通訳",
      ],
      multiword: true,
      echo: true,
      note: "はこの表が持っていません。収録するのは締切日・会議名・開催地・参加形式の印（『オンライン参加可』）・分野・等級だけで、会場のバリアフリー（車椅子・手話・字幕等）と、聞こえ方・見え方への配慮、食事の申し出（食物アレルギー・ハラル等）の欄はありません。出席のしやすさと配膳の申し出は各会議の公式ページに書いてあります。",
      live: "は収録していません（バリアフリーの欄はありません。公式ページをご覧ください）",
    },
    {
      /* 日付の欄の訪ね方。*/
      words: ["日付", "スケジュール"],
      multiword: true,
      echo: true,
      note: "はこの表の日付の欄の名前です。この表が出す日付は締切の日で、其々の種別（『論文締切』『概要締切』『登録締切』）か、幅の語（『今月』『来週』『明日』）で打つと絞れます。",
      live: "は締切の日付の欄です（種別か幅の語で絞れます）",
    },
    {
      /* SPEC 第 688・686 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      /* SPEC 第 698 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        "初日",
        "最終日",
        "中日",
        "2日目",
        "3日目",
        "全日程",
        "会期初日",
        "会期最終日",
        "開催予定",
      ],
      echo: true,
      note: "は行の『会期』に出ています（例: 『2026年12月1日(火)〜12月2日(水)』）。日付で絞る時は『12月1日』『2026年12月』のように打ってください。この表が持つ日付は締切と会期だけで、何日目かの区別は持ちません。",
      live: "は行の『会期』に出ています。日付で絞るには『12月1日』のように打ってください",
    },
    {
      /* SPEC 第 527・362 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        "知りたい",
        "教えて",
        "何か教えて",
        "詳細を教えて",
        "わかります",
        "分かる",
        "わかる",
        "どのくらい",
      ],
      /* SPEC 第 686・244・653 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      exactOnly: ["どこ", "どこで", "どこで開催"],
      multiword: true,
      echo: true,
      note: "だけでは、何を訪ねるか決まりません。この表は締切の日・会議名・開催地・参加形式を出しています（例: 『締切はいつ』『会議の日程』『会場はどこ』『採否はいつ分かる』）。",
      live: "だけでは訪ねる物が決まりません（例: 『締切はいつ』『会場はどこ』）",
    },
    {
      /* SPEC 第 383・385 */
      words: [
        "提出方法",
        "修正稿",
        "投稿システム",
        "投稿サイト",
        "投稿先",
        "提出先",
        "電子投稿",
        "オンライン提出",
        "フォーム",
        "paperback",
      ],
      multiword: true,
      deadlineTail: true,
      echo: true,
      note: "はこの表が持っていません。収録するのは締切日・締切の種別・会議名・開催地・参加形式の印（『オンライン参加可』）・分野・等級だけで、投稿先（EasyChair 等のシステム）の欄はありません。投稿先は各会議の公式ページに書いてあります。なお、自分の論文を貼って投稿先の候補を出す機能は この画面に在ります – 画面上部の『投稿先を探す』（『締切を検索』の隣）を押してください。",
      live: "は収録していません（投稿先の欄はありません・公式ページ）– 論文を貼る『投稿先を探す』が上に在ります",
    },
    {
      /* SPEC 第 696 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        "関連研究",
        "先行研究",
        "手法",
        "提案手法",
        "実験",
        "データセット",
        "結論",
        "序論",
        "本論",
        "まとめ",
        "展望",
        "サーベイ",
        "考察",
        "貢献",
        "研究背景",
        "動機",
        "アプローチ",
        "実装",
        "分析",

        "課題",

        "survey",
        "dataset",
        "conclusion",
        "introduction",
        "related work",
        "prior work",
        "future work",
        "background",
        "motivation",
        "figure",
        "table",
        "reference",
        "citation",
      ],
      echo: true,
      note: "は論文の中身の言葉で、この表が持つ欄の名前ではありません。この表が並べているのは催し物の名前・締切の日・分野・種別・開催地・参加形式・等級です。論文の題名や要旨を貼って投稿先の候補を出す機能は画面上部の『投稿先を探す』にあります（分野や主題の語でも引けます）。",
      live: "は論文の中身の言葉です。題名や要旨から探すには上の『投稿先を探す』へ",
    },

    {
      words: [
        "関連する会議",
        "自分の分野に近い会議",
        "おすすめの会議",
        "自分の論文に合う会議",
        "近い分野の会議",
      ],
      echo: true,
      note: "はこの表が持つ欄の名前ではありません。この表は催し物の名前・締切の日・分野・種別・開催地・参加形式・等級を並べた物で、会議どうしの近さや相性は持っていません。自分の論文に合う投稿先の候補は、画面上部の『投稿先を探す』に題名と要旨を貼ると出ます（分野や主題の語でも引けます）。",
      live: "は表の欄ではありません。論文を貼って候補を出す『投稿先を探す』が上に在ります",
    },
    {
      /* SPEC 第 337・387 */
      words: [
        "日本語",
        /* 第 671 回 – 言語で訊く人（`日本語` `英語のみ` は通る）。*/
        "英語で書く",
        "英語",
        "英語のみ",
        "日本語の会議",
        "日本語で発表",
        "日本語での発表",
        "日本語講演",
        "使用言語",
        "発表言語",
        "多言語",
      ],
      multiword: true,
      echo: true,
      deadlineTail: true,
      note: "はこの表が持っていません。収録するのは締切日・会議名・開催地・参加形式の印（『オンライン参加可』）・分野・等級だけで、発表に使う言語の欄はありません。使用言語は各会議の公式ページに書いてあります。",
      live: "は収録していません（発表に使う言語の欄はありません。公式ページをご覧ください）",
    },
    {
      /* SPEC §8（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        "プロセッサ",
        "半導体",
        "半導体設計",
        "集積回路",
        "VLSI",
        "チップ",
        "チップ設計",
        "回路設計",
      ],
      multiword: true,
      echo: true,
      deadlineTail: true,
      note: "では絞りません。この表が収録する催し物に其の語は現れません（半導体・チップその物の催し物を収録していません）。近い分野として通るのは『コンピュータアーキテクチャ』と『アーキテクチャ』です。",
      live: "では絞りません – 半導体自体の催し物は無いです。近いのは『コンピュータアーキテクチャ』",
    },
    {
      /* SPEC 第 337 */
      words: [
        /* SPEC 第 607 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "招へい状",
        "発行",
        "招待状",
        "招聘状",
        "ビザ",
        /* 手續きの名で打つ人。*/
        "ビザ申請",
        /* SPEC 第 690 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "ビザサポート",
        "招待状発行",
        /* SPEC 第 697 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "予防接種",
        "治安",
        "時差ボケ",
        /* 第 715 回 – 利用者が実際に打つ形（文の見本 106 文の残りから）。その群の斷りがそのまま答へになる物だけを載せる。*/
        "時差が少ない",
        "長期滞在が必要",
        "子供連れで参加",
        "治安が良い場所",
        /* SPEC 第 672・539 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "領事館",
        "就労ビザ",
        "招請",
        "若手",
        "若手研究者",
        "若手セッション",
        "若手ワークショップ",
        "ベストペーパー",
        "優秀論文",
        "賞",
        /* SPEC §8（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "論文賞",
        "学生ポスター賞",
        "口頭賞",
        "優秀論文賞",
        "最優秀論文賞",
        "最優秀賞",
        "デモ賞",
        "授賞式",
        "表彰",
        "受賞",
        "受賞講演",
        "学生ボランティア",
        /* SPEC 第 387 */
        "奨励賞",
        "学生奨励賞",
        "ベストペーパー賞",
        "最優秀発表賞",
        "査証",
        "パスポート",
        "在外参加",
        /* 賞の名– `授賞` `優秀賞` `若手優秀賞` は 0 行・無言（`賞` 単体と `受賞` は通う）。*/
        "授賞",
        "優秀賞",
        "若手優秀賞",

        "時差",
      ],
      multiword: true,
      echo: true,
      deadlineTail: true,
      note: "はこの表が持っていません。収録するのは締切日・会議名・開催地・参加形式の印（『オンライン参加可』）・分野・等級だけで、其れらを書く欄はありません。各会議の公式ページに書いてあるので、行の詳細に出る公式ページからご覧ください。",
      live: "は収録していません（其れらを書く欄はありません。行の詳細に出る公式ページをご覧ください）",
    },
    {
      /* SPEC 第 358・361 */
      /* 集まりの別の名。*/
      words: [
        "大会",
        "全国大会",
        "年会",
        "例会",
        "セミナー",
        "講演会",
        "講習会",
        "集会",
        "研究集会",
        /* 集まりの別の名。*/
        "アイデアソン",
        "コンテスト",
      ],
      multiword: true,
      echo: true,
      deadlineTail: true,
      note: "では絞りません。この表が収録する催し物に其の語は現れません（其の呼び方の催し物を収録していません）。近い呼び方として通るのは『研究会』『ワークショップ』『学会』『シンポジウム』です。",
      live: "では絞りません – 其の呼び方の催し物は収録に無いです。近いのは『研究会』『ワークショップ』",
    },
    {
      /* SPEC 第 361 */
      words: ["人工知能学会", "情報処理推進機構"],
      multiword: true,
      echo: true,
      deadlineTail: true,
      note: "では絞りません。この表が収録する催し物に其の語は現れません（其の学協会・機関の催し物を収録していません）。近い道は分野で絞る事で、通るのは『人工知能』と『セキュリティ』です。",
      live: "では絞りません – 其の学協会の催し物は無いです。『人工知能』『セキュリティ』の分野で",
    },
    {
      /* SPEC 第 358・362 */
      words: ["小規模", "小規模会議", "小規模な会議", "小規模ワークショップ", "アットホームな会議"],
      multiword: true,
      echo: true,
      deadlineTail: true,
      note: "はこの表が持っていません（催し物の規模の印を収録していません）。近い道は主題タグ『穴場』で絞る事で、其の方の語は通ります。",
      live: "は持っていません – 規模の印は無いです。近いのは主題タグ『穴場』です",
    },
    {
      /* SPEC 第 319・362 */
      words: [
        "締切が迫っている",
        "締切が迫る",
        "最近締切",
        "締切が近い会議",
        "締切が近づいている",

        "締切間近",
        "締切目前",
        "締切が近い",
        "近い締切",
        "間近の締切",
        /* SPEC 第 681 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "早い",
        "速い",
        "遅い",
        "遠い",
        /* SPEC 第 681 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "一番早い",
        "最も早い",
        "一番近い",
        "最も近い",
        "一番遅い",
        "最も遅い",
        "一番遠い",
        /* SPEC 第 348・382 */
        "締切間もなく",
        "間もなく締切",
        "締切直前",
        "直前の締切",
        "締切が間近い",
        "今にも締切",
        "締切間近な会議",
        "締切目前の会議",
      ],
      /* SPEC 第 505・683・682 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      exactOnly: ["日数", "締切までの日数", "残り日数", "最新", "最新の締切", "新しい締切"],
      multiword: true,
      echo: true,
      deadlineTail: true,
      note: "では絞りません。この表は『近い』『早い』の幅や順を勝手に決めません（締切の推測をしない決まり）。画面の既定の並びは締切が近い順（残り日数の昇順）なので上から順が近く、日数で絞る時は『締切まで 7 日以内』のボタンが在って其れが近い行を出しますし、検索の語では『今週』『来週』『明日締切』が通ります。",
      live: "では絞れません – 近いの幅は決まりません。『締切まで 7 日以内』のボタンか『今週』『来週』で",
    },
    {
      /* SPEC §8（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      /* SPEC 第 506 */
      words: [
        "締切が延びた",
        "締切が伸びた",
        "締切の延長",
        "申込締切が延びた",
        "確定",
        "延長した締切",
        "未確定の締切",
        "確定していない締切",
        "確定済みの締切",
        /* SPEC 第 643 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "締切変更",
        "日程変更",
        "元々の締切",
        "本来の締切",
        "延長前",
      ],
      multiword: true,
      echo: true,
      deadlineTail: true,
      note: "では絞れません。この表は締切の延伸や確定の印を持っていません（収録するのは公式ページに書かれた締切日だけで、日付を推測しない決まりです）。延伸について書いた行は『締切延長』で、日付が定まっていない旨を書いた行は『未定』で出ます。",
      live: "では絞れません – 延伸や確定の印は無いです。『締切延長』『未定』で絞ってください",
    },
    {
      /* SPEC 第 319・357 */
      words: [
        "メジャー",
        "メジャー会議",
        "主要",
        "主要会議",
        "主要な会議",
        "主要学会",
        "トップ会議",
        "トップクラス",
        "トップジャーナル",
        "有力",
        "有力会議",
        "ハイクラス",
        "一流",
        "一流会議",
        /* SPEC 第 509 */
        "上位",
        "上位の会議",
        "上位会議",
        "格付け",
        "レベル",
        "グレード",
        "ランク付け",
        "ランキング",
        "ランキング順",
        "有名な会議",
        /* SPEC 第 686 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "トップカンファレンス",
        "難関",
        "有名",
        "権威",
      ],
      multiword: true,
      echo: true,
      deadlineTail: true,
      note: "では絞れません。この表は催し物の評価を行の『ランク』（A*・A・B・C）で持っていて、其れが絞りになります。上の『ランク』の選択欄か『A*ランク』のクイック抽出のボタンで絞れますし、検索欄に『A*』や『A』と打つ形でも絞れます。",
      live: "では絞れません – 評価は『ランク』の選択欄か『A*ランク』のクイック抽出で絞って下さい",
    },
    {
      /* SPEC 第 356 */
      words: ["月前半", "月前半締切", "月前半の締切", "前半の月"],
      multiword: true,
      echo: true,
      deadlineTail: true,
      note: "では絞れません。月の前半が何日までを指すか（上旬の 10 日まで・半分までの 15 日）には公用の決まりが無いので、画面は勝手に絞りません。初めの 10 日を打つ（『上旬』）、中旬を打つ（『中旬』）、其の日を打つ（『1日』『5日』）が出来ます。",
      live: "では絞れません – 月前半の決まりは無いので、『上旬』『中旬』・其の日（『1日』）で絞ってください",
    },
    {
      /* SPEC 第 349・353・355 */
      words: [
        "月初",
        /* SPEC 第 503 */
        /* SPEC 第 390 */
        "月の初め",
        "月の頭",
        "月初の頃",
        "月初め",
        "月頭",
        "今月頭",
        "来月頭",
        "再来月頭",
        "月中",
        "月初締切",
        "来月頭締切",
        /* SPEC 第 344 */
        "月初頃",
        "月初め頃",
        "月頭頃",
      ],
      anyTail: true,
      multiword: true,
      echo: true,
      /* SPEC 第 344 */
      note: "では絞れません。月の初めという言い方は、何日を指すか（1日・最初の週・初めの 10 日）に公用の決まりが無いので、画面は勝手に絞りません。其の日を打つ（『1日』『5日』）、初めの 10 日を打つ（『上旬』）、其の月をまとめて打つ（『9月』）・来月を打つ（『来月』）が出来ます。",
      live: "では絞れません – 月初の決まりは無いので、日（『1日』）・『上旬』・其の月（『9月』）で絞ってください",
    },
    {
      /* SPEC 第 355 */
      words: ["週明け", "来週明け", "今週明け", "週明け締切"],
      anyTail: true,
      multiword: true,
      echo: true,
      note: "では絞れません。週の明けという言い方は、月曜日を指す人もあれば週の初めの日々を指す人もいるので、寄せられません。曜日（『月曜』『金曜』）や『今週』『来週』で絞ってください。",
      live: "では絞れません – 週明けの意味は一通に決まらないので、曜日（『月曜』）・『今週』『来週』で絞ってください",
    },
    {
      /* SPEC 第 352・355 */
      words: [
        "上半期",
        "下半期",
        "上期",
        "下期",
        "半期",
        "期初",
        "期末",
        "四半期",
        "第1四半期",
        "第2四半期",
        "第3四半期",
        "第4四半期",
        "上半期締切",
        "四半期締切",
        /* SPEC 第 337・352・503 */
        "前期",
        "後期",
      ],
      anyTail: true,
      multiword: true,
      echo: true,
      note: "という区分はこの表が持っていません。締切は暦月で出てくるので、其の期に当たる月を夫々打ってください（月の語は空格で並べると両方を含む行だけになるので、夫々打つ方が多く出ます）。年度の初め・終わりは『年度初め』（4月の締切）・『年度末』（3月の締切）で引けます。",
      live: "という区分はありません – 締切は暦月で出るので、其の期の月を打ってください",
    },
    {
      /* SPEC 第 337・352・353 */
      words: [
        "祝日",
        "祝日締切",
        "休日",
        "休日締切",
        "振替休日",
        "国民の休日",
        "連休",
        "大型連休",
        "お盆",
        "盆休み",
        "夏休み",
        "冬休み",
        "春休み",
        "ゴールデンウィーク",
        "GW",
        "年末年始",
        /* SPEC 第 337・352 */
        "祝日の締切",
        "休日の締切",
        "お盆の締切",
        "GWの締切",
        "年末年始の締切",
        /* SPEC 第 337・378 */
        "祝祭日",
        "三連休",
        "土日祝",
        "休暇",
        "祝祭日の締切",
        "三連休の締切",
        /* SPEC 第 434 */
        "シルバーウィーク",
        "代替休日",
      ],
      multiword: true,
      /* SPEC 第 248・352・504 */
      anyTail: true,
      echo: true,
      note: "では絞れません。この表は祝日・休日（振替休日・お盆・年末年始など）の情報を収録しておらず、締切日が休みと重なるかどうかも分かりません。代わりに曜日（『土日』『平日』）や日付（『9月22日』・`2026-09-22`）で絞ってください。『年末年始』は 12月と1月にまたがる言い方なので、『年末』（12月の締切）・『年始』（1月の締切）で夫々引けます。",
      live: "では絞れません – 祝日・休日は収録していません。曜日は『土日』『平日』、日付でも引けます",
    },
    {
      /* SPEC 第 648・511・337 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        "同じ日",
        "同日",
        "同じ週",
        "同じ月",
        "同時期",
        "同じ時期",
        "重なる",

        "締切が同じ会議",
        "同じ締切の会議",
        "締切が同じ",
        "重なります",
        "重複",
        "被る",
        "競合",
        "衝突",
        "比較",
        "二つを比べる",
        "並べて比べる",
      ],
      multiword: true,
      /* SPEC 第 354・504・337 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      anyTail: true,
      echo: true,
      note: "の数へ方はこの表に出来ません。表は締切ごとに一行で、日をまたいで同じ日に幾つ締切が来るかを示す欄がありません。同じ日に複数の締切が来ることは普通にありますが、まとめて数えることはできません。代わりに範囲（『今週』『来月』『9月』）や日付（『9月22日』）を打つと、その範囲の締切が日の順に並びます – 同じ日に重なった行は並びの中で隣り合います。二つの会を並べて比べることもできません。両方の名前を同じ範囲で打つと、その両方の行が出ます。",
      live: "では数へられません – 範囲や日付を打つと締切が日の順に並びます",
    },
    {
      /* SPEC 第 649・230・337 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        "分野の一覧",
        "どんな分野",
        "どんな分野を",
        "分野は幾つ",
        "分野を並べる",
        "分野の数",
        "カテゴリの一覧",
        "分野の種別",
        "どんな分野を扱う",
        "どんな分野を扱って",
        "分野はどこ",
      ],
      multiword: true,
      /* SPEC 第 337・504 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      anyTail: true,
      echo: true,
      note: "は画面の上の『分野』のチップに出しています。収録している分野は九種で、チップには日本語の名前と英字の正式名を並べ、件数も添えてあります（件数は他の絞り込みを通した後の数です）。押すとその分野だけの一覧になります。一つの内容に複数の分野が付く行もあります。どんな会議を収録しているかの詳しい話はページ下の『見方のてびき』に書いてあります。検索欄では絞り込めません。",
      live: "は画面の上の『分野』のチップに出します – 九種あり、日本語名と件数を添えてあります",
    },
    {
      /* SPEC 第 337・378 */
      words: [
        "共催申請",
        "後援申請",
        "協賛申請",

        "共催",
        "後援",
        "協賛",
        "共催者",
        "スポンサー",
        "sponsor",
        "協賛企業",
        "共催の締切",
        "後援の締切",
      ],
      multiword: true,
      echo: true,
      deadlineTail: true,
      note: "はこの表が持っていません。収録するのは締切日・会議名・開催地・参加形式の印（『オンライン参加可』）・分野・等級だけで、主催・共催・後援・協賛の区別と協賛企業の情報を打つ欄がありません。主催者は行の詳細に出る公式ページに書かれています。名前の断片（『SC』『SIGCOMM』等）や分野（『セキュリティ』『人工知能』）で絞る道が有ります。",
      live: "は持っていません – 主催・共催・後援・協賛の区別は無いです。名前の断片や分野で絞ってください",
    },
    {
      /* SPEC 第 337・378 */
      words: [
        /* SPEC 第 388・512 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "査読者",
        "レビュアー",
        /* 審査の段取りの名。*/
        "査読プロセス",
        "再査読",
        "審査基準",
        "採点項目",

        "レビューコメント",
        "評価基準",
        "ルーブリック",

        "ピアレビュー",
        "査読付き",
        /* SPEC 第 689 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "査読あり",
        "査読付き論文",
        "査読なし",
        "匿名化",
        "二重盲検",
        "ダブルブラインド",
        "ブラインド審査",
        /* まぎらはしい言い方（`リビューの返事はいつですか` – 実測 0 行 – 第 620 回）。*/
        "リビュー",
        "査読方式",
        "査読の方式",
        "審査方式",
        "レビュー方式",
        /* SPEC 第 648 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "匿名査読",
        /* 第 671 回 – 審査の方式を別の名で。*/
        "名乗り査読",
        "レビュー形式",
        "reciprocal reviewing",
        "二段階審査",
        "外部査読者",
        "プログラム委員",
        "PC委員",
        "評価項目",
        "採点基準",
        /* SPEC 第 337・381 */
        "レフリー",
        "ピアレビュー期間",
        /* SPEC 第 616・388・337 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "シングルブラインド",
        "トリプルブラインド",
        "ブラインド",
        "ブラインド査読",
        "公開レビュー",
        "オープンレビュー",
        "クローズドレビュー",
        "非公開レビュー",
        "レビューの公開",
        "実名審査",
        "記名審査",
      ],
      multiword: true,
      deadlineTail: true,
      echo: true,
      note: "の区別はこの表が持っていません。審査の方式（盲検の形・査読者数）を書く欄がなく、収録するのは締切日・会議名・開催地・参加形式の印・分野・等級だけです。但し審査の段階の日は持っているので、『査読』（実測 13 行）・『採択』（実測 129 行）のような締切の語で絞れます。",
      live: "の区別は収録していません – 審査の方式を書く欄は無いです。締切の語（『査読』『採択』）で絞れます",
    },
    {
      /* SPEC §8（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      /* SPEC 第 391 */
      words: [
        /* SPEC 第 505・610 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "招待",
        "招待講演",
        "一般講演",
        "基調講演",
        "キーノート",
        "招待発表",
        "ジャーナルペーパー",
        "発表形式",
        "口頭",
        "口頭発表",
        "パネル討論",
        "招待セッション",
        "一般発表",
        "短文",
        "レター",
        "論文特集提案",
        /* SPEC 第 644 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "発表形態",
        "特別発表",
        "学生論文",
        "デモ提出",
        /* SPEC 第 669 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "keynote",
        "invited talk",
        "plenary",
        "プレナリー",
        "oral presentation",
        "poster session",
        "tutorial session",
      ],
      multiword: true,
      echo: true,
      deadlineTail: true,
      note: "の区別はこの表が持っていません。催し物の名前（『ワークショップ』『セッション』『チュートリアル』など）は行の原文に出るので検索で当たりますが、招待・一般という区別は収録していません。",
      live: "の区別は収録していません（催し物の名前でなら当たります）",
    },
    {
      /* SPEC 第 689・686 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        "サーベイ論文",
        "レビュー論文",
        "招待論文",
        "研究論文",
        "学術論文",
        "総説",
        "総説論文",
        /* 種類の別の名。*/
        "チュートリアル論文",
        "ポスター論文",
        /* 種類を擴張子で打つ人。*/
        "ポスターPDF",
      ],
      echo: true,
      note: "は論文の種類の名前で、この表は種類の区別を持ちません。収録するのは締切の日と種別・会議名・開催地・参加形式の印（『オンライン参加可』）・分野・等級だけです。種類ごとに募集があるかは各催し物の公式ページに書かれています。",
      live: "はこの表が持たない論文の種類の区別です。公式ページをご覧ください",
    },
    {
      /* SPEC 第 388 */
      words: [
        "審査期間は何日",
        "査読はいつからいつまで",
        "投稿はいつからいつまで",

        "査読期間",
        "査読の時期",
        "審査期間",
        "審査の時期",
        "レビュー期間",
        "リビュー期間",
        "査読中",
        /* SPEC 第 519 */
        "リビュースケジュール",
        "rebuttal期間",
        "再投稿期間",
        "再提出期間",
        "改訂期間",
        "結果が分かる日",
        "結果がわかる日",
        "採否の時期",
      ],
      multiword: true,
      echo: true,
      deadlineTail: true,
      note: "はこの表が持っていません。審査をいつからいつまでやるかという期間の欄はなく、収録するのは締切日・締切の種別・会議名・開催地・参加形式の印・分野・等級だけです。但し審査の段階の締切は持って居ますので、『査読』（実測 13 行）・『反論期間開始』（同 8 行）・『採択通知』（同 129 行）で絞れます。",
      live: "は収録していません（審査の期間の欄はありません。締切の語『査読』『採択通知』で絞れます）",
    },
    {
      /* SPEC 第 388 */
      words: [
        "連絡著者",
        "corresponding",

        "筆頭著者",
        "所属",
        "第一著者",
        "共著者",
        /* 第 717 回 – 文の見本の残り（実測 2026-10-06: `共著者と相談` は 0 行・案内も無し）。*/
        "共著者と相談",
        "共著",
        "著者",
        "筆頭",
        "発表者",
        "登壇",
        "座長",
        "討論者",
        "パネリスト",
        "オーガナイザ",
        "司会",
        /* 役の長い言い方（`コレスポンディングオーサー` – 実測 0 行。第 620 回）。*/
        "コレスポンディングオーサー",
        "コレスポンディング",
        "演者",
        /* 第 645 回 – 連名で出す話を shorten して打つ人（実測 0 件・案内も無し）。*/
        "連名",
        /* SPEC 第 669 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "ゲストエディタ",
        "領域エディタ",
        "編集長",
        "査読者割り当て",
        "guest editor",
        "area editor",
        "session chair",
        "program chair",
        "general chair",
        "proceedings chair",
        "editor in chief",
        "reviewer assignment",
        "PC member",
      ],
      multiword: true,
      deadlineTail: true,
      echo: true,
      note: "はこの表が持っていません。著者や発表者の役（筆頭・共著・座長・討論者など）を書く欄がなく、収録するのは締切日・締切の種別・会議名・開催地・参加形式の印・分野・等級だけです。催し物の名前（『ワークショップ』『チュートリアル』『セッション』）は行の原文に出るので検索で当たります。",
      live: "は収録していません（役の欄はありません。催し物の名前でなら当たります）",
    },
    {
      /* SPEC §8（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: ["未確定", "仮締切", "暫定", "暫定締切", "確定締切", "本締切"],
      multiword: true,
      deadlineTail: true,
      echo: true,
      note: "という扱いはこの表にありません。載せるのは各会議が公式に出した日付だけで、仮の締切という印は持ちません。後から動いた締切は行に『延長』と出ます（実測で 21 行）。",
      live: "という扱いはありません – 公式に出た日付だけを書き、動いた締切は『延長』で分かります",
    },
    {
      /* SPEC §8（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: ["和暦", "令和", "平成", "明治", "大正", "昭和"],
      echo: true,
      deadlineTail: true,
      /* 注は初出に置く。*/
      multiword: true,
      note: "の日付はこの表に書いていません。締切は西暦で出します（例: 2026年8月22日）。「締切まで」の欄は今日からの日数です。",
      live: "の日付はありません – 締切は西暦（例 2026年8月22日）で出します",
    },
    /* SPEC 第 325 */
    {
      words: [
        "更新",
        "更新日時",
        "最終更新",
        "更新頻度",
        "最新版",
        "鮮度",
        "新しさ",
        "データの鮮度",
        "生成",
        "生成時刻",
        "データ生成",
        "いつ更新",
        "データ更新",
        "変更履歴",
        "最近更新",
        "更新時期",
        "更新された",
        "古いですか",
        "いつのもの",
      ],
      echo: true,
      deadlineTail: true,
      note: "のことなら、画面の右上に『データ生成』として、いま見ているデータがいつ作られたかを出しています（JST と曜日で、一覧と同じ単位）。更新は日次の運用で、生成から日数が経っているときは同じ場所に注意書きが出ます。日ごとの変更の一覧はこの画面に置いていません – 収録の範囲や更新の運用はページ下の『見方のてびき』の『データ更新』に書いてあります。検索では絞り込めません。",
      /* SPEC 第 631・636 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      live: "のことなら、生成時刻は右上の『データ生成』、運用は『見方のてびき』に書いています。検索では絞り込めません",
    },
    {
      words: [
        "データの出典",
        "データ源",
        "元のデータ",
        "データ元",
        "信頼性",
        "正確性",
        "正確",
        "誤り",
        "間違い",
        "根拠",
        "健全性",
      ],
      echo: true,
      deadlineTail: true,
      note: "のことなら、画面の下に『データ源』を出しています – 収録がどの配布物に基づいているかを並べ、名前のリンクから一次資料に飛べます。上流に無い物をこちらで入力した分もそこに書きます。裏取りを人の読める形にした報告（収録の件数・締切の確定状態の内訳・分野の内訳）も同じ場所に有ります – 中身はページ下の『見方のてびき』の『データの健全性（health.md）』に書いてあります。検索では絞り込めません。",
      live: "のことなら、収録の出所は画面下の『データ源』に書いています – 検索では絞り込めません",
    },
    {
      words: [
        "収録期間",
        "収録範囲",
        "収録の範囲",
        "収録対象",
        "収録の期間",
        "全件数",
        "何件",
        "件数",
        "どこまで収録",
        /* SPEC 第 649・648 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "何を収録",
        "何を収録してる",
        "何を収録している",
        /* 第 645 回 – 収録の幅を英語交じり・別の和語で打つ人（実測 0 件・案内も無し）。*/
        "カバレッジ",
        "カバー範囲",
        "網羅",
        "収録内容",
        "対象分野",
      ],
      echo: true,
      deadlineTail: true,
      note: "のことなら、いま出ている件数は一覧の上の件数欄に、収録している物の範囲はページ下の『見方のてびき』の『データ源』と『国内研究会・国内シンポジウム』の項に書いています。表の行の数は、この画面では絞り込みで動いた分として出るだけです。",
      live: "のことなら、件数は一覧の上の件数欄、範囲は『見方のてびき』 – 検索では絞り込めません",
    },
    {
      words: [
        "印刷",
        "印刷する",
        "プリント",
        "pdf",
        "共有",
        "共有する",
        "リンク",
        "リンクをコピー",
        "コピー",
        /* SPEC 第 649 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "表をコピー",
        "一覧をコピー",
        "行をコピー",
        "印刷した版",
        "紙で出す",
        "共有リンク",
        "画面共有",
        "画面共有する",
      ],
      echo: true,
      deadlineTail: true,
      note: "のことなら、印刷はブラウザの印刷（Ctrl + P など）で、いま絞り込んだ一覧の全行が出ます（画面は行を区切って描くので、印刷物だけ途中までにならないためです）。紙の上には条件の書き下ろし・表示件数・印刷した日時・データの生成日時も残ります。共有はブラウザのアドレスバーの URL をコピーすると、相手にも同じ条件・同じ並びの一覧が出ます。両方ともページ下の『見方のてびき』に書いてあります。検索では絞り込めません。",
      live: "のことなら、ブラウザの印刷で絞り込んだ一覧の全行が出ます – 共有は URL コピー、話は『見方のてびき』",
    },
    {
      /* SPEC 第 326 */
      words: [
        "条件クリア",
        "条件を消す",
        "条件を戻す",
        "条件を解除",
        "条件を外す",
        "絞り込みを消す",
        "絞り込み解除",
        "絞り込みを外す",
        "検索条件を消す",
        "リセット",
        "リセットする",
        "元に戻す",
        "戻す",
        "クリア",
        "解除",
        "全部外す",
        "非表示",
        "表示されない",
        "表示されん",
      ],
      echo: true,
      deadlineTail: true,
      note: "のことなら、絞り込みの欄の右に『条件クリア』のボタンが有ります – 押すと、検索欄に打った語・締切まで・分野・種別・参加形式・ランク・過去の締切が一度に戻ります。名前の通り条件だけで、論文のタイトル・概要・参考論文の欄は消しません（論文の欄を消すのは推薦の欄にある『論文の入力を消す』で、消した直後は『直前の入力に戻す』が同じ欄に出ます）。",
      /* SPEC 第 631 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      live: "のことなら、絞り込みの欄の右の『条件クリア』で、検索欄の語も含めた条件が一度に戻ります",
    },
    {
      /* SPEC 第 323 */
      words: ["ics", "ical"],
      echo: true,
      always: true,
      deadlineTail: true,
      note: "のことなら、二つの物があり得ます – 表がその語で書いている行と、会議名の中に語の途中として含まれる行が混じります（表の語として当たっているわけではありません）。会議名をお探しならそのまま引けます。カレンダーに入れるファイルをお探しなら、一覧の下の『カレンダーに追加（.ics）』か『購読 URL をコピー』を使ってください（.ics は収録全体で、画面の絞り込みは引き継がれません）",
      live: "のことなら、会議名など語の途中で当たった行が混じります – ファイルは『カレンダーに追加（.ics）』で",
    },
    {
      /* SPEC 第 321 */
      words: [
        "書き出し",
        "エクスポート",
        "ダウンロード",
        "保存",
        "csv",
        "表計算",
        "スプレッドシート",
        "予定表",
        /* SPEC 第 649 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "カレンダーに落す",
        "カレンダーに落とす",
        "カレンダーに取り込む",
        "カレンダー",
        "カレンダーに追加",
        /* 配る先を名乗り續ける打ち方。 */
        "Googleカレンダー",
        "購読",
        "サブスクライブ",
        /* SPEC 第 618・337・366 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "json",
        "生データ",
        "機械可読",
        /* SPEC 第 649・337・364 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "元データ",
        "生のデータ",
        "生ファイル",
        "カレンダー購読",
        "フィード購読",
        "機械向け",
        "表計算に貼る",
        "取り込み",
        "フィード",
        /* SPEC 第 641・337 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "エクセル",
        "Outlook",
        "XML",
        "atom",
      ],
      echo: true,
      deadlineTail: true,
      note: "のことなら、検索欄では絞り込めません（表にそのようには書いていないので当たりません）。持ち出しと購読は一覧の下の操作で出します – 『カレンダーに追加（.ics）』で今後の締切を自分のカレンダーに、『この一覧の N 件を CSV でダウンロード』で絞り込み後の全行を表計算に、『購読 URL をコピー』でアプリに打ち込む URL が出ます。なお .ics は収録全体を購読する形で、画面の絞り込みは引き継がれません。『投稿先を探す』の候補も同じ場所から書き出せます（『この候補 N 件を CSV でダウンロード』と『この候補 N 件をカレンダー（.ics）でダウンロード』。候補の CSV は先頭に一致評価・一致の点・言葉の一致・意味の近さの 4 列が付きます）。JSON をお探しなら、一覧の下の『全データ（JSON）』がこのサイトの同じ場所の data.json へのリンクです（機械が読む用の正で、画面の一覧に使う catalog.json より広く、過去の締切とそれより先の締切まで載ります。表計算に貼るだけなら CSV のほうが小さく、絞り込みを保ったまま出せます）",
      live: "のことなら、.ics や CSV で出せます – .ics は収録全体で絞り込みは引き継がれません",
      /* SPEC 第 392 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
    },
    {
      /* SPEC 第 239・320 */
      words: [
        "過去の締切",
        "過ぎた締切",
        "終わった締切",
        "終了した締切",
        "過去のもの",
        "過去の分",
        "過去分",
        "過去の一覧",
        "過去の締切を見る",
        "過ぎた締切を見る",
        "過去を表示",
        /* SPEC 第 511・512 */
        "過去",
        "履歴",
        /* SPEC 第 698 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "前回",
        /* SPEC 第 239・365・384 */
        "去年",
        "昨年",
        "昨年度",
        "去年の会議",
        "過去の会",
        "過去の会議",
        "終了した",
        "終了した会",
        /* SPEC 第 320・365 */
        "とっくに過ぎた締切",
        "過ぎた締切の",
        "終了した会議",
        "終了済み",
        "採録済み",
        "もう終わる",
        "終わった会議",
        "とっくに過ぎた",
        "とっくに過ぎてる",
        "とっくに終わった",

        "締切を過ぎた",
        /* 第 715 回 – 利用者が実際に打つ形（文の見本 106 文の残りから）。その群の斷りがそのまま答へになる物だけを載せる。*/
        "締切を忘れた",
        "締切を逃した",
        "締切に気づかなかった",
        "締切が過ぎた",
        "締切に遅れた",
        "申込を忘れた",
        "登録を忘れた",
        "応募を忘れた",
        "出し忘れた",
        "間に合わなかった",
      ],
      echo: true,
      deadlineTail: true,
      note: "のことなら、検索欄では絞り込めません（表にそのようには書いていないので当たりません）。過ぎた締切は既定で一覧から除いています – 上にある『過去の締切も表示』をオンにすると出て、品書に載っていない行は追加で読み込みます。トグルをオンにしたうえでこの語を打つとやはり当たらないので、出し分けはトグルだけでお願いします",
      live: "のことなら、上にある『過去の締切も表示』をオンにしてください（この語では絞れません）",
    },
    {
      /* SPEC 第 320・365・374・390 */
      words: [
        "以前",
        /* SPEC 第 390・397・447 */
        "以前の",
        "より前",
        "よりまえ",
        "よりも前",
        "より以前",
        "以前から",
        "より前に",
      ],
      echo: true,
      multiword: true,
      deadlineTail: true,
      note: "という其れより前の幅では絞り込めません（上流は過ぎた締切を載せず、此処でも既定で除いている為です）。其れより前を並べたいなら、上にある『過去の締切も表示』をオンにしてください。其の期間の締切を見たいなら、其の日付の幅をそのまま打てます（例: 『1月から7月』）。その月だけを見る事も出来ます（例: 『1月』）",
      live: "という其れより前の幅では絞りません – 過ぎた締切を除く為、『1月から7月』の幅か『過去の締切も表示』で",
    },
    {
      /* SPEC 第 447 */
      /* SPEC 第 361・397 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: ["以降", "以後", "この先", "以来"],
      echo: true,
      multiword: true,
      note: "だけでは其の起点が何か決まらないので検索欄では絞り込めません。特定の日時より後なら其の方と繋げて打ってください（『8月22日以降』『17時以降』）。日の語（『明日』『来月』）も繋げた形で打ち直してください",
      live: "だけでは其の起点が決まらないので絞りません（『8月22日以降』『明日以降』のやうに繋げて打ってください）",
    },
    {
      /* SPEC 第 645 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        "出典",
        "一次情報",
        "データ源",
        "情報源",
        "ソース",
        "提供元",
        "出所",
        /* SPEC 第 649 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "どこから取った",
        "どこからとった",
        "どこから来た",
        "どのサイトの話",
        "誰が管理",
        "誰が管理している",
        "誰が管理してる",
        "誰が作っている",
        "データの出所",
        "出所の確認",
        "裏取り",
        "出自",
        "何処から取った",
        "一次資料",
      ],
      echo: true,
      deadlineTail: true,
      note: "はページ下の『データ源』に出します。名前はリンクで、その配布物のページ（一次資料）に飛べます。くわしくは『見方のてびき』に書いてあります。",
      live: "はページ下の『データ源』に出します（リンクから一次資料に飛べます）",
    },
    {
      /* SPEC 第 628 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        "参考論文",
        "掲載先",
        "投稿予定",
        "投稿予定タイトル",
        "投稿予定概要",
        "投稿予定キーワード",
        "投稿予定論文",
        "論文の入力",
        "論文入力",
      ],
      echo: true,
      deadlineTail: true,
      note: "は論文を貼る欄の項目の事で、検索欄の語ではありません – 画面上部の『投稿先を探す』（『締切を検索』の隣）を押すと『論文の入力』が出て、『投稿予定タイトル』『投稿予定概要』『投稿予定キーワード』『参考論文』（1 行 1 件: タイトル | キーワード | 掲載先）が入れらます。選んだファイルは送信しません（文字の読み取りはこの端末の中だけで行います）。",
      live: "は論文を貼る欄の項目です – 上の『投稿先を探す』を押すと『論文の入力』が出ます",
    },
    {
      words: ["カテゴリ", "カテゴリー", "ラベル", "フィールド"],
      // 打たれた語を書き返さない組（この画面で使わない語なので）。
      echo: false,
      deadlineTail: true,
      /* 注は初出に置く。*/
      multiword: true,
      note: "欄の名前の言い方ですが、この画面にその名前の欄はありません。上の『分野』『種別』『参加形式』で選ぶか、値で検索してください（例: 「セキュリティ」「論文締切」「オンライン参加可」）。",
      live: "欄の名前では絞れません。上の『分野』『種別』で選ぶか、値で検索してください",
    },
    {
      /* SPEC 第 337・354・516 */
      words: [
        "インパクトファクター",
        "影響度",
        "引用数",
        "被引用数",
        /* 引用の数の別の名。*/
        "h-index",

        "採録",

        "不採択",
        "落選",
        /* 採否の知らせの名。*/
        "不採録通知",
        /* SPEC 第 688 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "不採録",
        "条件付き採録",
        /* 採否の言ひ方の続き。*/
        "条件付き採択",

        "採択率",
        "採点",
        "採択数",
        "採択本数",
        "採択傾向",
        "通過率",
        "競争率",
        "倍率",
        "投稿数",
        "投稿本数",
        "応募数",
        "応募者数",
        "審査員",
        "審査員数",
        "査読者数",
        "レビュアー数",
        "定員",
        "募集枠",
        "枠数",
        "収容人数",
        "参加者数",
        "参加登録者数",
        "人数",
        "acceptance rate",
        "スコア",
        /* SPEC 第 620 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "採択された",
        "採否の判定",
        /* 落ちた側の言い方。合否の日は持つが結果は持たん羣。*/
        "却下",
        "落ちた",
      ],
      multiword: true,
      /* SPEC 第 656・505・362・503 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      statTail: true,
      /* SPEC 第 505・513 */
      deadlineTail: true,
      echo: true,
      note: "はこの表が持っていません。収録するのは締切日・締切の種別・会議名・開催地・参加形式の印（『オンライン参加可』）・分野・等級だけで、採択率・投稿数・審査員数・定員・募集枠のような数の統計を書く欄はありません。但し採否の結果が分かる日は持っているので、『採択通知』（実測 129 行）・『査読』（同 13 行）のような締切の語で絞れます。",
      live: "は収録していません（採択率などの統計の欄はありません。公式ページをご覧ください）",
    },
    {
      /* SPEC 第 512・516 */
      words: [
        /* SPEC 第 388 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "発表準備",
        "オンデマンド",
        "閲覧期限",

        "録画",
        "録画公開",
        /* SPEC 第 670 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "zoom",
        "ズーム",
        "見逃し",
        "何分",
        "後日アーカイブ",
        "アーカイブ",
        "archive",
        "発表資料",
        "スライド",
        "発表時間",
        "持ち時間",
        "質疑",
        "質疑応答",
        "通訳",
        "同時通訳",
        "翻訳",
        "当日配布",
        "当日",
        "後日",
        "プログラム",
        "タイムテーブル",
        "進行表",
        "演目",
        "夕食会",
        "宴会",
        "ケータリング",
      ],
      multiword: true,
      deadlineTail: true,
      echo: true,
      note: "はこの表が持っていません。収録するのは締切日・締切の種別・会議名・開催地・参加形式の印（『オンライン参加可』）・分野・等級だけで、演目・録画・発表時間・通訳のような催し物の当日の様子を書く欄はありません。但し会の日程は行の『会期』（実測 145 行）に、オンラインで参加できるかは『オンライン参加可』の印に出ます。",
      live: "は収録していません（当日の様子の欄はありません。公式ページをご覧ください）",
    },
    {
      /* SPEC 第 505・517 */
      words: [
        "ポスター期限",
        "ポスター応募",
        "ポスター案内",
        "ポスター発表期限",
        "ポスター発表応募",
        "ポスター発表募集",
        "ポスター発表案内",
        "デモ期限",
        "デモ応募",
        "デモ募集",
        "デモ案内",
        "デモ発表期限",
        "デモ発表応募",
        "デモ発表募集",
        "デモ発表案内",
        "チュートリアル期限",
        "チュートリアル応募",
        "チュートリアル案内",
        "ワークショップ期限",
        "ワークショップ応募",
        "ワークショップ案内",
        "セッション期限",
        "セッション応募",
        "セッション案内",
        "特別セッション期限",
        "特別セッション応募",
        "特別セッション案内",
        "招待講演応募",
        "招待講演募集",
        "招待講演案内",
        "抄録期限",
        "抄録応募",
        "抄録募集",
        "抄録案内",
        "アブストラクト期限",
        "アブストラクト応募",
        "アブストラクト募集",
        "アブストラクト案内",
        "論文期限",
        "論文応募",
        "論文案内",
        /* SPEC 第 645 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "最終締切",
        "二次締切",
        "第二次締切",
        "追加締切",
        "査読期限",
        "査読応募",
        "査読募集",
        "査読案内",
        "査読締切",
        "採択期限",
        "採択応募",
        "採択募集",
        "採択案内",
        "登録応募",
        "登録募集",
        "登録案内",
        "学生期限",
        "学生応募",
        "学生募集",
        "学生案内",
        "カメラレディ応募",
        "カメラレディ募集",
        "カメラレディ案内",
      ],
      deadlineTail: true,
      echo: true,
      note: "という繋ぎ方では、この表は行を持ちません。催し物や原稿の名前（ポスター・デモ・チュートリアル・抄録など）と、締切の種別とは別の欄に載るので、二つを繋げた語は公式ページの文に現れるだけで表の語にはなりません。催し物の名前の語を単体で打つと、その語を行うに載せる行が出ます（実測 2026-09-30 – 実ビルドの品書 868 行: 『デモ』7 行・『ポスター』6 行・『チュートリアル』5 行・『抄録』146 行）。締切の区別で絞るのは『論文締切』（同 457 行）・『概要締切』（同 146 行）・『採否通知』（同 129 行）・『カメラレディ』（同 70 行）・『登録締切』（同 7 行）のように種別その物の語で打ってください。",
      live: "という締切の区別はありません（催し物の名前の語と締切の種別は別の欄に載ります）",
    },
    {
      /* SPEC 第 337・586 */
      words: ["二次会", "ツアー", "交歓", "親睦", "レセプション", "観光地", "観光"],
      multiword: true,
      echo: true,
      note:
        "はこの表の行に書かれて居らん交歓の段取りの話です。収録するのは催し物の名前・締切の日・" +
        "分野・種別・開催地・参加形式の六つで、二次会・観光・ツアー・レセプションのやうな交歓と" +
        "懇親の用意は、その催し物の公式ページの発表計画（社会プログラムの欄）か、参加者へ届く" +
        "案内の文に書かれて居ます。会場その物の事（最寄り・駐車・荷物・機材）は『最寄り』等で打つと" +
        "別の案内が出ます。",
      live: "交歓と懇親の段取りはありません（公式ページの社会プログラムの欄に）",
    },
    {
      /* SPEC 第 337・525・578・587 */
      words: [
        "産休",
        "育休",
        "育児",
        "介護休",

        "受講証明",
        "継続教育",
        "単位認定",
        /* SPEC 第 617・388・505 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "単位",
        "単位が立つ",
        "単位の認定",
        "修了要件",
        "博士号の要件",
        "出席扱い",
        "学務",
        "進級",
      ],
      multiword: true,
      echo: true,
      note:
        "は、その催し物の側ではなく、あなたの所属で決まる話です。この表は催し物の名前・締切の日・" +
        "分野・種別・開催地・参加形式だけを出して居り、単位が立つのか、修了や進級の要件に数えるのか、" +
        "参加を出席として扱うのかは、所属の大学・研究科の事務（学務・教務・学籍を扱う窓口）と、その" +
        "規程で決まります。催し物その物の事（会期・開催地・分野）は普段の打ち方で行が出ます。",
      live: "所属の大学・研究科の事務で決まる話です（この表は催し物の情報だけを持ちます）",
    },
    {
      /* SPEC 第 337 */
      words: ["公式ページ", "公式サイト", "URL", "ホームページ"],
      echo: true,
      note:
        "はこの表が持たない話ではありません。実測（2026-11-14 – 実ビルドの品書 700 件と版 1,677 件を" +
        "数へた）では収録の全てが公式ページへの繋ぎ先（URL）を持って居り、行を選ぶとドロワーに" +
        "『公式サイトを開く』のボタンが出ます。其の方の行を出すには、催し物の名前（例: SIGCOMM）・分野" +
        "・開催地・締切の日を打ってください。依頼の文そのままで打つと（『公式ページのURLを教えて』等）" +
        "行は出ません。",
      live: "公式ページへの繋ぎ先は行が持っています（行の『公式サイトを開く』ボタン）",
    },
    {
      /* SPEC 第 322・590 */
      words: ["和文論文誌", "和文", "英文論文誌", "研究報告"],
      multiword: true,
      echo: true,
      note:
        "では行が出ません。この表は催し物と特集号の締切を、その名前の表記で収録して居り、実測" +
        "（2026-11-16 – 品書 700 件）で和文・英文の別を持つ行は在りません。近い名前で打つと行が出ます" +
        "（同じ実測: 『論文誌』5 行・『特集号』15 行・『研究会』23 行・『journal』6 行）。その催し物の" +
        "和文・英文の別は、行の『公式サイトを開く』から飛べる公式ページに書いて居ます。",
      live: "和文・英文の別では絞り込めません（『論文誌』『特集号』等の名前で打つと行が出ます）",
    },
    {
      /* SPEC 第 601 */
      words: [
        "問い合わせ",
        "問い合わせ先",
        "相談窓口",
        "相談",
        "窓口",
        "事務局",
        "ハラスメント相談",
      ],
      multiword: true,
      echo: true,
      note:
        "を書く欄はこの表にありません。収録するのは締切日・会議名・開催地・参加形式の印" +
        "（『オンライン参加可』）・分野・等級だけで、催し物への問い合わせ先、相談の窓口（ハラスメント" +
        "の相談を含む）、事務局の連絡先は各催し物の公式ページの問い合わせの項や組織委員の一覧に書かれて" +
        "居ます。行の詳細を出せば其の公式ページが開けます。",
      live: "各催し物の公式ページの問い合わせの項・組織委員の一覧に載ります",
    },
    {
      /* SPEC 第 613・522・512 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        "PCメンバー",
        "プログラム委員会",
        "組織委員会",
        "運営委員会",
        "実行委員会",
        "セッションチェア",
        "オーガナイザー",
        "一般委員",
        "学生委員",
        "委員",
      ],
      multiword: true,
      echo: true,
      note:
        "はこの表が持っていません。収録するのは締切日・会議名・開催地・参加形式の印" +
        "（『オンライン参加可』）・分野・等級だけで、運営の委員の募集や委員の構成を書く欄は" +
        "ありません。其の催し物の組織委員の一覧は各会議の公式ページに載つて居ます。行の詳細を" +
        "出せば其の公式ページが開けます。",
      live:
        "は収録していません（委員の募集・構成の欄はありません。公式ページの組織委員の一覧を" +
        "ご覧ください）",
    },
    {
      /* SPEC 第 613・337・535 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        "リマインド",
        "リマインダー",
        "催促",
        "通知メール",
        "メール配信",
        "再通知",
        "締切の連絡",
      ],
      multiword: true,
      echo: true,
      note:
        "はこの表が持っていません。催し物がメールを送るか送らんかを書いた欄はなく、収録するのは" +
        "締切日・会議名・開催地・参加形式の印（『オンライン参加可』）・分野・等級だけです。但し" +
        "段階の日は種別に載つて居ますので、『採択』（実測 129 行）・『査読』（実測 13 行）・" +
        "『登録』（実測 7 行）のような締切の語でその段階の日が絞れます。",
      live: "は収録していません（メールの欄はありません。段階の日は『採択』『査読』『登録』で絞れます）",
    },

    {
      /* SPEC 第 629 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        "PDF読み込み",
        "PDFの読み込み",
        "PDFを読み込み",
        "ファイルを読み込み",
        "ファイル読み込み",
        "読み込みをキャンセル",
        "PDF読み込みをキャンセル",
      ],
      echo: true,
      deadlineTail: true,
      note: "は論文ファイルの操作です。「投稿先を探す」の「論文の入力」でファイルを選び、読み込み中の「読み込みをキャンセル」で中断できます。PDFは先頭3ページから題名・概要・キーワードを読み取り、選んだファイルは送信しません。",
      live: "は「投稿先を探す」の操作です。読み込み中は「読み込みをキャンセル」で中断できます",
    },
    {
      /* SPEC 第 629 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        "まだ受付中",
        "受付中",
        "まだ間に合う",
        "間に合いますか",
        "今から投稿",
        "間に合わない",
        "もう間に合わない",
        "滑り込み",
        /* 第 671 回 – 締切の後に望みを繋ぐ言い方（`滑り込み` は通る）。*/
        "遅れて提出",
        "セカンドチャンス",
        "ラストミニット",

        "今からでも間に合う",
        "今から間に合う",
        "まだ大丈夫",
        "今からでも大丈夫",
      ],
      echo: true,
      deadlineTail: true,
      note: "のことなら、受付状況は公式ページで確認してください。締切までの日数は一覧の『残り』に出ます。締切日のない募集は検索語を消してから『種別』で『常時受付』を選んで探せます。過ぎた締切を見るには『過去の締切も表示』をオンにしてください。",
      live: "のことなら、締切を確認してください。常時受付は検索語を消して『種別』で探せます",
    },

    {
      /* SPEC 第 685・337 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        "募集",
        "募集中",
        "応募",
        "公募",
        "発表募集",
        "参加募集",
        "参加者募集",
        "論文募集中",
        "応募受付",
        "登録受付",
        "参加受付",
        "申込受付",
        "発表申込受付",
        "参加申込受付",
        "公募情報",
        "募集開始",
        "受付開始",
        "応募開始",
        /* SPEC 第 689 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "学会発表",
        /* SPEC 第 685・514・362 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
        "期限",
        "締切期限",
        "応募期限",
        "募集期限",
        "投稿期限",
        "申込期限",
      ],
      echo: true,
      deadlineTail: true,
      note: "は締切の種別の名前ではありません。この表が並べているのは催し物の募集の締切その物なので、検索語を消すと募集中の締切が並び、残り日数は列『締切まで』に出ます。種類で絞る時は種別の語（『論文締切』『概要締切』、国内の研究会は『発表申込締切』）で打ってください。過ぎた募集まで見るには、上にある『過去の締切も表示』をオンにします。",
      live: "はこの表が並べている募集の締切その物です。検索語を消すと募集中の締切が並びます",
    },

    {
      /* SPEC 第 630 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: ["通知設定", "通知を受け取る", "通知が欲しい", "通知方法", "メール通知", "アラート"],
      echo: true,
      note: "のことなら、この頁からのメール配信やブラウザへの通知は在りません – 一覧の下の『カレンダーに追加（.ics）』で自分のカレンダーに入れ、『購読 URL をコピー』でアプリに購読先として打ち込むと、同じ購読先は毎日更新された形で読めます。",
      live: "のことなら、メール配信は在りません – 『カレンダーに追加（.ics）』か『購読 URL をコピー』を",
    },
    {
      /* SPEC 第 630 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: ["下書き", "ドラフト", "草稿", "入力中の論文が消えた"],
      echo: true,
      note: "のことなら、論文の入力に打ち込んだ物はこのタブの間は残ります – 画面を刷新しても欄の中身は保ちますが、別のタブや他の人には渡りません（共有 URL には乗りません）。間違へて『論文の入力を消す』を押した直後なら、『直前の入力に戻す』のボタンが出て之で戻せます。",
      live: "のことなら、打ち込んだ論文の入力はこのタブの間は残ります（URL には乗りません）",
    },

    {
      /* SPEC 第 631 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      /* SPEC 第 641 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: ["キーボード", "キー操作", "キーバインド", "ショートカット", "タブ", "Tab"],
      echo: true,
      note: "のことなら、ページ下の『見方のてびき』に『キーボードで一覧を動かす』の項が在ります – j / k（または ↓ / ↑）で選択行を動かし、Enter で公式ページを開き、d で行の詳細、/ で検索欄に飛び、Esc で欄を出ます。列の見出しも Tab で動いて Enter（またはスペース）で並び替わり、押して居る列は ↑ / ↓ と出ます。投稿先を探すモードでは表用の操作は使いません。",
      live: "のことなら、ページ下の『見方のてびき』に『キーボードで一覧を動かす』の項が在ります",
    },

    {
      /* SPEC 第 634・503 回（群の理由と実測は SPEC にある – 第 699 回にここを一読に縮めた）。*/
      words: [
        "スマホ",
        "スマートフォン",
        "携帯",
        "ケータイ",
        "レイアウト",
        "画面が崩れる",
        "表示が崩れる",
        "見にくい",
        "見づらい",
        "小さい画面",
        "タブレット",
        "iphone",
        "android",
      ],
      echo: true,
      note: "のことなら、狭い画面（スマートフォンの幅）では列の見出しを消して行をカードにし、表の上に『並べ替え』の列を出します – 並びを変えたい時は其の列のボタンを押してください。手元の端末で締切を持ち歩きたいなら、一覧の下の『カレンダーに追加（.ics）』で自分のカレンダーに入れる事も出来ます。詳しくはページ下の『見方のてびき』に書いてあります。",
      live: "のことなら、狭い画面では行をカードにして、表の上に『並べ替え』の列を出します",
    },
  ];

  type UIWordGroup = (typeof UI_WORD_GROUPS_JA)[number];

  const UI_WORD_TAILS_JA = [
    "したい",
    "される",
    "されます",
    "されて",
    "されました",
    "されています",
    "しています",
    "しました",
    "されますか",
    "されるの",
    "か",
    "ますか",
    "ですか",
    "でしょうか",
    "しますか",
    "を知りたい",
    "を教りたい",
    "は要りますか",
    "は必要ですか",
    "が要る",
    "が要ります",
    "が必要",
    "をお願い",
    "をしたい",
    "の有無",
    "募集",
    "対応",
    "を教えて",
    "してほしい",
    "して欲しい",
    "が欲しいです",
    "が知りたいです",
    "の予定は",
    "の可否",
    "します",
    "する",
    "して",
    "しとく",
    "し方",

    "追加",
    /* 「で」で打ち切る頼み方。`表示` も同じ（`すべて表示`）。 */
    "で",
    /* 一つに絞る頼み方。 */

    "知りたい",
    "見たい",
    "を探す",
    /* 設定まはりの語と、残存を問ふ語、
       手元の操作を問ふ語。 */
    "操作",
    "設定",
    "殘る",
    "残る",
    "殘ります",
    /* 操作をやめる打ち方。 */
    "キャンセル",
    /* 欄の名前を打ってから「選ぶ」「出す」で終る打ち方。 */
    "選ぶ",
    "てびき",
    "だけ",
    "のみ",
    "しか",
    "表示",
    "ください",
    "下さい",
    "しかた",
    "の仕方",
    "のやり方",
    "のしかた",
    "の場所",
    "はどこ",
    "はどこですか",
    "できる",
    "できます",
    "たい",
    "ほう",
    "る",
    "し",
    "を消す",
    "を解除",
    "を外す",
    "を戻す",
    "をコピー",
    "に追加",
    "に加える",
    "に入れる",
    "に入れて",
    "に付ける",
    "につける",
    "の書き出し方",
    "の仕方を知りたい",

    "は",
    "は？",
    "は?",
    "はいくら",
    "はいくら？",
    "はいくら?",
    "はいくらですか",
    "いくら",
    "いくら？",
    "いくら?",
    "いくらですか",
    "いくらかかりますか",
    "いくらかかる",
    "はいつ",
    "はいつ？",
    "はいつ?",
    "はいくつ",
    "はいくつ？",
    "はいくつ?",
    "どうなっている",
    "はどうなっている",
    "いつ",
    "いつ？",
    "いつ?",
    "どこ",
    "はいくらかかりますか",
    "はいくらかかる",
    "はいくら位",
    "いくら位",
    "はいくらぐらい",
    "いくらぐらい",
    "はいくらくらい",
    "いくらくらい",
    "はいつですか",

    "ありますか",
    "あります",
    "あるの",
    "あるの？",
    "ありますか？",
    "いつありますか",
    "はいつありますか",

    "できますか",
    "できるか",
    "できるの",
    "出来る",
    "ほしい",
    "いつある",
    "はいつある",
    "いつ分かる",
    "はいつ分かる",
    "いつわかります",
    "が知りたい",
    "知りたい",
    "しりたい",
    "わかりたい",
    "教えて",
    "おしえて",
    "いつ頃",
    "はいつ頃",
    "いつになる",
    "いつになります",

    "は知りたい",
    "が知りたい",
    "は知りたく",
    "が知りたく",
    "は教えて",
    "が教えて",
    "はあるの",
    "があるの",
    "はありますか",
    "は知りたいです",
    "がわかる",
    "が分かる",
    "はわかる",
    "は分かる",
    "いつですか",
    "っていくら",
    "っていつ",
    "っていつですか",
    "どこ？",
    "どのくらい",
    "はどれくらい",
    "どれくらい",
    "はどのくらい",
    "どれくらいですか",
    "何人",
    "は何人",
    "何件",
    "は何件",
    "あるか",
    "はあるか",
    "はある？",
    "はある?",
    "が出るか",
    "は出るか",
    "が出る",
    "は出る",
    "があるか",
    "がある？",
    "がある?",
    "があります",
    "がありますか",
    "がある",
    "はいくつある",
    "いくつある",
    "ある？",
    "ある?",
    "ありますか",
    "はありますか",
    "どこ?",
    "してもらえる",
    "してもらえるか",
    "もらえますか",
    "もらえるか",
    "の会期",
    "有りますか",
    "は有りますか",
    "の参加",
    "の募集",
    "の扱い",
    "の発行",
    "の制限",
    "の回数",
    "の依頼",
    "への依頼",
    "への登録",
    "のテンプレート",
    "のサービス",
    "の広さ",
    "の記載",
    "の記入",
    "の要求",
    "の公開",
    "が欲しい",
    "が通る",
    "いつ開かれる",
    "いつ開きます",
    "は英語",
    "は英語？",
    "は英語?",
    "は日本語",
    "は日本語？",
    "は日本語?",
    "何本まで",
    "一人何本まで",
    "の準備期間",
    "何日前まで",
    "何日前",
    "参加できる",
    "参加できます",
    "参加できる？",
    "参加できる?",
    "参加可能",
    "参加可能な",

    "になりたい",
    "参加したい",
    "参加希望",
    "の会期は",

    "を後で見る",
    "対応している",
    "として認定される",
    /* 「その一覧を**この形でもらえる… – 実測と理由は第 723 回に SPEC へ送つた。*/
    "でもらえる",
    "でもらえるか",
    "でもらえます",
    "でもらえますか",

    "がほしい",
    /* 「〜されたか確認する」「〜は誰がする」「〜論文のみ」。語を繋いだ形の磁石は 0 件実測 – 行が出る打ち方に斷りを出さん。*/
    "か確認する",
    "は誰がする",
    "論文のみ",

    "はいりますか",
    "いりますか",
    "は取っていますか",
    /* 義務の問ひ（`座長はやらないといけませんか`）。*/
    "といけませんか",
    "なければなりませんか",
    "大丈夫ですか",
    /* 「〜すればいいですか」（`発表者だけ登録すればいいですか` – 実測 0 行 – 第 620 回）。*/
    "いいですか",
    "ばいいですか",

    "はどうする",
    "に見たい",

    "落とす",
    "設定",
    "取り込む",
    "開く",
    "見る",
    "どこで見る",
    "に出る",
    "はある",

    "会議",
    "査読",
    "視聴",
    "動画",
    "開催",
    "限定",
    "専用",
    "専門",
    "特化",
    "向け",
    "歓迎",
  ];

  const UI_WORD_TAIL_NOUNS_JA = [
    "会議",
    "学会",
    "大会",
    "研究会",
    "ワークショップ",
    "セッション",
    "締切",
    "支援",
    "補助",
    "もの",
    "場合",
    "際",
    "時",
    "予定",
    "方法",
    /* 第 650 回 – 「どうやるのか」を訪ねる名をもう一つ（`購読の手順` `設定手順` – 上と同じ組み合はせで效く）。*/
    "手順",
  ];
  function uiWordTailOk(tail: string, 敬語一枚可?: boolean): boolean {
    if (UI_WORD_TAILS_JA.includes(tail)) return true;

    const 挟 = /^(?:から|まで|より|[がをにでへとものはや])(?=[ぁ-んァ-ヶ一-龥a-zA-Z々〻])/.exec(
      tail,
    );
    if (挟 && uiWordTailOk(tail.slice(挟[0].length))) return true;
    for (const 名 of UI_WORD_TAIL_NOUNS_JA) {
      if (!tail.endsWith(名)) continue;
      const 頭 = tail.slice(0, tail.length - 名.length);
      if (頭.length > 0 && UI_WORD_TAILS_JA.includes(頭)) return true;

      if (
        頭.length >= 2 &&
        頭.length <= 12 &&
        !/[\s、，,]/.test(頭) &&
        /^(?:が必要(?:な|です)?|が要る|が必須|が求められ(?:る|ます)?|が(?:不要|無し|無い|ない)(?:な|です)?|で(?:発表|參加|登壇|聽講)できる|でも(?:発表|參加)できる|ができる)$/.test(
          頭,
        )
      )
        return true;
    }

    for (const 知 of UI_WORD_TAILS_JA) {
      if (知.length < 4 || tail.length <= 知.length + 1 || !tail.endsWith(知)) continue;
      const 挟 = tail.slice(0, tail.length - 知.length);
      if (挟.length < 2 || 挟.length > 6 || /[\s、，,]/.test(挟)) continue;
      if (/[ぁ-ん]/.test(挟)) return true;
    }
    /* 敬語の尾を一枚剥がして同じ目で験す。実測 – `購読したいです` は羣の語に当るが
     * 敬語が續いただけで黙つていた（`購読したい` では出る）。 */

    if (敬語一枚可 && ["です", "ですか", "でしょうか", "でした", "ですよ", "ですね"].includes(tail))
      return true;

    if (
      /^[ぁ-んァ-ヶ一-龥々〻]{1,4}(?:たく|たい)(?:です|ですか|でしょうか|でした|ましょうか)?$/u.test(
        tail,
      )
    )
      return true;
    for (const 敬 of ["です", "ですか", "でしょうか", "でした", "ですよ", "ですね", "たいです"]) {
      if (!tail.endsWith(敬) || tail.length <= 敬.length) continue;
      if (uiWordTailOk(tail.slice(0, tail.length - 敬.length))) return true;
    }

    for (const 締 of UI_WORD_DEADLINE_TAILS_JA) {
      if (!tail.startsWith(締) || tail.length <= 締.length) continue;
      if (uiWordTailOk(tail.slice(締.length))) return true;
    }
    return false;
  }

  const UI_WORD_DEADLINE_TAILS_JA = [
    "締切",
    "の締切",
    "締切日",
    "の締切日",
    "締め切り",
    "の締め切り",
    "しめきり",
    "のしめきり",
    "期限",
    "の期限",
    "予定",
    "の予定",
    "まで",
    "までに",
  ];

  const UI_WORD_STAT_TAILS_JA = ["が高い", "が低い", "が多い", "が少ない"];

  function uiWordStemForms(q: string): string[] {
    const 表: Record<string, string> = {
      う: "い",
      く: "き",
      ぐ: "ぎ",
      す: "し",
      ず: "し",
      つ: "ち",
      ぬ: "ん",
      ぶ: "び",
      む: "み",
      る: "り",
    };
    const last = q.slice(-1);
    const 直 = 表[last];
    return 直 ? [q, q.slice(0, -1) + 直] : [q];
  }

  function 比べる語尾か(tail: string): boolean {
    return UI_WORD_STAT_TAILS_JA.some((語尾) => tail.startsWith(語尾));
  }

  function uiWordContain(q: string): { group: UIWordGroup; word: string } | null {
    if (q.length < 3 || q.length > 24) return null;
    let best: UIWordGroup | null = null;
    let bestWord = "";
    for (const form of uiWordStemForms(q)) {
      for (const group of UI_WORD_GROUPS_JA) {
        for (const word of group.words) {
          const folded = word.toLowerCase();
          if (folded.length < 2 || folded.length <= bestWord.length) continue;
          if (!form.startsWith(folded)) continue;
          const tail = q.slice(folded.length);

          const 連体 = tail.startsWith("の") && !/[\s、，,]/.test(tail);
          if (
            tail &&
            group.anyTail !== true &&
            !(group.deadlineTail === true && (UI_WORD_DEADLINE_TAILS_JA.includes(tail) || 連体)) &&
            !(group.statTail === true && 比べる語尾か(tail)) &&
            !uiWordTailOk(tail, true)
          )
            continue;
          best = group;
          bestWord = folded;
        }
      }
    }
    return best ? { group: best, word: bestWord } : null;
  }

  function 訪ねの尾を剥ぐ(q: string): string {
    const 身 = q.replace(/[？?！!。\s]+$/, "");
    return 身.replace(/(?:はどれですか|はどれか|はどれ|がどれ|はいつ|はいくつ|は幾つ)$/, "");
  }
  /** 打たれた語がどの案内の組に掛かるか（完全一致 → 活用の形の順で探す）。 */
  function uiWordMatch(query: unknown): { group: UIWordGroup; word: string } | null {
    const 生 = String(query == null ? "" : query)
      .trim()
      .toLowerCase();
    if (!生) return null;
    /* 見る順は**その侬を先に** – 崩した形を先に数へると `分野は幾つ` が「分野」一文字に落ちて
     * 第 649 回の案内を奪つた（実測 – 検査が名前を出して彈いた）。*/
    const 崩 = 訪ねの尾を剥ぐ(生);
    return uiWordMatch文(生) || (崩 !== 生 ? uiWordMatch文(崩) : null);
  }
  function uiWordMatch文(q: string): { group: UIWordGroup; word: string } | null {
    const 訪ねの崩 = q.replace(/(?:ですか|ますか|でした|です|ます|だ|か|？|\?)$/, "");
    const 訪ねの身 = 訪ねの崩.endsWith("り") ? `${訪ねの崩.slice(0, -1)}る` : 訪ねの崩;
    for (const group of UI_WORD_GROUPS_JA) {
      const word =
        group.words.find((candidate) => candidate.toLowerCase() === q) ||
        (group.exactOnly || []).find((candidate) => {
          const 語 = candidate.toLowerCase();
          return 語 === q || 語 === 訪ねの身;
        });
      if (word) return { group, word };
    }
    const 含み = uiWordContain(q);
    if (含み) return 含み;

    const 語尾の案内 = /(?:より|よりも)?(より前|よりまえ|よりも前|より前に|以前から|以前)$/.exec(q);
    if (語尾の案内) {
      const 語 = 語尾の案内[1];
      for (const group of UI_WORD_GROUPS_JA) {
        if (group.words.indexOf(語) >= 0) return { group, word: 語 };
      }
    }

    /* 繋ぐ語は「の」限りでは無い – 訪ねは**助詞で繋がる**（`論文が掲載` `動画は録画` `名前は記載`）。
     * ただし助詞を広げるとその前の部が**その方の群の語**である形を奪ふので、讓りの門（上）を
     * 其侭置く（実測 – `査読期間の締切` は前の方の斷りだけ）。*/
    const 連体 = /^(.{2,}?)(?:の|が|は|を|に|で|へ)(.+)$/.exec(q);
    if (連体) {
      const 後 = 連体[2];

      if (!uiWordContain(q)) {
        let best: { group: UIWordGroup; word: string } | null = null;
        for (const group of UI_WORD_GROUPS_JA) {
          const word = group.words.find((候補) => {
            if (候補.toLowerCase() === 後) return true;
            const 低 = 候補.toLowerCase();
            return 後.length > 低.length && 後.startsWith(低) && uiWordTailOk(後.slice(低.length));
          });
          if (word && (!best || word.length > best.word.length)) best = { group, word };
        }
        if (best) return best;
      }
    }

    const 語々 = q.split(/[\s、，,・]+/).filter((語) => 語.length >= 1);
    if (語々.length < 2) return null;
    let best: { group: UIWordGroup; word: string } | null = null;
    for (const 語 of 語々) {
      for (const group of UI_WORD_GROUPS_JA) {
        if (group.multiword !== true) continue;
        const word = group.words.find((candidate) => candidate.toLowerCase() === 語);
        if (word && (!best || word.length > best.word.length)) best = { group, word };
      }
    }
    return best;
  }

  function uiWordEntry(query: unknown): UIWordGroup | null {
    return uiWordMatch(query)?.group || null;
  }

  function uiWordExact(query: unknown): string {
    const q = String(query == null ? "" : query)
      .trim()
      .toLowerCase();
    if (!q) return "";
    for (const group of UI_WORD_GROUPS_JA) {
      const word = group.words.find((candidate) => candidate.toLowerCase() === q);
      if (word) return word;
    }
    return "";
  }

  /** 打ち返された語を正本の表記で返す（案内に書き返すか決めるのに使う）。 */
  function uiWordRawJa(query: unknown): string {
    return uiWordMatch(query)?.word || "";
  }

  function 打たれた表記Ja(query: unknown, 照合の語: string): string {
    const 折 = (値: string) =>
      (typeof 値.normalize === "function" ? 値.normalize("NFKC") : 値).toLowerCase();
    const 元 = String(query == null ? "" : query).trim();
    if (!元 || !照合の語) return 照合の語;
    const 照合 = 折(照合の語);
    if (折(元) === 照合) return 元;
    const 語列表 = 元.split(/\s+/).filter((語) => 語);
    for (const 語 of 語列表) {
      if (折(語) === 照合) return 語;
    }
    for (const 語 of 語列表) {
      if (折(語).indexOf(照合) === 0 && 語.length >= 照合の語.length) {
        return 語.slice(0, 照合の語.length);
      }
    }
    return 照合の語;
  }

  /** 0 件案内に出す一文（画面の使い方・操作・出典の語を打たれた人向け – 第 248 回）。 */

  function uiWordShapeNoteJa(query: unknown, 短い形: boolean, 打ち替えが在るか?: boolean): string {
    const 文 = String(query == null ? "" : query).trim();
    if (!文) return "";
    const 選ぶ = (長: string, 短: string) => (短い形 ? 短 : 長);

    const 週の位のかたちJa =
      /^(?:今週|こんしゅう|来週|らいしゅう|翌週|再来週|再々週|来々週|さいしゅう|さらいしゅう|先週|せんしゅう|昨週|前週|先々週|せんせんしゅう)(?:の)?(?:前半|後半)(?:に)?$/;

    const 時間帯の名前Ja =
      /^(?:夕方|ゆうがた|夕方頃|朝方|あさがた|明け方|夜明け|深夜|真夜中|未明|夜間|終日|一日中|1日中|お昼|昼|お昼過ぎ|昼過ぎ|真昼|昼間|ひるま|夜|夜中|今夜|朝|早朝|終業時間|終業|退勤|勤務終了)(?:までに|前に|前|以降|過ぎ|後に|後)?(?:に)?\s*(?:でした|ですか|でしょうか|でしょう|でしたね|ですよ|ですね|です|だよ|かな|じゃない|ではない|だと思います)?$/;

    const 幅の語の近似Ja =
      /^(?:今週|こんしゅう|来週|らいしゅう|翌週|再来週|再々週|来々週|先週|せんしゅう|昨週|前週|先々週|今月|来月|らいげつ|再来月|先月|せんげつ|去月|[0-9]{1,2}月|今年|来年|らいねん|再来年|去年|こぞとし|前年|[0-9]{3,4}年)(?:頃|ころ|ごろ|辺り|あたり|位|ぐらい|くらい|前後)(?:に)?\s*(?:でした|ですか|でしょうか|でしょう|でしたね|ですよ|ですね|です|だよ|かな)?$/;
    if (幅の語の近似Ja.test(文)) {
      return 選ぶ(
        ` 「${文}」では絞れません。週や月・年と言ふ幅の語に頃・前後のやうな近似の語を` +
          `続けても意味が決まりません – 前後にどこまで広げるかに公用の決まりが無く、` +
          `表側で勝手に幅を広げません。幅の語だけで「来週」「来月」のように打ってください`,
        `「${文}」では絞れません – 幅の語だけで「来週」「来月」のように打ってください`,
      );
    }

    const 時刻の近似Ja =
      /^(?:(?:午前|午後|ごぜん|ごご))?(?:正午|(?:[0-9]{1,2}|[〇零一二三四五六七八九十]{1,3})時(?:[0-9]{1,2}分|半)?)(?:頃|ころ|ごろ|辺り|あたり|位|ぐらい|くらい|前後)(?:に)?\s*(?:でした|ですか|でしょうか|でしょう|でしたね|ですよ|ですね|です|だよ|かな)?$/;
    if (時刻の近似Ja.test(文)) {
      return 選ぶ(
        ` 「${文}」で打たれても絞り込めません。時刻に頃・前後のやうな近似の語を続けても` +
          `何分前から何分後かを指すかに公用の決まりが無く、表側で勝手に幅を作りません。` +
          `其の時の幅で見る「17時台」・其の時刻からの「17時以降」のように打ってください`,
        `「${文}」では絞れません –「17時台」「17時以降」のように打ってください`,
      );
    }

    const 日の時間帯のかたちJa =
      /^(?:今日|明日|明後日|明々後日|あさって|昨日|一昨日|来週|今週|再来週|先週|先々週|週末|今週末|来週末|来月|今月|先月|来年|今年|去年|(?:(?:来|今|再々?|先々?)(?:周|週))(?:月|火|水|木|金|土|日)曜日?|[月火水木金土日]曜日?|(?:[0-9]{4}[-/年])?[0-9]{1,2}[-/月][0-9]{1,2}日?|(?:[0-9]{4}[-/年])?[0-9]{1,2}月|[0-9]{1,2}日)(?:の)?(?:(?:お昼|昼|夕方|ゆうがた|朝|深夜|夜)の)?(?:お昼|昼|夕方|ゆうがた|朝方|あさがた|明け方|夜明け|深夜|真夜中|未明|夜間|終日|一日中|1日中|お昼過ぎ|昼過ぎ|真昼|昼間|ひるま|夜|夜中|朝|早朝|終業時間|終業|退勤|勤務終了)(?:までに|前に|前|以降|過ぎ|後に|後)?(?:に)?\s*(?:でした|ですか|でしょうか|でしょう|でしたね|ですよ|ですね|です|だよ|かな)?$/;
    if (日の時間帯のかたちJa.test(文)) {
      return 選ぶ(
        ` 「${文}」では絞り込めません。日の語は其の方で解けますが、夕方・深夜のやうな` +
          `時間帯の名前はいつからいつまでを指すかに公用の決まりが無く、表側で勝手に幅を` +
          `作りません。其の日だけで「明日」「金曜」・其の時刻で「17時以降」のように打ってください`,
        `「${文}」では絞れません – 其の日「明日」か其の時刻「17時以降」で打ってください`,
      );
    }
    if (時間帯の名前Ja.test(文)) {
      return 選ぶ(
        ` 「${文}」のように時間帯の名前で打たれても絞り込めません – いつからいつまでを指すかに公用の決まりが無く、` +
          `表側で勝手に幅を作りません。其の時刻で見る（「午後5時」「17時台」）・其の日で見る（「明日」「8月12日」）のどちらかで打ってください。` +
          `正午を境にした「午前」「午後」は受けます`,
        `「${文}」では絞れません – 時間帯に公用の幅が有りません。「午後5時」「明日」で`,
      );
    }

    if (/^一時(?:に)?\s*(?:でした|ですよ|ですね|です|でしょうか|ですか|でしょう|かな)?$/.test(文)) {
      return 選ぶ(
        ` 「一時」は「しばらく」の意味にも取れるので、1 時に寄せません – 何時の事なら「1時」「午前1時」「13時」のように、` +
          `其の日の事なら「明日」「8月12日」のように打ってください`,
        `「一時」は1時に寄せません – 何時か（「1時」）か其の日（「明日」）で`,
      );
    }
    if (週の位のかたちJa.test(文)) {
      /* 打たれた表記を其侭返す（寄せた形を書かない – 第 366 回の決まり）。*/
      return 選ぶ(
        ` 「${文}」のように週の語に前半・後半を繋げても絞り込めません – 其の週の前半・後半が何日から何日を指すか（三日か四日か、水木か木金か）には公用の決まりが無く、` +
          `表側で勝手に幅を作りません。其の週すべてで見る（「来週」）・其の日で見る（「来週水曜」「8月12日」）のどちらかで打ってください`,
        `「${文}」では絞れません – 其の週「来週」か其の日「来週水曜」で打ってください`,
      );
    }

    const 月の頭尾のかたちJa =
      /^(?:(?:今|来|先|再来|再々|翌|去)月|(?:[0-9]{1,2}|[〇一二三四五六七八九十]{1,3})月)(?:の)?[ \u3000]*(?:の)?[ \u3000]*(?:頭|初め|始め|最初)[ \u3000]*(?:に)?$/;
    if (月の頭尾のかたちJa.test(文)) {
      return 選ぶ(
        ` 「${文}」では絞り込めません。其の月の初めという言い方は、一日を指す人もあれば初めの几日や` +
          `初めの十日（上旬）を指す人もあるので、公用の決まりに従つて寄せられません。其の日（「5日」）、` +
          `其の十日間（「上旬」）、又は其の月（「${文.replace(/[ \u3000]*(?:頭|初め|始め|最初)[ \u3000]*(?:に)?$/, "").trim()}」）で打ってください`,
        `「${文}」では絞れません – 其の日「5日」・上旬・其の月で打ってください`,
      );
    }
    const 週の頭尾のかたちJa =
      /^(?:今週|こんしゅう|来週|らいしゅう|翌週|前週|先週|せんしゅう|昨週|再来週|再々週|来々週|さいしゅう|さらいしゅう|先々週|せんせんしゅう|週)(?:の)?(?:頭|初め|始め|最初|末日|終わり)(?:に)?$/;
    if (週の頭尾のかたちJa.test(文)) {
      return 選ぶ(
        ` 「${文}」のように週の語に頭や終わりを繋げても絞り込めません – 其の週の中いつを指すか（月曜日か週の初めの几日か、金曜日か土日も含めた週末か）には公用の決まりが無く、` +
          `表側で勝手に幅を作りません。其の週すべてで見る（「来週」）・其の曜日で見る（「来週月曜」「8月12日」）・週末で見る（「来週末」）のどちらかで打ってください`,
        `「${文}」では絞れません – 其の週「来週」か、其の日や週末で打ってください`,
      );
    }

    const 月の前半のかたちJa =
      /^(?:[0-9]{1,2}月|今月|来月|再来月|先月|先々月|翌月|前月|こんげつ|らいげつ|せんげつ|さらいげつ)(?:の)?前半(?:の締切|締切)?(?:に)?$/;
    if (月の前半のかたちJa.test(文)) {
      return 選ぶ(
        ` 「${文}」のように月の語に前半を繋げても絞り込めません – 月の前半が何日までを指すか（上旬の 10 日まで・半分までの 15 日）には公用の決まりが無く、` +
          `画面は勝手に絞りません。初めの 10 日を打つ（「9月上旬」）・中旬を打つ（「9月中旬」）・其の日を打つ（「1日」「5日」）が出来ます`,
        `「${文}」では絞れません –「上旬」「中旬」か其の日で打ってください`,
      );
    }

    const 幅の頭Ja =
      "(?:今日|本日|明日|明後日|あさって|昨日|きのう|一昨日|年内|年度内|年度末|年度初め|年度始め|土曜日|日曜日|平日|今週|こんしゅう|来週|らいしゅう|翌週|再来週|先週|先々週|週末|今週末|来週末|今月|来月|再来月|先月|今年|来年|年末|年始|年明け|月末|[0-9]{1,2}月|[0-9]{1,2}月[0-9]{1,2}日|[0-9]{1,4}年)";
    /* 「もの」「やつ」は訪ねる人が**それ**と呼ぶ物の名前言う – 表の欄の名前では無い。
     * ただし『もの』の単体は検索側が既に剥ぐ（実測 `今日のもの` 2 行・`明日のもの` 4 行・
     * `年内のもの` 779 行）のでここで斷ると勸めが噓になる – 「ものだけ」の形だけが 0 行
     * （検索側は『だけ』までを剥がない – `今日のものだけ` 0 行）。*/
    const 指し名のかたちJa = new RegExp(
      "^" +
        幅の頭Ja +
        "(?:の)?(?:中)?(?:の|に)?(?:(?:やつ|奴|分|方)(?:だけ|しか)?|もの(?:だけ|しか)|うちに|うち|時点|(?:開か|含ま|行わ|催さ)れる)$",
    );

    const 判定のかたちJa = new RegExp(
      "^" +
        幅の頭Ja +
        "(?:(?:までの?|中の?|中に)(?:の)?(?:締切|期限)?(?:だけ|しか)" +
        "|(?:までの?|中の?|中に|を|が)?(?:に)?(?:間に合う|間に合います|終わる|過ぎた|すぎた|過ぎ|切れた|きれた|いつ)(?:の)?(?:(?:やつ|もの|奴)?))$",
    );

    const 過ぎた話Ja =
      /(?:^(?:昨日|きのう|一昨日|先週|先々週|先月|去年))|(?:過ぎた|すぎた|過ぎ|切れた|きれた)(?:やつ|もの|奴)?$/;
    if (指し名のかたちJa.test(文)) {
      return 選ぶ(
        ` 「${文}」のことなら、幅の語（「今週」「来月」）を単体で、` +
          `または其の幅で見たい欄の名前を添えて（「今週 締切」）打ってください – ` +
          `「やつ」「もの」に限らず「うちに」「開かれる」「時点」で閉じられても、締切の日の事か催し物の日の事か別な欄の事か決まりません。` +
          `幅の語その物は解けますので、其の方を単体で打てば絞れます` +
          (過ぎた話Ja.test(文)
            ? ` – 過ぎた日の締切は既定で画面に出ませんので、「過去の締切も表示」を付けてください`
            : ""),
        `「${文}」では絞れません – 後に添へた語が何の事か決まりません。幅の語を単体で、または「今週 締切」で`,
      );
    }
    if (判定のかたちJa.test(文)) {
      return 選ぶ(
        ` 「${文}」は其れより前か後かの話で、いつまで・いつからかの幅が決まりませんので` +
          `解けません（表側で勝手に幅を作りません – 第 344 回）。幅の語だけで「年内」「来週」` +
          `のように打つか、締切日からの日数で絞る「締切まで」の選択欄（7・30・90・180 日以内）で` +
          `幅を決めてください` +
          (過ぎた話Ja.test(文)
            ? ` – 過ぎた日の締切は既定で画面に出ませんので、「過去の締切も表示」を付けてください`
            : ""),
        `「${文}」では絞れません – 前か後かの話では幅が決まりません。幅の語だけで、または「締切まで」の欄で`,
      );
    }

    /* 尾は**収録が語として持たん段取りの名前**に限る – `募集` `提出` `投稿` `締切` `締切り`
     * `デッドライン` は行の原文に出る語なので、繋げた打ち手も行が出る（実測 –
     * `ワークショップ締切` 147 行・`デモ締切り` 9 行・`抄録提出` 2 行）。そこで「収録に無い」
     * と言へば噓の門になる（第 337・358 回 – 検査三本がそこを張つている）。*/
    const 手続きの尾Ja =
      /(?:期限|募集要項|要項|応募|案内|原稿|作成|準備|執筆|規格|サイズ|フォーマット|テンプレート|規約|規定|提出物)$/;
    const 催し物の頭Ja =
      /^(?:ポスター|デモ|チュートリアル|ワークショップ|セッション|トラック|パネル|講演|招待講演|招待セッション|特別セッション|一般講演|抄録|アブストラクト|論文|短文|レター|査読|報告|記録|特集号|特集セッション|研究発表会|シンポジウム|研究会|会議)/;

    if (
      !打ち替えが在るか &&
      文.length >= 4 &&
      文.length <= 24 &&
      !/[\s、，,。]/.test(文) &&
      !/(?:と|や|及び|および)/.test(文) &&
      催し物の頭Ja.test(文) &&
      手続きの尾Ja.test(文) &&
      /* 尾だけで立つ語（`投稿` `登録` `応募`）は羣の方が正しく答えるので讓す。 */
      文.replace(手続きの尾Ja, "").length >= 2
    ) {
      return 選ぶ(
        ` 「${文}」では絞れません。この表は催し物ごとの手続き（応募・提出・準備の段取り）を書く欄が無く、` +
          `収録するのは締切の日と種別だけです。催し物の名前は行の原文に出るのでその語で当たり、` +
          `締切の種類は種別その物の語（『論文締切』『概要締切』『採否通知』『カメラレディ』『登録締切』）で打ってください`,
        `「${文}」では絞れません – 手続きの欄は無く、締切は種別の語で打ってください`,
      );
    }

    const 行に書かれん催し物の頭Ja =
      /^(?:講演|報告|記録|短文|レター|パネル|トラック|研究発表会|特別講演|一般討論)/;
    /* 尾の十種 – 上の決まり（頭の語は行に出ん物だけ・他家と重なる四種）はここも同じ。
     * 二つの家はどちらも 0 件で斷るだけなので重なつても噓にならん（`パネル募集`）。*/
    const 繋がれた尾Ja = /(?:募集|提出|投稿|登録|期限|案内|応募|締切り|締切|デッドライン)$/;
    if (
      !打ち替えが在るか &&
      文.length >= 4 &&
      文.length <= 24 &&
      行に書かれん催し物の頭Ja.test(文) &&
      繋がれた尾Ja.test(文)
    ) {
      const 前 = 文.replace(繋がれた尾Ja, "");
      return 選ぶ(
        ` 「${文}」のやうに二つの語を繋げて打つと、その繋ぎ方で行の原文に書かれて居る物だけになります。` +
          `語を空格で離して「${前} ${文.match(繋がれた尾Ja) || ""}」のように打つと同じ意味で広く` +
          `当たります（繋げて書かれた行も含みます）。それでも 0 行の時は、「${前}」といふ名前この物が` +
          `この表の行に書かれて居ません – 収録するのは会の名前・締切の日・種別・分野・等級・開催地・` +
          `参加形式なので、催し物の名前の代は分野名か会の名前で打つと絞れます`,
        `「${文}」では繋がれた行だけになります – 語を空格で離すと同じ意味で広く当たります`,
      );
    }

    if (
      !打ち替えが在るか &&
      文.length >= 17 &&
      文.length <= 60 &&
      !/\s/.test(文) &&
      /[ぁ-ん]/.test(文) &&
      /(?:か|は|の|？|\?)$|知りたい|教えて|ほしい|欲しい/.test(文)
    ) {
      return 選ぶ(
        ` 「${文}」のやうな長い文のままでは絞れません。この欄は語を受けますので、` +
          `見たい物の語だけを取り出して空格で並べて打ってください（例: \`セキュリティ 2027年\`）` +
          ` – 文の中で絞れる語が有れば、其れ単体でも当たります`,
        `長い文では絞れません。語だけを取り出して空格で並べて打ってください`,
      );
    }
    return "";
  }

  function uiWordNoteJa(query: unknown, 打ち替えが在るか?: boolean): string {
    const 文 = String(query == null ? "" : query).trim();

    const 週の明けのかたちJa =
      /^(?:(?:今|来|再々?|先)?週明け(?:締切)?)(?:頃|ころ|ごろ|辺り|あたり)(?:に)?\s*(?:でした|ですか|でしょうか|でしょう|でしたね|ですよ|ですね|です|だよ|かな)?$/;
    if (週の明けのかたちJa.test(文)) {
      return (
        ` 「${文}」では絞れません。週の明けという言い方は、月曜日を指す人もあれば` +
        `週の初めの日々を指す人もいるので、寄せられません。位を足しても其れは決まりません。` +
        `曜日（「月曜」「金曜」）や「今週」「来週」で絞ってください`
      );
    }

    if (!uiWordExact(文)) {
      const 祝日のかたちJa = /^(?:[0-9]{1,2}|二|三|四|五|六|七)?連休(?:明け|中日|初日|最終日)?$/;
      const 祝語の付き方Ja =
        /^(?:GW|ゴールデンウィーク|シルバーウィーク|大型連休|お盆|盆|年末年始|正月|祝日|祝祭日|振替休日|代替休日)(?:明け|前|中)?$/;
      if (祝日のかたちJa.test(文) || 祝語の付き方Ja.test(文)) {
        return (
          ` 「${文}」のように祝日・休日の名前で打たれても絞り込めません – この表は祝日・休日（振替休日・お盆・年末年始など）の情報を収録しておらず、` +
          `締切日が休みと重なるかどうかも分かりません。代わりに曜日（「土日」「平日」）や日付（「9月22日」「2026-09-22」）で絞ってください`
        );
      }
    }

    const hit = uiWordEntry(query);
    if (!hit) return uiWordShapeNoteJa(query, false, 打ち替えが在るか);
    if (!hit.echo) return ` ${hit.note}`;
    const word = uiWordRawJa(query);
    if (hit.quiet && hit.quiet.indexOf(word) >= 0) return ` ${hit.noteQuiet || hit.note}`;
    return ` 「${打たれた表記Ja(query, word)}」${hit.note}`;
  }

  /** 当たりが行にあるかに関わらず件数欄に出す一文（`always` を置いた語 – 第 323 回）。 */
  function uiWordAlwaysNoteJa(query: unknown): string {
    const hit = uiWordEntry(query);
    if (!hit?.always) return "";
    return uiWordNoteJa(query);
  }

  function 漢の数字に直すJa(語: string): string | null {
    const 一の位まで = "一二三四五六七八九";
    const 一字ずつ = new Map([
      ["〇", "0"],
      ["一", "1"],
      ["二", "2"],
      ["三", "3"],
      ["四", "4"],
      ["五", "5"],
      ["六", "6"],
      ["七", "7"],
      ["八", "8"],
      ["九", "9"],
    ]);
    if (!/^[〇一二三四五六七八九十]{1,4}$/.test(語)) return null;
    /* `二〇二六` のように『〇』で書く打ち方は一字ずつ数字に読む。 */
    if (語.includes("〇")) {
      if (!/^[〇一二三四五六七八九]+$/.test(語)) return null;
      return [...語].map((字) => 一字ずつ.get(字) ?? "").join("");
    }
    const 十の位置 = 語.indexOf("十");
    if (十の位置 < 0) {
      return 語.length === 1 ? String(一の位まで.indexOf(語) + 1) : null;
    }
    const 前 = 語.slice(0, 十の位置);
    const 後 = 語.slice(十の位置 + 1);
    if (前.length > 1 || 後.length > 1) return null;
    const 十の位 = 前 ? 一の位まで.indexOf(前) + 1 : 1;
    if (前 && 十の位 < 1) return null;
    const 一の位 = 後 ? 一の位まで.indexOf(後) + 1 : 0;
    /* 十の位の上に『〇』を添える書き方（`十〇`）は受けない – その方は「一〇」で打たれる。 */
    if (後 && (一の位 < 1 || 後 === "〇")) return null;
    return String(十の位 * 10 + 一の位);
  }

  const DAY_RANGE_DAYS = /^(\d{1,4})(?:日間)?以内$/;
  const DAY_RANGE_UNIT = /^(\d{1,3})(.+?)以内$/;

  const 幅の漢数字 =
    /([〇一二三四五六七八九十]{1,4})(?=(?:日間|日にち|日|にち|週間|しゅうかん|週|か月|ヶ月|カ月|ケ月|ヶ月|か年|年間|年))/g;
  /** 幅の数えの漢数字を算用数字に寄せる。 */
  function 幅の漢数字を寄せるJa(文: string): string {
    return 文.replace(幅の漢数字, (全部: string, 数: string) => {
      const 数字 = 漢の数字に直すJa(数);
      return 数字 === null ? 全部 : 数字;
    });
  }

  const 数えの幅Ja =
    /^([0-9]{1,3})(日間|日にち|日|にち|週間|しゅうかん|週|か月|ヶ月|カ月|ケ月|ヶ月|か年|年間|年)$/;
  const DAY_RANGE_UNIT_JA: Record<string, number> = {
    日: 1,
    日間: 1,
    週間: 7,
    しゅうかん: 7,
    週: 7,
    か月: 30,
    カ月: 30,
    ヶ月: 30,
    ケ月: 30,
    か年: 365,
    ケ年: 365,
    年間: 365,
    年: 365,
  };
  /* 選択欄の実在する選択肢（テンプレートの `<select id="win">` と揃える – 画面に無い値を
   * 案内しない）。 */
  const WIN_LIMITS_JA: Array<[number, number]> = [
    [7, 7],
    [30, 30],
    [90, 90],
    [180, 180],
  ];

  /** 日数の範囲の言い方から日数を求める。該当しなければ null。
   * 全角数字は NFKC で半角に折る（`１か月以内` で打つ人もいる – 検索の正規化と同じ折方）。 */
  function dayRangeDaysJa(query: unknown): number | null {
    const raw = typeof query === "string" ? query : query == null ? "" : String(query);
    /* 空格（全角空格を含む）を詰めてか… – 実測と理由は第 723 回に SPEC へ送つた。*/
    const normalized = (typeof raw.normalize === "function" ? raw.normalize("NFKC") : raw)
      .trim()
      .replace(/\s+/g, "");
    if (!normalized) return null;

    if (HOUR_RANGE_JA.test(normalized)) return 時間数から日数Ja(normalized);

    const 幅の文 = 幅の漢数字を寄せるJa(normalized);

    /*片仮名まじりの表記（`半ケ月` `半ヶ月` `半ヵ月`）も同じ – （実測） `半月`
     * `半月以内` は「15 日として読む」案内が出るのに、`半ケ月` `半ヶ月` は 0 行で案内も無かつた
     * （NFKC はヶとヶをケに折らない – 実測で `半ヶ月` → `半ヶ月` の侭）。*/
    if (
      /^(?:半月|半か月|半ヶ月|半カ月|半ケ月|半ヵ月|半ヶ月|半月間|半か月間)(?:以内)?$/.test(幅の文)
    )
      return 15;

    const か月半Ja = /^([0-9]{1,3})(?:か月|ヶ月|カ月|ケ月)半(?:以内)?$/.exec(幅の文);
    if (か月半Ja) {
      const 日数 = Number(か月半Ja[1]) * 30 + 15;
      return 日数 >= 1 && 日数 <= 3650 ? 日数 : null;
    }
    const 幅の言い方 =
      /^(?:今日から|(?:締切|締め切り|〆切|しめきり)までに?の?|(?:締切|締め切り|〆切|しめきり)から)\s*([0-9]{1,4})\s*(.+?)(?:以内)?$/.exec(
        幅の文,
      );
    if (幅の言い方) {
      const 一単位 = DAY_RANGE_UNIT_JA[幅の言い方[2] as string];
      if (一単位 === undefined) return null;
      const 日数 = Number(幅の言い方[1]) * 一単位;
      return 日数 >= 1 && 日数 <= 3650 ? 日数 : null;
    }
    const plain = DAY_RANGE_DAYS.exec(幅の文);
    if (plain) {
      const days = Number(plain[1]);
      return days >= 1 && days <= 3650 ? days : null;
    }
    const unit = DAY_RANGE_UNIT.exec(幅の文);
    if (!unit) return null;
    const per = DAY_RANGE_UNIT_JA[unit[2] as string];
    if (per === undefined) return null;
    const count = Number(unit[1]);
    return count >= 1 ? count * per : null;
  }

  /** 日数の範囲の言い方に対して、選択欄で選べる値 `[値, ラベル]` を返す。 */
  function dayRangeWindowJa(query: unknown): (number | string)[] | null {
    const days = dayRangeDaysJa(query);
    if (days === null) return null;
    const exact = WIN_LIMITS_JA.filter((limit) => limit[0] === days)[0];
    if (exact) return [exact[1], `${exact[0]} 日以内`, "same"];
    const near = WIN_LIMITS_JA.filter((limit) => limit[0] >= days)[0];
    if (near) return [near[1], `${near[0]} 日以内`, "near"];
    const longest = WIN_LIMITS_JA[WIN_LIMITS_JA.length - 1] as [number, number];
    return [longest[1], `${longest[0]} 日以内`, "cap"];
  }

  /** 画面側の案内（0 行のときに出す）。 */
  /* 「3 日前まで」「1 か月前まで」は、それより前の締切**すべて**を指す言い方で、いつまで遡るかが
   * 書かれていない（2026-10-23 実測 – 実ビルドの品書 872 行・同刻:
   * `3日前まで` `1週間前まで` `1か月前まで` `半年前まで` `2年前まで` は**すべて 0 行・案内も無し** –
   * 同じ日の `3日前` 3 行・`1か月前` 7 行は通る）。その方の行は既定で画面に出ない過ぎた締切なので
   * （『過去の締切も表示』で出る）、幅を開いて行を足す事はしない – 幅の終わりが無い物を
   * 推測して絞るのは締切の推測になる。その事をその場で書く。 */
  const PAST_RANGE_UNTIL_JA = /^(?:半年|[0-9]{1,4}(?:日間|日|週間|週|か月|ヶ月|カ月|年))前まで$/;

  function dayRangeNoteJa(query: unknown): string {
    const 打たれた形 = (typeof query === "string" ? query : query == null ? "" : String(query))
      .trim()
      .replace(/\s+/g, "");
    if (PAST_RANGE_UNTIL_JA.test(打たれた形)) {
      return (
        ` 「${打たれた形}」のことなら、其れより前の締切すべての事なので検索欄では絞り込まずに` +
        `います（いつまで遡るかが書かれていない幅です – 幅の終わりを推測して絞りません）。` +
        `其の範囲は過ぎています – 「過去の締切も表示」を付けると並びます。`
      );
    }
    const hit = dayRangeWindowJa(query);
    if (!hit) return "";
    /* 打たれた形をそのまま返す（全角数字でも利用者の入力した文字を書く – 件数欄の
     * 「検索語『X』」と同じ判断）。 */
    const word = (typeof query === "string" ? query : query == null ? "" : String(query)).trim();

    if (HOUR_RANGE_JA.test(打たれた形)) {
      /* 時間単位で打たれた人へ – 「7 日以内が近い」とは言わない（その方は 7 倍広い幅なので）。
       * 分数で打たれた人にも同じ話 – 打った単位の名前を書く。*/
      const 打った単位 = /分(?:間)?以内$/.test(打たれた形) ? "分数" : "時間";
      return (
        ` 「${word}」のことなら、この表は締切を日単位で持っている（時に持たない）ので、${打った単位}` +
        `単位では絞れません。締切が今日・明日の行は『1 日以内』で出て、其れより短い幅は出せません。`
      );
    }
    if (hit[2] === "same") {
      return (
        ` 「${word}」は検索語としては当たりません。締切日からの日数で絞る「締切まで」の` +
        `選択欄で「${hit[1]}」を選ぶと同じ話です（締切日で数え、会期では数えません）。`
      );
    }
    if (hit[2] === "near") {
      return (
        ` 「${word}」は検索語としては当たりません。締切日からの日数で絞る「締切まで」の` +
        `選択欄は 7・30・90・180 日以内で、いちばん近いのは「${hit[1]}」です` +
        `（締切日で数え、会期では数えません）。`
      );
    }
    return (
      ` 「${word}」は検索語としては当たりません。締切日からの日数で絞る「締切まで」の` +
      `選択欄でいちばん長いのは「${hit[1]}」です。それより先まで見るには条件を置かずに` +
      `一覧を出してください。`
    );
  }

  /** 読み上げ側の短い文（60 文字以内に収まる形で – 件数欄の読み上げは同じ場所に出る）。 */
  function dayRangeLiveNoteJa(query: unknown): string {
    const 打たれた形 = (typeof query === "string" ? query : query == null ? "" : String(query))
      .trim()
      .replace(/\s+/g, "");
    if (PAST_RANGE_UNTIL_JA.test(打たれた形)) {
      return " は幅が過去に開いているので絞りません – 「過去の締切も表示」を付けると並びます";
    }
    const hit = dayRangeWindowJa(query);
    if (!hit) return "";
    if (HOUR_RANGE_JA.test(打たれた形)) {
      return ` は曖昧な幅では絞れません – 締切は日単位（時に持たない）。『1 日以内』か「締切まで」の欄で`;
    }
    /* 打たれた形をそのまま返す（全角数字でも利用者の入力した文字を書く – 件数欄の
     * 「検索語『X』」と同じ判断）。 */
    const word = (typeof query === "string" ? query : query == null ? "" : String(query)).trim();
    if (hit[2] === "same") return `「${word}」は「締切まで」の ${hit[1]}で絞えます`;
    if (hit[2] === "near") return `「${word}」は「締切まで」の ${hit[1]}が近い`;
    return `「${word}」は「締切まで」は ${hit[1]}まで`;
  }

  /** 読み上げ側の短い文（同じ表から作る – 画面と読み上げが別のことを言わないようにする）。 */
  function uiWordLiveNoteJa(query: unknown, 打ち替えが在るか?: boolean): string {
    const hit = uiWordEntry(query);
    if (!hit) return uiWordShapeNoteJa(query, true, 打ち替えが在るか);
    if (!hit.echo) return hit.live;
    const word = uiWordRawJa(query);
    if (hit.quiet && hit.quiet.indexOf(word) >= 0) return hit.liveQuiet || hit.live;
    return `「${word}」${hit.live}`;
  }

  function queryNarrowHintJa(query: unknown): string {
    const q = String(query == null ? "" : query).trim();
    if (!q) return "";
    const tokens = queryTokens(q)
      .map((token) => String(token))
      .filter((token) => token.length > 0);
    if (!tokens.length) return "";
    // 数値だけ（`25`、`12 25`）。暦日の単位を付ければ日付で絞れる。
    if (tokens.every((token) => /^[0-9]{1,3}$/.test(token))) {
      return `数値だけでは締切日を絞れていません（\`${tokens[0]}\` は 2025 や 11月25日 に混なります）。\`${tokens[0]}日\`・\`8月\`・\`2027年\` のように単位を付けてください`;
    }
    // 1 文字だけ（`S`・`会`）。ほとんどの行が含むので 2 文字以上を求める。
    if (tokens.length === 1 && tokens[0].length === 1) {
      return "1 文字だけではほとんどの行に当たって絞れていません。`SC`・`関西`・`HCI` のように 2 文字以上で打ってください";
    }
    /* 打ち直しの例は、打たれた語その物を例に書かない（`セキュリティ` と打った人に
       「分野（`セキュリティ`）で絞れます」と言うのは役に立たない）。 */
    const 例: Array<[string, string]> = [
      ["会議名", "SC"],
      ["分野", "セキュリティ"],
      ["開催地", "パリ"],
      ["参加形式", "オンライン"],
    ];
    const 打った語 = q.toLowerCase();
    const 使える例 = 例.filter(([, 語]) => 打った語.indexOf(語.toLowerCase()) < 0);
    if (!使える例.length) {
      return "この検索語はどの行にも当たっていて、絞り込みにはなっていません。会議の略称など、もっと具体的な語を足してください";
    }
    return `この検索語はどの行にも当たっていて、絞り込みにはなっていません。${使える例
      .slice(0, 2)
      .map(([項目, 語]) => `${項目}（\`${語}\`）`)
      .join("・")}などの語を足してください`;
  }

  function querySynonymNotes(query: unknown): string[] {
    const map = querySynonymMap();
    const notes: string[] = [];

    {
      const 打たれた検索語 = String(query ?? "");
      const 寄せた検索語 = String(collapseRelativeDayPhrase(打たれた検索語));
      if (打たれた検索語 !== 寄せた検索語 && /延長|延伸/.test(寄せた検索語)) {
        const 語 =
          queryTokens(打たれた検索語).find((語) => /延長|延伸/.test(String(語))) || 打たれた検索語;
        notes.push(
          `「${語}」は収録が締切の延伸に書く『延長』という語で探しています（締切日その物で絞るなら上の『締切まで』の欄が確かです）`,
        );
      }

      if (
        打たれた検索語 !== 寄せた検索語 &&
        /(?:^|\s)締切/.test(寄せた検索語) &&
        /締め|締切|〆|しめきり/.test(打たれた検索語) &&
        /* `締切未定` のような形は下の『未定』の案内が書く – こちらを出すと「期間の語」と
         * 誤った名前で呼ぶ。 */
        !/未定/.test(打たれた検索語)
      ) {
        const 語 =
          queryTokens(打たれた検索語).find((語) => /締め|締切|〆|しめきり/.test(String(語))) ||
          打たれた検索語;
        /* 名指す期間の語は**書き換え後**から取る（`3月末締め` で実際に照るのは `3月` –
         * 打たれた形をそのまま書くと、探していない語を画面に書く）。 */
        const 前の語 = 寄せた検索語.split(/\s+/).filter((語) => 語 && 語 !== "締切")[0] || 語;
        notes.push(
          `「${語}」は「${前の語}」と「締切」に分けて探しています（期間の語と『締切』の両方が書かれた行です – 締切日その物で絞るなら上の『締切まで』の欄が確かです）`,
        );
      }
      /* 「8月22日まで」「今月いっぱい」を期間の語に直した事も書く（黙って語を落とさない – 同じ決まり）。
       * 期間の語側の規則が既に受ける形（`明日まで` `来週まで` – 日付の範囲に解く）には出さない
       * – そちらはその側の案内が既に日付を書いている。 */
      const までの語 =
        /((?:[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}|[0-9]{1,2}[-/][0-9]{1,2}|[0-9]{1,2}月[0-9]{1,2}日|[〇一二三四五六七八九十]{1,4}月[〇一二三四五六七八九十]{1,4}日|[〇一二三四五六七八九十]{1,4}月末?|(?:0?[1-9]|1[0-2])月末?|(?:今週|来週|再来週|先週)?[月火水木金土日]曜(?:日)?|(?:今週|来週|再来週|先週)?週末|平日|今月|来月|再来月|先月|今週|来週|再来週|先週|今年|来年))(?:まで|いっぱい)/.exec(
          打たれた検索語,
        );
      if (までの語 && 打たれた検索語 !== 寄せた検索語 && !/(?:まで|いっぱい)/.test(寄せた検索語)) {
        const 照らす語 = 寄せた検索語.split(/\s+/).filter((語) => 語)[0];

        const 頭の形 = までの語 ? String(collapseRelativeDayPhrase(までの語[0])).trim() : "";
        if (照らす語 === までの語[1] || (頭の形 && 照らす語 === 頭の形)) {
          notes.push(
            `「${までの語[0]}」は「${照らす語}」の締切として探しています（締切の日その物で絞るなら上の『締切まで』の欄が確かです）`,
          );
        }
      }
      /* 「締切未定」を二語に直し、「期限未定」を『未定』に寄せる判断もその場で書く。収録に
       * 『期限』も『日付』の語も無い事を伏せた侭行の壁にしない。 */
      const 未定の語 = /((?:締切|締切り|締め|しめきり|〆切|〆|期限|日付)未定)/.exec(打たれた検索語);
      if (
        未定の語 &&
        打たれた検索語 !== 寄せた検索語 &&
        /(?:^|\s)未定(?:\s|$)/.test(` ${寄せた検索語} `)
      ) {
        const 落とした語 = 未定の語[1].slice(0, -2);
        const 両方 = /(?:^|\s)締切(?:\s|$)/.test(` ${寄せた検索語} `);
        notes.push(
          両方
            ? `「${未定の語[1]}」は「締切」と「未定」の両方が書かれた行を探しています（締切の日が決まっていないと書かれた行です – 収録に『未定』と書く行は少ないので、日付で探すなら上の『締切まで』の欄が確かです）`
            : `「${未定の語[1]}」は「未定」と書かれた行を探しています（この収録には「${落とした語}」の語が無いので落としました – 締切の日が決まっていない行の事です）`,
        );
      }
    }

    {
      const tokens = queryTokens(query);
      const whole = WHOLE_TABLE_QUERY_JA.map((word) => kanaFold(word));
      const dropped = tokens.filter((token) => whole.indexOf(kanaFold(token)) >= 0);
      const kept = tokens.filter((token) => whole.indexOf(kanaFold(token)) < 0);
      if (dropped.length && kept.length) {
        const note =
          `「${打たれた表記Ja(query, dropped[0])}」はこの表の全行にあてはまる語なので絞り込みには使わず、` +
          `他の語（${kept
            .slice(0, 2)
            .map((token) => `「${打たれた表記Ja(query, token)}」`)
            .join("・")}）で探しています`;
        notes.push(note);
      }
    }

    /* 照合には小文字化した形を使い、人に見せる例は画面と同じ大文字のままする
     * （`rankGradeOrderJa()` の並びは画面の選択欄と同じなので、例もそこから取る）。 */
    const labelWords = ["ランク", "評価", "類", "クラス"]; // `クラス` は第 640 回 – 品書に加へた語
    const gradeWordsShown = rankGradeOrderJa().map((grade) => String(grade));
    const gradeWords = gradeWordsShown.map((grade) => grade.toLowerCase());
    const queryForms = queryTokens(query).map((token) => kanaFold(String(token)));
    queryTokens(query).forEach((token) => {
      const hit = map[kanaFold(token)];
      if (hit) {
        const note = `「${打たれた表記Ja(query, token)}」は${hit[0]}で探しています`;
        if (notes.indexOf(note) < 0) notes.push(note);

        const ZONE_QUERY_WORDS_JA: Array<[string[], string]> = [
          [["日本時間", "日本標準時", "日本標準時間"], "JST"],
          [["世界標準時", "協定世界時", "グリニッジ標準時", "グリニッジ平均時"], "UTC・GMT"],
        ];
        let 範囲 = "";
        ZONE_QUERY_WORDS_JA.forEach(([語列表, 先]) => {
          if (語列表.map((語) => kanaFold(語)).indexOf(kanaFold(token)) >= 0) {
            範囲 =
              先 === "JST"
                ? "行に書かれた時刻を変換はしません – JST は時刻の書いてある行に付く表記なので、『日本時間』は時刻が書かれた行と同じ出方になります（AoE・UTC の行も含みます）"
                : "行に書かれた時刻を変換はしません – UTC・GMT と書かれた行を受けました（AoE と書かれた行もこの含みです）";
          }
        });
        if (範囲 && notes.indexOf(範囲) < 0) notes.push(範囲);
      }
      // 地域まとめ（`ヨーロッパ` → 欧州の国名）と地方まとめ（`関東` → 都道府県と都市名）は
      // 当たり行が一桁増えるので、広げた先を書く。
      const foldedToken = kanaFold(token);
      const matches = (entry: string[]) =>
        kanaFold(entry[0]) === foldedToken || kanaFold(entry[1]) === foldedToken;
      const continent = CONTINENT_READINGS.filter(matches);
      const region = continent.length ? continent : REGION_READINGS.filter(matches);
      if (region.length) {
        const members = regionEntryMembers(region[0]);
        // 地方は都道府県だけでは届かない（開催市だけ書かれた行がある）ので、
        // 展開した先の実態を語列表に書く。構成員が 1 つのときに「など」は付けない。
        const label = continent.length
          ? "地域まとめ"
          : REGION_ALSO_JA[region[0][0]] || "地方の都道府県と開催市";
        const where =
          members.length > 2
            ? `${members.slice(0, 2).join("・")} など ${members.length} か所の表記`
            : members.join("・") || "この表記";
        const note = `「${打たれた表記Ja(query, token)}」は${label}（${where}）で探しています`;
        if (notes.indexOf(note) < 0) notes.push(note);
        /* 海外は「収録の国名から導いた」まとめなので、届かない行の範囲も書く –
         * 639 行が出ると 0 行が見えないと、無い物を無いと言えない。 */
        if (OVERSEAS_HEADS_JA.indexOf(region[0][0]) >= 0) {
          const 範囲の案内 = `「${打たれた表記Ja(query, token)}」${OVERSEAS_COVERAGE_NOTE_TAIL_JA}`;
          if (notes.indexOf(範囲の案内) < 0) notes.push(範囲の案内);
        }
        // これ以上の説明は付けない。
        return;
      }
      // 主題のことばを英語表記の会議名へ広げたときも同じ。分野・主題の寄せ説明が
      // 既に出ている語では二重になるので、そちらに譲る。
      const topic = (
        hit ? [] : TOPIC_QUERY_ALIASES_JA.filter((entry) => kanaFold(entry[0]) === foldedToken)
      )
        .map((entry) => String(entry[1]))
        // 長音の書き方が違う条目が同じ寄せ先にくると、同じ語を並べることになる
        // （`ユーザインタフェース` → 「user interface / user interface」）。1 つに束ねる。
        .filter((latin, index, all) => all.indexOf(latin) === index);
      if (topic.length) {
        const note = `「${token}」は英語で書かれた会議名（${topic.slice(0, 2).join(" / ")} など）も探しています`;
        if (notes.indexOf(note) < 0) notes.push(note);
      }

      const 略語の綴り = hit
        ? []
        : TOPIC_ABBREVIATIONS_EN.filter((entry) => kanaFold(entry[0]) === foldedToken).map(
            (entry) => String(entry[1]),
          );
      if (略語の綴り.length) {
        const note = `「${打たれた表記Ja(query, token)}」は ${略語の綴り.join(" / ")} の略として同じ意味の行を探しています`;
        if (notes.indexOf(note) < 0) notes.push(note);
      }
      /* 開催地の寄せで、**1 つの日本語が複数の英文字表記に広がるとき**だけ書く
       * （`バリ` → `bari`（イタリア）と `bali`（インドネシア））。違う場所を足して
       * いるので、おしらせがないと「なぜこの行が出たか」が画面のどこにも出ない
       * （行の開催地は公式の英文字表記のまま残る）。
       * 1 とおりの寄せ（`クラクフ` → `krakow`）は精密に引けているので付けない ——
       * 地域まとめの検査が「精密に引ける語には付けない」と見ていて、同じ規則にする。
       * 表示側で日本語に寄せる語（国名など）も書かない（画面に既に日本語で出る）。 */
      const place = PLACE_QUERY_ALIASES_JA.filter(
        (entry) =>
          kanaFold(entry[0]) === foldedToken &&
          !displayedPlaceTerms().has(String(entry[1]).toLowerCase()),
      )
        .map((entry) => String(entry[1]))
        .filter((latin, index, all) => all.indexOf(latin) === index);
      if (place.length > 1) {
        const note = `「${token}」は同じ書き方の場所が複数あります（英語で書かれた開催地 ${place
          .slice(0, 3)
          .join(" / ")}${place.length > 3 ? " など" : ""}）`;
        if (notes.indexOf(note) < 0) notes.push(note);
      }
      const parts = ABBREV_YEAR_TOKEN.exec(token);
      if (parts) {
        const digits = parts[2];
        const year = digits.length === 2 ? `20${digits}` : digits;
        const note = `「${token}」は「${parts[1]}」と「${year}」に分けて探しています`;
        if (notes.indexOf(note) < 0) notes.push(note);
      }
    });
    /* 等級の語が混ざっていないのに、画面が等級を呼ぶ語だけを打った場合。 */

    const 等級語の目 = ["ランク", "評価", "類", "クラス"].map((語) => kanaFold(語)).join("|");
    const 等級を名乗る形 = (形: string) =>
      new RegExp(`^(?:[a-c]\\*?(?:${等級語の目})|(?:${等級語の目})[a-c]\\*?)$`).test(形);
    const graded = queryForms.some(
      (form) =>
        gradeWords.indexOf(form) >= 0 ||
        等級を名乗る形(form) ||
        form.indexOf("ccf") === 0 ||
        form.indexOf("core") === 0 ||
        form.indexOf("thcpl") === 0,
    );
    const bareLabel = labelWords.find((word) => queryForms.indexOf(kanaFold(word)) >= 0);
    if (bareLabel && !graded) {
      notes.push(
        `「${bareLabel}」だけでは等級を絞れていません（${gradeWordsShown[0]}ランク のように等級の語をいっしょに入れてください）`,
      );
    }
    return notes;
  }

  /* 相対日・相対週を解決したら、件数欄に解決結果を書く（相対月と同じ方針）。
   * 黙って条件が変わったように見えると、自分が何を見たのか分からなくなる。 */
  function relativeDayNotes(query: unknown, nowMs: number): string[] {
    const notes: string[] = [];
    query = String(query ?? "").replace(/([0-9０-９]{4})年の開催回/g, (shown) => {
      notes.push(`${shown} = 開催回の年で照合（開催日の年とは別）`);
      return " ";
    });

    const 解いた語: Array<{ 見せ: string; 解: string }> = [];

    const 語列 = queryTokens(collapseRelativeDayPhrase(query, nowMs), nowMs);
    let 次を飛ばす = false;
    /* 月の第何週の語を先頭から見て後ろに繋ぐ目が飛ばす語の数 */
    let 週を飛ばす = 0;
    語列.forEach((token, 番) => {
      if (次を飛ばす) {
        次を飛ばす = false;
        return;
      }
      if (週を飛ばす > 0) {
        週を飛ばす -= 1;
        return;
      }
      const 次 = (語列[番 + 1] as string) ?? "";
      const 前 = 解いた語[解いた語.length - 1];
      const 前々 = 解いた語[解いた語.length - 2];

      if (
        前 &&
        /^(?:午前|午後|ごぜん|ごご)$/.test(前.解) &&
        /^[0-9]{1,2}$/.test(token) &&
        clockTimeTermsJa(`${前.解}${token}${次}`) !== null
      ) {
        前.見せ = `${前.見せ} ${token} ${次}`;
        前.解 = `${前.解}${token}${次}`;
        次を飛ばす = true;
        return;
      }
      if (
        前 &&
        /^(?:(?:午前|午後|ごぜん|ごご))?[0-9]{1,2}$/.test(前.解) &&
        /^[時]/.test(token) &&
        clockTimeTermsJa(`${前.解}${token}`) !== null
      ) {
        前.見せ = `${前.見せ} ${token}`;
        前.解 = `${前.解}${token}`;
        return;
      }
      if (
        前 &&
        /^(?:午前|午後|ごぜん|ごご)$/.test(前.解) &&
        /^[0-9]{1,2}時(?:[0-9]{1,2}分|半)?$/.test(token) &&
        clockTimeTermsJa(`${前.解}${token}`) !== null
      ) {
        前.見せ = `${前.見せ} ${token}`;
        前.解 = `${前.解}${token}`;
        return;
      }
      if (
        前 &&
        /^(?:(?:午前|午後|ごぜん|ごご))?[0-9]{1,2}時(?:[0-9]{1,2}分)?$/.test(前.解) &&
        /^[0-9]{1,2}$/.test(token) &&
        /^[分]/.test(次) &&
        clockTimeTermsJa(`${前.解}${token}${次}`) !== null
      ) {
        前.見せ = `${前.見せ} ${token} ${次}`;
        前.解 = `${前.解}${token}${次}`;
        次を飛ばす = true;
        return;
      }
      if (
        前 &&
        /^(?:(?:午前|午後|ごぜん|ごご))?[0-9]{1,2}時$/.test(前.解) &&
        /^[0-9]{1,2}分$/.test(token) &&
        clockTimeTermsJa(`${前.解}${token}`) !== null
      ) {
        前.見せ = `${前.見せ} ${token}`;
        前.解 = `${前.解}${token}`;
        return;
      }

      {
        const 詰 = 相対日の寄せ形Ja(前 ? 前.解 : "", token, "");
        if (前 && 詰 !== "") {
          前.見せ = `${前.見せ} ${token}`;
          前.解 = 詰;
          return;
        }
      }
      if (
        前 &&
        /^(?:[0-9]+|[〇一二三四五六七八九十]{1,3}|半)$/.test(前.解) &&
        /^(?:か月|カ月|ヵ月|ヶ月|ケ月|箇月|年|日|月)$/.test(token) &&
        /^[後前]$/.test(次)
      ) {
        const 詰 = 相対日の寄せ形Ja(前.解, token, 次);
        if (詰 !== "") {
          前.見せ = `${前.見せ} ${token} ${次}`;
          前.解 = 詰;
          次を飛ばす = true;
          return;
        }
      }
      if (前 && monthPartRangeJa(`${前.解}${token}`, nowMs) !== null) {
        前.見せ = `${前.見せ} ${token}`;
        前.解 = `${前.解}${token}`;
        return;
      }

      if (
        前 &&
        幅の語尾の語Ja.test(token) &&
        幅の語尾を継いだ形が解けるJa(`${前.解}${token}`, nowMs)
      ) {
        前.見せ = `${前.見せ} ${token}`;
        前.解 = `${前.解}${token}`;
        return;
      }

      const 週目の窓 = 週の序数を寄せるJa(語列, 番);
      if (週目の窓) {
        let 見せ = (語列.slice(番, 番 + 週目の窓.飛 + 1) as string[]).join(" ");
        let 解 = 週目の窓.詰;
        週を飛ばす = 週目の窓.飛;

        const 月 = 解いた語[解いた語.length - 1];
        const 月の上 = 解いた語[解いた語.length - 2];

        const 月の解 = 月 ? `${月.解}${解}` : "";
        const 月の解の続き = 月 && 月の上 ? `${月の上.解}${月.解}${解}` : "";
        if (月 && monthPartRangeJa(月の解, nowMs) !== null) {
          見せ = `${月.見せ} ${見せ}`;
          解 = 月の解;
          解いた語.pop();
        } else if (月 && 月の上 && monthPartRangeJa(月の解の続き, nowMs) !== null) {
          見せ = `${月の上.見せ} ${月.見せ} ${見せ}`;
          解 = 月の解の続き;
          解いた語.pop();
          解いた語.pop();
        }
        解いた語.push({ 見せ, 解 });
        return;
      }

      if (前 && 前々 && 週的形状Ja.test(token)) {
        const 月の付いた週 = `${前々.解}${前.解}${token}`;
        if (monthPartRangeJa(月の付いた週, nowMs) !== null) {
          const 見せ = `${前々.見せ} ${前.見せ} ${token}`;
          解いた語.pop();
          解いた語.pop();
          解いた語.push({ 見せ, 解: 月の付いた週 });
          return;
        }
      }

      if (前 && 前々) {
        const 月の付いた塊 = `${前々.解}${前.解}${token}`;
        if (monthPartRangeJa(月の付いた塊, nowMs) !== null) {
          解いた語.push({ 見せ: `${前々.見せ} ${前.見せ} ${token}`, 解: 月の付いた塊 });
          return;
        }
      }
      解いた語.push({ 見せ: token, 解: token });
    });
    解いた語.forEach(({ 見せ: token, 解 }) => {
      const span = untilDayTermsJa(解 || token, nowMs) || fromTodayTermsJa(解 || token, nowMs);
      if (span) {
        const lastYmd = lastFullDateJa(span);
        if (lastYmd) {
          notes.push(spanNoteFromTodayJa(token, nowMs, lastYmd));
          return;
        }
      }
      /* 月を打たない裸の日の位付き（`3日あたり`）は毎月のその日に絞る – 十二個の内の一つ
       * だけで絞ったやうに書くと実物と嘘になる。 */
      const 裸日位 = /^([0-9]{1,2})日(?:頃|ころ|ごろ|辺り|あたり)$/.exec(token);
      if (裸日位 && Number(裸日位[1]) >= 1 && Number(裸日位[1]) <= 31) {
        notes.push(
          `${token} = 毎月${裸日位[1]}日の締切 – 「頃」「あたり」は幅にせず其の日だけで絞りました（他の月の其の日も含まれます）`,
        );
        return;
      }

      const 位の暦日 = 位の付いた日を暦日に解くJa(token, nowMs);
      if (位の暦日?.[0]) {
        const 刻 = /^([0-9]{4})年([0-9]{1,2})月([0-9]{1,2})日$/.exec(位の暦日[0]);
        const 曜 = 刻 ? weekdayJaFromDate(toIsoDate(位の暦日[0])) : "";
        notes.push(
          `${token} = ${位の暦日[0]}${曜 ? `(${曜})` : ""}の締切 – 「頃」「あたり」は幅にせず其の日だけで絞りました。前後の日もまとめるなら「8月8日から8月12日」のように幅で打ってください`,
        );
        return;
      }
      /* 和暦で打たれた時は、何年に直して探したかをその場で書く。 */
      const 和暦の解 = eraYearTermsJa(token);
      if (和暦の解) {
        const 解けた語 = 和暦の解.terms[0] || `${和暦の解.西暦}年`;
        notes.push(
          和暦の解.年度
            ? `${token} = ${和暦の解.西暦}年4月〜${和暦の解.西暦 + 1}年3月の締切 – 年度は 4 月始まりで、この表は締切を西暦でしか書いていないので西暦の月語に直して探しています`
            : `${token} = ${解けた語}の締切 – この表は締切を西暦でしか書いていないので、年号は西暦に直して探しています（年号と西暦の対応は暦の決まりです）`,
        );
        return;
      }
      /* 「今週金曜」のように週+曜日を繋げた形は、解けた 1 日を出す。 */
      const pressed = pressedWeekdayJa(token, nowMs) || pressedMonthDayJa(token, nowMs);
      if (pressed) {
        const 刻列表 = pressed
          .map((語) => /^([0-9]{4})年([0-9]{1,2})月([0-9]{1,2})日$/.exec(String(語)))
          .filter((刻): 刻 is RegExpExecArray => 刻 !== null);
        if (刻列表.length >= 1) {
          const 日付列表 = 刻列表.map((刻) => {
            const 日付 = `${刻[1]}年${刻[2]}月${刻[3]}日`;
            const 曜 = weekdayJaFromDate(toIsoDate(日付));
            return `${日付}${曜 ? `(${曜})` : ""}`;
          });
          const 過ぎている = 刻列表.every((刻) =>
            isPastJstDay([Number(刻[1]), Number(刻[2]), Number(刻[3])], nowMs),
          );
          notes.push(
            `${token} = ${日付列表.join("・")}の締切${日付列表.length > 1 ? " – 土曜・日曜に締まる物です（別の週の週末は含みません）" : ""}${
              過ぎている
                ? `（${日付列表.length > 1 ? "両日とも" : "その日は"}過ぎています – 「過去の締切も表示」を付けると並びます）`
                : ""
            }`,
          );
          return;
        }
      }
      /* 助詞が付きただけの形（`明日中に` `今週中に`）は表の形に寄せてから解く –
       * 案内は打たれた語のまま出す（見えているのはその語なので – 第 328 回）。 */

      const key = dateTokenStemJa(解 || token) || 解 || token;
      const dayOffset = RELATIVE_DAY_OFFSETS_JA[key];
      if (dayOffset !== undefined) {
        const ymd = offsetCalendarDay(nowMs, dayOffset);
        const iso = `${ymd[0]}-${String(ymd[1]).padStart(2, "0")}-${String(ymd[2]).padStart(2, "0")}`;
        const day = weekdayJaFromDate(iso);
        notes.push(`${token} = ${ymd[0]}年${ymd[1]}月${ymd[2]}日${day ? `(${day})` : ""}`);
        return;
      }
      const numeric = numericRelativeDay(key, nowMs);
      if (numeric) {
        const ymd = /^([0-9]{4})年([0-9]{1,2})月([0-9]{1,2})日$/.exec(numeric[1]);
        if (!ymd) return;
        const day = weekdayJaFromDate(toIsoDate(numeric[1]));
        notes.push(`${token} = ${ymd[1]}年${ymd[2]}月${ymd[3]}日${day ? `(${day})` : ""}`);
        return;
      }

      const halfYear = HALF_YEAR_JA.test(token);
      const withinKey = halfYear ? `${HALF_YEAR_DAYS_JA}日以内` : key;
      const within = withinDaysTermsJa(withinKey, nowMs);
      if (within) {
        const matched = /^([0-9]{1,4})日以内$/.exec(withinKey);
        const days = matched ? Number(matched[1]) : 0;
        if (days >= 1 && days <= 365) {
          const from = offsetCalendarDay(nowMs, 0);
          const to = offsetCalendarDay(nowMs, days);
          const first = `${from[0]}年${from[1]}月${from[2]}日`;
          const last = `${to[0]}年${to[1]}月${to[2]}日`;
          const firstDay = weekdayJaFromDate(toIsoDate(first));
          const lastDay = weekdayJaFromDate(toIsoDate(last));
          const tail =
            from[0] === to[0] ? `${to[1]}月${to[2]}日` : `${to[0]}年${to[1]}月${to[2]}日`;
          notes.push(
            `${token} = ${first}${firstDay ? `(${firstDay})` : ""}〜${tail}${lastDay ? `(${lastDay})` : ""}` +
              (halfYear
                ? " – 画面上の『180 日以内』を受けています（暦の半年は 180〜184 日なので、日数では少しずれます）"
                : " – 行に書かれた他の日付（別の締切ラウンド・会期）でも当たるので、締切日からの日数で絞る「締切まで」の欄が確かです"),
          );
          return;
        }
      }

      const 暦の幅 = /^([0-9]{1,3})(か月|ヶ月|ヵ月|ケ月|カ月|年)(?:以内)?$/.exec(token);
      if (暦の幅) {
        const 数 = Number(暦の幅[1]);
        const 単位 = 暦の幅[2];
        const 幅 = 単位 === "年" ? 365 : 30;
        const 日数 = 数 * 幅;
        notes.push(
          `${token} は暦の${単位}の幅で絞る欄がありません。画面上の『締切まで』の欄（『7 日以内』『30 日以内』『90 日以内』『180 日以内』）が締切日からの日数の幅です。` +
            (日数 <= 365
              ? `日数の語なら受けます（${数}${単位}はおおむね ${日数} 日 – 例: 『${日数}日以内』）。暦の${単位}は長さが一定でないので（1 か月なら 28〜31 日）、此の表はか月・年の打ち方を日数へ換えません`
              : `日数の語も 365 日までしか解きません（『366日以内』は 0 行）。1 年より長い幅は暦の年（例: 『来年』）で引いてください`),
        );
        return;
      }
      /* 「20時」「午後8時59分」は収録の時刻の表記に寄せた結果を出す。
       * 午後 → 24 時間表記の換算は打った人に見えないので、解けた形をそのまま書く。 */

      const clock = clockTimeTermsJa(解 || token);
      if (clock) {
        notes.push(
          `${token} = ${clock.解} の締切 – 収録の時刻は 24 時間表記（\`20:59\` のように時の頭を 0 埋め）で書かれています。${
            clock.帯
              ? "正午を境にしています（公の決まり）。時刻の収録が無い行は並びません"
              : clock.幅
                ? "冠の無い「N時」はその 1 時間ぶん（00 分〜59 分）を受けます"
                : "分まで打たれたときはその 1 点だけを見ます"
          }。タイムゾーン（JST・UTC・AoE）は行に書かれています`,
        );
        return;
      }
      /* 「20時59分までに」は“それ以前の時刻”という頼み方で、部分一致では作れない幅なので
       * 絞り込まず、確かでする欄を言う。 */
      const clockUntil = clockUntilQueryJa(token);
      if (clockUntil) {
        notes.push(
          `${token} = 時刻までで絞り込む事は検索欄では出来ません（収録は締切の日で並び、時刻は行に 24 時間表記で書かれています）。締切までの日数で絞るなら上の『締切まで』の欄が確かです – ${clockUntil} という時刻は行に書かれています`,
        );
        return;
      }

      const part = monthPartRangeJa(解 || key, nowMs);
      if (part) {
        const 初日 = `${part.year}年${part.month}月${part.from}日`;
        const 末日 = `${part.year}年${part.month}月${part.to}日`;
        const 初曜 = weekdayJaFromDate(toIsoDate(初日));
        const 末曜 = weekdayJaFromDate(toIsoDate(末日));
        const 過ぎ = isPastJstDay([part.year, part.month, part.to], nowMs)
          ? "（その範囲は過ぎています – 「過去の締切も表示」を付けると並びます）"
          : "";
        notes.push(
          `${token} = ${初日}${初曜 ? `(${初曜})` : ""}〜${末日}${
            末曜 ? `(${末曜})` : ""
          }の締切 – ${part.label}は月の ${part.from} 日から ${part.to} 日までです${
            part.label === "下旬"
              ? "（下旬は月末まで）"
              : /^第/.test(part.label)
                ? part.label === "第5週" || part.label === "第五週"
                  ? "（月はじめから 7 日ずつ数えます – 第5週は月末まで）"
                  : "（月はじめから 7 日ずつ数えます）"
                : ""
          }${過ぎ}`,
        );
        return;
      }
      /* 「今年度」「来年度中」は年度（4 月〜翌年 3 月）の幅で答える。
       * 年度跨ぎの相談がそのまま打てるように、初日と末日を曜日まで書く。 */
      const fiscalBase = fiscalYearBaseJa(key, nowMs);
      if (fiscalBase !== null) {
        const 初日 = `${fiscalBase}年4月1日`;
        const 末日 = `${fiscalBase + 1}年3月31日`;
        const 初曜 = weekdayJaFromDate(toIsoDate(初日));
        const 末曜 = weekdayJaFromDate(toIsoDate(末日));
        notes.push(
          `${token} = ${初日}${初曜 ? `(${初曜})` : ""}〜${末日}${
            末曜 ? `(${末曜})` : ""
          }の締切 – 年度は 4 月から翌年 3 月までです`,
        );
        return;
      }

      const 月數々 = [...String(query ?? "").matchAll(/[0-9]{1,2}月/g)].map((m) =>
        Number(m[0].replace("月", "")),
      );
      const 次の月數 = 月數々.length ? 月數々[月數々.length - 1] : Number.NaN;
      const 月で終わる =
        /(?:^|[^0-9])[0-9]{1,2}月(?:[\s\u3000]*(?:の|中|締切|開催|実施|会議|期限))*[\s\u3000]*$/.test(
          String(query ?? ""),
        );
      const 有月 = Number.isFinite(次の月數) && 次の月數 >= 1 && 次の月數 <= 12 && 月で終わる;
      const 數字の年 = /^([0-9]{4})年$/.exec(key);
      if (數字の年) {
        if (有月) {
          notes.push(
            `${token}${次の月數}月 = ${數字の年[1]}年${次の月數}月の締切（その月だけ – 年全体ではありません）`,
          );
          return;
        }
        notes.push(`${token} = ${數字の年[1]}年の締切（1〜12 か月）`);
        return;
      }
      const yearOffset = RELATIVE_YEAR_OFFSETS_JA[relativeYearKeyJa(key)];
      if (yearOffset !== undefined) {
        const base = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3_600_000);
        const 西暦 = base.getUTCFullYear() + yearOffset;
        /* `再来年3月` も**その月だけ** – 上と同じ。 */
        if (有月) {
          notes.push(
            `${token}${次の月數}月 = ${西暦}年${次の月數}月の締切（その月だけ – 年全体ではありません）`,
          );
          return;
        }
        notes.push(`${token} = ${西暦}年の締切（1〜12 か月）`);
        return;
      }
      /* 「明日以降」「来週から」は「それより後」の意味で、一日ぶんの語に寄せると嘘に
       * なる。なので絞り込まず、並び方と絞れる欄の場所を言う。 */

      const stem = より後を剥がす語Ja(解 || token);
      if (stem) {
        /* 初日は `その日以降の初日Ja` が決める – 検索の絞りも同じ関数を読む。*/
        let first = 其の日以降の初日Ja(解 || token, nowMs);
        /* 暦日を打ってそれより後と書いた形は上の機械が**絞る**ので、ここで「絞りません」と
         * 書くのは噓になる（件の数欄に解けた範囲が出る – 第 413 回）。 */
        if (暦日より後の語Ja(解 || token, nowMs).length) return;
        /* 暦に無い日を打たれた形（`2月30日以降`）はその日を日めくりの語に出来ないので、
         * その日を名乗る案内を書かない（在ら無い日を画面に出さない – 第 413 回）。 */
        if (first && 暦日に解くJa(first) === null) first = "";
        if (first) {
          notes.push(
            `${token} = ${first}以降のこと – 初期画面は締切の近い順に並んでいて、その以降の締切も並びます（締切までの日数で絞るなら上の『締切まで』の欄が確かです）`,
          );
          return;
        }

        const 年と暦月 = /^(.+?)((?:[0-9]{1,2}|[〇一二三四五六七八九十]{1,3})月)$/.exec(stem);
        if (年と暦月) {
          const 年の語 = String(年と暦月[1] || "");
          const 月の語 = String(年と暦月[2] || "");
          let 西暦: number | null = null;
          const 年番号 = /^([0-9]{4})年$/.exec(年の語);
          if (年番号) {
            西暦 = Number(年番号[1]);
          } else {
            const おまわり = RELATIVE_YEAR_OFFSETS_JA[relativeYearKeyJa(年の語)];
            if (typeof おまわり === "number") {
              const 基 = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3_600_000);
              西暦 = 基.getUTCFullYear() + おまわり;
            }
          }
          /* 漢数字の月（`今年一月から`）もその方の寄せを通してから数で見る。*/
          const 月数 = Number(幅の漢数字を寄せるJa(月の語).replace(/月$/, ""));
          if (西暦 !== null && Number.isFinite(月数) && 月数 >= 1 && 月数 <= 12) {
            const 但し書 = /^[0-9]{4}年$/.test(年の語)
              ? " – 其の年の締切が収録に無ければ何も出ません"
              : "";
            notes.push(
              `${token} = ${西暦}年${月数}月1日以降のこと（其の年の中まで）${但し書} – 初期画面は締切の近い順に並んでいて、その以降の締切も並びます（締切までの日数で絞るなら上の『締切まで』の欄が確かです）`,
            );
            return;
          }
        }

        if (
          日付らしき語Ja(stem) &&
          monthTokenToYearMonth(stem, nowMs) === null &&
          monthRangeTermsJa(stem, nowMs).length === 0
        ) {
          notes.push(
            `${token} = 其れより後の締切の事だと思いますが、前の語を此の表の日として探せないので検索欄では絞り込まずにいます（日の形に直して打ってください）。締切の近さで絞るなら上の『締切まで』の欄、過ぎた締切も見るなら『過去の締切も表示』が使えます`,
          );
          return;
        }
      }
      const week = weekDayTermsJa(key, nowMs);
      if (week.length === 7) {
        const first = week[0].split("年");
        const last = week[6].split("年");
        const firstIso = toIsoDate(week[0]);
        const lastIso = toIsoDate(week[6]);
        const head = `${first[0]}年${first[1]}`;
        const tail = first[0] === last[0] ? last[1] : `${last[0]}年${last[1]}`;
        notes.push(
          `${token} = ${head}(${weekdayJaFromDate(firstIso)})〜${tail}(${weekdayJaFromDate(lastIso)})`,
        );
      }
    });
    return notes;
  }

  /* 数の付いた日の言い方・曜日の語で… – 実測と理由は第 723 回に SPEC へ送つた。*/

  function 其の日以降の初日Ja(語: string, nowMs: number): string {
    const 芯 = より後を剥がす語Ja(String(語 || "")) || String(語 || "");
    if (!芯) return "";
    const dayOffset = RELATIVE_DAY_OFFSETS_JA[芯];
    if (dayOffset !== undefined) {
      const ymd = offsetCalendarDay(nowMs, dayOffset);
      return `${ymd[0]}年${ymd[1]}月${ymd[2]}日`;
    }
    const 週の語 = weekDayTermsJa(芯, nowMs);
    if (週の語.length === 7) return String(週の語[0] || "");
    const 旬 = monthPartRangeJa(芯, nowMs);
    if (旬 !== null) {
      const 塊 = 旬 as { year: number; month: number; from: number };
      return `${塊.year}年${塊.month}月${塊.from}日`;
    }
    const 年度 = fiscalYearBaseJa(芯, nowMs);
    if (年度 !== null) return `${年度}年4月1日`;
    if (芯 === "週末" || 芯 === "土日" || 芯 === "週末土日") {
      return 以降の初日Ja("今週末", nowMs);
    }
    const 年頃 = RELATIVE_YEAR_OFFSETS_JA[relativeYearKeyJa(芯)];
    if (年頃 !== undefined) {
      const baseNow = Number.isFinite(nowMs) ? nowMs : Date.now();
      const baseYear = new Date(baseNow + 9 * 3_600_000).getUTCFullYear();
      return `${baseYear + (年頃 as number)}年1月1日`;
    }
    return 以降の初日Ja(芯, nowMs);
  }

  function 以降の初日Ja(stem: string, nowMs: number): string {
    const 元 = String(collapseRelativeDayPhrase(stem) || "");
    const 数値 = numericRelativeDay(元, nowMs);
    if (数値) return String(数値[1] || "");
    /* `3日以降` `1週間以降` `1か月以降` – 単位だけの形はその方の単位ぶん後（後の語と
     * 同じ暦の動き方をするので、後の語に直して数値の相対日に読む – 月・年は日数に換えない）。 */
    const 単位だけ =
      /^([0-9]{1,4})日間?$/.test(元) ||
      /^([0-9]{1,2})(?:週間|週)$/.test(元) ||
      /^([0-9]{1,4})(?:か月|カ月|ヵ月|ヶ月|ケ月|箇月)$/.test(元) ||
      /^半年$/.test(元);
    if (単位だけ) {
      /* 単位の寄せ（`1週間後` → `7日後`）を挟んでから数値の相対日に読む – 週はその方が
       * 表にあるから（月・年は日数に換えない – 第 318 回の注と同じ）。 */
      const 後 = numericRelativeDay(String(collapseRelativeDayPhrase(`${元}後`)), nowMs);
      if (後) return String(後[1] || "");
    }
    const 曜日 = pressedWeekdayJa(元, nowMs) || pressedMonthDayJa(元, nowMs);
    if (曜日 && 曜日.length > 0) return String(曜日[0] || "");

    const 月日 = /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日$/.exec(元);
    if (月日) {
      const 月 = Number(月日[2]);
      const 日 = Number(月日[3]);
      if (月 >= 1 && 月 <= 12 && 日 >= 1 && 日 <= 31) {
        if (月日[1] !== undefined) return `${Number(月日[1])}年${月}月${日}日`;
        const 今 = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3_600_000);
        const 今年 = 今.getUTCFullYear();
        const 年 = isPastJstDay([今年, 月, 日], nowMs) ? 今年 + 1 : 今年;
        return `${年}年${月}月${日}日`;
      }
    }
    /* 月のまとまりの語（`来月末` `年度末`）はその月の末日 – 表の決まりと同じ読み方。 */
    const 月の対 = PERIOD_MONTH_WORDS_JA[元];
    if (月の対 !== undefined) {
      const 年月 = monthTokenToYearMonth(月の対, nowMs);
      if (年月) {
        /* 「末」の付く語はその月の末日、初めの付く語はその月の一日 – それ以外（`年内` など）は
         * 幅のはじまりなのでその月の一日（それより前を足さない – 幅の終わりは推測しない）。 */
        const 日 = /末$/.test(元) ? new Date(Date.UTC(年月[0], 年月[1], 0)).getUTCDate() : 1;
        return `${年月[0]}年${年月[1]}月${日}日`;
      }
    }
    const 暦日 = calendarDateGroups(元);
    if (暦日 && 暦日.length === 1) {
      const 付き = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(String(暦日[0] || ""));
      if (付き) return String(暦日[0] || "");
      const 年無し = /^(\d{1,2})月(\d{1,2})日$/.exec(String(暦日[0] || ""));
      if (年無し) {
        const 元日 = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3_600_000);
        const 今年 = 元日.getUTCFullYear();
        /* 過ぎた月日を打つ人は来年を見る – 月の範囲の言い方と同じ決まり。 */
        const 年 = isPastJstDay([今年, Number(年無し[1]), Number(年無し[2])], nowMs)
          ? 今年 + 1
          : 今年;
        return `${年}年${Number(年無し[1])}月${Number(年無し[2])}日`;
      }
    }
    return "";
  }

  /** 『から』『以降』の前に付く語が日付の言い方らしいか。 */
  function 日付らしき語Ja(stem: string): boolean {
    return /(?:[0-9]{1,4}|一|二|三|四|五|六|七|八|九|十|半)(?:日|日間|週|週間|か月|ヶ月|カ月|ケ月|箇月|年|旬|月末|末|曜日|月初)|[日月年週]初め|[日月年]始め|年度|末日|曜日|前|後|今週|来週|先週|毎週|来月|先月|今月|来年|今年|去年|明後日|明日|昨日|一昨日/.test(
      String(stem || ""),
    );
  }

  /** `2026年8月10日` の形の語を `2026-08-10` にする（曜日を引き出すため）。 */
  function toIsoDate(term: string): string {
    const parts = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(String(term || ""));
    if (!parts) return "";
    return `${parts[1]}-${parts[2].padStart(2, "0")}-${parts[3].padStart(2, "0")}`;
  }

  function withinDaysLimitMs(days: number, nowMs: number): number {
    return (Math.floor((nowMs + 9 * 3600000) / 86400000) + days + 1) * 86400000 - 9 * 3600000;
  }

  function withinDaysFloorMs(days: number, nowMs: number): number {
    return (Math.floor((nowMs + 9 * 3600000) / 86400000) - days) * 86400000 - 9 * 3600000;
  }

  function queryDaySpanJa(query: unknown): { first: string; last: string; label: string } | null {
    const text = String(query ?? "");
    if (!text) return null;
    const re = /(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?|(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/g;
    const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
    let first = "";
    let last = "";
    let label = "";
    let m: RegExpExecArray | null = re.exec(text);
    while (m) {
      const at = m.index;
      const before = at > 0 ? text.charAt(at - 1) : "";
      const after = text.charAt(at + m[0].length);
      /* 数字に貼り付いた一部分（品番・URL の末尾など）を日付として読まない。 */
      const glued = /[0-9]/.test(before) || (/[0-9-]/.test(after) && m[0].includes("-"));
      const year = Number.parseInt(m[1] || m[4] || "", 10);
      const month = Number.parseInt(m[2] || m[5] || "", 10);
      const dayText = m[3] || m[6] || "";
      if (!glued && year >= 1900 && year <= 2999 && month >= 1 && month <= 12) {
        // 月の末日は暦から求める（2 月 31 日を「その月の末尾」にしない）。
        const monthEnd = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const day = dayText ? Number.parseInt(dayText, 10) : 0;
        if (!dayText || (day >= 1 && day <= monthEnd)) {
          const lo = day ? `${year}-${pad(month)}-${pad(day)}` : `${year}-${pad(month)}-01`;
          const hi = day ? lo : `${year}-${pad(month)}-${pad(monthEnd)}`;
          if (!first || lo < first) first = lo;
          if (!last || hi > last) last = hi;
          if (!label) label = m[0];
        }
      }
      re.lastIndex = at + 1;
      m = re.exec(text);
    }
    return first && last && label ? { first, last, label } : null;
  }

  function categoryLabelJa(key: unknown): string {
    const k = typeof key === "string" ? key : "";
    return CATEGORY_LABELS_JA[k] || k;
  }

  function categoryChipLabelJa(key: unknown, enLabel: unknown): string {
    const k = typeof key === "string" ? key : "";
    const ja = categoryLabelJa(k);
    const en = typeof enLabel === "string" ? enLabel.trim() : "";
    if (!en || en.toLowerCase() === k.toLowerCase()) return ja;
    return `${ja}（${en}）`;
  }

  /* 分野名と国内区分は会議名に現れない。検索語（hay）に含めておかないと、
   * チップを知らない利用者は「ネットワーク」「国内」と打っても絞り込めない。 */
  function categorySearchTerms(
    cats: readonly string[] | null | undefined,
    tags: readonly string[] | null | undefined,
  ): string {
    const parts = [""];
    (cats || []).forEach((c) => {
      if (!c) return;
      parts.push(c);
      parts.push(CATEGORY_LABELS_JA[c] || "");
    });
    if (isDomesticTag(tags)) {
      parts.push(DOMESTIC_TAG_LABEL_JA);
      parts.push("domestic");
    }
    return parts.filter(Boolean).join(" ");
  }

  /* SPEC §7: 分野（categories）とは別に、会議には主題タグ (tags) が付く。
   * 200 会議が machine-learning や storage などのタグを持つのに検索語へ入れておらず、
   * 「機械学習」「ストレージ」「穴場」で引いても 0 件になっていた。
   * 対応表は実データに現れるタグだけを載せる（存在しない語を翻訳して作らない）。
   * 区切り（半角スペース / ハイフン）は吸収して引く（machine learning と machine-learning）。 */
  const TAG_LABELS_JA: Record<string, string> = {
    "computer-vision": "コンピュータビジョン",
    "computer-graphics": "コンピュータグラフィクス",
    "content-analysis": "コンテンツ解析",
    "data-mining": "データマイニング",
    "deep-learning": "ディープラーニング",
    discontinued: "掲載終了",
    dormant: "活動休止",
    fairness: "公平性",
    "human-computer-interaction": "人間情報処理",
    "image-processing": "画像処理",
    "information-retrieval": "情報検索",
    "information-systems": "情報システム",
    iot: "IoT",
    journal: "ジャーナル",
    "knowledge-representation": "知識表現",
    "knowledge-graphs": "ナレッジグラフ",
    "large-language-models": "大規模言語モデル",
    "lifelong-learning": "生涯学習",
    "machine-learning": "機械学習",
    mathematics: "数理",
    merged: "統合済み",
    "natural-language-processing": "自然言語処理",
    networking: "ネットワーク",
    niche: "穴場",
    "optimization-methods": "最適化",
    "pattern-recognition": "パターン認識",
    quantum: "量子",
    reasoning: "推論",
    recommendation: "推薦",
    "reinforcement-learning": "強化学習",
    "representation-learning": "表現学習",
    retrieval: "検索",
    robotics: "ロボティクス",
    security: "セキュリティ",
    "semantics-and-knowledge": "意味論と知識処理",
    "signal-processing": "信号処理",
    "software-engineering": "ソフトウェア工学",
    "special-issue": "特集号",
    speech: "音声",
    storage: "ストレージ",
    symposium: "シンポジウム",
    sysadmin: "運用管理",
    systems: "システム",
    "visual-information-processing": "視覚情報処理",
    "web-mining": "Web マイニング",
    "web-search": "ウェブ検索",
    workshop: "ワークショップ",
  };

  // 構造タグ（収録状態や国内区分）は主題として表示しても検索の助けにならない除外対象。
  const TAG_HIDDEN_FROM_UI = ["domestic-jp", "journal", "sensys", "virtual-execution"];

  /* 行に付ける「国内」の札。`domestic-jp` は**構造のタグ**なので主題の札の表
   * （`TAG_LABELS_JA`）には載せず、一覧は列の外に此の札を一つ出す（`app.ts`）。
   * AI（MCP の行）も同じ札を出すので、語の正本は此処に一つだけ置く – 寫すと
   * 畫面と AI で違ふ字面になる（實測 2026-10-16: 畫面は 38 行に「国内」を出して居たが、
   * MCP は行も結構化結果も國內を言はず、**日本で開催される國際会議**（CSFW 2027 の東京など）
   * と國內の學會を區別出来なかつた）。 */
  const DOMESTIC_TAG_LABEL_JA = "国内";

  /** 國內のタグを持つ行かを、畫面・CSV・MCP が同じ判定で見る。 */
  function isDomesticTag(tags: readonly string[] | null | undefined): boolean {
    return (tags || []).indexOf("domestic-jp") >= 0;
  }

  /** 行に付ける「国内」の札（國內で無い行は空）。 */
  function domesticTagLabelJa(tags: readonly string[] | null | undefined): string {
    return isDomesticTag(tags) ? DOMESTIC_TAG_LABEL_JA : "";
  }

  function tagKey(tag: unknown): string {
    const raw = typeof tag === "string" ? tag : "";
    return raw
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-");
  }

  function tagLabelJa(tag: unknown): string {
    return TAG_LABELS_JA[tagKey(tag)] || "";
  }

  /* 検索語には原文タグ・語に割った形・日本語表記の三れを入れる。
   * 「machine learning」を 2 語で打っても machine-learning に当たるようにするため、
   * ハイフンは空白にも置き換えておく。 */
  /* 詳細ドロワーに並べる主題タグ（日本語表記）。構造タグと、対応表に無い語は出さない。 */
  function topicTagsJa(tags: readonly string[] | null | undefined): string[] {
    const out: string[] = [];
    (tags || []).forEach((tag) => {
      if (!tag) return;
      if (TAG_HIDDEN_FROM_UI.indexOf(tagKey(tag)) >= 0) return;
      const label = tagLabelJa(tag);
      if (label && out.indexOf(label) < 0) out.push(label);
    });
    return out;
  }

  function tagSearchTerms(tags: readonly string[] | null | undefined): string {
    const parts: string[] = [];
    (tags || []).forEach((tag) => {
      if (!tag) return;
      parts.push(tag);
      parts.push(String(tag).replace(/[-_]+/g, " "));
      parts.push(tagLabelJa(tag));
    });
    return parts.filter(Boolean).join(" ");
  }

  /* SPEC §7: 絞り込んだ結果を丸ごと表計算に持ち出せるようにする。研究室内の予定表や
   * 経費申請の下書きに貼る用途が多く、ページングされた行だけを拾っても仕方がないため
   * 呼び出し側は絞り込み後の全行を渡す。
   * 列は日本語、文字コードは Excel が BOM 無しで読み替えると日本語が文字化けするため
   * 付け外しは呼び出し側（ダウンロード処理）に任せる。 */
  const CSV_HEADERS_JA = [
    "締切",
    "公式表記",
    // 数値を入れる列なので、単位を見出しに書く（「残り」だと文字列に見えて順を変えられない）。
    "残り日数",
    "会議",
    // 分野は画面では分野チップと行の詳細に出る語。絞り込みで使った次元が
    // 表計算側に無いと、分野ごとに並べ替えることができない（2026-09-23 時点の
    // 一覧は 7 列で分野列を持たないので、CSV だけに見出す意味がある）。
    "分野",
    "種別",
    "ラウンド",
    "CCF",
    "CORE",
    "THCPL",
    "会期",
    "開催地",
    "状態",
    "URL",
  ];

  function csvField(value: unknown): string {
    const raw = value == null ? "" : String(value);
    return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
  }

  function csvJstInstant(ms: number): string {
    const d = new Date(ms + 9 * 3600000);
    const p = (n: number) => (n < 10 ? `0${n}` : String(n));
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} JST(${CALENDAR_DATE_JA[d.getUTCDay()]})`;
  }

  /* AoE は UTC-12 の壁時計（§1）。一覧と同じ形を出す。 */
  function fmtAoEText(ms: number): string {
    const d = new Date(ms - 12 * 3600000);
    const p = (n: number) => (n < 10 ? `0${n}` : String(n));
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} AoE`;
  }

  /* 種別の日本語ラベルは下に持つ `… – 実測と理由は第 723 回に SPEC へ送つた。*/

  /* 表の種別セルと行の詳細に出す「第 N ラウンド」を、検索でも引けるようにする。
   * ラウンドの区別は画面ではこの書き方しかなく、CSV も `R1` `R2` と書いているのに、
   * 検索用の文字列に入れていなかったため、**画面に出ている語をそのまま打つと当たらない**
   * だった（2026-09-23 実測: 2 ラウンドの行は 387 件あるのに「R2」は 3 件、
   * 「第2」は 5 件）。画面に出る語は検索でも引ける、という規則をここで保つ。
   * 1 ラウンド目は画面に何も出さないが、CSV と並びの正本で `R1` を使っているので通す。
   * 半角スペースの有無は人の入力なので、両方の形をおく。 */

  const ROUND_LABELS_JA = [
    "第1ラウンド",
    "第2ラウンド",
    "第3ラウンド",
    "第4ラウンド",
    "第5ラウンド",
  ];

  function roundSearchTerms(round: unknown): string[] {
    const n = Number(round);
    if (!Number.isInteger(n) || n < 1) return [];
    const 語 = ROUND_LABELS_JA[n - 1] || `第${n}ラウンド`;
    return [語, `第 ${n} ラウンド`, `r${n}`];
  }

  /* 検索用の語は、行の詳細に並ぶ語も含める（一覧の印は確認済みを出さないが、
   * 行の詳細は「確認済み」と出す – 2026-08-09 生成ビルドで 25 行。画面に出る語が
   * 引けない状態をなくすための足し方なので、印の有無ではなく状態そのものを見る）。 */
  function verificationSearchWords(value: unknown): string {
    const status = verificationStatusKey(value);
    if (!status) return "";
    return VERIFICATION_STATUS_LABELS_JA[status] || "再確認待ち";
  }

  /* 締切セル・CSV・一覧の検索に出す**状態の語**をここで一本化する。
   * 画面は `推定` のバッジを出し、CSV にも同じ語を書いているのに、検索用の文字列
   * （hay）に入れていなかったため、**「推定」と打つと収録 134 件が 1 件も引けなかった**
   * （2026-09-23 実測。`再確認待ち` `要確認` も同じ）。画面に出る語は検索でも引ける、
   * という規則を関数1つで保つ。 */
  /* 上流の締切名に "Extended"（延長）と付いている行がある（2026-09-23 実測: 収録 3,235 行の
   * うち 30 行、将来締切では 15 行）。その事実は画面のどこにも出ておらず、検索も英語の
   * `extended` でしか引けなかった（「延長」は 3 件 – 偶然日本語の締切名に含んでいた行だけ）。
   * 締切が延びたかどうかは動作計画に直結するので、一覧・CSV・検索で同じ語を使う。
   * 表示する日付は延長後の締切そのもの（元の日付は上流も保持していない）。 */
  const EXTENDED_LABEL_JA = "延長後";

  function isExtendedDeadline(dl: unknown): boolean {
    const label = String((dl as Record<string, unknown> | null)?.label || "");
    // 差し替え前の日付を持つ行（下を参照）も、日付が後ろへ動いていれば同じ印を出す。
    // 前倒し（前へ動く）を「延長後」とは呼ばない。
    if (deadlineShiftsOf(dl).some((s) => s.later)) return true;
    return /extend/i.test(label) || label.indexOf("延長") >= 0;
  }

  function estimateWindowJa(ed: unknown): string {
    const e = (ed ?? {}) as Record<string, unknown>;
    if (e.estimated !== true) return "";
    const estimate = (e.estimate ?? {}) as Record<string, unknown>;
    const from = String(estimate.window_start ?? "").trim();
    const to = String(estimate.window_end ?? "").trim();
    if (!from || !to) return "";
    return `推定期間 ${from}〜${to}`;
  }

  const PULL_FORWARD_LABEL_JA = "前倒し";
  /* 行の詳細に出す一行の先頭語。索引にも同じ語を入れるので、この文をそのまま貼った人も
   * 日付の語でその行に戻ってこられる。 */
  const SHIFT_LINE_HEAD_JA = "前に出ていた締切";

  /** 差し替え前後の締切の一つ（表示は `fromJa`/`toJa`、索引は日付の語だけを使う）。 */
  type DeadlineShiftJa = {
    fromIso: string;
    fromDayJa: string;
    fromJa: string;
    toIso: string;
    toDayJa: string;
    toJa: string;
    later: boolean;
    precisionChangeLabelJa?: string;
  };

  /** 締切の値（差し替え前後のどちら側でも）を、画面に出す暦日 + 時刻に直す。 */
  function deadlineValuePartsJa(value: unknown, precision: unknown) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const dateOnly = precision === "date-only" || /^\d{4}-\d{2}-\d{2}$/.test(raw);
    const instant = dateOnly ? jstNoonMs(raw, Number.NaN) : (parsedInstant(raw) ?? Number.NaN);
    if (!Number.isFinite(instant)) return null;
    const ymd = calendarDateJa(instant);
    if (!ymd) return null;
    const iso = `${ymd[0]}-${String(ymd[1]).padStart(2, "0")}-${String(ymd[2]).padStart(2, "0")}`;
    const weekday = weekdayJaFromDate(iso);
    // 時刻を持つ値だけ時刻を添える（一覧の日付欄と同じ JST の暦日・同じ零詰め）。
    let clock = "";
    if (!dateOnly) {
      const jst = new Date(instant + 9 * 3_600_000);
      clock = ` ${String(jst.getUTCHours()).padStart(2, "0")}:${String(jst.getUTCMinutes()).padStart(2, "0")}`;
    }
    return { iso, ja: weekday ? `${iso}(${weekday})` : iso, clock, instant, dateOnly };
  }

  /** いま出している締切の値（行の基準と同じ欄を見る）。 */
  function currentDeadlineValuePartsJa(dl: Record<string, unknown>) {
    const dateOnly = dl.precision === "date-only";
    return deadlineValuePartsJa(dateOnly ? dl.local_date : (dl.utc ?? dl.at_utc), dl.precision);
  }

  /** 差し替え前の締切と、いま出している締切の組（同じ値の差し替えは何も返さない）。 */
  function deadlineShiftsOf(dl: unknown): DeadlineShiftJa[] {
    const d = dl as Record<string, unknown> | null;
    const list = d?.superseded_deadlines;
    if (!Array.isArray(list) || !list.length) return [];
    const to = currentDeadlineValuePartsJa(d as Record<string, unknown>);
    if (!to) return [];
    const out: DeadlineShiftJa[] = [];
    list.forEach((entry) => {
      const e = entry as Record<string, unknown>;
      const from = deadlineValuePartsJa(e.value, e.precision);
      if (!from || (from.instant === to.instant && from.dateOnly === to.dateOnly)) return;
      const precisionChangeLabelJa =
        from.dateOnly === to.dateOnly
          ? undefined
          : to.dateOnly
            ? "時刻未確認へ訂正"
            : "時刻表記へ更新";
      out.push({
        fromIso: from.iso,
        fromDayJa: from.ja,
        fromJa: `${from.ja}${from.clock}`,
        toIso: to.iso,
        toDayJa: to.ja,
        toJa: `${to.ja}${to.clock}`,
        later: !precisionChangeLabelJa && from.instant < to.instant,
        ...(precisionChangeLabelJa ? { precisionChangeLabelJa } : {}),
      });
    });
    return out;
  }

  function deadlineShiftLineJa(dl: unknown): string {
    const shifts = deadlineShiftsOf(dl);
    if (!shifts.length) return "";
    return `前に出ていた締切: ${shifts
      .map(
        (s) =>
          `${s.fromJa} → ${s.toJa}（${s.precisionChangeLabelJa ?? (s.later ? "延長" : PULL_FORWARD_LABEL_JA)}）`,
      )
      .join(" ／ ")}`;
  }

  function deadlineShiftSearchWords(dl: unknown): string {
    const shifts = deadlineShiftsOf(dl);
    if (!shifts.length) return "";
    const words: string[] = [SHIFT_LINE_HEAD_JA];
    shifts.forEach((s) => {
      // 暦日その物と、画面に並ぶ日付+曜日の形を両方入れる（貼った人がどちらを持っても引ける）。
      words.push(
        s.fromIso,
        s.fromDayJa,
        s.toIso,
        s.toDayJa,
        s.precisionChangeLabelJa ? "精度訂正" : s.later ? "延長" : PULL_FORWARD_LABEL_JA,
      );
    });
    return words.join(" ");
  }

  /* 締切を過ぎた行に出す印の形。以前の版は「過去の締切も表示」で出した行に一律
   * `締切済み（次回予定）` と書いていたが、収録データで次回が確認できる行は极少数だった
   * （2026-08-09 生成ビルドで実測: 過去行 77 件のうち **会期がまだ来ていない行 76 件**、
   * 同じ会議の次の回が確認できる行 0 件、会期も過ぎて次の回が無い行 1 件）。つまり
   * 76 件が根拠のない「次回予定」を出していて、読者は「この会議の次回は出る」と
   * 誤解する。会期の状態に応じて三つの形に分ける（行の詳細の「今後の会期」と同じ
   * `upcomingEditionsOf` を見る – 印だけが別の判断をしない）。 */
  const PAST_DEADLINE_TAG_JA = "締切済み";

  /** 行が締切を過ぎたかどうか（一覧の印・過去の締切の絞り込み・残り欄が同じ 1 本を見る）。 */

  function dateOnlyStateJa(
    r: { dateOnly?: unknown; t?: unknown; tLast?: unknown },
    now: number,
  ): "definitely-future" | "uncertain-on-date" | "definitely-past" | null {
    if (!r.dateOnly) return null;
    if (typeof r.t !== "number" || typeof r.tLast !== "number") return null;
    const t = r.t;
    const tLast = r.tLast;
    if (now < t) return "definitely-future";
    if (now <= tLast) return "uncertain-on-date";
    return "definitely-past";
  }

  /** 一覧の「残り」欄の語。**画面・CSV・MCP が同じ入口を見る**（正本は此処）。
   * 画面のセルは `site/app.ts` の `remain()`、表計算の数値は `deadlinesToCsv` が
   * 同じ規則（JST の暦日差）で数へ、MCP の行はここの `text` をそのまま使ふ。
   * 數へ方を此処で受けると、畫面と AI の答へが違ふ日に成る（實測 2026-10-15: CHES の
   * 2026-10-15 20:59 JST は 24 時間の floor だと「残り0日」・JST の暦日だと「あと 18 時間」。
   * 過去の行は「殘り（過ぎた）」の様な意味の通らない文に成る）。 */
  function remainingLabelJa(
    t: number,
    nowMs: number,
  ): { text: string; cls: "" | "past" | "today" | "soon" } {
    if (!Number.isFinite(t)) return { text: "―", cls: "" };
    /* JST の暦日（オフセットはインライン – この関数はビウド成果物から抜き出して檢查する）。 */
    const jstDay = (value: number) => Math.floor((value + 9 * 3600000) / 86400000);
    const diff = t - nowMs;
    if (diff < 0) {
      const days = jstDay(nowMs) - jstDay(t);
      return { text: days <= 0 ? "本日終了" : `${days} 日前に終了`, cls: "past" };
    }
    if (diff < 86400000) {
      const h = Math.floor(diff / 3600000);
      return { text: h <= 0 ? "まもなく" : `あと ${h} 時間`, cls: "today" };
    }
    const cal = jstDay(t) - jstDay(nowMs);
    return { text: `あと ${cal} 日`, cls: cal <= 14 ? "soon" : "" };
  }

  function deadlineRowIsPast(
    row: { t?: unknown; tLast?: unknown; dateOnly?: unknown; kind?: unknown },
    nowMs: number,
  ): boolean {
    if (row?.kind === "journal") return false;
    if (row?.dateOnly) {
      // 幅を持つ行（時刻未確認）は「表示したより前に終わった可能性がある」の間は過ぎたと呼ばない
      // （画面の「不確か」と同じ。`t`・`tLast` の両方が読めるときだけ判定する）。
      const first = Number(row.t);
      const last = Number(row.tLast);
      return Number.isFinite(first) && Number.isFinite(last) && last < nowMs;
    }
    const t = Number(row ? row.t : Number.NaN);
    return Number.isFinite(t) && t < nowMs;
  }

  /** 過ぎた締切の行の印。根拠のあるときだけ「次回予定」と書く。 */
  function pastDeadlineTagJa(
    row: {
      t?: unknown;
      tLast?: unknown;
      tEvent?: unknown;
      dateOnly?: unknown;
      conf?: unknown;
      ed?: {
        id?: string;
        event_start?: unknown;
        event_date_precision?: unknown;
        event_segments?: Array<{ start?: unknown; end?: unknown }>;
      } | null;
    },
    nowMs: number,
  ): string {
    if (!deadlineRowIsPast(row, nowMs)) return "";
    const tEvent = Number(row.tEvent);
    const precision = String(row.ed?.event_date_precision || "");
    const certain = !["month-only", "unverified", "not-announced"].includes(precision);
    const parts = row.ed?.event_segments?.length
      ? row.ed.event_segments
      : [{ start: row.ed?.event_start, end: row.ed?.event_start }];
    const starts = parts.flatMap((part) => {
      const bounds = eventDateBoundsMs(part.start, part.end, precision);
      return bounds ? [bounds[0]] : [];
    });
    const future = precision
      ? starts.length > 0 && Math.min(...starts) - 9 * 3_600_000 > nowMs
      : Number.isFinite(tEvent) && tEvent >= nowMs;
    if (certain && future) return `${PAST_DEADLINE_TAG_JA}（会期がこれから）`;
    const next = upcomingEditionsOf(
      row.conf,
      String(row.ed?.event_start || ""),
      nowMs,
      3,
      row.ed?.id,
    );
    if (next.length) return `${PAST_DEADLINE_TAG_JA}（次回予定）`;
    return PAST_DEADLINE_TAG_JA;
  }

  const VERIFICATION_STATUS_LABELS_JA: Record<string, string> = {
    verified: "確認済み",
    pending: "再確認待ち",
    retryable: "再試行待ち",
    changed: "変更を検出",
    "source-unreachable": "公式ページ取得不能",
    "manual-required": "複数候補のため要確認",
    "parser-failed": "複数候補のため要確認",
    unverified: "要確認",
  };

  /* 行の詳細の「公式確認」の語彙。**内部表記をそのまま見せない**（SPEC §7）ための表で、
   * 畫面（`app.ts` の `verificationSummary`）と AI（MCP の `verificationSummaryJa`）が
   * 同じ表を見る。此處に寫して置くと兩者が別の字面になり、AI が
   * `source_class: official-cfp` の儘を日本人研究者に伝へて了ふ
   * （實測 2026-10-16: MCP の行の構造化結果は内部の鍵名のまま出して居た）。
   * 知らない語は勝手に譯さない – 其の儘出す（推測して書く方が惡い）。 */
  const VERIFY_SOURCE_LABELS_JA: Record<string, string> = {
    "official-cfp": "公式CFP",
    publisher: "出版社ページ",
    "official-homepage": "公式ホームページ",
    aggregator: "集約サイト",
    unknown: "未確認",
  };

  const VERIFY_FIELD_LABELS_JA: Record<string, string> = {
    date: "日付",
    time: "時刻",
    timezone: "タイムゾーン",
    kind: "種別",
    round: "ラウンド",
    track: "トラック",
    deadline: "締切",
  };

  /* `selector_or_field` は公式ページのどこを読んだかを示す機械の判定名
   * （實測で `deadline-text-window`・`table-row:deadline`）。確認範圍ではないので、
   * 読み方を譯せる物だけ譯して出す。 */
  const VERIFY_SELECTOR_LABELS_JA: Record<string, string> = {
    "deadline-text-window": "本文中の締切の記述",
    "table-row:deadline": "公式ページ内の表の締切欄",
  };

  /** 確認元の語（知らないクラスは其の儘 – 譯さない）。 */
  function verifySourceLabelJa(value: unknown): string {
    const name = String(value ?? "").trim();
    if (!name) return "公式";
    return VERIFY_SOURCE_LABELS_JA[name] || name;
  }

  /** 確認範圍の語。讀み取つた項目が有る時は其の列、無い時は判定名か既定の三つ。
   * （項目が讀めた時は**其の儘譯す** – 空の欄を出さない為に既定で埋めない。畫面の
   *  `fieldsJa` と同じ形。） */
  function verifyScopeJa(verified: unknown, selector: unknown): string {
    if (Array.isArray(verified))
      return verified
        .map((item) => VERIFY_FIELD_LABELS_JA[String(item)] || String(item))
        .join("・");
    const name = typeof selector === "string" ? selector.trim() : "";
    if (!name) return "日付・時刻・タイムゾーン";
    const label = VERIFY_SELECTOR_LABELS_JA[name];
    return label ? `${label}（公式ページの読み取り箇所）` : `機械の判定名のまま: ${name}`;
  }

  /** 語彙の表（畫面が讀む用 – 寫さずに正本から取る）。 */
  function verifyLabelTables(): {
    status: Record<string, string>;
    source: Record<string, string>;
    field: Record<string, string>;
    selector: Record<string, string>;
  } {
    return {
      status: { ...VERIFICATION_STATUS_LABELS_JA },
      source: { ...VERIFY_SOURCE_LABELS_JA },
      field: { ...VERIFY_FIELD_LABELS_JA },
      selector: { ...VERIFY_SELECTOR_LABELS_JA },
    };
  }

  /** 行の詳細の「公式確認」を**日本語の部品**で返す（畫面が HTML に組み、MCP が其の侭返す）。
   * 記録が無い行は null（畫面も欄ごと出さない）。日時は JST の暦日の時刻で、
   * 利用者の端末の時刻合わせに左右されない書き方にする。 */
  function verificationSummaryJa(dl: unknown): {
    verified_at: string;
    source: string;
    scope: string;
    status: string;
    next_check_at: string | null;
  } | null {
    const record = (dl ?? {}) as {
      verification?: Record<string, unknown>;
      evidence?: Array<Record<string, unknown>>;
    };
    const verification = record.verification;
    if (!verification || typeof verification !== "object") return null;
    const evidence = (record.evidence ?? []).find(
      (item) => item.verifiedFields ?? item.verified_fields,
    );
    const verified = evidence?.verifiedFields ?? evidence?.verified_fields;
    return {
      verified_at: verification.last_verified_at
        ? jstStampJa(String(verification.last_verified_at))
        : "未確認",
      source: verifySourceLabelJa(verification.source_class),
      scope: verifyScopeJa(verified, verification.selector_or_field),
      status: VERIFICATION_STATUS_LABELS_JA[String(verification.status ?? "")] || "再確認待ち",
      next_check_at: verification.next_check_at
        ? jstStampJa(String(verification.next_check_at))
        : null,
    };
  }

  /** 公式確認の日時を JST で（`2026-08-02(日) 03:30 JST`）。讀めない値は其の侭言ふ。 */
  function jstStampJa(value: string): string {
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return `読み取り不能（原文: ${value}）`;
    const jst = new Date(d.getTime() + 9 * 3600000);
    const p = (n: number): string => String(n).padStart(2, "0");
    const weekday = ["日", "月", "火", "水", "木", "金", "土"][jst.getUTCDay()];
    return `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())}(${weekday}) ${p(
      jst.getUTCHours(),
    )}:${p(jst.getUTCMinutes())} JST`;
  }

  /** 検証状態の欄の形（オブジェクト・文字列・無し）を状態語に落とす。 */
  function verificationStatusKey(value: unknown): string {
    if (value && typeof value === "object")
      return String((value as { status?: unknown }).status ?? "");
    return String(value ?? "");
  }

  /** 検証状態が画面に出す語。未設定と確認済みは空（一覧の印は出さない）。 */
  function verificationStatusLabelJa(value: unknown): string {
    const status = verificationStatusKey(value);
    if (!status || status === "verified") return "";
    return VERIFICATION_STATUS_LABELS_JA[status] || "再確認待ち";
  }

  function statusBadgeWords(ed: object, dl: object): string[] {
    // `needs_reconfirm` と `verification` は型に生えていない上流由来の欄なので、
    // ここでは広く取る（2026-09-23 時点で収録カタログには 0 行。出た日に検索できることが
    // 目的で、語だけ先行して置いておく）。
    const e = ed as Record<string, unknown>;
    const d = dl as Record<string, unknown>;
    return [
      e.estimated ? "推定" : "",
      d.needs_reconfirm ? "再確認待ち" : "",
      verificationSearchWords(d.verification),
      isExtendedDeadline(dl) ? EXTENDED_LABEL_JA : "",
    ].filter(Boolean);
  }

  /* 表の 2 行目（公式表記）に出す語そのものを、検索の語にも入れる。2026-09-23 実測:
   * 将来締切 917 行のうち 181 行が「時刻未確認」の印を出し、524 行が「公式 AoE …」と
   * 出すのに、その語を打つと 0 件だった（画面に出ている語が引けない状態）。「AoE」は
   * 上流の締切名に混じる 2 件が引けるだけで、AoE 締切自体は 1 件も出ていなかった。
   *   -AoE は表と同じく AoE 宣言の行だけに入れる（JST 宣言の行に入れても、実在しない
   *     AoE 締切を探したことになり、表の向きともズレる）。
   *   -全行に出る「公式」の二字は入れない（入れても何も絞れず、絞れたと誤信させる。
   *   -「確認できたものだけ」はチェックボックスの側で絞れる）。 */
  function zoneSearchWords(dl: unknown, dateOnly: boolean): string {
    if (dateOnly) return TIME_UNCONFIRMED_LABEL_JA;
    const zone = officialZone(dl);
    if (!zone) return "";
    if (zone === "UTC" || zone === "JST" || zone === "AoE") return zone;
    // 表は「公式 CEST ／ 2026-… UTC」の形で出すので、両方の語を引けるようにする。
    return `${zone} UTC`;
  }

  /* ISO の暦日そのものを検索の語に足す（一覧の日付欄・会期欄に並ぶ語そのもの）。
   * 締切の暦日は `dayTermsJa` と並びに ISO も hay に入っていて引けるが、会期は日付が
   * 引けない（2026-08-09 生成ビルドで実測: 会期欄に並ぶ ISO 日付は延べ 1,214 箇所・230 種で、
   * そのうち 1,172 箇所は、会期にその日を書く行を `2026-12-03` でも `12月3日` でも引けなかった。
   * 当たった 42 箇所は締切の日付がたまたま同じ行）。会期欄の日付は画面に出ている語なので、
   * 表示と同じ `eventCellJa` の式から取る（表示と違う欄を索引に足すと、引ける語と見える語が
   * またズレる）。 */
  function isoDayJa(value: unknown): string {
    const ymd = calendarDateJa(value);
    if (!ymd) return "";
    const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));
    return `${ymd[0]}-${pad2(ymd[1])}-${pad2(ymd[2])}`;
  }

  function deadlineCellSearchWords(dl: unknown, t: number, dateOnly: boolean): string {
    if (dateOnly) {
      /* 日付しか確認できていない行の締切欄は `2026-09-30(水)` の形（`deadlinesToCsv` と同じ式）。
       * 打つ側は日付と曜日を割らない（上の `weekdayTail`）ので、この形その物を入れる。 */
      const local = String((dl as { local_date?: unknown } | null)?.local_date || "");
      const day = weekdayJaFromDate(local);
      return day ? `${local}(${day})` : "";
    }
    if (!Number.isFinite(t)) return "";
    const texts = [csvJstInstant(t)];
    if (officialZone(dl) === "AoE") texts.push(fmtAoEText(t));
    const words: string[] = [];
    texts.forEach((text) => {
      text.split(" ").forEach((part) => {
        /* `JST(土)` のように曜日と続けて書いてあるので、括弧より前だけを見る
         * （曜日の語は `dayTermsJa` が既に hay に入れている）。 */
        const head = part.replace(/\(.*$/u, "");
        let word = "";
        if (/^\d{1,2}:\d{2}$/u.test(part)) word = part;
        else if (head === "JST" || head === "AoE") {
          word = head;
          /* 締切欄は `JST(土)` と曜日が続括弧で書くので、**その形そのまま**も語に入れる
           * （打つ側は日付・時刻帯と曜日を割らない – `weekdayTail`）。`JST` だけを入れて
           * おけば足りるわけではない: 括弧を含む語として絞りたい人が同じ形を打てるようにする。 */
          if (/^JST[（(][日月火水木金土][）)]$/u.test(part)) word = part;
        }
        if (word && words.indexOf(word) < 0) words.push(word);
      });
    });
    return words.join(" ");
  }

  function officialDateSearchWords(dl: unknown, t: number, dateOnly: boolean): string {
    if (dateOnly || !Number.isFinite(t)) return "";
    if (officialZone(dl) !== "AoE") return "";
    const iso = /^(\d{4}-\d{2}-\d{2})/u.exec(fmtAoEText(t));
    if (!iso) return "";
    const day = iso[1];
    return [day, monthTermsJa(day), dayTermsJa(day)].filter(Boolean).join(" ");
  }

  /* 会期欄に並ぶ日付の語をまとめて返す（開始日・終了日の和暦形と ISO）。
   * 曜日は足さない。会期欄は `2026-12-03(木) 〜 2026-12-04(金)` と曜日も二つ出すが、
   * 会期の曜日まで検索に入れると「金曜日」が締切の日で引けなくなる（2026-08-09 生成ビルドで
   * 実測: 131 件 → 398 件に膨らみ、大部分は会期が金曜に終わる行）。曜日は締切の日の語の
   * ままにして、会期で選ぶ人は一覧の「会期」順で並べ替える道がある（てびきに書く）。 */
  function eventCertaintySearchText(value: unknown): string {
    const tokens: Record<string, string> = {
      会期未発表: "eventdateunannounced",
      月のみ判明: "eventdatemonthonly",
      日付未確認: "eventdateunverified",
    };
    return String(value ?? "").replace(/会期未発表|月のみ判明|日付未確認/g, (word) => tokens[word]);
  }

  function eventDaySearchWords(row: unknown): string {
    const ev = ((row as { ed?: unknown } | null)?.ed || {}) as Record<string, unknown>;
    const precision = String(ev.event_date_precision || "");
    if (precision === "not-announced") return `${eventCertaintySearchText("会期未発表")} tbd tba`;
    if (precision === "month-only")
      return eventCertaintySearchText(
        eventCellJa({ ed: { ...ev, date_text: "" } }) || "月のみ判明",
      );
    const words: string[] = [];
    [ev.event_start, ev.event_end].forEach((value) => {
      const iso = isoDayJa(value);
      if (!iso) return;
      words.push(dayTermsJa(value), iso);
    });
    words.push(eventCertaintySearchText(eventCellJa({ ed: ev })));
    return words.filter(Boolean).join(" ");
  }

  function eventSourceSearchText(ed: unknown): string {
    const ev = (ed || {}) as Record<string, unknown>;
    return ["month-only", "not-announced"].includes(String(ev.event_date_precision))
      ? eventDaySearchWords({ ed: ev })
      : String(ev.date_text || "");
  }

  /* 検索語を語の組に分けて、収録データで何行に当たるかを数える。語を並べて打った人が
   * 0 件に当たったとき、どの語が足りなかったのかを画面が言えるようにするため
   * （2026-09-23 実測: 「ネットワーク 福岡 GPU」は 0 件なのに、どの語が原因かを画面は
   * 何も言わなかった）。組の中は OR（同義・読み展開）、組の間は AND なので、
   * 数えるのも組の単位にする（1 語だけで数ると、展開で届く語を「無い」と誤報する）。 */

  function splitHintJa(query: unknown, 件數: (文: string) => number): string {
    const 文 = String(query == null ? "" : query).trim();
    if (文.length < 4 || 文.length > 20 || /\s/.test(文) || /\./.test(文)) return "";
    let 最良 = "";
    let 最良數 = 0;
    for (let i = 2; i <= 文.length - 2; i += 1) {
      const 候補 = `${文.slice(0, i)} ${文.slice(i)}`;
      const n = 件數(候補);
      if (n > 最良數) {
        最良數 = n;
        最良 = 候補;
      }
    }
    if (!最良 || 最良數 === 0) return "";
    return (
      ` 語を分けて「${最良}」と打つと ${最良數} 件出ます。` +
      "日本語で繋げた打ち方は、この表の行の文本にその形で見えん為、当たりません。"
    );
  }

  function queryTermCounts(
    query: unknown,
    hays: readonly unknown[],
    nowMs?: number,
  ): Array<{ term: string; count: number }> {
    const list = Array.isArray(hays) ? hays : [];
    const groups = queryTokenGroups(query, nowMs);

    const folded: string[] = [];
    for (let i = 0; i < list.length; i++) folded.push(kanaFold(list[i]));
    return groups.map((group) => {
      const alts = (group || []).length ? group : [""];
      const matchers = alts.map((alt) => searchGroups(alt, nowMs));
      let count = 0;
      for (let i = 0; i < folded.length; i++) {
        for (let j = 0; j < matchers.length; j++) {
          // `searchMatcher` と同じく、述語が空の語は全行に当たる。
          if (!matchers[j].length || matchFoldedGroups(folded[i], matchers[j])) {
            count += 1;
            break;
          }
        }
      }
      const labels: Record<string, string> = {
        eventdateunannounced: "会期未発表",
        eventdatemonthonly: "月のみ判明",
        eventdateunverified: "日付未確認",
      };
      const raw = String(alts[0] || "");
      const term =
        labels[raw] ||
        raw.replace(
          /^kyed([a-j]{4})$/,
          (_, digits: string) =>
            `${[...digits].map((digit) => digit.charCodeAt(0) - 97).join("")}年の開催回`,
        );
      return { term, count: count };
    });
  }

  function shorterHitWordsJa(
    query: unknown,
    hays: readonly unknown[],
    nowMs?: number,
    limit = 2,
  ): Array<{ word: string; count: number; how: string; pair?: string }> {
    const list = Array.isArray(hays) ? hays : [];
    const words: string[] = [];

    queryTokenGroups(expandRelativeMonths(query, nowMs ?? Date.now()), nowMs).forEach((group) => {
      const term = String(((group || [])[0] as string) || "").trim();
      if (term && !/^(?:kyed[a-j]{4}|eventdate(?:unannounced|monthonly|unverified))$/.test(term))
        words.push(term);
    });
    if (!words.length || words.length > 6) return [];

    const rawWords = String(query ?? "")
      .trim()
      .split(/\s+/)
      .filter((w) => w);
    const shown = (index: number, normalized: string): string => {
      const raw = rawWords.length === words.length ? String(rawWords[index] || "") : "";
      if (!raw || Array.from(raw).length !== Array.from(normalized).length) return normalized;
      return raw;
    };
    /* 行の畳み込み（`kanaFold`）は 1 回だけやる。打ち直しの見当は同じ表に 10〜20 の語を
     * 掛けるので、語ごとに畳み直すと同じ表を 20 回読む（2026-08-09 生成ビルド・候補行
     * 3,275 行 / 210 万字で実測: `分散並列処理基盤システム` 1 語の見当に **640 ms**、
     * `高速計算` 157 ms – 1 打鍵で検索欄が固まる。畳んでから数えると 35 ms）。
     * 述語の作り方は `searchMatcher` と同じ `searchGroups` を使うので、数は同じものになる。 */
    const folded: string[] = [];
    for (let i = 0; i < list.length; i++) folded.push(kanaFold(list[i]));
    const cache: Record<string, number> = {};
    const countOf = (word: string): number => {
      if (!word) return 0;
      if (cache[word] !== undefined) return cache[word];
      const groups = searchGroups(word, nowMs);
      let n = 0;
      if (groups.length) {
        for (let i = 0; i < folded.length; i++) {
          if (matchFoldedGroups(folded[i], groups)) n += 1;
        }
      }
      cache[word] = n;
      return n;
    };
    /* 語の切れ目 – 助詞と句読。それより外の切り方は語で無い切れ端になる。 */
    const 語の切れJa = /^[、。，,・：:！？のをはにへをもやとが]$/;
    const found: Array<{ word: string; count: number; how: string; pair?: string }> = [];
    const pushShown = (display: string, word: string, how: string, pair?: string): void => {
      const n = countOf(word);
      if (n <= 0) return;

      if (wholeTableQueryWordJa(display)) return;
      if (list.length >= 8 && n * 2 >= list.length) return;
      if (found.some((item) => item.word === display)) return;
      found.push({ word: display, count: n, how: how, pair: pair });
    };
    /* (a) 複数語を打たれているときは、語を 1 つに絞った数を each 語について出す。 */
    if (words.length >= 2)
      words.forEach((word, index) => {
        pushShown(shown(index, word), word, "alone");
      });
    words.forEach((word, index) => {
      if (countOf(word) > 0) return;
      const chars = Array.from(word);
      const raw = shown(index, word);
      const rawChars = Array.from(raw);
      if (chars.length < 3) return;
      /* (b) 続きを落とす、あるいは前を落とす。元の語に近いほう（長く残すほう）を先に取る。 */

      const 語面Ja = (前文: string): boolean => {
        const 字 = Array.from(前文);
        if (!字.length) return false;
        /* 假名で終る物は動詞・助数の語尾（『発表される』『いつ』）– 語の切れ端なので彈く。 */
        if (/[ぁ-ん]/.test(字[字.length - 1])) return false;
        for (const 文 of 字) if (語の切れJa.test(文) || 文 === "で") return false;
        return true;
      };

      const 一文字種Ja = (語: string): boolean =>
        /^[A-Za-z0-9〜ー]+$/.test(語) || /^[\u30a1-\u30faー〜]+$/.test(語);
      const 字種の邊Ja = (前語: string, 後語: string, 生の前?: string): boolean =>
        (前語.length >= 3 || /^[A-Z]{2}$/.test(生の前 || "")) &&
        後語.length >= 3 &&
        一文字種Ja(前語) &&
        一文字種Ja(後語) &&
        !/[ー〜0-9]$/.test(前語) &&
        !/^[ー〜]/.test(後語);

      const 催し物の呼び名Ja =
        /^(?:セミナー|ソナー|トラック|ランキング|チュートリアル|ワークショップ|シンポジウム|セッション|カンファレンス|ミーティング)$/;
      const 邊が語Ja = (前語: string, 後語: string): boolean =>
        催し物の呼び名Ja.test(前語) ||
        催し物の呼び名Ja.test(後語) ||
        (countOf(前語) >= 3 && countOf(後語) >= 3);
      const 継ぎ目Ja = (前: string, 後: string, 前文?: string): boolean =>
        (語の切れJa.test(後) && !語の切れJa.test(前)) ||
        /[々〻一-龥]/.test(前) ||
        (!!前文 && /[々〻一-龥]/.test(後) && 語面Ja(前文));
      /* 頭の邊を憶ゆる – 尾のループがその内側から切り出すと前の語に食い込む。*/
      let 頭の邊 = -1;
      for (let k = chars.length - 1; k >= 2; k--) {
        const head = chars.slice(0, k).join("");
        const 残る語 = chars.slice(k).join("");
        const 字種の邊のみ =
          !継ぎ目Ja(chars[k - 1], chars[k], head) &&
          字種の邊Ja(head, 残る語, rawChars.slice(0, k).join(""));
        if (!継ぎ目Ja(chars[k - 1], chars[k], head) && !字種の邊のみ) continue;
        if (字種の邊のみ && !邊が語Ja(head, 残る語)) continue;

        if (countOf(head) > 0) {
          pushShown(
            rawChars.length === chars.length ? rawChars.slice(0, k).join("") : head,
            head,
            "shorten",
          );
          頭の邊 = k;
          break;
        }
      }
      for (let k = 1; k <= chars.length - 2; k++) {
        if (頭の邊 >= 0 && k < 頭の邊) continue;
        const tail = chars.slice(k).join("");
        const 前語 = chars.slice(0, k).join("");

        if (/^[ぁ-ん]/.test(tail) && /[一-鿿]/.test(chars[k - 1])) continue;
        const 字種の邊のみ2 =
          !継ぎ目Ja(chars[k - 1], chars[k]) &&
          字種の邊Ja(前語, tail, rawChars.slice(0, k).join(""));
        if (!継ぎ目Ja(chars[k - 1], chars[k]) && !字種の邊のみ2) continue;
        if (字種の邊のみ2 && !邊が語Ja(前語, tail)) continue;
        if (countOf(tail) > 0) {
          pushShown(
            rawChars.length === chars.length ? rawChars.slice(k).join("") : tail,
            tail,
            "shorten",
          );
          break;
        }
      }
      /* (c) 2 つの語に割って、両方が立っているものだけ出す。 */
      if (found.some((item) => item.how === "split")) return;
      for (let k = 2; k <= chars.length - 2; k++) {
        const left = chars.slice(0, k).join("");
        const right = chars.slice(k).join("");
        if (countOf(left) <= 0) continue;
        /* 割った 2 語を別々に打った人数ではなく、**両方を含む行**の数を数える
         * （`学生 論文` と打ち直した人に見える件数なので、それで無いと噓になる）。 */
        const both = countOf(`${left} ${right}`);
        if (both <= 0) continue;
        const shownPair =
          rawChars.length === chars.length
            ? `${rawChars.slice(0, k).join("")} ${rawChars.slice(k).join("")}`
            : `${left} ${right}`;
        found.push({
          word: shownPair,
          count: both,
          how: "split",
          pair: `${left},${right}`,
        });
        break;
      }
    });

    const 寄 = new Map<string, string>();
    {
      const 語彙 = latinVocabularyJa(folded);
      words.forEach((word) => {
        if (countOf(word) > 0) return;
        for (const 近 of latinNearestJa(語彙, latinSkeletonJa(word))) 寄.set(近.word, 近.word);
      });
      for (const 語 of 寄.values()) pushShown(語, 語, "retype");
      // 収録の語として実在せぬ欧文の切れ端は打ち手から落す（`embeded`→『embe』63 件等 – 第 680 回）。
      for (let i = found.length - 1; i >= 0; i--) {
        const 見 = found[i];
        if (
          見.how !== "shorten" ||
          !/^[a-z0-9 .'-]+$/i.test(見.word) ||
          latinAttestedJa(語彙, 見.word)
        )
          continue;
        found.splice(i, 1);
      }
    }
    /* 収録の実在する綴りは、語の切れ端より先に置く（実測 – `embeded` に「『embe』63 件」より
     * 「『embedded』982 件」を先に出す – 切れ端を打てと言っても打てん）。*/
    const RANK: Record<string, number> = { retype: 0, split: 1, alone: 2, shorten: 3 };
    return found
      .sort((a, b) => {
        const ra = RANK[a.how] === undefined ? 3 : RANK[a.how];
        const rb = RANK[b.how] === undefined ? 3 : RANK[b.how];
        if (ra !== rb) return ra - rb;
        return b.count - a.count;
      })
      .slice(0, limit > 0 ? limit : 1);
  }

  /* 会議名+開催年の組み立て式。一覧・行の詳細・CSV・Markdown で同じ語を見せるために
   * 一箇所へ寄せる。以前は CSV だけが年を足さない別実装（素の `conf.title`）で、画面で
   * `3DV 2024` と見える行の CSV は `3DV` だった（2026-08-09 実測: 候補行 3,235 件のうち
   * 2,996 件で画面と CSV の会議名が違い、既定画面の 478 行中 422 件が該当。CSV には年の列が
   * 無いので、表計算で画面と同じ名前や西暦で絞り込んだ人が 0 行になる上、同じ会議の別回が
   * 一つの語に潰れて分離できた）。タイトルに既に年（`CANOPIE-HPC 2026`）や短縮年
   * （`SC '26`・`SC ’26`）が入っているときは二重に付けない。year が無いときはタイトルだけ返す。 */
  function titleWithYearJa(title: unknown, year: unknown): string {
    const t = String(title ?? "").trim();
    if (!t) return "";
    const y = Number(year);
    if (!Number.isFinite(y) || !y) return t;
    const yStr = String(y);
    const yy = yStr.slice(-2);
    const normT = t.normalize ? t.normalize("NFKC").trim() : t;
    const hasYear =
      normT.endsWith(yStr) ||
      normT.endsWith(`'${yy}`) ||
      (yy && new RegExp(`(?:20${yy}|['’]?${yy})$`).test(normT));
    return hasYear ? t : `${t} ${y}`;
  }

  /* 会期の表示語を決める式を一箇所にする。一覧・行の詳細・CSV が別々に組み立てていて
   * 行の詳細だけ公式ページの原文をそのまま出していた（2026-08-09 実測: 会期に ISO を持つ
   * 2,971 行のうち 2,933 行で行の詳細が `March 18-21, 2024` のような英語の原文になり、
   * 同じ行の一覧は `2024-03-18(月) 〜 2024-03-21(木)` と出ていた。既定画面にも 338 行
   * 出ている）。てびきの「日時」は「表と詳細で同じ式を使う」と書いているので、その案内に
   * 合わせる。読み取れる ISO があれば一覧と同じ式、ISO が無い行だけ原文を返す
   * （原文しか無い行は 12 行あり、そこに「未確認」より実際に決まっている会期を書くのは
   * CSV がもともとやっていたことと同じ）。 */
  /* 出張・会場押さえは曜日で見込むので、ISO 日付に曜日を添える（曜日が出せなければ添えない）。
   * 終了日が開始日と同じ・無い場合は1日分として出す。 */

  function meetingRangeJa(start: string, end: string): string {
    const startDay = weekdayJaFromDate(start);
    let when = `${start}${startDay ? `(${startDay})` : ""}`;
    if (end && end !== start) {
      const endDay = weekdayJaFromDate(end);
      const endHead = end.slice(0, 4) === start.slice(0, 4) ? "" : `${end.slice(0, 4)}-`;
      when += `〜${endHead}${end.slice(5)}${endDay ? `(${endDay})` : ""}`;
    }
    return when;
  }

  interface UpcomingEdition {
    link?: string;
    start: string;
    end: string;
    place: string;
    precision?: string;
    segments?: Array<{ start: string; end: string; label?: string }>;
    year?: number;
    editionId?: string;
  }

  /** 同じ会議の今後の会期。識別子がある場合は表示中の開催回だけを除く。 */
  function upcomingEditionsOf(
    conf: unknown,
    exceptStart: string,
    nowMs: number,
    max = 3,
    exceptId?: string,
  ): UpcomingEdition[] {
    const record = conf as { editions?: Array<Record<string, unknown>> };
    const out: UpcomingEdition[] = [];
    for (const ed of record.editions || []) {
      if (ed.estimated === true) continue;
      const segments = Array.isArray(ed.event_segments)
        ? (ed.event_segments as UpcomingEdition["segments"])
        : undefined;
      const start = String(ed.event_start || segments?.[0]?.start || "");
      const end = String(ed.event_end || segments?.at(-1)?.end || start);
      if (exceptId ? ed.id === exceptId : start === exceptStart) continue;
      const parts = segments?.length ? segments : [{ start, end }];
      if (
        !parts.some((part) => {
          const bounds = eventDateBoundsMs(part.start, part.end, ed.event_date_precision);
          return bounds && bounds[1] + 15 * 3_600_000 > nowMs;
        })
      )
        continue;
      out.push({
        start,
        end,
        place: String(ed.place || ""),
        ...(typeof ed.link === "string" && ed.link.trim() ? { link: ed.link } : {}),
        precision:
          typeof ed.event_date_precision === "string" ? ed.event_date_precision : undefined,
        segments,
        year: typeof ed.year === "number" ? ed.year : undefined,
        editionId: typeof ed.id === "string" ? ed.id : undefined,
      });
    }
    return out.sort((a, b) => a.start.localeCompare(b.start)).slice(0, max);
  }

  function laterEditionLineJa(ed: UpcomingEdition): string {
    const place = String(ed.place || "");
    const span =
      ed.segments?.length || (ed.precision && !["single-day", "exact-range"].includes(ed.precision))
        ? eventCellJa({
            ed: {
              event_start: ed.start,
              event_end: ed.end,
              event_date_precision: ed.precision,
              event_segments: ed.segments,
            },
          })
        : meetingRangeJa(ed.start, ed.end);
    const year =
      ed.year && (String(ed.year) !== ed.start.slice(0, 4) || ed.precision === "not-announced")
        ? `${ed.year}年の開催回: `
        : "";
    return `${year}${span}${place ? ` ＠${placeJa(place)}` : ""}`;
  }

  function editionYearSearchTerm(year: unknown): string {
    return `kyed${String(year)
      .normalize("NFKC")
      .replace(/\d/g, (digit) => String.fromCharCode(97 + Number(digit)))}`;
  }

  function laterEditionSearchWords(conf: unknown, exceptStart: string, exceptId?: string): string {
    const record = conf as { editions?: Array<Record<string, unknown>> };
    const words: string[] = [];
    for (const ed of record.editions || []) {
      if (ed.estimated === true) continue;
      const segments = Array.isArray(ed.event_segments) ? ed.event_segments : [];
      const start = String(ed.event_start || segments[0]?.start || "");
      if (
        (/^\d{4}-\d{2}-\d{2}$/.test(start) || ed.event_date_precision === "not-announced") &&
        typeof ed.year === "number"
      )
        words.push(editionYearSearchTerm(ed.year));
      if (exceptId ? ed.id === exceptId : exceptStart && start === exceptStart) continue;
      if (ed.event_date_precision === "not-announced") {
        words.push(eventDaySearchWords({ ed }));
        continue;
      }
      const parts = segments.length ? segments : [{ start, end: ed.event_end || start }];
      for (const part of parts) {
        if (!part || !/^\d{4}-\d{2}-\d{2}$/.test(String(part.start))) continue;
        const end = String(part.end || part.start);
        if (ed.event_date_precision === "month-only") {
          words.push(
            eventDaySearchWords({
              ed: { ...ed, event_start: part.start, event_end: end, event_segments: [] },
            }),
          );
          continue;
        }
        words.push(
          meetingRangeJa(String(part.start), end),
          String(part.start),
          end,
          eventCertaintySearchText(
            eventCellJa({
              ed: {
                event_start: part.start,
                event_end: end,
                event_date_precision: ed.event_date_precision,
              },
            }),
          ).replace(/\([日月火水木金土]\)/gu, ""),
        );
      }
    }
    return words.join(" ");
  }

  function eventDateBoundsMs(
    start: unknown,
    end: unknown,
    precision: unknown,
  ): [number, number] | null {
    const from = String(start ?? "").trim();
    const to = String(end || from).trim();
    const parse = (value: string): number => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return Number.NaN;
      const ms = Date.parse(value);
      return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value
        ? ms
        : Number.NaN;
    };
    const first = parse(from);
    const last = parse(to);
    if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return null;
    if (precision !== "month-only") return [first, last];
    const lower = new Date(first);
    lower.setUTCDate(1);
    const upper = new Date(last);
    upper.setUTCMonth(upper.getUTCMonth() + 1, 0);
    return [lower.getTime(), upper.getTime()];
  }

  function eventCellJa(row: unknown): string {
    const ed = ((row as { ed?: unknown } | null)?.ed || {}) as Record<string, unknown>;
    const precision = String(ed.event_date_precision || "");
    if (precision === "not-announced") return "会期未発表";
    if (Array.isArray(ed.event_segments) && ed.event_segments.length) {
      return ed.event_segments
        .map((part: Record<string, unknown>) => {
          const span = eventCellJa({
            ed: {
              event_start: part.start,
              event_end: part.end,
              event_date_precision: ed.event_date_precision,
            },
          });
          return span + (part.label ? `（${String(part.label)}）` : "");
        })
        .join(" / ");
    }
    const start = String(ed.event_start || "").trim();
    const end = String(ed.event_end || "").trim();
    if (precision === "month-only") {
      const month = (date: string): string =>
        /^\d{4}-(?:0[1-9]|1[0-2])-\d{2}$/.test(date) ? date.slice(0, 7) : "";
      const from = month(start);
      const to = month(end);
      const span = from && to && from !== to ? `${from} 〜 ${to}` : from || to;
      if (span) return `${span}（月のみ判明）`;
      const raw = String(ed.date_text || "").trim();
      if (/^\d{4}年(?:[1-9]|1[0-2])月号(?:（掲載予定）)?$/.test(raw)) return raw;
      return "開催月のみ判明（日付未確認）";
    }
    if (!start) return String(ed.date_text || "").trim();
    const withDay = (date: string): string => {
      const day = weekdayJaFromDate(date);
      return day ? `${date}(${day})` : date;
    };
    const span = end && end !== start ? `${withDay(start)} 〜 ${withDay(end)}` : withDay(start);
    return precision === "unverified" ? `${span}（日付未確認）` : span;
  }

  function csvDeadlineCells(row: Record<string, unknown>, nowMs: number): string[] {
    const conf = (row.conf || {}) as Record<string, unknown>;
    const ed = (row.ed || {}) as Record<string, unknown>;
    const dl = (row.dl || {}) as Record<string, unknown>;
    const rank = (conf.rank || {}) as Record<string, unknown>;
    const kind = String(row.kind || dl.kind || "");
    const dateOnly = row.dateOnly === true;
    const t = typeof row.t === "number" ? row.t : Number.NaN;
    let when = "";
    let official = "";
    if (kind === "journal") {
      when = "常時受付"; // 種別ラベルと同じ語（1 行の中で 2 つの名前を見せない）
    } else if (dateOnly) {
      const day = weekdayJaFromDate(row.localDate);
      when = day ? `${row.localDate}(${day})` : String(row.localDate || "");
      official = TIME_UNCONFIRMED_LABEL_JA;
    } else if (Number.isFinite(t)) {
      when = csvJstInstant(t);
      const zone = officialZone(dl);
      if (zone === "JST") official = "JST";
      else if (zone === "AoE") official = fmtAoEText(t);
      else if (zone && zone !== "UTC") official = `${zone} ／ UTC`;
      else official = "UTC";
    }
    /* 残り日数は数値のまま出す。表計算で開いたときに並べ替えたり近い分だけ狭めたりできる形で
     * 持てるためで、画面の「あと N 日」（読みやすさ優先）とは書き方が違う。過ぎた分は負の数。
     * 日期のみの行も日粒度で数値を出す（時刻の未確認は「公式表記」列が既に伝えている）。 */
    let left = "";
    // 幅を持つ行は、画面と同じ「表示している暦日」から数える（`tShown`）。画面の
    // 「あと N 日」と表計算の数が違うと、どちらを信じていいか分からなくなる。
    const tShown = typeof row.tShown === "number" && Number.isFinite(row.tShown) ? row.tShown : t;
    if (kind !== "journal" && Number.isFinite(tShown)) {
      /* 過ぎた分の数え方は、画面と同じ **JST の暦日差**にする。経過時間の floor だと、
       * 午前中の締切で「画面は 2019 日前に終了、表計算は -2020」と 1 日ずれる
       * （実測）。画面の数を
       * 確認するために表計算を開く人が、どちらを信じるか分からなくなるため。
       * 先の分も同じ暦日差にした（2026-08-09 生成ビルドで実測: 経過時間の floor だった
       * 日は、締切 2026-08-22 03:00 JST の行が JST 09:00 の眺めで「あと 12 日」／表計算は
       * 12 で、暦日では 13 日後。ずれは JST 20:00 の眺めだと 785 行中 320 行出た）。
       * 24 時間未满の行は画面が「あと N 時間」を出す側なので 0 のまま（急ぎを 1 日に
       * 丸めて大きく見せない）。 */
      const jstDay = (value: number) => Math.floor((value + 9 * 3600000) / 86400000);
      const ahead = tShown - nowMs;
      left =
        tShown < nowMs
          ? String(-(jstDay(nowMs) - jstDay(tShown)))
          : ahead < 86400000
            ? "0"
            : String(jstDay(tShown) - jstDay(nowMs));
    }
    /* ランクは画面と同じ書き方にする。上流の `N` は「ランクが付いていない」ことを
     * 表す番兵で等級ではない（SPEC §2）ので、表計算にそのまま渡すと「N という等級」
     * と読める（2026-09-23 実測: 将来締切 917 行の CSV に `N` が 271 マス出ていた。
     * 画面と行の詳細は同じ所を「評価なし」と出している）。体系その物が無い欄は
     * 空のまま出す（「評価なし」と「収録で未追跡」を混ぜない）。 */
    const csvRank = (value: unknown): string => {
      const text = String(value ?? "").trim();
      if (!text) return "";
      return RANK_ABSENT_GRADES.indexOf(text.toLowerCase()) >= 0 ? RANK_UNRATED_LABEL_JA : text;
    };
    // 画面が「未確認」「該当なし」と出す項目も、この列が引き受ける（値の列は空のまま）。
    const status = statusBadgeWords(ed, dl).concat(unconfirmedFieldsJa(row)).join("・");
    const place = placeJa(ed.place) || String(ed.place || "");
    // 分野は画面と同じ日本語の語を書く（英字の key を表計算に渡さない）。
    const catsJa = (
      (row.cats as string[] | undefined) ||
      (conf.categories as string[] | undefined) ||
      []
    )
      .map((c: string) => categoryLabelJa(c))
      .join("・");
    return [
      when,
      official,
      left,
      // 会議名は画面と同じ式（年を添え、title が無ければ key）。CSV には年の列が
      // 無いので、素の title を書くと表計算で画面と同じ名前が引けない。
      titleWithYearJa(conf.title || conf.key || "", ed.year),
      catsJa,
      kindLabelJa(kind),
      dl.round == null ? "" : `R${dl.round}`,
      csvRank(rank.ccf),
      csvRank(rank.core),
      csvRank(rank.thcpl),
      // 会期は画面と同じ式（一覧・行の詳細・CSV で `eventCellJa` を共有する）。
      eventCellJa(row),
      place,
      status,
      /* URL は文字列として渡す（`csvField` は何でも字にするので、以前は素の値を渡していた –
       * 欄を組み立てる関数が `string[]` を返すようになったので、ここで字にする）。 */
      String(ed.link || conf.link || ""),
    ];
  }

  function deadlinesToCsv(
    rows: readonly Record<string, unknown>[] | null | undefined,
    nowMs: number,
  ): string {
    const lines: string[] = [CSV_HEADERS_JA.join(",")];
    (rows || []).forEach((row) => {
      lines.push(csvDeadlineCells(row, nowMs).map(csvField).join(","));
    });
    return `${lines.join("\r\n")}\r\n`;
  }

  const RECOMMEND_CSV_HEADERS_JA = [
    // 画面のカードの札と同じ語（`fitLabel` の 3 語）。
    "一致評価",
    // 並べ替えに使う数なので、見出しに「点」まで書く（「一致」だけだと何の数か分からない）。
    "一致の点",
    // 内訳の 2 本（欄の並びは行の詳細と同じ順）。
    "言葉の一致",
    "意味の近さ",
    ...CSV_HEADERS_JA,
  ];

  function candidateRowsToCsv(
    rows: readonly Record<string, unknown>[] | null | undefined,
    nowMs: number,
  ): string {
    const lines: string[] = [RECOMMEND_CSV_HEADERS_JA.join(",")];
    (rows || []).forEach((row) => {
      /* 評価の語は候補の行が持つ値をそのまま書く（`_fitLabel` は `fitLabel` が付けた物で、
       * 画面のカードの札と同じ 1 語）。 */
      const 評価 = String(row._fitLabel || "").trim();
      const 數 = (value: unknown): string => (typeof value === "number" ? String(value) : "");
      /* 意味の近さは 0 を書かない（画面も「意味の近さ 0点」とは出さない – 札の内訳は
       * 0 より大きい時だけ並ぶ）。意味検索を使へん環境では全行が空に成り、「測つて 0」と
       * 「測つて居ない」が同じ数字に成らない。言葉の一致は逆に行の詳細が 0 点と書くので、
       * 0 もそのまま書く。 */
      const 意味の近さ =
        typeof row._semScore === "number" && row._semScore > 0 ? String(row._semScore) : "";
      lines.push(
        [
          評価,
          數(row._matchScore),
          數(row._vocabScore),
          意味の近さ,
          ...csvDeadlineCells(row, nowMs),
        ]
          .map(csvField)
          .join(","),
      );
    });
    return `${lines.join("\r\n")}\r\n`;
  }

  /* SPEC §7: 暦日だけの値に曜日を添える。`YYYY-MM-DD` を UTC の暦日として読み、
   * 閲覧者のタイムゾーンでシフトさせない（date-only の締切は UTC/JST/AoE に
   * 変換しないという §4 の約束を守るため、瞬間を作らず部分文字列から取る）。 */
  const CALENDAR_DATE_JA = ["日", "月", "火", "水", "木", "金", "土"];

  function weekdayJaFromDate(value: unknown): string {
    const raw = typeof value === "string" ? value.trim() : "";
    const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!matched) return "";
    const y = Number(matched[1]);
    const m = Number(matched[2]);
    const d = Number(matched[3]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return "";
    const instant = new Date(Date.UTC(y, m - 1, d));
    // Date.UTC は範囲外の日付を翌月に繰り越す（2026-13-45 が読めてしまう）。
    // 読み直した暦日が元値と一致するときだけ曜日を返す。
    if (
      instant.getUTCFullYear() !== y ||
      instant.getUTCMonth() + 1 !== m ||
      instant.getUTCDate() !== d
    )
      return "";
    return CALENDAR_DATE_JA[instant.getUTCDay()];
  }

  /* SPEC §7: 検索の照合は日本語入力に現れる表記ゆれを吸収する。
   * - 全角英数・全角記号は NFKC で半角に寄せる（「ＮＳＤＩ」を "nsdi" と同じ扱いにする）。
   * - 全角スペースも半角スペースに畳む（「ネットワーク　システム」で語が割れた扱いになるのを防ぐ）。
   * - 大文字小文字は無視する。
   * hay を作る側でも同じ正規化を通し、照合側だけがズレることがないようにする。 */
  /* NFD の分解では片付かない英文字（`ł` `ø` `ß` など）。ASCII で打つ人と合わせる。 */
  const DIACRITIC_FOLD_JA: Record<string, string> = {
    ł: "l",
    đ: "d",
    ø: "o",
    œ: "oe",
    æ: "ae",
    ß: "ss",
    þ: "th",
    ð: "d",
    ı: "i",
    ğ: "g",
    ș: "s",
    ț: "t",
    ż: "z",
    ź: "z",
    ć: "c",
    ń: "n",
    ť: "t",
    ě: "e",
    ů: "u",
  };
  const DIACRITIC_FOLD_CHARS = /[łđøœæßþðığșțżźćńťěů]/g;
  /* NFD を掛けるのは英文字だけに限る。日本語にかけてはいけない（`パ` が
   * `ハ` + 半濁点に分解され、件数欄の寄せ説明で利用者が打った語をそのまま
   * 見せるときに、見た目は同じで別の文字列になる）。 */
  const LATIN_DIACRITIC_CHARS = /[\u00c0-\u00ff\u0100-\u017f\u0180-\u024f\u1e00-\u1eff]/g;
  const COMBINING_MARKS = /[\u0300-\u036f]/g;

  /* アクセント記号は落とす。収録する開催地のつづりは `Montréal` `Malmö` `Kraków` のように
   * 現地表記で書かれていて（実測 118 行がアクセント付き英文字を含む）、日本人が打つ
   * ASCII ローマ字（`montreal` `malmo` `krakow`）とは 1 文字だけ違う。そのままでは
   * 画面に見える地名が引けない。NFKC だけでは é が分解されないので NFD にしてから
   * 合成記号を落とす。検索語・行の両方がこの関数を通るので、どちらで打っても同じ結果になる。
   * 表示（開催地セル）は公式表記のまま変えない。 */
  /* メーリングリストで CFP のリンクを受け取った人が、その URL を検索欄に貼って収録確認を
   * していた（2026-09-23 実測: 「https://warwick.ac.uk/fac/sci/dcs/aamas2027/」をそのまま貼る
   * と 0 行で、収録されていないと誤解していた）。会議の検索語に公式ページのホスト名の成分を
   * 足す。パスの語（fac・sci・index など）は他の語と衝突して誤爆の種になるだけなので入れない。
   * `www` も除く（どの会議でも同じ語になるので絞り込みにならない）。 */
  function hostFromUrl(value: unknown): string {
    let rest = typeof value === "string" ? value.trim() : "";
    if (!rest) return "";
    const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(rest);
    if (scheme) rest = rest.slice(scheme[0].length);
    rest = rest.replace(/^[^/@?#]*@/, "");
    const boundary = rest.search(/[/?#]/);
    if (boundary >= 0) rest = rest.slice(0, boundary);
    return rest.replace(/:\d+$/, "");
  }

  function hostLabels(host: unknown): string[] {
    const text = typeof host === "string" ? host : "";
    return (
      text
        .toLowerCase()
        .split(".")
        .map((part) => part.trim())
        // 2 文字以下の成分（`ac`・`uk`・`jp`・`co`）は落とす。どの会議のドメインにも出る語なので、
        // 入れると「SC」のような短い略称の検索がドメインで誤爆する（2026-09-23 実測: 45 行が
        // 47 行になった）。照合側も同じ表を通るので、URL を貼った検索はそのまま引ける。
        .filter((part) => part.length >= 3 && part !== "www")
    );
  }

  function linkSearchTerms(link: unknown): string {
    return hostLabels(hostFromUrl(link)).join(" ");
  }

  const KANJI_VARIANT_FOLD_JA: Record<string, string> = {
    〆: "締",

    迄: "まで",

    會: "会",
    學: "学",
    發: "発",
    檢: "検",
    對: "対",
    經: "経",
    應: "応",
    圖: "図",
    實: "実",
    單: "単",
    處: "処",
    數: "数",
    讓: "譲",
    歸: "帰",
    錄: "録",
  };
  const KANJI_VARIANT_FOLD_CHARS = /[〆迄會學發檢對經應圖實單處數讓歸錄]/g;

  const KATAKANA_HYPHEN_CHARS = /(?<=[\u30a1-\u30fa\u30fc])[-−‐‑–—~\u301c](?![a-z0-9])/g;

  function searchNormalize(value: unknown): string {
    const raw = typeof value === "string" ? value : value == null ? "" : String(value);
    let folded = typeof raw.normalize === "function" ? raw.normalize("NFKC") : raw;
    if (typeof folded.normalize === "function") {
      folded = folded.replace(LATIN_DIACRITIC_CHARS, (ch) =>
        ch.normalize("NFD").replace(COMBINING_MARKS, ""),
      );
    }
    folded = folded.replace(DIACRITIC_FOLD_CHARS, (ch) => DIACRITIC_FOLD_JA[ch] || ch);
    folded = folded.replace(KANJI_VARIANT_FOLD_CHARS, (ch) => KANJI_VARIANT_FOLD_JA[ch] || ch);

    folded = folded.replace(KATAKANA_HYPHEN_CHARS, "ー");
    return folded.toLowerCase().replace(/\s+/g, " ").trim();
  }

  /* 検索語は空白区切りの複数語として扱う。日本語で「ネットワーク 仮想化」のように
   * 語を並べて打つ利用者が多く、連結文字列そのものを haystack の中を探すでは当たらない。
   * 全語が含まれるときだけ一致とみなす（AND）。 */
  /* 検索語の両端の句読点だけ落とす。md の表をそのまま貼る利用（「締切: Tutorial
   * Proposal Deadline」）で、語そのものが入った token にならないと当たらないため。
   * `C++` のように記号が語の一部のものは壊したくないので、記号は列挙する。 */
  const QUERY_EDGE_PUNCTUATION =
    /^[。、，．・：:；;！？!？」』）)】\]]+|[。、，．・：:；;！？!？」』）)】\]]+$/g;

  /* 助詞は語の区切りとして読む（第 … – 実測と理由は第 723 回に SPEC へ送つた。*/
  const QUERY_PARTICLE_SPLIT_CHARS = "のもへがをやをでには";

  let 分野語彙Ja: Map<string, string> | null = null;

  /** 畳んだ形 → 画面と行に出る表層形（片仮名を平仮名に畳んだ形で照合すると 0 行になる – 実測）。 */
  function 分野語彙Ja取得(): Map<string, string> {
    if (分野語彙Ja) return 分野語彙Ja;
    const 集 = new Map<string, string>();
    const 足す = (語: string) => {
      const 表層 = searchNormalize(語);
      const 形 = kanaFold(表層);
      if (形.length >= 2 && 形.indexOf(" ") < 0 && !集.has(形)) 集.set(形, 表層);
    };
    /* 語彙は三つの正本から集める – 画面に分野語として出す表（`TAG_LABELS_JA`）、
       寄せ表（`QUERY_SYNONYMS_JA` – 打ち方の語とその寄せ先）、検索語の英訳表（`JP_EN`）。
       その方の表に無い語（`AI倫理` の `倫理` の様な物）は割らない – 行から勝手に語を作らない。 */
    Object.keys(TAG_LABELS_JA).forEach((語) => {
      足す(語.replace(/-/g, ""));
      足す(TAG_LABELS_JA[語] as string);
    });
    QUERY_SYNONYMS_JA.forEach((条目) => {
      [条目[0]].concat(条目[2]).forEach((語) => {
        足す(語);
      });
    });
    Object.keys(JP_EN).forEach((語) => {
      足す(語);
    });
    分野語彙Ja = 集;
    return 集;
  }

  let 他の規則で受ける語Ja: Set<string> | null = null;
  let 種別への寄せ語Ja: Set<string> | null = null;

  function 他の規則で受ける語かJa(形: string): boolean {
    if (!他の規則で受ける語Ja) {
      他の規則で受ける語Ja = new Set(
        Object.keys(querySynonymMap()).map((語) => kanaFold(searchNormalize(語))),
      );
    }
    return 他の規則で受ける語Ja.has(形);
  }

  function 種別への寄せ語かJa(形: string): boolean {
    if (!種別への寄せ語Ja) {
      const 表 = querySynonymMap();
      const 集 = new Set<string>();
      Object.keys(表).forEach((語) => {
        const 案内 = 表[語][0];
        if (案内.startsWith("種別") || 案内.startsWith("列") || 案内.startsWith("締切の回"))
          集.add(kanaFold(searchNormalize(語)));
      });
      種別への寄せ語Ja = 集;
    }
    return 種別への寄せ語Ja.has(形);
  }

  /** 分野の語を繋げた打ち方を、語彙表の語に割る（割れなければ元の語のまま返す）。 */
  function 分野の複合に割るJa(token: string): string[] {
    const 語彙 = 分野語彙Ja取得();
    const 表層 = searchNormalize(token);
    const 全体 = kanaFold(表層);
    if (全体.length < 4 || 語彙.has(全体)) return [token];
    /* 最も語数の少ない割方を探す – 長い語で取れる方はその方の語なので、細かく割らない。 */
    const 上限 = 10;
    const 最善: Array<string[] | null> = new Array<string[] | null>(全体.length + 1).fill(null);
    最善[0] = [];
    for (let i = 1; i <= 全体.length; i += 1) {
      for (let j = Math.max(0, i - 上限); j < i; j += 1) {
        const 断片 = 全体.slice(j, i);
        if (断片.length < 2) continue;
        const 表層断片 = 語彙.get(断片);
        if (!表層断片) continue;
        const 前 = 最善[j];
        if (!前) continue;
        const 候補 = 前.concat([表層断片]);
        const 今 = 最善[i];
        if (!今 || 候補.length < 今.length) 最善[i] = 候補;
      }
    }
    const 割れた = 最善[全体.length];
    if (!割れた || 割れた.length < 2) return [token];

    if (他の規則で受ける語かJa(全体)) return [token];

    if (割れた.some((断片) => 種別への寄せ語かJa(kanaFold(searchNormalize(断片))))) return [token];
    return 割れた;
  }

  const 数値の相対日の形Ja =
    /^(?:[0-9]{1,4}(?:日|か月|カ月|ヵ月|ヶ月|ケ月|箇月|年)|半(?:月|か月|ヶ月|ケ月|カ月|ヵ月|箇月))(?:後|前)$/;

  function 相対日の寄せ形Ja(前: string, 語: string, 語尾: string): string {
    if (!前 || !語) return "";
    const 詰 = 幅の漢数字を寄せるJa(`${前}${語}${語尾}`);
    if (数値の相対日の形Ja.test(詰)) return 詰;

    if (語尾 === "" && 前 === "半" && /^(?:年後|年前)$/.test(語)) return 詰;
    return "";
  }

  function 解ける日語かJa(語: string, 頭が決まつてるか = false): boolean {
    if (!語) return false;
    if (暦日に解くJa(語)) return true;
    const 柄 = dateTokenStemJa(語) || 語;
    if (typeof RELATIVE_DAY_OFFSETS_JA[柄] === "number") return true;

    if (/^[上中下]旬$/.test(柄)) return true;

    if (頭が決まつてるか && /^(?:[0-9]{1,2}日|[上中下]旬|最終週|最後の週)$/.test(語)) return true;
    return (
      /* 週の語に曜日を繋げた形は、**「… – 実測と理由は第 723 回に SPEC へ送つた。*/
      /^(?:今週|こんしゅう|来週|らいしゅう|再来週|先週|先々週)(?:[月火水木金土日]曜(?:日)?|末|中|土日|週末|平日)?$/.test(
        柄,
      ) ||
      /^[月火水木金土日]曜(?:日)?$/.test(柄) ||
      /* 季節の語もその方の規則が暦月語に解くので、並べた形が解ける –
       * それ以外の語（`人と機械` の様な打ち方）を列挙にしない為の目印は上の検査。 */
      /^(?:春|夏|秋|冬|通年|年初夏|真冬)$/.test(語) ||
      /^(?:[0-9]{1,2}月|今月|来月|先月)(?:上旬|中旬|下旬|最終週|最後の週|半分)?$/.test(語) ||
      /^[0-9]{4}年[0-9]{1,2}月(?:[上中下]旬|最終週|最後の週)?$/.test(語) ||
      /^(?:今月|来月|再来月|先月|昨月|先々月|翌月|前月)[0-9]{1,2}日$/.test(語) ||
      数値の相対日の形Ja.test(柄) ||
      数値の相対日の形Ja.test(語)
    );
  }

  function 幅の語を割らないかJa(語: string): boolean {
    const 区切り = 幅の区切りJa.exec(語);
    if (!区切り) return false;
    return 解ける日語かJa(区切り[1]) && 解ける日語かJa(区切り[2]);
  }

  function 全行の語尾に割るJa(語: string): string[] {
    const 語尾一覧 = Array.from(
      new Set(
        WHOLE_TABLE_QUERY_JA.map((word) => searchNormalize(String(word))).filter(
          (word) => word.length >= 2,
        ),
      ),
    ).sort((甲, 乙) => 乙.length - 甲.length);
    const 元 = String(語 || "");
    if (語尾一覧.indexOf(searchNormalize(元)) >= 0) return [元];

    if (他の規則で受ける語かJa(kanaFold(searchNormalize(元)))) return [元];
    let 残余 = 元;
    const 語々: string[] = [];

    while (残余.length >= 3) {
      const 形 = searchNormalize(残余);
      const 語尾 = 語尾一覧.find((word) => 形.endsWith(word) && 形.length - word.length >= 1);
      if (!語尾) break;

      if (解ける日語かJa(残余.slice(0, 残余.length - 語尾.length))) break;
      語々.unshift(語尾);
      残余 = 残余.slice(0, 残余.length - 語尾.length);
    }
    if (!語々.length) return [残余];
    if (残余) 語々.unshift(残余);
    return 語々;
  }

  function 締切の語尾に割るJa(語: string): string[] {
    /* 第 514 回と同じ決まりで、表はこの関数の中で作る（抜き出し検査がこの関数だけを外して
     * 動かす為）。打たれた語は正規化の後の姿で入るので、同じ目で寄せる。*/

    /* `日程` `学会` を足した– 単体で行を持つ語尾のみ（実測の数字は SPEC §8）。*/

    const 語尾一覧 = "締切|提出|投稿|deadline|abstract|登録|学会|日程|結果|通知"
      .split("|")
      .map((word) => searchNormalize(String(word)));
    const 頭一覧 = new Set(
      [
        "デモ",
        "デモ発表",
        "ポスター",
        "ポスター発表",
        "チュートリアル",
        "ワークショップ",
        "セッション",
        "特別セッション",
        "招待講演",
        "抄録",
        "アブストラクト",
        "論文",
        "査読",
        "採択",

        "機械学習",
        "HPC",
        "自然言語処理",
        "データベース",
        "ネットワーク",
        "計算論言語学",
        "セキュリティ",
        /* 提出・投稿その物 – 実測で `提出締切` **0 行・案内も無し**（単体では 457 行 – 寄せ表が
         * 種別『論文締切』へ導く）で、研究者が最も書く打ち方。頭に載せると `提出 ∧ 締切` に割れて
         * その寄せが届く（実測 457 行）。`投稿締切` は寄せ表に載つた形なのでこの方の門が彈く
         * （実測 457 行の侭・案内も「『投稿締切』は種別「論文締切」で探しています」の侭）。*/
        "提出",
        "投稿",
        "登録",
        "学生",
        "カメラレディ",

        "会議",
        "大会",
        "国際会議",

        "AI",
        "クラウド",
        "組み込み",
        "symposium",
        "シンポジウム",
        "スパコン",
        "通信",
        "年次",
        "暗号",
        "暗号論",
        "分散",
        "研究会",
        "統計",
        "量子",
        "最適化",
        "ソフトウェア",
        "ロボティクス",
        "IoT",
        "特集号",
        "最終原稿",
        "最終稿",
        "学生発表",
        "発表",
        "通知",
        "情報理論",
        "高性能計算",
      ]
        .map((word) => kanaFold(searchNormalize(String(word))))
        .filter((word) => word.length >= 2),
    );
    const 元 = String(語 || "");
    /* 語その物が語尾の語（`締切`）や、その方の規則がそのままの語を受ける形（`早期締切`
     * `投稿締切` `論文募集` の九形）なら割らない。第 514 回と同じ門。*/
    if (語尾一覧.indexOf(searchNormalize(元)) >= 0) return [元];
    if (他の規則で受ける語かJa(kanaFold(searchNormalize(元)))) return [元];
    let 残余 = 元;
    let 割つた = false;
    const 語々: string[] = [];

    for (;;) {
      const 形 = kanaFold(searchNormalize(残余));
      const 語尾 = 語尾一覧.find((word) => 形.endsWith(word) && 形.length - word.length >= 2);
      if (!語尾) break;
      const 頭 = 残余.slice(0, 残余.length - 語尾.length);

      語々.unshift(語尾);
      割つた = true;
      残余 = 頭;
    }
    /* 残つた頭が上の語彙に載つている時だけ、その割方を使う – 載つて居ない語（`システム`
     * `オンライン` `延長` の類）は上の注の通り、その方の規則が受ける形なので割らない。*/
    if (!割つた || !頭一覧.has(kanaFold(searchNormalize(残余)))) return [元];
    語々.unshift(残余);
    return 語々;
  }

  function 訪ねの語尾に落とすいつJa(語: string): string[] {
    const 元 = String(語 || "");
    if (!元.startsWith("いつ") || 元 === "いつ" || 元 === "いつですか") return [];
    if (他の規則で受ける語かJa(kanaFold(searchNormalize(元)))) return [];
    const 語尾 = 元.slice(2);
    const 訪ねの語尾 = new Set([
      "ありますか",
      "あるの",
      "分かる",
      "わかる",
      "わかります",
      "分かります",
      "知りたい",
      "しりたい",
      "知りたく",
      "教えて",
      "おしえて",
      "頃",
    ]);
    if (!訪ねの語尾.has(語尾)) return [];
    return ["いつ"];
  }

  let 寄せ表の和名の鍵cache: Record<string, true> | null = null;
  function 寄せ表の和名か(token: string): boolean {
    if (!寄せ表の和名の鍵cache) {
      const m: Record<string, true> = {};
      PLACE_QUERY_ALIASES_JA.concat(TOPIC_QUERY_ALIASES_JA).forEach((対) => {
        const 和名 = String(対[0] || "");
        if (和名) m[kanaFold(和名)] = true;
      });
      寄せ表の和名の鍵cache = m;
    }
    return 寄せ表の和名の鍵cache[kanaFold(String(token || ""))] === true;
  }

  function splitQueryToken(token: string, nowMs?: number): string[] {
    if (寄せ表の和名か(String(token || ""))) return [token];

    /* 両側の日が決まる幅は語ごと残す（それ以外 – `東京へ` の様な打ち方は今まで通り割る）。 */

    const ISOのT型Ja =
      /^([0-9]{4}-[0-9]{2}-[0-9]{2})[tT]([0-9]{1,2}):([0-9]{2})(?::[0-9]{2})?[zZ]?$/.exec(
        String(token || ""),
      );
    if (ISOのT型Ja && Number(ISOのT型Ja[2]) <= 23 && Number(ISOのT型Ja[3]) <= 59)
      return [ISOのT型Ja[1], `${Number(ISOのT型Ja[2])}:${ISOのT型Ja[3]}`];

    const 日の頭の形Ja =
      /^(?:今日|明日|明後日|明々後日|あさって|昨日|一昨日|来週|今週|再来週|先週|先々週|週末|今週末|来週末|来月|今月|先月|来年|今年|去年|月末|月初|上旬|中旬|下旬|年末|年始|[0-9]{1,2}月[0-9]{1,2}日|[0-9]{1,2}日|[0-9]{1,2}月|[月火水木金土日]曜日?|(?:(?:来|今|再々?|先々?)?(?:周|週))(?:月|火|水|木|金|土|日|曜)日)$/;

    const 日付境界Ja =
      /^(.+?)((?:(?:午前|午後|ごぜん|ごご)?(?:[0-9]{1,2}|[〇零一二三四五六七八九十]{1,3})時(?:[0-9]{1,2}分|半)?(?:以降|より|から|前|前に)?|正午|[0-9]{1,2}:[0-9]{2}(?:以降|より|から|前|前に)?)(?:に)?|[0-9]{1,2}時台|(?:(?:午前|午後|ごぜん|ごご)?[0-9]{1,2}(?::[0-9]{2})?(?:時(?:台)?)?(?:[-−ー~〜～－―‐](?:[0-9]{1,2}(?::[0-9]{2})?時?|午前|午後|正午)|台)?|(?:(?:午前|午後|ごぜん|ごご)?[0-9]{1,2}(?::[0-9]{2})?|正午)(?:まで|までに|前から)?)(?:に|で)?|午前中|午後中|午前|午後|正午|JST|UTC|GMT|jst|utc|gmt|日本時間|世界標準時|協定世界時)$/.exec(
        String(token || ""),
      );
    const 頭Ja = 日付境界Ja
      ? 日の頭の形Ja.test(日付境界Ja[1]) ||
        /* 裸の時刻の後ろに付く語尾の時刻帯（`17時JST` – 第 444 回 – 空格を挟んだ
         * `17時 JST` は二語の交わりで通るのに繋げた形だけ黙つていた）。 */
        /^(?:午前|午後)?(?:[0-9]{1,2}|[〇零一二三四五六七八九十]{1,3})時(?:[0-9]{1,2}分|半)?$/.test(
          日付境界Ja[1],
        ) ||
        (Number.isFinite(nowMs as number) &&
          pressedWeekdayJa(日付境界Ja[1], nowMs as number) !== null &&
          日付境界Ja[1] !== String(token || "")) ||
        (Number.isFinite(nowMs as number) &&
          pressedMonthDayJa(日付境界Ja[1], nowMs as number) !== null) ||
        eraYearTermsJa(日付境界Ja[1]) !== null ||
        (Number.isFinite(nowMs as number) && 暦日に解くJa(日付境界Ja[1]) !== null)
      : false;
    if (日付境界Ja && 頭Ja) return [日付境界Ja[1], 日付境界Ja[2]];

    const 暦日境界Ja =
      /^(\d{4}(?:[-/.]\d{1,2}){1,2}|(?:\d{1,2}[-/.]\d{1,2}|\d{4}年\d{1,2}月)?)((?:の)?(?:以降|以後|以来|この先|までに|まで|より前|より前に|以前|前から|前|後|後で|後から))$/;
    if (Number.isFinite(nowMs as number) && 暦日境界Ja.test(String(token || ""))) {
      const 割 = 暦日境界Ja.exec(String(token || "")) as RegExpExecArray;
      /* 点で書く暦日（`2026.7.1`）は上の目が受けるがその方の語の目が数えて居ないので
       * 切りへ寄せてから解く（解ける形だけ通す – 締切の推測はしない）。 */
      const 芯 = String(割[1] || "").replace(/\./g, "/");

      if (暦日に解くJa(芯) !== null) return [芯 + String(割[2] || "")];
    }
    if (幅の語を割らないかJa(String(token || ""))) return [token];

    if (列挙の語に割るJa(String(token || ""))) return [token];

    const 英文字の部の列Ja = String(token || "").split("と");
    if (
      英文字の部の列Ja.length >= 2 &&
      /^[a-z0-9+#.-]+$/i.test(英文字の部の列Ja[0]) &&
      英文字の部の列Ja.every((部) => 部.length >= 2 || /^[a-z0-9+#]+$/i.test(部))
    ) {
      return 英文字の部の列Ja;
    }

    const 動詞の目Ja = /(?:できますか|できかねます|できます|できる|出来る)/;
    if (動詞の目Ja.test(String(token || ""))) {
      const 部 = String(token)
        .split(動詞の目Ja)
        .filter((部) => 部.length > 0);
      if (部.length >= 1 && 部.every((部) => 部.length >= 2))
        return 部.flatMap((部) => splitQueryToken(部, nowMs));
    }

    /* 括弧は**捕さん括弧**にしないと、`split` が目その物を部として返してしまふ –
     * 「される」が自分の部に掛かつて無限に淺くなる。*/

    const 軽い動詞Ja = [
      "されています",
      "されてい",
      "されてます",
      "しております",
      "しています",
      "してます",
      "されました",
      "されて",
      "される",
      "されます",
      "しました",
      "しますか",
      "します",
      "され",
    ];
    let 受け身 = String(token || "");
    let 落した = false;
    for (let 度 = 0; 度 < 3; 度++) {
      const 目 = 軽い動詞Ja.find((語) => 受け身.endsWith(語));
      if (!目) break;
      const 残 = 受け身.slice(0, 受け身.length - 目.length);
      if (残.length < 2) break;
      受け身 = 残;
      落した = true;
    }
    if (落した && 受け身.length >= 2 && 受け身 !== token) {
      return [受け身].flatMap((部) => splitQueryToken(部, nowMs));
    }
    let 助詞々 = QUERY_PARTICLE_SPLIT_CHARS;
    if (token.indexOf("まで") >= 0) {
      /* `締切までの30日` は `の` でも割れてそれ迄 0 行だった（実測） – 期日を訊く語は
         語ごと残す方が正しい（その方の形はその側の規則が幅に解く）。 */
      助詞々 = 助詞々.replace("で", "").replace("の", "");

      const 幅の日数を含む頭 =
        /^(?:今日から|(?:締切|締め切り|〆切|しめきり)までに?の?|(?:締切|締め切り|〆切|しめきり)から)/;
      if (/までに$/.test(token) || 幅の日数を含む頭.test(token)) 助詞々 = 助詞々.replace("に", "");
    }
    const parts = token.split(new RegExp(`[${助詞々}]`)).filter((part) => part.length > 0);
    /* 分けた語が 2 つ以上で、それぞれ 2 文字以上のときだけ採用する。ひらがなの地名は
     * 助詞と同じ字を語の中に持っている（実測: `ながさき` は `が` で割れて `な` + `さき` に、
     * `やまぐち` は `や` が取れて `まぐち` になった – どちらも 1 行も当たらなくなる）。
     * そのような分割は捨てて、打たれた語をそのまま使う。 */
    /* 助詞で割れなかった語でも、分野の語を繋げた名詞なら其処で割る。 */
    if (parts.length < 2) {
      const 語尾割 = 全行の語尾に割るJa(token);
      if (語尾割.length >= 2) return 語尾割;
      /* 語の末尾が締切の語なら、そこで割る。分野の複合の割りの前に見る –
         催し物の名前＋締切（`デモ締切`）は分野の語の繋がりでは無い。*/
      const 締切語尾割 = 締切の語尾に割るJa(token);
      if (締切語尾割.length >= 2) return 締切語尾割;

      const 訪ね割 = 訪ねの語尾に落とすいつJa(token);
      if (訪ね割.length >= 1) return 訪ね割;

      const 尾の開催Ja = /^(.{1,}?)開催$/.exec(String(token || ""));
      /* 頭の語が一文字で足りるのは季節の語だけ – `の開催` のやうに助詞を落とした形は
       * 品書 2,669 行に当る語になって了う。*/
      const 頭Ja2 = 尾の開催Ja ? String(尾の開催Ja[1]) : "";
      if (
        尾の開催Ja &&
        (頭Ja2.length >= 2 || SEASON_MONTHS_JA[頭Ja2] !== undefined) &&
        !他の規則で受ける語かJa(kanaFold(searchNormalize(String(token || ""))))
      )
        return [頭Ja2];
      return 分野の複合に割るJa(token);
    }
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i].length < 2 && SEASON_MONTHS_JA[parts[i] as string] === undefined) {
        return [token];
      }
    }

    const 複合 = parts.flatMap((part) => 分野の複合に割るJa(part));

    const 落 = 複合.map((part) => 訪ねの語尾に落とすいつJa(String(part))[0] ?? String(part));
    const 詰 = [...new Set(落.filter((part) => part !== ""))];
    // 語を**入れ替へる**割り（`いつありますか` → `いつ`）は長さが変はらないので、中身を見た。
    if (詰.length >= 1 && 詰.some((part, i) => part !== 複合[i])) return 詰;
    return 複合.length >= parts.length ? 複合 : parts;
  }

  function queryTokens(query: unknown, nowMs?: number): string[] {
    const normalized = searchNormalize(query);
    if (!normalized) return [];

    const 相対語の寄せJa: Array<[string, string, string]> = [
      ["明", "日", "明日"],
      ["今", "日", "今日"],
      ["昨", "日", "昨日"],
      ["明", "後日", "明後日"],
      ["明後", "日", "明後日"],
      ["今", "週", "今週"],
      ["来", "週", "来週"],
      ["先", "週", "先週"],
      ["翌", "週", "翌週"],
      ["再", "来週", "再来週"],
      ["再来", "週", "再来週"],
      ["今", "月", "今月"],
      ["来", "月", "来月"],
      ["先", "月", "先月"],
      ["翌", "月", "翌月"],
      ["再", "来月", "再来月"],
      ["再来", "月", "再来月"],
      ["来", "年", "来年"],
      ["今", "年", "今年"],
      ["翌", "年", "翌年"],
    ];
    const seen: string[] = [];
    const 語を足すJa = (part: string) => {
      if (!part) return;
      const 前 = seen.length ? seen[seen.length - 1] : "";
      if (前) {
        const 対 = 相対語の寄せJa.find(([甲, 乙]) => 甲 === 前 && 乙 === part);
        if (対) {
          seen[seen.length - 1] = 対[2];
          return;
        }
      }

      const 助詞で切れたか = /^[とかへのをにではやからよりまで]+$/.test(前);
      const 並べるか =
        /^[0-9]+$/.test(前) ||
        /^[年月日]$/.test(前) ||
        /^[0-9]+[年月日]$/.test(part) ||
        助詞で切れたか;
      if (seen.indexOf(part) < 0 || 並べるか) seen.push(part);
    };
    normalized.split(" ").forEach((raw) => {
      const token = raw.replace(QUERY_EDGE_PUNCTUATION, "");
      if (!token) return;
      splitQueryToken(token, nowMs).forEach(語を足すJa);
    });

    const 訪ねの語かJa = (語: string) =>
      [
        "知りたい",
        "しりたい",
        "知りたく",
        "教えて",
        "おしえて",
        "分かる",
        "わかる",
        "わかります",
        "分かります",
        "あるの",
        "ありますか",
      ].includes(語);
    const 訪ねの語尾を剥ぐJa = (語: string): string => {
      // 語の末尾が訪ねの語で、そこより前が空かぬ時だけ剥ぐ（第 523 回 – 実測で
      // `査読について知りたい` は `ついて知りたい` が一語のまま残つて 0 行だつた）。
      if (語.length < 4) return 語;
      const 語尾 = [
        "知りたい",
        "しりたい",
        "知りたく",
        "教えて",
        "おしえて",
        "わかります",
        "分かります",
        "分かる",
        "わかる",
        "あるの",
        "ありますか",
      ];
      for (const 尾 of 語尾)
        if (語.endsWith(尾) && 語.length > 尾.length + 1) return 語.slice(0, -尾.length);
      return 語;
    };
    const 埋め木 = ["ついて", "について", "こと", "ため", "もの"];
    const 残り = seen
      .map((語) => 訪ねの語尾を剥ぐJa(String(語)))
      .filter((語) => !訪ねの語かJa(語) && !埋め木.includes(語));
    // 落ちる先が無い時は落とさない – 品書全部を出すのは噓。
    if (残り.length > 0) return 残り;
    return seen;
  }

  /* 「12月締切の会議だけ」のように月で探す利用者が多い。会期は国際会議だと英語表記
   * （`June 7-11, 2027`）なので `6月` では当たらない。締切（JST の暦日）と会期の
   * 開始・終了から和暦風の月語を hay に足す（`2026年12月 12月`）。
   * 瞬間から月を引くときは JST の暦日で読む（一覧の日時列と同じ）。
   * `YYYY-MM-DD` の文字列は閲覧者のタイムゾーンに依存せず、そのまま暦日として読む。 */
  function calendarDateJa(value: unknown): number[] | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      const jst = new Date(value + 9 * 3_600_000);
      return [jst.getUTCFullYear(), jst.getUTCMonth() + 1, jst.getUTCDate()];
    }
    const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
    if (!matched) return null;
    const year = Number(matched[1]);
    const month = Number(matched[2]);
    const day = Number(matched[3]);
    // `weekdayJaFromDate` と同じ検査。`Date.UTC` は 2月30日のような値を翌月へ繰り越す
    // ので、読み直した暦日が元値と一致するときだけ認める。
    const check = new Date(Date.UTC(year, month - 1, day));
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() + 1 !== month ||
      check.getUTCDate() !== day
    )
      return null;
    return [year, month, day];
  }

  function monthTermsJa(value: unknown): string {
    const ymd = calendarDateJa(value);
    if (!ymd) return "";
    const year = ymd[0];
    const month = ymd[1];
    if (month < 1 || month > 12) return "";
    return `${year}年${month}月 ${month}月`;
  }

  /* 暦日でも引けるようにする。「明日の締切」「8月10日」は月より細かく言う形で、
   * 実測では ISO 暦日を含む行が既定画面 477 行中 12 行しかなく、`8月10日` はもちろん
   * 「明日」「今週」も 1 件も当たらなかった。締切（JST の暦日）から
   * `2026年8月10日 8月10日` を hay に足す。
   * 会期は締切ではないので足さない（表は締切で並び、締切までで絞る）。 */
  /* 一覧の日付欄は JST の曜日を「(土)」の一文字で出している（2026-09-23 実測: 既定画面
   * 478 行は全て曜日付き。月55・火76・水69・木59・金69・土99・日51）。なのに「金曜日」で
   * 引くと 0 件だった – 画面に出ている語が検索で引けない。
   * ただし一文字（`土`）を語として入れると「土木」「地球」などの表記を巻き込んで誤爆する
   * ので、「土曜」「土曜日」の形で受ける（週末・平日の意的な探し方は
   * `WEEKDAY_QUERY_SYNONYMS_JA` で寄せる）。 */
  const WEEKDAY_TERMS_JA = ["日曜", "月曜", "火曜", "水曜", "木曜", "金曜", "土曜"];

  function weekdaySearchTerms(value: unknown): string {
    // 表示と同じ JST の暦日で曜日を数える（UTC の曜日を混ぜない）。暦日の読み方は
    // 月日・日の語と同じ `calendarDateJa` を使う（ parser を増やさない）。
    const ymd = calendarDateJa(value);
    if (!ymd) return "";
    const term = WEEKDAY_TERMS_JA[new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2])).getUTCDay()];
    return `${term} ${term}日`;
  }

  /* 表示している暦日の JST 正午。並び順・残り日数・CSV の残り列の基準にする
   * （`t` のように幅の端でなく、人が読んだ日付そのもの）。暦日が読めないときは
   * 従来の値に寄り、行を落とさない。 */
  function jstNoonMs(localDate: unknown, fallback: number): number {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(localDate ?? "").trim());
    if (!match) return fallback;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return fallback;
    // JST 正午 = UTC 03:00（`calendarDateJa` が JST の暦日を返すのと同じ基準）。
    const noon = Date.UTC(year, month - 1, day, 3, 0, 0);
    const check = new Date(noon);
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() + 1 !== month ||
      check.getUTCDate() !== day
    )
      return fallback;
    return noon;
  }

  function dayTermsJa(value: unknown): string {
    const ymd = calendarDateJa(value);
    if (!ymd) return "";
    const year = ymd[0];
    const month = ymd[1];
    const day = ymd[2];
    if (month < 1 || month > 12 || day < 1 || day > 31) return "";
    return `${year}年${month}月${day}日 ${month}月${day}日`;
  }

  /* かなのゆらぎを吸収する。国内の会場名は漢字、会議名はカタカナ表記が多く、
   * `ネットワーク` と `ねっとわーく`、`ッ` と `っ` のように表記が揺れる。
   * 比較の直前にかなをひらがなへ畳んで長音符を落とす（`hay` は表示にも使うので変えない）。 */
  const SMALL_KANA_JA: Record<string, string> = {
    ぁ: "あ",
    ぃ: "い",
    ぅ: "う",
    ぇ: "え",
    ぉ: "お",
    ヵ: "か",
    ヶ: "け",
    っ: "つ",
    ゃ: "や",
    ゅ: "ゆ",
    ょ: "よ",
    ゎ: "わ",
  };

  function kanaFold(value: unknown): string {
    const holder = kanaFold as unknown as { kanaFoldCache?: Map<string, string> };
    if (typeof value === "string" && holder.kanaFoldCache) {
      const hit = holder.kanaFoldCache.get(value);
      if (hit !== undefined) return hit;
    }
    let text = searchNormalize(value);
    if (!text) return "";
    text = text.replace(/[\u30a1-\u30fa]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 96));
    text = text.replace(/[ー\u309b\u309c]/g, "");
    text = text.replace(/[ぁぃぅぇぉヵヶっゃゅょゎ]/g, (ch) => SMALL_KANA_JA[ch] || ch);
    if (typeof value === "string") {
      if (!holder.kanaFoldCache) holder.kanaFoldCache = new Map();
      if (holder.kanaFoldCache.size >= 12_000) holder.kanaFoldCache.clear();
      holder.kanaFoldCache.set(value, text);
    }
    return text;
  }

  /* 「来月の締切だけ」は研究計画の立て方でよく言う形なので、相対月を検索語として受け付ける。
   * 展開先は hay に入っている `2026年10月` の形（`monthTermsJa` が作っている語）に合わせる。
   * 基準は JST の暦月（一覧の日時列と同じ）。年跨ぎ（12月 → 翌年1月）に対応する。
   * 展開しなかった語はそのまま残すので、`来月 国内` のような語のかけ算は壊れない。 */
  const RELATIVE_MONTH_OFFSETS_JA: Record<string, number> = {
    今月: 0,
    来月: 1,
    再来月: 2,
    先月: -1,
    昨月: -1,
    先々月: -2,

    翌月: 1,
    前月: -1,
    /* 「今月中の締切をまとめて出したい」は研究計画の立て方で必ず言う形。`中` を足すだけで
     * 0 件になっていた（同じビルドで実測: `今月` 189 件 / `今月中` 0 件、
     * `来月` 241 件 / `来月中` 0 件、`再来月` 186 件 / `再来月中` 0 件）。 */
    今月中: 0,
    来月中: 1,
    再来月中: 2,

    先月中: -1,

    こんげつ: 0,
    らいげつ: 1,
    せんげつ: -1,
    さらいげつ: 2,
    さいげつ: 2,
    こんげつ中: 0,
    らいげつ中: 1,
    せんげつ中: -1,
    さらいげつ中: 2,
  };

  /** 相対月の語 1 つを `YYYY年M月` に解決する。該当しなければ空文字を返す。
   * 基準は JST の暦月（一覧の日時列と同じ）。年跨ぎ（12月 → 翌年1月）に対応する。 */
  function relativeMonthTerm(token: string, nowMs: number): string {
    /* `来月中に` `今月までに` `今月以内` の形で落ちた。`3月以内` は
     * 「3 か月以内」にも読めるので、相対月の語だけを寄せる。 */
    const within = RELATIVE_MONTH_WITHIN.exec(String(token || ""));
    const key = within ? within[1] : dateTokenStemJa(token) || token;
    const offset = RELATIVE_MONTH_OFFSETS_JA[key];
    if (offset === undefined) return "";
    const base = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3_600_000);
    // 月の加算は日付を足さず月だけで行う（1/31 に 1 ヶ月足すと 3/3 になるため）。
    const shifted = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offset, 1));
    return `${shifted.getUTCFullYear()}年${shifted.getUTCMonth() + 1}月`;
  }

  function expandRelativeMonths(query: unknown, nowMs: number): string {
    const normalized = searchNormalize(query);
    if (!normalized) return normalized;
    let changed = false;
    const tokens: string[] = [];
    normalized.split(" ").forEach((token) => {
      /* 相対月の語を含むときだけ書き換える。含まない語は**打たれた形のまま**返す –
       * 助詞で割った形に直すと、展開結果をそのまま画面に書く場所（件数欄の
       * 「検索語『X』」）が利用者の入力と違う文字列になり、説明がちぐはぐになる。 */
      const parts = splitQueryToken(token, nowMs);
      const terms = parts.map((part) => relativeMonthTerm(part, nowMs));
      if (terms.some((term) => term)) {
        tokens.push(
          terms
            .map((term, index) => term || (parts[index] as string))
            .filter((value) => value)
            .join(" "),
        );
        changed = true;
      } else {
        tokens.push(token);
      }
    });
    return changed ? tokens.join(" ") : normalized;
  }

  function relativeMonthPairs(query: unknown, nowMs: number): Array<[string, string]> {
    const normalized = searchNormalize(query);
    if (!normalized) return [];
    const pairs: Array<[string, string]> = [];
    normalized.split(" ").forEach((token) => {
      splitQueryToken(token, nowMs).forEach((part) => {
        const term = relativeMonthTerm(part, nowMs);
        if (term) pairs.push([part, term]);
      });
    });
    return pairs;
  }

  /* 「明日の締切」「今週の締切」も言う。相対月と同じ方針で、表に出す語（暦日）へ
   * クエリ側で展開する。展開先は `dayTermsJa` が hay に入れた形に揃える。 */
  const RELATIVE_DAY_OFFSETS_JA: Record<string, number> = {
    今日: 0,
    きょう: 0,
    本日: 0,
    明日: 1,
    あした: 1,
    あす: 1,
    明後日: 2,
    あさって: 2,
    昨日: -1,
    きのう: -1,

    一昨日: -2,
    おととい: -2,
    明々後日: 3,

    今日中: 0,
    きょう中: 0,
    本日中: 0,
    明日中: 1,
    // 残り欄が今日出す語（過ぎた分と、1 時間以内の分）。この欄の語を貼れるようにする
    // 。`N 日前に終了` は `N日前` として上の数値側で受ける。
    本日終了: 0,
    まもなく: 0,
  };

  /* 週の語。日本では月曜始まりで話すのが普通（「今週中に出す」は月〜日）。
   * 週の語は 7 暦日の OR になるので、文字列展開では作れない（語同士は AND のため、
   * スペースで並べた時点で 0 件になる）。`queryTokenGroups` の 1 グループとして返す。 */
  const RELATIVE_WEEK_OFFSETS_JA: Record<string, number> = {
    今週: 0,
    こんしゅう: 0,
    来週: 1,
    らいしゅう: 1,
    先週: -1,
    せんしゅう: -1,

    翌週: 1,
    前週: -1,

    昨週: -1,
    /* 「今週中に出す」は月〜日の塊のまま話す（上の注と同じ）。`中` を足しただけで
     * 0 件の壁に当たる（同じビルドで実測: `今週` 19 件 / `今週中` 0 件、
     * `来週` 53 件 / `来週中` 0 件）。 */
    今週中: 0,
    こんしゅう中: 0,
    来週中: 1,
    らいしゅう中: 1,
    先週中: -1,
    /* 「再来週」は「来週」の次 – 月曜始まりの数えで今日から 8〜14 日後の塊になる。
     * 対応する月語（`再来月`）は既に通るので、週の語だけ 0 件だった
     * （2026-09-26 実測・2026-08-09 生成ビルドの品書 872 行: `来週` 53 行 / `再来週` **0 行**、
     * `来週中` 53 行 / `再来週中` **0 行**、`先週` 26 行 / `先々週` **0 行**、
     * `再来月` 188 行）。 */
    再来週: 2,
    再々週: 2,
    来々週: 2,
    さいしゅう: 2,
    さらいしゅう: 2,
    再来週中: 2,
    先々週: -2,
    せんせんしゅう: -2,
    先々週中: -2,

    今週内: 0,
    来週内: 1,
    先週内: -1,
  };

  /** 打たれた語がその週を指す言い方か。 */
  function 週の語かJa(語: string): boolean {
    const 文 = String(語 || "");
    if (Object.hasOwn(RELATIVE_WEEK_OFFSETS_JA, 文)) return true;
    /* 『来週中』『来週の内』のやうに位を足した形も同じ週を指す – 位を剥いで表に聞く。 */
    const 位を剥がし = 文.replace(/(?:の)?(?:中|内)$/, "");
    return 位を剥がし !== 文 && Object.hasOwn(RELATIVE_WEEK_OFFSETS_JA, 位を剥がし);
  }

  /** その方の月の十日間の塊を指す語（上旬・中旬・下旬）とその別の言い方か。 */
  function 旬の位かJa(語: string): boolean {
    return /^(?:上旬|中旬|下旬|中頃|中盤|半ば|前半|後半)$/.test(String(語 || ""));
  }

  /* 年の語も同じ形で受ける。「来年の締切はまだ出ていないのか」「今年の締切はぜんぶで
   * 几つなのか」は研究計画の立て方で必ず言う（2026-08-09 生成ビルドで実測: 「来年」は
   * 展開されずにそのまま語として searchNormalize され、hay にその語が無いので **0 件**
   * だった。2027年の締切は 863 行中 435 行あり、実際にはいちばん広い該当がある）。
   * 「来月」と違い 12 か月の OR なので、文字列展開では作れない（語同士は AND）。週の語と
   * 同じく `queryTokenGroups` の 1 グループとして返す。 */
  const RELATIVE_YEAR_OFFSETS_JA: Record<string, number> = {
    今年: 0,
    ことし: 0,
    本年: 0,

    当年: 0,
    前年: -1,
    来年: 1,
    らいねん: 1,
    再来年: 2,
    さらいねん: 2,
    去年: -1,
    きょねん: -1,
    せんねん: -1,
    /* `昨年` だけが表に無く、0 行で件数欄の解決も無かった。 */
    昨年: -1,
    一昨年: -2,
    いとおととし: -2,
    /* 申請書・経理の文脈で「翌年度」「翌年」が普通に出る – 第 330 回の実測で 0 行だった。 */
    翌年: 1,
    よくねん: 1,
    翌々年: 2,
    よくよくねん: 2,
  };

  const YEAR_SPAN_TAIL_JA = /^(.+?)(?:中|中間|かけて|いっぱい|以内)$/;

  function relativeYearKeyJa(token: string): string {
    const q = String(token || "");
    if (RELATIVE_YEAR_OFFSETS_JA[q] !== undefined) return q;
    const matched = YEAR_SPAN_TAIL_JA.exec(q);
    if (matched && RELATIVE_YEAR_OFFSETS_JA[matched[1]] !== undefined) return matched[1];
    return "";
  }

  const FISCAL_YEAR_OFFSETS_JA: Record<string, number> = {
    今年度: 0,
    こん年度: 0,
    来年度: 1,
    らいねんど: 1,
    翌年度: 1,
    よくねんど: 1,
    再来年度: 2,
    去年度: -1,
    前年度: -1,
    ぜんねんど: -1,
    一昨年度: -2,

    年度: 0,
  };

  const FISCAL_YEAR_TAIL_JA = /^(.+?)(?:中|以内|内|に)(?:に)?$/;

  /** 年度のかたまりを、その年度の始まる年（4 月始まり）で返す。解けなければ null。 */
  function fiscalYearBaseJa(token: string, nowMs: number): number | null {
    let q = String(token || "");
    const matched = FISCAL_YEAR_TAIL_JA.exec(q);
    if (matched && FISCAL_YEAR_OFFSETS_JA[matched[1]] !== undefined) q = matched[1];
    const offset = FISCAL_YEAR_OFFSETS_JA[q];
    if (offset === undefined) return null;
    const today = offsetCalendarDay(nowMs, 0);
    /* 基準が 1〜3 月のときは前年度が現在の年度（日本の年度は 4 月始まり）。 */
    return (today[1] >= 4 ? today[0] : today[0] - 1) + offset;
  }

  function fiscalYearTermsJa(token: string, nowMs: number): string[] | null {
    const base = fiscalYearBaseJa(token, nowMs);
    if (base === null) return null;
    return fiscalTermsFromYearJa(base);
  }

  /** 与えた年度（4 月始まり）の 12 か月語。 */
  function fiscalTermsFromYearJa(base: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const month = 4 + i;
      out.push(month <= 12 ? `${base}年${month}月` : `${base + 1}年${month - 12}月`);
    }
    return out;
  }

  /* 基準時刻は要らない – 年号と西暦の対応はその年号が始まった年にだけ決まる（相対的な語と
   * 違って「今年」のような基準を持たない）。 */
  function eraYearTermsJa(token: string): { terms: string[]; 西暦: number; 年度: boolean } | null {
    /* その年号が始まった西暦年と、その年号が続いた最長の年数（元年 = 開始の翌年）。 */
    const 年号の始まり: Record<string, [number, number]> = {
      明治: [1867, 45],
      大正: [1911, 15],
      昭和: [1925, 64],
      平成: [1988, 31],
      令和: [2018, 99],
    };

    /* 月・日まで続ける形（`令和8年8月22日`）も受ける – 和暦の日付で貼り付ける人は多い
     * （実測）。 */
    const 和暦の形 =
      /^(明治|大正|昭和|平成|令和)(?:元年|([0-9]{1,2})年)(度)?((?:[0-9]{1,2})月)?((?:[0-9]{1,2})日)?$/;
    /* `度` を必ず要求する – 付けなければ裸の `2026年`（暦年）を年度に化けさせる
     * 。 */
    const 西暦の年度の形 = /^([0-9]{4})年度$/;
    const 西暦の年度 = 西暦の年度の形.exec(String(token || ""));
    if (西暦の年度) {
      const year = Number(西暦の年度[1]);
      if (!(year >= 1900 && year <= 2200)) return null;
      return { terms: fiscalTermsFromYearJa(year), 西暦: year, 年度: true };
    }
    const matched = 和暦の形.exec(String(token || ""));
    if (!matched) return null;
    const 範囲 = 年号の始まり[matched[1]];
    if (!範囲) return null;
    const 年数 = matched[2] === undefined ? 1 : Number(matched[2]);
    if (!(年数 >= 1 && 年数 <= 範囲[1])) return null;
    const 西暦 = 範囲[0] + 年数;
    if (matched[4]) {
      /* `令和8年4月` はその月の語（月の語は他の月語と同じ経路で 12 か年にまたがって当たる）。 */
      const 月 = Number.parseInt(matched[4], 10);
      if (!(月 >= 1 && 月 <= 12)) return null;
      if (!matched[5]) return { terms: [`${西暦}年${月}月`], 西暦, 年度: false };
      /* 日まで打たれたらその暦日だけに出す – 年を付けない `8月22日` の形は足さない
       * （部分一致で他の年の同じ日を持ってくる – 第 329 回と同じ判断）。 */
      const 日 = Number.parseInt(matched[5], 10);
      if (!(日 >= 1 && 日 <= 31)) return null;
      return { terms: [`${西暦}年${月}月${日}日`], 西暦, 年度: false };
    }
    if (matched[3]) return { terms: fiscalTermsFromYearJa(西暦), 西暦, 年度: true };
    return { terms: [`${西暦}年`], 西暦, 年度: false };
  }

  /** 年の語に対して、その年の 1〜12 か月語（年付き）を返す。基準は JST の暦年。 */
  function yearMonthTermsJa(token: string, nowMs: number): string[] {
    const offset = RELATIVE_YEAR_OFFSETS_JA[relativeYearKeyJa(token)];
    if (offset === undefined) return [];
    const base = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3_600_000);
    const year = base.getUTCFullYear() + offset;
    const out: string[] = [];
    for (let month = 1; month <= 12; month += 1) out.push(`${year}年${month}月`);
    return out;
  }

  const MONTH_RANGE_FROM = /^(.+)月(?:以降|以来|から|より)$/;

  const MONTH_RANGE_SPAN =
    /^(.+)月(?:から|より|へ|〜|～|~|－|―|‐|−|-|ー)(.+?)月(?:まで|辺り|あたり|当たり|頃|ころ)?$/;

  /** 月の語（`9月`・相対月語）を `[年, 月]` に解決する。解決できなければ null。
   * 基準月より前の月を打たれたときは翌年として受け取る – 過ぎた月は計画の対象では
   * ないため（`1月以降` を 8 月に打つ人は翌年 1 月を見る）。 */
  function monthTokenToYearMonth(token: string, nowMs: number): number[] | null {
    const jst = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3_600_000);
    const year = jst.getUTCFullYear();
    const current = jst.getUTCMonth() + 1;
    /* 年まで打った形（`2026年1月… – 実測と理由は第 723 回に SPEC へ送つた。*/
    const 年付き = /^(\d{4})年(\d{1,2})月$/.exec(token);
    if (年付き) {
      const 月 = Number(年付き[2]);
      if (月 < 1 || 月 > 12) return null;
      return [Number(年付き[1]), 月];
    }
    const absolute = /^(\d{1,2})月$/.exec(token);
    if (absolute) {
      const month = Number(absolute[1]);
      if (month < 1 || month > 12) return null;
      return month < current ? [year + 1, month] : [year, month];
    }
    const term = relativeMonthTerm(token, nowMs);
    if (term) {
      const resolved = /^(\d{4})年(\d{1,2})月$/.exec(term);
      if (resolved) return [Number(resolved[1]), Number(resolved[2])];
    }
    return null;
  }

  /* 「来年9月以降」のように年の語を冠で付ける人もいる（計画の立て方では「来年の秋」と
   * 並べて言う）。冠があるときは基準月より前でも翌年へ繰らない – 年を言っている。 */
  const MONTH_RANGE_YEAR_PREFIX =
    /^(今年|ことし|本年|来年|らいねん|再来年|さらいねん|去年|きょねん)(.+)$/;

  /** 月の範囲の語を、表に出る暦月語（`YYYY年M月`）の OR グループへ展開する。 */
  function monthRangeTermsJa(token: string, nowMs: number): string[] {
    const prefixed = MONTH_RANGE_YEAR_PREFIX.exec(token);
    const yearOffset = prefixed ? RELATIVE_YEAR_OFFSETS_JA[prefixed[1]] : undefined;
    const body = prefixed ? (prefixed[2] as string) : token;
    const span = MONTH_RANGE_SPAN.exec(body);
    const from = span ? null : MONTH_RANGE_FROM.exec(body);
    const head = span ? `${span[1]}月` : from ? `${from[1]}月` : "";
    if (!head) return [];
    let start = monthTokenToYearMonth(head, nowMs);
    if (start && yearOffset !== undefined) {
      const jst = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3_600_000);
      start = [jst.getUTCFullYear() + yearOffset, start[1]];
    }
    if (!start) return [];
    let last: number[];
    if (span) {
      /* 後側は前側と同じ月の語で受ける – 数値の月は前の規則どおり年を繰り下げ、
       * 相対月語（`来月` `再来月`）はその語の解ける暦月を使う（基準より前の月は翌年 – 月の語
       * 全体の決まり）。どちらにせよ前側より前の月なら翌年として受ける。 */
      const 後 = monthTokenToYearMonth(`${span[2]}月`, nowMs);
      if (!後) return [];
      last =
        後[0] > start[0] || (後[0] === start[0] && 後[1] >= start[1]) ? 後 : [start[0] + 1, 後[1]];
      if (last[0] * 12 + last[1] > start[0] * 12 + start[1] + 24) {
        /* 二年以上の幅は打たれても出さない – それだけの幅を意図した打ち方は無い。 */
        return [];
      }
    } else {
      // 「以降」は暦年の終わりまでを出す。先にいつまで出したかは件数欄で言う
      // （伏せた範囲指定は誤信を生む – 同じ画面の約束）。
      last = [start[0], 12];
    }
    return monthSpanTerms(start, last);
  }

  /** `[年, 月]` の開始から終了までの暦月語（`YYYY年M月`）を並べる（年跨ぎ対応）。 */
  function monthSpanTerms(start: number[], last: number[]): string[] {
    const out: string[] = [];
    let y = start[0];
    let m = start[1];
    for (let guard = 0; guard < 25; guard += 1) {
      out.push(`${y}年${m}月`);
      if (y === last[0] && m === last[1]) break;
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return out;
  }

  const SEASON_YEAR_PREFIX =
    /^(今年|ことし|来年|らいねん|再来年|さらいねん|去年|きょねん)(?:の)?(.+)$/;
  const SEASON_YEAR_OFFSET: Record<string, number> = {
    今年: 0,
    ことし: 0,
    来年: 1,
    らいねん: 1,
    再来年: 2,
    さらいねん: 2,
    去年: -1,
    きょねん: -1,
  };
  const SEASON_MONTHS_JA: Record<string, number[]> = {
    春: [3, 5],
    はる: [3, 5],
    夏: [6, 8],
    なつ: [6, 8],
    秋: [9, 11],
    あき: [9, 11],
    冬: [12, 2],
    ふゆ: [12, 2],
  };

  /** `[開始月, 終了月]` の季節を、指定した年から始めた暦月語の組へ展開する（年跨ぎ対応）。 */
  function seasonSpanJa(startYear: number, span: number[]): string[] {
    const start = [startYear, span[0]];
    const last = span[1] >= span[0] ? [startYear, span[1]] : [startYear + 1, span[1]];
    return monthSpanTerms(start, last);
  }

  /** 季節の語が基準月の季節に含まれているか（`冬` は年を跨ぐので開始月 > 終了月に注意）。 */
  function seasonInsideSpan(current: number, span: number[]): boolean {
    return span[0] <= span[1]
      ? span[0] <= current && current <= span[1]
      : current >= span[0] || current <= span[1];
  }

  /** 季節の語を暦月語の OR グループへ展開する。 */
  function seasonTermsJa(token: string, nowMs: number, forcedYear?: number): string[] {
    const span = SEASON_MONTHS_JA[token];
    if (!span) return [];
    if (forcedYear) return seasonSpanJa(forcedYear, span);
    const jst = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3_600_000);
    const year = jst.getUTCFullYear();
    const current = jst.getUTCMonth() + 1;
    if (seasonInsideSpan(current, span)) {
      // 季節の途中なら、これから来る月だけ出す（8 月に `夏` と打って 7 月の締切を出さない）。
      return span[0] <= span[1]
        ? monthSpanTerms([year, current], [year, span[1]])
        : // `冬` は年を跨ぐので、12 月に打ったときと 1・2 月に打ったときで終了年が変わる。
          current >= span[0]
          ? monthSpanTerms([year, current], [year + 1, span[1]])
          : monthSpanTerms([year, current], [year, span[1]]);
    }
    // まだ来ていない季節は今年、過ぎた季節は来年（単月の `9月` が基準月より前なら来年、と揃える）。
    return seasonSpanJa(span[0] < current ? year + 1 : year, span);
  }

  function mergeSeasonTokens(tokens: string[]): string[] {
    const out: string[] = [];
    tokens.forEach((token) => {
      const prev = out.length ? (out[out.length - 1] as string) : "";
      if (prev && SEASON_YEAR_OFFSET[prev] !== undefined && SEASON_MONTHS_JA[token] !== undefined) {
        out[out.length - 1] = `${prev}の${token}`;
        return;
      }
      out.push(token);
    });
    return out;
  }

  /* 暦日（数字と切り・点・横棒・和暦で書く形）目印 – 語の割りで前語として残る物が
   * その方の語だと見る形（`1/1` `12/31` `7月1日` `2026-07-01`）。相対日（`来週`）・
   * 帯の語（`17時`）・時刻の語（`17`）は入ら無い。 */
  function 暦日の語かJa(語: string): boolean {
    return /^(?:[0-9]{4}(?:[-/.][0-9]{1,2}){1,2}|[0-9]{1,2}[-/.][0-9]{1,2}|(?:[0-9]{4}年[0-9]{1,2}月)[0-9]{1,2}日?|[0-9]{1,2}月[0-9]{1,2}日?|[0-9]{1,2}日|[0-9]{1,2}月)$/.test(
      語,
    );
  }
  /* 境界の語を剥がした芯と語尾に分ける（`1以降` → 芯 `1`・語尾 `以降`）。裸の境界の語
   * は芯が空になる。 */
  function 境界の語尾Ja(語: string): boolean {
    return /^(?:までに|まで|の)?(?:以降|以後|以来|この先|から|より|より前|より前に|以前|前から|まで|までに)$/.test(
      語,
    );
  }
  function 芯と語尾Ja(語: string): [string, string] {
    const 割 =
      /^(.*?)(までに|の)?((?:まで|以降|以後|以来|この先|から|より前|より前に|以前|前から|より|までに))$/.exec(
        語,
      );
    if (!割) return [語, ""];
    const 芯 = String(割[1] || "");
    const 語尾 = `${String(割[2] || "")}${String(割[3] || "")}`;
    if (芯 && !/^[0-9]/.test(芯)) return [語, ""];
    if (芯 && 芯 !== 語 && !暦日の語かJa(芯) && !/^[0-9]{1,2}(?:日|月)$/.test(芯)) return [語, ""];
    return [芯, 語尾];
  }
  /* 暦日と境界の語を空格で離って打つ… – 実測と理由は第 723 回に SPEC へ送つた。*/
  function 暦日を境界に寄せるJa(tokens: string[], nowMs: number): string[] {
    const out: string[] = [];
    tokens.forEach((token) => {
      const prev = out.length ? (out[out.length - 1] as string) : "";
      const [芯, 語尾] = 芯と語尾Ja(token);
      /* 暦日のかたまり（年・月・日）を繋… – 実測と理由は第 723 回に SPEC へ送つた。*/
      if (
        prev &&
        !語尾 &&
        /^(?:[0-9]{4}年(?:[0-9]{1,2}月)?|[0-9]{1,2}月)$/.test(prev) &&
        /^[0-9]{1,2}[月日]/.test(token) &&
        /^(?:[0-9]{4}年[0-9]{1,2}月(?:[0-9]{1,2}日)?|[0-9]{1,2}月[0-9]{1,2}日)$/.test(
          `${prev}${token}`,
        )
      ) {
        out[out.length - 1] = `${prev}${token}`;
        return;
      }

      /* 繋いだ形（`8月の`）は日付の語の語尾の表が受けるので、其処まで寄せる必要は無い –
       * 助詞を捨てるだけで同じ行に出る（寄せた側は年を冠した形（`2026年8月の`）で行が減つた –
       * 実測 34 行 / 捨てるだけの 189 行）。 */
      if (prev && token === "の" && 解ける日語かJa(prev)) return;
      if (prev && 芯 === "" && 語尾 !== "" && 境界の語尾Ja(語尾) && 暦日の語かJa(prev)) {
        /* 寄せた形は詰めて打つ人の形に直す – 点で書く暦日（「2026.7.1 以降」）は其侭
         * 繋ぐと解けない（実測 0 行 – 第 455 回と同じ目）。 */
        const 詰 = 暦日に境界を続けた形Ja(`${prev}${芯}${語尾}`) || `${prev}${芯}${語尾}`;
        /* その日として解ける暦日に境界の語が裸で並ぶ形が本丸（「12月31日」+「まで」）。
         * 暦に在ら無い日（「9 月 31 日 まで」）は寄せない（締切の推測はしない）。 */
        if (
          暦日に解くJa(prev) !== null ||
          暦日に解くJa(詰) !== null ||
          暦日に境界を続けた形Ja(詰) !== "" ||
          暦日より後の語Ja(詰, nowMs).length > 0 ||
          dayRangeTermsJa(詰, nowMs).length > 0
        ) {
          out[out.length - 1] = 詰;
          return;
        }
      }
      if (!prev || !語尾 || !境界の語尾Ja(語尾)) {
        out.push(token);
        return;
      }
      /* 助詞を挟む打ち方（`12/31 の までに`）は前語の一つ前も見る。 */
      const 前々 = out.length > 1 ? (out[out.length - 2] as string) : "";
      const 助詞 = /^(?:の|[にへのがを])$/.test(prev) ? 前々 : prev;
      const 前語 = 暦日の語かJa(prev) ? prev : 助詞;
      if (!前語 || !暦日の語かJa(前語)) {
        out.push(token);
        return;
      }

      const 詰形 = 暦日に境界を続けた形Ja(`${前語}${芯}${語尾}`);
      const 詰 = 詰形 || `${前語}${芯}${語尾}`;

      if (
        暦日に境界を続けた形Ja(詰) === "" &&
        !(前語 && 暦日に解くJa(前語) !== null && 境界の語尾Ja(語尾)) &&
        暦日より後の語Ja(詰, nowMs).length === 0 &&
        dayRangeTermsJa(詰, nowMs).length === 0
      ) {
        out.push(token);
        return;
      }
      const 位置 = 前語 === prev ? out.length - 1 : out.length - 2;
      out.splice(位置, out.length - 位置, 詰);
    });
    return out;
  }

  function 週の序数を寄せるJa(語列: string[], 番: number): { 詰: string; 飛: number } | null {
    const 頭 = String(語列[番] ?? "");
    /* 冠で了う語（`第` `月第`）か、冠と数まで打たれて週の語が足りない語（`第2` `月第2`）*/
    if (!/第[0-9〇一二三四五六七八九十]{0,2}$/.test(頭)) return null;
    const 次 = String(語列[番 + 1] ?? "");
    const 次々 = String(語列[番 + 2] ?? "");
    if (!次) return null;

    const 序数の尾Ja = /第([0-9〇一二三四五六七八九十]{1,2})週$/;
    const 二語 = `${頭}${次}`;
    if (序数の尾Ja.test(二語)) return { 詰: 二語, 飛: 1 };
    if (次々) {
      const 三語 = `${二語}${次々}`;
      if (序数の尾Ja.test(三語)) return { 詰: 三語, 飛: 2 };
    }
    return null;
  }

  function 単位を数字に寄せるJa(tokens: string[]): string[] {
    const out: string[] = [];
    for (let 番 = 0; 番 < tokens.length; 番 += 1) {
      const token = tokens[番] as string;
      const prev = out.length ? (out[out.length - 1] as string) : "";
      const 次々 = (tokens[番 + 1] as string) ?? "";
      const 週目の寄せ = 週の序数を寄せるJa(tokens, 番);
      if (週目の寄せ) {
        out.push(週目の寄せ.詰);
        番 += 週目の寄せ.飛;
        continue;
      }
      if (
        prev &&
        /^[0-9]+$/.test(prev) &&
        (/^[年月日](?:[0-9]|曜|[と]|$)/.test(token) /* `8 月と 9 月` の `月と` – 第 457 回 */ ||
          /^[0-9]+[年日月](?:[0-9]|$)/.test(token) ||
          /^[0-9]*[月日](?:までに|まで|より|から|この先|以降|以後|以来)$/.test(token))
      ) {
        out[out.length - 1] = `${prev}${token}`;
        continue;
      }

      {
        const 詰 = 相対日の寄せ形Ja(prev, token, "");
        if (詰 !== "" && prev) {
          out[out.length - 1] = 詰;
          continue;
        }
      }
      if (
        /^(?:[0-9]+|[〇一二三四五六七八九十]{1,3}|半)$/.test(prev) &&
        /^(?:か月|カ月|ヵ月|ヶ月|ケ月|箇月|年|日|月)$/.test(token) &&
        /^[後前]$/.test(次々)
      ) {
        const 詰 = 相対日の寄せ形Ja(prev, token, 次々);
        if (詰 !== "") {
          out[out.length - 1] = 詰;
          番 += 1;
          continue;
        }
      }
      /* 時刻の単位と冠を離って打つ形（`… – 実測と理由は第 723 回に SPEC へ送つた。*/
      if (
        prev &&
        /^(?:午前|午後|ごぜん|ごご)$/.test(prev) &&
        /^[0-9]{1,2}$/.test(token) &&
        clockTimeTermsJa(`${prev}${token}${次々}`) !== null
      ) {
        out[out.length - 1] = `${prev}${token}${次々}`;
        番 += 1;
        continue;
      }
      if (
        prev &&
        /^(?:(?:午前|午後|ごぜん|ごご))?[0-9]{1,2}$/.test(prev) &&
        /^[時]/.test(token) &&
        clockTimeTermsJa(`${prev}${token}`) !== null
      ) {
        out[out.length - 1] = `${prev}${token}`;
        continue;
      }
      /* 冠だけを離して数字と時を繋げて打つ形（`午後 5時`） – 同じ機械で受ける（実測
       * 2026-11-07: `午後5時以降` 538 行 / `午後 5時 以降` **0 行**）。*/
      if (
        prev &&
        /^(?:午前|午後|ごぜん|ごご)$/.test(prev) &&
        /^[0-9]{1,2}時(?:[0-9]{1,2}分|半)?$/.test(token) &&
        clockTimeTermsJa(`${prev}${token}`) !== null
      ) {
        out[out.length - 1] = `${prev}${token}`;
        continue;
      }

      if (
        prev &&
        /^(?:(?:午前|午後|ごぜん|ごご))?[0-9]{1,2}時(?:[0-9]{1,2}分)?$/.test(prev) &&
        /^[0-9]{1,2}$/.test(token) &&
        /^[分]/.test(次々) &&
        clockTimeTermsJa(`${prev}${token}${次々}`) !== null
      ) {
        out[out.length - 1] = `${prev}${token}${次々}`;
        番 += 1;
        continue;
      }
      if (
        prev &&
        /^(?:(?:午前|午後|ごぜん|ごご))?[0-9]{1,2}時$/.test(prev) &&
        /^[0-9]{1,2}分$/.test(token) &&
        clockTimeTermsJa(`${prev}${token}`) !== null
      ) {
        out[out.length - 1] = `${prev}${token}`;
        continue;
      }
      out.push(token);
    }
    return out;
  }

  const 幅の語尾の語Ja =
    /^(?:までに|まで|中に|中|内に|内|以内に|以内|以降|以後|以来|前に|前|より|から|末|初め|始め|当初|明け)$/;

  function 幅の語尾を継いだ形が解けるJa(語: string, nowMs: number): boolean {
    return (
      untilDayTermsJa(語, nowMs) !== null ||
      fromTodayTermsJa(語, nowMs) !== null ||
      withinDaysTermsJa(語, nowMs) !== null ||
      periodMonthTermsJa(語, nowMs).length > 0 ||
      monthPartRangeJa(語, nowMs) !== null ||
      weekDayTermsJa(語, nowMs).length === 7 ||
      dayRangeTermsJa(語, nowMs).length > 0 ||
      monthRangeTermsJa(語, nowMs).length > 0 ||
      RELATIVE_YEAR_OFFSETS_JA[relativeYearKeyJa(語)] !== undefined ||
      relativeMonthTerm(語, nowMs) !== "" ||
      fiscalYearTermsJa(語, nowMs) !== null ||
      clockTimeTermsJa(語) !== null ||
      解ける日語かJa(dateTokenStemJa(語))
    );
  }

  function 範囲の語を寄せるJa(tokens: string[], nowMs: number): string[] {
    const out: string[] = [];
    tokens.forEach((token) => {
      const prev = out.length ? (out[out.length - 1] as string) : "";
      if (
        prev &&
        /(?:から|より)$/.test(prev) &&
        /(?:までに|まで)$/.test(token) &&
        dayRangeTermsJa(prev + token, nowMs).length > 0
      ) {
        out[out.length - 1] = prev + token;
        return;
      }
      /* 幅の語尾を前に離して打つ形（`来週 まで`） – 語尾だけの語を残すと 0 行になるので
       * 前に寄せる。寄せた形が解けない時は其侭流す（`年内 中` の守り）。*/
      if (prev && 幅の語尾の語Ja.test(token) && 幅の語尾を継いだ形が解けるJa(prev + token, nowMs)) {
        out[out.length - 1] = prev + token;
        return;
      }
      out.push(token);
    });
    return out;
  }

  const 列挙の助詞Ja = /^(?:と|か|または|もしくは|あるいは|及び|ならびに)$/;
  /* 助詞が語の末尾に繋がれた形（`8月と`） – 長い助詞も見る。 */
  const 列挙の助詞の尾Ja = /(?:ならびに|または|もしくは|あるいは|及び|と|か)$/;

  function 列挙の語を寄せるJa(tokens: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      let 語 = tokens[i];
      for (;;) {
        const 助 = i + 1 < tokens.length ? (tokens[i + 1] as string) : "";
        const 次 = i + 2 < tokens.length ? (tokens[i + 2] as string) : "";
        /* 助詞が前の語に繋がれた打ち方（`8 月と 9 月` は `8月と` `9月` に割れる）は、
         * その語の末尾が助詞で了うかだけ見て後ろを継ぐ。 */
        const 助詞を連れた語 = 列挙の助詞の尾Ja.test(語);
        if (助詞を連れた語) {
          if (!助) break;
          const 継いだ形 = `${語}${助}`;
          if (列挙の語に割るJa(継いだ形) === null) break;
          語 = 継いだ形;
          i += 1;
          continue;
        }
        if (!助 || !次 || !列挙の助詞Ja.test(助)) break;
        const 並べた形 = `${語}${助}${次}`;
        /* 機械が解く形の時だけ寄せる – 月が決まらない物は寄せない（その侭なら
         * 別の語として通る – 締切の推測はしない）。 */
        if (列挙の語に割るJa(並べた形) === null) break;
        語 = 並べた形;
        i += 2;
      }

      if (語 === "と" && (out.length > 0 || i + 1 < tokens.length)) continue;
      out.push(語);
    }
    return out;
  }

  /** `来年の秋` のように年を冠した言い方を、その年の季節として展開する。 */
  function yearSeasonTermsJa(token: string, nowMs: number): string[] {
    const hit = SEASON_YEAR_PREFIX.exec(token);
    if (!hit) return [];
    const span = SEASON_MONTHS_JA[hit[2] as string];
    if (!span) return [];
    const jst = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3_600_000);
    const year = jst.getUTCFullYear();
    const delta = SEASON_YEAR_OFFSET[hit[1] as string];
    if (delta === undefined) return [];
    // 年を冠で書いたときは繰り上げない（`来年9月以降` と同じ判断）。
    return seasonSpanJa(year + delta, span);
  }

  /** 季節の語について `打った語 -> 出した範囲` の組を返す（件数欄の説明用）。 */
  function seasonPairs(query: unknown, nowMs: number): Array<[string, string]> {
    const normalized = searchNormalize(query);
    if (!normalized) return [];
    const pairs: Array<[string, string]> = [];
    mergeSeasonTokens(normalized.split(" ")).forEach((token) => {
      const yearSeason = yearSeasonTermsJa(token, nowMs);
      if (yearSeason.length) {
        pairs.push([token, `${yearSeason[0]}から${yearSeason[yearSeason.length - 1]}`]);
        return;
      }
      splitQueryToken(token, nowMs).forEach((part) => {
        const terms = seasonTermsJa(part, nowMs);
        if (terms.length) pairs.push([part, `${terms[0]}から${terms[terms.length - 1]}`]);
      });
    });
    return pairs;
  }

  /** 月の範囲の語について `打った語 -> 出した範囲` の組を返す（件数欄の説明用）。 */
  function monthRangePairs(query: unknown, nowMs: number): Array<[string, string]> {
    const normalized = searchNormalize(query);
    if (!normalized) return [];
    const pairs: Array<[string, string]> = [];
    normalized.split(" ").forEach((token) => {
      splitQueryToken(token, nowMs).forEach((part) => {
        const terms = monthRangeTermsJa(part, nowMs);
        if (terms.length) pairs.push([part, `${terms[0]}から${terms[terms.length - 1]}`]);
      });
    });
    return pairs;
  }

  const DAY_RANGE = new RegExp(
    `^((?:[0-9]{4}年)?[0-9]{1,2}月[0-9]{1,2}日?|(?:[0-9]{4}[-/])?[0-9]{1,2}[-/][0-9]{1,2}日?)` +
      `(?:から|より|へ|[-〜～~－―‐−ー])` +
      `((?:[0-9]{4}年)?[0-9]{1,2}月[0-9]{1,2}日?|(?:[0-9]{4}[-/])?[0-9]{1,2}[-/][0-9]{1,2}日?|[0-9]{1,2}日?)` +
      `(?:まで|いっぱい|辺り|あたり|当たり|頃|ころ)?$`,
  );

  /** 「8月20日」「2026/8/20」「8-20」を [年, 月, 日] に解く（年が打たれていない時は -1）。 */
  function 暦日に解くJa(語: string): number[] | null {
    const 和暦 = /^(?:([0-9]{4})年)?([0-9]{1,2})月([0-9]{1,2})日?$/.exec(語);
    const 区切り = 和暦 ? null : /^(?:([0-9]{4})[-/])?([0-9]{1,2})[-/]([0-9]{1,2})日?$/.exec(語);
    const hit = 和暦 || 区切り;
    if (!hit) return null;
    const 年 = hit[1] ? Number(hit[1]) : -1;
    const 月 = Number(hit[2]);
    const 日 = Number(hit[3]);
    if (月 < 1 || 月 > 12 || 日 < 1 || 日 > 31) return null;
    /* 暦に無い日（`2月30日`）は解かない – その日の締切は在り得ないので、近い日に寄せる事も
       しない（締切の推測はしない）。 */
    const 日時の检验 = new Date(Date.UTC(年 < 0 ? 2001 : 年, 月 - 1, 日));
    if (日時の检验.getUTCMonth() !== 月 - 1 || 日時の检验.getUTCDate() !== 日) return null;
    return [年, 月, 日];
  }

  const 幅の区切りJa =
    /^(.+?)(?:から|より|へ|[-〜～~－―‐−ー])(.+?)(?:までに|まで|いっぱい|辺り|あたり|当たり|頃|ころ)?$/;
  const 日の数の後Ja = /^(?:あと|残り)?([0-9]{1,3})(?:日間|日|にち)?(?:後|あと)$/;
  const 日の数の前Ja = /^([0-9]{1,3})(?:日間|日|にち)前$/;

  /** `2026年8月11日` の形の語を [年, 月, 日] に解く（暦の語表の並びが使う形）。 */
  function 暦日の語から解くJa(語: string): number[] | null {
    const hit = /^([0-9]{4})年([0-9]{1,2})月([0-9]{1,2})日$/.exec(String(語 || ""));
    return hit ? [Number(hit[1]), Number(hit[2]), Number(hit[3])] : null;
  }

  /** 幅の片側（`明日` `来週` `今週金曜` `3日後` `8月20日`）を暦日に解く（解けなければ null）。 */
  function 幅の片側を暦日に解くJa(
    語: string,
    nowMs: number,
    側: string,
    月のhint?: number[] | null,
  ): number[] | null {
    const 暦 = 暦日に解くJa(語);
    if (暦) return 暦;

    const 和暦 = eraYearTermsJa(語);
    if (和暦?.terms[0]) {
      const 解 = 暦日の語から解くJa(和暦.terms[0]);
      if (解) return 解;
    }
    const 柄 = dateTokenStemJa(語) || 語;
    const 日の数 = RELATIVE_DAY_OFFSETS_JA[柄];
    if (typeof 日の数 === "number") return offsetCalendarDay(nowMs, 日の数);
    const 週 = weekDayTermsJa(柄, nowMs);
    if (週.length === 7) return 暦日の語から解くJa(側 === "頭" ? 週[0] : 週[6]);

    /* 冠の無い旬（`来月上旬から中旬` の `中旬`）は頭側の月を継ぐ – その方の月が其侭では
     * 決まらないので、それ以外の月に直すと幅が逆向きになって解けない（実測 0 行）。 */
    const 旬 = monthPartRangeJa(
      月のhint && /^(?:上旬|中旬|下旬|最終週|最後の週|第[0-9一二三四五六七八九十]{1,3}週)$/.test(柄)
        ? `${月のhint[0]}年${月のhint[1]}月${柄}`
        : 柄,
      nowMs,
    );
    if (旬) return 側 === "頭" ? [旬.year, 旬.month, 旬.from] : [旬.year, 旬.month, 旬.to];

    const 裸の日 = 側 === "尾" ? /^([0-9]{1,2})日$/.exec(柄) : null;

    if (側 === "尾" && 月のhint && 月のhint.length >= 4 && 月のhint[3] !== 1 && 月のhint[4] !== 1) {
      const 数え = 数えの幅Ja.exec(柄);
      if (数え) {
        const 数 = Number(数え[1]);
        if (!(数 >= 1 && 数 <= 12)) return null;
        const 頭 = new Date(Date.UTC(月のhint[0], 月のhint[1] - 1, 月のhint[2]));
        const 単位 = 数え[2];
        if (/年/.test(単位)) {
          頭.setUTCFullYear(頭.getUTCFullYear() + 数);
        } else if (/月/.test(単位)) {
          頭.setUTCMonth(頭.getUTCMonth() + 数);
        } else {
          頭.setUTCDate(頭.getUTCDate() + 数 * (/週/.test(単位) ? 7 : 1));
        }
        return [頭.getUTCFullYear(), 頭.getUTCMonth() + 1, 頭.getUTCDate()];
      }
    }

    /* その日を継ぐ形はその侭 – 上の数えの幅の枝が目印を一つ足したので、目の数では
     * 見ない（それを目印の個数で見た為、`8月10日から12日` が 0 行に化けた – 実測）。 */
    if (裸の日 && 月のhint && 月のhint.length >= 4 && 月のhint[3] === 1) {
      const 日 = Number(裸の日[1]);
      if (!(日 >= 1 && 日 <= 31)) return null;
      let 継ぐ年 = 月のhint[0];
      let 継ぐ月 = 月のhint[1];
      if (日 < 月のhint[2]) {
        継ぐ月 += 1;
        if (継ぐ月 > 12) {
          継ぐ月 -= 12;
          継ぐ年 += 1;
        }
      }
      return [継ぐ年, 継ぐ月, 日];
    }

    const 曜 = /^([月火水木金土日])曜(?:日)?$/.exec(柄);
    if (曜) {
      const 序号 = WEEKDAY_ORDER_JA.indexOf(曜[1]);
      if (序号 < 0) return null;
      /* `WEEKDAY_ORDER_JA` は月を先頭に数えるので、暦が数える日曜先頭へ寄せる。 */
      const 目標 = (序号 + 1) % 7;
      const 基準 =
        側 === "頭" || !月のhint || 月のhint.length < 3
          ? offsetCalendarDay(nowMs, 0)
          : [月のhint[0], 月のhint[1], 月のhint[2]];
      const 基準日 = new Date(Date.UTC(基準[0], 基準[1] - 1, 基準[2]));
      基準日.setUTCDate(基準日.getUTCDate() + ((目標 - 基準日.getUTCDay() + 7) % 7));
      return [基準日.getUTCFullYear(), 基準日.getUTCMonth() + 1, 基準日.getUTCDate()];
    }
    const 押し = pressedWeekdayJa(柄, nowMs) || pressedMonthDayJa(柄, nowMs);
    if (押し?.length) return 暦日の語から解くJa(押し[0]);
    const 後 = 日の数の後Ja.exec(柄);
    if (後) return offsetCalendarDay(nowMs, Number(後[1]));
    const 前 = 日の数の前Ja.exec(柄);
    if (前) return offsetCalendarDay(nowMs, -Number(前[1]));
    return null;
  }

  function 暦日に境界を続けた形Ja(語: string): string {
    const 割 =
      /^(\d{4}(?:[-/.]\d{1,2}){1,2}|(?:\d{1,2}[-/.]\d{1,2}|\d{4}年\d{1,2}月)?)((?:の)?(?:以降|以後|以来|この先|までに|まで|より前|より前に|以前|前から|前|後|後で|後から))$/.exec(
        語,
      );
    if (!割) return "";
    const 芯 = String(割[1] || "").replace(/\./g, "/");

    if (暦日に解くJa(芯) === null) return "";
    return 芯 + String(割[2] || "");
  }

  function より後を剥がす語Ja(語: string): string {
    const 当たり = /^(.+?)(?:以降|以後|以来|この先|から|より)$/.exec(語);
    return 当たり ? 当たり[1] : "";
  }

  function 暦日より後の語Ja(語: string, nowMs: number): string[] {
    const 芯 = より後を剥がす語Ja(語);
    if (!芯) return [];
    let 解 = 暦日に解くJa(芯);

    if (!解) {
      const 文 = String(語 || "");

      const 後尾 = /^(.+?)(?:以降|以後|この先|以来|から|より)$/.exec(文);
      if (後尾) {
        const 初日 = 其の日以降の初日Ja(芯, nowMs);
        if (初日) 解 = 暦日に解くJa(初日);
      }
    }
    if (!解) return [];
    const 基準日時 = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3_600_000);
    const 並び = (年: number, 月: number, 日: number) => 年 * 10000 + 月 * 100 + 日;
    let 年 = 解[0] >= 0 ? 解[0] : 基準日時.getUTCFullYear();
    const 月 = 解[1];
    const 日 = 解[2];
    /* 年を打た無い形でその月日が既に過ぎている時は翌年へ繰る（暦日の幅と同じ決まり）。 */
    const 基準日 = 並び(
      基準日時.getUTCFullYear(),
      基準日時.getUTCMonth() + 1,
      基準日時.getUTCDate(),
    );
    if (解[0] < 0 && 並び(年, 月, 日) < 基準日) 年 += 1;
    const 語々: string[] = [];
    const 末日 = new Date(Date.UTC(年, 月, 0)).getUTCDate();
    for (let 日付 = 日; 日付 <= 末日; 日付 += 1) 語々.push(`${年}年${月}月${日付}日`);
    if (月 < 12) {
      for (const 暦月 of monthSpanTerms([年, 月 + 1], [年, 12])) 語々.push(暦月);
    }
    return 語々;
  }

  /** 日の語を幅で打たれた形から暦日の語（`2026年8月10日`）の組へ展開する。 */
  function dayRangeTermsJa(token: string, nowMs: number): string[] {
    const normalized = 幅の漢数字を寄せるJa(searchNormalize(token));
    if (!normalized) return [];

    const より後 = 暦日より後の語Ja(normalized, nowMs);
    if (より後.length) return より後;
    const hit = DAY_RANGE.exec(normalized);
    /* 暦日を二つ並べた形以外に、相対語を二つ並べた幅を受ける。 */
    const 幅 = hit ? null : 幅の区切りJa.exec(normalized);
    const 前語 = hit ? (hit[1] as string) : 幅 ? (幅[1] as string) : null;
    const 後語 = hit ? (hit[2] as string) : 幅 ? (幅[2] as string) : null;
    if (!前語 || !後語) return [];

    const 前 = 幅の片側を暦日に解くJa(前語, nowMs, "頭");
    if (!前) return [];
    /* 尾側に冠の無い旬（`来月上旬から中旬`）や冠の無い日（`8月10日から12日`）が来る形は、
     * 頭側の年月日（その日）を継がせる。 */
    const 基準日時 = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3600 * 1000);
    /* 四つ目は頭側が月を打ったか（冠の無い日をその日として受けるかの決まり – 第 376 回）。 */
    const hint = [
      前[0] >= 0 ? 前[0] : 基準日時.getUTCFullYear(),
      前[1],
      前[2],
      /[0-9]{1,2}月|[0-9]{1,2}[-/][0-9]{1,2}/.test(前語) ? 1 : 0,

      /^(?:今日|当日|(?:締切|締め切り|〆切|しめきり))/.test(String(前語 || "")) ? 1 : 0,
    ];
    const 後 = 幅の片側を暦日に解くJa(後語, nowMs, "尾", hint);

    if (!後) return [];
    const 基準 = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3600 * 1000);
    const 基準日 =
      基準.getUTCFullYear() * 10000 + (基準.getUTCMonth() + 1) * 100 + 基準.getUTCDate();
    let 年前 = 前[0] >= 0 ? 前[0] : 基準.getUTCFullYear();
    let 年後 = 後[0] >= 0 ? 後[0] : 年前;
    const 並び = (年: number, 月: number, 日: number) => 年 * 10000 + 月 * 100 + 日;
    /* 前側より前の月日は翌年として受ける（暦月の幅と同じ決まり – 第 370 回）。 */
    if (並び(年後, 後[1], 後[2]) < 並び(年前, 前[1], 前[2])) 年後 += 1;
    /* 年を打たれていない幅で、その終わりが既に過ぎている時も翌年へ繰る。 */
    if (前[0] < 0 && 並び(年後, 後[1], 後[2]) < 基準日) {
      年前 += 1;
      年後 += 1;
    }
    const out: string[] = [];
    let 年 = 年前;
    let 月 = 前[1];
    let 日 = 前[2];
    for (let guard = 0; guard <= 62; guard += 1) {
      out.push(`${年}年${月}月${日}日`);
      if (年 === 年後 && 月 === 後[1] && 日 === 後[2]) return out;
      /* 翌月（翌年）への繰り上げは暦の日数で決める – 月の長さを推測しない。 */
      const つぎ = new Date(Date.UTC(年, 月 - 1, 日 + 1));
      年 = つぎ.getUTCFullYear();
      月 = つぎ.getUTCMonth() + 1;
      日 = つぎ.getUTCDate();
    }
    /* 二か月を超える幅 – その方の暦語表の限界なので解かない。 */
    return [];
  }

  /** 件数欄用 – 日の幅を打たれた語と解決した暦日の範囲で組にする。 */
  /* `と` で並べた列挙（`8月と1… – 実測と理由は第 723 回に SPEC へ送つた。*/

  function 単体の展開語Ja(語: string, nowMs: number, 継ぐ?: number[] | null): string[] {
    if (/半/.test(語) && !numericRelativeDay(語, nowMs)) return [];

    if (継ぐ && 継ぐ.length >= 2) {
      if (/^[0-9]{1,2}日$/.test(語)) {
        const 継ぎ暦 = 幅の片側を暦日に解くJa(語, nowMs, "尾", 継ぐ);
        if (!継ぎ暦) return [];
        return [`${継ぎ暦[0] >= 0 ? 継ぎ暦[0] : 継ぐ[0]}年${継ぎ暦[1]}月${継ぎ暦[2]}日`];
      }
      if (/^(?:[上中下]旬|最終週|最後の週)$/.test(語)) {
        return monthPartTermsJa(`${継ぐ[1]}月${語}`, nowMs) || [];
      }
    }
    const 曜 = /^([月火水木金土日])曜(?:日)?$/.exec(dateTokenStemJa(語) || 語);
    if (曜) return [`${曜[1]}曜`];
    const 組 = queryTokenGroups(語, nowMs)[0] || [];
    const 語々 = 組.filter((項) => 項 !== 語);
    if (語々.length) return 語々;
    /* 年を添えた月の語はその侭暦月語 – 暦日の解きは日を持たないので通らない
     * （`2026年8月` 189 行 – 第 457 回）。 */
    if (/^[0-9]{4}年[0-9]{1,2}月$/.test(語)) return [語];
    const 暦 = 幅の片側を暦日に解くJa(語, nowMs, 継ぐ ? "尾" : "頭", 継ぐ || null);
    if (!暦) return [];
    const 基準 = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3600 * 1000);
    let 年 = 暦[0] >= 0 ? 暦[0] : 基準.getUTCFullYear();
    const 並び = (a: number, b: number, c: number) => a * 10000 + b * 100 + c;
    const 基準日 = 並び(基準.getUTCFullYear(), 基準.getUTCMonth() + 1, 基準.getUTCDate());
    /* 年を打たれて居ない月日は、その侭では過ぎた日になる – 幅と同じ決まりで翌年として受ける
     * （過ぎた日をその年に黙って取らない – 締切の推測はしない）。 */
    if (暦[0] < 0 && 並び(年, 暦[1], 暦[2]) < 基準日) 年 += 1;
    return [`${年}年${暦[1]}月${暦[2]}日`];
  }

  /** 並べた語の断片が、全部 日語で決まる形か（先頭の語以降は月を継げる形も通す –
   * 第 395 回）。`と` で並べた形と句読点で並べた形で同じ目印を使う。 */
  function 断片が皆決まるかJa(断片: string[]): boolean {
    for (let i = 0; i < 断片.length; i += 1) {
      if (!解ける日語かJa(断片[i], i > 0)) return false;
    }
    return true;
  }

  const 列挙の区切りJa = /(?:または|もしくは|あるいは|及び|ならびに|と)/;

  function 列挙の語に割るJa(語: string): string[] | null {
    let 断片 = String(語 || "")
      .split(列挙の区切りJa)
      .map((片) => 片.trim())
      .filter((片) => 片.length > 0);
    /* 助詞の `か` で並べた形（`8月10日か8月20日`） – `か` は他の語の中にも入るので、
     * 上の区切りで割れ無かつた時だけ試す（割れた物が全部日語で決まる時に通す –
     * `1か月か2か月` の様に語の途中で割れる物は其侭断る）。 */
    if (断片.length < 2) {
      断片 = String(語 || "")
        .split("か")
        .map((片) => 片.trim())
        .filter((片) => 片.length > 0);
    }
    if (断片.length < 2 || 断片.length > 4) return null;
    if (!断片が皆決まるかJa(断片)) return null;
    return 断片;
  }

  /** 案内に書く一片ずつの代表の語 – 年をまたぐ表（`8月`）は基準の年の語だけ選ぶ。 */
  function 列挙の代表語Ja(語々: string[], nowMs: number): string {
    const 年付き = 語々.filter((項) => /^[0-9]{4}年/.test(項));
    const 基準 = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3600 * 1000);
    const 基準年の語 = 年付き.find((項) => 項.startsWith(`${基準.getUTCFullYear()}年`));
    return 基準年の語 || 年付き[0] || 語々[0] || "";
  }

  /** 並べた断片から列挙を解いた物（当たり方に使う展開語と、案内に書く代表の語）。 */
  function 列挙を解くJa(断片: string[], nowMs: number): { 展開: string[]; 代表: string[] } | null {
    /* 先頭の語が名乗る月をそれ以降に継がせる – 幅の側が持つ月の印の形をそのまま使う
     * （三つ目は裸の日を受ける目印 – 第 376 回）。 */
    const 頭 = 幅の片側を暦日に解くJa(断片[0], nowMs, "頭", null);
    /* 年を打たれて居ない頭（`8月10日と11日`）もその年に継ぐ – その侭では過ぎた日に
     * なる時だけ翌年へ回す（幅の側と同じ決まり – 第 376 回）。 */
    const 基準 = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3600 * 1000);
    const 並び = (年: number, 月: number, 日: number) => 年 * 10000 + 月 * 100 + 日;
    let 継ぐ: number[] | null = null;
    if (頭) {
      let 継ぐ年 = 頭[0] >= 0 ? 頭[0] : 基準.getUTCFullYear();
      if (
        頭[0] < 0 &&
        並び(継ぐ年, 頭[1], 頭[2]) <
          並び(基準.getUTCFullYear(), 基準.getUTCMonth() + 1, 基準.getUTCDate())
      )
        継ぐ年 += 1;
      継ぐ = [
        継ぐ年,
        頭[1],
        頭[2],
        /[0-9]{1,2}月|[0-9]{1,2}[-/][0-9]{1,2}/.test(断片[0]) ? 1 : 0,
        0,
      ];
    }
    const 展開: string[] = [];
    const 代表: string[] = [];
    for (let i = 0; i < 断片.length; i += 1) {
      const 語々 = 単体の展開語Ja(断片[i], nowMs, i === 0 ? null : 継ぐ);
      /* 内の一つでも解けない語なら列挙全体を解かない – 片方だけの当たり方は噓になる。 */
      if (!語々.length) return null;
      for (const 語 of 語々) if (展開.indexOf(語) < 0) 展開.push(語);
      const 代表語 = 列挙の代表語Ja(語々, nowMs);
      if (代表語 && 代表.indexOf(代表語) < 0) 代表.push(代表語);
    }
    if (!代表.length) return null;
    return { 展開, 代表 };
  }

  function 列挙の解きJa(語: string, nowMs: number): { 展開: string[]; 代表: string[] } | null {
    const 断片 = 列挙の語に割るJa(語);
    return 断片 ? 列挙を解くJa(断片, nowMs) : null;
  }

  function 列挙の展開語Ja(語: string, nowMs: number): string[] {
    const 解 = 列挙の解きJa(語, nowMs);
    return 解 ? 解.展開 : [];
  }

  function 句読点の列挙Ja(語: string, nowMs: number): { 展開: string[]; 代表: string[] } | null {
    const 断片 = String(語 || "")
      .split(/[、，,]+/)
      .map((片) => 片.trim())
      .filter((片) => 片.length > 0);
    if (断片.length < 2 || 断片.length > 4) return null;
    if (!断片が皆決まるかJa(断片)) return null;
    return 列挙を解くJa(断片, nowMs);
  }

  function 連結の列挙Ja(語: string, nowMs: number): { 展開: string[]; 代表: string[] } | null {
    const q = String(語 || "").trim();
    if (q.length < 4 || q.length > 12) return null;
    if (解ける日語かJa(q)) return null;
    if (幅の語を割らないかJa(q)) return null;
    /* 暦日の形そのまま（`2月30日` のやうに在らない日を含む形も）は列挙にしない – 月の枝と
     * 日の枝に割るとその方の月ある行全部に化ける（実測で `2月30日` が 2 月の行 67 行に化けた –
     * 在らない日をその月の全行で答えるのは締切の推測になる）。ISO・スラッシュ書きも同じ。 */
    if (
      /^[0-9]{1,2}月[0-9]{1,2}日$/.test(q) ||
      /^[0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日$/.test(q) ||
      /[0-9][-/][0-9]/.test(q)
    )
      return null;
    const 月を名乗る頭Ja = /[0-9]{1,2}月|今月|来月|再来月|先月/;
    for (let 切断 = 2; 切断 <= q.length - 2; 切断 += 1) {
      const 頭 = q.slice(0, 切断);
      const 尾 = q.slice(切断);
      if (!解ける日語かJa(頭)) continue;
      if (!解ける日語かJa(尾, 月を名乗る頭Ja.test(頭))) continue;

      if (週の語かJa(頭) && 旬の位かJa(尾)) continue;
      const 解 = 列挙を解くJa([頭, 尾], nowMs);
      if (解) return 解;
    }
    return null;
  }

  function dayRangePairs(query: unknown, nowMs: number): Array<[string, string]> {
    const normalized = searchNormalize(query);
    if (!normalized) return [];
    const pairs: Array<[string, string]> = [];
    normalized.split(" ").forEach((token) => {
      splitQueryToken(token, nowMs).forEach((part) => {
        const terms = dayRangeTermsJa(part, nowMs);
        if (terms.length) pairs.push([part, `${terms[0]}から${terms[terms.length - 1]}`]);
        /* `と` の列挙は幅ではないので「または」で繋いで書く。 */

        const 列挙 = 列挙の解きJa(part, nowMs);
        if (!terms.length && 列挙) pairs.push([part, 列挙.代表.join("または")]);
        /* 「、」で並べた形も同じ – 案内は「または」で繋ぐ（並べた日であって幅では無い）。 */
        if (!terms.length && !列挙) {
          const 句列挙 = 句読点の列挙Ja(part, nowMs);
          if (句列挙) pairs.push([part, 句列挙.代表.join("または")]);
          /* 助詞も読点も無く並べた形も同じ – 案内は「または」で繋ぐ。 */
          if (!terms.length && !列挙) {
            const 連結 = 連結の列挙Ja(part, nowMs);
            if (連結) pairs.push([part, 連結.代表.join("または")]);
          }
        }
      });
    });
    return pairs;
  }

  const PERIOD_MONTH_WORDS_JA: Record<string, string> = {
    今月末: "今月",
    今月終わり: "今月",

    月終わり: "今月",
    月末: "今月",
    この月末: "今月",
    来月末: "来月",
    来月終わり: "来月",
    再来月末: "再来月",
    /* 先の側の言い方が揃っていなかった（2026-10-24 実測 – 実ビルドの品書 872 行・固定時刻
     * 2026-08-09T00:00:00Z）: `今月末` 189 行・`来月末` 240 行・`再来月末` 188 行が通るのに、
     * `先月末` **0 行**・`昨月末` **0 行**・`先々月末` **0 行**（同じビルドで `先月` 52 行・
     * `先月中旬` 26 行は通る – 月の語は前側もある）。過去の確認（「先月末に締まった物は
     * 何だったか」）は普通にする打ち方なので、上の同じ決まりでその月の語に寄せる。 */
    先月末: "先月",
    先月終わり: "先月",
    昨月末: "先月",
    先々月末: "先々月",

    今月内: "今月",
    来月内: "来月",
    再来月内: "再来月",
    先月内: "先月",
    /* 仮名で打つ人の『内』もその方の対。*/
    こんげつ内: "今月",
    らいげつ内: "来月",
    せんげつ内: "先月",
    年度末: "3月",
    年初: "1月",
    /* 年の切れ目の言い方の対が揃っていなかった（2026-10-10 実測・実ビルドの品書 872 行・
     * 同刻）: `年末` 183 行（= `12月` と対称差 0）・`年初` 109 行・
     * `年明け` 109 行（いずれも = `1月` と対称差 0）・`年度末` 80 行・`年度初め` 81 行・
     * `年度当初` 81 行が通るのに、`年始` **0 行**・`年初め` **0 行**・`年始め` **0 行**・
     * `年度始め` **0 行**だった（その方の語がある対の欠落 – 「締切の推測」には当たらない –
     * 年の初めはその暦月、年末が `12月` に寄るのと同じ決まり）。 */
    年始: "1月",
    年初め: "1月",
    年始め: "1月",
    年度始め: "4月",
    年明け: "1月",
    年度初め: "4月",
    年度当初: "4月",
    年末: "12月",
    // 「年内」は今月〜12月（過ぎた月を出さない – `@年内` で受ける）。
    年内: "@年内",
  };

  /** 月のまとまりの語を、表に出る暦月語（`YYYY年M月`）のグループへ展開する。 */
  function periodMonthTermsJa(token: string, nowMs: number): string[] {
    let target = PERIOD_MONTH_WORDS_JA[dateTokenStemJa(token) || token];
    if (!target) {
      for (const 候補 of [
        String(token || ""),
        String(token || "")
          .replace(/までに$/, "")
          .replace(/に$/, ""),
      ]) {
        if (候補 && PERIOD_MONTH_WORDS_JA[候補] !== undefined) {
          target = PERIOD_MONTH_WORDS_JA[候補];
          break;
        }
      }
    }
    if (!target) return [];
    const jst = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3_600_000);
    if (target === "@年内") {
      const out: string[] = [];
      for (let month = jst.getUTCMonth() + 1; month <= 12; month += 1) {
        out.push(`${jst.getUTCFullYear()}年${month}月`);
      }
      return out;
    }
    const resolved = monthTokenToYearMonth(target, nowMs);
    if (!resolved) return [];
    return [`${resolved[0]}年${resolved[1]}月`];
  }

  const MONTH_PART_DAYS_JA: Record<string, [number, number]> = {
    上旬: [1, 10],
    中旬: [11, 20],
    下旬: [21, 0],
  };

  const 週的形状Ja = /^第([0-9]{1,2}|[一二三四五六七八九十]{1,3})週$/;
  const 漢の週Ja: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  function 週の数Ja(label: string): number | null {
    const 拾 = 週的形状Ja.exec(String(label || ""));
    if (!拾) return null;
    const 字 = 拾[1];
    if (/^[0-9]+$/.test(字)) return Number(字);
    if (漢の週Ja[字] !== undefined) return 漢の週Ja[字];
    /* 『十一』の様な二字の形（月の週は五までしか受けないので、在れば外れる – 安心側の為だけ）。 */
    const 十の位 = /^([一二三四五六七八九]?)十([一二三四五六七八九])?$/.exec(字);
    if (十の位) {
      const 頭 = 十の位[1] ? 漢の週Ja[十の位[1]] : 1;
      return 頭 * 10 + (十の位[2] ? 漢の週Ja[十の位[2]] : 0);
    }
    return null;
  }
  function 週の範囲Ja(label: string): [number, number] | null {
    const 打 = 週の数Ja(label);
    if (打 === null || 打 < 1 || 打 > 5) return null;
    return [7 * (打 - 1) + 1, 打 === 5 ? 0 : 7 * 打];
  }
  const MONTH_PART_TAIL_JA =
    /^(.*?)の?(上旬|中旬|下旬|最終週|最後の週|第(?:[0-9]{1,2}|[一二三四五六七八九十]{1,3})週)$/;

  /** 「8月下旬」「来月上旬」「下旬」を暦日の幅へ解く（当てはまらなければ null）。 */
  function monthPartRangeJa(
    token: string,
    nowMs: number,
  ): { year: number; month: number; from: number; to: number; label: string } | null {
    const hit = MONTH_PART_TAIL_JA.exec(String(token || ""));
    if (!hit) return null;
    /* 上旬・中旬・下旬の表に無ければ、月の中之週を見る。 */

    const 最終週か = /^(?:最終週|最後の週)$/.test(hit[2]);
    let days = MONTH_PART_DAYS_JA[hit[2]] ?? 週の範囲Ja(hit[2]);
    if (!days && !最終週か) return null;

    const 冠 = hit[1] === "" ? "今月" : hit[1];

    if (週の語かJa(冠)) return null;
    const 絶対月 = /^(\d{4})年(\d{1,2})月$/.exec(冠);
    const resolved = 絶対月
      ? [Number(絶対月[1]), Number(絶対月[2])]
      : monthTokenToYearMonth(冠, nowMs);
    if (!resolved) return null;
    const year = Number(resolved[0]);
    const month = Number(resolved[1]);
    const 末日 = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (!days) days = [7 * (Math.ceil(末日 / 7) - 1) + 1, 0];

    if (days[0] > 末日) return null;
    return {
      year,
      month,
      from: days[0],
      to: days[1] === 0 ? 末日 : Math.min(days[1], 末日),
      label: hit[2],
    };
  }

  /** 旬の語を暦日の候補（`2026年8月21日` の形）へ展開する。他の年の同じ月日を混ぜる
   * 短い形（`8月21日`）は出さない – 旬は月を名乗った語なので年まで書く。 */
  function monthPartTermsJa(token: string, nowMs: number): string[] | null {
    const range = monthPartRangeJa(dateTokenStemJa(token) || String(token || ""), nowMs);
    if (!range) return null;
    const out: string[] = [];
    for (let d = range.from; d <= range.to; d += 1) {
      out.push(`${range.year}年${range.month}月${d}日`);
    }
    return out;
  }

  const CLOCK_JA =
    /^(?:(午前|午後|ごぜん|ごご)?([0-9]{1,2})時(?:(?:([0-9]{1,2})分)|(半))?(台)?|正午)(?:に|で|は|が|も)?$/;

  /** 時刻の語を `HH:MM` の候補へ解く（当てはまらなければ null）。分が有れば 1 点、
   * 無いときはその 1 時間ぶん（`20時` = 20:00〜20:59）を出す。 */
  function clockTimeTermsJa(
    token: string,
  ): { terms: string[]; 幅: boolean; 帯?: boolean; 解: string } | null {
    const 打たれた語 = String(token || "").trim();

    const 帯 = /^(午前中|午前|ごぜん|午後中|午後|ごご)(?:に|で|は|が|も|か|の)?$/.exec(打たれた語);
    if (帯) {
      /* 助詞を含めた全体が 帯[0] になるので、帯を分けるのは 帯[1] で見る（実測で『午後に』が
       * 午前の帯に化けた – 2026-10-08 – 打ち直した）。*/
      const 後 = 帯[1] === "午後中" || 帯[1] === "午後" || 帯[1] === "ごご";
      const 語々: string[] = [];
      for (let 時 = 後 ? 12 : 0; 時 <= (後 ? 23 : 11); 時 += 1)
        語々.push(`${String(時).padStart(2, "0")}:`);
      return {
        terms: 語々,
        幅: true,
        帯: true,
        解: 後 ? "12:00〜23:59（正午以降）" : "00:00〜11:59（正午より前）",
      };
    }

    const 午後以降Ja = /^(?:午後|ごご)(?:以降|より)$/.exec(打たれた語);
    if (午後以降Ja) {
      const 語々: string[] = [];
      for (let 時 = 12; 時 <= 23; 時 += 1) 語々.push(`${String(時).padStart(2, "0")}:`);
      return { terms: 語々, 幅: true, 帯: true, 解: "12:00〜23:59（正午以降）" };
    }
    if (/^正午(?:に|で|は|が|も)?$/.test(打たれた語)) {
      return { terms: ["12:00"], 幅: false, 解: "12:00（正午）" };
    }

    const 正午の境目Ja = /^正午(以降|より|から|前|前に)(?:に|で|は|が|も)?$/.exec(打たれた語);
    if (正午の境目Ja) {
      const 後 = 正午の境目Ja[1] !== "前" && 正午の境目Ja[1] !== "前に";
      const 語々: string[] = [];
      for (let 時 = 後 ? 12 : 0; 時 <= (後 ? 23 : 11); 時 += 1)
        語々.push(`${String(時).padStart(2, "0")}:`);
      return {
        terms: 語々,
        幅: true,
        帯: true,
        解: 後 ? "12:00〜23:59（正午以降）" : "00:00〜11:59（正午より前）",
      };
    }

    const 漢数字の数Ja = (字: string): number => {
      const 字の数: Record<string, number> = {
        一: 1,
        二: 2,
        三: 3,
        四: 4,
        五: 5,
        六: 6,
        七: 7,
        八: 8,
        九: 9,
      };
      const 十を含む =
        /^(?:(一|二|三|四|五|六|七|八|九))?十(?:(一|二|三|四|五|六|七|八|九))?$/.exec(字);
      if (十を含む) {
        const 十の位 = 十を含む[1] === undefined ? 1 : 字の数[十を含む[1]];
        const 一の位 = 十を含む[2] === undefined ? 0 : 字の数[十を含む[2]];
        return 十の位 * 10 + 一の位;
      }
      if (字 === "〇" || 字 === "零") return 0;
      return 字の数[字] === undefined ? Number.NaN : 字の数[字];
    };
    const 漢数字の語 =
      /([〇零]|[一二三四五六七八九]?十[一二三四五六七八九]?|[一二三四五六七八九])(?=時|分)/g;
    if (/^一時(?:に|でした|ですよ|ですね|です)?$/.test(打たれた語)) return null;
    const 算用に直した語 = 打たれた語.replace(漢数字の語, (_全, 数字) => {
      const 数 = 漢数字の数Ja(String(数字));
      return Number.isNaN(数) ? String(数字) : String(数);
    });

    const コロン直した語 = 算用に直した語.replace(/([0-9]{1,2}):([0-9]{2})/g, (_全, 時, 分) =>
      Number(時) <= 23 && Number(分) <= 59 ? `${Number(時)}時${Number(分)}分` : _全,
    );

    const 時境Ja =
      /^(?:(午前|午後|ごぜん|ごご))?([0-9]{1,2})時(?:(?:([0-9]{1,2})分)|(半))?(以降|より|から|前|前に)(?:に|で|は|が|も)?$/.exec(
        コロン直した語,
      );
    if (時境Ja) {
      const 前缀 = 時境Ja[1];
      const 時 = Number(時境Ja[2]);
      const 分 = 時境Ja[3] !== undefined ? Number(時境Ja[3]) : 時境Ja[4] === "半" ? 30 : null;
      const 後 = 時境Ja[5] === "以降" || 時境Ja[5] === "より" || 時境Ja[5] === "から";
      const 午前 = 前缀 === "午前" || 前缀 === "ごぜん";
      const 午後 = 前缀 === "午後" || 前缀 === "ごご";
      /* 『午前12時』は正午にも 0 時にも読めるので受けない（CLOCK_JA と同じ決まり）。 */
      if (!((午前 && 時 === 12) || 時 > 23 || (分 !== null && 分 > 59))) {
        let 時24 = 時;
        if (午後 && 時24 < 12) 時24 += 12;
        const 埋 = (n: number) => String(n).padStart(2, "0");
        const 語々: string[] = [];
        if (後) {
          if (分 === null || 分 === 0) {
            for (let h = 時24; h <= 23; h += 1) 語々.push(`${埋(h)}:`);
          } else {
            for (let m = 分; m <= 59; m += 1) 語々.push(`${埋(時24)}:${埋(m)}`);
            for (let h = 時24 + 1; h <= 23; h += 1) 語々.push(`${埋(h)}:`);
          }
        } else {
          for (let h = 0; h <= 時24 - 1; h += 1) 語々.push(`${埋(h)}:`);
          if (分 !== null && 分 > 0) {
            for (let m = 0; m <= 分 - 1; m += 1) 語々.push(`${埋(時24)}:${埋(m)}`);
          }
        }
        if (語々.length > 0) {
          const 記 = `${前缀 ?? ""}${時}時${分 === null || 分 === 0 ? "" : `${分}分`}`;
          const 頭 = `${埋(時24)}:${埋(分 === null ? 0 : 分)}`;
          return {
            terms: 語々,
            幅: true,
            帯: true,
            解: 後
              ? `${頭}〜23:59（${記}以降）`
              : 分 === null || 分 === 0
                ? `00:00〜${埋(時24 - 1)}:59（${記}より前）`
                : `00:00〜${埋(時24)}:${埋(分 - 1)}（${記}より前）`,
          };
        }
      }
    }

    const 時刻の幅Ja =
      /^(?:(午前|午後|ごぜん|ごご))?([0-9]{1,2})時(?:[0-9]{1,2}分)?(?:から|より|へ|[-−ー~〜～－―‐]|〜)(?:(午前|午後|ごぜん|ごご))?([0-9]{1,2})時(?:[0-9]{1,2}分)?(?:まで)?$/.exec(
        コロン直した語,
      );
    if (時刻の幅Ja) {
      const 時24 = (語: string, 時: number): number | null => {
        if (時 > 23) return null;
        if ((語 === "午後" || 語 === "ごご") && 時 < 12) return 時 + 12;
        if ((語 === "午前" || 語 === "ごぜん") && 時 === 12) return null;
        return 時;
      };
      const 前 = 時24(時刻の幅Ja[1] ?? "", Number(時刻の幅Ja[2]));
      const 後 = 時24(時刻の幅Ja[3] ?? "", Number(時刻の幅Ja[4]));
      if (前 !== null && 後 !== null && 後 >= 前) {
        const 埋 = (n: number) => String(n).padStart(2, "0");
        const 語々: string[] = [];
        for (let h = 前; h <= 後; h += 1) 語々.push(`${埋(h)}:`);
        const 記 = `${時刻の幅Ja[1] ?? ""}${時刻の幅Ja[2]}時から${時刻の幅Ja[3] ?? ""}${時刻の幅Ja[4]}時`;
        return {
          terms: 語々,
          幅: true,
          帯: true,
          解: `${埋(前)}:00〜${埋(後)}:59（${記} – 前後とも 1 時の帯で受けました。分は帯を絞りません）`,
        };
      }
    }
    const hit = CLOCK_JA.exec(コロン直した語);
    if (!hit) return null;
    const 午前午後 = hit[1];
    const 時の数字 = Number(hit[2]);
    const 分の数字 = hit[3] === undefined ? null : Number(hit[3]);
    const 半 = hit[4] === "半";
    /* 「午前12時」は正午にも 0 時にも読めるので受けない（締切の推測はしない – AGENTS.md）。
     * 「午後12時」は日本語では正午なので 12 のままする。 */
    if ((午前午後 === "午前" || 午前午後 === "ごぜん") && 時の数字 === 12) return null;
    let hour = 時の数字;
    if ((午前午後 === "午後" || 午前午後 === "ごご") && hour < 12) hour += 12;
    if (!(hour >= 0 && hour <= 23)) return null;
    let minute = 分の数字;
    if (minute === null && 半) minute = 30;
    if (minute !== null && !(minute >= 0 && minute <= 59)) return null;
    const 時 = String(hour).padStart(2, "0");
    const 分 = (m: number) => String(m).padStart(2, "0");
    if (minute === null) {
      const terms: string[] = [];
      for (let m = 0; m <= 59; m += 1) terms.push(`${時}:${分(m)}`);
      return { terms, 幅: true, 解: `${時}:00〜${時}:59` };
    }
    return { terms: [`${時}:${分(minute)}`], 幅: false, 解: `${時}:${分(minute)}` };
  }

  /** 「20時59分までに」のような“それ以前の時刻”という頼み方。部分一致では
   * 作れない幅なので絞り込まず、確かでする欄の場所を言う側に回す。 */
  function clockUntilQueryJa(token: string): string {
    const q = String(token || "").trim();
    if (!/(?:までに|まで)$/.test(q)) return "";
    const 芯 = q.replace(/(?:までに|まで)$/, "");
    return clockTimeTermsJa(芯) === null ? "" : 芯;
  }
  /** 月のまとまりの語について `打った語 -> 出した範囲` の組を返す（件数欄の説明用）。
   * `月末` の付く語には末日の日付を添える – 打った人が気にしているのは日付の方で、
   * 展開先の月だけ書いても答えにならない。 */
  /** 月に数字を打った『末』の形の案内（それ以外では null）。 */
  function 月の末の案内Ja(token: string, nowMs: number): string | null {
    /* 助詞を付きただけの形（`8月末まで` `来月末の締切`）も同じ案内を出す。 */
    const 芯 = dateTokenStemJa(String(token || "")) || String(token || "");
    const 形 = /^(?:(\d{4})年)?([0-9]{1,2})月の?(?:末|終わり)(?:までに|まで|に|で)?$/.exec(芯);
    if (!形) return null;
    const 月 = Number(形[2]);
    if (月 < 1 || 月 > 12) return null;
    /* 年を打たれて居ない形は、その侭では他の年の同じ月も並ぶ – その方を先に書く
     * （末日だけ書いてその年決まつたと読ませるのは噓になる）。 */
    const 基準 = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3_600_000);
    const 年 = 形[1]
      ? Number(形[1])
      : 基準.getUTCFullYear() + (月 < 基準.getUTCMonth() + 1 ? 1 : 0);
    const 日 = new Date(Date.UTC(年, 月, 0)).getUTCDate();
    const 曜日 = weekdayJaFromDate(
      `${年}-${String(月).padStart(2, "0")}-${String(日).padStart(2, "0")}`,
    );
    const 末日 = `${年}年${月}月${日}日${曜日 ? `(${曜日})` : ""}`;
    if (形[1]) return `${年}年${月}月の締切（末日は ${末日}）`;
    return `${月}月の締切（年を打たれて居ないので他の年の ${月}月 も並びます – 其の内 ${年}年${月}月 の末日は ${末日}）`;
  }

  function periodMonthPairs(query: unknown, nowMs: number): Array<[string, string]> {
    const normalized = searchNormalize(query);
    if (!normalized) return [];
    const pairs: Array<[string, string]> = [];
    normalized.split(" ").forEach((token) => {
      splitQueryToken(token, nowMs).forEach((part) => {
        let 見る = part;
        let terms = periodMonthTermsJa(part, nowMs);
        if (!terms.length) {
          const 寄せ = searchNormalize(collapseRelativeDayPhrase(part));
          if (寄せ !== "" && 寄せ !== part) {
            const 寄terms = periodMonthTermsJa(寄せ, nowMs);
            if (寄terms.length) 見る = 寄せ;
            terms = 寄terms;
          }
        }
        if (!terms.length) {
          const 案内 = 月の末の案内Ja(part, nowMs);
          if (案内) pairs.push([part, 案内]);
          return;
        }
        const first = terms[0];
        const last = terms[terms.length - 1];
        let label = first === last ? `${first}の締切` : `${first}から${last}の締切`;
        if (見る.indexOf("月末") >= 0 || 見る.indexOf("終わり") >= 0) {
          const ym = /^(\d{4})年(\d{1,2})月$/.exec(last);
          if (ym) {
            const end = new Date(Date.UTC(Number(ym[1]), Number(ym[2]), 0));
            const iso = `${ym[1]}-${ym[2].padStart(2, "0")}-${String(end.getUTCDate()).padStart(
              2,
              "0",
            )}`;
            const day = weekdayJaFromDate(iso);
            label += `（末日は ${ym[1]}年${ym[2]}月${end.getUTCDate()}日${day ? `(${day})` : ""}）`;
          }
        }
        pairs.push([見る, label]);
      });
    });
    return pairs;
  }

  /** JST の暦日を基準時刻からの日数ぶん進めた `[年, 月, 日]`。 */

  function 暦年Ja(nowMs: number): number {
    const 日番号 = Math.floor((nowMs + 9 * 3_600_000) / 86_400_000);
    /* 1970-01-01 を 0 とする日番号を、暦の年へ戻す（Howard Hinnant の days_from_civil の逆算 –
     * 400 年 = 146097 日・100 年・4 年の規則をその侭数へる）。*/
    const ずらし = 日番号 + 719468;
    const 時代 = Math.floor(ずらし / 146097);
    const 時代の日 = ずらし - 時代 * 146097;
    const 年の日 = Math.floor(
      (時代の日 -
        Math.floor(時代の日 / 1460) +
        Math.floor(時代の日 / 36524) -
        Math.floor(時代の日 / 146096)) /
        365,
    );
    const 年内の日 = 時代の日 - (365 * 年の日 + Math.floor(年の日 / 4) - Math.floor(年の日 / 100));
    const 月の番号 = Math.floor((5 * 年内の日 + 2) / 153);
    return 年の日 + 時代 * 400 + (月の番号 >= 10 ? 1 : 0);
  }

  function offsetCalendarDay(nowMs: number, days: number): number[] {
    const base = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3_600_000);
    const shifted = new Date(
      Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days),
    );
    return [shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate()];
  }

  /** 週の語に対して、その週の月〜日の暦日語（年付き）を返す。月曜始まり。 */
  function weekDayTermsJa(token: string, nowMs: number): string[] {
    const offset = RELATIVE_WEEK_OFFSETS_JA[token];
    if (offset === undefined) return [];
    const today = offsetCalendarDay(nowMs, 0);
    const dow = new Date(Date.UTC(today[0], today[1] - 1, today[2])).getUTCDay();
    const mondayShift = (dow + 6) % 7;
    const out: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const ymd = offsetCalendarDay(nowMs, -mondayShift + offset * 7 + i);
      out.push(`${ymd[0]}年${ymd[1]}月${ymd[2]}日`);
    }
    return out;
  }

  /* 画面の残り欄は「あと 51 日」に並ぶ（785 行）。そのまま貼ると `あと` `51` `日` の 3 語に
   * 割れて AND になり、どの行にも当たらなかった（2026-08-09 生成ビルドで実測: 「あと 51 日」
   * 「51日後」「51 日後」「残り51日」はすべて 0 件。数値の `51` だけ打つと日付の途中で
   * 当たって 0 件または無関係な当たり方になった）。同じ欄の「本日終了」も同じ形の日付語に
   * 展開すれば届く（「明日」などの相対日と同じ経路）。
   * 語が空格で割けるので、文字列の段階で `51日後` の 1 語に寄せる。`5日` だけの語は
   * 「今月の 5 日」の意味で使われる（上の 12 か月展開がすでにある）ので、数値だけでは
   * 絶対 day 語に寄せない。 */
  const RELATIVE_DAY_PHRASES_JA: Array<[RegExp, (n: number) => string]> = [
    [/(?:あと|残り|のこり)\s*([0-9]{1,4})\s*(?:日間|日|にち)/g, (n) => `${n}日後`],
    [/([0-9]{1,4})\s*(?:日間|日|にち)\s*(?:後|あと)/g, (n) => `${n}日後`],
    [/([0-9]{1,4})\s*(?:日|にち)\s*(?:前|まえ)/g, (n) => `${n}日前`],

    [/([0-9]{1,4})\s*(?:日間|日|にち)\s*以内/g, (n) => `${n}日以内`],

    [/([0-9]{1,2})\s*(?:週間|週)\s*以内/g, (n) => `${n * 7}日以内`],
    [/([0-9]{1,2})\s*(?:週間|週)\s*(?:後|あと|先)/g, (n) => `${n * 7}日後`],

    [/([0-9]{1,2})\s*(?:週間|週)\s*(?:前|まえ)/g, (n) => `${n * 7}日前`],
  ];

  /* 「3月中に出せるか」「11月中の締切」は月のまとまりの言い方で、`今月中`（4,698 行の表）と
   * 同じ頼み方だが、数値の月では引けなかった（2026-09-30 実測・同刻・
   * 品書 872 行）: `3月中` **0 行**・`11月中` **0 行** / 同じ月の `3月` 253 行・`11月` は通る。
   * `中` を剥がしてその月の語に寄せる – 月の長さを換えないので、寄せ先はその月の締切のまま
   * （締切の推測はしない）。`5人中` のような数え手の打ち方と取り違えないため、月として
   * 有り得る 1〜12 だけ寄せる。 */
  /* 「延長締切」「締切延長」「延長された締切」は繋げて打たれると 1 語になって落ちる
   * （実測）: 行は `延長` の語を
   * 持つ物が **21 行**あって `延長` 21 行・`締切の延長` 21 行で通るのに、**繋げた形はすべて 0 行**
   * （`延長締切` 0・`締切延長` 0・`延長された締切` 0）。延びた締切を訪ねるのは普通なので、
   * 語が割ける前に `延長` の 1 語へ寄せる。**延びた後の日付を保証しない** – 収録は `延長` と
   * 書かれた行を探すだけなので、日付で絞るなら画面の『締切まで』の欄が確かである事はその侭書く。 */
  /** 「あと 51 日」「51 日後」を `51日後` の 1 語に寄せる（語が割ける前にやる）。 */
  function collapseRelativeDayPhrase(query: unknown, nowMs?: number): unknown {
    if (typeof query !== "string" || !query) return query;
    /* 全角数字はここで半角に寄せる – 上の規則は数字の形を見るので、全角のまま空格を
       含めた打ち方（`３０ 日以内`）が語に割れて 0 件になっていた
       （2026-09-26 実測: `３０日以内` 249 行 / `３０ 日以内` **0 行** – 照合は NFKC で畳むので
       詰め打ちだけ救われていた）。行の語その物は畳まない – 検索語の側のみの寄せる。 */
    let out = query.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));

    const 数字に直す = 漢の数字に直すJa;

    const 日付の漢数字 =
      /([〇一二三四五六七八九十]{1,4})(か月|カ月|ヵ月|ヶ月|ケ月|箇月|年|月|日|週間|週)/g;
    out = out.replace(日付の漢数字, (全部: string, 数: string, 頭: string) => {
      const 数字 = 数字に直す(数);
      return 数字 === null ? 全部 : 数字 + 頭;
    });

    const 月日の漢数字の空格 =
      /([〇一二三四五六七八九十]{1,4})[ \u3000]+([月日])(?![ \u3000]*(?:後|前|間))/g;
    out = out.replace(月日の漢数字の空格, (全部: string, 数: string, 字: string) => {
      const 数字 = 数字に直す(数);
      return 数字 === null ? 全部 : `${数字}${字}`;
    });
    const 週の漢数字の空格 = /([〇一二三四五六七八九十]{1,4})[ \u3000]+週間/g;
    out = out.replace(週の漢数字の空格, (全部: string, 数: string) => {
      const 数字 = 数字に直す(数);
      return 数字 === null ? 全部 : `${数字}週間`;
    });

    const 回の漢数字 = /第([〇一二三四五六七八九十]{1,4})(?=ラウンド)/g;
    out = out.replace(回の漢数字, (全部: string, 数: string) => {
      const 数字 = 数字に直す(数);
      /* ラウンドの語は見ている（先読み）ので、置き換えるのは『第+数字』だけ –
       * 語をもう一度足すと『第1ラウンドラウンド』に化けた（実測 – 検査が落とした）。 */
      return 数字 === null ? 全部 : `第${数字}`;
    });
    /* **繋げて打たれた語は此処で寄せる** – 下の `N月中` `N月末` の規則は月の語を壊すので、
     * その前に語の形を見る（`3月末まで` のように月と末尾が連なる打ち方も頭の表で受ける –
     * 月の数え方は 1〜12 に絞る）。 */

    const 未定を繋げた言い方 = /(?:締切|締切り|締めしきり|締め|しめきり|〆切|〆)未定/g;
    const 未定を繋げた別の頭 = /(?:期限|日付)未定/g;

    const 期日までの言い方 =
      /((?:0?[1-9]|1[0-2])月末?|(?<!週)(?:[月火水木金土日]曜(?:日)?|平日)|(?<!週)(?<![今来先再])週末)[ \u3000]*まで/g;
    /* 「今月いっぱい」「来週いっぱい」も同じ頼み方（実測 `今月いっぱい` **0 行** / `今月` 189 行・
     * `来週いっぱい` **0 行** / `来週` は通る）。`まで` と違い期間の語の規則が同じ行集合に寄せる
     * 語なので含めてよい（実測で対称差 0 である事を検査する）。`週末いっぱい` `金曜いっぱい` も
     * 同じで、その方に範囲の規則は無いので接頭辞付き（`来週末いっぱい`）も受ける。 */
    const いっぱいの言い方 =
      /((?:[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}|[0-9]{1,2}[-/][0-9]{1,2}|[0-9]{1,2}月[0-9]{1,2}日|(?:0?[1-9]|1[0-2])月末?|今月|来月|再来月|先月|(?:今週|来週|再来週|先週)(?:[月火水木金土日]曜(?:日)?|週末)|[月火水木金土日]曜(?:日)?|週末|平日|今週|来週|再来週|先週|今年|来年))(?:[ \u3000]*いっぱい|一杯)/g;

    out = out.replace(
      /((?:[0-9]{4}年)?[0-9]{1,2})月([0-9]{1,2})日?[〜～~-]((?:[0-9]{4}年)?[0-9]{1,2})月([0-9]{1,2})日?/g,
      "$1月$2日から$3月$4日",
    );
    out = out.replace(
      /([0-9]{1,2})\/([0-9]{1,2})(?:から|より|へ|[〜～~-])([0-9]{1,2})\/([0-9]{1,2})/g,
      "$1月$2日から$3月$4日",
    );

    out = out.replace(
      /((?:[0-9]{4}年)?[0-9]{1,2}|来|再来|今|先々|先|昨)月[〜～~](?=(?:[0-9]{4}年)?(?:[0-9]{1,2}|来|再来|今|先々|先|昨)月)/g,
      "$1月から",
    );

    const 初旬の言い方 = /初旬/g;

    const 頃の言い方 =
      /([上下]旬|中旬|月初|月末|週末|年度初め|年度始め|年度末)(?:頃|ころ|ごろ|辺り|あたり)/g;

    const 中旬の別の言い方 = /(?:半ば|中頃|中盤)/g;
    /* 「本年度」「当年度」も同じ収録の年度語彙に寄せる（実測 `今年度` 872 行・`来年度` 273 行が
     * 通るのに `本年度` **0 行**・`当年度` **0 行** – 行政寄りの書き方をする人が損をしない為）。
     * 年度その物の幅はその方の表が日付で書くので、ここでは語を揃えるだけ。 */

    const 月の幅の裸の言い方 = /(?<![0-9来今再去本当週])(?:月の|月)(?:後半頃|後半|半ば|中盤)/g;
    const 下旬の別の言い方 = /((?:[0-9]{1,2}月|来月|今月|再来月)の?)後半頃?/g;

    const より後の言い方 = /より(?:後ろ|後|あと|のち)/g;
    const 月終わりの言い方 = /(?:月の?(?:終わり|末日))/g;
    const 年度の別の言い方 = /(?:本年度|当年度)/g;
    out = out.replace(頃の言い方, "$1");
    out = out.replace(初旬の言い方, "上旬");
    out = out.replace(より後の言い方, "以降");
    out = out.replace(月終わりの言い方, "月末");
    out = out.replace(下旬の別の言い方, "$1下旬");

    out = out.replace(月の幅の裸の言い方, (全部) => (全部.indexOf("後半") >= 0 ? "下旬" : "中旬"));
    out = out.replace(中旬の別の言い方, "中旬");
    out = out.replace(年度の別の言い方, "今年度");

    const 週の目の言い方 = /第?\s*([0-9]{1,2})\s*週\s*目/g;
    out = out.replace(週の目の言い方, (全部: string, 数: string) => {
      const 目の週の数Ja = Number(数);
      if (目の週の数Ja < 1 || 目の週の数Ja > 5) return 全部;
      return `第${数}週`;
    });

    out = out.replace(
      /(締切|締め切り|〆切|しめきり)\s*(?:まで|から)\s*([0-9]{1,3})\s*(日間|日|週間|週)(?![以未前後])/g,
      "$1まで$2$3",
    );

    const 相対日の語Ja =
      "(?:明々後日|明後日|一昨日|おととい|昨日|きのう|今日|きょう|本日|明日|あした|あす|明後日中|明日中|今日中|本日中|今週中|こんしゅう中|来週中|らいしゅう中|再来週中|先週中|先々週中|今週末|来週末|先週末|(?:今週|こんしゅう|来週|らいしゅう|再来週|再々週|来々週|さいしゅう|さらいしゅう|先週|せんしゅう|先々週|せんせんしゅう|翌週|前週|昨週)(?:[月火水木金土日]曜|末)?|(?:あと|残り)?[0-9]{1,3}(?:日間|日|にち)?後|[0-9]{1,3}(?:日間|日|にち)前|(?:[0-9]{4}年)?[0-9]{1,2}月[0-9]{1,2}日?|(?:[0-9]{4}[-/])?[0-9]{1,2}[-/][0-9]{1,2}日?|(?:[0-9]{1,2}月|今月|来月|先月|今|来|先)?(?:上旬|中旬|下旬)|[0-9]{1,2}日|[月火水木金土日]曜(?:日)?)";
    const 相対日の幅の記号Ja = new RegExp(`${相対日の語Ja}[〜～~－―‐−ー]${相対日の語Ja}`, "g");
    out = out.replace(相対日の幅の記号Ja, (全部) => 全部.replace(/[〜～~－―‐−ー]/, "から"));

    const 暦月語の項Ja = "|[0-9]{1,2}月|今月|来月|先月|再来月|昨月|先々月|翌月|前月|来々月";
    const 列挙の頭目印Ja = 相対日の語Ja.replace("|[0-9]{1,2}日", 暦月語の項Ja);

    const 列挙の語目印Ja = 相対日の語Ja.replace("|[0-9]{1,2}日", `${暦月語の項Ja}|[0-9]{1,2}日`);
    const 列挙の区切り語Ja = "(と|または|もしくは|あるいは|及び|ならびに|か)";
    const 列挙の併せJa = new RegExp(`^(${列挙の頭目印Ja})${列挙の区切り語Ja}(${列挙の語目印Ja})$`);
    const 列挙の連鎖Ja = new RegExp(
      `^(${列挙の頭目印Ja})${列挙の区切り語Ja}(${列挙の語目印Ja}(?:${列挙の区切り語Ja}${列挙の語目印Ja})+)$`,
    );
    const 裸の区切りJa = new RegExp(`^${列挙の区切り語Ja}$`);
    const 頭単独Ja = new RegExp(`^${列挙の頭目印Ja}$`);
    const 語単独Ja = new RegExp(`^${列挙の語目印Ja}$`);
    const 列挙の語列Ja = out.split(" ").filter((語) => 語.length > 0);
    /* 空格で孤立した目印（`来週 と 再来週`）は先に隣を吸う – 左は頭側の目印、右は語側の目印
     * （裸の日が左に来る形は寄せない決まりを同じ処で守る）。 */
    for (let i = 列挙の語列Ja.length - 2; i >= 0; i -= 1) {
      if (
        裸の区切りJa.test(列挙の語列Ja[i]) &&
        頭単独Ja.test(列挙の語列Ja[i - 1]) &&
        語単独Ja.test(列挙の語列Ja[i + 1])
      ) {
        列挙の語列Ja[i - 1] = 列挙の語列Ja[i - 1] + 列挙の語列Ja[i] + 列挙の語列Ja[i + 1];
        列挙の語列Ja.splice(i, 2);
      }
    }
    /* 右から順に隣を寄せる – 寄せた語が次の寄せの右側になれるので、三つ以上連ねた形
     * （`来週と 再来週と 来月`）も一束になる。每回空格が減るので必ず了う。 */
    for (let i = 列挙の語列Ja.length - 2; i >= 0; i -= 1) {
      const 併 = 列挙の語列Ja[i] + 列挙の語列Ja[i + 1];
      if (列挙の併せJa.test(併) || 列挙の連鎖Ja.test(併)) {
        列挙の語列Ja[i] = 併;
        列挙の語列Ja.splice(i + 1, 1);
      }
    }
    out = 列挙の語列Ja.join(" ");

    out = out.replace(
      /([0-9]{1,2})[ \u3000]+月(?=[ \u3000]*(?:までに|まで|末|中|内|以内|いっぱいに|いっぱい|以降|以後|以来))/g,
      "$1月",
    );

    const 単位に付いた助字 = /([0-9]+|再々|再来|昨|明|今|来|先|翌|再)[ \u3000]+([年月日時週])の/g;
    out = out.replace(単位に付いた助字, "$1$2 ");

    const 複合語の切れ目: Array<[RegExp, string]> = [
      [/(^|[ \u3000])週[ \u3000]+末/g, "$1週末"],
      [/(^|[ \u3000])(今|来|先|再来)[ \u3000]+(月末|月中)/g, "$1$2$3"],
      [/(^|[ \u3000])(今|来)[ \u3000]+年度/g, "$1$2年度"],
      [/(^|[ \u3000])年[ \u3000]+初[ \u3000]+め/g, "$1年初め"],
      [/(^|[ \u3000])年[ \u3000]+初/g, "$1年初"],

      [/(^|[ \u3000])(今|来|先|再来|昨|翌)[ \u3000]+週末/g, "$1$2週末"],
      [/(^|[ \u3000])(今|来|昨|再来|翌)[ \u3000]+年中/g, "$1$2年中"],
      [/(^|[ \u3000])(昨|再々)[ \u3000]+週/g, "$1$2週"],
      [/(^|[ \u3000])昨[ \u3000]+月/g, "$1昨月"],
      [/(^|[ \u3000])(翌|再来)[ \u3000]+年度/g, "$1$2年度"],

      [/(^|[ \u3000])(今|来|先|再来|昨|翌)[ \u3000]+(上旬|中旬|下旬)/g, "$1$2月 $3"],
      [/(今|来|先|再来|昨|翌)(上旬|中旬|下旬)/g, "$1月 $2"],

      [
        /(^|[ \u3000])((?:[0-9]{4}[ \u3000]*年)?[0-9]{1,2}|再来|来|今|先|昨|翌)[ \u3000]*月[ \u3000]+(上旬|中旬|下旬)[ \u3000]+(までに|まで|以降|以後|この先|以来|から|より)/g,
        "$1$2月$3$4",
      ],

      [
        /(^|[ \u3000])((?:[0-9]{4}年)?[0-9]{1,2}|来|今|先|再来|翌)月[ \u3000]*(?:の)?[ \u3000]*(末日|終わり)/g,
        "$1$2月末",
      ],

      [
        /(^|[ \u3000])((?:[0-9]{4}年)?[0-9]{1,2}|来|今|先|再来|翌)月[ \u3000]*(?:の)?[ \u3000]*(後半)/g,
        "$1$2月下旬",
      ],
      [
        /(^|[ \u3000])((?:来|今|去|明|昨|翌)年)[ \u3000]*(?:の)?[ \u3000]*(末日|末)(?![぀-ヿ一-龥])/g,
        "$1$2 12月",
      ],
      [
        /(^|[ \u3000])((?:来|今|去|明|昨|翌)年)[ \u3000]*(?:の)?[ \u3000]*(初め|始め)(?![぀-ヿ一-龥])/g,
        "$1$2 1月",
      ],
      [
        /(^|[ \u3000])((?:[0-9]{4}年)?[0-9]{1,2}|来|今|先|再来|翌)月[ \u3000]*(?:の)?[ \u3000]*(末)/g,
        "$1$2月$3",
      ],
      /* 週の語・年の語にその真ん中の語を直に繋げた形（`来週半ば` `今年中頃`）は、この段では
       * 割れない（試して実測 – この目で `来週半ば` を `来週 半ば` に割つても 0 件の侭で、
       * 使用者が空格を打った形の 52 件と違つた。その方はその語を解く段が語の割りの**前**で
       * 受ける形になっている為、この段からの寄せでは届かない）。その為 21 組（`来週半ば`
       * `来週中頃` `来週初旬` `今年半ば` `2026年半ば` 等）は今も 0 件・案内も無し –
       * 直すならその方の段（その週の塊を決める所）に別の群で足す（残した差に載せた）。*/
    ];
    for (const [切れ目, 複合語] of 複合語の切れ目) out = out.replace(切れ目, 複合語);

    out = out.replace(
      /(^|[ \u3000])([0-9]+|[〇零一二三四五六七八九十百]+|半)[ \u3000]+(年後|年前|か月後|ヶ月後|ケ月後|箇月後|週間後|週後|か月前|ヶ月前|ケ月前|箇月前|个月前|か月|个月|ケ月|箇月|月前|週間|半年)(?=(?:から|より|以降|以後|この先|以来|までに|まで))/g,
      "$1$2$3",
    );

    const 其れより後の尾Ja = /([^ \u3000]+)[ \u3000]+(以降|以後|この先)/g;
    out = out.replace(其れより後の尾Ja, (全体, 頭, 尾) =>
      日付らしき語Ja(頭) ? `${頭}${尾}` : 全体,
    );

    const 日の語か = (語: string) => 日付らしき語Ja(語) || 解ける日語かJa(語);

    out = out.replace(
      /(^|[ \u3000])((?:来|今|先|昨|翌)年度)[ \u3000]*(?:の)?[ \u3000]*(末|末日|終わり|初め|始め|当初)/g,
      "$1$2$3",
    );

    out = out.replace(
      /(^|[ \u3000])((?:来|今|先|昨|翌)年度)([0-9]{1,2}月|[〇一二三四五六七八九十]{1,3}月|上旬|中旬|下旬|初旬)/g,
      "$1$2 $3",
    );
    out = out.replace(
      /(^|[ \u3000])((?:来|今|去|明|昨|翌)年|[0-9]{4}年|(?:明治|大正|昭和|平成|令和)(?:[0-9]{1,2}|[〇一二三四五六七八九十]{1,3}|元)年)(上旬|中旬|下旬|初旬|中頃|半ば)/g,
      "$1$2 $3",
    );

    /* 寄せるのは**繋げた形だけ**にした – 離して打つた形（`年末 下旬 締切` 14 件）は字面の重なりで
     * 決まつて居り、同じ意味の月の語（`12月 下旬 締切` 11 件）と数が合は無い（別の方向にも外れる –
     * `年末 上旬` 5 件 ⇔ `12月 上旬` 96 件）。行を減らす直しはしないので、離した形はその侭にして、
     * 繋げた形だけをその方の表が持つ月の語へ寄せる。離した形のこの食ひ違ひは残した差。*/
    out = out.replace(/(^|[ \u3000])(年末)(上旬|中旬|下旬|初旬|中頃|中盤|半ば)/g, "$112月 $3");

    out = out.replace(/(^|[ \u3000])(年末)(中)(?![旬])/g, "$112月中");
    out = out.replace(/(^|[ \u3000])(年末)(12月)/g, "$112月");
    out = out.replace(/(^|[ \u3000])(年初|年始|年明け)(中)(?![旬])/g, "$11月中");
    out = out.replace(/(^|[ \u3000])(年初|年始|年明け)(1月)/g, "$11月");
    out = out.replace(/(^|[ \u3000])(年度末)(中)(?![旬])/g, "$13月中");
    out = out.replace(/(^|[ \u3000])(年度末)(3月)/g, "$13月");
    out = out.replace(/(^|[ \u3000])(年度初め|年度始め|年度当初)(中)(?![旬])/g, "$14月中");
    out = out.replace(/(^|[ \u3000])(年度初め|年度始め|年度当初)(4月)/g, "$14月");

    out = out.replace(/(^|[ \u3000])((?:今|来|先|再来|再々|翌)週)内/g, "$1$2");
    out = out.replace(/(^|[ \u3000])(年度末)(上旬|中旬|下旬|初旬|中頃|中盤|半ば)/g, "$13月 $3");
    out = out.replace(
      /(^|[ \u3000])(年初|年始|年明け)(上旬|中旬|下旬|初旬|中頃|中盤|半ば)/g,
      "$11月 $3",
    );
    out = out.replace(
      /(^|[ \u3000])(年度初め|年度始め|年度当初)(上旬|中旬|下旬|初旬|中頃|中盤|半ば)/g,
      "$14月 $3",
    );

    out = out.replace(/(^|[ \u3000])((?:来|今|去|明|昨|翌)年)(?:に|の|へ)(?=$|[ \u3000])/g, "$1$2");

    out = out.replace(
      /(^|[ \u3000])((?:今|来|先|再来|再々|翌|去|前|昨)週)(?:の)?[ \u3000]*(上旬|中旬|下旬|初旬|中頃|中盤|半ば)/g,
      "$1$2 $3",
    );
    out = out.replace(/(^|[ \u3000])((?:来|今|先|昨|翌)年度)(?:末|末日|終わり)/g, "$1$2 3月");
    out = out.replace(/(^|[ \u3000])((?:来|今|先|昨|翌)年度)(?:初め|始め|当初)/g, "$1$2 4月");
    out = out.replace(/(^|[ \u3000])((?:来|今|去|明|昨|翌)年)(?:末|末日)/g, "$1$2 12月");
    out = out.replace(/(^|[ \u3000])((?:来|今|去|明|昨|翌)年)(?:初|初め|始め)/g, "$1$2 1月");

    out = out.replace(
      /(^|[ \u3000])((?:来|明|翌)年|再来年)([0-9]{1,2}月|[〇一二三四五六七八九十]{1,3}月)(から|まで|より|以降|以後|この先|までに)/g,
      "$1$2 $3$4",
    );

    out = out.replace(
      /(^|[ \u3000])((?:今|来|再来|昨|去|明|翌)年|[0-9]{4}年|(?:明治|大正|昭和|平成|令和)(?:[0-9]{1,2}|[〇一二三四五六七八九十]{1,3}|元)年)内/g,
      "$1$2",
    );
    /* 元号の年＋『中』も同じ。『内』は上の目が既に受ける。*/
    out = out.replace(
      /(^|[ \u3000])([0-9]{4}年|(?:明治|大正|昭和|平成|令和)(?:[0-9]{1,2}|[〇一二三四五六七八九十]{1,3}|元)年)中/g,
      "$1$2",
    );

    out = out.replace(/(^|[ \u3000])ランク([A-Za-zＡ-Ｚａ-ｚ][A-Za-zＡ-ｚ]*[*＊]?)/g, "$1$2ランク");

    out = out.replace(
      /(^|[ \u3000])((?:再来年|[0-9]{4}年))([0-9]{1,2}月|[〇一二三四五六七八九十]{1,3}月)(?![0-9]{1,2}日|[0-9第])(?![ \u3000]*(?:から|まで|より|以降|以後|この先|までに))(?=$|[ \u3000])/g,
      "$1$2 $3",
    );

    if (Number.isFinite(nowMs)) {
      const 今の年 = 暦年Ja(nowMs as number);
      out = out.replace(
        /(^|[ \u3000])([0-9]{4})年([0-9]{1,2}月|[〇一二三四五六七八九十]{1,3}月)(から|まで|より|以降|以後|この先|までに)/g,
        (全部, 前, 年, 月, 尾) => (Number(年) > 今の年 ? `${前}${年}年 ${月}${尾}` : 全部),
      );
      /* 元号で書いた先の年（`令和九年12月から`）も同じ。元号は絶対の年なので、
       * 西暦に読み替へて今の年と較べられる（時計は渡された物を使う）。*/

      out = out.replace(
        /(^|[ \u3000])((?:明治|大正|昭和|平成|令和)(?:[0-9]{1,2}|[〇一二三四五六七八九十]{1,3}|元)年)([0-9]{1,2}月|[〇一二三四五六七八九十]{1,3}月)(?![0-9]{1,2}日|[0-9第])(?=$|[ \u3000])/g,
        (全部, 前, 年, 月) => {
          const 西暦 = eraYearTermsJa(年)?.西暦 ?? null;
          return 西暦 !== null && 西暦 > 今の年 ? `${前}${年} ${月}` : 全部;
        },
      );
      out = out.replace(
        /(^|[ \u3000])((?:明治|大正|昭和|平成|令和)(?:[0-9]{1,2}|[〇一二三四五六七八九十]{1,3}|元)年)([0-9]{1,2}月|[〇一二三四五六七八九十]{1,3}月)(から|まで|より|以降|以後|この先|までに)/g,
        (全部, 前, 年, 月, 尾) => {
          /* 西暦はそちらの機械（和暦の語を解く口）に聞く – 元号の表を二つ持たない。*/
          const 西暦 = eraYearTermsJa(年)?.西暦 ?? null;
          return 西暦 !== null && 西暦 > 今の年 ? `${前}${年} ${月}${尾}` : 全部;
        },
      );
    }
    out = out.replace(
      /(^|[ \u3000])((?:来|今|去|明|昨|翌)年)([0-9]{1,2}月|[〇一二三四五六七八九十]{1,3}月)(?![ \u3000]*(?:から|より|以降|以後|この先|以来|までに|まで))/g,
      "$1$2 $3",
    );
    const 語の連なりJa =
      /(^|[ \u3000])(締切|提出|投稿|論文|発表|会議|ワークショップ|チュートリアル|申込|登録|通知|結果|再|延長|camera|ラウンド)(?:時刻|時間|場所|料)/g;
    out = out.replace(
      語の連なりJa,
      (全体, 境, 頭) => `${境}${頭} ${全体.slice(境.length + 頭.length)}`,
    );
    const 離した幅の区切りJa = /([^ \u3000]+)[ \u3000]+(から|より)[ \u3000]*([^ \u3000]+)/g;

    const 繋がれた幅の尾Ja = /([^ \u3000]+?(?:から|より))[ \u3000]+([^ \u3000]+)/g;
    out = out.replace(離した幅の区切りJa, (全体, 前, 尾, 後) =>
      日の語か(前) && 日の語か(後) ? `${前}${尾}${後}` : 全体,
    );
    out = out.replace(繋がれた幅の尾Ja, (全体, 前, 後) => {
      const 芯 = 前.replace(/(?:から|より)$/, "");
      return 日の語か(芯) && 日の語か(後) ? `${前}${後}` : 全体;
    });

    out = out.replace(いっぱいの言い方, "$1");
    out = out.replace(期日までの言い方, "$1");

    out = out.replace(/最終版の提出/g, "最終版提出");

    out = out.replace(/カメラレディの準備/g, "カメラレディ");

    out = out.replace(/(?:參加登録|登録)(?:が|は)まだ/g, "登録締切");
    out = out.replace(未定を繋げた言い方, "締切 未定");
    out = out.replace(未定を繋げた別の頭, "未定");

    const 月のまとまり = /([0-9]{1,2})月[ \u3000]*中(?!旬|頃|途|止|断)(?:[ \u3000]*に)?/g;
    /* 「8月締め」「来月〆」「8月〆切… – 実測と理由は第 723 回に SPEC へ送つた。*/

    const 締切を繋げた言い方 =
      /((?:(?:年度当初|年度初め|年度始め|年度末|再来月末|来月末|今月末|年末|年初め|年始め|年始|年初|年明け|月末)|[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}|[0-9]{1,2}[-/][0-9]{1,2}|(?:今月|来月|再来月|先月|昨月|先々月|翌月|前月)[0-9]{1,2}日|[0-9]{1,2}月[0-9]{1,2}日|(?:[月火水木金土日]曜(?:日)?|週末|平日|明後日|明日|昨日|本日|今日)|(?:(?:今|来|再来|先|[0-9]{1,2})月?)?(?:上|中|下)旬|(?:0?[1-9]|1[0-2])月|今月|来月|再来月|先月|今年|来年|再来年|今年度|来年度|今週|来週|再来週|先週))(?:の)?(?:締めしきり|締め|締切|締切り|しめきり|〆切|〆)/g;

    const 月の末尾 = /([0-9]{1,2})月[ \u3000]*末(?!処理|尾)/g;

    const 延長の言い方: Array<[RegExp, string]> = [
      [/(?:延長|延伸)(?:された)?(?:締切|期限|デッドライン)/g, "延長"],
      [/(?:締切|期限|デッドライン)の?(?:延長|延伸)/g, "延長"],
    ];
    RELATIVE_DAY_PHRASES_JA.forEach(([pattern, to]) => {
      out = out.replace(pattern, (_all, digits) => {
        const n = Number(digits);
        return n >= 1 && n <= 3650 ? to(n) : _all;
      });
    });
    延長の言い方.forEach(([形, 寄せ先]) => {
      out = out.replace(形, 寄せ先);
    });
    /* `N月末` を先にその月へ寄せる – 後に繋げた締切の語を割るとき、`3月末締め` が
     * `3月 締切` まで届く順番にする（逆順だと `末` が邪魔して締切の語が割れなかった – 実測）。 */
    out = out.replace(月の末尾, (全部, 数字) => {
      const 月 = Number(数字);
      return 月 >= 1 && 月 <= 12 ? `${月}月` : 全部;
    });
    out = out.replace(締切を繋げた言い方, "$1 締切");
    out = out.replace(月のまとまり, (全部, digits) => {
      const n = Number(digits);
      return n >= 1 && n <= 12 ? `${n}月` : 全部;
    });

    const 敬語の語尾Ja =
      /(?:でしょうか|ですかね|ですか|でした|でしょう|でしょ|しましたね|ましたね|でしたね|ですよ|ですよね|ですね|です|ではありません|じゃありません|ではない|じゃない|だと思います|だと思います|になります|になりたい|なりたい|しました|します|ました|ます|したい|だよな|だね|だよ|かな|かなぁ|だと思う|っけ)[、。，．,.!?！？〜~…\s]*$/;

    const 格助詞の語尾Ja = /(?:を|と|へ)[、。，．,.!?！？〜~…\s]*$/;

    const 平仮名だけJa = /^[\u3041-\u309f\s]+$/;

    const 語尾の助詞Ja = /(?:で|に|は|が|も|の|や)[、。，．,.!?！？〜~…\s]*$/;

    const 限定の語尾Ja = /(?:だけ|のみ|しか)[、。，．,.!?！？〜~…\s]*$/;

    const 限定の語名Ja = ["限定", "専用", "専門", "特化", "向け", "歓迎"];
    const 限定の語名の語尾Ja = new RegExp(`(?:${限定の語名Ja.join("|")})[、。，．,.!?！？〜~…s]*$`);

    const 讓りの形の限定Ja = new Set([
      "学生向け",
      "学生限定",
      "大学院生向け",
      "若手限定",
      "女性限定",
      "男性限定",
      "機械向け",
      "オンライン限定",
      "ハイブリッド限定",
      "バーチャル限定",
    ]);
    /* 讓すのはその語その物だけ – 頭照合にすると `オンライン参加可` のやうな長い語まで讓す
     * （実測 – 頭照合では `オンライン参加可だけ` 0 行 / `オンライン参加可` 109 行だつた）。*/
    const 限定を讓る語Ja = new Set(["オンライン", "ハイブリッド", "バーチャル", "対面"]);

    const 幅の語尾Ja = /(?:までに|まで|なので|のに|ので)[、。，．,.!?！？〜~…\s]*$/;

    const 語頭の助詞Ja = /^(?:で|に|は|が|も|の|や)/;

    out = out.replace(
      /([^\s]{2,}?)((?:だけ|のみ|しか|限定|専用|専門|特化|向け|歓迎))の(?=[\u4e00-\u9fff\u30a1-\u30f6ーA-Za-z0-9])/g,
      /* 助詞（だけ等）は第 657 回と同じ讓し、限定の語名は讓りの形だけ讓す。*/
      (全部, 頭, 助) =>
        (
          限定の語名Ja.includes(助)
            ? 讓りの形の限定Ja.has(頭 + 助)
            : 限定を讓る語Ja.has(頭) || 讓りの形の限定Ja.has(頭 + 助)
        )
          ? 全部
          : `${頭} `,
    );

    const 打たれた語々 = out.split(" ");

    /* 前後の語は空格で割れた片段でも見る（`8 月 と 9 月` の前後は `月` と `9`） –
     * 数字・単位・その日を決める語なら暦日の一片として寄せる機械が後に控えている。 */
    const 暦日の一片Ja = (語: string): boolean =>
      !!語 &&
      (/^[0-9]+$/.test(語) ||
        /^[0-9]+[年月日]$/.test(語) ||
        /^[年月日]$/.test(語) ||
        解ける日語かJa(語));
    const 列挙の助詞かJa = (語: string, 番: number): boolean =>
      語 === "と" &&
      番 > 0 &&
      番 + 1 < 打たれた語々.length &&
      暦日の一片Ja(打たれた語々[番 - 1]) &&
      暦日の一片Ja(打たれた語々[番 + 1]);
    const 敬語を剥いだ語々 = 打たれた語々.map((語, 番) => {
      let 文 = 語;
      for (let 回 = 0; 回 < 3; 回 += 1) {
        let 次 = 文.replace(敬語の語尾Ja, "");
        if (次 === 文) {
          /* 並べた語の助詞は剥がない – そのまま」剥ぐと語の組が積に割れる */
          const 格を剥いだ = 文.replace(格助詞の語尾Ja, "");
          /* 平仮名だけの語は守る – ただし語その物が格助詞で了う場合（『ai を』の『を』）は
           * 落とす – そのまま残すと語のかけ算になって 0 行だった（実測『ai を』0 行 / 『ai』331 行）。*/
          if (列挙の助詞かJa(語, 番)) {
            次 = 文;
          } else if (格を剥いだ.length === 0 || !平仮名だけJa.test(文)) 次 = 格を剥いだ;
        }

        if (次 === 文) {
          const 助詞を剥いだ = 文.replace(語尾の助詞Ja, "");

          if (
            助詞を剥いだ !== 文 &&
            助詞を剥いだ.length >= 2 &&
            !幅の語尾Ja.test(文) &&
            dateTokenStemJa(文) === "" &&
            !平仮名だけJa.test(文)
          )
            次 = 助詞を剥いだ;
        }
        if (次 === 文) {
          /* 限定の助詞。上の番と同じ守りで見、讓す語の列を一つ增やすだけ。 */
          const 限定を剥いだ = 文.replace(限定の語尾Ja, "");
          if (
            限定を剥いだ !== 文 &&
            限定を剥いだ.length >= 2 &&
            !限定を讓る語Ja.has(限定を剥いだ) &&
            !平仮名だけJa.test(文)
          )
            次 = 限定を剥いだ;
        }
        if (次 === 文 && !讓りの形の限定Ja.has(文)) {
          const 語名を剥いだ = 文.replace(限定の語名の語尾Ja, "");
          if (語名を剥いだ !== 文 && 語名を剥いだ.length >= 2 && !平仮名だけJa.test(文))
            次 = 語名を剥いだ;
        }
        if (次 === 文) {
          const 頭を剥いだ = 文.replace(語頭の助詞Ja, "");
          if (
            頭を剥いだ !== 文 &&
            頭を剥いだ.length >= 2 &&
            !平仮名だけJa.test(文) &&
            番 > 0 &&
            打たれた語々.slice(0, 番).some((前語) => 前語.length > 0)
          )
            次 = 頭を剥いだ;
        }
        /* 残りが一字になる剥ぎ方はしない（実測で入れてしまった – 『すね』が『す』に化けて
         * 389 行に出た – 一字の語は行の文字列で大量に当たるので、寄せた側が元の語より
         * 広くなり過ぎる）。敬語その物で了う形（`です`）はその侭置く。*/
        if (次 === 文 || (次.length > 0 && 次.length < 2)) break;
        文 = 次;
      }
      return 文;
    });
    /* 敬語だけだった語（空格で離して打たれた『来週 でした』の『でした』）は落とす –
     * そのまま残すと語のかけ算になって 0 行だった（実測 0 行 / 『来週』53 行）。
     * 検索語ぜんぶが敬語で了う場合（『です』だけ）はその侭返す – 空の検索語にしない。*/

    const 残った語々 = 敬語を剥いだ語々.filter(
      (語, 番) =>
        語.length > 0 &&
        !(
          語.length <= 2 &&
          番 > 0 &&
          Array.from(語).every((字) => QUERY_PARTICLE_SPLIT_CHARS.indexOf(字) >= 0)
        ),
    );
    out = (残った語々.length > 0 ? 残った語々 : 打たれた語々).join(" ");
    return out;
  }

  function numericRelativeDay(token: string, nowMs: number): string[] | null {
    let 数 = 0;
    let 単位 = "";
    let 前後 = "";
    const 数え = /^([0-9]{1,4})(日|か月|カ月|ヵ月|ヶ月|ケ月|箇月|年)(後|前)$/.exec(token);
    if (数え) {
      数 = Number(数え[1]);
      単位 = 数え[2];
      前後 = 数え[3];
    } else if (token === "半年後" || token === "半年前") {
      /* 「半年」は 6 か月 – 暦の決まりで足す引き算なので、寄せ先は月の数（日数に換えない）。 */
      数 = 6;
      単位 = "か月";
      前後 = token === "半年後" ? "後" : "前";
    } else if (/^半(?:月|か月|ヶ月|カ月|ケ月|ヵ月|箇月)(後|前)$/.test(token)) {
      数 = 15;
      単位 = "日";
      前後 = token.slice(-1) === "後" ? "後" : "前";
    } else {
      return null;
    }
    const n = 数;
    const 符号 = 前後 === "後" ? 1 : -1;
    /* 上限は単位ごとに置く – 年の語で 9999 年を作らせない（その方の言い方は日数で引ける）。 */
    if (単位 === "日") {
      if (!(n >= 1 && n <= 3650)) return null;
      const ymd = offsetCalendarDay(nowMs, 符号 * n);
      return [token, `${ymd[0]}年${ymd[1]}月${ymd[2]}日`, `${ymd[1]}月${ymd[2]}日`];
    }
    /* 上限を超えたら寄せない – 0 か月として今日の日を返すと、打った人と違う日を
     * 「その通り」に書いてしまう（999 か月前 → 今日 – 直し中に実測で出た）。 */
    if (単位 === "か月" && !(n >= 1 && n <= 120)) return null;
    if (単位 === "年" && !(n >= 1 && n <= 30)) return null;
    const 月数 = 単位 === "年" ? 符号 * n * 12 : 符号 * n;
    const 元 = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3_600_000);
    const 合計月 = 元.getUTCMonth() + 月数;
    const 年 = 元.getUTCFullYear() + Math.floor(合計月 / 12);
    const 月 = ((合計月 % 12) + 12) % 12;
    /* 日めくりはしない – その月の末日を超えない様に置く（上の注）。 */
    const 末日 = new Date(Date.UTC(年, 月 + 1, 0)).getUTCDate();
    const 日 = Math.min(元.getUTCDate(), 末日);
    return [token, `${年}年${月 + 1}月${日}日`, `${月 + 1}月${日}日`];
  }

  function withinDaysTermsJa(token: string, nowMs: number): string[] | null {
    const matched = /^([0-9]{1,4})日以内$/.exec(token);
    if (!matched) return null;
    const days = Number(matched[1]);

    if (!(days >= 1 && days <= 365)) return null;
    const out: string[] = [token];
    for (let d = 0; d <= days; d++) {
      const ymd = offsetCalendarDay(nowMs, d);
      const yearMonthDay = `${ymd[0]}年${ymd[1]}月${ymd[2]}日`;
      if (out.indexOf(yearMonthDay) < 0) out.push(yearMonthDay, `${ymd[1]}月${ymd[2]}日`);
    }
    return out;
  }

  const DATE_TOKEN_TAILS_JA = [
    "までに",
    "まで",
    "中に",
    "に",
    "で",
    "の",
    "も",
    "は",
    "が",
    "や",
    "か",
    "だけ",
    "しか",
  ];

  /* 数の桁は字類で書く – 月は 1〜12 か月、日は最大 39 日まで受けてその方の暦で落ちる
   * （41 日以上の形はその方の語として解かない）。 */
  const 暦日と暦月の形Ja =
    /^(?:[0-9][0-9][0-9][0-9]年)?(?:(?:1[0-2]|[0-9])月(?:[0-3][0-9]日)?|[0-9][0-9][0-9][0-9]年)$/;
  /* 週の語を繋げた曜日・曜日の語（『来週金曜に』『土曜に』『金曜日の』）も同じ – その方の
   * 形は上の一覧が持つので、曜日の方だけ形で見抜く。 */
  const 曜日の形Ja =
    /^(?:今週|来週|再来週|先週|先々週)?(?:(?:1[0-2]|[0-9])月)?(?:月|火|水|木|金|土|日|平日|週末)曜?(?:日)?$/;

  const 同じ聞き方の助詞Ja = /(?:に|で|は|も|の|が|や)$/;

  /** 助詞を付きただけの暦日・暦月・年・曜日の語を、その方の語へ寄せる（無ければ空文字）。 */
  function 暦日の語に寄せるJa(token: string): string {
    const q = String(token || "");
    if (!同じ聞き方の助詞Ja.test(q)) return "";
    for (const 語尾 of ["に", "で", "は", "も", "の", "が", "や"]) {
      if (q.length <= 語尾.length + 1 || !q.endsWith(語尾)) continue;
      const 芯 = q.slice(0, -語尾.length);
      if (暦日と暦月の形Ja.test(芯) || 曜日の形Ja.test(芯)) return 芯;
    }
    return "";
  }

  /** 日付の語の表に載っている形か（助詞を剥がした後の検証に使う）。 */
  function isDateTableWordJa(word: string): boolean {
    const 数値の幅の形Ja = /^[0-9]{1,4}日以内$/;
    return (
      数値の相対日の形Ja.test(word) ||
      数値の幅の形Ja.test(word) ||
      暦日と暦月の形Ja.test(word) ||
      曜日の形Ja.test(word) ||
      word === "半年後" ||
      word === "半年前" ||
      RELATIVE_DAY_OFFSETS_JA[word] !== undefined ||
      RELATIVE_WEEK_OFFSETS_JA[word] !== undefined ||
      RELATIVE_MONTH_OFFSETS_JA[word] !== undefined ||
      RELATIVE_YEAR_OFFSETS_JA[word] !== undefined ||
      PERIOD_MONTH_WORDS_JA[word] !== undefined ||
      FISCAL_YEAR_OFFSETS_JA[word] !== undefined ||
      SEASON_MONTHS_JA[word] !== undefined ||
      MONTH_PART_TAIL_JA.test(word)
    );
  }

  /** 日付の語に助詞などが付きただけの形を、表にある形へ寄せる（無ければ空文字）。 */
  function dateTokenStemJa(token: string): string {
    const q = String(token || "");
    if (q.length < 3) return "";
    /* 数値で書く相対日の『前』の向き – 語の形だけ見る（換算はその方の規則が持つ）。 */

    const 数値の前の向きJa =
      /^(?:[0-9]{1,4}(?:日|か月|カ月|ヵ月|ヶ月|ケ月|箇月|年)|半年|半(?:月|か月|ヶ月|ケ月|カ月|ヵ月|箇月))前$/;
    for (const tail of DATE_TOKEN_TAILS_JA) {
      if (q.length <= tail.length + 1 || !q.endsWith(tail)) continue;
      const stem = q.slice(0, -tail.length);

      if (tail.indexOf("まで") === 0 && 数値の前の向きJa.test(stem)) continue;
      if (isDateTableWordJa(stem)) return stem;
    }
    return "";
  }

  const FROM_TODAY_HEAD =
    /^(?:今日から|(?:締切|締め切り|〆切|しめきり)までに?の?|(?:締切|締め切り|〆切|しめきり)から)\s*([0-9]{1,3})\s*(.+?)(?:以内)?$/;
  const FROM_TODAY_UNIT: Record<string, number> = {
    日: 1,
    日間: 1,
    週間: 7,
    しゅうかん: 7,
    週: 7,
    か月: 30,
    ヶ月: 30,
    カ月: 30,
  };

  function fromTodayTermsJa(token: string, nowMs: number): string[] | null {
    const matched = FROM_TODAY_HEAD.exec(
      String(token || "")
        .replace(/からに$/, "")
        .replace(/までに$/, ""),
    );
    if (!matched) return null;
    const per = FROM_TODAY_UNIT[matched[2]];
    if (per === undefined) return null;
    const days = Number(matched[1]) * per;
    if (!(days >= 1 && days <= 365)) return null;
    const out: string[] = [];
    for (let d = 0; d <= days; d += 1) {
      const ymd = offsetCalendarDay(nowMs, d);
      out.push(`${ymd[0]}年${ymd[1]}月${ymd[2]}日`, `${ymd[1]}月${ymd[2]}日`);
    }
    return out;
  }

  /** `今月以内` `来月以内` はその月の間のこと（`3月以内` は「3 か月以内」にも読めるので寄せない）。 */
  const RELATIVE_MONTH_WITHIN =
    /^(今月|来月|再来月|先月|翌月|前月|こんげつ|らいげつ|せんげつ)以内(?:に)?$/;

  /* 頭の語は暦の週の表（`RELATIVE_WEEK_OFFSETS_JA`）と同じ広さにする – その方で通る語が
   * 繋がれた形で只有無だと、その方の語を打った人だけ 0 行の壁に当たる（2026-10-24 実測 –
   * 実ビルドの品書 872 行・同刻: `先週金曜` 7 行・`今週金曜` 4 行・
   * `来週金曜` 19 行が通るのに `先々週金曜` **0 行**・`先々週月曜` **0 行**・`昨週金曜` **0 行**・
   * `先々週末` **0 行**（同じビルドで `先々週` 14 行・`昨週` 26 行・`先週末` 16 行は通る）。 */

  const PRESSED_WEEKDAY_JA =
    /^(今週|こんしゅう|来週|らいしゅう|再来週|さいしゅう|先週|せんしゅう|先々週|せんせんしゅう|前週|翌週|昨週|さくしゅう)(?:の)?(?:土日|週末|平日|([月火水木金土日])(?:曜)?(?:日)?|末)$/;
  const WEEKDAY_ORDER_JA = "月火水木金土日";

  function pressedWeekdayJa(token: string, nowMs: number): string[] | null {
    const matched = PRESSED_WEEKDAY_JA.exec(String(token || ""));
    if (!matched) return null;
    const days = weekDayTermsJa(matched[1], nowMs);
    if (days.length !== 7) return null;
    /* 「今週末に締まる物が欲しい」は研究計画で普通に言う（2026-09-30 実測・固定時刻
     * 2026-08-09T00:00:00Z・品書 872 行）: `週末` 268 行が通るのに `今週末` **0 行**・
     * `来週末` **0 行**・`先週末` **0 行**だった。裸の `週末`（上の 1,953 行の語群）は
     * 「土曜・日曜の締切全般」なので、週を名指した形をそこに寄せると**別週の週末まで出す**
     * （実測で `週末` 268 行には今週以外も含まれる）。なのでその週の暦日 2 日に解く –
     * 週は月〜日の塊（上の暦の決まり）で、土曜は 6 番目・日曜は 7 番目。*/
    if (matched[2] === undefined) {
      /* 「来週平日に間に合うか」「今週平… – 実測と理由は第 723 回に SPEC へ送つた。*/
      if (/平日$/.test(String(token || ""))) {
        const 平日五日 = [days[0], days[1], days[2], days[3], days[4]].map((語) =>
          String(語 || ""),
        );
        return 平日五日.every((語) => 語 !== "") ? 平日五日 : null;
      }
      const 土曜 = String(days[5] || "");
      const 日曜 = String(days[6] || "");
      return 土曜 && 日曜 ? [土曜, 日曜] : null;
    }
    const index = WEEKDAY_ORDER_JA.indexOf(matched[2]);
    if (index < 0) return null;
    const day = String(days[index] || "");

    return [day];
  }

  /* 月語に日を繋げた形（`来月10日… – 実測と理由は第 723 回に SPEC へ送つた。*/
  function pressedMonthDayJa(token: string, nowMs: number): string[] | null {
    const q = String(token || "").replace(/\s+/g, "");
    /* 表の語は長い物から当てる（`再来月` を `来月` で割らない – 語の順序に頼らない）。 */
    const 月語 = Object.keys(RELATIVE_MONTH_OFFSETS_JA)
      .sort((甲, 乙) => 乙.length - 甲.length)
      .find((語) => q.startsWith(語));
    if (!月語) return null;
    const 日 = /^([0-9]{1,2})日$/.exec(q.slice(月語.length));
    if (!日) return null;
    const 番号 = Number(日[1]);
    if (!(番号 >= 1 && 番号 <= 31)) return null;
    const 基準 = new Date(nowMs + 9 * 60 * 60 * 1000);
    const 連番 = 基準.getUTCMonth() + 1 + RELATIVE_MONTH_OFFSETS_JA[月語];
    const 年 = 基準.getUTCFullYear() + Math.floor((連番 - 1) / 12);
    const 月 = ((((連番 - 1) % 12) + 12) % 12) + 1;
    const 末日 = new Date(Date.UTC(年, 月, 0)).getUTCDate();
    if (番号 > 末日) return null;
    return [`${年}年${月}月${番号}日`];
  }

  function isPastJstDay(ymd: number[], nowMs: number): boolean {
    const today = offsetCalendarDay(nowMs, 0);
    return (
      ymd[0] < today[0] ||
      (ymd[0] === today[0] && (ymd[1] < today[1] || (ymd[1] === today[1] && ymd[2] < today[2])))
    );
  }

  /** 展開語の並びから最後の `YYYY年M月D日` を読む（幅の案内に使う）。 */
  function lastFullDateJa(terms: string[]): number[] | null {
    for (let i = terms.length - 1; i >= 0; i -= 1) {
      const parts = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(String(terms[i] || ""));
      if (parts) return [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    }
    return null;
  }

  /** 今日から指定した暦日までの幅を、件数欄の形で書く。 */
  function spanNoteFromTodayJa(token: string, nowMs: number, lastYmd: number[]): string {
    const first = offsetCalendarDay(nowMs, 0);
    const head = `${first[0]}年${first[1]}月${first[2]}日`;
    const headDay = weekdayJaFromDate(toIsoDate(head));
    /* 期日が既に過ぎている幅は逆向きになるので、その日 1 日として書き、過ぎていることを言う
     * （`今週金曜までに` を日曜に打つと金曜は過ぎている – 第 329 回）。 */
    if (isPastJstDay(lastYmd, nowMs)) {
      const 日付 = `${lastYmd[0]}年${lastYmd[1]}月${lastYmd[2]}日`;
      return `${token} = ${日付}${
        weekdayJaFromDate(toIsoDate(日付)) ? `(${weekdayJaFromDate(toIsoDate(日付))})` : ""
      }の締切（その日は過ぎています – 「過去の締切も表示」を付けると並びます）`;
    }
    /* 一日ぶんだけの幅（`今日まで`）に「〜同じ日」を書いても役に立たない。 */
    if (first[0] === lastYmd[0] && first[1] === lastYmd[1] && first[2] === lastYmd[2]) {
      return `${token} = ${head}${headDay ? `(${headDay})` : ""}の締切 – 行に書かれた他の日付（別の締切ラウンド・会期）でも当たるので、締切日からの日数で絞る「締切まで」の欄が確かです`;
    }
    const tail =
      first[0] === lastYmd[0]
        ? `${lastYmd[1]}月${lastYmd[2]}日`
        : `${lastYmd[0]}年${lastYmd[1]}月${lastYmd[2]}日`;
    const lastDay = weekdayJaFromDate(toIsoDate(`${lastYmd[0]}年${lastYmd[1]}月${lastYmd[2]}日`));
    return `${token} = ${head}${headDay ? `(${headDay})` : ""}〜${tail}${
      lastDay ? `(${lastDay})` : ""
    }の締切 – 行に書かれた他の日付（別の締切ラウンド・会期）でも当たるので、締切日からの日数で絞る「締切まで」の欄が確かです`;
  }

  /* 第 432 回 – 仮名の『ごろ』が尾の列挙に無く、`8月15日ごろ` `3日ごろ` が 0 行で
   * 案内も無しだった（同じ音の「頃」「ころ」は通る – 月の仮名と同じ片落ち級）。*/
  const 頃の尾Ja = /^(.+?)(?:頃|ころ|ごろ|辺り|あたり|位|ぐらい|くらい|前後)$/;
  const 和暦の日Ja =
    /^(?:令和|平成|昭和|大正|明治)(?:元年|[0-9]{1,2}年)(?:[0-9]{1,2}月)?(?:[0-9]{1,2}日)?$/;

  const 週の曜日Ja =
    /^(?:今週|こんしゅう|来週|らいしゅう|再来週|先週|先々週)[月火水木金土日](?:曜(?:日)?)?$/;

  /** その方の語を続けた形を、それ自身の暦日の語へ解く（解けなければ null）。 */
  function 位の付いた日を暦日に解くJa(token: string, nowMs: number): string[] | null {
    const 柄 = searchNormalize(String(token || ""));
    const hit = 頃の尾Ja.exec(柄);
    if (!hit) return null;
    const 頭 = hit[1] as string;

    const 裸日 = /^([0-9]{1,2})日(?:頃|ころ|ごろ|辺り|あたり)$/.exec(柄);
    if (裸日 && Number(裸日[1]) >= 1 && Number(裸日[1]) <= 31) {
      const 並び: string[] = [];
      for (let 月 = 1; 月 <= 12; 月 += 1) 並び.push(`${月}月${裸日[1]}日`);
      return 並び;
    }
    /* その日が決まらない語は寄せない（`8月頃` をその月へ寄せない – それ自体の語で打つ）。 */
    const 其の日が決まる =
      暦日に解くJa(頭) !== null ||
      和暦の日Ja.test(頭) ||
      typeof RELATIVE_DAY_OFFSETS_JA[頭] === "number" ||
      日の数の後Ja.test(頭) ||
      日の数の前Ja.test(頭) ||
      週の曜日Ja.test(頭) ||
      pressedMonthDayJa(頭, nowMs) !== null;
    if (!其の日が決まる) return null;
    const 暦 = 幅の片側を暦日に解くJa(頭, nowMs, "頭");
    if (!暦) return null;

    const 基準日時 = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3600 * 1000);
    const 基準日 =
      基準日時.getUTCFullYear() * 10000 +
      (基準日時.getUTCMonth() + 1) * 100 +
      基準日時.getUTCDate();
    let 継ぐ年 = 暦[0] >= 0 ? 暦[0] : 基準日時.getUTCFullYear();
    if (暦[0] < 0 && 継ぐ年 * 10000 + 暦[1] * 100 + 暦[2] < 基準日) 継ぐ年 += 1;
    return [`${継ぐ年}年${暦[1]}月${暦[2]}日`];
  }

  /** `明日まで` `来週までに` の形 – 期日までと聞く人なので、今日からその日までを出す
   * （行は締切日を 1 つ持つので OR の並びで受ける – `withinDaysTermsJa` と同じ組み立て）。 */
  function untilDayTermsJa(token: string, nowMs: number): string[] | null {
    const q = String(token || "");
    if (!/(?:までに|まで)$/.test(q)) return null;
    const stem = dateTokenStemJa(q);
    const head = /^(.+?)(?:までに|まで)$/.exec(q);
    const pressed = head
      ? pressedWeekdayJa(head[1], nowMs) || pressedMonthDayJa(head[1], nowMs)
      : null;

    const 暦 = head ? 暦日に解くJa(head[1]) : null;

    const 数値 = 暦 || /前$/.test(stem) ? null : numericRelativeDay(stem, nowMs);
    /* 月語に日を繋げた形（`来月10日までに`）もその年の形だけで出す幅にする。 */
    const pressedMonthDay = head ? pressedMonthDayJa(head[1], nowMs) : null;

    const 位の解 = head ? 位の付いた日を暦日に解くJa(head[1], nowMs) : null;
    /* 週+曜日を繋げた形（`今週金曜まで`）は表に無い語なので、剥がした形が無くても続ける
     * 。 */
    if (!stem && !pressed && !暦 && !位の解) return null;
    const dayOffset = RELATIVE_DAY_OFFSETS_JA[stem];
    let last: number[] | null = null;
    /* 「今月下旬までに」は下旬の末日までの幅。 */
    const part = monthPartRangeJa(stem || q, nowMs);
    if (part) last = [part.year, part.month, part.to];
    if (dayOffset !== undefined) {
      last = offsetCalendarDay(nowMs, dayOffset >= 0 ? dayOffset : 0);
    } else if (暦) {
      /* 年を名乗らない形はその年 – その日が今年もう過ぎてるなら来年に繰り上げる
       * （その方の日だけで探す形と同じ繰り上げ – 第 391 回）。 */
      const 基準年 = new Date(nowMs + 9 * 60 * 60 * 1000).getUTCFullYear();
      const 候補 = [暦[0] >= 0 ? 暦[0] : 基準年, 暦[1], 暦[2]];
      if (暦[0] < 0 && isPastJstDay(候補, nowMs)) {
        const 翌年 = [候補[0] + 1, 暦[1], 暦[2]];
        if (!isPastJstDay(翌年, nowMs)) 候補[0] = 翌年[0];
      }
      last = 候補;
    } else if (pressed && pressedMonthDayJa(head ? head[1] : "", nowMs)) {
      /* 月語に日を繋げた形（`来月10日までに`）もその方の日を末尾に受ける。 */
      const 刻 = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(pressed[0]);
      if (刻) last = [Number(刻[1]), Number(刻[2]), Number(刻[3])];
    } else if (位の解) {
      /* 位を剥がしたその日を末尾に受ける（その日を過ぎる方向には広げない）。 */
      const 刻 = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(位の解[0]);
      if (刻) last = [Number(刻[1]), Number(刻[2]), Number(刻[3])];
    } else if (数値) {
      /* 数値の相対日はその方の規則が暦日を出す（その 2 語目が `YYYY年M月D日` の形）。 */
      const 刻 = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(数値[1]);
      if (!刻) return null;
      last = [Number(刻[1]), Number(刻[2]), Number(刻[3])];
    } else {
      const week = weekDayTermsJa(stem, nowMs);
      if (week.length === 7) {
        const parts = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(week[6]);
        if (parts) last = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
      } else if (pressed) {
        const parts = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(pressed[0]);
        if (parts) last = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
      }
    }
    if (!last) return null;
    /* 期日が既に過ぎているときに今日からの幅を作ると、過ぎた方を無視した幅になる
     * 。その日 1 日だけを出す – 過ぎた締切の扱いは下の案内で言う。 */

    const 年付きのみ = 暦 !== null || 数値 !== null || pressedMonthDay !== null || 位の解 !== null;
    if (isPastJstDay(last, nowMs)) {
      const 語 = `${last[0]}年${last[1]}月${last[2]}日`;
      return 年付きのみ ? [語] : [語, `${last[1]}月${last[2]}日`];
    }
    const out: string[] = [];
    let 届いた = false;
    for (let d = 0; d <= 370; d += 1) {
      const ymd = offsetCalendarDay(nowMs, d);
      out.push(`${ymd[0]}年${ymd[1]}月${ymd[2]}日`);
      if (!年付きのみ) out.push(`${ymd[1]}月${ymd[2]}日`);
      if (ymd[0] === last[0] && ymd[1] === last[1] && ymd[2] === last[2]) {
        届いた = true;
        break;
      }
    }

    return 届いた ? out : null;
  }

  /** 相対日・相対日の語を、暦日の候補グループへ展開する（OR の組）。 */

  /* 時間の単位で打たれた形。 */
  /* 「半日」「3時間」に加えて **… – 実測と理由は第 723 回に SPEC へ送つた。*/
  const HOUR_RANGE_JA =
    /^(?:半日|半時間|(?:[0-9]{1,4}|[一二三四五六七八九十]{1,3})\s*(?:時間|分))(?:間)?以内$/;

  /** 時間の幅を日数に切り上げる（半日・1 日未満は 1 日 – それ以下に絞れない）。 */
  function 時間数から日数Ja(word: string): number {
    if (/^半日|^半時間/.test(word)) return 1;

    if (/^(?:[0-9]{1,4}|[一二三四五六七八九十]{1,3})\s*分/.test(word)) return 1;
    const 時 = Number(word.replace(/[^0-9]/g, ""));
    return Math.min(3650, Math.max(1, Math.ceil(時 / 24)));
  }

  const HALF_YEAR_JA = /^半年(?:以内|間)?$/;
  const HALF_YEAR_DAYS_JA = 180;

  function relativeDayGroups(token: string, nowMs: number): string[] | null {
    /* 「明日まで」「来週までに」は期日なので、今日からその日まで。 */
    const until = untilDayTermsJa(token, nowMs);
    if (until) return [token].concat(until);
    /* 「今日から 3 日」は `3日以内` と同じ幅。 */
    const fromToday = fromTodayTermsJa(token, nowMs);
    if (fromToday) return [token].concat(fromToday);
    /* `令和8年` `令和8年度` `2026年度` は西暦の暦語に解ける。 */
    const 和暦 = eraYearTermsJa(token);
    if (和暦) return [token].concat(和暦.terms);
    /* 「8月10日頃」「明日あたり」はその日自体を訪ねる打ち方。 */
    const 位 = 位の付いた日を暦日に解くJa(token, nowMs);
    if (位) return [token].concat(位);
    /* 「今週金曜」「来週木曜日」は締切日がその日の行に出会う。 */
    const pressedDay = pressedWeekdayJa(token, nowMs) || pressedMonthDayJa(token, nowMs);
    if (pressedDay) return [token].concat(pressedDay);
    /* 「今年度」「来年度中」は年度（4 月〜翌年 3 月）の月語に展開する。 */
    const fiscal = fiscalYearTermsJa(token, nowMs);
    if (fiscal) return [token].concat(fiscal);
    /* 「8月下旬」「来月上旬」は月の三日ごとの区切り。 */
    const monthPart = monthPartTermsJa(token, nowMs);
    if (monthPart) return [token].concat(monthPart);
    /* 「20時」「午後8時59分」は収録の 24 時間表記 `HH:MM` に寄せる。 */
    const clock = clockTimeTermsJa(token);
    if (clock) return [token].concat(clock.terms);
    /* 「半年（以内）」は `6か月以内` と同じ幅。 */
    const halfYear = HALF_YEAR_JA.test(String(token || ""));
    if (halfYear) {
      const terms = withinDaysTermsJa(`${HALF_YEAR_DAYS_JA}日以内`, nowMs);
      if (terms) return terms;
    }
    /* 助詞が付きただけの形は表の形に寄せる（`明日中に` → `明日中` – 第 328 回）。 */
    const stem = dateTokenStemJa(token) || token;
    const numeric = numericRelativeDay(stem, nowMs);
    if (numeric) return numeric;
    const within = withinDaysTermsJa(stem, nowMs);
    if (within) return within;
    const dayOffset = RELATIVE_DAY_OFFSETS_JA[stem];
    if (dayOffset !== undefined) {
      const ymd = offsetCalendarDay(nowMs, dayOffset);
      return [token, `${ymd[0]}年${ymd[1]}月${ymd[2]}日`, `${ymd[1]}月${ymd[2]}日`];
    }
    const week = weekDayTermsJa(stem, nowMs);
    if (week.length) return [token].concat(week);
    return null;
  }

  /* 土地名での検索。出張先は「国内であってほしい」「四国であってほしい」という条件で
   * 絞ることが多く、`おきなわ` や `しこく` でも引ける価値がある。読み辞書は
   * 47 都道府県と地方に限定する（一般語の読み辞書は誤爆が高く作らない）。
   * 展開は OR で候補を増やすだけなので、誤りが既存のヒットを消すことはない。 */
  const PLACE_READINGS: string[][] = [
    ["北海道", "ほっかいどう"],
    ["青森", "あおもり"],
    ["岩手", "いわて"],
    ["宮城", "みやぎ"],
    ["秋田", "あきた"],
    ["山形", "やまがた"],
    ["福島", "ふくしま"],
    ["茨城", "いばらき"],
    ["栃木", "とちぎ"],
    ["群馬", "ぐんま"],
    ["埼玉", "さいたま"],
    ["千葉", "ちば"],
    ["東京", "とうきょう"],
    ["神奈川", "かながわ"],
    ["新潟", "にいがた"],
    ["富山", "とやま"],
    ["石川", "いしかわ"],
    ["福井", "ふくい"],
    ["山梨", "やまなし"],
    ["長野", "ながの"],
    ["岐阜", "ぎふ"],
    ["静岡", "しずおか"],
    ["愛知", "あいち"],
    ["三重", "みえ"],
    ["滋賀", "しが"],
    ["京都", "きょうと"],
    ["大阪", "おおさか"],
    ["兵庫", "ひょうご"],
    ["奈良", "なら"],
    ["和歌山", "わかやま"],
    ["鳥取", "とっとり"],
    ["島根", "しまね"],
    ["岡山", "おかやま"],
    ["広島", "ひろしま"],
    ["山口", "やまぐち"],
    ["徳島", "とくしま"],
    ["香川", "かがわ"],
    ["愛媛", "えひめ"],
    ["高知", "こうち"],
    ["福岡", "ふくおか"],
    ["佐賀", "さが"],
    ["長崎", "ながさき"],
    ["熊本", "くまもと"],
    ["大分", "おおいた"],
    ["宮崎", "みやざき"],
    ["鹿児島", "かごしま"],
    ["沖縄", "おきなわ"],
  ];
  /* 地方名は構成する都道府県への OR に展開する。「中国」は国名と衝突するため、
   * かな表記 `ちゅうごくちほう` に限る（地方で絞りたい利用者はそう打つ）。 */
  /* 種別の日本語表記。サイトのドロワー・一覧、`upcoming.md`、検索のどれからも
   * 同じ語で引けるように、表記はここに一本化する（表示語で検索できないのが
   * 2026-09-22 に実測で出た: 「論文締切」「概要締切」が 0 件だった）。 */
  const KIND_LABEL_JA: Record<string, string> = {
    abstract: "概要締切",
    paper: "論文締切",
    supplementary: "補足資料締切",
    notification: "採否通知",
    camera_ready: "カメラレディ締切",
    rebuttal_start: "反論期間開始",
    rebuttal_end: "反論期間終了",
    review_release: "査読結果公開",
    registration: "登録締切",
    journal: "常時受付",
    other: "締切",
  };

  function kindLabelJa(kind: unknown): string {
    const key = String(kind ?? "");
    if (key === "venue") return "投稿先（締切未確認）";
    return KIND_LABEL_JA[key] || key;
  }

  function kindKeyJa(label: unknown): string {
    const 名 = String(label ?? "").trim();
    if (名 === "") return "";
    const 其の儘 = KIND_LABEL_JA[名];
    if (其の儘) return 名;
    const 見つかった = Object.keys(KIND_LABEL_JA).find((k) => KIND_LABEL_JA[k] === 名);
    return 見つかった ?? "";
  }

  function kindDateFieldJa(kind: unknown): string {
    // 検査がビルド成果からこの関数だけを抜き出して動かすので、表は関数の中に置く
    // （外の変数にすると、抜き出した先で見えなくなる – 第 298 回に実際に踏んだ）。
    const table: Record<string, string> = {
      notification: "通知日",
      review_release: "公開日",
      rebuttal_start: "開始日",
    };
    return table[String(kind ?? "")] || "締切";
  }

  /* 海外の開催地は画面に `Seat… – 実測と理由は第 723 回に SPEC へ送つた。*/

  const TOPIC_ABBREVIATIONS_EN: string[][] = [
    ["ml", "machine learning"],
    ["cv", "computer vision"],
    ["nlp", "natural language processing"],
    ["dl", "deep learning"],
    ["qc", "quantum computing"],
    ["kg", "knowledge graph"],
    ["iot", "internet of things"],
    ["llm", "large language model"],
  ];

  const REGION_READINGS: string[][] = [
    ["東北", "とうほく", "青森,岩手,宮城,秋田,山形,福島"],
    ["関東", "かんとう", "茨城,栃木,群馬,埼玉,千葉,東京,神奈川"],
    ["中部", "ちゅうぶ", "新潟,富山,石川,福井,山梨,長野,岐阜,静岡,愛知,三重"],
    ["北陸", "ほくりく", "新潟,富山,石川,福井"],
    ["関西", "かんさい", "滋賀,京都,大阪,兵庫,奈良,和歌山"],
    ["近畿", "きんき", "滋賀,京都,大阪,兵庫,奈良,和歌山"],
    ["中国地方", "ちゅうごくちほう", "鳥取,島根,岡山,広島,山口"],
    ["四国", "しこく", "徳島,香川,愛媛,高知"],
    // 沖縄は総務省の区分では「九州・沖縄地方」。`沖縄` 単独でも引けるので、
    // ここに入れることで `九州` の当たり方が狭まることはない。
    ["九州", "きゅうしゅう", "福岡,佐賀,長崎,熊本,大分,宮崎,鹿児島,沖縄"],
    /* 「中国」は国名としても地方名としても打たれる語。国名の行には当たるが地方の行には
     * 当たらない状態は、調べ方を狭めてしまう（2026-09-23 実測: `中国` は国名の 233 行だけ
     * で、中国地方の 3 行は `中国地方` と打たないと出なかった）。ここでは**足す方向**に
     * 広げ、どちらを探しているかを件数欄に書く（`REGION_ALSO_JA`）。
     * 地方だけの人が損をしないように、`中国地方` は今までどおり地方だけを出す。 */
    ["中国", "ちゅうごく", "鳥取,島根,岡山,広島,山口"],
    /* 日常語で打つ人のための呼び方（総務省の地方区分そのものではない語）。
     * 構成員は収録の開催地に現れる都道府県だけにする（`地域まとめの構成員は、
     * 収録カタログの開催地に現れる` の検査が同じ規則を見る）。2026-09-23 時点で
     * 首都圏は神奈川・埼玉・千葉の収録が無く、東海は三重・静岡の収録が無いので、
     * それらが入るまでは見える構成員だけを書く（収録された日に検査が足す案内になる）。
     * `甲信越`・`信越`・`南関東` は構成県がすべて 0 行なので置いていない。 */
    ["首都圏", "しゅとうけん", "東京"],
    ["東海", "とうかい", "愛知,岐阜"],
    ["東海地方", "とうかいちほう", "愛知,岐阜"],
  ];

  /* 国名と地方名の両方で打たれる語（`中国` だけ）。広げた先を誤解させないための
   * 説明ラベルをここで持つ。 */
  const REGION_ALSO_JA: Record<string, string> = {
    中国: "国名と中国地方の両方",
  };

  /* 地方で引いたときに、**開催市だけ**が書かれた行を落とさないための表。
   * 国内の国際会議の開催地は上流どおりの英字表記（`Tokyo, Japan`）で、都道府県が
   * 書かれないことが多い。地方名を都道府県に展開するだけでは取りこぼすため
   * （実測で `東京` は 28 件当たるのに `関東` は 1 件だった）、各都道府県の都市表記も
   * 同じ組に入れる。ここに挙げる都市は収録カタログに実際のつづりで現れるものだけ。
   * 日本語の表記（`横浜` など）は `PLACE_QUERY_ALIASES_JA` から引くので書かない。 */
  const PREFECTURE_CITIES_JA: string[][] = [
    ["東京", "tokyo"],
    ["神奈川", "yokohama"],
    ["茨城", "tsukuba"],
    ["京都", "kyoto"],
    ["大阪", "osaka"],
    ["兵庫", "kobe"],
    ["奈良", "nara"],
    ["愛知", "nagoya"],
    ["岐阜", "gifu"],
    ["福井", "fukui"],
    ["石川", "kanazawa"],
    ["福岡", "fukuoka"],
    ["長崎", "nagasaki"],
    ["沖縄", "okinawa,miyakojima"],
  ];

  const CITIES_BY_PREFECTURE: Record<string, string[]> = {};
  PREFECTURE_CITIES_JA.forEach(([prefecture, cities]) => {
    CITIES_BY_PREFECTURE[prefecture] = String(cities).split(",");
  });

  /* 表の見出し語（地方名・地域名）を展開した語の組。検索語の展開と件数欄の
   * 「こう探しました」で**同じ語列表**を使う（片方だけ直して説明が嘘になるのを防ぐ）。
   * 地方には都道府県と、その県の都市の表記まで入れる。 */
  function regionEntryMembers(entry: string[]): string[] {
    if (!entry[2]) return [entry[0]];
    const out = String(entry[2]).split(",");
    if (REGION_READINGS.indexOf(entry) < 0) return out;
    out.slice().forEach((member) => {
      (CITIES_BY_PREFECTURE[member] || []).forEach((city) => {
        cityQueryForms(city).forEach((form) => {
          if (out.indexOf(form) < 0) out.push(form);
        });
      });
    });
    return out;
  }

  /* 都市の英文字つづりから、画面・検索の両方で使う表記の組を作る。
   * 日本語側は `PLACE_QUERY_ALIASES_JA` の国名・都市名の表を引く（書き写さない）。 */
  function cityQueryForms(latinCity: string): string[] {
    const out = [latinCity];
    PLACE_QUERY_ALIASES_JA.forEach((entry) => {
      if (String(entry[1]).toLowerCase() === latinCity && out.indexOf(entry[0]) < 0)
        out.push(entry[0]);
    });
    return out;
  }

  /* 開催地の**地域まとめ**で引け… – 実測と理由は第 723 回に SPEC へ送つた。*/
  const EUROPE_JA =
    "イタリア,ドイツ,スペイン,フランス,イギリス,オーストリア,デンマーク,オランダ,ポルトガル,ギリシャ,アイルランド,ベルギー,スウェーデン,キプロス,フィンランド,スイス,チェコ,ハンガリー,ポーランド,リトアニア,ノルウェー,クロアチア,ルクセンブルク,アイスランド,ルーマニア,スロベニア,エストニア,ブルガリア,ロシア";
  const ASIA_JA =
    "中国,韓国,シンガポール,インド,ベトナム,台湾,マレーシア,タイ,インドネシア,カンボジア,香港";
  const US_STATES_JA =
    "カリフォルニア州,コロラド州,ハワイ州,ペンシルベニア州,ルイジアナ州,テネシー州,インディアナ州,オレゴン州";
  const US_JA = `アメリカ,${US_STATES_JA}`;
  /* メキシコは北米の国として「北米」側の membership にも入れる（3 分けた北米の慣行）。
   * メキシコだけを引く人は「メキシコ」と打つので、地域で引いたときに黙って落ちるほうが
   * 困る（実測）。行には
   * `Ciudad de México, メキシコ` のように国が出るので、当たった行で見分けられる。 */
  const NORTH_AMERICA_JA = `アメリカ,メキシコ,カナダ,${US_STATES_JA}`;
  /* 中南米を分けて打つ人のほうが多い（2026-09-23 実測: 「中南米」は 95 行当たるのに
   * 「南米」「中米」は 0 行。南米の会議を見ようとする人は「南米」と書く）。
   * 構成員は収録の開催地に現れる国だけにする（`地域まとめの構成員は、収録カタログの
   * 開催地に現れる` の検査が同じ規則を見ている。今日は ブラジル 42 行・メキシコ 29 行・
   * チリ 8 行・コスタリカ 6 行・パナマ 4 行・コロンビア 4 行・アルゼンチン 2 行で、
   * ペルー・ウルグアイ・グアテマラ等は収録に無いので足さない。収録された日に
   * 検査が「足す案内」になる）。 */
  const SOUTH_AMERICA_JA = "ブラジル,アルゼンチン,チリ,コロンビア";
  const CENTRAL_AMERICA_JA = "メキシコ,コスタリカ,パナマ";
  const OCEANIA_JA = "オーストラリア,ニュージーランド";
  const MIDDLE_EAST_JA = "イスラエル,アラブ首長国連邦,トルコ";
  const AFRICA_JA = "モロッコ,南アフリカ,ルワンダ,ガーナ,ナイジェリア";

  const OVERSEAS_JA = `${EUROPE_JA},${ASIA_JA},${NORTH_AMERICA_JA},${CENTRAL_AMERICA_JA},${SOUTH_AMERICA_JA},${MIDDLE_EAST_JA},${AFRICA_JA},${OCEANIA_JA}`;
  const CONTINENT_READINGS: string[][] = [
    ["ヨーロッパ", "よーろっぱ", EUROPE_JA],
    ["欧州", "こうしゅう", EUROPE_JA],
    ["ヨーロッパ圏", "よーろっぱけん", EUROPE_JA],
    ["アジア", "あじあ", ASIA_JA],
    ["北米", "ほくべい", NORTH_AMERICA_JA],
    ["北アメリカ", "きたアメリカ", NORTH_AMERICA_JA],
    ["中南米", "ちゅうなんべい", `${CENTRAL_AMERICA_JA},${SOUTH_AMERICA_JA}`],
    ["南米", "なんべい", SOUTH_AMERICA_JA],
    ["中米", "ちゅうべい", CENTRAL_AMERICA_JA],
    ["中東", "ちゅうとう", MIDDLE_EAST_JA],
    /* 「中近東」で打つ人がいる（実測: `中東` 5 行 / `中近東` **0 行**）。近東まで含む読み方も
     * あるが、この表が持つ国名の集まりは中東と同じ物を使う – 件数欄が『中近東』という打ち方
     * そのままで「地域まとめ（… か国）で探しています」と書くので、寄せ先は画面に見える。 */
    ["中近東", "ちゅうきんとう", MIDDLE_EAST_JA],
    ["アフリカ", "アフリカ".toLowerCase(), AFRICA_JA],
    ["オセアニア", "おせあにあ", OCEANIA_JA],
    ["アメリカ", "アメリカ".toLowerCase(), US_JA],
    // 「米国」と打った人にも州表記の行を同じにして出す（実測で `米国` だけ 135 行少なかった）。
    ["米国", "べいこく", US_JA],
    // 欧米は「欧州＋北米」と読む（豪州は入れない。日本語でのふつうの使い方に合わせる）。
    ["欧米", "おうべい", `${NORTH_AMERICA_JA},${EUROPE_JA}`],
    // 「海外」は画面のてびき（『海外の開催都市』）が使う語なので、引けるようにしておく。
    ["海外", "かいがい", OVERSEAS_JA],
    ["国外", "こくがい", OVERSEAS_JA],
    ["海外開催", "かいがいかいこう", OVERSEAS_JA],

    ["国外開催", "こくさいかいこう", OVERSEAS_JA],
  ];

  const OVERSEAS_HEADS_JA = ["海外", "国外", "海外開催", "国外開催"];

  const OVERSEAS_COVERAGE_NOTE_TAIL_JA =
    "で出すのは開催地の国名が日本語で書かれた行です – 開催地が空欄の行と、国名が略された行は出ません。「国内研究会・国内シンポジウム」は含みません";

  /* 会議の略称と年は、表では `NSDI 2027` のように別々の語に割れて書かれる。
   * ところが打たれるのは `nsdi27`（年を 4 桁で打つ人も `nsdi2027`）のような 1 語の形で、
   * そのままでは 1 件も当たらなかった（実測: `ICDE2027` 0 件 / `ICDE 2027` 6 件、
   * `nsdi27` 0 件 / `NSDI 2027` 6 件）。略称と年を、それぞれ別の組として要求する。
   * 語尾の数字は 2 桁（直近の年を略して書く流儀）と 4 桁の両方を受け、両方の表記を
   * 年の組に入れる（hay は `2027` と書くので `27` だけの照合では当たらない）。 */
  /* 日付を**数字だけ**の表記で打つ人に合わせる。表の行には暦日の日本語形
   * （`2026年8月22日` と `8月22日`、月は `2026年8月` と `8月`）が入っているので、
   * `2026-12-25` `2026/12/25` `12/25` `12-25` `12.25` `2026-12` を同じ組に入れる。
   * 年を打った人はその年限定と見る（年なしの暦日は足さない）。
   * 変更前はこれらがすべて 0 件だった（2026-09-23 実測）。
   * 月・日の範囲外（`13/45` など）は日付として扱わない。会議名や号数の数字の取り合わせを
   * 別物に解釈して当たり方を狭めるより、そのままの部分一致に残すほうがましだから。 */
  const DATE_WITH_YEAR_TOKEN = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;
  const DATE_MONTH_DAY_TOKEN = /^(\d{1,2})[-/.](\d{1,2})$/;
  const DATE_YEAR_MONTH_TOKEN = /^(\d{4})[-/.](\d{1,2})$/;

  const 和暦の暦日 = /^(?:(\d{4})年)?(\d{1,2})月(?:(\d{1,2})日)?$/;

  function calendarDateGroups(token: string): string[] | null {
    if (!/^\d/.test(token)) return null;
    const withYear = DATE_WITH_YEAR_TOKEN.exec(token);
    if (withYear) {
      const year = Number(withYear[1]);
      const month = Number(withYear[2]);
      const day = Number(withYear[3]);
      if (!isCalendarMonthDay(month, day)) return null;
      // 年まで打っているのに `8月22日`（年なし）も足すと、別年の同じ暦日が混ざって
      // 精密さを失う（実測で 14 件中 4 件が別年だった）。年の付いた形だけにする。
      return [`${year}年${month}月${day}日`];
    }
    const monthDay = DATE_MONTH_DAY_TOKEN.exec(token);
    if (monthDay) {
      const month = Number(monthDay[1]);
      const day = Number(monthDay[2]);
      if (!isCalendarMonthDay(month, day)) return null;
      return [`${month}月${day}日`];
    }
    const yearMonth = DATE_YEAR_MONTH_TOKEN.exec(token);
    if (yearMonth) {
      const year = Number(yearMonth[1]);
      const month = Number(yearMonth[2]);
      if (month < 1 || month > 12) return null;
      return [`${year}年${month}月`];
    }
    const 和暦 = 和暦の暦日.exec(token);
    if (和暦) {
      const 年 = 和暦[1] === undefined ? 0 : Number(和暦[1]);
      const 月 = Number(和暦[2]);
      const 日 = 和暦[3] === undefined ? 0 : Number(和暦[3]);
      if (月 < 1 || 月 > 12) return null;
      /* 日のある日はその方の暦日がある場合だけ（`2月30日` は暦日に在らない – 実測 3 行は
       * 表の文字列がその方の日を書いている行で、それを寄せる先は無い）。 */
      if (日 && !isCalendarMonthDay(月, 日)) return null;
      if (日) return [年 ? `${年}年${月}月${日}日` : `${月}月${日}日`];

      return 年 ? [`${年}年${月}月`] : null;
    }
    return null;
  }

  function isCalendarMonthDay(month: number, day: number): boolean {
    return month >= 1 && month <= 12 && day >= 1 && day <= 31;
  }

  const ABBREV_YEAR_TOKEN = /^([a-z]{2,})(\d{2}|\d{4})$/;

  function abbrevYearGroups(token: string): string[][] | null {
    const parts = ABBREV_YEAR_TOKEN.exec(token);
    if (!parts) return null;
    const head = parts[1];
    const digits = parts[2];
    // 1 文字の略称（`r0` など）は割らない。短い語の取り合わせで何でも当たるため。
    if (head.length < 2) return null;
    const years = digits.length === 2 ? [digits, `20${digits}`] : [digits, digits.slice(2)];
    /* 両方の組に打ち込まれた形そのものも入れておく。`SC26` のように語が割れていない
     * 表記の行は、今までどおり当たる（割った条件だけを要求して落とさない）。 */
    return [[token, head], [token].concat(years)];
  }

  /** 検索語を、かなで引いたときも含めた候補グループへ展開する（語ごとに OR の組）。 */
  /* 月語の展開で扱う年幅。収録は 2019 年ごろまで遡り、次回会期は 2030 年台半ばまで
   * 置くものがあるので、その前後を見込みでかぶせる（外れた年の行には和暦語を
   * 持たないので、単に当たらないだけ）。 */
  const MONTH_QUERY_YEAR_FROM = 2018;
  const MONTH_QUERY_YEAR_TO = 2032;

  /* 検索語その物が URL / ホスト名になるとき、そのまま語に分解するとパスの語（index・fac）や
   * `https` まで AND 条件に入って必ず 0 件になる（2026-09-23 実測）。ホストの成分だけに直して
   * から分解する（照合側の検索語にも同じホストの成分を入れている – `linkSearchTerms`）。 */
  function urlLikeQueryTerms(query: unknown): string | null {
    const text = typeof query === "string" ? query.trim() : "";
    if (!text || /\s/.test(text)) return null;
    const isUrl = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+$/i.test(text);
    // スキーム無しで運ばれてくることも多い（チャットやメーリングリストからのコピー）。
    const isHost = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.:][a-z0-9-]+)*(:\d+)?(\/\S*)?$/i.test(text)
      ? /\.[a-z]{2,}/i.test(text)
      : false;
    if (!isUrl && !isHost) return null;
    const labels = hostLabels(hostFromUrl(text));
    return labels.length ? labels.join(" ") : null;
  }

  function looksLikeUrlQuery(query: unknown): boolean {
    return urlLikeQueryTerms(query) !== null;
  }

  const CATEGORY_CHIP_HEADS_JA = Object.keys(CATEGORY_LABELS_JA)
    .map((key: string) => CATEGORY_LABELS_JA[key])
    .filter((label: string) => Boolean(label))
    .filter((label: string, i: number, all: string[]) => all.indexOf(label) === i)
    .sort((a: string, b: string) => b.length - a.length)
    .map((label: string) => label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  /* 括弧の中が英文字（分野の英表記）のときだけ落とす。日本語を含む括弧
   * （`人工知能（チュートリアル）`）は意図した絞り込みなので落とさない。閉じ括弧が
   * 無い形（コピー途中で切れた形）も受け取る。 */
  const CATEGORY_CHIP_TAIL = new RegExp(
    `(${CATEGORY_CHIP_HEADS_JA.join("|")})\\s*[（(][A-Za-z0-9 .,&/+\\-]*[A-Za-z][A-Za-z0-9 .,&/+\\-]*[)）]?`,
    "gu",
  );

  function collapseFieldPhraseEnglish(query: unknown): {
    query: unknown;
    /* 寄せ先の和名と、その語の組に載せるべき英語の綴り */
    寄せた: Array<[string, string[]]>;
  } {
    const aliases: Array<[string[], string]> = [
      [["information", "security"], "情報セキュリティ"],
      [["cyber", "security"], "情報セキュリティ"],
      [["network", "security"], "情報セキュリティ"],
      [["computer", "networks"], "ネットワーク"],
      [["computer", "networking"], "ネットワーク"],
      [["computer", "graphics"], "グラフィックス"],
      [["high", "performance", "computing"], "高性能計算"],
      [["human", "computer", "interaction"], "人間情報処理"],
      [["theoretical", "computer", "science"], "計算理論"],
      [["artificial", "intelligence"], "人工知能"],
      [["database", "systems"], "データベース"],
      [["operating", "systems"], "システム"],
      [["speech", "recognition"], "音声認識"],
    ];

    const formsEn = (words: string[]): string[] => {
      const last = words[words.length - 1];
      const stem =
        last.length >= 4 && last.endsWith("s") && !/(ss|us|is)$/.test(last)
          ? last.slice(0, -1)
          : last;
      const out: string[] = [];
      [words, [...words.slice(0, -1), stem]].forEach((ws) => {
        [ws.join(" "), ws.join("-")].forEach((form) => {
          if (out.indexOf(form) < 0) out.push(form);
        });
        if (ws.length > 1 && out.indexOf(ws.join("")) < 0) out.push(ws.join(""));
      });
      return out;
    };
    if (typeof query !== "string" || !query) return { query, 寄せた: [] };
    let out = query;
    const 寄せた: Array<[string, string[]]> = [];
    aliases.forEach(([words, to]) => {
      /* 前後が英文字・数字のときは別語の一部なので寄せない。後読みの先出し
       * （lookbehind）は古い Safari で構文エラーになるため使わない。 */
      const body = words.join("[\\s-]*");
      const before = out;
      out = out.replace(
        new RegExp(`(^|[^a-z0-9])(?:${body})(?![a-z0-9])`, "gi"),
        (_all: string, head: string) => `${head}${to}`,
      );
      if (out !== before && !寄せた.some((pair) => pair[0] === to))
        寄せた.push([to, formsEn(words)]);
    });
    return { query: out, 寄せた };
  }

  const 時刻の後ろのゾーン語Ja = new Set([
    "jst",
    "utc",
    "gmt",
    "aoe",
    "utc-12",
    "utc+12",
    "日本時間",
    "日本標準時",
    "日本標準時間",
    "世界標準時",
    "協定世界時",
    "グリニッジ標準時",
    "グリニッジ平均時",
  ]);
  /* 長い語から剥がす（`utc-12` を `utc` で切って残余に `-12` を残さない為）。 */
  const 時刻の後ろのゾーン語並びJa = [...時刻の後ろのゾーン語Ja].sort(
    (甲, 乙) => 乙.length - 甲.length,
  );

  function queryTokenGroups(query: unknown, nowMs?: number): string[][] {
    if (typeof query === "string")
      query = query.replace(/([0-9０-９]{4})年の開催回/g, (_, year: string) =>
        editionYearSearchTerm(year),
      );
    if (typeof query === "string") query = eventCertaintySearchText(query);
    if (typeof query === "string" && CATEGORY_CHIP_HEADS_JA.length) {
      query = query.replace(CATEGORY_CHIP_TAIL, "$1");
    }
    query = collapseRelativeDayPhrase(query, nowMs);
    const collapsed = collapseFieldPhraseEnglish(query);
    query = collapsed.query;
    const urlTerms = urlLikeQueryTerms(query);
    if (urlTerms !== null) query = urlTerms;
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const byReading: Record<string, string[]> = {};
    const synonyms = querySynonymMap();
    Object.keys(synonyms).forEach((key) => {
      byReading[key] = synonyms[key][1];
    });
    PLACE_READINGS.concat(REGION_READINGS)
      .concat(CONTINENT_READINGS)
      .forEach((entry) => {
        const members = regionEntryMembers(entry);
        const keys = [kanaFold(entry[1])];
        // 地方名は漢字そのものが会場地名に書かれるとは限らない（「九州」で別府を引きたい）。
        // 漢字見出しも同じ展開語彙に入れる。市名は会場文字列にそのまま出るので kana のみ。
        if (REGION_READINGS.indexOf(entry) >= 0 || CONTINENT_READINGS.indexOf(entry) >= 0)
          keys.push(kanaFold(entry[0]));
        for (const key of keys) {
          if (!byReading[key]) byReading[key] = [];
          members.forEach((member) => {
            if (byReading[key].indexOf(member) < 0) byReading[key].push(member);
          });
        }
      });
    /* 日本語表記で打たれた国名・都市名を、画面に出る英文字表記と同じ組に入れる。
     * 開催地は公式表記（`Seattle, USA`）を変えないので、日本語で打った人に届くように
     * するのは検索語側だけ。逆方向（`seattle` と打ったときに国内表記も見る）も同じ表から
     * 作るが、組の中身は同じ場所を指す語に限定する。 */
    PLACE_QUERY_ALIASES_JA.concat(TOPIC_QUERY_ALIASES_JA).forEach(([ja, latin]) => {
      const key = kanaFold(ja);
      if (!byReading[key]) byReading[key] = [];
      if (byReading[key].indexOf(latin) < 0) byReading[key].push(latin);
      if (!byReading[latin]) byReading[latin] = [];
      if (byReading[latin].indexOf(ja) < 0) byReading[latin].push(ja);
    });

    TOPIC_ABBREVIATIONS_EN.forEach(([略語, 綴り]) => {
      const key = kanaFold(略語);
      if (!byReading[key]) byReading[key] = [];
      if (byReading[key].indexOf(綴り) < 0) byReading[key].push(綴り);
    });
    /* 展開を 1 ホップだけ合成する。かな見出し（`とうきょう`）は漢字見出し（`東京`）へ
     * 寄せるが、漢字見出しが別に持つ英文字表記の寄せ（`tokyo`）は違う表にある。
     * 合成しないと、**漢字で引ける行数とかなで引ける行数がズレる**（2026-09-23 実測:
     * 東京 28 件に対して `とうきょう` 1 件、京都 18 件に対して `きょうと` 2 件、
     * `なら` 0 件）。1 ホップに限定して、連鎖展開で組が膨らみ続けるのを防ぐ。 */
    const resolved: Record<string, string[]> = {};
    /* ただし**地域まとめの見出しでは hop を止める**（`アジア` → `中国` の先が
     * 地方見出しになっていると、地方の都道府県までアジアの展開語に入ってしまう。
     * 「『アジア』に国内の行は入らない」という既定の約束が黙って壊れる。2026-09-23 に
     * `中国` を地方見出しへ足した折、アジアが 523 → 526 行へ広がって実際に壊れた）。 */
    const groupHeadings: Record<string, boolean> = {};
    REGION_READINGS.concat(CONTINENT_READINGS).forEach((entry) => {
      groupHeadings[kanaFold(entry[0])] = true;
      groupHeadings[kanaFold(entry[1])] = true;
    });
    /* **言い換えの寄せ先では地域まと… – 実測と理由は第 723 回に SPEC へ送つた。*/
    const synonymKeys: Record<string, boolean> = {};
    Object.keys(synonyms).forEach((key) => {
      synonymKeys[key] = true;
    });
    Object.keys(byReading).forEach((key) => {
      byReading[key].forEach((member) => {
        if (groupHeadings[member] && !synonymKeys[key]) return;
        const more = byReading[member];
        if (!more) return;
        more.forEach((extra) => {
          if (byReading[key].indexOf(extra) < 0) byReading[key].push(extra);
        });
      });
    });
    /* 和名へ寄せた語の組に、打たれた英語の綴りも載せる（上の `fieldPhraseFormsEn`）。
     * 載せないで寄せると、英語の綴りを行うに持つ行が打ち直し前より減る
     * （実測）。載せるのは実際に寄せた語だけ –
     * 打ってもいない語の綴りを載せると、分野名その物を打った人の当たりまで変わる。
     * `byReading[key]` は寄せ表（cache 済み）の配列その物なので、直さないで写してから足す。 */
    collapsed.寄せた.forEach(([ja, forms]) => {
      const key = kanaFold(ja);
      const base = byReading[key] ? byReading[key].slice() : [];
      forms.forEach((form) => {
        if (base.indexOf(form) < 0) base.push(form);
      });
      byReading[key] = base;
    });
    Object.keys(byReading).forEach((key) => {
      resolved[key] = byReading[key].slice();
    });

    const groups: string[][] = [];
    /* 中黒（・）などの並べ語は site 自身の区切り文字なので、入力でも区切りとして
     * 扱う（一覧・CSV・件数欄・行の詳細の分野/主題/ランクの並び）。
     * 件数欄・CSV・行の詳細は分野を `人工知能・データベース` のように・で並べて書く
     * （この表記を持つ行は収録 397 行）。そのまま写すと 1 語になり、打ち写した語が
     * 0 件に当たっていた（2026-09-23 実測）。切る方向は他の語と同じく AND。
     * ただし `サン・マロ`（saint-malo）のように 1 つの地名に・が入るものがあるので、
     * 語全体が別表に載っているときは、その寄せ先を各部分にも持たせる
     * （どちらの組からも同じ行に届くようにする）。 */
    /* 並べ語の文字類。`・` は画面の並べ書き（一覧・CSV・件数欄・行の詳細）、
     * `，` `、` も以前の書き方として残るため切っておく。`,` と `/` は表計算からの
     * 貼付と、`AI/ML` のように自分で区切る入力に必要（2026-09-23 実測: `ai/ml` は
     * 1 語扱いで 0 件だった）。`／` は正規化で `/` になるので、ここでまとめて受ける。
     * `・` を含む見出しは別表に `サン・マロ` の 1 件だけなので、下の束ねで救う。 */
    /* 全角の括弧・句読点・疑問符も区切りにする。日本語は語の間にスペースを入れないので、
     * `ICDE（2027）` `オンライン（予定）` のように括弧が語にくっついて 1 語になる
     * （2026-08-09 実測: `ICDE` は 18 行なのに `ICDE（2027）` は 0 行だった）。
     * 半角は語の前後にスペースが入ることが多いので、下の端の取り方で受ける
     * （`-` を区切りにしないのは `saint-malo` のような表記と日付 `2026-08-22` を
     * 壊さないため – `dateLike` と同じ判断）。 */
    const JOIN_WORDS = /[・，、,/()（）[\]［］！？:：;；「」『』【】〈〉〜{}]/;
    /* 語の端に付いた句読点・括弧（`sigcomm.` `(online)` `ICDE?`）は落とす。
     * `+` と `-` は端にあっても削らない – `C++` の語尾と `saint-malo` の表記を
     * 壊すため（実測で `c++` を端の記号として削ると 0 件のはずが 745 行に化けた）。
     * 中の記号もそのまま残す。 */
    const EDGE_PUNCT = /[（）()［］[\]【】〈〉《》「」『』！？!?。．.,:：;；〜~"'“”‘’`]+$/u;
    /* `2026-08-22` `12/25` のような日付入力は、`/` を区切りにしない
     * （日付として読む語なので、割ると暦日検索が壊れる。2026-09-23 に実測で拾った）。 */
    const dateLike = (token: string): boolean => {
      if (暦日に境界を続けた形Ja(String(token || ""))) return true;

      if (dayRangeTermsJa(String(token || ""), now).length > 0) return true;
      const 芯 = String(token || "").replace(/までに?$/, "");
      const parts = (芯.length > 0 ? 芯 : token).split("/");
      return parts.length >= 2 && parts.every((part) => /^[0-9]{1,4}$/.test(part));
    };
    /* 時刻の語も割らない。`23:59` をコロンで割ると `59` が立った語になり、その語を
     * 含む行が 1 件も無いので全体が 0 件になる（2026-08-09 生成ビルドで実測:
     * 一覧の 863 行中 679 行が締切欄か公式表記欄に時刻を出している – 21 種・最多は
     * `20:59` の 508 行 – のに、その語はぜんぶ 0 件だった）。全角コロンも受ける。 */
    const timeLike = (token: string): boolean => /^\d{1,2}[:：]\d{2}$/.test(token);

    const コロン時刻を続ける形Ja =
      /^[0-9]{1,2}[:：][0-9]{2}(?:(?:以降|より|から|前|前に|まで|までに|台)?(?:に|で|は|が|も)?|[-−ー~〜～－―‐][0-9]{1,2}[:：][0-9]{2}(?:まで)?)$/;
    /* 日付・時刻帯に続く括弧書きの曜日は**離さない**（実測は SPEC.md – 収録のセルは
     * `2026-08-22 03:00 JST(土)` `2026-09-30(水)` `2026-12-03(木) 〜 2026-12-04(金)` と
     * 書く – 一覧・CSV は同じ式）。括弧で割ると `木` のやうな一文字の語が立つ組になり、組は
     * AND なので、**セルをコピーして貼つた物が 0 件**だつた。かへつて会期欄の曜日を素の語として
     * hay に入れると `金` ひとつで数百件に膨れる。そこで**画面に並ぶ形そのもの**を一まとめの語と
     * して扱い、表示側もその形を入れる（下の `eventDaySearchWords` と `deadlineCellSearchWords`）。
     * 全角括弧は正規化で半角に、末尾の `)` は `queryTokens` が落とすので閉じ括弧の無い打ち方も
     * 受ける。*/
    const weekdayTail = (token: string): boolean =>
      /^(?:\d{4}-\d{2}-\d{2}|jst|aoe)[（(][日月火水木金土][）)]?$/u.test(token);
    const LEADING_PUNCT = /^[（）()［］[\]【】〈〉《》「」『』！？!?。．.,:：;；〜~"'“”‘’`]+/u;

    function trimEdgePunct(value: string): string {
      let out = value.trim();
      while (LEADING_PUNCT.test(out)) out = out.replace(LEADING_PUNCT, "");
      while (EDGE_PUNCT.test(out)) out = out.replace(EDGE_PUNCT, "");
      return out;
    }

    const middleParts = (token: string): string[] => {
      if (weekdayTail(token)) {
        // 括弧を落とすと語の形が変わるので、そのまま返す（`trimEdgePunct` は末尾の `)` を落とす）。
        return [token];
      }
      /* 時刻にタイムゾーンを**繋げて*… – 実測と理由は第 723 回に SPEC へ送つた。*/
      /* ゾーンの語を先に剥がす。時刻の後ろに繋がれた語（`23:59JST` `23:59JST締切`）でも、
       * 語の頭から始まる語（`jst締切` `AoE締切`）でも同じ。残余に区切り・句読点があるときは
       * 下の割りに任せる（之以上割ると語が壊れる – 上の `JOIN_WORDS` の決まり）。
       * 語がゾーン語その物（`jst`）の時は割らない –その方の語で探す。 */
      const ゾーン語を剥がすJa = (語: string, 後に語を要る: boolean): string[] => {
        const 語々: string[] = [];
        let 残余 = 語;
        for (let 回 = 0; 回 < 3; 回 += 1) {
          /* 括弧は落としてから探す – 末尾の `)` を落とすと曜日の括弧が壊れるので、
           * 頭の括弧だけ落とした形も別に持つ（下の曜日の検査がその方の形を見る為）。 */
          const 生 = 残余.replace(
            /^[（）()［］[\]【】〈〉《》「」『』！？!?。．.,:：;；〜~"'“”‘’`]+/u,
            "",
          );
          残余 = trimEdgePunct(残余);
          const ゾーン = 時刻の後ろのゾーン語並びJa.find((語尾) => 残余.startsWith(語尾));
          if (!ゾーン) break;

          const 曜日まで = 生.slice(ゾーン.length);
          if (/^[（(][日月火水木金土][）)]?$/.test(曜日まで)) {
            語々.push(`${ゾーン}${曜日まで}`);
            残余 = "";
            break;
          }
          語々.push(ゾーン);
          残余 = 残余.slice(ゾーン.length);
        }
        const 尾 = trimEdgePunct(残余);
        if (!語々.length) return [];
        if (後に語を要る && !尾) return [];
        if (尾 && JOIN_WORDS.test(尾)) return [];
        return 尾 ? [...語々, 尾] : 語々;
      };
      const 時刻に語を続けた形 = /^([0-9]{1,2}[:：][0-9]{2})(.+)$/u.exec(token);
      if (時刻に語を続けた形) {
        const 剥がした語々 = ゾーン語を剥がすJa(時刻に語を続けた形[2], false);
        if (剥がした語々.length) return [時刻に語を続けた形[1], ...剥がした語々];
      }
      const 頭にゾーンを置く形 = ゾーン語を剥がすJa(token, true);
      if (頭にゾーンを置く形.length) return 頭にゾーンを置く形;
      if (
        !JOIN_WORDS.test(token) ||
        dateLike(token) ||
        暦日に解くJa(String(token || "")) !== null ||
        暦日に境界を続けた形Ja(String(token || "")) !== "" ||
        timeLike(token) ||
        コロン時刻を続ける形Ja.test(token)
      ) {
        const only = trimEdgePunct(token);
        return only ? [only] : [];
      }
      const parts = token
        .split(JOIN_WORDS)
        .map((part) => trimEdgePunct(part))
        .filter(Boolean);
      // 並べ語だけの入力（`，` など）は語を作らない。句読点を含む行全件に化けるため。
      if (parts.length === 0) return [];
      return parts;
    };
    /* 記号だけから出る語（`？` `?` `（` `）` `-` `＋` …）は検索語にしない。画面の文字列は
     * `Lodz, Po (Poland)` のように括弧や記号を含むので、記号を語として要求すると文末に
     * 疑問符を打ちただけで 0 件になる（2026-08-09 実測: `ICDE` は 18 行なのに `ICDE？`
     * と `ICDE?` は 0 行で、0 件案内は収録されているのに `語「icde？」は収録データに
     * ありません` と出ていた）。逆に記号が行の一部に当たる絞りは効いてしまう
     * （`-` は 3,123 行、`（）` は 504 行、`＋` は 85 行）ので、同じ種類の入力が
     * 「全件」「一部」「0 件」の三通りに割れていた。上の `middleParts` が並べ語だけ
     * （`，` など）で語を作らないのと同じ判断を、記号全体に広げる。 */
    const hasWordChar = (value: string): boolean => /[\p{L}\p{N}]/u.test(value);

    const middleWhole = (token: string): string[] =>
      JOIN_WORDS.test(token) ? resolved[kanaFold(token)] || [] : [];
    const units: Array<{ token: string; whole: string[] }> = [];
    列挙の語を寄せるJa(
      範囲の語を寄せるJa(
        暦日を境界に寄せるJa(mergeSeasonTokens(単位を数字に寄せるJa(queryTokens(query, now))), now),
        now,
      ),
    ).forEach((raw) => {
      const 句列挙 = 句読点の列挙Ja(raw, now);
      if (句列挙) {
        units.push({ token: 句列挙.展開[0], whole: 句列挙.展開.slice(1) });
        return;
      }
      /* 助詞も読点も無く並べた形も同じ和集合にする。 */
      const 連結 = 連結の列挙Ja(raw, now);
      if (連結) {
        units.push({ token: 連結.展開[0], whole: 連結.展開.slice(1) });
        return;
      }
      middleParts(raw).forEach((part) => {
        if (!hasWordChar(part)) return;

        const monthTerm = relativeMonthTerm(part, now);
        if (monthTerm) {
          units.push({ token: monthTerm, whole: [] });
          return;
        }

        const yearSeason = yearSeasonTermsJa(raw, now);
        if (yearSeason.length) {
          units.push({ token: yearSeason[0], whole: yearSeason.slice(1) });
          return;
        }
        units.push({ token: part, whole: middleWhole(raw) });
      });
    });
    /* 画面は「第 2 ラウンド」と半角スペースを入れて書く（表の種別セル・行の詳細）。
     * そのまま写すと 「第」 AND「2」 AND「ラウンド」 になり、どの語もほぼ全行に
     * 含まれるので全件に化ける（2026-09-23 実測で確認）。ラウンドの語は 1 まとめで
     * 打たれたものとして扱う。*/
    const mergedUnits: Array<{ token: string; whole: string[] }> = [];
    for (let i = 0; i < units.length; i += 1) {
      const unit = units[i];
      const next = units[i + 1];
      const next2 = units[i + 2];
      if (!unit) continue;
      const roundWord = next2 ? next2.token : "";
      if (
        unit.token === "第" &&
        /^\d{1,2}$/.test(next ? next.token : "") &&
        (roundWord === "ラウンド" || roundWord === "round" || roundWord === "rounds")
      ) {
        mergedUnits.push({ token: `第${next ? next.token : ""}ラウンド`, whole: [] });
        i += 2;
      } else if (next && monthPartRangeJa(`${unit.token}${next.token}`, now) !== null) {
        const 繋いだ語 = `${unit.token}${next ? next.token : ""}`;
        mergedUnits.push({ token: 繋いだ語, whole: monthPartTermsJa(繋いだ語, now) || [] });
        i += 1;
      } else if (pressedWeekdayJa(`${unit.token}${next ? next.token : ""}`, now) !== null) {
        const joined = `${unit.token}${next ? next.token : ""}`;
        mergedUnits.push({
          token: joined,
          whole: (pressedWeekdayJa(joined, now) as string[]) || [],
        });
        i += 1;
      } else {
        mergedUnits.push(unit);
      }
    }
    /* 会議の略称らしき語が同じ入力に混ざっているか（`nsdi 27` の `27` を年の 2027 として
     * 扱うための条件）。略称は 2 文字以上の英文字のかたまりだけなので、月日だけの入力
     * （`8月 27`）や裸の `27` は対象にならない。裸の 2 桁は暦日の「27日」と衝突するので、
     * 略称があるときだけ年としても見る。 */
    const hasAbbrevToken = mergedUnits.some(
      (unit) => /^[a-z][a-z0-9]{1,15}$/.test(unit.token) && !/^\d+$/.test(unit.token),
    );
    mergedUnits.forEach((unit) => {
      const 寄せた語 = 暦日の語に寄せるJa(String(unit.token));
      const token = 寄せた語 || unit.token;
      let group = [token];
      /* `12月` と打つと `2026… – 実測と理由は第 723 回に SPEC へ送つた。*/
      if (/^[0-9]{1,2}月$/.test(token)) {
        const month = Number(token.slice(0, -1));
        if (month >= 1 && month <= 12) {
          group = [];
          for (let year = MONTH_QUERY_YEAR_FROM; year <= MONTH_QUERY_YEAR_TO; year += 1) {
            group.push(`${year}年${month}月`);
          }
        }
      } else if (/^[0-9]{1,2}日$/.test(token)) {
        const day = Number(token.slice(0, -1));
        if (day >= 1 && day <= 31) {
          group = [];
          for (let month = 1; month <= 12; month += 1) {
            group.push(`${month}月${day}日`);
          }
        }
      }
      const expanded = resolved[kanaFold(token)];
      unit.whole.forEach((name) => {
        if (group.indexOf(name) < 0) group.push(name);
      });
      if (expanded) {
        expanded.forEach((name) => {
          if (group.indexOf(name) < 0) group.push(name);
        });
      }

      if (token.indexOf("-") >= 0 && /[a-z]/i.test(token)) {
        const spaced = token.split("-").filter(Boolean).join(" ");
        if (spaced && group.indexOf(spaced) < 0) group.push(spaced);
      }
      pluralStems(kanaFold(token)).forEach((stem) => {
        if (group.indexOf(stem) < 0) group.push(stem);
        const stemGroup = resolved[stem];
        if (stemGroup) {
          stemGroup.forEach((name) => {
            if (group.indexOf(name) < 0) group.push(name);
          });
        }
      });
      // 「明日」「今週」は暦日へ展開する（展開しないと表の暦日語に当たらない）。
      const relative = relativeDayGroups(token, now);
      if (relative) {
        relative.forEach((name) => {
          if (group.indexOf(name) < 0) group.push(name);
        });
      }
      // 「来年」「今年」も 12 か月語へ展開する（同じく展開しないと当たらない）。
      yearMonthTermsJa(token, now).forEach((name) => {
        if (group.indexOf(name) < 0) group.push(name);
      });

      const monthRange = monthRangeTermsJa(token, now);
      if (monthRange.length) group = monthRange.slice();

      const dayRange = dayRangeTermsJa(token, now);
      if (dayRange.length) group = dayRange.slice();

      const 列挙 = 列挙の展開語Ja(token, now);
      if (列挙.length) group = 列挙.slice();
      /* 「秋」「春」などの季節の語も同じ暦月語のグループへ展開する。 */
      const season = seasonTermsJa(token, now);
      if (season.length) group = season.slice();

      const period = periodMonthTermsJa(token, now);
      if (period.length) group = period.slice();

      /* 時刻の語は零詰めた形に寄せる。画面に出る 21 種はすべて `08:59` の形で
       * 無い物は無く（2026-08-09 生成ビルドで実測）、打った側を画面の形に直す。元の形も
       * 同じ組に入れると部分一致で化ける – `8:59` に `08:59` の 88 行に加えて
       * 締切欄が `2026-11-09 18:59 JST(月)` の NOMS 2027 が 1 件混んだ（実測）ので、
       * 零詰めた形だけを入れる。 */
      if (timeLike(token)) {
        const clock = /^(\d{1,2})[:：](\d{2})$/.exec(token);
        if (clock) {
          // 元の形は組に残さない（`let group = [token]` から組み替える – 上の暦日と同じ）。
          group = [`${clock[1].length === 1 ? `0${clock[1]}` : clock[1]}:${clock[2]}`];
        }
      }

      // 数字だけの入力（`12/25` `2026-12-25` `2026-12`）は、hay に出る暦日の日本語形と
      // 同じ組に入れる。暦日への解決は月日そのものなので、日付の語とは違い説明は不要。
      const calendar = calendarDateGroups(token);
      if (calendar) {
        calendar.forEach((name) => {
          if (group.indexOf(name) < 0) group.push(name);
        });
      }
      /* 略称と年を離して打つ人は多い（`NSDI 27`）。貼り付けて打たれる前提の
       * `abbrevYearGroups` では割れたまま通り、変更前は 0 件だった（実測: `NSDI 27`
       * `ICDE 27` はいずれも 0 件で、`NSDI 2027` は出る）。 */
      if (hasAbbrevToken && /^\d{2}$/.test(token)) {
        const year = `20${token}`;
        if (group.indexOf(year) < 0) group.push(year);
      }
      const split = abbrevYearGroups(token);
      if (split) {
        // 略称の組にも読み展開を足す（`しこんどす27` のような入力は無いが、
        // 展開語を持つ語が割れる経路と衝突させないため統一する）。
        expanded?.forEach((name) => {
          if (split[0].indexOf(name) < 0) split[0].push(name);
        });
        groups.push(split[0], split[1]);
        return;
      }
      groups.push(group);
    });
    return groups;
  }

  /* 長い和語・熟語は、表側の表記が分かれていることがある（「オペレーティング・システム」
   * のように中黒で割れる語、主題語が別々に並ぶ hay）。語そのものが無いときだけ、
   * 2 つに割った両方が含まれるかを試す。短い語でやると別々の語の取り合わせで何でも
   * 当たってしまうので、長い日本語の語に限定する。 */
  const COMPOUND_MIN_LENGTH_JA = 7;

  function compoundSplitHit(target: string, token: string): boolean {
    if (token.length < COMPOUND_MIN_LENGTH_JA) return false;
    if (!/^[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]+$/.test(token)) return false;
    // 分割案は必ず語の先頭 2 文字と末尾 2 文字を含むので、それを必要条件に落として
    // 行を絞る（検索ボックスは 1 文字打つごとに全行を見るため、ここを怠ると遅い）。
    if (target.indexOf(token.slice(0, 2)) < 0 || target.indexOf(token.slice(-2)) < 0) return false;
    for (let cut = 2; cut <= token.length - 2; cut += 1) {
      if (target.indexOf(token.slice(0, cut)) >= 0 && target.indexOf(token.slice(cut)) >= 0)
        return true;
    }
    return false;
  }

  /**
   * 検索語に対する照合関数を 1 回だけ作る。`hayMatches(hay, query)` は行ごとに
   * 検索語を分解し直すため、行の数のぶんだけ無駄をする（実測 3234 行で 1 打鍵
   * 約 83 ms、うち約 69 ms が分解のやり直し）。一覧の絞り込みはこれを使う。
   */

  function withoutWholeTableGroups(groups: string[][]): string[][] {
    if (groups.length < 2) return groups;
    const whole = WHOLE_TABLE_QUERY_JA.map((word) => kanaFold(word));
    const kept = groups.filter(
      (group) => !group.every((term) => whole.indexOf(kanaFold(term)) >= 0),
    );
    return kept.length ? kept : groups;
  }

  const FUNCTION_WORDS_JA = ["開催", "実施"];
  function withoutFunctionGroups(groups: string[][]): string[][] {
    if (groups.length < 2) return groups;
    const 語々 = FUNCTION_WORDS_JA.map((word) => kanaFold(word));

    const 名々 = ["会議", "学会", "大会", "研究会", "ワークショップ", "セッション"].map((word) =>
      kanaFold(word),
    );
    const 機能語の組か = (group: string[]): boolean => {
      if (group.length !== 1) return false;
      const 語 = kanaFold(group[0]);
      if (語々.indexOf(語) >= 0) return true;

      if (語.length > 16) return false;
      return 語々.some((w) => 語.startsWith(w)) && 名々.some((n) => 語.endsWith(n));
    };
    const kept = groups.filter((group) => !機能語の組か(group));
    return kept.length ? kept : groups;
  }

  function searchGroups(query: unknown, nowMs?: number): string[][] {
    return withoutFunctionGroups(withoutWholeTableGroups(queryTokenGroups(query, nowMs))).map(
      (group) => group.map((term) => kanaFold(term)),
    );
  }

  function searchMatcher(query: unknown, nowMs?: number): (hay: unknown) => boolean {
    const groups = searchGroups(query, nowMs);
    if (!groups.length) return () => true;
    return (hay: unknown): boolean => {
      const target = kanaFold(hay);
      return matchFoldedGroups(target, groups);
    };
  }

  /* 英字 1〜2 文字の語か（ランクの A・B・C・N、会議の略称 SC など）。 */
  function isShortLatinTerm(term: string): boolean {
    return /^[a-z]{1,2}$/.test(term);
  }

  /* 英字を部分一致で開けると、語の途… – 実測と理由は第 723 回に SPEC へ送つた。*/
  function foldedLetterAtWordBoundary(target: string, term: string, leftOnly = false): boolean {
    let from = 0;
    for (;;) {
      const at = target.indexOf(term, from);
      if (at < 0) return false;
      const before = at > 0 ? target.charAt(at - 1) : "";
      const after = at + term.length < target.length ? target.charAt(at + term.length) : "";
      const gluedBefore = before !== "" && /[a-z0-9]/.test(before);
      const gluedAfter = after !== "" && /[a-z0-9]/.test(after);
      if (!gluedBefore && (leftOnly || !gluedAfter)) return true;
      from = at + 1;
    }
  }

  const LATIN_TERM_TOKEN = /^[a-z0-9][a-z0-9 .'-]*$/;

  let wholeWordLatinTerms: Record<string, true> | null = null;

  /* 開催地として置く英字語（国名・都市名・地域まとめの構成員）。ここに入っている語は
   * 語全体で当たったときだけ採用する（`usa` を `usage` と同じ場所にしない）。 */
  function placeLatinTerms(): Record<string, true> {
    if (wholeWordLatinTerms) return wholeWordLatinTerms;
    const out: Record<string, true> = {};
    const add = (value: string) => {
      const term = kanaFold(value.trim());
      if (term.length >= 3 && LATIN_TERM_TOKEN.test(term)) out[term] = true;
    };
    PLACE_QUERY_ALIASES_JA.forEach((entry) => {
      add(entry[0]);
      add(entry[1]);
    });
    PLACE_READINGS.forEach((entry) => {
      if (entry[2]) String(entry[2]).split(",").forEach(add);
    });
    CONTINENT_READINGS.forEach((entry) => {
      String(entry[2]).split(",").forEach(add);
    });
    wholeWordLatinTerms = out;
    return out;
  }

  /* 末尾が数字の語は、右に続くと**別の値**になる（ラウンドの `r1` に `r10` は 10 周目）。
   * 英字語と同じく語頭だけ開けた形にすると、1 周目を引いたのに 10・11・12 周目の行が
   * 混ざる（2026-08-09 実測: 「R1」で既定画面 426 行に当たり、そのうち 6 行は round が
   * 10・11・12 の行だった）。だからこの形に限って右端も要求する。 */
  function termEndsInDigit(term: string): boolean {
    return /[0-9]$/.test(term);
  }

  function pluralStems(term: string): string[] {
    let out: string[] = [];
    /* 語尾が `s` の語だけを対象にする（語尾を見て畳むと `cryptography` が `cryptograph`に
     * 化けて、語の形を無視した通り道が出来る – 実測で 10 行 → 22 行に化けた）。 */
    if (/^[a-z]{4,}s$/.test(term) && !/(ss|us|is)$/.test(term)) {
      /* `databases` は `database` + `s`、`classes` は `class` + `es` – 綴りだけでは
       * どちらか区別がつかないので、成り得る形を両方試す（当たるかどうかは行が決める）。 */
      out = [term.slice(0, -1)];
      if (/(xes|ses|zes|ches|shes)$/.test(term)) out.push(term.slice(0, -2));
    }
    return out;
  }

  /** 畳み済みの語グループ（語ごとに OR、語同士は AND）を行に照合する。 */

  function latinFoldedHit(target: string, term: string): boolean {
    if (isShortLatinTerm(term)) return foldedLetterAtWordBoundary(target, term);
    if (!LATIN_TERM_TOKEN.test(term)) return target.indexOf(term) >= 0;
    return foldedLetterAtWordBoundary(
      target,
      term,
      // 開催地の語と末尾が数字の語は右端も閉じる。
      !placeLatinTerms()[term] && !termEndsInDigit(term),
    );
  }

  function matchFoldedGroups(target: string, groups: string[][]): boolean {
    for (let i = 0; i < groups.length; i++) {
      let hit = false;
      for (let k = 0; k < groups[i].length; k++) {
        const term = groups[i][k];

        if (LATIN_TERM_TOKEN.test(term) && /\s/.test(term)) {
          const 語列 = term.split(/\s+/).filter(Boolean);

          let 皆當 = true;
          for (let w = 0; w < 語列.length; w++) {
            if (!latinFoldedHit(target, 語列[w])) {
              皆當 = false;
              break;
            }
          }
          if (皆當) {
            hit = true;
            break;
          }
          continue;
        }
        if (latinFoldedHit(target, term)) {
          hit = true;
          break;
        }
      }
      // どの候補も語そのものでは当たらなかったときだけ、長い和語の分割を試す。
      if (!hit) {
        for (let k = 0; k < groups[i].length; k++) {
          if (compoundSplitHit(target, groups[i][k])) {
            hit = true;
            break;
          }
        }
      }
      if (!hit) return false;
    }
    return true;
  }

  function hayMatches(hay: unknown, query: unknown): boolean {
    // 照合式は `searchMatcher` に一本化している（行ごとに検索語を分解し直さないため、
    // 一覧側はそちらを直接使う）。ここは 1 行ずつ照らすための薄い入口。
    return searchMatcher(query)(hay);
  }

  /* SPEC §7: 日本語 UI。開催地は出張・オンライン参加の判断材料だが、
   * 原文は "Alicante, Spain / Online" のような英字表記で、一覧を流し読みしたときに
   * 国が判別しにくい。国名と開催形式の語だけを日本語に寄せる。
   * 都市名は網羅できる形にできず、誤変換すると場所の特定ができなくなるため変換しない。
   * 対応表に無い語は推測せず原文を残す（data の開催地 307 通りの実値を見て持つ）。 */
  const PLACE_TERMS_JA: Array<[string, string]> = [
    ["united states of america", "アメリカ"],
    ["united states", "アメリカ"],
    // 上流の誤記 (United State) も同じ国として寄せる。原文の訂正は overrides 側で行う。
    ["united state", "アメリカ"],
    ["usa", "アメリカ"],
    ["south korea", "韓国"],
    ["republic of korea", "韓国"],
    ["korea", "韓国"],
    ["the netherlands", "オランダ"],
    ["netherlands", "オランダ"],
    ["united kingdom", "イギリス"],
    ["uk", "イギリス"],
    ["england", "イギリス"],
    ["new zealand", "ニュージーランド"],
    ["south africa", "南アフリカ"],
    ["costa rica", "コスタリカ"],
    ["türkiye", "トルコ"],
    ["turkey", "トルコ"],
    ["uae", "アラブ首長国連邦"],
    ["hong kong", "香港"],
    ["canada", "カナダ"],
    ["china", "中国"],
    ["italy", "イタリア"],
    ["japan", "日本"],
    ["australia", "オーストラリア"],
    ["spain", "スペイン"],
    ["singapore", "シンガポール"],
    ["germany", "ドイツ"],
    ["france", "フランス"],
    ["portugal", "ポルトガル"],
    ["india", "インド"],
    ["greece", "ギリシャ"],
    ["brazil", "ブラジル"],
    ["belgium", "ベルギー"],
    ["vietnam", "ベトナム"],
    ["thailand", "タイ"],
    ["sweden", "スウェーデン"],
    ["hungary", "ハンガリー"],
    ["czechia", "チェコ"],
    ["ireland", "アイルランド"],
    ["romania", "ルーマニア"],
    ["morocco", "モロッコ"],
    ["denmark", "デンマーク"],
    ["austria", "オーストリア"],
    ["bulgaria", "ブルガリア"],
    ["poland", "ポーランド"],
    ["iceland", "アイスランド"],
    ["finland", "フィンランド"],
    ["cyprus", "キプロス"],
    ["panama", "パナマ"],
    ["malaysia", "マレーシア"],
    ["indonesia", "インドネシア"],
    // アクセント付きの表記は語として書かれていないと当たらない（照合はそのままの
    // 文字列を見るので、検索のときだけアクセントを落とす仕組みはここでは効かない）。
    // 収録に現れた表記を増やす（2026-09-23: `México` が英語のまま残っていた）。
    ["mexico", "メキシコ"],
    ["méxico", "メキシコ"],
    ["curacao", "キュラソー"],
    ["curaçao", "キュラソー"],
    ["cameroon", "カメルーン"],
    ["luxembourg", "ルクセンブルク"],
    ["ghana", "ガーナ"],
    ["ecuador", "エクアドル"],
    ["malta", "マルタ"],
    ["armenia", "アルメニア"],
    ["chile", "チリ"],
    ["croatia", "クロアチア"],
    ["nigeria", "ナイジェリア"],
    ["cambodia", "カンボジア"],
    ["norway", "ノルウェー"],
    ["switzerland", "スイス"],
    ["lithuania", "リトアニア"],
    ["slovakia", "スロバキア"],
    // 以下は収録済みカタログの開催地末尾に実際に現れた語だけを追加する
    // （都道府県の補完と同じ方針。来ていない語を先回りで入れても検証できない）。
    ["czech republic", "チェコ"],
    ["united arab emirates", "アラブ首長国連邦"],
    ["u.s.a.", "アメリカ"],
    ["u.s.a", "アメリカ"],
    ["netherland", "オランダ"], // 上流の誤記。"netherlands" は上の語が先に当たる
    ["taiwan", "台湾"],
    ["israel", "イスラエル"],
    ["colombia", "コロンビア"],
    ["russia", "ロシア"],
    ["slovenia", "スロベニア"],
    // 国名を書かない表記では州が末尾に来る（"Boulder, Colorado"）。
    ["pennsylvania", "ペンシルベニア州"],
    ["california", "カリフォルニア州"],
    ["tennessee", "テネシー州"],
    ["louisiana", "ルイジアナ州"],
    ["colorado", "コロラド州"],
    ["hawaii", "ハワイ州"],
    ["ca", "カリフォルニア州"],
    // 国名を省略した行で末尾になる都市（都市名そのものの置換はfront側を壊すので末尾だけ）。
    ["los angeles", "ロサンゼルス"],
    ["san francisco", "サンフランシスコ"],
    ["denver", "デンバー"],
    ["vancouver", "バンクーバー"],
    ["leuven", "ルーヴェン"],
    ["santiago de compostela", "サンティアゴ・デ・コンポステーラ"],
    ["united kindom", "イギリス"], // 上流の誤記 (Kindom)
    ["estonia", "エストニア"],
    ["argentina", "アルゼンチン"],
    ["rwanda", "ルワンダ"],
    ["greec", "ギリシャ"], // 上流で切れた表記 (Greec)
    ["tuscany", "トスカーナ州"],
    ["indiana", "インディアナ州"],
    ["oregon", "オレゴン州"],
    ["abu dhabi", "アブダビ"],
    ["st. kitts", "セントクリストファー・ネイビス"],
    ["montreal", "モントリオール"],
    ["birmingham", "バーミンガム"],
    ["donostia", "ドノスティア"],
    ["paris", "パリ"],
    ["madrid", "マドリード"],
    ["europe", "ヨーロッパ"],
    ["us", "アメリカ"],
    /* 意図的に入れていない語:
     *   BE      … 二字の国コードは "GA"（州か国か）のように迷うので推測しない
     *   Grenada … `Radisson Grenada Beach Resort Grenada` の会場名の中で置換が当たり、
     *               会場名が壊れる（国名の行は他に無い） */
    ["online only", "オンラインのみ"],
    ["online", "オンライン"],
    ["virtual", "オンライン"],
    ["hybrid", "ハイブリッド"],
    ["in person", "対面"],
    ["in-person", "対面"],
    ["onsite", "対面"],
    ["on-site", "対面"],
    ["tbd", "未定"],
  ];

  // 語として置換する。語句の途中にマッチすると都市名を壊すため、
  // 前後は単語境界（ラテン文字・数字・ハイフン以外）に限定する。
  /* 国名の置換に壊される複合地名（収録に実在するものだけ）。`New Mexico` は
   * アメリカの州なのに、`mexico` の置換で表示が「New メキシコ」になり、
   * 「メキシコ」で引いた人にアメリカの会議を渡していた（2026-09-23 実測:
   * `New Mexico` 2 行）。「○○州」に寄せると `ニューメキシコ` の中に `メキシコ` が
   * 残って検索側でも同じ誤りが起きるので、**翻訳せず公式表記のまま**置く
   * （州名から国を推測して検索語に足すこともしない）。 */
  const PLACE_NAME_SHIELDS_JA = ["new mexico"];

  const PLACE_TERM_PATTERNS: Array<[RegExp, string]> = PLACE_TERMS_JA.map(([term, ja]) => [
    new RegExp(
      `(?<![A-Za-z0-9-])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9-])`,
      "gi",
    ),
    ja,
  ]);

  /* 2 文字の国コードで書かれた開催地（上流表記）。収録に現れる `BE` だけを足す
   * （`Antwerp, BE` が英語のまま残り、「ベルギー」で引いても出なかった。2026-09-23 実測:
   * 2 行）。末尾の句に単独で現れたときだけ置くので、会場名の一部にはマッチしない。 */
  const PLACE_COUNTRY_CODES_JA: Array<[string, string]> = [["be", "ベルギー"]];

  function placeTermJa(text: string): string {
    let out = text;
    /* 都市名などの語を、後で国名などに置き換える対象から一時的に退避する。退避は
     * 「目印 + 番号 + 目印」の形で行い、語の置き換えが終わったら元に戻す。目印は
     * 文字 NUL（U+0000）で良いが、**ソースに生の NUL バイトを書かない**こと。
     * 生で書くと、そのファイルを一続きのテキストとして開けなくなる仕組みがあり、
     * 編集も差分も検査も困る（2026-09-24 に正本 4 箇所で実発生）。必ず `\u0000` の
     * 書き表しで書く（意味は同じで、画面に出る値も変わらない）。 */
    const shielded: string[] = [];
    PLACE_NAME_SHIELDS_JA.forEach((name) => {
      out = out.replace(new RegExp(`(?<![A-Za-z0-9-])${name}(?![A-Za-z0-9-])`, "gi"), (matched) => {
        shielded.push(matched);
        return `\u0000${shielded.length - 1}\u0000`;
      });
    });
    PLACE_TERM_PATTERNS.concat(
      PLACE_COUNTRY_CODES_JA.map(
        ([term, ja]) =>
          [new RegExp(`(?<![A-Za-z0-9-])${term}(?![A-Za-z0-9-])`, "gi"), ja] as [RegExp, string],
      ),
    ).forEach(([pattern, ja]) => {
      out = out.replace(pattern, ja);
    });
    shielded.forEach((matched, i) => {
      out = out.split(`\u0000${i}\u0000`).join(matched);
    });
    // "UK and hybrid" 等の接続詞は中点に寄せる（一覧の 1 行で読める形にする）。
    return out.replace(/\s+and\s+|\s*&\s*/gi, "・");
  }

  /* 会場表記に都道府県が書かれるとは限らない（`倉敷市芸文館`、`名古屋大学 基盤センター` など）。
   * 土地で絞り込む利用者が「岡山」「愛知」で引けるよう、都市名から都道府県の手がかりを足す。
   * 一覧は実際に収録済みの会場表記（国内会議の開催地 36 種）に現れた都市だけに限る。
   * 表示は公式表記のまま変え、検索語にだけ効かせる（推測で都道府県を書かない）。 */
  const CITY_PREFECTURE_JA: Array<[string, string]> = [
    ["倉敷", "岡山"],
    ["名古屋", "愛知"],
    ["北九州", "福岡"],
    ["武蔵野", "東京"],
    ["能登", "石川"],
    ["函館", "北海道"],
    ["那覇", "沖縄"],
    ["札幌", "北海道"],
    ["仙台", "宮城"],
    ["松江", "島根"],
    ["高山", "岐阜"],
    ["別府", "大分"],
    ["香美", "高知"],
    ["御影", "兵庫"],
    ["芸文館", "岡山"],
    // 2026-09-22 に実データ（`data.json` の開催地）に出てくる都市だけを足した。
    // 都市名と都道府県名が同じものは、補記はされないが検索語には正式名が必要になる。
    ["東京", "東京"],
    ["大阪", "大阪"],
    ["京都", "京都"],
    ["熊本", "熊本"],
    ["鹿児島", "鹿児島"],
    ["高知", "高知"],
    ["岐阜", "岐阜"],
    ["和歌山", "和歌山"],
    ["大津", "滋賀"],
  ];

  /* 都道府県の正式名称。「県」を一律に足すと `北海道県` `東京県` `京都府県` という
   * 実在しない地名ができる（札幌の会場補記で実際に発生していた）。 */
  const PREFECTURE_OFFICIAL_JA: Record<string, string> = {
    東京: "東京都",
    京都: "京都府",
    大阪: "大阪府",
    北海道: "北海道",
  };

  function prefectureOfficialJa(prefecture: string): string {
    return PREFECTURE_OFFICIAL_JA[prefecture] || `${prefecture}県`;
  }

  /** 開催地に都道府県が書かれていないときだけ補う（`upcoming.md` の開催地列用）。
   * 公式表記を書き換えないため、末尾に空白区切りで添えるだけにする。 */
  function placeWithPrefectureJa(value: unknown): string {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return "";
    const prefectures = placePrefectures(raw);
    // 複数の都道府県に読める表記（大学名に他の土地名が含まれる等）では補わない。
    // 間違った土地を載せるほうが悪い。
    if (prefectures.length !== 1) return raw;
    const prefecture = prefectures[0] as string;
    if (raw.indexOf(prefecture) >= 0) return raw;
    return `${raw} ${prefectureOfficialJa(prefecture)}`;
  }

  /** 会場表記から割り出せる都道府県（表記に現れた順、重複なし）。 */
  function placePrefectures(value: unknown): string[] {
    const raw = typeof value === "string" ? value : "";
    const hits: string[] = [];
    CITY_PREFECTURE_JA.forEach(([city, prefecture]) => {
      if (raw.indexOf(city) < 0) return;
      if (hits.indexOf(prefecture) < 0) hits.push(prefecture);
    });
    return hits;
  }

  /** 会場表記から都道府県の検索語を作る（`岡山 岡山県`。「岡山県」と打っても引けるように両方）。
   * 正式名を使うので `東京 東京都` `大阪 大阪府` となる（`東京県` を作らない）。 */
  function placePrefectureJa(value: unknown): string {
    return placePrefectures(value)
      .map((prefecture) => {
        const official = prefectureOfficialJa(prefecture);
        // `北海道` のように正式名がそのまま都道府県名のものは語を繰り返さない。
        return official === prefecture ? prefecture : `${prefecture} ${official}`;
      })
      .join(" ");
  }

  /* 表は空の会期・開催地・ランクをこの語で出す（SPEC §7）。画面に書いた語は検索できるように
   * する（「表示している語で検索できる」の不変条件）。分野ごとにも引けるよう修飾形も添える。
   * 「未定」ではない — 会議が決めていないことと、 kamiyobi が確認できていないことは別。 */
  const UNCONFIRMED_LABEL_JA = "未確認";
  /* 日付だけが決まっている行の公式表記に出す語。一覧・行の詳細・CSV・検索が同じ語を
   * 使う（同じ物に二つの名前を付けない）。 */
  const TIME_UNCONFIRMED_LABEL_JA = "時刻未確認";

  function unconfirmedLabelJa(): string {
    return UNCONFIRMED_LABEL_JA;
  }

  /* 会期・開催地が「そもそも存在しない」行に使う語（SPEC §7）。「未確認」は kamiyobi が
   * 公式で裏を取れていないという意味なので、常時受付のジャーナル（会期も会場も無い）に
   * 同じ語を当てると、利用者は公式情報を追いかける意味のない探索をさせられる。 */
  const NOT_APPLICABLE_LABEL_JA = "該当なし";
  const NOT_APPLICABLE_TITLES_JA: Record<string, string> = {
    event: "常時受付のジャーナルには会期がありません",
    place: "常時受付のジャーナルには開催地がありません",
  };

  function notApplicableLabelJa(): string {
    return NOT_APPLICABLE_LABEL_JA;
  }

  function notApplicableTitleJa(field: string): string {
    return NOT_APPLICABLE_TITLES_JA[field] || "";
  }

  /** 会期・開催地がそもそも存在しない行か（常時受付のジャーナル）。 */
  function fieldNotApplicableJa(row: unknown): boolean {
    const rec = row as { kind?: unknown } | null;
    return String(rec?.kind ?? "") === "journal";
  }

  /* データ生成時刻が古いときの注意書き（SPEC §7）。`update-data.yml` は日次で走る設計
   * （cron: 17 20 * * *）なので、数日経ったままなら更新が止まっている可能性がある。
   * 締切のサイトで古いデータを開いた人がそれを最新と誤って使い、投稿の機会を逃すのが
   * 一番悪い失敗なので、表示しているデータの生成から経った日数を正直に出す。
   * ここはデータの生成時刻の話で、締切の日付を推測する話ではない。 */
  const DATA_STALE_DAYS_JA = 3;

  /** データ生成からの日数（**JST の暦日**で数える）が指定日数
   * （`DATA_STALE_DAYS_JA`）以上のときだけ、
   *  読めない値・未来の値（閲覧側の時計のズレ）では空文字 – 根拠の無い警告を出さない。 */
  function dataAgeNoteJa(generatedAt: unknown, nowMs: number): string {
    const raw = typeof generatedAt === "string" ? generatedAt.trim() : "";
    const at = raw ? Date.parse(raw) : Number.NaN;
    if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return "";
    /* 「N 日前」は JST の暦日で数える。この画面はデータ生成の時刻も一覧の日時も JST で
     * 出していて（「残り」も JST の暦日が正本）、生成時刻の直後に「データは N 日前」と
     * 並ぶので、ここだけ経過 24 時間で数えると隣に書いた日時と合わなかった
     * （2026-08-09 実測: JST で 8/6 23:00 生成のデータは、JST の暦日では 8/9 01:00 に
     * 3 日経過しているのに「2 日前」と数えられ、「3 日以上」のお知らせが出なかった。
     * 逆に 8/10 00:30 では暦日 4 日なのに「3 日前」と出た。警告が遅くとも約一日遅れて
     * 届くので、古い一覧を最新と誤る失敗を防げない）。
     * JST のオフセットはインラインに置く（月見出し・`remain` と同じ理由）。 */
    const jstDay = (t: number) => Math.floor((t + 9 * 3600000) / 86400000);
    const days = jstDay(nowMs) - jstDay(at);
    if (days < DATA_STALE_DAYS_JA) return "";
    return (
      ` データは ${days} 日前に生成されたものです。` +
      "日次で更新する運用なので、更新が止まっている可能性があります。" +
      "投稿前に公式サイトの募集要項を確認してください。"
    );
  }

  /* 意味検索が使えないとき、画面に理由を出す。失敗の識別子は #711 の構造要因（8 通りの
   * 失敗が 1 文言に潰れて原因追跡不能になっていた）を直すために持っているが、値は
   * `model load failed` のような英語なので、日本語の文にそのまま混ぜると利用者に読めない
   * 語が見える（2026-09-23 実測: 「原因: embeddings unavailable」）。画面には日本語を
   * 出し、識別子はそのまま要素の `data-semantic-reason` に残す（報告を受けた側が
   * 開発者ツールで読める）。 */
  const SEMANTIC_REASON_LABELS_JA: { [code: string]: string } = {
    unknown: "原因を特定できませんでした",
    "embeddings unavailable": "意味検索のデータが読み込めませんでした",
    "embedding set incompatible": "意味検索のデータの組み合わせが一致しません",
    "model metadata missing": "意味検索モデルの情報が見つかりません",
    "model load failed": "意味検索モデルの読み込みに失敗しました",
    "probe mismatch": "意味検索モデルの確認に失敗しました",
    "model unavailable": "意味検索モデルを利用できません",
    "query embedding failed": "入力した文章の読み取りに失敗しました",
    "recommendation data unavailable": "推薦データの読み込みに失敗しました",
    "manifest/index unavailable": "推薦データの目録が読み込めませんでした",
    "index structure mismatch": "推薦データの形が一致しません",
    "index build_id mismatch": "推薦データの版が一致しません（再読み込みで直ることがあります）",
    "index content_id mismatch": "推薦データの内容が一致しません（再読み込みで直ることがあります）",

    "semantic_status lexical-only": "この推薦データは意味検索に対応していません",
    "embeddings mismatch": "意味検索のデータが一致しません",
  };

  /** 失敗の識別子を利用者が読める形に直す。未知の値（モデル側が返す自由文）は
   *  「その他の問題」に寄せるが、既に日本語で書かれたものはそのまま通す。 */
  function semanticReasonJa(code: unknown): string {
    const value = typeof code === "string" ? code.trim() : "";
    if (!value) return SEMANTIC_REASON_LABELS_JA.unknown;
    const known = SEMANTIC_REASON_LABELS_JA[value];
    if (known) return known;
    // 日本語を含む自由文（後から運営が足した説明など）を、英語扱いで潰さない。
    return /[\u3041-\u309f\u30a1-\u30ff\u4e00-\u9fff]/.test(value) ? value : "その他の問題";
  }

  /* 画面が「未確認」「該当なし」と出す項目の一覧（SPEC §7）。一覧のセルを作る条件と
   * 揃えるため、行から取る。
   *   - 一覧のセルは空欄を作らないので、この語が画面に出る。
   *   - CSV の状態の列も同じ語を使う（値の列は空のまま – 表計算では値の側で並べ替える
   *     ほうが都合がよく、空・未確認・該当なしの区別はこの列が持つ）。画面が「未確認」と
   *     出す行が、書き出すとただの空欄になっていた（2026-09-23 実測: 会期が未知の行で
   *     状態・会期・開催地の各列がすべて空。常時受付の行も、画面は「該当なし」と読むのに
   *     CSV では同じ空欄で、区別できなかった）。 */
  function unconfirmedFieldsJa(row: unknown): string[] {
    const rec = row as { kind?: unknown; ed?: unknown; rankPairs?: unknown } | null;
    const ed = (rec?.ed || {}) as Record<string, unknown>;
    const notApplicable = fieldNotApplicableJa(row);
    const state = notApplicable ? NOT_APPLICABLE_LABEL_JA : UNCONFIRMED_LABEL_JA;
    const fields: string[] = [];
    if (!String(ed.event_start || "").trim()) fields.push(`会期${state}`);
    if (!String(ed.place || "").trim()) fields.push(`開催地${state}`);
    // ランクは常時受付の行にも付き得るので、該当なしにはならない（未確認だけ）。
    const pairs = (rec?.rankPairs || []) as readonly string[];
    if (!pairs.length) fields.push(`ランク${UNCONFIRMED_LABEL_JA}`);
    return fields;
  }

  /* 検索語に入れる「未確認」「該当なし」の語（SPEC §7）。画面に出る語は検索でも
   * 引ける、という約束を守るため、セルの語と同じものを検索語にも置く（CSV の状態の列にも
   * 同じ語を書くので、書き出し側で見た語をそのまま打てる）。 */
  function unconfirmedHayJa(row: unknown): string {
    const fields = unconfirmedFieldsJa(row);
    if (!fields.length) return "";
    // 項目名の付いた語だけでなく、セルにそのまま出る「未確認」でも引けるようにする。
    const bare = fields.some((field) => field.endsWith(UNCONFIRMED_LABEL_JA))
      ? ` ${UNCONFIRMED_LABEL_JA}`
      : "";
    return `${fields.join(" ")}${bare}`;
  }

  function unconfirmedMeaningJa(): string {
    return ` kamiyobi がその項目を公式に裏取りできていないという印（収録元が無いと決めた意味ではない）`;
  }

  function aoeMeaningJa(): string {
    return "「AoE」は UTC-12 の時刻で締める締切です";
  }

  /* ランク表の `N` は「評価の一覧に載っているが評価が付いていない」意味だと §2 で検証済み
   * （`ccf: N` など）。表に内部トークンの `N` をそのまま出すと読み手には読めないので、
   * 表示語に直す。評価の一覧にそもそも載らない行は「未確認」なので、語を使い分ける
   * （ kamiyobi が未確認なのと、一覧が評価を付けていないのは別の事実）。 */
  const RANK_UNRATED_LABEL_JA = "評価なし";
  const RANK_ABSENT_GRADES = ["n", "none", "-", ""];
  const RANK_SCALE_LABEL_JA: Record<string, string> = {
    ccf: "CCF",
    core: "CORE",
    thcpl: "THCPL",
  };

  function rankScaleLabelJa(name: string): string {
    const key = String(name || "").toLowerCase();
    return RANK_SCALE_LABEL_JA[key] || String(name || "").toUpperCase();
  }

  /** `ccf:B` → `CCF B`、`ccf:N` → `CCF 評価なし`。表・ドロワーで同じ語を使う。 */
  function rankPairLabelJa(pair: string): string {
    const text = String(pair || "");
    const at = text.indexOf(":");
    if (at < 0) return rankScaleLabelJa(text);
    const scale = rankScaleLabelJa(text.slice(0, at));
    const grade = text.slice(at + 1).trim();
    if (RANK_ABSENT_GRADES.indexOf(grade.toLowerCase()) >= 0) {
      return `${scale} ${RANK_UNRATED_LABEL_JA}`;
    }
    return `${scale} ${grade}`;
  }

  function rankUnratedLabelJa(): string {
    return RANK_UNRATED_LABEL_JA;
  }

  /** 表に出すランクの語を検索語として受け付ける（「表示している語で検索できる」）。 */
  function rankSearchTerms(rankPairs: readonly string[] | null | undefined): string {
    const parts: string[] = [];
    let hasGrade = false;
    (rankPairs || []).forEach((pair) => {
      const text = String(pair || "");
      const at = text.indexOf(":");
      if (at < 0) return;
      const scale = rankScaleLabelJa(text.slice(0, at)).toLowerCase();
      const grade = text.slice(at + 1).trim();
      parts.push(scale);
      if (RANK_ABSENT_GRADES.indexOf(grade.toLowerCase()) >= 0) {
        parts.push(RANK_UNRATED_LABEL_JA);
        parts.push(`${scale}${RANK_UNRATED_LABEL_JA}`);
        return;
      }
      parts.push(grade.toLowerCase());
      parts.push(`${scale} ${grade.toLowerCase()}`);
      /* 画面はこの等級を「ランク」とも呼ぶ（列の見出し・選択欄のラベル・早め絞り込みのボタンが
       * `A*ランク`。2026-08-09 生成のビルドで実測: ボタンの語どおり `A*ランク` と打つと 0 件、
       * 半角スペースを挟んだ `A* ランク` も 0 件で、`A*` 単体の 156 件に出会えなかった）。
       * 「表示している語で検索できる」をこの関数の不変条件にしているので、画面が書く語の形も
       * ここに寄せる（`評価` はてびき・件数欄・印刷の注記で同じ等級に使う語）。 */
      parts.push(`${grade.toLowerCase()}ランク`, `${grade.toLowerCase()}評価`);

      parts.push(`${grade.toLowerCase()}類`, `${grade.toLowerCase()}クラス`);

      parts.push(`クラス${grade.toLowerCase()}`);
      hasGrade = true;
    });
    /* 等級を持つ行に限って、単独の「ランク」「評価」も通す。半角スペースを挟んで
     * `A* ランク` と打つ人（`ランク A*` の語順の逆）が、同じ行に出会えるようにするため。
     * 評価の無い行まで広げると、「ランク」で全件が返って語の意味が薄くなる。 */
    if (hasGrade) parts.push("ランク", "評価", "類", "クラス");
    return parts.join(" ");
  }

  /* 会場表記にオンライン参加の記述があるか。出張できないときの参加手段は実務上よく見る
   * 条件だが、表記はdataの文字列に依存する（「会場名／オンライン」「〜 & Virtual」など）。
   * 対面かどうかは**判定しない**（書かれていないことから参加形式は推定できない）。
   * `Virtual Conference Center` のように会場名そのものに語が含まれる場合は除外する。 */
  // 比較側は `kanaFold` 済み（カタカナはひらがなに畳まれ、小さな仮名も伸びる）なので、
  // 照合語も同じ形にしておく（「オンライン」は「おんらいん」になる）。
  const ONLINE_TERMS_JA = ["オンライン", "ハイブリッド"].map((term) => kanaFold(term));
  /* 対面とオンラインの併用（hybrid）もオンライン参加ができるので対象に含める。
   * 英語側に入れていなかったため `Málaga, Spain (hybrid)`（GECCO など収録 20 行）が
   * 「オンライン参加可のみ」から落ちていた（2026-09-23 実測。日本語表記の `ハイブリッド` は
   * 上の語列表で拾えていたので、英語表記だけ漏れる不整合だった）。 */
  const ONLINE_TERMS_EN = ["online", "virtual", "hybrid"];
  // 会場名の一部として現れる句（2026-09-22 の実データ `San Francisco Bay, USA and KSIR
  // Virtual Conference Center, USA` で誤って online 扱いになった）。
  const ONLINE_VENUE_FALSE_POSITIVES = ["virtual conference center"];

  function conferenceNameSearchTerms(conf: ConferenceRecord): string {
    const name = [conf.title, conf.full_name, conf.acronym]
      .filter(Boolean)
      .join(" ")
      .normalize("NFKC");
    let host = "";
    try {
      host = new URL(String(conf.link || "")).hostname.toLowerCase();
    } catch (_) {}
    const domainIs = (domain: string): boolean => host === domain || host.endsWith(`.${domain}`);
    const words: string[] = [];
    if (/(?:\bipsj\b|情報処理学会)/i.test(name) || domainIs("ipsj.or.jp"))
      words.push("IPSJ ipsj.or.jp");
    if (/(?:\bieice\b|電子情報通信学会)/i.test(name) || domainIs("ieice.org"))
      words.push("IEICE ieice.org");
    return words.join(" ");
  }

  /* チェックボックスの語「国内研究会」も検索の語として引けるようにする。行の名前には
   * 「研究会」としか書かれず、「国内」はタグ側の情報なので複合語では当たらない
   * （実測）。
   * 語はその行に本当に当てはまるときだけ入れる。`国内シンポジウム` と
   * `国内ワークショップ` は名前にその語がある行だけで、2026-09-23 の収録では
   * domestic-jp の行にどちらも含まれていなかったので、条件を満たす行が増えた日に効く。 */
  function domesticFacetSearchTerms(
    tags: readonly string[] | null | undefined,
    title: unknown,
  ): string {
    if ((tags || []).indexOf("domestic-jp") < 0) return "";
    const name = String(title || "");
    const words: string[] = [];
    if (name.indexOf("研究会") >= 0) words.push("国内研究会");
    if (name.indexOf("シンポジウム") >= 0) words.push("国内シンポジウム");
    if (name.indexOf("ワークショップ") >= 0) words.push("国内ワークショップ");
    return words.join(" ");
  }

  /* 「オンライン参加可」はチェックボックスに出る語（=表示語）なので、ここで1回だけ書き、
   * 検索の語・行の検索用文字列・おしらせで同じ字面を使う。 */
  const ONLINE_PARTICIPATION_LABEL_JA = "オンライン参加可";

  /* 「オンライン参加可」はチェックボックスの語なので、検索の語としても引けるようにする
   * （`国内` を hay に入れるのと同じ流儀）。判定はチェックボックスと同じ
   * `placeOffersOnline` だけを使う（別実装を書くと、チェックで出る行と検索で出る行がズレる）。
   * 語を1つ入れておけば `オンライン参加` `参加可` も部分一致で引ける。 */
  function participationSearchTerms(value: unknown): string {
    return placeOffersOnline(value) ? ONLINE_PARTICIPATION_LABEL_JA : "";
  }

  /* 早め絞り込みのボタン（プリセット）。**自分の担当する条件だけ**を出し入れする切り替えに
   * する。以前は押すたびに検索語・種別・推定まで初期値へ戻し、点灯も「その条件だけで
   * 画面が埋まっているとき」だけだった（2026-09-23 実測: `スパコン` と打った後に
   * 「オンライン参加可」を押すと検索語が消えてのぞく前の 15 件になり、押されているはずの
   * ボタンは点かない。押した意味が分からず、もう一度押すと再び全件に戻る）。
   * 押した条件だけが戻ること、押されている条件が点いていること、もう一度押して
   * 外せることが、ボタンの最低限の約束。 */
  const PRESET_TARGETS: Record<string, PresetSelection> = {
    "7d": { win: "7d", rank: "", cats: [], domestic: false, online: false },
    a_star: { win: "all", rank: "A*", cats: [], domestic: false, online: false },
    hpc_sys: { win: "all", rank: "", cats: ["hpc", "systems"], domestic: false, online: false },
    domestic: { win: "all", rank: "", cats: [], domestic: true, online: false },
    online: { win: "all", rank: "", cats: [], domestic: false, online: true },
  };

  /* そのボタンの担当する条件が入っているか（点灯の正）。検索語など他の条件は見る必要が
   * 無い — 条件を足した画面でも「押されている」ことは分からないといけない。 */
  function presetIsActive(preset: unknown, current: PresetSelection | null): boolean {
    const target = PRESET_TARGETS[typeof preset === "string" ? preset : ""];
    if (!target || !current) return false;
    if (target.win !== "all" && current.win !== target.win) return false;
    if (target.rank && current.rank !== target.rank) return false;
    if (target.domestic && !current.domestic) return false;
    if (target.online && !current.online) return false;
    if (target.cats.length) {
      const held = current.cats.slice().sort().join(",");
      if (held !== target.cats.slice().sort().join(",")) return false;
    }
    return Boolean(
      target.win !== "all" || target.rank || target.domestic || target.online || target.cats.length,
    );
  }

  /* 押した結果の状態を返す（入力の正本を app 側に置いたまま、出し入れの規則だけをここで持つ）。
   * 未知のボタン名は何もしない（ボタンを増やして表を忘れたときに、状態を壊さない）。 */
  function presetNextSelection(preset: unknown, current: PresetSelection | null): PresetSelection {
    const base: PresetSelection = {
      win: current ? current.win : "all",
      rank: current ? current.rank : "",
      cats: current ? current.cats.slice() : [],
      domestic: current ? current.domestic : false,
      online: current ? current.online : false,
    };
    const target = PRESET_TARGETS[typeof preset === "string" ? preset : ""];
    if (!target) return base;
    const on = presetIsActive(preset, current);
    return {
      win: target.win !== "all" ? (on ? "all" : target.win) : base.win,
      rank: target.rank ? (on ? "" : target.rank) : base.rank,
      cats: target.cats.length ? (on ? [] : target.cats.slice()) : base.cats,
      domestic: target.domestic ? !base.domestic : base.domestic,
      online: target.online ? !base.online : base.online,
    };
  }

  function placeOffersOnline(value: unknown): boolean {
    let text = kanaFold(searchNormalize(value));
    if (!text) return false;
    for (const phrase of ONLINE_VENUE_FALSE_POSITIVES) text = text.split(phrase).join(" ");
    for (const term of ONLINE_TERMS_JA) if (text.indexOf(term) >= 0) return true;
    for (const term of ONLINE_TERMS_EN) if (text.indexOf(term) >= 0) return true;
    return false;
  }

  /* プリセットボタンが担当する条件。検索語・締切種別・推定・過去表示は**ここで扱わない**
   * （ボタンが利用者の入力を消さないための型）。 */
  type PresetSelection = {
    win: string;
    rank: string;
    cats: string[];
    domestic: boolean;
    online: boolean;
  };

  function placeJa(value: unknown): string {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return "";
    // 置換は各 "/" 区切りの末尾カンマ句に限定する。国名・開催形式はそこに来る。
    // 先頭側（会場名・都市名）を置換すると "Panama City, Panama" が
    // 「パナマ City」に化けて場所を特定できなくなる。
    return raw
      .split("/")
      .map((segment) => {
        const at = segment.lastIndexOf(",");
        if (at < 0) return placeTermJa(segment);
        return segment.slice(0, at + 1) + placeTermJa(segment.slice(at + 1));
      })
      .join("/");
  }

  /* 締切の公式表記（tz_raw）を、日本側で注記する簡潔な形に寄せる。
   * AoE 併記は「AoE で締切る会議」にしか意味がない。JST 宣言の国内締切に
   * AoE を併記すると、実在しない AoE 締切があると誤解させる。
   * 未知の値はそのまま返す（推測して JST/UTC に寄せない）。 */
  function officialZone(dl: unknown): string {
    const raw = dl && isRecord(dl) ? String((dl as DeadlineRecord).tz_raw || "") : "";
    const norm = raw.toUpperCase().replace(/\s/g, "");
    if (!norm) return "";
    if (norm.indexOf("AOE") >= 0) return "AoE";
    if (norm === "JST" || norm === "ASIA/TOKYO") return "JST";
    if (norm === "UTC+9" || norm === "UTC+09" || norm === "+09:00" || norm === "GMT+9")
      return "JST";
    if (norm === "UTC" || norm === "Z" || norm === "UTC+0" || norm === "UTC+00:00") return "UTC";
    return raw.trim();
  }

  /** Shared candidate-to-row boundary for browser rendering and offline ranking. */
  function candidateRows(data: unknown): CandidateRow[] {
    const out: CandidateRow[] = [];
    const source = isRecord(data) && Array.isArray(data.conferences) ? data.conferences : data;
    const conferences = Array.isArray(source) ? source.filter(isConference) : [];
    conferences.forEach((conf) => {
      (conf.editions || []).forEach((ed) => {
        const rankPairs: string[] = [];
        const rank = conf.rank || {};
        Object.keys(rank).forEach((name) => {
          if (rank[name]) rankPairs.push(`${name}:${rank[name]}`);
        });
        const confTags = conf.tags || [];
        const baseHay = [
          conf.title,

          titleWithYearJa(conf.title || conf.key || "", ed.year),
          conf.full_name,
          conferenceNameSearchTerms(conf),
          conf.key,
          ed.place,
          eventSourceSearchText(ed),
          linkSearchTerms(ed.link),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        const catHay = `${laterEditionSearchWords(conf, String(ed.event_start || ""), ed.id)} ${categorySearchTerms(conf.categories, confTags)} ${placeJa(ed.place)} ${placePrefectureJa(ed.place)} ${participationSearchTerms(ed.place)} ${domesticFacetSearchTerms(confTags, conf.title)}`;
        (ed.deadlines || []).forEach((dl) => {
          const dateOnly = dl.precision === "date-only";
          const window = dateOnly ? dateOnlyWindowMs(dl.local_date) : null;
          const t = dateOnly
            ? (parsedInstant(dl.earliest_utc) ?? window?.start ?? Number.NaN)
            : (parsedInstant(dl.utc ?? dl.at_utc) ?? Number.NaN);
          const tLast = dateOnly ? (parsedInstant(dl.latest_utc) ?? window?.end ?? Number.NaN) : t;
          if (!Number.isFinite(t) || !Number.isFinite(tLast)) return;
          /* 幅を持つ行（時刻未確認）は、`t` が「最も早い締め時刻」なので、これを並びと
           * 残りの基準に使うと、同じ行の日付欄より 1〜2 日早く並んでしまう
           * （2026-09-23 実測: 既定画面で表示暦日が戻る隣接ペア 27 件。例 08-15 の後に
           * 08-14 が来る。残りも日付欄より 1 日少ない値になった）。
           * そこで **画面に出している暦日（JST の正午）**を別の基準として持つ。
           * 終了したかどうかの判定は従来の幅（`t` / `tLast`）のまま – 「表示した日より
           * 前に終わっている可能性がある」という約束はそこが担っている。 */
          const tShown = dateOnly ? jstNoonMs(dl.local_date, t) : t;
          /* 会期の並び順の基準。会期は時刻を持たないので、画面と同じ暦日の正午に置く。
           * 未確認（`ed.event_start` が無い・読めない）は NaN のままにして、並びでは
           * 末尾に寄せる（画面の「未確認」と同じ意味）。 */
          const tEvent = jstNoonMs(String(ed.event_start || ""), Number.NaN);
          const cellWords = deadlineCellSearchWords(dl, t, dateOnly);
          const officialWords = officialDateSearchWords(dl, t, dateOnly);

          const shiftWords = deadlineShiftSearchWords(dl);
          out.push({
            conf,
            ed,
            dl,
            kind: dl.kind || "other",
            est: !!ed.estimated,
            t,
            tShown,
            tLast,
            tEvent,
            dateOnly,
            localDate: dateOnly ? String(dl.local_date || "") : "",
            cats: conf.categories || [],
            tags: conf.tags || [],
            rankPairs,
            hay: searchNormalize(
              `${baseHay} ${dl.label || ""} ${dl.kind || ""} ${kindLabelJa(dl.kind)} ${statusBadgeWords(ed, dl).join(" ")} ${roundSearchTerms(dl.round).join(" ")} ${unconfirmedHayJa({ kind: dl.kind || "", ed, rankPairs })} ${rankSearchTerms(rankPairs)} ${catHay} ${tagSearchTerms(confTags)} ${monthTermsJa(dateOnly ? dl.local_date : t)} ${dayTermsJa(dateOnly ? dl.local_date : t)} ${ed.event_date_precision === "not-announced" ? "" : `${monthTermsJa(ed.event_start)} ${monthTermsJa(ed.event_end)}`} ${weekdaySearchTerms(
                dateOnly ? dl.local_date : t,
              )} ${zoneSearchWords(dl, dateOnly)} ${cellWords} ${officialWords} ${shiftWords} ${eventDaySearchWords(
                {
                  ed,
                },
              )}`,
            ),
            dupLabel: dl.comment || "",
          });
        });
      });
    });
    return out;
  }

  /* 論文モード・常時受付用: 常時受付ジャーナル（tag: journal で締切なし）の行を合成する。
   * 特集号（締切付き）は通常の締切行で扱うため除外する。 */
  function journalRows(confs: unknown, now: number): CandidateRow[] {
    const out: CandidateRow[] = [];
    const safeConfs = Array.isArray(confs)
      ? confs.map(normalizeConference).filter((conf): conf is ConferenceRecord => conf !== null)
      : [];
    safeConfs.forEach((conf) => {
      const tags = conf.tags || [];
      if (tags.indexOf("journal") === -1) return;
      const hasDl = (conf.editions || []).some((edition) => Boolean(edition.deadlines?.length));
      if (hasDl) return;
      const pairs: string[] = [];
      const rank = conf.rank || {};
      if (Object.keys(rank).length) {
        Object.keys(rank).forEach((rk) => {
          if (rank[rk]) {
            pairs.push(`${rk}:${rank[rk]}`);
          }
        });
      }
      const baseHay = [
        conf.title,
        conf.full_name,
        conferenceNameSearchTerms(conf),
        conf.key,
        NOT_APPLICABLE_LABEL_JA,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const cats = conf.categories || [];
      out.push({
        conf: conf,

        ed: { place: "", date_text: "", id: conf.key },
        dl: { label: "", round: 1 },
        kind: "journal",
        est: false,
        t: now,
        tShown: now,
        tLast: now,
        // 常時受付のジャーナルに会期は無い（未確認の形にする）。
        tEvent: Number.NaN,
        cats: cats,
        tags: tags,
        rankPairs: pairs,
        hay: searchNormalize(
          `${baseHay} journal 常時受付 ${unconfirmedHayJa({
            kind: "journal",
            ed: { place: "", event_start: "" },
            rankPairs: pairs,
          })} ${categorySearchTerms(cats, tags)} ${tagSearchTerms(tags)}`,
        ),
        name: conf.title,
        year: null,
      });
    });
    return out;
  }

  /**
   * 会期情報があり、投稿締切が未収録の回を一覧にする。締切一覧の表は締切行でできており、
   * これらの回は `upcoming.md` にしか出ない。検索で引っ掛けて「次回の開催」を案内できる
   * ようにするのが目的なので、`candidateRows` と同じ検索要素（分類・開催地・都道府県・月・
   * タグ）を同じヘルパーで組み立てる。
   */
  function scheduleOnlyEditions(data: unknown): ScheduleOnlyEdition[] {
    const out: ScheduleOnlyEdition[] = [];
    const source = isRecord(data) && Array.isArray(data.conferences) ? data.conferences : data;
    const conferences = Array.isArray(source) ? source.filter(isConference) : [];
    conferences.forEach((conf) => {
      const confTags = conf.tags || [];
      const baseHay = [conf.title, conf.full_name, conferenceNameSearchTerms(conf), conf.key]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      (conf.editions || []).forEach((ed) => {
        if (ed.estimated || (ed.deadlines || []).length || (ed.schedule_deadlines || []).length)
          return;
        const segments = Array.isArray(ed.event_segments) ? ed.event_segments : [];
        const start = String(ed.event_start || segments[0]?.start || "");
        const end = String(ed.event_end || segments.at(-1)?.end || start);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) && ed.event_date_precision !== "not-announced")
          return;
        out.push({
          key: String(conf.key || ""),
          name: String(conf.title || conf.key || ""),
          year: ed.year,
          link: String((ed as { link?: string }).link || (conf as { link?: string }).link || ""),
          place: String(ed.place || ""),
          eventStart: start,
          eventEnd: end,
          eventDatePrecision: ed.event_date_precision,
          eventSegments: segments,
          rankPairs: Object.entries(conf.rank || {}).map(([source, grade]) => `${source}:${grade}`),
          cats: conf.categories || [],
          tags: confTags,
          hay: searchNormalize(
            /* 会期だけの行も、公式ページの URL で引けるようにする（上の締切行と同じ理由）。 */
            `${baseHay} ${titleWithYearJa(conf.title || conf.key, ed.year)} ${ed.place || ""} ${eventSourceSearchText(ed)} ${linkSearchTerms(ed.link)} ` +
              `${categorySearchTerms(conf.categories, confTags)} ${tagSearchTerms(confTags)} ` +
              `${placeJa(ed.place)} ${placePrefectureJa(ed.place)} ` +
              `${ed.event_date_precision === "not-announced" ? "" : `${monthTermsJa(start)} ${monthTermsJa(end)}`} ${["month-only", "not-announced"].includes(String(ed.event_date_precision)) ? "" : weekdaySearchTerms(start)} ${eventDaySearchWords({ ed })}`,
          ),
        });
      });
    });
    return out;
  }

  /* 論文モード用: 未来の投稿締切（abstract/paper）を持たない会議に限り、
   * 直近の過去投稿締切を 1 行だけ返す（RTSS 等「次回未発表」の会議を推薦圏に残す）。
   * 推定の過去行・開催イベント行は除外する。 */
  function pastRepresentatives(rows: readonly CandidateRow[], now: number): CandidateRow[] {
    const byKey: Record<string, CandidateRow> = {};
    const hasFuture: Record<string, boolean> = {};
    rows.forEach((r) => {
      if (r.kind !== "abstract" && r.kind !== "paper") return;
      const k = r.conf?.key;
      if (!k) return;
      if (rowIsFuture(r, now)) hasFuture[k] = true;
      if (!rowIsFuture(r, now) && !r.est && (!byKey[k] || r.t > byKey[k].t)) byKey[k] = r;
    });
    const out: CandidateRow[] = [];
    Object.keys(byKey).forEach((k) => {
      if (!hasFuture[k]) out.push(byKey[k]);
    });
    return out;
  }

  /** Retain collected venues without a usable submission date; never invent a deadline. */
  function undatedVenueRows(confs: unknown, represented: readonly CandidateRow[]): CandidateRow[] {
    const keys = new Set(
      represented.flatMap((row) => [
        row.conf.key,
        ...(row.submission?.sourceRecords ?? []).map((record) => record.venueKey),
      ]),
    );
    const safeConfs = Array.isArray(confs)
      ? confs.map(normalizeConference).filter((conf): conf is ConferenceRecord => conf !== null)
      : [];
    return safeConfs
      .filter((conf) => !keys.has(conf.key))
      .map((conf) => {
        const ed = [...(conf.editions ?? [])]
          .filter((edition) => !edition.estimated && !("estimate" in edition && edition.estimate))
          .sort((a, b) => Number(b.year ?? 0) - Number(a.year ?? 0))[0] ?? { id: conf.key };
        return {
          conf,
          ed,
          dl: {},
          kind: "venue",
          est: false,
          t: Number.NaN,
          tShown: Number.NaN,
          tLast: Number.NaN,
          tEvent: jstNoonMs(ed.event_start, Number.NaN),
          cats: conf.categories ?? [],
          tags: conf.tags ?? [],
          rankPairs: Object.entries(conf.rank ?? {}).map(([name, grade]) => `${name}:${grade}`),
          hay: searchNormalize([conf.title, conf.full_name, conf.key].filter(Boolean).join(" ")),
          name: conf.title,
          year: ed.year ?? null,
        };
      });
  }

  /** Keep every collected venue while distinguishing known submission dates from missing dates. */
  function candidatePool(
    rows: readonly CandidateRow[],
    conferences: unknown,
    now: number,
  ): CandidateRow[] {
    const submissions = rows.filter((row) => row.kind === "paper" || row.kind === "abstract");
    const dated = submissions
      .filter((row) => !deadlineRowIsPast(row, now))
      .concat(journalRows(conferences, now), pastRepresentatives(submissions, now));
    return dated.concat(undatedVenueRows(conferences, dated));
  }

  function rowDateOnlyState(
    row: CandidateRow | null | undefined,
    now: number,
  ): "definitely-future" | "uncertain-on-date" | "definitely-past" | null {
    if (!row?.dateOnly) return null;
    if (now < row.t) return "definitely-future";
    if (now <= (row.tLast || row.t)) return "uncertain-on-date";
    return "definitely-past";
  }

  function rowIsFuture(row: CandidateRow | null | undefined, now: number): boolean {
    return row?.dateOnly
      ? rowDateOnlyState(row, now) !== "definitely-past"
      : Boolean(row && row.t >= now);
  }

  /* 論文モード: 会議単位に代表行を選ぶ。
   * 締切行優先 → 未来締切優先 → 早い締切 / 直近の過去。 */
  function pickRepresentative(rows: readonly CandidateRow[], now: number): CandidateRow[] {
    const DAY = 86400000;
    const byKey: Record<string, CandidateRow> = {};
    const isFuture = (r: CandidateRow) =>
      r.kind === "event" ? now < (r.tLast || r.t) + DAY : rowIsFuture(r, now);
    rows.forEach((r) => {
      const k = r.conf && (r.conf.key || "");
      if (!k) return;
      const cur = byKey[k];
      if (!cur) {
        byKey[k] = r;
        return;
      }
      if (cur.kind === "event" && r.kind !== "event") {
        byKey[k] = r;
        return;
      }
      if (r.kind === "event" && cur.kind !== "event") {
        return;
      }
      const cf = isFuture(cur),
        rf = isFuture(r);
      if (cf !== rf) {
        if (rf) byKey[k] = r;
        return;
      }
      if (cf ? r.t < cur.t : r.t > cur.t) byKey[k] = r;
    });
    return Object.keys(byKey).map((k) => byKey[k]);
  }

  /* 論文モードの並び: 適合度が第一、同点なら未来締切 → 常時受付ジャーナル → 過去締切。 */
  function comparePapers(a: CandidateRow, b: CandidateRow, now: number): number {
    if ((b._matchScore ?? 0) !== (a._matchScore ?? 0)) {
      return (b._matchScore ?? 0) - (a._matchScore ?? 0);
    }
    const DAY = 86400000;
    const aFut = a.kind === "event" ? now < (a.tLast || a.t) + DAY : rowIsFuture(a, now);
    const bFut = b.kind === "event" ? now < (b.tLast || b.t) + DAY : rowIsFuture(b, now);
    if (aFut !== bFut) {
      return aFut ? -1 : 1;
    }
    // 未来締切の会議をジャーナルより優先（締切がある方が行動可能）
    const aJ = a.kind === "journal";
    const bJ = b.kind === "journal";
    if (aJ !== bJ) {
      return aJ ? 1 : -1;
    }
    /* 時刻の無い行（常時受付など）は上で既に後方へ寄せているが、同士どうしの比較は
     * NaN になる（`NaN - NaN` は並びの向きを決めない。app.ts の compareDeadlineRows と
     * 同じ理由で、入力の順によって並びが変わる）。数値へ寄せてから引く。 */
    const at = Number.isFinite(a.t) ? a.t : 0;
    const bt = Number.isFinite(b.t) ? b.t : 0;
    return at - bt;
  }

  /* 掲載先タグが属するカテゴリを全会議から推定する。
   * 例: lines の venue="RTSS" が systems カテゴリの会議に一致 → ["systems"]。 */
  function venueCategories(lines: readonly PaperRecord[], rows: readonly CandidateRow[]): string[] {
    const out: Record<string, boolean> = {};
    lines.forEach((p) => {
      if (!p.venue) return;
      const nv = normKey(p.venue);
      if (nv.length <= 2) return;
      rows.forEach((r) => {
        const c = r.conf || {};
        const hay = [normKey(c.key), normKey(c.title), normKey(c.full_name)].filter(Boolean);
        const hit = hay.some((h) => h && (h.indexOf(nv) !== -1 || nv.indexOf(h) !== -1));
        if (hit)
          r.cats.forEach((k) => {
            out[k] = true;
          });
      });
    });
    return Object.keys(out);
  }

  /* 掲載先に入れた語が、いま締切の並んでいる行の会議に見当たらないことを数える。
   * 「入力の例」は掲載先まで打ち替えてくれる（2026-08-09 生成ビルドの実測で、例の 1 件は
   * 掲載先を `IEEE RTSS` と指定する）が、その会議の締切が今は出ていないことがある
   * （同じビルドで実測: 検索対象 863 行に RTSS は 0 行）。候補はタイトルとキーワードから
   * 別に出るので、画面は動いているのに「例が教えた掲載先だけが黙って消えた」状態になる。
   * 一致の見方は `venueCategories` と揃える（書き分けると絞り込みと案内で答えが違ってしまう）。 */
  function unmatchedVenues(lines: readonly PaperRecord[], rows: readonly CandidateRow[]): string[] {
    const out: string[] = [];
    lines.forEach((p) => {
      const text = typeof p.venue === "string" ? p.venue.trim() : "";
      if (!text) return;
      const nv = normKey(text);
      if (nv.length <= 2) return;
      if (out.indexOf(text) !== -1) return;
      const matchesName = rows.some((r) => {
        const c = r.conf || {};
        return [normKey(c.key), normKey(c.title), normKey(c.full_name)]
          .filter(Boolean)
          .some((h) => h.indexOf(nv) !== -1 || nv.indexOf(h) !== -1);
      });
      /* 名前で当たらなくても、行の検索文で当たるなら「見当たらない」とは書かない。
       * ここは出さないことが正で、出すときは誤りがあってはいけない側なので、
       * 緩く寄せる（2026-08-09 生成ビルドで実測: 掲載先「情報処理学会」は名前の照合でも
       * 11 行に当たるので不要だったが、和名が略称にしか入っていない行で誤る余地を消す）。 */
      const matchesHay = matchesName ? false : rowHayMatcher(text, rows);
      if (!matchesName && !matchesHay) out.push(text);
    });
    return out;
  }

  /* 掲載先に入れた語が行に見当たらなかったことを、人の読む文で返す（空欄のとき空文字）。
   * 文をここに置くのは、built の成果物から検査できるようにするため（「評価なし」などの
   * 画面の語をこのファイルが持っているのと同じ置き方）。区切りは UI 側が足す。 */
  /* 掲載先に入れた語で行が引けるか（1 語について 1 回だけ照合式を作る）。 */
  function rowHayMatcher(venue: string, rows: readonly CandidateRow[]): boolean {
    const match = searchMatcher(venue);
    return rows.some((r) => match(r.hay));
  }

  function venueLookupNoticeJa(venues: readonly string[]): string {
    if (venues.length === 0) return "";
    return (
      `掲載先に入れた${venues.map((v) => `「${v}」`).join("・")}は、` +
      "いま締切が並んでいる会議に見当たりません（収録していないか、まだ締切が出ていません）。" +
      "候補はタイトル・キーワードから出しています"
    );
  }

  function breakdown(
    r: unknown,
    lines: readonly PaperRecord[],
    useFielded = false,
  ): ScoreBreakdown {
    const row = normalizeCandidateLike(r);
    if (!row)
      return {
        score: 0,
        topicScore: 0,
        venueScore: 0,
        venueHit: false,
        perLine: [],
        evidence: [],
        agg: { domain: 0, name: 0, paper: 0, jp: 0, tags: 0, venue: 0 },
        fieldScores: emptyFieldScores(),
      };
    const conf = confHay(row);
    const weights = paperWeights(lines);
    const perLine: LineEvidence[] = [];
    const agg: SignalScores & { venueName?: number } = {
      domain: 0,
      name: 0,
      paper: 0,
      jp: 0,
      tags: 0,
      venue: 0,
    };
    const fieldScores = emptyFieldScores();
    for (let i = 0; i < lines.length; i++) {
      const s = scoreLine(row, lines[i], conf, useFielded);
      const weight = weights[i] || { role: "reference", weight: 0 };
      perLine.push({
        score: s.score,
        role: weight.role,
        weight: weight.weight,
        venueHit: s.venueHit,
        details: s.details,
        fieldScores: s.fieldScores,
      });
      if (!weight.weight) continue;
      (Object.keys(s.details) as Array<keyof SignalScores>).forEach((key) => {
        if (key !== "venue") agg[key] += s.details[key] * weight.weight;
      });
      (Object.keys(s.fieldScores) as FieldName[]).forEach((key) => {
        fieldScores[key] += s.fieldScores[key] * weight.weight;
      });
    }
    const venue = venueEvidence(perLine, lines);
    agg.venue = venue.priorVenue;
    const topicScore = scorePapers(row, lines, useFielded);
    const signalEvidence: SignalEvidence[] = [];
    const evidenceTypes: Record<string, string> = {
      domain: "domain",
      name: "venue-name",
      paper: "accepted-paper",
      jp: "venue-name",
      tags: "topic-tag",
      venue: "prior-venue",
    };
    (Object.keys(evidenceTypes) as Array<keyof SignalScores>).forEach((kind) => {
      if (agg[kind] > 0)
        signalEvidence.push({ type: evidenceTypes[kind], contribution: agg[kind] });
    });
    const venueName = agg.name;
    agg.name += agg.paper;
    agg.venueName = venueName;
    return {
      score: topicScore + venue.priorVenue,
      topicScore: topicScore,
      venueScore: venue.score,
      venueHit: venue.venueHit,
      perLine: perLine,
      evidence: venue.evidence,
      signalEvidence: signalEvidence,
      agg: agg,
      fieldScores,
    };
  }

  /* Venue-level retrieval: fuse positive paper evidence by reciprocal rank.
   * K=60 keeps one evidence line close to its existing score while rewarding
   * independent matching lines. A tagged venue retains its absolute +venue signal. */
  function venueEvidence(perLine: readonly LineEvidence[], lines: readonly PaperRecord[]) {
    const evidence: Array<LineEvidence & { lineIndex: number; key: string }> = perLine
      .map((line, index): LineEvidence & { lineIndex: number; key: string } => ({
        lineIndex: index,
        score: line.score * (line.weight === undefined ? 1 : line.weight),
        weight: line.weight === undefined ? 1 : line.weight,
        venueHit: line.venueHit,
        details: line.details,
        fieldScores: line.fieldScores,
        role: line.role,
        key: [lines?.[index]?.title, lines?.[index]?.keywords, lines?.[index]?.venue]
          .map((value) => String(value || "").toLowerCase())
          .join("\u0000"),
      }))
      .filter((line) => line.weight > 0 && (line.score > 0 || line.venueHit))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.key < b.key) return -1;
        if (a.key > b.key) return 1;
        return a.lineIndex - b.lineIndex;
      });
    const k = 60;
    let fused = 0;
    let venueHit = false;
    evidence.forEach((line, index) => {
      fused += line.score / 100 / (k + index + 1);
      if (line.venueHit) venueHit = true;
      line.rank = index + 1;
    });
    const publicEvidence: LineEvidence[] = evidence.map(({ key: _key, ...line }) => line);
    const score = Math.round(100 * k * fused);
    const priorVenue = venueHit ? SIG_WEIGHTS.venue : 0;
    return {
      score: Math.min(100, score + priorVenue),
      priorVenue: priorVenue,
      venueHit: venueHit,
      evidence: publicEvidence,
    };
  }

  const CONFIDENCE_TOPIC_MIN = 40;
  const CONFIDENCE_SUFFICIENT_MIN = 55;
  const CONFIDENCE_MARGIN_MIN = 10;
  let rerankerModel: LinearRerankerModel | null = null;

  function setReranker(value: unknown) {
    rerankerModel = isValidRerankerModel(value) ? value : null;
  }

  function rerankerFeatures(
    entry: RecommendationEntry,
    lines: readonly PaperRecord[],
  ): RerankerFeatures {
    const languageMatch =
      lines.some((line) => hasJapanese(paperText(line))) ===
      hasJapanese(`${entry.row.conf.title ?? ""} ${entry.row.conf.full_name ?? ""}`)
        ? 1
        : 0;
    return {
      lexical_score: entry.lexicalScore / 100,
      semantic_score: entry.semantic / 100,
      category_overlap: entry.boosted ? 1 : 0,
      venue_name_evidence: (entry.match.agg?.name ?? 0) > 0 ? 1 : 0,
      prior_venue: entry.match.venueHit ? 1 : 0,
      language_match: languageMatch,
      venue_kind: ["paper", "journal", "venue"].includes(entry.row.kind) ? 1 : 0,
    };
  }

  function rerankerProbability(features: RerankerFeatures): number {
    const weights = rerankerModel?.weights ?? {};
    const z = RERANKER_FEATURE_SCHEMA.reduce(
      (sum, name) => sum + (weights[name] ?? 0) * features[name],
      rerankerModel?.intercept ?? 0,
    );
    const calibration = rerankerModel?.calibration;
    const calibrated =
      calibration?.method === "platt" && Number.isFinite(calibration.slope)
        ? calibration.slope * z + calibration.intercept
        : z;
    return 1 / (1 + Math.exp(-calibrated));
  }

  function confidenceState(evidenceStrength: number, margin: number): Confidence {
    if (!Number.isFinite(evidenceStrength) || evidenceStrength < CONFIDENCE_TOPIC_MIN)
      return "insufficient";
    if (evidenceStrength < CONFIDENCE_SUFFICIENT_MIN || margin < CONFIDENCE_MARGIN_MIN)
      return "ambiguous";
    return "sufficient";
  }

  /* カードの chips に出る語（`一致評価 <語> ▾`）。以前の「情報不足」は、論文を最後まで
   * 入力してもほぼ全ての行に出た（2026-09-23 実測: 概要・キーワードまで入れた入力で
   * 画面に出る 25 件のうち 23 件、意味検索の得点を足しても 122 件のうち 120 件が同じ語）。
   * 「論文の情報が足りない」と読める語で、実際に測った人がそこで入力をやめる恐れがある。
   * 実体は max(言葉の一致, 意味検索の近さ) が閾値に届かないことなので、その意味の語に
   * 変える（一覧の別の案内がすでに「重なる投稿先」という語を使っているので揃える）。
   * 「十分な一致」は精度保証が取れるまで出さない（上の定数コメント参照）。 */
  function fitLabel(confidence: Confidence): string {
    if (confidence === "sufficient") return "十分な一致";
    if (confidence === "ambiguous") return "候補";
    return "重なりうすい";
  }

  function availability(row: CandidateRow | null | undefined, now: number): Availability {
    const time = row && !row.dateOnly && Number.isFinite(row.t) ? row.t : null;
    const dateState = rowDateOnlyState(row, now);
    const future =
      row && row.kind === "journal"
        ? true
        : row && row.kind === "event"
          ? now < (row.tLast || row.t) + 86400000
          : rowIsFuture(row, now);
    return {
      kind: row?.kind || "unknown",
      status:
        row && row.kind === "journal"
          ? "ongoing"
          : !row || !Number.isFinite(row.t)
            ? "unknown"
            : dateState === "uncertain-on-date"
              ? "uncertain"
              : future
                ? "open"
                : "past",
      timestamp: time,
      local_date: row?.dateOnly ? (row.localDate ?? null) : null,
      date_state: dateState,
      estimated: !!row?.est,
    };
  }

  /* Fuse candidate ranks once per venue. Deadline rows are availability records,
   * not independent fit votes. */
  function venueRecommendations(
    rows: readonly unknown[],
    lines: readonly PaperRecord[],
    semanticScores: Record<string, number> | null,
    now: number,
    options: RecommendationOptions = {},
  ): RecommendationResult[] {
    const groups: Record<string, CandidateRow[]> = {};
    const opts = options || {};
    const safeNow = Number.isFinite(now) ? now : Date.now();
    const retrievalLines = opts.semanticSimilarities
      ? lines.map((line) => ({
          ...line,
          title: `${line.title} ${expandJp(line.title, true)}`.trim(),
          abstract: `${line.abstract || ""} ${expandJp(line.abstract, true)}`.trim(),
          keywords: `${line.keywords || ""} ${expandJp(line.keywords, true)}`.trim(),
        }))
      : lines;
    rows.map(normalizeCandidateLike).forEach((row) => {
      if (!row) return;
      const key = normKey(row.conf.key);
      if (key) {
        const group = groups[key] || [];
        groups[key] = group;
        group.push(row);
      }
    });
    const entries: RecommendationEntry[] = Object.keys(groups).map((key) => {
      const row = pickRepresentative(groups[key], safeNow)[0];
      const match = breakdown(row, lines, Boolean(opts.fieldedLexical));
      let boosted = false;
      let lexicalScore = match.venueScore;
      if (
        !match.venueHit &&
        Array.isArray(opts.venueCats) &&
        opts.venueCats.length &&
        row.cats.some((cat) => opts.venueCats?.indexOf(cat) !== -1)
      ) {
        lexicalScore = Math.min(100, lexicalScore + 10);
        boosted = true;
      }
      // 旧 API の観測値は正規化した ID。実モデルの経路は正典の ID で受け取る。
      const semanticKey =
        opts.semanticSimilarities && Object.hasOwn(semanticScores ?? {}, row.conf.key)
          ? row.conf.key
          : key;
      const semantic =
        semanticScores && Number.isFinite(semanticScores[semanticKey])
          ? semanticScores[semanticKey]
          : 0;
      const similarityKey = Object.hasOwn(opts.semanticSimilarities ?? {}, row.conf.key)
        ? row.conf.key
        : key;
      const similarity = opts.semanticSimilarities
        ? (opts.semanticSimilarities[similarityKey] ?? 0)
        : semantic;
      return {
        key,
        row,
        match,
        retrievalFields: opts.semanticSimilarities
          ? breakdown(row, retrievalLines, Boolean(opts.fieldedLexical)).fieldScores
          : match.fieldScores,
        lexicalScore,
        semantic,
        similarity: Number.isFinite(similarity) ? similarity : 0,
        evidenceStrength: Math.max(match.topicScore || 0, semantic || 0),
        boosted,
      };
    });
    const requestedTopN = opts.topN;
    const topN = Number.isInteger(requestedTopN) && (requestedTopN ?? 0) > 0 ? requestedTopN! : 200;
    const k = 60;
    const fieldRanks: Record<string, FieldRanks> = Object.fromEntries(
      entries.map((entry) => [entry.key, {}]),
    );
    const fieldRrf: Record<string, number> = Object.fromEntries(
      entries.map((entry) => [entry.key, 0]),
    );
    const retrievalRrf: Record<string, number> = Object.fromEntries(
      entries.map((entry) => [entry.key, 0]),
    );
    let activeWeight = 0;
    if (opts.fieldedLexical) {
      FIELD_NAMES.forEach((field) => {
        const ranked = entries
          .filter((entry) => entry.match.fieldScores[field] > 0)
          .sort(
            (a, b) =>
              b.match.fieldScores[field] - a.match.fieldScores[field] || a.key.localeCompare(b.key),
          )
          .slice(0, topN);
        if (ranked.length) activeWeight += FIELD_WEIGHTS[field];
        ranked.forEach((entry, index) => {
          const rank = index + 1;
          fieldRanks[entry.key][field] = rank;
          fieldRrf[entry.key] += FIELD_WEIGHTS[field] / (k + rank);
        });
        entries
          .filter((entry) => entry.retrievalFields[field] > 0)
          .sort(
            (a, b) =>
              b.retrievalFields[field] - a.retrievalFields[field] || a.key.localeCompare(b.key),
          )
          .slice(0, topN)
          .forEach((entry, index) => {
            retrievalRrf[entry.key] += FIELD_WEIGHTS[field] / (k + index + 1);
          });
      });
      entries.forEach((entry) => {
        const fused = activeWeight
          ? Math.round(Math.min(100, (fieldRrf[entry.key] * 100 * (k + 1)) / activeWeight))
          : 0;
        /* 分類の boost は「既に證據がある」venue の順位付けに限る。 */
        const 證據が在る = fused > 0 || (entry.match.venueHit && entry.match.venueScore > 0);
        entry.lexicalScore = Math.min(
          100,
          Math.max(fused, entry.match.venueHit ? entry.match.venueScore : 0) +
            (entry.boosted && 證據が在る ? 10 : 0),
        );
      });
    }
    const lexical = entries
      .slice()
      .sort(
        (a, b) =>
          (opts.fieldedLexical ? retrievalRrf[b.key] - retrievalRrf[a.key] : 0) ||
          b.lexicalScore - a.lexicalScore ||
          a.key.localeCompare(b.key),
      );
    const categoryRank = (row: CandidateRow) => {
      const rank = opts.venueCats?.findIndex((category) => row.cats.includes(category)) ?? -1;
      return rank < 0 ? Number.MAX_SAFE_INTEGER : rank;
    };
    const semantic = entries
      .filter((entry) => entry.similarity > 0)
      .sort(
        (a, b) =>
          b.similarity - a.similarity ||
          categoryRank(a.row) - categoryRank(b.row) ||
          b.lexicalScore - a.lexicalScore ||
          a.key.localeCompare(b.key),
      );
    const lexicalRanks: Record<string, number> = {};
    const semanticRanks: Record<string, number> = {};
    lexical
      .filter((entry) => entry.lexicalScore > 0 || retrievalRrf[entry.key] > 0)
      .slice(0, topN)
      .forEach((entry, index) => {
        lexicalRanks[entry.key] = index + 1;
      });
    semantic.slice(0, topN).forEach((entry, index) => {
      const previous = semantic[index - 1];
      semanticRanks[entry.key] =
        opts.semanticSimilarities && previous?.similarity === entry.similarity
          ? semanticRanks[previous.key]
          : index + 1;
    });
    const hasSemantic = Object.keys(semanticRanks).length > 0;
    const keys = Object.keys(lexicalRanks);
    Object.keys(semanticRanks).forEach((key) => {
      if (keys.indexOf(key) < 0) keys.push(key);
    });
    const evidenceOrder = keys
      .map((key) => entries.find((entry) => entry.key === key))
      .filter((entry): entry is RecommendationEntry => entry !== undefined)
      .sort((a, b) => b.evidenceStrength - a.evidenceStrength || a.key.localeCompare(b.key));
    const topEvidence = evidenceOrder[0] ? evidenceOrder[0].evidenceStrength : 0;
    const secondEvidence = evidenceOrder[1] ? evidenceOrder[1].evidenceStrength : 0;
    const topFiveEvidence = evidenceOrder.slice(0, 5).map((entry) => entry.evidenceStrength);
    const totalEvidence = topFiveEvidence.reduce((sum, value) => sum + value, 0);
    const top5Entropy =
      topFiveEvidence.length > 1 && totalEvidence > 0
        ? -topFiveEvidence.reduce((sum, value) => {
            const p = value / totalEvidence;
            return sum + (p ? p * Math.log(p) : 0);
          }, 0) / Math.log(topFiveEvidence.length)
        : 0;
    const lexicalTop = lexical.find((entry) => entry.lexicalScore > 0)?.key;
    const semanticTop = semantic[0]?.key;
    const inputHasAbstract = lines.some((line) => Boolean(line.abstract?.trim())) ? 1 : 0;
    const inputTokenCount = lexicalTerms(lines.map((line) => paperText(line)).join(" ")).length;
    const queryConfidence = {
      top1Score: topEvidence,
      top2Score: secondEvidence,
      margin: Math.max(0, topEvidence - secondEvidence),
      top5Entropy: Number(top5Entropy.toFixed(6)),
      lexicalSemanticAgreement:
        lexicalTop && semanticTop && lexicalTop === semanticTop ? 1 : semanticTop ? 0 : 0.5,
      candidateCoverage: entries.length ? Number((keys.length / entries.length).toFixed(6)) : 0,
      inputHasAbstract,
      inputTokenCount,
      calibrated: false,
    };
    const entropyFactor = Math.max(0, 1 - top5Entropy);
    const tokenRichness = Math.min(1, inputTokenCount / 20);
    const confidenceScore = Number(
      Math.max(
        0,
        Math.min(
          1,
          (topEvidence / 100) * 0.4 +
            Math.min(1, queryConfidence.margin / 50) * 0.2 +
            queryConfidence.candidateCoverage * 0.15 +
            queryConfidence.lexicalSemanticAgreement * 0.1 +
            entropyFactor * 0.1 +
            tokenRichness * 0.05,
        ),
      ).toFixed(6),
    );
    const blend = Math.max(0, Math.min(1, rerankerModel?.blend ?? 0));
    return keys
      .map((key): RecommendationResult | null => {
        const entry = entries.find((item) => item.key === key);
        if (!entry) return null;
        const lexicalRank = lexicalRanks[key] || null;
        const semanticRank = semanticRanks[key] || null;
        // 類似度を取得できるときは意味を主に使う。単語の偶然の一致で
        // 近い候補を落とさず、既存の表示スコア・学習特徴量は保つ。
        const hasTopicEvidence = !!topicVecsState && Object.keys(topicVecsState).length > 0;
        const lexicalRrfWeight = opts.semanticSimilarities
          ? hasTopicEvidence
            ? 0.2
            : 0.4
          : opts.fieldedLexical
            ? 1.6
            : 1;
        const semanticRrfWeight = opts.semanticSimilarities
          ? hasTopicEvidence
            ? 1.8
            : 1.6
          : opts.fieldedLexical
            ? 0.4
            : 1;
        // 語彙の欠落は不一致ではない。意味検索にある候補には、語彙一覧の
        // 末尾より下の中立値を使い、語彙の一致があったとは表示しない。
        const rrf =
          (lexicalRank
            ? lexicalRrfWeight / (k + lexicalRank)
            : opts.semanticSimilarities && semanticRank
              ? lexicalRrfWeight / (k + entries.length + 1)
              : 0) + (semanticRank ? semanticRrfWeight / (k + semanticRank) : 0);
        const score = hasSemantic
          ? Math.round(Math.min(100, (rrf * 100 * (k + 1)) / 2))
          : entry.lexicalScore;
        const margin =
          entry === evidenceOrder[0]
            ? evidenceOrder.length > 1
              ? topEvidence - secondEvidence
              : Infinity
            : entry.evidenceStrength - topEvidence;
        const features = rerankerFeatures(entry, lines);
        const probability = rerankerProbability(features);
        const thresholds = rerankerModel?.confidence_thresholds;
        // confidence_policy.sufficient_enabled が false の間は sufficient を出さない。
        const sufficientEnabled = rerankerModel?.confidence_policy.sufficient_enabled === true;
        const heuristicConfidence = confidenceState(entry.evidenceStrength, margin);
        const confidence = thresholds
          ? probability >= thresholds.sufficient && sufficientEnabled
            ? "sufficient"
            : probability >= thresholds.ambiguous
              ? "ambiguous"
              : "insufficient"
          : heuristicConfidence === "sufficient"
            ? "ambiguous"
            : heuristicConfidence;
        const rankingScore = rerankerModel
          ? Math.round(score * (1 - blend) + probability * 100 * blend)
          : score;
        const evidence: Array<SignalEvidence | LineEvidence> = [
          ...(entry.match.signalEvidence || entry.match.evidence),
        ];
        if (semanticRank)
          evidence.push({ type: "semantic", rank: semanticRank, contribution: entry.semantic });
        return {
          venueKey: String(entry.row.conf?.key || key),
          row: entry.row,
          fit: {
            score: rankingScore,
            rankingScore,
            evidenceStrength: entry.evidenceStrength,
            confidence,
            label: fitLabel(confidence),
            lexicalScore: entry.lexicalScore,
            fieldScores: entry.match.fieldScores,
            fieldRanks: fieldRanks[key],
            fieldRrf: Number(fieldRrf[key].toFixed(8)),
            semanticScore: entry.semantic,
            lexicalRank,
            semanticRank,
            rrf: Number(rrf.toFixed(8)),
            evidence,
            confidenceScore,
            queryConfidence,
            probability: Number(probability.toFixed(6)),
            baseScore: score,
            rerankerFeatures: features,
          },
          availability: availability(entry.row, safeNow),
          match: entry.match,
          boosted: entry.boosted,
        };
      })
      .filter((result): result is RecommendationResult => result !== null)
      .sort((a, b) => {
        const baseA = hasSemantic ? a.fit.rrf * (k + 1) * 50 : a.fit.baseScore;
        const baseB = hasSemantic ? b.fit.rrf * (k + 1) * 50 : b.fit.baseScore;
        const rawA = baseA * (1 - blend) + a.fit.probability * 100 * blend;
        const rawB = baseB * (1 - blend) + b.fit.probability * 100 * blend;
        return (
          rawB - rawA ||
          b.fit.score - a.fit.score ||
          (opts.semanticSimilarities ? categoryRank(a.row) - categoryRank(b.row) : 0) ||
          a.venueKey.localeCompare(b.venueKey)
        );
      });
  }

  /* 掲載先タグ（例: "IEEE RTSS"）に一致する会議のリストを返す。
   * scoreLine の venueHit と同じ照合規則（normKey + 略称エイリアス + 原文）。
   * セマンティックの擬似関連性フィードバック（PRF）に使う — タグ付き論文の
   * 会議埋め込みをクエリに混ぜることで「自分が載せた所と似た会議」を強く拾う。
   * 日本語タグ（例: 「情報処理学会 DPS 研究会」）は normKey が日本語を消して
   * 「dps」等の短い断片になり、誤爆（IPDPS 等）の元になるため、原文も照合する。
   */
  function matchVenueTag<T>(tag: unknown, confs: readonly T[]): T[] {
    const raw = String(tag || "")
      .trim()
      .replace(/\s+/g, " ");
    const nv = normKey(tag);
    if (raw.length < 2 && nv.length < 2) return [];
    const out: T[] = [];
    confs.forEach((item) => {
      if (!isRecord(item)) return;
      const c = normalizeConference(item.conf) ?? normalizeConference(item);
      if (!c) return;
      const key = normKey(c.key);
      const hay = [key, normKey(c.title), normKey(c.full_name)].filter(Boolean); // 原文（日本語含む）: 空白正規化したタグが会議の名称に含まれれば一致。
      // 短いタグ（ISC 等）は完全一致のみ（ISCA への部分一致誤爆を防ぐ）
      const rawHay = [
        (c.title || "").replace(/\s+/g, " "),
        (c.full_name || "").replace(/\s+/g, " "),
      ];
      const rl = raw.toLowerCase();
      let hit =
        raw.length >= 2 &&
        rawHay.some((h) => {
          if (!h) return false;
          const hl = h.toLowerCase();
          return raw.length <= 3 ? hl === rl : hl.indexOf(rl) !== -1 || rl.indexOf(hl) !== -1;
        });
      // normKey 照合: 2〜3 文字は完全一致のみ（「dps」が IPDPS に部分一致する誤爆防止）
      if (!hit && nv.length >= 2) {
        if (nv.length <= 3) {
          hit = hay.some((h) => h === nv);
        } else {
          hit = hay.some((h) => h && (h.indexOf(nv) !== -1 || nv.indexOf(h) !== -1));
        }
        if (!hit) {
          const aliases = VENUE_ALIASES[nv];
          if (aliases) hit = aliases.some((alias) => normKey(alias) === key);
        }
      }
      if (hit) out.push(item);
    });
    return out;
  }

  /* 2 つの埋め込みベクトルを重み wA（a の重み）で合成し L2 正規化する。
   * PRF 用: a = 論文クエリ、b = 掲載先会議の埋め込み。 */
  function numericVector(value: unknown): value is Vector {
    return Array.isArray(value) && value.every((item) => typeof item === "number");
  }

  function blendVectors(a: unknown, b: unknown, wA: number): Vector {
    if (!numericVector(a)) return [];
    if (!numericVector(b) || a.length !== b.length) return a;
    const w = typeof wA === "number" ? wA : 0.7;
    const out = new Array(a.length);
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      out[i] = w * a[i] + (1 - w) * b[i];
      sum += out[i] * out[i];
    }
    const n2 = Math.sqrt(sum);
    if (!n2) return a;
    for (let j = 0; j < out.length; j++) out[j] /= n2;
    return out;
  }

  /* コサイン類似度（埋め込みベクトル）。0 ベクトルは 0 を返す。 */
  function cosine(a: Vector, b: Vector): number {
    if (!a || !b || !a.length || a.length !== b.length) return 0;
    let dot = 0,
      na = 0,
      nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  function embeddingSetCompatible(
    bundle: EmbeddingBundle | null | undefined,
    language: string,
  ): boolean {
    const manifest = bundle?.manifest;
    const meta = manifest?.models?.[language];
    const set = language === "multi" ? bundle?.multi : bundle;
    if (manifest?.schema !== 1 || typeof manifest.profile_hash !== "string" || !meta || !set)
      return false;
    if (set.model !== meta.model || set.dim !== meta.dim || !meta.revision) return false;
    if (!Array.isArray(manifest.keys) || !set.embeddings) return false;
    const embeddings = set.embeddings;
    const keys = Object.keys(embeddings).sort();
    const expected = manifest.keys.slice().sort();
    if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) return false;
    if (meta.probe?.text !== "kamiyobi embedding compatibility probe") return false;
    if (!Array.isArray(meta.probe.vector) || meta.probe.vector.length !== meta.dim) return false;
    return keys.every((key) => {
      const vector = embeddings[key];
      return Array.isArray(vector) && vector.length === meta.dim;
    });
  }

  // 閾値 0.97: probe の役割は「別モデルの取り違え検出」(実測 cosine ≈ 0.40) であって
  // 量子化差の検出ではない。ビルドは fp32 で probe を保存し、ブラウザは q8 量子化
  // モデルで再計算するため、正しいモデルでも cosine ≈ 0.9895 (en/multi とも実測)。
  // 原因は q8 量子化のみ (同一ライブラリ+quantized:false では 1.000000 を実測、
  // Node/wasm のバックエンド差の寄与は測定限界以下)。旧閾値 0.99 はこの差で
  // 全訪問者の意味検索を静かに無効化していた (2026-09-06 本番QAで検出)。
  function embeddingProbeMatches(
    meta: EmbeddingModelMeta | null | undefined,
    vector: unknown,
  ): boolean {
    const numericVector =
      Array.isArray(vector) && vector.every((item) => typeof item === "number") ? vector : null;
    return Boolean(
      meta?.probe &&
        Array.isArray(meta.probe.vector) &&
        numericVector &&
        meta.probe.vector.length === numericVector.length &&
        cosine(meta.probe.vector, numericVector) >= 0.97,
    );
  }

  /* セマンティック適合度 0..100。
   * query: ユーザー論文の埋め込みベクトル、emb: {key: [...]} の会議埋め込み表。
   * 掲載先タグ付きの行が複数あってもクエリは 1 本に集約して類似度を出す。
   * paperVecs: skipEmb 会議（rtss/ecrts/usenix-security）の論文個別ベクトル表。
   * 与えた場合は「会議名との類似度」と「採択論文どれかとの類似度」の max を取る
   * （平均重心の汎用化を避けるため埋め込みから論文を外すと、論文タイトルから
   * セマンティックに発見されないため）。
   */
  function semanticSimilarity(
    confKey: string,
    queryVec: Vector,
    emb: VectorMap,
    paperVecs?: PaperVectorMap | null,
    topicVecs?: PaperVectorMap | null,
  ): number {
    if (!queryVec || !emb) return 0;
    const v = emb[confKey] || emb[(confKey || "").toLowerCase()];
    if (!v) return 0;
    let c = cosine(queryVec, v);
    const vectors = paperVecs || paperVecsState;
    const pvs = vectors?.[confKey];
    if (pvs?.length) {
      for (let i = 0; i < pvs.length; i++) {
        const pc = cosine(queryVec, pvs[i]);
        if (pc > c) c = pc;
      }
    }
    const topics = (topicVecs ?? topicVecsState)?.[confKey] ?? [];
    const rankedTopics = topics
      .map((vector) => ({ vector, similarity: cosine(queryVec, vector) }))
      .sort((a, b) => b.similarity - a.similarity);
    if (rankedTopics[0]) c = Math.max(c, rankedTopics[0].similarity);
    const strongest = rankedTopics[0];
    const support =
      strongest && rankedTopics.find((topic) => cosine(topic.vector, strongest.vector) < 0.85);
    // Corroborating distinct CFP topics add coverage; repeated copies add nothing.
    if (support) c += Math.max(0, 1 - c) * Math.max(0, support.similarity);
    return c;
  }

  function semanticScore(
    confKey: string,
    queryVec: Vector,
    emb: VectorMap,
    vectors?: PaperVectorMap | null,
    topicVecs?: PaperVectorMap | null,
  ): number {
    const c = semanticSimilarity(confKey, queryVec, emb, vectors, topicVecs);
    return Math.round(Math.max(0, (c - 0.2) / 0.8) * 100);
  }

  /* 会議プロファイルの英語比率 0..1。
   * embeddings.ts の profileTexts と同じ構成（title + full_name + tags）で測る。
   * 日本語名が主体の会議（IPSJ 特集号等）は英語モデルの埋め込みが「カテゴリ重心の
   * ぼやけ」になり、英語クエリへの誤マッチの元になる。英語クエリではこの比率で
   * セマンティックスコアを減衰させる（日本語クエリは多言語モデルなので減衰しない）。
   */
  function englishRatio(c: ConferenceRecord): number {
    const text = [c.title, c.full_name, (c.tags || []).join(" ")].filter(Boolean).join(" ");
    if (!text) return 1;
    const letters = text.replace(/[^a-zA-Z]/g, "").length;
    return letters / text.length;
  }

  /* 会議名・代表論文の語がクエリテキストに語境界で現れるか。
   * 部分文字列一致（indexOf）だと、会議名の略語 trans/syst がクエリの
   * Transcompiling/Systems に誤マッチする（QiMeng→ieice 46 点の実測原因）。
   * 単複形・活用形（bandit/bandits, process/processes, memory/memories, search/searches）は
   * 正当なマッチなので双方向に対称照合する。
   */
  function wordInText(hay: unknown, w: unknown): boolean {
    if (!hay || !w) return false;
    const safeW = String(w)
      .toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!safeW) return false;
    let re: string;
    if (safeW.endsWith("ies") && safeW.length > 4) {
      re = `${safeW.slice(0, -3)}(?:y|ies)`;
    } else if (safeW.endsWith("y") && safeW.length > 3 && !/[aeiou]y$/.test(safeW)) {
      re = `${safeW.slice(0, -1)}(?:y|ies)`;
    } else if (safeW.endsWith("sses") && safeW.length > 5) {
      re = `${safeW.slice(0, -2)}(?:es)?`;
    } else if (safeW.endsWith("ss")) {
      re = `${safeW}(?:es)?`;
    } else if (/(?:ches|shes|xes|zes)$/.test(safeW) && safeW.length > 4) {
      re = `${safeW.slice(0, -2)}(?:es)?`;
    } else if (/(?:ch|sh|x|z)$/.test(safeW)) {
      re = `${safeW}(?:es)?`;
    } else if (safeW.endsWith("s")) {
      re = `${safeW.slice(0, -1)}s?`;
    } else {
      re = `${safeW}s?`;
    }
    return new RegExp(`\\b${re}\\b`, "i").test(String(hay));
  }

  /* Domain/tag signals use token boundaries so short signals such as "ai" do not
   * match unrelated words. Hyphenated phrases are equivalent to space-separated
   * phrases; Japanese signals retain substring matching. */
  function signalInText(hay: unknown, signal: unknown): boolean {
    if (!hay || !signal) return false;
    const normalize = (value: unknown) => {
      const raw = String(value);
      const cached = signalTextCache.get(raw);
      if (cached !== undefined) return cached;
      return rememberLexicalValue(
        signalTextCache,
        raw,
        raw
          .toLowerCase()
          .replace(/[\u2010-\u2015\u2212-]/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      );
    };
    const text = normalize(hay);
    const needle = normalize(signal);
    if (!text || !needle) return false;
    if (/[\u3000-\u9fff]/.test(needle)) return text.indexOf(needle) !== -1;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern =
      signalPatternCache.get(needle) ??
      rememberLexicalValue(
        signalPatternCache,
        needle,
        new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i"),
      );
    return pattern.test(text);
  }

  /* クエリの内容語数（英語）。ブレンドの語彙重みの適応に使う。
   * 一般語（STOPWORDS）と短語は数えない — 入力が短いほど語彙シグナルが疎なので
   * セマンティック寄りに倒すべき、という実測の根拠になる。 */
  function contentWordCount(text: unknown): number {
    if (!text) return 0;
    const seen = new Set<string>();
    const m = String(text)
      .toLowerCase()
      .match(/[a-z][a-z0-9-]{2,}/g);
    (m || []).forEach((word) => {
      const w = word.replace(/[^a-z]/g, "");
      if (w.length > 3 && !STOPWORDS.has(w)) seen.add(w);
    });
    return seen.size;
  }

  /* 語彙スコアとセマンティックスコアの合成に使う語彙重み。
   * 英語: クエリの内容語数で適応（実測: 短いクエリは語彙が疎なのでセマンティック寄り 0.25、
   *   中〜長は 0.4。EN bench top1 84.4%→グループ別最良で確認）。
   * 日本語: 会議名の日本語チャンク一致が識別力の主役なので語彙寄り 0.6（JP ベンチ比較）。
   * len: クエリの内容語数（英語のみ。日本語は isJp が優先）。
   */
  function vocabWeight(len: number | undefined, isJp: boolean | undefined): number {
    if (isJp) return 0.6;
    return len !== undefined && len <= 4 ? 0.25 : 0.4;
  }

  /* 語彙スコアとセマンティックスコアの合成。
   * opts: { jp?: boolean, jpw?: number, len?: number } — jpw 指定時は最優先
   * （ベンチマークのスイープ用）、無ければ len と jp から vocabWeight で決める。
   * セマンティックが未ロード（オフライン等）なら語彙スコアをそのまま返す。
   */
  function blendScore(
    vocab: number,
    sem: number,
    opts?: { jp?: boolean; jpw?: number; len?: number },
  ): number {
    if (!sem) return vocab;
    const w = opts && typeof opts.jpw === "number" ? opts.jpw : vocabWeight(opts?.len, opts?.jp);
    return Math.round(vocab * w + sem * (1 - w));
  }

  /* テキストに日本語（かな・漢字）が含まれるか。
   * 言語適応型モデル選択の判定に使う（日本語論文は多言語モデルで埋め込む）。
   */
  function hasJapanese(text: unknown): boolean {
    return /[\u3040-\u9fff]/.test(String(text || ""));
  }

  function queryHasJapanese(lines: readonly PaperRecord[]): boolean {
    return lines.some((paper) => hasJapanese(paperText(paper).normalize("NFKC")));
  }

  /* 日本語キーワード → 英語の展開（語彙スコア用）。
   * 多言語モデルは日本語論文を埋め込めるが、語彙スコア（会議名の英単語との一致）は
   * 日本語テキストには全く効かない。そこで日本語の分野語を英語に展開してから
   * 分野シグナル・会議名・タグの一致判定に使う（例: 「低遅延」→ latency real-time）。
   * 表示用の論文テキストは保つ。埋め込み用クエリには英語の補助語を添える。
   */
  const JP_EN: Record<string, string> = {
    // システム・分散
    分散処理: "distributed processing",
    分散システム: "distributed system",
    分散: "distributed",
    低遅延: "low latency latency",
    リアルタイム: "real-time realtime",
    組み込み: "embedded",
    カーネル: "kernel",
    カーネル拡張: "ebpf kernel tracing",
    オペレーティングシステム: "operating system",
    仮想化: "virtualization",
    スケジューリング: "scheduling",
    スケジューラ: "scheduler",
    ミドルウェア: "middleware",
    ストレージ: "storage",
    メモリ: "memory",
    メモリアーキテクチャ: "cxl compute express link interconnect",
    キャッシュ: "cache",
    コンパイラ: "compiler",
    プロセッサ: "processor",
    マイクロアーキテクチャ: "microarchitecture",
    フォールトトレラント: "fault tolerant",
    高信頼: "reliable dependable",
    データセンター: "data center",
    サーバレス: "serverless",
    コンテナ: "container",
    マイクロサービス: "microservice",
    高速通信: "rdma remote direct memory access infiniband",
    // ネットワーク
    ネットワーク: "network networking",
    通信: "communication",
    無線: "wireless",
    ルーティング: "routing",
    パケット: "packet",
    エッジコンピューティング: "edge computing",
    エッジ: "edge",
    クラウド: "cloud",
    インターネット: "internet",
    モバイル: "mobile",
    IoT: "iot internet of things",
    // AI・データ
    機械学習: "machine learning",
    深層学習: "deep learning",
    強化学習: "reinforcement learning",
    学習: "learning",
    ニューラルネットワーク: "neural network",
    ニューラル: "neural",
    大規模言語モデル: "large language model",
    LLM推論: "large language model llm inference kv cache",
    検索拡張生成: "retrieval augmented generation rag",
    テンソル並列: "tensor parallelism pipeline distributed training",
    分散学習: "distributed training tensor parallelism pipeline",
    生成: "generative generation",
    推論: "inference",
    異常検知: "anomaly detection",
    時系列: "time series",
    データマイニング: "data mining",
    データベース: "database",
    検索: "search retrieval",
    推薦: "recommendation",
    自然言語処理: "natural language processing",
    音声認識: "speech recognition",
    物体検出: "object detection",
    セグメンテーション: "segmentation",
    ブロックチェーン: "blockchain",
    フェデレーテッド: "federated",
    量子: "quantum",
    グラフ: "graph",
    アルゴリズム: "algorithm",
    シミュレーション: "simulation",
    // セキュリティ
    セキュリティ: "security",
    プライバシー: "privacy",
    機密計算: "confidential computing tee secure enclave",
    信頼実行環境: "confidential computing tee secure enclave",
    暗号: "cryptography encryption",
    認証: "authentication",
    攻撃: "attack",
    脆弱性: "vulnerability",
    エンクレーブ: "enclave",
    マルウェア: "malware",
    // 画像・HCI・その他
    画像: "image",
    音声: "speech audio",
    映像: "video multimedia",
    ビジョン: "vision",
    可視化: "visualization",
    レンダリング: "rendering",
    アニメーション: "animation",
    ユーザビリティ: "usability",
    人間: "human",
    拡張現実: "augmented reality",
    仮想現実: "virtual reality",
    センサ: "sensor",
    ロボット: "robot robotics",
    自動運転: "autonomous driving",
    車載: "automotive",
    医療: "medical healthcare",
    交通: "transportation traffic",
    電力: "power energy",
    並列: "parallel",
    高性能計算: "high performance computing hpc supercomputing",
    ハイパフォーマンス: "high performance hpc",
    スーパーコンピュータ: "supercomputer",
    スパコン: "supercomputing supercomputer",
    高性能: "high performance",
    アクセラレータ: "accelerator acceleration",
    輻輳制御: "congestion control",
    耐故障性: "fault tolerance",
    レプリケーション: "replication",
    コンセンサス: "consensus",
    省電力: "power efficiency energy saving",
    集団通信: "collective communication",
    資源配分: "resource allocation",
    遅延: "latency delay",
    帯域: "bandwidth",
    スループット: "throughput",
    体感品質: "quality of experience qoe",
    負荷分散: "load balancing",
    オーケストレーション: "orchestration",
    プロビジョニング: "provisioning",
    自動化: "automation",
    運用管理: "operations management",
    トラフィック: "traffic",
    スライシング: "slicing",
    仮想マシン: "virtual machine",
    分散共有: "distributed shared",
  };

  /* 語彙一致に使う日本語→英語展開を有効/無効にする（ベンチマーク比較用。
   * 実測: 会議名チャンクの合成クエリでは誤爆するが、実論文の日本語語彙では有効）。 */
  let expandEnabled = true;
  function setExpandEnabled(v: boolean) {
    expandEnabled = !!v;
  }

  /* 検索用の専門語・表記を補う。 */
  const RETRIEVAL_TOPIC_ALIASES: Record<string, string> = {
    輻輳制御:
      "network congestion control transport protocols computer communication packet networking bandwidth allocation",
    通信状態: "network conditions",
    ネットワーク構成: "network configuration",
    競合フロー: "competing network flows",
    "pac learning": "probably approximately correct learning statistical learning theory",
    PAC学習: "probably approximately correct learning statistical learning theory",
    自己回帰: "autoregressive modeling",
    事前学習: "pretrained models transfer learning",
    ファインチューニング: "fine tuning neural networks transfer learning",
    led: "light emitting diode display hardware",
    プロジェクションマッピング: "projection mapping spatial displays",
    アクチュエーション: "actuation interactive hardware devices",
    java: "Java programming language software engineering program analysis",
    プログラム理解: "program comprehension software engineering program analysis",
    変数名: "variable naming software engineering program comprehension",
    ファジング: "fuzzing software security vulnerability discovery",
    メモリ重複排除: "memory deduplication operating systems virtual memory management",
    メモリ管理: "operating systems memory management",
    ゲームコントローラ: "human computer interaction input devices user interfaces",
    協調的議論: "computer supported cooperative work collaborative human computer interaction",
    協調作業: "computer supported cooperative work human computer interaction",
    クエリ拡張: "query expansion information retrieval document search",
    文書拡張: "document expansion information retrieval search",
    グラフ疎化: "graph sparsification spectral graph algorithms computational complexity",
    グラフスパース化: "graph sparsification spectral graph algorithms computational complexity",
    分位点推定: "quantile estimation statistical learning probability distribution estimation",
    "quantile estimation": "statistical estimation inference probability distribution learning",
    "distribution testing":
      "statistical learning hypothesis testing sample complexity learning theory",
    "kernel same-page merging": "operating systems kernel memory deduplication memory management",
    "random early detection": "network congestion control packet queue management",
    "memory deduplication": "operating systems virtual memory management",
    "model serving": "machine learning inference serving systems performance",
    "serving throughput": "operating systems GPU parallel inference resource management",
    "conformal risk control": "conformal prediction statistical machine learning risk estimation",
    "asynchronous training": "distributed machine learning optimization neural networks",
    isoperimetry:
      "isoperimetric inequalities high dimensional probability sampling learning theory",
    オイラー巡回: "Euler tours",
    行列式点過程: "determinantal point processes",
    不等式: "inequality",
    上界: "upper bound",
    疎化: "sparsification",
    加法誤差: "additive error",
    等周性: "isoperimetry high dimensional probability sampling learning theory",
    対数ソボレフ: "log Sobolev",
    ランジュバン: "Langevin",
    エクスパンダー: "expander graph",
    オンライン意思決定: "online decision making",
    リグレット: "regret",
    頑健: "robust",
    実物体: "physical objects tangible user interfaces human computer interaction",
    展示: "exhibition",
    芸術: "art",
    エンタテインメント: "entertainment",
    標的型メール: "spear phishing email security social engineering attacks",
    差分プライバシー: "differential privacy",
    局所差分プライバシー: "local differential privacy statistical estimation",
    シャッフル差分プライバシー: "shuffle differential privacy statistical estimation",
    加法モデル: "additive models statistical learning",
    ブースティング: "boosting statistical learning",
    ソーシャルエンジニアリング: "social engineering security attacks",
    フィッシング: "phishing security social engineering attacks",
    視覚効果: "visual effects interactive displays user interfaces",
    視覚効果生成: "visual effects creation interactive displays user interfaces",
    hpc: "high performance computing supercomputing parallel scientific computing",
    mpi: "message passing interface parallel high performance computing",
    集団通信:
      "MPI collective communication parallel computing high performance computing supercomputing",
    非同期集団通信:
      "MPI nonblocking collective communication parallel computing high performance computing",
    ランサムウェア: "ransomware malware cybersecurity extortion attacks",
    ransomware: "malware cybersecurity extortion attacks",
    生成モデル: "generative modeling neural machine learning",
    拡散モデル: "diffusion models neural generative machine learning",
    "diffusion models": "neural generative machine learning",
    生成: "generation",
    訓練データ: "training data machine learning",
    特徴選択: "feature selection machine learning",
    特徴表現: "feature representation learning",
    注意機構: "attention neural network",
    関連度伝播: "relevance propagation explainable machine learning",
    逆伝播: "backpropagation neural network",
    サンプリング: "sampling probabilistic statistical",
    標本: "sample statistical",
    勾配: "gradient optimization",
    確率分布: "probability distribution",
    分布検定:
      "distribution testing statistical learning hypothesis testing sample complexity learning theory",
    仮説検定: "hypothesis testing statistical inference",
    分位点: "quantile estimation statistical learning probability distribution inference",
    ベイズ: "bayesian probabilistic",
    回帰: "regression statistical learning",
    最適化: "optimization",
    汎化: "generalization learning theory",
    標本計算量: "sample complexity statistical learning",
    乱択: "randomized algorithms",
    clustering: "unsupervised machine learning",
    "k-means": "unsupervised machine learning",
    "a/b testing": "statistical inference causal inference",
    "treatment effect": "causal inference statistical learning",
    "large language model": "neural machine learning language modeling",
    llm: "large language models neural machine learning",
    "uncertainty quantification":
      "probabilistic modeling Bayesian statistical inference prediction uncertainty",
    "distribution shift":
      "statistical machine learning predictive uncertainty Bayesian inference out of distribution detection",
    inla: "integrated nested Laplace approximation Bayesian statistical inference",
  };

  function expansionTerms(text: unknown, forRetrieval = false): string[] {
    if (!expandEnabled) return [];
    const t = String(text || "").toLowerCase();
    const aliases = forRetrieval ? { ...JP_EN, ...RETRIEVAL_TOPIC_ALIASES } : JP_EN;
    const keys = Object.keys(aliases).filter((jp) =>
      forRetrieval && /^[a-z0-9/ -]+$/i.test(jp)
        ? signalInText(t, jp) ||
          wordInText(t.replace(/[\u2010-\u2015\u2212-]/g, " "), jp.replace(/-/g, " "))
        : t.includes(jp.toLowerCase()),
    );
    if (forRetrieval) {
      keys.sort(
        (a, b) => t.indexOf(a.toLowerCase()) - t.indexOf(b.toLowerCase()) || b.length - a.length,
      );
    }
    const distinctKeys = forRetrieval
      ? keys.filter(
          (key) =>
            !keys.some(
              (other) =>
                other.length > key.length && other.toLowerCase().includes(key.toLowerCase()),
            ),
        )
      : keys;
    const terms = distinctKeys.map((jp) => aliases[jp]);
    if (
      forRetrieval &&
      /特徴/.test(t) &&
      /ラベル/.test(t) &&
      /訓練|分類|標本|データ選択|データセット/.test(t)
    ) {
      terms.push("feature label supervised learning");
    }
    return terms;
  }

  function expandJp(text: unknown, forRetrieval = false): string {
    return expansionTerms(text, forRetrieval).join(" ");
  }

  /* 先頭論文の題名とキーワードを優先した、1800文字以内の埋め込み用クエリ。
   * 題名の主題と日本語の専門語を補い、会議プロファイルと照合する。
   */
  function queryText(lines: readonly PaperRecord[]): string {
    if (!lines?.length) return "";
    const p0 = lines[0];
    const p0TitleKw = [p0?.title, p0?.keywords]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const p0Full = paperText(p0).replace(/\s+/g, " ").trim();
    const all = lines.map((paper) => paperText(paper).replace(/\s+/g, " ").trim());
    const joined = all.filter(Boolean).join(" ").trim();
    const japanese = queryHasJapanese(lines);
    const hints = [
      ...new Set([
        ...expansionTerms(p0TitleKw, true),
        ...expansionTerms(japanese || !p0TitleKw ? p0Full : p0TitleKw, true),
      ]),
    ].join(" ");
    if (hints) {
      const shortHints = hints.length > 400 ? hints.slice(0, 400).replace(/\s+\S*$/, "") : hints;
      return [p0TitleKw, shortHints, joined].filter(Boolean).join(" ").slice(0, 1800);
    }
    if (joined.length <= 1800) {
      const primary = p0Full;
      return ((primary ? `${primary} ` : "") + joined).slice(0, 1800);
    }
    const emphasis = (p0TitleKw || p0Full.slice(0, 240)).slice(0, 1800);
    const budgetRemaining = Math.max(0, 1800 - (emphasis ? emphasis.length + 1 : 0));
    let truncatedJoined = joined.slice(0, budgetRemaining).trim();
    const lastSpace = truncatedJoined.lastIndexOf(" ");
    if (lastSpace > budgetRemaining * 0.8) {
      truncatedJoined = truncatedJoined.slice(0, lastSpace).trim();
    }
    return [emphasis, truncatedJoined].filter(Boolean).join(" ");
  }

  function safeExternalUrl(value: unknown): string {
    const text = String(value == null ? "" : value).trim();
    if (!text) return "";
    try {
      const url = new URL(text, "https://kamiyobi.invalid/");
      return url.protocol === "http:" || url.protocol === "https:" ? text : "";
    } catch (_error) {
      return "";
    }
  }

  const api = {
    暦年Ja: 暦年Ja,
    DOMAIN_SIGNAL: DOMAIN_SIGNAL,
    STOPWORDS: STOPWORDS,
    parsePaperLines: parsePaperLines,
    pdfTextLines: pdfTextLines,
    pdfPaperRecord: pdfPaperRecord,
    textPaperRecord: textPaperRecord,
    autoDetectCats: autoDetectCats,
    venueCategories: venueCategories,
    unmatchedVenues: unmatchedVenues,
    venueLookupNoticeJa: venueLookupNoticeJa,
    scorePapers: scorePapers,
    paperWeights: paperWeights,
    breakdown: breakdown,
    venueRecommendations: venueRecommendations,
    setReranker: setReranker,
    RERANKER_ALGORITHM_REVISION: RERANKER_ALGORITHM_REVISION,
    RERANKER_FEATURE_SCHEMA: RERANKER_FEATURE_SCHEMA,
    confidenceState: confidenceState,
    fitLabel: fitLabel,
    journalRows: journalRows,
    rankMatches: rankMatches,
    rankGradeJa: rankGradeJa,
    candidateRows: candidateRows,
    isCandidateConference: isConference,
    categoryLabelJa: categoryLabelJa,
    meetingRangeJa: meetingRangeJa,
    upcomingEditionsOf: upcomingEditionsOf,
    laterEditionSearchWords: laterEditionSearchWords,
    laterEditionLineJa: laterEditionLineJa,
    categoryChipLabelJa: categoryChipLabelJa,
    officialZone: officialZone,
    isExtendedDeadline: isExtendedDeadline,
    deadlineRowIsPast: deadlineRowIsPast,
    jstNoonMs: jstNoonMs,
    pastDeadlineTagJa: pastDeadlineTagJa,
    dateOnlyStateJa: dateOnlyStateJa,
    remainingLabelJa: remainingLabelJa,
    deadlineShiftsOf: deadlineShiftsOf,
    deadlineShiftLineJa: deadlineShiftLineJa,
    estimateWindowJa: estimateWindowJa,
    deadlineShiftSearchWords: deadlineShiftSearchWords,
    weekdaySearchTerms: weekdaySearchTerms,
    splitHintJa: splitHintJa,
    conjunctionQueryNoteJa: conjunctionQueryNoteJa,
    queryTermCounts: queryTermCounts,
    shorterHitWordsJa: shorterHitWordsJa,
    extendedLabelJa: () => EXTENDED_LABEL_JA,
    placeJa: placeJa,
    weekdayJaFromDate: weekdayJaFromDate,
    eventDateBoundsMs: eventDateBoundsMs,
    eventCellJa: eventCellJa,
    titleWithYearJa: titleWithYearJa,
    deadlinesToCsv: deadlinesToCsv,
    /* 推薦の候補の CSV。一覧の CSV と同じ締切の欄に、一致の欄を足した物。 */
    candidateRowsToCsv: candidateRowsToCsv,
    searchNormalize: searchNormalize,
    queryNarrowHintJa: queryNarrowHintJa,
    columnQueryWordJa: columnQueryWordJa,
    columnQueryNoteJa: columnQueryNoteJa,
    columnQueryLiveNoteJa: columnQueryLiveNoteJa,
    uiWordNoteJa: uiWordNoteJa,
    uiWordAlwaysNoteJa: uiWordAlwaysNoteJa,
    dayRangeDaysJa: dayRangeDaysJa,
    dayRangeWindowJa: dayRangeWindowJa,
    dayRangeNoteJa: dayRangeNoteJa,
    queryDaySpanJa: queryDaySpanJa,
    /* 「締切まで N 日」の窓の端。 */
    withinDaysLimitMs: withinDaysLimitMs,
    withinDaysFloorMs: withinDaysFloorMs,
    dayRangeLiveNoteJa: dayRangeLiveNoteJa,
    uiWordLiveNoteJa: uiWordLiveNoteJa,
    wholeTableQueryWordJa: wholeTableQueryWordJa,
    wholeTableQueryNoteJa: wholeTableQueryNoteJa,
    querySynonymNotes: querySynonymNotes,
    queryHiddenKindMatches: queryHiddenKindMatches,
    looksLikeUrlQuery: looksLikeUrlQuery,
    monthTermsJa: monthTermsJa,
    dayTermsJa: dayTermsJa,
    weekDayTermsJa: weekDayTermsJa,
    relativeDayNotes: relativeDayNotes,
    placePrefectureJa: placePrefectureJa,
    placeOffersOnline: placeOffersOnline,
    rankGradeOrderJa: rankGradeOrderJa,
    rankSortKey: rankSortKey,
    presetIsActive: presetIsActive,
    presetNextSelection: presetNextSelection,
    unconfirmedLabelJa: unconfirmedLabelJa,
    unconfirmedMeaningJa: unconfirmedMeaningJa,
    timeUnconfirmedLabelJa: () => TIME_UNCONFIRMED_LABEL_JA,
    aoeMeaningJa: aoeMeaningJa,
    unconfirmedFieldsJa: unconfirmedFieldsJa,
    unconfirmedHayJa: unconfirmedHayJa,
    dataAgeNoteJa: dataAgeNoteJa,
    dataStaleDaysJa: DATA_STALE_DAYS_JA,
    notApplicableLabelJa: notApplicableLabelJa,
    notApplicableTitleJa: notApplicableTitleJa,
    fieldNotApplicableJa: fieldNotApplicableJa,
    semanticReasonJa: semanticReasonJa,
    semanticReasonLabelsJa: SEMANTIC_REASON_LABELS_JA,
    rankPairLabelJa: rankPairLabelJa,
    rankScaleLabelJa: rankScaleLabelJa,
    rankUnratedLabelJa: rankUnratedLabelJa,
    rankSearchTerms: rankSearchTerms,
    placeWithPrefectureJa: placeWithPrefectureJa,
    expandRelativeMonths: expandRelativeMonths,
    relativeMonthPairs: relativeMonthPairs,
    monthRangeTermsJa: monthRangeTermsJa,
    monthRangePairs: monthRangePairs,
    dayRangeTermsJa: dayRangeTermsJa,
    _debug暦日: 暦日に解くJa,
    _debugDAY: (語: string) => {
      const hit = DAY_RANGE.exec(searchNormalize(語));
      return hit ? [hit[1], hit[2]] : null;
    },
    dayRangePairs: dayRangePairs,
    seasonTermsJa: seasonTermsJa,
    yearSeasonTermsJa: yearSeasonTermsJa,
    mergeSeasonTokens: mergeSeasonTokens,
    seasonPairs: seasonPairs,
    periodMonthPairs: periodMonthPairs,
    periodMonthTermsJa: periodMonthTermsJa,
    clockTimeTermsJa: clockTimeTermsJa,
    monthPartTermsJa: monthPartTermsJa,
    monthPartRangeJa: monthPartRangeJa,
    pressedWeekdayJa: pressedWeekdayJa,
    fiscalYearTermsJa: fiscalYearTermsJa,
    kanaFold: kanaFold,
    queryTokenGroups: queryTokenGroups,
    queryTokens: queryTokens,
    hayMatches: hayMatches,
    searchMatcher: searchMatcher,

    kanaFoldMemo: (): typeof kanaFold => kanaFold,
    tagLabelJa: tagLabelJa,
    isDomesticTag: isDomesticTag,
    domesticTagLabelJa: domesticTagLabelJa,
    topicTagsJa: topicTagsJa,
    tagSearchTerms: tagSearchTerms,
    scheduleOnlyEditions: scheduleOnlyEditions,
    kindLabelJa: kindLabelJa,
    kindKeyJa: kindKeyJa,
    kindLabelTable: () => ({ ...KIND_LABEL_JA }),
    kindDateFieldJa: kindDateFieldJa,
    verificationStatusLabelTable: () => ({ ...VERIFICATION_STATUS_LABELS_JA }),
    verifyLabelTables: verifyLabelTables,
    verifySourceLabelJa: verifySourceLabelJa,
    verifyScopeJa: verifyScopeJa,
    verificationSummaryJa: verificationSummaryJa,
    jstStampJa: jstStampJa,
    verificationStatusLabelJa: verificationStatusLabelJa,
    roundSearchTerms: roundSearchTerms,
    categorySearchTerms: categorySearchTerms,
    pastRepresentatives: pastRepresentatives,
    undatedVenueRows: undatedVenueRows,
    candidatePool: candidatePool,
    pickRepresentative: pickRepresentative,
    comparePapers: comparePapers,
    safeExternalUrl: safeExternalUrl,
    matchVenueTag: matchVenueTag,
    blendVectors: blendVectors,
    cosine: cosine,
    embeddingSetCompatible: embeddingSetCompatible,
    embeddingProbeMatches: embeddingProbeMatches,
    semanticScore: semanticScore,
    semanticSimilarity: semanticSimilarity,
    blendScore: blendScore,
    vocabWeight: vocabWeight,
    contentWordCount: contentWordCount,
    englishRatio: englishRatio,
    setNameIdf: setNameIdf,
    setPaperVecs: setPaperVecs,
    setTopicVecs: setTopicVecs,
    buildNameIdf: buildNameIdf,
    setSigWeights: setSigWeights,
    GENERIC_PAPER_WORDS: GENERIC_PAPER_WORDS,
    hasJapanese: hasJapanese,
    queryHasJapanese: queryHasJapanese,
    expandJp: expandJp,
    setExpandEnabled: setExpandEnabled,
    queryText: queryText,
    wordInText: wordInText,
    signalInText: signalInText,
    fieldedLexicalScore: (paper: unknown, candidate: unknown) => {
      const normalizedPaper = isRecord(paper)
        ? {
            title: String(paper.title ?? ""),
            abstract: typeof paper.abstract === "string" ? paper.abstract : "",
            keywords: typeof paper.keywords === "string" ? paper.keywords : "",
          }
        : { title: "" };
      const normalized = normalizeConference(candidate);
      if (!normalized) return { score: 0, fields: emptyFieldScores() };
      return fieldedLexicalScore(normalizedPaper, confHay(normalized));
    },
  };

  return api;
})();

export default Recommender;
