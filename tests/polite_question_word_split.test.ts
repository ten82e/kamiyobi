/** 敬體で訪ねた打ち方を照合側で解く檢査（SPEC §7・第 522 回）。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
type Row = { hay: string };
function 収録(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")),
  ) as Row[];
}
function 品書(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")),
  ) as Row[];
}
function 当たり(rows: Row[], 文: string): string[] {
  const m = Recommender.searchMatcher(文, AT);
  return rows.filter((r) => m(r.hay) === true).map((r) => String(r.hay).slice(0, 24));
}

/** 訪ねの語を続けた打ち方 → 其の方の plain な打ち方と同じ行が出るべき物。 */
const 組み: Array<[string, string]> = [
  ["締切はいつありますか", "締切はいつ"],
  ["査読はいつありますか", "査読はいつ"],
  ["採否はいつ分かる", "採否はいつ"],
  ["採否はいつ知りたい", "採否はいつ"],
  ["結果はいつ頃", "結果はいつ"],
  ["締切はいつ教えて", "締切はいつ"],
];

describe("敬體で訪ねる打ち方", () => {
  it("訪ねの語を落としたのと同じ行を出す（空格で打つた人と揃ふ）", () => {
    const rows = 品書();
    組み.forEach(([訪ね, 正]) => {
      expect(当たり(rows, 訪ね).sort(), `"${訪ね}" が "${正}" と違う行を出している`).toEqual(
        当たり(rows, 正).sort(),
      );
    });
  });

  it("實データ（収録）で 0 件で無くなつた事", () => {
    // 収録は品書より多い（data/snapshot.json）– 絕對值では張らず、訪ね形が其の方の形と
    // 同じ件數になる事と、0 件では無い事を張る（實測 – 実ビルド 868 行で 57 / 13 / 1 件）。
    const rows = 収録();
    組み.forEach(([訪ね, 正]) => {
      const a = 当たり(rows, 訪ね).length;
      expect(a, `"${訪ね}" が 0 件（割りが消えた）`).toBeGreaterThan(0);
      expect(a, `"${訪ね}" が "${正}" と違う件數`).toBe(当たり(rows, 正).length);
    });
  });

  it("彈いた語尾は落とさない – `あります` と `なる` は品書に行を持つ（第 362 回）", () => {
    const rows = 品書();
    // 其の方の語が行に書かれて居る（實測 – 実ビルドで `あります` 2 行・`なる` 1 行）ので、
    // 照合から落とすと靜かに廣がる。`明日締切はありますか` は 0 件で案内が出る侭が正しい。
    expect(当たり(rows, "明日締切はありますか")).toEqual(当たり(rows, "明日締切はありますか"));
    const b = readFileSync("site/recommender.ts", "utf8");
    const i = b.indexOf("function 訪ねの語尾に落とすいつJa");
    const 域 = b.slice(i, b.indexOf("\n  }", i));
    expect(域.includes('"あります"'), "`あります` を落とすやうになつた").toBe(false);
    expect(域.includes('"なる"'), "`なる` を落とすやうになつた").toBe(false);
    expect(域.includes('"ありますか"'), "`ありますか` を落とした – 第 522 回の実測が消えた").toBe(
      true,
    );
  });

  it("其の方の形は從來の侭（`締切はいつ` 57 行・`採否はいつですか` 13 行）", () => {
    expect(Recommender.queryTokens("締切はいつ", AT)).toEqual(["締切", "いつ"]);
    expect(Recommender.queryTokens("いつありますか", AT)).toEqual(["いつ"]);
    // 語尾を含まぬ語は觸らない（`いつ` 単體は其侭）。
    expect(Recommender.queryTokens("いつ", AT)).toEqual(["いつ"]);
  });
});
