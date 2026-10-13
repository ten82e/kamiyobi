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

/** その日から暦年の終わりまでの語 – その日のある月は暦日、それ以降の月は暦月。 */
function その日から年末までの語(年: number, 月: number, 日: number): string[] {
  const 語々: string[] = [];
  const 末日 = new Date(Date.UTC(年, 月, 0)).getUTCDate();
  for (let 日付 = 日; 日付 <= 末日; 日付 += 1) 語々.push(`${年}年${月}月${日付}日`);
  for (let 月目 = 月 + 1; 月目 <= 12; 月目 += 1) 語々.push(`${年}年${月目}月`);
  return 語々;
}

describe("暦日を打ってそれより後と書く形", () => {
  it("その日から暦年の終わりまでの行が出る", () => {
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

  it("件を絞れない打ち方 – 年を打たない過ぎている月は翌年に繰る", () => {
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
    /* 区切り文字の暦日（`2026-08-20から`）は幅と取り違える形 – 先にそれより後で受ける。 */
    expect(Recommender.dayRangePairs("2026-08-20から", 基準)).toEqual([
      ["2026-08-20から", "2026年8月20日から2026年12月"],
    ]);
    expect(対称差(列("2026-08-20から"), 和集合(その日から年末までの語(2026, 8, 20)))).toBe(0);
    /* 絞れた形の上に「絞りません」の案内を積まない。 */
    expect(Recommender.relativeDayNotes("8月22日以降", 基準)).toEqual([]);
  });

  it("暦にない日はその日を名乗らない（在らない日を画面に出さない）", () => {
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
  it("月の語で打つそれより後は其侭暦月の並びで絞る", () => {
    const 期待 = 和集合(["2026年9月", "2026年10月", "2026年11月", "2026年12月"]);
    expect(期待.size).toBeGreaterThan(0);
    expect(対称差(列("9月以降"), 期待)).toBe(0);
    expect(対称差(列("来月以降"), 期待)).toBe(0);
    expect(Recommender.relativeDayNotes("9月以降", 基準)).toEqual([]);
  });

  it("相対語のそれより後（`以降` `から`）はその初日から絞る（第 475 回・第 476 回）", () => {
    for (const [語, 件] of [
      ["来週から", 423],
      ["上旬から", 425],
      ["3日後から", 423],
    ] as Array<[string, number]>) {
      expect(列(語).size, `「${語}」が其の初日から絞れて居ない`).toBe(件);
      expect(Recommender.relativeDayNotes(語, 基準), `「${語}」に案内が残つた`).toEqual([]);
    }
    expect(列("明日以降").size).toBe(423);
    expect(Recommender.relativeDayNotes("明日以降", 基準)).toEqual([]);
    /* 月を打た無い日（`22日以降`）はその方の月の目で今年／来年を決めて絞る。 */
    expect(列("22日以降").size).toBe(395);
  });

  it("幅の打ち方と裸の暦日を変えて居ない", () => {
    const 幅 = [];
    for (let 日 = 10; 日 <= 22; 日 += 1) 幅.push(`2026年8月${日}日`);
    const 期待 = 和集合(幅);
    expect(期待.size, "品書にその幅の行が在らない").toBeGreaterThan(0);
    expect(対称差(列("8月10日から8月22日"), 期待)).toBe(0);
    expect(列("8月22日").size, "裸の暦日が壊れた").toBeGreaterThan(0);
    expect(対称差(列("8月22日"), 列("2026年8月22日"))).toBe(0);
  });
});

describe("成果物", () => {
  it("それより後の言い方の表と解く枝は一個所に決まる", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");

    expect(物.match(/以降\|以後\|以来\|この先\|から/g) ?? [], "それより後の語尾の表").toHaveLength(
      3,
    );
    expect(物.match(/function より後を剥がす語Ja/g) ?? [], "語尾を剥がす語の宣言").toHaveLength(1);
    /* 第 475 回で `その日以降の初日Ja` もこの語を読むので四つ（案内・検索・初日・暦日の目）。 */
    expect(物.match(/より後を剥がす語Ja\(/g) ?? [], "それより後の語の呼び出し").toHaveLength(4);
    expect(
      物.match(/暦日より後の語Ja\(normalized, nowMs\);/g) ?? [],
      "当たり方側の呼び出し",
    ).toHaveLength(1);

    expect(物.match(/以降の初日Ja/g) ?? [], "案内の初日を数える語").toHaveLength(7);
  });
});
