/**
 * 漢数字で打たれた日付・期間の検査（`八月` `八月二十二日` `三十日` `三日以内` `令和七年` `二〇二六年`）。
 * SPEC §4・§7・第 349 回。
 * 実測（2026-10-07 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `8月` 210 行・`22日` 63 行・`30日` 82 行・`8月下旬` 91 行・`8月まで` 210 行・`8月締め` 189 行・
 * `3日後` 3 行・`1週間後` 17 行・`3日以内` 17 行・`令和8年` 789 行が通るのに、`八月` **0 行**・
 * `八月締切` **0 行**・`八月二十二日` **0 行**・`二十二日` **0 行**・`三十日` **0 行**・
 * `八月下旬` **0 行**・`八月まで` **0 行**・`三日後` **0 行**・`一週間後` **0 行**・
 * `三日以内` **0 行**・`令和七年` **0 行**・`平成三十年` **0 行**・`二〇二六年` **0 行**だった。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { jsFunction } from "./runtime_extract.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 行列表(語: string): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
  const matches = Recommender.searchMatcher(語, 基準);
  return rows.filter((row) => matches(String(row.hay)) === true);
}

function 対称差(a: string, b: string): number {
  const x = new Set(行列表(a).map((r) => r.hay));
  const y = new Set(行列表(b).map((r) => r.hay));
  return [...x].filter((k) => !y.has(k)).length + [...y].filter((k) => !x.has(k)).length;
}

function 全案内(語: string): string {
  return [
    Recommender.querySynonymNotes(語).join(" "),
    Recommender.uiWordNoteJa(語),
    Recommender.uiWordLiveNoteJa(語),
    Recommender.relativeDayNotes(語, 基準).join(" "),
  ]
    .filter((文) => 文)
    .join(" / ");
}

/** 成果物に組み立てられた書き換え関数を実際に走らせる（其の関数が参照する表の宣言も置く – 第 347 回）。 */
function 書き換え(語: string): string {
  const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  const 本体 = jsFunction(rec, "collapseRelativeDayPhrase");
  const 表 = rec.slice(rec.indexOf("const RELATIVE_DAY_PHRASES_JA"));
  const 表の宣言 = 表.slice(0, 表.indexOf("];") + 2);
  expect(表の宣言.includes("["), "`RELATIVE_DAY_PHRASES_JA` の宣言が見つからない").toBe(true);
  const 関数 = new Function("Recommender", `${表の宣言}\nreturn (${本体});`)(Recommender) as (
    語: string,
  ) => string;
  return 関数(語);
}

