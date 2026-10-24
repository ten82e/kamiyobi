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
function 対稱差(左: Set<string>, 右: Set<string>): number {
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}
function 日の案内(文: string) {
  return (Recommender.relativeDayNotes(文, 基準) || []).join("|");
}

describe("年度の語に旬を直に繋いだ形がその年度 × その旬に解れる（第 488 回）", () => {
  it("繋いだ形と空格で並べた形が同じ行・同じ案内になる（実ビルドの値も注に記す）", () => {
    for (const [繋, 離] of [
      ["来年度上旬", "来年度 上旬"],
      ["来年度中旬", "来年度 中旬"],
      ["来年度下旬", "来年度 下旬"],
      ["来年度初旬", "来年度 初旬"],
      ["今年度上旬", "今年度 上旬"],
      ["今年度下旬", "今年度 下旬"],
    ] as Array<[string, string]>) {
      expect([繋, 対稱差(列(繋), 列(離))]).toEqual([繋, 0]);
      expect([繋, 日の案内(繋)], `「${繋}」の案内`).toEqual([繋, 日の案内(離)]);
      /* その年度を名乗る（句の方は行に無くても年度の幅は出す）。*/
      expect(日の案内(繋), `「${繋}」が其の年度を名乗つて居ない`).toContain("年4月1日");
    }
  });
  it("行数の実測（固定ハーネスの品書 435 行 – 実ビルド 868 行の値は注に記す）", () => {
    /* 検査用ビルドでは 2027 年度・2028 年度の締切が少ない為、来年度の旬は 0 行になる
     * （実ビルドでは `来年度上旬` 5 件・`来年度中旬` 1 件・`来年度下旬` 9 件・`来年度初旬` 5 件）。
     * 今年度の旬はこの品書にもある。*/
    expect(列("今年度上旬").size).toBe(10);
    expect(列("今年度下旬").size).toBe(列("今年度 下旬").size);
    expect(列("来年度上旬").size).toBe(0);
    expect(列("来年度初旬").size).toBe(列("来年度 初旬").size);
  });
  it("公用の決まりのない語は割らない（その侭 0 件 – 第 355 回）", () => {
    for (const 文 of ["来年度前半", "来年度後半", "来年度頭", "来年度序盤"]) {
      expect([文, 列(文).size]).toEqual([文, 0]);
    }
    /* 前半は離して打つても 0 件（その方が幅を決めて居ない – 案内も出さない）。*/
    expect(列("来年度 前半").size).toBe(0);
  });
  it("残した差 – 数字の年で書いた形だけが 0 件の侭（先の年の語は第 493 回で直つた）", () => {
    expect(列("来年12月から").size).toBe(21);
    expect(列("来年12月から").size).toBe(列("来年 12月から").size);
    /* 第 495 回に数字の先の年も割る目を入れたので、そちらも離した形と同じ行が出る。*/
    expect(列("2027年12月から").size).toBe(21);
    expect(列("2027年12月から").size).toBe(列("2027年 12月から").size);
    /* 年の語の語尾付きの形で行が出る物（この方は語を割らずに解けている – 第 485 回）。*/
    expect(列("今年1月から").size).toBe(427);
    expect(日の案内("今年1月から")).toContain("2026年1月1日以降のこと");
  });
  it("第 470 回〜第 487 回の実測はこの回で変へて居ない", () => {
    expect(列("来年度末").size).toBe(3);
    expect(列("来年度中").size).toBe(50);
    expect(列("来年度 3月").size).toBe(3);
    expect(列("来年度3月").size).toBe(3);
    expect(列("来月初め").size).toBe(0);
    expect(列("来月末").size).toBe(178);
    expect(列("来週 初旬").size).toBe(2);
    expect(列("週 末").size).toBe(146);
    expect(列("明日以降").size).toBe(423);
    expect(列("来 上旬").size).toBe(68);
    expect(列("締切時刻").size).toBe(181);
    expect(列("半 年後").size).toBe(2);
    expect(列("一 週間後").size).toBe(13);
    expect(列("ml から").size).toBe(0);
  });
});

describe("ビルド成果物に目がある事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("年度を割る目の列に旬が入つている", () => {
    expect(物).toContain("|上旬|中旬|下旬|初旬)/g,");
    expect(物.split("|上旬|中旬|下旬|初旬)/g,").length - 1).toBe(1);
    /* 年の語の目（語尾が控へる形を割らぬ）はその侭である事。*/
    expect(
      物.split("(?![ \\u3000]*(?:から|より|以降|以後|この先|以来|までに|まで))").length - 1,
    ).toBe(1);
  });
});
