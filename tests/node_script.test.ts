import { expect, it } from "vitest";
import { spawnScript } from "./node_script.ts";

it("executes generated programs larger than the Linux single-argument limit", () => {
  const source = `const text = ${JSON.stringify("日".repeat(70000))}; console.log(text.length);`;
  expect(Buffer.byteLength(source)).toBeGreaterThan(128 * 1024);
  const result = spawnScript("node", ["-e", source], { encoding: "utf8", timeout: 10000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("70000");
});

it("preserves explicit module mode, failure status, and diagnostics", () => {
  const result = spawnScript(
    "node",
    ["--input-type=module", "-e", "throw new Error('fixture failure')"],
    {
      encoding: "utf8",
      timeout: 10000,
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("fixture failure");
});
