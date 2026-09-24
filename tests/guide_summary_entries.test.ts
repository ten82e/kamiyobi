/**
 * 「見方のてびき」の入口（`<summary>`）が約束する語を、中に実際に項目として見つける検査
 * （SPEC §7・第 277 回）。
 *
 * 2026-08-09 生成ビルドで実測した形:
 *   - 入口の文字は「見方のてびき（「推定」「未確認」「該当なし」の意味・過去の締切の見方・
 *     CSV と印刷）」。この 3 つのうち「推定」「未確認」には項目（`<dt>`）が有るのに、
 *     **「該当なし」の項目は 0 個** だった。意味は「会期のみ・締切未定」の項目の末尾に
 *     1 文混じっているだけで、37 項目を流し読みしないと辿り着けない。
 *   - 「該当なし」は常時受付の期刊行の会期・開催地列に実際に出る語なので、画面でその語を
 *     見た人が説明に辿れる形にした（入口が名乗る語は必ず自分の項目を持つ、という約束にまとめる）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";

const strip = (src: string): string => src.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/* `site` はハーネスが `beforeAll` で埋めるので、読むのは検査の中から（モジュール評価時に
 * 読むと undefined で空振りする – 2026-09-24 に実発生）。 */
function page(): string {
  return readFileSync(join(site, "index.html"), "utf8");
}

/** てびき（`#helpPanel`）の内側だけを切り出す。 */
function guide(): string {
  const html = page();
  const at = html.indexOf('id="helpPanel"');
  expect(at, "てびきの欄が無い").toBeGreaterThan(0);
  const end = html.indexOf("</details>", at);
  expect(end, "てびきが閉じていない").toBeGreaterThan(at);
  return html.slice(at, end);
}

function items(g: string): string[] {
  return [...g.matchAll(/<dt>([\s\S]*?)<\/dt>/g)].map((m) => strip(m[1]).trim());
}

describe("見方のてびきの入口と中身が食い違っていない（第 277 回）", () => {
  it("入口が名乗る語は、中に自分の項目を持っている", () => {
    /* 入口の文字は、てびきを閉じた状態で目に見える唯一の説明。そこで名乗っているのに
     * 中に項目が無い語があると、開いた人は 37 項目を流し読みするしかない
     * （2026-08-09 生成ビルドで実測: 「該当なし」を名乗っていて項目は 0 個）。 */
    const g = guide();
    const summary = strip(/<summary>([\s\S]*?)<\/summary>/.exec(g)![1]);
    const named = [...summary.matchAll(/「([^」]+)」/g)].map((m) => m[1]);
    expect(named.length, "入口が何も名乗っていない（空振り検査の防止）").toBeGreaterThanOrEqual(3);
    const own = items(g);
    for (const term of named) {
      expect(own, `入口が名乗る「${term}」の項目がてびきに無い`).toContain(term);
    }
  });

  it("「該当なし」を「未確認」と別の意味だと、その項目で説明している", () => {
    const g = guide();
    const m = /<dt>該当なし<\/dt>\s*<dd>([\s\S]*?)<\/dd>/.exec(g);
    expect(m, "「該当なし」の項目が無い").toBeTruthy();
    const dd = strip(m![1]);
    expect(dd, "常時受付の期刊行だと書いていない").toContain("常時受付");
    // 「未確認」という語が一度出ていれば良い、では足りない – その項目の中で
    // 「 kamiyobi が裏取りできていないだけ」という向こう側の意味に触れていなければ、
    // 読み手は 2 つの語の向きを確定できない（第 277 回の改ざんで実発生）。
    expect(dd, "「未確認」が何を意味するのか書いていない").toMatch(/ kamiyobi .*裏/);
    expect(dd, "別の意味だと区別していない").toMatch(/別/);
    // 画面でその語を見た人が実際に引けることも書く（実測で確かめた事実だけを書く）。
    expect(dd, "検索で引けることを書いていない").toContain("検索");
  });

  it("同じ説明文を 2 か所に書き写していない", () => {
    // 移動した文が残ったままだと、同じ説明が 2 個並んで「どちらが本当か」分からなくなる。
    const sentence = "ジャーナルには会期も会場も無い";
    expect(page().split(sentence).length - 1, "説明文が書き写されている").toBe(1);
  });

  it("てびきの項目が重複しておらず、空の項目が無い", () => {
    const own = items(guide());
    expect(own.length, "項目が少なすぎる（組み立てが壊れた）").toBeGreaterThanOrEqual(36);
    expect(
      own.filter((t) => !t),
      "空の項目がある",
    ).toEqual([]);
    expect(
      own.filter((t, i) => own.indexOf(t) !== i),
      "同じ名前の項目が 2 つある",
    ).toEqual([]);
  });
});
