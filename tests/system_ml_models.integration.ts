import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { env } from "@huggingface/transformers";
import { afterAll, beforeAll, expect, it } from "vitest";
import R from "../site/recommendation.ts";
import { profileTexts, topicProfileTexts } from "../src/embedding-profiles.ts";
import {
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  EMBEDDING_MULTI_REVISION,
  EMBEDDING_REVISION,
  embedEach,
  embedSet,
  embedTopics,
} from "../src/embedding-runtime.ts";
import { freshFullVenuePool } from "./full_venue_pool.ts";

const titles = [
  "GPUクラスタにおける深層学習ジョブのスケジューリング",
  "Scheduling Deep Learning Jobs on GPU Clusters",
  "GREEN: Carbon-efficient Resource Scheduling for Machine Learning Clusters",
];
const results = new Map<string, string[]>();
const previousCache = env.cacheDir;
let raw: string;

beforeAll(async () => {
  const pool = freshFullVenuePool();
  raw = pool.raw;
  const conferences = pool.conferences.map((c) => ({ ...c, papers: [] }));
  expect(conferences).toHaveLength(696);
  const now = Date.UTC(2026, 9, 20);
  const rows = R.candidatePool(R.candidateRows({ conferences }), conferences, now);
  R.setNameIdf(R.buildNameIdf(conferences));
  R.setPaperVecs(null);
  R.setReranker(
    JSON.parse(
      readFileSync(join(import.meta.dirname, "../data/recommender-reranker.json"), "utf8"),
    ),
  );
  env.cacheDir = join(import.meta.dirname, "../.cache/embedding-models");
  for (const japanese of [false, true]) {
    const model = japanese ? EMBEDDING_MULTI_MODEL : EMBEDDING_MODEL;
    const revision = japanese ? EMBEDDING_MULTI_REVISION : EMBEDDING_REVISION;
    const profiles = profileTexts(conferences, pool.categoryNames, japanese, {});
    const topicProfiles = topicProfileTexts(conferences, pool.categoryNames, japanese);
    const embeddings = await embedSet(model, profiles.texts, profiles.keys, revision);
    const topics = await embedTopics(model, topicProfiles.texts, topicProfiles.keys, revision);
    R.setTopicVecs(topics);
    for (const title of titles) {
      const lines = R.parsePaperLines(title);
      if (R.queryHasJapanese(lines) !== japanese) continue;
      const plan = R.semanticQueryPlan(lines);
      const query = R.semanticQueryVector(
        lines,
        await embedEach(
          model,
          plan.map((entry) => entry.text),
          revision,
          true,
        ),
      );
      const similarities = Object.fromEntries(
        profiles.keys.map((key) => [
          key,
          R.semanticSimilarity(key, query, embeddings, null, topics),
        ]),
      );
      const scores = Object.fromEntries(
        profiles.keys.map((key) => [key, R.semanticScore(key, query, embeddings, null, topics)]),
      );
      results.set(
        title,
        R.venueRecommendations(rows, lines, scores, now, {
          fieldedLexical: true,
          semanticSimilarities: similarities,
          venueCats: R.autoDetectCats(lines),
        })
          .slice(0, 5)
          .map((entry) => entry.venueKey),
      );
    }
  }
}, 600000);

afterAll(() => {
  env.cacheDir = previousCache;
  R.setTopicVecs(null);
  if (raw) rmSync(raw, { recursive: true, force: true });
});

it.each(titles)("includes systems-for-ML venues for %s across the complete venue pool", (title) => {
  const top = results.get(title);
  expect(top, title).toHaveLength(5);
  expect(
    top?.some((key) => ["mlsys", "sc"].includes(key)),
    JSON.stringify(top),
  ).toBe(true);
});
