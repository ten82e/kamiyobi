/**
 * ビルド成果物（app.js / recommender.js）から関数を抜き出して `new Function` のハーネスに
 * 注入する手伝い（SPEC §7・§8）。
 *
 * tests/build_golden.test.ts は 1 MiB の lint 上限（tests/lint_budget.test.ts が番をする）に
 * 近いので、共有できるハーネスはここに置く（第 248 回 – 検査を追しただけで biome がファイルを
 * 丸ごと飛ばすようになり、19,000 行の検査が lint を通ったことになっていた事故の実測がある）。
 */

import { expect } from "vitest";
import { compileSiteRuntime } from "../src/build.ts";

let compiledRuntime: ReturnType<typeof compileSiteRuntime> | null = null;

/** ビルド済みの実行時（app.js / recommender.js の中身）を取り出す（初回だけコンパイルする）。 */
export function siteRuntime(name: keyof ReturnType<typeof compileSiteRuntime> = "app.js"): string {
  compiledRuntime ??= compileSiteRuntime();
  return compiledRuntime[name];
}

/** ビルド成果物から `function name(...) {...}` を中身ごと抜き出す。 */
export function jsFunction(html: string, name: string): string {
  let start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`jsFunction: ${name} が見つからない（空振り検査の防止）`);
  /* `async function` / `export function` の修飾語を落とすと、抜き出した本体は `await` を
   * 持ったままの同期関数になり、`new Function` が構文エラーになる（第 268 回の実発生:
   * `copyIcsSubscribeUrl` を抜いたとき「await は async 関数の中でだけ」と言われた。
   * 検索は `function 名前(` なので、修飾語は自動的にこぼれる）。直前の修飾語を連れてくる。 */
  const modifier = /(?:(?:async|export|default)\s+)+$/.exec(html.slice(0, start));
  if (modifier) start -= modifier[0].length;
  let depth = 0;
  let i = html.indexOf("{", start);
  while (true) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
    i += 1;
  }
}

/* Node 26 は `-e` に渡したソースを ESM かどうか機械的に判定するようで、配列のリテラルに
 * `"crypto"` が 1 語で含まれていると**モジュール扱いになり、トップレベルの `const`/`var` が
 * `new Function` の本体から見えなくなる**（`Recommender is not defined` に化ける。
 * 2026-09-23 に実発生: `cryptography` `xcrypto` は大丈夫で、`crypto` だけ該当した）。
 * 実行時に同じ文字列になる Unicode エスケープへ書き換えて回避する（正本はそのまま）。 */
export function vmSafeSource(src: string): string {
  return src.replace(/"crypto"/g, '"cr\\u0079pto"');
}

/**
 * 「この表その物を指す語」「欄の名前」「画面自身の語」の正本をビルド成果物から注入する
 * （第 239 回・第 244 回・第 248 回 – 検査側に書き写すと正本とズレる）。
 */
