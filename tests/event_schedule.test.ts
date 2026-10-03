import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { validateData } from "../scripts/validate-data.ts";
import Recommender from "../site/recommender.ts";
import { editionSessionJa, recordsOf, toCatalog, toJson } from "../src/build.ts";
import { applyOverrides } from "../src/merge.ts";
import { conferencesFromJson, parseDateRange, parseEventSegments } from "../src/model.ts";

const review = {
  edition_id: "meeting21",
  source_date_text: "February 7-10, 2022",
  source_start: "2022-02-07",
  source_end: "2022-02-10",
  held_year: 2022,
  source_url: "https://example.org/2021/",
  reviewed_on: "2026-10-02",
  note: "The official 2021 edition was postponed to February 2022.",
};
const edition = {
  id: "meeting21",
  year: 2021,
  date_text: review.source_date_text,
  event_start: review.source_start,
  event_end: review.source_end,
  event_review: review,
  deadlines: [],
};
const payload = (ed: Record<string, unknown>) => ({
  conferences: [{ key: "meeting", title: "Meeting", categories: ["ai"], editions: [ed] }],
});

describe("evidence-bound event schedules", () => {
  // Captured update-data run 37079425961, artifact 11257938372:
  // WASA's 2022 edition was postponed to April 2023; keep both years intact.
  const capturedWasa = {
    conferences: [
      {
        key: "wasa",
        title: "WASA",
        categories: ["networking"],
        editions: [
          {
            id: "wasa22",
            year: 2022,
            date_text: "April 7-9, 2023",
            event_start: "2023-04-07",
            event_end: "2023-04-09",
            deadlines: [],
          },
        ],
      },
    ],
  };
  const wasaOverride = () => {
    const overrides = load(readFileSync("data/overrides.yaml", "utf8")) as {
      conferences: Record<string, unknown>;
    };
    return { conferences: { wasa: overrides.conferences.wasa } };
  };
  it("covers the hosted WASA regression without changing its edition or historical dates", () => {
    expect(validateData(capturedWasa).errors).toEqual([
      "wasa/wasa22: date_text year 2023 conflicts with edition 2022",
      "wasa/wasa22: event_start year conflicts with edition 2022",
    ]);
    const patched = applyOverrides(conferencesFromJson(capturedWasa), wasaOverride());
    const output = toJson(patched, {}, new Date("2026-10-03"));
    expect(validateData(output).errors).toEqual([]);
    const conferences = output.conferences as Array<{ editions: Array<Record<string, unknown>> }>;
    expect(conferences[0].editions[0]).toMatchObject(capturedWasa.conferences[0].editions[0]);
  });
  it("rejects a changed WASA source date while preserving the upstream change", () => {
    const changed = structuredClone(capturedWasa);
    Object.assign(changed.conferences[0].editions[0], {
      date_text: "April 8-9, 2023",
      event_start: "2023-04-08",
    });
    const patched = applyOverrides(conferencesFromJson(changed), wasaOverride());
    const output = toJson(patched, {}, new Date("2026-10-03"));
    const conferences = output.conferences as Array<{ editions: Array<Record<string, unknown>> }>;
    expect(conferences[0].editions[0]).toMatchObject(changed.conferences[0].editions[0]);
    expect(validateData(output).errors).toEqual(
      expect.arrayContaining([expect.stringContaining("event review does not match")]),
    );
  });
  it("does not invent an absent historical edition from its evidence review", () => {
    const missing = structuredClone(capturedWasa);
    missing.conferences[0].editions = [];
    const patched = applyOverrides(conferencesFromJson(missing), wasaOverride());
    expect(patched[0].editions).toEqual([]);
  });
  it("keeps the nominal edition year and actual held year separate", () => {
    expect(validateData(payload(edition)).errors).toEqual([]);
    expect(validateData(payload({ ...edition, event_review: undefined })).errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("event_start year conflicts"),
        expect.stringContaining("date_text year 2022 conflicts"),
      ]),
    );
  });
  it.each([
    { edition_id: "other21" },
    { source_date_text: "different" },
    { source_start: "2022-02-08" },
    { held_year: 2023 },
    { source_url: "file:///tmp/evidence" },
    { reviewed_on: "2026-02-30" },
    { note: "" },
  ])("rejects mismatched pins and incomplete evidence: %j", (change) => {
    expect(
      validateData(payload({ ...edition, event_review: { ...review, ...change } })).errors,
    ).toEqual(expect.arrayContaining([expect.stringContaining("event review does not match")]));
  });
  it("accepts only explicitly reviewed source variants with the same parsed bounds", () => {
    const spaced = {
      ...edition,
      date_text: "February 7 - 10, 2022",
      event_review: {
        ...review,
        source_date_text_alternatives: ["February 7 - 10, 2022"],
      },
    };
    expect(validateData(payload(spaced)).errors).toEqual([]);
    expect(
      validateData(
        payload({
          ...spaced,
          event_review: {
            ...spaced.event_review,
            source_date_text_alternatives: ["February 8-10, 2022", "February 7 - 10, 2022"],
          },
        }),
      ).errors,
    ).toEqual(expect.arrayContaining([expect.stringContaining("event review does not match")]));
    expect(
      validateData(payload({ ...edition, event_start: undefined, event_end: undefined })).warnings,
    ).toEqual([]);
  });
  it("retains and rejects changed upstream dates rather than overwriting them with a review", () => {
    const confs = conferencesFromJson(
      payload({
        ...edition,
        date_text: "February 8-10, 2022",
        event_start: "2022-02-08",
        event_review: undefined,
      }),
    );
    const patched = applyOverrides(confs, {
      conferences: { meeting: { editions: { meeting21: edition } } },
    });
    expect(patched[0].editions[0].date_text).toBe("February 8-10, 2022");
    expect(validateData(toJson(patched, {}, new Date("2026-10-02"))).errors).toEqual(
      expect.arrayContaining([expect.stringContaining("event review does not match")]),
    );
  });
  it("represents separate days without inventing a continuous range", () => {
    const raw = "March 31, 2023 (virtual); April 3-5, 2023 (in person)";
    expect(parseDateRange(raw, 2023)).toEqual([null, null]);
    const parts = parseEventSegments(raw, 2023);
    expect(parts).toEqual([
      { start: "2023-03-31", end: "2023-03-31", label: "オンライン" },
      { start: "2023-04-03", end: "2023-04-05", label: "現地開催" },
    ]);
    const confs = conferencesFromJson(
      payload({
        id: "meeting23",
        year: 2023,
        date_text: raw,
        event_date_precision: "split-dates",
        event_segments: parts,
        deadlines: [],
      }),
    );
    expect(validateData(toJson(confs, {}, new Date("2026-10-02"))).errors).toEqual([]);
    expect(
      recordsOf(confs).map((row) => [
        row.start.toISOString().slice(0, 10),
        row.end.toISOString().slice(0, 10),
      ]),
    ).toEqual(parts.map((part) => [part.start, part.end]));
    const shown = Recommender.eventCellJa({ ed: { event_segments: parts } });
    expect(shown).toBe(
      "2023-03-31(金)（オンライン） / 2023-04-03(月) 〜 2023-04-05(水)（現地開催）",
    );
    expect(editionSessionJa(confs[0].editions[0])).toBe(shown);
    expect(parseEventSegments("March 32, 2023; April 3-5, 2023", 2023)).toEqual([]);
  });
  it("restores split dates from an older snapshot and retains upcoming event-only parts without filling gaps", () => {
    const raw = "May 31 and June 2-4, 2026";
    const confs = conferencesFromJson(
      payload({
        id: "meeting26",
        year: 2026,
        date_text: raw,
        event_start: null,
        event_end: null,
        event_date_precision: "unverified",
        deadlines: [],
      }),
    );
    const data = toJson(confs, {}, new Date("2026-05-01"));
    expect(validateData(data).errors).toEqual([]);
    expect(recordsOf(confs)).toHaveLength(2);
    const catalog = toCatalog(data, new Date("2026-05-01"));
    const ed = (catalog.conferences as Array<{ editions: Array<Record<string, unknown>> }>)[0]
      .editions[0];
    expect(ed.event_start).toBeNull();
    expect(ed.event_end).toBeNull();
    expect(ed.event_date_precision).toBe("split-dates");
    expect(ed.event_segments).toEqual(parseEventSegments(raw, 2026));
    expect(
      (toCatalog(data, new Date("2026-08-01")).conferences as Array<{ editions: unknown[] }>)[0]
        .editions,
    ).toEqual([]);
  });
  it("does not allow a split-dates marker or arbitrary parts to waive range checks", () => {
    for (const parts of [
      undefined,
      [],
      [{ start: "2022-02-07", end: "2022-02-10", label: "" }],
      [
        { start: "2022-02-07", end: "2022-02-10", label: "" },
        { start: "2022-02-09", end: "2022-02-10", label: "" },
      ],
      [
        { start: "2022-02-07", end: "2022-04-10", label: "" },
        { start: "2022-05-01", end: "2022-05-02", label: "" },
      ],
    ]) {
      expect(
        validateData(
          payload({ ...edition, event_date_precision: "split-dates", event_segments: parts }),
        ).errors.length,
      ).toBeGreaterThan(0);
    }
    expect(
      validateData(
        payload({
          ...edition,
          event_start: "2022-02-07",
          event_end: "2022-04-10",
          event_review: undefined,
        }),
      ).errors,
    ).toEqual(expect.arrayContaining([expect.stringContaining("event range exceeds")]));
  });
  it("publishes the six weekly AABI seminars and preserves the original 35-day envelope", () => {
    const overrides = load(readFileSync("data/overrides.yaml", "utf8")) as {
      conferences: Record<string, { editions: Record<string, Record<string, unknown>> }>;
    };
    const patch = overrides.conferences.probml.editions.probml2021;
    const ed = { ...patch, event_start: "2021-01-13", event_end: "2021-02-17", deadlines: [] };
    expect(validateData(payload(ed)).errors).toEqual([]);
    const confs = conferencesFromJson(payload(ed));
    expect(recordsOf(confs)).toHaveLength(6);
    expect(recordsOf(confs).every((row) => row.start.getTime() === row.end.getTime())).toBe(true);
    const serialized = toJson(confs, {}, new Date("2026-10-02"));
    expect(conferencesFromJson(serialized)[0].editions[0].event_start?.toISOString()).toBe(
      "2021-01-13T00:00:00.000Z",
    );
    expect(conferencesFromJson(serialized)[0].editions[0].event_review).toEqual(patch.event_review);
    expect(conferencesFromJson(serialized)[0].editions[0].event_segments).toEqual(
      patch.event_segments,
    );
  });
});
