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

describe("月の語に『終わり』を離って打つ形が詰め形と同じ行に出る（第 478 回）", () => {
  it("五の対が詰め形と一字も違わない行に出る（実測 – 前は離つた側が 0 件だった）", () => {
    for (const [離, 繋] of [
      ["来月 終わり", "来月終わり"],
      ["今月 終わり", "今月終わり"],
      ["先月 終わり", "先月終わり"],
      ["来月 終わり まで", "来月終わりまで"],
      ["来月 終わりの締切", "来月終わりの締切"],
    ] as Array<[string, string]>) {
      expect([離, 列(離).size]).toEqual([離, 列(繋).size]);
      expect([離, 列(離).size > 0]).toEqual([離, true]);
    }
  });
  it("行数の実測（固定ハーネスの品書 435 行）", () => {
    expect(列("来月 終わり").size).toBe(178);
    expect(列("今月 終わり").size).toBe(118);
    expect(列("先月 終わり").size).toBe(11);
    expect(列("来月 終わり まで").size).toBe(178);
    expect(列("来月 終わりの締切").size).toBe(153);
  });
  it("その月の幅で絞れる形は件の数欄が余計な事を書かない", () => {
    expect(案内("来月 終わり")).toBe("");
    expect(列("来月 終わり").size).toBe(列("来月末").size);
  });
});

describe("この段から届かない形（実測で残した差）と其它の守り", () => {
  it("『末日』『後半』は第 491 回で解け、『前半』は公用の決まりがないので 0 件の侭", () => {
    expect(列("来月 末日").size).toBe(178);
    expect(列("来月 末日").size).toBe(列("来月末日").size);
    expect(列("来月 後半").size).toBe(59);
    expect(列("来月 後半").size).toBe(列("来月後半").size);
    expect(列("8月 終わり").size).toBe(118);
    /* 前半は何日から何日かの決まりが無いので、離しても詰めても 0 件（案内も出さない）。*/
    expect(列("来月 前半").size).toBe(0);
    expect(列("来月前半").size).toBe(0);
    expect(案内("来月 前半")).toBe("");
  });
  it("週の語にその真ん中を直に繋げた形は第 490 回で解れる", () => {
    expect(列("来週半ば").size).toBe(43);
    expect(列("来週半ば").size).toBe(列("来週 半ば").size);
  });
  it("其它の機械が受ける語と前の回の実測は変へて居ない", () => {
    expect(列("ml から").size).toBe(0);
    expect(列("週 末").size).toBe(146);
    expect(列("月末").size).toBe(118);
    expect(列("来月末").size).toBe(178);
    expect(列("明日以降").size).toBe(423);
    expect(列("1 か月後から").size).toBe(362);
    expect(列("来 上旬").size).toBe(68);
    expect(列("明日 から 明後日").size).toBe(4);
    expect(列("来月 下旬 まで").size).toBe(276);
    expect(案内("来月 下旬 まで")).toContain("来月下旬まで = 2026年8月9日(日)〜9月30日(水)");
  });
});

describe("ビルド成果物に目がある事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("終り・末・末日・後半の寄せが現れる（第 483 回・第 491 回）", () => {
    expect(物.match(/\(末日\|終わり\)/g)?.length).toBe(1);
    expect(物).toContain("(後半)/g,");
    expect(物).toContain("末日|末)(?![぀-ヿ一-龥])");
  });
  it("前の六回の目の字面を壊して居ない", () => {
    expect(物.match(/複合語の切れ目/g)?.length).toBe(2);
    expect(物.match(/離した幅の区切りJa/g)?.length).toBe(2);
    expect(物.match(/其の日以降の初日Ja/g)?.length).toBe(3);
    expect(物.match(/単位に付いた助字/g)?.length).toBe(2);
    expect(物.match(/月の付いた塊/g)?.length).toBe(3);
  });
});
