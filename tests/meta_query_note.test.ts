/**
 * データの来歴・持ち出しの語を打った人の検査（SPEC §4・§7・第 325 回）。
 * 2026-09-26 実測: 実際の打ち方 116 語と来歴まわりの語 36 語を並べたとき、`更新頻度`
 * `信頼性` `収録範囲` `印刷` `共有` など 35 語は**品書 872 行で 0 行・案内も無く**、
 * 読み上げは「語「更新頻度」は収録データにありません」とだけ言っていた。真実だが役に立たない –
 * 答えはこの画面に在る（右上の『データ生成』・画面下の『データ源』・ページ下の『見方のてびき』）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string };

const AT = Date.parse("2026-08-09T00:00:00Z");

/** 生成・鮮度の語 */
const 更新の語 = [
  "更新",
  "更新日時",
  "最終更新",
  "更新頻度",
  "最新版",
  "鮮度",
  "データの鮮度",
  "生成",
  "生成時刻",
  "データ生成",
  "いつ更新",
  "データ更新",
  "変更履歴",
];
/** 出典・裏取りの語 */
const 出典の語 = [
  "データの出典",
  "データ源",
  "元のデータ",
  "データ元",
  "信頼性",
  "正確性",
  "正確",
  "誤り",
  "間違い",
  "根拠",
  "健全性",
];
/** 収録の範囲・件数の語 */
const 収録範囲の語 = [
  "収録期間",
  "収録範囲",
  "収録の範囲",
  "収録対象",
  "収録の期間",
  "全件数",
  "何件",
  "どこまで収録",
];
/** 印刷・共有の語 */
const 持ち出しの語 = [
  "印刷",
  "印刷する",
  "プリント",
  "pdf",
  "共有",
  "共有する",
  "リンク",
  "リンクをコピー",
  "共有リンク",
];
const 全語 = [...更新の語, ...出典の語, ...収録範囲の語, ...持ち出しの語];

/** 収録（実データ）で行に当たる語 – 当たるときは当たっているので、0 件の premise を別途見る。 */
const 当たり有 = new Set(["信頼性", "pdf"]);

function 収録(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")),
  ) as Row[];
}

function 当たり(rows: Row[], query: string): number {
  const match = Recommender.searchMatcher(query, AT);
  return rows.filter((row) => match(row.hay) === true).length;
}

/* 案内が指す場所の名前の正本。`id="genat"` の中身は実行時に書かれるので、生成時刻の
 * ラベルは `site/app.ts` に書いた物が正本になる（`id="sources"` と `<dt>データ源</dt>` は
 * 画面のMarkupに在る）。 */
function 画面の正本(): { 生成: string; 源: string; てびき: string } {
  const html = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const app = readFileSync(join(REPO_ROOT, "site", "app.ts"), "utf8");
  const ラベル有 = /「データ生成」|>データ生成</.test(app) && /id="genat"/.test(html);
  const 源有 = /<dt>データ源<\/dt>/.test(html) && /id="sources"/.test(html);
  const summary = /<summary>(見方のてびき[^<]*)<\/summary>/.exec(html);
  return {
    生成: ラベル有 ? "データ生成" : "",
    源: 源有 ? "データ源" : "",
    てびき: summary ? summary[1] : "",
  };
}

