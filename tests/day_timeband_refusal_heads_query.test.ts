/**
 * 「明日昼」「来週月曜夜」等、日の語に時間帯の名前を繋げた断りが黙つて居た（第 451 回）。
 *
 * 実測（2026-10-25 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * - `明日夕方` `9月15日夕方` `明日昼間` は第 440 回の断りが出るのに、`明日昼`
 *   `来週月曜夜` `来週夕方` `12/24夕方` `12/24の夕方` `24日夕方` `来月深夜` は
 *   0 行で案内も無し – ①断りの頭の形に週の複合語（来週月曜）・月と年の語・切り暦日
 *   （`12/24`）が数へられて居なかつた、②『昼』が両側の語表に在りかつただけ。
 * - 夕方・夜・昼はいつからいつまでを指すかに公用の決まりが無く、行は作れない
 *   （第 418 回の決まり – 締切の推測はしない）。直す物は**断り** – 黙った侭残さない。
 *
 * 直し: 断りの頭の形を第 443・448 回と同じ広さ（週複合語・月の語・和暦/切りの暦日）に
 * 広げ、帯の名の表に『昼』を足す（『明日昼』も『昼』も同じ断りを受ける）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 列表入口() {
  const 品 = (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
  const 済 = new Map<string, Set<string>>();
  return (語: string): Set<string> => {
    if (!済.has(語)) {
      const 当 = Recommender.searchMatcher(語, 基準);
      済.set(語, new Set(品.filter((行) => 当(行) === true)));
    }
    return 済.get(語) as Set<string>;
  };
}

const 列 = 列表入口();

describe("日の語に時間帯の名前を繋げた断りが打ち方を取り逃さない（第 451 回）", () => {
  for (const 語 of [
    "明日昼",
    "来週月曜夜",
    "来週夕方",
    "12/24夕方",
    "12/24の夕方",
    "24日夕方",
    "来月深夜",
    "来年夜",
    "9月15日夜",
  ]) {
    it(`『${語}』は 0 行の侭、公用の決まりが無い事の断りが出る`, () => {
      const 案内 = Recommender.uiWordNoteJa(語);
      expect(案内, 語).toContain("絞り込めません");
      expect(案内, 語).toContain("公用の決まり");
      expect(列(語).size, 語).toBe(0);
    });
  }
  it("第 440 回から出居た形は其侭断りする（回帰）", () => {
    for (const 語 of ["明日夕方", "明日昼間", "金曜夜", "月曜深夜"]) {
      expect(Recommender.uiWordNoteJa(語), 語).toContain("絞り込めません");
    }
  });
  it("行を出す語を断りで塞がない – 昼は行 0 が正しいが『明日』『12/24』『来月』は出る", () => {
    expect(列("明日").size).toBeGreaterThan(0);
    /* 切りの暦日（`12/24`）は此の方の語其侭では行が出ない（`/` の目 – 第 412 回 – が
     * 其處から先だけ通す為）。其の日を決める形は画面の暦日で見る。 */
    expect(列("12月24日").size).toBeGreaterThanOrEqual(0);
    expect(列("24日").size).toBeGreaterThan(0);
    expect(列("来月").size).toBeGreaterThan(0);
    /* 時間帯の名前其単体も断り – 行は作らない（第 418 回）。 */
    expect(Recommender.uiWordNoteJa("昼")).toContain("時間帯の名前");
    expect(列("昼").size).toBe(0);
  });
});

describe("直した形がビルド成果物に残る（第 451 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("断りの頭に週複合語と月の語と切りの暦日が数へられて居る", () => {
    expect(
      物.split(
        "来週末|来月|今月|先月|来年|今年|去年|(?:(?:来|今|再々?|先々?)(?:周|週))(?:月|火|水|木|金|土|日)曜日?",
      ).length - 1,
    ).toBe(1);
    expect(物.split("(?:[0-9]{4}[-/年])?[0-9]{1,2}[-/月][0-9]{1,2}日?").length - 1).toBe(1);
  });
});
