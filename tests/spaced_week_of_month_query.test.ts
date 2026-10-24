import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 品 = (
  Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
  ) as unknown as Array<{ hay: string }>
).map((行) => String(行.hay));

function 列(語: string): Set<string> {
  return new Set(品.filter((行) => Recommender.searchMatcher(語, 基準)(行) === true));
}

function 対称差(a: Set<string>, b: Set<string>): number {
  return [...a].filter((k) => !b.has(k)).length + [...b].filter((k) => !a.has(k)).length;
}

function 案内(語: string): string {
  return Recommender.relativeDayNotes(語, 基準).join(" ");
}

describe("冠を離って打つ月の第何週が詰め形と同じ行に出る（第 460 回）", () => {
  /* [離って打つ形, 詰めた形, 検査用ビルドの品書で測つた行数] */
  const 形: Array<[string, string, number]> = [
    ["第 2 週", "第2週", 26],
    ["第 二 週", "第二週", 26],
    ["8 月 第 2 週", "8月第2週", 26],
    ["8 月 第 二 週", "8月第二週", 26],
    ["3 月 第 1 週", "3月第1週", 8],
    ["来月 第 1 週", "来月第1週", 48],
    ["先月 第 3 週", "先月第3週", 2],
    ["今月 第 4 週", "今月第4週", 30],
    ["第 5 週", "第5週", 26],
    ["第 2 週 です", "第2週です", 26],
    ["8 月 第 2 週 の 締切", "8月第2週の締切", 26],
  ];

  for (const [離した形, 詰め形, 期待] of 形) {
    it(`「${離した形}」は「${詰め形}」と同じ行が出て ${期待} 行`, () => {
      const 離 = 列(離した形);
      const 詰 = 列(詰め形);
      expect(対称差(離, 詰), `対称差が出た: ${離した形} ⇔ ${詰め形}`).toBe(0);
      /* 詰め形が実質の行を引いている事（空振りの対称差 0 を防ぐ – 第 455 回）。 */
      expect(詰.size, `詰め形が ${期待} 行で無い: ${詰め形}`).toBe(期待);
      expect(離.size, `離って打つ形が ${期待} 行で無い: ${離した形}`).toBe(期待);
    });
  }

  it("月と週の間にだけ空格を置く形は第 439 回の侭通る", () => {
    expect(対称差(列("8月 第2週"), 列("8月第2週"))).toBe(0);
    expect(列("8月 第2週").size).toBe(26);
  });
});

describe("件数欄はその方の語を名乗り、引いた範囲を書く（第 460 回）", () => {
  it("冠を離つた形も『第2週は月の 8 日から 14 日までです』を添える", () => {
    /* 行だけ増えて案内が黙つていると、利用者は何の範囲を引いたのか読めない。 */
    expect(案内("第 2 週")).toContain("第 2 週 = 2026年8月8日(土)〜2026年8月14日(金)の締切");
    expect(案内("第 2 週")).toContain("第2週は月の 8 日から 14 日までです");
    expect(案内("第 二 週")).toContain("第 二 週 = 2026年8月8日(土)〜2026年8月14日(金)の締切");
    expect(案内("第 二 週")).toContain("第二週は月の 8 日から 14 日までです");
  });

  it("月を別に打つ形はその月の範囲を書く（今の月の範囲を書かない – 嘘になる）", () => {
    /* 検索側はその方の週をその月で解くので、案内もその方に従ふ。実測でこれを置かなかつた
     * 間は `3 月 第 2 週`（12 行）に対して「2026年8月8日〜8月14日」と書いていた。 */
    expect(案内("来月 第 2 週")).toContain("来月 第 2 週 = 2026年9月8日(火)〜2026年9月14日(月)");
    expect(案内("来月 第 2 週")).not.toContain("第 2 週 = 2026年8月");
    expect(案内("3 月 第 2 週")).toContain("3 月 第 2 週 = 2027年3月8日(月)〜2027年3月14日(日)");
    expect(案内("8 月 第 2 週")).toContain("8 月 第 2 週 = 2026年8月8日(土)〜2026年8月14日(金)");
    /* 詰め形が名乗つた語を、離した形も打たれた空格の侭名乗る。 */
    expect(案内("来月第2週")).toContain("来月第2週 = 2026年9月8日(火)〜2026年9月14日(月)");
  });
});

