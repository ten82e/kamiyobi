export type PublishManifest = {
  schema_version: 2 | 3;
  build_id: string;
  profile_hash: string;
  semantic_status: "ready" | "lexical-only";
  artifacts: Record<string, { bytes: number; sha256: string }>;
  source_commit?: string | null;
  data_commit?: string | null;
  workflow_run_id?: string | null;
  dirty_worktree?: boolean | null;
  inputs?: Record<string, { sha256: string }>;
  promotion_batches?: Array<{ id: string; sha256: string }>;
  build?: {
    now: string;
    offline: boolean | null;
    node: string;
    command: string;
    source_cache: "offline-with-snapshot-fallback" | "online-refresh" | "unspecified";
  };
};

export type SemanticState = { semantic: boolean; reason: string | null };

type RecommendationIndex = {
  build_id?: unknown;
  embedding_manifest?: { profile_hash?: unknown };
  conferences?: unknown;
};

type Embeddings = { manifest?: { profile_hash?: unknown } };

function validSchema3Provenance(manifest: PublishManifest): boolean {
  const nullableString = (value: unknown): boolean => value === null || typeof value === "string";
  return (
    nullableString(manifest.source_commit) &&
    nullableString(manifest.data_commit) &&
    nullableString(manifest.workflow_run_id) &&
    (manifest.dirty_worktree === null || typeof manifest.dirty_worktree === "boolean") &&
    manifest.inputs !== undefined &&
    manifest.promotion_batches !== undefined &&
    manifest.build !== undefined &&
    typeof manifest.build.now === "string" &&
    !Number.isNaN(Date.parse(manifest.build.now)) &&
    (manifest.build.offline === null || typeof manifest.build.offline === "boolean") &&
    typeof manifest.build.node === "string" &&
    typeof manifest.build.command === "string" &&
    ["offline-with-snapshot-fallback", "online-refresh", "unspecified"].includes(
      manifest.build.source_cache,
    ) &&
    Object.values(manifest.inputs ?? {}).every(
      (input) => typeof input?.sha256 === "string" && /^[0-9a-f]{64}$/.test(input.sha256),
    ) &&
    (manifest.promotion_batches ?? []).every(
      (batch) =>
        typeof batch?.id === "string" &&
        typeof batch.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(batch.sha256),
    )
  );
}

export async function verifyPublishArtifact(
  manifest: PublishManifest,
  name: string,
  text: string,
): Promise<boolean> {
  const artifact = manifest.artifacts[name];
  if (!artifact || new TextEncoder().encode(text).byteLength !== artifact.bytes) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hash = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return hash === artifact.sha256;
}

/** Validate the manifest-bound browser payload without disabling lexical recommendation. */
export async function loadPublishedRecommendation(
  fetchText: (name: string) => Promise<string>,
  fallback: RecommendationIndex,
): Promise<{ index: RecommendationIndex; embeddings: Embeddings | null; state: SemanticState }> {
  let manifest: PublishManifest;
  let indexText: string;
  try {
    manifest = JSON.parse(await fetchText("publish.json")) as PublishManifest;
    if (
      (manifest.schema_version !== 2 && manifest.schema_version !== 3) ||
      !manifest.build_id ||
      !manifest.profile_hash ||
      (manifest.schema_version === 3 && !validSchema3Provenance(manifest))
    ) {
      throw new Error("manifest schema/build_id/profile_hash mismatch");
    }
    indexText = await fetchText("recommendation-index.json");
    if (!(await verifyPublishArtifact(manifest, "recommendation-index.json", indexText))) {
      throw new Error("recommendation-index hash mismatch");
    }
  } catch {
    return {
      index: fallback,
      embeddings: null,
      state: { semantic: false, reason: "manifest/index unavailable" },
    };
  }
  let index: RecommendationIndex;
  try {
    index = JSON.parse(indexText) as RecommendationIndex;
    if (!Array.isArray(index.conferences)) throw new Error("index structure mismatch");
  } catch {
    return {
      index: fallback,
      embeddings: null,
      state: { semantic: false, reason: "index structure mismatch" },
    };
  }
  if (index.build_id !== manifest.build_id) {
    return {
      index,
      embeddings: null,
      state: { semantic: false, reason: "index build_id mismatch" },
    };
  }
  if (manifest.semantic_status !== "ready") {
    return {
      index,
      embeddings: null,
      state: { semantic: false, reason: "semantic_status lexical-only" },
    };
  }
  try {
    const text = await fetchText("embeddings.json");
    if (!(await verifyPublishArtifact(manifest, "embeddings.json", text))) throw new Error();
    const embeddings = JSON.parse(text) as Embeddings;
    if (
      index.embedding_manifest?.profile_hash !== manifest.profile_hash ||
      embeddings.manifest?.profile_hash !== manifest.profile_hash
    ) {
      throw new Error("profile mismatch");
    }
    return { index, embeddings, state: { semantic: true, reason: null } };
  } catch (error) {
    return {
      index,
      embeddings: null,
      state: {
        semantic: false,
        reason: error instanceof Error && error.message ? error.message : "embeddings mismatch",
      },
    };
  }
}
