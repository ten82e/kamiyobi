/**
 * 「まだ受付中？」と「PDF の読み込みを止めたい」を、畫面の名前で答へる（第 629 回）。
 *
 * 實測 – 2026-08-09T00:00:00Z 生成の実ビルド（品書 3,280 行）で 0 件になる打ち手 819 本を
 * 讀み直した處、此の二つの類が默つて居た（`まだ受付中` `受付中` `まだ間に合う` `今から投稿`
 * `滑り込み` / `PDF読み込みキャンセル` `PDFの読み込み` `ファイルを読み込み`
 * `読み込みをキャンセル`）。手書きの十四本で數へると、羣の斷りは **6 → 12 本**（当たり行の
 * 出る打ち手は無し – 第 337 回に觸れん）。`読み込みをキャンセル` は舊來「収録に無い欄」の
 * 斷りに落ちて居た – 押すボタンが畫面に在るので、導き間違ひになる。
 * 直しかた – 羣を二つ置き（`site/recommender.ts` の `UI_WORD_GROUPS_JA`）、斷りは**數を
 * 發合せんで見方だけを教へる**（殘り日数は列『締切まで』・終る日の無い物は『種別』の
 * 『常時受付』・過ぎた物は『過去の締切も表示』）。語尾に一覧へ「キャンセル」を足す。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 斷り = (文: string): string => String(Recommender.uiWordNoteJa(文, false) || "").trim();
const 短い = (文: string): string => String(Recommender.uiWordLiveNoteJa(文) || "").trim();
const 品書 = () =>
  Recommender.candidateRows(
    JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8")),
  );
const 当たり = (文: string): number => {
  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, 基準), 基準);
  return 品書().filter((r: { hay?: string }) => m(String(r.hay)) === true).length;
};

const 受付の打ち手 = ["受付中", "まだ受付中", "まだ間に合う", "今から投稿", "滑り込み"];
const 讀みの打ち手 = [
  "PDF読み込みキャンセル",
  "PDFの読み込み",
  "ファイルを読み込み",
  "読み込みをキャンセル",
  "pdfを読み込みたい",
];

describe("受付中を訪ねる打ち手（第 629 回）", () => {
  it("默らんやうにした上で、數を發合せんで見方を教へる", () => {
    for (const 文 of 受付の打ち手) {
      const out = 斷り(文);
      expect(out, `默つた: ${文}`).not.toBe("");
      expect(out, `見方の列が書かれて居ん: ${文}`).toContain("締切まで");
      expect(out, `常時受付の選び方が書かれて居ん: ${文}`).toContain("常時受付");
      expect(out, `過ぎた締切の出し方が書かれて居ん: ${文}`).toContain("過去の締切も表示");
      /* 締切の推測も、行の数の發音もせん（第 535 回 – 测て無い數は書かん）。 */
      expect(/[0-9０-９]/.test(out), `數を發して居る: ${文} → ${out}`).toBe(false);
    }
  });
  it("当たり行の出る打ち手に乘らん（第 337 回）", () => {
    for (const 文 of 受付の打ち手) expect(当たり(文), `行が出た: ${文}`).toBe(0);
  });
});

describe("PDF の読み取りを止めたい人（第 629 回）", () => {
  it("「収録に無い欄」の斷りに落とさず、押す所を名指す", () => {
    for (const 文 of 讀みの打ち手) {
      const out = 斷り(文);
      expect(out, `默つた: ${文}`).not.toBe("");
      expect(out, `押すボタンが書かれて居ん: ${文}`).toContain("PDF読み込みをキャンセル");
      expect(out, `舊來の「収録に無い欄」の斷りに落ちた: ${文}`).not.toContain(
        "この表が持つ欄の名前ではありません",
      );
    }
    /* 小文字の打ち方も同じ道を通る（羣の語は大小を區別せんとdup檢査が言つて居る – 第 383 回）。 */
    expect(斷り("pdf読み込み")).toContain("論文を貼る所");
  });
  it("讀み取りの実態を實物と同じやうに書く（先頭3ページ・送信せん）", () => {
    const out = 斷り("PDFの読み込み");
    expect(out).toContain("先頭3ページ");
    expect(out).toContain("送信しません");
  });
  it("当たり行の出る打ち手に乘らん（第 337 回）", () => {
    for (const 文 of 讀みの打ち手) expect(当たり(文), `行が出た: ${文}`).toBe(0);
  });
});

describe("斷りが名指す所は畫面に在る（第 466 回・第 628 回の流儀）", () => {
  it("ビルドした頁の見出しと一字違はん", () => {
    const 頁 = readFileSync(join(builtSite(), "index.html"), "utf8");
    for (const 字 of [
      "締切まで",
      "常時受付",
      "過去の締切も表示",
      "PDF読み込みをキャンセル",
      "論文の入力",
    ])
      expect(頁, `畫面に無い名前を案内が言った: ${字}`).toContain(字);
    /* 読み取りの但し書きも畫面の字面（案内が同じ數を言つて居る）。 */
    expect(頁).toContain("先頭3ページ");
  });
  it("讀み上げは 60 字以内（第 247 回）", () => {
    for (const 文 of 受付の打ち手.concat(讀みの打ち手)) {
      const 字 = [...短い(文)];
      expect(字.length, `讀み上げが ${字.length} 字: ${文}`).toBeLessThanOrEqual(60);
    }
  });
});

describe("他の導線を夺うた事無ん（磁石 – 第 503 回）", () => {
  it("`PDF` 單體は舊來通り印刷へ導す", () => {
    expect(当たり("PDF") + 斷り("PDF").length).toBeGreaterThan(0);
    expect(斷り("PDF")).toContain("印刷");
    expect(斷り("PDF")).not.toContain("PDF読み込みをキャンセル");
  });
  it("`キャンセル` 單體は舊來の羣の侬", () => {
    expect(斷り("キャンセル")).toContain("欄の名前ではありません");
  });
  it("搜の文に畫面の斷りを乘せん", () => {
    for (const 文 of ["セキュリティの会議", "AI の論文", "ネットワーク ワークショップ"]) {
      expect(当たり(文), `行が消えた: ${文}`).toBeGreaterThan(0);
    }
  });
});
