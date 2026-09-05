/** Deterministic semantic validation for every production data input. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import {
  asDate,
  deadlineTrackKey,
  embeddedTimezone,
  isConfirmedTimezone,
  parseInstant,
  truncatedVenueName,
} from "../src/model.ts";

export interface DataValidation {
  errors: string[];
  warnings: string[];
  stats: { exact: number; date_only: number; estimated: number };
}

export interface ValidatorWarning {
  code: string;
  subject: string;
  severity: "review";
  message: string;
  count?: number;
}

export type ValidatorFindingStatus = "unreviewed" | "accepted" | "fixed";

export interface ValidatorFinding extends ValidatorWarning {
  finding_id: string;
  status: ValidatorFindingStatus;
  reviewed_by?: string;
  reviewed_at?: string;
  review_reason?: string;
  evidence_ref?: string;
  expires_at?: string;
  fixed_at?: string;
}

function canonicalWarningSubject(subject: string): string {
  return subject.replace(
    /^(?:extra|manual|curated|overrides|primary|primary_overrides|snapshot):/,
    "",
  );
}

export function validatorWarnings(warnings: readonly string[]): ValidatorWarning[] {
  return [...warnings]
    .map((message) => {
      const firstSeparator = message.indexOf(":");
      const secondSeparator = message.indexOf(": ", firstSeparator + 1);
      const subject =
        (secondSeparator > firstSeparator
          ? message.slice(0, secondSeparator)
          : firstSeparator >= 0
            ? message.slice(0, firstSeparator)
            : "global"
        )
          .trim()
          .replace(/:\s*/g, ":") || "global";
      const text = message.slice(message.indexOf(":") + 1).trim();
      const code = /category vocabulary diverges/.test(text)
        ? "CATEGORY_VOCABULARY_DIVERGENCE"
        : /event date text is not structured/.test(text)
          ? "EVENT_DATE_UNSTRUCTURED"
          : /event range exceeds/.test(text)
            ? "EVENT_RANGE_ANOMALY"
            : /category_evidence/.test(text)
              ? "CATEGORY_REVIEW_EVIDENCE_MISSING"
              : "VALIDATOR_REVIEW";
      return {
        code,
        subject: canonicalWarningSubject(subject),
        severity: "review" as const,
        message,
      };
    })
    .sort(
      (left, right) =>
        left.code.localeCompare(right.code) || left.subject.localeCompare(right.subject),
    );
}

export function newValidatorWarnings(
  warnings: readonly string[],
  baseline: readonly Pick<ValidatorFinding, "code" | "subject" | "count" | "status">[],
): ValidatorWarning[] {
  const baselineCounts = new Map<string, number>();
  for (const item of baseline) {
    if (item.status !== "accepted") continue;
    baselineCounts.set(`${item.code}\0${item.subject}`, item.count ?? 1);
  }
  return warningIdentities(warnings).flatMap((item) => {
    const key = `${item.code}\0${item.subject}`;
    return item.count! > (baselineCounts.get(key) ?? 0) ? [item] : [];
  });
}

function warningSource(message: string): string | undefined {
  return /^(extra|manual|curated|overrides|primary|primary_overrides|snapshot):/.exec(
    message.trim(),
  )?.[1];
}

export function warningIdentities(warnings: readonly string[]): ValidatorWarning[] {
  const counts = new Map<string, ValidatorWarning & { count: number }>();
  const sourceByKey = new Map<string, string>();
  for (const item of validatorWarnings(warnings)) {
    const key = `${item.code}\0${item.subject}`;
    const source = warningSource(item.message);
    const previousSource = sourceByKey.get(key);
    if (source && previousSource && source !== previousSource) continue;
    if (source && !previousSource) sourceByKey.set(key, source);
    const existing = counts.get(key);
    counts.set(key, { ...item, count: (existing?.count ?? 0) + 1 });
  }
  return [...counts.values()].sort(
    (left, right) =>
      left.code.localeCompare(right.code) || left.subject.localeCompare(right.subject),
  );
}

