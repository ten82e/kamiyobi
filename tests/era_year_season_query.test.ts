/* 第 498 回 – 元号で書いた年を繋げた形（`令和九年上旬` `令和8年12月` `令和九年12月から`）
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、此の形は 0 件だつた –
 * 離して打てば通る（`令和九年 上旬` 11 件・`令和九年 中旬` 8 件・`令和九年 下旬` 20 件・
 * `令和九年 12月` 84 件・`令和九年 12月 から` 84 件）。其の年の語（来年・今年）と數字の年は
 * 第 487 回〜第 497 回に割れるやうにしたが、元号は列に入れて居なかつた。
 *
 * 直しは、旬の目と語尾の目に元号の年を足すだけ。西暦への讀み替へは**其方の機械**
 *（和暦の語を解く口）に聞く – 元号の表を二つ持たない（第 375 回の決まり。其れを見張つて居る検査が
 * 在り、最初に自分の表を書いた版は其れで落ちた – 第 498 回に實測）。
 *
 * 語尾の無い年＋暦月（`令和8年4月`）は元から解けて居た（其方の機械が受ける）ので、其の列には
 * 入れない – 入れると案内が別物に成る（實測で和暦の頁が二本落ちた）。*/
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

describe("元号で書いた年を繋げた形が、離した形と同じ行に出る（第 498 回）", () => {
  it("旬を繋げた形（行が出る年）", () => {
    for (const [繋, 離] of [
      ["令和8年上旬", "令和8年 上旬"],
      ["令和8年中旬", "令和8年 中旬"],
      ["令和8年下旬", "令和8年 下旬"],
      ["令和8年初旬", "令和8年 初旬"],
      ["令和九年上旬", "令和九年 上旬"],
      ["令和九年下旬", "令和九年 下旬"],
      ["平成三十八年上旬", "平成三十八年 上旬"],
    ] as Array<[string, string]>) {
      expect([繋, 対称差(列(繋), 列(離))], `「${繋}」が「${離}」と違ふ`).toEqual([繋, 0]);
      expect([繋, 日の案内(繋)], `「${繋}」の案内が違ふ`).toEqual([繋, 日の案内(離)]);
    }
    expect(列("令和8年上旬").size).toBeGreaterThan(0);
  });
  it("暦月を繋げた形は、西暦で同じ月と同じ行（先の年は第 499 回に割つた）", () => {
    /* 檢查用ビルド（435 行）の實測 – `令和8年12月` = 84 = `2026年12月`・`令和8年 12月` = 84（今の年は
     * 詰めた形が其の方で解ける）。先の年は第 499 回に割る目を入れたので、`令和9年12月` は離した形と
     * 同じ行が出る（第 498 回には 0 件で、離した形だけが行を出して居た – 殘した差が直つた）。*/
    expect(対称差(列("令和8年12月"), 列("2026年12月"))).toBe(0);
    expect(対称差(列("令和8年12月"), 列("令和8年 12月"))).toBe(0);
    expect(列("令和8年12月").size).toBe(84);
    expect([列("令和9年12月").size, 列("令和九年12月").size]).toEqual([21, 21]);
    expect(対称差(列("令和九年12月"), 列("令和九年 12月"))).toBe(0);
  });
  it("西暦への讀み替へは其方の機械と同じ（自分の元号表を持たない）", () => {
    /* `令和九年` = 2027年・`令和8年` = 2026年（其方の機械が案内に書く）。*/
    expect(日の案内("令和九年")).toContain("2027年");
    expect(日の案内("令和8年")).toContain("2026年");
    /* 語尾の無い年＋暦月（`令和8年4月`）は元から解けて居る – 割らずに其の侭。*/
    expect(日の案内("令和8年4月")).toContain("2026年4月");
  });
  it("日の続く形は此の目で割らない（其方の案内を保つ）", () => {
    /* `令和九年12月10日` は其の方（其の日の幅）の案内の侭 – 此の目は月で終る形だけを見る。*/
    expect(日の案内("令和九年12月10日")).toContain("2027年12月10日");
    expect(日の案内("令和九年12月10日")).not.toContain("年の締切（1〜12 か月）");
    expect(日の案内("令和8年4月10日頃")).toContain("2026年4月10日");
    expect(日の案内("令和8年4月10日頃")).not.toContain("年の締切（1〜12 か月）");
  });
  it("第 470 回〜第 497 回の実測は此の回で変へて居ない", () => {
    expect(列("2027年上旬").size).toBe(列("2027年 上旬").size);
    expect(列("2027年12月から").size).toBe(21);
    expect(列("2026年1月から").size).toBe(426);
    expect(列("2028年3月").size).toBe(0);
    expect(列("再来年3月").size).toBe(0);
    expect(列("来年上旬").size).toBe(2);
    expect(列("来週中旬").size).toBe(43);
    expect(列("年末上旬").size).toBe(40);
    expect(列("来月 末日").size).toBe(178);
    expect(列("週 末").size).toBe(145);
    expect(列("ml から").size).toBe(0);
    expect(列("締切時刻").size).toBe(180);
  });
});

describe("ビルド成果物に目が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("元号の年を割る目が旬と語尾の二箇所に在り、西暦は其方の機械に聞いて居る", () => {
    /* 三箇所 – 旬の目・語尾の目・語尾の無い先の年の目（第 498 回・第 499 回）。*/
    expect(物.split("(?:明治|大正|昭和|平成|令和)").length - 1).toBe(3);
    expect(物).toContain("eraYearTermsJa(年)?.西暦");
    /* 日の形を外す見張りは其の侭（第 497 回）。*/
    expect(物).toContain("(?![0-9]{1,2}日|[0-9第])");
  });
});
