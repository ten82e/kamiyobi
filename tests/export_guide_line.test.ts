import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";

/* 2026-10-18 – 研究者役の試しで、書き出しのボタンが 5 つ並ぶ中から「カレンダーに入れたい」の 1 つを
 * 選べなかった。名前は検査と画面の説明に固定されているので、押す前に違いを言う一行を添える。 */
it("書き出しのボタンの前に、カレンダーに入れる 2 通りと表計算・JSON の使い分けを一行で言う", () => {
  const html = readFileSync(join(site, "index.html"), "utf8");
  const guide = /<span id="exportGuide"[^>]*>([\s\S]*?)<\/span>/.exec(html);
  expect(guide, "案内の行が無い").not.toBeNull();
  const text = String(guide?.[1]);
  for (const label of [
    "カレンダー（.ics）でダウンロード",
    "カレンダーに追加（.ics）",
    "購読 URL をコピー",
    "CSV",
    "JSON",
  ])
    expect(text, `案内に「${label}」が無い`).toContain(label);
  expect(html.indexOf('id="exportGuide"'), "案内がボタンの後ろにある").toBeLessThan(
    html.indexOf('id="exportCsv"'),
  );
  /* 案内の行はボタンと同じ条件で出す（行の無い画面に案内だけ残さない）。 */
  const app = readFileSync(join(site, "app.js"), "utf8");
  expect(app).toMatch(/exportGuide\.hidden = exportBtn\.hidden/);
});
