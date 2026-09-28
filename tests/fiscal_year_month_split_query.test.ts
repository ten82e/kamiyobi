/* 第 487 回 – 年度の語に暦月を直に繋いだ形（`来年度3月` `来年度12月から`）
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、其の方の年度と其の月を
 * 並べた形は通るのに、繋いだ形は 0 件で案内も無かつた – `来年度3月` **0 件** ⇔ `来年度 3月` 13 件・
 * `今年度3月` **0 件** ⇔ 82 件・`来年度12月` **0 件** ⇔ 62 件・`来年度4月` **0 件** ⇔ 88 件。
 * 其れで其の月に其れより後・其れまでの語尾を続けた形も 0 件の侭だつた（`来年度3月から` **0 件** ⇔
 * `来年度 3月から` 302 件）で、其上 件の数欄は「検索欄では絞り込まずにいます」と書いて居た（行が 0 件の
 * 時には其れも嘘ではないが、其の語が解けるだけの話だったので第 485 回で残した差として載せた）。
 * 直しは其の年と暦月を二語に割るだけ（其の方が既に二語で解ける形 – 第 453 回）。
 *
 * **其れより後・其れまでの語尾が控へて居ても割る** – 年の語では同じ目を割ると行が減つた（`今年1月 から`
 * 796 件 → 393 件 – 第 485 回）が、年度の語では割つた方が増える方に行く（`来年度3月から` 0 件 → 302 件・
 * `今年度3月から` 0 件 → 435 件・`来年度12月まで` 0 件 → 62 件 – 実測 2026-11-08）。行を減らす直しは
 * せず、増やす方を採る（第 466 回・第 469 回）。其の二つの違いを検査に張る。*/
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
function 噓(文: string) {
  return 日の案内(文).includes("絞り込まずにいます") && 列(文).size > 0;
}

describe("年度の語に暦月を直に繋いだ形が其の年度 ∧ 其の月に解れる（第 487 回）", () => {
  it("継いだ形が空格で並べた形と一字も違わない行に出る", () => {
    for (const [繋, 離] of [
      ["来年度3月", "来年度 3月"],
      ["今年度3月", "今年度 3月"],
      ["来年度12月", "来年度 12月"],
      ["来年度4月", "来年度 4月"],
      ["来年度一月", "来年度 一月"],
    ] as Array<[string, string]>) {
      expect([繋, 対称差(列(繋), 列(離))]).toEqual([繋, 0]);
      expect(列(繋).size > 0, `「${繋}」が未だ 0 件`).toBe(true);
    }
  });
  it("其れより後・其れまでの語尾を続けた形も割れる（年の語では割らぬ – 実測の違い）", () => {
    for (const [繋, 離] of [
      ["来年度3月から", "来年度 3月から"],
      ["来年度12月まで", "来年度 12月まで"],
      ["今年度3月以降", "今年度 3月以降"],
    ] as Array<[string, string]>) {
      expect([繋, 対称差(列(繋), 列(離))]).toEqual([繋, 0]);
      expect(列(繋).size > 0, `「${繋}」が未だ 0 件`).toBe(true);
    }
    /* 其の方の語は其の年度の幅を名乗る（其れ以前の「絞り込みません」の文は並ばない）。*/
    expect(日の案内("来年度3月から")).toContain("来年度 = 2027年4月1日(木)〜2028年3月31日(金)");
    for (const 文 of ["来年度3月から", "来年度12月まで", "来年度3月", "今年度3月"]) {
      expect(噓(文), `「${文}」に行と食い違う案内が並んだ`).toBe(false);
    }
  });
  it("行数の実測（固定ハーネスの品書 435 行）", () => {
    expect(列("来年度3月").size).toBe(1);
    expect(列("今年度3月").size).toBe(28);
    expect(列("来年度12月").size).toBe(11);
    expect(列("来年度3月から").size).toBe(48);
    expect(列("来年度12月まで").size).toBe(11);
    /* 其の月を含まぬ年度の語は其の侭（`来年度` 48 件 ⊇ `来年度3月` 1 件）。*/
    expect(列("来年度").size).toBe(48);
    expect([...列("来年度3月")].every((行) => 列("来年度").has(行))).toBe(true);
  });
});

describe("其它の形は動かして居ない（第 352 回・第 484 回・第 485 回）", () => {
  it("年度のかたまりの対と、其の方で解ける年は其侭", () => {
    expect(列("来年度末").size).toBe(1);
    expect(列("来年度初め").size).toBe(29);
    expect(列("来年度中").size).toBe(48);
    expect(列("今年1月から").size).toBe(426);
    expect(日の案内("今年1月から")).toContain("2026年1月1日以降のこと（其の年の中まで）");
    /* 年の語に暦月を繋いで其れより後を続けた形は割らぬ決まり（割ると行が減る為）で、
     * 其の方の読み（其の年 ∧ 其の月）が其の幅を名乗る – 第 485 回。*/
    expect(列("来年12月から").size).toBe(0);
    expect(日の案内("来年12月から")).toContain("2027年12月1日以降のこと（其の年の中まで）");
    expect(噓("来年12月から")).toBe(false);
  });
  it("其の方が本当に解けぬ形は、今まで通りの導きが出る（其の文を張る）", () => {
    /* 公用の決まりの無い語（其の年の前半・年度の頭）と、表の日として探せぬ形は、其の侭其の導きを出す
     * （黙つて 0 件の侭にしない – 第 369 回）。其の文を反転させる改ざんが落ちる事を此處で張る。*/
    for (const 文 of ["来年前半から", "100万年前から"]) {
      expect(列(文).size, `「${文}」が行を出すやうになつた`).toBe(0);
      expect(日の案内(文), `「${文}」の導きが消えた`).toContain("検索欄では絞り込まずにいます");
    }
    expect(列("来年度頭").size).toBe(0);
  });
  it("第 470 回〜第 485 回の実測は此の回で変へて居ない", () => {
    expect(列("来月 末").size).toBe(178);
    expect(列("週 末").size).toBe(145);
    expect(列("来週 初旬").size).toBe(2);
    expect(列("明日以降").size).toBe(422);
    expect(列("来 上旬").size).toBe(68);
    expect(列("来月上旬").size).toBe(68);
    expect(列("締切時刻").size).toBe(180);
    expect(列("来月初め").size).toBe(0);
    expect(列("来年末").size).toBe(21);
    expect(列("来年初").size).toBe(23);
    expect(列("半 年後").size).toBe(2);
    expect(列("一 週間後").size).toBe(13);
    expect(列("ml から").size).toBe(0);
    expect(列("来週から").size).toBe(422);
  });
});

describe("ビルド成果物に目が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("年度を割る目と、年を割る目の語尾の扱いが別々である", () => {
    /* 年の語の目（語尾が控へる形を割らぬ）は一個、年度の語の目（語尾を問はぬ）は一個。*/
    expect(
      物.split("(?![ \\u3000]*(?:から|より|以降|以後|この先|以来|までに|まで))").length - 1,
    ).toBe(1);
    expect(
      物.split("((?:来|今|先|昨|翌)年度)([0-9]{1,2}月|[〇一二三四五六七八九十]{1,3}月)/g,").length -
        1,
    ).toBe(1);
    expect(物).toContain("(?:来|今|去|明|昨|翌)年)([0-9]{1,2}月");
  });
});
