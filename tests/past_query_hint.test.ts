/**
 * 「過去の締切」を**検索欄に打った人**の検査（SPEC §4・§7・第 320 回）。
 * 一覧には「過去の締切も表示」のチェック欄があるが、その名前の語を検索欄に打つ人は
 * 0 行で、案内も無かった（2026-08-09 生成ビルド・固定時刻 2026-08-09 で実測:
 * `過去の締切` `過ぎた締切` `終わった締切` `終了した締切` `過去のもの` `過去の分` `過去分`
 * `過去の一覧` `過去` `履歴` はいずれも**品書 872 行でも `data.json` 3,253 行でも 0 行**、
 * `uiWordNoteJa` `dayRangeNoteJa` `columnQueryNoteJa` もすべて空）。
 * 過ぎた締切は 2,325 行（収録の七割）在るので、「在るとも無いとも言われない」行き止まりだった。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string; t: number; conf?: { key?: string } };

const AT = Date.parse("2026-08-09T00:00:00Z");
const 対象の語 = [
  "過去の締切",
  "過ぎた締切",
  "終わった締切",
  "終了した締切",
  "過去のもの",
  "過去の分",
  "過去分",
  "過去の一覧",
  "過去の締切を見る",
  "過ぎた締切を見る",
  "過去を表示",
  "過去",
  "履歴",
];

function 読み込み(ファイル: string): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), ファイル), "utf8")),
  ) as Row[];
}

function 当たり行数(rows: Row[], query: string): number {
  const match = Recommender.searchMatcher(query, AT);
  return rows.filter((row) => match(row.hay) === true).length;
}

describe("「過去の締切」を打った人", () => {
  it("0 行のまま放さず、チェック欄の話をその場で言う", () => {
    const 品書 = 読み込み("catalog.json");
    const 全件 = 読み込み("data.json");
    expect(全件.length, "品書より少ない（ビルド成果物が読めない）").toBeGreaterThan(品書.length);
    対象の語.forEach((語) => {
      expect(当たり行数(品書, 語), `"${語}" が品書で当たった（前提が変わった）`).toBe(0);
      expect(当たり行数(全件, 語), `"${語}" が収録全体で当たった（前提が変わった）`).toBe(0);
      const 文 = Recommender.uiWordNoteJa(語);
      expect(文, `"${語}" を打った人に何も案内していない`).not.toBe("");
      expect(文.includes("過去の締切も表示"), `"${語}": チェック欄の語を書いていない`).toBe(true);
      /* 「既定で除いている」を省くと、0 件が「この表に過去が無い」話に読める。 */
      expect(文.includes("既定"), `"${語}": 既定で出ていないことを言っていない`).toBe(true);
      expect(
        文.includes("絞り込めません") || 文.includes("当たりません"),
        `"${語}": 検索で引けないとはっきり言っていない`,
      ).toBe(true);
    });
  });

  it("案内が書くチェック欄の名前は、画面の正本と一致する", () => {
    const html = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
    const 画面の語 = /id="past">\s*<span>([^<]+)<\/span>/.exec(html)?.[1];
    expect(画面の語, "チェック欄の見出しが見つからない").toBe("過去の締切も表示");
    対象の語.forEach((語) => {
      const 文 = Recommender.uiWordNoteJa(語);
      expect(文.includes(画面の語 || ""), `"${語}" の案内が画面の見出しと違う語を書いている`).toBe(
        true,
      );
      const 音声 = Recommender.uiWordLiveNoteJa(語);
      expect(
        音声.includes(画面の語 || ""),
        `"${語}" の読み上げが画面の見出しと違う語を書いている`,
      ).toBe(true);
    });
  });

  it("語を打ち足しても当たらないことを、案内が隠さない", () => {
    /* チェック欄をオンにしてからこの語を打つ人は「出ない」と受け取る – 実測で品書・収録とも
     * 0 行なので、案内は「出し分けはトグルだけで」と言わなければならない。 */
    対象の語.forEach((語) => {
      const 文 = Recommender.uiWordNoteJa(語);
      expect(
        文.includes("トグル") || 文.includes("チェック"),
        `"${語}": 出し分けが操作側であることを言っていない`,
      ).toBe(true);
    });
  });

  it("他の案内と二重にならず、他の打ち方には立たない", () => {
    対象の語.forEach((語) => {
      /* 同じ場所を指す案内を二つ積むと件数欄が読めなくなる（第 319 回と同じ型）。 */
      expect(Recommender.dayRangeNoteJa(語), `"${語}" に範囲の案内が重なった`).toBe("");
      expect(Recommender.columnQueryNoteJa(語), `"${語}" に欄の案内が重なった`).toBe("");
    });
    /* 語は打ち切り一致 – 他の打ち方に混ざって案内が立っては絞れない。 */
    ["論文締切", "締切", "〆切", "過去の締切 関西", "過ぎた", "締切 履歴"].forEach((語) => {
      expect(Recommender.uiWordNoteJa(語), `"${語}" に案内が立ってしまった`).toBe("");
    });
  });

  it("案内が言う通り、過ぎた締切は在って品書の外でもある", () => {
    /* ビルドハーネスの成果物（試験用の品書）で「既定で出る行」と「品書の外の行」を見る。
     * 実データの規模（2026-08-09 生成で過ぎた締切 2,325 行 / 収録 3,253 行）は §7 第 320 回に書いた。 */
    const 品書 = 読み込み("catalog.json");
    const 全件 = 読み込み("data.json");
    const 品書の鍵 = new Set(品書.map((row) => String(row.conf?.key || "")));
    const 過ぎ = 全件.filter((row) => Number(row.t) < AT);
    expect(過ぎ.length, "過ぎた締切が無く案内が空振り").toBeGreaterThan(5);
    const 品の外 = 過ぎ.filter((row) => !品書の鍵.has(String(row.conf?.key || ""))).length;
    expect(品の外, "品書に無い過ぎた締切が無く「追加で読み込みます」が噓になる").toBeGreaterThan(0);
    /* 収録全体（実データ）でも、既定で隠れる塊が大きいこと – 案内を出す価値の裏付け。 */
    const 収録 = Recommender.candidateRows(
      JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")),
    ) as Row[];
    expect(
      収録.filter((row) => Number(row.t) < AT).length,
      "収録の過ぎた締切の塊が小さい（前提が変わった）",
    ).toBeGreaterThan(1000);
  });
});
