/**
 * 月に数字を打った『末』（`8月末` `3月末` `2026年12月末`）の件数欄の案内 – 第 407 回。
 *
 * 実測（2026-10-04 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻
 * 2026-08-09T00:00:00Z）: 其の方の形は其の月の語と一寸ちがいの無い当たり方が出るのに、
 * 件の数欄は何も言わなかつた – `8月末` 210 行（= `8月` 210 行）・`3月末` 80 行（= `3月`
 * 80 行）・`12月末` 183 行（= `12月` 183 行）・`2026年12月末` 183 行（= `2026年12月` 183 行）・
 * `8月終わり` 210 行・`月終わり` 189 行（= `月末` 189 行）で、対称差は総て 0。
 * 月の語を名で打つ形（`今月末` `来月末` `月末`）は第四条の決まりどおり案内を出すので、
 * 数を打つ人だけ『末』が月の語に化けた事を知らずに居た。
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
  const 甲々 = 列(甲);
  const 乙々 = 列(乙);
  return (
    [...甲々].filter((行) => !乙々.has(行)).length + [...乙々].filter((行) => !甲々.has(行)).length
  );
}

const 文 = (語: string): string => {
  const 件 = Recommender.periodMonthPairs(語, 基準) as Array<[string, string]>;
  return 件.length ? String(件[0][1]) : "";
};

describe("月に数字を打った『末』の案内", () => {
  it("当たり方は其の月の語と一寸も変ら無い（案内だけを増やした）", () => {
    for (const [語, 対照] of [
      ["8月末", "8月"],
      ["3月末", "3月"],
      ["12月末", "12月"],
      ["2026年12月末", "2026年12月"],
      ["8月終わり", "8月"],
      ["月終わり", "月末"],
      ["8月末まで", "8月末"],
    ] as Array<[string, string]>) {
      expect(列(語).size, `「${語}」が行を出さない`).toBeGreaterThan(0);
      expect(対称差(語, 対照), `「${語}」の当たり方が「${対照}」と違う`).toBe(0);
    }
  });

  it("年を打たれた形は其の年の末日を書く", () => {
    expect(文("2026年12月末")).toBe("2026年12月の締切（末日は 2026年12月31日(木)）");
    expect(文("2026年12月末まで")).toBe("2026年12月の締切（末日は 2026年12月31日(木)）");
    /* うるう年の 2月（暦から数える – 2月31日を書かない）。 */
    expect(文("2028年2月末")).toContain("2028年2月29日");
    expect(文("2027年2月末")).toContain("2027年2月28日");
  });

  it("年を打たれて居ない形は他の年も並ぶと書く（其の年決まりと読ませない）", () => {
    for (const 語 of ["8月末", "3月末", "12月末", "8月終わり", "8月末まで", "8月末までに"]) {
      const 解 = 文(語);
      expect(解.length, `「${語}」の案内が黙つて居る`).toBeGreaterThan(0);
      expect(解, `「${語}」の案内が他の年に触れていない`).toContain("他の年の");
      expect(解, `「${語}」の案内が其の月を決まつた様に書く`).not.toMatch(
        /^20[0-9]{2}年[0-9]{1,2}月の締切/,
      );
      expect(解, `「${語}」の案内が末日を書かない`).toContain("末日は");
    }
  });

  it("助詞を付きただけの形は其のままの形と同じ案内", () => {
    for (const [語, 基] of [
      ["8月末まで", "8月末"],
      ["8月末までに", "8月末"],
      ["8月末に", "8月末"],
      ["8月終わりまで", "8月終わり"],
    ] as Array<[string, string]>) {
      expect(文(基).length, `対照の「${基}」の案内が無い`).toBeGreaterThan(0);
      expect(文(語), `「${語}」の案内が形だけ違う`).toBe(文(基));
    }
  });

  it("月の語を名で打つ形の案内は第 368 回の侭", () => {
    expect(文("今月末")).toBe("2026年8月の締切（末日は 2026年8月31日(月)）");
    expect(文("来月末")).toBe("2026年9月の締切（末日は 2026年9月30日(水)）");
    expect(文("月終わり"), "『月終わり』が『月末』と違う").toBe(文("月末"));
  });
});

describe("守り", () => {
  it("其の方の語ではない形に案内を足さない", () => {
    for (const 語 of ["8月", "2026年12月", "明日までに", "3日後", "8月上旬", "今週末"]) {
      expect(Recommender.periodMonthPairs(語, 基準), `「${語}」に案内を足した`).toEqual([]);
    }
  });

  it("月の切れ目の他のの語は今の書き方の侭", () => {
    expect(文("年度末")).toBe("2027年3月の締切");
    expect(文("年末")).toBe("2026年12月の締切");
    expect(文("年内")).toBe("2026年8月から2026年12月の締切");
  });

  it("其れより後ろは案内だけで絞り込まない決まりの侭", () => {
    expect(列("8月末").size, "対照の `8月末` が 0 行").toBeGreaterThan(0);
    expect(対称差("8月末", "3月末")).toBeGreaterThan(0);
  });
});

describe("成果物", () => {
  it("案内は一個所の関数で決まる", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/function 月の末の案内Ja\(/g) ?? []).toHaveLength(1);
    expect(
      物.match(/月の末の案内Ja\(part, nowMs\)/g) ?? [],
      "案内が月の切れ目の語の処で呼ばれていない",
    ).toHaveLength(1);
    expect(物.match(/^\s*月終わり: "今月",$/gm) ?? []).toHaveLength(1);
  });
});
