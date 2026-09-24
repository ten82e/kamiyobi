/**
 * 「今週末」「3月中」の検査（SPEC §4・§7・第 341 回）。
 * 実測（2026-09-30 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `週末` 268 行・`今週` 19 行・`3月` 80 行が通るのに、`今週末` **0 行**・`来週末` **0 行**・
 * `先週末` **0 行**・`3月中` **0 行**・`11月中` **0 行**だった（件数欄の解決も無し）。
 * 研究計画の「今週末に締まる物があるか」「3月中に出せるか」は普通の聞き方。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
/* 暦の語の検査は基準日を動かして二本立てる（第 339 回の教訓 – 固定時刻は日曜）。 */
const 水曜 = Date.parse("2026-08-12T00:00:00Z");

function 行集合(語: string, 基準日: number = 基準): Set<string> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
  const matches = Recommender.searchMatcher(語, 基準日);
  return new Set(
    rows.filter((row) => matches(String(row.hay)) === true).map((row) => String(row.hay)),
  );
}

function 対称差(a: string, b: string, 基準日: number = 基準): number {
  const x = 行集合(a, 基準日);
  const y = 行集合(b, 基準日);
  return [...x].filter((k) => !y.has(k)).length + [...y].filter((k) => !x.has(k)).length;
}

function 和集合(...語列表: string[]): Set<string> {
  const out = new Set<string>();
  語列表.forEach((語) => {
    行集合(語).forEach((行) => {
      out.add(行);
    });
  });
  return out;
}

function 解決(語: string, 基準日: number = 基準): string {
  return Recommender.relativeDayNotes(語, 基準日).join(" ");
}

describe("『今週末』型の言い方", () => {
  it("其の週の土曜・日曜に解ける（裸の `週末` に寄せない）", () => {
    /* 裸の `週末` は土曜・日曜の締切全般（実測 268 行 – 今週以外も含む）なので、週を名指した
     * 形をそこに寄せると別週の週末まで出す。其の週の暦日 2 日に解く事を見る。 */
    const 今週末 = 行集合("今週末");
    expect(今週末.size, "`今週末` が 0 行").toBeGreaterThan(0);
    const 期待 = 和集合("今週土曜", "今週日曜");
    const 余 = [...今週末].filter((k) => !期待.has(k)).length;
    const 足 = [...期待].filter((k) => !今週末.has(k)).length;
    expect(余 + 足, "`今週末` が今週土曜・今週日曜の和集合と違う").toBe(0);
    /* 別週と混ざっていない事（来週末と同じ行集合なら誤り）。 */
    const 来週末 = 行集合("来週末");
    expect(来週末.size, "`来週末` が 0 行").toBeGreaterThan(0);
    expect(
      [...来週末].filter((k) => !今週末.has(k)).length,
      "`来週末` が今週の行を含んでいる",
    ).toBeGreaterThan(0);
    /* 週を名指さない形には含まれる（寄せたのではなく、別の言い方である事）。 */
    expect(
      [...来週末].every((k) => 行集合("週末").has(k)),
      "`来週末` が週末全般の外を出した",
    ).toBe(true);
  });

  it("件数欄が解けた日をすべて書く（一日だけ名指す案内にしない）", () => {
    const 文 = 解決("今週末");
    expect(文).toContain("2026年8月8日(土)");
    expect(文, "日曜を書いていない").toContain("2026年8月9日(日)");
    expect(文, "別の週を含まない事を隠した").toContain("別の週の週末は含みません");
    /* 基準日を水曜に寄せると今週末は 8/15・8/16（週は月始まり – 第 339 回と同じ暦の決まり）。 */
    const 水 = 解決("今週末", 水曜);
    expect(水).toContain("2026年8月15日(土)");
    expect(水).toContain("2026年8月16日(日)");
    /* 一日に解ける形（`今週土曜`）は今まで通り一日だけ書く。 */
    const 一日 = 解決("今週土曜");
    expect(一日).toContain("2026年8月8日(土)");
    expect(一日, "一日の語に『土曜・日曜』と書いた").not.toContain("土曜・日曜に締まる物です");
  });

  it("`今週末まで` は期日として受ける", () => {
    expect(行集合("今週末まで").size, "`今週末まで` が 0 行").toBeGreaterThan(0);
  });
});

describe("『3月中』型の言い方", () => {
  it("其の月の語と同じ行を出す（全角も同じ）", () => {
    [
      ["3月中", "3月"],
      ["3月中に", "3月"],
      ["３月中", "3月"],
      ["12月中", "12月"],
    ].forEach(([打たれた語, 対照]) => {
      expect(行集合(対照).size, `対照の "${対照}" が 0 行`).toBeGreaterThan(0);
      expect(対称差(打たれた語, 対照), `"${打たれた語}" が "${対照}" と違う行を出した`).toBe(0);
    });
  });

  it("月に見えない形を寄せない（`13月中` `5人中`）", () => {
    /* 月として有り得ない数値はそのまま – 別の語と取り違えない。 */
    expect(行集合("13月中").size, "`13月中` に行が出た（月で無い形を寄せる）").toBe(0);
    expect(行集合("5人中").size, "`5人中` に行が出た").toBe(0);
    /* 寄せたか否かは行数では見えない（月として有り得ない語は寄せなくても 0 行）–
     * 打たれた語がそのまま残っている形で見る（第 341 回の改ざんで判明した検査の穴）。 */
    const 群 = (語: string) => Recommender.queryTokenGroups(語, 基準) as unknown as string[][];
    expect(群("13月中")[0], "`13月中` が月の語へ寄せられた").toContain("13月中");
    expect(群("5人中")[0], "`5人中` が月の語へ寄せられた").toContain("5人中");
  });

  it("上旬・中旬・下旬を壊さない（`12月中旬` を `12月旬` にしない）", () => {
    /* 実発生（第 341 回）: `N月中` の語尾を剥がす作りは `12月中旬` を巻き込んで、
     * 上旬・中旬・下旬の表（第 332 回）の検査を 2 本落とした。 */
    ["12月上旬", "12月中旬", "12月下旬"].forEach((語) => {
      expect(行集合(語).size, `"${語}" が 0 行になった（語を壊した）`).toBeGreaterThan(0);
    });
    const 十二月中旬 = 行集合("12月中旬");
    const 十二月 = 行集合("12月");
    expect(
      [...十二月中旬].every((k) => 十二月.has(k)),
      "`12月中旬` が 12 月の外を出した",
    ).toBe(true);
    expect(十二月中旬.size, "`12月中旬` が 12 月全体と同じ広さ（中が落ちている）").toBeLessThan(
      十二月.size,
    );
  });
});

describe("成果物", () => {
  it("組み立てた品が二つの言い方を持つ（第 341 回）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(rec.includes("月中"), "月中の寄せが消えた").toBe(true);
    /* 週の語に `末` を続ける形（`今週末`） – 週語の表に 前週・翌週 が入っている事も見る。 */
    expect(/前週\|翌週/.test(rec), "週語の選択が壊れた").toBe(true);
    /* `jsFunction` で抜き出す検査が有るので、月の寄せは関数の中に入っている事。 */
    const 関数 = rec.slice(rec.indexOf("function collapseRelativeDayPhrase"));
    expect(
      関数.slice(0, 2400).includes("月中"),
      "月中の寄せが関数の外に出た（抜き出し検査が壊れる）",
    ).toBe(true);
  });
});
