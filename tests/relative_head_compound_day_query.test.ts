/* 第 472 回 – 相対の語と複合日語を離って打つ形（`来 週末` `今 年中` `昨 月` `昨 週` `翌 年度`）
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、
 * ① 離つた側が 0 行で繋いだ側が行を出す対 – `今 年中` 0 行 / `今年中` 796 行・`来 年中` 0 行 /
 *    `来年中` 465 行・`翌 年中` 0 行 / `翌年中` 465 行・`昨 月` 0 行 / `昨月` 52 行・`昨 週` 0 行 /
 *    `昨週` 25 行・`再々 週` 0 行 / `再々週` 41 行・`昨 月末` 0 行 / `昨月末` 52 行・`翌 年度` 0 行 /
 *    `翌年度` 302 行。
 * ② 行は合つて居るのに件数欄だけが黙つて居た対 – `今 週末` 6 行・`来 週末` 40 行・`先 週末` 16 行・
 *    `再来 週末` 15 行・`昨 週末` 16 行・`翌 週末` 40 行（詰め形は「来週末 = 2026年8月15日(土)・
 *    2026年8月16日(日)の締切」と書くのに離つた側は無言 – 第 469 回と同じ型）。`昨 年中` `再来 年中`
 *    `再来 年度` は離つた側が**今の年の幅を名乗つて居た**（実測 –「年度 = 2026年4月1日(水)〜
 *    2027年3月31日(水)」 – 詰め形は「再来年度 = 2028年4月1日(土)〜2029年3月31日(土)」）。
 * 直しは第 471 回の `複合語の切れ目` に五行を足すだけ（同じ表の並び – 週の語より前に `週 末` の目を
 * 置くので `来 週 末` のやうに三語に割れた打ち方も寄る）。3 405 語の群（頭 10 種 × 複合語 21 種 ×
 * 後ろの語 5 種の総当り + 対照）で、**詰め形其身が変はつた語 0 語・対称差が開いた組 0 組・行の
 * 対称差が残る 0 語**、第 470 回の 2 458 語と第 471 回の 555 語の群は**差 0 語**を実測した。 */
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

describe("相対の語と複合日語を離って打つ形が詰め形と揃ふ（第 472 回）", () => {
  it("詰め形と対称差 0 – 行も件数欄も同じ（実測 – 前は離つた側が 0 行か無言だつた）", () => {
    for (const [離, 繋] of [
      ["今 週末", "今週末"],
      ["来 週末", "来週末"],
      ["先 週末", "先週末"],
      ["再来 週末", "再来週末"],
      ["昨 週末", "昨週末"],
      ["翌 週末", "翌週末"],
      ["今 年中", "今年中"],
      ["来 年中", "来年中"],
      ["昨 年中", "昨年中"],
      ["再来 年中", "再来年中"],
      ["翌 年中", "翌年中"],
      ["昨 月", "昨月"],
      ["昨 週", "昨週"],
      ["再々 週", "再々週"],
      ["翌 年度", "翌年度"],
      ["昨 月末", "昨月末"],
    ]) {
      expect([離, 列(離).size, 列(繋).size]).toEqual([離, 列(繋).size, 列(繋).size]);
      expect([離, 案内(離) !== "", 案内(繋) !== ""]).toEqual([
        離,
        案内(繋) !== "",
        案内(繋) !== "",
      ]);
    }
  });
  it("件数欄は其の複合語の幅を書く（前に黙つて居た六語と、今の年を名乗つて居た三語）", () => {
    expect(案内("来 週末")).toContain("来週末 = 2026年8月15日(土)・2026年8月16日(日)");
    expect(案内("今 週末")).toContain("今週末 = 2026年8月8日(土)・2026年8月9日(日)");
    expect(案内("昨 週末")).toContain("昨週末 = 2026年8月1日(土)");
    expect(案内("再来 週末")).toContain("再来週末 = 2026年8月22日(土)");
    expect(案内("翌 週末")).toContain("翌週末 = 2026年8月15日(土)");
    expect(案内("来 年中")).toContain("来年中 = 2027年の締切（1〜12 か月）");
    expect(案内("昨 年中")).toContain("昨年中 = 2025年の締切（1〜12 か月）");
    /* 実測 – 直し前の `再来 年度` は「年度 = 2026年4月1日(水)〜2027年3月31日(水)」と
     * 今の年度を書いて居た（詰め形は 2028年度を書く）。*/
    const 再 = 案内("再来 年度");
    expect(再).toContain("再来年度 = 2028年4月1日(土)〜2029年3月31日(土)");
    expect(再).not.toContain("年度 = 2026年4月1日(水)");
  });
  it("行数の実測（固定ハーネスの品書 435 行）", () => {
    expect(列("今 週末").size).toBe(1);
    expect(列("来 週末").size).toBe(34);
    expect(列("先 週末").size).toBe(5);
    expect(列("昨 週末").size).toBe(5);
    expect(列("翌 週末").size).toBe(34);
    expect(列("今 年中").size).toBe(426);
    expect(列("来 年中").size).toBe(113);
    expect(列("昨 年中").size).toBe(0);
    expect(列("昨 月").size).toBe(11);
    expect(列("昨 週").size).toBe(8);
    expect(列("再々 週").size).toBe(18);
    expect(列("昨 月末").size).toBe(11);
  });
  it("語尾を続けた形も詰め形と同じ – まで幅の収束を実測で張る", () => {
    expect(列("来 週末 まで").size).toBe(36);
    expect(列("来 週末 まで").size).toBe(列("来週末 まで").size);
    expect(案内("来 週末 まで")).toContain("来週末 まで = 2026年8月9日(日)〜8月15日(土)");
    expect(列("今 週末 まで").size).toBe(1);
    expect(列("今 週末 まで").size).toBe(列("今週末 まで").size);
    expect(案内("今 週末 まで")).toContain("今週末 まで = 2026年8月8日(土)");
    expect(列("今 年中 締切").size).toBe(369);
    expect(列("ml 来 年中 締切").size).toBe(3);
    expect(列("今 週末に").size).toBe(1);
    expect(案内("今 週末に")).toContain("今週末 = ");
  });
  it("三語に割れた打ち方も其の方の複合語に寄る（表の並びが効く事の実測）", () => {
    expect(列("来 週 末").size).toBe(34);
    expect(案内("来 週 末")).toContain("来週末 = 2026年8月15日(土)");
    expect(列("昨 週 末").size).toBe(5);
    expect(案内("昨 週 末")).toContain("昨週末 = ");
  });
});

