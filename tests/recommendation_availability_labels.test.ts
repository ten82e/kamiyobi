import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";

const source = readFileSync(new URL("../site/app.ts", import.meta.url), "utf8");
const start = source.indexOf("  function recommendationAvailability(");
const end = source.indexOf("  const trustLabel:", start);
if (start < 0 || end < 0) throw new Error("availability formatter not found");
const format = runInNewContext(
  `${stripTypeScriptTypes(source.slice(start, end))}\nrecommendationAvailability;`,
  {
    Recommender,
    UNCONFIRMED_JA: "未確認",
    fmtJst: (date: Date) => date.toISOString(),
    fmtDate: (date: Date) => date.toISOString(),
    fmtAoE: (date: Date) => date.toISOString(),
  },
) as (row: {
  _availability: { status: string; local_date?: string | null; estimated?: boolean };
  dl: object;
}) => string;

it.each([
  ["open", false, "次回締切: 2026-10-16(金)（時刻未確認）"],
  ["open", true, "次回締切: 2026-10-16(金)（時刻未確認）（推定）"],
  ["uncertain", false, "次回締切: 2026-10-16(金)（時刻未確認。終了済みの可能性があります）"],
  ["uncertain", true, "次回締切: 2026-10-16(金)（時刻未確認。終了済みの可能性があります）（推定）"],
])("keeps date-only status %s distinguishable when estimated=%s", (status, estimated, expected) => {
  const rows = Recommender.candidateRows({
    conferences: [
      {
        key: "distributed",
        title: "Distributed Systems",
        categories: ["systems"],
        editions: [
          {
            id: "distributed-2026",
            year: 2026,
            estimated,
            deadlines: [
              {
                kind: "paper",
                precision: "date-only",
                local_date: "2026-10-16",
                earliest_utc: "2026-10-15T10:00:00Z",
                latest_utc: "2026-10-17T11:59:59Z",
              },
            ],
          },
        ],
      },
    ],
  });
  const now = Date.parse(status === "open" ? "2026-10-13T00:00:00Z" : "2026-10-16T00:00:00Z");
  const result = Recommender.venueRecommendations(
    rows,
    Recommender.parsePaperLines("Distributed Systems"),
    null,
    now,
  );
  expect(result).toHaveLength(1);
  expect(result[0].availability.status).toBe(status);
  const text = format({ _availability: result[0].availability, dl: result[0].row.dl });
  expect(text).toBe(expected);
  expect(text).not.toMatch(/JST|UTC|\d{2}:\d{2}/);
});

it("preserves the closed status of a dated actual deadline", () => {
  expect(
    format({
      _availability: { status: "past", local_date: "2026-10-01", estimated: false },
      dl: {},
    }),
  ).toBe("締切済み");
});
