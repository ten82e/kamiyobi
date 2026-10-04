/* 第 477 回 – 数を離って打った相対日に、其れより後・其れまでの語尾を直に続けた形
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、此れ等は 0 件だつた
 * – `1 年後から` **0 件** / `1年後から` 41 件・`1 年後以降` **0 件** / 41 件・`1 年後まで` **0 件** /
 * 864 件・`1 か月後から` **0 件** / 670 件・`1 か月後まで` **0 件** / 230 件・`1 ヶ月後から` **0 件** /
 * 670 件・`半 年後から` **0 件** / 408 件・`1 か月前から` **0 件** / 796 件。其上、件数欄は数を
 * 落とした語を名乗つて、其れは絞り込めないと書いて居た –「年後から = 其れより後の締切の事だと
 * 思いますが、前の語を此の表の日として探せないので検索欄では絞り込めません」– 同じ事を一語で打てば
 * 41 件出て其の案内は出ない（打ち方の位置だけで噓が変わる形を残さない – 第 468 回・第 332 回）。
 * 直しは数の語と単位の語を一つに寄せる目を一段目に足した（実測 – 数 9 種 × 単位 16 種 × 語尾 12 種 ×
 * 詰め ⇔ 離し × 後続語 + 対照の群で、前回のビルドと此の回のビルドに共通する 5 350 語を較べ、
 * **行の差 740 語（全部 0 件から）・減つた物 0 語・案内の差 972 語**）。
 * 受けるのは**語尾が空格を挟まず直に付く形だけ** – 空格を挟む形（`3 か月後 まで`・`1 年後 から`）は
 * 其の方が既に解けて通り、其處は打たれた空格の侭を名乗る決まり（第 459 回・第 466 回）なので、
 * 先に寄せると名乗りだけが化ける（実測 – `3 か月後 まで` の件数欄が「3か月後 まで = …」になつた）。*/
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

describe("数を離つて打った相対日と語尾が詰め形と同じ行に出る（第 477 回）", () => {
  it("七の対が詰め形と一字も違わない行に出る（実測 – 前は離つた側が 0 件だつた）", () => {
    for (const [離, 繋] of [
      ["1 年後から", "1年後から"],
      ["1 か月後から", "1か月後から"],
      ["1 ヶ月後から", "1ヶ月後から"],
      ["半 年後から", "半年後から"],
      ["1 か月前から", "1か月前から"],
      ["2 週間後から", "2週間後から"],
      ["一 か月後から", "一か月後から"],
    ] as Array<[string, string]>) {
      expect([離, 列(離).size]).toEqual([離, 列(繋).size]);
    }
    expect(列("1 か月後から").size).toBe(362);
    /* 全角の数字も同じ – 入力の幅として受ける（実測 – 全角の数字だけを頭から落とす改ざんが
     * 検査を落さなかつたので、此の張りを足した）。*/
    for (const [離, 繋] of [
      ["１ か月後から", "1 か月後から"],
      ["２ 週間後から", "2 週間後から"],
      ["１ 年後から", "1 年後から"],
    ] as Array<[string, string]>) {
      expect([離, 列(離).size]).toEqual([離, 列(繋).size]);
    }
  });
  it("行数の実測（固定ハーネスの品書 435 行）", () => {
    expect(列("1 年後から").size).toBe(1);
    expect(列("1 年後以降").size).toBe(1);
    expect(列("1 年後まで").size).toBe(435);
    expect(列("1 か月後まで").size).toBe(161);
    expect(列("1 か月後までに").size).toBe(161);
    expect(列("半 年後から").size).toBe(94);
    expect(列("1 か月前から").size).toBe(427);
    expect(列("2 週間後から").size).toBe(413);
    expect(列("10 か月後から").size).toBe(4);
  });
  it("件数欄が数を落とした語を名乗る噓が消えた（幅で絞れる形は無言）", () => {
    for (const 文 of ["1 年後から", "1 か月後から", "半 年後から", "1 か月前から"]) {
      expect(案内(文), `「${文}」に前の噓の案内が残つた`).toBe("");
      expect([文, 列(文).size > 0]).toEqual([文, true]);
    }
    /* 其れまでの語尾を直に付けた形は其の範囲を書く（数を落とさない）。*/
    expect(案内("1 年後まで")).toContain("1年後まで = 2026年8月9日(日)〜2027年8月9日(月)");
    expect(案内("1 か月後まで")).toContain("1か月後まで = 2026年8月9日(日)〜9月9日(水)");
  });
  it("後ろにその他の語を続けても効く", () => {
    expect(列("ml 1 か月後から 締切").size).toBe(12);
    expect(列("1 年後から の 締切").size).toBe(1);
  });
});

