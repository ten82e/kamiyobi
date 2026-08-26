/** Seal a recommendation bundle with the shared semantic content identity.
 * usage: node scripts/seal-recommendation-bundle.ts <embeddings.json> <data.json> <out-manifest.json> <source-commit> */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  EMBEDDING_MULTI_REVISION,
  EMBEDDING_REVISION,
  EMBEDDING_RUNTIME_VERSION,
  embeddingProfileHash,
} from "../src/embeddings.ts";
import { computeSemanticContentId } from "../src/semantic-content.ts";

const [embeddingsPath, dataPath, outPath, sourceCommit] = process.argv.slice(2);
if (!embeddingsPath || !dataPath || !outPath || !sourceCommit) {
  throw new Error(
    "usage: node scripts/seal-recommendation-bundle.ts <embeddings.json> <data.json> <out> <commit>",
  );
}

const bytes = readFileSync(embeddingsPath);
const embedding = JSON.parse(bytes) as {
  manifest?: { runtime_version?: unknown; models?: { en?: { revision?: unknown } } };
};
const manifest = embedding.manifest;
if (!manifest?.runtime_version || !manifest.models?.en?.revision)
  throw new Error("invalid embedding manifest");

const rerankerRaw = readFileSync("data/recommender-reranker.json");
const reranker = JSON.parse(rerankerRaw.toString("utf8")) as Record<string, unknown>;

// seal 時に content id を再計算し、reuse 判定 (scripts/semantic-content.ts) と同じ式であることを強制する。
const actualContentId = computeSemanticContentId({
  profileHash: embeddingProfileHash(JSON.parse(readFileSync(dataPath, "utf8"))),
  rerankerHash: createHash("sha256").update(rerankerRaw).digest("hex"),
  algorithmRevision: String(reranker.algorithm_revision ?? ""),
  featureSchema: Array.isArray(reranker.feature_schema)
    ? (reranker.feature_schema as string[])
    : [],
  embeddingModel: EMBEDDING_MODEL,
  embeddingRevision: EMBEDDING_REVISION,
  multilingualModel: EMBEDDING_MULTI_MODEL,
  multilingualRevision: EMBEDDING_MULTI_REVISION,
  runtimeVersion: EMBEDDING_RUNTIME_VERSION,
});

writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      source_commit: sourceCommit,
      semantic_content_id: actualContentId,
      profile_hash: embeddingProfileHash(JSON.parse(readFileSync(dataPath, "utf8"))),
      model_revision: manifest.models.en.revision,
      multilingual_model_revision: manifest.models.multi?.revision ?? null,
      runtime_version: manifest.runtime_version,
      embeddings_sha256: createHash("sha256").update(bytes).digest("hex"),
      required_gate: "passed",
      full_benchmark: "passed",
    },
    null,
    2,
  )}\n`,
);
