/**
 * 催し物の開き方を指す機能語（`開催` `実施`）を、他の語があるときにのぞく（第 705 回）。
 *
 * 實測（2026-10-06 – 收錄の全體 5,069 行・速く開く品書 870 行・固定時刻 2026-10-06T00:00:00Z。
 * 検査が使ふ固定入力 – 品書 3,250 行・2026-08-09T00:00:00Z でも同じ）で、`海外で開催`
 * `東京で開催` `パリで開催` `オンラインで開催` は**0 行**だつたのに、同じ意味の繋げた形
 *（`海外開催` `東京開催` `パリ開催`）は行が出て居た（3,953 / 41 / 17 行）。日本語は語の間に
 * 空格を入れないので、`で` の一枚で語が割れ、`開催` が**別の語として AND に加はる**爲だつた
 *（`開催` 其の物は 152 行を持つ – 「國內開催」の樣な行なので、全行の語には出來ない）。
 *
 * 直し – 他の語が在る時に限り、**機能語だけの組**をのぞく（全行の語をのぞく第 245 回と同じ筋）。
 * 打つ人は「何處で開かれるか」を聞いて居るので、開き方を要求して 0 行に落とさない。
 *
 * 突合（群の語 × 語尾の網羅 20,223 本）– **行 増 7・減 0**（増は此の回に直した形その物、
 * 減は 0 – 默つて狹まる語は無い）・案内の變化 0。內譯は SPEC.md 第 705 回。
 */

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

function 全體(): string[] {
  return (
    Recommender.candidateRows(
      JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8")),
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
}

function 行列表(語: string, 行々: string[] = 品書()): string[] {
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(語, 基準), 基準);
  return 行々.filter((行) => 照合(行) === true).sort();
}

const 件 = (語: string, 行々?: string[]): number => 行列表(語, 行々).length;

/** 直した形と、同じ意味の繋げた形（行の集合が同じに成る筈）。 */
const 對 = [
  ["海外で開催", "海外開催"],
  ["東京で開催", "東京開催"],
  ["パリで開催", "パリ開催"],
  ["オンラインで開催", "オンライン開催"],
] as const;

describe("開き方を指す機能語を、他の語があるときにのぞく（第 705 回）", () => {
  it("品書と收錄の全體の兩方で、繋げた形と同じ行に屆く", () => {
    const 全 = 全體();
    for (const [打ち方, 繋げた形] of 對) {
      const 正 = 行列表(繋げた形);
      expect(正.length, `繋げた形に行が無い（此の檢査の前提）: ${繋げた形}`).toBeGreaterThan(0);
      expect(行列表(打ち方), `品書で別の行: ${打ち方}`).toEqual(正);
      const 全正 = 行列表(繋げた形, 全);
      expect(全正.length, `收錄の全體で繋げた形に行が無い: ${繋げた形}`).toBeGreaterThan(0);
      expect(行列表(打ち方, 全), `收錄の全體で別の行: ${打ち方}`).toEqual(全正);
    }
  });

  it("默つて狹まる語は無い（直す前に行が出て居た形は、行が減らない）", () => {
    /* 此の回の直しは**のぞく**だけなので、行が減る形は一つも無い筈（實測でも減 0）。
     * 減つて居たら、のぞいた事が別の語の當たりを壞して居る。 */
    for (const [打ち方, 前の行數] of [
      ["国内で開催", 22],
      ["研究会で開催", 2],
    ] as Array<[string, number]>) {
      expect(件(打ち方), `行が減つた: ${打ち方}`).toBeGreaterThanOrEqual(前の行數);
      expect(件(打ち方), `繋げた形と同じに成つて居ない: ${打ち方}`).toBe(
        件(打ち方.replace("で開催", "開催")),
      );
    }
  });

  it("機能語だけを打つた人は、今まで通り行が出る（のぞくのは他の語がある時だけ）", () => {
    for (const 語 of ["開催", "実施"]) {
      const 群 = Recommender.queryTokenGroups(語, 基準);
      expect(群.length, `一語なのに組が分かれた: ${語}`).toBe(1);
    }
    expect(件("開催"), "`開催` の行が消えた").toBeGreaterThan(0);
    /* `実施` は收錄に行を持たない（此の回の直しの前から）– 默るのは今まで通り。 */
    expect(件("実施"), "`実施` に行が出た（前提が變はつた）").toBe(0);
  });

  it("機能語をのぞいた事で、別の語の組が消えて居ない（のぞくのは其の組だけ）", () => {
    /* `セキュリティで開催` は `セキュリティ` と同じ行に屆く（のぞく前は 0 行だつた）。 */
    const 正 = 行列表("セキュリティ");
    expect(正.length, "此の檢査の前提が崩れた").toBeGreaterThan(0);
    expect(行列表("セキュリティで開催"), "分野の語が消えた").toEqual(正);
  });
});
