import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): string[] {
  return (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
}

const 全 = 品書();

function 列(query: string): Set<string> {
  const 当 = Recommender.searchMatcher(query, 基準);
  return new Set(全.filter((行) => 当(行) === true));
}

function 対称差(x: Set<string>, y: Set<string>): number {
  let 差 = 0;
  const 向 = new Set(y);
  for (const 行 of x) if (!向.has(行)) 差 += 1;
  const 戻 = new Set(x);
  for (const 行 of y) if (!戻.has(行)) 差 += 1;
  return 差;
}

function 案内(query: string): string {
  return Recommender.relativeDayNotes(query, 基準).join("");
}

const 九月の第二週 = "2026年9月8日(火)〜2026年9月14日(月)";

describe("月の語と第何週の語の空格の位置 16 通り（`9 月 第 2 週`）", () => {
  const 型: Array<[string, string]> = [];
  const 空格 = ["", " "];
  for (const 前 of 空格) {
    for (const 中 of 空格) {
      for (const 冠 of 空格) {
        for (const 末 of 空格) {
          型.push([`9${前}月${中}第${冠}2${末}週`, "9月第2週"] as [string, string]);
        }
      }
    }
  }

  for (const [打ち方, 詰め形] of 型) {
    it(`\`${打ち方}\` は \`${詰め形}\` と同じ行に出る`, () => {
      expect(対称差(列(打ち方), 列(詰め形)), 打ち方).toBe(0);
      expect(列(打ち方).size, 打ち方).toBe(31);
    });
  }

  it("0 行に落ちる形がない – 空格の位置で行数が割れない", () => {
    const 数 = new Map<number, string[]>();
    for (const [打ち方] of 型) {
      const n = 列(打ち方).size;
      数.set(n, [...(数.get(n) ?? []), 打ち方]);
    }
    expect([...数.keys()], JSON.stringify([...数.entries()])).toEqual([31]);
  });

  for (const [打ち方] of 型) {
    it(`\`${打ち方}\` の件数欄は其の月の範囲を書き、打たれた侭に名乗る`, () => {
      const 文 = 案内(打ち方);
      expect(文, 打ち方).toContain(九月の第二週);
      /* 今の月の範囲を書くと行と噓になる */
      expect(文, 打ち方).not.toContain("2026年8月8日(土)");
      expect(文, 打ち方).toContain(打ち方);
    });
  }
});

describe("その他の月の語・その他の序数でも空格の位置を問はぬ", () => {
  const 組: Array<[string, string, number]> = [
    ["来 月第2 週", "来月第2週", 31],
    ["来月第 2 週", "来月第2週", 31],
    ["来 月 第 2 週", "来月第2週", 31],
    ["来 月第5 週", "来月第5週", 25],
    ["3 月第2 週", "3月第2週", 4],
    ["3 月 第 2 週", "3月第2週", 4],
    ["8 月第3 週", "8月第3週", 48],
    ["8 月第5 週", "8月第5週", 26],
    ["12 月第 1 週", "12月第1週", 30],
    ["今 月第2 週", "今月第2週", 26],
    ["先 月第2 週", "先月第2週", 4],
    ["第 二 週", "第二週", 26],
    ["第 1 週", "第1週", 8],
    ["第 5 週", "第5週", 26],
    ["第 2 週 に", "第2週に", 26],
    ["第 2 週 まで", "第2週まで", 25],
    ["9 月 第2 週 に", "9月第2週に", 31],
    ["8 月第2 週 の 締切", "8月第2週 の 締切", 26],
    /* 第 467 回の序数の `目` を離って打つ形もこの形に落ちる */
    ["9 月第2 週目", "9月第2週", 31],
    ["第 2 週 目", "第2週", 26],
  ];
  for (const [打ち方, 詰め形, 行数] of 組) {
    it(`\`${打ち方}\` ⇔ \`${詰め形}\` ${行数} 行`, () => {
      expect(対称差(列(打ち方), 列(詰め形)), 打ち方).toBe(0);
      expect(列(打ち方).size, 打ち方).toBe(行数);
    });
  }

  it("その月にその週の範囲を書く – 今の月を書かない（第 332 回）", () => {
    expect(案内("来 月第2 週")).toContain("来 月第2 週 = 2026年9月8日(火)〜2026年9月14日(月)");
    expect(案内("3 月第2 週")).toContain("3 月第2 週 = 2027年3月8日(月)〜2027年3月14日(日)");
    expect(案内("8 月第3 週")).toContain("8 月第3 週 = 2026年8月15日(土)〜2026年8月21日(金)");
    expect(案内("12 月第 1 週")).toContain("12 月第 1 週 = 2026年12月1日(火)〜2026年12月7日(月)");
    expect(案内("先 月第2 週")).toContain("先 月第2 週 = 2026年7月8日(水)〜2026年7月14日(火)");
    expect(案内("来 月第5 週")).toContain("来 月第5 週 = 2026年9月29日(火)〜2026年9月30日(水)");
  });
});

describe("その方の表が受けない形は寄せない（第 453 回）", () => {
  const 守り: Array<[string, number]> = [
    /* 月の週は五まで – 詰め形も 0 行 */
    ["第 6 週", 0],
    ["来 月第6 週", 0],
    ["9 月第6 週", 0],
    ["第 0 週", 0],
    ["第 週", 0],
    /* 日の数の話 */
    ["第 2 週間", 0],
    ["2週", 0],
    /* 列挙・その他の語尾 */
    ["第2週と第3週", 0],
    ["9 月 第2 週 と 第3 週", 0],
    ["8 月第2 週か", 0],
    ["第 2 週 又は", 0],
    ["9 月第2 週目に", 0],
    /* その方の語の表に無い語（`第 2 ラウンド` 16 行を壊さない） */
    ["第 2 ラウンド", 16],
    ["第2ラウンド", 16],
  ];
  for (const [打ち方, 行数] of 守り) {
    it(`\`${打ち方}\` は ${行数} 行の侭`, () => {
      expect(列(打ち方).size, 打ち方).toBe(行数);
    });
  }

  it("対照 – その他の週の語と旬の語は動きを変へない", () => {
    expect(列("第").size).toBe(436);
    expect(列("週").size).toBe(0);
    expect(列("来週").size).toBe(43);
    expect(列("今週").size).toBe(4);
    expect(列("下旬").size).toBe(58);
    expect(案内("第 2 週")).toContain("第 2 週 = 2026年8月8日(土)〜2026年8月14日(金)");
    expect(案内("第 二 週")).toContain("第 二 週 = 2026年8月8日(土)〜2026年8月14日(金)");
    expect(案内("来週")).toContain("来週 = 2026年8月10日(月)〜8月16日(日)");
  });

  it("前の語が序数の語でない時は寄せない – 分野の語を呑まない（第 453 回）", () => {
    expect(列("ml 第2週").size, "ml 第2週").toBe(1);
    expect(列("ml 第 2 週").size, "ml 第 2 週").toBe(1);
    expect(列("ml の 第2週").size, "ml の 第2週").toBe(1);
    expect(列("ml 第2週 まで").size, "ml 第2週 まで").toBe(1);
    expect(列("論文 第2週").size, "論文 第2週").toBe(24);
    expect(列("論文 第 2 週").size, "論文 第 2 週").toBe(24);
    expect(対称差(列("論文 第2週"), 列("論文 第 2 週"))).toBe(0);
    expect(列("査読 第2 週").size, "査読 第2 週").toBe(0);
    expect(列("査読 第 2 週").size, "査読 第 2 週").toBe(0);
  });

  it("件数欄は寄せた語を二度解かない – `まで` の文が消えない（第 468 回）", () => {
    for (const 打ち方 of [
      "第 2 週 まで",
      "第2 週 まで",
      "第 2週 まで",
      "第2週 まで",
      "第 二 週 まで",
    ]) {
      const 文 = 案内(打ち方);
      expect(文, 打ち方).toContain("まで = 2026年8月9日(日)〜8月14日(金)");
      expect(文, 打ち方).not.toContain("2026年8月8日(土)");
    }
    expect(案内("8 月第3 週 まで")).toContain("まで = 2026年8月9日(日)〜8月21日(金)");
    expect(案内("来 月第2 週 まで")).toContain("まで = 2026年8月9日(日)〜9月14日(月)");
  });

  it("範囲の語（`まで`）を離つて打つ形は未だ寄らない – 次回の的（残した差の実測）", () => {
    expect(列("9 月 第2 週 まで").size, "9 月 第2 週 まで").toBe(1);
    expect(列("9月第2週まで").size, "9月第2週まで").toBe(185);
    expect(列("9 月第2週まで").size, "9 月第2週まで").toBe(0);
  });
});

describe("直した形がビルド成果物に残る（第 468 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");

  it("空格の位置を問はぬ目は一本で、検索側と件数欄が同じ目を読む", () => {
    /* 宣言 1 + 検索側 1 + 件数欄 1。二本に分かれて居ない事の張り。*/
    expect(物.split("週の序数を寄せるJa").length - 1).toBe(3);
    /* 寄せた形の末尾を見る表の一箇所と、二語と三語の二回の確かめ – 分け方を写して居ない事。*/
    expect(物.split("序数の尾Ja").length - 1).toBe(3);
    /* その方の語の表を引く確かめは、実測で効かない為に乗せて居ない
     * （107 語の群で一字も変わらなかつた – 第 463 回）。だから使う所は三箇所。*/
    expect(物.split("週的形状Ja").length - 1).toBe(3);
    /* 件数欄が後ろに繋いだ語を飛ばす数の宣言と増減の三箇所 + 宣言の注の一つ。*/
    expect(物.split("週を飛ばす").length - 1).toBe(4);
    /* 月の語を継いだ週の組み立ては案内の一箇所。*/
    expect(物.split("月の解の続き").length - 1).toBe(3);
  });
});
