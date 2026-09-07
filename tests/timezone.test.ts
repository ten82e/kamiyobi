/**
 * resolveTz: SPEC.md section 3 + the timezone values listed in sections 1.1 / 1.2.
 */

import { describe, expect, it, vi } from "vitest";
import {
  applyTz,
  asDate,
  isConfirmedTimezone,
  parseInstant,
  resetWarnings,
  resolveTz,
  type Tz,
  warningCounts,
} from "../src/model.ts";

const WINTER = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
const SUMMER = new Date(Date.UTC(2026, 6, 15, 12, 0, 0));

/** Offset of `tz` at the wall-clock instant `when`, in minutes. */
function offset(tz: Tz, when: Date = WINTER): number {
  const utc = applyTz(when.getTime(), tz);
  return (when.getTime() - utc.getTime()) / 60_000;
}

describe("resolve_tz", () => {
  it("AoE is UTC-12", () => {
    expect(offset(resolveTz("AoE"))).toBe(-12 * 60);
    expect(offset(resolveTz("aoe"))).toBe(-12 * 60);
    expect(offset(resolveTz("AOE"))).toBe(-12 * 60);
  });

  it.each(["UTC", "GMT", "utc"])("UTC-like value %j resolves to 0", (raw) => {
    expect(offset(resolveTz(raw))).toBe(0);
  });

  it.each([
    ["UTC+0", 0],
    ["UTC-0", 0],
    ["UTC+1", 1],
    ["UTC+2", 2],
    ["UTC+3", 3],
    ["UTC+7", 7],
    ["UTC+8", 8],
    ["UTC+9", 9],
    ["UTC+10", 10],
    ["UTC-4", -4],
    ["UTC-5", -5],
    ["UTC-6", -6],
    ["UTC-7", -7],
    ["UTC-8", -8],
    ["UTC-10", -10],
    ["UTC-11", -11],
    ["UTC-12", -12],
    ["UTC-08", -8],
    ["UTC+02", 2],
    ["GMT+02", 2],
  ] as Array<[string, number]>)("fixed offset %s", (raw, hours) => {
    expect(offset(resolveTz(raw))).toBe(hours * 60);
  });

  it("zero padded and bare offsets agree", () => {
    expect(offset(resolveTz("UTC-08"))).toBe(offset(resolveTz("UTC-8")));
    expect(offset(resolveTz("UTC+02"))).toBe(offset(resolveTz("UTC+2")));
  });

  it("colon offset", () => {
    expect(offset(resolveTz("UTC+05:30"))).toBe(5 * 60 + 30);
    expect(offset(resolveTz("UTC-03:30"))).toBe(-(3 * 60 + 30));
  });

  // Issue #31: impossible numeric offsets (minute > 59, or |offset| >= 24 h)
  // must fall back to UTC with the unknown-timezone warning instead of
  // silently producing a fixed offset.
  it.each(["UTC+25", "UTC+24", "UTC+24:00", "UTC+12:60", "UTC+05:99", "UTC-99:99"])(
    "impossible fixed offset %s falls back to UTC with a warning",
    (raw) => {
      resetWarnings();
      expect(offset(resolveTz(raw))).toBe(0);
      const total = Object.values(warningCounts()).reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThanOrEqual(1);
      resetWarnings();
    },
  );

  it.each([
    ["UTC+23:59", 23 * 60 + 59],
    ["UTC-23:59", -(23 * 60 + 59)],
    ["UTC+05:30", 5 * 60 + 30],
    ["UTC-03:30", -(3 * 60 + 30)],
    ["UTC+8", 8 * 60],
    ["UTC-08", -8 * 60],
    ["GMT+02", 2 * 60],
  ] as Array<[string, number]>)("boundary fixed offset %s", (raw, minutes) => {
    expect(offset(resolveTz(raw))).toBe(minutes);
  });

  it.each(["PT", "ET", "CT", "MT"])("floating regional alias %s observes DST", (raw) => {
    const tz = resolveTz(raw);
    expect(offset(tz, WINTER)).not.toBe(offset(tz, SUMMER));
  });

  it.each([
    ["PST", -8 * 60],
    ["PDT", -7 * 60],
    ["EDT", -4 * 60],
    ["MDT", -6 * 60],
    ["CDT", -5 * 60],
    ["CET", 60],
    ["CEST", 120],
  ] as Array<[string, number]>)("DST-specific abbreviation %j is literal", (raw, minutes) => {
    expect(isConfirmedTimezone(raw)).toBe(true);
    expect(offset(resolveTz(raw), WINTER)).toBe(minutes);
    expect(offset(resolveTz(raw), SUMMER)).toBe(minutes);
  });

  it.each(["CST", "IST", "BST"])("context-free abbreviation %j is ambiguous", (raw) => {
    expect(isConfirmedTimezone(raw)).toBe(false);
    expect(parseInstant("2026-07-15 12:00:00", raw)).toBeNull();
  });

  it("JST and KST aliases resolve to UTC+9", () => {
    expect(offset(resolveTz("JST"))).toBe(9 * 60);
    expect(offset(resolveTz("jst"))).toBe(9 * 60);
    expect(offset(resolveTz("KST"))).toBe(9 * 60);
  });

  it("SGT and HKT aliases resolve to UTC+8", () => {
    expect(offset(resolveTz("SGT"))).toBe(8 * 60);
    expect(offset(resolveTz("HKT"))).toBe(8 * 60);
  });

  it("spelled-out US zone names alias to PT/ET/CT/MT (#798)", () => {
    expect(isConfirmedTimezone("Pacific Time")).toBe(true);
    expect(isConfirmedTimezone("Eastern Time")).toBe(true);
    expect(resolveTz("Pacific Time")).toEqual(resolveTz("PT"));
    expect(resolveTz("Pacific Daylight Time")).toEqual(resolveTz("PDT"));
    expect(resolveTz("Central Standard Time")).toEqual(resolveTz("CT"));
    expect(isConfirmedTimezone("CST")).toBe(false);
    expect(parseInstant("2026-07-15 12:00:00", "Pacific Time")?.toISOString()).toBe(
      parseInstant("2026-07-15 12:00:00", "PT")?.toISOString(),
    );
  });

  it("IANA names", () => {
    const london = resolveTz("Europe/London");
    expect(offset(london, WINTER)).toBe(0);
    expect(offset(london, SUMMER)).toBe(60);

    const honolulu = resolveTz("Pacific/Honolulu");
    expect(offset(honolulu, WINTER)).toBe(-10 * 60);
    expect(offset(honolulu, SUMMER)).toBe(-10 * 60);
  });

  it("unknown value falls back to UTC with a warning", () => {
    resetWarnings();
    const tz = resolveTz("Mars/Olympus_Mons");
    expect(offset(tz)).toBe(0);
    const counts = warningCounts();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(1);
    resetWarnings();
  });

  it("parser rejects unknown and missing zones", () => {
    expect(parseInstant("2026-07-15 12:00:00", "Mars/Olympus_Mons")).toBeNull();
    expect(parseInstant("2026-07-15 12:00:00", "")).toBeNull();
    expect(parseInstant("2026-07-15 12:00:00", null)).toBeNull();
    expect(parseInstant("2026-07-15 12:00:00", undefined)).toBeNull();
  });

  it("July PST and PT produce different confirmed instants", () => {
    const pst = parseInstant("2026-07-15 12:00:00", "PST")!.getTime();
    const pt = parseInstant("2026-07-15 12:00:00", "PT")!.getTime();
    expect(pst).toBe(Date.UTC(2026, 6, 15, 20, 0, 0));
    expect(pt).toBe(Date.UTC(2026, 6, 15, 19, 0, 0));
  });

  it("CDT stays UTC-05 while CT observes its regional winter offset", () => {
    expect(parseInstant("2026-01-15 12:00:00", "CDT")?.toISOString()).toBe(
      "2026-01-15T17:00:00.000Z",
    );
    expect(parseInstant("2026-01-15 12:00:00", "CT")?.toISOString()).toBe(
      "2026-01-15T18:00:00.000Z",
    );
    expect(parseInstant("2026-07-15 12:00:00", "CDT")?.toISOString()).toBe(
      "2026-07-15T17:00:00.000Z",
    );
  });

  it("does not double-apply the DST offset for wall-clock times just after a transition (#726)", () => {
    // 2027-03-14 は America/New_York の夏時間開始日 (2:00 が 3:00 へ前進)。遷移直後の
    // 壁時計時刻は、素朴な UTC 解釈での offset 推定と実際の候補瞬間での offset が
    // 食い違うため、収束に2回目の反復を要する。誤って前回の候補瞬間から再度 offset を
    // 差し引くと (二重補正)、実在し一意に定まるはずの壁時計時刻から 1 時間以上ずれる。
    expect(parseInstant("2027-03-14 03:00:00", "America/New_York")?.toISOString()).toBe(
      "2027-03-14T07:00:00.000Z",
    );
    expect(parseInstant("2027-03-14 03:30:00", "America/New_York")?.toISOString()).toBe(
      "2027-03-14T07:30:00.000Z",
    );
    expect(parseInstant("2027-03-14 05:00:00", "America/New_York")?.toISOString()).toBe(
      "2027-03-14T09:00:00.000Z",
    );
    expect(parseInstant("2027-03-14 06:59:00", "America/New_York")?.toISOString()).toBe(
      "2027-03-14T10:59:00.000Z",
    );
    // 秋の巻き戻し (2027-11-07, 2:00 が2回発生) でも同じ二重補正が起きていた。
    expect(parseInstant("2027-11-07 03:00:00", "America/New_York")?.toISOString()).toBe(
      "2027-11-07T08:00:00.000Z",
    );
    expect(parseInstant("2027-11-07 05:00:00", "America/New_York")?.toISOString()).toBe(
      "2027-11-07T10:00:00.000Z",
    );
  });

  it("unknown timezone warning says the observation is rejected", () => {
    resetWarnings();
    expect(parseInstant("2026-07-15 12:00:00", "Mars/Olympus_Mons")).toBeNull();
    expect(warningCounts()).toHaveProperty(
      'unknown IANA timezone "Mars/Olympus_Mons"; observation rejected',
    );
    resetWarnings();
  });

  it("unknown value is not reported repeatedly", () => {
    resetWarnings();
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      for (let i = 0; i < 5; i++) {
        expect(offset(resolveTz("Totally/Bogus_Zone"))).toBe(0);
      }
    } finally {
      writeSpy.mockRestore();
    }
    // stderr への出力は最初の 1 回だけ（カウントは毎回増えるが出力はしない）。
    const warningLines = writeSpy.mock.calls.filter(([chunk]) =>
      String(chunk).includes("warning:"),
    ).length;
    expect(warningLines).toBeLessThanOrEqual(1);
    resetWarnings();
  });

  const ALL_UPSTREAM_TZ_VALUES = [
    // ccfddl (SPEC.md 1.1)
    "AoE",
    "UTC-12",
    "UTC-8",
    "UTC+0",
    "UTC",
    "UTC-7",
    "UTC-5",
    "UTC-4",
    "UTC+8",
    "UTC+1",
    "UTC+2",
    "UTC+3",
    "UTC+7",
    "UTC+9",
    "UTC+10",
    "UTC-6",
    "UTC-10",
    "UTC-11",
    "PT",
    // huggingface/ai-deadlines (SPEC.md 1.2)
    "UTC-08",
    "UTC+02",
    "GMT+02",
    "PST",
    "Europe/London",
    "Pacific/Honolulu",
  ];

  it.each(ALL_UPSTREAM_TZ_VALUES)("every upstream value resolves: %s", (raw) => {
    const tz = resolveTz(raw);
    expect(offset(tz)).not.toBeNull();
    const march = new Date(Date.UTC(2026, 2, 1, 9, 0, 0));
    expect(offset(tz, march)).not.toBeNull();
  });
});

