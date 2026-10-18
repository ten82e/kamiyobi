import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 行列表(語: string): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
  const matches = Recommender.searchMatcher(語, 基準);
  return rows.filter((row) => matches(String(row.hay)) === true);
}

function 対称差(a: string, b: string): number {
  const x = new Set(行列表(a).map((r) => r.hay));
  const y = new Set(行列表(b).map((r) => r.hay));
  return [...x].filter((k) => !y.has(k)).length + [...y].filter((k) => !x.has(k)).length;
}

/* 残り欄は「あと N 日」で並ぶが、人は「あと 1 週間」「あと 2 か月」とも打つ。
 * 2026-10-18 の実測では、どちらも 0 件で「語「あと1週間」は収録データにありません」と
 * 一般論の案内だけだった（`1週間後` `2週間以内` は通るのに、頭に `あと` が付くと落ちた）。
 * 同じ調べ方の「あと 3 日以内」も `3日後以内` という収録に無い語になっていて 0 件だった。 */
describe("「あと N 週間」「あと N か月」「あと N 日以内」の打ち方", () => {
  it("週の言い方はその日数の日付として引く（`あと 1 週間` = `7日後`）", () => {
    for (const [打つ, 同じ, 日数] of [
      ["あと1週間", "7日後", 7],
      ["あと 1 週間", "7日後", 7],
      ["残り1週間", "7日後", 7],
      ["あと2週間", "14日後", 14],
      ["のこり2週間", "14日後", 14],
      ["あと3週", "21日後", 21],
      ["あと1週間後", "7日後", 7],
    ] as Array<[string, string, number]>) {
      expect(行列表(同じ).length, `対照「${同じ}」が 0 行（検査が空振り）`).toBeGreaterThan(0);
      expect(行列表(打つ).length, `「${打つ}」が 0 行のまま`).toBeGreaterThan(0);
      expect(対称差(打つ, 同じ), `「${打つ}」が「${同じ}」と違う行を出した`).toBe(0);
      expect(
        Recommender.queryTokenGroups(打つ, 基準).flat().join(" "),
        `「${打つ}」が ${日数} 日の語になっていない`,
      ).toContain(`${日数}日後`);
    }
  });

  it("か月の言い方は暦の月のまま引く（`あと 2 か月` = `2ヶ月後`）", () => {
    for (const [打つ, 同じ] of [
      ["あと2ヶ月", "2ヶ月後"],
      ["あと 2 ヶ月", "2ヶ月後"],
      ["残り1ヶ月", "1ヶ月後"],
      ["あと3カ月", "3カ月後"],
    ] as Array<[string, string]>) {
      expect(行列表(同じ).length, `対照「${同じ}」が 0 行（検査が空振り）`).toBeGreaterThan(0);
      expect(対称差(打つ, 同じ), `「${打つ}」が「${同じ}」と違う行を出した`).toBe(0);
    }
  });

  it("幅の言い方（以内）は日数の幅のまま引く（`あと 7 日以内` = `7日以内`）", () => {
    /* 直す前は日付の側の規則が先に当たり、`7日後以内` という収録に無い語になっていた
     * （「あと 3 日以内」「あと 14 日以内」とも 0 件）。 */
    for (const [打つ, 同じ] of [
      ["あと7日以内", "7日以内"],
      ["あと 7 日以内", "7日以内"],
      ["あと14日以内", "14日以内"],
      ["残り14日以内", "14日以内"],
      ["あと1週間以内", "7日以内"],
      ["あと2週間以内", "14日以内"],
      ["のこり2週間以内", "14日以内"],
    ] as Array<[string, string]>) {
      expect(行列表(同じ).length, `対照「${同じ}」が 0 行（検査が空振り）`).toBeGreaterThan(0);
      expect(対称差(打つ, 同じ), `「${打つ}」が「${同じ}」と違う行を出した`).toBe(0);
      expect(
        Recommender.queryTokenGroups(打つ, 基準).flat().join(" "),
        `「${打つ}」に日付の側の語（日後）が混ざった`,
      ).not.toContain("日後");
    }
  });

  it("か月の幅は日数へ換えない（暦の月は長さが一定でない – 既存の約束のまま）", () => {
    expect(行列表("あと2ヶ月以内").length, "か月の幅を日数へ換えてしまった").toBe(0);
    const 案内 = [
      Recommender.relativeDayNotes("あと2ヶ月以内", 基準).join(" "),
      Recommender.querySynonymNotes("あと2ヶ月以内").join(" "),
      Recommender.uiWordNoteJa("あと2ヶ月以内"),
    ].join(" ");
    expect(案内, "か月を日数へ換えない理由を書いていない").toContain("か月");
  });

  it("単位だけの言い方には、どちらの書き方があるかを言う（勝手に寄せない）", () => {
    /* `3週間` `2か月` は、その日なのか、これからその期間なのかが決まらない。
     * 決められない事を言い、両方の書き方を示す（0 件のまま一般論で終わらせない）。 */
    for (const [語, 単位] of [
      ["3週間", "週間"],
      ["2か月", "か月"],
      ["1ヶ月", "ヶ月"],
    ] as Array<[string, string]>) {
      expect(行列表(語).length, `「${語}」が当たっている（前提が変わった）`).toBe(0);
      const 案内 = Recommender.relativeDayNotes(語, 基準).join(" ");
      expect(案内, `「${語}」に書き方を示していない`).toContain(`「${語}後」`);
      expect(案内, `「${語}」に幅の書き方を示していない`).toContain(`「${語}以内」`);
      expect(案内).toContain("いつまでかが書かれていません");
      expect(単位.length).toBeGreaterThan(0);
    }
    /* 広げた形（`3週間後`・`3週間以内`）は今まで通り日に解く（案内を重ねない）。 */
    expect(Recommender.relativeDayNotes("3週間後", 基準).join(" ")).toContain("=");
    expect(Recommender.relativeDayNotes("3週間以内", 基準).join(" ")).toContain("=");
  });

  it("過ぎた側の言い方（前）は動かさない", () => {
    /* `7日前` はそのまま過去の日付として引く（日付の側へ寄せない）。 */
    expect(対称差("7日前", "7日前"), "過去の言い方が動いた").toBe(0);
    expect(
      Recommender.queryTokenGroups("7日前", 基準).flat().join(" "),
      "過去の言い方が日付（日後）になっている",
    ).not.toContain("日後");
  });
});
