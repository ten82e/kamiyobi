import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { prepareLiveConsumerSite } from "./live_consumer_site.ts";

const repo = join(import.meta.dirname, "..");
const raw = readFileSync(join(repo, "tests/fixtures/mcp-semantic-papers.json"), "utf8");
if (
  createHash("sha256").update(raw).digest("hex") !==
  "2ac20fecb74d7b80d0643355503c617f64dab93d4021ea4ba8102e5dc719a9db"
)
  throw new Error("evaluation inputs or labels changed");
const holdoutRaw = readFileSync(join(repo, "tests/fixtures/mcp-semantic-holdout.json"), "utf8");
if (
  createHash("sha256").update(holdoutRaw).digest("hex") !==
  "3bc97ace5b509dfa502fece489373bbf3527b01ca298323c6adf2ddba9d7ca3c"
)
  throw new Error("holdout inputs or labels changed");
const initial = JSON.parse(raw);
const holdout = JSON.parse(holdoutRaw);
const domainsRaw = readFileSync(join(repo, "tests/fixtures/mcp-semantic-domains.json"), "utf8");
if (
  createHash("sha256").update(domainsRaw).digest("hex") !==
  "3d736ce110df290a7e1b272f8769bcb2215d38426ea2ca4fa4ca218549f2ea37"
)
  throw new Error("domain evaluation inputs or labels changed");
const domains = JSON.parse(domainsRaw);
const priorMcpSources = new Set([...initial.papers, ...holdout.papers].map((p) => p.source));
for (const p of domains.papers)
  if (priorMcpSources.has(p.source)) throw new Error("domain paper was already evaluated");
const confirmationRaw = readFileSync(
  join(repo, "tests/fixtures/mcp-semantic-domains-confirmation.json"),
  "utf8",
);
if (
  createHash("sha256").update(confirmationRaw).digest("hex") !==
  "284175fe174435e7860094022e7aae897dcd1d78205a6bf6119039732e1f750f"
)
  throw new Error("domain confirmation inputs or labels changed");
const confirmation = JSON.parse(confirmationRaw);
const developmentSources = new Set([
  ...priorMcpSources,
  ...domains.papers.map((p: { source: string }) => p.source),
]);
for (const p of confirmation.papers)
  if (developmentSources.has(p.source))
    throw new Error("domain confirmation source was already evaluated");
const finalRaw = readFileSync(join(repo, "tests/fixtures/mcp-semantic-domains-final.json"), "utf8");
if (
  createHash("sha256").update(finalRaw).digest("hex") !==
  "4398417641b8d2e34421e48d147cde1e5806bc6fdd21b74b7c02a88967741fca"
)
  throw new Error("final confirmation inputs or labels changed");
const finalConfirmation = JSON.parse(finalRaw);
const evaluatedSources = new Set([
  ...developmentSources,
  ...confirmation.papers.map((p: { source: string }) => p.source),
]);
for (const p of finalConfirmation.papers)
  if (evaluatedSources.has(p.source))
    throw new Error("final confirmation source was already evaluated");
for (const corpus of [initial, holdout, domains, confirmation, finalConfirmation])
  if (corpus.candidate_count !== 696 || corpus.top_k !== 5)
    throw new Error("evaluation gate changed");
const initialSources = new Set(initial.papers.map((p: { source: string }) => p.source));
for (const p of holdout.papers)
  if (initialSources.has(p.source)) throw new Error("holdout source leaked from development");