export function validateFindings(
  findings: readonly ValidatorFinding[],
  now = Date.now(),
): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const activeSubjects = new Set<string>();
  for (const finding of findings) {
    if (!finding.finding_id || ids.has(finding.finding_id))
      errors.push(`${finding.finding_id || "<missing>"}: finding_id is missing or duplicated`);
    ids.add(finding.finding_id);
    if (!finding.code || !finding.subject)
      errors.push(`${finding.finding_id}: code/subject is required`);
    const subjectKey = `${finding.code}\0${finding.subject}`;
    if (finding.status !== "fixed" && activeSubjects.has(subjectKey))
      errors.push(`${finding.finding_id}: canonical finding is duplicated`);
    if (finding.status !== "fixed") activeSubjects.add(subjectKey);
    if (!["unreviewed", "accepted", "fixed"].includes(finding.status))
      errors.push(`${finding.finding_id}: invalid status`);
    if (finding.status === "unreviewed")
      errors.push(`${finding.finding_id}: finding is unreviewed`);
    if (finding.status === "accepted") {
      if (!finding.reviewed_by)
        errors.push(`${finding.finding_id}: accepted finding lacks reviewed_by`);
      if (!finding.reviewed_at || !Number.isFinite(Date.parse(finding.reviewed_at)))
        errors.push(`${finding.finding_id}: accepted finding lacks valid reviewed_at`);
      if (!finding.review_reason)
        errors.push(`${finding.finding_id}: accepted finding lacks review_reason`);
      if (!finding.evidence_ref)
        errors.push(`${finding.finding_id}: accepted finding lacks evidence_ref`);
      const expiresAt = Date.parse(finding.expires_at ?? "");
      if (!Number.isFinite(expiresAt))
        errors.push(`${finding.finding_id}: accepted finding lacks valid expires_at`);
      else if (expiresAt <= now) errors.push(`${finding.finding_id}: accepted finding has expired`);
    }
    if (
      finding.status === "fixed" &&
      (!finding.fixed_at || !Number.isFinite(Date.parse(finding.fixed_at)))
    )
      errors.push(`${finding.finding_id}: fixed finding lacks valid fixed_at`);
  }
  return errors;
}

function readFindings(root: string): ValidatorFinding[] {
  const path = join(root, "data", "validator-findings.json");
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { findings?: ValidatorFinding[] };
  if (!Array.isArray(parsed.findings))
    throw new Error("validator-findings.json: findings is not an array");
  const errors = validateFindings(parsed.findings);
  if (errors.length) throw new Error(`invalid validator findings:\n${errors.join("\n")}`);
  return parsed.findings;
}

const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff\ufffd]/u;
const YEAR = /\b(20\d{2})\b/g;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAX_EVENT_DAYS = 31;
const CATEGORY_REVIEW_FIELDS = [
  "review_state",
  "reviewState",
  "category_review",
  "categoryReview",
  "categoryReviewState",
  "categoriesReviewState",
  "promotion",
  "promotion_state",
  "promotionState",
] as const;
const CATEGORY_STOP_WORDS = new Set([
  "and",
  "conference",
  "for",
  "in",
  "international",
  "of",
  "on",
  "symposium",
  "the",
  "to",
  "with",
  "workshop",
]);

type CategoryDefinitions = ReadonlyMap<string, string>;

function add(out: string[], message: string): void {
  out.push(message);
}
function years(value: unknown): number[] {
  return [...String(value ?? "").matchAll(YEAR)].map((match) => Number(match[1]));
}
function idYears(value: string, includeShortSuffix = false): number[] {
  const standalone = [...value.matchAll(/(?:^|[-_])(20\d{2})(?=$|[-_])/g)].map((match) =>
    Number(match[1]),
  );
  // Some upstream IDs compact the issue and edition suffix as 202726; the
  // terminal 26 is the edition year and must still be checked.
  const compact = [...value.matchAll(/20\d{2}(\d{2})(?=$|[-_])/g)].map(
    (match) => 2000 + Number(match[1]),
  );
  const terminalFour = /20\d{2}$/.exec(value);
  const terminalShort = /(\d{2})$/.exec(value);
  const shortYear = terminalShort ? Number(terminalShort[1]) : 0;
  return [
    ...new Set([
      ...standalone,
      ...compact,
      ...(terminalFour ? [Number(terminalFour[0])] : []),
      ...(includeShortSuffix && shortYear >= 20 ? [2000 + shortYear] : []),
    ]),
  ];
}
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object"),
      )
    : [];
}

function shortTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/20\d\d/g, " ")
    .replace(/\b(?:acm|ieee|ei)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function nameTokens(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/20\d\d/g, " ")
      .replace(/\b(?:acm|ieee|ei|the)\b/g, " ")
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );
}

function tokenJaccard(left: string, right: string): number {
  const a = nameTokens(left);
  const b = nameTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / (a.size + b.size - intersection);
}

