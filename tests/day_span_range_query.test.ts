/**
 * 暦日を二つ並べて打つ幅の検査。SPEC §4・§7・第 371 回。
 * 実測（2026-10-24 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）の直し前は、
 * 日の語が単体で通るのに幅が通らなかった –
 *   `8月10日` 4 行・`8月20日` 13 行 / `8月10日から8月20日` **0 行**・`8月10日〜8月20日` **0 行**・
 *   `8月10日から8月20日まで` **0 行**・`2026年8月10日から8月20日` **0 行**・`8/10から8/20` **0 行**
 * `8/10〜8/20` 37 行は幅ではなく両端の語を両方持つ行だった（`8月10日 8月20日` と並べた形と同じ）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 波 = "\u{301c}";

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

function 幅の件数欄(語: string): string {
  const 対 = Recommender.dayRangePairs(語, 基準) as Array<[string, string]>;
  return 対.length > 0 ? 対[0][1] : "";
}

describe("暦日を二つ並べた幅", () => {
  it("区切りの記号が変わっても同じ行が出る（『から』が基準）", () => {
    expect(
      行列表("8月10日から8月20日").length,
      "基準の『8月10日から8月20日』が通っていない",
    ).toBeGreaterThan(0);
    for (const 打ち方 of [
      `8月10日${波}8月20日`,
      `8月10日\u{ff5e}8月20日`,
      "8月10日~8月20日",
      "8月10日-8月20日",
      "8月10日\u{ff0d}8月20日",
      "8/10から8/20",
      `8/10${波}8/20`,
      "8月10日から8月20日まで",
      "2026年8月10日から8月20日",
    ]) {
      expect(
        対称差("8月10日から8月20日", 打ち方),
        `\`${打ち方}\` が『から』と違う行を出している`,
      ).toBe(0);
    }
  });

  it("件数欄には其の幅の日付が書かれる", () => {
    const 基準の幅 = 幅の件数欄("8月10日から8月20日");
    expect(基準の幅, "『8月10日から8月20日』の幅の件数欄が出ていない").toBe(
      "2026年8月10日から2026年8月20日",
    );
    for (const 打ち方 of [`8月10日${波}8月20日`, "8/10から8/20", "8月10日-8月20日"]) {
      expect(幅の件数欄(打ち方), `\`${打ち方}\` の件数欄が基準と同じ幅を書いていない`).toBe(
        基準の幅,
      );
    }
  });

  it("両端の語を両方持つ行に狭まらない（幅として受ける）", () => {
    const 幅 = new Set(行列表("8月10日から8月20日"));
    const 両端 = new Set(行列表("8月10日 8月20日"));
    for (const 語 of ["8月10日", "8月20日"]) {
      for (const 行 of 行列表(語)) {
        expect(幅.has(行), `幅が \`${語}\` の行を落としている`).toBe(true);
      }
    }
    expect(幅.size, "幅が両端を並べた形と 同じ広さにならない").toBeGreaterThan(両端.size);
  });

  it("年を跨ぐ幅は翌年として受け、過ぎた幅も翌年として受ける", () => {
    expect(対称差("12月25日から1月10日", `12月25日${波}1月10日`)).toBe(0);
    expect(幅の件数欄("12月25日から1月10日"), "年跨ぎの幅が化けている").toBe(
      "2026年12月25日から2027年1月10日",
    );
    /* 基準（2026-08-09）より前の幅を年無しで打たれた時は翌年として受ける –
       過ぎた幅を其の年に黙って取らない（締切の推測はしない）。 */
    expect(幅の件数欄("7月1日から7月20日"), "過ぎた幅を其の年受けた").toBe(
      "2027年7月1日から2027年7月20日",
    );
  });

  it("暦に無い日・広すぎる幅は幅に解かない（後側が日だけなら其の月を継ぐ – 第 376 回）", () => {
    expect(幅の件数欄("2月10日から2月30日"), "暦に無い日を幅に解いた").toBe("");
    expect(幅の件数欄("8月10日から12月20日"), "四か月分の幅を解いた").toBe("");
    /* 後側を日だけで打つ形は第 371 回では解けず置いていた – 原因は其の方の語の入口に届いて
       いない事だった（第 376 回で究明 – tests/bare_day_span_query.test.ts に詳しく置く）。 */
    expect(幅の件数欄("8月10日から20日"), "後側が日だけの形を幅に解かない").toBe(
      "2026年8月10日から2026年8月20日",
    );
  });
});

describe("其れ以外の幅の規則（語を分ける規則と其の方の語を結ぶ規則）を動かしていない事", () => {
  it("二語を波ダッシュで繋いだ形は、空白で並べた形と同じ行を出す", () => {
    expect(対称差("スパコン HPC", `スパコン${波}HPC`)).toBe(0);
  });

  it("月の幅・旬の幅・月のまとまりの語は其の方の規則が受けた侭", () => {
    expect(対称差("8月から11月", `8月${波}11月`)).toBe(0);
    expect(行列表(`上旬${波}中旬`).length).toBe(行列表("上旬〜中旬").length);
    expect(行列表("8月下旬").length, "『8月下旬』が通らなくなった").toBeGreaterThan(0);
    expect(行列表("今月末").length, "『今月末』が通らなくなった").toBeGreaterThan(0);
    expect(行列表("9月以降").length, "『9月以降』が通らなくなった").toBeGreaterThan(0);
  });
});

describe("成果物", () => {
  it("直し方が実測どおりの形で成果物に入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const app = readFileSync(join(builtSite(), "app.js"), "utf8");
    for (const [条目, 数] of [
      ["function dayRangeTermsJa", 1],
      ["function dayRangePairs", 1],
      ["const DAY_RANGE = new RegExp(", 1],
      ['"$1月$2日から$3月$4日"', 2],
      ["const dayRange = dayRangeTermsJa(token, now);", 1],
    ] as Array<[string, number]>) {
      expect(rec.split(条目).length - 1, `成果物の中の語の数: ${条目.slice(0, 16)}`).toBe(数);
    }
    expect(app.split("Recommender.dayRangePairs(query, now)").length - 1).toBe(1);
  });
});
