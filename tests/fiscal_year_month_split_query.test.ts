import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
function 品書(): string[] {
  return (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
}
const 全 = 品書();
function 列(文: string) {
  return new Set(全.filter((行) => Recommender.searchMatcher(文, 基準)(行) === true));
}
function 対称差(左: Set<string>, 右: Set<string>): number {
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}
function 日の案内(文: string) {
  return (Recommender.relativeDayNotes(文, 基準) || []).join("|");
}
function 噓(文: string) {
  return 日の案内(文).includes("絞り込まずにいます") && 列(文).size > 0;
}

describe("年度の語に暦月を直に繋いだ形がその年度 ∧ その月に解れる（第 487 回）", () => {
  it("継いだ形が空格で並べた形と一字も違わない行に出る", () => {
    for (const [繋, 離] of [
      ["来年度3月", "来年度 3月"],
      ["今年度3月", "今年度 3月"],
      ["来年度12月", "来年度 12月"],
      ["来年度4月", "来年度 4月"],
      ["来年度一月", "来年度 一月"],
    ] as Array<[string, string]>) {
      expect([繋, 対称差(列(繋), 列(離))]).toEqual([繋, 0]);
      expect(列(繋).size > 0, `「${繋}」が未だ 0 件`).toBe(true);
    }
  });
  it("それより後・それまでの語尾を続けた形も割れる（年の語では割らぬ – 実測の違い）", () => {
    for (const [繋, 離] of [
      ["来年度3月から", "来年度 3月から"],
      ["来年度12月まで", "来年度 12月まで"],
      ["今年度3月以降", "今年度 3月以降"],
    ] as Array<[string, string]>) {
      expect([繋, 対称差(列(繋), 列(離))]).toEqual([繋, 0]);
      expect(列(繋).size > 0, `「${繋}」が未だ 0 件`).toBe(true);
    }
    /* その方の語はその年度の幅を名乗る（それ以前の「絞り込みません」の文は並ばない）。*/
    expect(日の案内("来年度3月から")).toContain("来年度 = 2027年4月1日(木)〜2028年3月31日(金)");
    for (const 文 of ["来年度3月から", "来年度12月まで", "来年度3月", "今年度3月"]) {
      expect(噓(文), `「${文}」に行と食い違う案内が並んだ`).toBe(false);
    }
  });
  it("行数の実測（固定ハーネスの品書 435 行）", () => {
    expect(列("来年度3月").size).toBe(3);
    expect(列("今年度3月").size).toBe(29);
    expect(列("来年度12月").size).toBe(11);
    expect(列("来年度3月から").size).toBe(50);
    expect(列("来年度12月まで").size).toBe(44); // 2026-10-18 から「12月まで」は今月から 12 月末までの幅
    /* その月を含まぬ年度の語はその侭（`来年度` 48 件 ⊇ `来年度3月` 1 件）。*/
    expect(列("来年度").size).toBe(50);
    expect([...列("来年度3月")].every((行) => 列("来年度").has(行))).toBe(true);
  });
});

describe("其它の形は動かして居ない（第 352 回・第 484 回・第 485 回）", () => {
  it("年度のかたまりの対と、その方で解ける年は其侭", () => {
    expect(列("来年度末").size).toBe(3);
    expect(列("来年度初め").size).toBe(31);
    expect(列("来年度中").size).toBe(50);
    expect(列("今年1月から").size).toBe(427);
    expect(日の案内("今年1月から")).toContain("2026年1月1日以降のこと（その年の中まで）");

    expect(列("来年12月から").size).toBe(21);
    expect(列("来年12月から").size).toBe(列("来年 12月から").size);
    /* 案内はその年の幅（先の年は第 493 回に割る目を入れたので、月まで名乗る案内は出ない）。*/
    expect(日の案内("来年12月から")).toContain("来年 = 2027年");
    expect(噓("来年12月から")).toBe(false);
  });
  it("その方が本当に解けぬ形は、今まで通りの導きが出る（その文を張る）", () => {
    for (const 文 of ["来年前半から", "100万年前から"]) {
      expect(列(文).size, `「${文}」が行を出すやうになつた`).toBe(0);
      expect(日の案内(文), `「${文}」の導きが消えた`).toContain("検索欄では絞り込まずにいます");
    }
    expect(列("来年度頭").size).toBe(0);
  });
  it("第 470 回〜第 485 回の実測はこの回で変へて居ない", () => {
    expect(列("来月 末").size).toBe(178);
    expect(列("週 末").size).toBe(146);
    expect(列("来週 初旬").size).toBe(2);
    expect(列("明日以降").size).toBe(423);
    expect(列("来 上旬").size).toBe(68);
    expect(列("来月上旬").size).toBe(68);
    expect(列("締切時刻").size).toBe(181);
    expect(列("来月初め").size).toBe(0);
    expect(列("来年末").size).toBe(21);
    expect(列("来年初").size).toBe(23);
    expect(列("半 年後").size).toBe(2);
    expect(列("一 週間後").size).toBe(13);
    expect(列("ml から").size).toBe(0);
    expect(列("来週から").size).toBe(423);
  });
});

describe("ビルド成果物に目がある事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("年度を割る目と、年を割る目の語尾の扱いが別々である", () => {
    /* 年の語の目（語尾が控へる形を割らぬ）は一個、年度の語の目（語尾を問はぬ）は一個。*/
    expect(
      物.split("(?![ \\u3000]*(?:から|より|以降|以後|この先|以来|までに|まで))").length - 1,
    ).toBe(1);
    expect(
      物.split(
        "((?:来|今|先|昨|翌)年度)([0-9]{1,2}月|[〇一二三四五六七八九十]{1,3}月|上旬|中旬|下旬|初旬)/g,",
      ).length - 1,
    ).toBe(1);
    expect(物).toContain("(?:来|今|去|明|昨|翌)年)([0-9]{1,2}月");
  });
});
