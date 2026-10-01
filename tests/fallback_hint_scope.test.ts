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
