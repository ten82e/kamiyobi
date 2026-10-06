/**
 * 採否の知らせと最終版の別の名を行が出る語へ寄せ、原稿の仕上げと當日の運營の語を既存の群で
 * 受ける（第 691 回）。
 *
 * 實測（2026-10-06 – 収録の全体 5,069 行・速く開く品書 870 行・固定時刻 2026-10-06T00:00:00Z。
 * 検査が使ふ固定入力 – 品書 3,250 行・2026-08-09T00:00:00Z でも同じ）で、次の語は**0 行で
 * 案内も無し**だつた – `採録通知` `最終版提出` `キャプション` `付録` `オーバーレングス`
 * `インフォームドコンセント` `査読プロセス` `再査読` `不採録通知` `ページ課金` `録音許可`
 * `肖像権` `タイムキーパー` `質問時間` `記念撮影` `SNS投稿` `ハッシュタグ` `広報`
 * `参加者名簿` `資料公開` `開催中止` `開催延期` `ラウンドテーブル` `ボスターセッション`
 * `英語セッション` `研究集会`。
 *
 * 直しかた – ①**同じ意味を別の名で書いて居る二語は寄せる**（`QUERY_SYNONYMS_JA` –
 * `採録通知` → 種別「採択通知」 242 行・`最終版提出` → 種別「カメラレディ」 149 行。案内では無く
 * **行が出る**直し）。②殘りは既存の群へ（第 612・687〜690 回と同じ判斷）。
 *
 * 突合（群の語 × 語尾の網羅 19,367 本）– **行 增 2・減 0**・**案内 新規 24・消失 0・
 * 文の變へり 0**・寄せ 新規 2。內譯は SPEC.md 第 691 回。
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
const 寄せ = (語: string): string => Recommender.querySynonymNotes(語).join(" ");

/** 寄せた語と、其の寄せ先（收錄が同じ意味を別の名で書いて居る語）。 */
const 寄せた語: Array<[string, string]> = [
  /* 寄せ先は畫面に出る種別の語（`採否通知`）。收錄の原文が書く `採択通知` も同じ行に當たるが、
   * 既定の一覽にその行が無いので畫面に出る語とは見做せない（第 249 回の門 – 檢べが彈いた）。*/
  ["採録通知", "採否通知"],
  ["最終版提出", "カメラレディ"],
];

/** 群へ載せた語と、其の群の斷りに必ず出る語。 */
const 載せた語: Array<[string, string]> = [
  ["キャプション", "原稿の書式・頁数・投稿の手続き"],
  ["付録", "原稿の書式・頁数・投稿の手続き"],
  ["オーバーレングス", "原稿の書式・頁数・投稿の手続き"],
  ["インフォームドコンセント", "原稿の書式・頁数・投稿の手続き"],
  ["査読プロセス", "審査の方式（盲検の形・査読者数）"],
  ["再査読", "審査の方式（盲検の形・査読者数）"],
  ["不採録通知", "採否の結果が分かる日"],
  ["ページ課金", "費用の欄はありません"],
  ["録音許可", "往き方・泊まる所"],
  ["肖像権", "往き方・泊まる所"],
  ["タイムキーパー", "運営と手続きのこと"],
  ["質問時間", "運営と手続きのこと"],
  ["記念撮影", "運営と手続きのこと"],
  ["SNS投稿", "運営と手続きのこと"],
  ["ハッシュタグ", "運営と手続きのこと"],
  ["広報", "運営と手続きのこと"],
  ["参加者名簿", "運営と手続きのこと"],
  ["資料公開", "運営と手続きのこと"],
  ["開催中止", "運営と手続きのこと"],
  ["開催延期", "運営と手続きのこと"],
  ["ラウンドテーブル", "運営と手続きのこと"],
  ["ボスターセッション", "運営と手続きのこと"],
  ["英語セッション", "運営と手続きのこと"],
  ["研究集会", "其の呼び方の催し物を収録していません"],
];

describe("同じ意味を別の名で書いて居る語へ寄せる（第 691 回）", () => {
  it("寄せた語は、寄せ先と同じ行に屆く（一字も違はない）", () => {
    for (const [語, 先] of 寄せた語) {
      const 全 = 全體();
      expect(行列表(先, 全).length, `寄せ先が 0 行: ${先}`).toBeGreaterThan(0);
      expect(行列表(語, 全), `收錄の全體で寄せ先と別の行: ${語}`).toEqual(行列表(先, 全));
      expect(行列表(語), `品書で寄せ先と別の行: ${語}`).toEqual(行列表(先));
    }
  });

  it("寄せた事を件数欄に言う（黙って別の語で探さない – 第 246 回）", () => {
    for (const [語] of 寄せた語) {
      const 文 = 寄せ(語);
      expect(文, `寄せた事を言って居ん: ${語}`).toContain(`「${語}」`);
      expect(文, `寄せ先を名指して居ん: ${語}`).toContain("で探しています");
    }
    expect(寄せ("採録通知"), "種別を名指して居ん").toContain("採否通知");
    expect(寄せ("最終版提出"), "種別を名指して居ん").toContain("カメラレディ");
  });
});

describe("原稿の仕上げと當日の運營の語（第 691 回）", () => {
  it("品書と收錄の全體の兩方で 0 行（案内の出る打ち方である事を先に確かめる）", () => {
    const 全 = 全體();
    for (const [語] of 載せた語) {
      expect(件(語), `品書で行が出た: ${語}`).toBe(0);
      expect(行列表(語, 全).length, `收錄の全體で行が出た: ${語}`).toBe(0);
    }
  });

  it("默らず、其の群の斷りと公式ページへの道を言う", () => {
    for (const [語, 印] of 載せた語) {
      const 文 = 案内(語);
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `其の群の斷りで無い: ${語}`).toContain(印);
    }
    /* 公式ページへ導く群と、其の方で通る締切の語を名指す群がある（斷りの作りは群ごとに違ふ）。 */
    for (const 語 of ["キャプション", "ページ課金", "録音許可", "広報"]) {
      expect(案内(語), `公式ページへ導いて居ん: ${語}`).toContain("公式ページ");
    }
    expect(案内("査読プロセス"), "其の方で通る語を名指して居ん").toContain("『査読』");
    expect(案内("不採録通知"), "其の方で通る語を名指して居ん").toContain("『採択通知』");
    expect(案内("研究集会"), "近い呼び方を名指して居ん").toContain("研究会");
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

  it("行が出る語の斷りは奪はない（第 337 回）", () => {
    const 全 = 全體();
    for (const 語 of ["採択通知", "カメラレディ", "論文締切", "会期"]) {
      expect(行列表(語, 全).length, `前提が崩れた（0 行）: ${語}`).toBeGreaterThan(0);
      expect(案内(語), `行が出る語に斷りを付けた: ${語}`).toBe("");
    }
    /* 同じ群の語の扱ひを變へて居ない。 */
    for (const 語 of [
      "図表",
      "同意書",
      "査読者",
      "不採択",
      "参加費",
      "写真撮影",
      "特殊セッション",
      "中止",
      "大会",
    ]) {
      expect(件(語), `行が出た: ${語}`).toBe(0);
      expect(案内(語), `斷りが消えた: ${語}`).not.toBe("");
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
    /* 寄せの二條も成果物に入つて居る。 */
    for (const [語] of 寄せた語) expect(物, `寄せの條が無い: ${語}`).toContain(`["${語}",`);
  });
});
