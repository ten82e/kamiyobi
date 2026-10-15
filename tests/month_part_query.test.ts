import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 行集合(語: string): Set<string> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{
    key?: string;
    hay: string;
  }>;
  const matches = Recommender.searchMatcher(語, 基準);
  return new Set(
    rows
      .filter((row) => matches(String(row.hay)) === true)
      .map((row) => String(row.key ?? row.hay)),
  );
}

function 和集合(...語列表: string[]): Set<string> {
  const out = new Set<string>();
  語列表.forEach((語) => {
    行集合(語).forEach((行) => {
      out.add(行);
    });
  });
  return out;
}

function 差分(a: Set<string>, b: Set<string>): number {
  return [...a].filter((k) => !b.has(k)).length + [...b].filter((k) => !a.has(k)).length;
}

/** 行の文本（hay）を見る – 展開がその月のその日付に届いているかの検査に使う。 */
function 文本(語: string): string[] {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
  const matches = Recommender.searchMatcher(語, 基準);
  return rows.filter((row) => matches(String(row.hay)) === true).map((row) => String(row.hay));
}

describe("上旬・中旬・下旬", () => {
  it("日が判明している会期は三旬に分け、月のみ判明の会期は未分類として残す", () => {
    const catalog = JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8"));
    const monthOnly = Recommender.candidateRows(catalog).filter(
      (row) => row.conf.key === "percom" && row.ed.id === "percom27",
    );
    expect(monthOnly).toHaveLength(3);
    for (const row of monthOnly) {
      expect(row.ed).toMatchObject({
        event_date_precision: "month-only",
        event_start: "2027-03-08",
      });
      expect(String(row.dl.utc)).not.toMatch(/^2027-03/);
    }
    const unassigned = new Set(monthOnly.map((row) => String(row.hay)));
    ["12月", "3月", "11月"].forEach((月) => {
      const 全体 = 行集合(月);
      expect(全体.size, `"${月}" の行が読めない（検査が空振り）`).toBeGreaterThan(0);
      const 三つ = 和集合(`${月}上旬`, `${月}中旬`, `${月}下旬`);
      const remaining = 月 === "3月" ? unassigned : new Set<string>();
      expect(
        [...remaining].some((row) => 三つ.has(row)),
        "月のみ判明の会期を旬に割り当てた",
      ).toBe(false);
      expect(
        差分(new Set([...三つ, ...remaining]), 全体),
        `"${月}" の日程が判明した行に漏れか余分がある`,
      ).toBe(0);
    });
  });

  it("出した行は本当にその月のその十日ぶんの中にある（發明しない）", () => {
    expect(文本("12月上旬").length).toBeGreaterThan(0);
    文本("12月上旬").forEach((hay) => {
      expect(/2026年12月([1-9]|10)日/.test(hay), "上旬の範囲外の日付で当たった").toBe(true);
    });
    文本("12月中旬").forEach((hay) => {
      expect(/2026年12月1[1-9]日|2026年12月20日/.test(hay), "中旬の範囲外の日付で当たった").toBe(
        true,
      );
    });
    文本("12月下旬").forEach((hay) => {
      expect(/2026年12月2[1-9]日|2026年12月3[01]日/.test(hay), "下旬の範囲外の日付で当たった").toBe(
        true,
      );
    });
    /* 過ぎた月の語は翌年へ繰る– 旬も同じ決まりで解く事を確かめる。 */
    文本("3月下旬").forEach((hay) => {
      expect(/2027年3月2[1-9]日|2027年3月3[01]日/.test(hay), "3月下旬が今年の3月を引いた").toBe(
        true,
      );
    });
  });

  it("上旬と中旬は同じ行を出さない（1 行に二つの締切がある時は両方に出る）", () => {
    const 上旬 = 行集合("12月上旬");
    const 中旬 = 行集合("12月中旬");
    expect(上旬.size).toBeGreaterThan(0);
    expect(中旬.size).toBeGreaterThan(0);
    /* 行の文本には締切ラウンドが幾つも書かれているので、上旬の行が中旬にも出ることがある –
     * それは嘘ではなく、同じ行に二つの締切がある事になる（実測で 12月は 92 行が重なった）。
     * 重ならない行が必ずある事だけを見る – 範囲が同じになっていない事の検査。 */
    expect(
      [...上旬].filter((行) => !中旬.has(行)).length,
      "上旬が中旬と完全に同じになった",
    ).toBeGreaterThan(0);
    expect(
      [...中旬].filter((行) => !上旬.has(行)).length,
      "中旬が上旬と完全に同じになった",
    ).toBeGreaterThan(0);
  });

  it("離して打っても、詰めて打っても同じ行に出会う", () => {
    [
      ["来月下旬", "来月 下旬"],
      ["8月上旬", "8月 上旬"],
      ["3月下旬", "2027年 3月 下旬"],
      ["今月中旬", "今月 中旬"],
    ].forEach(([詰めた, 離れた]) => {
      const 基準行 = 行集合(詰めた);
      expect(基準行.size, `"${詰めた}" が 0 行の前提が崩れた`).toBeGreaterThan(0);
      expect(差分(行集合(離れた), 基準行), `"${離れた}" が違う行を出した`).toBe(0);

      const 解いた範囲 = (語: string) => {
        const 節 = Recommender.relativeDayNotes(語, 基準).join("").split(" = ");
        return 節.length > 1 ? 節[節.length - 1] : "";
      };
      expect(解いた範囲(離れた), `"${離れた}" の案内が別の範囲を指した`).toBe(解いた範囲(詰めた));
      expect(解いた範囲(離れた)).not.toBe("");
    });
  });

  it("冠のない「上旬」は今月のそれ、「来月下旬」は来月のそれ（案内も同じ範囲を言う）", () => {
    expect(差分(行集合("上旬"), 行集合("今月上旬"))).toBe(0);
    const 案内 = Recommender.relativeDayNotes("来月下旬", 基準);
    expect(案内.length).toBe(1);
    expect(案内[0]).toContain("2026年9月21日");
    expect(案内[0]).toContain("2026年9月30日");
    expect(案内[0], "分け方の決まりを書いていない").toContain("下旬は月の 21 日から 30 日までです");
    expect(案内[0], "月末までの話を省いた").toContain("月末まで");
    const 上旬 = Recommender.relativeDayNotes("8月上旬", 基準);
    expect(上旬[0]).toContain("上旬は月の 1 日から 10 日までです");
    expect(上旬[0]).toContain("(土)");
  });

  it("「下旬までに」は今日からの幅、「下旬以降」はその初日からの幅で絞る（第 475 回）", () => {
    const まで = 行集合("下旬までに");
    const 下旬 = 行集合("下旬");
    expect(下旬.size).toBeGreaterThan(0);
    expect([...下旬].filter((行) => !まで.has(行)).length, "『までに』が旬の行を落とした").toBe(0);
    const 幅 = Recommender.relativeDayNotes("下旬までに", 基準).join("");
    expect(幅).toContain("2026年8月9日");
    expect(幅).toContain("8月31日");

    expect(行集合("下旬以降").size).toBe(414);
    expect(Recommender.relativeDayNotes("下旬以降", 基準).join("")).toBe("");
  });

  it("切り方の決まりが公用にない語は受けない（0 件と案内の無さを pins する）", () => {
    ["月初", "前半", "後半", "週明け", "上半期", "下期"].forEach((語) => {
      expect(行集合(語).size, `"${語}" を受けてしまった`).toBe(0);
      expect(Recommender.relativeDayNotes(語, 基準).join(""), `"${語}" の案内を立てた`).toBe("");
    });
  });

  it("他の語との組み合わせは絞り込みになる", () => {
    const 旬 = 行集合("12月下旬");
    const 絞った = 行集合("12月下旬 セキュリティ");
    expect(旬.size).toBeGreaterThan(絞った.size);
    expect([...絞った].filter((行) => !旬.has(行)).length, "足した語で行が増えた").toBe(0);
  });

  it("組み立てた画面に表と形が残っている（ハーネスは名指し – 第 329 回）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");

    [
      "上旬: [1, 10]",
      "中旬: [11, 20]",
      "下旬: [21, 0]",
      "MONTH_PART_TAIL_JA",
      "monthPartTermsJa",
    ].forEach((断片) => {
      expect(rec.includes(断片), `組み立てた画面から ${断片} が消えた`).toBe(true);
    });
  });
});
