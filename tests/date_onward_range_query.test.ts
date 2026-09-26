/**
 * 暦日を打って「其れより後」と書く形 – 第 413 回。
 *
 * 実測（2026-10-08 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻
 * 2026-08-09T00:00:00Z）: 月の語で打つ `9月以降` は其の月から暦年の終わりまでを絞るのに
 * （703 行）、暦日を打つ形は總て 0 行だった – `8月22日以降` **0 行**（其の日から暦年の
 * 終わりまでは 744 行）・`8月22日以後` **0 行**・`9月15日から` **0 行**・
 * `2026年11月3日以降` **0 行**・`12月31日以降` **0 行**。其の上、件の数欄は
 * 「初期画面は締切の近い順に並んでいて、その以降の締切も並びます」と書いて居た –
 * 其の日より前の締切も並ぶので、其れは噓になる。`2月30日以降` は在ら無い日
 * （`2027年2月30日`）を名乗つて居た。
 *
 * 直し – 其の日のある月は暦日、其れ以降の月は暦月で受ける（月の語で打つ形と同じ決まり）。
 * 相対語（`明日以降` `来週から`）の非絞り込み（第 328 回）は其侭。
 *
 * 下の検査は検査用ビルドの品書（435 行）で見る – 期待する和集合も同じ品書から作る。
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
  const 全 = new Set<string>();
  for (const 語 of 語々) for (const 行 of 列(語)) 全.add(行);
  return 全;
}

/** 其の日から暦年の終わりまでの語 – 其の日のある月は暦日、其れ以降の月は暦月。 */
function その日から年末までの語(年: number, 月: number, 日: number): string[] {
  const 語々: string[] = [];
  const 末日 = new Date(Date.UTC(年, 月, 0)).getUTCDate();
  for (let 日付 = 日; 日付 <= 末日; 日付 += 1) 語々.push(`${年}年${月}月${日付}日`);
  for (let 月目 = 月 + 1; 月目 <= 12; 月目 += 1) 語々.push(`${年}年${月目}月`);
  return 語々;
}

describe("暦日を打って其れより後と書く形", () => {
  it("其の日から暦年の終わりまでの行が出る", () => {
    for (const [語, 年, 月, 日] of [
      ["8月22日以降", 2026, 8, 22],
      ["9月15日から", 2026, 9, 15],
      ["10月1日以降", 2026, 10, 1],
      ["2026年11月3日以降", 2026, 11, 3],
    ] as Array<[string, number, number, number]>) {
      const 期待 = 和集合(その日から年末までの語(年, 月, 日));
      expect(期待.size, `品書に「${語}」で出る筈の行が在らない`).toBeGreaterThan(0);
      expect(列(語).size, `「${語}」が 0 行の侭`).toBeGreaterThan(0);
      expect(対称差(列(語), 期待), `「${語}」の当たり方が其の日から年末の和集合と違う`).toBe(0);
    }
  });

  it("『以後』『以来』も『以降』と同じ当たり方になる", () => {
    expect(対称差(列("8月22日以後"), 列("8月22日以降"))).toBe(0);
    expect(対称差(列("8月22日以来"), 列("8月22日以降"))).toBe(0);
    expect(列("8月22日以後").size, "『以後』が 0 行の侭").toBeGreaterThan(0);
  });

  it("件を絞れない打ち方 – 年を打た無い過ぎて居る月は翌年に繰る", () => {
    /* 2026-08-09 見て `3月1日以降` は 2027 年の話（暦日の幅と同じ繰り下げ）。 */
    const 期待 = 和集合(その日から年末までの語(2027, 3, 1));
    expect(対称差(列("3月1日以降"), 期待)).toBe(0);
    expect(列("3月1日以降").size).toBeGreaterThan(0);
    expect(Recommender.dayRangePairs("3月1日以降", 基準)).toEqual([
      ["3月1日以降", "2027年3月1日から2027年12月"],
    ]);
  });

  it("件の数欄に解けた範囲が出る（伏せた範囲指定にしない）", () => {
    expect(Recommender.dayRangePairs("8月22日以降", 基準)).toEqual([
      ["8月22日以降", "2026年8月22日から2026年12月"],
    ]);
    expect(Recommender.dayRangePairs("8月22日以後", 基準)).toEqual([
      ["8月22日以後", "2026年8月22日から2026年12月"],
    ]);
    /* 区切り文字の暦日（`2026-08-20から`）は幅と取り違える形 – 先に其れより後で受ける（第 413 回）。 */
    expect(Recommender.dayRangePairs("2026-08-20から", 基準)).toEqual([
      ["2026-08-20から", "2026年8月20日から2026年12月"],
    ]);
    expect(対称差(列("2026-08-20から"), 和集合(その日から年末までの語(2026, 8, 20)))).toBe(0);
    /* 絞れた形の上に「絞りません」の案内を積まない（第 252 回の決まり）。 */
    expect(Recommender.relativeDayNotes("8月22日以降", 基準)).toEqual([]);
  });

  it("暦に無い日は其の日を名乗らない（在ら無い日を画面に出さない）", () => {
    for (const 語 of ["2月30日以降", "2月29日以降"]) {
      expect(列(語).size, `在ら無い日の「${語}」が行を出して居る`).toBe(0);
      const 案内 = Recommender.relativeDayNotes(語, 基準).join("");
      expect(案内, `「${語}」の案内が出て居ない`).not.toBe("");
      expect(案内, `「${語}」の案内が在ら無い日を暦日の形で名乗つて居る`).not.toMatch(
        /[0-9]{4}年2月(?:29|30)日/,
      );
      expect(案内).toContain("絞り込まず");
    }
  });
});

