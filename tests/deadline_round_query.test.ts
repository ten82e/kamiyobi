/**
 * 締切の回（ラウンド）の言い方の検査（SPEC §4・§7・第 334 回）。
 * 実測（2026-09-28 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * 画面が行に「第1ラウンド」の語を出していて（`第1ラウンド` 767 行・`第2ラウンド` 71 行・
 * `第3ラウンド` 15 行・`第4ラウンド` 3 行）、それ以外の打ち方は黙っていた –
 * `第1回` `第2回` `1回目` `初回` `1次締切` `ラウンド2` `1ラウンド目` `第1回締切` いずれも **0 行**。
 * 検査ハーネスの品書（435 行）には 3 回目以降のラウンドが無いので（実測 `第3回` 0 行）、
 * 3 回目以降は「案内は出るが 0 件」側で pins する – 土俵を混ぜない（第 331 回の教訓）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 行列表(語: string): Array<{ key?: string; hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{
    key?: string;
    hay: string;
  }>;
  const matches = Recommender.searchMatcher(語, 基準);
  return rows.filter((row) => matches(String(row.hay)) === true);
}

function 行集合(語: string): Set<string> {
  return new Set(行列表(語).map((row) => String(row.key ?? row.hay)));
}

function 差分(a: Set<string>, b: Set<string>): number {
  return [...a].filter((k) => !b.has(k)).length + [...b].filter((k) => !a.has(k)).length;
}

describe("締切の回（ラウンド）", () => {
  it("「第1回」「初回」「1回目」「1次締切」は、画面の語と同じ行に出会う", () => {
    const 一回 = 行集合("第1ラウンド");
    expect(一回.size, "『第1ラウンド』が 0 行のまま（前提が崩れた）").toBeGreaterThan(0);
    [
      "第1回",
      "初回",
      "1回目",
      "第一回",
      "一回目",
      "ラウンド1",
      "1ラウンド目",
      "1次締切",
      "第1回締切",
      "第１回",
    ].forEach((語) => {
      expect(差分(行集合(語), 一回), `"${語}" が「第1ラウンド」と違う行を出した`).toBe(0);
    });
  });

  it("「第2回」は 2 回目の行だけを出し、1 回目の行を混ぜない", () => {
    const 二回 = 行集合("第2回");
    expect(二回.size, "『第2回』が 0 行のまま（前提が崩れた）").toBeGreaterThan(0);
    expect(差分(二回, 行集合("第2ラウンド"))).toBe(0);
    expect(差分(行集合("二回目"), 二回)).toBe(0);
    expect(差分(行集合("ラウンド2"), 二回)).toBe(0);
    /* 行は一つの回しか持たないので、回は重ならない（旬とは違う – 第 332 回）。 */
    expect(
      [...行集合("第1回")].filter((行) => 二回.has(行)).length,
      "1 回目と 2 回目が重なった",
    ).toBe(0);
  });

  it("寄せた事は件数欄に画面の語で書く（打ち手に寄せ先を隠さない）", () => {
    const 案内 = Recommender.querySynonymNotes("第2回");
    expect(案内.length, "案内が 1 件ではない").toBe(1);
    expect(案内[0]).toContain("「第2回」は締切の回「第2ラウンド」で探しています");
    expect(Recommender.querySynonymNotes("初回")[0]).toContain("締切の回「第1ラウンド」");
  });

  it("収録に無い回は案内だけ出て、行は出さない（3 回目以降はハーネスの品書に無い）", () => {
    expect(行集合("第3回").size, "ハーネスの品書に 3 回目が現れた（前提が変わった）").toBe(0);
    const 案内 = Recommender.querySynonymNotes("第3回");
    expect(案内.length, "案内を立てていない").toBe(1);
    expect(案内[0]).toContain("第3ラウンド");
  });

  it("表の外（6 回目以降）は寄せない – 黙った 0 件にしないためではなく、無い語を發明しないため", () => {
    ["第6回", "第12回", "七回目"].forEach((語) => {
      expect(行集合(語).size, `"${語}" を受けてしまった`).toBe(0);
      expect(Recommender.querySynonymNotes(語).join(""), `"${語}" の案内を立てた`).toBe("");
    });
  });

  it("他の語を足せば絞り込みになる", () => {
    const 回 = 行集合("第1回");
    const 絞った = 行集合("第1回 ワークショップ");
    expect(絞った.size).toBeGreaterThan(0);
    expect(回.size).toBeGreaterThan(絞った.size);
    expect([...絞った].filter((行) => !回.has(行)).length, "足した語で行が増えた").toBe(0);
  });

  it("画面が出す回の語が表として成果物に残る（寄せ先の語が画面の語である根拠 – 第 334 回）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    /* 表その物を取り出して見る – 回の語は検索の寄せ先の説明文にも同じ語で出るため、
     * 成果物全体を眺めるだけでは表が壊れた事に気づかない（第 334 回の改ざん検査で実測した穴）。 */
    const 表 = /const ROUND_LABELS_JA = \[([\s\S]*?)\];/.exec(rec);
    expect(表, "画面が出す締切の回の語の表が成果物から見えない").not.toBeNull();
    const 中身 = (表 as unknown as RegExpExecArray)[1];
    for (let n = 1; n <= 5; n += 1) {
      expect(中身.includes(`"第${n}ラウンド"`), `回の表から 第${n}ラウンド が消えた`).toBe(true);
    }
    expect(表 as unknown as RegExpExecArray, "回の語の表が無い").not.toBeNull();
  });
});
