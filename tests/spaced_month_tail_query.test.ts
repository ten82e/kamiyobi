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

function 列(q: string): Set<string> {
  return new Set(全.filter((行) => Recommender.searchMatcher(q, 基準)(行) === true));
}

function 対称差(x: Set<string>, y: Set<string>): number {
  let n = 0;
  for (const a of x) if (!y.has(a)) n += 1;
  for (const b of y) if (!x.has(b)) n += 1;
  return n;
}

describe("月語・年語と幅の語尾を離って打つと詰め形と同じ行に出る（第 463 回）", () => {
  /* [空格で打つ形, 詰め形, 検査用ビルドで測つた行数] */
  const 組: Array<[string, string, number]> = [
    ["8 月 まで", "8月まで", 118],
    ["8 月 末", "8月末", 118],
    ["12 月 末", "12月末", 84],
    ["8 月 中", "8月中", 118],
    ["12 月 中", "12月中", 84],
    ["1 月 まで", "1月まで", 23],
    ["3 月 まで", "3月まで", 29],
    ["2026 年 8 月 まで", "2026年8月まで", 118],
    ["2026 年 8 月 末", "2026年8月末", 118],
    ["来週 いっぱい", "来週いっぱい", 43],
    ["今週 いっぱい", "今週いっぱい", 4],
    ["来月 いっぱい", "来月いっぱい", 178],
    ["金曜 いっぱい", "金曜いっぱい", 67],
    ["週末 いっぱい", "週末いっぱい", 146],
    ["今年 いっぱい", "今年いっぱい", 427],
    ["来年 いっぱい", "来年いっぱい", 114],
    ["来月 中", "来月中", 178],
    ["今月 中", "今月中", 118],
    ["来年 中", "来年中", 114],
    ["今年 中", "今年中", 427],
    ["今年 以内", "今年以内", 427],
    ["来年 以内", "来年以内", 114],
    ["来月 以内", "来月以内", 178],
    ["来月 以降", "来月以降", 389],
    ["8 月 以降", "8月以降", 425],
    ["金曜 まで", "金曜まで", 67],
    ["週末 まで", "週末まで", 146],
    ["来月 中 です", "来月中", 178],
  ];
  for (const [空格, 詰め, 件] of 組) {
    it(`「${空格}」は「${詰め}」と一字も違わない行が出て ${件} 件`, () => {
      expect(列(詰め).size, 詰め).toBe(件);
      expect(対称差(列(空格), 列(詰め)), 空格).toBe(0);
    });
  }

  it("寄せた形が詰め形より行数を減らした物はない（第 462 回と同じ張り方）", () => {
    for (const [空格, 詰め] of 組) {
      const 離れ = 列(空格);
      const 詰まり = 列(詰め);
      expect([空格, 離れ.size >= 詰まり.size]).toEqual([空格, true]);
    }
  });

  it("月と語尾が片方だけ離れた打ち方も同じ行に出る", () => {
    for (const [空格, 詰め] of [
      ["8月 まで", "8月まで"],
      ["8月 末", "8月末"],
      ["8月 中", "8月中"],
      ["3月 中", "3月中"],
    ]) {
      expect(対称差(列(空格), 列(詰め)), 空格).toBe(0);
    }
  });
});

describe("その方の機械も 0 行の語尾は寄せない（第 463 回 – 締切の推測はしない）", () => {
  it("「年内 中」は `年中` が表にないので寄せない – 27 行の侭（詰め形は 0 行）", () => {
    expect(列("年内 中").size).toBe(27);
    expect(列("年内中").size).toBe(0);
    expect(列("年内").size).toBe(425);
  });
  it("「ml 中」は語のかけ算（2 件）の侭 – 月の表には寄らない", () => {
    expect(列("ml 中").size).toBe(2);
    expect(列("ml中").size).toBe(0);
  });
  it("「査読 中」は語のかけ算（0 件）の侭", () => {
    expect(列("査読 中").size).toBe(0);
    expect(列("査読中").size).toBe(0);
  });
  it("「ml 以降」も語のかけ算の侭 – 月の幅の表が解かない語に `以降` は足さない", () => {
    expect(列("ml 以降").size).toBe(0);
    expect(列("論文 以降").size).toBe(0);
  });
  it("相対日から開いた幅 – `から` も `以降` も詰め形と同じ行に出る（第 475 回・第 476 回）", () => {
    for (const 語 of ["来週 から", "来週 以降"] as const) {
      expect(列(語).size).toBe(423);
      expect(Recommender.relativeDayNotes(語, 基準), `「${語}」に案内が残つた`).toEqual([]);
    }
    expect(列("来週から").size).toBe(423);
    expect(列("来週以降").size).toBe(423);
    expect(列("明日 から 明後日").size).toBe(列("明日から明後日").size);
  });
  it("語尾が単独で立つ打ち方はその侭 0 行（語その物を探している）", () => {
    expect(列("まで").size).toBe(0);
    expect(列("以降").size).toBe(0);
    expect(列("いっぱい").size).toBe(0);
  });
});

