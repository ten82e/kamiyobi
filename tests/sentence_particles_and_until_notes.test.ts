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

/* 2026-10-17 – `セキュリティの学会` は 0 行、`機械学習の学会` は 1 行（同じ文の「会議」は 75 行）だった。
 * 研究者が「〜の学会」と言うのは会議全般の言い換えで、`学会` 一語が当たるのは名前に学会を持つ
 * 国内の 24 行だけ。ほかの語と並んだ裸の `学会` は絞り込みに使わない。 */
it("ほかの語と並んだ裸の「学会」は「会議」と同じに、絞り込みに使わない", () => {
  for (const 主題 of ["セキュリティ", "機械学習"]) {
    const 基 = 列(主題);
    expect(基.size, `対照の行が 0（検査が空振り）: ${主題}`).toBeGreaterThan(0);
    expect(対称差(列(`${主題}の学会`), 基), `「${主題}の学会」が「${主題}」と違う`).toBe(0);
    expect(対称差(列(`${主題} 学会`), 基), `「${主題} 学会」が「${主題}」と違う`).toBe(0);
  }
  /* 一語だけの「学会」と、名前に学会を持つ語は今まで通り。 */
  expect(列("学会").size, "「学会」だけの検索が空になった").toBeGreaterThan(0);
  expect(列("情報処理学会").size, "「情報処理学会」が空になった").toBeGreaterThan(0);
});

/* 2026-10-17 – 画面の件数欄が `「来月まで」 = 2026年10月〜2026年11月` のすぐ後に `来月まで = 2026年11月`
 * と、食い違う 2 つ目の解釈を並べていた（`relativeMonthPairs` が幅の語を来月だけに解いていた）。 */
it("「〜月まで」は月の幅として 1 度だけ説明し、その月だけの解釈を重ねて出さない", () => {
  for (const 語 of ["来月まで", "今月まで", "再来月まで", "3月まで", "来月までに"])
    expect(Recommender.relativeMonthPairs(`${語} 機械学習`, 基準), `「${語}」`).toEqual([]);
  /* 幅でない「来月」は今まで通り。 */
  expect(Recommender.relativeMonthPairs("来月", 基準).length).toBe(1);
});

/* 2026-10-17 – `11月締切のセキュリティ会議` は 0 行だった（`セキュリティ会議` だけなら `セキュリティ` + `会議` に
 * 割れて 154 行）。助詞で割った後ろの語には、全行にあてはまる語（会議・大会）の語尾割りが掛かっていなかった。 */
it("助詞で割った後ろの語も、末尾の「会議」を全行の語として割る", () => {
  const 基 = 列("11月 締切 セキュリティ");
  expect(基.size, "対照の行が 0（検査が空振り）").toBeGreaterThan(0);
  expect(対称差(列("11月締切のセキュリティ会議"), 基)).toBe(0);
  expect(対称差(列("11月締切のセキュリティの会議"), 基)).toBe(0);
});

/* 同日 – `CORE A*の来月締切` の件数欄が「『の来月締切』は『の来月』と『締切』に分けて」と、助詞の「の」を
 * 語の頭に付けたまま書いた（等級の括りの直後の「の」が助詞として外れていなかった）。 */
it("等級の括りの直後の「の」は語の頭に残さない", () => {
  for (const 文 of ["CORE A*の来月締切", "CCF Aの来月締切", "CORE Aの来月締切"])
    for (const 語 of Recommender.queryTokens(文, 基準))
      expect(語.startsWith("の"), `「${文}」の語「${語}」が「の」で始まる`).toBe(false);
});
