/**
 * 続きを最後まで足した人のフォーカスを消さない検査（SPEC §7・第 273 回）。
 *
 * 2026-08-09 生成ビルドで実測した形：
 *   - 「さらに表示」「すべて表示」は、足す物が無くなると `updateMoreButton` が `hidden` にする。
 *     **押した人自身のフォーカスが消えた物に乗ったまま**になるため、その後の Tab は画面の
 *     先頭からやり直しになり、読み上げも居場所を失う。マウスならスクロールバーで済むが、
 *     キーボードだけで操作する人には一番こたえる。
 *   - 読み上げ欄（`#countLive`）にも、最後まで出したことは伝わっていなかった
 *     （件数欄の総数は押す前と同じなので、流れない）。
 */

import { describe, expect, it } from "vitest";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

type Fake = {
  hidden?: boolean;
  tabIndex?: number;
  textContent?: string;
  classList?: { contains: (c: string) => boolean };
  focus: () => void;
  calls: string[];
};

function fakeEl(calls: string[], name: string, extra: Partial<Fake> = {}): Record<string, unknown> {
  return {
    hidden: false,
    tabIndex: -1,
    textContent: "",
    focus: () => calls.push(name),
    ...extra,
  };
}

/** ビルド成果物から関数を抜き出して、画面の作りだけ差し替えて動かす。 */
function runKeepFocus(o: {
  active: string; // "more" | "showAll" | "q"
  moreHidden: boolean;
  allHidden: boolean;
  cardsHidden: boolean;
  rows?: { cls: string[] }[];
  lastCard?: boolean;
}) {
  const rt = siteRuntime("app.js");
  const src = ["countJa", "sharedRowNotice", "dataRows", "keepFocusAfterMoreDraw"]
    .map((n) => jsFunction(rt, n))
    .join("\n");
  const calls: string[] = [];
  const more = fakeEl(calls, "more", { hidden: o.moreHidden });
  const showAll = fakeEl(calls, "showAll", { hidden: o.allHidden });
  const tbody = fakeEl(calls, "tbody");
  const cards = fakeEl(calls, "cards", { hidden: o.cardsHidden });
  const live = fakeEl(calls, "countLive");
  const q = fakeEl(calls, "q");
  const rows = (o.rows ?? [{ cls: [] }, { cls: ["detail-row"] }, { cls: ["month-row"] }]).map(
    (r, i) =>
      fakeEl(calls, `row${i}`, { classList: { contains: (c: string) => r.cls.includes(c) } }),
  );
  /* カードがフォーカスを受け取れるかは `tabindex` 属性の有無で決まる（既定は属性が無く、
   * `tabIndex` を読んでも -1 が見えるだけ）。なので、代入されたかどうかを見るために、
   * 属性への代入として扱う。 */
  const cardAttrs: Record<string, string> = {};
  const lastCard = o.lastCard
    ? {
        attrs: cardAttrs,
        focus: () => calls.push("lastCard"),
        get tabIndex() {
          return "tabindex" in cardAttrs ? Number(cardAttrs.tabindex) : -1;
        },
        set tabIndex(v: number) {
          cardAttrs.tabindex = String(v);
        },
      }
    : null;
  (tbody as Record<string, unknown>).querySelectorAll = () => rows;
  (cards as Record<string, unknown>).lastElementChild = lastCard;
  const els: Record<string, Record<string, unknown>> = {
    more,
    showAll,
    tbody,
    recommendationCards: cards,
    countLive: live,
    q,
  };
  const build = new Function(
    "$",
    "document",
    "shown",
    "recommendationList",
    `${src}\nreturn keepFocusAfterMoreDraw;`,
  );
  const f = build(
    (id: string) => els[id],
    { activeElement: els[o.active] },
    { length: 478 },
    { length: 200 },
  );
  f();
  return { calls, live: String(live.textContent), attrs: cardAttrs };
}

