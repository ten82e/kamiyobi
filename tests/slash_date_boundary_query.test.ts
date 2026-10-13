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
  it("在らない日は寄せない – 2月30日の翌日と誤爆しない（締切の推測はしない）", () => {
    expect(列("2/30以降").size).toBe(0);
  });
  it("実品の行の写しで – その日以降の行が出て外の行は出ない", () => {
    const 当 = Recommender.searchMatcher("12/28以降", 基準);
    expect(当("ict 2026年12月 12月 2026年12月28日 12月28日 月曜 締切")).toBe(true);
    expect(当("ict 2026年11月 11月 2026年11月28日 11月28日 土曜 締切")).toBe(false);
  });
});

describe("それ他の暦日・境界の形を壊して居ない（不動）", () => {
  it("裸の暦日・幅の語はその侭 – 化けも減りもない（不動は前のビルドとの実測比較: 第 454 回）", () => {
    /* 横棒の幅の語は切りでも同じ – 第 453 回の空格の寄せもその侭。 */
    expect(対称差(列("8月20日から 8月25日まで"), 列("8月20日から8月25日まで"))).toBe(0);
    /* その方の語に解けない語尾（`と` で並べた切り）は割れる – 和集合の決まりは第 402 回。 */
    expect(列("8/20と8/25").size).toBe(0);
  });
  it("年を打った和暦は年を決める – 年なしの翌年繰りとはその方の暦日が違う", () => {
    /* 年付きの形はその方の年のその日から – 年なしは過ぎて居れば翌年へ繰る。切り・点・横棒も同じ決まりなので、年付きと年なしの差が其侭出る。 */
    expect(対称差(列("2026-07-01以降"), 列("2026年7月1日以降"))).toBe(0);
    expect(対称差(列("7/1以降"), 列("7月1日以降"))).toBe(0);
  });
});

describe("直した形がビルド成果物に残る（第 454 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("割らない決まりの目が 1 箇所・呼び出しが 2 箇所（語の割りと区切りの暦日の守り）", () => {
    expect(物.split("function 暦日に境界を続けた形Ja(").length - 1).toBe(1);

    expect(物.split("暦日に境界を続けた形Ja(String(token").length - 1).toBe(2);
    expect(物.split("暦日に境界を続けた形Ja(`").length - 1).toBe(2);
    /* 定義の形（`関数名(` を打つ所）はここに書く 5 箇所と別箇所に増えたら検査を落とす –
     * 総数で張る: 定義 1 + 上の 4 呼び（解ける検査の `詰` を見る目 2 を含む）= 7 箇所。 */
    expect(物.split("暦日に境界を続けた形Ja(").length - 1).toBe(7);
  });
  it("在らない日は守らない – 暦日の検査がその方の目だけで決まり、語の特別扱いを持たない（締切の推測はしない）", () => {
    /* 検査を落とす / 在ら無い日を特別扱いで通す改ざんは行に差が出ない為（実測 –
     * その方の割りの結果も 0 行）、決まりの字面を張る。 */
    expect(物.split("if (暦日に解くJa(芯) === null)").length - 1).toBe(1);
    const i = 物.indexOf("function 暦日に境界を続けた形Ja(");
    expect(物.slice(i, 物.indexOf("function より後を剥がす語Ja(", i))).not.toMatch(
      /語\s*[!=]==\s*"/,
    );
  });
});
