import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

const now = Date.parse("2028-02-20T03:00:00Z");
const edition = (
  id: string,
  start: string,
  end: string,
  precision = "exact-range",
  extra = {},
) => ({
  id,
  year: 2028,
  event_start: start,
  event_end: end,
  event_date_precision: precision,
  place: "Tokyo, Japan",
  deadlines: [],
  ...extra,
});
const conf = {
  key: "fresh",
  title: "Fresh",
  categories: ["systems"],
  editions: [
    edition("current", "2028-02-20", "2028-02-22", "exact-range", {
      deadlines: [{ kind: "paper", utc: "2028-03-01T00:00:00Z" }],
    }),
    edition("same-day-other", "2028-02-20", "2028-02-23"),
    edition("month", "2028-02-02", "2028-02-04", "month-only"),
    edition("split", "2028-02-01", "2028-02-28", "split-dates", {
      event_segments: [
        { start: "2028-02-01", end: "2028-02-01", label: "オンライン" },
        { start: "2028-02-28", end: "2028-02-28", label: "現地開催" },
      ],
    }),
    edition("postponed", "2028-02-25", "2028-02-26", "unverified", { year: 2027 }),
    edition("unannounced", "2031-03-02", "2031-03-04", "not-announced", { year: 2030 }),
    edition("estimated", "2028-02-24", "2028-02-24", "single-day", { estimated: true }),
    edition("finished", "2028-02-19", "2028-02-19"),
  ],
};
function later(at = now) {
  return Recommender.upcomingEditionsOf(conf, "2028-02-20", at, 20, "current");
}
describe("later editions retain certainty and edition identity", () => {
  it("excludes the displayed ID alone, retaining other editions with the same start", () => {
    expect(later().map((e) => e.editionId)).toEqual([
      "split",
      "month",
      "same-day-other",
      "postponed",
      "unannounced",
    ]);
    expect(
      Recommender.upcomingEditionsOf(conf, "2028-02-20", now, 20).some(
        (e) => e.start === "2028-02-20",
      ),
    ).toBe(false);
  });
  it("preserves month-only, unverified, unpublished and split dates in the actual displayed lines", () => {
    const lines = Object.fromEntries(
      later().map((e) => [e.editionId, Recommender.laterEditionLineJa(e)]),
    );
    expect(lines.month).toBe("2028-02（月のみ判明） ＠Tokyo, 日本");
    expect(lines.split).toBe(
      "2028-02-01(火)（オンライン） / 2028-02-28(月)（現地開催） ＠Tokyo, 日本",
    );
    expect(lines.postponed).toBe(
      "2027年の開催回: 2028-02-25(金) 〜 2028-02-26(土)（日付未確認） ＠Tokyo, 日本",
    );
    expect(lines.unannounced).toBe("2030年の開催回: 会期未発表 ＠Tokyo, 日本");
    expect(lines["same-day-other"]).toBe("2028-02-20(日)〜02-23(水) ＠Tokyo, 日本");
  });
  it("keeps exact dates through the last millisecond of their JST end day and monthly dates through leap day", () => {
    expect(
      later(Date.parse("2028-02-23T14:59:59.999Z")).some((e) => e.editionId === "same-day-other"),
    ).toBe(true);
    expect(
      later(Date.parse("2028-02-23T15:00:00Z")).some((e) => e.editionId === "same-day-other"),
    ).toBe(false);
    expect(later(Date.parse("2028-02-29T14:59:59.999Z")).map((e) => e.editionId)).toEqual([
      "month",
      "unannounced",
    ]);
    expect(later(Date.parse("2028-02-29T15:00:00Z")).map((e) => e.editionId)).toEqual([
      "unannounced",
    ]);
  });
  it("retains explicit segments without a continuous envelope and drops an expired envelope with no remaining segment", () => {
    const noEnvelope = {
      editions: [
        {
          id: "segments",
          event_date_precision: "split-dates",
          event_segments: [
            { start: "2028-02-21", end: "2028-02-21" },
            { start: "2028-02-25", end: "2028-02-25" },
          ],
        },
      ],
    };
    const rows = Recommender.upcomingEditionsOf(noEnvelope, "", now);
    expect(rows).toHaveLength(1);
    expect(Recommender.laterEditionLineJa(rows[0])).toBe("2028-02-21(月) / 2028-02-25(金)");
    expect(
      Recommender.upcomingEditionsOf(
        {
          editions: [
            edition("gap", "2028-02-01", "2028-02-28", "split-dates", {
              event_segments: [{ start: "2028-02-01", end: "2028-02-01" }],
            }),
          ],
        },
        "",
        now,
      ),
    ).toEqual([]);
  });
  it("keeps the displayed uncertainty wording searchable without matching unrelated announcement or month fragments", () => {
    const rows = Recommender.candidateRows({ conferences: [conf] });
    expect(rows).toHaveLength(1);
    for (const query of [
      "2028-02（月のみ判明）",
      "会期未発表",
      "2028-02-28(月)",
      "2027年の開催回",
      "2028年の開催回",
      "2030年の開催回",
      "２０３０年の開催回",
    ])
      expect(Recommender.searchMatcher(query, now)(rows[0].hay), query).toBe(true);
    expect(Recommender.searchMatcher("2030年", now)(rows[0].hay)).toBe(false);
    const publication = Recommender.candidateRows({
      conferences: [
        {
          key: "publication",
          title: "Publication",
          editions: [
            {
              id: "issue2030",
              year: 2030,
              date_text: "2030年9月号（掲載予定）",
              deadlines: [{ kind: "paper", utc: "2028-03-01T00:00:00Z" }],
            },
          ],
        },
      ],
    });
    expect(publication).toHaveLength(1);
    expect(Recommender.searchMatcher("2030年の開催回", now)(publication[0].hay)).toBe(false);
    expect(Recommender.queryTermCounts("2030年の開催回", [rows[0].hay], now)).toEqual([
      { term: "2030年の開催回", count: 1 },
    ]);
    expect(Recommender.relativeDayNotes("2030年の開催回", now)).toEqual([
      "2030年の開催回 = 開催回の年で照合（開催日の年とは別）",
    ]);
    expect(
      JSON.stringify(
        Recommender.shorterHitWordsJa("2030年の開催回 missingtopic", [rows[0].hay], now),
      ),
    ).not.toContain("kyed");
    expect(Recommender.queryTermCounts("会期未発表", [rows[0].hay], now)).toEqual([
      { term: "会期未発表", count: 1 },
    ]);
    expect(Recommender.searchMatcher("発表締切", now)(rows[0].hay)).toBe(false);
    expect(Recommender.searchMatcher("月の 締切", now)(rows[0].hay)).toBe(false);
  });
  it("passes the current edition ID from the real drawer expression", () => {
    const source = jsFunction(siteRuntime(), "openDrawer");
    const init = /const laterEditions =([\s\S]*?);/.exec(source)?.[1];
    expect(init).toBeDefined();
    const result = new Function("Recommender", "r", "Date", `return (${init});`)(
      Recommender,
      {
        conf,
        ed: conf.editions[0],
      },
      class extends Date {
        static now() {
          return now;
        }
      },
    );
    expect(result.some((e: { editionId: string }) => e.editionId === "current")).toBe(false);
    expect(result.some((e: { editionId: string }) => e.editionId === "same-day-other")).toBe(true);
  });
});
