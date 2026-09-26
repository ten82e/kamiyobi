/**
 * 漢字で「一杯」と打つ人だけ 0 行で黙つて居た（第 428 回）。
 *
 * 実測（2026-10-24 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * 仮名の `今週いっぱい` 19 行・`来週いっぱい` 53 行・`来月いっぱい` 240 行・
 * `今年いっぱい` 789 行が通るのに、漢字の `今週一杯` `来週一杯` `来月一杯`
 * `今年一杯` はいずれも **0 行で案内も無し**。「今週一杯までに返事を」は研究の打ち方で
 * 普通に書く綴りなので、同じ受け口（締切の語を寄せる規則の『いっぱいの言い方』）で
 * 漢字形も受ける。表の語・曜日の語・週末・年の語まで含めて 8 形、対称差 0。
 *
 * 直し – 『いっぱいの言い方』の語尾を `(?:いっぱい|一杯)` にする一箇所だけ。
 * 寄せ先は仮名と同じなので其它の機械（範囲の規則・件数欄・案内）は一寸も動かない。
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

describe("『一杯』は『いっぱい』と同じ（第 428 回）", () => {
  const 対: Array<[string, string]> = [
    ["今週一杯", "今週いっぱい"],
    ["来週一杯", "来週いっぱい"],
    ["再来週一杯", "再来週いっぱい"],
    ["先週一杯", "先週いっぱい"],
    ["来月一杯", "来月いっぱい"],
    ["今年一杯", "今年いっぱい"],
    ["来年一杯", "来年いっぱい"],
    ["週末一杯", "週末いっぱい"],
    ["来週末一杯", "来週末いっぱい"],
    ["金曜一杯", "金曜いっぱい"],
    ["8月20日一杯", "8月20日いっぱい"],
  ];
  for (const [漢, 假] of 対) {
    it(`『${漢}』は『${假}』と同じ一覧`, () => {
      expect(対称差(漢, 假), 漢).toBe(0);
      /* 両方が 0 行だと『同じ』が空振りする – 行が出ている事も夫々見る（第 428 回）。*/
      expect(列(漢).size, 漢).toBeGreaterThan(0);
      expect(列(假).size, 假).toBeGreaterThan(0);
    });
  }

  it("行も出る（0 行の侭『同じ』で空振りしない）", () => {
    expect(列("来週一杯").size).toBe(43);
    expect(列("来月一杯").size).toBe(178);
    expect(列("今週一杯").size).toBe(4);
  });

  it("案内は寄せ先の週の幅を書く（黙らない）", () => {
    expect(Recommender.relativeDayNotes("来週一杯", 基準).join("")).toContain(
      "来週 = 2026年8月10日(月)〜8月16日(日)",
    );
  });

  it("件数欄の立て方は其它の決まりの侭（月の名前に付きただけの形は立てない）", () => {
    expect(Recommender.periodMonthPairs("来月一杯", 基準)).toEqual([]);
  });
});

describe("其它は其侭（第 428 回）", () => {
  it("其它の語は一寸も動かない", () => {
    expect(対称差("来月いっぱい", "来月中")).toBe(0);
    expect(対称差("来月一杯", "来月")).toBe(0);
    expect(対称差("週末一杯", "週末")).toBe(0);
    expect(対称差("金曜一杯", "金曜")).toBe(0);
    expect(列("今年一杯").size).toBe(426);
    expect(列("来週末一杯").size).toBe(34);
    expect(対称差("来週末までに", "来週末までに")).toBe(0);
    expect(対称差("半月後", "15日後")).toBe(0);
    expect(対称差("来週と 再来週", "来週と再来週")).toBe(0);
    expect(対称差("aiとml", "ai ml")).toBe(0);
    expect(対称差("月 曜", "")).toBe(0);
    expect(列("").size).toBe(435);
  });
});

describe("割りの形がビルド成果物に残る（第 428 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("語尾の枝が漢字・仮名の両方を受ける", () => {
    /* 第 463 回 – 語尾の前に空格を置く打ち方（`来週 いっぱい`）も受けるやうにしたので、
     * 漢字の枝の直前に空格の目が入つた（仮名の `一杯` は詰め打ちのまま – 実測で
     * `来週 一杯` は詰め形 `来週一杯` と同じく 0 行なので広げない）。 */
    expect(物.split("(?:[ \\u3000]*いっぱい|一杯)").length - 1).toBe(1);
    /* 仮名だけの語尾に戻すと漢字が黙る – 其の方の形が表から消えた事も見る。*/
    expect(物.split("いっぱい/g").length - 1).toBe(0);
  });
});
