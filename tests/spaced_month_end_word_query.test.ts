/* 第 478 回 – 月の語に其の月の終りの語を離って打つ形（`来月 終わり` `今月 終わり` `先月 終わり`）
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、繋げた側だけが
 * 通つた – `来月 終わり` **0 件** / `来月終わり` 245 件・`今月 終わり` **0 件** / 192 件・
 * `先月 終わり` **0 件** / 52 件・`来月 終わり まで` **0 件** / 245 件。其の方の語は月の末の幅に
 * 解ける（件の数欄は其れを解けた幅として書き、0 件の時に「並びます」とは書かない – 第 413 回）。
 * 直しは月の語と『終わり』を一つに寄せる目を一段目に足した（其の方の機械が解ける形に揃べるだけ –
 * 第 453 回）。
 * 同じ目で試して**効かなかつた物**を代码の注に書いた（実測 – 此の段からでは其の方が解ける段に
 * 届かない為）: `来月 末日` 0 件 ⇔ 詰め形 245 件・`来月 後半` 0 件 ⇔ 86 件・`来週半ば` 0 件 ⇔
 * `来週 半ば` 52 件（此の目で二語に割つても 0 件の侭だつた）– 其れ等は残した差として張つた。*/
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
  it("五の対が詰め形と一字も違わない行に出る（実測 – 前は離つた側が 0 件だつた）", () => {
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
  it("其の月の幅で絞れる形は件の数欄が余計な事を書かない", () => {
    expect(案内("来月 終わり")).toBe("");
    expect(列("来月 終わり").size).toBe(列("来月末").size);
  });
});

describe("此の段から届かない形（実測で残した差）と其它の守り", () => {
  it("『末日』『後半』『前半』は此の段の寄せでは解けない – 0 件の侭", () => {
    /* 実測 2026-11-08 – 同じ目に載せても、此の目で一語に揃へても其の方が解ける段（月の末尾を
     * 決める所 – 第 460 回・第 465 回）が語の割りの前で受ける形なので届かなかつた。
     * 詰め形其れ自体は通る（実ビルドで `来月末日` 245 件・`来月後半` 86 件）。*/
    expect(列("来月 末日").size).toBe(0);
    expect(列("来月 後半").size).toBe(0);
    expect(列("来月 前半").size).toBe(0);
    expect(列("8月 終わり").size).toBe(0);
    expect(案内("来月 末日")).toBe("");
  });
  it("週の語・年の語に其の真ん中を直に繋げた形も 0 件の侭（割つても解れない）", () => {
    /* 実測 – 此の目で `来週半ば` を `来週 半ば` に割つても 0 件の侭だつた（使用者が空格を打つと
     * 43 件出る）。其の方の段で別の群として直す。*/
    expect(列("来週半ば").size).toBe(0);
    expect(列("来週 半ば").size).toBe(43);
  });
  it("其它の機械が受ける語と前の回の実測は変へて居ない", () => {
    expect(列("ml から").size).toBe(0);
    expect(列("週 末").size).toBe(145);
    expect(列("月末").size).toBe(118);
    expect(列("来月末").size).toBe(178);
    expect(列("明日以降").size).toBe(422);
    expect(列("1 か月後から").size).toBe(361);
    expect(列("来 上旬").size).toBe(68);
    expect(列("明日 から 明後日").size).toBe(4);
    expect(列("来月 下旬 まで").size).toBe(276);
    expect(案内("来月 下旬 まで")).toContain("来月下旬まで = 2026年8月9日(日)〜9月30日(水)");
  });
});

describe("ビルド成果物に目が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("終り・末の寄せが現れる（第 483 回で列を広げた）", () => {
    /* 実測 – 第 478 回は『終わり』だけを受け、第 483 回で『末』と仲介の『の』を足した（`来月 末` 0 件 →
     * 245 件・`来月の末` 0 件 → 245 件）。其の字面を張る。*/
    expect(物.match(/\(終わり\|末\)/g)?.length).toBe(1);
    expect(物).toContain("再来|翌)月[ \\u3000]*(?:の)?[ \\u3000]*(終わり|末)");
  });
  it("前の六回の目の字面を壊して居ない", () => {
    expect(物.match(/複合語の切れ目/g)?.length).toBe(2);
    expect(物.match(/離した幅の区切りJa/g)?.length).toBe(2);
    expect(物.match(/其の日以降の初日Ja/g)?.length).toBeGreaterThan(3);
    expect(物.match(/単位に付いた助字/g)?.length).toBe(2);
    expect(物.match(/月の付いた塊/g)?.length).toBe(3);
  });
});
