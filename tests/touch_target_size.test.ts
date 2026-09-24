/**
 * 指で押す端末で、操作できるものが十分に大きいための検査（SPEC §7・第 260 回）。
 *
 * ビルド済み画面のスタイルから高さを測ると、チェック欄が約 19.7 px、主題の絞り込みボタンが
 * 約 17.8 px しかなかった（上余白 + 下余白 + 文字の高さ + 枠）。WCAG 2.5.8 は
 * **24 × 24 CSS px 以上**を要求するので、この 2 つは届いていなかった
 * （https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html）。
 * 広げるのは `@media (hover: none), (pointer: coarse)` の中だけ – 幅ではなく操作手段で
 * 分ける（パソコンの見た目を太くしない。第 85 回と同じ分け方）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";

/* 指で押すときに確保したい高さ（px）。Apple の Human Interface Guidelines が 44 pt。 */
const MIN_TOUCH_HEIGHT = 44;

/* 広げる対象（画面で実際に押せるもの。表の中の情報チップは押せないので数えない）。 */
const TOUCH_TARGETS = [
  ".sortbar button",
  ".mode-switch button",
  ".btn-reset",
  ".preset-btn",
  ".sample-btn",
  ".chips label",
  "label.check",
  "button.tag",
];

function cssText(): string {
  const html = readFileSync(join(site, "index.html"), "utf8");
  return (html.match(/<style>([\s\S]*?)<\/style>/g) || []).join("\n");
}

/** `@media … { … }` の本体を括弧の対応で取り出す（中に入った規則もまとめて返す）。 */
function mediaBody(css: string, head: string): string | null {
  const at = css.indexOf(head);
  if (at < 0) return null;
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

/** スタイル塊から `セレクタ … { 本文 }` を平坦に並べる（注釈は落とす）。 */
function rulesIn(chunk: string): Array<{ selector: string; body: string }> {
  const clean = chunk.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (;;) {
    const m = re.exec(clean);
    if (!m) break;
    if (!m[2].includes(":")) continue;
    out.push({
      selector: m[1].replace(/\s+/g, " ").trim(),
      body: m[2].replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

it("指で押す端末では操作対象の高さが 44 px ある（SPEC §7）", () => {
  const css = cssText();
  const head = "@media (hover: none), (pointer: coarse) {";
  const body = mediaBody(css, head);
  expect(body, "操作手段で分けるスタイルの块が見つからない（条件の書き方を見直す）").toBeTruthy();
  const block = String(body);

  /* 分け方は「操作手段」でなければならない（幅で分けると、パソコンの窓を狭くした人が
   * 指で押さないまま太い画面を開く – 第 85 回）。 */
  expect(head).toContain("pointer: coarse");
  expect(head, "幅で操作手段を分け始めたらこの検査で止める").not.toContain("max-width");

  const heights: Record<string, number> = {};
  const read: string[] = [];
  rulesIn(block).forEach((rule) => {
    TOUCH_TARGETS.forEach((target) => {
      const parts = rule.selector.split(",").map((p) => p.trim());
      if (!parts.includes(target)) return;
      const declared = /min-height:\s*([\d.]+)px/.exec(rule.body);
      /* 対象に付いた規則は複数ありうる（高さの規則と見た目の規則）。**一番大きくした値**が
       * 実際に効く高さなので、それで判断する（見た目の規則だけ見て「高さ未指定」と誤らない）。 */
      read.push(target);
      heights[target] = Math.max(heights[target] || 0, declared ? Number(declared[1]) : 0);
    });
  });
  const weak = TOUCH_TARGETS.filter((target) => (heights[target] || 0) < MIN_TOUCH_HEIGHT).map(
    (target) => `${target} の高さが ${String(heights[target] || 0)} px しかない`,
  );
  /* 空振り防止: 対象を 1 つも読んでいないなら検査自体が壊れている。 */
  expect(
    new Set(read).size,
    `操作対象の高さを読み取れた数が少ない（${new Set(read).size} / ${TOUCH_TARGETS.length} 対象）`,
  ).toBe(TOUCH_TARGETS.length);
  expect(weak.join("\n"), "").toBe("");
});

it("パソコン側の見た目は太らせない（44 px は指で押す端末だけ）", () => {
  const css = cssText();
  /* 操作手段の块の外（＝パソコンも含む既定）に 44 px を入れると、パソコンの絞り込み欄が
   * 縦に太くなる。既定側は従来のまま（実測 17.8 〜 34.3 px）であることをここで見張り、
   * 広い画面の見た目を変えたら気づけるようにする。 */
  let outside = css;
  const block = mediaBody(css, "@media (hover: none), (pointer: coarse) {");
  if (block !== null)
    outside = css.replace(`@media (hover: none), (pointer: coarse) {${block}}`, "");
  const fat: string[] = [];
  rulesIn(outside).forEach((rule) => {
    TOUCH_TARGETS.forEach((target) => {
      if (
        !rule.selector
          .split(",")
          .map((p) => p.trim())
          .includes(target)
      )
        return;
      const declared = /min-height:\s*([\d.]+)px/.exec(rule.body);
      if (declared && Number(declared[1]) >= MIN_TOUCH_HEIGHT) {
        fat.push(`${target} が既定で ${declared[1]} px になっている`);
      }
    });
  });
  expect(fat.join("\n"), "").toBe("");
});
