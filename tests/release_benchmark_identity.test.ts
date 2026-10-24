import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  canonicalRealPaperBenchmarkContentId,
  readFeatureStore,
  realPaperBenchmarkContentId,
} from "../src/bench-recommender.ts";

it.each(["required", "full"] as const)(
  "seals the %s workflow's frozen inputs, rejecting a report that omits them",
  (coverage) => {
    const fixture = (name: string) => JSON.parse(readFileSync(`data/benchmarks/${name}`, "utf8"));
    const prefix = coverage === "required" ? "real-paper-required" : "real-paper";
    const dev = fixture(`${prefix}-dev.json`);
    const heldout = fixture(`${prefix}-heldout.json`);
    const negative = fixture("real-paper-negative.json");
    const features = readFeatureStore("data/benchmarks/real-paper-features.jsonl");
    const actualReportIdentity = realPaperBenchmarkContentId(
      coverage,
      dev,
      heldout,
      negative,
      features,
    );
    expect(canonicalRealPaperBenchmarkContentId(coverage)).toBe(actualReportIdentity);
    expect(realPaperBenchmarkContentId(coverage, dev, heldout, negative)).not.toBe(
      actualReportIdentity,
    );
    const altered = structuredClone(features);
    altered.records.pop();
    expect(realPaperBenchmarkContentId(coverage, dev, heldout, negative, altered)).not.toBe(
      actualReportIdentity,
    );
  },
);
