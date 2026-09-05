import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capturePage } from "../src/capture.ts";
import {
  CFP_PARSER_VERSION,
  type CfpCapture,
  canonicalJson,
  extractCfpCandidates,
  type PromotionObservation,
  providerIdentityFromUrl,
} from "../src/promotion.ts";

export interface ObserveOptions {
  url?: string;
  bodyPath?: string;
  candidate?: string;
  title?: string;
  categories?: string[];
  officialDomains?: string[];
  retrievedAt?: string;
  editionYear?: number;
  eventDate?: string;
  eventEndDate?: string;
  deadline?: PromotionObservation["deadline"];
  fetch?: typeof fetch;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

function fail(message: string): never {
  throw new Error(message);
}

function nextValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) fail(`${option} requires a value`);
  return value;
}

function parseYear(value: string): number {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) fail(`invalid year: ${value}`);
  return year;
}

function parseTimestamp(value: string): string {
  if (!ISO_TIMESTAMP.test(value))
    fail(`retrievedAt must be an ISO timestamp with timezone: ${value}`);
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) fail(`invalid timestamp: ${value}`);
  return timestamp.toISOString();
}

function parseArgs(argv: string[]): ObserveOptions {
  const options: ObserveOptions = { categories: [], officialDomains: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      if (options.url) fail(`unexpected argument: ${arg}`);
      options.url = arg;
      continue;
    }
    if (arg === "--url") {
      options.url = nextValue(argv, ++index, arg);
    } else if (["--body", "--body-out", "--out-body", "--body-path"].includes(arg)) {
      options.bodyPath = nextValue(argv, ++index, arg);
    } else if (arg === "--candidate") {
      options.candidate = nextValue(argv, ++index, arg);
    } else if (arg === "--title") {
      options.title = nextValue(argv, ++index, arg);
    } else if (arg === "--category") {
      options.categories = [...(options.categories ?? []), nextValue(argv, ++index, arg)];
    } else if (arg === "--categories") {
      options.categories = [
        ...(options.categories ?? []),
        ...nextValue(argv, ++index, arg).split(","),
      ];
    } else if (arg === "--official-domain") {
      options.officialDomains = [...(options.officialDomains ?? []), nextValue(argv, ++index, arg)];
    } else if (arg === "--retrieved-at") {
      options.retrievedAt = parseTimestamp(nextValue(argv, ++index, arg));
    } else if (arg === "--edition-year") {
      options.editionYear = parseYear(nextValue(argv, ++index, arg));
    } else if (arg === "--event-date") {
      options.eventDate = nextValue(argv, ++index, arg);
    } else if (arg === "--event-end-date") {
      options.eventEndDate = nextValue(argv, ++index, arg);
    } else if (arg === "--date") {
      options.deadline = { ...options.deadline, date: nextValue(argv, ++index, arg) };
    } else if (arg === "--time") {
      options.deadline = { ...options.deadline, time: nextValue(argv, ++index, arg) };
    } else if (arg === "--timezone") {
      options.deadline = { ...options.deadline, timezone: nextValue(argv, ++index, arg) };
    } else if (arg === "--kind") {
      options.deadline = { ...options.deadline, kind: nextValue(argv, ++index, arg) };
    } else if (arg === "--round") {
      const round = Number(nextValue(argv, ++index, arg));
      if (!Number.isInteger(round) || round < 1) fail("round must be a positive integer");
      options.deadline = { ...options.deadline, round };
    } else if (arg === "--track") {
      options.deadline = { ...options.deadline, track: nextValue(argv, ++index, arg) };
    } else {
      fail(`unknown option: ${arg}`);
    }
  }
  if (!options.url || !options.bodyPath)
    fail("usage: node scripts/observe-cfp.ts <url> --body <path> [options]");
  return options;
}

function normalizedList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export async function observeCfp(
  input: ObserveOptions | string[] = process.argv.slice(2),
): Promise<CfpCapture> {
  const options = Array.isArray(input) ? parseArgs(input) : input;
  if (!options.url) fail("usage: node scripts/observe-cfp.ts <url> [options]");
  if (!options.bodyPath) fail("saved body path is required (--body)");
  const requestedUrl = options.url;
  const captured = await capturePage(requestedUrl, {
    fetchImpl: options.fetch,
    parserVersion: CFP_PARSER_VERSION,
  });
  const bytes = captured.body ?? new Uint8Array();
  const headers: Record<string, string> = {};
  if (captured.headers.etag) headers.etag = captured.headers.etag;
  if (captured.headers.lastModified) headers["last-modified"] = captured.headers.lastModified;
  if (captured.headers.retryAfter) headers["retry-after"] = captured.headers.retryAfter;
  const finalUrl = captured.finalUrl;
  const retrievedAt = options.retrievedAt
    ? parseTimestamp(options.retrievedAt)
    : new Date().toISOString();
  const body = new TextDecoder().decode(bytes);
  const candidates = extractCfpCandidates(body);
  const candidateExcerpt = candidates[0]?.rawExcerpt;
  const excerpt =
    candidateExcerpt && body.includes(candidateExcerpt) ? candidateExcerpt : body.slice(0, 280);
  const capture: CfpCapture = {
    requestedUrl,
    finalUrl,
    status: captured.status,
    headers,
    retrievedAt,
    contentHash: captured.contentHash,
    parserVersion: CFP_PARSER_VERSION,
    excerpt,
    candidates,
    sourceRevision: captured.sourceRevision,
    bodyPath: options.bodyPath,
    providerIdentity: providerIdentityFromUrl(finalUrl),
    ...(options.officialDomains?.length
      ? { officialDomains: normalizedList(options.officialDomains) }
      : {}),
  };
  mkdirSync(dirname(options.bodyPath), { recursive: true });
  writeFileSync(options.bodyPath, bytes);
  return capture;
}

async function main(): Promise<void> {
  const observation = await observeCfp();
  process.stdout.write(`${canonicalJson(observation)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
