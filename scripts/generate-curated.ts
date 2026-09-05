import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { conferencesFromJson, deadlineTrackKey, kindOf, roundOf } from "../src/model.ts";
import { canonicalJson, verifyPromotionResolutionBatch } from "../src/promotion.ts";
import { parseFile } from "../src/sources/local.ts";

const ROOT = join(import.meta.dirname, "..");

type JsonRecord = Record<string, any>;

function resolutionId(resolution: JsonRecord): string {
  const body = { ...resolution };
  delete body.resolution_id;
  return `resolution-${createHash("sha256")
    .update(canonicalJson(body))
    .digest("hex")
    .slice(0, 16)}`;
}

function dateToken(value: unknown): string {
  return String(value ?? "")
    .trim()
    .slice(0, 10);
}

function promotedResolution(resolution: JsonRecord): boolean {
  return (
    resolution.decision === "promote" &&
    resolution.normalized &&
    (!resolution.canonicalization ||
      ["add-new-venue", "add-new-edition"].includes(resolution.canonicalization.decision))
  );
}

function resolutionVenueKey(resolution: JsonRecord): string {
  return String(
    (resolution.canonicalization?.decision === "add-new-edition"
      ? resolution.canonicalization.matchedVenueKey
      : undefined) ??
      resolution.normalized?.venue?.key ??
      resolution.candidate,
  );
}

