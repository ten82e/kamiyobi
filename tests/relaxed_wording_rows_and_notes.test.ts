/**
 * 言い換え・繋げた打ち方で 0 行と無言だった語の検査。SPEC §4・§7・第 362 回。
 * 実測（2026-10-19 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * 直し前は `穴場会議` `穴場な会議` `隠れ家的な会議` `提出期限` `投稿期限`（寄せの語 – 其の方の
 * `穴場` 44 行・`論文提出` 461 行が通った）と、`小規模会議` `締切間近` `会場参加` など十七形
 * （案内の語 – 行は出ないが其の場で其のことを言うべき語）が **0 行で案内も無し**だった。
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

const 寄せ: Array<[string, string]> = [
  ["穴場会議", "穴場"],
  ["穴場な会議", "穴場"],
  ["隠れ家的な会議", "穴場"],
];
const 規模の語 = [
  "小規模",
  "小規模会議",
  "小規模な会議",
  "小規模ワークショップ",
  "アットホームな会議",
];
const 近さの語 = ["締切間近", "締切目前", "締切が近い", "近い締切", "間近の締切"];
const 会場ことば = ["会場参加", "現地対面"];

describe("言い換えた打ち方", () => {
  it("其の方の収録の語へ寄り、行集合が一字も違わない（行を増やさない）", () => {
    for (const [日本語, 収録の語] of 寄せ) {
      expect(対称差(日本語, 収録の語), `\`${日本語}\` が \`${収録の語}\` と違う行を出した`).toBe(0);
    }
    const 出る = [...new Set(寄せ.map(([, 収録の語]) => 収録の語))].filter(
      (語) => 行列表(語).length > 0,
    );
    expect(
      出る.length,
      "寄せ先の語が検査の品書で全部 0 行（対称差ゼロが空に成っている – 第 357 回）",
    ).toBeGreaterThan(0);
  });

  it("表その物を指す語は寄せない（第 245 回の契約 – 収録の半分を超える寄せは絞り込みでない）", () => {
    /* 実測: `論文提出` は 461 行 / 収録 872 行 – 其の方へ寄せると半分超なので「絞れない」側の文に
     * 立てる（第 362 回で一度寄せたが、測って引っ込めた – 次の人は其れを踏まない様に張る）。 */
    for (const 語 of ["提出期限", "投稿期限"]) {
      expect(行列表(語).length, `\`${語}\` を寄せてしまった`).toBe(0);
      expect(Recommender.querySynonymNotes(語).join(""), `\`${語}\` に寄せの案内を立てた`).toBe("");
    }
  });

  it("案内が寄せ先を名指す（何を打っても其の方の道に届くと分かる）", () => {
    for (const [日本語, 収録の語] of 寄せ) {
      const 案内 = Recommender.querySynonymNotes(日本語).join(" ");
      expect(案内, `\`${日本語}\` の案内が寄せ先 \`${収録の語}\` を名指していない`).toContain(
        収録の語,
      );
    }
  });

  it("規模の語は 0 行の侭其のことを言い、近い道『穴場』を教える", () => {
    for (const 語 of 規模の語) {
      expect(行列表(語).length, `\`${語}\` に行が出るようになった（規模の印を作った）`).toBe(0);
      const 案内 = Recommender.uiWordNoteJa(語);
      expect(案内, `\`${語}\` に案内が無い`).toContain(`「${語}」`);
      expect(案内, `\`${語}\` の案内が規模の印が無い事を言っていない`).toContain("規模");
      expect(案内, `\`${語}\` の案内が近い道を教えない`).toContain("穴場");
      expect(Recommender.uiWordLiveNoteJa(語).length, `\`${語}\` の読み上げが短い`).toBeGreaterThan(
        10,
      );
    }
  });

  it("締切の近さの語は幅を勝手に決める代わりに、画面に実在するボタンを名指す（第 319 回）", () => {
    const html = readFileSync(join(builtSite(), "index.html"), "utf8");
    /* 案内が名指す操作は、ビルド済みの画面に実在する物だけにする（第 338 回と同じ見張り）。 */
    expect(html, "画面に『締切まで 7 日以内』のボタンが無い").toContain("締切まで 7 日以内");
    expect(html, "画面に締切まで 7 日以内の操作が無い").toContain('data-preset="7d"');
    for (const 語 of 近さの語) {
      expect(行列表(語).length, `\`${語}\` に行が出るようになった（近いの幅を作った）`).toBe(0);
      const 案内 = Recommender.uiWordNoteJa(語);
      expect(案内, `\`${語}\` に案内が無い`).toContain(`「${語}」`);
      expect(案内, `\`${語}\` の案内が画面のボタンを名指していない`).toContain("締切まで 7 日以内");
      expect(案内, `\`${語}\` の案内が推測しないと書いていない`).toContain("推測");
      expect(Recommender.uiWordLiveNoteJa(語), `\`${語}\` の読み上げがボタンを教えない`).toContain(
        "7 日",
      );
    }
  });

  it("当たりを収録に無いと言わない（第 358 回 – 対面参加の群の語と寄せ先の語は其侭）", () => {
    for (const 語 of [
      "穴場",
      "論文提出",
      "論文締切",
      "投稿締切",
      "大規模",
      "今週",
      "来週",
      "延長締切",
    ]) {
      expect(Recommender.uiWordNoteJa(語), `\`${語}\` を収録に無い語と言った`).toBe("");
    }
    /* 会場ことばは 0 行の語なので案内が出て良い – 其の方の参加形式の群の文が出る。 */
    for (const 語 of 会場ことば) {
      expect(行列表(語).length, `\`${語}\` に行が出るようになった`).toBe(0);
      expect(Recommender.uiWordNoteJa(語), `\`${語}\` に案内が無い`).toContain("参加形式");
    }
  });

  it("文は群で揃い、他の家系の案内は其侭（取り壊さない）", () => {
    for (const 群 of [規模の語, 近さの語]) {
      const 文々 = new Set(群.map((語) => Recommender.uiWordNoteJa(語).replace(`「${語}」`, "")));
      expect(文々.size, `群の文が揃っていない: ${群.join("・")}`).toBe(1);
    }
    expect(Recommender.uiWordNoteJa("主要会議")).toContain("『ランク』");
    expect(Recommender.uiWordNoteJa("月前半")).toContain("『上旬』");
    expect(Recommender.uiWordNoteJa("半導体")).toContain("収録していません");
    expect(Recommender.uiWordNoteJa("祝日 締切")).toContain("「祝日」");
    expect(Recommender.uiWordNoteJa("大会")).toContain("現れません");
    expect(対称差("生成AI", "generative"), "分野の寄せが壊れた").toBe(0);
    expect(対称差("イングランド", "england"), "開催地の寄せが壊れた").toBe(0);
  });
});

