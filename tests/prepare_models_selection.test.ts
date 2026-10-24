import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  env: { cacheDir: "previous-cache" },
  embedEach: vi.fn(async (_model: string, _texts: string[], _revision: string, _local: boolean) => [
    Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)),
  ]),
}));
vi.mock("@huggingface/transformers", () => ({ env: fake.env }));
vi.mock("../src/embedding-runtime.ts", () => ({
  EMBEDDING_MODEL: "english-model",
  EMBEDDING_REVISION: "english-revision",
  EMBEDDING_MULTI_MODEL: "japanese-model",
  EMBEDDING_MULTI_REVISION: "japanese-revision",
  EMBEDDING_DIM: 384,
  EMBEDDING_PROBE: "compatibility probe",
  embedEach: fake.embedEach,
}));

import { prepareModels } from "../src/prepare-models.ts";

beforeEach(() => {
  fake.embedEach.mockClear();
  fake.env.cacheDir = "previous-cache";
});
it.each([
  ["en", "english-model", "english-revision"],
  ["ja", "japanese-model", "japanese-revision"],
] as const)(
  "prepares only %s and verifies the selected model locally",
  async (language, model, revision) => {
    expect(await prepareModels("/unused-selection-test", false, language)).toEqual([
      { id: model, revision },
    ]);
    expect(fake.embedEach.mock.calls).toEqual([
      [model, ["compatibility probe"], revision, false],
      [model, ["compatibility probe"], revision, true],
    ]);
    expect(fake.env.cacheDir).toBe("previous-cache");
  },
);
it.each(["en", "ja"] as const)("checks only the selected %s model offline", async (language) => {
  await prepareModels("/unused-selection-test", true, language);
  expect(fake.embedEach.mock.calls).toEqual([
    [
      language === "en" ? "english-model" : "japanese-model",
      ["compatibility probe"],
      language === "en" ? "english-revision" : "japanese-revision",
      true,
    ],
  ]);
});
it("retains both models as the default", async () => {
  expect(await prepareModels("/unused-selection-test")).toEqual([
    { id: "english-model", revision: "english-revision" },
    { id: "japanese-model", revision: "japanese-revision" },
  ]);
  expect(fake.embedEach.mock.calls.map((call) => [call[0], call[3]])).toEqual([
    ["english-model", false],
    ["english-model", true],
    ["japanese-model", false],
    ["japanese-model", true],
  ]);
});
it("restores the cache directory when selected model verification fails", async () => {
  fake.embedEach.mockRejectedValueOnce(new Error("transient download error"));
  await expect(prepareModels("/unused-selection-test", false, "ja")).rejects.toMatchObject({
    diagnostic: {
      model: { id: "japanese-model" },
      recovery_command: "node src/prepare-models.ts --language ja",
    },
  });
  expect(fake.env.cacheDir).toBe("previous-cache");
});
it("rejects unknown language values before inference", async () => {
  await expect(prepareModels("/unused-selection-test", false, "unknown" as "en")).rejects.toThrow(
    "language",
  );
  expect(fake.embedEach).not.toHaveBeenCalled();
  expect(fake.env.cacheDir).toBe("previous-cache");
});
