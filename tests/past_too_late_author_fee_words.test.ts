/**
 * 「とっくに過ぎた」「もう間に合わない」「オーサーフィー」を、既に答へて居る家へ置く（第 635 回）。
 *
 * 實測 – 2026-08-09T00:00:00Z 生成の実ビルド（品書 3,280 行）で、案内の羣も打ち替えの候も
 * 出ん打ち手（候ゼロ 152 本 – 第 634 回で數へた內數）を並べ替へて見回した處、**答へは既に
 * 別の羣に書いて在つた** – 過ぎた締切が既定で除かれる話は羣 49、常時受付と過去の切替の話は
 * 羣 66、費用の欄が無い話は羣 16。缺けて居たのは其處に届く言い方だけで、之を六枚足した
 * （案内文は一本も書いて居らん – 一文字も新しい說明を増やさず導きだけ増した）。
 *
 * 之家違ひを張る（第 633 回の疵の再發防止） – 語が當たる斷りは一つだけ、他の家の斷片を含まん。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

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

/* [打ち手, 其の家が言ふ斷片, 他の家では無い證左] */
const 家族: Array<[string, string, string[]]> = [
  ["とっくに過ぎた", "過ぎた締切は既定で一覧から除いています", ["費用の欄", "当日の様子を書く欄"]],
  ["とっくに過ぎてる", "過ぎた締切は既定で一覧から除いています", ["常時受付"]],
  ["とっくに終わった", "過ぎた締切は既定で一覧から除いています", ["費用の欄"]],
  ["間に合わない", "終る日の決まつて居ない常時受付", ["過ぎた締切は既定で一覧から除いています"]],
  ["もう間に合わない", "終る日の決まつて居ない常時受付", ["費用の欄"]],
  ["オーサーフィー", "費用の欄はありません", ["常時受付", "当日の様子を書く欄"]],
  ["オーサーフィーはいくら", "費用の欄はありません", ["常時受付"]],
];

describe("過ぎた・間に合わん・著者費用の言い方（第 635 回）", () => {
  it("それぞれの家に着く – 斷りは一つだけ（之家違ひを張る）", () => {
    for (const [文, 家, 他] of 家族) {
      const out = 斷り(文);
      expect(out, `默つた: ${文}`).not.toBe("");
      expect(out, `${家} とは別の案内になつた: ${文} → ${out.slice(0, 40)}`).toContain(家);
      for (const 別 of 他) expect(out, `他の家の文が混じつた（${別}）: ${文}`).not.toContain(別);
      expect(当たり(文), `当たり行の出る打ち手: ${文}`).toBe(0);
    }
  });
  it("案内が名指す操作がビルドした畫面に實在る（第 466 回）", () => {
    const 頁 = readFileSync(join(builtSite(), "index.html"), "utf8");
    for (const 字 of ["過去の締切も表示", "常時受付", "締切まで"])
      expect(頁, `畫面に無い物を書いた: ${字}`).toContain(字);
  });
  it("讀み上げは 60 字以内（第 247 回）", () => {
    for (const [文] of 家族) {
      const 字 = [...短い(文)];
      expect(字.length, `讀み上げが ${字.length} 字: ${文}`).toBeLessThanOrEqual(60);
    }
  });
  it("搜の側は變はらん（第 362 回） – 同じ語で行が出る打ち手を讓す", () => {
    /* 羣に載せるのは品書 0 行の言い方だけ – 搜の語を潰して居らん事を實測の數で張る（第 362 回）。
       `締切` 2,886 行・`終了` 63 行（此の語は載せん – 行に出る）が舊來の侬通る事。 */
    expect(当たり("締切"), "締切は行が出る筈").toBeGreaterThan(2000);
    expect(当たり("終了"), "終了は羣に載せず搜に通す筈").toBe(63);
    /* 間に合ふ側の舊來の語は生きて居る（之家違ひで消えてはならん） */
    expect(斷り("まだ間に合う")).toContain("常時受付");
  });
});
