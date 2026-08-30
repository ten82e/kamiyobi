import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve as resolvePath } from "node:path";
import { dump as dumpYaml } from "js-yaml";
import { asDate, parseInstant } from "./model.ts";

export type PromotionSourceClass = "official-cfp" | "publisher" | "curated-manual" | "aggregator";

export const CFP_PARSER_VERSION = "cfp-observer/1";
export const DEFAULT_CAPTURE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface CfpExtractionCandidate {
  rawExcerpt: string;
  text?: string;
  label?: string;
  kind?: string;
  date?: string;
  time?: string;
  timezone?: string;
  eventDate?: string;
  eventEndDate?: string;
  editionYear?: number;
}

export interface CfpCapture {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  retrievedAt: string;
  contentHash: string;
  parserVersion: string;
  bodyPath?: string;
  excerpt: string;
  candidates: CfpExtractionCandidate[];
  sourceRevision: string;
  officialDomains?: string[];
}

export interface PromotionEvidence {
  sourceClass: PromotionSourceClass;
  sourceUrl: string;
  sourceRevision: string;
  retrievedAt: string;
  verifiedAt: string;
  contentHash: string;
  rawExcerpt: string;
}

export interface PromotionObservation {
  candidate: string;
  sourceUrl: string;
  sourceClass: PromotionSourceClass;
  title?: string;
  categories?: string[];
  tags?: string[];
  reviewState?: "reviewed" | "pending";
  categoryReviewState?: "reviewed" | "pending" | Record<string, string>;
  categoriesReviewState?: "reviewed" | "pending" | Record<string, string>;
  editionYear?: number;
  deadline?: {
    date?: string;
    time?: string;
    timezone?: string;
    kind?: string;
    round?: number;
    track?: string;
  };
  eventDate?: string;
  eventEndDate?: string;
  rawExcerpt: string;
  evidence?: Partial<PromotionEvidence>;
  capture?: CfpCapture;
  previousCapture?: CfpCapture;
  requestedUrl?: string;
  finalUrl?: string;
  status?: number;
  headers?: Record<string, string>;
  retrievedAt?: string;
  contentHash?: string;
  parserVersion?: string;
  bodyPath?: string;
  excerpt?: string;
  candidates?: CfpExtractionCandidate[];
  sourceRevision?: string;
  officialDomains?: string[];
}

export interface PromotionResolution {
  candidate: string;
  decision: "promote" | "hold" | "reject";
  verifiedFields: string[];
  reason: string;
  verification?: CaptureVerification;
  normalized?: {
    venue: {
      key: string;
      title: string;
      categories: string[];
      tags: string[];
      review_state: string;
    };
    edition: {
      year: number;
      edition_id: string;
      date_text: string;
      event_start?: string;
      event_end?: string;
    };
    deadline: Record<string, unknown>;
  };
}

export interface CaptureVerificationOptions {
  baseDir?: string;
  bodyPath?: string;
  officialDomains?: string[];
  previousCapture?: CfpCapture;
  now?: string | Date;
  maxAgeMs?: number;
  manifestBodyHash?: string;
  requireManifestBody?: boolean;
}

