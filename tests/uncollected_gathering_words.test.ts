/**
 * 収録に無い催し物の呼び方・賞・学協会の語の検査。SPEC §4・§7・第 361 回。
 * 実測（2026-10-18 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * 直し前は `論文賞` `表彰` `受賞` `大会` `全国大会` `例会` `セミナー` `講演会` `人工知能学会`
 * `情報処理推進機構` など二十形が **0 行で案内も無し**、読み上げは「其の語は収録データにありません」
 * だけだった。其れでも `賞`（群の語として在った物）は案内が在り、`研究会` 23 行・
 * `ワークショップ` 126 行・`学会` 24 行・`情報処理学会` 11 行は通る – **当たりを「収録に無い」と
 * 言わない**見張りを一緒に張る（第 358 回）。
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

/** 0 件の時に何と読むか（四つの案内の入口を纏める – 第 358 回の手順）。 */
function 全案内(語: string): string {
  return [
    Recommender.querySynonymNotes(語).join(" "),
    Recommender.uiWordNoteJa(語),
    Recommender.uiWordLiveNoteJa(語),
  ]
    .filter((x) => x)
    .join(" ");
}

const 賞の語 = [
  "論文賞",
  "優秀論文賞",
  "最優秀論文賞",
  "最優秀賞",
  "デモ賞",
  "授賞式",
  "表彰",
  "受賞",
  "受賞講演",
  "学生ボランティア",
];
const 呼び方の語 = ["大会", "全国大会", "年会", "例会", "セミナー", "講演会", "講習会", "集会"];
const 学協会の語 = ["人工知能学会", "情報処理推進機構"];
const 収録に無い語 = [...賞の語, ...呼び方の語, ...学協会の語];

