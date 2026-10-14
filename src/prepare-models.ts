#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SemanticModelError } from "./semantic-model-error.ts";

export async function prepareModels(root: string, offline = false) {
  const { env } = await import("@huggingface/transformers");
  const runtime = await import("./embedding-runtime.ts");
  const previousCache = env.cacheDir;
  env.cacheDir = join(root, ".cache/embedding-models");
  const models = [
    [runtime.EMBEDDING_MODEL, runtime.EMBEDDING_REVISION],
    [runtime.EMBEDDING_MULTI_MODEL, runtime.EMBEDDING_MULTI_REVISION],
  ];
  try {
    for (const [model, revision] of models) {
      try {
        // Verify the local inference path used by MCP after acquiring pinned weights.
        if (!offline) await runtime.embedEach(model, [runtime.EMBEDDING_PROBE], revision, false);
        const [vector] = await runtime.embedEach(model, [runtime.EMBEDDING_PROBE], revision, true);
        const norm = Math.hypot(...vector);
        if (
          vector.length !== runtime.EMBEDDING_DIM ||
          !vector.every(Number.isFinite) ||
          Math.abs(norm - 1) > 0.001
        )
          throw new Error("model returned an invalid embedding");
      } catch (cause) {
        throw new SemanticModelError(root, model, revision, "load", cause);
      }
    }
    return models.map(([id, revision]) => ({ id, revision }));
  } finally {
    env.cacheDir = previousCache;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    process.stdout.write(
      "英語・日本語の実モデルだけを準備します。会議データは読みません。\n" +
        "使い方: node src/prepare-models.ts [--offline]\n" +
        "--offline: 外部接続せず、保存済みモデルで推論できることを確認します。\n",
    );
    return;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== "--offline"))
    throw new Error("使い方: node src/prepare-models.ts [--offline]");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const models = await prepareModels(root, args[0] === "--offline");
  process.stdout.write(`${JSON.stringify({ ready: true, models })}\n`);
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  void main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
