/**
 * 分野の日本語の別の言い方の検査。SPEC §4・§7・第 359 回。
 * 実測（2026-10-17 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `AI` 331 行・`機械学習` 81 行・`computer architecture` 7 行・`reliability` 1 行が通るのに、
 * `生成AI` `生成的人工知能` `生成モデル` `コンピュータアーキテクチャ` `耐障害性`
 * `フォールトトレランス` `耐故障` はいずれも **0 行で案内も無し**、`プロセッサ` `半導体`
 * `集積回路` `VLSI` `チップ` も **0 行で案内も無し**（其の内半導体は催し物が収録に無い）。
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

/** 日本語の別の言い方 → 収録の原文の語。 */
const 分野の寄せ: Array<[string, string]> = [
  ["生成AI", "generative"],
  ["生成的人工知能", "generative"],
  ["生成モデル", "generative"],
  ["コンピュータアーキテクチャ", "computer architecture"],
  ["耐障害性", "reliability"],
  ["フォールトトレランス", "reliability"],
  ["耐故障", "reliability"],
];

const 収録に無い分野 = [
  "プロセッサ",
  "半導体",
  "半導体設計",
  "集積回路",
  "VLSI",
  "チップ",
  "チップ設計",
  "回路設計",
  "半導体 デザイン",
];

describe("分野の日本語の別の言い方", () => {
  it("其の方の原文の語と一字も違わない行集合になる（新しい幅を作らない）", () => {
    for (const [日本語, 原文] of 分野の寄せ) {
      expect(対称差(日本語, 原文), `\`${日本語}\` が \`${原文}\` と違う行を出した`).toBe(0);
    }
    /* 品書の載り方に依るので絶対値を張らない（第 344・355・357 回） – 寄せ先で行が出る組が
     * 在る事を見る（実品書では 生成AI 1 行・コンピュータアーキテクチャ 7 行・耐障害性 1 行）。 */
    const 原文々 = [...new Set(分野の寄せ.map(([, 原文]) => 原文))];
    const 出る = 原文々.filter((原文) => 行列表(原文).length > 0);
    expect(
      出る.length,
      `寄せ先の語（${原文々.join("・")}）が検査の品書で全部 0 行`,
    ).toBeGreaterThan(0);
  });

  it("黙って広くしない（`生成AI` を『AI』の行数に広げない）", () => {
    const 狭 = 行列表("生成AI").length;
    const 広 = 行列表("AI").length;
    expect(広, "対照の `AI` が 0 行").toBeGreaterThan(0);
    expect(狭, `生成AI が AI と同じ行数まで広がった（${広} 行）`).toBeLessThan(広);
    /* 広く探す道は案内の中に書く（黙って広げない代わり）。 */
    expect(Recommender.querySynonymNotes("生成AI").join(" ")).toContain("『AI』");
  });

  it("無い語を在る様に寄せない – 案内が其の事を言う", () => {
    const 案内 = Recommender.querySynonymNotes("耐障害性").join(" ");
    expect(案内, "寄せ先の語を言っていない").toContain("reliability");
    expect(案内, "収録に fault tolerance が無い事を言っていない").toContain("fault tolerance");
    expect(Recommender.querySynonymNotes("フォールトトレランス").join(" ")).toContain(
      "fault tolerance",
    );
  });
});

describe("収録に無い分野（半導体・チップ）", () => {
  it("0 行の侭、近い道を教える案内と読み上げが出る", () => {
    for (const 語 of 収録に無い分野) {
      expect(行列表(語).length, `\`${語}\` に行が出てしまった`).toBe(0);
      const 名 = 語.split(/[\s、]+/)[0];
      const 案内 = Recommender.uiWordNoteJa(語);
      expect(案内, `「${語}」の案内が出ていない`).toContain(`「${名}」`);
      expect(案内, `「${語}」の案内が収録に無い事を言っていない`).toContain("収録していません");
      expect(案内, `「${語}」の案内が近い道を教えない`).toContain("『コンピュータアーキテクチャ』");
      expect(Recommender.uiWordLiveNoteJa(語).length, `「${語}」の読み上げが短い`).toBeGreaterThan(
        10,
      );
    }
  });

  it("案内の文は打ち方に依らない", () => {
    const 本体 = (語: string) => Recommender.uiWordNoteJa(語).replace(`「${語}」`, "");
    expect(本体("集積回路")).toBe(本体("半導体"));
    expect(本体("VLSI")).toBe(本体("チップ設計"));
    for (const 語 of ["プロセッサ", "半導体", "集積回路", "VLSI", "チップ"]) {
      expect(Recommender.uiWordNoteJa("半導体"), `文が \`${語}\` を名指している`).not.toContain(
        `『${語}』`,
      );
    }
  });

  it("案内が名指す近い道は実際に行が出る（空振りする打ち方を教えない）", () => {
    const 道 = ["コンピュータアーキテクチャ", "アーキテクチャ"];
    const 出る = 道.filter((語) => 行列表(語).length > 0);
    expect(
      出る.length,
      `案内が名指す道（${道.join("・")}）が検査の品書で全部 0 行`,
    ).toBeGreaterThan(0);
  });
});

describe("壊していない物", () => {
  it("其の方の分野の語・画面の印・其れ以外の案内は其侭", () => {
    for (const 語 of [
      "AI",
      "機械学習",
      "LLM",
      "高性能計算",
      "スパコン",
      "組込み",
      "分散システム",
      "セキュリティ",
      "アーキテクチャ",
      "マイクロアーキテクチャ",
    ]) {
      expect(行列表(語).length, `\`${語}\` が落ちた`).toBeGreaterThan(0);
    }
    expect(Recommender.querySynonymNotes("マイクロアーキテクチャ").join(" ")).toContain(
      "microarchitecture",
    );
    expect(Recommender.uiWordNoteJa("主要会議")).toContain("『ランク』");
    /* 当たりを「収録に無い」と言い出さない見張り（第 358 回）– `アーキテクチャ` は実測 2 行
     * 当たるので案内の対象ではない（案内は 0 件の時だけ出る物）。 */
    expect(
      Recommender.uiWordNoteJa("アーキテクチャ"),
      "`アーキテクチャ` を収録に無い語にしてしまった",
    ).toBe("");
    expect(Recommender.uiWordNoteJa("旅費")).toContain("この表が持っていません");
    expect(Recommender.uiWordNoteJa("月前半")).toContain("『上旬』");
    expect(Recommender.uiWordNoteJa("祝日 締切")).toContain("「祝日」");
    /* `A*` を対照にしない – 検査の品書には等級の付いた行が載らない（第 357 回）。 */
    for (const 語 of ["穴場", "土日", "上旬"]) {
      expect(行列表(語).length, `\`${語}\` が落ちた`).toBeGreaterThan(0);
    }
  });
});

describe("成果物", () => {
  it("三分野の寄せと半導体の案内が成果物に一度ずつ入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const [断片, 期待] of [
      /* 断片はビルド後の実際の字で張る（biome が長い配列を折り返すので、ビルド前の字は使えない）。 */
      ["原文に computer architecture と書かれた行", 1],
      ["半導体・チップその物の催し物を収録していません", 1],
      ["其の分野を広く探すなら『AI』で絞れます", 3],
    ] as Array<[string, number]>) {
      expect(rec.split(断片).length - 1, `成果物の中の断片 \`${断片.slice(0, 14)}…\` の数`).toBe(
        期待,
      );
    }
  });
});
