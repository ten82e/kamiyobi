import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  type Conference,
  computeNextCheckAt,
  conferencesFromJson,
  type Deadline,
  deadlineTrackKey,
  isDateOnlyDeadline,
  parseInstant,
  type VerificationState,
} from "./model.ts";
import { type CfpExtractionCandidate, extractCfpCandidates } from "./promotion.ts";

export type ReverificationStatus = VerificationState["status"];

export interface VerificationLedgerEntry {
  official_url: string;
  last_attempt_at: string | null;
  last_verified_at: string | null;
  next_check_at: string;
  content_hash: string | null;
  status: ReverificationStatus;
  body_ref?: string;
  observed_value?: string;
  last_error?: string;
  updated_at?: string;
}

export type VerificationLedger = Record<string, VerificationLedgerEntry>;

export interface ReverificationResolution {
  deadline_id: string;
  venue_key: string;
  edition_id: string;
  kind: string;
  round: number;
  track: string;
  status: "changed" | "manual-required" | "parser-failed" | "source-unreachable";
  official_url: string;
  content_hash: string | null;
  old_value: string;
  new_value?: string;
  raw_excerpt?: string;
  body_ref?: string;
  errors?: string[];
  detected_at: string;
}

export interface ReverifyResponse {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

export type ReverifyFetcher = (url: string) => Promise<ReverifyResponse>;

export interface ReverificationOptions {
  dataPath: string;
  ledgerPath: string;
  resolutionsPath: string;
  evidenceDir: string;
  now?: Date;
  dueOnly?: boolean;
  fetcher?: ReverifyFetcher;
  timeoutMs?: number;
}

export interface ReverificationResult {
  processed: number;
  due: number;
  updated: number;
  changed: number;
  statuses: Record<ReverificationStatus, number>;
  ledger: VerificationLedger;
  resolutions: ReverificationResolution[];
}

const STATUS_SET = new Set<ReverificationStatus>([
  "pending",
  "verified",
  "changed",
  "source-unreachable",
  "parser-failed",
  "manual-required",
]);

const EMPTY_STATUS_COUNTS = (): Record<ReverificationStatus, number> => ({
  pending: 0,
  verified: 0,
  changed: 0,
  "source-unreachable": 0,
  "parser-failed": 0,
  "manual-required": 0,
});

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stableDeadlineId(
  conference: Conference,
  edition: Conference["editions"][number],
  deadline: Deadline,
): string {
  const venueId = conference.identity?.venueId?.trim() || conference.key;
  const editionId = edition.identity?.editionId?.trim() || edition.edition_id;
  // A workshop and a main call can share an edition and a generic "paper"
  // label. Use the explicit call ID as the fallback track so their ledger
  // entries cannot overwrite one another.
  const track =
    deadlineTrackKey(deadline.label, deadline.kind, deadline.track) ||
    edition.identity?.callIdentity?.callId?.trim() ||
    "main";
  return [venueId, editionId, deadline.kind, String(deadline.round), track].join("|");
}

function deadlineValue(deadline: Deadline): string {
  return isDateOnlyDeadline(deadline) ? deadline.local_date : deadline.at_utc.toISOString();
}

function deadlineInstant(deadline: Deadline): Date | null {
  if (isDateOnlyDeadline(deadline)) return new Date(`${deadline.local_date}T23:59:59.999Z`);
  return deadline.at_utc;
}

function candidateValue(candidate: CfpExtractionCandidate): string | null {
  if (!candidate.date) return null;
  if (candidate.time && candidate.timezone) {
    const instant = parseInstant(`${candidate.date} ${candidate.time}`, candidate.timezone);
    if (instant) return instant.toISOString();
  }
  return candidate.date;
}

function candidateValueForDeadline(
  candidate: CfpExtractionCandidate,
  deadline: Deadline,
): string | null {
  if (isDateOnlyDeadline(deadline)) return candidate.date ?? null;
  // An exact live value must not be marked verified from a page that only
  // supplies a calendar date; the missing time/timezone needs review.
  return candidate.time && candidate.timezone ? candidateValue(candidate) : null;
}

function candidateMatchesSlot(candidate: CfpExtractionCandidate, deadline: Deadline): boolean {
  if (candidate.kind && candidate.kind !== deadline.kind) return false;
  if (isDateOnlyDeadline(deadline)) return candidate.date === deadline.local_date;
  const value = candidateValueForDeadline(candidate, deadline);
  if (!value) return false;
  return value === deadline.at_utc.toISOString();
}

function candidateMatchesKind(candidate: CfpExtractionCandidate, deadline: Deadline): boolean {
  return !candidate.kind || candidate.kind === deadline.kind;
}

function scheduleNext(deadline: Deadline, now: Date): string {
  return (
    computeNextCheckAt(deadlineInstant(deadline), now) ??
    new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
  );
}

function validLedgerEntry(value: unknown): value is VerificationLedgerEntry {
  const raw = jsonRecord(value);
  return (
    typeof raw.official_url === "string" &&
    typeof raw.next_check_at === "string" &&
    typeof raw.status === "string" &&
    STATUS_SET.has(raw.status as ReverificationStatus) &&
    (raw.last_attempt_at === null ||
      typeof raw.last_attempt_at === "string" ||
      raw.last_attempt_at === undefined) &&
    (raw.last_verified_at === null ||
      typeof raw.last_verified_at === "string" ||
      raw.last_verified_at === undefined) &&
    (raw.content_hash === null ||
      typeof raw.content_hash === "string" ||
      raw.content_hash === undefined)
  );
}

export function readVerificationLedger(path: string): VerificationLedger {
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const object = jsonRecord(raw);
  const ledger: VerificationLedger = {};
  for (const [id, value] of Object.entries(object)) {
    if (!validLedgerEntry(value)) continue;
    const entry = value as VerificationLedgerEntry;
    ledger[id] = {
      official_url: entry.official_url,
      last_attempt_at: entry.last_attempt_at ?? null,
      last_verified_at: entry.last_verified_at ?? null,
      next_check_at: entry.next_check_at,
      content_hash: entry.content_hash ?? null,
      status: entry.status,
      ...(entry.body_ref ? { body_ref: entry.body_ref } : {}),
      ...(entry.observed_value ? { observed_value: entry.observed_value } : {}),
      ...(entry.last_error ? { last_error: entry.last_error } : {}),
      ...(entry.updated_at ? { updated_at: entry.updated_at } : {}),
    };
  }
  return ledger;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

async function fetchOfficial(url: string, timeoutMs: number): Promise<ReverifyResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { accept: "text/html, text/plain;q=0.9, */*;q=0.1" },
    });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function resolutionKey(resolution: ReverificationResolution): string {
  return `${resolution.deadline_id}\u0000${resolution.content_hash ?? ""}\u0000${resolution.new_value ?? ""}`;
}

