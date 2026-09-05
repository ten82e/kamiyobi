import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  canonicalRealPaperBenchmarkContentId,
  REAL_PAPER_REGRESSION_FLOORS,
} from "../src/bench-recommender.ts";
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  EMBEDDING_MULTI_REVISION,
  EMBEDDING_REVISION,
  embeddingManifest,
  venuePapersHash,
} from "../src/embeddings.ts";
import { semanticContentIdForArtifacts } from "../src/semantic-content.ts";
import { REPO_ROOT } from "./helpers.ts";

function embeddingFixture(data: Parameters<typeof embeddingManifest>[0]): unknown {
  const probe = Array(EMBEDDING_DIM).fill(0);
  return {
    model: EMBEDDING_MODEL,
    dim: EMBEDDING_DIM,
    venuePapersHash: venuePapersHash(),
    manifest: embeddingManifest(data, { en: probe, multi: probe }),
    embeddings: {},
    multi: { model: EMBEDDING_MULTI_MODEL, dim: EMBEDDING_DIM, embeddings: {} },
    paperVecs: {},
  };
}

it("keeps the trusted-pipeline invocation compatible without report files", () => {
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-seal-"));
  const embeddings = join(root, "embeddings.json");
  const data = join(root, "data.json");
  const out = join(root, "manifest.json");
  const dataValue = { conferences: [] };
  writeFileSync(embeddings, JSON.stringify(embeddingFixture(dataValue)));
  writeFileSync(data, JSON.stringify(dataValue));
  const result = spawnSync(
    process.execPath,
    [join(REPO_ROOT, "scripts", "seal-recommendation-bundle.ts"), embeddings, data, out, "commit"],
    { cwd: root, encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
    required_gate: "passed",
    full_benchmark: "passed",
    gate_provenance: {
      mode: "trusted-pipeline",
      required: null,
      full: null,
    },
  });
});

