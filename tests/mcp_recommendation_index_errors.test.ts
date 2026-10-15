import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { REPO_ROOT, tempWork } from "./helpers.ts";

const path = "public/recommendation-index.json";
const papers = ["Distributed systems network protocols", "分散システム ネットワーク プロトコル"];
function workspace() {
  const root = tempWork("kamiyobi-index-error-");
  for (const dir of ["src", "site"])
    cpSync(join(REPO_ROOT, dir), join(root, dir), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  mkdirSync(join(root, "public"));
  return root;
}
function repair(root: string, key: string) {
  writeFileSync(
    join(root, path),
    JSON.stringify({
      generated_at: "2030-01-01T00:00:00Z",
      conferences: [
        {
          key,
          title: "Distributed systems 分散システム",
          rank: {},
          scope: "Distributed systems network protocols 分散システム ネットワーク プロトコル",
          categories: ["systems"],
          editions: [],
        },
      ],
    }),
  );
}
it("reports index failures and recovers both tools in English and Japanese on the same connection", async () => {
  const root = workspace();
  const child = spawn(process.execPath, ["src/mcp.ts"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: child.stdout });
  const replies = reader[Symbol.asyncIterator]();
  let id = 0;
  async function request(tool: string, paper: string) {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: { name: tool, arguments: tool === "search_venues" ? { query: paper } : { paper } },
      })}\n`,
    );
    const reply = await replies.next();
    if (reply.done) throw new Error("MCP exited before replying");
    const response = JSON.parse(reply.value);
    expect(response.id).toBe(id);
    expect(response.error).toBeUndefined();
    return response.result;
  }
  async function check(code: string, key?: string) {
    for (const tool of ["search_venues", "recommend_venues"])
      for (const paper of papers) {
        const result = await request(tool, paper);
        if (key) {
          expect(result.isError).not.toBe(true);
          expect(result.structuredContent).toMatchObject({
            total: 1,
            candidate_venues: 1,
            rows: [{ venue_key: key }],
          });
          expect(result.structuredContent.error).toBeUndefined();
        } else {
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toEqual({
            error: {
              code,
              path,
              retryable: true,
              recovery_command: "npm run build",
            },
          });
          expect(result.content[0].text).toContain(path);
          expect(result.content[0].text).toContain("npm run build");
          expect(result.content[0].text).not.toContain(root);
        }
      }
  }
  try {
    await check("RECOMMENDATION_INDEX_NOT_READY");
    for (const invalid of [
      "{",
      "null",
      "{}",
      '{"conferences":[]}',
      '{"conferences":[null]}',
      '{"conferences":[[]]}',
    ]) {
      writeFileSync(join(root, path), invalid);
      await check("RECOMMENDATION_INDEX_INVALID");
      repair(root, "repaired");
      await check("", "repaired");
    }
    renameSync(join(root, path), join(root, "saved-index.json"));
    mkdirSync(join(root, path));
    await check("RECOMMENDATION_INDEX_UNREADABLE");
    renameSync(join(root, path), join(root, "unreadable-index"));
    await check("RECOMMENDATION_INDEX_NOT_READY");
    repair(root, "final");
    await check("", "final");
    for (const tool of ["search_venues", "recommend_venues"])
      for (const paper of ["Roman numismatics", "古代ローマの貨幣学"]) {
        const result = await request(tool, paper);
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ total: 0, candidate_venues: 1, rows: [] });
        expect(result.structuredContent.error).toBeUndefined();
      }
  } finally {
    reader.close();
    child.kill();
  }
});

it.each(["search_venues", "recommend"])(
  "%s CLI keeps unavailable-index failures off standard output",
  (tool) => {
    const root = workspace();
    for (const reason of ["missing", "invalid", "unreadable"] as const) {
      if (reason === "invalid") writeFileSync(join(root, path), "{");
      if (reason === "unreadable") {
        renameSync(join(root, path), join(root, "invalid-index.json"));
        mkdirSync(join(root, path));
      }
      for (const flags of [[], ["--json"]]) {
        const child = spawnSync(process.execPath, ["src/mcp.ts", tool, papers[0], ...flags], {
          cwd: root,
          encoding: "utf8",
          timeout: 15000,
        });
        expect(child.status).toBe(1);
        expect(child.stdout).toBe("");
        expect(child.stderr).toContain(path);
        expect(child.stderr).toContain("npm run build");
        expect(child.stderr).not.toContain(root);
        expect(child.stderr).toContain(
          {
            missing: "がありません",
            invalid: "の形式が不正です",
            unreadable: "を読み込めません",
          }[reason],
        );
      }
    }
    renameSync(join(root, path), join(root, "unreadable-index"));
    repair(root, "cli-repaired");
    const child = spawnSync(process.execPath, ["src/mcp.ts", tool, papers[1], "--json"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({
      total: 1,
      rows: [{ venue_key: "cli-repaired" }],
    });
  },
);

it("retries a transient read failure without a file update or a new MCP connection", () => {
  const root = workspace();
  repair(root, "transient");
  const identity = () => {
    const stat = statSync(join(root, path), { bigint: true });
    return [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs];
  };
  const before = identity();
  writeFileSync(
    join(root, "transient.mjs"),
    `
import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {runStdio} from "./src/mcp.ts";
const read=fs.readFileSync;
let fail=true;
fs.readFileSync=function(file,...args){
  if(String(file).endsWith("recommendation-index.json") && fail){
    fail=false;
    const error=new Error("injected transient read failure");
    error.code="EIO";
    throw error;
  }
  return read.call(this,file,...args);
};
syncBuiltinESMExports();
runStdio();
`,
  );
  const requests = [
    { name: "search_venues", arguments: { query: papers[0] } },
    { name: "search_venues", arguments: { query: papers[0] } },
    { name: "recommend_venues", arguments: { paper: papers[0] } },
    { name: "search_venues", arguments: { query: papers[1] } },
    { name: "recommend_venues", arguments: { paper: papers[1] } },
  ];
  const child = spawnSync(process.execPath, ["transient.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
    input: `${requests.map((params, id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params })).join("\n")}\n`,
  });
  expect(child.status, child.stderr).toBe(0);
  const responses = child.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(responses).toHaveLength(requests.length);
  expect(responses[0].result).toMatchObject({
    isError: true,
    structuredContent: { error: { code: "RECOMMENDATION_INDEX_UNREADABLE", path } },
  });
  for (const [i, response] of responses.entries()) {
    expect(response.id).toBe(i);
    expect(response.error).toBeUndefined();
    if (i === 0) continue;
    expect(response.result.isError).not.toBe(true);
    expect(response.result.structuredContent).toMatchObject({
      total: 1,
      candidate_venues: 1,
      rows: [{ venue_key: "transient" }],
    });
  }
  expect(identity()).toEqual(before);
});
