/**
 * 分野の語を繋げて打った名詞の検査。SPEC §4・§7・第 372 回。
 * 実測（2026-10-24 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）の直し前は、
 * 分野の語を二つ並べた打ち方 552 通りの内 326 通りが 0 行だった –
 *   `HPCセキュリティ` **0 行**（`HPC` 108 行・`セキュリティ` 152 行）・`分散ストレージ` **0 行**
 *   （23 行・1 行）・`組込みネットワーク` **0 行**（259 行・75 行）・`クラウドセキュリティ` **0 行**
 * 其の方の語を空白で並べた形（`HPC セキュリティ` 4 行）は通っていたので、繋いだ名詞だけが落ちた。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 目録(): ReturnType<typeof Recommender.candidateRows> {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")),
  );
}

function 行列表(語: string): string[] {
  const マッチ = Recommender.searchMatcher(語, 基準);
  return 目録()
    .filter((行) => マッチ(行.hay) === true)
    .map((行) => 行.hay);
}

function 対称差(a: string, b: string): number {
  const x = new Set(行列表(a));
  const y = new Set(行列表(b));
  return [...x].filter((k) => !y.has(k)).length + [...y].filter((k) => !x.has(k)).length;
}

function 件数欄(語: string): string {
  const 項目: string[] = [];
  項目.push(...(Recommender.querySynonymNotes(語) as unknown as string[]));
  項目.push(...(Recommender.uiWordNoteJa(語) as unknown as string[]));
  return 項目.join(" / ");
}

describe("分野の語を繋げて打った名詞", () => {
  it("空白で並べた打ち方と一行も違わない", () => {
    for (const [繋いだ形, 並べた形] of [
      ["HPCセキュリティ", "HPC セキュリティ"],
      ["機械学習セキュリティ", "機械学習 セキュリティ"],
      ["分散ストレージ", "分散 ストレージ"],
      ["組込みネットワーク", "組込み ネットワーク"],
      ["クラウドセキュリティ", "クラウド セキュリティ"],
      ["スパコンシミュレーション", "スパコン シミュレーション"],
      ["ネットワーク暗号", "ネットワーク 暗号"],
      ["高性能計算可視化", "高性能計算 可視化"],
      /* 助詞で割れた語の後ろ側が複合語である形（其の方の語を助詞が分けた後でも割る – 第 372 回）。 */
      ["ネットワークのクラウドセキュリティ", "ネットワーク クラウド セキュリティ"],
      ["8月のクラウドセキュリティ", "8月 クラウド セキュリティ"],
    ] as Array<[string, string]>) {
      expect(
        対称差(繋いだ形, 並べた形),
        `\`${繋いだ形}\` が \`${並べた形}\` と違う行を出している`,
      ).toBe(0);
      expect(件数欄(繋いだ形), `\`${繋いだ形}\` の件数欄が並べた形と違う事を言っている`).toBe(
        件数欄(並べた形),
      );
    }
  });

  it("其の方の語が其れ迄通っていた行を落とさない", () => {
    for (const 繋いだ形 of [
      "HPCセキュリティ",
      "組込みネットワーク",
      "クラウドセキュリティ",
      "スパコンシミュレーション",
      /* 助詞の後ろに複合語が来る形（助詞で割れた後でも其の方の語を割る – 第 372 回）。 */
      "ネットワークのクラウドセキュリティ",
      "8月のクラウドセキュリティ",
    ]) {
      expect(行列表(繋いだ形).length, `\`${繋いだ形}\` が 0 行に落ちた`).toBeGreaterThan(0);
    }
  });

  it("絞り込みは部分語の両方を含む（繋いだだけで其れ以外の行を足さない）", () => {
    for (const [繋いだ形, 前, 後] of [
      ["HPCセキュリティ", "HPC", "セキュリティ"],
      ["組込みネットワーク", "組込み", "ネットワーク"],
      ["クラウドセキュリティ", "クラウド", "セキュリティ"],
    ] as Array<[string, string, string]>) {
      const 幅 = new Set(行列表(繋いだ形));
      for (const 部分 of [前, 後]) {
        for (const 行 of 幅) {
          expect(
            new Set(行列表(部分)).has(行),
            `\`${繋いだ形}\` が \`${部分}\` で通らない行を出している`,
          ).toBe(true);
        }
      }
    }
  });

  it("其の方の語で立っている名詞は割らない（割ると意味が変わる – 実測 259 行と 7 行）", () => {
    expect(件数欄("分散システム"), "『分散システム』の案内が消えた").toContain("システム");
    expect(
      行列表("分散システム").length,
      "『分散システム』が『分散』『システム』に割れて其の方の意味になった",
    ).toBeGreaterThan(行列表("分散 システム").length);
    /* 語彙に立っている複合語は、空白で並べた形とは別の意味で通る（割っていない証拠）。 */
    const 割っていない = [
      ["知識グラフ", "知識 グラフ"],
      ["分散システム", "分散 システム"],
    ] as Array<[string, string]>;
    for (const [固まり, 並べた形] of 割っていない) {
      expect(
        行列表(固まり).length,
        `『${固まり}』が『${並べた形}』に割れて同じ行になった（其の方の語は一つの分野語）`,
      ).toBeGreaterThan(行列表(並べた形).length);
    }
  });

  it("其の方の規則が其侭の語を受ける名詞は割らない（割ると其の方の説明が落ちる – 第 372 回）", () => {
    /* 実測（2026-10-24 – 実ビルドの品書 872 行）: 割る規則を其侭掛けると `リアルタイムシステム` の
       案内が「原文の real-time という語」から前の語だけの物に落ち、`コンテナオーケストレーション` は
       其の方の規則の寄せ先（orchestration）を向かなくなった（`built_golden_4` の検査が落ちた）。
       `採択通知日` は其の方の語では寄せない物として決まって居り、割ると二つの語が別々に
       種別「採否通知」に寄って意味が広がった（第 246 回の守り）。 */
    expect(件数欄("リアルタイムシステム"), "『リアルタイムシステム』の説明が落ちた").toContain(
      "原文の real-time という語",
    );
    expect(
      件数欄("コンテナオーケストレーション"),
      "『コンテナオーケストレーション』の説明が落ちた",
    ).toContain("オーケストレーション");
    expect(件数欄("採択通知日"), "『採択通知日』が割れて種別に寄せた").toBe("");
    expect(対称差("リアルタイムシステム", "リアルタイムシステム")).toBe(0);
  });

  it("語彙に無い語を繋いだ形は割らない（行から勝手に語を作らない – 『AI倫理』の実測 0 行の侭）", () => {
    expect(対称差("AI倫理", "AI 倫理")).toBe(0);
    expect(対称差("情報科学", "情報 科学")).toBe(0);
  });
});