export function wholeTableQueryStubs(rec: string): string {
  const list = rec.match(/const WHOLE_TABLE_QUERY_JA[\s\S]*?\];/)?.[0] ?? "";
  expect(list, "WHOLE_TABLE_QUERY_JA が見つからない").toBeTruthy();
  /* 案内に其の方の語を書き返さない語（第 379 回）。注記の側が読むので同じ列を注入する
   * （書き写すと正本とズレる – 第 244 回）。 */
  const 省略語 = rec.match(/const WHOLE_TABLE_COPY_OMITTED_JA = [^\n]*;/)?.[0] ?? "";
  expect(省略語, "WHOLE_TABLE_COPY_OMITTED_JA が見つからない").toBeTruthy();
  /* 欄の名前の正本も同じ入口から注入する（第 244 回 – 書き写すと正本とズレる）。 */
  const cols = [
    rec.match(/const COLUMN_VALUE_EXAMPLES_JA[\s\S]*?\n\s*\};/)?.[0] ?? "",
    rec.match(/const COLUMN_QUERY_WORDS_JA[\s\S]*?\n\s*\];/)?.[0] ?? "",
  ];
  /* 画面自身の語（`使い方` `並び替え` `出典` など）の正本も同じ入口から（第 248 回）。 */
  const uiWords = rec.match(/const UI_WORD_GROUPS_JA[\s\S]*?\n\s*\];/)?.[0] ?? "";
  expect(uiWords, "UI_WORD_GROUPS_JA が見つからない").toBeTruthy();
  /* 活用の形の寄せ（第 326 回）– 画面の語の後ろに付く言い回しの正本。書き写すと画面とズレる。 */
  const uiTails = rec.match(/const UI_WORD_TAILS_JA[\s\S]*?\n\s*\];/)?.[0] ?? "";
  expect(uiTails, "UI_WORD_TAILS_JA が見つからない").toBeTruthy();
  cols.forEach((src) => {
    expect(src, "欄の名前の表が見つからない").toBeTruthy();
  });
  /* 日数の範囲の言い方（`1か月以内` など）の正本（第 253 回）。書き写すと画面とズレる。 */
  const dayRange = [
    rec.match(/const DAY_RANGE_DAYS = [^\n]*;/)?.[0] ?? "",
    rec.match(/const DAY_RANGE_UNIT = [^\n]*;/)?.[0] ?? "",
    rec.match(/const DAY_RANGE_UNIT_JA[\s\S]*?\n\s*\};/)?.[0] ?? "",
    rec.match(/const WIN_LIMITS_JA[\s\S]*?\n\s*\];/)?.[0] ?? "",
    /* 時間の単位で打たれた形（第 365 回）。`dayRangeDaysJa` が読むので、関数だけを渡すと
     * `HOUR_RANGE_JA is not defined` に化ける（第 257 回と同じ穴 – 実際に落ちた）。 */
    rec.match(/const HOUR_RANGE_JA = [^\n]*;/)?.[0] ?? "",
    /* 過去方向の『まで』の案内が読む表（第 367 回）。関数だけ渡すと `not defined` に化ける。 */
    rec.match(/const PAST_RANGE_UNTIL_JA = [^\n]*;/)?.[0] ?? "",
    jsFunction(rec, "時間数から日数Ja"),
    /* 幅の数を**漢数字**で打つ形（第 392 回）。`dayRangeDaysJa` と幅の展開がこの折り方を
     * 読むので、関数だけ渡すと `幅の漢数字を寄せるJa is not defined` に化ける
     * （第 257 回と同じ穴 – 実際に落ちた）。定数は二行に跨るので終端のセミコロンまで受ける。 */
    rec.match(/const 幅の漢数字 =[\s\S]*?;\n/)?.[0] ?? "",
    jsFunction(rec, "漢の数字に直すJa"),
    jsFunction(rec, "幅の漢数字を寄せるJa"),
  ];
  dayRange.forEach((src) => {
    expect(src, "日数の範囲の定義が見つからない").toBeTruthy();
  });
  return [
    list,
    省略語,
    // 欄の名前の定数も返す（抽出した `columnQueryEntry` は本体でこれらを読むので、関数だけ
    // 与えないと `COLUMN_QUERY_WORDS_JA is not defined` に化けた（第 248 回に実発生）。
    ...cols,
    uiWords,
    uiTails,
    /* 案内に書く語を**打たれた形**に戻す関数（第 366 回）。案内の関数が本体で読むので、関数だけ
     * 渡すと `打たれた表記Ja is not defined` に化ける（第 257 回と同じ穴 – 実際に落ちた）。 */
    jsFunction(rec, "打たれた表記Ja"),
    ...dayRange,
    jsFunction(rec, "dayRangeDaysJa"),
    jsFunction(rec, "dayRangeWindowJa"),
    jsFunction(rec, "dayRangeNoteJa"),
    jsFunction(rec, "dayRangeLiveNoteJa"),
    jsFunction(rec, "uiWordStemForms"),
    jsFunction(rec, "uiWordContain"),
    jsFunction(rec, "uiWordMatch"),
    jsFunction(rec, "uiWordEntry"),
    jsFunction(rec, "uiWordRawJa"),
    jsFunction(rec, "uiWordNoteJa"),
    jsFunction(rec, "uiWordLiveNoteJa"),
    jsFunction(rec, "wholeTableQueryWordJa"),
    jsFunction(rec, "wholeTableQueryNoteJa"),
    jsFunction(rec, "columnQueryEntry"),
    jsFunction(rec, "columnQueryWordJa"),
    jsFunction(rec, "columnQueryNoteJa"),
    jsFunction(rec, "columnQueryLiveNoteJa"),
  ].join("\n");
}

/**
 * 0 件の理由の読み上げ（`zeroResultLiveNote`）は行き先一文（`hiddenKindDeliveryJa`）を呼ぶので、
 * 使う側も一緒に抜く。関数式を並べるだけでは名前が生まれないので `var` で宣言する
 * （抜くと `hiddenKindDeliveryJa is not defined`、カンマ式にすると本文中で名前が見えない）。
 */
export function liveNoteSource(app: string): string {
  return `(function () {\n    var hiddenKindDeliveryJa = ${jsFunction(app, "hiddenKindDeliveryJa")};\n    return ${jsFunction(app, "zeroResultLiveNote")};\n  })()`;
}

/** 0 件案内（`emptyDeadlineHint`）を呼べる関数として返す（語はすべてビルドから注入する）。 */
export function deadlineHintFunction(): (f: Record<string, unknown>) => string {
  const app = siteRuntime();
  const rec = siteRuntime("recommender.js");
  return new Function(
    `${app.match(/const KIND_ALL_LABEL_JA = [^\n]*;/)?.[0] ?? ""}
     ${jsFunction(app, "countJa")};
     ${jsFunction(app, "hiddenKindDeliveryJa")};
     ${(rec.match(/const RANK_UNRATED_LABEL_JA = [^\n]*;/) || ['""'])[0]}
     ${wholeTableQueryStubs(rec)}
     const Recommender = { rankUnratedLabelJa: () => RANK_UNRATED_LABEL_JA, wholeTableQueryWordJa, wholeTableQueryNoteJa, columnQueryNoteJa, columnQueryLiveNoteJa, uiWordNoteJa, uiWordLiveNoteJa, dayRangeNoteJa, dayRangeLiveNoteJa };
     ${jsFunction(app, "rankFilterLabelJa")};
     ${jsFunction(app, "rankDropWordsJa")};
     return (${jsFunction(app, "emptyDeadlineHint")});`,
  )() as (f: Record<string, unknown>) => string;
}

/** 0 件の理由の読み上げ（`zeroResultLiveNote`）を呼べる関数として返す。 */
export function zeroResultLiveFunction(): (f: Record<string, unknown>) => string {
  const app = siteRuntime();
  const rec = siteRuntime("recommender.js");
  return new Function(
    `${jsFunction(app, "countJa")};
     ${wholeTableQueryStubs(rec)}
     const Recommender = { wholeTableQueryWordJa, wholeTableQueryNoteJa, columnQueryNoteJa, columnQueryLiveNoteJa, uiWordNoteJa, uiWordLiveNoteJa, dayRangeNoteJa, dayRangeLiveNoteJa };
     return (${liveNoteSource(app)});`,
  )() as (f: Record<string, unknown>) => string;
}
