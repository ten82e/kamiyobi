#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SemanticModelError } from "./semantic-model-error.ts";

export async function prepareModels(
  root: string,
  offline = false,
  language: "en" | "ja" | "both" = "both",
) {
  if (!["en", "ja", "both"].includes(language))
    throw new Error("language は en・ja・both のいずれかを指定してください。");
  const { env } = await import("@huggingface/transformers");
  const runtime = await import("./embedding-runtime.ts");
  const previousCache = env.cacheDir;
  env.cacheDir = join(root, ".cache/embedding-models");
  const available = [
    [runtime.EMBEDDING_MODEL, runtime.EMBEDDING_REVISION],
    [runtime.EMBEDDING_MULTI_MODEL, runtime.EMBEDDING_MULTI_REVISION],
  ];
  const models = language === "both" ? available : [available[language === "en" ? 0 : 1]];
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
        throw new SemanticModelError(
          root,
          model,
          revision,
          "load",
          cause,
          model === runtime.EMBEDDING_MODEL ? "en" : "ja",
        );
      }
    }
    return models.map(([id, revision]) => ({ id, revision }));
  } finally {
    env.cacheDir = previousCache;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const usage = "使い方: node src/prepare-models.ts [--offline] [--language en|ja|both]";
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    process.stdout.write(
      "英語・日本語の実モデルだけを準備します。会議データは読みません。\n" +
        `${usage}\n` +
        "--language: en は英語、ja は日本語、both は両方（既定）。\n" +
        "--offline: 外部接続せず、保存済みモデルで推論できることを確認します。\n",
    );
    return;
  }
  let offline = false;
  let language: "en" | "ja" | "both" = "both";
  let hasLanguage = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--offline" && !offline) offline = true;
    else if (args[i] === "--language" && !hasLanguage) {
      const value = args[++i];
      if (value !== "en" && value !== "ja" && value !== "both") throw new Error(usage);
      language = value;
      hasLanguage = true;
    } else throw new Error(usage);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const models = await prepareModels(root, offline, language);
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
