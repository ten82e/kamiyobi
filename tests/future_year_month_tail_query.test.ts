/* 第 493 回 – 先の年の語に暦月を繋ぎ、其の後に其れより後・其れまでの語尾を続けた形
 *（`来年12月から` `来年12月まで` `翌年3月以降`）
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、此の形は 0 件で
 * 案内も無く、件の数欄だけが「2027年12月1日以降のこと（其の年の中まで）」と幅を名乗つて居た –
 * **案内が書いて居る事を畫面が果たさない形**（第 332 回）。離して打つた形は通つて居た
 *（`来年 12月から` 84 件・`来年 12月まで` 84 件・`2027年 12月から` 84 件）。
 *
 * 直しは、**先の年を指す語**（来年・明年・翌年・再来年）と暦月の間を割つて、月と語尾を其の方の表へ
 * 渡すだけ（第 453 回 – 其の方が既に解ける形に揃べる）。
 *
 * **今の年・過ぎた年・數字の年は割らない** – 實測で、今の年の形は割らずとも解けて居り、割ると行が
 * 減る（`今年1月から` 796 件 → `今年 1月から` 393 件・検査用ビルド 426 → 104）。行を減らす直しは
 * しないの決まりに従ひ觸らない。數字の年（`2027年12月から`）は今の年と較べる手立てが此の段に無いので
 * 此の回では觸らず、0 件の侭（残した差）。*/
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

describe("先の年の語＋暦月＋其れより後が、離した形と同じ行・同じ案内になる（第 493 回）", () => {
  it("来年・明年・翌年・再来年で、語尾を問はず同じ（件數は検査用ビルド）", () => {
    for (const [繋, 離, 件] of [
      ["来年12月から", "来年 12月から", 21],
      ["来年12月まで", "来年 12月まで", 21],
      ["来年12月より", "来年 12月より", 21],
      ["来年12月以降", "来年 12月以降", 21],
      ["来年3月まで", "来年 3月まで", 28],
      ["来年1月まで", "来年 1月まで", 23],
      ["翌年12月から", "翌年 12月から", 21],
    ] as Array<[string, string, number]>) {
      expect([繋, 対称差(列(繋), 列(離))], `「${繋}」が「${離}」と違ふ`).toEqual([繋, 0]);
      expect([繋, 案内(繋)]).toEqual([繋, 案内(離)]);
      expect([繋, 列(繋).size]).toEqual([繋, 件]);
    }
    /* 品書に其の年の締切が無い形（検査用ビルド）も、離した形と同じ 0 件である事で張る。*/
    for (const [繋, 離] of [
      ["再来年3月から", "再来年 3月から"],
      ["明年3月から", "明年 3月から"],
    ] as Array<[string, string]>) {
      expect([繋, 対称差(列(繋), 列(離))]).toEqual([繋, 0]);
      expect([繋, 列(繋).size]).toEqual([繋, 0]);
    }
  });
  it("語尾の後ろに語が続く形も同じ", () => {
    for (const [繋, 離, 件] of [
      ["来年12月から 締切", "来年 12月から 締切", 12],
      ["来年12月からの締切", "来年 12月からの締切", 12],
    ] as Array<[string, string, number]>) {
      expect([繋, 対称差(列(繋), 列(離))]).toEqual([繋, 0]);
      expect([繋, 列(繋).size]).toEqual([繋, 件]);
    }
  });
  it("案内は其の年の幅を名乗る（月まで名乗つて行が出ない形は無くなつた）", () => {
    for (const 文 of ["来年12月から", "来年12月まで", "来年3月まで"]) {
      expect(案内(文), `「${文}」の案内`).toContain("来年 = 2027年");
      expect(案内(文), `「${文}」に絞り込めぬ案内が並んだ`).not.toContain("絞り込まずにいます");
      expect(列(文).size > 0, `「${文}」が 0 件の侭`).toBe(true);
    }
  });
});

describe("割らないと決めた形（第 466 回・第 485 回）", () => {
  it("今の年は割らずとも解けて居り、割ると行が減る", () => {
    /* 實測 – `今年1月から` 426 件（検査用ビルド）⇔ 割つた `今年 1月から` 104 件。行を減らす直しは
     * しないので、今の年・過ぎた年は觸らない。*/
    expect(列("今年1月から").size).toBe(426);
    expect(列("今年 1月から").size).toBe(104);
    expect(列("今年12月から").size).toBe(84);
    expect(案内("今年1月から")).toContain("2026年1月1日以降のこと（其の年の中まで）");
  });
  it("残した差 – 數字の年で書いた形は 0 件の侭", () => {
    /* 此の段に今の年が無いので、數字の年（`2027年12月から`）は割る判斷が出來ない。今の年の數字の形は
     * 其の方で解ける（`2026年1月から` 426 件）。*/
    expect(列("2027年12月から").size).toBe(0);
    expect(列("2026年1月から").size).toBe(426);
  });
  it("第 470 回〜第 492 回の実測は此の回で変へて居ない", () => {
    expect(列("来年12月").size).toBe(21);
    expect(列("来年12月に").size).toBe(21);
    expect(列("來年12月".replace("來", "来")).size).toBe(21);
    expect(列("来年上旬").size).toBe(2);
    expect(列("来週中旬").size).toBe(43);
    expect(列("年末上旬").size).toBe(40);
    expect(列("来月 末日").size).toBe(178);
    expect(列("週 末").size).toBe(145);
    expect(列("ml から").size).toBe(0);
    expect(列("締切時刻").size).toBe(180);
    expect(列("半 年後").size).toBe(2);
    expect(列("一 週間後").size).toBe(13);
    expect(列("今年1月から").size).toBe(426);
    expect(列("2026年1月から").size).toBe(426);
  });
});

describe("ビルド成果物に目が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("先の年の語を割る目が現れ、今の年は列に入つて居ない", () => {
    expect(物).toContain("|再来年)([0-9]{1,2}月");
    expect(物).toContain("(から|まで|より|以降|以後|この先|までに)/g,");
    /* 今の年・過ぎた年は此の列に入れない（割ると行が減る為）。*/
    expect(物).not.toContain(
      "((?:来|今|去|明|昨|翌)年|再来年)([0-9]{1,2}月|[〇一二三四五六七八九十]{1,3}月)(から|まで",
    );
  });
});
