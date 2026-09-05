/**
 * huggingface/ai-deadlines source.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import {
  asDate,
  type Conference,
  type Deadline,
  type DeadlineKind,
  deadlineEvidence,
  type Edition,
  embeddedTimezone,
  eventDatePrecisionOf,
  isNonDateMarker,
  kindOf,
  parseDateRange,
  parseInstant,
  refineKindWithLabel,
  roundOf,
  slug,
  supersededDeadlinesOf,
  warn,
} from "../model.ts";
import { fetchTarball } from "./base.ts";

const REPO = "huggingface/ai-deadlines";
const REF = "main";
const NAME = "aideadlines";

function deadlineHistory(value: unknown): Pick<Deadline, "superseded_deadlines"> {
  const items = supersededDeadlinesOf(value);
  return items.length ? { superseded_deadlines: items } : {};
}

// Old-format editions carry the deadlines at the top level.
const LEGACY: Array<[DeadlineKind, string, string]> = [
  ["abstract", "Abstract submission", "abstract_deadline"],
  ["paper", "Paper submission", "deadline"],
  ["paper", "Paper submission", "paper_deadline"],
  ["notification", "Notification", "notification_deadline"],
  ["notification", "Notification", "notification"],
  ["camera_ready", "Camera-ready submission", "camera_ready_deadline"],
  ["camera_ready", "Camera-ready submission", "camera_ready"],
];

/** Rewrite a lone previous-year token in free text to the edition year. */
function liftStaleYear(dateText: string, year: number): string {
  const found = [...dateText.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  if (found.length > 0 && found.every((y) => y === year - 1)) {
    return dateText.replace(new RegExp(`\\b${year - 1}\\b`, "g"), String(year));
  }
  return dateText;
}

/** 'CCF: A, CORE: A*, THCPL: A' or { ccf: 'A', core: 'A*' } -> {ccf: 'A', core: 'A*', ...}. */
export function rankOf(rankings: unknown): Record<string, string> {
  const rank: Record<string, string> = {};
  if (!rankings) return rank;

  if (typeof rankings === "object") {
    if (Array.isArray(rankings)) {
      for (const item of rankings) {
        if (typeof item === "string") {
          const idx = item.indexOf(":");
          if (idx >= 0) {
            const name = item.slice(0, idx).trim().toLowerCase();
            const value = item.slice(idx + 1).trim();
            if (name && value && value !== "null") rank[name] = value;
          }
        } else if (typeof item === "object" && item !== null) {
          for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
            if (
              v !== null &&
              v !== undefined &&
              String(v).trim() !== "" &&
              String(v).trim() !== "null"
            ) {
              rank[k.toLowerCase().trim()] = String(v).trim();
            }
          }
        }
      }
      return rank;
    }
    for (const [k, v] of Object.entries(rankings as Record<string, unknown>)) {
      if (v !== null && v !== undefined && String(v).trim() !== "" && String(v).trim() !== "null") {
        rank[k.toLowerCase().trim()] = String(v).trim();
      }
    }
    return rank;
  }

  for (const chunk of String(rankings).split(",")) {
    const idx = chunk.indexOf(":");
    if (idx >= 0) {
      const name = chunk.slice(0, idx).trim().toLowerCase();
      const value = chunk.slice(idx + 1).trim();
      if (name && value && value !== "null") rank[name] = value;
    }
  }
  return rank;
}

