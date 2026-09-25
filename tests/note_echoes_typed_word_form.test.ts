/**
 * 案内が書く語は **打たれた形**（大文字のまま）である事の検査。SPEC §4・§7・第 366 回。
 * 実測（2026-10-22 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）で、
 * 直し前は案内が大文字に直した語を小文字で書き直していた – 『ICS』を打った人に「ics」、
 * 『HPCの会議』に「他の語（「hpc」）」、『生成AI』に「生成ai」、全角の『ＡＩ』に「ai」。
 * 同じ画面の件数の行は「検索語『AI』」と打たれた形を書く（site/app.ts）ので、食い違っていた。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 全案内(語: string): string {
  return [
    Recommender.querySynonymNotes(語).join(" "),
    Recommender.uiWordNoteJa(語),
    Recommender.dayRangeNoteJa(語),
    Recommender.relativeDayNotes(語, 基準).join(" "),
  ]
    .filter((x) => x)
    .join(" ");
}

describe("大文字で打たれた略語の案内", () => {
  it("打たれた大文字の侭書く（小文字に書き返さない）", () => {
    const 形: Array<[string, string]> = [
      ["ICS", "ICS"],
      ["生成AI", "生成AI"],
      ["生成AI 関西", "生成AI"],
      ["HPCの会議", "HPC"],
      ["AI セキュリティの会議", "AI"],
      ["MLの会議", "ML"],
      ["NLP 会議", "NLP"],
    ];
    for (const [打ち方, 書く語] of 形) {
      const 案内 = 全案内(打ち方);
      expect(案内, `\`${打ち方}\` の案内が消えた`).toContain(`「${書く語}」`);
      expect(
        案内,
        `\`${打ち方}\` の案内が小文字に書き返している（直し前の実測 – 「${書く語.toLowerCase()}」）`,
      ).not.toContain(`「${書く語.toLowerCase()}」`);
    }
  });

  it("小文字で打った人は小文字の侭書く（直した事を見せない – 其の方が其の方の形）", () => {
    expect(全案内("ics")).toContain("「ics」");
    expect(全案内("生成ai")).toContain("「生成ai」");
    expect(全案内("hpcの会議")).toContain("「hpc」");
  });

  it("語に割れた先は、打たれた語の先頭ぶんを切る（助詞で割れた形 – 第 365 回の語の割れ方）", () => {
    /* 『AIの会議』は `ai` + `会議` に割れる – 其の時 案内は**打たれた語の先頭**を書く。
     * 実測で此の節を外すと「ai」に戻った（改ざん検査で張る）。 */
    expect(全案内("AIの会議")).toContain("「AI」");
    expect(全案内("aiの会議")).toContain("「ai」");
  });

  it("全角で打った形は全角の侭書く", () => {
    const 案内 = 全案内("ＡＩの会議");
    expect(案内, "全角で打たれた形が半角に直された").toContain("「ＡＩ」");
  });
});

describe("他の語の書き換え", () => {
  it("片仮名・漢字の語は別の形に直さない（片仮名を平仮名に直す折りは案内に使わない）", () => {
    /* 実測で「スパコン」の案内が平仮名に化けた – 検索の照合で使う折りを案内に流し込んだ形。
     * 其れは打たれた語を画面から消すので、別の語を取り違える物として張る。 */
    for (const 語 of [
      "スパコン",
      "組込みシステム",
      "カメラレディ期限",
      "分散コンピューティング",
      "ディープラーニング",
    ]) {
      const 案内 = 全案内(語);
      expect(案内, `\`${語}\` の案内が消えた`).toContain(語);
      expect(案内, `\`${語}\` の案内が平仮名に直している`).not.toContain(
        語.replace(/[\u30a1-\u30fa]/g, (字) => String.fromCharCode(字.charCodeAt(0) - 96)),
      );
    }
  });

  it("案内の行き先は変わっていない（書き方だけ直した – 誘導先を動かさない）", () => {
    expect(全案内("ICS")).toContain("会議名の中に語の途中として含まれる行");
    expect(全案内("生成AI")).toContain("原文に generative と書かれた行");
    expect(全案内("HPCの会議")).toContain("この表の全行にあてはまる語");
    expect(全案内("生成AI")).toContain("『AI』で絞れます");
  });

  it("件数欄が打たれた形を書く決まりと食い違わない（同じ画面の中で二つの言い方をしない）", () => {
    /* 件数欄を書き出すのは画面の側（site/app.ts → ビルド成果物の app.js）なので、其處を読む。 */
    const 画面 = readFileSync(join(builtSite(), "app.js"), "utf8");
    expect(画面, "件数欄が打たれた語を書かなくなった（上の決まりの片方が壊れた）").toContain(
      "検索語「",
    );
  });
});

describe("成果物", () => {
  it("直し方が実測どおりの形で成果物に入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const [条目, 数] of [
      ["function 打たれた表記Ja", 1],
      /* 呼出し六箇所 + 成果物に残る定義文一行（定義の文も同じ形を書く）。 */
      ["打たれた表記Ja(query,", 7],
    ] as Array<[string, number]>) {
      expect(rec.split(条目).length - 1, `成果物の中の語の数: ${条目.slice(0, 18)}`).toBe(数);
    }
  });
});