export interface CaptureVerification {
  valid: boolean;
  errors: string[];
  checkedFields: string[];
  bodyHash: string;
  sourceRevision: string;
  extractedCandidates: CfpExtractionCandidate[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}(?::\d{2})?$/;
const TITLE_YEAR = /\b(20\d{2})\b/;
const SHA256 = /^[0-9a-f]{64}$/i;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validDate(value: string): boolean {
  return DATE.test(value) && asDate(value) !== null;
}

function validTime(value: string): boolean {
  if (!TIME.test(value)) return false;
  const [hour, minute, second = "0"] = value.split(":");
  return Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59;
}

function titleYear(title: string | undefined): number | null {
  const match = TITLE_YEAR.exec(title ?? "");
  return match ? Number(match[1]) : null;
}

function yearOf(value: string | undefined): number | null {
  return value && validDate(value) ? Number(value.slice(0, 4)) : null;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => cmp(a, b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DATE_PATTERNS = [
  /\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/g,
  /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,|\s)\s*20\d{2}\b/gi,
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?[,]?\s+20\d{2}\b/gi,
  /\b20\d{2}年\d{1,2}月\d{1,2}日/g,
];

function extractedDate(text: string): { date: string; year: number } | null {
  const iso = /\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/.exec(text);
  const monthFirst =
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,|\s)\s*(20\d{2})\b/i.exec(
      text,
    );
  const dayFirst =
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?[,]?\s+(20\d{2})\b/i.exec(
      text,
    );
  const japanese = /\b(20\d{2})年(\d{1,2})月(\d{1,2})日/.exec(text);
  const year = iso
    ? Number(iso[1])
    : monthFirst
      ? Number(monthFirst[3])
      : dayFirst
        ? Number(dayFirst[3])
        : japanese
          ? Number(japanese[1])
          : 0;
  const month = iso
    ? Number(iso[2])
    : monthFirst
      ? MONTHS[monthFirst[1].slice(0, 3).toLowerCase()]
      : dayFirst
        ? MONTHS[dayFirst[2].slice(0, 3).toLowerCase()]
        : japanese
          ? Number(japanese[2])
          : 0;
  const day = iso
    ? Number(iso[3])
    : monthFirst
      ? Number(monthFirst[2])
      : dayFirst
        ? Number(dayFirst[1])
        : japanese
          ? Number(japanese[3])
          : 0;
  if (!year || !month || !day) return null;
  const value = new Date(Date.UTC(year, month - 1, day));
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  )
    return null;
  return {
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    year,
  };
}

function extractedDates(
  text: string,
): Array<{ date?: string; year?: number; index: number; end: number }> {
  return DATE_PATTERNS.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => {
      const value = extractedDate(match[0]);
      const index = match.index ?? 0;
      return { ...value, index, end: index + match[0].length };
    }),
  ).sort((a, b) => a.index - b.index || a.end - b.end);
}

function extractedTime(text: string): string | undefined {
  const match = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/i.exec(text);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? "0");
  const meridiem = (match[4] ?? "").replace(/\./g, "").toLowerCase();
  if (minute > 59 || second > 59 || hour > 23 || (meridiem && hour > 12)) return undefined;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function extractedTimezone(text: string): string | undefined {
  return /\b(AoE|UTC(?:[+-]\d{1,2}(?::?\d{2})?)?|GMT(?:[+-]\d{1,2}(?::?\d{2})?)?|PST|PDT|MST|MDT|CST|CDT|EST|EDT|CET|CEST|JST|PT|ET|CT|MT|[A-Za-z_]+\/[A-Za-z_]+)\b/i.exec(
    text,
  )?.[1];
}

function candidateKind(text: string): string {
  const value = text.toLowerCase();
  if (value.includes("abstract") || value.includes("概要")) return "abstract";
  if (value.includes("camera-ready") || value.includes("camera ready")) return "camera_ready";
  if (value.includes("notification") || value.includes("採否") || value.includes("通知"))
    return "notification";
  if (value.includes("rebuttal") || value.includes("author response")) return "rebuttal_end";
  if (value.includes("registration") || value.includes("参加登録")) return "registration";
  return "paper";
}

/** Extract only date-bearing CFP/deadline lines; ambiguous values stay candidates for review. */
export function extractCfpCandidates(body: string): CfpExtractionCandidate[] {
  const text = body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?(?:b|strong|em|i)\b[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|li|tr|div|h[1-6]|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t\u00a0]+/g, " ");
  const candidates: CfpExtractionCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)) {
    if (
      !/deadline|due|submission|submit|notification|camera[- ]?ready|call for papers|cfp|event|conference|開催|締切|期限|投稿|募集/i.test(
        raw,
      )
    )
      continue;
    const extracted = extractedDates(raw);
    for (const [index, value] of extracted.entries()) {
      if (!value.date || !value.year) continue;
      const scope =
        extracted.length === 1 ? raw : raw.slice(value.index, extracted[index + 1]?.index);
      const candidate: CfpExtractionCandidate = {
        rawExcerpt: raw,
        text: raw,
        label: raw,
        kind: candidateKind(raw),
        date: value.date,
        editionYear: value.year,
      };
      const time = extractedTime(scope);
      const timezone = extractedTimezone(scope);
      if (time) candidate.time = time;
      if (timezone) candidate.timezone = timezone;
      const key = canonicalJson(candidate);
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function ordered(values: string[] | undefined): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new TypeError("categories and tags must be arrays");
  return [
    ...new Set(
      values
        .map((value) => {
          if (typeof value !== "string")
            throw new TypeError("categories and tags must contain strings");
          return value.trim();
        })
        .filter(Boolean),
    ),
  ].sort(cmp);
}

function httpUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${field} must be an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`${field} must use http or https`);
  }
  return url;
}

