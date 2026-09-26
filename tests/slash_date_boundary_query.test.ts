/**
 * 「7/1以降」等、切りで書く暦日に境界の語を繋げると 0 行で黙つて居た（第 454 回）。
 *
 * 実測（2026-10-26 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * - 和暦の `7月1日以降` 83 行・`12月31日以降` 2 行・`12月31日までに` 763 行で通るのに、
 *   切りで書く `7/1以降` `12/31以降` `2026.7.1以降`（点）・横棒の `2026-07-01以降` は
 *   **0 行で案内も無し**（`12/31までに` だけは第 398 回の守りで通つて 763 行）。
 * - 守りの目が `7/1以降` を `7` + `1以降` に割つて了ひ、其の日が其處迄届かなかつた
 *   （debug ビルドの trace で実証 – 当たり語 7・1以降 の 2 語の交わりに成つた）。
 * - 年付きの切り（`2026/7/1以降`）は第 448 回の暦日守りが其の方の語を通すのに、境界の
 *   語を繋げた形だけが漏れて居た。
 *
 * 直し: 暦日（切り・点・横棒・和暦）に境界の語を繋げた形を、其の方の語に解ける時に限り
 * 割らない（在ら無い日 `2/30以降` は今まで通り – 締切の推測はしない）。
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

describe("暦日に境界の語を繋げた切り・点・横棒の形が和暦と同じ当たり方（第 454 回）", () => {
  for (const [切り, 和暦] of [
    ["7/1以降", "7月1日以降"],
    ["2026/7/1以降", "2026年7月1日以降"],
    ["12/28以降", "12月28日以降"],
    ["2026.7.1以降", "2026年7月1日以降"],
    ["2026-07-01以降", "2026年7月1日以降"],
    ["1/1以降", "1月1日以降"],
    ["12/31までに", "12月31日までに"],
  ] as const) {
    it(`『${切り}』は 0 行で無く、和暦形と一字も違わない当たり方`, () => {
      expect(列(切り).size, 切り).toBeGreaterThan(0);
      expect(対称差(列(切り), 列(和暦)), 切り).toBe(0);
    });
  }
  it("在ら無い日は寄せない – 2月30日の翌日と誤爆しない（締切の推測はしない）", () => {
    expect(列("2/30以降").size).toBe(0);
  });
  it("実品の行の写しで – 其の日以降の行が出て外の行は出ない", () => {
    const 当 = Recommender.searchMatcher("12/28以降", 基準);
    expect(当("ict 2026年12月 12月 2026年12月28日 12月28日 月曜 締切")).toBe(true);
    expect(当("ict 2026年11月 11月 2026年11月28日 11月28日 土曜 締切")).toBe(false);
  });
});

describe("其れ他の暦日・境界の形を壊して居ない（不動）", () => {
  it("裸の暦日・幅の語は其の侭 – 化けも減りも無い（不動は前のビルドとの実測比較: 第 454 回）", () => {
    /* ハーネスの品書では `7/1` の単独暦日は 0 行（実ビルド 872 行では 8 行 – 第 451 回の
     * 教訓: 行の数は品書に依る）なので、当たり方の不動はビルド比較に譲り、此處では
     * 別物の幅に化けない事を決まりで張る。 */
    /* 横棒の幅の語（第 450 回）は切りでも同じ – 第 453 回の空格の寄せも其の侭。 */
    expect(対称差(列("8月20日から 8月25日まで"), 列("8月20日から8月25日まで"))).toBe(0);
    /* 其の方の語に解けない語尾（`と` で並べた切り）は割れる – 和集合の決まりは第 402 回。 */
    expect(列("8/20と8/25").size).toBe(0);
  });
  it("年を打った和暦は年を決める – 年なしの翌年繰りとは其の方の暦日が違う", () => {
    /* 年付きの形は其の方の年の其の日から – 年なしは過ぎて居れば翌年へ繰る（第 413 回の
     * 決まり）。切り・点・横棒も同じ決まりなので、年付きと年なしの差が其侭出る。 */
    expect(対称差(列("2026-07-01以降"), 列("2026年7月1日以降"))).toBe(0);
    expect(対称差(列("7/1以降"), 列("7月1日以降"))).toBe(0);
  });
});

describe("直した形がビルド成果物に残る（第 454 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("割らない決まりの目が 1 箇所・呼び出しが 2 箇所（語の割りと区切りの暦日の守り）", () => {
    expect(物.split("function 暦日に境界を続けた形Ja(").length - 1).toBe(1);
    /* 定義 1 + dateLike の目 1 + 語の割りの目 1 = 3 箇所（コメント中の語は括弧付きで
     * 無いので数えない – 抜いた語の文字列で張る）。 */
    expect(物.split("暦日に境界を続けた形Ja(String(token").length - 1).toBe(2);
    expect(物.split("暦日に境界を続けた形Ja(").length - 1).toBe(3);
  });
  it("在ら無い日は守らない – 暦日の検査が其の方の目だけで決まり、語の特別扱いを持たない（締切の推測はしない）", () => {
    /* 検査を落とす / 在ら無い日を特別扱いで通す改ざんは行に差が出ない為（実測 –
     * 其の方の割りの結果も 0 行）、決まりの字面を張る。 */
    expect(物.split("if (暦日に解くJa(芯) === null)").length - 1).toBe(1);
    const i = 物.indexOf("function 暦日に境界を続けた形Ja(");
    expect(物.slice(i, 物.indexOf("function より後を剥がす語Ja(", i))).not.toMatch(
      /語\s*[!=]==\s*"/,
    );
  });
});
