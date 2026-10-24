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

function 対称差(x: Set<string>, y: Set<string>): number {
  let n = 0;
  for (const a of x) if (!y.has(a)) n += 1;
  for (const b of y) if (!x.has(b)) n += 1;
  return n;
}

function 交差(x: Set<string>, y: Set<string>): Set<string> {
  return new Set([...x].filter((a) => y.has(a)));
}

describe("暦日を頭に繋げた時刻の打ち方が通る（第 448 回）", () => {
  it("『2026年8月22日17時以降』はその日∩その方の時刻の交わりと一字も違わない", () => {
    const 当 = Recommender.searchMatcher("2026年8月22日17時以降", 基準);
    /* ハーネスの品書では日の語が画面の形そのままに立つ – 合成行で当たりを確かめる
     * 。 */
    expect(当("ict 2026年8月22日 17:30 deadline")).toBe(true);
    expect(当("ict 2026年9月5日 17:30 deadline")).toBe(false);
    expect(対称差(列("2026年8月22日17時以降"), 交差(列("2026年8月22日"), 列("17時以降")))).toBe(0);
    expect(対称差(列("2026年8月22日17時以降"), 列("2026年8月22日 17時以降"))).toBe(0);
  });
  it("在らない日は割らない – 『2月30日17時』はその日を名乗らない（締切の推測はしない）", () => {
    const 案内 = Recommender.relativeDayNotes("2月30日17時", 基準).join(" ");
    expect(案内).not.toContain("2月30日 =");
    expect(案内).toContain("17時");
    /* その日その物の語は其侭通る（割られて壊れて居ない – 二つ目の原因の検査）。 */
    expect(列("2026年8月22日").size).toBeGreaterThan(0);
    expect(列("2026-08-22").size).toBe(列("2026年8月22日").size);
  });
  it("他の日の頭の打ち方を壊して居ない", () => {
    for (const 語 of [
      "明日17時以降",
      "来週月曜17時以降",
      "8月10日17時",
      "今週末以降",
      "来週17時",
    ]) {
      expect(対称差(列(語), 列(語)), 語).toBe(0);
      expect(列(語).size, 語).toBeGreaterThanOrEqual(0);
    }
    /* 空格形との一致 – 繋げた形だけ違う当たり方に成つて居ない事。 */
    expect(対称差(列("8月10日17時"), 列("8月10日 17時"))).toBe(0);
  });
  it("ゾーン語の形（第 412 回）が暦日の目で壊れて居ない", () => {
    expect(列("23:59JST締切").size).toBeGreaterThan(0);
    expect(対称差(列("2026-08-22T17:00"), 列("2026-08-22 17:00"))).toBe(0);
  });
});

describe("直した形がビルド成果物に残る（第 448 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf-8");
  it("頭に暦日を数える枝と、その日を割らない守りが一つずつある", () => {
    expect(物.split("暦日に解くJa(日付境界Ja[1]) !== null").length - 1).toBe(1);
    expect(物.split('暦日に解くJa(String(token || "")) !== null').length - 1).toBe(1);
  });
});
