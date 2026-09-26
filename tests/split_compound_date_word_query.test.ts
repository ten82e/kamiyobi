/* 第 471 回 – 日付の複合語を片段で離って打つ形（`週 末` `今 月末` `来 年度` `年 初`）
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、繋いで打つ形は
 * 其の方の機械が解くのに、片段で離つた側はあらゆる語で黙つて居た – `週 末` 0 行 / `週末` 262 行・
 * `今 月末` 0 行 / `今月末` 192 行・`来 月末` 0 行 / `来月末` 245 行・`今 年度` 0 行 / `今年度`
 * 868 行・`年 初` 0 行 / `年初` 99 行。直しは `collapseRelativeDayPhrase` の `複合語の切れ目` –
 * 片段の片方が其れだけで 0 行の語（週 0・末 0・今 0・来 0・先 0・再来 0・月中 0）の対だけ寄せるの
 * で、離つた側の交わりは必ず 0 行であり、寄せても在る検索は一行も減ら無い。
 * 555 語の群（対の総当り・語尾を繋げた形・その他の機械の語・第 470 回の形の照合）で **行の差 208 語
 * （全部 0 行から）・減つた物 0 語**、第 470 回の 2 458 語の群は **差 0 語**を実測した。 */
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

describe("片段で離つた複合語が繋いだ形と同じ行を出す（第 471 回）", () => {
  it("十の対が繋いだ形と対称差 0（実測 – 前は離つた側が全て 0 行）", () => {
    for (const [離, 繋] of [
      ["週 末", "週末"],
      ["今 月末", "今月末"],
      ["来 月末", "来月末"],
      ["先 月末", "先月末"],
      ["再来 月末", "再来月末"],
      ["今 月中", "今月中"],
      ["来 月中", "来月中"],
      ["今 年度", "今年度"],
      ["来 年度", "来年度"],
      ["年 初", "年初"],
    ]) {
      expect([離, 列(離).size, 列(繋).size]).toEqual([離, 列(繋).size, 列(繋).size]);
      expect(列(離).size).toBeGreaterThan(0);
    }
  });
  it("行数の実測（固定ハーネスの品書 435 行）", () => {
    expect(列("週 末").size).toBe(145);
    expect(列("今 月末").size).toBe(118);
    expect(列("来 月末").size).toBe(178);
    expect(列("先 月末").size).toBe(11);
    expect(列("再来 月末").size).toBe(97);
    expect(列("今 月中").size).toBe(118);
    expect(列("来 月中").size).toBe(178);
    expect(列("今 年度").size).toBe(435);
    expect(列("来 年度").size).toBe(48);
    expect(列("年 初").size).toBe(23);
    expect(列("2026 年 初").size).toBe(15);
  });
  it("複合語に語尾を繋げて打つ形も其の方の語として解ける（語の段でなく文字列の段に目を置いた実測）", () => {
    expect(列("今 月末までに").size).toBe(118);
    expect(列("今 月末までに").size).toBe(列("今月末までに").size);
    expect(列("今 月末 までに").size).toBe(118);
    expect(列("来 月中 まで").size).toBe(178);
    expect(列("週 末 日").size).toBe(145);
  });
  it("件数欄は寄せた複合語の範囲を書き、別の範囲を書かない", () => {
    const 今 = 案内("今 年度");
    expect(今).toContain("今年度 = 2026年4月1日(水)〜2027年3月31日(水)");
    expect(今).not.toContain("2025年4月1日");
    const 来 = 案内("来 年度 の 論文");
    expect(来).toContain("来年度 = 2027年4月1日(木)〜2028年3月31日(金)");
    expect(来).not.toContain("2026年4月1日(水)〜2027年3月31日(水)");
    expect(案内("年 初 め")).not.toContain("2027年");
  });
  it("後ろにその他の語を続けても効く", () => {
    expect(列("週 末 の 締切").size).toBe(118);
    expect(列("週 末 論文").size).toBe(83);
    expect(列("ml 週 末").size).toBe(5);
    expect(列("今 月末 の 会議").size).toBe(118);
    expect(列("年 初 の 会議").size).toBe(23);
    expect(列("来 年度 の 論文").size).toBe(28);
  });
});

