import { cpSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import R from "../site/recommendation.ts";
import {
  assignShareIdentities,
  consolidateReviewedSubmissions,
} from "../site/submission-identity.ts";
import { buildAll, ROOT, setRoot } from "../src/build.ts";
import { conferencesFromJson } from "../src/model.ts";
import { REPO_ROOT, tempWork } from "./helpers.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

const now = new Date("2030-01-01T00:00:00Z");
const clocks = [
  now.getTime(),
  Date.parse("2030-01-02T11:59:59.999Z"),
  Date.parse("2030-01-02T12:00:00Z"),
  Date.parse("2030-02-02T00:00:00Z"),
  Date.parse("2030-02-11T00:00:00Z"),
];
function inspect(raw: unknown, recommendation: unknown, history: unknown) {
  const app = siteRuntime();
  const helpers = [
    "isRecord",
    "hasOptionalString",
    "isStringArray",
    "isDeadlineRecord",
    "isEditionRecord",
    "isConferenceRecord",
    "sourceRecord",
    "calendarSpan",
    "catalogWindow",
    "deadlineSummary",
    "catalogFrom",
    "rowShareKeyJa",
    "buildRows",
    "summaryDeadlineRows",
    "setRecommendationProfile",
    "setDeadlineProfile",
    "rowIsPast",
    "rowIsFuture",
    "rowShownDayMs",
    "rowAfter",
    "windowLimitMs",
    "renderSummaryStats",
  ];
  const initialization = /let rows = buildRows\(DATA\);\s*const summaryRows = [^\n]+;/.exec(
    app,
  )?.[0];
  expect(initialization).toBeDefined();
  return new Function(
    "Recommender",
    "assignShareIdentities",
    "consolidateReviewedSubmissions",
    "raw",
    "recommendation",
    "history",
    "clocks",
    `
    ${helpers.map((name) => jsFunction(app, name)).join("\n")}
    const DATA=catalogFrom(raw), DAY=86400000, els={};
    let activeData=DATA, clock=clocks[0];
    const Date=class extends globalThis.Date { static now(){return clock;} };
    const $=id=>els[id]??=( {textContent:""} );
    ${initialization}
    const sizes=[];
    const values=clocks.map(time=>{
      clock=time;
      return [DATA,recommendation,history].map((data,index)=>{
        if(index===1)setRecommendationProfile(data);else setDeadlineProfile(catalogFrom(data));
        sizes.push(rows.length);
        renderSummaryStats();
        return els.statUpcoming.textContent;
      });
    });
    return {values,sizes,parsed:DATA.deadline_summary};
  `,
  )(R, assignShareIdentities, consolidateReviewedSubmissions, raw, recommendation, history, clocks);
}

it("keeps full-collection counts across modes and short windows while advancing through uncertain deadline bounds", async () => {
  const root = tempWork("kamiyobi-summary-scope-");
  for (const dir of ["src", "site", "scripts"])
    cpSync(join(REPO_ROOT, dir), join(root, dir), { recursive: true });
  for (const file of ["package.json", "tsconfig.json"])
    cpSync(join(REPO_ROOT, file), join(root, file));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  const exact = (kind: string, utc: string) => ({ kind, utc, tz_raw: "UTC" });
  const input = conferencesFromJson({
    conferences: [
      {
        key: "test",
        title: "Test",
        categories: ["systems"],
        editions: [
          {
            id: "test30",
            year: 2030,
            deadlines: [
              {
                kind: "paper",
                precision: "date-only",
                local_date: "2030-01-01",
              },
              exact("paper", "2030-01-03T00:00:00Z"),
              exact("paper", "2030-01-20T00:00:00Z"),
              exact("abstract", "2030-01-31T14:00:00Z"),
              exact("paper", "2030-01-31T15:00:00Z"),
              exact("paper", "2030-02-10T00:00:00Z"),
              { kind: "abstract", precision: "date-only", local_date: "2030-02-01" },
              exact("paper", "2029-12-30T00:00:00Z"),
              exact("notification", "2030-01-04T00:00:00Z"),
              exact("journal", "2030-01-06T00:00:00Z"),
            ],
          },
          {
            id: "test31",
            year: 2031,
            estimated: true,
            deadlines: [exact("paper", "2030-01-05T00:00:00Z")],
          },
        ],
      },
    ],
  });
  const saved = JSON.stringify(input);
  const previous = ROOT;
  setRoot(root);
  try {
    for (const days of [7, 180]) {
      expect(existsSync(join(root, "data"))).toBe(false);
      const out = join(root, `out-${days}`);
      await buildAll(input, { site: { upcoming_days: days } }, out, now, {
        noEmbeddings: true,
        localEmbeddingsOnly: true,
        venuePapers: {},
        reranker: null,
      });
      const catalog = JSON.parse(readFileSync(join(out, "catalog.json"), "utf8"));
      const recommendation = JSON.parse(
        readFileSync(join(out, "recommendation-index.json"), "utf8"),
      );
      const history = JSON.parse(readFileSync(join(out, "data.json"), "utf8"));
      expect(catalog.deadline_summary).toHaveLength(7);
      const result = inspect(catalog, recommendation, history);
      expect(result.values).toEqual(
        [4, 6, 5, 2, 0].map((count) => [String(count), String(count), String(count)]),
      );
      expect(result.sizes[1]).toBeLessThan(result.sizes[2]);
      if (days === 7) expect(result.sizes[0]).toBeLessThan(result.sizes[2]);
      for (const bad of [
        undefined,
        null,
        {},
        [null],
        [{ t: 0, tLast: -1, tShown: 0, dateOnly: false }],
        [{ t: 0, tLast: 1, tShown: "bad", dateOnly: false }],
      ]) {
        const legacy = inspect({ ...catalog, deadline_summary: bad }, recommendation, history);
        expect(legacy.parsed).toBeUndefined();
        expect(legacy.values[0]).toEqual(Array(3).fill(days === 7 ? "少なくとも 2" : "4"));
      }
      const empty = { ...catalog, conferences: [], deadline_summary: [] };
      expect(inspect(empty, empty, empty).values).toEqual(clocks.map(() => ["0", "0", "0"]));
      expect(existsSync(join(root, "data"))).toBe(false);
    }
    expect(JSON.stringify(input)).toBe(saved);
  } finally {
    setRoot(previous);
    R.setNameIdf(null);
    R.setReranker(null);
  }
});