/** Same-year local records whose short titles match and whose names overlap. */
export function likelyDuplicateVenues(
  conferences: ReadonlyArray<{
    key?: unknown;
    title?: unknown;
    full_name?: unknown;
    editions?: unknown;
  }>,
): string[] {
  const rows = conferences.flatMap((conference) =>
    records(conference.editions).map((edition) => ({
      key: String(conference.key ?? "?"),
      title: String(conference.title ?? ""),
      fullName: String(conference.full_name ?? ""),
      year: Number(edition.year ?? 0),
    })),
  );
  const duplicates = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const left = rows[i];
      const right = rows[j];
      if (left.key === right.key || left.year !== right.year) continue;
      const title = shortTitle(left.title);
      if (!title || title !== shortTitle(right.title)) continue;
      if (
        tokenJaccard(left.fullName, right.fullName) < 0.7 &&
        shortTitle(left.fullName) !== title &&
        shortTitle(right.fullName) !== title
      )
        continue;
      duplicates.add([left.key, right.key].sort().join(" / "));
    }
  }
  return [...duplicates].sort();
}

function categoryRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return records(value);
  return value && typeof value === "object"
    ? records((value as Record<string, unknown>).conferences)
    : [];
}

function categoryValues(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string"))]
        .map((item) => item.trim())
        .filter(Boolean)
        .sort()
    : [];
}

export interface CategoryChange {
  key: string;
  before: string[];
  after: string[];
  added: string[];
  removed: string[];
}

export interface CategoryChangeSummary {
  changes: CategoryChange[];
  added: number;
  removed: number;
  summary: string;
}

/** Compare two data.json-shaped values without reading files or mutating input. */
export function summarizeCategoryChanges(before: unknown, after: unknown): CategoryChangeSummary {
  const categories = (value: unknown): Map<string, string[]> =>
    new Map(
      categoryRecords(value)
        .map(
          (conference) =>
            [String(conference.key ?? ""), categoryValues(conference.categories)] as const,
        )
        .filter(([key]) => key),
    );
  const previous = categories(before);
  const current = categories(after);
  const reasons = new Map(
    categoryRecords(after).flatMap((conference) =>
      records(conference.category_assignments).map(
        (assignment) =>
          [
            `${String(conference.key ?? "")}\0${String(assignment.category ?? "")}`,
            String(assignment.reason ?? "unknown"),
          ] as const,
      ),
    ),
  );
  const keys = [...previous.keys()].filter((key) => current.has(key)).sort();
  const changes = keys.flatMap((key) => {
    const previousValues = previous.get(key) ?? [];
    const currentValues = current.get(key) ?? [];
    const beforeSet = new Set(previousValues);
    const afterSet = new Set(currentValues);
    const added = currentValues.filter((value) => !beforeSet.has(value));
    const removed = previousValues.filter((value) => !afterSet.has(value));
    return added.length || removed.length
      ? [{ key, before: previousValues, after: currentValues, added, removed }]
      : [];
  });
  const summary = changes.length
    ? changes
        .map(
          ({ key, added, removed }) =>
            `- ${key}: ${[
              added.length
                ? `+${added
                    .map(
                      (category) =>
                        `${category} (${reasons.get(`${key}\0${category}`) ?? "unknown"})`,
                    )
                    .join(",")}`
                : "",
              removed.length ? `-${removed.join(",")}` : "",
            ]
              .filter(Boolean)
              .join(" ")}`,
        )
        .join("\n")
    : "- No category changes";
  return {
    changes,
    added: changes.reduce((count, change) => count + change.added.length, 0),
    removed: changes.reduce((count, change) => count + change.removed.length, 0),
    summary,
  };
}

export type DeadlineChangeRisk = "critical" | "high" | "medium" | "low" | "informational";

export interface DeadlineSemanticChange {
  slot: string;
  before: string | null;
  after: string | null;
  precisionBefore: string | null;
  precisionAfter: string | null;
  evidenceBefore: string | null;
  evidenceAfter: string | null;
  risk: DeadlineChangeRisk;
}

function deadlineSemanticRows(value: unknown): Map<string, Record<string, unknown>> {
  const rows = new Map<string, Record<string, unknown>>();
  for (const conference of categoryRecords(value)) {
    const venue = String(conference.key ?? "");
    for (const edition of records(conference.editions)) {
      const editionId = String(edition.id ?? edition.edition_id ?? edition.year ?? "");
      for (const deadline of records(edition.deadlines)) {
        const kind = String(deadline.kind ?? "other");
        const slot = [
          venue,
          editionId,
          kind,
          String(deadlineRound(deadline)),
          normalizedTrack(deadline.track, deadline.label, kind),
        ].join(" / ");
        rows.set(slot, deadline);
      }
    }
  }
  return rows;
}

