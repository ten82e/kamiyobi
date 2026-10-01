/**
 * 「情報工学」の括りと、分野の別名を畫面の分野名へ寄せる（第 638 回）。
 *
 * 日本の研究者が自分の分野を総称して打つ語（`情報工学` `情報科学` `情報学` `情報系`
 * `計算機科学` `コンピュータサイエンス`）は、2026-08-09 生成の実ビルド（品書 3,250 行）で
 * **六語とも 0 行・案内も無し**だつた（其の語を書く行が品書に一度も無い）。而して收錄の九分野
 * （人工知能・システム・セキュリティ・データベース・グラフィックス・ネットワーク・高性能計算・
 * 人間情報処理・計算理論）は悉くその下で、**分野の無い行は 0 / 3,250**（此の檢査が張る）。
 * だから其れらは「この表は全部その分野です」という話 – 絞り込みにはならんので、第 239 回の
 * 全行の語に配つた（打ち直し方は其の案内が欄の名前で書く）。
 *
 * ともかく行が欲しい打ち手は別に在る – `コンピュータネットワーク` `計算機ネットワーク`
 * `ネットワークプロトコル` `ヒューマンコンピュータインタラクション` `データベース管理`
 * `システム設計` はいずれも **舊 0 行**で、畫面の分野名に寄せると 257・138・447・676 行出る。
 * 寄せた事は其の畫面に出す（「『X』は分野『Y』で探しています」 – 默つて意味の廣まる行を出さん
 * 第 337 回・同じ流儀）。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 品書 = Recommender.candidateRows(
  JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8")),
);
const 当たり = (文: string): number => {
  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, 基準), 基準);
  return 品書.filter((r: { hay?: string }) => m(String(r.hay)) === true).length;
};
const 案内 = (文: string): string =>
  String(Recommender.wholeTableQueryNoteJa(文) || Recommender.uiWordNoteJa(文, false) || "").trim();
const ビルド = (f: string): string =>
  readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");

/* 分野の寄せ – [打ち手, 寄せ先の分野, その分野の行数] */
const 寄せ: Array<[string, string, number]> = [
  ["コンピュータネットワーク", "ネットワーク", 257],
  ["計算機ネットワーク", "ネットワーク", 257],
  ["ネットワークプロトコル", "ネットワーク", 257],
  ["ヒューマンコンピュータインタラクション", "人間情報処理", 138],
  ["データベース管理", "データベース", 447],
  ["システム設計", "システム", 676],
];

/* 表を一括して訪ねる語 – 絞り込みにはならん */
const 一括 = ["情報工学", "情報科学", "情報学", "情報系", "計算機科学", "コンピュータサイエンス"];

describe("分野の別名を畫面の分野名に寄せる（第 638 回）", () => {
  it("六本が行を出す – 舊 0 行の打ち手に收錄の行を返す", () => {
    for (const [文, 分野, 行数] of 寄せ) {
      expect(当たり(分野), `寄せ先その物が数へられん: ${分野}`).toBe(行数);
      expect(当たり(文), `${文} が ${分野} の行を出さん`).toBe(行数);
      const 說 = (Recommender.querySynonymNotes(文) || []).join("");
      expect(說, `寄せた事を畫面に出さん: ${文} → ${說}`).toContain(文);
      expect(說, `寄せ先を書かん: ${文}`).toContain(分野);
    }
  });
  it("寄せ先は悉く畫面に出る分野名（第 249 回の不變件 – 檢査が既に張るが此處でも）", () => {
    const 物 = ビルド("recommender.js");
    for (const [, 分野] of 寄せ)
      expect(物, `分類の表示名に無い語へ寄せた: ${分野}`).toContain(`"${分野}"`);
  });
  it("搜で行が出る語は寄せんで讓す – `情報処理` は 148 行で舊來通る", () => {
    expect(当たり("情報処理"), "部分一致で行が出る語の筈").toBe(148);
    expect((Recommender.querySynonymNotes("情報処理") || []).join("")).not.toContain("分野「");
  });
});

describe("表を一括して訪ねる語（第 239 回の全行の語 – 第 638 回）", () => {
  it("六本が『絞り込めません』に就く – 默つた 0 件画面を殘さん", () => {
    for (const 文 of 一括) {
      expect(当たり(文), `行が出る語を全行の語にして居る: ${文}`).toBe(0);
      const out = 案内(文);
      expect(out, `默つた: ${文}`).not.toBe("");
      expect(out, `全行の語と言はなんだ: ${文}`).toContain("全行にあてはまる語");
      expect(out, `搜で絞れると誤らす: ${文}`).toContain("検索では絞り込めません");
      expect(out, `打ち直しの欄を書かん: ${文}`).toContain("分野");
    }
  });
  it("收錄は九分野の下に在る – 分野の無い行はゼロ（括りの根據）", () => {
    /* 九分野の表示名（`CATEGORY_LABELS_JA` – 絞り込みチップ・行タグ・検索語の共通元）。 */
    const 九 = [
      "人工知能",
      "データベース",
      "グラフィックス",
      "人間情報処理",
      "高性能計算",
      "ネットワーク",
      "セキュリティ",
      "システム",
      "計算理論",
    ];
    const 物 = ビルド("recommender.js");
    for (const 名 of 九) expect(物, `畫面の分野名に無い: ${名}`).toContain(`"${名}"`);
    let 無 = 0;
    for (const r of 品書 as Array<{ cats?: string[] }>) if (!(r.cats || []).length) 無 += 1;
    expect(無, "分野の無い行が出た（一括の語の案内が噓になる）").toBe(0);
    expect(品書.length).toBe(3250);
  });
});
