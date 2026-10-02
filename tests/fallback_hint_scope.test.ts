/**
 * 案内の當たらん打ち手が落ちる受皿の文を、畫面の内容まで言う物にした（第 632 回）。
 *
 * 實測 – 2026-08-09T00:00:00Z 生成の実ビルド（品書 3,280 行）で 0 件になる打ち手 844 本の內
 * **273 本**が「羣の斷りも全行の語の打ち直しも當たらん」受皿に落ちて居た。其の文は
 * 「過去の締切も表示」「推定締切を含める」「別の語で試す」を數へるだけで、**この表が何を出す
 * 画面なのか**を一言も言はなんだ（`スクロール` `このページの説明` `査読のフィードバック`
 * `可能ですか` を打った人に、締切の日と催し物しか載らん事が伝わらん）。
 * 疵をもう一處 – 讀み上げは `site/recommender.ts` の斷りが句點で終る文に「。下に外せる条件も」を
 * 継いで、**「。。」を並べて居た**（實測 – 「公式ページをご覧ください。。下に外せる条件も」）。
 * 直し – 受皿の文に一筆足す（`site/app.ts` の `emptyDeadlineHint` の打ち替えの處）・句點を
 * 一つに揃へる（同じ函數の `聲`）。檢索の側は變はらん（第 362 回）。
 */

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

/** 0 件の畫面を作る – 既定では外せる条件が二つ在る（過去 1,200・推定 134）。 */
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

/* 受皿に落ちる打ち手（實測で羣の斷りも全行の語も當たらん物 – 画面の機能を訪ねる語・
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
/* 羣の斷りが當たる打ち手（斷りの文が既に句點で終る – 「。。」の出た所）。 */
const 斷りの當たる打ち手 = [
  "動画を見ることはできますか",
  "読み込みをキャンセル",
  "過去締切表示",
  "購読",
];

describe("受皿の文がこの表の中身を言ふ（第 632 回）", () => {
  it("默る打ち手は、収録される欄の名前とてびきの場所まで讀む", () => {
    for (const 文 of 受皿の打ち手) {
      const out = 畫面(袋(文));
      expect(out, `受皿の文が短い: ${文}`).toContain(
        "この表が出すのは催し物の名前・締切の日・分野・種別・開催地・参加形式",
      );
      expect(out, `てびきの場所が書かれて居ん: ${文}`).toContain("見方のてびき");
    }
  });
  /* 第 679 回 – 受皿の文が分野の欄の語を並べる（九分野外の語を打つ人に邊界を傳ふる）。*/
  it("受皿の文が分野の名前を數へて並べる（第 679 回）", () => {
    /* 實測（2026-08-09 生成の実ビルド・品書 3,250 行）– 情報処理の九分野外の語を打つ人は 0 行で、
     * 受皿は「分野名・主題・開催地の日本語でも引けます」とだけ言っていた（`脳科学` 0 行・
     * `ソナー` 0 行・`ケルビン` 0 行・`車座` 0 行 – 收錄の品書で搜 0 行を確かめてある）。
     * 邊界が分らん人は分野名を並べ直して空振りし續けるので、分野の欄に出る語を數へて言う。
     * 並べる語は檢査が品書から數へる（收錄の分野が増えたら案内にも增へる證 – 書き寫しを防ぐ）。 */
    const 欄 = [...new Set(品書.flatMap((r: { cats?: string[] }) => (r.cats || []) as string[]))]
      .map((c: string) => Recommender.categoryLabelJa(c))
      .sort((a: string, b: string) => a.localeCompare(b, "ja"));
    expect(欄.length, "品書から分野が讀められん（檢査が空振りする）").toBe(9);
    const out = 畫面(袋("脳科学", { categoryNames: 欄 }));
    expect(out, "分野の欄の名前が並んで居ん").toContain(`分野の欄は${欄.join("・")}`);
    expect(out, "本數を數へて言はんだ").toContain(`の${欄.length}種だけ`);
    // 他の呼び出し口が語を渡さんと其の文は出ん（受皿の文その物は消へん）。
    const 無 = 畫面(袋("脳科学"));
    // 空の並べで來ても噓を書かん（「分野の欄はの0種だけ」のやうな空文を出さない – 第 244 回）。
    const 空 = 畫面(袋("脳科学", { categoryNames: [] }));
    expect(空, "語の無い並べで空文を出した").not.toContain("分野の欄は");
    expect(空, "受皿の文が消えた").toContain("別の語で試す");
    expect(無, "渡さん語を並べた").not.toContain("分野の欄は");
    expect(無, "受皿の文が消えた").toContain("別の語で試す");
    // app が語を渡して居る證（渡しが切れると案内だけが古くなる – 第 215 回と同じ疵）。
    const 源 = readFileSync(join(REPO_ROOT, "site", "app.ts"), "utf8");
    expect(源, "app が分野の語を渡して居ん").toContain("categoryNames: categoryChipKeys(");
  });

  it("羣の斷りが當たる打ち手では二重に言はん", () => {
    /* 斷りを持つ側に同じ文を並べると、同じ話を二度讀む事になる（第 392 回の「目の字と
       聲が別のことを言はん」の裏 – 之は同じ事を二つ言ふ疵）。 */
    for (const 文 of 斷りの當たる打ち手) {
      const out = 畫面(袋(文));
      /* 斷りが當たるので、受皿の「別の語で試す…」は出ん（出たら同じ話を二度になる）。 */
      expect(out, `受皿に落ちた（斷りが當たらん）: ${文}`).not.toContain("別の語で試す");
      expect(out.split("この表が出すのは").length - 1, `受皿の文が二重に落ちた: ${文}`).toBe(0);
    }
  });
  it("案内が名指す欄とてびきは、ビルドした畫面に實物が在る（第 466 回）", () => {
    const 頁 = readFileSync(join(builtSite(), "index.html"), "utf8");
    for (const 字 of ["催し物", "締切", "分野", "種別", "開催地", "参加形式", "見方のてびき"])
      expect(頁, `畫面に無い物を受皿が言った: ${字}`).toContain(字);
  });
});

describe("讀み上げの句點（第 632 回）", () => {
  it("「。。」を並べん – 斷りが句點で終つても下に續く", () => {
    for (const 文 of 斷りの當たる打ち手.concat(受皿の打ち手)) {
      const out = 聲(袋(文));
      expect(out.includes("。。"), `句點が二つ並んだ: ${文} → ${out}`).toBe(false);
      expect(out.includes("。下に外せる条件"), `續きが落ちて讀み上げが途中で切れた: ${文}`).toBe(
        true,
      );
    }
  });
  it("受皿の短い讀み上げは 60 字以内（第 247 回）", () => {
    for (const 文 of 受皿の打ち手) {
      const out = 聲(袋(文));
      expect([...out].length, `讀み上げが ${[...out].length} 字: ${文}`).toBeLessThanOrEqual(60);
    }
  });
  it("搜の側は變はらん – 当たり行の出る打ち手は依然として出る", () => {
    const 當 = (文: string): number => {
      const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, 基準), 基準);
      return 品書.filter((r: { hay?: string }) => m(String(r.hay)) === true).length;
    };
    for (const 文 of ["セキュリティ", "ネットワーク", "研究会", "国内"])
      expect(當(文), `行が消えた: ${文}`).toBeGreaterThan(0);
  });
});
