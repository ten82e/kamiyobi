import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { queryReferenceSnapshotPath } from "./query_reference.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 品書 = Recommender.candidateRows(
  JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8")),
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

describe("分野の別名を画面の分野名に寄せる（第 638 回）", () => {
  it("六本が行を出す – 旧 0 行の打ち手に収録の行を返す", () => {
    for (const [文, 分野, 行数] of 寄せ) {
      expect(当たり(分野), `寄せ先その物が数へられん: ${分野}`).toBe(行数);
      expect(当たり(文), `${文} が ${分野} の行を出さん`).toBe(行数);
      const 說 = (Recommender.querySynonymNotes(文) || []).join("");
      expect(說, `寄せた事を畫面に出さん: ${文} → ${說}`).toContain(文);
      expect(說, `寄せ先を書かん: ${文}`).toContain(分野);
    }
  });
  it("寄せ先は悉く画面に出る分野名（第 249 回の不変件 – 検査が既に張るがここでも）", () => {
    const 物 = ビルド("recommender.js");
    for (const [, 分野] of 寄せ)
      expect(物, `分類の表示名に無い語へ寄せた: ${分野}`).toContain(`"${分野}"`);
  });
  it("検索で行が出る語は寄せんで讓す – `情報処理` は 148 行で旧來通る", () => {
    expect(当たり("情報処理"), "部分一致で行が出る語の筈").toBe(148);
    expect((Recommender.querySynonymNotes("情報処理") || []).join("")).not.toContain("分野「");
  });
});

describe("表を一括して訪ねる語（第 239 回の全行の語 – 第 638 回）", () => {
  it("六本が『絞り込めません』に就く – 黙つた 0 件画面を残さん", () => {
    for (const 文 of 一括) {
      expect(当たり(文), `行が出る語を全行の語にして居る: ${文}`).toBe(0);
      const out = 案内(文);
      expect(out, `默つた: ${文}`).not.toBe("");
      expect(out, `全行の語と言はなんだ: ${文}`).toContain("全行にあてはまる語");
      expect(out, `搜で絞れると誤らす: ${文}`).toContain("検索では絞り込めません");
      expect(out, `打ち直しの欄を書かん: ${文}`).toContain("分野");
    }
  });
  it("収録は九分野の下にある – 分野のない行はゼロ（括りの根據）", () => {
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
    expect(無, "分野のない行が出た（一括の語の案内が噓になる）").toBe(0);
    expect(品書.length).toBe(3250);
  });
});
