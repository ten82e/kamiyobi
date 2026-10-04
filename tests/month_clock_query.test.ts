/**
 * 「20時」「午後8時59分」で引けることの検査（SPEC §4・§7・第 333 回）。
 * 実測（2026-09-28 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * 時刻を持つ 688 行はすべて 24 時間表記の `HH:MM`（`20:59` 516 行・`23:59` 507 行・`08:59` 88 行 –
 * 時の頭は 0 埋めで、1 桁の時は 0 行）。ところが日本語の打ち方 `20時` `午後8時` `20時59分` は
 * いずれも **0 行**だった – `20:59` は 516 行当たるので、収録に時刻が有って打ち方が違うだけ。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 行列表(語: string): Array<{ key?: string; hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{
    key?: string;
    hay: string;
  }>;
  const matches = Recommender.searchMatcher(語, 基準);
  return rows.filter((row) => matches(String(row.hay)) === true);
}

function 行集合(語: string): Set<string> {
  return new Set(行列表(語).map((row) => String(row.key ?? row.hay)));
}

function 差分(a: Set<string>, b: Set<string>): number {
  return [...a].filter((k) => !b.has(k)).length + [...b].filter((k) => !a.has(k)).length;
}

/** その 1 時間ぶんの和集合（`20時` と同じ意味の組を、展開に依らず素の照合で組み立てる）。 */
function 時の和集合(hour: number): Set<string> {
  const 時 = String(hour).padStart(2, "0");
  const out = new Set<string>();
  for (let m = 0; m <= 59; m += 1) {
    行集合(`${時}:${String(m).padStart(2, "0")}`).forEach((行) => {
      out.add(行);
    });
  }
  return out;
}

