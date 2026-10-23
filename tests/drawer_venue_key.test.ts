import { expect, it } from "vitest";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

/* 行の詳細に、AI に渡す会議の識別子（key）と、その会議の行だけに絞った一覧への導線を出す。
 * 導線は検索語（`?q=`）ではなく `?venue=<key>` を使う – 検索は語の一致で引くので、短い識別子
 * （`chi`・`sc`）だと別の会議まで当たる（2026-10-23 実測: `chi` は 70 会場）。 */
it("行の詳細は、識別子と、その会議だけの一覧への導線を出す", () => {
  const app = siteRuntime();
  const src = jsFunction(app, "renderDrawerRowActions");
  expect(src, "識別子を出していない").toContain("会議の識別子: ");
  expect(src, "AI に渡す値だと書いていない").toContain("venue_info の key");
  expect(src, "導線が検索語（別の会議まで当たる）").not.toContain("?q=");
  expect(src, "導線が会議の鍵で絞っていない").toContain("?venue=");
  /* カレンダーのボタンは、予定にできる行だけ（日付だけの行では出さない）。 */
  expect(src, "カレンダーのボタンを無条件に出している").toContain("if (icsInputForRow(r)) {");
  expect(src, "会議の識別子が空でも出す").toContain("if (key) {");
});
