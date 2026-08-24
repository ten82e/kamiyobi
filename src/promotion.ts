import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dump as dumpYaml } from "js-yaml";
import { asDate, parseInstant } from "./model.ts";

export type PromotionSourceClass = "official-cfp" | "publisher" | "curated-manual" | "aggregator";

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
}

export interface PromotionResolution {
  candidate: string;
  decision: "promote" | "hold" | "reject";
  verifiedFields: string[];
  reason: string;
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

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}(?::\d{2})?$/;
const TITLE_YEAR = /\b(20\d{2})\b/;

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

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function ordered(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizedEvidence(observation: PromotionObservation): PromotionEvidence {
  const evidence = observation.evidence ?? {};
  return {
    sourceClass: observation.sourceClass,
    sourceUrl: evidence.sourceUrl ?? observation.sourceUrl,
    sourceRevision: evidence.sourceRevision ?? "",
    retrievedAt: evidence.retrievedAt ?? "",
    verifiedAt: evidence.verifiedAt ?? "",
    contentHash: evidence.contentHash ?? "",
    rawExcerpt: evidence.rawExcerpt ?? observation.rawExcerpt,
  };
}

function completeEvidence(evidence: PromotionEvidence): boolean {
  return Object.values(evidence).every((value) => typeof value === "string" && value.trim() !== "");
}

export function resolvePromotion(observation: PromotionObservation): PromotionResolution {
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
  const year = eventStart ? Number(eventStart.slice(0, 4)) : titleYear(observation.title);
  const targetYear = year ?? Number.NaN;
  const namedYear = titleYear(observation.title);
  const deadlineYear = Number(date.slice(0, 4));
  // CFP deadlines are normally in the event year or the preceding calendar year.
  const coherentYears =
    Number.isInteger(targetYear) &&
    (namedYear === null || namedYear === targetYear) &&
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
  if (!official) {
    return {
      candidate: observation.candidate,
      decision: "reject",
      verifiedFields: fields,
      reason: "non-primary evidence",
    };
  }
  if (
    !fields.includes("venue") ||
    !validDeadlineDate ||
    (!exact && !dateOnly) ||
    !eventRange ||
    !coherentYears ||
    !completeEvidence(evidence)
  ) {
    return {
      candidate: observation.candidate,
      decision: "hold",
      verifiedFields: fields,
      reason: "required field or evidence missing",
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
    normalized: {
      venue: {
        key,
        title: observation.title!.trim(),
        categories: ordered(observation.categories),
        tags: ordered(observation.tags),
        review_state: observation.reviewState ?? "reviewed",
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

export function verifyBatch(path: string): PromotionResolution[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => resolvePromotion(JSON.parse(line) as PromotionObservation))
    .sort((a, b) => a.candidate.localeCompare(b.candidate));
}

function extraFrom(resolutions: PromotionResolution[]): Record<string, unknown> {
  return {
    conferences: resolutions
      .filter((resolution) => resolution.decision === "promote" && resolution.normalized)
      .map((resolution) => {
        const normalized = resolution.normalized!;
        return {
          key: normalized.venue.key,
          title: normalized.venue.title,
          categories: normalized.venue.categories,
          tags: normalized.venue.tags,
          review_state: normalized.venue.review_state,
          link: (normalized.deadline.evidence as Array<{ sourceUrl: string }>)[0]!.sourceUrl,
          editions: [
            {
              ...normalized.edition,
              id: normalized.edition.edition_id,
              deadlines: [normalized.deadline],
            },
          ],
        };
      }),
  };
}

export function writePromotionBatch(
  observationsPath: string,
  resolutionsPath: string,
  manifestPath: string,
): PromotionResolution[] {
  const observations = readFileSync(observationsPath, "utf8");
  const resolutions = verifyBatch(observationsPath);
  const resolutionText = `${JSON.stringify(resolutions, null, 2)}\n`;
  const extraText = dumpYaml(extraFrom(resolutions), { noRefs: true, sortKeys: true });
  writeFileSync(resolutionsPath, resolutionText);
  writeFileSync(join(dirname(manifestPath), "extra.yaml"), extraText);
  const manifest = {
    schema: 1,
    observations: { sha256: createHash("sha256").update(observations).digest("hex") },
    resolutions: { sha256: createHash("sha256").update(resolutionText).digest("hex") },
    extra: { sha256: createHash("sha256").update(extraText).digest("hex") },
    decisions: Object.fromEntries(resolutions.map((item) => [item.candidate, item.decision])),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return resolutions;
}
