/**
 * 日にちの語へ「其の位」の語を続けた打ち方の検査（第 377 回）。
 * 実測（2026-10-24 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `8月10日` 4 行・`明日` 4 行・`来週金曜` 19 行が通るのに、`8月10日頃` `8月10日あたり`
 * `8月10日位` `8月10日ぐらい` `8月10日前後` `明日頃` `3日後頃` `来週金曜頃` はいずれも
 * **0 行で案内も無し**だった（其の方の語が品書の文字列に無いので其侭当たらず、解く所も無かった）。
 * 直すのは其の日だけ – 前後の日へ広げない（幅の広さを推測しない – AGENTS.md）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  return Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
}

function 行列表(語: string): Array<{ hay: string }> {
  const matches = Recommender.searchMatcher(語, 基準);
  return 品書().filter((row) => matches(String(row.hay)) === true);
}

function 対称差(a: string, b: string): number {
  const x = new Set(行列表(a).map((r) => r.hay));
  const y = new Set(行列表(b).map((r) => r.hay));
  return [...x].filter((k) => !y.has(k)).length + [...y].filter((k) => !x.has(k)).length;
}

/** 其の方の語が其の方の語を含んでいる（広い方に含まれる）。 */
function 含む(広い: string, 狭い: string): boolean {
  const x = new Set(行列表(広い).map((r) => r.hay));
  return 行列表(狭い).every((r) => x.has(r.hay));
}

function 案内(語: string): string {
  return Recommender.relativeDayNotes(語, 基準).join(" / ");
}

describe("其の方の語を続けた日にちの打ち方", () => {
  it("暦日に続けた形は其の日と同じ行を出す（前後へ広げない – 第 377 回）", () => {
    for (const 語 of [
      "8月10日頃",
      "8月10日あたり",
      "8月10日辺り",
      "8月10日位",
      "8月10日ぐらい",
      "8月10日くらい",
      "8月10日前後",
      "8月10日ころ",
    ]) {
      expect(対称差(語, "8月10日"), `其の方の語と同じ行: ${語}`).toBe(0);
      expect(行列表(語).length, `行が出ている: ${語}`).toBeGreaterThan(0);
    }
  });

  it("相対語・週+曜日に続けた形も其の日と同じ行を出す（第 377 回）", () => {
    for (const [語, 基] of [
      ["明日頃", "明日"],
      ["明日あたり", "明日"],
      ["3日後頃", "3日後"],
      ["来週金曜頃", "来週金曜"],
      ["今週金曜あたり", "今週金曜"],
    ] as Array<[string, string]>) {
      expect(対称差(語, 基), `其の日と同じ行: ${語}`).toBe(0);
      expect(含む(語, 基), `其の日を含む: ${語}`).toBe(true);
    }
  });

  it("其の方の幅に続けた形は其の方の幅と同じ行を出す（第 377 回）", () => {
    expect(対称差("8月10日から8月12日頃", "8月10日から8月12日")).toBe(0);
    expect(対称差("8月10日から8月12日あたり", "8月10日から8月12日")).toBe(0);
  });

  it("年を打たれていて其の日が過ぎている日は翌年として受ける（第 370 回と同じ決まり）", () => {
    const 文 = 案内("7月1日頃");
    expect(文, "其の方の語に翌年を続けると書く").toContain("7月1日頃 = 2027年7月1日");
    expect(文, "過ぎた其の日を其の年に黙って取らない").not.toContain("= 2026年7月1日");
    /* 行の側も其の方の暦日と同じ物を見ている（品書に其の行が無ければ両方 0 – 対称差 0）。 */
    expect(対称差("7月1日頃", "2027年7月1日")).toBe(0);
    /* 年を打たれた形は其の年を受ける – 今年へ寄せる其れ以外の形に混ざらない（和暦も同じ）。 */
    expect(案内("2027年8月10日頃")).toContain("2027年8月10日頃 = 2027年8月10日");
    expect(案内("令和9年8月10日頃")).toContain("令和9年8月10日頃 = 2027年8月10日");
  });

  it("件数欄は其の日と、前後へ広げない事を其の場で書く（第 377 回）", () => {
    for (const [語, 解] of [
      ["8月10日頃", "8月10日頃 = 2026年8月10日(月)の締切"],
      ["明日あたり", "明日あたり = 2026年8月10日(月)の締切"],
      ["3日後頃", "3日後頃 = 2026年8月12日(水)の締切"],
      ["来週金曜頃", "来週金曜頃 = 2026年8月14日(金)の締切"],
    ] as Array<[string, string]>) {
      const 文 = 案内(語);
      expect(文, `案内が解けた日を名乗る: ${語}`).toContain(解);
      expect(文, `前後へ広げない事をを書く: ${語}`).toContain("幅にせず其の日だけで絞りました");
      expect(文, "幅で打つ手立てを書く").toContain("幅で打ってください");
    }
    /* 案内が書く語は其の方の語に其侭現れる（案内がその語にはない日を名乗らない）。 */
    for (const 語 of ["8月10日頃", "明日あたり", "来週金曜頃"]) {
      expect(語).toContain(案内(語).split(" = ")[0] as string);
    }
  });

  it("其の日が決まらない形は解かず、件数欄も出さない（第 377 回）", () => {
    for (const 語 of [
      "8月頃", // 其の月の何時か決まらない – 其の月其れ自体で打つ
      "来週頃", // 週の何時か決まらない
      "12日から15日頃", // 何月の話か決まらない（第 376 回と同じ）
      "3日前後", // 其の日か日数か決まらない
      "単位", // 「位」で終わるだけの日付では無い語
      "学位",
    ]) {
      expect(行列表(語).length, `解かない: ${語}`).toBe(0);
      expect(案内(語), `件数欄も出さない: ${語}`).toBe("");
    }
  });

  it("直し方が実測どおりの形で成果物に入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 条目列表: Array<[string, number]> = [
      ["const 頃の尾Ja =", 1],
      ["const 和暦の日Ja =", 1],
      ["const 週の曜日Ja =", 1],
      ["function 位の付いた日を暦日に解くJa(", 1],
      ["const 其の日が決まる =", 1],
      /* 年を打たれていない日は其の方の幅と同じ決まりで年を決める（第 370 回と同じ）。 */
      ["let 継ぐ年 = 暦[0] >= 0 ? 暦[0] : 基準日時.getUTCFullYear();", 1],
      ["if (暦[0] < 0 && 継ぐ年 * 10000 + 暦[1] * 100 + 暦[2] < 基準日)", 1],
      ["return [token].concat(位);", 1],
      ["const 位の暦日 = 位の付いた日を暦日に解くJa(token, nowMs);", 1],
    ];
    for (const [条目, 数] of 条目列表) {
      expect(rec.split(条目).length - 1, `成果物の中の語の数: ${条目.slice(0, 20)}`).toBe(数);
    }
  });
});
