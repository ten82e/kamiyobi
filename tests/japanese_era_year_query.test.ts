/**
 * 和暦（`令和8年`・`令和8年度`）と西暦の年度（`2026年度`）の検査（SPEC §4・§7・第 343 回）。
 * 実測（2026-10-01 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `2026年` 789 行・`2027年` 452 行・`今年度` 872 行が通るのに、`令和8年` **0 行**・`令和8年度`
 * **0 行**・`令和8年4月` **0 行**・`平成30年` **0 行**・西暦の `2026年度` **0 行**だった。
 * 品書に和暦は一箇所も無い（`令和` 0 回・`平成` 0 回・`昭和` 0 回）ので、年号は西暦に直して探す
 * （年号と西暦の対応は暦の決まりで、締切の推測ではない – AGENTS.md）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 行列表(語: string): string[] {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
  const matches = Recommender.searchMatcher(語, 基準);
  return rows.filter((row) => matches(String(row.hay)) === true).map((row) => String(row.hay));
}

function 対称差(a: string, b: string): number {
  const x = new Set(行列表(a));
  const y = new Set(行列表(b));
  return [...x].filter((k) => !y.has(k)).length + [...y].filter((k) => !x.has(k)).length;
}

function 群(語: string): string[] {
  const groups = Recommender.queryTokenGroups(語, 基準) as unknown as string[][];
  return groups[0] || [];
}

function 解決(語: string): string {
  return Recommender.relativeDayNotes(語, 基準).join(" ");
}

describe("和暦で打たれた年", () => {
  it("其の年の西暦の語に解ける（行集合が西暦を打った人と同じ）", () => {
    expect(行列表("2026年").length, "対照の `2026年` が 0 行").toBeGreaterThan(0);
    expect(行列表("令和8年").length, "`令和8年` が 0 行").toBeGreaterThan(0);
    expect(対称差("令和8年", "2026年"), "`令和8年` が `2026年` と違う行を出した").toBe(0);
    /* 年の語に解けた形（`令和元年` など）は語の組で pins する（品書に其の年の行が無いので
     * 行数では見えない – 第 341 回の教訓）。 */
    expect(群("令和元年")).toContain("2019年");
    expect(群("平成31年")).toContain("2019年");
    expect(群("昭和64年")).toContain("1989年");
    expect(群("令和8年")).toContain("2026年");
  });

  it("月を続けた形は其の月の語に解ける", () => {
    expect(群("令和8年4月")).toContain("2026年4月");
    expect(対称差("令和8年9月", "2026年9月"), "`令和8年9月` が `2026年9月` と違う行を出した").toBe(
      0,
    );
  });

  it("件数欄は其の方の語を続けた所まで書く（案内が実物より広い年を名乗らない – 第 375 回）", () => {
    /* 実測（2026-10-24 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）の直し前は、
     * 月・日を続けた形も案内は「西暦○年の締切」としか書かなかった – `令和8年8月` は其の月の
     * 189 行に絞れているのに、年だけで絞った `令和8年`（789 行）と同じ説明だった（第 343 回落とし）。 */
    expect(行列表("令和8年8月").length, "対照の `令和8年8月` が 0 行").toBeGreaterThan(0);
    expect(
      行列表("令和8年8月").length < 行列表("令和8年").length,
      "月を続けた形が年と同じ広さ（検査が空振り）",
    ).toBe(true);
    expect(解決("令和8年8月"), "月を続けた案内が月を書かない").toContain("= 2026年8月の締切");
    expect(解決("令和8年8月10日"), "日を続けた案内が日を書かない").toContain(
      "= 2026年8月10日の締切",
    );
    expect(解決("令和7年3月"), "其の品書に無い月も解けた形で書く").toContain("= 2025年3月の締切");
    /* 年だけの形・年度を付けた形は其侭 – 其の方の広さと其の方の説明。 */
    expect(解決("令和8年"), "年だけの案内まで変えた").toContain("= 2026年の締切");
    expect(解決("令和8年度"), "年度の説明が変わった").toContain("2026年4月〜2027年3月");
    /* 案内に書く語と、其れを探す語が別れない（別の値から案内が出ない形にする）。 */
    for (const 語 of ["令和8年8月", "令和8年8月10日", "令和8年"]) {
      const 書いた語 = 解決(語).split(" = ")[1].trim().split("の締切")[0];
      expect(書いた語, `『${語}』の案内が解けた語を書いていない`).not.toBe("");
      expect(群(語), `『${語}』の案内が探す語と違う`).toContain(書いた語);
    }
  });

  it("其の年号に有り得ない年数は西暦に直さない", () => {
    /* 平成は 31 年まで – `平成32年` を 2020 年へ寄せると、無い年号の打ち方に別年の行を出す。 */
    expect(群("平成32年"), "`平成32年` を西暦に寄せるた").not.toContain("2020年");
    expect(群("明治46年")).not.toContain("1913年");
    /* 年数の無い打ち方（`令和年`）も直さない。 */
    expect(群("令和年"), "`令和年` を西暦に寄せるた").not.toContain("2019年");
  });
});

describe("`2026年度` の言い方", () => {
  it("年度は 4 月始まりの 12 か月語に解ける（和暦も同じ形）", () => {
    expect(群("2026年度")).toContain("2026年4月");
    expect(群("2026年度")).toContain("2027年3月");
    expect(対称差("令和9年度", "2027年度"), "`令和9年度` が `2027年度` と違う行を出した").toBe(0);
    expect(
      対称差("2026年度", "今年度"),
      "`2026年度` が `今年度`（基準時は同じ年度）と違う行を出した",
    ).toBe(0);
  });

  it("裸の西暦年を年度に化けさせない（実測で 789 行が 872 行になった）", () => {
    expect(群("2026年"), "`2026年` が年度に寄せられた").not.toContain("2026年4月");
    expect(解決("2026年")).not.toContain("4 月始まり");
  });
});

describe("件数欄の解決", () => {
  it("何に直して探したかを打たれた語のまま書く", () => {
    const 年 = 解決("令和8年");
    expect(年).toContain("令和8年 = 2026年");
    /* 「西暦で書いていない」だけでは直した事が分からない – 直して探す事を名指す句を見る
     * （第 343 回の改ざんで判明した検査の穴）。 */
    expect(年, "西暦に直して探した事を隠した").toContain("西暦に直して探しています");
    const 年度 = 解決("2026年度");
    expect(年度).toContain("2026年4月〜2027年3月");
    expect(年度, "4 月始まりの決まりを書かない").toContain("4 月始まり");
    expect(年度, "西暦の月語に直して探した事を隠した").toContain("西暦の月語に直して探しています");
  });
});

describe("成果物", () => {
  it("組み立てた品が和暦を持ち、年号の表が関数の中にある（第 341 回・第 343 回の教訓）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(rec.includes("令和"), "和暦が成果物から消えた").toBe(true);
    const 関数 = rec.slice(rec.indexOf("function eraYearTermsJa("));
    expect(関数.length, "`eraYearTermsJa` が見つからない").toBeGreaterThan(0);
    expect(
      関数.slice(0, 2400).includes("[1867, 45]"),
      "年号の表が関数の外に出た（正規表現にも年号の語は出るので表その物を見る – 第 343 回）",
    ).toBe(true);
    /* 抜き出す検査の一覧に載っている事（載せないと `ReferenceError` に化ける – 第 257 回）。 */
    const 一覧 = readFileSync(new URL("./built_golden_shared.ts", import.meta.url), "utf8");
    expect(一覧).toContain('"eraYearTermsJa"');
    expect(一覧).toContain('"fiscalTermsFromYearJa"');
  });
});
