/* 第 497 回 – 語尾の無い「年＋暦月」（`2028年3月` `再来年3月` `2027年3月`）に、其の年の幅の案内を出した
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、此の形は其の方
 *（離して打つた形）と**行は同じ**なのに案内だけが消えて居た – `2028年3月` **0 件で無言** ⇔
 * `2028年 3月` 0 件＋「2028年 = 2028年の締切（1〜12 か月）」・`再来年3月` **0 件で無言** ⇔
 * `再来年 3月` 同じ案内・`2027年3月` **82 件で無言** ⇔ `2027年 3月` 82 件＋「2027年 = …」
 *（其の年の語は第 487 回から此の列に在るので、`来年3月` は 82 件＋案内が出て居た – 數字と再来年だけが
 * 抜けて居た）。
 *
 * 直しは、其の年の語を割る列に**再来年と數字の年**を足すだけ（別の目にした – 語尾の控へる形は第 495 回の
 * 目が、日の続く形（`2027年8月10日頃`）と週の數（`2027年2月第5週`）は其方の目が受けるので、其れ等を
 * 外す見張りを付けた）。**行は一個も動かして居ない** – 群 547 語で行の差 0 語・案内の差 24 語・
 * 0 件で無言 0 → 0 語。*/
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

describe("語尾の無い年＋暦月にも其の年の幅の案内が出る（第 497 回）", () => {
  it("繋いだ形と離した形で、行も案内も揃ふ", () => {
    for (const [繋, 離] of [
      ["2028年3月", "2028年 3月"],
      ["2027年3月", "2027年 3月"],
      ["2026年3月", "2026年 3月"],
      ["2026年12月", "2026年 12月"],
      ["2028年12月", "2028年 12月"],
      ["2029年1月", "2029年 1月"],
      ["再来年3月", "再来年 3月"],
    ] as Array<[string, string]>) {
      expect([繋, 対称差(列(繋), 列(離))], `「${繋}」が「${離}」と違ふ`).toEqual([繋, 0]);
      expect([繋, 日の案内(繋)], `「${繋}」の案内が違ふ`).toEqual([繋, 日の案内(離)]);
      /* 年の幅を名乗る（其の年の語で書いた形と同じ文）。*/
      expect(日の案内(繋), `「${繋}」に年の幅が無い`).toContain("年の締切（1〜12 か月）");
    }
  });
  it("品書に締切が無い月でも、何も出ない理由が畫面に出る", () => {
    expect(列("2028年3月").size).toBe(0);
    expect(日の案内("2028年3月")).toContain("2028年の締切（1〜12 か月）");
    expect(日の案内("2028年3月")).not.toContain("絞り込まずにいます");
  });
  it("日の続く形と週の數は此の目で割らない（其方の目が受ける）", () => {
    /* `2027年8月10日頃` は其の方の案内（其の日の幅）を保つ。`2027年2月第5週` は幅を作らず無言。*/
    expect(日の案内("2027年8月10日頃")).toContain("2027年8月10日");
    expect(日の案内("2027年8月10日頃")).not.toContain("年の締切（1〜12 か月）");
    expect(日の案内("2027年2月第5週")).toBe("");
    expect(列("2027年2月第5週").size).toBe(0);
  });
  it("行は一個も動かして居ない（案内だけの直し）", () => {
    expect(列("2027年3月").size).toBe(28);
    expect(列("2026年12月").size).toBe(84);
    expect(列("2028年3月").size).toBe(0);
    expect(列("来年3月").size).toBe(列("来年 3月").size);
    expect(列("今年3月").size).toBe(列("今年 3月").size);
  });
  it("第 470 回〜第 496 回の実測は此の回で変へて居ない", () => {
    expect(列("2027年12月から").size).toBe(21);
    expect(列("2028年3月から").size).toBe(0);
    expect(列("来年12月から").size).toBe(21);
    expect(列("今年1月から").size).toBe(426);
    expect(列("2026年1月から").size).toBe(426);
    expect(列("2028年").size).toBe(0);
    expect(列("来年上旬").size).toBe(2);
    expect(列("来週中旬").size).toBe(43);
    expect(列("年末上旬").size).toBe(40);
    expect(列("来月 末日").size).toBe(178);
    expect(列("週 末").size).toBe(145);
    expect(列("ml から").size).toBe(0);
    expect(列("締切時刻").size).toBe(180);
  });
});

describe("ビルド成果物に目が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("再来年と數字の年を割る目が、日の形と週の數を外す見張り付きで現れる", () => {
    expect(物).toContain(
      "((?:再来年|[0-9]{4}年))([0-9]{1,2}月|[〇一二三四五六七八九十]{1,3}月)(?![0-9]{1,2}日|[0-9第])",
    );
    /* 今の年の語の列（第 487 回）は觸つて居ない。*/
    expect(物).toContain(
      "((?:来|今|去|明|昨|翌)年)([0-9]{1,2}月|[〇一二三四五六七八九十]{1,3}月)(?![ \\u3000]*(?:から|より|以降",
    );
  });
});
