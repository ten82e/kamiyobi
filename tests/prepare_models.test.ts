import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT } from "./helpers.ts";

for (const args of [["--help"], ["--unknown"], ["--offline", "--offline"]])
  it(`validates model preparation arguments ${args.join(" ")} before loading models`, () => {
    const child = spawnSync(process.execPath, [join(REPO_ROOT, "src/prepare-models.ts"), ...args], {
      encoding: "utf8",
      timeout: 10000,
    });
    expect(child.status).toBe(args[0] === "--help" ? 0 : 1);
    expect(args[0] === "--help" ? child.stdout : child.stderr).toContain("使い方:");
    if (args[0] !== "--help") expect(child.stdout).toBe("");
  });
