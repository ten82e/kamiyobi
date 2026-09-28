/**
 * 「来週頭」「来月前半」を打つ人だけ黙つて居た – 寄せない級の説明が兄弟語にだけ在つた（第 431 回）。
 *
 * 実測（2026-10-24 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * 同じ『寄せない』決まりの `来週明け` `月初` `月前半` は 0 行でも説明の案内が出るのに、
 * `来週頭` `今週頭` `週頭` `来週初め` `今週終わり` `来月前半` `8月前半` `今月前半` は
 * **0 行で案内も無し**（「何日？と聞かれても公用の決まりが無いので絞りません」という
 * 返事が其の語だけ無かつた）。第 356 回の月前半の決まりは裸の語だけで、接頭辞付きが
 * 抜けて居たのを其の侭にしていた。
 *
 * 直し – uiWordNoteJa の週の語の案内の並びに二つの形を通す（行は作らない – 寄せない侭、
 * 其の場に打ち直しを書く）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

const 案内 = (語: string) => Recommender.uiWordNoteJa(語);

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

describe("寄せない級も黙らない – 週頭・月前半（第 431 回）", () => {
  const 週頭語 = [
    "来週頭",
    "今週頭",
    "週頭",
    "来週初め",
    "週初め",
    "今週終わり",
    "来週の頭",
    "らいしゅう頭",
  ];
  for (const 語 of 週頭語) {
    it(`『${語}』は行を作らず説明だけ返す`, () => {
      expect(列(語).size, 語).toBe(0);
      const n = 案内(語);
      expect(n, 語).toContain("絞り込めません");
      expect(n, 語).toContain(語); /* 打たれた表記を其侭返す（第 366 回） */
      expect(n, 語).toContain("公用の決まりが無く");
    });
  }
  const 月前半語 = [
    "来月前半",
    "8月前半",
    "今月前半",
    "らいげつ前半",
    "来月前半の締切",
    "9月前半に",
  ];
  for (const 語 of 月前半語) {
    it(`『${語}』は上旬・中旬への打ち直しを書く`, () => {
      expect(列(語).size, 語).toBe(0);
      const n = 案内(語);
      expect(n, 語).toContain("月の前半が何日までを指すか");
      expect(n, 語).toContain("9月上旬");
    });
  }

  it("兄弟級の案内は其侭（来週明け・月初・月前半・来週前半）", () => {
    expect(案内("来週明け")).toContain("週の明け");
    expect(案内("月初")).toContain("月の初めという言い方");
    expect(案内("月前半")).toContain("月の前半が何日までを指すか");
    /* 案内の文は第 490 回で前半・後半の話に書き換へた（旬は二語に割れて行が出る側へ移つた）。*/
    expect(案内("来週前半")).toContain("週の語に前半・後半を繋げても");
  });

  it("通る語は寄せない – 上旬は別級で其侭通る", () => {
    expect(列("8月上旬").size).toBeGreaterThan(0);
    expect(案内("8月上旬")).toBe("");
    expect(列("来週中").size).toBe(43);
  });
});

describe("其它は其侭（第 431 回）", () => {
  it("案内も件数も動かない", () => {
    for (const 語 of ["aiとml", "月 曜", "来週と 再来週", "来週", "来月"]) {
      expect(案内(語), 語).toBe("");
    }
    /* 週の語＋旬は第 490 回で行が出る側になつた（案内は出さない）。*/
    expect(案内("来週中旬")).toBe("");
    expect(列("来週中旬").size).toBe(43);
    expect(列("aiとml").size).toBe(17);
    expect(列("").size).toBe(435);
  });
});

describe("割りの形がビルド成果物に残る（第 431 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("二本の形が検査の組み立てへ並ぶ", () => {
    for (const 形 of [
      "週の頭尾のかたちJa",
      "月の前半のかたちJa",
      "頭や終わりを繋げても絞り込めません",
    ]) {
      expect(物.split(形).length - 1, 形).toBeGreaterThan(0);
    }
  });
});