function mergeResolutions(
  previous: ReverificationResolution[],
  additions: ReverificationResolution[],
): ReverificationResolution[] {
  const byKey = new Map(previous.map((item) => [resolutionKey(item), item]));
  for (const item of additions) byKey.set(resolutionKey(item), item);
  return [...byKey.values()].sort(
    (left, right) =>
      left.detected_at.localeCompare(right.detected_at) ||
      left.deadline_id.localeCompare(right.deadline_id),
  );
}

function readResolutions(path: string): ReverificationResolution[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return Array.isArray(raw)
    ? raw.filter((item): item is ReverificationResolution => {
        const value = jsonRecord(item);
        return typeof value.deadline_id === "string" && typeof value.status === "string";
      })
    : [];
}

function initialLedgerEntry(
  deadline: Deadline,
  officialUrl: string,
  now: Date,
  previous: VerificationLedgerEntry | undefined,
): VerificationLedgerEntry {
  return (
    previous ?? {
      official_url: officialUrl,
      last_attempt_at: null,
      last_verified_at: null,
      next_check_at: scheduleNext(deadline, now),
      content_hash: null,
      status: "pending",
    }
  );
}

function updateEntry(
  entry: VerificationLedgerEntry,
  patch: Partial<VerificationLedgerEntry>,
): VerificationLedgerEntry {
  return { ...entry, ...patch };
}

/** Apply the persistent ledger to an in-memory build before serialization. */
export function applyVerificationLedger(
  conferences: Conference[] | null | undefined,
  ledger: VerificationLedger | null | undefined,
): Conference[] {
  if (!ledger || !Object.keys(ledger).length) return conferences ?? [];
  return (conferences ?? []).map((conference) => ({
    ...conference,
    editions: conference.editions.map((edition) => ({
      ...edition,
      deadlines: edition.deadlines.map((deadline) => {
        const entry = ledger[stableDeadlineId(conference, edition, deadline)];
        return entry
          ? {
              ...deadline,
              verification: {
                official_url: entry.official_url,
                last_attempt_at: entry.last_attempt_at,
                last_verified_at: entry.last_verified_at,
                next_check_at: entry.next_check_at,
                content_hash: entry.content_hash,
                status: entry.status,
              },
            }
          : deadline;
      }),
    })),
  }));
}

