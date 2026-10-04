/**
 * 週の語に平日・土日・週末を繋げた形 – 第 410 回。
 *
 * 実測（2026-10-06 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻
 * 2026-08-09T00:00:00Z）で、裸の語は通るのに週を名指した形が黙つて居た –
 * `平日` 604 行 / `来週平日` **0 行**・`今週平日` **0 行**・`先週平日` **0 行**・
 * `再来週平日` **0 行**、`来週末` 40 行 / `来週週末` **0 行**・`今週末` 5 行 /
 * `今週週末` **0 行**・`先週末` 16 行 / `先週週末` **0 行**。`土日` は逆に 1 曜日として
 * 読まれて日曜が落ちて居た – `来週土日` **31 行**（其の週の土曜だけ / `来週末` 40 行）。
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
  const 列 = (語: string): Set<string> => {
    if (!済.has(語)) {
      const 当 = Recommender.searchMatcher(語, 基準);
      済.set(語, new Set(品.filter((行) => 当(行) === true)));
    }
    return 済.get(語) as Set<string>;
  };
  列.和 = (...語々: string[]): Set<string> => {
    語々.forEach(列);
    return new Set(語々.flatMap((語) => [...列(語)]));
  };
  return 列;
}

const 列 = 列表入口();

function 対称差甲乙(甲: Set<string>, 乙: Set<string>): number {
  return [...甲].filter((行) => !乙.has(行)).length + [...乙].filter((行) => !甲.has(行)).length;
}

function 対称差(甲の語: string, 乙の語: string): number {
  return 対称差甲乙(列(甲の語), 列(乙の語));
}

/* 固定時刻 2026-08-09（日曜）からの暦の週 – 週は月〜日の塊。 */
const 今週の平日 = ["2026年8月3日", "2026年8月4日", "2026年8月5日", "2026年8月6日", "2026年8月7日"];
const 来週の平日 = [
  "2026年8月10日",
  "2026年8月11日",
  "2026年8月12日",
  "2026年8月13日",
  "2026年8月14日",
];

describe("週の語に平日を繋げた形", () => {
  it("其の週の月〜金の行だけを出す（其の週的全部でも 0 行でもない）", () => {
    for (const [語, 五日] of [
      ["来週平日", 来週の平日],
      ["今週平日", 今週の平日],
    ] as Array<[string, string[]]>) {
      const 其の方 = 列.和(...五日);
      expect(其の方.size, `品書で其の週の平日 5 日が 0 行`).toBeGreaterThan(0);
      expect(対称差甲乙(列(語), 其の方), `「${語}」の当たり方が其の週の月〜金と違う`).toBe(0);
    }
  });

  it("助詞と締切を繋げても其の日が其侭残る", () => {
    expect(対称差("来週平日に", "来週平日")).toBe(0);
    expect(対称差("来週平日の締切", "来週平日 締切")).toBe(0);
    expect(列("来週平日 締切").size, "対照の `来週平日 締切` が 0 行").toBeGreaterThan(0);
  });

  it("其の週の一曜日より廣く、其の週全部より狹い", () => {
    expect(列("来週平日").size).toBeGreaterThan(列("来週月曜").size);
    expect(列("来週").size).toBeGreaterThan(列("来週平日").size);
    /* 混入の検査 – 其の週全部が混ざつて居ない事（土曜・日曜を出さない）。 */
    const 五日 = new Set(来週の平日.flatMap((日) => [...列(日)]));
    const 土曜 = new Set(列("2026年8月15日"));
    expect(
      [...列("来週平日")].filter((行) => !五日.has(行)),
      "其の週平日以外の行が混ざつて居る",
    ).toHaveLength(0);
    expect([...列("来週平日")].filter((行) => 土曜.has(行) && !五日.has(行))).toHaveLength(0);
  });
});

