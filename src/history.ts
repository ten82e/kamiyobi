import { isDeepStrictEqual } from "node:util";
import { deadlineSlotKey } from "./merge.ts";
import { type Conference, type Deadline, type Edition, eventDatePrecisionOf } from "./model.ts";

export interface HistoryRetention {
  venue: string;
  edition: string;
  year: number;
  action: "edition-restored" | "event-retained" | "deadline-retained" | "identity-bound";
  slot?: string;
  previous?: unknown;
  incoming?: unknown;
}

function unique<T>(matches: T[], context: string): T | undefined {
  if (matches.length > 1) throw new Error(`ambiguous published history identity: ${context}`);
  return matches[0];
}

function venueMatch(current: Conference[], saved: Conference): Conference | undefined {
  const id = saved.identity?.venueId;
  const stable = id ? current.filter((c) => c.identity?.venueId === id) : [];
  if (stable.length) return unique(stable, saved.key);
  const exact = current.filter((c) => c.key === saved.key);
  if (exact.length) return unique(exact, saved.key);
  return unique(
    current.filter(
      (c) =>
        c.key === saved.key ||
        c.legacy_keys?.includes(saved.key) ||
        saved.legacy_keys?.includes(c.key),
    ),
    saved.key,
  );
}

function overridePlaceholder(e: Edition): boolean {
  return e.source === "override" && e.edition_id === `override-${e.year}` && !e.link && !e.identity;
}

function identityMatches(current: Edition, saved: Edition): boolean {
  if (current.year !== saved.year || current.estimated || overridePlaceholder(current))
    return false;
  const ids = new Set([saved.edition_id, saved.identity?.editionId, ...(saved.legacy_ids ?? [])]);
  ids.delete(undefined);
  ids.delete("");
  return [current.edition_id, current.identity?.editionId, ...(current.legacy_ids ?? [])].some(
    (id) => id && ids.has(id),
  );
}

function editionMatch(
  current: Edition[],
  saved: Edition,
  venue: string,
  reserved: Map<Edition, Edition[]>,
): Edition | undefined {
  const sameYear = current.filter(
    (e) => e.year === saved.year && !e.estimated && !overridePlaceholder(e),
  );
  const explicit = sameYear.filter((e) => identityMatches(e, saved));
  if (explicit.length) return unique(explicit, `${venue}/${saved.edition_id}`);
  // A URL is sufficient only inside one venue and year, with one candidate.
  // Shared parent URLs and same-year workshops must never select a first match.
  const urls = new Set([saved.link, ...(saved.identity?.officialUrls ?? [])].filter(Boolean));
  const byUrl = sameYear.filter(
    (e) =>
      !reserved.get(e)?.some((owner) => owner !== saved) &&
      [e.link, ...(e.identity?.officialUrls ?? [])].some((url) => url && urls.has(url)),
  );
  if (byUrl.length) return unique(byUrl, `${venue}/${saved.edition_id}`);
  return undefined;
}

function eventValue(e: Edition): unknown {
  return {
    start: e.event_start?.toISOString() ?? null,
    end: e.event_end?.toISOString() ?? null,
    precision: eventDatePrecisionOf(
      e.event_date_precision,
      e.date_text,
      e.event_start,
      e.event_end,
    ),
    segments: e.event_segments ?? [],
  };
}

function deadlineValue(d: Deadline): unknown {
  return d.precision === "date-only"
    ? { precision: d.precision, date: d.local_date }
    : { precision: "exact", utc: d.at_utc?.toISOString() ?? null };
}

/** Keep previously published, non-estimated upstream history until a reviewed override changes it.
 * Apply reviewed overrides to both inputs first; new editions and new slots remain available.
 */
export function retainPublishedHistory(
  current: Conference[],
  baseline: Conference[],
  now: Date,
): { conferences: Conference[]; retained: HistoryRetention[] } {
  const conferences = structuredClone(current);
  const retained: HistoryRetention[] = [];
  for (const savedConference of baseline) {
    const historical = savedConference.editions.filter(
      (e) => !e.estimated && e.year < now.getUTCFullYear() && e.source !== "local",
    );
    if (!historical.length) continue;
    let target = venueMatch(conferences, savedConference);
    if (!target) {
      target = { ...structuredClone(savedConference), editions: [] };
      conferences.push(target);
    }
    // Reserve explicit ID matches before considering URLs, independent of baseline order.
    // A shared URL must not steal the edition belonging to another published identity.
    const reserved = new Map(
      target.editions.map((edition) => [
        edition,
        historical.filter((saved) => identityMatches(edition, saved)),
      ]),
    );
    const used = new Set<Edition>();
    for (const saved of historical) {
      const context = { venue: target.key, edition: saved.edition_id, year: saved.year };
      let edition = editionMatch(target.editions, saved, target.key, reserved);
      if (!edition) {
        // Year-only reviewed patches can create an empty-identity placeholder when
        // the source omitted that edition. The reviewed published edition replaces it.
        target.editions = target.editions.filter(
          (e) => e.year !== saved.year || !overridePlaceholder(e),
        );
        edition = structuredClone(saved);
        target.editions.push(edition);
        used.add(edition);
        retained.push({ ...context, action: "edition-restored" });
        continue;
      }
      if (used.has(edition))
        throw new Error(
          `many-to-one published history identity: ${target.key}/${edition.edition_id}`,
        );
      used.add(edition);
      const legacyIds = [
        ...new Set([...(edition.legacy_ids ?? []), ...(saved.legacy_ids ?? []), saved.edition_id]),
      ]
        .filter((id) => id !== edition.edition_id)
        .sort();
      if (legacyIds.some((id) => !edition.legacy_ids?.includes(id))) {
        edition.legacy_ids = legacyIds;
        retained.push({ ...context, action: "identity-bound", incoming: edition.edition_id });
      }
      const previous = eventValue(saved);
      const incoming = eventValue(edition);
      if (!isDeepStrictEqual(previous, incoming)) {
        retained.push({ ...context, action: "event-retained", previous, incoming });
        for (const field of [
          "date_text",
          "event_start",
          "event_end",
          "event_date_precision",
          "event_segments",
          "event_review",
        ] as const) {
          Object.assign(edition, { [field]: structuredClone(saved[field]) });
        }
      }
      const savedSlots = new Map<string, Deadline[]>();
      for (const deadline of saved.deadlines) {
        const slot = deadlineSlotKey(deadline);
        savedSlots.set(slot, [...(savedSlots.get(slot) ?? []), deadline]);
      }
      for (const [slot, deadlines] of savedSlots) {
        const matches = edition.deadlines.filter((d) => deadlineSlotKey(d) === slot);
        if (
          deadlines.every((d) =>
            matches.some((m) => isDeepStrictEqual(deadlineValue(m), deadlineValue(d))),
          )
        )
          continue;
        retained.push({
          ...context,
          action: "deadline-retained",
          slot,
          previous: deadlines.map(deadlineValue),
          incoming: matches.map(deadlineValue),
        });
        edition.deadlines = edition.deadlines.filter((d) => deadlineSlotKey(d) !== slot);
        edition.deadlines.push(...structuredClone(deadlines));
      }
    }
  }
  return { conferences, retained };
}
