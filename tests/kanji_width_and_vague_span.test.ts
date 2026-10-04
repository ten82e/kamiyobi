/**
 * 幅と相対日を**漢数字・片仮名まじり・数えられない数**で打つ形 – 第 415 回。
 *
 * 実測（2026-10-08 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻
 * 2026-08-09T00:00:00Z）:
 * - 漢数字の寄せ（年・月・日・週は折る）に**か月が抜けて居た** – `五日後` 19 行・
 *   `二週間後` 19 行・`十一日後` 13 行が通るのに、`一か月後` **0 行**（`1か月後` 18 行）・
 *   `三か月後` **0 行**（`3か月後` 7 行）・`六ケ月後` **0 行**・`二ヶ月後` **0 行**で案内も無し。
 * - 半月の片仮名まじり（`半ケ月` `半ヵ月`）だけ「15 日として読む」案内が出て居ない
 *   （`半月` `半ヶ月` は出る – NFKC はヶをケに折らない実測）。
 * - 『数えられない数』の幅（`数日` `数日以内` `数週間以内` `数か月以内` `数年`）は
 *   0 行で案内も無し（同じ群の `近日中` `直近` `当面` は案内が出る）。
 *
 * 直し – 漢数字の単位に か月（表記ゆれ）を足す・半月の語に片仮名まじりを足す・
 * 曖昧な幅の語の列に『数…』を足す（**行は作らない** – 絞り込めない事は其の侭書く）。
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

/** 件の数欄に出る案内（一覧が 5 件以上のときだけ出る「絞れていません」は除く – app.ts 実測）。 */
function 案内(語: string): string {
  const 出口 = Object.keys(Recommender).filter((名) => /Note|Hint/.test(名));
  return 出口
    .map((名) => {
      const fn = (Recommender as unknown as Record<string, (...args: unknown[]) => unknown>)[名];
      let 文 = "";
      try {
        const 値 = fn(語, 基準);
        文 = Array.isArray(値) ? 値.join(" ") : String(値 ?? "");
      } catch {
        文 = "";
      }
      return 文.includes("どの行にも当たっていて") ? "" : 文;
    })
    .filter((文) => 文 !== "")
    .join(" ｜ ");
}

describe("相対日を漢数字で打つ形", () => {
  it("漢数字のか月は算用数字で打った時と同じ日・同じ行を出す", () => {
    for (const [漢, 算] of [
      ["一か月後", "1か月後"],
      ["三か月後", "3か月後"],
      ["六ケ月後", "6か月後"],
      ["二ヶ月後", "2か月後"],
      ["五カ月後", "5カ月後"],
    ] as Array<[string, string]>) {
      expect(列(算).size, `算用数字「${算}」の行が在らない（検査が空振り）`).toBeGreaterThan(0);
      expect(列(漢).size, `漢数字「${漢}」が 0 行の侭`).toBeGreaterThan(0);
      expect(対称差(列(漢), 列(算)), `「${漢}」の当たり方が算用数字と違う`).toBe(0);
    }
  });

  it("広げた日は件の数欄に其の日で書く（行を作つていない事の証拠は出さない）", () => {
    expect(案内("一か月後"), "解けた日を書いていない").toContain("2026年9月9日");
    expect(案内("一か月後"), "算用数字で打った時と違う案内になった").toBe(案内("1か月後"));
  });

  it("日・週・年の漢数字は以前から通つて居る（今回の寄せで変わつて居ない）", () => {
    for (const [漢, 算] of [
      ["五日後", "5日後"],
      ["二週間後", "2週間後"],
      ["一年後", "1年後"],
      ["十五日以内", "15日以内"],
      ["三日後", "3日後"],
    ] as Array<[string, string]>) {
      expect(対称差(列(漢), 列(算)), `「${漢}」が変わつた`).toBe(0);
    }
    /* 検査用ビルドの品書では `1年後` の行が 0 件の為、当たりのある物だけ件数を見る。 */
    for (const 漢 of ["五日後", "二週間後", "十五日以内", "三日後"]) {
      expect(列(漢).size, `「${漢}」が 0 行に減つた`).toBeGreaterThan(0);
    }
  });

  it("数の語が単体で立つ名称には触れない（一橋・三重・第一回）", () => {
    expect(列("第一回").size, "締切の回の漢数字が変わつた").toBeGreaterThan(0);
    expect(案内("第一回")).toContain("第1ラウンド");
    expect(案内("令和七年")).toContain("令和7年");
    /* 漢数字の寄せは『単位に繋がれた形だけ』 – 名称の一行も動かさない。 */
    expect(対称差(列("一橋"), new Set<string>())).toBe(0);
    expect(対称差(列("三重"), new Set<string>())).toBe(0);
  });
});

