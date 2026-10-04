/**
 * 「来月中」「今月内」で打つ人だけ件数欄が黙つて居た（第 427 回）。
 *
 * 実測（2026-10-24 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `今月中` 189 行・`来月中` 240 行・`再来月中` 188 行・`先月中` 52 行は其の方の月の語に
 * 解けて通る（`来月` 240 行と対称差 0）のに、件数欄は何も書かなかつた。同じ表の末側は
 * `来月末` = 「2026年9月の締切（末日は 2026年9月30日(水)）」を書く – 『○月中に出る枠』
 * 『今月中に間に合うか』は研究の普通の打ち方で、末側と同じ聞こえ方なので揃えた。
 *
 * 直し – 月のまとまりの語の表（PERIOD_MONTH_WORDS_JA）に『○月中』『○月内』を足す。
 * 展開は其の方の月の組に出て居たので行は一寸も動かず、件数欄が喋るだけ。
 * ただ `来月中に` の様に助詞が付きただけの形は、語尾剥ぎが `来月` まで寄せる為、表の
 * `来月中` に見えなくて其侭黙つた – 剥ぎ落ちの一段手前（打たれた形・『に』だけ剥いだ形）も
 * 表に見るやうにした（第 328 回の『助詞を剥がした形が表に有るときだけ』の決まりの続き）。
 *
 * 番として – 其の侭の月の語（`来月`）と『まで』『一杯』の名前側は件数欄を立てない侭
 * （『来月末まで』が期間の頼み方なので足さない決まり – SPEC の第 352 回の項）。
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
const 対称差 = (甲: string, 乙: string) => {
  const A = 列(甲);
  const B = 列(乙);
  let 違 = 0;
  for (const 行 of new Set([...A, ...B])) if (A.has(行) !== B.has(行)) 違 += 1;
  return 違;
};
const 件数欄 = (語: string) => Recommender.periodMonthPairs(語, 基準);

describe("『○月中』『○月内』は其の方の月と同じ（第 427 回）", () => {
  const 対: Array<[string, string]> = [
    ["今月中", "今月"],
    ["来月中", "来月"],
    ["再来月中", "再来月"],
    ["先月中", "先月"],
    ["今月内", "今月"],
    ["来月内", "来月"],
    ["再来月内", "再来月"],
    ["先月内", "先月"],
    ["来月中に", "来月"],
    ["先月中に", "先月"],
  ];
  for (const [中, 月] of 対) {
    it(`『${中}』は『${月}』と同じ一覧`, () => {
      expect(対称差(中, 月), 中).toBe(0);
      expect(列(中).size, 中).toBeGreaterThan(0);
    });
  }

  it("件数欄に其の方の月を書く（内の四つ。中側は相対月の解決が書く – 二重にしない）", () => {
    expect(件数欄("来月内")).toEqual([["来月内", "2026年9月の締切"]]);
    expect(件数欄("今月内")).toEqual([["今月内", "2026年8月の締切"]]);
    expect(件数欄("再来月内")).toEqual([["再来月内", "2026年10月の締切"]]);
    expect(件数欄("先月内")).toEqual([["先月内", "2026年7月の締切"]]);
    /* 語尾剥ぎが其の方の月の語の外へ寄せる形も、剥ぎ落ちの一段手前（『に』だけ剥いだ形）を
     * 表に見る – 外すと其の方の形だけ件数欄が黙る（第 427 回）。*/
    expect(件数欄("来月内に")).toEqual([["来月内に", "2026年9月の締切"]]);
    /* 今月中・来月中・再来月中・先月中は相対月の語の解決が件数欄を書く（第 427 回 – 月の
     * まとまりの表に二重に足すと同じ語が二度並んだ – 相対月側だけで足りる）。*/
    for (const 語 of ["今月中", "来月中", "再来月中", "先月中"]) {
      expect(件数欄(語), 語).toEqual([]);
    }
  });

  it("先月中に の様な助詞付きも和集合の侭、案内は二重にならない", () => {
    expect(対称差("先月中に", "先月")).toBe(0);
    /* 助詞付きの末側は元から出て居た（第 328 回） – 其の方の決まりの侭か確かめる。*/
    expect(件数欄("来月末に")[0]?.[1]).toContain("2026年9月");
  });
});

describe("その他は其侭（第 427 回）", () => {
  it("其の侭の月の語と『まで』『一杯』の名前は件数欄を立てない", () => {
    expect(件数欄("来月")).toEqual([]);
    expect(件数欄("来月まで")).toEqual([]);
    expect(件数欄("来月一杯")).toEqual([]);
  });

  it("その他の語は一寸も動かない", () => {
    expect(対称差("来月末", "来月")).toBe(0);
    expect(対称差("年内", "")).toBeGreaterThan(0);
    expect(列("年度末").size).toBe(29);
    expect(対称差("半月後", "15日後")).toBe(0);
    expect(対称差("来週と 再来週", "来週と再来週")).toBe(0);
    expect(対称差("aiとml", "ai ml")).toBe(0);
    expect(対称差("月 曜", "")).toBe(0);
    expect(列("").size).toBe(436);
  });
});

describe("割りの形がビルド成果物に残る（第 427 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("表に中・内の条目が並び、剥ぎ落ちの一段手前を見る", () => {
    for (const 形 of [
      "先月中: -1,",
      '今月内: "今月"',
      '来月内: "来月"',
      '再来月内: "再来月"',
      '先月内: "先月"',
    ]) {
      expect(物.split(形).length - 1, 形).toBe(1);
    }
    expect(物.split("PERIOD_MONTH_WORDS_JA[候補] !== undefined").length - 1).toBe(1);
  });
});
