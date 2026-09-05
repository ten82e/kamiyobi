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
};

interface DrawerRow {
  conf: {
    key?: string;
    title?: string;
    full_name?: string;
    link?: string;
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
  // SPEC.md section 7: catalog.json is injected by the build. Defaults to empty so that
  // opening the template standalone displays a blank table instead of throwing.
  const DATA = catalogFrom(window.__KAMIYOBI_DATA__) ?? {
    generated_at: "",
    sources: [],
    categories: {},
    conferences: [],
  };

  const DAY = 86400000;
  const PAGE = 40;
  let selectedIndex = -1;
  let sortKey = "rem";
  let sortAsc = true;

  const KIND_LABEL: Record<string, string> = {
    abstract: "概要締切",
    paper: "論文締切",
    journal: "常時受付",
  };

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
    past: false,
  };

  function $(id: string): HTMLElement {
    const element = document.getElementById(id);
    if (!element) throw new Error(`missing element #${id}`);
    return element;
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

  function fmtJst(d: Date) {
    const jst = new Date(d.getTime() + 9 * 3600000);
    return (
      jst.getUTCFullYear() +
      "-" +
      pad(jst.getUTCMonth() + 1) +
      "-" +
      pad(jst.getUTCDate()) +
      " " +
      pad(jst.getUTCHours()) +
      ":" +
      pad(jst.getUTCMinutes()) +
      " JST"
    );
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

  function catLabel(key: string) {
    return DATA.categories?.[key] ? key.toUpperCase() : key;
  }

  // タイトル + 開催年。タイトルが既にその年で終わっていれば年を二重に付けない。
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

  // Quick Presets
  function updatePresetActive() {
    const p7d =
      state.win === "7d" &&
      !state.q &&
      !state.cats.length &&
      !state.kind &&
      !state.rank &&
      !state.est &&
      !state.domestic &&
      !state.past;
    const paStar =
      state.rank === "A*" &&
      !state.q &&
      !state.cats.length &&
      !state.kind &&
      state.win === "all" &&
      !state.est &&
      !state.domestic &&
      !state.past;
    const pHpcSys =
      state.cats.length === 2 &&
      state.cats.indexOf("hpc") >= 0 &&
      state.cats.indexOf("systems") >= 0 &&
      !state.q &&
      !state.kind &&
      !state.rank &&
      state.win === "all" &&
      !state.est &&
      !state.domestic &&
      !state.past;
    const pDom =
      state.domestic &&
      !state.q &&
      !state.cats.length &&
      !state.kind &&
      !state.rank &&
      state.win === "all" &&
      !state.est &&
      !state.past;
    const map: Record<string, boolean> = {
      "7d": p7d,
      a_star: paStar,
      hpc_sys: pHpcSys,
      domestic: pDom,
    };
    document.querySelectorAll<HTMLElement>(".preset-btn").forEach((btn) => {
      const p = btn.getAttribute("data-preset");
      btn.classList.toggle("active", p !== null && Boolean(map[p]));
    });
  }

  window.applyPreset = (type: string) => {
    state = {
      mode: state.mode,
      q: "",
      cats: [],
      kind: "",
      rank: "",
      win: "all",
      est: false,
      domestic: false,
      past: false,
    };
    if (type === "7d") state.win = "7d";
    if (type === "a_star") state.rank = "A*";
    if (type === "hpc_sys") state.cats = ["hpc", "systems"];
    if (type === "domestic") state.domestic = true;
    stopHistoryLoad();
    if (state.mode === "deadlines") setDeadlineProfile(DATA);
    toForm();
    writeUrl();
    render();
  };

  // Column Sorting
  // 現在の並び順を aria-sort でスクリーンリーダーに伝える（昇順/降順/指定なし）。
  function setSortAria(key: string | null) {
    document.querySelectorAll<HTMLTableCellElement>("th[data-sort]").forEach((th) => {
      const k = th.getAttribute("data-sort");
      let state = "none";
      if (k === key) {
        state = sortAsc ? "ascending" : "descending";
      }
      th.setAttribute("aria-sort", state);
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

    let html =
      '<div style="background: let(--chip); padding: 14px; border-radius: 6px; border: 1px solid let(--border); margin-bottom: 16px;">' +
      '<div style="font-size: 0.78rem; color: let(--muted);">種別・日時</div>' +
      '<div style="font-size: 1.1rem; font-weight: 600; color: let(--fg); margin-top: 2px;">' +
      esc(KIND_LABEL[r.kind] || r.kind) +
      "</div>" +
      (r.kind === "journal"
        ? '<div style="font-family: let(--font-mono); font-size: 0.85rem; color: let(--accent); margin-top: 4px;">随時受付（締切なし）</div>'
        : r.dateOnly
          ? '<div style="font-family: let(--font-mono); font-size: 0.85rem; color: let(--accent); margin-top: 4px;">' +
            esc(r.localDate) +
            dateOnlyText +
            "</div>"
          : '<div style="font-family: let(--font-mono); font-size: 0.85rem; color: let(--accent); margin-top: 4px;">' +
            fmtDate(new Date(r.t)) +
            " UTC (" +
            fmtJst(new Date(r.t)) +
            " / " +
            fmtAoE(new Date(r.t)) +
            ")</div>") +
      "</div>";

    let actionRow = "";
    if (r.kind === "journal") {
      actionRow =
        '<div style="font-size: 0.85rem; color: let(--muted); margin-bottom: 16px;">常時受付のジャーナル（締切なし）です。投稿規程を公式サイトで確認してください。</div>';
    } else {
      actionRow =
        '<div style="font-size: 0.85rem; color: let(--muted); margin-bottom: 16px;">投稿前に公式サイトで最新の募集要項と締切を確認してください。</div>';
    }
    html += actionRow;

    const officialLink = safeExternalUrl(r.ed.link || r.conf.link);
    if (officialLink) {
      html +=
        '<a href="' +
        esc(officialLink) +
        '" target="_blank" style="display: block; text-align: center; background: let(--accent); color: #fff; text-decoration: none; padding: 10px; border-radius: 6px; font-weight: 600; margin-bottom: 20px;">公式サイトを開く</a>';
    }

    html +=
      '<div style="font-size: 0.85rem;">' +
      '<p style="margin-bottom: 8px;"><strong>開催地:</strong> ' +
      esc(r.ed.place || "未定") +
      "</p>" +
      '<p style="margin-bottom: 8px;"><strong>会期:</strong> ' +
      esc(r.ed.date_text || r.ed.event_start || "未定") +
      "</p>" +
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
      // フォーカスを開く直前の要素へ戻す。
      const prev = window._prevFocus;
      window._prevFocus = null;
      if (prev?.focus) prev.focus();
    }
  }
  window.closeDrawer = closeDrawer;

  // Keyboard Navigation (j/k/Enter/Esc//)
  function onKeydown(e: KeyboardEvent) {
    const target = e.target;
    if (!target || !("tagName" in target) || typeof target.tagName !== "string") return;
    const tag = target.tagName;
    const isContentEditable = "isContentEditable" in target && target.isContentEditable === true;
    if (
      tag === "INPUT" ||
      tag === "SELECT" ||
      tag === "TEXTAREA" ||
      tag === "BUTTON" ||
      isContentEditable
    ) {
      if (e.key === "Escape") {
        if ("blur" in target && typeof target.blur === "function") target.blur();
      }
      return;
    }
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
      const dtrs = [...$("tbody").querySelectorAll<HTMLTableRowElement>("tr")].filter(
        (row) => !row.classList.contains("detail-row"),
      );
      if (dtrs[selectedIndex]) dtrs[selectedIndex].focus();
      openDrawer(shown[selectedIndex]);
    } else if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      if (selectedIndex < shown.length - 1) {
        selectedIndex++;
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

  function updateRowSelection() {
    // 展開用 detail-row を除外し、shown[] の行と 1:1 対応を保つ
    const trs = [...$("tbody").querySelectorAll<HTMLTableRowElement>("tr")].filter(
      (row) => !row.classList.contains("detail-row"),
    );
    trs.forEach((tr, idx) => {
      tr.classList.toggle("selected", idx === selectedIndex);
    });
    if (trs[selectedIndex]) {
      trs[selectedIndex].scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  // ---- CATEGORIES ----
  const catsBox = $("cats");
  Object.keys(DATA.categories).forEach((k) => {
    const lbl = document.createElement("label");
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.value = k;
    lbl.appendChild(chk);
    const span = document.createElement("span");
    span.textContent = `${k.toUpperCase()} (${DATA.categories[k]})`;
    lbl.appendChild(span);
    catsBox.appendChild(lbl);
  });

  // ---- SELECTS ----
  const kindSel = $("kind");
  const optAllK = document.createElement("option");
  optAllK.value = "";
  optAllK.textContent = "投稿締切（概要・論文）";
  kindSel.appendChild(optAllK);
  Object.keys(KIND_LABEL).forEach((k) => {
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
  ["A*", "A", "B", "C", "N"].forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r;
    opt.textContent = `Rank ${r}`;
    rankSel.appendChild(opt);
  });

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
    const diff = ms - Date.now();
    if (diff < 0) {
      const pd = Math.floor(-diff / DAY);
      return { text: pd === 0 ? "本日終了" : `${pd} 日前に終了`, cls: "past" };
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
        clearSemantic("error");
        render();
        return;
      }
      const modelMeta = bundle.manifest.models[language];
      if (!modelMeta) {
        clearSemantic("error");
        render();
        return;
      }
      loadTransformers(modelMeta, generation, (loaded) => {
        if (!semanticIsCurrent(generation, text)) return;
        if (!loaded || semLoadedModel !== `${modelMeta.model}@${modelMeta.revision}` || !semModel) {
          clearSemantic("error");
          render();
          return;
        }
        checkSemanticProbe(modelMeta, (probeOk) => {
          if (!semanticIsCurrent(generation, text)) return;
          if (!probeOk) {
            clearSemantic("error");
            render();
            return;
          }
          const lines = Recommender.parsePaperLines(text);
          const q = Recommender.queryText(lines);
          const model = semModel;
          if (!model) {
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
              clearSemantic("error");
              render();
            });
        });
      });
    });
  }

  // ---- FILTERING ----
  function filter(): AppRow[] {
    const now = Date.now();
    const isPast = (row: AppRow) => (row.dateOnly ? now > row.tLast : row.t < now);
    const isAfter = (row: AppRow, dateLimit: number) => row.t > dateLimit;
    const q = state.q.toLowerCase();
    const isWinFuture = state.win === "future";
    const limit =
      state.win === "all" || isWinFuture ? Infinity : now + parseInt(state.win, 10) * DAY;
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

    // 分野: 手動チップがあればそれで絞る。論文モードでチップが空なら絞らない
    // （スコア順ソートで自然に候補が上位に来る）。
    const cats = state.cats;
    // 掲載先タグの属するカテゴリ（例: RTSS タグ → systems）。同カテゴリの会議を僅かにブースト
    const venueCats = pLines.length && Rec ? Rec.venueCategories(pLines, rows) : [];

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

    // 推薦モード（論文入力あり）では締切画面用の検索/種別/ランク/期間/分野/国内/推定/過去フィルタを
    // 適用しない。pool は既に未来締切+常時受付+過去代表行で構成済み。
    const inRecommend = state.mode === "recommend" && pLines.length > 0;

    let out: AppRow[] = pool.filter((r) => {
      if (!inRecommend && !state.est && r.est && !pLines.length) {
        return false;
      }
      // 過去行は通常モードで除外（「過去の締切も表示」トグルで表示）。
      // 論文モードでは「締切済みだが次回予定あり」の会議として許容
      if (isPast(r) && !pLines.length && !state.past) {
        return false;
      }
      if (r.est && isPast(r)) {
        return false;
      }
      // このサイトは「これから投稿できるところ」を探すもの。
      // 投稿締切（概要・論文）以外の種別（開催・採否通知等）は表示しない。
      // 論文モードまたは種別指定時のみ常時受付ジャーナル（kind: journal）を許容する。
      if (
        r.kind !== "abstract" &&
        r.kind !== "paper" &&
        !((pLines.length || state.kind === "journal") && r.kind === "journal")
      ) {
        return false;
      }
      if (!inRecommend && isAfter(r, limit)) {
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
          return false;
        }
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
          return false;
        }
      }
      if (!inRecommend && state.domestic && (r.tags || []).indexOf("domestic-jp") < 0) {
        return false;
      }
      if (!inRecommend && q && r.hay.indexOf(q) < 0) {
        return false;
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

    // Custom Sorting
    out.sort((a, b) => {
      if (pLines.length && Rec) {
        return Rec.comparePapers(a, b, now);
      }
      const mult = sortAsc ? 1 : -1;
      if (sortKey === "conf") {
        return (a.conf.title || "").localeCompare(b.conf.title || "") * mult;
      } else if (sortKey === "rank") {
        const ar = a.rankPairs[0] || "";
        const br = b.rankPairs[0] || "";
        return (ar === br ? 0 : ar > br ? 1 : -1) * mult;
      }
      return (a.t - b.t) * mult;
    });

    return out;
  }

  // ---- RENDERING ----
  let shown: AppRow[] = [];
  let drawn = 0;

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
      : remain(r.t);
    // 常時受付ジャーナルは締切の概念がないため「本日終了」等の誤解を与えない表示にする
    if (r.kind === "journal") {
      rem = { text: "常時受付", cls: "" };
    }

    const c0 = td(tr, "残り", "c-deadline");
    line(c0, rem.text, `left ${rem.cls}`);

    const c1 = td(tr, "日時");
    if (r.kind === "journal") {
      line(c1, "随時受付", "nowrap");
    } else if (r.dateOnly) {
      line(c1, r.localDate, "nowrap");
      line(c1, "時刻未確認", "sub nowrap");
    } else {
      const d = new Date(r.t);
      line(c1, `${fmtDate(d)} UTC`, "nowrap");
      line(c1, fmtJst(d), "sub nowrap");
      line(c1, fmtAoE(d), "sub nowrap");
    }

    const c2 = td(tr, "会議");
    const head = document.createElement("div");
    head.className = "conf";
    const name = titleWithYear(r.conf.title || r.conf.key || "", r.ed.year);
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
      const ms = document.createElement("span");
      // match-trigger: クリックで行内展開（この会議が選ばれた理由の内訳）
      ms.className = "tag match match-trigger";
      ms.textContent = `一致評価 ${r._fitLabel || "評価保留"} ▾`;
      if (r._match?.agg) {
        const agg = r._match.agg;
        const parts: string[] = [];
        if (agg.domain > 0) parts.push(`分野シグナル +${agg.domain}`);
        if ((agg.venueName || 0) > 0) parts.push(`会議名一致 +${agg.venueName}`);
        if (agg.paper > 0) parts.push(`採択論文一致 +${agg.paper}`);
        if (agg.jp > 0) parts.push(`日本語一致 +${agg.jp}`);
        if (agg.tags > 0) parts.push(`領域タグ +${agg.tags}`);
        if (agg.venue > 0) parts.push("過去掲載先一致");
        if ((r._semScore ?? 0) > 0) parts.push(`意味類似度 ${r._semScore}点`);
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
    const detail: string[] = [];
    if (r.dl.round && r.dl.round > 1) {
      detail.push(`第 ${r.dl.round} ラウンド`);
    }
    if (r.dl.label) {
      detail.push(r.dl.label);
    }
    if (detail.length) {
      line(c3, detail.join(" / "), "sub");
    }

    const c4 = td(tr, "ランク");
    if (r.rankPairs.length) {
      r.rankPairs.forEach((p) => {
        const s = p.split(":");
        const e = document.createElement("span");
        e.className = "tag";
        e.textContent = `${s[0].toUpperCase()} ${s[1]}`;
        c4.appendChild(e);
      });
    } else {
      line(c4, "-", "sub");
    }

    const c5 = td(tr, "会期");
    let span = "-";
    if (r.ed.event_start) {
      span =
        r.ed.event_end && r.ed.event_end !== r.ed.event_start
          ? `${r.ed.event_start} 〜 ${r.ed.event_end}`
          : r.ed.event_start;
    }
    line(c5, span, "sub nowrap");

    const c6 = td(tr, "開催地");
    line(c6, r.ed.place || "-", "sub");

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
    const verification = dl?.verification;
    if (!verification) return "";
    const sourceLabels: Record<string, string> = {
      "official-cfp": "公式CFP",
      publisher: "出版社ページ",
      "official-homepage": "公式ホームページ",
      aggregator: "集約サイト",
    };
    const statusLabels: Record<string, string> = {
      verified: "確認済み",
      pending: "再確認待ち",
      changed: "変更を検出",
      retryable: "再試行待ち",
      "source-unreachable": "公式ページ取得不能",
      "parser-failed": "複数候補のため要確認",
      "manual-required": "複数候補のため要確認",
    };
    const evidence = (dl.evidence ?? []).find((item) => item.verifiedFields);
    const fields = Array.isArray(evidence?.verifiedFields)
      ? evidence.verifiedFields.join("・")
      : verification.selector_or_field || "日付・時刻・タイムゾーン";
    const verifiedAt = verification.last_verified_at
      ? new Date(verification.last_verified_at).toLocaleString("ja-JP")
      : "未確認";
    return (
      '<div class="verification-summary"><b>公式確認</b> ' +
      esc(verifiedAt) +
      "<br><b>確認元</b> " +
      esc(sourceLabels[verification.source_class || ""] || verification.source_class || "公式") +
      "<br><b>確認範囲</b> " +
      esc(fields) +
      "<br><b>状態</b> " +
      esc(statusLabels[verification.status || ""] || verification.status || "未確認") +
      (verification.next_check_at
        ? "<br><b>次回確認予定</b> " +
          esc(new Date(verification.next_check_at).toLocaleString("ja-JP"))
        : "") +
      "</div>"
    );
  }

  function makeDetailRow(r: AppRow) {
    const tr = document.createElement("tr");
    tr.className = "detail-row";
    const td = document.createElement("td");
    td.colSpan = 7;
    const m: ScoreBreakdown | undefined = r._match;
    const agg = m?.agg ?? { domain: 0, name: 0, paper: 0, jp: 0, tags: 0, venue: 0 };
    let lines: PaperRecord[] = [];
    const paperText = valueElement("paperText").value;
    if (paperText.trim()) {
      lines = Recommender.parsePaperLines(paperText);
    }

    const chips: Array<[string, string, string]> = [];
    if (agg.domain > 0)
      chips.push([
        "分野シグナル",
        `+${agg.domain}`,
        "会議のカテゴリと論文キーワードが一致（HPC/AI/Security 等）",
      ]);
    if ((agg.venueName || 0) > 0)
      chips.push([
        "会議名一致",
        `+${agg.venueName}`,
        "会議名の内容語が論文タイトル・キーワードに含まれる",
      ]);
    if (agg.paper > 0)
      chips.push(["採択論文一致", `+${agg.paper}`, "この会議の代表採択論文の語彙と一致"]);
    if (agg.jp > 0) chips.push(["日本語一致", `+${agg.jp}`, "日本語の会議名・論文語が一致"]);
    if (agg.tags > 0)
      chips.push(["領域タグ", `+${agg.tags}`, "会議の領域タグ（real-time 等）が論文に含まれる"]);
    if (agg.venue > 0)
      chips.push([
        "過去掲載先一致",
        "補助",
        "過去に同じ掲載先が確認された補助シグナル（トピック一致とは別）",
      ]);
    if ((r._semScore ?? 0) > 0)
      chips.push([
        "意味検索候補",
        `順位 ${r._semanticRank || "—"}`,
        "埋め込み検索の候補順位を RRF に加算",
      ]);
    if (r._boosted)
      chips.push(["同分野ブースト", "+10", "掲載先タグから推定した分野とこの会議が一致"]);
    if (!chips.length) chips.push(["一致要素なし", "—", "低スコアでも閾値を超えたため表示"]);

    let html = '<div class="detail-inner">';
    html +=
      '<div class="detail-head">一致評価 ' +
      esc(r._fitLabel || "評価保留") +
      " の内訳（この会議が選ばれた理由）</div>";
    let comp: string;
    if (r._semanticRank) {
      comp =
        "RRF: 語彙検索順位 " +
        (r._lexicalRank || "—") +
        " + 意味検索順位 " +
        r._semanticRank +
        " → 一致評価 " +
        esc(r._fitLabel || "評価保留");
    } else if (semState === "loading") {
      comp = `語彙スコア ${r._vocabScore}点（意味検索を実行中…）`;
    } else if (semState === "error") {
      comp = `語彙スコア ${r._vocabScore}点（埋め込みが使えないため意味検索なし）`;
    } else {
      comp = `語彙スコア ${r._vocabScore}点`;
    }
    html +=
      '<div class="detail-comp">' +
      comp +
      (m?.evidence?.some((evidence) => evidence.rank) ? "（順位情報を RRF で集約）" : "") +
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
            "</b><em>" +
            esc(chip[1]) +
            "</em></span>",
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
    if (next?.classList.contains("detail-row")) {
      next.remove();
      return;
    }
    tr.parentNode?.insertBefore(makeDetailRow(r), tr.nextSibling);
  }

  function drawMore() {
    const tbody = $("tbody");
    const frag = document.createDocumentFragment();
    const end = Math.min(drawn + PAGE, shown.length);
    for (let i = drawn; i < end; i++) {
      frag.appendChild(makeRow(shown[i]));
    }
    tbody.appendChild(frag);
    drawn = end;
    const btn = $("more");
    if (drawn < shown.length) {
      btn.hidden = false;
      btn.textContent = `さらに表示 (残り ${shown.length - drawn} 件)`;
    } else {
      btn.hidden = true;
    }
  }

  function recommendationAvailability(r: AppRow) {
    const a = r._availability;
    if (!a) return "受付状況不明";
    if (a.status === "ongoing") return "常時受付";
    if (a.status === "uncertain" && a.local_date) {
      return `次回締切: ${a.local_date}（時刻未確認。終了済みの可能性があります）`;
    }
    if (a.status === "open" && a.local_date) {
      return `次回締切: ${a.local_date}（時刻未確認）`;
    }
    if (a.status === "open" && a.timestamp) {
      return (
        "次回締切: " +
        fmtDate(new Date(a.timestamp)) +
        " UTC / " +
        fmtAoE(new Date(a.timestamp)) +
        (a.estimated ? "（推定）" : "")
      );
    }
    if (a.status === "past") {
      return a.timestamp || a.local_date ? "締切済み" : "締切済み（次回情報なし）";
    }
    return "受付状況不明";
  }

  const trustLabel: Record<string, string> = {
    official: "公式確認",
    publisher: "出版社確認",
    "curated-manual": "手動確認",
    aggregator: "集約情報",
    assumption: "推定",
    unverified: "未確認",
  };
  const freshnessLabel: Record<string, string> = {
    fresh: "最新取得",
    "cache-fallback": "キャッシュ退避",
    "snapshot-fallback": "スナップショット退避",
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
      `研究適合度: ${r._fitLabel || "評価保留"}（順位評価）`,
      "card-section recommendation-axes",
    );
    line(
      card,
      `会議履歴: ${maturityLabel[axes.venue_maturity.status]}（観測年数 ${maturityEvidence.yearsObserved}年、プロフィール ${maturityEvidence.profileCoverage}件）`,
      "card-section recommendation-axes",
    );
    line(
      card,
      `締切: ${recommendationAvailability(r)} ／ 種別: ${KIND_LABEL[r.kind] || r.kind || "未確認"}`,
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
      ["分野シグナル", agg.domain],
      ["会議名一致", agg.venueName ?? 0],
      ["採択論文一致", agg.paper],
      ["日本語一致", agg.jp],
      ["領域タグ", agg.tags],
    ];
    reasonSignals.forEach((item) => {
      if (item[1] > 0) reasons.push(`${item[0]} +${item[1]}`);
    });
    if (agg.venue > 0) reasons.push("過去掲載先一致");
    if (r._semanticRank) reasons.push(`意味検索順位 ${r._semanticRank}`);
    if (r._boosted) reasons.push("同分野ブースト");
    line(
      card,
      reasons.length ? `選定理由: ${reasons.join(" / ")}` : "選定理由: 一致要素を確認できる候補",
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
        "投稿予定論文のタイトル・概要・PDF/TXTを入力してください。",
        "recommendation-card",
      );
      return;
    }
    if (!list.length) {
      line(
        cards,
        "該当する投稿先がありません。論文本文を長めに入れるか、条件を変えてみてください。",
        "recommendation-card",
      );
      return;
    }
    list.slice(0, 5).forEach((r) => {
      cards.appendChild(makeRecommendationCard(r, now));
    });
  }

  function render() {
    const recMode = state.mode === "recommend";
    if (recMode && !recommendationData && !recommendationError) loadRecommendationData();
    shown = recMode && !recommendationData ? [] : filter();
    drawn = 0;
    selectedIndex = -1;
    $("tbody").textContent = "";
    const paperText = valueElement("paperText").value;
    const paperMode = recMode && Boolean(paperText.trim());
    let cnt = paperMode
      ? `あなたの論文に合う投稿先 ${shown.length} 件`
      : recMode
        ? "投稿先を探すには論文情報を入力してください"
        : `${shown.length} 件 / 全 ${rows.length} 件`;
    if (!recMode && state.past && historyStatus === "loading") cnt += " ｜ 全履歴を読み込み中…";
    if (!recMode && state.past && historyStatus === "error")
      cnt += " ｜ 全履歴を読み込めませんでした";
    if (paperMode) {
      const _lines = Recommender.parsePaperLines(paperText);
      const _auto = _lines.length ? Recommender.autoDetectCats(_lines) : [];
      if (_auto.length && !state.cats.length) {
        cnt +=
          " ｜ 分野自動判定: " +
          _auto.map((k) => (DATA.categories[k] ? DATA.categories[k] : k)).join(", ");
      }
      // 意味検索の状態を明示（初回はモデル読込に数秒かかる）
      if (semState === "loading") {
        cnt += " ｜ 意味検索を実行中…";
      } else if (semState === "error") {
        cnt += " ｜ 意味検索は利用不可（埋め込みが使えないため語彙検索のみ）";
      }
    }
    $("count").textContent = cnt;
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
      $("more").hidden = true;
      renderRecommendationCards(paperMode ? shown : []);
    } else {
      $("deadlineTableWrap").hidden = false;
      $("recommendationCards").hidden = true;
      if (!shown.length) {
        $("empty").textContent = "該当する締切はありません。";
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
        setRecommendationProfile(result.index);
        render();
      })
      .catch(() => {
        recommendationError = true;
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
    state.mode = p.get("mode") === "recommend" ? "recommend" : "deadlines";
    state.q = p.get("q") || "";
    state.kind = KIND_LABEL[p.get("kind") || ""] ? p.get("kind") || "" : "";
    const rawRank = p.get("rank");
    state.rank = ["A*", "A", "B", "C", "N"].indexOf(rawRank || "") >= 0 ? rawRank || "" : "";
    const rawWin = p.get("win");
    state.win =
      ["all", "7d", "30d", "90d", "180d", "future"].indexOf(rawWin || "") >= 0
        ? rawWin || ""
        : "all";
    state.est = p.get("est") === "1";
    state.domestic = p.get("domestic") === "1";
    state.past = p.get("past") === "1";
    state.cats = (p.get("cats") || "")
      .split(",")
      .filter((category) => Boolean(category) && Boolean(DATA.categories[category]));
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
    if (state.past) p.set("past", "1");
    if (state.cats.length) p.set("cats", state.cats.join(","));
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
  function readPaperFile(file: File, signal: AbortSignal): Promise<PaperRecord> {
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
    const load: Promise<void> = files.some((file) => !/\.txt$/i.test(file.name))
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
        const name = error instanceof Error ? error.name : "Error";
        const message = error instanceof Error ? error.message : String(error);
        label.textContent =
          name === "AbortError"
            ? "PDF 読込をキャンセルしました"
            : `PDF 読込に失敗しました: ${message}`;
      })
      .finally(() => {
        if (job === pdfJob) {
          pdfAbortController = null;
          cancelPdf.hidden = true;
        }
      });
    target.value = "";
  });

