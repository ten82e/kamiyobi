/**
 * ビルド成果物を読む検査たちで共有する部品（SPEC §8）。
 *
 * ビルド後の画面・検索の検査は 1 ファイルに置ける量に上限がある（1 MiB を越えると biome が
 * 黙ってそのファイルを追わなくなる – tests/lint_budget.test.ts）。検査本体を複数のファイルに
 * 分けたので、そこで共有する読み込みの部品をここに移した（書き写すと正本とズレる – 同じ約束）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, expect } from "vitest";
import { runCli, tempWork } from "./helpers.ts";
import { jsFunction, siteRuntime, vmSafeSource } from "./runtime_extract.ts";

export let site: string;

export let data: Record<string, any>;

/* 検証状態の語彙を built の recommender から取り出して注入する行。画面の関数は
 * recommender の正本から作った module 直下の定数を見るので、ビルド成果物から抜き出した
 * 関数を動かす検査も同じ語彙で支える（語を書き写さない – 上の等級順と同じやり方）。 */
export function verificationLabelsSource(): string {
  const rec = siteRuntime("recommender.js");
  const table = rec.match(/const VERIFICATION_STATUS_LABELS_JA = \{[\s\S]*?\};/u)?.[0];
  expect(table, "recommender の検証状態の語彙表が見つからない").toBeTruthy();
  return `const VERIFICATION_STATUS_LABELS = ${String(table).replace(
    "const VERIFICATION_STATUS_LABELS_JA = ",
    "",
  )}`;
}

/* 等級順の列表をビルド成果から取り出す（テスト側に書き写さない）。
 * app.js の `RANK_GRADE_OPTIONS` は recommender の正本から作るので、
 * ハーネスへ入れるときは recommender 側の定義をそのまま使う。 */
export function rankGradeOptionsSource(): string {
  const rec = siteRuntime("recommender.js");
  const order = rec.match(/const RANK_GRADE_ORDER_JA = \[[^\]]*\];/)?.[0];
  expect(order, "recommender の等級順（RANK_GRADE_ORDER_JA）が見つからない").toBeTruthy();
  return `${String(order).replace("const RANK_GRADE_ORDER_JA", "const RANK_GRADE_OPTIONS")};`;
}

export function siteHtmlRuntime(): string {
  return `${readFileSync(join(site, "index.html"), "utf8")}\n${siteRuntime()}`;
}

beforeAll(() => {
  const outdir = join(tempWork("cfp-site-"), "public");
  // 埋め込み生成は 2 モデル（英語+多言語）で数秒かかるため、このテスト群ではスキップ
  const run = runCli(outdir, { extra: ["--no-embeddings"] });
  expect(
    run.status,
    `cli build failed\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`,
  ).toBe(0);
  site = outdir;
  data = JSON.parse(readFileSync(join(site, "data.json"), "utf8"));
}, 300_000);

export function conf(key: string): any {
  const matches = data.conferences.filter((c: any) => c.key === key);
  expect(matches.length).toBeGreaterThan(0);
  return matches[0];
}

// --- upcoming.md carries meetings too (SPEC.md 4) --------------------------

export function upcomingRows(dir: string): string[][] {
  const text = readFileSync(join(dir, "upcoming.md"), "utf8");
  const rows: string[][] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|") || new Set(line).isSubsetOf(new Set("|- "))) continue;
    rows.push(
      line
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim()),
    );
  }
  return rows.slice(1);
}

// --- the site's meeting rows run to the end of the meeting (SPEC.md 7) -----

/* `onKeydown` を抜き出して叩く検査は、第 135 回で増えたキーの振り分け関数も一緒に渡す
 * （抜き出した関数は独立していないと `ReferenceError` になる – 同じ穴に二度落ちないため、
 * 生の抜き出しではなくこの helper を使う）。 */
export function keydownWithBlockers(src: string): string {
  // 第 152 回: `j` は選択が行の描画範囲を越えないか確認するので、抜き出した関数に
  // その関数も必要（独立していないと `ReferenceError` – 同じ helper の趣旨と同じ）。
  // 第 273 回: 行の選び方を `dataRows` にまとめたので、それも入れる。実行時に新しい関数を
  // 足すたびにここへ来るのが正で、検査側ごとに別の抜き出しを作ると同じ穴に三度目落ちする
  // （`ReferenceError: dataRows is not defined` を実際に踏んだ）。
  return `const ensureRowsDrawn = () => {};\n${jsFunction(src, "dataRows")}\n${jsFunction(src, "keyBlockedByTarget")}\n${jsFunction(src, "onKeydown")}`;
}

