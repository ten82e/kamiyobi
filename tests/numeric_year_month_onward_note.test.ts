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
function 日の案内(文: string) {
  return (Recommender.relativeDayNotes(文, 基準) || []).join("|");
}

describe("数字の年＋暦月＋それより後には但し書が付く（第 494 回）", () => {
  it("但し書が付く（今の年の形 – 行が出る形にも、出ない形にも）", () => {
    for (const 文 of ["2026年12月から", "2026年1月から"]) {
      expect(日の案内(文), `「${文}」に但し書が無い`).toContain(
        "其の年の締切が収録に無ければ何も出ません",
      );
      /* 幅はその侭名乗る（但し書はその後に付く）。*/
      expect(日の案内(文), `「${文}」の幅が消えた`).toContain("以降のこと（其の年の中まで）");
    }
  });
  it("その年の語を名乗る形には付けない（第 493 回に割つて行が出る）", () => {
    for (const 文 of ["来年12月から", "来年1月以降", "来年3月まで"]) {
      expect(日の案内(文), `「${文}」に但し書が付いた`).not.toContain("収録に無ければ");
    }
    expect(日の案内("来年12月から")).toContain("来年 = 2027年");
  });
  it("今の年の行は一個も動かして居ない（先の年は第 495 回に割つた）", () => {
    /* 実測（実ビルド）– `2027年12月から` 0 件（その月の締切は `來年12月から` の 84 件で見える）・
     * `2027年3月から` 371 件・`2026年12月から` 178 件・`2026年1月から` 796 件。*/
    /* 先の年の形は第 495 回に割る目を入れたので、離した形と同じ行が出る。*/
    expect(列("2027年12月から").size).toBe(21);
    expect(列("2027年3月から").size).toBe(76);
    expect(列("2026年1月から").size).toBe(427);
    expect(列("2026年12月から").size).toBe(84);
    /* 同じ年の月を「來年」で打つと行が出る（打ち方で割れる事その物を但し書が説明する）。*/
    expect(列("来年12月から").size).toBe(21);
  });
  it("第 470 回〜第 493 回の実測はこの回で変へて居ない", () => {
    expect(列("来年12月から").size).toBe(21);
    expect(列("来年12月").size).toBe(21);
    expect(列("今年1月から").size).toBe(427);
    expect(列("来年上旬").size).toBe(2);
    expect(列("来週中旬").size).toBe(43);
    expect(列("年末上旬").size).toBe(40);
    expect(列("来月 末日").size).toBe(178);
    expect(列("週 末").size).toBe(146);
    expect(列("ml から").size).toBe(0);
    expect(列("締切時刻").size).toBe(181);
    expect(列("半 年後").size).toBe(2);
    expect(列("一 週間後").size).toBe(13);
  });
});

describe("ビルド成果物に但し書がある事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("但し書の文と、それを数字の年に限る見分けが現れる", () => {
    expect(物).toContain("其の年の締切が収録に無ければ何も出ません");
    expect(物).toContain("/^[0-9]{4}年$/.test(年の語)");
  });
});
