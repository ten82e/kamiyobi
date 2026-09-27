/* 第 474 回 – 月の塊に `まで` を離って続ける形（`来月 上旬 まで` `9 月 上旬 まで` `来 上旬 まで`）
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、件数欄は範囲を
 * 正しく書くのに行が其の範囲と無関係だつた – `来月 上旬 まで` **0 行** / `来月上旬まで` 250 行・
 * `来月 中旬 まで` **4 行** / 323 行・`来月 下旬 まで` **17 行** / 408 行・`9 月 上旬 まで`
 * **0 行** / 263 行・`来 上旬 まで` **0 行** / 250 行・`昨月 上旬 まで` **0 行** / 7 行・
 * `2026年9月 上旬 まで` **0 行** / 250 行。
 * 原因は語組 – 詰め形は群が一つ（九月と8月9日・10日の和集合）になるのに、離つた形は `来月` と
 * `上旬まで` の二群の積になつて、`上旬まで` が**今の月**の範囲として解れる為、九月との交わりが
 * 空だつた（実測 – 語組 `["2026年9月"]` × `["上旬まで","2026年8月9日","2026年8月10日"]`）。
 * 直しは第 471 回〜第 473 回と同じ表 `複合語の切れ目` に一本 – 其の方が範囲に解ける詰め形に寄せる。
 * 3 300 語の群で 0 行から 130 語を含む 432 語の行が動き、**詰め形其身（空格を含まぬ語）は 0 語も
 * 変はらず**、詰め形との対称差は 114 対で収束（`から` `以降` は詰め形も 0 行なので載せない –
 * 第 463 回）。 */
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

describe("月の塊にまでを離って続ける形が詰め形と同じ行を出す（第 474 回）", () => {
  /* 群の総当りは重い – 相対の頭と数字の頭で二分して、一つの張りが 30 秒の制限に掛からぬやうにする
   * （全部を一本にすると全体の実行負荷の下で検査が時間で落ちた – 実測 2026-11-08）。*/
  it("相対の頭に続く形が詰め形と同じ行に出る（実測 – 前は離つた側が 0 行か極少だつた）", () => {
    for (const [離, 繋] of [
      ["来月 上旬 まで", "来月上旬まで"],
      ["来月 中旬 まで", "来月中旬まで"],
      ["来月 下旬 まで", "来月下旬まで"],
      ["今月 上旬 まで", "今月上旬まで"],
      ["来月 上旬 までに", "来月上旬までに"],
      ["来 上旬 まで", "来月上旬まで"],
      ["来 月 上旬 まで", "来月上旬まで"],
    ]) {
      expect([離, 列(離).size, 列(繋).size]).toEqual([離, 列(繋).size, 列(繋).size]);
    }
    expect(列("来月 上旬 まで").size).toBeGreaterThan(100);
  });
  it("数字の頭・其它の相対の語も詰め形と同じ行に出る", () => {
    for (const [離, 繋] of [
      ["先月 上旬 まで", "先月上旬まで"],
      ["昨月 上旬 まで", "昨月上旬まで"],
      ["翌月 上旬 まで", "翌月上旬まで"],
      ["再来月 上旬 まで", "再来月上旬まで"],
      ["9月 上旬 まで", "9月上旬まで"],
      ["9 月 上旬 まで", "9月上旬まで"],
      ["2026年9月 上旬 まで", "2026年9月上旬まで"],
    ]) {
      expect([離, 列(離).size, 列(繋).size]).toEqual([離, 列(繋).size, 列(繋).size]);
    }
  });
  it("行数の実測（固定ハーネスの品書 435 行）", () => {
    expect(列("来月 上旬 まで").size).toBe(180);
    expect(列("来月 中旬 まで").size).toBe(230);
    expect(列("来月 下旬 まで").size).toBe(276);
    expect(列("来 上旬 まで").size).toBe(180);
    expect(列("今 上旬 まで").size).toBe(118);
    expect(列("9 月 上旬 まで").size).toBe(181);
    expect(列("翌月 上旬 まで").size).toBe(174);
    expect(列("2026年9月 上旬 まで").size).toBe(180);
    expect(列("再来月 上旬 まで").size).toBe(302);
    expect(列("昨月 上旬 まで").size).toBe(0);
    expect(列("来月 上旬 までに").size).toBe(180);
  });
  it("件数欄の範囲と行が合致して居る（範囲を書くのに 0 行だつた型）", () => {
    const 文 = 案内("来月 上旬 まで");
    expect(文).toContain("来月上旬まで = 2026年8月9日(日)〜9月10日(木)");
    expect(文).not.toContain("上旬まで = 2026年8月9日(日)〜8月10日(月)");
    expect(案内("来月 下旬 まで")).toContain("来月下旬まで = 2026年8月9日(日)〜9月30日(水)");
    /* 過ぎた月は其の旨を添へる（実測 – 行は 0 件で案内が其の事を立つて書く）*/
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
  it("詰め形が其の方で解けぬ頭と尾は载せない（実測 – 寄せ先も 0 行）", () => {
    /* 明 月上旬まで（明月上旬を月の語として解かない）と、`から` `以降` を続ける形 –
     * 詰め形 `来月上旬から` `来月上旬以降` も 0 行なので、寄せても 0 行の侭（効かな所以）。*/
    expect(列("明 月上旬まで").size).toBe(0);
    expect(列("毎 月上旬まで").size).toBe(0);
    expect(案内("明 月上旬まで")).toBe("");
    expect(列("来月上旬から").size).toBe(0);
    expect(列("来月 上旬 から").size).toBe(0);
    expect(列("来月上旬以降").size).toBe(0);
    expect(列("来月 上旬 以降").size).toBe(0);
    /* 其の幅の絞り込み其物は動く（実測 – 案内が其の旨を書く）*/
    expect(案内("来月上旬から")).toContain("2026年9月1日以降のこと");
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
    expect(列("年度末 まで").size).toBe(28);
    expect(列("来月 上旬").size).toBe(68);
    expect(列("来月 上旬").size).toBe(列("来月上旬").size);
    expect(案内("来月 上旬")).toContain("来月 上旬 = 2026年9月1日(火)");
    expect(列("週 末").size).toBe(145);
    expect(列("来 週末").size).toBe(34);
    expect(列("今 月末").size).toBe(118);
    expect(列("来 年中").size).toBe(113);
  });
  it("第 470 回〜第 473 回の実測は此の回で変へて居ない", () => {
    expect(列("8 月の 締切").size).toBe(114);
    expect(列("来 月の 下旬").size).toBe(59);
    expect(案内("来 月の 下旬")).toContain("来月 下旬 = 2026年9月21日(月)");
    expect(列("来 上旬").size).toBe(68);
    expect(列("今 中頃").size).toBe(55);
  });
});

describe("ビルド成果物に目が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("までを続ける寄せが現れる", () => {
    expect(物.match(/複合語の切れ目/g)?.length).toBe(2);
    expect(物).toContain('"$1$2月$3$4"');
    expect(物).toContain("(までに|まで)");
  });
  it("前の三回の目の字面を壊して居ない", () => {
    expect(物.match(/単位に付いた助字/g)?.length).toBe(2);
    expect(物).toContain('"$1$2週末"');
    expect(物).toContain('"$1$2月 $3"');
    expect(物.match(/月の付いた塊/g)?.length).toBe(3);
  });
});
