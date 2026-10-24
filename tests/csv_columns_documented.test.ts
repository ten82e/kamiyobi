/**
 * `data.csv` の列に、索引（`llms.txt`）の説明が漏れなく付いている事を見る。
 *
 * 列を足して説明を書き忘れれば、**その列の意味を AI が推測するしかない**（値の規則から
 * 辿れる物もあるが、`kind_ja`・`date_field` のように規則の外の列は説明が要る）。列を消して
 * 説明を残せば、無い列の意味を書いた索引に成る（2026-10-17 実測: どちらも 31 で一致）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { builtSite } from "./built_site.ts";

it("data.csv の列に、索引の説明が漏れなく付いている", () => {
  const out = builtSite();
  const 索引 = readFileSync(join(out, "llms.txt"), "utf8");
  const 節 = 索引.split("## data.csv の列")[1]?.split("\n## ")[0] ?? "";
  expect(節.length, "索引に data.csv の列の節が無い").toBeGreaterThan(500);
  /* 節は列ごとに `- <列名>：<説明>` を並べる。**説明が空の物**も見る（列だけ足して
   * 説明を書かなければ、見出しは在るのに中身が無い – 其れは書いて居ないのと同じ）。 */
  const 箇条 = [...節.matchAll(/^- ([a-z_]+)：([\s\S]*?)(?=\n- |\n\n|$)/gm)];
  const 説明 = new Set(箇条.map((m) => m[1]));
  const 空の説明 = 箇条.filter((m) => !m[2].trim()).map((m) => m[1]);

  const 頭 = readFileSync(join(out, "data.csv"), "utf8")
    .split("\n")[0]
    .replace(/^\uFEFF/, "")
    .split(",");
  expect(頭.length, "列が 20 本未満（前提が崩れた）").toBeGreaterThan(20);
  const 書いて居ない = [...頭].filter((x) => !説明.has(x)).sort();
  expect(書いて居ない, `索引に説明が無い列: ${書いて居ない.join("・")}`).toEqual([]);
  const 無い列 = [...説明].filter((x) => !頭.includes(x)).sort();
  expect(無い列, `索引が説明するのに列が無い物: ${無い列.join("・")}`).toEqual([]);
  expect(空の説明, `索引に説明が空の列: ${空の説明.join("・")}`).toEqual([]);
  /* 節の數の宣言も列數と合う（列を増減した日に書き忘れない）。 */
  expect(節, "節の列數の宣言が列數と違う").toContain(`列はこの順で ${頭.length} 本。`);
});
