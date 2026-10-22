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

/* 索引には「名前=値」の形で値の一覧も書いてある。値が実装（画面の選択肢・並べ替えの印）と
 * ずれると、リンクを組んだ人の画面で別の物が選ばれる（第 44 回に URL を 1 つずつ開いて
 * 実測: `mode`・`kind`・`win`・`sort`・`dir` は画面の選択肢と一致していた）。 */
it("索引に書いた値の一覧が、画面の選択肢と一致する", () => {
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const 索引 = readFileSync(join(REPO_ROOT, "public", "llms.txt"), "utf8");
  const 行 = 索引.split("\n").find((l) => l.includes("絞り込みを次の名前で載せます")) ?? "";
  const 選択肢 = (id: string): string[] => {
    const at = template.indexOf(`id="${id}"`);
    const box = template.slice(at, template.indexOf("</select>", at));
    return [...box.matchAll(/value="([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
  };
  const 書かれた値 = (name: string): string[] => {
    const m = new RegExp(`\`${name}\`（([^）]*)`).exec(行);
    return m ? [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]) : [];
  };
  /* 種別の選択肢はテンプレートでなく JS が作る（`SELECTABLE_KINDS`）。 */
  const app = readFileSync(join(REPO_ROOT, "site", "app.ts"), "utf8");
  const 種別の選択肢 = (/const SELECTABLE_KINDS = \[([^\]]+)\]/.exec(app)?.[1] ?? "")
    .split(",")
    .map((v) => v.trim().replace(/"/g, ""))
    .filter(Boolean);
  expect(種別の選択肢.length, "種別の選択肢が読めない").toBeGreaterThan(0);
  expect(書かれた値("kind").sort(), "kind の値が画面と違う").toEqual(種別の選択肢.sort());
  /* `all` は「かまわない」（既定）なので、索引には載せない。 */
  expect(書かれた値("win").sort(), "win の値が画面と違う").toEqual(
    選択肢("win")
      .filter((v) => v !== "all")
      .sort(),
  );
  for (const key of 書かれた値("sort")) {
    expect(template, `sort の値 ${key} が画面の並べ替えに無い`).toContain(`data-sort="${key}"`);
  }
  expect(書かれた値("sort").length, "sort の値が索引に書かれていない").toBeGreaterThan(3);
});
