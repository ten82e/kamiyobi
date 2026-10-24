import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import * as runtime from "../src/embedding-runtime.ts";
import { runModelRecovery } from "./mcp_recovery_case.ts";

const repo = join(import.meta.dirname, "..");
const raw = readFileSync(
  join(repo, "tests/fixtures/mcp-semantic-domains-confirmation.json"),
  "utf8",
);
if (
  createHash("sha256").update(raw).digest("hex") !==
  "284175fe174435e7860094022e7aae897dcd1d78205a6bf6119039732e1f750f"
)
  throw new Error("recovery evaluation inputs or labels changed");
interface Paper {
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
let replies: Record<string, any>[];
let errors: Record<string, any>[];
let sameProcess: boolean;
let prepared: Record<string, any>;
beforeAll(async () => {
  ({ replies, errors, sameProcess, prepared } = await runModelRecovery(corpus));
}, 1200000);
it("keeps one initialized MCP process and connection across four missing-model errors and preparation", () => {
  expect(errors).toHaveLength(4);
  expect(sameProcess).toBe(true);
  expect(prepared.ready).toBe(true);
  expect(replies).toHaveLength(48);
});
for (const [i, c] of cases.entries())
  it(`same-session recovery ${c.paper.id}/${c.mode}/${c.tool} retains a fixed suitable venue in top five`, () => {
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
