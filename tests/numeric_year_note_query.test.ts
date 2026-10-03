/* 第 496 回 – 數字で書いた年（`2028年`）に、其の年の語と同じ幅の案内を出した
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、`2028年` は 0 件で
 * 案内も無く、同じ年を「再来年」と書けば「再来年 = 2028年の締切（1〜12 か月）」と出て居た –
 * **打ち方で案内が消える形**（第 332 回）。行が出る年（`2027年` 465 件）にも同じ文を書く – 其の年の語で
 * 書いた形（`来年` 465 件）が既に出して居るので、數字の側だけが黙つて居た。
 *
 * 行は一個も動かして居ない（案内だけの直し – 群 224 語で行の差 0 語・案内の差 91 語）。*/
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
function 日の案内(文: string) {
  return (Recommender.relativeDayNotes(文, 基準) || []).join("|");
}

describe("數字で書いた年に其の年の幅の案内が出る（第 496 回）", () => {
  it("行が在る年にも、無い年にも同じ文を書く", () => {
    for (const [文, 年] of [
      ["2026年", 2026],
      ["2027年", 2027],
      ["2028年", 2028],
      ["2029年", 2029],
      ["2025年", 2025],
    ] as Array<[string, number]>) {
      expect(日の案内(文), `「${文}」に年の幅の案内が無い`).toContain(
        `${年}年の締切（1〜12 か月）`,
      );
      expect(日の案内(文), `「${文}」の案内が打たれた語を名乗つて居ない`).toContain(文);
    }
  });
  it("其の年の語で書いた形と同じ文になる（打ち方で案内が消えない）", () => {
    /* 同じ年を言葉で書いた形（`再來年` = 2028年）は元から案内が出て居た。其れに揃へた。*/
    const 數字 = 日の案内("2028年")
      .split("|")
      .filter((節) => 節.includes("2028年"));
    const 言葉 = 日の案内("再来年")
      .split("|")
      .filter((節) => 節.includes("2028年"));
    expect(數字.length).toBeGreaterThan(0);
    expect(言葉.length).toBeGreaterThan(0);
    expect(數字[0]?.replace("2028年", "再来年")).toBe(言葉[0]);
  });
  it("品書に締切が無い年の形も、何も出ない理由が畫面に出る", () => {
    /* 第 495 回には 0 件で無言だつた形。*/
    expect(列("2028年").size).toBe(0);
    expect(日の案内("2028年")).toContain("2028年の締切（1〜12 か月）");
    expect(列("2028年3月から").size).toBe(0);
    expect(日の案内("2028年3月から")).toContain("2028年の締切（1〜12 か月）");
  });
  it("行は一個も動かして居ない（案内だけの直し）", () => {
    expect(列("2026年").size).toBe(427);
    expect(列("2027年").size).toBeGreaterThan(0);
    expect(列("2028年").size).toBe(0);
    expect(列("2026年1月から").size).toBe(427);
    expect(列("2027年12月から").size).toBe(21);
    expect(列("来年12月から").size).toBe(21);
    expect(列("今年1月から").size).toBe(427);
  });
  it("第 470 回〜第 495 回の実測は此の回で変へて居ない", () => {
    expect(列("来年上旬").size).toBe(2);
    expect(列("来週中旬").size).toBe(43);
    expect(列("年末上旬").size).toBe(40);
    expect(列("来月 末日").size).toBe(178);
    expect(列("週 末").size).toBe(146);
    expect(列("ml から").size).toBe(0);
    expect(列("締切時刻").size).toBe(181);
    expect(列("半 年後").size).toBe(2);
    expect(列("一 週間後").size).toBe(13);
  });
});

describe("ビルド成果物に目が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("數字の年に其の年の幅を書く枝が現れる", () => {
    expect(物).toContain("const 數字の年 = /^([0-9]{4})年$/.exec(key);");
    expect(物).toContain("年の締切（1〜12 か月）");
  });
});
