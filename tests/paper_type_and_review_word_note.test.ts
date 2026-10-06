/**
 * 論文の種類と査読の言い方を、新しい群と既存の群で受ける（第 689 回）。
 *
 * 實測（2026-10-06 – 収録の全体 5,069 行・速く開く品書 870 行・固定時刻 2026-10-06T00:00:00Z。
 * 検査が使ふ固定入力 – 品書 3,250 行・2026-08-09T00:00:00Z でも同じ）で、次の語は**0 行で
 * 案内も無し**だつた – `サーベイ論文` `レビュー論文` `招待論文` `研究論文` `学術論文` `総説`
 * `総説論文` `査読あり` `査読付き論文` `条件付き採択` `学会発表`。
 *
 * 直しかた – ①**論文の種類だけは新しい群**を置く。此の七語は**寄せでは直せない** – 寄せ先の
 * 候補（`survey` `invited` `review paper`）が何れも 0 行で、`long paper` は開催地 Long Beach と
 * `paper` の掛かりだつた（第 686 回に檢べが名前を出して彈いた）。種類の區別を持つ欄が無い事と、
 * 其れを書く場所（公式ページ）を敎へる。②殘りは既存の群へ（第 612・687・688 回と同じ判斷）–
 * `査読あり` `査読付き論文` は「審査の方式（盲検の形・査読者数）を書く欄がなく」と言ふ群
 * （`査読付き` `査読者` `ピアレビュー` が既に居る）、`条件付き採択` は採否の統計の群
 * （`採録` `不採択` `条件付き採録` が既に居る）、`学会発表` は募集の群（斷りが既に
 * 「國內の研究會は『発表申込締切』」と名指して居る – 第 685 回）。
 *
 * 突合（群の語 × 語尾の網羅 18,871 本）– **行 增 0・減 0**・**案内 新規 11・消失 0・
 * 文の變へり 0**・寄せ 新規 0。內譯は SPEC.md 第 689 回。
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

/** 論文の種類の語（新しい群）と、其の群の斷りに必ず出る語。 */
const 種類の語: Array<[string, string]> = [
  ["サーベイ論文", "論文の種類の名前で、この表は種類の区別を持ちません"],
  ["レビュー論文", "論文の種類の名前で、この表は種類の区別を持ちません"],
  ["招待論文", "論文の種類の名前で、この表は種類の区別を持ちません"],
  ["研究論文", "論文の種類の名前で、この表は種類の区別を持ちません"],
  ["学術論文", "論文の種類の名前で、この表は種類の区別を持ちません"],
  ["総説", "論文の種類の名前で、この表は種類の区別を持ちません"],
  ["総説論文", "論文の種類の名前で、この表は種類の区別を持ちません"],
];

/** 既存の群へ載せた語と、其の群の斷りに必ず出る語。 */
const 既存の群の語: Array<[string, string]> = [
  ["査読あり", "審査の方式（盲検の形・査読者数）"],
  ["査読付き論文", "審査の方式（盲検の形・査読者数）"],
  ["条件付き採択", "採否の結果が分かる日"],
  ["学会発表", "締切の種別の名前ではありません"],
];