describe("寄せない形の守り（第 453 回・第 463 回・第 466 回）", () => {
  it("詰め形が其の方で解けぬ対は 0 行の侭（案内も化けない）", () => {
    expect(列("毎 週末").size).toBe(0);
    expect(列("明 週").size).toBe(0);
    expect(列("昨 月初").size).toBe(0);
    expect(列("来 年 末").size).toBe(0);
    expect(案内("毎 週末")).toBe("");
    expect(案内("明 週")).toBe("");
  });
  it("詰め形其身は一行も動かして居ない（総当り 3 405 語で変はつた語 0 語の実測）", () => {
    expect(列("今週末").size).toBe(1);
    expect(列("来週末").size).toBe(34);
    expect(列("今年中").size).toBe(426);
    expect(列("来年中").size).toBe(113);
    expect(列("昨月").size).toBe(11);
    expect(列("昨週").size).toBe(8);
    expect(列("再々週").size).toBe(18);
    expect(列("翌年度").size).toBe(48);
  });
  it("頭に複合語を既に持つ語とその他の機械の語は触らない", () => {
    /* `今年 月末` は詰め形 `今年月末` が解けぬ語（実測 – 離つた側 192 行 ⇔ 詰め形 0 行）なので
     * 寄せない – 境目が文の頭か空格の直後に在る目でも、頭の表に載せて居ない対は発火しない。*/
    expect(列("今 週 末").size).toBe(列("今週末").size);
    expect(列("年 中").size).toBe(27);
    expect(列("月 内").size).toBe(38);
    expect(列("論文 中").size).toBe(20);
    expect(列("8 月 末").size).toBe(118);
  });
  it("前回の残した差 – 上旬・中旬・下旬を相対の語に続ける形は第 473 回で解ける", () => {
    /* 実測 2026-11-08（第 472 回）– `今 上旬` 0 行（案内は今の月の「上旬 = 2026年8月1日(土)〜」）⇔
     * `今上旬` 0 行（案内無し）だつた。第 473 回で「其の月 + 塊」に寄せる目を同じ段に足したので、
     * 三通りとも其の月の塊の範囲を書く（実測 – `今 上旬` `今上旬` `今月 上旬` 三通り同じ行）。*/
    expect(列("今 上旬").size).toBe(10);
    expect(列("今 上旬").size).toBe(列("今上旬").size);
    expect(列("今 上旬").size).toBe(列("今月 上旬").size);
    expect(案内("今 上旬")).toContain("今月 上旬 = 2026年8月1日(土)〜2026年8月10日(月)");
    expect(案内("今上旬")).toContain("今月 上旬 = 2026年8月1日(土)〜2026年8月10日(月)");
    expect(案内("来 中旬")).toContain("来月 中旬 = 2026年9月11日(金)");
  });
  it("第 470 回・第 471 回の実測は此の回で変へて居ない", () => {
    expect(列("8 月の 締切").size).toBe(114);
    expect(列("来 月の 下旬").size).toBe(59);
    expect(列("週 末").size).toBe(145);
    expect(列("今 月末").size).toBe(118);
    expect(列("来 年度").size).toBe(48);
    expect(案内("来 月の 下旬")).toContain("来月 下旬 = 2026年9月21日(月)");
  });
});

describe("ビルド成果物に表が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("複合語の表と五行の寄せが現れる", () => {
    expect(物.match(/複合語の切れ目/g)?.length).toBe(2);
    expect(物).toContain('"$1$2週末"');
    expect(物).toContain('"$1$2年中"');
    expect(物).toContain('"$1昨月"');
    expect(物).toContain('"$1$2週"');
    expect(物).toContain('"$1$2年度"');
  });
  it("前の二回の目の字面を壊して居ない", () => {
    expect(物.match(/単位に付いた助字/g)?.length).toBe(2);
    expect(物.match(/月の付いた塊/g)?.length).toBe(3);
    expect(物.match(/週の序数を寄せるJa/g)?.length).toBe(3);
  });
});
