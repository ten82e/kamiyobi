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

function 対称差(甲: Set<string>, 乙: Set<string>): number {
  return [...甲].filter((行) => !乙.has(行)).length + [...乙].filter((行) => !甲.has(行)).length;
}

/** その年の初めからその終わりまでの暦日を単体で打った形の和集合（月を跨いでも動く）。 */
function 日の幅和(
  頭: readonly [number, number, number],
  尾: readonly [number, number, number],
): Set<string> {
  const 和 = new Set<string>();
  let [年, 月, 日] = 頭;
  for (;;) {
    for (const 行 of 列(`${年}年${月}月${日}日`)) 和.add(行);
    if (年 === 尾[0] && 月 === 尾[1] && 日 === 尾[2]) return 和;
    日 += 1;
    const 末日 = new Date(Date.UTC(年, 月, 0)).getUTCDate();
    if (日 > 末日) {
      日 = 1;
      月 += 1;
      if (月 > 12) {
        月 = 1;
        年 += 1;
      }
    }
  }
}

function 案内(語: string): string[] {
  const 関数 = (Recommender as unknown as Record<string, (語: string, 時刻: number) => string[]>)
    .relativeDayNotes;
  return 関数(語, 基準);
}

describe("暦日を名乗ったまでに", () => {
  it("今日からその日までの幅として受ける（その年の日幅と対称差 0）", () => {
    for (const [語, 尾] of [
      ["8月22日までに", [2026, 8, 22]],
      ["8月20日までに", [2026, 8, 20]],
      ["9月1日までに", [2026, 9, 1]],
      ["9月30日までに", [2026, 9, 30]],
    ] as const) {
      const 幅 = 日の幅和([2026, 8, 9], 尾);
      expect(列(語).size, `${語} が行を出さない`).toBeGreaterThan(0);
      expect(対称差(列(語), 幅), `${語} が其の年の日幅と違う列表`).toBe(0);
    }
  });

  it("年を名乗った形・区切りの形・`まで` だけの形も同じ幅", () => {
    expect(対称差(列("2026年8月22日までに"), 列("8月22日までに"))).toBe(0);
    expect(対称差(列("2026-08-22までに"), 列("8月22日までに"))).toBe(0);
    expect(対称差(列("8月22日まで"), 列("8月22日までに"))).toBe(0);
    expect(対称差(列("2026-08-22まで"), 列("8月22日までに"))).toBe(0);
  });

  it("区切りの日付に繋げた形は語に割れず、同じ幅になる（案内が出て行が一もない形にしない）", () => {
    expect(対称差(列("8/22までに"), 列("8月22日までに"))).toBe(0);
    expect(対称差(列("8/22まで"), 列("8月22日までに"))).toBe(0);
    expect(列("8/22までに").size, "`8/22までに` が行を出さない").toBeGreaterThan(0);
    /* 語の区切りとしての `/` は其侭動く（その方の語を繋げた形は寄せない）。 */
    expect(対称差(列("8/22締切"), 列("8月22日 締切"))).toBe(0);
  });

  it("件数欄に幅の両端を書く（当たり方と案内が食い違わない）", () => {
    expect(案内("8月22日までに")).toEqual([
      "8月22日までに = 2026年8月9日(日)〜8月22日(土)の締切 – 行に書かれた他の日付（別の締切ラウンド・会期）でも当たるので、締切日からの日数で絞る「締切まで」の欄が確かです",
    ]);
  });

  it("その年にもう過ぎてる日は明年へ繰り上げ、その事を案内に書く", () => {
    expect(案内("6月1日までに")).toEqual([
      "6月1日までに = 2026年8月9日(日)〜2027年6月1日(火)の締切 – 行に書かれた他の日付（別の締切ラウンド・会期）でも当たるので、締切日からの日数で絞る「締切まで」の欄が確かです",
    ]);
    expect(列("6月1日までに").size, "繰り上げた幅が行を出さない").toBeGreaterThan(0);
  });

  it("年まで名乗って過ぎてる日はその日だけで受ける（過ぎた方を無視した幅にしない）", () => {
    expect(案内("2025年8月22日までに")).toEqual([
      "2025年8月22日までに = 2025年8月22日(金)の締切（その日は過ぎています – 「過去の締切も表示」を付けると並びます）",
    ]);
    expect(対称差(列("2025年8月22日までに"), 列("2025年8月22日"))).toBe(0);
  });

  it("その年の形だけを出す（他の年の同じ月日を混ぜない – 案内が書く幅と揃える）", () => {
    /* 年を付けない形（`8月14日`）を混ぜると、実ビルドでは USENIX Security 2027 の
     * 要旨締切の 5 行が入って、案内の「2026年8月9日(日)〜8月22日(土)」と食い違う。 */
    expect(対称差(列("8月22日までに"), 日の幅和([2026, 8, 9], [2026, 8, 22]))).toBe(0);
    /* それに対し相対語の幅は年を付けない形も混ぜる（此処では変えない – 別の回の話）。 */
    const 相対和 = new Set<string>([
      ...列("2026年8月9日"),
      ...列("8月9日"),
      ...列("2026年8月10日"),
      ...列("8月10日"),
    ]);
    expect(対称差(列("明日までに"), 相対和)).toBe(0);
    expect(相対和.size, "品書に相対日の行がない").toBeGreaterThan(0);
  });

  it("他の語と繋げた形は幅と語の両方を掛けた物になる", () => {
    const 幅 = 列("8月22日まで");
    const 語 = 列("締切");
    const 掛 = new Set([...幅].filter((行) => 語.has(行)));
    expect(対称差(列("8月22日までに締切"), 掛)).toBe(0);
    expect(対称差(列("8月22日までに 締切"), 掛)).toBe(0);
    expect(掛.size, "品書にその方の締切の行がない").toBeGreaterThan(0);
    expect(列("8月22日までに 穴場").size).toBeLessThanOrEqual(列("穴場").size);
  });

  it("月・週末・曜日を名乗った『まで』は今まで通りその方の語に寄せる", () => {
    expect(対称差(列("8月まで"), 列("8月"))).toBe(0);
    expect(列("8月").size, "品書にその月の行がない").toBeGreaterThan(0);
    expect(対称差(列("金曜まで"), 列("金曜"))).toBe(0);
    expect(対称差(列("週末まで"), 列("週末"))).toBe(0);
    expect(対称差(列("今月末まで"), 列("今月末"))).toBe(0);
    /* 相対語の幅は今まで通り（その方の形は年を付けない形も混ぜる – 別の回の話）。 */
    expect(列("明日までに").size, "品書に相対日の行がない").toBeGreaterThan(0);
    expect(列("来週までに").size, "品書に週の行がない").toBeGreaterThan(0);
  });

  it("決まらない形は解かない（締切の推測はしない）", () => {
    /* 月を決めない裸の日は寄せない – その打ち方は今まで通り 0 行。 */
    expect(列("3日までに")).toEqual(new Set());
    expect(案内("3日までに")).toEqual([]);

    expect(対称差(列("8月22日頃までに"), 列("8月22日までに"))).toBe(0);
    expect(
      案内("8月22日頃までに").length,
      "位の付いた『までに』が案内を黙らせた侭",
    ).toBeGreaterThan(0);
    /* 「迄」の字は第 404 回からその方の仮名に寄せる（実測でそれ迄 0 行・案内も無し –
     * その方の字を書く収録行は 0 件なので、行の表記は変らない）。 */
    expect(対称差(列("8月22日迄に"), 列("8月22日までに"))).toBe(0);
    expect(案内("8月22日迄に").length, "漢字の『迄』が案内を黙らせた侭").toBeGreaterThan(0);
  });
});

