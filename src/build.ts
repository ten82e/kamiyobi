/**
 * Output generation: JSON / CSV / Markdown / llms.txt / HTML.
 *
 * Everything under public/ is produced here.  Rendering is a pure function of
 * (conferences, config, now) so that two runs with the same input are byte-identical.
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
import type { IcsCalendarMeta, IcsRow } from "../site/ics.ts";

import {
  ICS_CAL_NAME_JA,
  icsCalendarMeta,
  icsCalendarText,
  icsCategoryLabels,
  icsEventBody,
  icsUidSafe,
  jstParts,
  statusMarksJa,
} from "../site/ics.ts";
import { recommendationAxes, type SourceFreshness } from "../site/recommendation-core.ts";

export type { IcsCalendarMeta, IcsRow } from "../site/ics.ts";
export {
  ICS_CAL_NAME_JA,
  icsCalendarDescriptionJa,
  icsCalendarMeta,
  icsCalendarText,
  icsCategoryLabels,
  icsCategoryList,
  icsDayIso,
  icsEscapeText,
  icsEventBody,
  icsFoldLine,
  icsNextDay,
  icsUidSafe,
  jstParts,
  statusMarksJa,
} from "../site/ics.ts";

import Recommender, { isValidRerankerModel } from "../site/recommender.ts";
import { consolidateReviewedSubmissions, reviewedSubmission } from "../site/submission-identity.ts";
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
  getVenuePapers,
  venuePapersHash,
} from "./embeddings.ts";
import {
  type IdentityMigration,
  type IdentityMigrationManifest,
  identityKey,
  identityMigrationManifestForData,
  isIdentityMigrationManifest,
  matchesIdentitySelector,
  validateIdentityMigrationManifest,
} from "./identity-migration.ts";
import { DEADLINE_SELECTION_RULE } from "./merge.ts";
import {
  addDays,
  asDate,
  type Conference,
  cmpStr,
  computeNextCheckAt,
  DAY_MS,
  type Deadline,
  type DeadlineEvidence,
  dateOnly,
  dateOnlyState,
  dateOnlyWindow,
  deadlineTrackKey,
  type Edition,
  eventDatePrecisionOf,
  evidenceClassOf,
  exactDeadlineState,
  fmtDate,
  fmtUTC,
  isDateOnlyDeadline,
  isExactDeadline,
  supersededDeadlinesOf,
  warningCounts,
  warningSummaries,
} from "./model.ts";

export let ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SITE_RUNTIME_FILES = [
  "recommender.js",
  "place-aliases.js",
  "topic-aliases.js",
  "latin-retype.js",
  "recommendation-core.js",
  "recommendation.js",
  "publish.js",
  "ics.js",
  "app.js",
  "submission-identity.js",
] as const;

const MANAGED_OUTPUT_FILES = [
  "index.html",
  "data.json",
  "health.json",
  "health.md",
  "publish.json",
  "catalog.json",
  "recommendation-index.json",
  "data.csv",
  "upcoming.md",
  "upcoming.html",
  "404.html",
  "robots.txt",
  "sitemap.xml",
  "deadlines.ics",
  "llms.txt",
  "icon.svg",
  ".nojekyll",
  "embeddings.json",
  ...SITE_RUNTIME_FILES,
] as const;

function clearManagedOutput(outdir: string, removeEmbeddings: boolean): void {
  for (const name of MANAGED_OUTPUT_FILES) {
    if (name === "embeddings.json" && !removeEmbeddings) continue;
    rmSync(join(outdir, name), { force: true });
  }
}

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

// 種別の日本語表記はサイト側（site/recommender.ts）が正典。md も同じ表を使うことで、
// 「表示されている語で検索できる」状態を保つ。
export const KIND_LABEL_JA: Record<string, string> = Recommender.kindLabelTable();

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
  { name: "local", repo: "data/manual.yaml + data/curated.generated.yaml", license: "MIT" },
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
  /* 日本語の種別。`upcoming.md` と `deadlines.ics` は最初から日本語の種別を出していたのに、
   * この表だけ上流の英語（`paper` など）と、揺れる自由文の `label`（'Paper submission' /
   * 'Paper Submission' / 'Paper submission deadline' が同じ物として並ぶ）に頼る形だった
   * （2026-09-23 実測: 3,253 行のうち日本語の種別欄は 0）。画面と同じ語を**同じ正本**
   * （`KIND_LABEL_JA`）から入れるので、言い回しは増えない。列の順序で読む下流を壊さない
   * よう、**末尾に置く**。 */
  "kind_ja",

  "date_field",
  "event_segments",

  "verification_status",
  "verification_source_class",
  "extended",
];

/* `data.csv` の列辞書。列名は `CSV_COLUMNS` から書き出し、説明だけをここに持つ（列を足したときに
 * 名前の方が古くなる事故を防ぐため、説明側は名前で引く）。空欄の意味や 'N' のような番兵を
 * 書かないと、Excel で開いた人が「評価なし」と「ランク無し」を同じものとして扱ってしまう。 */
const CSV_COLUMN_NOTES_JA: Record<string, string> = {
  verification_status:
    "締切の確認の状態（`data.json` の `deadlines[].verification.status` と同じ値）。" +
    "'verified' は公式ページで確認した行、'manual-required' は公式ページから締切を 1 つに" +
    "確定できなかった行（画面の札では「要確認」。理由は一つではない – 公式ページを自動で" +
    "見に行けない・候補が複数で一意に決まらない・本文が取れなかった、のいずれか）、" +
    "'parser-failed' は公式ページは取れたのに締切を読み取れなかった行（画面の札では" +
    "「読み取り失敗」）、'pending' は次の確認に回した行。空欄は確認の記録がない行" +
    "（上流の集約データの多くがこれで、**未確認とは別物**）。",
  verification_source_class:
    "確認の元の種類（`data.json` の `deadlines[].verification.source_class` と同じ値）。" +
    "'official-cfp' は公式の募集ページ、'publisher' は出版社、'aggregator' は集約サイト、" +
    "'unknown' は不明。空欄は確認の記録がない行。",
  extended:
    "'true' は上流が締切を後ろへ動かした行（画面の札では「延長後」。上流の締切名に Extended と" +
    "付く行と、前の日付を持つ行で日付が後ろへ動いた物）。'false' は動いていない行。" +
    "前倒しは 'false'（延長とは呼ばない）。",
  key: "会議の正規化キー（slug）。`data.json` の `conferences[].key` と同じ。",
  title: "会議の略称。例 'SIGCOMM'。",
  full_name: "会議の正式名称（上流の原文）。",
  categories:
    "分野。`data.json` の `categories` のキーを `;` で連結する（例 'ai;db'）。" +
    "画面の分野チップに出る日本語ではなく英語のキーである。",
  rank_ccf:
    "CCF の等級。空欄は未評価。値 'N' は上流でランクが付いていないことを示す番兵で、等級ではない。",
  rank_core: "CORE の等級（例 'A*'）。空欄は未評価。値 'N' は CCF と同じ番兵。",
  year: "開催年（整数）。",
  edition_id: "開催回の ID（例 'sigcomm26'）。`data.json` の `editions[].id` と同じ。",
  kind:
    "日付の種別。'abstract'・'paper'・'supplementary'・'notification'・'camera_ready'・" +
    "'rebuttal_start'・'rebuttal_end'・'review_release'・'registration'・'other' の 10 種。" +
    "画面の「種別」で選べる概要・論文以外の種別もこの表には含まれる – 採否通知のように、その日" +
    "が締切ではない物を含む（日付の列が何を指すかは `date_field` で決まる – 第 302 回）。",
  label: "上流の表示用ラベル（原文。翻訳しない）。",
  round: "投稿ラウンド（1 起点の整数）。複数のラウンドを持つ会議がある。",
  deadline_precision:
    "締切値の精度。'exact' は時刻まで確定、'date-only' は暦日までは確定で時刻は未確認。",
  deadline_local_date:
    "'YYYY-MM-DD'。`deadline_precision` が 'date-only' の行だけに入る。'exact' の行では空欄。" +
    "`date_field` が「締切」以外の行では、この日は締切ではなくその他の予定日（第 302 回）。",
  deadline_utc:
    "その日の瞬間 'YYYY-MM-DDTHH:MM:SSZ'（UTC）。'date-only' の行では空欄（いつ始まるか終えるか分かっていないため書けない）。" +
    /* 数は日付を添へて書く。*/
    "`date_field` が「締切」以外（採否通知・査読結果公開・反論期間の開始）の行では、この日は**締切ではない** – 2026-10-06 の実測で 4,984 行のうち 311 行が該当する（収録が増えればこの数も動く。第 302 回）。",
  deadline_aoe:
    "AoE（UTC-12）基準で読み替えた瞬間 'YYYY-MM-DD HH:MM:SS AoE'。'date-only' の行では空欄。" +
    "意味は `deadline_utc` と同じで、`date_field` が「締切」以外の行では締切ではない日に入る。",
  tz_raw:
    "上流が書いたままのタイムゾーン表記（'AoE'、'UTC-12'、'PT' など）。'date-only' の行では空欄。",
  event_start:
    "会期の開始日 'YYYY-MM-DD'。複数回開催では原文の期間の先頭であり、連続開催を意味しない。分かっていない行は空欄。",
  event_end:
    "会期の終了日 'YYYY-MM-DD'。複数回開催では原文の期間の末尾であり、各開催日は event_segments を参照。分かっていない行は空欄。",
  event_segments:
    "離れた開催日・週次セミナーの各回を start / end / label の JSON 配列で示す。連続開催では空欄。",
  place:
    "開催地（上流の原文。例 'Zurich, Switzerland'）。画面と `upcoming.md` に入れる日本語化" +
    "（県名の補完や国名の変換）は施していないので、日本語で検索するときは画面を使う。",
  date_text: "上流の自由文の会期表記（例 'October 21-23, 2019'）。構造化されていない。",
  estimated:
    "推定版かどうかの 'true' / 'false'。'true' は過去実績からの機械推定で、公式に裏を取ったデータではない。",
  estimate_window_start:
    "推定版の表示用の窓の開始日 'YYYY-MM-DD'。確定版の行は空欄。公式締切ではない。",
  estimate_window_end:
    "推定版の表示用の窓の終了日 'YYYY-MM-DD'。確定版の行は空欄。公式締切ではない。",
  sources: "この行を出した出典名を `;` で連結したもの（例 'aideadlines;ccfddl'）。",
  kind_ja:
    "種別の日本語表記。画面の「種別」と同じ語で、`kind`（英語のキー）と 1 対 1。" +
    "例 'paper' は '論文締切'、'abstract' は '概要締切'。上流の自由文を訳した物ではなく、" +
    "画面・マークダウン・カレンダーと同じ表から引く。**この欄は種別の語だけで、その他を継がない**" +
    "（第 301 回 – 実測で 3,253 行のうち 55 行が '論文締切: Paper submission' の様な値に割れて" +
    "いた）。同じ年に同じ種別が重なる行の区別は `label`（上流の表示用ラベル）と `round` で見る。" +
    "画面の「種別」は、区別の要る行だけ語の後ろに上流のラベルを添える – この欄は添えない。",
  date_field:
    "その日を何と呼ぶか（'締切'・'通知日'・'公開日'・'開始日'）。`deadlines.ics` の本文に書く語と" +
    "同じで、語の正本も同じ（第 302 回）。**日付の列を締切として扱うかどうかを決めるのはこの欄** –" +
    " '締切' 以外の行は、その日までに何かを出す必要がない日（採否通知の通知日、査読結果の公開日、" +
    "反論期間の開始日）に入る。会期の行はこの表には入らない（会期は `data.json`・`upcoming.md`・" +
    "画面に出る – カレンダーでは各予定の本文の「会期: 」に書く – 第 304 回）。",
  link: "会議の公式サイトの URL。",
};

/* `llms.txt` の「出力一覧」に置く説明。名前は `MANAGED_OUTPUT_FILES` から書き出し、
 * 実装側に置くのは説明だけ（公開物を増やしたときに索引だけが古くなる状態を作らない）。
 * 2026-08-09 生成のビルドで実測: 出力一覧は 16 件のうち 10 件しか並べておらず、
 * `recommendation-core.js`・`publish.js`・`index.html`・`icon.svg`・`.nojekyll`・
 * `llms.txt` 自身へのふれが公開物の一覧のどこにも無かった。 */
/* 締切の分布（件数と、JST の暦日での最初・最後）。`llms.txt` の索引は、この値を成果物から
 * 数えて書く – 定数で書くと次のビルドで噓になる。 */
export type DeadlineSpan = { deadline_count: number; first_day: string; last_day: string };

export function deadlineSpan(root: unknown): DeadlineSpan | null {
  const conferences = (root as { conferences?: unknown } | null)?.conferences;
  if (!Array.isArray(conferences)) return null;
  let count = 0;
  let first = "";
  let last = "";
  const dayOf = (deadline: Record<string, unknown>): string => {
    const utc = deadline.utc;
    if (typeof utc === "string" && utc.length >= 19) {
      // `utc` は協定世界時 – カレンダーと画面が見る JST の暦日に揃える。
      const at = Date.parse(utc);
      if (Number.isFinite(at)) return new Date(at + 9 * 3600000).toISOString().slice(0, 10);
    }
    const local = deadline.local_date ?? deadline.utc;
    return typeof local === "string" && /^\d{4}-\d{2}-\d{2}/.test(local) ? local.slice(0, 10) : "";
  };
  conferences.forEach((conference) => {
    const editions = (conference as { editions?: unknown })?.editions;
    if (!Array.isArray(editions)) return;
    editions.forEach((edition) => {
      const deadlines = (edition as { deadlines?: unknown })?.deadlines;
      if (!Array.isArray(deadlines)) return;
      deadlines.forEach((deadline) => {
        const rec = deadline as Record<string, unknown>;
        const day = dayOf(rec);
        if (!day) return;
        count += 1;
        if (!first || day < first) first = day;
        if (!last || day > last) last = day;
      });
    });
  });
  return count > 0 ? { deadline_count: count, first_day: first, last_day: last } : null;
}

/* `llms.txt` の索引に添える実測の範囲。ビルドが書いた成果物と同じ物から導く。 */
export type LlmsSpans = {
  all?: DeadlineSpan | null;
  catalog?: DeadlineSpan | null;
  horizonDays?: number | null;
  calendar?: IcsCalendarMeta | null;
};

const LLMS_OUTPUT_NOTES_JA: Record<string, string> = {
  "index.html":
    "画面そのもの。`app.js` をモジュールとして読み、`app.js` の側が `recommender.js`・" +
    "`recommendation-core.js`・`publish.js` を import する（2026-08-09 生成ビルドの import 文で実測）。" +
    "JavaScript が動かないときの案内と、`data.csv`・`upcoming.md`・`data.json`・`deadlines.ics` への導線を内側に持つ。" +
    "人間の読み方はこのファイルではなく、画面の中の「見方のてびき」に書く。",
  "data.json":
    "正規化データ全体（機械可読の正）。画面の最初の一覧に並ぶのはこのうち `catalog.json` に" +
    "収まる分だけで、過去の全履歴とそれより先の締切はここだけにある。",
  "health.json": "配信前ゲートにも使う確定/推定締切とソース状態の健全性レポート。",
  "health.md":
    "health.json の人間向け要約。載っていない公開物（`health.json` 自身・`health.md` 自身・" +
    "`publish.json`）と完全なハッシュ一覧の所在を、表の直前に書いてある。",
  "publish.json":
    "最終公開セットのハッシュ、元 commit、入力 hash、build 条件と、意味検索用の埋め込みが公開物に" +
    "含まれるかを示す semantic_status（ready / lexical-only）。自分自身のハッシュは持てない。",
  "catalog.json":
    "締切画面向けの現在・近日期間カタログ。画面の最初の一覧はこのファイルに載る締切だけを出し、" +
    "それより先を見るには画面で「収録の全体を読み込む」を選ぶ。画面の判断に必要な 3 つの材料も" +
    "この中に入る – `reranker`（投稿先推薦の再学習の重み）、`history_bytes`（`history_ref` の" +
    "バイト数。画面は「収録の全体」を押す前に容量を数字で示す）、" +
    "`conferences[].recommendation_axes`（`venue_evidence`: 収録開催年数・論文サンプル数など、" +
    "`deadline_trust`: 日付・時刻・タイムゾーン・種別の確認状況、`research_fit`: 論文との一致評価）。",
  "recommendation-index.json": "投稿先推薦の会議プロフィールと埋め込み参照。",
  "data.csv":
    "1 行 1 締切のフラット表。列の意味は下の「data.csv の列」に書く。文字コードは BOM を付けない" +
    " UTF-8（画面のダウンロードボタンが書く CSV は Excel を助けるため BOM 付きで、別物）。" +
    "種別は英語のキー `kind` と、画面と同じ日本語の `kind_ja` を併記する（`label` は上流の" +
    "自由文で、つづりが揺れる – 'Paper submission' と 'Paper Submission' が同じ物として並ぶ）。" +
    "日付の列が**締切の日を指すかその他の予定日かを区別する欄は `date_field`**（2026-10-06 の" +
    "実測で 4,984 行のうち 311 行が締切ではない日 – 締切として数えると間違える。収録が増えれば" +
    "この数も動く）。",
  "upcoming.md":
    "直近 180 日の締切と開催の表。MCP の `list_upcoming` でも会期を取得できます。MCP の対象期間は `days` で指定します。購読カレンダー `deadlines.ics` は締切のみです。",
  "upcoming.html":
    "`upcoming.md` と同じ表を、ブラウザでそのまま読める形にしたもの（第 263 回）。Markdown の" +
    " 方は機械が読む用のまま残してある。",
  "404.html":
    "見つけられなかった場所に対する日本語の案内（GitHub Pages がない場所に対して出すページ）。" +
    "画面・直近の一覧・カレンダー・機械可読のデータへの口を、サイトの絶対 URL で並べる" +
    "（第 307 回）。日付は載せない。",
  "deadlines.ics":
    "収録した会議の日付をカレンダーに入れるための 1 本（RFC 5545）。1 日 = 1 イベントの終日" +
    "（JST の暦日）で、" +
    "画面の絞り込みは効かない。時刻未確認と推定はそのまま書く（第 266 回）。確認の状態" +
    "（`要確認` など）と延長（`延長後`）は、各予定の本文に `状態: ` の行で書く" +
    "（画面の一覧の札と同じ語 – 購読した人はカレンダーしか見ないため。第 861 回）。" +
    "**同じ締切には同じ UID を付ける**（`catalog.json` の締切の `ics_uid` に載せて、" +
    "画面の書き出しもそれをそのまま使う – 両方を同じカレンダーに入れても二重に並ばない）。" +
    "種別の語を ASCII に落とせる行はそのまま、落とせない行（日本語の種別名）は同じ語の" +
    "SHA-1 の先頭 8 桁にする – 読めるかより、ビルドをまたいで同じ値になる事を取る。" +
    "分野は画面と同じ日本語で " +
    "`CATEGORIES` と説明行の `分野:` の両方に載せる（第 292 回）。受信側の表示対応は kamiyobi 側では" +
    "検証していないが、説明行の語はカレンダー本文の検索に掛かる。",
  "llms.txt": "このファイル。機械が読む索引で、人間の操作説明は画面の中に書く。",
  "robots.txt":
    "機械が最初に読む 1 枚（RFC 9309）。収録は全て公開なので `Allow: /` だけを書き、" +
    "同じ場所の `sitemap.xml` と、AI の索引 `llms.txt` の絶対 URL を添える。",
  "sitemap.xml":
    "人が開く口（`/`・`upcoming.html`・`upcoming.md`・`llms.txt`）の絶対 URL と、" +
    "生成した日を `lastmod` に書く。データのファイルは索引 `llms.txt` が名指す – " +
    "ここに並べるのは頁として開ける物だけにする。",
  "icon.svg": "ブラウザのタブとブックマークに出すアイコン（SVG）。",
  ".nojekyll":
    "GitHub Pages に Jekyll での処理をさせないための目印。中身は 0 バイトの空ファイルで、" +
    "データとは関係ない。",
  "embeddings.json":
    "意味検索用の埋め込み。埋め込みを有効にしたビルドだけに出る（`--no-embeddings` では出ない）。" +
    "ないときの検索は語の一致だけで動く。",
  "recommender.js":
    "site/recommender.ts から生成する推薦実行時処理。検索・絞り込み・並び・CSV 書き出しの本体で、" +
    "画面の `app.js` が呼ぶ。",
  "place-aliases.js":
    "国名・都市名の日本語の打ち方を、この表の表記へ寄せる表（`recommender.js` が import する）。" +
    "条目の増減はこのファイルでやる – 収録データの側は変えていません。",
  "topic-aliases.js":
    "site/topic-aliases.ts から生成する、主題の日本語の打ち方を会議名の英字検索語へ寄せる表" +
    "（`recommender.js` が import する）。",
  "latin-retype.js":
    "site/latin-retype.ts から生成する、欧文の語を一文字違いに打った人へ収録の綴りを見当として出す表" +
    "（`recommender.js` が import する。捜しは広げん – 打ち手の提案だけ）。",
  "recommendation.js":
    "語の一致だけで推薦する際に、指定した掲載先と分野名だけの誤一致を区別する共有処理。",
  "recommendation-core.js":
    "site/recommendation-core.ts から生成する共有の推薦軸。画面もビルド側も同じ軸を読む" +
    "（`src/build.ts` が読み込んでいる）。",
  "publish.js":
    "site/publish.ts から生成する、公開物をつき合わせる部品。画面はここから `publish.json` と" +
    "`recommendation-index.json` のハッシュ検証を読む。検証が通らないときは語の一致だけの推薦に" +
    "落ちる（意味検索を黙って止めない）。",
  "app.js": "site/app.ts から生成するブラウザ UI 実行時処理。",
  "ics.js":
    "site/ics.ts から生成する、カレンダー（RFC 5545）の組み立て。配付する `deadlines.ics` と、" +
    "画面が「この一覧の N 件をカレンダー（.ics）で」と書き出す 1 本が、同じ器と同じ折り方に" +
    "なるようにする（`app.js` が import する）。",
  "submission-identity.js":
    "公式CFPを照合済みの同じ募集を、元の記録を保持して1件に表示する共有方針。",
};

