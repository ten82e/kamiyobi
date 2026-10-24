import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

/* 収録状況の四つの数字は「集まりの大きさ」しか言わない。そこから一覧へ行く道を数字の隣に
 * 書く（穴場は検索語、国内研究会はチェック – 2026-10-18。てびきには書いてあったが、
 * 数を見た場所からは離れていた）。 */
it("収録状況の数字の隣に、そこから一覧へ行く道が書いてある", () => {
  const template = readFileSync(join(import.meta.dirname, "..", "site", "template.html"), "utf8");
  const 始 = template.indexOf('id="catalogStats"');
  expect(始, "収録状況の塊が見つからない").toBeGreaterThan(-1);
  const 統計 = template.slice(始, template.indexOf("</details>", 始));
  expect(統計, "数字の隣に道が書いていない").toContain("stats-hint");
  expect(統計, "穴場の引き方を書いていない").toContain("「穴場」と打つと");
  expect(統計, "国内研究会の絞り方を書いていない").toContain("国内研究会・国内シンポジウムのみ");
  /* 名指した語は実在する（打てば行が出る・その欄が画面にある）。 */
  const site = builtSite();
  const rows = Recommender.candidateRows(
    JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as never,
  ) as unknown as Array<{ hay: string }>;
  const 照合 = Recommender.searchMatcher("穴場", Date.parse("2026-08-09T00:00:00Z"));
  const 行 = rows.filter((row) => 照合(String(row.hay)) === true).length;
  expect(行, "「穴場」で行が出ない（案内が空振り）").toBeGreaterThan(20);
  expect(template, "名指したチェック欄が画面に無い").toContain('type="checkbox" id="domestic"');
  /* てびきも同じ引き方を書いている（画面と説明で別々の道を指さない）。 */
  expect(template, "てびきが穴場の引き方を書いていない").toContain("検索欄に「穴場」と打つと");
});
