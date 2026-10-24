/**
 * 索引（`llms.txt`）の「catalog.json の形」が、実際の `catalog.json` の鍵と合う事を見る。
 *
 * この節は、畫面が最初に讀む窓に何が入つているかを AI に伝える物である。鍵を足して
 * 書き忘れれば其の鍵の意味は推測になり、消した鍵の説明を殘せば無い物を指す索引になる
 * （2026-10-17 実測: 鍵 14 に対し、節は「`data.json` と同じ 6 つ」+ 箇条書き 9 つで一致）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { builtSite } from "./built_site.ts";

it("索引の catalog.json の節が、実際の鍵と合う", () => {
  const out = builtSite();
  const 索引 = readFileSync(join(out, "llms.txt"), "utf8");
  const 節 = 索引.split("## catalog.json の形")[1]?.split("\n## ")[0] ?? "";
  expect(節.length, "索引に catalog.json の節が無い").toBeGreaterThan(200);

  /* 節は「`data.json` と同じ鍵」を 1 文で名指し、窓に固有の鍵を箇条書きで並べる。 */
  const 文 = /トップレベルは (.+?) に加えて/m.exec(節)?.[1] ?? "";
  expect(文, "索引に「data.json と同じ鍵」の文が無い").not.toBe("");
  const 同じ鍵 = new Set([...文.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]));
  const 箇条 = new Set([...節.matchAll(/^ {2}- ([a-z_]+): /gm)].map((m) => m[1]));
  const 書いた = new Set([...同じ鍵, ...箇条]);
  expect(書いた.size, "索引の鍵が 5 つ未満（前提が崩れた）").toBeGreaterThan(5);

  const カタログ = JSON.parse(readFileSync(join(out, "catalog.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const 鍵 = Object.keys(カタログ);
  expect(鍵.length, "catalog.json の鍵が 5 つ未満（前提が崩れた）").toBeGreaterThan(5);
  const 書いていない = 鍵.filter((x) => !書いた.has(x)).sort();
  expect(書いていない, `索引に書いていない鍵: ${書いていない.join("・")}`).toEqual([]);
  const 無い鍵 = [...書いた].filter((x) => !鍵.includes(x)).sort();
  expect(無い鍵, `索引が説明するのに無い鍵: ${無い鍵.join("・")}`).toEqual([]);
});
