import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import { generateCurated } from "../scripts/generate-curated.ts";
import {
  type Candidate,
  parseCandidateRegistry,
  splitCandidateLifecycle,
} from "../src/discover.ts";
import { type Conference, conferencesFromJson } from "../src/model.ts";
import { writePromotionBatch } from "../src/promotion.ts";
import { LocalSource, localSourcePaths, parseFile } from "../src/sources/local.ts";
import { REPO_ROOT } from "./helpers.ts";

const issueKeys = [
  "bdiot-2026",
  "admit-2026",
  "ccisc-2026",
  "csp-2027",
  "icaici-2026",
  "icbda2027",
  "iccns-2026",
  "iccr-2026",
  "icimt-2026",
  "icmip-2027",
  "keir-cikm2026",
  "raai2026",
];

function writeVerifiedBatch(
  batchDir: string,
  rows: Array<
    Record<string, unknown> & {
      candidate: string;
      normalized: {
        venue: Record<string, unknown> & {
          title: string;
          categories: string[];
          tags?: string[];
          identity?: { venueId?: string; sourceIds?: Record<string, string> };
        };
        edition: Record<string, unknown> & {
          year: number;
          identity?: { editionId?: string; sourceIds?: Record<string, string> };
          call_identity?: Record<string, unknown>;
          call_id?: string;
        };
        deadline: Record<string, unknown> & {
          date: string;
          kind: string;
          round?: number;
          track?: string;
          evidence: Array<{ sourceUrl: string }>;
        };
      };
    }
  >,
  existingConferences?: Conference[],
) {
  const observations = rows.map((row, index) => {
    const venue = row.normalized.venue;
    const edition = row.normalized.edition;
    const deadline = row.normalized.deadline;
    const sourceUrl = deadline.evidence[0]?.sourceUrl;
    if (!sourceUrl) throw new Error("test deadline evidence is required");
    const body = `Paper deadline: ${deadline.date}`;
    const bodyPath = join(batchDir, `capture-${index}.body`);
    const contentHash = createHash("sha256").update(body).digest("hex");
    writeFileSync(bodyPath, body);
    return {
      candidate: row.candidate,
      sourceUrl,
      sourceClass: "official-cfp",
      officialDomains: [new URL(sourceUrl).hostname],
      title: venue.title,
      categories: venue.categories,
      tags: venue.tags ?? [],
      reviewState: "reviewed",
      categoryReviewState: "reviewed",
      deadline: {
        date: deadline.date,
        kind: deadline.kind,
        round: deadline.round,
        track: deadline.track,
      },
      eventDate: `${edition.year}-04-01`,
      eventEndDate: `${edition.year}-04-01`,
      rawExcerpt: body,
      evidence: {
        sourceUrl,
        sourceClass: "official-cfp",
        sourceRevision: `sha256:${contentHash}`,
        retrievedAt: "2026-09-02T00:00:00.000Z",
        verifiedAt: "2026-09-02T00:00:00.000Z",
        contentHash,
        rawExcerpt: body,
      },
      capture: {
        requestedUrl: sourceUrl,
        finalUrl: sourceUrl,
        status: 200,
        headers: {},
        retrievedAt: "2026-09-02T00:00:00.000Z",
        contentHash,
        parserVersion: "test/1",
        bodyPath,
        excerpt: body,
        candidates: [{ rawExcerpt: body, date: deadline.date, kind: deadline.kind }],
        sourceRevision: `sha256:${contentHash}`,
        officialDomains: [new URL(sourceUrl).hostname],
      },
      venueIdentity: venue.identity,
      editionIdentity: edition.identity,
      callIdentity: edition.call_identity ?? edition.call_id,
    };
  });
  const observationsPath = join(batchDir, "observations.jsonl");
  writeFileSync(observationsPath, `${observations.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return writePromotionBatch(
    observationsPath,
    join(batchDir, "resolutions.json"),
    join(batchDir, "manifest.json"),
    { existingConferences },
  );
}

describe("canonical local inputs", () => {
  it("uses whichever canonical local files exist and rejects malformed shape", () => {
    const root = mkdtempSync(join(tmpdir(), "kamiyobi-local-inputs-"));
    const data = join(root, "data");
    mkdirSync(data, { recursive: true });
    const manual = join(data, "manual.yaml");
    writeFileSync(manual, "conferences: []\n");
    expect(localSourcePaths(root)).toEqual([manual]);
    expect(() => parseFile(join(data, "manual.yaml"))).not.toThrow();
    writeFileSync(manual, "not_conferences: true\n");
    expect(() => parseFile(manual)).toThrow(/conferences must be an array/);
  });

  it("keeps manual and generated promotion data disjoint and traceable", () => {
    const paths = localSourcePaths(REPO_ROOT);
    expect(paths.map((path) => path.split("/").at(-1))).toEqual([
      "manual.yaml",
      "curated.generated.yaml",
    ]);
    const manual = parseFile(paths[0]);
    const curated = parseFile(paths[1]);
    const legacy = parseFile(join(REPO_ROOT, "data", "extra.yaml"));
    const manualKeys = new Set(manual.map((conference) => conference.key));
    const curatedKeys = new Set(curated.map((conference) => conference.key));
    expect(curated.every((conference) => !manualKeys.has(conference.key))).toBe(true);
    expect(new Set(legacy.map((conference) => conference.key))).toEqual(manualKeys);
    expect(legacy.every((conference) => !curatedKeys.has(conference.key))).toBe(true);

    const resolutionIds = new Set<string>();
    for (const batch of readdirSync(join(REPO_ROOT, "data", "promotions"))) {
      expect(existsSync(join(REPO_ROOT, "data", "promotions", batch, "extra.yaml"))).toBe(false);
      const resolutions = JSON.parse(
        readFileSync(join(REPO_ROOT, "data", "promotions", batch, "resolutions.json"), "utf8"),
      ) as Array<{ resolution_id?: string }>;
      for (const resolution of resolutions) {
        if (resolution.resolution_id) resolutionIds.add(`${batch}\0${resolution.resolution_id}`);
      }
    }
    const refs = curated.flatMap((conference) =>
      conference.editions.flatMap((edition) =>
        edition.deadlines.flatMap((deadline) => {
          const ref = deadline.promotion_ref;
          return ref ? [`${ref.batch}\0${ref.resolution}`] : [];
        }),
      ),
    );
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((ref) => resolutionIds.has(ref))).toBe(true);
  });

  it("generates promotion data from resolutions instead of legacy extra data", () => {
    const root = mkdtempSync(join(tmpdir(), "kamiyobi-curation-source-"));
    const data = join(root, "data");
    const batch = "2026-09-02-demo";
    const batchDir = join(data, "promotions", batch);
    mkdirSync(batchDir, { recursive: true });
    writeFileSync(
      join(data, "extra.yaml"),
      "conferences:\n  - key: demo\n    title: Legacy\n    editions:\n      - year: 2027\n        id: demo27\n        date_text: 2027\n        deadlines:\n          - {kind: paper, date: '2026-01-01', precision: date-only}\n",
    );
    writeFileSync(join(data, "manual.yaml"), "conferences: []\n");
    writeFileSync(join(data, "snapshot.json"), '{"conferences":[]}\n');
    writeVerifiedBatch(batchDir, [
      {
        resolution_id: "promotion-demo",
        candidate: "demo",
        decision: "promote",
        verifiedFields: ["venue", "date"],
        reason: "verified",
        normalized: {
          venue: { key: "demo", title: "Canonical Demo", categories: ["systems"], tags: [] },
          edition: { year: 2027, edition_id: "demo-2027", date_text: "2027-04-01" },
          deadline: {
            kind: "paper",
            label: "paper",
            round: 1,
            track: "",
            precision: "date-only",
            date: "2026-10-01",
            evidence: [{ sourceUrl: "https://demo.example/cfp" }],
          },
        },
      },
    ]);

    expect(generateCurated(root)).toMatchObject({ manual: 0, curated: 1 });
    const generated = loadYaml(readFileSync(join(data, "curated.generated.yaml"), "utf8")) as {
      conferences: Array<{
        title: string;
        editions: Array<{ deadlines: Array<{ date: string }> }>;
      }>;
    };
    expect(generated.conferences[0]?.title).toBe("Canonical Demo");
    expect(generated.conferences[0]?.editions[0]?.deadlines[0]?.date).toBe("2026-10-01");
  });

  it("keeps manual editions when a promoted edition is added to the same venue", async () => {
    const root = mkdtempSync(join(tmpdir(), "kamiyobi-curation-new-edition-"));
    const data = join(root, "data");
    const batchDir = join(data, "promotions", "2026-09-02-demo");
    mkdirSync(batchDir, { recursive: true });
    const manual = [
      "conferences:",
      "  - key: demo",
      "    title: Demo",
      "    categories: [systems]",
      "    identity:",
      "      venueId: demo-series",
      "      sourceIds: {official: demo}",
      "    editions:",
      "      - year: 2026",
      "        id: demo",
      "        deadlines:",
      "          - {kind: paper, date: '2026-01-01', precision: date-only}",
      "",
    ].join("\n");
    writeFileSync(join(data, "extra.yaml"), manual);
    writeFileSync(join(data, "manual.yaml"), manual);
    const promoted = writeVerifiedBatch(
      batchDir,
      [2027, 2028].map((year) => ({
        resolution_id: `promotion-demo-${year}`,
        candidate: "old-demo",
        decision: "promote",
        canonicalization: { decision: "add-new-edition", matchedVenueKey: "demo" },
        normalized: {
          venue: {
            key: "old-demo",
            title: "Old Demo",
            categories: ["systems"],
            identity: { venueId: "demo-series", sourceIds: { official: "demo" } },
          },
          edition: {
            year,
            edition_id: "demo",
            identity: { editionId: `demo-${year}`, sourceIds: { official: String(year) } },
            call_identity: {
              seriesId: "demo-series",
              editionId: `demo-${year}`,
              callId: `demo-call-${year}`,
              parentEventId: null,
            },
          },
          deadline: {
            kind: "paper",
            round: 1,
            date: `${year - 1}-10-01`,
            precision: "date-only",
            evidence: [{ sourceUrl: `https://demo.example/${year}/cfp` }],
          },
        },
      })),
      parseFile(join(data, "manual.yaml")),
    );

    expect(generateCurated(root)).toMatchObject({ manual: 1, curated: 1 });
    expect(
      parseFile(join(data, "manual.yaml"))[0]?.editions.map((edition) => edition.year),
    ).toEqual([2026]);
    const generated = parseFile(join(data, "curated.generated.yaml"))[0];
    expect(generated?.key).toBe("demo");
    expect(generated?.editions.map((edition) => edition.year)).toEqual([2027, 2028]);
    expect(generated?.identity?.sourceIds?.official).toBe("demo");
    expect(generated?.editions[0]?.identity?.editionId).toBe("demo-2027");
    expect(generated?.editions[0]?.call_identity?.callId).toBe("demo-call-2027");
    const loaded = await new LocalSource(localSourcePaths(root)).load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.editions.map((edition) => edition.year)).toEqual([2026, 2027, 2028]);
    expect(loaded[0]?.editions[1]?.deadlines[0]?.promotion_ref).toEqual({
      batch: "2026-09-02-demo",
      resolution: promoted[0]?.resolution_id,
    });
  });

  it("does not rewrite canonical inputs when generated promotion data is invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "kamiyobi-curation-atomic-"));
    const data = join(root, "data");
    const batchDir = join(data, "promotions", "2026-09-02-demo");
    mkdirSync(batchDir, { recursive: true });
    writeFileSync(join(data, "extra.yaml"), "conferences: []\n");
    writeFileSync(join(data, "manual.yaml"), "conferences: []\n");
    const promoted = (date: string, track: string) => ({
      candidate: "demo",
      decision: "promote",
      normalized: {
        venue: { key: "demo", title: "Demo", categories: ["systems"] },
        edition: { year: 2027, edition_id: "demo-2027" },
        deadline: {
          kind: "paper",
          round: 1,
          track,
          date,
          evidence: [{ sourceUrl: "https://demo.example/cfp" }],
        },
      },
    });
    writeFileSync(join(data, "snapshot.json"), '{"conferences":[]}\n');
    writeVerifiedBatch(batchDir, [promoted("2026-10-01", "Main"), promoted("2026-11-01", "main")]);
    const resolutionsPath = join(batchDir, "resolutions.json");
    const manifestPath = join(batchDir, "manifest.json");
    const resolutionsText = readFileSync(resolutionsPath, "utf8");
    const manifestText = readFileSync(manifestPath, "utf8");

    expect(() => generateCurated(root)).toThrow(/duplicate promoted deadline slot/);
    expect(readFileSync(resolutionsPath, "utf8")).toBe(resolutionsText);
    expect(readFileSync(manifestPath, "utf8")).toBe(manifestText);
    expect(existsSync(join(data, "curated.generated.yaml"))).toBe(false);
  });

  it("rejects a promotion batch when any required artifact is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "kamiyobi-curation-incomplete-"));
    const data = join(root, "data");
    const batchDir = join(data, "promotions", "2026-09-02-demo");
    mkdirSync(batchDir, { recursive: true });
    writeFileSync(join(data, "extra.yaml"), "conferences: []\n");
    writeFileSync(join(batchDir, "observations.jsonl"), "");
    writeFileSync(join(batchDir, "manifest.json"), "{}\n");

    expect(() => generateCurated(root)).toThrow(/incomplete promotion batch/);
  });

  it("does not create an empty manual file from a malformed legacy root", () => {
    const root = mkdtempSync(join(tmpdir(), "kamiyobi-curation-invalid-root-"));
    const data = join(root, "data");
    mkdirSync(join(data, "promotions"), { recursive: true });
    writeFileSync(join(data, "extra.yaml"), "- invalid-root\n");

    expect(() => generateCurated(root)).toThrow(/must contain a YAML mapping/);
    expect(() => readFileSync(join(data, "manual.yaml"), "utf8")).toThrow();
  });

  it("attaches one explicit CallIdentity and legacy id set to every Issue #677 group", () => {
    const conferences = parseFile(join(REPO_ROOT, "data", "manual.yaml"));
    const byKey = new Map(conferences.map((conference) => [conference.key, conference]));
    for (const key of issueKeys) {
      const edition = byKey.get(key)?.editions[0];
      expect(edition, key).toBeDefined();
      expect(edition?.call_identity).toMatchObject({
        seriesId: expect.any(String),
        editionId: expect.any(String),
        callId: expect.any(String),
        parentEventId: null,
      });
      expect(edition?.legacy_ids?.length).toBeGreaterThan(0);
      expect(byKey.get(key)?.editions).toHaveLength(1);
    }
  });

  it("retains superseded deadline values for reconciled changes", () => {
    const conferences = parseFile(join(REPO_ROOT, "data", "manual.yaml"));
    const byKey = new Map(conferences.map((conference) => [conference.key, conference]));
    const expected = new Map([
      ["admit-2026", ["2026-09-30"]],
      ["ccisc-2026", ["2026-08-31"]],
      ["icaici-2026", ["2026-08-28"]],
      ["iccr-2026", ["2026-08-25"]],
      ["iccns-2026", ["2026-09-10"]],
      ["keir-cikm2026", ["2026-09-13", "2026-08-24"]],
    ]);
    for (const [key, values] of expected) {
      const deadlines = byKey.get(key)?.editions[0]?.deadlines ?? [];
      const history = deadlines.flatMap((deadline) => deadline.superseded_deadlines ?? []);
      expect(history.map((item) => item.value).sort(), key).toEqual([...values].sort());
      expect(history.every((item) => item.status === "superseded")).toBe(true);
      expect(history.every((item) => item.supersededBy.startsWith(`${key}|`))).toBe(true);
    }
  });

  it("keeps the official ICCNS submission date as the only current submission slot", () => {
    const conference = parseFile(join(REPO_ROOT, "data", "manual.yaml")).find(
      (item) => item.key === "iccns-2026",
    );
    expect(conference?.editions[0]?.deadlines).toHaveLength(1);
    expect(conference?.editions[0]?.deadlines[0]).toMatchObject({
      kind: "paper",
      precision: "date-only",
      local_date: "2026-08-01",
      evidence: [
        {
          sourceClass: "official-cfp",
          sourceUrl: "https://www.iccns.org/iccns_cfp.pdf",
          verifiedFields: ["date", "kind"],
        },
      ],
    });
  });

  it("records the corrected ICCNS slot in the PR semantic reconciliation", () => {
    const report = JSON.parse(
      readFileSync(join(REPO_ROOT, "data", "semantic-reconciliation.json"), "utf8"),
    );
    const comparison = report.comparisons.find((item: any) => item.pull_request === 678);
    expect(comparison.current_only_slots).toContainEqual(
      expect.objectContaining({
        venue_id: "iccns-2026",
        edition_id: "iccns-202626",
        call_id: "iccns-2026",
        deadline_kind: "paper",
        normalized_value: "2026-08-01",
        event_start: "2026-12-19",
        event_end: "2026-12-21",
        official_evidence: [
          expect.objectContaining({ source_url: "https://www.iccns.org/iccns_cfp.pdf" }),
        ],
        legacy_mapping: expect.objectContaining({
          legacy_keys: ["iccns-ei-2026"],
          legacy_edition_ids: ["iccns-ei-202626"],
        }),
      }),
    );
    expect(
      comparison.reference_only_slots
        .filter((item: any) => item.venue_id === "iccns-2026")
        .map((item: any) => item.deadline_kind)
        .sort(),
    ).toEqual(["abstract", "paper"]);

    const required = report.semantic_record_schema.required_fields;
    for (const row of report.comparisons.flatMap((item: any) => [
      ...item.current_only_slots,
      ...item.reference_only_slots,
    ])) {
      expect(Object.keys(row)).toEqual(expect.arrayContaining(required));
      expect(row.official_evidence).toBeInstanceOf(Array);
      expect(row.legacy_mapping).toMatchObject({
        canonical_venue_id: expect.any(String),
        canonical_edition_id: expect.any(String),
        legacy_keys: expect.any(Array),
        legacy_edition_ids: expect.any(Array),
      });
    }
  });
});

