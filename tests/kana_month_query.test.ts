/**
 * 仮名で「らいげつ」と打つ人だけ 0 行で黙つて居た（第 429 回）。
 *
 * 実測（2026-10-24 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * 週の語の表は仮名を持つので `らいしゅう` 53 行・`らいしゅう中` 53 行が通るのに、
 * 月の側は仮名が表に無く `らいげつ` `こんげつ` `せんげつ` `さらいげつ` `さいげつ`
 * **いずれも 0 行で案内も無し**。`らいげつ以内` も 0 行（其の方の『以内』の規則は
 * 仮名を読むが解決先が無かつた）。`中` を足しただけの形も同じ壁。
 *
 * 直し – 相対月の表（RELATIVE_MONTH_OFFSETS_JA）に仮名を通す（第 340 回の週の決まりと
 * 同じ）。『○月内』は月のまとまりの表が持つので其の方にも対を足す（第 427 回の続き）。
 * 寄せ先は漢字と同じ月なので案内も其の方の形（らいげつ = 2026年9月）で出る。
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

describe("仮名の月の語は漢字と同じ（第 429 回）", () => {
  const 対: Array<[string, string]> = [
    ["こんげつ", "今月"],
    ["らいげつ", "来月"],
    ["せんげつ", "先月"],
    ["さらいげつ", "再来月"],
    ["さいげつ", "再来月"],
    ["こんげつ中", "今月中"],
    ["らいげつ中", "来月中"],
    ["せんげつ中", "先月中"],
    ["さらいげつ中", "再来月中"],
    ["らいげつ内", "来月内"],
    ["こんげつ内", "今月内"],
    ["せんげつ内", "先月内"],
    ["らいげつに", "来月"],
    ["らいげつ以内", "来月"],
    ["こんげつ以内", "今月"],
  ];
  for (const [假, 漢] of 対) {
    it(`『${假}』は『${漢}』と同じ一覧`, () => {
      expect(対称差(假, 漢), 假).toBe(0);
      /* 両側 0 行の『同じ』は空振り – 行が出ている事も見る（第 428 回の決まり）。*/
      expect(列(假).size, 假).toBeGreaterThan(0);
      expect(列(漢).size, 漢).toBeGreaterThan(0);
    });
  }

  it("件の数と案内も其の方の形（黙らない・二重にならない）", () => {
    expect(対称差("らいげつ", "来月")).toBe(0);
    expect(Recommender.relativeMonthPairs("らいげつ", 基準)).toEqual([["らいげつ", "2026年9月"]]);
    expect(Recommender.periodMonthPairs("らいげつ内", 基準)).toEqual([
      ["らいげつ内", "2026年9月の締切"],
    ]);
    /* 其の侭の月の語に『に』を付けただけの形は件の欄を立てない侭（其の方の側の決まり）。*/
    expect(Recommender.periodMonthPairs("らいげつ", 基準)).toEqual([]);
  });

  it("仮名の週は元から通つて居た – 其の方の決まりの対か確かめる", () => {
    expect(対称差("らいしゅう", "来週")).toBe(0);
    expect(対称差("らいしゅう中", "来週中")).toBe(0);
  });
});

describe("其它は其侭（第 429 回）", () => {
  it("其它の語は一寸も動かない", () => {
    expect(対称差("来月一杯", "来月")).toBe(0);
    expect(対称差("半月後", "15日後")).toBe(0);
    expect(対称差("来週と 再来週", "来週と再来週")).toBe(0);
    expect(対称差("aiとml", "ai ml")).toBe(0);
    expect(対称差("月 曜", "")).toBe(0);
    expect(列("来月中").size).toBe(178);
    expect(列("").size).toBe(436);
  });

  it("一通に決まらない仮名は寄せない（締切の推測をしない）", () => {
    for (const 語 of ["みらいねん", "らいしゅうちゅう"]) {
      expect(列(語).size, 語).toBe(0);
    }
  });
});

describe("割りの形がビルド成果物に残る（第 429 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("相対月の表に仮名が並び、内の対も月のまとまりの表に在る", () => {
    for (const 形 of [
      "らいげつ: 1,",
      "こんげつ: 0,",
      "せんげつ: -1,",
      "さらいげつ: 2,",
      "らいげつ中: 1,",
      'らいげつ内: "来月"',
    ]) {
      expect(物.split(形).length - 1, 形).toBe(1);
    }
  });
});
