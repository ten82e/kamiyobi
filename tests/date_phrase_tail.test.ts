/**
 * 日付の語に**助詞や「まで」が付きただけ**の形の検査（SPEC §4・§7・第 328 回）。
 * 実測（2026-09-27 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `明日中` は通るのに `明日中に` **0 行**、`今週中` 19 行 / `今週中に` **0 行**、
 * `来週中` 53 行 / `来週中に` **0 行**、`年内` 772 行 / `年内に` **0 行**、
 * `明日` 4 行 / `明日まで` **0 行**・`来週までに` **0 行**・`今月までに` **0 行**・
 * `今日から3日` **0 行**（`3日以内` は 17 行で同じ行集合）。
 * 逆に、意味が一通に決まらない形（`明日ランス` `3月以内`）は寄せない –
 * （`来年中` は第 328 回では此処に置いていたが、第 330 回で「来年の中」という一通の
 *  読みで解いた – 実測 452 行で、件数欄も同じ年の語と一致した）。
 * 画面が勝手に期間を作らない（締切の推測はしない – AGENTS.md）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

type 品書行 = { key?: string; hay: string };

/** 品書（`catalog.json`）で、その語が落とした行の集合。 */
function 行集合(語: string): Set<string> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as 品書行[];
  const matches = Recommender.searchMatcher(語, 基準);
  return new Set(
    rows
      .filter((row) => matches(String(row.hay)) === true)
      .map((row) => String(row.key ?? row.hay)),
  );
}

