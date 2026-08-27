/**
 * Core types, timezone resolution and date parsers.
 *
 * This module is the single place where upstream free-form values are turned
 * into structured data.  Nothing here throws on bad input: unparsable values
 * become `null` and a de-duplicated warning is written to stderr.
 *
 * Ported from scripts/model.py (kamiyobi).
 */

export const DAY_MS = 86_400_000;

/** Anywhere on Earth: UTC-12. */
export const AOE_OFFSET_MINUTES = -12 * 60;

export type DeadlineKind =
  | "abstract"
  | "paper"
  | "supplementary"
  | "notification"
  | "camera_ready"
  | "rebuttal_start"
  | "rebuttal_end"
  | "review_release"
  | "registration"
  | "other";

export const KINDS: readonly string[] = [
  "abstract",
  "paper",
  "supplementary",
  "notification",
  "camera_ready",
  "rebuttal_start",
  "rebuttal_end",
  "review_release",
  "registration",
  "other",
];

export type DeadlineConfidence = "official" | "aggregator" | "estimated";
export type EvidenceClass =
  | "official-cfp"
  | "publisher"
  | "curated-manual"
  | "aggregator"
  | "assumption";

export type EvidenceField = "date" | "time" | "timezone" | "kind" | "round" | "track";

export interface DeadlineEvidence {
  source_name: string;
  source_url: string;
  observed_at: string;
  original_value: string;
  confidence: DeadlineConfidence;
  /** Field-level provenance. Legacy snake_case fields above remain public JSON compatible. */
  sourceClass?: EvidenceClass;
  sourceUrl?: string;
  sourceRevision?: string | null;
  retrievedAt?: string;
  verifiedAt?: string | null;
  contentHash?: string | null;
  rawExcerpt?: string;
  verifiedFields?: EvidenceField[];
  adapter?: string;
  structured?: boolean;
  selectorOrField?: string;
}

/** Freshness is a property of an observed deadline, never of the whole venue. */
export interface DeadlineOrigin {
  source: string;
  sourceClass?: EvidenceClass;
  revision: string | null;
  fetchedAt: string | null;
  freshness: "fresh" | "cache-fallback" | "snapshot-fallback";
}

export interface DeadlineEvidenceFallback {
  sourceName: string;
  sourceClass: EvidenceClass;
  sourceUrl?: string;
  originalValue: string;
}

const EVIDENCE_CLASSES = new Set<EvidenceClass>([
  "official-cfp",
  "publisher",
  "curated-manual",
  "aggregator",
  "assumption",
]);
const EVIDENCE_FIELDS = new Set<EvidenceField>([
  "date",
  "time",
  "timezone",
  "kind",
  "round",
  "track",
]);

/** Normalize supplied field evidence without manufacturing verification metadata. */
export function deadlineEvidence(
  value: unknown,
  fallback?: DeadlineEvidenceFallback,
): DeadlineEvidence[] {
  const items = Array.isArray(value) ? value : [];
  const out = items
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => {
      const sourceName = String(item.source_name ?? item.sourceName ?? fallback?.sourceName ?? "");
      const sourceUrl = String(item.source_url ?? item.sourceUrl ?? fallback?.sourceUrl ?? "");
      const originalValue = String(
        item.original_value ?? item.rawExcerpt ?? fallback?.originalValue ?? "",
      );
      if (!sourceName && !sourceUrl && !originalValue) return null;
      const sourceClass = String(item.sourceClass ?? fallback?.sourceClass ?? "");
      const fields = (Array.isArray(item.verifiedFields) ? item.verifiedFields : [])
        .map((field) => String(field))
        .filter((field): field is EvidenceField => EVIDENCE_FIELDS.has(field as EvidenceField));
      const evidence: DeadlineEvidence = {
        source_name: sourceName,
        source_url: sourceUrl,
        observed_at: String(item.observed_at ?? item.observedAt ?? ""),
        original_value: originalValue,
        confidence:
          item.confidence === "official" || item.confidence === "estimated"
            ? item.confidence
            : "aggregator",
        ...(EVIDENCE_CLASSES.has(sourceClass as EvidenceClass)
          ? { sourceClass: sourceClass as EvidenceClass }
          : {}),
        ...(sourceUrl ? { sourceUrl } : {}),
        ...(typeof item.sourceRevision === "string" ? { sourceRevision: item.sourceRevision } : {}),
        ...(typeof item.retrievedAt === "string" ? { retrievedAt: item.retrievedAt } : {}),
        ...(typeof item.verifiedAt === "string" ? { verifiedAt: item.verifiedAt } : {}),
        ...(typeof item.contentHash === "string" ? { contentHash: item.contentHash } : {}),
        ...(typeof item.rawExcerpt === "string" ? { rawExcerpt: item.rawExcerpt } : {}),
        ...(typeof item.adapter === "string" ? { adapter: item.adapter } : {}),
        ...(typeof item.structured === "boolean" ? { structured: item.structured } : {}),
        ...(typeof item.selectorOrField === "string"
          ? { selectorOrField: item.selectorOrField }
          : {}),
        ...(fields.length > 0 ? { verifiedFields: fields } : {}),
      };
      return evidence;
    })
    .filter((item): item is DeadlineEvidence => item !== null);
  if (out.length > 0 || !fallback) return out;
  return [
    {
      source_name: fallback.sourceName,
      source_url: fallback.sourceUrl ?? "",
      observed_at: "",
      original_value: fallback.originalValue,
      confidence: fallback.sourceClass === "assumption" ? "estimated" : "aggregator",
      sourceClass: fallback.sourceClass,
      ...(fallback.sourceUrl ? { sourceUrl: fallback.sourceUrl } : {}),
      ...(fallback.originalValue ? { rawExcerpt: fallback.originalValue } : {}),
    },
  ];
}

interface DeadlineBase {
  kind: DeadlineKind;
  label: string;
  round: number;
  /** Explicit normalized submission track; empty means the default track. */
  track?: string;
  comment: string | null;
  /** Raw candidate value retained for provenance during serialization. */
  raw_value?: string;
  evidence?: DeadlineEvidence[];
  origins?: DeadlineOrigin[];
  conflicts?: DeadlineConflict[];
  selection_rule?: string;
  /** Optional re-verification tracking for curated deadlines. */
  verification?: VerificationState;
}

export interface ExactDeadline extends DeadlineBase {
  /** Omitted on legacy in-memory values; serialization always writes it. */
  precision?: "exact";
  /** tz-aware, always UTC. */
  at_utc: Date;
  tz_raw: string;
  local_date?: never;
}

export interface DateOnlyDeadline extends DeadlineBase {
  precision: "date-only";
  /** Official calendar date. Time and timezone are unknown. */
  local_date: string;
  at_utc?: never;
  tz_raw?: never;
}

export type Deadline = ExactDeadline | DateOnlyDeadline;

export function isDateOnlyDeadline(deadline: Deadline): deadline is DateOnlyDeadline {
  return deadline.precision === "date-only";
}

export function isExactDeadline(deadline: Deadline): deadline is ExactDeadline {
  return !isDateOnlyDeadline(deadline);
}

