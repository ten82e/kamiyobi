/** 早め絞り込みのボタンが担当する条件（検索語・締切種別・推定・過去表示は含まない）。 */
type PresetSelection = {
  win: string;
  rank: string;
  cats: string[];
  domestic: boolean;
  online: boolean;
};

interface SiteDeadline {
  kind: string;
  label?: string;
  precision?: "exact" | "date-only";
  local_date?: string;
  earliest_utc?: string;
  latest_utc?: string;
  utc?: string | null;
  aoe?: string | null;
  tz_raw?: string | null;
  round?: number;
  verification?: SiteVerification;
  source_name?: string;
  evidence?: Array<Record<string, unknown>>;
}

interface SiteVerification {
  official_url: string;
  source_class?: string;
  source_name?: string;
  selector_or_field?: string;
  status: string;
  last_attempt_at?: string | null;
  last_verified_at?: string | null;
  next_check_at?: string;
  content_hash?: string | null;
}

interface SiteEdition {
  year: number;
  edition_id?: string;
  link?: string;
  place?: string;
  date_text?: string;
  event_date_precision?:
    | "exact-range"
    | "single-day"
    | "month-only"
    | "not-announced"
    | "unverified";
  event_start?: string | null;
  event_end?: string | null;
  estimated?: boolean;
  estimate?: {
    point_estimate: string;
    window_start: string;
    window_end: string;
  };
  deadlines?: SiteDeadline[];
}

interface SiteConference {
  key: string;
  title: string;
  full_name?: string;
  link?: string;
  categories?: string[];
  tags?: string[];
  rank?: Record<string, string>;
  editions?: SiteEdition[];
  papers?: string[];
  acronym?: string;
  scope?: string | string[];
  official_scope?: string | string[];
  representative_papers?: string[];
  paper_abstracts?: string[];
  keywords?: string[];
}

interface SiteRow {
  conf: SiteConference;
  ed: SiteEdition;
  kind: string;
  est?: boolean;
  t: number;
  tLast?: number;
  dateOnly?: boolean;
  localDate?: string;
  cats: string[];
  tags: string[];
  rankPairs: string[];
  hay: string;
  dupLabel?: string;
  _boosted?: boolean;
  _match?: { agg?: Record<string, number>; venueHit?: boolean };
  _vocabScore?: number;
  _matchScore?: number;
  _fitLabel?: string;
  _lexicalRank?: number | null;
  _semanticRank?: number | null;
  _semScore?: number;
  _availability?: unknown;
}

interface SitePaperRecord {
  title: string;
  abstract?: string;
  keywords?: string;
  venue?: string;
}

interface SiteElement extends HTMLElement {
  value: string;
  checked: boolean;
  files: FileList | null;
}

interface SiteRecommendation {
  row: SiteRow;
  boosted?: boolean;
  match?: { agg?: Record<string, number>; venueHit?: boolean };
  fit: {
    score: number;
    lexicalScore: number;
    fieldScores?: Record<string, number>;
    fieldRanks?: Record<string, number>;
    fieldRrf?: number;
    semanticScore: number;
    label?: string;
    lexicalRank?: number | null;
    semanticRank?: number | null;
    confidenceScore?: number;
    queryConfidence?: Record<string, number | boolean>;
  };
  availability?: unknown;
}

