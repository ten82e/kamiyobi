/**
 * 「1か月半」と「週明け頃」を打つ人だけ案内も無し – 幅は半月まで、週の明けは裸の語だけ受けて居た（第 439 回）。
 *
 * 実測（2026-10-24 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * - `1か月以内` は「30 日以内」の欄の案内が出るのに `1か月半` `1か月半以内`
 *   `一か月半以内` `2か月半以内` `1ヶ月半` は 0 行で案内も無し。
 * - `週明け` `来週明け` `今週明け` は語表の断りが出るのに `週明け頃` `週明けあたり`
 *   `週明けごろ` `来週明けあたり` `今週明け辺り` は 0 行で案内も無し。
 *
 * 直し –
 * - 幅の決まりに半月を足した形（Nか月半 = N×30+15 日の欄の話）を通す – 半月 = 15 日と
 *   同じ寄せ（第 315 回の決裁 – 行は作らない – は其の侭）。
 * - 週の明けに位を続ける形を其の方の断りに寄せる – 位を足しても意味は決まらない。
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

describe("か月半の幅が欄の話を受ける（第 439 回）", () => {
  for (const [語, 欄] of [
    ["1か月半", "90 日以内"],
    ["1か月半以内", "90 日以内"],
    ["一か月半以内", "90 日以内"],
    ["2か月半以内", "90 日以内"],
    ["1ヶ月半", "90 日以内"],
    /* 3か月半 = 105 日は 90 を越えるので次の欄 – 寄せが日数から来て居る事を見る。*/
    ["3か月半以内", "180 日以内"],
  ] as Array<[string, string]>) {
    it(`『${語}』は 0 行の侭、締切までの欄の案内が出る`, () => {
      expect(列(語).size, 語).toBe(0);
      const n = Recommender.dayRangeNoteJa(語);
      expect(n, 語).toContain(`「${語}」`);
      expect(n, 語).toContain("当たりません");
      /* 数の寄せ – 実測（2026-10-24 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）で
       * `1か月半以内` は 45 日の幅として 30 日と 90 日の間で一番近い「90 日以内」が出る。
       * 其の欄の話の侭 – 寄せを消すと「30 日以内」に化ける。*/
      expect(n, 語).toContain(欄);
    });
  }
  it("半月の既存の決まりは其の侭（第 330 回）", () => {
    for (const 語 of ["半月", "半月以内"]) {
      const n = Recommender.dayRangeNoteJa(語);
      expect(n, 語).toContain(`「${語}」`);
      expect(n, 語).toContain("当たりません");
    }
    expect(列("半月以内").size).toBe(0);
  });
  it("其它の幅の案内も其の侭", () => {
    expect(Recommender.dayRangeNoteJa("1か月以内")).toContain("30 日");
    expect(Recommender.dayRangeNoteJa("30日以内")).toContain("");
    expect(列("30日以内").size).toBeGreaterThan(0);
  });
});

describe("週の明けに位を付けても其の方の断り（第 439 回）", () => {
  for (const 語 of [
    "週明け頃",
    "週明けあたり",
    "週明けごろ",
    "来週明けあたり",
    "今週明け辺り",
    "来週明け締切頃",
  ]) {
    it(`『${語}』は 0 行の侭、打たれた表記で週の明けの断りが出る`, () => {
      expect(列(語).size, 語).toBe(0);
      const n = Recommender.uiWordNoteJa(語);
      expect(n, 語).toContain(`「${語}」`);
      expect(n, 語).toContain("週の明けという言い方");
    });
  }
  it("裸の週の明けは語表の案内の侭", () => {
    for (const 語 of ["週明け", "来週明け", "今週明け"]) {
      const n = Recommender.uiWordNoteJa(語);
      expect(n, 語).toContain(語);
      expect(n, 語).toContain("週の明けという言い方");
    }
  });
  it("其它の位と曜日語は動かない", () => {
    /* 幅の未確定な位（第 377 回の決まり）は 0 行案内無しの侭 – 週の明けの断りが
     * 其れを吞んで居ない事もここで見る。*/
    expect(列("3日前後").size).toBe(0);
    expect(Recommender.uiWordNoteJa("3日前後")).toBe("");
    for (const 語 of ["明日", "月曜", "金曜", "今週", "来週"]) {
      expect(Recommender.uiWordNoteJa(語), 語).not.toContain("週の明け");
    }
    /* 語表その物の語（位を付けない形）が此の断り側へ漏れない事 – 漏れたら
     * 語表を削った改ざんを行かないまま通す（実ビルドでも 0 行の語なので行では見えない）。*/
    expect(列("週明け締切").size).toBe(0);
    expect(Recommender.uiWordNoteJa("週明け締切")).toContain("週の明けという言い方");
    expect(Recommender.uiWordNoteJa("週明け")).toContain("週の明けという言い方");
    expect(列("今週").size).toBeGreaterThan(0);
  });
});

describe("割りの形がビルド成果物に残る（第 439 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("半月幅の式と週の明けの位式が入つて居る", () => {
    for (const 形 of [
      /^([0-9]{1,3})(?:か月|ヶ月|カ月|ケ月)半(?:以内)?$/.source,
      /^(?:(?:今|来|再々?|先)?週明け(?:締切)?)(?:頃|ころ|ごろ|辺り|あたり)(?:に)?\s*(?:でした|ですか|でしょうか|でしょう|でしたね|ですよ|ですね|です|だよ|かな)?$/
        .source,
    ]) {
      expect(物.split(形).length - 1, 形.slice(0, 18)).toBe(1);
    }
  });
});
