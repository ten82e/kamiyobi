/* 第 495 回 – 數字で書いた先の年＋暦月＋其れより後（`2027年12月から`）を割つて行を出した
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、此の形は 0 件だつた
 * （離して打てば 84 件）。第 494 回に気付いた通り、此の段は**時計を自分で讀めない**（`new Date` を
 * 一つ入れると固定時計の検査の足場で五本落ちる）ので、時刻から暦年だけを取る口を Date 無しで書いた
 *（日番号からの暦の逆算 – 400 年 146097 日の規則）。其れを語を割る段へ渡し、**今の年より先の年だけ**
 *を割る。
 *
 * 割る／割らぬの分かれ目は実測で決めた – `2026年1月から` 796 件 → `2026年 1月から` 393 件・
 * `2026年3月から` 796 → 317（今の年は割ると減る）・`2027年3月から` 371 → 371（同じ）・
 * `2027年12月から` 0 → 84（増える）・`2028年3月から` 0 → 0（同じ）。
 *
 * 割ると其の年の語は失はれるので、収録に行が無い年の形（`2028年3月から`）は 0 件で無言になる
 *（第 494 回の但し書は今の年の形にだけ残る – 残した差）。*/
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
function 列(文: string) {
  return new Set(全.filter((行) => Recommender.searchMatcher(文, 基準)(行) === true));
}
function 対称差(左: Set<string>, 右: Set<string>): number {
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}
function 日の案内(文: string) {
  return (Recommender.relativeDayNotes(文, 基準) || []).join("|");
}

describe("時刻から暦年を取る口が Date と總當たりで一致する（第 495 回）", () => {
  it("二〇一九年から二〇三一年までの日を一日刻みで較べる", () => {
    let 違ひ = 0;
    let 見た = 0;
    for (let 時 = Date.UTC(2019, 0, 1); 時 <= Date.UTC(2031, 11, 31); 時 += 86_400_000) {
      見た++;
      const 此方 = Recommender.暦年Ja(時);
      const 本家 = new Date(時 + 9 * 3_600_000).getUTCFullYear();
      if (此方 !== 本家) 違ひ++;
    }
    expect(見た).toBeGreaterThan(4000);
    expect(違ひ, "日番号からの暦の逆算が Date と食ひ違つた").toBe(0);
  });
  it("年を跨ぐ時刻（十二月三十一日・一月一日の境）でも一致する", () => {
    for (const 時 of [
      Date.UTC(2026, 11, 31, 14, 59),
      Date.UTC(2026, 11, 31, 15, 0),
      Date.UTC(2027, 0, 1, 0, 0),
      Date.UTC(2028, 1, 29, 3, 0),
      Date.UTC(2032, 1, 29, 3, 0),
    ]) {
      expect([時, Recommender.暦年Ja(時)]).toEqual([
        時,
        new Date(時 + 9 * 3_600_000).getUTCFullYear(),
      ]);
    }
  });
});

describe("數字で書いた先の年の形が、離した形と同じ行に出る（第 495 回）", () => {
  it("先の年は割る（今の年・過ぎた年は割らない）", () => {
    for (const [繋, 離, 件] of [
      ["2027年12月から", "2027年 12月から", 21],
      ["2027年12月以降", "2027年 12月以降", 21],
      ["2027年12月から 締切", "2027年 12月から 締切", 12],
    ] as Array<[string, string, number]>) {
      expect([繋, 対称差(列(繋), 列(離))], `「${繋}」が「${離}」と違ふ`).toEqual([繋, 0]);
      expect([繋, 列(繋).size]).toEqual([繋, 件]);
    }
    /* 今の年は割らずとも解ける（割ると減る – 実測 426 ⇔ 104）。*/
    expect(列("2026年1月から").size).toBe(426);
    expect(列("2026年 1月から").size).toBe(104);
    /* 其の年に締切が無い形（2028年）は、割つても割らなくても 0 件。*/
    expect(列("2028年3月から").size).toBe(0);
    expect(列("2028年 3月から").size).toBe(0);
  });
  it("先の年の行が出る形には但し書を付けない（行が出るので要らない）", () => {
    expect(列("2027年12月から").size).toBeGreaterThan(0);
    expect(日の案内("2027年12月から")).not.toContain("収録に無ければ");
  });
  it("残した差 – 其の年に締切が無い年は 0 件で無言（但し書は今の年の形にだけ残る）", () => {
    expect(列("2028年3月から").size).toBe(0);
    expect(日の案内("2028年3月から")).toBe("");
    expect(日の案内("2026年1月から")).toContain("其の年の締切が収録に無ければ何も出ません");
  });
  it("第 470 回〜第 494 回の実測は此の回で変へて居ない", () => {
    expect(列("2027年3月から").size).toBe(75);
    expect(列("2026年12月から").size).toBe(84);
    expect(列("2026年1月から").size).toBe(426);
    expect(列("来年12月から").size).toBe(21);
    expect(列("今年1月から").size).toBe(426);
    expect(列("来年12月").size).toBe(21);
    expect(列("来年上旬").size).toBe(2);
    expect(列("来週中旬").size).toBe(43);
    expect(列("年末上旬").size).toBe(40);
    expect(列("来月 末日").size).toBe(178);
    expect(列("週 末").size).toBe(145);
    expect(列("ml から").size).toBe(0);
    expect(列("締切時刻").size).toBe(180);
    expect(列("半 年後").size).toBe(2);
  });
});

describe("ビルド成果物に目が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("數字の年を割る目と、Date を讀まない暦年の口が現れる", () => {
    expect(物).toContain(
      "(^|[ \\u3000])([0-9]{4})年([0-9]{1,2}月|[〇一二三四五六七八九十]{1,3}月)(から|まで|より|以降|以後|この先|までに)",
    );
    expect(物).toContain("146097");
    /* 此の段に `new Date` を持ち込んで居ない事（固定時計の足場が落ちる – 第 494 回）。*/
    /* 註には語として出て来るので、呼び出しの形（`new Date(`）で見る。*/
    const 暦年の口 = 物.slice(
      物.indexOf("function 暦年Ja"),
      物.indexOf("function offsetCalendarDay", 物.indexOf("function 暦年Ja")),
    );
    expect(暦年の口, "暦年の口が時計を讀んで居る").not.toContain("new Date(");
  });
});
