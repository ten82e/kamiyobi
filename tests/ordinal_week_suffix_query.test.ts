import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

/* 品の語は `candidateRows` が作った検索の語（`hay`）の文字列 – 照合はその文字列に掛かる。*/
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
  for (const 物 of x) if (!向.has(物)) 差 += 1;
  const 帰 = new Set(x);
  for (const 物 of y) if (!帰.has(物)) 差 += 1;
  return 差;
}

describe("序数の `目` を付けた週は、その方の週と同じ行に出る（第 467 回）", () => {
  const 対: Array<[string, string, number]> = [
    ["第2週目", "第2週", 26],
    ["第 2 週目", "第2週", 26],
    ["第2 週目", "第2週", 26],
    ["第二週目", "第2週", 26],
    ["2週目", "第2週", 26],
    ["2 週目", "第2週", 26],
    ["第 2 週 目", "第2週", 26],
    ["第2週目に", "第2週に", 26],
    ["第2週目を", "第2週を", 26],
    ["第2週目まで", "第2週まで", 25],
    ["第3週目", "第3週", 48],
    ["第一週目", "第1週", 8],
    ["第五週目", "第5週", 26],
    ["9月第2週目", "9月第2週", 31],
    ["来月第2週目", "来月第2週", 31],
    ["8 月 第 2 週目", "8月第2週", 26],
    ["3 月 第 2 週目", "3月第2週", 1],
    ["9 月 第 2 週目", "9月第2週", 31],
  ];
  for (const [目, 其の方, 期待] of 対) {
    it(`「${目}」は其の方の語「${其の方}」と同じ ${期待} 行`, () => {
      /* その方がその方の品で一行以上引ける事 – 両側 0 行の空振りで対称差 0 を通さない。*/
      expect(列(其の方).size, 其の方).toBe(期待);
      expect(対称差(列(目), 列(其の方)), `${目} ⇔ ${其の方}`).toBe(0);
    });
  }

  it("その方の表が受けない数は寄せない – 第5週まで解けて第6週は両側 0 行（書き写した上限の対）", () => {
    expect(列("第5週目").size).toBe(26);
    expect(列("第5週").size).toBe(26);
    for (const [目, 其の方] of [
      ["第6週目", "第6週"],
      ["第12週目", "第12週"],
      ["12週目", "第12週"],
    ] as Array<[string, string]>) {
      expect(列(其の方).size, 其の方).toBe(0);
      expect(対称差(列(目), 列(其の方)), `${目} ⇔ ${其の方}`).toBe(0);
    }
  });
});

describe("別の語に化ける形は寄せない（第 453 回・第 389 回の断り）", () => {
  const 不動: Array<[string, number]> = [
    /* `N 週間` は日数の話 – `目` が付いてもその方の表に無い（詰め形も 0 行）。*/
    ["2週間目", 0],
    ["2週間", 0],
    ["1週間", 0],
    /* 週その物の語・冠だけ・数だけの週は語の断片。*/
    ["来週目", 0],
    ["週", 0],
    ["目", 0],
    ["2週", 0],
    /* その日からを推す形は作らない（締切の推測はしない – 第 439 回の断り）。*/
    /* 第 476 回でその週を初日として開いた幅に解けるやうにした – 三つの打ち方が揃ふ。
     * （前は全て 0 行で、打ち方ではなくその方が届か無い目だつた。）*/
    ["第2週目から", 423],
    ["第2週から", 423],
    ["第 2 週 から", 423],
    /* 週を二つ並べた列挙も解かない。*/
    ["第2週と第3週", 0],
    /* 冠がその他の語に続く形はその方の表に無いので触らない。*/
    ["第 2 ラウンド目", 0],
    ["第2週間に", 0],
  ];
  for (const [打ち方, 期待] of 不動) {
    it(`「${打ち方}」は今まで通り ${期待} 行`, () => {
      expect(列(打ち方).size, 打ち方).toBe(期待);
    });
  }

  const 対照: Array<[string, number]> = [
    ["第2週", 26],
    ["第 2 週", 26],
    ["第2週まで", 25],
    ["第2ラウンド", 16],
    ["第", 436],
    ["来週", 43],
    ["週末", 146],
    ["下旬", 58],
    ["論文", 264],
    ["9 月 第 2 週", 31],
    ["来月 第2週", 31],
    ["3月 第2週", 1],
  ];
  for (const [打ち方, 期待] of 対照) {
    it(`対照「${打ち方}」は ${期待} 行`, () => {
      expect(列(打ち方).size, 打ち方).toBe(期待);
    });
  }
});