describe("寄せない形の守り（第 459 回・第 466 回）", () => {
  it("語尾が空格を挟む形は触らない – 名乗りは打たれた侭", () => {
    /* 実測 2026-11-08 – 此の段が先に寄せると件数欄の名乗りだけが化けた（「3か月後 まで = …」）。*/
    expect(案内("3 か月後 まで")).toContain("3 か月後 まで = 2026年8月9日(日)〜");
    expect(案内("1 年後 まで")).toContain("1 年後 まで = 2026年8月9日(日)〜");
    expect(案内("1 か月後")).toContain("1 か月後 = 2026年9月9日(水)");
    expect(列("3 か月後 まで").size).toBe(367);
    expect(列("1 年後 まで").size).toBe(435);
    expect(列("1 年後 から").size).toBe(列("1 年後から").size);
  });
  it("其の品書に其の日が無い形は 0 件の侭（締切の推測はしない）", () => {
    /* `1 年前から`（2025年8月9日から）と `2 年後から`（2028年8月9日から）は、其れより後の締切が
     * この品書に在らん為 0 件 – 前は案内さへ出なかつたが、今は其の方の幅に解けた結果の 0 件。*/
    expect(列("1 年前から").size).toBe(0);
    expect(列("2 年後から").size).toBe(0);
    expect(列("1 年前から 締切").size).toBe(0);
    expect(案内("1 年前から")).toBe("");
  });
  it("数字で無い頭は寄せない", () => {
    expect(列("この 半年").size).toBe(0);
    expect(案内("この 半年")).toContain("半年 = 2026年8月9日(日)");
    expect(列("ml から").size).toBe(0);
    expect(列("論文から").size).toBe(0);
  });
  it("第 470 回〜第 476 回の実測は此の回で変へて居ない", () => {
    expect(列("週 末").size).toBe(146);
    expect(列("来月 上旬 まで").size).toBe(180);
    expect(列("明日から").size).toBe(423);
    expect(列("来 週末").size).toBe(34);
    expect(案内("来 週末")).toContain("来週末 = 2026年8月15日(土)");
    expect(列("8 月の 締切").size).toBe(114);
    expect(列("明日 から 明後日").size).toBe(4);
    expect(列("来月上旬から").size).toBe(389);
  });
});

describe("ビルド成果物に目が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("数の寄せ目が語尾を直に受ける形として現れる", () => {
    expect(
      物.match(/\(\?=\(\?:から\|より\|以降\|以後\|この先\|以来\|までに\|まで\)\)/g)?.length,
    ).toBe(1);
    expect(物).toContain("年後|年前|か月後");
    expect(物.match(/日の語か/g)?.length).toBeGreaterThan(1);
  });
  it("前の五回の目の字面を壊して居ない", () => {
    expect(物.match(/複合語の切れ目/g)?.length).toBe(2);
    expect(物.match(/離した幅の区切りJa/g)?.length).toBe(2);
    expect(物.match(/繋がれた幅の尾Ja/g)?.length).toBe(2);
    expect(物.match(/単位に付いた助字/g)?.length).toBe(2);
    expect(物.match(/月の付いた塊/g)?.length).toBe(3);
  });
});
