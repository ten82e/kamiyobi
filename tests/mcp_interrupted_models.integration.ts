import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import * as runtime from "../src/embedding-runtime.ts";
import { runModelRecovery } from "./mcp_recovery_case.ts";

const repo = join(import.meta.dirname, "..");
const raw = readFileSync(join(repo, "tests/fixtures/mcp-interrupted-papers.json"), "utf8");
if (
  createHash("sha256").update(raw).digest("hex") !==
  "448424e54ea6fbe0b7c75032f35dbe957f3e7f848cfddea16aec044b9ca70a98"
)
  throw new Error("recovery evaluation inputs or labels changed");
interface Paper {
  source: string;
  id: string;
  language: string;
  title: string;
  abstract: string;
  acceptable_venues: string[];
}
const corpus = JSON.parse(raw);
const papers: Paper[] = corpus.papers;
const cases = papers.flatMap((paper) =>
  ["title", "abstract", "title+abstract"].flatMap((mode) =>
    ["search_venues", "recommend_venues"].map((tool) => ({
      paper,
      mode,
      tool,
      input: JSON.stringify({
        ...(mode !== "abstract" ? { title: paper.title } : {}),
        ...(mode !== "title" ? { abstract: paper.abstract } : {}),
      }),
    })),
  ),
);
for (const name of readdirSync(join(repo, "tests/fixtures"))) {
  if (!name.endsWith(".json") || name === "mcp-interrupted-papers.json") continue;
  const previous = readFileSync(join(repo, "tests/fixtures", name), "utf8");
  for (const paper of papers) {
    if (previous.includes(paper.source) || previous.includes(paper.title))
      throw new Error(`paper already evaluated in ${name}: ${paper.id}`);
  }
}
let recoveryFailure: unknown;
let interruption: { received: number; total: number; url: string } | undefined;
let replies: Record<string, any>[];
let errors: Record<string, any>[];
let sameProcess: boolean;
let prepared: Record<string, any>;
beforeAll(async () => {
  try {
    ({ replies, errors, sameProcess, prepared, interruption } = await runModelRecovery(
      corpus,
      true,
    ));
  } catch (error) {
    recoveryFailure = error;
    replies = [];
    errors = [];
    sameProcess = false;
    prepared = {};
  }
}, 1200000);
it("interrupted recovery keeps one initialized MCP process and connection across interrupted acquisition, eight missing-model errors and retry", () => {
  expect(recoveryFailure, String(recoveryFailure)).toBeUndefined();
  expect(errors).toHaveLength(8);
  expect(interruption?.received).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  expect(interruption!.received).toBeLessThan(interruption!.total);
  expect(sameProcess).toBe(true);
  expect(prepared.ready).toBe(true);
  expect(replies).toHaveLength(24);
});
for (const [i, c] of cases.entries())
  it(`interrupted recovery ${c.paper.id}/${c.mode}/${c.tool} retains a fixed suitable venue in top five`, () => {
    const reply = replies[i];
    expect(reply?.isError).not.toBe(true);
    const result = reply?.structuredContent;
    expect(result?.candidate_venues).toBe(696);
    expect(result?.uses_embeddings).toBe(true);
    expect(result?.embedding_model).toEqual(
      c.paper.language === "ja"
        ? { id: runtime.EMBEDDING_MULTI_MODEL, revision: runtime.EMBEDDING_MULTI_REVISION }
        : { id: runtime.EMBEDDING_MODEL, revision: runtime.EMBEDDING_REVISION },
    );
    const keys = result?.rows?.slice(0, 5).map((row: { venue_key: string }) => row.venue_key) ?? [];
    expect(
      keys.some((key: string) => c.paper.acceptable_venues.includes(key)),
      JSON.stringify(keys),
    ).toBe(true);
  });
