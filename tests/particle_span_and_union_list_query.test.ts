import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  return Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
}

function 当たり列表(語: string): string[] {
  const 当 = Recommender.searchMatcher(語, 基準);
  return 品書()
    .filter((行) => 当(String(行.hay)) === true)
    .map((行) => String(行.hay))
    .sort();
}

function 対称差(甲: string, 乙: string): number {
  const 左 = new Set(当たり列表(甲));
  const 右 = new Set(当たり列表(乙));
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}

function 和集合(語々: string[]): Set<string> {
  const 出 = new Set<string>();
  for (const 語 of 語々) for (const 行 of 当たり列表(語)) 出.add(行);
  return 出;
}

function 対称差和(語: string, 内: string[]): number {
  const 左 = new Set(当たり列表(語));
  const 右 = 和集合(内);
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}

function 幅の展開(語: string): string[] {
  const 関数 = (Recommender as unknown as Record<string, (語: string, 時刻: number) => string[]>)
    .dayRangeTermsJa;
  return 関数(語, 基準);
}

function 案内組(語: string): Array<[string, string]> {
  const 関数 = (
    Recommender as unknown as Record<string, (語: string, 時刻: number) => Array<[string, string]>>
  ).dayRangePairs;
  return 関数(語, 基準);
}

describe("助詞 `へ` で結んだ幅", () => {
  it("`から` を使った幅と同じ列表を出す", () => {
    expect(対称差("8月10日へ8月20日", "8月10日から8月20日")).toBe(0);
    expect(対称差("月曜へ金曜", "月曜から金曜")).toBe(0);
    expect(対称差("明日へ明後日", "明日から明後日")).toBe(0);
    expect(対称差("来週へ再来週", "来週から再来週")).toBe(0);
  });

  it("その方の語がその方の幅に解ける（割れた語の組でない事）", () => {
    expect(幅の展開("8月10日へ8月20日")).toHaveLength(11);
    expect(幅の展開("明日へ明後日")).toEqual(["2026年8月10日", "2026年8月11日"]);
    expect(案内組("8月10日へ8月20日")).toEqual([
      ["8月10日へ8月20日", "2026年8月10日から2026年8月20日"],
    ]);
  });

  it("`へ` が本当に助詞の打ち方は今まで通り割れる", () => {
    /* その方の日を決めない語は割る – `会議へ` の様な打ち方で語その物を探しに行かない。 */
    /* その方の日を決めない語は今まで通り助詞で割れる（`へ` を助詞の表から消したのでは無い）。
     * 月を決めない幅 `10日へ20日` はそのまま解かない – 割った語の組として当たり方に残る。 */
    expect(案内組("セキュリティへ")).toEqual([]);
    expect(案内組("10日へ20日")).toEqual([]);
    expect(幅の展開("10日へ20日")).toEqual([]);
    expect(当たり列表("10日").length, "品書にその方の日の行がない").toBeGreaterThan(0);
    for (const 行 of 当たり列表("10日へ20日")) {
      expect(
        当たり列表("10日").includes(行),
        `割った語の組では無くなった: ${行.slice(0, 20)}`,
      ).toBe(true);
    }
  });
});