function domainName(value: string): string {
  const raw = value.trim().toLowerCase();
  if (!raw) return "";
  try {
    return (raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`)).hostname
      .toLowerCase()
      .replace(/\.$/, "");
  } catch {
    return "";
  }
}

export function isOfficialUrl(url: string, officialDomains: string[]): boolean {
  let hostname: string;
  try {
    hostname = httpUrl(url, "source URL").hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  return officialDomains
    .map(domainName)
    .filter(Boolean)
    .some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function captureOf(observation: PromotionObservation): CfpCapture | undefined {
  if (observation.capture) return observation.capture;
  const hasCaptureField = [
    observation.requestedUrl,
    observation.finalUrl,
    observation.status,
    observation.headers,
    observation.retrievedAt,
    observation.contentHash,
    observation.parserVersion,
    observation.bodyPath,
    observation.excerpt,
    observation.candidates,
    observation.sourceRevision,
  ].some((value) => value !== undefined);
  if (!hasCaptureField) return undefined;
  return {
    requestedUrl: observation.requestedUrl as string,
    finalUrl: observation.finalUrl as string,
    status: observation.status as number,
    headers: observation.headers as Record<string, string>,
    retrievedAt: observation.retrievedAt as string,
    contentHash: observation.contentHash as string,
    parserVersion: observation.parserVersion as string,
    bodyPath: observation.bodyPath as string,
    excerpt: observation.excerpt as string,
    candidates: observation.candidates as CfpExtractionCandidate[],
    sourceRevision: observation.sourceRevision as string,
    officialDomains: observation.officialDomains,
  };
}

function normalizedEvidence(observation: PromotionObservation): PromotionEvidence {
  const evidence = observation.evidence ?? {};
  const capture = captureOf(observation);
  return {
    sourceClass: observation.sourceClass,
    sourceUrl:
      evidence.sourceUrl ?? capture?.finalUrl ?? observation.finalUrl ?? observation.sourceUrl,
    sourceRevision:
      evidence.sourceRevision ?? capture?.sourceRevision ?? observation.sourceRevision ?? "",
    retrievedAt: evidence.retrievedAt ?? capture?.retrievedAt ?? observation.retrievedAt ?? "",
    verifiedAt: evidence.verifiedAt ?? "",
    contentHash: evidence.contentHash ?? capture?.contentHash ?? observation.contentHash ?? "",
    rawExcerpt:
      evidence.rawExcerpt ?? capture?.excerpt ?? observation.excerpt ?? observation.rawExcerpt,
  };
}

function evidenceFresh(evidence: PromotionEvidence, now?: string | Date): boolean {
  const retrievedAt = Date.parse(evidence.retrievedAt);
  const verifiedAt = Date.parse(evidence.verifiedAt);
  return (
    Number.isFinite(retrievedAt) &&
    Number.isFinite(verifiedAt) &&
    verifiedAt >= retrievedAt &&
    retrievedAt <= verificationNow(now) + 60_000
  );
}

function completeEvidence(evidence: PromotionEvidence, now?: string | Date): boolean {
  return (
    Object.values(evidence).every((value) => typeof value === "string" && value.trim() !== "") &&
    SHA256.test(evidence.contentHash) &&
    evidenceFresh(evidence, now)
  );
}

function normalizedTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const [hour, minute, second = "0"] = value.split(":");
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:${second.padStart(2, "0")}`;
}

function candidateMatches(
  deadline: PromotionObservation["deadline"],
  candidates: CfpExtractionCandidate[],
): boolean {
  if (!deadline) return false;
  return candidates.some((candidate) => {
    if (deadline.date && candidate.date !== deadline.date) return false;
    if (deadline.kind && candidate.kind !== deadline.kind) return false;
    if (deadline.time && normalizedTime(candidate.time) !== normalizedTime(deadline.time))
      return false;
    if (
      deadline.timezone &&
      (candidate.timezone ?? "").trim().toLowerCase() !== deadline.timezone.trim().toLowerCase()
    )
      return false;
    return Boolean(candidate.date);
  });
}

function categoriesAreReviewed(
  categories: string[],
  state: "reviewed" | "pending" | Record<string, string> | undefined,
): boolean {
  if (state === "reviewed") return categories.length > 0;
  if (!state || state === "pending" || typeof state !== "object") return false;
  for (const value of Object.values(state)) {
    if (value !== "reviewed" && value !== "pending")
      throw new TypeError("category review state must be reviewed or pending");
  }
  return categories.length > 0 && categories.every((category) => state[category] === "reviewed");
}

function assertCaptureShape(capture: CfpCapture): void {
  if (!capture || typeof capture !== "object" || Array.isArray(capture))
    throw new TypeError("capture must be an object");
  for (const field of [
    "requestedUrl",
    "finalUrl",
    "retrievedAt",
    "contentHash",
    "parserVersion",
    "excerpt",
    "sourceRevision",
  ] as const) {
    if (typeof capture[field] !== "string")
      throw new TypeError(`capture.${field} must be a string`);
  }
  if (!Number.isInteger(capture.status)) throw new TypeError("capture.status must be an integer");
  if (!capture.headers || typeof capture.headers !== "object" || Array.isArray(capture.headers))
    throw new TypeError("capture.headers must be an object");
  if (!Array.isArray(capture.candidates))
    throw new TypeError("capture.candidates must be an array");
  for (const candidate of capture.candidates) {
    if (!candidate || typeof candidate !== "object")
      throw new TypeError("capture.candidates must contain objects");
    if (typeof candidate.rawExcerpt !== "string")
      throw new TypeError("capture candidate rawExcerpt must be a string");
    if (candidate.date !== undefined && !validDate(candidate.date))
      throw new TypeError("capture candidate date must be YYYY-MM-DD");
  }
  for (const [key, value] of Object.entries(capture.headers)) {
    if (typeof key !== "string" || typeof value !== "string")
      throw new TypeError("capture.headers must contain strings");
  }
  if (capture.officialDomains !== undefined) {
    if (
      !Array.isArray(capture.officialDomains) ||
      capture.officialDomains.some((d) => typeof d !== "string")
    )
      throw new TypeError("capture.officialDomains must be string[]");
  }
}

function verificationNow(value: string | Date | undefined): number {
  const parsed =
    value instanceof Date ? value.getTime() : Date.parse(value ?? new Date().toISOString());
  if (!Number.isFinite(parsed)) throw new TypeError("verification now must be a valid date");
  return parsed;
}

function savedBody(
  capture: CfpCapture,
  options: CaptureVerificationOptions,
): { bytes: Buffer; text: string } | undefined {
  const bodyPath = options.bodyPath ?? capture.bodyPath;
  if (!bodyPath) return undefined;
  try {
    const bytes = readFileSync(resolvePath(options.baseDir ?? ".", bodyPath));
    return { bytes, text: bytes.toString("utf8") };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function verifyCapture(
  capture: CfpCapture,
  options: CaptureVerificationOptions = {},
): CaptureVerification {
  assertCaptureShape(capture);
  if (
    options.maxAgeMs !== undefined &&
    (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0)
  )
    throw new TypeError("maxAgeMs must be a non-negative number");

  const errors: string[] = [];
  const checkedFields = [
    "requestedUrl",
    "finalUrl",
    "status",
    "headers",
    "retrievedAt",
    "sourceRevision",
    "bodyHash",
    "excerpt",
    "officialDomain",
    "extractionCandidates",
  ];
  httpUrl(capture.requestedUrl, "requested URL");
  httpUrl(capture.finalUrl, "final URL");
  if (capture.status < 200 || capture.status >= 300) errors.push(`HTTP status ${capture.status}`);
  if (!capture.parserVersion.trim()) errors.push("parser version missing");

  const saved = savedBody(capture, options);
  const bodyHash = saved ? createHash("sha256").update(saved.bytes).digest("hex") : "";
  const extractedCandidates = saved ? extractCfpCandidates(saved.text) : [];
  if (!saved) errors.push("saved body missing");
  else {
    if (!SHA256.test(capture.contentHash) || bodyHash !== capture.contentHash.toLowerCase())
      errors.push("body hash mismatch");
    if (
      options.requireManifestBody &&
      (!options.manifestBodyHash || bodyHash !== options.manifestBodyHash.toLowerCase())
    )
      errors.push("manifest body hash mismatch");
    if (!capture.excerpt || !saved.text.includes(capture.excerpt))
      errors.push("excerpt is not contained in saved body");
  }

  const headers = Object.fromEntries(
    Object.entries(capture.headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const advertisedRevision = headers.etag?.trim() || headers["last-modified"]?.trim();
  const sourceRevisionMatchesBody =
    capture.sourceRevision.toLowerCase() === capture.contentHash.toLowerCase() ||
    capture.sourceRevision.toLowerCase() === `sha256:${capture.contentHash.toLowerCase()}`;
  if (!capture.sourceRevision.trim()) errors.push("source revision missing");
  if (
    advertisedRevision &&
    capture.sourceRevision !== advertisedRevision &&
    !sourceRevisionMatchesBody
  )
    errors.push("source revision does not match response headers");
  if (!advertisedRevision && capture.sourceRevision.trim() && !sourceRevisionMatchesBody)
    errors.push("source revision does not match body");

  const retrievedAt = Date.parse(capture.retrievedAt);
  if (!Number.isFinite(retrievedAt)) errors.push("retrievedAt is invalid");
  else {
    const now = verificationNow(options.now);
    const modifiedAt = headers["last-modified"] ? Date.parse(headers["last-modified"]) : Number.NaN;
    if (Number.isFinite(modifiedAt) && modifiedAt > retrievedAt)
      errors.push("source revision is from the future");
    if (retrievedAt > now + 60_000) errors.push("source revision is from the future");
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_CAPTURE_MAX_AGE_MS;
    if (now - retrievedAt > maxAgeMs) errors.push("source revision is stale");
  }
  if (options.previousCapture) {
    const previousRetrievedAt = Date.parse(options.previousCapture.retrievedAt);
    if (!Number.isFinite(previousRetrievedAt)) errors.push("previous retrievedAt is invalid");
    else if (!Number.isFinite(retrievedAt) || retrievedAt <= previousRetrievedAt)
      errors.push("source revision is not newer than previous capture");
    if (
      capture.sourceRevision === options.previousCapture.sourceRevision &&
      capture.contentHash === options.previousCapture.contentHash
    )
      errors.push("source revision is unchanged from previous capture");
  }

  const domains = options.officialDomains ?? capture.officialDomains ?? [];
  if (!domains.length) errors.push("official domain list missing");
  else if (!isOfficialUrl(capture.finalUrl, domains))
    errors.push("final URL is outside official domains");
  if (!extractedCandidates.length) errors.push("no extraction candidates");
  else if (!extractedCandidates.some((candidate) => Boolean(candidate.date)))
    errors.push("date extraction missing");

  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    checkedFields,
    bodyHash,
    sourceRevision: capture.sourceRevision,
    extractedCandidates,
  };
}

export function verifyPromotionObservation(
  observation: PromotionObservation,
  options: CaptureVerificationOptions = {},
): CaptureVerification {
  const capture = captureOf(observation);
  const errors: string[] = [];
  let bodyHash = "";
  let sourceRevision = "";
  let extractedCandidates: CfpExtractionCandidate[] = [];
  let checkedFields = [
    "officialDomain",
    "eventYear",
    "deadlineDate",
    "deadlineTime",
    "deadlineTimezone",
  ];
  if (capture) {
    const result = verifyCapture(capture, {
      ...options,
      officialDomains: options.officialDomains ?? observation.officialDomains,
      previousCapture: options.previousCapture ?? observation.previousCapture,
    });
    errors.push(...result.errors);
    bodyHash = result.bodyHash;
    sourceRevision = result.sourceRevision;
    extractedCandidates = result.extractedCandidates;
    checkedFields = [...result.checkedFields, ...checkedFields];
    const excerpt = normalizedEvidence(observation).rawExcerpt;
    const body = savedBody(capture, options)?.text;
    if (!excerpt || !body?.includes(excerpt))
      errors.push("observation excerpt is not contained in saved body");
    if (observation.deadline && !candidateMatches(observation.deadline, result.extractedCandidates))
      errors.push("deadline fields were not found in extraction candidates");
  }

  const evidence = normalizedEvidence(observation);
  const domains =
    options.officialDomains ?? observation.officialDomains ?? capture?.officialDomains ?? [];
  if (!domains.length) errors.push("official domain list missing");
  else if (!isOfficialUrl(evidence.sourceUrl, domains))
    errors.push("source URL is outside official domains");
  if (evidence.retrievedAt && !evidenceFresh(evidence, options.now))
    errors.push("source revision is not fresh");

  const targetYear =
    observation.editionYear ?? yearOf(observation.eventDate) ?? titleYear(observation.title);
  const eventYear = yearOf(observation.eventDate);
  if (targetYear === null) errors.push("event or edition year missing");
  if (targetYear !== null && eventYear !== null && targetYear !== eventYear)
    errors.push("event year does not match edition year");
  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    checkedFields: [...new Set(checkedFields)],
    bodyHash,
    sourceRevision,
    extractedCandidates,
  };
}

export function resolvePromotion(
  observation: PromotionObservation,
  options: CaptureVerificationOptions = {},
): PromotionResolution {
  const date = observation.deadline?.date ?? "";
  const time = observation.deadline?.time ?? "";
  const timezone = observation.deadline?.timezone ?? "";
  const validDeadlineDate = validDate(date);
  const exact = Boolean(
    validDeadlineDate &&
      validTime(time) &&
      timezone.trim() &&
      parseInstant(`${date} ${time}`, timezone),
  );
  const dateOnly = validDeadlineDate && !time && !timezone;
  const eventStart = observation.eventDate ?? "";
  const eventEnd = observation.eventEndDate ?? "";
  const validStart = !eventStart || validDate(eventStart);
  const validEnd = !eventEnd || validDate(eventEnd);
  const eventRange =
    validStart &&
    validEnd &&
    Boolean(eventStart) === Boolean(eventEnd) &&
    (!eventStart || eventStart <= eventEnd);
  const year = observation.editionYear ?? yearOf(eventStart) ?? titleYear(observation.title);
  const targetYear = year ?? Number.NaN;
  const namedYear = titleYear(observation.title);
  const eventYear = yearOf(eventStart);
  const deadlineYear = Number(date.slice(0, 4));
  const coherentYears =
    Number.isInteger(targetYear) &&
    (namedYear === null || namedYear === targetYear) &&
    (eventYear === null || eventYear === targetYear) &&
    deadlineYear >= targetYear - 1 &&
    deadlineYear <= targetYear;
  const fields = [
    ...(observation.candidate.trim() && observation.title?.trim() ? ["venue"] : []),
    ...(validDeadlineDate ? ["date"] : []),
    ...(exact ? ["time", "timezone"] : []),
    ...(observation.deadline?.kind ? ["kind"] : []),
    ...(Number.isInteger(observation.deadline?.round ?? 1) ? ["round"] : []),
    ...(observation.deadline?.track?.trim() ? ["track"] : []),
    ...(eventStart && validStart ? ["event_start"] : []),
    ...(eventEnd && validEnd ? ["event_end"] : []),
  ];
  const evidence = normalizedEvidence(observation);
  const official =
    observation.sourceClass === "official-cfp" || observation.sourceClass === "publisher";
  if (
    observation.reviewState !== undefined &&
    observation.reviewState !== "reviewed" &&
    observation.reviewState !== "pending"
  )
    throw new TypeError("reviewState must be reviewed or pending");
  if (!official) {
    return {
      candidate: observation.candidate,
      decision: "reject",
      verifiedFields: fields,
      reason: "non-primary evidence",
    };
  }

  const officialDomains =
    observation.officialDomains ?? captureOf(observation)?.officialDomains ?? [];
  const officialDomainOk =
    officialDomains.length > 0 && isOfficialUrl(evidence.sourceUrl, officialDomains);
  const categories = ordered(observation.categories);
  const reviewReady =
    observation.reviewState === "reviewed" &&
    categories.length > 0 &&
    categoriesAreReviewed(
      categories,
      observation.categoryReviewState ?? observation.categoriesReviewState,
    );
  if (!officialDomainOk)
    return {
      candidate: observation.candidate,
      decision: "hold",
      verifiedFields: fields,
      reason: "official domain not verified",
    };
  if (!reviewReady)
    return {
      candidate: observation.candidate,
      decision: "hold",
      verifiedFields: fields,
      reason: "review gate pending",
    };
  const capture = captureOf(observation);
  if (!capture)
    return {
      candidate: observation.candidate,
      decision: "hold",
      verifiedFields: fields,
      reason: "saved CFP capture required",
    };
  const captureVerification = verifyPromotionObservation(observation, options);
  if (!captureVerification.valid)
    return {
      candidate: observation.candidate,
      decision: "hold",
      verifiedFields: fields,
      reason: "capture verification failed",
      verification: captureVerification,
    };
  if (
    !fields.includes("venue") ||
    !validDeadlineDate ||
    (!exact && !dateOnly) ||
    !eventRange ||
    !coherentYears ||
    !completeEvidence(evidence, options.now)
  ) {
    return {
      candidate: observation.candidate,
      decision: "hold",
      verifiedFields: fields,
      reason: "required field or evidence missing",
      ...(captureVerification ? { verification: captureVerification } : {}),
    };
  }
  const editionYear = year!;
  const key = observation.candidate.trim();
  const deadline = {
    kind: observation.deadline?.kind ?? "paper",
    label: observation.deadline?.kind ?? "paper",
    round: observation.deadline?.round ?? 1,
    track: observation.deadline?.track?.trim() ?? "",
    precision: exact ? "exact" : "date-only",
    date: exact ? `${date} ${time}` : date,
    ...(exact ? { tz: timezone } : {}),
    evidence: [
      {
        ...evidence,
        verifiedFields: fields.filter((field) =>
          ["date", "time", "timezone", "kind", "round", "track"].includes(field),
        ),
      },
    ],
  };
  return {
    candidate: key,
    decision: "promote",
    verifiedFields: fields,
    reason: "primary fields and evidence verified",
    ...(captureVerification ? { verification: captureVerification } : {}),
    normalized: {
      venue: {
        key,
        title: observation.title!.trim(),
        categories,
        tags: ordered(observation.tags),
        review_state: observation.reviewState ?? "pending",
      },
      edition: {
        year: editionYear,
        edition_id: `${key}-${editionYear}`,
        date_text: observation.eventDate ?? String(editionYear),
        ...(eventStart ? { event_start: eventStart } : {}),
        ...(eventEnd ? { event_end: observation.eventEndDate } : {}),
      },
      deadline,
    },
  };
}

export function verifyBatch(
  path: string,
  options: CaptureVerificationOptions = {},
): PromotionResolution[] {
  const manifestPath = join(dirname(path), "manifest.json");
  const manifestBodies = new Map<string, string>();
  const hasManifest = existsSync(manifestPath);
  if (hasManifest) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      bodies?: Array<{ path?: unknown; sha256?: unknown }>;
    };
    if (!Array.isArray(manifest.bodies)) throw new TypeError("manifest.bodies must be an array");
    for (const body of manifest.bodies) {
      const sha256 = body.sha256;
      if (
        typeof body.path !== "string" ||
        !/^bodies\/[0-9a-f]{64}\.body$/.test(body.path) ||
        typeof sha256 !== "string" ||
        !SHA256.test(sha256)
      )
        throw new TypeError("manifest bodies must contain path and sha256");
      manifestBodies.set(resolvePath(dirname(manifestPath), body.path), sha256.toLowerCase());
    }
  }
  const verificationOptions = {
    ...options,
    baseDir: options.baseDir ?? dirname(path),
  };
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const observation = JSON.parse(line) as PromotionObservation;
      const capture = captureOf(observation);
      return resolvePromotion(observation, {
        ...verificationOptions,
        ...(hasManifest
          ? {
              requireManifestBody: true,
              manifestBodyHash: capture?.bodyPath
                ? manifestBodies.get(resolvePath(dirname(path), capture.bodyPath))
                : undefined,
            }
          : {}),
      });
    })
    .sort((a, b) => cmp(a.candidate, b.candidate));
}

