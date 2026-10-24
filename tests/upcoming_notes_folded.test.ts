import { expect, it } from "vitest";
import { toUpcomingHtml } from "../src/build.ts";

it("直近の一覧は生成時刻と対象期間だけを見せ、列の意味と但し書きを一つに畳んで表を先に出す", () => {
  const md = [
    "# 直近 180 日の締切と開催",
    "",
    "> 生成時刻: 2026-08-09T00:00:00Z",
    "> 対象期間: 2026-08-09 〜 2027-02-05",
    "> 日付列は締切の公式表記をそのまま載せる。",
    "",
    "> 列の意味: 「残り」は生成時刻からの残り。",
    "> 「AoE」は UTC-12 の時刻で締める締切です。",
    "",
    "| 日付 | 会議 |",
    "| --- | --- |",
    "| 2026-08-10 | DEMO 2026 |",
  ].join("\n");
  const html = toUpcomingHtml(md);
  const 畳み = html.match(/<details class="upcoming-notes">[\s\S]*?<\/details>/g) ?? [];
  // 引用の塊が二つあっても畳みは一つ。
  expect(畳み).toHaveLength(1);
  expect(畳み[0]).toContain("列の意味と但し書き");
  for (const 文 of ["日付列は締切の公式表記", "「残り」は生成時刻からの残り", "UTC-12"])
    expect(畳み[0], `但し書きが畳みに入っていない: ${文}`).toContain(文);
  // 生成時刻と対象期間は畳まずに見せる。
  expect(畳み[0]).not.toContain("生成時刻:");
  expect(畳み[0]).not.toContain("対象期間:");
  const 見える = html.replace(String(畳み[0]), "");
  expect(見える).toContain("生成時刻: 2026-08-09T00:00:00Z");
  expect(見える).toContain("対象期間: 2026-08-09");
  // 畳みは表より前（列の意味は表のうえにある – 表の caption と同じ約束）。
  expect(html.indexOf("upcoming-notes")).toBeLessThan(html.indexOf('id="upcoming-table"'));
});
