/**
 * 日を並べた語の区切り（`または` `もしくは` `あるいは` `及び` `ならびに` `か`）– 第 406 回。
 *
 * 実測（2026-10-03 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻
 * 2026-08-09T00:00:00Z）: `と` で並べた形は通る（`明日と明後日` 13 行・`3日後と5日後` 22 行・
 * `8月10日と8月20日` 17 行・`来週と再来週` 91 行）のに、其れ以外の書き下しの語で並べた形は
 * 全部 0 行だつた – `明日または明後日` **0 行**（語組が `明日また` + `明後日` に割れる）・
 * `3日後または5日後` **0 行**・`8月10日または8月20日` **0 行**・`来週または再来週` **0 行**・
 * `明日もしくは明後日` **0 行**（`しく` の様な壊れた語が交じる）・`8月及び9月` **0 行**・
 * `来週ならびに再来週` **0 行**・`8月10日か8月20日` **0 行**。
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

function 対称差(甲: Set<string>, 乙: Set<string>): number {
  return [...甲].filter((行) => !乙.has(行)).length + [...乙].filter((行) => !甲.has(行)).length;
}

function 和集合(...語々: string[]): Set<string> {
  const 和 = new Set<string>();
  for (const 語 of 語々) for (const 行 of 列(語)) 和.add(行);
  return 和;
}

describe("日を並べた語の区切り", () => {
  it("其れぞれの語の和集合に受ける（`と` で並べた形と同じ広さ）", () => {
    for (const [並べた形, 語々] of [
      ["明日または明後日", ["明日", "明後日"]],
      ["明日もしくは明後日", ["明日", "明後日"]],
      ["明日あるいは明後日", ["明日", "明後日"]],
      ["明日か明後日", ["明日", "明後日"]],
      ["3日後または5日後", ["3日後", "5日後"]],
      ["8月10日または8月20日", ["8月10日", "8月20日"]],
      ["8月10日及び8月20日", ["8月10日", "8月20日"]],
      ["8月10日か8月20日", ["8月10日", "8月20日"]],
      ["来週または再来週", ["来週", "再来週"]],
      ["来週ならびに再来週", ["来週", "再来週"]],
      ["8月及び9月", ["8月", "9月"]],
    ] as Array<[string, string[]]>) {
      const 和 = 和集合(...語々);
      expect(和.size, `対照の和集合（${語々.join("/")}）が 0 行`).toBeGreaterThan(0);
      expect(列(並べた形).size, `「${並べた形}」が行を出さない`).toBeGreaterThan(0);
      expect(対称差(列(並べた形), 和), `「${並べた形}」が和集合と違う列表`).toBe(0);
    }
  });

  it("其の方の仮名（`と`）で並べた形と完全に同じ行集合になる", () => {
    for (const [語, と形] of [
      ["明日または明後日", "明日と明後日"],
      ["3日後または5日後", "3日後と5日後"],
      ["8月10日または8月20日", "8月10日と8月20日"],
      ["来週または再来週", "来週と再来週"],
      ["8月及び9月", "8月と9月"],
    ] as Array<[string, string]>) {
      expect(列(と形).size, `対照の \`${と形}\` が 0 行`).toBeGreaterThan(0);
      expect(対称差(列(語), 列(と形)), `「${語}」が \`${と形}\` と違う列表`).toBe(0);
    }
  });

  it("先頭の語の月を継ぐ形も `と` で並べた形と同じ", () => {
    for (const [語, と形] of [
      ["8月10日または上旬", "8月10日と上旬"],
      ["8月下旬または9月上旬", "8月下旬と9月上旬"],
    ] as Array<[string, string]>) {
      expect(列(語).size, `「${語}」が行を出さない`).toBeGreaterThan(0);
      expect(対称差(列(語), 列(と形)), `「${語}」が \`${と形}\` と違う列表`).toBe(0);
    }
  });
});

describe("守り", () => {
  it("其の日を決めない語が一片でも交じれば解かない", () => {
    /* `半月後または半月前` は解ける形になった（第 426 回 – 半月 = 15 日の決まる日）。
     * 裸の`半月`（日を決めない幅の語）が一片でも交じる形は其侭解かない。*/
    for (const 語 of ["明日または半月", "3日後または15日以内"]) {
      expect(列(語), `「${語}」が解けてしまった（締切の推測になる）`).toEqual(new Set());
    }
  });

  it("語を並べただけの打ち方は助詞で割る侭（和集合にしない）", () => {
    expect(列("人").size, "対照の `人` が 0 行").toBeGreaterThan(0);
    for (const 語 of ["人と機械", "東京または大阪", "会議の日程と査読"]) {
      expect(列(語), `「${語}」が和集合に化けた`).toEqual(new Set());
    }
  });

  it("後に語が控える打ち方（`8月22日までに締切`）は語に割る侭", () => {
    for (const 語 of ["8月22日までに締切", "来月10日に締切", "明日に締切"]) {
      expect(列(語).size, `「${語}」が行を出さない`).toBeGreaterThan(0);
    }
  });

  it("幅の言い方は幅の侭", () => {
    expect(
      対称差(列("3日後から5日後"), 和集合("3日後", "4日後", "5日後")),
      "幅の言い方が幅の外の日を混ぜた",
    ).toBe(0);
    expect(
      対称差(列("3日後から5日後"), 和集合("3日後", "5日後")) > 0,
      "幅の言い方が二つの端の和集合に化けた",
    ).toBe(true);
  });
});

describe("成果物", () => {
  it("並べた語の区切りが一個所に決まつている", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/const 列挙の区切りJa = [^\n]*;/g) ?? []).toHaveLength(1);
    expect(
      物.match(/\.split\(列挙の区切りJa\)/g) ?? [],
      "区切りが列挙の処で読まれていない",
    ).toHaveLength(1);
    /* 助詞で割る処は日を並べた語を語ごと残す（壊れた語を作らない）。 */
    expect(
      物.match(/if \(列挙の語に割るJa\(String\(token \|\| ""\)\)\)/g) ?? [],
      "助詞で割る処の守りが無い",
    ).toHaveLength(1);
    /* `か` は他の語の中にも入るので、上の区切りで割れ無かつた時だけ試す。 */
    expect(物.match(/if \(断片\.length < 2\) \{/g) ?? []).toHaveLength(1);
    expect(物.match(/\.split\("か"\)/g) ?? []).toHaveLength(1);
  });
});
