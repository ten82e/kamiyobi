/** Query-independent recommendation axes shared by build, benchmark, and browser runtime. */

type JsonRecord = Record<string, unknown>;

export type TrustLevel =
  | "official"
  | "publisher"
  | "curated-manual"
  | "aggregator"
  | "assumption"
  | "unverified";
export type SourceFreshness = "fresh" | "cache-fallback" | "snapshot-fallback";

export interface VenueMaturityEvidence {
  yearsObserved: number;
  dblpIndexed: boolean;
  publisherVerified: boolean;
  ranked: boolean;
  /** Number of distinct representative papers available for the venue profile. */
  profileCoverage: number;
}

export interface DeadlineTrust {
  date: TrustLevel;
  time: TrustLevel;
  timezone: TrustLevel;
  kind: TrustLevel;
  sourceFreshness: SourceFreshness;
  conflicts: number;
}

export interface RecommendationAxes {
  research_fit: { score: number | null; categories: string[]; tags: string[] };
  venue_maturity: {
    status: "established" | "emerging" | "new" | "unverified";
    profile_status: "profiled" | "unprofiled";
    evidence: VenueMaturityEvidence;
  };
  deadline_precision: "exact" | "date-only" | "estimated" | "none";
  deadline_trust: DeadlineTrust;
  /** Compatibility field derived from deadline_trust, not from unscoped evidence. */
  evidence_quality: "official" | "publisher" | "curated-manual" | "aggregator" | "none";
}

const TRUST_RANK: Record<TrustLevel, number> = {
  unverified: 0,
  assumption: 1,
  aggregator: 2,
  "curated-manual": 3,
  publisher: 4,
  official: 5,
};

const TRUST_FIELDS = ["date", "time", "timezone", "kind"] as const;
type TrustField = (typeof TRUST_FIELDS)[number];

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => Boolean(item && typeof item === "object"))
    : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].sort()
    : [];
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" ? value.trim() !== "" : value !== null && value !== undefined;
}

function rankedValue(value: unknown): boolean {
  return nonEmpty(value) && !["n", "none", "null"].includes(String(value).trim().toLowerCase());
}

function deadlineTime(deadline: JsonRecord): number | null {
  const value =
    deadline.utc ??
    deadline.earliest_utc ??
    deadline.latest_utc ??
    deadline.at_utc ??
    deadline.local_date;
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? time : null;
}

function deadlineEndTime(deadline: JsonRecord): number | null {
  const value = deadline.latest_utc ?? deadline.utc ?? deadline.at_utc ?? deadline.local_date;
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? time : null;
}

function deadlineRecords(
  conference: JsonRecord,
  now: number,
): Array<{ deadline: JsonRecord; edition: JsonRecord; estimated: boolean }> {
  const editions = records(conference.editions);
  const future = editions
    .flatMap((edition) => records(edition.deadlines).map((deadline) => ({ edition, deadline })))
    .filter(({ deadline }) => (deadlineEndTime(deadline) ?? Number.NEGATIVE_INFINITY) >= now)
    .sort((a, b) => (deadlineTime(a.deadline) ?? 0) - (deadlineTime(b.deadline) ?? 0));
  const target = future[0]?.edition;
  return target
    ? future
        .filter(({ edition }) => edition === target)
        .map(({ deadline, edition }) => ({
          deadline,
          edition,
          estimated: Boolean(edition.estimated),
        }))
    : [];
}

function trustLevel(value: unknown): TrustLevel {
  const sourceClass = String(value ?? "")
    .trim()
    .toLowerCase();
  if (sourceClass === "official" || sourceClass === "official-cfp") return "official";
  if (sourceClass === "publisher") return "publisher";
  if (sourceClass === "curated-manual") return "curated-manual";
  if (sourceClass === "aggregator") return "aggregator";
  if (sourceClass === "assumption" || sourceClass === "estimated") return "assumption";
  return "unverified";
}

function evidenceTrust(evidence: JsonRecord, field: TrustField): TrustLevel {
  const verifiedFields = strings(evidence.verifiedFields);
  return verifiedFields.includes(field)
    ? trustLevel(evidence.sourceClass ?? evidence.source_class ?? evidence.confidence)
    : "unverified";
}

function fieldTrust(deadlines: Array<{ deadline: JsonRecord }>, field: TrustField): TrustLevel {
  return deadlines.reduce<TrustLevel>((best, { deadline }) => {
    const candidate = records(deadline.evidence).reduce<TrustLevel>((current, evidence) => {
      const next = evidenceTrust(evidence, field);
      return TRUST_RANK[next] > TRUST_RANK[current] ? next : current;
    }, "unverified");
    return TRUST_RANK[candidate] > TRUST_RANK[best] ? candidate : best;
  }, "unverified");
}

function sourceFreshness(value: unknown): SourceFreshness | null {
  const status = String(value ?? "").trim();
  return status === "fresh" || status === "cache-fallback" || status === "snapshot-fallback"
    ? status
    : null;
}

function freshnessValues(record: JsonRecord): SourceFreshness[] {
  return [
    record.sourceFreshness,
    record.source_freshness,
    record.sourceStatus,
    record.source_status,
    record.freshness,
    record.source,
    record.sourceName,
    record.source_name,
    ...strings(record.sources),
  ]
    .map(sourceFreshness)
    .filter((value): value is SourceFreshness => value !== null);
}

function sourceFreshnessOf(
  conference: JsonRecord,
  selected: Array<{ deadline: JsonRecord; edition: JsonRecord }>,
): SourceFreshness {
  const selectedRecords = selected.length
    ? selected.flatMap(({ deadline, edition }) => [
        ...freshnessValues(edition),
        ...freshnessValues(deadline),
        ...records(deadline.evidence).flatMap(freshnessValues),
      ])
    : records(conference.editions).flatMap(freshnessValues);
  const values = [...freshnessValues(conference), ...selectedRecords];
  if (values.includes("snapshot-fallback")) return "snapshot-fallback";
  if (values.includes("cache-fallback")) return "cache-fallback";
  return "fresh";
}

