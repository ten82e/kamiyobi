import { loadPublishedRecommendation } from "./publish.js";
import { type RecommendationAxes, recommendationAxes } from "./recommendation-core.js";
import Recommender from "./recommender.js";

type CandidateRow = ReturnType<typeof Recommender.candidateRows>[number];
type PaperRecord = ReturnType<typeof Recommender.parsePaperLines>[number];
type RecommendationResult = ReturnType<typeof Recommender.venueRecommendations>[number];
type ScoreBreakdown = ReturnType<typeof Recommender.breakdown>;
type ConferenceRecord = CandidateRow["conf"] & {
  link?: string;
  editions?: EditionRecord[];
  dblp?: string | null;
  sources?: string[];
  recommendation_axes?: RecommendationAxes;
};
type EditionRecord = CandidateRow["ed"] & {
  link?: string;
  event_start?: string | null;
  event_end?: string | null;
  event_date_precision?: string;
};
type DeadlineRecord = CandidateRow["dl"] & {
  verification?: {
    official_url?: string;
    source_class?: string;
    source_name?: string;
    selector_or_field?: string;
    status?: string;
    last_attempt_at?: string | null;
    last_verified_at?: string | null;
    next_check_at?: string;
  };
  source_name?: string;
  evidence?: Array<Record<string, unknown>>;
};
type AppRow = Omit<CandidateRow, "conf" | "ed" | "dl"> & {
  conf: ConferenceRecord;
  ed: EditionRecord;
  dl: DeadlineRecord;
  _boosted?: boolean;
  _match?: RecommendationResult["match"];
  _vocabScore?: number;
  _fitLabel?: string;
  _lexicalRank?: number | null;
  _semanticRank?: number | null;
  _semScore?: number;
  _availability?: RecommendationResult["availability"];
  /** 「過去の締切も表示」のとき、過ぎた行を後ろの塊に寄せるための目印（0: これから / 1: 過ぎた）。 */
  _pastBlock?: number;
};

interface DrawerRow {
  conf: {
    key?: string;
    title?: string;
    full_name?: string;
    link?: string;
    tags?: string[];
  };
  ed: {
    year?: number;
    link?: string;
    place?: string;
    date_text?: string;
    event_start?: string | null;
  };
  kind: string;
  dateOnly?: boolean;
  localDate?: string;
  // 表と同じ情報をドロワーでも出すため、この 2 つは無くさない（無い呼び出し側も許す）。
  cats?: string[];
  rankPairs?: string[];
  t: number;
  tLast: number;
  dl?: DeadlineRecord;
}

interface SourceRecord {
  name: string;
  repo?: string;
  license?: string;
  url?: string;
}

interface Catalog {
  generated_at?: string;
  sources: SourceRecord[];
  categories: Record<string, string>;
  conferences: ConferenceRecord[];
  history_ref?: string;
  reranker?: Record<string, unknown>;
}

type UiMode = "deadlines" | "recommend";
interface UiState {
  mode: UiMode;
  q: string;
  cats: string[];
  kind: string;
  rank: string;
  win: string;
  est: boolean;
  domestic: boolean;
  /** 会場表記にオンライン参加の記述がある行だけを出す（対面の判定はしない）。 */
  online: boolean;
  past: boolean;
}

type LoadStatus = "idle" | "loading" | "ready" | "error";
type SemanticStatus = LoadStatus;
type Vector = number[];
type VectorMap = Record<string, Vector>;

interface EmbeddingModelMeta {
  model: string;
  revision: string;
  dim: number;
  probe: { text: string; vector: Vector };
}

interface EmbeddingSet {
  model: string;
  dim: number;
  embeddings: VectorMap;
}

interface EmbeddingBundle extends EmbeddingSet {
  manifest: {
    schema: number;
    profile_hash: string;
    keys: string[];
    models: Record<string, EmbeddingModelMeta>;
  };
  multi?: EmbeddingSet;
  paperVecs?: Record<string, Vector[]>;
}

interface SemanticOutput {
  data: Iterable<number> | ArrayLike<number>;
}

type SemanticModel = (
  text: string,
  options: { pooling: "mean"; normalize: true },
) => Promise<SemanticOutput>;

interface TransformersModule {
  pipeline(
    task: "feature-extraction",
    model: string,
    options: { revision: string },
  ): Promise<SemanticModel>;
}

