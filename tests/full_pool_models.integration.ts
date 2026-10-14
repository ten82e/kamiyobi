import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AutoModel,
  AutoTokenizer,
  env,
  FeatureExtractionPipeline,
} from "@huggingface/transformers";
import { afterAll, beforeAll, expect, it } from "vitest";
import Recommender from "../site/recommendation.ts";
import { consolidateReviewedSubmissions } from "../site/submission-identity.ts";
import { profileTexts, topicProfileTexts } from "../src/embedding-profiles.ts";
import {
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  EMBEDDING_MULTI_REVISION,
  EMBEDDING_REVISION,
  embedEach,
  embedSet,
  embedTopics,
} from "../src/embedding-runtime.ts";
import { freshFullVenuePool } from "./full_venue_pool.ts";

const root = join(import.meta.dirname, "..");
const corpora = [
  "evaluation",
  "independent",
  "holdout-2025",
  "confirmation-2025",
  "precision-confirmation",
];
interface Paper {
  id: string;
  language: "en" | "ja";
  title: string;
  abstract: string;
  acceptable_venues: string[];
  source: string;
}
const fixtureTexts = corpora.map((name) =>
  readFileSync(join(root, `tests/fixtures/real-model-${name}.json`), "utf8"),
);
const fixtures = fixtureTexts.map((text) => JSON.parse(text));
const fixtureHashes = [
  "367f8940d5f2083d929af2ad45c64daf82cd976a3bcb3f8968e896f2e037b033",
  "23e7d903707c9877f035f73ace261692593a324dcb73ecc52db668df59db5ecb",
  "0beca9bca180764d51ab42331e515698a4e469516def613ffc869426b5ca6c2d",
  "406736515612efbdc519b4d15e914cf34e1c8be7590bb01df6b2cf8dde5b775d",
  "29be714f32361db5153a0c9083d77c85f1fa4fe232862146997c59dfd4b7f5f2",
];
const confirmationText = readFileSync(
  join(root, "tests/fixtures/full-pool-confirmation.json"),
  "utf8",
);
const confirmation = JSON.parse(confirmationText) as { papers: Paper[] };
const holdoutText = readFileSync(join(root, "tests/fixtures/full-pool-holdout.json"), "utf8");
const holdout = JSON.parse(holdoutText) as { papers: Paper[] };

const papers = [
  ...fixtures.flatMap((fixture) => fixture.papers),
  ...confirmation.papers,
  ...holdout.papers,
] as Paper[];
const modes = ["title", "abstract", "title+abstract"] as const;
interface Result {
  id: string;
  language: string;
  mode: string;
  dtype: string;
  search: string[];
  recommendation: string[];
  acceptable: string[];
}
const results: Result[] = [];
const previousCache = env.cacheDir;
let raw: string;
let keys: string[];
let representedVenueKeys: string[];

