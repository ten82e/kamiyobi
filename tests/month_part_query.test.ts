/**
 * 上旬・中旬・下旬で引けることの検査（SPEC §4・§7・第 332 回）。
 * 実測（2026-09-28 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `下旬` `上旬` `中旬` `8月下旬` `来月上旬` `今月中旬` `3月下旬` いずれも **0 行**だった –
 * 同じ月の `月末` 189 行・`来月末` 240 行は通る。月のまとめ方を「旬」で聞くのは日本語の
 * 普通の名前なので、受ける（日の区切りは JIS X 0412 の分け方: 上旬 1〜10 日・中旬 11〜20 日・
 * 下旬 21 日から月末）。
 */

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
  it("三分の一を合わせるとその月の行とちょうど一致する（漏れも余分もない）", () => {
    ["12月", "3月", "11月"].forEach((月) => {
      const 全体 = 行集合(月);
      expect(全体.size, `"${月}" の行が読めない（検査が空振り）`).toBeGreaterThan(0);
      const 三つ = 和集合(`${月}上旬`, `${月}中旬`, `${月}下旬`);
      expect(差分(三つ, 全体), `"${月}の旬の和集合" が "${月}" と違う行を出した`).toBe(0);
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
    /* 過ぎた月の語は翌年へ繰る（第 251 回の月の決まり）– 旬も同じ決まりで解く事を確かめる。 */
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
    /* 行の文本には締切ラウンドが幾つも書かれているので、上旬の行が中旬にも出ることが有る –
     * それは嘘ではなく、同じ行に二つの締切が在る事になる（実測で 12月は 92 行が重なった）。
     * 重ならない行が必ず在る事だけを見る – 範囲が同じになっていない事の検査。 */
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
      /* 案内も同じ範囲を言う – 行は 9 月のに「8月下旬」と書いたら画面の嘘になる（第 332 回）。
       * 打たれた語の後ろ（` = ` の後）が食い違わない事だけ見る – 前は打たれた形のまま出す。 */
      /* 第 496 回に數字の年（`2027年`）へ其の年の幅の案内を足したので、年の語を別に打つた形
       * （`2027年 3月 下旬`）は其の案内を先頭に持つ – 年の語で打つた形（`來年 3月 下旬`）が
       * 元から然うなので、其れに揃へた。見るのは**其の月の範囲**（最後の ` = ` の後）。*/
      const 解いた範囲 = (語: string) => {
        const 節 = Recommender.relativeDayNotes(語, 基準).join("").split(" = ");
        return 節.length > 1 ? 節[節.length - 1] : "";
      };
      expect(解いた範囲(離れた), `"${離れた}" の案内が別の範囲を指した`).toBe(解いた範囲(詰めた));
      expect(解いた範囲(離れた)).not.toBe("");
    });
  });

  it("冠の無い「上旬」は今月のそれ、「来月下旬」は来月のそれ（案内も同じ範囲を言う）", () => {
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

  it("「下旬までに」は今日からの幅、「下旬以降」は其の初日からの幅で絞る（第 475 回）", () => {
    const まで = 行集合("下旬までに");
    const 下旬 = 行集合("下旬");
    expect(下旬.size).toBeGreaterThan(0);
    expect([...下旬].filter((行) => !まで.has(行)).length, "『までに』が旬の行を落とした").toBe(0);
    const 幅 = Recommender.relativeDayNotes("下旬までに", 基準).join("");
    expect(幅).toContain("2026年8月9日");
    expect(幅).toContain("8月31日");
    /* 第 328 回は「以降」を一日の幅に畳むのを避けて絞り込まない決まりにしたが、其れは
     * 其のままだと 0 行になる上に、案内が「初期画面は…その以降の締切も並びます」と書く為、
     * 画面が其れを果たさない形に成つて居た（実測 2026-11-08）。第 475 回で暦日を打つ形
     * （`8月22日以降`）と同じ決まり – 其の初日から其の年の中まで – で絞るやうにした。
     * 絞れる形になったので件の数欄の案内は出ない（第 413 回と同じ）。 */
    expect(行集合("下旬以降").size).toBe(414);
    expect(Recommender.relativeDayNotes("下旬以降", 基準).join("")).toBe("");
  });

  it("切り方の決まりが公用に無い語は受けない（0 件と案内の無さを pins する）", () => {
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
    /* ビルド成果物では表の鍵に引用符が付きません（`上旬: [1, 10]` の形 – 2026-09-28 実測）なので、
     * 成果物に実際に出る形を見ます（引用符を付けた前提で検査を書かない – 第 330 回と同じ教訓）。 */
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
