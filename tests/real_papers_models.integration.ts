import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env, type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";
import { afterAll, beforeAll, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { profileTexts } from "../src/embedding-profiles.ts";
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  EMBEDDING_MULTI_REVISION,
  EMBEDDING_REVISION,
  embedEach,
  embedSet,
} from "../src/embedding-runtime.ts";

interface Venue {
  key: string;
  title: string;
  full_name: string;
  scope: string;
  scope_source: string;
  categories: string[];
  tags: string[];
}
interface Paper {
  id: string;
  language: "en" | "ja";
  title: string;
  abstract: string;
  abstract_sha256: string;
  primary_venue: string;
  acceptable_venues: string[];
  source: string;
  publication: string;
  abstract_kind?: string;
}
interface Fixture {
  sampling: string;
  profile_policy: string;
  papers: Paper[];
  venues: Venue[];
}
const inputText = readFileSync(
  new URL("./fixtures/real-model-evaluation.json", import.meta.url),
  "utf8",
);
const fixture = JSON.parse(inputText) as Fixture;
const modes = ["title", "abstract", "title+abstract"] as const;
type Mode = (typeof modes)[number];
const queryCases = fixture.papers.flatMap((paper) => modes.map((mode) => ({ paper, mode })));
const categories = {
  ai: "Artificial Intelligence and Machine Learning",
  theory: "Theoretical Computer Science",
  graphics: "Computer Vision and Graphics",
  hci: "Human Computer Interaction",
  db: "Databases and Information Retrieval",
  systems: "Computer Systems and Software",
  networking: "Computer Networks and Communications",
  hpc: "High Performance Computing",
  security: "Computer Security and Privacy",
};
const rows = fixture.venues.map((conf) => ({ conf, cats: conf.categories, kind: "paper" }));
const previousCache = env.cacheDir;
const contracts: Array<{
  language: "en" | "ja";
  profiles: string[];
  unrelatedCosine: number;
  texts: string[];
  queryCount: number;
  profileCosine: number;
  queryCosine: number;
}> = [];
const results: Array<{
  id: string;
  language: "en" | "ja";
  mode: Mode;
  source: string;
  abstract_kind: string;
  primary: string;
  acceptable: string[];
  search: string[];
  recommendation: string[];
  scores: Record<string, number>;
}> = [];

const normalized = (text: string) =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const rank = (keys: string[], wanted: string[]) => {
  const index = keys.findIndex((key) => wanted.includes(key));
  return index < 0 ? Infinity : index + 1;
};

function summarize(group: typeof results, method: "search" | "recommendation") {
  const primaryRanks = group.map((item) => rank(item[method], [item.primary]));
  const acceptableRanks = group.map((item) => rank(item[method], item.acceptable));
  const fraction = (ranks: number[], k: number) =>
    ranks.filter((r) => r <= k).length / ranks.length;
  return {
    count: group.length,
    primary_at_1: fraction(primaryRanks, 1),
    primary_at_5: fraction(primaryRanks, 5),
    primary_mrr: primaryRanks.reduce((sum, r) => sum + 1 / r, 0) / group.length,
    acceptable_at_1: fraction(acceptableRanks, 1),
    acceptable_at_5: fraction(acceptableRanks, 5),
    acceptable_mrr: acceptableRanks.reduce((sum, r) => sum + 1 / r, 0) / group.length,
    misses: group.filter((item) => rank(item[method], item.acceptable) > 5).map((item) => item.id),
  };
}

