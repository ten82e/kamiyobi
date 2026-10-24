import { mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { env } from "@huggingface/transformers";
import { afterAll, beforeAll, expect, it } from "vitest";
import R from "../site/recommendation.ts";
import * as runtime from "../src/embedding-runtime.ts";
import { semanticVenueScores } from "../src/mcp-semantic.ts";
import { prepareLiveConsumerSite } from "./live_consumer_site.ts";

const repo = join(import.meta.dirname, "..");
const previousCache = env.cacheDir;
let root: string;
let index: { conferences: Array<Record<string, unknown>>; categories: Record<string, string> };
beforeAll(async () => {
  env.cacheDir = join(repo, ".cache/embedding-models");
  await runtime.embedEach(
    runtime.EMBEDDING_MODEL,
    [runtime.EMBEDDING_PROBE],
    runtime.EMBEDDING_REVISION,
  );
  await runtime.embedEach(
    runtime.EMBEDDING_MULTI_MODEL,
    [runtime.EMBEDDING_PROBE],
    runtime.EMBEDDING_MULTI_REVISION,
  );
  root = prepareLiveConsumerSite(false);
  mkdirSync(join(root, ".cache"));
  symlinkSync(join(repo, ".cache/embedding-models"), join(root, ".cache/embedding-models"));
  index = JSON.parse(readFileSync(join(root, "public/recommendation-index.json"), "utf8"));
  expect(index.conferences).toHaveLength(696);
}, 600000);
afterAll(() => {
  env.cacheDir = previousCache;
  R.setTopicVecs(null);
  if (root) rmSync(root, { recursive: true, force: true });
});
it("real models preserve topic scores across deadline updates and reflect changed official topics", async () => {
  const en = R.parsePaperLines(
    JSON.stringify({ title: "Distributed file storage and memory management" }),
  );
  const ja = R.parsePaperLines(JSON.stringify({ title: "分散ストレージとメモリ管理" }));
  const before = await semanticVenueScores(root, index.conferences, index.categories, en);
  const dates: Array<Record<string, unknown>> = index.conferences.map((c) => ({
    ...c,
    editions: [{ year: 2030, deadlines: [{ utc: "2030-01-01T00:00:00Z" }] }],
  }));
  const afterDates = await semanticVenueScores(root, dates, index.categories, en);
  expect(afterDates.scores).toEqual(before.scores);
  expect(Object.keys(afterDates.scores)).toHaveLength(696);
  const japanese = await semanticVenueScores(root, dates, index.categories, ja);
  expect(japanese.model).toBe(runtime.EMBEDDING_MULTI_MODEL);
  expect(Object.keys(japanese.scores)).toHaveLength(696);
  // Only the owned in-memory test copy receives this deliberately different topic.
  const changed = dates.map((c) =>
    c.key === "fast"
      ? {
          ...c,
          scope: ["Interactive visual design"],
          official_scope: ["Image synthesis and user interface design"],
        }
      : c,
  );
  const afterTopics = await semanticVenueScores(root, changed, index.categories, en);
  expect(afterTopics.similarities.fast).not.toBe(before.similarities.fast);
  expect(afterTopics.similarities.fast).toBeLessThan(before.similarities.fast);
  expect(afterTopics.model).toBe(runtime.EMBEDDING_MODEL);
});
