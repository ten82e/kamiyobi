import { spawnSync } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPublishedRecommendation } from "../site/publish.ts";
import { REPO_ROOT } from "./helpers.ts";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const catalog = { conferences: [{ key: "fallback" }] };

function fixture(overrides: Record<string, unknown> = {}) {
  const index = JSON.stringify({
    build_id: "build-a",
    conferences: [],
    embedding_manifest: { profile_hash: "p" },
  });
  const embeddings = JSON.stringify({ manifest: { profile_hash: "p" } });
  const manifest = {
    schema_version: 2,
    build_id: "build-a",
    profile_hash: "p",
    semantic_status: "ready",
    artifacts: {
      "recommendation-index.json": { bytes: Buffer.byteLength(index), sha256: hash(index) },
      "embeddings.json": { bytes: Buffer.byteLength(embeddings), sha256: hash(embeddings) },
    },
    ...overrides,
  };
  const texts: Record<string, string> = {
    "publish.json": JSON.stringify(manifest),
    "recommendation-index.json": index,
    "embeddings.json": embeddings,
  };
  return {
    texts,
    manifest,
    fetch: async (name: string) => {
      if (texts[name] === undefined) throw new Error(name);
      return texts[name];
    },
  };
}

describe("browser publish manifest", () => {
  it("loads publish → index → embeddings and keeps semantic on matching identities", async () => {
    const data = fixture();
    const result = await loadPublishedRecommendation(data.fetch, catalog);
    expect(result.state).toEqual({ semantic: true, reason: null });
  });

  it.each([
    ["schema", { schema_version: 1 }],
    ["build", { build_id: "wrong" }],
    ["lexical", { semantic_status: "lexical-only" }],
  ])("keeps lexical results for %s mismatch", async (_name, override) => {
    const data = fixture(override);
    const result = await loadPublishedRecommendation(data.fetch, catalog);
    expect(result.state.semantic).toBe(false);
    expect(result.index.conferences).toEqual(_name === "schema" ? catalog.conferences : []);
  });

  it("handles index hash, profile, and embeddings hash mismatches", async () => {
    let data = fixture();
    data.texts["recommendation-index.json"] = "changed";
    let result = await loadPublishedRecommendation(data.fetch, catalog);
    expect(result.state.semantic).toBe(false);
    expect(result.index).toEqual(catalog);
    data = fixture();
    data.texts["recommendation-index.json"] = JSON.stringify({
      build_id: "build-a",
      conferences: [],
      embedding_manifest: { profile_hash: "other" },
    });
    data.manifest.artifacts["recommendation-index.json"] = {
      bytes: Buffer.byteLength(data.texts["recommendation-index.json"]),
      sha256: hash(data.texts["recommendation-index.json"]),
    };
    data.texts["publish.json"] = JSON.stringify(data.manifest);
    result = await loadPublishedRecommendation(data.fetch, catalog);
    expect(result.state.semantic).toBe(false);
    expect(result.index.conferences).toEqual([]);
    data = fixture();
    data.texts["embeddings.json"] = "changed";
    result = await loadPublishedRecommendation(data.fetch, catalog);
    expect(result.state.semantic).toBe(false);
    expect(result.index.conferences).toEqual([]);
  });

  it("has no authoritative JavaScript runtime and shares the core", () => {
    expect(existsSync(join(REPO_ROOT, "site", "app.js"))).toBe(false);
    expect(existsSync(join(REPO_ROOT, "site", "recommender.js"))).toBe(false);
    expect(readFileSync(join(REPO_ROOT, "site", "app.ts"), "utf8")).toContain(
      'from "./recommender.js"',
    );
    expect(readFileSync(join(REPO_ROOT, "src", "bench-recommender.ts"), "utf8")).toContain(
      "loadRecommender",
    );
    expect(readFileSync(join(REPO_ROOT, "src", "recommender-api.ts"), "utf8")).toContain(
      "../site/recommender.ts",
    );
  });

  it("emits every module referenced by the template in an offline build", () => {
    const out = mkdtempSync(join(tmpdir(), "kamiyobi-site-"));
    try {
      const built = spawnSync(
        "node",
        [
          "src/cli.ts",
          "build",
          "--out",
          out,
          "--offline",
          "--cache",
          ".cache",
          "--no-embeddings",
          "--now",
          "2026-08-09T00:00:00Z",
        ],
        { cwd: REPO_ROOT, encoding: "utf8" },
      );
      expect(built.status, built.stderr).toBe(0);
      for (const name of ["app.js", "recommender.js", "recommendation-core.js", "publish.js"]) {
        expect(existsSync(join(out, name))).toBe(true);
      }
      expect(readFileSync(join(out, "app.js"), "utf8")).toContain('from "./recommender.js"');
      expect(readFileSync(join(out, "index.html"), "utf8")).toContain('src="app.js"');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
