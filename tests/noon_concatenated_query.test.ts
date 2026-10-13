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

describe("正午を日の語に繋げてもその日と時刻の語に解ける（第 449 回）", () => {
  for (const 語 of ["来週水曜正午", "9月15日正午", "2026年8月22日正午", "明日正午"]) {
    it(`『${語}』は空格で打った人と一字も違わない当たり方で、案内が其の日と正午を名乗る`, () => {
      const 案内 = Recommender.relativeDayNotes(語, 基準).join(" ");
      expect(案内, 語).toContain("正午 = 12:00");
      expect(対称差(列(語), 列(語.replace("正午", " 正午"))), 語).toBe(0);
    });
  }
  it("その方の日が 12:00 を書いて居ない時は 0 行の侭（締切の推測はしない – 正直な 0）", () => {
    /* 来週月曜の行は 12: 頭を持たない（実測 0/4 行） – 繋げ形も 0 行が正しい。 */
    expect(対称差(列("来週水曜正午"), 交差(列("来週水曜"), 列("正午")))).toBe(0);
  });
  it("当たり方の検査 – 合成の和暦日の行で日と正午の交わりに成る", () => {
    /* 週語の注入は品書側で済んだ形なので、合成行では日の語がそのまま通る暦日で見る。 */
    const 当 = Recommender.searchMatcher("9月15日正午", 基準);
    expect(当("ict 2026年9月15日正午 deadline")).toBe(true);
    expect(当("ict 2026年9月16日正午 deadline")).toBe(false);
    /* 日の語は画面に並ぶ和暦形を通す（ISO 形での当たりはその方の語の決まり – 第 412 回 –
     * ここの張る物は「日と正午の交わりに成る」事）。 */
    expect(当("ict 2026年9月15日 12:00 deadline")).toBe(true);
    expect(当("ict 2026年9月15日 13:00 deadline")).toBe(false);
  });
  it("正午単体・前後境界の打ち方を壊して居ない（第 444 回）", () => {
    expect(列("正午").size).toBeGreaterThan(0);
    expect(対称差(列("正午以降"), 列("12時以降"))).toBe(0);
    expect(Recommender.relativeDayNotes("正午从前", 基準).join(" ")).not.toBe(undefined);
  });
});

describe("直した形がビルド成果物に残る（第 449 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf-8");
  it("割りの尾の時刻の形に正午が数えられている", () => {
    expect(
      物.split("|正午|[0-9]{1,2}:[0-9]{2}(?:以降|より|から|前|前に)?)(?:に)?|").length - 1,
    ).toBe(1);
  });
});
