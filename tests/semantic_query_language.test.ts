import { expect, it } from "vitest";
import R from "../site/recommender.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

function scheduled(input: string, multilingual = true) {
  const runtime = siteRuntime();
  // Observe the actual scheduler's loader choice without substituting inference results.
  const run = new Function(
    "core",
    "input",
    "multilingual",
    `
    const Recommender = {...core, embeddingSetCompatible: () => true};
    let semGeneration = 0, semState = 'idle', semanticReason = '';
    const selected = []; let loads = 0;
    const EMBEDDINGS = {manifest: {models: {en: {model: 'english'}, multi: {model: 'multilingual'}}},
      ...(multilingual ? {multi: {}} : {})};
    const currentPaperText = () => input;
    const clearSemantic = (state) => {semState = state;};
    const render = () => {};
    const loadEmbeddings = (cb) => {loads++; cb();};
    const loadTransformers = (meta) => {selected.push(meta.model);};
    ${jsFunction(runtime, "semanticIsCurrent")}
    ${jsFunction(runtime, "scheduleSemantic")}
    scheduleSemantic(); return {selected, loads, state: semState};
  `,
  );
  return run(R, input, multilingual) as { selected: string[]; loads: number; state: string };
}

it.each([
  '[{"title":"日本語","abstract":"機械学習"}]',
  '[{"title":"\\u65e5\\u672c\\u8a9e","abstract":"\\u6a5f\\u68b0\\u5b66\\u7fd2"}]',
])("uses the multilingual model for decoded Japanese paper content: %s", (input) => {
  expect(scheduled(input).selected).toEqual(["multilingual"]);
});

it("keeps an English paper on the English model when only the publication tag is Japanese", () => {
  expect(
    scheduled('[{"title":"Distributed computing","venue":"情報処理学会論文誌"}]').selected,
  ).toEqual(["english"]);
});

it("does not silently use the English model when the multilingual bundle is unavailable", () => {
  expect(scheduled('[{"title":"機械学習"}]', false)).toEqual({
    selected: [],
    loads: 1,
    state: "error",
  });
});

it.each(["[]", '[{"title":"","abstract":""}]'])(
  "does not load a model for an empty decoded paper: %s",
  (input) => {
    expect(scheduled(input)).toEqual({ selected: [], loads: 0, state: "idle" });
  },
);

it("recognizes half-width Japanese in the query language without rewriting the paper record", () => {
  const lines = R.parsePaperLines('[{"title":"ﾈｯﾄﾜｰｸ"}]');
  expect(R.queryHasJapanese(lines)).toBe(true);
  expect(lines[0].title).toBe("ﾈｯﾄﾜｰｸ");
});