/** Normalized non-generic track shared by merge, health, and validation. */
export function deadlineTrackKey(
  label: string | null | undefined,
  kind: string,
  explicitTrack?: string | null,
): string {
  if (explicitTrack?.trim()) return slug(explicitTrack);
  const type = slug(kind) || "other";
  const value = slug(String(label ?? "").replace(/\b(?:round|r)\s*\d+\b/gi, " "));
  const generic = new Set([
    "",
    type,
    `${type}-submission`,
    `${type}-deadline`,
    "submission",
    "deadline",
  ]);
  const genericPaper = /^(?:(?:regular|full)-)?paper-(?:submission|deadline)(?:-deadline)?$/.test(
    value,
  );
  return generic.has(value) || genericPaper ? "" : value;
}

export interface DeadlineConflict {
  at_utc: Date;
  /** Present when the conflicting observation published only a calendar date. */
  local_date?: string;
  label: string;
  source: string;
  raw_value?: string;
  evidence?: DeadlineEvidence;
}

/** Tracks ongoing re-verification of curated deadlines against their official source. */
export interface VerificationState {
  /** Official URL that was checked (CFP page, conference site). */
  official_url: string;
  /** ISO 8601 timestamp of last verification attempt (success or failure). */
  last_attempt_at: string | null;
  /** ISO 8601 timestamp of last successful confirmation (content unchanged). */
  last_verified_at: string | null;
  /** ISO 8601 timestamp of next scheduled check. */
  next_check_at: string;
  /** SHA-256 hash of last-seen page content for change detection. */
  content_hash: string | null;
  /** Current verification status. */
  status:
    | "pending"
    | "verified"
    | "changed"
    | "source-unreachable"
    | "parser-failed"
    | "manual-required";
}

/**
 * Compute the next verification check time based on days until the deadline.
 *
 * Schedule:
 *  - >90 days: 7-day interval
 *  - 30-90 days: 3-day interval
 *  - 7-30 days: daily
 *  - <7 days: daily (high priority)
 *  - Past deadline: no further checks (return null)
 */
export function computeNextCheckAt(deadlineUtc: Date | null, now: Date): string | null {
  if (!deadlineUtc) return null;
  const msUntil = deadlineUtc.getTime() - now.getTime();
  if (msUntil <= 0) return null;
  const daysUntil = msUntil / (1000 * 60 * 60 * 24);
  let intervalDays: number;
  if (daysUntil > 90) intervalDays = 7;
  else if (daysUntil > 30) intervalDays = 3;
  else intervalDays = 1;
  const nextMs = now.getTime() + intervalDays * 24 * 60 * 60 * 1000;
  // Never schedule past the deadline itself
  const clampedMs = Math.min(nextMs, deadlineUtc.getTime() - 1);
  return new Date(clampedMs).toISOString();
}

export interface DeadlineEstimate {
  point_estimate: string;
  window_start: string;
  window_end: string;
  source_editions: number[];
  method: "median-interval";
  confidence: "low" | "medium";
}

/** Explicit, source-backed venue identifiers.  Missing fields never imply identity. */
export interface VenueIdentity {
  venueId?: string;
  dblpKey?: string;
  officialDomains?: string[];
  aliases?: string[];
  sourceIds?: Record<string, string>;
}

/** Explicit edition identity supplements the legacy public `edition_id` field. */
export interface EditionIdentity {
  editionId?: string;
  officialUrls?: string[];
  /** Identifiers are scoped to their upstream source and never cross-match by value alone. */
  sourceIds?: Record<string, string>;
}

export interface Edition {
  /** Conference or workshop edition year, not the deadline's calendar year. */
  year: number;
  edition_id: string;
  link: string;
  place: string;
  date_text: string;
  /** Calendar dates kept as UTC midnights. */
  event_start: Date | null;
  event_end: Date | null;
  deadlines: Deadline[];
  estimated: boolean;
  estimate?: DeadlineEstimate;
  source: string;
  identity?: EditionIdentity;
}

export interface Conference {
  key: string;
  title: string;
  full_name: string;
  link: string;
  rank: Record<string, string>;
  dblp: string | null;
  upstream_sub: string | null;
  tags: string[];
  categories: string[];
  editions: Edition[];
  sources: string[];
  identity?: VenueIdentity;
  /** Previous public keys retained when deterministic collision handling renames a venue. */
  legacy_keys?: string[];
  category_assignments?: CategoryAssignment[];
}

export interface CategoryAssignment {
  category: string;
  reason: "source-subfield" | "explicit-venue-rule" | "manual-review" | "name-keyword";
}

// --------------------------------------------------------------------------
// warnings (aggregated; each distinct message is printed once)
// --------------------------------------------------------------------------

const WARNINGS = new Map<string, number>();

export interface WarningSummary {
  code: string;
  count: number;
  messages: string[];
}

