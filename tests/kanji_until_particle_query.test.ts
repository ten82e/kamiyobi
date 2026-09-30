/**
 * 漢字の「迄」で打たれた『まで』形（第 404 回）。
 *
 * 実測（2026-09-29 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻
 * 2026-08-09T00:00:00Z）: 仮名で打てば通る（`明日までに` 5 行・`8月22日までに` 89 行・
 * `来月上旬までに` 268 行・`3日後までに` 11 行）のに、同じ頼み方を漢字で打つと全部 0 行で
 * 案内も無かつた（`明日迄に` **0 行**・`明日迄` **0 行**・`8月22日迄に` **0 行**・
 * `来週火曜迄に` **0 行**・`来月10日迄に` **0 行**・`来月上旬迄に` **0 行**・
 * `3日後迄に` **0 行**）。其の方の字を書く収録行は 0 件なので、行の表記は変らない。
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

function 対称差(甲: Set<string>, 乙: Set<string>): number {
  return [...甲].filter((行) => !乙.has(行)).length + [...乙].filter((行) => !甲.has(行)).length;
}

function 案内(語: string): string {
  const 関数 = Recommender as unknown as Record<string, (語: string, 時刻: number) => string[]>;
  const 相対 = 関数.relativeDayNotes(語, 基準);
  if (相対.length) return 相対[0];
  return (Recommender.dayRangeLiveNoteJa(語) as unknown as string) || "";
}

describe("漢字の『迄』で打った締切の頼み方", () => {
  it("其の方の仮名で打った形と同じ行集合になる", () => {
    let 当たりの計 = 0;
    for (const [漢字, 仮名] of [
      ["明日迄に", "明日までに"],
      ["明日迄", "明日までに"],
      ["明後日迄に", "明後日までに"],
      ["昨日迄に", "昨日までに"],
      ["今日迄に", "今日までに"],
      ["来週迄に", "来週までに"],
      ["来週火曜迄に", "来週火曜までに"],
      ["今週金曜迄に", "今週金曜までに"],
      ["8月22日迄に", "8月22日までに"],
      ["8月22日迄", "8月22日までに"],
      ["2026年8月22日迄に", "2026年8月22日までに"],
      ["8/22迄に", "8月22日までに"],
      ["来月10日迄に", "来月10日までに"],
      ["今月15日迄に", "今月15日までに"],
      ["3日後迄に", "3日後までに"],
      ["1週間後迄に", "1週間後までに"],
      ["1か月後迄に", "1か月後までに"],
      ["来月上旬迄に", "来月上旬までに"],
      ["今月下旬迄に", "今月下旬までに"],
      ["明日頃迄に", "明日頃までに"],
      ["来月10日頃迄に", "来月10日頃までに"],
    ] as Array<[string, string]>) {
      expect(対称差(列(漢字), 列(仮名)), `「${漢字}」が \`${仮名}\` と違う列表`).toBe(0);
      当たりの計 += 列(漢字).size;
    }
    /* ハーネスの品書は実ビルドの品書（872 行）より小さいので其の方の語で立つ形が其處に
     * 無い事が有る – 空の一致ばかりにならないやうに、何れかで行が出る事を併せて張る。 */
    expect(当たりの計, "其の方の仮名で打つと行が出る組が一つも当たりを出さない").toBeGreaterThan(0);
  });

  it("幅の語の後に続けた形も同じ", () => {
    for (const [漢字, 仮名] of [
      ["8月10日から8月20日迄", "8月10日から8月20日までに"],
      ["明日から明後日迄", "明日から明後日"],
    ] as Array<[string, string]>) {
      expect(列(漢字).size, `「${漢字}」が行を出さない`).toBeGreaterThan(0);
      expect(対称差(列(漢字), 列(仮名)), `「${漢字}」が \`${仮名}\` と違う列表`).toBe(0);
    }
  });

  it("件数欄は其の日までの幅であることを言う", () => {
    expect(案内("明日迄に").indexOf("2026年8月9日(日)〜8月10日(月)の締切") >= 0).toBe(true);
    expect(案内("来月上旬迄に").indexOf("2026年8月9日(日)〜9月10日(木)の締切") >= 0).toBe(true);
  });

  it("過去方向に開いた幅は漢字でも解かない（締切の推測はしない）", () => {
    /* 第 367 回の決まり – `3日前までに` は解かない – 漢字で打った形も同じ。 */
    for (const [漢字, 仮名] of [
      ["3日前迄に", "3日前までに"],
      ["1か月前迄に", "1か月前までに"],
      ["昨日迄に締切", "昨日までに締切"],
    ] as Array<[string, string]>) {
      expect(対称差(列(漢字), 列(仮名)), `「${漢字}」が \`${仮名}\` と違う列表`).toBe(0);
    }
    expect(列("3日前迄に"), "『3日前迄に』が行を出している（過去方向の幅は解かない）").toEqual(
      new Set(),
    );
  });

  it("其の日を決めない語に続けた形も行を変えない", () => {
    for (const [漢字, 仮名] of [
      ["今迄", "今まで"],
      ["ここ迄", "ここまで"],
      ["受付迄に", "受付までに"],
      ["締切迄に", "締切までに"],
      ["迄", "まで"],
    ] as Array<[string, string]>) {
      expect(対称差(列(漢字), 列(仮名)), `「${漢字}」が \`${仮名}\` と違う列表`).toBe(0);
    }
  });
});

describe("行の表記", () => {
  it("品書に『迄』を書く行は無く、折込で行の文字は変らない", () => {
    const 品 = (
      Recommender.candidateRows(
        JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
      ) as unknown as Array<{ hay: string }>
    ).map((行) => String(行.hay));
    expect(品.filter((行) => 行.indexOf("迄") >= 0)).toEqual([]);
    /* 其の方の字を通す前の略字の折込（`〆`）は其の侭効いて居る。 */
    expect(品.filter((行) => 行.indexOf("締切") >= 0).length).toBeGreaterThan(0);
  });
});

describe("舊字体で打つ人（第 589 回）", () => {
  it("新字体で打った人と同じ行集合になる", () => {
    // 實測（2026-11-15 – 実ビルドの品書 700 件）: 舊字体の打ち方は 0 件の侭畫面无言だつた。
    // 収録の文字列に舊字体は進んで居らんので、折込は打つ人の方だけ到新字体に寄せる。
    for (const [舊, 新] of [
      ["學會", "学会"],
      ["發表", "発表"],
      ["處理", "処理"],
      ["登錄", "登録"],
      ["登錄", "登録"],
      ["錄", "録"],
      ["檢查", "検査"],
    ]) {
      expect(対称差(列(舊), 列(新)), `${舊} と ${新}`).toBe(0);
    }
    // 寄せが 실제로行を増やして居る事（0 對 0 の空振りで通さん）。
    expect(列("學會").size).toBeGreaterThan(0);
    expect(列("處理").size).toBeGreaterThan(0);
    expect(列("登錄").size).toBeGreaterThan(0);
    expect(列("錄").size).toBeGreaterThan(0);
  });
});

describe("成果物", () => {
  it("折込の表に『迄』が入つている", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/迄: "まで",/g) ?? []).toHaveLength(1);
    // 第 589 回で舊字体を十五字增やしたので、文字種の列は改行付きの形に變はつた。
    expect(物).toMatch(
      /KANJI_VARIANT_FOLD_CHARS =\s*\n?\s*\/\[〆迄會學發檢對經應圖實單處數讓歸錄\]\/g;/,
    );
    /* 略字の折込は其の侭残る。 */
    expect(物.match(/〆: "締",/g) ?? []).toHaveLength(1);
  });
});
