/**
 * 「年度内」「来年度中に」を打つ人だけ 0 行で黙つて居た（第 430 回）。
 *
 * 実測（2026-10-24 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `今年度` 872 行・`今年度中` 872 行・`来年度以内` 273 行が通るのに、
 * `年度内` `年度` は** 0 行で案内も無し**（其の方の年度と其の方の幅で通る語）、
 * `年度内に` `来年度中に` `来年度内に` `来年度に` も 0 行（語尾の『に』を
 * 年度の規則が受け足りなかつた – 月の側は `来月中に` が通る、第 427 回の続き）。
 *
 * 直し – 年度のかたまりの表に `年度: 0` を足し（『年内』が其の方の年の幅で通ると
 * 同じ指示の仕方）、語尾剥ぎに『内』と裸の『に』『中に』を通す。剥いだ側が表に
 * 在る物だけ受けるので其它の語は其のまま null。
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

describe("『年度内』『○年度中に』は年度のかたまり（第 430 回）", () => {
  const 対: Array<[string, string]> = [
    ["年度内", "今年度"],
    ["年度内に", "今年度"],
    ["年度", "今年度"],
    ["当年度内", "今年度"],
    ["今年度中に", "今年度"],
    ["来年度内", "来年度"],
    ["来年度中に", "来年度"],
    ["来年度内に", "来年度"],
    ["来年度に", "来年度"],
    ["来年度以内", "来年度"],
  ];
  for (const [甲, 乙] of 対) {
    it(`『${甲}』は『${乙}』と同じ一覧`, () => {
      expect(対称差(甲, 乙), 甲).toBe(0);
    });
  }

  it("件の数も同じ（0 行⇔0 行の空振りを防ぐ – 第 428 回の決まり）", () => {
    expect(列("年度内").size).toBe(436);
    expect(列("来年度内").size).toBe(50);
  });

  it("案内は其の方の年度を書き、年度は 4 月始まりの断りも添う", () => {
    const 案内 = Recommender.relativeDayNotes("年度内", 基準).join(" ");
    expect(案内).toContain("年度内 = 2026年4月1日(水)〜2027年3月31日(水)の締切");
    expect(案内).toContain("年度は 4 月から翌年 3 月までです");
  });
});

describe("其它は其侭（第 430 回）", () => {
  it("年度末・年内・其它の語は一寸も動かない", () => {
    expect(列("年度末").size).toBe(29);
    expect(列("年内").size).toBe(425);
    expect(対称差("らいげつ", "来月")).toBe(0);
    expect(対称差("来月一杯", "来月")).toBe(0);
    expect(対称差("半月後", "15日後")).toBe(0);
    expect(対称差("来週と 再来週", "来週と再来週")).toBe(0);
    expect(対称差("aiとml", "ai ml")).toBe(0);
    expect(対称差("月 曜", "")).toBe(0);
    expect(列("").size).toBe(436);
  });

  it("表に在らぬ語に『に』が付いただけの形は寄せない（締切の推測をしない）", () => {
    /* 『月初』は公開の決まりが無く寄せない級（第 332 回） – 『に』を剥いだ側が表に
     * 在ないので語尾剥ぎでも解けない。『年度末に』は月のまとまりの表が受けるので
     * 其の方の対（第 427 回の語尾剥ぎ）として件数を持つ – 両者を区別して見る。*/
    expect(列("月初に").size).toBe(0);
    expect(対称差("年度末に", "年度末")).toBe(0);
    expect(列("年度末に").size).toBe(29);
  });
});

describe("割りの形がビルド成果物に残る（第 430 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("年度語彙に『年度』が並び、語尾剥ぎが『内』『に』まで受ける", () => {
    for (const 形 of [
      "\n        年度: 0,",
      "FISCAL_YEAR_TAIL_JA = /^(.+?)(?:中|以内|内|に)(?:に)?$/",
    ]) {
      expect(物.split(形).length - 1, 形).toBe(1);
    }
    /* 枝から『中』を落とすと其の方の側が黙る – 其の方の侭の形が表から消えた事も見る。*/
    expect(物.split("(?:中|以内)$/").length - 1).toBe(0);
  });
});
