/**
 * 會期の一日を指す語と、論文誌・手續きの語（第 688 回）。
 *
 * 實測（2026-10-06 – 収録の全体 5,069 行・速く開く品書 870 行・固定時刻 2026-10-06T00:00:00Z。
 * 検査が使ふ固定入力 – 品書 3,250 行・2026-08-09T00:00:00Z でも同じ）で、次の語は**0 行で
 * 案内も無し**だつた – `初日` `最終日` `中日` `2日目` `3日目` `全日程` `会期初日` `会期最終日`
 * `学術雑誌` `ジャーナル論文` `サテライト` `併設` `ビザ申請` `不採録` `条件付き採録` `応募要領`
 * `改訂`。
 *
 * 直しかた – ①**會期の一日だけは新しい群**を置く。`会期` 其の物は 361 行を持つので欄の名前の表に
 * 載らず（第 686 回）、`開催期間` は欄の名前として案内が出る（同回）– 一日を指す語だけが
 * 默つて居た。行の『会期』に日付が出て居る事と、日付で絞る道を敎へる。
 * ②殘りは既存の群の語列表へ載せる（第 612・687 回と同じ判斷）– `学術雑誌` `ジャーナル論文` は
 * 「この表が載せる種別と違います」の群、`サテライト` `併設` は「運営と手続きのこと」の群、
 * `ビザ申請` は査証の群、`不採録` `条件付き採録` は採否の統計の群、`応募要領` `改訂` は
 * 「原稿の書式・頁数・投稿の手続き」の群。
 *
 * 突合（群の語 × 語尾の網羅 18,756 本）– **行 增 0・減 0**・**案内 新規 17・消失 0・
 * 文の變へり 0**・寄せ 新規 0。內譯は SPEC.md 第 688 回。
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

/** 會期の一日を指す語（新しい群）と、其の群の斷りに必ず出る語。 */
const 會期の語: Array<[string, string]> = [
  ["初日", "行の『会期』に出ています"],
  ["最終日", "行の『会期』に出ています"],
  ["中日", "行の『会期』に出ています"],
  ["2日目", "行の『会期』に出ています"],
  ["3日目", "行の『会期』に出ています"],
  ["全日程", "行の『会期』に出ています"],
  ["会期初日", "行の『会期』に出ています"],
  ["会期最終日", "行の『会期』に出ています"],
];

/** 既存の群へ載せた語と、其の群の斷りに必ず出る語。 */
const 既存の群の語: Array<[string, string]> = [
  ["学術雑誌", "この表が載せる種別と違います"],
  ["ジャーナル論文", "この表が載せる種別と違います"],
  ["サテライト", "運営と手続きのこと"],
  ["併設", "運営と手続きのこと"],
  ["ビザ申請", "この表が持っていません"],
  ["不採録", "採否の結果が分かる日"],
  ["条件付き採録", "採否の結果が分かる日"],
  ["応募要領", "原稿の書式・頁数・投稿の手続き"],
  ["改訂", "原稿の書式・頁数・投稿の手続き"],
];

