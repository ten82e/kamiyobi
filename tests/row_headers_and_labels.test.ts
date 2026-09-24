/**
 * 表の「行ヘッダー」と、幅せま画面で各マスに付く列名の検査（SPEC §7・第 284 回）。
 *
 * 2 つの実測した欠陥を、同時に直している。
 *
 *   1. **行ヘッダーが 1 個も無かった**。`upcoming.html` の 1,126 行は全て `<td>`、
 *      一覧（`index.html`）の行も全マスが `td` だった。列の名前（`scope="col"`）は
 *      出ていたので、一マスずつ読むと「種別」「推定」とは読めるが、
 *      **どの会議の行か**が分からない。
 *   2. **幅せま画面で列名が消え、置き換わる筈の列名が空だった**。`@media (max-width: 640px)`
 *      では `thead` を消し、各マスの前に `content: attr(data-label) "："` を出す作り。
 *      ところが `upcoming.html` のマス 6,756 個に `data-label` が **1 個も無く**
 *      （2026-09-24 実測）、その幅では各行が「：論文締切」のように記号だけ先頭に付いて、
 *      何が何列か読めなかった。
 *
 * 見た目は変えない（行ヘッダーは `td` と同じ見え方にし、カード化でも同じ積方にしている）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssBlocks, site } from "./built_golden_shared.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

function page(name: string): string {
  return readFileSync(join(site, name), "utf8");
}

/** `<style>` を全部つないだ物（両ページとも同じ規則の集合を埋め込んでいる）。 */
function cssOf(name: string): string {
  return [...page(name).matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
}

function bodyRows(src: string): string[] {
  const tb = src.slice(src.indexOf("<tbody"));
  return [...tb.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[0]);
}

/** 列ヘッダーの語（`scope="col"` の並び）。番号で書かないための取り出し口。 */
function upcomingColumns(): string[] {
  const src = page("upcoming.html");
  const headRow = src.slice(src.indexOf("<thead"), src.indexOf("</thead>"));
  return [...headRow.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
    m[1].replace(/<[^>]*>/g, "").trim(),
  );
}

/* `site` はビルド後に埋まる（検査の外で読むと undefined – ハーネスの約束）。
 * 上の列名も検査の中から読む。 */
describe("表の行が、どの行かを自分でおぼえている", () => {
  it("列の名前が読める（以降の検査の空振り防止）", () => {
    const columns = upcomingColumns();
    expect(columns.length, "列ヘッダーが読めない").toBeGreaterThanOrEqual(5);
    expect(
      columns.indexOf("会議"),
      `列ヘッダーに「会議」が無い: ${columns.join("・")}`,
    ).toBeGreaterThan(-1);
  });

  it("すべての行に、会議名を行ったヘッダーとして持つ", () => {
    const columns = upcomingColumns();
    const src = page("upcoming.html");
    const rows = bodyRows(src).filter((r) => r.includes("<td"));
    expect(rows.length, "行が無い（組み立てが壊れた）").toBeGreaterThan(100);
    const missing = rows.filter((r) => !r.includes('<th scope="row"'));
    expect(
      missing.slice(0, 2).map((r) => r.slice(0, 80)),
      `${missing.length} 行に行ヘッダーが無い`,
    ).toEqual([]);
    // 行ヘッダーは「会議」の列に有る（番号でなく、列ヘッダーから割り出した位置で見る）。
    const misplaced = rows.filter((r) => {
      const cells = [...r.matchAll(/<(t[hd])\b([^>]*)>/g)];
      const at = cells.findIndex((m) => m[1] === "th");
      return at !== columns.indexOf("会議");
    });
    expect(
      misplaced.slice(0, 2).map((r) => r.slice(0, 80)),
      `${misplaced.length} 行で、行ヘッダーが会議の列に無い`,
    ).toEqual([]);
    // 中身が空ではない（読み上げられる物が無ければ意味がない）。
    const empty = rows.filter((r) => {
      const m = /<th scope="row"[^>]*>([\s\S]*?)<\/th>/.exec(r);
      return !m || m[1].replace(/<[^>]*>/g, "").trim() === "";
    });
    expect(empty.slice(0, 2), `${empty.length} 行の行ヘッダーが空`).toEqual([]);
  });

  it("幅せま画面で列名に置き換わる語を、すべてのマスが持っている", () => {
    const columns = upcomingColumns();
    const src = page("upcoming.html");
    const rows = bodyRows(src).filter((r) => r.includes("<td"));
    const cells: Array<{ tag: string; attrs: string; index: number }> = [];
    for (const r of rows) {
      const found = [...r.matchAll(/<(t[hd])\b([^>]*)>/g)];
      for (const [i, m] of found.entries()) {
        cells.push({ tag: m[1], attrs: m[2], index: i });
      }
    }
    expect(cells.length, "マスが無い").toBeGreaterThan(100);
    const missing = cells.filter((c) => !c.attrs.includes("data-label"));
    expect(
      missing.slice(0, 3).map((c) => `<${c.tag}${c.attrs}>`),
      `${missing.length} マスに列名が無く、幅せま画面で「：値」だけになる`,
    ).toEqual([]);
    // 列名は列ヘッダーと同じ語（手で書き写してズレていない）。
    const wrong = cells.filter((c) => {
      const hit = /data-label="([^"]*)"/.exec(c.attrs);
      return !hit || hit[1] !== columns[c.index];
    });
    expect(
      wrong.slice(0, 3).map((c) => `${c.attrs.slice(0, 44)}（${columns[c.index]}のはず）`),
      `${wrong.length} マスの列名が、列ヘッダーと違う`,
    ).toEqual([]);
  });

  it("カード化の規則が、行ヘッダーにも同じ積方をさせる", () => {
    /* `data-label` を出しても、その幅で `thead` を消し、マスを積む規則でなければ
     * 検査だけ通って画面は直らない。逆に `td` だけの規則だと行ヘッダーだけ浮く。 */
    const css = cssOf("upcoming.html");
    const blocks = cssBlocks(css);
    const stacked = blocks.filter(
      (b) =>
        /max-width/.test(b.media) && /display:\s*block/.test(b.body) && /\btd\b/.test(b.selector),
    );
    expect(stacked.length, "幅せま画面でマスを積む規則が見つからない").toBeGreaterThan(0);
    const labelRule = blocks.filter((b) => /attr\(data-label\)/.test(b.body));
    expect(labelRule.length, "列名を出す規則が無い").toBeGreaterThan(0);
    /* `,` で並べた規則は `cssBlocks` が個別の規則に割るので、「同じセレクタに含んで
     * いるか」では測れない。対応する行ヘッダーの規則が同じ幅に有るかで見ます。 */
    const orphan = (list: typeof blocks) =>
      list
        .filter((b) => {
          const twin = b.selector.replace(/(^|[\s>+~])td\b/, '$1th[scope="row"]');
          return !blocks.some((o) => o.media === b.media && o.selector === twin);
        })
        .map((b) => `${b.media || "(どの幅でも)"} ${b.selector}`);
    expect(orphan(stacked), "積む規則で行ヘッダーが置き去り").toEqual([]);
    expect(orphan(labelRule), "列名を出す規則で行ヘッダーが置き去り").toEqual([]);
    expect(
      blocks.some(
        (b) =>
          /max-width/.test(b.media) && b.selector === "thead" && /display:\s*none/.test(b.body),
      ),
      "幅せま画面で列ヘッダーを消す前提が変わった（この検査の前提を見直す）",
    ).toBe(true);
  });

  /* 列ヘッダーの見た目（灰色の地・小さな字・大文字化・押せそうに見えるカーソル）が
   行ヘッダーに漏れないこと（第 284 回）。直前は `th` だけを狙った規則で、行の中の
   会議名が灰色の小さな大文字になり、押せる物と誤解される見た目になっていた。
   打ち消し規則を後から並べるのではなく、**規則を `thead th` に限定**しているため、
   判定は「素の `th` を狙う規則が残っていないか」でできる（打ち消しを忘れた追加も
   これなら捕まる）。 */
  it("行ヘッダーが、列ヘッダーの見た目を引き継がない", () => {
    for (const pageName of ["index.html", "upcoming.html"]) {
      const blocks = cssBlocks(cssOf(pageName));
      const props = (body: string) =>
        body
          .split(";")
          .map((d) => d.split(":")[0].trim())
          .filter((n) => /^[a-z-]+$/.test(n));
      /* 素の `th` を狙う規則は、`td` 側にも同じ項目が書いてある物だけ（= 行ヘッダーが
       * `td` と同じ見え方で済む物だけ）を許す。 */
      const bare = blocks.filter((b) => /^th(?=$|[\s:[])/.test(b.selector));
      const leaking = bare
        .filter((b) => {
          const twin = b.selector.replace(/^th(?=$|[\s:[])/, "td");
          const twinProps = new Set(
            blocks.filter((o) => o.selector === twin).flatMap((o) => props(o.body)),
          );
          return props(b.body).some((name) => !twinProps.has(name));
        })
        .map((b) => `${b.media || "(どの幅でも)"} ${b.selector}: ${b.body.trim().slice(0, 40)}`);
      expect(leaking, `${pageName}: 素の th を狙う規則が行ヘッダーにも効いている`).toEqual([]);
      // 列ヘッダー专用の見た目を決める規則は、必ず `thead` 側（または並び替え可能な見出し）に限定。
      const cosmetics = blocks.filter(
        (b) => /\bth\b/.test(b.selector) && /var\(--chip\)|text-transform:|cursor:/.test(b.body),
      );
      expect(
        cosmetics.length,
        `${pageName} に列ヘッダーの見た目の規則が無い（空振り防止）`,
      ).toBeGreaterThan(0);
      for (const b of cosmetics) {
        expect(b.selector, `${pageName}: 行にも効く列ヘッダーの見た目: ${b.selector}`).toMatch(
          /thead|data-sort/,
        );
      }
      /* ブラウザは `th` を太字にする（作者の規則が無くても UA が決める）。そこだけは
       * 明示的に普通のセルへ戻している。 */
      const pin = blocks.filter((b) => b.selector === 'tbody th[scope="row"]');
      expect(pin.length, `${pageName} に行ヘッダーの規則が無い`).toBeGreaterThan(0);
      expect(pin.map((b) => b.body).join(";"), "行ヘッダーが太字のまま").toMatch(
        /font-weight:\s*normal/,
      );
    }
  });

  it("行にマウスを載せた時だけ、行ヘッダーが取り残されない", () => {
    /* `tr:hover td` 等に `th[scope="row"]` を足さないと、そのマスだけ地色が変わらない。 */
    for (const pageName of ["index.html", "upcoming.html"]) {
      const blocks = cssBlocks(cssOf(pageName));
      const withTd = blocks.filter(
        (b) =>
          /\btd\b/.test(b.selector) &&
          /^(tr:(hover|selected)|tr\.selected|tr:last-child)/.test(b.selector),
      );
      expect(withTd.length, `${pageName} に行の状態の規則が無い`).toBeGreaterThanOrEqual(3);
      /* `,` で並べた規則は個別に割れるので、行ヘッダー側の規則が同じ幅に有るかで見る。 */
      const orphan = withTd
        .filter((b) => {
          const twin = b.selector.replace(/(^|[\s>+~])td\b/, '$1th[scope="row"]');
          return !blocks.some((o) => o.media === b.media && o.selector === twin);
        })
        .map((b) => `${b.media || "(どの幅でも)"} ${b.selector}`);
      expect(orphan, `${pageName}: 行の状態の規則が行ヘッダーに届いていない`).toEqual([]);
      const kinds = new Set(withTd.map((b) => b.selector.replace(/t[hd]\b/, "CELL")));
      expect(kinds.size, "検査している規則の種類が足りない（空振り防止）").toBeGreaterThanOrEqual(
        3,
      );
    }
  });
});

describe("一覧側（JavaScript が作る行）も同じ形", () => {
  const app = siteRuntime("app.js");

  it("セルを作る手が、行ヘッダーを作れる", () => {
    const helper = jsFunction(app, "td");
    expect(helper).toContain('createElement(rowHeader ? "th" : "td")');
    expect(helper).toMatch(/setAttribute\(\s*"scope"\s*,\s*"row"\s*\)/);
    // 「どの会議か」のセルだけが、その形になる（他の列まで行ヘッダーにしない）。
    const calls = [...app.matchAll(/td\(\s*(?:tr|row)\s*,\s*"([^"]+)"[^)]*\)/g)].map((m) => m[0]);
    expect(calls.length, "セルを作る呼び出しが見つからない").toBeGreaterThan(3);
    const headers = calls.filter((c) => /true\s*\)/.test(c));
    expect(headers.length, "行ヘッダーにしている列が 1 つも無い").toBeGreaterThan(0);
    expect(headers.length, `行ヘッダーにしすぎている: ${headers.join(" / ")}`).toBeLessThan(3);
    expect(headers.join(" ")).toMatch(/"会議"/);
  });

  it("印刷でも行ヘッダーを表のマスとして刷る", () => {
    /* 幅せま用の規則が印刷幅でも当たることがあるため、`tbody td` と並べて直している。 */
    for (const pageName of ["index.html", "upcoming.html"]) {
      const print = cssBlocks(cssOf(pageName)).filter((b) => /print/.test(b.media));
      expect(print.length, `${pageName} に印刷用の規則が無い`).toBeGreaterThan(0);
      expect(
        print.some(
          (b) => b.selector === 'tbody th[scope="row"]' && /display:\s*table-cell/.test(b.body),
        ),
        `${pageName} の印刷で、行ヘッダーがカードのまま残る`,
      ).toBe(true);
    }
  });
});
