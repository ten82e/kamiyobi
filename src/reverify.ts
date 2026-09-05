import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { deadlineSlotId } from "./build.ts";
import {
  assertSafePageUrl,
  capturePage,
  DEFAULT_CAPTURE_LIMITS,
  PageCaptureError,
  type PageObservation,
} from "./capture.ts";
import {
  type Conference,
  classifyDeadlineChange,
  computeNextCheckAt,
  type DeadlineChangeKind,
  dateOnlyWindow,
  deadlineTrackKey,
  explicitDeadlineExtension,
  type IdentityProvider,
  type PromotionRef,
  type ProviderIdentity,
  parseInstant,
  promotionRefOf,
  type VerificationState,
} from "./model.ts";
import {
  type CfpExtractionCandidate,
  extractCfpCandidates,
  providerIdentityFromUrl,
} from "./promotion.ts";

export type ResolutionState = "open" | "accepted" | "rejected" | "applied";

export interface VerificationLedgerEntry extends VerificationState {
  deadline_id: string;
  venue_key: string;
  edition_id: string;
  kind: string;
  round: number;
  track: string;
  label?: string;
  page_id?: string;
  observed_value?: string;
  observed_precision?: "exact" | "date-only";
  evidence_ref?: string;
  raw_excerpt?: string;
  body_ref?: string;
  source_name?: string;
  promotion_ref?: PromotionRef;
}

export interface VerificationPage {
  requested_url: string;
  final_url: string;
  status: number;
  content_type: string;
  content_length: number;
  content_hash: string;
  source_revision: string;
  parser_version: string;
  headers: PageObservation["headers"];
  provider?: IdentityProvider;
  provider_key?: string;
  etag?: string;
  last_modified?: string;
  last_attempt_at: string;
  last_success_at: string | null;
  body_ref: string;
  error?: string;
}

export interface VerificationResolution {
  resolution_id: string;
  deadline_id: string;
  page_id?: string;
  official_url: string;
  observed_at: string;
  state: ResolutionState;
  first_detected_at: string;
  last_seen_at: string;
  resolved_at?: string;
  resolved_by?: string;
  resolution_reason?: string;
  applied_at?: string;
  old_value: string;
  new_value: string;
  change_kind: DeadlineChangeKind;
  evidence_ref?: string;
  content_hash: string;
  raw_excerpt: string;
  /** Compatibility fields retained for consumers of the V1 ledger. */
  status: "changed" | "manual-required";
  previous_value: string;
  current_value: string;
}

export interface VerificationLedgerDeadline extends VerificationLedgerEntry {}

export interface VerificationLedger {
  schema_version: 2;
  producer_revision: "reverification-v2";
  generated_at: string;
  pages: Record<string, VerificationPage>;
  deadlines: Record<string, VerificationLedgerDeadline>;
  aliases: Record<string, string>;
  resolutions: VerificationResolution[];
  /** Non-enumerable V1-compatible view. Use `deadlines` for new code. */
  readonly entries: Record<string, VerificationLedgerEntry>;
}

export interface VerificationTarget {
  deadlineId: string;
  pageId: string;
  url: string;
  sourceClass: "official-cfp" | "publisher" | "official-homepage" | "aggregator" | "unknown";
  providerIdentity?: ProviderIdentity;
  kind: string;
  round: number;
  track: string;
  label: string;
  labelSignature: string;
  selectorOrField?: string;
  adapter?: string;
  callIdentity?: string;
  evidenceExcerpt?: string;
  sourceName?: string;
  promotionRef?: PromotionRef;
  priority: number;
  deadline: JsonDeadline;
  conference: JsonConference;
  edition: JsonEdition;
}

export interface ExtractedDeadlineField extends CfpExtractionCandidate {
  callIdentity?: string | { editionId?: string; callId?: string };
}

export interface ReverificationAdapter {
  name: string;
  supports(observation: PageObservation & { providerIdentity?: ProviderIdentity }): boolean;
  extract(body: Uint8Array, observation: PageObservation): ExtractedDeadlineField[];
}

export interface ReverifyLimits {
  maxPages: number;
  maxDeadlines: number;
  maxPerHost: number;
  minHostIntervalMs: number;
  concurrency: number;
  timeoutMs: number;
  maxBodyBytes: number;
}

export interface ReverifyOptions {
  dataPath: string;
  ledgerPath: string;
  now?: Date;
  due?: boolean;
  bodyRoot?: string;
  fetchImpl?: typeof fetch;
  limits?: Partial<ReverifyLimits>;
  resolutionsPath?: string;
}

export interface ReverifyResult {
  processed: number;
  deferred: number;
  statuses: Record<string, number>;
  ledger: VerificationLedger;
  pages: number;
}

interface JsonEvidence {
  sourceName?: string;
  source_name?: string;
  sourceClass?: string;
  source_class?: string;
  sourceUrl?: string;
  source_url?: string;
  rawExcerpt?: string;
  raw_excerpt?: string;
}

interface JsonDeadline {
  kind?: string;
  label?: string;
  round?: number;
  track?: string;
  precision?: string;
  local_date?: string;
  utc?: string | null;
  aoe?: string | null;
  verification?: Partial<VerificationState>;
  evidence?: JsonEvidence[];
  promotion_ref?: PromotionRef;
  promotionRef?: PromotionRef;
  call_identity?: string | { seriesId?: string; editionId?: string; callId?: string };
  callIdentity?: string | { seriesId?: string; editionId?: string; callId?: string };
  selector_or_field?: string;
  selectorOrField?: string;
  adapter?: string;
}

interface JsonEdition {
  year?: number;
  id?: string;
  edition_id?: string;
  link?: string;
  legacy_ids?: string[];
  identity?: { editionId?: string; sourceIds?: Record<string, string> };
  call_identity?: { seriesId?: string; editionId?: string; callId?: string };
  callIdentity?: { seriesId?: string; editionId?: string; callId?: string };
  deadlines?: JsonDeadline[];
}

interface JsonConference {
  key?: string;
  title?: string;
  link?: string;
  legacy_keys?: string[];
  identity?: { sourceIds?: Record<string, string>; aliases?: string[] };
  editions?: JsonEdition[];
}

interface JsonData {
  conferences?: JsonConference[];
}

const STATUSES = new Set<VerificationState["status"]>([
  "pending",
  "verified",
  "changed",
  "retryable",
  "source-unreachable",
  "parser-failed",
  "manual-required",
]);
const RESOLUTION_STATES = new Set<ResolutionState>(["open", "accepted", "rejected", "applied"]);
const CHANGE_KINDS = new Set<DeadlineChangeKind>([
  "unchanged",
  "precision-upgrade",
  "extension",
  "pull-in",
  "precision-downgrade",
  "different-track",
  "ambiguous",
]);
const MANUAL_CHANGE_KINDS = new Set<DeadlineChangeKind>([
  "pull-in",
  "precision-downgrade",
  "different-track",
  "ambiguous",
]);
const IDENTITY_PROVIDERS = new Set<IdentityProvider>([
  "easychair",
  "openreview",
  "hotcrp",
  "github-pages",
  "acm",
  "ieee",
  "dedicated-domain",
  "unknown",
]);
const SOURCE_CLASSES = new Set([
  "official-cfp",
  "publisher",
  "official-homepage",
  "aggregator",
  "unknown",
]);
const SHA256 = /^[0-9a-f]{64}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validIso(value: unknown, nullable = false): boolean {
  if (nullable && value === null) return true;
  if (typeof value !== "string") return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    calendar.getUTCFullYear() !== Number(year) ||
    calendar.getUTCMonth() !== Number(month) - 1 ||
    calendar.getUTCDate() !== Number(day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  )
    return false;
  return Number.isFinite(Date.parse(value));
}

function pageIdForUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return `page:${createHash("sha256").update(url.toString()).digest("hex")}`;
}

function canonicalUrl(value: string): string {
  const url = assertSafePageUrl(value);
  url.hash = "";
  return url.toString();
}

function attachEntries(ledger: Omit<VerificationLedger, "entries">): VerificationLedger {
  const result = ledger as VerificationLedger;
  Object.defineProperty(result, "entries", {
    configurable: true,
    enumerable: false,
    get: () =>
      Object.fromEntries(
        Object.entries(result.deadlines).map(([id, entry]) => [
          id,
          { ...entry, deadline_id: entry.deadline_id || id },
        ]),
      ),
  });
  return result;
}

function emptyLedger(): VerificationLedger {
  return attachEntries({
    schema_version: 2,
    producer_revision: "reverification-v2",
    generated_at: "",
    pages: {},
    deadlines: {},
    aliases: {},
    resolutions: [],
  });
}

function invalidLedgerEntry(id: string, reason: string): never {
  throw new TypeError(`invalid verification ledger entry:\n${id}: ${reason}`);
}

function stringField(
  id: string,
  raw: Record<string, unknown>,
  field: string,
  fallback = "",
): string {
  const value = raw[field];
  if (value === undefined) return fallback;
  if (typeof value !== "string") return invalidLedgerEntry(id, `${field} is invalid`);
  return value;
}

function roundField(id: string, raw: Record<string, unknown>): number {
  const value = raw.round;
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    return invalidLedgerEntry(id, "round is invalid");
  return value;
}

function safeBodyRef(id: string, value: unknown, field = "body_ref"): string {
  if (value === undefined) return "";
  if (typeof value !== "string") return invalidLedgerEntry(id, `${field} is invalid`);
  if (value === "") return "";
  if (!/^evidence\/blobs\/[a-f0-9]{64}(?:\.body)?$/i.test(value))
    return invalidLedgerEntry(id, `${field} must point inside evidence/blobs`);
  return value;
}

function validProviderIdentity(value: unknown): value is ProviderIdentity {
  if (!isRecord(value)) return false;
  return (
    typeof value.provider === "string" &&
    IDENTITY_PROVIDERS.has(value.provider as IdentityProvider) &&
    typeof value.providerKey === "string" &&
    typeof value.strength === "string" &&
    ["explicit", "provider-scoped", "dedicated-domain", "weak"].includes(value.strength)
  );
}

