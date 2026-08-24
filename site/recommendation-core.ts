/** Query-independent recommendation axes shared by build, benchmark, and browser runtime. */

type JsonRecord = Record<string, unknown>;

export interface RecommendationAxes {
  research_fit: { score: number | null; categories: string[]; tags: string[] };
  venue_maturity: { status: "established" | "new"; profile_status: "profiled" | "unprofiled" };
  deadline_precision: "exact" | "date-only" | "estimated" | "none";
  evidence_quality: "official" | "publisher" | "curated-manual" | "aggregator" | "none";
}

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

function deadlineTime(deadline: JsonRecord): number | null {
  const value = deadline.latest_utc ?? deadline.utc ?? deadline.at_utc ?? deadline.local_date;
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? time : null;
}

function deadlineRecords(
  conference: JsonRecord,
  now: number,
): Array<{ deadline: JsonRecord; estimated: boolean }> {
  const editions = records(conference.editions);
  const future = editions
    .flatMap((edition) => records(edition.deadlines).map((deadline) => ({ edition, deadline })))
    .filter(({ deadline }) => (deadlineTime(deadline) ?? Number.NEGATIVE_INFINITY) >= now)
    .sort((a, b) => (deadlineTime(a.deadline) ?? 0) - (deadlineTime(b.deadline) ?? 0));
  const target = future[0]?.edition;
  return target
    ? future
        .filter(({ edition }) => edition === target)
        .map(({ deadline }) => ({ deadline, estimated: Boolean(target.estimated) }))
    : [];
}

function evidenceQuality(
  deadlines: Array<{ deadline: JsonRecord }>,
): RecommendationAxes["evidence_quality"] {
  const classes = deadlines.flatMap(({ deadline }) =>
    records(deadline.evidence).map((evidence) => String(evidence.sourceClass ?? "")),
  );
  if (classes.includes("official-cfp")) return "official";
  if (classes.includes("publisher")) return "publisher";
  if (classes.includes("curated-manual")) return "curated-manual";
  if (classes.includes("aggregator")) return "aggregator";
  return "none";
}

export function recommendationAxes(
  conference: JsonRecord,
  researchFitScore: number | null = null,
  now: number = Date.now(),
): RecommendationAxes {
  const deadlines = deadlineRecords(conference, now);
  const hasExact = deadlines.some(
    ({ deadline }) => deadline.precision !== "date-only" && deadline.utc,
  );
  const hasDateOnly = deadlines.some(({ deadline }) => deadline.precision === "date-only");
  const hasEstimated =
    deadlines.some(({ estimated }) => estimated) ||
    (deadlines.length === 0 &&
      records(conference.editions).sort((a, b) => Number(b.year ?? 0) - Number(a.year ?? 0))[0]
        ?.estimated === true);
  const papers = strings(conference.papers);
  const editions = records(conference.editions);
  return {
    research_fit: {
      score: researchFitScore,
      categories: strings(conference.categories),
      tags: strings(conference.tags),
    },
    venue_maturity: {
      status: papers.length > 0 || editions.length > 1 ? "established" : "new",
      profile_status: papers.length > 0 ? "profiled" : "unprofiled",
    },
    deadline_precision: hasExact
      ? "exact"
      : hasDateOnly
        ? "date-only"
        : hasEstimated
          ? "estimated"
          : "none",
    evidence_quality: evidenceQuality(deadlines),
  };
}
