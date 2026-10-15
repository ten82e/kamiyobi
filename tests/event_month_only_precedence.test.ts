import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { editionSessionJa } from "../src/build.ts";
import { conferencesFromJson } from "../src/model.ts";

const examples = [
  { fields: {}, expected: "開催月のみ判明（日付未確認）" },
  { fields: { date_text: "May 17-19, 2030" }, expected: "開催月のみ判明（日付未確認）" },
  { fields: { date_text: "2030年5月17日～19日" }, expected: "開催月のみ判明（日付未確認）" },
  {
    fields: { event_end: "2030-05-19", date_text: "May 17-19, 2030" },
    expected: "2030-05（月のみ判明）",
  },
  {
    fields: { event_start: "2030-05-17", event_end: "2030-06-19" },
    expected: "2030-05 〜 2030-06（月のみ判明）",
  },
  { fields: { date_text: "2027年9月号（掲載予定）" }, expected: "2027年9月号（掲載予定）" },
  { fields: { event_start: "2030-99-17" }, expected: "開催月のみ判明（日付未確認）" },
  {
    fields: {
      event_segments: [
        { end: "2030-05-19", label: "オンライン" },
        { start: "2030-06-17", end: "2030-06-19", label: "現地開催" },
      ],
    },
    expected: "2030-05（月のみ判明）（オンライン） / 2030-06（月のみ判明）（現地開催）",
  },
];
it.each(examples)(
  "shows only known months despite retained day-level data: %j",
  ({ fields, expected }) => {
    const ed = { ...fields, event_date_precision: "month-only" };
    const before = JSON.stringify(ed);
    expect(Recommender.eventCellJa({ ed })).toBe(expected);
    expect(JSON.stringify(ed)).toBe(before);
    const conf = conferencesFromJson({
      conferences: [
        {
          key: "month",
          title: "Month",
          editions: [{ id: "month30", year: 2030, ...ed, deadlines: [] }],
        },
      ],
    })[0];
    expect(editionSessionJa(conf.editions[0])).toBe(expected);
    if (!("event_segments" in fields))
      expect(editionSessionJa({ ...conf.editions[0], estimated: true })).toBe(
        `${expected}（推定）`,
      );
  },
);

it("restores exact days only when the declared precision changes", () => {
  const ed = {
    event_start: "2030-05-17",
    event_end: "2030-05-19",
    event_date_precision: "month-only",
  };
  for (const [precision, expected] of [
    ["month-only", "2030-05（月のみ判明）"],
    ["exact-range", "2030-05-17(金) 〜 2030-05-19(日)"],
    ["month-only", "2030-05（月のみ判明）"],
    ["not-announced", "会期未発表"],
  ]) {
    ed.event_date_precision = precision;
    expect(Recommender.eventCellJa({ ed })).toBe(expected);
  }
});