/* 索引に添える収録範囲の文。`llms.txt` だけが読める情報として、
 * 「このファイルに何が入っているか」を件数と両端の暦日で書く。 */
function llmsScopeJa(name: string, spans: LlmsSpans | null): string {
  const countJa = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (name === "data.json") {
    const span = spans?.all;
    return span
      ? `収録している締切は ${countJa(span.deadline_count)} 件（${span.first_day} 〜 ${span.last_day}、JST の暦日）。`
      : "";
  }
  if (name === "catalog.json") {
    const span = spans?.catalog;
    if (!span) return "";
    const horizon =
      typeof spans?.horizonDays === "number" && spans.horizonDays > 0
        ? `生成から ${String(spans.horizonDays)} 日先で`
        : "直近の期間で";
    const calendar = spans?.calendar;
    return (
      `載る締切は ${countJa(span.deadline_count)} 件（${span.first_day} 〜 ${span.last_day}、` +
      `JST の暦日）で、${horizon}切る。それより先の締切と過去の全履歴は \`data.json\` に在り、` +
      (calendar
        ? `カレンダー（\`deadlines.ics\`）には ${countJa(calendar.event_count)} 件` +
          `（うち締切 ${countJa(calendar.deadline_count)} 件、` +
          `${calendar.first_day} 〜 ${calendar.last_day}）が入る。`
        : "カレンダー（`deadlines.ics`）にはこれより先も入る。")
    );
  }
  if (name === "deadlines.ics") {
    const meta = spans?.calendar;
    return meta
      ? `収録しているのは今後の日 ${countJa(meta.event_count)} 件（${meta.first_day} 〜 ${meta.last_day}、` +
          `JST の暦日）で、うち締切は ${countJa(meta.deadline_count)} 件 – 残りは採否通知・` +
          "査読結果公開・反論期間の開始のように、その日までに何かを出す必要のない日である" +
          "（本文の日付の欄も「通知日」などになる）。この範囲は画面に並べる期間より長い。" +
          "**会議が開かれている日（会期）を並べる予定は立てない**（終日が並ぶと締切が見えなくなるため）で、会期は各予定の本文の「会期: 」に書く。"
      : "";
  }
  return "";
}

const TEMPLATE_MARKER = "/*__DATA__*/null";
/* 機械可読の自己紹介（schema.org の Dataset）を差し込む印。雛形に置いておき、
 * ビルドが実測値で埋める – 中身を雛形に書くと、件数や期間が次のビルドで噓になる。 */
const JSONLD_MARKER = "<!--__JSONLD__-->";

/**
 * タイトル + 開催年を組み立てる。タイトルが既にその年（例: `CANOPIE-HPC 2026`）
 * または短縮年（例: `SC '26`, `SC ’26`）で終わっている場合は年を二重に付けない。
 * year が 0 / 未指定の場合はタイトルのみを返す。
 */

function 稀有な欄の實測(data: Record<string, unknown>): string {
  const 會議 = (data.conferences ?? []) as Array<Record<string, unknown>>;
  const 版 = 會議.flatMap((c) => (c.editions ?? []) as Array<Record<string, unknown>>);
  const 締切 = 版.flatMap((e) => (e.deadlines ?? []) as Array<Record<string, unknown>>);
  const 欄の數 = (箱: Array<Record<string, unknown>>, 名: string): number =>
    箱.filter((r) => 名 in r).length;
  const 切つた = (箱: Array<Record<string, unknown>>, 名: string): number =>
    箱.filter((r) => {
      const v = r[名];
      if (v === undefined || v === null) return false;
      if (typeof v === "string") return v.trim().length > 0;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === "object") return Object.keys(v as object).length > 0;
      return true;
    }).length;
  const 數 = (n: number): string => String(n).replace(/(\d)(?=(\d{3})+(?!\d))/g, "$1,");
  return (
    `版 ${數(版.length)} のうち call_identity ${欄の數(版, "call_identity")}・` +
    `legacy_ids ${欄の數(版, "legacy_ids")}・event_review ${欄の數(版, "event_review")}／` +
    `締切 ${數(締切.length)} のうち track ${切つた(締切, "track")}・` +
    `superseded_deadlines ${欄の數(締切, "superseded_deadlines")}・` +
    `promotion_ref ${欄の數(締切, "promotion_ref")}。` +
    `verification は ${欄の數(締切, "verification")} 件で殆どの締切に付く。` +
    `upstream_sub は会議 ${數(會議.length)} のうち ${欄の數(會議, "upstream_sub")} 件`
  );
}

export function titleWithYear(
  title: string | null | undefined,
  year: number | null | undefined,
): string {
  // 組み立て式は site/recommender.ts が正本。サイトの表・行の詳細・CSV と同じ名前の列を
  // md も出す（実装を 2 本持つと片方が古くなる）。
  return Recommender.titleWithYearJa(title, year);
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
  venuePapers?: Record<string, string[]>,
): boolean {
  if (!existing || typeof existing !== "object") return true;
  const expected = embeddingManifest(data, {}, venuePapers);
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
  if (manifest.profile_hash !== embeddingProfileHash(data, venuePapers)) return true;
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

/* サイトの自前アイコン（favicon）。外部フォント・外部画像に依存しないよう、
 * 文字を使わず図形で描く（日本語フォントが無い環境でも文字化けしない）。
 * 色は site/template.html の --accent と揃える。 */
const SITE_ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="kamiyobi">',
  '<rect width="32" height="32" rx="7" fill="#2f5fd0"/>',
  '<rect x="6" y="9" width="20" height="17" rx="2.5" fill="#ffffff"/>',
  '<rect x="6" y="9" width="20" height="4" rx="1.5" fill="#2f5fd0"/>',
  '<rect x="9.5" y="6" width="2.6" height="5.5" rx="1.3" fill="#ffffff"/>',
  '<rect x="19.9" y="6" width="2.6" height="5.5" rx="1.3" fill="#ffffff"/>',
  '<rect x="9.5" y="16.5" width="7" height="2.4" rx="1.2" fill="#2f5fd0"/>',
  '<rect x="9.5" y="21" width="4" height="2.4" rx="1.2" fill="#9dbdf5"/>',
  '<circle cx="21.5" cy="22.2" r="3.1" fill="#d84343"/>',
  "</svg>",
  "",
].join("\n");

// --- record extraction -------------------------------------------------------

/** Anywhere on Earth display: UTC-12 wall clock of `atUtc`. */
function aoeText(atUtc: Date): string {
  return `${fmtUTC(addDays(atUtc, -0.5), "%Y-%m-%d %H:%M:%S")} AoE`;
}

function jstClock(atUtc: Date): string {
  const jst = new Date(atUtc.getTime() + 9 * 3_600_000);
  const day = fmtDate(jst);
  const weekday = calendarDayJa(day);
  return `${day}${weekday ? `(${weekday})` : ""} ${fmtUTC(jst, "%H:%M")}`;
}

/** JST 宣言の締切は JST の壁時計で出す（SPEC §7 の site 表示と同じ規則）。
 * JST 23:59 締切を AoE 02:59 と見せると「当日早朝まで」と誤読される。 */
function jstText(atUtc: Date): string {
  return `${jstClock(atUtc)} JST`;
}

/** Markdown 表の日付列は締切の公式表記（`tz_raw`）にあった書き方をする。
 * AoE を出すのは公式が AoE の締切だけ。それ以外を AoE 壁時計へ勝手に直さない。
 * 未知の表記（PT・Europe/London など）は UTC 壁時計に公式表記を添え、換算はしない。 */
/* Markdown 表の日付に添える曜日。閲覧者のタイムゾーンではなく `YYYY-MM-DD` の暦日を
 * そのまま読む（site の weekdayJaFromDate と同じ規則）。Date.UTC は範囲外の日付を
 * 翌月へ繰り越すので、読み直した暦日が元値と一致するときだけ曜日を返す。 */
const CALENDAR_WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

