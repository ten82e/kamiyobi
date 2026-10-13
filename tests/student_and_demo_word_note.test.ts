import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): string[] {
  return (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
}

function 件(語: string): number {
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(語, 基準), 基準);
  return 品書().filter((行) => 照合(行) === true).length;
}

const 載せた語: Array<[string, string]> = [
  ["学生でも投稿できる", "募集対象や旅費の支援の有無"],
  ["学生でも参加できる", "募集対象や旅費の支援の有無"],
  ["学生が投稿できる", "募集対象や旅費の支援の有無"],
  ["学生でも発表できる", "募集対象や旅費の支援の有無"],
  ["デモができる会議", "運営と手続きのこと"],
  ["デモ発表がある", "運営と手続きのこと"],
];

describe("学生でも投稿できるか・デモができるかを聞く人（第 719 回）", () => {
  it("品書で 0 行（案内の出る打ち方である事を先に確かめる）", () => {
    for (const [語] of 載せた語) {
      expect(件(語), `行が出た: ${語}`).toBe(0);
    }
  });

  it("黙らず、その群の斷りを受ける", () => {
    for (const [語, 印] of 載せた語) {
      const 文 = String(Recommender.uiWordNoteJa(語, false) || "");
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `其の群の斷りで無い: ${語}`).toContain(印);
      /* 表が持たない物を、絞り込める物のやうに言はない。 */
      expect(文, `絞り込めると言つた: ${語}`).not.toContain("絞り込めません");
    }
  });

  it("読み上げは六十字まで・同じ群の既存語の扱ひを変へて居ない", () => {
    for (const [語] of 載せた語) {
      const 聲 = String(Recommender.uiWordLiveNoteJa(語) || "");
      expect(聲, `讀み上げが無い: ${語}`).not.toBe("");
      expect([...聲].length, `讀み上げが長い: ${語}`).toBeLessThanOrEqual(60);
    }
    for (const [語, 印] of [
      ["初心者", "募集対象や旅費の支援の有無"],
      ["初めての投稿", "募集対象や旅費の支援の有無"],
      ["出張届", "運営と手続きのこと"],
      ["出張申請", "運営と手続きのこと"],
    ] as Array<[string, string]>) {
      expect(件(語), `行が出た: ${語}`).toBe(0);
      expect(String(Recommender.uiWordNoteJa(語, false) || ""), `斷りが消えた: ${語}`).toContain(
        印,
      );
    }
    /* 比べる打ち手には斷りを乘せない（第 656・362 回の境界）。 */
    for (const 語 of ["参加費が高い", "査読が厳しくない会議", "費用が安い会議"]) {
      expect(String(Recommender.uiWordNoteJa(語, false) || ""), `境界に觸れた: ${語}`).toBe("");
    }
    /* 行が出る語に斷りを付けない。 */
    for (const 語 of ["学生", "参加登録", "デモ"]) {
      expect(件(語), `前提が崩れた（0 行）: ${語}`).toBeGreaterThan(0);
      expect(String(Recommender.uiWordNoteJa(語, false) || ""), `斷りを付けた: ${語}`).toBe("");
    }
  });
});
