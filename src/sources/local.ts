/**
 * Local source: manual and generated curated data, with extra.yaml as a legacy fallback.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import {
  asDate,
  type CategoryAssignment,
  type Conference,
  callIdentityOf,
  type Deadline,
  type DeadlineKind,
  deadlineEvidence,
  type Edition,
  editionIdentityOf,
  embeddedTimezone,
  eventDatePrecisionOf,
  fmtDate,
  kindOf,
  parseDateRange,
  parseInstant,
  promotionRefOf,
  refineKindWithLabel,
  roundOf,
  slug,
  supersededDeadlinesOf,
  venueIdentityOf,
  warn,
} from "../model.ts";

export const NAME = "local";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_PATH = join(ROOT, "data", "extra.yaml");

export function localSourcePaths(root = ROOT): string[] {
  const manual = join(root, "data", "manual.yaml");
  const curated = join(root, "data", "curated.generated.yaml");
  const canonical = [manual, curated].filter((path) => existsSync(path));
  return canonical.length > 0 ? canonical : [join(root, "data", "extra.yaml")];
}

const LEGACY_KIND_KEYS: Array<[DeadlineKind, string, string[]]> = [
  ["abstract", "Abstract submission", ["abstract_deadline", "abstract"]],
  [
    "paper",
    "Paper submission",
    ["deadline", "paper_deadline", "submission_deadline", "submission"],
  ],
  ["notification", "Notification", ["notification_deadline", "notification"]],
  [
    "camera_ready",
    "Camera-ready",
    ["camera_ready_deadline", "camera_ready", "final_deadline", "final_paper", "final_submission"],
  ],
  ["rebuttal_start", "Rebuttal start", ["rebuttal_start", "rebuttal_start_deadline"]],
  ["rebuttal_end", "Rebuttal end", ["rebuttal_end", "rebuttal_deadline", "rebuttal_end_deadline"]],
  ["registration", "Registration", ["registration_deadline", "registration"]],
];

export function deadlinesOf(raw: Record<string, unknown> | null | undefined): Deadline[] {
  if (!raw || typeof raw !== "object") return [];
  const out: Deadline[] = [];
  const sourceUrl = String(raw.source_url ?? raw.sourceUrl ?? raw.link ?? "");
  const parentTz = String(raw.tz ?? raw.timezone ?? "");
  const entries = raw.deadlines;
  if (entries !== undefined && entries !== null && !Array.isArray(entries))
    throw new TypeError("local deadlines must be an array");
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const tzRaw = String(rec.tz ?? rec.timezone ?? parentTz);
    const kind = refineKindWithLabel(
      kindOf(String(rec.kind ?? rec.type ?? "")),
      String(rec.label ?? ""),
      String(rec.kind ?? rec.type ?? ""),
    );
    const label = String(rec.label ?? kind);
    const superseded = supersededDeadlinesOf(rec.superseded_deadlines);
    const promotionRef = promotionRefOf(rec.promotion_ref ?? rec.promotionRef);
    const track = String(rec.track ?? "").trim();
    if (rec.precision === "date-only") {
      const localDate = asDate(rec.date);
      if (localDate === null || tzRaw.trim()) {
        warn(`date-only deadline requires YYYY-MM-DD without timezone: ${String(rec.date ?? "")}`);
        continue;
      }
      out.push({
        kind,
        label,
        precision: "date-only",
        local_date: fmtDate(localDate),
        round: roundOf(label, Number(rec.round ?? 1) || 1),
        ...(track ? { track: slug(track) } : {}),
        comment: rec.comment === null || rec.comment === undefined ? null : String(rec.comment),
        raw_value: String(rec.date),
        evidence: deadlineEvidence(rec.evidence ?? raw.evidence, {
          sourceName: NAME,
          sourceClass: "curated-manual",
          sourceUrl,
          originalValue: String(rec.date),
        }),
        ...(superseded.length ? { superseded_deadlines: superseded } : {}),
        ...(promotionRef ? { promotion_ref: promotionRef } : {}),
      });
      continue;
    }
    const at = parseInstant(rec.date, tzRaw);
    if (at === null) continue;
    out.push({
      kind,
      label,
      at_utc: at,
      tz_raw: embeddedTimezone(rec.date) ?? tzRaw,
      // A round named in the label wins over the explicit field.
      round: roundOf(label, Number(rec.round ?? 1) || 1),
      ...(track ? { track: slug(track) } : {}),
      comment: rec.comment === null || rec.comment === undefined ? null : String(rec.comment),
      raw_value: String(rec.date),
      evidence: deadlineEvidence(rec.evidence ?? raw.evidence, {
        sourceName: NAME,
        sourceClass: "curated-manual",
        sourceUrl,
        originalValue: String(rec.date),
      }),
      ...(superseded.length ? { superseded_deadlines: superseded } : {}),
      ...(promotionRef ? { promotion_ref: promotionRef } : {}),
    });
  }
  if (out.length === 0) {
    for (const [kind, label, keys] of LEGACY_KIND_KEYS) {
      for (const key of keys) {
        const val = raw[key];
        if (typeof val === "string" && val.trim()) {
          const at = parseInstant(val, parentTz);
          if (at !== null) {
            out.push({
              kind,
              label,
              at_utc: at,
              tz_raw: embeddedTimezone(val) ?? parentTz,
              round: roundOf(label, 1),
              comment: null,
              raw_value: String(val),
              evidence: deadlineEvidence(raw.evidence, {
                sourceName: NAME,
                sourceClass: "curated-manual",
                sourceUrl,
                originalValue: String(val),
              }),
              ...(supersededDeadlinesOf(raw.superseded_deadlines).length
                ? { superseded_deadlines: supersededDeadlinesOf(raw.superseded_deadlines) }
                : {}),
              ...(promotionRefOf(raw.promotion_ref ?? raw.promotionRef)
                ? { promotion_ref: promotionRefOf(raw.promotion_ref ?? raw.promotionRef) }
                : {}),
            });
          }
          break;
        }
      }
    }
  }
  return out;
}

/**
 * パッチの deadlines フィールドを「受理行 / 棄却行」に分解して意味論を返す
 * parseInstant は timezone 欠落・曖昧で null を返し、
 * deadlinesOf はその行を静かにスキップする。
 * deadlines キーだけで配列を丸ごと置換すると、全行棄却のパッチが既存確定値を空配列で潰す。
 *
 *   deadline フィールド無し            → keepExisting (メタデータのみパッチ)
 *   deadline フィールド有・受理 >= 1   → replace (受理行のみ)
 *   deadline フィールド有・受理 = 0    → keepExisting + 警告 (棄却行は観測として隔離)
 *   clear_deadlines: true             → clear (明示的な空配列。既定 false)
 */