function extraFrom(resolutions: PromotionResolution[]): Record<string, unknown> {
  const promoted = resolutions
    .filter((resolution) => resolution.decision === "promote" && resolution.normalized)
    .map((resolution) => resolution.normalized!);
  const venues = new Map<string, typeof promoted>();
  for (const normalized of promoted) {
    const group = venues.get(normalized.venue.key) ?? [];
    group.push(normalized);
    venues.set(normalized.venue.key, group);
  }
  return {
    conferences: [...venues.values()].map((venueRows) => {
      const normalized = venueRows[0]!;
      const editions = new Map<string, typeof venueRows>();
      for (const row of venueRows) {
        const group = editions.get(row.edition.edition_id) ?? [];
        group.push(row);
        editions.set(row.edition.edition_id, group);
      }
      return {
        key: normalized.venue.key,
        title: normalized.venue.title,
        categories: normalized.venue.categories,
        tags: normalized.venue.tags,
        review_state: normalized.venue.review_state,
        link: (normalized.deadline.evidence as Array<{ sourceUrl: string }>)[0]!.sourceUrl,
        editions: [...editions.values()].map((editionRows) => {
          const edition = editionRows[0]!;
          return {
            ...edition.edition,
            id: edition.edition.edition_id,
            deadlines: editionRows.map((row) => row.deadline),
          };
        }),
      };
    }),
  };
}