describe("続きを最後まで足した人のフォーカスが消えない（第 273 回）", () => {
  it("ボタンが消えたとき、フォーカスは最後に足した行へ移る", () => {
    const got = runKeepFocus({
      active: "more",
      moreHidden: true,
      allHidden: true,
      cardsHidden: true,
    });
    // `.detail-row`（行の詳細）と `.month-row`（月の見出し）を除いた最後の行。
    expect(got.calls, "フォーカスが消えたボタンの上に置いたまま（Tab が先頭からやり直し）").toEqual(
      ["row0"],
    );
  });

  it("読み上げにも、最後まで出したことが伝わる", () => {
    const got = runKeepFocus({
      active: "showAll",
      moreHidden: true,
      allHidden: true,
      cardsHidden: true,
    });
    expect(got.live, "読み上げ欄に何も流れない").toContain("すべて出しました");
    expect(got.live).toContain("478"); // 件数は画面と同じ区切り・同じ総数。
  });

  it("まだ足す物が残っているなら、フォーカスを動かさない", () => {
    const got = runKeepFocus({
      active: "more",
      moreHidden: false,
      allHidden: false,
      cardsHidden: true,
    });
    expect(got.calls, "ボタンが生きているのにフォーカスを奪った").toEqual([]);
    expect(got.live).toBe("");
  });

  it("条件の欄にフォーカスが有るとき（絞り込みの作り直し）は、動かさない", () => {
    const got = runKeepFocus({
      active: "q",
      moreHidden: true,
      allHidden: true,
      cardsHidden: true,
    });
    expect(got.calls, "押していない人のフォーカスを動かした").toEqual([]);
  });

  it("推薦カードでは最後のカードへ移り、カードはフォーカスを受け取れるようになる", () => {
    const got = runKeepFocus({
      active: "showAll",
      moreHidden: true,
      allHidden: true,
      cardsHidden: false,
      lastCard: true,
    });
    expect(got.calls).toEqual(["lastCard"]);
    expect(got.attrs?.tabindex, "カードに tabindex を属性として与えていない").toBe("-1");
    expect(got.live).toContain("候補 200 件");
  });

  it("行が 1 件も無いときに落ちない（0 件の画面で押せるわけではないが、念のため）", () => {
    const got = runKeepFocus({
      active: "more",
      moreHidden: true,
      allHidden: true,
      cardsHidden: true,
      rows: [],
    });
    expect(got.calls).toEqual([]);
  });

  it("行の選び方は 1 本の関数にまとまっていて、除く規則をそこだけに持つ", () => {
    const rt = siteRuntime("app.js");
    const body = jsFunction(rt, "dataRows");
    expect(body).toContain("detail-row");
    expect(body).toContain("month-row");
    // 呼び出し元が行を組み直す式を持ったら、この関数を使う形に寄せる（第 273 回）。
    // 1 要素を確かめる所（行の詳細のとなりを見る `next.classList.contains(…)` など）は
    // 別の規則なので、行を並べ替える式（`row.classList.contains(…)`）だけを数える。
    const inlined = (rt.match(/row\.classList\.contains\("detail-row"\)/g) || []).length;
    expect(inlined, "行の選び方の式が関数以外に書き写されている").toBe(1);
    expect(
      (rt.match(/dataRows\(\)/g) || []).length,
      "関数にまとめた意味が無い（呼び出し元が少ない）",
    ).toBeGreaterThanOrEqual(3);
  });

  it("続きを足す関数の末尾から、毎回この判断が呼ばれている", () => {
    const rt = siteRuntime("app.js");
    for (const name of ["drawMore", "drawMoreCards", "drawAll"]) {
      const body = jsFunction(rt, name);
      expect(body, `${name} の後にフォーカスの面倒を見ない（消えた上に残る）`).toContain(
        "keepFocusAfterMoreDraw();",
      );
    }
  });
});
