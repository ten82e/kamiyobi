import { readFileSync } from "node:fs";
import { join } from "node:path";
/** 英語の機械語とバリアフリーを訪ねる打ち方の檢査（SPEC §7・第 525 回）。 */
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
type Row = { hay: string };
function 品書(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")),
  ) as Row[];
}
function 件(rows: Row[], 文: string): number {
  const m = Recommender.searchMatcher(文, AT);
  return rows.filter((r) => m(r.hay) === true).length;
}
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

/** 表が持つ欄の外のこと – 寄せない語（第 518 回・第 525 回の決まり）。
 * 分野『システム』『機械学習』へ寄せると實測で 256 件・542 件に靜かに廣がるので彈いた
 *（第 525 回 – 自分は之を足さうとして四本の檢査に止められた。教訓は SPEC §8 の同條に置く）。*/
const 寄せない = ["GPU", "CUDA", "Kubernetes", "CTF", "推薦システム", "レコメンド"];

/** 0 件の侭斷りが出る打ち方（會場の費用とバリアフリー – 第 525 回）。 */
const 訪ね = [
  "アクセシビリティ",
  "バリアフリー",
  "車椅子",
  "車いす",
  "手話",
  "字幕",
  "accessibility",
  "wheelchair",
  "会場費",
  "懇親会費",
];

describe("英語の機械語とバリアフリー", () => {
  it("英語の機械語は寄せない – 0 件の侭（靜かに廣げない決まり）", () => {
    const rows = 品書();
    寄せない.forEach((文) => {
      expect(件(rows, 文), `"${文}" に行が届いた（分野への寄せは數百件の廣がり）`).toBe(0);
    });
  });

  it("其の他で行が 0 件の時だけ斷る（其の方で行が出る語を入れない – 第 337 回）", () => {
    const rows = 品書();
    訪ね.forEach((文) => {
      expect(件(rows, 文), `"${文}" が行に出る（斷るのは噓になる）`).toBe(0);
      const t = 案内(文);
      expect(t.length, `"${文}" が無言`).toBeGreaterThan(0);
      expect(t.includes("持っていません"), `"${文}": 欄が無いと斷つて居ない`).toBe(true);
      expect(t.includes(文), `"${文}": 打ち込まれた語を名乘つて居ない`).toBe(true);
    });
  });

  it("寄せの先は品書に實在する語（第 322 回）", () => {
    const rows = 品書();
    ["システム", "セキュリティ", "機械学習"].forEach((語) => {
      expect(件(rows, 語), `寄せ先の "${語}" が品書に無い`).toBeGreaterThan(0);
    });
  });
});