export function writePromotionBatch(
  observationsPath: string,
  resolutionsPath: string,
  manifestPath: string,
  options: { sourceBaseDir?: string } = {},
): PromotionResolution[] {
  const batchDir = dirname(manifestPath);
  const bodies = new Map<string, { path: string; sha256: string }>();
  const observations = readFileSync(observationsPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const observation = JSON.parse(line) as PromotionObservation;
      const capture = captureOf(observation);
      if (!capture) return canonicalJson(observation);
      const saved = savedBody(capture, {
        baseDir: options.sourceBaseDir ?? dirname(observationsPath),
      });
      if (!saved) throw new TypeError(`saved body missing: ${capture.bodyPath ?? ""}`);
      const sha256 = createHash("sha256").update(saved.bytes).digest("hex");
      const path = `bodies/${sha256}.body`;
      const target = resolvePath(batchDir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, saved.bytes);
      bodies.set(path, { path, sha256 });
      capture.bodyPath = relative(dirname(observationsPath), target) || ".";
      return canonicalJson(observation);
    })
    .join("\n");
  const observationText = observations ? `${observations}\n` : "";
  writeFileSync(observationsPath, observationText);
  const resolutions = verifyBatch(observationsPath);
  const resolutionText = `${JSON.stringify(resolutions, null, 2)}\n`;
  const extraText = dumpYaml(extraFrom(resolutions), {
    lineWidth: -1,
    noRefs: true,
    sortKeys: true,
  });
  writeFileSync(resolutionsPath, resolutionText);
  writeFileSync(join(dirname(manifestPath), "extra.yaml"), extraText);
  const manifest = {
    schema: 1,
    id: basename(dirname(manifestPath)),
    observations: { sha256: createHash("sha256").update(observationText).digest("hex") },
    resolutions: { sha256: createHash("sha256").update(resolutionText).digest("hex") },
    extra: { sha256: createHash("sha256").update(extraText).digest("hex") },
    bodies: [...bodies.values()].sort((a, b) => cmp(a.path, b.path)),
    decisions: Object.fromEntries(resolutions.map((item) => [item.candidate, item.decision])),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return resolutions;
}
