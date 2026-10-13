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

/** 載せた語と、その群の斷りに必ず出る語。 */
const 載せた語: Array<[string, string]> = [
  ["学会参加の許可", "運営と手続きのこと"],
  ["参加の許可", "運営と手続きのこと"],
  ["出張申請", "運営と手続きのこと"],
  ["発表時間が長い", "運営と手続きのこと"],
  ["質疑応答が長い", "運営と手続きのこと"],
  ["時差が少ない", "持っていません"],
  ["長期滞在が必要", "持っていません"],
  ["子供連れで参加", "持っていません"],
  ["治安が良い場所", "持っていません"],
  ["渡航費が高い", "費用の欄はありません"],
  ["締切を忘れた", "過去の締切も表示"],
  ["締切を逃した", "過去の締切も表示"],
  ["締切に気づかなかった", "過去の締切も表示"],
  ["参加費を払った", "費用の欄はありません"],
];

describe("文の見本の残りを、既存の群で受ける（第 715 回）", () => {
  it("品書と収録の全体の両方で 0 行（案内の出る打ち方である事を先に確かめる）", () => {
    const 全 = 全體();
    for (const [語] of 載せた語) {
      expect(件(語), `品書で行が出た: ${語}`).toBe(0);
      expect(行列表(語, 全).length, `收錄の全體で行が出た: ${語}`).toBe(0);
    }
  });

  it("黙らず、その群の斷りを受ける", () => {
    for (const [語, 印] of 載せた語) {
      const 文 = 案内(語);
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `其の群の斷りで無い: ${語}`).toContain(印);
    }
  });

  it("読み上げは短く、斷りはそれより長い（声だけ惡くならん – 第 651 回）", () => {
    for (const [語] of 載せた語) {
      const 聲 = 讀み上げ(語);
      expect(聲, `讀み上げが無い: ${語}`).not.toBe("");
      expect([...聲].length, `讀み上げが六十を越える: ${語}`).toBeLessThanOrEqual(60);
      expect([...案内(語)].length, `斷りが讀み上げより短い: ${語}`).toBeGreaterThanOrEqual(
        [...聲].length,
      );
    }
  });

  it("同じ群の語の扱ひを変へて居ない", () => {
    /* 載せた語と同じ群に元からいる語（同じ斷りを受ける）。 */
    for (const [語, 印] of [
      ["出張届", "運営と手続きのこと"],
      ["治安", "持っていません"],
      ["旅費", "費用の欄はありません"],
      ["締切を過ぎた", "過去の締切も表示"],
      ["インボイス", "費用の欄はありません"],
    ] as Array<[string, string]>) {
      expect(件(語), `行が出た: ${語}`).toBe(0);
      expect(案内(語), `斷りが消えた: ${語}`).toContain(印);
    }
    /* 比べる打ち手には斷りを付けない（第 656・362 回の境界 – 第 712 回に白一覧で越えた物）。 */
    for (const 語 of ["参加費が高い", "費用が安い会議", "元データをもらう方法"]) {
      expect(案内(語), `比べる打ち手に斷りが乘つた: ${語}`).toBe("");
    }
    /* 行が出る語に斷りを付けない。 */
    for (const 語 of ["カメラレディ", "デモ", "ポスター"]) {
      expect(件(語), `前提が崩れた（0 行）: ${語}`).toBeGreaterThan(0);
      expect(案内(語), `行が出る語に斷りを付けた: ${語}`).toBe("");
    }
  });
});