describe("作らない幅・触らない語（測つた断り）", () => {
  it("第6週以上・第0週・その月に在らない週は作らない（第 438 回）", () => {
    expect(列("第 6 週").size).toBe(0);
    expect(対称差(列("第 6 週"), 列("第6週"))).toBe(0);
    expect(列("第 0 週").size).toBe(0);
    expect(対称差(列("第 0 週"), 列("第0週"))).toBe(0);
  });

  it("語を続けた形を勝手に切らない（`第 2 週 から` は詰め形と同じ 0 行）– 序数の `目` だけ別（第 467 回）", () => {
    expect(対称差(列("第 2 週 目"), 列("第2週目"))).toBe(0);
    expect(対称差(列("第2週目"), 列("第2週"))).toBe(0);
    expect(列("第2週目").size).toBe(26);

    expect(対称差(列("第 2 週 から"), 列("第2週から"))).toBe(0);
    expect(列("第2週から").size).toBe(423);
    /* 週の語を二つ並べた列挙は解かない。 */
    expect(対称差(列("第 2 週 と 第 3 週"), 列("第2週と第3週"))).toBe(0);
    expect(列("第2週と第3週").size).toBe(0);
  });

  it("冠がその他の語に続く形は触らない（`第 2 ラウンド` – その方の表にない語）", () => {
    expect(対称差(列("第 2 ラウンド"), 列("第2ラウンド"))).toBe(0);
    expect(列("第 2 ラウンド").size).toBe(16);
  });

  it("第 438 回・第 439 回の形とその他の相対的な日の語は無傷", () => {
    for (const [空格, 詰め] of [
      ["8 月 下旬", "8月下旬"],
      ["来月 下旬", "来月下旬"],
      ["8 月 22 日", "8月22日"],
      ["来週 の 締切", "来週の締切"],
      ["ml で", "mlで"],
    ] as Array<[string, string]>) {
      expect(対称差(列(空格), 列(詰め)), `対称差が出た: ${空格} ⇔ ${詰め}`).toBe(0);
    }
    expect(列("8月下旬").size).toBe(58);
    expect(列("来週").size).toBe(43);
    expect(列("上旬").size).toBe(10);
    /* 裸の `週`・`目`・冠だけでは何も絞らない（語の断片を語として扱わない）。 */
    expect(列("週").size).toBe(0);
  });

  it("残した差 – 詰め形の方が壊れている形は寄せない（`来週第2週` 0 行）", () => {
    expect(列("来週第2週").size).toBe(0);
    expect(列("来週 第 2 週").size).toBe(25);
  });
});

describe("直した形がビルド成果物に残る（第 460 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");

  it("冠を週の語に寄せる目は空格の位置を問はず、数字と漢数字の両方を見ている", () => {
    /* 宣言 1 + 検索側 1 + 件数欄 1 – 一本の目を二段で読む。*/
    expect(物.split("週の序数を寄せるJa").length - 1).toBe(3);

    expect(物.match(/第\[[0-9〇一二三四五六七八九十\]]/g)?.length).toBe(2);

    expect(物.split("週的形状Ja.test(").length - 1).toBe(1);
  });

  it("件数欄も冠を離した形を解き、月を別に打つ形まで見る", () => {
    /* その方の週に月の語を継ぐ組み立て – 月を一語で打つ形と二語に離つて打つ形の両方を
     * 見る。実測 3 箇所。*/
    expect(物.split("月の解の続き").length - 1).toBe(3);
    /* 月を二語に離つた形を見る為の一段上の語 – 宣言と二つの確かめの五箇所（実測）。*/
    expect(物.split("月の上").length - 1).toBe(5);
  });
});
