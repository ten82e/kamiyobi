/**
 * 画面の語を**活用の形・言い方の続きで打った人**の検査（SPEC §4・§7・第 326 回）。
 * 実測（2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `書き出す` `書き出したい` `保存する` `ダウンロードする` `購読する` `購読したい`
 * `印刷したい` `カレンダーに入れる` `絞り込みを消す` `並び替える` は 0 行で、名詞形には案内が
 * 在るのに何も言わず、読み上げは「収録データにありません」とだけ言っていた（第 325 回で直した
 * 語の活用形）。逆に `クリアランス` `条件付き` `未確定` を語の一部として拾うと嘘になるので、
 * 語の**後ろに決まった言い回しが付く形**だけ名詞形に寄せる。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

/** 活用形・言い方 → 名詞形（正本の案内を出す側）。 */
const 言い方: Array<[string, string]> = [
  ["書き出す", "書き出し"],
  ["書き出したい", "書き出し"],
  ["保存する", "保存"],
  ["ダウンロードする", "ダウンロード"],
  ["購読する", "購読"],
  ["購読したい", "購読"],
  ["印刷したい", "印刷"],
  ["カレンダーに入れる", "カレンダー"],
  ["並び替える", "並び替え"],
];

/** 語が文の一部に過ぎない打ち方（寄せてはいけない側 – 実測で誤発火になった物）。 */
const 寄せない = [
  "クリアランス",
  "条件付き",
  "解像度",
  "戻り値",
  "除外",
  "凍結",
  "書き出しすぎ",
  "使い方と並び替え",
  "機械学習の分野",
  "セキュリティ 関西",
  "学習する",
  "研究する",
  "投稿する",
];

function 画面(): string {
  return readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
}

describe("画面の語を活用の形で打つ人", () => {
  it("活用形は、名詞形と同じ案内が出る（案内を新しく作らない）", () => {
    言い方.forEach(([打った語, 名詞形]) => {
      const 正本の文 = Recommender.uiWordNoteJa(名詞形);
      expect(正本の文, `"${名詞形}" 自身の案内が消えた`).not.toBe("");
      const 文 = Recommender.uiWordNoteJa(打った語);
      expect(文, `"${打った語}" に何も言わない`).not.toBe("");
      expect(文.trim(), `"${打った語}" の案内が "${名詞形}" と違う話をしている`).toBe(
        正本の文.trim(),
      );
      /* 読み上げも同じ案内に寄せる（語だけの読み上げに落ちないこと）。 */
      expect(Recommender.uiWordLiveNoteJa(打った語), `"${打った語}": 読み上げが空`).not.toBe("");
    });
  });

  it("書き返すのは正本の表記（打たれた語を表の表記に揃える）", () => {
    言い方.forEach(([打った語, 名詞形]) => {
      const 文 = Recommender.uiWordNoteJa(打った語);
      expect(文.includes(`「${名詞形}」`), `"${打った語}": 正本の語を書いていない`).toBe(true);
    });
  });

  it("語が一部のだけの打ち方には寄せない（実測で嘘になった形）", () => {
    寄せない.forEach((語) => {
      expect(Recommender.uiWordNoteJa(語), `"${語}" に案内を立てた（語の一部を拾った）`).toBe("");
      expect(Recommender.uiWordLiveNoteJa(語), `"${語}": 読み上げが誤発火`).toBe("");
    });
    /* `未確定` は第 337 回で自分の案内を持つ語になった（収録に「仮の締切」という扱いが
     * 無い事を言う）。ここで守るのは – 画面のボタン語 `確定` の案内（『見方のてびき』）を
     * 語の一部として拾わない事。 */
    expect(Recommender.uiWordNoteJa("未確定")).not.toContain("見方のてびき");
    expect(Recommender.uiWordNoteJa("未確定")).toContain("公式に出した日付");
  });

  it("条件を戻したい人には『条件クリア』の名前を出す（欄の名前の案内に譲らない）", () => {
    const html = 画面();
    /* 正本: 絞り込みの欄の右のボタン（`id="reset"`）と、論文の欄を消す別のボタン。 */
    expect(/<button class="btn-reset" id="reset">条件クリア<\/button>/.test(html)).toBe(true);
    expect(/id="paperReset"[^>]*>論文の入力を消す</.test(html)).toBe(true);
    expect(/id="paperUndo"[^>]*>直前の入力に戻す</.test(html)).toBe(true);
    [
      "リセット",
      "元に戻す",
      "クリア",
      "解除",
      "条件クリア",
      "条件を消す",
      "絞り込みを消す",
    ].forEach((語) => {
      const 文 = Recommender.uiWordNoteJa(語);
      expect(文.includes("条件クリア"), `"${語}": ボタンの名前を言わない`).toBe(true);
      expect(文.includes("論文の入力を消す"), `"${語}": 論文の欄の別ボタンを言わない`).toBe(true);
      expect(文.includes("直前の入力に戻す"), `"${語}": 戻すボタンの名前を言わない`).toBe(true);
      /* 条件は戻るが論文の欄は消さない – 噓の案内にしない。 */
      expect(
        文.includes("論文のタイトル・概要・参考論文の欄は消しません"),
        `"${語}": 範囲を曖昧にした`,
      ).toBe(true);
      /* 読み上げも同じボタンを言う – live を空にすると語だけの読み上げに落ちる（第 325 回）。 */
      const 声 = Recommender.uiWordLiveNoteJa(語);
      expect(声.includes("条件クリア"), `"${語}": 読み上げがボタンの名前を言わない`).toBe(true);
      expect(声.includes("検索欄の語も含めた"), `"${語}": 読み上げが何を戻すか言わない`).toBe(true);
      /* 欄の名前の案内（「上にある欄で選ぶか」）に拾われたら、押す場所の話が消える。 */
      expect(文.includes("この表の語ではなく"), `"${語}": 欄の名前の案内に拾われた`).toBe(false);
    });
  });

  it("成果物は寄せの部品を失っていない（試験用の注入は関数名で足す）", () => {
    const js = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    [
      "UI_WORD_TAILS_JA",
      "function uiWordStemForms",
      "function uiWordContain",
      "function uiWordMatch",
    ].forEach((断片) => {
      expect(js.includes(断片), `組み立てた画面から ${断片} が消えた`).toBe(true);
    });
    /* 試験ハーネスは関数名を並べて正本を注入する – 新しい語を足したとき同じ場所を直す。 */
    const 抜粋 = readFileSync(join(REPO_ROOT, "tests", "runtime_extract.ts"), "utf8");
    ["uiWordStemForms", "uiWordContain", "uiWordMatch", "UI_WORD_TAILS_JA"].forEach((名前) => {
      expect(抜粋.includes(名前), `試験の注入に ${名前} が無い`).toBe(true);
    });
  });
});
