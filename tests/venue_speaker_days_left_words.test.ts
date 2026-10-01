/**
 * 空港・演者・「あと何日」を、既に答へて居る家へ足す（第 636 回）。
 *
 * 實測 – 2026-08-09T00:00:00Z 生成の実ビルド（品書 3,280 行）で `空港`（0 行）`演者`（0 行）
 * `あと何日`（0 行）は畫面の導きが無く、其れぞれ會場まわり・著者の役・曖昧な幅の答へが既に
 * 別の羣に書いて在つた – 案内文は一文字も增やさず、言い方三枚だけを足した（第 635 回と同じ型）。
 *
 * 讓した所も張る（今後の為に – 之が此の回の実驗の一部である）
 *  - `何が収録`（0 行 – 通れば六本目）は讓した。實測 – 其の羣の讀み上げは `収録範囲` で既に
 *    **六十二字**、`どこまで収録` は**六十四字**（第 247 回の條を越して居る）で、五文字の語を
 *    足すと其れ以上になる。讀み上げを縮める試みは落ちた – `tests/meta_query_note.test.ts` が
 *    「検索では絞り込めません」を聲に張つて居て（搜で絞れん事を聲でも傳へる – 視覚に頼れん人は
 *    畫の文を読まん）、聲から落とす道は無い。
 *  - `更新履歴`（0 行）も讓した – 画面に「更新履歴」に當たる實物が在るかを確かめられなかつた
 *    （第 466 回 – 畫面に在る物だけを名指す）。
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

/* [打ち手, 其の家が言ふ斷片, 他の家では無い證左] */
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
  it("この羣に足した語の讀み上げは 60 字以内（第 247 回）", () => {
    for (const [文] of 家族) {
      const 字 = [...短い(文)];
      expect(字.length, `讀み上げが ${字.length} 字: ${文}`).toBeLessThanOrEqual(60);
    }
  });
  it("案内が名指す畫面の實物（第 466 回） – 『締切まで』の欄と『データ源』", () => {
    const 頁 = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    expect(斷り("あと何日")).toContain("締切まで");
    expect(頁, `畫面に無い物を書いた: 締切まで`).toContain("締切まで");
  });
});

describe("讓した所（實測の證左を檢査に残す）", () => {
  it("`何が収録` を收錄範囲の羣に載せん – 讀み上げが既に條を越して居る（第 247 回）", () => {
    /* 五文字の語を足すと其の羣の讀み上げは六十二字を越す。聲を縮める道は
       `tests/meta_query_note.test.ts` が塞いで居る（搜で絞れん事を聲でも傳へる決まり）。 */
    expect(当たり("何が収録"), "何が収録は搜で行が出ん筈").toBe(0);
    expect(String(Recommender.uiWordNoteJa("何が収録", false) || ""), "載つて居る？").not.toContain(
      "件数欄",
    );
    const 字 = [...短い("どこまで収録")];
    expect(字.length, `この羣の讀み上げが想定と變はつた（${字.length} 字）`).toBeGreaterThan(60);
    expect(短い("収録期間")).toContain("検索では絞り込めません");
  });
  it("`更新履歴` は載せん – 畫面に當たる實物を確かめられん（第 466 回）", () => {
    const 頁 = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    expect(当たり("更新履歴")).toBe(0);
    expect(頁, "畫面に「更新履歴」の語が在るなら此の檢査を見直す").not.toContain("更新履歴");
  });
});
