/**
 * 「見方のてびき」が見出しで群れているかの検査（SPEC §7・第 285 回）。
 *
 * てびきは締切一覧の語 39 個をその場で説明する欄だが、**見出しが 1 個も無く**、
 * 39 語が 1 個の `<dl>` に並んでいた（2026-09-24 実測: 画面の静的な見出しは `h1` 1 個と
 * `h2` 2 個だけで、てびきを開いても見出し一覧には何も増えない）。見出し辿りや
 * 「見出しだけを読む」操作では、てびきはひと塊の文章にしか見えない。
 *
 * 直し方は **語の並びと説明文を動かさず**、連なりの先頭に `<h3>` を置いて `<dl>` を
 * 割っただけ。だから検査の中心は「本文が一字も減っていないこと」になる。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssBlocks, site } from "./built_golden_shared.ts";

function page(name: string): string {
  return readFileSync(join(site, name), "utf8");
}

/** 正本（`site/template.html`）のてびきの塊。ビルド後と比べるためにも読む。 */
function guideOf(src: string): string {
  const at = src.indexOf('<details class="help"');
  expect(at, "てびき（`details.help`）が見当たらない").toBeGreaterThan(-1);
  const close = src.indexOf("</details>", at);
  return src.slice(at, close);
}

/** 見出しと群れの入れ物だけを退けた本文（語と説明の全文）。 */
function bodyText(guide: string): string {
  const t = guide.replace(/<h3>[\s\S]*?<\/h3>/g, "").replace(/<\/?(dl|div)\b[^>]*>/g, "");
  return t.replace(/\s+/g, " ").trim();
}

/** 見出しごとに、その集団に属す語を並べた物。 */
function groups(guide: string): Array<{ title: string; terms: string[] }> {
  const out: Array<{ title: string; terms: string[] }> = [];
  let current: { title: string; terms: string[] } | null = null;
  for (const m of guide.matchAll(/<h3>([\s\S]*?)<\/h3>|<dt[^>]*>([\s\S]*?)<\/dt>/g)) {
    if (m[1] !== undefined) {
      current = { title: m[1].replace(/<[^>]*>/g, "").trim(), terms: [] };
      out.push(current);
    } else if (current) {
      current.terms.push(m[2].replace(/<[^>]*>/g, "").trim());
    }
  }
  return out;
}

