/**
 * 締切の言い方の揺れ（`8月締め`・`8月末`）と和暦の日付（`令和8年8月22日`）の検査（SPEC §4・§7・第 344 回）。
 * 実測（2026-10-02 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `8月` 210 行・`締切` 709 行・`2026年8月22日` 12 行が通るのに、`8月締め` **0 行**・`来月締め`
 * **0 行**・`8月〆` **0 行**（`〆` 単独は 709 行）・`8月末` **0 行**（`今月末` 189 行は通る）・
 * `令和8年8月22日` **0 行**だった。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 行列表(語: string): string[] {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
  const matches = Recommender.searchMatcher(語, 基準);
  return rows.filter((row) => matches(String(row.hay)) === true).map((row) => String(row.hay));
}

function 行集合(語: string): Set<string> {
  return new Set(行列表(語));
}

function 対称差(a: string, b: string): number {
  const x = 行集合(a);
  const y = 行集合(b);
  return [...x].filter((k) => !y.has(k)).length + [...y].filter((k) => !x.has(k)).length;
}

function 群(語: string): string[] {
  const groups = Recommender.queryTokenGroups(語, 基準) as unknown as string[][];
  return groups[0] || [];
}

function 全案内(語: string): string {
  return [
    Recommender.querySynonymNotes(語).join(" "),
    Recommender.uiWordNoteJa(語),
    Recommender.uiWordLiveNoteJa(語),
    Recommender.relativeDayNotes(語, 基準).join(" "),
  ]
    .filter((文) => 文)
    .join(" / ");
}

describe("月や週に締切の語を繋げて打つ形", () => {
  it("期間の語と『締切』の両方が書かれた行に出会う", () => {
    expect(行列表("8月").length, "対照の `8月` が 0 行").toBeGreaterThan(0);
    expect(行列表("8月締め").length, "`8月締め` が 0 行").toBeGreaterThan(0);
    /* 繋げた打ち方は二語の AND – 月の語単独より狭くなり、締切の語単独にも入らない。 */
    const 月 = 行集合("8月");
    const 締 = 行集合("締切");
    行列表("8月締め").forEach((行) => {
      expect(月.has(行), "`8月締め` が其の月の外の行を出した").toBe(true);
      expect(締.has(行), "`8月締め` が『締切』を含まない行を出した").toBe(true);
    });
    /* 書き方の違いは同じ行集合に寄せる（`〆` は照合が「締」に寄せる – 繋げた時は月の語が消えて
     * いた – 第 344 回の実発生）。 */
    expect(対称差("8月締め", "8月〆"), "`8月〆` が `8月締め` と違う行を出した").toBe(0);
    expect(対称差("来月締め", "来月〆"), "`来月〆` が `来月締め` と違う行を出した").toBe(0);
    expect(対称差("来月締め", "来月 締切"), "`来月締め` が二語で打った人とは違う行を出した").toBe(
      0,
    );
    /* 月末を挟む形も同じ処まで届く（寄せの順番 – 実測で 0 行だった）。 */
    expect(行列表("3月末締め").length, "`3月末締め` が 0 行（寄せの順番が壊れた）").toBeGreaterThan(
      0,
    );
  });

  it("件数欄が分けて探した事を打たれた語で書く", () => {
    const 案内 = 全案内("8月締め");
    expect(案内).toContain("8月締め");
    expect(案内, "分けて探した事を隠した").toContain("に分けて探しています");
    expect(案内, "『締切まで』の欄の話を落とした").toContain("締切まで");
    /* 名指す期間の語は実際に照った形 – `3月末締め` で探するのは `3月`（月末は其の月の語に寄せる）。 */
    expect(全案内("3月末締め"), "探していない語を画面に書いた").toContain("「3月」と「締切」");
    /* 語を足さない打ち方にこの案内は立たない。 */
    expect(全案内("8月")).not.toContain("に分けて探しています");
  });
});

