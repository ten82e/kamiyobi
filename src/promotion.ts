import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve as resolvePath } from "node:path";
import { writeCasBody } from "./capture.ts";
import {
  asDate,
  type CallIdentity,
  type Conference,
  callIdentityOf,
  classifyDeadlineChange,
  cmpStr,
  type Deadline,
  type DeadlineChangeKind,
  deadlineTrackKey,
  type EditionIdentity,
  explicitDeadlineExtension,
  type IdentityProvider,
  isDateOnlyDeadline,
  monthOf,
  type ProviderIdentity,
  parseInstant,
  roundOf,
  slug,
  type VenueIdentity,
} from "./model.ts";

export type PromotionSourceClass = "official-cfp" | "publisher" | "curated-manual" | "aggregator";

export const CFP_PARSER_VERSION = "cfp-observer/2";
const DEFAULT_CAPTURE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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
  round?: number;
  track?: string;
  labelSignature?: string;
  adapter?: string;
  selectorOrField?: string;
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
  providerIdentity?: ProviderIdentity;
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
  providerIdentity?: ProviderIdentity;
  venueId?: string;
  venueIdentity?: Pick<VenueIdentity, "venueId" | "sourceIds">;
  editionId?: string;
  editionIdentity?: Pick<EditionIdentity, "editionId" | "sourceIds">;
  callIdentity?: string | CallIdentity;
}

export interface PromotionResolution {
  resolution_id?: string;
  candidate: string;
  decision: "promote" | "hold" | "reject";
  verifiedFields: string[];
  reason: string;
  verification?: CaptureVerification;
  canonicalization?: PromotionCanonicalization;
  normalized?: {
    venue: {
      key: string;
      title: string;
      categories: string[];
      tags: string[];
      review_state: string;
      identity?: Pick<VenueIdentity, "venueId" | "sourceIds">;
    };
    edition: {
      year: number;
      edition_id: string;
      date_text: string;
      event_start?: string;
      event_end?: string;
      identity?: Pick<EditionIdentity, "editionId" | "sourceIds">;
      call_identity?: CallIdentity;
      call_id?: string;
    };
    deadline: Record<string, unknown>;
  };
}

export type PromotionCanonicalDecision =
  | "add-new-venue"
  | "add-new-edition"
  | "enrich-existing-edition"
  | "supersede-existing-deadline"
  | "duplicate"
  | "hold"
  | "reject";

export interface PromotionCanonicalization {
  decision: PromotionCanonicalDecision;
  score: number;
  matchedBy: string[];
  matchedVenueKey?: string;
  matchedEditionId?: string;
  reason: string;
  changeKind?: DeadlineChangeKind;
  alternatives?: PromotionCanonicalMatch[];
  margin?: number | null;
  autoApplicable?: boolean;
}

export interface PromotionCanonicalMatch {
  venueKey: string;
  score: number;
  matchedBy: string[];
}

