/**
 * 色のコントラストの検査（SPEC §7・第 261 回）。
 *
 * WCAG 1.4.3 は、本文サイズの文字（この画面で 11.5 〜 14 px の語はすべて該当）に
 * **4.5:1 以上**を要求する（https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html）。
 * ビルド済み `index.html` のスタイルを読み取り、実際の描画で重なる色の組について比を出す
 * （`rgba(…, 0.06)` のような半透明の背景は、後ろの色と合成したうえで数える）。
 *
 * 2026-08-09 生成ビルドで実測した不合格:
 *   - ダークモードの「主題が合う」の緑（`.tag.match`） 2.65  ← ほぼ読めない
 *   - ライトモードの `.tag.est`（推定） 4.01 / `.tag.match` 4.26 / `.tag.past` 4.29
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";

const MIN_RATIO = 4.5;

function cssText(): string {
  const html = readFileSync(join(site, "index.html"), "utf8");
  /* `match(/…/g)` は捕獲グループを無視して全体一致だけ返す（`<style>` の語が
     残って `:root` が読めなくなった – 実発生）。`matchAll` で中身だけ集める。 */
  return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => String(m[1])).join("\n");
}

type Rgb = [number, number, number];

function hexToRgb(value: string): Rgb | null {
  const h = value.trim().replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** `rgba(15, 122, 85, 0.08)` を解析する（`var(--…)` は呼び出し側で解決する）。 */
function rgbaToParts(value: string): [number, number, number, number] | null {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/]+\s*([\d.]+))?\s*\)/.exec(value);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}

function composite(fg: [number, number, number, number], base: Rgb): Rgb {
  const a = fg[3];
  return [
    a * fg[0] + (1 - a) * base[0],
    a * fg[1] + (1 - a) * base[1],
    a * fg[2] + (1 - a) * base[2],
  ];
}

function luminance(rgb: Rgb): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

function ratio(fg: Rgb, bg: Rgb): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
}

/** `:root { --x: #…; }` の塊を解決済みの色で返す。 */
function rootVars(css: string, dark: boolean): Record<string, string> {
  const head = dark
    ? /@media \(prefers-color-scheme: dark\) (?:[\s\S]{0,40}?)\{([\s\S]*?)\n\}/
    : /(^|\})\s*:root\s*\{([\s\S]*?)\}/;
  const m = head.exec(css);
  const body = m ? (dark ? String(m[1]) : String(m[2])) : "";
  const out: Record<string, string> = {};
  for (const pair of body.matchAll(/(--[a-z0-9-]+):\s*([^;}]+)/g)) {
    out[pair[1]] = pair[2].trim();
  }
  return out;
}

/** 規則の本文から `color` / `background` を拾う。 */
function decl(body: string, prop: string): string | null {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body);
  return m ? m[1].trim() : null;
}

function ruleBodies(css: string, selector: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = String(m[1])
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\s+/g, " ")
      .trim();
    const parts = sel
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (parts.includes(selector)) out.push(String(m[2]).replace(/\s+/g, " ").trim());
  }
  return out;
}

/** `var(--x)` を解決し、`#hex` / `rgba()` を RGB に直す（半透明は base と合成）。 */
function resolve(declared: string, vars: Record<string, string>, base: Rgb, depth = 0): Rgb | null {
  if (depth > 4) return null;
  const text = declared.trim();
  const varRef = /^var\((--[a-z0-9-]+)\)$/.exec(text);
  if (varRef) {
    const next = vars[varRef[1]];
    return next ? resolve(next, vars, base, depth + 1) : null;
  }
  const hex = hexToRgb(text);
  if (hex) return hex;
  const rgba = rgbaToParts(text);
  if (rgba) return composite(rgba, base);
  return null;
}

