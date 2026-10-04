/**
 * 画面で読む注記の文字サイズが、日本語が潰れない床を守っているかの検査（SPEC §7・第 278 回）。
 *
 * 2026-09-24 にビルド成果物で実測した形:
 *   - 当たり方の説明 `.reason-why` が 0.7rem = **11.2px** で、サイト全体でも最も小さい部類だった。
 *     この説明は第 262 回まで `title` の注記にしか無く、「タッチ端末と読み上げで読めない」ので
 *     常に出す形へ直した物なのに、出した先が画面で一番小さい字だった。
 *   - 同じ 0.7rem が当たった要素名の列 `.perline-parts` にも乗り、当たり方のチップ
 *     `.reason-chip`（0.72rem）と「過去掲載先一致 …」（`.perline-venue` 0.72rem）が
 *     その下の階層で小さく読まれていた。
 *   - 数字だけの連番 `.perline-idx` は 0.7rem のままで足りる（仮名が潰れる問題ではないため）。
 *     その例外もここに書いて、後から同じ床に巻き込まれないようにする。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssBlocks, effectiveCss, site } from "./built_golden_shared.ts";

function css(): string {
  const html = readFileSync(join(site, "index.html"), "utf8");
  const blocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  expect(blocks.length, "画面の CSS が見つからない").toBeGreaterThan(0);
  return blocks.join("\n");
}

/** `--fs-note` の値を px に直す（rem は既定の 16px 換算）。 */
function notePx(src: string): number {
  const m = /--fs-note:\s*([0-9.]+)rem/.exec(
    cssBlocks(src)
      .map((b) => `${b.selector}{${b.body}}`)
      .join("\n"),
  );
  expect(m, "注記の文字サイズの取り決め（`--fs-note`）が無い").toBeTruthy();
  return Number(m![1]) * 16;
}

function pxOf(value: string | null): number | null {
  if (!value) return null;
  const rem = /^([0-9.]+)rem$/.exec(value);
  if (rem) return Number(rem[1]) * 16;
  const px = /^([0-9.]+)px$/.exec(value);
  if (px) return Number(px[1]);
  return null;
}

/* 日本語の語を読む欄（当たり方の説明・当たった要素の名前・過去の掲載先の呼び出し）。
 * これらは行の詳細の中で本文として読まれるので、数字だけの欄と違って床が必要。 */
const PROSE = [".reason-why", ".reason-chip", ".perline-parts", ".perline-venue"];

describe("注記の字が日本語で読める床を保つ（第 278 回）", () => {
  it("取り決めの値が 12px の床を割っていない", () => {
    expect(notePx(css())).toBeGreaterThanOrEqual(12);
  });

  it("日本語を読む欄は、幅 1280px でも 390px でも床以上で出る", () => {
    /* 画面幅で小さくし直す規則（`@media (max-width: …)`）が下から効くことがあるので、
     * 大きい画面とスマホの両方で見る（狭い画面ほど小さい字はきつい）。 */
    const src = css();
    const floor = notePx(src);
    for (const width of [1280, 390]) {
      for (const sel of PROSE) {
        const used = effectiveCss(src, sel, "font-size", width);
        expect(used, `${sel} に文字サイズの指定が無い（幅 ${width}px）`).toBeTruthy();
        let px = pxOf(String(used));
        if (px === null && /var\(--fs-note\)/.test(String(used))) px = floor;
        expect(px, `${sel} の文字サイズが読めない（幅 ${width}px・${used}）`).not.toBeNull();
        expect(px!, `${sel} が ${width}px で ${px}px に縮んでいる`).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it("床が 1 個の語に寄っていて、規則ごとに数字を書き写していない", () => {
    const src = css();
    for (const sel of PROSE) {
      const used = String(effectiveCss(src, sel, "font-size", 1280));
      expect(used, `${sel} が --fs-note を読まない（数値の書き写し）`).toContain("--fs-note");
    }
  });

  it("数字だけの連番は、意図的に床より小さい（例外を書いて置く）", () => {
    /* `.perline-idx` は行の連番（1, 2, 3 …）だけで、仮名が潰れる問題ではない。
     * 例外を検査に書いておかないと、次の人が床に巻き戻して幅を食う。 */
    const src = css();
    const used = String(effectiveCss(src, ".perline-idx", "font-size", 1280));
    expect(used, "連番の文字サイズが消えた").toMatch(/^0\.7rem$/);
  });

  it("当たり方の説明は、画面に実際に出る（隠した規則に戻していない）", () => {
    const src = css();
    const body = cssBlocks(src).find((b) => b.selector === ".reason-why")?.body || "";
    expect(body, ".reason-why の規則が無い").toBeTruthy();
    expect(body, "当たり方の説明が画面から消えている").not.toMatch(/display:\s*none/);
    const app = readFileSync(join(site, "app.js"), "utf8");
    expect(app, "当たり方の説明を出す組み立てが無い").toContain('class="reason-why"');
    // 説明の文字を CSS で画面外へ追放する手（絶対配置ではみ出す）も見る。
    expect(body, "説明が画面外へ追放されている").not.toMatch(/position:\s*absolute/);
  });
});
