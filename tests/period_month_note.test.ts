/**
 * 「今月末」「年内」など**月のまとまりの語**の検査（SPEC §4・§7・第 327 回）。
 * 実測（2026-09-26 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `今月` 189 行 / `今月末` **0 行**、`来月` 240 行 / `来月末` **0 行**、`年内` **0 行**、
 * `年度末` **0 行**、`年末` **0 行**、`年明け` **0 行**で、件数欄の解決も出ていなかった。
 * 研究計画の立て方で必ず出る言い方なので、暦月語のグループへ展開し、件数欄で展開先を出す。
 * 逆に、意味が一通に決まらない語（`月初` `週明け` `土日` `祝日` `上半期` `ゴールデンウィーク`）は
 * 寄せない – 締切の推測はしない（AGENTS.md）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

/** 打った語 → 展開先の暦月語（表に出る形）。 */
const 展開: Array<[string, string[]]> = [
  ["今月末", ["2026年8月"]],
  ["月末", ["2026年8月"]],
  ["この月末", ["2026年8月"]],
  ["今月終わり", ["2026年8月"]],
  ["来月末", ["2026年9月"]],
  ["再来月末", ["2026年10月"]],
  ["年内", ["2026年8月", "2026年9月", "2026年10月", "2026年11月", "2026年12月"]],
  ["年度末", ["2027年3月"]],
  ["年末", ["2026年12月"]],
  ["年初", ["2027年1月"]],
  ["年明け", ["2027年1月"]],
  ["年度初め", ["2027年4月"]],
];

/** 一通に決まらないので寄せない語（実測で 0 行のまま残る – 画面は勝手に絞らない）。 */
const 寄せない = [
  "月初",
  "週明け",
  "土日",
  "祝日",
  "上半期",
  "下期",
  "第1四半期",
  "ゴールデンウィーク",
  "お盆",
  "夏休み",
  "3月中",
  "3月以内",
];

describe("月のまとまりの語", () => {
  it("暦月語のグループに展開される（表の語に当たる形）", () => {
    展開.forEach(([語, 期待]) => {
      expect(Recommender.periodMonthTermsJa(語, 基準), `"${語}" が展開されない`).toEqual(期待);
    });
  });

  it("収録の行が実際に増える（実データ – 収録 3,250 行）", () => {
    const 収録 = Recommender.candidateRows(
      JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as never,
    ) as Array<{ hay: string }>;
    const 当たり = (語: string) => {
      const matcher = Recommender.searchMatcher(語, 基準);
      return 収録.filter((row) => matcher(String(row.hay)) === true).length;
    };
    // 直前は全部 0 行だった（実測）。
    expect(当たり("今月末"), "今月末が行に戻らない").toBeGreaterThanOrEqual(150);
    expect(当たり("来月末"), "来月末が行に戻らない").toBeGreaterThanOrEqual(150);
    expect(当たり("年内"), "年内が行に戻らない").toBeGreaterThanOrEqual(600);
    expect(当たり("年度末"), "年度末が行に戻らない").toBeGreaterThanOrEqual(30);
    // 他の語と組んでも効く（「年内 セキュリティ」のような打ち方）。
    expect(当たり("年内 セキュリティ"), "他の語と組むと壊れる").toBeGreaterThanOrEqual(30);
  });

  it("件数欄は展開先と末日を出す（`月末` で気にしているのは日付の方）", () => {
    const 文 = (語: string) => Recommender.periodMonthPairs(語, 基準);
    expect(文("今月末")).toEqual([["今月末", "2026年8月の締切（末日は 2026年8月31日(月)）"]]);
    expect(文("来月末")[0][1]).toContain("末日は 2026年9月30日(水)");
    /* 年内は範囲で出す – 過ぎた月は出さない（今月が始まり）。 */
    expect(文("年内")).toEqual([["年内", "2026年8月から2026年12月の締切"]]);
    expect(Recommender.periodMonthTermsJa("年内", Date.parse("2026-11-20T00:00:00Z"))).toEqual([
      "2026年11月",
      "2026年12月",
    ]);
  });

  it("意味が一通に決まらない語は寄せない（締切の推測をしない）", () => {
    寄せない.forEach((語) => {
      expect(Recommender.periodMonthTermsJa(語, 基準), `"${語}" を勝手に解釈した`).toEqual([]);
      expect(Recommender.periodMonthPairs(語, 基準), `"${語}" の件数欄を立てた`).toEqual([]);
    });
  });

  it("年の語 `昨年` は `去年` と同じ年に解決される（表の欠けの実測）", () => {
    const 語 = (q: string) => Recommender.relativeDayNotes(q, 基準).join("");
    expect(語("昨年")).toContain("2025年");
    expect(語("去年")).toContain("2025年");
    expect(Recommender.queryTokenGroups("昨年", 基準)[0].slice(0, 2)).toEqual([
      "昨年",
      "2025年1月",
    ]);
  });

  it("成果物が展開と件数欄の wiring を失っていない", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const app = readFileSync(join(builtSite(), "app.js"), "utf8");
    ["PERIOD_MONTH_WORDS_JA", "function periodMonthTermsJa", "function periodMonthPairs"].forEach(
      (断片) => {
        expect(rec.includes(断片), `組み立てた画面から ${断片} が消えた`).toBe(true);
      },
    );
    expect(app.includes("periodMonthPairs"), "件数欄の wiring が消えた").toBe(true);
  });
});
