import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { embeddingsStale, type PublishManifest, writePublishManifest } from "../src/build.ts";

export function restoreRecommendationBundle(bundlePath: string, outdir: string): boolean {
  const bundleDir = bundlePath.endsWith(".json") ? undefined : bundlePath;
  const embeddingsPath = bundleDir ? join(bundleDir, "embeddings.json") : bundlePath;
  const manifestPath = bundleDir ? join(bundleDir, "recommendation-bundle.json") : "";
  if (!existsSync(embeddingsPath) || !manifestPath || !existsSync(manifestPath)) return false;
  const data = JSON.parse(readFileSync(join(outdir, "data.json"), "utf8"));
  const bundle = JSON.parse(readFileSync(embeddingsPath, "utf8"));
  const attestation = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const publish = JSON.parse(readFileSync(join(outdir, "publish.json"), "utf8")) as PublishManifest;
  const embeddingManifest = bundle.manifest as Record<string, unknown> | undefined;
  const model = embeddingManifest?.models as { en?: { revision?: unknown } } | undefined;
  const hash = createHash("sha256").update(readFileSync(embeddingsPath)).digest("hex");
  if (
    // semantic 公開には required gate と full benchmark の両方の合格が必要。
    attestation.required_gate !== "passed" ||
    attestation.full_benchmark !== "passed" ||
    attestation.source_commit !== publish.source_commit ||
    attestation.profile_hash !== embeddingManifest?.profile_hash ||
    attestation.runtime_version !== embeddingManifest?.runtime_version ||
    attestation.model_revision !== model?.en?.revision ||
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
