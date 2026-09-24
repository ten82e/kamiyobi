/**
 * 「海外」で開催地を探す検査（SPEC §4・§7・第 335 回）。
 * 実測（2026-09-29 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * 画面のてびきは『海外の開催都市』を説明しているのに、`海外` `国外` `海外の会議` `海外開催`
 * `海外学会` はいずれも **0 行**だった。同じ意味の地域まとめは引けた（アジア 143 行・
 * 欧州 210 行・北米 235 行・中南米 33 行・アフリカ 16 行・オセアニア 8 行・中東 5 行、
 * 和集合 639 行）。`国内` は 38 行。
 * 検査ハーネスの品書（435 行）では 海外 274 行・国内 38 行 – 実ビルドの数を検査に書かない
 * （土俵を混ぜない – 第 331 回の教訓）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 地域まとめ = ["アジア", "欧州", "北米", "中南米", "アフリカ", "オセアニア", "中東"];

type 行 = { hay: string };

function 行列表(語: string): 行[] {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as 行[];
  const matches = Recommender.searchMatcher(語, 基準);
  return rows.filter((row) => matches(String(row.hay)) === true);
}

function 行集合(語: string): Set<string> {
  return new Set(行列表(語).map((row) => String(row.hay)));
}

function 対称差(a: Set<string>, b: Set<string>): number {
  return [...a].filter((行) => !b.has(行)).length + [...b].filter((行) => !a.has(行)).length;
}

function 案内(語: string): string[] {
  return Recommender.querySynonymNotes(語);
}

describe("開催地の「海外」", () => {
  it("「海外」は地域まとめの国すべてに出会う（収録の国名から導く – 国を並べ直さない）", () => {
    const 海外 = 行集合("海外");
    expect(海外.size, "『海外』が 0 行のまま（前提が崩れた）").toBeGreaterThan(0);
    const 和集合 = new Set<string>();
    // 地域ごとに 0 行かを検査しない（ハーネスの品書には オセアニア の行が無い – 実測 0 行。
    // 和集合が 0 でない事は上の『海外』> 0 で見ている）。
    地域まとめ.forEach((語) => {
      行集合(語).forEach((行) => {
        和集合.add(行);
      });
    });
    expect(対称差(海外, 和集合), "「海外」と地域まとめの和集合が割れた").toBe(0);
  });

  it("「国外」「海外開催」「かいがい」は「海外」と同じ行を出し、助詞を挟んでも同じ", () => {
    const 海外 = 行集合("海外");
    ["国外", "海外開催", "かいがい", "こくがい", "海外の会議"].forEach((語) => {
      expect(対称差(行集合(語), 海外), `"${語}" が「海外」と違う行を出した`).toBe(0);
    });
  });

  it("「海外」は国内の行を混ぜない（地域まとめは日本を含まない – 既定の約束）", () => {
    const 海外 = 行集合("海外");
    const 国内 = 行集合("国内");
    expect(国内.size, "『国内』が 0 行のまま（前提が崩れた）").toBeGreaterThan(0);
    expect([...海外].filter((行) => 国内.has(行)).length, "「海外」に国内研究会が混ざった").toBe(0);
    expect(
      [...海外].filter((行) => 行集合("日本").has(行)).length,
      "「海外」に日本開催が混ざった",
    ).toBe(0);
  });

  it("届かない範囲を件数欄に書く（地域の行でない行がある事を黙らない）", () => {
    expect(案内("海外").length, "案内の行数が違う").toBe(2);
    expect(案内("海外")[1]).toContain("開催地の国名が日本語で書かれた行");
    expect(案内("海外")[1]).toContain("国内研究会・国内シンポジウム」は含みません");
    expect(案内("国外")[1]).toContain("「国外」で出すのは");
    /* 地域まとめの語には範囲の案内を付けない（海外だけの注記）。 */
    expect(案内("アジア").length, "アジアまで範囲の案内を付けた").toBe(1);
    /* 「海外」が全行の補集合でない事は検査で留める – 補集合だと噓になる。 */
    const 海外 = 行集合("海外");
    const 全体 = 行集合("");
    expect(海外.size, "「海外」が全行に広がった").toBeLessThan(全体.size);
    expect(全体.size - 海外.size, "届かない行が 0 になった（案内が噓になる）").toBeGreaterThan(0);
  });

  it("他の語を足せば絞り込みになる", () => {
    const 海外 = 行集合("海外");
    const 絞った = 行集合("海外 ワークショップ");
    expect(絞った.size).toBeGreaterThan(0);
    expect(海外.size).toBeGreaterThan(絞った.size);
    expect([...絞った].filter((行) => !海外.has(行)).length, "足した語で行が増えた").toBe(0);
  });

  it("成果物が海外の語を地域まとめから導いた形のまま持つ（国を二重に書かない – 第 335 回）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    ["OVERSEAS_JA", "OVERSEAS_HEADS_JA", "OVERSEAS_COVERAGE_NOTE_TAIL_JA"].forEach((断片) => {
      expect(rec.includes(断片), `組み立てた画面から ${断片} が消えた`).toBe(true);
    });
    // 見出しの条目が「地域まとめの定数を並べ替えた形」である事 – 国を直に書き写したら落ちる。
    expect(
      /"海外",\s*"かいがい",\s*OVERSEAS_JA\s*\]/.test(rec),
      "海外の見出しが導出で無くなった（国を書き写した？）",
    ).toBe(true);
  });
});
