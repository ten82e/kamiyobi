import { join } from "node:path";
import { env, type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_MULTI_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const EMBEDDING_DIM = 384;
export const EMBEDDING_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
export const EMBEDDING_MULTI_REVISION = "2c4055b12046f11709e9df2c122e59ffbdc2f900";
export const EMBEDDING_RUNTIME_VERSION = "transformers-4.2.0";
export const EMBEDDING_SCHEMA_VERSION = 1;
export const EMBEDDING_PROBE = "kamiyobi embedding compatibility probe";
export const PAPER_VEC_KEYS: readonly string[] = ["usenix-security", "rtss"];

const extractorPromises = new Map<string, Promise<FeatureExtractionPipeline>>();

function getExtractor(
  model: string,
  revision: string,
  localFilesOnly = false,
): Promise<FeatureExtractionPipeline> {
  if (localFilesOnly && !env.cacheDir)
    return Promise.reject(new Error("transformers cache directory is unavailable"));
  const modelPath = localFilesOnly ? join(env.cacheDir!, model, revision) : model;
  const cacheKey = `${modelPath}@${revision}:${localFilesOnly ? "local" : "remote"}`;
  let p = extractorPromises.get(cacheKey);
  if (!p) {
    p = pipeline(
      "feature-extraction",
      modelPath,
      localFilesOnly ? { local_files_only: true } : { revision },
    ) as Promise<FeatureExtractionPipeline>;
    extractorPromises.set(cacheKey, p);
    void p.catch(() => extractorPromises.delete(cacheKey));
  }
  return p;
}

/** Round to 6 decimal places. */
export function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** 1 モデルぶんの埋め込み表 {key: number[]} を生成する。
 * keys に同じ key が複数回現れる場合（会議名 + 各代表論文タイトル）は、
 * その平均ベクトルを返し、会議の採択領域の重心にする。 */
export async function embedSet(
  model: string,
  texts: string[],
  keys: string[],
  revision: string,
  localFilesOnly = false,
): Promise<Record<string, number[]>> {
  const extractor = await getExtractor(model, revision, localFilesOnly);
  const sums = new Map<string, number[]>();
  const counts = new Map<string, number>();
  // メモリ節約のためバッチで処理
  const batch = 128;
  for (let start = 0; start < texts.length; start += batch) {
    const chunk = texts.slice(start, start + batch);
    const output = await extractor(chunk, { pooling: "mean", normalize: true });
    const tensors = Array.isArray(output) ? output : [output];
    let index = 0;
    for (const tensor of tensors) {
      const dims = tensor.dims;
      const n = dims.length >= 1 ? dims[0] : 1;
      const width = dims.length >= 2 ? dims[1] : EMBEDDING_DIM;
      const arr = Array.from(tensor.data as Float32Array | ArrayLike<number>);
      for (let i = 0; i < n; i++) {
        const key = keys[start + index];
        if (key !== undefined) {
          const vec = arr.slice(i * width, (i + 1) * width);
          const prev = sums.get(key);
          if (!prev) {
            sums.set(key, vec);
          } else {
            for (let d = 0; d < width; d++) prev[d] += vec[d];
          }
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        index += 1;
      }
    }
  }
  const out: Record<string, number[]> = {};
  for (const [key, sum] of sums) {
    const c = counts.get(key) ?? 1;
    const avg = sum.map((v) => v / c);
    const norm = Math.sqrt(avg.reduce((a, v) => a + v * v, 0)) || 1;
    out[key] = avg.map((v) => round6(v / norm));
  }
  return out;
}

/** 各テキストを個別ベクトルとして埋め込む（平均しない）。max 類似度用。 */
export async function embedEach(
  model: string,
  texts: string[],
  revision: string,
  localFilesOnly = false,
): Promise<number[][]> {
  const extractor = await getExtractor(model, revision, localFilesOnly);
  const out: number[][] = [];
  const batch = 128;
  for (let start = 0; start < texts.length; start += batch) {
    const chunk = texts.slice(start, start + batch);
    const output = await extractor(chunk, { pooling: "mean", normalize: true });
    const tensors = Array.isArray(output) ? output : [output];
    for (const tensor of tensors) {
      const dims = tensor.dims;
      const n = dims.length >= 1 ? dims[0] : 1;
      const width = dims.length >= 2 ? dims[1] : EMBEDDING_DIM;
      const arr = Array.from(tensor.data as Float32Array | ArrayLike<number>);
      for (let i = 0; i < n; i++) {
        const vec = arr.slice(i * width, (i + 1) * width);
        const norm = Math.sqrt(vec.reduce((a, v) => a + v * v, 0)) || 1;
        out.push(vec.map((v) => round6(v / norm)));
      }
    }
  }
  return out;
}
