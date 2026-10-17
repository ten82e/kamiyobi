import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { tempWork } from "./helpers.ts";

const fake = vi.hoisted(() => ({
  env: { cacheDir: "", allowRemoteModels: true, fetch: vi.fn<typeof fetch>() },
  tokenizer: vi.fn(async (path: string, _options: unknown) => ({ path })),
  model: vi.fn(async (path: string, _options: unknown) => ({ path })),
  extract: vi.fn(async (texts: string[], _options: unknown) => ({
    dims: [texts.length, 384],
    data: Float32Array.from(texts.flatMap(() => [1, ...Array<number>(383).fill(0)])),
  })),
  construct: vi.fn(),
}));
vi.mock("@huggingface/transformers", () => ({
  env: fake.env,
  AutoTokenizer: { from_pretrained: fake.tokenizer },
  AutoModel: { from_pretrained: fake.model },
  FeatureExtractionPipeline: function (input: unknown) {
    if (!new.target) throw new Error("pipeline must be constructed");
    fake.construct(input);
    return fake.extract;
  },
}));

import {
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  EMBEDDING_MULTI_REVISION,
  EMBEDDING_REVISION,
  embedEach,
} from "../src/embedding-runtime.ts";

const models = [
  [EMBEDDING_MODEL, EMBEDDING_REVISION],
  [EMBEDDING_MULTI_MODEL, EMBEDDING_MULTI_REVISION],
] as const;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function localMetadata(model: string, revision: string) {
  const directory = join(fake.env.cacheDir, model, revision);
  mkdirSync(directory, { recursive: true });
  for (const name of ["tokenizer.json", "tokenizer_config.json"])
    writeFileSync(join(directory, name), "{}");
  return directory;
}
beforeEach(() => {
  fake.env.cacheDir = tempWork("kamiyobi-loading-order-");
  fake.env.allowRemoteModels = true;
  fake.env.fetch.mockReset().mockImplementation(async () => new Response("{}"));
  fake.tokenizer.mockReset().mockImplementation(async (path) => ({ path }));
  fake.model.mockReset().mockImplementation(async (path) => ({ path }));
  fake.extract.mockClear();
  fake.construct.mockClear();
});
it.each(
  models.flatMap(([model, revision]) =>
    ["http", "json"].map((failure) => ({ model, revision, failure })),
  ),
)(
  "does not load weights when $failure tokenizer acquisition fails for $model, then retries",
  async ({ model, revision, failure }) => {
    fake.env.fetch.mockResolvedValueOnce(
      failure === "http" ? new Response("unavailable", { status: 503 }) : new Response("{invalid"),
    );
    await expect(embedEach(model, ["first input"], revision)).rejects.toThrow();
    expect(fake.model).not.toHaveBeenCalled();
    expect(fake.tokenizer).not.toHaveBeenCalled();
    expect(fake.env.fetch).toHaveBeenCalledTimes(1);
    expect(existsSync(join(fake.env.cacheDir, model, revision, "tokenizer.json"))).toBe(false);
    await expect(embedEach(model, ["retry input"], revision)).resolves.toHaveLength(1);
    expect(fake.model).toHaveBeenCalledExactlyOnceWith(model, {
      revision,
      device: "cpu",
      dtype: "fp32",
    });
    expect(fake.extract).toHaveBeenCalledWith(["retry input"], {
      pooling: "mean",
      normalize: true,
    });
  },
);
it.each(models)(
  "does not load weights while local tokenizer metadata is absent for %s",
  async (model, revision) => {
    await expect(embedEach(model, ["input"], revision, true)).rejects.toThrow(
      "tokenizer unavailable",
    );
    expect(fake.model).not.toHaveBeenCalled();
    expect(fake.env.fetch).not.toHaveBeenCalled();
    const directory = localMetadata(model, revision);
    await expect(embedEach(model, ["input"], revision, true)).resolves.toHaveLength(1);
    expect(fake.model).toHaveBeenCalledExactlyOnceWith(directory, {
      local_files_only: true,
      device: "cpu",
      dtype: "fp32",
    });
  },
);
it.each(models)(
  "does not load weights after tokenizer decoding fails for %s",
  async (model, revision) => {
    fake.tokenizer.mockRejectedValueOnce(new Error("tokenizer decoding failed"));
    await expect(embedEach(model, ["input"], revision)).rejects.toThrow(
      "tokenizer decoding failed",
    );
    expect(fake.model).not.toHaveBeenCalled();
    expect(fake.env.fetch).toHaveBeenCalledTimes(2);
    await expect(embedEach(model, ["input"], revision)).resolves.toHaveLength(1);
    expect(fake.model).toHaveBeenCalledTimes(1);
    expect(fake.env.fetch).toHaveBeenCalledTimes(2);
  },
);
it("shares pending tokenizer preparation without starting model loads early", async () => {
  const [model, revision] = models[0];
  localMetadata(model, revision);
  let release = (_value: { path: string }) => {};
  fake.tokenizer.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = embedEach(model, ["first"], revision, true),
    second = embedEach(model, ["second"], revision, true);
  await tick();
  const early = fake.model.mock.calls.length;
  release({ path: "ready" });
  await Promise.all([first, second]);
  expect(early).toBe(0);
  expect(fake.tokenizer).toHaveBeenCalledTimes(1);
  expect(fake.model).toHaveBeenCalledTimes(1);
  expect(fake.construct).toHaveBeenCalledTimes(1);
  expect(fake.extract.mock.calls.map((call) => call[0])).toEqual([["first"], ["second"]]);
});
it.each(models)(
  "retries a failed model load with the same input for %s",
  async (model, revision) => {
    localMetadata(model, revision);
    fake.model.mockRejectedValueOnce(new Error("model load failed"));
    await expect(embedEach(model, ["same input"], revision, true)).rejects.toThrow(
      "model load failed",
    );
    await expect(embedEach(model, ["same input"], revision, true)).resolves.toHaveLength(1);
    expect(fake.model).toHaveBeenCalledTimes(2);
    expect(fake.tokenizer).toHaveBeenCalledTimes(2);
    expect(fake.extract).toHaveBeenCalledTimes(1);
  },
);
it("reuses successful extractors independently for both languages", async () => {
  for (const [model, revision] of models) {
    localMetadata(model, revision);
    await embedEach(model, ["input"], revision, true);
  }
  await embedEach(models[0][0], ["another input"], models[0][1], true);
  expect(fake.model.mock.calls.map((call) => call[0])).toEqual(
    models.map(([model, revision]) => join(fake.env.cacheDir, model, revision)),
  );
  expect(fake.construct).toHaveBeenCalledTimes(2);
  expect(fake.extract).toHaveBeenCalledTimes(3);
});

it("prepares a new remote extractor when the cache directory changes", async () => {
  const [model, revision] = models[0];
  const first = fake.env.cacheDir;
  await embedEach(model, ["input"], revision);
  fake.env.cacheDir = tempWork("kamiyobi-other-model-cache-");
  await embedEach(model, ["input"], revision);
  expect(fake.model).toHaveBeenCalledTimes(2);
  expect(fake.tokenizer.mock.calls.map((call) => call[0])).toEqual([
    join(first, model, revision),
    join(fake.env.cacheDir, model, revision),
  ]);
  expect(fake.env.fetch).toHaveBeenCalledTimes(4);
  expect(existsSync(join(fake.env.cacheDir, model, revision, "tokenizer.json"))).toBe(true);
});
