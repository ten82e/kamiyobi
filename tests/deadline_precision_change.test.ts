import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";

it.each(["2026-12-01T14:59:00Z", "2026-12-01T03:00:00Z"])(
  "確定時刻 %s を時刻未確認に訂正しても、前倒しや延長と断定しない",
  (value) => {
    const dl = {
      precision: "date-only",
      local_date: "2026-12-01",
      label: "投稿締切",
      superseded_deadlines: [{ value, precision: "exact" }],
    };
    expect(Recommender.deadlineShiftsOf(dl)).toMatchObject([
      { later: false, precisionChangeLabelJa: "時刻未確認へ訂正" },
    ]);
    expect(Recommender.deadlineShiftLineJa(dl)).toContain("時刻未確認へ訂正");
    expect(Recommender.deadlineShiftLineJa(dl)).not.toMatch(/前倒し|延長/);
    expect(Recommender.isExtendedDeadline(dl)).toBe(false);
    expect(Recommender.searchMatcher("精度訂正")(Recommender.deadlineShiftSearchWords(dl))).toBe(
      true,
    );
  },
);

it("日付のみから時刻表記へ変わったときも、日付の正午と比較して延長扱いしない", () => {
  const dl = {
    precision: "exact",
    utc: "2026-12-01T14:59:00Z",
    label: "投稿締切",
    superseded_deadlines: [{ value: "2026-12-01", precision: "date-only" }],
  };
  expect(Recommender.deadlineShiftLineJa(dl)).toContain("時刻表記へ更新");
  expect(Recommender.deadlineShiftLineJa(dl)).not.toMatch(/前倒し|延長/);
  expect(Recommender.isExtendedDeadline(dl)).toBe(false);
});

it("時刻まで確認できた同士の変更では、元の延長・前倒し判定を保つ", () => {
  for (const [utc, extended] of [
    ["2026-12-02T14:59:00Z", true],
    ["2026-11-30T14:59:00Z", false],
  ] as const) {
    const dl = {
      precision: "exact",
      utc,
      label: "投稿締切",
      superseded_deadlines: [{ value: "2026-12-01T14:59:00Z", precision: "exact" }],
    };
    expect(Recommender.isExtendedDeadline(dl)).toBe(extended);
    expect(Recommender.deadlineShiftLineJa(dl)).toContain(extended ? "延長" : "前倒し");
    expect(Recommender.deadlineShiftsOf(dl)[0].precisionChangeLabelJa).toBeUndefined();
  }
});
