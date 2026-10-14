import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  AutoModel,
  AutoTokenizer,
  env,
  FeatureExtractionPipeline,
} from "@huggingface/transformers";
import { afterAll, beforeAll, expect, it } from "vitest";
import R from "../site/recommendation.ts";
import { consolidateReviewedSubmissions } from "../site/submission-identity.ts";
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
interface Paper {
  id: string;
  language: "en" | "ja";
  title: string;
  abstract: string;
  source: string;
  acceptable_venues: string[];
  modes?: string[];
}
const papers: Paper[] = names.flatMap((name, index) => {
  const raw = readFileSync(join(repo, "tests/fixtures", `${name}.json`), "utf8");
  if (createHash("sha256").update(raw).digest("hex") !== hashes[index])
    throw new Error("evaluation labels or inputs changed");
  const fixture = JSON.parse(raw);
  if (fixture.top_k !== 5 || fixture.candidate_count !== 696)
    throw new Error("evaluation gate changed");
  return fixture.papers;
});
const cases = papers.flatMap((paper) =>
  (paper.modes ?? ["title", "abstract", "title+abstract"]).map((mode) => ({
    paper,
    mode,
    input: {
      ...(mode !== "abstract" ? { title: paper.title } : {}),
      ...(mode !== "title" ? { abstract: paper.abstract } : {}),
    },
  })),
);
let root: string;
const results: Array<{ id: string; mode: string; surface: string; keys: string[] }> = [];
const previousCache = env.cacheDir;
beforeAll(async () => {
  root = prepareLiveConsumerSite();
  const data = JSON.parse(readFileSync(join(root, "public/data.json"), "utf8"));
  const bundle = JSON.parse(readFileSync(join(root, "public/embeddings.json"), "utf8"));
  expect(bundle.manifest.keys).toHaveLength(696);
  const rows = R.candidatePool(
    consolidateReviewedSubmissions(
      R.candidateRows(data),
      (r) => `${r.conf.key}|${r.ed.year ?? ""}|${r.kind}|${Math.trunc(r.t)}`,
    ),
    data.conferences,
    Date.UTC(2026, 9, 14),
  );
  const represented = new Set(
    rows.flatMap((r) => [
      r.conf.key,
      ...(r.submission?.sourceRecords ?? []).map((s) => s.venueKey),
    ]),
  );
  expect(represented.size).toBe(696);
  const profiles = data.conferences
    .map((conf: Record<string, unknown>) =>
      JSON.stringify({
        scope: conf.scope,
        official_scope: conf.official_scope,
        papers: conf.papers,
      }),
    )
    .join(" ")
    .toLowerCase();
  for (const p of papers) {
    expect(profiles).not.toContain(p.title.toLowerCase());
    expect(profiles).not.toContain(p.abstract.toLowerCase());
  }
  const requests = cases.flatMap((c, i) =>
    ["search_venues", "recommend_venues"].map((tool, j) => ({
      jsonrpc: "2.0",
      id: i * 2 + j + 1,
      method: "tools/call",
      params: {
        name: tool,
        arguments: {
          [tool === "search_venues" ? "query" : "paper"]: JSON.stringify(c.input),
          limit: 30,
        },
      },
    })),
  );
  const child = spawnSync(process.execPath, [join(root, "src/mcp.ts")], {
    cwd: root,
    input: `${requests.map((r) => JSON.stringify(r)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 32 * 1024 * 1024,
  });
  expect(child.status, child.stderr).toBe(0);
  const replies = child.stdout
    .split("\n")
    .filter(Boolean)
    .map((s) => JSON.parse(s));
  for (const [index, c] of cases.entries())
    for (const [j, surface] of ["search_venues", "recommend_venues"].entries()) {
      const result = replies.find((r) => r.id === index * 2 + j + 1)?.result;
      expect(result?.isError).not.toBe(true);
      expect(result?.structuredContent?.candidate_venues).toBe(696);
      expect(result?.structuredContent?.uses_embeddings).toBe(false);
      results.push({
        id: c.paper.id,
        mode: c.mode,
        surface,
        keys: result.structuredContent.rows.map((r: { venue_key: string }) => r.venue_key),
      });
    }
  env.cacheDir = join(repo, ".cache/embedding-models");
  R.setReranker(null);
  R.setPaperVecs(null);
  R.setSigWeights(null);
  R.setNameIdf(R.buildNameIdf(data.conferences));
  for (const language of ["en", "ja"] as const) {
    const metadata = bundle.manifest.models[language === "ja" ? "multi" : "en"];
    const modelPath = join(env.cacheDir!, metadata.model, metadata.revision);
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(modelPath, { local_files_only: true }),
      AutoModel.from_pretrained(modelPath, { local_files_only: true, device: "cpu", dtype: "q8" }),
    ]);
    const pipeline = new FeatureExtractionPipeline({
      task: "feature-extraction",
      tokenizer,
      model,
    });
    try {
      const probe = await pipeline(metadata.probe.text, { pooling: "mean", normalize: true });
      expect(R.embeddingProbeMatches(metadata, Array.from(probe.data))).toBe(true);
      const set = language === "ja" ? bundle.multi : bundle;
      R.setTopicVecs(set.topicVecs);
      for (const c of cases.filter((c) => c.paper.language === language)) {
        const lines = R.parsePaperLines(JSON.stringify(c.input));
        const vectors = await Promise.all(
          R.semanticQueryPlan(lines).map(
            async ({ text }) =>
              Array.from(
                (await pipeline(text, { pooling: "mean", normalize: true })).data,
              ) as number[],
          ),
        );
        const vector = R.semanticQueryVector(lines, vectors);
        const similarities = Object.fromEntries(
          bundle.manifest.keys.map((key: string) => [
            key,
            R.semanticSimilarity(key, vector, set.embeddings, null),
          ]),
        );
        const scores = Object.fromEntries(
          bundle.manifest.keys.map((key: string) => [
            key,
            R.semanticScore(key, vector, set.embeddings, null),
          ]),
        );
        results.push({
          id: c.paper.id,
          mode: c.mode,
          surface: "published-model-search",
          keys: [...bundle.manifest.keys].sort(
            (a, b) => similarities[b] - similarities[a] || a.localeCompare(b),
          ),
        });
        results.push({
          id: c.paper.id,
          mode: c.mode,
          surface: "published-model-recommendation",
          keys: R.venueRecommendations(rows, lines, scores, Date.UTC(2026, 9, 14), {
            fieldedLexical: true,
            semanticSimilarities: similarities,
            venueCats: R.autoDetectCats(lines),
            topN: rows.length,
          }).map((r) => r.venueKey),
        });
      }
    } finally {
      await pipeline.dispose();
    }
  }
}, 600000);
afterAll(() => {
  env.cacheDir = previousCache;
  R.setTopicVecs(null);
  R.setNameIdf(null);
  if (root) rmSync(root, { recursive: true, force: true });
});
for (const c of cases)
  for (const surface of [
    "search_venues",
    "recommend_venues",
    "published-model-search",
    "published-model-recommendation",
  ])
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
