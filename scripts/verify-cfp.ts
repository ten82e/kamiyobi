import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type CaptureVerificationOptions,
  type CfpCapture,
  canonicalJson,
  type PromotionObservation,
  resolvePromotion,
  verifyBatch,
  verifyCapture,
  verifyPromotionObservation,
} from "../src/promotion.ts";

interface CliOptions extends CaptureVerificationOptions {
  source?: string;
  sourceIsFile: boolean;
  previousPath?: string;
}

function valueAfter(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { sourceIsFile: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      options.source = valueAfter(argv, index, arg);
      options.sourceIsFile = true;
      index += 1;
    } else if (arg === "--body" || arg === "--body-path") {
      options.bodyPath = valueAfter(argv, index, arg);
      index += 1;
    } else if (arg === "--official-domain" || arg === "--domain") {
      options.officialDomains = [...(options.officialDomains ?? []), valueAfter(argv, index, arg)];
      index += 1;
    } else if (arg === "--now") {
      options.now = valueAfter(argv, index, arg);
      index += 1;
    } else if (arg === "--max-age-seconds") {
      const seconds = Number(valueAfter(argv, index, arg));
      if (!Number.isFinite(seconds) || seconds < 0)
        throw new Error("--max-age-seconds must be non-negative");
      options.maxAgeMs = seconds * 1000;
      index += 1;
    } else if (arg === "--previous") {
      options.previousPath = valueAfter(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else if (!options.source) options.source = arg;
    else throw new Error("only one source may be supplied");
  }
  return options;
}

function objectValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCapture(value: unknown): value is CfpCapture {
  return objectValue(value) && "requestedUrl" in value && !("candidate" in value);
}

function isInvalidVerification(value: unknown): boolean {
  return (
    objectValue(value) &&
    (value.valid === false ||
      ("decision" in value && value.decision !== "promote" && value.decision !== "reject"))
  );
}

function one(value: unknown, options: CaptureVerificationOptions): unknown {
  if (!objectValue(value)) throw new TypeError("CFP JSON must contain an object");
  if (isCapture(value)) return verifyCapture(value, options);
  const observation = value as unknown as PromotionObservation;
  const verification = verifyPromotionObservation(observation, options);
  const resolution = resolvePromotion(observation, options);
  return verification.valid || resolution.decision === "reject"
    ? resolution
    : { ...resolution, decision: "hold" as const, reason: verification.errors.join("; ") };
}

function finish(result: unknown, invalid = false): void {
  process.stdout.write(`${canonicalJson(result)}\n`);
  if (invalid) process.exitCode = 1;
}

const options = parseArgs(process.argv.slice(2));
if (options.previousPath) {
  options.previousCapture = JSON.parse(readFileSync(options.previousPath, "utf8")) as CfpCapture;
}
if (!options.source) {
  process.stderr.write(
    "usage: node scripts/verify-cfp.ts [--file] <json-or-jsonl> [--body <path>] [--official-domain <domain>]\n",
  );
  process.exitCode = 2;
} else if (options.sourceIsFile && !existsSync(options.source)) {
  throw new Error(`observation file does not exist: ${options.source}`);
} else if (options.sourceIsFile || existsSync(options.source)) {
  const path = options.source;
  const fileOptions = { ...options, baseDir: options.baseDir ?? dirname(path) };
  if (path.endsWith(".jsonl")) {
    const results = verifyBatch(path, fileOptions);
    finish(results, results.some(isInvalidVerification));
  } else {
    const text = readFileSync(path, "utf8").trim();
    if (!text) finish([]);
    else if (text.startsWith("[")) {
      const values = JSON.parse(text) as unknown;
      if (!Array.isArray(values)) throw new TypeError("JSON batch must be an array");
      const results = values.map((value) => one(value, fileOptions));
      finish(results, results.some(isInvalidVerification));
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        const results = verifyBatch(path, fileOptions);
        finish(results, results.some(isInvalidVerification));
        parsed = undefined;
      }
      if (parsed !== undefined) {
        const result = one(parsed, fileOptions);
        finish(result, isInvalidVerification(result));
      }
    }
  }
} else {
  const parsed = JSON.parse(options.source) as unknown;
  const result = one(parsed, options);
  finish(result, isInvalidVerification(result));
}
