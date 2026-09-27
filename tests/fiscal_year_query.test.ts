/**
 * 「今年度」「来年中」「半年以内」など**年でまとまって聞く**形の検査（SPEC §4・§7・第 330 回）。
 * 実測（2026-09-28 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `今年` 789 行 / `今年中` **0 行**、`来年` 452 行 / `来年中` **0 行**・`翌年` **0 行**、
 * `今年度` **0 行**・`来年度` **0 行**・`前年度` **0 行**・`翌年度` **0 行**、
 * `来年以降` **0 行**（案内も無し）、`6か月以内` が当たるのに `半年以内` **0 行**。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z"); /* 日曜 – 現在の年度は 2026 年度 */

function 行集合(語: string): Set<string> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{
    key?: string;
    hay: string;
  }>;
  const matches = Recommender.searchMatcher(語, 基準);
  return new Set(
    rows
      .filter((row) => matches(String(row.hay)) === true)
      .map((row) => String(row.key ?? row.hay)),
  );
}

function 差(a: Set<string>, b: Set<string>): number {
  return [...a].filter((k) => !b.has(k)).length + [...b].filter((k) => !a.has(k)).length;
}

describe("年でまとまって聞く入力", () => {
  it("年度は 4 月〜翌年 3 月の月語に解ける（固定時計で実測した範囲）", () => {
    const 今年度 = Recommender.fiscalYearTermsJa("今年度", 基準) || [];
    expect(今年度.length, "年度は 12 か月ぶん出す").toBe(12);
    expect(今年度[0], "今年度の始まりが 4 月ではない").toBe("2026年4月");
    expect(今年度[11], "今年度の終わりが翌年 3 月ではない").toBe("2027年3月");
    expect(Recommender.fiscalYearTermsJa("来年度", 基準)?.[0]).toBe("2027年4月");
    expect(Recommender.fiscalYearTermsJa("翌年度", 基準)?.[0]).toBe("2027年4月");
    expect(Recommender.fiscalYearTermsJa("前年度", 基準)?.[0]).toBe("2025年4月");
    expect(Recommender.fiscalYearTermsJa("去年度", 基準)?.[0]).toBe("2025年4月");
    expect(Recommender.fiscalYearTermsJa("再来年度中", 基準)?.[0]).toBe("2028年4月");
    /* 基準が 1〜3 月のときは前年度が現在の年度（年度は 4 月始まり）。時計をずらして調べる
     * （第 330 回 – この分岐は 8 月の時計だけでは検査にならない）。 */
    const 二月 = Date.parse("2026-02-10T00:00:00Z");
    expect(Recommender.fiscalYearTermsJa("今年度", 二月)?.[0], "2 月打ったときの今年度が違う").toBe(
      "2025年4月",
    );
    expect(Recommender.fiscalYearTermsJa("今年度", 二月)?.[11]).toBe("2026年3月");
    expect(Recommender.fiscalYearTermsJa("来年度", 二月)?.[0]).toBe("2026年4月");
    /* 月のまとまりの語（第 327 回）を年度側で食わない。 */
    expect(Recommender.fiscalYearTermsJa("年度末", 基準)).toBeNull();
    expect(Recommender.fiscalYearTermsJa("年度初め", 基準)).toBeNull();
  });

  it("品書で実際に行列が動く（今年度・来年度・年度＋主題）", () => {
    expect(行集合("今年度").size).toBeGreaterThan(0);
    expect(行集合("来年度").size).toBeGreaterThan(0);
    const 主題 = 行集合("セキュリティ");
    const 年度の主題 = 行集合("今年度のセキュリティ");
    expect(主題.size).toBeGreaterThan(0);
    expect(年度の主題.size, "主題を添えた打ち方で 0 行").toBeGreaterThan(0);
    /* 年度で絞ったのにより広い集合になる（AND が壊れている）ことは無い。 */
    expect(差(年度の主題, new Set([...年度の主題].filter((k) => 主題.has(k))))).toBe(0);
  });

  it("年の語に期間だけが付きただけの形は、その年と同じ行に出会う（品書）", () => {
    [
      ["来年中", "来年"],
      ["今年中", "今年"],
      ["今年いっぱい", "今年"],
      ["翌年", "来年"],
    ].forEach(([言い方, 名詞形]) => {
      const 基準の行 = 行集合(名詞形);
      expect(基準の行.size, `"${名詞形}" が 0 行の前提が崩れた`).toBeGreaterThan(0);
      expect(差(行集合(言い方), 基準の行), `"${言い方}" と "${名詞形}" で違う行が出た`).toBe(0);
    });
  });

  it("`半年` は画面が持つ『180 日以内』の幅で受ける（ラベルは画面から読む）", () => {
    const 画面 = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
    const 欄 = /<option value="180d">([^<]+)<\/option>/.exec(画面)?.[1] ?? "";
    expect(欄, "『180 日以内』の選択肢が画面から読めない").not.toBe("");
    const 半年 = 行集合("半年以内");
    expect(半年.size).toBeGreaterThan(0);
    expect(差(半年, 行集合(`${欄.replace(" ", "")}`)), "`半年以内` と画面の幅で違う行が出た").toBe(
      0,
    );
    expect(差(行集合("半年"), 半年), "`半年` だけ打った幅が違う").toBe(0);
    const 案内 = Recommender.relativeDayNotes("半年以内", 基準).join("");
    expect(案内).toContain("2026年8月9日(日)〜2027年2月5日(金)");
    expect(案内, "画面の幅を受けたと書いていない").toContain(欄);
    expect(案内, "暦の半年とずれると書いていない").toContain("ずれます");
  });

  it("月の単位を検索側で換算しない決裁を生かす（第 315 回 – 「3 か月」の幅は一通に決まらない）", () => {
    ["3か月以内", "6か月以内", "2か月以内"].forEach((語) => {
      expect(Recommender.queryTokenGroups(語, 基準), `"${語}" を日数に換算した`).toEqual([[語]]);
    });
  });

  it("`来年以降` は其の年から絞る（第 475 回）、`今年度から` は並び方と絞れる欄を言う", () => {
    /* 第 328 回は「其れより後」を一日ぶんに寄せると嘘になるので絞り込まない決まりにしたが、
     * そのままだと 0 行なのに案内だけ「並びます」と書く形に成つて居た（実測 2026-11-08）。
     * 第 475 回で暦日を打つ形（第 413 回）と同じ決まり – 其の初日から其の年の中まで – で絞る
     * やうにした為、案内は出なくなる。`から` は幅の区切りでもあるので案内の侭残す。 */
    expect(行集合("来年以降").size, "「来年以降」が其の年から絞れて居ない").toBe(113);
    expect(Recommender.relativeDayNotes("来年以降", 基準)).toEqual([]);
    const 年度から = Recommender.relativeDayNotes("今年度から", 基準).join("");
    expect(年度から).toContain("2026年4月1日");
    expect(年度から).toContain("以降のこと");
  });

  it("件数欄は年度のかたまりを曜日まで含めて言い切る", () => {
    const 今年度 = Recommender.relativeDayNotes("今年度", 基準).join("");
    expect(今年度).toContain("2026年4月1日(水)〜2027年3月31日(水)");
    expect(今年度, "年度が 4 月からだと書いていない").toContain("4 月から翌年 3 月");
    const 来年度 = Recommender.relativeDayNotes("来年度中", 基準).join("");
    expect(来年度).toContain("2027年4月1日(木)〜2028年3月31日(金)");
  });

  it("意味が一通に決まらない年のかたまりは寄せない（締切の推測はしない）", () => {
    ["数年以内", "数年", "1年半以内"].forEach((語) => {
      expect(Recommender.queryTokenGroups(語, 基準), `"${語}" を勝手に解釈した`).toEqual([[語]]);
      expect(Recommender.relativeDayNotes(語, 基準).join(""), `"${語}" の案内を立てた`).toBe("");
      expect(行集合(語).size, `"${語}" が行を絞った`).toBe(0);
    });
    /* `2年以内` は第 339 回から解答を出す（黙って 0 件にしない – 画面の日数の欄と、1 年より
     * 長い幅は日数の語の外だと書く）。守るのは **解釈しない事** – 語のまま残り、行を絞らず、
     * 幅の日付も日数への換算も書かない（締切の推測はしない）。 */
    expect(Recommender.queryTokenGroups("2年以内", 基準), "`2年以内` を勝手に解釈した").toEqual([
      ["2年以内"],
    ]);
    expect(行集合("2年以内").size, "`2年以内` が行を絞った").toBe(0);
    const 二年以内 = Recommender.relativeDayNotes("2年以内", 基準).join("");
    expect(二年以内).toContain("締切まで");
    expect(二年以内, "`2年以内` に幅の日付を立てた").not.toMatch(/= 20[0-9]{2}年/);
    expect(二年以内, "`2年以内` を日数へ換えた").not.toContain("日以内 = ");
  });

  it("成果物と注入一覧が年度のかたまりを失っていない（ハーネスは名指し – 第 329 回）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    [
      "FISCAL_YEAR_OFFSETS_JA",
      "YEAR_SPAN_TAIL_JA",
      "HALF_YEAR_JA",
      "function relativeYearKeyJa",
      "function fiscalYearTermsJa",
    ].forEach((断片) => {
      expect(rec.includes(断片), `組み立てた画面から ${断片} が消えた`).toBe(true);
    });
    const 一覧 = readFileSync(join(REPO_ROOT, "tests", "built_golden_shared.ts"), "utf8");
    [
      "relativeYearKeyJa",
      "fiscalYearBaseJa",
      "fiscalYearTermsJa",
      "FISCAL_YEAR_OFFSETS_JA",
      "HALF_YEAR_DAYS_JA",
    ].forEach((名前) => {
      expect(一覧.includes(名前), `検索の入口の一覧に ${名前} の注入が無い`).toBe(true);
    });
  });
});
