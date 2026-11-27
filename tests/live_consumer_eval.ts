import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AutoModel,
  AutoTokenizer,
  env,
  FeatureExtractionPipeline,
} from "@huggingface/transformers";
import { expect } from "vitest";
import R from "../site/recommendation.ts";
import { consolidateReviewedSubmissions } from "../site/submission-identity.ts";

export interface LiveConsumerPaper {
  id: string;
  language: "en" | "ja";
  title: string;
  abstract?: string;
  source: string;
  acceptable_venues: string[];
  modes?: string[];
}
export interface LiveConsumerCase {
  paper: LiveConsumerPaper;
  mode: string;
  input: { title?: string; abstract?: string };
}
export interface LiveConsumerResult {
  id: string;
  mode: string;
  surface: string;
  keys: string[];
}
export const LIVE_CONSUMER_SURFACES = [
  "search_venues",
  "recommend_venues",
  "published-model-search",
  "published-model-recommendation",
] as const;

export function liveConsumerCases(papers: LiveConsumerPaper[]): LiveConsumerCase[] {
  return papers.flatMap((paper) =>
    (paper.modes ?? ["title", "abstract", "title+abstract"]).map((mode) => ({
      paper,
      mode,
      input: {
        ...(mode !== "abstract" ? { title: paper.title } : {}),
        ...(mode !== "title" ? { abstract: paper.abstract } : {}),
      },
    })),
  );
}

/** Rank every case through the MCP tools and the published embeddings of a prepared site. */
export async function evaluateLiveConsumers(
  repo: string,
  root: string,
  cases: LiveConsumerCase[],
): Promise<LiveConsumerResult[]> {
  const results: LiveConsumerResult[] = [];
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
  for (const c of cases) {
    expect(profiles).not.toContain(c.paper.title.toLowerCase());
    if (c.paper.abstract) expect(profiles).not.toContain(c.paper.abstract.toLowerCase());
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
  return results;
}

/** 1-based rank of the first acceptable venue, or null when none is listed. */
export function firstAcceptableRank(keys: string[], acceptable: string[]): number | null {
  const index = keys.findIndex((key) => acceptable.includes(key));
  return index < 0 ? null : index + 1;
}
