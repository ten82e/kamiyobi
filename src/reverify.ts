import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { deadlineSlotId } from "./build.ts";
import {
  asDate,
  type Conference,
  computeNextCheckAt,
  deadlineTrackKey,
  type VerificationState,
} from "./model.ts";
import { type CfpExtractionCandidate, extractCfpCandidates } from "./promotion.ts";

export interface VerificationLedgerEntry extends VerificationState {
  deadline_id: string;
  venue_key: string;
  edition_id: string;
  kind: string;
  round: number;
  track: string;
  body_ref?: string;
}

export interface VerificationResolution {
  deadline_id: string;
  official_url: string;
  observed_at: string;
  status: "changed" | "manual-required";
  content_hash: string;
  previous_value: string;
  current_value: string;
  raw_excerpt: string;
}

export interface VerificationLedger {
  schema_version: 1;
  generated_at: string;
  entries: Record<string, VerificationLedgerEntry>;
  resolutions: VerificationResolution[];
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
}

interface JsonEdition {
  year?: number;
  id?: string;
  edition_id?: string;
  link?: string;
  deadlines?: JsonDeadline[];
}

interface JsonConference {
  key?: string;
  title?: string;
  link?: string;
  editions?: JsonEdition[];
}

interface JsonData {
  conferences?: JsonConference[];
}

export interface ReverifyOptions {
  dataPath: string;
  ledgerPath: string;
  now?: Date;
  due?: boolean;
  bodyRoot?: string;
  fetchImpl?: typeof fetch;
}

export interface ReverifyResult {
  processed: number;
  statuses: Record<string, number>;
  ledger: VerificationLedger;
}

function emptyLedger(): VerificationLedger {
  return { schema_version: 1, generated_at: "", entries: {}, resolutions: [] };
}

export function loadVerificationLedger(path: string): VerificationLedger {
  if (!existsSync(path)) return emptyLedger();
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<VerificationLedger>;
  if (
    value.schema_version !== 1 ||
    !value.entries ||
    Array.isArray(value.entries) ||
    typeof value.entries !== "object" ||
    !Array.isArray(value.resolutions)
  )
    throw new TypeError(`invalid verification ledger: ${path}`);
  return {
    schema_version: 1,
    generated_at: typeof value.generated_at === "string" ? value.generated_at : "",
    entries: value.entries as Record<string, VerificationLedgerEntry>,
    resolutions: value.resolutions as VerificationResolution[],
  };
}

export function writeVerificationLedger(path: string, ledger: VerificationLedger): void {
  mkdirSync(dirname(path), { recursive: true });
  const entries = Object.fromEntries(
    Object.entries(ledger.entries).sort(([left], [right]) => left.localeCompare(right)),
  );
  writeFileSync(path, `${JSON.stringify({ ...ledger, entries }, null, 2)}\n`, "utf8");
}

