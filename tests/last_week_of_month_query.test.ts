import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  return Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
}

function 当たり列表(語: string): string[] {
  const 当 = Recommender.searchMatcher(語, 基準);
  return 品書()
    .filter((行) => 当(String(行.hay)) === true)
    .map((行) => String(行.hay))
    .sort();
}

function 対称差(甲: string, 乙: string): number {
  const 左 = new Set(当たり列表(甲));
  const 右 = new Set(当たり列表(乙));
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}

function 対称差和(語: string, 内: string[]): number {
  const 左 = new Set(当たり列表(語));
  const 右 = new Set<string>();
  for (const 内語 of 内) for (const 行 of 当たり列表(内語)) 右.add(行);
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}

function 案内組(語: string): Array<[string, string]> {
  const 関数 = (
    Recommender as unknown as Record<string, (語: string, 時刻: number) => Array<[string, string]>>
  ).dayRangePairs;
  return 関数(語, 基準);
}

describe("その月の最終週", () => {
  it("最終週はその月の末日を含む週として受ける（その月の第五週と同じ列表）", () => {
    expect(当たり列表("8月最終週").length, "品書にその方の週の行がない").toBeGreaterThan(0);
    expect(対称差("8月最終週", "8月第5週")).toBe(0);
    expect(対称差("8月最後の週", "8月最終週")).toBe(0);
    expect(対称差("今月最終週", "8月第5週")).toBe(0);
    expect(対称差("最終週", "8月第5週")).toBe(0);
    expect(対称差("8月の最終週", "8月最終週")).toBe(0);
    expect(対称差("2026年8月最終週", "8月最終週")).toBe(0);
  });

  it("今月ではない月を名乗った形もその月の最終週で受ける", () => {
    expect(対称差("来月最終週", "2026年9月第5週")).toBe(0);
    expect(当たり列表("来月最終週").length, "継いだ月の最終週が行を出さない").toBeGreaterThan(0);
    /* 28 日の月には第五週が在らない – 最終週はその月の第四週と同じになる
     * （その方の月にある塊で受ける – 黙って幅を作らない決まりは第 389 回と同じ）。 */
    expect(対称差("2027年2月最終週", "2027年2月第4週")).toBe(0);
    expect(当たり列表("2027年2月最終週").length, "品書にその月の行がない").toBeGreaterThan(0);
  });

  it("最終週を片側に混んだ幅も解ける", () => {
    expect(案内組("8月上旬から最終週")).toEqual([
      ["8月上旬から最終週", "2026年8月1日から2026年8月31日"],
    ]);
    expect(当たり列表("8月上旬から最終週").length).toBeGreaterThan(0);
    expect(案内組("来月上旬から最終週")).toEqual([
      ["来月上旬から最終週", "2026年9月1日から2026年9月30日"],
    ]);
    /* 冠の無い最終週は幅の頭側の月を継ぐ（`来月上旬から中旬` と同じ決まり）。 */
    expect(案内組("8月最終週から9月第1週")).toEqual([
      ["8月最終週から9月第1週", "2026年8月29日から2026年9月7日"],
    ]);
  });

  it("列挙に混ぜた形も和集合で、案内に並べた塊を書く", () => {
    expect(対称差和("8月上旬と8月最終週", ["8月上旬", "8月最終週"])).toBe(0);
    expect(案内組("8月上旬と8月最終週")).toEqual([
      ["8月上旬と8月最終週", "2026年8月1日または2026年8月29日"],
    ]);
    expect(対称差和("8月最終週と9月上旬", ["8月最終週", "2026年9月上旬"])).toBe(0);
    /* 裸の最終週は先頭の語の月へ継ぐ（裸の旬と同じ決まり – 第 395 回）。 */
    expect(対称差和("8月10日と最終週", ["2026年8月10日", "8月最終週"])).toBe(0);
    expect(案内組("8月10日と最終週")).toEqual([
      ["8月10日と最終週", "2026年8月10日または2026年8月29日"],
    ]);
    /* 継いだ月はその列挙の頭が名乗った月 – 今月に化けない。 */
    expect(対称差和("2026年12月10日と最終週", ["2026年12月10日", "2026年12月最終週"])).toBe(0);
    expect(案内組("2026年12月10日と最終週")).toEqual([
      ["2026年12月10日と最終週", "2026年12月10日または2026年12月29日"],
    ]);
    expect(当たり列表("2026年12月10日").length, "品書にその方の日の行がない").toBeGreaterThan(0);
    expect(対称差和("8月下旬、最終週", ["8月下旬", "8月最終週"])).toBe(0);
    expect(案内組("8月下旬、最終週")).toEqual([
      ["8月下旬、最終週", "2026年8月21日または2026年8月29日"],
    ]);
  });
});

describe("それ以外の月の語は無傷", () => {
  it("月の中之週・旬・月末の形は其侭通る", () => {
    expect(当たり列表("8月第1週").length).toBeGreaterThan(0);
    expect(当たり列表("8月第4週").length).toBeGreaterThan(0);
    expect(当たり列表("今月第1週").length).toBeGreaterThan(0);
    expect(当たり列表("8月下旬").length).toBeGreaterThan(0);
    expect(対称差和("8月上旬と8月下旬", ["8月上旬", "8月下旬"])).toBe(0);
    expect(案内組("8月下旬から9月上旬")).toEqual([
      ["8月下旬から9月上旬", "2026年8月21日から2026年9月10日"],
    ]);
    /* 「月末の週」の様な形は解かない – その方の語は最終週では無い（締切の推測はしない）。 */
    expect(案内組("8月末の週")).toEqual([]);
    expect(当たり列表("8月末の週")).toEqual([]);
    expect(当たり列表("今月末").length).toBeGreaterThan(0);
  });
});

describe("成果物", () => {
  it("最終週がその月の末日から塊を決める処が実測どおりに成果物に入っている", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/const 最終週か = \/\^\(\?:最終週\|最後の週\)\$\//g) ?? []).toHaveLength(1);
    expect(物.match(/if \(!days && !最終週か\)/g) ?? []).toHaveLength(1);
    expect(物.match(/Math\.ceil\(末日 \/ 7\) - 1/g) ?? []).toHaveLength(1);

    expect(物.match(/最終週\|最後の週/g) ?? []).toHaveLength(7);
  });
});