describe("會期の一日を指す語（第 688 回）", () => {
  it("品書と收錄の全體の兩方で 0 行（案内の出る打ち方である事を先に確かめる）", () => {
    const 全 = 全體();
    for (const [語] of [...會期の語, ...既存の群の語]) {
      expect(件(語), `品書で行が出た: ${語}`).toBe(0);
      expect(行列表(語, 全).length, `收錄の全體で行が出た: ${語}`).toBe(0);
    }
  });

  it("默らず、行の『会期』と日付で絞る道を言う", () => {
    for (const [語, 印] of 會期の語) {
      const 文 = 案内(語);
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `其の群の斷りで無い: ${語}`).toContain(印);
      expect(文, `日付で絞る道が無い: ${語}`).toContain("日付で絞る");
      /* 何日目かの區別を持たない事を書く（持たない物を探させない）。 */
      expect(文, `區別を持たないと言って居ん: ${語}`).toContain("何日目かの区別は持ちません");
    }
  });

  it("案内が例に擧げる日付は、其の方で行が出る", () => {
    const 文 = 案内("初日");
    for (const 例 of ["12月1日", "2026年12月"]) {
      expect(文, `例が文に無い: ${例}`).toContain(例);
      expect(件(例), `例が 0 行: ${例}`).toBeGreaterThan(0);
    }
  });

  it("讀み上げは短く、斷りは其れより長い（聲だけ惡くならん – 第 651 回）", () => {
    for (const [語] of 會期の語) {
      const 聲 = 讀み上げ(語);
      expect(聲, `讀み上げが無い: ${語}`).not.toBe("");
      expect([...聲].length, `讀み上げが六十を越える: ${語}`).toBeLessThanOrEqual(60);
      expect([...案内(語)].length, `斷りが讀み上げより短い: ${語}`).toBeGreaterThanOrEqual(
        [...聲].length,
      );
    }
  });

  it("行が出る語の扱ひを變へて居ない（第 337 回）", () => {
    for (const 語 of ["会期", "2日", "12月1日"]) {
      expect(件(語), `前提が崩れた（0 行）: ${語}`).toBeGreaterThan(0);
      expect(案内(語), `行が出る語に斷りを付けた: ${語}`).toBe("");
    }
    /* 同じ欄を指す `開催期間` は欄の名前の斷り（第 686 回）– 此の群が先取りせん。 */
    expect(
      String(Recommender.columnQueryNoteJa("開催期間", (値) => 件(値) > 0) || ""),
      "欄の名前の斷りを奪つた",
    ).toContain("欄（会期）");
    /* 日付の欄の語（`日付` `スケジュール`）も其の侭。 */
    expect(案内("日付"), "`日付` の斷りが化けた").toContain("この表の日付の欄の名前");
  });
});

describe("論文誌と手續きの語を既存の群で受ける（第 688 回）", () => {
  it("默らず、其の群の斷りを受ける", () => {
    for (const [語, 印] of 既存の群の語) {
      const 文 = 案内(語);
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `其の群の斷りで無い: ${語}`).toContain(印);
    }
  });

  it("同じ群の語の扱ひを變へて居ない", () => {
    for (const 語 of [
      "学会誌",
      "掲載誌",
      "特殊セッション",
      "ビザ",
      "招へい状",
      "採録",
      "不採択",
      "再投稿",
    ]) {
      expect(件(語), `行が出た: ${語}`).toBe(0);
      expect(案内(語), `斷りが消えた: ${語}`).not.toBe("");
    }
    for (const 語 of ["論文誌"]) {
      expect(件(語), `前提が崩れた（0 行）: ${語}`).toBeGreaterThan(0);
      expect(案内(語), `行が出る語に斷りを付けた: ${語}`).toBe("");
    }
  });
});

describe("語列表その物の棚卸し（第 688 回）", () => {
  it("載せた語は、正本の群に一度ずつ載つて居る（一語一羣 – 第 512 回）", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 始 = 物.indexOf("const UI_WORD_GROUPS_JA = [");
    expect(始, "群の一覧が見つからない").toBeGreaterThan(0);
    const 後 = 物.slice(始);
    const 終 = 後.match(/\n\s*\];/);
    const 本 = 後.slice(0, 終 ? 終.index : 後.length);
    for (const [語] of [...會期の語, ...既存の群の語]) {
      /* 末尾の語は讀點が付かん（`"会期最終日"` の侭）ので、括りだけを數へる。 */
      const 數 = 本.split(`"${語}"`).length - 1;
      expect(數, `群の語列表に ${數} 回（一度だけ載せる）: ${語}`).toBe(1);
    }
    /* 會期の群の斷りが成果物に入つて居る（語だけ載せて斷りを忘れる形を防ぐ）。 */
    expect(本, "會期の群の斷りが無い").toContain("は行の『会期』に出ています");
  });
});
