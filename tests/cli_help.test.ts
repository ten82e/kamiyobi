import { spawnSync } from "node:child_process";
import { cpSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT, tempWork } from "./helpers.ts";

it("opens actual command help without generated profiles or published data", () => {
  const root = tempWork("kamiyobi-args-help-");
  for (const dir of ["src", "site", "scripts"])
    cpSync(join(REPO_ROOT, dir), join(root, dir), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  const result = spawnSync(process.execPath, [join(root, "src/cli.ts"), "--help"], {
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("--offline");
  expect(result.stdout).toContain("--max-pages");
  expect(result.stderr).toBe("");
  expect(existsSync(join(root, "data"))).toBe(false);
  expect(existsSync(join(root, "public"))).toBe(false);
});
