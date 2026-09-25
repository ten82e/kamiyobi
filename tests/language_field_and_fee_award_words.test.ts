/**
 * 使用言語・渡航費・賞の言い方と『国外開催』（第 387 回）。実測（2026-09-25 – 2026-08-09 生成の
 * 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * - `日本語` `英語` `英語のみ` `日本語の会議` `日本語で発表` `日本語での発表` `日本語講演`
 *   `使用言語` `発表言語` `多言語` は 0 行で案内も無しだった。品書の文本にも言語の情報は在らない
 *   （`english` 0 箇所・`in english` 0 箇所 – 実ビルド 872 行）。**但し `言語` は 31 行・
 *   `language` は 41 行通る**（会議の名前に含まれる語 – 実測）ので、其の語を「収録に無い」の群に
 *   入れると噓になる。`bilingual` も名前の一部に 2 行在る。
 * - `渡航支援` `トラベルグラント` `発表支援` `経費支援` `渡航費補助` `参加費支援` と
 *   `奨励賞` `学生奨励賞` `ベストペーパー賞` `最優秀発表賞` は 0 行で案内も無しだった（同じ群の
 *   `渡航費` `ベストペーパー` `受賞` `表彰` `論文賞` は案内が出る – 実測）。
 * - 『国外』639 行・『海外開催』639 行が通るのに、其の二つを繋げた `国外開催` だけ 0 行だった。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書の生(): string {
  return readFileSync(join(builtSite(), "catalog.json"), "utf8");
}

function 品書(): Array<{ hay: string }> {
  const catalog = JSON.parse(品書の生()) as unknown as never;
  return Recommender.candidateRows(catalog) as unknown as Array<{
    hay: string;
  }>;
}

function 当たり列表(語: string): string[] {
  const 当 = Recommender.searchMatcher(語, 基準);
  return 品書()
    .filter((行) => 当(String(行.hay)) === true)
    .map((行) => String(行.hay))
    .sort();
}

function 対称差(a: string[], b: string[]): number {
  const 左 = new Set(a);
  const 右 = new Set(b);
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}

function 全案内(語: string): string {
  const 入口 = [
    "columnQueryLiveNoteJa",
    "uiWordLiveNoteJa",
    "dayRangeLiveNoteJa",
    "wholeTableQueryNoteJa",
  ] as const;
  const 表 = Recommender as unknown as Record<
    (typeof 入口)[number],
    (q: string) => string | undefined
  >;
  return 入口.map((名) => String(表[名](語) || "")).join(" | ");
}

const 言語 = [
  "日本語",
  "英語",
  "英語のみ",
  "日本語の会議",
  "日本語で発表",
  "日本語での発表",
  "日本語講演",
  "使用言語",
  "発表言語",
  "多言語",
];
const 費用 = ["渡航支援", "トラベルグラント", "発表支援", "経費支援", "渡航費補助", "参加費支援"];
const 賞 = ["奨励賞", "学生奨励賞", "ベストペーパー賞", "最優秀発表賞"];

describe("使用言語の案内", () => {
  it("言語を訊いた人に、欄が在らない事を言って公式ページへ導す", () => {
    for (const 語 of 言語) {
      expect(当たり列表(語), `当たりが出てしまった: ${語}`).toEqual([]);
      const 案内 = 全案内(語);
      expect(案内, `案内が出ない: ${語}`).toContain("発表に使う言語の欄はありません");
      expect(案内, `公式ページへ導さない: ${語}`).toContain("公式ページ");
    }
  });

  it("収録に在る語を『収録に無い』と言わない（言語の語は別の表し方で現れる）", () => {
    /* `言語` 31 行・`language` 41 行・`bilingual` 2 行は会議の名前に含まれる語なので（実測 –
     * 実ビルドの品書 872 行）、当たりが在る語を案内の群に足して居ない事を張る。ハーネスの品書
     * （435 行）では `言語` の当たりが 0 行になるので、行の数では張れない – 案内が出ない事で張る。 */
    expect(品書の生().toLowerCase()).toContain("bilingual");
    for (const 語 of ["言語", "language", "bilingual"]) {
      expect(全案内(語), `当たりが在る語に案内を被せた: ${語}`).not.toContain(
        "発表に使う言語の欄はありません",
      );
    }
    /* 「言語の情報を一切収録して居ない」とは言わない（名前に現れる為 – 噓になる）。案内は
     * **欄の話**だけ言わせる – 品書その物の話をさせる文言は置かない。 */
    for (const 語 of 言語) {
      const 案内 = 全案内(語);
      expect(案内, `品書の話をし出した: ${語}`).not.toContain("品書");
      expect(案内, `情報が在らないと言っている: ${語}`).not.toContain("情報は在りません");
      expect(案内, `欄の話をして居ない: ${語}`).toContain("欄");
    }
  });
});

