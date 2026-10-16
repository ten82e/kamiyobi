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

describe("それより後の語を空格で離して打っても案内が届く（第 447 回）", () => {
  for (const 語 of ["17時 JST 以降", "以降"]) {
    it(`『${語}』は打ち直し導きを出す（行は 0 の侭 – 起点が決まらない）`, () => {
      const 案内 = Recommender.uiWordNoteJa(語);
      expect(案内, 語).toContain("起点");
      expect(案内, 語).toContain("8月22日以降");
      /* 絞り込みを増やさない – その方の決まりの侭 0 行。 */
      expect(列(語).size, 語).toBe(0);
    });
  }
  it("繋がつて解ける形は案内に塞がれない（『以降』だけで 538 行が通る侭）", () => {
    /* 元から通つていた繋がった形 – 案内を出して塞いだらこちらが壊れる。 */
    /* ハーネスの品書（435 行）では 181 行 – 実ビルドでは同じ形が 538 行。 */
    expect(列("17時以降 JST").size).toBe(181);
    expect(列("17時 JST 以降").size).toBe(0);
    expect(Recommender.uiWordNoteJa("17時以降")).not.toContain("起点が何か決まらない");
  });
  it("『来月 以降』のやうに月の語から離した形も打ち直し導きが出る", () => {
    expect(Recommender.uiWordNoteJa("来月 以降")).toContain("繋げて");
  });
  it("『17時 以降』は第 464 回で解ける – 範囲の案内が出て、打ち直し導きは 0 件ではないので画面に出ない", () => {
    for (const 語 of ["17時 以降", "JST 17時 以降"]) {
      expect(列(語).size, 語).toBe(181);
      const 案内 = Recommender.relativeDayNotes(語, 基準).join("");
      expect(`${語} -> ${案内}`).toContain("17:00〜23:59");
      /* 導きの語自体は画面の語の組に残つている（語尾単独の打ち方がある為）が、件数欄は
       * 0 件の時だけ画面に出る見張りに通る（上の見張りの決まりはその侭）。*/
    }
    expect(列("17時以降").size).toBe(181);
  });
});

describe("それより前も空格混じりで案内が出る（第 447 回）", () => {
  it("『17時 JST 以前』はそれより前の案内の仲間を受ける（第 390 回からの regression 張）", () => {
    expect(Recommender.uiWordNoteJa("17時 JST 以前")).toContain("それより前");
    expect(列("17時 JST 以前").size).toBe(0);
  });
  it("裸の『前』は塞がない – その侭当たりとして通る（第 397 回の決まり）", () => {
    expect(Recommender.uiWordNoteJa("前")).not.toContain("それより前");
    expect(列("前").size).toBeGreaterThan(0);
  });
});

describe("直した形がビルド成果物に残る（第 447 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf-8");
  it("それより後をそれ単独で打つ族の語列が入つている", () => {
    expect(物.split('words: ["以降", "以後", "この先", "以来"]').length - 1).toBe(1);
  });
});
