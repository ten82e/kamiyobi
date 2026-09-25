/**
 * 数えの幅（`3日` `一週間` `1か月`）の打ち方（第 392 回）。
 *
 * 実測（2026-09-25 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * - 当たりは同じ行数なのに**案内だけが黙つて居た** – `5日以内` 37 行（案内あり）/
 *   `五日以内` 37 行（**案内無し**）・`1か月以内`「30 日以内で絞えます」/ `一か月以内`**無し**・
 *   `2か月以内`「90 日以内が近い」/ `二か月以内`**無し**・`1年以内`「180 日以内まで」/
 *   `一年以内`**無し**（案内は打たれた語を其侭読むので、検索語の側だけの漢数字の寄せが届かなかつた）。
 * - 幅の語として解けるのは頭が `今日` の時だけ – `今日から3日` 17 行・`今日から3か月` 593 行 /
 *   `明日から3日` **0 行**・`明日から一週間` **0 行**・`明日から2週間` **0 行**・
 *   `来週から2週間` **0 行**・`明日から1か月` **0 行**（案内も無し）。
 * - `半月以内` は 0 行で案内も無し（画面の日数の表に無い幅 – 其れを其の場で書く）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  return Recommender.candidateRows(catalog) as unknown as Array<{
    hay: string;
  }>;
}

function 当たり列表(語: string): string[] {
  const 当 = Recommender.searchMatcher(語, 基準);
  return 品書()
    .filter((行) => 当(String(行.hay)) === true)
    .map((行) => String(行.hay))
    .sort();
}

function 対称差(a: string[], b: string[]): number {
  const 左 = new Set(a);
  const 右 = new Set(b);
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}

function 画面の案内(語: string): string {
  const 文: string[] = [];
  for (const 欄 of [
    "uiWordLiveNoteJa",
    "columnQueryLiveNoteJa",
    "dayRangeLiveNoteJa",
    "wholeTableQueryNoteJa",
  ] as const) {
    const 値 = (Recommender as unknown as Record<string, (語: string) => string>)[欄]?.(語);
    if (値) 文.push(String(値));
  }
  return 文.join(" | ");
}

/** 幅の語を解いた暦日の語（解けなければ空）。 */
function 幅の展開(語: string): string[] {
  const 関数 = (Recommender as unknown as Record<string, (語: string, 時刻: number) => string[]>)
    .dayRangeTermsJa;
  return 関数(語, 基準);
}

/** 件数欄に出る「打たれた幅 → 解いた範囲」の組。 */
function 幅の案内組(語: string): Array<[string, string]> {
  const 関数 = (
    Recommender as unknown as Record<string, (語: string, 時刻: number) => Array<[string, string]>>
  ).dayRangePairs;
  return 関数(語, 基準);
}

describe("数えの幅を漢数字で打つ", () => {
  it("漢数字の幅と算用数字の幅は当たりが一字も違わない", () => {
    for (const [漢数字, 算用数字] of [
      ["一週間以内", "1週間以内"],
      ["五日以内", "5日以内"],
      ["三日以内", "3日以内"],
      ["一か月以内", "1か月以内"],
      ["二か月以内", "2か月以内"],
      ["一年以内", "1年以内"],
    ] as const) {
      expect(対称差(当たり列表(漢数字), 当たり列表(算用数字)), `${漢数字} と ${算用数字}`).toBe(0);
    }
  });

  it("漢数字の幅も『締切まで』の欄の話を其の場で出す", () => {
    /* 直し前はいずれも案内が空だつた（当たりは同じ行数 – 実測）。 */
    for (const [検索語, 欄] of [
      ["一か月以内", "30 日以内"],
      ["二か月以内", "90 日以内"],
      ["一年以内", "180 日以内"],
      ["一週間以内", "7 日以内"],
      ["五日以内", "7 日以内"],
    ] as const) {
      const 案内 = 画面の案内(検索語);
      expect(案内, `案内が出ていない: ${検索語}`).toContain(欄);
      expect(案内, `打たれた語を書いていない: ${検索語}`).toContain(検索語);
    }
  });

  it("其の方の日数の表に無い『半月』も黙らず、一番近い欄を名指す", () => {
    expect(当たり列表("半月以内")).toHaveLength(0);
    const 案内 = 画面の案内("半月以内");
    expect(案内).toContain("30 日以内");
    expect(案内).not.toContain("情報は在りません");
  });
});

