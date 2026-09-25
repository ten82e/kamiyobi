/**
 * 助詞を付きただけの暦日・暦月・年・曜日の語 – 第 408 回。
 *
 * 実測（2026-10-05 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻
 * 2026-08-09T00:00:00Z）で、助詞を一個付けただけの形が総て **0 行**だった –
 * `8月10日に` `8月10日で` `8月10日は` `8月10日の` `8月に` `2026年に` `3月15日に`
 * `12月25日に` `土曜に` `来週金曜に` `8月末に`。助詞を落とすと同じ入力
 * （`8月10日` 4 行・`8月` 210 行・`2026年` 789 行・`土曜` 188 行・`来週金曜` 19 行）が
 * 通る。語を並べた頼み方（`8月10日に 締切`）でも其の語が壊れて入力全体が 0 行に成つた。
 * 表に在る語（`中旬に` `今週に` `来月も`）は既に寄せて居たので、其れと同じ決まりを
 * 数の日付に廣げた。
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
  return {
    総数: 品.length,
    列: (語: string): Set<string> => {
      if (!済.has(語)) {
        const 当 = Recommender.searchMatcher(語, 基準);
        済.set(語, new Set(品.filter((行) => 当(行) === true)));
      }
      return 済.get(語) as Set<string>;
    },
  };
}

const 表 = 列表入口();
const 列 = 表.列;

function 対称差(甲: string, 乙: string): number {
  const 甲々 = 列(甲);
  const 乙々 = 列(乙);
  return (
    [...甲々].filter((行) => !乙々.has(行)).length + [...乙々].filter((行) => !甲々.has(行)).length
  );
}

/* 助詞を付きただけの形と、其の方の語（其の方の語側は品書に其の形其侭が載る）。 */
const 寄せる形: Array<[string, string]> = [
  ["8月10日に", "8月10日"],
  ["8月10日で", "8月10日"],
  ["8月10日は", "8月10日"],
  ["8月10日の", "8月10日"],
  ["8月10日も", "8月10日"],
  ["3月15日に", "3月15日"],
  ["2026年8月10日に", "2026年8月10日"],
  ["8月に", "8月"],
  ["8月で", "8月"],
  ["8月は", "8月"],
  ["2026年12月に", "2026年12月"],
  ["2026年に", "2026年"],
  ["来週金曜に", "来週金曜"],
  ["土曜に", "土曜"],
  ["金曜日の", "金曜日"],
  ["8月末に", "8月末"],
  ["3月末に", "3月末"],
];

describe("助詞を付きただけの暦日・暦月・年・曜日", () => {
  it("其の方の語と一寸もちがわない行を出す", () => {
    for (const [語, 基] of 寄せる形) {
      expect(列(基).size, `対照の「${基}」が品書で 0 行`).toBeGreaterThan(0);
      expect(列(語).size, `「${語}」が 0 行の侭（助詞で壊れて居る）`).toBeGreaterThan(0);
      expect(対称差(語, 基), `「${語}」の当たり方が「${基}」と違う`).toBe(0);
    }
  });

  it("語を並べた頼み方でも其の語が壊れない", () => {
    for (const [語, 基] of [
      ["8月10日に 締切", "8月10日 締切"],
      ["8月に セキュリティ", "8月 セキュリティ"],
      ["3月15日に 締切", "3月15日 締切"],
    ] as Array<[string, string]>) {
      expect(列(基).size, `対照の「${基}」が品書で 0 行`).toBeGreaterThan(0);
      expect(対称差(語, 基), `「${語}」が語を並べた形で壊れて居る`).toBe(0);
    }
  });

  it("日の形に直して打た無くて済む（語の頭で暦日に寄せる）", () => {
    const 組 = (語: string) => Recommender.queryTokenGroups(語, 基準) as string[][];
    expect(組("8月10日に")[0], "暦日の語に寄せて居ない").toContain("8月10日");
    expect(組("土曜に")[0], "曜日の語に寄せて居ない").toContain("土曜");
  });
});

describe("守り", () => {
  it("『まで』『までに』は其の方で幅を作る語なので剥がさない", () => {
    /* 其の方の語は其の方の規則が幅として解く（第 328 回の決まり） – 助詞を剥がして暦日・
     * 相対日 its物に寄せると、其の日だけの絞り込みに化けて噓になる。なので其の方の語は
     * 其のまま組の頭に残る。 */
    const 頭 = (語: string) => String((Recommender.queryTokenGroups(語, 基準) as string[][])[0][0]);
    expect(頭("8月10日までに"), "『8月10日までに』を暦日へ寄せた").toBe("8月10日までに");
    expect(頭("明日までに"), "『明日までに』を相対日へ寄せた").toBe("明日までに");
    expect(頭("3日後までに"), "『3日後までに』を相対日へ寄せた").toBe("3日後までに");
    expect(列("3日後までに").size, "『3日後までに』が行を出さない").toBeGreaterThan(0);
    expect(表.総数, "品書が空").toBeGreaterThan(0);
  });

  it("同じ聞き方になら無い助詞は剥がさない", () => {
    /* 『だけ』『しか』は絞り込みの語なので其のまま – 表に其の形其侭は無いので 0 行の侭。 */
    expect(列("8月10日だけ").size, "『だけ』を剥がして窄めた").toBe(0);
    expect(列("8月だけ").size, "『だけ』を剥がして窄めた").toBe(0);
  });

  it("日付に縁の無い語は今の当たり方の侭", () => {
    for (const [語, 基] of [
      ["人と機械", "人と機械"],
      ["東京大阪", "東京大阪"],
      ["来週火曜", "来週火曜"],
    ] as Array<[string, string]>) {
      expect(対称差(語, 基)).toBe(0);
    }
    expect(対称差("明日", "明日")).toBe(0);
    expect(列("8月上旬").size, "対照の `8月上旬` が 0 行").toBeGreaterThan(0);
  });
});

describe("成果物", () => {
  it("寄せは一個所の函數で決まる", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/function 暦日の語に寄せるJa\(/g) ?? []).toHaveLength(1);
    expect(
      物.match(/暦日の語に寄せるJa\(String\(unit\.token\)\)/g) ?? [],
      "語の頭で寄せが呼ばれていない",
    ).toHaveLength(1);
    expect(物.match(/const 同じ聞き方の助詞Ja = /g) ?? []).toHaveLength(1);
  });
});
