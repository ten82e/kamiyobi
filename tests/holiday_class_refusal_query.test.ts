/**
 * 「2連休」を打つ人だけ案内も無しで黙つて居た – 祝日級の語表は語の形列挙だけ（第 434 回）。
 *
 * 実測（2026-10-24 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `連休` `三連休` `大型連休` `祝日` `お盆` `年末年始` `祝祭日` `振替休日` は「収録して
 * 居ません」の案内が出るのに、`2連休` `5連休` `連休明け` `連休中日` `連休初日`
 * `連休最終日` `シルバーウィーク` `代替休日` は 0 行で案内も無し。第 378 回の語表は
 *其の時判つた語の形だけを列挙して居た。品書の文本に holiday は一度も現れない為、
 * 「収録して居ません」は本当 – 数字と接尾の形も同じ案内で受ける（行を出さない事は不变）。
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

describe("祝日級を数字や接語で繋げて打つも同じ案内を受ける（第 434 回）", () => {
  for (const 語 of [
    "2連休",
    "5連休",
    "10連休",
    "二連休",
    "三連休明け",
    "連休明け",
    "連休中日",
    "連休初日",
    "連休最終日",
  ]) {
    it(`『${語}』は 0 行の侭、打たれた表記で祝日級の案内が出る`, () => {
      expect(列(語).size, 語).toBe(0);
      const n = Recommender.uiWordNoteJa(語);
      expect(n, 語).toContain(`「${語}」`);
      expect(n, 語).toContain("祝日・休日の名前で打たれても");
      expect(n, 語).toContain("絞り込めません");
    });
  }
  for (const 語 of ["シルバーウィーク", "代替休日"]) {
    it(`『${語}』は語表の語として案内が出る（行 0 の侭）`, () => {
      expect(列(語).size, 語).toBe(0);
      const n = Recommender.uiWordNoteJa(語);
      expect(n, 語).toContain(語);
      expect(n, 語).toContain("この表は祝日・休日");
    });
  }
});

describe("祝語の付き方も同じ案内を受ける（第 435 回）", () => {
  for (const 語 of [
    "GW明け",
    "お盆明け",
    "盆明け",
    "お盆前",
    "年末年始中",
    "ゴールデンウィーク明け",
    "大型連休明け",
    "祝日明け",
    "正月",
    "正月明け",
  ]) {
    it(`『${語}』は 0 行の侭、打たれた表記で祝日級の案内が出る`, () => {
      expect(列(語).size, 語).toBe(0);
      const n = Recommender.uiWordNoteJa(語);
      expect(n, 語).toContain(`「${語}」`);
      expect(n, 語).toContain("祝日・休日の名前で打たれても");
    });
  }
  it("『年始』『年末』は月の語 – 祝日級に引き寄せない", () => {
    expect(列("年始").size).toBeGreaterThan(0);
    expect(列("年末").size).toBeGreaterThan(0);
    expect(Recommender.uiWordNoteJa("年始")).not.toContain("祝日");
    expect(Recommender.uiWordNoteJa("年末")).not.toContain("祝日");
  });
});

describe("其它の語を祝日級に引き寄せない（第 434 回）", () => {
  it("曜日と平日は普通に絞れて祝日案内が出ない", () => {
    expect(列("土日").size).toBeGreaterThan(0);
    expect(列("平日").size).toBeGreaterThan(0);
    expect(Recommender.uiWordNoteJa("土日")).not.toContain("祝日");
    expect(Recommender.uiWordNoteJa("平日")).not.toContain("祝日");
  });
  it("其它の断られ語は其の方の案内の侭", () => {
    for (const 語 of ["明日", "3日あたり", "来週中頃", "月初", "来週頭"]) {
      expect(Recommender.uiWordNoteJa(語), 語).not.toContain("祝日");
    }
    expect(列("8月頃").size).toBe(0);
  });
  it("語表の語は従来通り（第 378 回）", () => {
    for (const 語 of ["連休", "三連休", "大型連休", "祝祭日", "土日祝"]) {
      const n = Recommender.uiWordNoteJa(語);
      expect(n, 語).toContain(語);
      expect(n, 語).toContain("この表は祝日・休日");
    }
  });
});

describe("割りの形がビルド成果物に残る（第 434 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("数字+連休の形と接尾の列挙と新語が入つて居る", () => {
    for (const 形 of [
      /^(?:[0-9]{1,2}|二|三|四|五|六|七)?連休(?:明け|中日|初日|最終日)?$/.source,
      /* 語表の条目その物（コメントにも其の名が一寸出る為、行の形見る）。*/
      '"シルバーウィーク",',
      '"代替休日",',
      /^(?:GW|ゴールデンウィーク|シルバーウィーク|大型連休|お盆|盆|年末年始|正月|祝日|祝祭日|振替休日|代替休日)(?:明け|前|中)?$/
        .source,
    ]) {
      expect(物.split(形).length - 1, 形.slice(0, 18)).toBe(1);
    }
  });
});
