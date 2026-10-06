/**
 * 論文の中身の言葉を、新しい群で受ける（第 696 回）。
 *
 * 實測（2026-10-06 – 収録の全体 5,069 行・速く開く品書 870 行・固定時刻 2026-10-06T00:00:00Z。
 * 検査が使ふ固定入力 – 品書 3,250 行・2026-08-09T00:00:00Z でも同じ）で、次の語は**0 行で
 * 案内も無し**だつた – `関連研究` `先行研究` `手法` `提案手法` `実験` `データセット` `結論`
 * `序論` `本論` `まとめ` `展望` `サーベイ` `考察` `貢献` `研究背景` `動機` `アプローチ` `実装`
 * `分析`。
 *
 * 此の表が並べて居るのは締切と催し物の屬性だけなので、論文の中身の言葉では引けない – そこで
 * **其の代はりの道**（題名や要旨から投稿先を出す畫面）を名指す。同じ事を言ふ群が既に在る
 *（第 383・385 回の「投稿先」の群 – 斷りが「自分の論文を貼って投稿先の候補を出す機能は
 * この畫面に在ります」と言つて居る）ので、其の隣に置いた。
 *
 * 行が出るので載せなかつた語 – `評価`（4,596 行）・`検証`（17 行）・`ベンチマーク`（1 行）。
 * 第 337 回の門（行が出る語に斷りを付けない）。
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

/** 群へ載せた語（論文の中身の言葉）。 */
const 載せた語 = [
  "関連研究",
  "先行研究",
  "手法",
  "提案手法",
  "実験",
  "データセット",
  "結論",
  "序論",
  "本論",
  "まとめ",
  "展望",
  "サーベイ",
  "考察",
  "貢献",
  "研究背景",
  "動機",
  "アプローチ",
  "実装",
  "分析",
  /* 最後に残っていた一つ（第 710 回 – 自然語の見本 239 語を総当たりして、この語だけが
   * 行き止まりだった）。「課題と展望」のように論文の節の名としても使う語。 */
  "課題",
  /* 英語で打つ人（第 711 回 – 実測 2026-10-06: 此の十三語は 0 行・案内も無しだった。
   * 同じ語の片仮名の形は此の群が既に受けるので、英語の綴りも揃へる）。 */
  "survey",
  "dataset",
  "conclusion",
  "introduction",
  "related work",
  "prior work",
  "future work",
  "background",
  "motivation",
  "figure",
  "table",
  "reference",
  "citation",
];

describe("論文の中身の言葉（第 696 回）", () => {
  it("品書と收錄の全體の兩方で 0 行（案内の出る打ち方である事を先に確かめる）", () => {
    const 全 = 全體();
    for (const 語 of 載せた語) {
      expect(件(語), `品書で行が出た: ${語}`).toBe(0);
      expect(行列表(語, 全).length, `收錄の全體で行が出た: ${語}`).toBe(0);
    }
  });

  it("默らず、中身の言葉である事と代はりの道を言う", () => {
    for (const 語 of 載せた語) {
      const 文 = 案内(語);
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `其の群の斷りで無い: ${語}`).toContain("は論文の中身の言葉で");
      /* 代はりの道（題名や要旨から投稿先を出す畫面）を名指す。 */
      expect(文, `代はりの道を名指して居ん: ${語}`).toContain("『投稿先を探す』");
      /* 此の表が持つ物を數へ上げる（何を打てば引けるかが分かる）。 */
      expect(文, `收錄する物を書いて居ん: ${語}`).toContain("催し物の名前・締切の日");
      /* 測つて居ない數を書かない（第 535 回）。 */
      expect(/[0-9０-９]/.test(文), `數を發して居る: ${語}`).toBe(false);
    }
  });

  it("讀み上げは短く、斷りは其れより長い（聲だけ惡くならん – 第 651 回）", () => {
    for (const 語 of 載せた語) {
      const 聲 = 讀み上げ(語);
      expect(聲, `讀み上げが無い: ${語}`).not.toBe("");
      expect([...聲].length, `讀み上げが六十を越える: ${語}`).toBeLessThanOrEqual(60);
      expect([...案内(語)].length, `斷りが讀み上げより短い: ${語}`).toBeGreaterThanOrEqual(
        [...聲].length,
      );
      expect(聲, `代はりの道を名指して居ん: ${語}`).toContain("投稿先を探す");
    }
  });

  it("行が出る語は載せない（第 337 回）", () => {
    const 全 = 全體();
    for (const 語 of ["評価", "検証", "ベンチマーク"]) {
      expect(行列表(語, 全).length, `前提が崩れた（0 行）: ${語}`).toBeGreaterThan(0);
      expect(案内(語), `行が出る語に斷りを付けた: ${語}`).toBe("");
    }
  });

  it("同じ事を言ふ隣の群の扱ひを變へて居ない", () => {
    for (const 語 of ["投稿先", "提出方法", "投稿システム"]) {
      expect(件(語), `行が出た: ${語}`).toBe(0);
      expect(案内(語), `斷りが消えた: ${語}`).not.toBe("");
      expect(案内(語), "代はりの道が消えた").toContain("『投稿先を探す』");
    }
    /* 一語一羣 – 此の群の語が他の群にも載つて居ない事を成果物で見る（第 512 回）。 */
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 始 = 物.indexOf("const UI_WORD_GROUPS_JA = [");
    const 後 = 物.slice(始);
    const 終 = 後.match(/\n\s*\];/);
    const 本 = 後.slice(0, 終 ? 終.index : 後.length);
    for (const 語 of 載せた語) {
      const 數 = 本.split(`"${語}"`).length - 1;
      expect(數, `群の語列表に ${數} 回（一度だけ載せる）: ${語}`).toBe(1);
    }
    expect(本, "中身の言葉の群の斷りが無い").toContain("は論文の中身の言葉で");
  });
});
