/**
 * 時刻にタイムゾーンを繋げて打つ形 – 第 412 回。
 *
 * 実測（2026-10-08 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻
 * 2026-08-09T00:00:00Z）: 空隔を打つた形は通るのに、繋げて打つ形はコロンで割れて
 * `23` + `59jst` のやうに壊れた語で探して居た – `23:59` 507 行・`23:59 JST` 507 行が通るのに
 * `23:59JST` **0 行**・`17:00JST` **0 行**・`09:00JST` **0 行**・`20:59JST` **0 行**・
 * `23:59日本標準時` **0 行**・`23:59AoE` **0 行**・`23:59JST締切` **0 行**、ゾーン語だけで
 * 始まる `AoE締切` **0 行**（`AoE 締切` 364 行）。括弧で括つた形は **516 行**に化けて居た –
 * `23` が 2023 年・`59` が 2059 年に寄って、其の方の時刻を書かない行が 9 行混つて居た。
 *
 * 下の検査は検査用ビルドの品書（435 行）で見る – 其の方の語の対照が其処でも 0 行に
 * 成らない事を先に確かめてから、当たり方の一致を張つて居る。
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

function 対称差(甲の語: string, 乙の語: string): number {
  const 甲 = 列(甲の語);
  const 乙 = 列(乙の語);
  return [...甲].filter((行) => !乙.has(行)).length + [...乙].filter((行) => !甲.has(行)).length;
}

function 語組(語: string): string[][] {
  return Recommender.queryTokenGroups(語, 基準) as unknown as string[][];
}

describe("時刻にゾーンを繋げて打つ形", () => {
  it("空隔を打つた形と同じ列表になる", () => {
    for (const [語, 基] of [
      ["23:59JST", "23:59 JST"],
      ["20:59JST", "20:59 JST"],
      ["12:00JST", "12:00 JST"],
      ["23:59日本時間", "23:59 日本時間"],
      ["23:59日本標準時", "23:59 日本標準時"],
      ["23:59AoE", "23:59 AoE"],
      ["23:59JST締切", "23:59 JST 締切"],
      ["23:59 JST締切", "23:59 JST 締切"],
      ["AoE締切", "AoE 締切"],
    ] as Array<[string, string]>) {
      expect(列(基).size, `対照の「${基}」が品書で 0 行`).toBeGreaterThan(0);
      expect(対称差(語, 基), `「${語}」の当たり方が「${基}」と違う`).toBe(0);
    }
  });

  it("全角のコロン・括弧で括つた形も同じ列表になる", () => {
    expect(対称差("23：59JST", "23:59JST")).toBe(0);
    expect(対称差("23:59（JST）", "23:59 JST")).toBe(0);
    expect(対称差("23:59(日本時間)", "23:59 日本時間")).toBe(0);
  });

  it("其の方の時刻を書かない行を混ぜない（化けて居た形の検査）", () => {
    const 時刻 = 列("23:59");
    expect(時刻.size, "品書に `23:59` の行が在らない").toBeGreaterThan(0);
    for (const 語 of ["23:59JST", "23:59（JST）", "23:59(日本時間)", "23:59日本時間"]) {
      const 混入 = [...列(語)].filter((行) => !時刻.has(行));
      expect(混入, `「${語}」が其の方の時刻を書かない行を混ぜて居る`).toHaveLength(0);
    }
  });

  it("壊れた語で探さない（時刻の語とゾーンの語に分かれる）", () => {
    expect(語組("09:00JST")).toEqual([["09:00"], ["jst"]]);
    expect(語組("23:59JST")).toEqual([["23:59"], ["jst"]]);
    /* 割つた片方が数の語に化けると、年や件の数に化ける（`23` → 2023 年）。 */
    for (const 語 of ["23:59JST", "23:59（JST）", "23:59AoE"]) {
      const 語々 = 語組(語).flat();
      expect(語々, `「${語}」が裸の数を含む`).not.toContain("23");
      expect(語々, `「${語}」が裸の数を含む`).not.toContain("59");
    }
  });
});

describe("守り", () => {
  it("ゾーン語その物と時刻その物の当たり方は変わらん", () => {
    expect(列("JST").size, "品書に `JST` の行が在らない").toBeGreaterThan(0);
    expect(対称差("jst", "JST")).toBe(0);
    expect(対称差("23:59", "23：59")).toBe(0);
    expect(対称差("23:59 AoE", "23:59aoe")).toBe(0);
  });

  it("締切欄を其のまま写した形（曜日の括弧付き）は曜日を別の語に割らん", () => {
    expect(列("20:59 JST(水)").size, "締切欄の形が 0 行に成つた").toBeGreaterThan(0);
    expect(対称差("20:59JST(水)", "20:59 JST(水)")).toBe(0);
    /* 末尾の `)` は語の端の記号として落ちる（其の方の形も同じ – 下の一致が其れ）。 */
    expect(語組("20:59JST(水)")).toEqual([["20:59"], ["jst(水"]]);
  });

  it("語の割り方が他の打ち方を壊して居ない", () => {
    /* 時刻の語にゾーン語以外の物を続ける形（`9:00-17:00`）は第 445 回から**幅**として
     * 受ける – コロンで割つて `9:00` と `17:00` の交わりにすると、其の両方を書く行だけ
     * になる化け方（実測 11 行）が其の侭残つて居た。時の打ち方の幅と同じ物になる事。 */
    expect(対称差("9:00-17:00", "9時から17時")).toBe(0);
    expect(列("9:00-17:00").size).toBeGreaterThan(0);
    expect(列("8月10日から8月22日").size, "日の幅が壊れた").toBeGreaterThan(0);
    expect(列("上旬と下旬").size, "旬を並べた語が壊れた").toBeGreaterThan(0);
    expect(対称差("8月上旬と下旬", "上旬と下旬")).toBe(0);
    /* 日の語は月の語より狹い（割つて広くなる化け方を防ぐ）。 */
    expect(列("2026年8月10日").size).toBeLessThan(列("8月").size);
  });
});

describe("成果物", () => {
  it("ゾーンの語の表と剥がす枝は一個所に決まる", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(
      物.match(/時刻の後ろのゾーン語並びJa\.find\(/g) ?? [],
      "ゾーン語を剥がす枝",
    ).toHaveLength(1);
    expect(
      物.match(/const 時刻の後ろのゾーン語Ja = new Set\(\[\s*"jst",\s*"utc",\s*"gmt",\s*"aoe",/g) ??
        [],
      "ゾーンの語の表",
    ).toHaveLength(1);
    expect(物.match(/const ゾーン語を剥がすJa = /g) ?? [], "剥がす枝").toHaveLength(1);
    expect(物.match(/function ゾーン語を剥がすJa/g) ?? [], "別に作った剥がし").toHaveLength(0);
  });
});
