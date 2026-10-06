/**
 * 論文や発表の**作り方**を聞く人を受ける（第 713 回）。
 *
 * 実測（2026-10-06 – 収録の全体 5,069 行・速く開く品書 870 行・固定時刻 2026-10-06T00:00:00Z。
 * 検査が使う固定入力 – 品書 3,250 行・2026-08-09T00:00:00Z でも同じ）で、次の 16 語は
 * **0 行で案内も無し**だった – `英文校正` `ネイティブチェック` `図の作り方` `表の作り方`
 * `コードの公開` `実験の再現` `新規性の主張` `貢献の書き方` `反論の書き方` `想定質問`
 * `論文の書き方` `発表の準備` `ポスターの作り方` `論文の推敲` `添削` `執筆`。
 *
 * この表は締切と催し物の欄しか持たないので、書き方の案内の在り処（投稿規定・発表の案内・
 * 所属の研究室・大学の支援）を教える新しい群を足した。
 *
 * 突合（群の語 × 語尾の網羅 20,750 本）– **行 増 0・減 0**・**案内 新規 12・消失 0・
 * 文の変わり 0**。内訳は SPEC.md 第 713 回。
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

const 書き方の語 = [
  "英文校正",
  "ネイティブチェック",
  "図の作り方",
  "表の作り方",
  "コードの公開",
  "実験の再現",
  "新規性の主張",
  "貢献の書き方",
  "反論の書き方",
  "想定質問",
  "論文の書き方",
  "発表の準備",
  "ポスターの作り方",
  "論文の推敲",
  "添削",
  "執筆",
];

describe("論文や発表の作り方を聞く人（第 713 回）", () => {
  it("品書と収録の全體の両方で 0 行（案内の出る打ち方である事を先に確かめる）", () => {
    const 全 = 全體();
    for (const 語 of 書き方の語) {
      expect(件(語), `品書で行が出た: ${語}`).toBe(0);
      expect(行列表(語, 全).length, `収録の全体で行が出た: ${語}`).toBe(0);
    }
  });

  it("黙らず、書き方の案内の在り処を教える", () => {
    for (const 語 of 書き方の語) {
      const 文 = 案内(語);
      expect(文, `黙った: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      /* この表が持たない物を、絞り込める物のように言わない。 */
      expect(文, `絞り込める物のように言っている: ${語}`).not.toContain("絞り込めません");
      /* 在り処を二通り言う（投稿規定と所属の支援 – 読む人のいる場所）。 */
      expect(文, `投稿規定へ導いていない: ${語}`).toContain("投稿規定");
      expect(文, `所属の支援へ導いていない: ${語}`).toContain("所属");
    }
  });

  it("読み上げは短く、断りはそれより長い（声だけ悪くならん – 第 651 回）", () => {
    for (const 語 of 書き方の語) {
      const 聲 = 讀み上げ(語);
      expect(聲, `読み上げが無い: ${語}`).not.toBe("");
      expect([...聲].length, `読み上げが六十を越える: ${語}`).toBeLessThanOrEqual(60);
      expect([...案内(語)].length, `断りが読み上げより短い: ${語}`).toBeGreaterThanOrEqual(
        [...聲].length,
      );
    }
  });

  it("書き方の話と、催し物の言葉の群を混ぜない", () => {
    /* 既存の群の語はそのままの扱い（この群へ回り込まない）。 */
    for (const [語, 印] of [
      ["発表練習", "会場"],
      ["特殊セッション", "運営と手続きのこと"],
      ["開催が近い", "列『会期』の見出しを押して"],
    ] as Array<[string, string]>) {
      expect(件(語), `行が出た: ${語}`).toBe(0);
      expect(案内(語), `断りが変わった: ${語}`).toContain(印);
    }
    /* 行が出る語に断りを付けない（第 337 回の門）。 */
    for (const 語 of ["ポスター", "論文締切", "会期"]) {
      expect(件(語), `前提が崩れた（0 行）: ${語}`).toBeGreaterThan(0);
      expect(案内(語), `行が出る語に断りを付けた: ${語}`).toBe("");
    }
  });
});