describe("日付の語に付きだけの助詞・期日", () => {
  it("助詞を足しただけの形は、名詞形とまったく同じ行を出す（品書）", () => {
    [
      ["明日中に", "明日中"],
      ["今週中に", "今週中"],
      ["来週中に", "来週中"],
      ["来月中に", "来月中"],
      ["年内に", "年内"],
      ["年内で", "年内"],
      ["今月末に", "今月末"],
      ["今月以内に", "今月"],
      ["来月までに", "来月"],
    ].forEach(([言い方, 名詞形]) => {
      const 足した = 行集合(言い方);
      const 素 = 行集合(名詞形);
      expect(
        足した.size,
        `"${名詞形}" が 0 行の前提が崩れた（比較の基準にできない）`,
      ).toBeGreaterThan(0);
      const 差分 =
        [...足した].filter((k) => !素.has(k)).length + [...素].filter((k) => !足した.has(k)).length;
      expect(差分, `"${言い方}" と "${名詞形}" で違う行が出た`).toBe(0);
    });
  });

  it("`まで` `までに` は今日からその日まで（期日で聞く人なので幅で受ける）", () => {
    const 語の組 = (q: string) => Recommender.queryTokenGroups(q, 基準)[0] || [];
    const 明日まで = 語の組("明日まで");
    expect(明日まで).toContain("2026年8月9日");
    expect(明日まで).toContain("2026年8月10日");
    expect(明日まで, "期日より先まで出した").not.toContain("2026年8月11日");
    expect(語の組("今日までに")).toContain("2026年8月9日");
    expect(語の組("今日までに"), "今日より前を足した").not.toContain("2026年8月8日");
    const 来週までに = 語の組("来週までに");
    expect(来週までに).toContain("2026年8月16日");
    expect(来週までに, "来週までなのに翌週まで出した").not.toContain("2026年8月17日");
  });

  it("`今日から N 日` は `N 日以内` と同じ行集合（品書）", () => {
    [
      ["今日から3日", "3日以内"],
      ["今日から3日間", "3日以内"],
      ["今日から1週間", "1週間以内"],
    ].forEach(([言い方, 言い換え]) => {
      const a = 行集合(言い方);
      const b = 行集合(言い換え);
      expect(b.size, `"${言い換え}" が 0 行の前提が崩れた`).toBeGreaterThan(0);
      const 差分 = [...a].filter((k) => !b.has(k)).length + [...b].filter((k) => !a.has(k)).length;
      expect(差分, `"${言い方}" と "${言い換え}" で違う行が出た`).toBe(0);
    });
  });

  it("`以降` も `から` も其の初日から絞る（第 475 回・第 476 回）", () => {
    /* 第 328 回は「其れより後」を一日ぶんに寄せると嘘になるので絞り込まない決まりにしたが、
     * そのままだと 0 行なのに案内だけが「並びます」と並ぶ事を書き、画面がそれ果たさなかつた
     * （実測 2026-11-08）。第 475 回で `以降` は暦日を打つ形（第 413 回）と同じ – 其の日から
     * 其の年の中まで – で絞るやうにした。第 476 回で `から` も同じ幅に解いた（其れでも幅の
     * 終りが消えぬやう、後に其它の日の語が控へる形は三語を一語に継ぐ）。 */
    for (const 語 of ["明日以降", "来週以降", "明日から", "来週から"]) {
      expect(行集合(語).size, `"${語}" が其の初日から絞れて居ない`).toBe(423);
      expect(Recommender.relativeDayNotes(語, 基準), `"${語}" に案内が残つた`).toEqual([]);
    }
    /* 幅で絞れる形なので案内は出ない – 其の日の読み方は dayRangePairs 側で張る（別の検査）。*/
    expect(行集合("来週から").size).toBe(423);
  });

  it("件数欄の文が幅と曜日を言う（`今日まで` の一日ぶンは「〜」を書かない）", () => {
    const 明日まで = Recommender.relativeDayNotes("明日まで", 基準).join("");
    expect(明日まで).toContain("2026年8月9日(日)〜8月10日(月)");
    expect(明日まで).toContain("締切まで");
    const 今日まで = Recommender.relativeDayNotes("今日までに", 基準).join("");
    expect(今日まで).toContain("2026年8月9日(日)の締切");
    expect(今日まで, "一日ぶんに幅の書き方を出した").not.toContain("〜");
    /* 助詞を剥がした形も、案内は打たれた語のまま出す。 */
    expect(Recommender.relativeDayNotes("明日中に", 基準).join("")).toContain("明日中に = ");
  });

  it("意味が一通に決まらない形は寄せない（締切の推測をしない）", () => {
    ["明日ランス", "3月以内", "今週あたり", "明日ほう", "明日な", "来年らしさ"].forEach((語) => {
      expect(Recommender.queryTokenGroups(語, 基準), `"${語}" を勝手に解釈した`).toEqual([[語]]);
      expect(Recommender.relativeDayNotes(語, 基準).join(""), `"${語}" の案内を立てた`).toBe("");
      expect(Recommender.periodMonthPairs(語, 基準), `"${語}" の件数欄を立てた`).toEqual([]);
      /* 助詞の表を緩めて日付の語に無い形まで寄せると、此処で壊れる（第 328 回）。 */
      expect(行集合(語).size, `"${語}" が行を絞った`).toBe(0);
    });
  });

  it("成果物と注入一覧が新しい部品を失っていない（ハーネスは 2 箇所有り – 第 327 回）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    [
      "DATE_TOKEN_TAILS_JA",
      "function dateTokenStemJa",
      "function untilDayTermsJa",
      "function fromTodayTermsJa",
    ].forEach((断片) => {
      expect(rec.includes(断片), `組み立てた画面から ${断片} が消えた`).toBe(true);
    });
    /* 組み立てた画面を eval で動かす検査は、読む部品を名指しで注入する一覧を持つ
     * （検索の入口 `tests/built_golden_shared.ts` – 第 326 回・第 327 回で実発生）。
     * 新しい語の表を足したら、其れを読む関数ごと一覧に足していないと `not defined` になる。 */
    const 一覧 = readFileSync(join(REPO_ROOT, "tests", "built_golden_shared.ts"), "utf8");
    ["dateTokenStemJa", "untilDayTermsJa", "fromTodayTermsJa", "isDateTableWordJa"].forEach(
      (名前) => {
        expect(一覧.includes(名前), `検索の入口の一覧に ${名前} の注入が無い`).toBe(true);
      },
    );
    ["DATE_TOKEN_TAILS_JA", "FROM_TODAY_UNIT", "FROM_TODAY_HEAD", "RELATIVE_MONTH_WITHIN"].forEach(
      (名前) => {
        expect(一覧.includes(名前), `検索の入口の一覧に ${名前} の表の注入が無い`).toBe(true);
      },
    );
  });
});
