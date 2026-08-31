/**
 * Name matching, classification, overrides, roll-forward and selection.
 * Ported from scripts/merge.py (kamiyobi).  Consumes the frozen interface
 * of src/model.ts (SPEC.md section 3) only.
 */

import {
  addDays,
  asDate,
  type Conference,
  cmpStr,
  DAY_MS,
  type Deadline,
  type DeadlineEstimate,
  type DeadlineEvidence,
  dateOnly,
  dateOnlyState,
  dateOnlyWindow,
  deadlineTrackKey,
  type Edition,
  type EditionIdentity,
  type ExactDeadline,
  fmtDate,
  isDateOnlyDeadline,
  isExactDeadline,
  KINDS,
  parseDateRange,
  slug,
  type VenueIdentity,
  warn,
} from "./model.ts";
import { patchDeadlineSemantics } from "./sources/local.ts";

export const DEFAULT_SOURCE_PRIORITY = ["local", "aideadlines", "ccfddl"];
export const DEFAULT_ONE_TO_ONE_MAX_S = 604800; // 7 d
export const DEFAULT_CROSS_SOURCE_TOLERANCE_S = 90000; // 25 h
export const DEADLINE_SELECTION_RULE = "source_priority_then_nearest_within_configured_window";
export const ABSENT_RANKS = new Set(["N", "-", "none", "None", "NONE", "null", "NULL", ""]);

interface Windows {
  one_to_one: number;
  cross_source: number;
}

// --------------------------------------------------------------------------
// merge
// --------------------------------------------------------------------------

/** Rewrite configured aliases and retain their explicit identity evidence. */
export function applyAliases(
  groups: Conference[][] | null | undefined,
  aliases: Record<string, unknown> | null | undefined,
): Conference[][] {
  if (!groups || !Array.isArray(groups)) return [];
  if (!aliases) return groups;
  const table = new Map(Object.entries(aliases).map(([k, v]) => [k, String(v)]));
  // ponytail: aliases are a small config table; index connected components if this ever becomes large.
  const aliasGroup = (key: string): string[] => {
    const seen = new Set<string>();
    let target = key;
    while (table.has(target) && !seen.has(target)) {
      seen.add(target);
      target = table.get(target)!;
    }
    return [...new Set([...table.keys(), ...table.values(), key])]
      .filter((candidate) => {
        const path = new Set<string>();
        let current = candidate;
        while (table.has(current) && !path.has(current)) {
          path.add(current);
          current = table.get(current)!;
        }
        return current === target;
      })
      .sort(cmpStr);
  };
  return groups.map((group) =>
    Array.isArray(group)
      ? group.map((conf) => {
          const key = table.get(conf.key);
          const explicitAliases = aliasGroup(key ?? conf.key);
          if (key === undefined && explicitAliases.length <= 1) return conf;
          return {
            ...conf,
            ...(key === undefined ? {} : { key }),
            identity: mergeVenueIdentity([conf.identity, { aliases: explicitAliases }]),
          };
        })
      : [],
  );
}

export interface IdentityConflict {
  scope: "venue" | "edition";
  reason: "ambiguous" | "source-collision" | "key-collision";
  subject: string;
  candidates: string[];
}

export interface MergeStats {
  merged_deadlines: number;
  merged_by_key: Record<string, number>;
  /** Optional public addition: deterministic diagnostics for refused identity matches. */
  identity_conflicts?: IdentityConflict[];
}

function freshStats(): MergeStats {
  return { merged_deadlines: 0, merged_by_key: {}, identity_conflicts: [] };
}

/** Merge only conferences supported by explicit venue identity evidence. */
export function mergeSources(
  groups: Conference[][] | null | undefined,
  config: Record<string, unknown> | null | undefined,
  stats: MergeStats | null = null,
): Conference[] {
  const safeConfig = config ?? {};
  const priority = (safeConfig.source_priority as string[]) ?? DEFAULT_SOURCE_PRIORITY;
  const windows = windowsOf(safeConfig);
  const tally = freshStats();

  const ordered: Array<{ prio: number; conf: Conference }> = [];
  for (const group of groups ?? []) {
    if (!Array.isArray(group)) continue;
    for (const conf of group) {
      if (!conf || typeof conf !== "object") continue;
      ordered.push({
        prio: priorityOf(conf, priority),
        conf: configuredIdentity(conf, safeConfig),
      });
    }
  }
  ordered.sort(
    (a, b) => a.prio - b.prio || cmpStr(conferenceSortKey(a.conf), conferenceSortKey(b.conf)),
  );

  const buckets: Conference[][] = [];
  for (const { conf } of ordered) {
    const matching = buckets.filter((bucket) =>
      bucket.some((candidate) => sameConference(candidate, conf)),
    );
    const combinedSources = [conf, ...matching.flat()].flatMap((item) => item.sources);
    const canCombine =
      matching.length > 0 && new Set(combinedSources).size === combinedSources.length;
    if (canCombine) {
      for (const bucket of matching) buckets.splice(buckets.indexOf(bucket), 1);
      buckets.push([...matching.flat(), conf]);
    } else {
      const keyCollisions = buckets.filter((bucket) => bucket[0].key === conf.key);
      const unexplainedCollisions = (matching.length > 0 ? matching : keyCollisions).filter(
        (bucket) => !explicitIdentitySplit(bucket[0], conf),
      );
      if (unexplainedCollisions.length > 0) {
        recordConflict(
          tally,
          "venue",
          matching.length > 0 ? "source-collision" : "key-collision",
          conferenceIdentityLabel(conf),
          unexplainedCollisions.map((bucket) => conferenceIdentityLabel(bucket[0])),
        );
      }
      buckets.push([conf]);
    }
  }

  const merged = uniqueConferenceKeys(
    buckets.map((bucket) => mergeBucket(bucket[0].key, bucket, windows, tally)),
    configuredVenueKeys(safeConfig),
  );

  merged.sort((a, b) => cmpStr(a.key, b.key));
  if (stats !== null) {
    stats.merged_deadlines = tally.merged_deadlines;
    stats.merged_by_key = tally.merged_by_key;
    stats.identity_conflicts = [...(tally.identity_conflicts ?? [])].sort(identityConflictOrder);
  }
  return merged;
}

/** Reapply configured stable IDs and fold editions made explicit by that registry. */
export function normalizeConfiguredVenueIdentities(
  confs: Conference[] | null | undefined,
  config: Record<string, unknown> | null | undefined,
): Conference[] {
  const safeConfig = config ?? {};
  const normalized = uniqueConferenceKeys(
    (confs ?? []).map((conf) => configuredIdentity(conf, safeConfig)),
    configuredVenueKeys(safeConfig),
  ).map((conf) => {
    const merged = mergeConfiguredEditions(conf, safeConfig);
    return {
      ...merged,
      legacy_keys: (merged.legacy_keys ?? []).filter((key) => key !== merged.key),
    };
  });
  return normalized.sort((a, b) => cmpStr(a.key, b.key));
}

function configuredVenueKeys(config: Record<string, unknown>): Set<string> {
  const registry = config.venue_identities;
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return new Set();
  return new Set(Object.keys(registry).map(slug).filter(Boolean));
}

