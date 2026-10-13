import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";
import { deadlineHintFunction, zeroResultLiveFunction } from "./runtime_extract.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 畫面 = deadlineHintFunction();
const 聲 = zeroResultLiveFunction();
const 品書 = Recommender.candidateRows(
  JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8")),
);

/** 0 件の画面を作る – 既定では外せる条件が二つある（過去 1,200・推定 134）。 */
function 袋(文: string, 追加: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    queryMatch: { catalog: 0, journal: 0 },
    catalogConferences: 12,
    urlQuery: false,
    termCounts: [{ term: 文, count: 0 }],
    shorterHits: [],
    hiddenKindWords: [],
    query: 文,
    ...追加,
  };
}

/* 受皿に落ちる打ち手（実測で羣の斷りも全行の語も当たらん物 – 画面の機能を訪ねる語・
   収録に無い情報を訪ねる語・ただの頼み）。 */
const 受皿の打ち手 = [
  "スクロール",
  "このページの説明",
  "査読のフィードバック",
  "可能ですか",
  "并べ替えて",
  "締切がまだ先の",
  "見ることはできますか",
];
/* 羣の斷りが当たる打ち手（斷りの文が既に句点で終る – 「。。」の出た所）。 */
const 斷りの當たる打ち手 = [
  "動画を見ることはできますか",
  "読み込みをキャンセル",
  "過去締切表示",
  "購読",
];

describe("受皿の文がこの表の中身を言う（第 632 回）", () => {
  it("黙る打ち手は、収録される欄の名前とてびきの場所まで読む", () => {
    for (const 文 of 受皿の打ち手) {
      const out = 畫面(袋(文));
      expect(out, `受皿の文が短い: ${文}`).toContain(
        "この表が出すのは催し物の名前・締切の日・分野・種別・開催地・参加形式",
      );
      expect(out, `てびきの場所が書かれて居ん: ${文}`).toContain("見方のてびき");
    }
  });
  /* 第 679 回 – 受皿の文が分野の欄の語を並べる（九分野外の語を打つ人に邊界を傳ふる）。*/
  it("受皿の文が分野の名前を数えて並べる（第 679 回）", () => {
    /* 実測（2026-08-09 生成の実ビルド・品書 3,250 行）– 情報処理の九分野外の語を打つ人は 0 行で、
     * 受皿は「分野名・主題・開催地の日本語でも引けます」とだけ言っていた（`脳科学` 0 行・
     * `ソナー` 0 行・`ケルビン` 0 行・`車座` 0 行 – 収録の品書で検索 0 行を確かめてある）。
     * 邊界が分らん人は分野名を並べ直して空振りし續けるので、分野の欄に出る語を数へて言う。
     * 並べる語は検査が品書から数へる（収録の分野が増えたら案内にも增へる證 – 書き寫しを防ぐ）。 */
    const 欄 = [...new Set(品書.flatMap((r: { cats?: string[] }) => (r.cats || []) as string[]))]
      .map((c: string) => Recommender.categoryLabelJa(c))
      .sort((a: string, b: string) => a.localeCompare(b, "ja"));
    expect(欄.length, "品書から分野が読められん（検査が空振りする）").toBe(9);
    const out = 畫面(袋("脳科学", { categoryNames: 欄 }));
    expect(out, "分野の欄の名前が並んでいない").toContain(`分野の欄は${欄.join("・")}`);
    expect(out, "本数を数えて言はんだ").toContain(`の${欄.length}種だけ`);
    // 他の呼び出し口が語を渡さんとその文は出ん（受皿の文その物は消へん）。
    const 無 = 畫面(袋("脳科学"));
    // 空の並べで來ても噓を書かん（「分野の欄はの0種だけ」のやうな空文を出さない – 第 244 回）。
    const 空 = 畫面(袋("脳科学", { categoryNames: [] }));
    expect(空, "語のない並べで空文を出した").not.toContain("分野の欄は");
    expect(空, "受皿の文が消えた").toContain("別の語で試す");
    expect(無, "渡さん語を並べた").not.toContain("分野の欄は");
    expect(無, "受皿の文が消えた").toContain("別の語で試す");
    // app が語を渡している證（渡しが切れると案内だけが古くなる – 第 215 回と同じ疵）。
    const 源 = readFileSync(join(REPO_ROOT, "site", "app.ts"), "utf8");
    expect(源, "app が分野の語を渡していない").toContain("categoryNames: categoryChipKeys(");
  });

  it("羣の斷りが当たる打ち手では二重に言はん", () => {
    /* 斷りを持つ側に同じ文を並べると、同じ話を二度読む事になる。 */
    for (const 文 of 斷りの當たる打ち手) {
      const out = 畫面(袋(文));
      /* 斷りが当たるので、受皿の「別の語で試す…」は出ん（出たら同じ話を二度になる）。 */
      expect(out, `受皿に落ちた（斷りが當たらん）: ${文}`).not.toContain("別の語で試す");
      expect(out.split("この表が出すのは").length - 1, `受皿の文が二重に落ちた: ${文}`).toBe(0);
    }
  });
  it("案内が名指す欄とてびきは、ビルドした画面に実物がある（第 466 回）", () => {
    const 頁 = readFileSync(join(builtSite(), "index.html"), "utf8");
    for (const 字 of ["催し物", "締切", "分野", "種別", "開催地", "参加形式", "見方のてびき"])
      expect(頁, `畫面に無い物を受皿が言った: ${字}`).toContain(字);
  });
});

describe("読み上げの句点（第 632 回）", () => {
  it("「。。」を並べん – 斷りが句点で終つても下に續く", () => {
    for (const 文 of 斷りの當たる打ち手.concat(受皿の打ち手)) {
      const out = 聲(袋(文));
      expect(out.includes("。。"), `句點が二つ並んだ: ${文} → ${out}`).toBe(false);
      expect(out.includes("。下に外せる条件"), `續きが落ちて讀み上げが途中で切れた: ${文}`).toBe(
        true,
      );
    }
  });
  it("受皿の短い読み上げは 60 字以内（第 247 回）", () => {
    for (const 文 of 受皿の打ち手) {
      const out = 聲(袋(文));
      expect([...out].length, `讀み上げが ${[...out].length} 字: ${文}`).toBeLessThanOrEqual(60);
    }
  });
  it("検索の側は変はらん – 当たり行の出る打ち手は依然として出る", () => {
    const 當 = (文: string): number => {
      const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, 基準), 基準);
      return 品書.filter((r: { hay?: string }) => m(String(r.hay)) === true).length;
    };
    for (const 文 of ["セキュリティ", "ネットワーク", "研究会", "国内"])
      expect(當(文), `行が消えた: ${文}`).toBeGreaterThan(0);
  });
});