describe("収録に無い催し物の呼び方・賞・学協会", () => {
  it("二十形は行が出ず、其の場で其のことを言い、読み上げも添う", () => {
    for (const 語 of 収録に無い語) {
      expect(行列表(語).length, `\`${語}\` に行が当たるようになった（収録の意味が変わった）`).toBe(
        0,
      );
      const 案内 = Recommender.uiWordNoteJa(語);
      expect(案内, `\`${語}\` に案内が無い（0 行と無言に戻った）`).toContain(`「${語}」`);
      expect(案内, `\`${語}\` の案内が収録に無い事を言っていない`).toMatch(
        /持っていません|収録していません|現れません/,
      );
      const 読み = Recommender.uiWordLiveNoteJa(語);
      expect(読み.length, `\`${語}\` の読み上げが短い`).toBeGreaterThan(10);
      expect(全案内(語), `\`${語}\` を収録に在る様におすすめした`).not.toMatch(
        /収録データにありません/,
      );
    }
  });

  it("案内の名指す道は実際に行が出る（在らない場所へ送らない – 第 319 回）", () => {
    /* 呼び方の群は『研究会』『ワークショップ』『学会』『シンポジウム』へ、学協会の群は
     * 『人工知能』『セキュリティ』へ導す。検査の品書に全部が載るとは限らないので、
     * 導す先の内、其の品書で出てから張る（第 344・359 回 – 絶対値を闇雲に張らない）。 */
    const 道 = ["研究会", "ワークショップ", "学会", "シンポジウム", "人工知能", "セキュリティ"];
    const 出る = 道.filter((語) => 行列表(語).length > 0);
    expect(
      出る.length,
      `案内が名指す道（${道.join("・")}）が検査の品書で全部 0 行`,
    ).toBeGreaterThan(0);
    for (const 語 of 呼び方の語) {
      const 案内 = Recommender.uiWordNoteJa(語);
      for (const 名指し of 出る.filter((w) =>
        ["研究会", "ワークショップ", "学会", "シンポジウム"].includes(w),
      )) {
        expect(案内, `\`${語}\` の案内が『${名指し}』を忘れている`).toContain(名指し);
      }
    }
    for (const 語 of 学協会の語) {
      const 案内 = Recommender.uiWordNoteJa(語);
      for (const 名指し of 出る.filter((w) => ["人工知能", "セキュリティ"].includes(w))) {
        expect(案内, `\`${語}\` の案内が『${名指し}』を忘れている`).toContain(名指し);
      }
    }
  });

  it("当たりを通る侭にする（学会・研究会・学生セッションを収録に無いと言わない – 第 358 回）", () => {
    for (const 語 of [
      "研究会",
      "学会",
      "情報処理学会",
      "電子情報通信学会",
      "学生セッション",
      "シンポジウム",
    ]) {
      expect(Recommender.uiWordNoteJa(語), `\`${語}\` を収録に無い語と言った`).toBe("");
    }
    /* 呼び方の語を行に付け足していない事（黙って意味を広げない – 第 337 回）。
     * `大会` を `研究会` に寄せる直し方をしたら、此処が落ちる。 */
    expect(行列表("大会").length, "`大会` に行が出るようになった（語を足し直した）").toBe(0);
    expect(行列表("大会").length, "`大会` が `研究会` に寄った").toBeLessThan(
      行列表("研究会").length,
    );
  });

  it("語を並べた形でも其の方の語を名指す（一字の語『賞』も通す – 第 361 回）", () => {
    const 並べ = ["賞 関西", "論文賞 関西", "大会 関西", "人工知能学会 関西", "表彰 オンライン"];
    for (const 打ち方 of 並べ) {
      const 案内 = Recommender.uiWordNoteJa(打ち方);
      expect(案内, `語を並べた \`${打ち方}\` で案内が黙った`).not.toBe("");
      const 語 = 打ち方.split(" ")[0];
      expect(案内, `\`${打ち方}\` が其の方の語を名指していない`).toContain(`「${語}」`);
    }
    /* 助詞は案内の語にならない（一字の語を通した為の化けの見張り – 表の一字の語は『賞』一つ）。 */
    for (const 助詞 of ["の", "に", "で", "を", "と", "から"]) {
      expect(Recommender.uiWordNoteJa(助詞), `助詞 \`${助詞}\` に案内が出た`).toBe("");
    }
    /* 表に語が無い打ち方（`費` も `無料` の語も – `無料` は別群の語なので其れは出る）は黙る。 */
    expect(Recommender.uiWordNoteJa("机 椅子"), "表に語が無い打ち方で案内が出た").toBe("");
    expect(Recommender.uiWordNoteJa("費 無料"), "`無料` の案内が消えた").toContain("「無料」");
  });

  it("文は群で揃い、其の方の語を余計に名指さない（群の語を他の語の文に混ぜない）", () => {
    const 群々 = [賞の語, 呼び方の語, 学協会の語];
    for (const 群 of 群々) {
      const 文々 = new Set(群.map((語) => Recommender.uiWordNoteJa(語).replace(`「${語}」`, "")));
      expect(文々.size, `群の中の文が揃っていない: ${群.join("・")}`).toBe(1);
      const 文 = [...文々][0];
      for (const 他 of 収録に無い語) {
        if (!群.includes(他)) {
          expect(文, `群の文が其の方の語 \`${他}\` を名指している`).not.toContain(他);
        }
      }
    }
  });
});

describe("成果物", () => {
  it("新しい二つの群の文が、実測どおりの回数で成果物に入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    /* 案内と読み上げの二か所に其の方の語が現れる（第 358 回 – 期待値は測って張る） */
    for (const [断片, 数] of [
      ["近い呼び方として通るのは", 1],
      ["其の呼び方の催し物は収録に無いです", 1],
      ["其の学協会・機関の催し物を収録していません", 1],
      /* 語の欄の形（引用符と読点込み）で張る – 語その物は上の注釈にも出るので 2 回になる（実測） */
      ['"学生ボランティア",', 1],
    ] as Array<[string, number]>)
      expect(rec.split(断片).length - 1, `成果物の中の \`${断片}\` の数`).toBe(数);
  });
});
