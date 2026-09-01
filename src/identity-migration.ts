import { dateOnlyWindow, deadlineTrackKey } from "./model.ts";

export const IDENTITY_MIGRATION_SCHEMA_VERSION = 1;
export const IDENTITY_REVISION = "identity-v1";

export type IdentityMigrationAction = "rename" | "duplicate-collapse" | "official-supersession";

export interface DeadlineIdentity {
  venue: string;
  edition: string;
  kind: string;
  round: number;
  track: string;
}

export interface DeadlineIdentitySelector extends DeadlineIdentity {
  /** `*` keeps source-local edition and label-derived track IDs out of the contract. */
  edition: string;
  earliest_utc?: string;
  latest_utc?: string;
}

export interface IdentityMigration {
  from: DeadlineIdentitySelector;
  to: DeadlineIdentity;
  action: IdentityMigrationAction;
  evidence_ref: string;
}

export interface IdentityMigrationManifest {
  schema_version: typeof IDENTITY_MIGRATION_SCHEMA_VERSION;
  from_identity_revision: string;
  to_identity_revision: string;
  migrations: IdentityMigration[];
}

type JsonRecord = Record<string, unknown>;

const ACTIONS = new Set<IdentityMigrationAction>([
  "rename",
  "duplicate-collapse",
  "official-supersession",
]);

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => record(item) !== null)
    : [];
}

function roundOf(value: unknown): number {
  const round = Number(value ?? 1);
  return Number.isInteger(round) && round >= 1 ? round : 1;
}

export function identityKey(identity: DeadlineIdentity): string {
  return [identity.venue, identity.edition, identity.kind, identity.round, identity.track].join(
    "|",
  );
}

function selectorKey(selector: DeadlineIdentitySelector): string {
  return [identityKey(selector), selector.earliest_utc ?? "", selector.latest_utc ?? ""].join("\0");
}

function endpoint(
  value: unknown,
  from: boolean,
): { identity: DeadlineIdentitySelector; errors: string[] } {
  const raw = record(value);
  if (!raw) {
    return { identity: {} as DeadlineIdentitySelector, errors: ["endpoint must be an object"] };
  }
  const errors: string[] = [];
  const venue = typeof raw.venue === "string" ? raw.venue.trim() : "";
  const edition = typeof raw.edition === "string" ? raw.edition.trim() : "";
  const kind = typeof raw.kind === "string" ? raw.kind.trim() : "";
  const track = typeof raw.track === "string" ? raw.track.trim() : "";
  const round = Number(raw.round);
  if (!venue) errors.push("venue is required");
  if (!edition || (from && edition !== "*" && edition.trim() === "")) {
    errors.push("edition is required");
  } else if (!from && edition === "*") {
    errors.push("to edition cannot be a wildcard");
  }
  if (!kind) errors.push("kind is required");
  if (typeof raw.track !== "string") errors.push("track is required");
  else if (!from && track === "*") errors.push("to track cannot be a wildcard");
  if (!Number.isInteger(round) || round < 1) errors.push("round must be a positive integer");
  if (typeof raw.earliest_utc !== "undefined" && typeof raw.latest_utc === "undefined")
    errors.push("from time range must include latest_utc");
  if (typeof raw.latest_utc !== "undefined" && typeof raw.earliest_utc === "undefined")
    errors.push("from time range must include earliest_utc");
  const earliest = typeof raw.earliest_utc === "string" ? Date.parse(raw.earliest_utc) : Number.NaN;
  const latest = typeof raw.latest_utc === "string" ? Date.parse(raw.latest_utc) : Number.NaN;
  if (typeof raw.earliest_utc !== "undefined" && !Number.isFinite(earliest))
    errors.push("earliest_utc is invalid");
  if (typeof raw.latest_utc !== "undefined" && !Number.isFinite(latest))
    errors.push("latest_utc is invalid");
  if (Number.isFinite(earliest) && Number.isFinite(latest) && earliest > latest)
    errors.push("earliest_utc is after latest_utc");
  if (!from && (typeof raw.earliest_utc !== "undefined" || typeof raw.latest_utc !== "undefined"))
    errors.push("to endpoint must not include a time range");
  return {
    identity: {
      venue,
      edition: edition || (from ? "*" : ""),
      kind,
      round,
      track,
      ...(typeof raw.earliest_utc === "string"
        ? { earliest_utc: new Date(earliest).toISOString() }
        : {}),
      ...(typeof raw.latest_utc === "string" ? { latest_utc: new Date(latest).toISOString() } : {}),
    },
    errors,
  };
}

