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

describe("年＋中／内がその年の語と同じ行に出る（第 500 回）", () => {
  it("年の語＋内と、数字の年＋中／内", () => {
    for (const [繋, 素] of [
      ["今年内", "今年"],
      ["来年内", "来年"],
      ["再来年内", "再来年"],
      ["去年内", "去年"],
      ["2026年中", "2026年"],
      ["2026年内", "2026年"],
      ["2027年中", "2027年"],
      ["2027年内", "2027年"],
      ["2028年内", "2028年"],
    ] as Array<[string, string]>) {
      expect([繋, 対称差(列(繋), 列(素))], `「${繋}」が「${素}」と違ふ`).toEqual([繋, 0]);
      expect([繋, 日の案内(繋)], `「${繋}」の案内が違ふ`).toEqual([繋, 日の案内(素)]);
    }
    /* 検査用ビルドの件数（実ビルドは 今年 796・来年 465）。*/
    expect(列("今年内").size).toBe(427);
    expect(列("来年内").size).toBe(114);
    expect(列("2026年中").size).toBe(427);
    expect(列("2027年内").size).toBe(114);
  });
  it("語が続く形も同じ", () => {
    for (const [繋, 素] of [
      ["今年内の締切", "今年の締切"],
      ["2026年中に", "2026年に"],
      ["2027年内に", "2027年に"],
    ] as Array<[string, string]>) {
      expect([繋, 対称差(列(繋), 列(素))], `「${繋}」が「${素}」と違ふ`).toEqual([繋, 0]);
    }
  });
  it("元号の年＋中／内も同じ（第 501 回）", () => {
    for (const [繋, 素] of [
      ["令和8年中", "令和8年"],
      ["令和8年内", "令和8年"],
      ["令和9年中", "令和9年"],
      ["令和9年内", "令和9年"],
      ["令和九年中", "令和九年"],
      ["平成30年内", "平成30年"],
    ] as Array<[string, string]>) {
      expect([繋, 対称差(列(繋), 列(素))], `「${繋}」が「${素}」と違ふ`).toEqual([繋, 0]);
    }
    expect(列("令和8年内").size).toBe(列("今年内").size);
    expect(列("令和9年中").size).toBe(列("来年内").size);
  });
  it("裸の年内と月の内はこの回で変へて居ない（第 427 回の決まり）", () => {
    /* `年内` は今月から 12 月まで（779 件・実ビルド）。月の側の寄せ（今月内 = 今月中）もその侭。*/
    expect(列("年内").size).toBe(425);
    expect(対称差(列("今月内"), 列("今月中"))).toBe(0);
    expect(列("今年中").size).toBe(列("今年").size);
  });
  it("第 470 回〜第 499 回の実測はこの回で変へて居ない", () => {
    expect(列("今年1月から").size).toBe(427);
    expect(列("来年12月から").size).toBe(21);
    expect(列("2027年12月から").size).toBe(21);
    expect(列("令和九年12月").size).toBe(21);
    expect(列("2028年3月").size).toBe(0);
    expect(列("来年上旬").size).toBe(2);
    expect(列("来週中旬").size).toBe(43);
    expect(列("年末上旬").size).toBe(40);
    expect(列("来月 末日").size).toBe(178);
    expect(列("週 末").size).toBe(146);
    expect(列("ml から").size).toBe(0);
    expect(列("締切時刻").size).toBe(181);
  });
});

describe("ビルド成果物に目がある事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("年＋内と数字の年＋中を寄せる目が現れる", () => {
    /* 第 501 回に元号の年もこの二つの目へ入れた（`令和8年中` `令和9年内`）。*/
    expect(物).toContain("|[0-9]{4}年|(?:明治|大正|昭和|平成|令和)");
    expect(物).toContain(")内/g,");
    expect(物).toContain("|[0-9]{4}年|(?:明治|大正|昭和|平成|令和)");
    expect(物).toContain(")中/g,");
  });
});