beforeAll(async () => {
  for (const [index, text] of fixtureTexts.entries())
    expect(createHash("sha256").update(text).digest("hex")).toBe(fixtureHashes[index]);
  expect(createHash("sha256").update(confirmationText).digest("hex")).toBe(
    "60e3f8ea7c65ee8789c0291dd9edfc5abbd45814e61a10b945cbeaf6ca06ec1c",
  );
  const priorSources = new Set(fixtures.flatMap((f) => f.papers.map((p: Paper) => p.source)));
  for (const paper of confirmation.papers) expect(priorSources.has(paper.source)).toBe(false);
  expect(createHash("sha256").update(holdoutText).digest("hex")).toBe(
    "8b7a82c849ffb8658d6265981d6dcfe4a250422b6dc310c960996ee505d39102",
  );
  const developmentSources = new Set([
    ...priorSources,
    ...confirmation.papers.map((p) => p.source),
  ]);
  for (const paper of holdout.papers) expect(developmentSources.has(paper.source)).toBe(false);
  const pool = freshFullVenuePool();
  raw = pool.raw;
  expect(pool.conferences).toHaveLength(696);
  expect(new Set(pool.conferences.map((c) => c.key)).size).toBe(696);
  // CFP text is independent of all evaluated papers; retain every other venue as a competitor.
  const identityNames = (text: string) =>
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s()（）]/g, "");
  const identities = new Map<string, string>();
  for (const venue of fixtures[0].venues as Array<{
    key: string;
    title: string;
    full_name: string;
  }>) {
    const exact = pool.conferences.find((conf) => conf.key === venue.key);
    const matches = pool.conferences.filter(
      (conf) =>
        identityNames(conf.title) === identityNames(venue.title) &&
        identityNames(conf.full_name).includes(identityNames(venue.full_name)),
    );
    identities.set(venue.key, exact?.key ?? (matches.length === 1 ? matches[0].key : venue.key));
  }
  const canonicalEvaluationKey = (key: string) => identities.get(key) ?? key;
  const conferences = pool.conferences.map((c) => ({ ...c, editions: [], papers: [] }));
  for (const paper of papers)
    expect(
      paper.acceptable_venues.some((key) =>
        conferences.some((c) => c.key === canonicalEvaluationKey(key)),
      ),
      paper.id,
    ).toBe(true);
  const consumerConferences = pool.conferences.map((conf) => ({ ...conf, papers: [] }));
  const datedRows = consolidateReviewedSubmissions(
    Recommender.candidateRows({ conferences: consumerConferences }),
    (row) => `${row.conf.key}|${row.ed.year ?? ""}|${row.kind}|${Math.trunc(row.t)}`,
  );
  const rows = Recommender.candidatePool(datedRows, consumerConferences, Date.UTC(2026, 0, 1));
  const represented = rows.flatMap((row) => [
    row.conf.key,
    ...(row.submission?.sourceRecords ?? []).map((record) => record.venueKey),
  ]);
  representedVenueKeys = [...new Set(represented)].sort();
  env.cacheDir = join(root, ".cache/embedding-models");
  Recommender.setReranker(null);
  Recommender.setPaperVecs(null);
  Recommender.setSigWeights(null);
  Recommender.setNameIdf(Recommender.buildNameIdf(conferences));
  for (const language of ["en", "ja"] as const) {
    const model = language === "en" ? EMBEDDING_MODEL : EMBEDDING_MULTI_MODEL;
    const revision = language === "en" ? EMBEDDING_REVISION : EMBEDDING_MULTI_REVISION;
    const profiles = profileTexts(conferences, pool.categoryNames, language === "ja", {});
    keys = profiles.keys;
    expect(keys).toHaveLength(696);
    const normalizedPapers = papers.map((paper) => ({
      id: paper.id,
      title: paper.title.normalize("NFKC").toLowerCase(),
      abstract: paper.abstract.normalize("NFKC").toLowerCase(),
    }));
    const leaks: string[] = [];
    for (const [index, text] of profiles.texts.entries()) {
      const normalized = text.normalize("NFKC").toLowerCase();
      for (const paper of normalizedPapers) {
        if (normalized.includes(paper.title)) leaks.push(`${keys[index]}/${paper.id}/title`);
        if (normalized.includes(paper.abstract)) leaks.push(`${keys[index]}/${paper.id}/abstract`);
      }
    }
    expect(leaks).toEqual([]);
    console.info(`${language}: embedding all ${keys.length} venue profiles`);
    const embeddings = await embedSet(model, profiles.texts, keys, revision);
    const topicProfiles = topicProfileTexts(conferences, pool.categoryNames, language === "ja");
    const topicLeaks: string[] = [];
    for (const [index, text] of topicProfiles.texts.entries()) {
      const normalized = text.normalize("NFKC").toLowerCase();
      for (const paper of normalizedPapers) {
        if (normalized.includes(paper.title))
          topicLeaks.push(`${topicProfiles.keys[index]}/${paper.id}/title`);
        if (normalized.includes(paper.abstract))
          topicLeaks.push(`${topicProfiles.keys[index]}/${paper.id}/abstract`);
      }
    }
    expect(topicLeaks).toEqual([]);
    const topicVecs = await embedTopics(model, topicProfiles.texts, topicProfiles.keys, revision);
    for (const vector of [...Object.values(embeddings), ...Object.values(topicVecs).flat()]) {
      expect(vector).toHaveLength(384);
      expect(vector.every(Number.isFinite)).toBe(true);
      expect(Math.hypot(...vector)).toBeCloseTo(1, 4);
    }
    Recommender.setTopicVecs(topicVecs);
    console.info(`${language}: profiles inferred`);
    const cases = papers
      .filter((p) => p.language === language)
      .flatMap((paper) => modes.map((mode) => ({ paper, mode })));
    const lines = cases.map(({ paper, mode }) =>
      Recommender.parsePaperLines(
        JSON.stringify([
          {
            title: mode === "abstract" ? "" : paper.title,
            abstract: mode === "title" ? "" : paper.abstract,
            keywords: "",
            venue: "",
          },
        ]),
      ),
    );
    const texts = lines.map((l) => Recommender.queryText(l));
    expect(new Set(texts).size).toBe(texts.length);
    for (const paperLines of lines)
      expect(Recommender.queryHasJapanese(paperLines)).toBe(language === "ja");

    const fp = await embedEach(model, texts, revision);
    console.info(`${language}: ${texts.length} queries inferred`);
    const tokenizer = await AutoTokenizer.from_pretrained(join(env.cacheDir!, model, revision), {
      local_files_only: true,
    });
    const q8 = new FeatureExtractionPipeline({
      task: "feature-extraction",
      tokenizer,
      model: await AutoModel.from_pretrained(model, { revision, device: "cpu", dtype: "q8" }),
    });
    try {
      for (let i = 0; i < cases.length; i++)
        for (const dtype of ["fp32", "q8"]) {
          const vector =
            dtype === "fp32"
              ? fp[i]
              : Array.from(
                  (await q8(texts[i], { pooling: "mean", normalize: true })).data as Float32Array,
                );
          expect(vector).toHaveLength(384);
          expect(Math.hypot(...vector)).toBeCloseTo(1, 4);
          const similarities = Object.fromEntries(
            keys.map((k) => [
              k,
              Recommender.semanticSimilarity(k, vector, embeddings, null, topicVecs),
            ]),
          );
          const scores = Object.fromEntries(
            keys.map((k) => [k, Recommender.semanticScore(k, vector, embeddings, null, topicVecs)]),
          );
          const search = [...keys].sort(
            (a, b) => similarities[b] - similarities[a] || a.localeCompare(b),
          );
          const recommendation = Recommender.venueRecommendations(
            rows,
            lines[i],
            scores,
            Date.UTC(2026, 0, 1),
            {
              fieldedLexical: true,
              semanticSimilarities: similarities,
              venueCats: Recommender.autoDetectCats(lines[i]),
              topN: rows.length,
            },
          ).map((r) => r.venueKey);
          results.push({
            id: cases[i].paper.id,
            language,
            mode: cases[i].mode,
            dtype,
            search,
            recommendation,
            acceptable: cases[i].paper.acceptable_venues.map(canonicalEvaluationKey),
          });
        }
    } finally {
      console.info(`${language}: rankings evaluated`);
      await q8.dispose();
    }
  }
  mkdirSync(join(root, "work"), { recursive: true });
  writeFileSync(
    join(root, "work/full-pool-model-evaluation.json"),
    JSON.stringify({ candidate_count: keys.length, keys, results }, null, 2),
  );
}, 1_800_000);
afterAll(() => {
  env.cacheDir = previousCache;
  Recommender.setNameIdf(null);
  Recommender.setTopicVecs(null);
  if (raw) rmSync(raw, { recursive: true, force: true });
});
for (const language of ["en", "ja"])
  for (const dtype of ["fp32", "q8"])
    for (const method of ["search", "recommendation"] as const)
      it(`all collected venues ${language}/${dtype}/${method}: suitable venue stays in top five`, () => {
        const group = results.filter((r) => r.language === language && r.dtype === dtype);
        expect(group).toHaveLength(language === "en" ? 141 : 123);
        const misses = group
          .filter((r) => !r[method].slice(0, 5).some((k) => r.acceptable.includes(k)))
          .map((r) => ({
            id: r.id,
            mode: r.mode,
            rank: r[method].findIndex((k) => r.acceptable.includes(k)) + 1,
            top: r[method].slice(0, 6),
          }));
        expect(misses).toEqual([]);
      });

it("every collected venue is represented by the actual consumer candidate pool", () => {
  expect(representedVenueKeys).toEqual([...keys].sort());
});