export interface PatchDeadlineSemantics {
  action: "keep-existing" | "replace" | "clear";
  accepted: Deadline[];
  rejectedCount: number;
}

const DEADLINE_FIELD_PRESENT_KEYS = [
  "deadlines",
  "deadline",
  "paper_deadline",
  "abstract_deadline",
];

export function patchDeadlineSemantics(
  patch: Record<string, unknown> | null | undefined,
): PatchDeadlineSemantics {
  if (!patch || typeof patch !== "object") {
    return { action: "keep-existing", accepted: [], rejectedCount: 0 };
  }
  if (patch.clear_deadlines === true) {
    return { action: "clear", accepted: [], rejectedCount: 0 };
  }
  const hasDeadlineField = DEADLINE_FIELD_PRESENT_KEYS.some((k) => k in patch);
  if (!hasDeadlineField) {
    return { action: "keep-existing", accepted: [], rejectedCount: 0 };
  }
  const accepted = deadlinesOf(patch);
  const declared = Array.isArray(patch.deadlines)
    ? patch.deadlines.length
    : accepted.length === 0
      ? 1
      : 0;
  const rejectedCount = Math.max(0, declared - accepted.length);
  if (accepted.length > 0) {
    return { action: "replace", accepted, rejectedCount };
  }
  warn(
    `patch has deadline fields but every row was rejected ` +
      `(${rejectedCount} unresolvable) — keeping existing deadlines`,
  );
  return { action: "keep-existing", accepted: [], rejectedCount };
}