function configuredIdentity(conf: Conference, config: Record<string, unknown>): Conference {
  const editions = conf.editions.map((edition) => configuredEditionIdentity(edition, config));
  const configured = editions.some((edition, index) => edition !== conf.editions[index])
    ? { ...conf, editions }
    : conf;
  const registry = config.venue_identities;
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return configured;
  for (const [venueId, value] of Object.entries(registry as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const sourceIds = (value as Record<string, unknown>).source_ids;
    if (!sourceIds || typeof sourceIds !== "object" || Array.isArray(sourceIds)) continue;
    const matches = Object.entries(sourceIds as Record<string, unknown>).some(
      ([source, id]) =>
        identityToken(configured.identity?.sourceIds?.[source]) !== "" &&
        identityToken(configured.identity?.sourceIds?.[source]) === identityToken(String(id)),
    );
    if (matches)
      return {
        ...configured,
        identity: mergeVenueIdentity([configured.identity, { venueId }]),
      };
  }
  return configured;
}

function configuredEditionIdentity(edition: Edition, config: Record<string, unknown>): Edition {
  const registry = config.edition_identities;
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return edition;
  for (const [editionId, value] of Object.entries(registry as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const sourceIds = (value as Record<string, unknown>).source_ids;
    if (!sourceIds || typeof sourceIds !== "object" || Array.isArray(sourceIds)) continue;
    const matches = Object.entries(sourceIds as Record<string, unknown>).some(
      ([source, id]) =>
        identityToken(edition.identity?.sourceIds?.[source]) !== "" &&
        identityToken(edition.identity?.sourceIds?.[source]) === identityToken(String(id)),
    );
    if (matches)
      return {
        ...edition,
        identity: mergeEditionIdentity([edition.identity, { editionId }]),
      };
  }
  return edition;
}

function mergeConfiguredEditions(conf: Conference, config: Record<string, unknown>): Conference {
  const groups = new Map<string, Edition[]>();
  for (const edition of conf.editions) {
    const editionId = identityToken(edition.identity?.editionId);
    groups.set(editionId, [...(groups.get(editionId) ?? []), edition]);
  }
  if (![...groups.entries()].some(([editionId, editions]) => editionId && editions.length > 1))
    return conf;

  const priority = (config.source_priority as string[]) ?? DEFAULT_SOURCE_PRIORITY;
  const tally = freshStats();
  const editions = [...groups.entries()].flatMap(([editionId, matches]) => {
    if (!editionId || matches.length === 1) return matches;
    const sources = matches
      .map((edition) => ({ ...conf, sources: [edition.source], editions: [edition] }))
      .sort((a, b) => priorityOf(a, priority) - priorityOf(b, priority));
    return mergeEditions(sources, windowsOf(config), tally);
  });
  editions.sort((a, b) => a.year - b.year || cmpStr(editionSortKey(a), editionSortKey(b)));
  return { ...conf, editions };
}

function windowsOf(config: Record<string, unknown>): Windows {
  return {
    one_to_one: Number(config.deadline_merge_one_to_one_max_seconds ?? DEFAULT_ONE_TO_ONE_MAX_S),
    cross_source: Number(
      config.deadline_merge_cross_source_seconds ?? DEFAULT_CROSS_SOURCE_TOLERANCE_S,
    ),
  };
}

function priorityOf(conf: Conference, priority: string[]): number {
  for (const name of conf.sources) {
    const idx = priority.indexOf(name);
    if (idx >= 0) return idx;
  }
  return priority.length;
}

function identityToken(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function urlToken(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return identityToken(raw).replace(/\/+$/, "");
  }
}

function domainToken(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return "";
  }
}

function aliasToken(value: string | null | undefined): string {
  return slug(value);
}

function commonIdentity(
  left: readonly string[] | null | undefined,
  right: readonly string[] | null | undefined,
  token: (value: string | null | undefined) => string = identityToken,
): string[] {
  const rightSet = new Set((right ?? []).map(token).filter(Boolean));
  return [...new Set((left ?? []).map(token).filter((value) => rightSet.has(value)))].sort(cmpStr);
}

function mergeVenueIdentity(values: Array<VenueIdentity | undefined>): VenueIdentity | undefined {
  const venueId = values.map((value) => value?.venueId?.trim()).find(Boolean);
  const dblpKey = values.map((value) => value?.dblpKey?.trim()).find(Boolean);
  const officialDomains = unique(values.flatMap((value) => value?.officialDomains ?? [])).sort(
    cmpStr,
  );
  const aliases = unique(values.flatMap((value) => value?.aliases ?? [])).sort(cmpStr);
  const sourceIds: Record<string, string> = {};
  for (const value of [...values].reverse()) Object.assign(sourceIds, value?.sourceIds ?? {});
  const sortedSourceIds = Object.fromEntries(
    Object.entries(sourceIds).sort(([a], [b]) => cmpStr(a, b)),
  );
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
        ...(Object.keys(sortedSourceIds).length ? { sourceIds: sortedSourceIds } : {}),
      }
    : undefined;
}

export function mergeEditionIdentity(
  values: Array<EditionIdentity | undefined>,
): EditionIdentity | undefined {
  const editionId = values.map((value) => value?.editionId?.trim()).find(Boolean);
  const officialUrls = unique(values.flatMap((value) => value?.officialUrls ?? [])).sort(cmpStr);
  const sourceIds: Record<string, string> = {};
  for (const value of [...values].reverse()) Object.assign(sourceIds, value?.sourceIds ?? {});
  const sortedSourceIds = Object.fromEntries(
    Object.entries(sourceIds).sort(([a], [b]) => cmpStr(a, b)),
  );
  return editionId || officialUrls.length || Object.keys(sortedSourceIds).length
    ? {
        ...(editionId ? { editionId } : {}),
        ...(officialUrls.length ? { officialUrls } : {}),
        ...(Object.keys(sortedSourceIds).length ? { sourceIds: sortedSourceIds } : {}),
      }
    : undefined;
}

function conferenceIdentityLabel(conf: Conference): string {
  return [
    identityToken(conf.identity?.venueId),
    identityToken(conf.identity?.dblpKey ?? conf.dblp),
    ...(conf.identity?.aliases ?? []).map(identityToken),
    ...Object.entries(conf.identity?.sourceIds ?? {}).map(
      ([source, sourceId]) => `${identityToken(source)}:${identityToken(sourceId)}`,
    ),
    conf.key,
  ]
    .filter(Boolean)
    .sort(cmpStr)
    .join("|");
}

function venueDomains(conf: Conference): string[] {
  return unique(conf.identity?.officialDomains ?? []).filter((value) => domainToken(value));
}

function compatibleAliases(conf: Conference): string[] {
  return unique(conf.identity?.aliases ?? []).filter((value) => aliasToken(value));
}

function conferenceNames(conf: Conference): string[] {
  return [conf.title, conf.full_name].filter(aliasToken);
}

function sameSourceId(left: Conference, right: Conference): boolean {
  return Object.entries(left.identity?.sourceIds ?? {}).some(
    ([source, id]) =>
      identityToken(id) !== "" &&
      identityToken(id) === identityToken(right.identity?.sourceIds?.[source]),
  );
}

function editionIdentityLabel(edition: Edition): string {
  return [
    identityToken(edition.identity?.editionId),
    ...Object.entries(edition.identity?.sourceIds ?? {}).map(
      ([source, sourceId]) => `${identityToken(source)}:${identityToken(sourceId)}`,
    ),
    ...(edition.identity?.officialUrls ?? []).map(urlToken),
    identityToken(edition.edition_id),
    String(edition.year),
  ]
    .filter(Boolean)
    .sort(cmpStr)
    .join("|");
}

function conferenceSortKey(conf: Conference): string {
  return [
    conferenceIdentityLabel(conf),
    conf.key,
    conf.title,
    conf.full_name,
    conf.link,
    conf.upstream_sub ?? "",
    conf.sources.join(","),
    conf.editions.map(editionIdentityLabel).sort(cmpStr).join(","),
  ].join("\u0000");
}

function editionSortKey(edition: Edition): string {
  return [editionIdentityLabel(edition), edition.place, edition.date_text, edition.source].join(
    "\u0000",
  );
}

function eventRangesOverlap(left: Edition, right: Edition): boolean {
  const leftStart = left.event_start?.getTime();
  const leftEnd = (left.event_end ?? left.event_start)?.getTime();
  const rightStart = right.event_start?.getTime();
  const rightEnd = (right.event_end ?? right.event_start)?.getTime();
  return (
    leftStart !== undefined &&
    leftEnd !== undefined &&
    rightStart !== undefined &&
    rightEnd !== undefined &&
    leftStart <= rightEnd &&
    rightStart <= leftEnd
  );
}