/** 宣言された色の文字列（`var(--x)` / `#hex` / `rgba()`）どうしの比を検査に足す。 */
function compareDecls(
  vars: Record<string, string>,
  colorDeclared: string,
  bgDeclared: string,
  label: string,
  weak: string[],
  seen: string[],
): void {
  const base = resolve(bgDeclared, vars, [255, 255, 255]);
  const fg = resolve(colorDeclared, vars, base || [255, 255, 255]);
  if (!fg || !base) {
    weak.push(`${label}: 色を解釈できない（${colorDeclared} / ${bgDeclared}）`);
    return;
  }
  const value = ratio(fg, base);
  seen.push(`${label} = ${String(value)}`);
  if (value < MIN_RATIO) {
    weak.push(
      `${label} のコントラストが ${String(value)}（文字 ${colorDeclared} / 背景 ${bgDeclared}）`,
    );
  }
}

function checkPair(
  css: string,
  vars: Record<string, string>,
  selector: string,
  label: string,
  weak: string[],
  seen: string[],
): void {
  const bodies = ruleBodies(css, selector);
  if (!bodies.length) {
    weak.push(`${label}: 規則が見つからない（画面から消えた？）`);
    return;
  }
  /* 同じ規則が複数ある（`.tag` + `.tag.est`）ので、後勝ちではなく**最後に見つかった色**と、
   * 背景が使えるかを順に確かめる。この画面では上書き順が一定なので十分。 */
  const colorBody = [...bodies].reverse().find((b) => decl(b, "color"));
  const bgBody = [...bodies]
    .reverse()
    .find((b) => decl(b, "background") || decl(b, "background-color"));
  const colorDeclared = colorBody ? decl(colorBody, "color") : null;
  const bgDeclared = bgBody ? decl(bgBody, "background") || decl(bgBody, "background-color") : null;
  if (!colorDeclared || !bgDeclared) {
    weak.push(`${label}: 文字色または背景が読めない`);
    return;
  }
  const baseVars = vars["--chip"] || "#ffffff";
  const base = resolve(String(bgDeclared), vars, hexToRgb(baseVars) || [255, 255, 255]);
  const fg = resolve(colorDeclared, vars, base || [255, 255, 255]);
  if (!fg || !base) {
    weak.push(`${label}: 色を解釈できない（${colorDeclared} / ${bgDeclared}）`);
    return;
  }
  const value = ratio(fg, base);
  seen.push(`${label} = ${String(value)}`);
  if (value < MIN_RATIO) {
    weak.push(
      `${label} のコントラストが ${String(value)}（文字 ${colorDeclared} / 背景 ${bgDeclared}）`,
    );
  }
}

