/**
 * 幅の狭い画面で締切の一覧が横幅を越えたときの案内と、キーボードでの動き方の検査（SPEC §7・第 265 回）。
 *
 * 2026-08-09 生成ビルドで実測した形：
 *   - `table { min-width: 880px }` / 7 列（収録 687 会議）
 *   - 640 px 以下は行がカードになるので越えない（`@media (max-width: 640px)`）
 *   - **641〜879 px だけ**横スクロールが起きる（iPad 縦持ち 768・810・834、画面を半分に割った窓、
 *     拡大表示）。この幅が、右に続きがあると気づけないまま左端だけ読む状態だった
 *   - `overflow-x: auto` の箱は既定でフォーカスされないので、キーボードでは動かせなかった
 *     （WCAG 2.1.1 操作可能性）
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";
import { jsFunction, siteRuntime, vmSafeSource } from "./runtime_extract.ts";

/* ------------------------------------------------------------------ 画面の形 */

/* `site` は共有ハーネスの `beforeAll` で決まるので、読むのは検査の中でする。 */
function pageHtml(): string {
  return readFileSync(join(site, "index.html"), "utf8");
}
function cssText(): string {
  return [...pageHtml().matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
}

describe("横幅を越えた表の案内（第 265 回）", () => {
  it("案内の場はスクロール面の外にあり、既定では隠れている", () => {
    const page = pageHtml();
    const hint = /<p class="scrollhint" id="tableScrollHint" hidden><\/p>/.exec(page);
    expect(hint, "案内の <p> が無い").toBeTruthy();
    // 中に置き直す改ざん（外に残したまま中にも置く）を検めるため、同じ id は 1 個だけを見る。
    expect(
      page.match(/id="tableScrollHint"/g)?.length,
      "案内の場が 2 つ有る（同じ id は HTML として誤り。中に置き直した可能性）",
    ).toBe(1);
    const wrap = page.indexOf('<div class="tablewrap" id="deadlineTableWrap">');
    expect(wrap, "スクロール面の箱が見つからない").toBeGreaterThan(-1);
    // 中に入れると自分でスクロールして消えるので、箱の外（直前）に置く。
    expect(hint!.index, "案内がスクロール面より後に有る").toBeLessThan(wrap);
    expect(page.slice(hint!.index, wrap), "案内が箱の直後に置いていない").toContain("</p>");
    // 紙には出さない（紙は横に越えない）。
    const print = /@media print\s*\{[\s\S]*?\n\}/.exec(cssText())?.[0] ?? "";
    expect(print, "印刷用の規則が見つからない").not.toBe("");
    expect(print, "案内が紙にも刷られる").toContain("#tableScrollHint");
  });

  it("スクロール面は横に動かせる形のまま、焦点の目印を書いている", () => {
    const cssMatch = cssText();
    const wrapRule = /\.tablewrap\s*\{([^}]*)\}/.exec(cssMatch)?.[1] ?? "";
    expect(wrapRule, "スクロール面が横に動かせる規則を失っている").toContain("overflow-x: auto");
    expect(cssMatch, "焦点の目印が無い（Tab で受けても場所が分からない）").toMatch(
      /\.tablewrap:focus-visible\s*\{[^}]*outline:/,
    );
    expect(cssMatch, "案内の文字色の規則が無い").toMatch(/\.scrollhint\s*\{[^}]*color:/);
  });

  it("案内の文字は明るい面でも暗い面でも読める（WCAG 1.4.3）", () => {
    // :root は明るい色と暗い色で 2 塊あるので、それぞれ別に見る（第 261 回）。
    const cssMatch = cssText();
    const blocks = [...cssMatch.matchAll(/:root[^{]*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(blocks.length, "配色の塊が 2 つ無い").toBeGreaterThanOrEqual(2);
    const vars = (body: string): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const m of body.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
      return out;
    };
    const rgb = (v: string): number[] => {
      const hex = /^#([0-9a-f]{3,8})$/i.exec(v.trim());
      if (hex) {
        let h = hex[1];
        if (h.length === 3)
          h = h
            .split("")
            .map((c) => c + c)
            .join("");
        return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
      }
      const fn = /rgba?\(([^)]+)\)/.exec(v);
      if (fn)
        return fn[1]
          .split(",")
          .slice(0, 3)
          .map((x) => Number.parseFloat(x));
      throw new Error(`色を読めない: ${v}`);
    };
    const lum = (c: number[]): number => {
      const f = (v: number): number => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (a: number[], b: number[]): number => {
      const hi = Math.max(lum(a), lum(b));
      const lo = Math.min(lum(a), lum(b));
      return (hi + 0.05) / (lo + 0.05);
    };
    blocks.slice(0, 2).forEach((body, i) => {
      const v = vars(body);
      const fg = rgb(v["--muted"]);
      for (const bg of ["--bg", "--panel", "--panel-hover"]) {
        expect(
          ratio(fg, rgb(v[bg])),
          `${i === 0 ? "明るい" : "暗い"}配色の案内が ${bg} 上で読めない`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  });
});

/* ------------------------------------------------------------------ 動き方 */

interface FakeEl {
  attrs: Record<string, string>;
  hidden: boolean;
  textContent: string;
  scrollWidth: number;
  clientWidth: number;
  setAttribute: (k: string, v: string) => void;
  removeAttribute: (k: string) => void;
}

function fakeEl(over: Partial<FakeEl> = {}): FakeEl {
  const el: FakeEl = {
    attrs: {},
    hidden: false,
    textContent: "",
    scrollWidth: 0,
    clientWidth: 0,
    setAttribute(k: string, v: string): void {
      this.attrs[k] = String(v);
    },
    removeAttribute(k: string): void {
      delete this.attrs[k];
    },
    ...over,
  };
  return el;
}

/** ビルド済み app.js の `syncTableScroll` を、にせの要素で動かす。 */
function runSync(wrap: FakeEl, hint: FakeEl): void {
  const app = siteRuntime();
  const label = app.match(/const TABLE_SCROLL_LABEL_JA =\s*"[^"]*";/)?.[0];
  const hintText = app.match(/const TABLE_SCROLL_HINT_JA =\s*"[^"]*";/)?.[0];
  expect(label, "スクロール面の説明（正本）が見つからない").toBeTruthy();
  expect(hintText, "案内の文（正本）が見つからない").toBeTruthy();
  const body = [
    label,
    hintText,
    "function $(id) { return els[id]; }",
    /* 抜き出した関数は宣言するだけでは走らないので、最後に必ず呼ぶ（呼ばないと検査は
       空振りになり、どんな実装でも通ってしまう – 第 265 回の実発生）。 */
    jsFunction(app, "tableScrollOver"),
    jsFunction(app, "syncTableScroll"),
    "syncTableScroll();",
  ].join("\n");
  new Function("els", vmSafeSource(body))({
    deadlineTableWrap: wrap,
    tableScrollHint: hint,
  });
}

describe("越えているときだけスクロール面を Tab で受けられる", () => {
  const app = siteRuntime();

  it("1 px を越えたかだけで決める（越えていないのに続きがあると言わない）", () => {
    const src = jsFunction(app, "tableScrollOver");
    const over = new Function(`return ${src}`)() as unknown as (a: number, b: number) => boolean;
    expect(over(880, 768), "iPad 縦持ちで越えていると言わない").toBe(true);
    expect(over(881, 768), "さらに狭い窓で越えていると言わない").toBe(true);
    expect(over(768, 768), "越えていないのに続くと述べている").toBe(false);
    expect(over(769, 768), "1 px の差を続いていると言っている").toBe(false);
    expect(over(770, 768), "2 px の差を続いていないと言っている").toBe(true);
    expect(over(767, 768), "右がはみ出ていないのに続くと述べている").toBe(false);
  });

  it("越えているときは場所を渡し、案内を出し、キー操作の書き方まで書く", () => {
    const wrap = fakeEl({ scrollWidth: 880, clientWidth: 768 });
    const hint = fakeEl({ hidden: true });
    runSync(wrap, hint);
    expect(wrap.attrs.tabindex, "スクロール面が Tab を受けない").toBe("0");
    expect(wrap.attrs.role, "読み上げが場所を辿れない").toBe("region");
    expect(wrap.attrs["aria-label"], "読み上げに何がスクロールするのか伝わらない").toContain("表");
    expect(wrap.attrs["aria-label"]).toMatch(/Tab/);
    expect(wrap.attrs["aria-label"]).toMatch(/[←→]/);
    expect(hint.hidden, "案内が出ない").toBe(false);
    expect(hint.textContent, "案内がキーの書き方を教えていない").toMatch(/←/);
    expect(hint.textContent).toContain("横");
  });

  it("越えていないときは差し込まない（空の焦点点を増やさない）", () => {
    /* 狭い窓から広い窓へ戻した場面その物で検める（前に越えていた要素に attributes が
       残ったまま）。からっぽの要素で始めると、消す物が無いので後始末を忘れても通る –
       改ざん実測で気づいた空振り（第 265 回）。 */
    const wrap = fakeEl({
      scrollWidth: 768,
      clientWidth: 768,
      attrs: { role: "region", "aria-label": "締切の一覧（…）", tabindex: "0" },
    });
    const hint = fakeEl({ hidden: false, textContent: "← → で横にスクロールできます" });
    runSync(wrap, hint);
    expect(wrap.attrs.tabindex, "越えていないのに焦点を受け取る").toBeUndefined();
    expect(wrap.attrs.role).toBeUndefined();
    expect(wrap.attrs["aria-label"]).toBeUndefined();
    expect(hint.hidden, "越えていないのに案内が残る").toBe(true);
    expect(hint.textContent, "消えたはずの案内の文が残っている").toBe("");
  });

  it("一覧が隠れている画面（投稿先を探す・0 件）で噓を言わない", () => {
    /* 隠れている要素は `scrollWidth` も `clientWidth` も 0 で、測れない。
       測れた方に寄せると「越えています」が誤って立つ。 */
    const wrap = fakeEl({
      scrollWidth: 0,
      clientWidth: 0,
      hidden: true,
      attrs: { role: "region", "aria-label": "締切の一覧（…）", tabindex: "0" },
    });
    const hint = fakeEl({ hidden: false, textContent: "← → で横にスクロールできます" });
    runSync(wrap, hint);
    expect(hint.hidden, "一覧が出ていないのに案内が残る").toBe(true);
    expect(wrap.attrs.tabindex).toBeUndefined();
  });

  it("言葉は 1 本だけ持つ（画面の説明と読み上げの説明が言い分かれなくする）", () => {
    expect(app.match(/const TABLE_SCROLL_LABEL_JA =/g)?.length).toBe(1);
    expect(app.match(/const TABLE_SCROLL_HINT_JA =/g)?.length).toBe(1);
    // 説明文をその場に書き写している箇所が無いことも見る（`setAttribute("aria-label", "…")` 直書き）。
    expect(
      app.match(/setAttribute\("aria-label",\s*"/g),
      "読み上げの説明をその場に書き写している",
    ).toBeNull();
  });

  it("窓の幅が変わりても揃え直す（拡大表示・画面分割を追いかけられる）", () => {
    expect(app, "幅が変わったときの揃え直しが無い").toContain(
      'window.addEventListener("resize", syncTableScroll)',
    );
    expect(app, "一覧を組み直したときに揃え直していない（幅が変わっても同じ画面になる）").toMatch(
      /syncTableScroll\(\);\s*\n\s*updatePresetActive\(\);/,
    );
  });
});
