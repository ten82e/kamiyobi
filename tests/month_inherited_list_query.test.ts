/**
 * 先頭の語の月を継ぐ列挙（`8月10日と11日` `8月上旬と下旬`）の打ち方（第 395 回）。
 *
 * 実測（2026-09-26 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻
 * 2026-08-09T00:00:00Z）: `8月10日` 4 行・`8月11日` 12 行・`8月上旬` 35 行・`8月下旬` 91 行・
 * `下旬` 91 行が通るのに、`8月10日と11日`・`8月15日と20日`・`8月1日と15日と30日`・
 * `8月上旬と8月下旬`・`8月上旬と下旬` は **0 行・案内も無し**だった（第 394 回で `と` の列挙を
 * 受けたが、裸の日と裸の旬を弾いて居た）。
 * 継がせないで其の方の語を其侭語組に渡すと裸の日は十二か月分に広がる – 其処を通すと
 * `8月10日と11日` が 96 行（其の内 8月11日 12 行 + 8月10日 4 行だけの話では無い）に化けた
 * （実測 – 其のままでは間違った広さなので継がせた）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  return Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
}

function 当たり列表(語: string): string[] {
  const 当 = Recommender.searchMatcher(語, 基準);
  return 品書()
    .filter((行) => 当(String(行.hay)) === true)
    .map((行) => String(行.hay))
    .sort();
}

function 対称差(甲: string, 乙: string): number {
  const 左 = new Set(当たり列表(甲));
  const 右 = new Set(当たり列表(乙));
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}

function 対称差和(語: string, 内: string[]): number {
  const 左 = new Set(当たり列表(語));
  const 右 = new Set<string>();
  for (const 内語 of 内) for (const 行 of 当たり列表(内語)) 右.add(行);
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}

function 案内組(語: string): Array<[string, string]> {
  const 関数 = (
    Recommender as unknown as Record<string, (語: string, 時刻: number) => Array<[string, string]>>
  ).dayRangePairs;
  return 関数(語, 基準);
}

describe("先頭の語の月を継ぐ列挙", () => {
  it("裸の日を継いだ列挙は其の月の其の日だけを出す（十二か月分に広げない）", () => {
    expect(案内組("8月10日と11日")).toEqual([
      ["8月10日と11日", "2026年8月10日または2026年8月11日"],
    ]);
    expect(当たり列表("8月10日と11日").length, "列挙が行を出さない").toBeGreaterThan(0);
    expect(対称差和("8月10日と11日", ["2026年8月10日", "2026年8月11日"])).toBe(0);
    expect(案内組("8月15日と20日")).toEqual([
      ["8月15日と20日", "2026年8月15日または2026年8月20日"],
    ]);
    expect(対称差和("8月15日と20日", ["2026年8月15日", "2026年8月20日"])).toBe(0);
  });

  it("裸の旬も先頭の語の月へ継ぐ（冠を付けた形と同じ列表）", () => {
    expect(当たり列表("8月上旬").length, "品書に上旬の行が無い").toBeGreaterThan(0);
    expect(対称差和("8月上旬と下旬", ["8月上旬", "8月下旬"])).toBe(0);
    expect(対称差("8月上旬と下旬", "8月上旬と8月下旬")).toBe(0);
    expect(案内組("8月上旬と8月下旬")).toEqual([
      ["8月上旬と8月下旬", "2026年8月1日または2026年8月21日"],
    ]);
  });

  it("今月ではない月を継いだ形は其の月に継ぐ（其の侭では今月に化ける）", () => {
    expect(案内組("12月上旬と下旬")).toEqual([
      ["12月上旬と下旬", "2026年12月1日または2026年12月21日"],
    ]);
    expect(当たり列表("12月上旬と下旬").length, "継いだ月の列挙が行を出さない").toBeGreaterThan(0);
    expect(対称差和("12月上旬と下旬", ["2026年12月上旬", "2026年12月下旬"])).toBe(0);
    expect(当たり列表("2026年12月上旬").length, "品書に其の月の上旬の行が無い").toBeGreaterThan(0);
  });

  it("三つ並べた形も先頭の語の月に継ぐ", () => {
    expect(対称差和("8月1日と15日と30日", ["2027年8月1日", "2027年8月15日", "2027年8月30日"])).toBe(
      0,
    );
    /* 其の日が既に過ぎて居る時は翌年として受ける（幅の側と同じ決まり – 案内に其の年が出る）。 */
    expect(案内組("8月1日と15日と30日")).toEqual([
      ["8月1日と15日と30日", "2027年8月1日または2027年8月15日または2027年8月30日"],
    ]);
  });

  it("月を継ぐ先頭が在る形だけ受ける（`10日と20日` は解かない）", () => {
    expect(案内組("10日と20日")).toEqual([]);
    expect(当たり列表("10日と20日")).toEqual([]);
    expect(当たり列表("2026年8月10日").length, "品書に其の方の日の行が無い").toBeGreaterThan(0);
    /* 目印を通る語でも、其の方の展開がこの枝に無い語（`通年`）を混んだ列挙は解かない –
     * 片方だけの当たり方は噓になる（実測 `春` 217 行 / `通年` 0 行）。 */
    expect(案内組("春と通年")).toEqual([]);
    expect(当たり列表("春と通年")).toEqual([]);
    expect(当たり列表("春").length, "品書に春の行が無い").toBeGreaterThan(0);
    /* 冠の無い旬を継ぐ形も、先に月を名乗る語が要る。 */
    expect(案内組("上旬と下旬")).toEqual([]);
  });

  it("其の方の語を其侭打った形は今まで通り十二か月分（継がせない）", () => {
    /* 列挙の内側だけ月を継がせる – 裸の日を単体で打つ人は其の方の日を全月で探す。 */
    expect(当たり列表("11日").length, "品書に十一日の行が無い").toBeGreaterThan(0);
    expect(当たり列表("11日").length).toBeGreaterThan(当たり列表("2026年8月11日").length);
    expect(当たり列表("下旬").length, "品書に下旬の行が無い").toBeGreaterThan(0);
  });
});

