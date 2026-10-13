import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  return Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
}

function 全體(): Array<{ hay: string }> {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8")),
  ) as unknown as Array<{ hay: string }>;
}

function 行列表(語: string, 行々: Array<{ hay: string }> = 品書()): string[] {
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(語, 基準), 基準);
  return 行々
    .filter((行) => 照合(String(行.hay)) === true)
    .map((行) => String(行.hay))
    .sort();
}

const 件 = (語: string): number => 行列表(語).length;
const 案内 = (語: string): string => String(Recommender.uiWordNoteJa(語, false) || "");
const 讀み上げ = (語: string): string => String(Recommender.uiWordLiveNoteJa(語) || "");

/** 間に合はなかつた人の言ひ方（過去の群へ載せた）。 */
const 間に合わなかつた語 = [
  "締切を過ぎた",
  "締切が過ぎた",
  "締切に遅れた",
  "申込を忘れた",
  "登録を忘れた",
  "応募を忘れた",
  "出し忘れた",
  "間に合わなかった",
];

/** 会の開き方を聞く語（新しい群）。 */
const 開き方の語 = [
  "毎年開催",
  "隔年開催",
  "毎年やっている",
  "隔年でやっている",
  "何回目",
  "第何回",
];

describe("締切に間に合はなかつた人の言ひ方（第 700 回）", () => {
  it("品書と収録の全体の両方で 0 行（案内の出る打ち方である事を先に確かめる）", () => {
    const 全 = 全體();
    for (const 語 of [...間に合わなかつた語, ...開き方の語]) {
      expect(件(語), `品書で行が出た: ${語}`).toBe(0);
      expect(行列表(語, 全).length, `收錄の全體で行が出た: ${語}`).toBe(0);
    }
  });

  it("黙らず、過去の出し方（『過去の締切も表示』）を言う", () => {
    for (const 語 of 間に合わなかつた語) {
      const 文 = 案内(語);
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `出し方を言つて居ん: ${語}`).toContain("過去の締切も表示");
      expect(文, `其の語では絞れんと言つて居ん: ${語}`).toContain("絞り込めません");
    }
    /* 同じ群の既存語の扱ひを変へて居ない。 */
    for (const 語 of ["前回", "過去", "去年", "終了した会議"]) {
      expect(件(語), `行が出た: ${語}`).toBe(0);
      expect(案内(語), `斷りが消えた: ${語}`).toContain("過去の締切も表示");
    }
  });

  it("読み上げは短く、斷りはそれより長い（声だけ惡くならん – 第 651 回）", () => {
    for (const 語 of [...間に合わなかつた語, ...開き方の語]) {
      const 聲 = 讀み上げ(語);
      expect(聲, `讀み上げが無い: ${語}`).not.toBe("");
      expect([...聲].length, `讀み上げが六十を越える: ${語}`).toBeLessThanOrEqual(60);
      expect([...案内(語)].length, `斷りが讀み上げより短い: ${語}`).toBeGreaterThanOrEqual(
        [...聲].length,
      );
    }
  });
});

describe("会の開き方を聞く人（第 700 回）", () => {
  it("黙らず、行の詳細の『会議の續いている年数』を名指す", () => {
    for (const 語 of 開き方の語) {
      const 文 = 案内(語);
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `欄の名前で無いと言つて居ん: ${語}`).toContain(
        "はこの表が持つ欄の名前ではありません",
      );
      expect(文, `手がかりを名指して居ん: ${語}`).toContain("会議の続いている年数");
      /* **何處に出るか**まで書く（実測で一度間違へた – 行の詳細には出ず、『投稿先を探す』の
       * 候補カードに出る。HeadlessChrome で行の詳細を開いて文字を探し、無い事を確かめた）。*/
      expect(文, `出る場所を間違へて居る: ${語}`).toContain("候補カード");
      expect(文, `公式ページへ導いて居ん: ${語}`).toContain("公式ページ");
      /* 持たない物を斷り、ある物へ渡す（数を發しない – 第 535 回）。 */
      expect(/[0-9０-９]/.test(文), `數を發して居る: ${語}`).toBe(false);
    }
  });

  it("名指した『会議の續いている年数』は、候補カードの組み立てに実際にある", () => {
    const app = readFileSync(join(builtSite(), "app.js"), "utf8");
    expect(app, "『会議の続いている年数』がない").toContain("会議の続いている年数");
    expect(app, "『確認した年』がない").toContain("確認した年");
    const 候補 = app.slice(app.indexOf("function makeRecommendationCard"));
    expect(候補, "候補カードの外に出ている").toContain("会議の続いている年数");
  });
});