describe("成果物", () => {
  it("暦日のまでにがその年の幅を決める処が実測どおりに成果物に入っている", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/const 暦 = head \? 暦日に解くJa\(head\[1\]\) : null;/g) ?? []).toHaveLength(1);
    /* 成果物では `return null;` が次の行に割れるので、目印は if の所まで。 */
    expect(物.match(/if \(!stem && !pressed && !暦 && !位の解\)/g) ?? []).toHaveLength(1);
    expect(
      物.match(
        /const 年付きのみ = 暦 !== null \|\| 数値 !== null \|\| pressedMonthDay !== null \|\| 位の解 !== null;/g,
      ) ?? [],
    ).toHaveLength(1);
    /* `までに` を割らない決まりは語の末尾に付いた時だけ（後に語が控える形は二語に割る）。 */
    expect(物.match(/\/までに\$\/\.test\(token\)/g) ?? []).toHaveLength(1);

    expect(物).toContain(
      'if (暦日に境界を続けた形Ja(String(token || "")))\n                return true;',
    );
    /* 期日までの言い方から数値で書いた暦日を落とした（月・週末・曜日だけ寄せる）。 */
    /* 期日までの言い方に入った語は月・週末・曜日だけ – 数値で書いた暦日は其処に在らない
     * （その方の語は `untilDayTermsJa` が幅に解く）。`いっぱいの言い方` は別の規則なので、
     * 同じ語列を持っても良い – 此処はその方の行を張る。 */
    expect(物, "期日までの言い方から数値で書いた暦日を落としていない").toContain(
      /* 第 463 回 – 語尾 `まで` の前の空格を受ける目を足した（`8 月 まで`）。 */
      "期日までの言い方 = /((?:0?[1-9]|1[0-2])月末?|(?<!週)(?:[月火水木金土日]曜(?:日)?|平日)|(?<!週)(?<![今来先再])週末)[ \\u3000]*まで/g;",
    );
  });
});
