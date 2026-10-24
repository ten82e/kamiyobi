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

function 件(語: string, 行々: Array<{ hay: string }>): number {
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(語, 基準), 基準);
  return 行々.filter((行) => 照合(String(行.hay)) === true).length;
}

const 載せた語 = [
  "関連する会議",
  "自分の分野に近い会議",
  "おすすめの会議",
  "自分の論文に合う会議",
  "近い分野の会議",
];

describe("どの会議に出せばよいかを聞く人（第 716 回）", () => {
  it("品書と収録の全体の両方で 0 行（案内の出る打ち方である事を先に確かめる）", () => {
    const 品 = 品書();
    const 全 = 全體();
    for (const 語 of 載せた語) {
      expect(件(語, 品), `品書で行が出た: ${語}`).toBe(0);
      expect(件(語, 全), `收錄の全體で行が出た: ${語}`).toBe(0);
    }
  });

  it("黙らず、候補を出す機能へ渡す", () => {
    for (const 語 of 載せた語) {
      const 文 = String(Recommender.uiWordNoteJa(語, false) || "");
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `候補を出す機能へ渡して居ん: ${語}`).toContain("『投稿先を探す』");
      /* 表が持たない物を持つている樣に言はない。 */
      expect(文, `持つて居る樣に言つた: ${語}`).not.toContain("絞り込めません");
    }
  });

  it("読み上げは短く、斷りはそれより長い（声だけ惡くならず – 第 651 回）", () => {
    for (const 語 of 載せた語) {
      const 聲 = String(Recommender.uiWordLiveNoteJa(語) || "");
      expect(聲, `讀み上げが無い: ${語}`).not.toBe("");
      expect([...聲].length, `讀み上げが六十を越える: ${語}`).toBeLessThanOrEqual(60);
      expect([...String(Recommender.uiWordNoteJa(語, false) || "")].length).toBeGreaterThanOrEqual(
        [...聲].length,
      );
    }
  });

  it("行が出る語と、既存の群の扱ひを変へて居ない", () => {
    const 品 = 品書();
    for (const 語 of ["カメラレディ", "デモ", "ポスター"]) {
      expect(件(語, 品), `前提が崩れた: ${語}`).toBeGreaterThan(0);
      expect(String(Recommender.uiWordNoteJa(語, false) || ""), `斷りを付けた: ${語}`).toBe("");
    }
    /* 同じ「探す」でも、投稿先（システム）の群は別の事を答へる（こちらへ取り込んで居ない）。 */
    for (const 語 of ["提出方法", "投稿先を探す"]) {
      expect(件(語, 品), `前提が崩れた（0 行）: ${語}`).toBe(0);
      expect(String(Recommender.uiWordNoteJa(語, false) || ""), `別の群の斷り: ${語}`).toContain(
        "EasyChair",
      );
    }
  });
});