/** Stable warning families; quoted values and counts must not create a new warning kind. */
export function warningCode(message: string): string {
  const rules: Array<[RegExp, string]> = [
    [/^unparsable event date\b/, "EVENT_DATE_UNSTRUCTURED"],
    [/^unparsable deadline\b/, "DEADLINE_UNSTRUCTURED"],
    [/^(?:unknown|conflicting) .*timezone\b/, "TIMEZONE_UNRESOLVED"],
    [/edition without a usable year/, "EDITION_YEAR_MISSING"],
    [/cannot parse\b/, "SOURCE_PARSE_FAILED"],
    [/deadline fields but every row was rejected/, "DEADLINE_PATCH_REJECTED"],
    [/date-only deadline requires/, "DATE_ONLY_INVALID"],
    [/primary\[.*outside edition window/, "PRIMARY_OUTSIDE_EDITION_WINDOW"],
    [/primary\[.*unconfirmed timezone/, "PRIMARY_TIMEZONE_UNCONFIRMED"],
    [/primary\[.*quarantined/, "PRIMARY_OBSERVATION_QUARANTINED"],
    [/fetch of .* failed/, "SOURCE_FETCH_CACHE_FALLBACK"],
    [/entry without key or title/, "SOURCE_ENTRY_INVALID"],
    [/override edition .* no accepted deadline/, "OVERRIDE_DEADLINE_REJECTED"],
  ];
  const known = rules.find(([pattern]) => pattern.test(message))?.[1];
  if (known) return known;
  const family = message
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  let hash = 2166136261;
  for (const char of family) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `UNCLASSIFIED_${(hash >>> 0).toString(16).padStart(8, "0").toUpperCase()}`;
}

export function warn(message: string): void {
  const n = (WARNINGS.get(message) ?? 0) + 1;
  WARNINGS.set(message, n);
  if (n === 1) {
    process.stderr.write(`warning: ${message}\n`);
  }
}

export function warningCounts(): Record<string, number> {
  return Object.fromEntries(WARNINGS);
}

export function warningSummaries(): WarningSummary[] {
  const grouped = new Map<string, WarningSummary>();
  for (const [message, count] of WARNINGS) {
    const code = warningCode(message);
    const held = grouped.get(code) ?? { code, count: 0, messages: [] };
    held.count += count;
    held.messages.push(message);
    grouped.set(code, held);
  }
  return [...grouped.values()]
    .map((entry) => ({ ...entry, messages: [...new Set(entry.messages)].sort(cmpStr) }))
    .sort((left, right) => cmpStr(left.code, right.code));
}

export function resetWarnings(): void {
  WARNINGS.clear();
}

// --------------------------------------------------------------------------
// date helpers (calendar values are anchored at UTC midnight)
// --------------------------------------------------------------------------

export function addDays(d: Date | null | undefined, n: number): Date {
  const base = d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date(0);
  return new Date(base.getTime() + (Number(n) || 0) * DAY_MS);
}

/** The calendar day of `d` as a UTC midnight. */
export function dateOnly(d: Date | null | undefined): Date {
  const base = d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date(0);
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
}

const PAD2 = (n: number): string => String(n).padStart(2, "0");

/** Compare strings by code point without locale-dependent collation. */
export function cmpStr(a: string | null | undefined, b: string | null | undefined): number {
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** 'YYYY-MM-DD' in UTC. */
export function fmtDate(d: Date | null | undefined): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  return `${d.getUTCFullYear()}-${PAD2(d.getUTCMonth() + 1)}-${PAD2(d.getUTCDate())}`;
}

/** strftime subset: %Y %m %d %H %M %S (UTC). */
export function fmtUTC(d: Date | null | undefined, pattern: string | null | undefined): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  const pat = String(pattern ?? "");
  return pat
    .replace(/%Y/g, String(d.getUTCFullYear()))
    .replace(/%m/g, PAD2(d.getUTCMonth() + 1))
    .replace(/%d/g, PAD2(d.getUTCDate()))
    .replace(/%H/g, PAD2(d.getUTCHours()))
    .replace(/%M/g, PAD2(d.getUTCMinutes()))
    .replace(/%S/g, PAD2(d.getUTCSeconds()));
}

/** Parse 'YYYY-MM-DD' (or a Date) into a UTC midnight, or null. */
export function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return dateOnly(value);
  const s = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (
    d.getUTCFullYear() !== Number(m[1]) ||
    d.getUTCMonth() !== Number(m[2]) - 1 ||
    d.getUTCDate() !== Number(m[3])
  ) {
    return null;
  }
  return d;
}

export interface DateOnlyWindow {
  earliestPossibleUtc: Date;
  latestPossibleUtc: Date;
}

export type DateOnlyState = "definitely-future" | "uncertain-on-date" | "definitely-past";
export type ExactDeadlineState = "future" | "past";

/** UTC interval in which an unknown timezone can still be on `localDate`. */
export function dateOnlyWindow(localDate: unknown): DateOnlyWindow | null {
  const day = asDate(localDate);
  if (day === null) return null;
  return {
    earliestPossibleUtc: new Date(day.getTime() - 14 * 3_600_000),
    latestPossibleUtc: new Date(day.getTime() + 36 * 3_600_000 - 1),
  };
}

export function dateOnlyState(localDate: unknown, now: Date): DateOnlyState | null {
  const window = dateOnlyWindow(localDate);
  if (window === null || !(now instanceof Date) || Number.isNaN(now.getTime())) return null;
  if (now.getTime() < window.earliestPossibleUtc.getTime()) return "definitely-future";
  if (now.getTime() <= window.latestPossibleUtc.getTime()) return "uncertain-on-date";
  return "definitely-past";
}

export function exactDeadlineState(atUtc: Date, now: Date): ExactDeadlineState | null {
  if (
    !(atUtc instanceof Date) ||
    Number.isNaN(atUtc.getTime()) ||
    !(now instanceof Date) ||
    Number.isNaN(now.getTime())
  )
    return null;
  return atUtc.getTime() >= now.getTime() ? "future" : "past";
}

// --------------------------------------------------------------------------
// slug
// --------------------------------------------------------------------------

/** Normalize a conference title into a key: 'IH&MMSec' -> 'ih-mmsec'. */
export function slug(title: string | null | undefined): string {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// --------------------------------------------------------------------------
// timezone
// --------------------------------------------------------------------------

const TZ_FIXED: Record<string, number> = {
  utc: 0,
  gmt: 0,
  ut: 0,
  z: 0,
  aoe: AOE_OFFSET_MINUTES,
};

/** Abbreviations whose standard/daylight meaning is explicit. */
const TZ_FIXED_ABBREVIATIONS: Record<string, number> = {
  pst: -8 * 60,
  pdt: -7 * 60,
  mst: -7 * 60,
  mdt: -6 * 60,
  est: -5 * 60,
  edt: -4 * 60,
  cet: 60,
  cest: 120,
  akst: -9 * 60,
  akdt: -8 * 60,
  hst: -10 * 60,
  cdt: -5 * 60,
};

const TZ_NAMED: Record<string, string> = {
  pt: "America/Los_Angeles",
  mt: "America/Denver",
  ct: "America/Chicago",
  et: "America/New_York",
  jst: "Asia/Tokyo",
  kst: "Asia/Seoul",
  sgt: "Asia/Singapore",
  hkt: "Asia/Hong_Kong",
};

/** These abbreviations name different zones unless the source gives context. */
const TZ_AMBIGUOUS = new Set(["cst", "ist", "bst"]);

const TZ_OFFSET_RE = /^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/;

export type Tz = { kind: "fixed"; offsetMinutes: number } | { kind: "iana"; name: string };
export type TzResolution = { status: "confirmed"; tz: Tz } | { status: "unconfirmed" };

/** Classify whether an upstream zone is precise enough to publish as UTC. */
export function resolveTzStatus(tzRaw: string | null | undefined): TzResolution {
  if (tzRaw === null || tzRaw === undefined) return { status: "unconfirmed" };
  const raw = String(tzRaw).trim();
  const low = raw.toLowerCase();

  if (!raw || TZ_AMBIGUOUS.has(low)) return { status: "unconfirmed" };
  if (low in TZ_FIXED) {
    return {
      status: "confirmed",
      tz: { kind: "fixed", offsetMinutes: TZ_FIXED[low] },
    };
  }
  if (low in TZ_FIXED_ABBREVIATIONS) {
    return {
      status: "confirmed",
      tz: { kind: "fixed", offsetMinutes: TZ_FIXED_ABBREVIATIONS[low] },
    };
  }
  if (low in TZ_NAMED) {
    return {
      status: "confirmed",
      tz: { kind: "iana", name: TZ_NAMED[low] },
    };
  }

  const m = TZ_OFFSET_RE.exec(low);
  if (m) {
    const sign = m[1] === "-" ? -1 : 1;
    const hours = Number(m[2]);
    const minutes = Number(m[3] ?? 0);
    // Reject impossible numeric offsets (minute > 59, or |offset| >= 24 h)
    // instead of silently shifting the deadline; fall through to the
    // unknown-timezone warning and UTC fallback below.
    if (hours <= 23 && minutes <= 59) {
      return {
        status: "confirmed",
        tz: { kind: "fixed", offsetMinutes: sign * (hours * 60 + minutes) },
      };
    }
  }

  if (raw.includes("/")) {
    try {
      // Intl throws RangeError for unknown timezone names.
      new Intl.DateTimeFormat("en-US", { timeZone: raw });
      return { status: "confirmed", tz: { kind: "iana", name: raw } };
    } catch {
      warn(`unknown IANA timezone ${JSON.stringify(raw)}; observation rejected`);
      return { status: "unconfirmed" };
    }
  }

  warn(`unknown timezone ${JSON.stringify(raw)}; observation rejected`);
  return { status: "unconfirmed" };
}

/** Backward-compatible resolver for code that only needs a usable zone. */
export function resolveTz(tzRaw: string | null | undefined): Tz {
  const resolution = resolveTzStatus(tzRaw);
  return resolution.status === "confirmed" ? resolution.tz : { kind: "fixed", offsetMinutes: 0 };
}

/** Whether `parseInstant` will accept this zone as a confirmed instant. */
export function isConfirmedTimezone(tzRaw: string | null | undefined): boolean {
  return resolveTzStatus(tzRaw).status === "confirmed";
}

/** Offset of `tz` at instant `utcMs`, in minutes. */
function tzOffsetMinutes(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  let hour = get("hour");
  let day = get("day");
  // Some locales/engines render midnight as '24' with the next day.
  if (hour === 24) {
    hour = 0;
    day += 1;
  }
  const local = Date.UTC(get("year"), get("month") - 1, day, hour, get("minute"), get("second"));
  return (local - utcMs) / 60_000;
}

/** Convert a naive wall-clock time (UTC-ms components) into UTC via `tz`. */
function zonedTimeToUtc(
  parts: {
    y: number;
    m: number;
    d: number;
    h: number;
    min: number;
    s: number;
  },
  tz: string,
): Date {
  let guess = Date.UTC(parts.y, parts.m - 1, parts.d, parts.h, parts.min, parts.s);
  for (let i = 0; i < 3; i++) {
    const off = tzOffsetMinutes(guess, tz);
    const candidate = guess - off * 60_000;
    if (tzOffsetMinutes(candidate, tz) === off) return new Date(candidate);
    guess = candidate;
  }
  return new Date(guess - tzOffsetMinutes(guess, tz) * 60_000);
}

/** Apply a tz descriptor to a naive wall-clock instant (ms), returning UTC. */
export function applyTz(naiveMs: number, tz: Tz): Date {
  if (tz.kind === "fixed") return new Date(naiveMs - tz.offsetMinutes * 60_000);
  const d = new Date(naiveMs);
  const instant = zonedTimeToUtc(
    {
      y: d.getUTCFullYear(),
      m: d.getUTCMonth() + 1,
      d: d.getUTCDate(),
      h: d.getUTCHours(),
      min: d.getUTCMinutes(),
      s: d.getUTCSeconds(),
    },
    tz.name,
  );
  return new Date(instant.getTime() + d.getUTCMilliseconds());
}

// --------------------------------------------------------------------------
// instants
// --------------------------------------------------------------------------

interface Naive {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  s: number;
  ms: number;
}

const EMBEDDED_TIMEZONE_RE = /(Z|[+-]\d{2}:\d{2})$/i;

/** Canonical timezone carried by an ISO timestamp, if present. */
export function embeddedTimezone(text: unknown): string | null {
  const suffix = EMBEDDED_TIMEZONE_RE.exec(String(text ?? "").trim())?.[0];
  if (!suffix) return null;
  return suffix.toUpperCase() === "Z" ? "UTC" : `UTC${suffix}`;
}

/** 'YYYY-MM-DD[ HH:MM[:SS[.sss]]]' after replacing 'T' with a space. */
function parseNaive(s: string): Naive | null {
  let m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(s);
  if (m) {
    const rawFrac = m[7] ?? "";
    const ms = rawFrac ? Number(rawFrac.slice(0, 3).padEnd(3, "0")) : 0;
    return validTime(+m[4], +m[5], +m[6])
      ? { y: +m[1], m: +m[2], d: +m[3], h: +m[4], min: +m[5], s: +m[6], ms }
      : null;
  }
  m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s);
  if (m) {
    return validTime(+m[4], +m[5], 0)
      ? { y: +m[1], m: +m[2], d: +m[3], h: +m[4], min: +m[5], s: 0, ms: 0 }
      : null;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    return { y: +m[1], m: +m[2], d: +m[3], h: 23, min: 59, s: 59, ms: 0 };
  }
  return null;
}

/** Reject out-of-range wall-clock time components (00:00–23:59:59). */
function validTime(h: number, min: number, s: number): boolean {
  return h <= 23 && min <= 59 && s <= 59;
}

function naiveToMs(n: Naive): number | null {
  const ms = Date.UTC(n.y, n.m - 1, n.d, n.h, n.min, n.s, n.ms);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== n.y ||
    check.getUTCMonth() !== n.m - 1 ||
    check.getUTCDate() !== n.d
  ) {
    return null; // e.g. Feb 30
  }
  return ms;
}