function safeLedgerUrl(id: string, value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    return invalidLedgerEntry(id, `${field} is missing`);
  try {
    assertSafePageUrl(value);
  } catch (error) {
    return invalidLedgerEntry(id, `${field} is unsafe: ${String(error)}`);
  }
  return value;
}

function validatePage(id: string, raw: unknown): VerificationPage {
  if (!isRecord(raw)) return invalidLedgerEntry(id, "page is not an object");
  for (const field of ["requested_url", "final_url"] as const) {
    safeLedgerUrl(id, raw[field], field);
  }
  if (!validIso(raw.last_attempt_at)) return invalidLedgerEntry(id, "last_attempt_at is invalid");
  if (!validIso(raw.last_success_at, true))
    return invalidLedgerEntry(id, "last_success_at is invalid");
  const status = raw.status === undefined ? 200 : raw.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 0 || status > 599)
    return invalidLedgerEntry(id, "status is invalid");
  if (raw.content_type !== undefined && typeof raw.content_type !== "string")
    return invalidLedgerEntry(id, "content_type is invalid");
  if (
    raw.content_length !== undefined &&
    (typeof raw.content_length !== "number" ||
      !Number.isInteger(raw.content_length) ||
      raw.content_length < 0)
  )
    return invalidLedgerEntry(id, "content_length is invalid");
  const contentHash = raw.content_hash === undefined ? "" : raw.content_hash;
  if (typeof contentHash !== "string" || (contentHash && !SHA256.test(contentHash)))
    return invalidLedgerEntry(id, "content_hash is invalid");
  const bodyRef = safeBodyRef(id, raw.body_ref);
  if (raw.headers !== undefined && !isRecord(raw.headers))
    return invalidLedgerEntry(id, "headers is invalid");
  const nestedHeaders = isRecord(raw.headers) ? raw.headers : {};
  for (const field of ["etag", "lastModified", "last_modified", "retryAfter", "retry_after"]) {
    if (nestedHeaders[field] !== undefined && typeof nestedHeaders[field] !== "string")
      return invalidLedgerEntry(id, `headers.${field} is invalid`);
  }
  const provider = raw.provider;
  if (
    provider !== undefined &&
    (typeof provider !== "string" || !IDENTITY_PROVIDERS.has(provider as IdentityProvider))
  )
    return invalidLedgerEntry(id, "provider is invalid");
  for (const field of [
    "source_revision",
    "parser_version",
    "provider_key",
    "etag",
    "last_modified",
    "error",
  ]) {
    if (raw[field] !== undefined && typeof raw[field] !== "string")
      return invalidLedgerEntry(id, `${field} is invalid`);
  }
  const requestedUrl = raw.requested_url as string;
  const finalUrl = raw.final_url as string;
  const lastAttempt = raw.last_attempt_at as string;
  const lastSuccess = raw.last_success_at === null ? null : (raw.last_success_at as string);
  return {
    requested_url: requestedUrl,
    final_url: finalUrl,
    status,
    content_type: String(raw.content_type ?? ""),
    content_length: Number(raw.content_length ?? 0),
    headers: {
      ...((typeof raw.etag === "string" ? raw.etag : nestedHeaders.etag) !== undefined
        ? { etag: (raw.etag ?? nestedHeaders.etag) as string }
        : {}),
      ...((typeof raw.last_modified === "string"
        ? raw.last_modified
        : (nestedHeaders.lastModified ?? nestedHeaders.last_modified)) !== undefined
        ? {
            lastModified: (raw.last_modified ??
              nestedHeaders.lastModified ??
              nestedHeaders.last_modified) as string,
          }
        : {}),
      ...((nestedHeaders.retryAfter ?? nestedHeaders.retry_after) !== undefined
        ? { retryAfter: (nestedHeaders.retryAfter ?? nestedHeaders.retry_after) as string }
        : {}),
    },
    content_hash: contentHash,
    source_revision: String(raw.source_revision ?? raw.etag ?? raw.last_modified ?? ""),
    parser_version: String(raw.parser_version ?? "reverification-v2"),
    provider: provider as IdentityProvider | undefined,
    ...(typeof raw.provider_key === "string" ? { provider_key: raw.provider_key } : {}),
    ...(typeof raw.etag === "string" ? { etag: raw.etag } : {}),
    ...(typeof raw.last_modified === "string" ? { last_modified: raw.last_modified } : {}),
    last_attempt_at: lastAttempt,
    last_success_at: lastSuccess,
    body_ref: bodyRef,
    ...(typeof raw.error === "string" ? { error: raw.error } : {}),
  };
}

function validateDeadline(
  id: string,
  raw: unknown,
  pages: Record<string, VerificationPage>,
): VerificationLedgerDeadline {
  if (!isRecord(raw)) return invalidLedgerEntry(id, "deadline is not an object");
  if (typeof raw.page_id !== "string" || !raw.page_id)
    return invalidLedgerEntry(id, "page_id is missing");
  if (!pages[raw.page_id]) return invalidLedgerEntry(id, `page_id ${raw.page_id} does not exist`);
  if (!validIso(raw.next_check_at)) return invalidLedgerEntry(id, "next_check_at is invalid");
  if (typeof raw.status !== "string" || !STATUSES.has(raw.status as VerificationState["status"]))
    return invalidLedgerEntry(id, "status is invalid");
  for (const field of [
    "deadline_id",
    "venue_key",
    "edition_id",
    "kind",
    "track",
    "label",
    "official_url",
    "source_name",
    "label_signature",
    "selector_or_field",
    "adapter",
    "observed_value",
    "evidence_ref",
    "raw_excerpt",
  ]) {
    if (raw[field] !== undefined && typeof raw[field] !== "string")
      return invalidLedgerEntry(id, `${field} is invalid`);
  }
  if (
    raw.source_class !== undefined &&
    (typeof raw.source_class !== "string" || !SOURCE_CLASSES.has(raw.source_class))
  )
    return invalidLedgerEntry(id, "source_class is invalid");
  if (
    raw.observed_precision !== undefined &&
    raw.observed_precision !== "exact" &&
    raw.observed_precision !== "date-only"
  )
    return invalidLedgerEntry(id, "observed_precision is invalid");
  for (const field of ["promotion_ref", "promotionRef"]) {
    if (raw[field] !== undefined && raw[field] !== null && !promotionRefOf(raw[field]))
      return invalidLedgerEntry(id, `${field} is invalid`);
  }
  if (raw.provider_identity !== undefined && !validProviderIdentity(raw.provider_identity))
    return invalidLedgerEntry(id, "provider_identity is invalid");
  if (
    raw.last_verified_at !== null &&
    raw.last_verified_at !== undefined &&
    !validIso(raw.last_verified_at)
  )
    return invalidLedgerEntry(id, "last_verified_at is invalid");
  if (raw.last_attempt_at !== undefined && !validIso(raw.last_attempt_at))
    return invalidLedgerEntry(id, "last_attempt_at is invalid");
  if (
    raw.content_hash !== undefined &&
    raw.content_hash !== null &&
    (typeof raw.content_hash !== "string" || (raw.content_hash && !SHA256.test(raw.content_hash)))
  )
    return invalidLedgerEntry(id, "content_hash is invalid");
  const pageId = raw.page_id as string;
  const nextCheck = raw.next_check_at as string;
  const page = pages[pageId];
  const bodyRef = raw.body_ref === undefined ? page.body_ref : safeBodyRef(id, raw.body_ref);
  const officialUrl =
    raw.official_url === undefined
      ? page.requested_url
      : safeLedgerUrl(id, raw.official_url, "official_url");
  const lastAttempt = validIso(raw.last_attempt_at, true)
    ? (raw.last_attempt_at as string)
    : page.last_attempt_at;
  const lastVerified =
    raw.last_verified_at === undefined ? null : (raw.last_verified_at as string | null);
  return {
    deadline_id: stringField(id, raw, "deadline_id", id),
    venue_key: stringField(id, raw, "venue_key"),
    edition_id: stringField(id, raw, "edition_id"),
    kind: stringField(id, raw, "kind", "other"),
    round: roundField(id, raw),
    track: stringField(id, raw, "track"),
    ...(typeof raw.label === "string" ? { label: raw.label } : {}),
    page_id: pageId,
    official_url: officialUrl,
    last_attempt_at: lastAttempt,
    last_verified_at: lastVerified,
    next_check_at: new Date(Date.parse(nextCheck)).toISOString(),
    content_hash:
      raw.content_hash === undefined ? page.content_hash || null : raw.content_hash || null,
    status: raw.status as VerificationState["status"],
    ...(typeof raw.source_class === "string"
      ? { source_class: raw.source_class as VerificationState["source_class"] }
      : {}),
    ...(typeof raw.source_name === "string" ? { source_name: raw.source_name } : {}),
    ...(promotionRefOf(raw.promotion_ref ?? raw.promotionRef)
      ? { promotion_ref: promotionRefOf(raw.promotion_ref ?? raw.promotionRef) }
      : {}),
    ...(validProviderIdentity(raw.provider_identity)
      ? { provider_identity: raw.provider_identity }
      : {}),
    ...(typeof raw.label_signature === "string" ? { label_signature: raw.label_signature } : {}),
    ...(typeof raw.selector_or_field === "string"
      ? { selector_or_field: raw.selector_or_field }
      : {}),
    ...(typeof raw.adapter === "string" ? { adapter: raw.adapter } : {}),
    ...(typeof raw.observed_value === "string" ? { observed_value: raw.observed_value } : {}),
    ...(raw.observed_precision === "exact" || raw.observed_precision === "date-only"
      ? { observed_precision: raw.observed_precision }
      : {}),
    ...(typeof raw.evidence_ref === "string" ? { evidence_ref: raw.evidence_ref } : {}),
    ...(typeof raw.raw_excerpt === "string" ? { raw_excerpt: raw.raw_excerpt } : {}),
    ...(bodyRef ? { body_ref: bodyRef } : {}),
  };
}

