import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { buildEmbeddings } from "../src/embeddings.ts";
import { tempWork } from "./helpers.ts";

// Replace model inference only. Profile assembly, batching, averaging and file output stay real.
const { pipeline } = vi.hoisted(() => ({ pipeline: vi.fn() }));
vi.mock("@huggingface/transformers", () => ({
  env: { cacheDir: "/offline-embedding-fixture" },
  pipeline,
}));
pipeline.mockImplementation(async (task: string, model: string, options: unknown) => {
  expect(task).toBe("feature-extraction");
  expect(options).toEqual({ local_files_only: true });
  const multi = model.includes("paraphrase-multilingual-MiniLM-L12-v2");
  expect(model).toContain(multi ? "paraphrase-multilingual-MiniLM-L12-v2" : "all-MiniLM-L6-v2");
  return async (texts: string[], extraction: unknown) => {
    expect(extraction).toEqual({ pooling: "mean", normalize: true });
    const values = texts.flatMap((text) => {
      const marker = /Fixture (\d{3})/.exec(text);
      const slot = marker ? Number(marker[1]) + (multi ? 160 : 0) : multi ? 382 : 383;
      const vector = Array<number>(384).fill(0);
      vector[slot] = 1;
      return vector;
    });
    return { dims: [texts.length, 384], data: Float32Array.from(values) };
  };
});

interface Bundle {
  dim: number;
  embeddings: Record<string, number[]>;
  multi: { dim: number; embeddings: Record<string, number[]> };
  manifest: {
    keys: string[];
    models: {
      en: { dim: number; probe: { vector: number[] } };
      multi: { dim: number; probe: { vector: number[] } };
    };
  };
}

async function generate(conferences: Array<{ key: string; title: string }>) {
  const dir = tempWork("kamiyobi-embedding-generation-");
  const input = join(dir, "input.json");
  const output = join(dir, "embeddings.json");
  writeFileSync(input, JSON.stringify({ conferences, categories: {} }));
  const returned = await buildEmbeddings(input, output, true);
  const bundle = JSON.parse(readFileSync(output, "utf8")) as Bundle;
  expect(returned).toEqual(bundle.embeddings);
  return bundle;
}

function expectedVector(slots: number[], value = 1): number[] {
  const vector = Array<number>(384).fill(0);
  for (const slot of slots) vector[slot] = value;
  return vector;
}

it("generates embeddings for every conference across batch boundaries in both models", async () => {
  const conferences = Array.from({ length: 131 }, (_, i) => ({
    key: `fixture-${String(i).padStart(3, "0")}`,
    title: `Fixture ${String(i).padStart(3, "0")}`,
  }));
  const bundle = await generate(conferences);
  const keys = conferences.map((conf) => conf.key);
  expect(Object.keys(bundle.embeddings).sort()).toEqual(keys);
  expect(Object.keys(bundle.multi.embeddings).sort()).toEqual(keys);
  expect(bundle.manifest.keys).toEqual(keys);
  expect(bundle.dim).toBe(384);
  expect(bundle.multi.dim).toBe(384);
  expect(bundle.manifest.models.en.dim).toBe(384);
  expect(bundle.manifest.models.multi.dim).toBe(384);
  expect(bundle.manifest.models.en.probe.vector).toEqual(expectedVector([383]));
  expect(bundle.manifest.models.multi.probe.vector).toEqual(expectedVector([382]));
  for (const [i, { key }] of conferences.entries()) {
    expect(bundle.embeddings[key], `English vector: ${key}`).toEqual(expectedVector([i]));
    expect(bundle.multi.embeddings[key], `Multilingual vector: ${key}`).toEqual(
      expectedVector([i + 160]),
    );
  }
  expect(pipeline).toHaveBeenCalledTimes(2);
});

it("averages repeated conference keys and normalizes both stored vectors", async () => {
  const bundle = await generate([
    { key: "repeated", title: "Fixture 000" },
    { key: "repeated", title: "Fixture 002" },
  ]);
  const component = Number(Math.SQRT1_2.toFixed(6));
  expect(Object.keys(bundle.embeddings)).toEqual(["repeated"]);
  expect(Object.keys(bundle.multi.embeddings)).toEqual(["repeated"]);
  expect(bundle.embeddings.repeated).toEqual(expectedVector([0, 2], component));
  expect(bundle.multi.embeddings.repeated).toEqual(expectedVector([160, 162], component));
  for (const vector of [bundle.embeddings.repeated, bundle.multi.embeddings.repeated]) {
    expect(vector.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(...vector)).toBeCloseTo(1, 5);
  }
});
