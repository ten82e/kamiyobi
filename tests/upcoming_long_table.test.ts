/**
 * 縦に長い静的な一覧（`upcoming.html`）を読み通せるかの検査（SPEC §7・第 269 回）。
 *
 * 2026-08-09 生成ビルドで実測した形：
 *   - 本文 250 KB・`<tr>` 1,127 行・7 欄・月まとめの見出しは無し（1 枚の長い表）
 *   - 「締切の一覧に戻る」は文書全体で **1 個だけ**（先頭）。`</table>` のうしろには
 *     何も無く、最後の行まで読んだ人は約 50 画面ぶん上に戻らなければならなかった
 *   - スタイルシートに `sticky` は 1 度も無く、少しスクロールすると欄の名前が消える
 *     （800 行目の数字が「残り」なのか「会期」なのかが分からない）
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveCss, site } from "./built_golden_shared.ts";

function page(name: string): string {
  return readFileSync(join(site, name), "utf8");
}
function cssOf(name: string): string {
  return [...page(name).matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
}

/* 横に越えない幅の計算（正本はスタイルシートの中にある）。 */
const TABLE_MIN_WIDTH = 880;
const WRAP_PADDING_X = 24;
const WRAP_BORDER_X = 1;
const SCROLLBAR_ALLOWANCE = 17;
const NEEDED =
  TABLE_MIN_WIDTH + WRAP_PADDING_X * 2 + WRAP_BORDER_X * 2 + SCROLLBAR_ALLOWANCE; /* 947 */

describe("縦に長い静的な一覧（第 269 回）", () => {
  it("前提として縦に長い（出口が要る根拠）", () => {
    const up = page("upcoming.html");
    const rows = up.match(/<tr\b/g)?.length ?? 0;
    /* 行数は生成時刻で動く（固定時計の 2026-08-09 生成で 1,127 行、共有ハーネスの時計で
     * 592 行を実測）。ここでは「先頭の 1 個だけでは戻れないほど長い」と言える根拠として、
     * 画面の 1 画面ぶん（40 行）を大きく越えることを見る。 */
    expect(rows, "想定より短い表になっている（見直しの合図）").toBeGreaterThan(200);
    expect(up.match(/<th scope="col">/g)?.length, "欄の数が変わった").toBe(7);
  });

  it("終端に出口が有る（最後の行よりうしろに、先頭と画面へ戻る物を出す）", () => {
    const up = page("upcoming.html");
    const lastRow = up.lastIndexOf("</tr>");
    const top = up.indexOf('href="#top"');
    const back = up.indexOf('href="index.html"', lastRow);
    expect(top, "先頭に戻るリンクが無い").toBeGreaterThan(lastRow);
    expect(back, "画面に戻るリンクが終端に無い（`</table>` のうしろが空だった）").toBeGreaterThan(
      lastRow,
    );
    // 指す先が実在すること（噓のリンクを置かない）。
    const id = /<p id="top">/.exec(up);
    expect(id, "#top の受け手が無い（押しても動かないリンク）").toBeTruthy();
    expect(existsSync(join(site, "index.html")), "index.html がビルド先に無い").toBe(true);
  });

  it("入口と終端で同じ言い回しを使う（同じ語を 2 か所に持たない）", () => {
    const up = page("upcoming.html");
    const labels = [...up.matchAll(/<a href="index\.html">([^<]*)<\/a>/g)].map((m) => m[1]);
    expect(labels.length, "画面へ戻るリンクが 2 つではない").toBe(2);
    expect(labels[1], "終端の言い回しが入口とずれている").toBe(labels[0]);
    const tops = [...up.matchAll(/<a href="#top">([^<]*)<\/a>/g)].map((m) => m[1]);
    expect(tops.length, "先頭に戻るリンクが 2 つではない").toBe(1);
    expect(tops[0], "何をすのか言わないラベル").toContain("先頭");
  });

  it("少しスクロールしても欄の名前が残る（広い画面で見出しが粘る）", () => {
    const css = cssOf("upcoming.html");
    expect(effectiveCss(css, ".tablewrap thead th", "position", 1200), "見出しが粘らない").toBe(
      "sticky",
    );
    expect(effectiveCss(css, ".tablewrap thead th", "top", 1200)).toBe("0");
    // 狭い画面は行がカードになり見出し自体が消えるので、粘着を出さない。
    expect(effectiveCss(css, "thead", "display", 400)).toBe("none");
    expect(effectiveCss(css, ".tablewrap thead th", "position", 600)).not.toBe("sticky");
  });

  it("粘着させる幅は、横に越えない幅だけ（はみ出す幅ではスクロール面を残す）", () => {
    const css = cssOf("index.html");
    let first: number | null = null;
    for (let w = 700; w <= 1400; w += 1) {
      if (effectiveCss(css, ".tablewrap", "overflow-x", w) === "visible") {
        first = w;
        break;
      }
    }
    expect(first, "横スクロール面を戻す幅が見つからない").not.toBeNull();
    expect(
      first as number,
      `その幅では表がはみ出す（表 ${TABLE_MIN_WIDTH} + 余白 + 枠 + スクロールバー ${SCROLLBAR_ALLOWANCE} = ${NEEDED} 以上が要る）。ページ全体の横スクロールが起きる`,
    ).toBeGreaterThanOrEqual(NEEDED);
    expect(
      effectiveCss(css, ".tablewrap", "overflow-x", (first as number) - 1),
      "越える幅でスクロール面まで消えている（表の続きに辿れない）",
    ).toBe("auto");
  });

  it("半透明の見出し地には不透明な下地を敷く（粘着中に下を走る行が透けない）", () => {
    const css = cssOf("upcoming.html");
    const up = page("upcoming.html");
    // このページの列見出しは並び替えられない（`data-sort` 属性が来ない）ので、下の規則が
    // 当たる。本文に `data-sort` という語が現れるのはスタイルシートの中だけなので、
    // 見出しの形その物を見て区別する（スタイルシートには語が出る）。
    const thead = /<thead>[\s\S]*?<\/thead>/.exec(up);
    expect(thead, "列見出しの塊が無い").toBeTruthy();
    expect(thead![0].includes("data-sort"), "静的な一覧の見出しが並び替えを持つ想定になった").toBe(
      false,
    );
    expect(
      effectiveCss(css, ".tablewrap thead th:not([data-sort])", "background-color", 1200),
      "粘着中の見出しに不透明な下地が無い（行の文字が透ける）",
    ).toBe("var(--panel)");
  });

  it("画面（index.html）の表にも同じ規則が効いている（規則を 2 か所に書かない）", () => {
    const css = cssOf("index.html");
    expect(effectiveCss(css, ".tablewrap thead th", "position", 1200), "画面だけ粘らない").toBe(
      "sticky",
    );
    // 画面の列見出しは不透明な地を既に持つので、下地の上書きで見た目を壊さない。
    expect(
      effectiveCss(css, ".tablewrap thead th:not([data-sort])", "background-color", 1200),
    ).toBe("var(--panel)");
    expect(effectiveCss(css, "th", "background", 1200), "並び替えられる列の地が消えた").toContain(
      "var(--chip)",
    );
  });

  it("紙には粘着を混ぜない（印刷では見出しが繰り返される）", () => {
    const css = cssOf("index.html");
    const print = /@media print\s*\{[\s\S]*?\n\}/.exec(css)?.[0] ?? "";
    expect(print, "印刷用の規則が見つからない").not.toBe("");
    expect(print, "印刷に粘着を混ぜている（用紙ごとにずれる）。").not.toContain("sticky");
  });
});
