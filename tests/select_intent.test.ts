import { expect, it } from "vitest";
import { select } from "../src/merge.ts";
import { makeConference, makeEdition } from "./helpers.ts";

it("retains explicitly collected undated venues and journals while honoring exclusions and categories", () => {
  const undated = (key: string) =>
    makeConference({
      key,
      title: key,
      categories: ["systems"],
      rank: { ccf: "C" },
      editions: [
        makeEdition({
          edition_id: `${key}30`,
          year: 2030,
          event_start: null,
          event_end: null,
          deadlines: [],
          event_date_precision: "not-announced",
        }),
      ],
    });
  const input = [
    undated("named"),
    undated("always"),
    { ...undated("journal"), rank: { ccf: "A" }, tags: ["journal"] },
    { ...undated("ordinary"), rank: { ccf: "A" } },
    undated("excluded"),
    { ...undated("inactive"), categories: ["ai"] },
  ];
  const config = {
    categories: { systems: "Systems" },
    taxonomy: { systems: { venues: ["named", "excluded", "inactive"] } },
    exclude: ["excluded"],
    rank_filter: { ccf: ["A"], keep_if_no_rank: false, always_keep: ["always"] },
  };
  const saved = JSON.stringify({ input, config });
  expect(
    select(input, config)
      .map((conf) => conf.key)
      .sort(),
  ).toEqual(["always", "journal", "named"]);
  const withDate = input.map((conf) =>
    conf.key === "ordinary"
      ? {
          ...conf,
          editions: [
            makeEdition({
              edition_id: "ordinary30",
              year: 2030,
              event_start: new Date("2030-01-15T00:00:00Z"),
              event_end: new Date("2030-01-16T00:00:00Z"),
              event_date_precision: "exact-range",
              deadlines: [],
            }),
          ],
        }
      : conf,
  );
  expect(
    select(withDate, config)
      .map((conf) => conf.key)
      .sort(),
  ).toEqual(["always", "journal", "named", "ordinary"]);
  expect(JSON.stringify({ input, config })).toBe(saved);
});
