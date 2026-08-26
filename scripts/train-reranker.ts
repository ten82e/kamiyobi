/** Deterministic dev-only L2 logistic reranker training and calibration. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { RERANKER_FEATURE_SCHEMA } from "../site/recommender.ts";

type DevRecord = { paper_id: string; primary_venue?: string; acceptable_venues: string[] };
type DevFixture = { records: DevRecord[] };
type Candidate = { venue: string; base_score: number; features: Record<string, number> };
type FeatureRecord = { paper_id: string; candidates: Candidate[] };
type Features = { version: number; feature_schema: string[]; records: FeatureRecord[] };
type Row = { x: number[]; y: number; paperId: string; venue: string; baseScore: number };
type Model = { intercept: number; weights: number[] };
const LAMBDAS = [0.01, 0.08, 0.2] as const;
const BLENDS = [0.05, 0.15, 0.3, 0.5, 1] as const;
const FOLDS = 5;
/** sufficient 解禁条件: dev 上でこの精度が証明できるまで「十分な一致」は出さない。 */
export const SUFFICIENT_POLICY = {
  min_precision: 0.8,
  min_wilson_lcb: 0.65,
  min_coverage: 0.1,
  min_positives: 20,
} as const;

function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, value))));
}
/** Venue-family grouped fold assignment: same primary venue never spans train/test. */
function familyFolds(dev: DevFixture): Map<string, number> {
  const families = [
    ...new Set(dev.records.map((record) => record.primary_venue ?? record.paper_id)),
  ].sort();
  const assignment = new Map<string, number>();
  for (const [index, family] of families.entries()) assignment.set(family, index % FOLDS);
  return assignment;
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
  return model.intercept + weights_dot(model.weights, row.x);
}
function weights_dot(weights: number[], x: number[]): number {
  return x.reduce((sum, value, index) => sum + value * weights[index], 0);
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
function wilsonLowerBound(correct: number, total: number): number {
  if (total === 0) return 0;
  const z = 1.96;
  const p = correct / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return Math.max(0, (centre - margin) / denominator);
}
/**
 * sufficient threshold は dev OOF top-1 の精度で解禁を判定する。
 * 条件未達なら sufficient_enabled=false を返し、UI は 2 段階に落ちる。
 */
/**
 * sufficient threshold は OOF top-1 確率の一意な値を全探索して決める。
 * 解禁条件 (precision / Wilson LCB / coverage / positive 数) を満たす閾値のうち
 * coverage 最大のものを採用する。どの閾値も満たさなくても best observed と
 * blocking condition を記録する (探索しないまま解禁されない、を防ぐ)。
 */
function confidencePolicy(top: Array<{ probability: number; correct: boolean }>) {
  const policy = SUFFICIENT_POLICY;
  const candidates = [...new Set(top.map((item) => item.probability))].sort((a, b) => b - a);
  let chosen: {
    threshold: number;
    precision: number;
    wilsonLcb: number;
    coverage: number;
    positives: number;
  } | null = null;
  let bestObserved: {
    threshold: number;
    precision: number;
    wilsonLcb: number;
    coverage: number;
    positives: number;
  } | null = null;
  for (const threshold of candidates) {
    const selected = top.filter((item) => item.probability >= threshold);
    if (selected.length === 0) continue;
    const positives = selected.filter((item) => item.correct).length;
    const point = {
      threshold,
      precision: positives / selected.length,
      wilsonLcb: wilsonLowerBound(positives, selected.length),
      coverage: selected.length / top.length,
      positives,
    };
    const checks = {
      precision_ok: point.precision >= policy.min_precision,
      wilson_lcb_ok: point.wilsonLcb >= policy.min_wilson_lcb,
      coverage_ok: point.coverage >= policy.min_coverage,
      positives_ok: point.positives >= policy.min_positives,
    };
    const unlocked = Object.values(checks).every(Boolean);
    if (unlocked && (chosen === null || point.coverage > chosen.coverage)) chosen = point;
    if (!unlocked || chosen !== null) {
      // best observed の記録用 (解禁失敗時の診断)
      if (
        bestObserved === null ||
        point.precision > bestObserved.precision ||
        (point.precision === bestObserved.precision && point.coverage > bestObserved.coverage)
      )
        bestObserved = point;
    }
  }
  if (chosen !== null && bestObserved === null) bestObserved = chosen;
  const unmetChecks =
    chosen !== null
      ? []
      : Object.entries({
          precision_ok: (bestObserved?.precision ?? 0) >= policy.min_precision,
          wilson_lcb_ok: (bestObserved?.wilsonLcb ?? 0) >= policy.min_wilson_lcb,
          coverage_ok: (bestObserved?.coverage ?? 0) >= policy.min_coverage,
          positives_ok: (bestObserved?.positives ?? 0) >= policy.min_positives,
        })
          .filter(([, ok]) => !ok)
          .map(([name]) => name);
  return {
    sufficient_enabled: chosen !== null,
    reason:
      chosen !== null
        ? "target precision reached"
        : bestObserved === null
          ? "no positive top-1 predictions"
          : "target precision not reached",
    ...(chosen === null && bestObserved !== null ? { blocking_conditions: unmetChecks } : {}),
    chosen_threshold: chosen === null ? null : Number(chosen.threshold.toFixed(8)),
    evidence: {
      sufficient_precision: chosen === null ? null : Number(chosen.precision.toFixed(8)),
      wilson_95_lcb: chosen === null ? null : Number(chosen.wilsonLcb.toFixed(8)),
      sufficient_coverage: chosen === null ? null : Number(chosen.coverage.toFixed(8)),
      sufficient_positives: chosen === null ? null : chosen.positives,
      best_observed_threshold:
        bestObserved === null ? null : Number(bestObserved.threshold.toFixed(8)),
      best_observed_precision:
        bestObserved === null ? null : Number(bestObserved.precision.toFixed(8)),
      best_observed_wilson_95_lcb:
        bestObserved === null ? null : Number(bestObserved.wilsonLcb.toFixed(8)),
      best_observed_coverage:
        bestObserved === null ? null : Number(bestObserved.coverage.toFixed(8)),
      best_observed_positives: bestObserved === null ? null : bestObserved.positives,
    },
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
  const devPath = values.dev ?? "data/benchmarks/real-paper-dev.json";
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
  if (devIds.size < FOLDS) throw new Error("dev training set is too small for grouped CV");
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
  // Grouped CV: papers sharing a primary venue stay in the same fold.
  const foldOfPaper = new Map<string, number>();
  for (const [family, fold] of familyFolds(dev)) {
    for (const record of dev.records) {
      if ((record.primary_venue ?? record.paper_id) === family)
        foldOfPaper.set(record.paper_id, fold);
    }
  }
  const trials: Array<{
    lambda: number;
    blend: number;
    mrr: number;
    recall5: number;
    logits: Array<{ key: string; logit: number; y: number }>;
  }> = [];
  for (const lambda of LAMBDAS) {
    const logits: Array<{ key: string; logit: number; y: number }> = [];
    for (let fold = 0; fold < FOLDS; fold++) {
      const trainRows = rows.filter((row) => foldOfPaper.get(row.paperId) !== fold);
      const testRows = rows.filter((row) => foldOfPaper.get(row.paperId) === fold);
      const model = trainLinear(pairwiseRows(trainRows), lambda);
      testRows.forEach((row) => {
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
  // ambiguous threshold: OOF top-1 確率の下位 1/3 分位点 (解禁時は sufficient 未満に丸める)。
  const sortedProbabilities = [
    ...new Set(calibratedMetric.top.map((item) => item.probability)),
  ].sort((a, b) => a - b);
  const ambiguousThreshold = Number(
    (sortedProbabilities[Math.floor((sortedProbabilities.length - 1) / 3)] ?? 0).toFixed(8),
  );
  const policy = confidencePolicy(calibratedMetric.top);
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
    selected_on: "real-paper-dev",
    selection_metric: "dev-oof-mrr-then-recall-at-5",
    algorithm_revision: "l2-pairwise-logistic-reranker-v3-grouped-cv",
    feature_schema: [...RERANKER_FEATURE_SCHEMA],
    training_data_hash: sha(devRaw),
    input_hashes: {
      [devPath]: sha(devRaw),
      [`${featurePath}#dev-records`]: sha(JSON.stringify(selectedFeatures)),
      [profilePath]: sha(profileRaw),
    },
    cv: {
      folds: FOLDS,
      assignment: "primary-venue-grouped-round-robin",
      dev_papers: devIds.size,
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
        // isotonic regression は未実装のため比較していない。実装するまで単一 method として明示。
        platt_brier: Number(brier.toFixed(8)),
        isotonic: { implemented: false, note: "not implemented; Platt scaling only" },
      },
    },
    confidence_policy: {
      ...policy,
      unlock_conditions: SUFFICIENT_POLICY,
    },
    threshold_evidence: {
      source: "dev-oof-top1-platt-calibrated",
      ...policy.evidence,
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
      // 解禁済みなら chosen threshold、未解禁なら将来の解禁候補 (best observed) を記録する。
      // sufficient_enabled=false の間この値は UI で使われない。
      sufficient: Number(
        (policy.chosen_threshold ?? policy.evidence.best_observed_threshold ?? 0).toFixed(8),
      ),
      ambiguous: ambiguousThreshold,
    },
  };
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
}

if (import.meta.main) main();

export { main as trainRerankerMain };
