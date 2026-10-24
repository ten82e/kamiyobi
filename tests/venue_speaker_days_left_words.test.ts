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

/* [打ち手, その家が言う斷片, 他の家では無い證左] */
const 家族: Array<[string, string, string[]]> = [
  ["空港", "会場の中と外", ["費用の欄", "常時受付"]],
  ["空港からのアクセス", "会場の中と外", ["日付の欄の名前"]],
  ["演者", "著者や発表者の役", ["会場の中と外", "費用の欄"]],
  ["演者の案内", "著者や発表者の役", ["常時受付"]],
  ["あと何日", "曖昧な幅では絞り込めません", ["著者や発表者の役"]],
  ["あと何日ですか", "曖昧な幅では絞り込めません", ["会場の中と外"]],
];

describe("空港・演者・「あと何日」（第 636 回）", () => {
  it("それぞれの家に着く – 斷りは一つだけ（之家違ひを張る – 第 633 回）", () => {
    for (const [文, 家, 他] of 家族) {
      const out = 斷り(文);
      expect(out, `默つた: ${文}`).not.toBe("");
      expect(out, `${家} とは別の案内になつた: ${文} → ${out.slice(0, 40)}`).toContain(家);
      for (const 別 of 他) expect(out, `他の家の文が混じつた（${別}）: ${文}`).not.toContain(別);
      expect(当たり(文), `当たり行の出る打ち手: ${文}`).toBe(0);
    }
  });
  it("この羣に足した語の読み上げは 60 字以内（第 247 回）", () => {
    for (const [文] of 家族) {
      const 字 = [...短い(文)];
      expect(字.length, `讀み上げが ${字.length} 字: ${文}`).toBeLessThanOrEqual(60);
    }
  });
  it("案内が名指す画面の実物（第 466 回） – 『締切まで』の欄と『データ源』", () => {
    const 頁 = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    expect(斷り("あと何日")).toContain("締切まで");
    expect(頁, `画面にない物を書いた: 締切まで`).toContain("締切まで");
  });
});

describe("讓した所（実測の證左を検査に残す）", () => {
  it("`何が収録` を収録範囲の羣に載せん – 読み上げは六十字を通るやうにした（第 247 回→第 651 回）", () => {
    expect(当たり("何が収録"), "何が収録は検索で行が出ん筈").toBe(0);
    expect(String(Recommender.uiWordNoteJa("何が収録", false) || ""), "載つている？").not.toContain(
      "件数欄",
    );
    for (const 打ち方 of ["どこまで収録", "収録期間", "収録範囲"]) {
      const 字 = [...短い(打ち方)];
      expect(字.length, `この羣の讀み上げが條を越えた（${字.length} 字）`).toBeLessThanOrEqual(60);
    }
    expect(短い("収録期間")).toContain("検索では絞り込めません");
  });
  it("`更新履歴` は載せん – 画面に当たる実物を確かめられん（第 466 回）", () => {
    const 頁 = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    expect(当たり("更新履歴")).toBe(0);
    expect(頁, "画面に「更新履歴」の語があるならこの検査を見直す").not.toContain("更新履歴");
  });
});