function validateResolution(index: number, raw: unknown): VerificationResolution {
  if (!isRecord(raw))
    return invalidLedgerEntry(`resolution[${index}]`, "resolution is not an object");
  const rawId = raw.resolution_id;
  if (rawId !== undefined && typeof rawId !== "string")
    return invalidLedgerEntry(`resolution[${index}]`, "resolution_id is invalid");
  const id = rawId === undefined ? `resolution[${index}]` : rawId;
  if (!id.trim()) return invalidLedgerEntry(`resolution[${index}]`, "resolution_id is missing");
  if (!RESOLUTION_STATES.has(raw.state as ResolutionState))
    return invalidLedgerEntry(id, "state is invalid");
  for (const field of [
    "deadline_id",
    "official_url",
    "old_value",
    "new_value",
    "change_kind",
  ] as const) {
    if (typeof raw[field] !== "string") return invalidLedgerEntry(id, `${field} is invalid`);
  }
  if (!CHANGE_KINDS.has(raw.change_kind as DeadlineChangeKind))
    return invalidLedgerEntry(id, "change_kind is invalid");
  if (raw.status !== undefined && raw.status !== "changed" && raw.status !== "manual-required")
    return invalidLedgerEntry(id, "status is invalid");
  for (const field of [
    "page_id",
    "resolved_at",
    "resolved_by",
    "resolution_reason",
    "applied_at",
    "previous_value",
    "current_value",
  ]) {
    if (raw[field] !== undefined && typeof raw[field] !== "string")
      return invalidLedgerEntry(id, `${field} is invalid`);
  }
  if (
    raw.content_hash !== undefined &&
    raw.content_hash !== "" &&
    !SHA256.test(String(raw.content_hash))
  )
    return invalidLedgerEntry(id, "content_hash is invalid");
  if (raw.raw_excerpt !== undefined && typeof raw.raw_excerpt !== "string")
    return invalidLedgerEntry(id, "raw_excerpt is invalid");
  const evidenceRef = safeBodyRef(id, raw.evidence_ref, "evidence_ref");
  for (const field of ["observed_at", "first_detected_at", "last_seen_at"] as const) {
    if (!validIso(raw[field])) return invalidLedgerEntry(id, `${field} is invalid`);
  }
  for (const field of ["resolved_at", "applied_at"] as const) {
    if (raw[field] !== undefined && !validIso(raw[field]))
      return invalidLedgerEntry(id, `${field} is invalid`);
  }
  if (raw.state === "applied" && typeof raw.applied_at !== "string")
    return invalidLedgerEntry(id, "applied state requires applied_at");
  if (raw.state !== "applied" && raw.applied_at !== undefined)
    return invalidLedgerEntry(id, "applied_at requires applied state");
  const status = raw.status === "manual-required" ? "manual-required" : "changed";
  const deadlineIdValue = raw.deadline_id as string;
  const officialUrl = safeLedgerUrl(id, raw.official_url, "official_url");
  const observedAt = raw.observed_at as string;
  const firstDetectedAt = raw.first_detected_at as string;
  const lastSeenAt = raw.last_seen_at as string;
  const oldValue = raw.old_value as string;
  const newValue = raw.new_value as string;
  if (raw.previous_value !== undefined && raw.previous_value !== oldValue)
    return invalidLedgerEntry(id, "previous_value must match old_value");
  if (raw.current_value !== undefined && raw.current_value !== newValue)
    return invalidLedgerEntry(id, "current_value must match new_value");
  return {
    resolution_id: id,
    deadline_id: deadlineIdValue,
    ...(typeof raw.page_id === "string" ? { page_id: raw.page_id } : {}),
    official_url: officialUrl,
    observed_at: observedAt,
    state: raw.state as ResolutionState,
    first_detected_at: firstDetectedAt,
    last_seen_at: lastSeenAt,
    ...(typeof raw.resolved_at === "string" ? { resolved_at: raw.resolved_at } : {}),
    ...(typeof raw.resolved_by === "string" ? { resolved_by: raw.resolved_by } : {}),
    ...(typeof raw.resolution_reason === "string"
      ? { resolution_reason: raw.resolution_reason }
      : {}),
    ...(typeof raw.applied_at === "string" ? { applied_at: raw.applied_at } : {}),
    old_value: oldValue,
    new_value: newValue,
    change_kind: raw.change_kind as DeadlineChangeKind,
    ...(evidenceRef ? { evidence_ref: evidenceRef } : {}),
    content_hash: String(raw.content_hash ?? ""),
    raw_excerpt: String(raw.raw_excerpt ?? ""),
    status,
    previous_value: String(raw.previous_value ?? oldValue),
    current_value: String(raw.current_value ?? newValue),
  };
}

function validateLedgerBindings(ledger: VerificationLedger): VerificationLedger {
  for (const oldId of Object.keys(ledger.aliases)) {
    const seen = new Set<string>();
    let current = oldId;
    while (ledger.aliases[current]) {
      if (seen.has(current)) invalidLedgerEntry(oldId, "alias graph contains a cycle");
      seen.add(current);
      current = ledger.aliases[current]!;
    }
    if (!ledger.deadlines[current])
      invalidLedgerEntry(oldId, `alias target does not resolve to a deadline: ${current}`);
    ledger.aliases[oldId] = current;
  }
  for (const [id, deadline] of Object.entries(ledger.deadlines)) {
    const pageId = deadline.page_id;
    if (!pageId) invalidLedgerEntry(id, "page_id is missing");
    const page = ledger.pages[pageId];
    if (!page) invalidLedgerEntry(id, `page_id does not exist: ${pageId}`);
    if (pageIdForUrl(deadline.official_url) !== pageIdForUrl(page.requested_url))
      invalidLedgerEntry(id, "official_url does not match page requested_url");
  }
  const resolutionIds = new Set<string>();
  for (const resolution of ledger.resolutions) {
    if (resolutionIds.has(resolution.resolution_id))
      invalidLedgerEntry(resolution.resolution_id, "duplicate resolution_id");
    resolutionIds.add(resolution.resolution_id);
    const deadline =
      ledger.deadlines[resolution.deadline_id] ??
      ledger.deadlines[ledger.aliases[resolution.deadline_id] ?? ""];
    if (!deadline)
      invalidLedgerEntry(
        resolution.resolution_id,
        `deadline_id does not resolve to a deadline: ${resolution.deadline_id}`,
      );
    if (resolution.page_id && !ledger.pages[resolution.page_id])
      invalidLedgerEntry(resolution.resolution_id, `page_id does not exist: ${resolution.page_id}`);
    if (resolution.page_id && resolution.page_id !== deadline.page_id)
      invalidLedgerEntry(resolution.resolution_id, "page_id does not match deadline page_id");
    if (pageIdForUrl(resolution.official_url) !== pageIdForUrl(deadline.official_url))
      invalidLedgerEntry(
        resolution.resolution_id,
        "official_url does not match deadline official_url",
      );
  }
  return ledger;
}

