/**
 * 索引（`llms.txt`）の「data.json のスキーマ要約」が、実際の鍵を漏れなく名指している事を見る。
 *
 * 節は会議・版・締切の各階層の鍵を並べる。鍵を足して書き忘れれば、**其の鍵の意味を AI が
 * 推測するしかない**（`data.csv` の列と同じ理屈。實測 2026-10-17: 会議 14・版 12・締切 20 の
 * 鍵がすべて節に出ている – 一部は「`year: integer, id: string, link: string, place: string`」の
 * ように、同じ行にまとめて書いてある）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { builtSite } from "./built_site.ts";

/** 節が名指しているかを、語の切れ目で見る（`id` が `identity_migrations` に当たらないように）。 */
function 名指し(節: string, 鍵: string): boolean {
  return new RegExp(`(?<![a-z_])${鍵}(?![a-z_])`).test(節);
}

it("索引のスキーマ要約が、data.json の鍵を漏れなく名指している", () => {
  const out = builtSite();
  const 索引 = readFileSync(join(out, "llms.txt"), "utf8");
  const 節 = 索引.split("## data.json のスキーマ要約")[1]?.split("\n## ")[0] ?? "";
  expect(節.length, "索引に data.json のスキーマ要約の節が無い").toBeGreaterThan(1000);

  const d = JSON.parse(readFileSync(join(out, "data.json"), "utf8")) as {
    conferences?: Array<Record<string, unknown>>;
  };
  /* **全行の鍵の合はん**を見る（任意の欄は一部の行にしか出ない – 先頭の 1 件だけを見て
   * いた時は、`promotion_ref` のような任意の欄を改名しても検査が落ちなかった）。 */
  const 集める = (物々: Array<Record<string, unknown>>): Set<string> => {
    const 出 = new Set<string>();
    for (const 物 of 物々) for (const k of Object.keys(物)) 出.add(k);
    return 出;
  };
  const 会議々 = (d.conferences ?? []) as Array<Record<string, unknown>>;
  const 版々 = 会議々.flatMap((c) => (c.editions ?? []) as Array<Record<string, unknown>>);
  const 締切々 = 版々.flatMap((e) => (e.deadlines ?? []) as Array<Record<string, unknown>>);
  expect(締切々.length, "締切が 100 行未満（前提が崩れた）").toBeGreaterThan(100);

  for (const [階層, 鍵] of [
    ["トップレベル", new Set(Object.keys(d as Record<string, unknown>))],
    ["会議", 集める(会議々)],
    ["版", 集める(版々)],
    ["締切", 集める(締切々)],
  ] as const) {
    expect(鍵.size, `${階層}の鍵が 3 つ未満（前提が崩れた）`).toBeGreaterThan(3);
    const 無い = [...鍵].filter((k) => !名指し(節, k)).sort();
    expect(無い, `索引のスキーマ要約が名指していない${階層}の鍵: ${無い.join("・")}`).toEqual([]);
  }
});
