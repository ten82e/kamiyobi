import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SemanticModelError } from "../src/semantic-model-error.ts";
import { tempWork } from "./helpers.ts";

const model = "test/model";
const revision = "pinned";
function ready(root: string) {
  const directory = join(root, ".cache/embedding-models", model, revision);
  mkdirSync(join(directory, "onnx"), { recursive: true });
  for (const file of ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model.onnx"])
    writeFileSync(join(directory, file), "present");
  return directory;
}
it("identifies missing or empty native model files without exposing the absolute workspace path", () => {
  const root = tempWork("model-not-ready-");
  const directory = ready(root);
  writeFileSync(join(directory, "onnx/model.onnx"), "");
  writeFileSync(join(directory, "onnx/model_quantized.onnx"), "present");
  const cause = new Error("internal failure");
  const error = new SemanticModelError(root, model, revision, "load", cause);
  expect(error.diagnostic.code).toBe("MODEL_NOT_READY");
  expect(error.diagnostic.missing_files).toEqual(["onnx/model.onnx"]);
  expect(error.diagnostic.model).toEqual({ id: model, revision });
  expect(error.message).toContain("実モデルが未準備");
  expect(error.message).not.toContain(root);
  expect(error.cause).toBe(cause);
});
it("distinguishes a load failure from missing weights", () => {
  const root = tempWork("model-load-failed-");
  ready(root);
  const error = new SemanticModelError(root, model, revision, "load", new Error("invalid model"));
  expect(error.diagnostic.code).toBe("MODEL_LOAD_FAILED");
  expect(error.diagnostic.missing_files).toEqual([]);
  expect(error.message).toContain("モデルファイルの破損");
});
it("distinguishes query inference failure from model loading", () => {
  const root = tempWork("model-query-failed-");
  ready(root);
  const error = new SemanticModelError(root, model, revision, "query", new Error("inference"));
  expect(error.diagnostic.code).toBe("SEMANTIC_INFERENCE_FAILED");
  expect(error.message).toContain("入力と実行環境");
});
