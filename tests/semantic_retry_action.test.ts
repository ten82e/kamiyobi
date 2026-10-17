import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import R from "../site/recommendation.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

const app = siteRuntime();
const wiring = /\$\("semanticRetry"\)\?\.addEventListener\("click", retrySemantic\);/.exec(
  app,
)?.[0];
if (!wiring) throw new Error("semantic retry button is not wired");
const functions = [
  "semanticCanRetry",
  "updateSemanticRetry",
  "retrySemantic",
  "invalidateSemantic",
  "scheduleSemantic",
  "semanticIsCurrent",
  "clearSemantic",
  "loadEmbeddings",
  "checkSemanticProbe",
  "semanticOutput",
]
  .map((name) => jsFunction(app, name))
  .join("\n");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness(title = "GPU memory systems", reason = "model load failed") {
  let active: unknown;
  class Element {
    hidden = true;
    textContent = "";
    disabled = false;
    attributes = new Map<string, string>();
    listeners = new Map<string, () => void>();
    addEventListener(name: string, callback: () => void) {
      this.listeners.set(name, callback);
    }
    toggleAttribute(name: string, present: boolean) {
      if (name === "disabled") this.disabled = present;
    }
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    }
    focus() {
      active = this;
    }
    click() {
      if (!this.disabled) {
        this.focus();
        this.listeners.get("click")?.();
      }
    }
  }
  const nodes = Object.fromEntries(
    ["semanticRetryStatus", "semanticRetryNote", "semanticRetry", "results"].map((id) => [
      id,
      new Element(),
    ]),
  );
  const paper = { value: JSON.stringify([{ title, abstract: "", keywords: "", venue: "" }]) };
  const metadata = (model: string) => ({
    model,
    revision: "pinned",
    dim: 3,
    probe: { text: "kamiyobi embedding compatibility probe", vector: [1, 0, 0] },
  });
  const set = (model: string) => ({ model, dim: 3, embeddings: { venue: [1, 0, 0] } });
  const bundle = {
    ...set("english"),
    multi: set("japanese"),
    manifest: {
      schema: 1,
      profile_hash: "fresh-unit-profiles",
      keys: ["venue"],
      models: { en: metadata("english"), multi: metadata("japanese") },
    },
  };
  const pending: Array<{ text: string; resolve: (value: unknown) => void }> = [];
  const model = (text: string) => new Promise((resolve) => pending.push({ text, resolve }));
  let loads = 0;
  const context = {
    paper,
    state: { mode: "recommend" },
    Recommender: R,
    EMBEDDINGS: bundle as typeof bundle | null,
    semState: "error",
    semanticReason: reason,
    semanticRetryRequested: false,
    semGeneration: 0,
    semQuery: null,
    semEmbeddings: null,
    semProbeCache: {} as Record<string, boolean>,
    semModel: model,
    semLoadedModel: "",
    recommendationNeedsRetry: false,
    document: {
      get activeElement() {
        return active;
      },
    },
    $: (id: string) => nodes[id],
    currentPaperText: () => paper.value,
    isRecord: (value: unknown) => Boolean(value && typeof value === "object"),
    loadTransformers: (
      meta: { model: string; revision: string },
      _generation: number,
      cb: (ready: boolean) => void,
    ) => {
      loads++;
      context.semLoadedModel = `${meta.model}@${meta.revision}`;
      cb(true);
    },
    render: () => {},
    updateSemanticRetry: (_recommend: boolean) => {},
    retrySemantic: () => {},
    invalidateSemantic: () => {},
    scheduleSemantic: (_manualRetry?: boolean) => {},
  };
  context.render = () => context.updateSemanticRetry(context.state.mode === "recommend");
  runInNewContext(`${functions}\n${wiring}`, context);
  context.render();
  return { context, paper, nodes, pending, loads: () => loads, active: () => active };
}

