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
  const start = html.indexOf(`function ${name}(`);
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
  /* 欄の名前の正本も同じ入口から注入する（第 244 回 – 書き写すと正本とズレる）。 */
  const cols = [
    rec.match(/const COLUMN_VALUE_EXAMPLES_JA[\s\S]*?\n\s*\};/)?.[0] ?? "",
    rec.match(/const COLUMN_QUERY_WORDS_JA[\s\S]*?\n\s*\];/)?.[0] ?? "",
  ];
  /* 画面自身の語（`使い方` `並び替え` `出典` など）の正本も同じ入口から（第 248 回）。 */
  const uiWords = rec.match(/const UI_WORD_GROUPS_JA[\s\S]*?\n\s*\];/)?.[0] ?? "";
  expect(uiWords, "UI_WORD_GROUPS_JA が見つからない").toBeTruthy();
  cols.forEach((src) => {
    expect(src, "欄の名前の表が見つからない").toBeTruthy();
  });
  /* 日数の範囲の言い方（`1か月以内` など）の正本（第 253 回）。書き写すと画面とズレる。 */
  const dayRange = [
    rec.match(/const DAY_RANGE_DAYS = [^\n]*;/)?.[0] ?? "",
    rec.match(/const DAY_RANGE_UNIT = [^\n]*;/)?.[0] ?? "",
    rec.match(/const DAY_RANGE_UNIT_JA[\s\S]*?\n\s*\};/)?.[0] ?? "",
    rec.match(/const WIN_LIMITS_JA[\s\S]*?\n\s*\];/)?.[0] ?? "",
  ];
  dayRange.forEach((src) => {
    expect(src, "日数の範囲の定義が見つからない").toBeTruthy();
  });
  return [
    list,
    // 欄の名前の定数も返す（抽出した `columnQueryEntry` は本体でこれらを読むので、関数だけ
    // 与えないと `COLUMN_QUERY_WORDS_JA is not defined` に化けた（第 248 回に実発生）。
    ...cols,
    uiWords,
    ...dayRange,
    jsFunction(rec, "dayRangeDaysJa"),
    jsFunction(rec, "dayRangeWindowJa"),
    jsFunction(rec, "dayRangeNoteJa"),
    jsFunction(rec, "dayRangeLiveNoteJa"),
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
