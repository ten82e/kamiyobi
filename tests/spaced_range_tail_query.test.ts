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

function 対称差(x: Set<string>, y: Set<string>): number {
  let n = 0;
  for (const a of x) if (!y.has(a)) n += 1;
  for (const b of y) if (!x.has(b)) n += 1;
  return n;
}

describe("空格で離した幅の語尾が詰め形と同じ行に出る（第 462 回）", () => {
  const 品 = 品書();
  const 列 = (q: string): Set<string> => {
    const 当 = Recommender.searchMatcher(q, 基準);
    return new Set(品.filter((行) => 当(行) === true));
  };

  /* [空格で離した打ち方, 詰めた打ち方, 検査用ビルドの品書で測つた実行数] */
  const 組: Array<[string, string, number]> = [
    ["来週 まで", "来週まで", 43],
    ["来週 までに", "来週までに", 43],
    ["来月 まで", "来月まで", 178],
    ["年内 まで", "年内まで", 425],
    ["明日 まで", "明日まで", 2],
    ["上旬 まで", "上旬まで", 2],
    ["下旬 まで", "下旬まで", 110],
    ["来週 中", "来週中", 43],
    ["今週 中", "今週中", 4],
    ["来週 中に", "来週中に", 43],
    ["今週 中に", "今週中に", 4],
    ["明日 中に", "明日中に", 2],
    ["来週 内", "来週内", 43],
    ["来月 内", "来月内", 178],
    ["今月 内", "今月内", 118],
    ["3 日 以内", "3日以内", 7],
    /* 暦日に幅の語尾を離って打つ形。 */
    ["8 月 22 日 まで", "8月22日まで", 60],
    ["12 月 31 日 まで", "12月31日まで", 423],
    /* 敬語を後ろに繋げた打ち方も同じ行に届く。 */
    ["来週 まで です", "来週まで", 43],
    ["今週 中 です", "今週中", 4],
  ];

  for (const [空格, 詰め, 行数] of 組) {
    it(`「${空格}」は「${詰め}」と同じ ${行数} 行に出る`, () => {
      expect(対称差(列(空格), 列(詰め)), `${空格} ⇔ ${詰め}`).toBe(0);
      expect(列(詰め).size, 詰め).toBe(行数);
    });
  }

  it("語尾を離しただけで一行も出なかつた形が、寄せてからは行に届く", () => {
    /* 詰め形が通る行数をその方で張る – 寄せが消えると 0 行に落ちる（改ざんの目 – 第 462 回）。 */
    expect(列("来週 まで").size).toBe(43);
    expect(列("年内 まで").size).toBe(425);
    expect(列("来週 中に").size).toBe(43);
    expect(列("来週 内").size).toBe(43);
    expect(列("下旬 まで").size).toBe(110);
  });
});

describe("解けない幅の語尾は寄せない（第 462 回 – 締切の推測はしない）", () => {
  const 品 = 品書();
  const 列 = (q: string): Set<string> => {
    const 当 = Recommender.searchMatcher(q, 基準);
    return new Set(品.filter((行) => 当(行) === true));
  };

  it("詰め形が解かない語尾は寄せない – `年内 中` の 27 行を 0 行に後退させない", () => {
    expect(列("年内 中").size).toBe(27);
    expect(列("年内中").size).toBe(0);
    /* 寄せた方が減る形は作らない決まり – その侭流した時より悪くなつたら落ちる。 */
    expect(列("年内 中").size).toBeGreaterThan(列("年内中").size);
  });

  it("相対日から開いた幅 – `から` も `以降` も詰め形と同じ行に出る（第 475 回・第 476 回）", () => {
    expect(列("来週 まで").size).toBe(43);
    for (const [離, 繋] of [
      ["来週 から", "来週から"],
      ["明日 から", "明日から"],
      ["来週 以降", "来週以降"],
    ] as Array<[string, string]>) {
      expect([離, 列(離).size]).toEqual([離, 列(繋).size]);
      expect([離, 列(離).size > 100]).toEqual([離, true]);
    }
    expect(列("来週 から").size).toBe(423);
  });

  it("日付の語ではない語に幅の語尾を繋がない – その方の語は語として通る", () => {
    /* `査読中` は行の文字列にもある語だが、`査読 中` を `査読中` に寄せて行を足さない。 */
    expect(列("査読 中").size).toBe(0);
    expect(列("査読中").size).toBe(0);
    expect(列("ml 中").size).toBe(2);
    expect(列("ml中").size).toBe(0);
  });

  it("帯の語に付いた語尾は、詰め形が解ける物だけ寄せる（第 464 回）", () => {
    expect(列("17時 以降").size).toBe(181);
    expect(対称差(列("17時 以降"), 列("17時以降"))).toBe(0);
    expect(列("17時 まで").size).toBe(0);
    expect(列("17時まで").size).toBe(0);
  });

  it("第 462 回に残した差として張つた形は、今は詰め形と一字も違わない", () => {
    for (const [空格, 詰め] of [
      ["8 月 まで", "8月まで"],
      ["8 月 中", "8月中"],
      ["来月 中", "来月中"],
    ]) {
      expect(列(詰め).size, 詰め).toBeGreaterThan(0);
      expect([...列(空格)].sort().join("\n"), 空格).toBe([...列(詰め)].sort().join("\n"));
    }
  });
});

