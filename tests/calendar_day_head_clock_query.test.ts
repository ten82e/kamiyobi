/**
 * 「2026年8月22日17時以降」だけ黙つて居た – 暦日を頭に繋げた時刻（第 448 回）。
 *
 * 実測（2026-10-25 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * - `2026年8月22日 17時以降`（空格）も助詞を挟んだ形も其の方の語で当たる（其の交わり
 *   8 行）のに、繋げた `2026年8月22日17時以降` は 0 行で案内も無しだった。
 * - 割りの頭が其の日を決める暦日（西暦年付き）を数えて居なかつた為で、其處から先の
 *   目（第 412 回の `:` と `-` の目）が其の日其の物を `2026` + `年8月22日` に割つて
 *   了ふ二つ目の原因も有つた。
 *
 * 直し:
 * - 割りの頭に「暦日に解ける形」を足す（在ら無い日 `2月30日` は解けないので割れない –
 *   締切の推測はしない）
 * - 語の割りの目で、暦日そのものを割らない守りを足す
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
  it("『2026年8月22日17時以降』は其の日∩其の方の時刻の交わりと一字も違わない", () => {
    const 当 = Recommender.searchMatcher("2026年8月22日17時以降", 基準);
    /* ハーネスの品書では日の語が画面の形其のままに立つ – 合成行で当たりを確かめる
     * （第 442 回 – 空対空の防ぎ）。 */
    expect(当("ict 2026年8月22日 17:30 deadline")).toBe(true);
    expect(当("ict 2026年9月5日 17:30 deadline")).toBe(false);
    expect(対称差(列("2026年8月22日17時以降"), 交差(列("2026年8月22日"), 列("17時以降")))).toBe(0);
    expect(対称差(列("2026年8月22日17時以降"), 列("2026年8月22日 17時以降"))).toBe(0);
  });
  it("在ら無い日は割らない – 『2月30日17時』は其の日を名乗らない（締切の推測はしない）", () => {
    /* 其の日を決める暦日に解けない形は**割りの頭にならない** – 案内が其の日を名乗る事
     * も近い日に寄せる事もない（其の方の語を写した当たりは元の侭 – 画面に在ら無い日を
     * 書かない決まり – 第 413 回）。 */
    const 案内 = Recommender.relativeDayNotes("2月30日17時", 基準).join(" ");
    expect(案内).not.toContain("2月30日 =");
    expect(案内).toContain("17時");
    /* 其の日其の物の語は其侭通る（割られて壊れて居ない – 二つ目の原因の検査）。 */
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
  it("頭に暦日を数える枝と、其の日を割らない守りが一つずつ在る", () => {
    expect(物.split("暦日に解くJa(日付境界Ja[1]) !== null").length - 1).toBe(1);
    expect(物.split('暦日に解くJa(String(token || "")) !== null').length - 1).toBe(1);
  });
});
