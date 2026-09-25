/**
 * 締切の回の漢数字と概要の言い方（第 386 回）。実測（2026-09-25 – 2026-08-09 生成の実ビルドの
 * 品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * - 算用数字の `第1ラウンド` 767 行・`第2ラウンド` 71 行・`第3ラウンド` 15 行・`第4ラウンド`
 *   3 行が通るのに、漢数字の `第一ラウンド` `第二ラウンド` `第三ラウンド` `第四ラウンド` は
 *   **0 行で案内も無し**だった（全角数字の `第１ラウンド` は 767 行通る – 同じ表記のゆらぎなのに
 *   漢数字だけ落ちて居た）。日付の漢数字の規則は語頭（年・月・日・週）しか見ないので、『第』込みの
 *   締切の回の表記が届いて居なかつた。
 * - `抄録` `要旨` `アブストラクト` は 146 行通るのに `サマリ` `サマリペーパー` は 0 行だった。
 * - 諦めた物も測つた – `ポスター論文`（`ポスター` 6 行・`ポスター 論文` 1 行が通るのに繋げて打つと
 *   0 行）は、上の表へ寄せても**寄せた後も 0 行の侭**だつた（実測 – 印を見る道は打ち方が単独か
 *   空格で割れた形の時だけ通る）。語の足し方では直せないので、其の事を代码の注に書いて置く。
 */

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

function 語の組(語: string): string[][] {
  return (
    Recommender as unknown as {
      queryTokenGroups: (q: unknown, now?: number) => string[][];
    }
  ).queryTokenGroups(語, 基準);
}

const 回の言い方: Array<[string, string]> = [
  ["第一ラウンド", "第1ラウンド"],
  ["第二ラウンド", "第2ラウンド"],
  ["第三ラウンド", "第3ラウンド"],
  ["第四ラウンド", "第4ラウンド"],
  ["第五ラウンド", "第5ラウンド"],
  ["第十ラウンド", "第10ラウンド"],
  ["第十一ラウンド", "第11ラウンド"],
];

describe("締切の回の漢数字", () => {
  it("漢数字で打っても算用数字と一字も違わない行列表を通す", () => {
    const 正 = 当たり列表("第1ラウンド");
    expect(正.length, "品書に締切の回の行が無い").toBeGreaterThan(0);
    for (const [漢, 算] of 回の言い方) {
      expect(語の組(漢), `語の組が違う: ${漢}`).toEqual(語の組(算));
      expect(対称差(当たり列表(漢), 当たり列表(算)), `当たり列表が違う: ${漢}`).toBe(0);
    }
    expect(当たり列表("第二ラウンド").length, "第二ラウンドが空").toBeGreaterThan(0);
  });

  it("『ラウンド』を二重に付けない（直しで実際に化けた形 – 検査が張る）", () => {
    for (const [漢] of 回の言い方) {
      for (const 組 of 語の組(漢)) {
        for (const 語 of 組) {
          expect(語, `語が化けている: ${語}`).not.toContain("ラウンドラウンド");
        }
      }
    }
  });

  it("他の漢数字の表記を変えない（日付の規則と『回』の条目は無傷）", () => {
    expect(当たり列表("第一回").length, "『第一回』の当たりが消えた").toBeGreaterThan(0);
    expect(語の組("十二月")).toEqual(語の組("12月"));
    expect(語の組("第1ラウンド")).toEqual(語の組("第1ラウンド"));
    expect(対称差(当たり列表("十二月"), 当たり列表("12月"))).toBe(0);
    /* 数字だけで打った形は従来通り（実ビルドでは『1ラウンド』769 行が『第1ラウンド』767 行より
     * 多い – 数字だけだと『第11ラウンド』も拾う為 – 実測）。品書の行の多い少ないに左右されない
     * 様に、減つて居ない事と語の組に『第』を足して居ない事で張る。 */
    expect(当たり列表("1ラウンド").length).toBeGreaterThanOrEqual(当たり列表("第1ラウンド").length);
    for (const 組 of 語の組("1ラウンド")) {
      expect(組, "『1ラウンド』に『第』を足した").not.toContain("第1ラウンド");
    }
  });
});

describe("概要の言い方", () => {
  it("サマリと打っても概要締切の行を其侭通す", () => {
    const 正 = 当たり列表("抄録");
    expect(正.length, "品書に概要締切の行が無い").toBeGreaterThan(0);
    for (const 語 of ["サマリ", "サマリペーパー"]) {
      expect(対称差(当たり列表(語), 正), `当たり列表が違う: ${語}`).toBe(0);
      expect(Recommender.querySynonymNotes(語).join("・"), `寄せの案内が無い: ${語}`).toContain(
        "概要締切",
      );
    }
  });

  it("収録に無い論文の種類の言い方を在る物に寄せない", () => {
    /* `ポスター論文` は寄せ先と同じ行にならない（実測 – 印を見る道は単独か空格で割れた形のみ）。
     * 寄せた事にして意味を広げない為、寄せて居ない事をここに張る。 */
    for (const 語 of ["ポスター論文", "レジメ", "レター", "一般発表"]) {
      expect(当たり列表(語), `当たりが出てしまった: ${語}`).toEqual([]);
      expect(Recommender.querySynonymNotes(語), `在る物へ寄せた: ${語}`).toEqual([]);
    }
    /* 打てる道は在る（実測 – `ポスター` 6 行・`ポスター 論文` は交差で 1 行）。 */
    expect(当たり列表("ポスター").length).toBeGreaterThan(0);
    expect(当たり列表("ポスター 論文").length, "空格で割った形が通ら無い").toBeLessThanOrEqual(
      当たり列表("ポスター").length,
    );
  });

  it("足した条目と正規化が成果物に一度だけ入っている", () => {
    const 成果物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const 語 of ["サマリ", "サマリペーパー"]) {
      expect(成果物.split(`["${語}", "種別「概要締切」"`).length - 1, `条目の数が違う: ${語}`).toBe(
        1,
      );
    }
    expect(成果物.split("回の漢数字").length - 1).toBeGreaterThan(0);
    /* 引っ込めた寄せが復活していない事（其の寄せを足すと案内だけが出て 0 行の侭になる –
     * 実測で確認済み）。注に語を書いているので、条目の形その物で張る。 */
    expect(
      成果物.split('["ポスター論文", "口頭発表以外の形の印「ポスター」"]').length - 1,
      "引っ込めた寄せが復活して居る",
    ).toBe(0);
  });
});
