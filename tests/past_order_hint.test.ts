import { expect, it } from "vitest";
import { siteRuntime } from "./runtime_extract.ts";

it("過去の締切を昇順で並べた時は、古い順だと言い、直近から見る手を件数欄に書く", () => {
  const app = siteRuntime();
  const 文 = "過ぎた締切は古い順です（直近から見るには「残り」の見出しを押して降順に）";
  const at = app.indexOf(文);
  expect(at, "件数欄の手の文が無い").toBeGreaterThan(0);
  // 昇順で「残り」か「日時」を見ている時だけ（降順では直近が既に先頭にある）。
  const 前 = app.slice(Math.max(0, at - 800), at);
  expect(前).toMatch(
    /if \(sortAsc && \(!sortKey \|\| sortKey === "rem" \|\| sortKey === "date"\)\)/,
  );
  // これからの締切が無く、過ぎた締切だけの一覧（`NSDI` で過去を表示）でも出る。
  expect(前).toContain("pastBlockTotal < shown.length");
  expect(app).toContain("if (!recMode && pastBlockTotal > 0) {");
});
