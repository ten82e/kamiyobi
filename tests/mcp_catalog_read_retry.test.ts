import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { REPO_ROOT, tempWork } from "./helpers.ts";

const screenTime = "2030-01-01T00:00:00Z";
const allTime = "2029-12-31T00:00:00Z";
const tools = ["search_deadlines", "list_upcoming", "venue_info"];
function venue(key: string, day: number) {
  return {
    key,
    title: `Distributed systems 分散システム ${key}`,
    categories: ["systems"],
    rank: {},
    editions: [
      {
        id: `${key}30`,
        year: 2030,
        deadlines: [
          {
            kind: "paper",
            utc: `2030-01-0${day}T00:00:00Z`,
            tz_raw: "UTC",
          },
        ],
      },
    ],
  };
}
function client(empty: boolean, { persistent = false, recommendation = false } = {}) {
  const root = tempWork("kamiyobi-catalog-read-retry-");
  for (const dir of ["src", "site"])
    cpSync(join(REPO_ROOT, dir), join(root, dir), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  for (const dir of ["public", "data"]) mkdirSync(join(root, dir));
  const catalog = join(root, "public/catalog.json");
  const snapshot = join(root, "data/snapshot.json");
  writeFileSync(
    catalog,
    JSON.stringify({
      generated_at: screenTime,
      conferences: empty
        ? []
        : [
            {
              ...venue("screen", 5),
              ...(recommendation
                ? {
                    recommendation_axes: {
                      research_fit: { score: null, categories: ["systems"], tags: [] },
                      venue_evidence: {
                        yearsObserved: 9,
                        profileCoverage: 3,
                        dblpLinked: true,
                        publisherSource: false,
                        rankListed: false,
                      },
                      deadline_precision: "exact",
                      evidence_quality: "none",
                      deadline_trust: {
                        date: "unverified",
                        time: "unverified",
                        timezone: "unverified",
                        kind: "unverified",
                        sourceFreshness: "unknown",
                        conflicts: 0,
                      },
                    },
                  }
                : {}),
            },
          ],
    }),
  );
  if (recommendation)
    writeFileSync(
      join(root, "public/recommendation-index.json"),
      JSON.stringify({
        generated_at: screenTime,
        conferences: [venue("screen", 5)],
      }),
    );
  writeFileSync(
    snapshot,
    JSON.stringify({
      snapshot_metadata: { generated_at: allTime },
      conferences: [venue("screen", 6), venue("archive", 7)],
    }),
  );
  const identity = () =>
    [
      catalog,
      snapshot,
      ...(recommendation ? [join(root, "public/recommendation-index.json")] : []),
    ].map((path) => {
      const stat = statSync(path, { bigint: true });
      return [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs];
    });
  const before = identity();
  writeFileSync(
    join(root, "run.mjs"),
    `
import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {runStdio} from "./src/mcp.ts";
const read=fs.readFileSync;
let failures=${persistent ? "Infinity" : "1"};
fs.readFileSync=function(file,...args){
  if(String(file).endsWith("catalog.json")){
    fs.appendFileSync("catalog-reads.txt","read\\n");
    if(failures-- > 0){const error=new Error("injected catalog read failure");error.code="EIO";throw error;}
  }
  return read.call(this,file,...args);
};
syncBuiltinESMExports();
runStdio(Date.parse("2030-01-01T00:00:00Z"));
`,
  );
  const child = spawn(process.execPath, ["run.mjs"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: child.stdout });
  const replies = reader[Symbol.asyncIterator]();
  let id = 0;
  return {
    async request(tool: string, scope = "screen", query?: string) {
      const args =
        tool === "recommend_venues"
          ? { paper: query || "Distributed systems" }
          : tool === "search_venues"
            ? { query: query || "Distributed systems" }
            : tool === "venue_info"
              ? { key: "screen", scope }
              : tool === "list_upcoming"
                ? { kinds: ["paper"], days: 30, scope }
                : { kinds: ["paper"], scope, ...(query ? { query } : {}) };
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: tool, arguments: args } })}\n`,
      );
      const reply = await replies.next();
      if (reply.done) throw new Error("MCP exited before replying");
      const response = JSON.parse(reply.value);
      expect(response.id).toBe(id);
      expect(response.error).toBeUndefined();
      expect(response.result.isError).not.toBe(true);
      return response.result;
    },
    reads() {
      return readFileSync(join(root, "catalog-reads.txt"), "utf8").trim().split("\n").length;
    },
    unchanged() {
      expect(identity()).toEqual(before);
    },
    close() {
      reader.close();
      child.kill();
    },
  };
}
function check(result: any, tool: string, scope: string, fallback: boolean, empty: boolean) {
  const data = result.structuredContent;
  expect(data).toMatchObject({
    scope,
    catalog_fallback: fallback,
    generated_at: scope === "all" ? allTime : screenTime,
  });
  if (tool === "venue_info" && scope === "screen" && empty) {
    expect(data).toMatchObject({
      lookup_status: "out_of_scope",
      available_deadline_total: 1,
      retry_arguments: { key: "screen", scope: "all" },
    });
    expect(data.rows).toBeUndefined();
    return;
  }
  const rows =
    tool === "list_upcoming"
      ? data.items.filter((item: { type: string }) => item.type === "deadline")
      : data.rows;
  const keys =
    scope === "screen"
      ? empty
        ? []
        : ["screen"]
      : tool === "venue_info"
        ? ["screen"]
        : ["screen", "archive"];
  expect(rows.map((row: { venue_key: string }) => row.venue_key)).toEqual(keys);
  if (keys.includes("screen"))
    expect(rows[0].utc).toBe(scope === "screen" ? "2030-01-05T00:00:00Z" : "2030-01-06T00:00:00Z");
  if (fallback) expect(result.content[0].text).toContain("public/catalog.json");
  else expect(result.content[0].text).not.toContain("有効な会議一覧を読み取れないため");
}
it.each(tools.flatMap((tool) => [false, true].map((empty) => ({ tool, empty }))))(
  "$tool retries an unreadable catalog on the next request (empty=$empty)",
  async ({ tool, empty }) => {
    const server = client(empty);
    try {
      check(await server.request(tool), tool, "all", true, empty);
      expect(server.reads()).toBe(1);
      check(await server.request(tool), tool, "screen", false, empty);
      expect(server.reads()).toBe(2);
      for (const next of tools) {
        check(await server.request(next), next, "screen", false, empty);
        check(await server.request(next, "all"), next, "all", false, empty);
      }
      for (const query of ["Distributed systems", "分散システム"])
        check(
          await server.request("search_deadlines", "screen", query),
          "search_deadlines",
          "screen",
          false,
          empty,
        );
      expect(server.reads()).toBe(2);
      server.unchanged();
    } finally {
      server.close();
    }
  },
);
it("keeps fallback consistent within each request while retrying a persistent failure on later requests", async () => {
  const server = client(false, { persistent: true });
  try {
    for (const [i, tool] of tools.entries()) {
      check(await server.request(tool), tool, "all", true, false);
      expect(server.reads()).toBe(i + 1);
    }
    server.unchanged();
  } finally {
    server.close();
  }
});

it("reloads catalog-derived recommendation evidence after a transient read failure", async () => {
  const server = client(false, { recommendation: true });
  try {
    const first = await server.request("recommend_venues");
    expect(first.structuredContent).toMatchObject({
      total: 1,
      rows: [
        { venue_key: "screen", axes: { venue_evidence: { yearsObserved: 1, profileCoverage: 0 } } },
      ],
    });
    expect(server.reads()).toBe(1);
    for (const tool of ["search_venues", "recommend_venues"])
      for (const query of ["Distributed systems", "分散システム"]) {
        const result = await server.request(tool, "screen", query);
        expect(result.structuredContent).toMatchObject({
          total: 1,
          rows: [
            {
              venue_key: "screen",
              axes: { venue_evidence: { yearsObserved: 9, profileCoverage: 3, dblpLinked: true } },
            },
          ],
        });
      }
    expect(server.reads()).toBe(2);
    server.unchanged();
  } finally {
    server.close();
  }
});
