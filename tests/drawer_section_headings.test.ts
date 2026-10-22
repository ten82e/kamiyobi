import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { siteRuntime } from "./runtime_extract.ts";

/* 行の詳細（ダイアログ）の節の名は見出し要素にする。読み上げで「会議名（h2）→ 節（h3）」と
 * 飛べるようにするため。2026-10-22 実測: 「投稿日程（この開催回）」は前から h3 だったが、
 * 一番上の「種別・日時」だけが div だった（見た目は同じ灰色の小さな字なので、目では気づかない）。 */
describe("行の詳細の節の名（第 37 回）", () => {
  const app = siteRuntime();
  const template = readFileSync(join(import.meta.dirname, "..", "site", "template.html"), "utf8");

  it("「種別・日時」は h3（見た目は drawer-label クラスで前のまま）", () => {
    expect(app, "種別・日時の節の名が div のまま").toContain(
      '<h3 class="drawer-label">種別・日時</h3>',
    );
    expect(app, "種別・日時の節の名が div のまま").not.toContain('">種別・日時</div>');
    expect(template, "drawer-label の見た目が無い").toContain(".drawer-label {");
  });

  it("「投稿日程」の節の名も h3", () => {
    expect(app, "投稿日程の見出しが h3 でない").toContain(
      'heading.textContent = r.submission ? "投稿日程（この特集号）" : "投稿日程（この開催回）";',
    );
    expect(app, "投稿日程の見出しが h3 でない").toContain('document.createElement("h3")');
  });
});
