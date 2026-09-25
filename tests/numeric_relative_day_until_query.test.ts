/**
 * 数値で書く相対日・幅に期日を繋げた形（`3日後までに` `1週間後までに` `3日以内に`）（第 399 回）。
 *
 * 実測（2026-09-27 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻
 * 2026-08-09T00:00:00Z）: `3日後` 3 行・`1週間後` 17 行・`1か月後` 18 行・`3日前` 3 行は
 * 其の方の日に通るのに、`3日後までに` **0 行**・`2週間後までに` **0 行**・
 * `1か月後までに` **0 行**・`3日前までに` **0 行**・`3日以内に` **0 行**（`3日以内` 17 行）・
 * `1週間以内に` **0 行**（`1週間以内` 60 行）で、案内も立たなかつた。期日を訊く語尾を
 * 剥がした形が「日付の表に載つた語」で無いと剥がさない決まりだったので、数値で書く形が
 * 其処で落ちた – 「3日後までに間に合う枠」と云う普通の訊き方が黙つて居た。
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

/** 今日から其の日までの暦日を単体で打った形の和集合（月を跨いでも動く）。 */
function 日の幅和(尾: readonly [number, number, number]): Set<string> {
  const 和 = new Set<string>();
  let [年, 月, 日] = [2026, 8, 9] as [number, number, number];
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

describe("数値で書く相対日に期日を繋げた形", () => {
  it("今日から其の日までの幅として受ける（其の日の日幅と対称差 0）", () => {
    for (const [語, 尾] of [
      ["3日後までに", [2026, 8, 12]],
      ["5日後までに", [2026, 8, 14]],
      ["2週間後までに", [2026, 8, 23]],
      ["24日後までに", [2026, 9, 2]],
      ["1か月後までに", [2026, 9, 9]],
    ] as Array<[string, readonly [number, number, number]]>) {
      const 幅 = 日の幅和(尾);
      expect(列(語).size, `${語} が行を出さない`).toBeGreaterThan(0);
      expect(対称差(列(語), 幅), `${語} が今日からの日幅と違う列表`).toBe(0);
    }
  });

  it("`まで` だけの形・漢数字・単位の寄せる形も同じ幅", () => {
    expect(対称差(列("3日後まで"), 列("3日後までに"))).toBe(0);
    expect(対称差(列("一週間後までに"), 列("7日後までに"))).toBe(0);
    expect(対称差(列("三日後までに"), 列("3日後までに"))).toBe(0);
    expect(対称差(列("1週間後までに"), 列("7日後までに"))).toBe(0);
  });

  it("『前』の向きは絞り込みに使わない（過去方向に開いた幅の終わりを決めない – 第 367 回）", () => {
    /* `3日前` 其れ自身は其の日で通るが、`までに` を繋げた形は幅の終わりを決める頼み方 so
     * 解かない（いつまで遡るかが書かれて居ない – 締切の推測はしない）。 */
    expect(列("3日前までに")).toEqual(new Set());
    expect(案内("3日前までに")).toEqual([]);
    expect(列("1か月前までに")).toEqual(new Set());
    expect(列("3日前").size, "品書に其の日の行が無い").toBeGreaterThan(0);
  });

  it("他の語と繋げた形は幅と語の両方を掛けた物になる", () => {
    const 掛 = new Set([...列("2日後まで")].filter((行) => 列("締切").has(行)));
    expect(対称差(列("2日後までに締切"), 掛)).toBe(0);
    expect(列("締切").size, "品書に締切の行が無い").toBeGreaterThan(0);
  });

  it("件数欄に幅の両端を書く（当たり方と案内が食い違わない）", () => {
    expect(案内("3日後までに")).toEqual([
      "3日後までに = 2026年8月9日(日)〜8月12日(水)の締切 – 行に書かれた他の日付（別の締切ラウンド・会期）でも当たるので、締切日からの日数で絞る「締切まで」の欄が確かです",
    ]);
  });

  it("`以内` の幅に `に` を繋げただけの形は其の方の幅と同じ列表", () => {
    expect(対称差(列("3日以内に"), 列("3日以内"))).toBe(0);
    expect(対称差(列("1週間以内に"), 列("1週間以内"))).toBe(0);
    expect(対称差(列("30日以内に"), 列("30日以内"))).toBe(0);
    expect(対称差(列("3日以内までに"), 列("3日以内"))).toBe(0);
    expect(列("30日以内").size, "品書に 30 日以内の行が無い").toBeGreaterThan(0);
    expect(案内("3日以内に")).toEqual([
      "3日以内に = 2026年8月9日(日)〜8月12日(水) – 行に書かれた他の日付（別の締切ラウンド・会期）でも当たるので、締切日からの日数で絞る「締切まで」の欄が確かです",
    ]);
  });

  it("幅の展開は 370 日まで – 其れより後の日を黙って切り詰めた幅にしない", () => {
    /* `2年後までに` は幅を作れないので、其の方の日で絞る（案内は其の日だけを名乗る –
     * 途中までを幅として出さない）。 */
    expect(対称差(列("2年後までに"), 列("2年後"))).toBe(0);
    const 案内文 = 案内("2年後までに").join("");
    expect(案内文, "切り詰めた幅を幅として書いている").not.toContain("〜");
    expect(案内文, "何の日で絞ったかを書いていない").toContain("2028年8月9日(水)");
    /* 其の内に収まる形は幅として受ける – 上の形と違って案内が両端を書く（此の対で
     * 上限の切れ目を見る – 切り詰めを幅として出さない事が検査で決まる）。 */
    const 内の案内 = 案内("1年後までに").join("");
    expect(内の案内, "370 日以内に収まる幅が幅として出ていない").toContain("〜");
    expect(内の案内).toContain("2027年8月9日(月)");
  });

  it("決まらない形は解かない（締切の推測はしない）", () => {
    /* 時間の単位は締切の日めくりに換えない（別の規則が別の形だけ受ける）。 */
    expect(列("1時間後までに")).toEqual(new Set());
    expect(案内("1時間後までに")).toEqual([]);
    /* 『以降』と『までに』を繋げた向きが定まらない形は解かない。 */
    expect(列("3日以降までに")).toEqual(new Set());
    expect(案内("3日以降までに")).toEqual([]);
  });
});

describe("成果物", () => {
  it("数値の相対日をまでにの末尾に決める処が実測どおりに成果物に入っている", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(
      物.match(
        /const 数値 = 暦 \|\| \/前\$\/\.test\(stem\) \? null : numericRelativeDay\(stem, nowMs\);/g,
      ) ?? [],
    ).toHaveLength(1);
    /* 成果物では `return null;` が次の行に割れるので、目印は if の所まで。 */
    expect(物.match(/if \(!stem && !pressed && !暦\)/g) ?? []).toHaveLength(1);
    /* 『前』の向きに期日を訊く語尾を繋げた形を寄せない決まり（第 367 回）。 */
    /* 成果物では `continue;` が次の行に割れるので、目印は if の所まで。 */
    expect(
      物.match(/if \(tail\.indexOf\("まで"\) === 0 && 数値の前の向きJa\.test\(stem\)\)/g) ?? [],
    ).toHaveLength(1);
    expect(物.match(/const 年付きのみ = 暦 !== null \|\| 数値 !== null;/g) ?? []).toHaveLength(1);
    /* 剥がした形を表に載つた語と見なす決まり – 数値の相対日と幅の二つ。 */
    expect(物.match(/数値の相対日の形Ja\.test\(word\)/g) ?? []).toHaveLength(1);
    expect(物.match(/数値の幅の形Ja\.test\(word\)/g) ?? []).toHaveLength(1);
    /* 展開の上限を越えた幅を黙って返さない決まり。 */
    expect(物.match(/return 届いた \? out : null;/g) ?? []).toHaveLength(1);
  });
});
