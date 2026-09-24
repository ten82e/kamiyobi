/**
 * 「1週間以内」「2週間後」「再来週」のように**週の単位で打った人**の検査（SPEC §4・§7・第 318 回）。
 * 画面の絞り込みは `7 日以内` `30 日以内` の日数で並ぶが、人は週の単位で数える – 週の語が
 * 展開されず 0 行だった（2026-09-26 実測・2026-08-09 生成ビルドの品書 872 行:
 * `1週間以内` `2週間以内` `3週間以内` `3週間後` すべて **0 行** / 寄せ先の `7日以内` 60 行、
 * `14日以内` 111 行、`21日後` 8 行。`来週` 53 行 / `再来週` **0 行**、`先週` 26 行 / `先々週` **0 行**、
 * 月語の `再来月` は 188 行で通っていた）。
 * 検査は品書（ビルド成果の catalog.json）と収録（`data/snapshot.json`）の両方に行う。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string };

const AT = Date.parse("2026-08-09T00:00:00Z");
const DAY = 86_400_000;

function corpora(): { label: string; rows: Row[] }[] {
  const built = JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8"));
  const snapshot = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8"));
  return [
    { label: "品書", rows: Recommender.candidateRows(built) as Row[] },
    { label: "収録", rows: Recommender.candidateRows(snapshot) as Row[] },
  ];
}

function reaching(rows: Row[], query: string): Set<Row> {
  const match = Recommender.searchMatcher(query, AT);
  return new Set(rows.filter((row) => match(row.hay) === true));
}

/** 品書の行が書く「2026年8月16日」形式の暦日のうち、今日からの日数の幅を調べる。 */
function 距今の幅(row: Row): number[] {
  const out: number[] = [];
  const text = String(row.hay);
  for (const hit of text.matchAll(/([0-9]{4})年([0-9]{1,2})月([0-9]{1,2})日/g)) {
    const ms = Date.UTC(Number(hit[1]), Number(hit[2]) - 1, Number(hit[3]));
    if (Number.isFinite(ms)) out.push(Math.round((ms - AT) / DAY));
  }
  return out;
}

