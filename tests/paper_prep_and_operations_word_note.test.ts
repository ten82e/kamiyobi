/**
 * 原稿を書く道具・手續きと、當日の運營の語を、既存の群で受ける（第 687 回）。
 *
 * 實測（2026-10-06 – 収録の全体 5,069 行・速く開く品書 870 行・固定時刻 2026-10-06T00:00:00Z。
 * 検査が使ふ固定入力 – 品書 3,250 行・2026-08-09T00:00:00Z でも同じ）で、次の語は**0 行で
 * 案内も無し**だつた – `LaTeX` `Overleaf` `参考文献` `文字数` `前刷り` `別刷り` `倫理`
 * `倫理審査` `剽窃` `被験者` `学生賞` `飛び入り` `見学` `都市`。
 *
 * 直しかた – 新しい群は作らない。同じ事を答へる群が既に在るので、其の語列表に載せるだけに
 * した（第 612 回と同じ判斷） –
 * ① `LaTeX` `Overleaf` `参考文献` `文字数` `前刷り` `別刷り` `倫理` `倫理審査` `剽窃`
 *    `被験者` は「原稿の書式・頁数・投稿の手続きは各催し物の公式ページ」と言ふ群
 *    （`書式` `ページ数` `研究倫理` `IRB` が既に居る）。
 * ② `学生賞` `飛び入り` `見学` は「運営と手続きのこと（…當日の進行と參加者の名簿）は各催し物の
 *    公式ページ」と言ふ群（`学会賞` `学生優秀賞` `当日参加` `途中参加` が既に居る）。
 * ③ `都市` は欄の名前の表（`会場` `場所` `都道府県` と同じ扱ひ – `どの都市` は第 653 回から
 *    此の欄を指して居る）。
 *
 * 突合（群の語 × 語尾の網羅 18,579 本）– **行 增 0・減 0**・**案内 新規 13・消失 0・
 * 文の變へり 0**・寄せ 新規 0。內譯は SPEC.md 第 687 回。
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
const 欄の案内 = (語: string): string =>
  String(Recommender.columnQueryNoteJa(語, (値) => 件(値) > 0) || "");

/** 載せた語と、其の群の斷りに必ず出る語。 */
const 載せた語: Array<[string, string]> = [
  ["LaTeX", "原稿の書式・頁数・投稿の手続き"],
  ["Overleaf", "原稿の書式・頁数・投稿の手続き"],
  ["参考文献", "原稿の書式・頁数・投稿の手続き"],
  ["文字数", "原稿の書式・頁数・投稿の手続き"],
  ["前刷り", "原稿の書式・頁数・投稿の手続き"],
  ["別刷り", "原稿の書式・頁数・投稿の手続き"],
  ["倫理", "原稿の書式・頁数・投稿の手続き"],
  ["倫理審査", "原稿の書式・頁数・投稿の手続き"],
  ["剽窃", "原稿の書式・頁数・投稿の手続き"],
  ["被験者", "原稿の書式・頁数・投稿の手続き"],
  ["学生賞", "運営と手続きのこと"],
  ["飛び入り", "運営と手続きのこと"],
  ["見学", "運営と手続きのこと"],
];

describe("原稿を書く道具・手續きの語（第 687 回）", () => {
  it("品書と收錄の全體の兩方で 0 行（案内の出る打ち方である事を先に確かめる）", () => {
    const 全 = 全體();
    for (const [語] of 載せた語) {
      expect(件(語), `品書で行が出た: ${語}`).toBe(0);
      expect(行列表(語, 全).length, `收錄の全體で行が出た: ${語}`).toBe(0);
    }
    expect(件("都市"), "品書で行が出た: 都市").toBe(0);
  });

  it("默らず、其の群の斷りを受ける", () => {
    for (const [語, 印] of 載せた語) {
      const 文 = 案内(語);
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `其の群の斷りで無い: ${語}`).toContain(印);
      expect(文, `公式ページへ導いて居ん: ${語}`).toContain("公式ページ");
      /* 測つて居ない數を書かない（第 535 回）。 */
      expect(/[0-9０-９]/.test(文), `數を發して居る: ${語}`).toBe(false);
    }
  });

  it("同じ事を答へる群の語の扱ひを變へて居ない", () => {
    for (const 語 of ["書式", "ページ数", "研究倫理", "IRB", "学会賞", "学生優秀賞", "当日参加"]) {
      expect(件(語), `行が出た: ${語}`).toBe(0);
      expect(案内(語), `斷りが消えた: ${語}`).not.toBe("");
    }
    /* 行が出る語には斷りを付けない（第 337 回）。 */
    for (const 語 of ["会期", "国内", "ポスター"]) {
      expect(件(語), `前提が崩れた（0 行）: ${語}`).toBeGreaterThan(0);
      expect(案内(語), `行が出る語に斷りを付けた: ${語}`).toBe("");
    }
  });

  it("`都市` は欄『開催地』の名前として案内を出す", () => {
    const 文 = 欄の案内("都市");
    expect(文, "默つた").toContain("欄（開催地）");
    expect(文, "値で打つ道を書いて居ん").toContain("值で打ってください");
    for (const 例 of ["国内", "米国"]) {
      expect(文, `例が文に無い: ${例}`).toContain(例);
      expect(件(例), `例が 0 行: ${例}`).toBeGreaterThan(0);
    }
    /* 同じ欄を指す先の語（`会場` `どの都市`）も其の侭。 */
    for (const 語 of ["会場", "どの都市", "都道府県"]) {
      expect(欄の案内(語), `欄の斷りが消えた: ${語}`).toContain("欄（開催地）");
    }
  });
});

describe("語列表その物の棚卸し（第 687 回）", () => {
  it("載せた語は、正本の群に一度ずつ載つて居る（一語一羣 – 第 512 回）", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 始 = 物.indexOf("const UI_WORD_GROUPS_JA = [");
    expect(始, "群の一覧が見つからない").toBeGreaterThan(0);
    const 後 = 物.slice(始);
    const 終 = 後.match(/\n\s*\];/);
    const 本 = 後.slice(0, 終 ? 終.index : 後.length);
    for (const [語] of 載せた語) {
      const 數 = 本.split(`"${語}",`).length - 1;
      expect(數, `群の語列表に ${數} 回（一度だけ載せる）: ${語}`).toBe(1);
    }
    /* 欄の名前の表にも一條（`都市` → 開催地）。 */
    expect(物, "`都市` の欄の名前が無い").toContain('["都市", "開催地"]');
  });
});
