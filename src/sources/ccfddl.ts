/**
 * ccfddl/ccf-deadlines source.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import {
  type Conference,
  type Deadline,
  type DeadlineKind,
  deadlineEvidence,
  type Edition,
  embeddedTimezone,
  eventDatePrecisionOf,
  isNonDateMarker,
  parseDateRange,
  parseInstant,
  refineKindWithLabel,
  slug,
  supersededDeadlinesOf,
  warn,
} from "../model.ts";
import { toStringArray } from "../util.ts";
import { fetchTarball } from "./base.ts";

const REPO = "ccfddl/ccf-deadlines";
const REF = "main";
const NAME = "ccfddl";

function deadlineHistory(value: unknown): Pick<Deadline, "superseded_deadlines"> {
  const items = supersededDeadlinesOf(value);
  return items.length ? { superseded_deadlines: items } : {};
}

// 'abstract deadline' (with a space) exists once upstream.
const ABSTRACT_KEYS = ["abstract_deadline", "abstract deadline", "abstract"];
const PAPER_KEYS = [
  "deadline",
  "paper_deadline",
  "submission_deadline",
  "paper deadline",
  "submission deadline",
];
const NOTIFICATION_KEYS = ["notification_deadline", "notification deadline", "notification"];
const CAMERA_READY_KEYS = [
  "camera_ready_deadline",
  "camera ready deadline",
  "camera_ready",
  "final_deadline",
  "final deadline",
  "final_paper",
  "final paper",
  "final_submission",
  "final submission",
];

/** Return the upstream key name that provided this candidate, or "" when unknown. */
function matchedKey(rec: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (rec[key] !== null && rec[key] !== undefined && String(rec[key]).trim() !== "") {
      return key;
    }
  }
  return "";
}

function extractCandidate(rec: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (rec[key] !== null && rec[key] !== undefined && String(rec[key]).trim() !== "") {
      return rec[key];
    }
  }
  return null;
}

