/**
 * 「来週あたり」「17時頃」「明日夕方」の三群だけ黙つて空だった – 幅・時刻・日の語の近似系列（第 440 回）。
 *
 * 実測（2026-10-24 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * - `明日あたり` 4 行・`8月20日ごろ` 13 行が通るのに `来週あたり` `再来週あたり`
 *   `再来週頃` `来月あたり` `来年あたり` は 0 行で案内も無し（幅の語は其の日を決めぬ）。
 * - `17時台` 12 行が通るのに `17時頃` `17時前後` `17時30分頃` `正午頃` `午後5時頃`
 *   `十七時ごろ` は 0 行で案内も無し。
 * - `明日` 4 行・`深夜` 0 行（断り有）が通るのに `明日夕方` `金曜夜` `月曜深夜`
 *   `明日の夕方` は 0 行で案内も無し。
 *
 * 直し – 三つの断り（行は作らない – 締切の推測をしない）:
 * - 幅の語（週・月・年）+ 近似の語 → 幅の語だけで打つ案内
 * - 時刻 + 近似の語 → 「17時台」「17時以降」への案内
 * - 日の語 + 時間帯の名前（の・に込み）→ 時間帯の名前 – 第 418 回 – に倣う案内
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

describe("幅の語に近似を付けても断りが届く（第 440 回）", () => {
  for (const 語 of [
    "来週あたり",
    "再来週あたり",
    "再来週頃",
    "来月あたり",
    "来年あたり",
    "今週ごろ",
  ]) {
    it(`『${語}』は 0 行の侭、幅の語だけで打つ案内`, () => {
      expect(列(語).size, 語).toBe(0);
      const n = Recommender.uiWordNoteJa(語);
      expect(n, 語).toContain(`「${語}」`);
      expect(n, 語).toContain("では絞れません");
    });
  }
  it("其の日が決まる位付きは其の侭解ける – 断りが吞まない", () => {
    expect(列("明日あたり").size).toBe(列("明日").size);
    const n = Recommender.uiWordNoteJa("明日あたり");
    expect(n).not.toContain("幅の語");
    expect(Recommender.relativeDayNotes("明日あたり", 基準).join("")).toContain("は幅にせず");
    for (const 語 of ["来週火曜頃", "来週中頃", "来週いっぱい", "来週末"]) {
      expect(Recommender.uiWordNoteJa(語), 語).not.toContain("幅の語に頃・前後のやうな近似の語");
    }
    expect(列("来週").size).toBeGreaterThan(0);
  });
});

describe("時刻に近似を付けても断りが届く（第 440 回）", () => {
  for (const 語 of [
    "17時頃",
    "17時前後",
    "17時30分頃",
    "正午頃",
    "午後5時頃",
    "十七時ごろ",
    "17時位",
  ]) {
    it(`『${語}』は 0 行の侭、時刻の公用の形への案内`, () => {
      expect(列(語).size, 語).toBe(0);
      const n = Recommender.uiWordNoteJa(語);
      expect(n, 語).toContain(`「${語}」`);
      expect(n, 語).toContain("17時台");
    });
  }
  it("公用の時刻の形は其の侭解ける", () => {
    expect(Recommender.uiWordNoteJa("17時台")).toBe("");
    const 解 = Recommender.relativeDayNotes("17時以降", 基準).join(" ");
    expect(解).toContain("17:00〜23:59");
    expect(Recommender.uiWordNoteJa("正午")).toBe("");
  });
  it("『一時』の断りは其の侭（第 420 回）", () => {
    expect(Recommender.uiWordNoteJa("一時")).toContain("しばらく");
  });
});

describe("日の語に時間帯の名前を繋いでも断りが届く（第 440 回）", () => {
  for (const 語 of ["明日夕方", "金曜夜", "月曜深夜", "明日の夕方", "来週末深夜", "8月20日未明"]) {
    it(`『${語}』は 0 行の侭、時間帯の名前の断り（第 418 回）が届く`, () => {
      expect(列(語).size, 語).toBe(0);
      const n = Recommender.uiWordNoteJa(語);
      expect(n, 語).toContain(`「${語}」`);
      expect(n, 語).toContain("時間帯の名前");
    });
  }
  it("日の語だけ・時間帯の名前だけは其の侭", () => {
    expect(列("明日").size).toBeGreaterThan(0);
    expect(Recommender.uiWordNoteJa("明日")).not.toContain("時間帯の名前");
    const n = Recommender.uiWordNoteJa("夕方");
    expect(n).toContain("時間帯の名前で打たれても");
  });
});

describe("断りの形がビルド成果物に残る（第 440 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("三つの式が入つて居る", () => {
    for (const 形 of ["幅の語の近似Ja", "時刻の近似Ja", "日の時間帯のかたちJa"]) {
      expect(物.split(形).length - 1, 形).toBeGreaterThanOrEqual(1);
    }
    for (const 文断片 of [
      "来週|らいしゅう|翌週|再来週|再々週|来々週|先週",
      "17時以降」のように打ってください",
    ]) {
      expect(物.split(文断片).length - 1, 文断片.slice(0, 16)).toBeGreaterThanOrEqual(1);
    }
  });
});
