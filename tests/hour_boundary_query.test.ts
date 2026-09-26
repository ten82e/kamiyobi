/**
 * 「17時以降」を打つ人だけ黙つて居た – 時刻は 1 時間帯と午前後の帯しか解かなかつた（第 436 回）。
 *
 * 実測（2026-10-24 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `17時` 2 行・`午後` は 12:00〜23:59 の帯に解けるのに、`17時以降` `17時前` `17時までに`
 * `午後以降` は 0 行で案内も無し。其の方の語に続けた時間帯の名前（`夕方以降` `夜中`
 * `今夜` `昼過ぎ` `終業時間後`）も案内も無しだつた。
 *
 * 直し –
 * - 時の境界を解く: `N時以降` は N:00〜23:59、`N時前` `N時までに` は 00:00〜(N-1):59、
 *   `午後以降` は午後の帯と同じ。品書の時刻は時の頭が必ず 0 埋め（第 418 回の実測理由）
 *   なので `HH:` の語だけで表せる – 幅の勝手な創作ではなく時の区切り其の物。
 * - 時間帯の名前の語群（第 418 回）に語（夜中・今夜・昼過ぎ・早朝・終業時間・終業・
 *   退勤・勤務終了）と続き方（以降・前に・までに・過ぎ・後・後に）を通す – 断りの文は
 *   その侭（公用の決まりが無いのは続き方でも同じ）。
 * - 分を打たれた境界（`17時30分以降`）は接頭では割れぬ為この限り（解かない・其の方の
 *   案内の侭 – 締切の推測はしない）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 列表入口() {
  const 品 = (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
  const 済 = new Map<string, Set<string>>();
  return (語: string): Set<string> => {
    if (!済.has(語)) {
      const 当 = Recommender.searchMatcher(語, 基準);
      済.set(語, new Set(品.filter((行) => 当(行) === true)));
    }
    return 済.get(語) as Set<string>;
  };
}

const 列 = 列表入口();

function 包含(a: Set<string>, b: Set<string>): boolean {
  for (const x of b) if (!a.has(x)) return false;
  return true;
}

describe("時刻の境界が解ける（第 436 回）", () => {
  it("以降は其の時から 23:59 まで・前とまでは其の時の前まで", () => {
    expect(列("17時以降").size).toBeGreaterThan(0);
    expect(
      Recommender.relativeDayNotes("17時以降", 基準).join(" ") + 列("17時以降").size,
    ).toContain("");
    for (const 語 of ["17時以降", "13時以降", "17時前", "17時前に", "午後以降"]) {
      expect(列(語).size, 語).toBeGreaterThan(0);
    }
  });
  it("帯の包含が時間の順に従う – 23時以降 ⊆ 17時以降 ⊆ 13時以降", () => {
    expect(包含(列("13時以降"), 列("17時以降"))).toBe(true);
    expect(包含(列("17時以降"), 列("23時以降"))).toBe(true);
    expect(包含(列("午後以降"), 列("13時以降"))).toBe(true);
  });
  it("前と以降は重ならない・までは第 333 回の断りの侭（含むか決まれない）", () => {
    for (const x of 列("17時前")) expect(列("17時以降").has(x)).toBe(false);
    /* ハーネスの品書に 17 時の行が無い為、行の在る 23 時で確かめる – ただし一行に
     * JST・UTC の二つの時刻が載る行が在るので行同士の重なり其の物は不可ではない。
     * 23 時より前の時刻を一切持たない行が 23時前 に入ってはならない（前が其の時の
     * 語を吞んだ改ざんを此れで捉える）。*/
    let 単一 = 0;
    for (const x of 列("23時以降")) {
      const 時々 = [...x.matchAll(/\b([0-9]{2}):[0-9]{2}\b/g)].map((m) => Number(m[1]));
      if (時々.length > 0 && 時々.every((h) => h >= 23)) {
        単一 += 1;
        expect(列("23時前").has(x), x.slice(0, 40)).toBe(false);
      }
    }
    expect(単一).toBeGreaterThan(0);
    expect(列("17時までに").size).toBe(0);
    expect(Recommender.relativeDayNotes("17時までに", 基準).join("")).toContain(
      "時刻までで絞り込む事は",
    );
  });
  it("日と繋げると両方で絞れる（15日の17時以降 ⊆ 15日）", () => {
    expect(列("15日の17時以降").size).toBeGreaterThan(0);
    expect(包含(列("15日"), 列("15日の17時以降"))).toBe(true);
  });
  it("案内が実物に付く・其の時の含み方が解けた形に現れる", () => {
    const n = Recommender.relativeDayNotes("17時以降", 基準).join(" ");
    expect(n).toContain("17:00〜23:59");
    const m = Recommender.relativeDayNotes("17時前", 基準).join(" ");
    expect(m).toContain("00:00〜16:59");
    /* 行の少ない品書でも含み方が壊れない事を解けた形側で見る – 以降は其の時から、
     * 前・までは其の時の前まで（`まで` を其の時を含む幅に化かさない – 第 333 回）。*/
    const 三 = Recommender.relativeDayNotes("23時以降", 基準).join(" ");
    expect(三).toContain("23:00〜23:59");
    const 一 = Recommender.relativeDayNotes("1時前", 基準).join(" ");
    expect(一).toContain("00:00〜00:59");
  });
});

