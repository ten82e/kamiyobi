/**
 * 月語に日を繋げた形（`来月10日` `今月15日` `再来月5日`）と、其に期日を繋げた形（第 400 回）。
 *
 * 実測（2026-09-28 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻
 * 2026-08-09T00:00:00Z）: `来月` 240 行・`来週月曜` 4 行・`9月10日` 20 行が通るのに、
 * `来月10日` **0 行**・`来月10日までに` **0 行**・`今月15日` **0 行**・`再来月5日` **0 行**・
 * `先月20日` **0 行**で案内も立たなかつた。週+曜日を繋げた形は第 329 回から解けるのに、
 * 月+日の形は空いて居た – 申請の締切を「来月10日」と書く人は多い。
 * 其れに伴ひ、並べた形（`来月10日と来月20日`）は片側だけ解けて AND に割れ、和集合の
 * 33 行の処を **1 行だけ出す**誤つた当たり方になつたので、其の方も同時に塞いだ。
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

function 対称差(甲: Set<string>, 乙: Set<string>): number {
  return [...甲].filter((行) => !乙.has(行)).length + [...乙].filter((行) => !甲.has(行)).length;
}

/** 両端を単体で打った形の和集合（月を跨いでも動く）。 */
function 日の幅和(
  頭: readonly [number, number, number],
  尾: readonly [number, number, number],
): Set<string> {
  const 和 = new Set<string>();
  let [年, 月, 日] = [頭[0], 頭[1], 頭[2]] as [number, number, number];
  for (;;) {
    for (const 行 of 列(`${年}年${月}月${日}日`)) 和.add(行);
    if (年 === 尾[0] && 月 === 尾[1] && 日 === 尾[2]) return 和;
    日 += 1;
    const 末日 = new Date(Date.UTC(年, 月, 0)).getUTCDate();
    if (日 > 末日) {
      日 = 1;
      月 += 1;
      if (月 > 12) {
        月 = 1;
        年 += 1;
      }
    }
  }
}

function 和集合(語々: string[]): Set<string> {
  const 和 = new Set<string>();
  for (const 語 of 語々) for (const 行 of 列(語)) 和.add(行);
  return 和;
}

function 案内(語: string): string[] {
  const 関数 = (Recommender as unknown as Record<string, (語: string, 時刻: number) => string[]>)
    .relativeDayNotes;
  return 関数(語, 基準);
}

