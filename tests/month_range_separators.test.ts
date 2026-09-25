/**
 * 月と月を繋いだ幅の打ち方の検査。SPEC §4・§7・第 370 回。
 * 実測（2026-10-24 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）で、直し前は
 * 『から』で打つ形だけが通っていた –
 *   `8月から11月` 673 行 / `8月〜11月` **64 行**（= `8月 11月` の AND）・`8月～11月` **0 行**・
 *   `8月~11月` **0 行**・`8月-11月` **0 行**・`8月－11月` **0 行**・`8月ー11月` **0 行**
 * 後側を数字の月以外で打つ形も落ちていた – `8月から12月` 772 行 / `来月から再来月` **0 行**・
 * `先月から今月` **0 行**・`来月〜再来月` 19 行（其の方の語を両方持つ行だけ）。
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
  const 対 = Recommender.monthRangePairs(語, 基準) as Array<[string, string]>;
  return 対.length > 0 ? 対[0][1] : "";
}

describe("月と月を繋いだ打ち方", () => {
  it("区切りの記号が変わっても同じ行が出る（『から』が基準）", () => {
    expect(行列表("8月から11月").length, "基準の『8月から11月』が通っていない").toBeGreaterThan(0);
    for (const 区切り of [波, "\u{ff5e}", "~", "-", "\u{ff0d}", "\u{30fc}", "\u{2212}"]) {
      const 打ち方 = `8月${区切り}11月`;
      expect(対称差("8月から11月", 打ち方), `\`${打ち方}\` が『から』と違う行を出している`).toBe(0);
    }
  });

  it("件数欄には同じ幅の日付が書かれる", () => {
    const 基準の幅 = 幅の件数欄("8月から11月");
    expect(基準の幅, "『8月から11月』の幅の件数欄が出ていない").toContain("2026年8月");
    for (const 区切り of [波, "\u{ff5e}", "~", "\u{ff0d}"]) {
      expect(
        幅の件数欄(`8月${区切り}11月`),
        `\`8月${区切り}11月\` の件数欄が基準と同じ幅を書いていない`,
      ).toBe(基準の幅);
    }
  });

  it("後側も前側と同じ月の語で打てる（相対月語 – 数字の月だけだった）", () => {
    expect(行列表("来月から再来月").length, "『来月から再来月』が通らない").toBeGreaterThan(0);
    expect(対称差("来月から再来月", `来月${波}再来月`)).toBe(0);
    expect(幅の件数欄(`来月${波}再来月`), "相対月語の幅が別の幅になっている").toBe(
      幅の件数欄("来月から再来月"),
    );
    /* 前の月に掛かる幅は其の前の月を見る – 翌年に繰り下げない（月の語の決まり）。 */
    expect(幅の件数欄(`先月${波}今月`)).toContain("2026年7月");
    expect(幅の件数欄(`先月${波}今月`)).toContain("2026年8月");
  });

  it("年を跨ぐ幅は翌年として受ける", () => {
    expect(対称差("11月から2月", `11月${波}2月`)).toBe(0);
    expect(幅の件数欄(`11月${波}2月`)).toBe("2026年11月から2027年2月");
    /* 年を付けた前側に対して後の側が前の月 – 前側の年に引き戻すと幅が逆になる
     * （其の年の其の月は其れより前なので、翌年として受ける – 改ざん検査で検出した）。 */
    expect(幅の件数欄("来年8月から3月"), "前側が来年の幅が化けている").toBe(
      "2027年8月から2028年3月",
    );
    expect(対称差("来年8月から3月", `来年8月${波}3月`)).toBe(0);
  });

  it("柔らかな語を添えた形（『辺り』『頃』）も同じ幅", () => {
    for (const 接尾の語 of ["まで", "辺り", "あたり", "頃"]) {
      expect(
        対称差("8月から11月", `8月から11月${接尾の語}`),
        `\`8月から11月${接尾の語}\` が別の行を出している`,
      ).toBe(0);
    }
  });

  it("月の数として有り得ない形は幅に解かない", () => {
    expect(幅の件数欄(`8月${波}36月`), "有り得ない月を幅に解いた").toBe("");
    expect(行列表(`8月${波}36月`).length).toBe(0);
  });
});

describe("其れ以外の語を波ダッシュで繋いだ打ち方（語を分ける規則は動かさない）", () => {
  it("二語を波ダッシュで繋いだ形は、空白で並べた形と同じ行を出す", () => {
    expect(対称差("スパコン HPC", `スパコン${波}HPC`)).toBe(0);
    expect(対称差("ネットワーク セキュリティ", `ネットワーク${波}セキュリティ`)).toBe(0);
  });

  it("日の幅と旬の幅の波ダッシュは其の方の規則が受けた侭", () => {
    expect(行列表(`8/10${波}8/20`).length).toBe(行列表("8/10〜8/20").length);
    expect(行列表(`上旬${波}中旬`).length).toBe(行列表("上旬〜中旬").length);
    expect(行列表(`今週${波}来週`).length).toBe(行列表("今週〜来週").length);
  });
});

describe("成果物", () => {
  it("直し方が実測どおりの形で成果物に入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const [条目, 数] of [
      ['"$1月から"', 1],
      ["const MONTH_RANGE_SPAN =", 1],
    ] as Array<[string, number]>) {
      expect(rec.split(条目).length - 1, `成果物の中の語の数: ${条目.slice(0, 14)}`).toBe(数);
    }
    /* 区切りの列に波ダッシュ・全角チルダ・半角チルダ・ハイフン（半角・全角）・長音が入っている。 */
    expect(rec).toContain("月[〜～~](?=");
    expect(rec).toMatch(/月\(\?:から\|より\|へ\|〜\|～\|~/);
  });
});