describe("時刻の打ち方", () => {
  it("「20時」は 20:00〜20:59 の締切に出て、本当にその時刻を含む行だけを出す", () => {
    const 受けた = 行集合("20時");
    expect(受けた.size, "『20時』が 0 行のまま（前提が崩れた）").toBeGreaterThan(0);
    expect(差分(受けた, 時の和集合(20)), "『20時』が 1 時間ぶんの和集合と違う行を出した").toBe(0);
    行列表("20時").forEach((row) => {
      expect(
        /(^|[^0-9])20:[0-5][0-9]/.test(String(row.hay)),
        "20 時の範囲の時刻を含まない行が出た",
      ).toBe(true);
    });
  });

  /* 一の桁の時は 0 埋めの形だけで当てる – 照合は部分一致なので素の `8:59` は `18:59` を含み、
   * 8 時で絞ったのに 18 時の行が混ざる（`1月` と `11月` の同じ穴 – 第 315 回）。
   * 検査ハーネスの品書（435 行）には 09 時の時刻が全く無いので（実測: `23:59` 181・`20:59` 163・
   * `08:59` 57・`15:59` 6・`12:59` 3・`01:00` 2・`12:00` 1・`10:00` 1）、`8時` を基準にする。
   * 実ビルドの品書（872 行）では 09 時も 12 行有る – 土俵を混ぜない（第 331 回の教訓）。 */
  it("一の桁の時は 0 埋めの形だけで当たる（18 時の行を混ぜない）", () => {
    const 八時 = 行集合("8時");
    expect(八時.size, "『8時』が 0 行のまま（前提が崩れた）").toBeGreaterThan(0);
    expect(差分(八時, 時の和集合(8)), "『8時』が 1 時間ぶんの和集合と違う行を出した").toBe(0);
    行列表("8時").forEach((row) => {
      const hay = String(row.hay);
      expect(/(^|[^0-9])08:[0-5][0-9]/.test(hay), "0 埋めの 8 時以外を引いた").toBe(true);
      expect(/(^|[^0-9])18:[0-5][0-9]/.test(hay), "18 時の行が混ざった").toBe(false);
    });
    /* 展開が 0 埋め以外の形を出さない事は、品の書に依存せず関数その物で確かめる。 */
    const 解 = Recommender.clockTimeTermsJa("8時") as unknown as { terms: string[] };
    expect(解.terms.length).toBe(60);
    expect(
      解.terms.filter((語) => /^08:[0-5][0-9]$/.test(語) === false).length,
      "0 埋め以外の形が混ざった",
    ).toBe(0);
  });

  it("分の指定はその 1 点だけを見る。午後の換算も同じ行に届く", () => {
    const 一分点 = 行集合("20時59分");
    expect(一分点.size).toBeGreaterThan(0);
    expect(差分(一分点, 行集合("20:59")), "『20時59分』が `20:59` と違う行を出した").toBe(0);
    expect(差分(行集合("午後8時59分"), 一分点), "『午後8時59分』が換算先と違う行を出した").toBe(0);
    expect(差分(行集合("午後8時"), 行集合("20時")), "『午後8時』が『20時』と違う行を出した").toBe(
      0,
    );
    expect(差分(行集合("20時台"), 行集合("20時")), "『20時台』が『20時』と違う行を出した").toBe(0);
    expect(差分(行集合("午後8時"), 時の和集合(20))).toBe(0);
  });

  it("件の数欄に解けた形・表記の決まり・タイムゾーンの話を書く", () => {
    const 幅 = Recommender.relativeDayNotes("20時", 基準);
    expect(幅.length).toBe(1);
    expect(幅[0]).toContain("20時 = 20:00〜20:59 の締切");
    expect(幅[0], "収録の表記の決まりを書いていない").toContain("24 時間表記");
    expect(幅[0], "0 埋めの話を省いた").toContain("0 埋め");
    expect(幅[0], "何時が混ざり得るかの注が無い").toContain("00 分〜59 分");
    expect(幅[0], "タイムゾーンの所在を書いていない").toContain("JST・UTC・AoE");
    /* 午後の換算は打った人に見えないので、解けた形をそのまま書く。 */
    expect(Recommender.relativeDayNotes("午後8時59分", 基準)[0]).toContain("= 20:59 の締切");
    expect(Recommender.relativeDayNotes("正午", 基準)[0]).toContain("12:00（正午）");
  });

  it("「20時59分までに」は絞り込まない（部分一致では作れない幅なので、確か欄を言う）", () => {
    expect(行集合("20時59分までに").size, "幅の頼み方を行で絞った").toBe(0);
    expect(行集合("20時までに").size).toBe(0);
    const 案内 = Recommender.relativeDayNotes("20時59分までに", 基準);
    expect(案内.length).toBe(1);
    expect(案内[0]).toContain("時刻までで絞り込む事は検索欄では出来ません");
    expect(案内[0], "確かでする欄の場所を教えない").toContain("『締切まで』");
    expect(案内[0]).toContain("20時59分");
  });

  it("読み違える形・範囲の外は受けない（締切の推測をしない）", () => {
    [
      ["午前12時", "正午にも 0 時にも読める"],
      ["25時", "24 時を超える"],
      ["90時", "時の形をしていない"],
      ["20時60分", "分の範囲の外"],
      ["13月時", "時の語ではない"],
    ].forEach(([語, 理由]) => {
      expect(行集合(語).size, `"${語}" を受けてしまった（${理由}）`).toBe(0);
      expect(Recommender.relativeDayNotes(語, 基準).join(""), `"${語}" の案内を立てた`).toBe("");
    });
  });

  it("収録に無い時刻は 0 件のまま、解けた形だけを案内する（絞り込みを広げない）", () => {
    const 案内 = Recommender.relativeDayNotes("8時半", 基準);
    expect(案内[0], "解けた形を書いていない").toContain("= 08:30 の締切");
    行列表("8時半").forEach((row) => {
      expect(/(^|[^0-9])08:30/.test(String(row.hay)), "8 時半以外を引いた").toBe(true);
    });
  });

  it("他の語を足せば絞り込みになる", () => {
    const 時刻 = 行集合("20時");
    const 絞った = 行集合("セキュリティ 20時");
    expect(絞った.size).toBeGreaterThan(0);
    expect(時刻.size).toBeGreaterThan(絞った.size);
    expect([...絞った].filter((行) => !時刻.has(行)).length, "足した語で行が増えた").toBe(0);
  });

  it("組み立てた画面に形と関数が残っている（ハーネスは名指し – 第 329 回）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    ["CLOCK_JA", "clockTimeTermsJa", "clockUntilQueryJa", "正午"].forEach((断片) => {
      expect(rec.includes(断片), `組み立てた画面から ${断片} が消えた`).toBe(true);
    });
  });
});