export interface CanonicalizationDecision {
  best: PromotionCanonicalMatch | null;
  alternatives: PromotionCanonicalMatch[];
  margin: number | null;
  autoApplicable: boolean;
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
  existingConferences?: readonly Conference[];
  canonicalizationMargin?: number;
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
    .sort(([a], [b]) => cmpStr(a, b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

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
      ? monthOf(monthFirst[1].slice(0, 3))
      : dayFirst
        ? monthOf(dayFirst[2].slice(0, 3))
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

function candidateTrack(text: string): string | undefined {
  const match = /\b(?:track|stream)\s*[:-]\s*([A-Za-z][A-Za-z0-9_-]*)/i.exec(text);
  return match ? slug(match[1]) : undefined;
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
  const rawLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const deadlineLabel = /deadline|due|notification|camera[- ]?ready|締切|期限/i;
  const blockedAdjacentDate =
    /\b(?:submissions?|events?|conferences?|open(?:s|ing)?|starts?|begins?)\b|開催/i;
  const isAdjacentDeadlineLabel = (line: string) =>
    deadlineLabel.test(line) &&
    !/^all deadlines?\b/i.test(line) &&
    !extractedDates(line).length &&
    !/\b(?:open|opens|opening|event|conference)\b|開催/i.test(line);
  const lines = rawLines
    .map((line, index) => {
      const next = rawLines[index + 1];
      if (isAdjacentDeadlineLabel(line) && next && extractedDates(next).length === 1)
        return deadlineLabel.test(next) || blockedAdjacentDate.test(next)
          ? line
          : `${line} ${next}`;
      const previous = rawLines[index - 1];
      return previous &&
        isAdjacentDeadlineLabel(previous) &&
        extractedDates(line).length === 1 &&
        !deadlineLabel.test(line)
        ? ""
        : line;
    })
    .filter(Boolean);
  const globalDeadlineTiming = lines.find(
    (line) =>
      /^all deadlines?\s+(?:are|at)\s+\d{1,2}:\d{2}(?::\d{2})?\s+(?:AoE|UTC(?:[+-]\d{1,2}(?::?\d{2})?)?|GMT(?:[+-]\d{1,2}(?::?\d{2})?)?|PST|PDT|MST|MDT|CST|CDT|EST|EDT|CET|CEST|JST|PT|ET|CT|MT|[A-Za-z_]+\/[A-Za-z_]+)(?:\s*\(Anywhere on Earth\))?[.!]?$/i.test(
        line,
      ) &&
      extractedTime(line) &&
      extractedTimezone(line),
  );
  const defaultTime = globalDeadlineTiming ? extractedTime(globalDeadlineTiming) : undefined;
  const defaultTimezone = globalDeadlineTiming
    ? extractedTimezone(globalDeadlineTiming)
    : undefined;
  const candidates: CfpExtractionCandidate[] = [];
  const seen = new Set<string>();
  const hasTimeExpression = (value: string) =>
    Boolean(extractedTime(value)) ||
    /\b(?:\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)|at\s+\d{3,4}|noon|midnight|end of (?:the )?day|eod)\b/i.test(
      value,
    );
  for (const raw of lines) {
    if (
      !/deadline|due|submission|submit|notification|camera[- ]?ready|call for papers|cfp|event|conference|開催|締切|期限|投稿|募集/i.test(
        raw,
      )
    )
      continue;
    const extracted = extractedDates(raw);
    const headerHasDeadline = /deadline|due|notification|camera[- ]?ready|締切|期限/i.test(
      raw.slice(0, extracted[0]?.index),
    );
    const hasBareMilitaryTime = extracted.some((date, index) =>
      /\b(?:[01]?\d|2[0-3])[0-5]\d\b/.test(raw.slice(date.end, extracted[index + 1]?.index)),
    );
    for (const [index, value] of extracted.entries()) {
      if (!value.date || !value.year) continue;
      const scope =
        extracted.length === 1 ? raw : raw.slice(value.index, extracted[index + 1]?.index);
      const ambiguousLeadingTime =
        extracted.length > 1 && hasTimeExpression(raw.slice(0, extracted[0].index));
      const candidate: CfpExtractionCandidate = {
        rawExcerpt: raw,
        text: raw,
        label: raw,
        kind: candidateKind(raw),
        date: value.date,
        editionYear: value.year,
        round: roundOf(raw),
        ...(candidateTrack(raw) ? { track: candidateTrack(raw) } : {}),
      };
      const localTime = ambiguousLeadingTime ? undefined : extractedTime(scope);
      const localTimezone = ambiguousLeadingTime ? undefined : extractedTimezone(scope);
      const prefix = raw.slice(extracted[index - 1]?.end ?? 0, value.index);
      const currentPrefix = prefix.slice(
        Math.max(prefix.lastIndexOf(";"), prefix.lastIndexOf("|")) + 1,
      );
      const suffix = raw.slice(value.end, extracted[index + 1]?.index ?? raw.length);
      const deadlineSemantics = deadlineLabel;
      const inheritsHeader =
        headerHasDeadline &&
        (/\b(?:round|cycle|phase)\b/i.test(currentPrefix) || /^[\s:—–-]*$/.test(currentPrefix)) &&
        (extracted.length === 1 || /^[\s,;:—–|-]*$/.test(suffix));
      const hasDeadlineSemantics =
        ((deadlineSemantics.test(currentPrefix) &&
          (index === 0 || !/^\s*[—–-]/.test(currentPrefix))) ||
          (extracted.length === 1 && deadlineSemantics.test(raw.slice(value.end))) ||
          inheritsHeader) &&
        !/\b(?:open|opens|opening|start|starts|begin|begins)\b/i.test(`${currentPrefix} ${suffix}`);
      const hasUnparsedTime = !localTime && hasTimeExpression(scope);
      const canUseDefault =
        hasDeadlineSemantics &&
        !hasUnparsedTime &&
        !localTimezone &&
        !hasBareMilitaryTime &&
        (extracted.length === 1 || !hasTimeExpression(raw)) &&
        Boolean(defaultTimezone);
      const time = localTime ?? (canUseDefault ? defaultTime : undefined);
      const timezone = localTimezone ?? (canUseDefault ? defaultTimezone : undefined);
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
  ].sort(cmpStr);
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

const SHARED_PROVIDER_HOSTS: Array<[IdentityProvider, RegExp]> = [
  ["easychair", /(?:^|\.)easychair\.org$/i],
  ["openreview", /(?:^|\.)openreview\.net$/i],
  ["hotcrp", /(?:^|\.)hotcrp\.com$/i],
  ["acm", /(?:^|\.)acm\.org$/i],
  ["ieee", /(?:^|\.)ieee\.org$/i],
];

function cleanProviderKey(value: string): string {
  return decodeURIComponent(value)
    .toLowerCase()
    .replace(/#.*/, "")
    .replace(/^\/+|\/+$/g, "");
}

/** Extract a provider-scoped identity without treating a shared host as a venue. */
export function providerIdentityFromUrl(value: string): ProviderIdentity {
  let url: URL;
  try {
    url = httpUrl(value, "provider URL");
  } catch {
    return { provider: "unknown", providerKey: "", strength: "weak" };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const shared = SHARED_PROVIDER_HOSTS.find(([, pattern]) => pattern.test(host));
  if (shared) {
    const [provider] = shared;
    let providerKey = `${url.pathname}${url.search}`;
    if (provider === "openreview") {
      providerKey = url.searchParams.get("id") ?? url.pathname;
    } else if (provider === "easychair") {
      providerKey = url.pathname;
    } else if (provider === "hotcrp") {
      providerKey = `${host}${url.pathname}`;
    } else if (provider === "acm" || provider === "ieee") {
      providerKey = `${host}${url.pathname}${url.search}`;
    }
    return { provider, providerKey: cleanProviderKey(providerKey), strength: "provider-scoped" };
  }
  if (host === "github.io" || host.endsWith(".github.io"))
    return {
      provider: "github-pages",
      providerKey: cleanProviderKey(`${host}${url.pathname}`),
      strength: "provider-scoped",
    };
  return { provider: "dedicated-domain", providerKey: host, strength: "dedicated-domain" };
}

function providerIdentityFromObservation(observation: PromotionObservation): ProviderIdentity {
  return (
    observation.providerIdentity ??
    captureOf(observation)?.providerIdentity ??
    providerIdentityFromUrl(normalizedEvidence(observation).sourceUrl)
  );
}

function providerIdentityMatches(left: ProviderIdentity, right: ProviderIdentity): boolean {
  if (!left.providerKey || !right.providerKey || left.provider !== right.provider) return false;
  return left.providerKey === right.providerKey;
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
    observation.providerIdentity,
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
    providerIdentity: observation.providerIdentity,
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

function identityValue(value: unknown, field: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return value.trim();
}

function identitySourceIds(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${field} must be an object`);
  const result: Record<string, string> = {};
  for (const [source, sourceId] of Object.entries(value)) {
    const normalizedSource = identityValue(source, `${field} source`);
    const normalizedId = identityValue(sourceId, `${field}.${normalizedSource}`);
    if (normalizedSource && normalizedId) result[normalizedSource] = normalizedId;
  }
  return result;
}

function promotionVenueIdentity(
  observation: PromotionObservation,
): Pick<VenueIdentity, "venueId" | "sourceIds"> | undefined {
  const raw = observation.venueIdentity as unknown;
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw)))
    throw new TypeError("venueIdentity must be an object");
  const value = raw as { venueId?: unknown; sourceIds?: unknown } | undefined;
  const venueId = identityValue(observation.venueId ?? value?.venueId, "venueId");
  const sourceIds = identitySourceIds(value?.sourceIds, "venueIdentity.sourceIds");
  return venueId || Object.keys(sourceIds).length
    ? {
        ...(venueId ? { venueId } : {}),
        ...(Object.keys(sourceIds).length ? { sourceIds } : {}),
      }
    : undefined;
}

function promotionEditionIdentity(
  observation: PromotionObservation,
): Pick<EditionIdentity, "editionId" | "sourceIds"> | undefined {
  const raw = observation.editionIdentity as unknown;
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw)))
    throw new TypeError("editionIdentity must be an object");
  const value = raw as { editionId?: unknown; sourceIds?: unknown } | undefined;
  const editionId = identityValue(observation.editionId ?? value?.editionId, "editionId");
  const sourceIds = identitySourceIds(value?.sourceIds, "editionIdentity.sourceIds");
  return editionId || Object.keys(sourceIds).length
    ? {
        ...(editionId ? { editionId } : {}),
        ...(Object.keys(sourceIds).length ? { sourceIds } : {}),
      }
    : undefined;
}

function promotionCallIdentity(
  observation: PromotionObservation,
): string | CallIdentity | undefined {
  const value = observation.callIdentity;
  if (value === undefined) return undefined;
  if (typeof value === "string") return identityValue(value, "callIdentity") || undefined;
  const normalized = callIdentityOf(value);
  if (!normalized) throw new TypeError("callIdentity must contain seriesId, editionId, and callId");
  return normalized;
}

function sourceIdentityMatches(
  observed: Record<string, string> | undefined,
  existing: Record<string, string> | undefined,
): boolean {
  if (!observed || !existing) return false;
  return Object.entries(observed).some(
    ([source, sourceId]) => existing[source]?.trim() === sourceId,
  );
}

function sourceIdentityConflicts(
  observed: Record<string, string> | undefined,
  existing: Record<string, string> | undefined,
): boolean {
  if (!observed || !existing) return false;
  return Object.entries(observed).some(
    ([source, sourceId]) =>
      Boolean(existing[source]?.trim()) && existing[source]!.trim() !== sourceId,
  );
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
  const observedVenueIdentity = promotionVenueIdentity(observation);
  const observedEditionIdentity = promotionEditionIdentity(observation);
  const observedCallIdentity = promotionCallIdentity(observation);
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
        ...(observedVenueIdentity ? { identity: observedVenueIdentity } : {}),
      },
      edition: {
        year: editionYear,
        edition_id: observedEditionIdentity?.editionId || `${key}-${editionYear}`,
        date_text: observation.eventDate ?? String(editionYear),
        ...(eventStart ? { event_start: eventStart } : {}),
        ...(eventEnd ? { event_end: observation.eventEndDate } : {}),
        ...(observedEditionIdentity ? { identity: observedEditionIdentity } : {}),
        ...(typeof observedCallIdentity === "string"
          ? { call_id: observedCallIdentity }
          : observedCallIdentity
            ? { call_identity: observedCallIdentity }
            : {}),
      },
      deadline,
    },
  };
}

interface PromotionVenueMatch {
  conference: Conference;
  kind: "strong" | "caution";
  score: number;
  matchedBy: string[];
  providerIdentity?: ProviderIdentity;
}

function promotionUrlToken(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return value.trim().toLowerCase().replace(/\/+$/, "");
  }
}

function promotionNameTokens(value: string | undefined): Set<string> {
  return new Set(
    slug(value)
      .replace(/(^|-)20\d{2}(?=-|$)/g, "$1")
      .split("-")
      .filter(Boolean),
  );
}

function promotionNamesMatch(left: string | undefined, right: string | undefined): boolean {
  const leftKey = slug(left).replace(/-20\d{2}(?=-|$)/g, "");
  const rightKey = slug(right).replace(/-20\d{2}(?=-|$)/g, "");
  if (leftKey && leftKey === rightKey) return true;
  const a = promotionNameTokens(left);
  const b = promotionNameTokens(right);
  if (a.size === 0 || b.size === 0) return false;
  const shared = [...a].filter((token) => b.has(token)).length;
  return shared / (a.size + b.size - shared) >= 0.7;
}

function conferenceProviderIdentities(conference: Conference): ProviderIdentity[] {
  const urls = [
    conference.link,
    ...(conference.identity?.officialDomains ?? []),
    ...conference.editions.flatMap((edition) => [
      edition.link,
      ...(edition.identity?.officialUrls ?? []),
    ]),
  ].filter(Boolean);
  const identities = [
    ...(conference.identity?.providerIdentities ?? []),
    ...urls.map((url) => providerIdentityFromUrl(url)),
  ];
  return [
    ...new Map(
      identities
        .filter((item) => item.providerKey)
        .map((item) => [`${item.provider}\0${item.providerKey}`, item]),
    ).values(),
  ];
}

function publicCanonicalMatch(match: PromotionVenueMatch): PromotionCanonicalMatch {
  return {
    venueKey: match.conference.key,
    score: match.score,
    matchedBy: [...match.matchedBy],
  };
}

function matchDecision(
  matches: PromotionVenueMatch[],
  margin = 40,
): { strong: PromotionVenueMatch[]; decision: CanonicalizationDecision } {
  const sorted = [...matches].sort(
    (left, right) => right.score - left.score || cmpStr(left.conference.key, right.conference.key),
  );
  const best = sorted[0] ? publicCanonicalMatch(sorted[0]) : null;
  const second = sorted[1] ? sorted[1].score : null;
  const scoreMargin = best && second !== null ? best.score - second : best ? Infinity : null;
  const strong = sorted.filter((match) => match.kind === "strong");
  const bestStrong = strong[0] ? publicCanonicalMatch(strong[0]) : null;
  const secondStrong = strong[1] ? strong[1].score : null;
  const strongMargin =
    bestStrong && secondStrong !== null
      ? bestStrong.score - secondStrong
      : bestStrong
        ? Infinity
        : null;
  return {
    strong,
    decision: {
      best: bestStrong ?? best,
      alternatives: sorted.slice(1).map(publicCanonicalMatch),
      margin: strongMargin ?? scoreMargin,
      autoApplicable: Boolean(bestStrong && (strongMargin === null || strongMargin >= margin)),
    },
  };
}

function promotionVenueMatch(
  observation: PromotionObservation,
  normalized: NonNullable<PromotionResolution["normalized"]>,
  conference: Conference,
): PromotionVenueMatch | null {
  const candidateKey = slug(normalized.venue.key || observation.candidate);
  const canonicalKeyMatch = candidateKey === slug(conference.key);
  const legacyKeyMatch = Boolean(
    candidateKey && (conference.legacy_keys ?? []).map(slug).includes(candidateKey),
  );
  const observedVenueIdentity = normalized.venue.identity ?? promotionVenueIdentity(observation);
  const observedEditionIdentity =
    normalized.edition.identity ?? promotionEditionIdentity(observation);
  const stableEditionId = observedEditionIdentity?.editionId;
  const stableEditionIdMatch = Boolean(
    stableEditionId &&
      conference.editions.some(
        (edition) =>
          edition.year === normalized.edition.year &&
          [edition.edition_id, edition.identity?.editionId, ...(edition.legacy_ids ?? [])]
            .filter(Boolean)
            .includes(stableEditionId),
      ),
  );
  const venueIdentityConflict = Boolean(
    (observedVenueIdentity?.venueId &&
      conference.identity?.venueId &&
      observedVenueIdentity.venueId !== conference.identity.venueId) ||
      sourceIdentityConflicts(observedVenueIdentity?.sourceIds, conference.identity?.sourceIds),
  );
  if (venueIdentityConflict) return null;
  const stableVenueIdMatch = Boolean(
    conference.identity?.venueId &&
      observedVenueIdentity?.venueId &&
      observedVenueIdentity.venueId === conference.identity.venueId,
  );
  const venueSourceIdMatch = sourceIdentityMatches(
    observedVenueIdentity?.sourceIds,
    conference.identity?.sourceIds,
  );
  const sourceUrl = normalizedEvidence(observation).sourceUrl;
  const officialUrls = [
    conference.link,
    ...conference.editions.flatMap((edition) => [
      edition.link,
      ...(edition.identity?.officialUrls ?? []),
    ]),
  ].filter(Boolean);
  const exactUrl = Boolean(
    sourceUrl &&
      officialUrls.some((url) => promotionUrlToken(url) === promotionUrlToken(sourceUrl)),
  );
  const officialDomains = [...(conference.identity?.officialDomains ?? []), ...officialUrls];
  const domainMatch = Boolean(sourceUrl && isOfficialUrl(sourceUrl, officialDomains));
  const providerIdentity = providerIdentityFromObservation(observation);
  const providerMatch = conferenceProviderIdentities(conference).find((candidate) =>
    providerIdentityMatches(providerIdentity, candidate),
  );
  const observedCallIdentity = promotionCallIdentity(observation);
  const callIdentityMatch = Boolean(
    observedCallIdentity &&
      typeof observedCallIdentity !== "string" &&
      conference.editions.some((edition) => {
        const existing = edition.call_identity;
        return Boolean(
          edition.year === normalized.edition.year &&
            existing &&
            existing.seriesId === observedCallIdentity.seriesId &&
            existing.editionId === observedCallIdentity.editionId &&
            existing.callId === observedCallIdentity.callId &&
            existing.parentEventId === observedCallIdentity.parentEventId,
        );
      }),
  );
  const dedicatedDomainMatch =
    providerIdentity.provider === "dedicated-domain" &&
    providerMatch?.provider === "dedicated-domain" &&
    conference.editions.some((edition) => edition.year === normalized.edition.year);
  const sharedHostMatch = conferenceProviderIdentities(conference).some(
    (candidate) =>
      candidate.provider === providerIdentity.provider &&
      candidate.provider !== "dedicated-domain" &&
      domainMatch,
  );
  const nameMatch =
    promotionNamesMatch(observation.title, conference.title) ||
    promotionNamesMatch(observation.title, conference.full_name) ||
    (conference.identity?.aliases ?? []).some((alias) =>
      promotionNamesMatch(observation.candidate, alias),
    );
  const matchedBy = [
    ...(canonicalKeyMatch ? ["canonical-key"] : []),
    ...(legacyKeyMatch ? ["legacy-key"] : []),
    ...(stableVenueIdMatch ? ["stable-venue-id"] : []),
    ...(stableEditionIdMatch ? ["stable-edition-id"] : []),
    ...(venueSourceIdMatch ? ["stable-venue-source-id"] : []),
    ...(callIdentityMatch ? ["call-identity"] : []),
    ...(exactUrl ? ["official-url"] : []),
    ...(domainMatch ? ["official-domain"] : []),
    ...(providerMatch ? ["provider-identity"] : []),
    ...(sharedHostMatch && !providerMatch ? ["shared-provider-host"] : []),
    ...(nameMatch ? ["name"] : []),
  ];
  if (!matchedBy.length) return null;
  const strongIdentity =
    legacyKeyMatch ||
    stableVenueIdMatch ||
    stableEditionIdMatch ||
    venueSourceIdMatch ||
    callIdentityMatch ||
    (providerMatch !== undefined &&
      (providerIdentity.provider === "github-pages" ||
        providerIdentity.provider === "easychair" ||
        providerIdentity.provider === "openreview" ||
        providerIdentity.provider === "hotcrp" ||
        providerIdentity.provider === "acm" ||
        providerIdentity.provider === "ieee" ||
        (dedicatedDomainMatch && (exactUrl || nameMatch))));
  if (strongIdentity) {
    return {
      conference,
      kind: "strong",
      score:
        (legacyKeyMatch ? 220 : 0) +
        (stableVenueIdMatch ? 240 : 0) +
        (stableEditionIdMatch ? 240 : 0) +
        (venueSourceIdMatch ? 220 : 0) +
        (callIdentityMatch ? 260 : 0) +
        (providerMatch ? 180 : 0) +
        (exactUrl ? 40 : 0) +
        (dedicatedDomainMatch ? 80 : 0) +
        (nameMatch ? 30 : 0),
      matchedBy,
      providerIdentity,
    };
  }
  // Shared names or domains are review signals only; they do not authorize a merge.
  return { conference, kind: "caution", score: nameMatch ? 30 : 20, matchedBy };
}

function promotionDateRangeOverlap(
  start: string | undefined,
  end: string | undefined,
  edition: Conference["editions"][number],
): boolean {
  const leftStart = asDate(start);
  const leftEnd = asDate(end ?? start);
  const rightStart = edition.event_start;
  const rightEnd = edition.event_end ?? edition.event_start;
  return Boolean(
    leftStart &&
      leftEnd &&
      rightStart &&
      rightEnd &&
      leftStart.getTime() <= rightEnd.getTime() &&
      rightStart.getTime() <= leftEnd.getTime(),
  );
}

function promotionEditionMatch(
  observation: PromotionObservation,
  normalized: NonNullable<PromotionResolution["normalized"]>,
  edition: Conference["editions"][number],
): string[] {
  if (edition.year !== normalized.edition.year) return [];
  const observedEditionIdentity =
    normalized.edition.identity ?? promotionEditionIdentity(observation);
  const stableEditionId = observedEditionIdentity?.editionId;
  const existingEditionIds = [
    edition.edition_id,
    edition.identity?.editionId,
    ...(edition.legacy_ids ?? []),
  ].filter((value): value is string => Boolean(value?.trim()));
  const editionIdentityConflict = Boolean(
    (stableEditionId &&
      existingEditionIds.length > 0 &&
      !existingEditionIds.includes(stableEditionId)) ||
      sourceIdentityConflicts(observedEditionIdentity?.sourceIds, edition.identity?.sourceIds),
  );
  if (editionIdentityConflict) return [];
  const stableEditionIdMatch = Boolean(
    stableEditionId && existingEditionIds.includes(stableEditionId),
  );
  const editionSourceIdMatch = sourceIdentityMatches(
    observedEditionIdentity?.sourceIds,
    edition.identity?.sourceIds,
  );
  const observedCallIdentity = promotionCallIdentity(observation);
  const existingCallIdentity = edition.call_identity;
  const callIdentityMatch =
    typeof observedCallIdentity === "string"
      ? Boolean(existingCallIdentity?.callId === observedCallIdentity)
      : Boolean(
          observedCallIdentity &&
            existingCallIdentity &&
            observedCallIdentity.seriesId === existingCallIdentity.seriesId &&
            observedCallIdentity.editionId === existingCallIdentity.editionId &&
            observedCallIdentity.callId === existingCallIdentity.callId &&
            observedCallIdentity.parentEventId === existingCallIdentity.parentEventId,
        );
  if (observedCallIdentity && existingCallIdentity && !callIdentityMatch) return [];
  const sourceUrl = normalizedEvidence(observation).sourceUrl;
  const editionUrls = [edition.link, ...(edition.identity?.officialUrls ?? [])].filter(Boolean);
  const exactUrl = Boolean(
    sourceUrl && editionUrls.some((url) => promotionUrlToken(url) === promotionUrlToken(sourceUrl)),
  );
  const domainMatch = Boolean(sourceUrl && isOfficialUrl(sourceUrl, editionUrls));
  const eventOverlap = promotionDateRangeOverlap(
    normalized.edition.event_start,
    normalized.edition.event_end,
    edition,
  );
  return [
    ...(stableEditionIdMatch ? ["stable-edition-id"] : []),
    ...(editionSourceIdMatch ? ["stable-edition-source-id"] : []),
    ...(callIdentityMatch ? ["call-identity"] : []),
    ...(exactUrl ? ["official-edition-url"] : []),
    ...(domainMatch ? ["official-edition-domain"] : []),
    ...(eventOverlap ? ["event-date"] : []),
  ];
}

function normalizedDeadlineInstant(deadline: Record<string, unknown>): number | null {
  if (deadline.precision === "date-only") return null;
  const date = typeof deadline.date === "string" ? deadline.date : "";
  const tz = typeof deadline.tz === "string" ? deadline.tz : "";
  return parseInstant(date, tz)?.getTime() ?? null;
}

function existingDeadlineInstant(deadline: Deadline): number | null {
  return isDateOnlyDeadline(deadline) ? null : deadline.at_utc.getTime();
}

function normalizedDeadlineDate(deadline: Record<string, unknown>): string {
  return String(deadline.precision === "date-only" ? deadline.date : "");
}

function existingDeadlineDate(deadline: Deadline): string {
  return isDateOnlyDeadline(deadline)
    ? deadline.local_date
    : deadline.at_utc.toISOString().slice(0, 10);
}

function samePromotionDeadlineSlot(
  normalized: NonNullable<PromotionResolution["normalized"]>,
  existing: Deadline,
): boolean {
  const deadline = normalized.deadline;
  const kind = String(deadline.kind ?? "other");
  const round = Number(deadline.round ?? 1) || 1;
  const track = deadlineTrackKey(String(deadline.label ?? ""), kind, String(deadline.track ?? ""));
  const existingTrack = deadlineTrackKey(existing.label, existing.kind, existing.track);
  return existing.kind === kind && existing.round === round && existingTrack === track;
}

function canonicalizePromotion(
  observation: PromotionObservation,
  resolution: PromotionResolution,
  existingConferences: readonly Conference[],
  marginThreshold = 40,
): PromotionCanonicalization {
  if (resolution.decision === "reject")
    return { decision: "reject", score: 0, matchedBy: [], reason: resolution.reason };
  if (resolution.decision !== "promote" || !resolution.normalized)
    return { decision: "hold", score: 0, matchedBy: [], reason: resolution.reason };

  const matches = existingConferences
    .map((conference) => promotionVenueMatch(observation, resolution.normalized!, conference))
    .filter((match): match is PromotionVenueMatch => match !== null);
  const selected = matchDecision(matches, marginThreshold);
  const strong = selected.strong;
  const matchMeta = {
    alternatives: selected.decision.alternatives,
    margin: selected.decision.margin,
    autoApplicable: selected.decision.autoApplicable,
  };
  if (
    strong.length > 1 &&
    (selected.decision.margin === null || selected.decision.margin < marginThreshold)
  )
    return {
      decision: "hold",
      score: strong[0]!.score,
      matchedBy: strong[0]!.matchedBy,
      reason: "multiple existing venues match official promotion evidence",
      ...matchMeta,
    };
  if (strong.length === 0) {
    const caution = matches.sort((a, b) => b.score - a.score)[0];
    if (caution)
      return {
        decision: "hold",
        score: caution.score,
        matchedBy: caution.matchedBy,
        matchedVenueKey: caution.conference.key,
        reason: "name or domain similarity requires manual identity review",
        ...matchMeta,
      };
    return {
      decision: "add-new-venue",
      score: 0,
      matchedBy: [],
      reason: "no existing venue identity matched",
      ...matchMeta,
    };
  }

  const venue = strong[0]!.conference;
  const editionMatches = venue.editions
    .map((edition) => ({
      edition,
      matchedBy: promotionEditionMatch(observation, resolution.normalized!, edition),
    }))
    .filter(({ matchedBy }) => matchedBy.length > 0);
  if (editionMatches.length > 1)
    return {
      decision: "hold",
      score: strong[0]!.score,
      matchedBy: [...strong[0]!.matchedBy],
      matchedVenueKey: venue.key,
      reason: "multiple editions match official promotion evidence",
      ...matchMeta,
    };
  if (editionMatches.length === 0)
    return {
      decision: "add-new-edition",
      score: strong[0]!.score,
      matchedBy: [...strong[0]!.matchedBy],
      matchedVenueKey: venue.key,
      reason: "existing venue matched but no existing edition did",
      ...matchMeta,
    };

  const edition = editionMatches[0]!.edition;
  const matchedBy = [...strong[0]!.matchedBy, ...editionMatches[0]!.matchedBy];
  const deadlineMatches = edition.deadlines.filter((existing) =>
    samePromotionDeadlineSlot(resolution.normalized!, existing),
  );
  if (deadlineMatches.length > 1)
    return {
      decision: "hold",
      score: strong[0]!.score,
      matchedBy,
      matchedVenueKey: venue.key,
      matchedEditionId: edition.edition_id,
      reason: "multiple existing deadlines share the promotion slot",
      ...matchMeta,
    };
  if (deadlineMatches.length === 0)
    return {
      decision: "enrich-existing-edition",
      score: strong[0]!.score,
      matchedBy,
      matchedVenueKey: venue.key,
      matchedEditionId: edition.edition_id,
      reason: "existing edition matched but deadline slot is new",
      ...matchMeta,
    };

  const existing = deadlineMatches[0]!;
  const changeKind = classifyDeadlineChange(existing, resolution.normalized.deadline);
  const candidateInstant = normalizedDeadlineInstant(resolution.normalized.deadline);
  const existingInstant = existingDeadlineInstant(existing);
  const sameDateOnly =
    normalizedDeadlineDate(resolution.normalized.deadline) === existingDeadlineDate(existing);
  if (
    (candidateInstant !== null &&
      existingInstant !== null &&
      candidateInstant === existingInstant) ||
    (candidateInstant === null && existingInstant === null && sameDateOnly)
  )
    return {
      decision: "duplicate",
      score: strong[0]!.score,
      matchedBy,
      matchedVenueKey: venue.key,
      matchedEditionId: edition.edition_id,
      reason: "existing deadline slot and value are identical",
      changeKind,
      ...matchMeta,
    };
  const official =
    observation.sourceClass === "official-cfp" || observation.sourceClass === "publisher";
  const extensionEvidence = normalizedEvidence(observation).rawExcerpt;
  const autoApplicable =
    changeKind === "precision-upgrade" ||
    changeKind === "unchanged" ||
    (changeKind === "extension" && official && explicitDeadlineExtension(extensionEvidence));
  if (!autoApplicable)
    return {
      decision: "hold",
      score: strong[0]!.score,
      matchedBy,
      matchedVenueKey: venue.key,
      matchedEditionId: edition.edition_id,
      reason: `deadline change requires manual resolution: ${changeKind}`,
      changeKind,
      ...matchMeta,
      autoApplicable: false,
    };
  return {
    decision: "supersede-existing-deadline",
    score: strong[0]!.score,
    matchedBy,
    matchedVenueKey: venue.key,
    matchedEditionId: edition.edition_id,
    reason: `official evidence changes an existing deadline value: ${changeKind}`,
    changeKind,
    ...matchMeta,
    autoApplicable: true,
  };
}

/** Resolve a verified promotion against the current catalog without mutating it. */
export function resolvePromotionAgainst(
  observation: PromotionObservation,
  options: CaptureVerificationOptions & { existingConferences: readonly Conference[] },
): PromotionResolution {
  const resolution = resolvePromotion(observation, options);
  return {
    ...resolution,
    canonicalization: canonicalizePromotion(
      observation,
      resolution,
      options.existingConferences,
      options.canonicalizationMargin ?? 40,
    ),
  };
}

export function verifyBatch(
  path: string,
  options: CaptureVerificationOptions = {},
): PromotionResolution[] {
  const manifestPath = join(dirname(path), "manifest.json");
  const manifestBodies = new Map<string, string>();
  const hasManifest = existsSync(manifestPath);
  const observationText = readFileSync(path, "utf8");
  if (hasManifest) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      observations?: { sha256?: unknown };
      resolutions?: { sha256?: unknown };
      bodies?: Array<{ path?: unknown; sha256?: unknown }>;
    };
    if (
      typeof manifest.observations?.sha256 !== "string" ||
      !SHA256.test(manifest.observations.sha256)
    )
      throw new TypeError("manifest observations must contain sha256");
    if (
      createHash("sha256").update(observationText).digest("hex") !==
      manifest.observations.sha256.toLowerCase()
    )
      throw new Error("manifest observations hash mismatch");
    if (
      typeof manifest.resolutions?.sha256 !== "string" ||
      !SHA256.test(manifest.resolutions.sha256)
    )
      throw new TypeError("manifest resolutions must contain sha256");
    if (
      createHash("sha256")
        .update(readFileSync(join(dirname(path), "resolutions.json")))
        .digest("hex") !== manifest.resolutions.sha256.toLowerCase()
    )
      throw new Error("manifest resolutions hash mismatch");
    if (!Array.isArray(manifest.bodies)) throw new TypeError("manifest.bodies must be an array");
    for (const body of manifest.bodies) {
      const sha256 = body.sha256;
      if (
        typeof body.path !== "string" ||
        !/^(?:\.\.\/\.\.\/)?evidence\/blobs\/[0-9a-f]{64}\.body$/.test(body.path) ||
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
  const resolutions = observationText
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const observation = JSON.parse(line) as PromotionObservation;
      const capture = captureOf(observation);
      const resolvedOptions = {
        ...verificationOptions,
        ...(hasManifest
          ? {
              requireManifestBody: true,
              manifestBodyHash: capture?.bodyPath
                ? manifestBodies.get(resolvePath(dirname(path), capture.bodyPath))
                : undefined,
            }
          : {}),
      };
      return verificationOptions.existingConferences
        ? resolvePromotionAgainst(observation, {
            ...resolvedOptions,
            existingConferences: verificationOptions.existingConferences,
          })
        : resolvePromotion(observation, resolvedOptions);
    })
    .sort((a, b) => cmpStr(a.candidate, b.candidate));
  if (hasManifest)
    assertStoredResolutionSemantics(
      path,
      readFileSync(join(dirname(path), "resolutions.json"), "utf8"),
      resolutions,
      {
        allowCaptureFailures: true,
        compareCanonicalization: Boolean(verificationOptions.existingConferences),
      },
    );
  return resolutions;
}

function addResolutionIds(resolutions: PromotionResolution[]): PromotionResolution[] {
  return resolutions.map((resolution) => {
    const body = { ...resolution };
    delete body.resolution_id;
    const digest = createHash("sha256").update(canonicalJson(body)).digest("hex").slice(0, 16);
    return { ...resolution, resolution_id: `resolution-${digest}` };
  });
}

function resolutionEvidenceCore(resolution: PromotionResolution): unknown {
  const normalized = resolution.normalized;
  if (!normalized)
    return { candidate: resolution.candidate, decision: resolution.decision, normalized: null };
  const venue = normalized.venue;
  const edition = normalized.edition;
  const deadline = normalized.deadline;
  return {
    candidate: resolution.candidate,
    decision: resolution.decision,
    normalized: {
      venue: {
        key: venue.key,
        title: venue.title,
        categories: venue.categories,
        tags: venue.tags,
        review_state: venue.review_state,
        identity: venue.identity,
      },
      edition: {
        year: edition.year,
        edition_id: edition.edition_id,
        date_text: edition.date_text,
        event_start: edition.event_start,
        event_end: edition.event_end,
        identity: edition.identity,
        call_identity: edition.call_identity,
        call_id: edition.call_id,
      },
      deadline: {
        kind: deadline.kind,
        round: deadline.round,
        track: deadline.track,
      },
    },
  };
}

function resolutionDeadlineProof(deadline: Record<string, unknown>): string {
  const date = String(deadline.date ?? deadline.value ?? "");
  if (deadline.precision === "date-only") return `date:${date.slice(0, 10)}`;
  const instant = parseInstant(date, String(deadline.tz ?? ""));
  return instant ? `instant:${instant.toISOString()}` : `exact:${date}\0${deadline.tz ?? ""}`;
}

function evidenceBodyPath(observationsPath: string, hash: string): string | null {
  let root = dirname(observationsPath);
  for (;;) {
    const candidate = join(root, "evidence", "blobs", `${hash}.body`);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}

function assertReverifiedResolution(
  observationsPath: string,
  stored: PromotionResolution,
  recomputed: PromotionResolution,
): void {
  const deadline = stored.normalized?.deadline;
  const original = recomputed.normalized?.deadline;
  if (!deadline || !original) throw new Error("stored promotion resolution semantics mismatch");
  const originalProof = resolutionDeadlineProof(original);
  const superseded = Array.isArray(deadline.superseded_deadlines)
    ? deadline.superseded_deadlines
    : [];
  if (!superseded.some((item) => resolutionDeadlineProof(item) === originalProof))
    throw new Error("stored promotion resolution semantics mismatch");
  const evidence = Array.isArray(deadline.evidence) ? deadline.evidence[0] : undefined;
  const hash = String(evidence?.contentHash ?? "").toLowerCase();
  const excerpt = String(evidence?.rawExcerpt ?? "");
  const bodyPath = SHA256.test(hash) ? evidenceBodyPath(observationsPath, hash) : null;
  if (!bodyPath) throw new Error("stored promotion resolution evidence body is missing");
  const body = readFileSync(bodyPath, "utf8");
  if (
    createHash("sha256").update(body).digest("hex") !== hash ||
    !excerpt ||
    !body.includes(excerpt)
  )
    throw new Error("stored promotion resolution evidence mismatch");
  const proof = resolutionDeadlineProof(deadline);
  const supported = extractCfpCandidates(body).some((candidate) =>
    candidate.time && candidate.timezone
      ? resolutionDeadlineProof({
          precision: "exact",
          date: `${candidate.date} ${candidate.time}`,
          tz: candidate.timezone,
        }) === proof
      : proof === `date:${candidate.date}`,
  );
  if (!supported) throw new Error("stored promotion resolution value is not supported by evidence");
}

function assertStoredResolutionSemantics(
  observationsPath: string,
  resolutionText: string,
  recomputed: PromotionResolution[],
  options: {
    allowCaptureFailures?: boolean;
    compareCanonicalization?: boolean;
    appliedResolutionEffects?: ReadonlyMap<string, string>;
  } = {},
): void {
  const stored = JSON.parse(resolutionText) as PromotionResolution[];
  if (!Array.isArray(stored) || stored.length !== recomputed.length)
    throw new Error("stored promotion resolution count mismatch");
  const resolutionIds = stored.map((resolution) => resolution.resolution_id);
  if (
    resolutionIds.some((id) => typeof id !== "string" || !id) ||
    new Set(resolutionIds).size !== resolutionIds.length
  )
    throw new Error("stored promotion resolution IDs must be present and unique");
  for (let index = 0; index < stored.length; index += 1) {
    const current = stored[index]!;
    const original = recomputed[index]!;
    if (current.candidate !== original.candidate)
      throw new Error("stored promotion resolution semantics mismatch");
    if (
      options.allowCaptureFailures &&
      original.decision === "hold" &&
      original.reason === "capture verification failed"
    )
      continue;
    if (options.compareCanonicalization) {
      const appliedEffect = current.resolution_id
        ? options.appliedResolutionEffects?.get(current.resolution_id)
        : undefined;
      const effectiveVenueKey =
        current.canonicalization?.decision === "add-new-edition"
          ? current.canonicalization.matchedVenueKey
          : current.canonicalization?.decision === "add-new-venue" ||
              current.canonicalization === undefined
            ? current.normalized?.venue.key
            : undefined;
      const deadline = current.normalized?.deadline;
      const kind = String(deadline?.kind ?? "paper");
      const effectiveEffect = effectiveVenueKey
        ? [
            effectiveVenueKey,
            String(current.normalized?.edition.edition_id ?? ""),
            kind,
            String(Number(deadline?.round ?? 1) || 1),
            deadlineTrackKey(String(deadline?.label ?? ""), kind, String(deadline?.track ?? "")),
          ].join("\0")
        : undefined;
      if (appliedEffect && effectiveEffect !== appliedEffect)
        throw new Error("stored promotion resolution ID does not match its published deadline");
      if (!appliedEffect && current.resolution_id !== addResolutionIds([current])[0]?.resolution_id)
        throw new Error("stored promotion resolution ID does not match its semantics");
      const canonicalizationMatches = current.canonicalization
        ? canonicalJson(current.canonicalization) === canonicalJson(original.canonicalization) ||
          (Boolean(appliedEffect) && effectiveEffect === appliedEffect)
        : original.canonicalization?.decision === "add-new-venue" ||
          (Boolean(appliedEffect) && effectiveEffect === appliedEffect);
      if (!canonicalizationMatches) throw new Error("stored promotion canonicalization mismatch");
    }
    if (
      canonicalJson(resolutionEvidenceCore(current)) !==
      canonicalJson(resolutionEvidenceCore(original))
    )
      throw new Error("stored promotion resolution semantics mismatch");
    const currentDeadline = current.normalized?.deadline;
    const originalDeadline = original.normalized?.deadline;
    if (!currentDeadline || !originalDeadline) continue;
    if (resolutionDeadlineProof(currentDeadline) !== resolutionDeadlineProof(originalDeadline)) {
      assertReverifiedResolution(observationsPath, current, original);
    } else if (
      canonicalJson({
        evidence: currentDeadline.evidence,
        superseded_deadlines: currentDeadline.superseded_deadlines,
      }) !==
      canonicalJson({
        evidence: originalDeadline.evidence,
        superseded_deadlines: originalDeadline.superseded_deadlines,
      })
    ) {
      throw new Error("stored promotion resolution evidence mismatch");
    }
  }
}

export function verifyPromotionResolutionBatch(
  observationsPath: string,
  resolutionText = readFileSync(join(dirname(observationsPath), "resolutions.json"), "utf8"),
  context: {
    existingConferences?: readonly Conference[];
    appliedResolutionEffects?: ReadonlyMap<string, string>;
  } = {},
): void {
  const { existingConferences } = context;
  const options = { baseDir: dirname(observationsPath), existingConferences };
  const recomputed = readFileSync(observationsPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const observation = JSON.parse(line) as PromotionObservation;
      return existingConferences
        ? resolvePromotionAgainst(observation, { ...options, existingConferences })
        : resolvePromotion(observation, options);
    })
    .sort((left, right) => cmpStr(left.candidate, right.candidate));
  assertStoredResolutionSemantics(observationsPath, resolutionText, recomputed, {
    compareCanonicalization: Boolean(existingConferences),
    appliedResolutionEffects: context.appliedResolutionEffects,
  });
}

export function writePromotionBatch(
  observationsPath: string,
  resolutionsPath: string,
  manifestPath: string,
  options: {
    sourceBaseDir?: string;
    outputObservationsPath?: string;
    existingConferences?: readonly Conference[];
    canonicalizationMargin?: number;
  } = {},
): PromotionResolution[] {
  const batchDir = dirname(manifestPath);
  const promotionsDir = dirname(batchDir);
  const bodyRoot =
    basename(promotionsDir) === "promotions"
      ? join(dirname(promotionsDir), "evidence", "blobs")
      : join(batchDir, "evidence", "blobs");
  const outputObservationsPath = options.outputObservationsPath ?? observationsPath;
  const bodies = new Map<string, { path: string; sha256: string }>();
  const staged = readFileSync(observationsPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const observation = JSON.parse(line) as PromotionObservation;
      const capture = captureOf(observation);
      if (!capture) return { observation };
      const saved = savedBody(capture, {
        baseDir: options.sourceBaseDir ?? dirname(observationsPath),
      });
      if (!saved) throw new TypeError(`saved body missing: ${capture.bodyPath ?? ""}`);
      const sha256 = createHash("sha256").update(saved.bytes).digest("hex");
      const path = `${relative(batchDir, bodyRoot).replaceAll("\\", "/")}/${sha256}.body`;
      return { observation, body: { path, sha256, bytes: saved.bytes } };
    });
  const baseDir = options.sourceBaseDir ?? dirname(observationsPath);
  const resolutions = addResolutionIds(
    staged
      .map(({ observation }) =>
        options.existingConferences
          ? resolvePromotionAgainst(observation, {
              baseDir,
              existingConferences: options.existingConferences,
              canonicalizationMargin: options.canonicalizationMargin,
            })
          : resolvePromotion(observation, { baseDir }),
      )
      .sort((a, b) => cmpStr(a.candidate, b.candidate)),
  );
  for (const { observation, body } of staged) {
    if (!body) continue;
    const target = writeCasBody(bodyRoot, body.sha256, body.bytes);
    bodies.set(body.path, { path: body.path, sha256: body.sha256 });
    const bodyPath = relative(dirname(outputObservationsPath), target) || ".";
    if (observation.capture) observation.capture.bodyPath = bodyPath;
    else observation.bodyPath = bodyPath;
  }
  const observations = staged.map(({ observation }) => canonicalJson(observation)).join("\n");
  const observationText = observations ? `${observations}\n` : "";
  const resolutionText = `${JSON.stringify(resolutions, null, 2)}\n`;
  for (const path of [outputObservationsPath, resolutionsPath, manifestPath])
    mkdirSync(dirname(path), { recursive: true });
  writeFileSync(outputObservationsPath, observationText);
  writeFileSync(resolutionsPath, resolutionText);
  const manifest = {
    schema: 1,
    id: basename(dirname(manifestPath)),
    observations: { sha256: createHash("sha256").update(observationText).digest("hex") },
    resolutions: { sha256: createHash("sha256").update(resolutionText).digest("hex") },
    bodies: [...bodies.values()].sort((a, b) => cmpStr(a.path, b.path)),
    decisions: Object.fromEntries(resolutions.map((item) => [item.candidate, item.decision])),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return resolutions;
}
