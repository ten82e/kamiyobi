import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { jsFunction } from "./runtime_extract.ts";

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

/** 案内の語を並べた打ち方と、その語が名指される事。 */
const 並べた打ち方: Array<[string, string]> = [
  ["祝日 締切", "祝日"],
  ["祝日 2026年9月", "祝日"],
  ["休日 会議", "休日"],
  ["年末年始 締切", "年末年始"],
  ["ゴールデンウィーク オンライン", "ゴールデンウィーク"],
  ["参加費 無料", "参加費"],
  /* 二つ収録に無い語が並んだ時は長い方を名指す（実測 – `オフライン` 4 字 > `参加費` 3 字）。 */
  ["オフライン 参加費", "オフライン"],
  ["対面参加 2026年9月", "対面参加"],
  ["お盆、締切", "お盆"],
  ["招待講演 workshop", "招待講演"],
];

describe("語を並べて打った人", () => {
  it("空格で並べても、その方の語を名指す案内が出る（0 件の侭 – 黙らない）", () => {
    for (const [打ち方, 語] of 並べた打ち方) {
      expect(行列表(打ち方).length, `${打ち方} に行が出てしまった`).toBe(0);
      const 案内 = Recommender.uiWordNoteJa(打ち方);
      expect(案内, `${打ち方} の案内が出ていない（黙った侭 0 件）`).toContain(`「${語}」`);
      const 読み上げ = Recommender.uiWordLiveNoteJa(打ち方);
      expect(読み上げ, `${打ち方} の読み上げが出ていない`).toContain(`「${語}」`);
    }
  });

  it("行は増えない – 案内の語を検索の語にしない", () => {
    /* その方の語で打った時と同じ行集合（案内だけが加わり、検索は変わらない）。 */
    expect(対称差("祝日 締切", "祝日"), "`祝日 締切` が行を作った").toBe(0);
    expect(対称差("参加費 無料", "参加費"), "`参加費 無料` が行を作った").toBe(0);
    /* 当たりの行がある打ち方は、並べ方の案内に吸われない（行はそのまま動く）。 */
    expect(行列表("バーチャル参加").length, "対照の `バーチャル参加` が 0 行").toBeGreaterThan(0);
    expect(Recommender.uiWordNoteJa("バーチャル参加"), "行が出る打ち方に 0 件案内を被せた").toBe(
      "",
    );
    expect(
      Recommender.querySynonymNotes("バーチャル参加").join(" "),
      "`バーチャル参加` の案内が消えた（第 350 回）",
    ).toContain("virtual");
  });

  it("語を並べた形は空格の数と区切りに動じない（実測で同じ行集合）", () => {
    expect(対称差("祝日 締切", "祝日  締切"), "空格の数で行が変わった").toBe(0);
    expect(対称差("祝日 締切", "祝日、締切"), "読点で区切ると行が変わった").toBe(0);
    expect(Recommender.uiWordNoteJa("祝日、締切")).toContain("「祝日」");
  });

  it("二つの収録にない語が並んだら、長い方を名指す（実測 – 打ち手の語に近い方）", () => {
    const 案内 = Recommender.uiWordNoteJa("無料 参加費");
    expect(案内, "`参加費` を名指していない（短い語で止まった）").toContain("「参加費」");
    expect(案内).toContain("費用の欄はありません");
  });
});

describe("案内を出す組の線引き", () => {
  it("二つの決まりの分かれ目 – 画面の使い方の語は並べた打ち手に出ない侭（第 250 回）", () => {
    for (const 文 of [
      "更新頻度 2026",
      "印刷 関西",
      "信頼性 機械学習",
      "ics 関西",
      "過去の締切 関西",
    ]) {
      expect(
        Recommender.uiWordNoteJa(文),
        `"${文}" に案内を被せた（第 250 回の決まりを壊した）`,
      ).toBe("");
    }
  });
});

describe("壊していない物", () => {
  it("語の活用の形・問いの形の照合は其侭（語を並べた経路はそれより後ろにある）", () => {
    expect(Recommender.uiWordNoteJa("祝日したい")).toContain("「祝日」");
    expect(Recommender.uiWordNoteJa("参加費の仕方")).toContain("「参加費」");
    expect(Recommender.uiWordNoteJa("費用はどこ")).toContain("「費用」");
    expect(Recommender.uiWordLiveNoteJa("祝日したい")).toContain("「祝日」");
  });

  it("一篇で打った形と、日付を繋げた形の案内は其侭（その方の規則を奪わない）", () => {
    expect(Recommender.uiWordNoteJa("祝日")).toContain("祝日・休日");
    expect(Recommender.uiWordNoteJa("祝日の締切")).toContain("「祝日の締切」");
    /* `年末締切` のように日付・期間の語を繋げた形は、その方の規則が受ける（第 344・352 回）。 */
    expect(Recommender.querySynonymNotes("年末締切").join(" ")).toContain("「年末」");
    expect(対称差("年末締切", "年末 締切"), "`年末締切` が変わった").toBe(0);
    expect(対称差("週末締切", "週末 締切"), "`週末締切` が変わった").toBe(0);
    expect(対称差("バーチャル参加", "バーチャル"), "`バーチャル参加` が変わった").toBe(0);
    expect(行列表("土日").length, "案内が導く `土日` が 0 行").toBeGreaterThan(0);
  });
});

describe("成果物", () => {
  it("語を並べた経路は完全一致と活用の形の後ろにある（その方の案内を優先する順）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    /* 第 683 回 – 選ぶ事の訪ねを剥ぐ為、当てはめ本体は `uiWordMatch文` に分けた（經路の順は其侭）。*/
    const 本文 = jsFunction(rec, "uiWordMatch文");
    expect(本文.length, "`uiWordMatch文` が見つからない").toBeGreaterThan(0);
    const 完全一致 = 本文.indexOf(".toLowerCase() === q");
    const 含み = 本文.indexOf("uiWordContain(q)");
    const 並べた = 本文.indexOf("語々");
    expect(完全一致 >= 0, "完全一致の形が消えた").toBe(true);
    expect(含み > 完全一致, "活用の形の照合の順が変わった").toBe(true);
    expect(並べた > 含み, "語を並べた経路が前に出た（その方の案内を奪う）").toBe(true);
  });

  it("選ぶ事を訪ねて終る形の崩しは、その侬が彈いた後でだけ見る（第 683 回）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 入口 = jsFunction(rec, "uiWordMatch");
    expect(入口.length, "`uiWordMatch` が見つからない").toBeGreaterThan(0);
    /* 崩した形（読点・`はどれ` 等を剥いだ物）を先に数へると、`分野は幾つ` が「分野」一文字に
     * 落ちて第 649 回の案内を奪ふ（実測）。その侬 → 崩 の順を產出物で張る。*/
    expect(入口, "崩した形の道が消えた").toContain("uiWordMatch文(崩)");
    expect(
      入口.indexOf("uiWordMatch文(生)") < 入口.indexOf("uiWordMatch文(崩)"),
      "崩した形が先に数はれる（先の尖つた案内を奪ふ）",
    ).toBe(true);
  });
});