describe("件数欄はその月の範囲を書く – 今の月を書いたら噓（第 332 回）", () => {
  const 名乗り: Array<[string, string]> = [
    ["第2週目", "第2週 = 2026年8月8日(土)〜2026年8月14日(金)の締切"],
    ["2週目", "第2週 = 2026年8月8日(土)〜2026年8月14日(金)の締切"],
    ["第2週目まで", "第2週まで = 2026年8月9日(日)〜8月14日(金)の締切"],
    ["来月第2週目", "来月第2週 = 2026年9月8日(火)〜2026年9月14日(月)の締切"],
    /* 月を二語に離つて週を詰めて打つ形 – 第 467 回で直すまで案内は今の月の範囲を書いていた
     * （行は 9 月の 31 行）。序数の `目` を落とした形もここに落ちる。*/
    ["9 月 第2週", "9 月 第2週 = 2026年9月8日(火)〜2026年9月14日(月)の締切"],
    ["9 月 第 2 週目", "9 月 第2週 = 2026年9月8日(火)〜2026年9月14日(月)の締切"],
    ["3 月 第2週", "3 月 第2週 = 2027年3月8日(月)〜2027年3月14日(日)の締切"],
  ];
  for (const [打ち方, 期待] of 名乗り) {
    it(`「${打ち方}」の件数欄は「${期待}」`, () => {
      const 案内 = Recommender.relativeDayNotes(打ち方, 基準).join("");
      expect(案内).toContain(期待);
    });
  }

  it("月の語に見えない語は組み立てない – その方の語の名乗りは其侭（第 453 回）", () => {
    expect(列("ml の 第2週").size).toBe(1);
    expect(Recommender.relativeDayNotes("ml の 第2週", 基準).join("")).toContain(
      "第2週 = 2026年8月8日(土)〜2026年8月14日(金)の締切",
    );
    expect(列("論文 第2週").size).toBe(24);
    expect(Recommender.relativeDayNotes("論文 第2週", 基準).join("")).toContain(
      "第2週 = 2026年8月8日",
    );
  });

  it("その月にその週が在らない形は、その方の週に落ちる – 案内は黙らない（第 389 回・第 453 回）", () => {
    /* 行は 0 行 – 同じ語を含む行が品書に無いだけ（実測 – 実ビルド 872 行でも 0 行）。
     * 其でも案内は解けた語を書く（黙らない – 第 332 回）。*/
    expect(列("13 月 第2週").size, "13 月 第2週").toBe(0);
    expect(Recommender.relativeDayNotes("13 月 第2週", 基準).join("")).toContain(
      "第2週 = 2026年8月8日(土)〜2026年8月14日(金)の締切",
    );
    expect(列("13 月 第2週目").size, "13 月 第2週目").toBe(0);
    expect(Recommender.relativeDayNotes("13 月 第2週目", 基準).join("")).toContain(
      "第2週 = 2026年8月8日(土)〜2026年8月14日(金)の締切",
    );
    expect(Recommender.relativeDayNotes("2 月 第5週", 基準).join("")).toContain(
      "第5週 = 2026年8月29日(土)〜2026年8月31日(月)の締切",
    );
  });

  it("解けない数は案内を黙らせる – 行が出ないのと揃つている", () => {
    expect(Recommender.relativeDayNotes("第6週目", 基準), "第6週目").toEqual([]);
    expect(列("第6週目").size).toBe(0);
    expect(Recommender.relativeDayNotes("2週間目", 基準), "2週間目").toEqual([]);
    expect(列("2週間目").size).toBe(0);
  });
});

describe("直した形がビルド成果物に残る（第 467 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");

  it("序数の `目` を落とす目は一箇所で、数の上限は其上の解き方と対", () => {
    /* 宣言 1 + 使用 1。*/
    expect(物.split("週の目の言い方").length - 1).toBe(2);
    expect(物.split("目の週の数Ja < 1 || 目の週の数Ja > 5").length - 1).toBe(1);

    expect(物.split("週的形状Ja").length - 1).toBe(3);

    expect(物.split("月の付いた週").length - 1).toBe(3);
  });
});
