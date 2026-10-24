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

/* 2026-10-18 – 研究者役の試しで、「機械学習の会議を探したい」が 0 行だった（「教えて」「知りたい」は
 * 通る）。「したい」だけを剥ぐと語幹の「探」が残って `機械学習の会議を探` を探していた。 */
it("「探したい」「探しています」「調べたい」で終わる依頼は、その語を落として同じ行を出す", () => {
  const 基 = 列("機械学習の会議を教えて");
  expect(基.size, "対照の行が 0（検査が空振り）").toBeGreaterThan(0);
  for (const 文 of [
    "機械学習の会議を探したい",
    "機械学習の会議を探しています",
    "機械学習の会議を探してます",
    "機械学習の会議を探しているんですが",
    "機械学習の会議を調べたい",
    "機械学習の会議をさがしたい",
  ])
    expect(対称差(列(文), 基), `「${文}」が「教えて」の形と違う`).toBe(0);
});

it("文の中の「来月まで」も今月からの幅として解き、件数欄がそう書く", () => {
  const 注 = Recommender.relativeDayNotes(
    Recommender.expandRelativeMonths("来月までに締切の機械学習の会議", 基準),
    基準,
  ).join(" ");
  expect(注).toContain("今月からその月の末まで");
});

it("読点・「までに」を含む長い文も、語に割れて同じ行を出す", () => {
  /* 2026-10-18 – `来月までに締切の、機械学習の会議を探したい` が 0 行だった。助詞の直後の読点で語が割れず、
   * `までに` を含む語では「の」でも割らなかったため、`締切の機械学習の会議` が一語のまま残った。 */
  const 基 = 列("年内まで 締切 機械学習");
  expect(基.size, "対照の行が 0（検査が空振り）").toBeGreaterThan(0);
  for (const 文 of [
    "年内までに締切の、機械学習の会議を探したい",
    "年内までに締切の機械学習の会議を探したい",
    "年内までに、締切の機械学習の会議を教えて",
  ])
    expect(対称差(列(文), 基), `「${文}」が割れていない`).toBe(0);
  /* 数を数える語の途中の読点は割らない。 */
  expect(Recommender.queryTokens("A、B", 基準)).toEqual(["a、b"]);
});
