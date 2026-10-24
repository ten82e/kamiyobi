import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT } from "./helpers.ts";

/* キーボードで動いたときの焦点の印は、押せる物・打てる物で同じ見た目にする。前はリンクと
 * `<summary>` だけブラウザ既定の 1px の輪で、ボタンや入力欄の 2px と揃っていなかった
 * （2026-10-23 実測: Tab で動かすと `a.skip-link` は `auto 1px rgb(0, 95, 204)`）。 */
it("焦点の印は、リンク・畳み・ボタン・入力欄で同じ規則が受ける", () => {
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const 規則 =
    /((?:[^{}]*:focus-visible[^{}]*,\s*)*[^{}]*:focus-visible)\s*\{([^}]*)\}/.exec(template)?.[0] ??
    "";
  expect(規則, "focus-visible の規則が見つからない").toContain("outline: 2px solid var(--accent)");
  for (const sel of [
    "a:focus-visible",
    "summary:focus-visible",
    "button:focus-visible",
    "input[type=text]:focus-visible",
  ])
    expect(規則, `${sel} が同じ規則に入っていない`).toContain(sel);
});