describe("データの来歴と持ち出しの語を打つ人", () => {
  it("41 語すべてに案内が有り、打った語を文に織り込む", () => {
    全語.forEach((語) => {
      const 文 = Recommender.uiWordNoteJa(語);
      expect(文, `"${語}" を打った人に何も言わない`).not.toBe("");
      expect(文.includes(`「${語}」`), `"${語}": 打った語を言わない`).toBe(true);
      /* 検索では絞れないことを毎回言う（当たりが行に在る語と混同させない）。 */
      expect(
        文.includes("検索では絞り込めません") || 文.includes("この画面では絞り込みで動いた"),
        `"${語}": 検索で絞れないことを言わない`,
      ).toBe(true);
    });
  });

  it("案内が指す場所の名前は、画面の正本と一致する", () => {
    const 正本 = 画面の正本();
    expect(正本.生成, "右上の生成時刻の欄が見つからない").toBe("データ生成");
    expect(正本.源, "画面下の出典の欄が見つからない").toBe("データ源");
    expect(正本.てびき.includes("見方のてびき"), "てびきの項が見つからない").toBe(true);
    更新の語.forEach((語) => {
      expect(
        Recommender.uiWordNoteJa(語).includes(正本.生成),
        `"${語}": 生成時刻の場所を言わない`,
      ).toBe(true);
    });
    出典の語.forEach((語) => {
      expect(Recommender.uiWordNoteJa(語).includes(正本.源), `"${語}": 出典の場所を言わない`).toBe(
        true,
      );
    });
    [...持ち出しの語, ...収録範囲の語].forEach((語) => {
      expect(
        Recommender.uiWordNoteJa(語).includes("見方のてびき"),
        `"${語}": てびきを言わない`,
      ).toBe(true);
    });
  });

  it("読み上げも同じ場所へ送り、収録に無い語の文に落ちない", () => {
    const js = readFileSync(join(builtSite(), "app.js"), "utf8");
    /* 読み上げの文は「打った語 + live」なので、live を空にすると語だけを読み上げる
     * （空文字にはならない – 実測で検査の穴だった）。場所の名前が実際に残っているかを見る。 */
    const 正本 = 画面の正本();
    [...更新の語, ...出典の語, ...収録範囲の語, ...持ち出しの語].forEach((語) => {
      const 声 = Recommender.uiWordLiveNoteJa(語);
      expect(声, `"${語}": 読み上げが空`).not.toBe("");
      const 場所 =
        更新の語.indexOf(語) >= 0
          ? 正本.生成
          : 出典の語.indexOf(語) >= 0
            ? 正本.源
            : "見方のてびき";
      expect(声.includes(場所), `"${語}": 読み上げが場所を言わない（語だけの読み上げ）`).toBe(true);
      expect(
        声.includes("検索では絞り込めません") || 声.includes("コピー"),
        `"${語}": 読み上げが絞れないことを言わない`,
      ).toBe(true);
    });
    /* 収録に無い語の文より前に、この案内が立っていること（順を入れ替えると
     * 「語「更新頻度」は収録データにありません」が先に読める – 今回直した欠陥の形）。 */
    /* 注釈に同じ文が書いてあるので、読むのは組み立てた文の形（末尾の pointer まで） –
     * 実行処理の場所を比較する。 */
    const 案内の位置 = js.indexOf("Recommender.uiWordLiveNoteJa(");
    /* 文字列リテラルに ${ を書くと検査器が警告になるので、正規表現で探す。 */
    const 無い語の位置 = js.search(/は収録データにありません\$\{pointer\}`/);
    expect(案内の位置, "読み上げの案内が消えた").toBeGreaterThan(-1);
    expect(無い語の位置, "収録に無い語の文が消えた（前提的变化）").toBeGreaterThan(-1);
    expect(案内の位置 < 無い語の位置, "収録に無い語の文が先に立つ順になった").toBe(true);
    /* 0 件のときだけ画面に出す門も、壊れていないことを見る。 */
    expect(js, "0 件の門が消えた").toMatch(/matchedRows === 0 \? Recommender\.uiWordNoteJa/);
  });

  it("当たりが無い語の案内であること（収録で 0 行）・当たる語は別に有る", () => {
    const rows = 収録();
    全語.forEach((語) => {
      const 件 = 当たり(rows, 語);
      if (当たり有.has(語)) {
        expect(件, `"${語}" は収録で行に当たる予定（前提が変わった）`).toBeGreaterThan(0);
      } else {
        expect(件, `"${語}" が収録で行に当たるようになった（案内を見直す）`).toBe(0);
      }
    });
  });

  it("語を並べた打ち方には出さない（複合の絞り込みを邪魔しない）", () => {
    ["更新頻度 2026", "印刷 関西", "信頼性 機械学習", "共有 URL", "収録範囲 量子"].forEach((文) => {
      expect(Recommender.uiWordNoteJa(文), `"${文}" に案内を立てた`).toBe("");
    });
  });
});
