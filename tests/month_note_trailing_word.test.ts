import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";

describe("月の判定の注は、後ろに語が続いてもその月だけを名乗る", () => {
  const 今 = Date.parse("2026-10-17T08:00:00Z");
  it.each([
    ["2026年11月 セキュリティ", "2026年11月 = 2026年11月の締切（その月だけ"],
    ["来年3月 セキュリティ", "来年3月 = 2027年3月の締切（その月だけ"],
    ["2026年11月", "2026年11月 = 2026年11月の締切（その月だけ"],
  ])("「%s」", (文, 注) => {
    const 注々 = Recommender.relativeDayNotes(文, 今) as string[];
    expect(注々.join(" / ")).toContain(注);
    expect(注々.join(" / ")).not.toContain("1〜12 か月");
  });
  it("年だけの問いは今まで通り年全体", () => {
    expect((Recommender.relativeDayNotes("2026年 セキュリティ", 今) as string[]).join()).toContain(
      "2026年 = 2026年の締切（1〜12 か月）",
    );
  });
});
