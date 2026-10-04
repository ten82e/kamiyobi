/**
 * 分野の略語を英文字で打つ形 – 第 414 回。
 *
 * 実測（2026-10-08 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻
 * 2026-08-09T00:00:00Z）: 品書が綴りしか書かない為、略語を打つ人は默つて 0 行に当たつて居た –
 * `ml` **0 行**（`machine learning` 99 行・`機械学習` 81 行）・`cv` **0 行**
 * （`computer vision` 48 行）・`nlp` 1 行（`natural language processing` 34 行）・
 * `dl` **0 行**（4 行）・`qc` **0 行**（`quantum computing` 3 行）・`kg` **0 行**
 * （`knowledge graph` 2 行）。
 *
 * 直し – 略語を其の方の綴りの組に入れる（一方向 – 綴りを打つ人側の当たりは動かさない）。
 * 広げた先は件の数欄に書く。会議名の略語（`osdi`）と、広げても行を増やさない略語
 * （`gnn` `ner` `xai` `mlops` `tee` `cdn` `p2p` `fl`）は置いていない。
 *
 * 下の検査は検査用ビルドの品書（435 行）で見る。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 列表入口() {
  const 品 = (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
  const 済 = new Map<string, Set<string>>();
  return (語: string): Set<string> => {
    if (!済.has(語)) {
      const 当 = Recommender.searchMatcher(語, 基準);
      済.set(語, new Set(品.filter((行) => 当(行) === true)));
    }
    return 済.get(語) as Set<string>;
  };
}

const 列 = 列表入口();

function 対称差(甲: Set<string>, 乙: Set<string>): number {
  return [...甲].filter((行) => !乙.has(行)).length + [...乙].filter((行) => !甲.has(行)).length;
}

function 和集合(語々: string[]): Set<string> {
  const 全 = new Set<string>();
  for (const 語 of 語々) for (const 行 of 列(語)) 全.add(行);
  return 全;
}

function 語組(語: string): string[][] {
  return (Recommender.queryTokenGroups(語, 基準) as unknown as string[][]).map((組) =>
    組.map(String),
  );
}

function 案内(語: string): string {
  return (Recommender.querySynonymNotes(語) as unknown as string[]).join(" ");
}

describe("分野の略語を英文字で打つ形", () => {
  it("略語は其の方の綴りと同じ行を出す（黙つて 0 行にしない）", () => {
    for (const [略語, 綴り] of [
      ["ml", "machine learning"],
      ["cv", "computer vision"],
      ["nlp", "natural language processing"],
      ["dl", "deep learning"],
      ["kg", "knowledge graph"],
      ["qc", "quantum computing"],
    ] as Array<[string, string]>) {
      expect(列(綴り).size, `品書に「${綴り}」の行が在らない（検査が空振り）`).toBeGreaterThan(0);
      expect(列(略語).size, `略語「${略語}」が 0 行の侭`).toBeGreaterThan(0);
      expect(対称差(列(略語), 列(綴り)), `「${略語}」の当たり方が綴りと違う`).toBe(0);
    }
  });

  it("其の方の綴りを行に持つ略語は、二つの表記の和集合を出す", () => {
    const 期待 = 和集合(["iot", "internet of things"]);
    expect(期待.size).toBeGreaterThan(0);
    expect(対称差(列("iot"), 期待)).toBe(0);
    /* 綴りの側の行も、略語を打つ人に渡る（逆も同じ – 略語の行は綴りを打つ人にも渡る）。 */
    expect(列("iot").size).toBeGreaterThanOrEqual(列("internet of things").size);
  });

  it("広げた先を件の数欄に書く（黙つて広がらない）", () => {
    for (const [略語, 綴り] of [
      ["ml", "machine learning"],
      ["cv", "computer vision"],
      ["iot", "internet of things"],
    ] as Array<[string, string]>) {
      const 文 = 案内(略語);
      expect(文, `「${略語}」の案内が出て居ない`).toContain(綴り);
      expect(文, `「${略語}」の案内が略語だと言つて居ない`).toContain("略");
    }
  });

  it("大文字で打っても同じ行・同じ案内", () => {
    expect(対称差(列("ML"), 列("ml"))).toBe(0);
    expect(列("ML").size).toBeGreaterThan(0);
    expect(案内("ML")).toContain("machine learning");
  });

  it("日本語で打つ分野の語と略語が同じ行に届く", () => {
    expect(列("画像認識").size, "品書に「画像認識」の行が在らない").toBeGreaterThan(0);
    expect(対称差(列("cv"), 列("画像認識"))).toBe(0);
  });
});

describe("守り", () => {
  it("其の方の綴りを打つ人側の語の組に、略語を載せない", () => {
    /* 逆方向に広げると、綴りを打った人の当たりが変わる（第 349 回 – 一通に決まらない語は
     * 寄せない）。語の組に略語が混ざつて居ないことを見る。 */
    expect(語組("machine learning").flat()).not.toContain("ml");
    expect(語組("computer vision").flat()).not.toContain("cv");
  });

  it("会議名の略語は分野に広げない（名指しの収録意思を略語で膨らませない）", () => {
    expect(列("operating systems design").size, "品書に其の表記の行が在らない").toBeGreaterThan(0);
    expect(列("osdi").size, "会議名の略語が行を増やして居る").toBe(0);
    expect(案内("osdi")).toBe("");
  });

  it("他の語の一部に化けない", () => {
    expect(列("html").size).toBe(0);
    expect(対称差(列("html"), 列("machine learning"))).toBeGreaterThan(0);
    expect(列("ai").size).toBeGreaterThan(0);
  });

  it("語を並べて打つ形は AND の侭（略語を広げた事で広くならない）", () => {
    const 子 = 列("ml 2027");
    expect(子.size).toBeGreaterThan(0);
    expect(
      [...子].every((行) => 列("ml").has(行)),
      "ml 2027 が ml より広い",
    ).toBe(true);
    const 二つ = 列("ml sys");
    expect(二つ.size, "`ml sys` が 0 行（AND が効きすぎて居る）").toBeGreaterThan(0);
    expect([...二つ].every((行) => 列("ml").has(行) && 列("sys").has(行))).toBe(true);
  });

  it("他の直しを変えて居ない", () => {
    /* 暦日を打って其れより後（第 413 回）。 */
    expect(列("8月22日以降").size).toBeGreaterThan(0);
    /* 時刻にゾーンを繋げて打つ形（第 412 回）。 */
    expect(対称差(列("23:59JST"), 列("23:59 JST"))).toBe(0);
    /* 裸の分野語。 */
    expect(対称差(列("データベース"), 列("db"))).toBe(0);
  });
});

describe("成果物", () => {
  it("略語の表は一個所で読み、広げる方向は一方向に決まる", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/const TOPIC_ABBREVIATIONS_EN = \[/g) ?? []).toHaveLength(1);
    expect(物.match(/TOPIC_ABBREVIATIONS_EN/g) ?? [], "表を読む箇所").toHaveLength(3);
    expect(物.match(/\["ml", "machine learning"\]/g) ?? []).toHaveLength(1);
    /* 綴り → 略語の逆方向の登録を置いて居ない（上の守りと同じ事を成果物でも見る）。 */
    expect(物.match(/byReading\[綴り\]/g) ?? []).toHaveLength(0);
  });
});
