import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT, tempWork } from "./helpers.ts";

const root = tempWork("kamiyobi-mcp-text-inputs-");
for (const dir of ["src", "site", "scripts"])
  cpSync(join(REPO_ROOT, dir), join(root, dir), { recursive: true });
symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
writeFileSync(join(root, "package.json"), '{"type":"module"}');
mkdirSync(join(root, "data"));
mkdirSync(join(root, "public"));
const generatedAt = "2030-01-01T00:00:00Z";
const conferences = [
  {
    key: "gpu",
    title: "GPU Symposium",
    full_name: "GPUメモリ研究会",
    scope: "gpu memory management",
    categories: ["systems"],
  },
  {
    key: "net",
    title: "Network Symposium",
    full_name: "ネットワーク研究会",
    scope: "network routing",
    categories: ["networks"],
  },
  {
    key: "legacy",
    title: "Legacy Symposium",
    full_name: "旧会議",
    scope: "archive",
    categories: [],
  },
].map((venue, index) => ({
  ...venue,
  rank: { core: "A" },
  tags: [],
  editions: [
    {
      id: `${venue.key}-${index === 2 ? 2029 : 2030}`,
      year: index === 2 ? 2029 : 2030,
      estimated: false,
      deadlines: [
        {
          kind: "paper",
          utc: index === 2 ? "2029-12-31T00:00:00Z" : `2030-01-0${index + 3}T00:00:00Z`,
          tz_raw: "UTC",
        },
      ],
    },
  ],
}));
const data = {
  conferences,
  categories: { systems: "Systems", networks: "Networks" },
  generated_at: generatedAt,
  snapshot_metadata: { generated_at: generatedAt },
};
for (const path of [
  "data/snapshot.json",
  "public/catalog.json",
  "public/recommendation-index.json",
])
  writeFileSync(join(root, path), JSON.stringify(data));
writeFileSync(
  join(root, "run.ts"),
  'import {runStdio} from "./src/mcp.ts";globalThis.fetch=async()=>{throw new Error("network forbidden")};runStdio(Date.parse("2030-01-01T00:00:00Z"));',
);
interface Reply {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent?: {
    query?: string;
    total?: number;
    venue_key?: string;
    lookup_status?: string;
    rows?: Array<{ venue_key: string }>;
  };
}
function calls(requests: Array<[string, Record<string, unknown>]>) {
  const child = spawnSync(process.execPath, ["run.ts"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    input: `${requests.map(([name, args], id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })).join("\n")}\n`,
    maxBuffer: 2 * 1024 * 1024,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const replies = child.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(replies).toHaveLength(requests.length);
  return replies.map((reply, id) => {
    expect(reply.id).toBe(id);
    expect(reply.error).toBeUndefined();
    return reply.result as Reply;
  });
}
const text = (reply: Reply) => reply.content.map((part) => part.text).join("\n");
function invalid(reply: Reply, field: string) {
  expect(reply.isError).toBe(true);
  expect(reply.structuredContent).toBeUndefined();
  expect(text(reply)).toContain(`${field} は文字列で指定してください`);
  expect(text(reply)).not.toMatch(/\[object Object\]|undefined|NaN/);
}

it("does not erase malformed deadline queries while applying other valid filters", () => {
  for (const query of [
    {},
    [],
    ["GPU"],
    { title: "GPU memory" },
    { abstract: "GPU memory management" },
  ]) {
    for (const corrected of ["GPU", "メモリ"]) {
      const [bad, good] = calls([
        ["search_deadlines", { query, kind: "paper", rank: "A", within_days: 30, scope: "all" }],
        [
          "search_deadlines",
          { query: corrected, kind: "paper", rank: "A", within_days: 30, scope: "all" },
        ],
      ]);
      invalid(bad, "query");
      expect(good.isError).not.toBe(true);
      expect(good.structuredContent?.total).toBe(1);
      expect(good.structuredContent?.rows?.map((row) => row.venue_key)).toEqual(["gpu"]);
    }
  }
});

it("routes a misplaced paper object to venue search without reconnecting or dropping its abstract", () => {
  const paper = { title: "An investigation", abstract: "GPU memory management" };
  for (const query of [paper, [paper]]) {
    const [bad, good] = calls([
      ["search_deadlines", { query, kind: "paper" }],
      ["search_venues", { query }],
    ]);
    invalid(bad, "query");
    expect(text(bad)).toContain("search_venues");
    expect(good.isError).not.toBe(true);
    expect(good.structuredContent?.rows?.[0].venue_key).toBe("gpu");
  }
});

it("does not turn a malformed explicit venue key into a name lookup", () => {
  for (const key of [{}, [], ["gpu"]]) {
    const [bad, good] = calls([
      ["venue_info", { key, name: "Network" }],
      ["venue_info", { key: "gpu" }],
    ]);
    invalid(bad, "key");
    expect(good.isError).not.toBe(true);
    expect(good.structuredContent?.venue_key).toBe("gpu");
  }
});

it("rejects malformed venue names and explanation words and accepts corrected text on the same connection", () => {
  for (const value of [{}, [], ["GPU"]]) {
    const [badName, goodName, badWord, goodWord] = calls([
      ["venue_info", { name: value }],
      ["venue_info", { name: "Network" }],
      ["explain_word", { word: value }],
      ["explain_word", { word: "GPU" }],
    ]);
    invalid(badName, "name");
    invalid(badWord, "word");
    expect(goodName.isError).not.toBe(true);
    expect(goodName.structuredContent?.venue_key).toBe("net");
    expect(goodWord.isError).not.toBe(true);
    expect(text(goodWord)).toContain("素の照合で 1 行");
  }
});

it("preserves explicit-key precedence and explains unused names without validating them", () => {
  const replies = calls([
    ["venue_info", { key: "gpu", name: {} }],
    ["venue_info", { key: "gpu", name: ["Network"] }],
    ["venue_info", { key: null, name: "Network" }],
    ["venue_info", { key: "gpu", name: "Network" }],
    ["venue_info", { key: "gpu", name: "   " }],
    ["venue_info", { key: "gpu" }],
  ]);
  for (const reply of replies) expect(reply.isError).not.toBe(true);
  expect(replies.map((reply) => reply.structuredContent?.venue_key)).toEqual([
    "gpu",
    "gpu",
    "net",
    "gpu",
    "gpu",
    "gpu",
  ]);
  expect(
    replies.map((reply) => text(reply).includes("name は key と共に与えられたので見ていません")),
  ).toEqual([true, true, false, true, false, false]);
});

it("preserves numeric search terms and deliberately omitted or empty queries", () => {
  const replies = calls([
    ["search_deadlines", { query: 2030, kind: "paper", include_past: true }],
    ["search_deadlines", { query: false, kind: "paper" }],
    ["search_deadlines", { query: null, kind: "paper" }],
    ["search_deadlines", { kind: "paper" }],
    ["search_deadlines", { query: "   ", kind: "paper" }],
    ["search_deadlines", {}],
  ]);
  for (const reply of replies) expect(reply.isError).not.toBe(true);
  expect(replies[0].structuredContent?.query).toBe("2030");
  expect(replies[0].structuredContent?.rows?.map((row) => row.venue_key)).toEqual(["gpu", "net"]);
  expect(replies[1].structuredContent?.query).toBe("false");
  expect(replies[1].structuredContent?.total).toBe(0);
  for (const reply of replies.slice(2, 5)) expect(reply.structuredContent?.total).toBe(2);
  expect(replies[5].structuredContent).toBeUndefined();
  expect(text(replies[5])).toContain("検索語が空です");
});