export function editionOf(
  raw: Record<string, unknown> | null | undefined,
  key: string,
): Edition | null {
  if (!raw || typeof raw !== "object") return null;
  const year = Number(raw.year);
  if (!Number.isInteger(year) || year <= 0) {
    warn(`local edition without a usable year under ${JSON.stringify(key)}`);
    return null;
  }
  const dateText = String(raw.date_text ?? raw.date ?? "");
  let start = asDate(raw.event_start ?? raw.start);
  let end = asDate(raw.event_end ?? raw.end);
  if (start === null || end === null) {
    const [parsedStart, parsedEnd] = parseDateRange(dateText, year);
    start = start ?? parsedStart;
    end = end ?? parsedEnd;
  }
  const editionId = String(raw.id ?? `${key}${String(year % 100).padStart(2, "0")}`);
  const link = String(raw.link ?? "");
  const callIdentity = callIdentityOf(raw.call_identity ?? raw.callIdentity);
  const legacyIds = toStringArray(raw.legacy_ids ?? raw.legacyIds);
  const declaredIdentity = editionIdentityOf(raw.identity);
  return {
    year,
    edition_id: editionId,
    link,
    place: String(raw.place ?? ""),
    date_text: dateText,
    event_date_precision: eventDatePrecisionOf(raw.event_date_precision, dateText, start, end),
    event_start: start,
    event_end: end,
    deadlines: deadlinesOf(raw),
    estimated: Boolean(raw.estimated),
    source: NAME,
    identity: {
      ...declaredIdentity,
      ...(declaredIdentity?.officialUrls?.length ? {} : link ? { officialUrls: [link] } : {}),
      sourceIds: { ...declaredIdentity?.sourceIds, [NAME]: editionId },
    },
    ...(callIdentity ? { call_identity: callIdentity } : {}),
    ...(legacyIds.length ? { legacy_ids: legacyIds } : {}),
  };
}

import { toStringArray } from "../util.ts";

