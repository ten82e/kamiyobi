/* 第 491 回 – 月の語・年の語に其の切れ目を**離して**打つた形（`来月 末日` `来月 後半` `来年 末`）
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、詰め形は通るのに
 * 離して打つと 0 件だつた（逆の隔たり – 第 483 回〜第 490 回は「詰めると 0 件」を直した）–
 * `来月末日` 245 件 ⇔ `来月 末日` **0 件**・`来月後半` 86 件 ⇔ `来月 後半` **0 件**・`今月末日` 192 ⇔
 * **0**・`今月後半` 92 ⇔ **0**・`先月末日` 52 ⇔ **0**・`先月後半` 26 ⇔ **0**・`再来月末日` 194 ⇔ **0**・
 * `再来月終わり` 194 ⇔ `再来月 終わり` **0**・`再来月後半` 68 ⇔ **0**・`来年末` 84 ⇔ `来年 末` **0**・
 * `今年末` 178 ⇔ `今年 末` **0**・`来年始め` 99 ⇔ `来年 始め` **0**・`今年始め` 38 ⇔ `今年 始め` **0**。
 *
 * 直しは、其の段で一語に揃へるのではなく、**其の方の表が既に持つ語へ寄せる**形にした（第 491 回 –
 * 月の末尾を決める段は語の割りの前に在るので、揃へた語は其処を通らない – 第 462 回に實測）。
 * 寄せ先と對称差 0 を實測で確かめた – 末日・終わり → 末（`来月末日` 245 = `来月末` 245）・
 * 後半 → 下旬（`来月後半` 86 = `来月 下旬` 86）・年末 → 12月（`来年末` 84 = `来年 12月` 84）・
 * 年始め → 1月（`来年始め` 99 = `来年 1月` 99）。年の語の側は、後に語が続く形
 * （`今年 初めての締切`）を壊さないやうに語尾の後ろを見る。
 *
 * 「前半」は何日から何日かの公用の決まりが無いので、離しても詰めても 0 件の侭（第 390 回・第 483 回）。*/
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
function 案内(文: string) {
  return `${(Recommender.uiWordNoteJa(文) || "").trim()}|${(Recommender.relativeDayNotes(文, 基準) || []).join("/")}`;
}

describe("月の語・年の語に切れ目を離して打つた形が詰め形と同じ行に出る（第 491 回）", () => {
  it("月の語＋末日・終わり（検査用ビルドの件數 – 実ビルドの値は頭の註）", () => {
    for (const [離, 件] of [
      ["来月 末日", 178],
      ["今月 末日", 118],
      ["先月 末日", 11],
      ["再来月 末日", 97],
      ["再来月 終わり", 97],
      ["8月 終わり", 118],
      ["1月 終わり", 23],
      ["3月 終わり", 28],
      ["12月 終わり", 84],
    ] as Array<[string, number]>) {
      const 詰 = 離.replace(/[ \u3000]+/g, "");
      expect([離, 対称差(列(離), 列(詰))], `「${離}」が「${詰}」と違ふ`).toEqual([離, 0]);
      expect([離, 列(離).size]).toEqual([離, 件]);
      expect([離, 案内(離)]).toEqual([離, 案内(詰)]);
    }
  });
  it("月の語＋後半は下旬に寄る（何日の幅かは同じ – 第 390 回）", () => {
    for (const [離, 詰, 件] of [
      ["来月 後半", "来月後半", 59],
      ["今月 後半", "今月後半", 58],
      ["先月 後半", "先月後半", 6],
      ["再来月 後半", "再来月後半", 33],
    ] as Array<[string, string, number]>) {
      expect([離, 対称差(列(離), 列(詰))]).toEqual([離, 0]);
      expect([離, 列(離).size]).toEqual([離, 件]);
      expect([離, 対称差(列(離), 列(離.replace("後半", "下旬")))], `「${離}」が下旬と違ふ`).toEqual(
        [離, 0],
      );
    }
  });
  it("年の語＋末・始めも詰め形と同じ行に出る", () => {
    for (const [離, 詰, 件] of [
      ["来年 末", "来年末", 21],
      ["今年 末", "今年末", 84],
      ["来年 始め", "来年始め", 23],
      ["今年 始め", "今年始め", 15],
    ] as Array<[string, string, number]>) {
      expect([離, 対称差(列(離), 列(詰))]).toEqual([離, 0]);
      expect([離, 列(離).size]).toEqual([離, 件]);
    }
    /* 寄せ先は其の方の表の語（年末 → 12月・年始め → 1月 – 第 484 回）。*/
    expect(対称差(列("来年 末"), 列("来年 12月"))).toBe(0);
    expect(対称差(列("来年 始め"), 列("来年 1月"))).toBe(0);
  });
  it("仲介の『の』や語尾が続く形も同じ", () => {
    for (const [離, 詰] of [
      ["来月 の 末日", "来月末日"],
      ["来年 の 末", "来年末"],
      ["来月 末日に", "来月末日に"],
      ["来月 後半から", "来月後半から"],
    ] as Array<[string, string]>) {
      expect([離, 対称差(列(離), 列(詰))]).toEqual([離, 0]);
      expect(列(離).size > 0, `「${離}」が未だ 0 件`).toBe(true);
    }
  });
});

