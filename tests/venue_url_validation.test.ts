import { expect, it } from "vitest";
import { siteRuntime } from "./runtime_extract.ts";

/* URL の `venue` に収録の無い鍵が来たら、絞り込みを外して断りを出す（2026-10-23 実測: 何もしないと
 * 「会議「zzz」以外の行 183 件」とだけ出て、鍵が無いのか条件が厳しいのか分からなかった）。
 * 実測: `?venue=zzz` は 183 件（既定の一覧）＋「リンクの会議「zzz」はこの一覧で使えない値なので、
 * 会議の絞り込みは外れています」。 */
it("URL の venue に収録の無い鍵が来たら、絞り込みを外して断る", () => {
  const app = siteRuntime();
  expect(app, "収録の鍵と突き合わせていない").toContain("収録の鍵.has(rawVenue)");
  expect(app, "断りを出していない").toContain(
    'urlValueNoticeJa("会議", rawVenue, "会議の絞り込みは外れています")',
  );
  /* 収録に在る鍵は、これまでどおり絞り込む（検証で落とさない）。 */
  expect(app, "収録の鍵まで外している").toContain(
    'state.venue = rawVenue && 収録の鍵.has(rawVenue) ? rawVenue : ""',
  );
});