function evidenceClass(deadline: Record<string, unknown> | undefined): string | null {
  return (
    records(deadline?.evidence)
      .map((evidence) => String(evidence.sourceClass ?? evidence.source_name ?? ""))
      .find(Boolean) ?? null
  );
}

function semanticRisk(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): DeadlineChangeRisk {
  if (before && !after) return "high";
  if (!before && after) return after.precision === "date-only" ? "medium" : "informational";
  if (!before || !after) return "informational";
  if (before.precision !== "date-only" && after.precision === "date-only") return "critical";
  const oldValue = Date.parse(
    deadlineValue(before, before.precision === "date-only" ? "date-only" : "exact"),
  );
  const newValue = Date.parse(
    deadlineValue(after, after.precision === "date-only" ? "date-only" : "exact"),
  );
  if (Number.isFinite(oldValue) && Number.isFinite(newValue) && newValue < oldValue)
    return "critical";
  const oldEvidence = evidenceClass(before);
  const newEvidence = evidenceClass(after);
  if (
    ["official-cfp", "publisher"].includes(oldEvidence ?? "") &&
    !["official-cfp", "publisher"].includes(newEvidence ?? "")
  )
    return "high";
  return "informational";
}

export function summarizeDeadlineChanges(
  before: unknown,
  after: unknown,
): { changes: DeadlineSemanticChange[]; summary: string } {
  const previous = deadlineSemanticRows(before);
  const current = deadlineSemanticRows(after);
  const changes = [...new Set([...previous.keys(), ...current.keys()])].sort().flatMap((slot) => {
    const oldDeadline = previous.get(slot);
    const newDeadline = current.get(slot);
    const oldPrecision = oldDeadline ? String(oldDeadline.precision ?? "exact") : null;
    const newPrecision = newDeadline ? String(newDeadline.precision ?? "exact") : null;
    const oldValue = oldDeadline
      ? deadlineValue(oldDeadline, oldPrecision === "date-only" ? "date-only" : "exact")
      : null;
    const newValue = newDeadline
      ? deadlineValue(newDeadline, newPrecision === "date-only" ? "date-only" : "exact")
      : null;
    const oldEvidence = evidenceClass(oldDeadline);
    const newEvidence = evidenceClass(newDeadline);
    if (oldValue === newValue && oldPrecision === newPrecision && oldEvidence === newEvidence)
      return [];
    return [
      {
        slot,
        before: oldValue,
        after: newValue,
        precisionBefore: oldPrecision,
        precisionAfter: newPrecision,
        evidenceBefore: oldEvidence,
        evidenceAfter: newEvidence,
        risk: semanticRisk(oldDeadline, newDeadline),
      } satisfies DeadlineSemanticChange,
    ];
  });
  return {
    changes,
    summary: changes.length
      ? changes
          .map(
            (change) =>
              `- ${change.slot}\n  date: ${change.before ?? "—"} -> ${change.after ?? "—"}; ` +
              `precision: ${change.precisionBefore ?? "—"} -> ${change.precisionAfter ?? "—"}; ` +
              `evidence: ${change.evidenceBefore ?? "—"} -> ${change.evidenceAfter ?? "—"}; risk: ${change.risk}`,
          )
          .join("\n")
      : "- No deadline semantic changes",
  };
}

export function normalizedTrack(track: unknown, label: unknown, kind: unknown): string {
  return deadlineTrackKey(
    String(label ?? ""),
    String(kind || "other"),
    typeof track === "string" ? track : "",
  );
}

function deadlineValue(
  deadline: Record<string, unknown>,
  precision: "exact" | "date-only",
): string {
  return String(
    precision === "date-only"
      ? (deadline.local_date ?? deadline.date)
      : (deadline.utc ?? deadline.at_utc ?? deadline.date ?? ""),
  );
}
function deadlineRound(deadline: Record<string, unknown>): number {
  const explicit = Number(deadline.round ?? 1) || 1;
  const named = /\b(?:round|r)\s*(\d+)\b/i.exec(String(deadline.label ?? ""));
  return named ? Number(named[1]) : explicit;
}

