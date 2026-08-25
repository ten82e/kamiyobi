import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { embeddingsStale, type PublishManifest, writePublishManifest } from "../src/build.ts";

export function restoreRecommendationBundle(bundlePath: string, outdir: string): boolean {
  if (!existsSync(bundlePath)) return false;
  const data = JSON.parse(readFileSync(join(outdir, "data.json"), "utf8"));
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  if (embeddingsStale(bundle, data)) return false;
  copyFileSync(bundlePath, join(outdir, "embeddings.json"));
  const manifest = JSON.parse(
    readFileSync(join(outdir, "publish.json"), "utf8"),
  ) as PublishManifest;
  writePublishManifest(
    outdir,
    [...Object.keys(manifest.artifacts), "embeddings.json"],
    new Date(manifest.generated_at),
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
