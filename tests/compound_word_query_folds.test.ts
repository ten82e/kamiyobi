/**
 * 語を繋げて打たれた形の寄せの検査。SPEC §4・§7・第 363 回。
 * 実測（2026-10-20 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * 直し前は `チュートリアルセッション` `ポスターセッション` `ワークショップ形式` `カメラレディ期限`
 * `早期登録締切` `分散コンピューティング` `組込みシステム` `埋め込みシステム` の八形が
 * **0 行で案内も無し**だった（其の方の `チュートリアル` 6 行・`ポスター` 6 行・`ワークショップ` 126 行・
 * `カメラレディ` 70 行・`早期登録` 7 行・`分散システム` 259 行・`組込み` 259 行は通った）。
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

/** 打ち方の語 → 其の方の収録の語（画面に出る語 – 行集合が一字も違わない事）。 */
const 寄せ: Array<[string, string]> = [
  ["チュートリアルセッション", "チュートリアル"],
  ["ポスターセッション", "ポスター"],
  ["ワークショップ形式", "ワークショップ"],
  ["カメラレディ期限", "カメラレディ"],
  ["早期登録締切", "早期登録"],
  ["分散コンピューティング", "分散システム"],
  ["組込みシステム", "組込み"],
];

describe("語を繋げて打たれた形", () => {
  it("其の方の語の行集合と一字も違わない（行を作らない – 第 337 回）", () => {
    for (const [打ち方, 収録の語] of 寄せ) {
      expect(対称差(打ち方, 収録の語), `\`${打ち方}\` が \`${収録の語}\` と違う行を出した`).toBe(0);
    }
    /* 検査の品書（435 行）で其の方の語が出てから張っている事を見せる（第 357 回 – 空振りの防止）。 */
    const 出る = 寄せ.filter(([打ち方]) => 行列表(打ち方).length > 0);
    expect(
      出る.length,
      "寄せた形が検査の品書で 0 行（対称差ゼロが空になっている）",
    ).toBeGreaterThanOrEqual(5);
  });

  it("其の場で何を探したか言い、打ち方を名指す", () => {
    for (const [打ち方] of 寄せ) {
      const 案内 = Recommender.querySynonymNotes(打ち方).join(" ");
      expect(案内, `\`${打ち方}\` に案内が無い（0 行と無言に戻った）`).toContain(`「${打ち方}」`);
      expect(案内, `\`${打ち方}\` の案内が探し方を言っていない`).toMatch(/探して|絞れ/);
    }
  });

  it("繋げたら何でも寄せない（意味が変わる形は寄せない – 手で選んだ事の見張り）", () => {
    /* 実測で「繋げた形」の候補は三千件を超えた – 其の内、意味が変わらない形だけを選んだ。
     * 仕組みで末尾を剥がす直し方をしたら、下の形が全部行を出すようになる（対称差で見ない –
     * 検査の品書で両方が 0 行になり得るので、成果物の正本の形で張る – 第 362 回）。 */
    const 寄せない = [
      "システム講演",
      "システム期限",
      "分散セッション",
      "組込み形式",
      "チュートリアル期限",
      "ポスター応募",
    ];
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 頭 = "const QUERY_SYNONYMS_JA = [";
    const i = rec.indexOf(頭);
    expect(i, "成果物に寄せ表が見つからない").toBeGreaterThan(0);
    const 本文 = rec.slice(i, rec.indexOf("];", i));
    expect(本文, "寄せ表の読み取りが短すぎる（切り出しが壊れている）").toContain("スパコン");
    for (const 語 of 寄せない) {
      expect(本文, `寄せ表に \`${語}\` が現れた（末尾を何でも剥がす仕組みにした）`).not.toContain(
        `["${語}",`,
      );
      expect(行列表(語).length, `\`${語}\` に行が出るようになった`).toBe(0);
    }
  });

  it("表その物の語と他の家系の案内を壊さない（第 245 回・第 362 回）", () => {
    /* 締切・表その物の語は寄せない決まり – 其の方の語のサンプルは其侭 0 行。 */
    for (const 語 of ["提出期限", "投稿期限", "締切日", "しめきり"]) {
      expect(行列表(語).length, `\`${語}\` を寄せてしまった`).toBe(0);
      expect(Recommender.querySynonymNotes(語).join(""), `\`${語}\` に寄せの案内を立てた`).toBe("");
    }
    /* 他の回で直した家が其侭働く事。 */
    expect(対称差("穴場会議", "穴場"), "穴場の寄せが壊れた").toBe(0);
    expect(対称差("生成AI", "generative"), "分野の寄せが壊れた").toBe(0);
    expect(対称差("イングランド", "england"), "開催地の寄せが壊れた").toBe(0);
    expect(Recommender.uiWordNoteJa("小規模会議"), "規模の案内が消えた").toContain("穴場");
    expect(Recommender.uiWordNoteJa("締切間近"), "締切の近さの案内が消えた").toContain("7 日");
    expect(Recommender.uiWordNoteJa("大会"), "催し物の呼び方の案内が消えた").toContain(
      "現れません",
    );
  });

  it("開発側の語を画面に出さない決まりと噛み合わない寄せを足さない（埋め込み – 第 363 回）", () => {
    /* 「埋め込み」は此の画面に出す文言に置かない語（`tests/build_golden.test.ts` が張っている）。
     * 案内は打ち方をそのまま名指すので、其の方を寄せの語にすると其の決まりに当たる –
     * 一度足して落ちて、下ろした（其れを検査に張る）。 */
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 頭 = "const QUERY_SYNONYMS_JA = [";
    const i = rec.indexOf(頭);
    expect(rec.slice(i, rec.indexOf("];", i)), "寄せ表に `埋め込み` の条目が現れた").not.toContain(
      '["埋め込み',
    );
    expect(行列表("埋め込みシステム").length, "`埋め込みシステム` が行を出すようになった").toBe(0);
    expect(
      行列表("組込みシステム").length,
      "其の方の `組込みシステム` が通らなくなった",
    ).toBeGreaterThan(0);
  });

  it("画面に出る種別の語を名指す（カメラレディ – 第 319 回）", () => {
    const html = readFileSync(join(builtSite(), "index.html"), "utf8");
    expect(html, "画面に種別『カメラレディ』が出ていない").toContain("カメラレディ");
    const 案内 = Recommender.querySynonymNotes("カメラレディ期限").join(" ");
    expect(案内, "案内が画面の種別の語を名指していない").toContain("カメラレディ");
  });
});

describe("成果物", () => {
  it("八つの寄せ条目が、実測どおりの回数で成果物に入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const [条目, 数] of [
      ['["チュートリアルセッション", "原文の tutorial という語", ["tutorial"]]', 1],
      ['["ポスターセッション", "原文の poster という語", ["poster"]]', 1],
      ['["ワークショップ形式", "原文の workshop という語", ["workshop"]]', 1],
      ['["カメラレディ期限", "種別「カメラレディ」", ["カメラレディ"]]', 1],
      ['["早期登録締切", "種別「登録締切」", ["登録締切"]]', 1],
      ['["分散コンピューティング", "分野「システム」", ["システム", "systems"]]', 1],
      ['["組込みシステム", "分野「システム」", ["システム", "systems"]]', 1],
    ] as Array<[string, number]>) {
      expect(rec.split(条目).length - 1, `成果物の中の条目の数: ${条目.slice(1, 18)}`).toBe(数);
    }
  });
});
