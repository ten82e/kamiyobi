/**
 * 週の語に曜日を繋げた形を「曜日」と打った人 – 第 409 回。
 *
 * 実測（2026-10-05 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻
 * 2026-08-09T00:00:00Z）で、「曜」で終わる形は其の日だけで通るのに（`来週金曜` 19 行・
 * `今週金曜` 4 行・`先々週金曜` 2 行）、`日` を足しただけの形は其の規則に見えて居らず、
 * 助詞も読点も無い列挙（第 402 回）に割れて **其の週的全部 + 他の週の其の曜日**まで出て
 * 居た – `来週金曜日` **184 行**（対称差 165 行）・`来週土曜日` **219 行**（同 188 行）・
 * `今週金曜日` **151 行**・`再来週水曜日` **157 行**・`先々週金曜日` **147 行** –
 * 幅の欄には「2026年8月10日または金曜」と、其方では頼んで居ない幅が出て居た。位（頃）を
 * 付けると逆に 0 行だった – `来週火曜頃` 6 行 / `来週火曜日頃` **0 行**。
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

function 対称差(甲: string, 乙: string): number {
  const 甲々 = 列(甲);
  const 乙々 = 列(乙);
  return (
    [...甲々].filter((行) => !乙々.has(行)).length + [...乙々].filter((行) => !甲々.has(行)).length
  );
}

/* 「曜日」と打つ形と、其の方が決まる形（「曜」で終わる形・位を付けた其の方）。 */
const 同じ形: Array<[string, string]> = [
  ["来週金曜日", "来週金曜"],
  ["来週月曜日", "来週月曜"],
  ["今週金曜日", "今週金曜"],
  ["先週金曜日", "先週金曜"],
  ["来週土曜日", "来週土曜"],
  ["来週日曜日", "来週日曜"],
  ["こんしゅう金曜日", "こんしゅう金曜"],
  ["来週火曜日頃", "来週火曜頃"],
  ["今週月曜日頃", "今週月曜頃"],
  ["来週水曜日に", "来週水曜"],
];

describe("週の語に曜日を『曜日』で繋げた形", () => {
  it("其の日だけで当たる（其の週的全部に化けない）", () => {
    for (const [語, 基] of 同じ形) {
      expect(列(基).size, `対照の「${基}」が品書で 0 行`).toBeGreaterThan(0);
      expect(対称差(語, 基), `「${語}」の当たり方が「${基}」と違う`).toBe(0);
    }
  });

  it("其の日が決まる – 週の七日を並べない", () => {
    const 組 = (語: string) => (Recommender.queryTokenGroups(語, 基準) as string[][])[0];
    const 月曜 = "2026年8月10日";
    const 金曜 = "2026年8月14日";
    expect(組("来週金曜日"), "其の日へ解けて居ない").toContain(金曜);
    expect(組("来週金曜日"), "其の週的全部に割れて居る").not.toContain(月曜);
    expect(組("来週月曜日"), "其の日へ解けて居ない").toContain(月曜);
    expect(組("来週月曜日"), "其の週的全部に割れて居る").not.toContain(金曜);
    expect(組("来週火曜日頃"), "位を付けた形が其の日へ解けて居ない").toContain("2026年8月11日");
  });

  it("其方では頼んで居ない幅を件の数欄に書かない", () => {
    const 幅 = (語: string) => Recommender.dayRangePairs(語, 基準) as Array<[string, string]>;
    expect(幅("来週金曜日"), "其の週の初めの日の幅が出て居る").toEqual([]);
    expect(幅("今週月曜日"), "其の週の初めの日の幅が出て居る").toEqual([]);
  });

  it("語を並べた頼み方でも其の日が其侭残る", () => {
    for (const [語, 基] of [
      ["来週金曜日の締切", "来週金曜 締切"],
      ["来週木曜日 締切", "来週木曜 締切"],
    ] as Array<[string, string]>) {
      expect(列(基).size, `対照の「${基}」が品書で 0 行`).toBeGreaterThan(0);
      expect(対称差(語, 基), `「${語}」が語を並べた形で壊れて居る`).toBe(0);
    }
  });
});

describe("守り", () => {
  it("列挙と幅は其侭通る（並べた形を潰さない）", () => {
    const 幅 = (語: string) => Recommender.dayRangePairs(語, 基準) as Array<[string, string]>;
    /* 並べた形は和集合の侭 – 案内も「または」で其の方が出す。 */
    expect(対称差("来週と再来週", "来週") + 対称差("来週と再来週", "再来週")).toBeGreaterThan(0);
    expect(幅("来週火曜と来週水曜").length, "並べた曜日の案内が消えた").toBe(1);
    expect(幅("来週から来週").length, "週の幅の案内が消えた").toBe(1);
    expect(列("明日と明後日").size, "対照の `明日と明後日` が 0 行").toBeGreaterThan(
      列("明日").size,
    );
  });

  it("週の語其物と其れ以外の語は今の当たり方の侭", () => {
    for (const 語 of [
      "来週",
      "今週",
      "来週末",
      "来週中",
      "来週平日",
      "土曜",
      "金曜日",
      "8月上旬",
    ]) {
      expect(列(語).size, `「${語}」が行を出さない`).toBeGreaterThanOrEqual(0);
    }
    expect(対称差("来週金曜", "来週金曜")).toBe(0);
    expect(対称差("来週末日曜", "来週末日曜")).toBe(0);
    expect(対称差("ai/ml", "ai/ml")).toBe(0);
    expect(対称差("人と機械", "人と機械")).toBe(0);
  });
});

describe("成果物", () => {
  it("『曜日』で終わる形を受ける規則は一個所に決まる", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/曜\(\?:日\)\?\|末\|中/g) ?? [], "列挙を割らない側の規則").toHaveLength(1);
    expect(
      物.match(/\[月火水木金土日\]\(\?:曜\(\?:日\)\?\)\?/g) ?? [],
      "位の付いた形を解く側の規則",
    ).toHaveLength(1);
  });
});
