/** 敬體で訪ねた人の案内の檢査（SPEC §7・第 521 回）。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";

/** 打ち込むと品書 0 件になる訪ね方（畫面は 0 件の時だけ案内を出す – 第 337 回）。 */
const 訪ね = [
  "費用はいつありますか",
  "参加費はいつありますか",
  "費用はありますか",
  "登録費はいつありますか",
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

describe("敬體で訪ねる人", () => {
  it("品書に行を含まない訪ねの語尾を足しても案内が出る", () => {
    訪ね.forEach((文) => {
      const t = 案内(文);
      expect(t.length, `"${文}" が仍ほ無言（語尾が剥がれて居ない）`).toBeGreaterThan(0);
      const 頭 = 文.replace(/は?.*$/, "");
      expect(t.includes(頭), `"${文}": 打ち込まれた語 "${頭}" を名乘つて居ない（第 388 回）`).toBe(
        true,
      );
    });
  });

  it("訪ねの語尾が**行を生ませる事は無い**（案内だけの追加 – 第 337 回）", () => {
    // 品書の字面に訪ねの語が現れない事を張る（出たら案内が噓になる）。
    const b = readFileSync("site/recommender.ts", "utf8");
    ["ありますか", "いつありますか"].forEach((語) => {
      const i = b.indexOf("const UI_WORD_TAILS_JA = [");
      expect(b.slice(i, i + 12000).includes(`"${語}"`), `"${語}" が語尾の表に無い`).toBe(true);
    });
  });

  it("其の方の形は從來の侭通る（語尾の追加で壊れて居ない）", () => {
    expect(案内("参加費はいくらですか").includes("参加費"), "從來の訪ね形が壞れた").toBe(true);
    expect(案内("使い方").length, "其處に終る打ち方が壞れた").toBeGreaterThan(0);
  });
});
