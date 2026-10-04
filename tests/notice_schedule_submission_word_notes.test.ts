/**
 * 通知・会期・投稿先・並び替えの言い方（第 385 回）。実測（2026-09-25 – 2026-08-09 生成の
 * 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * - 種別『採否通知』は `採択通知` `結果通知` `受理通知` `合否` で 129 行通るのに、`結果発表`
 *   `アクセプト` は **0 行で案内も無し**だった。
 * - 列『会期』は 185 行通るのに、`日程` `開催日` `開催日程` `開催時期` `いつ開催` `開始日`
 *   `終了日` は **0 行で案内も無し**だった。
 * - `提出方法` `投稿システム` `投稿サイト` `投稿先` `提出先` `電子投稿` `オンライン提出`
 *   `フォーム` `paperback` は 0 行で案内も無しだった – この表は投稿を受けるシステムを欄として
 *   持って居ない（但し `easychair` は原文に現れる – 実測 57 行 / 品書の文本 309 箇所なので、
 *   案内は「欄はありません」とだけ言う）。
 * - `日付順` `sort` は並び替えの話なのに案内も無かった（同じ群の `並べ替え` `名前順` は出る）。
 * 寄せない語: `採択通知日` は日付の打ち直しの話（`tests/concept_compound_query.test.ts` が張る
 * – 第 245 回）。`Accept` は実測 41 行で別の当たり方をして居る。`easychair` 57 行と `投稿`
 * 461 行を案内の群に入れて当たりを「収録に無い」と言わない。
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

function 語の組(語: string): string[][] {
  return (
    Recommender as unknown as {
      queryTokenGroups: (q: unknown, now?: number) => string[][];
    }
  ).queryTokenGroups(語, 基準);
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

const 通知 = ["結果発表", "アクセプト"];
const 会期 = ["日程", "開催日", "開催日程", "開催時期", "いつ開催", "開始日", "終了日"];
const 投稿先 = [
  "提出方法",
  "投稿システム",
  "投稿サイト",
  "投稿先",
  "提出先",
  "電子投稿",
  "オンライン提出",
  "フォーム",
  "paperback",
  "Paperback",
];

describe("採否通知と会期の言い方", () => {
  it("通知の別の言い方も種別『採否通知』の行を其侭通す", () => {
    const 正 = 当たり列表("採択通知");
    expect(正.length, "品書に採否通知の行が無い").toBeGreaterThan(0);
    for (const 語 of 通知) {
      expect(対称差(当たり列表(語), 正), `当たり列表が違う: ${語}`).toBe(0);
      expect(Recommender.querySynonymNotes(語).join("・"), `寄せの案内が無い: ${語}`).toContain(
        "採否通知",
      );
    }
  });

  it("会期を訊く言い方も列『会期』の行を其侭通す", () => {
    const 正 = 当たり列表("会期");
    expect(正.length, "品書に会期を持つ行が無い").toBeGreaterThan(0);
    for (const 語 of 会期) {
      expect(対称差(当たり列表(語), 正), `当たり列表が違う: ${語}`).toBe(0);
      const 案内 = Recommender.querySynonymNotes(語).join("・");
      expect(案内, `寄せの案内が無い: ${語}`).toContain("会期");
      expect(案内, `列の名前を書かない案内: ${語}`).toContain("列");
    }
  });

  it("`採択通知日` を寄せに混ぜない（日付の打ち直しの話 – 第 245 回の決まり）", () => {
    /* 語の組は空格で割れた形を並べるので、一続きの語は一個の組になる（実測 – 割っても 1 組）。
     * 寄せて居ない事は、其の組に寄せ先の語が入って居ない事と、寄せの案内が出ない事で張る。
     * 語の割れ方その物は `tests/concept_compound_query.test.ts` が張って居る（第 245 回）。 */
    for (const 組 of 語の組("採択通知日")) {
      expect(組, "『採択通知日』を採否通知へ寄せた").not.toContain("採否通知");
    }
    expect(Recommender.querySynonymNotes("採択通知日")).toEqual([]);
  });

  it("`Accept` の当たり方を変えない（41 行 – 別の当たり方を 129 行に寄せない）", () => {
    const アクセプト = 当たり列表("Accept");
    expect(アクセプト.length, "`Accept` の当たりが消えた").toBeGreaterThan(0);
    expect(
      対称差(アクセプト, 当たり列表("採択通知")),
      "`Accept` を採否通知に寄せて意味を変えた",
    ).toBeGreaterThan(0);
    expect(Recommender.querySynonymNotes("Accept")).toEqual([]);
  });
});