export const SEARCH_CANON = (() => {
  // 検索照合の規則は recommender.js の正本をそのまま注入する（書き写すと正本とズレるため、
  // スタブでの再現は避ける）。
  /* 検索照合の規則は recommender.js の正本をそのまま注入する（書き写すと正本とズレるため、
   * スタブでの再現は避ける）。國名・都市名の表は別の產出物に移したので、その讀點も繋ぐ
   * （第 583 回 – 1 MiB の上限を守る為の分け）。 */
  const rec = `${siteRuntime("recommender.js")}\n${siteRuntime("place-aliases.js")}\n${siteRuntime(
    "topic-aliases.js",
  )}`;
  const consts = [
    ["SMALL_KANA_JA", /const SMALL_KANA_JA[\s\S]*?\};/],
    // `searchNormalize` がアクセントを折るための表（正本から注入し、写しは作らない）。
    // 他の定数の定義中に `searchNormalize` が呼ばれるので、必ず先に置く。
    ["DIACRITIC_FOLD_JA", /const DIACRITIC_FOLD_JA[\s\S]*?\};/],
    ["DIACRITIC_FOLD_CHARS", /const DIACRITIC_FOLD_CHARS = [^\n]*;/],
    ["LATIN_DIACRITIC_CHARS", /const LATIN_DIACRITIC_CHARS = [^\n]*;/],
    ["COMBINING_MARKS", /const COMBINING_MARKS = [^\n]*;/],
    // 漢字の略字を折る表（第 241 回）。同じく `searchNormalize` が読むので先に置く。
    ["KANJI_VARIANT_FOLD_JA", /const KANJI_VARIANT_FOLD_JA[\s\S]*?\};/],
    ["KANJI_VARIANT_FOLD_CHARS", /const KANJI_VARIANT_FOLD_CHARS = [^\n]*;/],
    /* 長音の打ち違ひを折る字（第 639 回）。同じく `searchNormalize` が読むので、漢字の表の
     * 直後に置く（抜き出した関数と一緒に注入せんと `new Function` の中で未定義になる）。 */
    ["KATAKANA_HYPHEN_CHARS", /const KATAKANA_HYPHEN_CHARS = [^\n]*;/],
    /* 分野チップの語（`システム（Systems, Architecture and Storage）`）を打ち手で寄せる
     * ための定義。`queryTokenGroups` が読むので、抜き出した関数と一緒に注入する
     * （定義順: 表 → 見出し → 正規表現）。 */
    ["CATEGORY_LABELS_JA", /const CATEGORY_LABELS_JA[\s\S]*?\};/],
    ["CATEGORY_CHIP_HEADS_JA", /const CATEGORY_CHIP_HEADS_JA[\s\S]*?\)\);/],
    ["CATEGORY_CHIP_TAIL", /const CATEGORY_CHIP_TAIL = new RegExp\([\s\S]*?\);/],
    ["PLACE_QUERY_ALIASES_JA", /const PLACE_QUERY_ALIASES_JA[\s\S]*?\];/],
    ["TOPIC_QUERY_ALIASES_JA", /const TOPIC_QUERY_ALIASES_JA[\s\S]*?\];/],
    ["TOPIC_ABBREVIATIONS_EN", /const TOPIC_ABBREVIATIONS_EN[\s\S]*?\];/],
    /* 時刻に繋がれたタイムゾーンの語（第 412 回）。`queryTokenGroups` の内側から読むので、
     * 抜き出す関数と一緒に注入しないと `new Function` の中で未定義になる。 */
    ["時刻の後ろのゾーン語Ja", /const 時刻の後ろのゾーン語Ja = new Set\([\s\S]*?\]\);/],
    ["時刻の後ろのゾーン語並びJa", /const 時刻の後ろのゾーン語並びJa =[\s\S]*?\.length\);/],
    ["RELATIVE_MONTH_OFFSETS_JA", /const RELATIVE_MONTH_OFFSETS_JA[\s\S]*?\};/],
    // 月に数字を打った『末』の案内（第 407 回 – `periodMonthPairs` が呼ぶ）。
    ["月の末の案内Ja", /function 月の末の案内Ja\([\s\S]*?\n {4}\}/],
    // 助詞を付きただけの暦日・暦月・年・曜日を寄せる形（第 408 回 – 語の頭が呼ぶ）。
    ["暦日の語に寄せるJa", /function 暦日の語に寄せるJa\([\s\S]*?\n {4}\}/],
    ["暦日と暦月の形Ja", /const 暦日と暦月の形Ja =[\s\S]*?;/],
    ["曜日の形Ja", /const 曜日の形Ja =[\s\S]*?;/],
    ["同じ聞き方の助詞Ja", /const 同じ聞き方の助詞Ja = [^\n]*;/],
    // 「今月末」「年内」の語の表（第 327 回）。`queryTokenGroups` が呼ぶ関数と一緒に注入する。
    ["PERIOD_MONTH_WORDS_JA", /const PERIOD_MONTH_WORDS_JA[\s\S]*?\};/],
    /* 年度・期間の語（第 330 回）。 */
    ["FISCAL_YEAR_OFFSETS_JA", /const FISCAL_YEAR_OFFSETS_JA[\s\S]*?\};/],
    ["FISCAL_YEAR_TAIL_JA", /const FISCAL_YEAR_TAIL_JA = [^\n]*;/],
    ["YEAR_SPAN_TAIL_JA", /const YEAR_SPAN_TAIL_JA = [^\n]*;/],
    ["HALF_YEAR_JA", /const HALF_YEAR_JA = [^\n]*;/],
    ["HALF_YEAR_DAYS_JA", /const HALF_YEAR_DAYS_JA = [^\n]*;/],
    /* 上旬・中旬・下旬（第 332 回）。 */
    ["MONTH_PART_DAYS_JA", /const MONTH_PART_DAYS_JA[\s\S]*?\};/],
    ["MONTH_PART_TAIL_JA", /const MONTH_PART_TAIL_JA = [^\n]*;/],
    /* 時刻の打ち方（第 333 回）。 */
    ["CLOCK_JA", /const CLOCK_JA =\s*\n?\s*\/[^\n]*;/],
    // 助詞・期日の言い回しの表と「今日から N 日」の単位（第 328 回）。
    ["DATE_TOKEN_TAILS_JA", /const DATE_TOKEN_TAILS_JA[\s\S]*?\];/],
    /* 日を並べると書く区切り（第 406 回）。 */
    ["列挙の区切りJa", /const 列挙の区切りJa = [^\n]*;/],
    /* 並べた語の助詞の表（第 457 回 – 空格で離った列挙を寄せる機械が読む）。 */
    ["列挙の助詞Ja", /const 列挙の助詞Ja = [^\n]*;/],
    ["列挙の助詞の尾Ja", /const 列挙の助詞の尾Ja = [^\n]*;/],
    /* 数値で書く相対日の形（第 405 回 – 列挙の目印が読む）。 */
    ["数値の相対日の形Ja", /const 数値の相対日の形Ja = [^\n]*;/],
    ["FROM_TODAY_UNIT", /const FROM_TODAY_UNIT[\s\S]*?\};/],
    ["FROM_TODAY_HEAD", /const FROM_TODAY_HEAD = [^\n]*;/],
    ["RELATIVE_MONTH_WITHIN", /const RELATIVE_MONTH_WITHIN = [^\n]*;/],
    ["PRESSED_WEEKDAY_JA", /const PRESSED_WEEKDAY_JA[\s\S]*?;\n/],
    ["WEEKDAY_ORDER_JA", /const WEEKDAY_ORDER_JA = [^\n]*;/],
    // `dateTokenStemJa` が読む表（週の語・年の語・季節の語）は既に上の注入にあるので、
    // 同じ定数を二度並べない（`Identifier ... has already been declared` – 第 328 回で実発生）。
    ["PLACE_READINGS", /const PLACE_READINGS[\s\S]*?\];/],
    ["REGION_READINGS", /const REGION_READINGS[\s\S]*?\];/],
    // 地域まとめ（`ヨーロッパ` → 国名）は shared の国名リスト変数に依存するので、
    // 定義順（TDZ）を崩さないようにリストを先に、表を後に inject する。
    ["EUROPE_JA", /const EUROPE_JA =[\s\S]*?;/],
    ["ASIA_JA", /const ASIA_JA =[\s\S]*?;/],
    ["US_STATES_JA", /const US_STATES_JA =[\s\S]*?;/],
    ["US_JA", /const US_JA =[\s\S]*?;/],
    ["NORTH_AMERICA_JA", /const NORTH_AMERICA_JA =[\s\S]*?;/],
    ["SOUTH_AMERICA_JA", /const SOUTH_AMERICA_JA =[\s\S]*?;/],
    ["CENTRAL_AMERICA_JA", /const CENTRAL_AMERICA_JA =[\s\S]*?;/],
    ["OCEANIA_JA", /const OCEANIA_JA =[\s\S]*?;/],
    ["MIDDLE_EAST_JA", /const MIDDLE_EAST_JA =[\s\S]*?;/],
    ["AFRICA_JA", /const AFRICA_JA =[\s\S]*?;/],
    // 「海外」は地域まとめの構成員から導く（国を並べ直さない – 第 335 回）ので、先に要る。
    ["OVERSEAS_JA", /const OVERSEAS_JA =[\s\S]*?;/],
    ["CONTINENT_READINGS", /const CONTINENT_READINGS[\s\S]*?\];/],
    ["OVERSEAS_HEADS_JA", /const OVERSEAS_HEADS_JA =[\s\S]*?\];/],
    ["OVERSEAS_COVERAGE_NOTE_TAIL_JA", /const OVERSEAS_COVERAGE_NOTE_TAIL_JA =[\s\S]*?;/],
    // 地方名 → 都道府県 + 開催市（`関東` で `Tokyo, Japan` を引く）の定義。
    ["DAY_RANGE", /const DAY_RANGE = new RegExp\([\s\S]*?\);/],
    // 相対語を二つ並べて打つ幅（第 373 回）が使う定義 – 其の方の語を暦日に解く関数は
    // 其の側の語（明日・来週・来週金曜・3日後）を上の表から読むので、表は既に注入済み。
    ["幅の区切りJa", /const 幅の区切りJa =[\s\S]*?;/],
    ["日の数の後Ja", /const 日の数の後Ja = [^\n]*;/],
    ["日の数の前Ja", /const 日の数の前Ja = [^\n]*;/],
    // 「8月10日頃」の位で打つ形（第 377 回）が読む定義 – 其の日が決まる語の形を見る表。
    ["頃の尾Ja", /const 頃の尾Ja = [^\n]*;/],
    ["和暦の日Ja", /const 和暦の日Ja =[\s\S]*?;/],
    ["週の曜日Ja", /const 週の曜日Ja = [^\n]*;/],
    ["PREFECTURE_CITIES_JA", /const PREFECTURE_CITIES_JA[\s\S]*?\];/],
    ["CITIES_BY_PREFECTURE", /const CITIES_BY_PREFECTURE[\s\S]*?\};/],
    ["QUERY_EDGE_PUNCTUATION", /const QUERY_EDGE_PUNCTUATION = [^\n]*;/],
    ["COMPOUND_MIN_LENGTH_JA", /const COMPOUND_MIN_LENGTH_JA = [^\n]*;/],
    ["ONLINE_TERMS_JA", /const ONLINE_TERMS_JA = [^\n]*;/],
    ["ONLINE_TERMS_EN", /const ONLINE_TERMS_EN = [^\n]*;/],
    ["ONLINE_VENUE_FALSE_POSITIVES", /const ONLINE_VENUE_FALSE_POSITIVES = [^\n]*;/],
    ["QUERY_SYNONYMS_JA", /const QUERY_SYNONYMS_JA[\s\S]*?\];/],
    ["ABBREV_YEAR_TOKEN", /const ABBREV_YEAR_TOKEN = [^\n]*;/],
    // 分野の語を繋げて打った名詞を割る規則（第 372 回）が読む三つの正本の内、画面に分野語として
    // 出す表と検索語の英訳表（寄せ表は上にある）。其の方の語を割った結果を入れる変数も同じで、
    // 定義順（TDZ）を崩さない様に其の表の直後に置く。
    ["TAG_LABELS_JA", /const TAG_LABELS_JA[\s\S]*?\};/],
    ["JP_EN", /const JP_EN[\s\S]*?\};/],
    ["分野語彙Ja", /let 分野語彙Ja[^\n]*;/],
    ["他の規則で受ける語Ja", /let 他の規則で受ける語Ja[^\n]*;/],
    ["種別への寄せ語Ja", /let 種別への寄せ語Ja[^\n]*;/],
    // 数字だけの入力（`12/25` `2026-12`）を暦日へ解決するための定義。
    ["DATE_WITH_YEAR_TOKEN", /const DATE_WITH_YEAR_TOKEN = [^\n]*;/],
    ["DATE_MONTH_DAY_TOKEN", /const DATE_MONTH_DAY_TOKEN = [^\n]*;/],
    ["DATE_YEAR_MONTH_TOKEN", /const DATE_YEAR_MONTH_TOKEN = [^\n]*;/],
    // 英字語の語境界照合（開催地の語は語全体で当てる）が使う定義。
    ["LATIN_TERM_TOKEN", /const LATIN_TERM_TOKEN = [^\n]*;/],
    ["wholeWordLatinTerms", /let wholeWordLatinTerms[^\n]*;/],
    ["RELATIVE_DAY_OFFSETS_JA", /const RELATIVE_DAY_OFFSETS_JA[\s\S]*?\};/],
    ["RELATIVE_WEEK_OFFSETS_JA", /const RELATIVE_WEEK_OFFSETS_JA[\s\S]*?\};/],
    /* 画面の残り欄の語（`あと 51 日`）を 1 語に寄せる表（第 223 回）。`queryTokenGroups` が
     * 読むので、抜き出した関数と一緒に注入する（書き写すと正本とズレる）。 */
    ["RELATIVE_DAY_PHRASES_JA", /const RELATIVE_DAY_PHRASES_JA[\s\S]*?\];/],
    ["RELATIVE_YEAR_OFFSETS_JA", /const RELATIVE_YEAR_OFFSETS_JA[\s\S]*?\};/],
    /* 表の全行にあてはまる語（第 245 回）。照合でのく側と注記の側が同じ列を向くので、
     * 抜き出して注入する（書き写すと正本とズレる）。 */
    ["WHOLE_TABLE_QUERY_JA", /const WHOLE_TABLE_QUERY_JA[\s\S]*?\];/],
    /* 案内に其の方の語を書き返さない語（第 379 回）。注記の側が読むので同じ列を注入する。 */
    ["WHOLE_TABLE_COPY_OMITTED_JA", /const WHOLE_TABLE_COPY_OMITTED_JA = [^\n]*;/],
    /* 和暦の区切りの暦日を其の方の暦日語に寄せる表（第 380 回）。`calendarDateGroups` が
     * 読むので、抜き出した関数と一緒に注入する（書き写すと正本とズレる – 第 379 回）。 */
    ["和暦の暦日", /const 和暦の暦日 = [^\n]*;/],
    /* 幅の数えの漢数字と、尾側に付く数えの幅（第 392 回）。二行に跨る宣言なので
     * 終端のセミコロンまで抜く（書き写すと正本とズレる – 第 379 回と同じ判断）。 */
    ["幅の漢数字", /const 幅の漢数字 =[\s\S]*?;\n/],
    ["数えの幅Ja", /const 数えの幅Ja =[\s\S]*?;\n/],
    ["QUERY_PARTICLE_SPLIT_CHARS", /const QUERY_PARTICLE_SPLIT_CHARS = [^\n]*;/],
    /* 月の範囲（第 252 回）と季節の語（第 254 回）が使う定義。連なった定義をまとめて抜く
     * （このファイルは biome の 1 MiB 上限に近いので 1 エントリにまとめる）。 */
    ["MONTH_RANGE", /const MONTH_RANGE_FROM[\s\S]*?MONTH_RANGE_YEAR_PREFIX = [^\n]*;/],
    ["SEASON", /const SEASON_YEAR_PREFIX[\s\S]*?SEASON_MONTHS_JA[\s\S]*?\};/],
  ].map(([name, re]) => {
    const src = rec.match(re)?.[0];
    expect(src, `${name} 定義が見つからない`).toBeTruthy();
    return vmSafeSource(src as string);
  });
  return [
    ...consts,
    ...[
      "kanaFold",
      "monthTermsJa",
      "expandRelativeMonths",
      /* 相対月・月の範囲・季節の展開（第 251〜254 回）。抜いた関数は独立ではないので
       * `ReferenceError` になる。 */
      "relativeMonthTerm",
      "relativeMonthPairs",
      "monthTokenToYearMonth",
      "monthRangeTermsJa",
      "monthSpanTerms",
      /* 暦日を二つ並べた幅の展開（第 371 回）。抜いた関数は独立ではないので `ReferenceError`
       * になる（上の月の展開と同じ理由 – tests/built_golden.test.ts で実測）。 */
      "暦日に解くJa",
      /* 幅の数えの漢数字（第 392 回）– 上の寄せと `dayRangeTermsJa` が呼ぶ。 */
      "幅の漢数字を寄せるJa",
      /* 数と単位を離って打った数値の相対日を一語に寄せる手順（第 466 回）– 検索の語を割る段
       * （`単位を数字に寄せるJa`）が呼ぶ。抜くと `new Function` のハーネスだけ ReferenceError。*/
      "相対日の寄せ形Ja",
      /* 暦日を打って其れより後と書く形（第 413 回）– `dayRangeTermsJa` が呼ぶ。
       * 第 475 回で相対の語（`明日以降` `来週以降` `下旬以降`）も同じ幅で絞るやうにした為、
       * 其の初日を決める二本も抜く – 抜くと抜き出した品が `ReferenceError`（第 466 回）。*/
      /* 其れより後の語を日の語から離って打つ形の寄せ（第 475 回）が呼ぶ日付の語の目。 */
      "日付らしき語Ja",
      "より後を剥がす語Ja",
      "其の日以降の初日Ja",
      "以降の初日Ja",
      "暦日より後の語Ja",
      "dayRangeTermsJa",
      "dayRangePairs",
      "暦日の語から解くJa",
      "幅の片側を暦日に解くJa",
      // 「8月10日頃」の位で打つ形の案内（第 377 回）が呼ぶ関数。
      "位の付いた日を暦日に解くJa",
      "分野語彙Ja取得",
      "他の規則で受ける語かJa",
      "種別への寄せ語かJa",
      "分野の複合に割るJa",
      "seasonSpanJa",
      "seasonInsideSpan",
      "seasonTermsJa",
      "yearSeasonTermsJa",
      "mergeSeasonTokens",
      /* 並べた語（列挙）の空格寄せ（第 457 回）– `queryTokenGroups` の内側が呼ぶので
       * 同じ表に並べないと抜き出した品が `ReferenceError` になる（第 257 回・第 453 回・
       * 第 455 回・第 456 回と同じ穴）。 */
      "列挙の語を寄せるJa",
      /* 数字と単位（年・月・日）の空格寄せ（第 456 回）– `queryTokenGroups` の内側が
       * 呼ぶので同じ表に並べないと抜き出した品が `ReferenceError` になる
       * （第 257 回・第 341 回・第 392 回・第 453 回・第 455 回と同じ穴）。 */
      /* 月の第何週の語を空格の位置を問はず寄せる目（第 468 回）– 検索側の
       * `単位を数字に寄せるJa` と案内の `relativeDayNotes` が同じ目を呼ぶので、
       * 抜き出した品が `ReferenceError` にならぬやう一緒に注入する（第 466 回の実発生）。*/
      "週の序数を寄せるJa",
      "単位を数字に寄せるJa",
      /* 「Xから Yまで」を空格で離って打った幅の寄せ（第 453 回）– `queryTokenGroups` が
       * 呼ぶので同じ表に並べないと、抜き出した品が `ReferenceError` になる
       * （第 257 回・第 341 回・第 392 回と同じ穴）。 */
      "範囲の語を寄せるJa",
      /* 暦日と境界の語の空格寄せ（第 455 回）– `queryTokenGroups` の内側が呼ぶので、
       * 同じ表に並べないと抜き出した品が `ReferenceError` になる（第 257 回・第 341 回・
       * 第 392 回・第 453 回と同じ穴）。 */
      "暦日を境界に寄せるJa",
      /* 上の寄せが呼ぶ目印と芯割りの目（第 455 回）– 寄せの品だけ抜いて此等が
       * 無いと `ReferenceError` になる（第 257 回と同じ穴）。 */
      "暦日の語かJa",
      "境界の語尾Ja",
      "芯と語尾Ja",
      "searchNormalize",
      // 第 153 回: URL を検索欄に貼れるようにしたので、その部品も一緒に抜く
      // （抜いた関数は独立していないと `ReferenceError` になる）。
      "hostFromUrl",
      "hostLabels",
      "linkSearchTerms",
      "urlLikeQueryTerms",
      "queryTokens",
      // 助詞の分割と全行の語をのく処理は `queryTokens` / `searchMatcher` が呼ぶ（第 245 回）。
      // 第 394 回: 助詞 `へ` を含む幅を割らない決まりと、`と` の列挙を和集合に解く枝は
      // `splitQueryToken` / `queryTokenGroups` から呼ぶので、同じ表に並べないと抜き出した
      // 品が `ReferenceError` になる（第 257 回・第 341 回・第 392 回と同じ穴）。
      /* 暦日に境界の語を繋げた形を割らない決まり（第 454 回）– `splitQueryToken` と
       * `queryTokenGroups` の内側が呼ぶので、同じ表に並べないと抜き出した品が
       * `ReferenceError` になる（第 257 回・第 341 回・第 392 回と同じ穴）。 */
      "暦日に境界を続けた形Ja",
      "解ける日語かJa",
      "幅の語を割らないかJa",
      "単体の展開語Ja",
      "列挙の代表語Ja",
      "列挙の解きJa",
      "列挙を解くJa",
      "句読点の列挙Ja",
      "断片が皆決まるかJa",
      "列挙の語に割るJa",
      "列挙の展開語Ja",
      /* 語の末尾に繋がれた全行の語を割る手順（第 514 回）– `splitQueryToken` が呼ぶので
       * 同じ表に並べないと、抜き出した品が `ReferenceError` になる
       * （第 257 回・第 372 回・第 453 回と同じ穴）。*/
      "全行の語尾に割るJa",
      /* 語の末尾に繋がれた締切の語を割る手順（第 517 回）– 同じく `splitQueryToken` が呼ぶ。*/
      "締切の語尾に割るJa",
      "訪ねの語尾に落とすいつJa",
      "splitQueryToken",
      "withoutWholeTableGroups",
      "querySynonymMap",
      "abbrevYearGroups",
      "isCalendarMonthDay",
      "calendarDateGroups",
      "offsetCalendarDay",
      "weekDayTermsJa",
      "yearMonthTermsJa",
      // 月のまとまりの語（`今月末` `年内`）は暦月語へ展開する（第 327 回）– 解決の関数も
      // 同じ入口から注入する（一覧を知らない抽出検査が `not defined` で落ちる – 第 257 回と同じ穴）。
      "relativeMonthTerm",
      "monthTokenToYearMonth",
      "periodMonthTermsJa",
      // 日付の語に付きだけの助詞・「まで」「今日から N 日」を剥がす部品（第 328 回）。
      "isDateTableWordJa",
      "dateTokenStemJa",
      "untilDayTermsJa",
      "fromTodayTermsJa",
      // 週と曜日を繋げた形（`今週金曜`）を 1 日に解く部品（第 329 回）。
      "pressedWeekdayJa",
      "連結の列挙Ja",
      "pressedMonthDayJa",
      "isPastJstDay",
      // 年度・年のまとまりの語（第 330 回）。
      "relativeYearKeyJa",
      "fiscalYearBaseJa",
      // 年度の 12 か月語の組み立て（第 330 回）と和暦の寄せ（第 343 回）。`relativeDayGroups`
      // と `fiscalYearTermsJa` が呼ぶので、定義順で先に置く（第 257 回と同じ穴を踏まない）。
      "fiscalTermsFromYearJa",
      "eraYearTermsJa",
      "fiscalYearTermsJa",
      // 月の三日ごとの区切り（`8月下旬` `来月 下旬`）を暦日へ解く部品（第 332 回）。
      "monthPartRangeJa",
      "monthPartTermsJa",
      // 時刻の打ち方（`20時` `午後8時59分`）を 24 時間表記へ解く部品（第 333 回）。
      "clockTimeTermsJa",
      "clockUntilQueryJa",
      // 数値の相対日（`あと 51 日` → `51日後` → 暦日）。`relativeDayGroups` と
      // `queryTokenGroups` が呼ぶので、定義順で先に置く（第 223 回）。
      // 漢数字を算用数字に直す正本（第 392 回 – 上の語の寄せが呼ぶので先に置く）。
      "漢の数字に直すJa",
      "collapseRelativeDayPhrase",
      "numericRelativeDay",
      // 「N 日以内」の範囲展開（第 315 回）: `relativeDayGroups` が呼ぶので注入も一緒にする。
      "withinDaysTermsJa",
      // 英語の正式名称の寄せ（第 316 回）: 表・綴りの形・判定を関数 1 本に閉じた。
      "collapseFieldPhraseEnglish",
      "relativeDayGroups",
      "queryTokenGroups",
      "compoundSplitHit",
      "placeOffersOnline",
      "isShortLatinTerm",
      "foldedLetterAtWordBoundary",
      "termEndsInDigit",
      // 複数形の寄せ（第 314 回）は `queryTokenGroups` が語の組を作るときに行うので、
      // `pluralStems` も同じ入口から注入する（照合の側へ置くと、此の一覧を知らない
      // 抽出検査が `pluralStems is not defined` で落ちる – 第 257 回と同じ穴）。
      "pluralStems",
      "placeLatinTerms",
      "cityQueryForms",
      "regionEntryMembers",
      // 英字語の當たり門（第 675 回）は `matchFoldedGroups` が呼ぶので、注入も一緒にする
      // （此處へ足さんとしは `latinFoldedHit is not defined` で eval が落ちる – 第 257 回と同じ穴）。
      "latinFoldedHit",
      "matchFoldedGroups",
      // `searchMatcher` は述語の組み立てを `searchGroups` に移したので、注入も一緒にする
      // （共有部品を 1 本足すたびに、ハーネスはそれを知らないまま古い形を組む – 第 257 回と同じ穴）。
      "searchGroups",
      "searchMatcher",
      "hayMatches",
    ].map((name) => jsFunction(rec, name)),
  ];
})();

