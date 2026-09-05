/** Single source of truth for the sealed-bundle content identity.
 * Used by bundle sealing, reuse checks, and restore validation so the formula
 * can never drift between call sites. */
import { createHash } from "node:crypto";
import {
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  EMBEDDING_MULTI_REVISION,
  EMBEDDING_REVISION,
  EMBEDDING_RUNTIME_VERSION,
  embeddingProfileHash,
} from "./embeddings.ts";

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