describe("寄せ表に載せない語（黙って意味を作らない）", () => {
  it("「近い」の語・規模の語・会場ことばを検索の寄せに載せない（第 337 回・第 362 回）", () => {
    /* 検査の品書では「今週」の行が無く、行集合を比較する張りは空になる（第 357 回 – 改ざんを
     * 走らせて測って気づいた – そのままでは `締切間近` を『今週』に寄せる直し方が通った）。
     * だから**成果物の正本の形**で張る: 寄せ表（QUERY_SYNONYMS_JA）の打ち方の語に、其方達の語が
     * 一つも載っていない事。 */
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 頭 = "const QUERY_SYNONYMS_JA = [";
    const i = rec.indexOf(頭);
    expect(i, "成果物に寄せ表が見つからない").toBeGreaterThan(0);
    const 本文 = rec.slice(i, rec.indexOf("];", i));
    expect(本文, "寄せ表の読み取りが短すぎる（切り出しが壊れている）").toContain("スパコン");
    for (const 語 of [...近さの語, ...規模の語, ...会場ことば]) {
      expect(
        本文,
        `寄せ表に \`${語}\` を寄せる条目が現れた（黙って幅・規模を作った）`,
      ).not.toContain(`["${語}",`);
    }
  });
});

describe("成果物", () => {
  it("寄せと案内が、実測どおりの回数で成果物に入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const [断片, 数] of [
      ['["穴場会議", "主題タグ「穴場」", ["穴場"]]', 1],
      /* 説明の形は検査が読む（「label」 – 第 250 回） – 三語ぶんの説明が其の形に入る */
      /* 第 384 回で `穴場の会` を足して 4 条目になった（実測 – ビルド成果物で数えた）。 */
      ["主題タグ「穴場」", 4],
      ["催し物の規模の印を収録していません", 1],
      ["この表は『近い』の幅を勝手に決めません", 1],
      /* 語の欄の形で張る – 語その物は追記の注釈にも出るので其の侭だと 2 回になる（実測） */
      ['"会場参加",', 1],
    ] as Array<[string, number]>)
      expect(rec.split(断片).length - 1, `成果物の中の \`${断片}\` の数`).toBe(数);
  });
});
