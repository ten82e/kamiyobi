/**
 * 位（頃・あたり・前後・ぐらい）を付けた形 – 月語に日を繋げた形と『までに』の方（第 403 回）。
 *
 * 実測（2026-09-28 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻
 * 2026-08-09T00:00:00Z）: `明日頃` 4 行・`来週火曜頃` 6 行・`8月22日頃` 12 行が通るのに、
 * **月語に日を繋げた形だけ 0 行**（`来月10日頃` **0 行**・`来月10日あたり` **0 行**・
 * `来月10日前後` **0 行**・`来月10日ぐらい` **0 行**）。又『までに』の方では位の語を剥がす
 * 規則が効かず、`8月22日までに` 11 行・`8月22日頃` 12 行が通るのに `8月22日頃までに`
 * **0 行**（案内も無し）だつた。
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

function 和集合(語々: string[]): Set<string> {
  const 和 = new Set<string>();
  for (const 語 of 語々) for (const 行 of 列(語)) 和.add(行);
  return 和;
}

function 案内(語: string): string {
  const 関数 = Recommender as unknown as Record<string, (語: string, 時刻: number) => string[]>;
  const 相対 = 関数.relativeDayNotes(語, 基準);
  if (相対.length) return 相対[0];
  return (Recommender.dayRangeLiveNoteJa(語) as unknown as string) || "";
}

describe("位を付けた形", () => {
  it("月語に日を繋げた形も其の方の暦日で受ける（其の日だけで探す方と対称差 0）", () => {
    expect(列("来月10日").size, "対照の「来月10日」が 0 行").toBeGreaterThan(0);
    for (const [位を付けた形, 日のみ] of [
      ["来月10日頃", "来月10日"],
      ["来月10日ころ", "来月10日"],
      ["来月10日あたり", "来月10日"],
      ["来月10日辺り", "来月10日"],
      ["来月10日前後", "来月10日"],
      ["来月10日ぐらい", "来月10日"],
      ["来月10日位", "来月10日"],
      ["再来月5日頃", "再来月5日"],
      ["今月15日頃", "今月15日"],
    ] as Array<[string, string]>) {
      expect(列(位を付けた形).size, `「${位を付けた形}」が行を出さない`).toBeGreaterThan(0);
      expect(
        対称差(列(位を付けた形), 列(日のみ)),
        `「${位を付けた形}」が \`${日のみ}\` と違う列表`,
      ).toBe(0);
    }
  });

  it("前後の日へ広げない（位は幅にならない）", () => {
    const 三日 = 和集合(["2026年9月9日", "2026年9月10日", "2026年9月11日"]);
    expect(三日.size, "対照の三日間が 0 行").toBeGreaterThan(0);
    expect(対称差(列("来月10日頃"), 三日) > 0, "「来月10日頃」が三日間に広がっている").toBe(true);
  });

  it("其の日が決まらない語に位を続けても解かない", () => {
    for (const 語 of ["8月頃", "来月頃", "今週頃", "8月あたり", "来週頃"]) {
      expect(列(語), `「${語}」が解けてしまった`).toEqual(new Set());
    }
    /* 其の月に其の日が在らない形（第 400 回）。 */
    expect(列("来月31日頃"), "「来月31日頃」が解けてしまった").toEqual(new Set());
  });

  it("件数欄は位を付けた語を名乗り、幅にしない理由を其の場に書く", () => {
    const 文 = 案内("来月10日頃");
    expect(
      文.startsWith("来月10日頃 = 2026年9月10日(木)の締切"),
      `案内が打たれた語を名乗らない: ${文}`,
    ).toBe(true);
    expect(文.indexOf("幅にせず") >= 0, `案内に幅にしない理由が無い: ${文}`).toBe(true);
  });
});

describe("位を付けた形に『までに』を続けた形", () => {
  it("今日からの幅として受ける（『までに』を位なしで打った方と対称差 0）", () => {
    for (const [位を付けた形, 幅] of [
      ["8月22日頃までに", "8月22日までに"],
      ["8月22日頃まで", "8月22日までに"],
      ["8月22日あたりまでに", "8月22日までに"],
      ["来月10日頃までに", "来月10日までに"],
      ["来月10日ころまでに", "来月10日までに"],
      ["明日頃までに", "明日までに"],
      ["今月31日頃までに", "今月31日までに"],
    ] as Array<[string, string]>) {
      expect(列(幅).size, `対照の「${幅}」が 0 行`).toBeGreaterThan(0);
      expect(対称差(列(位を付けた形), 列(幅)), `「${位を付けた形}」が \`${幅}\` と違う列表`).toBe(
        0,
      );
    }
  });

  it("件数欄は今日からの幅であることを言う", () => {
    const 文 = 案内("来月10日頃までに");
    expect(
      文.startsWith("来月10日頃までに = 2026年8月9日(日)〜9月10日(木)の締切"),
      `案内が幅を言わない: ${文}`,
    ).toBe(true);
  });

  it("其の日が在らない形は『までに』を続けても解かない", () => {
    expect(列("来月31日頃までに")).toEqual(new Set());
  });
});

describe("成果物", () => {
  it("位を剥がす規則が月語+日と『までに』の側に効いている", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    /* 月語に日を繋げた形も「其の日が決まる語」に数える。 */
    expect(物.match(/pressedMonthDayJa\(頭, nowMs\) !== null;/g) ?? []).toHaveLength(1);
    /* 『までに』の側 – 位の解をgateと枝と年付きの判定に入れた。 */
    expect(物.match(/if \(!stem && !pressed && !暦 && !位の解\)/g) ?? []).toHaveLength(1);
    expect(物.match(/else if \(位の解\)/g) ?? []).toHaveLength(1);
    expect(物.match(/exec\(位の解\[0\]\)/g) ?? []).toHaveLength(1);
    expect(
      物.match(
        /const 年付きのみ = 暦 !== null \|\| 数値 !== null \|\| pressedMonthDay !== null \|\| 位の解 !== null;/g,
      ) ?? [],
    ).toHaveLength(1);
  });
});
