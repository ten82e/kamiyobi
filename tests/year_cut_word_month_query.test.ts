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
/* 案内はその方が解けた語を名乗る為、繋いだ形と月の語では
 * 頭が違つて当然。その方が同じ範囲を指している事は ` = ` の後で見る。*/
function 解けた範囲(文: string) {
  const 節 = 案内(文).split(" = ");
  return 節.length > 1 ? 節.slice(1).join(" = ") : "";
}

describe("年の切れ目の語＋暦月・中がその月の語に解れる（第 502 回）", () => {
  it("年末は 12月、年初/年始/年明けは 1月、年度末は 3月、年度初めは 4月 – 暦月その物と『中』", () => {
    for (const [繋, 月語, 件] of [
      ["年末12月", "12月", 84],
      ["年末中", "12月中", 84],
      ["年初1月", "1月", 23],
      ["年初中", "1月中", 23],
      ["年始1月", "1月", 23],
      ["年始中", "1月中", 23],
      ["年明け1月", "1月", 23],
      ["年明け中", "1月中", 23],
      ["年度末3月", "3月", 29],
      ["年度末中", "3月中", 29],
      ["年度初め4月", "4月", 31],
      ["年度初め中", "4月中", 31],
      ["年度始め4月", "4月", 31],
      ["年度当初4月", "4月", 31],
    ] as Array<[string, string, number]>) {
      expect([繋, 対称差(列(繋), 列(月語))], `「${繋}」が「${月語}」と違ふ`).toEqual([繋, 0]);
      expect(列(繋).size, `「${繋}」が 0 件の侭`).toBeGreaterThan(0);
      expect([繋, 列(繋).size]).toEqual([繋, 件]);
      expect([繋, 解けた範囲(繋)], `「${繋}」の案内が「${月語}」と違ふ`).toEqual([
        繋,
        解けた範囲(月語),
      ]);
    }
  });
  it("語が后续いても同じ（中に・の締切）", () => {
    for (const [繋, 素] of [
      ["年末中に", "12月中に"],
      ["年度末の締切", "3月の締切"],
      ["年初中の締切", "1月中の締切"],
    ] as Array<[string, string]>) {
      expect([繋, 対称差(列(繋), 列(素))], `「${繋}」が「${素}」と違ふ`).toEqual([繋, 0]);
    }
  });
  it("中旬を食べない（第 492 回目の側 – 見張りを入れて実測で確かめた）", () => {
    /* 『中』の目を足す前にこの形が壊れた – `年明け中旬` が `1月中旬` ではなく `1月中` に化けた。
     * 見張りを付けてからはその月の中旬と同じ行・同じ案内。*/
    for (const [繋, 素] of [
      ["年明け中旬", "1月中旬"],
      ["年末中旬", "12月中旬"],
      ["年度末中旬", "3月中旬"],
      ["年度初め中旬", "4月中旬"],
      ["年初中旬", "1月中旬"],
    ] as Array<[string, string]>) {
      expect([繋, 対称差(列(繋), 列(素))], `「${繋}」が「${素}」と違ふ`).toEqual([繋, 0]);
      expect([繋, 解けた範囲(繋)], `「${繋}」の案内が違ふ`).toEqual([繋, 解けた範囲(素)]);
    }
    expect(列("年明け中旬").size).toBe(7);
    /* 旬の目もその侭通る。*/
    expect(対称差(列("年末上旬"), 列("12月 上旬"))).toBe(0);
  });
  it("週の語＋『内』はその週に解れる（第 500 回の年の語と同じ型）", () => {
    for (const [繋, 素, 件] of [
      ["再来週内", "再来週", 18],
      ["来週内", "来週", 43],
      ["今週内", "今週", 4],
      ["先週内", "先週", 8],
    ] as Array<[string, string, number]>) {
      expect([繋, 対称差(列(繋), 列(素))], `「${繋}」が「${素}」と違ふ`).toEqual([繋, 0]);
      expect([繋, 列(繋).size]).toEqual([繋, 件]);
    }
    /* 離して打つた形（`再来週 内`）は字面の重なりで旧の侭 – 第 492 回と同じで、繋いだ形だけ
     * 寄せる（離した形を動かせば行が減る向きに動く為）。その数を張る。*/
    expect(列("再来週 内").size).toBe(4);
    expect(案内("再来週 内")).toContain("2026年8月17日");
  });
  it("残した差 – 『内』は月の側の対がないために寄せない", () => {
    /* `12月内` は 0 件（月の側の対に無い）なので、`年末内` をその方に寄せても行が出ない。*/
    expect(列("12月内").size).toBe(0);
    for (const 文 of ["年末内", "年初内", "年度末内", "年度初め内"]) {
      expect([文, 列(文).size]).toEqual([文, 0]);
    }
  });
  it("第 470 回〜第 501 回の実測はこの回で変へて居ない", () => {
    expect(列("年内").size).toBe(425);
    expect(列("今年内").size).toBe(427);
    expect(列("2026年中").size).toBe(427);
    expect(列("令和9年中").size).toBe(114);
    expect(列("来月中").size).toBe(178);
    expect(列("年末").size).toBe(84);
    expect(列("年末 中").size).toBe(10);
    expect(列("来月 末日").size).toBe(178);
    expect(列("週 末").size).toBe(146);
    expect(列("ml から").size).toBe(0);
    expect(列("締切時刻").size).toBe(181);
    expect(列("2027年12月から").size).toBe(21);
    expect(列("半 年後").size).toBe(2);
    expect(列("一 週間後").size).toBe(13);
  });
});

describe("ビルド成果物に目がある事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("四つの『中』の目全部に『旬』の見張りが在り、暦月の目と週の内も現れる", () => {
    expect(物.split("(中)(?![旬])/g").length - 1).toBe(4);
    expect(物).toContain('"$112月中"');
    expect(物).toContain('"$11月中"');
    expect(物).toContain('"$13月中"');
    expect(物).toContain('"$14月中"');
    expect(物).toContain(")(12月)/g");
    expect(物).toContain(")(3月)/g");
    expect(物).toContain(")(4月)/g");
    expect(物).toContain(")週)内/g");
  });
});