function migrateV1(value: Record<string, unknown>): VerificationLedger {
  if (!isRecord(value.entries))
    throw new TypeError("invalid verification ledger: entries is not an object");
  if (!Array.isArray(value.resolutions))
    throw new TypeError("invalid verification ledger: resolutions is not an array");
  if (value.generated_at !== undefined && !validIso(value.generated_at))
    invalidLedgerEntry("<ledger>", "generated_at is invalid");
  const ledger = emptyLedger();
  ledger.generated_at = typeof value.generated_at === "string" ? value.generated_at : "";
  for (const [id, raw] of Object.entries(value.entries)) {
    if (!isRecord(raw)) invalidLedgerEntry(id, "entry is not an object");
    const officialUrl = raw.official_url;
    if (typeof officialUrl !== "string" || !officialUrl.trim())
      invalidLedgerEntry(id, "official_url is missing");
    let pageId: string;
    try {
      pageId = pageIdForUrl(officialUrl);
      assertSafePageUrl(officialUrl);
    } catch (error) {
      invalidLedgerEntry(id, `official_url is unsafe: ${String(error)}`);
    }
    const lastAttempt =
      raw.last_attempt_at === undefined || raw.last_attempt_at === null
        ? ledger.generated_at || new Date(0).toISOString()
        : raw.last_attempt_at;
    if (typeof lastAttempt !== "string" || !validIso(lastAttempt))
      invalidLedgerEntry(id, "last_attempt_at is invalid");
    const lastVerifiedValue = raw.last_verified_at;
    if (
      lastVerifiedValue !== undefined &&
      lastVerifiedValue !== null &&
      (typeof lastVerifiedValue !== "string" || !validIso(lastVerifiedValue))
    )
      invalidLedgerEntry(id, "last_verified_at is invalid");
    const lastVerified =
      lastVerifiedValue === undefined || lastVerifiedValue === null ? null : lastVerifiedValue;
    const contentHashValue = raw.content_hash;
    if (
      contentHashValue !== undefined &&
      contentHashValue !== null &&
      (typeof contentHashValue !== "string" ||
        (contentHashValue !== "" && !SHA256.test(contentHashValue)))
    )
      invalidLedgerEntry(id, "content_hash is invalid");
    const contentHash =
      contentHashValue === undefined || contentHashValue === null ? "" : contentHashValue;
    for (const field of ["etag", "last_modified", "label", "source_name"]) {
      if (raw[field] !== undefined && typeof raw[field] !== "string")
        invalidLedgerEntry(id, `${field} is invalid`);
    }
    const bodyRef = safeBodyRef(id, raw.body_ref);
    const page =
      ledger.pages[pageId] ??
      ({
        requested_url: officialUrl,
        final_url: officialUrl,
        status: 200,
        content_type: "",
        content_length: 0,
        headers: {},
        content_hash: contentHash,
        source_revision: contentHash ? `sha256:${contentHash}` : "",
        parser_version: "reverification-v1-migrated",
        last_attempt_at: lastAttempt,
        last_success_at: lastVerified,
        body_ref: bodyRef,
        ...(typeof raw.etag === "string" ? { etag: raw.etag } : {}),
        ...(typeof raw.last_modified === "string" ? { last_modified: raw.last_modified } : {}),
        provider: providerIdentityFromUrl(officialUrl).provider,
      } satisfies VerificationPage);
    ledger.pages[pageId] = page;
    const next = raw.next_check_at;
    if (!validIso(next)) invalidLedgerEntry(id, "next_check_at is invalid");
    const status = raw.status as VerificationState["status"];
    if (!STATUSES.has(status)) invalidLedgerEntry(id, "status is invalid");
    ledger.deadlines[id] = {
      deadline_id: id,
      venue_key: stringField(id, raw, "venue_key"),
      edition_id: stringField(id, raw, "edition_id"),
      kind: stringField(id, raw, "kind", "other"),
      round: roundField(id, raw),
      track: stringField(id, raw, "track"),
      ...(typeof raw.label === "string" ? { label: raw.label } : {}),
      page_id: pageId,
      official_url: officialUrl,
      last_attempt_at: lastAttempt,
      last_verified_at: lastVerified,
      next_check_at: new Date(Date.parse(String(next))).toISOString(),
      content_hash: contentHash || null,
      status,
      ...(typeof raw.source_name === "string" ? { source_name: raw.source_name } : {}),
      ...(raw.body_ref !== undefined ? { body_ref: bodyRef } : {}),
    };
  }
  for (const [index, raw] of value.resolutions.entries()) {
    if (!isRecord(raw)) invalidLedgerEntry(`resolution[${index}]`, "resolution is not an object");
    const resolutionKey = `resolution[${index}]`;
    const deadlineId = raw.deadline_id;
    if (typeof deadlineId !== "string" || !deadlineId.trim())
      invalidLedgerEntry(resolutionKey, "deadline_id is invalid");
    const oldValue =
      raw.previous_value === undefined || raw.previous_value === null ? "" : raw.previous_value;
    const newValue =
      raw.current_value === undefined || raw.current_value === null ? "" : raw.current_value;
    if (typeof oldValue !== "string")
      invalidLedgerEntry(resolutionKey, "previous_value is invalid");
    if (typeof newValue !== "string") invalidLedgerEntry(resolutionKey, "current_value is invalid");
    const observedAt =
      raw.observed_at === undefined || raw.observed_at === null
        ? ledger.generated_at
        : raw.observed_at;
    if (typeof observedAt !== "string" || !validIso(observedAt))
      invalidLedgerEntry(resolutionKey, "observed_at is invalid");
    const status = raw.status === undefined ? "changed" : raw.status;
    if (status !== "changed" && status !== "manual-required")
      invalidLedgerEntry(resolutionKey, "status is invalid");
    const contentHash =
      raw.content_hash === undefined || raw.content_hash === null ? "" : raw.content_hash;
    if (typeof contentHash !== "string" || (contentHash !== "" && !SHA256.test(contentHash)))
      invalidLedgerEntry(resolutionKey, "content_hash is invalid");
    const rawExcerpt =
      raw.raw_excerpt === undefined || raw.raw_excerpt === null ? "" : raw.raw_excerpt;
    if (typeof rawExcerpt !== "string") invalidLedgerEntry(resolutionKey, "raw_excerpt is invalid");
    const resolutionId = `resolution:${createHash("sha256")
      .update(`${deadlineId}\0${oldValue}\0${newValue}\0${contentHash}`)
      .digest("hex")}`;
    const officialUrl = safeLedgerUrl(resolutionKey, raw.official_url, "official_url");
    ledger.resolutions.push({
      resolution_id: resolutionId,
      deadline_id: deadlineId,
      official_url: officialUrl,
      observed_at: observedAt,
      state: "open",
      first_detected_at: observedAt,
      last_seen_at: observedAt,
      old_value: oldValue,
      new_value: newValue,
      change_kind: "ambiguous",
      content_hash: contentHash,
      raw_excerpt: rawExcerpt,
      status: "manual-required",
      previous_value: oldValue,
      current_value: newValue,
    });
  }
  return validateLedgerBindings(ledger);
}

export function loadVerificationLedger(path: string): VerificationLedger {
  if (!existsSync(path)) return emptyLedger();
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) throw new TypeError("root is not an object");
    value = parsed;
  } catch (error) {
    throw new TypeError(`invalid verification ledger: ${path}: ${String(error)}`);
  }
  if (value.schema_version === 1) return migrateV1(value);
  if (value.schema_version !== 2)
    throw new TypeError(`invalid verification ledger: ${path}: schema_version is not 2`);
  if (value.producer_revision !== "reverification-v2")
    throw new TypeError(`invalid verification ledger: ${path}: producer_revision is invalid`);
  if (!validIso(value.generated_at))
    throw new TypeError(`invalid verification ledger: ${path}: generated_at is invalid`);
  if (!isRecord(value.pages))
    throw new TypeError(`invalid verification ledger: ${path}: pages is not an object`);
  if (!isRecord(value.deadlines))
    throw new TypeError(`invalid verification ledger: ${path}: deadlines is not an object`);
  if (!isRecord(value.aliases))
    throw new TypeError(`invalid verification ledger: ${path}: aliases is not an object`);
  if (!Array.isArray(value.resolutions))
    throw new TypeError(`invalid verification ledger: ${path}: resolutions is not an array`);
  const pages = Object.fromEntries(
    Object.entries(value.pages).map(([id, raw]) => [id, validatePage(id, raw)]),
  );
  const deadlines = Object.fromEntries(
    Object.entries(value.deadlines).map(([id, raw]) => [id, validateDeadline(id, raw, pages)]),
  );
  const aliases: Record<string, string> = {};
  for (const [oldId, newId] of Object.entries(value.aliases)) {
    if (typeof newId !== "string" || !newId) invalidLedgerEntry(oldId, "alias target is invalid");
    if (!oldId || oldId === newId)
      invalidLedgerEntry(oldId || "<missing>", "alias is self-referential");
    if (deadlines[oldId]) invalidLedgerEntry(oldId, "alias shadows a canonical deadline");
    aliases[oldId] = newId;
  }
  const resolutions = value.resolutions.map((raw, index) => validateResolution(index, raw));
  return validateLedgerBindings(
    attachEntries({
      schema_version: 2,
      producer_revision: "reverification-v2",
      generated_at: typeof value.generated_at === "string" ? value.generated_at : "",
      pages,
      deadlines,
      aliases,
      resolutions,
    }),
  );
}

function serializableLedger(ledger: VerificationLedger): Record<string, unknown> {
  return {
    schema_version: 2,
    producer_revision: "reverification-v2",
    generated_at: ledger.generated_at,
    pages: Object.fromEntries(Object.entries(ledger.pages).sort(([a], [b]) => a.localeCompare(b))),
    deadlines: Object.fromEntries(
      Object.entries(ledger.deadlines).sort(([a], [b]) => a.localeCompare(b)),
    ),
    aliases: Object.fromEntries(
      Object.entries(ledger.aliases).sort(([a], [b]) => a.localeCompare(b)),
    ),
    resolutions: [...ledger.resolutions].sort((a, b) =>
      a.resolution_id.localeCompare(b.resolution_id),
    ),
  };
}

export function writeVerificationLedger(path: string, ledger: VerificationLedger): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(serializableLedger(ledger), null, 2)}\n`, "utf8");
}

export function writeVerificationResolutions(path: string, ledger: VerificationLedger): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ schema_version: 1, producer_revision: "reverification-v2", resolutions: ledger.resolutions }, null, 2)}\n`,
    "utf8",
  );
}

function assertCapturedResolutionBody(
  path: string,
  ledger: VerificationLedger,
  resolution: VerificationResolution,
): void {
  const deadline =
    ledger.deadlines[resolution.deadline_id] ??
    ledger.deadlines[ledger.aliases[resolution.deadline_id] ?? ""];
  if (!deadline) throw new Error(`resolution deadline is missing: ${resolution.resolution_id}`);
  const page = resolution.page_id
    ? ledger.pages[resolution.page_id]
    : deadline?.page_id
      ? ledger.pages[deadline.page_id]
      : undefined;
  const contentHash = resolution.content_hash || page?.content_hash || deadline?.content_hash || "";
  if (!SHA256.test(contentHash))
    throw new Error(`resolution has no captured body hash: ${resolution.resolution_id}`);
  if (
    !page ||
    !SHA256.test(page.content_hash) ||
    page.content_hash.toLowerCase() !== contentHash.toLowerCase()
  )
    throw new Error(
      `resolution captured body does not match target page: ${resolution.resolution_id}`,
    );
  const bodyRef = resolution.evidence_ref || page.body_ref;
  if (!bodyRef) throw new Error(`resolution captured body is missing: ${resolution.resolution_id}`);
  if (!page.body_ref || bodyRef !== page.body_ref)
    throw new Error(
      `resolution captured body does not match target page: ${resolution.resolution_id}`,
    );
  const referencedHash = /^evidence\/blobs\/([a-f0-9]{64})(?:\.body)?$/i.exec(bodyRef)?.[1];
  if (referencedHash?.toLowerCase() !== contentHash.toLowerCase())
    throw new Error(
      `resolution captured body reference hash mismatch: ${resolution.resolution_id}`,
    );
  const bodyPath = resolve(dirname(path), bodyRef);
  if (!existsSync(bodyPath))
    throw new Error(`resolution captured body is missing: ${resolution.resolution_id}`);
  const bodyBytes = readFileSync(bodyPath);
  const observedHash = createHash("sha256").update(bodyBytes).digest("hex");
  if (observedHash !== contentHash.toLowerCase())
    throw new Error(`resolution captured body hash mismatch: ${resolution.resolution_id}`);
  const body = bodyBytes.toString("utf8");
  const valueProof = (value: string): string => {
    const text = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `date:${text}`;
    const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?\s*(\S+)$/.exec(text);
    const instant = match ? parseInstant(`${match[1]} ${match[2]}`, match[3]) : null;
    return instant ? `instant:${instant.toISOString()}` : "";
  };
  const expected = valueProof(resolution.new_value);
  const excerpt = resolution.raw_excerpt.trim().replace(/\s+/g, " ");
  const supported = extractCfpCandidates(body).some(
    (candidate) =>
      candidate.kind === deadline.kind &&
      (candidate.round ?? 1) === deadline.round &&
      candidateTrack(candidate) === deadline.track &&
      valueProof(candidateValue(candidate)) === expected &&
      candidate.rawExcerpt.trim().replace(/\s+/g, " ") === excerpt,
  );
  if (!expected || !supported)
    throw new Error(
      `resolution captured body does not support new value: ${resolution.resolution_id}`,
    );
}