function exactTimezone(deadline: Record<string, unknown>, value: string): string {
  // `utc`/`at_utc` is already normalized; its trailing Z is not in conflict
  // with the original source zone retained in `tz_raw`.
  const timezone = String(deadline.tz_raw ?? deadline.tz ?? deadline.timezone ?? "");
  if (
    (deadline.utc !== undefined || deadline.at_utc !== undefined) &&
    embeddedTimezone(value) === "UTC" &&
    (!timezone || isConfirmedTimezone(timezone))
  )
    return "";
  return timezone;
}

function configuredCategories(root = ROOT): Map<string, string> {
  const raw = load(join(root, "config.yaml")).categories;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new Map();
  return new Map(
    Object.entries(raw as Record<string, unknown>)
      .filter(([key]) => key.trim())
      .map(([key, label]) => [key, String(label ?? "")]),
  );
}

function words(value: unknown): Set<string> {
  return new Set(
    (
      String(value ?? "")
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? []
    ).filter((word) => !CATEGORY_STOP_WORDS.has(word)),
  );
}

function hasMeaningfulValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

function isAutoPromoted(conference: Record<string, unknown>): boolean {
  return CATEGORY_REVIEW_FIELDS.some((field) => {
    const value = conference[field];
    if (value === undefined || value === null || value === false) return false;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return /auto|approv|confirm|promot|reviewed|verified/i.test(text ?? "");
  });
}

function categoryDivergence(
  conference: Record<string, unknown>,
  categoryDefinitions: CategoryDefinitions,
): string[] {
  const assigned = categoryValues(conference.categories).filter((category) =>
    categoryDefinitions.has(category),
  );
  const text = [conference.title, conference.full_name, conference.scope]
    .filter((value) => typeof value === "string")
    .join(" ");
  const textWords = words(text);
  if (!assigned.length || !textWords.size) return [];
  const scores = [...categoryDefinitions].map(
    ([category, label]) =>
      [
        category,
        [...words(`${category} ${label}`)].filter((word) => textWords.has(word)).length,
      ] as const,
  );
  if (assigned.some((category) => scores.find(([name]) => name === category)?.[1])) return [];
  return scores
    .filter(([category, score]) => !assigned.includes(category) && score >= 2)
    .sort(([, left], [, right]) => right - left)
    .map(([category]) => category);
}

function validateCategories(
  key: string,
  conference: Record<string, unknown>,
  categoryDefinitions: CategoryDefinitions,
  result: DataValidation,
): void {
  if (!("categories" in conference)) return;
  const raw = conference.categories;
  if (!Array.isArray(raw) || raw.length === 0) {
    add(result.errors, `${key}: categories is empty or invalid`);
  } else {
    for (const item of raw) {
      const category = typeof item === "string" ? item.trim() : "";
      if (!category) add(result.errors, `${key}: category is empty`);
      else if (!categoryDefinitions.has(category))
        add(result.errors, `${key}: unknown category ${category}`);
    }
  }
  if (isAutoPromoted(conference) && !hasMeaningfulValue(conference.category_evidence))
    add(result.warnings, `${key}: auto-promoted categories lack category_evidence`);
  const divergent = categoryDivergence(conference, categoryDefinitions);
  if (divergent.length)
    add(
      result.warnings,
      `${key}: category vocabulary diverges from title/full_name/scope; possible ${divergent.join(", ")}`,
    );
}

function parseExactDeadline(
  value: string,
  timezone: string,
  prefix: string,
  result: DataValidation,
): Date | null {
  const embedded = embeddedTimezone(value);
  const confirmedTimezone = timezone && isConfirmedTimezone(timezone);
  const confirmedEmbedded = embedded && isConfirmedTimezone(embedded);
  const parsed = parseInstant(value, timezone || embedded);
  if (parsed) return parsed;
  if (
    (timezone && !confirmedTimezone) ||
    (embedded && !confirmedEmbedded) ||
    (!timezone && !embedded)
  )
    add(result.errors, `${prefix}: exact has unconfirmed timezone`);
  else if (timezone && embedded)
    add(result.errors, `${prefix}: exact timezone conflicts with embedded offset`);
  else add(result.errors, `${prefix}: invalid exact instant`);
  return null;
}

