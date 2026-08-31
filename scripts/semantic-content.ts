/** CLI: print the semantic_content_id for the current tree (bundle reuse + seal share this).
 * usage: node scripts/semantic-content.ts [data.json] [reranker.json]
 * profile hash は embeddings.ts の embeddingProfileHash と同一定義 (built data から計算)。 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  EMBEDDING_MULTI_REVISION,
  EMBEDDING_REVISION,
  EMBEDDING_RUNTIME_VERSION,
  embeddingProfileHash,
} from "../src/embeddings.ts";
import { computeSemanticContentId } from "../src/semantic-content.ts";

const dataPath = process.argv[2] ?? "public/data.json";
const rerankerPath = process.argv[3] ?? "data/recommender-reranker.json";

if (process.argv[1]?.endsWith("semantic-content.ts")) {
  const reranker = JSON.parse(readFileSync(rerankerPath, "utf8")) as Record<string, unknown>;
  const data = JSON.parse(readFileSync(dataPath, "utf8"));
  const inputs = {
    profileHash: embeddingProfileHash(data),
    rerankerHash: createHash("sha256").update(readFileSync(rerankerPath)).digest("hex"),
    algorithmRevision: String(reranker.algorithm_revision ?? ""),
    featureSchema: Array.isArray(reranker.feature_schema)
      ? (reranker.feature_schema as string[])
      : [],
    embeddingModel: EMBEDDING_MODEL,
    embeddingRevision: EMBEDDING_REVISION,
    multilingualModel: EMBEDDING_MULTI_MODEL,
    multilingualRevision: EMBEDDING_MULTI_REVISION,
    runtimeVersion: EMBEDDING_RUNTIME_VERSION,
  };
  for (const [key, value] of Object.entries(inputs)) {
    if (!value || (Array.isArray(value) && value.length === 0))
      throw new Error(`semantic content input missing: ${key}`);
  }
  process.stdout.write(computeSemanticContentId(inputs));
}
