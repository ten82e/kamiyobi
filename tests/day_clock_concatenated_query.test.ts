/**
 * 「明日17時」「来週火曜17時以降」を繋げて打つ人だけ黙つて空だつた（第 443 回）。
 *
 * 実測（2026-10-24 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * - 空格を挟んだ `明日 17時` も助詞の `明日の17時` も通るのに、繋げた `明日17時`
 *   `8月10日17時30分` `明日17時台` `明日5時半` は 0 行で案内も無しだった –
 *   空格が有る人だけ通つた。
 * - `来週月曜` 4 行・`17時以降` 586 行が通るのに `来週月曜17時以降` は 0 行で
 *   「其れより後の締切の事だと思いますが…」の案内 – 其の日を決める複合語は頭に受けて
 *   居なかつた。
 * - `来月頃` `来年頃`（第 440 回）の断りが付くのに `8月あたり` `3月ごろ` `2027年頃`
 *   `2026年あたり` は 0 行で案内も無し – 数値の月・年が頭の表から落ちて居た。
 *
 * 直し:
 * - 割りの尾に裸の時刻点（`N時` `N時M分` `N時半`）と `N時台` を足す
 * - 頭に 日の頭の形Ja の他に其の日を決める複合語（週+曜日の押した形・月+日・和暦）を通す
 * - 幅の語の近似の頭に `[0-9]{1,2}月` と `[0-9]{3,4}年` を足す
 *
 * 守り – 他の語を割らない決まり（第 423 回）は其侭 – 頭が日の語か解ける複合語の時にだけ
 * 割る。其のまま一日を名乗る語（`来週火曜` など – tests/concatenated_day_words_query.test.ts）
 * は尾に時刻を含まないから割られない。
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

describe("日の語に時刻を直に繋げた形が割れる（第 443 回）", () => {
  for (const [語, 甲, 乙] of [
    ["明日17時", "明日", "17時"],
    ["明日17時台", "明日", "17時台"],
    ["明日5時半", "明日", "5時半"],
    ["明日正午", "明日", "正午"],
  ] as Array<[string, string, string]>) {
    it(`『${語}』は『${甲}』∩『${乙}』`, () => {
      expect(対称差(列(語), 交差(列(甲), 列(乙))), 語).toBe(0);
    });
  }
  it("其の方の語の案内も其の場に出る（黙つた 0 行にしない）", () => {
    const 案内 = Recommender.relativeDayNotes("明日17時", 基準).join(" ");
    expect(案内).toContain("明日 = 2026年8月10日(月)");
    expect(案内).toContain("17時");
  });
  it("其の日を決める複合語を頭に持つ形も割れる", () => {
    expect(対称差(列("来週月曜17時以降"), 交差(列("来週月曜"), 列("17時以降")))).toBe(0);
    const 案内 = Recommender.relativeDayNotes("来週火曜17時以降", 基準).join(" ");
    expect(案内).toContain("来週火曜 = 2026年8月11日(火)");
    expect(案内, "其れより後の断りが残つて居る").not.toContain("此の表の日と見付かりません");
  });
  it("他の語は割らない（第 423 回 – 頭が日の語の時にだけ割る）", () => {
    /* 割られたら 締切 ∩ 17時 の和集合に化ける – 其れと違う列表であることを張る。 */
    const 其のまま = 列("締切17時");
    const 割れた形 = new Set([...列("締切"), ...列("17時")]);
    expect(対称差(其のまま, 割れた形) > 0, "「締切17時」が割れた").toBe(true);
    expect(其のまま.size).toBe(0);
  });
});

describe("数値の月・年の近似語も断りが届く（第 443 回）", () => {
  for (const 語 of ["8月あたり", "3月ごろ", "2027年頃", "2026年あたり"]) {
    it(`『${語}』は 0 行の侭、幅の語の断り`, () => {
      expect(列(語).size, 語).toBe(0);
      const n = Recommender.uiWordNoteJa(語);
      expect(n, 語).toContain(`「${語}」`);
      expect(n, 語).toContain("では絞れません");
    });
  }
});

describe("直した形がビルド成果物に残る（第 443 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf-8");
  it("割りの尾に裸の時刻点と半と時台、頭に複合語の枝が入つて居る", () => {
    expect(
      物.split(
        /^(.+?)((?:(?:午前|午後|ごぜん|ごご)?(?:[0-9]{1,2}|[〇零一二三四五六七八九十]{1,3})時(?:[0-9]{1,2}分|半)?(?:以降|より|から|前|前に)?|正午|[0-9]{1,2}:[0-9]{2}(?:以降|より|から|前|前に)?)(?:に)?|[0-9]{1,2}時台|午前|午後|正午|JST|UTC|GMT|jst|utc|gmt|日本時間|世界標準時|協定世界時)$/
          .source,
      ).length - 1,
    ).toBe(1);
    expect(物.split("pressedWeekdayJa(日付境界Ja[1]").length - 1).toBe(1);
  });
  it("幅の語の近似の頭に数値の月と年が入つて居る", () => {
    expect(物.split("[0-9]{1,2}月|今年").length - 1).toBe(1);
    expect(物.split("[0-9]{3,4}年)(?:頃").length - 1).toBe(1);
  });
});