describe("半月の表記ゆれ", () => {
  it("片仮名まじりで打っても『半月』と同じ案内が出る（黙つて 0 行にしない）", () => {
    for (const 語 of ["半月", "半月以内", "半ケ月", "半ヶ月", "半ヵ月", "半月間"]) {
      const 文 = 案内(語);
      expect(文, `「${語}」の案内が出て居ない`).toContain("検索語としては当たりません");
      expect(文, `「${語}」の案内が欄の話を写して居ない`).toContain("締切まで");
      expect(列(語).size, `「${語}」で行を作つた（月の単位は換えない決まり）`).toBe(0);
    }
  });

  it("算用数字で打つ幅の語も同じ案内の侭", () => {
    expect(案内("1か月以内")).toContain("暦のか月の幅で絞る欄がありません");
  });
});

describe("数えられない数の幅", () => {
  it("『数…』の幅は絞り込めない事を其の場に書く（0 行の侭黙らない）", () => {
    for (const 語 of [
      "数日",
      "数日間",
      "数日以内",
      "数週間",
      "数週間以内",
      "数か月",
      "数か月以内",
      "数ヶ月以内",
      "数年",
    ]) {
      const 文 = 案内(語);
      /* 別の案内も「曖昧な幅」の語を含む為、この表が書いた文その物を張る。 */
      expect(文, `「${語}」に対する曖昧な幅の案内が出て居ない`).toContain(
        `「${語}」という曖昧な幅では絞り込めません`,
      );
      expect(文, `「${語}」の案内が『締切まで』の欄へ導いていない`).toContain("締切まで");
      /* 行は作らない – 何日かの決定は表側では出来ない。 */
      expect(列(語).size, `「${語}」で行を作つた`).toBe(0);
    }
  });

  it("同じ群の以前からの語は其侭", () => {
    expect(案内("近日中")).toContain("「近日中」という曖昧な幅では絞り込めません");
    expect(案内("直近")).toContain("という曖昧な幅では絞り込めません");
  });
});

describe("守り", () => {
  it("他の直しを変えて居ない", () => {
    /* 分野の略語（第 414 回）。 */
    expect(列("ml").size).toBeGreaterThan(0);
    expect(案内("ml")).toContain("machine learning");
    /* 暦日を打って其れより後（第 413 回）。 */
    expect(列("8月22日以降").size).toBeGreaterThan(0);
    /* 時刻にゾーンを繋げて打つ形（第 412 回）。 */
    expect(対称差(列("23:59JST"), 列("23:59 JST"))).toBe(0);
    /* 半年は数の語を通らない別の条目で解ける。 */
    expect(案内("半年後")).toContain("半年後");
    expect(列("半年後").size).toBeGreaterThan(0);
  });
});

describe("成果物", () => {
  it("漢数字の単位表と曖昧な幅の語は一個所に決まる", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/const 日付の漢数字 =/g) ?? []).toHaveLength(1);
    expect(
      物.match(/\(か月\|カ月\|ヵ月\|ヶ月\|ケ月\|箇月\|年\|月\|日\|週間\|週\)/g) ?? [],
    ).toHaveLength(1);
    expect(物.match(/半ケ月\|半ヵ月/g) ?? [], "片仮名まじりの半月").toHaveLength(1);
    expect(物.match(/"数日以内"/g) ?? []).toHaveLength(1);
    expect(物.match(/"数週間以内"/g) ?? []).toHaveLength(1);
  });
});
