import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { env } from "@huggingface/transformers";
import { afterAll, beforeAll, expect, it } from "vitest";
import R from "../site/recommendation.ts";
import {
  evaluateLiveConsumers,
  LIVE_CONSUMER_SURFACES,
  type LiveConsumerPaper,
  type LiveConsumerResult,
  liveConsumerCases,
} from "./live_consumer_eval.ts";
import { prepareLiveConsumerSite } from "./live_consumer_site.ts";

const repo = join(import.meta.dirname, "..");
const names = [
  "live-consumer-papers",
  "live-consumer-confirmation",
  "live-consumer-author-inputs",
  "live-consumer-final-holdout",
];
const hashes = [
  "421e9b25b43da7234f2f0d0e1d1f6eded453d196f78e3e2fa41ef04e0994aa45",
  "c347ae2529ec406b67c6484ff9efcfaa0389908f17388114f5751440a4455015",
  "6425c861c675e65dbd02ff7be52365b0ab9cd24edd2ef33bf27ba73ecf006af4",
  "34b52282237dfad48d12363c4afec4062b87e875d1d6dcf1fb2c19eb51ae2c3a",
];
const papers: LiveConsumerPaper[] = names.flatMap((name, index) => {
  const raw = readFileSync(join(repo, "tests/fixtures", `${name}.json`), "utf8");
  if (createHash("sha256").update(raw).digest("hex") !== hashes[index])
    throw new Error("evaluation labels or inputs changed");
  const fixture = JSON.parse(raw);
  if (fixture.top_k !== 5 || fixture.candidate_count !== 696)
    throw new Error("evaluation gate changed");
  return fixture.papers;
});
const cases = liveConsumerCases(papers);
let root: string;
let results: LiveConsumerResult[] = [];
const previousCache = env.cacheDir;
beforeAll(async () => {
  root = prepareLiveConsumerSite();
  results = await evaluateLiveConsumers(repo, root, cases);
}, 600000);
afterAll(() => {
  env.cacheDir = previousCache;
  R.setTopicVecs(null);
  R.setNameIdf(null);
  if (root) rmSync(root, { recursive: true, force: true });
});
for (const c of cases)
  for (const surface of LIVE_CONSUMER_SURFACES)
    it(`${surface}: ${c.paper.id}/${c.mode} finds a suitable venue in the unchanged top five`, () => {
      const result = results.find(
        (r) => r.id === c.paper.id && r.mode === c.mode && r.surface === surface,
      );
      expect(result).toBeDefined();
      expect(
        result!.keys.slice(0, 5).some((key) => c.paper.acceptable_venues.includes(key)),
        JSON.stringify(result!.keys.slice(0, 10)),
      ).toBe(true);
    });
