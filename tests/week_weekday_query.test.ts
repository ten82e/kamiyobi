/**
 * 週と曜日を**繋げて**打った形の検査（SPEC §4・§7・第 329 回）。
 * 実測（2026-09-28 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `今週の水曜` 1 行 / `今週金曜` **0 行**、`来週の木曜日` 4 行 / `来週月曜` **0 行**・
 * `来週火曜` **0 行**・`来週土曜` **0 行**・`今週金曜までに` **0 行**・`来週月曜まで` **0 行**。
 * 離して打たれた形は「今週の行 AND 水曜の語」になり、締切日が別の日の行が混ざっていた
 * （`今週の水曜` 1 行と `2026年8月5日` 3 行は**別の行**だった）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z"); /* 日曜 */

/** 品書（`catalog.json`）で、その語が落とした行の集合。 */
function 行集合(語: string): Set<string> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{
    key?: string;
    hay: string;
  }>;
  const matches = Recommender.searchMatcher(語, 基準);
  return new Set(
    rows
      .filter((row) => matches(String(row.hay)) === true)
      .map((row) => String(row.key ?? row.hay)),
  );
}

describe("週と曜日を繋げた入力", () => {
  it("その週のその曜日 1 日に解ける（固定時計で実測した暦日）", () => {
    const 解 = (語: string) => Recommender.pressedWeekdayJa(語, 基準);
    expect(解("今週金曜"), "今週金曜が解けない").toEqual(["2026年8月7日"]);
    expect(解("今週金曜日")).toEqual(["2026年8月7日"]);
    expect(解("来週月曜")).toEqual(["2026年8月10日"]);
    expect(解("来週の木曜日")).toEqual(["2026年8月13日"]);
    expect(解("再来週水曜")).toEqual(["2026年8月19日"]);
    expect(解("先週金曜"), "先週が解けない").toEqual(["2026年7月31日"]);
    /* 月の語と取り違えない（`来月中` を来曜と読んだら壊れる – 第 327 回の表との境界）。 */
    ["来月中", "今月末", "来週中", "3月中", "年内"].forEach((語) => {
      expect(解(語), `"${語}" を曜日と取り違えた`).toBeNull();
    });
  });

  it("離して打った形・助詞を挟んだ形・繋げた形が同じ行に出会う（品書）", () => {
    [
      ["今週水曜", "今週 水曜", "今週の水曜"],
      ["来週木曜", "来週 木曜日", "来週の木曜日"],
    ].forEach(([繋がった形, 離れた形, 助詞形]) => {
      const 基準の行 = 行集合(繋がった形);
      expect(基準の行.size, `"${繋がった形}" が 0 行の前提が崩れた`).toBeGreaterThan(0);
      [離れた形, 助詞形].forEach((言い方) => {
        const 行 = 行集合(言い方);
        const 差分 =
          [...基準の行].filter((k) => !行.has(k)).length +
          [...行].filter((k) => !基準の行.has(k)).length;
        expect(差分, `"${言い方}" と "${繋がった形}" で違う行が出た`).toBe(0);
      });
    });
  });

  it("解けた日は年を付けた形で出す（素の `8月7日` は他の年の行を拾う）", () => {
    const 語の組 = Recommender.queryTokenGroups("今週金曜", 基準)[0] || [];
    expect(語の組).toContain("2026年8月7日");
    expect(語の組, "年を付けない形を足して他の年まで拾った").not.toContain("8月7日");
  });

  it("`まで` `までに` は今日からその日まで – 過ぎた日はその日だけ", () => {
    const 語の組 = (q: string) => Recommender.queryTokenGroups(q, 基準)[0] || [];
    const 来週月曜まで = 語の組("来週月曜まで");
    expect(来週月曜まで).toContain("2026年8月9日");
    expect(来週月曜まで).toContain("2026年8月10日");
    expect(来週月曜まで, "期日より先まで出した").not.toContain("2026年8月11日");
    /* 日曜に打った `今週金曜までに` の金曜は過ぎている – 逆向きの幅を作らない。 */
    const 今週金曜までに = 語の組("今週金曜までに");
    expect(今週金曜までに).toEqual(expect.arrayContaining(["今週金曜までに", "2026年8月7日"]));
    expect(今週金曜までに, "過ぎた日からの幅を作った").not.toContain("2026年8月8日");
  });

  it("過ぎた日とこれからの日で件数欄の言い方を変える（ラベルは画面から読む）", () => {
    const 画面 = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
    const ラベル = /id="past">\s*<span>([^<]+)</.exec(画面)?.[1] ?? "";
    expect(ラベル, "『過去の締切も表示』のラベルが画面から読めない").not.toBe("");
    const 過ぎた = Recommender.relativeDayNotes("今週金曜", 基準).join("");
    expect(過ぎた).toContain("2026年8月7日(金)");
    expect(過ぎた, "過ぎていることを言っていない").toContain("過ぎています");
    expect(過ぎた, "絞れる欄の場所を言っていない").toContain(ラベル);
    const これから = Recommender.relativeDayNotes("来週金曜", 基準).join("");
    expect(これから).toContain("2026年8月14日(金)");
    expect(これから, "来ていない日に『過ぎています』と書いた").not.toContain("過ぎています");
  });

  it("成果物と注入一覧が解く部品を失っていない（ハーネスは名指し – 第 328 回）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    ["PRESSED_WEEKDAY_JA", "WEEKDAY_ORDER_JA", "function pressedWeekdayJa"].forEach((断片) => {
      expect(rec.includes(断片), `組み立てた画面から ${断片} が消えた`).toBe(true);
    });
    const 一覧 = readFileSync(join(REPO_ROOT, "tests", "built_golden_shared.ts"), "utf8");
    ["pressedWeekdayJa", "PRESSED_WEEKDAY_JA", "WEEKDAY_ORDER_JA"].forEach((名前) => {
      expect(一覧.includes(名前), `検索の入口の一覧に ${名前} の注入が無い`).toBe(true);
    });
  });
});