interface SiteRecommenderApi {
  buildNameIdf(conferences: SiteConference[]): Record<string, unknown>;
  embeddingProbeMatches(meta: unknown, vector: number[]): boolean;
  embeddingSetCompatible(embeddings: unknown, language: string): boolean;
  hasJapanese(text: string): boolean;
  queryText(lines: readonly unknown[]): string;
  matchVenueTag(venue: string, conferences: SiteConference[]): SiteConference[];
  autoDetectCats(lines: readonly unknown[]): string[];
  venueCategories(lines: readonly unknown[], rows: SiteRow[]): string[];
  journalRows(conferences: SiteConference[], now: number): SiteRow[];
  pastRepresentatives(rows: SiteRow[], now: number): SiteRow[];
  rankMatches(rankPairs: string[], grade: string): boolean;
  comparePapers(a: SiteRow, b: SiteRow, now: number): number;
  candidateRows(data: unknown): SiteRow[];
  categoryLabelJa(key: unknown): string;
  categorySearchTerms(
    cats: readonly string[] | null | undefined,
    tags: readonly string[] | null | undefined,
  ): string;
  officialZone(dl: unknown): string;
  /** 検索語を語の組に分け、収録データの何行に当たるかを数える（0 件のときの案内がどの語の
   * せいかを言うため）。組の中は OR、組の間は AND なので、組の単位で数える。 */
  queryTermCounts(
    query: unknown,
    hays: readonly unknown[],
    nowMs?: number,
  ): Array<{ term: string; count: number }>;
  /** 一覧の日付欄に出す JST の曜日を、検索の語として返す（「土曜 土曜日」）。
   * 一文字（`土`）は他の語を巻くので入れていない。 */
  weekdaySearchTerms(value: unknown): string;
  /** 上流の締切名が延長を示しているか（一覧・CSV・検索で同じ判定を使う）。 */
  isExtendedDeadline(dl: unknown): boolean;
  /** 延長を示すチップの語（画面・CSV・検索で同じ語を使う）。 */
  extendedLabelJa(): string;
  placeJa(value: unknown): string;
  weekdayJaFromDate(value: unknown): string;
  deadlinesToCsv(
    rows: readonly Record<string, unknown>[] | null | undefined,
    nowMs: number,
  ): string;
  searchNormalize(value: unknown): string;
  kanaFold(value: unknown): string;
  monthTermsJa(value: unknown): string;
  placePrefectureJa(value: unknown): string;
  placeWithPrefectureJa(value: unknown): string;
  /** 会場表記にオンライン参加の記述があるか（対面かどうかは判定しない）。 */
  placeOffersOnline(value: unknown): boolean;
  /** 早め絞り込みのボタンが押されている状態か（点灯の正本）。 */
  /** 評価の等級を「よさ」の順に並べた表（選択欄・URL・並び順で同じ正本）。 */
  rankGradeOrderJa(): string[];
  /** ランク順の並びキー（等級のよさだけを見る。評価の無い行は末尾）。 */
  rankSortKey(pairs: readonly string[] | null | undefined): string;
  presetIsActive(preset: unknown, current: PresetSelection | null): boolean;
  /** 早め絞り込みのボタンを押した後の状態（自分の担当する条件だけを出し入れする）。 */
  presetNextSelection(preset: unknown, current: PresetSelection | null): PresetSelection;
  /** 空の会期・開催地・ランクを表で出す語（検索側と同じ正本）。 */
  unconfirmedLabelJa(): string;
  querySynonymNotes(query: unknown): string[];
  dayTermsJa(value: unknown): string;
  weekDayTermsJa(token: string, nowMs: number): string[];
  relativeDayNotes(query: unknown, nowMs: number): string[];
  queryHiddenKindMatches(query: unknown, hiddenKindLabels: readonly string[]): string[];
  rankPairLabelJa(pair: string): string;
  rankScaleLabelJa(name: string): string;
  rankUnratedLabelJa(): string;
  rankSearchTerms(rankPairs: readonly string[] | null | undefined): string;
  expandRelativeMonths(query: unknown, nowMs: number): string;
  queryTokenGroups(query: unknown): string[][];
  queryTokens(query: unknown): string[];
  hayMatches(hay: unknown, query: unknown): boolean;
  /** 検索語ごとの照合関数を 1 回だけ作る（一覧の絞り込みは行ごとに作り直さない）。 */
  searchMatcher(query: unknown, nowMs?: number): (hay: unknown) => boolean;
  scheduleOnlyEditions(data: unknown): Array<{
    key: string;
    name: string;
    link: string;
    place: string;
    eventStart: string;
    eventEnd: string;
    cats: string[];
    tags: string[];
    hay: string;
  }>;
  tagLabelJa(tag: unknown): string;
  topicTagsJa(tags: readonly string[] | null | undefined): string[];
  safeExternalUrl(value: unknown): string;
  pdfPaperRecord(metadata: unknown, pages: unknown[], fallbackText: string): SitePaperRecord;
  textPaperRecord(text: string, fallbackText: string): SitePaperRecord;
  parsePaperLines(text: string): SitePaperRecord[];
  fieldedLexicalScore(
    paper: SitePaperRecord,
    conference: SiteConference,
  ): { score: number; fields: Record<string, number> };
  contentWordCount(text: string): number;
  semanticScore(key: string, vector: number[], embeddings: Record<string, number[]>): number;
  blendVectors(left: number[], right: number[], weight: number): number[];
  setNameIdf(value: Record<string, unknown>): void;
  setPaperVecs(value: Record<string, number[][]> | null): void;
  setReranker(value: Record<string, unknown> | null): void;
  venueRecommendations(
    rows: SiteRow[],
    lines: readonly unknown[],
    semanticScores: Record<string, number> | null,
    now: number,
    options?: Record<string, unknown>,
  ): SiteRecommendation[];
}

interface SiteCatalog {
  generated_at: string;
  sources: Array<Record<string, unknown>>;
  categories: Record<string, string>;
  conferences: SiteConference[];
  history_ref?: string;
  recommendation_ref?: string;
  reranker?: Record<string, unknown>;
}

interface PdfTextItem {
  str?: string;
  transform?: number[];
}

interface PdfPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
}

interface PdfDocument {
  numPages: number;
  getPage(page: number): Promise<PdfPage>;
  getMetadata(): Promise<{ info?: Record<string, unknown> }>;
}

interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy?: () => void | Promise<void>;
}

interface PdfJsRuntime {
  version?: string;
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(options: { data: ArrayBuffer }): PdfLoadingTask;
}

interface Window {
  __KAMIYOBI_DATA__: SiteCatalog | null;
  Recommender?: SiteRecommenderApi;
  pdfjsLib?: PdfJsRuntime;
  applyPreset?: (type: string) => void;
  toggleSort?: (key: string | null) => void;
  openDrawer?: (row: unknown) => void;
  closeDrawer?: (event?: Event) => void;
  _prevFocus?: HTMLElement | null;
  _activeRef?: HTMLElement | null;
}
