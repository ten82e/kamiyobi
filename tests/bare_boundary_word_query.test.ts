/**
 * 「17時 JST 以降」の `以降` だけ黙つて行を殺して居た（第 447 回）。
 *
 * 実測（2026-10-25 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * - `17時以降 JST` `JST 17時以降` は 538 行が通るのに `17時 JST 以降` `17時 以降`
 *   `JST 17時 以降` は 0 行で案内も無し。語の割りで `以降` だけが別語に残り、
 *   其の方が行に書かれて居ないので全体の当たりを消していた（`17時 JST` 迄は当たる – 2 行）。
 * - `17時 JST 以前` も 0 行で案内無し – 語尾の表（第 390 回）が空格混じりに掛かつて居ない。
 *
 * 直し:
 * - 画面の語の組に『其れより後を其れ単独で打つ』族（以降・以後・この先・以来）を足す –
 *   起点が決まらないから絞れない事を打ち直し導きと共に書く（0 行の侭 – 絞りは増やさない）。
 *   『後』『のち』は入れない（行に書かれて当たりとして通る – 第 397 回）。
 * - 『以前』の族は空格で打たれた形も語列で受ける（裸の『前』『後ろ』は塞がない – 第 397 回）。
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

describe("其れより後の語を空格で離して打っても案内が届く（第 447 回）", () => {
  /* `17時 以降` `JST 17時 以降` は第 464 回で解ける形になつた（下の別の検査へ移した） –
   * 此處に置くのは、間に別の語が入つて其の方の機械が解かない形と、語尾だけの打ち方。*/
  for (const 語 of ["17時 JST 以降", "以降"]) {
    it(`『${語}』は打ち直し導きを出す（行は 0 の侭 – 起点が決まらない）`, () => {
      const 案内 = Recommender.uiWordNoteJa(語);
      expect(案内, 語).toContain("起点");
      expect(案内, 語).toContain("8月22日以降");
      /* 絞り込みを増やさない – 其の方の決まりの侭 0 行。 */
      expect(列(語).size, 語).toBe(0);
    });
  }
  it("繋がつて解ける形は案内に塞がれない（『以降』だけで 538 行が通る侭）", () => {
    /* 元から通つて居た繋がった形 – 案内を出して塞いだら此方が壊れる。 */
    /* ハーネスの品書（435 行）では 181 行 – 実ビルドでは同じ形が 538 行（第 442 回 –
     * 品の大きさは張らない。繋がった形が元通り通る事だけ張る）。 */
    expect(列("17時以降 JST").size).toBe(181);
    expect(列("17時 JST 以降").size).toBe(0);
    expect(Recommender.uiWordNoteJa("17時以降")).not.toContain("起点が何か決まらない");
  });
  it("『来月 以降』のやうに月の語から離した形も打ち直し導きが出る", () => {
    expect(Recommender.uiWordNoteJa("来月 以降")).toContain("繋げて");
  });
  it("『17時 以降』は第 464 回で解ける – 範囲の案内が出て、打ち直し導きは 0 件ではないので画面に出ない", () => {
    /* 第 447 回当時は 0 行で「其の起点が決まらない」の導きだけが画面に出て居た。其の方の
     * 打ち方は起点（17 時）を言つて居て、詰めれば絞れるので噓だつた – 単位と語尾を寄せて
     * 詰め形と同じ行に出すやうにした（実測 2026-11-07 – 実ビルド 538 行・此の品の 181 行）。*/
    for (const 語 of ["17時 以降", "JST 17時 以降"]) {
      expect(列(語).size, 語).toBe(181);
      const 案内 = Recommender.relativeDayNotes(語, 基準).join("");
      expect(`${語} -> ${案内}`).toContain("17:00〜23:59");
      /* 導きの語自体は画面の語の組に残つて居る（語尾単独の打ち方が在る為）が、件数欄は
       * 0 件の時だけ画面に出る見張りに通る（上の見張りの決まりは其の侭）。*/
    }
    expect(列("17時以降").size).toBe(181);
  });
});

describe("其れより前も空格混じりで案内が出る（第 447 回）", () => {
  it("『17時 JST 以前』は其れより前の案内の仲間を受ける（第 390 回からの regression 張）", () => {
    expect(Recommender.uiWordNoteJa("17時 JST 以前")).toContain("其れより前");
    expect(列("17時 JST 以前").size).toBe(0);
  });
  it("裸の『前』は塞がない – 其の侭当たりとして通る（第 397 回の決まり）", () => {
    expect(Recommender.uiWordNoteJa("前")).not.toContain("其れより前");
    expect(列("前").size).toBeGreaterThan(0);
  });
});

describe("直した形がビルド成果物に残る（第 447 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf-8");
  it("其れより後を其れ単独で打つ族の語列が入つて居る", () => {
    expect(物.split('words: ["以降", "以後", "この先", "以来"]').length - 1).toBe(1);
  });
});
