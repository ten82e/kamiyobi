import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

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
function 日の案内(文: string) {
  return (Recommender.relativeDayNotes(文, 基準) || []).join("|");
}

describe("語尾のない年＋暦月にもその年の幅の案内が出る（第 497 回）", () => {
  it("繋いだ形と離した形で、行も案内も揃ふ", () => {
    for (const [繋, 離] of [
      ["2028年3月", "2028年 3月"],
      ["2027年3月", "2027年 3月"],
      ["2026年3月", "2026年 3月"],
      ["2026年12月", "2026年 12月"],
      ["2028年12月", "2028年 12月"],
      ["2029年1月", "2029年 1月"],
      ["再来年3月", "再来年 3月"],
    ] as Array<[string, string]>) {
      expect([繋, 対称差(列(繋), 列(離))], `「${繋}」が「${離}」と違ふ`).toEqual([繋, 0]);
      expect([繋, 日の案内(繋)], `「${繋}」の案内が違ふ`).toEqual([繋, 日の案内(離)]);

      expect(日の案内(繋), `「${繋}」に月の幅が無い`).toMatch(/\d+月の締切（その月だけ/);
    }
  });
  it("品書に締切がない月でも、何も出ない理由が画面に出る", () => {
    expect(列("2028年3月").size).toBe(0);
    expect(日の案内("2028年3月")).toContain("2028年3月の締切");
    expect(日の案内("2028年3月")).not.toContain("絞り込まずにいます");
  });
  it("日の続く形と週の数はこの目で割らない（そちらの目が受ける）", () => {
    /* `2027年8月10日頃` はその方の案内（その日の幅）を保つ。`2027年2月第5週` は幅を作らず無言。*/
    expect(日の案内("2027年8月10日頃")).toContain("2027年8月10日");
    expect(日の案内("2027年8月10日頃")).not.toContain("年の締切");
    expect(日の案内("2027年2月第5週")).toBe("");
    expect(列("2027年2月第5週").size).toBe(0);
  });
  it("行は一個も動かして居ない（案内だけの直し）", () => {
    expect(列("2027年3月").size).toBe(29);
    expect(列("2026年12月").size).toBe(84);
    expect(列("2028年3月").size).toBe(0);
    expect(列("来年3月").size).toBe(列("来年 3月").size);
    expect(列("今年3月").size).toBe(列("今年 3月").size);
  });
  it("第 470 回〜第 496 回の実測はこの回で変へて居ない", () => {
    expect(列("2027年12月から").size).toBe(21);
    expect(列("2028年3月から").size).toBe(0);
    expect(列("来年12月から").size).toBe(21);
    expect(列("今年1月から").size).toBe(427);
    expect(列("2026年1月から").size).toBe(427);
    expect(列("2028年").size).toBe(0);
    expect(列("来年上旬").size).toBe(2);
    expect(列("来週中旬").size).toBe(43);
    expect(列("年末上旬").size).toBe(40);
    expect(列("来月 末日").size).toBe(178);
    expect(列("週 末").size).toBe(146);
    expect(列("ml から").size).toBe(0);
    expect(列("締切時刻").size).toBe(181);
  });
});

describe("ビルド成果物に目がある事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("再来年と数字の年を割る目が、日の形と週の数を外す見張り付きで現れる", () => {
    expect(物).toContain(
      "((?:再来年|[0-9]{4}年))([0-9]{1,2}月|[〇一二三四五六七八九十]{1,3}月)(?![0-9]{1,2}日|[0-9第])",
    );
    /* 今の年の語の列は觸つて居ない。*/
    expect(物).toContain(
      "((?:来|今|去|明|昨|翌)年)([0-9]{1,2}月|[〇一二三四五六七八九十]{1,3}月)(?![ \\u3000]*(?:から|より|以降",
    );
  });
});
describe("相対の語がどう解けたかを名乗る（第 940 回）", () => {
  const now = new Date("2026-11-08T00:00:00Z").getTime();
  it("「年＋月」は、その月だけだと名乗る（年全体と言わない）", () => {
    for (const 語 of ["2026年11月", "来年12月", "再来年3月"]) {
      const 注 = Recommender.relativeDayNotes(語, now);
      expect(注.length, `「${語}」の注が無い（黙って居る）`).toBeGreaterThan(0);
      expect(注[0], `「${語}」に其の月が無い`).toContain("その月だけ");
      expect(注[0], `「${語}」を年全体と言つて居る（嘘）`).not.toContain("1〜12 か月");
    }
    /* 年だけなら從來の文（それは嘘ではない – その年全体を見る）。 */
    expect(Recommender.relativeDayNotes("2026年", now)[0] ?? "").toContain("1〜12 か月");
    expect(Recommender.relativeDayNotes("来年", now)[0] ?? "").toContain("1〜12 か月");
  });
  it("月の後に機能語が続いても、その月だけを名乗る（第 941 回）", () => {
    for (const 語 of ["今月の締切", "来月の締切"]) {
      const 注 = Recommender.relativeDayNotes(
        (
          Recommender as unknown as { expandRelativeMonths(q: string, n: number): string }
        ).expandRelativeMonths?.(語, now) ?? 語,
        now,
      );
      expect(注[0] ?? "", `「${語}」に其の月が書いて居ん`).toContain("その月だけ");
      expect(注[0] ?? "", `「${語}」を年全体と言つて居る（嘘）`).not.toContain("1〜12 か月");
    }
    /* 幅の語尾（`まで`・`から`）は飛ばさない – その處の行が幅を名乘る。 */
    for (const 語 of ["来年12月まで", "来年12月から"]) {
      expect(Recommender.relativeDayNotes(語, now)[0] ?? "").toContain("1〜12 か月");
    }
    /* 自分で月を打つ形は黙つていい（年は既にその文にある – 危險なのは勝手に解けた形）。 */
    expect(Recommender.relativeDayNotes("2026年11月", now)[0] ?? "").toContain("その月だけ");
  });

  it("幅の言い方は、その處の行に讓る（第 493 回の約束 – 潰さない）", () => {
    for (const 語 of ["来年12月から", "来年12月まで", "来年3月まで"]) {
      const 注 = Recommender.relativeDayNotes(語, now);
      expect(注[0] ?? "", `「${語}」の注`).toContain("1〜12 か月");
      expect(注[0] ?? "", `「${語}」を其の月だと名乗つて居る`).not.toContain("その月だけ");
    }
  });
  it("行の数と案内の幅が合う（検算できる – 第 496 回の数え方）", () => {
    /* 品書で「その月」と「その年」の行数を数へて、案内の幅と比べる。 */
    const snap = JSON.parse(
      readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8"),
    ) as never;
    const 行 = Recommender.candidateRows(snap);
    const 照合 = (語: string): number => {
      const m = Recommender.searchMatcher(語, now);
      return 行.filter((r) => m(r.hay) === true).length;
    };
    const 月 = 照合("2026年11月");
    const 年 = 照合("2026年");
    expect(月, "「その月」で 0 行（検査が空振り）").toBeGreaterThan(0);
    expect(年, "「その年」が「その月」より少い（検算が逆だ）").toBeGreaterThan(月);
  });
});
