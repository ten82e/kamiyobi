/**
 * 日付と締切の語を**繋げて**打つ形（`8月22日締め`）・「まで」「いっぱい」で期間を言う形
 * （`8月まで` `今月いっぱい`）・「締切未定」系の検査（SPEC §4・§7・第 346 回）。
 * 実測（2026-10-04 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `8月22日` 12 行・`8月22日 締切` 11 行・`8月` 210 行・`今月` 189 行・`来週` 53 行・`未定` 6 行・
 * `締切 未定` 4 行が通るのに、`8月22日締め` **0 行**・`12月19日締切` **0 行**・
 * `令和8年8月22日締め` **0 行**・`8月まで` **0 行**・`今月いっぱい` **0 行**・`締切未定` **0 行**・
 * `期限未定` **0 行**だった。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { jsFunction } from "./runtime_extract.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 行列表(語: string): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
  const matches = Recommender.searchMatcher(語, 基準);
  return rows.filter((row) => matches(String(row.hay)) === true);
}

function 対称差(a: string, b: string): number {
  const x = new Set(行列表(a).map((r) => r.hay));
  const y = new Set(行列表(b).map((r) => r.hay));
  return [...x].filter((k) => !y.has(k)).length + [...y].filter((k) => !x.has(k)).length;
}

function 全案内(語: string): string {
  return [
    Recommender.querySynonymNotes(語).join(" "),
    Recommender.uiWordNoteJa(語),
    Recommender.uiWordLiveNoteJa(語),
    Recommender.relativeDayNotes(語, 基準).join(" "),
  ]
    .filter((文) => 文)
    .join(" / ");
}

describe("日付に締切の語を繋げて打つ形", () => {
  it("`8月22日締め` `8月22日締切` は空格で打つのと同じ行を出す", () => {
    expect(行列表("8月22日 締切").length, "対照の `8月22日 締切` が 0 行").toBeGreaterThan(0);
    expect(
      対称差("8月22日締め", "8月22日 締切"),
      "`8月22日締め` が `8月22日 締切` と違う行を出した",
    ).toBe(0);
    expect(
      対称差("8月22日締切", "8月22日 締切"),
      "`8月22日締切` が `8月22日 締切` と違う行を出した",
    ).toBe(0);
    const 日付 = new Set(行列表("8月22日").map((r) => r.hay));
    const 締切 = new Set(行列表("締切").map((r) => r.hay));
    行列表("8月22日締め").forEach((行) => {
      expect(日付.has(String(行.hay)), "其の日付で無い行を出した").toBe(true);
      expect(締切.has(String(行.hay)), "『締切』を書かない行を出した").toBe(true);
    });
    const 案内 = 全案内("8月22日締め");
    expect(案内).toContain("8月22日");
    expect(案内, "分けて探した事を隠した").toContain("に分けて探しています");
  });

  it("和暦の日付に繋がれた締切の語も、其の暦日の行に届く", () => {
    const 暦日 = new Set(行列表("2026年8月22日").map((r) => r.hay));
    const 打 = 行列表("令和8年8月22日締め");
    expect(打.length, "`令和8年8月22日締め` が 0 行").toBeGreaterThan(0);
    打.forEach((行) => {
      expect(暦日.has(String(行.hay)), "別の日の行を出した").toBe(true);
    });
    expect(対称差("令和8年8月22日締め", "令和8年8月22日 締切")).toBe(0);
    /* 年を付けない暦日（`8月22日`）は足さない – 他の年の同じ日を持ってくる（第 329 回）。 */
    expect(全案内("令和8年8月22日締め")).not.toContain("『8月22日』も");
  });
});

