import { expect, it } from "vitest";
import { toCatalog } from "../src/build.ts";

it("preserves complete planning dates of retained editions without widening list rows", () => {
  const oldAbstract = { kind: "abstract", utc: "2026-07-01T12:00:00Z", round: 1 };
  const paper = { kind: "paper", utc: "2026-10-18T12:00:00Z", round: 2 };
  const distantPaper = { kind: "paper", utc: "2027-05-01T12:00:00Z", round: 3 };
  const unknownTime = {
    kind: "notification",
    precision: "date-only",
    local_date: "2027-05-10",
    earliest_utc: "2027-05-09T10:00:00Z",
    latest_utc: "2027-05-11T11:59:59Z",
  };
  const edition = {
    id: "demo27",
    year: 2027,
    deadlines: [oldAbstract, paper, distantPaper, unknownTime],
  };
  const otherMeeting = {
    id: "demo27-autumn",
    year: 2027,
    deadlines: [{ kind: "paper", utc: "2027-09-01T12:00:00Z" }],
  };
  const source = {
    conferences: [{ key: "demo", legacy_keys: ["former-demo"], editions: [edition, otherMeeting] }],
  };
  const catalog = toCatalog(source, new Date("2026-10-02T00:00:00Z"));
  const conf = (catalog.conferences as Array<Record<string, any>>)[0];
  expect(conf.legacy_keys).toEqual(["former-demo"]);
  expect(conf.legacy_keys).not.toBe(source.conferences[0].legacy_keys);
  expect(conf.editions).toHaveLength(1);
  expect(conf.editions[0].deadlines).toEqual([paper]);
  expect(conf.editions[0].schedule_deadlines).toEqual([oldAbstract, distantPaper, unknownTime]);
  expect(conf.editions[0].schedule_deadlines[2].utc).toBeUndefined();
  expect(edition.deadlines).toEqual([oldAbstract, paper, distantPaper, unknownTime]);
  expect(catalog.window).toEqual({ lookback_days: 30, upcoming_days: 180 });
});

it("does not attach supplemental schedules to an event-only edition or duplicate window dates", () => {
  const data = {
    conferences: [
      {
        key: "demo",
        editions: [
          {
            id: "event",
            year: 2026,
            event_start: "2026-10-20",
            event_end: "2026-10-22",
            deadlines: [{ kind: "paper", utc: "2026-05-01T00:00:00Z" }],
          },
          { id: "call", year: 2027, deadlines: [{ kind: "paper", utc: "2026-11-01T00:00:00Z" }] },
        ],
      },
    ],
  };
  const catalog = toCatalog(data, new Date("2026-10-02T00:00:00Z"));
  const editions = (catalog.conferences as Array<Record<string, any>>)[0].editions;
  expect(editions).toHaveLength(2);
  expect(editions[0].deadlines).toEqual([]);
  expect(editions.every((edition: Record<string, any>) => !("schedule_deadlines" in edition))).toBe(
    true,
  );
});