describe("てびきが見出しで群れている", () => {
  it("語と説明の本文が、割る前後で一字も減っていない", () => {
    /* 見出しを入れる作業でいちばん怖いのは、説明を切り貼して減らす事。
     * 正本（組み立て元）とビルド後の画面の両方を読み、同じ本文であることを確かめる。 */
    const built = bodyText(guideOf(page("index.html")));
    const source = bodyText(guideOf(readFileSync("site/template.html", "utf8")));
    expect(built.length, "ビルド後のてびきの本文が空").toBeGreaterThan(20_000);
    expect(built, "正本と画面でてびきの本文が違う（説明が減ったかも）").toBe(source);
  });

  it("語が 1 個も見出しの外に置き去りになっていない", () => {
    const built = groups(guideOf(page("index.html")));
    expect(built.length, "見出しの数が足りない").toBeGreaterThanOrEqual(6);
    const lonely = built.filter((g) => g.terms.length < 2);
    expect(
      lonely.map((g) => g.title),
      "語が 1 個だけの集団がある（見出しを増やしすぎ）",
    ).toEqual([]);
    const huge = built.filter((g) => g.terms.length > 8);
    expect(
      huge.map((g) => `${g.title}: ${String(g.terms.length)} 語`),
      "集団が大きすぎて壁になっている",
    ).toEqual([]);
    // 語の総数（見出しに吸い取られて減っていない）。第 308 回で「データの健全性
    // （health.md）」を 1 語足したので 40 – てびきに語を足す変更はこの数を巻き込む。
    // 第 619 回 – 一覧の下に『全データ（JSON）』の出口を足したので、てびきにも同じ語を
    // 載せる（物を足したらてびきも直す – 第 267 回）。41 語。
    const total = built.reduce((acc, g) => acc + g.terms.length, 0);
    expect(total, "てびきの語の数が増減した（てびきの項目を足す時はここも直す）").toBe(41);
    for (const g of built) {
      expect(g.terms.length, `「${g.title}」に語が有らない`).toBeGreaterThan(0);
      for (const t of g.terms) {
        expect(t, `「${g.title}」に空の語が混ざった`).not.toBe("");
      }
    }
  });

  it("見出しは、ページに既に有る語だけを使って書かれている", () => {
    /* 画面のよそで使っていない語だけの見出しを増やすと、用語集の語と見出しが
     * 二重になって検索・読み上げで紛れる。見出しの語が本文に現れることを確かめる。 */
    const guide = guideOf(page("index.html"));
    const body = bodyText(guide);
    for (const g of groups(guide)) {
      expect(g.title, "空の見出し").not.toBe("");
      expect(g.title, `見出しに英文字の塊が残っている: ${g.title}`).not.toMatch(/[A-Za-z]{4,}/);
      const words = g.title
        .split(/[\s・]+/)
        .map((w) => w.trim())
        .filter((w) => w.length >= 2);
      expect(
        words.length,
        `見出し「${g.title}」から語を取り出せない（空振り防止）`,
      ).toBeGreaterThan(0);
      for (const w of words) {
        expect(body.includes(w), `見出しの語「${w}」が本文に一度も出てこない: ${g.title}`).toBe(
          true,
        );
      }
    }
  });

  it("見出しの階段が飛んでいない（てびきの中だけ段が上がる）", () => {
    const html = page("index.html");
    const statics = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({
      level: Number(m[1]),
      text: m[2].replace(/<[^>]*>/g, "").trim(),
    }));
    const h1 = statics.filter((h) => h.level === 1);
    expect(h1.length, `h1 が ${String(h1.length)} 個有る`).toBe(1);
    expect(
      statics.some((h) => h.level === 2),
      "h2 が無い",
    ).toBe(true);
    // 静的な画面に h4 以降は無い（てびきの見出しは h3 まで）。
    expect(
      statics.filter((h) => h.level >= 4).map((h) => `h${String(h.level)}: ${h.text}`),
      "段が飛んでいる見出しがある",
    ).toEqual([]);
    // てびきの h3 は、てびきの外に漏れていない（画面の h3 = てびきの h3）。
    const h3 = statics.filter((h) => h.level === 3);
    expect(h3.length, "静的な画面の h3 が消えた").toBeGreaterThan(5);
    expect(h3.length, "てびきの外に h3 が混ざった").toBe(groups(guideOf(html)).length);
    // 支援技術には閉じたてびきの見出しが見えないので、閉じた時に消える事も確かめる。
    const help = /@media print[\s\S]*?\n\}/.exec(html)?.[0] ?? "";
    expect(
      help.length,
      "印刷用の規則が見つからない（てびきの印刷での扱いを見直す）",
    ).toBeGreaterThan(0);
  });

  it("見出しが語と区別できる見た目になっている", () => {
    /* 規則が無いとブラウザ既定に任せる事になり、てびきの字の大きさ（0.83rem）の中では
     * 語（`dt`）と見分けが付きにくい。太さと余白を決めている規則を見る。 */
    const css = [...page("index.html").matchAll(/<style>([\s\S]*?)<\/style>/g)]
      .map((m) => m[1])
      .join("\n");
    const blocks = cssBlocks(css);
    const head = blocks.filter((b) => b.selector === ".help h3");
    expect(head.length, "てびきの見出しの規則が無い").toBeGreaterThan(0);
    const body = head.map((b) => b.body).join(";");
    expect(body, "見出しの字の大きさが決まっていない").toMatch(/font-size:/);
    expect(body, "見出しの太さが決まっていない").toMatch(/font-weight:\s*(700|bold)/);
    expect(body, "前の群れと離す余白が決まっていない").toMatch(/margin:/);
  });
});