function placesCompatible(left: string, right: string): boolean {
  return Boolean(identityToken(left) && identityToken(left) === identityToken(right));
}

function recordConflict(
  stats: MergeStats,
  scope: IdentityConflict["scope"],
  reason: IdentityConflict["reason"],
  subject: string,
  candidates: string[],
): void {
  stats.identity_conflicts?.push({
    scope,
    reason,
    subject,
    candidates: [...new Set(candidates)].sort(cmpStr),
  });
}

function identityConflictOrder(left: IdentityConflict, right: IdentityConflict): number {
  return (
    cmpStr(left.scope, right.scope) ||
    cmpStr(left.reason, right.reason) ||
    cmpStr(left.subject, right.subject) ||
    cmpStr(left.candidates.join("\u0000"), right.candidates.join("\u0000"))
  );
}

function uniqueConferenceKeys(
  confs: Conference[],
  reservedKeys: ReadonlySet<string>,
): Conference[] {
  const byKey = new Map<string, Conference[]>();
  for (const conf of confs) {
    const canonical = slug(conf.identity?.venueId ?? "") || conf.key;
    const normalized =
      canonical === conf.key
        ? conf
        : {
            ...conf,
            key: canonical,
            legacy_keys: [...new Set([...(conf.legacy_keys ?? []), conf.key])].sort(cmpStr),
          };
    byKey.set(normalized.key, [...(byKey.get(normalized.key) ?? []), normalized]);
  }
  const out: Conference[] = [];
  for (const [key, collisions] of byKey) {
    if (collisions.length === 1) {
      out.push(collisions[0]!);
      continue;
    }
    const used = new Set<string>();
    for (const conf of [...collisions].sort((a, b) =>
      cmpStr(conferenceSortKey(a), conferenceSortKey(b)),
    )) {
      const base = `${key}-${collisionSuffix(conf)}`;
      let next = base;
      for (let suffix = 2; used.has(next); suffix++) next = `${base}-${suffix}`;
      used.add(next);
      out.push({
        ...conf,
        key: next,
        legacy_keys: [...new Set([...(conf.legacy_keys ?? []), conf.key])].sort(cmpStr),
      });
    }
  }
  const canonicalKeys = new Set([...out.map((conference) => conference.key), ...reservedKeys]);
  return out.map((conference) => {
    const legacyKeys = (conference.legacy_keys ?? []).filter((key) => !canonicalKeys.has(key));
    if (legacyKeys.length === (conference.legacy_keys ?? []).length) return conference;
    const { legacy_keys: _legacyKeys, ...withoutLegacyKeys } = conference;
    return legacyKeys.length
      ? { ...withoutLegacyKeys, legacy_keys: legacyKeys }
      : withoutLegacyKeys;
  });
}

function collisionSuffix(conf: Conference): string {
  const explicit = [
    conf.identity?.venueId,
    conf.identity?.dblpKey ?? conf.dblp,
    ...Object.entries(conf.identity?.sourceIds ?? {})
      .sort(([a], [b]) => cmpStr(a, b))
      .map(([source, sourceId]) => `${source}-${sourceId}`),
  ].filter(Boolean);
  const content = [
    conf.title,
    conf.full_name,
    conf.link,
    ...conf.editions.map((edition) =>
      [edition.year, edition.source, edition.edition_id, edition.link].join("-"),
    ),
  ];
  return slug(conf.upstream_sub ?? "") || slug(explicit.join("-")) || slug(content.join("-"));
}

function sameConference(left: Conference, right: Conference): boolean {
  if (explicitIdentitySplit(left, right)) return false;
  const leftId = identityToken(left.identity?.venueId);
  const rightId = identityToken(right.identity?.venueId);
  if (leftId && rightId) return leftId === rightId;
  const leftDblp = identityToken(left.identity?.dblpKey ?? left.dblp);
  const rightDblp = identityToken(right.identity?.dblpKey ?? right.dblp);
  if (leftDblp && rightDblp) return leftDblp === rightDblp;
  if (left.key !== right.key) return false;
  if (sameSourceId(left, right)) return true;
  if (
    commonIdentity(venueDomains(left), venueDomains(right), domainToken).length > 0 &&
    commonIdentity(conferenceNames(left), conferenceNames(right), aliasToken).length > 0
  )
    return true;
  return commonIdentity(compatibleAliases(left), compatibleAliases(right), aliasToken).length > 0;
}

/** Distinct source identities are an explicit split, not an unresolved collision. */
function explicitIdentitySplit(left: Conference, right: Conference): boolean {
  const leftVenueId = identityToken(left.identity?.venueId);
  const rightVenueId = identityToken(right.identity?.venueId);
  if (leftVenueId && rightVenueId && leftVenueId !== rightVenueId) return true;
  const sources = new Set([
    ...Object.keys(left.identity?.sourceIds ?? {}),
    ...Object.keys(right.identity?.sourceIds ?? {}),
  ]);
  return [...sources].some((source) => {
    const leftId = identityToken(left.identity?.sourceIds?.[source]);
    const rightId = identityToken(right.identity?.sourceIds?.[source]);
    return leftId !== "" && rightId !== "" && leftId !== rightId;
  });
}

function mergeBucket(
  key: string,
  confs: Conference[],
  windows: Windows,
  tally: MergeStats,
): Conference {
  // `confs` is ordered high priority first.
  const identity = mergeVenueIdentity(confs.map((conf) => conf.identity));
  const out: Conference = {
    key,
    title: confs[0].title,
    full_name: confs[0].full_name,
    link: confs[0].link,
    rank: {},
    dblp: null,
    upstream_sub: null,
    tags: [],
    categories: [],
    editions: [],
    sources: [],
    ...(identity ? { identity } : {}),
  };
  for (const conf of [...confs].reverse()) {
    // low priority first, higher priority overwrites
    if (conf.title) out.title = conf.title;
    if (conf.full_name) out.full_name = conf.full_name;
    if (conf.link) out.link = conf.link;
    if (Object.keys(conf.rank).length > 0) out.rank = { ...out.rank, ...conf.rank };
    if (conf.dblp) out.dblp = conf.dblp;
    if (conf.upstream_sub) out.upstream_sub = conf.upstream_sub;
  }
  out.tags = unique(confs.flatMap((c) => c.tags));
  out.categories = unique(confs.flatMap((c) => c.categories));
  out.sources = unique(confs.flatMap((c) => c.sources));
  const legacyKeys = unique(confs.flatMap((c) => c.legacy_keys ?? []));
  if (legacyKeys.length > 0) out.legacy_keys = legacyKeys;
  const before = tally.merged_deadlines;
  out.editions = mergeEditions(confs, windows, tally);
  const mergedHere = tally.merged_deadlines - before;
  if (mergedHere > 0) tally.merged_by_key[key] = mergedHere;
  return out;
}

