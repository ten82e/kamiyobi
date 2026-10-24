import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { verifyPublishedHistory } from "../scripts/capture-published-history.ts";
import { retainPublishedHistory } from "../src/history.ts";
import { applyOverrides, mergeSources } from "../src/merge.ts";
import { conferencesFromJson } from "../src/model.ts";
import { makeConference, makeDeadline, makeEdition, runCli, tempWork, utc } from "./helpers.ts";

const captured = JSON.parse(readFileSync("tests/fixtures/published-history-pr958.json", "utf8"));
const now = new Date("2026-10-04T00:00:00Z");
const baseline = () => conferencesFromJson(captured.baseline);
const incoming = () => conferencesFromJson(captured.incoming);
const overrides = load(readFileSync("data/overrides.yaml", "utf8")) as Record<string, unknown>;

describe("actual publication to PR958 history regression", () => {
  it("keeps 3DV/AAAI/ICA3PP full dates, permits reviewed TCC/SYSTOR corrections, and keeps ISS submissions", () => {
    const before = baseline();
    const candidate = incoming();
    const retained = retainPublishedHistory(candidate, before, now);
    const output = applyOverrides(retained.conferences, overrides);
    const edition = (key: string, year: number) =>
      output.find((c) => c.key === key)!.editions.find((e) => e.year === year)!;
    for (const [key, year, start, end] of [
      ["3dv", 2024, "2024-03-18", "2024-03-21"],
      ["aaai", 2024, "2024-02-20", "2024-02-27"],
      ["ica3pp", 2025, "2025-10-30", "2025-11-02"],
      ["tcc", 2023, "2023-11-29", "2023-12-02"],
      ["systor", 2024, "2024-09-23", "2024-09-24"],
      ["cscw", 2022, "2022-11-08", "2022-11-22"],
    ] as const) {
      expect(edition(key, year).event_start?.toISOString().slice(0, 10), key).toBe(start);
      expect(edition(key, year).event_end?.toISOString().slice(0, 10), key).toBe(end);
    }
    const iss = edition("iss", 2025);
    expect(edition("cscw", 2022).deadlines).toHaveLength(2);
    expect(edition("cscw", 2022).event_date_precision).toBe("exact-range");
    expect(iss.deadlines).toHaveLength(2);
    expect(iss.deadlines).toEqual(before.find((c) => c.key === "iss")!.editions[0].deadlines);
    expect(iss.event_start).toBeNull();
    expect(iss.event_end).toBeNull();
    expect(iss.deadlines.every((d) => d.evidence?.some((e) => e.confidence === "aggregator"))).toBe(
      true,
    );
    expect(retained.retained.some((r) => r.venue === "3dv" && r.action === "event-retained")).toBe(
      true,
    );
    expect(candidate).toEqual(incoming());
    expect(before).toEqual(baseline());
  });

  it("binds all six old edition IDs without joining the other FSE venue", () => {
    const candidate = incoming();
    candidate.push(
      makeConference({
        key: "fse",
        title: "Software engineering FSE",
        editions: [makeEdition({ year: 2024, edition_id: "fse24" })],
      }),
    );
    const result = retainPublishedHistory(candidate, baseline(), now);
    expect(result.retained.filter((r) => r.action === "identity-bound")).toHaveLength(6);
    for (const c of baseline().filter((c) => ["fse-sc", "ica3pp"].includes(c.key))) {
      const target = result.conferences.find((t) => t.key === c.key)!;
      for (const e of c.editions)
        expect(target.editions.find((t) => t.year === e.year)?.legacy_ids).toContain(e.edition_id);
    }
    expect(result.conferences.find((c) => c.key === "fse")).toEqual(candidate.at(-1));
    // The next refresh still starts from raw source IDs, while its baseline is our prior output.
    const second = retainPublishedHistory(candidate, result.conferences, now);
    for (const c of result.conferences) {
      for (const e of c.editions.filter((e) => e.legacy_ids?.length)) {
        expect(
          second.conferences
            .find((t) => t.key === c.key)
            ?.editions.find((t) => t.edition_id === e.edition_id)?.legacy_ids,
        ).toEqual(e.legacy_ids);
      }
    }
  });

  it("restores a missing edition separately when another edition shares only its year", () => {
    const saved = makeConference({
      key: "venue",
      title: "Venue",
      editions: [
        makeEdition({ year: 2025, edition_id: "main25", link: "https://example.org/main" }),
      ],
    });
    const next = structuredClone(saved);
    next.editions = [
      makeEdition({ year: 2025, edition_id: "workshop25", link: "https://example.org/workshop" }),
    ];
    const result = retainPublishedHistory([next], [saved], now);
    expect(result.conferences[0].editions).toEqual([next.editions[0], saved.editions[0]]);
    expect(result.retained.map((r) => r.action)).toEqual(["edition-restored"]);
  });

  it("rejects an ambiguous same-year URL instead of merging workshops into the first edition", () => {
    const candidate = incoming();
    const c = candidate.find((c) => c.key === "fse-sc")!;
    c.editions.push({ ...structuredClone(c.editions[0]), edition_id: "workshop23" });
    expect(() => retainPublishedHistory(candidate, baseline(), now)).toThrow(
      /ambiguous published history/,
    );
  });

  it("rejects many-to-one history identity instead of dropping a published edition", () => {
    const saved = makeConference({
      key: "venue",
      title: "Venue",
      editions: [
        makeEdition({ year: 2025, edition_id: "main25", link: "https://example.org/2025" }),
        makeEdition({ year: 2025, edition_id: "workshop25", link: "https://example.org/2025" }),
      ],
    });
    const next = structuredClone(saved);
    next.editions.pop();
    next.editions[0].edition_id = "canonical25";
    next.editions[0].legacy_ids = ["main25", "workshop25"];
    expect(() => retainPublishedHistory([next], [saved], now)).toThrow(
      /many-to-one published history identity/,
    );
  });

  it("reserves explicit IDs before URLs and independently restores another published edition", () => {
    const saved = makeConference({
      key: "venue",
      title: "Venue",
      editions: [
        makeEdition({ year: 2025, edition_id: "main25", link: "https://example.org/2025" }),
        makeEdition({ year: 2025, edition_id: "workshop25", link: "https://example.org/2025" }),
      ],
    });
    const next = structuredClone(saved);
    next.editions.pop();
    for (const editions of [saved.editions, [...saved.editions].reverse()]) {
      const result = retainPublishedHistory([next], [{ ...saved, editions }], now);
      expect(result.conferences[0].editions).toEqual(saved.editions);
      expect(result.retained.map((r) => r.action)).toEqual(["edition-restored"]);
    }
  });

  it("explicitly binds CoRL 2025's rotating and archived URLs and keeps both submission slots", () => {
    const config = load(readFileSync("config.yaml", "utf8")) as Record<string, unknown>;
    const corl = incoming().filter((c) => c.key === "corl");
    expect(corl[0].editions).toHaveLength(2);
    const merged = mergeSources([corl], config);
    const saved = baseline().filter((c) => c.key === "corl");
    const result = retainPublishedHistory(merged, saved, now).conferences[0];
    expect(result.editions).toHaveLength(1);
    expect(result.editions[0].identity?.editionId).toBe("corl-2025");
    expect(result.editions[0].event_start?.toISOString().slice(0, 10)).toBe("2025-09-27");
    expect(result.editions[0].event_end?.toISOString().slice(0, 10)).toBe("2025-09-30");
    expect(result.editions[0].deadlines.map((d) => d.kind).sort()).toEqual(["abstract", "paper"]);
    expect(retainPublishedHistory(merged, [result], now).conferences[0]).toEqual(result);
  });

  it("reviews CPAL 2025 as one edition with two official tracks and keeps the old value as superseded", () => {
    const config = load(readFileSync("config.yaml", "utf8")) as Record<string, unknown>;
    const raw = incoming().filter((c) => c.key === "cpal");
    expect(raw[0].editions).toHaveLength(2);
    const current = applyOverrides(mergeSources([raw], config), overrides);
    const saved = baseline().filter((c) => c.key === "cpal");
    const previous = saved[0].editions[0].deadlines[0];
    const result = retainPublishedHistory(current, applyOverrides(saved, overrides), now);
    expect(result.conferences[0].editions).toHaveLength(1);
    const edition = result.conferences[0].editions[0];
    expect(edition.identity?.editionId).toBe("cpal-2025");
    expect(edition.edition_id).toBe("cpal25");
    expect(edition.event_start?.toISOString().slice(0, 10)).toBe("2025-03-24");
    expect(edition.event_end?.toISOString().slice(0, 10)).toBe("2025-03-27");
    expect(edition.deadlines.map((d) => [d.track, d.at_utc?.toISOString()])).toEqual([
      ["proceedings", "2024-12-03T11:59:00.000Z"],
      ["recent-spotlight", "2025-01-13T11:59:00.000Z"],
    ]);
    expect(
      edition.deadlines[0].superseded_deadlines?.map((d) => new Date(d.value).getTime()),
    ).toContain(previous.at_utc?.getTime());
    for (const deadline of edition.deadlines) {
      const evidence = deadline.evidence?.find((e) => e.confidence === "official");
      expect(evidence?.source_url).toBe("https://2025.cpal.cc/deadlines/");
      expect(createHash("sha256").update(readFileSync(evidence!.evidenceRef!)).digest("hex")).toBe(
        evidence?.contentHash,
      );
    }
  });

  it("retains missing slots and values, while new slots and current-year updates survive", () => {
    const old = makeConference({
      key: "venue",
      title: "Venue",
      editions: [
        makeEdition({
          year: 2025,
          edition_id: "v25",
          deadlines: [makeDeadline("paper", "Paper", utc(2025, 1, 1))],
        }),
      ],
    });
    const next = structuredClone(old);
    next.editions[0].deadlines = [
      makeDeadline("paper", "Paper", utc(2025, 1, 2)),
      makeDeadline("other", "Poster", utc(2025, 2, 1)),
    ];
    next.editions.push(
      makeEdition({ year: 2026, edition_id: "v26", event_start: utc(2026, 11, 1) }),
    );
    const result = retainPublishedHistory([next], [old], now);
    expect(result.conferences[0].editions[0].deadlines).toContainEqual(
      old.editions[0].deadlines[0],
    );
    expect(result.conferences[0].editions[0].deadlines).toContainEqual(
      next.editions[0].deadlines[1],
    );
    expect(result.conferences[0].editions[1]).toEqual(next.editions[1]);
    expect(retainPublishedHistory(result.conferences, [old], now).retained).toEqual([]);
  });

  it("does not resurrect estimates or deleted local canonical entries; reviewed drops still apply", () => {
    const old = baseline();
    old.push(
      makeConference({
        key: "local",
        title: "Local",
        editions: [makeEdition({ year: 2025, source: "local" })],
      }),
    );
    old.push(
      makeConference({
        key: "estimated",
        title: "Estimate",
        editions: [makeEdition({ year: 2025, estimated: true })],
      }),
    );
    const result = retainPublishedHistory(incoming(), old, now);
    expect(result.conferences.some((c) => ["local", "estimated"].includes(c.key))).toBe(false);
    expect(applyOverrides(result.conferences, { drop: ["iss"] }).some((c) => c.key === "iss")).toBe(
      false,
    );
  });
});

