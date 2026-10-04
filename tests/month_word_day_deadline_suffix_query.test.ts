/**
 * 月語に日を繋げた形に締切の語をさらに繋げた形（`来月10日締切` `今月15日〆`）（第 401 回）。
 *
 * 実測（2026-09-28 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻
 * 2026-08-09T00:00:00Z）: `来月10日` 20 行・`来月10日 締切` 18 行・`来週月曜締切` 3 行・
 * `明日締切` 3 行・`8月22日締切` 11 行が通るのに、**月語に日を繋げた形だけ繋げた瞬間に 0 行**
 * （`来月10日締切` **0 行**・`今月15日〆` **0 行**・`再来月5日締め` **0 行**・
 * `先月20日〆切` **0 行**・`翌月3日しめきり` **0 行**）。締切の語を繋げて打つ形は
 * 第 344 回（暦日）・第 346 回（其の日・其の曜日）・第 348 回（月の幅）で順に塞いだ処で、
 * 第 400 回で足した月語+日の形が其の頭に落ちて居た。
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

function 和集合(語々: string[]): Set<string> {
  const 和 = new Set<string>();
  for (const 語 of 語々) for (const 行 of 列(語)) 和.add(行);
  return 和;
}

function 積(甲: Set<string>, 乙: Set<string>): Set<string> {
  return new Set([...甲].filter((行) => 乙.has(行)));
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

function 案内(語: string): string[] {
  const 関数 = (Recommender as unknown as Record<string, (語: string, 時刻: number) => string[]>)
    .relativeDayNotes;
  return 関数(語, 基準);
}

describe("月語に日と締切の語を繋げた形", () => {
  it("空格で打った形と同じ列表になる（繋げた人が損をしない）", () => {
    expect(列("来月10日").size, "対照の「来月10日」が 0 行").toBeGreaterThan(0);
    for (const [繋いだ形, 空格] of [
      ["来月10日締切", "来月10日 締切"],
      ["来月10日〆", "来月10日 〆"],
      ["来月10日の締切", "来月10日 締切"],
      ["今月15日〆", "今月15日 〆"],
      ["再来月5日締め", "再来月5日 締め"],
      ["先月20日〆切", "先月20日 〆切"],
      ["翌月3日しめきり", "翌月3日 しめきり"],
      ["来月1日締切", "来月1日 締切"],
    ] as Array<[string, string]>) {
      expect(
        対称差(列(繋いだ形), 列(空格)),
        `\`${繋いだ形}\` が空格で打った \`${空格}\` と違う列表`,
      ).toBe(0);
    }
  });

  it("締切の語は其の方の絞り込みとして効く（其の日だけで探す形に含まれる）", () => {
    for (const [繋いだ形, 日のみ] of [
      ["来月10日締切", "来月10日"],
      ["今月15日〆", "今月15日"],
    ] as Array<[string, string]>) {
      const 甲 = 列(繋いだ形);
      const 乙 = 列(日のみ);
      expect(甲.size, `\`${繋いだ形}\` が行を出さない`).toBeGreaterThan(0);
      for (const 行 of 甲) {
        expect(乙.has(行), `\`${繋いだ形}\` が \`${日のみ}\` に無い行を出している`).toBe(true);
      }
    }
  });

  it("幅と列挙に締切の語を繋げた形も其の方の絞り込みになる", () => {
    /* 第 400 回で解ける様になった幅・列挙の形に、締切の語をさらに繋げた形 */
    const 幅 = 日の幅和([2026, 9, 10], [2026, 9, 20]);
    expect(対称差(列("来月10日から来月20日締切"), 積(幅, 列("締切")))).toBe(0);
    const 二日 = 和集合(["来月10日", "来月20日"]);
    expect(対称差(列("来月10日と来月20日締切"), 積(二日, 列("締切")))).toBe(0);
  });

  it("件数欄は打たれた月語+日を名乗る", () => {
    expect(案内("来月10日締切")).toEqual(["来月10日 = 2026年9月10日(木)の締切"]);
    expect(案内("再来月5日締め")).toEqual(["再来月5日 = 2026年10月5日(月)の締切"]);
  });

  it("其の月に在らない日は締切の語を繋げても解かない", () => {
    /* 基準の日の来月は 9 月 – 31 日は在らない（第 400 回の決まり）。 */
    expect(列("来月31日締切")).toEqual(new Set());
    expect(案内("来月31日締切")).toEqual([]);
  });

  it("其の他の繋げた形は其侭（暦日・其の日・週・月の幅・年の切れ目）", () => {
    expect(列("8月22日締切").size, "暦日を繋げた形が壊れた").toBeGreaterThan(0);
    for (const [語, 空] of [
      ["明日締切", "明日 締切"],
      ["金曜締切", "金曜 締切"],
      ["来週月曜締切", "来週月曜 締切"],
      ["来月末締切", "来月末 締切"],
      ["8月上旬締め", "8月上旬 締め"],
      ["年度末締切", "年度末 締切"],
      ["来月締切", "来月 締切"],
    ] as Array<[string, string]>) {
      expect(対称差(列(語), 列(空)), `\`${語}\` が変わった`).toBe(0);
    }
  });
});

describe("成果物", () => {
  it("月語に日を繋げた形が締切の語の頭の表に入っている", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    /* 数値の暦日の枝より先に置く（長い形が先に勝つ – 第 344 回と同じ決まり）。 */
    expect(物).toContain(
      "|(?:今月|来月|再来月|先月|昨月|先々月|翌月|前月)[0-9]{1,2}日|[0-9]{1,2}月[0-9]{1,2}日|",
    );
  });
});
