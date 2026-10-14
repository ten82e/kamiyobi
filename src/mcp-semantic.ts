import { createHash } from "node:crypto";
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

const profiles = new Map<
  string,
  Promise<{ embeddings: Record<string, number[]>; topics: Awaited<ReturnType<typeof embedTopics>> }>
>();
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
  const key = createHash("sha256")
    .update(JSON.stringify({ root, model, revision, conferences, categories }))
    .digest("hex");
  let pending = profiles.get(key);
  if (!pending) {
    pending = (async () => {
      const p = profileTexts(conferences, categories, multi, {});
      const t = topicProfileTexts(conferences, categories, multi);
      return {
        embeddings: await embedSet(model, p.texts, p.keys, revision, true),
        topics: await embedTopics(model, t.texts, t.keys, revision, true),
      };
    })();
    profiles.set(key, pending);
    void pending.catch(() => profiles.delete(key));
  }
  const { embeddings, topics } = await pending;
  const plan = R.semanticQueryPlan(lines);
  const vectors = await embedEach(
    model,
    plan.map((q) => q.text),
    revision,
    true,
  );
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