function conflictCount(deadlines: Array<{ deadline: JsonRecord }>): number {
  return deadlines.reduce((count, { deadline }) => {
    if (Array.isArray(deadline.conflicts)) return count + deadline.conflicts.length;
    return typeof deadline.conflicts === "number" && Number.isFinite(deadline.conflicts)
      ? count + Math.max(0, deadline.conflicts)
      : count;
  }, 0);
}

function deadlineTrust(
  conference: JsonRecord,
  deadlines: Array<{ deadline: JsonRecord; edition: JsonRecord }>,
): DeadlineTrust {
  const trust = Object.fromEntries(
    TRUST_FIELDS.map((field) => [field, fieldTrust(deadlines, field)]),
  ) as Pick<DeadlineTrust, TrustField>;
  return {
    ...trust,
    sourceFreshness: sourceFreshnessOf(conference, deadlines),
    conflicts: conflictCount(deadlines),
  };
}

function evidenceQuality(
  trust: Pick<DeadlineTrust, TrustField>,
): RecommendationAxes["evidence_quality"] {
  const best = TRUST_FIELDS.reduce<TrustLevel>(
    (current, field) => (TRUST_RANK[trust[field]] > TRUST_RANK[current] ? trust[field] : current),
    "unverified",
  );
  return best === "unverified" || best === "assumption" ? "none" : best;
}

function evidenceRecords(conference: JsonRecord, editions: JsonRecord[]): JsonRecord[] {
  return [
    ...records(conference.evidence),
    ...editions.flatMap((edition) => [
      ...records(edition.evidence),
      ...records(edition.deadlines).flatMap((deadline) => records(deadline.evidence)),
    ]),
  ];
}

function maturityEvidence(conference: JsonRecord, editions: JsonRecord[]): VenueMaturityEvidence {
  const yearsObserved = new Set(
    editions
      .filter((edition) => edition.estimated !== true)
      .map((edition) => Number(edition.year))
      .filter((year) => Number.isInteger(year) && year > 0),
  ).size;
  const evidence = evidenceRecords(conference, editions);
  const publisherVerified =
    evidence.some(
      (item) =>
        trustLevel(item.sourceClass ?? item.source_class ?? item.confidence) === "publisher",
    ) ||
    [
      ...strings(conference.sources),
      ...editions.map((edition) => String(edition.source ?? "").trim()).filter(Boolean),
    ].some((source) => source.toLowerCase() === "publisher");
  const rank = conference.rank;
  const ranked =
    (typeof rank === "string" && rankedValue(rank)) ||
    (Array.isArray(rank) && rank.some(rankedValue)) ||
    (rank !== null && typeof rank === "object" && Object.values(rank).some(rankedValue));
  const profileCoverage = strings(conference.papers).length;
  const dblp = conference.dblp;
  return {
    yearsObserved,
    dblpIndexed:
      (typeof dblp === "string" && dblp.trim() !== "" && dblp.trim().toLowerCase() !== "null") ||
      (Array.isArray(dblp) && dblp.some(nonEmpty)) ||
      (dblp !== null && typeof dblp === "object" && Object.values(dblp).some(nonEmpty)),
    publisherVerified,
    ranked,
    profileCoverage,
  };
}

function maturityStatus(
  evidence: VenueMaturityEvidence,
): RecommendationAxes["venue_maturity"]["status"] {
  const signals =
    (evidence.yearsObserved >= 3 ? 1 : 0) +
    (evidence.dblpIndexed ? 1 : 0) +
    (evidence.publisherVerified ? 1 : 0) +
    (evidence.ranked ? 1 : 0) +
    (evidence.profileCoverage >= 2 ? 1 : 0);
  // Two editions or one paper alone only supports emerging/new; established needs history plus two independent signals.
  if (evidence.yearsObserved >= 3 && signals >= 3) return "established";
  if (evidence.yearsObserved >= 2 || signals >= 2) return "emerging";
  if (evidence.yearsObserved >= 1 || signals >= 1 || evidence.profileCoverage >= 1) return "new";
  return "unverified";
}

export function recommendationAxes(
  conference: JsonRecord,
  researchFitScore: number | null = null,
  now: number = Date.now(),
): RecommendationAxes {
  const deadlines = deadlineRecords(conference, now);
  const trust = deadlineTrust(conference, deadlines);
  const editions = records(conference.editions);
  const maturity = maturityEvidence(conference, editions);
  const hasExact = deadlines.some(
    ({ deadline }) => deadline.precision !== "date-only" && Boolean(deadline.utc),
  );
  const hasDateOnly = deadlines.some(({ deadline }) => deadline.precision === "date-only");
  const hasEstimated =
    deadlines.some(({ estimated }) => estimated) ||
    (deadlines.length === 0 &&
      [...editions].sort((a, b) => Number(b.year ?? 0) - Number(a.year ?? 0))[0]?.estimated ===
        true);
  return {
    research_fit: {
      score: researchFitScore,
      categories: strings(conference.categories),
      tags: strings(conference.tags),
    },
    venue_maturity: {
      status: maturityStatus(maturity),
      profile_status: maturity.profileCoverage > 0 ? "profiled" : "unprofiled",
      evidence: maturity,
    },
    deadline_precision: hasExact
      ? "exact"
      : hasDateOnly
        ? "date-only"
        : hasEstimated
          ? "estimated"
          : "none",
    deadline_trust: trust,
    evidence_quality: evidenceQuality(trust),
  };
}