const corpus = {
  papers: [
    ...initial.papers,
    ...holdout.papers,
    ...domains.papers,
    ...confirmation.papers,
    ...finalConfirmation.papers,
  ],
};
interface Paper {
  id: string;
  language: string;
  title: string;
  abstract: string;
  source: string;
  acceptable_venues: string[];
}
const papers: Paper[] = corpus.papers;
const cases = papers.flatMap((paper) =>
  ["title", "abstract", "title+abstract"].flatMap((mode) =>
    ["search_venues", "recommend_venues"].map((tool) => ({
      paper,
      mode,
      tool,
      input: {
        ...(mode !== "abstract" ? { title: paper.title } : {}),
        ...(mode !== "title" ? { abstract: paper.abstract } : {}),
      },
    })),
  ),
);
let root: string;
let replies: Array<{ id: number; result: Record<string, any> }>;
const request = (id: number, tool: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: tool, arguments: args },
});
function invoke(requests: unknown[]) {
  const child = spawnSync(process.execPath, [join(root, "src/mcp.ts")], {
    cwd: root,
    input: `${requests.map((x) => JSON.stringify(x)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 600000,
    maxBuffer: 32 * 1024 * 1024,
  });
  expect(child.status, child.stderr).toBe(0);
  return child.stdout
    .split("\n")
    .filter(Boolean)
    .map((s) => JSON.parse(s));
}
beforeAll(async () => {
  const previous = new Set(
    readdirSync(join(repo, "tests/fixtures"))
      .filter((n) =>
        /^(real-model-|full-pool-(confirmation|holdout)|live-consumer-).*\.json$/.test(n),
      )
      .flatMap((n) =>
        (JSON.parse(readFileSync(join(repo, "tests/fixtures", n), "utf8")).papers ?? []).map(
          (p: Paper) => p.source,
        ),
      ),
  );
  for (const p of papers) expect(previous.has(p.source), p.source).toBe(false);
  // Prepare pinned pretrained weights, without reusing any profile or evaluation vectors.
  const { env } = await import("@huggingface/transformers");
  const runtime = await import("../src/embedding-runtime.ts");
  const previousCache = env.cacheDir;
  try {
    env.cacheDir = join(repo, ".cache/embedding-models");
    await runtime.embedEach(
      runtime.EMBEDDING_MODEL,
      [runtime.EMBEDDING_PROBE],
      runtime.EMBEDDING_REVISION,
    );
    await runtime.embedEach(
      runtime.EMBEDDING_MULTI_MODEL,
      [runtime.EMBEDDING_PROBE],
      runtime.EMBEDDING_MULTI_REVISION,
    );
  } finally {
    env.cacheDir = previousCache;
  }
  root = prepareLiveConsumerSite(false);
  const index = JSON.parse(readFileSync(join(root, "public/recommendation-index.json"), "utf8"));
  expect(index.conferences).toHaveLength(696);
  expect(index.conferences.every((c: { papers: unknown[] }) => !c.papers.length)).toBe(true);
  const profiles = JSON.stringify(index.conferences).toLowerCase();
  for (const p of papers) {
    expect(profiles).not.toContain(p.title.toLowerCase());
    expect(profiles).not.toContain(p.abstract.toLowerCase());
  }
  for (const name of [
    "public/embeddings.json",
    "data/snapshot.json",
    "data/venue-profiles.json",
    "data/recommender-reranker.json",
  ])
    expect(existsSync(join(root, name))).toBe(false);
  // A requested semantic search must fail visibly when real weights are unavailable.
  const missing = invoke([
    request(1, "search_venues", { query: papers[0].title, retrieval: "semantic" }),
  ])[0];
  expect(missing.result.isError).toBe(true);
  expect(missing.result.structuredContent).toBeUndefined();
  mkdirSync(join(root, ".cache"), { recursive: true });
  symlinkSync(join(repo, ".cache/embedding-models"), join(root, ".cache/embedding-models"));
  replies = invoke(
    cases.map((c, i) =>
      request(i + 1, c.tool, {
        [c.tool === "search_venues" ? "query" : "paper"]: JSON.stringify(c.input),
        retrieval: "semantic",
        limit: 30,
      }),
    ),
  );
  expect(replies).toHaveLength(cases.length);
}, 600000);
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
for (const [i, c] of cases.entries())
  it(`MCP actual model ${c.paper.id}/${c.mode}/${c.tool} retains suitable venues in the fixed top five`, () => {
    const reply = replies.find((r) => r.id === i + 1)?.result;
    expect(reply?.isError).not.toBe(true);
    const result = reply?.structuredContent;
    expect(result?.candidate_venues).toBe(696);
    expect(result?.uses_embeddings).toBe(true);
    const keys = result.rows.slice(0, 5).map((r: { venue_key: string }) => r.venue_key);
    expect(
      keys.some((key: string) => c.paper.acceptable_venues.includes(key)),
      JSON.stringify(keys),
    ).toBe(true);
    expect(result?.embedding_model).toEqual(
      c.paper.language === "ja"
        ? {
            id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
            revision: "2c4055b12046f11709e9df2c122e59ffbdc2f900",
          }
        : { id: "Xenova/all-MiniLM-L6-v2", revision: "751bff37182d3f1213fa05d7196b954e230abad9" },
    );
  });