describe("`と` で並べた列挙", () => {
  it("並べた語の和集合を出す（その方の日を両方出す – 幅ではない）", () => {
    for (const [語, 内] of [
      ["月曜と金曜", ["月曜", "金曜"]],
      ["8月と11月", ["8月", "11月"]],
      ["明日と明後日", ["明日", "明後日"]],
    ] as Array<[string, string[]]>) {
      expect(当たり列表(語).length, `行が出ない: ${語}`).toBeGreaterThan(0);
      expect(対称差和(語, 内), `和集合と違う列表: ${語}`).toBe(0);
    }
  });

  it("件数欄には幅ではなく『または』で書く", () => {
    expect(案内組("明日と明後日")).toEqual([["明日と明後日", "2026年8月10日または2026年8月11日"]]);
    expect(案内組("8月と11月")).toEqual([["8月と11月", "2026年8月または2026年11月"]]);
    expect(案内組("月曜と金曜")).toEqual([["月曜と金曜", "月曜または金曜"]]);
  });

  it("相対の月を並べた形も受ける（月の語は柄に寄せると消える – 打たれた語の側で見る）", () => {
    expect(案内組("今月と来月")).toEqual([["今月と来月", "2026年8月または2026年9月"]]);
    expect(当たり列表("今月と来月").length, "相対の月の列挙が行を出さない").toBeGreaterThan(0);
    expect(対称差和("今月と来月", ["今月", "来月"])).toBe(0);
  });

  it("季節の語を並べた形も和集合で受ける", () => {
    expect(当たり列表("秋と春").length, "季節を並べた語が行を出さない").toBeGreaterThan(0);
    expect(対称差和("秋と春", ["秋", "春"])).toBe(0);
  });

  it("日を決めない語を `と` で繋いだ打ち方は列挙にしない（其侭の語として探す）", () => {
    /* その方の語はその方の語の展開語を持つので、両側の検査を落とすと割った語の和集合に
     * 化ける（実測 – 改ざんで緑通しになった為、ここに張る – 第 394 回）。 */
    expect(案内組("セキュリティと機械学習")).toEqual([]);
    expect(当たり列表("セキュリティと機械学習")).toEqual([]);
    expect(和集合(["セキュリティ", "機械学習"]).size, "品書にその方の語の行がない").toBeGreaterThan(
      0,
    );
  });

  it("『曜日』と打たれた形は件数欄で画面の曜日の語に寄せる", () => {
    expect(案内組("月曜日と金曜日")).toEqual([["月曜日と金曜日", "月曜または金曜"]]);
    expect(対称差("月曜日と金曜日", "月曜と金曜")).toBe(0);
  });

  it("三つ以上並べた形も同じ決まりで受ける", () => {
    expect(対称差和("明日と明後日と明々後日", ["明日", "明後日", "明々後日"])).toBe(0);
  });

  it("その方が決まらない語を混んだ列挙は解かない（片方だけの当たり方は噓になる）", () => {
    /* その方の幅に解ける形は列挙では解かない – その方は幅の規則が受ける。 */
    expect(幅の展開("8月上旬と下旬")).toEqual([]);

    expect(案内組("10日と下旬")).toEqual([]);
    expect(当たり列表("10日と下旬")).toEqual([]);
    expect(案内組("上旬と下旬")).toEqual([["上旬と下旬", "2026年8月1日または2026年8月21日"]]);

    expect(案内組("8月上旬と8月下旬")).toEqual([
      ["8月上旬と8月下旬", "2026年8月1日または2026年8月21日"],
    ]);
    expect(当たり列表("8月上旬").length, "品書に上旬の行がない").toBeGreaterThan(0);
    /* `と` を語に持つ打ち方は列挙ではない – 其侭の語として探す（その方の語の当たりは
     * そのまま – 割った語の和集合に化けない）。 */
    expect(案内組("人と機械")).toEqual([]);
    expect(当たり列表("人と機械")).toEqual([]);
    expect(和集合(["人", "機械"]).size, "品書に人・機械の語の行がない").toBeGreaterThan(0);
    expect(案内組("ひとと")).toEqual([]);
    expect(案内組("と")).toEqual([]);
  });
});

describe("それ以外の幅の形は無傷", () => {
  it("その方の助詞・記号で結んだ幅と数の幅は其侭通る", () => {
    expect(対称差("8月10日より8月20日", "8月10日から8月20日")).toBe(0);
    expect(対称差("8月10日〜8月20日", "8月10日から8月20日")).toBe(0);
    expect(対称差("明日から明後日", "明日〜明後日")).toBe(0);
    expect(当たり列表("明日から3日").length).toBeGreaterThan(0);
    expect(当たり列表("来週から2週間").length).toBeGreaterThan(0);
    expect(対称差("8月から11月", "2026年8月から2026年11月")).toBe(0);
    expect(当たり列表("8月").length).toBeGreaterThan(0);
  });
});

describe("成果物", () => {
  it("割らない決まりと列挙の枝が実測どおりに成果物に入っている", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/function 幅の語を割らないかJa\(/g) ?? []).toHaveLength(1);
    expect(物.match(/if \(幅の語を割らないかJa\(String\(token \|\| ""\)\)\)/g) ?? []).toHaveLength(
      1,
    );
    expect(物.match(/const 列挙 = 列挙の展開語Ja\(token, now\);/g) ?? []).toHaveLength(1);
    expect(物.match(/pairs\.push\(\[part, 列挙\.代表\.join\("または"\)\]\)/g) ?? []).toHaveLength(
      1,
    );
    /* その方の目印は `と` の列挙と句読点の列挙で共有するなので、出る回数は二つ。 */

    expect(物.match(/if \(!断片が皆決まるかJa\(断片\)\)/g) ?? []).toHaveLength(2);
  });
});
