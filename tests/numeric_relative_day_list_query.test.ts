/**
 * 数値で書く相対日を並べた形（`3日後と5日後` `3日後5日後` `3日後、5日後`）– 第 405 回。
 *
 * 実測（2026-10-02 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻
 * 2026-08-09T00:00:00Z）: 其れぞれ単体で打てば通る（`3日後` 3 行・`5日後` 19 行・
 * `1週間後` 17 行・`1か月後` 18 行）のに、並べた形は全部 0 行だつた –
 * `3日後と5日後` **0 行**（和集合 22 行）・`1週間後と2週間後` **0 行**（和集合 36 行）・
 * `1か月後と2か月後` **0 行**（和集合 34 行）・`3日後と明日` **0 行**（和集合 7 行）・
 * `3日後、5日後` **0 行**・`2日後と4日後と6日後` **0 行**。相対語（`明日と明後日`）は
 * 並べた形が通るので、数の向きだけ損をして居た。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 列表入口() {
  const 品 = (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
  const 済 = new Map<string, Set<string>>();
  return (語: string): Set<string> => {
    if (!済.has(語)) {
      const 当 = Recommender.searchMatcher(語, 基準);
      済.set(語, new Set(品.filter((行) => 当(行) === true)));
    }
    return 済.get(語) as Set<string>;
  };
}

const 列 = 列表入口();

function 対称差(甲: Set<string>, 乙: Set<string>): number {
  return [...甲].filter((行) => !乙.has(行)).length + [...乙].filter((行) => !甲.has(行)).length;
}

function 和集合(...語々: string[]): Set<string> {
  const 和 = new Set<string>();
  for (const 語 of 語々) for (const 行 of 列(語)) 和.add(行);
  return 和;
}

function はみ出し(甲: Set<string>, 乙: Set<string>): number {
  return [...甲].filter((行) => !乙.has(行)).length;
}

describe("数値で書く相対日を並べた形", () => {
  it("其れぞれの語の和集合に受ける", () => {
    for (const [並べた形, 語々] of [
      ["3日後と5日後", ["3日後", "5日後"]],
      ["1週間後と2週間後", ["1週間後", "2週間後"]],
      ["1か月後と2か月後", ["1か月後", "2か月後"]],
      ["2日後と4日後と6日後", ["2日後", "4日後", "6日後"]],
      ["3日後と明日", ["3日後", "明日"]],
      ["明日と3日後", ["明日", "3日後"]],
      ["3日後、5日後", ["3日後", "5日後"]],
      ["3日前と5日前", ["3日前", "5日前"]],
    ] as Array<[string, string[]]>) {
      const 和 = 和集合(...語々);
      expect(和.size, `対照の和集合（${語々.join("/")}）が 0 行`).toBeGreaterThan(0);
      expect(列(並べた形).size, `「${並べた形}」が行を出さない`).toBeGreaterThan(0);
      expect(対称差(列(並べた形), 和), `「${並べた形}」が和集合と違う列表`).toBe(0);
    }
  });

  it("助詞も読点も無い並べ打ちも同じ和集合に受ける", () => {
    for (const [連結, 並べた形] of [
      ["3日後5日後", "3日後と5日後"],
      ["1週間後2週間後", "1週間後と2週間後"],
    ] as Array<[string, string]>) {
      expect(列(連結).size, `「${連結}」が行を出さない`).toBeGreaterThan(0);
      expect(対称差(列(連結), 列(並べた形)), `「${連結}」が \`${並べた形}\` と違う列表`).toBe(0);
    }
  });

  it("和集合より広くならない（其れぞれの日以外の日を混ぜない）", () => {
    expect(はみ出し(列("3日後と5日後"), 和集合("3日後", "5日後"))).toBe(0);
    /* `半月後` は 15 日ぶんの決まる日になった（第 426 回 – 暦の定め。其の方の語は
     * `15日後` `15日前` と同じ一日に解ける）ので、並べた形は和集合で解ける。*/
    expect(
      はみ出し(列("半月後と半月前"), 和集合("半月後", "半月前")) +
        はみ出し(和集合("半月後", "半月前"), 列("半月後と半月前")),
      "「半月後と半月前」が和集合と違う",
    ).toBe(0);
    expect(列("半月以内と15日以内"), "「半月以内と15日以内」が解けてしまった").toEqual(new Set());
    /* 一片でも其の日を決めない物が交じれば列挙全体を解かない – 片方だけの当たり方は
     * 「其の方の語で引いた人」より広い噓の幅になる（対照: `8月10日` 4 行・`3日後` 3 行）。 */
    expect(列("8月10日と半月"), "其の日を決めない語が混じる列挙を解いた").toEqual(new Set());
    /* 第 426 回 – 半月後は其の方で日を決める語なので、この並びは解ける（対照: 裸の`半月`は解かない侭）。*/
    expect(列("3日後と半月後").size, "「3日後と半月後」が解けない").toBeGreaterThan(0);
    expect(列("1か月後と15日以内"), "幅の語が混じる列挙を解いた").toEqual(new Set());
  });

  it("幅の言い方は幅の侭（二つの端の和集合に化けない）", () => {
    expect(列("3日後から5日後").size, "幅の言い方が行を出さない").toBeGreaterThan(0);
    expect(
      対称差(列("3日後から5日後"), 和集合("3日後", "5日後")) > 0,
      "幅の言い方が二つの端の和集合に化けている",
    ).toBe(true);
    /* 幅の途中で列挙を解こうとして語を割らない（`3日後から` の様な壊れた語を作らない）。 */
    expect(
      はみ出し(列("3日後から5日後"), 和集合("3日後", "4日後", "5日後")),
      "幅の言い方が幅の外の日を混ぜている",
    ).toBe(0);
  });

  it("語を並べただけの打ち方は和集合にしない（AND の侭）", () => {
    expect(列("東京").size, "対照の `東京` が 0 行").toBeGreaterThan(0);
    expect(列("東京大阪"), "語を並べた打ち方が和集合に化けた").toEqual(new Set());
    /* 読点を打たれた語も – 日語で決まらない物は AND の侭（第 396 回の決まり）。 */
    expect(列("東京、大阪"), "日語では決まらない語が和集合に化けた").toEqual(new Set());
    expect(
      対称差(列("東京、大阪"), 和集合("東京", "大阪")) > 0,
      "読点で並べた語を和集合にしている",
    ).toBe(true);
    expect(はみ出し(列("3日後と5日後と明日"), 和集合("3日後", "5日後", "明日"))).toBe(0);
    expect(
      対称差(列("3日後と5日後と明日"), 和集合("3日後", "5日後", "明日")),
      "三つ並べた形が和集合と違う",
    ).toBe(0);
  });
});

describe("成果物", () => {
  it("数値の相対日の形を表す語が一個所に決まつている", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/const 数値の相対日の形Ja = /g) ?? []).toHaveLength(1);
    /* 列挙の目印（打たれた語と柄の両方）と『までに』を剥ぐ規則が同じ語を読む。 */
    expect(物.match(/数値の相対日の形Ja\.test\(柄\)/g) ?? []).toHaveLength(1);
    expect(物.match(/数値の相対日の形Ja\.test\(語\)/g) ?? []).toHaveLength(1);
    expect(物.match(/数値の相対日の形Ja\.test\(word\)/g) ?? []).toHaveLength(1);
  });
});
