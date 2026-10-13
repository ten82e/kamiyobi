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

describe("正午を前後の境目に続けられる（第 444 回）", () => {
  it("『正午以降』『正午から』『正午より』は『12時以降』と一字も違わない", () => {
    for (const 語 of ["正午以降", "正午から", "正午より", "正午以降に"]) {
      expect(対称差(列(語), 列("12時以降")), 語).toBe(0);
      expect(列(語).size, 語).toBeGreaterThan(0);
    }
    const 案内 = Recommender.relativeDayNotes("正午以降", 基準).join(" ");
    expect(案内).toContain("12:00〜23:59（正午以降）");
  });
  it("『正午前』『正午前に』は『午前』の帯と一字も違わない", () => {
    for (const 語 of ["正午前", "正午前に"]) {
      expect(対称差(列(語), 列("午前")), 語).toBe(0);
      expect(列(語).size, 語).toBeGreaterThan(0);
    }
  });
  it("それ以降本来の『正午』『正午に』は 12:00 一点の侭", () => {
    expect(対称差(列("正午に"), 列("正午"))).toBe(0);
    const 当 = Recommender.searchMatcher("正午に", 基準);
    expect(当("hpc 12:00 deadline")).toBe(true);
    expect(当("hpc 12:05 deadline")).toBe(false);
  });
});

describe("時刻の語に付いた助詞くらいで黙らない（第 444 回）", () => {
  for (const [語, 芯] of [
    ["17時に", "17時"],
    ["17時台に", "17時台"],
    ["9時30分に", "9時30分"],
    ["5時半に", "5時半"],
    ["17時以降に", "17時以降"],
  ] as Array<[string, string]>) {
    it(`『${語}』は『${芯}』と一字も違わない`, () => {
      /* ハーネスの品書は 17 時の行が無く対称差が空対空になり得る – 当たり方を
       * 合成行でも見る。 */
      const 当 = Recommender.searchMatcher(語, 基準);
      const 芯当 = Recommender.searchMatcher(芯, 基準);
      for (const 入る of ["hpc 17:30 deadline", "hpc 17:00", "ai 18:30", "ai 05:30"]) {
        expect(当(入る), `${語} が『${入る}』に当たら無い`).toBe(芯当(入る));
      }
      expect(対称差(列(語), 列(芯)), 語).toBe(0);
    });
  }
  it("日の語と繋げた形も助詞付きで割れる", () => {
    const 期待 = 交差(列("明日"), 列("17時"));
    expect(対称差(列("明日17時に"), 期待)).toBe(0);
    const 後 = 交差(列("明日"), 列("17時以降"));
    expect(対称差(列("明日17時以降に"), 後)).toBe(0);
    expect(列("明日17時以降に").size).toBeGreaterThan(0);
  });
});

describe("語尾の時刻帯を繋げて打ても二語の交わりになる（第 444 回）", () => {
  for (const [語, 空格] of [
    ["17時JST", "17時 JST"],
    ["12時UTC", "12時 UTC"],
    ["9時30分日本時間", "9時30分 日本時間"],
  ] as Array<[string, string]>) {
    it(`『${語}』は『${空格}』と一字も違わない`, () => {
      expect(対称差(列(語), 列(空格)), 語).toBe(0);
    });
  }
  it("当たり方は合成行で見る（ハーネスの行数に依らない）", () => {
    const 当 = Recommender.searchMatcher("17時JST", 基準);
    expect(当("hpc 17:30 deadline (jst)")).toBe(true);
    expect(当("hpc 17:30 deadline (utc)")).toBe(false);
    expect(当("hpc 18:30 deadline (jst)")).toBe(false);
  });
});

describe("直した形がビルド成果物に残る（第 444 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf-8");
  it("正午の境目の式と語尾の時刻帯の語群が入つている", () => {
    expect(物.split("/^正午(以降|より|から|前|前に)(?:に|で|は|が|も)?$/").length - 1).toBe(1);
    expect(物.split("|JST|UTC|GMT|jst|utc|gmt|日本時間|世界標準時|協定世界時)$").length - 1).toBe(
      1,
    );
    expect(
      物.split(
        /^(?:(午前|午後|ごぜん|ごご))?([0-9]{1,2})時(?:(?:([0-9]{1,2})分)|(半))?(以降|より|から|前|前に)(?:に|で|は|が|も)?$/
          .source,
      ).length - 1,
    ).toBe(1);
  });
});