describe("守り", () => {
  it("月の語で打つ其れより後は其侭暦月の並びで絞る", () => {
    const 期待 = 和集合(["2026年9月", "2026年10月", "2026年11月", "2026年12月"]);
    expect(期待.size).toBeGreaterThan(0);
    expect(対称差(列("9月以降"), 期待)).toBe(0);
    expect(対称差(列("来月以降"), 期待)).toBe(0);
    expect(Recommender.relativeDayNotes("9月以降", 基準)).toEqual([]);
  });

  it("相対語の其れより前は絞り込まない決まり（第 328 回）と案内は其侭", () => {
    for (const 語 of ["明日以降", "来週から", "上旬から", "3日後から"]) {
      const 案内 = Recommender.relativeDayNotes(語, 基準);
      expect(案内.length, `「${語}」の案内が消えた`).toBe(1);
      expect(案内[0]).toContain("並びます");
    }
    expect(列("明日以降").size).toBe(0);
    expect(列("来週から").size).toBe(0);
    /* 月を打た無い日は解かない（何月の話か決まらない – 締切の推測はしない）。 */
    expect(列("22日以降").size).toBe(0);
  });

  it("幅の打ち方と裸の暦日を変えて居ない", () => {
    const 幅 = [];
    for (let 日 = 10; 日 <= 22; 日 += 1) 幅.push(`2026年8月${日}日`);
    const 期待 = 和集合(幅);
    expect(期待.size, "品書に其の幅の行が在らない").toBeGreaterThan(0);
    expect(対称差(列("8月10日から8月22日"), 期待)).toBe(0);
    expect(列("8月22日").size, "裸の暦日が壊れた").toBeGreaterThan(0);
    expect(対称差(列("8月22日"), 列("2026年8月22日"))).toBe(0);
  });
});

describe("成果物", () => {
  it("其れより後の言い方の表と解く枝は一個所に決まる", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/以降\|以後\|以来\|この先\|から/g) ?? [], "其れより後の語尾の表").toHaveLength(
      1,
    );
    expect(物.match(/function より後を剥がす語Ja/g) ?? [], "語尾を剥がす語の宣言").toHaveLength(1);
    expect(物.match(/より後を剥がす語Ja\(/g) ?? [], "其れより後の語の呼び出し").toHaveLength(3);
    expect(
      物.match(/暦日より後の語Ja\(normalized, nowMs\);/g) ?? [],
      "当たり方側の呼び出し",
    ).toHaveLength(1);
    /* 第 446 回の『週末以降』の枝が其の方の語を呼ぶので三つ（宣言・今週末・週末）。 */
    expect(物.match(/以降の初日Ja/g) ?? [], "案内の初日を数える語").toHaveLength(3);
  });
});
