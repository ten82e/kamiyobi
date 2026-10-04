/**
 * 電話で打つ人が、検索欄を押されただけで画面を拡大されないための検査（SPEC §7・第 259 回）。
 *
 * iOS の Safari は、**文字の大きさが 16 px 未満の入力欄**に焦点が当たると画面を自動で
 * 拡大する（拡大すると表が見えなくなり、もどす操作が追加される）。入力の文字を大きく
 * するのが直し方で、`viewport` に `maximum-scale` を足して拡大自体を止めるのは
 * 拡大したい人の操作も奪うので使わない。
 * 根拠（実装の言い合わせとして残す）:
 *   - https://github.com/saadeghi/daisyui/issues/3871
 *   - https://github.com/heroui-inc/heroui/issues/5326
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";

/* 入力欄の文字の最低の大きさ（px）。iOS が自動拡大を始める境目。 */
const MIN_INPUT_FONT_PX = 16;
/* `:root` に `font-size` が無いときの基準（ブラウザ既定）。 */
const ROOT_FONT_PX = 16;

/** `<style>` の中から平坦な規則（`セレクタ { 本文 }`）を取り出す。 */
function cssRules(css: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (;;) {
    const m = re.exec(css);
    if (!m) break;
    const body = m[2];
    /* `@media` の頭（本文をさらに規則として読むので、条件の行は規則として数えない）。 */
    if (/@media|@supports/.test(m[1]) && !body.includes(";")) continue;
    if (!body.includes(";") && !body.includes(":")) continue;
    rules.push({ selector: m[1].replace(/\s+/g, " ").trim(), body });
  }
  return rules;
}

/** `1rem` `14px` `0.88rem` などの指定を px に直す（`calc` 等は扱わない – 見つけたら報告）。 */
function toPx(declared: string): number | null {
  const value = declared.trim();
  const rem = /^([\d.]+)rem$/.exec(value);
  if (rem) return Number(rem[1]) * ROOT_FONT_PX;
  const px = /^([\d.]+)px$/.exec(value);
  if (px) return Number(px[1]);
  return null;
}

/* 直接入力欄を構えるセレクタ（画面に実際に在るものだけ）。 */
const EDITABLE_SELECTORS = ["input[type=search]", "input[type=text]", "select", "textarea"];

/* `input[type="search"]` と `input[type=search]` は同じものなので、引用符を落として比べる。 */
const plain = (value: string): string => value.replace(/["']/g, "").replace(/\s+/g, "");

it("入力欄の文字は 16 px 以上（押されただけで画面が拡大されない – SPEC §7）", () => {
  const html = readFileSync(join(site, "index.html"), "utf8");
  const css = (html.match(/<style>([\s\S]*?)<\/style>/g) || []).join("\n");
  expect(css, "画面にスタイルが見つからない").toContain("font-size");
  const rules = cssRules(css);
  expect(rules.length, "スタイルの規則を読み取れていない").toBeGreaterThan(40);

  /* 基準の文字サイズを固定しておく（`:root` で変えていたら 16 px 前提が崩れる）。 */
  const rootSize = /:root\s*\{[^}]*font-size:\s*([^;}]+)/.exec(css);
  expect(
    rootSize ? String(toPx(String(rootSize[1] || ""))) : "既定 16",
    "`:root` の文字サイズが変わっている（この検査の px 換算を見直す）",
  ).toBe("既定 16");

  const checked: string[] = [];
  const weak: string[] = [];
  rules.forEach((rule) => {
    EDITABLE_SELECTORS.forEach((target) => {
      const parts = rule.selector.split(",").map((p) => plain(p));
      if (!parts.includes(plain(target))) return;
      const declared = /(?:^|;)\s*font-size:\s*([^;]+)/.exec(`;${rule.body.replace(/\s+/g, " ")}`);
      if (!declared) return;
      const px = toPx(String(declared[1] || ""));
      checked.push(`${target} → ${String(declared[1]).trim()}`);
      if (px === null) {
        weak.push(`${target} の文字サイズが判別できない（${String(declared[1]).trim()}）`);
      } else if (px < MIN_INPUT_FONT_PX) {
        weak.push(`${target} の文字が ${px} px（${String(declared[1]).trim()}）しかない`);
      }
    });
  });
  /* 検査が空振りしていないこと（画面の入力欄の文字サイズを実際に読んでいる）。 */
  expect(checked.length, "入力欄の文字サイズを 1 つも読んでいない").toBeGreaterThanOrEqual(
    EDITABLE_SELECTORS.length,
  );
  expect(weak.join("\n"), "").toBe("");
});

it("拡大を止めるのではなく文字を大きくしている（viewport の約束）", () => {
  const html = readFileSync(join(site, "index.html"), "utf8");
  /* `maximum-scale` / `user-scalable=no` は、拡大したい人の操作も奪う（WCAG 1.4.4）。
   * 拡大の問題は入力欄の文字を大きくして解くので、viewport に拡大制限を戻さない。 */
  expect(html).not.toMatch(/maximum-scale/i);
  expect(html).not.toMatch(/user-scalable\s*=\s*no/i);
});
