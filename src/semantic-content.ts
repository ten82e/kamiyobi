/** Single source of truth for the sealed-bundle content identity.
 * Used by bundle sealing, reuse checks, and restore validation so the formula
 * can never drift between call sites. */
import { createHash } from "node:crypto";

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