/**
 * 未発表マーカー (TBD / TBA / To be announced) と状態語 (Extended など) は
 * パース失敗ではなく、日付がこの field で表現できない正常な状態。
 * warning を出さずに null を返す (raw observation には元値が残る)。
 */
export function isNonDateMarker(text: unknown): boolean {
  if (text === null || text === undefined) return false;
  const s = String(text).trim().toLowerCase().replace(/[.:]$/, "");
  return s === "tbd" || s === "tba" || s === "to be announced" || s === "extended";
}

/** Parse an upstream deadline into an aware UTC Date, or null. */
export function parseInstant(text: unknown, tzRaw: string | null | undefined): Date | null {
  if (text === null || text === undefined || isNonDateMarker(text)) return null;
  const original = String(text).trim();
  const embeddedTzRaw = embeddedTimezone(original);
  let s = original.replace("T", " ").trim();
  if (embeddedTzRaw) s = s.replace(EMBEDDED_TIMEZONE_RE, "").trim();
  const naive = parseNaive(s);
  if (!naive) {
    warn(`unparsable deadline ${JSON.stringify(String(text))}`);
    return null;
  }
  const ms = naiveToMs(naive);
  if (ms === null) {
    warn(`unparsable deadline ${JSON.stringify(String(text))}`);
    return null;
  }
  if (embeddedTzRaw) {
    const embedded = resolveTzStatus(embeddedTzRaw);
    if (embedded.status !== "confirmed") return null;
    const instant = applyTz(ms, embedded.tz);
    if (!String(tzRaw ?? "").trim()) return instant;
    const supplied = resolveTzStatus(tzRaw);
    if (supplied.status !== "confirmed") return null;
    if (applyTz(ms, supplied.tz).getTime() !== instant.getTime()) {
      warn(`conflicting timezone in deadline ${JSON.stringify(original)}; observation rejected`);
      return null;
    }
    return instant;
  }
  const resolution = resolveTzStatus(tzRaw);
  if (resolution.status !== "confirmed") return null;
  return applyTz(ms, resolution.tz);
}

