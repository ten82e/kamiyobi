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
function 対称差(左: Set<string>, 右: Set<string>): number {
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}
function 列(文: string) {
  return new Set(全.filter((行) => Recommender.searchMatcher(文, 基準)(行) === true));
}
function 案内(文: string) {
  return Recommender.relativeDayNotes(文, 基準).join("|");
}

describe("月の塊にまでを離って続ける形が詰め形と同じ行を出す（第 474 回）", () => {
  it("相対の頭に続く形が詰め形と同じ行に出る（実測 – 前は離つた側が 0 行か極少だった）", () => {
    for (const [離, 繋] of [
      ["来月 上旬 まで", "来月上旬まで"],
      ["来月 中旬 まで", "来月中旬まで"],
      ["来月 下旬 まで", "来月下旬まで"],
      ["今月 上旬 まで", "今月上旬まで"],
    ] as Array<[string, string]>) {
      const 離れ = 列(離);
      expect([離, 対称差(離れ, 列(繋))]).toEqual([離, 0]);
    }
    expect(列("来月 上旬 まで").size).toBeGreaterThan(100);
  });
  it("頭其自体を離つて打つ形も詰め形と同じ行に出る（上の続き – 一個に纏めると検査が重くなる為分けた）", () => {
    for (const [離, 繋] of [
      ["来月 上旬 までに", "来月上旬までに"],
      ["来 上旬 まで", "来月上旬まで"],
      ["来 月 上旬 まで", "来月上旬まで"],
    ] as Array<[string, string]>) {
      const 離れ = 列(離);
      expect([離, 対称差(離れ, 列(繋))]).toEqual([離, 0]);
    }
  });
  it("数字の頭・其它の相対の語も詰め形と同じ行に出る", () => {
    const 離側: Array<[string, number, number]> = [];
    for (const [離, 繋] of [
      ["先月 上旬 まで", "先月上旬まで"],
      ["昨月 上旬 まで", "昨月上旬まで"],
      ["翌月 上旬 まで", "翌月上旬まで"],
      ["再来月 上旬 まで", "再来月上旬まで"],
      ["9月 上旬 まで", "9月上旬まで"],
      ["9 月 上旬 まで", "9月上旬まで"],
      ["2026年9月 上旬 まで", "2026年9月上旬まで"],
    ]) {
      /* 列() は品書全体を走らせる – 一対で三度も呼ぶと全体の検査で 30 秒に近づく（実測 2026-11-08）。
       * 一纏めに数えてから較べる。*/
      離側.push([離, 列(離).size, 列(繋).size] as [string, number, number]);
    }
    for (const [離, a, b] of 離側) {
      expect([離, a]).toEqual([離, b]);
    }
  });
  it("行数の実測（固定ハーネスの品書 435 行）", () => {
    expect(列("来月 上旬 まで").size).toBe(180);
    expect(列("来月 中旬 まで").size).toBe(230);
    expect(列("来月 下旬 まで").size).toBe(276);
    expect(列("来 上旬 まで").size).toBe(180);
    expect(列("今 上旬 まで").size).toBe(118);
    expect(列("9 月 上旬 まで").size).toBe(181);
    expect(列("翌月 上旬 まで").size).toBe(173);
    expect(列("2026年9月 上旬 まで").size).toBe(180);
    expect(列("再来月 上旬 まで").size).toBe(301);
    expect(列("昨月 上旬 まで").size).toBe(0);
    expect(列("来月 上旬 までに").size).toBe(180);
  });
  it("件数欄の範囲と行が合致している（範囲を書くのに 0 行だった型）", () => {
    const 文 = 案内("来月 上旬 まで");
    expect(文).toContain("来月上旬まで = 2026年8月9日(日)〜9月10日(木)");
    expect(文).not.toContain("上旬まで = 2026年8月9日(日)〜8月10日(月)");
    expect(案内("来月 下旬 まで")).toContain("来月下旬まで = 2026年8月9日(日)〜9月30日(水)");
    /* 過ぎた月はその旨を添へる（実測 – 行は 0 件で案内がその事を立つて書く）*/
    const 昨 = 案内("昨月 上旬 まで");
    expect(昨).toContain("昨月上旬まで = 2026年7月10日(金)の締切");
    expect(昨).toContain("その日は過ぎています");
    expect(列("昨月 上旬 まで").size).toBe(0);
  });
  it("後ろにその他の語を続けても効く", () => {
    expect(列("ml 来月 上旬 まで").size).toBe(8);
    expect(列("来月 上旬 まで 論文").size).toBe(108);
    expect(案内("ml 来月 上旬 まで")).toContain("来月上旬まで = 2026年8月9日(日)");
  });
});