function validateEdition(
  key: string,
  edition: Record<string, unknown>,
  result: DataValidation,
): void {
  const year = Number(edition.year);
  const id = String(edition.id ?? edition.edition_id ?? "");
  const prefix = `${key}/${id || year}`;
  if (!Number.isInteger(year)) {
    add(result.errors, `${prefix}: edition year is invalid`);
    return;
  }
  for (const idYear of idYears(id))
    if (idYear !== year) add(result.errors, `${prefix}: id year conflicts with edition year`);
  const start = asDate(edition.event_start);
  const end = asDate(edition.event_end);
  if (edition.event_start !== undefined && edition.event_start !== null && !start)
    add(result.errors, `${prefix}: event_start is invalid`);
  if (edition.event_end !== undefined && edition.event_end !== null && !end)
    add(result.errors, `${prefix}: event_end is invalid`);
  if (start && start.getUTCFullYear() !== year)
    add(result.errors, `${prefix}: event_start year conflicts with edition ${year}`);
  if (end && ![year, year + 1].includes(end.getUTCFullYear()))
    add(result.errors, `${prefix}: event_end year conflicts with edition ${year}`);
  const allowedTextYears = new Set([year]);
  if (start?.getUTCFullYear() === year && end?.getUTCFullYear() === year + 1)
    allowedTextYears.add(year + 1);
  for (const mentioned of years(edition.date_text))
    if (!allowedTextYears.has(mentioned))
      add(result.errors, `${prefix}: date_text year ${mentioned} conflicts with edition ${year}`);
  if ((start === null) !== (end === null))
    add(result.errors, `${prefix}: event range is incomplete`);
  if (start && end) {
    if (start > end) add(result.errors, `${prefix}: event range is reversed`);
    if (end.getTime() - start.getTime() > MAX_EVENT_DAYS * 86_400_000) {
      const dateText = String(edition.date_text ?? "");
      const hasDayNumber = /(?:^|[^\d])(?:[1-9]|[12]\d|3[01])(?:\D|$)/.test(dateText);
      const isMonthEnvelope =
        !hasDayNumber &&
        /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|(?:1[0-2]|[1-9])月/i.test(
          dateText,
        );
      add(
        isMonthEnvelope ? result.warnings : result.errors,
        `${prefix}: event range exceeds ${MAX_EVENT_DAYS} days`,
      );
    }
  }
  const dateText = String(edition.date_text ?? "").trim();
  const eventPrecision = String(edition.event_date_precision ?? "").trim();
  if (
    eventPrecision &&
    !["exact-range", "single-day", "month-only", "not-announced", "unverified"].includes(
      eventPrecision,
    )
  )
    add(result.errors, `${prefix}: unknown event date precision ${eventPrecision}`);
  const eventStatus = String(edition.event_date_status ?? "")
    .trim()
    .toLowerCase();
  const explicitlyNotAnnounced =
    eventStatus === "not-announced" || /^(?:tbd(?:\s+20\d{2})?|not announced)$/i.test(dateText);
  if (!start && !end && dateText && !explicitlyNotAnnounced && !eventPrecision)
    add(result.warnings, `${prefix}: event date text is not structured`);

  const slots = new Map<string, string>();
  for (const deadline of records(edition.deadlines)) {
    if (
      deadline.precision !== undefined &&
      deadline.precision !== "exact" &&
      deadline.precision !== "date-only"
    )
      add(result.errors, `${prefix}: unknown deadline precision ${String(deadline.precision)}`);
    const precision = deadline.precision === "date-only" ? "date-only" : "exact";
    const value = deadlineValue(deadline, precision);
    let deadlineDate: Date | null = null;
    if (precision === "date-only") {
      result.stats.date_only += 1;
      if (
        deadline.tz_raw ||
        deadline.tz ||
        deadline.timezone ||
        deadline.utc ||
        deadline.at_utc ||
        deadline.time ||
        /[T\s]\d{1,2}:\d{2}/.test(value)
      )
        add(result.errors, `${prefix}: date-only has time/timezone`);
      deadlineDate = asDate(value);
      if (!deadlineDate) add(result.errors, `${prefix}: invalid date-only value`);
    } else {
      result.stats.exact += 1;
      const tz = exactTimezone(deadline, value);
      if (deadline.local_date !== undefined)
        add(result.errors, `${prefix}: exact mixes local_date with instant`);
      const calendarDate = /^(\d{4}-\d{2}-\d{2})[T ]/.exec(value)?.[1];
      deadlineDate = parseExactDeadline(value, tz, prefix, result) ?? asDate(calendarDate);
    }
    if (edition.estimated) result.stats.estimated += 1;
    const kind = String(deadline.kind ?? "other");
    const slot = [
      kind,
      deadlineRound(deadline),
      normalizedTrack(deadline.track, deadline.label, kind),
    ].join("\0");
    const previous = slots.get(slot);
    if (previous !== undefined && previous !== value)
      add(result.errors, `${prefix}: conflicting deadline slot ${slot.replaceAll("\0", "/")}`);
    slots.set(slot, value);
    const meetingEnd = end ?? start;
    if (
      start &&
      deadlineDate &&
      !Number.isNaN(deadlineDate.getTime()) &&
      ["paper", "abstract", "supplementary"].includes(kind) &&
      meetingEnd &&
      deadlineDate > meetingEnd
    )
      add(result.errors, `${prefix}: deadline appears to be an event date (${kind})`);
  }
}

