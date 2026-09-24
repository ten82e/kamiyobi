/**
 * 案内が画面の実物の語を使っているかの検査（SPEC §7・第 271 回）。
 *
 * 2026-08-09 生成ビルドで実測した形：
 *   - てびきは CSV の項目で「残りは**表の下に出るボタン**で足します」と言っていたが、
 *     そのボタンは画面上 **さらに表示 (残り N 件)** と出る。ボタン名はどこにも書かれて
 *     おらず、てびきを読んだ人は目の前のボタンと対応づけられなかった。
 *   - 「締切まで」の項目も「締切日からの日数で絞ります」とだけ言い、実際の選択肢
 *     （かまわない・7 日以内・30 日以内・90 日以内・180 日以内）を一つも挙げていなかった。
 *   - `upcoming.md`（1,126 行）は前置きで「`index.html` の表が同じ式で出すので…そちらが早い」
 *     と**名指しするだけ**で、リンクが 1 本も無かった（ビルド実測: index.html へのリンク 0 本）。
 *     GitHub の生的な表示ではコードspan になるだけで辿れない。
 *   - 表の最後まで読むと出口も無く、そこで終わりだった。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";

function page(name: string): string {
  return readFileSync(join(site, name), "utf8");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
}

/** 画面（`index.html`）の中の「見方のてびき」を、タグを落として返す。 */
function guideText(): string {
  const mk = page("index.html").replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, "");
  const panel = /<details class="help"[\s\S]*?<\/details>/.exec(mk);
  expect(panel, "てびきが見つからない").toBeTruthy();
  return stripTags(panel![0]);
}

/**
 * てびきの特定の項目（`<dt>` と、それに続く `<dd>`）だけを、タグを落として返す。
 * 項目を問わずガイド全体を見ると、他の項目の例文が語を拾ってしまうので、
 * 「その項目が言っている」まで見るために使う（第 271 回の改ざんで実発生:
 * 「締切まで 7 日以内」を項目から消しても、別の項目の例文に残って通ってしまった）。
 */
function guideEntry(term: string): string {
  const mk = page("index.html").replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, "");
  const m = new RegExp(`<dt>${term}</dt>\\s*<dd>([\\s\\S]*?)</dd>`).exec(mk);
  expect(m, `てびきに「${term}」の項目が無い`).toBeTruthy();
  return stripTags(m![1]);
}

/** 画面に実際に並ぶ「締切まで」の選択肢（検査側に書き写さない）。 */ function windowChoices(): string[] {
  const m = /<select\b[^>]*\bid="win"[^>]*>([\s\S]*?)<\/select>/.exec(page("index.html"));
  expect(m, "「締切まで」の選択欄が無い").toBeTruthy();
  const opts = [...m![1].matchAll(/<option value="[^"]*"[^>]*>([^<]*)<\/option>/g)].map((x) =>
    x[1].trim(),
  );
  expect(opts.length, "選択肢が読めない").toBeGreaterThanOrEqual(4);
  return opts;
}

describe("案内は画面の実物の語を使っている（第 271 回）", () => {
  it("てびきが続け方を教えるボタンを、画面と同じ名で名指している", () => {
    const mk = page("index.html").replace(
      /<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g,
      "",
    );
    const btn = /<button id="more"[^>]*>([^<]*)<\/button>/.exec(mk);
    expect(btn, "表の下のボタンが無い").toBeTruthy();
    const label = btn![1].trim();
    expect(label, "ボタンの語が空").not.toBe("");
    expect(guideText(), `てびきが画面のボタン「${label}」を名指していない`).toContain(label);
    // ラベルは実行時に残り件数を足す形（「さらに表示 (残り N 件)」）なので、語の本体も揃っている。
    const js = page("app.js");
    expect(js, "実行時のラベルがボタンの語と違う物になった").toContain(`\`さらに表示 (残り `);
  });

  it("「締切まで」の項目が、実際の選択肢をすべて名乗っている", () => {
    // 項目をまたいで語が拾えると検査が空振りになるので、この項目の中で揃っていることを見る。
    const entry = guideEntry("締切まで");
    const missing = windowChoices().filter((c) => !entry.includes(c));
    expect(
      missing,
      `「締切まで」の項目が名乗っていない選択肢がある: ${missing.join("、")}`,
    ).toEqual([]);
  });

  it("早め絞り込みのボタンは、画面に出るボタン名をすべて項目で名乗っている", () => {
    const mk = page("index.html");
    const labels = [...mk.matchAll(/data-preset="[^"]+"[^>]*>([^<]*)<\/button>/g)]
      .map((m) => m[1].trim())
      .filter((v, i, xs) => v && xs.indexOf(v) === i);
    expect(labels.length, "クイック抽出のボタンが読めない").toBeGreaterThanOrEqual(4);
    const entry = guideEntry("早め絞り込みのボタン");
    const missing = labels.filter((v) => !entry.includes(v));
    expect(missing, `項目が名乗っていないボタンがある: ${missing.join("、")}`).toEqual([]);
  });

  it("「表の下に出る」という案内が噓ではない（ボタンは実際に表よりうしろにある）", () => {
    const mk = page("index.html").replace(
      /<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g,
      "",
    );
    expect(mk.indexOf('<button id="more"'), "ボタンが表より前に有る").toBeGreaterThan(
      mk.lastIndexOf("</table>"),
    );
  });

  it("マークダウンの前置きは、名指すだけでなく辿れるリンクにしている", () => {
    const md = page("upcoming.md");
    const head = md.slice(0, md.indexOf("\n|"));
    const link = /\[([^\]]+)\]\(index\.html\)/.exec(head);
    expect(link, "前置きの指し先がリンクになっていない（生的な表示で辿れない）").toBeTruthy();
    expect(link![1], "何がもらえるのか言わないリンク文").toContain("index.html");
    expect(head, "前置きが画面の利点を言わなくなった").toContain("早い");
    expect(existsSync(join(site, "index.html")), "指す先がビルド先に無い").toBe(true);
  });

  it("マークダウンの終端にも出口が有り、言い回しは `upcoming.html` と同じ正本", () => {
    const md = page("upcoming.md");
    const lastRow = md.lastIndexOf("\n| ");
    const exit = md.slice(lastRow);
    const link = /\[([^\]]+)\]\(index\.html\)/.exec(exit);
    expect(
      link,
      "最後の行のうしろに出口が無い（1,000 行超の表の最後まで来て打ち切り）",
    ).toBeTruthy();
    // 同じ語を 2 か所に持たない方針: HTML 側は矢印を足すので、同じ正本から組まれている
    // ことは「終端のリンク文言がこの語で終わっている」ことで確かめる。
    const html = page("upcoming.html");
    const anchors = [...html.matchAll(/<a href="index\.html">([^<]*)<\/a>/g)].map((m) => m[1]);
    expect(anchors.length, "HTML 側の戻る口が減っている").toBeGreaterThanOrEqual(2);
    expect(
      anchors[anchors.length - 1].endsWith(link![1]),
      `マークダウンだけが別の言い回しをしている（HTML: ${anchors[anchors.length - 1]}）`,
    ).toBe(true);
    expect(exit, "出口が何をしてくれるか言わない").toContain("絞り込み");
  });
});
