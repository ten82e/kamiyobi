/**
 * 参加形式の語に『参加』『開催』『のみ』を繋げた形の検査（`バーチャル参加` `対面参加` `現地のみ`）。
 * SPEC §4・§7・第 350 回。
 * 実測（2026-10-08 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `バーチャル` 11 行・`オンライン参加可` 24 行・`オンラインのみ` 1 行・`対面`〜`リアル開催` は
 * 0 行だが案内が出る、のに、`バーチャル参加` **0 行**・`バーチャル開催` **0 行**・
 * `対面参加` **0 行**・`オフライン参加` **0 行**・`オンサイト参加` **0 行**・`現地参加` **0 行**・
 * `リアル参加` **0 行**・`対面のみ` **0 行** はいずれも**案内も無し**だった（読み上げは
 * 「収録データにありません」とだけ言う）。
 */

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

describe("参加形式の語を繋げた言い方", () => {
  it("`バーチャル参加` `バーチャル開催` は `バーチャル` と同じ行に出会う", () => {
    expect(行列表("バーチャル").length, "対照の `バーチャル` が 0 行").toBeGreaterThan(0);
    for (const 語 of ["バーチャル参加", "バーチャル開催"]) {
      expect(行列表(語).length, `${語} が 0 行の侭`).toBeGreaterThan(0);
      expect(対称差(語, "バーチャル"), `${語} が \`バーチャル\` と違う行を出した`).toBe(0);
      expect(全案内(語), `${語} の案内が消えた`).toContain("virtual");
    }
  });

  it("`バーチャルのみ` は寄せない（オンラインのみの行だけ、という別の頼み方）", () => {
    /* 実測 `オンラインのみ` 1 行 / `オンライン` 24 行 – 「のみ」は行集合を絞る語なので、
     * 其の方へ寄せると hybrid の行まで出す事になる（噓になる – 寄せない）。 */
    expect(行列表("オンラインのみ").length, "対照の `オンラインのみ` が 0 行").toBeGreaterThan(0);
    expect(
      行列表("オンラインのみ").length,
      "`オンラインのみ` が `オンライン` と同じ広さに化けた",
    ).toBeLessThan(行列表("オンライン").length);
    expect(対称差("バーチャル参加", "オンライン参加") > 0, "別の参加形式を同じ行にした").toBe(true);
    /* 『のみ』を付けた頼み方は受けない – 其の侭 0 行（実測 – 寄せる形を足していない事の検査）。 */
    expect(行列表("バーチャルのみ").length, "`バーチャルのみ` を寄せる形を足した").toBe(0);
    expect(行列表("ハイブリッドのみ").length, "`ハイブリッドのみ` を寄せる形を足した").toBe(0);
  });

  it("対面側の言い方は 0 行の侭、其のことを其の場で書く（行を作らない）", () => {
    for (const 語 of [
      "対面参加",
      "対面のみ",
      "オフライン参加",
      "オフライン開催",
      "オフラインのみ",
      "オンサイト参加",
      "オンサイト開催",
      "オンサイトのみ",
      "現地参加",
      "現地のみ",
      "リアル参加",
      "リアルのみ",
    ]) {
      expect(行列表(語).length, `${語} に行が出てしまった（収録に無い物を寄せた）`).toBe(0);
      const 案内 = 全案内(語);
      /* 「収録に無い」だけで止まらない – 何で探せるかを其の場で書く（第 337 回の決まり）。
       * 前の文に『オンライン参加可』は出る為、導く後半その物を張る（前半だけ残す改ざんを
       * 検出出来なかった – 第 350 回の実発生）。 */
      expect(案内, `${語} の案内が出ていない（黙った侭 0 件）`).toContain(
        "『オンライン参加可』で探せます",
      );
      /* 打ち込んだ語その物を名指す（第 249 回の書き方と同じ – 別の語に読み替えない）。 */
      expect(案内, `${語} を名指していない`).toContain(語);
    }
  });
});

describe("壊していない物", () => {
  it("オンライン側の語は今までどおり（案内は寄せた結果を書く）", () => {
    expect(対称差("オンライン参加", "オンライン"), "`オンライン参加` が別の行を出した").toBe(0);
    for (const 語 of ["オンライン参加可", "オンライン", "ハイブリッド"]) {
      expect(行列表(語).length, `${語} が 0 行に落ちた`).toBeGreaterThan(0);
    }
    /* `ハイブリッド参加` は収録の語その物に当たる形（行集合は `ハイブリッド` より狭い –
     * 広げても別の行になるので寄せていない）。 */
    expect(行列表("ハイブリッド参加").length, "`ハイブリッド参加` が 0 行に落ちた").toBeGreaterThan(
      0,
    );
    expect(対称差("ハイブリッド参加", "ハイブリッド") > 0, "`ハイブリッド参加` を広く寄せた").toBe(
      true,
    );
  });

  it("会議名に現れる語を寄せない決まりは其侭", () => {
    /* `仮想` は寄せない – 「仮想マシン」等の名前に当たる（第 246 回）。 */
    expect(行列表("仮想マシン").length, "`仮想マシン` が出るようになった（寄せた）").toBe(0);
    expect(全案内("バーチャル参加")).not.toContain("仮想");
  });
});

describe("成果物", () => {
  it("二つの表に、繋げた形が其のまま入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const 語 of [
      "バーチャル参加",
      "バーチャル開催",
      "対面参加",
      "現地参加",
      "オンサイトのみ",
    ]) {
      expect(rec.includes(語), `${語} が表から消えた`).toBe(true);
    }
    /* 別の寄せる先（原文の virtual 以外の語）に替えていない事 – 同じ行集合の検査が其れを見る。 */
    const virtualの寄せ = rec.match(/"バーチャル参加", "原文の virtual という語", \["virtual"\]/g);
    expect(virtualの寄せ, "バーチャル参加の寄せる先が変わった").toHaveLength(1);
  });
});
