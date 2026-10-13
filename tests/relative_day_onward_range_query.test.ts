import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
function 品書(): string[] {
  return (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
}
const 全 = 品書();
function 列(文: string) {
  return new Set(全.filter((行) => Recommender.searchMatcher(文, 基準)(行) === true));
}
function 案内(文: string) {
  return Recommender.relativeDayNotes(文, 基準).join("|");
}

describe("それより後の語を日の語に続けた形がその初日から絞れる（第 475 回）", () => {
  it("離つて打つ形が繋いだ形と同じ行に出る（実測 – 前は両側 0 行だった）", () => {
    for (const [離, 繋] of [
      ["来週 以降", "来週以降"],
      ["明日 以降", "明日以降"],
      ["下旬 以後", "下旬以後"],
      ["来月上旬 以降", "来月上旬以降"],
      ["明日 この先", "明日この先"],
      ["来週 以来", "来週以来"],
    ]) {
      expect([離, 列(離).size, 列(繋).size]).toEqual([離, 列(繋).size, 列(繋).size]);
      expect(列(離).size).toBeGreaterThan(100);
    }
  });
  it("行数の実測（固定ハーネスの品書 435 行 – 前はこの内すべて 0 行だった）", () => {
    expect(列("明日以降").size).toBe(423);
    expect(列("来週以降").size).toBe(423);
    expect(列("今週以降").size).toBe(423);
    expect(列("先週以降").size).toBe(425);
    expect(列("下旬以降").size).toBe(414);
    expect(列("中旬以降").size).toBe(423);
    expect(列("来月上旬以降").size).toBe(389);
    expect(列("週末以降").size).toBe(423);
    expect(列("来週末以降").size).toBe(421);
    expect(列("来年度以降").size).toBe(50);
    expect(列("来年以降").size).toBe(114);
    expect(列("22日以降").size).toBe(395);
    expect(列("年度末以降").size).toBe(50);
    expect(列("来月末以降").size).toBe(295);
  });
  it("幅で絞れる形は件の数欄が「並びます」と嘘を書かない（暦日を打つ形と同じ決まり – 第 413 回）", () => {
    for (const 文 of [
      "明日以降",
      "来週以降",
      "下旬以降",
      "来月上旬以降",
      "来年以降",
      "来週 以降",
    ]) {
      expect(案内(文)).toBe("");
      expect([文, 列(文).size > 0]).toEqual([文, true]);
    }
  });
  it("後ろに其它の語を続けても効く", () => {
    expect(列("ml 明日以降 締切").size).toBe(14);
    expect(列("明日以降 論文").size).toBe(259);
    expect(列("来週 以降 の 締切").size).toBe(366);
    expect(列("下旬以降 締切").size).toBe(357);
  });
});

describe("載せない形と其它の機械の守り（第 328 回・第 373 回・第 453 回）", () => {
  it("`から` `より` もその初日から絞る – 幅の終りが控へる形は三語を一語に継ぐ（第 476 回）", () => {
    for (const [文, 件] of [
      ["今日から", 423],
      ["明日から", 423],
      ["来週から", 423],
      ["来週 より", 423],
      ["来月上旬から", 389],
      ["3日後から", 423],
      ["22日より", 395],
    ] as Array<[string, number]>) {
      expect([文, 列(文).size]).toEqual([文, 件]);
      expect(案内(文), `「${文}」に案内が残つた`).toBe("");
    }
    /* 幅の終りがある形は詰め形と一字も違わない当たり方になる。*/
    for (const [離, 繋] of [
      ["明日 から 明後日", "明日から明後日"],
      ["9月上旬から 中旬", "9月上旬から中旬"],
      ["9 月 上旬 から 中旬", "9月上旬から中旬"],
      ["来月上旬 から 中旬", "来月上旬から中旬"],
    ] as Array<[string, string]>) {
      expect([離, 列(離).size]).toEqual([離, 列(繋).size]);
    }
    expect(列("明日 から 明後日").size).toBe(4);
    expect(列("9 月 上旬 から 中旬").size).toBe(120);
  });
  it("月の語・年・時刻の語はその方の機械が既に絞る – この回は触つて居ない", () => {
    expect(列("8月以降").size).toBe(425);
    expect(列("9月以降").size).toBe(389);
    expect(列("8月から").size).toBe(425);
    expect(列("17時 以降").size).toBe(181);
    expect(案内("17時 以降")).toContain("17時 以降 = 17:00〜23:59");
    expect(案内("17時以降")).toContain("17時以降 = 17:00〜23:59");
  });
  it("日付の語でないものには尾を寄せない（第 447 回の案内が其侭出る）", () => {
    expect(列("論文以降").size).toBe(0);
    expect(列("JST 以降").size).toBe(0);
    expect(案内("論文以降")).not.toContain("初期画面は締切の近い順に");
  });
  it("その月の語と塊を離つてそれより後を続ける形も詰め形と同じ行に出る（第 476 回）", () => {
    for (const [離, 繋] of [
      ["来月 上旬 以降", "来月上旬以降"],
      ["来月上旬 以降", "来月上旬以降"],
      ["来月 中旬 から", "来月中旬から"],
    ] as Array<[string, string]>) {
      expect([離, 列(離).size]).toEqual([離, 列(繋).size]);
    }
    expect(列("来月上旬以降").size).toBe(389);
  });
  it("在り得ない日は 0 行の侭で、案内がその事を立つて書く（締切の推測はしない）", () => {
    expect(列("2月30日以降").size).toBe(0);
    expect(案内("2月30日以降")).toContain("其れより後の締切の事だと思いますが");
  });
  it("第 470 回〜第 474 回の実測はこの回で変へて居ない", () => {
    expect(列("週 末").size).toBe(146);
    expect(列("来月 上旬 まで").size).toBe(180);
    expect(列("来 上旬").size).toBe(68);
    expect(列("来 週末").size).toBe(34);
    expect(案内("来 週末")).toContain("来週末 = 2026年8月15日(土)");
    expect(列("8 月の 締切").size).toBe(114);
    expect(列("来 年中").size).toBe(114);
  });
});

describe("ビルド成果物に目がある事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("初日の函数と尾の寄せが現れる", () => {
    /* 五つ目 – 第 476 回で「塊の語を `以降` に揃える目」を落した事を注に書いた為、字面が一つ増えた。*/
    expect(物.match(/其の日以降の初日Ja/g)?.length).toBe(3);
    expect(物.match(/其れより後の尾Ja/g)?.length).toBe(2);
    expect(物).toContain("日付らしき語Ja(頭)");
  });
  it("前の四回の目の字面を壊して居ない", () => {
    expect(物.match(/複合語の切れ目/g)?.length).toBe(2);
    expect(物).toContain('"$1$2月$3$4"');
    expect(物.match(/単位に付いた助字/g)?.length).toBe(2);
    expect(物.match(/月の付いた塊/g)?.length).toBe(3);
  });
});
