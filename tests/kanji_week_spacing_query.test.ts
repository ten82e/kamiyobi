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

describe("漢数字の週を離つて打つ形が詰め形と同じ行に出る（第 481 回）", () => {
  it("六の対が詰め形と一字も違わない行に出る（実測 – 前は離つた側が 0 行だった）", () => {
    for (const [離, 繋] of [
      ["一 週間後", "一週間後"],
      ["二 週間前", "二週間前"],
      ["三 週間以内", "三週間以内"],
      ["十 週間後", "十週間後"],
      ["十一 週間後", "十一週間後"],
      ["一 週間後 の 締切", "一週間後の締切"],
    ] as Array<[string, string]>) {
      expect([離, 対称差(列(離), 列(繋))]).toEqual([離, 0]);
    }
  });
  it("行数の実測（固定ハーネスの品書 435 行）", () => {
    expect(列("一 週間後").size).toBe(13);
    expect(列("三 週間以内").size).toBe(90);
    expect(列("十 週間後").size).toBe(4);
    expect(列("十一 週間後").size).toBe(2);
    expect(列("一 週間後 の 締切").size).toBe(13);
    /* 二 週間前はその方が過去の日にち（14 日前）なのでこの品書に行が在らん – 0 件の対称。*/
    expect(列("二 週間前").size).toBe(0);
    expect(案内("二 週間前")).toContain("14日前 = 2026年7月26日(日)");
  });
  it("件の数欄はその日への変換を書き、0 件を約束しない", () => {
    expect(案内("一 週間後")).toContain("7日後 = 2026年8月16日(日)");
    expect(案内("三 週間以内")).toContain("21日以内 = 2026年8月9日(日)〜8月30日(日)");
  });
});

describe("他の単位に空格を広げない決まり（第 459 回・第 466 回・第 470 回）", () => {
  it("名乗りは打たれた空格の侭 – 週以外の単位は目の外", () => {
    /* 実測 2026-11-08 – 目の単位列を広くした版ではこの二つが「1か月後 = …」「第 2週 = …」に
     * 化けた（行は合つた侭名乗りだけが噓になる – 第 332 回）。*/
    expect(案内("一 か月後")).toContain("一 か月後 = 2026年9月9日(水)");
    expect(案内("第 二 週")).toContain("第 二 週 = 2026年8月8日(土)〜2026年8月14日(金)");
    expect(列("第 二 週").size).toBe(26);
    expect(列("第 二 週").size).toBe(列("第2週").size);
  });
  it("bare の週を離つた形は寄せない（その語は其它の機械が受ける）", () => {
    expect(列("一 週").size).toBe(0);
    expect(列("二 週").size).toBe(0);
    /* 其它の数字の語の離し方も其侭（実測 – この目を入れても変はらぬ）。*/

    expect(列("一 月 五 日").size).toBe(5);
    expect(列("一 月 五 日").size).toBe(列("1 月 5 日").size);
    expect(列("五 日後").size).toBe(17);
    expect(案内("五 日後")).toContain("五 日後 = 2026年8月14日(金)");
  });
  it("第 470 回〜第 480 回の実測はこの回で変へて居ない", () => {
    expect(列("締切時刻").size).toBe(181);
    expect(列("来月 終わり").size).toBe(178);
    expect(列("週 末").size).toBe(146);
    expect(列("ml から").size).toBe(0);
    expect(列("明日以降").size).toBe(423);
    expect(列("来 上旬").size).toBe(68);
    expect(列("半 年後").size).toBe(2);
    expect(列("1 週間後").size).toBe(13);
    expect(列("明日 から 明後日").size).toBe(4);
  });
});

describe("ビルド成果物に目がある事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("週に限り空格を受ける目が現れる", () => {
    expect(物.match(/週の漢数字の空格/g)?.length).toBe(2);
    expect(物).toContain("{1,4})[ \\u3000]+週間");
    /* 漢数字を直すその方の目は繋がれた形だけを見る決まりを壊して居ない（空格を許す目を
     * その目に載せ替へて居ない事の実測 – 第 481 回）。*/
    expect(物).toContain(
      "([〇一二三四五六七八九十]{1,4})(か月|カ月|ヵ月|ヶ月|ケ月|箇月|年|月|日|週間|週)",
    );
    expect(物.match(/\(\[〇一二三四五六七八九十\]\{1,4\}\)\(か月/g)?.length).toBe(1);
  });
  it("前の九回の目の字面を壊して居ない", () => {
    expect(物.match(/語の連なりJa/g)?.length).toBe(2);
    expect(物.match(/離した幅の区切りJa/g)?.length).toBe(2);
    expect(物.match(/繋がれた幅の尾Ja/g)?.length).toBe(2);
    expect(物.match(/複合語の切れ目/g)?.length).toBe(2);
    expect(物.match(/月の付いた塊/g)?.length).toBe(3);
  });
});
