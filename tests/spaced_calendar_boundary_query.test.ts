import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): string[] {
  return (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
}

function 対称差(x: Set<string>, y: Set<string>): number {
  let n = 0;
  for (const a of x) if (!y.has(a)) n += 1;
  for (const b of y) if (!x.has(b)) n += 1;
  return n;
}

describe("空格で離した暦日と境界の語が詰め形と同じ行に出る（第 455 回）", () => {
  const 品 = 品書();
  const 列 = (q: string): Set<string> => {
    const 当 = Recommender.searchMatcher(q, 基準);
    return new Set(品.filter((行) => 当(行) === true));
  };

  const 組: Array<[string, string]> = [
    ["12/31 までに", "12/31までに"],
    ["12/28 までに", "12/28までに"],
    ["7月1日 以降", "7月1日以降"],
    ["1/1 以降", "1/1以降"],
    ["7/1 以降", "7/1以降"],
    ["2026-07-01 以降", "2026-07-01以降"],
    ["2026.7.1 以降", "2026.7.1以降"],
    ["7/1 から", "7月1日から"],
    ["8/20 から 8/25 まで", "8/20から8/25まで"],
    ["8/20 から 25日まで", "8月20日から25日まで"],
    ["8月20日から 8月25日まで", "8月20日から8月25日まで"],
    ["12/31 の までに", "12/31までに"],
  ];
  for (const [空, 詰] of 組) {
    it(`「${空}」は詰め形「${詰}」と一字も違わない`, () => {
      const 実 = 列(詰);
      /* 詰め形がその方の品で一行以上引ける事 – 両側 0 行の空振りで
       * 対称差 0 が通る穴を防ぐ。 */
      expect(実.size, 詰).toBeGreaterThan(0);
      expect(対称差(列(空), 実), 空).toBe(0);
    });
  }

  /* 不動 – 在ら無い日・相対日・帯は今まで通り（締切の推測はしない – 第 328 回・
   * 第 369 回・第 398 回・第 454 回の決まりをこの寄せが壊さない事）。 */
  /* 期待値は実ビルドではなく検査用ビルドの品書で測った実行数（上の流儀と同じ –
   * 実測 2026-11-05 – 検査品 435 行）。 */
  /* 詰め形の方へも実質の行が其侭届く事を張る – 品書が空に化けると上の対称差 0 が
   * 両側 0 行で空振りする為。 */
  it("詰め形が品書で実質の行を引く", () => {
    expect(列("12/31までに").size).toBeGreaterThan(100);
    expect(列("1/1以降").size).toBeGreaterThan(100);
    expect(列("8月20日から8月25日まで").size).toBeGreaterThan(0);
  });

  /* 暦日の語に寄せるので、その方の割りの形も壊れない – 割った語が助詞だけなどに
   * 化けたらここで落ちる（芯の暦日検査を落とす改ざんはこの一行で捉える – 第 455 回）。 */
  it("暦日と助詞だけの語は今まで通り割れて一行も引かない", () => {
    expect(列("12 の まで")).toEqual(new Set());
  });

  /* 暦日の語に寄せるので、その方の割りの形も壊れない – 割った語が助詞だけなどに
   * 化けたらここで落ちる（芯の暦日検査を落とす改ざんを捉える – 第 455 回）。 */
  it("暦日と助詞だけの語は今まで通り割れて一行も引かない", () => {
    expect(列("12 の まで")).toEqual(new Set());
  });

  const 不動: Array<[string, number]> = [
    /* 在ら無い日は寄せない – その日を決める目に解けない（締切の推測はしない）。 */
    ["2/30 以降", 0],
    ["2/30 までに", 0],

    ["来週 まで", 43],
    ["明日 まで", 2],
    ["今週 まで", 0],
    ["来週 から", 423],
    /* ゾーン・幅の語は暦日の語では無いので寄せない。帯（`17時 以降`）は第 464 回で
     * その方の機械が解くやうにしたので、この表から降ろして別の検査で張る。 */
    ["JST 以降", 0],
    ["5 日間", 0],
    ["明日から 5日間", 36],
    /* 助詞で割れる形はその方の決まり（`3 日前` は詰め形とも同じ 1 行）。 */
    ["3 日前", 1],
  ];
  for (const [打ち方, 期待] of 不動) {
    it(`「${打ち方}」は今まで通り ${期待} 行`, () => {
      expect(列(打ち方).size, 打ち方).toBe(期待);
    });
  }
  /* 詰め形側が検査品で引ける行の侭動く事も張る – 寄せが詰め形を壊したら
   * 上の対称差 0 もここで落ちる。 */
  it("詰め形「17時以降」の寄せない決まり – 帯の語は暦日の語に寄らない", () => {
    expect(列("17時以降").size).toBe(181);
  });
  it("「17時 以降」は第 464 回で詰め形と同じ行に出る（この表の 0 行は古い決まり）", () => {
    expect(列("17時 以降").size).toBe(181);
    expect(対称差(列("17時 以降"), 列("17時以降"))).toBe(0);
  });
});

describe("直した形がビルド成果物に残る（第 455 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("空格寄せの定義が 1 箇所・語の割りの内側の呼びが 1 箇所", () => {
    expect(物.split("function 暦日を境界に寄せるJa(").length - 1).toBe(1);
    expect(
      物.split(
        "範囲の語を寄せるJa(暦日を境界に寄せるJa(mergeSeasonTokens(単位を数字に寄せるJa(queryTokens(query, now))), now), now)",
      ).length - 1,
    ).toBe(1);
  });
  it("寄せた形を切りへ寄せる目（第 454 回の正規化）が寄せの中に 2 箇所", () => {
    /* 第 456 回で裸の境界の語を寄せる決まりも同じ正規化を通すので 2 箇所
       （実ビルドで測った `2026.7.1 以降` 789 行 ⇔ 詰め形が其侭 1 箇所の内）。 */
    expect(物.split("暦日に境界を続けた形Ja(`").length - 1).toBe(2);
  });
  /* 芯の暦日検査を落とす改ざんは品書の行に差が出ない（実測 – 37 語ぜんぶ同数 –
   * GATE の解ける検査がその方で弾く為 – 第 454 回と同じ穴）。なので字面を張る。 */
  it("芯割りの暦日検査（数字で始まらない芯・暦日でない芯を割らない）が一個所", () => {
    /* ビルドの整形は `return` を別行に落とす – 条件の目印までを張る。 */
    expect(物.split("if (芯 && !/^[0-9]/.test(芯))").length - 1).toBe(1);
    expect(
      物.split("if (芯 && 芯 !== 語 && !暦日の語かJa(芯) && !/^[0-9]{1,2}(?:日|月)$/.test(芯))")
        .length - 1,
    ).toBe(1);
  });
  it("寄せた語を割らない守りが語の割りの目に入る（対称差に現れない穴の為）", () => {
    expect(
      /* ビルドの整形が `return true;` を別行に落とす – 目印の語の割りの内側に入る所まで。 */
      物.split('if (dayRangeTermsJa(String(token || ""), now).length > 0)').length - 1,
    ).toBe(1);
  });
});
