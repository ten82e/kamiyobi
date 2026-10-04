/** 訪ねの動詞で打たれた打ち方の檢査（SPEC §7・第 523 回）。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
type Row = { hay: string };
function 品書(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")),
  ) as Row[];
}
function 収録(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")),
  ) as Row[];
}
function 当たり(rows: Row[], 文: string): string[] {
  const m = Recommender.searchMatcher(文, AT);
  return rows.filter((r) => m(r.hay) === true).map((r) => String(r.hay).slice(0, 24));
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

/** 訪ねの語を落としたら、其れ無しの打ち方と全く同じ行が出るべき物。 */
const 組み: Array<[string, string]> = [
  ["採否が知りたい", "採否"],
  ["査読について知りたい", "査読"],
  ["発表を知りたい", "発表"],
  ["締切はいつありますか", "締切はいつ"],
  ["結果がわかる", "結果"],
];

describe("訪ねの動詞で打つ人", () => {
  it("其の方の打ち方と同じ行集合になる（品書）", () => {
    const rows = 品書();
    組み.forEach(([訪ね, 正]) => {
      expect(当たり(rows, 訪ね).sort(), `"${訪ね}" が "${正}" と違う行を出している`).toEqual(
        当たり(rows, 正).sort(),
      );
    });
  });

  it("収録でも同じ件數で、0 件では無い", () => {
    const rows = 収録();
    組み.forEach(([訪ね, 正]) => {
      expect(当たり(rows, 訪ね).length, `"${訪ね}" が 0 件`).toBeGreaterThan(0);
      expect(当たり(rows, 訪ね).length).toBe(当たり(rows, 正).length);
    });
  });

  it("表に無い事を訪ねた打ち方は、其の名を名乘つて斷る（第 388 回）", () => {
    (
      [
        ["ビザは知りたい", "ビザ"],
        ["費用は教えて", "費用"],
        ["参加費はあるの", "参加費"],
      ] as Array<[string, string]>
    ).forEach(([文, 頭]) => {
      const t = 案内(文);
      expect(t.length, `"${文}" が仍ほ無言（語尾が剥がれて居ない）`).toBeGreaterThan(0);
      expect(t.includes(頭), `"${文}": "${頭}" を名乘つて居ない`).toBe(true);
      expect(t.includes("持っていません"), `"${文}": 斷つて居ない`).toBe(true);
    });
  });

  it("訪ねの語だけで打たれたら品書全部を出さない（第 362 回）", () => {
    const rows = 品書();
    ["知りたい", "教えて", "あるの", "わかります"].forEach((文) => {
      expect(当たり(rows, 文), `"${文}" だけで ${rows.length} 行に出た`).toEqual([]);
    });
  });

  it("內容語になり得る語は落とさない（彈いた語尾 – 實測で行を持つ）", () => {
    const b = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
    const i = b.indexOf("const 訪ねの語かJa");
    expect(i, "落とす語の表が見つからない").toBeGreaterThan(0);
    const 域 = b.slice(i, b.indexOf("return seen;", i));
    ["あります", "なる", "いつ", "どこ"].forEach((語) => {
      expect(域.includes(`"${語}"`), `"${語}" を落とすやうになつた（靜かに廣がる）`).toBe(false);
    });
  });
});
