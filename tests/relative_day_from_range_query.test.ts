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
function 案内(文: string) {
  return Recommender.relativeDayNotes(文, 基準).join("|");
}

describe("それより後の語 `から` `より` を続けた形がその初日から絞れる（第 476 回）", () => {
  it("離つて打つ形・詰め形・その他の語を継いだ形が同じ行に出る", () => {
    for (const [離, 繋] of [
      ["来週 から", "来週から"],
      ["明日 から", "明日から"],
      ["来週 より", "来週より"],
      ["来月 から", "来月から"],
      ["上旬 から", "上旬から"],
      ["3か月後 から", "3か月後から"],
      ["来月 上旬 から", "来月上旬から"],
      ["来月上旬 から", "来月上旬から"],
    ] as Array<[string, string]>) {
      expect([離, 列(離).size]).toEqual([離, 列(繋).size]);
      expect([離, 列(離).size > 100]).toEqual([離, true]);
    }
  });
  it("行数の実測（固定ハーネスの品書 435 行 – 前はこの内すべて 0 件だった）", () => {
    expect(列("今日から").size).toBe(423);
    expect(列("明日から").size).toBe(423);
    expect(列("来週から").size).toBe(423);
    expect(列("上旬から").size).toBe(425);
    expect(列("中旬から").size).toBe(423);
    expect(列("下旬から").size).toBe(414);
    expect(列("来月上旬から").size).toBe(389);
    expect(列("22日より").size).toBe(395);
    expect(列("3日後から").size).toBe(423);
    expect(列("1か月前から").size).toBe(427);
    expect(列("今年度から").size).toBe(427);
    expect(列("来年から").size).toBe(114);
  });
  it("幅で絞れる形は件の数欄が「並びます」と嘘を書かない", () => {
    for (const 文 of ["明日から", "来週から", "上旬から", "来月上旬から", "今年度から"]) {
      expect(案内(文), `「${文}」に案内が残つた`).toBe("");
      expect([文, 列(文).size > 0]).toEqual([文, true]);
    }
  });
});

describe("離って打った開いた幅は詰め形と同じ機械を読む（第 373 回・第 455 回・第 476 回）", () => {
  it("十三の対が詰め形と一字も違わない行に出る", () => {
    for (const [離, 繋] of [
      ["明日 から 明後日", "明日から明後日"],
      ["来週 から 来月", "来週から来月"],
      ["明日 から 3日", "明日から3日"],
      ["3日後 から 1週間後", "3日後から1週間後"],
      ["下旬 から 中旬", "下旬から中旬"],
      ["来週 から 一週間", "来週から一週間"],
      ["9月上旬から 中旬", "9月上旬から中旬"],
      ["9 月 上旬 から 中旬", "9月上旬から中旬"],
      ["来月上旬 から 来月中旬", "来月上旬から来月中旬"],
      ["8月 から 9月", "8月から9月"],
      ["来月 から 再来月", "来月から再来月"],
      ["8月10日 から 8月20日", "8月10日から8月20日"],
      ["明日から 5日間", "明日から5日間"],
    ] as Array<[string, string]>) {
      expect([離, 列(離).size]).toEqual([離, 列(繋).size]);
    }
    /* 終りが決まる形なので、幅の外の行を勝手に呑まない（実測 – 明日から明後日は二日ぶん）。*/
    expect(列("明日 から 明後日").size).toBe(4);
    expect(列("明日 から 明後日").size).toBeLessThan(列("明日から").size);
  });
  it("列挙の形はその侭別の文に書く（幅の継ぎとは別の機械）", () => {
    expect(案内("下旬 又は 上旬")).toContain("下旬 = 2026年8月21日(金)");
    expect(案内("下旬 又は 上旬")).toContain("上旬 = 2026年8月1日(土)");
  });
});

describe("寄せない形の守り（第 355 回・第 453 回・第 463 回）", () => {
  it("日の語でない物には `から` を寄せない（案内の導きが其侭出る）", () => {
    expect(列("ml から").size).toBe(0);
    expect(列("論文から").size).toBe(0);
    expect(列("ml から 論文").size).toBe(0);
    /* 過去向きの語は幅を作らない（締切の推測はしない – 第 367 回）。*/
    expect(列("100万年前から").size).toBe(0);
    expect(案内("100万年前から")).toContain("それより後の締切のことだと思いますが");

    expect(列("1 年後から").size).toBe(1); /* 実ビルド 868 行では 41 件（固定ハーネスは 1 件）*/
  });
  it("詰め形其身は動かして居ない（他の頁で張る実測の値は其侭）", () => {
    expect(列("明日以降").size).toBe(423);
    expect(列("来月 上旬 まで").size).toBe(180);
    expect(列("週 末").size).toBe(146);
    expect(列("8月から").size).toBe(425);
    expect(案内("17時 以降")).toContain("17時 以降 = 17:00〜23:59");
  });
  it("第 470 回〜第 475 回の実測はこの回で変へて居ない", () => {
    expect(列("8 月の 締切").size).toBe(114);
    expect(列("来 週末").size).toBe(34);
    expect(案内("来 週末")).toContain("来週末 = 2026年8月15日(土)");
    expect(列("来 上旬").size).toBe(68);
    expect(列("来 月中").size).toBe(178);
    expect(列("2月30日以降").size).toBe(0);
  });
});

describe("ビルド成果物に目がある事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("二つの継ぎ目が現れ、効かぬ目は落た事が見える", () => {
    expect(物.match(/開いた幅の尾Ja/g)?.length).toBe(undefined);
    expect(物.match(/塊の語から幅の終りJa/g)?.length).toBe(undefined);
    expect(物.match(/離した幅の区切りJa/g)?.length).toBe(2);
    expect(物.match(/繋がれた幅の尾Ja/g)?.length).toBe(2);
    expect(物).toContain("日の語か");
  });
  it("前の五回の目の字面を壊して居ない", () => {
    expect(物.match(/複合語の切れ目/g)?.length).toBe(2);
    expect(物.match(/其の日以降の初日Ja/g)?.length).toBe(3);
    expect(物.match(/単位に付いた助字/g)?.length).toBe(2);
    expect(物.match(/月の付いた塊/g)?.length).toBe(3);
  });
});