// --------------------------------------------------------------------------
// date ranges
// --------------------------------------------------------------------------

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const KNOWN_MONTH_TYPOS: Record<string, number> = {
  // Upstream typos such as 'Septemper' (APWeb-WAIM 2024).
  septemper: 9,
};

export function monthOf(word: string): number | null {
  const w = word.toLowerCase();
  if (w.length < 3) return null;
  if (w in KNOWN_MONTH_TYPOS) return KNOWN_MONTH_TYPOS[w];
  for (let i = 0; i < MONTHS.length; i++) {
    if (MONTHS[i].startsWith(w)) return i + 1;
  }
  return null;
}

const TOKEN_RE = /([A-Za-z]+)|(\d{1,4})/g;

/** Pull the first month / day / year out of one side of a range. */
function scan(part: string): {
  month: number | null;
  day: number | null;
  year: number | null;
  invalidDay: boolean;
} {
  let month: number | null = null;
  let day: number | null = null;
  let year: number | null = null;
  let invalidDay = false;
  for (const m of part.matchAll(TOKEN_RE)) {
    const word = m[1];
    const num = m[2];
    if (word !== undefined) {
      if (month === null) month = monthOf(word);
    } else {
      const n = Number(num);
      if (num.length === 4) {
        if (year === null) year = n;
      } else if (n >= 1 && n <= 31 && day === null) {
        day = n;
      } else if (day === null) {
        // Explicit but impossible day (0, 32+, 3-digit): fail closed
        // instead of degrading to a fabricated month-only span.
        invalidDay = true;
      }
    }
  }
  return { month, day, year, invalidDay };
}

function mkdate(year: number, month: number, day: number): Date | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

/** First and last calendar day of `month` in `year`. */
function monthSpan(year: number, month: number): [Date | null, Date | null] {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return [mkdate(year, month, 1), mkdate(year, month, last)];
}

/** Parse numeric date forms: 'YYYY-MM-DD - YYYY-MM-DD', 'YYYY-MM-DD to YYYY-MM-DD', 'YYYY/MM/DD', 'YYYY-MM-DD', etc. */
function parseNumericRange(s: string): { matched: boolean; range: [Date | null, Date | null] } {
  // YYYY-MM-DD - YYYY-MM-DD or YYYY/MM/DD - YYYY/MM/DD or YYYY.MM.DD - YYYY.MM.DD
  // Also supports YYYY-MM-DD - MM-DD
  let m =
    /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*(?:[-–—~]|to|through|until)\s*(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})$/i.exec(
      s,
    );
  if (m) {
    const y1 = Number(m[1]);
    const m1 = Number(m[2]);
    const d1 = Number(m[3]);
    const y2 = m[4] ? Number(m[4]) : m1 > Number(m[5]) ? y1 + 1 : y1;
    const m2 = Number(m[5]);
    const d2 = Number(m[6]);
    const start = mkdate(y1, m1, d1);
    const end = mkdate(y2, m2, d2);
    if (start && end && start <= end) {
      return { matched: true, range: [start, end] };
    }
    return { matched: true, range: [null, null] };
  }
  // YYYY-MM-DD - DD
  m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*(?:[-–—~]|to|through|until)\s*(\d{1,2})$/i.exec(s);
  if (m) {
    const y1 = Number(m[1]);
    const m1 = Number(m[2]);
    const d1 = Number(m[3]);
    const d2 = Number(m[4]);
    const start = mkdate(y1, m1, d1);
    const end = mkdate(y1, m1, d2);
    if (start && end && start <= end) {
      return { matched: true, range: [start, end] };
    }
    return { matched: true, range: [null, null] };
  }
  // Single YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
  m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) {
    const d = mkdate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (d) {
      return { matched: true, range: [d, d] };
    }
    return { matched: true, range: [null, null] };
  }
  return { matched: false, range: [null, null] };
}

function parseJapaneseRange(
  s: string,
  fallbackYear: number,
): { matched: boolean; range: [Date | null, Date | null] } {
  // 全角数字・記号を正規化 (２０２６ -> 2026, ～ -> 〜)
  // extra.yaml: '特集号予定 2027年9月号' — drop a leading label before YYYY年
  // and a trailing 号 (journal-issue marker) so the existing month branch matches.
  let norm = s.normalize("NFKC").replace(/\s+/g, "");
  norm = norm.replace(/^.*?(?=\d{4}年)/u, "").replace(/号$/u, "");

  // 1. 日付範囲: YYYY年M月D日[〜-]YYYY年M月D日 / YYYY年M月D日[〜-]M月D日 / YYYY年M月D日[〜-]D日
  let m =
    /^(\d{4})年(\d{1,2})月(\d{1,2})日\s*(?:[〜~～\-–—]|から|to)\s*(?:(\d{4})年)?(?:(\d{1,2})月)?(\d{1,2})日$/i.exec(
      norm,
    );
  if (m) {
    const y1 = Number(m[1]);
    const m1 = Number(m[2]);
    const d1 = Number(m[3]);
    const m2 = m[5] ? Number(m[5]) : m1;
    const y2 = m[4] ? Number(m[4]) : m1 > m2 ? y1 + 1 : y1;
    const d2 = Number(m[6]);
    const start = mkdate(y1, m1, d1);
    const end = mkdate(y2, m2, d2);
    if (start && end && start <= end) {
      return { matched: true, range: [start, end] };
    }
    return { matched: true, range: [null, null] };
  }

  // 2. 月度範囲: YYYY年M月[〜-]YYYY年M月 / YYYY年M月[〜-]M月
  m = /^(\d{4})年(\d{1,2})月\s*(?:[〜~～\-–—]|から|to)\s*(?:(\d{4})年)?(\d{1,2})月$/i.exec(norm);
  if (m) {
    const y1 = Number(m[1]);
    const m1 = Number(m[2]);
    const m2 = Number(m[4]);
    const y2 = m[3] ? Number(m[3]) : m1 > m2 ? y1 + 1 : y1;
    const [start] = monthSpan(y1, m1);
    const [, end] = monthSpan(y2, m2);
    if (start && end && start <= end) {
      return { matched: true, range: [start, end] };
    }
    return { matched: true, range: [null, null] };
  }

  // 3. 単一日付: YYYY年M月D日 / M月D日
  m = /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日$/.exec(norm);
  if (m) {
    const y = m[1] ? Number(m[1]) : fallbackYear;
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const one = mkdate(y, mo, d);
    if (one) {
      return { matched: true, range: [one, one] };
    }
    return { matched: true, range: [null, null] };
  }

  // 4. 単一月: YYYY年M月 / M月
  m = /^(?:(\d{4})年)?(\d{1,2})月$/.exec(norm);
  if (m) {
    const y = m[1] ? Number(m[1]) : fallbackYear;
    const mo = Number(m[2]);
    const [start, end] = monthSpan(y, mo);
    if (start && end) {
      return { matched: true, range: [start, end] };
    }
    return { matched: true, range: [null, null] };
  }

  return { matched: false, range: [null, null] };
}

