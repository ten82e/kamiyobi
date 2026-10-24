import { statSync } from "node:fs";
import { join } from "node:path";

export class SemanticModelError extends Error {
  readonly diagnostic: {
    code: "MODEL_NOT_READY" | "MODEL_LOAD_FAILED" | "SEMANTIC_INFERENCE_FAILED";
    model: { id: string; revision: string };
    cache_directory: string;
    missing_files: string[];
    retryable: true;
    recovery_command: string | null;
  };

  constructor(
    root: string,
    model: string,
    revision: string,
    phase: "load" | "query",
    cause: unknown,
    language: "en" | "ja" | "both" = "both",
  ) {
    const directory = join(".cache/embedding-models", model, revision);
    const missing = [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "onnx/model.onnx",
    ].filter((file) => {
      try {
        const stat = statSync(join(root, directory, file));
        return !stat.isFile() || stat.size === 0;
      } catch {
        return true;
      }
    });
    const code = missing.length
      ? "MODEL_NOT_READY"
      : phase === "load"
        ? "MODEL_LOAD_FAILED"
        : "SEMANTIC_INFERENCE_FAILED";
    const reason = missing.length
      ? `実モデルが未準備です。不足ファイル: ${missing.join("、")}`
      : phase === "load"
        ? "実モデルの読み込みに失敗しました。モデルファイルの破損や実行環境を確認してください。"
        : "実モデルによる推論に失敗しました。入力と実行環境を確認してください。";
    const preparation = `node src/prepare-models.ts${language === "both" ? "" : ` --language ${language}`}`;
    super(
      `${reason}\n対象モデル: ${model}@${revision}\n保存先: ${directory}` +
        (missing.length ? `\n準備: ${preparation}` : ""),
      { cause },
    );
    this.name = "SemanticModelError";
    this.diagnostic = {
      code,
      model: { id: model, revision },
      cache_directory: directory,
      missing_files: missing,
      retryable: true,
      recovery_command: missing.length ? preparation : null,
    };
  }
}
