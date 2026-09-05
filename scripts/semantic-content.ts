/** CLI: print the semantic_content_id for the current tree (bundle reuse + seal share this).
 * usage: node scripts/semantic-content.ts [data.json] [reranker.json]
 * profile hash は embeddings.ts の embeddingProfileHash と同一定義 (built data から計算)。 */
import { readFileSync } from "node:fs";
import { semanticContentIdForArtifacts } from "../src/semantic-content.ts";

const dataPath = process.argv[2] ?? "public/data.json";
const rerankerPath = process.argv[3] ?? "data/recommender-reranker.json";

if (process.argv[1]?.endsWith("semantic-content.ts")) {
  const data = JSON.parse(readFileSync(dataPath, "utf8"));
  process.stdout.write(semanticContentIdForArtifacts(data, readFileSync(rerankerPath)));
}
