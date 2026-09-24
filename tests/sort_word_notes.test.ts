/**
 * 並び替えを訊く語の検査（SPEC §4・§7・第 338 回）。
 * 実測（2026-09-30 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `早い順` `遅い順` `近い順` `遠い順` `新しい順` `古い順` `会議名順` `名前順` `ランク順`
 * `会期順` `残り順` `日時順` `ソート` `昇順` `降順` `人気順` **いずれも 0 行で案内も無し**。
 * `並び順` `並び替え` だけが案内を持っていたが、其の案内は **在らない場所へ送っていた** –
 * 「上にある欄（『並び順』…）」と書くが、其の名前の欄は画面に存在しない（並び順は列の見出しを
 * 押す操作: ビルド済み一覧の `th[data-sort]` と、狭い画面に出る並べ替え欄 `button[data-sort]`）。
 * なのでここでの本命の検査は、**案内が名指す見出しが一覧に実在する事**（`data-sort` を読む）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 画面(): string {
  return readFileSync(join(builtSite(), "index.html"), "utf8");
}

function 行数(語: string): number {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
  const matches = Recommender.searchMatcher(語, 基準);
  return rows.filter((row) => matches(String(row.hay)) === true).length;
}

function 案内(語: string): string {
  return Recommender.uiWordNoteJa(語);
}

/** 並び替えられる列の見出し（`th[data-sort]` の語）。案内が名指して良い物の正本。 */
function 並び替えられる列(): string[] {
  const html = 画面();
  const 列: string[] = [];
  const 形 = /data-sort="[a-z]+"[^>]*>([^<]{1,10}?)\s*(?:↕|↑|↓)?\s*</g;
  let m = 形.exec(html);
  while (m) {
    const 語 = m[1].replace(/（.*?）/g, "").trim();
    if (語 && 列.indexOf(語) < 0) 列.push(語);
    m = 形.exec(html);
  }
  return 列;
}

describe("並び替えを訊く語", () => {
  it("案内が名指す見出しは、一覧に並び替えられる列として実在する", () => {
    const 列 = 並び替えられる列();
    /* 検査自身の前提: ビルド済み一覧に並び替えられる列が並んでいる。 */
    expect(列.length, "並び替えられる列が読めない").toBeGreaterThanOrEqual(5);
    ["残り", "日時", "会期", "会議", "ランク"].forEach((見出し) => {
      expect(列, `案内が名指す『${見出し}』が並び替えられる列に無い`).toContain(見出し);
      expect(案内("並び替え"), `案内が『${見出し}』を書いていない`).toContain(見出し);
    });
    /* 案内が書く「狭い画面では表の上に出る並べ替えの欄」も実在する（`id="sortBar"` –
     * CSS で狭い画面だけに出る。在らない物へ送らない – 第 338 回の本命）。 */
    const html = 画面();
    expect(/<div class="sortbar" id="sortBar"[^>]*aria-label="並べ替え">/.test(html)).toBe(true);
    expect(案内("並び替え")).toContain("狭い画面");
  });

  it("順の言い方（早い順・近い順・会議名順など）が行き先を言う", () => {
    const 語列表 = [
      "早い順",
      "遅い順",
      "近い順",
      "遠い順",
      "新しい順",
      "古い順",
      "会議名順",
      "名前順",
      "ランク順",
      "会期順",
      "残り順",
      "日時順",
      "ソート",
      "昇順",
      "降順",
      "並び替え",
      "並び順",
      "並べ替え",
    ];
    語列表.forEach((語) => {
      expect(行数(語), `"${語}" を受けてしまった（案内の前提が崩れた）`).toBe(0);
      const 文 = 案内(語);
      expect(文, `"${語}" に何も言わない`).not.toBe("");
      expect(文, `"${語}": 打たれた語を書いていない`).toContain(`「${語}」`);
      expect(文, `"${語}": 列の見出しの操作と言わない`).toContain("列の見出し");
      expect(文, `"${語}": 検索欄に打たない事を言わない`).toContain("検索欄");
    });
  });

  it("在らない『並び順』という欄へ送らない（第 248 回の案内を事実へ直した）", () => {
    expect(案内("並び替え")).not.toContain("上にある欄");
    /* 画面に『並び順』という操作欄は無い（てびきの項名としてだけ出る – `site/template.html` の
     * `<dt>並び順</dt>`）。選択欄にもボタンにも出ていない事をみる。 */
    const html = 画面();
    expect(/<option[^>]*>\s*並び順/.test(html), "『並び順』という選択欄が現れた").toBe(false);
    expect(/<button[^>]*>\s*並び順\s*</.test(html), "『並び順』というボタンが現れた").toBe(false);
    expect(/aria-label="並び順"/.test(html), "『並び順』という aria-label が現れた").toBe(false);
    /* 絞り込みは本当に欄の操作 – そちらは「上にある欄」を書き、見出しの話を混ぜない。 */
    const 絞 = 案内("絞り込み");
    expect(絞).toContain("上にある欄");
    expect(絞).not.toContain("列の見出し");
    /* 開発用語 `フィルタ` は書き返さない（第 244 回からの扱い）。 */
    const 黙 = 案内("フィルタ");
    expect(黙).toContain("上にある欄");
    expect(黙, "`フィルタ` を文に織り込んだ").not.toContain("「フィルタ」");
  });

  it("人気順のような順は無いと答える（在る順の名前は並べる）", () => {
    ["人気順", "人気", "おすすめ順", "注目順"].forEach((語) => {
      expect(行数(語), `"${語}" を受けてしまった`).toBe(0);
      const 文 = 案内(語);
      expect(文, `"${語}" に何も言わない`).not.toBe("");
      expect(文, `"${語}": その順が無いと言わない`).toContain("という順はこの表にありません");
      expect(文, `"${語}": 在る順の名前を書かない`).toContain("『残り』");
    });
  });

  it("受けていない言い方まで受けたことにしない（`急ぎ順`）", () => {
    /* 言い方无限に足さない – 受けない語に案内を立てて「何でも分かる表」に見せない。 */
    expect(行数("急ぎ順")).toBe(0);
    expect(案内("急ぎ順"), "`急ぎ順` まで受けた").toBe("");
  });

  it("成果物が順の案内と語を持つ（第 338 回）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 断片列表: Array<[RegExp, string]> = [
      [/"早い順"/, "`早い順` の条目"],
      [/"人気順"/, "`人気順` の条目"],
      [/列の見出し（『残り』『日時』『会期』『会議』『ランク』）/, "見出しを名指す案内"],
    ];
    断片列表.forEach(([形, 名前]) => {
      expect(形.test(rec), `組み立てた画面から ${名前} が消えた`).toBe(true);
    });
  });
});