describe("投稿先と並び替えの案内", () => {
  it("投稿先は欄として無いと教え、行は發明しない", () => {
    for (const 語 of 投稿先) {
      expect(当たり列表(語), `当たりが出てしまった: ${語}`).toEqual([]);
      const 案内 = 全案内(語);
      expect(案内, `案内が出ない: ${語}`).toContain("投稿先の欄はありません");
      expect(案内, `公式ページへ導さない: ${語}`).toContain("公式ページ");
    }
  });

  it("収録に在る語を『収録に無い』と言わない（EasyChair は原文に現れる）", () => {
    /* 案内は「欄はありません」とだけ言う – データに全く無いと言うのは噓になる（実測 – 品書の文本に
     * easychair が現れる。当たり 57 行 – 実ビルド）。 */
    expect(品書の生().toLowerCase()).toContain("easychair");
    for (const 語 of 投稿先) {
      expect(全案内(語), `収録に全く無いと言っている: ${語}`).not.toContain(
        "EasyChair は収録していません",
      );
    }
    /* 当たりの在る語を案内の群に混じれない。 */
    for (const 語 of ["easychair", "投稿"]) {
      expect(当たり列表(語).length, `当たりが消えた: ${語}`).toBeGreaterThan(0);
      expect(全案内(語), `当たりが在る語に案内を被せた: ${語}`).not.toContain(
        "投稿先の欄はありません",
      );
    }
  });

  it("並び替えの語も列の見出しへ導す", () => {
    for (const 語 of ["日付順", "sort"]) {
      expect(当たり列表(語), `当たりが出てしまった: ${語}`).toEqual([]);
      expect(全案内(語), `案内が出ない: ${語}`).toContain("列の見出し");
    }
    for (const 語 of ["並べ替え", "名前順"]) {
      expect(全案内(語), `既存の案内が消えた: ${語}`).toContain("列の見出し");
    }
  });

  it("足した条目が成果物に一度だけ入っている", () => {
    const 成果物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const 語 of [
      ...通知,
      ...会期,
      ...投稿先.filter((語) => 語 !== "Paperback"),
      "日付順",
      "sort",
    ]) {
      /* 正規表現にしない – `A*` の様な語を渡すと量符に読める（第 318 回）。 */
      const 数 = 成果物.split(`"${語}",`).length - 1;
      if (語 === "開始日") {
        /* `開始日` は別の案内の文にも出て来る語なので（実測 2 回）、寄せの条目その物で張る。 */
        expect(
          成果物.split(`["開始日", "列「会期」", ["会期"]]`).length - 1,
          "寄せの条目の数が違う",
        ).toBe(1);
        continue;
      }
      expect(数, `条目の数が違う: ${語}`).toBe(1);
    }
    /* 案内の群は一度だけ書いて在る（二度書くと画面に同じ案内が二つ並ぶ）。 */
    expect(成果物.split("投稿先の欄はありません").length - 1).toBe(1);
    /* 大文字の `Paperback` は別条目にしない – 群の語は大小を区別しない（第 383 回の冗長条目の
     * 教訓 – 実測で `paperback` `Paperback` `PAPERBACK` いずれも同じ案内が出る）。 */
    expect(成果物.split('"Paperback"').length - 1).toBe(0);
  });
});
