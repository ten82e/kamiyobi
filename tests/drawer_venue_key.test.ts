import { expect, it } from "vitest";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

/* 行の詳細に、AI に渡す会議の識別子（key）を出す。押せるリンクにはしない – 検索は語の一致で
 * 引くので、短い識別子（`chi`・`sc`）だと別の会議まで当たる（2026-10-23 実測: `chi` は 70 会場、
 * `sc` は 7 会場）。「この会議だけ」を正確に絞る URL はまだ無い。 */
it("行の詳細は、会議の識別子を文字で出す（一覧へのリンクにはしない）", () => {
  const app = siteRuntime();
  const src = jsFunction(app, "renderDrawerRowActions");
  expect(src, "識別子を出していない").toContain("会議の識別子: ");
  expect(src, "AI に渡す値だと書いていない").toContain("venue_info の key");
  expect(src, "識別子を一覧へのリンクにしている（短い識別子で別の会議まで当たる）").not.toContain(
    "?q=",
  );
  /* カレンダーのボタンは、予定にできる行だけ（日付だけの行では出さない）。 */
  expect(src, "カレンダーのボタンを無条件に出している").toContain("if (icsInputForRow(r)) {");
  expect(src, "会議の識別子が空でも出す").toContain("if (key) {");
});
