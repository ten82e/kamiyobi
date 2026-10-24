import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@huggingface/transformers";
import { afterAll, beforeAll, expect, it } from "vitest";
import R from "../site/recommendation.ts";
import {
  evaluateLiveConsumers,
  firstAcceptableRank,
  LIVE_CONSUMER_SURFACES,
  type LiveConsumerPaper,
  type LiveConsumerResult,
  liveConsumerCases,
} from "./live_consumer_eval.ts";
import { prepareLiveConsumerSite } from "./live_consumer_site.ts";

/* Official CFP topics exist for only some venues. A venue without them must not be
 * displaced from the top five by those that have them, while a venue with them that
 * already ranks in the top five keeps its place. */
const repo = join(import.meta.dirname, "..");
const fixtureHashes: Record<string, string> = {
  "scope-displacement": "494ad3b8ac069c71e03280a280418211a28fc93cfdc72203779c1fd35c96ebfc",
  "live-consumer-author-inputs": "6425c861c675e65dbd02ff7be52365b0ab9cd24edd2ef33bf27ba73ecf006af4",
};
function fixture(name: string) {
  const raw = readFileSync(join(repo, "tests/fixtures", `${name}.json`), "utf8");
  if (createHash("sha256").update(raw).digest("hex") !== fixtureHashes[name])
    throw new Error("evaluation labels or inputs changed");
  const parsed = JSON.parse(raw);
  if (parsed.top_k !== 5 || parsed.candidate_count !== 696)
    throw new Error("evaluation gate changed");
  return parsed;
}
const displacement = fixture("scope-displacement") as {
  papers: LiveConsumerPaper[];
  protected: Array<{ fixture: string; id: string; modes: string[]; surfaces: string[] }>;
};
const protectedChecks = displacement.protected.map((entry) => {
  const paper = (fixture(entry.fixture).papers as LiveConsumerPaper[]).find(
    (p) => p.id === entry.id,
  );
  if (!paper) throw new Error(`protected case missing: ${entry.id}`);
  return { paper: { ...paper, modes: entry.modes }, surfaces: entry.surfaces };
});
const checks = [
  ...displacement.papers.map((paper) => ({ paper, surfaces: [...LIVE_CONSUMER_SURFACES] })),
  ...protectedChecks,
];
const cases = liveConsumerCases(checks.map((c) => c.paper));
let root: string;
let results: LiveConsumerResult[] = [];
const previousCache = env.cacheDir;
beforeAll(async () => {
  root = prepareLiveConsumerSite();
  results = await evaluateLiveConsumers(repo, root, cases);
  const report = cases.flatMap((c) =>
    LIVE_CONSUMER_SURFACES.map((surface) => {
      const keys = results.find(
        (r) => r.id === c.paper.id && r.mode === c.mode && r.surface === surface,
      )!.keys;
      return {
        id: c.paper.id,
        mode: c.mode,
        surface,
        rank: firstAcceptableRank(keys, c.paper.acceptable_venues),
        top5: keys.slice(0, 5),
      };
    }),
  );
  if (process.env.SCOPE_DISPLACEMENT_REPORT)
    writeFileSync(process.env.SCOPE_DISPLACEMENT_REPORT, `${JSON.stringify(report, null, 2)}\n`);
}, 600000);
afterAll(() => {
  env.cacheDir = previousCache;
  R.setTopicVecs(null);
  R.setNameIdf(null);
  if (root) rmSync(root, { recursive: true, force: true });
});
for (const check of checks)
  for (const c of cases.filter((c) => c.paper.id === check.paper.id))
    for (const surface of check.surfaces)
      it(`${surface}: ${c.paper.id}/${c.mode} keeps a suitable venue in the top five`, () => {
        const result = results.find(
          (r) => r.id === c.paper.id && r.mode === c.mode && r.surface === surface,
        );
        expect(result).toBeDefined();
        const rank = firstAcceptableRank(result!.keys, c.paper.acceptable_venues);
        expect(rank !== null && rank <= 5, JSON.stringify(result!.keys.slice(0, 10))).toBe(true);
      });
