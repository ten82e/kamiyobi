import { describe, expect, it } from "vitest";
import { extractDeadlines, primaryAdapter } from "../src/fetch-primary.ts";
import { applyOverrides } from "../src/merge.ts";
import { isDateOnlyDeadline, isExactDeadline } from "../src/model.ts";
import { extractCfpCandidates } from "../src/promotion.ts";
import { extractObservationTime, resolvePrimaryObservations } from "../src/sources/primary.ts";
import { makeConference, makeEdition } from "./helpers.ts";

describe("full-width Japanese CFP observations", () => {
  it("keeps published full-width dates, clocks and original excerpts in promotion", () => {
    for (const raw of [
      "要旨締切：２０２６年５月１５日 ２３：５９ 日本時間",
      "Ａｂｓｔｒａｃｔ ｄｅａｄｌｉｎｅ：Ｍａｙ １５， ２０２６ １１：５９ ＰＭ ＪＳＴ",
    ]) {
      expect(extractCfpCandidates(raw)).toMatchObject([
        { kind: "abstract", date: "2026-05-15", time: "23:59:00", rawExcerpt: raw, text: raw },
      ]);
    }
  });

  it("keeps each compound deadline's kind, date and zone together", () => {
    const raw =
      "要旨締切：２０２６年５月１５日 １２：３０ ＪＳＴ； 原稿投稿締切：２０２６年５月２２日 ２３：５９ ＡｏＥ";
    expect(extractCfpCandidates(raw)).toMatchObject([
      { kind: "abstract", date: "2026-05-15", time: "12:30:00", timezone: "JST", rawExcerpt: raw },
      { kind: "paper", date: "2026-05-22", time: "23:59:00", timezone: "AoE", rawExcerpt: raw },
    ]);
    expect(extractCfpCandidates("要旨提出\n２０２６年５月１５日")).toMatchObject([
      { kind: "abstract", date: "2026-05-15", rawExcerpt: "要旨提出 ２０２６年５月１５日" },
    ]);
  });

  it("reads full-width global timing without assigning it to invalid local clocks", () => {
    expect(
      extractCfpCandidates(
        "Ａｌｌ ｄｅａｄｌｉｎｅｓ：２３：５９ ＡｏＥ\n投稿締切：２０２６年５月１５日",
      ),
    ).toMatchObject([{ date: "2026-05-15", time: "23:59:00", timezone: "AoE" }]);
    const [invalid] = extractCfpCandidates(
      "All deadlines: 23:59 AoE\n投稿締切：２０２６年５月１５日 ２５：６１",
    );
    expect(invalid.date).toBe("2026-05-15");
    expect(invalid.time).toBeUndefined();
    expect(invalid.timezone).toBeUndefined();
    expect(extractCfpCandidates("投稿締切：２０２６年２月３０日 ２３：５９ 日本時間")).toEqual([]);
  });

  it("keeps full-width primary clocks and raw excerpts without inventing precision", () => {
    const raw = "要旨締切：２０２６年５月１５日 ２３：５９ 日本時間";
    const adapter = primaryAdapter("https://example.test/cfp");
    expect(adapter.extract(raw, 2026)).toMatchObject([
      { kind: "abstract", date: "2026-05-15", time: "23:59:00", tz: "JST", rawExcerpt: raw },
    ]);
    expect(
      extractDeadlines(["投稿締切：２０２６年５月１５日 ２３：５９ ＡｏＥ"], 2026),
    ).toMatchObject([{ date: "2026-05-15", time: "23:59:00", tz: "AoE" }]);
    const [dateOnly] = extractDeadlines(["投稿締切：２０２６年５月１５日"], 2026);
    expect(dateOnly.time).toBeUndefined();
    expect(dateOnly.tz).toBeUndefined();
    expect(extractDeadlines(["投稿締切：２０２６年２月３０日"], 2026)).toEqual([]);
  });

  it("does not mistake full-width UTC offsets or invalid clocks for a deadline time", () => {
    expect(
      extractObservationTime("締切：２０２６年５月１５日 ２３：５９：５９ ＵＴＣ＋０９：００"),
    ).toBe("23:59:59");
    for (const raw of [
      "ＵＴＣ＋０９：００",
      "ＧＭＴ＋９：００",
      "２５：００",
      "２３：６０",
      "２０２６年５月１５日",
    ]) {
      expect(extractObservationTime(raw), raw).toBeNull();
    }
  });

  it("publishes confirmed JST instants, retains dates alone and quarantines unconfirmed clocks", () => {
    const rows = extractDeadlines(
      [
        "要旨締切：２０２６年５月１５日 ２３：５９ 日本時間",
        "原稿投稿締切：２０２６年５月１６日",
        "採否通知：２０２６年５月１７日 ２３：５９",
      ],
      2026,
    );
    const observed = resolvePrimaryObservations({
      conferences: { demo: { editions: { 2026: { deadlines: rows } } } },
    });
    const [conf] = applyOverrides(
      [
        makeConference({
          key: "demo",
          title: "DEMO",
          editions: [makeEdition({ year: 2026, edition_id: "demo26" })],
        }),
      ],
      observed,
    );
    const abstract = conf.editions[0].deadlines.find((row) => row.kind === "abstract")!;
    expect(isExactDeadline(abstract)).toBe(true);
    if (!isExactDeadline(abstract)) throw new Error("confirmed Japanese time was lost");
    expect(abstract.at_utc.toISOString()).toBe("2026-05-15T14:59:00.000Z");
    const paper = conf.editions[0].deadlines.find((row) => row.kind === "paper")!;
    expect(isDateOnlyDeadline(paper)).toBe(true);
    if (!isDateOnlyDeadline(paper)) throw new Error("unconfirmed zone became an exact instant");
    expect(paper.local_date).toBe("2026-05-16");
    expect(conf.editions[0].deadlines.some((row) => row.kind === "notification")).toBe(false);
  });
});