/** Fetch due official pages, update the ledger, and write unresolved changes separately. */
export async function reverifyDue(options: ReverificationOptions): Promise<ReverificationResult> {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new TypeError("reverification now must be valid");
  const payload = JSON.parse(readFileSync(resolve(options.dataPath), "utf8")) as Record<
    string,
    unknown
  >;
  const conferences = conferencesFromJson(payload);
  const ledger = readVerificationLedger(options.ledgerPath);
  const previousResolutions = readResolutions(options.resolutionsPath);
  const resolutions: ReverificationResolution[] = [];
  const statuses = EMPTY_STATUS_COUNTS();
  const fetcher =
    options.fetcher ?? ((url: string) => fetchOfficial(url, options.timeoutMs ?? 20_000));
  const dueOnly = options.dueOnly ?? true;
  const targets = conferences.flatMap((conference) =>
    conference.editions.flatMap((edition) =>
      edition.deadlines.flatMap((deadline) => {
        const officialUrl = deadline.verification?.official_url || edition.link || conference.link;
        if (!officialUrl) return [];
        const deadlineAt = deadlineInstant(deadline);
        if (dueOnly && deadlineAt && deadlineAt.getTime() <= now.getTime()) return [];
        const id = stableDeadlineId(conference, edition, deadline);
        const existing = ledger[id];
        const nextCheckAt = existing?.next_check_at ?? deadline.verification?.next_check_at;
        const verificationStatus = existing?.status ?? deadline.verification?.status;
        const lastVerifiedAt =
          existing?.last_verified_at ?? deadline.verification?.last_verified_at;
        const due =
          !nextCheckAt ||
          !Number.isFinite(Date.parse(nextCheckAt)) ||
          Date.parse(nextCheckAt) <= now.getTime() ||
          // The build seeds a future cadence for pending records, but a record
          // with no successful verification must still be checked once. After
          // that first attempt, failures use their persisted next_check_at.
          (verificationStatus === "pending" && !lastVerifiedAt);
        if (dueOnly && !due) return [];
        return [{ conference, edition, deadline, id, officialUrl, existing, due }];
      }),
    ),
  );
  let updated = 0;
  let targetIndex = 0;
  const workerCount = Math.min(8, targets.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = targetIndex++;
        if (index >= targets.length) return;
        const target = targets[index]!;
        const { conference, edition, deadline, id, officialUrl } = target;
        const entry = initialLedgerEntry(deadline, officialUrl, now, target.existing);
        let next = updateEntry(entry, {
          official_url: officialUrl,
          last_attempt_at: now.toISOString(),
          updated_at: now.toISOString(),
        });
        let response: ReverifyResponse;
        try {
          response = await fetcher(officialUrl);
        } catch (error) {
          next = updateEntry(next, {
            status: "source-unreachable",
            next_check_at: scheduleNext(deadline, now),
            last_error: error instanceof Error ? error.message : String(error),
          });
          ledger[id] = next;
          statuses[next.status] += 1;
          updated += 1;
          resolutions.push({
            deadline_id: id,
            venue_key: conference.key,
            edition_id: edition.edition_id,
            kind: deadline.kind,
            round: deadline.round,
            track: deadline.track ?? "",
            status: "source-unreachable",
            official_url: officialUrl,
            content_hash: entry.content_hash,
            old_value: deadlineValue(deadline),
            errors: [next.last_error ?? "source unreachable"],
            detected_at: now.toISOString(),
          });
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          next = updateEntry(next, {
            status: "source-unreachable",
            next_check_at: scheduleNext(deadline, now),
            last_error: `HTTP status ${response.status}`,
          });
          ledger[id] = next;
          statuses[next.status] += 1;
          updated += 1;
          resolutions.push({
            deadline_id: id,
            venue_key: conference.key,
            edition_id: edition.edition_id,
            kind: deadline.kind,
            round: deadline.round,
            track: deadline.track ?? "",
            status: "source-unreachable",
            official_url: officialUrl,
            content_hash: entry.content_hash,
            old_value: deadlineValue(deadline),
            errors: [next.last_error ?? "source unreachable"],
            detected_at: now.toISOString(),
          });
          continue;
        }
        const bytes = Buffer.from(response.body, "utf8");
        const contentHash = createHash("sha256").update(bytes).digest("hex");
        mkdirSync(options.evidenceDir, { recursive: true });
        const bodyPath = join(options.evidenceDir, `${contentHash}.body`);
        if (!existsSync(bodyPath)) writeFileSync(bodyPath, bytes);
        // Store a portable repository-relative reference in the ledger.  An
        // absolute runner path would make every CI execution look like a
        // content change and would be unusable after checkout elsewhere.
        const bodyRef = relative(dirname(options.ledgerPath), bodyPath).replace(/\\/g, "/");
        const candidates = extractCfpCandidates(response.body).filter((candidate) =>
          candidateMatchesKind(candidate, deadline),
        );
        if (!candidates.length) {
          next = updateEntry(next, {
            status: "parser-failed",
            content_hash: contentHash,
            body_ref: bodyRef,
            next_check_at: scheduleNext(deadline, now),
            last_error: "no deadline candidate matched the deadline kind",
          });
          ledger[id] = next;
          statuses[next.status] += 1;
          updated += 1;
          resolutions.push({
            deadline_id: id,
            venue_key: conference.key,
            edition_id: edition.edition_id,
            kind: deadline.kind,
            round: deadline.round,
            track: deadline.track ?? "",
            status: "parser-failed",
            official_url: officialUrl,
            content_hash: contentHash,
            old_value: deadlineValue(deadline),
            body_ref: bodyRef,
            errors: [next.last_error ?? "parser failed"],
            detected_at: now.toISOString(),
          });
          continue;
        }
        const matching = candidates.filter((candidate) =>
          candidateMatchesSlot(candidate, deadline),
        );
        if (matching.length === 1) {
          const candidate = matching[0]!;
          next = updateEntry(next, {
            status: "verified",
            content_hash: contentHash,
            body_ref: bodyRef,
            last_verified_at: now.toISOString(),
            next_check_at: scheduleNext(deadline, now),
            observed_value:
              candidateValueForDeadline(candidate, deadline) ?? deadlineValue(deadline),
            last_error: undefined,
          });
          ledger[id] = next;
          statuses[next.status] += 1;
          updated += 1;
          continue;
        }
        if (candidates.length === 1) {
          const candidate = candidates[0]!;
          const newValue = candidateValueForDeadline(candidate, deadline);
          next = updateEntry(next, {
            status: newValue ? "changed" : "parser-failed",
            content_hash: contentHash,
            body_ref: bodyRef,
            next_check_at: scheduleNext(deadline, now),
            observed_value: newValue ?? undefined,
            last_error: newValue ? undefined : "candidate has no normalized date",
          });
          ledger[id] = next;
          statuses[next.status] += 1;
          updated += 1;
          const status = next.status === "changed" ? "changed" : "parser-failed";
          resolutions.push({
            deadline_id: id,
            venue_key: conference.key,
            edition_id: edition.edition_id,
            kind: deadline.kind,
            round: deadline.round,
            track: deadline.track ?? "",
            status,
            official_url: officialUrl,
            content_hash: contentHash,
            old_value: deadlineValue(deadline),
            ...(newValue ? { new_value: newValue } : {}),
            raw_excerpt: candidate.rawExcerpt,
            body_ref: bodyRef,
            ...(next.last_error ? { errors: [next.last_error] } : {}),
            detected_at: now.toISOString(),
          });
          continue;
        }
        next = updateEntry(next, {
          status: "manual-required",
          content_hash: contentHash,
          body_ref: bodyRef,
          next_check_at: scheduleNext(deadline, now),
          last_error: `multiple ${deadline.kind} deadline candidates could not be resolved`,
        });
        ledger[id] = next;
        statuses[next.status] += 1;
        updated += 1;
        resolutions.push({
          deadline_id: id,
          venue_key: conference.key,
          edition_id: edition.edition_id,
          kind: deadline.kind,
          round: deadline.round,
          track: deadline.track ?? "",
          status: "manual-required",
          official_url: officialUrl,
          content_hash: contentHash,
          old_value: deadlineValue(deadline),
          body_ref: bodyRef,
          errors: [next.last_error ?? "manual resolution required"],
          detected_at: now.toISOString(),
        });
      }
    }),
  );
  writeJsonAtomic(options.ledgerPath, ledger);
  writeJsonAtomic(options.resolutionsPath, mergeResolutions(previousResolutions, resolutions));
  return {
    processed: targets.length,
    due: targets.filter((target) => target.due).length,
    updated,
    changed: resolutions.filter((resolution) => resolution.status === "changed").length,
    statuses,
    ledger,
    resolutions: mergeResolutions(previousResolutions, resolutions),
  };
}