  // ---- wiring ----
  let timer: ReturnType<typeof setTimeout> | undefined;
  $("q").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(apply, 180);
  });
  $("paperText").addEventListener("input", () => {
    invalidateSemantic();
    clearTimeout(timer);
    timer = setTimeout(() => {
      apply();
      scheduleSemantic();
    }, 200);
  });
  ["paperPrimaryTitle", "paperPrimaryAbstract", "paperPrimaryKeywords", "paperReferences"].forEach(
    (id) => {
      $(id).addEventListener("input", () => {
        syncPaperText();
        invalidateSemantic();
        clearTimeout(timer);
        timer = setTimeout(() => {
          apply();
          scheduleSemantic();
        }, 200);
      });
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
  ["kind", "rank", "win", "est", "domestic", "past"].forEach((id) => {
    $(id).addEventListener("change", apply);
  });
  catsBox.addEventListener("change", apply);
  $("more").addEventListener("click", drawMore);
  $("modeRecommend").addEventListener("click", () => setMode("recommend"));
  $("modeDeadlines").addEventListener("click", () => setMode("deadlines"));
  $("historyRetry").addEventListener("click", () => {
    if (state.mode !== "deadlines" || !state.past) return;
    loadHistoryData();
    render();
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
      past: false,
    };
    valueElement("paperText").value = "";
    setPrimaryRecord();
    valueElement("paperReferences").value = "";
    paperFiles.value = "";
    $("paperFileLabel").textContent = "未選択";
    stopHistoryLoad();
    if (state.mode === "deadlines") setDeadlineProfile(DATA);
    invalidateSemantic();
    toForm();
    writeUrl();
    render();
  });

  if (DATA.generated_at) {
    $("genat").textContent = `データ生成: ${DATA.generated_at}`;
  }
  const srcs = (DATA.sources || []).map(
    (source) =>
      source.name +
      (source.repo ? ` (${source.repo}${source.license ? `, ${source.license}` : ""})` : ""),
  );
  $("sources").textContent = srcs.length ? srcs.join(" / ") : "-";

  const localSrc = DATA.sources.find((source) => source.name === "local");
  if (localSrc && safeExternalUrl(localSrc.url)) {
    const a = document.createElement("a");
    a.href = safeExternalUrl(localSrc.url);
    a.textContent = "リポジトリ";
    $("repolink").appendChild(document.createTextNode(" / "));
    $("repolink").appendChild(a);
  }

  readUrl();
  updateModeUi();
  toForm();
  if (state.mode === "deadlines" && state.past) loadHistoryData();
  render();
})();
