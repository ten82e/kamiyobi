/**
 * 「N 日以内」の案内が、**引き方の範囲**を噓なく言っているかの検査（SPEC §4・§7・第 319 回）。
 * 語の展開は行が書く暦日の語で引くので、行に書かれた**別の締切ラウンドや会期の日付**でも当たる。
 * 2026-08-09 生成の実ビルドの品書 872 行で実測: `30日以内` は 249 行に当たり、うち一覧に出る
 * 締切が 30 日以内に無い行が **38 行**（8 行はすでに過ぎた締切）。`7日以内` は 60 行中 19 行、
 * `90日以内` は 593 行中 51 行。件数欄は幅だけを言い、その幅が行の文字列全体で引いていることを
 * 言っていなかった（第 315 回・第 318 回の実装の残り欠け – 第 253 回が展開しなかった理由その物）。
 * 締切日からの日数で確実に絞る欄（`site/template.html` の「締切まで」）が既にあるので、そこへ連れていく。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string; t: number };

const AT = Date.parse("2026-08-09T00:00:00Z");
const DAY = 86_400_000;
/** 画面の絞り込み欄の見出し（案内が書く語は画面と違っていてはいけない）。 */
const 欄名 = /for="win">([^<]+)</.exec(
  readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8"),
)?.[1];

function 品書(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")),
  ) as Row[];
}

function 幅の案内(query: string): string {
  return Recommender.relativeDayNotes(query, AT).join("");
}

describe("「N 日以内」の案内が引き方の範囲を言う", () => {
  it("幅だけを見て安心させる文にしない", () => {
    expect(欄名, "画面の絞り込み欄の見出しが見つからない").toBe("締切まで");
    const 言い切りだけ: Record<string, string> = {
      "30日以内": "30日以内 = 2026年8月9日(日)〜9月8日(火)",
      "7日以内": "7日以内 = 2026年8月9日(日)〜8月16日(日)",
      "1週間以内": "7日以内 = 2026年8月9日(日)〜8月16日(日)",
    };
    ["30日以内", "7日以内", "1週間以内"].forEach((query) => {
      const 文 = 幅の案内(query);
      /* 幅の両端（初日と末日）を固定する – 末日を落とすと範囲が広がったままになる。 */
      expect(文.split(" – ")[0], `"${query}": 幅の言い切りが実測の暦日と違う`).toBe(
        言い切りだけ[query],
      );
      expect(文, `"${query}" の案内が出ていない`).not.toBe("");
      expect(文.includes("行に書かれた他の日付"), `"${query}": 引き方の範囲を言っていない`).toBe(
        true,
      );
      expect(文.includes("会期"), `"${query}": 会期の日付で当たる行があることを言っていない`).toBe(
        true,
      );
      expect(文.includes(`「${欄名}」`), `"${query}": 画面の語で絞り込み欄を指していない`).toBe(
        true,
      );
      /* 幅を言う手を止めてはいけない（第 318 回 – 週で打った人に換算を見せるための部分）。 */
      expect(
        /[0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日/.test(文),
        `"${query}": 幅の日付を落とさせた`,
      ).toBe(true);
    });
  });

  it("注意文は範囲を引く語だけに出す", () => {
    /* 幅を引いていない語（`10日後` `3日前` `再来週`）に「別の締切ラウンド・会期でも当たる」と
     * 書くのは筋が違う – 暦日を一拍で引く語の話に絞る。 */
    const 注意 = "行に書かれた他の日付";
    ["10日後", "3日前", "2026年9月1日"].forEach((query) => {
      const 文 = 幅の案内(query);
      expect(文.includes(注意), `"${query}" に範囲の注意を付けた`).toBe(false);
    });
    /* 寄せない語（月の単位）は第 253 回の案内が持っていて、二重に言わない。 */
    expect(幅の案内("1か月以内"), "寄せない語に幅の案内まで出した").toBe("");
    const 既存 = Recommender.dayRangeNoteJa("1か月以内", AT);
    expect(既存.includes("締切まで"), "月の単位を絞り込み欄へ導いていない").toBe(true);
    expect(既存.includes(注意), "同じ注意を二つの案内で言っている").toBe(false);
  });

  it("実データで、幅内の締切を持たない行が本当に混じる", () => {
    /* 注意文が噓でないことの裏取り（品書 872 行・固定時刻 2026-08-09）。この混入が無くなったら
     * 注意文を直すと合図する – 検査が前提の崩れを教える形にする。 */
    const rows = 品書();
    expect(rows.length, "ビルド成果物の行が読めない（検査が空振り）").toBeGreaterThan(100);
    let 混入 = 0;
    let 当たり = 0;
    rows.forEach((row) => {
      if (Recommender.searchMatcher("30日以内", AT)(row.hay) !== true) return;
      当たり += 1;
      const 日数 = (Number(row.t) - AT) / DAY;
      if (!(日数 >= 0 && 日数 <= 30)) 混入 += 1;
    });
    expect(当たり, "`30日以内` が 0 行（検査が空振り）").toBeGreaterThan(100);
    expect(混入, "幅内の締切を持たない行が混ざらなくなった（注意文を見直す）").toBeGreaterThan(0);
  });
});
