/**
 * 月の後半・半ば・終わりという打ち方の検査。SPEC §4・§7・第 356 回。
 * 実測（2026-10-14 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `8月下旬` 91 行・`来月下旬` 85 行・`中旬` 74 行・`月末` 189 行・`週末` 268 行が通るのに、
 * 同じ幅の別の言い方 `8月後半` `来月後半` `9月の後半` `月後半` `月中盤` `月半ば` `月終わり`
 * `月の終わり` `週末頃` はいずれも **0 行**だった（其の方の幅の表に語が抜けただけ – 第 348 回）。
 * 逆に `月前半` は公用の区切りが無いので **寄せない侭、案内を出す**（第 355 回の決まり）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { jsFunction } from "./runtime_extract.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 行列表(語: string): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
  const matches = Recommender.searchMatcher(語, 基準);
  return rows.filter((row) => matches(String(row.hay)) === true);
}

function 対称差(a: string, b: string): number {
  const x = new Set(行列表(a).map((r) => r.hay));
  const y = new Set(行列表(b).map((r) => r.hay));
  return [...x].filter((k) => !y.has(k)).length + [...y].filter((k) => !x.has(k)).length;
}

/** 同じ幅の別の言い方 → 其の方の幅の語。 */
const 寄せの組: Array<[string, string]> = [
  ["8月後半", "8月下旬"],
  ["来月後半", "来月下旬"],
  ["今月後半", "今月下旬"],
  ["9月の後半", "9月下旬"],
  ["月後半", "下旬"],
  ["月の後半", "下旬"],
  ["月後半頃", "下旬"],
  ["8月後半まで", "8月下旬まで"],
  ["来月後半の締切", "来月下旬の締切"],
  ["月中盤", "中旬"],
  ["月半ば", "中旬"],
  ["8月中盤", "8月中旬"],
  ["来月中盤", "来月中旬"],
  ["来月半ば", "来月中旬"],
  ["今月半ば", "今月中旬"],
  ["月終わり", "月末"],
  ["月の終わり", "月末"],
  ["8月終わり", "8月末"],
  ["来月終わり", "来月末"],
  ["月終わり 関西", "月末 関西"],
  ["週末頃", "週末"],
];

describe("月の後半・半ば・終わり", () => {
  it("其の方の幅と一字も違わない行集合になる（勝手に幅を作らない）", () => {
    for (const [打ち方, 幅] of 寄せの組) {
      expect(行列表(幅).length, `其の方の \`${幅}\` が 0 行（対照が空）`).toBeGreaterThan(0);
      expect(対称差(打ち方, 幅), `\`${打ち方}\` が \`${幅}\` と違う行を出した`).toBe(0);
    }
  });

  it("寄せた形も幅の日付を案内に書く（其の方の表をそのまま通る証拠）", () => {
    expect(Recommender.relativeDayNotes("8月後半", 基準).join(" ")).toContain("2026年8月21日");
    expect(Recommender.relativeDayNotes("月半ば", 基準).join(" ")).toContain("2026年8月11日");
  });

  it("週の時合を壊さない（『今週後半』を『今下旬』に化けさせない）", () => {
    /* 裸の幅の規則は月の語にだけ効く – 前の文字が 数字・他の月の語・週の語の時は其の方の規則に
     * 譲る（其れを崩すと `8月中盤` は `8中旬` に化けて 0 行に落ちた – 実測で検出した）。 */
    expect(行列表("今週").length, "対照の `今週` が 0 行").toBeGreaterThan(0);
    expect(行列表("今週後半").length, "『今週後半』が幅に寄せられて行が増えた").toBe(0);
    expect(対称差("8月中盤", "8月中旬"), "`8月中盤` が壊れた").toBe(0);
    expect(対称差("来月中盤", "来月中旬"), "`来月中盤` が壊れた").toBe(0);
  });
});

describe("月前半は寄せない", () => {
  it("公用の区切りが無いので 0 行の侭、其の方の打ち方を教える", () => {
    expect(行列表("月前半").length, "`月前半` を上旬に寄せてしまった").toBe(0);
    expect(行列表("上旬").length, "対照の `上旬` が 0 行").toBeGreaterThan(0);
    const 案内 = Recommender.uiWordNoteJa("月前半");
    expect(案内).toContain("「月前半」");
    expect(案内, "公用の決まりが無い事を言っていない").toContain("公用の決まりが無い");
    expect(案内, "其の方の打ち方を教えない").toContain("『上旬』");
    expect(案内).toContain("『中旬』");
    expect(Recommender.uiWordLiveNoteJa("月前半")).toContain("『上旬』");
    /* 語を並べて打たれた形にも届く（第 354 回の合図）。 */
    expect(Recommender.uiWordNoteJa("月前半 オンライン")).toContain("「月前半」");
  });
});

describe("壊していない物", () => {
  it("其の方の幅・休日の案内・月の末の形は其侭", () => {
    for (const 語 of ["上旬", "中旬", "下旬", "8月上旬", "来月下旬", "8月中旬"]) {
      expect(行列表(語).length, `\`${語}\` が落ちた`).toBeGreaterThan(0);
    }
    expect(Recommender.relativeDayNotes("8月下旬", 基準).join(" ")).toContain("2026年8月21日");
    expect(対称差("8月末頃", "8月末"), "`8月末頃` が変わった").toBe(0);
    expect(対称差("来月末", "来月"), "対照の `来月末` が変わった").toBe(0);
    expect(行列表("今週末").length, "`今週末` が落ちた").toBeGreaterThan(0);
    expect(Recommender.uiWordNoteJa("月初")).toContain("公用の決まりが無い");
    expect(Recommender.uiWordNoteJa("週明け")).toContain("『月曜』");
    expect(Recommender.uiWordNoteJa("上半期")).toContain("『年度初め』");
    expect(Recommender.uiWordNoteJa("祝日 締切")).toContain("「祝日」");
    expect(行列表("土日").length, "`土日` が落ちた").toBeGreaterThan(0);
  });
});

describe("成果物", () => {
  it("三つの寄せが成果物の関数に一度ずつ在る", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 本文 = jsFunction(rec, "collapseRelativeDayPhrase");
    expect(本文.length, "`collapseRelativeDayPhrase` が見つからない").toBeGreaterThan(0);
    for (const 断片 of [
      "中旬の別の言い方",
      "下旬の別の言い方",
      "月終わりの言い方",
      "月の幅の裸の言い方",
    ]) {
      expect(本文.split(断片).length - 1, `関数の中の \`${断片}\` の数が変`).toBeGreaterThanOrEqual(
        1,
      );
    }
    /* 裸の形の規則は、月の語が繋がった形を寄せた **後ろ** に置く（前に置くと `8月後半` が
     * `8下旬` に化ける – 実測で落ちた順序）。 */
    expect(
      本文.indexOf("下旬の別の言い方,") < 本文.indexOf("月の幅の裸の言い方,"),
      "裸の形の寄せが先に来た（月を繋げた形が壊れる）",
    ).toBe(true);
  });
});
