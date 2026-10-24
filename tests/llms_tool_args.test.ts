import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT } from "./helpers.ts";

/* 索引（llms.txt）の「他のツールでは…」の行は、道具ごとの引数の名前を書く。取り違えると
 * 呼び出しが案内で止まる（2026-10-23 実測: `search_venues` を `paper` で呼ぶと
 * 「query に研究テーマ・題名・概要を指定してください」だけが返り、索引には `query` の語が
 * 無かった）。 */
it("索引の引数の行が、道具ごとの引数名を書いている", () => {
  const llms = readFileSync(join(REPO_ROOT, "public", "llms.txt"), "utf8");
  const 行 = llms.split("\n").find((l) => l.includes("他のツールでは")) ?? "";
  expect(行, "索引に引数の行が無い").toBeTruthy();
  /* 研究テーマ・題名・概要は search_venues の `query`、論文情報は recommend_venues の `paper`。 */
  expect(行, "`query` を書いていない").toContain("`query`");
  expect(行, "`paper` を書いていない").toContain("`paper`");
  expect(行, "どちらの道具か書いていない").toMatch(/`search_venues` が `query`/);
  expect(行, "どちらの道具か書いていない").toMatch(/`recommend_venues` が `paper`/);

  /* 道具の側も、その名前で受けている（索引と実装がずれていない）。 */
  const mcp = readFileSync(join(REPO_ROOT, "src", "mcp.ts"), "utf8");
  const schema = (name: string): string => {
    const at = mcp.indexOf(`name: "${name}"`);
    expect(at, `${name} が見つからない`).toBeGreaterThan(-1);
    const end = mcp.indexOf("inputSchema", at);
    return mcp.slice(end, mcp.indexOf("},\n  },", end));
  };
  expect(schema("search_venues"), "search_venues が query を受けていない").toContain("query:");
  expect(schema("recommend_venues"), "recommend_venues が paper を受けていない").toContain(
    "paper:",
  );
});
