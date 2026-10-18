import { expect, it } from "vitest";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

/* 絞りの内訳（何件をのぞいたか）は、絞った時にこそ読む物。以前は検索語があるときと 0 件の
 * ときにしか件数欄を開いていなかったので、ランクや期間だけを選ぶと「41 件」だけが見えて、
 * のぞいた 142 件の話は畳まれた中に在った（2026-10-18 実測）。 */
it("絞り込みを入れたら、件数欄を開いて「のぞいた数」を読める", () => {
  const app = siteRuntime();
  const 判定 = new Function("state", `return (${jsFunction(app, "deadlineFiltersOnJa")})();`) as (
    state: Record<string, unknown>,
  ) => boolean;
  const 素 = {
    q: "",
    kind: "",
    rank: "",
    cats: [],
    domestic: false,
    online: false,
    est: false,
    past: false,
    win: "all",
  };
  expect(判定({ ...素 }), "絞っていないのに開く").toBe(false);
  /* 一つずつ入れて、どれでも開く事を見る（條件を足したときに片方だけ直す事故を防ぐ）。 */
  for (const [名, 値] of [
    ["kind", "paper"],
    ["rank", "A*"],
    ["cats", ["security"]],
    ["domestic", true],
    ["online", true],
    ["est", true],
    ["past", true],
    ["win", "7d"],
  ] as Array<[string, unknown]>) {
    expect(判定({ ...素, [名]: 値 }), `${名} を入れても開かない`).toBe(true);
  }
  /* 論文を入れているときは、合う行の数も件数欄と紙に書く（行ごとの札だけでは、一覧の
   * どこに何行あるかは分からない）。数えるのは締切の一覧の枝だけ。 */
  expect(app, "件数欄に合う行の数を書いていない").toContain("この論文に合う行");
  expect(app, "合う行の数を数えていない").toContain("recommendFitMatches = 一致.length;");
  expect(app, "合う行が在っても件数欄を開かない").toContain("recommendFitMatches > 0");

  /* 画面の組み立ても、この判定を通して開いている（条件を書き写していない）。 */
  expect(app, "件数欄の開閉が判定を通していない").toContain(
    '(state.mode === "deadlines" && (deadlineFiltersOnJa() || recommendFitMatches > 0))',
  );
  expect(app, "0 件のときに開かない").toContain("shown.length === 0 ||");
  expect(app, "検索語があるときに開かない").toContain("Boolean(state.q.trim()) ||");
});