export function deadlinesOf(
  timeline: unknown,
  tzRaw: string,
  rawEdition?: Record<string, unknown>,
): Deadline[] {
  const out: Deadline[] = [];
  const sourceUrl = String(rawEdition?.link ?? "");
  if (timeline !== undefined && timeline !== null && !Array.isArray(timeline))
    throw new TypeError("ccfddl timeline must be an array");
  if (Array.isArray(timeline) && timeline.length > 0) {
    for (const [index, entry] of timeline.entries()) {
      if (typeof entry !== "object" || entry === null)
        throw new TypeError("ccfddl timeline entries must be objects");
      const rec = entry as Record<string, unknown>;
      const rnd = index + 1;
      const entryTz = String(rec.timezone ?? rec.tz ?? tzRaw ?? "");
      const comment =
        rec.comment === null || rec.comment === undefined ? null : String(rec.comment);
      const rawAbstract = extractCandidate(rec, ABSTRACT_KEYS);
      const rawPaper = extractCandidate(rec, PAPER_KEYS);
      const rawNotification = extractCandidate(rec, NOTIFICATION_KEYS);
      const rawCameraReady = extractCandidate(rec, CAMERA_READY_KEYS);
      const candidates: Array<[DeadlineKind, string, unknown, string]> = [
        ["abstract", "Abstract submission", rawAbstract, "abstract"],
        ["paper", "Paper submission", rawPaper, matchedKey(rec, PAPER_KEYS)],
        ["notification", "Notification", rawNotification, "notification"],
        ["camera_ready", "Camera-ready", rawCameraReady, "camera_ready"],
      ];
      for (const [kind, label, raw, keyName] of candidates) {
        if (raw === null || raw === undefined) continue;
        const at = parseInstant(raw, entryTz);
        if (
          at === null &&
          !isNonDateMarker(raw) &&
          (entryTz.trim() !== "" || embeddedTimezone(String(raw)) !== null)
        )
          throw new TypeError(`ccfddl deadline is not parseable: ${String(raw)}`);
        if (at === null) continue;
        // ccfddl の timeline entry は comment にトラック名 (Posters Track 等) を
        // 持つ。
        // 汎用キー由来の kind を label/comment 語彙で精緻化する。
        out.push({
          kind: refineKindWithLabel(kind, [comment, label].filter(Boolean).join(" · "), keyName),
          label,
          at_utc: at,
          tz_raw: embeddedTimezone(raw) ?? entryTz,
          round: rnd,
          comment,
          raw_value: String(raw),
          evidence: deadlineEvidence(rec.evidence ?? rawEdition?.evidence, {
            sourceName: NAME,
            sourceClass: "aggregator",
            sourceUrl,
            originalValue: String(raw),
          }),
          ...deadlineHistory(rec.superseded_deadlines ?? rawEdition?.superseded_deadlines),
        });
      }
    }
    if (out.length > 0) return out;
  }

  // Fallback to top-level rawEdition properties if timeline is absent or yielded no deadlines
  if (rawEdition && typeof rawEdition === "object") {
    const entryTz = String(rawEdition.timezone ?? rawEdition.tz ?? tzRaw ?? "");
    const comment =
      rawEdition.comment === null || rawEdition.comment === undefined
        ? null
        : String(rawEdition.comment);
    const rawAbstract = extractCandidate(rawEdition, ABSTRACT_KEYS);
    const rawPaper = extractCandidate(rawEdition, PAPER_KEYS);
    const rawNotification = extractCandidate(rawEdition, NOTIFICATION_KEYS);
    const rawCameraReady = extractCandidate(rawEdition, CAMERA_READY_KEYS);
    const candidates: Array<[DeadlineKind, string, unknown, string]> = [
      ["abstract", "Abstract submission", rawAbstract, "abstract"],
      ["paper", "Paper submission", rawPaper, matchedKey(rawEdition ?? {}, PAPER_KEYS)],
      ["notification", "Notification", rawNotification, "notification"],
      ["camera_ready", "Camera-ready", rawCameraReady, "camera_ready"],
    ];
    for (const [kind, label, raw, keyName] of candidates) {
      if (raw === null || raw === undefined) continue;
      const at = parseInstant(raw, entryTz);
      if (
        at === null &&
        !isNonDateMarker(raw) &&
        (entryTz.trim() !== "" || embeddedTimezone(String(raw)) !== null)
      )
        throw new TypeError(`ccfddl deadline is not parseable: ${String(raw)}`);
      if (at === null) continue;
      out.push({
        kind: refineKindWithLabel(kind, [comment, label].filter(Boolean).join(" · "), keyName),
        label,
        at_utc: at,
        tz_raw: embeddedTimezone(raw) ?? entryTz,
        round: 1,
        comment,
        raw_value: String(raw),
        evidence: deadlineEvidence(rawEdition.evidence, {
          sourceName: NAME,
          sourceClass: "aggregator",
          sourceUrl,
          originalValue: String(raw),
        }),
        ...deadlineHistory(rawEdition.superseded_deadlines),
      });
    }
  }

  return out;
}

