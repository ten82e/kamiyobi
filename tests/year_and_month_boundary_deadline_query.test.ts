/**
 * 年・月の切れ目の語（`年末` `年始` `年度末` `来月末`）に締切の語を繋げた形の検査。
 * SPEC §4・§7・第 352 回。
 * 実測（2026-10-10 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `年末` 183 行・`年初` 109 行・`年明け` 109 行・`年度末` 80 行・`年度初め` 81 行・`年度当初` 81 行・
 * `月末` 189 行・`来月末` 240 行が通るのに、`年始` **0 行**・`年初め` **0 行**・`年始め` **0 行**・
 * `年度始め` **0 行**（対の語が在るのに其方だけ欠けていた）、又、締切の語を**繋げた**形はいずれも
 * **0 行**（`年末締切` **0 行**・`年始締切` **0 行**・`年初締切` **0 行**・`年度末締切` **0 行**・
 * `年度初め締切` **0 行**・`月末締切` **0 行**・`来月末締切` **0 行**…）で、空格で打った方だけが
 * 届いていた（`年末 締切` 127 行・`年度末 締切` 63 行・`月末 締切` 172 行）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { jsFunction } from "./runtime_extract.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 行列表(語: string): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
  const matches = Recommender.searchMatcher(語, 基準);
  return rows.filter((row) => matches(String(row.hay)) === true);
}

function 対称差(a: string, b: string): number {
  const x = new Set(行列表(a).map((r) => r.hay));
  const y = new Set(行列表(b).map((r) => r.hay));
  return [...x].filter((k) => !y.has(k)).length + [...y].filter((k) => !x.has(k)).length;
}

function 全案内(語: string): string {
  return [
    Recommender.querySynonymNotes(語).join(" "),
    Recommender.uiWordNoteJa(語),
    Recommender.uiWordLiveNoteJa(語),
    Recommender.relativeDayNotes(語, 基準).join(" "),
  ]
    .filter((文) => 文)
    .join(" / ");
}

/** 成果物に組み立てられた書き換え関数を実際に走らせる（其の関数が参照する表の宣言も置く – 第 347 回）。 */
function 書き換え(語: string): string {
  const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  const 本体 = jsFunction(rec, "collapseRelativeDayPhrase");
  const 表 = rec.slice(rec.indexOf("const RELATIVE_DAY_PHRASES_JA"));
  const 表の宣言 = 表.slice(0, 表.indexOf("];") + 2);
  expect(表の宣言.includes("["), "`RELATIVE_DAY_PHRASES_JA` の宣言が見つからない").toBe(true);
  /* 漢数字を算用数字に直す正本（第 392 回）– 上の語の寄せが呼ぶので、関数だけ渡すと
   * `漢の数字に直すJa is not defined` に化ける（第 257 回と同じ穴 – 実際に落ちた）。 */
  const 下請け = jsFunction(rec, "漢の数字に直すJa");
  const 関数 = new Function(
    "Recommender",
    `${表の宣言}\nconst 漢の数字に直すJa = ${下請け};\nreturn (${本体});`,
  )(Recommender) as (語: string) => string;
  return 関数(語);
}

const 切れ目と暦月: Array<[string, string]> = [
  ["年末", "12月"],
  ["年始", "1月"],
  ["年初", "1月"],
  ["年初め", "1月"],
  ["年始め", "1月"],
  ["年明け", "1月"],
  ["年度末", "3月"],
  ["年度初め", "4月"],
  ["年度始め", "4月"],
  ["年度当初", "4月"],
];