function deadlineId(
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

function priorState(
  deadline: JsonDeadline,
  ledgerEntry: VerificationLedgerEntry | undefined,
): Partial<VerificationState> | undefined {
  return ledgerEntry ?? deadline.verification;
}

function deadlineCutoff(deadline: JsonDeadline): Date | null {
  const value =
    deadline.precision === "date-only"
      ? `${deadline.local_date ?? ""}T23:59:59.999Z`
      : String(deadline.utc ?? "");
  const parsed = asDate(value);
  return parsed;
}

function expectedDates(deadline: JsonDeadline): Set<string> {
  return new Set(
    [deadline.local_date, deadline.utc, deadline.aoe]
      .map((value) => String(value ?? "").slice(0, 10))
      .filter((value) => /^20\d\d-\d\d-\d\d$/.test(value)),
  );
}

function sameKind(candidate: CfpExtractionCandidate, deadline: JsonDeadline): boolean {
  return !deadline.kind || candidate.kind === deadline.kind;
}

function matchingCandidate(
  deadline: JsonDeadline,
  candidates: CfpExtractionCandidate[],
): { candidate?: CfpExtractionCandidate; sameKind: CfpExtractionCandidate[] } {
  const sameKindCandidates = candidates.filter((candidate) => sameKind(candidate, deadline));
  const dates = expectedDates(deadline);
  return {
    candidate: sameKindCandidates.find((candidate) => candidate.date && dates.has(candidate.date)),
    sameKind: sameKindCandidates,
  };
}

function candidateValue(candidate: CfpExtractionCandidate | undefined): string {
  if (!candidate) return "";
  return [candidate.date, candidate.time, candidate.timezone].filter(Boolean).join(" ");
}

function deadlineValue(deadline: JsonDeadline): string {
  return String(
    deadline.precision === "date-only" ? (deadline.local_date ?? "") : (deadline.utc ?? ""),
  );
}

function nextCheck(deadline: JsonDeadline, now: Date, previous: string | undefined): string {
  return (
    computeNextCheckAt(deadlineCutoff(deadline), now) ??
    previous ??
    new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
  );
}

function stateFor(
  state: Partial<VerificationState> | undefined,
  officialUrl: string,
  now: Date,
  status: VerificationState["status"],
  hash: string | null,
  deadline: JsonDeadline,
): VerificationState {
  const verified = status === "verified" ? now.toISOString() : (state?.last_verified_at ?? null);
  return {
    official_url: officialUrl,
    last_attempt_at: now.toISOString(),
    last_verified_at: verified,
    next_check_at: nextCheck(deadline, now, state?.next_check_at),
    content_hash: hash ?? state?.content_hash ?? null,
    status,
  };
}

function bodyRef(bodyRoot: string, ledgerPath: string, hash: string): string {
  return relative(resolve(dirname(ledgerPath)), join(bodyRoot, `${hash}.body`));
}

function addResolution(
  resolutions: VerificationResolution[],
  resolution: VerificationResolution,
): void {
  const previous = resolutions[resolutions.length - 1];
  if (
    previous?.deadline_id === resolution.deadline_id &&
    previous.content_hash === resolution.content_hash
  )
    return;
  resolutions.push(resolution);
}

export async function reverifyData(options: ReverifyOptions): Promise<ReverifyResult> {
  const now = options.now ?? new Date();
  const bodyRoot = resolve(
    options.bodyRoot ?? join(dirname(options.ledgerPath), "evidence", "blobs"),
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const data = JSON.parse(readFileSync(options.dataPath, "utf8")) as JsonData;
  const ledger = loadVerificationLedger(options.ledgerPath);
  const statuses: Record<string, number> = {};
  let processed = 0;

  for (const conference of data.conferences ?? []) {
    for (const edition of conference.editions ?? []) {
      for (const deadline of edition.deadlines ?? []) {
        const id = deadlineId(conference, edition, deadline);
        const previous = ledger.entries[id];
        const state = priorState(deadline, previous);
        if (!state?.official_url || !state.next_check_at) continue;
        const cutoff = deadlineCutoff(deadline);
        if (cutoff && cutoff.getTime() <= now.getTime()) continue;
        if (options.due && Date.parse(state.next_check_at) > now.getTime()) continue;
        processed++;

        const officialUrl = state.official_url;
        let status: VerificationState["status"] = "source-unreachable";
        let hash: string | null = null;
        let currentValue = "";
        let rawExcerpt = "";
        try {
          const response = await fetchImpl(officialUrl, { redirect: "follow" });
          const body = await response.text();
          const bytes = Buffer.from(body, "utf8");
          hash = createHash("sha256").update(bytes).digest("hex");
          mkdirSync(bodyRoot, { recursive: true });
          writeFileSync(join(bodyRoot, `${hash}.body`), bytes);
          const candidates = response.ok ? extractCfpCandidates(body) : [];
          const match = matchingCandidate(deadline, candidates);
          if (!response.ok) status = "source-unreachable";
          else if (!candidates.length) status = "parser-failed";
          else if (match.candidate) status = "verified";
          else if (match.sameKind.length) {
            status = "changed";
            currentValue = candidateValue(match.sameKind[0]);
            rawExcerpt = match.sameKind[0]?.rawExcerpt ?? "";
          } else status = "manual-required";
          if (status === "manual-required" && candidates[0]) {
            currentValue = candidateValue(candidates[0]);
            rawExcerpt = candidates[0].rawExcerpt;
          }
        } catch {
          status = "source-unreachable";
        }

        const nextState = stateFor(state, officialUrl, now, status, hash, deadline);
        ledger.entries[id] = {
          ...nextState,
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
          ...(hash
            ? { body_ref: bodyRef(bodyRoot, options.ledgerPath, hash) }
            : previous?.body_ref
              ? { body_ref: previous.body_ref }
              : {}),
        };
        if (status === "changed" || status === "manual-required")
          addResolution(ledger.resolutions, {
            deadline_id: id,
            official_url: officialUrl,
            observed_at: now.toISOString(),
            status,
            content_hash: hash ?? "",
            previous_value: deadlineValue(deadline),
            current_value: currentValue,
            raw_excerpt: rawExcerpt,
          });
        statuses[status] = (statuses[status] ?? 0) + 1;
      }
    }
  }
  ledger.generated_at = now.toISOString();
  writeVerificationLedger(options.ledgerPath, ledger);
  return { processed, statuses, ledger };
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
        const entry = ledger.entries[id];
        if (!entry) return deadline;
        const {
          deadline_id: _id,
          venue_key: _venue,
          edition_id: _edition,
          kind: _kind,
          round: _round,
          track: _track,
          body_ref: _body,
          ...verification
        } = entry;
        return { ...deadline, verification };
      }),
    })),
  }));
}