it("verifies published bytes and commit identity, failing closed for bad or empty captures", () => {
  const bytes = Buffer.from(JSON.stringify(captured.baseline));
  const manifest = {
    source_commit: "a".repeat(40),
    data_commit: "b".repeat(40),
    artifacts: { "data.json": { sha256: createHash("sha256").update(bytes).digest("hex") } },
  };
  expect(() => verifyPublishedHistory(manifest, bytes)).not.toThrow();
  expect(() => verifyPublishedHistory(manifest, Buffer.from("{}"))).toThrow(/hash mismatch/);
  expect(() => verifyPublishedHistory({ ...manifest, source_commit: "" }, bytes)).toThrow(
    /commit identity/,
  );
  const empty = Buffer.from('{"conferences":[]}');
  expect(() =>
    verifyPublishedHistory(
      {
        ...manifest,
        artifacts: { "data.json": { sha256: createHash("sha256").update(empty).digest("hex") } },
      },
      empty,
    ),
  ).toThrow(/empty/);
});

it("uses the same verified publication for both updater builds and preserves its diagnostic artifact", () => {
  const workflow = readFileSync(".github/workflows/update-data.yml", "utf8");
  expect(workflow).toContain(
    "node scripts/capture-published-history.ts /tmp/kamiyobi-update/published/data.json",
  );
  expect(
    workflow.match(/--history-baseline \/tmp\/kamiyobi-update\/published\/data.json/g),
  ).toHaveLength(2);
  expect(workflow).toContain(
    "--history-report /tmp/kamiyobi-update/current/history-retention.json",
  );
});

it("honors an explicit baseline in the real offline CLI and writes its content hash", () => {
  const root = tempWork("cfp-history-cli-");
  const baselinePath = join(root, "published.json");
  const bytes = Buffer.from(JSON.stringify(captured.baseline));
  writeFileSync(baselinePath, bytes);
  const out = join(root, "public");
  const reportPath = join(root, "diagnostics/history-retention.json");
  const result = runCli(out, {
    extra: ["--no-embeddings", "--history-baseline", baselinePath, "--history-report", reportPath],
  });
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(out, "history-retention.json"))).toBe(false);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  expect(report.baseline_sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  const output = conferencesFromJson(JSON.parse(readFileSync(join(out, "data.json"), "utf8")));
  const iss = output.find((c) => c.key === "iss")!.editions.find((e) => e.year === 2025)!;
  expect(iss.deadlines).toHaveLength(2);
  expect(iss.deadlines).toEqual(baseline().find((c) => c.key === "iss")!.editions[0].deadlines);
  writeFileSync(baselinePath, '{"conferences":[]}');
  expect(
    runCli(join(root, "invalid"), {
      extra: ["--no-embeddings", "--history-baseline", baselinePath],
    }).status,
  ).not.toBe(0);
});