export function editionOf(
  raw: Record<string, unknown> | null | undefined,
  parentTz = "",
  sourceId = "",
): Edition | null {
  if (!raw || typeof raw !== "object") return null;
  const year = Number(raw.year);
  if (!Number.isInteger(year) || year <= 0) {
    warn(`ccfddl edition without a usable year: ${JSON.stringify(raw.id)}`);
    return null;
  }
  const tzRaw = String(raw.timezone ?? raw.tz ?? parentTz ?? "");
  const dateText = String(raw.date ?? "");
  const [start, end] = parseDateRange(dateText, year);
  const upstreamId = String(raw.id ?? "").trim() || (sourceId ? `${sourceId}:${year}` : "");
  const link = String(raw.link ?? "");
  return {
    year,
    edition_id: String(raw.id ?? (year ? String(year) : "")),
    link,
    place: String(raw.place ?? ""),
    date_text: dateText,
    event_date_precision: eventDatePrecisionOf(raw.event_date_precision, dateText, start, end),
    event_start: start,
    event_end: end,
    deadlines: deadlinesOf(raw.timeline, tzRaw, raw),
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

export function conferenceOf(
  raw: Record<string, unknown> | null | undefined,
  sourceId = "",
): Conference | null {
  if (!raw || typeof raw !== "object") return null;
  const title = String(raw.title ?? "").trim();
  if (!title) return null;
  const parentTz = String(raw.timezone ?? raw.tz ?? "");
  const venueSourceId = sourceId || String(raw.dblp ?? "").trim();
  const rawConfs = raw.confs;
  if (rawConfs !== undefined && rawConfs !== null && !Array.isArray(rawConfs))
    throw new TypeError("ccfddl confs must be an array");
  const editions = (Array.isArray(rawConfs) ? rawConfs : [])
    .map((c) => {
      if (typeof c !== "object" || c === null)
        throw new TypeError("ccfddl conference editions must be objects");
      return editionOf(c as Record<string, unknown>, parentTz, venueSourceId);
    })
    .filter((e): e is Edition => e !== null)
    .sort((a, b) => a.year - b.year);
  const rank: Record<string, string> = {};
  for (const [k, v] of Object.entries((raw.rank as Record<string, unknown> | null) ?? {})) {
    if (v !== null && v !== undefined && String(v).trim() !== "" && String(v).trim() !== "null") {
      rank[String(k).toLowerCase().trim()] = String(v).trim();
    }
  }
  let link = "";
  for (const edition of [...editions].reverse()) {
    if (edition.link) {
      link = edition.link;
      break;
    }
  }
  if (!link && raw.link) {
    link = String(raw.link);
  }
  const dblp = raw.dblp === null || raw.dblp === undefined ? "" : String(raw.dblp).trim();
  return {
    key: slug(title),
    title,
    full_name: String(raw.description ?? raw.full_name ?? title),
    acronym: String(raw.acronym ?? title),
    scope: toStringArray(raw.scope),
    official_scope: toStringArray(raw.official_scope),
    paper_abstracts: toStringArray(raw.paper_abstracts),
    keywords: toStringArray(raw.keywords),
    link,
    rank,
    dblp: dblp || null,
    upstream_sub: raw.sub === null || raw.sub === undefined ? null : String(raw.sub),
    tags: [],
    categories: [],
    editions,
    sources: [NAME],
    ...(dblp || venueSourceId
      ? {
          identity: {
            ...(dblp ? { dblpKey: dblp } : {}),
            ...(link ? { officialDomains: [link] } : {}),
            ...(venueSourceId ? { sourceIds: { [NAME]: venueSourceId } } : {}),
          },
        }
      : {}),
  };
}

/** Read every `conference/<SUB>/<name>.yml` under an extracted tree. */
export function parseTree(conferenceDir: string | null | undefined): Conference[] {
  if (!conferenceDir) return [];
  const out: Conference[] = [];
  const files: string[] = [];
  const stack = [conferenceDir];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch (error) {
      warn(`ccfddl: cannot read directory ${cur}: ${String(error)}`);
      if (cur === conferenceDir && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`ccfddl: cannot read directory ${cur}: ${String(error)}`);
    }
    for (const name of entries) {
      const p = join(cur, name);
      try {
        if (statSync(p).isDirectory()) {
          stack.push(p);
        } else if (
          (name.endsWith(".yml") || name.endsWith(".yaml")) &&
          name !== "types.yml" &&
          name !== "types.yaml"
        ) {
          files.push(p);
        }
      } catch (error) {
        warn(`ccfddl: cannot inspect ${p}: ${String(error)}`);
        throw new Error(`ccfddl: cannot inspect ${p}: ${String(error)}`);
      }
    }
  }
  for (const path of files.sort()) {
    let loaded: unknown;
    try {
      loaded = loadYaml(readFileSync(path, "utf8"));
    } catch (exc) {
      const message = `ccfddl: cannot parse ${path}: ${String(exc)}`;
      warn(message);
      throw new Error(message);
    }
    const items = Array.isArray(loaded) ? loaded : [loaded];
    if (items.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
      throw new TypeError(`ccfddl source ${path}: entries must be objects`);
    }
    for (const item of items) {
      const sourceId = path.slice(conferenceDir.length + 1).replace(/\.ya?ml$/, "");
      // 1 ファイルの構造 drift（例: confs が配列でない）でソース全体を落とさない。
      // その会議だけ skip し、締切消失は health gate の slot 比較が検出する。
      let conference: Conference | null;
      try {
        conference = conferenceOf(item as Record<string, unknown>, sourceId);
      } catch (exc) {
        const message = `ccfddl: cannot map ${path}: ${String(exc)}`;
        warn(message);
        throw new Error(message);
      }
      if (conference !== null) out.push(conference);
    }
  }
  return out;
}

export class CcfddlSource {
  name = NAME;

  async load(
    cacheDir: string,
    options: { offline?: boolean; now?: Date } = {},
  ): Promise<Conference[]> {
    const root = await fetchTarball(REPO, REF, cacheDir, options);
    return parseTree(join(root, "conference"));
  }
}