/**
 * Parse free-form event dates such as 'September 29 - October 3, 2025'.
 * Also accepts month-only forms: 'November, 2026', 'March-April, 2025',
 * 'August 2027 (exact dates TBD)', and Japanese formats ('2026年8月17日〜21日').
 */
export function parseDateRange(
  text: string | null | undefined,
  fallbackYear: number,
): [Date | null, Date | null] {
  if (!text || isNonDateMarker(text)) return [null, null];

  let s = String(text).replace(/[\u2010-\u2015\u2212]/g, "-");
  s = s.replace(/\s+/g, " ").trim();
  // Drop trailing parenthetical notes (回次・併催名・TBD・場所など).
  // extra.yaml house style: '2026年8月6日-7日 (SWoPP 2026 / 第205回)'.
  // ASCII and fullwidth parens; repeat so stacked notes fall off.
  for (;;) {
    const stripped = s.replace(/\s*[(（][^)）]*[)）]\s*$/u, "").trim();
    if (stripped === s) break;
    s = stripped;
  }

  const num = parseNumericRange(s);
  if (num.matched) {
    if (num.range[0] === null || num.range[1] === null) {
      warn(`unparsable event date ${JSON.stringify(String(text))}`);
      return [null, null];
    }
    return num.range;
  }

  const jp = parseJapaneseRange(s, fallbackYear);
  if (jp.matched) {
    if (jp.range[0] === null || jp.range[1] === null) {
      warn(`unparsable event date ${JSON.stringify(String(text))}`);
      return [null, null];
    }
    return jp.range;
  }

  // 'September 29 to October 2, 2026' spells the range in words.
  s = s.replace(/\s+(?:to|through|until)\s+/gi, "-");
  const [left, right] = s.split("-", 2);
  const parts = right === undefined ? [left] : [left, right];

  const m1 = scan(parts[0]);
  if (parts.length === 1) {
    if (m1.month === null || m1.invalidDay) {
      // A standalone four-digit year is an intentional year-only value
      // (e.g. data/extra.yaml IPSJ/IEICE editions whose exact dates are
      // not published): keep the null pair silently.  'TBD 2027' is the
      // same contract with an explicit unpublished marker.
      // An impossible day (0, 32+, 3-digit) is not: fail closed instead
      // of fabricating a month-only span.
      if (!m1.invalidDay && !/^\d{4}$/.test(s) && !/^TBD\s+\d{4}$/i.test(s)) {
        warn(`unparsable event date ${JSON.stringify(String(text))}`);
      }
      return [null, null];
    }
    const year = m1.year ?? fallbackYear;
    if (m1.day === null) {
      // Month-only: 'November, 2026' / 'Oct, 2022'.
      return monthSpan(year, m1.month);
    }
    const one = mkdate(year, m1.month, m1.day);
    if (one === null) {
      // Impossible calendar date (e.g. September 31, non-leap February 29):
      // fail closed like the range branch, and warn instead of silently
      // dropping the event from every output.
      warn(`unparsable event date ${JSON.stringify(String(text))}`);
      return [null, null];
    }
    return [one, one];
  }

  const m2 = scan(parts[1]);
  const m1m = m1.month ?? m2.month;
  const m2m = m2.month ?? m1m;
  if (m1m === null || m2m === null || m1.invalidDay || m2.invalidDay) {
    warn(`unparsable event date ${JSON.stringify(String(text))}`);
    return [null, null];
  }

  // Month-only range: 'March-April, 2025'.
  if (m1.day === null && m2.day === null) {
    let y1 = m1.year;
    let y2 = m2.year;
    if (y1 === null && y2 === null) {
      y1 = y2 = fallbackYear;
    } else if (y1 === null) {
      // The stated year belongs to the second month: a descending range
      // ('October - February, 2026') crosses into the previous year, same
      // convention as the day-form branch below ('December 28 - January 3,
      // 2026' -> 2025-12-28..2026-01-03).
      y1 = (m1m > m2m ? (y2 ?? fallbackYear) - 1 : y2) ?? fallbackYear;
    } else if (y2 === null) {
      y2 = m2m < m1m ? y1 + 1 : y1;
    }
    const [start] = monthSpan(y1, m1m);
    const [, end] = monthSpan(y2!, m2m);
    if (start === null || end === null || start > end) {
      warn(`unparsable event date ${JSON.stringify(String(text))}`);
      return [null, null];
    }
    return [start, end];
  }

  if (m1.day === null || m2.day === null) {
    warn(`unparsable event date ${JSON.stringify(String(text))}`);
    return [null, null];
  }

  let y1 = m1.year;
  let y2 = m2.year;
  if (y1 === null && y2 === null) {
    y1 = y2 = fallbackYear;
  } else if (y1 === null) {
    y1 = (m1m > m2m ? (y2 ?? fallbackYear) - 1 : y2) ?? fallbackYear;
  } else if (y2 === null) {
    y2 = m2m < m1m ? y1 + 1 : y1;
  }

  const start = mkdate(y1!, m1m, m1.day);
  const end = mkdate(y2!, m2m, m2.day);
  if (start === null || end === null || start > end) {
    warn(`unparsable event date ${JSON.stringify(String(text))}`);
    return [null, null];
  }
  return [start, end];
}

// --------------------------------------------------------------------------
// deadline kinds
// --------------------------------------------------------------------------

const PAPER = new Set(["deadline", "paper", "submission", "full_paper"]);
const CAMERA = new Set([
  "camera_ready",
  "camera_ready_deadline",
  "camera",
  "revision_deadline",
  "final_paper",
  "final_submission",
]);
const REBUTTAL_END = new Set([
  "rebuttal_end",
  "rebuttal",
  "rebuttal_and_revision",
  "author_response",
]);
const REGISTRATION = new Set(["registration", "reviewer_registration", "commitment_deadline"]);

/**
 * Label vocabulary that identifies a non-paper track when the upstream type is
 * a generic term ("deadline" / "submission" etc.). Posters, art shows, student
 * volunteering, workshops, competitions, awards and demos are real deadlines
 * but not paper-submission deadlines; publishing them as kind:paper pollutes
 * the recommendation index and the UI's 投稿締切 filter.
 * "Art Papers"-style proceedings tracks are NOT listed: their label keeps the
 * word "papers" as a whole word, which the patterns below do not match.
 */
const NON_PAPER_LABEL_RE =
  /(?<![\w-])(posters?(?![\w-])|art gallery|student volunteer|workshops?(?![\w-])|student research competition|doctoral consortium|demonstration(?![\w-])|demo session|rising stars|appy hour|real-time live!|frontiers deadline|panels?(?![\w-])|educator)/i;

