import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { Conference, Edition, EventDatePrecision } from "../src/model.ts";

const repo = join(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "kamiyobi-llms-build-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const dir of ["src", "site"]) cpSync(join(repo, dir), join(root, dir), { recursive: true });
for (const file of ["package.json", "tsconfig.json"]) cpSync(join(repo, file), join(root, file));
symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
writeFileSync(
  join(root, "build.mjs"),
  `
import {readFileSync} from 'node:fs';
import {setRoot,buildAll} from './src/build.ts';
globalThis.fetch=async()=>{throw new Error('network forbidden in count build')};
setRoot(import.meta.dirname);
const confs=JSON.parse(readFileSync('input.json','utf8'));
for(const conf of confs) for(const ed of conf.editions)
  for(const key of ['event_start','event_end']) if(ed[key]) ed[key]=new Date(ed[key]);
await buildAll(confs,{},'out',new Date('2026-08-09T00:00:00Z'),{
  noEmbeddings:true,localEmbeddingsOnly:true,venuePapers:{},reranker:null
});
`,
);
const zero = {
  "exact-range": 0,
  "single-day": 0,
  "month-only": 0,
  "split-dates": 0,
  unverified: 0,
  "not-announced": 0,
};
function edition(precision: EventDatePrecision, dated = false): Edition {
  return {
    year: 2028,
    edition_id: precision,
    link: "https://example.org/",
    place: "Tokyo",
    date_text: "",
    event_date_precision: precision,
    event_start: dated ? new Date("2028-05-01T00:00:00Z") : null,
    event_end: dated ? new Date("2028-05-02T00:00:00Z") : null,
    deadlines: [],
    estimated: false,
    source: "manual",
  };
}
function conference(key: string, editions: Edition[]): Conference {
  return {
    key,
    title: key,
    full_name: key,
    link: "https://example.org/",
    rank: {},
    dblp: null,
    upstream_sub: null,
    tags: [],
    categories: [],
    editions,
    sources: ["manual"],
  };
}
function buildAndCheck(confs: Conference[], expected: typeof zero, other: number, dated: number) {
  for (const dir of ["data", "public", ".cache"]) expect(existsSync(join(root, dir))).toBe(false);
  writeFileSync(join(root, "input.json"), JSON.stringify(confs));
  const child = spawnSync(process.execPath, ["build.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 60000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
  const data = JSON.parse(readFileSync(join(root, "out/data.json"), "utf8")) as {
    conferences: {
      editions: { event_date_precision: keyof typeof zero; event_start: string | null }[];
    }[];
  };
  const editions = data.conferences.flatMap((conf) => conf.editions);
  const actual = { ...zero };
  for (const ed of editions) actual[ed.event_date_precision]++;
  expect(actual, "published data must retain the independently specified input counts").toEqual(
    expected,
  );
  const uncertain = editions.filter(
    (ed) => !["exact-range", "single-day"].includes(ed.event_date_precision),
  );
  expect(uncertain).toHaveLength(other);
  const withDates = uncertain.filter((ed) => ed.event_start !== null);
  expect(withDates).toHaveLength(dated);
  const lines = readFileSync(join(root, "out/llms.txt"), "utf8")
    .split("\n")
    .filter((line) => line.includes("- event_date_precision:"));
  expect(lines).toHaveLength(1);
  const matches = [...lines[0].matchAll(/'([^']+)'（[^）]*・([\d,]+) 版）/g)];
  expect(matches).toHaveLength(6);
  const published = Object.fromEntries(
    matches.map((m) => [m[1], Number(m[2].replaceAll(",", ""))]),
  );
  expect(published, "llms.txt must count the same editions as data.json").toEqual(actual);
  const coverage = /以外の ([\d,]+) 版のうち、([\d,]+) 版には event_start/.exec(lines[0]);
  expect(coverage).not.toBeNull();
  expect(
    Number(coverage![1].replaceAll(",", "")),
    "llms.txt uncertain count must match data.json",
  ).toBe(uncertain.length);
  expect(
    Number(coverage![2].replaceAll(",", "")),
    "llms.txt dated count must match data.json",
  ).toBe(withDates.length);
  for (const dir of ["data", "public", ".cache"]) expect(existsSync(join(root, dir))).toBe(false);
}
it("rebuilds llms.txt counts from all published editions as editions are added and removed", () => {
  expect(existsSync(join(root, "out"))).toBe(false);
  const confs = [
    conference("A", [edition("exact-range", true), edition("unverified")]),
    conference("B", [edition("month-only", true)]),
  ];
  buildAndCheck(confs, { ...zero, "exact-range": 1, unverified: 1, "month-only": 1 }, 2, 1);
  confs[1].editions.push(
    edition("unverified", true),
    edition("not-announced"),
    edition("single-day", true),
    edition("split-dates", true),
  );
  buildAndCheck(
    confs,
    {
      ...zero,
      "exact-range": 1,
      unverified: 2,
      "month-only": 1,
      "not-announced": 1,
      "single-day": 1,
      "split-dates": 1,
    },
    5,
    3,
  );
  confs.splice(0, 1);
  buildAndCheck(
    confs,
    {
      ...zero,
      unverified: 1,
      "month-only": 1,
      "not-announced": 1,
      "single-day": 1,
      "split-dates": 1,
    },
    4,
    3,
  );
});
it("rebuilds precision and coverage counts when the same edition changes certainty and dates", () => {
  const event = edition("unverified", true);
  const confs = [conference("C", [event, edition("not-announced")])];
  buildAndCheck(confs, { ...zero, unverified: 1, "not-announced": 1 }, 2, 1);
  event.event_date_precision = "exact-range";
  buildAndCheck(confs, { ...zero, "exact-range": 1, "not-announced": 1 }, 1, 0);
  event.event_date_precision = "month-only";
  buildAndCheck(confs, { ...zero, "month-only": 1, "not-announced": 1 }, 2, 1);
  event.event_start = null;
  event.event_end = null;
  buildAndCheck(confs, { ...zero, "month-only": 1, "not-announced": 1 }, 2, 0);
  buildAndCheck([], zero, 0, 0);
});
