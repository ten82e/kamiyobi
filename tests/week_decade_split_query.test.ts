/* 第 490 回 – 週の語に旬を直に繋いだ形（`来週中旬` `今週上旬` `再来週半ば`）
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、繋いだ側は 0 件で
 * 案内を出し、離した側は通つて居た – `来週中旬` **0 件**（案内付き）⇔ `来週 中旬` 52 件・
 * `来週上旬` **0 件** ⇔ 4 件・`来週初旬` **0 件** ⇔ 4 件・`来週中頃` **0 件** ⇔ 52 件・
 * `来週中盤` **0 件** ⇔ 52 件・`来週半ば` **0 件** ⇔ 52 件・`今週上旬` **0 件** ⇔ 21 件・
 * `今週初旬` **0 件** ⇔ 21 件・`先週上旬` **0 件** ⇔ 16 件・`再来週中旬` **0 件** ⇔ 25 件・
 * `再来週下旬` **0 件** ⇔ 24 件。
 *
 * 第 416 回は『其の週の中のまとまりは絞り込まない』として案内を出して居たが、旬（上旬・中旬・下旬）
 * は**其の月の十一日から二十日と言ふ公用の決まりを持つ語**で、週と交はらせても幅は一つに決まる
 * （其の方が既に二語で解ける形に揃べる – 第 453 回）。其の爲、案内の列からは旬を外し、**公用の
 * 決まりの無い前半・後半だけ**を案内に殘した（`来週 前半` 0 件・`来週 後半` 0 件 – 離して打つても
 * 行が出ないので、行を減らす直しにはならない）。
 *
 * 週の中の位置（頭・初め・終わり・末日）は第 431 回・第 483 回の侭で案内を出す（曜日を指す人と
 * 其の週の几日かを指す人が居る – 一通に決まらない）。*/
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
function 画面案内(文: string) {
  return (Recommender.uiWordNoteJa(文) || "").trim();
}

describe("週の語に旬を直に繋いだ形が其の週 × 其の旬に解れる（第 490 回）", () => {
  it("繋いだ形が離した形と同じ行・同じ案内になる（十五對）", () => {
    const 対: Array<[string, number]> = [
      ["来週中旬", 43],
      ["来週上旬", 2],
      ["来週初旬", 2],
      ["来週中頃", 43],
      ["来週中盤", 43],
      ["来週半ば", 43],
      ["今週上旬", 4],
      ["今週初旬", 4],
      ["再来週中旬", 12],
      ["再来週下旬", 9],
      ["先週上旬", 5],
    ];
    for (const [繋, 件] of 対) {
      /* 「再来週」のやうに頭が三文字の物も在るので、週の字で割る。*/
      const 離 = 繋.replace(/^(.+?週)(.+)$/, "$1 $2");
      expect([繋, 対称差(列(繋), 列(離))]).toEqual([繋, 0]);
      expect([繋, 画面案内(繋)]).toEqual([繋, 画面案内(離)]);
      /* 検査用ビルドの件数（実ビルド 868 行の値は頭の註に記す）。*/
      expect([繋, 列(繋).size]).toEqual([繋, 件]);
      /* 案内（絞り込めません）は出さない – 其の週の幅を名乗る案内は出る。*/
      expect(画面案内(繋), `「${繋}」に絞り込めぬ案内が並んだ`).not.toContain("絞り込めません");
    }
  });
  it("其の月の旬に化けない（週と交はつた分だけ少ない）", () => {
    expect(列("中旬").size).toBeGreaterThan(0);
    expect(列("来週中旬").size).toBeLessThan(列("中旬").size);
    /* 過ぎた週は行が無いのが正しい（既定で過ぎた締切を除く）。*/
    expect(列("先週中旬").size).toBe(列("先週 中旬").size);
  });
  it("語尾が控へる形も同じ（第 487 回〜第 489 回と同じ測り方）", () => {
    for (const 繋 of ["来週中旬に", "来週中旬 締切", "再来週下旬まで"]) {
      const 離 = 繋.replace("週", "週 ").replace("旬", "旬 ");
      expect([繋, 対称差(列(繋), 列(離))]).toEqual([繋, 0]);
    }
    expect(列("来週中旬に").size).toBe(43);
  });
});

describe("案内が殘る形は其の侭（第 416 回・第 431 回・第 483 回）", () => {
  it("公用の決まりの無い前半・後半と、週の中の位置", () => {
    for (const 文 of ["来週前半", "来週後半"]) {
      expect(列(文).size, `「${文}」に行が出た`).toBe(0);
      expect(画面案内(文), `「${文}」の案内が消えた`).toContain("週の語に前半・後半を繋げても");
    }
    for (const 文 of ["来週頭", "来週末日", "来週始め"]) {
      expect(列(文).size, `「${文}」に行が出た`).toBe(0);
      expect(画面案内(文), `「${文}」の案内が消えた`).toContain("週の語に頭や終わりを繋げても");
    }
    /* 離して打つても行が出ない（案内の殘る形が行を持つ形ではない事 – 行を減らす直しではない）。*/
    for (const 文 of ["来週 前半", "来週 後半"]) expect(列(文).size).toBe(0);
  });
  it("第 470 回〜第 489 回の実測は此の回で変へて居ない", () => {
    expect(列("来年上旬").size).toBe(2);
    expect(列("来年度上旬").size).toBe(0);
    expect(列("来年度3月").size).toBe(1);
    expect(列("来年12月").size).toBe(21);
    /* 第 493 回に先の年の語を割る目を入れたので、離した形と同じ行が出る。*/
    expect(列("来年12月から").size).toBe(21);
    expect(列("来年12月から").size).toBe(列("来年 12月から").size);
    expect(列("来月初め").size).toBe(0);
    expect(列("来月末").size).toBe(178);
    expect(列("週 末").size).toBe(145);
    expect(列("来週 末").size).toBe(34);
    expect(列("明日以降").size).toBe(422);
    expect(列("来 上旬").size).toBe(68);
    expect(列("締切時刻").size).toBe(180);
    expect(列("半 年後").size).toBe(2);
    expect(列("一 週間後").size).toBe(13);
    expect(列("ml から").size).toBe(0);
    expect(列("今年1月から").size).toBe(426);
  });
});

describe("ビルド成果物に目が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("週の語＋旬の目が在り、案内の列から旬が外れて居る", () => {
    expect(物).toContain(
      "(?:今|来|先|再来|再々|翌|去|前|昨)週)(?:の)?[ \\u3000]*(上旬|中旬|下旬|初旬|中頃|中盤|半ば)/g,",
    );
    /* 案内の列（週の位）は前半・後半だけ。*/
    expect(物).toContain("(?:前半|後半)(?:に)?$/;");
    expect(物).toContain("週の語に前半・後半を繋げても");
  });
});
