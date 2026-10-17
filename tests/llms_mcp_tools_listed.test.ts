import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";

/* 2026-10-17 – 索引の道具の表が `search_venues` を欠き、`recommend_venues` を「意味検索は
 * 使わず」と書いていた（実際は `retrieval: semantic` を受ける）。表を読んだ AI が道具を
 * 見落とさないよう、サーバの登録と突き合わせる。 */
it("llms.txt の MCP の表はサーバが持つ道具をすべて挙げる", () => {
  const server = readFileSync(join(import.meta.dirname, "..", "src", "mcp.ts"), "utf8");
  const tools = [...server.matchAll(/^ {4}name: "([a-z_]+)",$/gm)].map((m) => m[1]);
  expect(tools.length, "サーバの道具が読めない（検査が空振り）").toBeGreaterThanOrEqual(6);
  const text = readFileSync(join(site, "llms.txt"), "utf8");
  const start = text.indexOf("## AI から引く（MCP）");
  const section = text.slice(start, text.indexOf("\n## ", start + 5));
  for (const tool of tools) expect(section, `表に ${tool} が無い`).toContain(`| \`${tool}\` |`);
  expect(section).toContain('retrieval: "semantic"');
  expect(section).not.toContain("意味検索は使わず");
});

it("llms.txt の冒頭は画面と同じ分野の幅を名乗る", () => {
  const head = readFileSync(join(site, "llms.txt"), "utf8").split("\n").slice(0, 5).join("");
  for (const 分野 of ["セキュリティ", "DB", "HCI", "理論", "論文誌"]) expect(head).toContain(分野);
});
