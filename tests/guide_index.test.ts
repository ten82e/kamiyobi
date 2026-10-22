import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { builtSite } from "./built_site.ts";

/** てびき（`details.help`）の塊を切り出す。 */
function てびき(src: string): string {
  const at = src.indexOf('<details class="help"');
  expect(at, "てびき（`details.help`）が見つからない").toBeGreaterThan(-1);
  const close = src.indexOf("</details>", at);
  expect(close, "てびきの終わりが見つからない").toBeGreaterThan(at);
  return src.slice(at, close);
}

const 札を外す = (html: string): string => html.replace(/<[^>]*>/g, "").trim();

/* てびきの見出しは summary の中の h2（読み上げの見出しの並びを h1 → h2 → その下の h3 に
 * するため）。画面を開くと JS が題を差し替えるが、その時も h2 を残す（2026-10-22 実測:
 * summary ごと textContent で書き換えていて、開くと `.help-title` が消えていた）。 */
it("てびきの見出しは h2（開いた後も残る）", () => {
  const online = てびき(readFileSync(join(builtSite(), "index.html"), "utf8"));
  expect(online, "てびきの題が h2 でない").toContain('<summary><h2 class="help-title">');
  const app = readFileSync(join(import.meta.dirname, "..", "site", "app.ts"), "utf8");
  expect(app, "題の差し替えが summary ごと書き換えている").not.toContain(
    "summary.textContent = recommend",
  );
  expect(app, "題の差し替えが h2 を見ていない").toContain('summary?.querySelector("h2")');
});

function 節々(guide: string): Array<{ id: string; text: string }> {
  return [...guide.matchAll(/<h3\b([^>]*)>([\s\S]*?)<\/h3>/g)].map((m) => ({
    id: /id="([^"]+)"/.exec(m[1])?.[1] ?? "",
    text: 札を外す(m[2]),
  }));
}

function 目次(guide: string): Array<{ id: string; text: string }> {
  const at = guide.indexOf('class="help-index"');
  if (at < 0) return [];
  const end = guide.indexOf("</nav>", at);
  const box = guide.slice(at, end < 0 ? undefined : end);
  return [...box.matchAll(/<a href="#([^"]+)">([\s\S]*?)<\/a>/g)].map((m) => ({
    id: m[1],
    text: 札を外す(m[2]),
  }));
}

it("てびきの目次は、節と同じ順・同じ名前で並ぶ", () => {
  const guide = てびき(
    readFileSync(join(import.meta.dirname, "..", "site", "template.html"), "utf8"),
  );
  const 節 = 節々(guide);
  expect(節.length, "節が少なすぎる（検査が空振り）").toBeGreaterThanOrEqual(5);
  for (const 項 of 節) expect(項.id, `節に id が無い: ${項.text}`).not.toBe("");
  expect(new Set(節.map((項) => 項.id)).size, "節の id が重なっている").toBe(節.length);
  const 目 = 目次(guide);
  expect(目.length, "目次が無い（または空）").toBeGreaterThanOrEqual(5);
  expect(
    目.map((項) => 項.id),
    "目次と節の順・飛び先が違う",
  ).toEqual(節.map((項) => 項.id));
  for (const [index, 項] of 目.entries())
    expect(項.text, `目次と節の名前が違う: ${項.id}`).toBe(節[index].text);
});

it("目次はてびきの頭にあり、組み立てた画面でも飛び先が実在する", () => {
  const source = てびき(
    readFileSync(join(import.meta.dirname, "..", "site", "template.html"), "utf8"),
  );
  expect(source.indexOf('class="help-index"'), "目次が最初の節より後ろにある").toBeLessThan(
    source.indexOf("<h3"),
  );
  const built = てびき(readFileSync(join(builtSite(), "index.html"), "utf8"));
  const ids = new Set([...built.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const 目 = 目次(built);
  expect(目.length, "組み立てた画面に目次が無い").toBeGreaterThanOrEqual(5);
  for (const 項 of 目) expect(ids.has(項.id), `飛び先が実在しない: ${項.id}`).toBe(true);
  /* 節の終わりから目次へ戻れる（節が長いので、上まで戻らせない）。 */
  const 戻り = [...built.matchAll(/<p class="help-back"><a href="#([^"]+)">/g)].map((m) => m[1]);
  expect(戻り.length, "節の数と戻り先の数が違う").toBe(節々(built).length);
  for (const id of 戻り) expect(ids.has(id), `戻り先が実在しない: ${id}`).toBe(true);
});