function readYaml(path: string): JsonRecord {
  const value = loadYaml(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${path} must contain a YAML mapping`);
  return value as JsonRecord;
}

function conferenceRows(value: JsonRecord, path: string): JsonRecord[] {
  if (!Array.isArray(value.conferences))
    throw new TypeError(`${path}: conferences must be an array`);
  return value.conferences.map((conference, index) => {
    if (!conference || typeof conference !== "object" || Array.isArray(conference))
      throw new TypeError(`${path}: conferences[${index}] must be a mapping`);
    return conference as JsonRecord;
  });
}

function writeYaml(path: string, value: JsonRecord): void {
  writeFileSync(path, dumpYaml(value, { lineWidth: -1, noRefs: true, sortKeys: true }), "utf8");
}

function enrichResolutionMetadata(
  resolution: JsonRecord,
  legacyConferences: JsonRecord[],
): JsonRecord {
  if (!resolution.normalized) return resolution;
  const normalized = resolution.normalized;
  const venue = normalized.venue ?? {};
  const edition = normalized.edition ?? {};
  const deadline = normalized.deadline ?? {};
  const legacyConference = legacyConferences.find(
    (conference) => String(conference.key ?? "") === resolutionVenueKey(resolution),
  );
  const legacyEditions = (legacyConference?.editions ?? []) as JsonRecord[];
  const legacyEdition =
    legacyEditions.find((item) => Number(item.year) === Number(edition.year)) ??
    (legacyEditions.length === 1 ? legacyEditions[0] : undefined);
  const legacyDeadlines = (legacyEdition?.deadlines ?? []) as JsonRecord[];
  const legacyDeadline = legacyDeadlines.find(
    (item) =>
      String(item.kind ?? "paper") === String(deadline.kind ?? "paper") &&
      Number(item.round ?? 1) === Number(deadline.round ?? 1) &&
      String(item.track ?? "") === String(deadline.track ?? "") &&
      dateToken(item.date) === dateToken(deadline.date),
  );
  const enrichedVenue = { ...venue };
  if (!enrichedVenue.full_name && legacyConference?.full_name)
    enrichedVenue.full_name = legacyConference.full_name;
  if (!enrichedVenue.link && legacyConference?.link) enrichedVenue.link = legacyConference.link;
  const enrichedEdition = { ...edition };
  for (const field of ["link", "place", "date_text"] as const) {
    if (!enrichedEdition[field] && legacyEdition?.[field])
      enrichedEdition[field] = legacyEdition[field];
  }
  const enrichedDeadline = { ...deadline };
  if (enrichedDeadline.label === enrichedDeadline.kind && legacyDeadline?.label)
    enrichedDeadline.label = legacyDeadline.label;
  return {
    ...resolution,
    normalized: {
      ...normalized,
      venue: enrichedVenue,
      edition: enrichedEdition,
      deadline: enrichedDeadline,
    },
  };
}

function batchManifestUpdate(batchDir: string, resolutionText: string): [string, string] | null {
  const manifestPath = join(batchDir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as JsonRecord;
  delete manifest.extra;
  manifest.resolutions = {
    sha256: createHash("sha256").update(resolutionText).digest("hex"),
  };
  return [manifestPath, `${JSON.stringify(manifest, null, 2)}\n`];
}

function rowSortKey(row: JsonRecord): string {
  const normalized = row.normalized ?? {};
  const venue = normalized.venue ?? {};
  const edition = normalized.edition ?? {};
  const deadline = normalized.deadline ?? {};
  return [
    String(venue.key ?? row.candidate ?? ""),
    String(edition.edition_id ?? ""),
    String(deadline.kind ?? "paper"),
    String(deadline.round ?? 1),
    String(deadline.track ?? ""),
    dateToken(deadline.date),
    String(row.resolution_id ?? ""),
  ].join("\0");
}

function curatedFromResolutions(rowsByKey: Map<string, JsonRecord[]>): JsonRecord[] {
  const curated: JsonRecord[] = [];
  for (const key of [...rowsByKey.keys()].sort()) {
    const rows = [...(rowsByKey.get(key) ?? [])].sort((a, b) =>
      rowSortKey(a).localeCompare(rowSortKey(b)),
    );
    const first = rows[0]?.normalized;
    if (!first) continue;
    const venue = first.venue ?? {};
    const byEdition = new Map<string, JsonRecord[]>();
    for (const row of rows) {
      const editionId = String(row.normalized?.edition?.edition_id ?? "");
      if (!editionId)
        throw new Error(`promoted resolution has no edition_id: ${row.resolution_id}`);
      const editionKey = `${Number(row.normalized?.edition?.year)}\0${editionId}`;
      const group = byEdition.get(editionKey) ?? [];
      group.push(row);
      byEdition.set(editionKey, group);
    }
    const editions = [...byEdition.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, group]) => {
        const edition = group[0]!.normalized.edition;
        const seenSlots = new Set<string>();
        const deadlines = group.map((row) => {
          const deadline = row.normalized.deadline;
          const label = String(deadline.label ?? "");
          const kind = kindOf(String(deadline.kind ?? label));
          const slot = [
            key,
            String(edition.edition_id),
            kind,
            String(roundOf(label, Number(deadline.round ?? 1) || 1)),
            deadlineTrackKey(label, kind, String(deadline.track ?? "")),
          ].join("\0");
          if (seenSlots.has(slot)) throw new Error(`duplicate promoted deadline slot: ${slot}`);
          seenSlots.add(slot);
          return {
            ...deadline,
            promotion_ref: {
              batch: row.batch,
              resolution: row.resolution_id,
            },
          };
        });
        const sourceUrl = String(
          (deadlines[0]?.evidence as JsonRecord[] | undefined)?.find((item) =>
            String(item.sourceUrl ?? item.source_url ?? "").trim(),
          )?.sourceUrl ??
            (deadlines[0]?.evidence as JsonRecord[] | undefined)?.[0]?.source_url ??
            "",
        ).trim();
        if (!sourceUrl) throw new Error(`promoted resolution has no evidence URL: ${key}`);
        return {
          year: Number(edition.year),
          id: String(edition.edition_id),
          date_text: String(edition.date_text ?? edition.year ?? ""),
          ...(edition.event_start ? { event_start: edition.event_start } : {}),
          ...(edition.event_end ? { event_end: edition.event_end } : {}),
          link: String(edition.link ?? sourceUrl),
          ...(edition.place ? { place: edition.place } : {}),
          ...(edition.identity ? { identity: edition.identity } : {}),
          ...(edition.call_identity ? { call_identity: edition.call_identity } : {}),
          ...(edition.call_id ? { call_id: edition.call_id } : {}),
          deadlines,
        };
      });
    const evidenceLink = String(
      (editions[0]?.deadlines?.[0]?.evidence as JsonRecord[] | undefined)?.find((item) =>
        String(item.sourceUrl ?? item.source_url ?? "").trim(),
      )?.sourceUrl ?? "",
    ).trim();
    curated.push({
      key,
      title: String(venue.title ?? key),
      full_name: String(venue.full_name ?? venue.title ?? key),
      link: String(venue.link ?? "").trim() || evidenceLink,
      categories: Array.isArray(venue.categories) ? venue.categories : [],
      ...(Array.isArray(venue.tags) && venue.tags.length ? { tags: venue.tags } : {}),
      ...(venue.identity ? { identity: venue.identity } : {}),
      editions,
    });
  }
  return curated;
}

export function generateCurated(
  root = ROOT,
  resolutionOverrides: ReadonlyMap<string, string> = new Map(),
): { manual: number; curated: number; batches: number } {
  const dataRoot = join(root, "data");
  const legacyPath = join(dataRoot, "extra.yaml");
  const legacy = readYaml(legacyPath);
  const legacyConferences = conferenceRows(legacy, legacyPath);
  const snapshotPath = join(dataRoot, "snapshot.json");
  const existingConferences = existsSync(snapshotPath)
    ? conferencesFromJson(JSON.parse(readFileSync(snapshotPath, "utf8")) as JsonRecord)
    : parseFile(legacyPath);
  const appliedByBatch = new Map<string, Map<string, string>>();
  const currentCuratedPath = join(dataRoot, "curated.generated.yaml");
  if (existsSync(currentCuratedPath)) {
    for (const conference of conferenceRows(readYaml(currentCuratedPath), currentCuratedPath)) {
      for (const edition of (conference.editions ?? []) as JsonRecord[]) {
        for (const deadline of (edition.deadlines ?? []) as JsonRecord[]) {
          const ref = deadline.promotion_ref as JsonRecord | undefined;
          const batch = String(ref?.batch ?? "");
          const resolution = String(ref?.resolution ?? "");
          if (!batch || !resolution) continue;
          const kind = String(deadline.kind ?? "paper");
          const effects = appliedByBatch.get(batch) ?? new Map<string, string>();
          effects.set(
            resolution,
            [
              String(conference.key),
              String(edition.id ?? edition.edition_id ?? ""),
              kind,
              String(Number(deadline.round ?? 1) || 1),
              deadlineTrackKey(String(deadline.label ?? ""), kind, String(deadline.track ?? "")),
            ].join("\0"),
          );
          appliedByBatch.set(batch, effects);
        }
      }
    }
  }
  const manualPath = join(dataRoot, "manual.yaml");
  const resolutionsByKey = new Map<string, JsonRecord[]>();
  const migratedKeys = new Set<string>();
  const pendingWrites: Array<[string, string]> = [];

  for (const batch of readdirSync(join(dataRoot, "promotions")).sort()) {
    const batchDir = join(dataRoot, "promotions", batch);
    const path = join(batchDir, "resolutions.json");
    const observationsPath = join(batchDir, "observations.jsonl");
    if (![path, observationsPath, join(batchDir, "manifest.json")].every(existsSync))
      throw new Error(`incomplete promotion batch: ${batch}`);
    const sourceResolutionText = resolutionOverrides.get(path) ?? readFileSync(path, "utf8");
    const raw = JSON.parse(sourceResolutionText) as JsonRecord[];
    verifyPromotionResolutionBatch(observationsPath, sourceResolutionText, {
      existingConferences,
      appliedResolutionEffects: appliedByBatch.get(batch),
    });
    const resolutions: JsonRecord[] = raw.map((resolution) => {
      const enriched = enrichResolutionMetadata(resolution, legacyConferences);
      return {
        ...enriched,
        resolution_id: enriched.resolution_id ?? resolutionId(enriched),
      };
    });
    const resolutionText = `${JSON.stringify(resolutions, null, 2)}\n`;
    pendingWrites.push([path, resolutionText]);
    const manifestUpdate = batchManifestUpdate(batchDir, resolutionText);
    if (manifestUpdate) pendingWrites.push(manifestUpdate);
    for (const resolution of resolutions) {
      if (!promotedResolution(resolution)) continue;
      const key = resolutionVenueKey(resolution);
      if (resolution.canonicalization?.decision !== "add-new-edition") migratedKeys.add(key);
      const rows = resolutionsByKey.get(key) ?? [];
      rows.push({ ...resolution, batch });
      resolutionsByKey.set(key, rows);
    }
  }

  const manualInputPath = existsSync(manualPath) ? manualPath : legacyPath;
  const manualInput = existsSync(manualPath) ? readYaml(manualPath) : legacy;
  const manualSource = conferenceRows(manualInput, manualInputPath);
  const manual = manualSource.filter((conference) => !migratedKeys.has(String(conference.key)));
  const curated = curatedFromResolutions(resolutionsByKey);

  const missingRefs = curated.flatMap((conference) =>
    (conference.editions ?? []).flatMap((edition: JsonRecord) =>
      (edition.deadlines ?? [])
        .filter((deadline: JsonRecord) => !deadline.promotion_ref)
        .map(() => `${conference.key}/${edition.id}`),
    ),
  );
  if (missingRefs.length > 0) {
    throw new Error(`curated deadlines without promotion_ref: ${missingRefs.join(", ")}`);
  }

  for (const [path, text] of pendingWrites) writeFileSync(path, text, "utf8");
  if (
    !existsSync(manualPath) ||
    manual.length !== manualSource.length ||
    manual.some((conference, index) => conference.key !== manualSource[index]?.key)
  )
    writeYaml(manualPath, { schema_version: 1, conferences: manual });
  writeYaml(join(dataRoot, "curated.generated.yaml"), {
    schema_version: 1,
    generated_from: "data/promotions/*/resolutions.json",
    conferences: curated,
  });

  return { manual: manual.length, curated: curated.length, batches: resolutionsByKey.size };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  process.stdout.write(`${JSON.stringify(generateCurated())}\n`);
