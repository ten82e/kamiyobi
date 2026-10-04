/**
 * 画面のてびきから収録の裏取りの報告（`health.md`）へ行けることの検査（SPEC §4・§7・第 308 回）。
 * ビルド済みサイトは `tests/built_site.ts` 経由で共有する。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

/** 画面のてびきの、ある見出しから次の `</dd>` までの本文。 */
function helpEntry(html: string, term: string): string {
  const start = html.indexOf(`<dt>${term}</dt>`);
  expect(start, `てびきに「${term}」の見出しが無い`).toBeGreaterThan(-1);
  const end = html.indexOf("</dd>", start);
  expect(end, `てびきの「${term}」の説明が終わっていない`).toBeGreaterThan(start);
  return html.slice(start, end);
}

it("てびきに、収録の裏取りの報告（health.md）への口が在る（第 308 回）", () => {
  const html = readFileSync(join(builtSite(), "index.html"), "utf8");
  const entry = helpEntry(html, "データの健全性（health.md）");
  /* 口が実際のファイルを指している（存在しない物を教えない）。 */
  expect(entry, "health.md へのリンクが無い").toContain('<a href="health.md"');
  expect(existsSync(join(builtSite(), "health.md")), "指している health.md が無い").toBe(true);
  /* 何のファイルか分からないと押せない – title に中身を書いてある。 */
  expect(entry, "リンクの説明（title）が無い").toContain("title=");
  /* 「データ源」「データ更新」と同じまとまりに置く – 更新の話の隣に無いと見付からない。 */
  expect(
    html.indexOf("<dt>データ源</dt>") < html.indexOf("<dt>データの健全性（health.md）</dt>"),
    "データ源より前に置いてある（更新の話の隣に無い）",
  ).toBe(true);
  expect(
    html.indexOf("<dt>データの健全性（health.md）</dt>") <
      html.indexOf("<dt>論文の入力とサンプル</dt>"),
    "論文の入力の後に置いてある（データの話から離れている）",
  ).toBe(true);
});

it("てびきが.health.md の中身として書いたことを、報告が実際に載せている（第 308 回）", () => {
  /* 口の説明で「何が書いてあるか」を書くなら、報告の側に其れが在ることを見る。
   * 報告の側だけ直して、画面の言い回しが噓を言い始めるのを止めたい（第 299 回の
   * 「言い回しは 1 箇所の正本から」と同じ約束）。 */
  const html = readFileSync(join(builtSite(), "index.html"), "utf8");
  const entry = helpEntry(html, "データの健全性（health.md）");
  const report = readFileSync(join(builtSite(), "health.md"), "utf8");
  const 約束: Array<[string, string]> = [
    ["分野の内訳", "分野の内訳"],
    ["解析で見つけた", "解析上の注意"],
    ["snapshot", "snapshot"],
    ["時刻まで確定", "時刻まで確定"],
    ["必ず収録しておきたい会議", "必ず収録しておきたい会議"],
  ];
  for (const [画面の語, 報告の語] of 約束) {
    expect(entry, `てびきが「${画面の語}」と書いていない`).toContain(画面の語);
    expect(report, `報告に「${報告の語}」が在らないのにてびきが約束している`).toContain(報告の語);
  }
  /* 機械が読む形の名前も画面から教える（報告の名前を実在する物だけ書く）。 */
  expect(entry).toContain("health.json");
  expect(existsSync(join(builtSite(), "health.json")), "health.json が無い").toBe(true);
});

it("正本の実測メモが 2 度書いていない – 一方だけ直し忘れると噓が始まる（第 308 回）", () => {
  /* `site/recommender.ts` に 2 行以上の実測メモの塊が 2 か所置いてある状態を検出する
   * （実際に入っていた – `virtual` を寄せない理由の 3 行が重複し、一方だけ直す危険が在った）。 */
  const lines = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8").split("\n");
  const seen = new Map<string, number>();
  let run: string[] = [];
  const flush = (): void => {
    for (let i = 0; i + 1 < run.length; i += 1) {
      const key = `${run[i]}\u0000${run[i + 1]}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    run = [];
  };
  for (const line of lines) {
    const text = line.trim();
    if (text.startsWith("//")) {
      run.push(text);
    } else {
      flush();
    }
  }
  flush();
  const 重複 = [...seen.entries()].filter(([, n]) => n > 1);
  expect(
    重複.map(([key]) => key.replace("\u0000", " / ").slice(0, 72)),
    `実測メモの塊が重複している: ${重複.length} 箇所`,
  ).toEqual([]);
});