describe("漢数字で打つ日付", () => {
  it("`八月` `十一月` `十二月` は数字で打つのと同じ行を出す", () => {
    expect(行列表("8月").length, "対照の `8月` が 0 行").toBeGreaterThan(0);
    for (const [漢, 数字] of [
      ["一月", "1月"],
      ["八月", "8月"],
      ["十月", "10月"],
      ["十一月", "11月"],
      ["十二月", "12月"],
    ] as Array<[string, string]>) {
      expect(対称差(漢, 数字), `${漢} が ${数字} と違う行を出した`).toBe(0);
    }
    /* 月の幅に繋がれた形も其侭通る（第 348 回の表は数字の形しか見ていない – 其の前に寄せる）。 */
    expect(対称差("八月下旬", "8月下旬"), "`八月下旬` が違う行を出した").toBe(0);
    expect(全案内("八月下旬"), "其の幅の日付を書いていない").toContain("2026年8月21日(金)");
  });

  it("`二十二日` `三十日` `八月二十二日` も数字と同じ行を出す", () => {
    expect(対称差("二十二日", "22日"), "`二十二日` が違う行を出した").toBe(0);
    expect(対称差("三十日", "30日"), "`三十日` が違う行を出した").toBe(0);
    expect(対称差("二十日", "20日"), "`二十日` が違う行を出した").toBe(0);
    expect(対称差("八月二十二日", "8月22日"), "`八月二十二日` が違う行を出した").toBe(0);
    expect(対称差("八月締切", "8月 締切"), "`八月締切` が違う行を出した").toBe(0);
    expect(対称差("八月締め", "8月 締切"), "`八月締め` が違う行を出した").toBe(0);
    /* 案内は実際に照った語を書く（探していない語を画面に書かない – 第 345 回と同じ決まり）。 */
    expect(全案内("八月締切"), "寄せた語を名指していない").toContain("「8月」と「締切」");
    expect(全案内("八月締切"), "探していない語を名指した").not.toContain("「八月」と「締切」");
  });

  it("`一週間後` `三日以内` も数字と同じ行を出す（其の日付の案内は其侭立つ）", () => {
    expect(対称差("一週間後", "1週間後"), "`一週間後` が違う行を出した").toBe(0);
    expect(対称差("三日後", "3日後"), "`三日後` が違う行を出した").toBe(0);
    expect(対称差("二十日後", "20日後"), "`二十日後` が違う行を出した").toBe(0);
    expect(対称差("三日以内", "3日以内"), "`三日以内` が違う行を出した").toBe(0);
    /* 幅の案内は最初の日付に年を書き、後続は書かない – 其の方の形そのまま張る。 */
    expect(全案内("三日以内"), "其の日付を書いていない").toContain("2026年8月9日(日)");
    expect(全案内("三日以内"), "幅の終わりを書いていない").toContain("8月12日(水)");
  });

  it("`令和七年` `平成三十年` `二〇二六年` も年として受ける（過ぎた年はその旨を書く）", () => {
    expect(対称差("令和八年", "令和8年"), "`令和八年` が違う行を出した").toBe(0);
    expect(対称差("二〇二六年", "2026年"), "`二〇二六年` が違う行を出した").toBe(0);
    expect(対称差("令和七年", "令和7年"), "`令和七年` が違う行を出した").toBe(0);
    expect(対称差("平成三十年", "平成30年"), "`平成三十年` が違う行を出した").toBe(0);
    expect(全案内("令和七年"), "其の年が過ぎている事を書いていない").toContain("2025年");
    expect(全案内("令和八年")).toContain("2026年");
  });

  it("`まで` `いっぱい` に漢数字を繋げた形も、寄せた語を其の場で書く", () => {
    expect(対称差("八月まで", "8月まで"), "`八月まで` が違う行を出した").toBe(0);
    expect(対称差("八月いっぱい", "8月いっぱい"), "`八月いっぱい` が違う行を出した").toBe(0);
    expect(対称差("八月二十二日まで", "8月22日まで"), "`八月二十二日まで` が違う行を出した").toBe(
      0,
    );
    expect(全案内("八月まで"), "何として探したかを書いていない").toContain("「八月まで」は「8月」");
    expect(全案内("八月二十二日まで")).toContain("「8月22日」の締切として");
    /* 日付の範囲に解く形は其の方の案内の侭（第 347 回の対照）。 */
    for (const 語 of ["明日まで", "来週まで", "来週末まで"]) {
      expect(全案内(語), `${語} の日付の案内が消えた`).toContain("2026年8月");
      expect(全案内(語), `${語} を寄せた`).not.toContain("の締切として探しています");
    }
  });
});

describe("寄せない物", () => {
  it("数の語が単体で立つ名称・その日の語は触らない", () => {
    for (const 語 of [
      "一橋",
      "三重",
      "十二",
      "五十",
      "今日",
      "明日",
      "本日",
      "来年",
      "先週",
      "週末",
    ]) {
      expect(書き換え(語), `${語} を寄せた`).toBe(語);
    }
    /* 読み取れない形は其侭返す（壊れた語を作らない）。 */
    expect(書き換え("十十年")).toBe("十十年");
    expect(書き換え("一十年")).toBe("10年");
    expect(書き換え("十月")).toBe("10月");
    expect(書き換え("八月二十二日")).toBe("8月22日");
  });

  it("第 344 – 348 回の形は此の回合の変更でも其侭通る", () => {
    expect(書き換え("週末締切")).toBe("週末 締切");
    expect(書き換え("上旬締切")).toBe("上旬 締切");
    expect(書き換え("8月半ば")).toBe("8月中旬");
    expect(書き換え("本年度")).toBe("今年度");
    expect(書き換え("来週末まで")).toBe("来週末まで");
    expect(書き換え("3月末")).toBe("3月");
    expect(対称差("3日後", "3日以内") > 0, "`3日後` と `3日以内` が同じ行になった").toBe(true);
  });
});

describe("成果物", () => {
  it("漢数字の読みは関数の中に在り、日付の接頭辞に繋がれた形だけを見る", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 本文 = jsFunction(rec, "collapseRelativeDayPhrase");
    expect(本文.length, "`collapseRelativeDayPhrase` が見つからない").toBeGreaterThan(0);
    expect(本文.includes("数字に直す"), "漢数字の読みが関数の外に出た").toBe(true);
    expect(本文.includes("日付の漢数字"), "漢数字の規則が消えた").toBe(true);
    expect(
      本文.includes("(年|月|日|週間|週)"),
      "日付の接頭辞に繋がれた形だけを見る形が消えた",
    ).toBe(true);
    /* 数の語が単体で立つ形を寄せる形を又増やさない（名称を壊す – 上の検査で守る）。 */
    expect(
      本文.includes("/([〇一二三四五六七八九十]{1,4})/g"),
      "単体の数の語を寄せる形を足した",
    ).toBe(false);
    /* 案内は漢数字の読みを又書かず、書き換え関数に聞いて揃える（第 339 回 – 写しは必ずずれる）。 */
    expect(rec.includes("頭の形"), "案内が書き換え関数に聞かなくなった").toBe(true);
  });
});