export function assertResolutionCanApply(path: string, resolutionId: string): void {
  const ledger = loadVerificationLedger(path);
  const resolution = ledger.resolutions.find((item) => item.resolution_id === resolutionId);
  if (!resolution) throw new Error(`unknown verification resolution: ${resolutionId}`);
  if (resolution.state === "applied")
    throw new Error(`verification resolution is already applied: ${resolutionId}`);
  if (resolution.state === "rejected")
    throw new Error(`rejected verification resolution cannot be applied: ${resolutionId}`);
  if (
    (resolution.status === "manual-required" || MANUAL_CHANGE_KINDS.has(resolution.change_kind)) &&
    resolution.state !== "accepted"
  )
    throw new Error(
      `manual-required verification resolution needs accepted state: ${resolutionId}`,
    );
  assertCapturedResolutionBody(path, ledger, resolution);
}

export function transitionVerificationResolution(
  path: string,
  resolutionId: string,
  state: ResolutionState,
  reason = "",
  now = new Date(),
): VerificationLedger {
  const ledger = loadVerificationLedger(path);
  const resolution = ledger.resolutions.find((item) => item.resolution_id === resolutionId);
  if (!resolution) throw new Error(`unknown verification resolution: ${resolutionId}`);
  if (resolution.state === "applied" && state !== "applied")
    throw new Error(`verification resolution is already applied: ${resolutionId}`);
  if (resolution.state === "rejected" && state !== "rejected")
    throw new Error(`rejected verification resolution cannot transition: ${resolutionId}`);
  if (state === "applied") assertResolutionCanApply(path, resolutionId);
  resolution.state = state;
  resolution.resolved_at = now.toISOString();
  resolution.resolved_by = "cli";
  if (reason) resolution.resolution_reason = reason;
  if (state === "applied") {
    resolution.applied_at = now.toISOString();
    const deadline =
      ledger.deadlines[resolution.deadline_id] ??
      ledger.deadlines[ledger.aliases[resolution.deadline_id] ?? ""];
    if (deadline) {
      deadline.status = "verified";
      deadline.last_verified_at = now.toISOString();
      deadline.observed_value = resolution.new_value;
      if (resolution.content_hash) deadline.content_hash = resolution.content_hash;
      if (resolution.evidence_ref) deadline.evidence_ref = resolution.evidence_ref;
    }
  }
  writeVerificationLedger(path, ledger);
  writeVerificationResolutions(join(dirname(path), "reverification-resolutions.json"), ledger);
  return ledger;
}

export function deadlineId(
  conference: JsonConference,
  edition: JsonEdition,
  deadline: JsonDeadline,
): string {
  const key = String(conference.key ?? "");
  const editionId = String(edition.id ?? edition.edition_id ?? edition.year ?? "");
  const kind = String(deadline.kind ?? "other");
  const round = Number(deadline.round ?? 1) || 1;
  const track = deadlineTrackKey(String(deadline.label ?? ""), kind, String(deadline.track ?? ""));
  return deadlineSlotId(key, editionId, kind, round, track);
}

function deadlineCutoff(deadline: JsonDeadline): Date | null {
  if (deadline.precision === "date-only")
    return dateOnlyWindow(deadline.local_date)?.latestPossibleUtc ?? null;
  const exact = new Date(String(deadline.utc ?? ""));
  return Number.isNaN(exact.getTime()) ? null : exact;
}

function deadlineValue(deadline: JsonDeadline): string {
  return String(
    deadline.precision === "date-only" ? (deadline.local_date ?? "") : (deadline.utc ?? ""),
  );
}

function retryAfterAt(value: string | undefined, now: Date): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return now.getTime() + Number(value) * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nextCheck(
  deadline: JsonDeadline,
  now: Date,
  previous: string | undefined,
  retryAfter: string | undefined,
): string {
  const scheduled =
    computeNextCheckAt(deadlineCutoff(deadline), now) ??
    previous ??
    new Date(now.getTime() + DAY_MS).toISOString();
  const retryAt = retryAfterAt(retryAfter, now);
  return new Date(Math.max(Date.parse(scheduled), retryAt ?? 0)).toISOString();
}

