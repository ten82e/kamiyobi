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
    // 締切種別も言い方が分かれる。学会側は「抄録」「要旨」と書くことが多いが、
    // 表は「概要締切」を出す（実測: `抄録` 0 件 / `概要` 660 件）。
    // 「アブストラクト」単体では当たるが、選択肢に出る語との複合で打つ人が多い
    // （`アブストラクト締切` は 2026-09-23 実測で 0 件、`概要締切` は 660 件）。
    ["アブストラクト締切", "種別「概要締切」", ["概要締切", "abstract"]],
    // ほかのサイトや昔の表記で「随時受付」と書くところがある。表の語は `常時受付`
    // （種別ラベル・CSV・並び順・てびきですべて同じ語を使っているので、そこへ寄せる）。
    ["随時受付", "種別「常時受付」", ["常時受付", "journal"]],
    // 等級の列を見出しの語で打つ人。画面は評価の無い行に「評価なし」と出すのに、列の見出しは
    // 「ランク」なので、その語で打つと 0 件に当たっていた（2026-08-09 生成ビルドで実測:
    // `ランクなし` 0 件 / 画面の語 `評価なし` 144 件）。
    ["ランクなし", "画面の語「評価なし」", ["評価なし"]],
    // 「論文募集」は上流（Call for Papers）の言い方。表は種別を「論文締切」と出すので、
    // その語へ寄せる（2026-08-09 生成ビルドで実測: `論文募集` 0 件 / `論文締切` 454 件）。
    // 原文の "paper" には寄せない – 採否通知などのラベルにも出る語で、寄せる先として
    // 誤っている（実測: "paper" を入れた形で出た行に種別「採否通知」が混ざった）。
    ["論文募集", "種別「論文締切」", ["論文締切"]],
    ["抄録締切", "種別「概要締切」", ["概要締切", "abstract"]],
    ["要旨締切", "種別「概要締切」", ["概要締切", "abstract"]],
    ["抄録", "種別「概要締切」", ["概要締切", "abstract"]],
    ["要旨", "種別「概要締切」", ["概要締切", "abstract"]],
    ["アブストラクト", "種別「概要締切」", ["概要締切", "abstract"]],
    ["全文締切", "種別「論文締切」", ["論文締切", "paper"]],
    ["全文", "種別「論文締切」", ["論文締切", "paper"]],
    ["フルペーパー", "種別「論文締切」", ["論文締切", "paper"]],
    ["本論文", "種別「論文締切」", ["論文締切", "paper"]],
  ];

  /* 検索語が、表に出さない締切種別の表示語に当たるかを聞く（0 件の案内が使う）。
   * 「採否通知」は てびき と件数欄に語が出るのに、表は投稿締切だけを出すため検索すると
   * 0 件になる。収録が無いのだと誤解させないため、区別できる案内を出せるようにする。
   * 当たった種別名を返す（案内側で実名を書くため、真偽値だけでは使えない）。 */
  /* 部分一致では捕まえられない言い方（ラベルと語が噛み合わないものだけ足す）。 */
  const HIDDEN_KIND_ALIASES_JA: Record<string, string[]> = {
    採否通知: ["合否", "結果通知", "採択通知"],
    カメラレディ締切: ["最終稿", "最終原稿", "camera ready", "camera-ready"],
    反論期間開始: ["リバットル", "rebuttal"],
    反論期間終了: ["リバットル", "rebuttal"],
    査読結果公開: ["ピアレビュー結果"],
  };

  function queryHiddenKindMatches(query: unknown, hiddenKindLabels: readonly string[]): string[] {
    const tokens = queryTokens(query);
    if (!tokens.length) return [];
    const out: string[] = [];
    hiddenKindLabels.forEach((label) => {
      if (!label) return;
      const words = [label].concat(HIDDEN_KIND_ALIASES_JA[label] || []);
      const hit = tokens.some((token) =>
        words.some((word) => word.indexOf(token) >= 0 || token.indexOf(word) >= 0),
      );
      if (hit && out.indexOf(label) < 0) out.push(label);
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
    const UPSTREAM_TEXT_QUERY_SYNONYMS_JA: Array<[string, string, string[]]> = [
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
      ["特別セッション", "原文の special session という語", ["special session"]],
      ["学生セッション", "原文の student という語", ["student"]],
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

  function querySynonymNotes(query: unknown): string[] {
    const map = querySynonymMap();
    const notes: string[] = [];
    /* 第 194 回に、画面が等級を呼ぶ語（列の見出し・選択欄の「ランク」、てびきと件数欄の「評価」）を
     * 検索語に入れた。ただしこの語だけは等級を絞らない（2026-08-09 生成のビルドで実測: `ランク`
     * だけで 839 / 863 行、`評価` だけで 475 / 863 行）。絞れたと読み違えないよう、等級の語が
     * 混ざっていないときだけ、そのことを書く。 */
    /* 照合には小文字化した形を使い、人に見せる例は画面と同じ大文字のままする
     * （`rankGradeOrderJa()` の並びは画面の選択欄と同じなので、例もそこから取る）。 */
    const labelWords = ["ランク", "評価"];
    const gradeWordsShown = rankGradeOrderJa().map((grade) => String(grade));
    const gradeWords = gradeWordsShown.map((grade) => grade.toLowerCase());
    const queryForms = queryTokens(query).map((token) => kanaFold(String(token)));
    queryTokens(query).forEach((token) => {
      const hit = map[kanaFold(token)];
      if (hit) {
        const note = `「${token}」は${hit[0]}で探しています`;
        if (notes.indexOf(note) < 0) notes.push(note);
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
        // この語にさらに付ける説明はない。
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
        /^[a-c]\*?(ランク|評価)$/.test(form) ||
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
    queryTokens(query).forEach((token) => {
      const dayOffset = RELATIVE_DAY_OFFSETS_JA[token];
      if (dayOffset !== undefined) {
        const ymd = offsetCalendarDay(nowMs, dayOffset);
        const iso = `${ymd[0]}-${String(ymd[1]).padStart(2, "0")}-${String(ymd[2]).padStart(2, "0")}`;
        const day = weekdayJaFromDate(iso);
        notes.push(`${token} = ${ymd[0]}年${ymd[1]}月${ymd[2]}日${day ? `(${day})` : ""}`);
        return;
      }
      const yearOffset = RELATIVE_YEAR_OFFSETS_JA[token];
      if (yearOffset !== undefined) {
        const base = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3_600_000);
        notes.push(`${token} = ${base.getUTCFullYear() + yearOffset}年の締切（1〜12 か月）`);
        return;
      }
      const week = weekDayTermsJa(token, nowMs);
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

  function categoryLabelJa(key: unknown): string {
    const k = typeof key === "string" ? key : "";
    return CATEGORY_LABELS_JA[k] || k;
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
  function roundSearchTerms(round: unknown): string[] {
    const n = Number(round);
    if (!Number.isInteger(n) || n < 1) return [];
    return [`第${n}ラウンド`, `第 ${n} ラウンド`, `r${n}`];
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
    return /extend/i.test(label) || label.indexOf("延長") >= 0;
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

  /* 締切欄・公式表記欄に並ぶ時刻の語（`20:59`・`23:59`）を hay に入れる。実測:
   * 2026-08-09 生成ビルドでは 863 行中 679 行がどちらかの欄に時刻を出している
   * （21 種・最多は `20:59` の 508 行）のに、その語を打つとぜんぶ 0 件だった。
   * 語は**画面と同じ列を組み立てる関数から取る**（書き写すと表示とズレる）。
   * AoE 宣言の行は公式表記欄に AoE の時刻も出る（同じ行に二つの時刻が並ぶ）ので、
   * それも入れる。日付しか確認できていない行は時刻を出さないので語を入れない。 */
  function timeSearchWords(dl: unknown, t: number, dateOnly: boolean): string {
    if (dateOnly || !Number.isFinite(t)) return "";
    const texts = [csvJstInstant(t)];
    if (officialZone(dl) === "AoE") texts.push(fmtAoEText(t));
    const words: string[] = [];
    texts.forEach((text) => {
      text.split(" ").forEach((part) => {
        if (/^\d{1,2}:\d{2}$/.test(part) && words.indexOf(part) < 0) words.push(part);
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
    return queryTokenGroups(query, nowMs).map((group) => {
      const alts = (group || []).length ? group : [""];
      const matchers = alts.map((alt) => searchMatcher(alt, nowMs));
      let count = 0;
      for (let i = 0; i < list.length; i++) {
        for (let j = 0; j < matchers.length; j++) {
          if (matchers[j](list[i])) {
            count += 1;
            break;
          }
        }
      }
      return { term: String(alts[0] || ""), count: count };
    });
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

  function searchNormalize(value: unknown): string {
    const raw = typeof value === "string" ? value : value == null ? "" : String(value);
    let folded = typeof raw.normalize === "function" ? raw.normalize("NFKC") : raw;
    if (typeof folded.normalize === "function") {
      folded = folded.replace(LATIN_DIACRITIC_CHARS, (ch) =>
        ch.normalize("NFD").replace(COMBINING_MARKS, ""),
      );
    }
    folded = folded.replace(DIACRITIC_FOLD_CHARS, (ch) => DIACRITIC_FOLD_JA[ch] || ch);
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

  function queryTokens(query: unknown): string[] {
    const normalized = searchNormalize(query);
    if (!normalized) return [];
    const seen: string[] = [];
    normalized.split(" ").forEach((raw) => {
      const token = raw.replace(QUERY_EDGE_PUNCTUATION, "");
      if (token && seen.indexOf(token) < 0) seen.push(token);
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

  function kanaFold(value: unknown): string {
    let text = searchNormalize(value);
    if (!text) return "";
    text = text.replace(/[\u30a1-\u30fa]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 96));
    text = text.replace(/[ー\u309b\u309c]/g, "");
    text = text.replace(/[ぁぃぅぇぉヵヶっゃゅょゎ]/g, (ch) => SMALL_KANA_JA[ch] || ch);
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
  };

  /** 相対月の語を `YYYY年M月` へ置き換えた検索語を返す（該当がなければ元の検索語のまま）。 */
  function expandRelativeMonths(query: unknown, nowMs: number): string {
    const normalized = searchNormalize(query);
    if (!normalized) return normalized;
    let changed = false;
    const tokens = normalized.split(" ").map((token) => {
      const offset = RELATIVE_MONTH_OFFSETS_JA[token];
      if (offset === undefined) return token;
      const base = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3_600_000);
      // 月の加算は日付を足さず月だけで行う（1/31 に 1 ヶ月足すと 3/3 になるため）。
      const shifted = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offset, 1));
      changed = true;
      return `${shifted.getUTCFullYear()}年${shifted.getUTCMonth() + 1}月`;
    });
    return changed ? tokens.join(" ") : normalized;
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
    来年: 1,
    らいねん: 1,
    再来年: 2,
    さらいねん: 2,
    去年: -1,
    きょねん: -1,
    せんねん: -1,
    一昨年: -2,
    いとおととし: -2,
  };

  /** 年の語に対して、その年の 1〜12 か月語（年付き）を返す。基準は JST の暦年。 */
  function yearMonthTermsJa(token: string, nowMs: number): string[] {
    const offset = RELATIVE_YEAR_OFFSETS_JA[token];
    if (offset === undefined) return [];
    const base = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 9 * 3_600_000);
    const year = base.getUTCFullYear() + offset;
    const out: string[] = [];
    for (let month = 1; month <= 12; month += 1) out.push(`${year}年${month}月`);
    return out;
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

  /** 相対日・相対日の語を、暦日の候補グループへ展開する（OR の組）。 */
  function relativeDayGroups(token: string, nowMs: number): string[] | null {
    const dayOffset = RELATIVE_DAY_OFFSETS_JA[token];
    if (dayOffset !== undefined) {
      const ymd = offsetCalendarDay(nowMs, dayOffset);
      return [token, `${ymd[0]}年${ymd[1]}月${ymd[2]}日`, `${ymd[1]}月${ymd[2]}日`];
    }
    const week = weekDayTermsJa(token, nowMs);
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
    ["英国", "uk"],
    ["英国", "england"],
    ["豪州", "australia"],
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
    ["侵入検知", "intrusion detection"],
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
    ["中東", "ちゅうとう", "イスラエル,アラブ首長国連邦,トルコ"],
    ["アフリカ", "アフリカ".toLowerCase(), "モロッコ,南アフリカ,ルワンダ,ガーナ,ナイジェリア"],
    ["オセアニア", "おせあにあ", OCEANIA_JA],
    ["アメリカ", "アメリカ".toLowerCase(), US_JA],
    // 「米国」と打った人にも州表記の行を同じにして出す（実測で `米国` だけ 135 行少なかった）。
    ["米国", "べいこく", US_JA],
    // 欧米は「欧州＋北米」と読む（豪州は入れない。日本語でのふつうの使い方に合わせる）。
    ["欧米", "おうべい", `${NORTH_AMERICA_JA},${EUROPE_JA}`],
  ];

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

  function queryTokenGroups(query: unknown, nowMs?: number): string[][] {
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
    Object.keys(byReading).forEach((key) => {
      byReading[key].forEach((member) => {
        if (groupHeadings[member]) return;
        const more = byReading[member];
        if (!more) return;
        more.forEach((extra) => {
          if (byReading[key].indexOf(extra) < 0) byReading[key].push(extra);
        });
      });
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
    const LEADING_PUNCT = /^[（）()［］[\]【】〈〉《》「」『』！？!?。．.,:：;；〜~"'“”‘’`]+/u;

    function trimEdgePunct(value: string): string {
      let out = value.trim();
      while (LEADING_PUNCT.test(out)) out = out.replace(LEADING_PUNCT, "");
      while (EDGE_PUNCT.test(out)) out = out.replace(EDGE_PUNCT, "");
      return out;
    }

    const middleParts = (token: string): string[] => {
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
    queryTokens(query).forEach((raw) => {
      middleParts(raw).forEach((part) => {
        if (!hasWordChar(part)) return;
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

      /* 時刻の語は零詰めた形に寄せる。画面に出る 21 種はすべて `08:59` の形所以外に
       * 無いので（2026-08-09 生成ビルドで実測）、打った側を画面の形に直す。元の形も
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
  function searchMatcher(query: unknown, nowMs?: number): (hay: unknown) => boolean {
    const groups = queryTokenGroups(query, nowMs).map((group) =>
      group.map((term) => kanaFold(term)),
    );
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
    const shielded: string[] = [];
    PLACE_NAME_SHIELDS_JA.forEach((name) => {
      out = out.replace(new RegExp(`(?<![A-Za-z0-9-])${name}(?![A-Za-z0-9-])`, "gi"), (matched) => {
        shielded.push(matched);
        return ` ${shielded.length - 1} `;
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
      out = out.split(` ${i} `).join(matched);
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
      hasGrade = true;
    });
    /* 等級を持つ行に限って、単独の「ランク」「評価」も通す。半角スペースを挟んで
     * `A* ランク` と打つ人（`ランク A*` の語順Reverse）が、同じ行に出会えるようにするため。
     * 評価の無い行まで広げると、「ランク」で全件が返って語の意味が薄くなる。 */
    if (hasGrade) parts.push("ランク", "評価");
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
          conf.full_name,
          conf.key,
          ed.place,
          ed.date_text,
          linkSearchTerms(ed.link),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        const catHay = `${categorySearchTerms(conf.categories, confTags)} ${placeJa(ed.place)} ${placePrefectureJa(ed.place)} ${participationSearchTerms(ed.place)} ${domesticFacetSearchTerms(confTags, conf.title)}`;
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
          const timeWords = timeSearchWords(dl, t, dateOnly);
          const officialWords = officialDateSearchWords(dl, t, dateOnly);
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
              )} ${zoneSearchWords(dl, dateOnly)} ${timeWords} ${officialWords} ${eventDaySearchWords(
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
    officialZone: officialZone,
    isExtendedDeadline: isExtendedDeadline,
    weekdaySearchTerms: weekdaySearchTerms,
    queryTermCounts: queryTermCounts,
    extendedLabelJa: () => EXTENDED_LABEL_JA,
    placeJa: placeJa,
    weekdayJaFromDate: weekdayJaFromDate,
    eventCellJa: eventCellJa,
    titleWithYearJa: titleWithYearJa,
    deadlinesToCsv: deadlinesToCsv,
    searchNormalize: searchNormalize,
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
    kanaFold: kanaFold,
    queryTokenGroups: queryTokenGroups,
    queryTokens: queryTokens,
    hayMatches: hayMatches,
    searchMatcher: searchMatcher,
    tagLabelJa: tagLabelJa,
    topicTagsJa: topicTagsJa,
    tagSearchTerms: tagSearchTerms,
    scheduleOnlyEditions: scheduleOnlyEditions,
    kindLabelJa: kindLabelJa,
    kindLabelTable: () => ({ ...KIND_LABEL_JA }),
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
