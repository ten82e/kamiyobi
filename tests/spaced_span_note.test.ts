/**
 * 幅の語に空格（全角空格）を交えて打った人 – 第 422 回。
 *
 * 実測（2026-10-08 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * 行を出す側は語の内の空格を既に受けて居た（`2 週間 以内` 111 行 ≡ `2週間以内`・`3 日以内` 17 行・
 * `五日 以内` 37 行・`180 日以内` 854 行 – 検索の正規化が詰める）のに、案内通道は trim だけで
 * 素通りし、**行は出るのに案内だけが黙つて居た** – 『3 日以内』17 行に「7 日以内が近い」が
 * 書けない、『5 以内』『10 以内』（半角・全角空格）0 行で案内も無し（『5以内』には出る）、
 * 『30 分 以内』『1 時間 以内』『半 日以内』『二 週間以内』も同じ。
 *
 * 直し – 幅を読む所（`dayRangeDaysJa`）で空格を詰めてから読み、二つの案内通道の枝分けも
 * 詰めた形で揃える。揃えないと『30 分 以内』が分数の枝から落ちて、30 分に「30 日以内が近い」と
 * 別の話を書く（直前の一歩で実際になりかけた – 実測 2026-10-08）。
 * echo は打たれた形を其侭書く（第 366 回の決まり – 寄せた形を書かない）。行は此処では決まらない
 * （行は検索の正規化が決める）ので、行集合は一寸も動かない。
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

function 対称差(甲: string, 乙: string): number {
  const A = 列(甲);
  const B = 列(乙);
  return [...A].filter((行) => !B.has(行)).length + [...B].filter((行) => !A.has(行)).length;
}

function 幅の案内(語: string): string {
  return String(Recommender.dayRangeNoteJa(語) ?? "").replace(/\s+/g, " ");
}

function 日数(語: string): number | null {
  const 庫 = Recommender as unknown as Record<string, (語: string) => number | null>;
  return 庫.dayRangeDaysJa(語);
}

/* 空格の打ち方は半角・全角・語の頭と数字の間を混ぜる – 検査用ビルドでも行の在る形を使う。 */
const 組 = [
  ["3 日以内", "3日以内"],
  ["五日 以内", "五日以内"],
  ["2 週間 以内", "2週間以内"],
  ["5 以内", "5以内"],
  ["10　以内", "10以内"],
  ["180 日以内", "180日以内"],
] as const;

describe("空格を交えた幅の打ち方", () => {
  it("行を出す側は既に受けて居た（詰めた形と同じ行集合 – 直前から動いて居ない事の確認）", () => {
    for (const [空格, 密] of 組) {
      expect(対称差(空格, 密), `「${空格}」が行集合で「${密}」と違う物を出した`).toBe(0);
    }
    expect(列("2 週間 以内").size, "『2 週間 以内』の行が在らない（検査が空振り）").toBeGreaterThan(
      0,
    );
  });

  it("案内も同じ話を出す – 詰めた形の案内と空格を除いて一寸もちがわない", () => {
    for (const [空格, 密] of 組) {
      const 空格の文 = 幅の案内(空格);
      expect(空格の文.length, `「${空格}」の案内が無い（行は出るのに黙つて居た）`).toBeGreaterThan(
        2,
      );
      /* 打った形を其侭 echo する（第 366 回の決まり）。 */
      expect(空格の文, `「${空格}」が打ち直した形を echo した`).toContain(
        空格.replace(/\s+/g, " "),
      );
      expect(空格の文.replace(/\s+/g, ""), `「${空格}」の案内が「${密}」と違う話を書いた`).toBe(
        幅の案内(密).replace(/\s+/g, ""),
      );
    }
  });

  it("幅の日数も同じ値に解ける（表の外に突き出した値でも噓のない同じ話）", () => {
    for (const [空格, 密] of 組) {
      expect(日数(空格), `「${空格}」が幅として読めない`).not.toBeNull();
      expect(日数(空格), `「${空格}」と「${密}」で日数が違う`).toBe(日数(密));
    }
    expect(日数("3 日以内"), "『3 日以内』が 3 日で無い").toBe(3);
  });

  it("一日より細かい幅も分数・時間の枝に乗る（『30 分 以内』に日の欄の話を書かない）", () => {
    for (const [空格, 密] of [
      ["30 分 以内", "30分以内"],
      ["1 時間 以内", "1時間以内"],
      ["半 日以内", "半日以内"],
    ] as const) {
      const 文 = 幅の案内(空格);
      expect(文.length, `「${空格}」の案内が無い`).toBeGreaterThan(2);
      expect(文, `「${空格}」が日数の欄の話に化けた: ${文}`).toContain("日単位");
      expect(文, `「${空格}」が「近い」で別幅に寄せた: ${文}`).not.toMatch(/日以内が近い/);
      expect(文.replace(/\s+/g, "")).toBe(幅の案内(密).replace(/\s+/g, ""));
      expect(日数(空格), `「${空格}」の丸めが違う`).toBe(1);
    }
    /* 分数で打った人は分数単位と書く（空格で時間の枝に落ちない事）。 */
    expect(幅の案内("30 分 以内"), "『30 分 以内』に時間単位と書いた").toContain("分数単位");
    expect(幅の案内("1 時間 以内"), "『1 時間 以内』に分数と書いた").toContain("時間単位");
  });
});

describe("壊して居ない側", () => {
  it("単位を落とすと其侭 0 行・案内無し（幅だと勝手に決めない）", () => {
    expect(日数("30分"), "『30分』を幅に化かした").toBeNull();
    expect(幅の案内("30分"), "『30分』まで幅の案内が出た").toBe("");
    expect(列("30分").size).toBe(0);
  });

  it("過去に開いた幅は別の案内の侭（空格でも其侭）", () => {
    const 文 = 幅の案内("3日 前まで");
    expect(文, "『3日 前まで』の案内が消えた").toContain("過去の締切も表示");
    expect(文, "『3日 前まで』を幅の欄の話に化した").not.toContain("締切まで」の選択欄");
    expect(幅の案内("3日前まで"), "『3日前まで』の案内が消えた").toContain("過去の締切も表示");
  });

  it("成果物の二つの案内通道は詰めた形で枝分けして居る（元の形で分ける枝に戻さない）", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.split("HOUR_RANGE_JA.test(打たれた形)").length - 1, "枝分けの数が違う").toBe(2);
    expect(物.split("HOUR_RANGE_JA.test(word)").length - 1, "元の形に分ける枝が復活した").toBe(0);
    expect(
      物.split("HOUR_RANGE_JA.test(String(query").length - 1,
      "元の形に分ける枝が復活した",
    ).toBe(0);
    const 折 = /\.trim\(\)\s*\.replace\(\/\\s\+\/g, ""\)/g;
    const 数 = (物.match(折) || []).length;
    expect(数, `trim+空格詰め の折り（幅の読みと案内二通道の三箇所）が ${数} 箇所`).toBe(3);
  });
});