it("画面の語と背景のコントラストは 4.5 以上（WCAG 1.4.3・SPEC §7）", () => {
  const css = cssText();
  const weak: string[] = [];
  const seen: string[] = [];

  const light = rootVars(css, false);
  expect(Object.keys(light).length, ":root の色が見つからない").toBeGreaterThan(6);
  const dark = { ...light, ...rootVars(css, true) };
  expect(Object.keys(dark).length, "ダークモードの色が見つからない").toBeGreaterThan(6);

  /* 行の詳細・候補のカードに並ぶ小さな語（11.5 px）。本文（14 px）は次の検査で見る。 */
  const cases: Array<[string, Record<string, string>]> = [
    ["ライト", light],
    ["ダーク", dark],
  ];
  const tags: Array<[string, string]> = [
    ["タグ（推定）", ".tag.est"],
    ["タグ（主題が合う）", ".tag.match"],
    ["タグ（過去）", ".tag.past"],
    ["タグ（既定）", ".tag"],
  ];
  cases.forEach(([themeName, vars]) => {
    tags.forEach(([label, selector]) => {
      checkPair(css, vars, selector, `${themeName} ${label}`, weak, seen);
    });
  });
  /* 主題として決めている色そのものも総当たりで見る（薄い背景を持つ規則だけでなく、
   * 表の本文・件数欄・語の見出しなど、画面じゅうで 4.5 以上を要求される）。 */
  const themeColors = ["--fg", "--muted", "--accent", "--warn", "--soon", "--ok"];
  const themeBgs = ["--bg", "--panel", "--chip"];
  cases.forEach(([themeName, vars]) => {
    themeColors.forEach((color) => {
      expect(vars[color], `${themeName} の ${color} が決まっていない`).toBeTruthy();
      themeBgs.forEach((bg) => {
        compareDecls(
          vars,
          `var(${color})`,
          `var(${bg})`,
          `${themeName} ${color} on ${bg}`,
          weak,
          seen,
        );
      });
    });
  });

  /* 背景を自分で持たない規則（理由チップの中の語・内訳行の投稿先）。後ろの色の
   * 一番不利な方で見る（表は --bg、詳細パネルは --panel に載ることがある）。 */
  cases.forEach(([themeName, vars]) => {
    themeBgs.forEach((bg) => {
      compareDecls(
        vars,
        "var(--ok)",
        `var(${bg})`,
        `${themeName} 内訳行の投稿先 on ${bg}`,
        weak,
        seen,
      );
    });
    compareDecls(
      vars,
      "var(--ok)",
      String(decl(ruleBodies(css, ".reason-chip").join(";"), "background") || "var(--chip)"),
      `${themeName} 理由チップの語`,
      weak,
      seen,
    );
  });

  /* 空振り防止: テーマの総当たり（2 × 6 × 3）+ タグ（2 × 4）+ 上の 2 種別（2 × 4）。 */
  expect(
    seen.length,
    `読み取れた色の組が少ない（${String(seen.length)} 組）`,
  ).toBeGreaterThanOrEqual(52);
  expect(weak.join("\n"), "").toBe("");
});

it("半透明の背景でも数えられる（ rgba を合成して比べる）", () => {
  /* 検査自体の作り込みの確認: `.tag.est` の背景は `rgba(…, 0.06)` – 合成しないで数えると
   * 実際の画面よりよく見える（白い背景に薄い緑を混ぜた色より、後ろが暗いほうが読みにくい）。 */
  const css = cssText();
  const est = ruleBodies(css, ".tag.est").find((b) => decl(b, "background"));
  expect(est, ".tag.est の背景が見つからない").toBeTruthy();
  expect(rgbaToParts(String(decl(String(est), "background")))?.[3]).toBeLessThan(1);
});

/** `@media print { … }` のような塊を括弧の対応で丸ごと落とす（紙では出ないものまで
 * 数えない – 紙用に薄い色へ差し替えた規則が並んでいる）。 */
function stripBlock(css: string, head: string): string {
  const at = css.indexOf(head);
  if (at < 0) return css;
  let depth = 0;
  const open = css.indexOf("{", at);
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(0, at) + css.slice(i + 1);
    }
  }
  return css;
}

/** 宣言を (色, アルファ) に直す。**`var()` を解決してから**アルファを見る
 * （`--accent-subtle` は `rgba(...)` を持つ – 解決前に見ると半透明と気づけない）。 */
function resolveAlpha(
  declared: string,
  vars: Record<string, string>,
  depth = 0,
): [Rgb, number] | null {
  if (depth > 5) return null;
  const text = declared.trim();
  const varRef = /^var\((--[a-z0-9-]+)\)$/.exec(text);
  if (varRef) {
    const next = vars[varRef[1]];
    return next ? resolveAlpha(next, vars, depth + 1) : null;
  }
  /* 「背景を敷かない」という指定は、後ろの色がそのまま見える（アルファ 0）。
   * これを「解釈できない」と誤ると、`background: transparent` の語が数えられない。 */
  if (text === "transparent") return [[255, 255, 255], 0];
  const hex = hexToRgb(text);
  if (hex) return [hex, 1];
  const parts = rgbaToParts(text);
  return parts ? [[parts[0], parts[1], parts[2]], parts[3]] : null;
}

