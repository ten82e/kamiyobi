/**
 * 正本とビルド成果物に、文字 NUL（U+0000）が混ざっていないかの検査（SPEC §7・第 281 回）。
 *
 * 2026-09-24 に実測した形:
 *   - `site/recommender.ts` の地名の盾（都市名を国名の置き換えから守る目印）が、
 *     **ソースに生の NUL バイトを 4 個**書いていた（同じファイルの別の所では `\u0000` の
 *     書き表しを使っていて、書き方が割れていた）。
 *   - 画面に出る値は正しくても、**ビルド後の `recommender.js`（利用者every人に配る物）に
 *     NUL が 4 個入る**。テキストとして扱う筈のファイルが、一部の仕組みで連続した文章として
 *     開けなくなる（このセッションで実際に編集機能が「バイナリ」と拒否した）。
 *   - 直し方は生ではなく `\u0000` の書き表しで書く（同じ意味・同じ動き）。置き換え前後で
 *     `placeJa` の結果が 343 行すべて一致すること、他の成果物が 1 バイトも変わらないことを
 *     実測で確かめた。
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

/** ビルド成果物のファイル一覧（`site` はハーネスが作ったビルド先）。 */
function builtFiles(): string[] {
  return readdirSync(site)
    .map((name) => join(site, name))
    .filter((p) => statSync(p).isFile());
}

