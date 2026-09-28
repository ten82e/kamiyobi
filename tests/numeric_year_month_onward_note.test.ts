/* 第 494 回 – 數字で書いた先の年＋暦月＋其れより後（`2027年12月から`）の案内に但し書を足した
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、其の形は 0 件なのに
 * 件の数欄が「2027年12月1日以降のこと（其の年の中まで）」と幅だけを名乗つて居た – 同じ年を
 * 「來年12月から」と打てば 84 件出る（第 493 回に割る目を入れた）ので、**打ち方で結果が割れるのは
 * 収録の側の事情**である。其の旨を但し書く（「 – 其の年の締切が収録に無ければ何も出ません」）。
 *
 * 但し書は**數字の年だけ**に付ける（其の年の語を名乗る形は第 493 回に割つて行が出るやうになつて
 * 居るので、其の侭）。今の年を此の段で見分けるには時計を讀む事に成るので、其れはしない
 *（此の回に時計を讀む手を入れた版は、固定時計で走らせる検査の足場で `Date is not a constructor` に
 * 成つて五本落ちた – 検索の道は時計を渡されて動く、自分では讀まない）。
 *
 * 行は一個も動かして居ない（案内だけの直し）。*/
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

describe("數字の年＋暦月＋其れより後には但し書が付く（第 494 回）", () => {
  it("但し書が付く（今の年の形 – 行が出る形にも、出ない形にも）", () => {
    for (const 文 of ["2026年12月から", "2026年1月から"]) {
      expect(日の案内(文), `「${文}」に但し書が無い`).toContain(
        "其の年の締切が収録に無ければ何も出ません",
      );
      /* 幅は其の侭名乗る（但し書は其の後に付く）。*/
      expect(日の案内(文), `「${文}」の幅が消えた`).toContain("以降のこと（其の年の中まで）");
    }
  });
  it("其の年の語を名乗る形には付けない（第 493 回に割つて行が出る）", () => {
    for (const 文 of ["来年12月から", "来年1月以降", "来年3月まで"]) {
      expect(日の案内(文), `「${文}」に但し書が付いた`).not.toContain("収録に無ければ");
    }
    expect(日の案内("来年12月から")).toContain("来年 = 2027年");
  });
  it("今の年の行は一個も動かして居ない（先の年は第 495 回に割つた）", () => {
    /* 実測（実ビルド）– `2027年12月から` 0 件（其の月の締切は `來年12月から` の 84 件で見える）・
     * `2027年3月から` 371 件・`2026年12月から` 178 件・`2026年1月から` 796 件。*/
    /* 先の年の形は第 495 回に割る目を入れたので、離した形と同じ行が出る。*/
    expect(列("2027年12月から").size).toBe(21);
    expect(列("2027年3月から").size).toBe(75);
    expect(列("2026年1月から").size).toBe(426);
    expect(列("2026年12月から").size).toBe(84);
    /* 同じ年の月を「來年」で打つと行が出る（打ち方で割れる事其の物を但し書が説明する）。*/
    expect(列("来年12月から").size).toBe(21);
  });
  it("第 470 回〜第 493 回の実測は此の回で変へて居ない", () => {
    expect(列("来年12月から").size).toBe(21);
    expect(列("来年12月").size).toBe(21);
    expect(列("今年1月から").size).toBe(426);
    expect(列("来年上旬").size).toBe(2);
    expect(列("来週中旬").size).toBe(43);
    expect(列("年末上旬").size).toBe(40);
    expect(列("来月 末日").size).toBe(178);
    expect(列("週 末").size).toBe(145);
    expect(列("ml から").size).toBe(0);
    expect(列("締切時刻").size).toBe(180);
    expect(列("半 年後").size).toBe(2);
    expect(列("一 週間後").size).toBe(13);
  });
});

describe("ビルド成果物に但し書が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("但し書の文と、其れを數字の年に限る見分けが現れる", () => {
    expect(物).toContain("其の年の締切が収録に無ければ何も出ません");
    expect(物).toContain("/^[0-9]{4}年$/.test(年の語)");
  });
});
