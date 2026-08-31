/**
 * Local source: conferences the upstreams do not carry (data/extra.yaml).
 * Ported from scripts/sources/local.py.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import {
  asDate,
  type CallIdentity,
  type Conference,
  type Deadline,
  type DeadlineKind,
  type DeadlineOrigin,
  deadlineEvidence,
  type Edition,
  type EditionIdentity,
  type EventDatePrecision,
  embeddedTimezone,
  fmtDate,
  kindOf,
  type PromotionRef,
  parseDateRange,
  parseInstant,
  refineKindWithLabel,
  roundOf,
  type SupersededDeadline,
  slug,
  type VerificationState,
  warn,
} from "../model.ts";

export const NAME = "local";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_PATH = join(ROOT, "data", "extra.yaml");

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

const VERIFICATION_STATUSES = new Set<VerificationState["status"]>([
  "pending",
  "verified",
  "changed",
  "source-unreachable",
  "parser-failed",
  "manual-required",
]);
const EVENT_DATE_PRECISIONS = new Set<EventDatePrecision>([
  "exact-range",
  "single-day",
  "month-only",
  "not-announced",
  "unverified",
]);

function eventDatePrecisionOf(value: unknown): EventDatePrecision | undefined {
  const precision = String(value ?? "").trim();
  return EVENT_DATE_PRECISIONS.has(precision as EventDatePrecision)
    ? (precision as EventDatePrecision)
    : undefined;
}

function verificationOf(value: unknown): VerificationState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const officialUrl = String(raw.official_url ?? raw.officialUrl ?? "").trim();
  const nextCheckAt = String(raw.next_check_at ?? raw.nextCheckAt ?? "").trim();
  const status = String(raw.status ?? "");
  if (
    !officialUrl ||
    !nextCheckAt ||
    !VERIFICATION_STATUSES.has(status as VerificationState["status"])
  ) {
    return undefined;
  }
  const timestamp = (candidate: unknown): string | null => {
    const text = String(candidate ?? "").trim();
    return text || null;
  };
  return {
    official_url: officialUrl,
    last_attempt_at: timestamp(raw.last_attempt_at ?? raw.lastAttemptAt),
    last_verified_at: timestamp(raw.last_verified_at ?? raw.lastVerifiedAt),
    next_check_at: nextCheckAt,
    content_hash:
      typeof raw.content_hash === "string"
        ? raw.content_hash
        : typeof raw.contentHash === "string"
          ? raw.contentHash
          : null,
    status: status as VerificationState["status"],
  };
}

function supersededDeadlinesOf(value: unknown): SupersededDeadline[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => {
      const reason = String(item.reason ?? "");
      return reason === "official-update" || reason === "duplicate-promotion"
        ? {
            value: String(item.value ?? "").trim(),
            source: String(item.source ?? "").trim(),
            status: "superseded" as const,
            supersededBy: String(item.supersededBy ?? item.superseded_by ?? "").trim(),
            reason,
          }
        : null;
    })
    .filter(
      (item): item is SupersededDeadline =>
        item !== null && Boolean(item.value && item.source && item.supersededBy),
    );
}

function promotionRefOf(value: unknown): PromotionRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const batch = String(raw.batch ?? "").trim();
  const resolution = String(raw.resolution ?? "").trim();
  return batch && resolution ? { batch, resolution } : undefined;
}

function callIdentityOf(value: unknown): CallIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const seriesId = String(raw.seriesId ?? raw.series_id ?? "").trim();
  const editionId = String(raw.editionId ?? raw.edition_id ?? "").trim();
  const callId = String(raw.callId ?? raw.call_id ?? "").trim();
  const parentValue = raw.parentEventId ?? raw.parent_event_id ?? null;
  const parentEventId =
    parentValue === null || parentValue === undefined ? null : String(parentValue).trim() || null;
  return seriesId && editionId && callId
    ? { seriesId, editionId, callId, parentEventId }
    : undefined;
}

function editionIdentityOf(value: unknown): EditionIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const editionId = String(raw.editionId ?? raw.edition_id ?? "").trim();
  const officialUrls = toStringArray(raw.officialUrls ?? raw.official_urls);
  const sourceIdsRaw = raw.sourceIds ?? raw.source_ids;
  const sourceIds =
    sourceIdsRaw && typeof sourceIdsRaw === "object" && !Array.isArray(sourceIdsRaw)
      ? Object.fromEntries(
          Object.entries(sourceIdsRaw as Record<string, unknown>)
            .flatMap(([source, value]) => {
              const values = toStringArray(value);
              return values.length ? [[source.trim(), values[0]!] as const] : [];
            })
            .filter(([source]) => source),
        )
      : {};
  const callIdentity = callIdentityOf(raw.callIdentity ?? raw.call_identity);
  return editionId || officialUrls.length || Object.keys(sourceIds).length || callIdentity
    ? {
        ...(editionId ? { editionId } : {}),
        ...(officialUrls.length ? { officialUrls } : {}),
        ...(Object.keys(sourceIds).length ? { sourceIds } : {}),
        ...(callIdentity ? { callIdentity } : {}),
      }
    : undefined;
}

function identityOf(value: unknown): Conference["identity"] {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const venueId = String(raw.venueId ?? raw.venue_id ?? "").trim();
  const dblpKey = String(raw.dblpKey ?? raw.dblp_key ?? "").trim();
  const officialDomains = toStringArray(raw.officialDomains ?? raw.official_domains);
  const aliases = toStringArray(raw.aliases);
  const sourceIdsRaw = raw.sourceIds ?? raw.source_ids;
  const sourceIds =
    sourceIdsRaw && typeof sourceIdsRaw === "object" && !Array.isArray(sourceIdsRaw)
      ? Object.fromEntries(
          Object.entries(sourceIdsRaw as Record<string, unknown>)
            .flatMap(([source, value]) => {
              const values = toStringArray(value);
              return values.length ? [[source.trim(), values[0]!] as const] : [];
            })
            .filter(([source]) => source),
        )
      : {};
  return venueId ||
    dblpKey ||
    officialDomains.length ||
    aliases.length ||
    Object.keys(sourceIds).length
    ? {
        ...(venueId ? { venueId } : {}),
        ...(dblpKey ? { dblpKey } : {}),
        ...(officialDomains.length ? { officialDomains } : {}),
        ...(aliases.length ? { aliases } : {}),
        ...(Object.keys(sourceIds).length ? { sourceIds } : {}),
      }
    : undefined;
}

function originsOf(value: unknown): DeadlineOrigin[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => {
      const freshness = String(item.freshness ?? "");
      return item.source && ["fresh", "cache-fallback", "snapshot-fallback"].includes(freshness)
        ? {
            source: String(item.source),
            ...(typeof item.sourceClass === "string"
              ? { sourceClass: item.sourceClass as DeadlineOrigin["sourceClass"] }
              : {}),
            revision: typeof item.revision === "string" ? item.revision : null,
            fetchedAt: typeof item.fetchedAt === "string" ? item.fetchedAt : null,
            freshness: freshness as DeadlineOrigin["freshness"],
          }
        : null;
    })
    .filter((item): item is DeadlineOrigin => item !== null);
}

export function deadlinesOf(raw: Record<string, unknown> | null | undefined): Deadline[] {
  if (!raw || typeof raw !== "object") return [];
  const out: Deadline[] = [];
  const sourceUrl = String(raw.source_url ?? raw.sourceUrl ?? raw.link ?? "");
  const parentTz = String(raw.tz ?? raw.timezone ?? "");
  for (const entry of (raw.deadlines as unknown[] | null) ?? []) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const tzRaw = String(rec.tz ?? rec.timezone ?? parentTz);
    const kind = refineKindWithLabel(
      kindOf(String(rec.kind ?? rec.type ?? "")),
      String(rec.label ?? ""),
      String(rec.kind ?? rec.type ?? ""),
    );
    const label = String(rec.label ?? kind);
    const track = String(rec.track ?? "").trim();
    if (rec.precision === "date-only") {
      const localDate = asDate(rec.date);
      if (localDate === null || tzRaw.trim()) {
        warn(`date-only deadline requires YYYY-MM-DD without timezone: ${String(rec.date ?? "")}`);
        continue;
      }
      const verification = verificationOf(rec.verification ?? raw.verification);
      const supersededDeadlines = supersededDeadlinesOf(
        rec.superseded_deadlines ?? rec.supersededDeadlines ?? raw.superseded_deadlines,
      );
      const promotionRef = promotionRefOf(
        rec.promotion_ref ?? rec.promotionRef ?? raw.promotion_ref,
      );
      const origins = originsOf(rec.origins ?? raw.origins);
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
        ...(origins.length ? { origins } : {}),
        ...(supersededDeadlines.length ? { superseded_deadlines: supersededDeadlines } : {}),
        ...(promotionRef ? { promotion_ref: promotionRef } : {}),
        ...(verification ? { verification } : {}),
      });
      continue;
    }
    const at = parseInstant(rec.date, tzRaw);
    if (at === null) continue;
    const verification = verificationOf(rec.verification ?? raw.verification);
    const supersededDeadlines = supersededDeadlinesOf(
      rec.superseded_deadlines ?? rec.supersededDeadlines ?? raw.superseded_deadlines,
    );
    const promotionRef = promotionRefOf(rec.promotion_ref ?? rec.promotionRef ?? raw.promotion_ref);
    const origins = originsOf(rec.origins ?? raw.origins);
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
      ...(origins.length ? { origins } : {}),
      ...(supersededDeadlines.length ? { superseded_deadlines: supersededDeadlines } : {}),
      ...(promotionRef ? { promotion_ref: promotionRef } : {}),
      ...(verification ? { verification } : {}),
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
  const providedIdentity = editionIdentityOf(raw.identity);
  const callIdentity = callIdentityOf(raw.call_identity ?? raw.callIdentity);
  const sourceIds = providedIdentity?.sourceIds ?? {};
  const identity = {
    ...(providedIdentity ?? {}),
    ...(link && !providedIdentity?.officialUrls?.length ? { officialUrls: [link] } : {}),
    sourceIds: { ...sourceIds, [NAME]: sourceIds[NAME] ?? editionId },
    ...(callIdentity ? { callIdentity } : {}),
  };
  const eventDatePrecision = eventDatePrecisionOf(
    raw.event_date_precision ?? raw.eventDatePrecision,
  );
  return {
    year,
    edition_id: editionId,
    link,
    place: String(raw.place ?? ""),
    date_text: dateText,
    event_start: start,
    event_end: end,
    deadlines: deadlinesOf(raw),
    estimated: Boolean(raw.estimated),
    source: NAME,
    ...(Object.keys(identity).length ? { identity } : {}),
    ...(toStringArray(raw.legacy_ids).length ? { legacy_ids: toStringArray(raw.legacy_ids) } : {}),
    ...(eventDatePrecision ? { event_date_precision: eventDatePrecision } : {}),
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
    return [];
  }
  const conferences =
    typeof loaded === "object" && loaded !== null
      ? (((loaded as Record<string, unknown>).conferences as unknown[] | null) ?? [])
      : [];
  const out: Conference[] = [];
  for (const item of conferences) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    const title = String(raw.title ?? "").trim();
    const key = String(raw.key ?? slug(title)).trim();
    if (!key) {
      warn(`local source: entry without key or title in ${path}`);
      continue;
    }
    const editions = ((raw.editions as unknown[] | null) ?? [])
      .map((e) =>
        typeof e === "object" && e !== null ? editionOf(e as Record<string, unknown>, key) : null,
      )
      .filter((e): e is Edition => e !== null)
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
    const configuredIdentity = identityOf(raw.identity);
    const conferenceIdentity = {
      ...(configuredIdentity ?? {}),
      ...(link && !configuredIdentity?.officialDomains?.length ? { officialDomains: [link] } : {}),
      sourceIds: {
        ...(configuredIdentity?.sourceIds ?? {}),
        [NAME]: configuredIdentity?.sourceIds?.[NAME] ?? key,
      },
    };
    out.push({
      key,
      title: title || key,
      full_name: String(raw.full_name ?? "") || title || key,
      link,
      rank,
      dblp: raw.dblp === null || raw.dblp === undefined ? null : String(raw.dblp),
      upstream_sub: null,
      tags: toStringArray(raw.tags),
      categories: toStringArray(raw.categories),
      editions,
      sources: [NAME],
      identity: conferenceIdentity,
      ...(toStringArray(raw.legacy_keys).length
        ? { legacy_keys: toStringArray(raw.legacy_keys) }
        : {}),
      ...(Array.isArray(raw.category_assignments)
        ? { category_assignments: raw.category_assignments as Conference["category_assignments"] }
        : {}),
    });
  }
  return out;
}

export class LocalSource {
  name = NAME;
  readonly path: string;

  constructor(path: string = DEFAULT_PATH) {
    this.path = path;
  }

  async load(): Promise<Conference[]> {
    return parseFile(this.path);
  }
}
