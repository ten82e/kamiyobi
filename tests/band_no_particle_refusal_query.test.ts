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

describe("日の語と時間帯の間の『の』を取り逃さない（第 452 回）", () => {
  for (const 語 of ["明日の夜", "明日の朝", "来週月曜の夜", "24日の夜", "来月の夜", "明日の昼"]) {
    it(`『${語}』は 0 行の侭、公用の決まりが無い事の断りが出る`, () => {
      const 案内 = Recommender.uiWordNoteJa(語);
      expect(案内, 語).toContain("絞り込めません");
      expect(案内, 語).toContain("公用の決まり");
      expect(列(語).size, 語).toBe(0);
    });
  }
  it("既に受かつていた形は其侭（回帰 – 第 440・451 回）", () => {
    for (const 語 of ["明日夕方", "12/24の夕方", "明日昼"]) {
      expect(Recommender.uiWordNoteJa(語), 語).toContain("絞り込めません");
    }
  });
  it("それより前の打ち方と取り違へない – 『明日の17時までに』は元の案内の侭", () => {
    expect(Recommender.uiWordNoteJa("明日の17時までに")).not.toContain("公用の決まり");
  });
});

describe("直した形がビルド成果物に残る（第 452 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("帯の語の『の』の枝が一箇所", () => {
    expect(物.split("(?:(?:お昼|昼|夕方|ゆうがた|朝|深夜|夜)の)?").length - 1).toBe(1);
  });
});
