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
  callIdentity?: string;
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
  call_identity?: string;
  callIdentity?: string;
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
  call_identity?: { editionId?: string; callId?: string };
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
const SHA256 = /^[0-9a-f]{64}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validIso(value: unknown, nullable = false): boolean {
  return (
    (nullable && value === null) ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)))
  );
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

function validatePage(id: string, raw: unknown): VerificationPage {
  if (!isRecord(raw)) return invalidLedgerEntry(id, "page is not an object");
  for (const field of ["requested_url", "final_url"] as const) {
    if (typeof raw[field] !== "string" || !raw[field])
      return invalidLedgerEntry(id, `${field} is missing`);
    try {
      assertSafePageUrl(raw[field]);
    } catch (error) {
      return invalidLedgerEntry(id, `${field} is unsafe: ${String(error)}`);
    }
  }
  if (!validIso(raw.last_attempt_at)) return invalidLedgerEntry(id, "last_attempt_at is invalid");
  if (!validIso(raw.last_success_at, true))
    return invalidLedgerEntry(id, "last_success_at is invalid");
  if (typeof raw.content_hash !== "string" || (raw.content_hash && !SHA256.test(raw.content_hash)))
    return invalidLedgerEntry(id, "content_hash is invalid");
  if (raw.body_ref !== undefined && typeof raw.body_ref !== "string")
    return invalidLedgerEntry(id, "body_ref is invalid");
  const provider = raw.provider;
  if (provider !== undefined && typeof provider !== "string")
    return invalidLedgerEntry(id, "provider is invalid");
  const requestedUrl = raw.requested_url as string;
  const finalUrl = raw.final_url as string;
  const lastAttempt = raw.last_attempt_at as string;
  const lastSuccess = raw.last_success_at === null ? null : (raw.last_success_at as string);
  return {
    requested_url: requestedUrl,
    final_url: finalUrl,
    status: Number(raw.status ?? 200),
    content_type: String(raw.content_type ?? ""),
    content_length: Number(raw.content_length ?? 0),
    headers: {
      ...(typeof raw.etag === "string" ? { etag: raw.etag } : {}),
      ...(typeof raw.last_modified === "string" ? { lastModified: raw.last_modified } : {}),
    },
    content_hash: raw.content_hash,
    source_revision: String(raw.source_revision ?? raw.etag ?? raw.last_modified ?? ""),
    parser_version: String(raw.parser_version ?? "reverification-v2"),
    provider: provider as IdentityProvider | undefined,
    ...(typeof raw.provider_key === "string" ? { provider_key: raw.provider_key } : {}),
    ...(typeof raw.etag === "string" ? { etag: raw.etag } : {}),
    ...(typeof raw.last_modified === "string" ? { last_modified: raw.last_modified } : {}),
    last_attempt_at: lastAttempt,
    last_success_at: lastSuccess,
    body_ref: String(raw.body_ref ?? ""),
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
  if (
    raw.last_verified_at !== null &&
    raw.last_verified_at !== undefined &&
    !validIso(raw.last_verified_at)
  )
    return invalidLedgerEntry(id, "last_verified_at is invalid");
  if (raw.content_hash !== undefined && typeof raw.content_hash !== "string")
    return invalidLedgerEntry(id, "content_hash is invalid");
  const pageId = raw.page_id as string;
  const nextCheck = raw.next_check_at as string;
  const page = pages[pageId];
  const officialUrl =
    typeof raw.official_url === "string" && raw.official_url
      ? raw.official_url
      : page.requested_url;
  const lastAttempt = validIso(raw.last_attempt_at, true)
    ? (raw.last_attempt_at as string)
    : page.last_attempt_at;
  const lastVerified =
    raw.last_verified_at === undefined ? null : (raw.last_verified_at as string | null);
  return {
    deadline_id: typeof raw.deadline_id === "string" ? raw.deadline_id : id,
    venue_key: String(raw.venue_key ?? ""),
    edition_id: String(raw.edition_id ?? ""),
    kind: String(raw.kind ?? "other"),
    round: Number(raw.round ?? 1) || 1,
    track: String(raw.track ?? ""),
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
    ...(isRecord(raw.provider_identity)
      ? { provider_identity: raw.provider_identity as unknown as ProviderIdentity }
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
    ...(typeof raw.body_ref === "string"
      ? { body_ref: raw.body_ref }
      : page.body_ref
        ? { body_ref: page.body_ref }
        : {}),
  };
}

function validateResolution(index: number, raw: unknown): VerificationResolution {
  if (!isRecord(raw))
    return invalidLedgerEntry(`resolution[${index}]`, "resolution is not an object");
  const id = String(raw.resolution_id ?? `resolution[${index}]`);
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
  for (const field of ["observed_at", "first_detected_at", "last_seen_at"] as const) {
    if (!validIso(raw[field])) return invalidLedgerEntry(id, `${field} is invalid`);
  }
  const status = raw.status === "manual-required" ? "manual-required" : "changed";
  const deadlineIdValue = raw.deadline_id as string;
  const officialUrl = raw.official_url as string;
  const observedAt = raw.observed_at as string;
  const firstDetectedAt = raw.first_detected_at as string;
  const lastSeenAt = raw.last_seen_at as string;
  const oldValue = raw.old_value as string;
  const newValue = raw.new_value as string;
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
    ...(typeof raw.evidence_ref === "string" ? { evidence_ref: raw.evidence_ref } : {}),
    content_hash: String(raw.content_hash ?? ""),
    raw_excerpt: String(raw.raw_excerpt ?? ""),
    status,
    previous_value: String(raw.previous_value ?? oldValue),
    current_value: String(raw.current_value ?? newValue),
  };
}

function migrateV1(value: Record<string, unknown>): VerificationLedger {
  if (!isRecord(value.entries))
    throw new TypeError("invalid verification ledger: entries is not an object");
  if (!Array.isArray(value.resolutions))
    throw new TypeError("invalid verification ledger: resolutions is not an array");
  const ledger = emptyLedger();
  ledger.generated_at = typeof value.generated_at === "string" ? value.generated_at : "";
  for (const [id, raw] of Object.entries(value.entries)) {
    if (!isRecord(raw)) invalidLedgerEntry(id, "entry is not an object");
    const officialUrl = String(raw.official_url ?? "");
    if (!officialUrl) invalidLedgerEntry(id, "official_url is missing");
    let pageId: string;
    try {
      pageId = pageIdForUrl(officialUrl);
      assertSafePageUrl(officialUrl);
    } catch (error) {
      invalidLedgerEntry(id, `official_url is unsafe: ${String(error)}`);
    }
    const lastAttempt = String(
      raw.last_attempt_at ?? ledger.generated_at ?? new Date(0).toISOString(),
    );
    if (!validIso(lastAttempt)) invalidLedgerEntry(id, "last_attempt_at is invalid");
    const page =
      ledger.pages[pageId] ??
      ({
        requested_url: officialUrl,
        final_url: officialUrl,
        status: 200,
        content_type: "",
        content_length: 0,
        headers: {},
        content_hash: typeof raw.content_hash === "string" ? raw.content_hash : "",
        source_revision: typeof raw.content_hash === "string" ? `sha256:${raw.content_hash}` : "",
        parser_version: "reverification-v1-migrated",
        last_attempt_at: lastAttempt,
        last_success_at:
          raw.last_verified_at === null || raw.last_verified_at === undefined
            ? null
            : String(raw.last_verified_at),
        body_ref: typeof raw.body_ref === "string" ? raw.body_ref : "",
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
      venue_key: String(raw.venue_key ?? ""),
      edition_id: String(raw.edition_id ?? ""),
      kind: String(raw.kind ?? "other"),
      round: Number(raw.round ?? 1) || 1,
      track: String(raw.track ?? ""),
      ...(typeof raw.label === "string" ? { label: raw.label } : {}),
      page_id: pageId,
      official_url: officialUrl,
      last_attempt_at: validIso(raw.last_attempt_at, true)
        ? (raw.last_attempt_at as string)
        : lastAttempt,
      last_verified_at: validIso(raw.last_verified_at, true)
        ? (raw.last_verified_at as string)
        : null,
      next_check_at: new Date(Date.parse(String(next))).toISOString(),
      content_hash:
        raw.content_hash === null || raw.content_hash === undefined
          ? null
          : String(raw.content_hash),
      status,
      ...(typeof raw.source_name === "string" ? { source_name: raw.source_name } : {}),
      ...(typeof raw.body_ref === "string" ? { body_ref: raw.body_ref } : {}),
    };
  }
  for (const [index, raw] of value.resolutions.entries()) {
    if (!isRecord(raw)) invalidLedgerEntry(`resolution[${index}]`, "resolution is not an object");
    const oldValue = String(raw.previous_value ?? "");
    const newValue = String(raw.current_value ?? "");
    const observedAt = String(raw.observed_at ?? ledger.generated_at);
    if (!validIso(observedAt)) invalidLedgerEntry(`resolution[${index}]`, "observed_at is invalid");
    const resolutionId = `resolution:${createHash("sha256")
      .update(`${raw.deadline_id}\0${oldValue}\0${newValue}\0${raw.content_hash ?? ""}`)
      .digest("hex")}`;
    ledger.resolutions.push({
      resolution_id: resolutionId,
      deadline_id: String(raw.deadline_id ?? ""),
      official_url: String(raw.official_url ?? ""),
      observed_at: observedAt,
      state: "open",
      first_detected_at: observedAt,
      last_seen_at: observedAt,
      old_value: oldValue,
      new_value: newValue,
      change_kind: raw.status === "manual-required" ? "ambiguous" : "extension",
      content_hash: String(raw.content_hash ?? ""),
      raw_excerpt: String(raw.raw_excerpt ?? ""),
      status: raw.status === "manual-required" ? "manual-required" : "changed",
      previous_value: oldValue,
      current_value: newValue,
    });
  }
  return ledger;
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
    aliases[oldId] = newId;
  }
  return attachEntries({
    schema_version: 2,
    producer_revision: "reverification-v2",
    generated_at: typeof value.generated_at === "string" ? value.generated_at : "",
    pages,
    deadlines,
    aliases,
    resolutions: value.resolutions.map((raw, index) => validateResolution(index, raw)),
  });
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

export function assertResolutionCanApply(path: string, resolutionId: string): void {
  const ledger = loadVerificationLedger(path);
  const resolution = ledger.resolutions.find((item) => item.resolution_id === resolutionId);
  if (!resolution) throw new Error(`unknown verification resolution: ${resolutionId}`);
  if (resolution.state === "applied")
    throw new Error(`verification resolution is already applied: ${resolutionId}`);
  if (resolution.state === "rejected")
    throw new Error(`rejected verification resolution cannot be applied: ${resolutionId}`);
  if (resolution.status === "manual-required" && resolution.state !== "accepted")
    throw new Error(
      `manual-required verification resolution needs accepted state: ${resolutionId}`,
    );
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

function sourceClassOf(deadline: JsonDeadline): VerificationTarget["sourceClass"] {
  const state = deadline.verification;
  if (
    state?.source_class === "official-cfp" ||
    state?.source_class === "publisher" ||
    state?.source_class === "official-homepage" ||
    state?.source_class === "aggregator"
  )
    return state.source_class;
  const classes = (deadline.evidence ?? []).map((item) =>
    String(item.sourceClass ?? item.source_class ?? ""),
  );
  if (classes.includes("official-cfp")) return "official-cfp";
  if (classes.includes("publisher")) return "publisher";
  if (classes.includes("aggregator")) return "aggregator";
  return "unknown";
}

function evidenceFor(deadline: JsonDeadline): JsonEvidence | undefined {
  return [...(deadline.evidence ?? [])].sort((a, b) => {
    const rank = (item: JsonEvidence): number => {
      const source = String(item.sourceClass ?? item.source_class ?? "");
      return source === "official-cfp"
        ? 0
        : source === "publisher"
          ? 1
          : source === "aggregator"
            ? 2
            : 3;
    };
    return rank(a) - rank(b);
  })[0];
}

function sourceUrlOf(deadline: JsonDeadline): string {
  const evidence = evidenceFor(deadline);
  return String(
    deadline.verification?.official_url ?? evidence?.sourceUrl ?? evidence?.source_url ?? "",
  ).trim();
}

function autoSource(target: VerificationTarget): boolean {
  if (target.sourceClass === "official-cfp") return true;
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
  const evidence = evidenceFor(deadline);
  const sourceClass = sourceClassOf(deadline);
  const url = sourceUrlOf(deadline);
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
    ...((deadline.call_identity ?? deadline.callIdentity)
      ? { callIdentity: String(deadline.call_identity ?? deadline.callIdentity) }
      : {}),
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

function genericFields(body: Uint8Array, adapter: string): ExtractedDeadlineField[] {
  const text = new TextDecoder().decode(body);
  return extractCfpCandidates(text).map((candidate) => ({ ...candidate, adapter }));
}

export const REVERIFICATION_ADAPTERS: ReverificationAdapter[] = [
  {
    name: "easychair",
    supports: (observation) => observation.providerIdentity?.provider === "easychair",
    extract: (body) => genericFields(body, "easychair"),
  },
  {
    name: "openreview",
    supports: (observation) => observation.providerIdentity?.provider === "openreview",
    extract: (body) => genericFields(body, "openreview"),
  },
  {
    name: "generic-structured-html",
    supports: (observation) => /html/i.test(observation.contentType),
    extract: (body) => genericFields(body, "generic-structured-html"),
  },
  {
    name: "generic-text",
    supports: () => true,
    extract: (body) => genericFields(body, "generic-text"),
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
  return String(candidate.callIdentity ?? "")
    .trim()
    .toLowerCase();
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
  if (target.callIdentity && candidateCallIdentity(candidate) !== target.callIdentity.toLowerCase())
    return false;
  if (target.adapter && candidate.adapter && candidate.adapter !== target.adapter) return false;
  if (target.selectorOrField && candidate.selectorOrField !== target.selectorOrField) return false;
  if (
    target.evidenceExcerpt &&
    !candidate.rawExcerpt.includes(target.evidenceExcerpt) &&
    !target.evidenceExcerpt.includes(candidate.rawExcerpt)
  )
    return false;
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
    return candidate.date === String(deadline.local_date ?? "");
  const expected = String(deadline.utc ?? "");
  if (!candidate.time || !candidate.timezone) return false;
  const at = parseInstant(`${candidate.date} ${candidate.time}`, candidate.timezone);
  return Boolean(at && expected && at.toISOString() === expected);
}

function matchingCandidate(
  target: VerificationTarget,
  candidates: ExtractedDeadlineField[],
): { candidate?: ExtractedDeadlineField; compatible: ExtractedDeadlineField[] } {
  const compatible = candidates.filter((candidate) => slotCompatible(target, candidate));
  const same = compatible.filter((candidate) => sameDeadlineValue(target.deadline, candidate));
  return { candidate: same.length === 1 ? same[0] : undefined, compatible };
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
  const bodyRef = captured.bodyRef
    ? relative(resolve(dirname(ledgerPath)), captured.bodyRef)
    : (old?.body_ref ?? "");
  return {
    requested_url: captured.requestedUrl,
    final_url: captured.finalUrl,
    status: captured.status,
    content_type: captured.contentType,
    content_length: captured.contentLength || old?.content_length || 0,
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
    concurrency: positive(value?.concurrency, 4),
    timeoutMs: positive(value?.timeoutMs, DEFAULT_CAPTURE_LIMITS.timeoutMs),
    maxBodyBytes: positive(value?.maxBodyBytes, DEFAULT_CAPTURE_LIMITS.maxBodyBytes),
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
  const fetchImpl = options.fetchImpl ?? fetch;
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
        captured = await capturePage(url, {
          fetchImpl,
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
      if (captured.notModified)
        return { group, page, candidates: [] as ExtractedDeadlineField[], notModified: true };
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
      else if (result.notModified) status = "verified";
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
  return { processed: targets.length, statuses, ledger, pages: selectedPages.length };
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