describe("壊してはならない形（第 390 回・第 466 回・第 490 回）", () => {
  it("公用の決まりの無い前半は 0 件の侭（離しても詰めても）", () => {
    for (const 文 of ["来月 前半", "来月前半", "今月 前半", "来年 前半"]) {
      expect([文, 列(文).size]).toEqual([文, 0]);
    }
    expect(String(Recommender.uiWordNoteJa("来月 前半") ?? "").trim()).toBe("");
  });
  it("後に語が続く形を壊して居ない（語尾の後ろを見る）", () => {
    /* 第 484 回に年の語＋初/末を詰め形で寄せた時と同じ守り。`今年 初めての締切` を
     * `今年 1月めての締切` に化けさせない。*/
    expect(列("今年 初めての締切").size).toBe(0);
    expect(列("今年 初").size).toBe(0);
    expect(列("年末 末").size).toBe(0);
  });
  it("第 470 回〜第 490 回の実測は此の回で変へて居ない", () => {
    expect(列("週 末").size).toBe(145);
    expect(列("来週 末").size).toBe(34);
    expect(列("来月末").size).toBe(178);
    expect(列("来月 末").size).toBe(178);
    expect(列("来月初め").size).toBe(0);
    expect(列("締切時刻").size).toBe(180);
    expect(列("ml から").size).toBe(0);
    expect(列("来年度末").size).toBe(1);
    expect(列("来年度 末").size).toBe(1);
    expect(列("再来月 終わり").size).toBe(97);
    expect(列("来年12月から").size).toBe(0);
    expect(列("今年1月から").size).toBe(426);
    expect(列("来年 12月").size).toBe(21);
    expect(列("来年上旬").size).toBe(2);
    expect(列("来週中旬").size).toBe(43);
    expect(列("半 年後").size).toBe(2);
  });
});

describe("ビルド成果物に目が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("末日・終わり→末、後半→下旬、年末→12月、年始め→1月の寄せが現れる", () => {
    for (const 語 of ['"$1$2月末"', '"$1$2月下旬"']) {
      expect(物.split(語).length - 1, `寄せ先「${語}」の數`).toBe(1);
    }
    /* 「$1$2 12月」 と 「$1$2 1月」 は第 484 回の年の語の目（詰め形）も出すので二つ在る –
     * 同じ寄せ先に落ちるので行は動かない（對称差 0 を上の張りで見て居る）。*/
    for (const 語 of ['"$1$2 12月"', '"$1$2 1月"']) {
      expect(物.split(語).length - 1, `寄せ先「${語}」の數`).toBe(2);
    }
    expect(物).toContain("末日|末)(?![぀-ヿ一-龥])");
    expect(物).toContain("(初め|始め)(?![぀-ヿ一-龥])");
  });
});
