/**
 * 句読点で並べた日の列挙（`8月下旬、9月上旬` `8月10日、11日`）の打ち方（第 396 回）。
 *
 * 実測（2026-09-26 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻
 * 2026-08-09T00:00:00Z）: `と` で並べた形は第 394 回・第 395 回で受けるようになったが、
 * 句読点で並べた形は語の区切りに割れて別々の組（AND）になり、当たり方が勝手に減つて居た –
 * `8月下旬、9月上旬` **6 行**（`と` の形 173 行 – 其の内 8月下旬 91 行 + 9月上旬 82 行）、
 * `8月10日、11日` **3 行**（`と` の形 7 行）、`明日、明後日` **3 行**（`と` の形 13 行）、
 * `8/10、8/20` **37 行**（其れは 8・10・20 を含む行の事で、締切日ではない）。
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

describe("句読点で並べた日の列挙", () => {
  it("句読点で並べた形は `と` で並べた形と同じ当たり方になる", () => {
    for (const [句, 並] of [
      ["8月下旬、9月上旬", "8月下旬と9月上旬"],
      ["8月10日、11日", "8月10日と11日"],
      ["明日、明後日", "明日と明後日"],
      ["8月、11月", "8月と11月"],
      ["今週、来週", "今週と来週"],
      ["8月10日,11日", "8月10日と11日"],
      ["月曜、金曜", "月曜と金曜"],
    ] as const) {
      expect(対称差(句, 並), `${句} と ${並} が違う列表`).toBe(0);
    }
    expect(当たり列表("8月下旬、9月上旬").length, "列挙が行を出さない").toBeGreaterThan(0);
  });

  it("案内に並べた日を書く（幅では無いので「から」で無い）", () => {
    expect(案内組("8月下旬、9月上旬")).toEqual([
      ["8月下旬、9月上旬", "2026年8月21日または2026年9月1日"],
    ]);
    expect(案内組("8月10日、11日")).toEqual([
      ["8月10日、11日", "2026年8月10日または2026年8月11日"],
    ]);
    expect(案内組("明日、明後日")).toEqual([["明日、明後日", "2026年8月10日または2026年8月11日"]]);
    expect(案内組("8月、11月")).toEqual([["8月、11月", "2026年8月または2026年11月"]]);
  });

  it("スラッシュで打った日も和集合になる（其れまでは別々の語の並びだった）", () => {
    expect(案内組("8/10、8/20")).toEqual([["8/10、8/20", "8月10日または8月20日"]]);
    expect(対称差和("8/10、8/20", ["8/10", "8/20"])).toBe(0);
    /* 其の方の語を単体で打った形は其侭 – 割って別々の語として探す形にはしない。 */
    expect(当たり列表("8/10").length, "品書に其の方の日の行が無い").toBeGreaterThan(0);
  });

  it("三つ並べた形も和集合、四つまで（五つは語の並びとして其侭置く）", () => {
    expect(
      対称差和("8月下旬、9月上旬、10月上旬", ["2026年8月下旬", "2026年9月上旬", "2026年10月上旬"]),
    ).toBe(0);
    expect(案内組("8月下旬、9月上旬、10月上旬")).toEqual([
      ["8月下旬、9月上旬、10月上旬", "2026年8月21日または2026年9月1日または2026年10月1日"],
    ]);
    expect(案内組("8月、11月、12月、1月、2月")).toEqual([]);
  });

  it("日を並べた物ではない語の列挙は今まで通り AND（語を又さない）", () => {
    expect(案内組("東京、大阪")).toEqual([]);
    expect(当たり列表("東京、大阪")).toEqual(当たり列表("東京 大阪"));
    expect(案内組("機械学習、ネットワーク")).toEqual([]);
    /* 空白で並べた形は AND の侭 – 区切りによって意味を変えない。 */
    expect(案内組("明日 明後日")).toEqual([]);
    expect(当たり列表("明日 明後日").length, "品書に相対日の行が無い").toBeGreaterThan(0);
    expect(当たり列表("明日 明後日").length).toBeLessThan(当たり列表("明日、明後日").length);
    /* 継ぐ先が無い裸の日と、展開語の無い語を混んだ物は解かない – 其侭語の並び（AND）。 */
    expect(案内組("10日、20日")).toEqual([]);
    expect(当たり列表("10日、20日")).toEqual(当たり列表("10日 20日"));
    expect(当たり列表("10日").length, "品書に其の方の日の行が無い").toBeGreaterThan(0);
    expect(案内組("春、通年")).toEqual([]);
    expect(当たり列表("春、通年")).toEqual([]);
    expect(当たり列表("春").length, "品書に春の行が無い").toBeGreaterThan(0);
  });
});

describe("其れ以外の打ち方は無傷", () => {
  it("幅・列挙・語の形は其侭通る", () => {
    expect(対称差("8月10日へ8月20日", "8月10日から8月20日")).toBe(0);
    expect(対称差("8月10日と11日", "8月10日、11日")).toBe(0);
    expect(案内組("8月下旬と9月上旬")).toEqual([
      ["8月下旬と9月上旬", "2026年8月21日または2026年9月1日"],
    ]);
    expect(案内組("8月下旬から9月上旬")).toEqual([
      ["8月下旬から9月上旬", "2026年8月21日から2026年9月10日"],
    ]);
    expect(当たり列表("来週から2週間").length).toBeGreaterThan(0);
    expect(案内組("来週から2週間")).toEqual([["来週から2週間", "2026年8月10日から2026年8月24日"]]);
    expect(案内組("8月と9月の下旬")).toEqual([["8月と9月", "2026年8月または2026年9月"]]);
    expect(案内組("人と機械")).toEqual([]);
  });
});

describe("成果物", () => {
  it("句読点の列挙が語組を作る処と案内の両方に結ばれて居る", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/const 句列挙 = 句読点の列挙Ja\(raw, now\);/g) ?? []).toHaveLength(1);
    /* 断片が全部日語で決まるかを見る目印は `と` の列挙と共有（二か所で出る）。 */
    expect(物.match(/if \(!断片が皆決まるかJa\(断片\)\)/g) ?? []).toHaveLength(2);
    expect(
      物.match(/token: 句列挙\.展開\[0\], whole: 句列挙\.展開\.slice\(1\)/g) ?? [],
    ).toHaveLength(1);
    expect(物.match(/const 句列挙 = 句読点の列挙Ja\(part, nowMs\);/g) ?? []).toHaveLength(1);
    expect(物.match(/句列挙\.代表\.join\("または"\)/g) ?? []).toHaveLength(1);
    /* `と` の列挙と句読点の列挙は同じ解きを共有する – 表を二重に書かない決まり。 */
    expect(物.match(/return 断片 \? 列挙を解くJa\(断片, nowMs\) : null;/g) ?? []).toHaveLength(1);
    expect(物.match(/return 列挙を解くJa\(断片, nowMs\);/g) ?? []).toHaveLength(1);
  });
});
