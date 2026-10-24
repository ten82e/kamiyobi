import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

/* 品の語は `candidateRows` が作った検索の語（`hay`）の文字列 – 照合はその文字列に掛かる
 * 。*/
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

describe("月のまとまりの語に幅の語尾を離って付けても詰め形と同じ行に出る（第 465 回）", () => {
  const 対: Array<[string, string, number]> = [
    ["来月 末", "来月末", 178],
    ["今月 末", "今月末", 118],
    ["月 末", "月末", 118],
    ["先月 末", "先月末", 11],
    ["来月 内", "来月内", 178],
    ["今月 内", "今月内", 118],
    ["年度 末", "年度末", 29],
    ["年度 初め", "年度初め", 31],
    ["年度 始め", "年度始め", 31],
    ["年度 当初", "年度当初", 31],
    ["年度 中", "年度中", 436],
    ["年度 内", "年度内", 436],
    ["年 明け", "年明け", 23],
    /* 第 463 回で開いた語尾の続き – 同じ目（月のまとまりの表）を受ける形 */
    ["来月 中", "来月中", 178],
    ["来週 中", "来週中", 43],
  ];
  for (const [空格, 詰め, 期待] of 対) {
    it(`「${空格}」は詰め形「${詰め}」と同じ ${期待} 行`, () => {
      /* 詰め形がその方の品で一行以上引ける事 – 両側 0 行の空振りで対称差 0 を通さない。 */
      expect(列(詰め).size, 詰め).toBe(期待);
      expect(対称差(列(空格), 列(詰め)), `${空格} ⇔ ${詰め}`).toBe(0);
    });
  }

  it("語尾に `に` を足しただけの形も同じ行に出る", () => {
    expect(列("年度 以内に").size).toBe(436);
    expect(対称差(列("年度 以内に"), 列("年度以内に"))).toBe(0);
  });
});

describe("詰め形が解けない語尾は寄せない（第 453 回・第 462 回の決まり）", () => {
  /* 詰め形も 0 行の語は、寄せても 0 行のままなので門が通さない。 */
  const 不動: Array<[string, number]> = [
    /* 第 491 回で年の語の離した切れ目も寄せるやうになつた（詰め形と同じ 84 件）。*/
    ["今年 末", 84],
    /* 年の語にその切れ目の語を直に繋いだ形は第 484 回でその方の対に寄せるやうにした（前 0 行 –
     * `年末` 178 行・`年初` 99 行が通るのに継いだ形だけ黙つていた）。*/
    ["今年末", 84],
    ["来年末", 21],
    ["ml 末", 0],
    ["ml末", 0],
    ["ml 初め", 0],
    ["ml明け", 0],
    ["論文 末", 0],
    ["論文末", 0],
    ["査読 末", 0],
    /* 詰め形 `年中` は 0 行 – 寄せたら 27 行が 0 行に後退するので寄せない。 */
    ["年 中", 27],
    ["年中", 0],
    /* 詰め形 `年内中` は 0 行。 */
    ["年内 中", 27],
    ["年内中", 0],
    /* 月初の決まりは無いので寄せない。 */
    ["月初", 0],
    ["月初め", 0],
    ["月初 め", 0],

    ["来週 から", 423],
    ["来週から", 423],
    ["来週 より", 423],
    /* `末` を語尾の表に足した事で別の機械が壊れて居ない事。 */
    ["来週 まで", 43],
    ["来週 いっぱい", 43],
    ["ml 中", 2],
    ["査読 中", 0],
    ["来月 下旬", 59],
    ["17時 まで", 0],
    ["17時まで", 0],
  ];
  for (const [打ち方, 期待] of 不動) {
    it(`「${打ち方}」は今まで通り ${期待} 行`, () => {
      expect(列(打ち方).size, 打ち方).toBe(期待);
    });
  }

  it("『週末』の言い換えは別の機械 – 語の表の目（七語の週）は広げず、別の段で寄せる（第 471 回）", () => {
    expect(列("週末").size).toBe(146);
    expect(列("週 末").size).toBe(146);
    expect(列("来週末").size).toBe(34);
    expect(列("今週末").size).toBe(1);
    /* 七語の週に依らぬ形は依然として別の行 – 表が広かつて居ない事の実測 */
    expect(列("週 末日").size).toBe(0);
  });
});

