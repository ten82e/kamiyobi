/**
 * 見つけられなかった場所への案内ページ（`404.html`）の検査（SPEC §4・§7）。
 * GitHub Pages は無い場所の応答として同梱の `404.html` を出す。ビルド済みサイトは
 * `tests/built_site.ts` 経由で共有する（1 ファイルに全検査を並べると biome の上限にぶつかる –
 * tests/lint_budget.test.ts）。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { builtSite } from "./built_site.ts";

function page(): string {
  return readFileSync(join(builtSite(), "404.html"), "utf8");
}

/** 様子の塊とタグを除いた、人が読む本文。 */
function bodyText(): string {
  return page()
    .replace(/<style>[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

it("無い場所に開いた人を、日本語で締切の場所に帰す（第 307 回）", () => {
  const html = page();
  expect(html).toContain('<html lang="ja">');
  expect(html, "見出しが日本語で無い").toContain("そのページは見つかりません");
  /* 無い場所の応答を検索エンジンに本文として拾わせない。 */
  expect(html).toContain('name="robots" content="noindex"');
  /* 帰す先は画面・直近の一覧・カレンダー・機械可読のデータの 4 口。 */
  for (const file of ["index.html", "upcoming.html", "deadlines.ics", "data.json", "llms.txt"]) {
    expect(html, `404 ページに ${file} へのリンクが無い`).toContain(`/${file}"`);
    /* 何に帰す口か分からないと押せない – 行の本文（口の名前 + 用事）が日本語で続いて書く。
       口の名前だけの改ざんもここで落ちる（実測: 用事の列を消すと 1 行 12 語程度になる）。 */
    const li = new RegExp(`<li><a href="[^"]+/${file}">([\\s\\S]*?)</li>`).exec(html);
    expect(li, `404 ページの ${file} の口が行になっていない`).not.toBeNull();
    const 説明 = (li![1].match(/[^\s<>・，、]+/g) || []).join("").length;
    expect(説明, `${file} の口の説明が短い（${説明} 語分しかない）`).toBeGreaterThan(24);
  }
  const links = [...html.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  expect(links.length, "口が少なすぎる").toBeGreaterThanOrEqual(4);
});

it("404 ページの口はサイトの絶対 URL で、サイトの直下で間違えても帰れる（第 307 回）", () => {
  /* 相対リンクだと、`https://<domain>/deadlines.ics`（場所の prefix を落とした打ち方）で開いた
   * ときに `https://<domain>/index.html` へ飛んで再び居場所を失う。サイトの所在地は
   * `upcoming.html` の canonical が持つので、検査側は host を書き写さずにそこから取る。 */
  const canonical = /<link rel="canonical" href="([^"]+)\/upcoming\.html">/.exec(
    readFileSync(join(builtSite(), "upcoming.html"), "utf8"),
  );
  expect(canonical, "canonical が読めない（基準が無い）").not.toBeNull();
  const base = canonical![1];
  const links = [...page().matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  expect(links.length).toBeGreaterThanOrEqual(4);
  const 相対 = links.filter((href) => !href.startsWith(`${base}/`));
  expect(相対, `絶対 URL で無い口がある: ${相対.join(" / ")}`).toEqual([]);
  /* 他所のサイトに人を流さない（このページは自分の口のだけを並べる）。 */
  const hosts = [...page().matchAll(/https?:\/\/([^/" ]+)/g)].map((m) => m[1]);
  const own = new URL(base).host;
  const others = hosts.filter((h) => h !== own);
  expect(others, `このサイト以外の host への口がある: ${[...new Set(others)].join(" / ")}`).toEqual(
    [],
  );
});

it("404 ページは締切も会期も載せない – 日付を推測しない（第 307 回）", () => {
  const text = bodyText();
  const dates = text.match(/\d{4}-\d{2}-\d{2}/g) || [];
  expect(dates, `本文に日付が載っている: ${dates.join(" / ")}`).toEqual([]);
  /* 何時までも同じ物が読まれる場所なので、「今の締切」に見える行を作らない。 */
  for (const label of ["締切: ", "会期: "]) {
    expect(text, `404 ページに ${label} の形が出ている`).not.toContain(label);
  }
  expect(text).toContain("このページ自体は締切も会期も載せません");
});

it("出口の索引（llms.txt）が 404 ページを隠さない（第 307 回）", () => {
  expect(existsSync(join(builtSite(), "404.html")), "404.html が無い").toBe(true);
  const llms = readFileSync(join(builtSite(), "llms.txt"), "utf8");
  const line = llms.split("\n").find((l) => l.startsWith("- 404.html"));
  expect(line, "llms.txt に 404.html の項が無い").toBeTruthy();
  /* 名前の行だけでも出てくるので、出口の用事まで書かれていることを見る（説明の項が別名に
     なって空振りする改ざんを捕まえる – 第 307 回）。 */
  for (const 語 of ["絶対 URL", "日付は載せない"]) {
    expect(line as string, `llms.txt の 404.html の項に「${語}」が無い`).toContain(語);
  }
});
