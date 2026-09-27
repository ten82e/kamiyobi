/* 第 482 回 – 漢数字の月・日を離つて打つ形（`八 月` `五 日` `一 月 五 日`）
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、離つた側は 0 件で
 * 案内も無かつた – `八 月` **0 件** / `8月` 216 件・`一 月` **0 件** / 99 件・`五 日` **0 件** /
 * 73 件・`二十 日` **0 件** / 100 件・`一 月 五 日` **0 件** / `1 月 5 日` 21 件・
 * `八 月 二十 日` **0 件** / 13 件・`三 月 と 四 月` **0 件** / 157 件・`八 月 の 締切` **0 件** /
 * 114 件。其の方の語を決める目が、漢数字と単位が**繋がれて居る形だけ**を見て居た為で
 * （`日付の漢数字` – 第 392 回）、算用数字では通る打ち方だけ通る状態だつた（第 468 回）。
 * 週の語は第 481 回、半年の語は第 480 回で別に直して居る。
 *
 * **『日』の後に『後』『前』『間』が離つて控へる形は畳まない** – 其の方の数の語は語を割る段が
 * 打たれた空格の侭を名乗る決まりで受ける為、此の段で算用数字に畳むと名乗りだけが化ける
 * （実測 2026-11-08 – 畳んだ版では「五 日後 = …」が「5日後 = …」になつて其れを張る頁が落ちた）。
 * 同じ理由で『年』も列に載せて居ない（`一 年 後` は其の侭 2 件で、案内は「一 年 後 = …」）。*/
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
  return Recommender.relativeDayNotes(文, 基準).join("|");
}

describe("漢数字の月・日を離つて打つ形が算用数字と同じ行に出る（第 482 回）", () => {
  it("七の対が算用数字で打つ形と一字も違わない行に出る（実測 – 前は漢数字側が 0 件だつた）", () => {
    for (const [漢, 数] of [
      ["八 月", "8 月"],
      ["一 月", "1 月"],
      ["五 日", "5 日"],
      ["二十 日", "20 日"],
      ["一 月 五 日", "1 月 5 日"],
      ["八 月 二十 日", "8 月 20 日"],
      ["三 月 と 四 月", "3 月 と 4 月"],
    ] as Array<[string, string]>) {
      expect([漢, 対称差(列(漢), 列(数))]).toEqual([漢, 0]);
      expect([漢, 列(漢).size > 0]).toEqual([漢, true]);
    }
  });
  it("行数の実測（固定ハーネスの品書 435 行 – 実ビルド 868 行では其れより多い）", () => {
    expect(列("八 月").size).toBe(118);
    expect(列("一 月").size).toBe(23);
    expect(列("五 日").size).toBe(29);
    expect(列("二十 日").size).toBe(66);
    expect(列("一 月 五 日").size).toBe(5);
    expect(列("八 月 二十 日").size).toBe(7);
    expect(列("三 月 と 四 月").size).toBe(56);
    expect(列("八 月 の 締切").size).toBe(114);
  });
  it("其の方に何も足さない – 月は其の月、日は其の日で絞れる", () => {
    expect(案内("八 月")).toBe("");
    expect(列("八 月").size).toBeLessThan(列("締切").size);
    /* 其の方の語（一 月）が解けるやうになつたので、案内は其の月の下旬を書く – 前は其の月（八月）の
     * 下旬と取り違へて居た（実測 – 案内「1月の 下旬 = 2027年1月21日(木)〜2027年1月31日(日)」）。
     * 数字の形は其の方の書き換への物（第 481 回で `一 週間後` → 「7日後 = …」と同じ）。*/
    expect(案内("一 月の 下旬")).toContain("2027年1月21日(木)〜2027年1月31日(日)");
  });
});

describe("名乗りは打たれた侭 – 畳まない形の実測（第 459 回・第 466 回）", () => {
  it("其の後に日の数の語が控へる形と『年』は畳まない", () => {
    /* 実測 2026-11-08 – 此の目へ『日』を広く载せた版では「5日後 = …」に化けて、其れを張る頁が
     * 二十四本落ちた。後方照合で守つた後の値。*/
    expect(案内("五 日後")).toContain("五 日後 = 2026年8月14日(金)");
    expect(列("五 日後").size).toBe(17);
    expect(案内("一 年 後")).toContain("一 年 後 = 2027年8月9日(月)");
    expect(案内("一 か月後")).toContain("一 か月後 = 2026年9月9日(水)");
    expect(列("一 か月後").size).toBe(4);
    expect(案内("第 二 週")).toContain("第 二 週 = 2026年8月8日(土)〜2026年8月14日(金)");
  });
  it("第 478 回〜第 481 回と其它の機械は其侭", () => {
    expect(列("来月 終わり").size).toBe(178);
    expect(列("締切時刻").size).toBe(180);
    expect(列("一 週間後").size).toBe(13);
    expect(列("半 年後").size).toBe(2);
    expect(列("週 末").size).toBe(145);
    expect(列("ml から").size).toBe(0);
    expect(列("明日以降").size).toBe(422);
    expect(列("来 上旬").size).toBe(68);
    expect(列("明日 から 明後日").size).toBe(4);
  });
});

describe("ビルド成果物に目が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("月日の目が後方照合付きで現れる", () => {
    expect(物.match(/月日の漢数字の空格/g)?.length).toBe(2);
    expect(物).toContain("([月日])(?![ \\u3000]*(?:後|前|間))");
    /* 週の目（第 481 回）と其の方の漢数字の目は其侭。*/
    expect(物.match(/週の漢数字の空格/g)?.length).toBe(2);
    expect(物).toContain(
      "([〇一二三四五六七八九十]{1,4})(か月|カ月|ヵ月|ヶ月|ケ月|箇月|年|月|日|週間|週)",
    );
  });
  it("検査の使い捨て目録を掃く入口が張られる（第 482 回 – ディスクの詰まりの片付け）", () => {
    /* 実測（2026-11-08）で、検査の使い捨て目録が `$TMPDIR` に 139 546 個・約 40 GB 積まつて
     * ディスクが 97 % まで詰まつた。其れを掃く入口（`npm run clean:tmp`）と、検査が自分の作った
     * 目録を終了時に消す仕組み（`tempWork`）を同じ回で入れた。*/
    const 手 = readFileSync("package.json", "utf8");
    expect(手).toContain("clean_tmp.ts");
    expect(手).toContain("clean:tmp");
  });
});
