import { cpSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildAll, ROOT, recordsOf, setRoot, toUpcomingMd } from "../src/build.ts";
import { makeConference, makeDeadline, makeEdition, REPO_ROOT, tempWork } from "./helpers.ts";

function input() {
  const meeting = (key: string, start: string, end = start) =>
    makeConference({
      key,
      title: key,
      editions: [
        makeEdition({
          year: 2029,
          edition_id: key,
          event_start: new Date(start),
          event_end: new Date(end),
          event_date_precision: start === end ? "single-day" : "exact-range",
        }),
      ],
    });
  return [
    meeting("ending", "2029-06-01"),
    meeting("tomorrow", "2029-06-02"),
    meeting("last-day", "2029-06-03"),
    meeting("outside", "2029-06-04"),
    meeting("running", "2029-05-31", "2029-06-02"),
    makeConference({
      key: "deadline",
      title: "deadline",
      editions: [
        makeEdition({
          year: 2029,
          deadlines: [makeDeadline("paper", "Paper", new Date("2029-06-02T15:00:00Z"), "UTC")],
        }),
      ],
    }),
    makeConference({
      key: "beyond-deadline",
      title: "beyond-deadline",
      editions: [
        makeEdition({
          year: 2029,
          deadlines: [makeDeadline("paper", "Paper", new Date("2029-06-02T15:00:00.001Z"), "UTC")],
        }),
      ],
    }),
  ];
}
const cases = [
  ["2029-06-01T14:59:59.999Z", "2029-06-01", "2029-06-02", true, false],
  ["2029-06-01T15:00:00.000Z", "2029-06-02", "2029-06-03", false, true],
] as const;
function check(text: string, c: (typeof cases)[number]) {
  const [, first, last, ending, edge] = c;
  expect(text).toContain(`対象期間: ${first} 〜 ${last}`);
  const rows = text.split("\n").filter((line) => line.startsWith("| "));
  const has = (name: string) => rows.some((line) => line.includes(`[${name} 2029]`));
  expect(has("ending")).toBe(ending);
  expect(has("tomorrow")).toBe(true);
  expect(has("last-day")).toBe(edge);
  expect(has("outside")).toBe(false);
  expect(has("running")).toBe(true);
  expect(has("deadline")).toBe(edge);
  expect(has("beyond-deadline")).toBe(false);
}
it("advances the displayed period and event boundary at JST midnight while keeping exact deadline cutoffs", () => {
  for (const c of cases) check(toUpcomingMd(recordsOf(input()), new Date(c[0]), 1), c);
});
it("builds matching Markdown and HTML periods from fresh inputs across JST midnight", async () => {
  const root = tempWork("kamiyobi-upcoming-jst-");
  for (const dir of ["site", "scripts", "src"])
    cpSync(join(REPO_ROOT, dir), join(root, dir), { recursive: true });
  for (const file of ["tsconfig.json", "package.json"])
    cpSync(join(REPO_ROOT, file), join(root, file));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  const originalRoot = ROOT;
  setRoot(root);
  try {
    for (const c of cases) {
      expect(existsSync(join(root, "data"))).toBe(false);
      await buildAll(input(), { site: { upcoming_days: 1 } }, join(root, "out"), new Date(c[0]), {
        noEmbeddings: true,
        localEmbeddingsOnly: true,
        venuePapers: {},
        reranker: null,
      });
      const md = readFileSync(join(root, "out/upcoming.md"), "utf8");
      check(md, c);
      const html = readFileSync(join(root, "out/upcoming.html"), "utf8");
      expect(html).toContain(`対象期間: ${c[1]} 〜 ${c[2]}`);
      expect(html.includes("last-day 2029")).toBe(c[4]);
      expect(html).not.toContain("outside 2029");
      expect(existsSync(join(root, "data"))).toBe(false);
    }
  } finally {
    setRoot(originalRoot);
  }
});
