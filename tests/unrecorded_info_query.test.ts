/**
 * 収録していない情報を訪ねる語の検査（SPEC §4・§7・第 337 回）。
 * 実測（2026-09-30 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `参加費` `登録費` `費用` `無料` `有料` `経費` `旅費` `学生割引` `キャンセル料`
 * `招待講演` `基調講演` `未確定` `仮締切` `和暦` `令和` **すべて 0 行・案内も無し**で、
 * 読み上げは「語「参加費」は収録データにありません」とだけ言っていた（`site/app.ts` の
 * 収録に無い語の文）。真実だが役に立たない – 無い物を無いと言いつつ、何を収録しているか
 * 言わなかった（第 325 回で来歴の語を直した `UI_WORD_GROUPS_JA` の、手をつけていなかった語群）。
 * `未定` は受けない – 実測 6 行（実ビルド）・検査ハーネスの品書でも 1 行当たり、案内を
 * 立てれば「収録に無い」が噓になる。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 行数(語: string): number {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
  const matches = Recommender.searchMatcher(語, 基準);
  return rows.filter((row) => matches(String(row.hay)) === true).length;
}

function 案内(語: string): string {
  return Recommender.uiWordNoteJa(語);
}

describe("収録に無い情報を訪ねる語", () => {
  it("費用を訊く人には、収録している物を書いてから無い事を言う", () => {
    const 語列表 = [
      "参加費",
      "参加費用",
      "参加料",
      "登録費",
      "費用",
      "参加費無料",
      "登録費無料",
      "無料",
      "有料",
      "経費",
      "旅費",
      "学生割引",
      "キャンセル料",
    ];
    語列表.forEach((語) => {
      expect(行数(語), `"${語}" を受けてしまった`).toBe(0);
      const 文 = 案内(語);
      expect(文, `"${語}" に何も言わない`).not.toBe("");
      expect(文, `"${語}": 打たれた語を書いていない`).toContain(`「${語}」`);
      expect(文, `"${語}": 費用の欄が無いと言わない`).toContain("費用の欄はありません");
      expect(文, `"${語}": 収録している物を言わない`).toContain("締切日");
      /* 読み上げ（`site/app.ts` の live 欄）にも同じ事が届く。 */
      expect(Recommender.uiWordLiveNoteJa(語), `"${語}": 読み上げが空`).toContain("費用");
    });
  });

  it("講演の区分は持たないが、催し物の名前は当たると書く", () => {
    ["招待講演", "一般講演", "基調講演", "キーノート", "招待発表"].forEach((語) => {
      expect(行数(語), `"${語}" を受けてしまった`).toBe(0);
      const 文 = 案内(語);
      expect(文, `"${語}" に何も言わない`).not.toBe("");
      expect(文, `"${語}": 区別を持っていないと言わない`).toContain("区別はこの表が持っていません");
      /* 案内が名指す語が画面に実在する事（第 325 回からの基準）。 */
      expect(行数("ワークショップ"), "案内が名指す語が行に出ていない").toBeGreaterThan(0);
    });
  });

  it("締切の確定度を訊く人には、公式に出た日付だけである事と『延長』の出方を書く", () => {
    ["未確定", "仮締切", "暫定", "暫定締切", "確定締切", "本締切"].forEach((語) => {
      expect(行数(語), `"${語}" を受けてしまった`).toBe(0);
      const 文 = 案内(語);
      expect(文, `"${語}" に何も言わない`).not.toBe("");
      expect(文, `"${語}": 公式に出た日付だけと言わない`).toContain("公式に出した日付だけ");
      expect(文, `"${語}": 『延長』の出方を言わない`).toContain("延長");
    });
    /* 案内が『延長』で分かると言う以上、行に実在する事（実測で実ビルド 21 行）。 */
    expect(行数("延長"), "案内が名指す『延長』が行に出ていない").toBeGreaterThan(0);
  });

  it("和暦で訊く人には西暦で出していると書く", () => {
    ["和暦", "令和", "平成", "明治", "大正", "昭和"].forEach((語) => {
      expect(行数(語), `"${語}" を受けてしまった`).toBe(0);
      const 文 = 案内(語);
      expect(文, `"${語}" に何も言わない`).not.toBe("");
      expect(文, `"${語}": 西暦で出すと言わない`).toContain("西暦");
      expect(文, `"${語}": 例の書き方を言わない`).toContain("2026年8月22日");
    });
    /* 語が繋がった打ち方（`令和8年`）には案内が届かない – 受けない事を検査に留める
     * （受けない物を受けているように書かない – SPEC §7 の残りの穴）。 */
    expect(案内("令和8年")).toBe("");
  });

  it("当たっている語を『収録に無い』に混ぜない（`未定` は行に出る語）", () => {
    /* 実測で `未定` は実ビルド 6 行・検査ハーネスの品書でも 1 行当たるので、
     * 「収録に無い」の案内を立てたら噓になる。 */
    expect(行数("未定"), "`未定` が 0 行になった（前提が変わった）").toBeGreaterThan(0);
    expect(案内("未定"), "`未定` に収録に無い案内を立てた").toBe("");
    expect(Recommender.uiWordLiveNoteJa("未定")).toBe("");
  });

  it("寄せ先が在る語の案内を変えない（`ワークショップ`・`オンライン`）", () => {
    expect(行数("ワークショップ")).toBeGreaterThan(0);
    expect(案内("ワークショップ"), "行が出る語に収録に無い案内を立てた").toBe("");
    expect(String(Recommender.querySynonymNotes("ワークショップ"))).toContain("workshop");
  });

  it("成果物が四つの案内を持つ（第 337 回）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 案内の断片: Array<[RegExp, string]> = [
      [/費用の欄はありません/, "費用の案内"],
      [/区別はこの表が持っていません/, "講演の区分の案内"],
      [/仮の締切という印は持ちません/, "締切の確定度の案内"],
      [/締切は西暦で出します/, "和暦の案内"],
    ];
    案内の断片.forEach(([形, 名前]) => {
      expect(形.test(rec), `組み立てた画面から ${名前} が消えた`).toBe(true);
    });
  });
});
