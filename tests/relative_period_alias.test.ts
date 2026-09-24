/**
 * 相対的な期間の言い方（翌週・前週・翌月・前月・当年・前年）の検査（SPEC §4・§7・第 340 回）。
 * 実測（2026-09-30 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `翌週` **0 行**・`前週` **0 行**・`翌月` **0 行**・`前月` **0 行**・`当年` **0 行**・`前年` **0 行**で、
 * 件数欄の解決も出ていなかった。同じ日に成対の言い方は通っていた（`来週` 53 行・`先週` 26 行・
 * `来月` 240 行・`先月` 52 行・`今年` 789 行・`本年` 789 行・`去年` は語として解ける）。
 * 年では `翌年`（第 330 回）が既に通るので、**「翌～」の系列が週と月で途切れていた**計算になる。
 * 寄せ先は暦の決まりそのもの（翌週 = 来週、当年 = 今年）で、換算の發明はしていない。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
/* 固定時刻は日曜で、その日に限って『今週』の幅と『明日』が重なる – 暦の語の検査は
 * 基準日を動かして二本立てる（第 339 回の教訓）。 */
const 水曜 = Date.parse("2026-08-12T00:00:00Z");

function 行列表(語: string, 基準日: number = 基準): string[] {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
  const matches = Recommender.searchMatcher(語, 基準日);
  return rows.filter((row) => matches(String(row.hay)) === true).map((row) => String(row.hay));
}

function 行集合(語: string, 基準日: number = 基準): Set<string> {
  return new Set(行列表(語, 基準日));
}

function 対称差(a: string, b: string, 基準日: number = 基準): number {
  const x = 行集合(a, 基準日);
  const y = 行集合(b, 基準日);
  return [...x].filter((k) => !y.has(k)).length + [...y].filter((k) => !x.has(k)).length;
}

function 解決(語: string, 基準日: number = 基準): string {
  return Recommender.relativeDayNotes(語, 基準日).join(" ");
}

/** 対になる言い方（打たれた語 -> 表に在る語）。暦の決まりで一通に決まる物だけ。 */
const 対 = [
  ["翌週", "来週"],
  ["前週", "先週"],
  ["翌月", "来月"],
  ["前月", "先月"],
  ["当年", "今年"],
  ["前年", "去年"],
];

describe("相対的な期間の言い方", () => {
  it("『翌～』『前～』が対になる言い方と同じ行を出す", () => {
    対.forEach(([打たれた語, 表の語]) => {
      expect(対称差(打たれた語, 表の語), `"${打たれた語}" が "${表の語}" と違う行を出した`).toBe(0);
    });
    /* 対照の語が行を出す事も見る – ただし年の語は品書の年数で 0 行が正しい（実測で品書に
     * 出る年は 2026年と2027年だけ – `前年` = 2025 年は 0 行が真 – 次の検査で書く）。 */
    ["来週", "先週", "来月", "先月", "今年"].forEach((語) => {
      expect(行集合(語).size, `"${語}" が 0 行になった（前提が変わった）`).toBeGreaterThan(0);
    });
  });

  it("基準日を動かしても寄せ先が同じ（日曜の固定時刻だけで確かめない）", () => {
    対.forEach(([打たれた語, 表の語]) => {
      expect(対称差(打たれた語, 表の語, 水曜), `"${打たれた語}" が水曜の基準でズレた`).toBe(0);
    });
    /* 週は月〜日の塊 – 寄せただけでなく幅も同じ事を件数欄の解決で見る（打たれた語の名前を
     * 除いた幅の部分を比べる – 語の名前が違うのは正しい）。 */
    const 幅 = (語: string) => 解決(語, 水曜).replace(`${語} = `, "");
    expect(幅("翌週"), "翌週と来週で幅が違う").toBe(幅("来週"));
    expect(幅("前週"), "前週と先週で幅が違う").toBe(幅("先週"));
    expect(解決("翌週", 水曜)).toContain("2026年8月17日(月)");
  });

  it("『翌月以内』も月の間の話として解ける（月の語にだけ通る形を週の方に残さない）", () => {
    expect(対称差("翌月以内", "来月以内")).toBe(0);
    expect(行集合("翌月以内").size, "`翌月以内` が 0 行").toBeGreaterThan(0);
  });

  it("行の無い年に寄っても、在る年だと嘘をつかない（`前年` は 2025 年）", () => {
    /* 品書に出る年は 2026年と2027年だけ（実測）– `前年` = 2025 年なので 0 行が正しい。
     * 0 行を隠して「来週のような幅」に混ぜない事。 */
    expect(行集合("前年").size, "`前年` に行が出てしまった（品書の年が変わった？）").toBe(0);
    const 文 = 解決("前年");
    expect(文, "`前年` の解決を書かない").toContain("2025年");
    expect(文).toContain("1〜12 か月");
    /* 同じ年の語（去年・昨年）と同じ解答である事（打たれた語の名前を除いて比べる）。 */
    expect(文.replace("前年 = ", "")).toBe(解決("去年").replace("去年 = ", ""));
    expect(対称差("前年", "昨年")).toBe(0);
  });

  it("日本語として打たれない言い方まで受けない（`本周` `現週` `本月` `去週`）", () => {
    /* 受けない語を決めて書く – 「何でも分かる表」に見せない（第 337 回・第 339 回と同じ基準）。
     * 中国語混じりの `本周` `本月` は実測で 0 行で、日本語の言い換え（今週・今月）が既に通る。 */
    ["本周", "現週", "本月", "去週", "去月"].forEach((語) => {
      expect(行集合(語).size, `"${語}" まで受けてしまった`).toBe(0);
      expect(解決(語).trim(), `"${語}" に解決を立てた`).toBe("");
    });
  });

  it("既存の期間の語の解答を変えない（`来週` `再来月` `年内` `下旬`）", () => {
    expect(解決("来週")).toContain("2026年8月10日(月)〜8月16日(日)");
    expect(行集合("再来月").size).toBeGreaterThan(0);
    expect(行集合("年内").size).toBeGreaterThan(0);
    expect(行集合("来月下旬").size).toBeGreaterThan(0);
  });

  it("成果物が六つの語を持つ（第 340 回）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    ["翌週", "前週", "翌月", "前月", "当年", "前年"].forEach((語) => {
      expect(rec.includes(語), `組み立てた画面から ${語} が消えた`).toBe(true);
    });
    /* 月の「以内」の形にも入っている事（正規表現の選択から落ちたら行が出る語が消える）。 */
    expect(/翌月\|前月|前月\|翌月/.test(rec) || rec.includes("翌月|前月")).toBe(true);
  });
});
