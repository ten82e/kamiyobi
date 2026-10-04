/**
 * 曜日を並べた幅（`月曜から金曜`）の打ち方（第 393 回）。
 *
 * 実測（2026-09-25 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z・
 * 其の日は日曜）:
 * - `月曜` 100 行・`土日` 268 行・`平日` 604 行・`金曜まで` 133 行が通るのに、
 *   `月曜から金曜` **0 行**・`月曜日から金曜日` **0 行**・`月曜から水曜` **0 行**・
 *   `金曜から月曜` **0 行**・`明日から金曜` **0 行**・`8月10日から金曜` **0 行**・
 *   `月曜〜金曜` **0 行**（案内も無し）。
 * - 週を付けた頭（`来週月曜から金曜`）は頭の語だけが通って居た – **0 行**。
 * 直し後は 30 行（月曜から金曜）・48 行（金曜から月曜）が出て、件数欄には解いた範囲が日付で出る。
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

function 幅の展開(語: string): string[] {
  const 関数 = (Recommender as unknown as Record<string, (語: string, 時刻: number) => string[]>)
    .dayRangeTermsJa;
  return 関数(語, 基準);
}

function 幅の案内組(語: string): Array<[string, string]> {
  const 関数 = (
    Recommender as unknown as Record<string, (語: string, 時刻: number) => Array<[string, string]>>
  ).dayRangePairs;
  return 関数(語, 基準);
}

describe("曜日を並べた幅", () => {
  it("基準の日から見て其の日以降で最初の其の曜日に解ける", () => {
    /* 2026-08-09 は日曜なので、其の週（月〜日）は 8月3日〜8月9日 – 月曜は翌日になる。 */
    expect(幅の展開("月曜から金曜")[0]).toBe("2026年8月10日");
    expect(幅の展開("月曜から金曜").at(-1)).toBe("2026年8月14日");
    expect(幅の展開("月曜から金曜")).toHaveLength(5);
    expect(幅の展開("月曜から水曜")).toEqual(["2026年8月10日", "2026年8月11日", "2026年8月12日"]);
  });

  it("尾側が頭側より早い曜日でも其の日以降に回る（五日ぶんにしない）", () => {
    expect(幅の展開("金曜から月曜")[0]).toBe("2026年8月14日");
    expect(幅の展開("金曜から月曜").at(-1)).toBe("2026年8月17日");
    expect(幅の展開("金曜から月曜")).toHaveLength(4);
  });

  it("『曜』と『曜日』の両方、記号で結んだ形も同じ列表を出す", () => {
    for (const 甲 of ["月曜から金曜日", "月曜日から金曜日", "月曜〜金曜", "月曜から金曜"]) {
      expect(対称差(甲, "月曜から金曜"), `当たり方が違う: ${甲}`).toBe(0);
    }
    /* 其の週の週末（土曜・日曜の二日）を頭に打たれた形は初日（土曜）から受ける –
     * 終日（日曜）からにすると其の土曜の締切が幅から落ちる（第 393 回 – 改ざん検査で
     * 二日の内のどちらを頭にするかを目で選んだ形が緑通しになった為、ここに張る）。 */
    expect(幅の案内組("先週末から火曜")).toEqual([
      ["先週末から火曜", "2026年8月1日から2026年8月4日"],
    ]);
    expect(当たり列表("月曜から金曜").length, "品書に曜日の幅の行が無い").toBeGreaterThan(0);
  });

  it("暦日や相対の日を頭に継いでも尾側の曜日が解ける", () => {
    expect(対称差("明日から金曜", "月曜から金曜")).toBe(0);
    expect(幅の案内組("8月10日から金曜")).toEqual([
      ["8月10日から金曜", "2026年8月10日から2026年8月14日"],
    ]);
    /* 週を付けた頭は其の方の規則で其の日が決まる（今週 = 8月3日〜8月9日 – 第 329 回）。 */
    expect(幅の案内組("来週月曜から金曜")).toEqual([
      ["来週月曜から金曜", "2026年8月10日から2026年8月14日"],
    ]);
    expect(幅の案内組("今週金曜から日曜")).toEqual([
      ["今週金曜から日曜", "2026年8月7日から2026年8月9日"],
    ]);
  });

  it("件数欄は打たれた語と解いた範囲をそのまま書く（其の方が決めた分け方を隠さない）", () => {
    expect(幅の案内組("月曜から金曜")).toEqual([
      ["月曜から金曜", "2026年8月10日から2026年8月14日"],
    ]);
    expect(幅の案内組("金曜から月曜")).toEqual([
      ["金曜から月曜", "2026年8月14日から2026年8月17日"],
    ]);
  });
});

describe("其れ以外の曜日の打ち方と幅は無傷", () => {
  it("裸の曜日・週末・平日・『まで』は今まで通り", () => {
    for (const 語 of ["月曜", "金曜", "土日", "週末", "平日", "金曜まで"]) {
      expect(当たり列表(語).length, `通らなくなった: ${語}`).toBeGreaterThan(0);
    }
    expect(
      当たり列表("月曜から金曜").length < 当たり列表("月曜").length + 当たり列表("金曜").length,
    ).toBe(true);
  });

  it("其の方の語の幅と数の幅は其侭解ける", () => {
    expect(対称差("明日から明後日", "明日〜明後日")).toBe(0);
    expect(当たり列表("明日から3日").length).toBeGreaterThan(0);
    expect(当たり列表("来週から2週間").length).toBeGreaterThan(0);
    expect(当たり列表("8月から11月").length).toBeGreaterThan(0);
    expect(対称差("8月10日から8月20日", "8/10〜8/20")).toBe(0);
  });

  it("其の方が決まって居ない形は黙つた侭（締切の推測はしない）", () => {
    expect(幅の展開("2日前から3日前")).toEqual([]);
    expect(幅の案内組("来月から再来月")).toEqual([]);
    expect(幅の展開("12日から15日")).toEqual([]);
  });
});

describe("成果物", () => {
  it("語を結ぶ語の列挙と暦日へ解く枝に曜日が在る", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    /* 案内だけが解けて当たりが 0 行、という食い違いを防ぐ為、二か所に同じ語が必要（第 393 回）。 */
    expect(物.match(/\|\[0-9\]\{1,2\}日\|\[月火水木金土日\]曜\(\?:日\)\?\)/g) ?? []).toHaveLength(
      1,
    );
    expect(
      物.match(/const 曜 = \/\^\(\[月火水木金土日\]\)曜\(\?:日\)\?\$\/\.exec\(柄\);/g) ?? [],
    ).toHaveLength(1);
    expect(
      物.match(/const 基準日 = new Date\(Date\.UTC\(基準\[0\], 基準\[1\] - 1, 基準\[2\]\)\);/g) ??
        [],
    ).toHaveLength(1);
  });
});