describe("時間帯の名前+続き方は其の場で断る（第 436 回）", () => {
  for (const 語 of [
    "夕方以降",
    "夕方までに",
    "夜中",
    "今夜",
    "昼過ぎ",
    "終業時間後",
    "終業後",
    "夜以降",
    "朝過ぎ",
    "深夜までに",
  ]) {
    it(`『${語}』は 0 行の侭、打たれた表記で時間帯の案内が出る`, () => {
      expect(列(語).size, 語).toBe(0);
      const n = Recommender.uiWordNoteJa(語);
      expect(n, 語).toContain(`「${語}」`);
      expect(n, 語).toContain("時間帯の名前");
    });
  }
  it("分入りの境界も解ける – 分の頭も 0 埋めなので列挙は正確（第 437 回）", () => {
    const n = Recommender.relativeDayNotes("17時30分以降", 基準).join(" ");
    expect(n).toContain("17:30〜23:59");
    const m = Recommender.relativeDayNotes("17時30分前", 基準).join(" ");
    expect(m).toContain("00:00〜17:29");
    expect(Recommender.relativeDayNotes("23時59分以降", 基準).join(" ")).toContain("23:59〜23:59");
    expect(Recommender.relativeDayNotes("0時30分前", 基準).join(" ")).toContain("00:00〜00:29");
    /* 其の時を始点に含む – 17時30分以降 は 17時以降 の部分集合で、17時前 は
     * 17時30分前 の部分集合（狭い方が広い方に吞まれる）。*/
    expect(包含(列("17時以降"), 列("17時30分以降"))).toBe(true);
    expect(包含(列("17時30分前"), 列("17時前"))).toBe(true);
    expect(列("17時30分以降").size).toBeGreaterThan(0);
  });
  it("算用 0 分・午後・漢数字の同じ時間は同じ行集合", () => {
    expect(列("17時以降").size).toBeGreaterThan(0);
    for (const 語 of ["17時00分以降", "午後5時以降", "十七時以降"]) {
      let n = 0;
      for (const x of 列(語)) if (!列("17時以降").has(x)) n += 1;
      for (const x of 列("17時以降")) if (!列(語).has(x)) n += 1;
      expect(n, 語).toBe(0);
      const 解 = Recommender.relativeDayNotes(語, 基準).join(" ");
      expect(解, 語).toContain("17:00〜23:59");
    }
    /* 案内は打った表記を返す – 午後を落として 5時と書かない（午前と紛れる為）。*/
    expect(Recommender.relativeDayNotes("午後5時以降", 基準).join(" ")).toContain(
      "（午後5時以降）",
    );
  });
  it("含むかが決まれぬ形と読めぬ形は 0 行の侭", () => {
    expect(列("17時30分までに").size).toBe(0);
    expect(Recommender.relativeDayNotes("17時30分までに", 基準).join("")).toContain(
      "時刻までで絞り込む事は",
    );
    expect(列("午前12時以降").size).toBe(0);
    expect(列("25時以降").size).toBe(0);
    expect(列("0時0分前").size).toBe(0);
  });
  it("其它の時間帯の語は第 418 回の侭", () => {
    /* 『一時』は専用の断り（第 420 回）で別の文 – ここでは時間帯級の語だけ見る。*/
    for (const 語 of ["朝", "夜", "夕方", "終日", "未明"]) {
      const n = Recommender.uiWordNoteJa(語);
      expect(n, 語).toContain(語);
      expect(n, 語).toContain("時間帯の名前");
    }
    /* `17時` の 1 時間ぶんはハーネスの品書に行が無い為、行数は見ない –
     * 解ける形其の物は其它の境界で見る（実ビルドでは 2 行）。*/
    expect(列("20時59分までに").size).toBe(0);
    expect(Recommender.relativeDayNotes("20時59分までに", 基準).join("")).toContain("時刻まで");
  });
});

describe("割りの形がビルド成果物に残る（第 436 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("境界の式と語群の追加が入つて居る", () => {
    for (const 形 of [
      /^(?:(午前|午後|ごぜん|ごご))?([0-9]{1,2})時(?:([0-9]{1,2})分)?(以降|より|前|前に)$/.source,
      "夜|夜中|今夜|朝|早朝|終業時間|終業|退勤|勤務終了",
      "(?:以降|前に|までに|過ぎ|後|後に)?",
    ]) {
      expect(物.split(形).length - 1, 形.slice(0, 18)).toBe(1);
    }
  });
});
