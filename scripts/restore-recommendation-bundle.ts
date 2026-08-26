import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { embeddingsStale, type PublishManifest, writePublishManifest } from "../src/build.ts";
import { embeddingProfileHash } from "../src/embeddings.ts";
import {
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  EMBEDDING_MULTI_REVISION,
  EMBEDDING_REVISION,
  EMBEDDING_RUNTIME_VERSION,
} from "../src/embeddings.ts";
import { computeSemanticContentId } from "../src/semantic-content.ts";

export function restoreRecommendationBundle(bundlePath: string, outdir: string): boolean {
  const bundleDir = bundlePath.endsWith(".json") ? undefined : bundlePath;
  const embeddingsPath = bundleDir ? join(bundleDir, "embeddings.json") : bundlePath;
  const manifestPath = bundleDir ? join(bundleDir, "recommendation-bundle.json") : "";
  if (!existsSync(embeddingsPath) || !manifestPath || !existsSync(manifestPath)) return false;
  const data = JSON.parse(readFileSync(join(outdir, "data.json"), "utf8"));
  const bundle = JSON.parse(readFileSync(embeddingsPath, "utf8"));
  const attestation = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const publish = JSON.parse(readFileSync(join(outdir, "publish.json"), "utf8")) as PublishManifest;
  const hash = createHash("sha256").update(readFileSync(embeddingsPath)).digest("hex");
  // 公開 commit と bundle の生成元 commit は別物 (reuse では origin commit を保持する)。
  // 現在の data から content id を再計算し、semantic 内容が一致することだけを要求する。
  const currentContentId = computeSemanticContentId({
    profileHash: embeddingProfileHash(data),
    rerankerHash: createHash("sha256")
      .update(readFileSync("data/recommender-reranker.json"))
      .digest("hex"),
    algorithmRevision: String(
      (
        JSON.parse(readFileSync("data/recommender-reranker.json", "utf8")) as Record<
          string,
          unknown
        >
      ).algorithm_revision ?? "",
    ),
    featureSchema: ((
      JSON.parse(readFileSync("data/recommender-reranker.json", "utf8")) as Record<string, unknown>
    ).feature_schema ?? []) as string[],
    embeddingModel: EMBEDDING_MODEL,
    embeddingRevision: EMBEDDING_REVISION,
    multilingualModel: EMBEDDING_MULTI_MODEL,
    multilingualRevision: EMBEDDING_MULTI_REVISION,
    runtimeVersion: EMBEDDING_RUNTIME_VERSION,
  });
  if (
    // semantic 公開には required gate と full benchmark の両方の合格が必要。
    attestation.required_gate !== "passed" ||
    attestation.full_benchmark !== "passed" ||
    attestation.semantic_content_id !== currentContentId ||
    attestation.embeddings_sha256 !== hash
  )
    return false;
  if (embeddingsStale(bundle, data)) return false;
  copyFileSync(embeddingsPath, join(outdir, "embeddings.json"));
  writePublishManifest(
    outdir,
    [...Object.keys(publish.artifacts), "embeddings.json"],
    new Date(publish.generated_at),
    "ready",
  );
  return true;
}

if (process.argv[1] && basename(process.argv[1]) === "restore-recommendation-bundle.ts") {
  const [bundle, outdir = "public"] = process.argv.slice(2);
  if (!bundle)
    throw new Error("usage: node scripts/restore-recommendation-bundle.ts <bundle> [out]");
  console.log(
    restoreRecommendationBundle(resolve(bundle), resolve(outdir))
      ? "restored compatible recommendation bundle"
      : "compatible recommendation bundle unavailable; publishing lexical-only",
  );
}
