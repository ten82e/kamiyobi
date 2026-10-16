import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

const app = siteRuntime();
const original = jsFunction(app, "loadTransformers");
const cacheDeclaration = /const semModelLoads = [^;]+;/.exec(app)?.[0];
if (!cacheDeclaration) throw new Error("pending model cache declaration missing");
const importCall = "import(__rewriteRelativeImportExtension(transformersUrl))";
if (original.split(importCall).length !== 2) throw new Error("model import seam changed");
const source = original.replace(importCall, "importTransformers(transformersUrl)");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness() {
  const pending: Array<{
    model: string;
    revision: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  const loaded: Array<{ generation: number; ok: boolean }> = [];
  const context = {
    semGeneration: 0,
    semLoadedModel: "",
    semModel: null,
    semState: "idle",
    transformersModule: (value: { pipeline?: unknown }) => typeof value.pipeline === "function",
    importTransformers: async () => ({
      pipeline: (_task: string, model: string, { revision }: { revision: string }) =>
        new Promise((resolve, reject) => pending.push({ model, revision, resolve, reject })),
    }),
  };
  const load = runInNewContext(`${cacheDeclaration}\n(${source})`, context);
  return {
    pending,
    loaded,
    context,
    request(generation: number, model = "en", revision = "pinned") {
      context.semGeneration = generation;
      context.semState = "loading";
      load({ model, revision }, generation, (ok: boolean) => loaded.push({ generation, ok }));
    },
  };
}

it("shares one pending model load across edits and completes only the latest input", async () => {
  const ui = harness();
  ui.request(1);
  ui.request(2);
  ui.request(3);
  await tick();
  expect(ui.pending).toHaveLength(1);
  const model = () => {};
  ui.pending[0].resolve(model);
  await tick();
  expect(ui.loaded).toEqual([{ generation: 3, ok: true }]);
  expect(ui.context.semModel).toBe(model);
  expect(ui.context.semLoadedModel).toBe("en@pinned");
  ui.request(4);
  await tick();
  expect(ui.pending).toHaveLength(1);
  expect(ui.loaded).toEqual([
    { generation: 3, ok: true },
    { generation: 4, ok: true },
  ]);
});

it("shares separate pending language models when input switches back before either is ready", async () => {
  const ui = harness();
  ui.request(1, "en");
  ui.request(2, "ja");
  ui.request(3, "en");
  await tick();
  expect(ui.pending.map(({ model }) => model)).toEqual(["en", "ja"]);
  const english = () => {};
  ui.pending[0].resolve(english);
  await tick();
  ui.pending[1].resolve(() => {});
  await tick();
  expect(ui.loaded).toEqual([{ generation: 3, ok: true }]);
  expect(ui.context.semModel).toBe(english);
  expect(ui.context.semLoadedModel).toBe("en@pinned");
});

it("retries a failed shared preparation on the next edit", async () => {
  const ui = harness();
  ui.request(1);
  ui.request(2);
  await tick();
  expect(ui.pending).toHaveLength(1);
  ui.pending[0].reject(new Error("download interrupted"));
  await tick();
  expect(ui.loaded).toEqual([{ generation: 2, ok: false }]);
  expect(ui.context.semState).toBe("error");
  ui.request(3);
  await tick();
  expect(ui.pending).toHaveLength(2);
  const model = () => {};
  ui.pending[1].resolve(model);
  await tick();
  expect(ui.loaded).toEqual([
    { generation: 2, ok: false },
    { generation: 3, ok: true },
  ]);
  expect(ui.context.semModel).toBe(model);
});

it("keeps revisions distinct and never installs an obsolete completion", async () => {
  const ui = harness();
  ui.request(1, "en", "old");
  ui.request(2, "en", "new");
  await tick();
  expect(ui.pending.map(({ revision }) => revision)).toEqual(["old", "new"]);
  ui.pending[1].resolve(() => {});
  await tick();
  ui.pending[0].resolve(() => {});
  await tick();
  expect(ui.loaded).toEqual([{ generation: 2, ok: true }]);
  expect(ui.context.semLoadedModel).toBe("en@new");
});
