import { expect, it } from "vitest";
import { deadlineMoment } from "../scripts/reverification-manifest.ts";

it("keeps date-only deadlines date-only and uses their uncertainty boundary", () => {
  expect(
    deadlineMoment({
      precision: "date-only",
      local_date: "2026-08-24",
      latest_utc: "2026-08-25T11:59:59.999Z",
      kind: "paper",
    }),
  ).toEqual({ display: "2026-08-24", cutoff: "2026-08-25T11:59:59.999Z" });
  expect(deadlineMoment({ utc: "2026-08-24T23:59:59Z", kind: "paper" })).toEqual({
    display: "2026-08-24T23:59:59Z",
    cutoff: "2026-08-24T23:59:59Z",
  });
  expect(deadlineMoment({ precision: "date-only", local_date: "2026-08-24", kind: "paper" })).toBe(
    null,
  );
});
