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
  return Recommender.relativeDayNotes(文, 基準).join("|");
}

describe("頭と単位を離つて打った半年の語が詰め形と同じ行に出る（第 480 回）", () => {
  it("四の対が詰め形と一字も違わない行に出る（実測 – 前は離つた側が 0 行だった）", () => {
    for (const [離, 繋] of [
      ["半 年後", "半年後"],
      ["半 年前", "半年前"],
      ["半 年後に", "半年後に"],
      ["半 年後 まで", "半年後まで"],
    ] as Array<[string, string]>) {
      expect([離, 対称差(列(離), 列(繋))]).toEqual([離, 0]);
      expect([離, 列(離).size > 0]).toEqual([離, true]);
    }
  });
  it("行数の実測（固定ハーネスの品書 435 行）", () => {
    expect(列("半 年後").size).toBe(2);
    expect(列("半 年前").size).toBe(2);
    expect(列("半 年後に").size).toBe(2);
    expect(列("半 年後 まで").size).toBe(433);
    expect(列("半年後").size).toBe(2);
    expect(列("半年後まで").size).toBe(433);
  });
  it("件数欄は打たれた空格の侭を名乗り、その日を書く（第 459 回・第 332 回）", () => {
    expect(案内("半 年後")).toContain("半 年後 = 2027年2月9日(火)");
    expect(案内("半 年前")).toContain("半 年前 = 2026年2月9日(月)");
    expect(案内("半 年後 まで")).toContain("半 年後 まで = 2026年8月9日(日)〜2027年");
  });
});

describe("寄せない形の実測（第 453 回・第 466 回）", () => {
  it("三つに割れた形は日の語に寄せない – 範囲の欄が受ける語の侭行を出す", () => {
    /* 実測 – `半年 後` を日の語 `半年後` に寄せると 15 行 → 2 行に減る（その決まりを別の頁でも
     * 張つている）。その門は『半』を一語として離つた形に限定した。`半 年 後`（三つに割る）は
     * この目を入れても入れなくも 0 行の侭（実測 – 変はつて居ない）。*/
    expect(列("半年 後").size).toBe(15);
    expect(案内("半年 後")).toContain("半年 = 2026年8月9日(日)〜2027年2月5日(金)");
    expect(列("半 年 後").size).toBe(0);
    expect(列("半 年").size).toBe(0);
  });
  it("その方の表が既に受ける形と解けぬ語は動かして居ない", () => {
    expect(列("半 か月後").size).toBe(4);
    expect(列("半月後").size).toBe(4);
    expect(列("半 週間後").size).toBe(0);
    expect(列("半週間後").size).toBe(0);

    expect(列("一 週間後").size).toBe(13);
    expect(列("一週間後").size).toBe(13);
  });
  it("第 470 回〜第 479 回の実測はこの回で変へて居ない", () => {
    expect(列("締切時刻").size).toBe(181);
    expect(列("来月 終わり").size).toBe(178);
    expect(列("週 末").size).toBe(146);
    expect(列("ml から").size).toBe(0);
    expect(列("明日以降").size).toBe(423);
    expect(列("来 上旬").size).toBe(68);
    expect(列("来月 下旬 まで").size).toBe(276);
    expect(列("明日 から 明後日").size).toBe(4);
    expect(列("1 年後から").size).toBe(1);
  });
});

describe("ビルド成果物に目がある事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("寄せの門が二語の形に限つて現れる", () => {
    expect(物.match(/\^半年\(\?:後\|前\)\$/g)?.length).toBe(undefined);
    expect(物).toContain('前 === "半"');
    expect(物).toContain("/^(?:年後|年前)$/");
    /* その方の表（裸の半年を載せぬ決まり）は其侭 – 載せ替へて居ない事の実測。*/
    expect(物).toContain("半(?:月|か月|ヶ月|ケ月|カ月|ヵ月|箇月)");
    expect(物).not.toContain("半(?:月|か月|ヶ月|ケ月|カ月|ヵ月|箇月|年)");
  });
  it("前の八回の目の字面を壊して居ない", () => {
    expect(物.match(/語の連なりJa/g)?.length).toBe(2);
    expect(物.match(/離した幅の区切りJa/g)?.length).toBe(2);
    expect(物.match(/繋がれた幅の尾Ja/g)?.length).toBe(2);
    expect(物.match(/複合語の切れ目/g)?.length).toBe(2);
    expect(物.match(/月の付いた塊/g)?.length).toBe(3);
  });
});
