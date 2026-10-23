import { expect, it } from "vitest";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

/* ★ を付けた会議は、この端末にだけ覚える（共有 URL には載せない – 何を見たいかは人ごとに違い、
 * URL に載せると他人の ★ が自分の一覧に混ざる）。値は会議の鍵で、`?venue=` にそのまま渡せる。
 * 2026-10-23 実測: ★ を付けるとパネルに「SIGMOD → ?venue=sigmod」が出て、× で消える。 */
it("★ はこの端末にだけ覚え、会議の鍵で一覧へ渡す", () => {
  const app = siteRuntime();
  expect(app, "保存先が localStorage でない").toContain("window.localStorage.setItem(WATCH_KEY");
  expect(app, "この端末だけだと書いていない").toContain("この端末");
  const render = jsFunction(app, "renderWatchPanel");
  expect(render, "一覧へのリンクが会議の鍵でない").toContain("?venue=");
  expect(render, "× で外せない").toContain("filter((k) => k !== key)");
  const actions = jsFunction(app, "renderDrawerRowActions");
  expect(actions, "行の詳細に ★ が無い").toContain("★ ");
  expect(actions, "★ を付け外しできない").toContain("now.includes(key)");
  /* URL には載せない（状態は保存だけ）。 */
  const write = jsFunction(app, "writeUrl");
  expect(write, "★ を URL に載せている").not.toContain("watch");
});
