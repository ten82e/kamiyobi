/**
 * 「週末以降」の案内と ISO の `T` 型（第 446 回）。
 *
 * 実測（2026-10-25 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * - `今週末以降` は「2026年8月8日以降のこと – …」の案内が出るのに `週末以降`
 *   `土日以降` は 0 行で案内も無し – 裸の『週末』は公用の読みで今週の週末。
 * - `2026-08-22 17:00` と空格で打つと其の方の語で当たるのに `2026-08-22T17:00`
 *   `2026-08-22T17:00:00Z` は 0 行で案内も無し – ICS やカレンダーから貼る形。
 *
 * 直し:
 * - 案内の初日を数える語に裸の『週末』『土日』（今週末と同じ初日 – 幅は作らない）
 * - ISO の `T` 型を日と時刻の二語に割る（秒と末尾の `Z` は落とす – 時刻の
 *   変換はしない – 第 336 回。空格で打った人と同じ当たり方に揃えるだけ）
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

describe("裸の『週末』以降も初日の案内が出る（第 446 回）", () => {
  it("『週末以降』は『今週末以降』と同じ初日を名乗る", () => {
    const 案内 = Recommender.relativeDayNotes("週末以降", 基準).join(" ");
    expect(案内).toContain("週末以降 = 2026年8月8日以降のこと");
    const 今 = Recommender.relativeDayNotes("今週末以降", 基準).join(" ");
    expect(今).toContain("今週末以降 = 2026年8月8日以降のこと");
    /* 幅は勝手に作らない – 其の方の決まりの侭 0 行。 */
    expect(列("週末以降").size).toBe(0);
  });
  it("『土日以降』も其の週の土曜を初日に名乗る", () => {
    expect(Recommender.relativeDayNotes("土日以降", 基準).join(" ")).toContain(
      "2026年8月8日以降のこと",
    );
  });
  it("『週末』単体の当たり方は不変（其の方の語で受ける侭）", () => {
    expect(列("週末").size).toBeGreaterThan(0);
    const 案内 = Recommender.relativeDayNotes("週末", 基準).join(" ");
    expect(案内).toBe("");
  });
});

describe("ISO の T 型を貼っても日の語と時刻の語に解ける（第 446 回）", () => {
  it("『2026-08-22T17:00』は空格で打った人と一字も違わない当たり方をし、合成行で確認できる", () => {
    const 当 = Recommender.searchMatcher("2026-08-22T17:00", 基準);
    expect(当("ict 2026-08-22 17:00 deadline")).toBe(true);
    expect(当("ict 2026-08-22 18:00")).toBe(false);
    expect(当("ict 2026-09-05 17:00")).toBe(false);
    expect(対称差(列("2026-08-22T17:00"), 列("2026-08-22 17:00"))).toBe(0);
  });
  it("秒と末尾の `Z` を含んでも同じ – 時刻の変換はしない（第 336 回）", () => {
    const 当 = Recommender.searchMatcher("2026-08-22T09:05:00Z", 基準);
    expect(当("ict 2026-08-22 09:05")).toBe(true);
    expect(当("ict 2026-08-22 09:06")).toBe(false);
    expect(対称差(列("2026-08-22T17:00:00Z"), 列("2026-08-22 17:00"))).toBe(0);
  });
  it("案内が其の方の語の形で出る", () => {
    const 案内 = Recommender.relativeDayNotes("2026-08-22T17:00", 基準).join(" ");
    expect(案内).toContain("17:00");
  });
  it("外の時刻（25時）は寄せない – 其の方の語で探す侭", () => {
    const 当 = Recommender.searchMatcher("2026-08-22T25:00", 基準);
    expect(当("ict 2026-08-22 25:00")).toBe(false);
    /* 案内の出方で見る – 17:00 なら其の方の語の案内が出るが 25:00 は寄せない為ない
     * （ハーネスの品書では行が空対空になり得る – 第 442 回の教訓）。 */
    expect(Recommender.relativeDayNotes("2026-08-22T17:00", 基準).join(" ")).toContain("17:00");
    expect(Recommender.relativeDayNotes("2026-08-22T25:00", 基準).join(" ")).toBe("");
  });
});

describe("直した形がビルド成果物に残る（第 446 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf-8");
  it("ISO の T 型の式と週末の案内の枝が入つて居る", () => {
    expect(
      物.split("/^([0-9]{4}-[0-9]{2}-[0-9]{2})[tT]([0-9]{1,2}):([0-9]{2})(?::[0-9]{2})?[zZ]?$/")
        .length - 1,
    ).toBe(1);
    expect(物.split('stem === "週末" || stem === "土日"').length - 1).toBe(1);
    expect(物.split('first = 以降の初日Ja("今週末", nowMs);').length - 1).toBe(1);
  });
});