export function deadlinesOf(raw: Record<string, unknown> | null | undefined): Deadline[] {
  if (!raw || typeof raw !== "object") return [];
  const out: Deadline[] = [];
  const parentTz = String(raw.timezone ?? raw.tz ?? "");
  const sourceUrl = String(raw.link ?? raw.url ?? "");
  const entries = raw.deadlines;
  if (entries !== undefined && entries !== null && !Array.isArray(entries))
    throw new TypeError("aideadlines deadlines must be an array");
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null)
        throw new TypeError("aideadlines deadline entries must be objects");
      const rec = entry as Record<string, unknown>;
      const tzRaw = String(rec.timezone ?? rec.tz ?? parentTz);
      const at = parseInstant(rec.date, tzRaw);
      if (
        at === null &&
        !isNonDateMarker(rec.date) &&
        (tzRaw.trim() !== "" || embeddedTimezone(String(rec.date)) !== null)
      )
        throw new TypeError(`aideadlines deadline is not parseable: ${String(rec.date)}`);
      if (at === null) continue;
      const rawType = String(rec.type ?? rec.kind ?? "");
      const label = String(rec.label ?? rawType);
      out.push({
        kind: refineKindWithLabel(kindOf(rawType), label, rawType),
        label,
        at_utc: at,
        tz_raw: embeddedTimezone(rec.date) ?? tzRaw,
        // This schema has no round field; the label is the only place a round
        // is ever stated (SPEC.md 3.3).
        round: roundOf(label),
        comment: rec.comment === null || rec.comment === undefined ? null : String(rec.comment),
        raw_value: String(rec.date),
        evidence: deadlineEvidence(rec.evidence ?? raw.evidence, {
          sourceName: NAME,
          sourceClass: "aggregator",
          sourceUrl,
          originalValue: String(rec.date),
        }),
        ...deadlineHistory(rec.superseded_deadlines ?? raw.superseded_deadlines),
      });
    }
    if (out.length > 0) return out;
  }

  for (const [kind, label, key] of LEGACY) {
    const at = parseInstant(raw[key], parentTz);
    if (
      at === null &&
      raw[key] !== undefined &&
      raw[key] !== null &&
      !isNonDateMarker(raw[key]) &&
      (parentTz.trim() !== "" || embeddedTimezone(String(raw[key])) !== null)
    )
      throw new TypeError(`aideadlines deadline is not parseable: ${String(raw[key])}`);
    if (at !== null) {
      out.push({
        kind,
        label,
        at_utc: at,
        tz_raw: embeddedTimezone(raw[key]) ?? parentTz,
        round: 1,
        comment: null,
        raw_value: String(raw[key]),
        evidence: deadlineEvidence(raw.evidence, {
          sourceName: NAME,
          sourceClass: "aggregator",
          sourceUrl,
          originalValue: String(raw[key]),
        }),
        ...deadlineHistory(raw.superseded_deadlines),
      });
    }
  }
  return out;
}

export function editionOf(
  raw: Record<string, unknown> | null | undefined,
  sourceId = "",
): Edition | null {
  if (!raw || typeof raw !== "object") return null;
  const year = Number(raw.year);
  if (!Number.isInteger(year) || year <= 0) {
    warn(`aideadlines edition without a usable year: ${JSON.stringify(raw.id)}`);
    return null;
  }
  const dateText = liftStaleYear(String(raw.date ?? ""), year);
  let start = asDate(raw.start);
  let end = asDate(raw.end);
  const [parsedStart, parsedEnd] = parseDateRange(dateText, year);
  // Structured start/end is sometimes a full year off while the free-text
  // date names the edition year (ICASSP 2026: start 2025-05-04, date May 2026).
  if (
    parsedStart !== null &&
    parsedEnd !== null &&
    parsedStart.getUTCFullYear() === year &&
    (start === null || end === null || start.getUTCFullYear() !== year)
  ) {
    start = parsedStart;
    end = parsedEnd;
  } else {
    start = start ?? parsedStart;
    end = end ?? parsedEnd;
  }
  const rawPlace = raw.place !== null && raw.place !== undefined ? String(raw.place).trim() : "";
  const place =
    rawPlace ||
    ["city", "country"]
      .map((k) => (raw[k] !== null && raw[k] !== undefined ? String(raw[k]).trim() : ""))
      .filter((s) => s.length > 0)
      .join(", ");
  const upstreamId = String(raw.id ?? "").trim() || (sourceId ? `${sourceId}:${year}` : "");
  const link = String(raw.link ?? "");
  return {
    year,
    edition_id: String(raw.id ?? (year ? String(year) : "")),
    link,
    place,
    date_text: dateText,
    event_date_precision: eventDatePrecisionOf(raw.event_date_precision, dateText, start, end),
    event_start: start,
    event_end: end,
    deadlines: deadlinesOf(raw),
    estimated: false,
    source: NAME,
    ...(upstreamId || link
      ? {
          identity: {
            ...(link ? { officialUrls: [link] } : {}),
            ...(upstreamId ? { sourceIds: { [NAME]: upstreamId } } : {}),
          },
        }
      : {}),
  };
}

