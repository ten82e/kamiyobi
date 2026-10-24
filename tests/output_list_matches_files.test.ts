/**
 * 索引（`llms.txt`）の「出力一覧」が、実際に配付しているファイルと一致する事を見る。
 *
 * この節は AI が「何がどこにあるか」を知るための物である。新しい出力を足して 1 行を
 * 書き忘れれば**其のファイルは誰にも見つけられず**、消したファイルの行を残せば
 * **無い物を指す索引**に成る（2026-10-17 実測: 実物 28・索引 28 で一致。`embeddings.json`
 * だけは条件付きで出ない物として書いてある）。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { builtSite } from "./built_site.ts";

it("索引の出力一覧が、配付しているファイルと一致する", () => {
  const out = builtSite();
  const 索引 = readFileSync(join(out, "llms.txt"), "utf8");
  const 節 = 索引.split("## 出力一覧")[1]?.split("\n## ")[0] ?? "";
  expect(節.length, "索引に出力一覧の節が無い").toBeGreaterThan(200);
  const 名 = new Set([...節.matchAll(/^- ([^\s：:]+)/gm)].map((m) => m[1]));
  expect(名.size, "索引の出力一覧が 10 件未満（前提が崩れた）").toBeGreaterThan(10);

  const 実物 = new Set(
    readdirSync(out, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name),
  );
  /* 埋め込みを有効にしたビルドだけに出る物（索引が其う書いている）。 */
  const 条件付き = new Set(["embeddings.json"]);
  const 書いていない = [...実物].filter((x) => !名.has(x)).sort();
  expect(書いていない, `索引に書いていない配付物: ${書いていない.join("・")}`).toEqual([]);
  const 無い物 = [...名].filter((x) => !実物.has(x) && !条件付き.has(x)).sort();
  expect(無い物, `索引が指すのに配付していない物: ${無い物.join("・")}`).toEqual([]);
});
