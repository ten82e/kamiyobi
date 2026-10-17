import { join } from "node:path";
import { env } from "@huggingface/transformers";
import R from "../site/recommendation.ts";
import { profileTexts, topicProfileTexts } from "./embedding-profiles.ts";
import {
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  EMBEDDING_MULTI_REVISION,
  EMBEDDING_REVISION,
  embedEach,
  embedSet,
  embedTopics,
} from "./embedding-runtime.ts";
import { SemanticModelError } from "./semantic-model-error.ts";
import { SemanticProfileCache, semanticProfileKey } from "./semantic-profile-cache.ts";

const profiles = new SemanticProfileCache<{
  embeddings: Record<string, number[]>;
  topics: Awaited<ReturnType<typeof embedTopics>>;
}>(2);
/** Infer profiles from the current index; persisted vectors and paper samples are not inputs. */
export async function semanticVenueScores(
  root: string,
  conferences: unknown[],
  categories: Record<string, string>,
  lines: Parameters<typeof R.semanticQueryPlan>[0],
) {
  env.cacheDir = join(root, ".cache/embedding-models");
  const multi = R.queryHasJapanese(lines);
  const model = multi ? EMBEDDING_MULTI_MODEL : EMBEDDING_MODEL;
  const revision = multi ? EMBEDDING_MULTI_REVISION : EMBEDDING_REVISION;
  const p = profileTexts(conferences, categories, multi, {});
  const t = topicProfileTexts(conferences, categories, multi);
  const key = semanticProfileKey(root, model, revision, p, t);
  const pending = profiles.getOrCreate(key, async () => ({
    embeddings: await embedSet(model, p.texts, p.keys, revision, true),
    topics: await embedTopics(model, t.texts, t.keys, revision, true),
  }));
  const { embeddings, topics } = await pending.catch((cause: unknown) => {
    throw new SemanticModelError(root, model, revision, "load", cause, multi ? "ja" : "en");
  });
  const plan = R.semanticQueryPlan(lines);
  const vectors = await embedEach(
    model,
    plan.map((q) => q.text),
    revision,
    true,
  ).catch((cause: unknown) => {
    throw new SemanticModelError(root, model, revision, "query", cause, multi ? "ja" : "en");
  });
  const vector = R.semanticQueryVector(lines, vectors);
  R.setTopicVecs(topics);
  const keys = conferences.map((c) => String((c as { key: string }).key));
  return {
    model,
    revision,
    scores: Object.fromEntries(keys.map((k) => [k, R.semanticScore(k, vector, embeddings, null)])),
    similarities: Object.fromEntries(
      keys.map((k) => [k, R.semanticSimilarity(k, vector, embeddings, null)]),
    ),
  };
}