export function calendarDayJa(value: Date | string | null | undefined): string {
  const raw = value instanceof Date ? fmtDate(value) : String(value ?? "").trim();
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!matched) return "";
  const y = Number(matched[1]);
  const m = Number(matched[2]);
  const d = Number(matched[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return "";
  const instant = new Date(Date.UTC(y, m - 1, d));
  if (
    instant.getUTCFullYear() !== y ||
    instant.getUTCMonth() + 1 !== m ||
    instant.getUTCDate() !== d
  )
    return "";
  return CALENDAR_WEEKDAY_JA[instant.getUTCDay()];
}

/** Markdown 専用の AoE 壁時計（`data.json` / `data.csv` の `aoe` は曜日を付けないので分ける）。 */
function mdAoEText(atUtc: Date): string {
  const shifted = addDays(atUtc, -0.5);
  return `${fmtDate(shifted)}${calendarDayJa(shifted) ? `(${calendarDayJa(shifted)})` : ""} ${fmtUTC(shifted, "%H:%M:%S")} AoE`;
}

const JST_TZ_VALUES = ["JST", "UTC+9", "UTC+09", "UTC+09:00", "GMT+9", "ASIA/TOKYO"];
const AOE_TZ_VALUES = ["AOE", "UTC-12", "UTC-12:00"];
const UTC_TZ_VALUES = ["", "UTC", "UTC+0", "UTC+00", "GMT"];

export function deadlineWhenText(atUtc: Date, tzRaw: string | null | undefined): string {
  const raw = String(tzRaw ?? "").trim();
  const zone = raw.toUpperCase().replace(/\s+/g, "");
  if (JST_TZ_VALUES.indexOf(zone) >= 0) return jstText(atUtc);

  if (AOE_TZ_VALUES.indexOf(zone) >= 0) return `${mdAoEText(atUtc)}（${jstReadingJa(atUtc)}）`;
  const jstDay = fmtUTC(atUtc, "%Y-%m-%d");
  const weekday = calendarDayJa(jstDay);
  const utc = `${jstDay}${weekday ? `(${weekday})` : ""} ${fmtUTC(atUtc, "%H:%M:%S")} UTC`;
  if (UTC_TZ_VALUES.indexOf(zone) >= 0) return `${utc}（${jstReadingJa(atUtc)}）`;
  return `${utc}（公式 ${raw}・${jstReadingJa(atUtc)}）`;
}

/** 日付欄に添える日本時間の読み。単位は 1 度だけ。 */
function jstReadingJa(atUtc: Date): string {
  return `JST では ${jstClock(atUtc)}`;
}

function sortedDeadlines(edition: Edition): Deadline[] {
  return [...edition.deadlines].sort(
    (a, b) =>
      a.round - b.round ||
      deadlineSortTime(a) - deadlineSortTime(b) ||
      cmpStr(a.kind, b.kind) ||
      cmpStr(a.label ?? "", b.label ?? "") ||
      cmpStr(a.track ?? "", b.track ?? ""),
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
  /** 種別の語だけ（接頭辞も接尾辞も足さない – 第 301 回）。`data.csv` の `kind_ja` はこれを書く。 */
  kind_ja: string;

  kind_note: string;
  /** その日の行を何と呼ぶか（「締切」/「通知日」など – 第 299 回）。種別の正本で決める。 */
  date_field: string;
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
        const labelBase = KIND_LABEL_JA[dl.kind] ?? KIND_LABEL_JA.other;
        let labelJa = labelBase;
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
          // 表に計算（ピボット）を作る人は語で選ぶので、語の純粋な形を別に持つ。
          // 同じ年の同じ種別が重ねてある行だけ `kind_label` に上流のラベルを続ける – 画面では
          // それが要るが、表では語が割れる原因になる（区別は `label` と `round` で付く）。
          kind_ja: labelBase,

          kind_note:
            String(dl.track ?? "").trim() ||
            (labelJa === labelBase ? "" : String(dl.label ?? "").trim()),
          date_field: Recommender.kindDateFieldJa(dl.kind),
          estimated: ed.estimated,
          conf,
          edition: ed,
          deadline: dl,
          all_day: isDateOnlyDeadline(dl),
          start: isDateOnlyDeadline(dl) ? anchor : new Date(anchor.getTime() - 30 * 60_000),
          end: dateWindow?.latestPossibleUtc ?? anchor,
        });
      });
      const segments = ed.event_segments?.length
        ? ed.event_segments
        : ed.event_start
          ? [
              {
                start: fmtDate(ed.event_start),
                end: fmtDate(ed.event_end ?? ed.event_start),
                label: "",
              },
            ]
          : [];
      for (const segment of !ed.estimated ? segments : []) {
        const start = asDate(segment.start);
        const end = asDate(segment.end);
        if (!start || !end) continue;
        records.push({
          type: "event",
          categories: cats,
          kind_label: "開催",
          kind_ja: "開催",
          kind_note: segment.label,
          /* 会期は締切ではない。この行がカレンダーに載ったとき、日付の欄を
             「締切」にすると締切に見える。 */
          date_field: "会期",
          estimated: false,
          conf,
          edition: ed,
          deadline: null,
          all_day: true,
          start,
          end,
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
      ? (asDate(rec.deadline.local_date)?.getTime() ?? rec.start.getTime())
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
  venuePapers?: Record<string, string[]>,
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
  const healthConfig = (safeConfig.health as Record<string, unknown>) ?? {};
  const reverificationConfig = (healthConfig.reverification as Record<string, unknown>) ?? {};
  const reverificationEnabled = Boolean(reverificationConfig.enabled);
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
            ? `${baseUrl}/data/manual.yaml`
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
  const bootstrapVerification = (
    deadline: Deadline,
    evidence: Array<Record<string, unknown>>,
  ): Record<string, unknown> | undefined => {
    const source = evidence.find((item) =>
      ["official-cfp", "publisher", "aggregator"].includes(evidenceClassOf(item)),
    );
    if (!source) return undefined;
    const sourceUrl = String(source.sourceUrl ?? source.source_url ?? "").trim();
    if (!sourceUrl) return undefined;
    const sourceClass = evidenceClassOf(source) || "aggregator";
    const verifiedAt = String(source.verifiedAt ?? source.retrievedAt ?? "").trim();
    const hasVerifiedEvidence =
      ["official-cfp", "publisher"].includes(sourceClass) &&
      Boolean(source.contentHash) &&
      Number.isFinite(Date.parse(verifiedAt));
    const deadlineDate = isDateOnlyDeadline(deadline)
      ? (dateOnlyWindow(deadline.local_date)?.latestPossibleUtc ?? null)
      : deadline.at_utc;
    const nextCheck =
      computeNextCheckAt(deadlineDate, safeNow) ??
      new Date(safeNow.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    return {
      official_url: sourceUrl,
      last_attempt_at: Number.isFinite(Date.parse(String(source.retrievedAt ?? "")))
        ? String(source.retrievedAt)
        : null,
      last_verified_at: hasVerifiedEvidence ? new Date(Date.parse(verifiedAt)).toISOString() : null,
      next_check_at: nextCheck,
      content_hash: typeof source.contentHash === "string" ? source.contentHash : null,
      ...(typeof source.sourceName === "string"
        ? { source_name: source.sourceName }
        : typeof source.source_name === "string"
          ? { source_name: source.source_name }
          : {}),
      status: hasVerifiedEvidence
        ? "verified"
        : sourceClass === "aggregator"
          ? "manual-required"
          : "pending",
      source_class: sourceClass,
      ...(typeof source.adapter === "string" ? { adapter: source.adapter } : {}),
      ...(typeof source.selectorOrField === "string"
        ? { selector_or_field: source.selectorOrField }
        : {}),
    };
  };
  const outConfs: unknown[] = [];
  for (const conf of [...(confs ?? [])].sort((a, b) => cmpStr(a?.key ?? "", b?.key ?? ""))) {
    if (!conf || typeof conf !== "object") continue;
    const editions: unknown[] = [];
    for (const ed of [...(conf.editions ?? [])].sort(
      (a, b) => (a.year ?? 0) - (b.year ?? 0) || cmpStr(a.edition_id ?? "", b.edition_id ?? ""),
    )) {
      const officialUrl = ed.link || conf.link;
      editions.push({
        year: ed.year,
        id: ed.edition_id,
        link: officialUrl,
        place: ed.place,
        date_text: ed.date_text,
        event_date_precision:
          ed.event_segments?.length &&
          !["not-announced", "month-only"].includes(ed.event_date_precision || "")
            ? "split-dates"
            : eventDatePrecisionOf(
                ed.event_date_precision,
                ed.date_text,
                ed.event_start,
                ed.event_end,
              ),
        ...(ed.event_segments !== undefined ? { event_segments: ed.event_segments } : {}),
        ...(ed.event_review !== undefined ? { event_review: ed.event_review } : {}),
        event_start: ed.event_start ? fmtDate(ed.event_start) : null,
        event_end: ed.event_end ? fmtDate(ed.event_end) : null,
        estimated: ed.estimated,
        ...(ed.estimate ? { estimate: { ...ed.estimate } } : {}),
        source: ed.source,
        ...(ed.identity ? { identity: ed.identity } : {}),
        ...(ed.call_identity ? { call_identity: { ...ed.call_identity } } : {}),
        ...(ed.legacy_ids?.length ? { legacy_ids: [...ed.legacy_ids] } : {}),
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
            ...(dl.superseded_deadlines?.length
              ? { superseded_deadlines: dl.superseded_deadlines.map((item) => ({ ...item })) }
              : {}),
            ...(dl.promotion_ref ? { promotion_ref: { ...dl.promotion_ref } } : {}),
            ...(conflicts.length > 0 ? { conflicts } : {}),
            ...(dl.verification
              ? { verification: { ...dl.verification } }
              : reverificationEnabled
                ? (() => {
                    const verification = bootstrapVerification(dl, evidence);
                    return verification ? { verification } : {};
                  })()
                : {}),
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
      acronym: conf.acronym || conf.title,
      ...(conf.scope?.length ? { scope: [...conf.scope] } : {}),
      ...(conf.official_scope?.length ? { official_scope: [...conf.official_scope] } : {}),
      ...(conf.paper_abstracts?.length ? { paper_abstracts: [...conf.paper_abstracts] } : {}),
      ...(conf.keywords?.length ? { keywords: [...conf.keywords] } : {}),
      categories: [...conf.categories],
      rank: { ...conf.rank },
      link: conf.link,
      tags: [...conf.tags],
      sources: [...conf.sources],
      dblp: conf.dblp,
      ...(conf.upstream_sub ? { upstream_sub: conf.upstream_sub } : {}),
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
      papers: (venuePapers ?? getVenuePapers())[conf.key] ?? [],
    });
  }
  const data: Record<string, unknown> = {
    generated_at: fmtUTC(safeNow, "%Y-%m-%dT%H:%M:%SZ"),
    site: {
      domain,
      base_url: baseUrl,
    },
    sources,
    categories: { ...categories },
    legacy_key_redirects: (() => {
      const aliases = new Map<string, string[]>();
      const venueIdentities = safeConfig.venue_identities;
      const canonicalKeys = new Set([
        ...(confs ?? []).map((conference) => conference.key),
        ...(venueIdentities &&
        typeof venueIdentities === "object" &&
        !Array.isArray(venueIdentities)
          ? Object.keys(venueIdentities)
          : []),
      ]);
      for (const conference of confs ?? []) {
        for (const legacy of conference.legacy_keys ?? []) {
          aliases.set(legacy, [...(aliases.get(legacy) ?? []), conference.key]);
        }
      }
      return Object.fromEntries(
        [...aliases]
          .filter(([legacy, targets]) => !canonicalKeys.has(legacy) && new Set(targets).size === 1)
          .map(([legacy, targets]) => [legacy, targets[0]!] as const)
          .sort(([a], [b]) => cmpStr(a, b)),
      );
    })(),
    conferences: outConfs,
  };
  data.identity_migrations = identityMigrationManifestForData(
    data,
    safeConfig.deadline_identity_migrations,
  );
  return data;
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

function recordDeadlineLastDay(conf: JsonRecord): string | null | "" {
  let last = Number.NaN;
  let sawUndated = false;
  jsonRecords(conf.editions).forEach((edition) => {
    jsonRecords(edition.deadlines).forEach((deadline) => {
      const range = jsonDeadlineRange(deadline);
      if (range === null) {
        sawUndated = true;
        return;
      }
      if (!Number.isFinite(last) || range[1] > last) last = range[1];
    });
  });
  if (!Number.isFinite(last)) return sawUndated ? "" : null;
  // 協定世界時の幅の終端 – 画面とカレンダーが見る JST の暦日に揃える。
  return new Date(last + 9 * 3600000).toISOString().slice(0, 10);
}

function recordEstimatedNextDay(conf: JsonRecord, nowMs: number): string {
  let bestMs = Number.NaN;
  jsonRecords(conf.editions).forEach((edition) => {
    const 版ごと推定 = edition.estimated === true;
    jsonRecords(edition.deadlines).forEach((deadline) => {
      if (!版ごと推定 && deadline.estimated !== true) return;

      const range = jsonDeadlineRange(deadline);
      if (range === null) return;
      if (range[1] < nowMs) return;
      if (!Number.isFinite(bestMs) || range[1] < bestMs) bestMs = range[1];
    });
  });
  return Number.isFinite(bestMs) ? new Date(bestMs + 9 * 3600000).toISOString().slice(0, 10) : "";
}

function recordDeadlineNext(
  conf: JsonRecord,
  nowMs: number,
): { day: string; kind: string; count: number } {
  let bestMs = Number.NaN;
  let bestKind = "";
  let count = 0;
  jsonRecords(conf.editions).forEach((edition) => {
    jsonRecords(edition.deadlines).forEach((deadline) => {
      const range = jsonDeadlineRange(deadline);
      if (range === null || range[1] < nowMs) return;
      count += 1;
      if (!Number.isFinite(bestMs) || range[1] < bestMs) {
        bestMs = range[1];
        bestKind = typeof deadline.kind === "string" ? deadline.kind : "";
      }
    });
  });
  if (!Number.isFinite(bestMs)) return { day: "", kind: "", count };
  return {
    day: new Date(bestMs + 9 * 3600000).toISOString().slice(0, 10),
    kind: bestKind,
    count,
  };
}

/** 締切の JST の暦日（`YYYYMMDD`）。UID を引く鍵に使う – 配付物の ICS が使う日と
 * 同じ組み方（`date-only` は公式の暦日、時刻のある物は JST へ寄せた日）。 */
function jsonDeadlineDay(deadline: JsonRecord): string {
  if (String(deadline.precision ?? "") === "date-only")
    return String(deadline.local_date ?? "")
      .replace(/-/g, "")
      .slice(0, 8);
  const at = jsonTime(deadline.utc);
  return at === null ? "" : new Date(at + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, "");
}

/** 配付物の ICS が使った UID を、締切に載せる（引けなければ載せない）。
 *
 * 畫面は SHA-1 を持たないので、自分で同じ UID を組めない – ここで渡さないと、書き出しの
 * 予定が購読の予定と別の物になり、兩方を入れた人に同じ締切が二度並ぶ（實測 2026-10-17）。 */
function attachIcsUids(
  edition: JsonRecord,
  deadlines: JsonRecord[],
  icsUids?: Map<string, string> | null,
): JsonRecord[] {
  if (!icsUids) return deadlines;
  return deadlines.map((deadline) => {
    const uid = icsUids.get(
      icsDeadlineUidKey(
        String(edition.id ?? ""),
        String(deadline.kind ?? ""),
        deadline.round,
        String(deadline.label ?? ""),
        jsonDeadlineDay(deadline),
      ),
    );
    return uid ? { ...deadline, ics_uid: uid } : deadline;
  });
}

function compactEdition(
  edition: JsonRecord,
  deadlines: JsonRecord[],
  icsUids?: Map<string, string> | null,
): JsonRecord {
  return {
    year: edition.year,
    id: edition.id,
    link: edition.link,
    place: edition.place,
    date_text: edition.date_text,
    event_date_precision: eventDatePrecisionOf(
      edition.event_date_precision,
      String(edition.date_text ?? ""),
      asDate(edition.event_start),
      asDate(edition.event_end),
    ),
    ...(edition.event_segments !== undefined ? { event_segments: edition.event_segments } : {}),
    ...(edition.event_review !== undefined ? { event_review: edition.event_review } : {}),
    event_start: edition.event_start,
    event_end: edition.event_end,
    estimated: edition.estimated,
    ...(edition.estimate ? { estimate: edition.estimate } : {}),
    source: edition.source,
    ...(edition.call_identity ? { call_identity: edition.call_identity } : {}),
    ...(Array.isArray(edition.legacy_ids) && edition.legacy_ids.length
      ? { legacy_ids: edition.legacy_ids }
      : {}),
    deadlines: attachIcsUids(edition, deadlines, icsUids),
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
    ...(conf.acronym ? { acronym: conf.acronym } : {}),
    ...(conf.scope ? { scope: conf.scope } : {}),
    ...(conf.official_scope ? { official_scope: conf.official_scope } : {}),
    ...(conf.paper_abstracts ? { paper_abstracts: conf.paper_abstracts } : {}),
    ...(conf.keywords ? { keywords: conf.keywords } : {}),
    categories: conf.categories,
    rank: conf.rank,
    link: conf.link,
    tags: conf.tags,
    sources: conf.sources,
    ...(conf.category_assignments ? { category_assignments: conf.category_assignments } : {}),
    ...(Array.isArray(conf.legacy_keys) && conf.legacy_keys.length
      ? { legacy_keys: [...conf.legacy_keys] }
      : {}),
    editions,
    ...(withPapers ? { papers: conf.papers ?? [] } : {}),
  };
}

/** The deadline UI payload: metadata plus only the current/near deadline window. */
export function toCatalog(
  data: Record<string, unknown>,
  now: Date | null | undefined,
  days = 180,
  // カレンダー配信の実測（件数と収録の最初/最後の締切日）。画面の注記はここを読む –
  // 画面側で数え直すと、配信物と同じ数を言えなくなる。
  calendar: IcsCalendarMeta | null | undefined = undefined,
  reranker?: Record<string, unknown> | null,
  /* 締切ごとのカレンダーの UID（配付物が使った物）。畫面は SHA-1 を持たないので、
   * 自分で同じ UID を組めない – ここで渡して、書き出しの予定が購読の予定と同じ物に
   * なるようにする（違うと、兩方を入れた人に同じ締切が二度並ぶ）。 */
  icsUids?: Map<string, string> | null,
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
          Array.isArray(edition.event_segments) && edition.event_segments.length
            ? jsonRecords(edition.event_segments).some((part) => {
                const start = jsonTime(part.start);
                const end = jsonTime(part.end);
                return start !== null && end !== null && end >= lookback && start <= horizon;
              })
            : eventStart !== null &&
              eventEnd !== null &&
              eventEnd >= lookback &&
              eventStart <= horizon;
        if (!inWindow && !deadlines.length && edition.event_date_precision !== "not-announced")
          return null;
        const compact = compactEdition(edition, deadlines, icsUids);
        // Supplemental dates belong only to the drawer; the list retains its existing window.
        const scheduleDeadlines = jsonRecords(edition.deadlines).filter(
          (deadline) => !deadlines.includes(deadline),
        );
        if (deadlines.length && scheduleDeadlines.length) {
          compact.schedule_deadlines = attachIcsUids(edition, scheduleDeadlines, icsUids);
        }
        return compact;
      })
      .filter((edition): edition is JsonRecord => edition !== null);
    const entry = compactConference(conf, editions, false);

    if (!editions.some((edition) => jsonRecords(edition.deadlines).length > 0)) {
      entry.record_deadline_last = recordDeadlineLastDay(conf);
      // 収録の側に締切があるときは、近い日も添える（第 298 回 – 待っている物が無い会には
      // 書かないので、画面は「在らない」と「数えていない」を混めない）。
      const next = recordDeadlineNext(conf, safeNow.getTime());
      if (next.count) {
        entry.record_deadline_next = next.day;
        entry.record_deadline_next_kind = next.kind;
        entry.record_deadline_count = next.count;
      }

      entry.record_estimated_next = recordEstimatedNextDay(conf, safeNow.getTime());
    }

    return {
      ...entry,
      recommendation_axes: recommendationAxes(
        /* `papers` は catalog に載せない（data.json と推薦索引が正本 – 載せると窓の分が
         * 膨らむ）。だが**論文サンプル數は其処から數へる**。載せないまま數へると
         * `profileCoverage` が 0 に固まり、画面のカードと MCP が「論文サンプル 0件」と
         * 出して居た（推薦索引は 8件 – 實測 2026-10-15 で 23 会議が不一致。畫面と AI が
         * 同じ噓をつく状態で、順位の元にした論文數とカードの數が食ひ違って居た）。 */
        { ...entry, all_editions: conf.editions, papers: conf.papers ?? [] },
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
    window: { lookback_days: 30, upcoming_days: Math.max(1, days) },
    history_ref: "data.json",
    recommendation_ref: "recommendation-index.json",
    deadline_summary: consolidateReviewedSubmissions(
      Recommender.candidateRows(data),
      (row) => `${row.conf.key}|${row.ed.year ?? ""}|${row.kind}|${Math.trunc(row.t)}`,
    )
      .filter(
        (row) =>
          (row.kind === "abstract" || row.kind === "paper") &&
          !row.est &&
          !Recommender.deadlineRowIsPast(row, safeNow.getTime()),
      )
      .map((row) => ({
        t: row.t,
        tLast: row.tLast,
        tShown: Number.isFinite(row.tShown) ? row.tShown : row.t,
        dateOnly: row.dateOnly === true,
      })),

    reranker: readRerankerModel(reranker),
    // カレンダー配信の中身の実測（件数と収録の最初/最後の締切日）。画面の注記はここを読む –
    // 画面側で数え直すと、配信物と同じ数を言えなくなる。
    calendar: calendar ?? null,
    conferences,
  };
}

/** The recommendation payload: venue profiles and one representative availability record. */

function readRerankerModel(
  supplied?: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (supplied !== undefined) {
    if (supplied !== null && !isValidRerankerModel(supplied))
      throw new Error("recommender reranker model contract is invalid");
    return supplied;
  }
  const rerankerPath = join(ROOT, "data", "recommender-reranker.json");
  try {
    const value = JSON.parse(readFileSync(rerankerPath, "utf8"));
    if (!isValidRerankerModel(value)) throw new Error("model contract is invalid");
    return value as unknown as Record<string, unknown>;
  } catch (error) {
    throw new Error(`recommender reranker ${rerankerPath} を読めない: ${String(error)}`);
  }
}

export function toRecommendationIndex(
  data: Record<string, unknown>,
  now: Date | null | undefined,
  sourceStatus: Record<string, string> = {},
  venuePapers?: Record<string, string[]>,
  rerankerInput?: Record<string, unknown> | null,
): Record<string, unknown> {
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const reranker = readRerankerModel(rerankerInput);
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
              freshness: ["fresh", "cache-fallback", "snapshot-fallback"].includes(status)
                ? status
                : "unknown",
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
    embedding_manifest: embeddingManifest(
      data as Parameters<typeof embeddingManifest>[0],
      {},
      venuePapers,
    ),
    reranker,
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
const HEALTH_DEADLINE_LOOKBACK_MS = 14 * DAY_MS;

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
        "manual.yaml",
        "curated.generated.yaml",
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
  /** 正典の supersession 台帳 (旧値→現行値の公式訂正) を gate へ渡す。 */
  superseded_values?: HealthSupersededValue[];
}

export interface HealthSupersededValue {
  value: string;
  precision: "exact" | "date-only";
  reason: string;
  superseded_at: string;
  /** 訂正先 slot id。免責をこの slot family に限定するための必須スコープ。 */
  superseded_by: string;
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
interface LegacyHealthDeadlineRef {
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
  warning_identities?: string[];
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
  identity_migrations?: IdentityMigrationManifest;
}

export interface HealthReportOptions {
  sourceStatus?: Record<string, HealthSourceStatus>;
  sourceMetadata?: Record<string, HealthSourceMetadata>;
  recommendationSourceStatus?: Record<string, SourceFreshness>;
  buildInputMode?: "online-refresh" | "offline-snapshot";
  sourceFailures?: string[];
  snapshotFallback?: boolean;
  parseWarnings?: Record<string, number>;
  parseWarningCount?: number;
  warningCodes?: Record<string, { count: number; messages: string[] }>;
  warningIdentityKeys?: string[];
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

function normalizedTrackKey(
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

function evidenceFieldList(item: JsonRecord): string[] {
  return jsonStrings(item.verifiedFields ?? item.verified_fields);
}

function officialEvidenceHash(deadline: JsonRecord): string | undefined {
  const items = jsonRecords(deadline.evidence)
    .filter((item) => ["official-cfp", "publisher"].includes(evidenceClassOf(item)))
    .filter((item) => {
      const fields = evidenceFieldList(item);
      return (
        fields.includes("date") && (fields.includes("time") ? fields.includes("timezone") : true)
      );
    })
    .map(
      (item) =>
        `${String(item.sourceUrl ?? item.source_url ?? "")}\n${String(item.contentHash ?? item.content_hash ?? item.sourceRevision ?? item.original_value ?? "")}`,
    )
    .filter((row) => row !== "\n")
    .sort(cmpStr);
  if (items.length === 0) return undefined;
  return createHash("sha256").update(items.join("\n")).digest("hex").slice(0, 16);
}

function healthEvidence(deadline: JsonRecord): HealthDeadlineEvidence[] {
  return jsonRecords(deadline.evidence)
    .map((item): HealthDeadlineEvidence | null => {
      const sourceClass = evidenceClassOf(item);
      const sourceUrl = String(item.sourceUrl ?? item.source_url ?? "");
      const fields = evidenceFieldList(item).filter((field) =>
        ["date", "time", "timezone", "kind", "round", "track"].includes(field),
      ) as NonNullable<DeadlineEvidence["verifiedFields"]>;
      if (!sourceClass && !sourceUrl && fields.length === 0) return null;
      return {
        ...(sourceClass ? { sourceClass: sourceClass as DeadlineEvidence["sourceClass"] } : {}),
        ...(sourceUrl ? { sourceUrl } : {}),
        ...(typeof item.sourceRevision === "string" || typeof item.source_revision === "string"
          ? { sourceRevision: String(item.sourceRevision ?? item.source_revision) }
          : {}),
        ...(typeof item.retrievedAt === "string" || typeof item.retrieved_at === "string"
          ? { retrievedAt: String(item.retrievedAt ?? item.retrieved_at) }
          : {}),
        ...(typeof item.verifiedAt === "string" || typeof item.verified_at === "string"
          ? { verifiedAt: String(item.verifiedAt ?? item.verified_at) }
          : {}),
        ...(typeof item.contentHash === "string" || typeof item.content_hash === "string"
          ? { contentHash: String(item.contentHash ?? item.content_hash) }
          : {}),
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
        const supersededValues = supersededDeadlinesOf(deadline.superseded_deadlines).map(
          (item) => ({
            value: item.value,
            precision: item.precision,
            reason: item.reason,
            superseded_at: item.supersededAt,
            superseded_by: item.supersededBy,
          }),
        );
        // 公式訂正で過去日へ移った締切も、訂正が lookback 内なら gate が旧 slot と
        // 突き合わせられるよう refs に残す。
        const recentlySuperseded = supersededValues.some(
          (item) => Date.parse(item.superseded_at) >= lookbackStart,
        );
        if (!estimated && key && (latest >= lookbackStart || recentlySuperseded)) {
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
          if (supersededValues.length > 0) ref.superseded_values = supersededValues;
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
            const conflictAt = Date.parse(String(conflict.at_utc ?? conflict.utc ?? ""));
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
  const providedIdentityManifest = data.identity_migrations;
  if (
    providedIdentityManifest !== undefined &&
    !isIdentityMigrationManifest(providedIdentityManifest)
  ) {
    throw new Error("invalid identity migration manifest in data payload");
  }
  const identityManifest =
    providedIdentityManifest === undefined
      ? identityMigrationManifestForData(data)
      : providedIdentityManifest;
  const currentIdentityKeys = new Set(
    sortedDeadlineRefs
      .map((ref) => parseDeadlineSlot(ref)?.deadline_id)
      .filter((key): key is string => Boolean(key)),
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
    warning_identities: options.warningIdentityKeys ?? [],
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
    identity_migrations: {
      ...identityManifest,
      // health refs intentionally exclude old/past deadlines; keep only
      // migrations whose target can participate in this transition.
      migrations: identityManifest.migrations.filter((migration) =>
        currentIdentityKeys.has(identityKey(migration.to)),
      ),
    },
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
    const atUtc = rec.at_utc ?? rec.utc;
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
    const supersededValues = healthSupersededValues(rec.superseded_values);
    if (supersededValues.length > 0) ref.superseded_values = supersededValues;
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
  superseded_values: HealthSupersededValue[];
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
    superseded_values: ref.superseded_values ?? [],
  };
}

/** health.json から読み戻した superseded_values を検証付きで正規化する。 */
function healthSupersededValues(value: unknown): HealthSupersededValue[] {
  if (!Array.isArray(value)) return [];
  const parsed: HealthSupersededValue[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const entryValue = String(rec.value ?? "").trim();
    const precision = rec.precision === "exact" ? "exact" : "date-only";
    const reason = String(rec.reason ?? "").trim();
    const supersededAt = String(rec.superseded_at ?? "").trim();
    const supersededBy = String(rec.superseded_by ?? "").trim();
    if (!entryValue || !reason || !supersededBy || !Number.isFinite(Date.parse(supersededAt)))
      continue;
    parsed.push({
      value: entryValue,
      precision,
      reason,
      superseded_at: supersededAt,
      superseded_by: supersededBy,
    });
  }
  return parsed;
}

/**
 * 正典の supersession 台帳が、baseline slot の値を現行 slot への公式訂正として
 * 記録しているか。免責は (1) 旧値の完全一致、(2) superseded_by が台帳を持つ現行
 * slot 自身の family (venue/edition/kind/round) を指すこと、(3) 旧 slot と現行 slot
 * の kind/round 一致、(4) 訂正が lookback 内であること、をすべて要求する。
 */
function supersededCovers(
  previous: DeadlineSlot,
  current: DeadlineSlot,
  currentTime: number,
): boolean {
  if (previous.kind !== current.kind || previous.round !== current.round) return false;
  return current.superseded_values.some((item) => {
    const supersededAt = Date.parse(item.superseded_at);
    if (
      !Number.isFinite(supersededAt) ||
      !Number.isFinite(currentTime) ||
      supersededAt < currentTime - HEALTH_DEADLINE_LOOKBACK_MS ||
      supersededAt > currentTime + DAY_MS
    )
      return false;
    const target = item.superseded_by.split("|");
    if (
      (target[0] ?? "") !== current.venue ||
      (target[1] ?? "") !== current.edition ||
      (target[2] ?? "") !== current.kind ||
      deadlineRound(target[3]) !== current.round
    )
      return false;
    if (item.precision === "date-only") {
      const window = dateOnlyWindow(item.value);
      return (
        window !== null &&
        window.earliestPossibleUtc.getTime() === previous.earliest_ms &&
        window.latestPossibleUtc.getTime() === previous.latest_ms
      );
    }
    const at = Date.parse(item.value);
    return Number.isFinite(at) && at === previous.earliest_ms && at === previous.latest_ms;
  });
}

function matchDeadlineSlots(
  previous: DeadlineSlot[],
  current: DeadlineSlot[],
  manifest: IdentityMigrationManifest | null | undefined,
): {
  pairs: Array<{ previous: DeadlineSlot; current: DeadlineSlot; migration?: IdentityMigration }>;
  unmatchedPrevious: DeadlineSlot[];
} {
  const usedPrevious = new Set<number>();
  const usedCurrent = new Set<number>();
  const currentUse = new Map<number, "exact" | "migration">();
  const pairs: Array<{
    previous: DeadlineSlot;
    current: DeadlineSlot;
    migration?: IdentityMigration;
  }> = [];

  // Edition id の改名・重複 (例: override-2027 と mobicom27 が同値で fold) は slot 内容が同一でも
  // 「future deadline disappeared」の誤検知になる。venue + year + kind/round/track + 時刻が完全一致する
  // slot は同一締切として扱う: previous 側の重複を先に潰してから 1:1 で対にする。
  const sameValueKey = (slot: DeadlineSlot): string =>
    [
      slot.venue,
      slot.year,
      slot.kind,
      slot.round,
      slot.track,
      slot.earliest_ms,
      slot.latest_ms,
    ].join("\0");
  const representativeOf = new Map<string, number>();
  previous.forEach((slot, index) => {
    const key = sameValueKey(slot);
    const first = representativeOf.get(key);
    if (first === undefined) representativeOf.set(key, index);
    else usedPrevious.add(index); // 同一締切の重複 ref は比較対象から外す
  });

  // identityKey 完全一致の current を常にペアにする — schema_version 不変の
  // edition id rename (例: 上流が override-2027 を公式収録して issta27 に改名) でも
  // venue/kind/round/track/時刻が全て一致する slot は同一締切であり、
  // 「future deadline disappeared」の誤検知にしてはならない (2026-08-30 issta 実測)。
  // 時刻まで完全一致する別締切が同一 venue に同居することはなく、本物の消失
  // (時刻変化・削除) はここでマッチせず unmatchedPrevious に残る。
  const currentByIdentity = new Map<string, number[]>();
  current.forEach((slot, index) => {
    const key = sameValueKey(slot);
    const list = currentByIdentity.get(key) ?? [];
    list.push(index);
    currentByIdentity.set(key, list);
  });
  previous.forEach((slot, previousIndex) => {
    if (usedPrevious.has(previousIndex)) return;
    const candidates = (currentByIdentity.get(sameValueKey(slot)) ?? []).filter(
      (index) => !usedCurrent.has(index),
    );
    if (candidates.length === 0) return;
    candidates.sort((a, b) => current[a].earliest_ms - current[b].earliest_ms || a - b);
    const currentIndex = candidates[0];
    usedPrevious.add(previousIndex);
    usedCurrent.add(currentIndex);
    currentUse.set(currentIndex, "exact");
    pairs.push({ previous: slot, current: current[currentIndex] });
  });

  // track キー(ラベル由来)の正規化だけが変わった slot も同一締切として扱う —
  // venue/year/kind/round と時刻が完全一致し、両側で候補が一意な場合に限る。
  // 同一 venue の同一時刻に track 違いの別締切が同居する場合は一意性が崩れ、
  // ここではマッチせず従来どおり unmatchedPrevious に残る。
  const trackFreeKey = (slot: DeadlineSlot): string =>
    [slot.venue, slot.year, slot.kind, slot.round, slot.earliest_ms, slot.latest_ms].join("\0");
  // edition id の改名 (例: genai4sg26 → genai4sg-2026) で時刻表現も変わる場合、
  // track まで一致し両側一意なら同一枠として対応付け、値・精度の検査
  // (authorizesEarlier / authorizesPrecisionCorrection) へ回す。ペア化は容認ではない。
  const editionFreeKey = (slot: DeadlineSlot): string =>
    [slot.venue, slot.year, slot.kind, slot.round, slot.track].join("\0");
  const currentByTrackFree = new Map<string, number[]>();
  current.forEach((slot, index) => {
    if (usedCurrent.has(index)) return;
    const key = trackFreeKey(slot);
    const list = currentByTrackFree.get(key) ?? [];
    list.push(index);
    currentByTrackFree.set(key, list);
  });
  const previousByTrackFree = new Map<string, number[]>();
  previous.forEach((slot, index) => {
    if (usedPrevious.has(index)) return;
    const key = trackFreeKey(slot);
    const list = previousByTrackFree.get(key) ?? [];
    list.push(index);
    previousByTrackFree.set(key, list);
  });
  previous.forEach((slot, previousIndex) => {
    if (usedPrevious.has(previousIndex)) return;
    const key = trackFreeKey(slot);
    if ((previousByTrackFree.get(key) ?? []).length !== 1) return;
    const candidates = (currentByTrackFree.get(key) ?? []).filter(
      (index) => !usedCurrent.has(index),
    );
    if (candidates.length !== 1) return;
    const currentIndex = candidates[0];
    usedPrevious.add(previousIndex);
    usedCurrent.add(currentIndex);
    currentUse.set(currentIndex, "exact");
    pairs.push({ previous: slot, current: current[currentIndex] });
  });

  const currentByEditionFree = new Map<string, number[]>();
  current.forEach((slot, index) => {
    if (usedCurrent.has(index)) return;
    const list = currentByEditionFree.get(editionFreeKey(slot)) ?? [];
    list.push(index);
    currentByEditionFree.set(editionFreeKey(slot), list);
  });
  const previousByEditionFree = new Map<string, number[]>();
  previous.forEach((slot, index) => {
    if (usedPrevious.has(index)) return;
    const list = previousByEditionFree.get(editionFreeKey(slot)) ?? [];
    list.push(index);
    previousByEditionFree.set(editionFreeKey(slot), list);
  });
  previous.forEach((slot, previousIndex) => {
    if (usedPrevious.has(previousIndex)) return;
    const key = editionFreeKey(slot);
    if ((previousByEditionFree.get(key) ?? []).length !== 1) return;
    const candidates = (currentByEditionFree.get(key) ?? []).filter(
      (index) => !usedCurrent.has(index),
    );
    if (candidates.length !== 1) return;
    const currentIndex = candidates[0];
    usedPrevious.add(previousIndex);
    usedCurrent.add(currentIndex);
    currentUse.set(currentIndex, "exact");
    pairs.push({ previous: slot, current: current[currentIndex] });
  });

  if (manifest)
    previous.forEach((slot, previousIndex) => {
      if (usedPrevious.has(previousIndex)) return;
      const matching = manifest.migrations.filter((migration) =>
        matchesIdentitySelector(
          migration.from,
          {
            venue: slot.venue,
            edition: slot.edition,
            kind: slot.kind,
            round: slot.round,
            track: slot.track,
          },
          new Date(slot.earliest_ms).toISOString(),
          new Date(slot.latest_ms).toISOString(),
        ),
      );
      if (matching.length !== 1) return;
      const candidates = current
        .map((candidate, index) => ({ candidate, index }))
        .filter(
          ({ candidate, index }) =>
            identityKey(candidate) === identityKey(matching[0].to) &&
            (!usedCurrent.has(index) ||
              currentUse.get(index) === "exact" ||
              matching[0].action === "duplicate-collapse"),
        );
      if (candidates.length !== 1) return;
      const currentIndex = candidates[0].index;
      usedPrevious.add(previousIndex);
      if (!usedCurrent.has(currentIndex)) {
        usedCurrent.add(currentIndex);
        currentUse.set(currentIndex, "migration");
      }
      pairs.push({ previous: slot, current: current[currentIndex], migration: matching[0] });
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
    currentUse.set(currentIndex, "exact");
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
    // Same-raw-value timezone discrepancy: two aggregator sources interpret
    // the same date string with different timezone offsets (e.g. PST vs PDT).
    // When the gap is exactly 1 hour and both members are exact precision,
    // pick the primary (earlier deadline = more conservative) and warn.
    if (exact.length === members.length && exact.length === 2) {
      const gap = Math.abs(exact[0].earliest_ms - exact[1].earliest_ms);
      if (gap === 3_600_000) {
        warnings.push(`${side} timezone discrepancy resolved: ${id} (1h gap)`);
        resolved.push(exact[0].earliest_ms <= exact[1].earliest_ms ? exact[0] : exact[1]);
        continue;
      }
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
  const latestPrior =
    prior.length > 0
      ? Math.max(...prior.map((evidence) => evidenceTime(evidence)!))
      : Number.NEGATIVE_INFINITY;
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
  manifest: IdentityMigrationManifest | null | undefined,
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
  const migrationErrors = validateIdentityMigrationManifest(
    manifest,
    new Set(newGroups.slots.map((slot) => identityKey(slot))),
  );
  if (migrationErrors.length > 0) {
    reasons.push(
      ...migrationErrors.map((error) => `identity migration manifest invalid: ${error}`),
    );
    return { ok: false, reasons, warnings };
  }
  const { pairs, unmatchedPrevious } = matchDeadlineSlots(
    oldGroups.slots,
    newGroups.slots,
    manifest,
  );
  for (const pair of pairs) {
    if (pair.current.earliest_ms >= pair.previous.latest_ms) continue;
    // 正典の supersession 台帳が旧値を現行値への公式訂正として記録している場合、
    // 前倒し・精度後退は根拠付きの訂正であり配信阻止しない。
    if (supersededCovers(pair.previous, pair.current, currentTime)) continue;
    if (pair.previous.precision === "exact" && pair.current.precision === "date-only") {
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
    if (authorizesEarlier(pair.previous, pair.current)) continue;
    reasons.push(`deadline pulled earlier without evidence: ${pair.previous.deadline_id}`);
  }
  for (const slot of unmatchedPrevious) {
    if (slot.latest_ms <= previousTime) continue;
    if (!Number.isFinite(currentTime) || slot.latest_ms > currentTime) {
      // 消えた旧 slot が同一 venue (または legacy 移行先 venue) の現行 slot の
      // supersession 台帳に旧値として記録されている場合 (公式訂正による段階統合・
      // 値の置換) は消失と扱わない。
      const migratedVenues = new Set(
        (manifest?.migrations ?? [])
          .filter((migration) => migration.from.venue === slot.venue)
          .map((migration) => migration.to.venue),
      );
      if (
        newGroups.slots.some(
          (candidate) =>
            (candidate.venue === slot.venue || migratedVenues.has(candidate.venue)) &&
            // track も一致を要求する: supersededCovers 自体は superseded_by を
            // venue/edition/kind/round までしか照合しないため、これがないと
            // ある track の正当な訂正台帳が、値も一致する別 track の消失まで
            // 免責してしまう (#722)。
            candidate.track === slot.track &&
            supersededCovers(slot, candidate, currentTime),
        )
      )
        continue;
      const identityCandidate = newGroups.slots.some(
        (candidate) =>
          candidate.venue !== slot.venue &&
          candidate.year === slot.year &&
          candidate.kind === slot.kind &&
          candidate.round === slot.round &&
          candidate.track === slot.track &&
          candidate.earliest_ms === slot.earliest_ms &&
          candidate.latest_ms === slot.latest_ms,
      );
      reasons.push(
        identityCandidate
          ? `identity migration required: ${slot.deadline_id}`
          : `future deadline disappeared: ${slot.deadline_id}`,
      );
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
  warning_identities?: string[];
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
  // Offline builds intentionally use committed snapshot data; observation
  // staleness (relative to BUILD_NOW) is expected and not actionable.
  const isOffline = currentReport.build_input_mode === "offline-snapshot";
  for (const [source, metadata] of Object.entries(currentReport.source_metadata ?? {})) {
    if (source === "local") continue;
    if (isOffline) continue;
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
      currentReport.identity_migrations,
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
  // Identity-based warning comparison (set-diff instead of code/count).
  // When warning_identities are available on both sides, compare by unique
  // identity keys so that venue A being fixed while venue B breaks is detected.
  const previousWarningIdentities: string[] | undefined = previousIsOnline
    ? previousReport.warning_identities
    : observation?.warning_identities;
  if (
    diagnosticsAvailable &&
    Array.isArray(previousWarningIdentities) &&
    previousWarningIdentities.length > 0
  ) {
    const previousKeySet = new Set(previousWarningIdentities);
    const currentKeys = currentReport.warning_identities ?? [];
    const newKeys = currentKeys.filter((key) => !previousKeySet.has(key));
    if (newKeys.length > 0) {
      reasons.push(`new warning identities: ${newKeys.length}`);
    }
  } else if (diagnosticsAvailable) {
    // Fallback: legacy code/count comparison for baselines without identities.
    const previousWarningCodes: Record<string, { count: number; messages: string[] }> | undefined =
      previousIsOnline ? previousReport.warning_codes : observation?.warning_codes;
    if (previousWarningCodes) {
      for (const [code, warning] of Object.entries(currentReport.warning_codes ?? {})) {
        const prior = previousWarningCodes[code];
        if (!prior) reasons.push(`new warning code: ${code}`);
        else if (warning.count > prior.count) reasons.push(`warning code increased: ${code}`);
      }
    }
  }
  return { ok: reasons.length === 0, reasons, warnings };
}

export function healthMarkdown(report: HealthReport, omittedOutputs: string[] = []): string {
  /* 「health.md：health.json の人間向け要約」と書きながら、本文だけ英語のままだった
   * （2026-09-23 確認）。読むのは収録を確かめる人なので日本語に寄せる。
   * 機械可読の正は `health.json` なので、見出しには JSON のキーを併記する
   * （日本語のラベルだけ見てキーを辿れなくしないため）。 */
  const metric = (label: string, key: string, value: string | number) =>
    `| ${label}（\`${key}\`） | ${value} |`;
  const SOURCE_STATUS_JA: Record<string, string> = {
    fresh: "今回取得",
    "snapshot-fallback": "収録 snapshot から",
    failed: "取得失敗",
  };
  const sourceNote = (status: string) => SOURCE_STATUS_JA[status] || `不明（${status}）`;
  const fallbackSources = Object.entries(report.source_status)
    .filter(([, status]) => status !== "fresh")
    .map(([source]) => source);
  const lines = [
    "# ビルド健全性",
    "",
    `生成時刻（\`generated_at\`）: ${report.generated_at}`,
    "",
    "## まとめ",
    "",
    `- 収録している会議は ${report.tracked_venues} 件。うち次回以降に確定した締切を持つ会議が ${report.future_confirmed_venues} 件、推定締切を持つ会議が ${report.future_estimated_venues} 件。`,
    `- 次回以降の締切は確定 ${report.future_exact_deadlines ?? 0} 件（時刻まで確定）+ 日付のみ ${report.future_date_only_deadlines ?? 0} 件、推定 ${report.future_estimated_deadlines ?? 0} 件。推定は公式サイトで裏が取れるまで既定の一覧に出さない。`,
    // グローバルなフォールバック旗とソース別の状況が食い違うことがある
    // （上流にあたって一部だけ snapshot を使った組み立て）。両方出すと読者が迷うので、
    // 実態の式を 1 つにまとめて書く。
    fallbackSources.length === 0
      ? "- 今回の組み立ては上流をその場であたって行った。"
      : report.snapshot_fallback
        ? "- 今回の組み立ては収録 snapshot（リポジトリに確定済みの上流データ）で組んだ。上流をその場で取っていないので、日付は snapshot を取った時点のまま。"
        : `- 今回の組み立ては上流をその場であたったが、一部（${fallbackSources.join(" / ")}）は収録 snapshot の値を使った。`,
    fallbackSources.length
      ? `- 収録 snapshot にフォールバックしたソース: ${fallbackSources.join(" / ")}（未取得のぶんは snapshot の値で組んでいる）`
      : "- 収録 snapshot にフォールバックしたソースはない。",
    "",
    "## 収録の数",
    "",
    "| 意味（`health.json` のキー） | 値 |",
    "|---|---:|",
    metric("収録している会議", "tracked_venues", report.tracked_venues),
    metric(
      "次回以降に確定した締切を持つ会議",
      "future_confirmed_venues",
      report.future_confirmed_venues,
    ),
    metric(
      "次回以降に推定締切を持つ会議",
      "future_estimated_venues",
      report.future_estimated_venues,
    ),
    metric("確定した締切", "confirmed_deadlines", report.confirmed_deadlines),
    metric("推定締切", "estimated_deadlines", report.estimated_deadlines),
    metric(
      "次回以降の締切（時刻まで確定）",
      "future_exact_deadlines",
      report.future_exact_deadlines ?? 0,
    ),
    metric(
      "次回以降の締切（日付のみ）",
      "future_date_only_deadlines",
      report.future_date_only_deadlines ?? 0,
    ),
    metric(
      "次回以降の推定締切",
      "future_estimated_deadlines",
      report.future_estimated_deadlines ?? 0,
    ),
    metric(
      "次回以降に時刻まで確定した締切を持つ会議",
      "venues_with_exact_future_deadline",
      report.venues_with_exact_future_deadline ?? 0,
    ),
    metric(
      "次回以降に日付のみの締切を持つ会議",
      "venues_with_date_only_future_deadline",
      report.venues_with_date_only_future_deadline ?? 0,
    ),
    metric(
      "会議 key の移行記録",
      "identity_migrations",
      report.identity_migrations?.migrations.length ?? 0,
    ),
    metric("解析上の注意の件数", "parse_warning_count", report.parse_warning_count),
    `| 収録 snapshot で組んだか（\`snapshot_fallback\`） | ${report.snapshot_fallback ? "はい" : "いいえ"} |`,
    `| 入力プロファイルのハッシュ（\`profile_hash\`） | ${report.profile_hash} |`,
    "",
    "## 上流ソースの状況",
    "",
    "| ソース | 状況 |",
    "|---|---|",
    ...Object.entries(report.source_status).map(
      ([source, status]) => `| ${source} | ${sourceNote(status)}（\`${status}\`） |`,
    ),
    "",

    `上流の取得に失敗したソース: ${report.source_failures.length > 0 ? `${report.source_failures.join(", ")}（収録 snapshot の値で組んだ）` : "なし"}`,
    "",
    "## 分野の内訳",
    "",
    "> 分野は機械可読のキー（`data.json` の `categories` と同じ物）で出す。日本語の名前は画面のチップと行の詳細に出る物と同じ入口（`Recommender.categoryLabelJa`）から添える（第 703 回）。",
    "",
    "| 分野（キー） | 日本語 | 会議数 |",
    "|---|---|---:|",
    ...Object.entries(report.category_distribution).map(([category, count]) => {
      const label = String(Recommender.categoryLabelJa(category) ?? "").trim();
      return `| ${category} | ${label && label !== category ? label : "－"} | ${count} |`;
    }),
    "",
    "## 解析上の注意",
    "",
    ...(Object.entries(report.parse_warnings).length
      ? Object.entries(report.parse_warnings).map(([message, count]) => `- ${count} 件: ${message}`)
      : ["- なし"]),
    "",
    "## 必ず収録しておきたい会議",
    "",
    ...(Object.entries(report.required_venues).length
      ? Object.entries(report.required_venues).map(
          ([venue, status]) =>
            `- ${venue}: ${status === "present" ? "収録済み" : `未取得（${status}）`}`,
        )
      : ["- なし"]),
    "",
    "## 出力ファイル",
    "",
    /* 「出力ファイル」という見出しの下に一部だけを並べると、読者はそれが配付物の全部だと
     * 読む（2026-08-09 生成のビルドで実測: 配付先に置くファイルは 16 件、この表は 13 件で、
     * 除く 3 件のことをどこにも書いていなかった）。載らない物とその理由を、表の直前で
     * 自分で言う。名前は呼び出し側の実際の書き出し順から渡す（書き写すと順が変わったとき
     * に噓をつく）。 */
    ...(omittedOutputs.length
      ? [
          `> この表に載るのは、表を組み立てた時点で書き終わっていた出力だけです。載らないのは ${omittedOutputs
            .map((name) => `\`${name}\``)
            .join(
              "・",
            )} です。\`health.json\` と \`health.md\` はこの表のうしろに書き出すので、自分自身のハッシュをここには書けません。\`publish.json\` は後段の公開手順が書き出します。配付物のバイト数とハッシュの完全な一覧は \`publish.json\` の \`artifacts\` にあります（そこに \`publish.json\` 自身は載りません）。`,
          "",
        ]
      : []),
    "| ファイル | バイト数 | SHA-256 |",
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
  venuePapers?: Record<string, string[]>,
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
    ? embeddingProfileHash(JSON.parse(readFileSync(join(outdir, "data.json"), "utf8")), venuePapers)
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

function csvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 締切の枠（venue・開催回・種別・回次・トラック）の印。`data.json` の締切と
 * `recordsOf` の締切を突き合わせるのに使う（`reverify` の `deadlineSlotId` と同じ組み方）。 */
function deadlineSlotKeyJa(
  venueKey: string,
  editionId: string,
  deadline: { kind?: string; round?: number; track?: string; label?: string },
): string {
  return [
    venueKey,
    editionId,
    deadline.kind ?? "",
    deadline.round ?? 1,
    deadlineTrackKey(deadline.label ?? "", deadline.kind ?? "", deadline.track ?? ""),
  ].join("\0");
}

/** `data.json` の締切が持つ確認の状態を、枠から引ける形にする。
 *
 * `data.csv` は `recordsOf` の生の締切を見るので、**保存された記録が無い行**（`toJson` が
 * 証拠から足した `pending`・`manual-required`）が空欄になっていた（2026-10-17 実測:
 * 2,480 行が `data.json` に状態を持ちながら CSV は空欄。畫面の札と暦は同じ状態を出している）。 */
export function verificationBySlot(
  data: { conferences?: unknown } | null | undefined,
): Map<string, { status: string; source_class: string }> {
  const 表 = new Map<string, { status: string; source_class: string }>();
  const conferences = (data as { conferences?: unknown[] } | null | undefined)?.conferences;
  if (!Array.isArray(conferences)) return 表;
  for (const conf of conferences as Array<Record<string, unknown>>) {
    const key = String(conf.key ?? "");
    for (const ed of (conf.editions ?? []) as Array<Record<string, unknown>>) {
      const editionId = String(ed.id ?? "");
      for (const dl of (ed.deadlines ?? []) as Array<Record<string, unknown>>) {
        const v = dl.verification as Record<string, unknown> | undefined;
        if (!v) continue;
        const status = String(v.status ?? "").trim();
        const sourceClass = String(v.source_class ?? "").trim();
        if (!status && !sourceClass) continue;
        表.set(
          deadlineSlotKeyJa(key, editionId, {
            kind: String(dl.kind ?? ""),
            round: Number(dl.round ?? 1),
            track: String(dl.track ?? ""),
            label: String(dl.label ?? ""),
          }),
          { status, source_class: sourceClass },
        );
      }
    }
  }
  return 表;
}

export function toCsv(
  records: DataRecord[] | null | undefined,
  確認の寫?: Map<string, { status: string; source_class: string }>,
): string {
  const lines: string[] = [];
  lines.push(CSV_COLUMNS.join(","));
  for (const rec of records ?? []) {
    if (!rec || typeof rec !== "object" || rec.type !== "deadline") continue;
    const { conf, edition: ed, deadline: dl } = rec;
    if (!conf || !ed || dl === null || dl === undefined) continue;
    const 寫 = 確認の寫?.get(deadlineSlotKeyJa(conf.key, ed.edition_id, dl));
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

        String(rec.kind_ja ?? rec.kind_label ?? "").trim() || KIND_LABEL_JA.other,
        // 日付の列が締切の日を指しているかどうかは、この欄で決まる。
        String(rec.date_field ?? "").trim() || "締切",
        ed.event_segments?.length ? JSON.stringify(ed.event_segments) : "",
        /* 確認の状態。**`data.json` と同じ値**を書く（列の説明がそう言っている）。
         * 保存された記録が無い行は、`toJson` が証拠から足した状態を表から引く –
         * 畫面の札と暦（`deadlines.ics`）は同じ状態を出しているので、CSV だけ空欄だと
         * 同じ行が出口ごとに違う事になる（第 861 回の暦と同じ理由）。表にも無い行だけ
         * 空欄にする（「未確認」とは書かない – 空欄は「その値が分からん」の意）。 */
        寫?.status ?? dl.verification?.status ?? "",
        寫?.source_class ?? dl.verification?.source_class ?? "",
        Recommender.isExtendedDeadline(dl) ? "true" : "false",
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

/** HTML に出す文字をエスケープする（セルに `<` を含む表記が来ない保証は無いため）。 */
function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ カレンダー配信 */

export function sessionSpanJa(
  start: unknown,
  end: unknown,
  estimated: boolean | null | undefined,
): string {
  const from = asDate(start);
  if (!from) return "";
  const to = asDate(end) ?? from;
  const one = (d: Date): string => {
    const day = calendarDayJa(d);
    return day ? `${fmtDate(d)}(${day})` : fmtDate(d);
  };
  const span = from.getTime() === to.getTime() ? one(from) : `${one(from)} 〜 ${one(to)}`;
  return estimated ? `${span}（推定）` : span;
}

export function editionSessionJa(ed: Edition): string {
  if (ed.event_date_precision === "not-announced") {
    const text = Recommender.eventCellJa({ ed });
    return ed.estimated ? `${text}（推定）` : text;
  }
  if (ed.event_date_precision === "month-only" && !ed.event_start && !ed.event_segments?.length) {
    const text = Recommender.eventCellJa({ ed: { ...ed, event_end: fmtDate(ed.event_end) } });
    return ed.estimated ? `${text}（推定）` : text;
  }
  if (!ed.event_start && !ed.event_segments?.length) return "";
  if (ed.event_segments?.length)
    return ed.event_segments
      .map((part) => {
        const text = Recommender.eventCellJa({
          ed: {
            event_start: part.start,
            event_end: part.end,
            event_date_precision: ed.event_date_precision,
          },
        });
        return `${text}${ed.estimated ? "（推定）" : ""}${part.label ? `（${part.label}）` : ""}`;
      })
      .join(" / ");
  const text = Recommender.eventCellJa({
    ed: { ...ed, event_start: fmtDate(ed.event_start), event_end: fmtDate(ed.event_end) },
  });
  return text && ed.estimated ? `${text}（推定）` : text;
}

export function icsEventRows(
  records: DataRecord[] | null | undefined,
  now: Date | null | undefined,
): IcsRow[] {
  return icsRowsWithUids(records, now).rows;
}

/** カレンダーの行と、その行が使った UID を一度に組む。
 *
 * UID を別に組み直すと、片方だけ直した日に食い違う（それが元の不具合だった – 畫面の
 * 書き出しは ASCII の種別の鍵、配付物は日本語の種別名の SHA-1 で、同じ締切が別の予定に
 * なっていた）。**同じ一巡で両方を作る**。
 *
 * 鍵は「開催回・種別・回次・原表記・JST の暦日」。畫面（`catalog.json` の締切）と
 * 同じ材料で組める形にしてある – 畫面は SHA-1 を持たないので、配付物の UID を
 * データに載せて渡す。 */
export function icsRowsWithUids(
  records: DataRecord[] | null | undefined,
  now: Date | null | undefined,
): { rows: IcsRow[]; uids: Map<string, string> } {
  const uids = new Map<string, string>();
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const stamp = jstParts(safeNow);
  const rows: IcsRow[] = [];
  const used = new Map<string, number>();
  const submissionOf = (rec: DataRecord) => {
    if (rec.conf?.key !== "jip" && rec.conf?.key !== "ipsj-27-r-compsac") return null;
    return reviewedSubmission({
      venueKey: rec.conf.key,
      editionId: rec.edition?.edition_id,
      editionYear: rec.edition?.year,
      label: rec.deadline?.label,
      officialUrl: rec.edition?.link || rec.conf.link,
      kind: rec.deadline?.kind,
      round: rec.deadline?.round,
      track: rec.deadline?.track,
      precision: rec.deadline?.precision,
      localDate: rec.deadline?.local_date,
    });
  };
  const canonicalPresent = (records ?? []).some(
    (rec) => rec?.type === "deadline" && rec.conf?.key === "jip" && submissionOf(rec),
  );
  const reviewedSeen = new Set<string>();
  for (const rec of records ?? []) {
    if (!rec || typeof rec !== "object" || rec.type !== "deadline") continue;
    const dl = rec.deadline;
    if (!dl) continue;
    const submission = submissionOf(rec);
    if (
      submission &&
      ((canonicalPresent && rec.conf.key !== "jip") || reviewedSeen.has(submission.key))
    )
      continue;
    if (submission) reviewedSeen.add(submission.key);
    const conf = rec.conf ?? {};
    const ed = rec.edition ?? {};
    const kind = String(rec.kind_label ?? "").trim() || "締切";
    let day: string;
    let whenText: string;
    let atMs: number;
    if (isDateOnlyDeadline(dl)) {
      if (dateOnlyState(dl.local_date, safeNow) === "definitely-past") continue;
      const raw = String(dl.local_date ?? "")
        .replace(/-/g, "")
        .slice(0, 8);
      if (!/^\d{8}$/.test(raw)) continue;
      day = raw;
      whenText = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}（時刻未確認）`;
      // 並び順のための時刻（JST 正午）。表示には使わない – 終日イベントにするため。
      atMs = Date.UTC(
        Number(raw.slice(0, 4)),
        Number(raw.slice(4, 6)) - 1,
        Number(raw.slice(6, 8)),
        12 - 9,
      );
    } else {
      if (exactDeadlineState(dl.at_utc, safeNow) === "past") continue;
      const parts = jstParts(dl.at_utc);
      if (!parts) continue;
      day = parts.day;
      whenText = `${parts.human}（JST）`;
      atMs = dl.at_utc.getTime();
    }
    const title = submission
      ? titleWithYear(submission.title, submission.publicationYear)
      : titleWithYear(conf.title, ed.year);

    const kindWord = String(rec.kind_ja ?? "").trim() || kind;
    const kindNote = String(rec.kind_note ?? "").trim();
    const kindShown = kindNote ? `${kindWord}（${kindNote}）` : kindWord;
    const summary = rec.estimated ? `${title}：${kindShown}（推定）` : `${title}：${kindShown}`;
    const link = ed.link || conf.link || "";

    const 状態 = statusMarksJa(dl);
    const placeJa = String(
      Recommender.placeJa(Recommender.placeWithPrefectureJa(ed.place)) ?? "",
    ).trim();
    const catsJa = icsCategoryLabels(conf.categories);
    const desc = [
      `会議: ${title}`,
      `種別: ${kindShown}`,

      catsJa.length ? `分野: ${catsJa.join("・")}` : "",
      `${rec.date_field}: ${whenText}`,

      submission
        ? `掲載予定: ${submission.issueLabel}／${submission.language}`
        : `会期: ${editionSessionJa(ed) || Recommender.unconfirmedLabelJa()}`,
      `開催地: ${placeJa || Recommender.unconfirmedLabelJa()}`,
      rec.estimated ? "この日付は上流が推定として出したもので、公式で裏を取れていません" : "",

      状態.length ? `状態: ${状態.join("・")}` : "",
      link ? `詳細: ${link}` : "",
      `収録: ${ICS_CAL_NAME_JA}（データ生成: ${stamp ? `${stamp.human}（JST）` : "未確認"}）`,
    ].filter(Boolean);

    const kindTag =
      icsUidSafe(kind) || createHash("sha1").update(kind, "utf8").digest("hex").slice(0, 8);
    const base = [
      "kamiyobi",
      icsUidSafe(ed.edition_id || `${conf.key ?? "conf"}-${ed.year ?? ""}`),
      kindTag,
    ]
      .filter(Boolean)
      .join("-");
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    const uid = `${base}${n === 0 ? "" : `-${n + 1}`}@kamiyobi`;
    uids.set(
      icsDeadlineUidKey(
        String(ed.edition_id ?? ""),
        String(dl.kind ?? ""),
        dl.round,
        String(dl.label ?? ""),
        day,
      ),
      uid,
    );
    rows.push({
      day,
      at: atMs,
      // 欄名を決めた所で「締切かどうか」も決めておく（数え方を後から真似ない – 第 300 回）。
      deadline: rec.date_field === "締切",

      body: icsEventBody(
        {
          uid,
          day,
          summary,
          description: desc.join("\n"),
          link,
          categories: catsJa,
          location: placeJa,
        },
        safeNow,
      ),
    });
  }
  rows.sort((a, b) => a.at - b.at || cmpStr(a.body[5] ?? "", b.body[5] ?? ""));
  return { rows, uids };
}

/** 締切ごとの UID を引く鍵。**配付物と畫面の両方が同じ材料で組める形**にする
 * （開催回・種別・回次・原表記・JST の暦日）。日付を入れるのは引くためだけで、
 * UID その物は日付を含まない（締切が動いても購読者の予定が入れ替わらないため）。 */
export function icsDeadlineUidKey(
  editionId: string,
  kind: string,
  round: unknown,
  label: string,
  day: string,
): string {
  return [editionId, kind, String(Number(round ?? 1) || 1), label, day].join("\u0000");
}

/* 購読先に申告する事実。行から導く – 別々に数えると、申告と中身がズレる
 * （「928 件」と書いて 927 件しか入っていない、が一番信用を失う）。 */
/** 入口（行を作ってカレンダーの本文に組む）。行だけが必要なら `icsEventRows` を使う。 */
export function toIcsText(
  records: DataRecord[] | null | undefined,
  now: Date | null | undefined,
): string {
  return icsCalendarText(icsEventRows(records, now), now);
}

/* 静的な一覧（`upcoming.html`）の入口と終端で使う言い回し。同じ語を 2 か所に書くと
 * 片方だけ直してズレるので、1 個の正本から組む。このページの本文は 1,127 行あり、
 * 「戻る」は先頭に 1 つしか無かった（最後の行を読んだ人は約 50 画面ぶん上に戻ら
 * なければならなかった – 2026-09-23 実測: `index.html` へのリンクは文書全体で 1 個、
 * `</table>` のうしろには何も無い）。 */

const UPCOMING_TITLE_JA = "直近の締切と会期 | kamiyobi";
/* 面板と同じ 2 色。`site/template.html` に書いてある物と必ず揃える（ズレは検査で止める）。 */
const UPCOMING_THEME_LIGHT = "#f7f7f8";
const UPCOMING_THEME_DARK = "#18181b";
/* このページは JavaScript を 1 文字も読み込まない（実測: 画面の `script` は 0 個）ので、
   画面より強く締められる。`style-src` の `'unsafe-inline'` は埋め込む様式（`siteStyleBlock`）用。
   `frame-ancestors` は meta 経由では効かないので書かない（画面と同じ理由）。 */
const UPCOMING_CSP =
  "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'none'; " +
  "style-src 'unsafe-inline'; img-src 'self' data:; form-action 'none'";

/* 画面の表へ戻る口の言い回し。HTML（`upcoming.html`）とマークダウン（`upcoming.md`）で
 * 同じ語を使うため、矢印を外した本文だけをここに持つ（同じ語を 2 か所に持たない）。 */
const UPCOMING_BACK_TEXT_JA = "締切の一覧に戻る";
const UPCOMING_BACK_LABEL_JA = `&larr; ${UPCOMING_BACK_TEXT_JA}`;
const UPCOMING_TOP_LABEL_JA = "&uarr; 先頭に戻る";

function pageDescription(heading: string, columns: string[]): string {
  const title = heading.trim() || "直近の締切と会期";
  const cols = columns.length ? `${columns.join("・")}の列で、` : "";
  return (
    `${title}を一覧にしたページです。${cols}日時は日本時間（JST）と曜日で出します。` +
    "画面の絞り込みを使わない方向けの静的な表で、同じデータは upcoming.md・data.csv・" +
    "deadlines.ics でも配信しています。"
  );
}

export function toNotFoundHtml(styleBlock = "", baseUrl = ""): string {
  const base = baseUrl.replace(/\/+$/, "");
  const link = (file: string): string => (base ? `${base}/${file}` : file);
  const row = (file: string, label: string, note: string): string =>
    `<li><a href="${escapeHtmlText(link(file))}">${label}</a>${note}</li>`;
  return [
    "<!doctype html>",
    '<html lang="ja">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // 無い場所の応答なので、検索エンジンに本文として拾わせない。
    '<meta name="robots" content="noindex">',
    "<title>ページが見つかりません - kamiyobi</title>",
    `<link rel="icon" href="${escapeHtmlText(link("icon.svg"))}" type="image/svg+xml">`,
    styleBlock,
    "</head>",
    "<body>",
    /* 樣式の塊は雛形から渡すが、幅と余白は `.wrap` が持っている。付け忘れると本文が
     * 畫面の端から端まで屆き、廣い畫面で 1 行が長くなり過ぎる（2026-10-17 實測:
     * `upcoming.html` は `<main class="wrap">`、404 だけ素の `<main>` だった）。 */
    '<main class="wrap">',
    "<h1>そのページは見つかりません</h1>",
    "<p>URL の打ち間違いか、リンクが古くなっています。締切と会期の情報は次の場所に在ります。</p>",
    "<ul>",
    row(
      "index.html",
      "締切の一覧（画面）",
      " – 残り日数・日本時間への換算・絞り込み・検索はそちらでできます。収録の全体を読むこともできます",
    ),
    row(
      "upcoming.html",
      "直近の締切と会期の表",
      " – 実行処理を必要としない版（印刷・JavaScript なしで読める）",
    ),
    row("deadlines.ics", "カレンダー（deadlines.ics）", " – 収録している今後の締切を全て"),

    row("data.csv", "表計算のための表（data.csv）", " – 1 行 1 締切。過去の分も入っている"),
    row("upcoming.md", "文字だけの表（upcoming.md）", " – 直近 180 日。grep や他ツールに渡せる形"),
    row(
      "data.json",
      "機械可読のデータ（data.json）",
      " – 画面より広い期間（過去の全履歴とそれより先の締切）まで入っている",
    ),
    row(
      "llms.txt",
      "機械向けの索引（llms.txt）",
      " – 出口が何で、それぞれに何が載っているかを並べた物",
    ),
    "</ul>",
    "<p>探している会議が収録にあるか分からないときは、画面の検索欄に会議名の固有名詞を打ってください。" +
      "0 件のときは、その名前が収録の名簿にあるかどうかも画面が言います。</p>",
    "<p>このページ自体は締切も会期も載せません（日付を推測しないため）。</p>",
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** 機械可読の自己紹介（schema.org の `Dataset`）。
 *
 * 頁を開いた AI と検索の側に「これは何のデータで、どこにあり、いつ作られ、どこまでを
 * 覆うか」を一度に言う。値は**ビルドが数えた実測**を使う – 定数を書くと次のビルドで
 * 噓になる（件数・期間・生成時刻）。 */
export function toDatasetJsonLd(input: {
  baseUrl?: string;
  title?: string;
  description?: string;
  generatedAt?: string;
  span?: DeadlineSpan | null;
  repoUrl?: string;
  keywords?: string[];
}): string {
  const base = String(input.baseUrl ?? "").replace(/\/+$/, "");
  const link = (file: string): string => (base ? `${base}/${file}` : file);
  const repo = String(input.repoUrl ?? "").replace(/\/+$/, "");
  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: String(input.title ?? "kamiyobi"),
    url: base ? `${base}/` : "index.html",
    inLanguage: "ja",
    isAccessibleForFree: true,
    /* 配付する 4 本。どれも毎回のビルドで書く物だけを並べる（`embeddings.json` は
     * `--no-embeddings` で消えるので入れない）。 */
    distribution: [
      ["data.json", "application/json", "正規化した収録データ全体（機械可読の正）"],
      ["data.csv", "text/csv", "1 行 1 締切の平坦な表"],
      ["deadlines.ics", "text/calendar", "今後の締切の購読用カレンダー（RFC 5545）"],
      ["llms.txt", "text/plain", "出力ファイルとデータ形式の索引（AI 向け）"],
    ].map(([file, format, name]) => ({
      "@type": "DataDownload",
      name: String(name),
      encodingFormat: String(format),
      contentUrl: link(String(file)),
    })),
  };
  if (input.description) node.description = String(input.description);
  if (input.generatedAt) node.dateModified = String(input.generatedAt);
  if (input.span) node.temporalCoverage = `${input.span.first_day}/${input.span.last_day}`;
  if (repo) node.creator = { "@type": "Organization", name: "kamiyobi", url: repo };
  if (repo) node.license = `${repo}/blob/main/LICENSE`;
  if (input.keywords?.length) node.keywords = [...input.keywords];
  /* 頁の中に置くので、`</script>` で早く閉じさせない（値は全て自分で組んだ物だが、
   * 説明文は雛形から取るので、念のため）。 */
  const json = JSON.stringify(node, null, 2).replace(/<\//g, "<\\/");
  return `<script type="application/ld+json">\n${json}\n</script>`;
}

/** 機械が最初に読む 1 枚（RFC 9309）。AI の索引（`llms.txt`）への道もここに書く –
 * 索引はページからも辿れるが、クローラは最初にこのファイルを読む。 */
export function toRobotsTxt(baseUrl = ""): string {
  const base = baseUrl.replace(/\/+$/, "");
  const lines = [
    "# kamiyobi - submission deadlines of CS conferences, workshops and journals",
    `# Machine-readable index for AI agents: ${base ? `${base}/llms.txt` : "llms.txt"}`,
    "User-agent: *",
    "Allow: /",
    "",
  ];
  /* `Sitemap` は群の外に置く（RFC 9309 の群は空行で切れる）。 */
  if (base) lines.push(`Sitemap: ${base}/sitemap.xml`, "");
  return `${lines.join("\n")}\n`;
}

/** 人が開く口の一覧。データのファイル（`data.json` など）は索引（`llms.txt`）が名指す –
 * ここに並べるのは頁として開ける物だけにする。 */
export function toSitemapXml(baseUrl = "", lastmod = ""): string {
  const base = baseUrl.replace(/\/+$/, "");
  const day = /^\d{4}-\d{2}-\d{2}$/.test(lastmod) ? lastmod : "";
  const 口 = ["", "upcoming.html", "upcoming.md", "llms.txt"].map((file) =>
    base ? `${base}/${file}` : file || "index.html",
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...口.map(
      (loc) =>
        `  <url><loc>${escapeHtmlText(loc)}</loc>${day ? `<lastmod>${day}</lastmod>` : ""}</url>`,
    ),
    "</urlset>",
    "",
  ].join("\n");
}

export function toUpcomingHtml(markdown: string, styleBlock = "", baseUrl = ""): string {
  const inlineMd = (value: string): string =>
    escapeHtmlText(value)
      /* 行き先は絶対 URL だけでなく**同じ場所のファイル**（`index.html`）も受ける。絕対 URL だけを
       * 見ていた為、`[絞り込みの効く一覧（\`index.html\`）](index.html)` と
       * `[${UPCOMING_BACK_TEXT_JA}](index.html)` の二つが**生のマークダウンの侭**頁に出ていた
       * （2026-10-06 実測 – upcoming.html の冒頭と末尾。読者は括弧と丸括弧の並びを読まされ、
       * 行き先も押せなかつた）。筋（`javascript:` の樣な物）は通さない – 相対と http(s) だけ。*/

      .replace(/\[([\s\S]*?)\]\(([^)\s]+)\)/g, (_all, text: string, url: string) => {
        const 筋付き = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(url);
        if (筋付き && !/^https?:\/\//.test(url)) return _all;
        // URL は `escapeMdUrl` でパーセント形式（`&` を含まない）にしているが、
        // 属性の引用符は念のため守る。
        return `<a href="${url.replace(/"/g, "%22")}" rel="noopener">${text}</a>`;
      })
      .replace(/`([^`]+)`/g, "<code>$1</code>");

  const out: string[] = [];
  let quote: string[] = [];
  let table: string[] = [];

  let heading = "";
  /* 表を組み立てる最中にしか分からない列の名前を、head の説明にも使う。 */
  let pageColumns: string[] = [];
  const flushQuote = (): void => {
    if (!quote.length) return;
    out.push(
      `<blockquote>\n${quote.map((l) => `<p>${inlineMd(l)}</p>`).join("\n")}\n</blockquote>`,
    );
    quote = [];
  };
  const flushTable = (): void => {
    if (!table.length) return;
    const rows = table.map((line) =>
      line
        .replace(/^\s*\|/, "")
        .replace(/\|\s*$/, "")
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replace(/\\\|/g, "|")),
    );
    const body = rows.filter((cells) => !cells.every((cell) => /^:?-{2,}:?$/.test(cell)));
    const head = body.length ? body[0] : null;
    const rest = body.slice(1);
    const parts: string[] = [];
    if (head) {
      /* 支援技術には「何の表か」「何が何列並ぶか」が先に入ってほしい。この表は
       * 1,127 行あるので、名前の無い表では現在地が分からない（2026-08-09 生成ビルドで
       * 実測: `upcoming.html` の `<table>` に `<caption>` は 0 個で、一覧の側には有った）。
       * 画面には出さない（一覧の `<caption>` と同じ `only-sr` を使う）。 */
      parts.push(
        `<caption class="only-sr">${inlineMd(heading)}の一覧。列は ${head
          .map((cell) => inlineMd(cell))
          .join("・")} です。列の意味と但し書きは表のうえに書いてあります。</caption>`,
      );
      parts.push(
        `<thead><tr>${head
          .map((cell) => `<th scope="col">${inlineMd(cell)}</th>`)
          .join("")}</tr></thead>`,
      );
    }
    /* 幅せま画面（`@media (max-width: 640px)`）では列見出しを消し、各マスの先頭に
     * `data-label` の値を接頭（先頭に付く語）として添えてカードに積む。`upcoming.html` の全マス 6,756 個に
     * `data-label` が **1 個も無く**（2026-09-24 実測）、その幅では各行が「：論文締切」の
     * ようにラベルの空いた記号だけが出て、何が何列か読めなかった。列名は上の
     * 列ヘッダー（`scope="col"`）と同じ物を使う（手で書き写すと列の並びが変わる）。 */
    const columnLabels = head ? head.map((cell) => inlineMd(cell).replace(/<[^>]*>/g, "")) : [];
    pageColumns = columnLabels.map((cell) => cell.trim()).filter((cell) => cell.length > 0);
    /* 「会議」の列を**行ヘッダー**にする。1,126 行を一マスずつ読む時、列名だけでは
     * 「どの会議の行か」が分からず、種別や「推定」が何に対する値か取り出せない
     * （2026-09-24 実測: 行ヘッダーは 0 個で、全マスが `td` だった）。
     * 列名は上の列ヘッダーと同じ語を使うので、番号は書き込まない。 */
    const rowHeadColumn = columnLabels.findIndex((cell) => cell.trim() === "会議");
    if (rest.length) {
      parts.push(
        `<tbody>\n${rest
          .map(
            (cells) =>
              `<tr>${cells
                .map((cell, i) => {
                  const label = columnLabels[i]
                    ? ` data-label="${escapeHtmlText(columnLabels[i])}"`
                    : "";
                  return i === rowHeadColumn
                    ? `<th scope="row"${label}>${inlineMd(cell)}</th>`
                    : `<td${label}>${inlineMd(cell)}</td>`;
                })
                .join("")}</tr>`,
          )
          .join("\n")}\n</tbody>`,
      );
    }

    out.push(
      `<div class="tablewrap">\n<table class="upcoming" id="upcoming-table">\n${parts.join("\n")}\n</table>\n</div>`,
    );
    table = [];
  };

  for (const line of markdown.split("\n")) {
    if (line.startsWith("|")) {
      flushQuote();
      table.push(line);
      continue;
    }
    flushTable();
    if (line.startsWith("# ")) heading = line.slice(2).trim();
    if (line.startsWith("# ") || line.startsWith("## ")) {
      flushQuote();
      const level = line.startsWith("# ") ? 1 : 2;
      out.push(`<h${level}>${inlineMd(line.slice(level + 1))}</h${level}>`);
      continue;
    }
    if (line.startsWith(">")) {
      quote.push(line.replace(/^>\s?/, ""));
      continue;
    }
    flushQuote();
    if (line.trim()) out.push(`<p>${inlineMd(line)}</p>`);
  }
  flushTable();
  flushQuote();

  return [
    "<!doctype html>",
    '<html lang="ja">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${UPCOMING_CSP}">`,
    `<title>${UPCOMING_TITLE_JA}</title>`,
    `<meta name="description" content="${escapeHtmlText(pageDescription(heading, pageColumns))}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="kamiyobi">',
    '<meta property="og:locale" content="ja_JP">',
    `<meta property="og:title" content="${escapeHtmlText(UPCOMING_TITLE_JA)}">`,
    `<meta property="og:description" content="${escapeHtmlText(pageDescription(heading, pageColumns))}">`,
    '<meta name="twitter:card" content="summary">',
    // tab で他タブと見分けるための自前アイコン（画面と同じ物。外部アセットは読まない）。
    '<link rel="icon" type="image/svg+xml" href="icon.svg">',
    // 自分の場所（og:url と canonical は config.yaml の site.base_url から組み立てる）。
    ...(baseUrl
      ? [
          `<meta property="og:url" content="${escapeHtmlText(`${baseUrl}/upcoming.html`)}">`,
          `<link rel="canonical" href="${escapeHtmlText(`${baseUrl}/upcoming.html`)}">`,
        ]
      : []),
    `<meta name="theme-color" content="${UPCOMING_THEME_LIGHT}">`,
    `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${UPCOMING_THEME_DARK}">`,
    styleBlock,
    "</head>",
    "<body>",
    '<main class="wrap">',
    '<p id="top"><a href="index.html">' +
      UPCOMING_BACK_LABEL_JA +
      "</a>（同じ収録内容の一覧で、日本時間への" +
      "換算と残り日数も出します。機械が読む形のマークダウンは " +
      '<a href="upcoming.md">upcoming.md</a>、全件は <a href="data.csv">data.csv</a> にあります。' +
      '締切を自分のカレンダーに入れるには <a href="deadlines.ics">deadlines.ics</a>（今後の締切が全て、' +
      "1 件 = 1 つの終日（JST の暦日）で、このページの絞り込みはありません）。</p>",

    '<p class="skip-to-table"><a href="#upcoming-table">表へ（列の意味と但し書きを飛ばす）</a></p>',
    out.join("\n"),
    // 長い表の終端にも出口を置く（先頭まで戻れないまま画面を閉じないために）。
    '<p><a href="#top">' +
      UPCOMING_TOP_LABEL_JA +
      '</a> <a href="index.html">' +
      UPCOMING_BACK_LABEL_JA +
      "</a></p>",
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
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
  /* 「本日開催」「残り N 日」「N 日後」の 今日 は **JST の暦日**で決める。この表の日付は会期
   * そのもの（時刻を持たない暦日）で、サイトの一覧も JST 固定。UTC の暦日を今日にすると、
   * 日本の午前 9 時までのあいだだけ表が一日古くなる（2026-08-10 08:30 JST 生成で実測: 前日に
   * 終わった会期が「開催中(残り1日)」、当日開始の 2 件が「1日」＝明日になっていた）。日本の朝に
   * この表で出張の予定を読む人が、噓をつかずに済む側へ寄せる。 */
  const today = dateOnly(new Date(safeNow.getTime() + 9 * 3_600_000));
  const horizonDay = dateOnly(new Date(horizon.getTime() + 9 * 3_600_000));
  const rows: string[] = [];
  for (const rec of records ?? []) {
    if (!rec || typeof rec !== "object") continue;
    const { conf, edition: ed } = rec;
    if (!conf || !ed) continue;
    const rawLink = ed.link || conf.link;
    const link = rawLink ? escapeMdUrl(rawLink) : "";
    const titleEscaped = escapeMdCell(titleWithYear(conf.title, ed.year));
    const name = link ? `[${titleEscaped}](${link})` : titleEscaped;
    // md の開催地列は、サイトの表が見せている日本語表記をそのまま使う。
    // `placeWithPrefectureJa` だけだと海外行が "Kunming, China" のまま残り、
    // 「日本」で grep しても国内の行に当たらない（国名の日本語化は `placeJa` が持つ）。
    // 都道府県を添えるのは md 側だけ（サイトは title に原文を落とせるが、md は持てない）。
    // 空の開催地は、空欄にせずサイトと同じ「未確認」を出す。空欄だと公式が出ていないのと
    // 収録漏れが区別できない（SPEC §7 の表と同じ判断）。語は recommender の正本を使い、
    // md に書いた語がサイトの検索で引ける状態も保つ。
    const placeEscaped = escapeMdCell(
      Recommender.placeJa(Recommender.placeWithPrefectureJa(ed.place)) ||
        Recommender.unconfirmedLabelJa(),
    );
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
        const day = calendarDayJa(dl.local_date);
        when = `${dl.local_date}${day ? `(${day})` : ""}（時刻未確認）`;
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
          } else if (Math.floor(remainMs / 60_000) >= 1) {
            left = `${Math.floor(remainMs / 60_000)}分`;
          } else {
            /* 1 分を切った行を「1分」と書かない。上は 日・時間・分 いずれも切り下げなのに、
             * ここだけ 1 に切り上げていた（2026-08-09 実測: 生成時刻ちょうどに締まる行が
             * 「1分」になっていた。同じ行の画面は「まもなく」を出す）。存在しない猶予を
             * 約束するのがいちばん悪いので、画面と同じ語で「猶予を数えられない」を出す。 */
            left = "まもなく";
          }
        }

        when = Recommender.estimateWindowJa(ed) || deadlineWhenText(dl.at_utc, dl.tz_raw);
      }
      // 投稿トラックを補い、種別ラベルに含まれる注記は重ねない。
      const kindText = escapeMdCell(
        rec.kind_note && !rec.kind_label.endsWith(`: ${rec.kind_note}`)
          ? `${rec.kind_label}（${rec.kind_note}）`
          : rec.kind_label,
      );
      const roundText = `R${dl.round}`;

      const sessionText = editionSessionJa(ed) || Recommender.unconfirmedLabelJa();

      const 状態 = statusMarksJa(dl).join("・");
      rows.push(
        `| ${when} | ${left} | ${name} | ${kindText} | ${roundText} | ${ed.estimated ? "推定" : ""} | ${placeEscaped} | ${sessionText} | ${状態} |`,
      );
    } else {
      const start = rec.start;
      const end = rec.end;
      const bounds = Recommender.eventDateBoundsMs(
        fmtDate(start),
        fmtDate(end),
        ed.event_date_precision,
      );
      if (
        ed.event_date_precision === "not-announced" ||
        !bounds ||
        bounds[0] > horizonDay.getTime() ||
        today.getTime() > bounds[1]
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
      if (["month-only", "unverified", "not-announced"].includes(ed.event_date_precision || "")) {
        left = "日付未確認";
      }
      const when = Recommender.eventCellJa({
        ed: {
          event_start: fmtDate(start),
          event_end: fmtDate(end),
          event_date_precision: ed.event_date_precision,
        },
      });
      rows.push(
        `| ${when} | ${left} | ${name} | ${escapeMdCell(rec.kind_note ? `開催（${rec.kind_note}）` : "開催")} | - | ${ed.estimated ? "推定" : ""} | ${placeEscaped} | ${when} |  |`,
      );
    }
  }
  // md を単体で読む人（grep する人、他ツールに食わせる人）にとって、
  // 「いつの時点で」「いつまで」を網羅した表なのかが分からないと表を使えない。
  // サイト側は JST 基準で揃えているので、生成時刻の JST での読み方も添える。
  const spanEnd = fmtDate(horizonDay);
  const spanEndWeekday = calendarDayJa(spanEnd);
  const head = [
    `# 直近 ${safeDays} 日の締切と開催`,
    "",
    `生成時刻: ${fmtUTC(safeNow, "%Y-%m-%dT%H:%M:%SZ")}（JST では ${jstClock(safeNow)}）`,
    `対象期間: ${fmtDate(today)} 〜 ${spanEnd}${spanEndWeekday ? `(${spanEndWeekday})` : ""}（日本時間の暦日。生成時刻から ${safeDays} 日先まで。進行中の会期は開始日が生成時刻より前でも載る）`,
    "",

    "> 日付列は締切の公式表記（AoE / UTC / JST 宣言）をそのまま載せ、日本時間での読みを後に添える",
    "> （`2026-02-06(金) 23:59:00 AoE（JST では 2026-02-07(土) 20:59）` の形。AoE 23:59 は",
    "> 日本では翌日の夜で、日が変わる行が多い）。行の並びは締切の瞬間の古い順で、日付列に書いた",
    "> 暦日の順ではない（時刻未確認の行はその日の 00:00 UTC に並ぶ）。絞り込みと並び替えは、",
    "> 同じ式を出す [絞り込みの効く一覧（`index.html`）](index.html) が早い。",
    "> 会期行の日付は開催日そのもの（暦日）で、時刻は持たない。",
    "",
    // 列の名前だけでは読めない（特に短縮した見出し）。この表を単体で開いた人が、
    // 表のうえだけで列の意味を確定できるようにする（サイトと同じ語を使う）。
    "> 列の意味: 「残り」は生成時刻からの残り（1 分未満は 1 分、以降は日）。種別が「開催」の行は",
    "> 締切ではなく会議の会期そのもので、残りの列は「本日開催」「開催中(残り N 日)」と書く。",
    "> 「ラウンド」は同じ会議の中の繰り返しの募集（R1・R2 のように数える。会期行は「-」）。",
    "> 「会期」は会議が開かれている日の範囲で、出張の段取りはこの列を見る（`deadlines.ics` の",
    "> 各予定の本文に書いた物と同じ値で、上流が推定とした会期には「（推定）」を添える）。種別が",
    "> 「開催」の行は日付列が会期その物なので、同じ値を繰り返す。",
    "> 「推定」は前年までの実績から機械的に置いた未確認の値で、公式の発表ではない。",
    "> 「状態」は、公式ページから締切を 1 つに確定できなかった日（「要確認」）や、",
    "> 上流が締切を後ろへ動かした日（「延長後」）に付く（画面の一覧の札と同じ語）。空欄は、",
    "> 公式で確認済みか、確認の記録がない日のいずれか。",

    "> 上流が推定とした締切は、日付の欄に『推定期間 A〜B』の形で幅を書く（どの日かは決まっていないので、一日に決めない）。",

    "> 種別は日本語の名（『論文締切』など）。上流が同じ種別に**元の呼び名**を付けている行は、『論文締切: Paper submission』の様に後ろへ添える（元の呼び名は上流の言葉の侭）。",
    /* 目印の語はこの表に実際に並ぶ物だけ説明する（2026-08-09 生成ビルドの実測: 1,127 行の
     * うち開催地が「未確認」182 行、日付に「（時刻未確認）」を持つ行 180 行、AoE の宣言が
     * 410 箇所）。「未確認」を「収録元が無いと決めた意味」と誤読されると、探している会議を
     * 捨ててしまう。意味の文は画面のてびき・印刷の但し書きと同じ正本から取る。 */
    `> 「${Recommender.unconfirmedLabelJa()}」は${Recommender.unconfirmedMeaningJa()}です。この表では開催地の列に`,
    "> 出ます。",
    `> 日付列の「（${Recommender.timeUnconfirmedLabelJa()}）」は、その日であることだけを確認できて、何時までに`,
    "> 出すかが公式に出ていない行。",
    `> ${Recommender.aoeMeaningJa()}。`,
    "",
    "| 日付 | 残り | 会議 | 種別 | ラウンド | 推定 | 開催地 | 会期 | 状態 |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  if (rows.length === 0) rows.push("| - | - | 該当なし | - | - | - | - | - |");
  /* 1,000 行を超える表なので、最後まで読んだ人にも出口を置く（`upcoming.html` と同じ言い回しを
   * 同じ正本から使う）。GitHub の生的な表示では、この名前はコードのスパンになるだけで辿れない。 */
  const tail = [
    "",
    `[${UPCOMING_BACK_TEXT_JA}](index.html) ―― 日本時間への換算・残り日数・絞り込みはそちら。` +
      ` この表は生成時刻の時点の静的な写しで、直近 ${String(safeDays)} 日を並べています。`,
  ];
  return `${[...head, ...rows, ...tail].join("\n")}\n`;
}

const UPCOMING_DAYS_CAP = 400;

function upcomingWindowDays(value: unknown): { requested: number; days: number } {
  const raw = Number(value ?? 180);
  const requested = Number.isFinite(raw) && Number.isInteger(raw) && raw > 0 ? raw : 180;
  return { requested, days: Math.min(requested, UPCOMING_DAYS_CAP) };
}

export function toLlmsTxt(
  config: Record<string, unknown> | null | undefined,
  spans?: LlmsSpans | null,
  data?: Record<string, unknown> | null,
): string {
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
    "国際会議に加えて国内研究会・国内シンポジウム（情報処理学会・電子情報通信学会など）も収録する",
    "（`tags` に `domestic-jp` を付けた会議で、`data.json` からも絞り込める）。",
    "国内の締切は JST 宣言が多く、サイトは日本時間（JST）と曜日を最初に表示して",
    "2 行目に公式表記を添える。国際会議は AoE（UTC-12）や UTC 宣言のまま併記し、",
    "時刻を公式で確認できていない日付は「時刻未確認」として幅を持つ値として扱う。",
    "",
    /* 「出力一覧」は名前の通り公開物全体の索引だが、10 件だけを並べて残りを黙っていた
     * （2026-08-09 生成のビルドで実測: ビルドが置くファイルは 16 件、この表は 10 件で、
     * `recommendation-core.js`・`publish.js`・`index.html`・`icon.svg`・`.nojekyll`・
     * `llms.txt` 自身にはどこにもふれていなかった）。名前はビルドが管理する出力一覧
     * `MANAGED_OUTPUT_FILES` から書き出す（書き写すと、公開物を増やしたときに索引だけ古くなる）。 */
    /* 配信の絕対 URL（`site.base_url` が正本 – 404 の頁や `upcoming.html` と同じ）。
     * 索引を読む機械が「カレンダーを購読したい」に答えられる様に、**購読先の URL** を書く。
     * ファイル名だけでは 1 度ダウンロードするやり方になり、每日入れ替はる物が古い儘になる
     * （実測 2026-10-12: 索引に `github.io` が 1 箇所も無く、答へるのに README を読む必要が
     * 在った）。 */
    ...(() => {
      const base = String(
        (safeConfig.site as Record<string, unknown> | null)?.base_url ?? "",
      ).replace(/\/+$/, "");
      if (!base) return [];
      // 空行は導入文との境に一つ（配列の前にある物）で足りる。
      return [
        `配信している絶対 URL（\`site.base_url\` が正本）: ${base}`,
        `- 画面: ${base}/`,
        `- カレンダーの購読先に指定する URL: ${base}/deadlines.ics`,
        "  （毎日朝の更新のあと、新しい一覧に置き換わります。ファイルを一度ダウンロードするだけでは",
        "  古くなります。画面の絞り込みは効きません。分野は各予定の `CATEGORIES` にも入ります）",
      ];
    })(),
    "",
    "## 出力一覧",
    "",
    ...MANAGED_OUTPUT_FILES.map((name) => {
      const note = LLMS_OUTPUT_NOTES_JA[name] ?? "";
      if (name === "upcoming.md") {
        return (
          `- ${name}：直近 ${String(
            upcomingWindowDays((safeConfig.site as Record<string, unknown> | null)?.upcoming_days)
              .days,
          )} 日の締切と開催の表。MCP の \`list_upcoming\` でも会期を取得できます。` +
          "MCP の対象期間は `days` で指定します。購読カレンダー `deadlines.ics` は締切のみです。"
        );
      }

      // 句点の後に空白を挟むと、機械が 2 つの項目と取り違える。読み終えた文の後ろに
      // 実測の範囲をそのまま続ける。
      const spanOf = llmsScopeJa(name, spans ?? null);
      return `- ${name}：${spanOf ? `${note}${spanOf}` : note}`;
    }),
  ];
  lines.push(
    "",

    "## AI から引く（MCP）",
    "",
    "`node src/mcp.ts` で起動する読み取り専用の stdio サーバです。収録 snapshot と、存在すれば初期カタログ・推薦インデックスを読みます。外部への送信や書き込みは行いません。",
    "",
    "| ツール | 内容 |",
    "|---|---|",
    "| `search_deadlines` | 日本語検索。語を省いて kind / kinds / within_days などの条件だけでも絞れます。既定は今後の投稿締切で、推定は除きます。 |",
    "| `list_upcoming` | 今日から指定日数以内の締切と開催。既定は全種別で、推定も含みます。 |",
    "| `venue_info` | 会議の開催回・締切・ランク・会期。今後の物から並べ、過去の締切も表示します。 |",
    "| `explain_word` | 絞り込み前の照合件数と検索語への案内。代表行を最大3行表示します。 |",
    "| `collection_stats` | 収録数、生成時刻、確認状態、データ源、配布ファイルの要約。 |",
    "| `recommend_venues` | 語彙と再学習の重みで投稿先を評価。意味検索は使わず、長い論文は最初の20行で調べます。 |",
    "",
    '全種別は `kinds: ["all"]` で指定できます。`search_deadlines` の引数は `query`・`limit`・`offset`・`include_past`・`include_estimated`・`kind`・`kinds`・`rank`・`domestic`・`online`・`within_days`・`scope` です。',
    "他のツールでは `days`・`key`・`name`・`word`・`paper` を使います。各ツールの inputSchema で受け付ける項目と既定値を確認してください。",
    "収録 snapshot と公開物はビルド時の統合・選択で件数が異なる場合があります。収録全体と初期一覧を同じ範囲として比較しないでください。",
    "`scope: screen` は初期一覧、`scope: all` は収録全体です。初期カタログがない場合は全体へ切り替え、その旨を返します。画面と件数を比べる場合は、期間・種別・推定・過去表示を揃えてください。",
    "`search_deadlines` の structuredContent は total・rows・next_offset を持ちます。続きは同じ条件で next_offset を offset に渡します。日付のみの行の utc・jst は null です。推定期間、確認状態、投稿トラックは別の項目です。行に `domestic`（国内の学会か。開催地が日本とは別で、日本で開かれる国際会議は false）と `full_name`（正式名。画面の一覧が会議名の下に出すのと同じ）を持たせてあります。行のテキストでは `domestic` を「国内」の札で出します。公式確認（確認した日時・確認元・確認範囲・状態・次回確認予定）は `verification_ja` に、画面の行の詳細が並べるのと同じ日本語で入ります。",
    "0件では画面と同じ案内を使い、次の一手まで返す設計です。入力や結果の切り詰めは黙らない方針で、採択率・参加費・投稿要件など未収録の情報を推測して答えません。",
    "",
    "## サイト（index.html）の日本語での引き方",
    "",
    "会議名・分野・主題・開催地を検索できます。複数語は空白で区切ります。日時は日本時間（JST）で、時刻未確認の締切は公式の暦日のままです。",
    "相対日付は実行時の日本時間で解釈し、判定した期間を表示します。`今月`・`来月`・`再来月`・`先月` はその時点の暦月で解決します。日付語は別ラウンドや会期にも当たるため、締切の期間だけを絞るには「締切まで」を使います。曖昧な期間や未収録の情報は推測しません。",
    "「投稿先を探す」の候補CSVは、順位・一致評価・一致の点・言葉の一致・意味の近さを含みます。一致評価は証拠の強さを表す区分で、点とは別です。",
    "CSV・画面のICS出力は絞り込み後の全行です。購読用 deadlines.ics は収録全体の今後の締切で、絞り込みを引き継ぎません。共有URLには一覧条件を含めますが、論文の本文は含めません。",
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
    "- identity_migrations: object：旧 slot から現在の slot への明示的な移行契約。",
    "- conferences: array：会議の配列。各要素は次の形である。",
    "  - key: string：正規化キー（slug）。例 'sigcomm'。",
    "  - upstream_sub: string|null：上流（ccfddl）が付けた分野の略号（例 'CG'）。この計画の分野（categories）とは別の欄で、空のこともある。",
    "  - title: string：略称。例 'SIGCOMM'。",
    "  - full_name: string：正式名称。",
    "  - acronym: string：検索用の会議略称。存在時のみ。",
    "  - scope / official_scope: array of string：検索用の対象分野。存在時のみ。",
    "  - paper_abstracts / keywords: array of string：検索用の代表概要・キーワード。存在時のみ。",
    "  - categories: array of string：上記 categories のキー。",
    "  - rank: object：{'ccf': 'A', 'core': 'A*', 'thcpl': 'B'} の形。欠けうる（'thcpl' を持つ会議は実測 2026-10-16 で 696 のうち 344）。",
    "    値 'N' は上流でランクが付いていないことを表す番兵であり、等級ではない。",
    "  - link: string：会議の公式サイト。",
    "  - tags: array of string：補助タグ。カテゴリではない。",
    "  - sources: array of string：この会議の出典名。",
    "  - dblp: string|null：DBLP の会議キー。ない場合は null。",
    "  - identity: object：明示的な同一性。{venueId, dblpKey, officialDomains, aliases, sourceIds}。存在時のみ。`sourceIds` は出典名（'ccfddl'・'aideadlines'・'local'）からその出典での ID への写像。",
    "  - legacy_keys: array of string：正規 key へ移行した旧 key。存在時のみ。",
    "  - category_assignments: array：カテゴリと付与理由。存在時のみ。",
    "  - papers: array of string：代表採択論文タイトル。語彙一致・推薦に使う。",
    "    ない会議は空配列。",
    "  - editions: array：開催回。各要素は次の形である。",
    "    - year: integer, id: string（例 'sigcomm26'）, link: string, place: string",
    "    - date_text: string：上流の自由文の会期表記。構造化されていないことがある。",
    "    - event_start / event_end: string|null：'YYYY-MM-DD'。パース不能なら null。",
    // 件数は出力するデータから集計し、収録内容の変更を説明にも反映する。
    (() => {
      const 版 = jsonRecords(data?.conferences).flatMap((conf) =>
        jsonRecords(conf.editions).map((edition) => ({
          確かさ: String(edition.event_date_precision ?? ""),
          始まる日: edition.event_start,
        })),
      );
      // 他の件数表示と同じく、3桁ごとに区切る。
      const 千の桁 = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      const 數 = (確かさ: string): number => 版.filter((e) => e.確かさ === 確かさ).length;
      // 確定した日付範囲・単日の開催回を除き、日付が記録されている件数も示す。
      const 其の外 = 版.filter((e) => e.確かさ !== "exact-range" && e.確かさ !== "single-day");
      const 其の外で日が入る = 其の外.filter((e) => String(e.始まる日 ?? "").trim()).length;
      return (
        "    - event_date_precision: string：会期の日付の確かさ。" +
        `'exact-range'（開始と終了が確定・${千の桁(數("exact-range"))} 版）` +
        `・'single-day'（1 日・${千の桁(數("single-day"))} 版）` +
        `・'month-only'（月までしか分からない・${千の桁(數("month-only"))} 版）` +
        `・'split-dates'（飛び石・${千の桁(數("split-dates"))} 版）` +
        `・'unverified'（未確認・${千の桁(數("unverified"))} 版）` +
        `・'not-announced'（未発表・${千の桁(數("not-announced"))} 版）。` +
        `'exact-range' と 'single-day' 以外の ${千の桁(其の外.length)} 版のうち、` +
        `${千の桁(其の外で日が入る)} 版には event_start が記録されている。件数は出力データから集計する。`
      );
    })(),
    "    - call_identity: object：{seriesId, editionId, callId, parentEventId}。呼びかけ（call）の同一性。",
    "    - legacy_ids: string[]：以前の版の識別子（改名・統合の前に使っていた物）。",
    /* `event_segments` は README が「機械処理ではこれを参照する」と名指している欄なのに、
     * この要約の版の箇条書きに無かった（2026-10-16 実測: 版 2,606 のうち 3 版が持つ。
     * CSV の列の節には前から書いてあった）。`event_start`/`event_end` だけを見ると、
     * 離れた開催日や週次セミナーを連続開催と読み違える。 */
    "    - event_segments: array：離れた開催日・週次セミナーの各回を {start, end, label} で並べた物（実測 2026-10-16: 版 2,606 のうち 3 版）。連続開催では付かない – `event_start`/`event_end` だけでは連続開催を意味しないので、各回が要る時はこちらを見る。",
    "    - event_review: object：会期の見直しの記録（上流の原文の日付文言 source_date_text・確かめた日 reviewed_on・覚え書き note など。正本は src/model.ts の EventReview）。",
    "    - estimated: boolean：true は過去実績からの推定。実データではない。",
    "    - estimate: object|null：推定版の作り方。{method, point_estimate, window_start, window_end, source_editions, confidence}。確定版にはない（実測 2026-10-16: 48 版）。`method` は 'median-interval'（直近の版の間隔の中央値）のみ、`confidence` は 'low'|'medium'（実測: medium 39・low 9）。`source_editions` は根拠にした版の年。",
    "      window_start / window_end は表示用の日付範囲であり、公式締切ではない。",
    "    - source: string：この開催回を提供した出典名。",
    "    - identity: object：明示的な同一性。{editionId, officialUrls, sourceIds}。存在時のみ（sourceIds を持つ版は実測 2026-10-16 で 2,606 のうち 2,554。`sourceIds` は会議と同じく出典名から ID への写像）。",
    "    - deadlines: array：各要素は次の形である。",
    "      - kind: string：'abstract'|'paper'|'supplementary'|'notification'" +
      "|'camera_ready'|'rebuttal_start'|'rebuttal_end'|'review_release'" +
      "|'registration'|'other' の 10 種のみ。",
    "      - label: string：上流の表示用ラベル。",
    "      - precision: 'exact'|'date-only'：締切値の精度。",
    "      - exact は utc: 'YYYY-MM-DDTHH:MM:SSZ'、aoe、tz_raw を持つ。",
    "      - date-only は local_date: 'YYYY-MM-DD' と earliest_utc/latest_utc を持ち、utc/aoe/tz_raw は null。",
    "      - round: integer：1 起点。複数投稿ラウンドを持つ会議がある。",
    "      - track: string：投稿のトラック（例 'research track'）。空の行が多い。",
    "      - ics_uid: string：この締切が配付のカレンダー（`deadlines.ics`）で使う UID。載る締切だけが持つ（実測 2026-10-16: 品書の締切 871 のうち 792）。画面の書き出しもこれをそのまま使うので、同じ締切が購読と書き出しで同じ予定になる。無い締切は購読の対象外（過去・先すぎる物など）で、画面が自分で組む。",
    "      - verification: object：公式 URL を確かめた記録。{official_url, last_attempt_at, last_verified_at, next_check_at, content_hash, status, source_class, source_name, provider_identity, label_signature, selector_or_field, adapter, promotion_ref}。**画面の札と「確認元」はここから出る** – `status` は 'verified'(35)|'manual-required'(4,435)|'parser-failed'(2)|'pending'(2)、`source_class` は 'official-cfp'(39)|'publisher'(3)|'aggregator'(4,097)|'unknown'(335)（実測 2026-10-16。'unknown' は確かめた元が分からない行で、値を推測しない）。**数は語の側に付ける** – 並びだけを書くと、語を並べ替えた日に数が別の語に付く。`provider_identity` は {provider, providerKey, strength} で、`provider` は 'easychair'|'openreview'|'hotcrp'|'github-pages'|'acm'|'ieee'|'dedicated-domain'|'unknown'、`strength` は 'explicit'|'provider-scoped'|'dedicated-domain'|'weak'。実測 2026-10-16: 締切 4,990 のうち 4,474 が持つ。",
    "      - superseded_deadlines: array：上書きされた古い締切の記録。{value, precision, source, supersededBy, reason, status, supersededAt, evidenceRef}。`reason` は 'manual-resolution'(36)|'official-extension'(2)、`status` は 'superseded'（実測 2026-10-16。締切 4,990 のうち 38 行）。",
    "      - promotion_ref: object：{batch, resolution}。公開した締切から、それを載せた判断（昇格）への参照。",
    `    - 項目ごとに記録の有無が異なります（ビルド時の実測: ${data ? 稀有な欄の實測(data) : "データがないため集計できません"}）。`,
    "      - comment: string|null：上流の注記。",
    "      - status: 'confirmed'|'estimated'：開催回の確定/推定状態。",
    "      - selection_rule: string：採用値を選んだ決定規則。",
    "      - evidence: array：その値をどこで見たかの記録。**二つの書き方が混ざる** – 旧来の snake_case（source_name・source_url・observed_at・original_value・confidence）と、欄ごとの来歴の camelCase（sourceClass・sourceUrl・sourceRevision・retrievedAt・verifiedAt・contentHash・evidenceRef・rawExcerpt・verifiedFields・adapter・structured・selectorOrField）。実測 2026-10-16: `confidence` は 'official'(21)|'aggregator'(5,023)|'estimated'(74)、`sourceClass` が確かめた元の種類（'official-cfp'(41)|'publisher'(3)|'curated-manual'(787)|'aggregator'(4,213)|'assumption'(74)）、`verifiedFields` が確かめた欄（'date'(46)|'time'(10)|'timezone'(10)|'kind'(40)|'round'(27)|'track'(6)）、`contentHash` と `verifiedAt` が揃って初めてその行を「公式で確認した」と数える。実測 2026-10-16: 締切 4,990 の全行が持ち、件数は 5,118（sourceClass 5,118・verifiedFields 46・contentHash 43・verifiedAt 45）。",
    "      - conflicts: array：採用しなかった候補値。{source, label, at_utc, local_date, precision, original_value, evidence}（存在時のみ。実測 2026-10-16: 51 行。`precision` は 'exact'|'date-only'、`local_date` は date-only の時だけ）。",
    "",
    /* `data.csv` は README でも入口に挙がる成果物なのに、列の辞書がどの公開文書にも無かった
     * （2026-08-09 生成のビルドで実測: 25 本の列名のうち 7 本 ― `rank_ccf`・`rank_core`・
     * `edition_id`・`deadline_utc`・`deadline_aoe`・`estimate_window_start`・
     * `estimate_window_end` ― は `llms.txt` のどこにも出てこなかった）。Excel で開いた人は
     * 空欄と 'N' の違いを確かめようが無い。列名はビルドの列定義から書き出す（書き写すと、
     * 列を足したときに辞書だけが残る）。 */
    "## data.csv の列",
    "",
    "1 行 1 締切の平坦な表で、`data.json` の `conferences[].editions[].deadlines[]` を展開した物である。",
    "列の名は、多くが `data.json` の鍵と同じ名である（`deadline_*` は `deadlines[]`、`event_*` は `editions[]`、`rank_*` は `conferences[].rank`、`estimate_window_*` は `editions[].estimate`、`verification_*` は `deadlines[].verification` の下）。この規則にない列は、その列の説明を見る（`kind_ja`・`date_field`・`extended` など – 実測 2026-10-08: 31 列のうち 26 列がこの規則で辿れる）。",
    "推定版と過去の締切もそのまま含まれる。画面や `upcoming.md` と違い、**値は機械可読のまま**にしてある。",
    "**このサイトが付ける印としての日本語は書かない**（「未確認」「該当なし」など。空欄は「その値が分かっていない」を意味する – 実測 2026-10-06: その種の印が値として出ている列は一つもない）。ただし**上流の原文に日本語が在ればその侭出す** – 国内の催し物では `title` `full_name` `label` `place` `date_text` `date_field` `event_segments` の七列に日本語が入る（「値は機械可読のまま」と言うのは**このサイトが語を足さない**と言う意味である）。",
    "**上流が英語の印を書いている事がある**（実測 2026-10-06: `date_text` 65 行・`place` 10 行が `TBD`）。これはこちらが付けた印では無く**上流の原文**なので、その侭出す（空欄と `TBD` は意味が違う – 空欄はその値が分からない、`TBD` は上流が「未定」と書いている）。",
    "ただ 1 つの例外が `kind_ja` で、種別だけは英語のキー（`paper` など）だけでは",
    "絞り込み・並べ替えに困る人がいるため、画面と同じ日本語を併記している（語の正本も画面と同じ表）。",
    `列はこの順で ${String(CSV_COLUMNS.length)} 本。`,
    "",
    ...CSV_COLUMNS.map((name) => `- ${name}：${CSV_COLUMN_NOTES_JA[name] ?? ""}`),
    "",
    "## 利用上の注意",
    "",
    "- exact の比較は deadlines[].utc、date-only の比較は earliest_utc/latest_utc の不確実性区間で行う。aoe は表示用である。",
    "- date-only の UTC 境界は状態判定用であり、公式時刻や時刻単位の残り時間として扱わない。",
    "- estimated=true の版は推定窓であり、公式サイトで締切を確認してから利用する。",
    "- data.csv は 1 行 1 締切のフラット表で、deadline_precision と deadline_local_date を持つ。",
    "  comment・tags・thcpl ランクは列にない。全情報が要るときは data.json を使う。",
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
export function jsonCompact(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : jsonCompact(v))).join(", ")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
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
    venuePapers?: Record<string, string[]>;
    reranker?: Record<string, unknown> | null;
    localEmbeddingsOnly?: boolean;
    health?: HealthReportOptions;
    publishProvenance?: PublishProvenance;
  } = {},
): Promise<BuildStats> {
  mkdirSync(outdir, { recursive: true });
  clearManagedOutput(outdir, opts.noEmbeddings === true);

  const safeConfs = Array.isArray(confs) ? confs : [];
  const safeConfig = config ?? {};

  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const nowUtc = new Date(safeNow.getTime());
  // DTSTAMP is derived from --now (floored to the day).
  const site = (safeConfig.site as Record<string, unknown>) ?? {};
  const { requested: upcomingDays, days: upcomingDays使ふ } = upcomingWindowDays(
    site.upcoming_days,
  );
  if (upcomingDays使ふ < upcomingDays) {
    process.stderr.write(
      `warning: site.upcoming_days=${upcomingDays} は上限 ${UPCOMING_DAYS_CAP} を超えたので ${UPCOMING_DAYS_CAP} 日として扱います` +
        "（収録の果てより先は行がないので、大きな日数は飾りに成ります）\n",
    );
  }

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

  const data = toJson(safeConfs, safeConfig, nowUtc, opts.venuePapers);
  /* カレンダーの行は 1 回だけ作る – 件数と期間の申告（`catalog.json` 経由で画面に出す）は、
   * 同じ行から導かないと本文とズレる。 */
  const { rows: icsRows, uids: icsUids } = icsRowsWithUids(records, nowUtc);
  const icsMeta = icsCalendarMeta(icsRows);
  // 品書は 1 回だけ組む（`catalog.json` と、画面に差し込む物と、索引の申告が
  // それぞれ違う品書を指さないため。第 289 回と同じ轍を踏まない）。
  /* 締切ごとのカレンダーの UID も品書へ渡す（畫面の書き出しが購読と同じ予定になるように）。 */
  const catalog = toCatalog(data, nowUtc, upcomingDays使ふ, icsMeta, opts.reranker, icsUids);
  // A new page build does not imply that upstream deadlines were checked again.
  catalog.source_updates = Object.values(opts.health?.sourceMetadata ?? {})
    .filter((source) => source.source !== "local")
    .map((source) => ({
      name: source.source,
      status: source.status,
      fetched_at: source.fetchedAt,
    }));
  const jsonText = JSON.stringify(data, null, 2);
  write("data.json", `${jsonText}\n`);

  catalog.history_bytes = Buffer.byteLength(`${jsonText}\n`, "utf8");
  write("catalog.json", `${JSON.stringify(catalog, null, 2)}\n`);
  const publishProvenance =
    opts.publishProvenance ?? collectPublishProvenance(ROOT, undefined, { now: nowUtc });
  const contentId = publishContentId(
    publishProvenance,
    embeddingProfileHash(data, opts.venuePapers),
  );
  const buildId = publishBuildId(nowUtc, contentId);
  write(
    "recommendation-index.json",
    `${JSON.stringify(
      {
        ...toRecommendationIndex(
          data,
          nowUtc,
          opts.health?.recommendationSourceStatus ?? opts.health?.sourceStatus,
          opts.venuePapers,
          opts.reranker,
        ),
        content_id: contentId,
        build_id: buildId,
      },
      null,
      2,
    )}\n`,
  );
  /* `data.json` の状態を CSV にも載せる（表は `data.json` を書いた後の `data` から作る）。 */
  write("data.csv", toCsv(records, verificationBySlot(data)));
  /* 「直近の締切と会期」の表はここが 1 本。ブラウザで読める版（下の `upcoming.html`）は
   * この文字列から作る（同じ表を二重に作らないため）。 */
  const upcomingMd = toUpcomingMd(records, nowUtc, upcomingDays使ふ);
  write("upcoming.md", upcomingMd);
  write("deadlines.ics", icsCalendarText(icsRows, nowUtc));

  // セマンティックレコメンド用の埋め込み（transformers.js が無ければスキップして語彙のみで動作）
  if (!opts.noEmbeddings) {
    try {
      const embPath = join(outdir, "embeddings.json");
      let needEmb = true;
      try {
        const existing = JSON.parse(readFileSync(embPath, "utf8")) as {
          embeddings?: Record<string, unknown>;
        };
        needEmb = embeddingsStale(existing, data, opts.venuePapers);
      } catch {
        needEmb = true;
      }
      if (needEmb) {
        const { buildEmbeddings } = await import("./embeddings.ts");
        await buildEmbeddings(
          join(outdir, "data.json"),
          embPath,
          opts.localEmbeddingsOnly === true,
          opts.venuePapers,
        );
      }
      written.push("embeddings.json");
    } catch (exc) {
      rmSync(join(outdir, "embeddings.json"), { force: true });
      console.warn(
        `warning: embeddings を生成しなかった（${(exc as Error).constructor.name}: ${String(exc)}）`,
      );
    }
  }

  write(
    "llms.txt",
    toLlmsTxt(
      safeConfig,
      {
        all: deadlineSpan(data),
        catalog: deadlineSpan(catalog),
        horizonDays: upcomingDays使ふ,
        calendar: icsMeta,
      },
      data as Record<string, unknown>,
    ),
  );
  write("icon.svg", SITE_ICON_SVG);
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
      throw new Error(`required site template marker missing: ${templatePath}`);
    }
    if (!templateText.includes(JSONLD_MARKER)) {
      throw new Error(`required site template marker missing: ${JSONLD_MARKER}`);
    }
    // 画面と同じ見た目にするため、`index.html` と同じ様子の塊を取り出して使う
    // （データを書き込む前の本文から読む – JSON をまたぐ正規表現にしない）。
    const siteStyleBlock = /<style>[\s\S]*?<\/style>/.exec(templateText)?.[0] ?? "";
    // サイトの所在地は 1 か所で決める（`upcoming.html` の canonical と `404.html` の口が同じ値を向く）。
    const siteBaseUrl = String(
      site.base_url ?? `https://${String(site.domain ?? "kamiyobi")}`,
    ).replace(/\/+$/, "");
    templateText = templateText.replace(TEMPLATE_MARKER, embedJson(jsonCompact(catalog)));
    /* 機械可読の自己紹介。題と説明は雛形の `<title>`・`<meta name="description">` から取る
     * （同じ文を二か所に書くと、片方だけ直した日に食い違う）。 */
    templateText = templateText.replace(
      JSONLD_MARKER,
      toDatasetJsonLd({
        baseUrl: siteBaseUrl,
        title: /<title>([\s\S]*?)<\/title>/.exec(templateText)?.[1]?.trim() ?? "kamiyobi",
        description:
          /<meta name="description" content="([^"]*)"/.exec(templateText)?.[1]?.trim() ?? "",
        generatedAt: String(data.generated_at ?? ""),
        span: deadlineSpan(data),
        /* 帰属とライセンスの行き先は `site.repo`（`ten82e/kamiyobi` の形）。 */
        repoUrl: /^https?:\/\//.test(String(site.repo ?? ""))
          ? String(site.repo)
          : site.repo
            ? `https://github.com/${String(site.repo)}`
            : siteBaseUrl,
        keywords: ["締切", "国際会議", "国内研究会", "ワークショップ", "ジャーナル特集号", "学会"],
      }),
    );
    write("index.html", templateText);
    for (const [name, source] of Object.entries(compileSiteRuntime())) write(name, source);
    // `upcoming.md` は Markdown のまま渡すとブラウザが表に整形してくれないので、
    // 同じ内容の読みやすい版を隣に置く。画面からの導線はこっちに向ける。
    write("upcoming.html", toUpcomingHtml(upcomingMd, siteStyleBlock, siteBaseUrl));
    // 無い場所を開いた人に日本語で口を渡す。画面の見た目のままにする。
    write("404.html", toNotFoundHtml(siteStyleBlock, siteBaseUrl));
    /* 機械が最初に読む 1 枚と、人が開く口の一覧。索引（`llms.txt`）への道を
     * ここにも書く – クローラは頁より先に robots.txt を読む。 */
    write("robots.txt", toRobotsTxt(siteBaseUrl));
    write("sitemap.xml", toSitemapXml(siteBaseUrl, nowUtc.toISOString().slice(0, 10)));
  } else {
    throw new Error(`required site template missing: ${templatePath}`);
  }

  const report = healthReport(data, nowUtc, {
    ...opts.health,
    profileHash: opts.health?.profileHash ?? embeddingProfileHash(data, opts.venuePapers),
    parseWarnings: opts.health?.parseWarnings ?? warningCounts(),
    warningCodes:
      opts.health?.warningCodes ??
      Object.fromEntries(
        warningSummaries().map(({ code, count, messages }) => [code, { count, messages }]),
      ),
    outputFiles: outputFileManifest(outdir, written),
  });
  write("health.json", `${JSON.stringify(report, null, 2)}\n`);
  // この表に載せられなかった物（後から書き出す物）を、md の側に名前で宣言させる。
  const omittedOutputs = [...new Set([...written, "health.md", "publish.json"])].filter(
    (name) => !Object.hasOwn(report.output_files, name),
  );
  write("health.md", healthMarkdown(report, omittedOutputs));
  writePublishManifest(
    outdir,
    written,
    nowUtc,
    written.includes("embeddings.json") ? "ready" : "lexical-only",
    publishProvenance,
    opts.venuePapers,
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
