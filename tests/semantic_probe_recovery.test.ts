import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import R from "../site/recommendation.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

const app = siteRuntime();
const probe = jsFunction(app, "checkSemanticProbe");
const output = jsFunction(app, "semanticOutput");
const metadata = (model = "en", revision = "pinned") => ({
  model,
  revision,
  dim: 3,
  probe: { text: "compatible embedding probe", vector: [1, 0, 0] },
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness() {
  const pending: Array<{
    text: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  const context = {
    semModel: (text: string) =>
      new Promise((resolve, reject) => pending.push({ text, resolve, reject })),
    semProbeCache: {} as Record<string, boolean>,
    Recommender: R,
    isRecord: (value: unknown) => Boolean(value && typeof value === "object"),
  };
  const check = runInNewContext(`${output}\n(${probe})`, context);
  const results: boolean[] = [];
  return {
    pending,
    results,
    cache: context.semProbeCache,
    check(meta = metadata()) {
      check(meta, (value: boolean) => results.push(value));
    },
  };
}

it.each(["rejected", "invalid-output"])(
  "retries an inconclusive compatibility probe after %s on the same model",
  async (failure) => {
    const ui = harness();
    ui.check();
    expect(ui.pending).toHaveLength(1);
    expect(ui.pending[0].text).toBe("compatible embedding probe");
    if (failure === "rejected") ui.pending[0].reject(new Error("temporary inference failure"));
    else ui.pending[0].resolve({ data: null });
    await tick();
    expect(ui.results).toEqual([false]);
    expect(Object.hasOwn(ui.cache, "en@pinned")).toBe(false);
    ui.check();
    expect(ui.pending).toHaveLength(2);
    ui.pending[1].resolve({ data: new Float32Array([1, 0, 0]) });
    await tick();
    expect(ui.results).toEqual([false, true]);
    expect(ui.cache["en@pinned"]).toBe(true);
    ui.check();
    expect(ui.pending).toHaveLength(2);
    expect(ui.results).toEqual([false, true, true]);
  },
);

it("keeps a completed incompatible probe rejected instead of accepting it on retry", async () => {
  const ui = harness();
  ui.check();
  ui.pending[0].resolve({ data: new Float32Array([0, 1, 0]) });
  await tick();
  expect(ui.results).toEqual([false]);
  expect(ui.cache["en@pinned"]).toBe(false);
  ui.check();
  expect(ui.pending).toHaveLength(1);
  expect(ui.results).toEqual([false, false]);
});

it("keeps compatibility results separate for language models and revisions", async () => {
  const ui = harness();
  ui.check();
  ui.pending[0].resolve({ data: [1, 0, 0] });
  await tick();
  ui.check(metadata("ja"));
  ui.pending[1].resolve({ data: [0, 1, 0] });
  await tick();
  ui.check(metadata("en", "next"));
  ui.pending[2].resolve({ data: [1, 0, 0] });
  await tick();
  expect(ui.results).toEqual([true, false, true]);
  expect(ui.cache).toEqual({ "en@pinned": true, "ja@pinned": false, "en@next": true });
});
