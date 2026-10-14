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
function run(args: string[], input?: string) {
  return spawnSync(process.execPath, [join(root, "src/mcp.ts"), ...args], {
    cwd: root,
    input,
    encoding: "utf8",
    timeout: 30000,
  });
}
for (const query of ["parallel computing", "並列計算"])
  it(`returns a structured missing-model error for ${query} over MCP`, () => {
    const child = run(
      [],
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_venues", arguments: { query, retrieval: "semantic" } },
      })}\n`,
    );
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim()).result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error?.code).toBe("MODEL_NOT_READY");
    expect(result.structuredContent.error.model.id).toBe(
      query === "並列計算"
        ? "Xenova/paraphrase-multilingual-MiniLM-L12-v2"
        : "Xenova/all-MiniLM-L6-v2",
    );
    expect(result.structuredContent.error.missing_files).toContain("onnx/model.onnx");
    expect(result.structuredContent.rows).toBeUndefined();
    expect(result.content[0].text).toContain("実モデルが未準備");
  });
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

it("reads a fielded Japanese paper from a file without treating its path as the title", () => {
  const file = join(root, "draft.txt");
  writeFileSync(
    file,
    "タイトル：実装の評価\n概要：消失訂正符号を用いた分散メモリストレージを評価する。",
  );
  const result = run(["recommend", "--input", file, "--limit", "1", "--json"]);
  expect(result.status, result.stderr).toBe(0);
  const page = JSON.parse(result.stdout);
  expect(page.input.received).toBe(1);
  expect(page.rows.map((r: { venue_key: string }) => r.venue_key)).toEqual(["storage"]);
});
it("accepts piped JSON including quotes and newlines as one paper", () => {
  const result = run(
    ["search_venues", "--input", "-", "1", "--json"],
    JSON.stringify({ title: 'An "evaluation"', abstract: "erasure coded\nmemory storage" }),
  );
  expect(result.status, result.stderr).toBe(0);
  const page = JSON.parse(result.stdout);
  expect(page.input.received).toBe(1);
  expect(page.limit).toBe(1);
  expect(page.rows[0].venue_key).toBe("storage");
});
it("preserves a title-ending year when the count is explicit", () => {
  const result = run(["recommend", "Memory", "storage", "2026", "--limit", "1"]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Memory storage 2026");
  expect(result.stdout).toMatch(/\n1\. /);
  expect(result.stdout).not.toMatch(/\n2\. /);
});
it.each([
  ["recommend", "--input"],
  ["recommend", "--input", "--json"],
  ["stats", "--input", "-"],
  ["recommend", "direct title", "--input", "-"],
  ["recommend", "--input", "-", "--input", "-"],
  ["recommend", "--limit"],
  ["recommend", "title", "--limit", "0"],
  ["recommend", "title", "--limit", "1.5"],
  ["recommend", "title", "--limit", "1", "--limit", "2"],
])("rejects ambiguous input/count arguments %j", (...args) => {
  const result = run(args, "memory storage");
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/--input|--limit/);
});
it("reports unreadable files, empty input, invalid UTF-8 and binary documents", () => {
  const invalid = join(root, "invalid.txt");
  const pdf = join(root, "paper.pdf");
  const word = join(root, "paper.docx");
  writeFileSync(invalid, Buffer.from([0xc3, 0x28]));
  writeFileSync(pdf, "%PDF-1.7 fake");
  writeFileSync(word, Buffer.from([0x50, 0x4b, 3, 4]));
  for (const [file, input, message] of [
    [join(root, "missing.txt"), undefined, "読めません"],
    ["-", "  ", "題名または概要"],
    [invalid, undefined, "UTF-8"],
    [pdf, undefined, "Wordファイル"],
    [word, undefined, "Wordファイル"],
  ] as const) {
    const result = run(["search_venues", "--input", file, "--json"], input);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
  }
});
