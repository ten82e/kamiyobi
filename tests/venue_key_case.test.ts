import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";

/* 画面の札も件数欄も `SIGMOD`（大文字）と出す。URL の `venue` は小文字の鍵しか受け付けず、
 * `?venue=SIGMOD` は絞り込みが黙って外れていた（2026-10-24 実測: 175 件・札なし）。 */
describe("URL の venue の鍵は、大文字小文字を問わずに受ける", () => {
  const keys = ["sigmod", "icse", "chi"];
  it("小文字・大文字・混在のどれでも、収録の鍵に正規化する", () => {
    expect(Recommender.venueKeyFromInput("sigmod", keys)).toBe("sigmod");
    expect(Recommender.venueKeyFromInput("SIGMOD", keys)).toBe("sigmod");
    expect(Recommender.venueKeyFromInput("Sigmod", keys)).toBe("sigmod");
  });
  it("収録に無い鍵・空は空文字（絞り込みを外す）", () => {
    expect(Recommender.venueKeyFromInput("zzz", keys)).toBe("");
    expect(Recommender.venueKeyFromInput("", keys)).toBe("");
    expect(Recommender.venueKeyFromInput("  ", keys)).toBe("");
  });
  it("前後の空白は落とす", () => {
    expect(Recommender.venueKeyFromInput("  icse ", keys)).toBe("icse");
  });
});
