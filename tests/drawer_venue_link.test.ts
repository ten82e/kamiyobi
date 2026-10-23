import { expect, it } from "vitest";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

/* 行の詳細から、その会議の行だけを一覧で見られるようにする（2026-10-23 実測: 押すと検索欄に
 * `sigmod` が入り 3 件に絞られた）。会議の識別子（key）は、AI に頼むときにも使える
 * （MCP の venue_info の key）ので、押す所の文字にも入れる。 */
it("行の詳細に、その会議の行だけを見る導線と識別子がある", () => {
  const app = siteRuntime();
  const src = jsFunction(app, "renderDrawerRowActions");
  /* 型を落とした形で渡ってくるので、値の部分だけで見る。 */
  expect(src, "会議の識別子を押す所の文字に入れていない").toContain("この会議（");
  expect(src, "識別子を文字に入れていない").toContain("key");
  expect(src, "検索の URL を組んでいない").toContain("all.href = " + "`?q=");
  expect(src, "AI に渡す識別子だと書いていない").toContain("venue_info の key");
  /* カレンダーのボタンは、予定にできる行だけ（日付だけの行では出さない）。 */
  expect(src, "カレンダーのボタンを無条件に出している").toContain("if (icsInputForRow(r)) {");
  expect(src, "会議の識別子が空でもリンクを出す").toContain("if (key) {");
});
