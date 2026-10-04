/** Single source of truth for the sealed-bundle content identity.
 * Used by bundle sealing, reuse checks, and restore validation so the formula
 * can never drift between call sites. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  EMBEDDING_MULTI_REVISION,
  EMBEDDING_REVISION,
  EMBEDDING_RUNTIME_VERSION,
  embeddingProfileHash,
} from "./embeddings.ts";

// Semantic data may stay unchanged while fixtures, floors or gate wiring change.
// Keep that policy identity separate so deadline-only updates can still reuse a
// bundle, but an older gate cannot attest a newer gate's result.
export const RECOMMENDATION_GATE_INPUTS = [
  "data/benchmarks/real-paper-feature-baseline.json",
  "data/benchmarks/real-paper-features.jsonl",
  "data/benchmarks/real-paper-required-dev.json",
  "data/benchmarks/real-paper-required-heldout.json",
  "data/benchmarks/real-paper-dev.json",
  "data/benchmarks/real-paper-heldout.json",
  "data/benchmarks/real-paper-negative.json",
  "data/benchmarks/real-paper-required-manifest.json",
  "data/benchmarks/real-paper-dev-manifest.json",
  "data/benchmarks/real-paper-heldout-manifest.json",
  "data/benchmarks/regression-known.json",
  "data/venue-profiles.json",
  "data/recommender-reranker.json",
  "src/bench-recommender.ts",
  "src/args.ts",
  "src/util.ts",
  "src/embeddings.ts",
  "src/build.ts",
  "src/semantic-content.ts",
  "site/recommendation-core.ts",
  "site/recommender.ts",
  "site/latin-retype.ts",
  "site/place-aliases.ts",
  "site/topic-aliases.ts",
  "scripts/seal-recommendation-bundle.ts",
  "scripts/restore-recommendation-bundle.ts",
  "scripts/semantic-content.ts",
  ".github/workflows/ci.yml",
  ".github/workflows/nightly.yml",
  ".github/workflows/recommendation-bundle.yml",
  ".github/workflows/deploy.yml",
  "package-lock.json",
  "package.json",
] as const;

export function recommendationGatePolicyId(root = new URL("../", import.meta.url)): string {
  const inputs = RECOMMENDATION_GATE_INPUTS.map((path) => [
    path,
    createHash("sha256")
      .update(readFileSync(new URL(path, root)))
      .digest("hex"),
  ]);
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, inputs }))
    .digest("hex");
}

export interface SemanticContentInputs {
  profileHash: string;
  rerankerHash: string;
  algorithmRevision: string;
  featureSchema: readonly string[];
  embeddingModel: string;
  embeddingRevision: string;
  multilingualModel: string;
  multilingualRevision: string;
  runtimeVersion: string;
}

export function computeSemanticContentId(inputs: SemanticContentInputs): string {
  return createHash("sha256")
    .update(
      [
        inputs.profileHash,
        inputs.rerankerHash,
        inputs.algorithmRevision,
        inputs.featureSchema.join("\0"),
        `${inputs.embeddingModel}@${inputs.embeddingRevision}`,
        `${inputs.multilingualModel}@${inputs.multilingualRevision}`,
        inputs.runtimeVersion,
      ].join("\0"),
    )
    .digest("hex");
}

export function semanticContentIdForArtifacts(data: unknown, rerankerRaw: Buffer): string {
  const reranker = JSON.parse(rerankerRaw.toString("utf8")) as Record<string, unknown>;
  const featureSchema = reranker.feature_schema;
  if (
    !Array.isArray(featureSchema) ||
    featureSchema.length === 0 ||
    featureSchema.some((value) => typeof value !== "string" || value.trim() !== value || !value) ||
    new Set(featureSchema).size !== featureSchema.length
  )
    throw new Error("invalid reranker feature_schema");
  const algorithmRevision = reranker.algorithm_revision;
  if (
    typeof algorithmRevision !== "string" ||
    !algorithmRevision ||
    algorithmRevision.trim() !== algorithmRevision
  )
    throw new Error("invalid reranker algorithm_revision");
  const inputs = {
    profileHash: embeddingProfileHash(data as Parameters<typeof embeddingProfileHash>[0]),
    rerankerHash: createHash("sha256").update(rerankerRaw).digest("hex"),
    algorithmRevision,
    featureSchema,
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
  return computeSemanticContentId(inputs);
}
