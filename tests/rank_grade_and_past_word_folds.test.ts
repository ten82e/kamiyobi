/**
 * 等級・穴場・早期・過去の言い方（第 384 回）。実測（2026-09-25 – 2026-08-09 生成の実ビルドの
 * 品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * - 等級の印は `A*` 159 行・`A` 320 行・`B` 264 行が通るのに、日本語で書く形 `特A` `A特`
 *   `エースター` `Aスター` `Aスタート` `A*の会` `A*級` `A*な会議` は **0 行で案内も無し**だった。
 * - 穴場は主題タグの画面ラベルで 44 行通るのに、`穴場の会` だけ抜けて居た。
 * - `早期登録` `登録締切` `登録期限` は 7 行通るのに、`早期締切` `早期提出` は **0 行で案内も無し**
 *   だった（収録に早期割引の区別は無いので、其の方の条目と同じ案内付きで『登録締切』へ寄せる）。
 * - 過去の締切はトグルへ導す案内が出る群に、`去年` `昨年` `昨年度` `去年の会議` `過去の会`
 *   `過去の会議` `終了した` `終了した会` が抜けて居た（**0 行・案内も無し**だった）。過ぎた締切は
 *   収録の締切の七割（2,325 行）あってトグルで出せる – 語を足して行を出すことはしない。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  return Recommender.candidateRows(catalog) as unknown as Array<{
    hay: string;
  }>;
}

function 当たり列表(語: string): string[] {
  const 当 = Recommender.searchMatcher(語, 基準);
  return 品書()
    .filter((行) => 当(String(行.hay)) === true)
    .map((行) => String(行.hay))
    .sort();
}

function 対称差(a: string[], b: string[]): number {
  const 左 = new Set(a);
  const 右 = new Set(b);
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}

function 語の組(語: string): string[][] {
  return (
    Recommender as unknown as {
      queryTokenGroups: (q: unknown, now?: number) => string[][];
    }
  ).queryTokenGroups(語, 基準);
}

function 全案内(語: string): string {
  const 入口 = [
    "columnQueryLiveNoteJa",
    "uiWordLiveNoteJa",
    "dayRangeLiveNoteJa",
    "wholeTableQueryNoteJa",
  ] as const;
  const 表 = Recommender as unknown as Record<
    (typeof 入口)[number],
    (q: string) => string | undefined
  >;
  return 入口.map((名) => String(表[名](語) || "")).join(" | ");
}

const 等級 = ["特A", "A特", "エースター", "Aスター", "Aスタート", "A*の会", "A*級", "A*な会議"];

const 過去 = [
  "去年",
  "昨年",
  "昨年度",
  "去年の会議",
  "過去の会",
  "過去の会議",
  "終了した",
  "終了した会",
];

describe("等級・穴場の言い方", () => {
  it("日本語で書いた等級も A* の語へ寄せる", () => {
    /* ハーネスの品書（435 行）には A* の行が 0 行なので（実測 – 実ビルドの品書 872 行では
     * 159 行）、此處では**行集合が A* と一字も違わない**事と、**語の組に A* が入って居る**
     * 事を両方張る（どちらか一方だけだと、別の語へ寄せた時や条目が消えた時に落ちない）。
     * 行集合の一致は実ビルドでも実測してある – 8 語すべて 0 → 159 行 / 対称差 0（上の注）。 */
    const 正 = 当たり列表("A*");
    for (const 語 of 等級) {
      expect(対称差(当たり列表(語), 正), `当たり列表が違う: ${語}`).toBe(0);
      const 組 = 語の組(語);
      expect(組.length, `語の組が括られた形ではない: ${語}`).toBe(1);
      expect(組[0], `A* へ寄せていない: ${語}`).toContain("A*");
    }
    /* 実在する等級の語は其侭通る（寄せを増やした事で壊れていない）。 */
    expect(当たり列表("A").length, "`A` の当たりが消えた").toBeGreaterThan(0);
  });

  it("寄せた等級は件数欄の案内に出す", () => {
    for (const 語 of 等級) {
      const 案内 = Recommender.querySynonymNotes(語).join("・");
      expect(案内, `寄せの案内が出ない: ${語}`).toContain("A*");
      expect(案内, `欄の名前を書かない案内: ${語}`).toContain("等級");
    }
  });

  it("`エー` の当たり方を変えない（A に寄せない）", () => {
    const エー = 当たり列表("エー");
    expect(エー.length, "`エー` の当たりが消えた").toBeGreaterThan(0);
    expect(対称差(エー, 当たり列表("A*")), "`エー` を A* に寄せて意味を変えた").toBeGreaterThan(0);
    expect(Recommender.querySynonymNotes("エー")).toEqual([]);
  });

  it("穴場の別の言い方も主題タグの行を其侭通す", () => {
    const 正 = 当たり列表("穴場");
    expect(正.length).toBeGreaterThan(0);
    for (const 語 of ["穴場の会", "穴場会議", "穴場な会議"]) {
      expect(対称差(当たり列表(語), 正), `当たり列表が違う: ${語}`).toBe(0);
    }
  });
});

describe("早期の言い方", () => {
  it("収録に無い早期割引の区別を發明せず、登録の締切を其の旨の案内付きで出す", () => {
    const 正 = 当たり列表("登録締切");
    expect(正.length).toBeGreaterThan(0);
    for (const 語 of ["早期締切", "早期提出", "早期割引"]) {
      expect(対称差(当たり列表(語), 正), `当たり列表が違う: ${語}`).toBe(0);
      const 案内 = Recommender.querySynonymNotes(語).join("・");
      expect(案内, `収録に無い旨を書かない案内: ${語}`).toContain("収録に早期割引の区別は無く");
    }
  });
});

describe("過去の言い方", () => {
  it("年まわしの語も『過去の締切も表示』のトグルへ導す", () => {
    for (const 語 of 過去) {
      /* 行を作らない – 表に「去年」とは書いていないので掛ける先が無い。 */
      expect(当たり列表(語), `当たりが出てしまった: ${語}`).toEqual([]);
      const 案内 = 全案内(語);
      expect(案内, `案内が出ない: ${語}`).toContain("過去の締切も表示");
      expect(案内, `この語では絞れないと言わない: ${語}`).toContain("絞れません");
    }
    /* 既に出て居た語も其侭（語を足した事で群が壊れていない）。 */
    for (const 語 of ["過去", "過ぎた締切"]) {
      expect(全案内(語), `既存の案内が消えた: ${語}`).toContain("過去の締切も表示");
    }
  });

  it("足した条目が成果物に入っている", () => {
    const 成果物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const 語 of [...等級, "穴場の会", "早期締切", "早期提出", ...過去]) {
      /* 正規表現にしない – `A*の会` の様に記号を含む語を正規表現に渡すと量符に読める
       * （第 318 回と同じ点）。文字列そのもので数える。 */
      const 数 = 成果物.split(`"${語}"`).length - 1;
      expect(数, `条目の数が違う: ${語}`).toBe(1);
    }
  });
});
