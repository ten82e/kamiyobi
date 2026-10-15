import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RERANKER_ALGORITHM_REVISION, RERANKER_FEATURE_SCHEMA } from "../site/recommender.ts";
import {
  EMBEDDING_MODEL,
  EMBEDDING_REVISION,
  serializeVenueProfileArtifact,
} from "../src/embeddings.ts";
import type { Conference, Edition, EventDatePrecision } from "../src/model.ts";
import { cacheMetadata, cacheSlot, extractedRoot } from "../src/sources/base.ts";

const repo = join(import.meta.dirname, "..");
describe.each(["API", "CLI", "upstream CLI", "archive CLI"])("%s build", (entry) => {
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-llms-build-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["src", "site", "scripts"])
    cpSync(join(repo, dir), join(root, dir), { recursive: true });
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
  if (entry !== "API") {
    expect(existsSync(join(root, "data"))).toBe(false);
    mkdirSync(join(root, "data"));
    // Count tests supply fresh, unrelated profile inputs; no published artifacts are copied.
    const policy = {
      method: "count-test",
      max_prototypes: 3,
      source_year_max: 2025,
      embedding_model: EMBEDDING_MODEL,
      embedding_revision: EMBEDDING_REVISION,
    };
    const titles = ["Test profile alpha", "Test profile beta", "Test profile gamma"];
    writeFileSync(
      join(root, "data/venue-profiles.json"),
      serializeVenueProfileArtifact({
        policy,
        profiles: {
          fixture: {
            selection: policy,
            prototypes: titles,
            papers: titles.map((title) => ({
              title,
              year: 2025,
              source: "fixture",
              source_url: "https://example.org/fixture",
              collected_at: "2026-01-01T00:00:00Z",
            })),
          },
        },
      }),
    );
    writeFileSync(
      join(root, "config.yaml"),
      JSON.stringify({
        rollforward: { enabled: false },
        taxonomy: { test: { venues: ["A", "B", "C", "up-ccf", "up-ai"] } },
        categories: { test: {} },
      }),
    );
    writeFileSync(
      join(root, "guard.mjs"),
      "globalThis.fetch=async()=>{throw new Error('network forbidden in CLI count build')};",
    );
    writeFileSync(
      join(root, "data/recommender-reranker.json"),
      JSON.stringify({
        version: 1,
        algorithm_revision: RERANKER_ALGORITHM_REVISION,
        feature_schema: RERANKER_FEATURE_SCHEMA,
        intercept: 0,
        weights: Object.fromEntries(RERANKER_FEATURE_SCHEMA.map((name) => [name, 0])),
        blend: 0,
        confidence_thresholds: { sufficient: 0.8, ambiguous: 0.5 },
        confidence_policy: { sufficient_enabled: false },
      }),
    );
  }
  if (entry === "archive CLI") {
    writeFileSync(
      join(root, "guard.mjs"),
      `
const originalFetch=globalThis.fetch;
const routes={
  'https://codeload.github.com/ccfddl/ccf-deadlines/tar.gz/refs/heads/main':'ccfddl',
  'https://codeload.github.com/huggingface/ai-deadlines/tar.gz/refs/heads/main':'aideadlines'
};
globalThis.fetch=(url,opts)=>{
  const route=routes[String(url)];
  if(!route) throw new Error('unexpected upstream request: '+url);
  return originalFetch(process.env.COUNT_ARCHIVE_ORIGIN+'/'+route,opts);
};
`,
    );
    writeFileSync(
      join(root, "archive-runner.mjs"),
      `
import {createServer} from 'node:http';
import {readFileSync,appendFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const server=createServer((req,res)=>{
  const name=req.url?.slice(1);
  if(!['ccfddl','aideadlines'].includes(name)){res.writeHead(404).end();return;}
  appendFileSync('requests.jsonl',JSON.stringify(name)+'\\n');
  res.writeHead(200,{'Content-Type':'application/gzip'});
  res.end(readFileSync('archives/'+name+'.tar.gz'));
});
server.listen(0,'127.0.0.1',()=>{
  const child=spawn(process.execPath,process.argv.slice(2),{
    stdio:'inherit',env:{...process.env,COUNT_ARCHIVE_ORIGIN:'http://127.0.0.1:'+server.address().port}
  });
  child.on('error',err=>{console.error(err);server.close(()=>process.exit(1));});
  child.on('exit',code=>server.close(()=>process.exit(code??1)));
});
`,
    );
  }
  const upstreamEntry = entry === "upstream CLI" || entry === "archive CLI";
  function clearOnlineOutputs() {
    for (const path of ["data/snapshot.json", "data/source-snapshots"])
      rmSync(join(root, path), { recursive: true, force: true });
  }
  function assertNoGeneratedInputs() {
    for (const path of [
      "public",
      ".cache",
      "data/snapshot.json",
      "data/curated.generated.yaml",
      "empty-cache",
      "data/source-snapshots",
      "data/primary_overrides.yaml",
    ])
      expect(existsSync(join(root, path)), `generated input present: ${path}`).toBe(false);
    if (entry === "API") expect(existsSync(join(root, "data"))).toBe(false);
  }
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
      categories: ["test"],
      editions,
      sources: ["manual"],
    };
  }
  function buildAndCheck(
    confs: Conference[] | null,
    expected: typeof zero,
    other: number,
    dated: number,
  ) {
    if (entry === "archive CLI") {
      rmSync(join(root, "archive-cache"), { recursive: true, force: true });
      rmSync(join(root, "requests.jsonl"), { force: true });
      clearOnlineOutputs();
      expect(existsSync(join(root, "archive-cache")), "archive cache must start empty").toBe(false);
    }
    assertNoGeneratedInputs();
    writeFileSync(join(root, "input.json"), JSON.stringify(confs));
    if (entry === "CLI")
      writeFileSync(
        join(root, "data/manual.yaml"),
        JSON.stringify({
          conferences: confs!.map((conf) => ({
            ...conf,
            editions: conf.editions.map((ed) => ({ ...ed, id: ed.edition_id })),
          })),
        }),
      );
    const command =
      entry === "API"
        ? ["build.mjs"]
        : [
            "--import",
            "./guard.mjs",
            "src/cli.ts",
            "build",
            "--out",
            "out",
            "--config",
            "config.yaml",
            "--cache",
            entry === "archive CLI"
              ? "archive-cache"
              : entry === "upstream CLI"
                ? "upstream-cache"
                : "empty-cache",
            ...(entry === "archive CLI" ? [] : ["--offline"]),
            "--no-embeddings",
            "--now",
            "2026-08-09T00:00:00Z",
          ];
    const child = spawnSync(
      process.execPath,
      entry === "archive CLI" ? ["archive-runner.mjs", ...command] : command,
      {
        cwd: root,
        encoding: "utf8",
        timeout: 60000,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
    const data = JSON.parse(readFileSync(join(root, "out/data.json"), "utf8")) as {
      conferences: {
        editions: {
          event_date_precision: keyof typeof zero;
          event_start: string | null;
          source: string;
        }[];
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
    if (upstreamEntry) {
      expect(existsSync(join(root, "data/manual.yaml"))).toBe(false);
      expect(new Set(editions.map((ed) => ed.source))).toEqual(new Set(["ccfddl", "aideadlines"]));
      expect(child.stderr).not.toContain("が取得できない");
    }
    if (entry === "archive CLI") {
      expect(
        readFileSync(join(root, "requests.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .sort(),
        "both archives must be downloaded over HTTP",
      ).toEqual(["aideadlines", "ccfddl"]);
      for (const [name, repoName, dir] of [
        ["ccfddl", "ccfddl/ccf-deadlines", "conference"],
        ["aideadlines", "huggingface/ai-deadlines", "src/data/conferences"],
      ]) {
        const slot = cacheSlot(join(root, "archive-cache"), repoName, "main");
        expect(
          cacheMetadata(slot)?.contentHash,
          "downloaded archive bytes must reach cache metadata",
        ).toBe(
          createHash("sha256")
            .update(readFileSync(join(root, "archives", `${name}.tar.gz`)))
            .digest("hex"),
        );
        const extracted = extractedRoot(slot);
        expect(extracted, "downloaded archive must be extracted").not.toBeNull();
        expect(
          readFileSync(join(extracted!, dir, "counts.yaml"), "utf8"),
          "downloaded rows must reach extracted cache",
        ).toBe(readFileSync(rawPath(repoName, dir), "utf8"));
      }
      clearOnlineOutputs();
    }
    assertNoGeneratedInputs();
  }
  function rawPath(repoName: string, dir: string) {
    return entry === "archive CLI"
      ? join(root, "archive-input", repoName.replaceAll("/", "__"), "raw", dir, "counts.yaml")
      : join(cacheSlot(join(root, "upstream-cache"), repoName, "main"), "raw", dir, "counts.yaml");
  }
  if (!upstreamEntry) {
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
      if (entry === "CLI") {
        const configPath = join(root, "config.yaml");
        writeFileSync(
          configPath,
          JSON.stringify({ ...JSON.parse(readFileSync(configPath, "utf8")), exclude: ["C"] }),
        );
        buildAndCheck(confs, zero, 0, 0);
      } else buildAndCheck([], zero, 0, 0);
    });
  } else {
    function rawInputs() {
      return {
        ccf: [
          {
            title: "UP-CCF",
            sub: "DS",
            confs: [
              {
                year: 2027,
                id: "ccf27",
                date: "May 1-2, 2027",
                link: "https://ccf.example.org/2027",
              },
              {
                year: 2028,
                id: "ccf28",
                date: "May 1-2, 2028",
                link: "https://ccf.example.org/2028",
              },
            ],
          },
        ],
        ai: [
          {
            title: "UP-AI",
            year: 2027,
            id: "ai27",
            date: "June 1, 2027",
            link: "https://ai.example.org/2027",
          },
          { title: "UP-AI", year: 2028, id: "ai28", date: "", link: "https://ai.example.org/2028" },
        ],
      };
    }
    function writeRaw(input: ReturnType<typeof rawInputs>) {
      const cache = join(root, "upstream-cache");
      rmSync(cache, { recursive: true, force: true });
      for (const [repoName, dir, rows] of [
        ["ccfddl/ccf-deadlines", "conference", input.ccf],
        ["huggingface/ai-deadlines", "src/data/conferences", input.ai],
      ] as const) {
        const path = join(rawPath(repoName, dir), "..");
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "counts.yaml"), JSON.stringify(rows));
        if (entry === "archive CLI") {
          mkdirSync(join(root, "archives"), { recursive: true });
          execFileSync("tar", [
            "-czf",
            join(
              root,
              "archives",
              repoName.startsWith("ccfddl/") ? "ccfddl.tar.gz" : "aideadlines.tar.gz",
            ),
            "-C",
            join(root, "archive-input", repoName.replaceAll("/", "__")),
            "raw",
          ]);
        }
      }
    }
    function writeOverrides(editions: Record<string, unknown>) {
      writeFileSync(
        join(root, "data/overrides.yaml"),
        JSON.stringify({ conferences: { "up-ccf": { editions } } }),
      );
    }
    it("tracks additions and removals from both raw upstream sources after overrides", () => {
      const input = rawInputs();
      writeRaw(input);
      writeOverrides({ ccf28: { event_date_precision: "month-only" } });
      buildAndCheck(
        null,
        { ...zero, "exact-range": 1, "single-day": 1, "month-only": 1, unverified: 1 },
        2,
        1,
      );
      input.ccf[0].confs.push({
        year: 2029,
        id: "ccf29",
        date: "TBA",
        link: "https://ccf.example.org/2029",
      });
      input.ai.push({
        title: "UP-AI",
        year: 2029,
        id: "ai29",
        date: "June 1-2, 2029",
        link: "https://ai.example.org/2029",
      });
      writeRaw(input);
      buildAndCheck(
        null,
        {
          ...zero,
          "exact-range": 2,
          "single-day": 1,
          "month-only": 1,
          unverified: 1,
          "not-announced": 1,
        },
        3,
        1,
      );
      input.ccf[0].confs.shift();
      input.ai.splice(0, 1);
      writeRaw(input);
      buildAndCheck(
        null,
        { ...zero, "exact-range": 1, "month-only": 1, unverified: 1, "not-announced": 1 },
        3,
        1,
      );
    });
    it("tracks override-only precision, date coverage and edition removal with unchanged upstream inputs", () => {
      const input = rawInputs();
      writeRaw(input);
      const before = [...Object.values(input).map((rows) => JSON.stringify(rows))];
      writeOverrides({ ccf28: { event_date_precision: "month-only" } });
      buildAndCheck(
        null,
        { ...zero, "exact-range": 1, "single-day": 1, "month-only": 1, unverified: 1 },
        2,
        1,
      );
      writeOverrides({
        ccf28: {
          event_date_precision: "unverified",
          date_text: "",
          event_start: null,
          event_end: null,
        },
      });
      buildAndCheck(null, { ...zero, "exact-range": 1, "single-day": 1, unverified: 2 }, 2, 0);
      writeOverrides({
        ccf28: {
          event_date_precision: "single-day",
          event_start: "2028-05-03",
          event_end: "2028-05-03",
        },
      });
      buildAndCheck(null, { ...zero, "exact-range": 1, "single-day": 2, unverified: 1 }, 1, 0);
      writeOverrides({
        ccf27: { drop: true },
        ccf28: {
          event_date_precision: "split-dates",
          event_start: "2028-05-03",
          event_end: "2028-05-05",
        },
      });
      buildAndCheck(null, { ...zero, "single-day": 1, "split-dates": 1, unverified: 1 }, 2, 1);
      expect([JSON.stringify(input.ccf), JSON.stringify(input.ai)]).toEqual(before);
      expect(readFileSync(rawPath("ccfddl/ccf-deadlines", "conference"), "utf8")).toBe(before[0]);
      expect(
        readFileSync(rawPath("huggingface/ai-deadlines", "src/data/conferences"), "utf8"),
      ).toBe(before[1]);
    });
  }
});
