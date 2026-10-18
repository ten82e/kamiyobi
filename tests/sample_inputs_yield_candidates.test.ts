import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

/* 「入力の例」は、押した人がその場で候補を見られる事が仕事（0 件だと壊れて見える）。
 * リード文は HPC・AI・HCI も挙げているので、その分野の例も置いてある（2026-10-18）。
 * 例ごとに、候補が出る事と、例が名指す掲載先が収録に当たる事を見る。 */
it("入力の例はどれも候補が出て、名指す掲載先も収録に当たる", () => {
  const site = builtSite();
  const html = readFileSync(join(site, "index.html"), "utf8");
  const 例 = [...html.matchAll(/data-sample="([^"]+)"/g)].map((m) => String(m[1]));
  expect(例.length, "入力の例が少なすぎる（検査が空振り）").toBeGreaterThanOrEqual(5);
  const catalog = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
    typeof Recommender.candidateRows
  >[0] & { conferences: Parameters<typeof Recommender.candidatePool>[1] };
  const rows = Recommender.candidateRows(catalog);
  const now = Date.parse("2026-08-09T00:00:00Z");
  const pool = Recommender.candidatePool(rows, catalog.conferences, now);
  const 見た: string[] = [];
  for (const 文 of 例) {
    const lines = Recommender.parsePaperLines(文);
    const 題 = String(lines[0]?.title ?? 文).slice(0, 34);
    expect(lines.length, `例が 1 論文に読めない: ${文}`).toBeGreaterThan(0);
    const 残 = Recommender.venueRecommendations(pool, lines, null, now, {
      fieldedLexical: true,
    }).filter((r) => r.fit.score >= 10);
    expect(残.length, `例「${題}」で候補が 0 件（押しても何も出ない）`).toBeGreaterThan(0);
    const 掲載先 = 文.split("|")[2]?.trim() ?? "";
    /* 例の掲載先は、収録に在るとは限らない（`IEEE RTSS` は収録に無い – そのときは画面が
     * 「見当たりません」と名指す。黙って消さない事が約束）。 */
    const 見当たらない = Recommender.unmatchedVenues(lines, rows);
    if (見当たらない.length)
      expect(
        Recommender.venueLookupNoticeJa(見当たらない),
        `例「${題}」の掲載先「${掲載先}」を黙って消している`,
      ).toContain(掲載先);
    見た.push(`${掲載先 || "(掲載先なし)"}: ${残.length}`);
  }
  expect(見た.join(" / "), "例の数だけ確かめていない").toContain(":");
});
