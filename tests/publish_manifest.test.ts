import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectPublishProvenance,
  type PublishProvenance,
  publishBuildId,
  publishContentId,
  writePublishManifest,
} from "../src/build.ts";
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  embeddingManifest,
  venuePapersHash,
} from "../src/embeddings.ts";
import { NOW, runCli } from "./helpers.ts";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const provenance: PublishProvenance = {
  sourceCommit: "source-sha",
  dataCommit: "data-sha",
  workflowRunId: "run-7",
  dirtyWorktree: false,
  inputs: { "config.yaml": { sha256: sha256("config") } },
  promotionBatches: [{ id: "data/promotions/7", sha256: sha256("batch") }],
  build: {
    now: NOW.toISOString(),
    offline: true,
    node: process.version,
    command:
      "node src/cli.ts build --out <dir> --cache <dir> --now <publish.build.now> [--offline]",
    source_cache: "offline-with-snapshot-fallback",
  },
};

describe("publish manifest", () => {
  it("hashes every present build input and promotion manifest deterministically", () => {
    const root = mkdtempSync(join(tmpdir(), "kamiyobi-provenance-"));
    const data = join(root, "data");
    mkdirSync(join(data, "promotions", "batch-b"), { recursive: true });
    for (const name of [
      "config.yaml",
      "extra.yaml",
      "overrides.yaml",
      "primary_overrides.yaml",
      "snapshot.json",
      "venue-profiles.json",
    ]) {
      const path = name === "config.yaml" ? join(root, name) : join(data, name);
      writeFileSync(path, name, "utf8");
    }
    writeFileSync(
      join(data, "promotions", "batch-b", "manifest.json"),
      JSON.stringify({ id: "batch-b" }),
      "utf8",
    );

    const captured = collectPublishProvenance(root);
    expect(Object.keys(captured.inputs)).toEqual([
      "config.yaml",
      "data/extra.yaml",
      "data/overrides.yaml",
      "data/primary_overrides.yaml",
      "data/snapshot.json",
      "data/venue-profiles.json",
    ]);
    expect(captured.inputs["data/extra.yaml"]?.sha256).toBe(sha256("extra.yaml"));
    expect(captured.promotionBatches).toEqual([
      { id: "batch-b", sha256: sha256(JSON.stringify({ id: "batch-b" })) },
    ]);
  });

  it("reports tracked changes without treating generated files as source dirt", () => {
    const root = mkdtempSync(join(tmpdir(), "kamiyobi-provenance-git-"));
    writeFileSync(join(root, "config.yaml"), "site: clean\n", "utf8");
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["add", "config.yaml"], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"],
      { cwd: root },
    );

    writeFileSync(join(root, "generated.txt"), "generated\n", "utf8");
    expect(collectPublishProvenance(root).dirtyWorktree).toBe(false);
    writeFileSync(join(root, "config.yaml"), "site: changed\n", "utf8");
    expect(collectPublishProvenance(root).dirtyWorktree).toBe(true);
  });

  it("hashes final artifacts deterministically and excludes the manifest itself", () => {
    const outdir = mkdtempSync(join(tmpdir(), "kamiyobi-publish-"));
    const files = ["b.txt", "a.txt"];
    for (const [name, text] of [
      ["a.txt", "alpha"],
      ["b.txt", "beta"],
    ] as const) {
      writeFileSync(join(outdir, name), text, "utf8");
    }

    const first = writePublishManifest(outdir, files, NOW, "lexical-only", provenance);
    const firstText = readFileSync(join(outdir, "publish.json"), "utf8");
    const secondText = (() => {
      writePublishManifest(outdir, ["a.txt", "b.txt", "publish.json"], NOW, "lexical-only");
      return readFileSync(join(outdir, "publish.json"), "utf8");
    })();

    const contentId = publishContentId(provenance, "");
    expect(first).toEqual({
      schema_version: 4,
      generated_at: "2026-08-09T00:00:00.000Z",
      semantic_status: "lexical-only",
      artifacts: {
        "a.txt": { bytes: 5, sha256: sha256("alpha") },
        "b.txt": { bytes: 4, sha256: sha256("beta") },
      },
      content_id: contentId,
      build_id: publishBuildId(NOW, contentId),
      profile_hash: "",
      source_commit: "source-sha",
      data_commit: "data-sha",
      workflow_run_id: "run-7",
      dirty_worktree: false,
      inputs: { "config.yaml": { sha256: sha256("config") } },
      promotion_batches: [{ id: "data/promotions/7", sha256: sha256("batch") }],
      build: provenance.build,
    });
    expect(firstText).toBe(secondText);
  });

  it("keeps content identity stable while build identity follows the clock", () => {
    const content = publishContentId(provenance, "profile");
    expect(publishContentId(provenance, "profile")).toBe(content);
    expect(publishBuildId(NOW, content)).not.toBe(
      publishBuildId(new Date(NOW.getTime() + 1_000), content),
    );
  });

  it("distinguishes a lexical-only build from a restored embedding bundle", () => {
    const outdir = join(mkdtempSync(join(tmpdir(), "kamiyobi-site-")), "public");
    const run = runCli(outdir, { extra: ["--no-embeddings"] });
    expect(
      run.status,
      `cli build failed\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`,
    ).toBe(0);

    const lexicalManifest = JSON.parse(readFileSync(join(outdir, "publish.json"), "utf8")) as {
      generated_at: string;
      semantic_status: string;
      artifacts: Record<string, { sha256: string }>;
      source_commit: string | null;
      data_commit: string | null;
      workflow_run_id: string | null;
      dirty_worktree: boolean | null;
      inputs: Record<string, { sha256: string }>;
      promotion_batches: Array<{ id: string; sha256: string }>;
      build: PublishProvenance["build"];
    };
    expect(lexicalManifest.semantic_status).toBe("lexical-only");
    expect(lexicalManifest.artifacts["data.json"]).toBeDefined();
    expect(lexicalManifest.artifacts.embeddings).toBeUndefined();
    const preRestoreHashes = JSON.stringify(lexicalManifest.artifacts);

    // キャッシュ復元は --no-embeddings build の後にこの bundle を書き込む。
    const data = JSON.parse(readFileSync(join(outdir, "data.json"), "utf8")) as {
      categories: Record<string, string>;
      conferences: Array<Record<string, unknown>>;
    };
    const probe = new Array<number>(EMBEDDING_DIM).fill(0);
    const embeddingBundle = {
      model: EMBEDDING_MODEL,
      dim: EMBEDDING_DIM,
      venuePapersHash: venuePapersHash(),
      manifest: embeddingManifest(data),
      embeddings: Object.fromEntries(embeddingManifest(data).keys.map((key) => [key, [...probe]])),
      multi: {
        model: EMBEDDING_MULTI_MODEL,
        dim: EMBEDDING_DIM,
        embeddings: Object.fromEntries(
          embeddingManifest(data).keys.map((key) => [key, [...probe]]),
        ),
      },
      paperVecs: {},
    };
    writeFileSync(join(outdir, "embeddings.json"), JSON.stringify(embeddingBundle), "utf8");

    const readyManifest = writePublishManifest(
      outdir,
      ["data.json", "embeddings.json"],
      new Date(lexicalManifest.generated_at),
      "ready",
    );
    expect(existsSync(join(outdir, "embeddings.json"))).toBe(true);
    expect(readyManifest.semantic_status).toBe("ready");
    expect(JSON.stringify(readyManifest.artifacts)).not.toBe(preRestoreHashes);
    expect(readyManifest.artifacts["embeddings.json"]?.sha256).toBe(
      createHash("sha256")
        .update(readFileSync(join(outdir, "embeddings.json")))
        .digest("hex"),
    );
    expect(readyManifest).toMatchObject({
      source_commit: lexicalManifest.source_commit,
      data_commit: lexicalManifest.data_commit,
      workflow_run_id: lexicalManifest.workflow_run_id,
      dirty_worktree: lexicalManifest.dirty_worktree,
      inputs: lexicalManifest.inputs,
      promotion_batches: lexicalManifest.promotion_batches,
      build: lexicalManifest.build,
    });
  });
});
