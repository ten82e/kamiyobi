import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as runtime from "../src/embedding-runtime.ts";
import { prepareLiveConsumerSite } from "./live_consumer_site.ts";

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
let root: string;
const replies: Record<string, any>[] = [];
const errors: Record<string, any>[] = [];
let sameProcess = false;
let prepared: Record<string, any>;
beforeAll(async () => {
  root = prepareLiveConsumerSite(false);
  expect(corpus.candidate_count).toBe(696);
  expect(corpus.top_k).toBe(5);
  const index = JSON.parse(readFileSync(join(root, "public/recommendation-index.json"), "utf8"));
  expect(index.conferences).toHaveLength(696);
  expect(index.conferences.every((c: { papers: unknown[] }) => c.papers.length === 0)).toBe(true);
  const profile = JSON.stringify(index).toLowerCase();
  for (const paper of papers) {
    expect(profile).not.toContain(paper.title.toLowerCase());
    expect(profile).not.toContain(paper.abstract.toLowerCase());
  }
  expect(existsSync(join(root, ".cache/embedding-models"))).toBe(false);
  writeFileSync(
    join(root, "server.ts"),
    'import {env} from "@huggingface/transformers";env.allowRemoteModels=false;env.fetch=async()=>{throw new Error("unexpected remote request")};import {runStdio} from "./src/mcp.ts";runStdio();',
  );
  const child = spawn(process.execPath, [join(root, "server.ts")], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pid = child.pid;
  let stderr = "";
  child.stderr.on("data", (text) => {
    stderr += text;
  });
  const waiting = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    const pending = waiting.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    waiting.delete(response.id);
    pending.resolve(response);
  });
  const closed = new Promise<number | null>((resolve) =>
    child.on("close", (code) => {
      for (const pending of waiting.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`MCP exited ${code}: ${stderr}`));
      }
      waiting.clear();
      resolve(code);
    }),
  );
  let id = 0;
  function request(method: string, params?: unknown): Promise<Record<string, any>> {
    const current = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(current);
        reject(new Error(`MCP response timed out: ${method}; ${stderr}`));
      }, 180000);
      waiting.set(current, { resolve, reject, timer });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: current, method, ...(params ? { params } : {}) })}\n`,
      );
    });
  }
  function call(c: (typeof cases)[number]) {
    return request("tools/call", {
      name: c.tool,
      arguments: {
        [c.tool === "search_venues" ? "query" : "paper"]: c.input,
        retrieval: "semantic",
        limit: 30,
      },
    });
  }
  try {
    const initial = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "recovery-test", version: "1" },
    });
    expect(initial.result.protocolVersion).toBe("2025-06-18");
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    for (const language of ["en", "ja"])
      for (const tool of ["search_venues", "recommend_venues"]) {
        const c = cases.find(
          (c) => c.paper.language === language && c.tool === tool && c.mode === "title+abstract",
        )!;
        errors.push((await call(c)).result);
      }
    expect(
      errors.every(
        (r) => r.isError === true && r.structuredContent?.error?.code === "MODEL_NOT_READY",
      ),
    ).toBe(true);
    expect((await request("ping")).result).toEqual({});
    // Only pinned pretrained weights are reused; no profiles, vectors or generated data are copied.
    for (const [model, revision] of [
      [runtime.EMBEDDING_MODEL, runtime.EMBEDDING_REVISION],
      [runtime.EMBEDDING_MULTI_MODEL, runtime.EMBEDDING_MULTI_REVISION],
    ]) {
      const directory = join(root, ".cache/embedding-models", model, revision);
      mkdirSync(join(directory, "onnx"), { recursive: true });
      for (const file of [
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "onnx/model.onnx",
      ])
        copyFileSync(
          join(repo, ".cache/embedding-models", model, revision, file),
          join(directory, file),
          constants.COPYFILE_FICLONE,
        );
    }
    const preparation = spawnSync(
      process.execPath,
      [join(root, "src/prepare-models.ts"), "--offline"],
      { cwd: root, encoding: "utf8", timeout: 180000 },
    );
    expect(preparation.status, preparation.stderr).toBe(0);
    prepared = JSON.parse(preparation.stdout);
    expect(prepared.ready).toBe(true);
    expect(prepared.models).toHaveLength(2);
    for (const c of cases) replies.push((await call(c)).result);
    expect((await request("ping")).result).toEqual({});
    sameProcess = child.pid === pid && child.exitCode === null && child.signalCode === null;
    child.stdin.end();
    expect(await closed, stderr).toBe(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    lines.close();
  }
  for (const file of [
    "public/embeddings.json",
    "data/snapshot.json",
    "data/venue-profiles.json",
    "data/recommender-reranker.json",
  ])
    expect(existsSync(join(root, file))).toBe(false);
}, 600000);
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
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
