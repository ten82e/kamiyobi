/* 第 473 回 – 相対の語に月の塊を直接続ける形（`来 上旬` `今 下旬` `来 半ば` `来上旬`）
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、二つの型が同時に
 * 壊れて居た – ① 0 行: `来 上旬` 0 行 ⇔ `来月 上旬` 92 行・`今 下旬` 0 行 ⇔ 92 行・`再来 中旬`
 * 0 行 ⇔ 66 行・`来 半ば` 0 行 ⇔ 79 行で、詰め形の `来上旬` も 0 行（案内も無し）。② 件数欄が
 * 今の月の範囲を噓で書く: `来 上旬` は 0 行のまま「上旬 = 2026年8月1日(土)〜2026年8月10日(月)」
 * と今の月を書いて居た（`昨 中旬` `翌 上旬` `先 上旬` も同じ – 第 469 回と同じ型）。
 * 直しは第 471 回・第 472 回と同じ表 `複合語の切れ目` に二つを足す – 其の方の機械が既に解く
 * 「其の月 + 塊」に寄せる（実測 – 今 上旬 37・中旬 74・下旬 92・初旬 37・半ば 74・中頃 74 /
 * 来 92・79・86・92・79・79 / 先 6・26・26・6・26・26 / 昨 6・26・26・6・26・26 / 再来 72・66・
 * 68・72・66・66 / 翌 92・79・86・92・79・79）。**塊は三つ** – `初旬` `半ば` `中頃` は此の上流の目が
 * 既に `上旬` `中旬` に寄せて居て此の目まで届かない（改ざんで落しても 来 半ば 57 行・来 初旬 68 行・
 * 来 中頃 57 行はそのまま通つた – 第 463 回）。**寄せた形には空格を一文字残す** – 詰め形に
 * 寄せると `先月 半ば` 26 行 ⇔ `先月半ば` 0 行・`翌月 半ば` 79 行 ⇔ `翌月半ば` 0 行に減つた
 * （第 466 回）。1 977 語の群で **行の差 743 語（全部 0 行から）・減つた物 0 語**、第 472 回の
 * 3 405 語（差 263 語・減 0）、第 471 回の 555 語と第 470 回の 2 458 語は **差 0 語**を実測した。 */
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

describe("相対の語に月の塊を続ける形が其の月の塊として解ける（第 473 回）", () => {
  it("離つた形・詰め形・其の月を打つ形の三通りが同じ行に出る", () => {
    for (const [甲, 乙] of [
      ["今", "上旬"],
      ["今", "中旬"],
      ["今", "下旬"],
      ["来", "上旬"],
      ["来", "中旬"],
      ["来", "下旬"],
      ["来", "半ば"],
      ["来", "初旬"],
      ["来", "中頃"],
      ["先", "中旬"],
      ["先", "半ば"],
      ["昨", "上旬"],
      ["再来", "中旬"],
      ["翌", "上旬"],
    ]) {
      const 月形 = 列(`${甲}月 ${乙}`).size;
      expect([`${甲} ${乙}`, 列(`${甲} ${乙}`).size]).toEqual([`${甲} ${乙}`, 月形]);
      expect([`${甲}${乙}`, 列(`${甲}${乙}`).size]).toEqual([`${甲}${乙}`, 月形]);
    }
  });
  it("行数の実測（固定ハーネスの品書 435 行）", () => {
    expect(列("来 上旬").size).toBe(68);
    expect(列("来 中旬").size).toBe(57);
    expect(列("来 下旬").size).toBe(59);
    expect(列("今 下旬").size).toBe(58);
    expect(列("今 中頃").size).toBe(55);
    expect(列("先 中旬").size).toBe(6);
    expect(列("先 半ば").size).toBe(6);
    expect(列("昨 上旬").size).toBe(0);
    expect(列("再来 中旬").size).toBe(36);
    expect(列("翌 上旬").size).toBe(68);
    expect(列("来 初旬").size).toBe(68);
    expect(列("来 半ば").size).toBe(57);
  });
  it("件数欄は其の月の塊の範囲を書く（前に今の月を書いて居た六語）", () => {
    const 来 = 案内("来 上旬");
    expect(来).toContain("来月 上旬 = 2026年9月1日(火)〜2026年9月10日(木)");
    expect(来).not.toContain("上旬 = 2026年8月");
    expect(案内("今 下旬")).toContain("今月 下旬 = 2026年8月21日(金)〜2026年8月31日(月)");
    expect(案内("再来 中旬")).toContain("再来月 中旬 = 2026年10月11日(日)〜2026年10月20日(火)");
    expect(案内("翌 上旬")).toContain("翌月 上旬 = 2026年9月1日(火)");
    const 昨 = 案内("昨 上旬");
    expect(昨).toContain("昨月 上旬 = 2026年7月1日(水)〜2026年7月10日(金)");
    expect(昨).toContain("その範囲は過ぎています");
    expect(案内("来 半ば")).toContain("来月 中旬 = 2026年9月11日(金)");
    expect(案内("来 初旬")).toContain("来月 上旬 = 2026年9月1日(火)");
  });
  it("語尾を続けた形も其の月の塊として解ける", () => {
    expect(列("来 上旬 締切").size).toBe(56);
    expect(列("来 上旬 の 論文").size).toBe(45);
    expect(列("ml 来 上旬 締切").size).toBe(2);
    expect(列("今 上旬 まで").size).toBe(2);
    expect(案内("今 上旬 まで")).toContain("今月 上旬 まで = 2026年8月9日(日)〜8月10日(月)");
    expect(列("今 下旬 まで").size).toBe(110);
    expect(案内("今 下旬 まで")).toContain("今月 下旬 まで = 2026年8月9日(日)〜8月31日(月)");
    expect(案内("来 上旬 まで")).toContain("来月 上旬 まで = 2026年8月9日(日)〜9月10日(木)");
  });
});