interface PdfReadResult {
  pages: PdfTextItem[][];
  metadata: { info?: Record<string, unknown> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOptionalString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || record[key] === null || typeof record[key] === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const TRUST_LEVELS = new Set([
  "official",
  "publisher",
  "curated-manual",
  "aggregator",
  "assumption",
  "unverified",
]);

function isRecommendationAxes(value: unknown): value is RecommendationAxes {
  if (!isRecord(value) || !isRecord(value.research_fit) || !isRecord(value.venue_maturity)) {
    return false;
  }
  const maturity = value.venue_maturity;
  const maturityEvidence = maturity.evidence;
  const trust = value.deadline_trust;
  if (!isRecord(maturityEvidence) || !isRecord(trust)) return false;
  return (
    ["established", "emerging", "new", "unverified"].includes(String(maturity.status)) &&
    ["profiled", "unprofiled"].includes(String(maturity.profile_status)) &&
    typeof maturityEvidence.yearsObserved === "number" &&
    typeof maturityEvidence.dblpIndexed === "boolean" &&
    typeof maturityEvidence.publisherVerified === "boolean" &&
    typeof maturityEvidence.ranked === "boolean" &&
    typeof maturityEvidence.profileCoverage === "number" &&
    ["date", "time", "timezone", "kind"].every((field) => TRUST_LEVELS.has(String(trust[field]))) &&
    ["fresh", "cache-fallback", "snapshot-fallback"].includes(String(trust.sourceFreshness)) &&
    typeof trust.conflicts === "number"
  );
}

function isDeadlineRecord(value: unknown): value is DeadlineRecord {
  if (!isRecord(value)) return false;
  return (
    hasOptionalString(value, "kind") &&
    hasOptionalString(value, "label") &&
    hasOptionalString(value, "comment") &&
    hasOptionalString(value, "precision") &&
    hasOptionalString(value, "local_date") &&
    hasOptionalString(value, "earliest_utc") &&
    hasOptionalString(value, "latest_utc") &&
    hasOptionalString(value, "utc") &&
    (value.round === undefined || typeof value.round === "number")
  );
}

function isEditionRecord(value: unknown): value is EditionRecord {
  if (!isRecord(value)) return false;
  return (
    (value.year === undefined || typeof value.year === "number") &&
    hasOptionalString(value, "place") &&
    hasOptionalString(value, "date_text") &&
    hasOptionalString(value, "link") &&
    hasOptionalString(value, "event_start") &&
    hasOptionalString(value, "event_end") &&
    (value.estimated === undefined || typeof value.estimated === "boolean") &&
    (value.deadlines === undefined ||
      (Array.isArray(value.deadlines) && value.deadlines.every(isDeadlineRecord)))
  );
}

function isConferenceRecord(value: unknown): value is ConferenceRecord {
  if (!isRecord(value) || typeof value.key !== "string") return false;
  const rankValid =
    value.rank === undefined ||
    (isRecord(value.rank) && Object.values(value.rank).every((item) => typeof item === "string"));
  return (
    hasOptionalString(value, "title") &&
    hasOptionalString(value, "full_name") &&
    hasOptionalString(value, "link") &&
    (value.categories === undefined || isStringArray(value.categories)) &&
    (value.tags === undefined || isStringArray(value.tags)) &&
    (value.papers === undefined || isStringArray(value.papers)) &&
    rankValid &&
    (value.editions === undefined ||
      (Array.isArray(value.editions) && value.editions.every(isEditionRecord)))
  );
}

function sourceRecord(value: unknown): SourceRecord | null {
  if (!isRecord(value) || typeof value.name !== "string") return null;
  return {
    name: value.name,
    repo: typeof value.repo === "string" ? value.repo : undefined,
    license: typeof value.license === "string" ? value.license : undefined,
    url: typeof value.url === "string" ? value.url : undefined,
  };
}

function catalogFrom(value: unknown): Catalog | null {
  if (!isRecord(value) || !Array.isArray(value.conferences)) return null;
  const conferences = value.conferences.filter(isConferenceRecord);
  if (conferences.length !== value.conferences.length) return null;
  const categories: Record<string, string> = {};
  if (isRecord(value.categories)) {
    for (const [key, label] of Object.entries(value.categories)) {
      if (typeof label === "string") categories[key] = label;
    }
  }
  return {
    generated_at: typeof value.generated_at === "string" ? value.generated_at : undefined,
    sources: Array.isArray(value.sources)
      ? value.sources.map(sourceRecord).filter((source): source is SourceRecord => source !== null)
      : [],
    categories,
    conferences,
    history_ref: typeof value.history_ref === "string" ? value.history_ref : undefined,
    reranker: isRecord(value.reranker) ? value.reranker : undefined,
  };
}

function isDrawerRow(value: unknown): value is DrawerRow {
  return (
    isRecord(value) &&
    isRecord(value.conf) &&
    isRecord(value.ed) &&
    typeof value.kind === "string" &&
    typeof value.t === "number" &&
    typeof value.tLast === "number"
  );
}

function vector(value: unknown): Vector | null {
  return Array.isArray(value) && value.every((item) => typeof item === "number") ? value : null;
}

function vectorMap(value: unknown): VectorMap | null {
  if (!isRecord(value)) return null;
  const result: VectorMap = {};
  for (const [key, item] of Object.entries(value)) {
    const parsed = vector(item);
    if (!parsed) return null;
    result[key] = parsed;
  }
  return result;
}

function embeddingSet(value: unknown): EmbeddingSet | null {
  if (!isRecord(value)) return null;
  const embeddings = vectorMap(value.embeddings);
  const model = value.model;
  const dim = value.dim;
  if (
    !embeddings ||
    typeof model !== "string" ||
    typeof dim !== "number" ||
    !Number.isInteger(dim) ||
    dim <= 0
  )
    return null;
  return { model, dim, embeddings };
}

function embeddingModelMeta(value: unknown): EmbeddingModelMeta | null {
  if (!isRecord(value) || !isRecord(value.probe)) return null;
  const probeVector = vector(value.probe.vector);
  const model = value.model;
  const revision = value.revision;
  const dim = value.dim;
  const probeText = value.probe.text;
  if (
    typeof model !== "string" ||
    typeof revision !== "string" ||
    typeof dim !== "number" ||
    !Number.isInteger(dim) ||
    dim <= 0 ||
    typeof probeText !== "string" ||
    !probeVector
  ) {
    return null;
  }
  return {
    model,
    revision,
    dim,
    probe: { text: probeText, vector: probeVector },
  };
}

function embeddingBundle(value: unknown): EmbeddingBundle | null {
  if (!isRecord(value)) return null;
  const base = embeddingSet(value);
  const manifest = isRecord(value.manifest) ? value.manifest : null;
  const schema = manifest?.schema;
  const profileHash = manifest?.profile_hash;
  const keys = manifest?.keys;
  if (
    !base ||
    schema !== 1 ||
    typeof profileHash !== "string" ||
    !Array.isArray(keys) ||
    !keys.every((key): key is string => typeof key === "string") ||
    !isRecord(manifest?.models)
  ) {
    return null;
  }
  const models: Record<string, EmbeddingModelMeta> = {};
  for (const [language, item] of Object.entries(manifest.models)) {
    const model = embeddingModelMeta(item);
    if (!model) return null;
    models[language] = model;
  }
  const multiValue = value.multi;
  const multi = multiValue === undefined ? undefined : embeddingSet(multiValue);
  if (multiValue !== undefined && !multi) return null;
  const paperVecs: Record<string, Vector[]> = {};
  const rawPaperVecs = value.paperVecs;
  if (rawPaperVecs !== undefined) {
    if (!isRecord(rawPaperVecs)) return null;
    for (const [key, item] of Object.entries(rawPaperVecs)) {
      if (!Array.isArray(item)) return null;
      const vectors = item.map(vector);
      if (vectors.some((entry) => entry === null)) return null;
      paperVecs[key] = vectors.filter((entry): entry is Vector => entry !== null);
    }
  }
  return {
    ...base,
    manifest: {
      schema,
      profile_hash: profileHash,
      keys: [...keys],
      models,
    },
    multi: multi ?? undefined,
    paperVecs,
  };
}

function transformersModule(value: unknown): value is TransformersModule {
  return isRecord(value) && typeof value.pipeline === "function";
}

function semanticOutput(value: unknown): value is SemanticOutput {
  if (!isRecord(value)) return false;
  const data = value.data;
  return (
    Array.isArray(data) ||
    ArrayBuffer.isView(data) ||
    (isRecord(data) && typeof data.length === "number")
  );
}

(() => {
  /* ビルド時にデータが差し込まれる（SPEC §7）。無い状態で開いても例外にせず、
   * 空の一覧として出す – ただし「絞り込みで 0 件」と取り違えない案内を後段で出す
   * （`emptyDeadlineHint` の冒頭）。 */
  const DATA = catalogFrom(window.__KAMIYOBI_DATA__) ?? {
    generated_at: "",
    sources: [],
    categories: {},
    conferences: [],
  };

  const DAY = 86400000;
  const PAGE = 40;
  /* 推薦カードの初期表示件数。件数欄は候補の総数を出すので、ここで打ち切ったまま
   * 「さらに表示」を出さないと「200 件」と言いながら 5 件しか見えない画面になる
   * （変更前は 5 件 fixed で、残りの候補に到達する手段が無かった）。 */
  const RECOMMENDATION_PAGE = 20;
  let selectedIndex = -1;
  /* いま開いている行の詳細（ドロワー）の行。URL に載せる対象として持つ。
   * 「この画面を見る？」で送った人は、送った人が開いていた行の詳細も一緒に開いていて
   * ほしい（2026-09-23 実測: 絞り込みと並び順、てびきの開閉（第 140 回）は URL に残るが、
   * 行の詳細を開いた状態はどこにも残っておらず、送られた側は表の一覧だけを受け取った）。 */
  let drawerRow: AppRow | null = null;
  /* URL から受け取った行の鍵。起動時の描き込みが終わってから行を探す。 */
  let pendingDrawerKey = "";

  /* 共有用の行の鍵。同じ一覧の中でも区別が要る（同じ会議は概要締切と論文締切で別行に
   * なり、同じ種別でも第 1 ラウンドと第 2 ラウンドが並ぶ）ので、会議の鍵に年・種別・
   * 締切時刻を添える。値その物ではなく照合にだけ使う。 */
  function rowShareKeyJa(r: {
    conf?: { key?: string };
    ed?: { year?: unknown };
    kind?: string;
    t?: number;
  }): string {
    const key = String(r.conf?.key || "");
    const year = r.ed && r.ed.year !== undefined && r.ed.year !== null ? String(r.ed.year) : "";
    const kind = String(r.kind || "");
    const t = Number.isFinite(Number(r.t)) ? String(Math.trunc(Number(r.t))) : "";
    return `${key}|${year}|${kind}|${t}`;
  }
  /** ソートできる列の key。`th[data-sort]` と一致させる（ズレは検査で拾う）。 */
  /* 表の列数。行をまたぐ見出し（月見出し・過ぎた締切の見出し・行の詳細）はここを使う
   * （直書きを 3 箇所に分けると、列を増やした日に見出しの跨ぎが足りず右に列が余る –
   * 画面では「表示が欠けた」ように見え、支援技術では見出しが列に紐づかない –
   * `site/template.html` の見出しと検査で突き合わせる）。 */
  const TABLE_COLUMNS_JA = 7;

  const SORTABLE_KEYS = ["rem", "date", "event", "conf", "rank"];
  const DEFAULT_SORT_KEY = "rem";
  let sortKey = DEFAULT_SORT_KEY;
  let sortAsc = true;

  // 種別の日本語表記は recommender の正典と同じ表を使う（表示している語で検索できない、
  // という状態を作らないため）。
  const KIND_LABEL: Record<string, string> = Recommender.kindLabelTable();

  /* 種別セレクトの選択肢。`filter()` の `byKind` が通す種別と必ず揃える —
   * 選んでも 0 件になる選択肢を並べるのが最もまずい（選択肢が噺になる）。
   * 採否通知・カメラレディ・登録締切などはサイト表に出さない仕様で、
   * それらを追うのは `upcoming.md`（SPEC §4・§7）。 */
  const SELECTABLE_KINDS = ["abstract", "paper", "journal"];

  /* 収録元がその締切に付けた名前（`dl.label`）の出し方。既定画面 478 行はすべて原語の名称を
   * 持ち、無印で並べていた（2026-09-23 実測: いちばん多いのは「Submission deadline」の 129 行、
   * ほか「Paper submission」56 行、「Submission」34 行…。国内分は「発表申込締切」など日本語）。
   * 種別欄の本筋（概要締切・論文締切）と同じ列に、印の無い別の分類が並んで見えるため、
   * 「画面の種別とは別物で、収録元の呼び方その物」であることを語で書く。会期の項で既に
   * 使っている「原表記」の語をここでも使う。
   * 表のセルと行の詳細で同じ式を使う（式が二つあると、片方だけ直してズレる – 第 128 回）。 */
  function kindDetailJa(round: unknown, label: unknown): string {
    const parts: string[] = [];
    const r = Number(round);
    if (Number.isFinite(r) && r > 1) parts.push(`第 ${r} ラウンド`);
    const text = typeof label === "string" ? label.trim() : "";
    if (text) parts.push(`原表記: ${text}`);
    return parts.join(" / ");
  }

  /* 種別セレクトの既定（絞り込みなし）の書き方。0 件の案内もこの語を書く —
   * 案内が古いラベルを指すと、その語が画面に見つからない。 */
  const KIND_ALL_LABEL_JA = "投稿締切（概要・論文）";

  /* 件数の数え方。てびきは「全 3,235 件」と書いていたのに、画面は同じ数を「全 3235 件」と
   * 出していた（2026-09-23 実測: 既定画面は「478 件 / 全 3235 件」、0 件の案内は
   * 「過去の締切 2317 件」）。4 桁以上の数を素で出されると、一覧の件数と収録総数を
   * 見比べたときに桁の大きさが取り出しにくい。てびきの書き方に合わせて 3 桁ごとに区切る。
   * `toLocaleString` は環境の実装差に左右される（地域によって区切り文字が違う）ので、
   * 区切りは自分で書く。 */
  function countJa(n: number): string {
    const int = Math.trunc(Number(n) || 0);
    const digits = String(Math.abs(int)).replace(/\B(?=(\d{3})+$)/g, ",");
    return int < 0 ? `-${digits}` : digits;
  }

  /* ランク絞り込みの選択肢（data の grade と一致させる。SPEC §2: `N` はランク無し）。 */
  // 等級の順は recommender の正本から取る（並び順と同じ順序で選択肢を出す）。
  const RANK_GRADE_OPTIONS = Recommender.rankGradeOrderJa();
  const RANK_UNRATED_JA = Recommender.rankUnratedLabelJa();
  /* 「評価なし」の吹き出し。中身は画面の語だけで書く – 折り返し形式の指定（markdown の
   * バッククォート）は `title` で効かず「内部表記では `N`」のように記号がそのまま出ていた
   * （2026-09-23 実測）。同じく開発寄りの「内部表記」という語も画面のどこにも出てこない。
   * 利用者が知りたいのは「評価なし」と「未確認」の違いなので、その区別を書く
   * （てびきの「空欄の出し方」と同じ説明の向き）。 */
  const RANK_UNRATED_TITLE_JA =
    "この会議はその評価一覧に載っていますが、評価は付いていません。評価が付いていないことと、 kamiyobi が公式で裏を取れていないこと（「未確認」）は別に出しています。";
  const RANK_FILTER_NOTE_JA =
    "CCF・CORE・THCPL のいずれかの一覧で、その評価が付いている会議を出します。";

  /** URL やフォームから来た種別を選択可能なものにする。捨てた場合は理由を返す。 */
  function selectableKind(raw: string | null): { kind: string; notice: string } {
    const value = raw || "";
    if (!value || SELECTABLE_KINDS.indexOf(value) >= 0) {
      return { kind: value, notice: "" };
    }
    if (KIND_LABEL[value]) {
      // 実在する種別なのに表に出さない場合だけ、理由を伝える（不明な値は黙って落とす）。
      return {
        kind: "",
        notice: `${KIND_LABEL[value]} は表に出しません（upcoming.md で確認できます）`,
      };
    }
    return { kind: "", notice: "" };
  }

  // recommender.js から供給（テスト可能な単一正典）。無ければこの場で縮退定義。
  let activeData: Catalog = DATA;
  let recommendationData: Catalog | null = null;
  let recommendationPromise: Promise<void> | null = null;
  let recommendationError = false;
  let historyStatus: LoadStatus = "idle";

  function createHistoryLoader(
    fetchJson: (ref: string) => Promise<Catalog>,
    onState?: (status: LoadStatus) => void,
  ) {
    let requestId = 0;
    let pending: Promise<Catalog | null> | null = null;
    let value: Catalog | null = null;
    let status: LoadStatus = "idle";

    function notify() {
      if (onState) onState(status);
    }

    return {
      get data() {
        return value;
      },
      get status() {
        return status;
      },
      cancel: () => {
        requestId += 1;
        pending = null;
        if (status === "loading") {
          status = "idle";
        }
      },
      load: (ref: string): Promise<Catalog | null> => {
        if (value) return Promise.resolve(value);
        if (pending) return pending;
        const id = ++requestId;
        status = "loading";
        notify();
        const next = Promise.resolve()
          .then(() => fetchJson(ref))
          .then((data) => {
            if (id !== requestId) return null;
            if (
              !data ||
              typeof data !== "object" ||
              !Array.isArray(data.conferences) ||
              data.conferences.some(
                (conference) =>
                  !conference ||
                  typeof conference !== "object" ||
                  !Array.isArray(conference.editions),
              )
            ) {
              throw new Error("invalid history data");
            }
            value = data;
            pending = null;
            status = "ready";
            notify();
            return data;
          })
          .catch(() => {
            if (id !== requestId) return null;
            pending = null;
            status = "error";
            notify();
            return null;
          });
        pending = next;
        return next;
      },
    };
  }

  // 会議名 + 代表採択論文語彙の IDF 重みを実行時に計算して有効化する。
  // 実測（golden EN）: 実論文タイトルで正解会議 top1 が 25.0→37.5% に改善。
  // 汎用語（machine/deep/cache 等）が全会議の語彙に現れて誤爆するのを減衰する。
  function setRecommendationProfile(data: unknown) {
    const catalog = catalogFrom(data);
    if (!catalog) throw new Error("invalid recommendation catalog");
    activeData = catalog;
    rows = buildRows(catalog);
    if (catalog.conferences.length) {
      Recommender.setNameIdf(Recommender.buildNameIdf(catalog.conferences));
    }
    Recommender.setReranker(catalog.reranker ?? null);
  }

  let state: UiState = {
    mode: "deadlines",
    q: "",
    cats: [],
    kind: "",
    rank: "",
    win: "all",
    est: false,
    domestic: false,
    online: false,
    past: false,
  };

  function $(id: string): HTMLElement {
    const element = document.getElementById(id);
    if (!element) throw new Error(`missing element #${id}`);
    return element;
  }

  /* 印刷物に残す条件の書き下ろし。画面の絞り込み欄は印刷では落ちる（研究室に貼る・
   * グループ会議で回覧する用途 – スタイルのコメントに書いた需要そのもの）なので、
   * 紙のうえに「どんな条件で絞った一覧か」が無いと、受け取った人は収録全体の一覧と
   * 取り違える（2026-09-23 実測: 印刷時に条件を書く箇所はどこにも無かった）。
   * 語は画面のチェック欄・セレクトと同じ物を書く（別の名前を付けない）。
   * ラベルは呼び出し側から渡す – 検査はこの関数を単位で切り出して動かす。 */
  function describeFilters(
    s: {
      q: string;
      cats: string[];
      kind: string;
      rank: string;
      est: boolean;
      domestic: boolean;
      online: boolean;
      past: boolean;
    },
    kindLabel: (k: string) => string,
    categoryLabel: (c: string) => string,
    windowLabel: string,
    sort: { key: string; asc: boolean },
    sortLabel: (key: string) => string,
  ): string {
    const out: string[] = [];
    const query = String(s.q || "").trim();
    if (query) out.push(`検索語「${query}」`);
    if (s.kind) out.push(`種別: ${kindLabel(s.kind)}`);
    if (s.rank) out.push(`ランク: ${s.rank}`);
    if (s.cats.length) out.push(`分野: ${s.cats.map((c) => categoryLabel(c)).join("・")}`);
    if (windowLabel) out.push(`締切まで: ${windowLabel}`);
    if (s.est) out.push("推定締切を含める");
    if (s.domestic) out.push("国内研究会・国内シンポジウムのみ");
    if (s.online) out.push("オンライン参加可のみ");
    if (s.past) out.push("過去の締切も表示");
    // 何も絞っていないときは「全件」と書く。空欄だと、絞ったのに漏れたのか読めない。
    const condition = out.length ? out.join(" ／ ") : "絞り込みなし（収録全体の一覧）";
    /* 並び順は絞り込みではないが、紙には必要 – 同じ一覧を並べ替えて配ることもある
     * （第 126 回で会期順が増えたので、「会期順で印刷した」が紙で分からないと
     * 読み手は日付の順がなぜ違うのかを確かめられない）。既定の並びでも書く。 */
    const order = sortLabel(sort.key);
    if (!order) return condition;
    return `${condition} ／ 並び順: ${order} ${sort.asc ? "昇順" : "降順"}`;
  }

  function valueElement(id: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
    const element = $(id);
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      return element;
    }
    throw new Error(`element #${id} has no value`);
  }

  function inputElement(id: string): HTMLInputElement {
    const element = $(id);
    if (element instanceof HTMLInputElement) return element;
    throw new Error(`element #${id} is not an input`);
  }

  function pad(n: number) {
    return (n < 10 ? "0" : "") + n;
  }

  function fmtDate(d: Date) {
    return (
      d.getUTCFullYear() +
      "-" +
      pad(d.getUTCMonth() + 1) +
      "-" +
      pad(d.getUTCDate()) +
      " " +
      pad(d.getUTCHours()) +
      ":" +
      pad(d.getUTCMinutes())
    );
  }

  function rowDateOnlyState(r: AppRow | DrawerRow, now: number) {
    if (!r.dateOnly) return null;
    if (typeof r.t !== "number" || typeof r.tLast !== "number") return null;
    if (now < r.t) return "definitely-future";
    if (now <= r.tLast) return "uncertain-on-date";
    return "definitely-past";
  }

  function rowIsPast(r: AppRow, now: number) {
    return r.dateOnly ? rowDateOnlyState(r, now) === "definitely-past" : r.t < now;
  }

  function rowIsFuture(r: AppRow, now: number) {
    return !rowIsPast(r, now);
  }

  function rowAfter(r: AppRow, limit: number) {
    return r.t > limit;
  }

  // 投稿作業は日本の時刻で回る。JST を主表記にし、曜日を必ず添える。
  // AoE 締切（23:59 AoE 等）は JST では翌日の夜になるため、UTC 優先では
  // 「日本でいつまでに提出すればよいか」が判定できない。
  const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

  function fmtJst(d: Date) {
    const jst = new Date(d.getTime() + 9 * 3600000);
    return (
      jst.getUTCFullYear() +
      "-" +
      pad(jst.getUTCMonth() + 1) +
      "-" +
      pad(jst.getUTCDate()) +
      "(" +
      WEEKDAY_JA[jst.getUTCDay()] +
      ") " +
      pad(jst.getUTCHours()) +
      ":" +
      pad(jst.getUTCMinutes()) +
      " JST"
    );
  }

  /* 「データ生成」の表示。生成時刻は UTC の `...Z` で来るため、そのまま出すと日本語の
   * 利用者には日付が一日ずれて見える（2026-09-23 実測: 「データ生成: 2026-08-09T00:00:00Z」
   * → JST では同日 09:00。夜ビルドなら日付その物が翌日になる）。一覧と同じ JST + 曜日 に
   * 寄せる。読めない値には嘘の日付を作らず原文を残す。 */
  function generatedAtLabel(value: string): string {
    /* ヘッダーに常に出る語なので、値が欠けているときの書き方まで決める
     * （2026-09-23 実測: 空文字で「データ生成: 」の語だけ、`undefined` ではその英字が、
     * `null` では 1970-01-01 がそのまま出ていた – 締切のサイトで間違った日付を
     * 「データ生成」として見せるのが最悪）。値その物は読めない表記として残す
     * （原因の切り分けに要る）が、主語にはしない。 */
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return `データ生成: ${UNCONFIRMED_JA}`;
    const at = new Date(raw);
    // 日付として読めない値は、そのまま書く。人が読める印字（「未取得」など）を
    // 運営が置くことがあるので、それを「未確認」に潰さない – 危険なのは空欄と、
    // 読めるのに間違った日付（`null` → 1970-01-01）を見ることだけだった。
    if (Number.isNaN(at.getTime())) return `データ生成: ${raw}`;
    return `データ生成: ${fmtJst(at)}`;
  }

  // Anywhere on Earth (UTC-12)。SPEC §7: 締切表示に AoE 表記を併記する。
  function fmtAoE(d: Date) {
    const aoe = new Date(d.getTime() - 12 * 3600000);
    return (
      aoe.getUTCFullYear() +
      "-" +
      pad(aoe.getUTCMonth() + 1) +
      "-" +
      pad(aoe.getUTCDate()) +
      " " +
      pad(aoe.getUTCHours()) +
      ":" +
      pad(aoe.getUTCMinutes()) +
      " AoE"
    );
  }

  // SPEC §7: 日本語 UI。分野は日本語名で示す（英表記の正本は data.json の categories）。
  function catLabel(key: string) {
    return Recommender.categoryLabelJa(key);
  }

  // タイトル + 開催年。タイトルが既にその年で終わっていれば年を二重に付けない。
  /* 表の会議名列に実際に出る語。並び順はこの語を使う（素の `conf.title` で並べると、
   * タイトル欠落の行 — 表示は `ieice-nolta-2027` のような語 — が空文字で先頭に集まり、
   * 「勝手に並ぶ」ように見える。セルの書き換えとSortingが別文字列を持つのが原因）。 */
  /* 同じ締切時刻の行は、そのままではデータ源の順で並ぶ。既定画面 477 行のうち 303 行が
   * 別の行と同じ締切時刻を持ち（同値グループは最大 17 行）、同じ日の内側がバラバラな
   * ままだった。締切時刻 → 表に出る会議名（五十音順）→ 種別（種別セレクトと同じ順）の
   * 順でタイを割り、同じ日に並んだ行を上から読めるようにする。
   * 日本語名は `"ja"` collation を使う（漢字は読み基準の五十音順になる。実測で
   * 航空(か) → 情報(ざ) → 電子(た) と並ぶ。カタカナ語は漢字語より前に出る）。
   * 日付だけ_unknown_の行（175 件）は JST 00:00 相当なので、同じ日内では先に並ぶ。 */
  /* SPEC §7: 締切の時刻を持たない行（常時受付の学術誌など）の並び方。
   * `a.t < b.t` は片側が NaN だと常に false なので、旧実装は比較の向きが定まらなかった
   * （2026-09-23 実測: 時刻の無い行を交ぜて並べ替えると、入力順を変えただけで結果が
   * 変わり、昇順では先頭に出て「いちばん近い締切」と誤読させる）。収録カタログには
   * 現時点で時刻の無い行が 0 件なので今日の見え方は変わらないが、学術誌を 1 行足すと
   * 日時順の表全体が崩れる形だった。ここを直す。
   * 約束: 時刻の無い行は向きの影響を受けない場所（最後尾）にまとめる。未知の種別を
   * 末尾に置く `kindSortIndex` と同じ型。 */
  /* `mult` を中を取る: 昇順・降順は締切のある行の中での向きで、時刻の無い行は
   * どちらの向きでも最後尾に置く（外で `* mult` をすると降順で先頭に反転して
   * 「いちばん遠い」に化ける）。依存を新たに増やさないよう NaN はここで寄せる
   * （ビルド成果物から関数を抜き出す検査は、自由変数を全部渡し直す必要がある）。 */
  function compareDeadlineRows(a: AppRow, b: AppRow, mult: number = 1): number {
    // 基準は「画面に出している暦日」(`tShown`)。古い呼び出し側や検査で組んだ行が
    // 持っていないときは `t` に寄せる（行を落とさない・並びを壊さない）。
    const key = (r: AppRow) =>
      Number.isFinite(r.tShown) ? r.tShown : Number.isFinite(r.t) ? r.t : Number.NaN;
    const aKey = key(a);
    const bKey = key(b);
    const aTail = Number.isFinite(aKey) ? 0 : 1;
    const bTail = Number.isFinite(bKey) ? 0 : 1;
    if (aTail !== bTail) return aTail - bTail;
    const at = Number.isFinite(aKey) ? aKey : 0;
    const bt = Number.isFinite(bKey) ? bKey : 0;
    if (at !== bt) return (at < bt ? -1 : 1) * mult;
    const cmp = conferenceNameCell(a).localeCompare(conferenceNameCell(b), "ja");
    if (cmp) return cmp * mult;
    return (kindSortIndex(a.kind) - kindSortIndex(b.kind)) * mult;
  }

  /** 会期順の比較。会期が決まっていない行（表では「未確認」）は末尾に寄せる –
   * 画面で「未確認」と読める行が、並び順では先頭に来るのは噓になる（時刻未確認の行を
   * 末尾に置くのと同じ約束）。同じ会期の行は締切の近い順に揃える。 */
  function compareEventRows(a: AppRow, b: AppRow, mult: number = 1): number {
    const key = (r: AppRow) => (Number.isFinite(r.tEvent) ? r.tEvent : Number.NaN);
    const aKey = key(a);
    const bKey = key(b);
    const aTail = Number.isFinite(aKey) ? 0 : 1;
    const bTail = Number.isFinite(bKey) ? 0 : 1;
    if (aTail !== bTail) return aTail - bTail;
    const at = Number.isFinite(aKey) ? aKey : 0;
    const bt = Number.isFinite(bKey) ? bKey : 0;
    if (at !== bt) return at < bt ? -1 * mult : 1 * mult;
    // 会期が同じ行（同日に複数ある研究会など）は、締切の基準でそろえる。
    const aDue = Number.isFinite(dueShown(a)) ? dueShown(a) : 0;
    const bDue = Number.isFinite(dueShown(b)) ? dueShown(b) : 0;
    if (aDue !== bDue) return aDue < bDue ? -1 * mult : 1 * mult;
    return 0;
  }

  /** 比較に使う締切の基準（`compareDeadlineRows` と同じ組み立て。検査で単位切り出し
   * するので、外部の決まり値を見ずにこの中で完結させる）。 */
  function dueShown(r: AppRow): number {
    return Number.isFinite(r.tShown) ? r.tShown : Number.isFinite(r.t) ? r.t : Number.NaN;
  }

  /** 種別の並び順（種別セレクトに並べる順と共通。書き写さない）。 */
  function kindSortIndex(kind: string): number {
    const at = SELECTABLE_KINDS.indexOf(kind);
    return at < 0 ? SELECTABLE_KINDS.length : at;
  }

  function conferenceNameCell(r: AppRow): string {
    return titleWithYear(r.conf.title || r.conf.key || "", r.ed.year);
  }

  /* 会議名+年の組み立ては site/recommender.ts の `titleWithYearJa` と**同じ式**を使う。
   * 本体をここに置くのは、検査が表の並び順を実行するときにこの関数を単独で動かすため
   * （他モジュールへの呼び出しにすると、検査側が正本を注入し直しになる）。式がズレたら
   * 一覧と CSV が違う会議名を書くので、`会議名は CSV と同じ語が出る` の検査が両方を
   * 突き合わせて弾く（実装を 2 本持つ代价は検査で払う）。 */
  function titleWithYear(title: string | undefined, year: number | null | undefined) {
    const t = String(title || "").trim();
    if (!t) return "";
    if (!year) return t;
    const yStr = String(year);
    const yy = yStr.slice(-2);
    const normT = t.normalize ? t.normalize("NFKC").trim() : t;
    const hasYear =
      normT.endsWith(yStr) ||
      normT.endsWith(`'${yy}`) ||
      (yy && new RegExp(`(?:20${yy}|['’]?${yy})$`).test(normT));
    if (hasYear) {
      return t;
    }
    return `${t} ${year}`;
  }

  /* 早め絞り込みのボタン。点灯は「その条件が入っているか」だけを見る（`presetIsActive` が
   * 正本）。以前は他の条件がすべて空のときだけ点いていたので、検索語を打った後に
   * 「オンライン参加可」を押すと、条件は掛かっているのにボタンは点かず、押した意味が
   * 画面から読めなかった（2026-09-23）。 */
  function updatePresetActive() {
    document.querySelectorAll<HTMLElement>(".preset-btn").forEach((btn) => {
      btn.classList.toggle(
        "active",
        Recommender.presetIsActive(btn.getAttribute("data-preset"), state),
      );
    });
  }

  /* ボタンは**自分が担当する条件だけ**を出し入れする（`presetNextSelection` が正本）。
   * 以前は押すたびに検索語・締切種別・推定まで初期値へ戻していた。検索語を打った人が
   * 「オンライン参加可」で絞り直したのに全件に戻るなど、意図と逆のことになっていた。
   * 条件をまとめて外す操作は、0 件案内の「条件をまとめて外す」が自分で状態を戻して
   * 担っているので、ボタン側で初期値に戻す役まで兼ねる必要はない。 */
  window.applyPreset = (type: string) => {
    state = { ...state, ...Recommender.presetNextSelection(type, state) };
    stopHistoryLoad();
    if (state.mode === "deadlines") setDeadlineProfile(DATA);
    toForm();
    writeUrl();
    render();
  };

  // Column Sorting
  /* 並び順の目印。ひきがし `↕` だけが見えていると、どの列がどちら向きで並んでいるか
   * 押した人にも分からない（`aria-sort` はスクリーンリーダー向けで、マウス利用者には
   * 見えない）。押している列は ↑ / ↓、他は ↕ のままにする。 */
  function sortMarkJa(active: boolean, asc: boolean): string {
    if (!active) return "↕";
    return asc ? "↑" : "↓";
  }

  /* 並び替えの状態は、見出しの語尾の矢印にしか出ていなかった（2026-09-23 実測）。
   * キーボードでヘッダーを押して並びが変わっても読み上げは何も言わない。「並びを
   * 変えたら黙らない」方針（過ぎた締切を下にまとめた件数を件数欄に書くのと同じ）に
   * 従っていない。画面は混むので、読み上げ専用の短い欄にだけ足す（第 89 回で分けた仕組み）。
   * 列の語は見出し自身から取る（テストにもソートバーにも書き写さない）。 */
  /** 並びの基準にしている列の画面での語。見出しから取る（書き写すと、列の名前を
   * 変えたときに案内だけ古くなる）。見出しは目印の矢印まで書き換えるので、そこは落とす。 */
  function sortColumnLabel(key: string): string {
    if (!key) return "";
    const th = document.querySelector<HTMLElement>(`th[data-sort="${key}"]`);
    return String((th && th.textContent) || "")
      .replace(/[↑↓↕]\s*$/, "")
      .trim();
  }

  function sortNoteJa(key: string, asc: boolean): string {
    const label = sortColumnLabel(key);
    if (!label) return "";
    return ` ｜ 並び順: ${label} ${asc ? "昇順" : "降順"}`;
  }

  // 現在の並び順を aria-sort（支援技術向け）と見出しの目印（目に見える方）で伝える。
  function setSortAria(key: string | null) {
    // 列見出しと、狭い画面に出す並べ替えバー（`button[data-sort]`）が同じ目印を使う。
    // 見出しには `aria-sort`、ボタンには `aria-pressed`（ボタンに aria-sort は意味不通）。
    document.querySelectorAll<HTMLElement>("[data-sort]").forEach((node) => {
      const k = node.getAttribute("data-sort");
      const active = k === key;
      if (node.tagName === "BUTTON") {
        node.setAttribute("aria-pressed", active ? "true" : "false");
      } else {
        node.setAttribute("aria-sort", active ? (sortAsc ? "ascending" : "descending") : "none");
      }
      // 語尾の目印だけ入れ替える（語のほうは触らない）。
      const label = String(node.textContent || "").replace(/[↑↓↕]\s*$/, "");
      node.textContent = `${label}${sortMarkJa(active, sortAsc)}`;
    });
  }

  window.toggleSort = (key: string | null) => {
    if (!key) return;
    if (sortKey === key) {
      sortAsc = !sortAsc;
    } else {
      sortKey = key;
      sortAsc = true;
    }
    setSortAria(key);
    writeUrl();
    render();
  };

  // ソート可能ヘッダーはキーボード（Enter / Space）でも操作できるようにする。
  // グローバル keydown の Enter=選択行のリンクを開く に奪われないよう stopPropagation する。
  document.querySelectorAll<HTMLTableCellElement>("th[data-sort]").forEach((th) => {
    th.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        window.toggleSort?.(th.getAttribute("data-sort"));
      }
    });
  });

  // Drawer Controls
  function openDrawer(r: DrawerRow) {
    drawerRow = r as unknown as AppRow;
    writeUrl();
    // フォーカス管理: 開く直前の要素を保存し、ドロワー内（閉じるボタン）へフォーカスを移す。
    window._prevFocus = document.activeElement as HTMLElement | null;
    $("drawerBackdrop").classList.add("active");
    $("drawerTitle").textContent = titleWithYear(r.conf.title || r.conf.key, r.ed.year);
    $("drawerFullName").textContent = r.conf.full_name || "";
    const dateState = rowDateOnlyState(r, Date.now());
    const dateOnlyText =
      dateState === "uncertain-on-date"
        ? "（時刻未確認。すでに終了している可能性があります）"
        : dateState === "definitely-past"
          ? "（締切日経過）"
          : "（時刻未確認）";

    // 表の種別セルに出している「第 N ラウンド」「ラベル」をドロワーで落とさない。
    // 同じ会議の複数ラウンドを見分ける実務上有意のある情報で、詳細側で欠けると困る。
    const kindDetail = kindDetailJa(r.dl && r.dl.round, r.dl && r.dl.label);
    // 表と同じ式で併記を出す。AoE は公式が AoE 締めの場合だけ見せる
    // （JST 宣言の国内締切に AoE を出すと、実在しない AoE 締切があると誤解させる）。
    const zone = Recommender.officialZone(r.dl);
    let crossCheck = `${fmtDate(new Date(r.t))} UTC`;
    if (zone === "AoE") crossCheck = `公式 ${fmtAoE(new Date(r.t))}`;
    else if (zone === "JST") crossCheck = "公式 JST 締切";
    else if (zone && zone !== "UTC") crossCheck = `公式 ${zone} ／ ${fmtDate(new Date(r.t))} UTC`;

    let html =
      '<div style="background: var(--chip); padding: 14px; border-radius: 6px; border: 1px solid var(--border); margin-bottom: 16px;">' +
      '<div style="font-size: 0.78rem; color: var(--muted);">種別・日時</div>' +
      '<div style="font-size: 1.1rem; font-weight: 600; color: var(--fg); margin-top: 2px;">' +
      esc(KIND_LABEL[r.kind] || r.kind) +
      "</div>" +
      (r.kind === "journal"
        ? '<div style="font-family: var(--font-mono); font-size: 0.85rem; color: var(--accent); margin-top: 4px;">常時受付（締切なし）</div>'
        : r.dateOnly
          ? '<div style="font-family: var(--font-mono); font-size: 0.85rem; color: var(--accent); margin-top: 4px;">' +
            esc(
              `${r.localDate}${Recommender.weekdayJaFromDate(r.localDate) ? `(${Recommender.weekdayJaFromDate(r.localDate)})` : ""}`,
            ) +
            dateOnlyText +
            "</div>"
          : '<div style="font-family: var(--font-mono); font-size: 0.85rem; color: var(--accent); margin-top: 4px;">' +
            fmtJst(new Date(r.t)) +
            "（" +
            crossCheck +
            "）</div>") +
      (kindDetail
        ? `<div style="font-size: 0.8rem; color: var(--muted); margin-top: 4px;">${esc(kindDetail)}</div>`
        : "") +
      "</div>";

    let actionRow = "";
    if (r.kind === "journal") {
      actionRow =
        '<div style="font-size: 0.85rem; color: var(--muted); margin-bottom: 16px;">常時受付のジャーナル（締切なし）です。投稿規程を公式サイトで確認してください。</div>';
    } else {
      actionRow =
        '<div style="font-size: 0.85rem; color: var(--muted); margin-bottom: 16px;">投稿前に公式サイトで最新の募集要項と締切を確認してください。</div>';
    }
    html += actionRow;

    const officialLink = safeExternalUrl(r.ed.link || r.conf.link);
    if (officialLink) {
      html +=
        '<a href="' +
        esc(officialLink) +
        '" target="_blank" style="display: block; text-align: center; background: var(--accent); color: #fff; text-decoration: none; padding: 10px; border-radius: 6px; font-weight: 600; margin-bottom: 20px;">公式サイトを開く</a>';
    }

    const placeRaw = String(r.ed.place || "");
    const placeShown = Recommender.placeJa(placeRaw);
    // 会期も一覧・CSV と同じ式を使う（`eventCellJa` を共有）。公式表記は原表記として添える。
    const eventShownJa = Recommender.eventCellJa(r);
    const eventRawJa = String(r.ed.date_text || "").trim();
    // 研究会は毎月開くので、この行の回より後の会期も併記する（「次はいつか」を
    // 行をめくって探さなくて済むように）。日程の書き方は表と揃える。
    const laterEditions = upcomingEditionsOf(r.conf, String(r.ed.event_start || ""), Date.now());
    const catNamesJa = (r.cats || []).map((key) => catLabel(key));
    const rankShown = (r.rankPairs || []).map((pair) => Recommender.rankPairLabelJa(pair));
    // 今後の会期の開催地も、表と同じ書き方で日本語に寄せる（行の詳細の中で
    // 「開催地: 京都, 日本」と「今後の会期: … ＠Kyoto, Japan」が両方出ると、
    // 別の場所だと誤解する。原文は title に残す）。
    const laterEditionsText = laterEditions
      .map((next) => {
        const place = String(next.place || "");
        return `${meetingRangeJa(next.start, next.end)}${place ? ` ＠${Recommender.placeJa(place)}` : ""}`;
      })
      .join(" / ");
    const laterEditionsRaw = laterEditions
      .map((next) => String(next.place || ""))
      .filter((place) => place && Recommender.placeJa(place) !== place)
      .join(" / ");
    const laterEditionsHtml = laterEditions.length
      ? `<p style="margin-bottom: 8px;"${
          laterEditionsRaw ? ` title="原表記: ${esc(laterEditionsRaw)}"` : ""
        }><strong>今後の会期:</strong> ${esc(laterEditionsText)}</p>`
      : "";
    html +=
      '<div style="font-size: 0.85rem;">' +
      '<p style="margin-bottom: 8px;"><strong>開催地:</strong> ' +
      esc(
        placeShown || (Recommender.fieldNotApplicableJa(r) ? NOT_APPLICABLE_JA : UNCONFIRMED_JA),
      ) +
      "</p>" +
      (placeShown && placeShown !== placeRaw
        ? '<p style="margin-bottom: 8px; color: var(--muted); font-size: 0.8rem;">原表記: ' +
          esc(r.ed.place || "") +
          "</p>"
        : "") +
      '<p style="margin-bottom: 8px;"><strong>会期:</strong> ' +
      esc(
        eventShownJa || (Recommender.fieldNotApplicableJa(r) ? NOT_APPLICABLE_JA : UNCONFIRMED_JA),
      ) +
      "</p>" +
      // 公式ページの会期表記は「原表記」として下に添える（開催地と同じ作法）。前にここを
      // 主語にしていたので、一覧が `2024-03-18(月) 〜 2024-03-21(木)` の行の詳細が
      // `March 18-21, 2024` と英語だけ書いていた（SPEC §7）。
      (eventRawJa && eventRawJa !== eventShownJa
        ? '<p style="margin-bottom: 8px; color: var(--muted); font-size: 0.8rem;">原表記: ' +
          esc(eventRawJa) +
          "</p>"
        : "") +
      laterEditionsHtml +
      // 並べ語は中黒（・）に統一する。一覧・CSV・件数欄はすでに中黒で並べていて、
      // 行の詳細だけ全角コンマ（，）だと、同じ情報を 2 通りの書き方で見る上に、
      // 行の詳細から検索欄へ写したときに 1 語扱いで 0 件へ落ちる（2026-09-23 実測）。
      // 主題タグは日本語表記で出す（会議名から場を推定しないため）。
      // 表にある分野・ランクをドロワーで落とさない（詳細を開いたのに一覧より分からない、を
      // 避ける）。分野は日本語名、ランクの表記は表のセルと同じ形にする。
      (catNamesJa.length
        ? `<p style="margin-bottom: 8px;"><strong>分野:</strong> ${esc(catNamesJa.join("・"))}</p>`
        : "") +
      (rankShown.length
        ? `<p style="margin-bottom: 8px;"><strong>ランク:</strong> ${esc(rankShown.join("・"))}</p>`
        : "") +
      (Recommender.topicTagsJa(r.conf.tags).length
        ? '<p style="margin-bottom: 8px;"><strong>主題:</strong> ' +
          esc(Recommender.topicTagsJa(r.conf.tags).join("・")) +
          "</p>"
        : "") +
      "</div>";
    html += verificationSummary(r.dl);

    $("drawerBody").innerHTML = html;
    const closeBtn = $("drawerClose");
    if (closeBtn) closeBtn.focus();
  }
  window.openDrawer = (row: unknown) => {
    if (isDrawerRow(row)) openDrawer(row);
  };

  // 閉じるのは ✕ ボタン（自前 onclick 経由、引数なし）とバックドロップの直接クリックのみ。
  // ドロワー内の button がバブルしても閉じない。
  function closeDrawer(e: Event | null = null) {
    if (!e || e.target === $("drawerBackdrop")) {
      $("drawerBackdrop").classList.remove("active");
      drawerRow = null;
      writeUrl();
      // フォーカスを開く直前の要素へ戻す。
      const prev = window._prevFocus;
      window._prevFocus = null;
      if (prev?.focus) prev.focus();
    }
  }
  window.closeDrawer = closeDrawer;

  /* どのキーを入力欄・ボタン自身が受け取るかの判断（SPEC §7）。
   *
   * 文字を打つ欄（入力欄・選択欄・改行が打てる欄）では、すべてのキーを欄に渡す –
   * 「/」を検索のショートカットとして奪うと、論文の本文に「GPU/vGPU」や URL を
   * 打てなくなる。ボタンは Enter と Space だけが操作に効くので、それ以外は
   * ショートカットに渡す。
   *
   * 以前はボタンにフォーカスが乗っているとすべてのキーを止めていた（2026-09-23 実測:
   * 完成した画面の `onKeydown` を実行して確かめた – 「過去の締切も表示」のボタンを
   * クリックした直後、`/` で検索欄にフォーカスが移らず、`j` も効かなかった –
   * 画面をクリックするたびに快捷键が死んでいた。`j` / `k` を打つ人はボタンを
   * 踏んだ直後であることが多い）。 */
  function keyBlockedByTarget(tag: string, key: string, contentEditable: boolean): boolean {
    if (contentEditable) return true;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return true;
    if (tag === "BUTTON") return key === "Enter" || key === " " || key === "Spacebar";
    return false;
  }

  // Keyboard Navigation (j/k/Enter/Esc//)
  function onKeydown(e: KeyboardEvent) {
    const target = e.target;
    if (!target || !("tagName" in target) || typeof target.tagName !== "string") return;
    const tag = target.tagName;
    const isContentEditable = "isContentEditable" in target && target.isContentEditable === true;
    const onControl =
      tag === "INPUT" ||
      tag === "SELECT" ||
      tag === "TEXTAREA" ||
      tag === "BUTTON" ||
      isContentEditable;
    if (onControl && e.key === "Escape") {
      if ("blur" in target && typeof target.blur === "function") target.blur();
      /* `/` で検索欄に入って Esc で出た人は、そのまま `j` / `k` を打ちたい。
       * フォーカスが body に落ちると、支援技術ではどこを読めばいいのか分からない
       * （2026-09-23 実測: 選択行に返していなかった – 行の詳細を閉じたときだけ
       * 戻す形になっていた）。選択行があるときだけ返す。検索語は消さない
       * （消すと打ち直しが発生して却って困る）。 */
      if (target === $("q") && selectedIndex >= 0 && shown.length) updateRowSelection();
      return;
    }
    if (keyBlockedByTarget(tag, e.key, isContentEditable)) return;
    // 推薦モードでは非表示の締切表用ショートカットを無効化する。
    if (
      typeof state !== "undefined" &&
      state.mode === "recommend" &&
      (e.key === "d" ||
        e.key === "j" ||
        e.key === "k" ||
        e.key === "Enter" ||
        e.key === "ArrowDown" ||
        e.key === "ArrowUp")
    ) {
      e.preventDefault();
      return;
    }
    if (e.key === "/") {
      e.preventDefault();
      $("q").focus();
    } else if (e.key === "d" && selectedIndex >= 0 && selectedIndex < shown.length) {
      // キーボードで詳細ドロワーを開く。
      // 行にフォーカスしてから開き、
      // openDrawer が _prevFocus として保存する。
      e.preventDefault();
      // 選択行がまだ描画されていなければ先に描く（下のフォーカス先が存在しないため）。
      ensureRowsDrawn(selectedIndex);
      const dtrs = [...$("tbody").querySelectorAll<HTMLTableRowElement>("tr")].filter(
        (row) => !(row.classList.contains("detail-row") || row.classList.contains("month-row")),
      );
      if (dtrs[selectedIndex]) dtrs[selectedIndex].focus();
      openDrawer(shown[selectedIndex]);
    } else if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      if (selectedIndex < shown.length - 1) {
        selectedIndex++;
        ensureRowsDrawn(selectedIndex);
        updateRowSelection();
      }
    } else if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      if (selectedIndex > 0) {
        selectedIndex--;
        updateRowSelection();
      }
    } else if (e.key === "Enter" && selectedIndex >= 0 && selectedIndex < shown.length) {
      const r = shown[selectedIndex];
      const href = safeExternalUrl(r.ed.link || r.conf.link);
      if (href) window.open(href, "_blank", "noopener,noreferrer");
    } else if (e.key === "Escape") {
      closeDrawer();
    }
  }
  window.addEventListener("keydown", onKeydown);

  /* 選択は `shown`（絞り込み後の全行）まで進められるが、表に描いてある行は `drawn` 行だけ
   * （既定は PAGE=40 行 – 2026-09-23 実測）。`j` を 40 回押すと、ハイライトとフォーカスは
   * 40 行目に残ったまま内部の選択だけ 41 行目以降へ進み、`d` を押すと画面に出ていない行の
   * 詳細が開いていた。マウスなら「さらに表示」を自分で押せるが、キーボードだけで操作する人に
   * その入口を探させるのは無理があるので、必要になった時点で描く。 */
  function ensureRowsDrawn(index: number): void {
    let guard = 0;
    while (drawn <= index && drawn < shown.length && guard <= shown.length) {
      drawMore();
      guard += 1;
    }
  }

  function updateRowSelection() {
    // 展開用 detail-row を除外し、shown[] の行と 1:1 対応を保つ
    const trs = [...$("tbody").querySelectorAll<HTMLTableRowElement>("tr")].filter(
      (row) => !(row.classList.contains("detail-row") || row.classList.contains("month-row")),
    );
    trs.forEach((tr, idx) => {
      const on = idx === selectedIndex;
      tr.classList.toggle("selected", on);
      /* 選んだ行はクラスの目印だけ変えていた。視覚だけの状態は支援技術に伝わらない
       * （2026-09-23 実測: ビルド成果物に `aria-current`・`aria-selected` は 1 箇所も
       * 無く、`selected` クラスの切り替えだけだった）。表の行なので `aria-current="row"`
       * を使う。選ぶのをやめた行からは消す（付けっぱなしだと 2 行が「今選んでいる行」に
       * なる）。再描画時は選択が解かれるので、付けっぱなしにはならない。 */
      if (on) tr.setAttribute("aria-current", "row");
      else tr.removeAttribute("aria-current");
    });
    if (trs[selectedIndex]) {
      /* フォーカスも選んだ行へ移す。クラス目印だけ変えてスクロールしていたので、
       * キーボードで `j` / `k` を押しても支援技術には何も読まれなかった（2026-09-23 実測:
       * てびきは「キーボードで一覧を動かす」と案内しているのに、支援技術には無音だった）。
       * `preventScroll` は効かない環境があるので、自分で scrollIntoView する。 */
      trs[selectedIndex].focus({ preventScroll: true });
      /* 1 打鍵ごとに なめらかスクロールを続けると酔う人がいる（「動きを抑える」設定は
       * JS の `behavior` を自動では見ない – 2026-09-23 実測）。設定があれば瞬間移動にする。 */
      const reduced =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      trs[selectedIndex].scrollIntoView({
        block: "nearest",
        behavior: reduced ? "auto" : "smooth",
      });
    }
  }

  // ---- CATEGORIES ----
  const catsBox = $("cats");
  const catCountNodes: Record<string, HTMLElement> = {};
  Object.keys(DATA.categories).forEach((k) => {
    const lbl = document.createElement("label");
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.value = k;
    lbl.appendChild(chk);
    const span = document.createElement("span");
    // 日本語名を主、英表記は併記（現場では分野の英語名で覚えている人もいるため）。
    const en = String(DATA.categories?.[k] || "");
    span.textContent = en && en.toLowerCase() !== k ? `${catLabel(k)}（${en}）` : catLabel(k);
    span.title = `${k}: ${en}`;
    lbl.appendChild(span);
    // 件数（他の絞り込みを通った行の数）。何を選ぶと何が残りそうか分からないと、
    // チップを試すたびに表が空になる。0 の分野も消さずに薄く残す（収録が無いことが分かる）。
    const countNode = document.createElement("span");
    countNode.className = "chip-count";
    countNode.textContent = "0";
    lbl.appendChild(countNode);
    catCountNodes[k] = countNode;
    catsBox.appendChild(lbl);
  });

  /** 分野チップの件数を書き換える。`filter()` が数え直した `categoryCounts()` を使う。 */
  function updateCategoryCounts(): void {
    const counts = categoryCounts();
    Object.keys(catCountNodes).forEach((key) => {
      const node = catCountNodes[key] as HTMLElement;
      const value = counts[key] || 0;
      node.textContent = String(value);
      node.classList.toggle("zero", value === 0);
    });
  }

  // ---- SELECTS ----
  const kindSel = $("kind");
  const optAllK = document.createElement("option");
  optAllK.value = "";
  optAllK.textContent = KIND_ALL_LABEL_JA;
  kindSel.appendChild(optAllK);
  SELECTABLE_KINDS.forEach((k) => {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = KIND_LABEL[k];
    kindSel.appendChild(opt);
  });

  const rankSel = $("rank");
  const optAllR = document.createElement("option");
  optAllR.value = "";
  optAllR.textContent = "すべて";
  rankSel.appendChild(optAllR);
  // 値は data の grade のまま（URL にも同じ値を書く）。見出しは日本語に出す —
  // 「Rank N」は内部トークンそのもので、読み手には意味が伝わらない。
  RANK_GRADE_OPTIONS.forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r;
    opt.textContent = r === "N" ? RANK_UNRATED_JA : r;
    opt.title = r === "N" ? RANK_UNRATED_TITLE_JA : RANK_FILTER_NOTE_JA;
    rankSel.appendChild(opt);
  });
  rankSel.title = RANK_FILTER_NOTE_JA;

  // ---- DATA FLATTENING ----
  function buildRows(data: Catalog): AppRow[] {
    return Recommender.candidateRows(data);
  }
  let rows = buildRows(DATA);

  function setDeadlineProfile(data: Catalog) {
    activeData = data;
    rows = buildRows(data);
  }

  function syncHistoryState() {
    historyStatus = historyLoader.status;
    if (
      historyStatus === "ready" &&
      historyLoader.data &&
      state.mode === "deadlines" &&
      state.past
    ) {
      setDeadlineProfile(historyLoader.data);
    } else if (historyStatus === "error" && state.mode === "deadlines") {
      setDeadlineProfile(DATA);
    }
    render();
  }

  function fetchHistoryJson(ref: string): Promise<Catalog> {
    return fetch(ref).then(async (response) => {
      if (!response.ok) throw new Error(`history ${response.status}`);
      const catalog = catalogFrom(await response.json());
      if (!catalog) throw new Error("invalid history data");
      return catalog;
    });
  }

  const historyLoader = createHistoryLoader(fetchHistoryJson, syncHistoryState);

  // Update Summary Dashboard Stats
  $("statConfs").textContent = String((DATA.conferences || []).length);
  const nowMs = Date.now();
  const next30 = rows.filter(
    (r) =>
      (r.kind === "abstract" || r.kind === "paper") &&
      !r.est &&
      rowIsFuture(r, nowMs) &&
      !rowAfter(r, nowMs + 30 * DAY),
  ).length;
  $("statUpcoming").textContent = String(next30);
  const nicheCount = (DATA.conferences || []).filter(
    (c) => (c.tags || []).indexOf("niche") !== -1,
  ).length;
  $("statNiche").textContent = String(nicheCount);
  const domCount = (DATA.conferences || []).filter(
    (c) => (c.tags || []).indexOf("domestic-jp") !== -1,
  ).length;
  $("statDomestic").textContent = String(domCount);

  // ---- REMAIN / STATUS ----
  function remain(ms: number) {
    /* 締切の瞬間が読めない行は組み立て時点で落ちるので、ここは本来通らない。
     * それでも通ったときに画面へ `あと NaN 日` と出すのがいちばん悪い
     * （2026-09-23 実測: 呼び出し側が基準を間違えると NaN がそのまま出ていた）。
     * 数えられない、という意味で横線を出す（「評価なし」を空欄にしない規則と同じで、
     * 値が無いことを値として出す）。 */
    if (!Number.isFinite(ms)) return { text: "―", cls: "" };
    const now = Date.now();
    const diff = ms - now;
    if (diff < 0) {
      /* 「本日終了」は経過時間ではなく **JST の暦日**で決める。経過日数の floor だと
       * 23 時間 59 分前（JST では昨日）まで「本日終了」になり、いつ締切ったかが読め
       * なかった（2026-09-23 実測: JST で前日に終わった締切が「本日終了」出る。一覧は
       * JST を単位にしているので、ここも揃える）。
       * JST のオフセットは monthKey と同じ理由でインラインに置く（この関数はビルド
       * 成果物から抜き出して検査するので、依存を増やさない。第 91 回）。 */
      const jstDay = (t: number) => Math.floor((t + 9 * 3600000) / DAY);
      const days = jstDay(now) - jstDay(ms);
      return { text: days <= 0 ? "本日終了" : `${days} 日前に終了`, cls: "past" };
    }
    const d = Math.floor(diff / DAY);
    if (d === 0) {
      const h = Math.floor(diff / 3600000);
      return { text: h <= 0 ? "まもなく" : `あと ${h} 時間`, cls: "today" };
    }
    return { text: `あと ${d} 日`, cls: d <= 14 ? "soon" : "" };
  }

  // Paper Text Matching Score。ロジックは recommender.js (Recommender.breakdown) に移管

  // ---- SEMANTIC MATCH (AI 補助: transformers.js + embeddings.json) ----
  // embeddings.json は build 時に生成（src/embeddings.ts）。
  // ブラウザでは transformers.js でユーザー入力を埋め込み、語彙スコアと合成する。
  let EMBEDDINGS: EmbeddingBundle | null = null; // manifest + 言語別の埋め込み表
  let semQuery: Vector | null = null; // 現在のユーザー入力の埋め込みベクトル
  let semModel: SemanticModel | null = null; // transformers.js の pipeline
  let semLoadedModel = ""; // ロード済みモデル ID（言語適応で切り替え）
  let semEmbeddings: VectorMap | null = null; // 言語に応じた埋め込み表（en / multi）
  let semGeneration = 0;
  let semState: SemanticStatus = "idle"; // idle | loading | ready | error（AI 状態の表示用）
  let semanticReason: string | null = null;
  /* 画面には日本語の理由だけを出し、識別子はこの要素の `data-semantic-reason` に残す
   * （原因追跡は #711 以来の要件なので捨てない）。*/
  let countSemanticReason: string | null = null;
  const semProbeCache: Record<string, boolean> = {}; // model@revision -> probe compatibility

  function currentPaperText() {
    return valueElement("paperText").value;
  }

  function semanticIsCurrent(generation: number, text: string) {
    return generation === semGeneration && currentPaperText() === text;
  }

  function clearSemantic(nextState?: SemanticStatus) {
    semQuery = null;
    semEmbeddings = null;
    Recommender.setPaperVecs(null);
    if (nextState) semState = nextState;
  }

  function invalidateSemantic() {
    semGeneration += 1;
    clearSemantic("idle");
  }

  function loadEmbeddings(cb: () => void) {
    if (EMBEDDINGS) {
      cb();
      return;
    }
    semanticReason = semanticReason || "embeddings unavailable";
    cb();
  }

  function loadTransformers(
    modelMeta: EmbeddingModelMeta,
    generation: number,
    cb: (loaded: boolean) => void,
  ) {
    const modelId = modelMeta.model;
    const revision = modelMeta.revision;
    const modelKey = `${modelId}@${revision}`;
    if (semLoadedModel === modelKey && semModel) {
      if (generation === semGeneration) cb(true);
      return;
    }
    if (generation !== semGeneration) return;
    if (semState === "error") {
      cb(false);
      return;
    }
    semState = "loading";
    // jsdelivr の素のパッケージ URL は Node 向けバンドルで window.transformers を
    // 公開しない（実行しても undefined になる）。ESM ビルド（+esm）を動的 import する。
    const transformersUrl = "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/+esm";
    import(transformersUrl)
      .then((module: unknown) => {
        if (!transformersModule(module)) throw new Error("invalid transformers module");
        return module.pipeline("feature-extraction", modelId, { revision });
      })
      .then((model) => {
        if (generation !== semGeneration) return;
        semModel = model;
        semLoadedModel = modelKey;
        semState = "ready";
        cb(true);
      })
      .catch(() => {
        if (generation !== semGeneration) return;
        semState = "error";
        cb(false);
      });
  }

  function checkSemanticProbe(modelMeta: EmbeddingModelMeta, cb: (compatible: boolean) => void) {
    const modelKey = `${modelMeta.model}@${modelMeta.revision}`;
    if (Object.hasOwn(semProbeCache, modelKey)) {
      cb(semProbeCache[modelKey]);
      return;
    }
    const model = semModel;
    if (!model) {
      cb(false);
      return;
    }
    model(modelMeta.probe.text, { pooling: "mean", normalize: true })
      .then((output: unknown) => {
        if (!semanticOutput(output)) throw new Error("invalid embedding output");
        const ok = Recommender.embeddingProbeMatches(modelMeta, Array.from(output.data));
        semProbeCache[modelKey] = ok;
        cb(ok);
      })
      .catch(() => {
        semProbeCache[modelKey] = false;
        cb(false);
      });
  }

  // 論文テキストが変わったら埋め込みを再計算し、完了後に render する。
  // 言語適応: 日本語を含む論文は多言語モデル、それ以外は英語モデルで埋め込む
  // （実測: EN は英語モデル 80.1% > 多言語 76.2%、JP は多言語 42.9% > 英語 19.0%）。
  function scheduleSemantic() {
    const generation = ++semGeneration;
    const text = currentPaperText();
    clearSemantic("idle");
    if (!text.trim() || !Recommender) return;
    semState = "loading";
    loadEmbeddings(() => {
      if (!semanticIsCurrent(generation, text)) return;
      if (!EMBEDDINGS) {
        clearSemantic("error");
        render();
        return;
      }
      const bundle = EMBEDDINGS;
      const isJp = Recommender.hasJapanese(text);
      const language = isJp && bundle.multi ? "multi" : "en";
      const embSet = language === "multi" ? bundle.multi : bundle;
      if (!embSet || !Recommender.embeddingSetCompatible(bundle, language)) {
        semanticReason = "embedding set incompatible";
        clearSemantic("error");
        render();
        return;
      }
      const modelMeta = bundle.manifest.models[language];
      if (!modelMeta) {
        semanticReason = "model metadata missing";
        clearSemantic("error");
        render();
        return;
      }
      loadTransformers(modelMeta, generation, (loaded) => {
        if (!semanticIsCurrent(generation, text)) return;
        if (!loaded || semLoadedModel !== `${modelMeta.model}@${modelMeta.revision}` || !semModel) {
          semanticReason = "model load failed";
          clearSemantic("error");
          render();
          return;
        }
        checkSemanticProbe(modelMeta, (probeOk) => {
          if (!semanticIsCurrent(generation, text)) return;
          if (!probeOk) {
            semanticReason = "probe mismatch";
            clearSemantic("error");
            render();
            return;
          }
          const lines = Recommender.parsePaperLines(text);
          const q = Recommender.queryText(lines);
          const model = semModel;
          if (!model) {
            semanticReason = "model unavailable";
            clearSemantic("error");
            render();
            return;
          }
          model(q, { pooling: "mean", normalize: true })
            .then((output: unknown) => {
              if (!semanticOutput(output)) throw new Error("invalid embedding output");
              if (!semanticIsCurrent(generation, text)) return;
              let nextQuery = Array.from(output.data);
              // 擬似関連性フィードバック（PRF）: 掲載先タグ付き論文がある場合、
              // その会議の埋め込みを 0.3 混ぜる（「自分が載せた所と似た会議」を拾う）。
              // 実測: タグ付きクエリで正解会議 #1 が 78.9% → 92.2% に改善。
              const tagged = lines.filter((paper) => paper.venue);
              if (tagged.length) {
                const matched: ConferenceRecord[] = [];
                tagged.forEach((paper) => {
                  Recommender.matchVenueTag(paper.venue ?? "", activeData.conferences).forEach(
                    (c) => {
                      matched.push(c);
                    },
                  );
                });
                const mvecs = matched
                  .map((conference) => embSet.embeddings[conference.key])
                  .filter((item): item is Vector => Boolean(item));
                if (mvecs.length) {
                  let avg = mvecs[0].slice();
                  for (let i = 1; i < mvecs.length; i++) {
                    for (let j = 0; j < avg.length; j++) avg[j] += mvecs[i][j];
                  }
                  avg = avg.map((value) => value / mvecs.length);
                  nextQuery = Recommender.blendVectors(nextQuery, avg, 0.7);
                }
              }
              if (!semanticIsCurrent(generation, text)) return;
              semQuery = nextQuery;
              semEmbeddings = embSet.embeddings;
              // 論文個別ベクトル（max 類似度）は英語クエリのみ。
              // 日本語クエリは多言語モデルなので英語モデルの論文ベクトルを混ぜない。
              Recommender.setPaperVecs(isJp ? null : (bundle.paperVecs ?? null));
              semState = "ready";
              render();
            })
            .catch(() => {
              if (!semanticIsCurrent(generation, text)) return;
              semanticReason = "query embedding failed";
              clearSemantic("error");
              render();
            });
        });
      });
    });
  }

  // ---- FILTERING ----
  /** 展開で置き換わった語だけ `来月 = 2026年10月` の形で返す（説明用の補助）。 */
  function relativeMonthNote(query: string, expanded: string): string {
    const before = String(query || "")
      .trim()
      .split(/\s+/);
    const after = String(expanded || "")
      .trim()
      .split(/\s+/);
    const pairs: string[] = [];
    for (let i = 0; i < before.length; i++) {
      if (after[i] && before[i] !== after[i]) pairs.push(`${before[i]} = ${after[i]}`);
    }
    return pairs.length ? ` ｜ ${pairs.join("、")}` : "";
  }

  /** 相対月を展開した後の検索語。`filter()` の描画周期内でだけ有効（利用者の入力文は `state.q`）。 */
  let searchQuery = "";

  /* 値が空のとき、記号「-」だけを出さない。利用者は「該当なし」「収録漏れ」
   * 「公式が出ていない」を区別できない。確認できていないことを短い語で出し、
   * 詳しい理由は title に落とす。「未定」にすると会議が決めていないことになり、
   * kamiyobi が確認できていないという事実とは別の話になるため使わない。
   * 語そのものは recommender の正本を使い、表に出る語が検索で引ける状態を保つ。 */
  const UNCONFIRMED_JA = Recommender.unconfirmedLabelJa();
  /* 「未確認」（確認できていない）と「該当なし」（そもそも存在しない）は別の話なので、
   * 常時受付の行には後者を出す（SPEC §7）。 */
  const NOT_APPLICABLE_JA = Recommender.notApplicableLabelJa();
  const UNCONFIRMED_TITLES_JA = {
    event: " kamiyobi が公式で会期を確認できていません。".trim(),
    place: " kamiyobi が公式で開催地を確認できていません。".trim(),
    rank: "CCF・CORE の一覧でこの会議の評価が確認できていません。".trim(),
  };

  /* 「N 件 / 全 M 件」の差の内訳。既定で隠れる行（過去の締切・推定・投稿締切以外の種別）を
   * 数える。隠れていることを説明しないと、探した締切が「無い」と誤解される。 */
  let hiddenCounts = {
    past: 0,
    est: 0,
    kind: 0,
    domestic: 0,
    // 「オンライン参加可のみ」で落ちた行数と、そのうち開催地自体が未確認の行数。
    online: 0,
    onlinePlaceUnknown: 0,
    // 「締切まで N 日以内」の窓（上限・下限の両方）で落ちた行数。
    window: 0,
    // 「評価でしぼる」で落ちた行数（選択した等級を持たない行）。
    rank: 0,
    // 分野チップで落ちた行数（選んだ分野を持たない行）。
    cats: 0,
  };

  /* URL で渡された種別のうち、表に出さないものを読み捨てたときの説明。
   * 黙って条件が変わったように見えるのを避ける（相対月を解決したときと同じ方針）。 */
  /* 共有リンクの中で、この一覧が受け付けられなかった値の案内。黙って落とすと、送った人が
   * 意図した絞り込みが外れた画面を相手に見せる（送った人は自分が映った画面を信じている）。
   * 種別だけ特別扱いしていたのは、他の値でも同じ問題が起きるのに気づけていなかったから。 */
  let urlNotices: string[] = [];

  /* 共有リンクのチェック欄の値を読む。空・0・false は入りなし、1・true は入り、
   * それ以外は「読めない」として扱い、理由を出す。第 130 回でランク・締切まで・分野・
   * 並び順は直したが、チェック欄は `=== "1"` のまま残っていて、`?past=true` も
   * `?past=maybe` も黙って入りなしになっていた（2026-09-23 実測: 4 つのチェック欄いずれも、
   * 1 以外の値で画面になんの説明も出さない）。 */
  function urlFlagJa(raw: unknown): { on: boolean; readable: boolean } {
    const value = String(raw == null ? "" : raw)
      .trim()
      .toLowerCase();
    if (value === "" || value === "0" || value === "false") return { on: false, readable: true };
    if (value === "1" || value === "true") return { on: true, readable: true };
    return { on: false, readable: false };
  }

  /** 受け付けられなかった値を、条件の書き下ろしとは別の文で伝える。 */
  function urlValueNoticeJa(label: string, value: string, behavior: string): string {
    if (!value) return "";
    return `リンクの${label}「${value}」はこの一覧で使えない値なので、${behavior}`;
  }

  function hiddenDeadlineCounts(): {
    past: number;
    est: number;
    kind: number;
    domestic: number;
    online: number;
    onlinePlaceUnknown: number;
    window: number;
    rank: number;
    cats: number;
  } {
    return hiddenCounts;
  }

  /* 検索語が収録データ全体で何件に当たるかを数える（0 件の案内が使う）。
   * 表は投稿締切・未来だけを出すので、収録している語でも 0 件になりうる。
   * 「 kamiyobi に無い」と「今出していない」を区別できないと、そこで検索をやめてしまう。
   * 絞り込みをまたいだ再実行はしない（どの条件を外せば出るかと結びつけると、
   * 1 つ外しても他の条件で 0 件のときに過剰な約束になる）。 */
  function queryMatchCounts(query: string): { catalog: number; journal: number } {
    const trimmed = query.trim();
    if (!trimmed) return { catalog: 0, journal: 0 };
    const matches = Recommender.searchMatcher(
      Recommender.expandRelativeMonths(trimmed, Date.now()),
    );
    let catalog = 0;
    rows.forEach((row) => {
      if (matches(row.hay)) catalog += 1;
    });
    let journal = 0;
    Recommender.journalRows(activeData.conferences, Date.now()).forEach((row) => {
      if (matches((row as unknown as AppRow).hay)) journal += 1;
    });
    return { catalog, journal };
  }

  /* 0 件の理由を出したのは良いが、その文は表の場所（`#emptyText`）に書くだけで、
   * 支援技術には読まれていなかった（2026-09-23 実測: 読み上げ専用の欄は件数だけを
   * 言っていた）。長い文を aria-live に流すのは避ける方針なので、読み上げには同じ原因を
   * 短い形で入れる。 */
  function zeroResultLiveNote(filter: {
    hiddenKindWords: string[];
    termCounts: Array<{ term: string; count: number }>;
    // 検索語が公式ページの URL の形か（URL で引いた人は「語が無い」話では済まない）。
    urlQuery: boolean;
    queryMatch: { catalog: number; journal: number };
    catalogConferences: number;
    // 下に並ぶ「外せる条件」が 1 つ以上あるか（0 件案内と数え上げを同じにする）。
    clearable: boolean;
    pastShown: boolean;
    hidden: Record<string, number>;
  }): string {
    // データその物が無いときは、他のどの説明より先にそれを言う（読み上げは短い形で）。
    if (!filter.catalogConferences) return " ｜ 締切のデータが入っていません";
    /* 0 件画面の下の方には「外せる条件」を書く。読み上げには短い形だけを流すので、
     * その案内が画面に出ていることを一言添えないと、支援技術では 0 件とだけ聞いて
     * 操作をやめてしまう（画面の内訳まで流すと 1 打鍵ごとに数十語になるので、
     * そこは流さない – 上の `countLive` の注記と同じ判断）。 */
    const loosenable =
      filter.clearable ||
      !filter.pastShown ||
      Boolean(filter.hidden?.past) ||
      Boolean(filter.hidden?.est);
    const pointer = loosenable ? "。下に外せる条件も書いてあります" : "";
    // 外せる条件が 1 つも無いなら、その旨を言う（「下に案内がある」「緩めると出る」は
    // いずれも噓になる）。2026-09-23 の収録では踏めない（今後より後の締切が多数ある）
    // ので、収録が古くなった日に効く形の防御である。
    if (!loosenable) return " ｜ 収録にいま以降の締切が残っていません。データ更新をお待ちください";
    /* URL を貼った人（メーリングリストの CFP リンクで収録確認をしている – 第 153 回）には、
     * 打った文字列を「語が無い」と言っても収録の範囲が伝わらない。何を引いたのかを名指しして、
     * 収録の中心を言う。会議名でも引けるので、その案内も添える。 */
    if (filter.urlQuery && filter.queryMatch.catalog === 0)
      return (
        " ｜ 検索語の URL の会議は収録に見当たりません。収録の中心はランク付けの一覧に載る会議と" +
        "国内研究会です。公式ページのアドレスではなく会議名（「ICDE」など）でも試してください" +
        pointer
      );
    const dead = filter.termCounts.filter((t) => t.count === 0).map((t) => t.term);
    if (dead.length) return ` ｜ 語「${dead[0]}」は収録データにありません${pointer}`;
    if (filter.hiddenKindWords.length)
      return (
        ` ｜ 検索語は「${filter.hiddenKindWords[0]}」の種別に当たります（表に出さない種別です）` +
        pointer
      );
    if (filter.queryMatch.catalog > 0)
      return (
        ` ｜ 検索語は収録で ${countJa(filter.queryMatch.catalog)} 件に当たりますが、いまの条件では 0 件です` +
        pointer
      );
    // 何も絞り込んでいないのに 0 件なら、緩める条件ではなく収録の時刻の話をする。
    if (!filter.clearable && !filter.pastShown && filter.hidden?.past)
      return " ｜ 収録の締切はすべて過ぎています。「過去の締切も表示」で出ます";
    return " ｜ いまの条件では行がありません" + pointer;
  }

  /* 語を並べて打った検索語を、語の組に分けて収録データの当たり数を数える
   * （`queryMatchCounts` と同じ展開を使う – 展開を忘れると届く語を「無い」と書く）。 */
  function queryTermNotes(query: string): Array<{ term: string; count: number }> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const now = Date.now();
    return Recommender.queryTermCounts(
      Recommender.expandRelativeMonths(trimmed, now),
      rows.map((row) => row.hay),
      now,
    );
  }

  /* 検索語が「表に出さない種別」の表示語に当たるか。`SELECTABLE_KINDS` に無い種別が対象で、
   * 選択肢と同じ列表から求める（書き写すと増えた種別が案内から落ちる）。 */
  function hiddenKindQueryWords(query: string): string[] {
    const table = Recommender.kindLabelTable();
    const hidden = Object.keys(table)
      .filter((kind) => SELECTABLE_KINDS.indexOf(kind) < 0)
      .map((kind) => String(table[kind] || ""));
    return Recommender.queryHiddenKindMatches(query, hidden);
  }

  /** 分野チップの件数（`filter()` が分野以外の条件を通った行について数え直す）。 */
  let catFacetCounts: Record<string, number> = {};

  function categoryCounts(): Record<string, number> {
    return catFacetCounts;
  }

  /** 締切までの窓の選択肢。`site/template.html` の `<select id="win">` と必ず揃える。 */
  const WIN_OPTIONS = ["all", "7d", "30d", "90d", "180d"];

  /* 窓の上限時刻。絞り込みと 0 件時の会期案内で別の式を書くと、表と案内が違う窓で
   * 動く（過去行を出すか否かは `past` のチェックボックスだけが決める）。 */
  function windowLimitMs(win: string, now: number): number {
    return win === "all" ? Number.POSITIVE_INFINITY : now + Number.parseInt(win, 10) * DAY;
  }

  /* 「締切まで N 日」の下側。既定（過去を表示しない）は過去分がそもそも出ないので要らないが、
   * 「過去の締切も表示」と同時に使うと窓が未来側にしか効かず、2019 年まで全件が残って
   * 窓が意味を失う（実測: 7 日以内 + 過去表示で 2,059 行）。過去を見せているときは
   * 同じ日数の前後の窓として扱う（「先週出た締切と今週の締切」が見られる形）。 */
  function windowFloorMs(win: string, now: number): number {
    return win === "all" ? Number.NEGATIVE_INFINITY : now - Number.parseInt(win, 10) * DAY;
  }

  function filter(): AppRow[] {
    const now = Date.now();
    // `来月` などの相対月を検索語として受け付ける。展開式の一覧への反映は recommender が
    // 持つ（`来月` がどの月を指すかの判断を UI 側に二重化しない）。
    searchQuery = Recommender.expandRelativeMonths(state.q, now);
    // 検索語の分解は 1 描画に 1 回で足りる。行ごとに `hayMatches` を呼ぶと、そのたびに
    // 語を分解し直す（3234 行で 1 打鍵あたり約 83 ms かかっていた）。
    const matchesQuery = Recommender.searchMatcher(searchQuery);
    const isPast = (row: AppRow) => (row.dateOnly ? now > row.tLast : row.t < now);
    const isAfter = (row: AppRow, dateLimit: number) => row.t > dateLimit;
    const limit = windowLimitMs(state.win, now);
    const floor = state.past ? windowFloorMs(state.win, now) : Number.NEGATIVE_INFINITY;
    const pElem = typeof document !== "undefined" ? $("paperText") : null;
    const pText =
      state.mode === "recommend" && pElem && "value" in pElem && typeof pElem.value === "string"
        ? pElem.value.trim()
        : "";
    // 単体抽出テスト（node probe）でも動くよう、filter 内では window 経由で解決する
    const Rec = Recommender;
    const pLines = Rec
      ? Rec.parsePaperLines(pText)
      : pText
        ? [{ title: pText, keywords: "", venue: "" }]
        : [];

    // 分野: 手動チップがあればそれで絞る。論文モードではチップ自体を見せていない
    // （`.field.deadline-only` で非表示）ので、ここで絞る必要は無い。
    const cats = state.cats;
    // 掲載先タグの属するカテゴリ（例: RTSS タグ → systems）。同カテゴリの会議を僅かにブースト
    const autoCats = pLines.length && Rec ? Rec.autoDetectCats(pLines) : [];
    const detectedVenueCats = pLines.length && Rec ? Rec.venueCategories(pLines, rows) : [];
    const venueCats = [...new Set([...(state.cats || []), ...detectedVenueCats, ...autoCats])];

    // 論文モードおよび常時受付モード: 未来締切 + 常時受付ジャーナル + 未来締切の無い会議の過去代表行
    // （過去行は代表 1 行のみに限定し、全過去版で埋めない）
    let pool = rows;
    if (pLines.length && Rec) {
      pool = rows
        .filter((row) => !isPast(row))
        .concat(Rec.journalRows(activeData.conferences, now), Rec.pastRepresentatives(rows, now));
    } else if (state.kind === "journal" && Rec) {
      pool = rows.concat(Rec.journalRows(activeData.conferences, now));
    }

    // 推薦モード（論文入力あり）では締切画面用の絞り込みを一切適用しない。
    // 検索・種別・ランク・期間・推定・過去に加え、分野チップ・国内・オンラインも
    // このモードでは非表示なので適用しない（効かない制御を残さない）。
    // 分野は絞らず `venueCats` によるスコアの寄せにだけ使う。
    // pool は既に未来締切 + 常時受付ジャーナル + 過去代表行で構成済み。
    const inRecommend = state.mode === "recommend" && pLines.length > 0;

    // 分野だけを覗いた述語。分野チップの件数は「他の条件を通った行」を数えるため、
    // ここで区切っておく（選んだ分野で自分の選択肢を潰さない、facet の普通の形にする）。
    const matchesExceptCats = (r: AppRow): boolean => {
      // 既定の条件で何件が落ちたかを数える。「N 件 / 全 M 件」の差を読み手が説明できる
      // ようにするためで、条件式を外に書き出して二重実装する代わりにここで名前を付ける。
      const byEst = !inRecommend && !state.est && r.est && !pLines.length;
      // 過去行は通常モードで除外（「過去の締切も表示」トグルで表示）。
      // 論文モードでは「締切済みだが次回予定あり」の会議として許容
      const byPast = isPast(r) && !pLines.length && !state.past;
      // 推定日程がすでに過ぎた行は「推定を含める」でも出さない（未来の約束ではない）。
      const byEstimatedPast = r.est && isPast(r);
      // このサイトは「これから投稿できるところ」を探すもの。
      // 投稿締切（概要・論文）以外の種別（開催・採否通知等）は表示しない。
      // 論文モードまたは種別指定時のみ常時受付ジャーナル（kind: journal）を許容する。
      const byKind =
        r.kind !== "abstract" &&
        r.kind !== "paper" &&
        !((pLines.length || state.kind === "journal") && r.kind === "journal");
      // 各条件は**独立に**数える（1 行が過去かつ投稿締切以外なら両方に立つ）。
      // なので内訳を足しても全件にはならない — 表示文でもそう書く。
      if (!inRecommend) {
        if (byEst) hiddenCounts.est += 1;
        if (byPast) hiddenCounts.past += 1;
        if (byKind) hiddenCounts.kind += 1;
      }
      if (byEst || byPast || byEstimatedPast || byKind) {
        return false;
      }
      if (!inRecommend && isAfter(r, limit)) {
        // 「締切まで 7 日以内」を選ぶと 438 件が黙って消える（実測: 対象 477 行のうち表示 39 件）。
        // 件数欄が窓の話をしないと「今週は収録が薄い」と誤解して検索をやめてしまう。
        hiddenCounts.window += 1;
        return false;
      }
      // 日付だけの行は当日中が有効なので、終端側（tLast）で窓に触れているかを見る。
      if (!inRecommend && (r.dateOnly ? r.tLast < floor : r.t < floor)) {
        // 「過去の締切も表示」と併用したときの下限側。同じ窓の話なので上の計数とまとめる。
        hiddenCounts.window += 1;
        return false;
      }
      if (!inRecommend && state.kind && r.kind !== state.kind) {
        return false;
      }
      // ランクはグレード厳密比較（indexOf の部分一致だと A が core:A* に誤マッチする）
      if (!inRecommend && state.rank) {
        const rankHit = Rec
          ? Rec.rankMatches(r.rankPairs, state.rank)
          : r.rankPairs.indexOf(state.rank) >= 0;
        if (!rankHit) {
          // 評価は選択欄の表示が「A*」などの一語で、収まっているのか無いのかが見えない。
          // のぞいた件数を出さないと「収録に A* が少ない」と誤解する（国内・オンラインと
          // 同じ型の問題。2026-09-23 実測: 「A*」を選ぶと既定画面 477 行のうち 61 行だけ
          // 出て、のこり 416 行の話が件数欄になかった）。
          if (!inRecommend) hiddenCounts.rank += 1;
          return false;
        }
      }
      if (!inRecommend && state.domestic && (r.tags || []).indexOf("domestic-jp") < 0) {
        // 「国内研究会・国内シンポジウムのみ」は**主催の区分**で、日本で開かれる会議のことでは
        // ない。チェックしたままだと `Tokyo, 日本` のような行が黙って消えるので、
        // のぞいた件数を件数欄に出す（利用者が「日本で開かれる会議を見たい」に気づける形で）。
        if (!inRecommend) hiddenCounts.domestic += 1;
        return false;
      }
      // 開催形式は会場表記に書かれた記述だけで絞る（書かれていないことから対面を断定しない）。
      if (!inRecommend && state.online && !Recommender.placeOffersOnline(r.ed.place)) {
        // チェックを付けた人にとって「出ない理由」は 2 種類ある。
        // 会場表記に対面の記述しかない場合と、**開催地自体が未確認**で読みようがない場合。
        // 後者を区別しないと「オンライン参加が無い会議」と誤解して検索をやめてしまう
        // （実測: 既定画面 477 行でオンライン参加可は 15 件だけ、のぞく 462 件のうち
        // 110 件は開催地が空）。
        hiddenCounts.online += 1;
        if (!String(r.ed.place || "").trim()) hiddenCounts.onlinePlaceUnknown += 1;
        return false;
      }
      // 検索は正規化した語の AND 判定（全角入力・全角スペース・複数語に対応するため
      // 照合式は recommender の searchMatcher を単一正典にする）。
      if (!inRecommend && !matchesQuery(r.hay)) {
        return false;
      }
      return true;
    };

    hiddenCounts = {
      past: 0,
      est: 0,
      kind: 0,
      domestic: 0,
      online: 0,
      onlinePlaceUnknown: 0,
      window: 0,
      rank: 0,
      cats: 0,
    };
    catFacetCounts = {};
    let out: AppRow[] = pool.filter((r) => {
      if (!matchesExceptCats(r)) {
        return false;
      }
      // チップの件数: 分野の絞り込みを見る前の状態で数える。
      for (const cat of r.cats || []) {
        catFacetCounts[cat] = (catFacetCounts[cat] || 0) + 1;
      }
      if (!inRecommend && cats.length) {
        let hit = false;
        for (let i = 0; i < cats.length; i++) {
          if (r.cats.indexOf(cats[i]) >= 0) {
            hit = true;
            break;
          }
        }
        if (!hit) {
          // チップには分野ごとの件数が写るが、「選んだ分野で何行が出て、他が何行だったか」は
          // 件数欄に書かないと分からない。窓や評価と同じ型でのぞいた件数を出す
          // （のぞいた行数は「他の条件を通った行」の数えなので、チップの件数と足して
          // 全件にはならない）。
          if (!inRecommend) hiddenCounts.cats += 1;
          return false;
        }
      }
      r._boosted = false;
      return true;
    });

    if (pLines.length && Rec) {
      let semanticScores: Record<string, number> | null = null;
      if (semQuery && semEmbeddings) {
        const scores: Record<string, number> = {};
        const query = semQuery;
        const embeddings = semEmbeddings;
        out.forEach((r) => {
          const key = r.conf?.key;
          if (key && !Object.hasOwn(scores, key)) {
            scores[key] = Rec.semanticScore(key, query, embeddings, null);
          }
        });
        semanticScores = scores;
      }
      out = Rec.venueRecommendations(out, pLines, semanticScores, now, {
        venueCats: venueCats,
        fieldedLexical: true,
      })
        .filter((recommendation) => recommendation.fit.score >= 10)
        .map(
          (recommendation): AppRow => ({
            ...recommendation.row,
            _boosted: recommendation.boosted,
            _match: recommendation.match,
            _vocabScore: recommendation.fit.lexicalScore,
            _matchScore: recommendation.fit.score,
            _fitLabel: recommendation.fit.label,
            _lexicalRank: recommendation.fit.lexicalRank,
            _semanticRank: recommendation.fit.semanticRank,
            _semScore: recommendation.fit.semanticScore,
            _availability: recommendation.availability,
          }),
        );
    }

    /* 「過去の締切も表示」を入れると、既定の並び（残りの昇順）では 2019 年の行が画面の
     * 先頭になり、これからの締切が 2,318 行の下に沈んでいた（2026-09-23 実測: 収録 3,235 行の
     * うち締切時刻が過ぎた行が 2,318 行）。過ぎた行を後ろの塊に寄せる目印を先に置く。
     * 比較関数（抽出して検査する）の依存を増やさないため、計算はここでやる。 */
    if (state.past) {
      out.forEach((r) => {
        r._pastBlock = Number.isFinite(r.t) && r.t < now ? 1 : 0;
      });
    }

    // Custom Sorting
    out.sort((a, b) => {
      if (pLines.length && Rec) {
        return Rec.comparePapers(a, b, now);
      }
      const mult = sortAsc ? 1 : -1;
      if (sortKey === "conf") {
        // 会議名順は表に出る語で並べ、同じ名前の複数版（年違い）は締切時刻でそろえる。
        // ロケールを明示しないと、閲覧者の UI ロケールで日本語の並びが変わる
        // （実測: 既定＝自環境ロケールでは en/de と ja で「航空/情報」の順が入れ替わった）。
        // `"ja"` は漢字を読み（音読み）の五十音順に並べる collation。読み辞書を持たない
        // のでカタカナ語は漢字語より前の段に出る（異スクリプト間の段差は越えられない）。
        const cmp = conferenceNameCell(a).localeCompare(conferenceNameCell(b), "ja");
        return cmp ? cmp * mult : (a.tShown - b.tShown) * mult;
      } else if (sortKey === "event") {
        // 会期順（出張の計画は「いつ開かれるか」で見ることが多い）。未確認は末尾。
        return compareEventRows(a, b, mult);
      } else if (sortKey === "rank") {
        // 等級の点数で並べる（`rankSortKey` が正本）。`rankPairs` をそのまま文字列比較
        // すると体系名が先に効いて `ccf:C` が `core:A*` より前に来ていた。
        // 数値列と同じ約束で、降順がいちばん評価の高い行（A*）から出る。
        const ar = Recommender.rankSortKey(a.rankPairs);
        const br = Recommender.rankSortKey(b.rankPairs);
        const cmp = ar === br ? 0 : ar < br ? -1 : 1;
        // ランクが同じ行は締切の近い順（同じ評価の塊の中を読める順にする）。
        return cmp ? cmp * mult : compareDeadlineRows(a, b, mult);
      }
      // ここは「残り」「日時」の列を見ているときだけ通る。過ぎた締切の塊は、昇順・降順の
      // 向きに関係なく後ろに置く（塊の中は選んだ向きそのまま。降順で先頭に反転させると
      // 「いちばん遠い」ではなく「いちばん近い過去の締切」が画面の先頭になって誤解を招く）。
      const block = (a._pastBlock || 0) - (b._pastBlock || 0);
      if (block) return block;
      return compareDeadlineRows(a, b, mult);
    });

    return out;
  }

  // 月見出し行（.month-row）と推薦理由の行内展開（.detail-row）は shown[] と 1:1 にならない。
  // 選択・詳細・キーボード移動はこれらの行を数えない（off-by-one の再発防止）。
  // 日時順で見ているときだけ月で区切る。一致度順やランク順で区切ると、
  // 月が往復してかえって読めなくなる。
  /* SPEC §7: 絞り込み後の全行を表計算へ持ち出せるようにする。ページング後の表示分だけ
   * ではなく `shown` 全体を書き出す。Excel は BOM の無い UTF-8 を日本語として読めないため
   * BOM を付けて渡す（本文の区切りは recommender の deadlinesToCsv が単一正典）。 */
  function exportShownCsv() {
    const csv = Recommender.deadlinesToCsv(
      shown as unknown as Record<string, unknown>[],
      Date.now(),
    );
    if (typeof Blob === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) return;
    const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" }));
    /* ファイル名の日は JST にする。このサイトは「日時は JST で出しています」と宣言し、
     * 一覧の日付も JST 固定で計算しているのに、ここだけ端末の時刻合わせで出ていた
     * （2026-08-09 実測: 同じ瞬間に保存しても、UTC の端末では
     * `kamiyobi-deadlines-20260809.csv`、日本の端末では `kamiyobi-deadlines-20260810.csv`
     * に化けた。JST で 0 時台に保存する – 夜に締切をまとめたり出張先のホテルで
     * 端末を現地に合わせたり – ケースで日付が一日ずれる）。
     * JST のオフセットはインラインに置く（この関数はビルド成果物から抜き出して検査する
     * ので依存を増やさない。`remain`・`fmtJst` と同じ理由）。 */
    const stampDate = new Date(Date.now() + 9 * 3600000);
    const stamp = `${stampDate.getUTCFullYear()}${String(stampDate.getUTCMonth() + 1).padStart(2, "0")}${String(stampDate.getUTCDate()).padStart(2, "0")}`;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `kamiyobi-deadlines-${stamp}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    if (URL.revokeObjectURL) URL.revokeObjectURL(url);
  }

  /* SPEC §7: 0 件のとき、原因になりやすい条件をそのまま並べる。
   * 期間窓・過去非表示・「開催行は表に出さない」が重なると、収録が無いのだと
   * 誤解して離脱するため、いま外せる条件を実名で示す。*/
  function emptyDeadlineHint(filter: {
    window: string;
    past: boolean;
    cats: number;
    domestic: boolean;
    online: boolean;
    rank: string;
    kind: string;
    est: boolean;
    hidden: Record<string, number>;
    query: string;
    hiddenKindWords: string[];
    queryMatch: { catalog: number; journal: number };
    termCounts: Array<{ term: string; count: number }>;
    urlQuery: boolean;
    catalogConferences: number;
  }): string {
    /* 収録データその物が無いとき（データが差し込まれていない HTML を開いた、組み込みの
     * データを拡張機能が止めた等）は、条件の話をする前にそれを伝える
     * （2026-09-23 実測: 「該当する締切はありません。条件を緩めると出ます」と出ていて、
     * 緩めても何も出ない人に的外れの案内になっていた）。*/
    if (!filter.catalogConferences) {
      return (
        "締切のデータが入っていません。ページの読み込みに失敗している可能性があります。" +
        "時間をおいて再読み込みするか、サイトの一覧を開き直してください。"
      );
    }
    const base = "該当する締切はありません。";
    const trimmedQuery = filter.query.trim();
    /* 検索語が採否通知・査読結果公開など、表に出さない種別に当たっていることがある。
     * 外せる条件とは別枠の「なぜ 0 件か」なので、先に文として立てる。 */
    const kindNote = filter.hiddenKindWords.length
      ? ` 検索語は${filter.hiddenKindWords.map((w) => `「${w}」`).join("・")}の種別に当たります` +
        "（表には投稿締切だけを出します）。"
      : "";
    /* 検索語が収録データ全体では行に当たっているのに 0 件のとき（既定で出す行が
     * 投稿締切・未来だけなので起こる）。「 kamiyobi に無い」と誤解させない。 */
    /* URL を貼った人に、アドレスを「語」と呼んではいけない（読み上げでは数十文字の URL が
     * 語として読まれ、収録の範囲の話も伝わらない – 第 153 回で URL 検索を通した続き）。
     * 読み上げ側の `zeroResultLiveNote` と同じことを書く（画面と読み上げで噓が違うと
     * どちらも信じられなくなる）。 */
    // ドメインが収録に当たっている場合は「収録にあるが条件で消えている」が正しいので、
    // その場合はこの文を立てない（上の catalogNote が受け持つ）。
    const urlNote =
      filter.urlQuery && filter.queryMatch.catalog === 0
        ? " 検索語の URL の会議は収録に見当たりません。収録の中心はランク付けの一覧に載る会議と" +
          "国内研究会です。公式ページのアドレスではなく会議名（「ICDE」など）で試してください。"
        : "";
    const catalogNote =
      trimmedQuery && filter.queryMatch.catalog > 0
        ? (filter.urlQuery
            ? ` その URL のドメインは収録済みで ${countJa(filter.queryMatch.catalog)} 件に当たります`
            : ` 検索語「${trimmedQuery}」は収録済みで ${countJa(filter.queryMatch.catalog)} 件に当たります`) +
          "（表は投稿締切でこれから先のものだけを出す既定と、いまの絞り込みで 0 件になっています）。" +
          (filter.queryMatch.journal > 0
            ? ` 常時受付のジャーナル ${countJa(filter.queryMatch.journal)} 件は「種別」で選べます。`
            : "")
        : "";
    /* 語を並べて打ったのに 0 件のとき、どの語が足りなかったのかを言う（2026-09-23 実測:
     * 「ネットワーク 福岡 GPU」も「人工知能 だけ」も 0 件なのに、画面は原因の語を言わず
     * 「検索語を短くする」しか出さなかった）。収録データに無い語があればそれを名指す
     * （その語を待っても行は増えない）。語が全部当たっている場合は、すべてを含む行が
     * 無いだけなので語ごとの件数を示し、いずれかを外すよう導く。 */
    // URL の検索語を語に分解して「〜は収録データにも見当たりません」と言うのは誤解になる
    // （分解された語はドメインの一部で、検索の失敗理由ではない）。
    const terms = !filter.urlQuery && filter.termCounts.length > 1 ? filter.termCounts : [];
    const deadTerms = terms.filter((t) => t.count === 0).map((t) => t.term);
    let termNote = "";
    if (deadTerms.length) {
      termNote =
        ` 検索語のうち${deadTerms
          .slice(0, 2)
          .map((w) => `「${w}」`)
          .join("・")}は` + "収録データにも見当たりません。その語を外すと増えます。";
    } else if (terms.length > 1) {
      termNote =
        " 語をすべて含む行はありません（" +
        terms
          .slice(0, 3)
          .map((t) => `「${t.term}」${t.count}件`)
          .join("・") +
        "）。いずれかの語を外すと増えます。";
    }
    /* 原因を特定できたときは、他の説明文を足さない。考えられる理由を全部並べると
     * 「結局どうすればいい」が読めなくなる。検索語を短くする助言も、原因が分かっていれば
     * 的外れなので出さない。 */
    const specific = Boolean(kindNote || catalogNote || deadTerms.length || urlNote);

    /* 0 件案内はこれまで「外せる条件」の名前だけを並べていた。同じ画面上の件数欄は
     * 同じ条件で消えた件数を書いているのに、案内の側には数字が無く、6 項目のうち
     * どれから外す価値があるかが読めなかった（2026-09-23 実測: 窓を 7 日・評価を A* に
     * 絞って 0 件にした画面の案内は「外せる条件: …」の羅列だけだった）。
     * 件数欄と同じ名前の同じ数字を項目に添える – 「外せば増える」という約束ではなく、
     * 「いまこの条件で隠れている行数」なので、そのように書く。 */
    /* 案内の項目は「いまこの条件で隠れている行数」を添える。件数欄は同じ画面上で同じ
     * 条件の数字を内訳として書いているのに、案内の側には数字が無かった（2026-09-23 実測:
     * 窓を 7 日・評価を A* に絞った 0 件画面の案内は条件名の羅列だけで、どれから外す
     * 価値があるか読めなかった）。外せば増えるという約束ではなく、いま隠れている行数なので、
     * そのように書く。件数欄と同じ名前の同じ数字を使う（案内と件数欄が違う行の話をするのを防ぐ）。 */
    const tip = (text: string, key: string, label: string): void => {
      // 隠している行数が 0 の条件を勧めても、行は増えずに外し直しの手だけ増える
      // （件数欄に内訳として出ていない条件と同じ理屈）。
      const n = filter.hidden ? filter.hidden[key] || 0 : 0;
      if (!n) return;
      tips.push(`${text}（${label} ${countJa(n)} 件）`);
    };
    const tips: string[] = [];
    // 選択肢の実際のラベルを書く（「すべて」に変えた旧名を案内すると、その語が見つからない）。
    if (filter.window && filter.window !== "all")
      tip(
        "「締切まで」を「かまわない」に変更",
        "window",
        `「締切まで ${Number.parseInt(filter.window, 10)} 日以内」を超える`,
      );
    if (!filter.past) tip("「過去の締切も表示」をオン", "past", "過去の締切");
    // 推定は既定で出さない。0 件の画面でこれに触れないと、収録にある語を「無い」と
    // 誤解したまま検索をやめてしまう（件数欄は同じ数を「推定 N 件」として書いている）。
    if (!filter.est) tip("「推定締切を含める」をオン", "est", "推定");
    if (filter.cats > 0) tip("分野チップをはずす", "cats", "選んだ分野を持たない行");
    if (filter.domestic)
      tip(
        "「国内研究会・国内シンポジウムのみ」をオフ",
        "domestic",
        "国内研究会・国内シンポジウム以外",
      );
    if (filter.online)
      tip("「オンライン参加可のみ」をオフ", "online", "オンライン参加の記載がない");
    if (filter.rank && filter.rank !== "all")
      tip("ランクを「すべて」に変更", "rank", `評価「${filter.rank}」を持たない行`);
    // 種別も絞り込みである。これを数えないと、案内どおりに他を外しても 0 件のままになる。
    if (filter.kind) tip(`「種別」を「${KIND_ALL_LABEL_JA}」に変更`, "kind", "投稿締切以外の種別");
    if (trimmedQuery && !specific)
      tips.push("検索語を短くする（分野名・主題・開催地の日本語でも引けます）");

    const meetingNote = "開催日だけが確定している会議は表に出さず、upcoming.md に載せています。";
    if (specific) {
      return tips.length
        ? `${base}${kindNote}${catalogNote}${urlNote}${termNote} 外せる条件: ${tips.join(" / ")}。`
        : `${base}${kindNote}${catalogNote}${urlNote}${termNote}`;
    }
    if (!tips.length) return `${base}${termNote} ${meetingNote}`;
    return `${base}${termNote} 多いのは ${tips.join(" / ")}。${meetingNote}`;
  }

  /**
   * 会期の暦日表示。表の日付列と同じ書き方（暦日 + 曜日、時刻は付けない、
   * 同じ年会期で年を二度書かない）を案内とドロワーで共有する。
   */
  function meetingRangeJa(start: string, end: string): string {
    const startDay = Recommender.weekdayJaFromDate(start);
    let when = `${start}${startDay ? `(${startDay})` : ""}`;
    if (end && end !== start) {
      const endDay = Recommender.weekdayJaFromDate(end);
      const endHead = end.slice(0, 4) === start.slice(0, 4) ? "" : `${end.slice(0, 4)}-`;
      when += `〜${endHead}${end.slice(5)}${endDay ? `(${endDay})` : ""}`;
    }
    return when;
  }

  /** 同じ研究会のこれから先の会期（行になっている回を除く）。研究会は毎月開くので、
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
      // 会期が終わった回を出さない（開始日が今を向いていても終了日が過ぎていれば除外）。
      const endMs = Date.parse(`${String(ed.event_end || start)}T23:59:59+09:00`);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
      if (endMs < nowMs) continue;
      out.push({ start, end: String(ed.event_end || start), place: String(ed.place || "") });
    }
    return out.sort((a, b) => a.start.localeCompare(b.start)).slice(0, max);
  }

  /**
   * 0 件のとき、会期だけ確定している次回開催を案内する。締切が未定の会は表に載らない
   * （`upcoming.md` 側にしか出ない）ので、「検索語は合っているのに 0 件」をそのまま
   * 放置しない。表示する日程は表と同じく暦日 + 曜日で、時刻は付けない。
   */
  /* 会期だけが確定している回の形（表の行とは別物なので型も分けて持つ – 件数欄と 0 件の
   * 案内で同じ型を使い回す）。 */
  type ScheduleOnlyMatch = {
    name: string;
    eventStart: string;
    eventEnd: string;
    place?: string;
    link?: string;
  };

  /* いまの絞り込みで残る「会期だけが確定している会」を数える（表に出さないだけで、
   * 検索語・分野・国内・オンライン・締切までの窓は表と同じ目盛りで掛ける）。 */
  function scheduleOnlyMatches(filter: {
    window: string;
    cats: string[];
    domestic: boolean;
    online: boolean;
  }): ScheduleOnlyMatch[] {
    const now = Date.now();
    const limit = windowLimitMs(filter.window, now);
    const meetsQuery = Recommender.searchMatcher(searchQuery);
    return Recommender.scheduleOnlyEditions(DATA)
      .filter((m) => {
        if (searchQuery.trim() && !meetsQuery(m.hay)) return false;
        if (filter.domestic && m.tags.indexOf("domestic-jp") < 0) return false;
        if (filter.online && !Recommender.placeOffersOnline(m.place)) return false;
        if (filter.cats.length && !filter.cats.some((c) => m.cats.indexOf(c) >= 0)) return false;
        const startMs = Date.parse(`${m.eventStart}T00:00:00+09:00`);
        return Number.isFinite(startMs) && startMs >= now && startMs <= limit;
      })
      .sort((a, b) => a.eventStart.localeCompare(b.eventStart)) as unknown as ScheduleOnlyMatch[];
  }

  function renderNextMeetingNote(matches: ScheduleOnlyMatch[]): void {
    const box = $("emptyMeeting");
    if (!box) return;
    box.textContent = "";
    box.hidden = true;
    const found = matches.slice(0, 3);
    if (!found.length) return;
    const lead = document.createElement("strong");
    lead.textContent = "会期だけ確定している次回:";
    box.appendChild(lead);
    found.forEach((m, index) => {
      const sep = document.createTextNode(index === 0 ? " " : " / ");
      box.appendChild(sep);
      const label = document.createTextNode(`${meetingRangeJa(m.eventStart, m.eventEnd)} `);
      box.appendChild(label);
      if (m.link) {
        const a = document.createElement("a");
        a.href = m.link;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = m.name;
        box.appendChild(a);
      } else {
        box.appendChild(document.createTextNode(m.name));
      }
      if (m.place) {
        // 会期だけの会の開催地も、表と同じく日本語に寄せる（原文は title に残す）。
        const shownPlace = Recommender.placeJa(m.place);
        const placeNode = document.createElement("span");
        placeNode.textContent = ` ＠${shownPlace}`;
        if (shownPlace !== m.place) placeNode.title = String(m.place);
        box.appendChild(placeNode);
      }
    });
    /* 「upcoming.md に載せます」と言うだけだと、画面を読む人にはファイル名が打てない
     * （このファイルはこのサイトの同じ場所に有るので、押せば届く）。文章の中も押せる形に
     * する（外側の文章はそのまま – 読み上げで同じ語を二度読ませない）。 */
    box.appendChild(document.createTextNode(" 締切が未定の会は表に載せません（会期は"));
    const upcoming = document.createElement("a");
    upcoming.href = "upcoming.md";
    upcoming.textContent = "upcoming.md";
    /* md はマークダウンのまま配るので、ブラウザでは表に整形されない（実測: 配信先の
     * `content-type` は `text/markdown` で、ブラウザはこれを表として描画しない。記号が並んだ
     * 文章で見えるか、ダウンロードされる）。てびきの項と同じ説明を title に添える
     * （見出し文を長くして読み上げで同じ語を二度読ませないため）。 */
    upcoming.title =
      "マークダウンで書いた表なので、ブラウザでは表に整形されず、記号が並んだ文章として開くか、" +
      "そのままダウンロードされます（開き方はブラウザで違います）。表が見たいだけならこの画面の" +
      "一覧が早く、締切が未定で会期だけ決まっている会はこのファイルにしか載りません。";
    box.appendChild(upcoming);
    box.appendChild(document.createTextNode("にも掲載）。"));
    box.hidden = false;
  }

  /** 0 件時に「条件をまとめて外す」を出すべきか（既に全部外れていれば出さない）。 */
  function filtersClearable(filter: {
    window: string;
    cats: number;
    domestic: boolean;
    online: boolean;
    rank: string;
    kind: string;
    est: boolean;
    query: string;
  }): boolean {
    return Boolean(
      (filter.window && filter.window !== "all" && filter.window !== "") ||
        filter.cats > 0 ||
        filter.domestic ||
        filter.online ||
        (filter.rank && filter.rank !== "all" && filter.rank !== "") ||
        // 種別だけを掛けた状態で 0 件になった人に「外せる条件はありません」と言わない。
        filter.kind ||
        // 「推定締切を含める」も外せる条件である（0 件案内が並べる項目と同じにする。
        // 2026-09-23 の収録では推定だけを入れて 0 件になることが起きないため、
        // 今日は画面で踏めないが、案内と数え上げをズレさせない）。
        filter.est ||
        filter.query.trim(),
    );
  }

  function shouldGroupMonths(grouping: {
    sortKey: string | null;
    sortAsc: boolean;
    paper: boolean;
  }): boolean {
    if (grouping.paper) return false;
    if (!grouping.sortAsc) return false;
    return !grouping.sortKey || grouping.sortKey === "rem" || grouping.sortKey === "date";
  }

  // 月キーは JST で決める（表示が JST なので、表示と違う単位で区切ると迷う）。
  function monthKey(r: AppRow): string {
    if (r.kind === "journal") return "";
    // 月も「画面に出している暦日」で決める。幅を持つ行は `t` が締切の最も早い瞬間なので、
    // それを見ると表示している暦日と違う月に入ることがある（残り・並びと同じ基準）。
    const basis = Number.isFinite(r.tShown) ? r.tShown : r.t;
    if (!Number.isFinite(basis)) return "";
    const jst = new Date(basis + 9 * 3600000);
    return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}`;
  }

  function monthHeading(key: string, count: number): string {
    const parts = key.split("-");
    return `${parts[0]}年${Number(parts[1])}月（${countJa(count)} 件）`;
  }

  function makeMonthRow(key: string, count: number) {
    const tr = document.createElement("tr");
    tr.className = "month-row";
    const th = document.createElement("th");
    th.colSpan = TABLE_COLUMNS_JA;
    th.scope = "colgroup";
    th.textContent = monthHeading(key, count);
    tr.appendChild(th);
    return tr;
  }

  /* 過ぎた締切の塊の先頭に出す見出し行。月見出しと同じ `month-row` を併せ持つ
   * （支援技術のコラム対応と同じにしておかないと、列を跨ぐ行として読まれない）。 */
  function makeSectionRow(label: string, count: number) {
    const tr = document.createElement("tr");
    tr.className = "month-row section-row";
    const th = document.createElement("th");
    th.colSpan = TABLE_COLUMNS_JA;
    th.scope = "colgroup";
    th.textContent = `${label}（${countJa(count)} 件）`;
    tr.appendChild(th);
    return tr;
  }

  // ---- RENDERING ----
  let shown: AppRow[] = [];
  let drawn = 0;
  // 推薦カード側の描画進捗（「さらに表示」を表と同じボタンで共有するため分けて持つ）。
  let cardsDrawn = 0;
  let recommendationList: AppRow[] = [];
  // 月見出しの描画条件と、描画対象における月ごとの件数（見出しの「N 件」用）。
  let groupMonths = false;
  let monthCounts: Record<string, number> = {};
  let lastMonthKey = "";
  // 過ぎた締切の塊の件数と、ページ末尾で出していた見出し（「さらに表示」で繰り返さない）。
  let pastBlockTotal = 0;
  let lastPastBlock = -1;

  function td(tr: HTMLTableRowElement, label: string, cls = "") {
    const e = document.createElement("td");
    if (label) {
      e.setAttribute("data-label", label);
    }
    if (cls) {
      e.className = cls;
    }
    tr.appendChild(e);
    return e;
  }

  function line(parent: HTMLElement, text: string | number | null | undefined, cls = "") {
    if (!text) {
      return null;
    }
    const d = document.createElement("div");
    if (cls) {
      d.className = cls;
    }
    d.textContent = String(text);
    parent.appendChild(d);
    return d;
  }

  function verificationAlert(status: string | undefined): string | null {
    if (!status || status === "verified") return null;
    if (status === "changed") return "変更を検出";
    if (status === "source-unreachable") return "公式ページ取得不能";
    if (status === "manual-required" || status === "parser-failed") return "複数候補のため要確認";
    return "再確認待ち";
  }

  function makeRow(r: AppRow) {
    const tr = document.createElement("tr");
    tr.tabIndex = -1; // スクリプトからのフォーカス受付（ドロワー開閉時のフォーカス復元先）
    tr.onclick = (event: MouseEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.classList.contains("match-trigger")) {
        toggleDetail(r, tr);
        return;
      }
      /* 行の文字をドラッグして選んだ人（会議名・会場・公式ページの名前をコピーしたかった）
       * にもドロワーが開いていた（2026-09-23 実測: リンクと一致評価の目印以外では必ず開く
       * 書き方で、`getSelection` の参照はビルド成果物に 1 件も無かった）。選んだ物が
       * ドロワーと背景に隠れて、コピーしたい文字が消える。選択しているときは開かない。
       * 選択がこの行のなかにあるときだけ止める（他所に残った選択を理由に、いま押した行を
       * 開かないのは別の不親切になる）。 */
      const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
      if (selection && !selection.isCollapsed && String(selection.toString()).trim()) {
        if (tr.contains(selection.anchorNode)) return;
      }
      if (target?.tagName !== "A") {
        openDrawer(r);
      }
    };
    const dateState = rowDateOnlyState(r, Date.now());
    let rem = r.dateOnly
      ? dateState === "definitely-past"
        ? { text: "締切日経過", cls: "past" }
        : dateState === "uncertain-on-date"
          ? { text: "締切日です（終了済みの可能性あり）", cls: "today" }
          : { text: "時刻未確認", cls: "" }
      : remain(r.tShown);
    // 常時受付ジャーナルは締切の概念がないため「本日終了」等の誤解を与えない表示にする
    if (r.kind === "journal") {
      rem = { text: "常時受付", cls: "" };
    }

    const c0 = td(tr, "残り", "c-deadline");
    line(c0, rem.text, `left ${rem.cls}`);

    const c1 = td(tr, "日時（JST）");
    if (r.kind === "journal") {
      // 種別セル・CSV・詳細・てびきと同じ語に寄せる（1 行の中で 2 つの名前が見えると
      // 別のものだと誤解する）。
      line(c1, "常時受付", "nowrap");
    } else if (r.dateOnly) {
      // 暦日だけ分かっている締切でも、動作計画は曜日で見込むので曜日を添える。
      const dateOnlyDay = Recommender.weekdayJaFromDate(r.localDate);
      line(c1, dateOnlyDay ? `${r.localDate}(${dateOnlyDay})` : r.localDate, "nowrap");
      line(c1, "時刻未確認", "sub nowrap");
    } else {
      const d = new Date(r.t);
      // JST を主表記にする。AoE 23:59 締切は JST では翌日の夜になるため、
      // UTC 優先だと日本で何時までに提出すればよいか判定できない。
      // 2 行目は公式ページの表記。AoE 併記は AoE で締切る会議だけに出す
      // （JST 宣言の国内締切に AoE を見せると、実在しない AoE 締切があると誤解させる）。
      line(c1, fmtJst(d), "nowrap");
      const zone = Recommender.officialZone(r.dl);
      let sub = `${fmtDate(d)} UTC`;
      if (zone === "JST") sub = "公式 JST 締切";
      else if (zone === "AoE") sub = `公式 ${fmtAoE(d)}`;
      else if (zone && zone !== "UTC") sub = `公式 ${zone} ／ ${fmtDate(d)} UTC`;
      line(c1, sub, "sub nowrap");
    }

    const c2 = td(tr, "会議");
    const head = document.createElement("div");
    head.className = "conf";
    const name = conferenceNameCell(r);
    const href = safeExternalUrl(r.ed.link || r.conf.link);
    if (href) {
      const a = document.createElement("a");
      a.href = href;
      a.textContent = name.trim();
      a.rel = "noopener noreferrer";
      a.target = "_blank";
      head.appendChild(a);
    } else {
      head.textContent = name.trim();
    }
    c2.appendChild(head);
    if (r.conf.full_name && r.conf.full_name !== r.conf.title) {
      line(c2, r.conf.full_name, "sub");
    }
    const tags = document.createElement("div");
    r.cats.forEach((k) => {
      const s = document.createElement("span");
      s.className = "tag";
      s.textContent = catLabel(k);
      tags.appendChild(s);
    });
    if (r._matchScore && r._matchScore >= 10) {
      // match-trigger: 行内展開（この会議が選ばれた理由の内訳）。
      // `<span>` + `onclick` だとキーボードで開けなかった（Tab で届かず、行の Enter は
      // ドロワーを開くので理由の内訳に到達できない。2026-09-23 実測: ビルド成果物に
      // `aria-expanded` は 1 箇所も無く、トリガは span）。ボタンにして開閉状態を出す。
      const ms = document.createElement("button");
      ms.type = "button";
      ms.className = "tag match match-trigger";
      ms.setAttribute("aria-expanded", "false");
      ms.textContent = `一致評価 ${r._fitLabel || "評価保留"} ▾`;
      if (r._match?.agg) {
        const agg = r._match.agg;
        const parts: string[] = [];
        if (agg.domain > 0) parts.push(`分野の一致 +${agg.domain}`);
        if ((agg.venueName || 0) > 0) parts.push(`会議名一致 +${agg.venueName}`);
        if (agg.paper > 0) parts.push(`採択論文一致 +${agg.paper}`);
        if (agg.jp > 0) parts.push(`日本語一致 +${agg.jp}`);
        if (agg.tags > 0) parts.push(`主題の一致 +${agg.tags}`);
        if (agg.venue > 0) parts.push("過去掲載先一致");
        if ((r._semScore ?? 0) > 0) parts.push(`意味の近さ ${r._semScore}点`);
        if (parts.length) ms.title = parts.join(" ／ ");
      }
      tags.appendChild(ms);
    }
    if (r._match?.venueHit) {
      const vh = document.createElement("span");
      vh.className = "tag match";
      vh.textContent = "過去掲載先一致";
      tags.appendChild(vh);
    }
    if (r.est) {
      const es = document.createElement("span");
      es.className = "tag est";
      es.textContent = "推定";
      tags.appendChild(es);
    }
    // 締切が延びていたことは、一覧に出さないと分からない（2026-09-23 実測: 上流の締切名に
    // "Extended" と付く 30 行が、画面では他の行と区別が無く、検索も英語でしか引けなかった）。
    if (Recommender.isExtendedDeadline(r.dl)) {
      const xs = document.createElement("span");
      xs.className = "tag est";
      xs.textContent = Recommender.extendedLabelJa();
      tags.appendChild(xs);
    }
    const verificationTag = verificationAlert(r.dl.verification?.status);
    if (verificationTag) {
      const vs = document.createElement("span");
      vs.className = "tag est";
      vs.textContent = verificationTag;
      tags.appendChild(vs);
    }
    if (r.kind === "journal") {
      const jr = document.createElement("span");
      jr.className = "tag match";
      jr.textContent = "常時受付";
      tags.appendChild(jr);
    } else if (rowIsPast(r, Date.now())) {
      const pp = document.createElement("span");
      pp.className = "tag past";
      pp.textContent = "締切済み（次回予定）";
      tags.appendChild(pp);
    }
    if ((r.tags || []).indexOf("domestic-jp") >= 0) {
      const dj = document.createElement("span");
      dj.className = "tag";
      dj.textContent = "国内";
      tags.appendChild(dj);
    }
    if (tags.childNodes.length) {
      c2.appendChild(tags);
    }

    const c3 = td(tr, "種別");
    line(c3, (KIND_LABEL[r.kind] || r.kind) + (r.dupLabel ? `: ${r.dupLabel}` : ""));
    const detail = kindDetailJa(r.dl.round, r.dl.label);
    if (detail) {
      line(c3, detail, "sub");
    }

    const c4 = td(tr, "ランク");
    if (r.rankPairs.length) {
      r.rankPairs.forEach((p) => {
        const e = document.createElement("span");
        e.className = "tag";
        // 内部トークンの `N` をそのまま出さない（表・ドロワーで同じ語を使う）。
        e.textContent = Recommender.rankPairLabelJa(p);
        if (e.textContent.indexOf(RANK_UNRATED_JA) >= 0) {
          e.title = RANK_UNRATED_TITLE_JA;
        }
        c4.appendChild(e);
      });
    } else {
      const rankCell = line(c4, UNCONFIRMED_JA, "sub");
      if (rankCell) rankCell.title = UNCONFIRMED_TITLES_JA.rank;
    }

    const c5 = td(tr, "会期");
    const eventNa = Recommender.fieldNotApplicableJa(r);
    // 会期の式は一覧・行の詳細・CSV で `eventCellJa` を共有する。ここで別の式を持つと
    // 行の詳細だけ公式ページの原文（英語）になった（SPEC §7）。
    const span = Recommender.eventCellJa(r) || (eventNa ? NOT_APPLICABLE_JA : UNCONFIRMED_JA);
    const spanCell = line(c5, span, "sub nowrap");
    if (spanCell && span === UNCONFIRMED_JA) spanCell.title = UNCONFIRMED_TITLES_JA.event;
    if (spanCell && eventNa) spanCell.title = Recommender.notApplicableTitleJa("event");

    const c6 = td(tr, "開催地");
    const placeShown = Recommender.placeJa(r.ed.place);
    const placeNa = Recommender.fieldNotApplicableJa(r);
    const placeCell = line(c6, placeShown || (placeNa ? NOT_APPLICABLE_JA : UNCONFIRMED_JA), "sub");
    if (placeCell && !placeShown && placeNa) {
      placeCell.title = Recommender.notApplicableTitleJa("place");
    }
    if (placeCell) {
      // 日本語化は流し読み用。会場名・市区郡を含む原文は title に落とす。
      if (placeShown && placeShown !== r.ed.place) placeCell.title = String(r.ed.place || "");
      else if (!placeShown) placeCell.title = UNCONFIRMED_TITLES_JA.place;
    }

    return tr;
  }

  // ---- 推薦理由の行内展開（一致評価タグのクリックで開閉） ----
  function esc(s: unknown) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function safeExternalUrl(value: unknown) {
    return Recommender.safeExternalUrl(value);
  }

  function verificationSummary(dl?: DeadlineRecord) {
    /* 行の詳細の「公式確認」に出る語は、収録データの内部表記のまま見せない（2026-08-09 実測:
     * ビルド後のデータで `source_class` が `unknown` の締切が 236 件あり「確認元: unknown」と
     * 出ていた。`verifiedFields` は `date・kind・round` のような内部の項目名でそのまま
     * 出ていた（項目その物が無いときの既定値は「日付・時刻・タイムゾーン」と日本語なので、
     * 同じ欄の中で日本語と機械の表記が混ざっていた）。知らない語を勝手に翻訳しない –
     * 中身を推測して書くほうが悪いので、そのまま出す。
     * （下の語彙表はこの関数の内側にある。検査が関数ごと抜き出して実行できる形に
     * 保っておくため – 外に出すと抜き出した側で参照が切れる）。 */
    /* 「分からない」を出す語は 未確認 / 該当なし / 評価なし に揃える画面の約束がある
     * （`recommendationAvailability` の comment と、てびきの「未確認」の項）。
     * 第 159 回ではここに `不明` を入れてしまった（2026-08-09 実測: ビルド後の app.js で
     * 利用者に出る 「不明」 はこの 1 箇所だけで、てびきに無い語だった – 同じ種の欠陥が
     * 2026-09-23 にも記録されている: カードだけが「受付状況不明」と出て直している）。
     * てびきの語に寄せる。 */
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
     * （実測で `deadline-text-window` 3 件・`table-row:deadline` 2 件）。確認範囲では
     * ないので、読み方を訳せる物だけ訳して出す。 */
    const VERIFY_SELECTOR_LABELS_JA: Record<string, string> = {
      "deadline-text-window": "本文中の締切の記述",
      "table-row:deadline": "公式ページ内の表の締切欄",
    };

    const verifiedFieldsJa = (list: readonly unknown[]): string =>
      list.map((item) => VERIFY_FIELD_LABELS_JA[String(item)] || String(item)).join("・");

    const fieldsJa = (
      verified: readonly unknown[] | null | undefined,
      selector: unknown,
    ): string => {
      if (Array.isArray(verified)) return verifiedFieldsJa(verified);
      const name = typeof selector === "string" ? selector.trim() : "";
      if (!name) return "日付・時刻・タイムゾーン";
      const label = VERIFY_SELECTOR_LABELS_JA[name];
      return label ? `${label}（公式ページの読み取り箇所）` : `機械の判定名のまま: ${name}`;
    };

    const verification = dl?.verification;
    if (!verification) return "";
    const statusLabels: Record<string, string> = {
      verified: "確認済み",
      pending: "再確認待ち",
      changed: "変更を検出",
      retryable: "再試行待ち",
      "source-unreachable": "公式ページ取得不能",
      "parser-failed": "複数候補のため要確認",
      "manual-required": "複数候補のため要確認",
    };
    /* 日時はこの画面の他の場所と同じ JST で出す。表のヘッダーは「日時は JST で出しています」
     * と書いてあり、一覧の日時は `fmtJst` が +09:00 固定で計算している。一方ここは
     * `toLocaleString("ja-JP")` だった – これは**利用者の端末の時刻合わせ**で変わる
     * （2026-08-09 実測: `2026-08-01T18:30:00Z` が TZ=UTC では `2026/8/1 18:30:00`、
     * TZ=Asia/Tokyo では `2026/8/2 3:30:00`、TZ=America/Los_Angeles では
     * `2026/8/1 11:30:00` になり、次回確認予定は日付その物が一日ずれる
     * `2026/8/9 21:00` と `2026/8/10 6:00` の差になった）。会議への出張先で端末の時計を
     * 現地に合わせる人は珍しくなく、そのとき行の表と行の詳細が同じ会議について違う
     * 日時を書くことになる。`toLocaleString` は区切りの実装差でも既に避けることにして
     * ある（上の `countJa` の comment と同じ理由）。
     * 下の計算は `fmtJst` と同じ式をこの関数の内側に置いたもの – 検査がこの関数だけを
     * `new Function` で抜き出して実行できる形を保つため（語彙表と同じ理由で、第 159 回で
     * 実際に検査が切れた）。上の検査が `fmtJst` との結果の一致を見ている。 */
    const jstStamp = (value: string): string => {
      const d = new Date(value);
      if (!Number.isFinite(d.getTime())) return `読み取り不能（原文: ${value}）`;
      const jst = new Date(d.getTime() + 9 * 3600000);
      const p = (n: number): string => String(n).padStart(2, "0");
      const weekday = ["日", "月", "火", "水", "木", "金", "土"][jst.getUTCDay()];
      // `fmtJst` と同じ並び（`2026-08-02(日) 03:30 JST`）を、内側で組み立てる。
      return `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())}(${weekday}) ${p(
        jst.getUTCHours(),
      )}:${p(jst.getUTCMinutes())} JST`;
    };

    const evidence = (dl.evidence ?? []).find(
      (item) => item.verifiedFields ?? item.verified_fields,
    );
    const verified = evidence?.verifiedFields ?? evidence?.verified_fields;
    const fields = fieldsJa(
      Array.isArray(verified) ? verified : null,
      verification.selector_or_field,
    );
    const verifiedAt = verification.last_verified_at
      ? jstStamp(verification.last_verified_at)
      : "未確認";
    return (
      '<div class="verification-summary"><b>公式確認</b> ' +
      esc(verifiedAt) +
      "<br><b>確認元</b> " +
      esc(
        VERIFY_SOURCE_LABELS_JA[verification.source_class || ""] ||
          verification.source_class ||
          "公式",
      ) +
      "<br><b>確認範囲</b> " +
      esc(fields) +
      "<br><b>状態</b> " +
      esc(statusLabels[verification.status || ""] || verification.status || "未確認") +
      (verification.next_check_at
        ? `<br><b>次回確認予定</b> ${esc(jstStamp(verification.next_check_at))}`
        : "") +
      "</div>"
    );
  }

  function makeDetailRow(r: AppRow) {
    const tr = document.createElement("tr");
    tr.className = "detail-row";
    const td = document.createElement("td");
    td.colSpan = TABLE_COLUMNS_JA;
    const m: ScoreBreakdown | undefined = r._match;
    const agg = m?.agg ?? { domain: 0, name: 0, paper: 0, jp: 0, tags: 0, venue: 0 };
    let lines: PaperRecord[] = [];
    const paperText = valueElement("paperText").value;
    if (paperText.trim()) {
      lines = Recommender.parsePaperLines(paperText);
    }

    /* 内訳の chips は「当たった要素」の名前だけを出す（2 番目の欄は順位などの
     * 実数があるときだけ埋める）。以前は `+18` のような数字を並べていたが、それは
     * 手作業で決めた信号重み（`SIG_WEIGHTS`）で、**画面に出すスコアとは別の計算**だった
     * （スコアは各項目の順位の融合 + 会議名一致 + 分野の推定で決まる – 2026-09-23 実測:
     * 「一致スコア 65点」の行の内訳の数字は 18 + 9 が並ぶだけで合計 27、63 点的な行は
     * 合計 21、59 点的な行は合計 57）。`+` 付きの数字は足して読むものに見えるため、
     * 画面の噓になっていた。当たり外れだけが本当に分かる形にする。 */
    const chips: Array<[string, string, string]> = [];
    if (agg.domain > 0)
      chips.push([
        "分野の一致",
        "",
        "会議の分野と論文のキーワードが一致（HPC・AI・セキュリティなど）",
      ]);
    if ((agg.venueName || 0) > 0)
      chips.push(["会議名一致", "", "会議名の内容語が論文タイトル・キーワードに含まれる"]);
    if (agg.paper > 0)
      chips.push(["採択論文一致", "", "この会議で採択された論文に使われた語と一致"]);
    if (agg.jp > 0) chips.push(["日本語一致", "", "日本語の会議名・論文語が一致"]);
    if (agg.tags > 0)
      chips.push(["主題の一致", "", "会議の主題（real-time など）が論文に書かれている"]);
    if (agg.venue > 0)
      chips.push([
        "過去掲載先一致",
        "補助",
        "過去にこの掲載先への投稿が確認されている（主題の一致とは別の補助情報）",
      ]);
    if ((r._semScore ?? 0) > 0)
      chips.push([
        "意味検索の候補",
        /* 順位は上位の候補にだけ付く（近さを示す点は上位以外にも付く）。横棒の記号で
         * 誤魔化さず語で書く。このサイトの「分からない」は 未確認 / 該当なし / 評価なし
         * の語で出すことにしていて、記号は使わない（2026-08-09 実測: ビルド後の
         * `app.js` に U+2014 の横棒が 2 箇所残り、候補を 200 件出した画面で 44 件が
         * 「順位 —」になっていた）。 */
        r._semanticRank ? `順位 ${r._semanticRank}` : "順位は出ていません",
        "意味検索（文の意味の近さで探す検索）の順位も、順序決めに使う",
      ]);
    if (r._boosted)
      chips.push(["同じ分野（掲載先から推定）", "", "掲載先から推定した分野とこの会議が一致"]);
    if (!chips.length)
      chips.push(["目立つ一致はない", "", "一致の数は少ないが、表示の下限は超えている"]);

    let html = '<div class="detail-inner">';
    html +=
      '<div class="detail-head">一致評価 ' +
      esc(r._fitLabel || "評価保留") +
      " の内訳（この会議で当たった要素）</div>";
    let comp: string;
    if (r._semanticRank) {
      /* 語彙検索の順位は、言葉が重なった候補にだけ付く（語彙の点が 0 の行には付かない）。
       * 意味検索で見つかる行は語彙の点が 0 ことがあり（2026-08-09 実測: 候補 200 件中
       * 3 件。例 `cade` は語彙 0 点・意味の近さ 0.899 で意味検索 1 位）、その行で
       * 「言葉の一致（語彙検索）で — 位」と横棒を出していて、順位が無いのか値が壊れたのか
       * 読めなかった。
       * 語彙の点はその行に実際に出ている値なので、それをそのまま書く（記号で潰さない）。 */
      const lexicalJa = r._lexicalRank
        ? `言葉の一致（語彙検索）で ${r._lexicalRank} 位`
        : `言葉の一致（語彙検索）では ${r._vocabScore} 点で順位は無く`;
      comp =
        lexicalJa +
        "、意味検索で " +
        r._semanticRank +
        " 位 → 合わせて 一致評価 " +
        esc(r._fitLabel || "評価保留");
    } else if (semState === "loading") {
      comp = `言葉の一致スコア ${r._vocabScore}点（意味検索を実行中…）`;
    } else if (semState === "error") {
      comp = `言葉の一致スコア ${r._vocabScore}点（意味検索が使えないため、言葉の一致だけで順位を決めています）`;
    } else {
      comp = `言葉の一致スコア ${r._vocabScore}点`;
    }
    html +=
      '<div class="detail-comp">' +
      comp +
      (m?.evidence?.some((evidence) => evidence.rank) ? "（2つの検索の順位を合わせて集約）" : "") +
      "</div>";
    html +=
      '<div class="reason-chips">' +
      chips
        .map(
          (chip) =>
            '<span class="reason-chip" title="' +
            esc(chip[2]) +
            '"><b>' +
            esc(chip[0]) +
            "</b>" +
            // 順位など実数がある項目だけ値を出す（空の <em> は空白の塊に見える）。
            (chip[1] ? "<em>" + esc(chip[1]) + "</em>" : "") +
            "</span>",
        )
        .join("") +
      "</div>";

    if (lines.length > 1) {
      html += '<div class="perline">';
      for (let i = 0; i < lines.length; i++) {
        const p = lines[i];
        const pl = m?.perLine?.[i];
        const sc = pl ? pl.score : 0;
        const parts: string[] = [];
        if (pl) {
          if (pl.details.domain > 0) parts.push(`分野 +${pl.details.domain}`);
          if (pl.details.name > 0) parts.push(`会議名 +${pl.details.name}`);
          if (pl.details.paper > 0) parts.push(`採択論文 +${pl.details.paper}`);
          if (pl.details.jp > 0) parts.push(`日本語 +${pl.details.jp}`);
          if (pl.details.tags > 0) parts.push(`タグ +${pl.details.tags}`);
          if (pl.details.venue > 0) parts.push("過去掲載先");
        }
        html +=
          '<div class="perline-item">' +
          '<span class="perline-idx">' +
          (i + 1) +
          "</span>" +
          '<span class="perline-title">' +
          esc(p.title || "") +
          "</span>" +
          '<span class="perline-score">' +
          sc +
          "点</span>" +
          (pl?.venueHit
            ? '<span class="perline-venue">過去掲載先一致' +
              (p.venue ? ` (${esc(p.venue)})` : "") +
              "</span>"
            : "") +
          (parts.length ? `<span class="perline-parts">${parts.join(" ・ ")}</span>` : "") +
          "</div>";
      }
      html += "</div>";
    }
    html += verificationSummary(r.dl);
    html += "</div>";
    td.innerHTML = html;
    tr.appendChild(td);
    return tr;
  }

  function toggleDetail(r: AppRow, tr: HTMLTableRowElement) {
    const next = tr.nextElementSibling;
    // 開閉を支援技術に伝える（行そのものは `detail-row` の追加・削除で分かるが、
    // トリガの状態が分からないと「押せる物」だと気づけない）。
    const setExpanded = (open: boolean) => {
      const trigger = tr.querySelector<HTMLElement>(".match-trigger");
      if (trigger && trigger.tagName === "BUTTON") {
        trigger.setAttribute("aria-expanded", String(open));
      }
    };
    if (next && (next.classList.contains("detail-row") || next.classList.contains("month-row"))) {
      next.remove();
      setExpanded(false);
      return;
    }
    tr.parentNode?.insertBefore(makeDetailRow(r), tr.nextSibling);
    setExpanded(true);
  }

  /** 「さらに表示」のラベル（残り件数を出す。表と推薦カードで同じ形にする）。 */
  function moreButtonLabel(drawnCount: number, total: number): string {
    return `さらに表示 (残り ${countJa(total - drawnCount)} 件)`;
  }

  /** 「さらに表示」の表示可否とラベルを、描画済み件数と総数からそろえる。 */
  function updateMoreButton(drawnCount: number, total: number) {
    const btn = $("more");
    if (drawnCount < total) {
      btn.hidden = false;
      btn.textContent = moreButtonLabel(drawnCount, total);
    } else {
      btn.hidden = true;
    }
  }

  /** 「さらに表示」を推薦カードで押したとき: 次の 20 件を足す（表と違い作り直しは不要）。 */
  function drawMoreCards() {
    const cards = $("recommendationCards");
    const now = Date.now();
    const end = Math.min(cardsDrawn + RECOMMENDATION_PAGE, recommendationList.length);
    for (let i = cardsDrawn; i < end; i += 1) {
      cards.appendChild(makeRecommendationCard(recommendationList[i], now));
    }
    cardsDrawn = end;
    updateMoreButton(cardsDrawn, recommendationList.length);
  }

  function drawMore() {
    // 推薦モードでは表が出ていない。同じボタンでカードの続きを出す。
    if (!$("recommendationCards").hidden) {
      drawMoreCards();
      return;
    }
    const tbody = $("tbody");
    const frag = document.createDocumentFragment();
    const end = Math.min(drawn + PAGE, shown.length);
    for (let i = drawn; i < end; i++) {
      if (groupMonths) {
        const key = monthKey(shown[i]);
        // 前のページ末尾と同じ月の行なら見出しは繰り返さない。
        if (key && key !== lastMonthKey) {
          frag.appendChild(makeMonthRow(key, monthCounts[key] || 0));
        }
        lastMonthKey = key;
      }
      // 過ぎた締切を表示に含めるときは、塊の切り替わりに見出しを出す（件数が分かれて
      // いるのに理由が分からない行の壁にしないため。SPEC §7）。
      if (pastBlockTotal > 0 && pastBlockTotal < shown.length) {
        const block = shown[i]._pastBlock || 0;
        if (block !== lastPastBlock) {
          frag.appendChild(
            makeSectionRow(
              block ? "過ぎた締切" : "これからの締切",
              block ? pastBlockTotal : shown.length - pastBlockTotal,
            ),
          );
          lastPastBlock = block;
        }
      }
      frag.appendChild(makeRow(shown[i]));
    }
    tbody.appendChild(frag);
    drawn = end;
    updateMoreButton(drawn, shown.length);
  }

  function recommendationAvailability(r: AppRow) {
    const a = r._availability;
    // 画面の「分からない」の語は 未確認 / 該当なし / 評価なし に揃えてある（てびきの
    // 「空欄の出し方」に同じ約束を書いている）。カードだけが「不明」を出していた
    // （2026-09-23 実測: 「受付状況不明」。てびきにも出てこない語だった）。
    if (!a) return `受付状況${UNCONFIRMED_JA}`;
    if (a.status === "ongoing") return "常時受付";
    // 日付の向きは表と揃える（JST を主表記、曜日を添える、公式の表記は副で出す）。
    // カードだけ UTC 主表記だった（2026-09-23 実測: 「次回締切: 2026-10-05 23:59 UTC /
    // 2026-10-05 15:59 AoE」）。AoE 23:59 締切は JST では翌日の夜になるので、UTC 優先だと
    // 日本で何時までに出せばよいか決められない。表は第 65 回から JST を主にしている。
    const dayJa = (date: string) => {
      const weekday = Recommender.weekdayJaFromDate(date);
      return weekday ? `${date}(${weekday})` : date;
    };
    if (a.status === "uncertain" && a.local_date) {
      return `次回締切: ${dayJa(a.local_date)}（時刻未確認。終了済みの可能性があります）`;
    }
    if (a.status === "open" && a.local_date) {
      return `次回締切: ${dayJa(a.local_date)}（時刻未確認）`;
    }
    if (a.status === "open" && a.timestamp) {
      const d = new Date(a.timestamp);
      const zone = Recommender.officialZone(r.dl);
      // AoE 併記は AoE で締切る会議だけに出す（表と同じ理由。JST 宣言の締切に AoE を
      // 見せると、実在しない AoE 締切があると誤解させる）。
      const official =
        zone === "JST"
          ? "（公式 JST 締切）"
          : zone === "AoE"
            ? `（公式 AoE ${fmtAoE(d)}）`
            : zone && zone !== "UTC"
              ? `（公式 ${zone} ／ ${fmtDate(d)} UTC）`
              : `（公式 ${fmtDate(d)} UTC）`;
      return "次回締切: " + fmtJst(d) + official + (a.estimated ? "（推定）" : "");
    }
    if (a.status === "past") {
      return a.timestamp || a.local_date ? "締切済み" : "締切済み（次回情報なし）";
    }
    // 受け付け中なのに次回の日付が出ていない行がある（表の「時刻未確認」より情報が薄い）。
    // ここで「受付状況が分かりません」と言うと、受け付けていることまで分からないので、
    // 分からない部分だけを書く。
    if (a.status === "open") return `次回締切の日付が${UNCONFIRMED_JA}`;
    return `受付状況${UNCONFIRMED_JA}`;
  }

  const trustLabel: Record<string, string> = {
    official: "公式確認",
    publisher: "出版社確認",
    "curated-manual": "手動確認",
    aggregator: "集約情報",
    assumption: "推定",
    unverified: "未確認",
  };
  /* 推薦カードの「取得状態」に出る語。`キャッシュ退避`・`スナップショット退避` は
   * 実装側の語で、読者には「その締切が今日の見積もりなのか、古いデータなのか」が
   * 伝わらなかった（2026-09-23 確認）。何が違うかで書く。 */
  const freshnessLabel: Record<string, string> = {
    fresh: "今回あたって確認",
    "cache-fallback": "前回の取得データ（今回は上流にあたらず）",
    "snapshot-fallback": "確定済みの収録データ（今回は上流にあたらず）",
  };
  const maturityLabel: Record<string, string> = {
    established: "確立",
    emerging: "成長中",
    new: "新規",
    unverified: "未確認",
  };

  function axesForRecommendation(r: AppRow, now: number): RecommendationAxes {
    const published = isRecommendationAxes(r.conf.recommendation_axes)
      ? r.conf.recommendation_axes
      : null;
    if (published) {
      return {
        ...published,
        research_fit: { ...published.research_fit, score: r._matchScore ?? null },
      };
    }
    return recommendationAxes(
      r.conf as unknown as Record<string, unknown>,
      r._matchScore ?? null,
      now,
    );
  }

  function makeRecommendationCard(r: AppRow, now: number) {
    const card = document.createElement("article");
    card.className = "recommendation-card";
    const isPastOnly = r._availability?.status === "past";
    const title = document.createElement("h3");
    const name = titleWithYear(r.conf.title || r.conf.key || "", isPastOnly ? null : r.ed.year);
    const href = safeExternalUrl(isPastOnly ? r.conf.link : r.ed.link || r.conf.link);
    if (href) {
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = name;
      title.appendChild(link);
    } else {
      title.textContent = name;
    }
    card.appendChild(title);
    if (r.conf.full_name && r.conf.full_name !== r.conf.title) line(card, r.conf.full_name, "sub");

    const meta = document.createElement("div");
    meta.className = "card-meta";
    const fit = document.createElement("span");
    fit.className = "tag match";
    fit.textContent = `一致評価 ${r._fitLabel || "評価保留"}`;
    meta.appendChild(fit);
    const availability = document.createElement("span");
    availability.className = "tag";
    availability.textContent = recommendationAvailability(r);
    meta.appendChild(availability);
    card.appendChild(meta);

    const axes = axesForRecommendation(r, now);
    const maturityEvidence = axes.venue_maturity.evidence;
    const deadlineTrust = axes.deadline_trust;
    line(
      card,
      // 「観測年数」「プロフィール」も実装側の語。`profileCoverage` はその会議の
      // 論文サンプル数（`recommendation-core.ts` の `strings(conference.papers)`）なので、
      // 数えているものを書く。
      `会議の続いている年数: ${maturityLabel[axes.venue_maturity.status]}（確認した年 ${maturityEvidence.yearsObserved}年、その会議の論文サンプル ${maturityEvidence.profileCoverage}件）`,
      "card-section recommendation-axes",
    );
    line(
      card,
      `種別: ${KIND_LABEL[r.kind] || r.kind || "未確認"}`,
      "card-section recommendation-axes",
    );
    line(
      card,
      `締切の確認状況: 日付 ${trustLabel[deadlineTrust.date]} ／ 時刻 ${trustLabel[deadlineTrust.time]} ／ タイムゾーン ${trustLabel[deadlineTrust.timezone]} ／ 種別 ${trustLabel[deadlineTrust.kind]}`,
      "card-section recommendation-axes",
    );
    line(
      card,
      `取得状態: ${freshnessLabel[deadlineTrust.sourceFreshness]} ／ 締切の競合: ${deadlineTrust.conflicts}件`,
      "card-section recommendation-axes",
    );

    const agg = r._match?.agg ?? {
      domain: 0,
      venueName: 0,
      paper: 0,
      jp: 0,
      tags: 0,
      venue: 0,
    };
    const reasons: string[] = [];
    const reasonSignals: Array<[string, number]> = [
      ["分野の一致", agg.domain],
      ["会議名一致", agg.venueName ?? 0],
      ["採択論文一致", agg.paper],
      ["日本語一致", agg.jp],
      ["主題の一致", agg.tags],
    ];
    reasonSignals.forEach((item) => {
      if (item[1] > 0) reasons.push(`${item[0]} +${item[1]}`);
    });
    if (agg.venue > 0) reasons.push("過去掲載先一致");
    if (r._semanticRank) reasons.push(`意味検索順位 ${r._semanticRank}`);
    if (r._boosted) reasons.push("同じ分野（掲載先から推定）");
    line(
      card,
      reasons.length
        ? `選定理由: ${reasons.join(" / ")}`
        : "選定理由: 目立つ一致はないが候補に入った",
      "card-section",
    );
    if (r.conf.link && safeExternalUrl(r.conf.link)) {
      const official = document.createElement("a");
      official.href = safeExternalUrl(r.conf.link);
      official.target = "_blank";
      official.rel = "noopener noreferrer";
      official.textContent = "公式サイト";
      official.className = "card-section";
      card.appendChild(official);
    }
    return card;
  }

  function renderRecommendationCards(list: AppRow[], now = Date.now()) {
    const cards = $("recommendationCards");
    cards.textContent = "";
    recommendationList = list;
    cardsDrawn = 0;
    if (!recommendationData) {
      line(
        cards,
        recommendationError ? "推薦データを読み込めませんでした。" : "推薦データを読み込み中…",
        "recommendation-card",
      );
      return;
    }
    const lines = Recommender.parsePaperLines(valueElement("paperText").value);
    if (!lines.length) {
      line(
        cards,
        // 共有リンクで開いた人は、ここが空のままになる（論文の本文をURLに載せないため）。
        // 「リンクが壊れた」と受け取られると、そこで操作が止まる。
        "投稿予定論文のタイトル・概要・PDF/TXTを入力してください。リンクで開いた場合はここが空になります（論文の本文はURLに載せません）。",
        "recommendation-card",
      );
      return;
    }
    if (!list.length) {
      // 推薦モードでは締切画面の絞り込み（検索・分野・国内など）を見せていないので、
      // 「条件を変えてみてください」は画面に無いものを探す案内になる。
      // 実際に打てる手（論文の情報量、入力形式の見本）だけを書く。
      line(
        cards,
        "この論文の語と重なる投稿先が見つかりませんでした。タイトル・概要・キーワードを足すと当たりやすくなります。上のサンプルボタンで入力の形を確かめられます。",
        "recommendation-card",
      );
      return;
    }
    cardsDrawn = Math.min(list.length, RECOMMENDATION_PAGE);
    list.slice(0, cardsDrawn).forEach((r) => {
      cards.appendChild(makeRecommendationCard(r, now));
    });
  }

  function render() {
    const recMode = state.mode === "recommend";
    if (recMode && !recommendationData && !recommendationError) loadRecommendationData();
    shown = recMode && !recommendationData ? [] : filter();
    // チップの件数は分野以外の条件で絞った後の数。推薦モードではチップを見せないので更新しない。
    if (!recMode) updateCategoryCounts();
    drawn = 0;
    selectedIndex = -1;
    groupMonths = shouldGroupMonths({
      sortKey: sortKey,
      sortAsc: sortAsc,
      paper: recMode && Boolean(valueElement("paperText").value.trim()),
    });
    monthCounts = {};
    lastMonthKey = "";
    pastBlockTotal = shown.reduce((n: number, r: AppRow) => n + (r._pastBlock ? 1 : 0), 0);
    lastPastBlock = -1;
    if (groupMonths) {
      shown.forEach((r) => {
        const key = monthKey(r);
        if (key) monthCounts[key] = (monthCounts[key] || 0) + 1;
      });
    }
    $("tbody").textContent = "";
    const paperText = valueElement("paperText").value;
    const paperMode = recMode && Boolean(paperText.trim());
    let cnt = paperMode
      ? `あなたの論文に合う投稿先 ${countJa(shown.length)} 件${
          shown.length > RECOMMENDATION_PAGE
            ? `（まず上位 ${countJa(RECOMMENDATION_PAGE)} 件を表示）`
            : ""
        }`
      : recMode
        ? "投稿先を探すには論文情報を入力してください"
        : `${countJa(shown.length)} 件 / 全 ${countJa(rows.length)} 件`;
    // 読み上げ用の一行。`#count` は「のぞく」の内訳まで載せる長い欄なので、そこを
    // そのまま aria-live にすると 1 打鍵ごとに数十語が流れる（第 88 回で付けて実測）。
    // 件数と、解決結果・取得状態の短い通知だけをこちらに出す。
    let cntLive = cnt;
    // 前の描画で出した理由が残り続けないよう、状態を組み直すたびに消す。
    countSemanticReason = null;
    /* 会期だけが確定している会の当たり数を、件数欄と 0 件の案内で共用する（同じ絞り込みを
     * 二箇所に書かない）。対象は数十件なので、毎回数えても打鍵のコストにはならない。 */
    const scheduleOnly =
      recMode || paperMode
        ? []
        : scheduleOnlyMatches({
            window: state.win,
            cats: state.cats,
            domestic: state.domestic,
            online: state.online,
          });
    // 「全 M 件」との差をその場で説明する。内訳は独立に数えているので合計は全件にならない
    // （過去かつ投稿締切以外の行が両方に立つ）ため、「〜をのぞく」の形で書く。
    if (!recMode && !paperMode) {
      const hidden = hiddenDeadlineCounts();
      const parts: string[] = [];
      if (hidden.past) parts.push(`過去の締切 ${countJa(hidden.past)} 件`);
      if (hidden.kind) parts.push(`投稿締切以外の種別 ${countJa(hidden.kind)} 件`);
      // 「推定」の語は一覧の検索でも引ける（`推定` バッジの語を hay に入れている）が、
      // 既定ではここで行が落ちたままなので、出し方を同じ行に書く。
      if (hidden.est) parts.push(`推定 ${countJa(hidden.est)} 件（「推定締切を含める」で出ます）`);
      // 国内チェックで消えた行は「国内研究会ではない」だけの理由で落ちている。
      // 日本開催の国際会議もここに入るため、件数だけ出しておかないと検索をやめてしまう。
      if (hidden.window && state.win !== "all") {
        // 選んだ窓の名前は選択欄の表記のまま書く（「どのボタンを戻せばいいか」が分かる形で）。
        parts.push(
          `「締切まで ${Number.parseInt(state.win, 10)} 日以内」を超える ${countJa(hidden.window)} 件`,
        );
      }
      // 評価で絞った件数。選択欄の等級表記をそのまま書く（画面の語で探す人が探せる形に）。
      if (hidden.rank && state.rank)
        parts.push(`評価「${state.rank}」を持たない行 ${countJa(hidden.rank)} 件`);
      // 分野チップも同じ。チップに押した語が並ぶので、外した語を日本語でそのまま書く。
      if (hidden.cats && state.cats.length)
        parts.push(
          `分野「${state.cats.map((key: string) => catLabel(key)).join("・")}」を持たない行 ${countJa(hidden.cats)} 件`,
        );
      if (hidden.domestic)
        parts.push(`国内研究会・国内シンポジウム以外 ${countJa(hidden.domestic)} 件`);
      if (hidden.online) {
        // 「記載が無いだけ」の行数を括弧で添える（対面だと断定していないことの説明にもなる）。
        parts.push(
          hidden.onlinePlaceUnknown
            ? `オンライン参加の記載がない ${countJa(hidden.online)} 件（うち開催地が未確認 ${countJa(hidden.onlinePlaceUnknown)} 件）`
            : `オンライン参加の記載がない ${countJa(hidden.online)} 件`,
        );
      }
      if (parts.length) cnt += ` ｜ のぞく: ${parts.join("・")}`;
      /* 同じ条件で会期だけが確定している会の件数。これまでは表が 0 件のときにだけ
       * 出していたので、表に 1 行でも出た人は「これで全部だ」と受け取ってしまう
       * （2026-09-23 実測: 「研究会」は表 16 件に対し会期だけの該当 28 件、
       * 「ネットワーク」は 39 件に対し 31 件が画面に出ていなかった）。 */
      if (shown.length && scheduleOnly.length) {
        const scheduleNote = ` ｜ 同じ条件で会期だけが確定している会 ${countJa(scheduleOnly.length)} 件（締切は未定）`;
        cnt += scheduleNote;
        cntLive += scheduleNote;
      }
      // 「スパコン」などを分野名に寄せたときは、寄せた先をその場で書く。
      // 理由も見ずに分野全体の行を並べると、なぜ出たか分からないまま行の壁になる。
      const synonymNotes = Recommender.querySynonymNotes(searchQuery).concat(
        // 「明日」「今週」を暦日へ解決したことも同じ欄に寄せる（相対月と同じ方針で、
        // 黙って条件が変わったように見せない）。
        Recommender.relativeDayNotes(searchQuery, Date.now()),
      );
      if (synonymNotes.length) {
        cnt += ` ｜ ${synonymNotes.join("・")}`;
        cntLive += ` ｜ ${synonymNotes.join("・")}`;
      }
    }
    if (!recMode && urlNotices.length) {
      const noticeText = urlNotices.map((notice) => ` ｜ ${notice}`).join("");
      cnt += noticeText;
      cntLive += noticeText;
    }
    if (!recMode && state.past && historyStatus === "loading") {
      cnt += " ｜ 全履歴を読み込み中…";
      cntLive += " ｜ 全履歴を読み込み中…";
    }
    if (!recMode && state.past && historyStatus === "error") {
      cnt += " ｜ 全履歴を読み込めませんでした";
      cntLive += " ｜ 全履歴を読み込めませんでした";
    }
    if (paperMode) {
      const _lines = Recommender.parsePaperLines(paperText);
      const _auto = _lines.length ? Recommender.autoDetectCats(_lines) : [];
      if (_auto.length && !state.cats.length) {
        const autoNote = ` ｜ 分野自動判定: ${_auto.map((k) => catLabel(k)).join("・")}`;
        cnt += autoNote;
        cntLive += autoNote;
      }
      // 意味検索の状態を明示（初回はモデル読込に数秒かかる）
      if (semState === "loading") {
        cnt += " ｜ 意味検索を実行中…";
        cntLive += " ｜ 意味検索を実行中…";
      } else if (semState === "error") {
        // 失敗理由コードを併記する。publish.ts / 各 error 分岐が設定する診断コードで、
        // 8+通りの失敗が1文言に潰れて原因追跡不能になっていた (#711 の構造要因)。
        /* 理由の識別子は英語なので、画面には日本語を出す – 英字の符号は利用者に
         * 読めない（2026-09-23 実測: 「原因: embeddings unavailable」）。 */
        const semCode = semanticReason || "unknown";
        const semNote = ` ｜ 意味検索は利用不可（語彙検索のみ・原因: ${Recommender.semanticReasonJa(semCode)}）`;
        cnt += semNote;
        cntLive += semNote;
        countSemanticReason = semCode;
      }
    }
    // 「来月」で検索したとき、何月に絞ったのかを利用者が確認できるようにする
    // （相対指定が裏でどう解決されたかを見せないのは誤信を生む）。
    if (!recMode) {
      const note = relativeMonthNote(state.q, searchQuery);
      if (note) {
        cnt += note;
        cntLive += note;
      }
    }
    // 過ぎた締切を下へまとめたことは、件数欄に書く（黙って並びを変えないため）。
    if (!recMode && pastBlockTotal > 0 && pastBlockTotal < shown.length) {
      const blockNote = ` ｜ 過ぎた締切 ${countJa(pastBlockTotal)} 件は下にまとめました`;
      cnt += blockNote;
      cntLive += blockNote;
    }
    // 並び替えの状態を読み上げに足す（表が出ているときだけ。推薦のカードでは
    // 見出しが消えているので、見出しの語から作るこの文は出さない）。
    if (!recMode && !paperMode) cntLive += sortNoteJa(sortKey, sortAsc);
    /* 0 件の理由は、のちのち表の場所に出す長い文と同じ材料から作る（同じ判定を二箇所に
       書かない）。0 件のときだけ走るので、打鍵ごとの当たりの数え上げは増えない。 */
    const zeroFilter =
      !recMode && !paperMode && !shown.length
        ? {
            window: state.win,
            past: state.past,
            cats: state.cats.length,
            domestic: state.domestic,
            online: state.online,
            rank: state.rank,
            kind: state.kind,
            est: state.est,
            query: state.q,
            // 0 件の案内が、件数欄と同じ数字を項目ごとに添えられるようにする。
            hidden: hiddenDeadlineCounts(),
            hiddenKindWords: hiddenKindQueryWords(searchQuery),
            urlQuery: Recommender.looksLikeUrlQuery(searchQuery),
            queryMatch: queryMatchCounts(searchQuery),
            termCounts: queryTermNotes(searchQuery),
            // データその物が無い場合と、絞り込みで 0 件の場合を区別する材料。
            catalogConferences: DATA.conferences.length,
          }
        : null;
    if (zeroFilter)
      cntLive += zeroResultLiveNote({
        ...zeroFilter,
        // 0 件案内が「外せる条件」として並べる数と、読み上げの言いぶりを揃える。
        clearable: filtersClearable(zeroFilter),
        pastShown: state.past,
      });
    $("count").textContent = cnt;
    /* 原因の識別子は画面に出さないが、捨てると調査できない（#711）。属性で残す
     * （エラーのときだけ付け、他の状態では消す – 前の理由が残り続けるのを防ぐ）。 */
    if (countSemanticReason) $("count").setAttribute("data-semantic-reason", countSemanticReason);
    else $("count").removeAttribute("data-semantic-reason");
    // 読み上げはこちらの短い欄だけ（画面に出す文は `#count` のまま）。
    const countLive = $("countLive");
    if (countLive) countLive.textContent = cntLive;
    // CSV 書き出しは締切一覧の絞り込み結果に対してだけ意味がある（推薦モードでは出さない）。
    const exportBtn = $("exportCsv");
    if (exportBtn) {
      exportBtn.textContent = `表示中の ${countJa(shown.length)} 件を CSV でダウンロード`;
      exportBtn.hidden = recMode || !shown.length;
    }
    const showHistoryStatus =
      !recMode && state.past && (historyStatus === "loading" || historyStatus === "error");
    $("historyStatus").hidden = !showHistoryStatus;
    if (showHistoryStatus) {
      $("historyStatusText").textContent =
        historyStatus === "loading"
          ? "過去の締切を読み込んでいます…"
          : "全履歴を読み込めませんでした。表示中のカタログは利用できます。";
      $("historyRetry").hidden = historyStatus !== "error";
    }
    if (recMode) {
      $("deadlineTableWrap").hidden = true;
      $("recommendationCards").hidden = false;
      $("empty").hidden = true;
      renderRecommendationCards(paperMode ? shown : []);
      // 件数欄は総数を出すので、打ち切ったぶんは「さらに表示」に載せ直す
      // （数の言い切りと画面の食い違いを残さない）。
      updateMoreButton(cardsDrawn, recommendationList.length);
    } else {
      $("deadlineTableWrap").hidden = false;
      $("recommendationCards").hidden = true;
      if (zeroFilter) {
        const filter = zeroFilter;
        $("emptyText").textContent = emptyDeadlineHint(filter);
        renderNextMeetingNote(scheduleOnly);
        // 「過去の締切も表示」だけは一覧の意味を変える（過去行の読み込みを伴う）ので
        // まとめて外す側では触らず、文章での案内に留める。
        $("emptyReset").hidden = !filtersClearable(filter);
        $("empty").hidden = false;
      } else {
        $("empty").hidden = true;
      }
      drawMore();
    }
    updatePresetActive();
  }

  function updateModeUi() {
    const recommend = state.mode === "recommend";
    const panel = $("controlsPanel");
    panel.classList.toggle("mode-recommend", recommend);
    panel.classList.toggle("mode-deadlines", !recommend);
    $("modeRecommend").setAttribute("aria-pressed", String(recommend));
    $("modeDeadlines").setAttribute("aria-pressed", String(!recommend));
    // てびきは締切一覧の読み方を説明するもの。推薦画面では表が消えるので畳む。
    $("helpPanel").hidden = recommend;
  }

  function loadRecommendationData() {
    if (recommendationData || recommendationPromise || recommendationError) return;
    recommendationPromise = loadPublishedRecommendation(
      (name) =>
        fetch(name).then((response) => {
          if (!response.ok) throw new Error(`${name} ${response.status}`);
          return response.text();
        }),
      DATA,
    )
      .then((result) => {
        const catalog = catalogFrom(result.index);
        if (!catalog) throw new Error("invalid recommendation catalog");
        recommendationData = catalog;
        EMBEDDINGS = result.embeddings ? embeddingBundle(result.embeddings) : null;
        semanticReason = result.state.reason;
        if (!result.state.semantic || !EMBEDDINGS) clearSemantic("error");
        // 埋め込み到着前に scheduleSemantic が走ると error で固着する
        // (loadEmbeddings は取得を待たず EMBEDDINGS 未設定なら即 error)。
        // データが揃ったここで、入力済みの論文テキストに対して再計算する。
        else if (currentPaperText().trim()) scheduleSemantic();
        setRecommendationProfile(result.index);
        render();
      })
      .catch(() => {
        recommendationError = true;
        semanticReason = "recommendation data unavailable";
        clearSemantic("error");
        render();
      });
  }

  function resolveHistoryRef() {
    const ref = DATA?.history_ref;
    if (typeof ref !== "string" || !ref.trim()) return "";
    try {
      const url = new URL(ref, window.location.href);
      if (url.origin !== window.location.origin) return "";
      return url.href;
    } catch (_) {
      return "";
    }
  }

  function stopHistoryLoad() {
    historyLoader.cancel();
    historyStatus = historyLoader.status;
  }

  function loadHistoryData() {
    if (state.mode !== "deadlines" || !state.past) return;
    if (historyLoader.data) {
      historyStatus = historyLoader.status;
      setDeadlineProfile(historyLoader.data);
      return;
    }
    const ref = resolveHistoryRef();
    if (!ref) {
      historyStatus = "error";
      setDeadlineProfile(DATA);
      render();
      return;
    }
    historyLoader.load(ref);
  }

  function setMode(mode: UiMode) {
    /* モードを変えると表は消える（推薦画面では行を一覧に描かない）ので、開いていた行の
     * 詳細は閉じる。閉じないと `?row=` が投稿先を探す画面の URL に残る（`writeUrl` は
     * `drawerRow` をモードが見ていずに書く）。その URL を受け取った人は、表の出ない画面で
     * 行を開こうとして、収録があるのに「収録に見当たりません」と読まされた
     * （2026-08-09 実測: `setMode` はドロワーを閉めていなかった）。 */
    if (drawerRow) closeDrawer();
    window._prevFocus = null;
    state.mode = mode === "recommend" ? "recommend" : "deadlines";
    updateModeUi();
    writeUrl();
    if (state.mode === "recommend") {
      stopHistoryLoad();
      if (recommendationData) setRecommendationProfile(recommendationData);
      else loadRecommendationData();
    } else if (state.past) {
      loadHistoryData();
    } else {
      stopHistoryLoad();
      setDeadlineProfile(DATA);
    }
    render();
  }

  function readUrl() {
    const p = new URLSearchParams(window.location.search);
    // 案内は読み取りのつど作り直す（項目を集めたあとで初期化すると、最初に集めた分が
    // 消える。2026-09-23 に実発生）。
    urlNotices = [];
    const rawMode = p.get("mode");
    state.mode = rawMode === "recommend" ? "recommend" : "deadlines";
    if (rawMode && rawMode !== "recommend" && rawMode !== "deadlines") {
      urlNotices.push(urlValueNoticeJa("モード", rawMode, "締切の一覧を開きました"));
    }
    state.q = p.get("q") || "";
    const urlKind = selectableKind(p.get("kind"));
    state.kind = urlKind.kind;
    if (urlKind.notice) urlNotices.push(urlKind.notice);
    const rawRank = p.get("rank");
    // 許す値は選択肢の正本と同じ（書き写すと URL だけ通る値が生まれる）。
    state.rank = RANK_GRADE_OPTIONS.indexOf(rawRank || "") >= 0 ? rawRank || "" : "";
    if (rawRank && !state.rank) {
      urlNotices.push(urlValueNoticeJa("ランク", rawRank, "ランクの絞り込みは外れています"));
    }
    const rawWin = p.get("win");
    // 受け付ける値はセレクトの選択肢と表裏一体にする（選択肢に無い値を通すと、その値で
    // 共有された URL を開いた人のセレクトが空欄になる。`future` は過去行を落とさない
    // 何もしない値だったので、受け付け自体をやめた）。
    state.win = WIN_OPTIONS.indexOf(rawWin || "") >= 0 ? rawWin || "" : "all";
    if (rawWin && state.win === "all") {
      urlNotices.push(urlValueNoticeJa("締切まで", rawWin, "締切日は絞っていません"));
    }
    /* チェック欄の値。`1` / `true` で入り、`0` / `false` で入りなし、読めない値は
     * 入りなしにして、画面上の語（ラベルそのもの）で理由を出す。
     * `p.get("est")` のように鍵を直書きするのは、URL に書いた条件を読み戻す照合検査
     * （SPEC §7）が鍵名を洗えるようにするためでもある。 */
    const flagNoticeJa = (label: string, raw: string | null): void => {
      urlNotices.push(
        urlValueNoticeJa(label, raw == null ? "" : String(raw), "チェックは入りませんでした"),
      );
    };
    const estRaw = p.get("est");
    const domesticRaw = p.get("domestic");
    const onlineRaw = p.get("online");
    const pastRaw = p.get("past");
    const estFlag = urlFlagJa(estRaw);
    const domesticFlag = urlFlagJa(domesticRaw);
    const onlineFlag = urlFlagJa(onlineRaw);
    const pastFlag = urlFlagJa(pastRaw);
    if (!estFlag.readable) flagNoticeJa("推定締切を含める", estRaw);
    if (!domesticFlag.readable) flagNoticeJa("国内研究会・国内シンポジウムのみ", domesticRaw);
    if (!onlineFlag.readable) flagNoticeJa("オンライン参加可のみ", onlineRaw);
    if (!pastFlag.readable) flagNoticeJa("過去の締切も表示", pastRaw);
    state.est = estFlag.on;
    state.domestic = domesticFlag.on;
    state.online = onlineFlag.on;
    state.past = pastFlag.on;
    /* 「見方のてびき」を開いた状態もリンクで引き継ぐ。閉じた `<details>` の中は
     * ブラウザのページ内検索（Ctrl+F）で出てこない（WebKit の既知の制限:
     * https://bugs.webkit.org/show_bug.cgi?id=239940）。てびきを探している人が
     * 「このページに書いてあるのに見つからない」で止まらないように、開いた状態で
     * 渡せる道をここに置く（2026-09-23）。 */
    const helpFlag = urlFlagJa(p.get("help"));
    // 開いていた行の詳細も引き継ぐ（行が見つからないときは静かに開かない –
    // 件数欄に注意を足すと、行の有り無しと無関係な読み上げが増えるため第 140 回と同じ扱い）。
    const rowFlag = p.get("row");
    pendingDrawerKey = typeof rowFlag === "string" ? rowFlag : "";
    // 読めない値でも注意を出さない。てびきは画面の絞り込みではなく見せ方なので、
    // 件数欄に「チェックは入りませんでした」を並べると、本当に外れた条件の案内が
    // 埋もれる（チェック欄と同じ案内文もそこでは不通）。
    // `<details>` の開閉なので型を落とす（`$` は HTMLElement を返す）。見出しは
    // `site/template.html` に常に有るので存在チェックはしない（他の欄と同じ）。
    const helpPanel = $("helpPanel") as HTMLDetailsElement;
    helpPanel.open = helpFlag.on;
    const rawCats = (p.get("cats") || "").split(",").filter((category) => Boolean(category));
    state.cats = rawCats.filter((category) => Boolean(DATA.categories[category]));
    // 分野は「知らない鍵を黙って落とす」と、送った人の意図より広い一覧を開くことになる
    // （全部の鍵が未知なら、そもそも絞り込んでいない画面になる）。
    const unknownCats = rawCats.filter((category) => !DATA.categories[category]);
    if (unknownCats.length) {
      // 知らない鍵はラベルの引きようが無いので、URL に書いたとおりの値で見せる
      // （送った人が打った / 生成的に得た文字列そのものが分からないと直せない）。
      const names = unknownCats.join("・");
      urlNotices.push(
        state.cats.length
          ? `リンクの分野「${names}」はこの一覧に無いので、その部分だけ外しました`
          : `リンクの分野「${names}」はこの一覧に無いので、分野の絞り込みは外れています`,
      );
    }
    const rawSort = p.get("sort");
    sortKey = rawSort && SORTABLE_KEYS.indexOf(rawSort) >= 0 ? rawSort : DEFAULT_SORT_KEY;
    if (rawSort && sortKey === DEFAULT_SORT_KEY && SORTABLE_KEYS.indexOf(rawSort) < 0) {
      urlNotices.push(urlValueNoticeJa("並び順", rawSort, "既定の並び順に戻しました"));
    }
    sortAsc = p.get("dir") !== "desc";
  }

  function writeUrl() {
    const p = new URLSearchParams();
    p.set("mode", state.mode);
    if (state.q) p.set("q", state.q);
    if (state.kind) p.set("kind", state.kind);
    if (state.rank) p.set("rank", state.rank);
    if (state.win !== "all") p.set("win", state.win);
    if (state.est) p.set("est", "1");
    if (state.domestic) p.set("domestic", "1");
    if (state.online) p.set("online", "1");
    if (state.past) p.set("past", "1");
    if (state.cats.length) p.set("cats", state.cats.join(","));
    // 並び順も URL に入れる。「国内研究会を締切の新しい順で」のような共有が、
    // 開いた人の画面で元の並びにならないのは惜しい。既定の並びなら引数を足さない。
    if (sortKey !== DEFAULT_SORT_KEY) p.set("sort", sortKey);
    if (!sortAsc) p.set("dir", "desc");
    // てびきを開いている状態も同じ理屈で引き継ぐ（上の読み取り側参照）。
    const helpPanelEl = $("helpPanel") as HTMLDetailsElement;
    if (helpPanelEl.open) p.set("help", "1");
    if (drawerRow) p.set("row", rowShareKeyJa(drawerRow));
    const str = p.toString();
    history.replaceState(null, "", str ? `?${str}` : window.location.pathname);
  }

  function toForm() {
    valueElement("q").value = state.q;
    valueElement("kind").value = state.kind;
    valueElement("rank").value = state.rank;
    valueElement("win").value = state.win;
    inputElement("est").checked = state.est;
    inputElement("domestic").checked = state.domestic;
    inputElement("online").checked = state.online;
    inputElement("past").checked = state.past;
    catsBox.querySelectorAll<HTMLInputElement>("input").forEach((chk) => {
      chk.checked = state.cats.indexOf(chk.value) >= 0;
    });
    updatePresetActive();
  }

  function fromForm() {
    state.q = valueElement("q").value;
    state.kind = valueElement("kind").value;
    state.rank = valueElement("rank").value;
    state.win = valueElement("win").value;
    state.est = inputElement("est").checked;
    state.domestic = inputElement("domestic").checked;
    state.online = inputElement("online").checked;
    state.past = inputElement("past").checked;
    state.cats = [];
    catsBox.querySelectorAll<HTMLInputElement>("input").forEach((chk) => {
      if (chk.checked) state.cats.push(chk.value);
    });
  }

  function apply() {
    fromForm();
    writeUrl();
    if (state.mode === "deadlines" && state.past) {
      loadHistoryData();
    } else {
      stopHistoryLoad();
      if (state.mode === "deadlines") setDeadlineProfile(DATA);
    }
    render();
  }

  // ---- paper file upload（PDF/TXT → editable structured records） ----
  const PDFJS_VERSION = "3.11.174";
  const PDFJS_SCRIPT = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const PDF_MAX_BYTES = 20 * 1024 * 1024;
  const PDF_MAX_PAGES = 100;
  const PDF_PAGE_LIMIT = 3;
  const PDF_TIMEOUT_MS = 15000;
  let pdfAbortController: AbortController | null = null;
  let pdfJob = 0;
  let paperPrimaryVenue = "";

  function loadPdfJs(cb: (loaded: boolean) => void) {
    if (
      PDFJS_SCRIPT.indexOf(`/${PDFJS_VERSION}/`) < 0 ||
      PDFJS_WORKER.indexOf(`/${PDFJS_VERSION}/`) < 0
    ) {
      cb(false);
      return;
    }
    if (window.pdfjsLib) {
      cb(String(window.pdfjsLib.version || PDFJS_VERSION) === PDFJS_VERSION);
      return;
    }
    const s = document.createElement("script");
    s.src = PDFJS_SCRIPT;
    s.onload = () => {
      window.pdfjsLib!.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      cb(true);
    };
    s.onerror = () => {
      cb(false);
    };
    document.head.appendChild(s);
  }
  function abortError() {
    const error = new Error("PDF extraction cancelled");
    error.name = "AbortError";
    return error;
  }
  function readPdf(buf: ArrayBuffer, signal: AbortSignal): Promise<PdfReadResult> {
    const runtime = window.pdfjsLib;
    if (!runtime) return Promise.reject(new Error("pdfjs unavailable"));
    const task = runtime.getDocument({ data: buf });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (task.destroy) task.destroy();
    };
    return new Promise<PdfReadResult>((resolve, reject) => {
      const cleanup = () => {
        if (timeout !== undefined) clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
      };
      const resolveOnce = (value: PdfReadResult) => {
        cleanup();
        resolve(value);
      };
      const rejectOnce = (error: unknown) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        stop();
        rejectOnce(abortError());
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => {
        stop();
        rejectOnce(new Error("PDF extraction timed out"));
      }, PDF_TIMEOUT_MS);
      task.promise
        .then(async (doc) => {
          if (doc.numPages > PDF_MAX_PAGES) throw new Error("PDF has too many pages");
          const pages: Array<Promise<PdfTextItem[]>> = [];
          for (let i = 1; i <= Math.min(doc.numPages, PDF_PAGE_LIMIT); i++) {
            pages.push(
              doc.getPage(i).then((page) => page.getTextContent().then((content) => content.items)),
            );
          }
          return {
            pages: await Promise.all(pages),
            metadata: await doc.getMetadata().catch(() => ({ info: {} })),
          };
        })
        .then(resolveOnce, rejectOnce);
    });
  }
  function textRecord(name: string, text: string) {
    return Recommender.textPaperRecord(text, name);
  }
  /* PDF 読み込みの失敗を、画面に出せる日本語と打ち手へ寄せる。内部の英語文字列を
   * そのまま出していた（2026-09-23 実測: 「PDF 読込に失敗しました: pdfjs unavailable」
   * 「: file is too large」「: PDF has too many pages」「: PDF extraction timed out」、
   * pdf.js 由来の "Invalid PDF structure." など）。日本語の利用者は何が起きたか
   * 直せないので、原因の心当たりと代替手段（貼り付け）を出す。
   * 上限値はテスト側にも書き写さず、同じ定数から作る。 */
  function pdfFailureMessageJa(error: unknown): string {
    const name = error instanceof Error ? error.name : "";
    if (name === "AbortError") return "PDF 読込をキャンセルしました";
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    const pasteHint = "タイトルと概要を下の欄に貼り付けてください";
    /* 対応していない文書形式を「PDF が読めない」とは言わない（自分の PDF の文字化けを疑って、
     * 直せない方向へ探させることになる – 第 150 回）。 */
    if (message.indexOf("unsupported document") >= 0) {
      const ext = /format:\s*([a-z0-9]+)/.exec(message);
      return (
        (ext ? `.${ext[1]} は` : "その形式のファイルは") +
        "この欄で読めません（対応しているのは PDF と TXT です）。" +
        "Word などは TXT に保存し直すか、" +
        pasteHint
      );
    }
    if (
      message.indexOf("pdfjs") >= 0 ||
      message.indexOf("cdnjs") >= 0 ||
      message.indexOf("failed to fetch") >= 0
    ) {
      return (
        "PDF を読む仕組みが呼び出せませんでした（外部から部品を取れないネットワーク状況の" +
        "可能性があります）。" +
        pasteHint
      );
    }
    if (message.indexOf("too large") >= 0 || message.indexOf("size") >= 0) {
      const mb = Math.round(PDF_MAX_BYTES / (1024 * 1024));
      return `PDF が大きすぎます（${mb} MB まで）。抜粋を TXT にして貼るか、小さいファイルを指定してください`;
    }
    if (message.indexOf("too many pages") >= 0) {
      return (
        `PDF のページが多すぎます（${PDF_MAX_PAGES} ページまで）。` +
        "先頭部分を TXT に書き出して貼ってください"
      );
    }
    if (message.indexOf("timed out") >= 0 || message.indexOf("timeout") >= 0) {
      return "PDF の読み込みが遅すぎて中断しました。" + pasteHint;
    }
    if (
      message.indexOf("invalid pdf") >= 0 ||
      message.indexOf("password") >= 0 ||
      message.indexOf("structure") >= 0
    ) {
      return (
        "PDF から文字を読み取れませんでした（文字が入っていない PDF や、パスワード付きは" +
        "読めません）。" +
        pasteHint
      );
    }
    return "PDF を読み込めませんでした。ファイルを確かめるか、" + pasteHint;
  }

  /* 対応していない文書形式（Word・一太郎・OpenDocument など）。これを PDF として読むと
   * pdf.js が `Invalid PDF structure.` を落とし、画面は「文字が入っていない PDF や、
   * パスワード付きは読めません」と言っていた（2026-09-23 実測: `.docx` を選んだ人がこの文を
   * 受け、自分の PDF の文字化けを疑って直せない方向へ探した）。ピッカーは `accept` だけで
   * 絞られるわけではなく、「すべてのファイル」に切り替えれば運べるので、拡張子で止める。 */
  function unsupportedPaperFormatJa(name: unknown): string | null {
    const text = String(name || "");
    const m = /\.(docx?|odt|rtf|pages|wps|pptx?|odp|key|epub|zip)$/i.exec(text);
    if (!m) return null;
    return `unsupported document format: ${m[1].toLowerCase()}`;
  }

  function readPaperFile(file: File, signal: AbortSignal): Promise<PaperRecord> {
    const unsupported = unsupportedPaperFormatJa(file.name);
    if (unsupported) return Promise.reject(new Error(unsupported));
    if (file.size > PDF_MAX_BYTES) return Promise.reject(new Error("file is too large"));
    if (/\.txt$/i.test(file.name)) return file.text().then((text) => textRecord(file.name, text));
    return file
      .arrayBuffer()
      .then((buf) => readPdf(buf, signal))
      .then((result) => Recommender.pdfPaperRecord(result.metadata, result.pages, file.name));
  }
  function syncPaperText() {
    const primary: PaperRecord = {
      title: valueElement("paperPrimaryTitle").value.trim(),
      abstract: valueElement("paperPrimaryAbstract").value.trim(),
      keywords: valueElement("paperPrimaryKeywords").value.trim(),
      venue: paperPrimaryVenue,
    };
    let records: PaperRecord[] =
      primary.title || primary.abstract || primary.keywords ? [primary] : [];
    records = records.concat(Recommender.parsePaperLines(valueElement("paperReferences").value));
    valueElement("paperText").value = records.length ? JSON.stringify(records) : "";
  }
  function setPrimaryRecord(record?: Partial<PaperRecord>) {
    valueElement("paperPrimaryTitle").value = record?.title || "";
    valueElement("paperPrimaryAbstract").value = record?.abstract || "";
    valueElement("paperPrimaryKeywords").value = record?.keywords || "";
    paperPrimaryVenue = record?.venue || "";
  }
  const paperFiles = inputElement("paperFiles");
  const cancelPdf = $("cancelPdf");
  cancelPdf.addEventListener("click", () => {
    if (pdfAbortController) pdfAbortController.abort();
  });
  paperFiles.addEventListener("change", (event) => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLInputElement)) return;
    const files = Array.from(target.files ?? []);
    if (!files.length) return;
    const label = $("paperFileLabel");
    label.textContent = "読み込み中…";
    cancelPdf.hidden = false;
    const job = ++pdfJob;
    pdfAbortController = new AbortController();
    const signal = pdfAbortController.signal;
    /** @type {Promise<void>} */
    const load: Promise<void> = files.some(
      (file) => !/\.txt$/i.test(file.name) && !unsupportedPaperFormatJa(file.name),
    )
      ? new Promise((resolve, reject) =>
          loadPdfJs((ok) => (ok ? resolve() : reject(new Error("pdfjs unavailable")))),
        )
      : Promise.resolve();
    load
      .then(() => Promise.all(files.map((file) => readPaperFile(file, signal))))
      .then((records) => {
        if (job !== pdfJob || signal.aborted) throw abortError();
        setPrimaryRecord(records[0] || {});
        valueElement("paperReferences").value = records
          .slice(1)
          .map((record) =>
            [record.title, record.keywords, record.venue].filter(Boolean).join(" | "),
          )
          .join("\n");
        syncPaperText();
        label.textContent = files.map((file) => file.name).join(", ");
        apply();
        scheduleSemantic();
      })
      .catch((error: unknown) => {
        label.textContent = pdfFailureMessageJa(error);
      })
      .finally(() => {
        if (job === pdfJob) {
          pdfAbortController = null;
          cancelPdf.hidden = true;
        }
      });
    target.value = "";
  });

  /* 入力欄への入力を遅延適用する。日本語 IME の変換中は適用しない —
   * 未確定のひらなが（「きかい」）で画面が入れ替わって見えいうえ、変換候補ウィンドウを
   * 開いたままの再計算はもたつく。確定（compositionend）後に一度だけ走らせる。
   * 検索欄だけでなく論文入力の各欄も同じにする。要旨・タイトルは日本語で打つ欄なので、
   * 検索欄だけ守っても使っている人は同じもたつきを踏む。
   * `onType` は打鍵ごとに走らせる軽い処理（再計算を伴わないキャッシュ無効化など）。
   * 変換中に他の操作（分野チップ等）をされたときに、古い結果を使い回さないため必要。 */
  function wireDebouncedInput(
    element: { addEventListener(type: string, listener: () => void): void },
    delay: number,
    applyInput: () => void,
    onType?: () => void,
  ): void {
    let composing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (onType) onType();
      clearTimeout(timer);
      if (composing) return;
      timer = setTimeout(applyInput, delay);
    };
    element.addEventListener("compositionstart", () => {
      composing = true;
      if (onType) onType();
    });
    element.addEventListener("compositionend", () => {
      composing = false;
      schedule();
    });
    element.addEventListener("input", schedule);
  }

  // ---- wiring ----
  // 検索は 1 打鍵で全行を絞り込む（3234 行で約 9.6 ms）。確定・入力のたびに
  // 走らせるともたつくので、入力はまとめて 1 回だけ適用する。
  wireDebouncedInput(valueElement("q"), 180, apply);
  wireDebouncedInput(
    $("paperText"),
    200,
    () => {
      apply();
      scheduleSemantic();
    },
    invalidateSemantic,
  );
  ["paperPrimaryTitle", "paperPrimaryAbstract", "paperPrimaryKeywords", "paperReferences"].forEach(
    (id) => {
      wireDebouncedInput(
        $(id),
        200,
        () => {
          syncPaperText();
          apply();
          scheduleSemantic();
        },
        invalidateSemantic,
      );
    },
  );

  document.querySelectorAll<HTMLElement>(".sample-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const sample = Recommender.parsePaperLines(button.getAttribute("data-sample"))[0];
      setPrimaryRecord(sample);
      valueElement("paperReferences").value = "";
      syncPaperText();
      apply();
      scheduleSemantic();
    });
  });
  ["kind", "rank", "win", "est", "domestic", "online", "past"].forEach((id) => {
    $(id).addEventListener("change", apply);
  });
  catsBox.addEventListener("change", apply);
  /* てびきを開閉したら URL も揃える。閉じた `<details>` の中はブラウザのページ内検索に
   * 出ないので、開いた人一緒の画面をそのまま共有できるようにする（読み取り側は `readUrl`）。 */
  $("helpPanel").addEventListener("toggle", () => writeUrl());
  $("more").addEventListener("click", drawMore);
  // 0 件時の「条件をまとめて外す」。早め絞り込みのボタンは自分の条件だけを出し入れする
  // 切り替えなので、まとめて外す役はここで状態を戻して担う。
  // 一覧の意味を変える「過去の締切も表示」は利用者の選択として残す。
  $("emptyReset").addEventListener("click", () => {
    const past = state.past;
    state = {
      mode: state.mode,
      q: "",
      cats: [],
      kind: "",
      rank: "",
      win: "all",
      est: false,
      domestic: false,
      online: false,
      past,
    };
    stopHistoryLoad();
    if (state.mode === "deadlines") setDeadlineProfile(DATA);
    toForm();
    writeUrl();
    render();
  });
  const exportCsvButton = $("exportCsv");
  if (exportCsvButton) exportCsvButton.addEventListener("click", exportShownCsv);
  // 印刷時は絞り込み後の全行を描画する。画面は 40 行ずつしか出さないので、
  // この措置が無いと印刷物だけ「直近 40 件」で途中までになる。印刷後に戻す。
  let printExpanded = false;
  /* 印刷物に「いつのデータで、どんな条件の一覧か」を残す。画面の絞り込み欄は印刷で
   * 落ちるので、これがないと紙だけ条件の分からない一覧になる（データ生成日はヘッダーに
   * 残るが、絞り込み条件はどこにも残っていなかった – 2026-09-23 実測）。 */
  /* 送られてきたリンクで、送った人が開いていた行の詳細を開く。条件も一緒に来るので
   * 通常は同じ行が見つかるが、データの生成日が違うと無いことがある（そのときは
   * 表だけを出す – 存在しない行を開くより、開かないほうがマシな誤解で済む）。 */
  /* 共有された行のURL（`?row=`）を受け取った人は、その行が既定の一覧に出ていないと
   * これまで**何も起きなかった**（2026-09-23 実測: 収録の共有キー 3,207 件のうち既定の
   * 画面に出るのは 475 件で、残り 2,732 件 – 過ぎた締切 2,295 件・推定 134 件・表の既定の
   * 種別以外 303 件 – へのリンクは黙って一覧だけが出ていた）。論文のメモやスライドに
   * 残った去年の締切のリンクを踏む操作はふつうにあるので、外せる条件を自分で外して
   * 見せ、それでも見つからないときだけその旨を言う。 */
  function sharedRowState(row: AppRow | null, now: number): "past" | "est" | "other" | "missing" {
    if (!row) return "missing";
    if (rowIsPast(row, now)) return "past";
    if (row.est) return "est";
    return "other";
  }

  /* 共有リンクの行を一覧に出すために、こちら側で緩める条件を 1 つずつ試す。緩めるたびに
   * 描き直してその行が出るかを見る（まとめて全部外すと、関係の無い条件まで外れた画面に
   * なるので、必要最小限だけ触る）。緩めた項目名を返すのは、件数のうしろにそのまま
   * 書くため（外したことが見えないと、受け取った人は送った人と同じ画面を開けたのか
   * 判断できない）。チェック欄の項目は「隠す条件を外した」という意味の語にしている –
   * 「条件を外しました」に並べて筋が通る。 */
  function loosenSharedRowConditions(find: () => number): string[] {
    const steps: [string, () => void][] = [];
    if (state.q) {
      steps.push([
        "検索語",
        () => {
          state.q = "";
        },
      ]);
    }
    if (state.kind) {
      steps.push([
        "種別",
        () => {
          state.kind = "";
        },
      ]);
    }
    if (state.rank) {
      steps.push([
        "ランク",
        () => {
          state.rank = "";
        },
      ]);
    }
    if (state.win !== "all") {
      steps.push([
        "締切まで",
        () => {
          state.win = "all";
        },
      ]);
    }
    if (state.cats.length) {
      steps.push([
        "分野",
        () => {
          state.cats = [];
        },
      ]);
    }
    if (state.domestic) {
      steps.push([
        "国内研究会・国内シンポジウムのみ",
        () => {
          state.domestic = false;
        },
      ]);
    }
    if (state.online) {
      steps.push([
        "オンライン参加可のみ",
        () => {
          state.online = false;
        },
      ]);
    }
    if (!state.past) {
      steps.push([
        "過去の締切を隠す条件",
        () => {
          state.past = true;
        },
      ]);
    }
    if (!state.est) {
      steps.push([
        "推定の行を隠す条件",
        () => {
          state.est = true;
        },
      ]);
    }
    const changed: string[] = [];
    for (const [name, apply] of steps) {
      apply();
      changed.push(name);
      render();
      if (find() >= 0) return changed;
    }
    return changed;
  }

  function restoreDrawerFromUrl() {
    if (!pendingDrawerKey) return;
    /* 投稿先を探す画面では表を描かないので、行の詳細は開けない。上の `setMode` が
     * モード変更時に閉じるので、こういう URL はふつうは生まれない（手入力と、直す前の
     * 版本が作ったリンクで受け取る）。条件を勝手に外さず、理由をそのまま言う。 */
    if (state.mode !== "deadlines") {
      sharedRowNotice(
        "リンクに行の詳細が含まれていますが、投稿先を探す画面では行を開きません。締切の一覧に戻すと開けます。",
      );
      return;
    }
    let idx = shown.findIndex((r) => rowShareKeyJa(r) === pendingDrawerKey);
    if (idx < 0) {
      const hit = rows.find((r) => rowShareKeyJa(r) === pendingDrawerKey) || null;
      const why = sharedRowState(hit, Date.now());
      if (why === "missing") {
        sharedRowNotice(
          "共有された行はこの収録に見当たりません。データの更新で無くなった可能性があります。",
        );
        return;
      }
      if (SELECTABLE_KINDS.indexOf((hit as { kind: string }).kind) < 0) {
        /* 表に出さない種別（採否通知・カメラレディ・反論期間など）の行へのリンクは、
         * 絞り込みの問題ではないので「条件を確認してください」とは言わない（実測: 既定で
         * 一覧に出ない 2,732 件のうち 303 件がこの種別で、表に出さない行なのである）。
         * 行その物を見せて中身を読むことができる – 行の目印は出せない（一覧に無い）ので、
         * その旨を添える。 */
        sharedRowNotice(
          "その行は表に出さない種別（採否通知・カメラレディなど）なので、行を開いて中身を出します。",
        );
        openDrawer(hit as unknown as DrawerRow);
        return;
      }
      /* 既定で隠している条件（過ぎた締切・推定）は、リンクが指す行のために自分で外す。
       * 画面のチェックも同じにする – 外したことが見えないと「なぜ過去の行が出ているか」が
       * 読めない（`toForm` は条件欄を state から書き直す）。 */
      if (why === "past") state.past = true;
      else if (why === "est") state.est = true;
      toForm();
      render();
      /* まだ無い行は、リンクに書かれた検索語や絞り込みで落ちている（実測: `q` と `row` を
       * 同時に含む URL で、表に出る `paper` の行が「表に出さない種別なので…」という
       * 筋違いの案内を受けていた）。送った人の画面ではその行が出ていたので、受け取る側で
       * 条件を緩めて開く（過ぎた締切・推定で決めた方針の続き）。 */
      const keyAt = () => shown.findIndex((r) => rowShareKeyJa(r) === pendingDrawerKey);
      idx = keyAt();
      /* 過ぎた締切・推定を外しただけで出てくる行には、これ以上触らない（第 156 回の
       * 扱いのまま）。それでも無い行だけ、リンクについていた条件を緩めに行く。 */
      const loosened = idx < 0 ? loosenSharedRowConditions(keyAt) : [];
      idx = keyAt();
      if (idx < 0) {
        /* 収録に見当っても、いまの一覧に出さない行（会期だけの研究会など）がある。
         * ここまで条件を緩めても出ない行を「見当たりません」とは言わない – 行は
         * 有るので、開いて中身を出す。 */
        sharedRowNotice(
          loosened.length
            ? `その行はいまの一覧に出さない行なので、リンクについていた条件（${loosened.join("・")}）を外したうえで、行を開いて中身を出します。`
            : "その行はいまの一覧に出さない行なので、行を開いて中身を出します。",
        );
        openDrawer(hit as unknown as DrawerRow);
        return;
      }
      // `render()` が `#countLive` を書き直すので、案内は後から同じ欄に足す。
      if (loosened.length) {
        sharedRowNotice(
          `その行を開くために、リンクについていた条件を自分から外しました（${loosened.join("・")}）。一覧はリンクの条件と違う範囲になっています。`,
        );
      }
    } else {
      render();
    }
    /* `render()` は本体の先頭で `selectedIndex = -1` と `drawn = 0` に戻す（2026-09-23 実測:
     * `render` の本体の最初に両方の代入がある）。従来は render の前に選択を置いていたため、
     * 共有リンクを受け取った側の画面で、開いた行に目印が付かなかった。描き終えた後に付け直す。 */
    selectedIndex = idx;
    ensureRowsDrawn(idx);
    updateRowSelection();
    openDrawer(shown[idx] as unknown as DrawerRow);
  }

  /* 起動時のみ使うお知らせ。`render()` が `#countLive` を書き直すので、この関数は
   * render の後に呼ぶ（0 件案内と同じ 「 ｜ 」 の形で流す – 支援技術では同じ場所から
   * 読まれる）。 */
  function sharedRowNotice(text: string) {
    const live = $("countLive");
    if (live) live.textContent = ` ｜ ${text}`;
  }

  function fillPrintMeta() {
    const box = $("printMeta");
    if (!box) return;
    const genAt = typeof DATA.generated_at === "string" ? DATA.generated_at : "";
    const winSelect = valueElement("win") as HTMLSelectElement;
    const opt =
      winSelect && winSelect.options && winSelect.selectedIndex >= 0
        ? winSelect.options[winSelect.selectedIndex]
        : null;
    const winText = opt ? String(opt.text || opt.textContent || "").trim() : "";
    const winLabel = state.win && state.win !== "all" ? winText || state.win : "";
    const printedTail = ` ／ 印刷した日時 ${fmtJst(new Date())} ／ ${generatedAtLabel(genAt)}`;
    /* 投稿先を探す画面では、表の絞り込み条件も「表示 N 件」も紙に意味がない（並ぶのは
     * 候補のカードだけ）。従来は表用の文言をそのまま書いていて、カードが並んだ紙に
     * 「表示 0 件」と刷れていた（2026-09-23 実測: 推薦画面では `shown` が空になる –
     * `render` の `shown = recMode && !recommendationData ? [] : filter()`）。
     * 紙に出る語は画面の実物（「投稿先を探す」）に揃える。 */
    if (state.mode !== "deadlines") {
      const cards = $("recommendationCards");
      const n = cards?.children?.length ?? 0;
      box.textContent = `この印刷物: 投稿先を探す画面 ／ 候補 ${countJa(n)} 件${printedTail}`;
      return;
    }
    box.textContent =
      `この印刷物: ${describeFilters(
        state,
        (k) => KIND_LABEL[k] || k,
        (c) => Recommender.categoryLabelJa(c),
        winLabel,
        { key: sortKey, asc: sortAsc },
        sortColumnLabel,
      )}` + ` ／ 表示 ${countJa(shown.length)} 件${printedTail}`;
  }
  window.addEventListener("beforeprint", () => {
    fillPrintMeta();
    if (state.mode !== "deadlines") return;
    if (drawn >= shown.length) return;
    const target = shown.length;
    while (drawn < target) drawMore();
    printExpanded = true;
  });
  window.addEventListener("afterprint", () => {
    const box = $("printMeta");
    if (box) box.textContent = "";
    if (!printExpanded) return;
    printExpanded = false;
    render();
  });
  $("modeRecommend").addEventListener("click", () => setMode("recommend"));
  $("modeDeadlines").addEventListener("click", () => setMode("deadlines"));
  $("historyRetry").addEventListener("click", () => {
    if (state.mode !== "deadlines" || !state.past) return;
    loadHistoryData();
    render();
  });
  /* 「条件クリア」は名前の通り条件だけを外す。論文のタイトル・概要・参考論文の欄まで
   * 消していた（2026-09-23 実測: `#reset` の中に `paperText` と `paperReferences` の代入が
   * 残っていた）。絞り込みをまとめ直したいだけの人（CSV を条件なしで出したいためだけに
   * 押す人也 – てびきがそう案内している）が、打ち込んだ概要を Confirmation も Undo も無く
   * 失っていた。消す操作は、そう書かれた別のボタンに寄せる。 */
  function clearPaperInput() {
    valueElement("paperText").value = "";
    setPrimaryRecord();
    valueElement("paperReferences").value = "";
    paperFiles.value = "";
    $("paperFileLabel").textContent = "未選択";
    invalidateSemantic();
  }

  $("paperReset").addEventListener("click", () => {
    clearPaperInput();
    // 条件は触らない（`apply` は欄の中身を読み直し、候補を描き直すだけ）。
    apply();
  });

  $("reset").addEventListener("click", () => {
    state = {
      mode: state.mode,
      q: "",
      cats: [],
      kind: "",
      rank: "",
      win: "all",
      est: false,
      domestic: false,
      online: false,
      past: false,
    };
    stopHistoryLoad();
    if (state.mode === "deadlines") setDeadlineProfile(DATA);
    invalidateSemantic();
    toForm();
    writeUrl();
    render();
  });

  if (DATA.generated_at) {
    const genAtNode = $("genat");
    genAtNode.textContent = generatedAtLabel(DATA.generated_at);
    /* 日次更新の運用から日数が経ているなら、古いデータを最新と誤って使わせないために
     * その旨を出す（SPEC §7）。締切の日付を推測する話ではなく、表示しているデータの
     * 生成時刻の話。 */
    const ageNote = Recommender.dataAgeNoteJa(DATA.generated_at, Date.now());
    if (ageNote) {
      const stale = document.createElement("span");
      stale.className = "stale";
      stale.textContent = ageNote;
      genAtNode.appendChild(stale);
    }
  }
  /* データ源の行。`local` はこのサイト自身の入力で、上流の配布物ではない。
   * 内部のファイル名（`data/extra.yaml`）を画面に出さない（§7: 内部キー・実装語を出さない）。
   * また上流と並ぶ欄に自前の入力へ「MIT」を出すのは誤解を招く（配布物のライセンス表記に
   * 見える。2026-09-23 実測）。上流の出典は一次資料へ飛べるようにリンクする。 */
  function dataSourceLabels(sources: SourceRecord[]): Array<{ label: string; url: string | null }> {
    return (sources || []).map((source) => {
      const url = safeExternalUrl(source.url);
      if (source.name === "local") {
        return { label: "このサイトで収録した分（上流に無いもの）", url };
      }
      const where = source.repo
        ? `（${source.repo}${source.license ? `、${source.license}` : ""}）`
        : "";
      return { label: `${source.name}${where}`, url };
    });
  }

  const srcEls = dataSourceLabels(DATA.sources || []);
  const sourcesEl = $("sources");
  sourcesEl.textContent = "";
  if (!srcEls.length) {
    sourcesEl.textContent = "-";
  }
  srcEls.forEach((item, i) => {
    if (i) sourcesEl.appendChild(document.createTextNode(" / "));
    if (item.url) {
      const a = document.createElement("a");
      a.href = item.url;
      a.textContent = item.label;
      sourcesEl.appendChild(a);
    } else {
      sourcesEl.appendChild(document.createTextNode(item.label));
    }
  });

  const localSrc = DATA.sources.find((source) => source.name === "local");
  if (localSrc && safeExternalUrl(localSrc.url)) {
    const a = document.createElement("a");
    a.href = safeExternalUrl(localSrc.url);
    a.textContent = "リポジトリ";
    $("repolink").appendChild(document.createTextNode(" / "));
    $("repolink").appendChild(a);
  }

  readUrl();
  // URL から復元した並び順をヘッダーの矢印と aria-sort にも反映する（表の中身だけ
  // 並び、見出しが既定を指しているのは読み違えのもと）。
  setSortAria(sortKey);
  updateModeUi();
  toForm();
  if (state.mode === "deadlines" && state.past) loadHistoryData();
  render();
  restoreDrawerFromUrl();
})();
