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

describe("間に合うか・初めてかを聞く人（第 712 回）", () => {
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
  it("列『会期』の見出しを押す道と、未確認の行の置き方を言う", () => {
    const 文 = 案内("開催が近い");
    expect(文, "並べ替えの道を言つていない").toContain("列『会期』の見出しを押して");
    expect(文, "既定の並びを言つていない").toContain("既定の並びは締切の近い順");
    expect(文, "未確認の行の置き方を言つていない").toContain("末尾に置きます");
    expect(讀み上げ("開催が近い"), "読み上げが道を言つていない").toContain("会期");
  });

  it("名指した並べ替えは、てびきが同じ事を書いている（画面と文書で同じ約束）", () => {
    /* 案内が名指す先（列『会期』を押す・未確認は末尾）を、てびきの「並び順」の項が
     * 同じ語で書いているかを見る（別々に書くと片方だけ古くなる – 第 276 回と同じ決まり）。*/
    const html = readFileSync(join(builtSite(), "index.html"), "utf8");
    const i = html.indexOf("<dt>並び順</dt>");
    expect(i, "てびきに並び順の項がない").toBeGreaterThan(-1);
    const 項 = html.slice(i, html.indexOf("</dd>", i)).replace(/<[^>]+>/g, "");
    expect(項, "てびきが会期の順を書いて居ない").toContain("会期の順は出張の計画に向きます");
    expect(項, "てびきが未確認の行の置き方を書いて居ない").toContain("末尾に置きます");
  });
});