it.each(
  ["GPU memory systems", "分散メモリ管理"].flatMap((title) =>
    ["model load failed", "model unavailable", "query embedding failed", "probe mismatch"].map(
      (reason) => ({ title, reason }),
    ),
  ),
)(
  "retries $reason for $title through the wired button without changing input",
  async ({ title, reason }) => {
    const ui = harness(title, reason);
    const original = ui.paper.value;
    expect(ui.nodes.semanticRetryStatus.hidden).toBe(false);
    expect(ui.nodes.semanticRetryNote.textContent).toContain("入力を残したまま");
    ui.nodes.semanticRetry.click();
    expect(ui.context.semState).toBe("loading");
    expect(ui.nodes.semanticRetry.disabled).toBe(false);
    expect(ui.nodes.semanticRetry.attributes.get("aria-disabled")).toBe("true");
    expect(ui.nodes.semanticRetryNote.textContent).toBe("意味検索を再試行中…");
    ui.nodes.semanticRetry.click();
    expect(ui.loads()).toBe(1);
    expect(ui.pending).toHaveLength(1);
    expect(ui.pending[0].text).toBe("kamiyobi embedding compatibility probe");
    ui.pending[0].resolve({ data: [1, 0, 0] });
    await tick();
    expect(ui.pending).toHaveLength(2);
    expect(ui.pending[1].text).toContain(title);
    ui.pending[1].resolve({ data: [0, 1, 0] });
    await tick();
    expect(ui.context.semState).toBe("ready");
    expect(ui.context.semQuery).toEqual([0, 1, 0]);
    expect(ui.nodes.semanticRetryStatus.hidden).toBe(false);
    expect(ui.nodes.semanticRetry.disabled).toBe(false);
    expect(ui.nodes.semanticRetry.attributes.get("aria-disabled")).toBe("false");
    expect(ui.nodes.semanticRetryNote.textContent).toBe("意味検索が完了しました。");
    expect(ui.active()).toBe(ui.nodes.semanticRetry);
    expect(ui.paper.value).toBe(original);
    ui.context.invalidateSemantic();
    ui.context.render();
    expect(ui.context.semanticRetryRequested).toBe(false);
    expect(ui.nodes.semanticRetryStatus.hidden).toBe(true);
    expect(ui.active()).toBe(ui.nodes.results);
  },
);

it.each(["GPU memory systems", "分散メモリ管理"])(
  "does not retry a confirmed incompatible model for %s",
  (title) => {
    const ui = harness(title, "probe mismatch");
    ui.context.semProbeCache[
      `${R.queryHasJapanese(R.parsePaperLines(ui.paper.value)) ? "japanese" : "english"}@pinned`
    ] = false;
    ui.context.render();
    expect(ui.nodes.semanticRetryStatus.hidden).toBe(true);
    ui.context.retrySemantic();
    expect(ui.loads()).toBe(0);
    expect(ui.pending).toEqual([]);
  },
);

it.each([
  "lexical-only",
  "empty-input",
  "data-retry",
  "deadline-mode",
  "loading",
  "automatic-success",
])("does not offer semantic retry for %s", (kind) => {
  const ui = harness();
  if (kind === "lexical-only") ui.context.EMBEDDINGS = null;
  if (kind === "empty-input") ui.paper.value = "";
  if (kind === "data-retry") ui.context.recommendationNeedsRetry = true;
  if (kind === "deadline-mode") ui.context.state.mode = "deadlines";
  if (kind === "loading") ui.context.semState = "loading";
  if (kind === "automatic-success") ui.context.semState = "ready";
  ui.context.render();
  expect(ui.nodes.semanticRetryStatus.hidden).toBe(true);
  ui.context.retrySemantic();
  expect(ui.loads()).toBe(0);
});

it("keeps normal automatic inference free of the retry completion notice", async () => {
  const ui = harness();
  ui.context.scheduleSemantic();
  ui.context.render();
  expect(ui.nodes.semanticRetryStatus.hidden).toBe(true);
  ui.pending[0].resolve({ data: [1, 0, 0] });
  await tick();
  ui.pending[1].resolve({ data: [0, 1, 0] });
  await tick();
  expect(ui.context.semState).toBe("ready");
  expect(ui.context.semanticRetryRequested).toBe(false);
  expect(ui.nodes.semanticRetryStatus.hidden).toBe(true);
});

it("stops offering retry if the new probe confirms an actual incompatibility", async () => {
  const ui = harness();
  ui.nodes.semanticRetry.click();
  ui.pending[0].resolve({ data: [0, 1, 0] });
  await tick();
  expect(ui.context.semState).toBe("error");
  expect(ui.context.semanticReason).toBe("probe mismatch");
  expect(ui.nodes.semanticRetryStatus.hidden).toBe(true);
  expect(ui.active()).toBe(ui.nodes.results);
  ui.context.retrySemantic();
  expect(ui.loads()).toBe(1);
});

it("connects the retry state to rendering and an accessible button in the actual template", () => {
  expect(jsFunction(app, "render")).toContain("updateSemanticRetry(recMode)");
  const template = readFileSync(new URL("../site/template.html", import.meta.url), "utf8");
  expect(template).toContain(
    '<div id="semanticRetryStatus" class="scrollhint" aria-live="polite" hidden>',
  );
  expect(template).toContain('<button id="semanticRetry" type="button">意味検索を再試行</button>');
});