/** Parse an extra.yaml file into conferences. */
export function parseFile(path: string | null | undefined): Conference[] {
  if (!path) return [];
  let loaded: unknown;
  try {
    loaded = loadYaml(readFileSync(path, "utf8"));
  } catch (exc) {
    warn(`local: cannot parse ${path}: ${String(exc)}`);
    if (existsSync(path)) throw new Error(`local: cannot parse ${path}: ${String(exc)}`);
    return [];
  }
  if (
    typeof loaded !== "object" ||
    loaded === null ||
    !Array.isArray((loaded as Record<string, unknown>).conferences)
  ) {
    throw new TypeError(`local source ${path}: conferences must be an array`);
  }
  const conferences = (loaded as Record<string, unknown>).conferences as unknown[];
  const out: Conference[] = [];
  for (const [index, item] of conferences.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new TypeError(`local source ${path}: conference entry ${index} must be an object`);
    }
    const raw = item as Record<string, unknown>;
    const title = String(raw.title ?? "").trim();
    const key = String(raw.key ?? slug(title)).trim();
    if (!key) {
      throw new TypeError(`local source ${path}: conference entry ${index} needs key or title`);
    }
    const rawEditions = raw.editions;
    if (rawEditions !== undefined && rawEditions !== null && !Array.isArray(rawEditions)) {
      throw new TypeError(`local source ${path}: conference ${key} editions must be an array`);
    }
    const editions = (Array.isArray(rawEditions) ? rawEditions : [])
      .map((e, editionIndex) => {
        if (typeof e !== "object" || e === null || Array.isArray(e)) {
          throw new TypeError(
            `local source ${path}: conference ${key} edition ${editionIndex} must be an object`,
          );
        }
        const edition = editionOf(e as Record<string, unknown>, key);
        if (edition === null) {
          throw new TypeError(
            `local source ${path}: conference ${key} edition ${editionIndex} has no usable year`,
          );
        }
        return edition;
      })
      .sort((a, b) => a.year - b.year);
    const rank: Record<string, string> = {};
    for (const [k, v] of Object.entries((raw.rank as Record<string, unknown> | null) ?? {})) {
      if (v !== null && v !== undefined && String(v).trim() !== "" && String(v).trim() !== "null") {
        rank[String(k).toLowerCase().trim()] = String(v).trim();
      }
    }
    let link = String(raw.link ?? "").trim();
    if (!link) {
      for (const edition of [...editions].reverse()) {
        if (edition.link) {
          link = edition.link;
          break;
        }
      }
    }
    const categoryAssignments: CategoryAssignment[] = Array.isArray(raw.category_assignments)
      ? raw.category_assignments
          .filter((item): item is Record<string, unknown> =>
            Boolean(item && typeof item === "object"),
          )
          .flatMap((item) => {
            const category = String(item.category ?? "").trim();
            const reason = String(item.reason ?? "");
            return category &&
              ["source-subfield", "explicit-venue-rule", "manual-review", "name-keyword"].includes(
                reason,
              )
              ? [
                  {
                    category,
                    reason: reason as CategoryAssignment["reason"],
                    ...(typeof item.evidence === "string" && item.evidence.trim()
                      ? { evidence: item.evidence.trim() }
                      : {}),
                  },
                ]
              : [];
          })
      : [];
    const declaredIdentity = venueIdentityOf(raw.identity);
    out.push({
      key,
      title: title || key,
      full_name: String(raw.full_name ?? "") || title || key,
      acronym: String(raw.acronym ?? (title || key)),
      scope: toStringArray(raw.scope),
      official_scope: toStringArray(raw.official_scope),
      paper_abstracts: toStringArray(raw.paper_abstracts),
      keywords: toStringArray(raw.keywords),
      link,
      rank,
      dblp: raw.dblp === null || raw.dblp === undefined ? null : String(raw.dblp),
      upstream_sub: null,
      tags: toStringArray(raw.tags),
      categories: toStringArray(raw.categories),
      ...(toStringArray(raw.legacy_keys).length
        ? { legacy_keys: toStringArray(raw.legacy_keys) }
        : {}),
      editions,
      sources: [NAME],
      identity: {
        ...declaredIdentity,
        ...(declaredIdentity?.officialDomains?.length
          ? {}
          : link
            ? { officialDomains: [link] }
            : {}),
        sourceIds: { ...declaredIdentity?.sourceIds, [NAME]: key },
      },
      ...(categoryAssignments.length ? { category_assignments: categoryAssignments } : {}),
    });
  }
  return out;
}

export class LocalSource {
  name = NAME;
  readonly paths: string[];
  readonly path: string;

  constructor(path: string | string[] = DEFAULT_PATH) {
    this.paths = (Array.isArray(path) ? path : [path]).filter(Boolean);
    this.path = this.paths[0] ?? DEFAULT_PATH;
  }

  async load(): Promise<Conference[]> {
    const byKey = new Map<string, Conference>();
    for (const conference of this.paths.flatMap((path) => parseFile(path))) {
      const existing = byKey.get(conference.key);
      if (!existing) {
        byKey.set(conference.key, conference);
        continue;
      }
      const editionKeys = new Set(
        existing.editions.map((edition) => `${edition.year}\0${edition.edition_id}`),
      );
      const duplicate = conference.editions.find((edition) =>
        editionKeys.has(`${edition.year}\0${edition.edition_id}`),
      );
      if (duplicate)
        throw new Error(`duplicate local edition ${conference.key}/${duplicate.edition_id}`);
      byKey.set(conference.key, {
        ...existing,
        identity: {
          ...conference.identity,
          ...existing.identity,
          officialDomains: [
            ...new Set([
              ...(existing.identity?.officialDomains ?? []),
              ...(conference.identity?.officialDomains ?? []),
            ]),
          ],
          sourceIds: {
            ...conference.identity?.sourceIds,
            ...existing.identity?.sourceIds,
          },
        },
        editions: [...existing.editions, ...conference.editions].sort(
          (left, right) =>
            left.year - right.year || left.edition_id.localeCompare(right.edition_id),
        ),
      });
    }
    return [...byKey.values()];
  }
}