describe("週の語に土日・週末を繋げた形", () => {
  it("其の週の土曜と日曜の両方を出す（日曜が落ちない）", () => {
    for (const [語, 基] of [
      ["来週週末", "来週末"],
      ["今週週末", "今週末"],
      ["来週土日", "来週末"],
      ["今週土日", "今週末"],
    ] as Array<[string, string]>) {
      expect(列(基).size, `対照の「${基}」が品書で 0 行`).toBeGreaterThan(0);
      expect(対称差(語, 基), `「${語}」の当たり方が「${基}」と違う`).toBe(0);
    }
  });

  it("其の週の日曜だけの行にも届く", () => {
    const 日曜 = 列("2026年8月16日");
    expect(日曜.size, "品書に其の週の日曜の行が在らない").toBeGreaterThan(0);
    expect(
      [...日曜].filter((行) => !列("来週土日").has(行)),
      "其の週の日曜の行が `来週土日` から落ちして居る",
    ).toHaveLength(0);
  });
});

describe("並べた形と件の数欄", () => {
  it("並べた週のまとまりは和集合で、案内は「または」で出る", () => {
    const 幅 = Recommender.dayRangePairs("来週平日と来週土日", 基準) as Array<[string, string]>;
    expect(幅, "並べた形の案内が消えて居る").toHaveLength(1);
    expect(幅[0][1], "案内が和集合の書き方になつて居ない").toContain("または");
    /* 其の週の平日 + 其の週の週末 = 其の週全部（和集合が其のまま七日分になる – 減つて居ない事）。 */
    expect(対称差("来週平日と来週土日", "来週")).toBe(0);
  });

  it("其の日を決めない語の欄は黙る（其方では頼んで居ない幅を書かない）", () => {
    const 幅 = (語: string) => Recommender.dayRangePairs(語, 基準) as Array<[string, string]>;
    expect(幅("来週平日"), "其の週平日の幅が出て居る").toEqual([]);
    expect(幅("来週末"), "其の週末の幅が出て居る").toEqual([]);
  });
});

describe("守り", () => {
  it("週の語・曜日の語・裸のまとまりの語は今の当たり方の侭", () => {
    for (const 語 of [
      "来週",
      "今週",
      "来週末",
      "来週中",
      "来週金曜",
      "平日",
      "土日",
      "週末",
      "来週平日",
    ]) {
      expect(列(語).size, `「${語}」が今より減つてはならない`).toBeGreaterThan(0);
    }
    /* 其の週 ⊃ 其の週の週末 ⊃ 其の週の日曜 – 包含が崩れて居ない。 */
    expect([...列("来週末")].filter((行) => !列("来週").has(行))).toHaveLength(0);
    expect(列("来週と再来週").size).toBeGreaterThan(列("来週").size);
    /* 前の回まで通つた言い方が其侭通る（対照との対称差 0）。 */
    expect(対称差("来週金曜日", "来週金曜")).toBe(0);
    expect(対称差("8月10日に", "8月10日")).toBe(0);
    expect(対称差("来週 金曜日", "来週金曜")).toBe(0);
    expect(列("8月上旬と下旬").size).toBeGreaterThan(0);
  });

  it("其の週に其の日が在る形だけを解く（在らない日を足さない）", () => {
    const 組 = (語: string) => (Recommender.queryTokenGroups(語, 基準) as string[][])[0];
    expect(組("来週平日")).toContain("2026年8月10日");
    expect(組("来週平日")).toContain("2026年8月14日");
    expect(組("来週土日")).toEqual(expect.arrayContaining(["2026年8月15日", "2026年8月16日"]));
    expect(組("来週平日")).not.toContain("2026年8月15日");
  });
});

describe("成果物", () => {
  it("週のまとまりの語を受ける枝は一個所に決まる", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(
      物.match(/\(\?:土日\|週末\|平日\|\(\[月火水木金土日\]\)/g) ?? [],
      "押した週のまとまりの規則",
    ).toHaveLength(1);
    expect(物.match(/\/平日\$\/\.test\(/g) ?? [], "平日を五日に解く枝").toHaveLength(1);
    expect(
      物.match(/\|末\|中\|土日\|週末\|平日\)\?\$\/\.test\(/g) ?? [],
      "列挙を割らない側の規則",
    ).toHaveLength(1);
  });
});
