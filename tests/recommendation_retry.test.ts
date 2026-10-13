import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { loadPublishedRecommendation } from "../site/publish.ts";

const source = readFileSync(new URL("../site/app.ts", import.meta.url), "utf8");
const start = source.indexOf("  function loadRecommendationData() {");
const end = source.indexOf("  function resolveHistoryRef() {", start);
if (start < 0 || end < 0) throw new Error("recommendation loader not found");
const loader = stripTypeScriptTypes(source.slice(start, end));
interface Index {
  conferences: Array<{ key: string }>;
  build_id?: string;
}
function harness(invalidFallback = false) {
  const fallback = invalidFallback ? {} : { conferences: [{ key: "Initial" }] };
  const index = { build_id: "recovered-build", conferences: [{ key: "Recovered" }] };
  const text = JSON.stringify(index);
  const manifest = JSON.stringify({
    schema_version: 2,
    build_id: "recovered-build",
    profile_hash: "profile",
    semantic_status: "lexical-only",
    artifacts: {
      "recommendation-index.json": {
        bytes: Buffer.byteLength(text),
        sha256: createHash("sha256").update(text).digest("hex"),
      },
    },
  });
  let available = false;
  let pause: Promise<void> | undefined;
  const calls: string[] = [];
  const profiles: Index[] = [];
  const paper = { title: "分散システムの論文", abstract: "入力済みの概要" };
  const context = {
    recommendationData: null as Index | null,
    recommendationPromise: null as Promise<void> | null,
    recommendationError: false,
    recommendationNeedsRetry: false,
    EMBEDDINGS: null,
    semanticReason: null,
    DATA: fallback,
    loadPublishedRecommendation,
    fetch: async (name: string) => {
      calls.push(name);
      if (name === "publish.json" && pause) await pause;
      return {
        ok: available,
        status: available ? 200 : 503,
        text: async () => (name === "publish.json" ? manifest : text),
      };
    },
    catalogFrom: (value: Index) => (Array.isArray(value.conferences) ? value : null),
    embeddingBundle: (value: unknown) => value,
    clearSemantic: () => {},
    currentPaperText: () => JSON.stringify(paper),
    scheduleSemantic: () => {},
    render: () => {},
    setRecommendationProfile: (value: Index) => profiles.push(value),
    loadRecommendationData: () => {},
    retryRecommendationData: () => {},
  };
  runInNewContext(loader, context);
  return {
    context,
    calls,
    profiles,
    paper,
    recover: () => {
      available = true;
    },
    hold: () => {
      let release = () => {};
      pause = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    async load() {
      context.loadRecommendationData();
      await context.recommendationPromise;
    },
    async retry() {
      context.retryRecommendationData();
      await context.recommendationPromise;
    },
  };
}

it("recovers a failed publication fetch without replacing the user's paper", async () => {
  const ui = harness();
  await ui.load();
  expect(ui.context.recommendationData?.conferences).toEqual([{ key: "Initial" }]);
  expect(ui.context.recommendationNeedsRetry).toBe(true);
  ui.recover();
  await ui.retry();
  expect(ui.context.recommendationData?.conferences).toEqual([{ key: "Recovered" }]);
  expect(ui.context.recommendationNeedsRetry).toBe(false);
  expect(ui.profiles.at(-1)?.build_id).toBe("recovered-build");
  expect(ui.paper).toEqual({ title: "分散システムの論文", abstract: "入力済みの概要" });
  expect(ui.calls).toEqual(["publish.json", "publish.json", "recommendation-index.json"]);
});

it("recovers an unusable fallback after the publication becomes available", async () => {
  const ui = harness(true);
  await ui.load();
  expect(ui.context.recommendationError).toBe(true);
  ui.recover();
  await ui.retry();
  expect(ui.context.recommendationError).toBe(false);
  expect(ui.context.recommendationData?.conferences).toEqual([{ key: "Recovered" }]);
});

it("does not start overlapping requests when retry is pressed repeatedly", async () => {
  const ui = harness();
  await ui.load();
  ui.recover();
  const release = ui.hold();
  ui.context.retryRecommendationData();
  ui.context.retryRecommendationData();
  release();
  await ui.context.recommendationPromise;
  expect(ui.calls.filter((name) => name === "publish.json")).toHaveLength(2);
  expect(ui.calls.filter((name) => name === "recommendation-index.json")).toHaveLength(1);
  expect(ui.context.recommendationData?.conferences).toEqual([{ key: "Recovered" }]);
});

it("does not offer retry for an intentional lexical-only publication", async () => {
  const ui = harness();
  ui.recover();
  await ui.load();
  expect(ui.context.recommendationData?.conferences).toEqual([{ key: "Recovered" }]);
  expect(ui.context.recommendationNeedsRetry).toBe(false);
});
