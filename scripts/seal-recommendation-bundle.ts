/** Seal a recommendation bundle with the shared semantic content identity.
 * usage: node scripts/seal-recommendation-bundle.ts <embeddings.json> <data.json> <out-manifest.json> <source-commit> [--required-gate <report.json> --full-benchmark <report.json>] */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  canonicalRealPaperBenchmarkContentId,
  type RealPaperCoverage,
  type RealPaperResult,
  realPaperRegressionReasons,
} from "../src/bench-recommender.ts";
import { embeddingsStale } from "../src/build.ts";
import { embeddingProfileHash } from "../src/embeddings.ts";
import { semanticContentIdForArtifacts } from "../src/semantic-content.ts";

const positional: string[] = [];
let requiredGatePath = "";
let fullBenchmarkPath = "";
let requiredGateSeen = false;
let fullBenchmarkSeen = false;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--required-gate") {
    requiredGateSeen = true;
    requiredGatePath = args[++index] ?? "";
  } else if (arg === "--full-benchmark") {
    fullBenchmarkSeen = true;
    fullBenchmarkPath = args[++index] ?? "";
  } else if (arg?.startsWith("--")) {
    throw new Error(`unknown option: ${arg}`);
  } else if (arg) {
    positional.push(arg);
  }
}
const [embeddingsPath, dataPath, outPath, sourceCommit] = positional;
if (
  positional.length !== 4 ||
  requiredGateSeen !== fullBenchmarkSeen ||
  (requiredGateSeen && (!requiredGatePath || !fullBenchmarkPath))
) {
  throw new Error(
    "usage: node scripts/seal-recommendation-bundle.ts <embeddings.json> <data.json> <out> <commit> [--required-gate <report.json> --full-benchmark <report.json>]",
  );
}

function readPassedReport(
  path: string,
  label: string,
  coverage: RealPaperCoverage,
  semanticContentId: string,
): { report_sha256: string; benchmark_content_id: string } {
  let bytes: Buffer;
  let value: unknown;
  try {
    bytes = readFileSync(path);
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} report is unreadable: ${String(error)}`);
  }
  const report = value as
    | (Partial<RealPaperResult> & { passed?: unknown; semantic_content_id?: unknown })
    | null;
  const benchmarkContentId = canonicalRealPaperBenchmarkContentId(coverage);
  const regressions =
    !report || Array.isArray(report)
      ? ["report must be an object"]
      : realPaperRegressionReasons(report, coverage, benchmarkContentId);
  if (report?.semantic_content_id !== semanticContentId)
    regressions.push("semantic content does not match the sealed data");
  if (report?.passed !== true || regressions.length)
    throw new Error(
      `${label} must be a passed ${coverage} real-paper report: ${regressions.join("; ")}`,
    );
  return {
    report_sha256: createHash("sha256").update(bytes).digest("hex"),
    benchmark_content_id: benchmarkContentId,
  };
}

const bytes = readFileSync(embeddingsPath);
const embedding = JSON.parse(bytes) as {
  manifest?: { runtime_version?: unknown; models?: { en?: { revision?: unknown } } };
};
const manifest = embedding.manifest;
if (!manifest?.runtime_version || !manifest.models?.en?.revision)
  throw new Error("invalid embedding manifest");

const data = JSON.parse(readFileSync(dataPath, "utf8"));
if (embeddingsStale(embedding, data)) throw new Error("stale or incompatible embedding bundle");
const rerankerRaw = readFileSync(new URL("../data/recommender-reranker.json", import.meta.url));

// seal 時に content id を再計算し、reuse 判定 (scripts/semantic-content.ts) と同じ式であることを強制する。
const actualContentId = semanticContentIdForArtifacts(data, rerankerRaw);
const gateProvenance = requiredGatePath
  ? {
      mode: "verified-reports",
      required: readPassedReport(requiredGatePath, "required gate", "required", actualContentId),
      full: readPassedReport(fullBenchmarkPath, "full benchmark", "full", actualContentId),
    }
  : { mode: "trusted-pipeline", required: null, full: null };

writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      // 公開 commit と生成元 commit を分離: reuse 時は origin commit のまま残る。
      source_commit: sourceCommit,
      bundle_origin_commit: sourceCommit,
      semantic_content_id: actualContentId,
      profile_hash: embeddingProfileHash(data),
      model_revision: manifest.models.en.revision,
      multilingual_model_revision: manifest.models.multi?.revision ?? null,
      runtime_version: manifest.runtime_version,
      embeddings_sha256: createHash("sha256").update(bytes).digest("hex"),
      required_gate: "passed",
      full_benchmark: "passed",
      gate_provenance: gateProvenance,
    },
    null,
    2,
  )}\n`,
);