beforeAll(async () => {
  expect(fixture.papers.filter((p) => p.language === "en")).toHaveLength(14);
  expect(fixture.papers.filter((p) => p.language === "ja")).toHaveLength(8);
  expect(fixture.venues).toHaveLength(27);
  const keys = fixture.venues.map((v) => v.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const paper of fixture.papers) {
    expect(paper.title.trim()).not.toBe("");
    expect(paper.abstract.length).toBeGreaterThan(100);
    expect(createHash("sha256").update(paper.abstract).digest("hex")).toBe(paper.abstract_sha256);
    expect(paper.acceptable_venues).toContain(paper.primary_venue);
    for (const key of paper.acceptable_venues) expect(keys).toContain(key);
  }
  for (const venue of fixture.venues) {
    expect(Object.keys(venue).sort()).toEqual([
      "categories",
      "full_name",
      "key",
      "scope",
      "scope_source",
      "tags",
      "title",
    ]);
    expect(venue.scope_source).toMatch(/^https:\/\//);
  }
  env.cacheDir = join(import.meta.dirname, "..", ".cache", "embedding-models");
  Recommender.setReranker(null);
  Recommender.setPaperVecs(null);
  Recommender.setNameIdf(Recommender.buildNameIdf(rows));
  Recommender.setSigWeights(null);
  Recommender.setExpandEnabled(true);
  for (const language of ["en", "ja"] as const) {
    const profiles = profileTexts(fixture.venues, categories, language === "ja", {});
    const model = language === "en" ? EMBEDDING_MODEL : EMBEDDING_MULTI_MODEL;
    const revision = language === "en" ? EMBEDDING_REVISION : EMBEDDING_MULTI_REVISION;
    const embeddings = await embedSet(model, profiles.texts, profiles.keys, revision);
    for (const vector of Object.values(embeddings)) {
      expect(vector).toHaveLength(EMBEDDING_DIM);
      expect(vector.every(Number.isFinite)).toBe(true);
      expect(Math.hypot(...vector)).toBeCloseTo(1, 4);
    }
    const group = queryCases.filter((item) => item.paper.language === language);
    const lines = group.map(({ paper, mode }) =>
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
    const texts = lines.map((line) => Recommender.queryText(line));
    const vectors = await embedEach(model, texts, revision);
    expect(vectors).toHaveLength(group.length);
    // Check routing independently of the shared generator's extractor cache.
    const direct = (await pipeline("feature-extraction", model, {
      revision,
      device: "cpu",
      dtype: "fp32",
    })) as FeatureExtractionPipeline;
    try {
      const output = await direct([profiles.texts[0], texts[0]], {
        pooling: "mean",
        normalize: true,
      });
      const expected = output.tolist() as number[][];
      contracts.push({
        language,
        profiles: profiles.texts,
        unrelatedCosine: Recommender.cosine(embeddings.sc, embeddings.css),
        texts,
        queryCount: group.length,
        profileCosine: Recommender.cosine(embeddings[profiles.keys[0]], expected[0]),
        queryCosine: Recommender.cosine(vectors[0], expected[1]),
      });
    } finally {
      await direct.dispose();
    }
    for (const [i, { paper, mode }] of group.entries()) {
      const scores = Object.fromEntries(
        keys.map((key) => [key, Recommender.semanticScore(key, vectors[i], embeddings, null)]),
      );
      const search = keys.slice().sort((a, b) => scores[b] - scores[a] || a.localeCompare(b));
      const recommendation = Recommender.venueRecommendations(
        rows,
        lines[i],
        scores,
        Date.UTC(2026, 0, 1),
        {
          fieldedLexical: true,
          venueCats: Recommender.autoDetectCats(lines[i]),
          topN: rows.length,
        },
      ).map((result) => result.venueKey);
      expect(new Set(recommendation).size).toBe(recommendation.length);
      for (const key of recommendation) expect(keys).toContain(key);
      results.push({
        id: paper.id,
        language,
        mode,
        source: paper.source,
        abstract_kind: paper.abstract_kind ?? "author abstract",
        primary: paper.primary_venue,
        acceptable: paper.acceptable_venues,
        search,
        recommendation,
        scores,
      });
    }
  }
  const metrics = Object.fromEntries(
    ["en", "ja"].flatMap((language) =>
      modes.map((mode) => {
        const group = results.filter((item) => item.language === language && item.mode === mode);
        return [
          `${language}/${mode}`,
          {
            search: summarize(group, "search"),
            recommendation: summarize(group, "recommendation"),
          },
        ];
      }),
    ),
  );
  const reportPath =
    process.env.KAMIYOBI_REAL_MODEL_REPORT ??
    join(import.meta.dirname, "..", "work", "real-model-evaluation.json");
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        input_sha256: createHash("sha256").update(inputText).digest("hex"),
        sampling: fixture.sampling,
        profile_policy: fixture.profile_policy,
        ranker:
          "Production fielded lexical/semantic fusion without a trained reranker or paper prototypes",
        models: {
          en: { model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION },
          ja: { model: EMBEDDING_MULTI_MODEL, revision: EMBEDDING_MULTI_REVISION },
        },
        metrics,
        results,
      },
      null,
      2,
    ),
  );
});

afterAll(() => {
  env.cacheDir = previousCache;
  Recommender.setPaperVecs(null);
  Recommender.setNameIdf(null);
  Recommender.setSigWeights(null);
  Recommender.setReranker(null);
});

it("real paper evaluation separates profiles, preserves inputs and uses the specified models", () => {
  expect(contracts).toHaveLength(2);
  for (const contract of contracts) {
    expect(contract.unrelatedCosine, `${contract.language}: unrelated venue profiles`).toBeLessThan(
      0.95,
    );
    expect(contract.profileCosine, `${contract.language}: profile model routing`).toBeGreaterThan(
      0.99999,
    );
    expect(contract.queryCosine, `${contract.language}: query model routing`).toBeGreaterThan(
      0.99999,
    );
    expect(new Set(contract.texts).size).toBe(contract.queryCount);
    for (const text of contract.texts) expect(text.trim()).not.toBe("");
    for (const profile of contract.profiles) {
      for (const paper of fixture.papers) {
        expect(normalized(profile), `profile/query title leak: ${paper.id}`).not.toContain(
          normalized(paper.title),
        );
        expect(normalized(profile), `profile/query abstract leak: ${paper.id}`).not.toContain(
          normalized(paper.abstract),
        );
      }
    }
  }
});

for (const language of ["en", "ja"] as const) {
  for (const mode of modes) {
    it(`real papers ${language}/${mode}: retrieves and recommends independently suitable venues`, () => {
      const group = results.filter((item) => item.language === language && item.mode === mode);
      expect(group).toHaveLength(language === "en" ? 14 : 8);
      for (const method of ["search", "recommendation"] as const) {
        const summary = summarize(group, method);
        expect(
          summary.acceptable_at_5,
          JSON.stringify({ method, ...summary }),
        ).toBeGreaterThanOrEqual(0.75);
        expect(
          summary.acceptable_mrr,
          JSON.stringify({ method, ...summary }),
        ).toBeGreaterThanOrEqual(0.35);
      }
    });
  }
}
