/**
 * 「7 日以内」のように打った人の検査（SPEC §4・§7・第 315 回）。
 * 画面には同じ文言の絞り込み（`7 日以内` `30 日以内` `90 日以内` `180 日以内`）が有るのに、
 * 検索欄に打つと 0 行だった（2026-09-25 実測・2026-08-09 生成の実ビルドの品書 872 行 –
 * 実際に 30 日以内に締切を持つ行は 210 行ある）。検査はビルド済み品の行と、
 * 画面の select のラベル（`site/template.html` から取る – 画面の語をテスト側に写すと
 * 画面だけが変わって黙る。第 313 回と同じ工夫）の両方で行う。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string; t?: number };

const AT = Date.parse("2026-08-09T00:00:00Z");

function rows(): Row[] {
  const catalog = JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8"));
  return Recommender.candidateRows(catalog) as Row[];
}

function reaching(rs: Row[], query: string): Set<Row> {
  const match = Recommender.searchMatcher(query, AT);
  return new Set(rs.filter((row) => match(row.hay) === true));
}

/** 画面の絞り込み（締切の近さ）のラベルを `site/template.html` から拾う。 */
function filterLabels(): string[] {
  const html = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  return [...html.matchAll(/option value="[0-9]+d">([^<]+)</g)].map((m) => m[1].trim());
}

/** 今日から N 日後までの暦日の語（展開が載せる形）。 */
function dayWords(days: number): string[] {
  const out: string[] = [];
  for (let d = 0; d <= days; d++) {
    const date = new Date(AT + d * 86_400_000);
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    out.push(`${date.getUTCFullYear()}年${month}月${day}日`, `${month}月${day}日`);
  }
  return out;
}

function writesAny(row: Row, words: string[]): boolean {
  const text = String(row.hay);
  return words.some((word) => text.includes(word));
}

describe("「N 日以内」と打った人", () => {
  it("画面の絞り込みと同じ文言で、同じ行に会える", () => {
    const labels = filterLabels();
    /* 画面に 4 通りの選択肢が有ること（減ったら検査が空振りになる） */
    expect(labels.length).toBeGreaterThanOrEqual(4);
    const rs = rows();
    let 当たった行数 = 0;
    labels.forEach((label) => {
      const 離し = reaching(rs, label);
      const 詰め = reaching(rs, label.replace(/ /g, ""));
      /* 離し・詰めどちらで打っても同じ行が出る */
      expect(詰め.size, `「${label}」を詰めて打つと行数が変わる`).toBe(離し.size);
      離し.forEach((row) => {
        expect(詰め.has(row), `「${label}」の詰め打ちで行が落ちる`).toBe(true);
      });
      expect(離し.size, `「${label}」が 0 行`).toBeGreaterThan(0);
      当たった行数 += 離し.size;
    });
    expect(当たった行数).toBeGreaterThan(100);
  });

  it("範囲は日に従って広がり、その日に当たる語より狭くならない", () => {
    const rs = rows();
    const 序 = [7, 30, 90, 180, 365];
    let 前 = 0;
    序.forEach((days) => {
      const now = reaching(rs, `${days}日以内`);
      expect(now.size, `${days}日以内 が ${前}行 以下に縮んだ`).toBeGreaterThanOrEqual(前);
      前 = now.size;
      /* 「N 日後」が当たる行（其の暦日を書く行）は「N 日以内」にも入る */
      reaching(rs, `${days}日後`).forEach((row) => {
        expect(now.has(row), `${days}日後 の行が ${days}日以内 から落ちている`).toBe(true);
      });
    });
    expect(前, "範囲の広がりが見えず空振り").toBeGreaterThan(100);
  });

  it("当たった行は、範囲内の暦日を行の文字列に持つ", () => {
    const rs = rows();
    [7, 30].forEach((days) => {
      const words = dayWords(days);
      reaching(rs, `${days}日以内`).forEach((row) => {
        expect(
          writesAny(row, words),
          `${days}日以内 が範囲外の暦日だけの行を拾っている: ${String(row.hay).slice(0, 60)}`,
        ).toBe(true);
      });
    });
    /* 逆に、範囲内の暦日を書く行は必ず当たる（取りこぼしがないこと） */
    const words = dayWords(30);
    const 範囲内の行 = rs.filter((row) => writesAny(row, words));
    範囲内の行.forEach((row) => {
      expect(reaching(rs, "30日以内").has(row), "範囲内の暦日を書く行が落ちている").toBe(true);
    });
    expect(範囲内の行.length, "品書に範囲内の暦日が無く空振り").toBeGreaterThan(50);
  });

  it("週・月の単位と上限を超えた打ちは展開しない（対象外を実測で決めた）", () => {
    /* AT = 2026-08-09 なので、8月16日 は 7 日後、9月8日 は 30 日後、7月10日 は 30 日前 */
    const 近い = { hay: "学術会議 2026年8月16日 8月16日" };
    const 遠い = { hay: "学術会議 2026年9月8日 9月8日" };
    const 過去 = { hay: "学術会議 2026年7月10日 7月10日" };
    const 述語 = (query: string) => Recommender.searchMatcher(query, AT);
    expect(述語("7日以内")(近い.hay)).toBe(true);
    expect(述語("30日以内")(遠い.hay)).toBe(true);
    /* 週・月への換算は画面のどこにも書いていないので發明しない */
    expect(述語("1週間以内")(近い.hay), "「1週間以内」が展開されている").toBe(false);
    expect(述語("1か月以内")(遠い.hay), "「1か月以内」が展開されている").toBe(false);
    /* 上限（1 年）を超えた打ちも展開しない */
    expect(述語("366日以内")(遠い.hay), "上限を超えた打ちが展開されている").toBe(false);
    /* 範囲は未来方向だけ – 「N 日前」の行を巻き込まない */
    expect(述語("30日前")(過去.hay)).toBe(true);
    expect(述語("30日以内")(過去.hay), "「30日以内」が過去の行を拾っている").toBe(false);
  });
});
