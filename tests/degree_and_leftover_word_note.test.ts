/**
 * 學位と課程の手續きを新しい群で受け、殘りの三語を既存の群へ載せる（第 698 回）。
 *
 * 實測（2026-10-06 – 収録の全体 5,069 行・速く開く品書 870 行・固定時刻 2026-10-06T00:00:00Z。
 * 検査が使ふ固定入力 – 品書 3,250 行・2026-08-09T00:00:00Z でも同じ）で、次の語は**0 行で
 * 案内も無し**だつた – `卒論` `修論` `博論` `卒業論文` `博士論文` `学位` `博士学位` `学位審査`
 * `論文審査` `課程` `ドクター` `ドクターコース` `ドクトラル` `口頭試問` `公聴会` `前回`
 * `ポスターPDF` `開催予定`。
 *
 * 直し①**學位と課程の手續きだけは新しい群** – 此の表が並べるのは會議と雜誌の締切なので、
 * 學位の手續きは此處に無い。但し**博士課程の學生向けの枠を持つ會議が在る**ので、其の行に出る
 * 原文の英字（`doctoral` – 收錄の全體で 4 行、品書でも 4 行）を名指す（打ち直しの道を渡す）。
 * `修士論文` `博士課程` `修士号` `学位論文` は上の對象とレベルの群が「修士」「博士學生」の一致で
 * 既に受けるので、此の群へは載せない（一語一羣 – 第 512 回）。
 * 直し②殘りの三語は既存の群へ – `前回` は「過ぎた締切は…『過去の締切も表示』をオンに」と言ふ群、
 * `ポスターPDF` は論文の種類の群、`開催予定` は「行の『會期』に出ています」と言ふ群。
 *
 * 突合（群の語 × 語尾の網羅 19,880 本）– **行 增 0・減 0**・**案内 新規 18・消失 0・
 * 文の變へり 0**・寄せ 新規 0。內譯は SPEC.md 第 698 回。
 */

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

/** 學位と課程の手續きの語（新しい群）。 */
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

/** 既存の群へ載せた語と、其の群の斷りに必ず出る語。 */
const 既存の群の語: Array<[string, string]> = [
  ["前回", "過去の締切も表示"],
  ["ポスターPDF", "論文の種類の名前で"],
  ["開催予定", "行の『会期』に出ています"],
];

describe("學位と課程の手續き（第 698 回）", () => {
  it("品書と收錄の全體の兩方で 0 行（案内の出る打ち方である事を先に確かめる）", () => {
    const 全 = 全體();
    for (const 語 of [...學位の語, ...既存の群の語.map(([語]) => 語)]) {
      expect(件(語), `品書で行が出た: ${語}`).toBe(0);
      expect(行列表(語, 全).length, `收錄の全體で行が出た: ${語}`).toBe(0);
    }
  });

  it("默らず、代はりの道（博士課程の學生向けの枠）を名指す", () => {
    for (const 語 of 學位の語) {
      const 文 = 案内(語);
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `其の群の斷りで無い: ${語}`).toContain("学位や課程の手続き");
      /* 何處へ聞けば良いかを言ふ（此の表には無い物の行き先）。 */
      expect(文, `行き先を書いて居ん: ${語}`).toContain("教務");
      /* 代はりの道 – 博士課程の學生向けの枠と、其の行に出る原文の英字。 */
      expect(文, `代はりの道を名指して居ん: ${語}`).toContain("doctoral");
      /* 測つて居ない數を書かない（第 535 回）。 */
      expect(/[0-9０-９]/.test(文), `數を發して居る: ${語}`).toBe(false);
    }
  });

  it("名指した英字は、收錄の全體で行を持つ", () => {
    /* 案内が名指す語が 0 行だと、渡した道が行き止まりになる（第 246 回の門と同じ考へ）。
     * 見るのは**收錄の全體**（實データの 5,069 行）– 檢査が使ふ固定入力（3,250 行）は
     * 凍つた見本で、此の語を持つ行が入つて居ない（實ビルドの畫面では 1 行出る事を
     * HeadlessChrome で確かめた – 第 698 回）。 */
    expect(行列表("doctoral", 全體()).length, "收錄の全體で 0 行").toBeGreaterThan(0);
  });

  it("讀み上げは短く、斷りは其れより長い（聲だけ惡くならん – 第 651 回）", () => {
    for (const 語 of [...學位の語, ...既存の群の語.map(([語]) => 語)]) {
      const 聲 = 讀み上げ(語);
      expect(聲, `讀み上げが無い: ${語}`).not.toBe("");
      expect([...聲].length, `讀み上げが六十を越える: ${語}`).toBeLessThanOrEqual(60);
      expect([...案内(語)].length, `斷りが讀み上げより短い: ${語}`).toBeGreaterThanOrEqual(
        [...聲].length,
      );
    }
  });

  it("默らず、其の群の斷りを受ける（既存の群へ載せた三語）", () => {
    for (const [語, 印] of 既存の群の語) {
      const 文 = 案内(語);
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `其の群の斷りで無い: ${語}`).toContain(印);
    }
  });

  it("同じ群の語の扱ひを變へて居ない（一語一羣 – 第 512 回）", () => {
    /* 上の對象とレベルの群が受ける語は此方へ載せて居ない（載せると應答が割れる）。 */
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
    /* 行が出る語には斷りを付けない（第 337 回）。 */
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
    expect(本, "學位の群の斷りが無い").toContain(
      "はこの表が持っていません。この表が並べているのは会議",
    );
  });
});
