import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

function page(name: string): string {
  return readFileSync(join(site, name), "utf8");
}

function pageBody(): string {
  return page("index.html").replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, "");
}

/** `updateMoreButton` を、ボタンの作りだけ差し替えて動かす。 */
function runUpdateMoreButton(drawn: number, total: number) {
  const rt = siteRuntime("app.js");
  const src = ["countJa", "moreButtonLabel", "showAllButtonLabel", "updateMoreButton"]
    .map((n) => jsFunction(rt, n))
    .join("\n");
  /* 初期状態は「前に描画したときは出ていた」側にする。隠れた状態から始めると、
   * 閉じる側（`hidden = true`）を消した改ざんが通ってしまう。 */
  const els: Record<string, { hidden: boolean; textContent: string }> = {
    more: { hidden: false, textContent: "さらに表示 (残り 0 件)" },
    showAll: { hidden: false, textContent: "すべて表示 (残り 0 件)" },
  };
  const build = new Function("$", `${src}\nreturn updateMoreButton;`);
  build((id: string) => els[id])(drawn, total);
  return els;
}

describe("一覧の続きを一気に入れる口がある（第 272 回）", () => {
  it("「すべて表示」が表の下に在り、初期状態では隠れている", () => {
    const btn = /<button id="showAll"[^>]*>([^<]*)<\/button>/.exec(pageBody());
    expect(btn, "「さらに表示」のとなりに続きを一気に入れる口がない").toBeTruthy();
    expect(btn![1].trim(), "ボタンに語がない").toBe("すべて表示");
    expect(btn![0], "初期状態で出て見える（まだ足す物がないときに見える噓の口）").toContain(
      "hidden",
    );
    const more = pageBody().indexOf('<button id="more"');
    const all = pageBody().indexOf('<button id="showAll"');
    expect(Math.abs(more - all) < 400, "2 つが離れて見える（どちらが続きか分からない）").toBe(true);
  });

  it("ラベルは「さらに表示」と同じ形で、同じ残り件数を出す（実行物を動かして確かめる）", () => {
    const els = runUpdateMoreButton(40, 478);
    expect(els.more.hidden, "続きがあるのに「さらに表示」が隠れている").toBe(false);
    expect(els.showAll.hidden, "続きがあるのに「すべて表示」が隠れている").toBe(false);
    expect(els.more.textContent).toBe("さらに表示 (残り 438 件)");
    expect(els.showAll.textContent).toBe("すべて表示 (残り 438 件)");
  });

  it("足す物が無くなると、両方のボタンが揃って消える", () => {
    const els = runUpdateMoreButton(478, 478);
    expect([els.more.hidden, els.showAll.hidden], "片方だけ残る（押しても何も起きない口）").toEqual(
      [true, true],
    );
  });

  it("4 桁をこえる残り件数も、画面と同じ区切りで出す", () => {
    const els = runUpdateMoreButton(40, 3253);
    expect(els.showAll.textContent).toBe("すべて表示 (残り 3,213 件)");
  });

  it("続きの出し方は表でも推薦カードでも同じ関数を使い、無限に回らない止め方がある", () => {
    const rt = siteRuntime("app.js");
    const body = jsFunction(rt, "drawAll");
    expect(body).toContain("drawMore();");
    expect(body).toContain("drawMoreCards();");

    expect(
      body,
      "足す物が無くなるときに進捗を見て抜ける形がない（止まらないループの防止）",
    ).toMatch(/const before = [\s\S]*?if \(after <= before\)\s*break;/);
    expect(rt, "クリックの配線が無く、出ても押せないボタンになる").toContain(
      '$("showAll").addEventListener("click", drawAll)',
    );
  });

  it("印刷物には出さない（紙の上に押せないボタンを書かない）", () => {
    const css = [...page("index.html").matchAll(/<style>([\s\S]*?)<\/style>/g)]
      .map((m) => m[1])
      .join("\n");
    const print = /@media print \{([\s\S]*?)\n\}/.exec(css);
    expect(print, "印刷用の設定がない").toBeTruthy();
    expect(print![1], "印刷物に「すべて表示」が刷られる").toMatch(/#showAll\b/);
  });

  it("てびきの CSV の項目が、ボタンと同じ語を名乗っている", () => {
    const mk = pageBody();
    const m = /<dt>CSV<\/dt>\s*<dd>([\s\S]*?)<\/dd>/.exec(mk);
    expect(m, "てびきに CSV の項目がない").toBeTruthy();
    const entry = m![1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    const btn = /<button id="showAll"[^>]*>([^<]*)<\/button>/.exec(mk);
    expect(entry, `CSV の項目が「${btn![1]}」を名乗っていない`).toContain(btn![1].trim());
    // 「さらに表示」の語も同時に保つ。書き分けが増えても元の案内が消えないこと。
    expect(entry).toContain("さらに表示");
  });
});