describe("寄せない形の守り（第 453 回・第 463 回）", () => {
  it("詰め形がその方で解けぬ頭と尾は载せない（実測 – 寄せ先も 0 行）", () => {
    expect(列("明 月上旬まで").size).toBe(0);
    expect(列("毎 月上旬まで").size).toBe(0);
    expect(案内("明 月上旬まで")).toBe("");
    /* 第 476 回で `から` もその初日からの幅に解けるやうになり、離つた形も詰め形と同じ行に出る。*/
    expect(列("来月上旬から").size).toBe(389);
    expect(列("来月 上旬 から").size).toBe(389);
    expect(列("来月上旬以降").size).toBe(389);
    expect(列("来月 上旬 以降").size).toBe(389);

    expect(案内("来月上旬から")).toBe("");
  });
  it("詰め形其身は一行も動かして居ない（群 3 300 語で変はつた語 0 語の実測）", () => {
    expect(列("来月上旬まで").size).toBe(180);
    expect(列("今月上旬まで").size).toBe(118);
    expect(列("来月中旬まで").size).toBe(230);
    expect(列("来月下旬まで").size).toBe(276);
    expect(列("9月上旬まで").size).toBe(181);
    expect(列("昨月上旬まで").size).toBe(0);
    expect(列("来月上旬").size).toBe(68);
  });
  it("まで幅のその他の形とその他の機械の語は其侭", () => {
    expect(列("8月 まで").size).toBe(118);
    expect(列("年度末 まで").size).toBe(29);
    expect(列("来月 上旬").size).toBe(68);
    expect(列("来月 上旬").size).toBe(列("来月上旬").size);
    expect(案内("来月 上旬")).toContain("来月 上旬 = 2026年9月1日(火)");
    expect(列("週 末").size).toBe(146);
    expect(列("来 週末").size).toBe(34);
    expect(列("今 月末").size).toBe(118);
    expect(列("来 年中").size).toBe(114);
  });
  it("第 470 回〜第 473 回の実測はこの回で変へて居ない", () => {
    expect(列("8 月の 締切").size).toBe(114);
    expect(列("来 月の 下旬").size).toBe(59);
    expect(案内("来 月の 下旬")).toContain("来月 下旬 = 2026年9月21日(月)");
    expect(列("来 上旬").size).toBe(68);
    expect(列("今 中頃").size).toBe(55);
  });
});

describe("ビルド成果物に目がある事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("までを続ける寄せが現れる", () => {
    expect(物.match(/複合語の切れ目/g)?.length).toBe(2);
    expect(物).toContain('"$1$2月$3$4"');
    /* 第 476 回でこの目の語尾の一覧は、その方の幅の機械が受ける物に揃つた。*/
    expect(物).toContain("(までに|まで|以降|以後|この先|以来|から|より)");
  });
  it("前の三回の目の字面を壊して居ない", () => {
    expect(物.match(/単位に付いた助字/g)?.length).toBe(2);
    expect(物).toContain('"$1$2週末"');
    expect(物).toContain('"$1$2月 $3"');
    expect(物.match(/月の付いた塊/g)?.length).toBe(3);
  });
});
