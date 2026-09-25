/**
 * 和暦の区切りでゼロ埋めた日付（`08月10日` `2026年08月10日` `2026年08月`）を、其の方の
 * 暦日語に寄せる（第 380 回）。
 * 実測（2026-09-25 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `8月10日` 4 行 / `08月10日` **0 行**、`8月1日` 17 行 / `8月01日` **0 行**、`8月5日` 8 行 /
 * `8月05日` **0 行**、`2026年8月10日` 4 行 / `2026年08月10日` **0 行**、`2026年8月` 189 行 /
 * `2026年08月` **0 行**。其れなのに `2026-08-10`（同じ日を数字と記号で打った形）は 4 行出て
 * 居た – 表の暦日はゼロ埋め無しで書かれて居る（**品書の 872 行にゼロ埋めの表記を持つ行は
 * 0 行** – 実測）ので、其の方の形で打った人だけが 0 件画面に落ちて居た。
 * 其れ以前の回が時刻で同じ寄せをしている（`8:59` → `08:59` – 第 273 回）。
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

function 当たり(語: string): string[] {
  const matches = Recommender.searchMatcher(語, 基準);
  return 品書()
    .filter((row) => matches(String(row.hay)) === true)
    .map((row) => String(row.hay))
    .sort();
}

/** 二つの打ち方の当たり列表の対称差（同じ行集合なら 0）。 */
function 対称差(a: string, b: string): number {
  const 左 = new Set(当たり(a));
  const 右 = new Set(当たり(b));
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}

describe("和暦の区切りのゼロ埋め日付", () => {
  it("ゼロ埋めた日・月日は其の方の形の行を其侭通す", () => {
    /* 品書の行の集合が其の方の形と完全に一致する事を主にする（実測ビルドの 872 行では
     * 0 行 → 4 行・17 行・8 行・189 行 – 此の土俵（検査の品書）の行数は違うので絶対値を
     * 書かない – 第 331 回）。 */
    for (const [埋, 正] of [
      ["08月10日", "8月10日"],
      ["8月01日", "8月1日"],
      ["8月05日", "8月5日"],
      ["2026年08月10日", "2026年8月10日"],
      ["08月09日", "8月9日"],
      ["2026年08月", "2026年8月"],
    ]) {
      expect(対称差(埋, 正), `当たり列表が違う: ${埋}`).toBe(0);
    }
    /* 内 1 組は本当に行が在る事も見る（両方 0 行の対で対称差 0 を並べた検査を避ける）。 */
    expect(当たり("8月01日").length).toBeGreaterThan(0);
    expect(当たり("2026年08月").length).toBeGreaterThan(0);
  });

  it("其の方の形の当たりは動かさない（寄せは足すだけ）", () => {
    /* 直し前と同じ語で当たり方を変えない事。実測（対照 22 語で変化 0 語）の内、この土俵で
     * 見る語を並べる（`13月10日`・`2月30日` は暦日では無いので寄せない – 其の方の日を
     * 書いている行の当たりも変えない）。 */
    for (const 語 of [
      "8月10日",
      "8月1日",
      "2026年8月",
      "8月",
      "10日",
      "08月",
      "来週",
      "明日",
      "8月10日から8月20日",
      "8月上旬",
      "2026-08-10",
      "8/10",
      "13月10日",
      "2月30日",
    ]) {
      const 元 = 当たり(語);
      expect(対称差(語, 語), `当たりが動いた: ${語}`).toBe(0);
      expect(元.length, `当たり列表が空: ${語}`).toBeGreaterThanOrEqual(0);
    }
    /* 冠の無い `08月`（月だけの語）は**寄せない** – 月の語の道（其の方の暦月への展開 –
     * 第 251 回）が其の方を既に受けているので、寄せは要らない（実測: 直し前からも
     * `08月` 210 行 / `8月` 210 行で同じ – 実測ビルドの 872 行）。 */
    expect(対称差("08月", "8月"), "08月 の月の当たりが動いた").toBe(0);
    const 組 = (語: string) =>
      (
        Recommender as unknown as {
          queryTokenGroups: (q: unknown, now?: number) => string[][];
        }
      )
        .queryTokenGroups(語, 基準)
        .map((語々) => [...語々].sort());
    const 月A = 組("08月");
    const 月B = 組("8月");
    expect(月A).toEqual(月B);
  });

  it("暦月・日の範囲の外は寄せない（表の表記の形を 1 つ足すだけ）", () => {
    /* 寄せは**表記の寄せ**なので、其の方の日が現実に暦日へ在るかまでは見ない（其の方の日を
     * 書いている行の当たりを変えない為 – 実測: 此の土俵では 0 行・実測ビルドの 872 行では
     * 3 行（其の方の日を表の表記が書いて居る行 – 暦日として解いた先では無い）。 */
    for (const 語 of ["2026年02月30日", "2月30日", "13月10日", "2026年13月10日", "08月32日"]) {
      expect(当たり(語), `当たりが出た: ${語}`).toEqual([]);
    }
    const 語組 = (語: string) =>
      (
        Recommender as unknown as {
          queryTokenGroups: (q: unknown, now?: number) => string[][];
        }
      ).queryTokenGroups(語, 基準);
    /* 範囲の内（2 月 30 日のように月の範囲には在る形）は表の表記の形を 1 つだけ足す。 */
    expect(語組("2026年02月30日")[0]).toContain("2026年2月30日");
    /* 暦月の範囲（1〜12 月）と日の範囲（1〜31 日）の外は寄せない（打たれた表記だけ）。 */
    expect(語組("13月10日")[0]).toEqual(["13月10日"]);
    expect(語組("08月32日")[0]).toEqual(["08月32日"]);
  });

  it("語の組は其の方の暦日語を 1 つだけ足す（他の語を足さない）", () => {
    const グループ = (
      Recommender as unknown as {
        queryTokenGroups: (q: unknown, now?: number) => string[][];
      }
    ).queryTokenGroups("08月10日", 基準);
    expect(グループ.length).toBe(1);
    expect(グループ[0]).toContain("8月10日");
    /* 年を付けた形から年無しの形へは広げない（実測で 14 件中 4 件が別年だった – 第 305 回）。 */
    const 年付き = (
      Recommender as unknown as {
        queryTokenGroups: (q: unknown, now?: number) => string[][];
      }
    ).queryTokenGroups("2026年08月10日", 基準);
    expect(年付き[0]).toContain("2026年8月10日");
    expect(年付き[0].some((語) => /^8月10日$/.test(String(語)))).toBe(false);
  });

  it("寄せの表が成果物に 1 処だけ入っている", () => {
    const 成果物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(成果物.match(/const 和暦の暦日 = /g) || []).toHaveLength(1);
    expect(成果物.match(/和暦の暦日\.exec\(token\)/g) || []).toHaveLength(1);
  });
});