import { toStringArray } from "../util.ts";

/** Read `src/data/conferences/*.yml`; each item is one edition. */
export function parseTree(conferencesDir: string | null | undefined): Conference[] {
  if (!conferencesDir) return [];
  const byKey = new Map<string, Conference>();
  let fileList: string[];
  try {
    fileList = readdirSync(conferencesDir);
  } catch (error) {
    warn(`aideadlines: cannot read directory ${conferencesDir}: ${String(error)}`);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`aideadlines: cannot read directory ${conferencesDir}: ${String(error)}`);
  }
  for (const path of fileList.filter((n) => n.endsWith(".yml") || n.endsWith(".yaml")).sort()) {
    let loaded: unknown;
    try {
      loaded = loadYaml(readFileSync(join(conferencesDir, path), "utf8"));
    } catch (exc) {
      const message = `aideadlines: cannot parse ${path}: ${String(exc)}`;
      warn(message);
      throw new Error(message);
    }
    const items = Array.isArray(loaded) ? loaded : [loaded];
    if (items.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
      throw new TypeError(`aideadlines source ${path}: entries must be objects`);
    }
    for (const item of items) {
      const raw = item as Record<string, unknown>;
      const title = String(raw.title ?? "").trim();
      if (!title) continue;
      const sourceId = path.replace(/\.ya?ml$/, "");
      const edition = editionOf(raw, sourceId);
      if (edition === null) continue;
      const key = slug(title);
      let conference = byKey.get(key);
      if (conference === undefined) {
        conference = {
          key,
          title,
          full_name: String(raw.full_name ?? title),
          acronym: String(raw.acronym ?? title),
          scope: toStringArray(raw.scope),
          official_scope: toStringArray(raw.official_scope),
          paper_abstracts: toStringArray(raw.paper_abstracts),
          keywords: toStringArray(raw.keywords),
          link: "",
          rank: {},
          dblp: null,
          upstream_sub: null,
          tags: toStringArray(raw.tags),
          categories: [],
          editions: [],
          sources: [NAME],
          identity: { sourceIds: { [NAME]: sourceId } },
        };
        byKey.set(key, conference);
      }
      conference.editions.push(edition);
      // Conference-level facts come from the newest edition seen.
      if (edition.year >= Math.max(...conference.editions.map((e) => e.year))) {
        conference.full_name = String(raw.full_name ?? title);
        conference.acronym = String(raw.acronym ?? title);
        conference.scope = toStringArray(raw.scope);
        conference.official_scope = toStringArray(raw.official_scope);
        conference.paper_abstracts = toStringArray(raw.paper_abstracts);
        conference.keywords = toStringArray(raw.keywords);
        const rank = rankOf(raw.rankings);
        if (Object.keys(rank).length > 0) conference.rank = rank;
        if (edition.link) {
          conference.link = edition.link;
          conference.identity = {
            ...conference.identity,
            officialDomains: [edition.link],
          };
        }
        const tags = toStringArray(raw.tags);
        if (tags.length > 0) conference.tags = tags;
      }
    }
  }
  for (const conference of byKey.values()) {
    conference.editions.sort((a, b) => a.year - b.year);
  }
  return [...byKey.keys()].sort().map((k) => byKey.get(k)!);
}

export class AideadlinesSource {
  name = NAME;

  async load(
    cacheDir: string,
    options: { offline?: boolean; now?: Date } = {},
  ): Promise<Conference[]> {
    const root = await fetchTarball(REPO, REF, cacheDir, options);
    return parseTree(join(root, "src", "data", "conferences"));
  }
}
