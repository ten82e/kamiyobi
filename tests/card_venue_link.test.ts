import { expect, it } from "vitest";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

/* 推薦のカードから、その会議の締切を締切の一覧で開ける（2026-10-23 実測: RTSS のカードから
 * `?venue=rtss&past=1` を開くと、RTSS の 7 行が出た）。検索語ではなく会議の鍵で絞るので、
 * 同じ語を含む別の会議は混ざらない。締切が過ぎた候補は既定の一覧に行が無いので、過去も
 * 出す条件を添える（押した先が空にならない）。 */
it("推薦のカードから、その会議の締切だけの一覧を開ける", () => {
  const app = siteRuntime();
  const src = jsFunction(app, "makeRecommendationCard");
  expect(src, "カードに一覧への導線が無い").toContain("この会議の締切を一覧で見る");
  expect(src, "会議の鍵で絞っていない（検索語だと別の会議も混ざる）").toContain("?venue=");
  expect(src, "締切が過ぎた候補に過去の条件を添えていない").toContain('"&past=1"');
  expect(src, "過ぎたかどうかを見ていない").toContain('_availability?.status === "past"');
});
