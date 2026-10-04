/**
 * 畫面の使い方を尋ねる打ち手が默らん（第 641 回）。
 *
 * てびきの語（`使い方` `見方`）は載つて居たが、**別の尋ね方をした人が出會へて居なかつた**。
 * 實測（2026-08-09 生成の品書 3,250 行・固定時刻 2026-08-09T00:00:00Z）で –
 * `凡例`・`色分け`・`印`・`読み上げ`・`スクリーンリーダー`・`類義語`・`一致評価`・`意味検索`・
 * `該当なし`・`タブ`・`エクセル`・`Outlook`・`XML`・`atom` はいずれも **0 行で案内も無し**だつた。
 * 歸屬先は既に在る（てびきの見出しは「一致評価・意味検索・印」を持ち、CSV の段は『カレンダーに
 * 追加（.ics）』『CSV でダウンロード』を書き、キーボードの段は Tab を書く）。**新しい文を書かず、
 * 其の羣に語だけを足した**。
 *
 * 彈いた物 – 行が出る語を載せ替へると噓の門になる（第 337 回）: `推定` 183 行・`未確認` 605 行・
 * `マーク` 39 行・`RSS` 13 行・`feed` 4 行・`データ` 477 行・`Excel` 1 行。`説明` も彈いた –
 * 單語なら羣が受けられるが、`このページの説明` と打つ人には受皿の「この表が出すのは催し物の名前・
 * 締切の日・…」の方が役に立つ（第 632 回の檢査がその文を張つて居る）。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 品書 = Recommender.candidateRows(
  JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8")),
) as unknown as Array<{ hay: string }>;
const 当たり = (文: string): number => {
  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, 基準), 基準);
  return 品書.filter((r) => m(String(r.hay)) === true).length;
};
const 案内 = (文: string): string =>
  String(Recommender.uiWordNoteJa(文, false) || "").trim() +
  String(Recommender.wholeTableQueryNoteJa(文) || "").trim() +
  (Recommender.querySynonymNotes(文) || []).join("");

const てびきの打ち手 = [
  "凡例",
  "色分け",
  "印",
  "しるし",
  "読み方",
  "読み上げ",
  "スクリーンリーダー",
  "類義語",
  "一致評価",
  "意味検索",
  "該当なし",
];
const 持ち出しの打ち手 = ["エクセル", "Outlook", "XML", "atom"];
const 鍵盤の打ち手 = ["タブ", "Tab"];

describe("使い方を尋ねる打ち手（第 641 回）", () => {
  it("十七の語が歸屬先に屆く – 歸屬先はてびきの見出しに實在る", () => {
    const 見出し = readFileSync(new URL("../site/template.html", import.meta.url), "utf8");
    for (const 文 of てびきの打ち手) {
      const 案 = 案内(文);
      expect(案, `${文} が默つた侬`).toContain("見方のてびき");
      expect(当たり(文), `${文} に行が出て居る（噓の門）`).toBe(0);
    }
    // 羣が名指す物が文書に實在る（案内だけ増えて中身が無い、を防ぐ）。
    expect(見出し, "てびきに『一致評価・意味検索・印』の段が消へた").toContain(
      "一致評価・意味検索・印",
    );
    for (const 語 of ["該当なし", "意味検索", "読み上げ"])
      expect(見出し, `てびきに ${語} が書かれて居らん`).toContain(語);
  });
  it("持ち出しの形を名指す打ち手は、在る物を並べて居る羣へ屆く", () => {
    for (const 文 of 持ち出しの打ち手) {
      const 案 = 案内(文);
      expect(案, `${文} が默つた侬`).toContain(".ics");
      expect(案, `${文} の答えに CSV が無い`).toContain("CSV");
      expect(当たり(文), `${文} に行が出て居る`).toBe(0);
    }
  });
  it("`タブ` はキーボードの段に屆く – 見出しの Tab が答えに書かれて居る", () => {
    for (const 文 of 鍵盤の打ち手) {
      const 案 = 案内(文);
      expect(案, `${文} が默つた侬`).toContain("Tab");
      expect(当たり(文), `${文} に行が出て居る`).toBe(0);
    }
  });
  it("行が出る語を載せ替へん – 噓の門にならん（第 337 回）", () => {
    for (const [文, 最低] of [
      ["推定", 100],
      ["未確認", 500],
      ["マーク", 30],
      ["RSS", 10],
      ["データ", 400],
    ] as const) {
      expect(当たり(文), `${文} の行の数が變はつた`).toBeGreaterThanOrEqual(最低);
      expect(案内(文), `${文} に羣の案内が出て噓の門`).not.toContain("見方のてびき");
    }
    // `Excel`（一文字目の大文字の形）は 1 行通る – 小文字の `エクセル` だけを載せた理由。
    expect(当たり("Excel"), "Excel の行が消へたら判斷が變はる").toBeGreaterThan(0);
    expect(当たり("説明"), "説明に行が出て居たら讓す理由が無い").toBe(0);
  });
  it("`このページの説明` は羣で無く受皿が受ける（第 632 回）", () => {
    expect(String(Recommender.uiWordNoteJa("このページの説明", false) || "").trim()).toBe("");
    expect(String(Recommender.uiWordNoteJa("説明", false) || "").trim()).toBe("");
  });
});