/** Refine a kind derived from a generic upstream type using the row's own label. */
export function refineKindWithLabel(
  kind: DeadlineKind,
  label: string | null | undefined,
  rawType?: string | null | undefined,
): DeadlineKind {
  if (kind !== "paper" && kind !== "abstract") return kind;
  // 明示的な型語 (paper / full_paper / abstract 等) で宣言された行は人間または
  // ソースの意図を反映するため、label 語彙で格下げしない。
  // 汎用語 ("deadline" / "submission" / 空) のときだけ refine を適用する。
  if (rawType !== undefined) {
    const t = String(rawType ?? "")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    // 汎用語: トラック名を含まないキー/型。ccfddl の paper_deadline /
    // submission_deadline も「論文締切」の key 表記でしかなく汎用とみなす。
    const GENERIC = new Set([
      "",
      "deadline",
      "submission",
      "paper_deadline",
      "submission_deadline",
      "due",
      "due_date",
    ]);
    if (!GENERIC.has(t)) return kind;
  }
  const s = String(label ?? "").trim();
  if (!s) return kind;
  if (NON_PAPER_LABEL_RE.test(s)) return kind === "abstract" ? kind : "other";
  // An explicit "submission"/"deadline" wording for a named non-paper track.
  if (
    /(poster|volunteer|competition|award)/i.test(s) &&
    !/full[- ]?paper|short[- ]?paper/i.test(s)
  ) {
    return "other";
  }
  return kind;
}

/** Normalize an upstream deadline type name into one of the 10 kinds. */
export function kindOf(rawTypeOrKey: string | null | undefined): DeadlineKind {
  const s = String(rawTypeOrKey ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (s.startsWith("abstract")) return "abstract";
  if (s.includes("notification")) return "notification";
  if (PAPER.has(s)) return "paper";
  if (s === "supplementary") return "supplementary";
  if (CAMERA.has(s) || s.includes("camera_ready")) return "camera_ready";
  if (s === "rebuttal_start") return "rebuttal_start";
  if (REBUTTAL_END.has(s)) return "rebuttal_end";
  if (s === "review_release") return "review_release";
  if (REGISTRATION.has(s)) return "registration";
  return "other";
}

const ROMAN_NUMERALS: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
};

const KANJI_NUMERALS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

const ROUND_PATTERNS = [
  /\b(?:round|cycle|phase|stage)\s*#?\s*([0-9]+)\b/i,
  /\b([0-9]+)(?:st|nd|rd|th)\s+(?:round|cycle|phase|stage)\b/i,
  /\b(?:round|cycle|phase|stage)\s*#?\s*(i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/i,
  /\br([1-9][0-9]?)\b/i,
  /第\s*([0-9]+|[一二三四五六七八九十]+)\s*(?:回|次|期)/,
  /([0-9]+|[一二三四五六七八九十]+)\s*次(?:締切|募集|提出)/,
  /([0-9]+|[一二三四五六七八九十]+)\s*回目/,
];

/** Submission round stated in a free-form label, else `default`. */
export function roundOf(label: string | null | undefined, defaultRound = 1): number {
  const s = String(label ?? "").normalize("NFKC");
  for (const pattern of ROUND_PATTERNS) {
    const match = pattern.exec(s);
    if (match) {
      const raw = match[1].toLowerCase();
      if (raw in ROMAN_NUMERALS) return ROMAN_NUMERALS[raw];
      if (raw in KANJI_NUMERALS) return KANJI_NUMERALS[raw];
      const value = Number(raw);
      if (value >= 1) return value;
    }
  }
  return defaultRound;
}

// --------------------------------------------------------------------------
// snapshot restore (SPEC.md section 6: keep building when upstream is down)
// --------------------------------------------------------------------------

/** 配列・文字列両対応の string[] 正規化（sources 層と同じ挙動: trim・空要素除去）。 */
function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) {
    return val
      .filter((x) => x !== null && x !== undefined)
      .map((x) => String(x).trim())
      .filter(Boolean);
  }
  if (typeof val === "string" && val.trim() !== "") {
    return [val.trim()];
  }
  return [];
}

function deadlineEstimateOf(value: unknown): DeadlineEstimate | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const sourceEditions = Array.isArray(raw.source_editions)
    ? raw.source_editions.map(Number).filter(Number.isInteger)
    : [];
  if (
    typeof raw.point_estimate !== "string" ||
    typeof raw.window_start !== "string" ||
    typeof raw.window_end !== "string" ||
    sourceEditions.length === 0 ||
    raw.method !== "median-interval" ||
    (raw.confidence !== "low" && raw.confidence !== "medium")
  ) {
    return undefined;
  }
  return {
    point_estimate: raw.point_estimate,
    window_start: raw.window_start,
    window_end: raw.window_end,
    source_editions: sourceEditions,
    method: "median-interval",
    confidence: raw.confidence,
  };
}

function identityStrings(value: unknown): string[] {
  return [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].sort(cmpStr);
}

function venueIdentityOf(value: unknown): VenueIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const venueId = typeof raw.venueId === "string" ? raw.venueId.trim() : "";
  const dblpKey = typeof raw.dblpKey === "string" ? raw.dblpKey.trim() : "";
  const officialDomains = identityStrings(raw.officialDomains);
  const aliases = identityStrings(raw.aliases);
  const sourceIds = Object.fromEntries(
    Object.entries(
      raw.sourceIds && typeof raw.sourceIds === "object"
        ? (raw.sourceIds as Record<string, unknown>)
        : {},
    )
      .filter(([, sourceId]) => typeof sourceId === "string" && sourceId.trim())
      .map(([source, sourceId]) => [source.trim(), String(sourceId).trim()])
      .filter(([source]) => source)
      .sort(([left], [right]) => cmpStr(left, right)),
  );
  return venueId ||
    dblpKey ||
    officialDomains.length ||
    aliases.length ||
    Object.keys(sourceIds).length
    ? {
        ...(venueId ? { venueId } : {}),
        ...(dblpKey ? { dblpKey } : {}),
        ...(officialDomains.length ? { officialDomains } : {}),
        ...(aliases.length ? { aliases } : {}),
        ...(Object.keys(sourceIds).length ? { sourceIds } : {}),
      }
    : undefined;
}

function editionIdentityOf(value: unknown): EditionIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const editionId = typeof raw.editionId === "string" ? raw.editionId.trim() : "";
  const officialUrls = identityStrings(raw.officialUrls);
  const sourceIds = Object.fromEntries(
    Object.entries(
      raw.sourceIds && typeof raw.sourceIds === "object"
        ? (raw.sourceIds as Record<string, unknown>)
        : {},
    )
      .filter(([, sourceId]) => typeof sourceId === "string" && sourceId.trim())
      .map(([source, sourceId]) => [source.trim(), String(sourceId).trim()])
      .filter(([source]) => source)
      .sort(([left], [right]) => cmpStr(left, right)),
  );
  return editionId || officialUrls.length || Object.keys(sourceIds).length
    ? {
        ...(editionId ? { editionId } : {}),
        ...(officialUrls.length ? { officialUrls } : {}),
        ...(Object.keys(sourceIds).length ? { sourceIds } : {}),
      }
    : undefined;
}

