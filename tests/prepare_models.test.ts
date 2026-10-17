import { spawnSync } from "node:child_process";
import { cpSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT, tempWork } from "./helpers.ts";

for (const args of [
  ["--help"],
  ["--unknown"],
  ["--offline", "--offline"],
  ["--language"],
  ["--language", "unknown"],
  ["--language", "en", "--language", "ja"],
  ["--offline", "--language", "--offline"],
])
  it(`validates model preparation arguments ${args.join(" ")} before loading models`, () => {
    const child = spawnSync(process.execPath, [join(REPO_ROOT, "src/prepare-models.ts"), ...args], {
      encoding: "utf8",
      timeout: 10000,
    });
    expect(child.status).toBe(args[0] === "--help" ? 0 : 1);
    expect(args[0] === "--help" ? child.stdout : child.stderr).toContain("使い方:");
    if (args[0] !== "--help") expect(child.stdout).toBe("");
  });

it.each([
  { args: ["--offline", "--language", "en"], model: "Xenova/all-MiniLM-L6-v2", language: "en" },
  {
    args: ["--language", "ja", "--offline"],
    model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    language: "ja",
  },
  { args: ["--language", "both", "--offline"], model: "Xenova/all-MiniLM-L6-v2", language: "en" },
])(
  "selects $language through CLI parsing before reporting missing local weights",
  ({ args, model, language }) => {
    const root = tempWork("kamiyobi-prepare-selection-cli-");
    cpSync(join(REPO_ROOT, "src"), join(root, "src"), { recursive: true });
    symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    const guard = join(root, "offline-guard.mjs");
    writeFileSync(
      guard,
      'import {env} from "@huggingface/transformers";env.allowRemoteModels=false;env.fetch=globalThis.fetch=async()=>{throw new Error("network forbidden")};',
    );
    const child = spawnSync(
      process.execPath,
      ["--import", guard, join(root, "src/prepare-models.ts"), ...args],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30000,
      },
    );
    expect(child.status, child.stderr).toBe(1);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain(`対象モデル: ${model}@`);
    expect(child.stderr).toContain(`準備: node src/prepare-models.ts --language ${language}`);
    expect(child.stderr).not.toContain(root);
    for (const name of ["data", "public", ".cache/embedding-models/Xenova"])
      expect(existsSync(join(root, name))).toBe(false);
  },
);
