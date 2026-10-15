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
function 案内(文: string) {
  return `${(Recommender.uiWordNoteJa(文) || "").trim()}|${(Recommender.relativeDayNotes(文, 基準) || []).join("/")}`;
}

describe("年の切れ目を指す語に旬を繋いだ形がその月の旬に解れる（第 492 回）", () => {
  it("年末は 12月・年度末は 3月・年初/年始/年明けは 1月・年度初めは 4月へ寄る", () => {
    /* 対照先は**月の語と旬を離して打つた形**（この目が寄せる先その物 – 詰めた `12月上旬` は
     * 別の段が解いて居て、件数は同じでも行の集合が違ふ）。*/
    for (const [繋, 月語] of [
      ["年末上旬", "12月 上旬"],
      ["年末中旬", "12月 中旬"],
      ["年末下旬", "12月 下旬"],
      ["年末初旬", "12月 初旬"],
      ["年度末上旬", "3月 上旬"],
      ["年度末下旬", "3月 下旬"],
      ["年初上旬", "1月 上旬"],
      ["年初下旬", "1月 下旬"],
      ["年始上旬", "1月 上旬"],
      ["年始下旬", "1月 下旬"],
      ["年明け中旬", "1月 中旬"],
      ["年度初め上旬", "4月 上旬"],
      ["年度初め下旬", "4月 下旬"],
    ] as Array<[string, string]>) {
      expect([繋, 対称差(列(繋), 列(月語))], `「${繋}」が「${月語}」と違ふ`).toEqual([繋, 0]);
      expect([繋, 案内(繋)]).toEqual([繋, 案内(月語)]);
      expect(列(繋).size > 0, `「${繋}」が未だ 0 件`).toBe(true);
    }
  });
  it("件数の実測（検査用ビルド – 実ビルドの値は頭の注）", () => {
    for (const [文, 件] of [
      ["年末上旬", 40],
      ["年末中旬", 42],
      ["年末下旬", 6],
      ["年度末上旬", 9],
      ["年初上旬", 6],
      ["年始下旬", 11],
    ] as Array<[string, number]>) {
      expect([文, 列(文).size]).toEqual([文, 件]);
    }
  });
  it("年の語に助詞が直に付いた形はその方の語だけの形と同じ", () => {
    for (const [付き, 素] of [
      ["来年に", "来年"],
      ["来年の", "来年"],
      ["今年に", "今年"],
      ["今年の", "今年"],
      ["去年に", "去年"],
    ] as Array<[string, string]>) {
      expect([付き, 対称差(列(付き), 列(素))], `「${付き}」が「${素}」と違ふ`).toEqual([付き, 0]);
      if (付き !== "去年に") expect(列(付き).size > 0, `「${付き}」が未だ 0 件`).toBe(true);
    }
    /* 過ぎた年は行が無いのが正しい（それでも寄せは効いている – 集合が同じ）。*/
    expect(列("去年に").size).toBe(0);
    /* その方の表が既に受ける形（来年度に）はその侭。*/
    expect(列("来年度に").size).toBe(列("来年度").size);
    expect(列("来月に").size).toBe(列("来月").size);
  });
});

describe("残した差と守り（第 466 回・第 491 回）", () => {
  it("離して打つた形は字面の重なりで決まる（同じ意味でも数が違う – 繋げた形だけを寄せた）", () => {
    /* 実測（検査用ビルド）– `年末 下旬 締切` 14 件 ⇔ `12月 下旬 締切` 11 件・`年末 上旬` 5 件 ⇔
     * `12月 上旬` 118 件。離した形を月の語へ寄せると行が減る向きが出るので、その侭にした。*/
    expect(列("年末 下旬 締切").size).toBe(6);
    expect(列("12月 下旬 締切").size).toBe(5);
    expect(列("年末 上旬").size).toBe(1);
    expect(列("年末上旬").size).toBe(40);
  });
  it("第 470 回〜第 491 回の実測はこの回で変へて居ない", () => {
    expect(列("年末").size).toBe(84);
    expect(列("年初").size).toBe(23);
    expect(列("年度末").size).toBe(29);
    expect(列("年始").size).toBe(23);
    expect(列("来年").size).toBe(114);
    expect(列("今年").size).toBe(427);
    expect(列("来年度").size).toBe(50);
    expect(列("年末 末").size).toBe(0);
    expect(列("来月 末日").size).toBe(178);
    expect(列("来年 末").size).toBe(21);
    expect(列("来年上旬").size).toBe(2);
    expect(列("来週中旬").size).toBe(43);
    /* 第 493 回に先の年の語を割る目を入れたので、離した形と同じ行が出る。*/
    expect(列("来年12月から").size).toBe(21);
    expect(列("来年12月から").size).toBe(列("来年 12月から").size);
    expect(列("今年1月から").size).toBe(427);
    expect(列("週 末").size).toBe(146);
    expect(列("ml から").size).toBe(0);
    expect(列("締切時刻").size).toBe(181);
  });
});

describe("ビルド成果物に目がある事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("四つの月の語への寄せと、助詞の剥ぎが現れる", () => {
    for (const 語 of ['"$112月 $3"', '"$13月 $3"', '"$11月 $3"', '"$14月 $3"']) {
      expect(物.split(語).length - 1, `寄せ先「${語}」の數`).toBe(1);
    }
    /* 助詞の剥ぎは年の語だけ（年度・月・週はその方の表が受けるので觸らない）。*/
    expect(物).toContain("((?:来|今|去|明|昨|翌)年)(?:に|の|へ)(?=$|[ \\u3000])");
  });
});
