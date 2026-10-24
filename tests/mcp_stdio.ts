import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { REPO_ROOT, tempWork } from "./helpers.ts";

export type McpCall = [string, Record<string, unknown>];

export function createMcpSandbox(prefix: string, now: string): string {
  const root = tempWork(prefix);
  for (const dir of ["src", "site", "scripts"])
    cpSync(join(REPO_ROOT, dir), join(root, dir), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  for (const dir of ["data", "public"]) mkdirSync(join(root, dir));
  writeFileSync(
    join(root, "run.ts"),
    `import {runStdio} from "./src/mcp.ts";globalThis.fetch=async()=>{throw new Error("network forbidden")};runStdio(Date.parse(${JSON.stringify(now)}));`,
  );
  return root;
}

export function callMcp<T>(root: string, requests: McpCall[]): T[] {
  const child = spawnSync(process.execPath, ["run.ts"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    input: `${requests.map(([name, args], id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })).join("\n")}\n`,
    maxBuffer: 4 * 1024 * 1024,
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
    return reply.result as T;
  });
}