function labelSignature(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/g, " ")
    .replace(
      /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,|\s)\s*20\d{2}\b/gi,
      " ",
    )
    .replace(/\b20\d{2}\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b(?:AoE|UTC|GMT|PST|PDT|MST|MDT|CST|CDT|EST|EDT|CET|CEST|JST|PT|ET|CT|MT)\b/gi, " ")
    .replace(/\b(?:deadline|due|submission date|date)\b/g, " ")
    .replace(/\b(?:round|cycle|phase|stage)\s*#?\s*\d+\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function excerptSignature(value: string): string {
  return labelSignature(value.replace(/<[^>]+>/g, " ").replace(/&(?:#\d+|#x[\da-f]+|\w+);/gi, " "));
}

function callIdentityKey(value: unknown): string {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (!isRecord(value)) return "";
  return String(
    value.callId ??
      value.call_id ??
      value.editionId ??
      value.edition_id ??
      value.seriesId ??
      value.series_id ??
      "",
  )
    .trim()
    .toLowerCase();
}

function sourceClassOf(value: unknown): VerificationTarget["sourceClass"] {
  return value === "official-cfp" ||
    value === "publisher" ||
    value === "official-homepage" ||
    value === "aggregator"
    ? value
    : "unknown";
}

function evidenceFor(deadline: JsonDeadline): JsonEvidence | undefined {
  return [...(deadline.evidence ?? [])].sort((a, b) => {
    const rank = (item: JsonEvidence): number => {
      const source = String(item.sourceClass ?? item.source_class ?? "");
      return source === "official-cfp"
        ? 0
        : source === "publisher"
          ? 1
          : source === "official-homepage"
            ? 2
            : source === "aggregator"
              ? 3
              : 4;
    };
    return rank(a) - rank(b);
  })[0];
}

function sourceOf(deadline: JsonDeadline): {
  sourceClass: VerificationTarget["sourceClass"];
  url: string;
  evidence?: JsonEvidence;
} {
  const verified = String(deadline.verification?.official_url ?? "").trim();
  if (verified) {
    const evidence = (deadline.evidence ?? []).find(
      (item) => String(item.sourceUrl ?? item.source_url ?? "").trim() === verified,
    );
    const stateClass = sourceClassOf(deadline.verification?.source_class);
    return {
      sourceClass:
        stateClass === "unknown"
          ? sourceClassOf(evidence?.sourceClass ?? evidence?.source_class)
          : stateClass,
      url: verified,
      ...(evidence ? { evidence } : {}),
    };
  }
  const evidence = evidenceFor(deadline);
  return {
    sourceClass: sourceClassOf(evidence?.sourceClass ?? evidence?.source_class),
    url: String(evidence?.sourceUrl ?? evidence?.source_url ?? "").trim(),
    ...(evidence ? { evidence } : {}),
  };
}

function autoSource(target: VerificationTarget): boolean {
  if (target.sourceClass === "official-cfp") return true;
  if (target.sourceClass === "official-homepage")
    return Boolean(target.providerIdentity?.providerKey);
  if (target.sourceClass !== "publisher") return false;
  return Boolean(
    target.providerIdentity?.providerKey && target.providerIdentity.provider !== "unknown",
  );
}

function priorityOf(deadline: JsonDeadline, now: Date): number {
  const cutoff = deadlineCutoff(deadline);
  const days = cutoff ? (cutoff.getTime() - now.getTime()) / DAY_MS : Infinity;
  let priority = 0;
  if (days <= 7) priority += 400;
  else if (days <= 30) priority += 300;
  else if (days <= 90) priority += 100;
  if (deadline.precision === "date-only") priority += 40;
  if (deadline.verification?.status === "changed") priority += 80;
  return priority - (Number.isFinite(days) ? Math.max(0, days) : 0);
}

function targetFor(
  conference: JsonConference,
  edition: JsonEdition,
  deadline: JsonDeadline,
  id: string,
  now: Date,
  ledger: VerificationLedger,
): VerificationTarget | null {
  const state = ledger.deadlines[id] ?? deadline.verification;
  const source = sourceOf(deadline);
  const evidence = source.evidence;
  const sourceClass = source.sourceClass;
  const url = source.url;
  if (!url) return null;
  let safeUrl: string;
  try {
    safeUrl = canonicalUrl(url);
  } catch {
    return null;
  }
  const providerIdentity = state?.provider_identity ?? providerIdentityFromUrl(safeUrl);
  const kind = String(deadline.kind ?? "other");
  const round = Number(deadline.round ?? 1) || 1;
  const callIdentity = callIdentityKey(
    deadline.call_identity ??
      deadline.callIdentity ??
      edition.call_identity ??
      edition.callIdentity,
  );
  return {
    deadlineId: id,
    pageId: state?.page_id ?? pageIdForUrl(safeUrl),
    url: safeUrl,
    sourceClass,
    ...(providerIdentity.providerKey ? { providerIdentity } : {}),
    kind,
    round,
    track: deadlineTrackKey(String(deadline.label ?? ""), kind, String(deadline.track ?? "")),
    label: String(deadline.label ?? kind),
    labelSignature: state?.label_signature ?? labelSignature(String(deadline.label ?? "")),
    ...((state?.selector_or_field ?? deadline.selector_or_field ?? deadline.selectorOrField)
      ? {
          selectorOrField: String(
            state?.selector_or_field ?? deadline.selector_or_field ?? deadline.selectorOrField,
          ),
        }
      : {}),
    ...((state?.adapter ?? deadline.adapter)
      ? { adapter: String(state?.adapter ?? deadline.adapter) }
      : {}),
    ...(callIdentity ? { callIdentity } : {}),
    ...((evidence?.rawExcerpt ?? evidence?.raw_excerpt)
      ? { evidenceExcerpt: String(evidence.rawExcerpt ?? evidence.raw_excerpt) }
      : {}),
    ...((evidence?.sourceName ?? evidence?.source_name)
      ? { sourceName: String(evidence.sourceName ?? evidence.source_name) }
      : {}),
    ...((deadline.promotion_ref ?? deadline.promotionRef)
      ? { promotionRef: deadline.promotion_ref ?? deadline.promotionRef }
      : {}),
    priority: priorityOf(deadline, now),
    deadline,
    conference,
    edition,
  };
}

export function collectVerificationTargets(
  data: JsonData,
  ledger: VerificationLedger,
  now: Date,
  due = false,
): VerificationTarget[] {
  const targets: VerificationTarget[] = [];
  for (const conference of data.conferences ?? []) {
    for (const edition of conference.editions ?? []) {
      for (const deadline of edition.deadlines ?? []) {
        const cutoff = deadlineCutoff(deadline);
        if (cutoff && cutoff.getTime() <= now.getTime()) continue;
        const id = deadlineId(conference, edition, deadline);
        const target = targetFor(conference, edition, deadline, id, now, ledger);
        if (!target) continue;
        const state = ledger.deadlines[id] ?? deadline.verification;
        if (due && state?.next_check_at && Date.parse(state.next_check_at) > now.getTime())
          continue;
        targets.push(target);
      }
    }
  }
  return targets.sort(
    (a, b) => b.priority - a.priority || a.deadlineId.localeCompare(b.deadlineId),
  );
}

function genericFields(
  body: Uint8Array,
  adapter: string,
  selectorOrField: string,
): ExtractedDeadlineField[] {
  const text = new TextDecoder().decode(body);
  return extractCfpCandidates(text).map((candidate) => ({
    ...candidate,
    adapter,
    selectorOrField,
  }));
}

export const REVERIFICATION_ADAPTERS: ReverificationAdapter[] = [
  {
    name: "easychair-v1",
    supports: (observation) => observation.providerIdentity?.provider === "easychair",
    extract: (body) => genericFields(body, "easychair-v1", "table-row:deadline"),
  },
  {
    name: "generic-v1",
    supports: (observation) => observation.providerIdentity?.provider === "openreview",
    extract: (body) => genericFields(body, "generic-v1", "deadline-text-window"),
  },
  {
    name: "generic-v1",
    supports: (observation) => /html/i.test(observation.contentType),
    extract: (body) => genericFields(body, "generic-v1", "deadline-text-window"),
  },
  {
    name: "generic-v1",
    supports: () => true,
    extract: (body) => genericFields(body, "generic-v1", "deadline-text-window"),
  },
];

function adapterFor(
  observation: PageObservation & { providerIdentity?: ProviderIdentity },
): ReverificationAdapter {
  return (
    REVERIFICATION_ADAPTERS.find((adapter) => adapter.supports(observation)) ??
    REVERIFICATION_ADAPTERS[REVERIFICATION_ADAPTERS.length - 1]!
  );
}

function candidateTrack(candidate: CfpExtractionCandidate): string {
  return candidate.track ? deadlineTrackKey("", candidate.kind ?? "other", candidate.track) : "";
}

function candidateCallIdentity(candidate: ExtractedDeadlineField): string {
  return callIdentityKey(candidate.callIdentity);
}

function slotCompatible(target: VerificationTarget, candidate: ExtractedDeadlineField): boolean {
  if (String(candidate.kind ?? "other") !== target.kind) return false;
  if ((Number(candidate.round ?? 1) || 1) !== target.round) return false;
  if (candidateTrack(candidate) !== target.track) return false;
  const candidateLabel = labelSignature(candidate.label ?? candidate.rawExcerpt);
  if (
    target.labelSignature &&
    candidateLabel &&
    candidateLabel !== target.labelSignature &&
    !candidateLabel.includes(target.labelSignature) &&
    !target.labelSignature.includes(candidateLabel)
  )
    return false;
  const candidateIdentity = candidateCallIdentity(candidate);
  if (target.callIdentity && candidateIdentity && candidateIdentity !== target.callIdentity)
    return false;
  if (target.adapter && candidate.adapter && candidate.adapter !== target.adapter) return false;
  if (target.selectorOrField && candidate.selectorOrField !== target.selectorOrField) return false;
  if (target.evidenceExcerpt) {
    const targetEvidence = excerptSignature(target.evidenceExcerpt);
    const candidateEvidence = excerptSignature(candidate.rawExcerpt);
    if (
      targetEvidence &&
      candidateEvidence &&
      !candidateEvidence.includes(targetEvidence) &&
      !targetEvidence.includes(candidateEvidence)
    )
      return false;
  }
  return true;
}

function candidateValue(candidate: CfpExtractionCandidate | undefined): string {
  return candidate
    ? [candidate.date, candidate.time, candidate.timezone].filter(Boolean).join(" ")
    : "";
}

function candidateRecord(
  candidate: ExtractedDeadlineField,
  target: VerificationTarget,
): Record<string, unknown> {
  const label = target.label;
  const track = target.track;
  if (candidate.time && candidate.timezone) {
    const at = parseInstant(`${candidate.date ?? ""} ${candidate.time}`, candidate.timezone);
    if (at)
      return {
        kind: candidate.kind ?? "other",
        label,
        round: candidate.round ?? 1,
        track,
        precision: "exact",
        at_utc: at,
        date: candidate.date,
        time: candidate.time,
        tz: candidate.timezone,
      };
  }
  return {
    kind: candidate.kind ?? "other",
    label,
    round: candidate.round ?? 1,
    track,
    precision: "date-only",
    local_date: candidate.date ?? "",
  };
}

function sameDeadlineValue(deadline: JsonDeadline, candidate: ExtractedDeadlineField): boolean {
  if (!candidate.date) return false;
  if (deadline.precision === "date-only")
    return (
      !(candidate.time && candidate.timezone) &&
      candidate.date === String(deadline.local_date ?? "")
    );
  const expected = String(deadline.utc ?? "");
  if (!candidate.time || !candidate.timezone) return false;
  const at = parseInstant(`${candidate.date} ${candidate.time}`, candidate.timezone);
  return Boolean(at && expected && at.getTime() === Date.parse(expected));
}

function matchingCandidate(
  target: VerificationTarget,
  candidates: ExtractedDeadlineField[],
): { candidate?: ExtractedDeadlineField; compatible: ExtractedDeadlineField[] } {
  const compatible = candidates.filter((candidate) => slotCompatible(target, candidate));
  const same = compatible.filter((candidate) => sameDeadlineValue(target.deadline, candidate));
  return {
    candidate: compatible.length === 1 && same.length === 1 ? same[0] : undefined,
    compatible,
  };
}

function stateFor(
  state: Partial<VerificationState> | undefined,
  target: VerificationTarget,
  now: Date,
  status: VerificationState["status"],
  page: VerificationPage | undefined,
  observed?: ExtractedDeadlineField,
  reason?: string,
): VerificationLedgerDeadline {
  return {
    deadline_id: target.deadlineId,
    venue_key: String(target.conference.key ?? ""),
    edition_id: String(target.edition.id ?? target.edition.edition_id ?? target.edition.year ?? ""),
    kind: target.kind,
    round: target.round,
    track: target.track,
    label: target.label,
    page_id: target.pageId,
    official_url: target.url,
    last_attempt_at: now.toISOString(),
    last_verified_at: status === "verified" ? now.toISOString() : (state?.last_verified_at ?? null),
    next_check_at: nextCheck(target.deadline, now, state?.next_check_at, page?.headers.retryAfter),
    content_hash: page?.content_hash || state?.content_hash || null,
    status,
    ...(target.sourceClass ? { source_class: target.sourceClass } : {}),
    ...(target.sourceName ? { source_name: target.sourceName } : {}),
    ...(target.promotionRef ? { promotion_ref: target.promotionRef } : {}),
    ...(target.providerIdentity ? { provider_identity: target.providerIdentity } : {}),
    ...(target.labelSignature ? { label_signature: target.labelSignature } : {}),
    ...(target.selectorOrField ? { selector_or_field: target.selectorOrField } : {}),
    ...(target.adapter ? { adapter: target.adapter } : {}),
    ...(observed
      ? {
          observed_value: candidateValue(observed),
          observed_precision: observed.time && observed.timezone ? "exact" : "date-only",
          raw_excerpt: observed.rawExcerpt,
        }
      : {}),
    ...(page?.body_ref ? { body_ref: page.body_ref } : {}),
    ...(reason ? { raw_excerpt: reason } : {}),
  };
}

function resolutionId(
  deadlineIdValue: string,
  oldValue: string,
  newValue: string,
  kind: string,
): string {
  return `resolution:${createHash("sha256").update(`${deadlineIdValue}\0${oldValue}\0${newValue}\0${kind}`).digest("hex")}`;
}

function recordResolution(
  ledger: VerificationLedger,
  target: VerificationTarget,
  now: Date,
  status: "changed" | "manual-required",
  candidate: ExtractedDeadlineField | undefined,
  changeKind: DeadlineChangeKind,
  page: VerificationPage | undefined,
  reason?: string,
): void {
  const oldValue = deadlineValue(target.deadline);
  const newValue = candidateValue(candidate);
  const id = resolutionId(target.deadlineId, oldValue, newValue, changeKind);
  const existing = ledger.resolutions.find((item) => item.resolution_id === id);
  if (existing) {
    existing.last_seen_at = now.toISOString();
    existing.observed_at = now.toISOString();
    if (page?.content_hash) existing.content_hash = page.content_hash;
    if (page?.body_ref) existing.evidence_ref = page.body_ref;
    if (candidate?.rawExcerpt || reason)
      existing.raw_excerpt = candidate?.rawExcerpt ?? reason ?? "";
    return;
  }
  ledger.resolutions.push({
    resolution_id: id,
    deadline_id: target.deadlineId,
    page_id: target.pageId,
    official_url: target.url,
    observed_at: now.toISOString(),
    state: "open",
    first_detected_at: now.toISOString(),
    last_seen_at: now.toISOString(),
    ...(reason ? { resolution_reason: reason } : {}),
    old_value: oldValue,
    new_value: newValue,
    change_kind: changeKind,
    ...(page?.body_ref ? { evidence_ref: page.body_ref } : {}),
    content_hash: page?.content_hash ?? "",
    raw_excerpt: candidate?.rawExcerpt ?? reason ?? "",
    status,
    previous_value: oldValue,
    current_value: newValue,
  });
}

function pageForCapture(
  pageId: string,
  captured: Awaited<ReturnType<typeof capturePage>>,
  ledger: VerificationLedger,
  ledgerPath: string,
): VerificationPage {
  const provider = providerIdentityFromUrl(captured.finalUrl);
  const old = ledger.pages[pageId];
  const bodyRef = captured.body
    ? relative(resolve(dirname(ledgerPath)), captured.bodyRef)
    : (old?.body_ref ?? "");
  const contentLength =
    captured.notModified || captured.retryable || captured.status < 200 || captured.status >= 300
      ? (old?.content_length ?? captured.contentLength)
      : captured.contentLength;
  return {
    requested_url: captured.requestedUrl,
    final_url: captured.finalUrl,
    status: captured.status,
    content_type: captured.contentType,
    content_length: contentLength,
    headers: captured.headers,
    content_hash: captured.contentHash,
    source_revision: captured.sourceRevision,
    parser_version: captured.parserVersion,
    provider: provider.provider,
    ...(provider.providerKey ? { provider_key: provider.providerKey } : {}),
    ...(captured.headers.etag ? { etag: captured.headers.etag } : {}),
    ...(captured.headers.lastModified ? { last_modified: captured.headers.lastModified } : {}),
    last_attempt_at: captured.retrievedAt,
    last_success_at:
      captured.notModified ||
      (!captured.retryable && captured.status >= 200 && captured.status < 300)
        ? captured.retrievedAt
        : (old?.last_success_at ?? null),
    body_ref: bodyRef,
  };
}

function errorPage(
  target: VerificationTarget,
  now: Date,
  error: unknown,
  old?: VerificationPage,
): VerificationPage {
  const provider = target.providerIdentity ?? providerIdentityFromUrl(target.url);
  return {
    requested_url: target.url,
    final_url: old?.final_url ?? target.url,
    status: 0,
    content_type: old?.content_type ?? "",
    content_length: old?.content_length ?? 0,
    headers: old?.headers ?? {},
    content_hash: old?.content_hash ?? "",
    source_revision: old?.source_revision ?? "",
    parser_version: "reverification-v2",
    provider: provider.provider,
    ...(provider.providerKey ? { provider_key: provider.providerKey } : {}),
    last_attempt_at: now.toISOString(),
    last_success_at: old?.last_success_at ?? null,
    body_ref: old?.body_ref ?? "",
    error: error instanceof PageCaptureError ? `${error.code}: ${error.message}` : String(error),
  };
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, worker),
  );
  return out;
}

function normalizeLimits(value: Partial<ReverifyLimits> | undefined): ReverifyLimits {
  const positive = (raw: number | undefined, fallback: number): number =>
    Number.isInteger(raw) && Number(raw) > 0 ? Number(raw) : fallback;
  return {
    maxPages: positive(value?.maxPages, 40),
    maxDeadlines: positive(value?.maxDeadlines, 200),
    maxPerHost: positive(value?.maxPerHost, 5),
    minHostIntervalMs: positive(value?.minHostIntervalMs, 250),
    concurrency: positive(value?.concurrency, 4),
    timeoutMs: positive(value?.timeoutMs, DEFAULT_CAPTURE_LIMITS.timeoutMs),
    maxBodyBytes: positive(value?.maxBodyBytes, DEFAULT_CAPTURE_LIMITS.maxBodyBytes),
  };
}

function hostRateLimiter(intervalMs: number): (url: string) => Promise<void> {
  const nextAt = new Map<string, number>();
  return async (url: string): Promise<void> => {
    const host = new URL(url).hostname.toLowerCase();
    const now = Date.now();
    const start = Math.max(now, nextAt.get(host) ?? now);
    nextAt.set(host, start + intervalMs);
    if (start > now) await new Promise<void>((resolve) => setTimeout(resolve, start - now));
  };
}

function aliasResolved(ledger: VerificationLedger, id: string): string {
  const seen = new Set<string>();
  let current = id;
  while (ledger.aliases[current] && !seen.has(current)) {
    seen.add(current);
    current = ledger.aliases[current]!;
  }
  return current;
}

function migrateTargetIds(data: JsonData, ledger: VerificationLedger): void {
  const targets = collectVerificationTargets(data, emptyLedger(), new Date("1970-01-01T00:00:00Z"));
  for (const [oldId, entry] of Object.entries(ledger.deadlines)) {
    if (targets.some((target) => target.deadlineId === oldId)) continue;
    const target = targets.find(
      (item) =>
        item.kind === entry.kind &&
        item.round === entry.round &&
        item.track === entry.track &&
        [
          item.conference.key,
          ...(item.conference.legacy_keys ?? []),
          ...(item.conference.identity?.aliases ?? []),
        ].some((value) => String(value ?? "") === entry.venue_key) &&
        [
          item.edition.id,
          item.edition.edition_id,
          ...(item.edition.legacy_ids ?? []),
          item.edition.identity?.editionId,
          item.edition.call_identity?.editionId,
          item.edition.call_identity?.callId,
        ].some((value) => String(value ?? "") === entry.edition_id),
    );
    if (!target || ledger.deadlines[target.deadlineId]) continue;
    ledger.deadlines[target.deadlineId] = {
      ...entry,
      deadline_id: target.deadlineId,
      venue_key: String(target.conference.key ?? entry.venue_key),
      edition_id: String(
        target.edition.id ?? target.edition.edition_id ?? target.edition.year ?? entry.edition_id,
      ),
      ...(target.promotionRef ? { promotion_ref: target.promotionRef } : {}),
    };
    ledger.aliases[oldId] = target.deadlineId;
    delete ledger.deadlines[oldId];
  }
}

function bootstrapEmbeddedVerification(
  data: JsonData,
  ledger: VerificationLedger,
  now: Date,
): void {
  for (const conference of data.conferences ?? []) {
    for (const edition of conference.editions ?? []) {
      for (const deadline of edition.deadlines ?? []) {
        const state = deadline.verification;
        if (
          state?.status !== "verified" ||
          typeof state.last_verified_at !== "string" ||
          !validIso(state.last_verified_at) ||
          typeof state.content_hash !== "string" ||
          !SHA256.test(state.content_hash)
        )
          continue;
        const id = deadlineId(conference, edition, deadline);
        const target = targetFor(conference, edition, deadline, id, now, ledger);
        if (!target || !autoSource(target) || ledger.deadlines[id]) continue;
        const verifiedAt = new Date(Date.parse(state.last_verified_at)).toISOString();
        const nextCheck =
          typeof state.next_check_at === "string" && validIso(state.next_check_at)
            ? new Date(Date.parse(state.next_check_at)).toISOString()
            : nextCheckForBootstrap(deadline, now);
        const provider = target.providerIdentity;
        ledger.pages[target.pageId] ??= {
          requested_url: target.url,
          final_url: target.url,
          status: 200,
          content_type: "",
          content_length: 0,
          content_hash: state.content_hash,
          source_revision: `sha256:${state.content_hash}`,
          parser_version: "promotion-evidence-bootstrap",
          headers: {},
          ...(provider ? { provider: provider.provider } : {}),
          ...(provider?.providerKey ? { provider_key: provider.providerKey } : {}),
          last_attempt_at:
            typeof state.last_attempt_at === "string" && validIso(state.last_attempt_at)
              ? new Date(Date.parse(state.last_attempt_at)).toISOString()
              : verifiedAt,
          last_success_at: verifiedAt,
          body_ref: "",
        };
        ledger.deadlines[id] = {
          deadline_id: id,
          venue_key: String(conference.key ?? ""),
          edition_id: String(edition.id ?? edition.edition_id ?? edition.year ?? ""),
          kind: String(deadline.kind ?? "other"),
          round: Number(deadline.round ?? 1) || 1,
          track: deadlineTrackKey(
            String(deadline.label ?? ""),
            String(deadline.kind ?? "other"),
            String(deadline.track ?? ""),
          ),
          label: String(deadline.label ?? deadline.kind ?? "other"),
          page_id: target.pageId,
          official_url: target.url,
          last_attempt_at: verifiedAt,
          last_verified_at: verifiedAt,
          next_check_at: nextCheck,
          content_hash: state.content_hash,
          status: "verified",
          source_class: target.sourceClass,
          ...(target.sourceName ? { source_name: target.sourceName } : {}),
          ...(target.promotionRef ? { promotion_ref: target.promotionRef } : {}),
          ...(provider ? { provider_identity: provider } : {}),
          ...(target.labelSignature ? { label_signature: target.labelSignature } : {}),
          ...(target.selectorOrField ? { selector_or_field: target.selectorOrField } : {}),
          ...(target.adapter ? { adapter: target.adapter } : {}),
        };
      }
    }
  }
}

function nextCheckForBootstrap(deadline: JsonDeadline, now: Date): string {
  return (
    computeNextCheckAt(deadlineCutoff(deadline), now) ??
    new Date(now.getTime() + DAY_MS).toISOString()
  );
}

function hasFreshEmbeddedVerification(target: VerificationTarget, now: Date): boolean {
  const state = target.deadline.verification;
  return Boolean(
    state?.status === "verified" &&
      autoSource(target) &&
      typeof state.next_check_at === "string" &&
      validIso(state.next_check_at) &&
      Date.parse(state.next_check_at) > now.getTime(),
  );
}

export async function reverifyData(options: ReverifyOptions): Promise<ReverifyResult> {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new TypeError("reverify now must be a valid date");
  const limits = normalizeLimits(options.limits);
  const bodyRoot = resolve(
    options.bodyRoot ?? join(dirname(options.ledgerPath), "evidence", "blobs"),
  );
  const fetchImpl = options.fetchImpl;
  const waitForHost = hostRateLimiter(limits.minHostIntervalMs);
  const data = JSON.parse(readFileSync(options.dataPath, "utf8")) as JsonData;
  const ledger = loadVerificationLedger(options.ledgerPath);
  migrateTargetIds(data, ledger);
  bootstrapEmbeddedVerification(data, ledger, now);
  const allTargets = collectVerificationTargets(data, ledger, now, Boolean(options.due));
  const targets = allTargets
    .filter((target) => !hasFreshEmbeddedVerification(target, now))
    .slice(0, limits.maxDeadlines);
  const statuses: Record<string, number> = {};
  const addStatus = (status: string): void => {
    statuses[status] = (statuses[status] ?? 0) + 1;
  };
  const groups = new Map<string, VerificationTarget[]>();
  for (const target of targets) {
    const key = canonicalUrl(target.url);
    groups.set(key, [...(groups.get(key) ?? []), target]);
  }
  const selectedPages: Array<[string, VerificationTarget[]]> = [];
  const hostCounts = new Map<string, number>();
  for (const [url, group] of groups) {
    if (selectedPages.length >= limits.maxPages) break;
    if (!group.some(autoSource)) continue;
    const host = new URL(url).hostname.toLowerCase();
    const count = hostCounts.get(host) ?? 0;
    if (count >= limits.maxPerHost) continue;
    hostCounts.set(host, count + 1);
    const pageId = group[0]!.pageId;
    for (const target of group) target.pageId = pageId;
    selectedPages.push([url, group]);
  }
  const selectedIds = new Set(
    selectedPages.flatMap(([, group]) => group.map((target) => target.deadlineId)),
  );
  for (const target of targets) {
    if (selectedIds.has(target.deadlineId)) continue;
    if (!autoSource(target)) {
      // deadline エントリが参照する page は必ず実体化する。欠落したまま書くと
      // 台帳が再読込不能 (page_id does not exist) になり後続サブコマンドが全滅する。
      // 既存 page が同一 URL なら温存する (取得済み content_hash / body_ref を消さない)。
      // URL が変わっていたら旧 page のままでは official_url 整合検査で再読込不能になるため、
      // 新 URL の page_id へ張り替えてスタブを置く。
      const existing = ledger.pages[target.pageId];
      if (!existing || existing.requested_url !== target.url) {
        if (existing) target.pageId = pageIdForUrl(target.url);
        ledger.pages[target.pageId] ??= {
          requested_url: target.url,
          final_url: target.url,
          status: 0,
          content_type: "",
          content_length: 0,
          content_hash: "",
          source_revision: "",
          parser_version: "reverification-v2-unfetched",
          headers: {},
          provider: providerIdentityFromUrl(target.url).provider,
          last_attempt_at: now.toISOString(),
          last_success_at: null,
          body_ref: "",
        };
      }
      ledger.deadlines[target.deadlineId] = stateFor(
        ledger.deadlines[target.deadlineId] ?? target.deadline.verification,
        target,
        now,
        "manual-required",
        ledger.pages[target.pageId],
        undefined,
        "source is not an automatically verifiable official page",
      );
      addStatus("manual-required");
    }
  }
  const pageResults = await mapConcurrent(
    selectedPages,
    limits.concurrency,
    async ([url, group]) => {
      const target = group[0]!;
      const previous = ledger.pages[target.pageId];
      let captured: Awaited<ReturnType<typeof capturePage>>;
      try {
        await waitForHost(url);
        captured = await capturePage(url, {
          ...(fetchImpl ? { fetchImpl } : {}),
          previous: previous
            ? {
                headers: previous.headers,
                contentHash: previous.content_hash,
                sourceRevision: previous.source_revision,
                bodyRef: previous.body_ref,
                contentLength: previous.content_length,
              }
            : undefined,
          bodyRoot,
          parserVersion: "reverification-v2",
          maxBodyBytes: limits.maxBodyBytes,
          timeoutMs: limits.timeoutMs,
        });
      } catch (error) {
        const page = errorPage(target, now, error, previous);
        ledger.pages[target.pageId] = page;
        return { group, page, candidates: [] as ExtractedDeadlineField[], error };
      }
      const page = pageForCapture(target.pageId, captured, ledger, options.ledgerPath);
      ledger.pages[target.pageId] = page;
      if (captured.notModified) {
        if (!page.body_ref)
          return {
            group,
            page,
            candidates: [] as ExtractedDeadlineField[],
            cachedBodyMissing: true,
          };
        let body: Uint8Array;
        try {
          body = readFileSync(resolve(dirname(options.ledgerPath), page.body_ref));
        } catch {
          return {
            group,
            page,
            candidates: [] as ExtractedDeadlineField[],
            cachedBodyMissing: true,
          };
        }
        const adapter = adapterFor({
          ...captured,
          providerIdentity: providerIdentityFromUrl(captured.finalUrl),
        });
        return {
          group,
          page,
          candidates: adapter.extract(body, captured),
          adapter: adapter.name,
          notModified: true,
        };
      }
      if (captured.retryable || captured.status < 200 || captured.status >= 300 || !captured.body)
        return {
          group,
          page,
          candidates: [] as ExtractedDeadlineField[],
          retryable: captured.retryable,
        };
      const observation = {
        ...captured,
        providerIdentity: providerIdentityFromUrl(captured.finalUrl),
      };
      const adapter = adapterFor(observation);
      return {
        group,
        page,
        candidates: adapter.extract(captured.body, captured),
        adapter: adapter.name,
      };
    },
  );
  for (const result of pageResults) {
    for (const target of result.group) {
      const oldState = ledger.deadlines[target.deadlineId] ?? target.deadline.verification;
      let status: VerificationState["status"];
      let observed: ExtractedDeadlineField | undefined;
      let changeKind: DeadlineChangeKind | undefined;
      if (!autoSource(target)) status = "manual-required";
      else if (
        result.error instanceof PageCaptureError &&
        (result.error.code === "body-too-large" || result.error.code === "unsafe-url")
      )
        status = "manual-required";
      else if (result.error) status = "source-unreachable";
      else if (result.cachedBodyMissing) status = "manual-required";
      else if (result.retryable) status = "retryable";
      else if (!result.candidates.length) status = "parser-failed";
      else {
        const match = matchingCandidate(target, result.candidates);
        if (match.candidate) {
          status = "verified";
          observed = match.candidate;
        } else if (match.compatible.length === 1) {
          observed = match.compatible[0];
          changeKind = classifyDeadlineChange(
            target.deadline as Record<string, unknown>,
            candidateRecord(observed, target),
          );
          const safeChange =
            changeKind === "precision-upgrade" ||
            (changeKind === "extension" && explicitDeadlineExtension(observed.rawExcerpt));
          status = safeChange ? "changed" : "manual-required";
        } else if (match.compatible.length > 1) {
          status = "manual-required";
          observed = match.compatible[0];
          changeKind = "ambiguous";
        } else {
          status = "manual-required";
          observed = result.candidates[0];
          changeKind = "ambiguous";
        }
      }
      const page = result.page;
      ledger.deadlines[target.deadlineId] = stateFor(oldState, target, now, status, page, observed);
      if (status === "changed" || status === "manual-required") {
        const kind = changeKind ?? "ambiguous";
        recordResolution(
          ledger,
          target,
          now,
          status,
          observed,
          kind,
          page,
          kind === "extension" && explicitDeadlineExtension(observed?.rawExcerpt)
            ? "official deadline extension"
            : undefined,
        );
      }
      addStatus(status);
    }
  }
  ledger.generated_at = now.toISOString();
  writeVerificationLedger(options.ledgerPath, ledger);
  writeVerificationResolutions(
    options.resolutionsPath ?? join(dirname(options.ledgerPath), "reverification-resolutions.json"),
    ledger,
  );
  const processed = Object.values(statuses).reduce((total, count) => total + count, 0);
  return {
    processed,
    deferred: targets.length - processed,
    statuses,
    ledger,
    pages: selectedPages.length,
  };
}

function entryFor(ledger: VerificationLedger, id: string): VerificationLedgerDeadline | undefined {
  const resolved = aliasResolved(ledger, id);
  return ledger.deadlines[id] ?? ledger.deadlines[resolved];
}

/** Carry successful/error states into the next in-memory build. */
export function applyVerificationLedger(
  conferences: Conference[],
  ledger: VerificationLedger,
): Conference[] {
  return conferences.map((conference) => ({
    ...conference,
    editions: conference.editions.map((edition) => ({
      ...edition,
      deadlines: edition.deadlines.map((deadline) => {
        const id = deadlineSlotId(
          conference.key,
          edition.edition_id,
          deadline.kind,
          deadline.round,
          deadlineTrackKey(deadline.label, deadline.kind, deadline.track),
        );
        const entry = entryFor(ledger, id);
        if (!entry) return deadline;
        const {
          deadline_id: _id,
          venue_key: _venue,
          edition_id: _edition,
          kind: _kind,
          round: _round,
          track: _track,
          label: _label,
          page_id: _page,
          observed_value: _observed,
          observed_precision: _precision,
          evidence_ref: _evidence,
          raw_excerpt: _excerpt,
          body_ref: _body,
          ...verification
        } = entry;
        return { ...deadline, verification };
      }),
    })),
  }));
}
