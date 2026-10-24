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
  return Recommender.candidateRows(catalog) as unknown as Array<{
    hay: string;
  }>;
}

function 当たり列表(語: string): string[] {
  const 当 = Recommender.searchMatcher(語, 基準);
  return 品書()
    .filter((行) => 当(String(行.hay)) === true)
    .map((行) => String(行.hay))
    .sort();
}

function 対称差(a: string[], b: string[]): number {
  const 左 = new Set(a);
  const 右 = new Set(b);
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}

function 範囲の案内(語: string): string {
  return (Recommender.relativeDayNotes(語, 基準) as string[]).map((文) => String(文)).join(" / ");
}

/** その月の週と、その日付の幅をそのまま打った形が同じ行列表を出す事を張る。 */
function 同じ行列表か(週: string, 幅: string) {
  const 正 = 当たり列表(幅);
  expect(正.length, `品書に其の幅の行が無い: ${幅}`).toBeGreaterThan(0);
  expect(対称差(当たり列表(週), 正), `当たり列表が違う: ${週}`).toBe(0);
}

describe("月の中之週", () => {
  it("週の打ち方はその日付の幅と同じ行だけ出す", () => {
    同じ行列表か("8月第1週", "2026年8月1日から2026年8月7日");
    同じ行列表か("8月第2週", "2026年8月8日から2026年8月14日");
    同じ行列表か("8月第3週", "2026年8月15日から2026年8月21日");
    同じ行列表か("8月第4週", "2026年8月22日から2026年8月28日");
    同じ行列表か("8月第5週", "2026年8月29日から2026年8月31日");
    同じ行列表か("9月第2週", "2026年9月8日から2026年9月14日");
    同じ行列表か("来月第1週", "2026年9月1日から2026年9月7日");
  });

  it("漢数字・冠のない形・離して打った形も同じ行列表を通す", () => {
    const 正 = 当たり列表("8月第2週");
    expect(正.length, "品書に8月第2週の行がない").toBeGreaterThan(0);
    for (const 語 of ["第二週", "第2週", "8月 第2週"]) {
      expect(対称差(当たり列表(語), 正), `当たり列表が違う: ${語}`).toBe(0);
    }
  });

  it("範囲と分け方の決まりを画面に書く（自分の決めた分け方を黙って使わない）", () => {
    const 文 = 範囲の案内("8月第2週");
    expect(文).toContain("2026年8月8日");
    expect(文).toContain("2026年8月14日");
    expect(文, "分け方の決まりを書いていない").toContain("月はじめから 7 日ずつ");
    /* 第5週は月末まで – その月の末日より先を幅にしない。 */
    const 五週 = 範囲の案内("8月第5週");
    expect(五週).toContain("2026年8月31日");
    expect(五週, "月末までの話を書いていない").toContain("第5週は月末まで");
    expect(範囲の案内("9月第3週")).toContain("2026年9月15日");
  });

  it("作らない幅 – 第6週以上・第0週・その月に在らない週・日数と混じる裸の週", () => {
    for (const 語 of ["第6週", "第0週", "2月第5週", "2027年2月第5週"]) {
      expect(当たり列表(語), `幅を作ってしまった: ${語}`).toEqual([]);
      expect(範囲の案内(語), `幅を作った案内が出た: ${語}`).toBe("");
    }
    /* 冠の無い数だけの週は日数の話と混じるので受けない（`3週間` はその方の形で受けている）。 */
    for (const 語 of ["1週", "3週間", "2週"]) {
      expect(範囲の案内(語), `幅の決まりを混じた: ${語}`).not.toContain("7 日ずつ");
    }
    /* その月にある週は解ける（28 日の月の第4週 – 22〜28 日）。 */
    expect(範囲の案内("2月第4週")).toContain("2月22日");
  });

  it("上旬・中旬・下旬とそれ以外の相対的な日付の語は無傷", () => {
    for (const 語 of ["8月上旬", "8月中旬", "8月下旬", "下旬", "来月下旬"]) {
      expect(当たり列表(語).length, `当たりが消えた: ${語}`).toBeGreaterThan(0);
    }
    /* 上旬の分け方は変えて居ない（1〜10 日 – 第 344 回で『前半』を寄せない判断と同じ系列）。 */
    const 上旬 = 範囲の案内("8月上旬");
    expect(上旬).toContain("2026年8月1日");
    expect(上旬).toContain("2026年8月10日");
    expect(上旬, "上旬に週の決まりを混じた").not.toContain("7 日ずつ");
    for (const 語 of ["今週", "来週", "再来週", "第1ラウンド", "第一ラウンド"]) {
      expect(当たり列表(語).length, `当たりが消えた: ${語}`).toBeGreaterThan(0);
      expect(範囲の案内(語), `案内を混じた: ${語}`).not.toContain("7 日ずつ");
    }
  });

  it("週の解き方が成果物に入っている（正規表現を二箇所に書いていない）", () => {
    const 成果物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    /* 関数の宣言と使用の二箇所 – 分け方の数え方を別の場所に書き写して居ない事の張る。 */
    expect(成果物.split("週の範囲Ja").length - 1).toBe(2);

    expect(成果物.split("週的形状Ja").length - 1).toBe(3);
    /* 分け方の説明は案内の文の二つ（第5週用とその方の週用）とソースの注の一つ – 実測 3 回。 */
    expect(成果物.split("月はじめから 7 日ずつ").length - 1).toBe(2);

    expect(成果物.split("打 < 1 || 打 > 5").length - 1).toBe(1);
    /* 『第』の無い形の打ち込まれ方（『1週』）は日数の話と混じるので受けない – 頭が『第』で
     * 始まる形しか見ない事を張る（その無い形を通すには二箇所を緩める必要がある – 改ざん検査）。 */
    expect(成果物.split("/^第([").length - 1).toBe(1);

    expect(成果物.split("週の目の言い方").length - 1).toBe(2);
    expect(成果物.split("目の週の数Ja < 1 || 目の週の数Ja > 5").length - 1).toBe(1);
  });
});