function migrationGraphHasCycle(
  migrations: Array<Pick<IdentityMigration, "from" | "to">>,
): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (identity: DeadlineIdentity): boolean => {
    const key = identityKey(identity);
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    const next = migrations
      .filter(
        ({ from }) =>
          from.venue === identity.venue &&
          (from.edition === "*" || from.edition === identity.edition) &&
          from.kind === identity.kind &&
          from.round === identity.round &&
          (from.track === "*" || from.track === identity.track),
      )
      .some(({ to }) => visit(to));
    visiting.delete(key);
    visited.add(key);
    return next;
  };
  return migrations.some(({ to }) => visit(to));
}

/** Validate a manifest before it is allowed to relax the health gate. */
export function validateIdentityMigrationManifest(
  value: unknown,
  targetKeys?: ReadonlySet<string>,
): string[] {
  if (value === undefined) return [];
  const raw = record(value);
  if (!raw) return ["identity migration manifest must be an object"];
  const errors: string[] = [];
  if (raw.schema_version !== IDENTITY_MIGRATION_SCHEMA_VERSION)
    errors.push("schema_version must be 1");
  for (const key of ["from_identity_revision", "to_identity_revision"] as const)
    if (typeof raw[key] !== "string" || !raw[key].trim()) errors.push(`${key} is required`);
  if (!Array.isArray(raw.migrations)) {
    errors.push("migrations must be an array");
    return errors;
  }

  const fromKeys = new Map<string, string>();
  const targetActions = new Map<string, IdentityMigrationAction[]>();
  const graph: Array<Pick<IdentityMigration, "from" | "to">> = [];
  raw.migrations.forEach((item, index) => {
    const migration = record(item);
    if (!migration) {
      errors.push(`migrations[${index}] must be an object`);
      return;
    }
    const from = endpoint(migration.from, true);
    const to = endpoint(migration.to, false);
    for (const error of from.errors) errors.push(`migrations[${index}].from: ${error}`);
    for (const error of to.errors) errors.push(`migrations[${index}].to: ${error}`);
    const action = migration.action;
    if (typeof action !== "string" || !ACTIONS.has(action as IdentityMigrationAction))
      errors.push(`migrations[${index}].action is invalid`);
    if (typeof migration.evidence_ref !== "string" || !migration.evidence_ref.trim())
      errors.push(`migrations[${index}].evidence_ref is required`);
    if (from.errors.length > 0 || to.errors.length > 0 || typeof action !== "string") return;
    const typedAction = action as IdentityMigrationAction;
    const fromKey = selectorKey(from.identity);
    const toKey = identityKey(to.identity);
    const priorTarget = fromKeys.get(fromKey);
    if (priorTarget !== undefined && priorTarget !== toKey)
      errors.push(`multiple migration targets for ${fromKey}`);
    else if (priorTarget === toKey) errors.push(`duplicate migration source: ${fromKey}`);
    fromKeys.set(fromKey, toKey);
    const actions = targetActions.get(toKey) ?? [];
    actions.push(typedAction);
    targetActions.set(toKey, actions);
    if (targetKeys && !targetKeys.has(toKey))
      errors.push(`migration target does not exist: ${toKey}`);
    const sourceKey = identityKey(from.identity);
    if (sourceKey === toKey) errors.push(`migration self-loop: ${toKey}`);
    graph.push({ from: from.identity, to: to.identity });
  });
  for (const [toKey, actions] of targetActions) {
    if (actions.length > 1 && actions.some((action) => action !== "duplicate-collapse"))
      errors.push(`multiple sources for ${toKey} require duplicate-collapse`);
  }
  if (migrationGraphHasCycle(graph)) errors.push("identity migration cycle detected");
  return [...new Set(errors)].sort();
}

export function isIdentityMigrationManifest(value: unknown): value is IdentityMigrationManifest {
  return validateIdentityMigrationManifest(value).length === 0 && record(value) !== null;
}

export function matchesIdentitySelector(
  selector: DeadlineIdentitySelector,
  identity: DeadlineIdentity,
  earliestUtc: string,
  latestUtc: string,
): boolean {
  if (
    selector.venue !== identity.venue ||
    (selector.edition !== "*" && selector.edition !== identity.edition) ||
    selector.kind !== identity.kind ||
    selector.round !== identity.round ||
    (selector.track !== "*" && selector.track !== identity.track)
  )
    return false;
  return (
    (selector.earliest_utc === undefined || selector.earliest_utc === earliestUtc) &&
    (selector.latest_utc === undefined || selector.latest_utc === latestUtc)
  );
}