describe("「まで」「いっぱい」で期間を言う形", () => {
  it("数値で書いた月と暦日の `まで` – 月は其の月の語、暦日は今日からの幅で探す", () => {
    expect(行列表("8月").length, "対照の `8月` が 0 行").toBeGreaterThan(0);
    expect(対称差("8月まで", "8月"), "`8月まで` が `8月` と違う行を出した").toBe(0);
    /* 暦日を名乗った `まで` は其の日だけの形に寄せない（第 398 回 – 寄せた上で `に` を
     * 残すと `8月22日に` のやうな壊れた語になり、`までに` を付けた形は 0 行になつた）。
     * 其の日だけの形は幅に含む – 其れより広い側に化けるので、含む事を見る。 */
    const 其の日 = new Set(行列表("8月22日").map((行) => 行.hay));
    const 幅 = new Set(行列表("8月22日まで").map((行) => 行.hay));
    expect(幅.size, "`8月22日まで` が 0 行").toBeGreaterThan(0);
    expect(
      [...其の日].every((行) => 幅.has(行)),
      "`8月22日まで` が其の日の行を落とした",
    ).toBe(true);
    expect(全案内("8月22日まで"), "幅の案内が消えた").toContain("〜");
    /* 月と末尾が連なる打ち方も受ける（`N月末` の規則に任せるだけの形にしない – 頭の表から
     * 末尾を取ると 0 行に戻る – 検査で守る）。 */
    expect(対称差("3月末まで", "3月末"), "`3月末まで` が `3月末` と違う行を出した").toBe(0);
    const 案内 = 全案内("8月まで");
    expect(案内, "何として探したかを書いていない").toContain("「8月まで」は「8月」");
    /* 期間の語側の規則が既に受ける形（`明日まで`）は其の侭 – 日付の範囲に解く案内が其の側に
     * 在る事を続ける（第 340 回 – 此方の規則がどの頭を受けるかは下に検査を置く）。 */
    expect(全案内("明日まで"), "`明日まで` の日付の範囲の案内が消えた").toContain("〜");
  });

  it("`いっぱい` は其の期間の語と同じ行集合を出す", () => {
    expect(対称差("今月いっぱい", "今月"), "`今月いっぱい` が `今月` と違う行を出した").toBe(0);
    expect(対称差("来週いっぱい", "来週"), "`来週いっぱい` が `来週` と違う行を出した").toBe(0);
    expect(対称差("8月いっぱい", "8月"), "`8月いっぱい` が `8月` と違う行を出した").toBe(0);
    expect(全案内("今月いっぱい")).toContain("今月");
    /* 打たれていない語を案内に書かない – `今月` 単体には其の案内は要らない。 */
    expect(全案内("今月")).not.toContain("の締切として探しています");
  });
});

describe("締切の日が決まっていない事を尋ねる形", () => {
  it("`締切未定` は『締切』と『未定』の両方を見る", () => {
    expect(行列表("未定").length, "対照の `未定` が 0 行").toBeGreaterThan(0);
    expect(対称差("締切未定", "締切 未定"), "`締切未定` が `締切 未定` と違う行を出した").toBe(0);
    const 案内 = 全案内("締切未定");
    expect(案内).toContain("締切");
    expect(案内).toContain("未定");
    /* 「期間の語」と誤って呼ばない（第 346 回の実発生 – 二つの案内が同時に立っていた）。 */
    expect(案内).not.toContain("期間の語と『締切』の両方が書かれた行");
  });

  it("`期限未定` `日付未定` は収録に其の語が無い事をその場で書く", () => {
    expect(対称差("期限未定", "未定"), "`期限未定` が `未定` と違う行を出した").toBe(0);
    expect(対称差("日付未定", "未定"), "`日付未定` が `未定` と違う行を出した").toBe(0);
    expect(全案内("期限未定"), "落とした語を書いていない").toContain("「期限」");
    expect(全案内("日付未定")).toContain("「日付」");
  });
});

describe("成果物", () => {
  it("組み立てた品が四つの形を持ち、書き換えが関数の中にある", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 本文 = jsFunction(rec, "collapseRelativeDayPhrase");
    expect(本文.length, "`collapseRelativeDayPhrase` が見つからない").toBeGreaterThan(0);
    expect(本文.includes("いっぱいの言い方"), "`いっぱい` の規則が関数の外に出た").toBe(true);
    expect(本文.includes("期日までの言い方"), "`まで` の規則が関数の外に出た").toBe(true);
    expect(本文.includes("未定を繋げた言い方"), "`未定` の規則が関数の外に出た").toBe(true);
    expect(
      本文.includes("[0-9]{1,2}月[0-9]{1,2}日"),
      "日付に繋がれた締切の語を受ける形が消えた",
    ).toBe(true);
    /* 和暦の日付専用の枝は置かない – `令和8年8月22日締め` の中の `8月22日締め` の形で受かる
     * （実測で同じ 11 行 – 二重の規則を持たせない判断を上と揃える）。 */
    expect(本文.includes("明治|大正|昭和|平成|令和)"), "和暦の日付の枝を又増やした").toBe(false);
    expect(rec.includes("の締切として探しています"), "『まで』『いっぱい』の案内が消えた").toBe(
      true,
    );
    expect(rec.includes("両方が書かれた行を探しています"), "『締切未定』の案内が消えた").toBe(true);
    /* 実装側の言い方を案内に混ぜない – 説明文の語彙の検査が守っているのに加えて、
     * 寄せ語彙（頭を落とす表）にも戻さない（第 346 回の実発生 – 其の表に其の英字語を載せたら
     * 説明文の語彙の検査が別のもので引っかかった）。 */
    const 頭 = 本文.slice(本文.indexOf("未定を繋げた別の頭"));
    const 頭の規則 = 頭.slice(0, 頭.indexOf(";"));
    expect(頭の規則.includes("期限"), "頭を落とす表が見つからない").toBe(true);
    expect(頭の規則.includes("デッドライン"), "実装側の言い方を寄せ語彙に戻した").toBe(false);
  });
});