describe("寄せない形の守り（第 453 回・第 463 回・第 466 回）", () => {
  it("両側が其れだけで行を出す対は寄せない – 寄せると行が減るから", () => {
    /* 実測 – `年 中` 27 行 ⇔ `年中` 0 行・`月 内` 38 行 ⇔ `月内` 0 行・`年 半ば` 55 行 ⇔ `年半ば` 0 行
     * （繋いだ形を其の方の機械が解かないので、寄せた側は 0 行に減る）。*/
    expect(列("年 中").size).toBe(27);
    expect(列("年中").size).toBe(0);
    expect(列("月 内").size).toBe(38);
    expect(列("月内").size).toBe(0);
    expect(列("年 半ば").size).toBe(55);
    expect(列("年半ば").size).toBe(0);
  });
  it("其の方の機械が二語のまま同じ行を出す形は其侭（語の途中の発火も案内の化けも無い）", () => {
    expect(列("今週 末").size).toBe(1);
    expect(案内("今週 末")).toContain("今週 = 2026年8月3日(月)〜8月9日(日)");
    expect(案内("今週 末")).not.toContain("今週末 = ");
    expect(列("来週 末").size).toBe(34);
    expect(案内("来週 末")).toContain("来週 = 2026年8月10日(月)〜8月16日(日)");
    expect(列("先週 末").size).toBe(5);
    expect(列("来月 末").size).toBe(178);
    expect(列("来月 末").size).toBe(列("来月末").size);
  });
  it("其の方の機械が複合語として解く形は其侭（`来 週末` は寄せない）", () => {
    expect(列("来 週末").size).toBe(34);
    /* 実測 – `来 週末` は其の方の語列のまま其の行が出て案内は無し（第 471 回では触らない）。
     * 週の幅を其の月の幅と取り違えた案内だけは出さない事を張る。*/
    expect(案内("来 週末")).not.toContain("来週 = 2026年8月10日(月)〜8月16日(日)の締切 – 土曜");
    expect(列("年 末").size).toBe(84);
    expect(列("年 初 め").size).toBe(23);
    expect(列("年 初 め").size).toBe(列("年初め").size);
  });
  it("繋いだ形が其の方で解けぬ対は 0 行の侭（案内も作らない）", () => {
    expect(列("週 末日").size).toBe(0);
    expect(列("月 初").size).toBe(0);
    expect(列("週 初").size).toBe(0);
    expect(列("週内").size).toBe(0);
    expect(列("再々 月末").size).toBe(0);
    expect(案内("週 末日")).toBe("");
  });
  it("その他の機械が受ける語の内の字を複合語と取り違えない", () => {
    expect(列("論文 中").size).toBe(20);
    expect(列("8 月 末").size).toBe(118);
    expect(列("8 月 中").size).toBe(118);
    expect(列("9 月 下旬").size).toBe(59);
    expect(案内("8 月 末")).not.toContain("今年度");
  });
  it("第 470 回の実測は此の回で変へて居ない", () => {
    expect(列("来 月の 下旬").size).toBe(59);
    expect(列("8 月の 締切").size).toBe(114);
    expect(案内("来 月の 下旬")).toContain("来月 下旬 = 2026年9月21日(月)");
  });
});

describe("ビルド成果物に表が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("複合語の表と、其れを読む行が現れる", () => {
    expect(物.match(/複合語の切れ目/g)?.length).toBe(2);
    expect(物).toContain('"$1週末"');
    expect(物).toContain('"$1$2年度"');
    expect(物).toContain('"$1年初め"');
  });
  it("前の回の目の字面を壊して居ない", () => {
    expect(物.match(/単位に付いた助字/g)?.length).toBe(2);
    expect(物.match(/月の付いた塊/g)?.length).toBe(3);
    expect(物.match(/週の序数を寄せるJa/g)?.length).toBe(3);
    expect(物.match(/週的形状Ja/g)?.length).toBe(3);
  });
});
