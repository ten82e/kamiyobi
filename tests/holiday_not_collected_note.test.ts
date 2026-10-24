import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

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

const 締切を繋げた語 = ["祝日の締切", "休日の締切", "お盆の締切", "GWの締切", "年末年始の締切"];

const 休日の語 = [
  "祝日",
  "祝日締切",
  "休日",
  "休日締切",
  "振替休日",
  "国民の休日",
  "連休",
  "大型連休",
  "お盆",
  "盆休み",
  "夏休み",
  "冬休み",
  "春休み",
  "ゴールデンウィーク",
  "GW",
  "年末年始",
  ...締切を繋げた語,
];

describe("祝日・休日の頼み方", () => {
  it("0 行の侭、そのことと代替の探し方をその場に書く（行を作らない – 締切の推測をしない）", () => {
    for (const 語 of 休日の語) {
      expect(行列表(語).length, `${語} に行が出てしまった（祝日を勝手に日付へ寄せた）`).toBe(0);
      if (!締切を繋げた語.includes(語)) {
        /* 素の語は、寄せた事にして件数欄を噓にしない – 同義語の案内も立てない。 */
        expect(Recommender.querySynonymNotes(語).join(""), `${語} の同義の案内を立てた`).toBe("");
      }
      const 案内 = Recommender.uiWordNoteJa(語);
      expect(案内, `${語} の案内が出ていない（黙った侭 0 件）`).toContain(語);
      expect(案内, `${語} が収録に無い事を書いていない`).toContain("収録しておらず");
      /* 無いと言うだけで止まらない – 何で探せるかを書く。 */
      expect(案内, `${語} が探し方を書いていない`).toContain("『土日』『平日』");
      expect(案内, `${語} が日付で探せる事を書いていない`).toContain("日付");
      const 読み上げ = Recommender.uiWordLiveNoteJa(語);
      expect(読み上げ, `${語} の読み上げが出ていない`).toContain("収録していません");
      expect(読み上げ, `${語} の読み上げが探し方を置いていない`).toContain("土日");
    }
  });

  it("`年末年始の締切` は期間に分ける文と収録にない文の両方を受ける（実測で並ぶ – 第 352 回）", () => {
    const 文 = Recommender.querySynonymNotes("年末年始の締切").join(" ");
    expect(文, "期間に分ける文が消えた（第 352 回の規則が居ない）").toContain("「年末年始」");
    expect(Recommender.uiWordNoteJa("年末年始の締切")).toContain("収録しておらず");
    expect(行列表("年末年始の締切").length, "0 行の侭である事が消えた").toBe(0);
  });

  it("`土日` `平日` はその方で受けられる（案内が導く先が実在する）", () => {
    expect(行列表("土日").length, "案内が導く `土日` が 0 行").toBeGreaterThan(0);
    expect(行列表("平日").length, "案内が導く `平日` が 0 行").toBeGreaterThan(0);
    /* 日付で探せる事も本当（案内が名指す例の形）。 */
    expect(行列表("2026-09-22").length, "案内が名指す日付の形が 0 行").toBeGreaterThan(0);
  });

  it("『年末年始』は 12月と1月の両方にまたがるので、それぞれで引ける事を導く", () => {
    const 案内 = Recommender.uiWordNoteJa("年末年始");
    expect(案内).toContain("『年末』");
    expect(案内).toContain("『年始』");
    /* 導く先が実在する。 */
    expect(対称差("年末", "12月"), "`年末` が変わった").toBe(0);
    expect(対称差("年始", "1月"), "`年始` が変わった").toBe(0);
    expect(行列表("年末").length, "`年末` が 0 行に落ちた").toBeGreaterThan(0);
  });
});

describe("壊していない物", () => {
  it("他の『収録にない』案内と、締切を繋げた案内は其侭", () => {
    expect(Recommender.uiWordNoteJa("参加費")).toContain("費用の欄はありません");
    expect(Recommender.uiWordNoteJa("招待講演")).toContain("区別はこの表が持っていません");
    expect(Recommender.uiWordNoteJa("対面参加")).toContain("オンライン参加可");
    expect(対称差("バーチャル参加", "バーチャル"), "`バーチャル参加` が変わった").toBe(0);
    /* 案内の表に『〜の締切』の形を足しても、日付を繋けた形の案内はその方の規則が受ける。 */
    expect(対称差("年末締切", "年末 締切"), "`年末締切` が案内の表に吸われた").toBe(0);
    expect(Recommender.querySynonymNotes("年末締切").join(" ")).toContain("「年末」");
    expect(行列表("年末締切").length, "`年末締切` が 0 行に落ちた").toBeGreaterThan(0);
    expect(行列表("年始締切").length, "`年始締切` が 0 行に落ちた").toBeGreaterThan(0);
  });

  it("休日の語を他の語に寄せていない（表の語は案内にしか出ない）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    /* 「祝日」が寄せ先の表（`PERIOD_MONTH_WORDS_JA` – 暦月へ展開する表）に入っていない事。
     * 入れる事は祝日をその月の全行に寄せる事になり、締切の推測になる（AGENTS.md）。 */

    const 暦月の表 = rec.slice(rec.indexOf("const PERIOD_MONTH_WORDS_JA"));
    const 宣言 = 暦月の表.slice(0, 暦月の表.indexOf("};"));
    expect(宣言.includes("祝日"), "暦月の表に `祝日` が入った").toBe(false);
    expect(宣言.includes("年末"), "`年末` の寄せが消えた（第 352 回）").toBe(true);
  });
});
