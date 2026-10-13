import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): Array<{ hay: string }> {
  const 目録 = JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8"));
  return Recommender.candidateRows(目録);
}

function 当たり行列表(語: string): string[] {
  const マッチ = Recommender.searchMatcher(語, 基準);
  return 品書()
    .filter((行) => マッチ(行.hay) === true)
    .map((行) => 行.hay);
}

function 対称差(左: string[], 右: string[]): string[] {
  return 左.filter((文) => 右.indexOf(文) < 0).concat(右.filter((文) => 左.indexOf(文) < 0));
}

function 日の案内(語: string): string {
  return Recommender.relativeDayNotes(語, 基準).join(" ");
}

function 月の範囲(語: string): string {
  const 組 = Recommender.periodMonthPairs(語, 基準);
  return 組.length ? String(組[0][1]) : "";
}

describe("過去の月の「末」", () => {
  it("『先月末』『昨月末』は『先月』と同じ行を出す（表に出るのはその月の締切）", () => {
    const 相手 = 当たり行列表("先月");
    expect(相手.length, "品書に 『先月』 の行がない – 比較できない").toBeGreaterThan(0);
    for (const 打ち方 of ["先月末", "昨月末", "先月終わり"]) {
      const 自分 = 当たり行列表(打ち方);
      expect(自分.length, `\`${打ち方}\` が 0 行の侭`).toBeGreaterThan(0);
      expect(対称差(自分, 相手), `\`${打ち方}\` が \`先月\` と違う行を出している`).toEqual([]);
    }
  });

  it("月のまとまりの案内はその月の末日を書く – 過去の月でも今月の日を返さない", () => {
    expect(月の範囲("先月末")).toContain("2026年7月");
    expect(月の範囲("昨月末")).toContain("2026年7月31日");
    expect(月の範囲("先々月末")).toContain("2026年6月30日");
    /* 今月・来月が今まで通りである事（前の月を足した事で動いていない）。 */
    expect(月の範囲("今月末")).toContain("2026年8月31日");
    expect(月の範囲("来月末")).toContain("2026年9月30日");
  });

  it("『先月末まで』の範囲もその月の末日までと書く（幅を推測しない）", () => {
    expect(月の範囲("先月末まで")).toContain("2026年7月31日");
  });
});

describe("週を繋げた曜日の形の前側", () => {
  it("『昨週金曜』は『先週金曜』と同じ日・同じ行を出す", () => {
    expect(日の案内("昨週金曜")).toContain(
      (日の案内("先週金曜").split(" = ")[1] || "").split("の")[0],
    );
    const 相手 = 当たり行列表("先週金曜");
    expect(相手.length, "品書に `先週金曜` の行がない – 比較できない").toBeGreaterThan(0);
    expect(対称差(当たり行列表("昨週金曜"), 相手)).toEqual([]);
  });

  it("『先々週金曜』もその方の週その曜日の 1 日に解ける", () => {
    expect(日の案内("先々週金曜"), "`先々週金曜` が日にちに解けない").toContain("2026年7月24日");
    expect(日の案内("先々週月曜")).toContain("2026年7月20日");
    /* 過ぎた日なので、その方の日が出る欄の名前を添える。 */
    expect(日の案内("先々週金曜")).toContain("過去の締切も表示");
  });

  it("『先々週末』はその週の土曜・日曜の二日に解け、別の週の週末を混ぜない", () => {
    const 案内 = 日の案内("先々週末");
    expect(案内).toContain("2026年7月25日");
    expect(案内).toContain("2026年7月26日");
    /* 裸の `週末` は別の週も含むので、週を名指した形と同じにしてはならない。 */
    expect(対称差(当たり行列表("先々週末"), 当たり行列表("週末")).length).toBeGreaterThan(0);
    expect(当たり行列表("先週末").length, "品書に `先週末` の行がない").toBeGreaterThan(0);
  });
});

describe("成果物", () => {
  it("過去の語が実測どおりの形で成果物に入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const [条目, 数] of [
      ["先月末: ", 1],
      ["昨月末: ", 1],
      ["先々月末: ", 1],

      ["|先々週|せんせんしゅう|", 3],
      ["|昨週|さくしゅう)", 1],
    ] as Array<[string, number]>) {
      expect(rec.split(条目).length - 1, `成果物の中の語の数: ${条目.slice(0, 12)}`).toBe(数);
    }
  });
});