/** Rebuild conferences from a `data.json`-shaped payload. */
export function conferencesFromJson(
  payload: Record<string, unknown> | null | undefined,
): Conference[] {
  if (!payload || typeof payload !== "object") return [];
  const out: Conference[] = [];
  for (const raw of (payload.conferences as unknown[] | undefined) ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const conf = raw as Record<string, unknown>;
    const editions: Edition[] = [];
    for (const edRaw of (conf.editions as unknown[] | undefined) ?? []) {
      if (!edRaw || typeof edRaw !== "object") continue;
      const ed = edRaw as Record<string, unknown>;
      const year = Number(ed.year);
      if (!Number.isInteger(year) || year <= 0) continue;
      const identity = editionIdentityOf(ed.identity);
      const deadlines: Deadline[] = [];
      for (const dlRaw of (ed.deadlines as unknown[] | undefined) ?? []) {
        if (!dlRaw || typeof dlRaw !== "object") continue;
        const dl = dlRaw as Record<string, unknown>;
        const evidence = deadlineEvidence(dl.evidence).filter((item) => item.original_value);
        const origins = (Array.isArray(dl.origins) ? dl.origins : [])
          .filter((item): item is Record<string, unknown> =>
            Boolean(item && typeof item === "object"),
          )
          .map((item) => ({
            source: String(item.source ?? "").trim(),
            ...(EVIDENCE_CLASSES.has(String(item.sourceClass) as EvidenceClass)
              ? { sourceClass: String(item.sourceClass) as EvidenceClass }
              : {}),
            revision: typeof item.revision === "string" ? item.revision : null,
            fetchedAt: typeof item.fetchedAt === "string" ? item.fetchedAt : null,
            freshness: item.freshness,
          }))
          .filter(
            (item): item is DeadlineOrigin =>
              Boolean(item.source) &&
              ["fresh", "cache-fallback", "snapshot-fallback"].includes(String(item.freshness)),
          );
        const conflicts = (Array.isArray(dl.conflicts) ? dl.conflicts : [])
          .filter((item): item is Record<string, unknown> =>
            Boolean(item && typeof item === "object"),
          )
          .map((item) => {
            const rawEvidence =
              item.evidence && typeof item.evidence === "object"
                ? (item.evidence as Record<string, unknown>)
                : {};
            const conflictAt = parseInstant(
              item.at_utc ?? item.atUtc ?? item.original_value ?? rawEvidence.original_value,
              "UTC",
            );
            if (conflictAt === null) return null;
            const rawValue = String(
              item.original_value ?? rawEvidence.original_value ?? conflictAt.toISOString(),
            );
            const source = String(item.source ?? rawEvidence.source_name ?? "");
            const conflictEvidence = deadlineEvidence(rawEvidence, {
              sourceName: source,
              sourceClass: "aggregator",
              originalValue: rawValue,
            })[0];
            const conflict: DeadlineConflict = {
              at_utc: conflictAt,
              ...(asDate(item.local_date) ? { local_date: fmtDate(asDate(item.local_date)!) } : {}),
              label: String(item.label ?? ""),
              source,
              raw_value: rawValue,
              ...(conflictEvidence ? { evidence: conflictEvidence } : {}),
            };
            return conflict;
          })
          .filter((item): item is DeadlineConflict => item !== null);
        const base = {
          kind: refineKindWithLabel(kindOf(String(dl.kind ?? "other")), String(dl.label ?? "")),
          label: String(dl.label ?? ""),
          round: Number(dl.round ?? 1) || 1,
          ...(typeof dl.track === "string" && dl.track.trim() ? { track: slug(dl.track) } : {}),
          comment: dl.comment === null || dl.comment === undefined ? null : String(dl.comment),
          ...(evidence.length > 0 ? { evidence } : {}),
          ...(origins.length > 0 ? { origins } : {}),
          ...(conflicts.length > 0 ? { conflicts } : {}),
          ...(typeof dl.selection_rule === "string" ? { selection_rule: dl.selection_rule } : {}),
        };
        if (dl.precision === "date-only") {
          const localDate = asDate(dl.local_date);
          if (localDate === null) continue;
          deadlines.push({
            ...base,
            precision: "date-only",
            local_date: fmtDate(localDate),
          });
          continue;
        }
        if (!isConfirmedTimezone(String(dl.tz_raw ?? ""))) continue;
        const at = parseInstant(dl.utc, "UTC");
        if (at === null) continue;
        deadlines.push({
          ...base,
          precision: "exact",
          at_utc: at,
          tz_raw: String(dl.tz_raw ?? ""),
        });
      }
      editions.push({
        year,
        edition_id: String(ed.id ?? ""),
        link: String(ed.link ?? ""),
        place: String(ed.place ?? ""),
        date_text: String(ed.date_text ?? ""),
        event_start: asDate(ed.event_start),
        event_end: asDate(ed.event_end),
        deadlines,
        estimated: Boolean(ed.estimated),
        ...(deadlineEstimateOf(ed.estimate) ? { estimate: deadlineEstimateOf(ed.estimate) } : {}),
        source: String(ed.source ?? ""),
        ...(identity ? { identity } : {}),
      });
    }
    editions.sort((a, b) => a.year - b.year);
    let link = String(conf.link ?? "").trim();
    if (!link) {
      for (const ed of [...editions].reverse()) {
        if (ed.link) {
          link = ed.link;
          break;
        }
      }
    }
    const dblp =
      conf.dblp === null || conf.dblp === undefined || String(conf.dblp).trim() === ""
        ? null
        : String(conf.dblp).trim();
    const upstream_sub =
      conf.upstream_sub !== null && conf.upstream_sub !== undefined
        ? String(conf.upstream_sub).trim()
        : conf.sub !== null && conf.sub !== undefined
          ? String(conf.sub).trim()
          : null;
    const identity = venueIdentityOf(conf.identity);
    const categoryAssignments = (
      Array.isArray(conf.category_assignments) ? conf.category_assignments : []
    )
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .flatMap((item) => {
        const category = String(item.category ?? "").trim();
        const reason = String(item.reason ?? "");
        return category &&
          ["source-subfield", "explicit-venue-rule", "manual-review", "name-keyword"].includes(
            reason,
          )
          ? [{ category, reason: reason as CategoryAssignment["reason"] }]
          : [];
      });
    out.push({
      key: String(conf.key ?? ""),
      title: String(conf.title ?? ""),
      full_name: String(conf.full_name ?? ""),
      link,
      rank: Object.fromEntries(
        Object.entries((conf.rank as Record<string, unknown> | undefined) ?? {})
          .filter(
            ([, v]) =>
              v !== null &&
              v !== undefined &&
              String(v).trim() !== "" &&
              String(v).trim() !== "null",
          )
          .map(([k, v]) => [String(k).toLowerCase().trim(), String(v).trim()]),
      ),
      dblp,
      upstream_sub,
      tags: toStringArray(conf.tags),
      categories: toStringArray(conf.categories),
      editions,
      sources: toStringArray(conf.sources),
      ...(identity ? { identity } : {}),
      ...(toStringArray(conf.legacy_keys).length
        ? { legacy_keys: toStringArray(conf.legacy_keys) }
        : {}),
      ...(categoryAssignments.length ? { category_assignments: categoryAssignments } : {}),
    });
  }
  return out;
}
