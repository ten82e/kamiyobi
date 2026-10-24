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

/* [打ち手, その家が言う斷片, 他の家では無い證左] */
const 家族: Array<[string, string, string[]]> = [
  ["とっくに過ぎた", "過ぎた締切は既定で一覧から除いています", ["費用の欄", "当日の様子を書く欄"]],
  ["とっくに過ぎてる", "過ぎた締切は既定で一覧から除いています", ["常時受付"]],
  ["とっくに終わった", "過ぎた締切は既定で一覧から除いています", ["費用の欄"]],
  ["間に合わない", "『常時受付』を選んで探せます", ["過ぎた締切は既定で一覧から除いています"]],
  ["もう間に合わない", "『常時受付』を選んで探せます", ["費用の欄"]],
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
  it("案内が名指す操作がビルドした画面に実ある（第 466 回）", () => {
    const 頁 = readFileSync(join(builtSite(), "index.html"), "utf8");
    for (const 字 of ["過去の締切も表示", "常時受付", "締切まで"])
      expect(頁, `畫面に無い物を書いた: ${字}`).toContain(字);
  });
  it("読み上げは 60 字以内（第 247 回）", () => {
    for (const [文] of 家族) {
      const 字 = [...短い(文)];
      expect(字.length, `讀み上げが ${字.length} 字: ${文}`).toBeLessThanOrEqual(60);
    }
  });
  it("検索の側は変はらん（第 362 回） – 同じ語で行が出る打ち手を讓す", () => {
    expect(当たり("締切"), "締切は行が出る筈").toBeGreaterThan(2000);
    expect(当たり("終了"), "終了は羣に載せず検索に通す筈").toBe(63);
    /* 間に合ふ側の旧來の語は生きている（之家違ひで消えてはならん） */
    expect(斷り("まだ間に合う")).toContain("常時受付");
  });
});