function mergeEditions(confs: Conference[], windows: Windows, tally: MergeStats): Edition[] {
  const byYear = new Map<
    number,
    Array<{ edition: Edition; tagged: Array<[string, Deadline]>; sources: Set<string> }>
  >();
  for (const conf of confs) {
    // high priority first
    for (const edition of [...conf.editions].sort((a, b) =>
      cmpStr(editionSortKey(a), editionSortKey(b)),
    )) {
      const bucket = byYear.get(edition.year) ?? [];
      const source = edition.source || conf.sources.join("+") || "unknown";
      const matching = bucket.filter((item) => mergeTarget(item.edition, edition));
      const eligible = matching.filter((item) => !item.sources.has(source));
      const tagged: Array<[string, Deadline]> = edition.deadlines.map((d) => [edition.source, d]);
      if (eligible.length !== 1) {
        if (matching.length > 0) {
          recordConflict(
            tally,
            "edition",
            eligible.length > 1 ? "ambiguous" : "source-collision",
            editionIdentityLabel(edition),
            matching.map((item) => editionIdentityLabel(item.edition)),
          );
        }
        bucket.push({ edition: { ...edition, deadlines: [] }, tagged, sources: new Set([source]) });
      } else {
        const heldItem = eligible[0];
        const held = heldItem.edition;
        if (held.estimated && !edition.estimated) {
          // SPEC.md 3.6: a real edition replaces an estimated one.
          const preservedSources = new Set([...heldItem.sources, source]);
          bucket[bucket.indexOf(heldItem)] = {
            edition: { ...edition, deadlines: [] },
            tagged,
            sources: preservedSources,
          };
        } else if (edition.estimated && !held.estimated) {
          // An estimate joining a real edition contributes nothing.
          continue;
        } else {
          fillEdition(held, edition);
          heldItem.tagged.push(...tagged);
          heldItem.sources.add(source);
        }
      }
      byYear.set(edition.year, bucket);
    }
  }
  const out: Edition[] = [];
  for (const year of [...byYear.keys()].sort((a, b) => a - b)) {
    const bucket = byYear.get(year)!;
    bucket.sort(
      (a, b) =>
        cmpStr(a.edition.edition_id, b.edition.edition_id) ||
        cmpStr(editionSortKey(a.edition), editionSortKey(b.edition)),
    );
    for (const item of bucket) {
      // Deduplicate after every source has contributed.
      item.edition.deadlines = dedupDeadlines(item.tagged, windows, tally);
      out.push(item.edition);
    }
  }
  const ids = new Map<string, number>();
  const used = new Set(out.map((edition) => edition.edition_id));
  for (const edition of out) ids.set(edition.edition_id, (ids.get(edition.edition_id) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const edition of out) {
    const id = edition.edition_id;
    if ((ids.get(id) ?? 0) <= 1) continue;
    const index = seen.get(id) ?? 0;
    seen.set(id, index + 1);
    if (index === 0) continue;
    const hint = slug(`${edition.source}-${edition.identity?.sourceIds?.[edition.source] ?? ""}`);
    const base = `${id}-${hint || index + 1}`;
    let next = base;
    for (let suffix = 2; used.has(next); suffix++) next = `${base}-${suffix}`;
    edition.edition_id = next;
    used.add(next);
  }
  return out;
}

function mergeTarget(left: Edition, right: Edition): boolean {
  const leftId = identityToken(left.identity?.editionId);
  const rightId = identityToken(right.identity?.editionId);
  if (leftId && rightId && leftId === rightId) return true;
  // 同一 source 内で明示的に異なる edition 識別子 (editionId / sourceIds) を持ち、
  // 会期が重ならないなら、月例研究会など年内複数開催の正当な独立 occurrence。
  // URL 共有は同一開催の証拠にならない (IEICE の ken program page は全研究会共通)。
  // 同一 source 内の比較に限る: 異なる source 間は片方が日付未発表でも統合する。
  if (
    left.source === right.source &&
    left.source !== "" &&
    ((leftId && rightId && leftId !== rightId) ||
      (() => {
        const a = left.identity?.sourceIds?.[left.source];
        const b = right.identity?.sourceIds?.[right.source];
        return Boolean(a && b && a !== b);
      })()) &&
    !eventRangesOverlap(left, right)
  ) {
    return false;
  }
  const leftUrls = left.identity?.officialUrls ?? [];
  const rightUrls = right.identity?.officialUrls ?? [];
  if (commonIdentity(leftUrls, rightUrls, urlToken).length > 0) return true;
  if (
    commonIdentity(
      Object.values(left.identity?.sourceIds ?? {}),
      Object.values(right.identity?.sourceIds ?? {}),
    ).length > 0 &&
    eventRangesOverlap(left, right)
  )
    return true;
  return eventRangesOverlap(left, right) && placesCompatible(left.place, right.place);
}

function fillEdition(target: Edition, other: Edition): void {
  if (!target.edition_id && other.edition_id) target.edition_id = other.edition_id;
  if (!target.link && other.link) target.link = other.link;
  if (!target.place && other.place) target.place = other.place;
  if (!target.date_text && other.date_text) target.date_text = other.date_text;
  if (!target.event_start && other.event_start) target.event_start = other.event_start;
  if (!target.event_end && other.event_end) target.event_end = other.event_end;
  const identity = mergeEditionIdentity([target.identity, other.identity]);
  if (identity) target.identity = identity;
}

/** Label form used for equality: case and whitespace carry no meaning. */
function normLabel(label: string | null | undefined): string {
  // 先頭と末尾の空白を除き、連続する空白を 1 個に畳む。
  return (label ?? "").trim().split(/\s+/).join(" ").toLowerCase();
}

function sameGenericSubmissionSlot(left: Deadline, right: Deadline): boolean {
  if (left.track?.trim() || right.track?.trim()) return false;
  const kind = normLabel(left.kind || "other");
  const generic = new Set([`${kind} submission`, `${kind} submission deadline`]);
  return generic.has(normLabel(left.label)) && generic.has(normLabel(right.label));
}

/** Re-apply the SPEC.md 3.6 fold after roll-forward. */
export function dedupDeadlinesAfterRollforward(
  confs: Conference[],
  config: Record<string, unknown>,
  stats: MergeStats | null = null,
): Conference[] {
  const windows = windowsOf(config);
  const tally = freshStats();
  const out: Conference[] = [];
  for (const conf of confs) {
    const editions: Edition[] = [];
    for (const edition of conf.editions) {
      const before = tally.merged_deadlines;
      const tagged: Array<[string, Deadline]> = edition.deadlines.map((d) => [edition.source, d]);
      editions.push({ ...edition, deadlines: dedupDeadlines(tagged, windows, tally) });
      const folded = tally.merged_deadlines - before;
      if (folded > 0) {
        tally.merged_by_key[conf.key] = (tally.merged_by_key[conf.key] ?? 0) + folded;
      }
    }
    out.push({ ...conf, editions });
  }
  if (stats !== null) {
    stats.merged_deadlines = (stats.merged_deadlines ?? 0) + tally.merged_deadlines;
    for (const [key, count] of Object.entries(tally.merged_by_key)) {
      stats.merged_by_key[key] = (stats.merged_by_key[key] ?? 0) + count;
    }
  }
  return out;
}

/**
 * Fold deadlines of one edition that are the same deadline seen twice
 * (SPEC.md 3.6).  `tagged` arrives highest source priority first.
 */
function dedupDeadlines(
  tagged: Array<[string, Deadline]>,
  windows: Windows,
  tally: MergeStats,
): Deadline[] {
  const heldPerSource = new Map<string, number>();
  for (const [source, d] of tagged) {
    const key = `${source}\u0000${d.kind}`;
    heldPerSource.set(key, (heldPerSource.get(key) ?? 0) + 1);
  }
  const kept: Array<{ origins: Set<string>; deadline: Deadline }> = [];
  for (const [source, deadline] of tagged) {
    let best: { gap: number; index: number } | null = null;
    for (let index = 0; index < kept.length; index++) {
      const { origins, deadline: held } = kept[index];
      if (held.kind !== deadline.kind || held.round !== deadline.round) continue;
      const sameSource = origins.has(source);
      if (
        deadlineSlotKey(held) !== deadlineSlotKey(deadline) &&
        (sameSource || !sameGenericSubmissionSlot(held, deadline))
      )
        continue;
      const gap =
        isDateOnlyDeadline(held) && isDateOnlyDeadline(deadline)
          ? held.local_date === deadline.local_date
            ? 0
            : Number.POSITIVE_INFINITY
          : isDateOnlyDeadline(held) && isExactDeadline(deadline)
            ? exactInsideDateOnly(deadline, held)
              ? 0
              : Number.POSITIVE_INFINITY
            : isExactDeadline(held) && isDateOnlyDeadline(deadline)
              ? exactInsideDateOnly(held, deadline)
                ? 0
                : Number.POSITIVE_INFINITY
              : isExactDeadline(held) && isExactDeadline(deadline)
                ? Math.abs(held.at_utc.getTime() - deadline.at_utc.getTime()) / 1000
                : Number.POSITIVE_INFINITY;
      if (sameSource) {
        if (gap !== 0 || normLabel(held.label) !== normLabel(deadline.label)) continue;
      } else {
        const oneToOne = [...origins, source].every(
          (name) => (heldPerSource.get(`${name}\u0000${deadline.kind}`) ?? 0) === 1,
        );
        const limit = oneToOne ? windows.one_to_one : windows.cross_source;
        if (gap > limit) continue;
      }
      // Nearest wins, not first.
      if (best === null || gap < best.gap) best = { gap, index };
    }
    if (best === null) {
      kept.push({ origins: new Set([source]), deadline });
      continue;
    }
    const entry = kept[best.index];
    const sameSource = entry.origins.has(source);
    entry.origins.add(source);
    entry.deadline = absorb(entry.deadline, deadline, sameSource, source);
    tally.merged_deadlines += 1;
  }
  const consolidated: Array<{ origins: Set<string>; deadline: Deadline }> = [];
  for (const entry of kept) {
    const matching = consolidated.find(
      (held) =>
        deadlineSlotKey(held.deadline) === deadlineSlotKey(entry.deadline) &&
        isExactDeadline(held.deadline) &&
        isExactDeadline(entry.deadline),
    );
    if (!matching) {
      consolidated.push(entry);
      continue;
    }
    const incoming = entry.deadline;
    if (sameDeadlineValue(matching.deadline, incoming)) {
      matching.deadline = absorb(
        matching.deadline,
        incoming,
        false,
        [...entry.origins].sort(cmpStr)[0] ?? "unknown",
      );
      matching.origins = new Set([...matching.origins, ...entry.origins]);
      tally.merged_deadlines += 1;
      continue;
    }
    const source = [...entry.origins].sort(cmpStr)[0] ?? "unknown";
    const at = isExactDeadline(incoming)
      ? incoming.at_utc
      : dateOnlyWindow(incoming.local_date)?.earliestPossibleUtc;
    if (at) {
      matching.deadline = {
        ...matching.deadline,
        conflicts: [
          ...(matching.deadline.conflicts ?? []),
          { at_utc: at, label: incoming.label, source, raw_value: incoming.raw_value },
        ],
      } as Deadline;
    }
    tally.merged_deadlines += 1;
  }
  const out = consolidated.map((k) => k.deadline);
  out.sort(
    (a, b) =>
      a.round - b.round ||
      deadlineSortTime(a) - deadlineSortTime(b) ||
      cmpStr(a.kind, b.kind) ||
      cmpStr(a.label ?? "", b.label ?? ""),
  );
  return out;
}

/** Same slot is not enough: only identical precision and value are foldable evidence. */
function sameDeadlineValue(left: Deadline, right: Deadline): boolean {
  if (isDateOnlyDeadline(left) || isDateOnlyDeadline(right))
    return (
      isDateOnlyDeadline(left) && isDateOnlyDeadline(right) && left.local_date === right.local_date
    );
  return left.at_utc.getTime() === right.at_utc.getTime();
}

function absorb(
  winner: Deadline,
  loser: Deadline,
  sameSource: boolean,
  loserSource: string,
): Deadline {
  const evidence = mergeEvidence(winner.evidence, loser.evidence);
  const origins = mergeOrigins(winner.origins, loser.origins);
  const notes: string[] = [];
  if (winner.comment) notes.push(winner.comment);
  if (loser.comment && !notes.includes(loser.comment)) notes.push(loser.comment);
  if (loser.label && loser.label !== winner.label) {
    const sameInstant =
      isDateOnlyDeadline(winner) && isDateOnlyDeadline(loser)
        ? winner.local_date === loser.local_date
        : isExactDeadline(winner) && isExactDeadline(loser)
          ? winner.at_utc.getTime() === loser.at_utc.getTime()
          : false;
    const note = `${sameInstant ? "同時刻の" : ""}別記載: ${loser.label}`;
    if (!notes.includes(note)) notes.push(note);
  }
  const comment = notes.length > 0 ? notes.join(" / ") : null;
  const round = sameSource ? winner.round : Math.max(winner.round, loser.round);
  if (isDateOnlyDeadline(winner) && isExactDeadline(loser)) {
    return {
      ...loser,
      comment,
      selection_rule: DEADLINE_SELECTION_RULE,
      ...(evidence.length > 0 ? { evidence } : {}),
      ...(origins.length > 0 ? { origins } : {}),
    };
  }
  if (isExactDeadline(winner) && isDateOnlyDeadline(loser)) {
    return {
      ...winner,
      comment,
      selection_rule: DEADLINE_SELECTION_RULE,
      ...(evidence.length > 0 ? { evidence } : {}),
      ...(origins.length > 0 ? { origins } : {}),
    };
  }
  if (isDateOnlyDeadline(winner) && isDateOnlyDeadline(loser)) {
    if (
      comment === winner.comment &&
      round === winner.round &&
      evidence.length === (winner.evidence?.length ?? 0)
    )
      return winner;
    return {
      ...winner,
      comment,
      round,
      selection_rule: DEADLINE_SELECTION_RULE,
      ...(evidence.length > 0 ? { evidence } : {}),
      ...(origins.length > 0 ? { origins } : {}),
    };
  }
  if (!isExactDeadline(winner) || !isExactDeadline(loser)) return winner;
  const priorConflicts = winner.conflicts ?? [];
  // An identical instant from another source is corroborating evidence, not a
  // conflict (SPEC.md 3.6): only genuinely different values are conflicts.
  const sameInstant =
    isExactDeadline(winner) &&
    isExactDeadline(loser) &&
    winner.at_utc.getTime() === loser.at_utc.getTime();
  const conflicts =
    sameSource ||
    sameInstant ||
    priorConflicts.some(
      (conflict) =>
        conflict.source === loserSource &&
        conflict.at_utc.getTime() === loser.at_utc.getTime() &&
        conflict.label === loser.label,
    )
      ? priorConflicts
      : [
          ...priorConflicts,
          {
            at_utc: loser.at_utc,
            label: loser.label,
            source: loserSource,
            ...(loser.raw_value ? { raw_value: loser.raw_value } : {}),
          },
        ];
  if (
    comment === winner.comment &&
    round === winner.round &&
    conflicts.length === priorConflicts.length &&
    evidence.length === (winner.evidence?.length ?? 0)
  )
    return winner;
  return {
    ...winner,
    comment,
    round,
    selection_rule: DEADLINE_SELECTION_RULE,
    ...(conflicts.length > 0 ? { conflicts } : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(origins.length > 0 ? { origins } : {}),
  };
}

function mergeEvidence(
  left: DeadlineEvidence[] | undefined,
  right: DeadlineEvidence[] | undefined,
): DeadlineEvidence[] {
  const seen = new Set<string>();
  return [...(left ?? []), ...(right ?? [])].filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeOrigins(
  left: Deadline["origins"],
  right: Deadline["origins"],
): NonNullable<Deadline["origins"]> {
  const seen = new Set<string>();
  return [...(left ?? []), ...(right ?? [])].filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deadlineSortTime(deadline: Deadline): number {
  if (isExactDeadline(deadline)) return deadline.at_utc.getTime();
  return (
    dateOnlyWindow(deadline.local_date)?.earliestPossibleUtc.getTime() ?? Number.MAX_SAFE_INTEGER
  );
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

// --------------------------------------------------------------------------
// classify
// --------------------------------------------------------------------------

export function classify(
  confs: Conference[] | null | undefined,
  config: Record<string, unknown> | null | undefined,
): Conference[] {
  if (!confs || !Array.isArray(confs)) return [];
  const safeConfig = config ?? {};
  const taxonomy = (safeConfig.taxonomy as Record<string, unknown>) ?? {};
  const known = new Set(
    Object.keys((safeConfig.categories as Record<string, unknown>) ?? taxonomy),
  );
  const excluded = new Set((safeConfig.exclude as string[] | null) ?? []);
  const out: Conference[] = [];
  for (const conf of confs) {
    let categories: string[];
    let assignments = (conf.category_assignments ?? []).filter((assignment) =>
      conf.categories.includes(assignment.category),
    );
    if (excluded.has(conf.key)) {
      categories = [];
      assignments = [];
    } else {
      categories = [...conf.categories];
      for (const category of categories) {
        if (!assignments.some((assignment) => assignment.category === category)) {
          assignments.push({ category, reason: "source-subfield" });
        }
      }
      for (const [name, rule] of Object.entries(taxonomy)) {
        if (!categories.includes(name) && matches(conf, (rule as Record<string, unknown>) ?? {})) {
          categories.push(name);
          assignments.push({
            category: name,
            reason: toStringArray((rule as Record<string, unknown>)?.venues).includes(conf.key)
              ? "explicit-venue-rule"
              : "source-subfield",
          });
        }
      }
      categories = known.size === 0 ? categories : categories.filter((c) => known.has(c));
      assignments = assignments.filter((assignment) => categories.includes(assignment.category));
    }
    out.push({ ...conf, categories, category_assignments: assignments });
  }
  return out;
}

import { toStringArray } from "./util.ts";

function matches(conf: Conference, rule: Record<string, unknown>): boolean {
  if (toStringArray(rule.venues).includes(conf.key)) return true;
  const subs = toStringArray(rule.ccfddl_subs);
  if (conf.upstream_sub && subs.includes(conf.upstream_sub)) return true;
  const sources = toStringArray(rule.sources);
  return sources.length > 0 && sources.some((s) => conf.sources.includes(s));
}

// --------------------------------------------------------------------------
// overrides
// --------------------------------------------------------------------------

export function applyOverrides(
  confs: Conference[] | null | undefined,
  overrides: Record<string, unknown> | null | undefined,
): Conference[] {
  if (!confs || !Array.isArray(confs)) return [];
  overrides = overrides ?? {};
  const dropped = new Set(toStringArray(overrides.drop));
  const patches = (overrides.conferences as Record<string, unknown>) ?? {};
  const out: Conference[] = [];
  for (const conf of confs) {
    if (dropped.has(conf.key)) continue;
    const patch = patches[conf.key] as Record<string, unknown> | undefined;
    if (!patch) {
      out.push(conf);
      continue;
    }
    const next: Conference = { ...conf, editions: [...conf.editions] };
    const record = next as unknown as Record<string, unknown>;
    for (const field of ["title", "full_name", "link", "dblp", "upstream_sub"] as const) {
      if (field in patch) {
        const v = patch[field];
        record[field] = v === null ? null : String(v);
      }
    }
    if ("rank" in patch) {
      const updatedRank = { ...next.rank };
      for (const [k, v] of Object.entries((patch.rank as Record<string, unknown>) ?? {})) {
        const normK = String(k).toLowerCase().trim();
        if (
          v === null ||
          v === undefined ||
          String(v).trim() === "" ||
          String(v).trim() === "null"
        ) {
          delete updatedRank[normK];
        } else {
          updatedRank[normK] = String(v).trim();
        }
      }
      next.rank = updatedRank;
    }
    for (const field of ["tags", "categories"] as const) {
      if (field in patch) {
        next[field] = toStringArray(patch[field]);
        if (field === "categories") {
          next.category_assignments = next.categories.map((category) => ({
            category,
            reason: "manual-review",
          }));
        }
      }
    }
    const editionPatches = (patch.editions as Record<string, unknown>) ?? {};
    if (Object.keys(editionPatches).length > 0) {
      next.editions = patchEditions(next.editions, editionPatches);
    }
    out.push(next);
  }
  return out;
}

/** Drop paper/abstract deadlines that fall after the meeting ends (or starts, if event_end is null). */
export function sanitizeEditions(confs: Conference[] | null | undefined): Conference[] {
  if (!confs || !Array.isArray(confs)) return [];
  return confs.map((conf) => {
    if (!conf || typeof conf !== "object") return conf;
    const editions = Array.isArray(conf.editions) ? conf.editions : [];
    return {
      ...conf,
      editions: editions.map((edition) => {
        if (!edition || typeof edition !== "object") return edition;
        const meetingEnd = edition.event_end ?? edition.event_start;
        if (
          meetingEnd === null ||
          !Array.isArray(edition.deadlines) ||
          edition.deadlines.length === 0
        )
          return edition;
        const kept = edition.deadlines.filter((d) => {
          if (!(d && (d.kind === "paper" || d.kind === "abstract"))) return true;
          const day = isDateOnlyDeadline(d) ? asDate(d.local_date) : dateOnly(d.at_utc);
          return day === null || day.getTime() <= dateOnly(meetingEnd).getTime();
        });
        if (kept.length === edition.deadlines.length) return edition;
        return { ...edition, deadlines: kept };
      }),
    };
  });
}

function patchEditions(editions: Edition[], patches: Record<string, unknown>): Edition[] {
  const kept: Edition[] = [];
  const patchedYears = new Set<number>();
  const realYears = new Set(
    editions.filter((edition) => !edition.estimated).map(({ year }) => year),
  );
  for (const edition of editions) {
    if (edition.estimated && realYears.has(edition.year)) continue;
    const patch = patches[String(edition.year)] as Record<string, unknown> | undefined;
    if (patch === undefined) {
      kept.push(edition);
      continue;
    }
    patchedYears.add(edition.year);
    if (patch.drop) continue;
    const next: Edition = { ...edition, deadlines: [...edition.deadlines] };
    if ("id" in patch) next.edition_id = String(patch.id);
    for (const field of ["link", "place", "date_text"] as const) {
      if (field in patch) next[field] = String(patch[field]);
    }
    for (const field of ["event_start", "event_end"] as const) {
      if (field in patch) next[field] = asDate(patch[field]);
    }
    if ("estimated" in patch) {
      // 推定版 (rollforward 生成) を実版へ昇格 / 降格させるための上書き。
      next.estimated = Boolean(patch.estimated);
      if (!next.estimated) next.estimate = undefined;
    }
    if (
      patch.clear_deadlines === true ||
      "deadlines" in patch ||
      "deadline" in patch ||
      "paper_deadline" in patch ||
      "abstract_deadline" in patch ||
      (patch.mode === "merge-slots" && Array.isArray(patch.remove))
    ) {
      // 置換 (延長・訂正): 上流の古い締切を残さず差し替える (SPEC.md 3.5)。
      // ただし全行棄却のパッチ (timezone 欠落・曖昧で parseInstant が全滅) は
      // 既存確定値を空配列で潰さない。
      // 明示的な空は
      // clear_deadlines: true でのみ可能。
      const semantics = patchDeadlineSemantics({ ...patch, link: next.link });
      const hasRemoval = patch.mode === "merge-slots" && Array.isArray(patch.remove);
      if (semantics.action === "replace" || hasRemoval) {
        const removals: DeadlineSlotObservation[] = Array.isArray(patch.remove)
          ? patch.remove
              .filter((item): item is Record<string, unknown> =>
                Boolean(item && typeof item === "object"),
              )
              .map((item) => ({
                kind: (KINDS as readonly string[]).includes(String(item.kind))
                  ? (String(item.kind) as Deadline["kind"])
                  : "other",
                label: String(item.label ?? item.kind ?? "other"),
                round: Number(item.round ?? 1) || 1,
                ...(typeof item.track === "string" && item.track.trim()
                  ? { track: slug(item.track) }
                  : {}),
                precision: "date-only" as const,
                local_date: "1970-01-01",
                comment: null,
                remove: true,
              }))
          : [];
        next.deadlines =
          patch.mode === "merge-slots"
            ? mergeDeadlineSlots(next.deadlines, [...semantics.accepted, ...removals])
            : semantics.accepted;
      } else if (semantics.action === "clear") {
        next.deadlines = [];
      }
      // keep-existing: deadlines を触らない (メタデータのみパッチ)
    }
    fillEventFromDateText(next);
    kept.push(next);
  }
  // 既存 edition に無い year の patch は新規 edition として追加する。
  for (const [yearKey, patch] of Object.entries(patches)) {
    if (!/^\d+$/.test(yearKey)) continue;
    const year = Number(yearKey);
    if (patchedYears.has(year)) continue;
    if (typeof patch !== "object" || patch === null) continue;
    const rec = patch as Record<string, unknown>;
    if (rec.drop) continue;
    // 受入条件「受理締切も会議/開催メタ情報も無い
    // edition は追加しない」。全行棄却の deadlines のみで link/place/date_text/
    // event_* も無いブロックは、空の確定版として公開する価値が無く、
    // isFuture 判定や UI を汚すだけなのでスキップする。
    const semantics = patchDeadlineSemantics(rec);
    const hasMeta =
      "link" in rec ||
      "place" in rec ||
      "date_text" in rec ||
      "event_start" in rec ||
      "event_end" in rec;
    if (semantics.action !== "replace" && !hasMeta) {
      warn(`override edition ${yearKey} has no accepted deadline and no metadata — not added`);
      continue;
    }
    const edition: Edition = {
      year,
      edition_id: rec.id ? String(rec.id) : `override-${year}`,
      link: "",
      place: "",
      date_text: "",
      event_start: null,
      event_end: null,
      deadlines:
        semantics.action === "replace"
          ? semantics.accepted
          : semantics.action === "clear"
            ? []
            : [],
      estimated: Boolean(rec.estimated),
      source: "override",
    };
    for (const field of ["link", "place", "date_text"] as const) {
      if (field in rec) edition[field] = String(rec[field]);
    }
    for (const field of ["event_start", "event_end"] as const) {
      if (field in rec) edition[field] = asDate(rec[field]);
    }
    fillEventFromDateText(edition);
    kept.push(edition);
  }
  return kept;
}

/** date_text がパースできるのに event_start が空なら埋める。明示値は残す。 */
function fillEventFromDateText(edition: Edition): void {
  if (edition.event_start || !edition.date_text) return;
  const [start, end] = parseDateRange(edition.date_text, edition.year);
  if (start) edition.event_start = start;
  if (end) edition.event_end = end;
}

/** Logical deadline slot: kind + round + normalized non-generic track. */
export function deadlineSlotKey(deadline: Deadline): string {
  const kind = deadline.kind || "other";
  return [
    kind,
    String(deadline.round || 1),
    deadlineTrackKey(deadline.label, kind, deadline.track),
  ].join("\0");
}

function exactInsideDateOnly(exact: Deadline, dateOnly: Deadline): boolean {
  if (!isExactDeadline(exact) || !isDateOnlyDeadline(dateOnly)) return false;
  const window = dateOnlyWindow(dateOnly.local_date);
  return Boolean(
    window &&
      exact.at_utc.getTime() >= window.earliestPossibleUtc.getTime() &&
      exact.at_utc.getTime() <= window.latestPossibleUtc.getTime(),
  );
}

/** Apply primary observations slot-by-slot without letting lower precision erase exact data. */
export type DeadlineSlotObservation = Deadline & { remove?: boolean };

export function mergeDeadlineSlots(
  existing: Deadline[],
  observed: DeadlineSlotObservation[],
): Deadline[] {
  const out = [...existing];
  for (const incoming of observed) {
    const index = out.findIndex((held) => deadlineSlotKey(held) === deadlineSlotKey(incoming));
    if (incoming.remove) {
      if (index >= 0) out.splice(index, 1);
      continue;
    }
    if (index < 0) {
      out.push(incoming);
      continue;
    }
    const held = out[index];
    if (isExactDeadline(held) && isDateOnlyDeadline(incoming)) {
      if (!exactInsideDateOnly(held, incoming)) {
        out[index] = {
          ...held,
          conflicts: [
            ...(held.conflicts ?? []),
            {
              at_utc: new Date(`${incoming.local_date}T00:00:00Z`),
              local_date: incoming.local_date,
              label: incoming.label,
              source: "primary",
            },
          ],
        };
      }
      continue;
    }
    if (isDateOnlyDeadline(held) && isExactDeadline(incoming)) {
      if (exactInsideDateOnly(incoming, held)) {
        const evidence = mergeEvidence(incoming.evidence, held.evidence);
        out[index] = {
          ...incoming,
          precision: "exact",
          ...(evidence.length > 0 ? { evidence } : {}),
        };
      } else {
        out[index] = {
          ...held,
          conflicts: [
            ...(held.conflicts ?? []),
            { at_utc: incoming.at_utc, label: incoming.label, source: "primary" },
          ],
        } as Deadline;
      }
      continue;
    }
    if (
      (isExactDeadline(held) &&
        isExactDeadline(incoming) &&
        held.at_utc.getTime() !== incoming.at_utc.getTime()) ||
      (isDateOnlyDeadline(held) &&
        isDateOnlyDeadline(incoming) &&
        held.local_date !== incoming.local_date)
    ) {
      out[index] = {
        ...held,
        conflicts: [
          ...(held.conflicts ?? []),
          {
            at_utc: isExactDeadline(incoming)
              ? incoming.at_utc
              : new Date(`${incoming.local_date}T00:00:00Z`),
            ...(isDateOnlyDeadline(incoming) ? { local_date: incoming.local_date } : {}),
            label: incoming.label,
            source: "primary",
          },
        ],
      } as Deadline;
      continue;
    }
    const evidence = mergeEvidence(incoming.evidence, held.evidence);
    out[index] = { ...incoming, ...(evidence.length > 0 ? { evidence } : {}) };
  }
  return out.sort((a, b) => deadlineSortTime(a) - deadlineSortTime(b) || cmpStr(a.kind, b.kind));
}

// --------------------------------------------------------------------------
// roll-forward
// --------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n % 2 === 1) return sorted[(n - 1) / 2];
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** Round non-negative values to the nearest integer, with ties to even. */
function roundHalfToEven(x: number): number {
  const r = Math.round(x);
  if (Math.abs(x % 1) === 0.5) return r % 2 === 0 ? r : r - 1;
  return r;
}

export function rollforward(
  confs: Conference[] | null | undefined,
  today: Date,
  config: Record<string, unknown> | null | undefined,
): Conference[] {
  if (!confs || !Array.isArray(confs)) return [];
  const safeConfig = config ?? {};
  const cfg = (safeConfig.rollforward as Record<string, unknown>) ?? {};
  const enabled = cfg.enabled === undefined ? true : Boolean(cfg.enabled);
  if (!enabled) return [...confs];
  const kinds = new Set((cfg.kinds as string[] | null) ?? ["abstract", "paper"]);
  const defaultInterval = Number(cfg.default_interval_days ?? 364);
  const lookback = Number(cfg.interval_lookback_editions ?? 3);
  const maxStale = Number(cfg.max_stale_days ?? 730);

  const out: Conference[] = [];
  for (const conf of confs) {
    const current = { ...conf, editions: conf.editions.filter((edition) => !edition.estimated) };
    const estimated = estimateEdition(current, today, kinds, defaultInterval, lookback, maxStale);
    if (estimated !== null) {
      out.push({ ...current, editions: [...current.editions, estimated] });
    } else {
      out.push(current);
    }
  }
  return out;
}

function estimateEdition(
  conf: Conference,
  today: Date,
  kinds: Set<string>,
  defaultInterval: number,
  lookback: number,
  maxStale: number,
): Edition | null {
  if (conf.editions.some((edition) => isFuture(edition, today))) return null;
  const dated: Array<{ edition: Edition; at: Date }> = [];
  for (const edition of [...conf.editions].sort((a, b) => a.year - b.year)) {
    if (edition.estimated) continue;
    const at = paperAt(edition);
    if (at !== null) dated.push({ edition, at });
  }
  if (dated.length === 0) return null;

  const last = dated[dated.length - 1];
  const stale = Math.floor((dateOnly(today).getTime() - dateOnly(last.at).getTime()) / DAY_MS);
  if (stale < 0 || stale > maxStale) return null;

  const interval = intervalDays(
    dated.slice(-lookback).map((d) => d.at),
    defaultInterval,
  );
  // Advance by whole intervals so the weekday is preserved.
  let steps = 1;
  while (
    steps < 3 &&
    dateOnly(addDays(last.at, interval * steps)).getTime() < dateOnly(today).getTime()
  ) {
    steps += 1;
  }
  const shift = interval * steps;
  if (dateOnly(addDays(last.at, shift)).getTime() < dateOnly(today).getTime()) {
    return null;
  }
  // Derive the year label from the shift actually applied.
  const year = last.edition.year + Math.max(1, Math.round(shift / 365.25));
  if (conf.editions.some((e) => e.year === year && !e.estimated)) {
    return null; // upstream already lists that edition, it just has no dates yet
  }

  const deadlines: ExactDeadline[] = last.edition.deadlines
    .filter(isExactDeadline)
    .filter((d) => kinds.has(d.kind))
    .map((d) => ({
      ...d,
      at_utc: addDays(d.at_utc, shift),
      comment: `Estimated from the ${last.edition.year} edition`,
    }));
  if (deadlines.length === 0) return null;
  const point =
    deadlines.find((deadline) => deadline.kind === "paper")?.at_utc ??
    deadlines.slice().sort((a, b) => a.at_utc.getTime() - b.at_utc.getTime())[0].at_utc;
  const windowDays = Math.max(14, roundHalfToEven(interval / 4 / 7) * 7);
  const estimate: DeadlineEstimate = {
    point_estimate: fmtDate(dateOnly(point)),
    window_start: fmtDate(dateOnly(addDays(point, -windowDays))),
    window_end: fmtDate(dateOnly(addDays(point, windowDays))),
    source_editions: dated.slice(-lookback).map(({ edition }) => edition.year),
    method: "median-interval",
    confidence: dated.length >= 3 ? "medium" : "low",
  };
  return {
    year,
    edition_id: `${conf.key}${String(year % 100).padStart(2, "0")}-est`,
    link: last.edition.link,
    place: "",
    date_text: "",
    event_start: null,
    event_end: null,
    deadlines,
    estimated: true,
    estimate,
    source: last.edition.source,
  };
}

function isFuture(edition: Edition, today: Date): boolean {
  if (
    edition.deadlines.some((d) => {
      if (d.kind !== "paper") return false;
      if (isDateOnlyDeadline(d)) return dateOnlyState(d.local_date, today) !== "definitely-past";
      return dateOnly(d.at_utc).getTime() >= dateOnly(today).getTime();
    })
  ) {
    return true;
  }
  return [edition.event_start, edition.event_end].some(
    (day) => day !== null && dateOnly(day).getTime() >= dateOnly(today).getTime(),
  );
}

function paperAt(edition: Edition): Date | null {
  const papers = edition.deadlines
    .filter(isExactDeadline)
    .filter((d) => d.kind === "paper")
    .map((d) => d.at_utc);
  if (papers.length === 0) return null;
  return papers.reduce((a, b) => (a.getTime() < b.getTime() ? a : b));
}

function intervalDays(instants: Date[], defaultInterval: number): number {
  const gaps: number[] = [];
  for (let i = 0; i < instants.length - 1; i++) {
    gaps.push(Math.floor((instants[i + 1].getTime() - instants[i].getTime()) / DAY_MS));
  }
  if (gaps.length === 0) return defaultInterval;
  const estimate = roundHalfToEven(median(gaps) / 7) * 7; // multiples of 7 preserve the weekday
  return estimate >= 180 && estimate <= 900 ? estimate : defaultInterval;
}

// --------------------------------------------------------------------------
// select
// --------------------------------------------------------------------------

export function select(
  confs: Conference[] | null | undefined,
  config: Record<string, unknown> | null | undefined,
): Conference[] {
  if (!confs || !Array.isArray(confs)) return [];
  const safeConfig = config ?? {};
  const enabled = new Set(Object.keys((safeConfig.categories as Record<string, unknown>) ?? {}));
  const excluded = new Set((safeConfig.exclude as string[] | null) ?? []);
  const rankFilter = (safeConfig.rank_filter as Record<string, unknown>) ?? {};
  const alwaysKeep = new Set((rankFilter.always_keep as string[] | null) ?? []);
  // Venues named under taxonomy are intentional inclusions.
  for (const rule of Object.values((safeConfig.taxonomy as Record<string, unknown>) ?? {})) {
    if (typeof rule === "object" && rule !== null) {
      for (const v of ((rule as Record<string, unknown>).venues as string[] | null) ?? []) {
        alwaysKeep.add(v);
      }
    }
  }
  const keepIfNoRank =
    rankFilter.keep_if_no_rank === undefined ? true : Boolean(rankFilter.keep_if_no_rank);
  const schemes: Record<string, unknown> = {};
  for (const [name, allowed] of Object.entries(rankFilter)) {
    // 空リスト (ccf: []) は通過条件に数えない。
    if (
      name !== "keep_if_no_rank" &&
      name !== "always_keep" &&
      Array.isArray(allowed) &&
      allowed.length > 0
    ) {
      schemes[name] = allowed;
    }
  }

  const out: Conference[] = [];
  for (const conf of confs) {
    if (excluded.has(conf.key)) continue;
    const categories =
      enabled.size === 0 ? [...conf.categories] : conf.categories.filter((c) => enabled.has(c));
    if (categories.length === 0) continue;
    if (!alwaysKeep.has(conf.key) && !rankOk(conf, schemes, keepIfNoRank)) continue;
    // ジャーナル（tags: [journal]）は日付なしでも残す。venues 名指し（alwaysKeep）も同様 — 名指し＝収録意思。
    if (!alwaysKeep.has(conf.key) && !hasDates(conf) && !(conf.tags ?? []).includes("journal"))
      continue;
    out.push({ ...conf, categories });
  }
  return out;
}

function hasDates(conf: Conference | null | undefined): boolean {
  if (!conf || !Array.isArray(conf.editions)) return false;
  return conf.editions.some(
    (ed) => ed && (ed.deadlines?.length > 0 || ed.event_start !== null || ed.event_end !== null),
  );
}

export function rankOk(
  conf: Conference | null | undefined,
  schemes: Record<string, unknown> | null | undefined,
  keepIfNoRank: boolean,
): boolean {
  if (!conf || typeof conf !== "object") return false;
  if (!schemes || typeof schemes !== "object") return true;
  const schemeEntries = Object.entries(schemes).map(
    ([name, allowed]) =>
      [
        name.toLowerCase().trim(),
        (Array.isArray(allowed) ? (allowed as string[]) : []).map((v) =>
          String(v).trim().toUpperCase(),
        ),
      ] as const,
  );
  if (schemeEntries.length === 0) return true;

  const confRank = new Map<string, string>();
  for (const [k, v] of Object.entries(conf.rank ?? {})) {
    if (v !== null && v !== undefined) {
      confRank.set(k.toLowerCase().trim(), String(v).trim());
    }
  }

  let hasRank = false;
  for (const [schemeName, allowedValues] of schemeEntries) {
    const rawValue = confRank.get(schemeName);
    if (!rawValue || ABSENT_RANKS.has(rawValue)) continue;
    hasRank = true;
    const normValue = rawValue.toUpperCase();
    if (allowedValues.includes(normValue) || allowedValues.includes(rawValue)) {
      return true;
    }
  }
  return keepIfNoRank && !hasRank;
}
