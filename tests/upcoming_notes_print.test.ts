import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT } from "./helpers.ts";

/* JavaScript なしの面（upcoming.html）の但し書きは `<details>` で畳んである（画面では開いて
 * 読む）。紙では開けないので、印刷のときだけ中身を出す – 列の意味が無いと「残り」「状態」
 * が読めない（2026-10-23 実測: 印刷の模擬で中身が display: none のままだった）。 */
it("upcoming.html の但し書きは、紙には畳まずに刷る", () => {
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const print = template.slice(template.indexOf("@media print {"));
  const 規則 = print.slice(0, print.indexOf("\n}", print.indexOf(".upcoming-notes")) + 2);
  expect(規則, "但し書きの中身を紙に出す規則が無い").toContain(
    ".upcoming-notes > *:not(summary) { display: block !important; }",
  );
  /* 但し書きは 1 ページに収め、見出しの直後で割らない（紙では 128 ページになる長い表なので、
   * 列の意味がページをまたぐと読めない – 2026-10-23 実測: 但し書きは break-inside: auto で、
   * ページの途中で切れ得た）。 */
  expect(print, "但し書きを 1 ページに収める規則が無い").toContain(
    ".upcoming-notes, .upcoming-notes > blockquote { break-inside: avoid; }",
  );
  expect(print, "見出しの直後で割らない規則が無い").toContain(
    "h1, h2, .upcoming-notes > summary { break-after: avoid; }",
  );

  /* 画面の側では畳んだまま（既定の details の見た目を壊さない）。 */
  const 画面 = template.slice(0, template.indexOf("@media print {"));
  expect(画面, "画面でも開いてしまう規則がある").not.toMatch(
    /\.upcoming-notes[^{]*\{[^}]*display:\s*block/,
  );
});
