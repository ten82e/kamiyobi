/**
 * 月の初め・週の明け・期という柔らかい打ち方の検査。SPEC §4・§7・第 355 回。
 * 実測（2026-10-13 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `月初` `月初め` `月頭` `今月頭` `来月頭` `再来月頭` `月中` `週明け` `来週明け` `上半期` `下半期`
 * `上期` `下期` `半期` `期初` `期末` `四半期` `第1四半期` … はいずれも **0 行で案内も無し**で、
 * 其れに対して `1日` 133 行・`5日` 69 行・`上旬` 35 行・`9月` 253 行・`来月` 240 行・`月曜` 100 行・
 * `来週` 53 行・`年度初め` 81 行・`年度末` 80 行が通っていた。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 行列表(語: string): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
  const matches = Recommender.searchMatcher(語, 基準);
  return rows.filter((row) => matches(String(row.hay)) === true);
}

const 柔らかい打ち方: string[] = [
  "月初",
  "月初め",
  "月頭",
  "今月頭",
  "来月頭",
  "再来月頭",
  "月中",
  "月初締切",
  "来月頭締切",
  "月初頃",
  "月初め頃",
  "月頭頃",
  "週明け",
  "来週明け",
  "今週明け",
  "週明け締切",
  "上半期",
  "下半期",
  "上期",
  "下期",
  "半期",
  "期初",
  "期末",
  "四半期",
  "第1四半期",
  "第2四半期",
  "第3四半期",
  "第4四半期",
  "上半期締切",
  "四半期締切",
  /* 語を並べて打たれた形（第 354 回の `multiword` – 此の三群にも立てている）。 */
  "月初 オンライン",
  "上期 機械学習",
  "週明け セキュリティ",
];

describe("柔らかい範囲の語", () => {
  it("0 行の侭、寄せない理由と其の方の打ち方を其の場に書く", () => {
    for (const 語 of 柔らかい打ち方) {
      expect(行列表(語).length, `${語} に行が出てしまった（勝手に寄せた）`).toBe(0);
      const 案内 = Recommender.uiWordNoteJa(語);
      /* 語を並べて打たれた形は、其の方の語を名指す（第 354 回 – `月初 オンライン` → 「『月初』…」）。 */
      const 名指す語 = 語.split(/[\s、]+/)[0];
      expect(案内, `${語} の案内が出ていない（黙った侭 0 件）`).toContain(`「${名指す語}」`);
      /* 無いと言うだけで止まらない – 其の方の打ち方を名指す（第 337 回の決まり）。 */
      expect(案内, `${語} が其の方の打ち方を書いていない`).toMatch(
        /『(1日|月曜|上旬|9月|来週|年度初め)』/,
      );
      const 読み上げ = Recommender.uiWordLiveNoteJa(語);
      expect(読み上げ, `${語} の読み上げが出ていない`).toContain(`「${名指す語}」`);
      /* 理由の文も張る（「公用の決まりが有る」に書き換える改ざん – 噓の案内 – を落とす）。 */
      expect(
        案内 + 読み上げ,
        `${語} の案内が理由を書いていない（噓に書き換えられた可能性）`,
      ).toMatch(
        /公用の決まりが無い|一通に決まらない|持っていません|区分はありません|寄せられません/,
      );
      expect(読み上げ.length, `${語} の読み上げが短い（探し方を置いていない）`).toBeGreaterThan(
        案内.length > 0 ? 10 : 0,
      );
    }
  });

  it("文の中身は打ち方に依らない（打っていない語を名指さない – 第 344 回）", () => {
    /* 『月初』で打っても『月頭頃』で打っても、其の語の後に付く文は同じで、其処に別の語が
     * 出ない（其れは案内が寄せた事にする文に読める）。 */
    const 月初 = Recommender.uiWordNoteJa("月初").replace("「月初」", "");
    const 月頭頃 = Recommender.uiWordNoteJa("月頭頃").replace("「月頭頃」", "");
    expect(月頭頃, "打ち方で文の本体が変わった").toBe(月初);
    expect(月初.includes("『月初』"), "文の中で別の打ち方を名指している").toBe(false);
    expect(Recommender.uiWordNoteJa("来週明け").replace("「来週明け」", "")).toBe(
      Recommender.uiWordNoteJa("週明け").replace("「週明け」", ""),
    );
  });

  it("群ごとに、導す語を省略していない（其の方の打ち方を一つも教えない案内にしない）", () => {
    expect(Recommender.uiWordNoteJa("月初")).toContain("『上旬』");
    expect(Recommender.uiWordNoteJa("月初")).toContain("『1日』");
    expect(Recommender.uiWordNoteJa("月初")).toContain("『来月』");
    expect(Recommender.uiWordNoteJa("週明け")).toContain("『月曜』");
    expect(Recommender.uiWordNoteJa("週明け")).toContain("『来週』");
    expect(Recommender.uiWordNoteJa("上半期")).toContain("『年度初め』");
    expect(Recommender.uiWordLiveNoteJa("月初")).toContain("『上旬』");
  });

  it("案内が導す語は実際に行を出す（空振りする打ち方を教えない）", () => {
    for (const 語 of [
      "1日",
      "5日",
      "上旬",
      "9月",
      "来月",
      "月曜",
      "金曜",
      "今週",
      "来週",
      "年度初め",
      "年度末",
    ]) {
      expect(行列表(語).length, `案内が名指す \`${語}\` が 0 行`).toBeGreaterThan(0);
    }
  });

  it("月を空格で並べると狭くなるという案内の但し書きは本当", () => {
    /* 其の方の品書（検査のビルド – 実品書 872 行ではなく 435 行・2026-08-09 固定時刻）で、
     * 二つの月をまたぐ行を持つ組を選ぶ。実品書では `4月 5月` が 4 行（`4月` 81 行）だが、
     * 其の方では 0 行だったので、組を洗ってから関係を張る（絶対値を張らない – 第 344 回）。 */
    const 月々: Array<[string, string]> = [
      ["4月", "5月"],
      ["8月", "9月"],
      ["3月", "4月"],
      ["9月", "10月"],
      ["1月", "2月"],
      ["5月", "6月"],
      ["10月", "11月"],
    ];
    const 組 = 月々.find(([前, 後]) => 行列表(`${前} ${後}`).length > 0);
    expect(
      組,
      "二つの月を含む行が品書に無い – 但し書きを実測できない（品書を変える）",
    ).toBeTruthy();
    const [前, 後] = 組 as [string, string];
    const 四月 = new Set(行列表(前).map((r) => r.hay));
    const 並べた = 行列表(`${前} ${後}`);
    expect(四月.size, `対照の ${前} が 0 行`).toBeGreaterThan(0);
    expect(
      並べた.filter((r) => !四月.has(r.hay)).length,
      "並べた方に行が増えた（両方を含む行だけではない）",
    ).toBe(0);
    expect(並べた.length, "並べた方が狭くない").toBeLessThan(四月.size);
    const 案内 = Recommender.uiWordNoteJa("上半期");
    expect(案内, "但し書きが消えた（並べれば多く出ると誤解させる）").toContain(
      "両方を含む行だけになる",
    );
    /* 読み上げにも同じ但し書きの趣旨（暦月で夫々打つ）が在る。 */
    expect(Recommender.uiWordLiveNoteJa("上半期")).toContain("暦月");
  });
});

