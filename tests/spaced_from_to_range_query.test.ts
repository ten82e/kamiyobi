/**
 * 「8月20日から 25日まで」等、幅を空格で離って打つと 0 行で黙つて居た（第 453 回）。
 *
 * 実測（2026-10-26 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * - 寄せた `8月20日から25日まで` `8月20日から8月25日まで` は 41 行で通るのに、間に空格を
 *   入れた `8月20日から 25日まで` `8月20日から 8月25日まで` は **0 行で案内も無し** –
 *   幅の解きは語の其處其處で走る為、割れた二語の内の尾側（`25日まで`）が其の方の語に
 *   解けず、AND で 0 行になつた（`8月20日から` 746 行・`25日まで` 0 行と実測）。
 * - 同じ和集合の穴は第 402 回（並べた日の連結）・第 423 回（相対語の内の空格）で塞いだ –
 *   幅の語が其れから抜けて居た。
 *
 * 直し: 行を出す側の語の列（第 332 回の季節の寄せと同じ置き場）で、隣り合う
 * 「〜から/より」「〜まで/までに」を継いだ語が**幅の解きで実際に解ける時にだけ**寄せる。
 * 解けない語（`明日から 17時まで` 等）は其侭下流れで今の動きを変えない – 幅を発明しない
 * （締切の推測はしない）。
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

function 対称差(x: Set<string>, y: Set<string>): number {
  let n = 0;
  for (const a of x) if (!y.has(a)) n += 1;
  for (const b of y) if (!x.has(b)) n += 1;
  return n;
}

describe("幅を空格で離って打っても寄せた人と同じ行が出る（第 453 回）", () => {
  for (const [空格, 寄せ] of [
    ["8月20日から 25日まで", "8月20日から25日まで"],
    ["8月20日から 8月25日まで", "8月20日から8月25日まで"],
    ["9月1日から 9月10日まで", "9月1日から9月10日まで"],
    ["9月1日より 9月10日までに", "9月1日より9月10日までに"],
  ] as const) {
    it(`『${空格}』は 0 行で無く、寄せ形と一字も違わない当たり方`, () => {
      expect(列(空格).size, 空格).toBeGreaterThan(0);
      expect(対称差(列(空格), 列(寄せ)), 空格).toBe(0);
    });
  }
  it("実品の行の写しで – 其の日を打つ行が出て、外の月の行は出ない", () => {
    /* 実測（第 453 回）: 当たり行は `… 2026年8月 8月 2026年8月25日 8月25日 火曜 …` の
     * やうに月語と暦日を揃えて持つ – 幅の解きが並べる語（暦月・暦日）と其の方の語の
     * 目の合わせ方は其のまま、其の日其物の日付を継いだ語で受ける。 */
    const 当 = Recommender.searchMatcher("8月20日から 25日まで", 基準);
    expect(当("ict 2026年8月 8月 2026年8月25日 8月25日 火曜 締切")).toBe(true);
    expect(当("ict 2026年8月 8月 2026年9月1日 9月1日 火曜 締切")).toBe(false);
  });
  it("解けない語は寄せて居ない – 幅を発明しない（締切の推測はしない）", () => {
    /* 時刻側の `まで` を日の語に継いだ幅は解けない – 元通り別々の語で受ける。 */
    expect(列("明日から 17時まで").size).toBe(列("明日から 17時 まで").size);
  });
});

describe("其れ他の幅・境界の形を壊して居ない（不動）", () => {
  /* 前の回のビルドとの実測比較（行対称差 0）は第 453 回の記録に譲り、此處では
   * 寄せが効く筈の無い形が別の話に化けて居ない事を決まりで張る。 */
  it("数えの幅への寄せは起きない – 次語が `まで` で終ら無い限り別々の語の侭", () => {
    /* 寄せの条件は「次語が `まで`/`までに` で終る」– `明日から 5日間` は其侭二語で
     * 受ける（実測 – 寄せ形の `明日から5日間` 44 行に化けない）。 */
    expect(列("明日から 5日間").size).toBe(0);
  });
  it("開いた幅（`8月20日から`）は其の侭開いた幅 – 次語を勝手に呑まない", () => {
    const 幅 = 列("8月20日から");
    expect(幅.size).toBeGreaterThan(0);
    /* 後の語が日の語で無い（`締切`）時は寄せない – 交わりが `締切` 側で減る。 */
    const 交 = new Set([...幅].filter((a) => 列("締切").has(a)));
    expect(列("8月20日から 締切").size).toBe(交.size);
  });
  it("解けない語は寄せない – 幅の解きが 0 語の継ぎ足しをしない（締切の推測はしない）", () => {
    /* 日の語 + 時刻の `まで` は幅の解きで 0 語（実測 – debug ビルドの trace で確かめた:
     * `9月1日から 17時まで` は門を抜けるが解語数 0）。其處を寄せた BUILD と、寄せない
     * BUILD は行が其處其処で違う – 寄せた BUILD は幅に解けた行だけを受けるので、
     * 日の語に解けるだけの行が落ちる。 */
    /* 行は `9月1日から` の開いた幅で受かる和暦日を持つ物 – 寄せた BUILD は此れを
     * 解けない幅に読み替えて 0 行に落とす（実測で前の行が解ける事を先に確かめた:
     * `9月1日から` で ○○・`9月2日` で ×○）。 */
    const 行 = [
      "ict September first deadline 2026年9月1日 9月1日 締切",
      "ict sep two deadline 2026年9月2日 9月2日 締切",
    ];
    const 幅側 = Recommender.searchMatcher("9月1日から", 基準);
    expect(行.filter((x) => 幅側(x)).length).toBe(2);
    const 当 = Recommender.searchMatcher("9月1日から 17時まで", 基準);
    expect(行.filter((x) => 当(x)).length).toBe(0);
    /* 同じ門は相対語にも其侭効く – 解ける幅は寄せた人と同じ形に成る（実測 53 行 –
     * 相対語は行の注入が其の方の語側で働く為、合成の行では試せない – 第 449 回の教訓。
     * 前の BUILD との対称差実測（第 453 回）も此の等式の侭 0）。 */
    const 対 = (x: Set<string>, y: Set<string>) => {
      let n = 0;
      for (const a of x) if (!y.has(a)) n += 1;
      for (const b of y) if (!x.has(b)) n += 1;
      return n;
    };
    expect(対(列("来週から 来週まで"), 列("来週"))).toBe(0);
  });
});

describe("直した形がビルド成果物に残る（第 453 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("寄せの呼び出しが 1 箇所・定義が 1 箇所", () => {
    expect(
      /* 第 455 回の空格寄せが内側に入った – 幅の寄せが其の方の入力を包む侭居る事を張る。 */
      物.split(
        "範囲の語を寄せるJa(暦日を境界に寄せるJa(mergeSeasonTokens(queryTokens(query, now)), now), now)",
      ).length - 1,
    ).toBe(1);
    expect(物.split("function 範囲の語を寄せるJa(").length - 1).toBe(1);
  });
});
