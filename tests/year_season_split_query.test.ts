/* 第 489 回 – 年の語に旬を直に繋いだ形（`来年上旬` `今年下旬` `2027年上旬` `来年中頃`）
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、繋いだ側は 0 件で
 * 案内も無く、離した側は通つて居た – `来年上旬` **0 件** ⇔ `来年 上旬` 11 件・`来年中旬` **0 件** ⇔
 * 8 件・`来年下旬` **0 件** ⇔ 20 件・`来年初旬` **0 件** ⇔ 11 件・`今年上旬` **0 件** ⇔ 37 件・
 * `今年中旬` **0 件** ⇔ 74 件・`今年下旬` **0 件** ⇔ 92 件・`2027年上旬` **0 件** ⇔ 11 件・
 * `来年中頃` **0 件** ⇔ 8 件・`来年半ば` **0 件** ⇔ 8 件。語尾が控へる形も同じ（`来年上旬から`
 * **0 件** ⇔ `来年 上旬 から` 377 件・`来年下旬まで` **0 件** ⇔ 49 件）。
 *
 * 直しは其の年の語を割る目の列に旬（上旬・中旬・下旬・初旬・中頃・半ば）を足すだけ（其の方が既に
 * 二語で解ける形に揃べる – 第 453 回）。語尾が控へる形も**割る**（割ると増える方に行く – 第 487 回・
 * 第 488 回と同じ測り方。年の語＋暦月の目は逆に減るので其の方だけ語尾の除外を持つ）。
 *
 * **週の語は触らない** – `来週中旬` `今週上旬` は第 416 回・第 431 回・第 483 回の決まりで
 * 「其の週の中いつを指すかに公用の決まりが無い」として案内を出す側に在り、離して打つた形
 * （`来週 中旬` 52 件）が二語の交はりで出る事とは別の話（どちらへ揃へるかは其の方の回の話）。
 * 此の頁には其の侭を張る。
 *
 * **過ぎた年は品書に無い** – `去年上旬` は繋げても離しても 0 件（既定で過ぎた締切を除く – 行が
 * 無いのが正しい）。其れを 0 件の侭として張る。*/
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
function 案内(文: string) {
  return `${(Recommender.uiWordNoteJa(文) || "").trim()}|${(Recommender.relativeDayNotes(文, 基準) || []).join("/")}`;
}

