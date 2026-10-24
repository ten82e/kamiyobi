import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { editionSessionJa, recordsOf, toJson, toUpcomingMd } from "../src/build.ts";
import { conferencesFromJson } from "../src/model.ts";

const start = "2028-05-01";
const end = "2028-05-31";
const cases = [
  ["month-only", "2028-05（月のみ判明）"],
  ["unverified", "2028-05-01(月) 〜 2028-05-31(水)（日付未確認）"],
  ["not-announced", "会期未発表"],
  ["exact-range", "2028-05-01(月) 〜 2028-05-31(水)"],
] as const;

describe("event certainty in human-readable dates", () => {
  it("preserves not-announced when serializing editions that retain old segments", () => {
    const precision = "not-announced";
    const segments = [{ start, end, label: "オンライン" }];
    const confs = conferencesFromJson({
      conferences: [
        {
          key: "retained",
          title: "Retained",
          editions: [
            {
              id: "retained28",
              year: 2028,
              event_start: start,
              event_end: end,
              event_date_precision: precision,
              event_segments: segments,
              deadlines: [],
            },
          ],
        },
      ],
    });
    expect(toJson(confs, {}, new Date("2028-03-01"), {})).toMatchObject({
      conferences: [
        {
          editions: [
            {
              event_date_precision: precision,
              event_segments: segments,
              event_start: start,
              event_end: end,
            },
          ],
        },
      ],
    });
  });
  it.each(cases)(
    "retains %s when dates exist in every published display",
    (precision, expected) => {
      const ed = { event_start: start, event_end: end, event_date_precision: precision };
      expect(Recommender.eventCellJa({ ed })).toBe(expected);
      const confs = conferencesFromJson({
        conferences: [
          {
            key: "fresh-meeting",
            title: "Fresh meeting",
            categories: ["systems"],
            editions: [{ id: "fresh28", year: 2028, ...ed, deadlines: [] }],
          },
        ],
      });
      expect(editionSessionJa(confs[0].editions[0])).toBe(expected);
      const rows = Recommender.candidateRows({
        conferences: [
          {
            key: "fresh",
            title: "Fresh",
            categories: ["systems"],
            editions: [
              {
                id: "fresh28",
                year: 2028,
                ...ed,
                deadlines: [{ kind: "paper", utc: "2028-04-01T00:00:00Z" }],
              },
            ],
          },
        ],
      });
      expect(rows).toHaveLength(1);
      expect(Recommender.searchMatcher("発表締切")(rows[0].hay)).toBe(false);
      expect(Recommender.searchMatcher("月の 締切")(rows[0].hay)).toBe(false);
      expect(Recommender.searchMatcher(expected, Date.parse("2028-03-01"))(rows[0].hay)).toBe(true);
      for (const now of ["2028-04-30T12:00:00Z", "2028-05-01T12:00:00Z", "2028-05-15T12:00:00Z"]) {
        const md = toUpcomingMd(recordsOf(confs), new Date(now), 60);
        const line = md.split("\n").find((line) => line.includes("Fresh meeting"));
        if (precision === "not-announced") {
          expect(line, "未発表の会期を日付で絞った一覧に出さない").toBeUndefined();
          continue;
        }
        expect(line).toBeDefined();
        expect(line).toContain(`| ${expected} |`);
        if (precision !== "exact-range") {
          expect(line).toContain("| 日付未確認 |");
          expect(line).not.toMatch(/本日開催|開催中|\| \d+日 \|/);
        } else if (now.includes("05-01")) expect(line).toContain("| 本日開催 |");
        else if (now.includes("05-15")) expect(line).toContain("| 開催中(残り17日) |");
        else expect(line).toContain("| 1日 |");
      }
    },
  );
  it("changes only the declared certainty and preserves exact individual split dates", () => {
    const ed = { event_start: start, event_end: end, event_date_precision: "month-only" };
    expect(Recommender.eventCellJa({ ed })).toBe("2028-05（月のみ判明）");
    ed.event_date_precision = "exact-range";
    expect(Recommender.eventCellJa({ ed })).toBe(cases[3][1]);
    expect(
      Recommender.eventCellJa({
        ed: {
          event_date_precision: "split-dates",
          event_segments: [
            { start, end: start, label: "オンライン" },
            { start: end, end },
          ],
        },
      }),
    ).toBe("2028-05-01(月)（オンライン） / 2028-05-31(水)");
  });
  it("does not expose arbitrary days in a month-only span across months", () => {
    expect(
      Recommender.eventCellJa({
        ed: {
          event_start: "2028-12-02",
          event_end: "2029-01-03",
          event_date_precision: "month-only",
        },
      }),
    ).toBe("2028-12 〜 2029-01（月のみ判明）");
    const journal = { kind: "journal", ed: { event_date_precision: "unverified" } };
    expect(Recommender.eventCellJa(journal)).toBe("");
    expect(Recommender.fieldNotApplicableJa(journal)).toBe(true);
    const conf = conferencesFromJson({
      conferences: [
        {
          key: "unknown",
          title: "Unknown",
          categories: [],
          editions: [
            {
              id: "unknown28",
              year: 2028,
              date_text: "2028",
              event_date_precision: "unverified",
              deadlines: [],
            },
          ],
        },
      ],
    });
    expect(editionSessionJa(conf[0].editions[0])).toBe("");
    expect(Recommender.eventCellJa({ ed: { event_date_precision: "not-announced" } })).toBe(
      "会期未発表",
    );
    expect(
      Recommender.eventCellJa({
        ed: { date_text: "2027年9月号（掲載予定）", event_date_precision: "month-only" },
      }),
    ).toBe("2027年9月号（掲載予定）");
  });
});
