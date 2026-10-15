import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect } from "vitest";
import * as runtime from "../src/embedding-runtime.ts";
import { prepareLiveConsumerSite } from "./live_consumer_site.ts";

export interface RecoveryPaper {
  id: string;
  language: string;
  title: string;
  abstract: string;
  acceptable_venues: string[];
}
export interface RecoveryCorpus {
  candidate_count: number;
  top_k: number;
  papers: RecoveryPaper[];
}
export function recoveryCases(papers: RecoveryPaper[]) {
  return papers.flatMap((paper) =>
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
}
export async function runModelRecovery(corpus: RecoveryCorpus, interruptDownload = false) {
  const papers = corpus.papers;
  const cases = recoveryCases(papers);
  const replies: Record<string, any>[] = [];
  const errors: Record<string, any>[] = [];
  let sameProcess = false;
  let prepared: Record<string, any>;
  let interruption: { received: number; total: number; url: string } | undefined;

  const root = prepareLiveConsumerSite(false);
  try {
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
      const cache = join(root, ".cache/embedding-models");
      const cachedFiles = existsSync(cache)
        ? readdirSync(cache, { recursive: true }).filter((file) =>
            statSync(join(cache, String(file))).isFile(),
          )
        : [];
      expect(cachedFiles, "model preparation must start with no cached files").toEqual([]);
      if (interruptDownload) {
        const preload = join(root, "interrupt.mjs");
        const log = join(root, "interrupted.json");
        cpSync(join(import.meta.dirname, "interrupted_model_download.mjs"), preload);
        const failed = spawnSync(process.execPath, [join(root, "src/prepare-models.ts")], {
          cwd: root,
          encoding: "utf8",
          timeout: 180000,
          env: {
            ...process.env,
            NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`,
            KAMIYOBI_INTERRUPTION_LOG: log,
          },
        });
        expect(failed.status, failed.stderr).toBe(1);
        expect(failed.stdout).not.toContain('"ready":true');
        interruption = JSON.parse(readFileSync(log, "utf8"));
        expect(interruption!.received).toBeGreaterThanOrEqual(4 * 1024 * 1024);
        expect(interruption!.received).toBeLessThan(interruption!.total);
        const directory = join(cache, runtime.EMBEDDING_MODEL, runtime.EMBEDDING_REVISION);
        for (const file of ["config.json", "tokenizer.json", "tokenizer_config.json"])
          expect(statSync(join(directory, file)).size).toBeGreaterThan(0);
        expect(
          existsSync(join(directory, "onnx/model.onnx")),
          "partial weights must not be published as complete",
        ).toBe(false);
        for (const language of ["en", "ja"])
          for (const tool of ["search_venues", "recommend_venues"]) {
            const c = cases.find(
              (c) =>
                c.paper.language === language && c.tool === tool && c.mode === "title+abstract",
            )!;
            const error = (await call(c)).result;
            expect(error.isError).toBe(true);
            expect(error.structuredContent?.error?.code).toBe("MODEL_NOT_READY");
            errors.push(error);
          }
        expect((await request("ping")).result).toEqual({});
      }
      // The command acquires pinned weights itself while the initialized MCP connection stays open.
      const preparation = spawnSync(process.execPath, [join(root, "src/prepare-models.ts")], {
        cwd: root,
        encoding: "utf8",
        timeout: 900000,
      });
      expect(
        preparation.status,
        `preparation retry must recover from the incomplete cache: ${preparation.stderr}`,
      ).toBe(0);
      prepared = JSON.parse(preparation.stdout);
      expect(prepared.ready).toBe(true);
      expect(prepared.models).toEqual([
        { id: runtime.EMBEDDING_MODEL, revision: runtime.EMBEDDING_REVISION },
        { id: runtime.EMBEDDING_MULTI_MODEL, revision: runtime.EMBEDDING_MULTI_REVISION },
      ]);
      for (const model of prepared.models)
        for (const file of [
          "config.json",
          "tokenizer.json",
          "tokenizer_config.json",
          "onnx/model.onnx",
        ])
          expect(statSync(join(cache, model.id, model.revision, file)).size).toBeGreaterThan(0);
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
    return { errors, replies, sameProcess, prepared, interruption };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
