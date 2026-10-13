import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT, tempWork } from "./helpers.ts";

function sandbox() {
  const root = join(tempWork("kamiyobi-mcp-cli-numbers-"), "研究 workspace");
  mkdirSync(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "public"));
  mkdirSync(join(root, "data"));
  cpSync(join(REPO_ROOT, "src/mcp.ts"), join(root, "src/mcp.ts"));
  cpSync(join(REPO_ROOT, "site"), join(root, "site"), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(root, "clock.mjs"), 'Date.now = () => Date.parse("2026-10-13T00:00:00Z");');
  const data = {
    generated_at: "2026-10-13T00:00:00Z",
    snapshot_metadata: { generated_at: "2026-10-13T00:00:00Z" },
    categories: { systems: "Systems" },
    conferences: ["Alpha", "Beta"].map((name) => ({
      key: name.toLowerCase(),
      title: `GPU ${name}`,
      categories: ["systems"],
      scope: "GPU programming",
      editions: [
        {
          id: `${name}-2026`,
          year: 2026,
          deadlines: [
            { kind: "paper", precision: "exact", utc: "2026-10-15T00:00:00Z", tz_raw: "UTC" },
          ],
        },
      ],
    })),
  };
  for (const file of [
    "public/catalog.json",
    "public/recommendation-index.json",
    "data/snapshot.json",
  ])
    writeFileSync(join(root, file), JSON.stringify(data));
  return root;
}
function run(root: string, args: string[], entry = join(root, "src/mcp.ts")) {
  const result = spawnSync(
    process.execPath,
    ["--import", join(root, "clock.mjs"), entry, ...args],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

it("uses a valid CLI search limit without reporting a type mistake", () => {
  const root = sandbox();
  const one = run(root, ["search", "GPU", "1"]);
  const two = run(root, ["search", "GPU", "2"]);
  for (const text of [one, two]) {
    expect(text).toContain("検索語「GPU」に当たる締切: 2 件");
    expect(text).not.toContain("数値に変換しました");
    expect(text).not.toContain("limit は数で指定");
  }
  expect(one).toContain("1 件まで表示・残り 1 件");
  expect(two).toContain("GPU Alpha");
  expect(two).toContain("GPU Beta");
});

it("uses valid CLI days and recommendation limits without type warnings", () => {
  const root = sandbox();
  const upcoming = run(root, ["list_upcoming", "7", "paper"]);
  expect(upcoming).toContain("7 日以内");
  expect(upcoming).toContain("GPU Alpha");
  expect(upcoming).toContain("GPU Beta");
  expect(upcoming).not.toContain("数値に変換しました");
  const recommendation = run(root, ["recommend", "GPU programming", "1"]);
  expect(recommendation).toContain("に合う投稿先: 2 件");
  expect(recommendation).toContain("1 件まで表示・残り 1 件");
  expect(recommendation).not.toContain("数値に変換しました");
});

it("still explains invalid CLI values and the chosen fallback", () => {
  const root = sandbox();
  const result = run(root, ["search", "GPU", "invalid"]);
  expect(result).toContain("limit は 1 以上の数で指定してください");
  expect(result).toContain("未指定として扱います");
  expect(result).toContain("GPU Alpha");
  expect(result).toContain("GPU Beta");
});

it("still explains a string-typed number received through MCP", () => {
  const root = sandbox();
  const result = spawnSync(
    process.execPath,
    ["--import", join(root, "clock.mjs"), join(root, "src/mcp.ts")],
    {
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_deadlines", arguments: { query: "GPU", limit: "1" } } })}\n`,
      encoding: "utf8",
      timeout: 10000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  const reply = JSON.parse(result.stdout);
  expect(reply.result.content[0].text).toContain('limit は数で指定してください（いま "1"');
  expect(reply.result.content[0].text).toContain("数値に変換しました");
  expect(reply.result.structuredContent.returned).toBe(1);
});

it("starts CLI and MCP through a symbolic launcher in a Japanese workspace path", () => {
  const root = sandbox();
  const entry = join(root, "kamiyobi-mcp.ts");
  symlinkSync(join(root, "src/mcp.ts"), entry);
  expect(run(root, ["search", "GPU", "1"], entry)).toContain("GPU Alpha");
  const result = spawnSync(process.execPath, [entry], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: "起動確認", method: "ping" })}\n`,
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ jsonrpc: "2.0", id: "起動確認", result: {} });
});
