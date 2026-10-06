/**
 * 間に合ふか・初めてか・開かれる日が近いかを聞く人を受ける（第 712 回）。
 *
 * 實測（2026-10-06 – 收錄の全體 5,069 行・速く開く品書 870 行・固定時刻 2026-10-06T00:00:00Z。
 * 検査が使ふ固定入力 – 品書 3,250 行・2026-08-09T00:00:00Z でも同じ）で、自然な文の見本 106 文の
 * うち、次の語は**0 行で案内も無し**だつた – `今からでも間に合う` `今から間に合う` `まだ大丈夫`
 * `今からでも大丈夫` `初めての投稿` `初投稿` `学会デビュー` `発表が初めて` `チュートリアルの依頼`
 * `ワークショップの提案` `企画セッションの提案` `発表の練習` `開催が近い` `開催が近い会議`
 * `会期が近い` `開催間近`。
 *
 * 直し – ①間に合ふかの四語は「まだ間に合う」「間に合いますか」が既に居る群へ、②初めての四語は
 * `初心者` が居る對象とレベルの群へ、③依頼・提案の三語は運営の群へ、④`発表の練習` は
 * `発表練習` が居る會場の設備の群へ、⑤開かれる日の近さの四語は**新しい群**（此の表の既定の並びは
 * **締切**の近い順なので、開かれる日の順に見る道を敎へる）。
 *
 * 突合（群の語 × 語尾の網羅 20,574 本）– **行 增 0・減 0**・**案内 新規 16・消失 0・
 * 文の變へり 0**。內譯は SPEC.md 第 712 回。
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

/** 載せた語と、其の群の斷りに必ず出る語。 */
const 載せた語: Array<[string, string]> = [
  ["今からでも間に合う", "いまの一覧は過ぎた締切を除いて並べています"],
  ["今から間に合う", "いまの一覧は過ぎた締切を除いて並べています"],
  ["まだ大丈夫", "いまの一覧は過ぎた締切を除いて並べています"],
  ["今からでも大丈夫", "いまの一覧は過ぎた締切を除いて並べています"],
  ["初めての投稿", "募集対象や旅費の支援の有無"],
  ["初投稿", "募集対象や旅費の支援の有無"],
  ["学会デビュー", "募集対象や旅費の支援の有無"],
  ["発表が初めて", "募集対象や旅費の支援の有無"],
  ["チュートリアルの依頼", "運営と手続きのこと"],
  ["ワークショップの提案", "運営と手続きのこと"],
  ["企画セッションの提案", "運営と手続きのこと"],
  ["発表の練習", "往き方・泊まる所"],
  ["開催が近い", "列『会期』の見出しを押して"],
  ["開催が近い会議", "列『会期』の見出しを押して"],
  ["会期が近い", "列『会期』の見出しを押して"],
  ["開催間近", "列『会期』の見出しを押して"],
];

describe("間に合ふか・初めてかを聞く人（第 712 回）", () => {
  it("品書と收錄の全體の兩方で 0 行（案内の出る打ち方である事を先に確かめる）", () => {
    const 全 = 全體();
    for (const [語] of 載せた語) {
      expect(件(語), `品書で行が出た: ${語}`).toBe(0);
      expect(行列表(語, 全).length, `收錄の全體で行が出た: ${語}`).toBe(0);
    }
  });

  it("默らず、其の群の斷りを受ける", () => {
    for (const [語, 印] of 載せた語) {
      const 文 = 案内(語);
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `其の群の斷りで無い: ${語}`).toContain(印);
    }
  });

  it("讀み上げは短く、斷りは其れより長い（聲だけ惡くならん – 第 651 回）", () => {
    for (const [語] of 載せた語) {
      const 聲 = 讀み上げ(語);
      expect(聲, `讀み上げが無い: ${語}`).not.toBe("");
      expect([...聲].length, `讀み上げが六十を越える: ${語}`).toBeLessThanOrEqual(60);
      expect([...案内(語)].length, `斷りが讀み上げより短い: ${語}`).toBeGreaterThanOrEqual(
        [...聲].length,
      );
    }
  });

  it("同じ群の語の扱ひを變へて居ない", () => {
    for (const 語 of ["まだ間に合う", "間に合いますか", "初心者", "特殊セッション", "発表練習"]) {
      expect(件(語), `行が出た: ${語}`).toBe(0);
      expect(案内(語), `斷りが消えた: ${語}`).not.toBe("");
    }
    for (const 語 of ["会期", "ポスター", "論文締切"]) {
      expect(件(語), `前提が崩れた（0 行）: ${語}`).toBeGreaterThan(0);
      expect(案内(語), `行が出る語に斷りを付けた: ${語}`).toBe("");
    }
  });
});

describe("開かれる日の近さを聞く人（第 712 回）", () => {
  it("列『會期』の見出しを押す道と、未確認の行の置き方を言ふ", () => {
    const 文 = 案内("開催が近い");
    expect(文, "並べ替えの道を言つて居ん").toContain("列『会期』の見出しを押して");
    expect(文, "既定の並びを言つて居ん").toContain("既定の並びは締切の近い順");
    expect(文, "未確認の行の置き方を言つて居ん").toContain("末尾に置きます");
    expect(讀み上げ("開催が近い"), "讀み上げが道を言つて居ん").toContain("会期");
  });

  it("名指した並べ替えは、てびきが同じ事を書いて居る（畫面と文書で同じ約束）", () => {
    /* 案内が名指す先（列『会期』を押す・未確認は末尾）を、てびきの「並び順」の項が
     * 同じ語で書いて居るかを見る（別々に書くと片方だけ古くなる – 第 276 回と同じ決まり）。*/
    const html = readFileSync(join(builtSite(), "index.html"), "utf8");
    const i = html.indexOf("<dt>並び順</dt>");
    expect(i, "てびきに並び順の項が無い").toBeGreaterThan(-1);
    const 項 = html.slice(i, html.indexOf("</dd>", i)).replace(/<[^>]+>/g, "");
    expect(項, "てびきが會期の順を書いて居ない").toContain("会期の順は出張の計画に向きます");
    expect(項, "てびきが未確認の行の置き方を書いて居ない").toContain("末尾に置きます");
  });
});