describe("壊していない物", () => {
  it("一通に決まる語の展开と案内は其侭（寄せない決まりを壊さない）", () => {
    /* 寄せ表に足す改ざん（月初を暦月へ寄せる等）は此れで落ちる。 */
    for (const 語 of [
      "月初",
      "週明け",
      "上半期",
      "下期",
      "第1四半期",
      "ゴールデンウィーク",
      "祝日",
    ]) {
      expect(Recommender.periodMonthTermsJa(語, 基準), `${語} を展開してしまった`).toEqual([]);
    }
    /* `上旬` `中旬` `下旬` は暦月の表（PERIOD_MONTH_WORDS_JA）ではなく幅の展开（第 349 回）で
     * 通る。其の表で 上旬 を要求するのは別の規則の検査になる（実測で空 – 検査を書いた側の間違い
     * として其の場で直した）。 */
    expect(Recommender.relativeDayNotes("上旬", 基準).join(" ")).toContain("2026年8月1日");
    expect(Recommender.relativeDayNotes("8月上旬", 基準).join(" ")).toContain("2026年8月1日");
    expect(Recommender.uiWordNoteJa("祝日")).toContain("祝日・休日");
    expect(Recommender.uiWordNoteJa("祝日 締切")).toContain("「祝日」");
    expect(Recommender.querySynonymNotes("8月まで").join(" ")).toContain("「8月」");
    expect(行列表("土日").length, "案内が導く `土日` が 0 行").toBeGreaterThan(0);
    expect(行列表("上旬").length, "`上旬` が 0 行に落ちた").toBeGreaterThan(0);
  });
});

describe("成果物", () => {
  it("三つの群が読み上げの文ごと成果物に在る", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const 断片 of [
      "月初の決まりは無いので",
      "週明けの意味は一通に決まらないので",
      "という区分はありません – 締切は暦月で出るので",
    ]) {
      expect(rec.split(断片).length - 1, `成果物から案内が消えた: ${断片}`).toBe(1);
    }
  });
});
