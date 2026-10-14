import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import { REPO_ROOT, tempWork } from "./helpers.ts";

let root: string;
beforeAll(() => {
  root = tempWork("kamiyobi-cli-options-");
  for (const name of ["src", "site"])
    cpSync(join(REPO_ROOT, name), join(root, name), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  mkdirSync(join(root, "public"));
  writeFileSync(
    join(root, "public/recommendation-index.json"),
    JSON.stringify({
      reranker: null,
      conferences: [
        {
          key: "storage",
          title: "Storage",
          full_name: "Distributed Memory Storage",
          categories: ["systems"],
          scope: ["erasure coded memory storage"],
          editions: [],
        },
      ],
    }),
  );
});
function run(args: string[]) {
  return spawnSync(process.execPath, [join(root, "src/mcp.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
  });
}
it("keeps the whole unquoted English title and emits a parseable result without text mixed in", () => {
  const result = run([
    "search_venues",
    "Efficient",
    "erasure",
    "coded",
    "memory",
    "storage",
    "5",
    "--retrieval",
    "lexical",
    "--json",
  ]);
  expect(result.status, result.stderr).toBe(0);
  const page = JSON.parse(result.stdout);
  expect(page.rows).toHaveLength(1);
  expect(page.rows[0].venue_key).toBe("storage");
  expect(page.limit).toBe(5);
  expect(page.uses_embeddings).toBe(false);
  expect(page.candidate_venues).toBe(1);
});
it.each([
  ["recommend", "memory", "--retrieval"],
  ["recommend", "memory", "--retrieval", "unknown"],
  ["recommend", "memory", "--retrieval", "semantic", "--retrieval", "lexical"],
  ["stats", "--retrieval", "semantic"],
  ["stats", "--json"],
  ["search_venues", "memory", "--json", "--json"],
  ["search_venues", "memory", "--offset", "-1", "--json"],
])("rejects invalid mode/output flags %j instead of putting them into the paper", (...args) => {
  const result = run(args);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/--retrieval|--json|--offset/);
});
it("actually selects semantic inference and reports missing weights as a failure", () => {
  const result = run(["recommend", "memory storage", "--retrieval", "semantic", "--json"]);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/tokenizer|model|モデル/);
});

it("reports an unknown tool as failure without polluting JSON output", () => {
  const result = run(["saerch", "--json"]);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("7種類");
  expect(result.stderr).toContain("search_venues");
});