/** 正本として点検するソースのディレクトリ。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else out.push(p);
  }
  return out;
}

function nulCount(path: string): number {
  return [...readFileSync(path)].filter((b) => b === 0).length;
}

describe("正本にも配る成果物にも、文字 NUL が混ざっていない（第 281 回）", () => {
  it("ビルド成果物のどれにも 0x00 が無い", () => {
    const files = builtFiles();
    expect(files.length, "ビルド成果物が見つからない（空振り検査の防止）").toBeGreaterThan(8);
    const bad = files
      .filter((p) => nulCount(p) > 0)
      .map((p) => `${p.split("/").pop()}（${nulCount(p)} 個）`);
    expect(bad, `NUL を含む成果物がある: ${bad.join(", ")}`).toEqual([]);
  });

  it("正本のソースにも 0x00 が無い", () => {
    const files = [...sourceFiles("site"), ...sourceFiles("src"), ...sourceFiles("tests")];
    expect(files.length, "正本が見つからない（空振り検査の防止）").toBeGreaterThan(10);
    const bad = files.filter((p) => nulCount(p) > 0).map((p) => `${p}（${nulCount(p)} 個）`);
    expect(bad, `NUL を含む正本がある: ${bad.join(", ")}`).toEqual([]);
  });

  it("目印は生ではなく、書き表し（バックスラッシュを使う形）で書かれている", () => {
    /* 上の 2 本は「生が無い」ことだけを見るので、目印を使う作りその物が消えた場合は
     * ここで見つける。盾の関数（都市名を退避する所）の本体に、書き表しの目印が有り、
     * 且つその本体に生が無いことまで見る。 */
    const body = jsFunction(siteRuntime("recommender.js"), "placeTermJa");
    expect(body, "盾の関数に目印の書き表しが無い（退避する作りが消えた）").toMatch(
      /\\u00[0-9A-Fa-f]{2}/,
    );
    expect(
      [...Buffer.from(body, "utf8")].filter((b) => b === 0).length,
      "盾の関数の目印が生になっている",
    ).toBe(0);
  });

  it("地名の盾は、実データのすべての掲載先で語を潰さず元に戻している", () => {
    /* 退避した語を戻す処理が壊れると、都市名が消えて「1」だけの様な値が画面に残る。
     * 固定した例だと、このビルドに該当が無く空振りで通るので、実データ全件で見る。
     * 見ているのは 3 つ。
     *   1. 目印（U+0000）が値に漏れていない
     *   2. 入力にある英文字の語が、置き換えの語彙で説明できる物以外、残っている
     *   3. 入力に無い数字が、値に現れない（番号が目印の場で放置された場合を掴む） */
    const script = [
      "(async () => {",
      "const { readFileSync } = await import('node:fs');",
      `const REC = ${JSON.stringify(join(site, "recommender.js"))};`,
      "const { default: Recommender } = await import('file://' + REC);",
      `const CAT = JSON.parse(readFileSync(${JSON.stringify(join(site, "catalog.json"))}, 'utf8'));`,
      "const places = new Set();",
      "for (const c of CAT.conferences) {",
      "  for (const ed of c.editions || []) {",
      "    for (const [k, v] of Object.entries(ed || {})) {",
      "      if (k.toLowerCase().includes('place') && typeof v === 'string' && v.trim()) places.add(v.trim());",
      "    }",
      "  }",
      "}",
      /* 置き換えの語彙は testing 側に書き写さない（正本とズレる – §8 の約束）。*/
      "const SRC = readFileSync(REC, 'utf8');",
      "const grab = (name) => {",
      "  const m = SRC.match(new RegExp('const ' + name + ' = (\\\\[[\\\\s\\\\S]*?\\\\]);'));",
      "  if (!m) throw new Error(name + ' が見つからない（空振り検査の防止）');",
      "  return new Function('return ' + m[1])();",
      "};",
      "const TERMS = grab('PLACE_TERMS_JA').map((x) => x[0])",
      "  .concat(grab('PLACE_COUNTRY_CODES_JA').map((x) => x[0]));",
      "const SHIELDS = grab('PLACE_NAME_SHIELDS_JA');",
      "const ALL = TERMS.concat(SHIELDS);",
      "const single = new Set(ALL.map((t) => String(t).toLowerCase()).filter((t) => !t.includes(' ')));",
      "const WORD = /[a-z\\u00e0-\\u00ff][a-z\\u00e0-\\u00ff-]+/g;",
      "const lost = [];",
      "const digits = [];",
      "const rows = [...places];",
      "let withNul = 0;",
      "let rewritten = 0;",
      "for (const p of rows) {",
      "  const ja = Recommender.placeJa(p);",
      "  const full = Recommender.placeWithPrefectureJa(p);",
      "  if (ja.includes(String.fromCharCode(0)) || full.includes(String.fromCharCode(0))) withNul++;",
      "  if (ja !== p) rewritten++;",
      "  const low = p.toLowerCase();",
      "  const ow = new Set((ja.toLowerCase().match(WORD) || []).concat((full.toLowerCase().match(WORD) || [])));",
      "  const covered = new Set(single);",
      "  for (const t of ALL) {",
      "    const tl = String(t).toLowerCase();",
      "    if (tl.includes(' ') && low.includes(tl)) (tl.match(WORD) || []).forEach((w) => covered.add(w));",
      "  }",
      "  ['and', 'of', 'the', 'or'].forEach((w) => covered.add(w));",
      "  for (const w of new Set(low.match(WORD) || [])) {",
      "    if (!ow.has(w) && !covered.has(w)) lost.push(p + ' => ' + ja + ' （失われた語: ' + w + '）');",
      "  }",
      "  const inD = (p.match(/\\d+/g) || []).length;",
      "  const outD = (ja.match(/\\d+/g) || []).length;",
      "  if (outD > inD) digits.push(p + ' => ' + ja);",
      "}",
      /* 盾の目的その物: 退避する語は、国名の語へ置き換わる場所（末尾の句）に有っても残る。
       * 語は正本の列表から取る（手書きすると列表が変わったときに空振りする）。
       * 書き方は「都市名, 末尾の句」– `placeJa` は末尾の句だけを書くので、その形にする。*/
      "const shield = String(SHIELDS[0] || '');",
      "const probe = shield ? 'Albuquerque, ' + shield : '';",
      "const shieldKept = shield ? Recommender.placeJa(probe).toLowerCase().includes(shield.toLowerCase()) : false;",
      "console.log(JSON.stringify({",
      "  checked: rows.length, lexicon: ALL.length, withNul, rewritten,",
      "  lostCount: lost.length, lost: lost.slice(0, 3),",
      "  digitCount: digits.length, digits: digits.slice(0, 3),",
      "  shield, probe, shieldKept,",
      "  sample: rows.filter((p) => Recommender.placeJa(p) !== p).slice(0, 2).map((p) => p + ' => ' + Recommender.placeJa(p)),",
      "}));",
      "})();",
    ].join("\n");
    const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
    expect(proc.status, proc.stderr).toBe(0);
    const out = JSON.parse(proc.stdout) as {
      checked: number;
      lexicon: number;
      withNul: number;
      rewritten: number;
      lostCount: number;
      lost: string[];
      digitCount: number;
      digits: string[];
      shield: string;
      probe: string;
      shieldKept: boolean;
      sample: string[];
    };
    expect(out.checked, "掲載先が 1 件も読めない（空振り検査の防止）").toBeGreaterThan(100);
    expect(out.lexicon, "置き換えの語彙が読めない").toBeGreaterThan(10);
    expect(out.withNul, "目印が値に漏れている").toBe(0);
    expect(out.lost, `掲載先の語が説明なく消えている（${out.lostCount} 件）`).toEqual([]);
    expect(out.digits, `入力に無い数字が値に出ている（${out.digitCount} 件）`).toEqual([]);
    expect(
      out.rewritten,
      "掲載先の書き換えが 1 件も起きていない（空振り検査の防止）",
    ).toBeGreaterThan(0);
    expect(out.shield, "盾の語が列表から読めない").toBeTruthy();
    expect(out.shieldKept, `盾の語「${out.shield}」が ${out.probe} で残っていない`).toBe(true);
  });
});
