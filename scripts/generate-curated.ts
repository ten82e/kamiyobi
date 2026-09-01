import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { canonicalJson } from "../src/promotion.ts";

const ROOT = join(import.meta.dirname, "..");
const DATA = join(ROOT, "data");

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

function readYaml(path: string): JsonRecord {
  const value = loadYaml(readFileSync(path, "utf8"));
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function writeYaml(path: string, value: JsonRecord): void {
  writeFileSync(path, dumpYaml(value, { lineWidth: -1, noRefs: true, sortKeys: true }), "utf8");
}

function updateBatchFiles(
  batch: string,
  batchDir: string,
  resolutions: JsonRecord[],
  resolutionText: string,
): void {
  const manifestPath = join(batchDir, "manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as JsonRecord;
    manifest.resolutions = {
      sha256: createHash("sha256").update(resolutionText).digest("hex"),
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  const extraPath = join(batchDir, "extra.yaml");
  if (!existsSync(extraPath)) return;
  const extra = readYaml(extraPath);
  const byCandidate = new Map<string, JsonRecord[]>();
  for (const resolution of resolutions) {
    if (!promotedResolution(resolution)) continue;
    const rows = byCandidate.get(String(resolution.candidate)) ?? [];
    rows.push(resolution);
    byCandidate.set(String(resolution.candidate), rows);
  }
  for (const conference of (extra.conferences ?? []) as JsonRecord[]) {
    const rows = byCandidate.get(String(conference.key)) ?? [];
    const used = new Set<number>();
    for (const edition of (conference.editions ?? []) as JsonRecord[]) {
      for (const deadline of (edition.deadlines ?? []) as JsonRecord[]) {
        const index = rows.findIndex((resolution, i) => {
          if (used.has(i)) return false;
          const normalized = resolution.normalized?.deadline ?? {};
          return (
            String(normalized.kind ?? "paper") === String(deadline.kind ?? "paper") &&
            dateToken(normalized.date) === dateToken(deadline.date)
          );
        });
        if (index < 0) continue;
        used.add(index);
        deadline.promotion_ref = {
          batch,
          resolution: rows[index]!.resolution_id,
        };
      }
    }
  }
  const extraText = dumpYaml(extra, { lineWidth: -1, noRefs: true, sortKeys: true });
  writeFileSync(extraPath, extraText, "utf8");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as JsonRecord;
    manifest.extra = { sha256: createHash("sha256").update(extraText).digest("hex") };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
}

const legacy = readYaml(join(DATA, "extra.yaml"));
const manualPath = join(DATA, "manual.yaml");
const resolutionsByKey = new Map<string, JsonRecord[]>();
const promotedKeys = new Set<string>();

for (const batch of readdirSync(join(DATA, "promotions")).sort()) {
  const batchDir = join(DATA, "promotions", batch);
  const path = join(batchDir, "resolutions.json");
  if (!existsSync(path)) continue;
  const raw = JSON.parse(readFileSync(path, "utf8")) as JsonRecord[];
  const resolutions = raw.map((resolution) => ({
    ...resolution,
    resolution_id: resolution.resolution_id ?? resolutionId(resolution),
  }));
  const resolutionText = `${JSON.stringify(resolutions, null, 2)}\n`;
  writeFileSync(path, resolutionText, "utf8");
  updateBatchFiles(batch, batchDir, resolutions, resolutionText);
  for (const resolution of resolutions) {
    if (!promotedResolution(resolution)) continue;
    const key = String(resolution.normalized.venue.key ?? resolution.candidate);
    promotedKeys.add(key);
    const rows = resolutionsByKey.get(key) ?? [];
    rows.push({ ...resolution, batch });
    resolutionsByKey.set(key, rows);
  }
}

const legacyConferences = (legacy.conferences ?? []) as JsonRecord[];
const manualInput = existsSync(manualPath) ? readYaml(manualPath) : legacy;
const manualSource = (manualInput.conferences ?? legacyConferences) as JsonRecord[];
const manual = manualSource.filter((conference) => !promotedKeys.has(String(conference.key)));
if (
  !existsSync(manualPath) ||
  manual.length !== manualSource.length ||
  manual.some((conference, index) => conference.key !== manualSource[index]?.key)
)
  writeYaml(manualPath, { schema_version: 1, conferences: manual });
const curated = legacyConferences
  .filter((conference) => promotedKeys.has(String(conference.key)))
  .map((conference) => {
    const rows = resolutionsByKey.get(String(conference.key)) ?? [];
    const used = new Set<number>();
    for (const edition of (conference.editions ?? []) as JsonRecord[]) {
      for (const deadline of (edition.deadlines ?? []) as JsonRecord[]) {
        const index = rows.findIndex((resolution, i) => {
          if (used.has(i)) return false;
          const normalized = resolution.normalized?.deadline ?? {};
          return (
            String(normalized.kind ?? "paper") === String(deadline.kind ?? "paper") &&
            dateToken(normalized.date) === dateToken(deadline.date)
          );
        });
        if (index < 0) continue;
        used.add(index);
        deadline.promotion_ref = {
          batch: rows[index]!.batch,
          resolution: rows[index]!.resolution_id,
        };
      }
    }
    return conference;
  });

writeYaml(join(DATA, "curated.generated.yaml"), {
  schema_version: 1,
  generated_from: "data/promotions/*/resolutions.json",
  conferences: curated,
});

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

process.stdout.write(
  `${JSON.stringify({ manual: manual.length, curated: curated.length, batches: resolutionsByKey.size })}\n`,
);
