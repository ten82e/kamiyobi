/**
 * 「〜はどれ？」「〜会議」で終る訪ね方と、日数・最新・伸びたの別の名前（第 683 回）。
 *
 * 事實（2026-08-09T00:00:00Z 生成の実ビルド・品書 3,250 行）– `最も近い締切はどれ？`
 * `早い締切はどれ` `早い会議` `締切が伸びた会議` `日数` `締切までの日数` `最新の締切`
 * `伸びた` は 0 行で案内も無く、行き止まりの受皿に落ちて居た。訪ねの語を羣に載せる道
 * （`exactOnly` – 第 682 回）とは別に、**打ち方の末尾に續くだけの語**（選ぶ事の訪ね・
 * 讀點・催し物の名を一般的な一語で締める言ひ方）を剝ぐ道を又ぎ側に足した。
 *
 * 此處の肝 – 崩した形は**後に數へる**。先に數へると `分野は幾つ` が「分野」一文字に落ちて
 * 第 649 回の案内を奪ふ（實測で檢査が彈いた – 下の「其の侬を先に」の條が其れを張る）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { queryReferenceSnapshotPath } from "./query_reference.ts";
import { deadlineHintFunction } from "./runtime_extract.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
const 本 = readFileSync(`${process.cwd()}/site/recommender.ts`, "utf8");
const 品書 = Recommender.candidateRows(
  JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8")),
);
const hays = 品書.map((行) => String(行.hay));

const 搜 = (文: unknown): number => {
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(String(文), AT), AT);
  return hays.filter((行) => 照合(行) === true).length;
};
const 案内 = (文: string): string => String(Recommender.uiWordNoteJa(文, false) || "");
const 行列表 = (文: string): string[] => {
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, AT), AT);
  return hays.filter((行) => 照合(行) === true).sort();
};

describe("選ぶ事の訪ね・語尾の催し物の名・日数と伸びた（第 683 回）", () => {
  it("品書は 3,250 行", () => {
    expect(品書.length).toBe(3250);
  });

  it("默つて居た訪ね方が、其の羣の斷りを受ける", () => {
    // 選ぶ事を訪ねて終る形 – 羣の語の道（又ぎ側）が語尾の白一覧を知らん為、舊來は默つた。
    for (const 文 of ["最も近い締切はどれ？", "早い締切はどれ", "近い締切はどれ？", "早い会議"]) {
      expect(案内(文), `『${文}』が默つた侬`).toContain("では絞りません");
    }
    // 日の語の別の名前 – 斷りは「残り日数の昇順」と『締切まで』の欄を名指す羣に載せた。
    for (const 文 of ["日数", "締切までの日数", "残り日数", "最新", "最新の締切", "新しい締切"]) {
      expect(案内(文), `『${文}』が默つた侬`).toContain("残り日数の昇順");
    }
    // 動詞で訪ねる形の後の催し物の名 – 讓りの語尾に `会議` を足して受ける。
    expect(案内("締切が伸びた会議")).toContain("延伸");
    expect(案内("遠い会議")).toContain("では絞りません");
  });

  it("其の侬を先に數へる – 崩した形が案内を奪はん", () => {
    // `は幾つ` を剥ぐと「分野」一文字になり、第 649 回の案内が落ちる（崩しは次に數へる證）。
    for (const 文 of ["分野は幾つ", "分野はどこを見れば", "どんな分野を扱ってる"]) {
      expect(案内(文), `『${文}』が默つた侬`).toContain("チップ");
    }
    // 配線 – 其の侬（生）が先に屆き、崩（剥いだ形）は歸つて來た時だけ見る。
    const 道 = 本.slice(本.indexOf("function uiWordMatch("), 本.indexOf("function uiWordMatch文("));
    expect(道).toContain("uiWordMatch文(生) ||");
    expect(道).toContain("崩 !== 生");
    expect(道.length).toBeLessThan(900);
  });

  it("伸びた・延びたは締切が延びた印「延長」に寄せる – 行が實際に出る", () => {
    expect(搜("延長")).toBeGreaterThan(0);
    expect(搜("伸びた")).toBe(搜("延長"));
    expect(搜("延びた")).toBe(搜("延長"));
    expect(行列表("伸びた")).toEqual(行列表("延長"));
    // 彈いた語 – 逆のこと（早まつた日）は『延長』の印に出んと斷り切れん為、寄せん。
    expect(搜("早まった")).toBe(0);
    expect(搜("変更")).toBe(0);
  });

  it("搜れる打ち手には何も被せん – 語尾の剥ぎと `会議` は 0 件の時だけ效く", () => {
    // 行が出る打ち方は讓りが出ん（`site/app.ts` の門）だが、案内の函數も寄せん事を張る。
    expect(搜("登録の会議")).toBeGreaterThan(0);
    expect(案内("登録の会議")).toBe("");
    expect(案内("オンラインの会議")).toBe("");
    // 值を並べた打ち手（第 250 回・第 354 回）の側は舊來通り – 空格を跨いだ剥ぎは無かった。
    expect(案内("過去の締切 関西")).toBe("");
  });

  it("默らせると決めた物は默つた侬", () => {
    // 第 653 回 – 事實として張る默り・第 623 回 – 二語を打った形の默り。
    for (const 文 of ["いつ締切られますか", "手数料 締切", "間に合う 締切"]) {
      expect(案内(文), `『${文}』が開いた`).toBe("");
    }
  });

  it("行き止まりの畫面文にも載る（受皿だけに落ちん）", () => {
    const 文 = "最も近い締切はどれ？";
    const 欄 = deadlineHintFunction();
    const 出 = String(
      欄({
        window: "all",
        past: false,
        cats: 0,
        domestic: false,
        online: false,
        rank: "all",
        kind: "",
        est: false,
        clearable: true,
        pastShown: false,
        hidden: { past: 1200, est: 134 },
        hiddenKindWords: [],
        queryMatch: { catalog: 0, journal: 0 },
        catalogConferences: 700,
        urlQuery: false,
        termCounts: [{ term: 文, count: 0 }],
        shorterHits: Recommender.shorterHitWordsJa(文, hays, AT, 4) || [],
        query: 文,
        categoryNames: ["人工知能", "データベース"],
      }),
    );
    expect(出).toContain("残り日数の昇順");
    expect(出.length).toBeLessThanOrEqual(320);
  });
});
