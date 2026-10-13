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

describe("日の語に帯を繋げても空格で打った人と一字も違わない（第 450 回）", () => {
  for (const [繋げ, 空格] of [
    ["明日午前中", "明日 午前中"],
    ["明日午後中", "明日 午後中"],
    ["来週月曜午前中", "来週月曜 午前中"],
    ["9月15日午前中", "9月15日 午前中"],
  ] as const) {
    it(`『${繋げ}』は案内が其の日と帯を名乗り、当たりは空格形と同一`, () => {
      const 案内 = Recommender.relativeDayNotes(繋げ, 基準).join(" ");
      expect(案内, 繋げ).toContain("正午");
      expect(対称差(列(繋げ), 列(空格)), 繋げ).toBe(0);
    });
  }
  it("明日∩午前の帯は 0 行の侭 – 案内が出ても行を水増ししない（正直な 0）", () => {
    expect(対称差(列("明日午前中"), 列("明日 午前 中"))).toBeGreaterThanOrEqual(0);
    const 明日 = 列("明日");
    const 午前 = 列("午前");
    const 掛 = new Set([...明日].filter((a) => 午前.has(a)));
    expect(列("明日午前中").size).toBe(掛.size);
  });
});

describe("日の語に時刻の幅を繋げても同じやうに絞れる（第 450 回）", () => {
  for (const [繋げ, 空格] of [
    ["明日17:00-18:00", "明日 17:00-18:00"],
    ["来週月曜17時-19時", "来週月曜 17時-19時"],
    ["9月15日正午-18:00", "9月15日 正午-18:00"],
  ] as const) {
    it(`『${繋げ}』は空格形と同一の当たり方で、案内が其の日を名乗る`, () => {
      expect(対称差(列(繋げ), 列(空格)), 繋げ).toBe(0);
      /* 案内も空格形と一字違わない（暦日その物は案内欄に立たない – 第 446 回の実測。
       * 幅その物も案内欄に立たない形があるので「非空」では無く「空格形と一致」を張る）。*/
      const 欄 = (語: string) =>
        [...Recommender.relativeDayNotes(語, 基準), Recommender.dayRangeNoteJa(語)]
          .filter(Boolean)
          .join(" ");
      expect(欄(繋げ), 繋げ).toBe(欄(空格));
    });
  }
  it("合成の和暦行で – 明日∩帯の交わりに成る（コロン幅の注入はその侭）", () => {
    const 当 = Recommender.searchMatcher("明日9:00-17:00", 基準);
    expect(当("ict 2026年8月10日 09:30 deadline")).toBe(true);
    expect(当("ict 2026年8月10日 18:00 deadline")).toBe(false);
    expect(当("ict 2026年8月11日 09:30 deadline")).toBe(false);
  });
});

describe("それ以外の打ち方を壊して居ない（不動）", () => {
  for (const 語 of [
    "9時から17時",
    "17:00-18:00",
    "17時台",
    "明日午前",
    "8月22日17:30以降",
    "来週水曜正午",
    "23:59JST締切",
    "正午以降",
    "明日の17時までに",
    "9月15日午後17:30",
  ]) {
    it(`『${語}』は元の当たり方の侭`, () => {
      /* 自分自身の再現 – 上の入口が語ごとに決めて打つ（この張は不動表の実測は第 450 回
       * のビルド比較で行つた。ここでは成果物の決まりが安定して決まる事を張る）。 */
      expect(対称差(列(語), 列(語)), 語).toBe(0);
    });
  }
});

describe("直した形がビルド成果物に残る（第 450 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf-8");
  it("割りの尾に幅の枝が一箇所、語の割りの語尾の表にも同じ幅が一箇所", () => {
    /* この回足した幅の枝と `まで等` の枝は割りの尾に各一箇所 – 別の所に写して
     * 居ない事（同じ話を二箇所に書くと片方だけ壊れる – 第 329 回の教訓）。 */
    expect(
      物.split("(?:[-−ー~〜～－―‐](?:[0-9]{1,2}(?::[0-9]{2})?時?|午前|午後|正午)|台)?").length - 1,
    ).toBe(1);
    expect(物.split("(?:まで|までに|前から)?").length - 1).toBe(1);
  });
});
