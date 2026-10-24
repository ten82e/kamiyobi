import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  EMBEDDING_MULTI_REVISION,
  EMBEDDING_REVISION,
} from "../src/embedding-runtime.ts";
import { REPO_ROOT, tempWork } from "./helpers.ts";

it.each([
  { language: "en", model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION },
  { language: "ja", model: EMBEDDING_MULTI_MODEL, revision: EMBEDDING_MULTI_REVISION },
])(
  "does not request model files after tokenizer acquisition fails in the real $language CLI",
  ({ language, model, revision }) => {
    const root = tempWork("kamiyobi-tokenizer-failure-cli-");
    cpSync(join(REPO_ROOT, "src"), join(root, "src"), { recursive: true });
    symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    const log = join(root, "requests.jsonl"),
      guard = join(root, "failure.mjs");
    writeFileSync(
      guard,
      `
import {appendFileSync} from 'node:fs';
import {env} from '@huggingface/transformers';
env.fetch=globalThis.fetch=async(input)=>{
 const url=String(input instanceof Request?input.url:input);
 appendFileSync(process.env.MODEL_REQUEST_LOG,JSON.stringify(url)+'\\n');
 return new Response('injected temporary failure',{status:503});
};
`,
    );
    const child = spawnSync(
      process.execPath,
      ["--import", guard, "src/prepare-models.ts", "--language", language],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30000,
        env: { ...process.env, MODEL_REQUEST_LOG: log },
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(1);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("実モデルが未準備");
    expect(child.stderr).toContain(`node src/prepare-models.ts --language ${language}`);
    const requests = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests, "failed tokenizer acquisition must not start model download requests").toEqual(
      [`https://huggingface.co/${model}/resolve/${revision}/tokenizer.json`],
    );
    expect(
      existsSync(join(root, ".cache/embedding-models", model, revision, "onnx/model.onnx")),
    ).toBe(false);
    for (const name of ["public", "data", "embeddings.json"])
      expect(existsSync(join(root, name))).toBe(false);
  },
);
