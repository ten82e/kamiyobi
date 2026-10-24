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

/** 学位と課程の手續きの語（新しい群）。 */
const 學位の語 = [
  "卒論",
  "修論",
  "博論",
  "卒業論文",
  "博士論文",
  "学位",
  "学位論文",
  "博士学位",
  "学位審査",
  "論文審査",
  "課程",
  "ドクター",
  "ドクターコース",
  "ドクトラル",
  "口頭試問",
  "公聴会",
];

/** 既存の群へ載せた語と、その群の斷りに必ず出る語。 */
const 既存の群の語: Array<[string, string]> = [
  ["前回", "過去の締切も表示"],
  ["ポスターPDF", "論文の種類の名前で"],
  ["開催予定", "行の『会期』に出ています"],
];

describe("学位と課程の手續き（第 698 回）", () => {
  it("品書と収録の全体の両方で 0 行（案内の出る打ち方である事を先に確かめる）", () => {
    const 全 = 全體();
    for (const 語 of [...學位の語, ...既存の群の語.map(([語]) => 語)]) {
      expect(件(語), `品書で行が出た: ${語}`).toBe(0);
      expect(行列表(語, 全).length, `收錄の全體で行が出た: ${語}`).toBe(0);
    }
  });

  it("黙らず、代はりの道（博士課程の学生向けの枠）を名指す", () => {
    for (const 語 of 學位の語) {
      const 文 = 案内(語);
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `其の群の斷りで無い: ${語}`).toContain("学位や課程の手続き");
      /* 何處へ聞けば良いかを言う（この表には無い物の行き先）。 */
      expect(文, `行き先を書いて居ん: ${語}`).toContain("教務");
      /* 代はりの道 – 博士課程の学生向けの枠と、その行に出る原文の英字。 */
      expect(文, `代はりの道を名指して居ん: ${語}`).toContain("doctoral");
      /* 測つて居ない数を書かない。 */
      expect(/[0-9０-９]/.test(文), `數を發して居る: ${語}`).toBe(false);
    }
  });

  it("名指した英字は、収録の全体で行を持つ", () => {
    expect(行列表("doctoral", 全體()).length, "収録の全体で 0 行").toBeGreaterThan(0);
  });

  it("読み上げは短く、斷りはそれより長い（声だけ惡くならん – 第 651 回）", () => {
    for (const 語 of [...學位の語, ...既存の群の語.map(([語]) => 語)]) {
      const 聲 = 讀み上げ(語);
      expect(聲, `讀み上げが無い: ${語}`).not.toBe("");
      expect([...聲].length, `讀み上げが六十を越える: ${語}`).toBeLessThanOrEqual(60);
      expect([...案内(語)].length, `斷りが讀み上げより短い: ${語}`).toBeGreaterThanOrEqual(
        [...聲].length,
      );
    }
  });

  it("黙らず、その群の斷りを受ける（既存の群へ載せた三語）", () => {
    for (const [語, 印] of 既存の群の語) {
      const 文 = 案内(語);
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `其の群の斷りで無い: ${語}`).toContain(印);
    }
  });

  it("同じ群の語の扱ひを変へて居ない（一語一羣 – 第 512 回）", () => {
    /* 上の対象とレベルの群が受ける語はこちらへ載せて居ない（載せると応答が割れる）。 */
    for (const 語 of ["修士論文", "博士課程", "修士号"]) {
      expect(件(語), `行が出た: ${語}`).toBe(0);
      const 文 = 案内(語);
      expect(文, `斷りが消えた: ${語}`).not.toBe("");
      expect(文, `此方の群が奪つた: ${語}`).not.toContain("学位や課程の手続き");
    }
    for (const 語 of ["過去", "去年", "ポスター論文", "初日"]) {
      expect(件(語), `行が出た: ${語}`).toBe(0);
      expect(案内(語), `斷りが消えた: ${語}`).not.toBe("");
    }
    /* 行が出る語には斷りを付けない。 */
    for (const 語 of ["会期", "ポスター", "論文締切"]) {
      expect(件(語), `前提が崩れた（0 行）: ${語}`).toBeGreaterThan(0);
      expect(案内(語), `行が出る語に斷りを付けた: ${語}`).toBe("");
    }
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 始 = 物.indexOf("const UI_WORD_GROUPS_JA = [");
    const 後 = 物.slice(始);
    const 終 = 後.match(/\n\s*\];/);
    const 本 = 後.slice(0, 終 ? 終.index : 後.length);
    for (const 語 of [...學位の語, ...既存の群の語.map(([語]) => 語)]) {
      const 數 = 本.split(`"${語}"`).length - 1;
      expect(數, `群の語列表に ${數} 回（一度だけ載せる）: ${語}`).toBe(1);
    }
    expect(本, "学位の群の斷りがない").toContain(
      "はこの表が持っていません。この表が並べているのは会議",
    );
  });
});
