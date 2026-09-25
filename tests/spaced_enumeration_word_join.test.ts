/**
 * 相対日の列挙を語の間に空格を交えて打つ形（『来週と 再来週』『8月及び 9月』）– 第 424 回。
 *
 * 実測（2026-10-09 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）: 同じ頼み方で
 * 寄せた語は列挙の機械が和集合を出す（来週と再来週 91 行・8月及び9月 441 行）のに、語の間に
 * 空格が在るだけで二語に割れて AND になり、別の話が出て居た –
 * 『来週と 再来週』**3 行**・『来週 と 再来週』**3 行**・『8月及び 9月』**0 行**。
 *
 * 直し – `collapseRelativeDayPhrase` の語列で、両側が相対日の目印の語である列挙の目印
 * （と・または・もしくは・あるいは・及び・ならびに・か）の前後の空格を詰めて 1 語に寄せ、
 * 其の方の列挙の機械に渡すだけ（展開の發明はしない）。番として –
 * ①内容語の並べ打ち（『人と 機械』・『ai と ml』）は目印が受けず AND の侭、
 * ②頭（左端）が裸の日（『10日と 20日』）は月が決まらず列挙も解けないので寄せない
 *  （寄せるとかけ算 6 行が 1 語 0 行に落ちた）、
 * ③片側だけが日付の形（『来週とai』）も寄せない。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 列表入口() {
  const 品 = (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
  const 済 = new Map<string, Set<string>>();
  return (語: string): Set<string> => {
    if (!済.has(語)) {
      const 当 = Recommender.searchMatcher(語, 基準);
      済.set(語, new Set(品.filter((行) => 当(行) === true)));
    }
    return 済.get(語) as Set<string>;
  };
}

const 列 = 列表入口();
const 対称差 = (甲: string, 乙: string) => {
  const A = 列(甲);
  const B = 列(乙);
  let 違 = 0;
  for (const 行 of new Set([...A, ...B])) if (A.has(行) !== B.has(行)) 違 += 1;
  return 違;
};
const 和集合の差 = (列挙: string, 甲: string, 乙: string) => {
  const A = 列(列挙);
  const U = new Set([...列(甲), ...列(乙)]);
  let 違 = 0;
  for (const 行 of new Set([...A, ...U])) if (A.has(行) !== U.has(行)) 違 += 1;
  return 違;
};

describe("相対日の列挙を空格で打つと和集合になる（第 424 回）", () => {
  const 並べ打ち: Array<[string, string, string]> = [
    ["来週と 再来週", "来週", "再来週"],
    ["来週 と 再来週", "来週", "再来週"],
    ["明日と 明後日", "明日", "明後日"],
    ["3日後と 5日後", "3日後", "5日後"],
    ["来週または 再来週", "来週", "再来週"],
    ["明日か 明後日", "明日", "明後日"],
    ["8月及び 9月", "8月", "9月"],
  ];
  for (const [列挙, 甲, 乙] of 並べ打ち) {
    it(`『${列挙}』は『${甲}』『${乙}』の和集合`, () => {
      expect(和集合の差(列挙, 甲, 乙), 列挙).toBe(0);
      expect(列(列挙).size).toBeGreaterThan(0);
    });
  }

  it("寄せた語（空格無し）と同じ一覧になる", () => {
    expect(対称差("来週と 再来週", "来週と再来週")).toBe(0);
    expect(対称差("来週 と 再来週", "来週と再来週")).toBe(0);
    expect(対称差("8月及び 9月", "8月及び9月")).toBe(0);
  });

  it("三つ以上連ねた形も一束になる", () => {
    expect(対称差("来週と 再来週と 来月", "来週と再来週と来月")).toBe(0);
    expect(列("来週と 再来週と 来月").size).toBeGreaterThan(0);
  });
});

describe("列挙の寄せは其它の打ち方を壊さない（第 424 回）", () => {
  it("内容語の並べ打ちは和集合にしない", () => {
    expect(列("人と 機械").size).toBe(0);
    // 『ai と ml』は語が割れて AND – 寄せが和集合になったら行が増える。
    expect(対称差("ai と ml", "ai ml")).toBe(0);
    expect(対称差("ai と ml", "ai")).toBeGreaterThan(0);
  });

  it("頭が裸の日（月が決まらない）は寄せない – かけ算の 5 行が其侭", () => {
    // 寄せると 1 語に化けて 0 行に落ちる（実測 6 行→0 行）。AND の掛かり方を保つ。
    expect(対称差("10日と 20日", "10日 20日")).toBe(0);
    expect(列("10日と 20日").size).toBeGreaterThan(0);
  });

  it("片側だけが日付の形は寄せない", () => {
    expect(対称差("来週とai", "ai")).toBeGreaterThan(0);
    expect(列("来週とai").size).toBe(0);
  });

  it("第 423 回の空格相対日・其它の検索は一寸も動かない", () => {
    expect(対称差("来 週", "来週")).toBe(0);
    expect(対称差("月 曜", "")).toBe(0);
    expect(対称差("3 日以内", "3日以内")).toBe(0);
    expect(対称差("来週 月曜", "来週 月曜")).toBe(0);
    expect(列("").size).toBe(435);
  });
});

describe("寄せの折方がビルド成果物に残る（第 424 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("語列を右から寄せる折方と暦月語の項が在る", () => {
    expect(物.match(/const 列挙の語列Ja = out\.split\(" "\)/g)).toHaveLength(1);
    expect(物.match(/const 暦月語の項Ja =/g)).toHaveLength(1);
    expect(
      物.includes('const 列挙の頭目印Ja = 相対日の語Ja.replace("|[0-9]{1,2}日", 暦月語の項Ja)'),
    ).toBe(true);
  });
  it("裸の日を頭の目印に残さない（接着で化けた形に戻っていない）", () => {
    // 頭目印が裸の日 `|[0-9]{1,2}日` をそのまま含んで居たら、`10日と 20日` が化ける。
    const 頭 = 物.slice(物.indexOf("const 列挙の頭目印Ja ="));
    const 頭定義 = 頭.slice(0, 頭.indexOf(";"));
    expect(頭定義.includes("暦月語の項Ja")).toBe(true);
    expect(頭定義.includes(".replace(")).toBe(true);
  });
});