describe("裸の『締め』は表その物の語の侭にする", () => {
  it("『締切』に寄せず、0 件の理由と打ち直し方を言う", () => {
    /* 『締切』は 872 行中 709 行に当たる – 寄せると絞り込みにならない 709 行が出るだけなので、
     * 「この表の全行にあてはまる語」と言う既の契約を守る（第 239 回）。 */
    expect(行列表("締め").length, "`締め` が『締切』に寄せられた").toBe(0);
    expect(Recommender.wholeTableQueryWordJa("締め"), "`締め` を表その物の語としていない").toBe(
      "締め",
    );
    ["締切り", "しめきり", "締め切り"].forEach((語) => {
      expect(行列表(語).length, `${語} が当たるようになった（前提が変わった）`).toBe(0);
      expect(Recommender.wholeTableQueryWordJa(語), `${語} を表その物の語としていない`).toBe(語);
    });
  });
});

describe("`N月末` の言い方", () => {
  it("其の月の語に寄せる（`今月末` `来月末` と同じ頼み方）", () => {
    expect(行列表("8月末").length, "`8月末` が 0 行").toBeGreaterThan(0);
    expect(対称差("8月末", "8月"), "`8月末` が `8月` と違う行を出した").toBe(0);
    expect(対称差("12月末", "12月"), "`12月末` が `12月` と違う行を出した").toBe(0);
    /* 月のまとまりの検査（第 341 回）と同じ守り – 範囲外の数値と別の語を寄せない。 */
    expect(群("13月末"), "`13月末` を寄せた").toContain("13月末");
    const 五人 = Recommender.queryTokenGroups("5人月末", 基準) as unknown as string[][];
    expect((五人[0] || []).join(""), "語が割れない打ち方を壊した").toContain("5人月末");
  });
});

describe("和暦の日付", () => {
  it("月日まで打たれた形は其の暦日に解ける", () => {
    expect(行列表("2026年8月22日").length, "対照の `2026年8月22日` が 0 行").toBeGreaterThan(0);
    expect(
      対称差("令和8年8月22日", "2026年8月22日"),
      "`令和8年8月22日` が西暦と違う行を出した",
    ).toBe(0);
    /* 年を付けない `8月22日` は足さない – 他の年の同じ日を持ってくる（第 329 回と同じ判断）。 */
    expect(群("令和8年8月22日"), "年を付けない暦日を足した").not.toContain("8月22日");
    expect(群("令和8年8月")).toContain("2026年8月");
  });

  it("有り得ない月は西暦に直さない", () => {
    expect(群("令和8年13月4日"), "`令和8年13月4日` を寄せた").toContain("令和8年13月4日");
    expect(行列表("令和8年13月4日").length).toBe(0);
  });
});

describe("成果物", () => {
  it("組み立てた品が三つの言い方を持ち、寄せが関数の中にある", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 関数 = rec.slice(rec.indexOf("function collapseRelativeDayPhrase("));
    expect(関数.length, "`collapseRelativeDayPhrase` が見つからない").toBeGreaterThan(0);
    const 本文 = 関数.slice(0, 3000);
    expect(本文.includes("月末"), "`N月末` の寄せが成果物から消えた").toBe(true);
    expect(本文.includes("$1 締切"), "繋げた締切の語の寄せが成果物から消えた").toBe(true);
    const 和暦関数 = rec.slice(rec.indexOf("function eraYearTermsJa("));
    expect(
      /\(\(\?:\[0-9\]\{1,2\}\)日\)/.test(和暦関数.slice(0, 2600)),
      "和暦の日（`令和8年8月22日`）を受ける形が消えた",
    ).toBe(true);
    /* 裸の『締め』を『締切』へ寄せる案は棄却した – 寄せた形の説明が成果物に立っていない事で
     * 守る（注釈はビルドで消えるので注釈を見てはいけない – 第 344 回の実測）。 */
    expect(rec.includes("欄「締切」"), "裸の『締め』を『締切』に寄せる形に戻った").toBe(false);
  });
});
