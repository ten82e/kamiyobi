/**
 * 「半月後」を打つ人（半月 = 15 日）– 第 426 回。
 *
 * 実測（2026-10-23 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * 案内側は半月を 15 日として読む決まりを既に持つ（第 330 回 – `半月`・`半月以内` には
 * 「15 日として読む」の欄の話が出る）のに、行を出す側だけ日を決めず、`半月後` **0 行**・
 * `半月後までに` **0 行**・`半月後と来週` **0 行**で案内も無しだった（同じ日の `15日後` は
 * 8 行・`15日後までに` 98 行・`15日後と来週` 61 行が通る）。`半ケ月後` `半ヶ月後` も同じ
 * （NFKC はケ・ヶを折らない – 第 330 回の実測）。
 *
 * 直し – 数値の相対日（numericRelativeDay）に半月（15 日ぶん）の語を足す。半月は 15 日と
 * 暦の定めで決まるので「月の長さを日数に換えない」決まり（第 318 回）に触れない。
 * 数値の相対日の目印（列挙と『までに』の受け口）も同じ形に揃え、列挙の展開の『半』総当たり
 * 拒否（第 395 回 – 当時は半月は日を決めないので正しかった）は「日を決める形を通す」に直す。
 *
 * 番として – 裸の『半月』『半月以内』『半年』は其侭（案内は其の方の欄の話を書く・
 * 第 315/330 回の決まりで月の単位を検索側で換えない）。『半月前』は 15 日ぶん前として解くが
 * 『半月前までに』は解かない（いつまで遡るかを書く規則は其侭 – 第 367 回）。
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
const 対称差 = (甲: string, 乙: string) => {
  const A = 列(甲);
  const B = 列(乙);
  let 違 = 0;
  for (const 行 of new Set([...A, ...B])) if (A.has(行) !== B.has(行)) 違 += 1;
  return 違;
};
const 和集合の差 = (列挙: string, 甲: string, 乙: string) => {
  const A = 列(列挙);
  const U = new Set([...列(甲), ...列(乙)]);
  let 違 = 0;
  for (const 行 of new Set([...A, ...U])) if (A.has(行) !== U.has(行)) 違 += 1;
  return 違;
};

describe("半月後は 15 日後と同じ一日になる（第 426 回）", () => {
  const 対: Array<[string, string]> = [
    ["半月後", "15日後"],
    ["半月前", "15日前"],
    ["半月後までに", "15日後までに"],
    ["半月後と来週", "15日後と来週"],
    ["半ケ月後", "15日後"],
    ["半ヶ月後", "15日後"],
  ];
  for (const [半月, 日数] of 対) {
    it(`『${半月}』は『${日数}』と同じ一覧`, () => {
      expect(対称差(半月, 日数), 半月).toBe(0);
      expect(列(半月).size, 半月).toBeGreaterThan(0);
    });
  }

  it("列挙と読点の並びも和集合になる", () => {
    expect(和集合の差("明日と半月後", "明日", "半月後")).toBe(0);
    expect(列("明日と半月後").size).toBeGreaterThan(0);
    expect(対称差("半月後、明日", "明日と半月後")).toBe(0);
  });

  it("案内に其の方の日付を書く", () => {
    const 注 = Recommender.relativeDayNotes("半月後", 基準).join(" ");
    expect(注).toContain("半月後 = 2026年8月24日(月)");
    const 幅 = [
      Recommender.uiWordNoteJa("半月後までに"),
      ...Recommender.relativeDayNotes("半月後までに", 基準),
    ].join(" ");
    expect(幅).toContain("8月24日");
  });
});

describe("裸の半月と其它は其侭（第 426 回）", () => {
  it("裸の『半月』『半月以内』は当たり方にせず、欄の話の案内を書く（第 315 回・第 330 回の決まり）", () => {
    expect(列("半月").size).toBe(0);
    expect(列("半月以内").size).toBe(0);
    for (const 語 of ["半月", "半月以内"]) {
      const 注 = [Recommender.uiWordNoteJa(語), Recommender.dayRangeNoteJa(語)]
        .filter(Boolean)
        .join(" ");
      expect(注, 語).toContain("当たりません");
    }
  });

  it("『半月前までに』は遡りの終わりを決めるので行を作らない（第 367 回の決まり）", () => {
    expect(対称差("半月前までに", "15日前までに")).toBe(0);
  });

  it("其它の日の語は一寸も動かない", () => {
    expect(対称差("1週間後", "7日後")).toBe(0);
    expect(列("半年後").size).toBe(2);
    expect(対称差("月 曜", "")).toBe(0);
    expect(対称差("aiとml", "ai ml")).toBe(0);
    expect(対称差("来週と 再来週", "来週と再来週")).toBe(0);
    expect(列("").size).toBe(435);
  });
});

describe("割りの形がビルド成果物に残る（第 426 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("数値の相対日に半月の枝が在り、列挙の拒否は日を決める形を通す", () => {
    expect(物.match(/数 = 15;\s*\n\s*単位 = "日";\s*\n\s*前後 = token\.slice\(-1\)/g)).toHaveLength(
      1,
    );
    expect(
      物.match(/if \(\/半\/\.test\(語\) && !numericRelativeDay\(語, nowMs\)\)\s*return \[\];/g),
    ).toHaveLength(1);
  });
  it("『半』の総当たり拒否に戻っていない", () => {
    expect(物.includes("if (/半/.test(語)) return [];")).toBe(false);
  });
});