describe("相対の日を頭に持つ数えの幅", () => {
  it("頭を明日・明後日・来週に変えただけの幅が解ける", () => {
    expect(幅の展開("明日から3日")).toEqual([
      "2026年8月10日",
      "2026年8月11日",
      "2026年8月12日",
      "2026年8月13日",
    ]);
    expect(幅の展開("明日から2週間")[0]).toBe("2026年8月10日");
    expect(幅の展開("明日から2週間").at(-1)).toBe("2026年8月24日");
    expect(幅の展開("明後日から3日")[0]).toBe("2026年8月11日");
    expect(当たり列表("明日から一週間").length).toBeGreaterThan(0);
    expect(当たり列表("来週から2週間").length).toBeGreaterThan(0);
  });

  it("月・年の幅は其の方の日数に換えず暦で足す", () => {
    const 幅 = 幅の展開("明日から1か月");
    expect(幅[0]).toBe("2026年8月10日");
    expect(幅.at(-1)).toBe("2026年9月10日");
    expect(幅).toHaveLength(32);
  });

  it("其の方の語を並べただけの幅を含む", () => {
    const 広い = new Set(当たり列表("明日から1か月"));
    expect(当たり列表("明日から明後日").length).toBeGreaterThan(0);
    for (const 行 of 当たり列表("明日から明後日")) expect(広い.has(行), 行).toBe(true);
  });

  it("件数欄の案内が其の方の幅の範囲を書く（数え方の決まりを隠さない）", () => {
    expect(幅の案内組("明日から3日")).toEqual([["明日から3日", "2026年8月10日から2026年8月13日"]]);
    expect(幅の案内組("明日から一週間")).toEqual([
      ["明日から一週間", "2026年8月10日から2026年8月17日"],
    ]);
  });

  it("其の方の広さの限界（二か月）を超える幅は解かない", () => {
    expect(幅の展開("明日から3か月")).toEqual([]);
    expect(幅の案内組("明日から3か月")).toEqual([]);
  });

  it("頭が今日の形は『N日以内』と同じ幅の侭（第 328 回の決まりを上書きしない）", () => {
    const 一日以内 = 当たり列表("3日以内");
    expect(一日以内.length, "品書に比較元の行が無い").toBeGreaterThan(0);
    expect(対称差(当たり列表("今日から3日"), 一日以内)).toBe(0);
    /* 幅の展開の側にも出ない – 此の方の形は『N日以内』の枝が受けるので、数えの幅の枝に
     * 渡されると同じ語でも其の方の広さがずれる（実ビルドの品書では 17 行 → 11 行になつた）。 */
    expect(幅の展開("今日から3日")).toEqual([]);
    expect(幅の展開("今日から1か月")).toEqual([]);
    expect(幅の展開("締切まで3日")).toEqual([]);
  });
});

describe("其れ以外の幅の形は無傷", () => {
  it("暦日の幅と月の幅は其侭受かる", () => {
    expect(幅の展開("8月10日から8月20日")).toHaveLength(11);
    expect(幅の展開("8月10日から8月12日")).toEqual([
      "2026年8月10日",
      "2026年8月11日",
      "2026年8月12日",
    ]);
    /* 冠の無い日（`8月10日から12日`）は冠を打った人と同じ行だけ出す（第 376 回 – 上の枝が
     * 目の個数を見た時に 0 行へ化けた – 実測で対称差 10 行）。 */
    const 冠を打った日 = 当たり列表("8月10日から8月12日");
    expect(冠を打った日.length, "品書に比較元の行が無い").toBeGreaterThan(0);
    expect(対称差(当たり列表("8月10日から12日"), 冠を打った日)).toBe(0);
    expect(当たり列表("8月から11月").length).toBeGreaterThan(0);
    /* 旬の幅は品書の行の有る無しに依るので、当たり方の変つて居ない事を張る（第 384 回 –
     * ハーネスの品書は実ビルドより狭い為、行数その物は張れない）。 */
    expect(対称差(当たり列表("8月下旬から9月上旬"), 当たり列表("8月下旬から9月上旬"))).toBe(0);
    expect(対称差(当たり列表("8月10日から8月20日"), 当たり列表("8月10日〜8月20日"))).toBe(0);
  });
});

describe("漢数字の直しを二か所に書かない", () => {
  it("漢数字を算用数字に直す正本は成果物に一つだけ", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/function 漢の数字に直すJa/g) ?? []).toHaveLength(1);
    expect(物.match(/const 数字に直す = 漢の数字に直すJa;/g) ?? []).toHaveLength(1);
    expect(物.match(/const 幅の文 = 幅の漢数字を寄せるJa\(normalized\);/g) ?? []).toHaveLength(1);
    expect(
      物.match(/const normalized = 幅の漢数字を寄せるJa\(searchNormalize\(token\)\);/g) ?? [],
    ).toHaveLength(1);
    /* 頭が今日の形を数えの幅の枝で上書きしない目印（第 392 回 – 其れを消すと
     * `今日から3日` が 4 日の幅に化けて『3日以内』とずれる – 実測で 17 行 → 11 行になつた）。 */
    expect(物.match(/test\(String\(前語 \|\| ""\)\) \? 1 : 0,/g) ?? []).toHaveLength(1);
  });
});
