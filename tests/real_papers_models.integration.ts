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
const independentText = readFileSync(
  new URL("./fixtures/real-model-independent.json", import.meta.url),
  "utf8",
);
const independent = JSON.parse(independentText) as Pick<
  Fixture,
  "sampling" | "profile_policy" | "papers"
>;
const holdoutText = readFileSync(
  new URL("./fixtures/real-model-holdout-2025.json", import.meta.url),
  "utf8",
);
const holdout = JSON.parse(holdoutText) as Pick<Fixture, "sampling" | "profile_policy" | "papers">;
const confirmationText = readFileSync(
  new URL("./fixtures/real-model-confirmation-2025.json", import.meta.url),
  "utf8",
);
const confirmation = JSON.parse(confirmationText) as Pick<
  Fixture,
  "sampling" | "profile_policy" | "papers"
>;
const papers = [
  ...fixture.papers.map((paper) => ({ ...paper, corpus: "initial" as const })),
  ...independent.papers.map((paper) => ({ ...paper, corpus: "independent" as const })),
  ...holdout.papers.map((paper) => ({ ...paper, corpus: "holdout" as const })),
  ...confirmation.papers.map((paper) => ({ ...paper, corpus: "confirmation" as const })),
];
const modes = ["title", "abstract", "title+abstract"] as const;
type Mode = (typeof modes)[number];
const queryCases = papers.flatMap((paper) => modes.map((mode) => ({ paper, mode })));
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
  encodedModel: string;
  encodedQueryCosine: number;
  inputs: Array<{
    actual: ReturnType<typeof Recommender.parsePaperLines>;
    title: string;
    abstract: string;
  }>;
}> = [];
const results: Array<{
  id: string;
  corpus: "initial" | "independent" | "holdout" | "confirmation";
  language: "en" | "ja";
  mode: Mode;
  source: string;
  abstract_kind: string;
  primary: string;
  acceptable: string[];
  search: string[];
  recommendation: string[];
  scores: Record<string, number>;
  similarities: Record<string, number>;
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
  expect(createHash("sha256").update(inputText).digest("hex")).toBe(
    "367f8940d5f2083d929af2ad45c64daf82cd976a3bcb3f8968e896f2e037b033",
  );
  expect(createHash("sha256").update(independentText).digest("hex")).toBe(
    "23e7d903707c9877f035f73ace261692593a324dcb73ecc52db668df59db5ecb",
  );
  expect(independent.papers.filter((p) => p.language === "en")).toHaveLength(12);
  expect(independent.papers.filter((p) => p.language === "ja")).toHaveLength(12);
  expect(createHash("sha256").update(holdoutText).digest("hex")).toBe(
    "0beca9bca180764d51ab42331e515698a4e469516def613ffc869426b5ca6c2d",
  );
  const priorSources = new Set([...fixture.papers, ...independent.papers].map((p) => p.source));
  expect(holdout.papers.filter((p) => p.language === "en")).toHaveLength(6);
  expect(holdout.papers.filter((p) => p.language === "ja")).toHaveLength(6);
  for (const paper of holdout.papers) expect(priorSources.has(paper.source)).toBe(false);
  expect(createHash("sha256").update(confirmationText).digest("hex")).toBe(
    "406736515612efbdc519b4d15e914cf34e1c8be7590bb01df6b2cf8dde5b775d",
  );
  const developmentSources = new Set(
    [...fixture.papers, ...independent.papers, ...holdout.papers].map((p) => p.source),
  );
  expect(confirmation.papers.filter((p) => p.language === "en")).toHaveLength(6);
  expect(confirmation.papers.filter((p) => p.language === "ja")).toHaveLength(6);
  for (const paper of confirmation.papers) expect(developmentSources.has(paper.source)).toBe(false);
  expect(new Set(papers.map((p) => p.id)).size).toBe(papers.length);
  const initialSources = new Set(fixture.papers.map((p) => p.source));
  for (const paper of independent.papers) expect(initialSources.has(paper.source)).toBe(false);
  expect(fixture.papers.filter((p) => p.language === "en")).toHaveLength(14);
  expect(fixture.papers.filter((p) => p.language === "ja")).toHaveLength(8);
  expect(fixture.venues).toHaveLength(27);
  const keys = fixture.venues.map((v) => v.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const paper of papers) {
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
      const escaped = JSON.stringify(lines[0])
        .split("")
        .map((character) =>
          character.charCodeAt(0) > 127
            ? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
            : character,
        )
        .join("");
      const decoded = Recommender.parsePaperLines(escaped);
      expect(decoded).toEqual(lines[0]);
      const encodedJapanese = Recommender.queryHasJapanese(decoded);
      const encodedModel = encodedJapanese ? EMBEDDING_MULTI_MODEL : EMBEDDING_MODEL;
      const encodedRevision = encodedJapanese ? EMBEDDING_MULTI_REVISION : EMBEDDING_REVISION;
      const encodedVectors = await embedEach(
        encodedModel,
        [Recommender.queryText(decoded)],
        encodedRevision,
      );
      contracts.push({
        encodedModel,
        encodedQueryCosine: Recommender.cosine(vectors[0], encodedVectors[0]),
        language,
        profiles: profiles.texts,
        unrelatedCosine: Recommender.cosine(embeddings.sc, embeddings.css),
        texts,
        queryCount: group.length,
        profileCosine: Recommender.cosine(embeddings[profiles.keys[0]], expected[0]),
        queryCosine: Recommender.cosine(vectors[0], expected[1]),
        inputs: group.map(({ paper, mode }, index) => ({
          actual: lines[index],
          title: mode === "abstract" ? "" : paper.title,
          abstract: mode === "title" ? "" : paper.abstract,
        })),
      });
    } finally {
      await direct.dispose();
    }
    for (const [i, { paper, mode }] of group.entries()) {
      const scores = Object.fromEntries(
        keys.map((key) => [key, Recommender.semanticScore(key, vectors[i], embeddings, null)]),
      );
      const similarities = Object.fromEntries(
        keys.map((key) => [key, Recommender.semanticSimilarity(key, vectors[i], embeddings, null)]),
      );
      const search = keys
        .filter((key) => similarities[key] > 0)
        .sort((a, b) => similarities[b] - similarities[a] || a.localeCompare(b));
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
      ).map((result) => result.venueKey);
      expect(new Set(recommendation).size).toBe(recommendation.length);
      for (const key of recommendation) expect(keys).toContain(key);
      results.push({
        id: paper.id,
        corpus: paper.corpus,
        language,
        mode,
        source: paper.source,
        abstract_kind: paper.abstract_kind ?? "author abstract",
        primary: paper.primary_venue,
        acceptable: paper.acceptable_venues,
        search,
        recommendation,
        scores,
        similarities,
      });
    }
  }
  const metrics = Object.fromEntries(
    ["initial", "independent", "holdout", "confirmation"].flatMap((corpus) =>
      ["en", "ja"].flatMap((language) =>
        modes.map((mode) => {
          const group = results.filter(
            (item) => item.corpus === corpus && item.language === language && item.mode === mode,
          );
          return [
            `${corpus}/${language}/${mode}`,
            {
              search: summarize(group, "search"),
              recommendation: summarize(group, "recommendation"),
            },
          ];
        }),
      ),
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
        sampling: {
          initial: fixture.sampling,
          independent: independent.sampling,
          holdout: holdout.sampling,
          confirmation: confirmation.sampling,
        },
        confirmation_sha256: createHash("sha256").update(confirmationText).digest("hex"),
        holdout_sha256: createHash("sha256").update(holdoutText).digest("hex"),
        independent_sha256: createHash("sha256").update(independentText).digest("hex"),
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
    for (const input of contract.inputs) {
      expect(input.actual).toEqual([
        {
          title: input.title,
          abstract: input.abstract,
          keywords: "",
          venue: "",
        },
      ]);
    }
    for (const text of contract.texts) expect(text.trim()).not.toBe("");
    for (const profile of contract.profiles) {
      for (const paper of papers) {
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
      const group = results.filter(
        (item) => item.corpus === "initial" && item.language === language && item.mode === mode,
      );
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

it("every initial recommendation, including the former English and Japanese misses, stays in the top five", () => {
  const initial = results.filter((item) => item.corpus === "initial");
  expect(initial).toHaveLength(66);
  for (const item of initial) {
    expect(
      rank(item.recommendation, item.acceptable),
      `${item.id}/${item.mode}: ${item.recommendation.join(", ")}`,
    ).toBeLessThanOrEqual(5);
  }
});

for (const language of ["en", "ja"] as const) {
  for (const mode of modes) {
    it(`independent papers ${language}/${mode}: maintains the original quality floors`, () => {
      const group = results.filter(
        (item) => item.corpus === "independent" && item.language === language && item.mode === mode,
      );
      expect(group).toHaveLength(12);
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

it("improves recommendation ranking on disjoint real papers in both languages", () => {
  // Measured before the implementation change, with the same papers, labels and profiles.
  const baseline = {
    en: { title: 2 / 3, abstract: 19 / 24, "title+abstract": 19 / 24 },
    ja: {
      title: 0.4479166666666666,
      abstract: 0.29328703703703707,
      "title+abstract": 0.3043981481481482,
    },
  };
  for (const language of ["en", "ja"] as const)
    for (const mode of modes) {
      const group = results.filter(
        (item) => item.corpus === "independent" && item.language === language && item.mode === mode,
      );
      const summary = summarize(group, "recommendation");
      expect(
        summary.acceptable_mrr,
        `${language}/${mode}: ${JSON.stringify(summary)}`,
      ).toBeGreaterThan(baseline[language][mode]);
      expect(summary.acceptable_at_5).toBeGreaterThanOrEqual(language === "en" ? 11 / 12 : 10 / 12);
    }
});

for (const language of ["en", "ja"] as const)
  for (const mode of modes) {
    it(`2025 holdout ${language}/${mode}: keeps the original quality floors`, () => {
      const group = results.filter(
        (r) => r.corpus === "holdout" && r.language === language && r.mode === mode,
      );
      expect(group).toHaveLength(6);
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

it("all independent Japanese recommendations retain a suitable venue in the top five", () => {
  const group = results.filter((r) => r.corpus === "independent" && r.language === "ja");
  expect(group).toHaveLength(36);
  for (const item of group)
    expect(
      rank(item.recommendation, item.acceptable),
      `${item.id}/${item.mode}: ${item.recommendation.join(", ")}`,
    ).toBeLessThanOrEqual(5);
});

it("improves Japanese recommendations on the separately selected 2025 papers", () => {
  const baseline = {
    title: 0.398005698005698,
    abstract: 0.7277777777777779,
    "title+abstract": 0.7182539682539684,
  };
  for (const mode of modes) {
    const group = results.filter(
      (r) => r.corpus === "holdout" && r.language === "ja" && r.mode === mode,
    );
    expect(group).toHaveLength(6);
    expect(summarize(group, "recommendation").acceptable_mrr, mode).toBeGreaterThan(baseline[mode]);
  }
});

for (const language of ["en", "ja"] as const)
  for (const mode of modes) {
    it(`2025 confirmation ${language}/${mode}: keeps the original quality floors`, () => {
      const group = results.filter(
        (r) => r.corpus === "confirmation" && r.language === language && r.mode === mode,
      );
      expect(group).toHaveLength(6);
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

it("every separately selected 2025 recommendation has a suitable venue in the top five", () => {
  const group = results.filter((r) => r.corpus === "holdout");
  expect(group).toHaveLength(36);
  for (const item of group)
    expect(
      rank(item.recommendation, item.acceptable),
      `${item.id}/${item.mode}: ${item.recommendation.join(", ")}`,
    ).toBeLessThanOrEqual(5);
});

it("preserves the recovered native-Japanese title-and-abstract ranking", () => {
  const group = results.filter(
    (r) => r.corpus === "initial" && r.language === "ja" && r.mode === "title+abstract",
  );
  expect(group).toHaveLength(8);
  expect(summarize(group, "recommendation").acceptable_mrr).toBeGreaterThanOrEqual(15 / 16);
});

it("improves title recommendations on the additional confirmation papers in both languages", () => {
  const baseline = { en: 11 / 12, ja: 0.736111111111111 };
  for (const language of ["en", "ja"] as const) {
    const group = results.filter(
      (r) => r.corpus === "confirmation" && r.language === language && r.mode === "title",
    );
    expect(group).toHaveLength(6);
    expect(summarize(group, "recommendation").acceptable_mrr, language).toBeGreaterThan(
      baseline[language],
    );
  }
});

it("keeps every confirmation recommendation within the top five", () => {
  const group = results.filter((r) => r.corpus === "confirmation");
  expect(group).toHaveLength(36);
  for (const item of group)
    expect(
      rank(item.recommendation, item.acceptable),
      `${item.id}/${item.mode}: ${item.recommendation.join(", ")}`,
    ).toBeLessThanOrEqual(5);
});

it("routes escaped paper content through the correct actual model", () => {
  expect(contracts).toHaveLength(2);
  for (const contract of contracts) {
    expect(contract.encodedModel).toBe(
      contract.language === "ja" ? EMBEDDING_MULTI_MODEL : EMBEDDING_MODEL,
    );
    expect(contract.encodedQueryCosine).toBeGreaterThan(0.99999);
  }
});

it("keeps suitable venues in the top five of raw semantic retrieval for every paper input", () => {
  expect(results).toHaveLength(210);
  for (const item of results)
    expect(
      rank(item.search, item.acceptable),
      `${item.id}/${item.mode}: ${item.search.join(", ")}`,
    ).toBeLessThanOrEqual(5);
});
