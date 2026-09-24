/**
 * 静的な一覧（`upcoming.html`）の head が、画面（`index.html`）と同じ入口情報を持つかの検査
 * （SPEC §7・第 286 回）。
 *
 * 2026-09-24 にビルド後で実測した形：`upcoming.html` の head は
 * `charset`・`viewport`・`title` の **3 個だけ**で、画面に有る説明・og（type / site_name /
 * locale / title / description / url）・twitter:card・アイコン・canonical・theme-color・
 * Content-Security-Policy が **1 個も無かった**。画面の head には「検索結果とチャットの
 * プレビューが入口になる」という意図が書いてあり、それは絞り込みの無いこのページにも
 * そのまま当てはまる（研究室のグループチャットに貼られるのはこっちである事も多い）。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toUpcomingHtml } from "../src/build.ts";
import { site } from "./built_golden_shared.ts";

function page(name: string): string {
  return readFileSync(join(site, name), "utf8");
}

function headOf(src: string): string {
  const at = src.indexOf("</head>");
  expect(at, "head の終端が見当たらない").toBeGreaterThan(-1);
  return src.slice(0, at);
}

/** head に並ぶ `meta`・`link` の名前（`name` / `property` / `rel`）を一覧にする。 */
function headNames(head: string): string[] {
  const out: string[] = [];
  for (const m of head.matchAll(/<(?:meta|link)\b([^>]*)>/g)) {
    const attrs = m[1];
    for (const key of ["property", "name", "rel", "http-equiv"]) {
      const v = new RegExp(`${key}="([^"]*)"`).exec(attrs);
      if (v) out.push(v[1]);
    }
  }
  return out;
}

function contentOf(head: string, selector: string): string {
  /* `Content-Security-Policy` は `http-equiv` に載る。名前と指定子だけを見ると
   * 「規則が無い」と誤読する（第 286 回の実測: 有るのに空に読めた）。 */
  const m = new RegExp(
    `<meta[^>]+(?:name|property|http-equiv)="${selector}"[^>]+content="([^"]*)"`,
  ).exec(head);
  return m ? m[1] : "";
}

/** ビルド後の表の列の名前（説明が実語を使っているかの突き合わせに使う）。 */
function columnsOf(name: string): string[] {
  const head = page(name).match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? "";
  return [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
    m[1].replace(/<[^>]*>/g, "").trim(),
  );
}

const REQUIRED_JA = [
  "description",
  "og:type",
  "og:site_name",
  "og:locale",
  "og:title",
  "og:description",
  "og:url",
  "twitter:card",
  "canonical",
  "icon",
  "theme-color",
  "Content-Security-Policy",
];

