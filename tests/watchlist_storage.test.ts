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
  /* 一覧には次の締切を並べる（★ を付けた理由がその場で分かる）。読み込み済みの行から見るので、
   * 過ぎた締切しか無い会議は「今後の締切なし」と書く（推測で日付を作らない）。 */
  expect(render, "次の締切を出していない").toContain("次回 ");
  expect(render, "無いときに推測しない").toContain("今後の締切なし");
  /* 名前は行ではなく会議の名簿（収録の全 696 件）から引く — 締切が過ぎた会議は行が無く、
   * 行から引くと鍵（`rtss`）がそのまま出る（2026-10-23 実測）。 */
  expect(app, "名前を会議の名簿から引いていない").toContain(
    "DATA.conferences || []).find((c) => c.key === key)",
  );

  /* URL には載せない（状態は保存だけ）。 */
  const write = jsFunction(app, "writeUrl");
  expect(write, "★ を URL に載せている").not.toContain("watch");
});
