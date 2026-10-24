/**
 * 回の記録（README と SPEC）の番人。ビルド成果物を見ないので、大きくならない方に置く
 * （tests/lint_budget.test.ts の検査と同じ理由）。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

it("利用手順と仕様に、重複見出し・作業日記・制御文字を混ぜない", () => {
  for (const name of ["README.md", "SPEC.md"]) {
    const text = readFileSync(join(ROOT, name), "utf8");
    expect(
      [...text].some(
        (char) => char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0)),
      ),
    ).toBe(false);
    expect(text).not.toMatch(/第\s*\d+\s*(?:回|囮|囘)/);
    const headings: string[] = [];
    let inCode = false;
    for (const line of text.split("\n")) {
      if (/^```/.test(line)) inCode = !inCode;
      if (!inCode && /^#{1,6} /.test(line)) headings.push(line);
    }
    expect(headings.length).toBeGreaterThan(5);
    expect(new Set(headings).size, `${name} に重複見出しがあります`).toBe(headings.length);
  }
});

it("README と SPEC で、箇条書きが前の項の文末に繋がっていない（第 299 回）", () => {
  for (const name of ["README.md", "SPEC.md"]) {
    const lines = readFileSync(join(ROOT, name), "utf8").split("\n");
    const glued = lines
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /。\s*-\s+\*\*/.test(line) || /。\s*-\s+[^\d\s]/.test(line))
      .map(([n, line]) => `${n} 行目: ${line.slice(0, 48)}`);
    expect(glued, `${name} に繋がった箇条書きがある`).toEqual([]);
  }
});

it("README が MCP サーバの入口と、実装と同じ 7 つの道具を書いている（第 891 回）", () => {
  /* 実測 2026-10-22: README の「機械可読の出力」は「次の **2 つ**を見るのが早い」と書いた儘で
   * 表には 5 つ並び、**MCP サーバに一度も觸れて居なかつた**。MCP は AI がこの収録を使う時の
   * 入口（`node src/mcp.ts`）なので、購読手順を書く README に無いのは穴だ。 */
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  expect(readme, "MCP サーバの節がない").toContain("### MCP サーバとして使う");
  expect(readme, "起動の命令を書いていない").toContain("node src/mcp.ts");
  expect(readme, "stdio・読み取り專用と言つていない").toContain("stdio");
  expect(readme, "外部へ送らん事を書いていない").toContain("外部への送信は行わない");
  /* 「2 つ」が残つていると、読む人は表の 5 つを見て齟齬を覺える。 */
  const 節 = readme.slice(
    readme.indexOf("## 機械可読の出力"),
    readme.indexOf("### MCP サーバとして使う"),
  );
  expect(節, "表の立てる数が残つている").not.toContain("次の 2 つ");
  expect(節, "表の 5 つを数えていない").toContain("次の 5 つ");
  /* 道具の一覽は**実装が持つ物**と突き合はせる。
   * 增えた道具が黙つた儘に成らない。 */
  const mcp = readFileSync(join(ROOT, "src", "mcp.ts"), "utf8");
  const 宣言 = [...mcp.matchAll(/^\s{4}name: "([a-z_]+)",$/gm)].map((m) => m[1]);
  expect(宣言.length, "この検查の前提（道具の宣言）が崩れた").toBe(7);
  const 表 = readme.slice(readme.indexOf("### MCP サーバとして使う"));
  for (const 名 of 宣言) {
    expect(表, `README の道具の表が ${名} を書いて居ん`).toContain(`\`${名}\``);
  }
  /* 表中の cellule に逃げて居ない `|` があると、訳と同じ表が割れる（実測 2026-10-22 で踏んだ）。 */
  const 行 = 表.split("\n").filter((l) => l.startsWith("| `"));
  expect(行.length, "README の道具の表が読めない").toBeGreaterThan(3);
  for (const l of 行) {
    const cellule = l.slice(1, -1).split("|");
    for (const c of cellule)
      expect(c.includes("|"), `表中に逃げて居ない | が在る: ${l}`).toBe(false);
  }
});
