/**
 * 「3日あたり」を打つ人だけ黙つて居た – 位（頃・あたり）は満の日付と相対日にだけ効いた（第 432 回）。
 *
 * 実測（2026-10-24 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `3日` 80 行・`8月15日あたり` 31 行・`明日あたり` 4 行が通るのに、裸の日に位を繋げた
 * `3日あたり` `3日頃` `3日前後` は **0 行で案内も無し**。仮名の『ごろ』は尾の列挙自体に
 * 無く、満の日付の `8月15日ごろ` `明日ごろ` も 0 行だつた（同じ音の「頃」「ころ」は通る）。
 *
 * 直し –
 * - 位の語の列挙に『ごろ』を足す（満の日付・相対日・月語+日全部に効く）
 * - 裸の日（月を決めない日）を頭を持つ位付きは、裸の日と同じ十二か月の並びで解く
 *   （毎月の其の日 – 年を決めない語なので繰り上げも裸の日と同じ）
 * 幅は広げない – 「頃」「あたり」は其の日だけで絞る（第 377 回の決まり）。
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

function 対称差(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (!b.has(x)) n += 1;
  for (const x of b) if (!a.has(x)) n += 1;
  return n;
}

describe("裸の日+位は裸の日と同列（第 432 回）", () => {
  const 対: Array<[string, string]> = [
    ["3日あたり", "3日"],
    ["3日頃", "3日"],
    ["3日ごろ", "3日"],
    ["3日ころ", "3日"],
    ["15日あたり", "15日"],
    ["24日辺り", "24日"],
    ["31日あたり", "31日"],
  ];
  for (const [語, 親] of 対) {
    it(`『${語}』は『${親}』と同列で空ではない`, () => {
      const A = 列(語);
      const B = 列(親);
      /* 同じ一覧検査の空振り防止 – 両側 0 行なら対称差 0 は空（第 428 回の教訓）。 */
      expect(B.size, 親).toBeGreaterThan(0);
      expect(A.size, 語).toBe(B.size);
      expect(対称差(A, B), 語).toBe(0);
    });
  }
});

describe("満の日付・相対日でも仮名の『ごろ』が効く（第 432 回）", () => {
  it("8月15日ごろ は 8月15日 と同列", () => {
    const A = 列("8月15日ごろ");
    const B = 列("8月15日");
    expect(B.size).toBeGreaterThan(0);
    expect(対称差(A, B)).toBe(0);
  });
  it("明日ごろ・来月10日ごろ は親と対称差 0", () => {
    for (const [語, 親] of [
      ["明日ごろ", "明日"],
      ["来月10日ごろ", "来月10日"],
    ]) {
      expect(対称差(列(語), 列(親)), 語).toBe(0);
    }
  });
});

describe("案内が実物とズレない（第 432 回）", () => {
  it("裸の日の位付きは『毎月 N 日』と書く", () => {
    for (const 語 of ["3日あたり", "15日頃", "15日ごろ", "3日ごろ"]) {
      const n = Recommender.relativeDayNotes(語, 基準).join("、");
      expect(n, 語).toContain(語);
      expect(n, 語).toMatch(/毎月\d+日の締切/);
      expect(n, 語).toContain("他の月の其の日も含まれます");
      /* 十二個の内の一つだけのやうに書いては嘘になる */
      expect(n, 語).not.toMatch(/202\d年\d+月\d+日/);
    }
  });
  it("満の日付の位付きは其の方の暦日を書く（第 377 回）", () => {
    const n = Recommender.relativeDayNotes("8月15日ごろ", 基準).join("、");
    expect(n).toContain("2026年8月15日(土)");
  });
});

describe("寄せない決まりは不変（第 432 回）", () => {
  it("其の日が決まらない位は其侭黙る – 締切の推測をしない", () => {
    expect(列("8月頃").size).toBe(0);
    expect(列("3日前後").size).toBe(0);
    expect(Recommender.relativeDayNotes("3日前後", 基準).join("")).toBe("");
    expect(列("5日位").size).toBe(0);
    expect(列("32日あたり").size).toBe(0);
    expect(列("0日あたり").size).toBe(0);
    /* 行に当たらぬ日（32日）は案内も出さない – 緩めた上限は行を変えぬまま嘘を書く。*/
    expect(Recommender.relativeDayNotes("32日あたり", 基準).join("")).toBe("");
    expect(Recommender.relativeDayNotes("0日あたり", 基準).join("")).toBe("");
    expect(列("来月あたり").size).toBe(0);
    expect(列("9月あたり").size).toBe(0);
  });
  it("其它は其侭", () => {
    expect(列("aiとml").size).toBe(17);
    expect(列("").size).toBe(436);
    expect(Recommender.relativeDayNotes("aiとml", 基準).join("")).toBe("");
  });
});

describe("割りの形がビルド成果物に残る（第 432 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("ごろ・裸日の十二か月展開・毎月の案内が入つて居る", () => {
    for (const 形 of [
      "頃|ころ|ごろ|辺り",
      "並び.push(`${月}月${裸日[1]}日`);",
      "他の月の其の日も含まれます",
    ]) {
      expect(物.split(形).length - 1, 形.slice(0, 18)).toBeGreaterThan(0);
    }
  });
});
