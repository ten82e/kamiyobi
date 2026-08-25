/** Deterministic dev-only L2 logistic reranker training and calibration. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { RERANKER_FEATURE_SCHEMA } from "../site/recommender.ts";

type DevRecord = { paper_id: string; acceptable_venues: string[] };
type DevFixture = { records: DevRecord[] };
type Candidate = { venue: string; base_score: number; features: Record<string, number> };
type FeatureRecord = { paper_id: string; candidates: Candidate[] };
type Features = { version: number; feature_schema: string[]; records: FeatureRecord[] };
type Row = { x: number[]; y: number; paperId: string; venue: string; baseScore: number };
type Model = { intercept: number; weights: number[] };
const LAMBDAS = [0.01, 0.08, 0.2] as const;
const BLENDS = [0.05, 0.15, 0.3, 0.5, 1] as const;

function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, value))));
}
function splitIndex(id: string): number {
  let value = 0;
  for (const byte of Buffer.from(id)) value = (value * 33 + byte) >>> 0;
  return value % 3;
}
function trainLinear(rows: Row[], lambda: number): Model {
  const weights = Array(RERANKER_FEATURE_SCHEMA.length).fill(0);
  let intercept = 0;
  const positives = rows.filter((row) => row.y === 1).length;
  const positiveWeight = rows.length / Math.max(1, positives * 2);
  const negativeWeight = rows.length / Math.max(1, (rows.length - positives) * 2);
  for (let step = 0; step < 800; step++) {
    let biasGradient = 0;
    const gradient = Array(weights.length).fill(0);
    for (const row of rows) {
      const predicted = sigmoid(
        intercept + row.x.reduce((sum, value, index) => sum + value * weights[index], 0),
      );
      const error = (predicted - row.y) * (row.y ? positiveWeight : negativeWeight);
      biasGradient += error;
      row.x.forEach((value, index) => {
        gradient[index] += error * value;
      });
    }
    const rate = 0.18 / Math.sqrt(step + 1);
    intercept -= (rate * biasGradient) / rows.length;
    weights.forEach((value, index) => {
      weights[index] = value - rate * (gradient[index] / rows.length + lambda * value);
    });
  }
  return { intercept, weights };
}
function pairwiseRows(rows: Row[]): Row[] {
  const out: Row[] = [];
  for (const paperId of new Set(rows.map((row) => row.paperId))) {
    const group = rows.filter((row) => row.paperId === paperId);
    const positives = group.filter((row) => row.y === 1);
    const negatives = group.filter((row) => row.y === 0).slice(0, 100);
    for (const positive of positives) {
      for (const negative of negatives) {
        const difference = positive.x.map((value, index) => value - negative.x[index]);
        out.push({ ...positive, x: difference, y: 1, baseScore: 0 });
        out.push({ ...negative, x: difference.map((value) => -value), y: 0, baseScore: 0 });
      }
    }
  }
  return out;
}
function modelLogit(model: Model, row: Row): number {
  return (
    model.intercept + row.x.reduce((sum, value, index) => sum + value * model.weights[index], 0)
  );
}
function rankMetrics(
  rows: Row[],
  predictions: Map<string, number>,
  blend: number,
): { mrr: number; recall5: number; top: Array<{ probability: number; correct: boolean }> } {
  const paperIds = [...new Set(rows.map((row) => row.paperId))].sort();
  let reciprocal = 0;
  let recall5 = 0;
  const top: Array<{ probability: number; correct: boolean }> = [];
  for (const paperId of paperIds) {
    const ranked = rows
      .filter((row) => row.paperId === paperId)
      .sort((left, right) => {
        const lp = predictions.get(`${left.paperId}\0${left.venue}`) ?? 0;
        const rp = predictions.get(`${right.paperId}\0${right.venue}`) ?? 0;
        const ls = left.baseScore * (1 - blend) + lp * 100 * blend;
        const rs = right.baseScore * (1 - blend) + rp * 100 * blend;
        return rs - ls || left.venue.localeCompare(right.venue);
      });
    const rank = ranked.findIndex((row) => row.y === 1) + 1;
    if (rank > 0) reciprocal += 1 / rank;
    if (rank > 0 && rank <= 5) recall5 += 1;
    top.push({
      probability: predictions.get(`${ranked[0].paperId}\0${ranked[0].venue}`) ?? 0,
      correct: ranked[0].y === 1,
    });
  }
  return { mrr: reciprocal / paperIds.length, recall5: recall5 / paperIds.length, top };
}
function fitPlatt(values: Array<{ logit: number; y: number }>): {
  slope: number;
  intercept: number;
} {
  let slope = 1;
  let intercept = 0;
  for (let step = 0; step < 500; step++) {
    let slopeGradient = 0;
    let interceptGradient = 0;
    for (const value of values) {
      const error = sigmoid(slope * value.logit + intercept) - value.y;
      slopeGradient += error * value.logit;
      interceptGradient += error;
    }
    const rate = 0.12 / Math.sqrt(step + 1);
    slope -= rate * (slopeGradient / values.length + 0.02 * slope);
    intercept -= (rate * interceptGradient) / values.length;
  }
  return { slope, intercept };
}
function thresholdEvidence(top: Array<{ probability: number; correct: boolean }>) {
  const thresholds = [...new Set(top.map((item) => item.probability))].sort((a, b) => a - b);
  const choices = thresholds.map((threshold) => {
    const selected = top.filter((item) => item.probability >= threshold);
    return {
      threshold,
      precision: selected.filter((item) => item.correct).length / selected.length,
      coverage: selected.length / top.length,
    };
  });
  choices.sort(
    (left, right) =>
      right.precision - left.precision ||
      right.coverage - left.coverage ||
      right.threshold - left.threshold,
  );
  const selected = choices[0];
  const sufficient = Math.min(0.99, Math.max(...thresholds) + 0.05);
  return {
    sufficient,
    ambiguous: thresholds[Math.floor((thresholds.length - 1) / 3)],
    precision: null,
    coverage: 0,
    best_observed_precision: selected.precision,
    best_observed_coverage: selected.coverage,
  };
}

function main(argv = process.argv.slice(2)): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      dev: { type: "string" },
      features: { type: "string" },
      profiles: { type: "string" },
      out: { type: "string" },
    },
  });
  const devPath = values.dev ?? "data/benchmarks/real-paper-required-dev.json";
  const featurePath = values.features ?? "data/benchmarks/real-paper-required-features.json";
  const profilePath = values.profiles ?? "data/venue-profiles.json";
  const outPath = values.out ?? "data/recommender-reranker.json";
  const devRaw = readFileSync(devPath, "utf8");
  const featureRaw = readFileSync(featurePath, "utf8");
  const profileRaw = readFileSync(profilePath, "utf8");
  const dev = JSON.parse(devRaw) as DevFixture;
  const features = JSON.parse(featureRaw) as Features;
  if (
    features.version !== 1 ||
    features.feature_schema.join("\0") !== RERANKER_FEATURE_SCHEMA.join("\0")
  )
    throw new Error("production reranker feature schema mismatch");
  const devIds = new Set(dev.records.map((record) => record.paper_id));
  if (devIds.size < 6) throw new Error("dev training set is too small");
  const selectedFeatures = [
    ...new Map(
      features.records
        .filter((record) => devIds.has(record.paper_id))
        .map((record) => [record.paper_id, record]),
    ).values(),
  ].sort((left, right) => left.paper_id.localeCompare(right.paper_id));
  if (selectedFeatures.length !== devIds.size) throw new Error("dev production features missing");
  const acceptable = new Map(
    dev.records.map((record) => [record.paper_id, record.acceptable_venues]),
  );
  const rows: Row[] = selectedFeatures.flatMap((record) =>
    record.candidates.map((candidate) => {
      if (Object.keys(candidate.features).join("\0") !== RERANKER_FEATURE_SCHEMA.join("\0"))
        throw new Error(`candidate feature schema mismatch: ${record.paper_id}/${candidate.venue}`);
      return {
        paperId: record.paper_id,
        venue: candidate.venue,
        y: acceptable.get(record.paper_id)?.includes(candidate.venue) ? 1 : 0,
        x: RERANKER_FEATURE_SCHEMA.map((name) => candidate.features[name]),
        baseScore: candidate.base_score,
      };
    }),
  );
  const trials: Array<{
    lambda: number;
    blend: number;
    mrr: number;
    recall5: number;
    logits: Array<{ key: string; logit: number; y: number }>;
  }> = [];
  for (const lambda of LAMBDAS) {
    const logits: Array<{ key: string; logit: number; y: number }> = [];
    for (let fold = 0; fold < 3; fold++) {
      const model = trainLinear(
        pairwiseRows(rows.filter((row) => splitIndex(row.paperId) !== fold)),
        lambda,
      );
      rows
        .filter((row) => splitIndex(row.paperId) === fold)
        .forEach((row) => {
          logits.push({
            key: `${row.paperId}\0${row.venue}`,
            logit: modelLogit(model, row),
            y: row.y,
          });
        });
    }
    const predictions = new Map(logits.map((item) => [item.key, sigmoid(item.logit)]));
    for (const blend of BLENDS) {
      const metric = rankMetrics(rows, predictions, blend);
      trials.push({ lambda, blend, mrr: metric.mrr, recall5: metric.recall5, logits });
    }
  }
  trials.sort(
    (left, right) =>
      right.mrr - left.mrr ||
      right.recall5 - left.recall5 ||
      left.lambda - right.lambda ||
      left.blend - right.blend,
  );
  const selected = trials[0];
  const platt = fitPlatt(selected.logits.map(({ logit, y }) => ({ logit, y })));
  const calibrated = new Map(
    selected.logits.map((item) => [item.key, sigmoid(platt.slope * item.logit + platt.intercept)]),
  );
  const calibratedMetric = rankMetrics(rows, calibrated, selected.blend);
  const thresholds = thresholdEvidence(calibratedMetric.top);
  const model = trainLinear(pairwiseRows(rows), selected.lambda);
  const brier =
    selected.logits.reduce((sum, item) => {
      const probability = sigmoid(platt.slope * item.logit + platt.intercept);
      return sum + (probability - item.y) ** 2;
    }, 0) / selected.logits.length;
  const artifact = {
    version: 1,
    model: "linear-logit",
    coefficient_source: "trained",
    selected_on: "real-paper-required-dev",
    selection_metric: "dev-oof-mrr-then-recall-at-5",
    algorithm_revision: "l2-pairwise-logistic-reranker-v2",
    feature_schema: [...RERANKER_FEATURE_SCHEMA],
    training_data_hash: sha(devRaw),
    input_hashes: {
      [devPath]: sha(devRaw),
      [`${featurePath}#dev-records`]: sha(JSON.stringify(selectedFeatures)),
      [profilePath]: sha(profileRaw),
    },
    cv: {
      folds: 3,
      assignment: "paper-id-hash-mod-3",
      selected_lambda: selected.lambda,
      selected_blend: selected.blend,
      oof_mrr: Number(selected.mrr.toFixed(8)),
      oof_recall_at_5: Number(selected.recall5.toFixed(8)),
      trials: trials.map(({ lambda, blend, mrr, recall5 }) => ({
        lambda,
        blend,
        mrr: Number(mrr.toFixed(8)),
        recall_at_5: Number(recall5.toFixed(8)),
      })),
    },
    calibration: {
      method: "platt",
      slope: Number(platt.slope.toFixed(10)),
      intercept: Number(platt.intercept.toFixed(10)),
      comparison: {
        platt_brier: Number(brier.toFixed(8)),
        isotonic: { eligible: false, reason: "fewer than 20 dev papers" },
      },
    },
    threshold_evidence: {
      source: "dev-oof-top1",
      sufficient_precision: thresholds.precision,
      sufficient_coverage: Number(thresholds.coverage.toFixed(8)),
      best_observed_precision: Number(thresholds.best_observed_precision.toFixed(8)),
      best_observed_coverage: Number(thresholds.best_observed_coverage.toFixed(8)),
      guard_margin: 0.05,
    },
    intercept: Number(model.intercept.toFixed(10)),
    weights: Object.fromEntries(
      RERANKER_FEATURE_SCHEMA.map((name, index) => [
        name,
        Number(model.weights[index].toFixed(10)),
      ]),
    ),
    blend: selected.blend,
    confidence_thresholds: {
      sufficient: Number(thresholds.sufficient.toFixed(8)),
      ambiguous: Number(Math.min(thresholds.ambiguous, thresholds.sufficient).toFixed(8)),
    },
  };
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
}

if (import.meta.main) main();

export { main as trainRerankerMain };
