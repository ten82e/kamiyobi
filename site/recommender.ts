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
  /** 会期の暦日。国際会議の `date_text` は英語表記なので、月での検索はこっちを使う。 */
  event_start?: string;
  event_end?: string;
  estimated?: boolean;
  /** 公式ページ。検索欄に URL を貼って収録確認をする人が使えるように、検索語へ入れる。 */
  link?: string;
  deadlines?: DeadlineRecord[];
}

/** 会期だけが決まっていて締切が未定の回（締切一覧の表には出さない）。 */
interface ScheduleOnlyEdition {
  key: string;
  name: string;
  link: string;
  place: string;
  eventStart: string;
  eventEnd: string;
  cats: string[];
  tags: string[];
  hay: string;
}

interface ConferenceRecord {
  key: string;
  /** 会議・ジャーナルの公式ページの URL。画面は `ed.link || conf.link` でリンクを出すので、
   * 正規化の段階で落とすと、そこを通る行（常時受付のジャーナル）だけリンクの無い行になる。 */
  link?: string;
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
  /** 品の窓に締切が 1 本も入らない会議にだけ付く、収録側の一番遠い締切日（JST の暦日）。
   * 収録に締切が 1 本も無いは `null`、日付が読めない物しかない等は `""`（画面は数を言わない）。
   * 第 295 回 – 画面が「読み込んでも増えない」を数え直さずに言えるようにする。 */
  record_deadline_last?: string | null;
  /** 収録の側で一番近い締切の日（品の窓の外も含む – 第 298 回）。 */
  record_deadline_next?: string;
  /** その締切の種別（`abstract` など – 画面の日本語に直す）。 */
  record_deadline_next_kind?: string;
  /** 品書の生成時点で残っていた締切の本数（第 298 回）。 */
  record_deadline_count?: number;
}

