import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 品書 = (
  Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
  ) as unknown as Array<{ hay: string }>
).map((行) => String(行.hay));
const 列 = (文: string) =>
  new Set(品書.filter((行) => Recommender.searchMatcher(文, 基準)(行) === true));
const 対称差 = (甲: Set<string>, 乙: Set<string>) =>
  [...甲].filter((行) => !乙.has(行)).length + [...乙].filter((行) => !甲.has(行)).length;

/* 2026-10-17 – 初回利用者の試しで `来月までの機械学習の学会` と `CCF Aの年内までの締切` が 0 行だった。
 * 「までの」は `締切までの30日` のように期日を訊く語として一語に残していたため、後ろに別の語が続く文では
 * 割れず、`来月までの機械学習の学会` が一つの語のまま収録に当たらなかった。 */
it("「〜までの」の後ろに主題が続く文は、期間の語と主題に割れて同じ行を出す", () => {
  const 基 = 列("年内まで 機械学習");
  expect(基.size, "対照の行が 0（検査が空振り）").toBeGreaterThan(0);
  for (const 文 of [
    "年内までの機械学習の学会",
    "年内までの機械学習の会議",
    "年内までの、機械学習の会議",
  ])
    expect(対称差(列(文), 基), `「${文}」が割れていない`).toBe(0);

  const 等級 = 列("CCF A 年内まで 締切");
  expect(等級.size, "対照の行が 0（検査が空振り）").toBeGreaterThan(0);
  expect(対称差(列("CCF Aの年内までの締切"), 等級)).toBe(0);
});

it("期日を訊く「締切までの30日」は割らない", () => {
  expect(Recommender.queryTokens("締切までの30日", 基準)).toEqual(["締切までの30日"]);
});