describe("寄せない形の守り（第 453 回・第 463 回・第 466 回）", () => {
  it("寄せ先が其の方で解けぬ頭は载せない（実測 – 今月の案内が其侭残る）", () => {
    /* `明 上旬` の寄せ先 `明月上旬` は 0 行で案内も無し、`再々月 上旬` も 0 行（再々月を月の語と
     * して解かない為）。寄せても 0 行の侭で案内だけが消えるので载せない – 其の代は其の方の機械に
     * 月の語を解かせる別の群の話（第 474 回の候補）。実測 – 今も此の三語は今の月の案内を書く侭。*/
    for (const 文 of ["明 上旬", "再々 上旬", "毎 上旬"]) {
      expect([文, 列(文).size]).toEqual([文, 0]);
      expect(案内(文)).toContain("上旬 = 2026年8月1日(土)〜2026年8月10日(月)");
    }
    expect(列("明月上旬").size).toBe(0);
    expect(案内("明月上旬")).toBe("");
  });
  it("其の月が既に打たれて居る形は触らない（詰め形と空格形の両方）", () => {
    expect(列("来月 上旬").size).toBe(68);
    expect(列("来月上旬").size).toBe(68);
    expect(案内("来月上旬")).toContain("来月上旬 = 2026年9月1日(火)〜2026年9月10日(木)");
    expect(列("来月下旬").size).toBe(59);
    expect(列("9 月 上旬").size).toBe(68);
    expect(列("来週 上旬").size).toBe(2);
    expect(案内("来週 上旬")).toContain("来週 = 2026年8月10日(月)〜8月16日(日)");
  });
  it("その他の機械が受ける語と塊の単体は其侭", () => {
    expect(列("上旬").size).toBe(10);
    expect(列("半ば").size).toBe(55);
    expect(列("今 月中").size).toBe(118);
    expect(列("毎 週末").size).toBe(0);
    expect(列("昨 週").size).toBe(8);
    expect(列("来 年中").size).toBe(113);
    expect(案内("半ば")).toContain("中旬 = 2026年8月11日(火)");
  });
  it("第 470 回・第 471 回・第 472 回の実測は此の回で変へて居ない", () => {
    expect(列("8 月の 締切").size).toBe(114);
    expect(列("来 月の 下旬").size).toBe(59);
    expect(案内("来 月の 下旬")).toContain("来月 下旬 = 2026年9月21日(月)");
    expect(列("週 末").size).toBe(145);
    expect(列("今 月末").size).toBe(118);
    expect(列("来 週末").size).toBe(34);
    expect(案内("来 週末")).toContain("来週末 = 2026年8月15日(土)");
  });
});

describe("ビルド成果物に目が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf-8");
  it("二つの目と空格を残す寄せが現れる", () => {
    expect(物.match(/複合語の切れ目/g)?.length).toBe(2);
    expect(物.match(/\(上旬\|中旬\|下旬\)/g)?.length).toBe(2);
    expect(物).toContain('"$1$2月 $3"');
    expect(物).toContain('"$1月 $2"');
  });
  it("前の三回の目の字面を壊して居ない", () => {
    expect(物.match(/単位に付いた助字/g)?.length).toBe(2);
    expect(物).toContain('"$1$2週末"');
    expect(物).toContain('"$1$2年中"');
    expect(物.match(/月の付いた塊/g)?.length).toBe(3);
  });
});