describe("渡航費と賞の別の言い方", () => {
  it("費用の言い方は費用の案内へ行く", () => {
    for (const 語 of 費用) {
      expect(当たり列表(語), `当たりが出てしまった: ${語}`).toEqual([]);
      const 案内 = 全案内(語);
      expect(案内, `費用の案内が出ない: ${語}`).toContain("費用の欄はありません");
      /* 意味の違う群に混じらない（賞の話と混じると案内が噓になる）。 */
      expect(案内, `賞の案内に混じた: ${語}`).not.toContain("其れらを書く欄はありません");
    }
  });

  it("賞の言い方は賞の案内へ行く", () => {
    for (const 語 of 賞) {
      expect(当たり列表(語), `当たりが出てしまった: ${語}`).toEqual([]);
      const 案内 = 全案内(語);
      expect(案内, `賞の案内が出ない: ${語}`).toContain("其れらを書く欄はありません");
      expect(案内, `費用の案内に混じた: ${語}`).not.toContain("費用の欄はありません");
    }
    /* 既存の語の案内は無傷（実測で既に案内がでて居た語）。 */
    for (const 語 of ["ベストペーパー", "受賞", "表彰"]) {
      expect(全案内(語), `既存の案内が消えた: ${語}`).toContain("其れらを書く欄はありません");
    }
    for (const 語 of ["渡航費", "掲載料", "学割"]) {
      expect(全案内(語), `既存の費用の案内が消えた: ${語}`).toContain("費用の欄はありません");
    }
  });
});

describe("国外開催", () => {
  it("『国外』と『海外開催』を繋げた言い方も同じ行列表を通す", () => {
    const 正 = 当たり列表("国外");
    expect(正.length, "品書に国外の行が無い").toBeGreaterThan(0);
    expect(対称差(当たり列表("国外開催"), 正), "当たり列表が違う").toBe(0);
    expect(対称差(当たり列表("海外開催"), 当たり列表("海外")), "`海外開催` を壊した").toBe(0);
    /* 国内は別の規則が受ける（実測 38 行 – 変えて居ない）。 */
    expect(対称差(当たり列表("国内開催"), 当たり列表("国内")), "`国内開催` を壊した").toBe(0);
  });

  it("案内を立てる表と見出しの語の両方に書いて在る（片方だけ足すと 0 行の侭だった）", () => {
    const 成果物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    /* 実測で 2 回 – ①行を出す表 ②案内文を立てる見出しの語。第 387 回で①だけ足した侭では
     * 0 行の侭だつたので、両方有る事をここで張る。 */
    expect(成果物.split('"国外開催"').length - 1).toBe(2);
    /* 言語の案内の群は一度だけ書いて在る（案内の文は note と live の 2 处 – 実測）。 */
    expect(成果物.split("発表に使う言語の欄はありません").length - 1).toBe(2);
    for (const 語 of [...言語, ...費用, ...賞]) {
      expect(成果物.split(`"${語}"`).length - 1, `条目の数が違う: ${語}`).toBe(1);
    }
  });
});
