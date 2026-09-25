/**
 * ISO・スラッシュ書きの日付に締切の語を繋げた形の検査（`2026-08-22締切` `8/22まで` `8-22〆`）。
 * SPEC §4・§7・第 351 回。
 * 実測（2026-10-09 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `2026-08-22` 12 行・`8/22` 12 行・`8-22` 12 行・`2026-08-22 締切` 11 行・`8/22 締切` 11 行が
 * 通るのに、`2026-08-22締切` **0 行**・`8/22締切` **0 行**・`8-22締切` **0 行**・
 * `2026-08-22〆` **0 行**・`2026-08-22まで` **0 行**（空格でも 0 行）・`8/22まで` **0 行**・
 * `2026-08-22いっぱい` **0 行**だった。
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

describe("ISO・スラッシュの日付に締切を繋げた形", () => {
  it("締切の語を繋げても空格で打った方と同じ行に出会う", () => {
    expect(行列表("2026-08-22 締切").length, "対照が 0 行").toBeGreaterThan(0);
    for (const [漢, 空格] of [
      ["2026-08-22締切", "2026-08-22 締切"],
      ["2026-08-22締め", "2026-08-22 締切"],
      ["2026-08-22〆", "2026-08-22 締切"],
      ["2026-08-22しめきり", "2026-08-22 締切"],
      ["8/22締切", "8/22 締切"],
      ["8-22締切", "8-22 締切"],
      ["8/22〆", "8/22 締切"],
    ] as Array<[string, string]>) {
      expect(行列表(漢).length, `${漢} が 0 行の侭`).toBeGreaterThan(0);
      expect(対称差(漢, 空格), `${漢} が空格と違う行を出した`).toBe(0);
    }
  });

  it("其の日付その物に直す – 打たれた語を其のまま名指す（中の一部を拾わない）", () => {
    /* 年の有四桁の形を先に置かないと `2026-08-22` の内側の `8-22` が先に当たり、
     * 案内が打たれていない語を名指す（其れを検査する – 並び順は効く）。 */
    expect(書き換え("2026-08-22締切")).toBe("2026-08-22 締切");
    expect(書き換え("8/22締切")).toBe("8/22 締切");
    expect(全案内("2026-08-22締切"), "打たれた語を名指していない").toContain("「2026-08-22締切」");
    expect(全案内("2026-08-22締切"), "寄せた語を書いていない").toContain(
      "「2026-08-22」と「締切」",
    );
    expect(全案内("2026-08-22締切"), "打たれていない語を名指した").not.toContain("「8-22」");
  });

  it("`いっぱい` を繋げた形は其の日付の締切として探す（其の日付の語を名指す）", () => {
    for (const [語, 基] of [
      ["2026-08-22いっぱい", "2026-08-22"],
      ["2026-08-22締切", "2026-08-22 締切"],
    ] as Array<[string, string]>) {
      expect(行列表(語).length, `${語} が 0 行の侭`).toBeGreaterThan(0);
      expect(対称差(語, 基), `${語} が基の方と違う行を出した`).toBe(0);
      expect(全案内(語), `${語} が何として探したかを書いていない`).toContain("締切");
    }
  });

  it("`まで` を繋げた形は其の日付を語に割らず、今日からの幅として探す（第 398 回）", () => {
    for (const [語, 基] of [
      ["2026-08-22まで", "2026-08-22"],
      ["8/22まで", "8/22"],
      ["8/22までに", "8/22"],
    ] as Array<[string, string]>) {
      const 其の日 = new Set(行列表(基).map((行) => 行.hay));
      const 幅 = new Set(行列表(語).map((行) => 行.hay));
      expect(幅.size, `${語} が 0 行の侭`).toBeGreaterThan(0);
      expect(
        [...其の日].every((行) => 幅.has(行)),
        `${語} が其の日の行を落とした`,
      ).toBe(true);
      expect(全案内(語), `${語} の幅の案内が消えた`).toContain("〜");
    }
    /* `8/22まで` のやうに区切りの日付へ期日を繋げた形は、`/` で語に割れると `8` と
     * `22まで` の二語になって一も当たらなかつた（其的一方、件数欄は幅を出して居た）。 */
    expect(書き換え("8/22まで"), "`8/22まで` が語に割れた").toBe("8/22まで");
  });
});

describe("壊していない物", () => {
  it("年月だけの形・その他の打ち方は其侭", () => {
    expect(行列表("2026-08").length, "`2026-08` が化けた").toBeGreaterThan(100);
    expect(書き換え("2026-08")).toBe("2026-08");
    expect(書き換え("8/22")).toBe("8/22");
    expect(書き換え("3-5")).toBe("3-5");
    expect(書き換え("2026-08-22")).toBe("2026-08-22");
  });

  it("第 344 – 350 回の形は此の回合の変更でも其侭通る", () => {
    expect(書き換え("8月22日締切")).toBe("8月22日 締切");
    expect(書き換え("週末締切")).toBe("週末 締切");
    expect(書き換え("上旬締切")).toBe("上旬 締切");
    /* 『頃』を落とした後、`N月末` は其の月に寄せる（第 341 回 – 其の方の形そのまま張る）。 */
    expect(書き換え("8月末頃")).toBe("8月");
    expect(書き換え("八月締切")).toBe("8月 締切");
    /* `N月まで` は其の月に寄せる（締切の語を足さない – 第 347 回の実測のまま）。 */
    expect(対称差("8月まで", "8月"), "`8月まで` が変わった").toBe(0);
    expect(対称差("明日締切", "明日 締切"), "`明日締切` が変わった").toBe(0);
    expect(行列表("バーチャル参加").length, "`バーチャル参加` が落ちた").toBeGreaterThan(0);
    expect(行列表("対面参加").length, "`対面参加` に行くようになった").toBe(0);
  });
});

describe("成果物", () => {
  it("ISO の形は締切・まで・いっぱい・案内の四つの頭に同じように入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 本文 = jsFunction(rec, "collapseRelativeDayPhrase");
    const 断片 = "[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}|[0-9]{1,2}[-/][0-9]{1,2}";
    /* 関数の中は 締切 / まで / いっぱい の三本、案内の側が一本。 */
    /* 関数の中は 締切 / いっぱい の二本 – 数値で書いた日付の `まで` は此処で寄せない
     * （其の方の形は `untilDayTermsJa` が今日からの幅に解く – 第 398 回）、案内の側が一本。 */
    expect(本文.split(断片).length - 1, "関数の中の ISO の頭の数が変わった").toBe(2);
    expect(rec.split(断片).length - 1, "案内の側の ISO の頭が消えた").toBe(3);
    /* 月の和文の形より前に在る（其の日付を先に受ける為 – 上の検査が其れを見る）。 */
    expect(
      本文.indexOf(断片) < 本文.indexOf("[0-9]{1,2}月[0-9]{1,2}日"),
      "ISO の形が和文の日付より後ろに並んだ",
    ).toBe(true);
  });
});