describe("discovery lifecycle split", () => {
  it("keeps active candidates full and archive records compact", () => {
    const active = parseCandidateRegistry(
      loadYaml(readFileSync(join(REPO_ROOT, "data", "discovery", "active.yaml"), "utf8")),
    );
    const archive = JSON.parse(
      readFileSync(join(REPO_ROOT, "data", "discovery", "archive.json"), "utf8"),
    ) as { lifecycle: string; records: Array<Record<string, string>> };
    expect(active.candidates.length).toBeGreaterThan(0);
    expect(archive.lifecycle).toBe("archive");
    expect(archive.records.length).toBeGreaterThan(active.candidates.length);
    for (const record of archive.records) {
      expect(Object.keys(record).sort()).toEqual([
        "decision",
        "fingerprint",
        "last_reviewed",
        "source_url_hash",
      ]);
      expect(record.source_url_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("does not archive a future scoped candidate with an official URL", () => {
    const candidate: Candidate = {
      key: "future-workshop",
      title: "Future Workshop",
      full_name: "Future Workshop",
      link: "https://future.example/",
      categories: ["systems"],
      tags: [],
      source_type: "conference",
      evidence_url: "",
      status: "discovered",
      discovered_at: "2026-09-01T00:00:00Z",
      date_text: "2099-01-01",
      place: "",
      deadlines: [],
    };
    const split = splitCandidateLifecycle([candidate], new Date("2026-09-01T00:00:00Z"));
    expect(split.active).toHaveLength(1);
    expect(split.archive).toHaveLength(0);
  });
});

it("round-trips the new edition identity fields through JSON", () => {
  const local = parseFile(join(REPO_ROOT, "data", "manual.yaml"));
  const json = local.map((conference) => ({
    ...conference,
    editions: conference.editions.map((edition) => ({
      year: edition.year,
      id: edition.edition_id,
      link: edition.link,
      place: edition.place,
      date_text: edition.date_text,
      event_start: edition.event_start?.toISOString().slice(0, 10) ?? null,
      event_end: edition.event_end?.toISOString().slice(0, 10) ?? null,
      estimated: edition.estimated,
      source: edition.source,
      call_identity: edition.call_identity,
      legacy_ids: edition.legacy_ids,
      deadlines: edition.deadlines.map((deadline) => ({
        kind: deadline.kind,
        label: deadline.label,
        round: deadline.round,
        comment: deadline.comment,
        precision: deadline.precision,
        local_date: deadline.precision === "date-only" ? deadline.local_date : undefined,
        promotion_ref: deadline.promotion_ref,
      })),
    })),
  }));
  const restored = conferencesFromJson({ conferences: json });
  const iccr = restored.find((conference) => conference.key === "iccr-2026")?.editions[0];
  expect(iccr?.call_identity?.callId).toBe("iccr-2026");
  expect(iccr?.legacy_ids).toEqual(["ieee-iccr-202626"]);
});