describe("月語に日を繋げた形", () => {
  it("其の方の暦日で探す（其の日を単体で打った形と対称差 0）", () => {
    for (const [語, 基] of [
      ["来月10日", "2026年9月10日"],
      ["来月1日", "2026年9月1日"],
      ["今月15日", "2026年8月15日"],
      ["再来月5日", "2026年10月5日"],
      ["先月20日", "2026年7月20日"],
      ["翌月3日", "2026年9月3日"],
    ] as Array<[string, string]>) {
      expect(列(基).size, `対照の「${基}」が 0 行`).toBeGreaterThan(0);
      expect(対称差(列(語), 列(基)), `${語} が其の方の日の行と違う列表`).toBe(0);
    }
  });

  it("件数欄に解けた日を書く（過ぎた日過ぎてる事は其の方で言う）", () => {
    expect(案内("来月10日")).toEqual(["来月10日 = 2026年9月10日(木)の締切"]);
    expect(案内("今月3日")).toEqual([
      "今月3日 = 2026年8月3日(月)の締切（その日は過ぎています – 「過去の締切も表示」を付けると並びます）",
    ]);
  });

  it("`までに` を繋げた形は今日からの幅として受ける（其の日毎の和集合と対称差 0）", () => {
    const 幅 = 日の幅和([2026, 8, 9], [2026, 9, 10]);
    expect(列("来月10日までに").size, "`来月10日までに` が行を出さない").toBeGreaterThan(0);
    expect(対称差(列("来月10日までに"), 幅), "`来月10日までに` が今日からの日幅と違う列表").toBe(0);
    expect(案内("来月10日までに")).toEqual([
      "来月10日までに = 2026年8月9日(日)〜9月10日(木)の締切 – 行に書かれた他の日付（別の締切ラウンド・会期）でも当たるので、締切日からの日数で絞る「締切まで」の欄が確かです",
    ]);
  });

  it("其の月に其の日が在らない形は解かない（締切の推測はしない）", () => {
    /* 基準の日の来月は 9 月 – 9 月に 31 日は在らない。其の方の日で探す形は 0 行の侭で、
     * 案内も立てない（在らない日を在る日として見せない）。 */
    expect(列("来月31日")).toEqual(new Set());
    expect(案内("来月31日")).toEqual([]);
    /* 其の月に在る日は解ける – 月の末日の数まで見る。 */
    expect(対称差(列("来月29日"), 列("2026年9月29日"))).toBe(0);
    expect(対称差(列("今月31日"), 列("2026年8月31日"))).toBe(0);
  });

  it("月語に日を繋げた形を並べた物は和集合になる（AND に割れて減らない）", () => {
    const 和 = 和集合(["来月10日", "来月20日"]);
    expect(和.size, "対照の二日が 0 行").toBeGreaterThan(0);
    for (const 語 of ["来月10日と来月20日", "来月10日、来月20日", "来月10日,来月20日"]) {
      expect(対称差(列(語), 和), `${語} が二日の和集合と違う列表`).toBe(0);
    }
  });

  it("月語に日を繋げた形を幅に並べた形も其の幅で受ける", () => {
    const 幅 = 日の幅和([2026, 9, 10], [2026, 9, 20]);
    expect(幅.size, "対照の幅が 0 行").toBeGreaterThan(0);
    expect(対称差(列("来月10日から来月20日"), 幅)).toBe(0);
    expect(対称差(列("来月10日から来月20日までに"), 幅)).toBe(0);
  });

  it("月語其れ自身と週+曜日の形は其侭", () => {
    expect(列("来月").size, "`来月` が壊れた").toBeGreaterThan(0);
    expect(対称差(列("来月まで"), 列("来月"))).toBe(0);
    expect(対称差(列("来週月曜"), 列("2026年8月10日"))).toBe(0);
    expect(対称差(列("来月中"), 列("来月"))).toBe(0);
  });
});

describe("成果物", () => {
  it("月語に日を繋げた形を解く処と五箇所の配線が実測どおりに成果物に入っている", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/function pressedMonthDayJa\(token, nowMs\)/g) ?? []).toHaveLength(1);
    /* 週+曜日の形と決まりを共通にする配線（案内・幅の片側・列挙の目印・日の語の群・までにの枝）。 */
    expect(
      物.match(/pressedWeekdayJa\(token, nowMs\) \|\| pressedMonthDayJa\(token, nowMs\);/g) ?? [],
    ).toHaveLength(2);
    expect(
      物.match(/pressedWeekdayJa\(元, nowMs\) \|\| pressedMonthDayJa\(元, nowMs\);/g) ?? [],
    ).toHaveLength(1);
    expect(
      物.match(/pressedWeekdayJa\(柄, nowMs\) \|\| pressedMonthDayJa\(柄, nowMs\);/g) ?? [],
    ).toHaveLength(1);
    expect(
      物.match(
        /pressedWeekdayJa\(head\[1\], nowMs\) \|\| pressedMonthDayJa\(head\[1\], nowMs\)/g,
      ) ?? [],
    ).toHaveLength(1);
    /* 其の月に其の日が在らない日は解かない決まり（成果物では `return null;` が次の行に割れる）。 */
    expect(物.match(/if \(番号 > 末日\)/g) ?? []).toHaveLength(1);
    /* 並べた形が AND に割れない為の目印（其のままの語で見る – 第 394 回と同じ決まり）。 */
    expect(物).toContain(
      "/^(?:今月|来月|再来月|先月|昨月|先々月|翌月|前月)[0-9]{1,2}日$/.test(語)",
    );
  });
});