/* 並び順の比較は表の実装そのものを注入する。SORT はセルに出る語（`conferenceNameCell`）で
 * 決まるので、スタブにすると「見ていない語で並ぶ」欠けを検査できない。 */
export const SORT_CANON = (() => {
  const app = siteRuntime();
  const consts = [/const SELECTABLE_KINDS = [^\n]*;/.exec(app)?.[0] || ""];
  const fns = ["titleWithYear", "conferenceNameCell", "kindSortIndex", "compareDeadlineRows"].map(
    (name) => jsFunction(app, name),
  );
  return { consts, fns, all: [...consts, ...fns] };
})();

/* 間接 eval で関数はグローバルに載るが、`const` は eval 用の宣言環境に閉じる
 * （`globalThis.X` にならない）。eval に渡す側だけ `var` に直す（正本の値はそのまま）。 */
export const SORT_CANON_EVAL = [
  ...SORT_CANON.consts.map((src) => src.replace(/^const /, "var ")),
  ...SORT_CANON.fns,
].join("\n");

export const FILTER_RUNTIME_STUBS = [
  // 窓の上限時刻は絞り込みと 0 件時の会期案内で共有する実装（書かないと両者が違う窓で動く）。
  jsFunction(siteRuntime(), "windowLimitMs"),
  // 「締切まで」の上下限は絞り込み本体が共有する実装（窓の解釈を二重化しない）。
  jsFunction(siteRuntime(), "windowFloorMs"),
  // 窓の比較そのもの（行の表示暦日）も共有実装（第 228 回に絞り込みと画面上部の数が 1 本に
  // 寄ったので、ハーネスもそこを注入する。書かないと `rowAfter is not defined` になる）。
  jsFunction(siteRuntime(), "rowShownDayMs"),
  jsFunction(siteRuntime(), "rowAfter"),
  ...SORT_CANON.all,
  "let semQuery = null, semEmbeddings = null;",
  "let catFacetCounts = {};",
  "let hiddenCounts = {",
  "  past: 0, est: 0, kind: 0, domestic: 0, online: 0, onlinePlaceUnknown: 0, window: 0, rank: 0, cats: 0,",
  "};",
  "const activeData = { conferences: [] };",
  ...SEARCH_CANON,
  "let searchQuery = '';",
  "const Recommender = { searchNormalize: searchNormalize, queryTokens: queryTokens, kanaFold: kanaFold, queryTokenGroups: queryTokenGroups, searchMatcher: searchMatcher, matchFoldedGroups: matchFoldedGroups, placeOffersOnline: placeOffersOnline, monthTermsJa: monthTermsJa, expandRelativeMonths: expandRelativeMonths, hayMatches: hayMatches, parsePaperLines: (text) => text ? [{ title: text }] : [], hasJapanese: () => false, contentWordCount: () => 0, autoDetectCats: () => [], venueCategories: () => [], unmatchedVenues: () => [], journalRows: () => [], pastRepresentatives: () => [], rankMatches: (pairs, rank) => pairs.includes(rank), venueRecommendations: (rows) => rows.map((row) => ({ row, boosted: false, match: null, availability: null, fit: { score: 10, lexicalScore: 10, label: '', lexicalRank: 0, semanticRank: 0, semanticScore: 0 } })), comparePapers: () => 0 };",
].join("\n");

