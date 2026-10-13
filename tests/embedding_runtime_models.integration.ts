import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { env } from "@huggingface/transformers";
import { afterAll, expect, it } from "vitest";
import { EMBEDDING_MODEL, EMBEDDING_REVISION, embedEach } from "../src/embedding-runtime.ts";

const work = mkdtempSync(join(tmpdir(), "kamiyobi-runtime-models-"));
const previousCache = env.cacheDir;
afterAll(() => {
  env.cacheDir = previousCache;
  rmSync(work, { recursive: true, force: true });
});
function cosine(a: number[], b: number[]) {
  return a.reduce((sum, value, i) => sum + value * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));
}

it("initializes a fresh real extractor without remote model-list discovery", async () => {
  const root = join(import.meta.dirname, "..");
  env.cacheDir = join(root, ".cache/embedding-models");
  await embedEach(EMBEDDING_MODEL, ["fresh extractor initialization"], EMBEDDING_REVISION);
  const script = join(work, "offline-extractor.mjs");
  writeFileSync(
    script,
    `
    import { env } from ${JSON.stringify(pathToFileURL(join(root, "node_modules/@huggingface/transformers/dist/transformers.node.mjs")).href)};
    import { embedEach, EMBEDDING_MODEL, EMBEDDING_REVISION } from ${JSON.stringify(pathToFileURL(join(root, "src/embedding-runtime.ts")).href)};
    env.cacheDir = ${JSON.stringify(join(root, ".cache/embedding-models"))};
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.fetch = async () => { throw new Error("remote model discovery must not be used"); };
    const vectors = await embedEach(EMBEDDING_MODEL, [
      "Internet packet routing and network transport protocols",
      "Relational databases, transaction isolation and SQL query optimization"
    ], EMBEDDING_REVISION);
    console.log(JSON.stringify(vectors));
  `,
  );
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 60000 });
  expect(result.status, result.stderr).toBe(0);
  const vectors = JSON.parse(result.stdout.trim()) as number[][];
  expect(vectors).toHaveLength(2);
  for (const vector of vectors) {
    expect(vector).toHaveLength(384);
    expect(vector.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(...vector)).toBeCloseTo(1, 4);
  }
  expect(cosine(vectors[0], vectors[1])).toBeLessThan(0.8);
});
