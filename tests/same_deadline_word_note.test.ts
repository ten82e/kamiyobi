import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 件(語: string): number {
  const 品書 = Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
  ) as unknown as Array<{ hay: string }>;
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(語, 基準), 基準);
  return 品書.filter((行) => 照合(String(行.hay)) === true).length;
}

describe("締切が同じ会議（第 724 回）", () => {
  it("三つの打ち方が、どれも同じ斷りを受ける", () => {
    for (const 語 of ["締切が同じ会議", "同じ締切の会議", "締切が同じ"]) {
      expect(件(語), `行が出た: ${語}`).toBe(0);
      const 文 = String(Recommender.uiWordNoteJa(語, false) || "");
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `代はりの道を言つて居ん: ${語}`).toContain(
        "同じ日に重なった行は並びの中で隣り合います",
      );
    }
    /* 読み上げは六十字まで。 */
    for (const 語 of ["締切が同じ会議", "同じ締切の会議", "締切が同じ"]) {
      const 聲 = String(Recommender.uiWordLiveNoteJa(語) || "");
      expect(聲, `讀み上げが無い: ${語}`).not.toBe("");
      expect([...聲].length, `讀み上げが長い: ${語}`).toBeLessThanOrEqual(60);
    }
  });

  it("元からいる語の扱ひを変へて居ない", () => {
    expect(件("締切が重なる会議"), "行が出た").toBe(0);
    expect(String(Recommender.uiWordNoteJa("締切が重なる会議", false) || "")).toContain(
      "同じ日に重なった行は並びの中で隣り合います",
    );
    /* 行が出る語には斷りを付けない。 */
    for (const 語 of ["会期", "論文締切"]) {
      expect(件(語), `前提が崩れた: ${語}`).toBeGreaterThan(0);
      expect(String(Recommender.uiWordNoteJa(語, false) || ""), `斷りを付けた: ${語}`).toBe("");
    }
  });
});