it("同じ規則に文字色と背景を持つ語を総当たりで見る（第 262 回）", () => {
  const cssAll = cssText();
  const css = stripBlock(cssAll, "@media print");
  expect(css, "紙用の塊を落とせなかった").not.toContain("@media print");

  const light = rootVars(css, false);
  const dark = { ...light, ...rootVars(css, true) };
  const weak: string[] = [];
  const skipped: string[] = [];
  const seenSelectors: string[] = [];
  let read = 0;

  const themes: Array<[string, Record<string, string>]> = [
    ["ライト", light],
    ["ダーク", dark],
  ];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = String(m[1])
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\s+/g, " ")
      .trim();
    const body = `;${String(m[2]).replace(/\s+/g, " ").trim()}`;
    const color = decl(body, "color");
    const background = decl(body, "background") || decl(body, "background-color");
    if (!color || !background) continue;
    themes.forEach(([themeName, vars]) => {
      const bg = resolveAlpha(background, vars);
      const fg = resolveAlpha(color, vars);
      if (!bg || !fg) {
        /* 解釈できない宣言（`currentColor` 等）。今は無いので、増えたら気づけるように数える。 */
        skipped.push(`${themeName} ${selector}（${color} / ${background}）`);
        return;
      }
      /* 半透明の背景は「後ろ」が何になるか規則だけで決まらないので、画面の広い色
         （--bg / --panel / --chip）のうち**一番不利な組合せ**で数える。 */
      const underNames = ["--bg", "--panel", "--chip"];
      const unders = underNames
        .map((n) => resolveAlpha(`var(${n})`, vars))
        .filter((x): x is [Rgb, number] => x !== null)
        .map((x) => x[0]);
      const values: number[] = [];
      if (bg[1] < 1) {
        unders.forEach((under) => {
          const bgFinal = composite([bg[0][0], bg[0][1], bg[0][2], bg[1]], under);
          const fgFinal =
            fg[1] < 1 ? composite([fg[0][0], fg[0][1], fg[0][2], fg[1]], bgFinal) : fg[0];
          values.push(ratio(fgFinal, bgFinal));
        });
      } else {
        const fgFinal = fg[1] < 1 ? composite([fg[0][0], fg[0][1], fg[0][2], fg[1]], bg[0]) : fg[0];
        values.push(ratio(fgFinal, bg[0]));
      }
      const worst = Math.min(...values);
      read += 1;
      seenSelectors.push(selector);
      if (worst < MIN_RATIO) {
        weak.push(
          `${themeName} ${selector} のコントラストが ${String(worst)}（文字 ${color} / 背景 ${background}）`,
        );
      }
    });
  }
  /* 空振り防止: 画面には文字色と背景を同時に持つ規則が十分に有る（2026-08-09 ビルドで 22 規則）。 */
  expect(read, `読み取れた規則が少ない（${String(read)} 組）`).toBeGreaterThanOrEqual(30);
  /* 数え損ねた宣言は 0 件のままとする（増えたら検査の作り込みを直す合図）。 */
  expect(skipped.join("\n"), "色として解釈できない宣言が増えた").toBe("");
  /* 「読めた数」だけでは、規則の名前が変わって静かに抜けると気づけない。画面で実際に
   * 薄い背景を敷いている規則を名前で指しておき、消えたら落ちるようにする（空振り防止）。 */
  const EXPECTED = [
    ".skip-link",
    ".brand-badge",
    ".month-row th",
    ".tag.match",
    ".tag.est",
    ".tag.past",
    ".chips label",
  ];
  const missing = EXPECTED.filter(
    (want) =>
      !seenSelectors.some((sel) =>
        sel
          .split(",")
          .map((p) => p.trim())
          .includes(want),
      ),
  );
  expect(missing.join("\n"), "薄い背景を敷く規則が見つからない").toBe("");
  expect(weak.join("\n"), "").toBe("");
});