describe("年・月の切れ目の語", () => {
  it("年の切れ目の言い方は其の方の暦月と同じ行に出会う（対の語が揃っている）", () => {
    for (const [語, 暦月] of 切れ目と暦月) {
      expect(行列表(暦月).length, `対照の \`${暦月}\` が 0 行`).toBeGreaterThan(0);
      expect(行列表(語).length, `${語} が 0 行の侭（対の語が欠けている）`).toBeGreaterThan(0);
      expect(対称差(語, 暦月), `${語} が \`${暦月}\` と違う行を出した`).toBe(0);
    }
  });

  it("締切の語を繋げても空格で打った方と同じ行に出会う", () => {
    for (const 語 of [
      "年末",
      "年始",
      "年初",
      "年初め",
      "年始め",
      "年明け",
      "年度末",
      "年度初め",
      "年度始め",
      "年度当初",
      "月末",
      "来月末",
      "今月末",
      "再来月末",
    ]) {
      expect(行列表(`${語} 締切`).length, `対照の \`${語} 締切\` が 0 行`).toBeGreaterThan(0);
      expect(行列表(`${語}締切`).length, `${語}締切 が 0 行の侭`).toBeGreaterThan(0);
      expect(対称差(`${語}締切`, `${語} 締切`), `${語}締切 が空格と違う行を出した`).toBe(0);
      const 案内 = 全案内(`${語}締切`);
      expect(案内, `${語}締切 の案内が出ていない`).toContain(`「${語}締切」`);
      expect(案内, `${語}締切 が何に寄せたかを書いていない`).toContain(`「${語}」`);
    }
    expect(書き換え("年末締切")).toBe("年末 締切");
    expect(書き換え("年度末締切")).toBe("年度末 締切");
    expect(書き換え("来月末締切")).toBe("来月末 締切");
  });

  it("`まで` を繋げた形は範囲の規則が受ける（其の月に潰さない – 第 331・332 回）", () => {
    /* 実測 `来月末まで` 240 行 = `来月まで` 240 行（対称差 0）。切れ目の語を `まで` の頭に足すと
     * 期間が其の月に潰れる – 実際に足して既存の検査が落ちたので引いた（其の事を見る）。 */
    expect(行列表("来月まで").length, "対照の `来月まで` が 0 行").toBeGreaterThan(0);
    expect(対称差("来月末まで", "来月まで"), "`来月末まで` が範囲を潰した").toBe(0);
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 本文 = jsFunction(rec, "collapseRelativeDayPhrase");
    const まで宣言 = 本文.slice(本文.indexOf("期日までの言い方"));
    const まで規則 = まで宣言.slice(0, まで宣言.indexOf(";"));
    expect(
      まで規則.includes("年度当初|年度初め"),
      "`まで` の頭に切れ目の語を足した（期間が其の月に潰れる）",
    ).toBe(false);
  });
});

describe("壊していない物", () => {
  it("第 344 – 351 回の形と、月の数字の形は其侭", () => {
    expect(書き換え("8月末頃")).toBe("8月");
    expect(対称差("8月末締切", "8月末 締切"), "`8月末締切` が変わった").toBe(0);
    expect(対称差("8月まで", "8月"), "`8月まで` が変わった").toBe(0);
    expect(対称差("上旬締切", "上旬 締切"), "`上旬締切` が変わった").toBe(0);
    expect(対称差("週末締切", "週末 締切"), "`週末締切` が変わった").toBe(0);
    expect(対称差("2026-08-22締切", "2026-08-22 締切"), "`2026-08-22締切` が変わった").toBe(0);
    expect(対称差("八月締切", "8月 締切"), "`八月締切` が変わった").toBe(0);
  });

  it("受けない形は受けない侭（`年内` は範囲の語 – 締切を繋げても寄せない）", () => {
    /* `年内` は「今月〜12月」の範囲を表す特別な語（`@年内`）なので、締切の語を繋げた形も
     * 其のまま返す（実測 `年内締切` は品書で 0 行 – 其の方の語に寄せて件数を盛らない）。 */
    expect(書き換え("年内締切")).toBe("年内締切");
    expect(行列表("年内").length, "対照の `年内` が 0 行").toBeGreaterThan(0);
  });
});

describe("成果物", () => {
  it("切れ目の語の頭は締切を繋げた規則にだけが在る（`まで`・`いっぱい`・案内に足していない）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 本文 = jsFunction(rec, "collapseRelativeDayPhrase");
    const 断片 = "年度当初|年度初め|年度始め|年度末|再来月末|来月末|今月末|年末";
    expect(本文.split(断片).length - 1, "切れ目の語の頭の数が変わった").toBe(1);
    /* 案内の表（関数の外）にも足していない – 『年末まで』の案内が範囲の規則と食い違うのを防ぐ。 */
    expect(rec.split(断片).length - 1, "切れ目の語の頭が関数の外にも増えた").toBe(1);
    /* 対の表（`PERIOD_MONTH_WORDS_JA`）は関数の外の module レベルの定数 – 関数の中身では無く
     * 成果物全体で見る（第 347 回 – 関数の本体だけ見て空振りしたのと同じ轍を踏まない）。 */
    for (const 語 of ["年始", "年初め", "年始め"]) {
      expect(rec.includes(`${語}: "1月"`), `対の表から \`${語}\` が消えた`).toBe(true);
    }
    expect(rec.includes('年度始め: "4月"'), "`年度始め` の寄せが消えた").toBe(true);
  });
});
