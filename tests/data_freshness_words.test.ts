import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 斷り = (文: string): string =>
  String(Recommender.uiWordNoteJa(文, false) || Recommender.wholeTableQueryNoteJa(文) || "").trim();
const 短い = (文: string): string => String(Recommender.uiWordLiveNoteJa(文) || "").trim();
const 品書 = Recommender.candidateRows(
  JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8")),
);
const 当たり = (文: string): number => {
  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, 基準), 基準);
  return 品書.filter((r: { hay?: string }) => m(String(r.hay)) === true).length;
};

const 打ち手 = [
  "最近更新",
  "更新時期",
  "更新された",
  "古いですか",
  "いつのもの",
  "いつ更新",
  "鮮度",
];

describe("データの鮮度を訪ねる言い方（第 637 回）", () => {
  it("七本が黙らん – 右上の『データ生成』と『見方のてびき』を名指す", () => {
    for (const 文 of 打ち手) {
      const out = 斷り(文);
      expect(out, `默つた: ${文}`).not.toBe("");
      expect(out, `『データ生成』を名指さぬ案內: ${文}`).toContain("データ生成");
      expect(out, `てびきの所が書かれて居ん: ${文}`).toContain("見方のてびき");
      expect(out, `搜で絞れると誤らす案內: ${文}`).toContain("検索では絞り込めません");
      expect(out, `他の家の文が混じつた: ${文}`).not.toContain("費用の欄");
      expect(当たり(文), `当たり行の出る打ち手: ${文}`).toBe(0);
    }
  });
  it("読み上げは 60 字以内（第 247 回 – 旧この家是七十三字だった）", () => {
    for (const 文 of 打ち手) {
      const 字 = [...短い(文)];
      expect(字.length, `讀み上げが ${字.length} 字: ${文}`).toBeLessThanOrEqual(60);
      expect(短い(文), `聲から搜の條が消えた: ${文}`).toContain("検索では絞り込めません");
    }
    /* 五文字の語を載せても条の内（縮めた證左 – 讓すれば 73+7 字になつた）。 */
    expect([...短い("いつのもの")].length).toBeLessThanOrEqual(60);
  });
  it("案内が名指す物がビルドした画面に実ある（第 466 回）", () => {
    const 頁 = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    expect(頁, `画面にない物を書いた: データ生成`).toContain("データ生成");
    expect(頁, `画面にない物を書いた: 見方のてびき`).toContain("見方のてびき");
  });
  it("検索で行が出る打ち手は載せん（第 503 回の磁石 – 噓の門）", () => {
    for (const 文 of ["いつのデータ", "データはいつ"]) {
      expect(当たり(文), `${文} は行が出る筈`).toBeGreaterThan(0);
      expect(斷り(文), `搜の打ち手に『データ生成』を乘せた: ${文}`).not.toContain("のことなら、");
    }
  });
});

describe("古さの警報（dataAgeNoteJa）", () => {
  const 日 = 86400000;
  const 文 = (日數: number): string =>
    String(Recommender.dataAgeNoteJa(new Date(基準 - 日 * 日數).toISOString(), 基準));
  it("三日前から出て二日前では黙る（日次運用の条 – 実測）", () => {
    expect(文(2), "二日では黙る筈").toBe("");
    expect(文(3)).toContain("3 日前");
    expect(文(9)).toContain("9 日前");
    expect(文(3)).toContain("日次で更新する運用");
    expect(文(3)).toContain("公式サイトの募集要項");
  });
  it("入力は生成時刻の文字列（数字を渡すと黙る – 型の契約を残す）", () => {
    expect(String(Recommender.dataAgeNoteJa(基準 - 30 * 日, 基準)), "数字でも効く積り").toBe("");
    expect(文(30)).toContain("30 日前");
  });
});
