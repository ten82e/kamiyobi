import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  type Candidate,
  parseCandidateRegistry,
  splitCandidateLifecycle,
} from "../src/discover.ts";
import { conferencesFromJson } from "../src/model.ts";
import { localSourcePaths, parseFile } from "../src/sources/local.ts";
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

describe("canonical local inputs", () => {
  it("keeps manual and generated promotion data disjoint and traceable", () => {
    const paths = localSourcePaths(REPO_ROOT);
    expect(paths.map((path) => path.split("/").at(-1))).toEqual([
      "manual.yaml",
      "curated.generated.yaml",
    ]);
    const manual = parseFile(paths[0]);
    const curated = parseFile(paths[1]);
    const manualKeys = new Set(manual.map((conference) => conference.key));
    expect(curated.every((conference) => !manualKeys.has(conference.key))).toBe(true);

    const resolutionIds = new Set<string>();
    for (const batch of readdirSync(join(REPO_ROOT, "data", "promotions"))) {
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
