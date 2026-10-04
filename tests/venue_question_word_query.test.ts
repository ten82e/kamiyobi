/** 会場を別の言い方・訪ね方で打った人の檢査（SPEC §7・第 524 回）。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";

/** 打ち込むと品書 0 件になる訪ね方（畫面は 0 件の時だけ案内を出す – 第 337 回）。 */
const 訪ね: Array<[string, string]> = [
  ["会場はどこ", "会場"],
  ["会場はどこですか", "会場"],
  ["会場は", "会場"],
  ["会場どこ", "会場"],
  ["会場はどこにありますか", "会場"],
  ["開催地はどこ", "会場"],
  ["場所", "場所"],
  ["開催場所", "開催場所"],
  ["会議場", "会議場"],
  ["種別はどれ", "種別"],
  ["分野はどこ", "分野"],
  ["日付はいつ", ""],
];

function 案内(語: string): string {
  return [
    Recommender.columnQueryNoteJa(語),
    Recommender.uiWordNoteJa(語),
    Recommender.dayRangeNoteJa(語),
    Recommender.wholeTableQueryNoteJa(語),
    ...Recommender.querySynonymNotes(語),
  ]
    .filter(Boolean)
    .join(" ∥ ");
}

describe("会場を別の言い方で訪ねる人", () => {
  it("案内が打ち込まれた語を名乘る（第 388 回）", () => {
    訪ね.forEach(([文, 頭]) => {
      const t = 案内(文);
      if (!頭) return;
      expect(t.length, `"${文}" が仍ほ無言（問ひの語が剥がれて居ない）`).toBeGreaterThan(0);
      expect(t.includes(`「${頭}」`), `"${文}": 打ち込まれた語 "${頭}" を名乘つて居ない`).toBe(
        true,
      );
    });
  });

  it("其の方で 0 件の訪ね形が斷りに就いた（無言の殘りを增やさない）", () => {
    (["会場はどこ", "場所", "開催場所", "会議場", "種別はどれ"] as string[]).forEach((文) => {
      expect(案内(文).includes("値で打ってください"), `"${文}" が値の語を促して居ない`).toBe(true);
    });
  });

  it("行が出る打ち方を案内で邪魔しない（第 337 回）", () => {
    // `締切はいつ` は其侭 行が出る（`いつ` は幅の語で、落とす語尾の一覽に置いて居ない）。
    const b = readFileSync("site/recommender.ts", "utf8");
    const i = b.indexOf("const 剥ぐ語尾 = [");
    const 域 = b.slice(i, b.indexOf("\n    ];", i));
    expect(域.includes('"いつ"'), "`いつ` を剥ぐやうになつた – 幅の語を落とす事になる").toBe(false);
    expect(域.includes('"あります"'), "`あります` を剥ぐやうになつた – 品書 2 行の內容語").toBe(
      false,
    );
    expect(Recommender.queryTokens("締切はいつ", Date.parse("2026-08-09T00:00:00Z"))).toEqual([
      "締切",
      "いつ",
    ]);
  });
});