/** ビルド後の CSS をルール単位に割る（ネストは @media のみ）。
 * コメントは前置されるとセレクタや @media の判定を壊すので、先に落とす。 */
export function cssBlocks(
  css: string,
  media = "",
): Array<{ media: string; selector: string; body: string }> {
  const source = media === "" ? css.replace(/\/\*[\s\S]*?\*\//g, "") : css;
  const out: Array<{ media: string; selector: string; body: string }> = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("{", i);
    if (open < 0) break;
    const prelude = source.slice(i, open).trim();
    const closeBrace = (from: number): number => {
      let depth = 1;
      let j = from;
      while (j < source.length && depth > 0) {
        if (source[j] === "{") depth += 1;
        else if (source[j] === "}") depth -= 1;
        j += 1;
      }
      return j - 1;
    };
    if (/^@(media|supports)/.test(prelude)) {
      const end = closeBrace(open + 1);
      const cond = prelude.replace(/^@(media|supports)\s*/, "");
      for (const rule of cssBlocks(source.slice(open + 1, end), cond)) out.push(rule);
      i = end + 1;
      continue;
    }
    if (prelude.startsWith("@")) {
      i = closeBrace(open + 1) + 1;
      continue;
    }
    const end = source.indexOf("}", open);
    if (end < 0) break;
    for (const sel of prelude
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      out.push({ media, selector: sel, body: source.slice(open + 1, end) });
    }
    i = end + 1;
  }
  return out;
}

