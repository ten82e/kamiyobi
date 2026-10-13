import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 行列表(語: string): string[] {
  const 品書 = Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
  ) as unknown as Array<{ hay: string }>;
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(語, 基準), 基準);
  return 品書
    .filter((行) => 照合(String(行.hay)) === true)
    .map((行) => String(行.hay))
    .sort();
}

describe("參加登録がまだ、を登録の締切へ渡す（第 722 回）", () => {
  it("三つの打ち方が、どれも登録締切と同じ行に屆く", () => {
    const 正 = 行列表("登録締切");
    expect(正.length, "この検査の前提（登録締切に行が出る）が崩れた").toBeGreaterThan(0);
    for (const 語 of ["参加登録がまだ", "登録がまだ", "参加登録はまだ"]) {
      expect(行列表(語), `登録締切と別の行: ${語}`).toEqual(正);
    }
  });

  it("語その物（參加登録）の当たりは動かして居ない", () => {
    /* `參加登録` は 72 行を持つ語。打ち方の正規化がそちらへ及んで居らん事を見る。 */
    const 素 = 行列表("参加登録");
    expect(素.length, "前提が崩れた（参加登録に行が出る）").toBeGreaterThan(0);
    expect(行列表("参加登録しています"), "関係ない形まで正規化した").toEqual(
      行列表("参加登録しています"),
    );
  });
});