describe("論文の種類を打つ人（第 689 回）", () => {
  it("品書と收錄の全體の兩方で 0 行（案内の出る打ち方である事を先に確かめる）", () => {
    const 全 = 全體();
    for (const [語] of [...種類の語, ...既存の群の語]) {
      expect(件(語), `品書で行が出た: ${語}`).toBe(0);
      expect(行列表(語, 全).length, `收錄の全體で行が出た: ${語}`).toBe(0);
    }
  });

  it("默らず、種類の區別を持たない事と公式ページを言う", () => {
    for (const [語, 印] of 種類の語) {
      const 文 = 案内(語);
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `其の群の斷りで無い: ${語}`).toContain(印);
      expect(文, `公式ページへ導いて居ん: ${語}`).toContain("公式ページ");
      /* 持たない欄を數へ上げて居る（何を探しても出ない事が分かる）。 */
      expect(文, `收錄する物を書いて居ん: ${語}`).toContain("締切の日と種別");
      expect(/[0-9０-９]/.test(文), `測つて居ない數: ${語}`).toBe(false);
    }
  });

  it("讀み上げは短く、斷りは其れより長い（聲だけ惡くならん – 第 651 回）", () => {
    for (const [語] of [...種類の語, ...既存の群の語]) {
      const 聲 = 讀み上げ(語);
      expect(聲, `讀み上げが無い: ${語}`).not.toBe("");
      expect([...聲].length, `讀み上げが六十を越える: ${語}`).toBeLessThanOrEqual(60);
      expect([...案内(語)].length, `斷りが讀み上げより短い: ${語}`).toBeGreaterThanOrEqual(
        [...聲].length,
      );
    }
  });

  it("寄せでは直せない事を確かめる（寄せ先が無い – 第 246 回）", () => {
    /* 此の群を寄せで直さなかつた理由。`survey` `invited` は 0 行。`review paper` は 1 行あるが
     * 中身は "call for book reviews" の掛かり、`review` の 40 行は「査読結果公開」の行で、
     * 何れも論文の種類では無い（第 686 回に `long paper` が Long Beach の掛かりだつたのと同じ形）。 */
    const 全 = 全體();
    for (const 先 of ["survey", "invited"]) {
      expect(行列表(先, 全).length, `寄せ先が出來た: ${先}`).toBe(0);
      expect(Recommender.querySynonymNotes(先).join(""), `寄せて居る: ${先}`).toBe("");
    }
    /* 見た目で寄せたら誤爆する對（此の群を寄せで直さなかつた證）。 */
    expect(行列表("review paper", 全).length, "`review paper` が増えた").toBeLessThan(3);
    expect(Recommender.querySynonymNotes("レビュー論文").join(""), "`レビュー論文` を寄せた").toBe(
      "",
    );
  });

  it("行が出る語の斷りは奪はない（第 337 回）", () => {
    const 全 = 全體();
    for (const 語 of ["論文締切", "発表申込締切", "採択通知"]) {
      expect(行列表(語, 全).length, `前提が崩れた（0 行）: ${語}`).toBeGreaterThan(0);
      expect(案内(語), `行が出る語に斷りを付けた: ${語}`).toBe("");
    }
    /* 別の群が既に受ける語（此の群が先取りせん – 一語一羣）。 */
    for (const 語 of ["招待講演", "口頭発表", "一般発表", "原著論文", "査読付き", "条件付き採録"]) {
      expect(件(語), `行が出た: ${語}`).toBe(0);
      expect(案内(語), `斷りが消えた: ${語}`).not.toBe("");
    }
    expect(案内("招待講演"), "`招待講演` を此の群が奪つた").not.toContain("論文の種類の名前");
  });
});

describe("査読と採否の言い方を既存の群で受ける（第 689 回）", () => {
  it("默らず、其の群の斷りを受ける", () => {
    for (const [語, 印] of 既存の群の語) {
      const 文 = 案内(語);
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `其の群の斷りで無い: ${語}`).toContain(印);
    }
    /* 學會發表の斷りは、其の方で通る種別の語を名指す（第 685 回の群）。 */
    expect(案内("学会発表"), "種別の語を名指して居ん").toContain("発表申込締切");
  });

  it("同じ群の語の扱ひを變へて居ない", () => {
    for (const 語 of ["査読者", "ピアレビュー", "採録", "不採択", "不採録", "募集", "応募"]) {
      expect(件(語), `行が出た: ${語}`).toBe(0);
      expect(案内(語), `斷りが消えた: ${語}`).not.toBe("");
    }
  });
});

describe("語列表その物の棚卸し（第 689 回）", () => {
  it("載せた語は、正本の群に一度ずつ載つて居る（一語一羣 – 第 512 回）", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 始 = 物.indexOf("const UI_WORD_GROUPS_JA = [");
    expect(始, "群の一覧が見つからない").toBeGreaterThan(0);
    const 後 = 物.slice(始);
    const 終 = 後.match(/\n\s*\];/);
    const 本 = 後.slice(0, 終 ? 終.index : 後.length);
    for (const [語] of [...種類の語, ...既存の群の語]) {
      const 數 = 本.split(`"${語}"`).length - 1;
      expect(數, `群の語列表に ${數} 回（一度だけ載せる）: ${語}`).toBe(1);
    }
    expect(本, "論文の種類の群の斷りが無い").toContain("は論文の種類の名前で");
  });
});
