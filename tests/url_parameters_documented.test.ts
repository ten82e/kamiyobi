/**
 * 画面が URL に載せる引数が、索引（`llms.txt`）に書いてある事を見る。
 *
 * 引数を足したのに索引へ書かなければ、**AI も人もその絞り込みのリンクを組めない**
 * （2026-10-17 に 14 個を初めて書いた。それまでは実装だけが知つていた）。逆向き
 * （索引に有るのに実装が讀まない名前）は、值の一覽（`abstract`・`7d` など）と同じ
 * 字面なので機械で選り分けにくい – 此方からは、実装が書く物が漏れなく載っている事を見る。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT } from "./helpers.ts";

it("畫面が URL に載せる引数が、索引に書いてある", () => {
  const app = readFileSync(join(REPO_ROOT, "site", "app.ts"), "utf8");
  const 名 = [...app.matchAll(/p\.set\("([a-z_]+)"/g)].map((m) => m[1]);
  const 実装 = [...new Set(名)].sort();
  expect(実装.length, "引数が 10 個未満（前提が崩れた）").toBeGreaterThan(10);

  const 索引 = readFileSync(join(REPO_ROOT, "public", "llms.txt"), "utf8");
  /* 「画面の URL には、絞り込みを次の名前で載せます」の行（索引のサイトの節）。 */
  const 行 = 索引.split("\n").find((l) => l.includes("絞り込みを次の名前で載せます"));
  expect(行, "索引に URL の引数の行が無い").toBeTruthy();
  /* `dir=desc` の樣に「名前=值」で書いてある物も、其の引数を書いた物として數へる
   * （值が 1 つに定まる物は其の形の方が讀みやすい）。 */
  const 書かれていない = 実装.filter((x) => !行!.includes(`\`${x}\``) && !行!.includes(`\`${x}=`));
  expect(書かれていない, `索引に書いていない引数: ${書かれていない.join("・")}`).toEqual([]);

  /* 索引の側にも、実装より多い名前が並んで居ないか（値の一覽と混ざつて居ないか）は、
   * 行の長さで緩く見る（引数 14 個 + 值の一覽で 300 字を超える）。 */
  expect(行!.length, "索引の行が短すぎる（引数が消えた？）").toBeGreaterThan(200);
});
