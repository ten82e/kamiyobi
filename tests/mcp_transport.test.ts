import { spawnSync } from "node:child_process";
import { cpSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT, tempWork } from "./helpers.ts";

function run(input: string) {
  const root = tempWork("kamiyobi-mcp-transport-");
  cpSync(join(REPO_ROOT, "src"), join(root, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "site"), join(root, "site"), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(root, "run.ts"), 'import { runStdio } from "./src/mcp.ts"; runStdio();');
  const result = spawnSync(process.execPath, [join(root, "run.ts")], {
    input,
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
const ping = JSON.stringify({ jsonrpc: "2.0", id: "正常な要求", method: "ping" });

it("does not silently drop a request merely because its method starts with notifications", () => {
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: "ack",
    method: "notifications/initialized",
  });
  const replies = run(`${request}\n${ping}\n`);
  expect(replies).toHaveLength(2);
  expect(replies[0]).toMatchObject({ jsonrpc: "2.0", id: "ack", error: { code: -32601 } });
  expect(replies[1]).toEqual({ jsonrpc: "2.0", id: "正常な要求", result: {} });
});

it.each([
  ["{", -32700, null],
  ["null", -32600, null],
  ["[]", -32600, null],
  ["42", -32600, null],
  ['"text"', -32600, null],
  ['{"jsonrpc":"1.0","id":7,"method":"ping"}', -32600, 7],
  ['{"jsonrpc":"2.0","id":8,"method":42}', -32600, 8],
  ['{"jsonrpc":"2.0","id":null,"method":"ping"}', -32600, null],
  ['{"jsonrpc":"2.0","id":{},"method":"ping"}', -32600, null],
  ['{"jsonrpc":"2.0","id":1.5,"method":"ping"}', -32600, null],
  ['{"jsonrpc":"2.0","id":9,"method":"ping","params":null}', -32602, 9],
  ['{"jsonrpc":"2.0","id":10,"method":"ping","params":[]}', -32602, 10],
  ['{"jsonrpc":"2.0","id":11,"method":"ping","params":"bad"}', -32602, 11],
])("reports malformed message %s and answers the following request", (raw, code, id) => {
  const replies = run(`${raw}\n${ping}\n`);
  expect(replies).toHaveLength(2);
  expect(replies[0]).toMatchObject({ jsonrpc: "2.0", id, error: { code } });
  expect(replies[0]).not.toHaveProperty("result");
  expect(replies[0].error.message).toEqual(expect.any(String));
  expect(replies[1]).toEqual({ jsonrpc: "2.0", id: "正常な要求", result: {} });
});

it("does not reply to notifications, including known request methods and invalid parameters", () => {
  const notifications = [
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", method: "ping" },
    { jsonrpc: "2.0", method: "tools/list" },
    { jsonrpc: "2.0", method: "tools/call", params: null },
    { jsonrpc: "2.0", method: "unknown" },
  ];
  expect(
    run(`${notifications.map((value) => JSON.stringify(value)).join("\n")}\n${ping}\n`),
  ).toEqual([{ jsonrpc: "2.0", id: "正常な要求", result: {} }]);
});

it("preserves zero IDs and processes a final request without a newline at EOF", () => {
  const first = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" });
  expect(run(`${first}\n${ping}`)).toEqual([
    { jsonrpc: "2.0", id: 0, result: {} },
    { jsonrpc: "2.0", id: "正常な要求", result: {} },
  ]);
});