interface CandidateRow {
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
}
interface RecommendationEntry {
  key: string;
  row: CandidateRow;
  match: ScoreBreakdown;
  lexicalScore: number;
  semantic: number;
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
  status: "ongoing" | "uncertain" | "open" | "past";
  timestamp: number | null;
  local_date: string | null;
  date_state: "definitely-future" | "uncertain-on-date" | "definitely-past" | null;
  estimated: boolean;
}
interface PdfItem {
  str?: string;
  transform?: number[];
  height?: number;
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
    (value.height === undefined || typeof value.height === "number") &&
    (value.transform === undefined ||
      (Array.isArray(value.transform) && value.transform.every((item) => typeof item === "number")))
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
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        let parts = line.split(/\s*\|\s*/);
        if (parts.length === 1) parts = line.split(/\t+/);
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
        return jsonRows.length ? jsonRows : null;
      } catch (_error) {
        return null;
      }
    }
    // タイトルラベルが 1 つも無ければ構造化入力ではないとみなす（表形式の生テキストを
    // 壊さないため。英語・日本語のどちらのタイトル表記でも通す）。
    if (!/^[\s　]*(title|タイトル|表題|標題|題目|論文名)[\s　]*[:：]/im.test(raw)) return null;
    const fields: Record<string, string> = { title: "", abstract: "", keywords: "", venue: "" };
    let current = "";
    raw.split(/\r?\n/).forEach((line) => {
      const match = PAPER_FIELD_RE_JA.exec(line);
      if (match) {
        current = paperFieldKeyJa(match[1]);
        if (!current) return;
        fields[current] = match[2].trim();
      } else if (current && line.trim()) {
        fields[current] += (fields[current] ? "\n" : "") + line.trim();
      }
    });
    const labeled = normalizePaperRecord(fields);
    return labeled ? [labeled] : null;
  }

  function pdfTextLines(pages: unknown): string[] {
    const pageList: unknown[][] =
      Array.isArray(pages) && Array.isArray(pages[0]) ? pages : [Array.isArray(pages) ? pages : []];
    return pageList
      .flatMap((items) => {
        const groups: Record<string, Array<{ text: string; x: number }>> = {};
        items.forEach((item) => {
          if (!isPdfItem(item)) return;
          const text = String(item.str || "")
            .replace(/\s+/g, " ")
            .trim();
          if (!text) return;
          const transform = item.transform || [];
          const y = Number(transform[5]);
          const x = Number(transform[4]);
          const key = Number.isFinite(y) ? Math.round(y / 2) * 2 : Object.keys(groups).length;
          const group = groups[String(key)] || [];
          groups[String(key)] = group;
          group.push({ text, x: Number.isFinite(x) ? x : 0 });
        });
        return Object.keys(groups)
          .sort((a, b) => Number(b) - Number(a))
          .map((key) =>
            groups[key]
              .sort((a, b) => a.x - b.x)
              .map((item) => item.text)
              .join(" ")
              .trim(),
          );
      })
      .filter(Boolean);
  }

  function pdfPaperRecord(metadata: unknown, pages: unknown, fallbackText: unknown): PaperRecord {
    const pageList: unknown[][] =
      Array.isArray(pages) && Array.isArray(pages[0]) ? pages : [Array.isArray(pages) ? pages : []];
    const lines = pdfTextLines(pageList);
    const metadataRecord = isRecord(metadata) ? metadata : {};
    const info = isRecord(metadataRecord.info) ? metadataRecord.info : metadataRecord;
    let title = String(info.Title || info.title || "").trim();
    if (!title) {
      const first = pageList[0] || [];
      const items = first.filter(isPdfItem);
      const sizes = items.map((item) =>
        Math.abs(Number((item.transform || [])[0]) || Number(item.height) || 0),
      );
      const max = Math.max.apply(null, sizes.concat([0]));
      if (max > 0) {
        title = items
          .filter((_item, index) => sizes[index] >= max * 0.9)
          .map((item) => String(item.str || "").trim())
          .filter(Boolean)
          .join(" ");
      }
    }
    const fallback = String(fallbackText || "").trim();
    if (!title) title = lines[0] || fallback.slice(0, 200);
    title = title.replace(/\s+/g, " ").slice(0, 240);
    const normalized = lines.map((line) => line.replace(/\s+/g, " ").trim());
    const abstractAt = normalized.findIndex(
      (line) => /^abstract\s*[:.]?/i.test(line) || /^概要\s*[:：]?/.test(line),
    );
    const keywordsAt = normalized.findIndex((line) =>
      /^(keywords?|index terms|キーワード)\s*[:：]?/i.test(line),
    );
    const sectionEnd = (start: number) =>
      normalized.findIndex(
        (line, index) =>
          index > start &&
          /^(keywords?|index terms|introduction|references|参考文献|1\.?\s+introduction)\b/i.test(
            line,
          ),
      );
    let abstract = "";
    if (abstractAt >= 0) {
      const abstractStart = normalized[abstractAt]
        .replace(/^abstract\s*[:.]?/i, "")
        .replace(/^概要\s*[:：]?/, "")
        .trim();
      const abstractEnd = sectionEnd(abstractAt);
      abstract = [abstractStart]
        .concat(
          normalized.slice(
            abstractAt + 1,
            abstractEnd < 0
              ? keywordsAt > abstractAt
                ? keywordsAt
                : normalized.length
              : abstractEnd,
          ),
        )
        .filter(Boolean)
        .join(" ");
    }
    const keywords =
      keywordsAt >= 0
        ? normalized[keywordsAt].replace(/^(keywords?|index terms|キーワード)\s*[:：]?/i, "").trim()
        : "";
    return {
      title,
      abstract: abstract.slice(0, 6000),
      keywords: keywords.slice(0, 1000),
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
    if (!title) return null;
    return {
      title: title,
      abstract: String(value("abstract") || value("summary") || "").trim(),
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
  function setPaperVecs(pv: PaperVectorMap | null) {
    paperVecsState = pv || null;
  }

  /* 全会議から IDF 重み表を作る。
   * ブラウザ側はデータロード後にこの結果を setNameIdf に渡す（buildNameIdf で計算）。
   * ベンチの --idf と同じ定義。
   *
   * 代表採択論文語彙（papers）の汎用語（machine/deep/cache 等）は全会議に
   * 現れる。
   * そのまま 1 語 15 点だと会議間で衝突して誤爆する。
   * IDF で減衰すると golden EN（実論文）top1 が 25.0→37.5% に改善した。
   *
   * 実測では次の 2 段階で現在の定義にした。
   * 1. 「名前 + papers 同一 df」だと、papers を追加した会議（rtss/ecrts）の
   *    論文語が名前語の df を汚染し、名前語の IDF が薄まって合成ベンチ top1 が
   *    84.8→76.9 に悪化したため、df を種類別に分離する。
   * 2. それでも「名前にも papers にも出る語」（memory 等）は名前 df を優先したため、
   *    papers マッチでも名前由来の高重みになり、rtss/ecrts の papers 語彙が
   *    無関係クエリ（Beehive の memory、private optimization の optimization）を奪った。
   *    そのため、マッチ元（名前語 / papers 語）ごとに別マップを使う。
   */
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

  function lexicalTerms(value: unknown): string[] {
    const raw = String(value ?? "").toLowerCase();
    if (!raw) return [];
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
    return [...terms];
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
   * （2026-09-23 実測: ランク列の降順で ccf:N の行が先頭に来ていた）。
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

  /* 検索の言いゆれの吸収: 日本の研究者が口にする語を、表に書いてある分野名に寄せる。
   * 「スパコン」は 0 件になるが「高性能計算」は収録済み、という食い違いを防ぐためで、
   * 対応は**画面に出す語（分野名・締切種別・主題タグの表記）そのもの**に向ける。
   * 表の語ではない別名（会議名の中の言葉など）は 寄せない。画面に出る語へ寄せる
   * ことを不変条件にすると、寄せ先が行に見えない語に化ける事故を防げる。
   * 真ん中の語は件数欄に「こう探しました」と出して説明する。理由も見せずに
   * 分野全体の行を並べると、なぜ出たか分からないまま壁になる。
   * 精密な語（`機械学習` など）は寄せない。寄せるのは、そのままでは当たらない語だけにする。
   * 「〜込み」は `組み込み`・`組込み` の 2 表記まで受け、「埋め込み」は置かない
   * （§7 の開発用語を残さない規則と同じ語彙に揃える）。 */
  const QUERY_SYNONYMS_JA: Array<[string, string, string[]]> = [
    /* 裸の `締め` `締切り` `しめきり` は『締切』に**寄せない**（第 344 回で試して棄却）。
     * 『締切』は 872 行中 709 行に当たる表その物の語で、寄せると絞り込みにならない 709 行が
     * 出るだけだった。其れより「この表の全行にあてはまる語なので絞り込めません」と打ち直し方を
     * 言う既の契約が強い（`WHOLE_TABLE_QUERY_JA` – 第 239 回・検査が前提を張っている）。
     * 締切の語を**別の語に繋げて打つ形**（`8月締め`）は絞り込みになるので寄せる –
     * `collapseRelativeDayPhrase` を見る。 */
    /* 種別を打つ人の言い方を増やす（2026-10-03 実測・実ビルドの品書 872 行・固定時刻
     * 2026-08-09T00:00:00Z）。`査読結果` 13 行・`反論` 27 行・`採択通知` 129 行が通るのに、
     * `ピアレビュー結果` **0 行**（`HIDDEN_KIND_ALIASES_JA` に載っていたが、其の表は打たれた
     * 語を語に割って比べるため 3 語に割れて当たっていなかった – 日本語の言い換えの正本は
     * 此処だと下の注が既に書いている）、`反論終了` **0 行**（画面の種別ラベルは
     * `反論期間終了`）。**`リバットル` は寄せない**（実測 0 行で悔しいが、反論期間開始 8 行と
     * 反論期間終了 19 行にまたがる語で、一つの種別へ寄せるのは意味が広がる – 既の判断が
     * 検査で守られている。其の場合は種別の対応を画面に書く道を残す）。 */
    ["ピアレビュー結果", "種別「査読結果公開」", ["査読結果公開"]],
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
      "早割",
      "種別「登録締切」（収録に早期割引の区別は無く、登録の締切を出しています）",
      ["登録締切"],
    ],
    /* 分野の日本語の別の言い方が表に抜けていた（2026-10-17 実測・実ビルドの品書 872 行）:
     * `AI` 331 行・`機械学習` 81 行・`高性能計算` 102 行が通るのに、`生成AI` は **0 行で案内も
     * 無し**だった – 其の方の収録の語は原文の `generative`（1 行 – 実測）。**広く探す道を案内の
     * 中に書く**ので、黙って『AI』の 331 行に広げない（意味の違う行をよけいに出さない – 第 337 回
     * の「黙って別の意味の語に寄せない」）。 */
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
     * 日本語側の `マイクロアーキテクチャ` は既に通るのに、其の親の語が抜けていた）。 */
    [
      "コンピュータアーキテクチャ",
      "原文に computer architecture と書かれた行",
      ["computer architecture"],
    ],
    /* 耐障害性は収録の原文に `fault tolerance` が 1 度も現れない（実測 0 行）ので、其の方で
     * 使われている `reliability`（1 行）へ導す。**無い語を在る様に寄せない**（案内で其の事を言う）。 */
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
    /* 穴場の言い方（2026-10-19 実測・実ビルドの品書 872 行 – 直し前はいずれも **0 行で案内も無し**）。
     * `穴場` は収録の主題タグ `niche` の画面のラベル（`TAG_LABELS_JA`）で 44 行通るので、其の方の
     * 言い方を其処へ寄せる（行を増やさない – 寄せ先の語の行と一字も違わない事を検査に張る）。 */
    ["穴場会議", "主題タグ「穴場」", ["穴場"]],
    ["穴場な会議", "主題タグ「穴場」", ["穴場"]],
    ["隠れ家的な会議", "主題タグ「穴場」", ["穴場"]],
    /* 寄せなかった語（測って決めた – 次の人が同じ所で迷わない様に書く）:
     *   `提出期限` `投稿期限` は其の方の種別ラベル `論文提出` に寄せると **461 行 / 収録 872 行**
     *   （実測 – 半分を超える）で、絞り込みにならない。此のサイトは其の方の形を「表その物を指す語」
     *   として扱い、「其の語では絞れません」と別の文で答える（第 245 回の契約 –
     *   `tests/deadline_day_word.test.ts` と `tests/built_golden_3.test.ts` が其れを守る）。
     *   `小規模` 等も同じ理由で寄せない（規模の印を作らない – 上の案内の群が其のことを言う）。 */
    ["スパコン", "分野「高性能計算」", ["高性能計算", "hpc"]],
    ["スーパーコンピュータ", "分野「高性能計算」", ["高性能計算", "hpc"]],
    ["スーパーコンピューター", "分野「高性能計算」", ["高性能計算", "hpc"]],
    ["スーパーコンピューティング", "分野「高性能計算」", ["高性能計算", "hpc"]],
    ["並列処理", "分野「高性能計算」", ["高性能計算", "hpc"]],
    ["並列計算", "分野「高性能計算」", ["高性能計算", "hpc"]],
    ["分散システム", "分野「システム」", ["システム", "systems"]],
    ["分散処理", "分野「システム」", ["システム", "systems"]],
    ["組み込み", "分野「システム」", ["システム", "systems"]],
    ["組込み", "分野「システム」", ["システム", "systems"]],
    ["クラウド", "分野「システム」", ["システム", "systems"]],
    ["深層学習", "主題「ディープラーニング」", ["ディープラーニング", "deep-learning"]],
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
    ["リモート", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    ["遠隔", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    ["ウェブ開催", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
    ["web開催", "参加形式「オンライン参加可」", ["オンライン参加可", "online"]],
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
    /* 原文の "journal" には**寄せない**（2026-10-03 実測・実ビルドの品書 872 行）:
     * `随時受付` が返す 6 件は**すべて会議名に "Journal" を含む行**（`IJGCA 2026 International
     * Journal of Grid Computing & Applications` など）で、種別『常時受付』の行では無かった
     * （其の種別の行はこの品書に 0 件）。画面の件数欄は「種別『常時受付』で探しています」と
     * 言い、見せる行は別の語で当たっていた – 案内と実物がズレる寄せは削る（第 342 回の
     * 「案内が言った英文字語を全行が含む事を見る」の同じ流儀）。`学会誌` は元々寄せない事に
     * している（上の注）。 */
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
    /* 種別の欄に出る語の言い換え（第 246 回）。2026-08-09 生成ビルドの実測（872 行）で、
     * 打たれた語が 0 行で寄せ先の語が当たることを確かめた語だけを載せている:
     *   `採択通知` `採択` `採択結果` `結果通知` `合否通知` `受理通知` `合否` -> 採否通知 129 行
     *   `最終原稿` `最終稿` `カメラレディ原稿` -> カメラレディ締切 70 行
     *   `登録期限` `事前登録` `登録開始` -> 登録締切 7 行
     *   `レビュー結果` `審査結果` `査読公開` -> 査読結果公開 13 行
     * 寄せていない語も実測で決めた。`最終版` `最終提出` は提出その物の話で論文締切と混じる、
     * `リバットル` は「反論期間開始」（8 行）と「反論期間終了」の二つの語にまたがる、
     * `採択通知日` は日付の打ち直しの話（語のかけ算で直せる）。 */
    ["採択通知", "種別「採否通知」", ["採否通知"]],
    ["採択", "種別「採否通知」", ["採否通知"]],
    ["採択結果", "種別「採否通知」", ["採否通知"]],
    ["結果通知", "種別「採否通知」", ["採否通知"]],
    ["合否通知", "種別「採否通知」", ["採否通知"]],
    ["受理通知", "種別「採否通知」", ["採否通知"]],
    ["合否", "種別「採否通知」", ["採否通知"]],
    ["最終原稿", "種別「カメラレディ締切」", ["カメラレディ締切"]],
    ["最終稿", "種別「カメラレディ締切」", ["カメラレディ締切"]],
    ["カメラレディ原稿", "種別「カメラレディ締切」", ["カメラレディ締切"]],
    ["登録期限", "種別「登録締切」", ["登録締切"]],
    ["事前登録", "種別「登録締切」", ["登録締切"]],
    ["登録開始", "種別「登録締切」", ["登録締切"]],
    ["レビュー結果", "種別「査読結果公開」", ["査読結果公開"]],
    ["審査結果", "種別「査読結果公開」", ["査読結果公開"]],
    ["査読公開", "種別「査読結果公開」", ["査読結果公開"]],
    /* 画面に出る語に「日」が付きただけの打ち方（第 331 回）。検索は打ち込まれた語を収録の
     * 文本に部分一致で当てるので、収録側が「締切」「論文締切」としか書いていない語に「日」が
     * 付くと 1 語も当たらず黙っていた。2026-08-09 生成ビルドの品書 872 行・固定時刻
     * 2026-08-09T00:00:00Z で実測した語だけを載せる:
     *   `提出日` 0 / `提出` 461 行、`投稿日` 0 / `投稿` 461 行、`通知日` 0 / `通知` 129 行、
     *   `採択日` 0 / `採択` 129 行、`登録日` 0 / `登録` 7 行、`会期日` 0 / `会期` 185 行、
     *   `参加登録` 0 / `早期登録` 0（`登録締切` 7 行・原文の "registration" 42 行）。
     *   `early registration`（1 行）は寄せ先に足さない – その 1 行は `登録締切` の 7 行に
     *   既に含まれる（実測で行数が変わらなかった）ので、表に置いても行は増えない。
     * `締切日` `〆切日` `締め切り日` は寄せない – 同じ表に「この語は全行にあてはまるので
     * 絞り込めない」と正直に言う案内が既に有る（`WHOLE_TABLE_QUERY_JA` – 第 245 回の実測:
     * `締切日` 0 行 / `締切` 709 行 – 872 行のうち 709 行へ寄せるのは絞り込みではなく、
     * 件の数だけが増えて読み違えられる）。そちらの案内を生かす。
     * 「日」を検索側で一般的に剥がさない – `今日` `明日` `3日` などの日付の語と衝突するし、
     * 寄せ先の無い語（`会議日` は `会議` も 0 行）に当たって画面が期間を發明する原因になる
     * （締切の推測はしない – AGENTS.md）。寄せ先は上の条目と同じ画面の語に揃える。 */
    ["提出日", "種別「論文締切」", ["論文締切"]],
    ["投稿日", "種別「論文締切」", ["論文締切"]],
    ["通知日", "種別「採否通知」", ["採否通知"]],
    ["採択日", "種別「採否通知」", ["採否通知"]],
    ["登録日", "種別「登録締切」", ["登録締切"]],
    ["参加登録", "種別「登録締切」", ["登録締切", "registration"]],
    ["早期登録", "種別「登録締切」", ["登録締切"]],
    ["会期日", "列「会期」", ["会期"]],
    ["提出", "種別「論文締切」", ["論文締切"]],
    ["抄録締切", "種別「概要締切」", ["概要締切", "abstract"]],
    ["要旨締切", "種別「概要締切」", ["概要締切", "abstract"]],
    ["抄録", "種別「概要締切」", ["概要締切", "abstract"]],
    ["要旨", "種別「概要締切」", ["概要締切", "abstract"]],
    ["アブストラクト", "種別「概要締切」", ["概要締切", "abstract"]],
    ["全文締切", "種別「論文締切」", ["論文締切", "paper"]],
    ["全文", "種別「論文締切」", ["論文締切", "paper"]],
    ["フルペーパー", "種別「論文締切」", ["論文締切", "paper"]],
    ["本論文", "種別「論文締切」", ["論文締切", "paper"]],
    /* 締切の回（ラウンド）の言い方（第 334 回）。画面は各締切に「第1ラウンド」の語を付けていて、
     * それが収録の語だが、打ち手は「第1回」「1回目」「初回」「1次締切」「ラウンド1」と書く –
     * いずれも黙っていた（2026-09-28 実測・2026-08-09 生成の実ビルドの品書 872 行: `第1回` `第2回`
     * `1回目` `初回` `1次締切` `ラウンド2` `1ラウンド目` `第1回締切` すべて **0 行** / 同じ意味の
     * `第1ラウンド` 767 行・`第2ラウンド` 71 行・`第3ラウンド` 15 行・`第4ラウンド` 3 行）。
     * 英語の `round 1`（39 行）は上流の文本にそう書かれた行だけなので、画面の語に寄せる（第 331 回）。
     * 全角の「第１回」は検索語の側が NFKC で畳まるので同じ条目で受ける（2026-09-28 実測）。 */
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
  ];

  /* 検索語が、表に出さない締切種別の表示語に当たるかを聞く（0 件の案内が使う）。
   * 「採否通知」は てびき と件数欄に語が出るのに、表は投稿締切だけを出すため検索すると
   * 0 件になる。収録が無いのだと誤解させないため、区別できる案内を出せるようにする。
   * 当たった種別名を返す（案内側で実名を書くため、真偽値だけでは使えない）。 */
  /* 部分一致では捕まえられない言い方（ラベルと語が噛み合わないものだけ足す）。 */
  /* 表に出さない種別の別名。ここでしか言えない語だけを置く – 画面に出る種別ラベルへの
   * 言い換え（`採択通知` `合否` `結果通知` `最終稿` `最終原稿` `登録期限` `レビュー結果` など）は
   * `QUERY_SYNONYMS_JA` が正本で、上を見る（第 246 回に二箇所で同じ言い換えを持ってしまい、
   * `登録期限` だけが案内から落ちた。実測で検査した）。英文は画面のラベルに対応語が無いので
   * ここに置く。 */
  const HIDDEN_KIND_ALIASES_JA: Record<string, string[]> = {
    カメラレディ締切: ["camera ready", "camera-ready"],
    /* `ピアレビュー結果` はここに載せても当たっていなかった（語に割って比べる表なので
     * 3 語に割れて落ちる – 2026-10-03 実測で 0 行）。日本語の言い換えは `QUERY_SYNONYMS_JA`
     * が正本なのでそちらへ移した（第 246 回 – 二箇所に書いた言い換えは必ずズレる）。 */
    反論期間開始: ["リバットル", "rebuttal"],
    反論期間終了: ["リバットル", "rebuttal"],
  };

  function queryHiddenKindMatches(query: unknown, hiddenKindLabels: readonly string[]): string[] {
    const tokens = queryTokens(query);
    if (!tokens.length) return [];
    /* 言い換えの表（`querySynonymMap`）も通して当てる。第 246 回で「採択」-> 「採否通知」のような
     * 言い換えを `QUERY_SYNONYMS_JA` に載せたが、この側は打たれた語しか見ていなかったため、
     * 検索は寄せているのに案内は種別を名指さない行が生まれた（2026-08-09 生成ビルドの実測:
     * `登録期限` は 登録締切 の 7 行に寄せているのに、案内は「いまの絞り込みで 0 件」と言った）。
     * 同じ言い換えを `HIDDEN_KIND_ALIASES_JA` に二度書くのはやめる（正本は一つ – 二箇所に書いた
     * 言い換えは必ずズレる）。 */
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
    /* 種別ごとに、語がどう当たったかを数える（第 247 回）。
     *  - 語がその物（打たれた語や寄せ先の語が種別の語・別名と一致）なら、その語は種別を区別できる。
     *  - 語の途中で重なる一致（部分一致）は、複数の種別に同時に当たった瞬間に区別ではなくなる。
     *    実測: HEAD のビルドでは `〆切`（正規化で `締切`）が 補足資料締切・カメラレディ締切・
     *    登録締切・締切 の四つに当たり、`反論` は 反論期間開始・反論期間終了 の二つに当たった。
     *    四つ目（種別 `other` の表示語「締切」）は他の種別の語にすっぽり含まれるので、
     *    そもそも名指す語にしない。 */
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
    /* 上流の原文にしか出ていない語を、日本語の言い方で引けるようにする表。画面に対応する語が
     * 無いので `QUERY_SYNONYMS_JA` には載せられない（あの表の展開語は列に出るラベルでなければ
     * ならない。曜日の表と同じ理由で分離する）。並べる語は収録データに実在する物だけにする –
     * 実在しない語を寄せても 0 件のままなので、表に置く意味が無い
     * （2026-08-09 生成ビルドで実測: `ポスター` 0 件なのに原文の poster は 6 行、`デモ` 0 件 /
     * demo 7 行、`チュートリアル` 0 件 / tutorial 6 行、`特別セッション` 0 件 / special session 3 行、
     * `学生セッション` 0 件 / student 1 行）。寄せたことは件数欄に「原文の … という語で探しています」と出す。
     */
    /* 時刻の後に書かれるタイムゾーンの言い方（第 336 回）。行は `20:59 JST` / `AoE` /
     * `UTC-12` のように英文字で状態を書く（2026-09-30 実測・実ビルドの品書 872 行:
     * `JST` 688 行・`AoE` 492 行・`UTC` 176 行・`GMT` 6 行）が、日本語で打つと黙っていた –
     * `日本時間` `日本標準時` `世界標準時` `協定世界時` `グリニッジ標準時` `現地時間`
     * **いずれも 0 行**。受けるのは **行にそのゾーンが書かれた行**だけで、**時刻を変換して
     * 他のゾーンの行を出す事はしない**（下の範囲の案内に書く – 無い物を数えないため）。
     * `現地時間` は寄せない – どの時刻の事かを収録が持たない（行に「現地」の語は 0 回）。 */
    const UPSTREAM_TEXT_QUERY_SYNONYMS_JA: Array<[string, string, string[]]> = [
      ["日本時間", "行の時刻に書かれた JST という語", ["JST"]],
      ["日本標準時", "行の時刻に書かれた JST という語", ["JST"]],
      ["日本標準時間", "行の時刻に書かれた JST という語", ["JST"]],
      ["世界標準時", "行の時刻に書かれた UTC・GMT の語", ["UTC", "GMT"]],
      ["協定世界時", "行の時刻に書かれた UTC・GMT の語", ["UTC", "GMT"]],
      ["グリニッジ標準時", "行の時刻に書かれた UTC・GMT の語", ["UTC", "GMT"]],
      ["グリニッジ平均時", "行の時刻に書かれた UTC・GMT の語", ["UTC", "GMT"]],
      /* 「バーチャル開催」は上流の英文字語でしか書かれていない（2026-09-30 実測・実ビルドの
       * 品書 872 行・固定時刻 2026-08-09T00:00:00Z）: `バーチャル` **0 行**なのに原文の
       * `virtual` は 11 行（`オンライン` 24 行・`ポスター` 6 行は通っていた）。
       * **`口頭` は載せない** – 原文の `oral` を打つと 0 行で、品書に現れる "oral" は別の英字語の
       * 一部（5 箇所）に過ぎなかった（上の決まり – 収録に実在しない語を寄せても 0 件のまま）。
       * 参加形式の「対面」「現地」「リアル」も受けない – 収録に参加形式のラベルが無く、其のことを
       * 上の案内が既に画面に書いている。 */
      ["バーチャル", "原文の virtual という語", ["virtual"]],
      /* 『参加』『開催』を繋げた言い方も同じ語を指す（2026-10-08 実測・実ビルドの品書 872 行）:
       * `バーチャル` 11 行が通るのに `バーチャル参加` **0 行**・`バーチャル開催` **0 行**で
       * 案内も無し（画面は「語「バーチャル参加」は収録データにありません」とだけ読む）。
       * 収録の `virtual` を持つ行と同じ行に会えるので、其の方へ寄せる（対称差 0 – 検査で張る）。
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
      /* 上の `ポスター発表` `ポスター募集` と同じ形の言い方が、催し物の言い方では抜けていた
       * （2026-08-09 生成ビルドで実測・第 234 回: `チュートリアル` 6 件 /
       * `チュートリアル提案` 0 件、`ワークショップ` 126 件 / `ワークショップ提案` 0 件、
       * `セッション` 3 件 / `セッション募集` 0 件、`学生` 1 件 / `学生発表` 0 件）。
       * 寄せ先は素の語と同じで、画面の会議名・募集文にそのまま出る語。 */
      ["チュートリアル提案", "原文の tutorial という語", ["tutorial"]],
      ["チュートリアル募集", "原文の tutorial という語", ["tutorial"]],
      ["ワークショップ提案", "原文の workshop という語", ["workshop"]],
      ["ワークショップ募集", "原文の workshop という語", ["workshop"]],
      ["セッション提案", "原文の session という語", ["session"]],
      ["セッション募集", "原文の session という語", ["session"]],
      ["特別セッション募集", "原文の special session という語", ["special session"]],
      ["学生発表", "原文の student という語", ["student"]],
      ["ポスター提案", "原文の poster という語", ["poster"]],
      /* 会の催し物の言い方。表の行は原文の英文字をそのまま会議名・募集文に載せるので、
       * 日本語で打った人だけ届かなかった（2026-08-09 生成ビルドで実測・第 232 回:
       * `ワークショップ` 74 件 / `workshop` 126 件 – 74 件は種別ラベルが日本語で出ていた行で、
       * 「The 3rd International Workshop on …」のように会議名に書く 52 件が抜けていた。
       * `セッション` 0 件 / `session` 3 件、`学生` 0 件 / `student` 1 件）。寄せ先はいずれも
       * 画面の会議名・募集文にそのまま出る語。`セッション` は部分一致で別語を巻かないことを
       * 実測で確認した（`session` を含む行 3 件は 3 件とも語としての session）。
       * `パネル` は入れていない – 収録で `panel` を書く行は 1 件（IFIP WG 11.9）で、検査が
       * 「寄せた先が空の同義語を置かない」をテスト用の収録データで確かめているため、
       * そこに無い語は置いていない（実データに 1 行ある程度の寄せは、0 件の壁を直す損が
       * 説明しきれない）。`panel` を書く会が収録されたら足す。 */
      ["ワークショップ", "原文の workshop という語", ["workshop"]],
      ["セッション", "原文の session という語", ["session"]],
      ["学生", "原文の student という語", ["student"]],
      ["特別セッション", "原文の special session という語", ["special session"]],
      ["学生セッション", "原文の student という語", ["student"]],
      /* 主題の日本語（推薦の照合では `JP_EN` という対応表で扱っている語）。検索の側には
       * 対応が無く、日本語で打つと 0 件になっていた（2026-08-09 生成ビルドで実測・第 226 回:
       * `アルゴリズム` 0 件 / 会議名に algorithm と書く会 19 行、`自動化` 0 件 / 13 行、
       * `ニューラル` 0 件 / 7 行、`コンテナ` 0 件・`ミドルウェア` 0 件・`オーケストレーション`
       * 0 件 / 各 4 行、`異常検知` 0 件・`マイクロアーキテクチャ` 0 件・`ニューラルネットワーク`
       * 0 件 / 各 3 行、`メモリ` 0 件 / 1 行）。寄せるのは**そのままでは 1 行も当たらない語だけ**
       * （§7 の「精密な語は寄せない」）。対応が `JP_EN` とズレないことは検査が見る。 */
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
      /* 「日」を付けただけの形と、和語の言い方が原文側にしか語の無い形（第 331 回）。
       * 実測（2026-08-09 生成ビルドの品書 872 行）で、打ち込む語が 0 行・寄せ先の語が行を
       * 持つ物だけ: `リアルタイムシステム` 0 / real-time 3 行、`プロシーディング` 0 /
       * proceedings 2 行（長音の書き方が違う 3 通りを並べた）。
       * 寄せない事も実測で決めた – `オンサイト` `対面` `招待講演` は原文の onsite・
       * in-person・invited が 0 行（第 251 回と同じ結論）、`光通信` `サーバレス`
       * `バイオインフォマティクス` `推薦システム` は optical・serverless・bioinformatics・
       * recommender が 0 行なので、表に置く意味が無い。 */
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
      /* 分野の和名（カタカナを含む）で打つ人が、収録があっても行に会えていなかった
       * （2026-09-24 実測・2026-08-09 生成ビルドの品書 872 行。括弧内はそのまま打った時の行数 /
       * 寄せ先の語を書く行数: `画像認識` 0 / 48、`マルチメディア` 2 / 26、`ビッグデータ` 0 / 20、
       * `大量データ` 0 / 20、`知識発見` 0 / 9、`データサイエンス` 0 / 4、`生体` 0 / 7、
       * `バイオ` 0 / 7、`リコメンデーション`・`レコメンデーション`・`レコメンド` 各 0 / 7）。
       * 検証ハーネスの品書（863 行）でも 11 語のうち 10 語が 0 行で、`マルチメディア` だけ 2 行
       * だった（同じ形）。行は原文の英文字をそのまま会議名に載せるので、日本語で打った人
       * だけ壁になっていた（`ワークショップ` と同じ形 – 第 232 回）。
       * 寄せ先はいずれも画面の会議名・募集文にそのまま出る語（画面に出る語への寄せという
       * 不変条件）。精密な語（`コンピュータビジョン` は 43 行当たる、`推薦` は 7 行当たる）は
       * 寄せない。`音声認識`・`医療情報`・`自動運転` は寄せ先の語自体が収録に無いので置かない
       * （0 件の壁は直らないため）。 */
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
      /* 分野の名を**修飾を付けた長い形で打つ人**が、画面に出ている分野名その物を打った人より
       * 少ない行にしか会えていなかった（2026-09-25 実測・2026-08-09 生成ビルドの品書 872 行。
       * `長い形を打った行数 / 分野名を打った行数`）:
       *   `情報セキュリティ` 2 / 152、`暗号学` 0 / 31、`理論計算機科学` 0 / 45、
       *   `理論コンピュータ科学` 0 / 45、`音声認識` 0 / 3、`統計学` 0 / 3。
       * 検索は打たれた語を行の中に見つける仕事なので、`情報セキュリティ` は画面の `セキュリティ` を
       * 含む行でも外れる（区切りの概念が無い）。寄せ先は**画面に出る分野名**か、**その行の原文に
       * 出ている語**に限る（不変条件 – 件数欄に出す説明が嘘にならない方を選ぶ）。実測で分かった:
       * 画面の分野名は `セキュリティ` `音声` の 2 語だけ（`計算理論` は在るが `理論` `暗号` `統計` は
       * 分野名として出ていない – 測らずに「分野名の …」と書くと件数欄の説明が嘘になる – §8）。
       * なので `暗号学` `統計学` `音声認識` は行の原文に出る語へ直接寄せ（`音声` `統計` の和名経由の
       * 寄せは、其の和名自身の寄せ語に依存する連鎖になるので避け、原文の語を直接寄せ先にしている）、
       * `暗号学` だけは寄せ先を `暗号` の 1 語に絞った – `暗号` 自身の寄せが英字の別表記を含むので
       * 当たり集合は 31 行で同じ（実測 – 余計な行 0）なのに、説明に其の英字の語をそのまま書くと、
       * 検査ハーネスの `node -e` が其の語を契機にソースをモジュール扱いにして落ちる（AGENTS.md に
       * 載る既知の罠 – 回避策は文字列リテラル其の物にしか効かず、説明文中の同語は守らない）。
       * 件数欄の説明は短く正直に `暗号` までとし、英文字の寄せは `暗号` 側の説明に任せる。
       * `理論計算機科学` は分野名 `計算理論`（44 行）に加えて原文の `理論`（45 行 – 1 行は
       * `計算理論` とは書かれない）にも寄せる。精密な長い形は置かない: `ネットワークセキュリティ` は 3 行当たり
       * 自体が成り立っている（`ネットワーク` 75 行と `セキュリティ` 152 行の両方に寄せると、
       * 求めた範囲より広い結果になって精密さを失う）。`組込みシステム` 0 行、`情報工学` 0 行、
       * `計算機科学` 0 行、`コンピュータ科学` 0 行は、寄せ先の分野名が収録に無いので置かない
       * （0 件の壁は直らない – 第 306 回と同じ判断）。
       * 第 306 回の注記は `音声認識` を「寄せ先の語自体が収録に無い」と置いていなかったが、其の時の
       * 判断は英文字の語（`speech` を会議名に書く行）を見たもので、**画面の分野名 `音声` は
       * 収録に 3 行在った**（実測で訂正 – §8）。 */
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
      /* 開催地の州名を日本語で打った人。画面の開催地は公式の英語表記（`Atlanta, Georgia, USA`）を
       * そのまま載せるので、州名は行の原文に英文字で出ていて、日本語の州名を打った人だけが
       * 壁に当たっていた（第 309 回で 7 州を寄せた – `テキサス` 0 / 3、`ジョージア` 0 / 8 など）。
       * 第 310 回の実測（同じ品書 872 行）で、州名を寄せても届かない行がいちばん多い形が分かった
       * – 開催地は州を郵便略記で書くことがある（`Chicago, IL, USA`）。和名で打った行数 /
       * 開催地に略記を書く行数: `イリノイ` 0 / 57（フル名 illinois を書く行は 0 行で、略記にしか
       * 先が無い）、`カリフォルニア` 11 / 38、`フロリダ` 0 / 9（フル名 florida は 0 行）、
       * `コロラド` 5 / 8、`ワシントン` 4 / 6、`マサチューセッツ` 0 / 4、`メリーランド` 0 / 3。
       * そこで略記も寄せ先に足した。略記は余計な行を呼ばない – 略記その物を検索語として打った
       * 行数は、開催地に其の略記を独立の語として書く行数と一致した（`il` 57 / 57、`ca` 38 / 38、
       * `fl` 9 / 9、`ga` 5 / 5、`co` 8 / 8、`wa` 6 / 6、`ma` 4 / 4、`md` 3 / 3）。
       * 略記を寄せ先にしない語: `or`（オレゴン）は英語の接続詞に当たって寄与外 2 行を出した
       * （実測: 開催地に or を書く 0 行 / 検索 2 行 – `Montréal, Canada` と `Lucca, Italy`）ので
       * 英文字のまま引くのに任せる。`tx` `az` `va` `pa` は開催地に書く行が 0 行なので足さない
       * （フル名で足りる）。`オンタリオ` は開催地に其の語を書く行が 0 行、`on` は 662 行に当たる
       * 英語の語なので置かない。`ワシントン` は第 309 回で「そのまま 4 行当たるので置かない」と
       * 書いたが、`WA` で書く行が 6 行あるので置き直す（D.C. の行は `Washington DC, USA` の形で
       * `washington` を含むので `dc` は足さない）。`ユタ` は置かない – 小文字と長音の折り合わせで
       * `コンピュータ` を含む行に当たり 51 行を出す（開催地に utah を書く行は 11 行）。`ハワイ` も
       * 置かない – 開催地に Hawaii を書く行が 0 行で、`ホノルル` はそのまま 4 行当たる。 */
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

  /* この表その物を指す語（第 239 回）。表は締切を並べた物なので「締め切り」は全行に
   * あてはまるが、行の文字列には現れない（種別の欄は「論文締切」「概要締切」など語が
   * 違う）。2026-08-09 生成ビルドで実測（収録 863 行）:
   *   `締め切り` `締切り` `締切日` `提出期限` はいずれも 0 件 / `締切` は 700 行。
   * 0 件のまま「該当する締切はありません」とだけ出すと、この表に締切が無いと読める。
   * 当てるのは検索語まるごとの一致だけにする – 「締め切り 関西」のように他の語を足した
   * 人は打ち直しが効いている側の話で、語を名指すのは的外れになる。 */
  const WHOLE_TABLE_QUERY_JA = [
    /* 「8月締め」のように別のの語に繋げて打たれる時は絞り込みになるので受ける（第 344 回）。
     * 裸で打たれた時は 0 行のまま放置されていた（2026-10-02 実測・実ビルドの品書 872 行:
     * `締め` **0 行**で件数欄の案内も無し – 同じ意味の `締め切り` だけ案内が出ていた）。 */
    "締め",
    "締め切り",
    "締切り",
    "しめきり",
    "締切日",
    /* 写法の違う形も同じ判断にする（第 331 回の実測: `〆切日` `締め切り日` は 0 行で、
     * 「絞り込めない」と言う案内も立たず、ただの 0 件画面だった – 同じ意味の `締切日` だけ
     * 案内が出ていた）。絞り込みにはならないという判断は書き方に依存しない。 */
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
    // ひらがなで打つ人と同じ判断をするための生字（`wholeTableQueryWordJa` は小文字化だけで
    // 比べる – 第 239 回の方針）。片仮名は `kanaFold` が折るので書かなくていい。
    "かいぎ",
    "たいかい",
  ];

  /**
   * 検索語がこの表その物を指す語のとき、打たれた語を返す（そうでなければ空）。
   * 小文字化と前後の空白だけ整える – `kanaFold` に寄せると、漢字の語に対して
   * 不要な依存（発音記号の表）を検査側に押し付けることになる。
   */
  function wholeTableQueryWordJa(query: unknown): string {
    const q = String(query == null ? "" : query)
      .trim()
      .toLowerCase();
    if (!q) return "";
    const hit = WHOLE_TABLE_QUERY_JA.find((word) => word.toLowerCase() === q);
    return hit || "";
  }

  /** 0 件の画面に出す打ち直し方（読み上げ側の短い文も同じ語列表から作る）。 */
  function wholeTableQueryNoteJa(query: unknown): string {
    const word = wholeTableQueryWordJa(query);
    if (!word) return "";
    return (
      ` 「${word}」はこの表の全行にあてはまる語なので、検索では絞り込めません。` +
      "会議名（`SC`）・分野（`セキュリティ`）・開催地（`パリ`）のように、表の欄に出る語で打ってください。"
    );
  }

  /* 欄の名前その物を打つ人（第 244 回）。値ではなく軸の名前なので 1 行も減らないのに、
   * 画面は「その語は収録に無い」と言っていた。2026-08-09 生成ビルドの実測（872 行）:
   * `分野` `テーマ` `分類` `種別` `種類` `ステータス` `参加形式`
   * `会場` `地域` `都道府県` はいずれも 0 件で、値の語（`セキュリティ` 152 件・
   * `論文締切` 461 件・`オンライン参加可` 24 件・`アジア` 143 件）は当たっていた。
   * 「カテゴリ」「カテゴリー」も 0 件だったが、打たれた語を案内に書き返すため、この画面で
   * 使ってはいけない語を並べる検査（開発用語を残さない検査）に当たるので載せない。
   * 値の例は画面に出る語だけを書く（別の検査が「例に挙げた語が本当に当たりを持つこと」を
   * 見ている）。`ランク` 847 件・`会期` 185 件・`開催地` 180 件は当たりがあるので載せない。 */
  const COLUMN_VALUE_EXAMPLES_JA: Record<string, string[]> = {
    分野: ["セキュリティ", "機械学習", "高性能計算"],
    種別: ["論文締切", "概要締切"],
    参加形式: ["オンライン参加可"],
    開催地: ["国内", "米国"],
    地域: ["アジア", "ヨーロッパ"],
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
    ["都道府県", "開催地"],
    ["地域", "地域"],
  ];

  function columnQueryEntry(query: unknown): [string, string] | null {
    const q = String(query == null ? "" : query)
      .trim()
      .toLowerCase();
    if (!q) return null;
    const hit = COLUMN_QUERY_WORDS_JA.find(
      ([word, column]) => word.toLowerCase() === q || column.toLowerCase() === q,
    );
    return hit ? [hit[0], hit[1]] : null;
  }

  /** 検索語が欄の名前のとき、打たれた語を返す（読み上げの分岐が使う）。 */
  function columnQueryWordJa(query: unknown): string {
    const hit = columnQueryEntry(query);
    return hit ? hit[0] : "";
  }

  /** 0 件案内に出す打ち直し方（値の例は収録に実在する語だけ – 検査がそれを見る）。 */
  function columnQueryNoteJa(query: unknown): string {
    const hit = columnQueryEntry(query);
    if (!hit) return "";
    const examples = (COLUMN_VALUE_EXAMPLES_JA[hit[1]] || [])
      .map((word) => `「${word}」`)
      .join("・");
    const column = hit[0] === hit[1] ? "この表の欄" : `この表の欄（${hit[1]}）`;
    return (
      ` 「${hit[0]}」は${column}の名前で、値その物ではありません。` +
      `値で打ってください（例: ${examples}）。`
    );
  }

  /** 読み上げ側の短い文（同じ表から作り、画面と読み上げが別のことを言わないようにする）。 */
  function columnQueryLiveNoteJa(query: unknown): string {
    const hit = columnQueryEntry(query);
    if (!hit) return "";
    const first = (COLUMN_VALUE_EXAMPLES_JA[hit[1]] || [])[0] || "";
    const column = hit[0] === hit[1] ? "欄" : `欄（${hit[1]}）`;
    return `「${hit[0]}」は${column}の名前です。値（「${first}」など）で打ってください`;
  }

  /* 画面自身の操作・説明・出典にあたる語（第 248 回）。表の値ではないので 1 行も減らないのに、
   * 画面は「その語は収録データにありません」としか言わなかった。2026-08-09 生成ビルドで実測
   * （候補 3,253 行に対して当たり 0 件、言い換えの案内も無し）: `使い方` `ヘルプ` `てびき`
   * `つかいかた` `みかた` `並び替え` `並び順` `絞り込み` `フィルタ` `条件` `一覧` `確定`
   * `出典` `一次情報` `カテゴリ` `カテゴリー` `ラベル` `フィールド`。
   * 案内が名指す画面の語は、ビルド済みの index.html に実在するものだけにする
   * （『見方のてびき』『データ源』『並び順』『条件クリア』 – 検査が実在を見る）。
   * `カテゴリ` `カテゴリー` はこの画面で使わない語なので、打たれた語を文に織り込まない
   * （第 244 回で欄の名前の表に載せられなかった分の救済）。 */
  /* `quiet` に置いた語は案内に書き返さない（この画面の説明文に書かない実装側の語なので、
   * 開発用語を残さない検査に当たる – `カテゴリ` 系と同じ扱い）。主語の無い文で同じことを言う。 */
  const UI_WORD_GROUPS_JA: Array<{
    words: string[];
    echo: boolean;
    note: string;
    live: string;
    quiet?: string[];
    noteQuiet?: string;
    liveQuiet?: string;
    /* 語を並べて打たれた時にも案内を出す（第 354 回）。第 250 回頃は語を並べた打ち方に
     * 案内を出さなかった – 『更新頻度 2026』『印刷 関西』の打ち手は複合の絞り込みをしていて、
     * 画面の使い方の案内を被せるのが邪魔だった（其の検査は其侭通す）。
     * 「この表が其の情報を持っていない」を告げる組（費用・区分・締切の確定・祝日・参加形式）は、
     * 其の情報で行を引こうとして 0 件に嵌まっているので、語を並べても其のことを伝える。 */
    multiword?: boolean;
    /* 立てた語に行が当たるかに関わらず件数欄に出す（第 323 回 – 当たりが行に有る語は
     * 0 件案内では届かない）。 */
    always?: boolean;
  }> = [
    {
      words: ["使い方", "ヘルプ", "てびき", "つかいかた", "みかた", "確定"],
      echo: true,
      note: "はこの表の語ではなく、ページの下にある『見方のてびき』に書いています。検索では絞り込めません。",
      live: "は下の『見方のてびき』に書いています（検索では絞れません）",
    },
    {
      /* 並べ替えを訊く語（第 338 回）。第 248 回の案内は『並び順』という「欄」へ送っていたが、
       * その欄は存在しない – 並び順は**列の見出しを押す**操作（`site/template.html` の
       * `th[data-sort]` と、狭い画面に出る並べ替えの欄 `button[data-sort]`。2026-09-30 実測で
       * 並び替え系の語 `早い順` `近い順` `会議名順` `新しい順` `ソート` `昇順` など 17 語は
       * 0 行・案内も無く、`並び順` `並び替え` だけが**在らない場所へ送っていた**）。
       * 案内が名指す見出しは、ビルド済み一覧に実在する物だけにする（検査が `data-sort` を見る）。 */
      words: [
        "並び替え",
        "並び順",
        "並べ替え",
        "ソート",
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
      ],
      echo: true,
      note: "はこの表の語ではなく、列の見出し（『残り』『日時』『会期』『会議』『ランク』）を押して操作します。狭い画面では表の上に出る並べ替えの欄を使います。検索欄には打ち込まないでください。",
      live: "は列の見出し（『残り』『日時』など）で操作します",
    },
    {
      /* 期間を曖昧に訪ねる語（第 339 回）。2026-09-30 実測・固定時刻 2026-08-09T00:00:00Z で
       * `当面` `しばらく` `近いうち` `直近` `間もなく` `早め` `締切の近い` `いつまで` は
       * すべて 0 行・案内も無し。画面には締切日からの日数で絞る欄（`site/template.html` の
       * `<label for="win">締切まで</label>` + `<select id="win">` の選択肢）が在るので、其の名前を
       * 書いて渡す（案内が名指す選択肢は検査がビルド済み一覧の `<option>` を読んで照合する –
       * 第 338 回の手順）。 */
      words: [
        "当面",
        "しばらく",
        "近いうち",
        "近い内",
        "直近",
        "間もなく",
        "早め",
        "締切の近い",
        "いつまで",
      ],
      echo: true,
      note: "という曖昧な幅では絞り込めません。上の『締切まで』の欄（『7 日以内』『30 日以内』『90 日以内』『180 日以内』）で締切日からの日数を選んでください。この欄は締切日からの日数で、会期の長さではありません。",
      live: "は曖昧な幅では絞れません。上の『締切まで』の欄（『7 日以内』『30 日以内』など）で日数を選んでください",
    },
    {
      /* 人気という順は無い – 在る順の名前を並べて答える（第 338 回）。 */
      /* `評価順` `締切順` も同じ（2026-10-16 実測: `古い順` `遠い順` は案内が出るのに、
       * この二つは **0 行で案内も無し** – 表に語が抜けただけ）。 */
      words: ["人気順", "人気", "おすすめ順", "注目順", "評価順", "締切順"],
      echo: true,
      note: "という順はこの表にありません。並べ替えられるのは列の見出し（『残り』『日時』『会期』『会議』『ランク』）です。",
      live: "という順はありません。並べられるのは列の見出し（『残り』『日時』『会期』『会議』『ランク』）です",
    },
    {
      /* 絞り込みを訊く語 – こちらは本当に欄の操作（`種別` `ランク` `締切まで` `条件クリア`）。 */
      words: ["絞り込み", "フィルタ", "条件"],
      echo: true,
      note: "はこの表の語ではなく、上にある欄（『種別』『ランク』『締切まで』『条件クリア』）で操作します。検索欄には打ち込まないでください。",
      live: "は上にある欄で操作します（検索欄には打ち込まないでください）",
      quiet: ["フィルタ"],
      noteQuiet:
        "操作はこの表の話ではなく、上にある欄（『種別』『ランク』『締切まで』『条件クリア』）で行います。検索欄には打ち込まないでください。",
      liveQuiet: "操作は上にある欄（『種別』など）で行います。検索欄には打ち込みません",
    },
    {
      /* 参加形式の「対面」側で打たれる語（第 249 回）。2026-08-09 生成ビルドで実測:
       * `対面` `対面開催` `オフライン` `オンサイト` `現地` `現地開催` `リアル` `リアル開催` は
       * いずれも 0 行で、`対面` は `data.json` に 1 度も現れない（収録していない事実）。
       * オンライン側（`ハイブリッド` `リモート` `遠隔` など）は `QUERY_SYNONYMS_JA` で
       * 『オンライン参加可』に寄せるので、そちらは行が出て案内は要らない。
       * `仮想` は寄せない – 「仮想マシン」等の会議名に当たり、行をよけいに出す（第 246 回の
       * `virtual` と同じ理由）。 */
      words: [
        "対面",
        "対面開催",
        /* 『参加』『のみ』を繋げた言い方（2026-10-08 実測・実ビルドの品書 872 行）:
         * 上の八つの語は案内が出るのに、`対面参加` `対面のみ` `オフライン参加` `オフライン開催`
         * `オンサイト参加` `オンサイト開催` `現地参加` `リアル参加` はいずれも **0 行で案内も無し**
         * （画面は「収録データにありません」とだけ読む）。収録に対面の印が無い事は同じなので、
         * 同じ案内を出す（0 行の侭 – 行を作らない – 第 249 回と同じ決まり）。 */
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
        /* オンライン側の『のみ』『だけ』も同じ（2026-10-16 実測・実ビルドの品書 872 行）:
         * `ハイブリッド` は synonym で『オンライン参加可』に寄って 24 行通るのに、
         * `ハイブリッドのみ` `ハイブリッドだけ` `オンラインだけ` `対面だけ` は **0 行で案内も無し**
         * （『のみ』を繋げると語が割れず synonym に届かない – 第 249 回と同じ形）。収録に
         * 対面の印が無い事は同じなので同じ案内を出す（行を作らない）。 */
        "ハイブリッドのみ",
        "ハイブリッドだけ",
        "オンラインだけ",
        "対面だけ",
        /* 会場の言い方（2026-10-19 実測 – `会場参加` `現地対面` は 0 行で案内も無し、
         * `対面参加` `現地参加` は同じ群の案内が出ていた）。 */
        "会場参加",
        "現地対面",
      ],
      multiword: true,
      echo: true,
      note: "は参加形式の言い方ですが、この表は参加形式の印として『オンライン参加可』だけを出していて、対面かどうかは収録していません。オンラインで参加できる行は『オンライン参加可』で探せます。",
      live: "参加形式は『オンライン参加可』の印だけです。対面は収録していません",
    },
    /* 収録していない情報を訪ねる語（第 337 回）。第 325 回で来歴の語を直したこの表の、
     * 手をつけていない残りの語群。2026-09-30 実測（2026-08-09 生成の実ビルド・品書 872 行・
     * 固定時刻 2026-08-09T00:00:00Z）で、下の語は**すべて 0 行・案内も無し**、読み上げは
     * 「語「参加費」は収録データにありません」とだけ言っていた（`site/app.ts` の収録に無い語の文）。
     * 真実だが役に立たない – 無い物を無いと言いつつ、何を収録しているかを言っていなかった。
     * `未定` は受けない – 実測で 6 行当たる（行の原文に其の語が現れる）ので「収録に無い」が噓になる。 */
    {
      /* 参加費・登録費まわり。収録に費用の欄は無い（実測で `参加費` `登録費` `費用` `無料`
       * `有料` `経費` `旅費` `学生割引` `キャンセル料` いずれも 0 行）。 */
      words: [
        "参加費",
        "参加費用",
        "参加料",
        "登録費",
        "費用",
        "参加費無料",
        "登録費無料",
        "無料",
        "有料",
        "経費",
        "旅費",
        "学生割引",
        "キャンセル料",
        /* 旅費・補助・支援（2026-10-16 実測・実ビルドの品書 872 行）: `旅費` は案内が出るのに、
         * `渡航費` `旅費支援` `旅費補助` `補助` `補助金` `学生支援` `travel grant` は
         * **0 行で案内も無し**だった（其の方の群に語が抜けただけ – 第 348 回）。`支援` 単独は
         * 実測 3 行あるので当たりなので群に入れない（「収録に無い」が噓になる – 第 337 回）。 */
        "渡航費",
        "旅費支援",
        "旅費補助",
        "補助",
        "補助金",
        "学生支援",
        "travel grant",
        /* 空格で並べた形（`travel grant 関西`）は語に割れて届くので、部品も受ける
         * （`travel` `grant` はいずれも実測 0 行 – 「収録に無い」が噓にならない – 第 337 回、
         * 語を並べた形は第 354 回の合図 `multiword` で受ける）。 */
        "travel",
        "grant",
      ],
      multiword: true,
      echo: true,
      note: "はこの表が持っていません。収録するのは締切日・会議名・開催地・参加形式の印（『オンライン参加可』）・分野・等級だけで、費用の欄はありません。参加費は各会議の公式ページに書いてあります。",
      live: "は収録していません（費用の欄はありません。公式ページをご覧ください）",
    },
    {
      /* 半導体・チップの語（2026-10-17 実測・実ビルドの品書 872 行）: `プロセッサ` `半導体`
       * `半導体設計` `集積回路` `VLSI` `チップ` `回路設計` はいずれも **0 行で案内も無し**、
       * 品書の文本にも現れない（`processor` 0 箇所 – 実測）。催し物その物が収録に無いので
       * 寄せ先は無く、**近い道を教えるだけ**にする（『コンピュータアーキテクチャ』7 行・
       * 『アーキテクチャ』2 行 – 実測で 0 でない事を張った）。 */
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
      note: "では絞りません。この表が収録する催し物に其の語は現れません（半導体・チップその物の催し物を収録していません）。近い分野として通るのは『コンピュータアーキテクチャ』と『アーキテクチャ』です。",
      live: "では絞りません – 半導体やチップその物の催し物は収録に無いです。近いのは『コンピュータアーキテクチャ』『アーキテクチャ』です",
    },
    {
      /* 招待状・賞・若手など、この表が持っていない情報（2026-10-16 実測・実ビルドの品書
       * 872 行）: `招待状` `招聘状` `ビザ` `若手` `若手研究者` `若手セッション` `ベストペーパー`
       * `優秀論文` `賞` はいずれも **0 行で案内も無し**、読み上げは「其の語は収録データに
       * ありません」とだけ言う（`site/app.ts` の収録に無い語の文）。真実だが役に立たない –
       * 無い物を無いと言いつつ、何を収録しているか言っていなかった（第 337 回と同じ型）。
       * `学生セッション` は実測 1 行あるので当たり、`支援` も 3 行あるので当たり – 群に入れない。 */
      words: [
        "招待状",
        "招聘状",
        "ビザ",
        "若手",
        "若手研究者",
        "若手セッション",
        "若手ワークショップ",
        "ベストペーパー",
        "優秀論文",
        "賞",
        /* 賞の語は「賞」一文字しか持っていなかった（2026-10-18 実測・実ビルドの品書 872 行 –
         * `論文賞` `優秀論文賞` `最優秀論文賞` `最優秀賞` `デモ賞` `授賞式` `表彰` `受賞`
         * `受賞講演` `学生ボランティア` はいずれも **0 行で案内も無し** – 「賞」は案内が在ったのに
         * 其の方の語は完全一致しか見ないので黙っていた）。其の方の群が「其れらを書く欄は
         * ありません」と言うので、語だけを足す。 */
        "論文賞",
        "優秀論文賞",
        "最優秀論文賞",
        "最優秀賞",
        "デモ賞",
        "授賞式",
        "表彰",
        "受賞",
        "受賞講演",
        "学生ボランティア",
      ],
      multiword: true,
      echo: true,
      note: "はこの表が持っていません。収録するのは締切日・会議名・開催地・参加形式の印（『オンライン参加可』）・分野・等級だけで、其れらを書く欄はありません。各会議の公式ページに書いてあるので、行の詳細に出る公式ページからご覧ください。",
      live: "は収録していません（其れらを書く欄はありません。行の詳細に出る公式ページをご覧ください）",
    },
    {
      /* 催し物の「呼び方」を打つ人（第 361 回）。実測（2026-10-18 – 実ビルドの品書 872 行）:
       * `研究会` 23 行・`ワークショップ` 126 行・`学会` 24 行・`シンポジウム` 3 行が通るのに、
       * `大会` `全国大会` `年会` `例会` `セミナー` `講演会` `講習会` `集会` は **0 行で案内も無し**
       * だった（其の呼び方の催し物を収録していない – 収録するのは締切を機械で読める会議・
       * ワークショップ）。**通る呼び方へ導すだけ**で、行の語を足し直さない（収録の契約）。
       * 「其の語は現れません」という言い方にする – `大会研究会` の様に一部の語が当たりになり得る
       * 形で「其の呼び方は収録に無い」とは言えない（第 358 回の「当たりを収録に無いと言わない」）。 */
      words: ["大会", "全国大会", "年会", "例会", "セミナー", "講演会", "講習会", "集会"],
      multiword: true,
      echo: true,
      note: "では絞りません。この表が収録する催し物に其の語は現れません（其の呼び方の催し物を収録していません）。近い呼び方として通るのは『研究会』『ワークショップ』『学会』『シンポジウム』です。",
      live: "では絞りません – 其の呼び方の催し物は収録に無いです。近いのは『研究会』『ワークショップ』『学会』『シンポジウム』です",
    },
    {
      /* 学協会・機関の名前で行を引こうとする人（第 361 回）。実測（同じ品書）: `情報処理学会`
       * 11 行・`電子情報通信学会` 13 行・`情報通信学会` 13 行・`学会` 24 行が通るのに、
       * `人工知能学会` `情報処理推進機構` は **0 行で案内も無し** – 其の機関の催し物が収録に無い
       * （無い物を無いと言う – 収録の語をでっち上げない）。其の方の学会は通るので、**群の文は
       * 「其の語は現れません」に留める**（学会一般が無い事にはしない）。 */
      words: ["人工知能学会", "情報処理推進機構"],
      multiword: true,
      echo: true,
      note: "では絞りません。この表が収録する催し物に其の語は現れません（其の学協会・機関の催し物を収録していません）。近い道は分野で絞る事で、通るのは『人工知能』と『セキュリティ』です。",
      live: "では絞りません – 其の学協会・機関の催し物は収録に無いです。『人工知能』『セキュリティ』の分野で絞れます",
    },
    {
      /* 催し物の**規模**を訊く語（第 362 回）。実測（2026-10-19 – 実ビルドの品書 872 行）:
       * `小規模` `小規模会議` `小規模な会議` `小規模ワークショップ` `アットホームな会議` はいずれも
       * **0 行で案内も無し**だった – この表は規模の印を持っていない（行の属性は締切日・会議名・
       * 開催地・参加形式の印・分野・等級・主題タグ – 第 358 回と同じ型）。近い道は主題タグ『穴場』
       * （44 行 – 此の表が「小さくて狙い目の会」と付けているタグ – `TAG_LABELS_JA` の `niche`）。
       * `大規模` は実測 1 行あるので当たり – 群に入れない（当たりを収録に無いと言わない）。 */
      words: ["小規模", "小規模会議", "小規模な会議", "小規模ワークショップ", "アットホームな会議"],
      multiword: true,
      echo: true,
      note: "はこの表が持っていません（催し物の規模の印を収録していません）。近い道は主題タグ『穴場』で絞る事で、其の方の語は通ります。",
      live: "は持っていません – 規模の印は無いです。近いのは主題タグ『穴場』です",
    },
    {
      /* 締切の**近さ**を日本語のまわし言葉で訊く語（第 362 回）。実測（同じ品書）: `今週` 19 行・
       * `来週` 53 行・`明日締切` 3 行・`延長締切` 21 行が通るのに、`締切間近` `締切目前`
       * `締切が近い` `近い締切` `間近の締切` は **0 行で案内も無し**だった。此の表は「近い」の幅を
       * 勝手に決めない（締切の推測をしない – AGENTS.md の収録の契約）ので、**画面に実在する
       * 『締切まで 7 日以内』のボタン**（`site/template.html` の `data-preset="7d"` – 第 319 回
       * 「画面の語は画面の正本から読む」）と、其の方の語を通る順の名前を教えるだけにする。 */
      words: ["締切間近", "締切目前", "締切が近い", "近い締切", "間近の締切"],
      multiword: true,
      echo: true,
      note: "では絞りません。この表は『近い』の幅を勝手に決めません（締切の推測をしない決まり）。画面には『締切まで 7 日以内』のボタンが在って其れが近い行を出しますし、検索の語では『今週』『来週』『明日締切』が通ります。",
      live: "では絞れません – 近いの幅は決まりません。『締切まで 7 日以内』のボタンか『今週』『来週』で",
    },
    {
      /* 締切の状態を訊く語（2026-10-16 実測）: `締切延長` 21 行・`未定` 6 行・`締切未定` 4 行が
       * 通るのに、`延長した締切` `未確定の締切` `確定していない締切` は **0 行で案内も無し**。
       * この表は延伸の印も確定の印も持たない（収録するのは公式ページに書かれた締切日 –
       * 締切の推測をしない – AGENTS.md の収録の契約）。其の方の打ち方を通すので、**案内は其の方の
       * 語へ導すだけ**にする。 */
      words: ["延長した締切", "未確定の締切", "確定していない締切", "確定済みの締切"],
      multiword: true,
      echo: true,
      note: "では絞れません。この表は締切の延伸や確定の印を持っていません（収録するのは公式ページに書かれた締切日だけで、日付を推測しない決まりです）。延伸について書いた行は『締切延長』で、日付が定まっていない旨を書いた行は『未定』で出ます。",
      live: "では絞れません – 延伸や確定の印は無いです。『締切延長』『未定』で絞ってください",
    },
    {
      /* 催し物の格を日本語のまわし言葉で打つ人（第 357 回）。実測（2026-10-15 – 実ビルドの品書
       * 872 行）: `A*` 159 行・`A` 320 行・`穴場` 44 行が通るのに、`メジャー` `主要会議` `主要`
       * `トップ会議` `トップジャーナル` `有力会議` `ハイクラス` `一流` `ランキング` `有名な会議`
       * はいずれも **0 行で案内も無し**だった。この表は評価を `ランク`（A*・A・B・C – 画面の
       * 選択欄の名前 – 第 319 回「画面の語は画面の正本から読む」）で持つので、其れが絞りになる。
       * **其の方の絞りへ導すだけ**で、格の語を行に付け足さない（収録の契約 – 締切の推測をしない）。 */
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
        "ランキング",
        "ランキング順",
        "有名な会議",
      ],
      multiword: true,
      echo: true,
      note: "では絞れません。この表は催し物の評価を行の『ランク』（A*・A・B・C）で持っていて、其れが絞りになります。上の『ランク』の選択欄か『A*ランク』のクイック抽出のボタンで絞れますし、検索欄に『A*』や『A』と打つ形でも絞れます。",
      live: "では絞れません – 評価は『ランク』の選択欄か『A*ランク』のクイック抽出、検索欄に『A*』『A』と打つ形で絞ってください",
    },
    {
      /* 月の前半という言い方（第 356 回）。実測 `月前半` **0 行**・`8月前半` は 0 行で案内も無し
       * （`8月上旬` 35 行・`8月中旬` 74 行が通る）。**寄せない** – 前半が 15 日までを指すのか
       * 上旬（1〜10 日）を指すのかに公用の決まりは無いので、上旬に寄せるのは幅を狭める事になる。 */
      words: ["月前半", "月前半締切", "月前半の締切", "前半の月"],
      multiword: true,
      echo: true,
      note: "では絞れません。月の前半が何日までを指すか（上旬の 10 日まで・半分までの 15 日）には公用の決まりが無いので、画面は勝手に絞りません。初めの 10 日を打つ（『上旬』）、中旬を打つ（『中旬』）、其の日を打つ（『1日』『5日』）が出来ます。",
      live: "では絞れません – 月前半の決まりは無いので、『上旬』『中旬』・其の日（『1日』）で絞ってください",
    },
    {
      /* 月の幅を柔らかに打つ語 – 寄せない侭、打ち方を導く（第 355 回）。2026-10-13 実測
       * （実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）: `月初` `月初め` `月頭`
       * `今月頭` `来月頭` `再来月頭` `月中` はいずれも **0 行で案内も無し**、其れに対して
       * `1日` 133 行・`5日` 69 行・`上旬` 35 行・`9月` 253 行・`来月` 240 行が通る。
       * **寄せない** – 「月初」が何日を指すかに公用の決まりは無いので、上旬へ寄せるのは
       * 幅を広げる事になる（第 349 回以降の「一通に決まらない語は寄せない」）。
       * 案内が名指す語は実在する（其れは検査が実測で張る – 第 353 回と同じ決まり）。 */
      words: [
        "月初",
        "月初め",
        "月頭",
        "今月頭",
        "来月頭",
        "再来月頭",
        "月中",
        "月初締切",
        "来月頭締切",
        /* 『〜頃』と柔らかに打つ形（実測 `月初め頃` **0 行で案内も無し** – 其れに対し `上旬頃` は
         * 上旬に寄って 35 行通る（第 344 回）。寄せられない語なので、語として其のまま受ける）。 */
        "月初頃",
        "月初め頃",
        "月頭頃",
      ],
      multiword: true,
      echo: true,
      /* 文の中身は打ち方の名を繰り返さない（『月初』で打っても『月頭頃』で打っても同じ文が
       * 其の語の後に付く – 文中で別の語を名指すと、打っていない語を名指す文になる – 第 344 回）。 */
      note: "では絞れません。月の初めという言い方は、何日を指すか（1日・最初の週・初めの 10 日）に公用の決まりが無いので、画面は勝手に絞りません。其の日を打つ（『1日』『5日』）、初めの 10 日を打つ（『上旬』）、其の月をまとめて打つ（『9月』）・来月を打つ（『来月』）が出来ます。",
      live: "では絞れません – 月初の決まりは無いので、日（『1日』）・『上旬』・其の月（『9月』）で絞ってください",
    },
    {
      /* 週の幅を柔らかに打つ語（第 355 回）。実測 `週明け` **0 行**・`来週明け` **0 行**で案内も
       * 無し。月曜日を指す人も週の初めの日々を指す人もあるので寄せられない（案内が導す語は実測
       * `月曜` 100 行・`金曜` 133 行・`今週` 19 行・`来週` 53 行）。 */
      words: ["週明け", "来週明け", "今週明け", "週明け締切"],
      multiword: true,
      echo: true,
      note: "では絞れません。週の明けという言い方は、月曜日を指す人もあれば週の初めの日々を指す人もいるので、寄せられません。曜日（『月曜』『金曜』）や『今週』『来週』で絞ってください。",
      live: "では絞れません – 週明けの意味は一通に決まらないので、曜日（『月曜』）・『今週』『来週』で絞ってください",
    },
    {
      /* 期・四半期という区分（第 355 回）。実測 `上半期` `下半期` `上期` `下期` `半期` `期初`
       * `期末` `四半期` `第1四半期` … はいずれも **0 行で案内も無し** – この表に其の欄は無い
       * （品書の文本にも出ない）。締切は暦月で出てくるので其の期に当たる月を夫々打つ事を導す。
       * 月を空格で並べると両方を含む行だけになる（実測 `4月 5月` 4 行 – `4月` 81 行・`5月` より
       * 少ない）ので、其れも案内で但し書く。`年度初め`（81 行）・`年度末`（80 行）は第 352 回で
       * 其の方の暦月に寄るので、其方を導いて良い。 */
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
      ],
      multiword: true,
      echo: true,
      note: "という区分はこの表が持っていません。締切は暦月で出てくるので、其の期に当たる月を夫々打ってください（月の語は空格で並べると両方を含む行だけになるので、夫々打つ方が多く出ます）。年度の初め・終わりは『年度初め』（4月の締切）・『年度末』（3月の締切）で引けます。",
      live: "という区分はありません – 締切は暦月で出るので、其の期の月を夫々打ってください（年度の初め・終わりは『年度初め』『年度末』）",
    },
    {
      /* 祝日・休日のまわりの頼み方（第 353 回）。2026-10-11 実測（2026-08-09 生成の実ビルド・
       * 品書 872 行・固定時刻 2026-08-09T00:00:00Z）: `祝日` `祝日締切` `休日` `休日締切`
       * `振替休日` `国民の休日` `連休` `大型連休` `お盆` `盆休み` `夏休み` `冬休み` `春休み`
       * `ゴールデンウィーク` `GW` `年末年始` は**すべて 0 行で案内も無し**、読み上げは
       * 「語「祝日」は収録データにありません」とだけ言っていた（第 337 回の参加費と同じ形）。
       * **収録に休日の情報は無い** – 品書の文本に「祝日」「休日」「連休」「holiday」は
       * 一度も現れない（実測 0 件）ので「収録していません」は本当である。
       * **寄せない** – 祝日を特定の日に寄せるのは締切の推測になる（AGENTS.md）ので、0 行の侭、
       * 其のことと代替の探し方（曜日・日付）を其の場に書く。`年末` `年始` は其の方の暦月に
       * 寄る（第 352 回 – 実測 `年末` 183 行・`年始` 109 行）ので、『年末年始』には其れを導く。
       * `土日` `平日` は其の方で受けられる（実測 268 行・604 行 – 下の案内が其れを名指す）。 */
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
        /* 『〜の締切』と繋げて打つ形（2026-10-11 実測: `祝日の締切` **0 行で案内も無し** –
         * 案内の表は語の完全一致か、語の後ろが『したい』『の仕方』等の問いの形の時だけ働く
         * （`UI_WORD_TAILS_JA`）ので、「の締切」は其の方で受けられない）。第 337 回の表が
         * `参加費無料` `登録費無料` のように複合の形を其のまま載せているのと同じ流儀で足す
         * （`UI_WORD_TAILS_JA` に「の締切」を足すと、費用・区分など他の組まで
         * 「の締切」の案内に吸われるので、そこは触らない – 第 352 回で学んだ範囲の lesson）。 */
        "祝日の締切",
        "休日の締切",
        "お盆の締切",
        "GWの締切",
        "年末年始の締切",
      ],
      multiword: true,
      echo: true,
      note: "では絞れません。この表は祝日・休日（振替休日・お盆・年末年始など）の情報を収録しておらず、締切日が休みと重なるかどうかも分かりません。代わりに曜日（『土日』『平日』）や日付（『9月22日』・`2026-09-22`）で絞ってください。『年末年始』は 12月と1月にまたがる言い方なので、『年末』（12月の締切）・『年始』（1月の締切）で夫々引けます。",
      live: "では絞れません – 祝日・休日は収録していません。曜日は『土日』『平日』、日付でも引けます",
    },
    {
      /* 講演の招待・一般という区分。催し物の名前自体は行の原文に出るので検索で当たる
       * （実測 `ワークショップ` 126 行・`セッション` 3 行）が、区分の印は無い。 */
      words: ["招待講演", "一般講演", "基調講演", "キーノート", "招待発表"],
      multiword: true,
      echo: true,
      note: "の区別はこの表が持っていません。催し物の名前（『ワークショップ』『セッション』『チュートリアル』など）は行の原文に出るので検索で当たりますが、招待・一般という区別は収録していません。",
      live: "の区別は収録していません（催し物の名前でなら当たります）",
    },
    {
      /* 締切が確定しているかどうかを訊く語。収録は公式に出た日付だけを載せている（AGENTS.md の
       * 「締切の推測はしない」）ので、「仮」「未確定」という扱いその物が無い。 */
      words: ["未確定", "仮締切", "暫定", "暫定締切", "確定締切", "本締切"],
      multiword: true,
      echo: true,
      note: "という扱いはこの表にありません。載せるのは各会議が公式に出した日付だけで、仮の締切という印は持ちません。後から動いた締切は行に『延長』と出ます（実測で 21 行）。",
      live: "という扱いはありません – 公式に出た日付だけを書き、動いた締切は『延長』で分かります",
    },
    {
      /* 和暦で打つ人。日付は西暦でしか書いていない。`令和8年` のように語が繋がった打ち方には
       * 案内が届かない（語の区切りの問題 – SPEC §7 に残りの穴として書く）。 */
      words: ["和暦", "令和", "平成", "明治", "大正", "昭和"],
      echo: true,
      note: "の日付はこの表に書いていません。締切は西暦で出します（例: 2026年8月22日）。「締切まで」の欄は今日からの日数です。",
      live: "の日付はありません – 締切は西暦（例 2026年8月22日）で出します",
    },
    /* データの来歴・運用・持ち出しの語を打つ人（第 325 回）。2026-09-26 実測: 実際の打ち方
     * 116 語と、画面の来歴まわりの語 36 語を並べたとき、これらは**品書 872 行で 0 行・案内も無し**
     * で、読み上げは「語「更新頻度」は収録データにありません」とだけ言っていた（`site/app.ts` の
     * 収録に無い語の文）。真実だが役に立たない – この画面に答えが在るのに、場所を言っていなかった。
     * 案内は画面の正本の見出しを名前で書く（右上の『データ生成』・画面下の『データ源』・
     * ページ下の『見方のてびき』 – `site/template.html` の `id="genat"` `id="sources"` と `<summary>`）。 */
    {
      words: [
        "更新",
        "更新日時",
        "最終更新",
        "更新頻度",
        "最新版",
        "鮮度",
        "データの鮮度",
        "生成",
        "生成時刻",
        "データ生成",
        "いつ更新",
        "データ更新",
        "変更履歴",
      ],
      echo: true,
      note: "のことなら、画面の右上に『データ生成』として、いま見ているデータがいつ作られたかを出しています（JST と曜日で、一覧と同じ単位）。更新は日次の運用で、生成から日数が経っているときは同じ場所に注意書きが出ます。日ごとの変更の一覧はこの画面に置いていません – 収録の範囲や更新の運用はページ下の『見方のてびき』の『データ更新』に書いてあります。検索では絞り込めません。",
      live: "のことなら、データの生成時刻は右上の『データ生成』、運用はページ下の『見方のてびき』の『データ更新』に書いています。検索では絞り込めません",
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
      note: "のことなら、画面の下に『データ源』を出しています – 収録がどの配布物に基づいているかを並べ、名前のリンクから一次資料に飛べます。上流に無い物をこちらで入力した分もそこに書きます。裏取りを人の読める形にした報告（収録の件数・締切の確定状態の内訳・分野の内訳）も同じ場所に有ります – 中身はページ下の『見方のてびき』の『データの健全性（health.md）』に書いてあります。検索では絞り込めません。",
      live: "のことなら、収録の出所は画面下の『データ源』、裏取りの報告はページ下の『見方のてびき』の項に書いています。検索では絞り込めません",
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
        "どこまで収録",
      ],
      echo: true,
      note: "のことなら、いま出ている件数は一覧の上の件数欄に、収録している物の範囲はページ下の『見方のてびき』の『データ源』と『国内研究会・国内シンポジウム』の項に書いています。表の行の数は、この画面では絞り込みで動いた分として出るだけです。",
      live: "のことなら、件数は一覧の上の件数欄、収録の範囲はページ下の『見方のてびき』に書いています。検索では絞り込めません",
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
        "共有リンク",
      ],
      echo: true,
      note: "のことなら、印刷はブラウザの印刷（Ctrl + P など）で、いま絞り込んだ一覧の全行が出ます（画面は行を区切って描くので、印刷物だけ途中までにならないためです）。紙の上には条件の書き下ろし・表示件数・印刷した日時・データの生成日時も残ります。共有はブラウザのアドレスバーの URL をコピーすると、相手にも同じ条件・同じ並びの一覧が出ます。両方ともページ下の『見方のてびき』に書いてあります。検索では絞り込めません。",
      live: "のことなら、印刷はブラウザの印刷で絞り込んだ一覧の全行が出ます。共有はアドレスバーの URL をコピーしてください – ページ下の『見方のてびき』に書いてあります",
    },
    {
      /* 条件を戻したい人（第 326 回）。実測: `リセット` `元に戻す` `クリア` `解除` は 0 行で
       * 案内も無く、`条件クリア` `条件を消す` は第 326 回の活用の形の寄せ以後、欄の名前の案内
       * （「上にある欄で選ぶか、値で打ってください」）に拾われて – 押すべきボタンの話を
       * していなかった。正本は `<button id="reset">条件クリア</button>`（`site/template.html`）と
       * `site/app.ts` の `$("reset")` の処理（検索欄の語も含めた条件を一度に戻す –
       * 論文の欄は触らない）。 */
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
      ],
      echo: true,
      note: "のことなら、絞り込みの欄の右に『条件クリア』のボタンが有ります – 押すと、検索欄に打った語・締切まで・分野・種別・参加形式・ランク・過去の締切が一度に戻ります。名前の通り条件だけで、論文のタイトル・概要・参考論文の欄は消しません（論文の欄を消すのは推薦の欄にある『論文の入力を消す』で、消した直後は『直前の入力に戻す』が同じ欄に出ます）。",
      live: "のことなら、絞り込みの欄の右の『条件クリア』で、検索欄の語も含めた条件が一度に戻ります。論文の欄は消しません",
    },
    {
      /* `ics` はこの画面が配るファイルの名前でもあり、会議名の一部分でもある（第 323 回）。
       * 実測（2026-08-09 生成ビルドの品書 872 行）: `ics` は 14 行に当たり、**10 行は会議名の
       * 語の途中に貼り付いた物**（"ICSOC" `@icsa2027`）、`ical` は 2 行で同じ形。
       * 当たりが行に有るので 0 件案内は立たない – 探している人が多くを受ける側に
       * 件数欄（`always`）で言う。照合の貼り付き自体は別の手当（§7 同回に理由を書く）。 */
      words: ["ics", "ical"],
      echo: true,
      always: true,
      note: "のことなら、二つの物があり得ます – 表がその語で書いている行と、会議名の中に語の途中として含まれる行が混じります（表の語として当たっているわけではありません）。会議名をお探しならそのまま引けます。カレンダーに入れるファイルをお探しなら、一覧の下の『カレンダーに追加（.ics）』か『購読 URL をコピー』を使ってください（.ics は収録全体で、画面の絞り込みは引き継がれません）",
      live: "のことなら、会議名など語の途中で当たった行が混じります。カレンダー用のファイルは一覧の下の『カレンダーに追加（.ics）』で出せます",
    },
    {
      /* 持ち出し・購読の語を検索欄に打つ人（第 321 回）。2026-08-09 生成ビルドで実測 –
       * `書き出し` `エクスポート` `ダウンロード` `保存` `csv` `表計算` `スプレッドシート`
       * `予定表` `カレンダー` `カレンダーに追加` `購読` `サブスクライブ` は品書 872 行・
       * `data.json` 3,253 行のどちらも 0 行で、案内も無かった。一方、画面には一覧の下に
       * 『カレンダーに追加（.ics）』『この一覧の N 件を CSV でダウンロード』『購読 URL をコピー』の
       * 三つの操作が有る（締切を自分のカレンダーで管理したい人は最初にこの語を打つ）。
       * `ics` は入れていない – 14 行に当たり、その 10 行は会議名の一部分に貼り付いた物
       * （"ICSOC" `@icsa20` – 実測）で、当たりが行にあるのでこの案内の筋ではない。
       * `excel` も入れていない – 収録の 1 行（ICRA 2023 の文中の語）に本当に当たるので、
       * 語としての検索を案内に奪わせない。貼り付き自体は §7 第 321 回に別の欠陥として残す。 */
      words: [
        "書き出し",
        "エクスポート",
        "ダウンロード",
        "保存",
        "csv",
        "表計算",
        "スプレッドシート",
        "予定表",
        "カレンダー",
        "カレンダーに追加",
        "購読",
        "サブスクライブ",
      ],
      echo: true,
      note: "のことなら、検索欄では絞り込めません（表にそのようには書いていないので当たりません）。持ち出しと購読は一覧の下の操作で出します – 『カレンダーに追加（.ics）』で今後の締切を自分のカレンダーに、『この一覧の N 件を CSV でダウンロード』で絞り込み後の全行を表計算に、『購読 URL をコピー』でアプリに打ち込む URL が出ます。なお .ics は収録全体を購読する形で、画面の絞り込みは引き継がれません",
      live: "のことなら、一覧の下の『カレンダーに追加（.ics）』や CSV のダウンロードで出せます（.ics は収録全体で、絞り込みは引き継がれません）",
    },
    {
      /* 一覧のトグルの名前を検索欄に打つ人（第 320 回）。2026-08-09 生成ビルドで実測 –
       * `過去の締切` `過ぎた締切` `終わった締切` `終了した締切` `過去のもの` `過去の分` `過去分`
       * `過去の一覧` `過去` `履歴` は品書 872 行・`data.json` 3,253 行の**どちらも 0 行**で、
       * 案内は三つ（`uiWordNoteJa` `dayRangeNoteJa` `columnQueryNoteJa`）とも空だった。
       * 一方、過ぎた締切は 2,325 行（収録の締切の七割）あって、画面のトグルで出せる –
       * 探している物が在るとも無いとも言われない行き止まりだった。
       * 語を足して行を出すことはしない – 表に「過去の締切」とは書いていないので掛ける先が無く、
       * 全行を拾う語になって絞り込みにもならない（第 239 回の方針）。トグルへ連れていく。 */
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
        "過去",
        "履歴",
      ],
      echo: true,
      note: "のことなら、検索欄では絞り込めません（表にそのようには書いていないので当たりません）。過ぎた締切は既定で一覧から除いています – 上にある『過去の締切も表示』をオンにすると出て、品書に載っていない行は追加で読み込みます。トグルをオンにしたうえでこの語を打つとやはり当たらないので、出し分けはトグルだけでお願いします",
      live: "のことなら、上にある『過去の締切も表示』をオンにしてください（この語では絞れません）",
    },
    {
      words: ["出典", "一次情報", "データ源"],
      echo: true,
      note: "はページ下の『データ源』に出します。名前はリンクで、その配布物のページ（一次資料）に飛べます。くわしくは『見方のてびき』に書いてあります。",
      live: "はページ下の『データ源』に出します（リンクから一次資料に飛べます）",
    },
    {
      words: ["カテゴリ", "カテゴリー", "ラベル", "フィールド"],
      // 打たれた語を書き返さない組（この画面で使わない語なので）。
      echo: false,
      note: "欄の名前の言い方ですが、この画面にその名前の欄はありません。上の『分野』『種別』『参加形式』で選ぶか、値で打ってください（例: 「セキュリティ」「論文締切」「オンライン参加可」）。",
      live: "欄の名前では絞れません。上の『分野』『種別』で選ぶか、値で打ってください",
    },
  ];

  type UIWordGroup = (typeof UI_WORD_GROUPS_JA)[number];

  /* 活用の形で打たれた人を、名詞形の案内へ寄せる（第 326 回）。
   * 実測（2026-08-09 生成ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
   * `書き出す` `書き出したい` `保存する` `ダウンロードする` `購読する` `購読したい`
   * `印刷したい` `カレンダーに入れる` `絞り込みを消す` `並び替える` の 10 表は、名詞形
   * （`書き出し` `保存` `購読` `印刷` `カレンダー` `絞り込み` `並び替え`）に案内が在るのに
   * 何も言わず、読み上げは「収録データにありません」とだけ言っていた（第 325 回で直した語の
   * 活用形にあたる）。画面の語を名前の一部に含むので、一番長く含む組の案内を出す。
   * 実際の打ち方 114 表（分野・場所・時期・欄の名前）で誤発火 0 を実測 – 案内は 0 件のときだけ
   * 画面に出す門を通るので、行が出ている打ち方には影響しない。 */
  /* 画面の語の後ろに付くだけの人（活用の形・言い方の続き）。ここを並べ替えない理由は、
   * 語が**文の途中や前に有るだけ**の場合に寄せないため – 第 326 回の実測で、語を含むだけの
   * 打ち方は誤発火になった（`クリアランス` が `クリア` に、`条件付き` が `条件` に、
   * `未確定` が `確定` に拾われた）。語の後に続く物が下の言い回しのときだけ寄せる。 */
  const UI_WORD_TAILS_JA = [
    "したい",
    "します",
    "する",
    "して",
    "しとく",
    "し方",
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
  ];

  /* 「書き出す」のように、用言の活用で語幹の母音が違う形（出し / 出す）で打たれることがある
   * （第 326 回の実測 – この形だけ寄せが漏れた）。語の最後の母音を連用形の形に直した物でも
   * 同じ検査を通す。 */
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

  function uiWordContain(q: string): { group: UIWordGroup; word: string } | null {
    if (q.length < 3 || q.length > 16) return null;
    let best: UIWordGroup | null = null;
    let bestWord = "";
    for (const form of uiWordStemForms(q)) {
      for (const group of UI_WORD_GROUPS_JA) {
        for (const word of group.words) {
          const folded = word.toLowerCase();
          if (folded.length < 2 || folded.length <= bestWord.length) continue;
          if (!form.startsWith(folded)) continue;
          const tail = q.slice(folded.length);
          if (tail && !UI_WORD_TAILS_JA.includes(tail)) continue;
          best = group;
          bestWord = folded;
        }
      }
    }
    return best ? { group: best, word: bestWord } : null;
  }

  /** 打たれた語がどの案内の組に掛かるか（完全一致 → 活用の形の順で探す）。 */
  function uiWordMatch(query: unknown): { group: UIWordGroup; word: string } | null {
    const q = String(query == null ? "" : query)
      .trim()
      .toLowerCase();
    if (!q) return null;
    for (const group of UI_WORD_GROUPS_JA) {
      const word = group.words.find((candidate) => candidate.toLowerCase() === q);
      if (word) return { group, word };
    }
    const 含み = uiWordContain(q);
    if (含み) return 含み;
    /* 語を並べて打った人（第 354 回）。2026-10-12 実測（実ビルドの品書 872 行）: 空格で
     * 「祝日 締切」「参加費 無料」「対面参加 2026年9月」「ワークショップ 招待講演」のように
     * 打つ人は、其の方の語が収録に無い・又は 1 行も減らない語だと分かっていて其の筈が、
     * **完全一致と語の活用の形しか見ない為、案内が黙っていた**（第 337 回の表は一篇の語
     * だけ見ていた）。画面の案内は 0 件の時しか出ない（`site/app.ts` の `matchedRows === 0`
     * の見張り – 検査が其れを見る）ので、打たれた語の中に案内の組の語が在れば其れを名指す。
     * 其の方の規則（日付を繋げた形 – 第 344 回以降）より後に置く（其れらを奪わない –
     * 「年末締切」等はこの順のままで其の方の案内が出る）。 */
    /* 一字の語も通す（第 361 回）。語の道は**完全一致**なので、一字の語は表に一字の語が在る時だけ
     * 発火する – 表の一字の語は『賞』一つ（実測）で、助詞（の・に・で）は表に無いので化けない。
     * 直し前は「賞 関西」で『賞』の案内が落ちていた（2026-10-18 実測）。 */
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

  /** 打ち返された語を正本の表記で返す（案内に書き返すか決めるのに使う）。 */
  function uiWordRawJa(query: unknown): string {
    return uiWordMatch(query)?.word || "";
  }

  /** 0 件案内に出す一文（画面の使い方・操作・出典の語を打たれた人向け – 第 248 回）。 */
  function uiWordNoteJa(query: unknown): string {
    const hit = uiWordEntry(query);
    if (!hit) return "";
    if (!hit.echo) return ` ${hit.note}`;
    const word = uiWordRawJa(query);
    if (hit.quiet && hit.quiet.indexOf(word) >= 0) return ` ${hit.noteQuiet || hit.note}`;
    return ` 「${word}」${hit.note}`;
  }

  /** 当たりが行に有るかに関わらず件数欄に出す一文（`always` を置いた語 – 第 323 回）。 */
  function uiWordAlwaysNoteJa(query: unknown): string {
    const hit = uiWordEntry(query);
    if (!hit?.always) return "";
    return uiWordNoteJa(query);
  }

  /* 日数の範囲の言い方（`3日以内` `1週間以内` `1か月以内`）（第 253 回）。
   * 2026-08-09 生成ビルド・固定時刻 2026-08-09T00:00:00Z で実測: `3日以内` 0 行・
   * `7日以内` 0 行・`1週間以内` 0 行・`1か月以内` 0 行・`90日以内` 0 行で、案内も無かった。
   * これを暦月・暦日のグループへ展開しない – 表の暦日語は締切日だけでなく会期の日時も
   * 含む（実測: `2026年8月30日` に当たる 14 行のうち締切がその日の行は 0 行）ので、
   * 「3 日以内に締切がある行」のつもりで会期が 3 日以内の行が混じる。画面には既に
   * 締切日からの日数で絞る「締切まで」の選択欄（7・30・90・180 日以内）があるので、
   * そちらへ連れていく。検索語として効くと見せるのがいちばん悪い。 */
  const DAY_RANGE_DAYS = /^(\d{1,4})(?:日間)?以内$/;
  const DAY_RANGE_UNIT = /^(\d{1,3})(.+?)以内$/;
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
    const normalized = (typeof raw.normalize === "function" ? raw.normalize("NFKC") : raw).trim();
    if (!normalized) return null;
    const plain = DAY_RANGE_DAYS.exec(normalized);
    if (plain) {
      const days = Number(plain[1]);
      return days >= 1 && days <= 3650 ? days : null;
    }
    const unit = DAY_RANGE_UNIT.exec(normalized);
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
  function dayRangeNoteJa(query: unknown): string {
    const hit = dayRangeWindowJa(query);
    if (!hit) return "";
    /* 打たれた形をそのまま返す（全角数字でも利用者の入力した文字を書く – 件数欄の
     * 「検索語『X』」と同じ判断）。 */
    const word = (typeof query === "string" ? query : query == null ? "" : String(query)).trim();
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
    const hit = dayRangeWindowJa(query);
    if (!hit) return "";
    /* 打たれた形をそのまま返す（全角数字でも利用者の入力した文字を書く – 件数欄の
     * 「検索語『X』」と同じ判断）。 */
    const word = (typeof query === "string" ? query : query == null ? "" : String(query)).trim();
    if (hit[2] === "same") return `「${word}」は「締切まで」の ${hit[1]}で絞えます`;
    if (hit[2] === "near") return `「${word}」は「締切まで」の ${hit[1]}が近い`;
    return `「${word}」は「締切まで」は ${hit[1]}まで`;
  }

  /** 読み上げ側の短い文（同じ表から作る – 画面と読み上げが別のことを言わないようにする）。 */
  function uiWordLiveNoteJa(query: unknown): string {
    const hit = uiWordEntry(query);
    if (!hit) return "";
    if (!hit.echo) return hit.live;
    const word = uiWordRawJa(query);
    if (hit.quiet && hit.quiet.indexOf(word) >= 0) return hit.liveQuiet || hit.live;
    return `「${word}」${hit.live}`;
  }

  /* 検索語を打っても 1 行も減らないときの打ち直し方（第 227 回）。
   * 2026-08-09 生成ビルドで実測: `月`・`日`・`年` はそれぞれ 863 / 863 行に当たり、件数欄の
   * 数字が 1 も動かずに画面はどこにも理由を書かなかった。数値だけでは暦日が決まらない
   * （`25` は 2025 や 11月25日 に混なって 105 行に当たり、`25日` の 94 行と一致しない）。
   * 行のどの欄にも寄らない語を伸ばすのは索引側ではできないので、ここで言い直す。 */
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
    /* 「延長締切」「締切延長」「延長された締切」は語が割れず 0 行だったので `延長` の 1 語に
     * 寄せている（第 342 回）。**寄せた事を其の場でおしらせする** – 黙って別の語で探した事に
     * すると、なぜその行が出たか分からないまま行数の壁になる（上の同じ理由）。
     * 判断は書き換えの関数その物に聞く（正規表現を二箇所に書くと必ずズレる – 第 339 回）。 */
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
      /* 「8月締め」を『8月』と『締切』の二語に直した事も其の場で書く（黙って語を増やさない –
       * 第 342 回と同じ決まり）。判断は書き換えの関数に聞く（正規表現を二箇所に書かない）。 */
      if (
        打たれた検索語 !== 寄せた検索語 &&
        /(?:^|\s)締切/.test(寄せた検索語) &&
        /締め|締切|〆|しめきり/.test(打たれた検索語) &&
        /* `締切未定` のような形は下の『未定』の案内が書く – 此方を出すと「期間の語」と
         * 誤った名前で呼ぶ（第 346 回の実発生 – 案内が語の性質を嘘をつく）。 */
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
       * – そちらは其の側の案内が既に日付を書いている。 */
      const までの語 =
        /((?:[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}|[0-9]{1,2}[-/][0-9]{1,2}|[0-9]{1,2}月[0-9]{1,2}日|[〇一二三四五六七八九十]{1,4}月[〇一二三四五六七八九十]{1,4}日|[〇一二三四五六七八九十]{1,4}月末?|(?:0?[1-9]|1[0-2])月末?|(?:今週|来週|再来週|先週)?[月火水木金土日]曜(?:日)?|(?:今週|来週|再来週|先週)?週末|平日|今月|来月|再来月|先月|今週|来週|再来週|先週|今年|来年))(?:まで|いっぱい)/.exec(
          打たれた検索語,
        );
      if (までの語 && 打たれた検索語 !== 寄せた検索語 && !/(?:まで|いっぱい)/.test(寄せた検索語)) {
        /* 説明文の式中に引用符を置く形にしない – 説明文の語彙を見る検査が文字列の切れ目を
         * 取り違える（第 346 回の実発生 – 案内の語を其処で削る式を書いたら別の語の検査に
         * 引っかかった）。削った結果は上の書き換え関数に聞く。 */
        const 照らす語 = 寄せた検索語.split(/\s+/).filter((語) => 語)[0];
        /* 漢数字で打たれた形（`八月まで`）は寄せた形で数字に変わる – 其の語其のを又ここで
         * 読み替えず、書き換え関数その物に聞いて揃える（第 339 回 – 同じ読みを二処に書くと
         * 必ずずれる。別の言い方の表に形を足すたびに案内が黙る事故も防ぐ）。 */
        const 頭の形 = までの語 ? String(collapseRelativeDayPhrase(までの語[0])).trim() : "";
        if (照らす語 === までの語[1] || (頭の形 && 照らす語 === 頭の形)) {
          notes.push(
            `「${までの語[0]}」は「${照らす語}」の締切として探しています（締切の日その物で絞るなら上の『締切まで』の欄が確かです）`,
          );
        }
      }
      /* 「締切未定」を二語に直し、「期限未定」を『未定』に寄せる判断も其の場で書く。収録に
       * 『期限』も『日付』の語も無い事を伏せた侭行の壁にしない（第 345 回と同じ）。 */
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
    /* 表の全行にあてはまる語を照合でのいたときは、そのことを書く（第 245 回）。
     * `セキュリティの会議` を `セキュリティ` で探したので、画面の件数は
     * 「セキュリティの会議」だけの数ではない – 絞れたと読み違えられないようにする。 */
    {
      const tokens = queryTokens(query);
      const whole = WHOLE_TABLE_QUERY_JA.map((word) => kanaFold(word));
      const dropped = tokens.filter((token) => whole.indexOf(kanaFold(token)) >= 0);
      const kept = tokens.filter((token) => whole.indexOf(kanaFold(token)) < 0);
      if (dropped.length && kept.length) {
        const note =
          `「${dropped[0]}」はこの表の全行にあてはまる語なので絞り込みに使い、` +
          `他の語（${kept
            .slice(0, 2)
            .map((token) => `「${token}」`)
            .join("・")}）で探しています`;
        notes.push(note);
      }
    }
    /* 第 194 回に、画面が等級を呼ぶ語（列の見出し・選択欄の「ランク」、てびきと件数欄の「評価」）を
     * 検索語に入れた。ただしこの語だけは等級を絞らない（2026-08-09 生成のビルドで実測: `ランク`
     * だけで 839 / 863 行、`評価` だけで 475 / 863 行）。絞れたと読み違えないよう、等級の語が
     * 混ざっていないときだけ、そのことを書く。 */
    /* 照合には小文字化した形を使い、人に見せる例は画面と同じ大文字のままする
     * （`rankGradeOrderJa()` の並びは画面の選択欄と同じなので、例もそこから取る）。 */
    const labelWords = ["ランク", "評価", "類"];
    const gradeWordsShown = rankGradeOrderJa().map((grade) => String(grade));
    const gradeWords = gradeWordsShown.map((grade) => grade.toLowerCase());
    const queryForms = queryTokens(query).map((token) => kanaFold(String(token)));
    queryTokens(query).forEach((token) => {
      const hit = map[kanaFold(token)];
      if (hit) {
        const note = `「${token}」は${hit[0]}で探しています`;
        if (notes.indexOf(note) < 0) notes.push(note);
        /* タイムゾーンで打った人には、寄せた先が**行に書かれた表記**であることを書く –
         * 別の時間帯の行を変換して足す事はしない（第 336 回）。含みの範囲を実測で書く:
         * JST の表記は時刻の書いてある行に付く（688 行 = 時刻を持つ行 688 行と一致）で、
         * AoE（492 行）・UTC・GMT（176 行）の行はすべて JST の表記も持つつもり、なので
         * 「AoE の行は出ません」とは書けない（書いたら噓になる）。 */
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
        const note = `「${token}」は${label}（${where}）で探しています`;
        if (notes.indexOf(note) < 0) notes.push(note);
        /* 海外は「収録の国名から導いた」まとめなので、届かない行の範囲も書く –
         * 639 行が出ると 0 行が見えないと、無い物を無いと言えない（第 335 回）。 */
        if (OVERSEAS_HEADS_JA.indexOf(region[0][0]) >= 0) {
          const 範囲の案内 = `「${token}」${OVERSEAS_COVERAGE_NOTE_TAIL_JA}`;
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
    const graded = queryForms.some(
      (form) =>
        gradeWords.indexOf(form) >= 0 ||
        /^[a-c]\*?(ランク|評価|類)$/.test(form) ||
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
    /* 月の語と旬を**離して**打った形（`来月 下旬`）は、解く前に一語へ寄せる（第 332 回）。
     * 寄せないで語ごとに解くと、行は 9 月下旬のものなのに案内は「8月下旬」と書いてしまう –
     * 案内は画面に出る物なので、行と食い違うと嘘になる。 */
    const 解いた語: Array<{ 見せ: string; 解: string }> = [];
    queryTokens(collapseRelativeDayPhrase(query)).forEach((token) => {
      const 前 = 解いた語[解いた語.length - 1];
      if (前 && monthPartRangeJa(`${前.解}${token}`, nowMs) !== null) {
        前.見せ = `${前.見せ} ${token}`;
        前.解 = `${前.解}${token}`;
        return;
      }
      解いた語.push({ 見せ: token, 解: token });
    });
    解いた語.forEach(({ 見せ: token, 解 }) => {
      /* 「明日まで」「今日から 3 日」は幅なので、幅のまま書く（第 328 回）。 */
      const span = untilDayTermsJa(token, nowMs) || fromTodayTermsJa(token, nowMs);
      if (span) {
        const lastYmd = lastFullDateJa(span);
        if (lastYmd) {
          notes.push(spanNoteFromTodayJa(token, nowMs, lastYmd));
          return;
        }
      }
      /* 和暦で打たれた時は、何年に直して探したかを其の場で書く（第 343 回）。 */
      const 和暦の解 = eraYearTermsJa(token);
      if (和暦の解) {
        notes.push(
          和暦の解.年度
            ? `${token} = ${和暦の解.西暦}年4月〜${和暦の解.西暦 + 1}年3月の締切 – 年度は 4 月始まりで、この表は締切を西暦でしか書いていないので西暦の月語に直して探しています`
            : `${token} = ${和暦の解.西暦}年の締切 – この表は締切を西暦でしか書いていないので、年号は西暦に直して探しています（年号と西暦の対応は暦の決まりです）`,
        );
        return;
      }
      /* 「今週金曜」のように週+曜日を繋げた形は、解けた 1 日を出す（第 329 回）。 */
      const pressed = pressedWeekdayJa(token, nowMs);
      if (pressed) {
        /* 解けた日を**すべて**書く – `今週末` は土曜・日曜の二日へ展開するので、一日目だけ
         * 名指す案内は実物（出る行）とズレる（第 341 回 – 案内と実照合の一致）。 */
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
      const key = dateTokenStemJa(token) || token;
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
      /* 「7日以内」「14日以内」（週から寄せた形を含む）は範囲なので、件数欄に幅を書く（第 318 回）。
       * 週で打った人には日数への換算が見えないと「何で 60 行なのか」が分からない –
       * 1 週 = 7 日の換算を隠さず出すための案内。 */
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
      /* 「3か月以内」「1年以内」は暦のか月・年の幅なので日数の語へ寄せない（第 318 回の判断 –
       * 暦の 1 か月は 28〜31 日で変わる）。だが黙って 0 件にもしない（2026-09-30 実測・固定時刻
       * 2026-08-09T00:00:00Z・品書 872 行: `1か月以内` `2か月以内` `3か月以内` `3ヶ月以内`
       * `1年以内` `2年以内` はいずれも **0 行で案内も無し** – 画面の日数の絞り込み（『7 日以内』
       * 『30 日以内』『90 日以内』『180 日以内』）へ届いていなかった）。日数の語なら受けるので、
       * その形を例に書いて渡す（`90日以内` 593 行・`365日以内` 872 行を実測で確認）。*/
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
      /* 「20時」「午後8時59分」は収録の時刻の表記に寄せた結果を出す（第 333 回）。
       * 午後 → 24 時間表記の換算は打った人に見えないので、解けた形をそのまま書く。 */
      const clock = clockTimeTermsJa(token);
      if (clock) {
        notes.push(
          `${token} = ${clock.解} の締切 – 収録の時刻は 24 時間表記（\`20:59\` のように時の頭を 0 埋め）で書かれています。${
            clock.幅
              ? "冠の無い「N時」はその 1 時間ぶん（00 分〜59 分）を受けます"
              : "分まで打たれたときはその 1 点だけを見ます"
          }。タイムゾーン（JST・UTC・AoE）は行に書かれています`,
        );
        return;
      }
      /* 「20時59分までに」は“それ以前の時刻”という頼み方で、部分一致では作れない幅なので
       * 絞り込まず、確かでする欄を言う（第 333 回 – 黙って 0 件にしない）。 */
      const clockUntil = clockUntilQueryJa(token);
      if (clockUntil) {
        notes.push(
          `${token} = 時刻までで絞り込む事は検索欄では出来ません（収録は締切の日で並び、時刻は行に 24 時間表記で書かれています）。締切までの日数で絞るなら上の『締切まで』の欄が確かです – ${clockUntil} という時刻は行に書かれています`,
        );
        return;
      }
      /* 「8月下旬」「来月上旬」は幅なので、出した範囲と分け方の決まりを書く（第 332 回）。
       * 「いついつまで」を尋ねているのに、打たれた語を繰り返すだけの案内は答えにならない。 */
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
            part.label === "下旬" ? "（下旬は月末まで）" : ""
          }${過ぎ}`,
        );
        return;
      }
      /* 「今年度」「来年度中」は年度（4 月〜翌年 3 月）の幅で答える（第 330 回）。
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
      const yearOffset = RELATIVE_YEAR_OFFSETS_JA[relativeYearKeyJa(key)];
      if (yearOffset !== undefined) {
        const base = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3_600_000);
        notes.push(`${token} = ${base.getUTCFullYear() + yearOffset}年の締切（1〜12 か月）`);
        return;
      }
      /* 「明日以降」「来週から」は「それより後」の意味で、一日ぶんの語に寄せると嘘に
       * なる（第 328 回）。なので絞り込まず、並び方と絞れる欄の場所を言う。 */
      const onward = /^(.+?)(?:以降|から)$/.exec(token);
      if (onward) {
        const stem = onward[1];
        const dayOffset = RELATIVE_DAY_OFFSETS_JA[stem];
        const onwardWeek = weekDayTermsJa(stem, nowMs);
        let first = "";
        if (dayOffset !== undefined) {
          const ymd = offsetCalendarDay(nowMs, dayOffset);
          first = `${ymd[0]}年${ymd[1]}月${ymd[2]}日`;
        } else if (onwardWeek.length === 7) {
          first = onwardWeek[0];
        } else if (monthPartRangeJa(stem, nowMs) !== null) {
          const 旬 = monthPartRangeJa(stem, nowMs) as {
            year: number;
            month: number;
            from: number;
          };
          first = `${旬.year}年${旬.month}月${旬.from}日`;
        } else if (fiscalYearBaseJa(stem, nowMs) !== null) {
          first = `${fiscalYearBaseJa(stem, nowMs) as number}年4月1日`;
        } else if (RELATIVE_YEAR_OFFSETS_JA[relativeYearKeyJa(stem)] !== undefined) {
          const baseNow = Number.isFinite(nowMs) ? nowMs : Date.now();
          const baseYear = new Date(baseNow + 9 * 3_600_000).getUTCFullYear();
          first = `${baseYear + (RELATIVE_YEAR_OFFSETS_JA[relativeYearKeyJa(stem)] as number)}年1月1日`;
        }
        if (first) {
          notes.push(
            `${token} = ${first}以降のこと – 初期画面は締切の近い順に並んでいて、その以降の締切も並びます（締切までの日数で絞るなら上の『締切まで』の欄が確かです）`,
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

  /** `2026年8月10日` の形の語を `2026-08-10` にする（曜日を引き出すため）。 */
  function toIsoDate(term: string): string {
    const parts = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(String(term || ""));
    if (!parts) return "";
    return `${parts[1]}-${parts[2].padStart(2, "0")}-${parts[3].padStart(2, "0")}`;
  }

  /* 検索語に書かれた日付の幅を、ISO の暦日として返す（第 293 回）。解釈するのは一覧の検索が
   * 実際に持つ形だけ – `monthTermsJa`（`2027年3月`）・`dayTermsJa`（`2027年3月10日`）・
   * `isoDayJa`（`2027-03-10`）が hay に入れる語と同じ物にする（画面で引ける形以外を解釈すると、
   * 案内が「引けるはずの語が引けない」話を始める）。
   * 年を言わない `3月10日` は年を作る推測になるので返さない（締切の推測はしない – AGENTS.md）。
   * 幅で返すのは「その月だけ」が収録の切れ目にかかる場合（`2027年2月` など）に、先とは
   * 言わせないと噓になるため。 */
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

  /**
   * 分野チップに並ぶ語（日本語名を主、英表記を併記）。チップの描画と検索索引が同じ式を
   * 使うための入口 – 画面に並ぶ語を索引が持たないと、コピーして貼った人が 0 件に落ちる
   * （第 215 回・第 216 回と同じ判断）。
   */
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
    if ((tags || []).indexOf("domestic-jp") >= 0) {
      parts.push("国内");
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

  /* 種別の日本語ラベルは下に持つ `KIND_LABEL_JA`（`kindLabelJa`）を正本にする。ここに
   * 3 件だけの別の表を持っていたため、この経路だけが `notification` / `camera_ready` 等の
   * 内部表記を英字のまま返す可能性を持っていた。上の分野列が `categoryLabelJa` を使い、
   * ビルドが書く `data.csv` が正本の `kindLabelTable` を使うのに、ここだけ古い表を別で
   * 持っていた（同じ語彙に表を 2 つ持つと必ず片方が古くなる）。
   * **到達性の注記**: 一覧は概要・論文・常時受付の種別しか出さず（`SELECTABLE_KINDS`）、
   * 画面の CSV は `shown` を渡すので、現時点で利用者が英字の入った CSV を得る経路は無い。
   * よってこれは表示が変わる欠陥ではなく、採否通知など種別を一覧に出す変更をした瞬間に
   * 英字が漏れる地雷の除去。関数の契約として「既知の種別なら内部表記を書かない」を守る。 */

  /* 表の種別セルと行の詳細に出す「第 N ラウンド」を、検索でも引けるようにする。
   * ラウンドの区別は画面ではこの書き方しかなく、CSV も `R1` `R2` と書いているのに、
   * 検索用の文字列に入れていなかったため、**画面に出ている語をそのまま打つと当たらない**
   * だった（2026-09-23 実測: 2 ラウンドの行は 387 件あるのに「R2」は 3 件、
   * 「第2」は 5 件）。画面に出る語は検索でも引ける、という規則をここで保つ。
   * 1 ラウンド目は画面に何も出さないが、CSV と並びの正本で `R1` を使っているので通す。
   * 半角スペースの有無は人の入力なので、両方の形をおく。 */
  /* 画面が行に出す締切の回の語（第 334 回）。検索語の寄せ先もここを見る – 「画面が言わない語に
   * 寄せない」ための表で、表に無い回（6 回目以降）は下の式で作る – 定数で書くと次のビルドで
   * 噓になる（第 291 回）。 */
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

  /* 上流が締切を差し替えた行（`superseded_deadlines`）は、前の値を kamiyobi が持っている。
   * それなのに画面にも検索にも出ていなかった（2026-08-09 生成ビルドで実測・第 224 回:
   * 収録 863 行のうち 21 行が前の締切を持ち、うち 15 行は日付その物が動いているのに、
   * 「延長後」の印はラベルに "Extended" を持つ 3 行だけ。前に見た日付と違う行を開いた人は、
   * 「このサイトは古いのか / 会議が動いたのか」を判定できなかった）。
   * 前の日付を行の詳細に出し、その日付を貼るとその行に出会えるようにする（第 220 回と同じ
   * 約束 – ドロワーに並ぶ語は引ける）。延びた行は既存の「延長後」の印も出す。 */
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
    return { iso, ja: weekday ? `${iso}(${weekday})` : iso, clock, instant };
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
      if (!from || from.instant === to.instant) return;
      out.push({
        fromIso: from.iso,
        fromDayJa: from.ja,
        fromJa: `${from.ja}${from.clock}`,
        toIso: to.iso,
        toDayJa: to.ja,
        toJa: `${to.ja}${to.clock}`,
        later: from.instant < to.instant,
      });
    });
    return out;
  }

  /* 行の詳細に出す一行。無いときは空文字。表示と検索の語はここが 1 本（第 212 回の規則）。
   * 「延長」「前倒し」は**表示していた日付同士の関係**として書く。上流が締切を動かしたのか、
   * こちらの以前の記録が弱かったのかはデータから分からないので、会議の動作を推測した文は
   * 書かない（「締切の推測はしない」という収録契約と同じ）。 */
  function deadlineShiftLineJa(dl: unknown): string {
    const shifts = deadlineShiftsOf(dl);
    if (!shifts.length) return "";
    return `前に出ていた締切: ${shifts
      .map((s) => `${s.fromJa} → ${s.toJa}（${s.later ? "延長" : PULL_FORWARD_LABEL_JA}）`)
      .join(" ／ ")}`;
  }

  /* 検索の語に入れるのは**日付の語と差し替えを示す語だけ**。行の詳細の文をそのまま入れると、
   * その文に混じる時刻が 締切欄・公式表記欄の時刻の精度を落とす（2026-08-09 生成ビルドで実測・
   * 第 224 回: 文ごと入れたら「08:59」の当たり行が 57 → 58 になって、曜日の検査と同じ
   * 「見ていない語で当たった」形になった）。第 220 回で今後の会期の開催地を索引に
   *入れなかったのと同じ判断。 */
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
        s.later ? "延長" : PULL_FORWARD_LABEL_JA,
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
  function deadlineRowIsPast(
    row: { t?: unknown; tLast?: unknown; dateOnly?: unknown },
    nowMs: number,
  ): boolean {
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
      ed?: { event_start?: unknown } | null;
    },
    nowMs: number,
  ): string {
    if (!deadlineRowIsPast(row, nowMs)) return "";
    const tEvent = Number(row.tEvent);
    if (Number.isFinite(tEvent) && tEvent >= nowMs)
      return `${PAST_DEADLINE_TAG_JA}（会期がこれから）`;
    const next = upcomingEditionsOf(row.conf, String(row.ed?.event_start || ""), nowMs);
    if (next.length) return `${PAST_DEADLINE_TAG_JA}（次回予定）`;
    return PAST_DEADLINE_TAG_JA;
  }

  /* 締切の検証状態が画面に出す語。一覧の印・行の詳細・検索用の語の三箇所が同じ表を
   * 見るための正本（ここに寄せる前は、画面の印を作る語と検索用の語が別実装で、
   * **画面が 375 行に出していた「複数候補のため要確認」が検索で 1 件も引けなかった**
   * （2026-08-09 生成ビルドで実測・第 212 回。`確認済み` 25 行、`再確認待ち` 2 行も 0 件。
   * 原因は検索側が `d.verification === "unverified"` という文字列比較を見ていたことで、
   * 実データの形は `{status: "manual-required"}` のオブジェクトだった）。
   * 未知の状態は画面と同じ「再確認待ち」にする – 機械の語をそのまま出さない。 */
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

  /* 締切欄・公式表記欄に並ぶ語を hay に入れる。語は**画面と同じ列を組み立てる関数
   * （`csvJstInstant` / `fmtAoEText`）の出力から取る**（書き写すと表示とズレる – 第 209 回）。
   * 入れるのは 2 種の語。
   *
   * 1. 時刻の語（`20:59`・`23:59`）。2026-08-09 生成ビルドでは 863 行中 679 行がどちらかの欄に
   *    時刻を出している（21 種・最多は `20:59` の 508 行）のに、その語を打つとぜんぶ 0 件だった
   *    （第 213 回）。
   * 2. 時刻帯の語（`JST`・`AoE`）。`csvJstInstant` は**公式の zone 宣言が有る無しにかかわらず**
   *    締切欄を `2026-08-22 03:00 JST(土)` の形で書く。ところが `zoneSearchWords` は公式の zone
   *    宣言を読む関数なので、宣言が無い行と AoE 宣言の行（合わせて 659 行）に `JST` が
   *    入っておらず、締切欄のセルをコピーして検索欄に貼ると 0 件になった。一覧で最も頻繁に
   *    コピーされる欄なので、表示式に語を聴く（第 216 回）。
   *
   * AoE 宣言の行は公式表記欄に AoE の時刻も出る（同じ行に二つの時刻が並ぶ）のでそれも入れる。
   * 日付しか確認できていない行は時刻も `JST` も出さないので語を入れない。 */
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

  /* 公式表記欄に出る AoE の暦日を、検索の語に入れる（第 214 回）。AoE 宣言行は締切欄の
   * JST の日付と公式表記欄の AoE の日付が違い（2026-08-09 生成ビルドで 863 行中 486 行）、
   * 画面に書いた日付をそのまま打つと その行に出会わなかった（公式表記欄の日付 165 種のうち
   * 39 種がその日を書く行をぜんぶ拾えず、例: AAAI 2027 は 公式表記 `2026-07-21 23:59 AoE` /
   * 締切欄 `2026-07-22 20:59 JST(水)`）。暦日だけでなく「N月」「YYYY年」の語も同じ式から足す
   * （AoE は前日なので月をまたぐ行が 26 行、年をまたぐ行が 1 行ある – 「11月30日」「2026年」が
   * その行を拾えないままになる）。語は**公式表記欄を組み立てる `fmtAoEText` の出力から取る**
   * （表示と同じ式を使う – 第 209 回・第 213 回と同じ判断）。曜日は足さない: 公式表記欄は
   * 曜日を出さない（締切欄の曜日は JST のもので、AoE の曜日ではない）。 */
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
  function eventDaySearchWords(row: unknown): string {
    const ev = ((row as { ed?: unknown } | null)?.ed || {}) as Record<string, unknown>;
    const words: string[] = [];
    [ev.event_start, ev.event_end].forEach((value) => {
      const iso = isoDayJa(value);
      if (!iso) return;
      words.push(dayTermsJa(value), iso);
    });
    /* 会期欄に並ぶ `2026-12-03(木)` の形も、**表示と同じ `eventCellJa` の出力から**語にする
     * （第 209 回・第 213 回と同じ判断）。打つ側もこの形を割らないので、セルをコピーして貼れば
     * その行に出会う。曜日を単独の語としては入れない – `金` ひとつで数百行に膨れる。 */
    eventCellJa({ ed: ev })
      .split(" ")
      .forEach((part) => {
        if (/^\d{4}-\d{2}-\d{2}[（(][日月火水木金土][）)]$/u.test(part)) words.push(part);
      });
    return words.filter(Boolean).join(" ");
  }

  /* 検索語を語の組に分けて、収録データで何行に当たるかを数える。語を並べて打った人が
   * 0 件に当たったとき、どの語が足りなかったのかを画面が言えるようにするため
   * （2026-09-23 実測: 「ネットワーク 福岡 GPU」は 0 件なのに、どの語が原因かを画面は
   * 何も言わなかった）。組の中は OR（同義・読み展開）、組の間は AND なので、
   * 数えるのも組の単位にする（1 語だけで数ると、展開で届く語を「無い」と誤報する）。 */
  function queryTermCounts(
    query: unknown,
    hays: readonly unknown[],
    nowMs?: number,
  ): Array<{ term: string; count: number }> {
    const list = Array.isArray(hays) ? hays : [];
    const groups = queryTokenGroups(query, nowMs);
    /* 語ごとの件数は、語 1 つぶんずつ表を読み直す形だった。検索の述語は行ごとに
     * `kanaFold(hay)`（全角・半角・仮名のゆらぎを寄せる）を掛けるので、**行の畳み込みが
     * 語の数 × 同義語の数だけ走る**（2026-08-09 生成ビルド・候補行 3,253 行 / 210 万字で
     * 実測: `ネットワーク 福岡` の件数欄だけで **93 ms** – 検索そのもの 31 ms の 3 倍。
     * 検索欄 1 打鍵 83 ms の内訳の大半がこれで、語を並べた人ほど重かった – 第 258 回）。
     * 行は 1 回だけ畳み、語の組み立ては `searchMatcher` と同じ `searchGroups` を使う。 */
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
      return { term: String(alts[0] || ""), count: count };
    });
  }

  /* 0 件のときに「検索語を短くする」とだけ書いても、直らないことがある（第 256 回）。
   * 2026-08-09 生成ビルドで自然な打ち方 93 語を調べると 47 語が 0 行で、案内はどれにも
   * 同じ「検索語を短くする」を出していた。実際には 3 種類の打ち直しがある –
   *  (a) 複合語の一方だけを打つ（`生成AI` → `AI`）
   *  (b) 長い語の続きを落とす / 前を落とす（`高速計算` → `高速`）
   *  (c) 2 つの語に割る（`学生論文` → `学生 論文`）
   * どっちも 0 行なら「短くする」は直らない助言なので、出さない判断もここで決める。
   * 数の数え上げは 0 件案内と同じ集合（候補行 + 常時受付のジャーナル行）を使う –
   * `queryTermCounts` と同じ理由（同じ語彙を 2 か所に持つと必ず片方が古くなる）。 */
  function shorterHitWordsJa(
    query: unknown,
    hays: readonly unknown[],
    nowMs?: number,
    limit = 2,
  ): Array<{ word: string; count: number; how: string; pair?: string }> {
    const list = Array.isArray(hays) ? hays : [];
    const words: string[] = [];
    /* 展開（`来月` → 暦月など）は数え上げのためにここで掛ける。打たれた文字その物は
     * 下の `rawWords` で別に読む – 展開済みの文字列を渡されると、見本が小文字に化ける
     * （`生成AI` に `ai` と出すと、読み手はそのまま打てない – 第 256 回）。 */
    queryTokenGroups(expandRelativeMonths(query, nowMs ?? Date.now()), nowMs).forEach((group) => {
      const term = String(((group || [])[0] as string) || "").trim();
      if (term) words.push(term);
    });
    if (!words.length || words.length > 6) return [];
    /* 数え上げは展開済みの語（小文字・NFKC）でやるが、画面に出す見本は**打たれた形**で無いと
     * 読み手が打てない（`生成AI` に `ai` と出しても、そのまま打てない – 第 256 回）。
     * 語の数が合っていれば元の文字列から語を割り出し、見本はそちらを使う。 */
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
    const found: Array<{ word: string; count: number; how: string; pair?: string }> = [];
    const pushShown = (display: string, word: string, how: string, pair?: string): void => {
      const n = countOf(word);
      if (n <= 0) return;
      if (found.some((item) => item.word === display)) return;
      found.push({ word: display, count: n, how: how, pair: pair });
    };
    /* (a) 複数語を打たれているときは、語を 1 つに絞った数を each 語について出す。 */
    if (words.length >= 2)
      words.forEach((word, index) => {
        pushShown(shown(index, word), word, "alone");
      });
    words.forEach((word, index) => {
      /* 当たっている語をこれ以上短くしても、見当の打ち直しにならない（第 256 回実測:
       * `ネットワーク 福岡 GPU` に `ネットワー` を勧めていた – 語を外す話と混ざる）。 */
      if (countOf(word) > 0) return;
      const chars = Array.from(word);
      const raw = shown(index, word);
      const rawChars = Array.from(raw);
      if (chars.length < 3) return;
      /* (b) 続きを落とす、あるいは前を落とす。元の語に近いほう（長く残すほう）を先に取る。 */
      for (let k = chars.length - 1; k >= 2; k--) {
        const head = chars.slice(0, k).join("");
        if (countOf(head) > 0) {
          pushShown(
            rawChars.length === chars.length ? rawChars.slice(0, k).join("") : head,
            head,
            "shorten",
          );
          break;
        }
      }
      for (let k = 1; k <= chars.length - 2; k++) {
        const tail = chars.slice(k).join("");
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
    /* 並べ替えは「元の語の意味を残せている順」が先（第 256 回）。割って両方残す見当は
     * 打ち直しても探している物から遠ざからないので、語を 1 つ落とす・短くするより先に置く。
     * 件数の大きさは同じ形の中では見る（1 件だけの見当より当たりのある見当のほうが役に立つ）。 */
    const RANK: Record<string, number> = { split: 0, alone: 1, shorten: 2 };
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
  /**
   * 会期の暦日表示。表の日付列と同じ書き方（暦日 + 曜日、時刻は付けない、同じ年会期で年を
   * 二度書かない）を一覧・行の詳細・0 件の案内・検索索引で共有する。索引がこの形を持たないと、
   * 行の詳細に並ぶ「今後の会期」をコピーして検索欄に貼った人だけ 0 件に落ちる（第 220 回）。
   */
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

  /** 同じ会議のこれから先の会期（行になっている回を除く）。研究会は毎月開くので、
   *  1 行だけ見て「次はいつか」が分からないのは惜しい。 */
  function upcomingEditionsOf(
    conf: unknown,
    exceptStart: string,
    nowMs: number,
    max = 3,
  ): Array<{ start: string; end: string; place: string }> {
    const record = conf as { editions?: Array<Record<string, unknown>> };
    const out: Array<{ start: string; end: string; place: string }> = [];
    for (const ed of record.editions || []) {
      const start = String(ed.event_start || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) continue;
      if (start === exceptStart) continue;
      const startMs = Date.parse(`${start}T00:00:00+09:00`);
      // 会期を終えた回は出さない（開始日が今を向いていても、終了日が過ぎていれば除く）。
      const endMs = Date.parse(`${String(ed.event_end || start)}T23:59:59+09:00`);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
      if (endMs < nowMs) continue;
      out.push({ start, end: String(ed.event_end || start), place: String(ed.place || "") });
    }
    return out.sort((a, b) => a.start.localeCompare(b.start)).slice(0, max);
  }

  /** 行の詳細に並ぶ「今後の会期」1 回の書き方（日程 ＠開催地）。表示と索引で同じ形を持つため
   * の入口 – ＠を含めておかないと、画面からコピーした語の先頭に ＠ が残り、索引の語と
   * つながらずに 0 件へ落ちる（第 220 回）。 */
  function laterEditionLineJa(ed: { start: string; end: string; place: string }): string {
    const place = String(ed.place || "");
    return `${meetingRangeJa(ed.start, ed.end)}${place ? ` ＠${placeJa(place)}` : ""}`;
  }

  /* 行の詳細に並ぶ「今後の会期」の語。表示と同じ `meetingRangeJa` で組み、**この行の回以外の
   * 回をすべて**載せる。画面は「これから先の回を最大 3 回」なので、その集合は必ずここに収まる
   * （行になっている回より前の回でも、まだ開いていなければ画面に出る – CHES の 2026 年回と
   * 2027 年回の関係で実測）。時計で絞らないのは、索引が画面より古くなるのを避けるためで、
   * 逆に広く取りすぎるだけなので検索の当たり方が噓にならない方を取った（第 220 回）。 */
  function laterEditionSearchWords(conf: unknown, exceptStart: string): string {
    const record = conf as { editions?: Array<Record<string, unknown>> };
    const parts: string[] = [];
    for (const ed of record.editions || []) {
      const start = String(ed.event_start || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) continue;
      if (exceptStart && start === exceptStart) continue;
      const end = String(ed.event_end || start);
      /* 日程だけ載せる。併記する開催地をここに載せると、**他の語の当たり方を壊す** –
       * 実際に載せて測ったところ、この行の開催地欄がヨーロッパの行が「南米」で 118 件当たり、
       * 「ハイブリッド」がオンライン参加の記載のない行を出し、「別表記の寄せ」の誤爆が 11 件
       * 増えた（第 220 回。既存の開催地・参加形式の検査がまとめて検出した。第 219 回の
       * `プライバシー` と同じ型）。今後の会期の開催地で行を絞り込みたい人は、その回が
       * 行になったときに引ける（行の会期欄とその回の開催地は必ず対で出ている）。 */
      parts.push(meetingRangeJa(start, end), start, end);
    }
    return parts.join(" ");
  }

  function eventCellJa(row: unknown): string {
    const ed = ((row as { ed?: unknown } | null)?.ed || {}) as Record<string, unknown>;
    const start = String(ed.event_start || "").trim();
    if (!start) return String(ed.date_text || "").trim();
    const withDay = (date: string): string => {
      const day = weekdayJaFromDate(date);
      return day ? `${date}(${day})` : date;
    };
    const end = String(ed.event_end || "").trim();
    return end && end !== start ? `${withDay(start)} 〜 ${withDay(end)}` : withDay(start);
  }

  function deadlinesToCsv(
    rows: readonly Record<string, unknown>[] | null | undefined,
    nowMs: number,
  ): string {
    const lines: string[] = [CSV_HEADERS_JA.join(",")];
    (rows || []).forEach((row) => {
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
         * （2026-08-09 実測: 過ぎた行 2,317 件のうち 279 件が 1 日大きかった）。画面の数を
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
      lines.push(
        [
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
          ed.link || conf.link,
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

  /* 漢字の略字・異字体を折込む（第 241 回）。`〆` は「締」の略字で、収録元が原表記のまま
   * 入る行がある（2026-08-09 生成ビルドの実測: 情報処理学会研究会の「発表申込〆切(延長後)」
   * 「発表原稿〆切」の 4 行）。折込まないと `〆切` は 4 行にしか当たらず、同じ意味の `締切`
   * （700 行）で引いた人と同じ画面に出会えなかった。全角・半角をならす NFKC は漢字の
   * 略字を折込まないので、ここで受ける。照合側（hay）も検索語側も同じ関数を通るので、
   * 一か所で両方に効く。画面に出す文字はここを通らないので表示は変わらない。 */
  const KANJI_VARIANT_FOLD_JA: Record<string, string> = {
    〆: "締",
  };
  const KANJI_VARIANT_FOLD_CHARS = /[〆]/g;

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

  /* 助詞は語の区切りとして読む（第 245 回）。検索語を空白でしか分けていなかったので、
   * 助詞を挟んで打った日本人利用者が 0 行に当たっていた（2026-08-09 生成ビルドの実測・872 行:
   * `セキュリティの会議` 0 行（`セキュリティ` 152 行）・`9月の締切` 0 行（`9月 締切` 209 行）・
   * `国内の研究会` 0 行（`国内研究会` 23 行）・`査読の期間` 0 行（`査読` 13 行）。
   * 助詞は行の文字列でも大量に当たる語なので、内容語としても使えていない（実測: `の` 単体で
   * 390 行・`で` 197 行・`と` 121 行 – 「その語で何を絞りたかったのか」がゼロになる）。
   * 文字は `searchNormalize` を通した語から切る – 片仮名はそのまま残るので `ソフトウェア` の
   * `ト` は平仮名 `と` と違い、語を壊さない（実測: `ソフトウェア` は 4 行のまま変えていない）。
   * 切って語が残らないときは元の語に戻す（`を` だけを打った人に 0 行を返さない）。 */
  const QUERY_PARTICLE_SPLIT_CHARS = "のもへがをやをでには";

  function splitQueryToken(token: string): string[] {
    const parts = token
      .split(new RegExp(`[${QUERY_PARTICLE_SPLIT_CHARS}]`))
      .filter((part) => part.length > 0);
    /* 分けた語が 2 つ以上で、それぞれ 2 文字以上のときだけ採用する。ひらがなの地名は
     * 助詞と同じ字を語の中に持っている（実測: `ながさき` は `が` で割れて `な` + `さき` に、
     * `やまぐち` は `や` が取れて `まぐち` になった – どちらも 1 行も当たらなくなる）。
     * そのような分割は捨てて、打たれた語をそのまま使う。 */
    if (parts.length < 2) return [token];
    for (let i = 0; i < parts.length; i += 1) {
      /* 季節の語は 1 文字（`秋の会議` の `秋`）なので、上の長さの検査を通すと割れない
       * （第 254 回 – 実測: `秋` 802 行 / `秋の会議` 0 行）。表に合う語だと決まっている
       * ものだけ通す – ひらがなの地名を守るための検査なので、語彙が決まっている語は
       * 危険が無い（`春` `夏` `秋` `冬` は地名の一部にはならない – `秋田` は割れない）。 */
      if (parts[i].length < 2 && SEASON_MONTHS_JA[parts[i] as string] === undefined) {
        return [token];
      }
    }
    return parts;
  }

  function queryTokens(query: unknown): string[] {
    const normalized = searchNormalize(query);
    if (!normalized) return [];
    const seen: string[] = [];
    normalized.split(" ").forEach((raw) => {
      const token = raw.replace(QUERY_EDGE_PUNCTUATION, "");
      if (!token) return;
      splitQueryToken(token).forEach((part) => {
        if (part && seen.indexOf(part) < 0) seen.push(part);
      });
    });
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

  /* 畳み込みは入力の文字列だけで決まる（純粋な関数）。検索は行ごとにこれを掛けるので、
   * 1 打鍵で表 1 回ぶん（3,253 行 / 210 万字）を毎回組み直し、同じ量の文字列をゴミとして
   * 捨て続けていた（第 258 回実測: 畳み込み 1 走 13.6 ms、1 打鍵 4 MB のゴミ）。
   * 畳んだ結果を憶えると、検索も語ごとの件数も表を畳み直ししなくなる
   * （検索 1 走 31 ms → 4 ms）。表が無限に育っても困らないよう、上限を越えたらまとめて
   * 捨てて組み直す。文字列以外は鍵が衝突しうる（`null` と `"null"`）ので憶えない。 */
  /* 畳み込みは入力の文字列だけで決まる（純粋な関数）。検索は行ごとにこれを掛けるので、
   * 1 打鍵で表 1 回ぶん（3,253 行 / 210 万字）を組み直し、同じ量の文字列をゴミとして捨てて
   * いた（2026-08-09 生成ビルドで実測: 畳み込み 1 走 13.6 ms、1 打鍵 4 MB のゴミ、
   * 検索 1 走 31 ms → **1.2 ms**、語ごとの件数 93 ms → **4 ms** – 第 258 回）。
   * 憶えた結果はこの関数の側に持つ。検査ハーネスは関数を**名前で抜き出して**組み立てるので、
   * 外側に `const` を増やすとハーネスがそれを知らないまま古い形を組んで落ちる
   * （第 256 回 `shorterHitTipsJa`、第 257 回 `searchGroups`、この関数の 3 回目 – 実発生）。
   * 表が無限に育っても困らないよう、上限を越えたらまとめて捨てて組み直す。
   * 文字列以外は鍵が衝突しうる（`null` と `"null"`）ので憶えない。 */
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
    先々月: -2,
    /* 「来月の締切」を申請書の言葉で `翌月`、「先月」と対で `前月` と打つ人（2026-09-30 実測・
     * 固定時刻 2026-08-09T00:00:00Z・品書 872 行）: `翌月` **0 行**・`前月` **0 行**で件数欄の
     * 解決も無し。同じ日の `来月` 240 行・`先月` 52 行は通っていた – 暦月の offsets 表から
     * この二つの言い方だけ落ちていた（週・年では `翌週` `翌年` の内 `翌年` は第 330 回で入っている）。 */
    翌月: 1,
    前月: -1,
    /* 「今月中の締切をまとめて出したい」は研究計画の立て方で必ず言う形。`中` を足すだけで
     * 0 件になっていた（同じビルドで実測: `今月` 189 件 / `今月中` 0 件、
     * `来月` 241 件 / `来月中` 0 件、`再来月` 186 件 / `再来月中` 0 件）。 */
    今月中: 0,
    来月中: 1,
    再来月中: 2,
  };

  /** 相対月の語 1 つを `YYYY年M月` に解決する。該当しなければ空文字を返す。
   * 基準は JST の暦月（一覧の日時列と同じ）。年跨ぎ（12月 → 翌年1月）に対応する。 */
  function relativeMonthTerm(token: string, nowMs: number): string {
    /* `来月中に` `今月までに` `今月以内` の形で落ちた（第 328 回）。`3月以内` は
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

  /** 相対月の語を `YYYY年M月` へ置き換えた検索語を返す（該当がなければ元の検索語のまま）。
   *
   * 助詞で繋がれた入力も同じ展開をする（第 251 回）。`来月の締切` は空白で区切られないので
   * 丸ごと 1 語として残り、展開が効かなかった – 実測（2026-08-09 生成ビルド・固定時刻
   * 2026-08-09T00:00:00Z）で `来月` 343 行 / `来月 セキュリティ` 41 行なのに
   * **`来月の締切` 0 行**・`来月の論文締切` 0 行。助詞で割った語を同じ表に通す。 */
  function expandRelativeMonths(query: unknown, nowMs: number): string {
    const normalized = searchNormalize(query);
    if (!normalized) return normalized;
    let changed = false;
    const tokens: string[] = [];
    normalized.split(" ").forEach((token) => {
      /* 相対月の語を含むときだけ書き換える。含まない語は**打たれた形のまま**返す –
       * 助詞で割った形に直すと、展開結果をそのまま画面に書く場所（件数欄の
       * 「検索語『X』」）が利用者の入力と違う文字列になり、説明がちぐはぐになる。 */
      const parts = splitQueryToken(token);
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

  /** 相対月の語がどの暦月に解決されたかを `打った語 -> 解決した暦月` の組で返す（第 251 回）。
   *
   * 展開後の文字列と打った文字列を番号で突き合わせるやり方は、助詞で繋がれた形で
   * 壊れる（`来月の締切` は 1 語のまま展開され 2 語になるため、対応がずれ
   * 「来月の締切 = 2026年9月」という読み違えの案内になった）。解決の内側でできた組をそのまま返す。 */
  function relativeMonthPairs(query: unknown, nowMs: number): Array<[string, string]> {
    const normalized = searchNormalize(query);
    if (!normalized) return [];
    const pairs: Array<[string, string]> = [];
    normalized.split(" ").forEach((token) => {
      splitQueryToken(token).forEach((part) => {
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
    /* 「今日中に間に合う締切が見たい」は同じ日の話なので、同じ展開先に向ける
     * （2026-08-09 生成ビルドで実測・第 234 回: `今日` 2 件 / `今日中` 0 件、
     * `本日` 2 件 / `本日中` 0 件、`明日` 4 件 / `明日中` 0 件）。 */
    今日中: 0,
    きょう中: 0,
    本日中: 0,
    明日中: 1,
    // 残り欄が今日出す語（過ぎた分と、1 時間以内の分）。この欄の語を貼れるようにする
    // （第 223 回）。`N 日前に終了` は `N日前` として上の数値側で受ける。
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
    /* 月の側に対になる言い方（`翌月` `前月`）があるのに週の側に無く、実測で `翌週` **0 行**・
     * `前週` **0 行**（同じビルドで `来週` 53 行・`先週` 26 行 – 第 340 回）。週は月〜日の塊
     * （`site/recommender.ts` の上の注と同じ暦の決まり）なので、寄せ先は其のまま。 */
    翌週: 1,
    前週: -1,
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
  };

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
    /* 申請書・年度の話で「当年」「前年」は普通に出る – 実測（第 340 回・同じビルド）で
     * `当年` **0 行**・`前年` **0 行**（`今年` 789 行・`本年` 789 行・`去年` は通っていた）。 */
    当年: 0,
    前年: -1,
    来年: 1,
    らいねん: 1,
    再来年: 2,
    さらいねん: 2,
    去年: -1,
    きょねん: -1,
    せんねん: -1,
    /* `昨年` だけが表に無く、0 行で件数欄の解決も無かった（第 327 回の実測 – `去年` は
     * 同じ年の語なのに通っていた）。 */
    昨年: -1,
    一昨年: -2,
    いとおととし: -2,
    /* 申請書・経理の文脈で「翌年度」「翌年」が普通に出る – 第 330 回の実測で 0 行だった。 */
    翌年: 1,
    よくねん: 1,
    翌々年: 2,
    よくよくねん: 2,
  };

  /* 「今年中」「来年中」「今年いっぱい」は年の語に期間の語が付きただけなので、同じ年へ寄せる
   * （第 330 回）。実測（2026-08-09 生成ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）で
   * `今年` 789 行 / `今年中` **0 行**、`来年` 452 行 / `来年中` **0 行**、`今年いっぱい` **0 行**。
   * 助詞の表（`DATE_TOKEN_TAILS_JA`）に `中` を足すと `来年中` より前の形が壊れるので、
   * 年の語の側で受ける（第 328 回で決めた境界）。 */
  const YEAR_SPAN_TAIL_JA = /^(.+?)(?:中|中間|かけて|いっぱい|以内)$/;

  function relativeYearKeyJa(token: string): string {
    const q = String(token || "");
    if (RELATIVE_YEAR_OFFSETS_JA[q] !== undefined) return q;
    const matched = YEAR_SPAN_TAIL_JA.exec(q);
    if (matched && RELATIVE_YEAR_OFFSETS_JA[matched[1]] !== undefined) return matched[1];
    return "";
  }

  /* 年度（4 月から翌年 3 月）のかたまり。研究費・出張の年度跨ぎは此処で聞く
   * （第 330 回 – 実測で `今年度` `来年度` `前年度` `翌年度` がすべて 0 行だった）。
   * `年度末` `年度初め` は月のまとまりの語（第 327 回）が先に受けるので、此処には置かない。 */
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
  };
  const FISCAL_YEAR_TAIL_JA = /^(.+?)(?:中|以内)$/;

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

  /** 与えた年度（4 月始まり）の 12 か月語（第 330 回と同じ組み立て – 二箇所に書かない）。 */
  function fiscalTermsFromYearJa(base: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const month = 4 + i;
      out.push(month <= 12 ? `${base}年${month}月` : `${base + 1}年${month - 12}月`);
    }
    return out;
  }

  /* 和暦で打つ人が引けない（2026-10-01 実測・2026-08-09 生成の実ビルド・品書 872 行・固定時刻
   * 2026-08-09T00:00:00Z）: `2026年` 789 行・`2027年` 452 行・`今年度` 872 行が通るのに、
   * `令和8年` **0 行**・`令和8年度` **0 行**・`令和7年` **0 行**・`令和8年4月` **0 行**・
   * `平成30年` **0 行**・`昭和60年` **0 行**・西暦の `2026年度` も **0 行**。品書に和暦は
   * 一箇所も無く（`令和` 0 回・`平成` 0 回・`昭和` 0 回）、締切は西暦でしか書かれていない
   * （其の事は裸の `令和` を打った人への案内が既に画面に書いている）。なので**年号を西暦に
   * 直して探す** – 年号と西暦の対応は暦の決まり（其の年号の始まりの西暦年）で、締切の推測では
   * 無い。和暦の年その物が西暦の何年かの対応だけを使い、**其の年号が続いていた範囲外の数値は
   * 直さない**（`平成32年` は直さない – 有り得ない打ち方は其の侭 0 行にして、間違った年に
   * 寄せる事を避ける）。 */
  /** 和暦（`令和8年` `令和8年度` `令和8年4月`）と西暦の年度（`2026年度`）を暦語へ解く。
   * 年号の表は**此処に置く** – 検査は `tests/runtime_extract.ts` の `jsFunction` で関数だけを
   * 組み立てた品から抜き出して走らせるので、関数の外の `const` に置くと届かない（第 341 回・
   * 第 343 回の実発生 – 三度目の同じ穴）。 */
  /* 基準時刻は要らない – 年号と西暦の対応は其の年号が始まった年にだけ決まる（相対的な語と
   * 違って「今年」のような基準を持たない）。 */
  function eraYearTermsJa(token: string): { terms: string[]; 西暦: number; 年度: boolean } | null {
    /* 其の年号が始まった西暦年と、其の年号が続いた最長の年数（元年 = 開始の翌年）。 */
    const 年号の始まり: Record<string, [number, number]> = {
      明治: [1867, 45],
      大正: [1911, 15],
      昭和: [1925, 64],
      平成: [1988, 31],
      令和: [2018, 99],
    };
    /* `元年` はそれ自体に「年」が含まれる（`令和元年年` とは書かない）– 数値の形だけが
     * 後ろの「年」を要求する（第 343 回の実発生 – 初回は `令和元年` が解けなかった）。 */
    /* 月・日まで続ける形（`令和8年8月22日`）も受ける – 和暦の日付で貼り付ける人は多い
     * （実測 2026-10-02: `2026年8月22日` 12 行 / `令和8年8月22日` **0 行**）。 */
    const 和暦の形 =
      /^(明治|大正|昭和|平成|令和)(?:元年|([0-9]{1,2})年)(度)?((?:[0-9]{1,2})月)?((?:[0-9]{1,2})日)?$/;
    /* `度` を必ず要求する – 付けなければ裸の `2026年`（暦年）を年度に化けさせる
     * （第 343 回の実測: 789 行が 872 行になった）。 */
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
      /* `令和8年4月` は其の月の語（月の語は他の月語と同じ経路で 12 か年にまたがって当たる）。 */
      const 月 = Number.parseInt(matched[4], 10);
      if (!(月 >= 1 && 月 <= 12)) return null;
      if (!matched[5]) return { terms: [`${西暦}年${月}月`], 西暦, 年度: false };
      /* 日まで打たれたら其の暦日だけに出す – 年を付けない `8月22日` の形は足さない
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

  /* 月の範囲の言い方を受ける（第 252 回）。研究計画・出張の相談では「9月以降の締切を
   * 見たい」「9月から11月あたりの会議を出したい」がそのまま打たれる。2026-08-09 生成ビルド
   * （固定時刻 2026-08-09T00:00:00Z）で実測: `9月` は 687 行に当たるのに、
   * **`9月以降` 0 行・`9月から` 0 行・`9月から11月` 0 行・`来月以降` 0 行**で、
   * 案内も出ていなかった（2026年9〜12月に当たる行は 957 行ある）。
   * 週の語・年の語と同じく、表に出る暦月語（`monthTermsJa` が hay に入れる形）の
   * OR グループへ展開する。 */
  const MONTH_RANGE_FROM = /^(.+)月(?:以降|以来|から)$/;
  const MONTH_RANGE_SPAN = /^(.+)月から(\d{1,2})月(?:まで)?$/;

  /** 月の語（`9月`・相対月語）を `[年, 月]` に解決する。解決できなければ null。
   * 基準月より前の月を打たれたときは翌年として受け取る – 過ぎた月は計画の対象では
   * ないため（`1月以降` を 8 月に打つ人は翌年 1 月を見る）。 */
  function monthTokenToYearMonth(token: string, nowMs: number): number[] | null {
    const jst = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3_600_000);
    const year = jst.getUTCFullYear();
    const current = jst.getUTCMonth() + 1;
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
      const second = Number(span[2]);
      if (second < 1 || second > 12) return [];
      last = second >= start[1] ? [start[0], second] : [start[0] + 1, second];
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

  /* 季節の語（第 254 回）。「秋の会議を出したい」は分野をまたいだ計画の立て方で普通に言う。
   * 2026-08-09 生成ビルド・固定時刻 2026-08-09T00:00:00Z で実測: **`秋` 0 行・`春` 0 行・
   * `夏` 0 行・`冬` 0 行・`秋の会議` 0 行・`来年の秋` 0 行**（2026年9〜11月に当たる行は
   * 802 行ある）。月の範囲と同じ暦月語の OR グループへ展開する。
   * 区切りは気象月の四つ組み（春 3〜5・夏 6〜8・秋 9〜11・冬 12〜2）。上流の締切名にも
   * 「秋開催」のような表記は無いため、季節の語は表に書かれていない語として扱う
   * （展開された月は件数欄で言う – 伏せた範囲指定は誤信を生む）。 */
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

  /** 助詞で割られた `来年` + `秋` を `来年の秋` の形に寄せる（第 254 回）。
   * `queryTokens` が助詞で割ったあとだと、年の語と季節の語が別々の語になり
   * 「2027 年のどこか」と「2026 年 9〜11 月」のかけ算になってしまう
   * （実測: `来年の秋` 245 行 – 期待は 2027年9〜11月 に当たる 34 行）。 */
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
      splitQueryToken(token).forEach((part) => {
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
      splitQueryToken(token).forEach((part) => {
        const terms = monthRangeTermsJa(part, nowMs);
        if (terms.length) pairs.push([part, `${terms[0]}から${terms[terms.length - 1]}`]);
      });
    });
    return pairs;
  }

  /* 月のまとまり・年の中の地点の語（第 327 回）。実測（2026-09-26 – 2026-08-09 生成ビルドの
   * 品書 872 行・固定時刻 2026-08-09T00:00:00Z）: `今月` 189 行なのに `今月末` **0 行**、
   * `来月` 240 行なのに `来月末` **0 行**、`年内` **0 行**、`年度末` **0 行**、`年末` **0 行**、
   * `年明け` **0 行**で、件数欄の解決も出ていなかった。研究計画では「今月末までに間に合うか」
   * 「年内に出せる枠」という聞き方をするので、暦月語のグループへ展開する。
   * 展開先は**その月の締切** – 行の日付で末日より前を削る作りはしていないので、
   * 「末日より前だけ」とは言わない（締切の推測はしない – AGENTS.md）。 */
  const PERIOD_MONTH_WORDS_JA: Record<string, string> = {
    今月末: "今月",
    今月終わり: "今月",
    月末: "今月",
    この月末: "今月",
    来月末: "来月",
    来月終わり: "来月",
    再来月末: "再来月",
    年度末: "3月",
    年初: "1月",
    /* 年の切れ目の言い方の対が揃っていなかった（2026-10-10 実測・実ビルドの品書 872 行・
     * 固定時刻 2026-08-09T00:00:00Z）: `年末` 183 行（= `12月` と対称差 0）・`年初` 109 行・
     * `年明け` 109 行（いずれも = `1月` と対称差 0）・`年度末` 80 行・`年度初め` 81 行・
     * `年度当初` 81 行が通るのに、`年始` **0 行**・`年初め` **0 行**・`年始め` **0 行**・
     * `年度始め` **0 行**だった（其の方の語が在る対の欠落 – 「締切の推測」には当たらない –
     * 年の初めは其の暦月、年末が `12月` に寄るのと同じ決まり）。 */
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
    /* `年内に` `今月末まで` の形も同じ表に寄せる（第 328 回 – 助詞を剥がした形が表に有るときだけ）。 */
    const target = PERIOD_MONTH_WORDS_JA[dateTokenStemJa(token) || token];
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

  /* 上旬・中旬・下旬（第 332 回）。三日ごとの区切りは JIS X 0412 の分け方に習う –
   * 上旬 1〜10 日、中旬 11〜20 日、下旬 21 日から月末。実測（2026-08-09 生成ビルドの品書
   * 872 行・固定時刻 2026-08-09T00:00:00Z）で `下旬` `上旬` `中旬` `8月下旬` `来月上旬`
   * `今月中旬` はいずれも **0 行**だった（同じ月の `月末` 189 行・`来月末` 240 行は通る）。
   * 月のまとまりを「旬」で聞くのは日本語の普通の名前なので、語尾を剥がすのではなく
   * 条目として受ける。切り方の取り決めが公用の定義に無い語（`月初` `前半` `後半`）は
   * 受けない – 締切の推測はしない（AGENTS.md）。 */
  const MONTH_PART_DAYS_JA: Record<string, [number, number]> = {
    上旬: [1, 10],
    中旬: [11, 20],
    下旬: [21, 0],
  };
  const MONTH_PART_TAIL_JA = /^(.*?)の?(上旬|中旬|下旬)$/;

  /** 「8月下旬」「来月上旬」「下旬」を暦日の幅へ解く（当てはまらなければ null）。 */
  function monthPartRangeJa(
    token: string,
    nowMs: number,
  ): { year: number; month: number; from: number; to: number; label: string } | null {
    const hit = MONTH_PART_TAIL_JA.exec(String(token || ""));
    if (!hit) return null;
    const days = MONTH_PART_DAYS_JA[hit[2]];
    if (!days) return null;
    /* 冠の無い `下旬` だけは今月を基準にする（「下旬の締切」は今月の話をしている）。
     * `来月` のような月の語は検索語の段で既に `2026年9月` へ書き換わる（第 251 回）ので、
     * 西历付きの月の形も受ける – 離して打たれた `来月 下旬` が割れないようにする（第 332 回）。 */
    const 冠 = hit[1] === "" ? "今月" : hit[1];
    const 絶対月 = /^(\d{4})年(\d{1,2})月$/.exec(冠);
    const resolved = 絶対月
      ? [Number(絶対月[1]), Number(絶対月[2])]
      : monthTokenToYearMonth(冠, nowMs);
    if (!resolved) return null;
    const year = Number(resolved[0]);
    const month = Number(resolved[1]);
    const 末日 = new Date(Date.UTC(year, month, 0)).getUTCDate();
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
  /* 「20時」「午後8時59分」の打ち方（第 333 回）。収録の時刻は 24 時間表記の `HH:MM` で、
   * 時の頭は 0 埋めされている（2026-08-09 生成ビルドの品書 872 行の実測: 時刻を持つ 688 行が
   * すべて 2 桁の時で、1 桁の時は 0 行。内訳は `20:59` 516 行・`23:59` 507 行・`08:59` 88 行）。
   * ところが日本語の打ち方 `20時` `午後8時` `20時59分` は 1 語も当たらず黙っていた。
   * 0 埋め以外の形（`9:00`）は出さない – 照合は部分一致なので `9:00` は `19:00` を含み、
   * 9 時で絞ったのに 19 時の行が混ざる（`1月` と `11月` の同じ穴 – 第 315 回）。 */
  /* 「までに」「まで」はここに含めない – 「その時刻より前」という幅は部分一致では作れないので、
   * 下の `clockUntilQueryJa` が案内だけを立てる（第 333 回）。 */
  const CLOCK_JA =
    /^(?:(午前|午後|ごぜん|ごご)?([0-9]{1,2})時(?:(?:([0-9]{1,2})分)|(半))?(台)?|正午)$/;

  /** 時刻の語を `HH:MM` の候補へ解く（当てはまらなければ null）。分が有れば 1 点、
   * 無いときはその 1 時間ぶん（`20時` = 20:00〜20:59）を出す。 */
  function clockTimeTermsJa(token: string): { terms: string[]; 幅: boolean; 解: string } | null {
    const 打たれた語 = String(token || "").trim();
    if (打たれた語 === "正午") {
      return { terms: ["12:00"], 幅: false, 解: "12:00（正午）" };
    }
    const hit = CLOCK_JA.exec(打たれた語);
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

  /** 「20時59分までに」のような“それ以前の時刻”という頼み方（第 333 回）。部分一致では
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
  function periodMonthPairs(query: unknown, nowMs: number): Array<[string, string]> {
    const normalized = searchNormalize(query);
    if (!normalized) return [];
    const pairs: Array<[string, string]> = [];
    normalized.split(" ").forEach((token) => {
      splitQueryToken(token).forEach((part) => {
        const terms = periodMonthTermsJa(part, nowMs);
        if (!terms.length) return;
        const first = terms[0];
        const last = terms[terms.length - 1];
        let label = first === last ? `${first}の締切` : `${first}から${last}の締切`;
        if (part.indexOf("月末") >= 0 || part.indexOf("終わり") >= 0) {
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
        pairs.push([part, label]);
      });
    });
    return pairs;
  }

  /** JST の暦日を基準時刻からの日数ぶん進めた `[年, 月, 日]`。 */
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
    /* 「30 日以内」は画面の絞り込み（`7 日以内` `30 日以内` `90 日以内` `180 日以内`）と同じ
     * 文言なので、語が割ける前に 1 語へ寄せる（第 315 回）。 */
    [/([0-9]{1,4})\s*(?:日間|日|にち)\s*以内/g, (n) => `${n}日以内`],
    /* 「1 週間以内」「2 週間後」を日数の語に寄せる（第 318 回）。**1 週 = 7 日**は暦の定義で、
     * 画面の絞り込み（`7 日以内` `30 日以内`）と同じ形に寄せるだけで換算の發明ではない
     * （月・年は月の長さが違うので寄せない – 下の注）。2026-09-26 実測・同じビルド:
     * `1週間以内` `2週間以内` `3週間以内` `3週間後` すべて **0 行** / 寄せ先の `7日以内` 60 行、
     * `14日後` 19 行、`21日後` 8 行。 */
    [/([0-9]{1,2})\s*(?:週間|週)\s*以内/g, (n) => `${n * 7}日以内`],
    [/([0-9]{1,2})\s*(?:週間|週)\s*(?:後|あと|先)/g, (n) => `${n * 7}日後`],
  ];

  /* 「3月中に出せるか」「11月中の締切」は月のまとまりの言い方で、`今月中`（4,698 行の表）と
   * 同じ頼み方だが、数値の月では引けなかった（2026-09-30 実測・固定時刻 2026-08-09T00:00:00Z・
   * 品書 872 行）: `3月中` **0 行**・`11月中` **0 行** / 同じ月の `3月` 253 行・`11月` は通る。
   * `中` を剥がして其の月の語に寄せる – 月の長さを換えないので、寄せ先は其の月の締切のまま
   * （締切の推測はしない）。`5人中` のような数え手の打ち方と取り違えないため、月として
   * 有り得る 1〜12 だけ寄せる。 */
  /* 「延長締切」「締切延長」「延長された締切」は繋げて打たれると 1 語になって落ちる
   * （2026-09-30 実測・実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）: 行は `延長` の語を
   * 持つ物が **21 行**あって `延長` 21 行・`締切の延長` 21 行で通るのに、**繋げた形はすべて 0 行**
   * （`延長締切` 0・`締切延長` 0・`延長された締切` 0）。延びた締切を訪ねるのは普通なので、
   * 語が割ける前に `延長` の 1 語へ寄せる。**延びた後の日付を保証しない** – 収録は `延長` と
   * 書かれた行を探すだけなので、日付で絞るなら画面の『締切まで』の欄が確かである事は其の侭書く。 */
  /** 「あと 51 日」「51 日後」を `51日後` の 1 語に寄せる（語が割ける前にやる）。 */
  function collapseRelativeDayPhrase(query: unknown): unknown {
    if (typeof query !== "string" || !query) return query;
    /* 全角数字はここで半角に寄せる – 上の規則は数字の形を見るので、全角のまま空格を
       含めた打ち方（`３０ 日以内`）が語に割れて 0 件になっていた
       （2026-09-26 実測: `３０日以内` 249 行 / `３０ 日以内` **0 行** – 照合は NFKC で畳むので
       詰め打ちだけ救われていた）。行の語その物は畳まない – 検索語の側のみの寄せる。 */
    let out = query.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
    /* 漢数字で打たれた日付・期間も此処で算用数字に寄せる（2026-10-07 実測・実ビルドの品書 872 行）:
     * `8月` 210 行・`22日` 63 行・`30日` 82 行・`20日` 93 行・`8月下旬` 91 行・`8月まで` 210 行・
     * `8月締め` 189 行・`3日後` 3 行・`20日後` 7 行・`1週間後` 17 行・`3日以内` 17 行・
     * `令和8年` 789 行が通るのに、`八月` **0 行**・`八月締切` **0 行**・`八月二十二日` **0 行**・
     * `二十二日` **0 行**・`三十日` **0 行**・`八月下旬` **0 行**・`八月まで` **0 行**・
     * `三日後` **0 行**・`二十日後` **0 行**・`一週間後` **0 行**・`三日以内` **0 行**・
     * `令和七年` **0 行**・`平成三十年` **0 行**・`昭和六十年` **0 行**・`二〇二六年` **0 行**だった。
     * **数の語に日付の接頭辞（年・月・日・週）が繋がれた形だけ**を見る – 数の語が単体で立つ物
     * （`一橋` `三重` のような名称）には触れない。行の語その物は畳まない – 検索語の側のみ寄せる
     * （上の全角数字と同じ流儀 – 第 320 回）。変換できない形（`十十` など）は其侭返す。 */
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
    const 数字に直す = (語: string): string | null => {
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
      /* 十の位の上に『〇』を添える書き方（`十〇`）は受けない – 其の方は「一〇」で打たれる。 */
      if (後 && (一の位 < 1 || 後 === "〇")) return null;
      return String(十の位 * 10 + 一の位);
    };
    const 日付の漢数字 = /([〇一二三四五六七八九十]{1,4})(年|月|日|週間|週)/g;
    out = out.replace(日付の漢数字, (全部: string, 数: string, 頭: string) => {
      const 数字 = 数字に直す(数);
      return 数字 === null ? 全部 : 数字 + 頭;
    });
    /* **繋げて打たれた語は此処で寄せる** – 下の `N月中` `N月末` の規則は月の語を壊すので、
     * 其の前に語の形を見る（`3月末まで` のように月と末尾が連なる打ち方も頭の表で受ける –
     * 月の数え方は 1〜12 に絞る）。 */
    /* 「締切未定」「期限未定」も繋げて打たれる（2026-10-04 実測・実ビルドの品書 872 行）:
     * `未定` 6 行・`締切 未定` 4 行が通るのに `締切未定` **0 行**・`期限未定` **0 行**・
     * `日付未定` **0 行**。この収録には『期限』も『日付』の語も **0 行**なので、其れを頭に残した
     * まま二語に割っても 0 行の侭 – 頭を落として『未定』に寄せる（『締切』は 709 行あるので
     * 絞り込みとして残る – 第 344 回で裸の『締め』を寄せなかったのと同じ判断）。 */
    const 未定を繋げた言い方 = /(?:締切|締切り|締めしきり|締め|しめきり|〆切|〆)未定/g;
    const 未定を繋げた別の頭 = /(?:期限|日付)未定/g;
    /* 「8月22日まで」「8月まで」は 0 行（`まで` は収録の語に無い – 実測 0 行）。其の一方
     * `今月まで` 189 行・`来週まで` 60 行・`明日まで` 5 行は期間の語側の規則が既に受けるので、
     * **数値で書いた日付と月だけ**寄せる（既存の規則の行集合と案内を変えない為 – 検査で対照する）。
     * 曜日・週末・平日も同じ頼み方（実測 `週末まで` **0 行** / `週末` 268 行・`金曜まで` **0 行** /
     * `金曜` 133 行）だが、`来週末まで` 51 行・`来週金曜まで` 37 行・`今週金曜まで` 4 行は
     * 期間の語側の規則が日付の範囲に解いていて件数が違う（実測 – `来週末` 単体は 40 行）。
     * なので其の方の形は受けない – 曜日の語は**直前が『週』で終わる物**を寄せず、週末の語は
     * **直前が今・来・先・再である物**を寄せない（`(?<!週)` と `(?<![今来先再])` – 実測で
     * `来週末まで` を寄せると 51 行 → 40 行に化けて其の方の案内を黙って壊した – 検査で対照する）。 */
    const 期日までの言い方 =
      /((?:[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}|[0-9]{1,2}[-/][0-9]{1,2}|[0-9]{1,2}月[0-9]{1,2}日|(?:0?[1-9]|1[0-2])月末?|(?<!週)(?:[月火水木金土日]曜(?:日)?|平日)|(?<!週)(?<![今来先再])週末))まで/g;
    /* 「今月いっぱい」「来週いっぱい」も同じ頼み方（実測 `今月いっぱい` **0 行** / `今月` 189 行・
     * `来週いっぱい` **0 行** / `来週` は通る）。`まで` と違い期間の語の規則が同じ行集合に寄せる
     * 語なので含めてよい（実測で対称差 0 である事を検査する）。`週末いっぱい` `金曜いっぱい` も
     * 同じで、其方に範囲の規則は無いので接頭辞付き（`来週末いっぱい`）も受ける。 */
    const いっぱいの言い方 =
      /((?:[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}|[0-9]{1,2}[-/][0-9]{1,2}|[0-9]{1,2}月[0-9]{1,2}日|(?:0?[1-9]|1[0-2])月末?|今月|来月|再来月|先月|(?:今週|来週|再来週|先週)(?:[月火水木金土日]曜(?:日)?|週末)|[月火水木金土日]曜(?:日)?|週末|平日|今週|来週|再来週|先週|今年|来年))いっぱい/g;
    /* 月の幅を柔らかな日本語で打つ形（2026-10-06 実測・実ビルドの品書 872 行）:
     * `上旬` 35 行・`中旬` 74 行・`下旬` 91 行・`8月下旬` 91 行・`来月下旬` 85 行が通るのに、
     * 同じ幅の別の言い方 `初旬` **0 行**・`半ば` **0 行**・`中頃` **0 行**・`今月半ば` **0 行**・
     * `来月初旬` **0 行**・`8月半ば` **0 行**・`上旬頃` **0 行**だった。其の方の幅の表（上旬・中旬・
     * 下旬 – 日付の範囲に解いて其の日付を案内に書く）に寄せるだけ – 新しい幅を作らない。
     * **下の `N月中` の規則より前に置く**（`8月中頃` は `8月中旬` へ寄せる – 其の後だと
     * `N月中` の規則が月の語を壊す – 第 346 回と同じ理由）。 */
    const 初旬の言い方 = /初旬/g;
    /* 『頃』を付ける形は其の幅の語その物に付ける形として受ける（実測 `上旬頃` **0 行**・
     * `中旬頃` **0 行**・`下旬頃` **0 行**・`8月末頃` **0 行** / 其の方は 35・74・91・210 行）。
     * 此処での注意は二つ – 其の内一つは**其の方の規則より前に置く**事: `月末` を月の語に寄せる
     * 規則（`月の末尾`）が先だと `8月末頃` は `8月頃` になって語に割れなくなる（実測 0 行 –
     * 其の順序を崩す改ざんを検査で検出した）。
     * 尚 `中旬頃` が 0 行だった原因は順序ではなく、此の表に `中旬` の形が抜けていただけだった
     * （初めに書いた時は `上旬` `下旬` だけを受けていた – 配置の理由を書く前に実際に動かして
     * 確認する、第 346 回の教訓を自分でもう一度踏んだ – 第 348 回の実発生）。 */
    /* `週末頃` も同じ（2026-10-14 実測: `週末` 268 行が通るのに `週末頃` **0 行**）。 */
    const 頃の言い方 = /([上下]旬|中旬|月初|月末|週末)頃/g;
    /* `中盤` も同じ幅の別の言い方（2026-10-14 実測・実ビルドの品書 872 行: `中旬` 74 行・
     * `8月中旬` 74 行が通るのに `中盤` **0 行**・`8月中盤` **0 行** – 既に寄せている `半ば`
     * `中頃` と同じ立ち位置で、表に語が抜けていただけ – 第 348 回と同じ原因）。 */
    const 中旬の別の言い方 = /(?:半ば|中頃|中盤)/g;
    /* 「本年度」「当年度」も同じ収録の年度語彙に寄せる（実測 `今年度` 872 行・`来年度` 273 行が
     * 通るのに `本年度` **0 行**・`当年度` **0 行** – 行政寄りの書き方をする人が損をしない為）。
     * 年度その物の幅は其の方の表が日付で書くので、ここでは語を揃えるだけ。 */
    /* 月の語に繋げた『後半』は下旬の別の言い方（2026-10-14 実測: `8月下旬` 91 行・`来月下旬`
     * 85 行が通るのに `8月後半` **0 行**・`来月後半` **0 行**・`9月の後半` **0 行**）。**月の語が
     * 無い `後半` は寄せない**（『試合の後半』等に読めるので一通に決まらない – 第 355 回の
     * 「一通に決まらない語は寄せない」）。「月の語 + の + 後半」も受ける（実測 `9月の後半` 0 行）。 */
    /* 『月後半』『月の後半』（月の語の無い形）も其の方の幅に寄せる（実測 `月後半` **0 行**・
     * `月の後半` **0 行** / `下旬` 91 行 – 月の語が付いた形が通るのに、其れが無い形だけ通ら
     * なかった）。『月半ば』『月中盤』は上の `半ば` `中頃` `中盤` を中旬に寄せる規則が受ける
     * （実測 74 行 – 二重の規則を置かない – 第 344 回）。**前の文字が数字・他の月の語・週の語の
     * 形には当てない** – 其の方の規則が月や週を保ったまま寄せるので、ここで当てると `8中旬`
     * `今中旬` に化けて 0 行に落ちた（実測 – 第 348 回の順序の穴と同じ型）。 */
    const 月の幅の裸の言い方 = /(?<![0-9来今再去本当週])(?:月の|月)(?:後半頃|後半|半ば|中盤)/g;
    const 下旬の別の言い方 = /((?:[0-9]{1,2}月|来月|今月|再来月)の?)後半頃?/g;
    /* 『月終わり』『月の終わり』は `月末` に寄せる（実測 `月末` 189 行が通るのに `月終わり`
     * **0 行**・`月の終わり` **0 行**）。**其の方の `月の末尾` の規則より前に置く** – 先だと
     * 月の語だけを残す形に化けて幅が消える（`8月末頃` で一度踏んだ順序の穴 – 第 348 回）。 */
    const 月終わりの言い方 = /(?:月の?終わり)/g;
    const 年度の別の言い方 = /(?:本年度|当年度)/g;
    out = out.replace(頃の言い方, "$1");
    out = out.replace(初旬の言い方, "上旬");
    out = out.replace(月終わりの言い方, "月末");
    out = out.replace(下旬の別の言い方, "$1下旬");
    /* 裸の形（月の語の付かない『月後半』『月半ば』）は其の方の幅に切り替える。**月の語が
     * 繋がった形を寄せた後でやる** – 先にやると `8月後半` が `8下旬` に化けて 0 行に落ちた
     * （実測 – 第 348 回の順序の穴と同じ型）。 */
    out = out.replace(月の幅の裸の言い方, (全部) => (全部.indexOf("後半") >= 0 ? "下旬" : "中旬"));
    out = out.replace(中旬の別の言い方, "中旬");
    out = out.replace(年度の別の言い方, "今年度");
    out = out.replace(いっぱいの言い方, "$1");
    out = out.replace(期日までの言い方, "$1");
    out = out.replace(未定を繋げた言い方, "締切 未定");
    out = out.replace(未定を繋げた別の頭, "未定");
    /* 上の注の `N月中` の寄せ。**此処で宣言する** – 検査は `tests/runtime_extract.ts` の
     * `jsFunction` で此の関数だけを組み立てた成果物から抜き出して走らせるので、関数の外の
     * `const` に置くと参照が届かない（第 341 回の実発生 – 組み立てた品で
     * `ReferenceError: … is not defined` になった）。毎回作る形は `/g` の続き読みも残さない。 */
    /* `N月中` の後ろに他の語が続く形は寄せない – `12月中旬` を `12月旬` に壊した
     * （第 341 回の実発生 – 上旬・中旬・下旬の表（第 332 回）と同じ月で collision した）。
     * 上旬・中旬・下旬・中旬頃・途中で切れる打ち方が其のまま通る形に留める。 */
    const 月のまとまり = /([0-9]{1,2})月中(?!旬|頃|途|止|断)(?:に)?/g;
    /* 「8月締め」「来月〆」「8月〆切」のように月や週の語に締切の語を**繋げて**打つと 1 語に
     * なって落ちた（2026-10-02 実測・実ビルドの品書 872 行）: `8月` 210 行・`締切` 709 行が
     * 通るのに `8月締め` **0 行**・`来月締め` **0 行**・`8月〆` **0 行**（`〆` を単独で打つと
     * 709 行 – 照合が `〆` を「締」に寄せるので `8月締` の 1 語に化けて月の語が消える為）。
     * 空格を挟んで二語に直す（AND で受ける – 其の月に締切が書かれた行が出る）。
     * **日付その物に繋げて打つ形**も同じ（2026-10-04 実測・実ビルドの品書 872 行）: `8月22日` 12 行・
     * `8月22日 締切` 11 行が通るのに `8月22日締め` **0 行**・`12月19日締切` **0 行**・
     * `令和8年8月22日締め` **0 行**。和暦の日付は後に西暦の語へ解くが、締切の語が繋がったままでは
     * 語に割れず其処に届かない。**和暦の枝は要らない** – `令和8年8月22日締め` の中にも `8月22日締め`
     * の形が在るので其のまま受かり、剥がした後も 11 行の侭だった（実測 – 二重の規則を置かない）。
     * 日付の形は月の形より先に並べる（長い形が先に勝つ – 逆順だと `8月` だけ寄せて `22日締め` が
     * 残る）。 */
    /* 年の切れ目の語に締切の語を繋げた形（2026-10-10 実測・実ビルドの品書 872 行）:
     * 空格で打った方は通る（`年末 締切` 127 行・`年初 締切` 90 行・`年度末 締切` 63 行・
     * `年度初め 締切` 62 行）のに、**繋げた瞬間に 0 行**（`年末締切` **0 行**・`年始締切` **0 行**・
     * `年初締切` **0 行**・`年度末締切` **0 行**・`年度初め締切` **0 行**・… 十語すべて）だった。
     * 第 344 回（`8月22日締切`）・第 348 回（`上旬締切`）と同じ流儀で頭の表に足す（其の方の語に
     * 直して其の方の規則に渡す – 空格で打った方と対称差 0）。**長い形を先に置く**（`年度末` を
     * `年末` で受けると頭がずれる）。
     * **`まで` `いっぱい` の側には足さない**（2026-10-10 実測で決めた）: 『来月末まで』『年度末まで』
     * は期間の頼み方で、其の期間の締切全部を出す範囲の規則が受ける形だから（第 331・332 回 –
     * `来月` を `まで` の頭に入れると期間が其の月に潰れる – 既存の検査が其れを張っていて、
     * 此の回合の初めに足した際に実際に落ちた）。実測 `来月末まで` 240 行は範囲の規則が其のまま受ける
     * （`来月まで` 240 行と対称差 0 – 繋げても繋がなくても同じ – 足す必要はなかった）。 */
    /* 日付を ISO・スラッシュ書き（`2026-08-22` `8/22`）で打つ人は、其れだけで 12 行に会える
     * （2026-10-09 実測・実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z: `2026-08-22` 12 行・
     * `8/22` 12 行・`8-22` 12 行・`2026-08-22 締切` 11 行・`8/22 締切` 11 行・`2026-08-22まで` は
     * 空格でも **0 行** – `まで` の側は和暦・和文の日付しか見ていなかった）。なのに締切の語を
     * **繋げて**打つと **0 行**（`2026-08-22締切` **0 行**・`8/22締切` **0 行**・`8-22締切` **0 行**・
     * `2026-08-22〆` **0 行**・`2026-08-22まで` **0 行**・`8/22まで` **0 行**・
     * `2026-08-22いっぱい` **0 行**）。上の和文の日付と同じ流儀で頭の表に加え、其の日付その物に
     * 直す（空格で打った方と対称差 0 – 検査で張る）。**年の有四桁の形を先に置く** –
     * さもないと `2026-08-22` の内で `8-22` が先に当たり、案内が打たれていない語を名指す。 */
    const 締切を繋げた言い方 =
      /((?:(?:年度当初|年度初め|年度始め|年度末|再来月末|来月末|今月末|年末|年初め|年始め|年始|年初|年明け|月末)|[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}|[0-9]{1,2}[-/][0-9]{1,2}|[0-9]{1,2}月[0-9]{1,2}日|(?:[月火水木金土日]曜(?:日)?|週末|平日|明後日|明日|昨日|本日|今日)|(?:(?:今|来|再来|先|[0-9]{1,2})月?)?(?:上|中|下)旬|(?:0?[1-9]|1[0-2])月|今月|来月|再来月|先月|今年|来年|再来年|今年度|来年度|今週|来週|再来週|先週))(?:の)?(?:締めしきり|締め|締切|締切り|しめきり|〆切|〆)/g;
    /* 日付に繋がれた締切の語と同じ理由で、**その日・その曜日を打つ形**も受ける（2026-10-05 実測・
     * 実ビルドの品書 872 行）: `週末 締切` 210 行・`金曜 締切` 112 行・`平日 締切` 499 行・
     * `明日 締切` 3 行・`明後日 締切` 11 行・`来週月曜 締切` 3 行が通るのに、`週末締切` **0 行**・
     * `金曜締切` **0 行**・`月曜〆` **0 行**・`平日しめきり` **0 行**・`明日締切` **0 行**だった。
     * 其の日・其の曜日の語は其侭置いて『締切』を分けるだけ – 期間の語側の規則（`明日` `来週末` を
     * 日付に解く）は其侭後に効く（`来週末締切` は `来週末 締切` の 38 行になる）。
     * **週を付けた形のための枝は要らない** – `来週月曜締切` の中にも `月曜締切` の形が在るので
     * 其のまま受かり、枝を剥がしても 3 行の侭だった（第 346 回と同じ判断 – 二重の規則を置かない。
     * 案内の側の表は寄せた語 `来週月曜` を名指す為に其の形を持つ – あちらは別物）。
     * **月の幅（上旬・中旬・下旬）に繋がれた形も同じ頭で受ける**（2026-10-06 実測）:
     * `8月上旬 締切` 30 行・`来月上旬 締切` 73 行・`今月中旬 締切` 70 行が通るのに
     * `8月上旬締め` **0 行**・`来月上旬締め` **0 行**・`上旬締切` **0 行**・`8月中旬締め` **0 行**
     * だった（月の形 `(?:0?[1-9]|1[0-2])月` だけだと `8月上旬締め` で `8月` までしか受けず、
     * 残った `上旬締め` は語に割れない – 実測 0 行）。其の幅の語単体（`上旬締切`）も受ける –
     * 実測 `上旬 締切` 30 行 / `上旬締切` **0 行**だった。
     * `本日締切` `今日締切` も同じ形で受ける（実測 `本日 締切` 0 行 – 此れらは 0 件の侭だが、
     * 打ち方で損をしない為の寄せであり、件数が増える理由にはしない）。 */
    /* 「3月末に出る枠」は其の月の語（`今月末` 189 行・`来月末` 240 行が通るのと同じ頼み方）。
     * `N月末` は語が割れて 0 行だった（実測 `8月末` **0 行** / `8月` 210 行）。`月末処理` のような
     * 語に化けないため、後ろに別の語が続く形は寄せない（第 341 回の `N月中` と同じ守り）。 */
    const 月の末尾 = /([0-9]{1,2})月末(?!処理|尾)/g;
    /* 締切が延びた事を訪ねる繋げた言い方（此処に置く – 関数の外の `const` にすると、
     * `jsFunction` で関数だけ抜き出す検査が `ReferenceError` になる – 第 341 回の教訓）。 */
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
    /* `N月末` を先に其の月へ寄せる – 後に繋げた締切の語を割るとき、`3月末締め` が
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
    return out;
  }

  /** 数値の相対日（`51日後` `3日前`）。語の形を壊さない範囲で 1 暦日に展開する。 */
  function numericRelativeDay(token: string, nowMs: number): string[] | null {
    const matched = /^([0-9]{1,4})(日後|日前)$/.exec(token);
    if (!matched) return null;
    const n = Number(matched[1]);
    if (!(n >= 1 && n <= 3650)) return null;
    const ymd = offsetCalendarDay(nowMs, matched[2] === "日後" ? n : -n);
    return [token, `${ymd[0]}年${ymd[1]}月${ymd[2]}日`, `${ymd[1]}月${ymd[2]}日`];
  }

  /* 「7日以内」「30日以内」を、今日から N 日後までの暦日の候補グループへ展開する（第 315 回）。
   * 画面は同じ文言の絞り込み（`7 日以内` `30 日以内` `90 日以内` `180 日以内`）を持つので、
   * 検索欄に打った人が 0 行に当たっていた（2026-09-25 実測・2026-08-09 生成ビルドの品書 872 行:
   * `7 日以内` `7日以内` `30 日以内` `30日以内` `90日以内` `180日以内` すべて **0 行** –
   * 実際に 30 日以内に締切を持つ行は 210 行、7 日以内は 40 行あった）。
   * 「N 日前」のように 1 暦日へは畳まない – 「以内」は範囲なので、`N日後` の 1 語と同じ
   * 扱いにすると 1 日ぶんの行しか返らない（実測: `30日後` は 10 行）。
   * 週・月の単位は展開しない – 「1 か月 = 30 日」のような換算を画面のどこにも書いていないので、
   * 検索の側だけで換算を發明しない（第 311 回の曜日表・暦月語とは意味が重ならない）。 */
  function withinDaysTermsJa(token: string, nowMs: number): string[] | null {
    const matched = /^([0-9]{1,4})日以内$/.exec(token);
    if (!matched) return null;
    const days = Number(matched[1]);
    /* 展開する範囲の上限は 1 年 – それ以上は「来年」などの暦月語で引く方が速い
     * （上限を置くのは検査ハーネスの都合でもある – ハーネスは関数を 1 本ずつ抽出して
     * 組み立てるので、モジュール定数を関数の中に置かないと `not defined` になる – 第 257 回）。 */
    if (!(days >= 1 && days <= 365)) return null;
    const out: string[] = [token];
    for (let d = 0; d <= days; d++) {
      const ymd = offsetCalendarDay(nowMs, d);
      const yearMonthDay = `${ymd[0]}年${ymd[1]}月${ymd[2]}日`;
      if (out.indexOf(yearMonthDay) < 0) out.push(yearMonthDay, `${ymd[1]}月${ymd[2]}日`);
    }
    return out;
  }

  /* 日付の語に**付きただけ**で 0 件になる言い方（第 328 回）。実測（2026-09-27 –
   * 2026-08-09 生成ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
   * `明日中` は通るのに `明日中に` **0 行**、`今週中` 19 行 / `今週中に` **0 行**、
   * `来週中` 53 行 / `来週中に` **0 行**、`来月中` 240 行 / `来月中に` **0 行**、
   * `年内` 772 行 / `年内に` **0 行**、`今月末` 189 行 / `今月末に` **0 行**、
   * `明日` 4 行 / `明日まで` **0 行**・`明日までに` **0 行**・`今日までに` **0 行**・
   * `来週までに` **0 行**・`今月までに` **0 行**・`3月までに` **0 行**。
   * 剥がした後に残る形が日付の表に**有るときだけ**寄せる（無い物は寄せない –
   * 第 326 回と同じ判断）。`から` と `以降` は意味が「それ以降」になるので、ここで剥がさない
   * （一日分の行だけ出して「以降」とは言えない）。 */
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

  /** 日付の語の表に載っている形か（助詞を剥がした後の検証に使う）。 */
  function isDateTableWordJa(word: string): boolean {
    return (
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

  /** 日付の語に助詞などが付きただけの形を、表に有る形へ寄せる（無ければ空文字）。 */
  function dateTokenStemJa(token: string): string {
    const q = String(token || "");
    if (q.length < 3) return "";
    for (const tail of DATE_TOKEN_TAILS_JA) {
      if (q.length <= tail.length + 1 || !q.endsWith(tail)) continue;
      const stem = q.slice(0, -tail.length);
      if (isDateTableWordJa(stem)) return stem;
    }
    return "";
  }

  /* 「今日から 3 日」「今日から 1 週間」は、同じ幅を `3日以内` `1週間以内` と言う形と
   * 同じ締切を指す（第 328 回の実測: `今日から3日` **0 行** / `3日以内` 17 行で、同じ行集合）。
   * 幅の日数は `withinDaysTermsJa` が持つ物（1〜365）だけ通す。 */
  const FROM_TODAY_HEAD = /^今日から([0-9]{1,3})(.+)$/;
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
    const matched = FROM_TODAY_HEAD.exec(String(token || "").replace(/からに$/, ""));
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

  /* 週と曜日を**繋げて**打った形（`今週金曜` `来週木曜日`）。実測（2026-09-28 –
   * 2026-08-09 生成ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）で、助詞を挟む形は
   * 当たるのに繋げた形は 0 行だった – `今週の水曜` 1 行 / `今週金曜` **0 行**、
   * `来週の木曜日` 4 行 / `来週月曜` **0 行**・`来週火曜` **0 行**・`来週土曜` **0 行**。
   * 離して打たれた形（`今週 水曜`）は「今週の行 AND 水曜の語」になるため、締切日が別の日の
   * 行が混ざっていた（`今週の水曜` 1 行 / `2026年8月5日` 3 行で**別の行** – 第 329 回）。
   * なので両方を同じ 1 日へ解く。月の語（`来月中`）とは語が重ならない（`中` を要求しない）。 */
  const PRESSED_WEEKDAY_JA =
    /^(今週|こんしゅう|来週|らいしゅう|再来週|さいしゅう|先週|せんしゅう|前週|翌週)(?:の)?(?:([月火水木金土日])(?:曜)?(?:日)?|末)$/;
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
     * （実測で `週末` 268 行には今週以外も含まれる）。なので其の週の暦日 2 日に解く –
     * 週は月〜日の塊（上の暦の決まり）で、土曜は 6 番目・日曜は 7 番目。*/
    if (matched[2] === undefined) {
      const 土曜 = String(days[5] || "");
      const 日曜 = String(days[6] || "");
      return 土曜 && 日曜 ? [土曜, 日曜] : null;
    }
    const index = WEEKDAY_ORDER_JA.indexOf(matched[2]);
    if (index < 0) return null;
    const day = String(days[index] || "");
    /* 年を付けない `8月5日` の形は足さない – 部分一致なので他の年の同じ日の行を拾う
     * （第 329 回の実測: 年付き 3 行に対して 8 行に化けた）。hay は和暦付きの語を持つ。 */
    return [day];
  }

  /** 与えた暦日（[年, 月, 日]）が基準時刻の JST の日より前か（第 329 回）。
   * 件数欄の幅と週+曜日の案内で同じ判断を二重に書くと、改ざんでも片方だけ壊れて
   * 検査が黙っていた（第 329 回の改ざんで実発生）。 */
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

  /** 今日から指定した暦日までの幅を、件数欄の形で書く（第 328 回）。 */
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
    /* 一日ぶんだけの幅（`今日まで`）に「〜同じ日」を書いても役に立たない（第 328 回）。 */
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

  /** `明日まで` `来週までに` の形 – 期日までと聞く人なので、今日からその日までを出す
   * （行は締切日を 1 つ持つので OR の並びで受ける – `withinDaysTermsJa` と同じ組み立て）。 */
  function untilDayTermsJa(token: string, nowMs: number): string[] | null {
    const q = String(token || "");
    if (!/(?:までに|まで)$/.test(q)) return null;
    const stem = dateTokenStemJa(q);
    const head = /^(.+?)(?:までに|まで)$/.exec(q);
    const pressed = head ? pressedWeekdayJa(head[1], nowMs) : null;
    /* 週+曜日を繋げた形（`今週金曜まで`）は表に無い語なので、剥がした形が無くても続ける
     * （第 329 回 – ここでの早期 return で 0 行のままだった）。 */
    if (!stem && !pressed) return null;
    const dayOffset = RELATIVE_DAY_OFFSETS_JA[stem];
    let last: number[] | null = null;
    /* 「今月下旬までに」は下旬の末日までの幅（第 332 回）。 */
    const part = monthPartRangeJa(stem || q, nowMs);
    if (part) last = [part.year, part.month, part.to];
    if (dayOffset !== undefined) {
      last = offsetCalendarDay(nowMs, dayOffset >= 0 ? dayOffset : 0);
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
     * （第 329 回）。その日 1 日だけを出す – 過ぎた締切の扱いは下の案内で言う。 */
    if (isPastJstDay(last, nowMs)) {
      return [`${last[0]}年${last[1]}月${last[2]}日`, `${last[1]}月${last[2]}日`];
    }
    const out: string[] = [];
    for (let d = 0; d <= 370; d += 1) {
      const ymd = offsetCalendarDay(nowMs, d);
      out.push(`${ymd[0]}年${ymd[1]}月${ymd[2]}日`, `${ymd[1]}月${ymd[2]}日`);
      if (ymd[0] === last[0] && ymd[1] === last[1] && ymd[2] === last[2]) break;
    }
    return out;
  }

  /** 相対日・相対日の語を、暦日の候補グループへ展開する（OR の組）。 */
  /* 「半年」は画面が持つ幅の選択肢（『締切まで』の `180 日以内`）を受けて受ける（第 330 回 –
   * 実測で `半年` `半年以内` は 0 行だった。月の単位を検索側で換算しない決裁（第 315 回 –
   * `3か月以内` は展開しない。`6か月以内` も展開されないのを第 330 回の実測で確認した –
   * 「半年」だけは画面の 180 日という幅がそのまま使えるので受け、暦の半年と 1〜3 日ずれる
   * 事は件の数欄で正直に書く（締切の推測はしない – AGENTS.md）。 */
  const HALF_YEAR_JA = /^半年(?:以内|間)?$/;
  const HALF_YEAR_DAYS_JA = 180;

  function relativeDayGroups(token: string, nowMs: number): string[] | null {
    /* 「明日まで」「来週までに」は期日なので、今日からその日まで（第 328 回）。 */
    const until = untilDayTermsJa(token, nowMs);
    if (until) return [token].concat(until);
    /* 「今日から 3 日」は `3日以内` と同じ幅（第 328 回）。 */
    const fromToday = fromTodayTermsJa(token, nowMs);
    if (fromToday) return [token].concat(fromToday);
    /* `令和8年` `令和8年度` `2026年度` は西暦の暦語に解ける（第 343 回 – 品書は西暦のみ）。 */
    const 和暦 = eraYearTermsJa(token);
    if (和暦) return [token].concat(和暦.terms);
    /* 「今週金曜」「来週木曜日」は締切日がその日の行に出会う（第 329 回）。 */
    const pressedDay = pressedWeekdayJa(token, nowMs);
    if (pressedDay) return [token].concat(pressedDay);
    /* 「今年度」「来年度中」は年度（4 月〜翌年 3 月）の月語に展開する（第 330 回）。 */
    const fiscal = fiscalYearTermsJa(token, nowMs);
    if (fiscal) return [token].concat(fiscal);
    /* 「8月下旬」「来月上旬」は月の三日ごとの区切り（第 332 回）。 */
    const monthPart = monthPartTermsJa(token, nowMs);
    if (monthPart) return [token].concat(monthPart);
    /* 「20時」「午後8時59分」は収録の 24 時間表記 `HH:MM` に寄せる（第 333 回）。 */
    const clock = clockTimeTermsJa(token);
    if (clock) return [token].concat(clock.terms);
    /* 「半年（以内）」は `6か月以内` と同じ幅（第 330 回 – 数字の無い語は下の表が読めない）。 */
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
    return KIND_LABEL_JA[key] || key;
  }

  /* 日付の欄を何と呼ぶか、種別ごとに決める（第 299 回）。カレンダー配信用の `deadlines.ics` は
   * 本文の行がそのまま表示されるので、欄の名前がその日の呼称になる。実測（2026-09-24・
   * 2026-08-09 生成ビルド）では 928 個のイベントのうち **167 個**が採否通知・査読結果公開・
   * 反論期間開始で、人が何かを出す日ではないのに全て「締切: 2026-08-09 09:00（JST）」と
   * 書かれていた。表に出さない種別でもカレンダーには載る（第 288 回）ので、ここで欄名を決める。
   * 概要・論文・補足資料・カメラレディ・登録・反論期間終了・常時受付は、そのまま「締切」。 */
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

  /* 海外の開催地は画面に `Seattle, USA` のように英文字で書かれる（公式表記のまま変えない）。
   * それでも日本人は「シアトル」「米国」と打つので、**同じ場所を指す別表記**を検索語の組に
   * 足す。語自体は画面に出ている形のまま入れる（表示に無い語へ寄せない）。
   * 対象は収録カタログの開催地に現れる都市に限定する（実測で英字の都市句 124 種、
   * うち日本語名が一意に決まるものだけを挙げた。収録に現れない `仙台` `広島` のような
   * 表記は、会場が日本語で書かれているため既に引けており、英文字側は死語になるので置いていない）。
   * 変更前はこの形で 0 件だった:
   * `東京` 0（`tokyo` は 11 件）/ `シアトル` 0 / `ホノルル` 0 / `米国` 0（`アメリカ` 99 件）。 */
  const PLACE_QUERY_ALIASES_JA: string[][] = [
    ["米国", "usa"],
    ["米国", "america"],
    ["合衆国", "usa"],
    /* `合衆国` は `米国` より 26 行少なかった（2026-09-25 実測: 合衆国 182 行 / 米国 208 行）。
     * 届かなかった行は開催地に `United States` と書く行で（其の表記 12 種 – `Wilmington, North
     * Carolina, United States`）、`合衆国` には `usa` と `america` の寄せしかなかった。
     * `米国` は地域まとめの構成員なので地域まとめ側で拾えていた – 同じ国を指す言い方は同じ
     * 寄せ先を持つ。`United States of America` の表記を書く行は 0 行なので `america` は足さない
     * （収録に現れない表記を寄せ先にしない）。 */
    ["合衆国", "united states"],
    /* 「英国」と「イギリス」は同じ国を指すのに、寄せ先が揃っていなかった（2026-09-25 実測・
     * 2026-08-09 生成の実ビルドの品書 872 行で `英国` 18 行 / `イギリス` 32 行 – 開催地に
     * `United Kingdom` と書く行は `イギリス` の表示ラベルでしか当たらず、`英国` は `UK` と
     * `England` を書く行にしか届かなかった）。画面の開催地は「Edinburgh, イギリス」の形で
     * 表示ラベルを出すので、ラベルの語を打った人は当たり、書き言葉でいちばん多く使う
     * 「英国」を打った人だけ 17 行に会えなかった。同じ国を指す言い方は同じ寄せ先を持つ、
     * という形に直す（`米国` / `アメリカ` は既に当たり集合が一致していた – 対称差 0 行）。
     * 上流の誤記 `United Kindom` への寄せは足さない – 収録カタログに其の表記を書く行は
     * 0 行だった（2026-09-25 実測）。 */
    ["英国", "uk"],
    ["英国", "england"],
    ["英国", "united kingdom"],
    ["イギリス", "uk"],
    ["イギリス", "england"],
    ["イギリス", "united kingdom"],
    ["豪州", "australia"],
    /* 都市の和名は、同じ読みを表記の違う二通りで書く人が居る。表に載った片方だけを打てば
     * 良いという形にしておくと、もう一方の打ち方が黙って 0 行になる（2026-09-25 実測・
     * 2026-08-09 生成の実ビルドの品書 872 行で `収録 N 行 / 和名で打った行数 / 漏れ`）:
     *   `モントリオール` 13 / 13 / 0 に対して `モントリアル` 13 / 0 / 13
     *   `マドリード` 2 / 2 / 0 に対して `マドリッド` 2 / 0 / 2
     * 長音と小書きの差は検索の折り合わせでは解消されない（片方の表記が 0 行だったことが其の
     * 実測になる）。同じ読みを表記の数だけ表に置く。
     * 併せて、収録に在るのに和名の寄せが一度も無かった都市を足す:
     *   `バルパライソ` 4 / 0 / 4、`パナマシティ` 4 / 0 / 4（`パナマ` は国の寄せで 4 行当たっていた）、
     *   `フェニックス` 1 / 0 / 1。
     * 足さなくて良かった語: `フロリアノポリス`（9 行）は追加する前から 9 行当たっていた
     * （実測 – 誤字の `フルリアノポリス` で測って 0 行だったので、欠けていると誤診した）。
     * 当たっている語を足し込むと、後の人が「足す前は何行だったのか」を追えなくなる。
     * 置かなかった語: `ライプル`（インド Raipur 4 行）– 日本人が打つ形が定まらず、`インド`
     * （国の寄せで当たる）で足りる。`サン・フランシスコ`（中黒入り 7 行）は現代の日本語で
     * 中黒を書く人が少ないので置いていない。 */
    ["モントリアル", "montreal"],
    ["マドリッド", "madrid"],
    ["バルパライソ", "valparaiso"],
    ["パナマシティ", "panama city"],
    ["フェニックス", "phoenix"],
    /* 以下は、品書の開催地の都市成分を走査して（和名の寄せが表に無い物を数える）収録に在るのに
     * 和名が 0 行だった都市。日本人が打つ形が一通りに決まる物だけを挙げた
     * （2026-09-25 実測・直し前に各 0 行 / 収録 2〜3 行 / 寄与外 0 行）:
     * `グラナダ` `チャールストン` `リッチモンド` `アリカンテ` `マンガロール` `平昌`
     * `長沙` `無錫` `ゴア`（ゴア州）*/
    ["グラナダ", "granada"],
    ["チャールストン", "charleston"],
    ["リッチモンド", "richmond"],
    ["アリカンテ", "alicante"],
    ["マンガロール", "mangalore"],
    ["平昌", "pyeongchang"],
    ["長沙", "changsha"],
    ["無錫", "wuxi"],
    ["ゴア", "goa"],
    ["東京", "tokyo"],
    ["横浜", "yokohama"],
    ["京都", "kyoto"],
    ["神戸", "kobe"],
    ["奈良", "nara"],
    ["大阪", "osaka"],
    ["名古屋", "nagoya"],
    ["福岡", "fukuoka"],
    // 以下は収録カタログの日本開催行に実際のつづりで現れる都市（2026-09-23 に
    // `data/snapshot.json` の日本開催行 72 行の都市表記 18 種を数えて追記）。
    // 日本語で打つと 0 件、英文字で打つと当たる、という状態を無くす。
    ["金沢", "kanazawa"],
    ["福井", "fukui"],
    ["岐阜", "gifu"],
    ["長崎", "nagasaki"],
    ["沖縄", "okinawa"],
    ["筑波", "tsukuba"],
    ["宮古島", "miyakojima"],
    ["シカゴ", "chicago"],
    ["シドニー", "sydney"],
    ["メルボルン", "melbourne"],
    ["パース", "perth"],
    ["ブリスベン", "brisbane"],
    ["オークランド", "auckland"],
    ["ゴールドコースト", "gold coast"],
    ["ソウル", "seoul"],
    ["テジョン", "daejeon"],
    ["大田", "daejeon"],
    ["香港", "hong kong"],
    ["マカオ", "macao"],
    ["サンディエゴ", "san diego"],
    ["ローマ", "rome"],
    ["ミラノ", "milan"],
    ["ナポリ", "naples"],
    ["バリ", "bari"],
    ["ボローニャ", "bologna"],
    ["バンクーバー", "vancouver"],
    ["ロンドン", "london"],
    ["グラスゴー", "glasgow"],
    ["エジンバラ", "edinburgh"],
    ["ランカスター", "lancaster"],
    ["ウィーン", "vienna"],
    ["リスボン", "lisbon"],
    ["ポルト", "porto"],
    ["バルセロナ", "barcelona"],
    ["マドリード", "madrid"],
    ["バレンシア", "valencia"],
    ["サンフランシスコ", "san francisco"],
    ["ロサンゼルス", "los angeles"],
    ["サンタクララ", "santa clara"],
    ["サンタバーバラ", "santa barbara"],
    ["サンノゼ", "san jose"],
    ["リバサイド", "riverside"],
    ["ピッツバーグ", "pittsburgh"],
    ["トロント", "toronto"],
    ["オタワ", "ottawa"],
    ["アブダビ", "abu dhabi"],
    ["ドバイ", "dubai"],
    ["上海", "shanghai"],
    ["杭州", "hangzhou"],
    ["北京", "beijing"],
    ["広州", "guangzhou"],
    ["深圳", "shenzhen"],
    ["武漢", "wuhan"],
    ["成都", "chengdu"],
    ["瀋陽", "shenyang"],
    ["天津", "tianjin"],
    ["蘇州", "suzhou"],
    ["ハルビン", "harbin"],
    ["ソルトレイクシティ", "salt lake city"],
    ["モントリオール", "montreal"],
    ["ホノルル", "honolulu"],
    ["コペンハーゲン", "copenhagen"],
    ["シアトル", "seattle"],
    ["ダブリン", "dublin"],
    ["リオデジャネイロ", "rio de janeiro"],
    ["フィラデルフィア", "philadelphia"],
    ["ボルチモア", "baltimore"],
    ["台北", "taipei"],
    ["タイペイ", "taipei"],
    ["プラハ", "prague"],
    ["アムステルダム", "amsterdam"],
    ["ロッテルダム", "rotterdam"],
    ["デルフト", "delft"],
    ["アテネ", "athens"],
    ["リマソル", "limassol"],
    ["ハノイ", "hanoi"],
    ["デンバー", "denver"],
    ["オーランド", "orlando"],
    ["クアラルンプール", "kuala lumpur"],
    ["ヘルシンキ", "helsinki"],
    ["タンペレ", "tampere"],
    ["パリ", "paris"],
    ["ニューオーリンズ", "new orleans"],
    /* 開催地の日本語の別の言い方・国・州の正式名（2026-10-18 実測・実ビルドの品書 872 行）。
     * 直し前は下の語を打つと **0 行で案内も無し**、其の方の英語の表記は通る（括弧内は其の方の行数）。
     * 内訳は三種類 – ① 都市の略した言い方（`ソルトレイク` – 表には `ソルトレイクシティ` が在った）
     * ② 同じ国の別の表記（`ギリシア` – 表には `ギリシャ` が在った）
     * ③ 正式名・州の付き方（`大韓民国`・`ニューヨーク州`・`イングランド` – 収録の原文は `korea`
     * `new york` `england`）。**1 行以上出る条目だけを置く**（此の表の決まり – 行を増やさない、
     * 打ち損じの語を勝手に作り出さない）。 */
    ["リバースサイド", "riverside"], // 19 行
    ["ソルトレイク", "salt lake city"], // 9 行
    ["ギリシア", "greece"], // 25 行（`ギリシャ` の別の表記 – 表の側は 1 通りの綴りしか持たなかった）
    ["大韓民国", "korea"], // 14 行（`韓国` は既に通った）
    ["エジプト", "egypt"], // 1 行
    ["ノースカロライナ", "north carolina"], // 1 行
    ["ニューヨーク州", "new york"], // 1 行（`ニューヨーク` は州の寄りに既に在った – 其の方の原文の行）
    ["イングランド", "england"], // 35 行
    /* 収録カタログの開催地に実際のつづりで現れる都市を、カタカナ入力で引けるようにする
     * （2026-09-23 に `data/snapshot.json` の開催地を数えて、収録 5 行以上かつ表の無かった
     * 都市を挙げた）。海外の出張先はカタカナで覚えるのが普通で、英文字のつづりを
     * 打つ人は多くない。1 行も増やさない条目は置かない（同じ検査を通している）。
     * 開き直しの許す寄せもある: `ワシントン` は `Washington, DC` だけでなく
     * `Bellevue, Washington`（州）や `Washington University ...` にも当たる。開催地には
     * 国・州が併記されるので、当たった行で見分けられると判断した。 */
    ["リール", "lille"],
    ["ツーソン", "tucson"],
    ["チェジュ", "jeju"],
    ["チェジュ島", "jeju island"],
    ["マカオ", "macau"],
    ["ブエナビスタ", "buena vista"],
    ["バンガロール", "bangalore"],
    ["ベンガルール", "bengaluru"],
    ["ルッカ", "lucca"],
    ["レントン", "renton"],
    ["ビルバオ", "bilbao"],
    ["ベルン", "bern"],
    ["ストラスブール", "strasbourg"],
    ["アーヘン", "aachen"],
    ["ワシントン", "washington"],
    ["ヘント", "ghent"],
    ["アーバー", "ann arbor"],
    ["ボイシ", "boise"],
    ["ニューヨーク", "new york"],
    ["テッサロニキ", "thessaloniki"],
    ["シアトル", "seattle"],
    ["シナヤ", "xi'an"],
    ["ヴィリニュス", "vilnius"],
    ["マラケシュ", "marrakesh"],
    ["ストニーブルック", "stony brook"],
    ["パフォス", "paphos"],
    ["ベルファスト", "belfast"],
    ["タンジェ", "tangier"],
    /* インドネシアのバリの島とイタリアのバーリは、日本語では「バリ」と書く人が多いため
     * 同じ見出しから両方に展開する（画面には `Bali, インドネシア` / `Bari, イタリア` のように
     * 国が出るので、当たった行で区別できる）。 */
    ["バリ", "bali"],
    ["ヴァレッタ", "valletta"],
    ["サンマロ", "saint-malo"],
    ["サン・マロ", "saint-malo"],
    ["ソチ", "sochi"],
    ["プロビデンス", "providence"],
    ["プサン", "busan"],
    ["ブサン", "busan"],
    ["クレタ", "crete"],
    ["クレタ島", "crete"],
    ["アイントホーフェン", "eindhoven"],
    ["パドヴァ", "padua"],
    ["シェムリアップ", "siem reap"],
    ["カルガリー", "calgary"],
    ["リマッサル", "limassol"],
    ["トリノ", "turin"],
    ["チューリッヒ", "zurich"],
    ["シンガポール", "singapore"],
    ["エドモントン", "edmonton"],
    ["ドレスデン", "dresden"],
    ["ストックホルム", "stockholm"],
    ["アナハイム", "anaheim"],
    ["ハンティントンビーチ", "huntington beach"],
    ["ニューヨーク", "new york"],
    ["ボストン", "boston"],
    ["バンコク", "bangkok"],
    ["ミュンヘン", "munich"],
    ["ブレーメン", "bremen"],
    ["ハノーファー", "hannover"],
    ["オースティン", "austin"],
    ["ラスベガス", "las vegas"],
    ["アトランタ", "atlanta"],
    ["モンテレー", "monterey"],
    ["ワシントン", "washington"],
    ["ダラス", "dallas"],
    ["ベルリン", "berlin"],
    ["イスタンブール", "istanbul"],
    ["リヨン", "lyon"],
    ["ボルドー", "bordeaux"],
    ["ナント", "nantes"],
    ["オーフス", "aarhus"],
    ["ブダペスト", "budapest"],
    ["ブルッヘ", "bruges"],
    ["トロンヘイム", "trondheim"],
    ["ルーヴェン", "leuven"],
    ["マーストリヒト", "maastricht"],
    ["ユトレヒト", "utrecht"],
    ["サウサンプトン", "southampton"],
    ["ミネアポリス", "minneapolis"],
    ["マイアミ", "miami"],
    ["レイキャビク", "reykjavik"],
    ["ボルダー", "boulder"],
    ["ローリー", "raleigh"],
    ["ベルビュー", "bellevue"],
    ["ニューデリー", "new delhi"],
    ["ラバト", "rabat"],
    ["フロリアノポリス", "florianopolis"],
    /* 開催市の日本語の言い方（2026-09-23 実測で、打ち方が通じず 0 件になっていたもの）。
     * 表は開催地の公式表記を変えないので、日本語で打った人に届くのは検索語側だけ。
     * 置くのは**収録カタログにその都市が現れるとき**に限る（死んだ寄せを作らない）。
     * 表記が迷う語（`アンタルヤ`・`シャニア`）は置いていない。`ワシントン` は上に既に
     * あり（特別区にも州にも当たることをてびきに書いてある）、ここでの再掲はしない。 */
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
    /* 日本開催の行は、開催地のローマ字をそのまま打つ人が少ない（国内なので漢字で打つ）。
     * 収録の日本開催の行を洗い出したところ、`Aizuwakamatsu` の 2 行だけがどの日本語の
     * 言い方でも届かなかった（2026-09-23 実測）。`Miyakojima`（FC の回）は上に
     * `宮古島` で既に寄せてあり、公式の表記（fc25.ifca.ai の "Miyakojima, Japan"）と
     * 揃っている。`宮島`（広島の厳島）は当たる行が無いので置いていない。 */
    ["会津若松", "aizuwakamatsu"],
    ["会津", "aizuwakamatsu"],
    /* 会場名で行を書いている回（表に `Hitotsubashi Hall, 東京, 日本` と出る）。
     * 都市名（`東京`）でも届くが、会場で覚える人がいる。 */
    ["一橋講堂", "hitotsubashi hall"],
    ["日本科学未来館", "miraikan"],
    ["未来館", "miraikan"],
    // 国名の翻訳から守って公式表記のまま置いた州（`PLACE_NAME_SHIELDS_JA`）。
    ["ニューメキシコ", "new mexico"],
  ];

  /* 主題のことばも、日本語で打った人に届くようにする。分野ラベル（`セキュリティ` など）は
   * 画面に出るが、会議名そのものに主題が英文字で書かれている行が多い
   * （`Applied Cryptography and Network Security`）。`暗号` と打つ人にその行を渡すには、
   * 会議名に現れる英文字を同じ検索語の組に入れるしかない（開催地と同じ方針。表示は変えない）。
   * 収録カタログの会議名に現れる語だけに限る（実測で下表の語が 4〜258 行に現れる。現れない
   * `自動運転` `省電力` `仮想化` などは置いていない）。
   * `視覚`→vision は語境界の照合（下の `foldedLetterAtWordBoundary`）を導入するまで
   * 置けなかった（`division` `supervision` に当たり、実測で 258 行に誤爆していた。
   * 語境界で照らすようにして 248 行になり、当たり例はすべて computer vision 系だった）。
   * **新しい行を増やさない条目は置かない**（実測で追加 0 件だった `機械学習`→machine learning、
   * `データベース`→database は、分野ラベルや主題の日本語名が既に同じ行を拾えていた）。
   * `シンガポール`→singapore も同様（開催地の表記が既に日本語化されていた）。 */
  const TOPIC_QUERY_ALIASES_JA: string[][] = [
    ["暗号", "crypto"],
    ["暗号理論", "crypto"],
    /* 長い表記も同じ行に連れていく（第 322 回 – 2026-08-09 生成の実ビルドの品書 872 行で、
     * 短いほうだけ置いて長い表記が 0 行になっていた。追加で増える行を実測した物だけを置く:
     * `量子コンピュータ` `量子コンピューター` `量子コンピューティング` `量子計算` → 6 行、
     * `暗号論` → 31 行、`情報理論` → 1 行 → 第 324 回に続いた）。
     * 寄せる日本語は英語側の範囲と同等の物だけ – `自動運転`→`autonomous`（自律システムまで含む）
     * `記憶装置`→`storage` `性能評価`→`performance` は日本語のほうが狭いので置かない
     * （`自動運転` は `自律` を置く既存の検査と同じ判断）。
     * 逆に `機械翻訳` `数値計算` `半導体` `仮想化` は英語側も 0 行なので置かない（実測）。 */
    ["暗号論", "crypto"],
    ["量子コンピュータ", "quantum"],
    ["量子コンピューター", "quantum"],
    ["量子コンピューティング", "quantum"],
    ["量子計算", "quantum"],
    ["情報理論", "information theory"],
    /* 同じ表の続き（第 324 回 – 2026-08-09 生成の実ビルドの品書 872 行・収録 3,250 行で測った）。
     * いずれも日本語の語を行に書いた物は 0 行で、英語の表記の行だけが増えていた:
     * `エージェント` → 14 行（収録 34 行）、`アクセラレータ` `アクセラレーター` → 3 行（4 行）、
     * `ワイヤレス` → 7 行（23 行）、`知識表現` → 2 行（19 行）、
     * `クラウドコンピューティング` → 25 行（`クラウド` 打ちは分類語で 259 行）。
     * 落とした候補: `侵入検知`→`intrusion detection` は**寄せでは 0 行**だった – 英語の照合は語を
     * 分けて当てる（`intrusion` と `detection` を別々に含む行が 1 行）ので、かたまりの寄せは
     * 行を増やさない（`データセンター` と同じ – 第 322 回）。`プロセッサ` `拡散モデル` `拡張現実`
     * `デジタルツイン` `ベイズ` `ファジング` `耐タンパ` `時系列` `連合学習` `説明可能` は英語側も 0 行。*/
    ["エージェント", "agent"],
    ["アクセラレータ", "accelerator"],
    ["アクセラレーター", "accelerator"],
    ["ワイヤレス", "wireless"],
    ["知識表現", "knowledge representation"],
    /* `クラウドコンピューティング` は `cloud` に寄せる（25 行）。`クラウド` と打つと収録の分類語
     * （日本語で書かれている）に当たって 259 行になるので、長い表記のほうが少ない行になる –
     * 寄せの先を `くらうど`（件数欄に当たった語として載る形）にすれば 259 行に揃うが、件数欄は
     * 「英語で書かれた会議名（… など）も探しています」と言う文なので、日本語の語を載せられない
     * （実測で確かめた）。長い表記は 25 行に置くのが今の正。 */
    ["クラウドコンピューティング", "cloud"],
    /* `データセンター`→`data center` `ファイルシステム`→`file system` は置いていない –
     * 寄せは語のかたまりのまま照らすので、収録の書き方に連続した形が無く**追加 0 行**だった
     * （`data` と `center` を別々に含む行は在るが、それはこの語を打った人の探している行では
     * ない – 実測）。 */
    ["深層学習", "deep learning"],
    ["ディープラーニング", "deep learning"],
    ["画像", "image"],
    ["視覚", "vision"],
    ["音声", "speech"],
    ["無線", "wireless"],
    ["信号", "signal"],
    ["通信", "communication"],
    ["人間", "human"],
    ["ロボット", "robot"],
    ["ロボティクス", "robot"],
    ["センサー", "sensor"],
    ["統計", "statistics"],
    ["量子", "quantum"],
    ["ブロックチェーン", "blockchain"],
    ["信頼性", "reliability"],
    ["シミュレーション", "simulation"],
    ["最適化", "optimization"],
    ["検証", "verification"],
    ["教育", "education"],
    ["分散", "distributed"],
    ["分散処理", "distributed"],
    ["並列", "parallel"],
    ["並列処理", "parallel"],
    ["高性能計算", "high performance"],
    ["組み込み", "embedded"],
    ["組込み", "embedded"],
    ["形式手法", "formal method"],
    ["宇宙", "space"],
    /* 口の利かれる分野の語で、収録側の表記が英文字のものを足す（2026-09-23 実測:
     * 以下の日本語はいずれも 0 件で、同じ意味の英文字表記は数件〜数十件当たった。
     * 「収録に無い」と「打ち方が通じない」を区別できないと、そこで検索をやめる）。
     * 追加の基準は既存と同じく**収録カタログに英文字側が現れること**（死んだ寄せを
     * 作らない。`テスト`・`対話`・`モデリング` は当たり方が広すぎるので割愛した）。 */
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
    /* `侵入検知` の寄せ先は語を分けた（第 324 回の実測で直した）。旧来は `intrusion detection`
     * だったが、寄せは語のかたまりのまま照らすので**画面に出る品書 872 行では追加 0 行**だった
     * （`intrusion` と `detection` を別々に含む行が 1 行在るだけ）。`intrusion` に替えると
     * 語を分けた `intrusion` を**足して**品書 0 → 1 行・収録 5 → 15 行にした（当たりは同じ 1 行 – 収録は "Intrusion Detection …" と書く）。かたまりと短い語を**並べて置くことはできない** – 同じ寄せ先に二つ並べると短いほうが落ちて
     * かたまりだけが残った（実測: 品書 0 行のまま）。なので 1 語に替えた（留めていた検査も一緒に直す）。*/
    ["侵入検知", "intrusion"],
    ["モバイル", "mobile"],
    ["ユーザインタフェース", "user interface"],
    ["ユーザインターフェース", "user interface"],
    ["ゲーム", "game"],
    ["エッジコンピューティング", "edge computing"],
    ["仮想現実", "virtual reality"],
    ["拡張現実", "augmented reality"],
    ["計算機アーキテクチャ", "computer architecture"],
    ["データ分析", "data analytics"],
    ["パターン認識", "pattern recognition"],
    /* 同じ調べものを続けて足した群（2026-09-23 実測: 日本語は 0 件も、英文字表記は
     * 1〜183 行当たっていた）。`自動運転` は入れていない（収録の英文字は `autonomous` で、
     * 自律システムまで入る。日本語の `自律` のほうを置いた）。 */
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
    // `画像認識` は入れていない（英文字側が `image recognition` の語順で収録に現れない。
    // 当たった 3 行は `graphics, patterns and images` + 別箇所の `recognition` で、
    // 別表記として置く語ではない）。`画像`・`パターン認識`・`コンピュータビジョン` で引ける。
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

  /* 開催地の**地域まとめ**で引けるようにする。画面の開催地は公式表記（`Seattle, USA`）を
   * 基本にしつつ、末尾の国名だけは日本語へ寄せて表示する（`placeJa`）。収録カタログの
   * 開催地に実際に現れる国名だけを上げている（2026-09-23 に末尾国名を数えて作成:
   * `USA` 611 行 / 画面 175 行、`Italy` 120/14、`Greece` 60/33 など）。
   * 展開は一方向だけ（`ヨーロッパ` → 国名）。逆をやると `イタリア` と打った人の結果が
   * 欧州全体に広がって精密さを失う。
   * 境界の判断は明記しておく:
   *  - `アジア` に日本は入れない。日本人の利用で「アジア」に国内研究会が混ざると誤解になる。
   *    国内を見たいときは `国内` か `日本` で引く。
   *  - `トルコ` は `中東` だけに入れる（地理的には欧州でもあるが、二重に主張しない）。
   *  - キプロスは EU 運用に合わせて `ヨーロッパ` に置く。
   *  - アルメニアは欧州・中東のどちらにも入れない（収録 3 行で、境界を断定しない）。
   *  - `北米` はアメリカ・カナダ（メキシコは `中南米`）。
   *  - `アメリカ` には州表記の行も入れる。開催地に国名を書かず州だけ書く上流が多い
   *    （`San Diego, CA` / `Colorado` など。実測で `CA` だけ 26 行）。 */
  const EUROPE_JA =
    "イタリア,ドイツ,スペイン,フランス,イギリス,オーストリア,デンマーク,オランダ,ポルトガル,ギリシャ,アイルランド,ベルギー,スウェーデン,キプロス,フィンランド,スイス,チェコ,ハンガリー,ポーランド,リトアニア,ノルウェー,クロアチア,ルクセンブルク,アイスランド,ルーマニア,スロベニア,エストニア,ブルガリア,ロシア";
  const ASIA_JA =
    "中国,韓国,シンガポール,インド,ベトナム,台湾,マレーシア,タイ,インドネシア,カンボジア,香港";
  const US_STATES_JA =
    "カリフォルニア州,コロラド州,ハワイ州,ペンシルベニア州,ルイジアナ州,テネシー州,インディアナ州,オレゴン州";
  const US_JA = `アメリカ,${US_STATES_JA}`;
  /* メキシコは北米の国として「北米」側の membership にも入れる（3 分けた北米の慣行）。
   * メキシコだけを引く人は「メキシコ」と打つので、地域で引いたときに黙って落ちるほうが
   * 困る（2026-09-23 実測: メキシコ開催 29 行が「北米」で出ていなかった）。行には
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
  /* 「海外」は**地域まとめの国をすべて足した物**（第 335 回）。国を並べ直さない – 地域を
   * 増やした日に海外も同じように増えるようにするため。収録の実測（2026-09-29・
   * 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
   * `海外` `国外` `海外の会議` `海外開催` `海外学会` はいずれも **0 行** /
   * 地域まとめ（アジア・欧州・北米・中南米・アフリカ・オセアニア・中東）の和集合 639 行 /
   * `国内` 38 行。どちらの語も持たない行が 179 行有るので、**海外は開けた語で語る**
   * （下の海外案内に書く – 開催地が空欄の行と、国名が略された行は出ない）。 */
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
    /* 「中近東」で打つ人が居る（実測: `中東` 5 行 / `中近東` **0 行**）。近東まで含む読み方も
     * あるが、此の表が持つ国名の集まりは中東と同じ物を使う – 件数欄が『中近東』という打ち方
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
  ];
  /* 海外の見出し（下の案内文を立てる語）。*/
  const OVERSEAS_HEADS_JA = ["海外", "国外", "海外開催"];
  /* 海外は収録の開催地の国名から導くので、国名が書かれていない行に届かない。黙って
   * 639 行を出すより、届かない範囲を書いたほうがまし（第 335 回 – 実測でどちらの語も
   * 持たない行が 179 行あり、その例は `Lodz, PO` のように国名を 2 文字に略した表記）。*/
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
   * 置くものがあるので、その前後を見込みでかぶせる（外れた年の行はhay に和暦語を
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

  /* 0 件の案内が「語「〜」は収録データにありません」と言う形は、URL を貼った人には当たり方が
   * 違う（打ったのは語ではなく公式ページのアドレスで、収録の範囲の話になる – 第 154 回）。
   * 判定だけを外に出す（照合側は `queryTokenGroups` の中で同じ式を通る）。 */
  function looksLikeUrlQuery(query: unknown): boolean {
    return urlLikeQueryTerms(query) !== null;
  }

  /* 分野チップに並ぶ語（`システム（Systems, Architecture and Storage）`）は、画面から
   * コピーして貼られる語なので、**括弧の中身を別語として扱わない**。括弧は並べ語なので
   * 素通りさせると `システム` `systems` `architecture` `and` `storage` の AND に割れて
   * どこにも届かない（2026-08-09 生成ビルドで実測: `システム（…）` は 0 件、
   * `人工知能（…）` は 309 行中 55 件、`高性能計算（…）` は 102 行中 13 件）。
   * 索引側に英表記を載せる手もあるが、それは別の語の精度を壊す – `プライバシー` が
   * `セキュリティ（Security and Privacy）` に当たって 16 件 → 78 件に膨らんだ
   * （第 219 回で実測。てびきに書いた実測値を検査する検査が検出した）。 */
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

  /* 英語の正式名称（長い分野名）で打つ人を、和名で打った人と同じ語の組に載せる（第 316 回）。
   * 検索語は語に割って AND を取るため、分野の正式名称をそのまま打つとその語の並びを行う
   * 行にしか当たらない（2026-09-25 実測・2026-08-09 生成の実ビルドの品書 872 行 –
   * `情報セキュリティ` 152 行 / "information security" **13** 行、`人工知能` 314 /
   * "artificial intelligence" **61**、`データベース` 118 / "database systems" **2**、
   * `計算理論` 44 / "theoretical computer science" **3**、`音声認識` 3 / "speech recognition"
   * **0**）。分野のチップは `高性能計算（High Performance Computing）` のように英表記を
   * 括弧で併記するので、画面から貼った人は救われている（上の `CATEGORY_CHIP_TAIL`）。
   * 和名で検索した場合の展開をそのまま使わせるため、語に割る前に和名へ寄せる。
   * 寄せ先は 正本 の `QUERY_SYNONYMS_JA` と分野名その物で、新しい寄せ語彙は足さない。 */
  /* 打たれた検索語に英語の正式名称が有るか見て、和名へ寄せる。実際に寄めた物だけを
   * `寄せた` に返す – 打ってもいない語の綴りを語の組に載せると、分野名その物を打った人の
   * 当たりまで変わる（実測 – 常時載せにすると分野の絞り込みと件数欄の検査 16 本が
   * 画面の実測値と合わなくなった – 第 316 回）。
   * 表・綴りの形・判定を 1 本の関数の中に置く – 検査ハーネスは関数を 1 本ずつ抽出して
   * 画面の代码を組み立てるので、モジュール定数を参照すると `not defined` になる
   * （第 257 回と同じ穴）。 */
  function collapseFieldPhraseEnglish(query: unknown): {
    query: unknown;
    /* 寄せ先の和名と、其の語の組に載せるべき英語の綴り */
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
    /* 和名だけに寄せると、英語の綴りを行に持つ行が打ち直し前より減る（実測 – 品書 872 行で
     * 8 行: "artificial intelligence" を打つ人が AI4S 2026 に会えなくなる – 和名経由の寄せは
     * 原文の語を直接寄せ先にすべき、という第 313 回の教訓と同じ）。語と語の間はスペース・
     * ハイフン・無しで書かれ、末尾の語は単数で書かれることもある（実測 – NOSSDAV は
     * "operating system support" と単数で書く）ので、其の形を載せる。 */
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

  function queryTokenGroups(query: unknown, nowMs?: number): string[][] {
    if (typeof query === "string" && CATEGORY_CHIP_HEADS_JA.length) {
      query = query.replace(CATEGORY_CHIP_TAIL, "$1");
    }
    query = collapseRelativeDayPhrase(query);
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
    /* **言い換えの寄せ先では地域まとめの見出しでも hop を進める**（第 250 回）。
     * `国内開催` を `国内` に寄せたときは行の表記にそのまま届くが、`米国開催` を `米国` に
     * 寄せた場合は `米国` 自体が地域まとめの見出しで、行は州などの英文字表記を持つ
     * （`米国` は 787 行に当たるが、行のなかに「米国」の表記は 1 度も無い）。ここで止めて
     * いると、言い換えた語が 0 行のままで「探しています」と噓を言う案内になる
     * （第 249 回に実測して載せなかった語）。地域まとめの見出しを止めていた理由
     * （ continent → 地方 → 都道府県 の連鎖で組が膨らむ）は、**打ち込まれた語**が
     * 見出しのときだけ当てはまるので、その場合は今までどおり止める。 */
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
     * （2026-09-25 実測 – 品書 872 行で 8 行）。載せるのは実際に寄せた語だけ –
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
      const parts = token.split("/");
      return parts.length >= 2 && parts.every((part) => /^[0-9]{1,4}$/.test(part));
    };
    /* 時刻の語も割らない。`23:59` をコロンで割ると `59` が立った語になり、その語を
     * 含む行が 1 件も無いので全体が 0 件になる（2026-08-09 生成ビルドで実測:
     * 一覧の 863 行中 679 行が締切欄か公式表記欄に時刻を出している – 21 種・最多は
     * `20:59` の 508 行 – のに、その語はぜんぶ 0 件だった）。全角コロンも受ける。 */
    const timeLike = (token: string): boolean => /^\d{1,2}[:：]\d{2}$/.test(token);
    /* 日付・時刻帯に続く括弧書きの曜日は**離さない**。締切欄は `2026-08-22 03:00 JST(土)`、
     * 日付しか確認できていない行は `2026-09-30(水)`、会期欄は `2026-12-03(木) 〜 2026-12-04(金)`
     * と書く（一覧・CSV は同じ式）。括弧で割ると `木` のような1文字の語が立った組になり、組は
     * AND なので、**セルをコピーして貼ると 559 行（会期欄を持つ 677 行）が 0 件**だった
     * （2026-08-09 生成ビルドで実測）。かといって会期欄の曜日を素の語として hay に入れると
     * `金` ひとつで 131 件 → 数百件に膨れる。そこで**画面に並ぶ形そのもの**を 1 まとめの語として
     * 扱い、表示側もその形を入れる（下の `eventDaySearchWords` と `deadlineCellSearchWords`）。
     * 全角括弧は正規化で半角になる。末尾の `)` は `queryTokens` が落とす（`2026-12-03(木` に
     * なる）ので閉じ括弧は無くても受ける – 落ちた形は hay 側の `2026-12-03(木)` に部分一致で
     * 届く。ここまで直しても `金` のような**1文字だけの曜日**を単独で打つと、表示している
     * 行が締切欄ぶん 131 件 → 締切欄+会期欄ぶん 398 件に増える（`月` `日` は月日の漢字その物で
     * 既に 863 件＝全件）。2文字以上の `金曜` `金曜日` は変わりに変わらない（131 件のまま –
     * 会期欄の語は `2027-04-09(金)` なので `金曜` を含まない）。1文字の曜日はそれ自体が
     * 曖昧な語なので、受け入れる。 */
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
      if (!JOIN_WORDS.test(token) || dateLike(token) || timeLike(token)) {
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
    mergeSeasonTokens(queryTokens(query)).forEach((raw) => {
      middleParts(raw).forEach((part) => {
        if (!hasWordChar(part)) return;
        /* 相対月の語はここで暦月に解決する（第 251 回）。`expandRelativeMonths` は空白で
         * 区切られた語しか見ておらず、助詞で割られた `来月の締切` の `来月` がそのまま
         * 残って 0 行になっていた（実測: `来月` 343 行 / `来月の締切` 0 行）。
         * 年の語・週の語・日の語がここで解決されているのと同じ場所にする。 */
        const monthTerm = relativeMonthTerm(part, now);
        if (monthTerm) {
          units.push({ token: monthTerm, whole: [] });
          return;
        }
        /* 季節の語もここで暦月語に展開する（第 254 回）。1 まとめの語（`秋`）と違い、
         * 助詞で割られた `秋の会議` は下の組み替えに届かないので、ここで扱う。
         * 展開した月は 1 つの OR グループにまとめる – `units` の要素同士は AND なので、
         * 月ごとに分ける「9 月と 10 月と 11 月」の要求になってしまう。 */
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
        /* 月の語と旬を**離して**打った形（`来月 下旬` `8月 上旬`）も 1 group にまとめる
         * （第 332 回）。単位が割れたままだと「来月の行 AND 今月の下旬の日」になり、
         * どちらも当たらない 0 行になった。 */
        const 繋いだ語 = `${unit.token}${next ? next.token : ""}`;
        mergedUnits.push({ token: 繋いだ語, whole: monthPartTermsJa(繋いだ語, now) || [] });
        i += 1;
      } else if (pressedWeekdayJa(`${unit.token}${next ? next.token : ""}`, now) !== null) {
        /* 週と曜日を**離して**打った形（`今週 水曜` `来週の木曜`）も 1 group にまとめる
         * （第 329 回）。単位が割れたままだと「今週の行 AND 水曜の語」になり、締切日が
         * 別の日の行が混ざった（実測で `今週の水曜` 1 行と `2026年8月5日` 3 行は別の行）。 */
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
      const token = unit.token;
      let group = [token];
      /* `12月` と打つと `2026年12月` の行が出てほしい。ところが素の `1月` は `11月` に、
       * `1日` は `11日`・`21日`・`31日` に文字列として含まれる。照合は部分一致なので、
       * **12月で絞り込んだのに11月の締切が混ざっていた**（2026-09-23 実測: 「1月」の
       * 当たり 892 件のうち 526 件が 1 月と無関係、「2月」も 394 件、「1日」は 287 件）。
       * 先頭に空白を付けた形で照合する手は、`searchNormalize` が語を trim するため
       * 素の語に戻って効かなかった（実測で無変化）。なので **hay に出る和暦付きの形に
       * 展開する**（hay の月語は `2026年12月 12月`、日語は `2026年8月10日 8月10日`）。
       * `2026年1月` のように打たれたときは展開しない（隣接の月を含まない語なので）。 */
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
      /* 英字の**複数形**は、単数形の組に載せる（第 314 回）。語頭一致の規則は「打たれた語が
       * 原文の語の左端に並ぶ」ときだけ通すので、語尾に `s` を足した瞬間に外れる – 収録に
       * 5 回以上出る複数形の語 45 語のうち 24 語が、単数形で当たる行の一部を取りこぼしていた
       * （2026-09-25 実測・収録 872 行: `abstracts` 5 行 / `abstract` 146 行、
       * `deadlines` 0 行 / `deadline` 231 行、`papers` 25 行 / `paper` 510 行、
       * 収録に稀な語では `databases` 0 行 / `database` 13 行）。
       * 照合の側ではなく、語の組を作ところで寄せる – 単数形が**別の語への寄せ語彙を
       * 持つ**場合があるため（`communication` は「通信」の寄せ語 – 照合側で畳むと
       * `communications` は其の道に載れず、15 行が取りこぼされたままだった – 実測）。
       * 単数形の組その物を使うので、展開語（地域まとめ・漢字表記など）も同じ組に乗る。 */
      /* ハイフンで繋いだ語は、スペースで繋いだ形でも引く（第 317 回）。CFP を写す語と
       * URL のスラッグは `paper-submission` `international-conference` のように語をハイフンで
       * 繋ぐので、其の形で打つ人は其の並びを行うに書く行にしか当たらなかった
       * （2026-09-25 実測 – 品書に頻出の 171 並びのうち 166 並びで件数が違い、減った行の延べ
       * 5,007 行。収録 3,250 行では 400 並び中 393 並び・延べ 24,758 行 –
       * `paper-submission` 0 行 / `paper submission` 1,768 行、`international-conference` 3 行 /
       * 341 行、`CCF-B` 0 行 / `CCF B` 264 行）。語に割った形を OR で足すだけなので、
       * 今当たっている行は残る。 */
      /*英文字を含む語だけ – 数字とハイフンの語（`2026-12-25` `2026-13`）は其の場で
       * 暦日・暦月として扱われており、語に割った形を足すと数字の羅列として他に当たる
       * （実測 – `2026-13` に `2026 13` が載ると、ありえない数字の日付扱いを見る検査が落ちた –
       * 第 317 回）。 */
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
      /* 「9月以降」「9月から11月」も暦月語のグループへ展開する（第 252 回）。
       * 展開できたときは元の語を組に残さない – 表にその語が無いので、残しても
       * 当たり方を狭めるだけになる。 */
      const monthRange = monthRangeTermsJa(token, now);
      if (monthRange.length) group = monthRange.slice();
      /* 「秋」「春」などの季節の語も同じ暦月語のグループへ展開する（第 254 回）。 */
      const season = seasonTermsJa(token, now);
      if (season.length) group = season.slice();
      /* 「今月末」「年内」のような月のまとまりの語も同じ暦月語の組へ展開する（第 327 回）。
       * 展開できたときは元の語を組に残さない – 組の中は OR なので残しても当たり方は
       * 変わらない（実測で差分 0 を確かめた – 第 327 回の改ざんで発覚）が、表に無い語が
       * 混ざった組になるだけで、0 件のときの案内が打った語を読む余地を無くす。
       * `monthRange`・`season` と同じ書き方に揃える。 */
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
  /* 表の全行にあてはまる語（`WHOLE_TABLE_QUERY_JA`）は、他の語があるときのぞく
   * （第 245 回）。`セキュリティの会議` は 0 行だった – `会議` を要求するからで、
   * 表は会议その物を並べた物なので要求しても 1 行も減らない（実測: `会議` 0 行、
   * `セキュリティ` 152 行）。その語だけを打った人は 0 行のままなので、注記で理由を言う。 */
  function withoutWholeTableGroups(groups: string[][]): string[][] {
    if (groups.length < 2) return groups;
    const whole = WHOLE_TABLE_QUERY_JA.map((word) => kanaFold(word));
    const kept = groups.filter(
      (group) => !group.every((term) => whole.indexOf(kanaFold(term)) >= 0),
    );
    return kept.length ? kept : groups;
  }

  /* 検索語から述語（語の組）を作る。`searchMatcher` と、同じ表に複数の語を掛ける
   * 数え上げ（`shorterHitWordsJa`）で**同じ述語の作り方を共有する**（第 257 回 –
   * 述語の組み立てを 2 か所に持つと必ず片方が古くなる）。 */
  function searchGroups(query: unknown, nowMs?: number): string[][] {
    return withoutWholeTableGroups(queryTokenGroups(query, nowMs)).map((group) =>
      group.map((term) => kanaFold(term)),
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

  /* 英字を部分一致で開けると、語の途中に当たって誤爆する。実測（2026-09-23）:
   *   - `N` は 3234 行中 3,219 行、`sc` は 342 行（"science" の一部まで拾った）。
   *   - `usa` は `evomusart`・`usage` に当たり、`america` は `latin american` に当たった。
   *     `米国` でパナマとドイツの会議が 4 件出る誤りになった（SPEC §7）。
   * 表に出している語（`CCF B` の `B`、略称 `SC` など）は引けるようにしたいので、
   * 一致そのものはやめず、**英数字に挟まれた位置の一致は使わない**ことにする。
   * ただし語頭の一致まで捨てると `crypto` が `cryptography` に当たらなくなるので、
   * 要求する境界は語の性質で分ける:
   *   - 英字 1〜2 文字: 前後 both（従来どおり）。
   *   - 開催地として置く語（国名・都市名・地域まとめの構成員）: 前後 both。
   *     略称（`usa`）や語の一部（`usage`, `american`）を同じ場所と見なさないため。
   *   - それ以外の英字語: 左端だけ（`robot` → `robots`、`crypto` → `cryptography` は残す）。
   * 正規表現を作らずに走査する（語の分解は 1 描画 1 回で、行ごとに作るものではない）。 */
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

  /* 英字語を**複数形で打つ人**は、単数形で当たる行の多くに会えない（2026-09-25 実測・
   * 収録 872 行）。語頭一致の規則は「打たれた語が原文の語の左端に並ぶ」ときだけ通すので、
   * 語尾に `s` を足した瞬間に外れる – 収録に 5 回以上出る複数形の語 45 語のうち 24 語が
   * 単数形より少ない行にしか当たらなかった（`abstracts` 5 行 / `abstract` 146 行、
   * `architectures` 8 行 / `architecture` 16 行）。収録に稀な語では 0 行になった
   * （`databases` 0 行 / `database` 13 行、`computer networks` 0 行）。
   * 外れたときだけ、単数形と見なせる形も照らす。照合は英字語と同じ語頭一致に置く
   * （`mode` が `model` に当たる既存の緩さはそのまま – 打たれた語が短くなるだけなので
   * 新種の通り道は増えない）。語尾が `ss` `us` `is` の語（`business` `campus` `analysis`）は
   * 単数形その物なので触らない。語ごとの結果を覚えておかない – 照合 1 回あたりの仕事は
   * 短い語の正規表現 1 本で足り、覚えた方が速くなるほど重複しない（`tests/bench_recommender.test.ts`
   * が速さを検査している – 実測で変らない範囲）。 */
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
  function matchFoldedGroups(target: string, groups: string[][]): boolean {
    for (let i = 0; i < groups.length; i++) {
      let hit = false;
      for (let k = 0; k < groups[i].length; k++) {
        const term = groups[i][k];
        if (isShortLatinTerm(term)) {
          if (foldedLetterAtWordBoundary(target, term)) {
            hit = true;
            break;
          }
          continue;
        }
        if (LATIN_TERM_TOKEN.test(term)) {
          // 開催地の語は語全体、その他の英字語は語頭が英数字でつながっていない位置だけ。
          // ただし末尾が数字の語は右も閉じる（上の `termEndsInDigit`）。
          if (
            foldedLetterAtWordBoundary(
              target,
              term,
              // 開催地の語と末尾が数字の語は右端も閉じる。
              !placeLatinTerms()[term] && !termEndsInDigit(term),
            )
          ) {
            hit = true;
            break;
          }
          continue;
        }
        if (target.indexOf(term) >= 0) {
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
    // 間違った土地をprinted に載せるほうが悪い。
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
    "semantic_status lexical-only":
      "この推薦データでは意味検索を使えません（言葉の一致だけで探します）",
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

  /* 「未確認」と「AoE」の意味を一文で書く（SPEC §7・第 275 回）。画面のてびき、印刷の
   * 但し書き（`printLegendJa`）、`upcoming.html` の列の意味が同じ文を使う – 手コピーすると
   * 3 か所でズレる。とくに「未確認」は、 kamiyobi が裏取りできていないだけなのに
   * 「収録元が無いと決めたのだ」と誤読されやすい（2026-08-09 生成ビルドの実測:
   * `upcoming.html` 1,127 行のうち開催地が「未確認」182 行、日付に「（時刻未確認）」を持つ行
   * 180 行あったのに、そのページには「推定」の説明しか無く、意味が確定できなかった）。 */
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
      /* 等級の呼び方は「ランク」「評価」で止まらない。等級を並べて呼ぶ日本語として
       * `A 類` `B 類` が一般的（2026-08-09 生成ビルドで実測・第 235 回:
       * `Aランク` 286 件 / `A評価` 286 件なのに `A類` は **0 件**、`B類` `C類` `A*類` も
       * 0 件）。表の等級その物は変えず、この行が持つ等級の語として足す。 */
      parts.push(`${grade.toLowerCase()}類`);
      hasGrade = true;
    });
    /* 等級を持つ行に限って、単独の「ランク」「評価」も通す。半角スペースを挟んで
     * `A* ランク` と打つ人（`ランク A*` の語順Reverse）が、同じ行に出会えるようにするため。
     * 評価の無い行まで広げると、「ランク」で全件が返って語の意味が薄くなる。 */
    if (hasGrade) parts.push("ランク", "評価", "類");
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

  /* チェックボックスの語「国内研究会」も検索の語として引けるようにする。行の名前には
   * 「研究会」としか書かれず、「国内」はタグ側の情報なので複合語では当たらない
   * （2026-09-23 実測: `国内研究会` は 0 件なのに、チェックボックスでは同じ行が出る）。
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
          /* 会議名は**画面と同じ式**（年を添えた `titleWithYearJa`）でも hay に入れる。
           * 素の `conf.title` だけだと、年を後付けした行の画面に出る名前が引けない
           * （2026-08-09 生成ビルドで実測: 一覧に出る会議名 429 種のうち 26 種 – 影響 35 行 –
           * が `ACISP 2027` の形そのままで 0 件。`ACISP` は 1 件引ける。これらの回は
           * 会期が未定なので hay に 2027 が無く、画面に並ぶ語が索引に無い語だった）。
           * 年は回ごとなので editions のループ内で組む（第 205 回で CSV をこの式に寄せた
           * のと同じ正本を使う）。 */
          titleWithYearJa(conf.title || conf.key || "", ed.year),
          conf.full_name,
          conf.key,
          ed.place,
          ed.date_text,
          linkSearchTerms(ed.link),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        const catHay = `${laterEditionSearchWords(conf, String(ed.event_start || ""))} ${categorySearchTerms(conf.categories, confTags)} ${placeJa(ed.place)} ${placePrefectureJa(ed.place)} ${participationSearchTerms(ed.place)} ${domesticFacetSearchTerms(confTags, conf.title)}`;
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
          /* 差し替え前の締切（行の詳細に並ぶ語）も引けるようにする（第 224 回）。日付だけ
           * 入れる – 会期のときと同じで、場所の名前と違い日付の語は他の欄の精度を落とさない。 */
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
              `${baseHay} ${dl.label || ""} ${dl.kind || ""} ${kindLabelJa(dl.kind)} ${statusBadgeWords(ed, dl).join(" ")} ${roundSearchTerms(dl.round).join(" ")} ${unconfirmedHayJa({ kind: dl.kind || "", ed, rankPairs })} ${rankSearchTerms(rankPairs)} ${catHay} ${tagSearchTerms(confTags)} ${monthTermsJa(dateOnly ? dl.local_date : t)} ${dayTermsJa(dateOnly ? dl.local_date : t)} ${monthTermsJa(ed.event_start)} ${monthTermsJa(ed.event_end)} ${weekdaySearchTerms(
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
      const baseHay = [conf.title, conf.full_name, conf.key, NOT_APPLICABLE_LABEL_JA]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const cats = conf.categories || [];
      out.push({
        conf: conf,
        ed: { place: "", date_text: "" },
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
   * 会期だけが決まっていて締切が未定の回を一覧にする。締切一覧の表は締切行でできており、
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
      const baseHay = [conf.title, conf.full_name, conf.key]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      (conf.editions || []).forEach((ed) => {
        if ((ed.deadlines || []).length) return;
        const start = String(ed.event_start || "");
        const end = String(ed.event_end || start);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return;
        out.push({
          key: String(conf.key || ""),
          name: String(conf.title || conf.key || ""),
          link: String((ed as { link?: string }).link || (conf as { link?: string }).link || ""),
          place: String(ed.place || ""),
          eventStart: start,
          eventEnd: end,
          cats: conf.categories || [],
          tags: confTags,
          hay: searchNormalize(
            /* 会期だけの行も、公式ページの URL で引けるようにする（上の締切行と同じ理由）。 */
            `${baseHay} ${ed.place || ""} ${ed.date_text || ""} ${linkSearchTerms(ed.link)} ` +
              `${categorySearchTerms(conf.categories, confTags)} ${tagSearchTerms(confTags)} ` +
              `${placeJa(ed.place)} ${placePrefectureJa(ed.place)} ` +
              `${monthTermsJa(start)} ${monthTermsJa(end)} ${weekdaySearchTerms(start)}`,
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
   * 画面の語をこの文件が持っているのと同じ置き方）。区切りは UI 側が足す。 */
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
      venue_kind: ["paper", "journal"].includes(entry.row.kind) ? 1 : 0,
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
      const semantic =
        semanticScores && Number.isFinite(semanticScores[key]) ? semanticScores[key] : 0;
      return {
        key,
        row,
        match,
        lexicalScore,
        semantic,
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
      });
      entries.forEach((entry) => {
        const fused = activeWeight
          ? Math.round(Math.min(100, (fieldRrf[entry.key] * 100 * (k + 1)) / activeWeight))
          : 0;
        entry.lexicalScore = Math.min(
          100,
          Math.max(fused, entry.match.venueHit ? entry.match.venueScore : 0) +
            (entry.boosted ? 10 : 0),
        );
      });
    }
    const lexical = entries
      .slice()
      .sort(
        (a, b) =>
          (opts.fieldedLexical ? fieldRrf[b.key] - fieldRrf[a.key] : 0) ||
          b.lexicalScore - a.lexicalScore ||
          a.key.localeCompare(b.key),
      );
    const categoryRank = (entry: RecommendationEntry) => {
      const rank = opts.venueCats?.findIndex((category) => entry.row.cats.includes(category)) ?? -1;
      return rank < 0 ? Number.MAX_SAFE_INTEGER : rank;
    };
    const semantic = entries
      .filter((entry) => entry.semantic > 0)
      .sort(
        (a, b) =>
          b.semantic - a.semantic ||
          categoryRank(a) - categoryRank(b) ||
          b.lexicalScore - a.lexicalScore ||
          a.key.localeCompare(b.key),
      );
    const lexicalRanks: Record<string, number> = {};
    const semanticRanks: Record<string, number> = {};
    lexical
      .filter((entry) => entry.lexicalScore > 0)
      .slice(0, topN)
      .forEach((entry, index) => {
        lexicalRanks[entry.key] = index + 1;
      });
    semantic.slice(0, topN).forEach((entry, index) => {
      semanticRanks[entry.key] = index + 1;
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
        // Fielded lexical retrieval benefits from a lexical tie-breaker after
        // the expanded venue profiles; keep the legacy symmetric blend for
        // the unfielded path used by the synthetic compatibility benchmark.
        const lexicalRrfWeight = opts.fieldedLexical ? 1.6 : 1;
        const semanticRrfWeight = opts.fieldedLexical ? 0.4 : 1;
        const rrf =
          (lexicalRank ? lexicalRrfWeight / (k + lexicalRank) : 0) +
          (semanticRank ? semanticRrfWeight / (k + semanticRank) : 0);
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
        const rawA = a.fit.baseScore * (1 - blend) + a.fit.probability * 100 * blend;
        const rawB = b.fit.baseScore * (1 - blend) + b.fit.probability * 100 * blend;
        return rawB - rawA || b.fit.score - a.fit.score || a.venueKey.localeCompare(b.venueKey);
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
  function semanticScore(
    confKey: string,
    queryVec: Vector,
    emb: VectorMap,
    paperVecs?: PaperVectorMap | null,
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
    return Math.round(Math.max(0, (c - 0.2) / 0.8) * 100); // 0.2 以下は 0、1.0 で 100
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
    const normalize = (value: unknown) =>
      String(value)
        .toLowerCase()
        .replace(/[\u2010-\u2015\u2212-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const text = normalize(hay);
    const needle = normalize(signal);
    if (!text || !needle) return false;
    if (/[\u3000-\u9fff]/.test(needle)) return text.indexOf(needle) !== -1;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(text);
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

  /* 日本語キーワード → 英語の展開（語彙スコア用）。
   * 多言語モデルは日本語論文を埋め込めるが、語彙スコア（会議名の英単語との一致）は
   * 日本語テキストには全く効かない。そこで日本語の分野語を英語に展開してから
   * 分野シグナル・会議名・タグの一致判定に使う（例: 「低遅延」→ latency real-time）。
   * ブラウザの表示テキストや埋め込み入力は変更しない（語彙一致の内部処理のみ）。
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

  /* 日本語テキストに含まれる分野語を英語に展開する（無ければ ""）。 */
  function expandJp(text: unknown): string {
    if (!expandEnabled) return "";
    const t = String(text || "").toLowerCase();
    let out = "";
    Object.keys(JP_EN).forEach((jp) => {
      if (t.indexOf(jp.toLowerCase()) !== -1) out += ` ${JP_EN[jp]}`;
    });
    return out.trim();
  }

  /* 論文テキスト（全行連結）を埋め込み用の単一クエリ文にする。
   * 先頭行は「自分の投稿予定論文」とみなし強調する（参考論文のノイズに埋没させない）。
   * 短い入力（タイトル+キーワード）は従来の全体2回反復を維持しつつ、
   * 長いアブストラクト（512トークン超）時はタイトル・キーワードを優先強調し
   * 全体を約1800文字（~350トークン）以内に収めてモデル側の切り捨て・前方偏重を防ぐ。
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
    if (joined.length <= 1800) {
      const primary = p0Full;
      return (primary ? `${primary} ` : "") + joined;
    }
    const emphasis = p0TitleKw || p0Full.slice(0, 240);
    const budgetRemaining = Math.max(0, 1800 - (emphasis ? emphasis.length + 1 : 0));
    let truncatedJoined = joined.slice(0, budgetRemaining).trim();
    const lastSpace = truncatedJoined.lastIndexOf(" ");
    if (lastSpace > budgetRemaining * 0.8) {
      truncatedJoined = truncatedJoined.slice(0, lastSpace).trim();
    }
    return (emphasis ? `${emphasis} ` : "") + truncatedJoined;
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
    candidateRows: candidateRows,
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
    deadlineShiftsOf: deadlineShiftsOf,
    deadlineShiftLineJa: deadlineShiftLineJa,
    deadlineShiftSearchWords: deadlineShiftSearchWords,
    weekdaySearchTerms: weekdaySearchTerms,
    queryTermCounts: queryTermCounts,
    shorterHitWordsJa: shorterHitWordsJa,
    extendedLabelJa: () => EXTENDED_LABEL_JA,
    placeJa: placeJa,
    weekdayJaFromDate: weekdayJaFromDate,
    eventCellJa: eventCellJa,
    titleWithYearJa: titleWithYearJa,
    deadlinesToCsv: deadlinesToCsv,
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
    /* 検査用の窓（第 264 回）: 「同じ行を二度畳まない」を壁時計ではなく**働き方**で検めるため、
       畳む関数そのものを渡す。速さを時間で測る検査は、同じ機械の並列実行で平気で落ちる
       （第 258 回の検査が第 263 回の連続実行で落ちた – 実発生）。憶えた量は検査側の `Map` を
       差し込んで数えるので、憶える仕組みを外してからでも落ちる。 */
    kanaFoldMemo: (): typeof kanaFold => kanaFold,
    tagLabelJa: tagLabelJa,
    topicTagsJa: topicTagsJa,
    tagSearchTerms: tagSearchTerms,
    scheduleOnlyEditions: scheduleOnlyEditions,
    kindLabelJa: kindLabelJa,
    kindLabelTable: () => ({ ...KIND_LABEL_JA }),
    kindDateFieldJa: kindDateFieldJa,
    verificationStatusLabelTable: () => ({ ...VERIFICATION_STATUS_LABELS_JA }),
    verificationStatusLabelJa: verificationStatusLabelJa,
    roundSearchTerms: roundSearchTerms,
    categorySearchTerms: categorySearchTerms,
    pastRepresentatives: pastRepresentatives,
    pickRepresentative: pickRepresentative,
    comparePapers: comparePapers,
    safeExternalUrl: safeExternalUrl,
    matchVenueTag: matchVenueTag,
    blendVectors: blendVectors,
    cosine: cosine,
    embeddingSetCompatible: embeddingSetCompatible,
    embeddingProbeMatches: embeddingProbeMatches,
    semanticScore: semanticScore,
    blendScore: blendScore,
    vocabWeight: vocabWeight,
    contentWordCount: contentWordCount,
    englishRatio: englishRatio,
    setNameIdf: setNameIdf,
    setPaperVecs: setPaperVecs,
    buildNameIdf: buildNameIdf,
    setSigWeights: setSigWeights,
    GENERIC_PAPER_WORDS: GENERIC_PAPER_WORDS,
    hasJapanese: hasJapanese,
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