export function cssMediaApplies(media: string, width: number): boolean {
  if (!media) return true;
  if (/\bprint\b/.test(media)) return false;
  const max = media.match(/max-width:\s*(\d+)px/);
  if (max && width > Number(max[1])) return false;
  const min = media.match(/min-width:\s*(\d+)px/);
  if (min && width < Number(min[1])) return false;
  return true;
}

/** 同じセレクタに後から書かれた宣言が勝つ、という単一の規則で解決する。 */
export function effectiveCss(
  css: string,
  selector: string,
  property: string,
  width: number,
): string | null {
  let value: string | null = null;
  for (const block of cssBlocks(css)) {
    if (block.selector !== selector) continue;
    if (!cssMediaApplies(block.media, width)) continue;
    const hit = block.body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
    if (hit) value = (hit[1] as string).trim();
  }
  return value;
}

/** 文字列リテラルだけを拾う（ビルド後はコメントが残るため、正規表現では混ざる）。 */
export function japaneseStringLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close < 0) break;
      i = close + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let buf = "";
      while (j < src.length) {
        const d = src[j];
        if (d === "\\") {
          buf += src[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (d === c) break;
        if (d === "\n" && c !== "`") break;
        buf += d;
        j += 1;
      }
      if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(buf)) out.push(buf);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}
