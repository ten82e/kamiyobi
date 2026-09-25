/**
 * 語を並べて（空格で）打った人への案内の検査。SPEC §4・§7・第 354 回。
 * 実測（2026-10-12 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * 一篇で打てば案内の出る語も、空格で並べた瞬間に**案内が黙っていた**（`祝日 締切` 0 行・無案内
 * `祝日 2026年9月` 0 行・無案内 `参加費 無料` 0 行・無案内 `対面参加 2026年9月` 0 行・無案内
 * `年末年始 締切` 0 行・無案内 `ゴールデンウィーク オンライン` 0 行・無案内
 * `オフライン 参加費` 0 行・無案内）– 案内の表（`UI_WORD_GROUPS_JA`）は完全一致と語の活用の形しか
 * 見ていなかった（第 337 回）。画面の案内は 0 件の時しか出ない（`site/app.ts` の見張り）。
 */

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

/** 案内の語を並べた打ち方と、其の語が名指される事。 */
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
  it("空格で並べても、其の方の語を名指す案内が出る（0 件の侭 – 黙らない）", () => {
    for (const [打ち方, 語] of 並べた打ち方) {
      expect(行列表(打ち方).length, `${打ち方} に行が出てしまった`).toBe(0);
      const 案内 = Recommender.uiWordNoteJa(打ち方);
      expect(案内, `${打ち方} の案内が出ていない（黙った侭 0 件）`).toContain(`「${語}」`);
      const 読み上げ = Recommender.uiWordLiveNoteJa(打ち方);
      expect(読み上げ, `${打ち方} の読み上げが出ていない`).toContain(`「${語}」`);
    }
  });

  it("行は増えない – 案内の語を検索の語にしない", () => {
    /* 其の方の語で打った時と同じ行集合（案内だけが加わり、検索は変わらない）。 */
    expect(対称差("祝日 締切", "祝日"), "`祝日 締切` が行を作った").toBe(0);
    expect(対称差("参加費 無料", "参加費"), "`参加費 無料` が行を作った").toBe(0);
    /* 当たりの行が在る打ち方は、並べ方の案内に吸われない（行は其のまま動く）。 */
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

  it("二つの収録に無い語が並んだら、長い方を名指す（実測 – 打ち手の語に近い方）", () => {
    const 案内 = Recommender.uiWordNoteJa("無料 参加費");
    expect(案内, "`参加費` を名指していない（短い語で止まった）").toContain("「参加費」");
    expect(案内).toContain("費用の欄はありません");
  });
});

describe("案内を出す組の線引き", () => {
  it("二つの決まりの分かれ目 – 画面の使い方の語は並べた打ち手に出ない侭（第 250 回）", () => {
    /* 「この表が其の情報を持っていない」と告げる組（費用・区分・締切の確定・祝日・参加形式）は
     * 語を並べても案内が出る（上の検査）。一方、画面の使い方の語（`更新頻度` `印刷` `共有`…）を
     * 他の語と並べる打ち手は複合の絞り込みをしているので、案内を被せない（第 250 回の決まり –
     * `tests/meta_query_note.test.ts` `tests/export_query_hint.test.ts`
     * `tests/past_query_hint.test.ts` が其の方を張っている）。此の回合は其の二つが
     * 食い違わない所へ線を引いた（合図は `multiword` – 他の組に立てる改ざんを検査で検出した）。 */
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
  it("語の活用の形・問いの形の照合は其侭（語を並べた経路は其れより後ろに在る）", () => {
    /* `UI_WORD_TAILS_JA` の先（`したい` `の仕方` `はどこ`）を足した形は、第 248 回から
     * 案内が出る。語を並べた経路を活用の形の照合より前に置くと、一篇の語（語々經路は
     * 語が二つ以上の時だけ働く）で案内が消える – 実際に其の並び替えを作って落ちた。 */
    expect(Recommender.uiWordNoteJa("祝日したい")).toContain("「祝日」");
    expect(Recommender.uiWordNoteJa("参加費の仕方")).toContain("「参加費」");
    expect(Recommender.uiWordNoteJa("費用はどこ")).toContain("「費用」");
    expect(Recommender.uiWordLiveNoteJa("祝日したい")).toContain("「祝日」");
  });

  it("一篇で打った形と、日付を繋げた形の案内は其侭（其の方の規則を奪わない）", () => {
    expect(Recommender.uiWordNoteJa("祝日")).toContain("祝日・休日");
    expect(Recommender.uiWordNoteJa("祝日の締切")).toContain("「祝日の締切」");
    /* `年末締切` のように日付・期間の語を繋げた形は、其の方の規則が受ける（第 344・352 回）。 */
    expect(Recommender.querySynonymNotes("年末締切").join(" ")).toContain("「年末」");
    expect(対称差("年末締切", "年末 締切"), "`年末締切` が変わった").toBe(0);
    expect(対称差("週末締切", "週末 締切"), "`週末締切` が変わった").toBe(0);
    expect(対称差("バーチャル参加", "バーチャル"), "`バーチャル参加` が変わった").toBe(0);
    expect(行列表("土日").length, "案内が導く `土日` が 0 行").toBeGreaterThan(0);
  });
});

describe("成果物", () => {
  it("語を並べた経路は完全一致と活用の形の後ろに在る（其の方の案内を優先する順）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 本文 = jsFunction(rec, "uiWordMatch");
    expect(本文.length, "`uiWordMatch` が見つからない").toBeGreaterThan(0);
    const 完全一致 = 本文.indexOf(".toLowerCase() === q");
    const 含み = 本文.indexOf("uiWordContain(q)");
    const 並べた = 本文.indexOf("語々");
    expect(完全一致 >= 0, "完全一致の形が消えた").toBe(true);
    expect(含み > 完全一致, "活用の形の照合の順が変わった").toBe(true);
    expect(並べた > 含み, "語を並べた経路が前に出た（其の方の案内を奪う）").toBe(true);
  });
});