describe("週の単位で打った人", () => {
  it("日数で打った人と、同じ行に会う", () => {
    let 当たった行 = 0;
    corpora().forEach(({ label, rows }) => {
      [
        ["1週間以内", "7日以内"],
        ["2週間以内", "14日以内"],
        ["3週間以内", "21日以内"],
        ["12週間以内", "84日以内"],
        ["1週間後", "7日後"],
        ["3週間後", "21日後"],
        ["2週間先", "14日後"],
        ["2 週間以内", "14日以内"],
      ].forEach(([週, 日]) => {
        const byWeek = reaching(rows, 週);
        const byDay = reaching(rows, 日);
        byWeek.forEach((row) => {
          expect(byDay.has(row), `${label}: "${週}" が "${日}" で当たらない行を拾った`).toBe(true);
        });
        byDay.forEach((row) => {
          expect(byWeek.has(row), `${label}: "${週}" を打つ人が "${日}" の行に会えない`).toBe(true);
        });
        当たった行 += byWeek.size;
      });
    });
    expect(当たった行, "当たりの行が無く空振り").toBeGreaterThan(30);
  });

  it("再来週・先々週は、来週・先週の次の塊に会う", () => {
    let 調べた行 = 0;
    corpora().forEach(({ label, rows }) => {
      const 週: Array<[string, number, number]> = [
        /* AT = 2026-08-09 は日曜 – 月曜始まりで 今週 8月3日〜9日、来週 10日〜16日、
         * 再来週 17日〜23日、先週 7月27日〜8月2日、先々週 7月20日〜26日（実測で確かめた）。 */
        ["再来週", 8, 14],
        ["先々週", -20, -14],
      ];
      週.forEach(([語, から, まで]) => {
        const 当たる = reaching(rows, String(語));
        rows.forEach((row) => {
          const 幅 = 距今の幅(row);
          const 範囲内 = 幅.some((d) => d >= から && d <= まで);
          if (!範囲内) return;
          調べた行 += 1;
          expect(当たる.has(row), `${label}: 「${語}」が ${から}〜${まで} 日後の行に会えない`).toBe(
            true,
          );
        });

        当たる.forEach((row) => {
          const 幅 = 距今の幅(row);
          expect(
            幅.length === 0 || 幅.some((d) => d >= から && d <= まで),
            `${label}: 「${語}」が範囲外の行を拾った`,
          ).toBe(true);
        });
      });
    });
    expect(調べた行, "範囲内の行が集まらず空振り").toBeGreaterThan(10);
  });

  it("週の塊は重ならない（来週と再来週は別の 7 日）", () => {
    const group = (語: string) =>
      (Recommender.queryTokenGroups(語, AT) as unknown as string[][])[0] || [];
    const 来週 = group("来週");
    const 再来週 = group("再来週");
    expect(来週.length, "来週が暦日に展開されていない").toBeGreaterThan(4);
    expect(再来週.length, "再来週が暦日に展開されていない").toBeGreaterThan(4);
    const 共有 = 再来週.filter((語) => 来週.indexOf(語) >= 0);
    expect(共有, `来週と再来週が同じ暦日を共有した: ${共有.join(",")}`).toEqual([]);
  });

  it("全角数字で打っても同じ行に会う", () => {
    corpora().forEach(({ label, rows }) => {
      [
        ["１週間以内", "7日以内"],
        ["３０ 日以内", "30日以内"],
        ["２週間後", "14日後"],
      ].forEach(([全角, 半角]) => {
        const a = reaching(rows, 全角);
        const b = reaching(rows, 半角);
        expect(a.size, `${label}: "${全角}" が "${半角}" と違う件数になった`).toBe(b.size);
        b.forEach((row) => {
          expect(a.has(row), `${label}: "${全角}" を打つ人が "${半角}" の行に会えない`).toBe(true);
        });
      });
    });
  });

  it("件数欄の案内が、寄せた日数と幅をその場で言う", () => {
    /* 週で打った人には 1 週 = 7 日の換算が見えないので、件数欄が「何を引き合いに出したのか」
     * を言う（第 318 回 – 「1か月以内」は換算を發明しないので案内も出さない）。 */
    const 注記 = (query: string) => Recommender.relativeDayNotes(query, AT);
    /* 幅の言い切りだけを見る（案内に続く注意文の契約は
     * `tests/within_days_scope_note.test.ts` が持つ – 第 319 回）。 */
    const 幅 = (query: string) => (注記(query)[0] || "").split(" – ")[0];
    expect(幅("1週間以内"), "週で打った人に寄せた日数と幅を言っていない").toBe(
      "7日以内 = 2026年8月9日(日)〜8月16日(日)",
    );
    expect(幅("2 週間以内"), "空格入りでも案内が出ない").toBe(
      "14日以内 = 2026年8月9日(日)〜8月23日(日)",
    );
    /* 年をまたぐ幅は年も書く（省略すると別の日に読める – 実測 2027年7月25日）。 */
    expect(幅("50週間以内"), "年をまたぐ幅で年を省略した").toBe(
      "350日以内 = 2026年8月9日(日)〜2027年7月25日(日)",
    );
    /* 案内が言った幅は、実際に検索で引いた暦日の語と一致する（噓を言う案内にしない）。 */
    const group = (Recommender.queryTokenGroups("1週間以内", AT) as unknown as string[][])[0] || [];
    ["2026年8月9日", "2026年8月16日"].forEach((語) => {
      expect(group.indexOf(語) >= 0, `案内が言った ${語} で引いていない`).toBe(true);
    });
    /* 月の単位は換算しないので案内も出さない（第 315 回の方針）。 */
    expect(注記("1か月以内"), "換算を發明した案内が出ている").toEqual([]);
  });

  it("上限（1 年）を超える週は展開しない", () => {
    /* 展開の上限は 365 日（第 315 回） – 週で打っても同じ上限を守る。 */
    const 三十八日後 = { hay: "学術会議 2026年9月16日 9月16日" };
    const 一年後 = { hay: "学術会議 2027年8月9日 8月9日" };
    const 述語 = (query: string) => Recommender.searchMatcher(query, AT);
    expect(述語("52週間以内")(三十八日後.hay), "52 週間（364 日）が展開されていない").toBe(true);
    expect(述語("53週間以内")(三十八日後.hay), "53 週間（371 日）が展開されている").toBe(false);
    expect(述語("53週間以内")(一年後.hay), "上限を超えた打ちが行を拾った").toBe(false);
  });
});
