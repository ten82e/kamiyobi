import { expect, it } from "vitest";
import { callMcp, createMcpSandbox, type McpCall } from "./mcp_stdio.ts";

type Reply = { isError?: boolean; content: Array<{ text: string }> };
const root = createMcpSandbox("kamiyobi-mcp-wrong-arg-", "2030-01-01T00:00:00Z");

/* 2026-10-17 – AI 役の試しで、`search_venues` に論文情報を `paper`（`recommend_venues` の名前）で渡すと
 * 「query を指定してください」とだけ返り、渡した `paper` が使われなかった事が読み取れなかった。 */
it("search_venues に paper を渡した誤りは、使われなかった引数と正しい名前を言う", () => {
  const calls: McpCall[] = [["search_venues", { paper: "GPU memory management" }]];
  const [bad] = callMcp<Reply>(root, calls);
  expect(bad.isError).toBe(true);
  expect(bad.content[0].text).toContain("query");
  expect(bad.content[0].text).toContain("paper");
  expect(bad.content[0].text).toContain("recommend_venues");
});