describe("其れ以外の列挙と幅は無傷", () => {
  it("第 394 回で受けた形と幅の形は其侭通る", () => {
    expect(対称差("月曜と金曜", "月曜日と金曜日")).toBe(0);
    expect(対称差和("8月と11月", ["8月", "11月"])).toBe(0);
    expect(対称差和("来週月曜と来週水曜", ["来週月曜", "来週水曜"])).toBe(0);
    expect(対称差("8月10日へ8月20日", "8月10日から8月20日")).toBe(0);
    expect(案内組("8月10日へ8月20日")).toEqual([
      ["8月10日へ8月20日", "2026年8月10日から2026年8月20日"],
    ]);
    expect(当たり列表("8月10日から12日").length).toBeGreaterThan(0);
    expect(当たり列表("来週から2週間").length).toBeGreaterThan(0);
    expect(案内組("8月と半月")).toEqual([]);
    expect(案内組("人と機械")).toEqual([]);
  });
});

describe("成果物", () => {
  it("月の継承が実測どおりに成果物に入っている", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/\[0-9\]\{1,2\}日\|\[上中下\]旬/g) ?? []).toHaveLength(1);
    expect(物.match(/if \(継ぐ && 継ぐ\.length >= 2\)/g) ?? []).toHaveLength(1);
    expect(物.match(/monthPartTermsJa\(`\$\{継ぐ\[1\]\}月\$\{語\}`/g) ?? []).toHaveLength(1);
    expect(物.match(/let 継ぐ = null;/g) ?? []).toHaveLength(1);
    /* 半月の様な幅の語は列挙で解かない決まり（其の方の語は日を決めない）。 */
    expect(物.match(/if \(\/半\/\.test\(語\)\)/g) ?? []).toHaveLength(1);
  });

  it("案内は列挙の解きから代表の語だけを書く（当たり方は広く見せない）", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/pairs\.push\(\[part, 列挙\.代表\.join\("または"\)\]\)/g) ?? []).toHaveLength(
      1,
    );
    expect(物.match(/function 列挙の代表語Ja\(/g) ?? []).toHaveLength(1);
  });
});