describe("静的な一覧の入口情報（第 286 回）", () => {
  it("画面と同じ項目が、静的な一覧にも並んでいる", () => {
    const index = headNames(headOf(page("index.html")));
    const statics = headNames(headOf(page("upcoming.html")));
    /* 項目の集合を静的な側から見る（画面側に無い物が増えても構わないので、逆向きは
     * 要求しない – 静的な側は JavaScript を読まないため、不要な項目が有ってよい）。 */
    const missing = REQUIRED_JA.filter((n) => !statics.includes(n));
    expect(missing, `静的な一覧に無い項目: ${missing.join("・")}`).toEqual([]);
    // 画面だけが持っている物を列挙して、意図しない退化をここで気づけるようにする。
    const absent = [...new Set(index)].filter((n) => !statics.includes(n));
    expect(absent, `静的な一覧に無い画面の項目: ${absent.join("・")}`).toEqual([]);
  });

  it("説明は空でなく、日本語で、表の実語を使っている", () => {
    const up = page("upcoming.html");
    const head = headOf(up);
    const description = contentOf(head, "description");
    expect(
      description.length,
      "説明が空（検索結果とチャットのプレビューが白くなる）",
    ).toBeGreaterThan(40);
    expect(description, "説明に日本語が混じっていない").toMatch(/[ぁ-んァ-ヶ]/);
    expect(description.length, "説明が長すぎてプレビューで切れる").toBeLessThanOrEqual(200);
    // 説明文が表の実語（列の名前）を使う – 手写しでズレた説明を書かないため。
    const columns = columnsOf("upcoming.html").filter((c) => c.length >= 2);
    expect(columns.length, "列の名前が読めない（空振り防止）").toBeGreaterThan(3);
    const used = columns.filter((c) => description.includes(c));
    expect(
      used.length,
      `説明が列の名前を 1 つも参照していない: ${description}`,
    ).toBeGreaterThanOrEqual(3);
    // og の説明と同じ物を書く（2 か所で別の事を言わない）。
    expect(contentOf(head, "og:description"), "og の説明が画面の説明と違う").toBe(description);
    expect(contentOf(head, "og:title"), "og の見出しが title と違う").toBe(
      /<title[^>]*>([\s\S]*?)<\/title>/.exec(up)?.[1].trim() ?? "",
    );
    // 生成のたびに変わる絶対時刻を head に焼き込まない（古くて噓の説明になる）。
    expect(description, "説明に生成時刻の絶対値が焼かれている").not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("自分の場所（og:url と canonical）が、画面と同じ基準から組み立っている", () => {
    const config = readFileSync("config.yaml", "utf8");
    const base = /site:\n[\s\S]*?\n\s*base_url:\s*(\S+)/.exec(config)?.[1] ?? "";
    expect(base, "config.yaml の site.base_url が読めない").not.toBe("");
    const head = headOf(page("upcoming.html"));
    expect(contentOf(head, "og:url"), "og:url が base_url からの組み立てになっていない").toBe(
      `${base}/upcoming.html`,
    );
    const canonical =
      /<link rel="canonical" href="([^"]+)"/.exec(headOf(page("upcoming.html")))?.[1] ?? "";
    expect(canonical, "canonical が og:url と違う場所を指している").toBe(contentOf(head, "og:url"));
    // 画面の場所（base_url その物）とは違う場所を指す（同じだと複製として扱われる）。
    const indexCanonical =
      /<link rel="canonical" href="([^"]+)"/.exec(headOf(page("index.html")))?.[1] ?? "";
    expect(indexCanonical, "画面の canonical が読めない").not.toBe("");
    expect(canonical, "静的な一覧が画面と同じ場所を自分の場所として名乗っている").not.toBe(
      indexCanonical,
    );
  });

  it("JavaScript を読まない頁に見合う締め方になっている", () => {
    const up = page("upcoming.html");
    const csp = contentOf(headOf(up), "Content-Security-Policy");
    expect(csp, "静的な一覧に CSP が無い（画面には有る）").not.toBe("");
    expect(csp, "スクリプトを読まない頁なのに script を開いている").toMatch(/script-src\s+'none'/);
    /* 声明が実態と矛盾していないこと。ページに `script` が 1 本も無い事を、ここでも見る
     * （埋め込む様式は `style-src 'unsafe-inline'` で生かす – 画面と同じ様式を運んでいる）。 */
    expect(up.match(/<script\b/g) || [], "静的な一覧にスクリプトが混ざった").toHaveLength(0);
    expect(csp, "埋め込む様式が死んでいる（表が素の見た目になる）").toMatch(
      /style-src\s+'unsafe-inline'/,
    );
    expect(csp, "base の取り方が決まっていない").toMatch(/base-uri\s+'none'/);
  });

  it("tab とスマホの縁の色が、画面とずれていない", () => {
    /* 色を 2 か所に書くと片方だけ変わる。静的な一覧は画面の様式をそのまま運んでいるので、
     * theme-color の 2 値も画面（`site/template.html`）と一致するはず。 */
    const template = readFileSync("site/template.html", "utf8");
    const up = headOf(page("upcoming.html"));
    const values = (src: string): string[] =>
      [...src.matchAll(/<meta name="theme-color"[^>]*content="([^"]+)"/g)].map((m) => m[1]);
    const fromTemplate = values(template);
    const fromStatic = values(up);
    expect(fromTemplate.length, "画面に theme-color が 2 つ無い（空振り防止）").toBe(2);
    expect(fromStatic, "静的な一覧に theme-color が 2 つ無い").toEqual(fromTemplate);
    // アイコンの実体（リンク切れだと tab が無地になる）。
    expect(existsSync(join(site, "icon.svg")), "icon.svg が成果物に無い").toBe(true);
    expect(up, "アイコンへのリンクが成果物に無い").toContain('href="icon.svg"');
  });

  it("所在を渡さない組み立てでも、ページは壊れない（呼び出しの既定）", () => {
    /* `toUpcomingHtml` は所在（base_url）を渡さない呼び出し方も許す。そのときは
     * 「自分の場所」を書かないだけで、表と説明はそのまま出る（ビルドの組み立てが変わっても
     * ページが真っ白にならない事をここで止める）。 */
    const markdown =
      "# 直近 180 日の締切と開催\n\n| 日付 | 残り | 会議 |\n| --- | --- | --- |\n| 2026-09-01 | 23 日後 | 例会 |\n";
    const bare = toUpcomingHtml(markdown, "<style>body{}</style>");
    expect(bare).toContain("<!doctype html>");
    expect(bare).toContain("直近 180 日の締切と開催を一覧にしたページです");
    expect(bare).toContain("<th");
    expect(bare).not.toContain('rel="canonical"');
    const withBase = toUpcomingHtml(
      markdown,
      "<style>body{}</style>",
      "https://example.test/kamiyobi",
    );
    expect(withBase).toContain(
      '<link rel="canonical" href="https://example.test/kamiyobi/upcoming.html">',
    );
    // 説明文は同じ（所在の有無で中身が揺れない）。
    const desc = (src: string): string =>
      /<meta name="description" content="([^"]*)"/.exec(src)?.[1] ?? "";
    expect(desc(withBase), "所在の有無で説明が変わった").toBe(desc(bare));
  });
});