describe("案内は打たれた空格の侭の名乗り、範囲は詰め形と同じ（第 462 回）", () => {
  const 組: Array<[string, string]> = [
    ["来週 まで", "来週 まで = 2026年8月9日(日)〜8月16日(日)の締切"],
    ["来週 までに", "来週 までに = 2026年8月9日(日)〜8月16日(日)の締切"],
    ["明日 まで", "明日 まで = 2026年8月9日(日)〜8月10日(月)の締切"],
    ["上旬 まで", "上旬 まで = 2026年8月9日(日)〜8月10日(月)の締切"],
    ["下旬 まで", "下旬 まで = 2026年8月9日(日)〜8月31日(月)の締切"],
    ["来週 中", "来週 中 = 2026年8月10日(月)〜8月16日(日)"],
    ["今週 中", "今週 中 = 2026年8月3日(月)〜8月9日(日)"],
    ["来週 中に", "来週 中に = 2026年8月10日(月)〜8月16日(日)"],
    ["今週 中に", "今週 中に = 2026年8月3日(月)〜8月9日(日)"],
    ["来週 内", "来週 内 = 2026年8月10日(月)〜8月16日(日)"],
  ];
  for (const [打ち方, 案内] of 組) {
    it(`「${打ち方}」の案内は「${案内}」で始まる`, () => {
      const 出 = Recommender.relativeDayNotes(打ち方, 基準).join(" ／ ");
      expect(出, 打ち方).toContain(案内);
    });
  }

  it("案内は語尾を剥いだ形の名乗りにならない", () => {
    /* 検索側だけ直した第一版は案内が黙つた – 案内が消えたらここで落ちる（改ざんの目）。 */
    expect(Recommender.relativeDayNotes("来週 まで", 基準).length).toBe(1);
    expect(Recommender.relativeDayNotes("来週 中", 基準).length).toBe(1);
    expect(Recommender.relativeDayNotes("来週 中に", 基準).length).toBe(1);
    /* 空格を落とした語の名乗りではない – 打った人が自分の打ち方を読み違へない。 */
    expect(Recommender.relativeDayNotes("来週 まで", 基準)[0]).not.toMatch(/^来週まで/);
    expect(Recommender.relativeDayNotes("来週 中", 基準)[0]).not.toMatch(/^来週中/);
  });

  it("書き散らした案内でも範囲は詰め形と一字も違わない", () => {
    const 空格 = Recommender.relativeDayNotes("来週 まで", 基準)
      .join(" ／ ")
      .replace(/来週 まで/, "来週まで");
    expect(空格).toBe(Recommender.relativeDayNotes("来週まで", 基準).join(" ／ "));
    const 中 = Recommender.relativeDayNotes("来週 中", 基準)
      .join(" ／ ")
      .replace(/来週 中/, "来週中");
    expect(中).toBe(Recommender.relativeDayNotes("来週中", 基準).join(" ／ "));
  });

  it("寄せない形の案内は今まで通り – 幅で絞れる形の案内は消える（第 476 回）", () => {
    expect(Recommender.relativeDayNotes("年内 中", 基準).join("")).toBe("");
    /* `来週 から` は第 476 回から幅で絞れる – その方の決まりと同じく案内は出ない。*/
    expect(Recommender.relativeDayNotes("来週 から", 基準)).toEqual([]);
  });
});

