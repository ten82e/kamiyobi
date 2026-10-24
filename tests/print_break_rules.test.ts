import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT } from "./helpers.ts";

/* 紙では、読めなくなる所で切らない。表の行（1 行）・但し書き（列の意味）・推薦のカード（1 枚）は
 * それぞれ 1 ページに収め、見出しの直後では割らない（2026-10-23 実測: カードは高さ 337〜365px で
 * `break-inside: auto` のまま、107 枚並ぶ紙の途中で切れ得た）。 */
it("紙では、行・但し書き・カードを 1 ページに収める", () => {
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const print = template.slice(template.indexOf("@media print {"));
  for (const [規則, 名] of [
    ["tbody tr, .month-row { break-inside: avoid; page-break-inside: avoid; }", "表の行"],
    [".upcoming-notes, .upcoming-notes > blockquote { break-inside: avoid; }", "但し書き"],
    ["#recommendationCards article { break-inside: avoid; }", "推薦のカード"],
    ["#recommendationCards article h3 { break-after: avoid; }", "カードの題"],
    ["h1, h2, .upcoming-notes > summary { break-after: avoid; }", "見出しの直後"],
  ] as const)
    expect(print, `${名}を割らない規則が無い`).toContain(規則);
});