describe("asDate and timezone caching fixes (#746)", () => {
  it("asDate parses ISO timestamps with time deterministically in UTC", () => {
    expect(asDate("2026-05-01 23:59:59")).toEqual(new Date(Date.UTC(2026, 4, 1)));
    expect(asDate("2026-05-01T23:59:59")).toEqual(new Date(Date.UTC(2026, 4, 1)));
    expect(asDate("2026-05-01T23:59:59Z")).toEqual(new Date(Date.UTC(2026, 4, 1)));
    expect(asDate("2026-05-01T15:00:00+09:00")).toEqual(new Date(Date.UTC(2026, 4, 1)));
    expect(asDate("2026-05-01")).toEqual(new Date(Date.UTC(2026, 4, 1)));
    expect(asDate(null)).toBeNull();
    expect(asDate(undefined)).toBeNull();
    expect(asDate("not-a-date")).toBeNull();
  });

  it("applies cached Intl.DateTimeFormat with consistent hourCycle across repeated calls", () => {
    const zone = resolveTz("America/New_York");
    const t1 = applyTz(Date.UTC(2026, 6, 1, 12, 0, 0), zone);
    const t2 = applyTz(Date.UTC(2026, 6, 1, 12, 0, 0), zone);
    expect(t1.getTime()).toBe(t2.getTime());
    expect(t1.toISOString()).toBe("2026-07-01T16:00:00.000Z");
  });
});
