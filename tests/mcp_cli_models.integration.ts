import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { env } from "@huggingface/transformers";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as runtime from "../src/embedding-runtime.ts";
import { prepareLiveConsumerSite } from "./live_consumer_site.ts";

const repo = join(import.meta.dirname, "..");
let root: string;
beforeAll(async () => {
  const previousCache = env.cacheDir;
  try {
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
  } finally {
    env.cacheDir = previousCache;
  }
  root = prepareLiveConsumerSite(false);
  mkdirSync(join(root, ".cache"));
  symlinkSync(join(repo, ".cache/embedding-models"), join(root, ".cache/embedding-models"));
  expect(existsSync(join(root, "public/embeddings.json"))).toBe(false);
}, 600000);
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
const papers = JSON.parse(
  readFileSync(join(repo, "tests/fixtures/mcp-semantic-domains.json"), "utf8"),
).papers;
it.each([
  { id: "hzccl-en", tool: "search_venues", model: runtime.EMBEDDING_MODEL },
  { id: "ransomware-ja", tool: "recommend_venues", model: runtime.EMBEDDING_MULTI_MODEL },
])("CLI $tool uses the actual model for $id and preserves paper fields", ({ id, tool, model }) => {
  const paper = papers.find((p: { id: string }) => p.id === id);
  const input = id.endsWith("-en")
    ? paper.title.split(" ")
    : [JSON.stringify({ title: paper.title, abstract: paper.abstract })];
  const child = spawnSync(
    process.execPath,
    [join(root, "src/mcp.ts"), tool, ...input, "5", "--retrieval", "semantic", "--json"],
    { cwd: root, encoding: "utf8", timeout: 600000, maxBuffer: 8 * 1024 * 1024 },
  );
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result.candidate_venues).toBe(696);
  expect(result.uses_embeddings).toBe(true);
  expect(result.embedding_model.id).toBe(model);
  expect(result.input.received).toBe(1);
  expect(result.rows).toHaveLength(5);
  expect(
    result.rows.some((r: { venue_key: string }) => paper.acceptable_venues.includes(r.venue_key)),
    JSON.stringify(result.rows.map((r: { venue_key: string }) => r.venue_key)),
  ).toBe(true);
});
