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
  return Recommender.candidateRows(catalog) as unknown as Array<{
    hay: string;
  }>;
}

function 当たり列表(語: string): string[] {
  const 当 = Recommender.searchMatcher(語, 基準);
  return 品書()
    .filter((行) => 当(String(行.hay)) === true)
    .map((行) => String(行.hay))
    .sort();
}

function 対称差(a: string[], b: string[]): number {
  const 左 = new Set(a);
  const 右 = new Set(b);
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}

function 画面の案内(語: string): string {
  const 文: string[] = [];
  for (const 欄 of [
    "uiWordLiveNoteJa",
    "columnQueryLiveNoteJa",
    "dayRangeLiveNoteJa",
    "wholeTableQueryNoteJa",
  ] as const) {
    const 値 = (Recommender as unknown as Record<string, (語: string) => string>)[欄](語);
    if (値) 文.push(String(値));
  }
  return 文.join(" | ");
}

/** その方の幅を裸で打った人と同じ行だけ出す事を張る（絶対数はハーネスで変わる – 第 384 回）。 */
function 同じ行列表か(打ち方: string, 正本の打ち方: string) {
  const 正 = 当たり列表(正本の打ち方);
  expect(正.length, `品書に比較元の行が無い: ${正本の打ち方}`).toBeGreaterThan(0);
  expect(対称差(当たり列表(打ち方), 正), `当たり列表が違う: ${打ち方}`).toBe(0);
}

describe("年まで打った月の幅", () => {
  it("年を書いても書かなくても同じ行だけ出す", () => {
    同じ行列表か("2026年8月から2026年11月", "8月から11月");
    同じ行列表か("2026年8月から11月", "8月から11月");
    同じ行列表か("1月から7月", "2027年1月から2027年7月");
    同じ行列表か("2027年1月から2027年6月", "2027年1月から6月");
    同じ行列表か("2026年8月から2026年11月まで", "2026年8月から2026年11月");
  });

  it("記号だけ変えた幅が同じ列表を出す（波ダッシュは黙って窄まらなかった）", () => {
    /* 直し前は `2026年8月〜2026年11月` だけ 61 行（その二つの月を両方持つ行 – AND）で、
     * その方の記号 673 行と 612 行ずれていた（実測）。*/
    同じ行列表か("2026年8月〜2026年11月", "2026年8月から2026年11月");
    同じ行列表か("2026年8月～2026年11月", "2026年8月から2026年11月");
    同じ行列表か("2026年8月~2026年11月", "2026年8月から2026年11月");
    同じ行列表か("2026年8月〜11月", "2026年8月から2026年11月");
    /* 空格で二語に打った人はその侭二語の掛け算（それはその方の打ち方で変えない – 第 354 回）。*/
    const 幅 = 当たり列表("2026年8月から2026年11月");
    const 二語 = 当たり列表("2026年8月 2026年11月");
    expect(二語.length, "二語の掛け算の方が幅を含む").toBeGreaterThan(0);
    expect(二語.length < 幅.length, "二語が幅と同じになってしまった").toBe(true);
  });

  it("年跨ぎの幅と『以降』も解ける（その年を打たれたらその年 – 翌年に繰らない）", () => {
    expect(当たり列表("2026年11月から2027年3月").length).toBeGreaterThan(0);
    expect(当たり列表("2026年12月以降").length).toBeGreaterThan(0);
    /* 暦月の展開その物も張る（年を跨いだ列表が出る事 – 画面の当たり方はこれを読む）。*/
    expect(Recommender.monthRangeTermsJa("2026年11月から2027年3月", 基準)).toEqual([
      "2026年11月",
      "2026年12月",
      "2027年1月",
      "2027年2月",
      "2027年3月",
    ]);
    expect(Recommender.monthRangeTermsJa("2026年8月〜2026年11月", 基準)).toEqual([
      "2026年8月",
      "2026年9月",
      "2026年10月",
      "2026年11月",
    ]);
    /* 年を打たれた時はその年 – 過ぎた月でも翌年へ繰らない（裸の月の語とは別の決まり）。*/
    expect(Recommender.monthRangeTermsJa("2026年1月以降", 基準)[0]).toBe("2026年1月");
    /* 有り得ない月（その月にその日は在らない – 13 月など）は解かない。黙ってその他の月に
     * 化けると画面に出ない語へ導く。*/
    expect(
      Recommender.monthRangeTermsJa("2026年13月以降", 基準),
      "あり得ない月で幅を作った",
    ).toEqual([]);
    expect(当たり列表("2026年13月"), "あり得ない月で行が出た").toEqual([]);
    /* 月の幅を解けた時は暦日の展開に組を奪わせない – その暦日の幅は其侭受ける。*/
    同じ行列表か("2026年8月10日から2026年8月20日", "8月10日から8月20日");
  });
});

describe("発表の種類の別の言い方", () => {
  it("その方の区別を持たないとその場で言い、催し物の名前で当たる事を導す", () => {
    for (const 語 of [
      "ジャーナルペーパー",
      "パネル討論",
      "招待セッション",
      "一般発表",
      "短文",
      "レター",
      "論文特集提案",
      "デモ提出",
    ]) {
      expect(当たり列表(語), `其の語で行が出てしまった: ${語}`).toEqual([]);
      const 文 = 画面の案内(語);
      expect(文, `案内が出ていない: ${語}`).toContain("収録していません");
      expect(文, "当たる道を導していない").toContain("催し物の名前でなら当たります");
      expect(文, "収録が何も持って居ない様に言う").not.toContain("情報は在りません");
    }
  });

  it("当たりのある語は足して居ない（その語を打った人は其侭行を見られる）", () => {
    for (const 語 of ["デモ", "ポスター", "チュートリアル", "特別セッション", "ワークショップ"]) {
      expect(当たり列表(語).length, `当たりが消えた: ${語}`).toBeGreaterThan(0);
      expect(画面の案内(語), `案内を混じた: ${語}`).not.toContain("催し物の名前でなら当たります");
    }
  });
});

describe("成果物", () => {
  it("語の規則を二箇所に書き写して居ない", () => {
    const 成果物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    /* 波ダッシュを『から』に寄せる規則は一つ（年に語を受ける形 – 実測 1 回）。*/
    expect(成果物.split("((?:[0-9]{4}年)?[0-9]{1,2}|来|再来").length - 1).toBe(1);
    /* 年付きの月の語を解く所も一つ（その他の所に正規表現を書き写して居ない事）。*/
    expect(成果物.split("const 年付き = /^(\\d{4})年(\\d{1,2})月$/").length - 1).toBe(1);

    expect(
      Recommender.dayRangeTermsJa("2026年8月から2026年11月", 基準),
      "暦日が月の幅に重なった",
    ).toEqual([]);
    expect(
      Recommender.dayRangeTermsJa("2026年8月10日から2026年8月20日", 基準).length,
      "その方の暦日の幅が消えた",
    ).toBeGreaterThan(0);
  });
});
