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
function 画面案内(文: string) {
  return (Recommender.uiWordNoteJa(文) || "").trim();
}
function 日の案内(文: string) {
  return (Recommender.relativeDayNotes(文, 基準) || []).join("|");
}

describe("年度・年の語にその切れ目の語を継いだ形がその月で絞れる（第 484 回）", () => {
  it("年度の語 – 継ぎ方を問はず同じ行に出る（実測 – 前はどれも 0 件だった）", () => {
    for (const [漢, 解] of [
      ["来年度末", "来年度 3月"],
      ["来年度 末", "来年度 3月"],
      ["来年度の末", "来年度 3月"],
      ["今年度末", "今年度 3月"],
      ["来年度初め", "来年度 4月"],
      ["来年度当初", "来年度 4月"],
    ] as Array<[string, string]>) {
      expect([漢, 対称差(列(漢), 列(解))]).toEqual([漢, 0]);
      expect(列(漢).size > 0, `「${漢}」が未だ 0 件`).toBe(true);
    }
    expect(列("来年度末").size).toBe(3);
    expect(列("今年度末").size).toBe(列("今年度 3月").size);
  });
  it("年の語 – 年末・年初・暦月を直に繋いだ形がその方の対と同じ行に出る", () => {
    for (const [漢, 解] of [
      ["来年末", "来年 12月"],
      ["今年末", "今年 12月"],
      ["来年初", "来年 1月"],
      ["来年12月", "来年 12月"],
      ["今年12月", "今年 12月"],
      ["来年1月", "来年 1月"],
    ] as Array<[string, string]>) {
      expect([漢, 対称差(列(漢), 列(解))]).toEqual([漢, 0]);
      expect(列(漢).size > 0, `「${漢}」が未だ 0 件`).toBe(true);
    }
    expect(列("今年末").size).toBe(84);
    expect(列("来年末").size).toBe(21);
  });
  it("その幅で絞れる形に「絞り込めません」の案内は並ばない", () => {
    for (const 文 of ["来年度末", "今年度末", "来年末", "今年末"]) {
      expect(画面案内(文), `「${文}」に案内が並んだ`).toBe("");
      /* その年の幅を名乗る案内は出る（その方の語がその年を決めている為 – その値は上に張つた）。*/
      expect(日の案内(文) !== "", `「${文}」の幅が案内に出ていない`).toBe(true);
    }
  });
});

describe("割らぬと決めた形（第 352 回・第 355 回・第 466 回）", () => {
  it("裸の年度のかたまりはその方の表が受け、その案内は其侭出る", () => {
    expect(列("年度末").size).toBeGreaterThan(0);

    expect(列("年度初め").size).toBe(31);
    expect(列("年度初め").size).toBe(列("年度 4月").size);
    expect(列("年度末").size).toBe(29);
    expect(画面案内("年度末")).toBe("");
    expect(列("年度末あたり").size).toBe(29);
    expect(列("年度初めから").size).toBe(50);
  });
  it("それより後の語尾が離つて控へる年は割らぬ（行を減らさぬ為 – 第 466 回・第 469 回）", () => {
    expect(列("今年1月 から").size).toBe(427);
    expect(列("今年1月から").size).toBe(427);
    expect(列("今年 1月 から").size).toBe(105);
    expect(列("今年1月 から").size).toBe(列("今年1月から").size);

    expect(日の案内("今年1月 から")).toContain("2026年1月1日以降のこと");
    expect(日の案内("今年1月 から")).not.toContain("絞り込まずにいます");
  });
  it("公用の決まりのない語は割らずに 0 件の侭（其旨をここに張る）", () => {
    for (const 文 of ["来年度頭", "来年前半", "来年頭", "今年後半", "来年序盤"]) {
      expect([文, 列(文).size]).toEqual([文, 0]);
    }
    expect(列("来年初旬").size).toBe(2);
    expect(列("来年初旬").size).toBe(列("来年 初旬").size);
  });
  it("第 470 回〜第 483 回の実測はこの回で変へて居ない", () => {
    expect(列("来月 末").size).toBe(178);
    expect(列("来週 末").size).toBe(34);
    expect(列("週 末").size).toBe(146);
    expect(列("月末").size).toBe(118);
    expect(列("明日以降").size).toBe(423);
    expect(列("来 上旬").size).toBe(68);
    expect(列("来月上旬").size).toBe(68);
    expect(列("ml から").size).toBe(0);
    expect(列("来月終わり").size).toBe(178);
    expect(列("来月初め").size).toBe(0);
    expect(画面案内("来月初め")).toContain("其の十日間（「上旬」）");
    expect(列("一 週間後").size).toBe(13);
    expect(列("半 年後").size).toBe(2);
    expect(列("締切時刻").size).toBe(181);
  });
});

describe("ビルド成果物に目がある事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("年度・年の切れ目の目と、それより後を守る後方照合が現れる", () => {
    /* その方の対と同じ読みをさせる四つの割る先（3月・4月・12月・1月）が、夫々一個ずつある事。*/
    for (const 先 of ["3月", "4月", "12月", "1月"]) {
      const 語 = `$1$2 ${先}");`;
      expect(物.split(語).length - 1, `割先「${先}」の数`).toBe(1);
    }
    expect(物).toContain("来|今|先|昨|翌)年度)[ \\u3000]*(?:の)?");
    /* 裸の年度を割らぬ決まり（頭の語を必須にしている事）。*/
    expect(物).not.toContain("(?:来|今|先|昨|翌)?年度)(?:末");
    /* それより後・それまでの語尾が控へる年+月を割らぬ後方照合。*/
    expect(物).toContain("(?![ \\u3000]*(?:から|より|以降|以後|この先|以来|までに|まで))");
  });
});