export function validateData(
  payload: Record<string, unknown>,
  categoryDefinitions: CategoryDefinitions = configuredCategories(),
): DataValidation {
  const result: DataValidation = {
    errors: [],
    warnings: [],
    stats: { exact: 0, date_only: 0, estimated: 0 },
  };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    add(result.errors, "top-level payload must be an object");
    return result;
  }
  if (!Array.isArray(payload.conferences)) {
    add(result.errors, "conferences must be an array");
    return result;
  }
  for (const conference of records(payload.conferences)) {
    const key = String(conference.key ?? "?");
    const editions = records(conference.editions);
    validateCategories(key, conference, categoryDefinitions, result);
    const actualYears = editions
      .filter((edition) => !edition.estimated)
      .map((edition) => Number(edition.year))
      .filter(Number.isInteger);
    if (actualYears.length > 0) {
      const expected = Math.max(...actualYears);
      for (const keyYear of idYears(key, true)) {
        if (keyYear !== expected)
          add(result.errors, `${key}: key year ${keyYear} conflicts with edition ${expected}`);
      }
    }
    for (const field of ["title", "full_name"] as const) {
      const value = String(conference[field] ?? "");
      if (INVISIBLE.test(value))
        add(result.errors, `${key}: ${field} contains invisible/replacement characters`);
      if (truncatedVenueName(value)) add(result.errors, `${key}: ${field} appears truncated`);
      const mentioned = years(value);
      const actual = actualYears;
      if (mentioned.length && actual.length) {
        const expected = Math.max(...actual);
        for (const namedYear of mentioned)
          if (namedYear !== expected)
            add(
              result.errors,
              `${key}: ${field} year ${namedYear} conflicts with edition ${expected}`,
            );
      }
    }
    const ids = new Set<string>();
    for (const edition of editions) {
      const id = String(edition.id ?? edition.edition_id ?? "");
      if (id && ids.has(id)) add(result.errors, `${key}: duplicate edition id ${id}`);
      ids.add(id);
      validateEdition(key, edition, result);
    }
  }
  for (const pair of likelyDuplicateVenues(records(payload.conferences)))
    add(result.errors, `duplicate venue edition ${pair}`);
  result.errors = [...new Set(result.errors)].sort();
  result.warnings.sort();
  return result;
}

function load(path: string): Record<string, unknown> {
  return loadYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
}
function overrideConferences(
  value: Record<string, unknown>,
  source: string,
): Record<string, unknown>[] {
  const primary = source === "primary_overrides";
  return Object.entries((value.conferences as Record<string, unknown>) ?? {}).map(([key, raw]) => ({
    key: `${source}:${key}`,
    ...(raw as Record<string, unknown>),
    editions: Object.entries(
      ((raw as Record<string, unknown>).editions as Record<string, unknown>) ?? {},
    ).map(([year, edition]) => {
      const item = edition as Record<string, unknown>;
      const deadlines = records(item.deadlines).map((deadline) => {
        if (!primary) return deadline;
        const time = typeof deadline.time === "string" ? deadline.time : "";
        return time
          ? { ...deadline, date: `${String(deadline.date)} ${time}` }
          : { ...deadline, precision: "date-only", tz: undefined, timezone: undefined };
      });
      return { year: Number(year), ...item, ...(deadlines.length ? { deadlines } : {}) };
    }),
  }));
}
function primaryRegistry(value: Record<string, unknown>): Record<string, unknown>[] {
  return Object.entries((value.conferences as Record<string, unknown>) ?? {}).map(([key, raw]) => ({
    key: `primary:${key}`,
    editions: [{ year: Number((raw as Record<string, unknown>).year) }],
  }));
}

