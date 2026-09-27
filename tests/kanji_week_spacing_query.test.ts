/* 第 481 回 – 漢数字の週を離つて打つ形（`一 週間後` `三 週間以内`）
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、詰めた形は其の方の
 * 規則が日の数に解くのに、離つて打つと 0 行だつた – `一 週間後` **0 行** / `一週間後` 17 行・
 * `二 週間前` **0 行** / 9 行・`三 週間以内` **0 行** / 158 行・`十一 週間後` **0 行** / 4 行。
 * 其れは漢数字を算用数字に直す目（`日付の漢数字`）が、数の語と単位の語が**繋がれて居る形だけ**を
 * 見る為だつた（其の目の注に「数の語が単体で立つ物と取り違へない為」と書いて在る – 第 392 回）。
 * 同じ目を其它の単位（月・日・年・bare 週）に広げると、実測で二つの決まりが壊れた –
 * ①件の数欄の名乗りが打たれた空格の侭で無くなる（`一 か月後` の案内が「1か月後 = …」に化けた –
 * 第 459 回・第 466 回）、②月の第何週を示す語（`第 二 週`）の案内が「第 2週 = …」に化ける。
 * なので**週間に限つて**空格を受ける別目を足した（週は其の方が日の数への換算を必要とする語で、
 * 単体で立つ数の語と取り違へる余地が無い – 第 453 回）。*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
function 品書(): string[] {
  return (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
}
const 全 = 品書();
function 列(文: string) {
  return new Set(全.filter((行) => Recommender.searchMatcher(文, 基準)(行) === true));
}
function 対称差(左: Set<string>, 右: Set<string>): number {
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}
function 案内(文: string) {
  return Recommender.relativeDayNotes(文, 基準).join("|");
}

describe("漢数字の週を離つて打つ形が詰め形と同じ行に出る（第 481 回）", () => {
  it("六の対が詰め形と一字も違わない行に出る（実測 – 前は離つた側が 0 行だつた）", () => {
    for (const [離, 繋] of [
      ["一 週間後", "一週間後"],
      ["二 週間前", "二週間前"],
      ["三 週間以内", "三週間以内"],
      ["十 週間後", "十週間後"],
      ["十一 週間後", "十一週間後"],
      ["一 週間後 の 締切", "一週間後の締切"],
    ] as Array<[string, string]>) {
      expect([離, 対称差(列(離), 列(繋))]).toEqual([離, 0]);
    }
  });
  it("行数の実測（固定ハーネスの品書 435 行）", () => {
    expect(列("一 週間後").size).toBe(13);
    expect(列("三 週間以内").size).toBe(90);
    expect(列("十 週間後").size).toBe(4);
    expect(列("十一 週間後").size).toBe(2);
    expect(列("一 週間後 の 締切").size).toBe(13);
    /* 二 週間前は其の方が過去の日にち（14 日前）なのでこの品書に行が在らん – 0 件の対称。*/
    expect(列("二 週間前").size).toBe(0);
    expect(案内("二 週間前")).toContain("14日前 = 2026年7月26日(日)");
  });
  it("件の数欄は其の日への変換を書き、0 件を約束しない", () => {
    expect(案内("一 週間後")).toContain("7日後 = 2026年8月16日(日)");
    expect(案内("三 週間以内")).toContain("21日以内 = 2026年8月9日(日)〜8月30日(日)");
  });
});

describe("他の単位に空格を広げない決まり（第 459 回・第 466 回・第 470 回）", () => {
  it("名乗りは打たれた空格の侭 – 週以外の単位は目の外", () => {
    /* 実測 2026-11-08 – 目の単位列を広くした版では此の二つが「1か月後 = …」「第 2週 = …」に
     * 化けた（行は合つた侭名乗りだけが噓になる – 第 332 回）。*/
    expect(案内("一 か月後")).toContain("一 か月後 = 2026年9月9日(水)");
    expect(案内("第 二 週")).toContain("第 二 週 = 2026年8月8日(土)〜2026年8月14日(金)");
    expect(列("第 二 週").size).toBe(26);
    expect(列("第 二 週").size).toBe(列("第2週").size);
  });
  it("bare の週を離つた形は寄せない（其の語は其它の機械が受ける）", () => {
    expect(列("一 週").size).toBe(0);
    expect(列("二 週").size).toBe(0);
    /* 其它の数字の語の離し方も其侭（実測 – 此の目を入れても変はらぬ）。*/
    expect(列("一 月 五 日").size).toBe(0);
    expect(列("五 日後").size).toBe(17);
    expect(案内("五 日後")).toContain("五 日後 = 2026年8月14日(金)");
  });
  it("第 470 回〜第 480 回の実測は此の回で変へて居ない", () => {
    expect(列("締切時刻").size).toBe(180);
    expect(列("来月 終わり").size).toBe(178);
    expect(列("週 末").size).toBe(145);
    expect(列("ml から").size).toBe(0);
    expect(列("明日以降").size).toBe(422);
    expect(列("来 上旬").size).toBe(68);
    expect(列("半 年後").size).toBe(2);
    expect(列("1 週間後").size).toBe(13);
    expect(列("明日 から 明後日").size).toBe(4);
  });
});

describe("ビルド成果物に目が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("週に限り空格を受ける目が現れる", () => {
    expect(物.match(/週の漢数字の空格/g)?.length).toBe(2);
    expect(物).toContain("{1,4})[ \\u3000]+週間");
    /* 漢数字を直す其の方の目は繋がれた形だけを見る決まりを壊して居ない（空格を許す目を
     * その目に載せ替へて居ない事の実測 – 第 481 回）。*/
    expect(物).toContain(
      "([〇一二三四五六七八九十]{1,4})(か月|カ月|ヵ月|ヶ月|ケ月|箇月|年|月|日|週間|週)",
    );
    expect(物.match(/\(\[〇一二三四五六七八九十\]\{1,4\}\)\(か月/g)?.length).toBe(1);
  });
  it("前の九回の目の字面を壊して居ない", () => {
    expect(物.match(/語の連なりJa/g)?.length).toBe(2);
    expect(物.match(/離した幅の区切りJa/g)?.length).toBe(2);
    expect(物.match(/繋がれた幅の尾Ja/g)?.length).toBe(2);
    expect(物.match(/複合語の切れ目/g)?.length).toBe(2);
    expect(物.match(/月の付いた塊/g)?.length).toBe(3);
  });
});