describe("其れ以外の語の分け方（助詞・季節・表の全行に当たる語）が生きている事", () => {
  it("助詞で割った形と表の全行の語の案内は変わっていない", () => {
    expect(件数欄("ネットワークの会議"), "『ネットワークの会議』の案内が消えた").toContain(
      "この表の全行",
    );
    expect(件数欄("9月の締切"), "『9月の締切』の案内が消えた").toContain("締切");
    expect(行列表("スパコン〜HPC").length, "語を結ぶ記号の形が壊れた").toBe(
      行列表("スパコン HPC").length,
    );
  });
});

describe("成果物", () => {
  it("直し方が実測どおりの形で成果物に入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const [条目, 数] of [
      ["function 分野の複合に割るJa(", 1],
      ["function 分野語彙Ja取得(", 1],
      ["Object.keys(TAG_LABELS_JA)", 1],
      ["Object.keys(JP_EN).forEach((語) => {\n            足す(語);", 1],
      ["if (他の規則で受ける語かJa(全体))", 1],
      ["if (割れた.some((断片) => 種別への寄せ語かJa(", 1],
      ["return 分野の複合に割るJa(token);", 1],
      ["const 複合 = parts.flatMap((part) => 分野の複合に割るJa(part));", 1],
    ] as Array<[string, number]>) {
      expect(rec.split(条目).length - 1, `成果物の中の語の数: ${条目.slice(0, 18)}`).toBe(数);
    }
  });
});
