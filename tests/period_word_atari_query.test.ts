/**
 * 「月末あたり」を打つ人だけ黙つて居た – 寄せの規則が『頃』だけ受けて居た（第 433 回）。
 *
 * 実測（2026-10-24 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `月末` 189 行・`中旬頃` 74 行・`週末` 268 行・`年度末` 80 行が通るのに、同じ語に別の
 * 位を続けただけの `月末あたり` `中旬あたり` `上旬あたり` `週末あたり` `今月末あたり`
 * `年度末あたり` は **0 行で案内も無し**。頃の言い方の規則が語の列挙を『頃』1字でのみ
 * 続けて居た為。仮名の『ころ』『ごろ』『辺り』『あたり』も同じ音・同じ頼み方。
 *
 * 直し –
 * - 頃の言い方の尾に『ころ』『ごろ』『辺り』『あたり』を通す（裸の日で通した語群と同じ –
 *   『前後』『位』『ぐらい』『くらい』は其の幅か其它か区別がつかないので寄せない侭）
 * - 語の列挙に `年度末` `年度初め` `年度始め` を足す（其の方の表が在るので尾を続けるだけ）
 * - periodMonthPairs も寄せた形を見る（行は寄せた形で出るのに案内だけ裸の語に付くと、
 *   寄せた事が利用者に伝わらない）
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

function 対称差(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (!b.has(x)) n += 1;
  for (const x of b) if (!a.has(x)) n += 1;
  return n;
}

describe("時期語+位は其の方の語と同列（第 433 回）", () => {
  const 対: Array<[string, string]> = [
    ["月末あたり", "月末"],
    ["月末ごろ", "月末"],
    ["中旬あたり", "中旬"],
    ["上旬あたり", "上旬"],
    ["週末あたり", "週末"],
    ["今月末あたり", "今月末"],
    ["来月末あたり", "来月末"],
    ["来月末辺り", "来月末"],
    ["年度末あたり", "年度末"],
    ["年度初め頃", "年度初め"],
    ["来週末あたり", "来週末"],
  ];
  for (const [語, 親] of 対) {
    it(`『${語}』は『${親}』と同列で空ではない`, () => {
      const A = 列(語);
      const B = 列(親);
      expect(B.size, 親).toBeGreaterThan(0);
      expect(対称差(A, B), 語).toBe(0);
    });
  }
});

describe("案内が実物に付く（第 433 回）", () => {
  it("月末あたりは月末の案内を出す – 行 189 行で案内無しは嘘の侪", () => {
    const P = Recommender.periodMonthPairs("月末あたり", 基準);
    expect(P.length).toBe(1);
    expect(String(P[0][1])).toContain("末日は");
    const Q = Recommender.periodMonthPairs("年度末あたり", 基準);
    expect(Q.length).toBe(1);
    expect(String(Q[0][0])).toBe("年度末");
  });
  it("親の案内は其侭", () => {
    expect(Recommender.periodMonthPairs("月末", 基準).length).toBe(1);
    expect(Recommender.periodMonthPairs("来月末", 基準).length).toBe(1);
  });
});

describe("寄せない語は其侭黙る（第 433 回）", () => {
  it("位でも幅の決まらない語は寄せない – 締切の推測をしない", () => {
    expect(列("来週あたり").size).toBe(0);
    expect(列("3日前後").size).toBe(0);
    expect(Recommender.periodMonthPairs("来週あたり", 基準).length).toBe(0);
    expect(Recommender.relativeDayNotes("3日前後", 基準).join("")).toBe("");
    expect(列("8月頃").size).toBe(0);
  });
  it("其它は其侭", () => {
    expect(列("aiとml").size).toBe(17);
    expect(列("月 曜").size).toBe(436);
    expect(列("3日あたり").size).toBe(列("3日").size);
  });
});

describe("割りの形がビルド成果物に残る（第 433 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("尾の語群と年度語と案内の寄せが入つて居る", () => {
    for (const 形 of [
      "(?:頃|ころ|ごろ|辺り|あたり)/g",
      "月初|月末|週末|年度初め|年度始め|年度末",
      "searchNormalize(collapseRelativeDayPhrase(part))",
    ]) {
      expect(物.split(形).length - 1, 形.slice(0, 18)).toBe(1);
    }
  });
});