function payloadForFile(path: string): Record<string, unknown> {
  if (path.endsWith(".json"))
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const value = load(path);
  const name = path.split("/").at(-1);
  if (name === "overrides.yaml") {
    return { conferences: overrideConferences(value, "overrides") };
  }
  if (name === "primary.yaml") return { conferences: primaryRegistry(value) };
  if (name === "primary_overrides.yaml") {
    return { conferences: overrideConferences(value, "primary_overrides") };
  }
  return value;
}

export function validateFile(
  path: string,
  categoryDefinitions: CategoryDefinitions = configuredCategories(),
): DataValidation {
  return validateData(payloadForFile(path), categoryDefinitions);
}

export function validateProduction(root = ROOT): DataValidation {
  const categoryDefinitions = configuredCategories(root);
  const extra = payloadForFile(join(root, "data", "extra.yaml"));
  const primary = load(join(root, "data", "primary.yaml"));
  const primaryOverrides = load(join(root, "data", "primary_overrides.yaml"));
  const snapshot = payloadForFile(join(root, "data", "snapshot.json"));
  const manualPath = join(root, "data", "manual.yaml");
  const curatedPath = join(root, "data", "curated.generated.yaml");
  const inputs = [
    { name: "extra", payload: extra },
    {
      name: "overrides",
      payload: payloadForFile(join(root, "data", "overrides.yaml")),
    },
    {
      name: "primary",
      payload: { conferences: primaryRegistry(primary) },
    },
    {
      name: "primary_overrides",
      payload: { conferences: overrideConferences(primaryOverrides, "primary_overrides") },
    },
    {
      name: "snapshot",
      payload: snapshot,
    },
    ...(existsSync(manualPath) ? [{ name: "manual", payload: payloadForFile(manualPath) }] : []),
    ...(existsSync(curatedPath) ? [{ name: "curated", payload: payloadForFile(curatedPath) }] : []),
  ];
  const aggregate: DataValidation = {
    errors: [],
    warnings: [],
    stats: { exact: 0, date_only: 0, estimated: 0 },
  };
  for (const input of inputs) {
    const checked = validateData(input.payload, categoryDefinitions);
    aggregate.errors.push(...checked.errors.map((message) => `${input.name}: ${message}`));
    aggregate.warnings.push(...checked.warnings.map((message) => `${input.name}: ${message}`));
    aggregate.stats.exact += checked.stats.exact;
    aggregate.stats.date_only += checked.stats.date_only;
    aggregate.stats.estimated += checked.stats.estimated;
  }
  const primaryKeys = Object.keys((primary.conferences as Record<string, unknown>) ?? {});
  const registeredKeys = new Set(primaryKeys);
  const generatedKeys = new Set(
    Object.keys((primaryOverrides.conferences as Record<string, unknown>) ?? {}),
  );
  const venueKeys = new Set(
    [...records(extra.conferences), ...records(snapshot.conferences)].map(
      (conference) => conference.key,
    ),
  );
  for (const key of primaryKeys) {
    if (!generatedKeys.has(key))
      add(aggregate.errors, `primary: ${key}: generated override missing`);
    if (!venueKeys.has(key))
      add(aggregate.errors, `primary: ${key}: venue key missing from extra/snapshot`);
  }
  for (const key of generatedKeys)
    if (!registeredKeys.has(key)) add(aggregate.errors, `primary: ${key}: registry entry missing`);
  aggregate.errors = [...new Set(aggregate.errors)].sort();
  aggregate.warnings.sort();
  return aggregate;
}

export function main(argv = process.argv.slice(2)): number {
  const json = argv.includes("--json");
  const file = argv.find((value) => !value.startsWith("-"));
  try {
    const result = file ? validateFile(file) : validateProduction();
    const findings = file ? [] : readFindings(ROOT);
    const baseline = file ? [] : findings;
    const newWarnings = file ? [] : newValidatorWarnings(result.warnings, baseline);
    if (json)
      process.stdout.write(
        `${JSON.stringify({
          ...result,
          warning_identities: warningIdentities(result.warnings),
          new_warnings: newWarnings,
          finding_counts: {
            total: findings.length,
            unreviewed: findings.filter((item) => item.status === "unreviewed").length,
          },
        })}\n`,
      );
    else
      process.stdout.write(`validated ${result.stats.exact + result.stats.date_only} deadlines\n`);
    return result.errors.length || newWarnings.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(`validate:data failed: ${String(error)}\n`);
    return 2;
  }
}
if (process.argv[1]?.endsWith("validate-data.ts")) process.exit(main());
