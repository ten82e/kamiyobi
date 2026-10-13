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
  ["ビザサポート", "この表が持っていません"],
  ["招待状発行", "この表が持っていません"],
  ["ホテル予約", "往き方・泊まる所"],
  ["相部屋", "往き方・泊まる所"],
  ["一人部屋", "往き方・泊まる所"],
  ["学生会員", "費用の欄はありません"],
  ["正会員", "費用の欄はありません"],
  ["賛助会員", "費用の欄はありません"],
  ["交通費支給", "費用の欄はありません"],
  ["宿泊補助", "費用の欄はありません"],
  ["現金", "費用の欄はありません"],
  ["海外旅行保険", "運営と手続きのこと"],
  ["ポスター賞", "運営と手続きのこと"],
  ["優秀発表賞", "運営と手続きのこと"],
  ["研究賞", "運営と手続きのこと"],
  ["功績賞", "運営と手続きのこと"],
  ["研究奨励賞", "運営と手続きのこと"],
  ["若手研究者賞", "運営と手続きのこと"],
  ["国際会議賞", "運営と手続きのこと"],
  ["ベストポスター", "運営と手続きのこと"],
  ["オーディエンス賞", "運営と手続きのこと"],
];

describe("渡航・宿泊・費用と、会員・賞の語（第 690 回）", () => {
  it("品書と収録の全体の両方で 0 行（案内の出る打ち方である事を先に確かめる）", () => {
    const 全 = 全體();
    for (const [語] of 載せた語) {
      expect(件(語), `品書で行が出た: ${語}`).toBe(0);
      expect(行列表(語, 全).length, `收錄の全體で行が出た: ${語}`).toBe(0);
    }
  });

  it("黙らず、その群の斷りと公式ページへの道を言う", () => {
    for (const [語, 印] of 載せた語) {
      const 文 = 案内(語);
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `其の群の斷りで無い: ${語}`).toContain(印);
      expect(文, `公式ページへ導いて居ん: ${語}`).toContain("公式ページ");
      /* 測つて居ない数を書かない。 */
      expect(/[0-9０-９]/.test(文), `數を發して居る: ${語}`).toBe(false);
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
    for (const 語 of [
      "ビザ",
      "招へい状",
      "招聘状発行",
      "宿",
      "民宿",
      "旅館",
      "宿泊先",
      "旅費補助",
      "渡航費補助",
      "滞在費",
      "クレジットカード",
      "支払期限",
      "振込先",
      "保険",
      "学会賞",
      "学生優秀賞",
      "論文賞",
      "受賞者",
    ]) {
      expect(件(語), `行が出た: ${語}`).toBe(0);
      expect(案内(語), `斷りが消えた: ${語}`).not.toBe("");
    }
    /* 行が出る語には斷りを付けない。 */
    for (const 語 of ["会期", "ポスター", "論文締切"]) {
      expect(件(語), `前提が崩れた（0 行）: ${語}`).toBeGreaterThan(0);
      expect(案内(語), `行が出る語に斷りを付けた: ${語}`).toBe("");
    }
  });

  it("一語一羣の棚卸し（第 512 回）", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 始 = 物.indexOf("const UI_WORD_GROUPS_JA = [");
    expect(始, "群の一覧が見つからない").toBeGreaterThan(0);
    const 後 = 物.slice(始);
    const 終 = 後.match(/\n\s*\];/);
    const 本 = 後.slice(0, 終 ? 終.index : 後.length);
    for (const [語] of 載せた語) {
      const 數 = 本.split(`"${語}"`).length - 1;
      expect(數, `群の語列表に ${數} 回（一度だけ載せる）: ${語}`).toBe(1);
    }
  });
});