describe("案内は打たれた空格の侭を名乗り、絞れているのに「絞りません」と書かない（第 463 回）", () => {
  it("年の語に幅の語尾を離って付けた形は、その年の締切と書く（第 330 回と同じ解き方）", () => {
    expect(Recommender.relativeDayNotes("来年 中", 基準)).toEqual([
      "来年 中 = 2027年の締切（1〜12 か月）",
    ]);
    expect(Recommender.relativeDayNotes("今年 中", 基準)).toEqual([
      "今年 中 = 2026年の締切（1〜12 か月）",
    ]);
  });
  it("週の語に `いっぱい` を離って付けた形は、詰め形と同じ範囲を書く", () => {
    const 詰め = Recommender.relativeDayNotes("来週いっぱい", 基準);
    expect(詰め).toEqual(["来週 = 2026年8月10日(月)〜8月16日(日)"]);
    expect(Recommender.relativeDayNotes("来週 いっぱい", 基準)).toEqual(詰め);
  });
  it("行を絞れているのに「検索欄では絞り込まずにいます」と書く案内を出さない", () => {
    for (const 語 of ["来月 以降", "8 月 以降", "来年 以内", "来月 以内"]) {
      const 文 = JSON.stringify(Recommender.relativeDayNotes(語, 基準));
      expect(`${語} -> ${文}`).not.toContain("絞り込まず");
    }
  });
  it("月と第 N 週を別に打つ形の案内は、寄せで名乗りが化けない（第 460 回）", () => {
    const 文 = Recommender.relativeDayNotes("8 月 第 2 週", 基準);
    expect(文.length).toBe(1);
    expect(文[0].startsWith("8 月 第 2 週 = 2026年8月8日(土)〜2026年8月14日(金)")).toBe(true);
  });
});

describe("それ以外の検索は動かない（第 463 回 – 対照）", () => {
  const 対: Array<[string, number]> = [
    ["論文 の締切", 264],
    ["8 月 第 2 週", 26],
    ["来週", 43],
    ["今週", 4],
    ["来月", 178],
    ["今年", 427],
    ["来年", 114],
    ["年内", 425],
    ["中", 27],
    ["8 月 22 日 まで", 60],
    ["来週 中", 43],
    ["来週 中に", 43],
    ["来月 内", 178],
    ["3 日 以内", 7],
    ["ml の会議", 18],
    ["12月31日まで", 423],
    ["3日から5日まで", 0],
    /* 第 476 回で開いた幅も詰め形と同じ行に出る。*/
    ["来週 から", 423],
    ["今月 下旬", 58],
    /* 第 490 回で週の語＋旬も二語に割れるやうになつた（実ビルド 52 件）。*/
    ["来週中旬", 43],
  ];
  for (const [語, 件] of 対) {
    it(`「${語}」は ${件} 件の侭`, () => {
      expect(列(語).size, 語).toBe(件);
    });
  }
});

describe("直した形がビルド成果物に残る（第 463 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");

  it("数字と月の語の詰めは 1 箇所 – 後ろに幅の語尾が控へている時だけ詰める", () => {
    const 寄せ =
      'out = out.replace(/([0-9]{1,2})[ \\u3000]+月(?=[ \\u3000]*(?:までに|まで|末|中|内|以内|いっぱいに|いっぱい|以降|以後|以来))/g, "$1月");';
    expect(物.split(寄せ).length - 1).toBe(1);
  });
  it("文字列の書換四本が語尾の前の空格を受ける", () => {
    expect(
      物.split("月のまとまり = /([0-9]{1,2})月[ \\u3000]*中(?!旬|頃|途|止|断)(?:[ \\u3000]*に)?/g;")
        .length - 1,
    ).toBe(1);
    expect(物.split("月の末尾 = /([0-9]{1,2})月[ \\u3000]*末(?!処理|尾)/g;").length - 1).toBe(1);
    expect(物.split("[ \\u3000]*まで/g;").length - 1).toBe(1);
    expect(物.split("(?:[ \\u3000]*いっぱい|一杯)").length - 1).toBe(1);
  });

  it("語の表の目は六つから十三に増えた – 月の幅・暦年・暦月・時刻・年度（第 463 回・第 465 回）", () => {
    expect(物.split("function 幅の語尾を継いだ形が解けるJa(").length - 1).toBe(1);
    for (const 目 of [
      "monthRangeTermsJa(語, nowMs).length > 0",
      "RELATIVE_YEAR_OFFSETS_JA[relativeYearKeyJa(語)] !== undefined",
      'relativeMonthTerm(語, nowMs) !== ""',
      "fiscalYearTermsJa(語, nowMs) !== null",
      "clockTimeTermsJa(語) !== null",
    ]) {
      expect(物.split(目).length - 1, 目).toBe(1);
    }
    const 門 = 物.slice(
      物.indexOf("function 幅の語尾を継いだ形が解けるJa("),
      物.indexOf("解ける日語かJa(dateTokenStemJa(語))"),
    );
    expect(門.split("||").length - 1, "目の数").toBe(12);

    expect(物.match(/幅の語尾を継いだ形が解けるJa\(/g)?.length).toBe(3);
  });
  it("案内の「それより後」は寄せた形から剥ぐ – 空格の侭で剥ぐと表が解かない", () => {
    expect(物.split("より後を剥がす語Ja(解 || token)").length - 1).toBe(1);
    expect(物.split("暦日より後の語Ja(解 || token, nowMs)").length - 1).toBe(1);
  });
});
