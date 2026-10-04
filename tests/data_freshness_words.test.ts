/**
 * データの鮮度を訪ねる言い方（最近更新・いつのもの・古いですか）と、その聲の長さ（第 637 回）。
 *
 * 實測 – 2026-08-09T00:00:00Z 生成の実ビルド（品書 3,280 行）で `最近更新` `更新時期`
 * `更新された` `古いですか` `いつのもの` はいずれも品書 0 行で導きが無く、而して答へは既に
 * 同じ羣に在つた（右上の『データ生成』・『見方のてびき』の『データ更新』・日次の運用）。
 * 案内文は增やさず、言い方五枚だけを載せた（第 635・636 回と同じ型）。
 *
 * もう一つ – **其の羣の讀み上げが七十三字あつた**（第 247 回の條を六字越して居た）。五文字の語を
 * 載せると更に越すので、聲を五十二字に縮めた（畫の note は變はさん – 聲は畫の要約で好い –
 * 第 631 回。「検索では絞り込めません」の句は聲に殘す – 搜で絞れると思はせんと為）。效き –
 * `鮮度` の讀み上げ 73 → 56 字（この家是舊來から七十三字で讀まれて居た）。
 *
 * `dataAgeNoteJa` は生成からの日數で出るwarningsの文 – 三日前から出て二日前では默る（實測）。
 * 入力は文字列（ISO）で無いと空を返す – 數字を渡すと「警報が何時も出ん」と誤讀んだ（第 637 回
 * の自分の疵）ので、型の契約を檢査に殘す。
 */

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
  it("七本が默らん – 右上の『データ生成』と『見方のてびき』を名指す", () => {
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
  it("讀み上げは 60 字以内（第 247 回 – 舊この家是七十三字だつた）", () => {
    for (const 文 of 打ち手) {
      const 字 = [...短い(文)];
      expect(字.length, `讀み上げが ${字.length} 字: ${文}`).toBeLessThanOrEqual(60);
      expect(短い(文), `聲から搜の條が消えた: ${文}`).toContain("検索では絞り込めません");
    }
    /* 五文字の語を載せても條の内（縮めた證左 – 讓すれば 73+7 字になつた）。 */
    expect([...短い("いつのもの")].length).toBeLessThanOrEqual(60);
  });
  it("案內が名指す物がビルドした畫面に實在る（第 466 回）", () => {
    const 頁 = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    expect(頁, `畫面に無い物を書いた: データ生成`).toContain("データ生成");
    expect(頁, `畫面に無い物を書いた: 見方のてびき`).toContain("見方のてびき");
  });
  it("搜で行が出る打ち手は載せん（第 503 回の磁石 – 噓の門）", () => {
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
  it("三日前から出て二日前では默る（日次運用の條 – 實測）", () => {
    expect(文(2), "二日では默る筈").toBe("");
    expect(文(3)).toContain("3 日前");
    expect(文(9)).toContain("9 日前");
    expect(文(3)).toContain("日次で更新する運用");
    expect(文(3)).toContain("公式サイトの募集要項");
  });
  it("入力は生成時刻の文字列（數字を渡すと默る – 型の契約を殘す）", () => {
    expect(String(Recommender.dataAgeNoteJa(基準 - 30 * 日, 基準)), "數字でも効く積り").toBe("");
    expect(文(30)).toContain("30 日前");
  });
});
