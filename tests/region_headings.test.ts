/**
 * 画面の領域が見出しとランドマークで飛べるかの検査（SPEC §7・第 274 回）。
 *
 * 2026-08-09 生成ビルドで実測した形：
 *   - 静的な HTML の見出しは `h1 kamiyobi 投稿締切` と、実行時に埋まるドロワーの `h2` の
 *     **2 つだけ**だった。支援技術は見出しとランドマークで画面を飛ぶので、VoiceOver の
 *     ローターや NVDA の見出し一覧を開いても、この画面には移動先が 1 件しか並ばない。
 *   - `<main>` より前に Tab で止まる物は **44 個**有り、「締切の一覧へ進む」で跳んだ先が
 *     何なのか、跳んだ本人にも名乗りが無かった（表の `caption` は見出し一覧に出ない）。
 *   - 推薦モードの欄は 4 つの入力欄と見本のボタンが並ぶだけで、塊としての名前が無かった。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { japaneseStringLiterals, site } from "./built_golden_shared.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

function page(name: string): string {
  return readFileSync(join(site, name), "utf8");
}

/** 静的な HTML の見出し（style / script を落とした本体から）。 */
function headings(html: string): { level: number; text: string; attrs: string }[] {
  const body = html.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, "");
  return [...body.matchAll(/<(h[1-6])\b([^>]*)>([\s\S]*?)<\/\1>/g)].map((m) => ({
    level: Number(m[1].slice(1)),
    text: m[3]
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
    attrs: m[2],
  }));
}

describe("画面の領域が見出しで飛べる（第 274 回）", () => {
  it("見出し一覧に、結果欄と論文の入力の塊が並ぶ", () => {
    const hs = headings(page("index.html"));
    const words = hs.map((h) => h.text);
    expect(words, "跳んだ先と論文の入力が、見出し一覧に無い").toEqual(
      expect.arrayContaining(["締切の一覧", "論文の入力"]),
    );
    // h1 を 1 個に保つ（支援技術は h1 をページの顔として読む）。
    expect(hs.filter((h) => h.level === 1)).toHaveLength(1);
  });

  it("見出しは画面の見た目を変えない（紙にも出ない）", () => {
    const html = page("index.html");
    const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
    const hiddenRule = /\.only-sr\s*\{[^}]*\}/;
    expect(css, "画面に出さないための規則が無い").toMatch(hiddenRule);
    expect(hiddenRule.exec(css)?.[0]).toMatch(/clip-path|position:\s*absolute/);
    // 印刷 CSS がsr-only を元に戻すと、紙に「締切の一覧」が並ぶ（紙の見出しは別に出している）。
    const print = css.match(/@media print \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(print, "印刷で画面に出ない見出しを復活させている").not.toMatch(/only-sr|sr-label/);
    /* 規則が生きているだけでは足りず、見出しがそのクラスを着ている必要がある
     * （クラスを外す改ざんが通った – 第 274 回の実発生）。 */
    const named = headings(html).filter((h) => h.text === "締切の一覧" || h.text === "論文の入力");
    expect(named, "名乗りの見出しが並んでいない").toHaveLength(2);
    for (const h of named) {
      expect(h.attrs, `見出し「${h.text}」が画面に出てしまう`).toContain("only-sr");
    }
  });

  it("見出しの語は、画面がよそで既に使っている語だけ", () => {
    const html = page("index.html");
    for (const h of headings(html)) {
      if (!h.text) continue; // ドロワーの見出しは実行時に埋まる（次の検査で見る）。
      // 見出しを構成する語が本文のよそにも出ていれば、画面自身の語で名乗っていることに
      // なる（見出しは組み立てなので、そのままの文字列が HTML に無いことがある）。
      for (const word of h.text.split(/\s+/).filter((w) => w.length >= 2)) {
        const uses = (html.match(new RegExp(word, "g")) || []).length;
        expect(
          uses,
          `見出し「${h.text}」の語「${word}」が他所で使われていない（作った語の可能性）`,
        ).toBeGreaterThan(1);
      }
    }
    // 逆方向: 画面に無い語（英語の "Filter" など）を見出しにしておかない。
    // h1 だけはサイト自身の名前（kamiyobi）なので除く。
    for (const h of headings(html)) {
      if (!h.text || h.level === 1) continue;
      expect(h.text, `見出し「${h.text}」に英文字が混じっている`).not.toMatch(/[A-Za-z]{4,}/);
    }
  });

  it("aria-labelledby は実在する見出しを指す（宙に浮いた参照にしない）", () => {
    const body = page("index.html").replace(
      /<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g,
      "",
    );
    const refs = [...body.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThanOrEqual(3); // 結果欄・論文の入力・ドロワー。
    for (const ref of refs) {
      const holder = new RegExp(`<(\\w+)\\b[^>]*id="${ref}"[^>]*>`).exec(body);
      expect(holder, `aria-labelledby が指す id="${ref}" が無い`).not.toBeNull();
      // ドロワーの見出しだけ h2 で、他も見出しである（名前を付ける先が見出しでないと
      // 見出し一覧から飛べない）。
      expect(holder?.[1], `id="${ref}" の主役が見出しでない`).toBe("h2");
    }
  });

  it("スキップリンクの跳んだ先が、自分を名乗る", () => {
    const body = page("index.html").replace(
      /<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g,
      "",
    );
    const skip = /<a class="skip-link" href="#([^"]+)">([^<]*)<\/a>/.exec(body);
    expect(skip, "スキップリンクその物が無い").not.toBeNull();
    expect(skip?.[2], "スキップリンクが何処へ行くかを書いていない").toContain("締切の一覧");
    const main = new RegExp(`<main\\b[^>]*id="${skip?.[1]}"[^>]*>([\\s\\S]{0,600})`).exec(body);
    expect(main, `スキップリンクの到達先 #${skip?.[1]} が main で無い`).not.toBeNull();
    expect(main?.[1], "跳んだ先に名乗り（見出し）が無い").toMatch(
      /<h2\b[^>]*>\s*締切の一覧\s*<\/h2>/,
    );
  });

  it("静的な HTML に空の見出しを残さない（実行時に埋まる物だけ）", () => {
    const html = page("index.html");
    const empties = headings(html).filter((h) => !h.text);
    expect(empties.map((h) => h.attrs)).toEqual([expect.stringContaining("drawerTitle")]);
    const rt = siteRuntime("app.js");
    expect(rt, "ドロワーの見出しを埋める箇所が無く、空の見出しが画面に出る").toMatch(
      /\$\("drawerTitle"\)[\s\S]{0,80}textContent/,
    );
  });

  it("推薦の候補は見出し（h3）を持つので、候補その物にも飛べる", () => {
    const rt = siteRuntime("app.js");
    const body = jsFunction(rt, "makeRecommendationCard");
    expect(body, "候補のカードに見出しの組み立てが無い").toContain('createElement("h3")');
    // 見出しの中身は会議名（`japaneseStringLiterals` は日本語の文字列だけ拾うので、
    // ここは組み立ての形を見ている）。
    expect(body).toContain("titleWithYear");
    expect(japaneseStringLiterals(rt).length).toBeGreaterThan(0);
  });
});
