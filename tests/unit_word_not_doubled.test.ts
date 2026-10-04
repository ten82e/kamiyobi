/**
 * 配信する文章の中で、**同じ時間単位を同じ括弧の中に二度書かない**検査（SPEC §7・第 283 回）。
 *
 * `upcoming.md` と `upcoming.html` の先頭には「いつの時点の表か」を書く。ここが
 * `生成時刻: 2026-08-09T00:00:00Z（JST では 2026-08-09(日) 09:00 JST）` となっていて、
 * 単位（JST）が同じ括弧の中に二度出ていた（2026-09-24 実測）。JST 壁時計を作る関数が
 * 単位を必ず文末に付けるためで、文の中で既に「JST では」と書いてある場所と重なった。
 * 表示その物は正しいが、締切の時刻を扱う表の頭文が言い直しになっているのは読みにくい。
 *
 * 見ているのは 2 点。
 *   1. 括弧の中に同じ単位（JST・UTC・AoE）が二度入っていない
 *   2. 生成時刻の行は「（JST では <壁時計>）」の形で、中身に単位が混ざっていない
 * 見張り自体が空振りしないよう、括弧の数と JST を含む括弧の数を先に確かめる。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";

/** 画面に出る文章だけを残す（script と style を落とし、タグと文字参照を退ける）。 */
function visibleText(name: string): string {
  const raw = readFileSync(join(site, name), "utf8");
  if (!name.endsWith(".html")) return raw;
  const body = raw
    .replace(/<script\b[\s\S]*?<\/script>/g, " ")
    .replace(/<style\b[\s\S]*?<\/style>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  return body
    .replace(/<[^>]*>/g, " ")
    .replace(/&larr;/g, "←")
    .replace(/&rarr;/g, "→")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

const UNITS = ["JST", "UTC", "AoE"];
const PAGES = ["index.html", "upcoming.html", "upcoming.md", "llms.txt", "health.md"];

describe("同じ括弧の中に時間単位を二度書かない", () => {
  for (const page of PAGES) {
    it(`${page} に、単位が重複した括弧が無い`, () => {
      const text = visibleText(page);
      const parens = [...text.matchAll(/（[^（）]*?）/g)].map((m) => m[0]);
      /* 空振りの防止: 括弧が全く無ければこの検査は何も見ていない。JST を括弧に書くか
       * はページごとに違う（`health.md` には 0 個 – 2026-09-24 実測）ので、まとめた数は
       * 別の検査で見る。 */
      expect(parens.length, `${page} に括弧が少ない（検査が空振りになる）`).toBeGreaterThanOrEqual(
        20,
      );
      const doubled = parens.filter((p) => UNITS.some((u) => p.split(u).length - 1 >= 2));
      expect(
        doubled.slice(0, 3).map((p) => p.replace(/\s+/g, " ").slice(0, 90)),
        `同じ単位が二度入った括弧がある（${doubled.length} 箇所）`,
      ).toEqual([]);
    });
  }

  it("JST を書く括弧が、全体で実際に調べられるだけ有る", () => {
    /* 上の検査は「重複が有るか」だけを見るので、そもそも JST を括弧に書く文章が
     * 一箇所も無いなら空事で通る。件数を見ておく。 */
    const all = PAGES.flatMap((page) => [...visibleText(page).matchAll(/（[^（）]*?）/g)]).map(
      (m) => m[0],
    );
    const withJst = all.filter((p) => p.includes("JST"));
    expect(
      withJst.length,
      "JST を含む括弧が少なすぎる（上の検査が空振りになる）",
    ).toBeGreaterThanOrEqual(10);
  });

  it("生成時刻の行は、単位を括弧の外に一度だけ書く", () => {
    const FORM =
      /生成時刻: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z（JST では \d{4}-\d{2}-\d{2}\([月火水木金土日]\) \d{2}:\d{2}）/;
    for (const page of ["upcoming.md", "upcoming.html"]) {
      const text = visibleText(page);
      expect(text.replace(/\s+/g, " "), `${page} に生成時刻の行が有る`).toMatch(FORM);
      // 言い直し（中に単位が混ざる形）が戻っていないこと。
      expect(
        /（JST では[^（）]*JST[^（）]*）/.test(text),
        `${page} の生成時刻の括弧の中に単位が混ざっている`,
      ).toBe(false);
    }
  });

  it("JST 壁時計をそのまま使うと、検査が落ちる（見張りが生きている）", () => {
    /* 直前まで出ていた形を実際に作って、上の規則がそれを弾くことを確かめる
     * （正しくない形が通るなら、この見張りは空振り – §8 の約束）。 */
    const broken = "生成時刻: 2026-08-09T00:00:00Z（JST では 2026-08-09(日) 09:00 JST）";
    const parens = [...broken.matchAll(/（[^（）]*?）/g)].map((m) => m[0]);
    expect(parens.filter((p) => p.split("JST").length - 1 >= 2).length).toBe(1);
    expect(/（JST では[^（）]*JST[^（）]*）/.test(broken)).toBe(true);
    // 正しい形は、上の 2 規則を両方通る。
    const fixed = "生成時刻: 2026-08-09T00:00:00Z（JST では 2026-08-09(日) 09:00）";
    const fixedParens = [...fixed.matchAll(/（[^（）]*?）/g)].map((m) => m[0]);
    expect(fixedParens.filter((p) => p.split("JST").length - 1 >= 2).length).toBe(0);
    expect(/（JST では[^（）]*JST[^（）]*）/.test(fixed)).toBe(false);
  });
});