describe("年の語に旬を直に繋いだ形が其の年 × 其の旬に解れる（第 489 回）", () => {
  it("繋いだ形が離した形と一字も違はない行・同じ案内になる", () => {
    for (const [繋, 離] of [
      ["来年上旬", "来年 上旬"],
      ["来年中旬", "来年 中旬"],
      ["来年下旬", "来年 下旬"],
      ["来年初旬", "来年 初旬"],
      ["来年中頃", "来年 中頃"],
      ["来年半ば", "来年 半ば"],
      ["今年上旬", "今年 上旬"],
      ["今年下旬", "今年 下旬"],
      ["2027年上旬", "2027年 上旬"],
      ["2027年半ば", "2027年 半ば"],
    ] as Array<[string, string]>) {
      expect([繋, 対称差(列(繋), 列(離))]).toEqual([繋, 0]);
      expect([繋, 案内(繋)], `「${繋}」の案内`).toEqual([繋, 案内(離)]);
    }
    /* 検査用ビルドの件数（実ビルド 868 行の値は頭の註に記す）– `来年下旬` だけは此の品書に
     * 2027 年度の下旬の締切が無い為 0 件（実ビルドは 20 件）で、行が無いのが正しい。*/
    for (const [文, 件] of [
      ["来年上旬", 2],
      ["来年中旬", 1],
      ["来年初旬", 2],
      ["来年中頃", 1],
      ["来年半ば", 1],
      ["今年上旬", 10],
      ["今年下旬", 58],
      ["2027年上旬", 2],
      ["2027年半ば", 1],
      ["来年下旬", 0],
    ] as Array<[string, number]>) {
      expect([文, 列(文).size]).toEqual([文, 件]);
    }
  });
  it("語尾が控へる形も割れる（其の年 ∧ 其の旬から／まで）", () => {
    for (const [繋, 離] of [
      ["来年上旬から", "来年 上旬 から"],
      ["来年下旬まで", "来年 下旬 まで"],
      ["今年中旬に", "今年 中旬 に"],
    ] as Array<[string, string]>) {
      expect([繋, 対称差(列(繋), 列(離))]).toEqual([繋, 0]);
      expect(列(繋).size > 0, `「${繋}」が未だ 0 件`).toBe(true);
    }
    /* 其の年の幅を名乗る（旬の方は行に在ら無くても年の案内は出る）。*/
    expect(案内("来年上旬")).toContain("2027年");
    expect(案内("今年下旬")).toContain("2026年");
  });
  it("行数の実測（固定ハーネスの品書 435 行 – 実ビルド 868 行の値は註に記す）", () => {
    /* 実ビルドでは `来年上旬` 11 件・`今年下旬` 92 件・`2027年上旬` 11 件・`来年上旬から` 377 件
     * （検査用ビルドの値は此處に張る）。*/
    expect(列("来年上旬").size).toBe(列("来年 上旬").size);
    expect(列("来年上旬から").size).toBe(103);
    expect(列("来年下旬まで").size).toBe(1);
    expect(列("今年中旬に").size).toBe(55);
    expect(列("来年上旬から").size).toBeGreaterThan(列("来年上旬").size);
  });
  it("週の語と過ぎた年は此の回で変へて居ない", () => {
    /* 週の語＋旬は第 490 回で年の語と同じく二語に割れるやうになつた（此の頁を書いた時は案内を
     * 出す側で、其の侭を張つて居た）。案内が殘るのは公用の決まりの無い前半・後半だけ。*/
    expect(列("来週中旬").size).toBe(列("来週 中旬").size);
    expect(列("来週中旬").size).toBeGreaterThan(0);
    expect(Recommender.uiWordNoteJa("来週中旬") || "").toBe("");
    expect(Recommender.uiWordNoteJa("来週前半") || "").toContain("週の語に前半・後半を繋げても");
    /* 過ぎた年は品書に無い（離しても 0 件 – 行が無いのが正しい）。*/
    expect(列("去年上旬").size).toBe(0);
    expect(列("去年 上旬").size).toBe(0);
  });
  it("第 470 回〜第 488 回の実測は此の回で変へて居ない", () => {
    expect(列("来年12月").size).toBe(21);
    expect(列("来年12月から").size).toBe(0);
    /* `来年度上旬` は検査用ビルドに 2028 年度の締切が無い為 0 件（実ビルドは 5 件）–
     * 離した形と同じである事で張る（第 488 回）。*/
    expect(列("来年度上旬").size).toBe(列("来年度 上旬").size);
    expect(列("来年度3月").size).toBe(1);
    expect(列("来月初め").size).toBe(0);
    expect(列("来月末").size).toBe(178);
    expect(列("来週 初旬").size).toBe(2);
    expect(列("週 末").size).toBe(145);
    expect(列("明日以降").size).toBe(422);
    expect(列("来 上旬").size).toBe(68);
    expect(列("来月上旬").size).toBe(68);
    expect(列("締切時刻").size).toBe(180);
    expect(列("半 年後").size).toBe(2);
    expect(列("一 週間後").size).toBe(13);
    expect(列("ml から").size).toBe(0);
    expect(列("今年1月から").size).toBe(426);
  });
});

describe("ビルド成果物に目が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("年の語＋旬の目が在り、年の語＋暦月の目とは別である", () => {
    expect(物).toContain("(?:来|今|去|明|昨|翌)年|[0-9]{4}年)(上旬|中旬|下旬|初旬|中頃|半ば)/g,");
    expect(物.split("(上旬|中旬|下旬|初旬|中頃|半ば)/g,").length - 1).toBe(1);
    /* 年の語＋暦月の目は語尾の除外を持つた侭（兩方の扱ひが違ふ事を張る）。*/
    expect(
      物.split("(?![ \\u3000]*(?:から|より|以降|以後|この先|以来|までに|まで))").length - 1,
    ).toBe(1);
  });
});
