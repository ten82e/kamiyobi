/**
 * 収録していない情報を訪ねる言い方の案内（第 378 回）。
 * 実測（2026-09-25 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `参加費` `参加料` `登録費` `旅費` `学生割引` と `祝日` `連休` `振替休日` `年末年始` には
 * 「収録していません」の案内が出るのに、其の群の近傍の言い方 – `受講料` `学生料金` `登録料`
 * `参加登録費` `祝祭日` `三連休` `土日祝` `休暇` – は **0 行で案内も無し**、`共催` `後援` `協賛`
 * `スポンサー` と `ピアレビュー` `二重盲検` `ダブルブラインド` `ブラインド審査` `査読方式` は
 * **群その物が無く 0 行で案内も無し**だった（画面は「0 件」だけで、無い物が無いと分からなかった）。
 * 案内が噓にならない語だけを入れる（当たり語を入れると噓になる – 第 337 回）。
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

/** 画面上の短い案内（読み上げに出る語）。 */
function 短い案内(語: string): string {
  const 列: Array<(q: string) => string> = [
    (q) => String(Recommender.columnQueryLiveNoteJa(q) || ""),
    (q) => String(Recommender.uiWordLiveNoteJa(q) || ""),
    (q) => String(Recommender.dayRangeLiveNoteJa(q) || ""),
    (q) => String(Recommender.wholeTableQueryNoteJa(q) || ""),
  ];
  for (const 取 of 列) {
    const 得 = 取(語);
    if (得) return 得;
  }
  return "";
}

/** 行が 0 本の時に出る長文の案内（件数欄）。 */
function 長い案内(語: string): string {
  return String(Recommender.uiWordNoteJa(語) || "");
}

describe("収録していない情報を訪ねる言い方", () => {
  it("費用の群の近傍の言い方に、費用の欄が無い事を其の場で書く（第 378 回）", () => {
    for (const 語 of ["受講料", "学生料金", "登録料", "参加登録費"]) {
      expect(行列表(語).length, `絞り込まない: ${語}`).toBe(0);
      expect(短い案内(語), `案内が出る: ${語}`).toContain("費用の欄");
      expect(長い案内(語), `長文も費用を書く: ${語}`).toContain("費用の欄");
    }
  });

  it("祝日の群の近傍の言い方に、曜日と日付で引ける事を其の場で書く（第 378 回）", () => {
    for (const 語 of ["祝祭日", "三連休", "土日祝", "休暇", "祝祭日の締切", "三連休の締切"]) {
      expect(行列表(語).length, `絞り込まない: ${語}`).toBe(0);
      const 文 = 短い案内(語);
      expect(文, `案内が出る: ${語}`).toContain("祝日・休日は収録していません");
      expect(文, `曜日の代替を書く: ${語}`).toContain("土日");
      expect(長い案内(語), `長文は日付でも引けると書く: ${語}`).toContain("9月22日");
    }
  });

  it("主催・共催・後援・協賛の群を新設し、名前で引ける道を書く（第 378 回）", () => {
    for (const 語 of ["共催", "後援", "協賛", "スポンサー", "共催の締切", "後援の締切"]) {
      expect(行列表(語).length, `絞り込まない: ${語}`).toBe(0);
      const 文 = 短い案内(語);
      expect(文, `案内が出る: ${語}`).toContain("主催・共催・後援・協賛");
      expect(文, `名前で引ける道を書く: ${語}`).toContain("名前の断片");
      expect(長い案内(語), `長文も其の区別が無いと書く: ${語}`).toContain("打つ欄がありません");
    }
  });

  it("審査の方式の群を新設し、審査の段階の日は有ると噓なく書く（第 378 回）", () => {
    for (const 語 of [
      "ピアレビュー",
      "二重盲検",
      "ダブルブラインド",
      "ブラインド審査",
      "査読方式",
      "審査方式",
    ]) {
      expect(行列表(語).length, `絞り込まない: ${語}`).toBe(0);
      const 文 = 短い案内(語);
      expect(文, `案内が出る: ${語}`).toContain("審査の方式を書く欄は無いです");
      expect(文, `締切の語で絞れると書く: ${語}`).toContain("査読");
    }
    /* 案内が名指す語へ収録に無い案内を付けない（其の方の語を通すと言っている – 実測
     * 872 行の品書で『査読』13 行・『採択』129 行 – ハーネスの品書では行数が変わるので
     * 案内が出ていない事だけ見る。其の方の語に案内を付けたら噓になる – 第 337 回）。 */
    expect(長い案内("査読"), "『査読』へ収録に無い案内を付けない").toBe("");
    expect(長い案内("採択"), "『採択』へ収録に無い案内を付けない").toBe("");
  });

  it("其の方で通る語を群に入れない（案内が噓になる – 第 337 回）", () => {
    /* 実測 872 行の品書で 夏季 6 行・早期登録 7 行・早期割引 7 行（ハーネスの品書では
     * 行数が足りないので、其の方の語へ「収録に無い」の案内を付けていない事を見る）。 */
    for (const 語 of ["夏季", "早期登録", "早期割引", "査読", "採択"]) {
      expect(長い案内(語), `収録に無い案内を付けない: ${語}`).toBe("");
    }
  });

  it("其れ以前の群の案内は其侭（費用・参加形式・祝日・催し物の区別 – 第 337 回・第 353 回）", () => {
    expect(短い案内("参加費")).toContain("費用の欄");
    expect(短い案内("対面")).toContain("オンライン参加可");
    expect(短い案内("祝日")).toContain("祝日・休日は収録していません");
    expect(短い案内("招待講演")).toContain("催し物の名前でなら当たります");
    expect(行列表("祝日").length).toBe(0);
    expect(行列表("オンライン").length, "収録の印は通る").toBeGreaterThan(0);
  });

  it("直し方が実測どおりの形で成果物に入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 条目列表: Array<[string, number]> = [
      /* 費用の群と祝日の群へ語を足し、新しい群を二つ増やした。 */
      ['"受講料",', 1],
      ['"学生料金",', 1],
      ['"登録料",', 1],
      ['"参加登録費",', 1],
      ['"祝祭日",', 1],
      ['"三連休",', 1],
      ['"土日祝",', 1],
      ['"休暇",', 1],
      /* 新しい群 – 其の方の語が其の語に無い実測（sponsor / peer review / double-blind 0 件）を見た語だけ。 */
      ['"共催",', 1],
      ['"後援",', 1],
      ['"協賛",', 1],
      ['"ピアレビュー",', 1],
      ['"二重盲検",', 1],
      ["は持っていません – 主催・共催・後援・協賛の区別は無いです", 1],
      ["の区別は収録していません – 審査の方式を書く欄は無いです", 1],
    ];
    for (const [条目, 数] of 条目列表) {
      expect(rec.split(条目).length - 1, `成果物の中の語の数: ${条目.slice(0, 18)}`).toBe(数);
    }
  });
});