describe("件数欄は寄せた形で解き、名乗りは打たれた侭にする（第 462 回・第 465 回）", () => {
  it("『年度 中』『年度 内』は年度の範囲を打たれた空格のまま名乗る", () => {
    for (const 語 of ["年度 中", "年度 内"]) {
      const 案内 = Recommender.relativeDayNotes(語, 基準).join("");
      expect(`${語} -> ${案内}`).toContain(`${語} = 2026年4月1日(水)〜2027年3月31日(水)の締切`);
      /* 行はその範囲に絞れている – 「検索欄では絞り込まずにいます」は噓なので出してはいけない。*/
      expect(案内).not.toContain("絞り込まずにいます");
    }
  });

  it("『年度 以内に』も年度の範囲を書く（語尾の `に` は助詞として剥ぐ）", () => {
    const 案内 = Recommender.relativeDayNotes("年度 以内に", 基準).join("");
    expect(案内).toContain("2026年4月1日(水)〜2027年3月31日(水)の締切");
    expect(案内).not.toContain("絞り込まずにいます");
  });

  it("月のまとまりの語は詰め形と同じで案内を持たない – 黙つているのは噓ではない", () => {
    for (const 語 of ["来月 末", "年度 末", "年 明け"]) {
      expect(Recommender.relativeDayNotes(語, 基準), 語).toEqual([]);
    }
    expect(列("来月 末").size).toBe(178);
  });
});

describe("対照 – その他の機械が受ける打ち方は当たり方を変へない（第 465 回）", () => {
  const 対照: Array<[string, number]> = [
    ["週末", 146],
    ["年内", 425],
    ["年度", 436],
    ["来年度", 50],
    ["論文 の締切", 264],
    ["ml の会議", 18],
    ["第 2 週", 26],
    ["8 月 第 2 週", 26],
    ["来年 中", 114],
    ["今年 以内", 427],
    ["8 月 22 日 まで", 60],
    ["8 月 末", 118],
    ["8 月 まで", 118],
    ["8月から", 425],
    ["17時以降", 181],
    ["23時59分", 181],
    ["来週", 43],
  ];
  for (const [打ち方, 期待] of 対照) {
    it(`「${打ち方}」は ${期待} 行`, () => {
      expect(列(打ち方).size, 打ち方).toBe(期待);
    });
  }
});

describe("直した形がビルド成果物に残る（第 465 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");

  it("幅の語尾の表に月のまとまりの語尾が载る – 別の機械で受ける語尾は載らない", () => {
    const 宣言 = 物.split("\n").filter((行) => 行.includes("const 幅の語尾の語Ja ="));
    expect(宣言.length).toBe(1);
    for (const 語尾 of ["末", "初め", "始め", "当初", "明け"]) {
      expect(宣言[0], 語尾).toContain(`|${語尾}`);
    }
    /* 詰め形が別の機械でも解けない語尾は第 462 回の決まりの侭入れない。 */
    for (const 語尾 of ["いっぱい", "この先"]) {
      expect(宣言[0], 語尾).not.toContain(`|${語尾}`);
    }
  });

  it("語の表に年度の目が一本在り、七語の週の目は緩んで居ない", () => {
    expect(物.split("fiscalYearTermsJa(語, nowMs) !== null").length - 1).toBe(1);
    expect(物.split("weekDayTermsJa(語, nowMs).length === 7").length - 1).toBe(1);
    expect(物.match(/weekDayTermsJa\(語, nowMs\)\.length/g)?.length).toBe(1);
    expect(物.split("function 幅の語尾を継いだ形が解けるJa(").length - 1).toBe(1);
    expect(物.match(/幅の語尾を継いだ形が解けるJa\(/g)?.length).toBe(3);
  });
});
