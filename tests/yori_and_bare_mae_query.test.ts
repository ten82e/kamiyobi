/**
 * 「8月22日より」「終業前」だけ黙つて空だつた – 『より』の尾と時間帯の名前の裸の『前』（第 441 回）。
 *
 * 実測（2026-10-24 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * - `8月22日以降` 744 行・`8月22日以後`・`8月22日以来` が通るのに `8月22日より`
 *   `3月10日より` は 0 行で案内も無し – 第 369 回の『黙つて 0 行にしない』に反した。
 * - `9月から` 703 行・`9月以降` が通るのに `9月より` `8月より` は 0 行 – 幅の区切りでは
 *   『より』を受けるのに、単独の頭の形だけ受けて居なかつた。
 * - `終業前に`・`夕方以降` の断り（第 418 回）が出るのに裸の `終業前` `夕方前` `夜前` は黙つて居た。
 *
 * 直し:
 * - より後を剥がす語Ja の尾に『より』（暦日+より は第 413 回の絞る群と同じ並びで受ける –
 *   件の数欄に解けた範囲が出る）
 * - MONTH_RANGE_FROM に『より』（月の語は第 252 回から絞る群 – `9月より` ≡ `9月から`）
 * - 時間帯の名前と日の語+時間帯の尾に裸の『前』
 *
 * 第 328 回の契約（相対語の『から』『以降』は絞り込まない – 案内で其の方の日を書く）は
 * 其侭 – 対の検査で不動を見る。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 列表入口() {
  const 品 = (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
  const 済 = new Map<string, Set<string>>();
  return (語: string): Set<string> => {
    if (!済.has(語)) {
      const 当 = Recommender.searchMatcher(語, 基準);
      済.set(語, new Set(品.filter((行) => 当(行) === true)));
    }
    return 済.get(語) as Set<string>;
  };
}

const 列 = 列表入口();

function 対称差(x: Set<string>, y: Set<string>): number {
  let n = 0;
  for (const a of x) if (!y.has(a)) n += 1;
  for (const b of y) if (!x.has(b)) n += 1;
  return n;
}

describe("暦日+『より』は其の日から年末で絞れる（第 441 回）", () => {
  it("『8月22日より』は『8月22日以降』と一字も違わない", () => {
    expect(対称差(列("8月22日より"), 列("8月22日以降"))).toBe(0);
    expect(列("8月22日より").size).toBeGreaterThan(0);
    /* 絞れる形に『絞りません』の案内を残さない（第 413 回と同じ）。 */
    expect(Recommender.relativeDayNotes("8月22日より", 基準)).toEqual([]);
    expect(Recommender.dayRangePairs("8月22日より", 基準)).toEqual([
      ["8月22日より", "2026年8月22日から2026年12月"],
    ]);
  });
  it("月の語の『より』は其の月から年末 – 其の方の範囲の言い方が受ける", () => {
    expect(対称差(列("9月より"), 列("9月から"))).toBe(0);
    expect(対称差(列("8月より"), 列("8月から"))).toBe(0);
    expect(列("9月より").size).toBeGreaterThan(0);
    expect(Recommender.monthRangePairs("9月より", 基準)).toEqual([
      ["9月より", "2026年9月から2026年12月"],
    ]);
  });
  it("相対語の『から』『より』『以降』は其の初日から絞る（第 475 回・第 476 回）", () => {
    /* 第 328 回の「絞り込まない」決まりは 0 行と案内の食い違いを残して居た（実測 2026-11-08）。
     * `以降` は第 475 回で其の方が持つ幅の決まり（第 413 回）に揃へ、`から` `より` は第 476 回で
     * 受けた – 幅の終りが後に控へる形は三語を一語に継いで其の方の幅の機械に渡すので終りは消えない。*/
    for (const [語, 件] of [
      ["来週から", 423],
      ["明日から", 423],
      ["上旬から", 425],
      ["3日後から", 423],
      ["22日より", 395],
    ] as Array<[string, number]>) {
      expect(列(語).size, `「${語}」が其の初日から絞れて居ない`).toBe(件);
      expect(Recommender.relativeDayNotes(語, 基準), `「${語}」に案内が残つた`).toEqual([]);
    }
    /* 後に其它の日の語が控へる形は詰め形と同じ – 幅の終りが消えて居ない事の実測。*/
    expect(列("明日 から 明後日").size).toBe(列("明日から明後日").size);
    expect(列("明日以降").size).toBe(423);
    expect(Recommender.relativeDayNotes("明日以降", 基準)).toEqual([]);
    /* 月を打た無い日（`22日以降`）は其の方の月の目（第 252 回）で年を決めて絞る。 */
    expect(列("22日以降").size).toBe(395);
  });
});

describe("時間帯の名前の裸の『前』も断りが届く（第 441 回）", () => {
  for (const 語 of ["終業前", "夕方前", "夜前"]) {
    it(`『${語}』は 0 行の侭、時間帯の名前の断り`, () => {
      expect(列(語).size, 語).toBe(0);
      const n = Recommender.uiWordNoteJa(語);
      expect(n, 語).toContain(`「${語}」`);
      expect(n, 語).toContain("絞り込めません");
    });
  }
  it("日の語+時間帯+前も複合の断り", () => {
    expect(列("明日夕方前").size).toBe(0);
    const n = Recommender.uiWordNoteJa("明日夕方前");
    expect(n).toContain("「明日夕方前」");
    expect(n).toContain("時間帯の名前");
  });
});

describe("直した形がビルド成果物に残る（第 441 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("尾の表と月の頭の表に『より』が入つて居る", () => {
    /* 第 455 回が尾の語列を二目増やした（空格寄せの目印と芯割り） – 同じ語列の
     * 数が減ったら（改ざんで尾の表が縮んだら）落ちるように総数で張る。 */
    /* 其の方の語尾の表 1 + 其の日を決める複合語の表 1 + 月の頭の表 1 – 第 455 回の
     * 二目は其の方の語列の目（`までに` を頭に据ゑる流儀）に揃へたので増えない。 */
    expect(物.split("この先|から|より").length - 1).toBe(3);
    expect(物.split("(?:までに|まで|の)?").length - 1).toBe(1);
    expect(物.split("(までに|の)?(").length - 1).toBe(1);
    expect(物.split("/^(.+)月(?:以降|以来|から|より)$/;").length - 1).toBe(1);
    expect(物.split("(?:までに|前に|前|以降|過ぎ|後に|後)?").length - 1).toBe(2);
  });
});