it("requires distinct passed required and full real-paper reports", () => {
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-seal-"));
  const embeddings = join(root, "embeddings.json");
  const data = join(root, "data.json");
  const out = join(root, "manifest.json");
  const required = join(root, "required.json");
  const full = join(root, "full.json");
  const dataValue = { conferences: [] };
  writeFileSync(embeddings, JSON.stringify(embeddingFixture(dataValue)));
  writeFileSync(data, JSON.stringify(dataValue));
  const semanticContentId = semanticContentIdForArtifacts(
    JSON.parse(readFileSync(data, "utf8")),
    readFileSync(join(REPO_ROOT, "data/recommender-reranker.json")),
  );
  const report = (coverage: "required" | "full") => {
    const queries = coverage === "required" ? 9 : 80;
    const confidence_interval = {
      method: "bootstrap",
      confidence_level: 0.95,
      seed: 0x5eed2026,
      resamples: 1_000,
      metrics: Object.fromEntries(
        ["mrr", "recall@1", "recall@5", "recall@10", "ndcg@10"].map((metric) => [
          metric,
          { lower: 1, upper: 1 },
        ]),
      ),
    };
    const mode = {
      queries,
      mrr: 1,
      top1Accuracy: 1,
      coverage: 1,
      "recall@1": 1,
      "recall@5": 1,
      "recall@10": 1,
      "ndcg@5": 1,
      "ndcg@10": 1,
      confidence_interval,
    };
    const rates = {
      mrr: 0,
      "recall@1": 0,
      "recall@5": 0,
      "recall@10": 0,
      "ndcg@10": 0,
    };
    const split = {
      queries,
      modes: {
        lexical: structuredClone(mode),
        semantic: structuredClone(mode),
        fused: structuredClone(mode),
      },
      strata: {
        language: {},
        category: {},
        domain: {},
        venueScope: {},
        venueKind: {},
        inputMode: {},
      },
      mode_deltas: {
        lexical_to_semantic: structuredClone(rates),
        lexical_to_fused: structuredClone(rates),
        semantic_to_fused: structuredClone(rates),
      },
      abstention: {
        mode: "fused",
        total: queries,
        abstained: 0,
        coverage: 1,
        conditionalPrecision: 1,
        "conditionalRecall@5": 1,
      },
      candidate_retrieval: {
        lexical_recall_at_50: 1,
        semantic_recall_at_50: 1,
        union_recall_at_50: 1,
        oracle_reranker_recall_at_5: 1,
      },
      calibration: {
        expected_calibration_error: 0,
        brier_score: 0,
        top1_expected_calibration_error: 0,
        top1_brier_score: 0,
        top5_expected_calibration_error: 0,
        top5_brier_score: 0,
      },
    };
    const heldout = structuredClone(split);
    if (coverage === "required") {
      heldout.queries = 10;
      for (const value of Object.values(heldout.modes)) value.queries = 10;
      heldout.abstention.total = 10;
    }
    return {
      benchmark: "real-paper-v1",
      version: 1,
      coverage,
      benchmark_content_id: canonicalRealPaperBenchmarkContentId(coverage),
      passed: true,
      semantic_content_id: semanticContentId,
      models: {
        en: { model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION },
        ja: { model: EMBEDDING_MULTI_MODEL, revision: EMBEDDING_MULTI_REVISION },
      },
      splits: {
        dev: structuredClone(split),
        heldout,
        negative: {
          queries: 41,
          expected_abstention_rate: 1,
          non_abstain_rate: 0,
          non_abstain_precision: null,
        },
      },
      regression_floor: structuredClone(REAL_PAPER_REGRESSION_FLOORS[coverage]),
      timing: { firstLoadMs: null, repeatRecommendationMs: null },
    };
  };
  writeFileSync(required, JSON.stringify({ ok: true }));
  writeFileSync(full, JSON.stringify(report("full")));

  const run = () =>
    spawnSync(
      process.execPath,
      [
        "scripts/seal-recommendation-bundle.ts",
        embeddings,
        data,
        out,
        "commit",
        "--required-gate",
        required,
        "--full-benchmark",
        full,
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );

  const incomplete = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, "scripts", "seal-recommendation-bundle.ts"),
      embeddings,
      data,
      out,
      "commit",
      "--required-gate",
      required,
    ],
    { cwd: root, encoding: "utf8" },
  );
  expect(incomplete.status).not.toBe(0);
  expect(`${incomplete.stdout}${incomplete.stderr}`).toMatch(/full-benchmark/);

  const emptyReports = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, "scripts", "seal-recommendation-bundle.ts"),
      embeddings,
      data,
      out,
      "commit",
      "--required-gate",
      "",
      "--full-benchmark",
      "",
    ],
    { cwd: root, encoding: "utf8" },
  );
  expect(emptyReports.status).not.toBe(0);

  const staleEmbedding = JSON.parse(readFileSync(embeddings, "utf8"));
  staleEmbedding.manifest.runtime_version = "stale";
  writeFileSync(embeddings, JSON.stringify(staleEmbedding));
  expect(run().status).not.toBe(0);
  writeFileSync(embeddings, JSON.stringify(embeddingFixture(dataValue)));

  const unrelated = run();
  expect(unrelated.status).not.toBe(0);
  expect(`${unrelated.stdout}${unrelated.stderr}`).toMatch(/passed required real-paper report/);
  expect(existsSync(out)).toBe(false);

  writeFileSync(required, JSON.stringify(report("full")));
  expect(run().status).not.toBe(0);

  writeFileSync(required, JSON.stringify({ ...report("required"), semantic_content_id: "wrong" }));
  expect(run().status).not.toBe(0);

  writeFileSync(required, JSON.stringify({ ...report("required"), benchmark_content_id: "wrong" }));
  expect(run().status).not.toBe(0);

  writeFileSync(
    required,
    JSON.stringify({
      benchmark: "real-paper-v1",
      version: 1,
      coverage: "required",
      passed: true,
      semantic_content_id: semanticContentId,
      splits: { dev: {}, heldout: {}, negative: {} },
      regression_floor: REAL_PAPER_REGRESSION_FLOORS.required,
    }),
  );
  expect(run().status).not.toBe(0);

  const belowFloor = report("required");
  belowFloor.splits.heldout.modes.fused["recall@5"] = 0;
  writeFileSync(required, JSON.stringify(belowFloor));
  expect(run().status).not.toBe(0);

  const inconsistent = report("required");
  inconsistent.splits.dev.candidate_retrieval.lexical_recall_at_50 = 0;
  inconsistent.splits.dev.candidate_retrieval.semantic_recall_at_50 = 0;
  inconsistent.splits.dev.candidate_retrieval.union_recall_at_50 = 1;
  writeFileSync(required, JSON.stringify(inconsistent));
  expect(run().status).not.toBe(0);

  inconsistent.splits.dev.candidate_retrieval.lexical_recall_at_50 = 1;
  inconsistent.splits.dev.candidate_retrieval.semantic_recall_at_50 = 1;
  inconsistent.splits.dev.mode_deltas.lexical_to_fused.mrr = 1;
  writeFileSync(required, JSON.stringify(inconsistent));
  expect(run().status).not.toBe(0);

  const contradictoryNegative = report("required");
  contradictoryNegative.splits.negative.non_abstain_rate = 1;
  writeFileSync(required, JSON.stringify(contradictoryNegative));
  expect(run().status).not.toBe(0);

  const wrongCount = report("required");
  wrongCount.splits.dev.queries = 6;
  for (const value of Object.values(wrongCount.splits.dev.modes)) value.queries = 6;
  wrongCount.splits.dev.abstention.total = 6;
  writeFileSync(required, JSON.stringify(wrongCount));
  expect(run().status).not.toBe(0);

  const almostEqual = report("required");
  almostEqual.splits.dev.mode_deltas.lexical_to_fused.mrr = 0.0000004;
  writeFileSync(required, JSON.stringify(almostEqual));
  expect(run().status).not.toBe(0);

  const contradictoryInterval = report("required");
  contradictoryInterval.splits.dev.modes.fused.mrr = 0;
  contradictoryInterval.splits.dev.mode_deltas.lexical_to_fused.mrr = -1;
  contradictoryInterval.splits.dev.mode_deltas.semantic_to_fused.mrr = -1;
  writeFileSync(required, JSON.stringify(contradictoryInterval));
  expect(run().status).not.toBe(0);

  const roundedUnion = report("required");
  roundedUnion.splits.dev.candidate_retrieval.lexical_recall_at_50 = 0.111111;
  roundedUnion.splits.dev.candidate_retrieval.semantic_recall_at_50 = 0.444444;
  roundedUnion.splits.dev.candidate_retrieval.union_recall_at_50 = 0.555556;
  roundedUnion.splits.dev.candidate_retrieval.oracle_reranker_recall_at_5 = 0.555556;
  writeFileSync(required, JSON.stringify(roundedUnion));
  expect(run().status).toBe(0);

  writeFileSync(required, `${JSON.stringify(report("required"), null, 2)}\n`);
  writeFileSync(full, `${JSON.stringify(report("full"), null, 2)}\n`);
  expect(run().status).toBe(0);
  expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
    required_gate: "passed",
    full_benchmark: "passed",
    gate_provenance: {
      mode: "verified-reports",
      required: {
        report_sha256: createHash("sha256").update(readFileSync(required)).digest("hex"),
        benchmark_content_id: canonicalRealPaperBenchmarkContentId("required"),
      },
      full: {
        report_sha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
        benchmark_content_id: canonicalRealPaperBenchmarkContentId("full"),
      },
    },
  });
});

it("rejects ambiguous reranker identity metadata", () => {
  const data = { conferences: [] };
  const reranker = (algorithm_revision: unknown, feature_schema: unknown) =>
    Buffer.from(JSON.stringify({ algorithm_revision, feature_schema }));

  expect(() => semanticContentIdForArtifacts(data, reranker(" revision ", ["score"]))).toThrow(
    /algorithm_revision/,
  );
  expect(() =>
    semanticContentIdForArtifacts(data, reranker("revision", ["score", "score"])),
  ).toThrow(/feature_schema/);
  expect(() => semanticContentIdForArtifacts(data, reranker("revision", ["score", ""]))).toThrow(
    /feature_schema/,
  );
});
