import { readFileSync, writeFileSync } from "node:fs";
import { env } from "@huggingface/transformers";

import {
  EMBEDDING_MODEL,
  EMBEDDING_REVISION,
  embedVenueProfileTitles,
  selectVenueMedoids,
  serializeVenueProfileArtifact,
  type VenueProfilePaper,
} from "../src/embeddings.ts";

const [inputPath, outputPath] = process.argv.slice(2);

if (!inputPath || !outputPath) {
  console.error("usage: node scripts/generate-venue-profiles.ts <input.json> <output.json>");
  process.exitCode = 2;
} else {
  // Generation is intentionally reproducible from the pinned local model cache.
  env.allowRemoteModels = false;
  const input = JSON.parse(readFileSync(inputPath, "utf8"));
  const policy = {
    ...input.policy,
    method: "fixed-title-embedding-k-medoids",
    embedding_model: EMBEDDING_MODEL,
    embedding_revision: EMBEDDING_REVISION,
  };
  const titles = Object.values(
    input.profiles as Record<string, { papers: VenueProfilePaper[] }>,
  ).flatMap((profile) => profile.papers.map((paper) => paper.title));
  const vectors = await embedVenueProfileTitles(titles);
  const profiles = Object.fromEntries(
    Object.entries(input.profiles as Record<string, { papers: VenueProfilePaper[] }>).map(
      ([key, profile]) => [
        key,
        {
          ...profile,
          selection: policy,
          prototypes: selectVenueMedoids(profile.papers, policy.max_prototypes, vectors).map(
            (paper) => paper.title,
          ),
        },
      ],
    ),
  );
  writeFileSync(outputPath, serializeVenueProfileArtifact({ ...input, policy, profiles }));
}
