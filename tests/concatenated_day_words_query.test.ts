/**
 * 助詞も読点も無く日語を二つ並べた打ち方（`明日明後日` `8月9月` `来週再来週`）（第 402 回）。
 *
 * 実測（2026-09-28 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻
 * 2026-08-09T00:00:00Z）: `明日` 4 行・`明後日` 12 行・其の方を `と` で並べた形 13 行・
 * `8月と9月` 441 行が通るのに、**並べただけの形は 0 行**（`明日明後日` **0 行**・`今日明日`
 * **0 行**・`昨日今日` **0 行**・`来週再来週` **0 行**・`8月9月` **0 行**・
 * `8月下旬9月上旬` **0 行**・`今月来月` **0 行**）。日本語は語の間に読点を入れない書き方が
 * 有るので、其の打ち方でも損をしないやうにする – 其の方の組が全部の日語で決まる時だけ
 * 和集合にする（語を並べた物 `東京大阪` は其侭 AND の侭）。
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

describe("助詞も読点も無い日語の連結", () => {
  it("其の方を `と` で並べた形と同じ列表になる（並べただけで減らない）", () => {
    expect(列("明日").size, "対照の「明日」が 0 行").toBeGreaterThan(0);
    for (const [並べた形, と] of [
      ["明日明後日", "明日と明後日"],
      ["今日明日", "今日と明日"],
      ["昨日今日", "昨日と今日"],
      ["来週再来週", "来週と再来週"],
      ["8月9月", "8月と9月"],
      ["8月下旬9月上旬", "8月下旬と9月上旬"],
      ["今月来月", "今月と来月"],
      ["来週翌週", "来週と翌週"],
    ] as Array<[string, string]>) {
      expect(
        対称差(列(並べた形), 列(と)),
        `\`${並べた形}\` が \`と\` で並べた \`${と}\` と違う列表`,
      ).toBe(0);
    }
  });

  it("裸の日を継がせる連結（月を名乗る頭）も読点で並べた方と同じ", () => {
    expect(列("8月10日と11日").size, "対照の「8月10日と11日」が 0 行").toBeGreaterThan(0);
    expect(
      対称差(列("8月10日11日"), 列("8月10日と11日")),
      "`8月10日11日` が `と` で並べた方と違う列表",
    ).toBe(0);
    expect(
      対称差(列("8月10日11日"), 列("8月10日、11日")),
      "`8月10日11日` が読点で並べた方と違う列表",
    ).toBe(0);
  });

  it("並べた日に締切の語を繋げた形も其の方の絞り込みになる", () => {
    expect(列("明日と明後日締切").size, "対照の「明日と明後日締切」が 0 行").toBeGreaterThan(0);
    expect(
      対称差(列("明日明後日締切"), 列("明日と明後日締切")),
      "`明日明後日締切` が `と` で並べた方と違う列表",
    ).toBe(0);
  });

  it("同じ語を繰り返す形は其の方の語の侭（重複が絞り込みを強めない）", () => {
    expect(列("来月").size, "対照の「来月」が 0 行").toBeGreaterThan(0);
    expect(対称差(列("来月来月"), 列("来月")), "`来月来月` が変わった").toBe(0);
  });

  it("二日・二週の和集合になる（其れぞれ単体で打った形の和と対称差 0）", () => {
    const 二日 = new Set([...列("明日")].concat([...列("明後日")]));
    expect(二日.size, "対照の二日が 0 行").toBeGreaterThan(0);
    expect(対称差(列("明日明後日"), 二日), "`明日明後日` が二日の和集合と違う").toBe(0);
    const 二週 = new Set([...列("来週")].concat([...列("再来週")]));
    expect(対称差(列("来週再来週"), 二週), "`来週再来週` が二週の和集合と違う").toBe(0);
  });

  it("其のまま一日（二日）を名乗る語は割らない（別週の物を交ざらせない）", () => {
    /* 割れると其の方の語の和集合に化ける – 其れと違う列表であることを張る。 */
    for (const [語, 甲, 乙] of [
      ["来週火曜", "来週", "火曜"],
      ["来週月曜", "来週", "月曜"],
      ["今週末", "今週", "週末"],
      ["来週末", "来週", "週末"],
    ] as Array<[string, string, string]>) {
      const 其のまま = 列(語);
      expect(其のまま.size, `対照の「${語}」が 0 行`).toBeGreaterThan(0);
      const 割れた形 = new Set([...列(甲)].concat([...列(乙)]));
      expect(
        対称差(其のまま, 割れた形) > 0,
        `「${語}」が「${甲}」と「${乙}」の和集合に割れた`,
      ).toBe(true);
    }
    /* 月語+日（第 400 回）は其のまま一日を名乗る。 */
    expect(対称差(列("来月10日"), 列("2026年9月10日"))).toBe(0);
    expect(対称差(列("今月15日"), 列("2026年8月15日"))).toBe(0);
  });

  it("幅の形は幅の侭受ける（列挙に化けて広まらない）", () => {
    const 二日 = new Set([...列("明日")].concat([...列("明後日")]));
    const 幅 = 列("明日から明後日");
    expect(幅.size, "`明日から明後日` が行を出さない").toBeGreaterThan(0);
    for (const 行 of 幅) {
      expect(二日.has(行), "`明日から明後日` が二日の外を出している").toBe(true);
    }
    /* 週を跨いだ幅も其の方の日幅の侭 – 列挙の和集合に化けない。 */
    const 週幅 = 列("来週月曜から来週金曜");
    expect(週幅.size, "`来週月曜から来週金曜` が行を出さない").toBeGreaterThan(0);
    const 週々 = new Set([...列("来週月曜")].concat([...列("来週金曜")]));
    let 内 = 0;
    for (const 行 of 週幅) if (週々.has(行)) 内 += 1;
    expect(内 < 週幅.size, "`来週月曜から来週金曜` が両端の二日だけに潰れた").toBe(true);
  });

  it("裸の日を継がせない（言い直しを列挙にしない）", () => {
    /* 「明日11日」は同じ日を言い直す打ち方 – 月を名乗る頭の時だけ裸の日を継がせる
     * （第 395 回と同じ決まり）。 */
    expect(列("明日11日")).toEqual(new Set());
    expect(列("今日3日")).toEqual(new Set());
  });

  it("語を並べた物（地名等）は其侭 AND の侭", () => {
    /* 語を並べた物は両方の語を要求する（AND）の侭 – 和集合にしてはいけない。 */
    const 甲 = 列("東京"),
      乙 = 列("大阪"),
      語 = 列("東京大阪");
    expect(甲.size, "対照の「東京」が 0 行").toBeGreaterThan(0);
    expect(乙.size, "対照の「大阪」が 0 行").toBeGreaterThan(0);
    for (const 行 of 語) {
      expect(甲.has(行) && 乙.has(行), `\`東京大阪\` が AND で無い行を出している: ${行}`).toBe(
        true,
      );
    }
    /* 語を並べた物が和集合に化けると、其の方の語だけを名乗る形より広く当たる – 其れを防ぐ。 */
    const 和集合 = new Set([...甲].concat([...乙]));
    expect(対称差(語, 和集合) > 0, "語を並べた物が和集合と 同じ列表").toBe(true);
  });
});

describe("成果物", () => {
  it("助詞も読点も無い連結を列挙に解く処が実測どおりに成果物に入っている", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/function 連結の列挙Ja\(語, nowMs\)/g) ?? []).toHaveLength(1);
    /* 其のまま解ける語は割らない決まり（成果物では `return null;` が次の行に割れる）。 */
    expect(物.match(/if \(解ける日語かJa\(q\)\)/g) ?? []).toHaveLength(1);
    /* 語の組と件数欄の案内の二箇所に配線して有る。 */
    expect(物.match(/連結の列挙Ja\((?:raw, now|part, nowMs)\)/g) ?? []).toHaveLength(2);
    /* 月を名乗る頭の時だけ裸の日を継がせる。 */
    expect(物).toContain("const 月を名乗る頭Ja = /[0-9]{1,2}月|今月|来月|再来月|先月/;");
    expect(物).toContain("解ける日語かJa(尾, 月を名乗る頭Ja.test(頭))");
  });
});