function deadlineRange(deadline: JsonRecord): [string, string] | null {
  const exact = Date.parse(String(deadline.utc ?? ""));
  if (Number.isFinite(exact)) {
    const iso = new Date(exact).toISOString();
    return [iso, iso];
  }
  const earliest = Date.parse(String(deadline.earliest_utc ?? ""));
  const latest = Date.parse(String(deadline.latest_utc ?? ""));
  if (Number.isFinite(earliest) && Number.isFinite(latest))
    return [new Date(earliest).toISOString(), new Date(latest).toISOString()];
  const window = dateOnlyWindow(String(deadline.local_date ?? ""));
  return window
    ? [window.earliestPossibleUtc.toISOString(), window.latestPossibleUtc.toISOString()]
    : null;
}

/** Generate explicit slot migrations from the public legacy-key redirects. */
export function identityMigrationManifestForData(
  data: Record<string, unknown>,
): IdentityMigrationManifest {
  const redirects = record(data.legacy_key_redirects) ?? {};
  const aliasCounts = new Map<string, number>();
  for (const target of Object.values(redirects)) {
    if (typeof target === "string" && target.trim())
      aliasCounts.set(target, (aliasCounts.get(target) ?? 0) + 1);
  }
  const candidates: Array<{ migration: IdentityMigration; range: [string, string] }> = [];
  for (const conference of records(data.conferences)) {
    const canonicalVenue = String(conference.key ?? "").trim();
    if (!canonicalVenue) continue;
    const aliases = Object.entries(redirects)
      .filter(([, target]) => target === canonicalVenue)
      .map(([legacy]) => legacy.trim())
      .filter(Boolean)
      .sort();
    if (aliases.length === 0) continue;
    for (const edition of records(conference.editions)) {
      if (edition.estimated === true) continue;
      const editionId = String(edition.id ?? edition.edition_id ?? edition.year ?? "").trim();
      if (!editionId) continue;
      for (const deadline of records(edition.deadlines)) {
        const range = deadlineRange(deadline);
        if (!range) continue;
        const kind = String(deadline.kind ?? "other").trim() || "other";
        const track = deadlineTrackKey(
          String(deadline.label ?? ""),
          kind,
          String(deadline.track ?? ""),
        );
        const to: DeadlineIdentity = {
          venue: canonicalVenue,
          edition: editionId,
          kind,
          round: roundOf(deadline.round),
          track,
        };
        for (const legacyVenue of aliases) {
          candidates.push({
            migration: {
              from: {
                venue: legacyVenue,
                edition: "*",
                kind: to.kind,
                round: to.round,
                track: "*",
              },
              to,
              action: (aliasCounts.get(canonicalVenue) ?? 0) > 1 ? "duplicate-collapse" : "rename",
              evidence_ref: `data://legacy-key-redirect/${legacyVenue}->${canonicalVenue}`,
            },
            range,
          });
        }
      }
    }
  }
  const bySource = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const key = selectorKey(candidate.migration.from);
    bySource.set(key, [...(bySource.get(key) ?? []), candidate]);
  }
  const migrations: IdentityMigration[] = [];
  for (const group of bySource.values()) {
    if (group.length === 1) {
      migrations.push(group[0].migration);
      continue;
    }
    const ranged = group.map(({ migration, range }) => ({
      ...migration,
      from: { ...migration.from, earliest_utc: range[0], latest_utc: range[1] },
    }));
    const byRangedSource = new Map<string, IdentityMigration[]>();
    for (const migration of ranged) {
      const key = selectorKey(migration.from);
      byRangedSource.set(key, [...(byRangedSource.get(key) ?? []), migration]);
    }
    for (const rangedGroup of byRangedSource.values()) {
      // ponytail: unresolved same-time ambiguity stays gated; add a source-specific manifest entry when needed.
      if (rangedGroup.length === 1) migrations.push(rangedGroup[0]);
    }
  }
  migrations.sort((left, right) => selectorKey(left.from).localeCompare(selectorKey(right.from)));
  return {
    schema_version: IDENTITY_MIGRATION_SCHEMA_VERSION,
    from_identity_revision: "legacy-public-key",
    to_identity_revision: IDENTITY_REVISION,
    migrations,
  };
}
