import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 斷り = (文: string): string => String(Recommender.uiWordNoteJa(文, false) || "").trim();
const 短い = (文: string): string => String(Recommender.uiWordLiveNoteJa(文) || "").trim();
const template = readFileSync(new URL("../site/template.html", import.meta.url), "utf8");
const cancelLabel = /<button\b[^>]*id="cancelPdf"[^>]*>([^<]+)<\/button>/
  .exec(template)?.[1]
  .trim();
if (!cancelLabel) throw new Error("cancel control is missing");
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
  it("黙らんやうにした上で、数を發合せんで見方を教へる", () => {
    for (const 文 of 受付の打ち手) {
      const out = 斷り(文);
      expect(out, `默つた: ${文}`).not.toBe("");
      expect(out, `見方の列が書かれて居ん: ${文}`).toContain("締切まで");
      expect(out, `常時受付の選び方が書かれて居ん: ${文}`).toContain("常時受付");
      expect(out, `過ぎた締切の出し方が書かれて居ん: ${文}`).toContain("過去の締切も表示");
      /* 締切の推測も、行の数の發音もせん。 */
      expect(/[0-9０-９]/.test(out), `數を發して居る: ${文} → ${out}`).toBe(false);
    }
  });
  it("当たり行の出る打ち手に乘らん（第 337 回）", () => {
    for (const 文 of 受付の打ち手) expect(当たり(文), `行が出た: ${文}`).toBe(0);
  });
});

describe("PDF の読み取りを止めたい人（第 629 回）", () => {
  it("「収録にない欄」の斷りに落とさず、押す所を名指す", () => {
    for (const 文 of 讀みの打ち手) {
      const out = 斷り(文);
      expect(out, `默つた: ${文}`).not.toBe("");
      expect(out, `押すボタンが書かれて居ん: ${文}`).toContain(cancelLabel);
      expect(out).toContain("投稿先を探す");
      expect(out, `舊來の「収録に無い欄」の斷りに落ちた: ${文}`).not.toContain(
        "この表が持つ欄の名前ではありません",
      );
    }
    /* 小文字の打ち方も同じ道を通る（羣の語は大小を區別せんとdup検査が言つている – 第 383 回）。 */
    expect(斷り("pdf読み込み")).toContain("論文の入力");
  });
  it("読み取りの実態を実物と同じやうに書く（先頭3ページ・送信せん）", () => {
    const out = 斷り("PDFの読み込み");
    expect(out).toContain("先頭3ページ");
    expect(out).toContain("送信しません");
  });
  it("当たり行の出る打ち手に乘らん（第 337 回）", () => {
    for (const 文 of 讀みの打ち手) expect(当たり(文), `行が出た: ${文}`).toBe(0);
  });
});

describe("斷りが名指す所は画面にある（第 466 回・第 628 回の流儀）", () => {
  it("ビルドした頁の見出しと一字違はん", () => {
    const 頁 = readFileSync(join(builtSite(), "index.html"), "utf8");
    for (const 字 of ["締切まで", "常時受付", "過去の締切も表示", cancelLabel, "論文の入力"])
      expect(頁, `畫面に無い名前を案内が言った: ${字}`).toContain(字);
    /* 読み取りの但し書きも画面の字面（案内が同じ数を言つている）。 */
    expect(頁).toContain("先頭3ページ");
  });
  it("読み上げは 60 字以内（第 247 回）", () => {
    for (const 文 of 受付の打ち手.concat(讀みの打ち手)) {
      const 字 = [...短い(文)];
      expect(字.length, `讀み上げが ${字.length} 字: ${文}`).toBeLessThanOrEqual(60);
    }
  });
});

describe("他の導線を夺うた事無ん（磁石 – 第 503 回）", () => {
  it("`PDF` 単体は旧來通り印刷へ導す", () => {
    expect(当たり("PDF") + 斷り("PDF").length).toBeGreaterThan(0);
    expect(斷り("PDF")).toContain("印刷");
    expect(斷り("PDF")).not.toContain(cancelLabel);
  });
  it("`キャンセル` 単体は旧來の羣の侬", () => {
    expect(斷り("キャンセル")).toContain("欄の名前ではありません");
  });
  it("検索の文に画面の斷りを乘せん", () => {
    for (const 文 of ["セキュリティの会議", "AI の論文", "ネットワーク ワークショップ"]) {
      expect(当たり(文), `行が消えた: ${文}`).toBeGreaterThan(0);
    }
  });
});
