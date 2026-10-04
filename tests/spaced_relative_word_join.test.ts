/**
 * 相対日の語を空格で二つに割って打った人（『来 週』『明 日』『再 来週』）– 第 423 回。
 *
 * 実測（2026-10-09 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * 寄せた語は行が出る（来週 53・来月 240・来年 452・明後日 12・明日 4）のに、語の内で空格を打つと
 * 二語に割れて片方も日時の語として解けず、**AND で 0 行**だった – 『来 週』『今 週』『明 日』
 * 『来 月』『来 年』『今 日』『先 週』『再 来週』すべて 0 行（半角・全角空格とも）。
 *
 * 直し – 検索の語に立てる対を表で持ち、隣り合う語を寄せる（queryTokens の語を足す折り）。
 * 表に置くのは片段が単体 0 行（来・明・今・再・先・翌・昨・週・後日）で、寄せた語が解ける対だけ –
 * 今は 0 行の形にだけ効く。片段が其の方の語を持つ形（`月 曜` 872 行 – 月曜と月と日の関係）・
 * 片側が既に解ける形（`来週 月曜` 4 行・`来週 中` 2 行）には触らない。
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

function 対称差(甲: string, 乙: string): number {
  const A = 列(甲);
  const B = 列(乙);
  return [...A].filter((行) => !B.has(行)).length + [...B].filter((行) => !A.has(行)).length;
}

/* 検査用ビルドで行の在る対だけ（片段は単体 0 行の実測 – 来 43・今週 4・明日 2・来月 178）。 */
const 対 = [
  ["来 週", "来週", 43],
  ["今 週", "今週", 4],
  ["明 日", "明日", 2],
  ["来 月", "来月", 178],
  ["来 年", "来年", 114],
  ["再 来週", "再来週", 18],
  ["明 後日", "明後日", 4],
] as const;

describe("空格で割れた相対日の語", () => {
  it("寄せた語と一寸もちがわない行が出る（来 週 53 行 → 同じ話）", () => {
    for (const [空格, 密, 基] of 対) {
      expect(対称差(空格, 密), `「${空格}」が「${密}」と違う行を出した`).toBe(0);
      expect(列(空格).size, `「${空格}」の行が消えた`).toBe(基);
    }
  });

  it("全角空格でも同じ（『来　週』）", () => {
    expect(対称差("来　週", "来週"), "全角空格で割れた形が寄らない").toBe(0);
    expect(列("来　週").size, "全角空格の『来　週』の行が消えた").toBe(43);
  });

  it("語の後ろに語を連ねても効く（『来 週 月曜』は『来週 月曜』と同じ）", () => {
    expect(対称差("来 週 月曜", "来週 月曜"), "語を連ねた打ち方で違う行が出た").toBe(0);
    expect(列("来 週 月曜").size, "『来 週 月曜』の行が消えた").toBe(2);
  });

  it("寄せる順を変えても同じ（『再 来週』と『再来 週』）", () => {
    expect(対称差("再 来週", "再来 週"), "割る位置で違う話になった").toBe(0);
    expect(列("再来 週").size, "『再来 週』が解けない").toBe(18);
  });

  it("別の相対語に寄せない（来週と今週は違う話 – 對稱差が其侭開く）", () => {
    expect(対称差("来 週", "今 週"), "違う語同士が同じ行に寄った").toBeGreaterThan(0);
    expect(対称差("来 週", "来 月"), "週と月が同じ行に寄った").toBeGreaterThan(0);
  });
});

describe("壊して居ない側", () => {
  it("片段が其の方の語を持つ形は其侭（『月 曜』435 行 – 月曜に潰さない）", () => {
    expect(列("月 曜").size, "『月 曜』が行けた（語の寄せが内容検索を潰した）").toBe(436);
    expect(対称差("来週 月曜", "来週"), "『来週 月曜』が『来週』に潰れた").toBeGreaterThan(0);
    expect(列("明日 明後日").size, "並べ打ちが 0 行に潰れた").toBeGreaterThan(0);
    expect(対称差("明日 明後日", "明日 明後日"), "空格の位置で話が変わった").toBe(0);
  });

  it("其の他の検索は一寸も動かない（幅・語の列・時間）", () => {
    expect(対称差("3 日以内", "3日以内"), "空格幅が動いた").toBe(0);
    expect(
      対称差("来週 の 締切", "来 週 の 締切"),
      "助詞を連ねた列で寄せが其の他の話を作った",
    ).toBe(0);
    expect(対称差("二十時", "20時"), "時刻が動いた").toBe(0);
    expect(列("30分以内").size, "分数幅で行が出るようになった").toBe(0);
  });

  it("空・片段だけの検索は其侭全部/0（表が其の他の語に波及しない）", () => {
    expect(列("").size, "空検索が行けなかった（語立てが壊れた）").toBe(436);
    expect(列("週 週").size, "同じ片段の繰り返しが行けた").toBe(0);
  });

  it("成果物の語立てに表が在り、其処にだけ寄せる枝が在る", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.split("const 相対語の寄せJa = [").length - 1, "寄せの表の数が違う").toBe(1);
    for (const 形 of ['["来", "週", "来週"]', '["明", "日", "明日"]', '["再", "来週", "再来週"]']) {
      expect(物.split(形).length - 1, `表の対 ${形} が無い`).toBe(1);
    }
    /* 片段が単体で語を持つ形を表に足して居ない事（月・日・年を寄せると内容検索が潰れる –
     * 曜日の表（日月火…）と同じ断片なので、寄せの表の区切りの中だけで見る）。 */
    const 頭 = 物.indexOf("const 相対語の寄せJa = [");
    expect(頭, "寄せの表が成果物に無い").toBeGreaterThan(-1);
    const 表の中 = 物.slice(頭, 物.indexOf("];", 頭));
    for (const 禁忌 of ['"月", "曜"', '"日", "月"', '"年", "月"', '"月", "年"', '"日", "年"']) {
      expect(表の中.includes(禁忌), `表が内容語の対 ${禁忌} を受けて居る`).toBe(false);
    }
  });
});
