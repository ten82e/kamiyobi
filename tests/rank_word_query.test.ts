/**
 * 催し物の格を日本語のまわし言葉で打った人への案内の検査。SPEC §4・§7・第 357 回。
 * 実測（2026-10-15 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `A*` 159 行・`A` 320 行が通るのに、`メジャー` `主要会議` `トップ会議` `有力会議` `ハイクラス`
 * `一流` `ランキング` `有名な会議` はいずれも **0 行で案内も無し**だった。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { jsFunction } from "./runtime_extract.ts";

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

/** 四つの入口を束ねた全案内（第 353 回以降の決まり）。 */
function 全案内(語: string): string {
  return [
    Recommender.querySynonymNotes(語).join(" "),
    Recommender.uiWordNoteJa(語),
    Recommender.uiWordLiveNoteJa(語),
    Recommender.relativeDayNotes(語, 基準).join(" "),
  ]
    .filter((文) => 文)
    .join(" ∥ ");
}

const 格の打ち方 = [
  "メジャー",
  "メジャー会議",
  "主要",
  "主要会議",
  "主要な会議",
  "主要学会",
  "トップ会議",
  "トップクラス",
  "トップジャーナル",
  "有力",
  "有力会議",
  "ハイクラス",
  "一流",
  "一流会議",
  "ランキング",
  "ランキング順",
  "有名な会議",
  "主要 オンライン",
  "ハイクラス 機械学習",
];

describe("格を日本語で打った人", () => {
  it("其の方の絞りに導す案内が、打ち方に依らず出る", () => {
    for (const 語 of 格の打ち方) {
      expect(行列表(語).length, `\`${語}\` が行を出すようになった（案内ではなく寄せた）`).toBe(0);
      const 案内 = Recommender.uiWordNoteJa(語);
      const 名指す語 = 語.split(/[\s、]+/)[0];
      expect(案内, `「${語}」の案内が出ていない`).toContain(`「${名指す語}」`);
      expect(案内, `「${語}」の案内が選択欄の名前を言っていない`).toContain("『ランク』");
      expect(案内, `「${語}」の案内が検索欄で打てる等級を教えない`).toContain("『A*』");
      expect(全案内(語), `「${語}」の読み上げが出ていない`).toContain("クイック抽出");
      expect(
        Recommender.uiWordLiveNoteJa(語),
        `「${語}」の読み上げが選択欄の名前を落とした`,
      ).toContain("『ランク』");
    }
  });

  it("案内の文は打ち方に依らない（打っていない格の語を名指さない）", () => {
    const 本体 = (語: string) => Recommender.uiWordNoteJa(語).replace(`「${語}」`, "");
    expect(本体("ハイクラス")).toBe(本体("主要会議"));
    expect(本体("一流会議")).toBe(本体("メジャー"));
    for (const 語 of [
      "メジャー",
      "主要",
      "一流",
      "ハイクラス",
      "ランキング",
      "トップ会議",
      "有力",
    ]) {
      expect(Recommender.uiWordNoteJa("主要会議"), `文が \`${語}\` を名指している`).not.toContain(
        `『${語}』`,
      );
    }
  });

  it("案内が導す物は本当に効く（画面の語は画面の正本から読む – 第 319 回）", () => {
    /* 検索欄に打つ形は実際に行が出る。**品書の絶対値を張らない**（第 344・355 回 – 実品書では
     * `A*` 159 行・`A` 320 行だが、検査の品書では等級の語の載り方が違う – 実測）ので、
     * 案内が名指す等級の語のうち品書で行が出る物が在る事を見る。 */
    const 等級 = ["A*", "A", "B", "C"];
    const 効く = 等級.filter((語) => 行列表(語).length > 0);
    expect(
      効く.length,
      `案内が名指す等級の語（${等級.join("・")}）が検査の品書で全部 0 行`,
    ).toBeGreaterThan(0);
    /* 画面の選択欄とクイック抽出のボタンは其の方の名前でビルドに在る。 */
    const 画面 = readFileSync(join(builtSite(), "index.html"), "utf8");
    expect(画面, "画面に『ランク』の選択欄が無いのに案内が書いている").toContain(
      '<label for="rank">ランク</label>',
    );
    expect(画面, "『A*ランク』のクイック抽出のボタンが無いのに案内が書いている").toContain(
      'data-preset="a_star"',
    );
    expect(画面).toContain("A*ランク");
  });
});

describe("他の語の案内は其侭", () => {
  it("等級の案内・穴場・休日の案内・柔らかい範囲の案内は其侭", () => {
    expect(Recommender.querySynonymNotes("評価").join(" ")).toContain("等級を絞れていません");
    expect(Recommender.querySynonymNotes("評価が高い").join(" ")).toContain("等級を絞れていません");
    expect(行列表("穴場").length, "`穴場` が落ちた").toBeGreaterThan(0);
    expect(全案内("国内会議"), "`国内会議` の案内が消えた").toContain("国内");
    expect(Recommender.uiWordNoteJa("月初")).toContain("公用の決まりが無い");
    expect(Recommender.uiWordNoteJa("月前半")).toContain("『上旬』");
    expect(Recommender.uiWordNoteJa("祝日 締切")).toContain("「祝日」");
  });

  it("格の語を寄せた形にはしない（行を増やさない – 収録の契約）", () => {
    /* 案内だけを出す決まり: 格の語は行の語ではないので、寄せると行集合が変わる。 */
    for (const 語 of ["メジャー", "主要会議", "ハイクラス"]) {
      const 並べた = 行列表(`${語} オンライン`);
      expect(並べた.length, `\`${語} オンライン\` に行が出てしまった`).toBe(0);
    }
  });
});

describe("成果物", () => {
  it("導しの文が成果物に一度だけ入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const 断片 of [
      "『ランク』の選択欄か『A*ランク』のクイック抽出のボタン",
      "評価は『ランク』の選択欄か『A*ランク』のクイック抽出",
    ]) {
      expect(rec.split(断片).length - 1, `成果物の中の断片 \`${断片.slice(0, 12)}…\` の数`).toBe(1);
    }
  });

  it("格の語は寄せない（其の方の絞りへの書き換えを作らない – 収録の契約）", () => {
    /* 案内ではなく **行を増やす**直し（`主要会議` を `A*` に寄せる等）は、収録の契約を壊す –
     * 格の語は行の語ではないので寄せた瞬間に行集合が変わる。行の検査は品書の載り方に依る
     * （検査の品書では `A*` が 0 行 – 実測で其れでは捕まらないと分かった）ので、
     * 寄せの関数その物に格の語が現れない事を張る。 */
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 関数 = jsFunction(rec, "collapseRelativeDayPhrase");
    expect(関数.length, "`collapseRelativeDayPhrase` が見つからない").toBeGreaterThan(0);
    for (const 語 of ["主要", "メジャー", "ハイクラス", "一流", "ランキング"]) {
      expect(
        関数,
        `寄せの関数が \`${語}\` を扱うようになった（行が増えていないか見る）`,
      ).not.toContain(語);
    }
  });
});
