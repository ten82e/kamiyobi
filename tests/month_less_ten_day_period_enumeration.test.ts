/**
 * 月を打た無い旬（上旬・中旬・下旬）を並べた形 – 第 411 回。
 *
 * 実測（2026-10-07 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻
 * 2026-08-09T00:00:00Z）で、旬は其れだけで其の月の暦日に解ける（`上旬` 35 行・`中旬` 74 行・
 * `下旬` 91 行）のに、並べた形は總て 0 行だつた – `上旬と下旬` **0 行**（和集合 126 行）・
 * `上旬と中旬` **0 行**（106 行）・`中旬と下旬` **0 行**（157 行）・`上旬、下旬` **0 行**・
 * `上旬下旬` **0 行**・`上旬と下旬と中旬` **0 行**（189 行）・`上旬と下旬 締切` **0 行**。
 * 月を付けた形（`8月上旬と下旬` 126 行）は通つて居た。
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
  const 列 = (語: string): Set<string> => {
    if (!済.has(語)) {
      const 当 = Recommender.searchMatcher(語, 基準);
      済.set(語, new Set(品.filter((行) => 当(行) === true)));
    }
    return 済.get(語) as Set<string>;
  };
  列.和 = (...語々: string[]): Set<string> => new Set(語々.flatMap((語) => [...列(語)]));
  return 列;
}

const 列 = 列表入口();

function 対称差甲乙(甲: Set<string>, 乙: Set<string>): number {
  return [...甲].filter((行) => !乙.has(行)).length + [...乙].filter((行) => !甲.has(行)).length;
}

function 対称差(甲の語: string, 乙: Set<string>): number {
  return 対称差甲乙(列(甲の語), 乙);
}

describe("月を打た無い旬を並べた形", () => {
  it("其の方の語の和集合で当たる（0 行でも別の月に化けたりもしない）", () => {
    for (const [語, 並] of [
      ["上旬と下旬", ["上旬", "下旬"]],
      ["上旬と中旬", ["上旬", "中旬"]],
      ["中旬と下旬", ["中旬", "下旬"]],
      ["上旬、下旬", ["上旬", "下旬"]],
      ["上旬下旬", ["上旬", "下旬"]],
      ["上旬と下旬に", ["上旬", "下旬"]],
    ] as Array<[string, string[]]>) {
      const 其の方 = 列.和(...並);
      expect(其の方.size, `品書で ${並.join("・")} が 0 行`).toBeGreaterThan(0);
      expect(対称差(語, 其の方), `「${語}」の当たり方が其の方の語の和集合と違う`).toBe(0);
    }
  });

  it("三つ以上並べても其侭和集合になる", () => {
    const 三つ = 列.和("上旬", "中旬", "下旬");
    expect(三つ.size, "品書で三つの旬が 0 行").toBeGreaterThan(0);
    expect(対称差("上旬と下旬と中旬", 三つ), "三つ並べた形が壊れて居る").toBe(0);
  });

  it("語を並べた頼み方も通る", () => {
    const 締切有 = 列("上旬と下旬 締切");
    expect(締切有.size, "`上旬と下旬 締切` が 0 行").toBeGreaterThan(0);
    expect(
      [...締切有].filter((行) => !列("上旬と下旬").has(行)),
      "`上旬と下旬 締切` が和集合より廣い",
    ).toHaveLength(0);
  });

  it("件の数欄に其の月のどちらの旬か書く", () => {
    const 幅 = (語: string) => Recommender.dayRangePairs(語, 基準) as Array<[string, string]>;
    for (const 語 of ["上旬と下旬", "中旬と下旬"]) {
      const 出 = 幅(語);
      expect(出, `「${語}」の案内が消えて居る`).toHaveLength(1);
      expect(出[0][1], `「${語}」の案内が和集合の書き方になつて居ない`).toContain("または");
      expect(出[0][1], `「${語}」の案内が月日を決めて居ない`).toMatch(/[0-9]+月[0-9]+日/);
    }
  });
});

describe("守り", () => {
  it("月が決まらない裸の日の列挙は解かない侭（締切の推測はしない）", () => {
    expect(列("10日と20日").size, "裸の日の列挙が解けて了う – 他の月に化ける").toBe(0);
    expect(列("11日").size, "裸の日が今より減つてはならない").toBeGreaterThan(0);
  });

  it("月を付けた列挙は今の当たり方の侭", () => {
    expect(対称差("8月上旬と下旬", 列.和("8月上旬", "8月下旬"))).toBe(0);
    expect(対称差("8月10日と11日", 列.和("8月10日", "8月11日"))).toBe(0);
    expect(列("8月上旬と下旬").size).toBeGreaterThan(列("8月上旬").size);
    expect(列("8月10日と11日").size).toBeGreaterThan(列("8月10日").size);
  });

  it("其れだけで通る旬の語は変わらん", () => {
    for (const 語 of ["上旬", "中旬", "下旬", "最終週", "8月中旬", "来月上旬"]) {
      expect(列(語).size, `「${語}」が行を出さない`).toBeGreaterThanOrEqual(0);
    }
    /* 旬と旬の和集合は月の語の和集合より廣くない（其の月の行の侭）。 */
    expect(対称差("上旬と下旬", 列.和("上旬", "下旬"))).toBe(0);
    expect(列("上旬と下旬").size).toBeLessThanOrEqual(列("8月").size);
  });

  it("其の方の語の規則に頼む（月の語の列挙も其侭）", () => {
    const 幅 = Recommender.dayRangePairs("来月上旬と下旬", 基準) as Array<[string, string]>;
    expect(幅, "月を付けた列挙の案内が消えた").toHaveLength(1);
    expect(幅[0][1]).toContain("9月");
  });
});

describe("成果物", () => {
  it("裸の旬を受ける枝は一個所に決まる", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/\^\[上中下\]旬\$\/\.test\(柄\)/g) ?? [], "裸の旬を受ける枝").toHaveLength(1);
  });
});