describe("他の打ち方と取り合はない（第 462 回）", () => {
  const 品 = 品書();
  const 列 = (q: string): Set<string> => {
    const 当 = Recommender.searchMatcher(q, 基準);
    return new Set(品.filter((行) => 当(行) === true));
  };

  /* [打ち方, 検査用ビルドで測つた実行数] – 第 455〜461 回で張った形が動いて居ない事。 */
  const 据: Array<[string, number]> = [
    ["論文 の締切", 264],
    ["ml の会議", 18],
    ["8 月 の 締切", 114],
    ["第 2 週", 26],
    ["来週", 43],
    ["年内", 425],
    ["中", 27],
    ["まで", 0],
    ["12月31日まで", 423],
    ["締切まで", 0],
    ["3日前まで", 0],
    /* 第 490 回で週の語＋旬も二語に割れるやうになつた（実ビルド 52 件）。*/
    ["来週中旬", 43],
    ["今月 下旬", 58],
    ["ml で", 18],
  ];
  for (const [打ち方, 期待] of 据) {
    it(`「${打ち方}」は今まで通り ${期待} 行`, () => {
      expect(列(打ち方).size, 打ち方).toBe(期待);
    });
  }

  it("語の寄せが無くなっても語尾だけは語として残らない", () => {
    /* 幅の語尾を語として残すと 0 行になる – それ自体を張る（`まで` だけでは一行も当たらない）。 */
    expect(列("まで").size).toBe(0);
    expect(列("中に").size).toBe(0);
    expect(列("以内に").size).toBe(0);
  });
});

describe("直した形がビルド成果物に残る（第 462 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");

  it("幅の語尾の表は 1 箇所 – 測つて解ける語尾だけが載る", () => {
    const 宣言 = 物.split("\n").filter((行) => 行.includes("const 幅の語尾の語Ja ="));
    expect(宣言.length).toBe(1);
    expect(宣言[0]).toContain("までに|まで|中に|中|内に|内|以内に|以内");

    for (const 語尾 of ["いっぱい", "この先"]) {
      expect(宣言[0], 語尾).not.toContain(`|${語尾}`);
    }

    expect(宣言[0]).toContain("|以降|以後|以来");

    expect(宣言[0]).toContain("|前に|前|より|から");
  });

  it("寄せの検査は 1 箇所の宣言から出る – 案内側と検索側が同じ目を使う", () => {
    expect(物.split("function 幅の語尾を継いだ形が解けるJa(").length - 1).toBe(1);
    expect(物.match(/幅の語尾を継いだ形が解けるJa\(/g)?.length).toBe(3);
    expect(物.match(/幅の語尾の語Ja\.test\(token\)/g)?.length).toBe(2);
  });

  it("案内は寄せた形で解き、名乗りは打たれた侭にする", () => {
    /* 二つ（旬と幅の語尾）から七つに増えた – 第 464 回の時刻の寄せが五つ（冠の三語寄せ・
     * 単位・冠の後ろが繋がれた形・分の三語寄せ・分）*/
    /* 案内側で名乗りを継ぐ所は第 466 回の数値の相対日の目で二つ増えた（実測で張る –
     * 数を張ると案内側の目が静かに落ちない）。*/
    expect(物.match(/前\.見せ = /g)?.length).toBe(9);
    expect(物.split("解ける日語かJa(dateTokenStemJa(語))").length - 1).toBe(1);
    expect(物.split("const key = dateTokenStemJa(解 || token)").length - 1).toBe(1);
    expect(物.split("untilDayTermsJa(解 || token, nowMs)").length - 1).toBe(1);
  });
});
